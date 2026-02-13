#!/usr/bin/env node
// ============================================================
// memory-mcp-server.js v2.0 — MCP Server for Claude Code
// Gives Claude CLI full memory management tools
//
// Install: npm install better-sqlite3
// Add to Claude: claude mcp add memory -- node ./memory/memory-mcp-server.js
//
// New in v2:
//   - 8 tools: search, add, update, delete, profile, list, relate, stats
//   - Importance levels + memory types
//   - Multi-tag support
//   - Memory cleanup/maintenance
//   - Portable paths (no hardcoded dirs)
// ============================================================

import { createInterface } from 'readline';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ========================
// CONFIG
// ========================
const DB_PATH = process.env.MEMORY_DB_PATH || resolve(process.argv[2] || resolve(__dirname, '../memories.db'));
const CONTAINER_TAG = process.env.MEMORY_CONTAINER || 'claude_memory';

// ========================
// EMBEDDED MEMORY ENGINE
// ========================
class MemoryDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        container_tag TEXT DEFAULT 'default',
        memory_type TEXT DEFAULT 'dynamic' CHECK(memory_type IN ('static','dynamic','episodic','semantic')),
        importance TEXT DEFAULT 'normal' CHECK(importance IN ('critical','high','normal','low')),
        source TEXT DEFAULT 'user',
        metadata TEXT DEFAULT '{}',
        access_count INTEGER DEFAULT 0,
        is_deleted INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_container ON memories(container_tag);
      CREATE INDEX IF NOT EXISTS idx_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_deleted ON memories(is_deleted);
      CREATE INDEX IF NOT EXISTS idx_updated ON memories(updated_at);

      CREATE TABLE IF NOT EXISTS memory_links (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT DEFAULT 'related',
        strength REAL DEFAULT 1.0,
        PRIMARY KEY (source_id, target_id),
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );
    `);
  }

  add(content, tag = CONTAINER_TAG, type = 'dynamic', importance = 'normal', source = 'claude_tool') {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO memories (id, content, container_tag, memory_type, importance, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(id, content, tag, type, importance, source);
    return { id, content, type, importance };
  }

  update(id, updates) {
    const existing = this.db.prepare(`SELECT * FROM memories WHERE id = ? AND is_deleted = 0`).get(id);
    if (!existing) return { success: false, error: 'Memory not found' };

    const content = updates.content ?? existing.content;
    const importance = updates.importance ?? existing.importance;
    const memoryType = updates.type ?? existing.memory_type;

    this.db.prepare(`
      UPDATE memories SET content = ?, importance = ?, memory_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(content, importance, memoryType, id);

    return { success: true, id };
  }

  search(query, tag = CONTAINER_TAG, limit = 10, types = [], minImportance = null) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    const IMPORTANCE_RANK = { critical: 4, high: 3, normal: 2, low: 1 };
    const minRank = minImportance ? (IMPORTANCE_RANK[minImportance] || 0) : 0;

    let rows;
    if (words.length === 0) {
      let sql = `SELECT id, content, memory_type, importance, access_count, created_at, updated_at FROM memories WHERE container_tag = ? AND is_deleted = 0`;
      const params = [tag];
      if (types.length > 0) {
        sql += ` AND memory_type IN (${types.map(() => '?').join(',')})`;
        params.push(...types);
      }
      sql += ` ORDER BY updated_at DESC LIMIT ?`;
      params.push(limit);
      rows = this.db.prepare(sql).all(...params);
    } else {
      const conditions = words.map(() => `LOWER(content) LIKE ?`).join(' OR ');
      const params = [tag];
      let sql = `SELECT id, content, memory_type, importance, access_count, created_at, updated_at FROM memories WHERE container_tag = ? AND is_deleted = 0 AND (${conditions})`;
      params.push(...words.map(w => `%${w}%`));
      if (types.length > 0) {
        sql += ` AND memory_type IN (${types.map(() => '?').join(',')})`;
        params.push(...types);
      }
      sql += ` ORDER BY updated_at DESC LIMIT ?`;
      params.push(limit);
      rows = this.db.prepare(sql).all(...params);
    }

    // Score and filter
    return rows
      .map(row => {
        const lc = row.content.toLowerCase();
        const matchCount = words.length > 0 ? words.filter(w => lc.includes(w)).length / words.length : 0.5;
        return { ...row, score: matchCount };
      })
      .filter(r => (IMPORTANCE_RANK[r.importance] || 2) >= minRank)
      .sort((a, b) => b.score - a.score);
  }

  getProfile(tag = CONTAINER_TAG) {
    const staticMems = this.db.prepare(`
      SELECT content, importance FROM memories
      WHERE container_tag = ? AND memory_type = 'static' AND is_deleted = 0
      ORDER BY CASE importance WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, updated_at DESC
    `).all(tag);

    const dynamicMems = this.db.prepare(`
      SELECT content, importance, updated_at FROM memories
      WHERE container_tag = ? AND memory_type IN ('dynamic', 'episodic') AND is_deleted = 0
      ORDER BY updated_at DESC LIMIT 30
    `).all(tag);

    return { static: staticMems, dynamic: dynamicMems };
  }

  delete(id) {
    this.db.prepare('UPDATE memories SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return { success: true };
  }

  listAll(tag = CONTAINER_TAG, limit = 50, types = []) {
    let sql = `SELECT id, content, memory_type, importance, access_count, created_at, updated_at FROM memories WHERE container_tag = ? AND is_deleted = 0`;
    const params = [tag];
    if (types.length > 0) {
      sql += ` AND memory_type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }
    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  link(sourceId, targetId, relation = 'related', strength = 1.0) {
    this.db.prepare(`INSERT OR REPLACE INTO memory_links (source_id, target_id, relation, strength) VALUES (?, ?, ?, ?)`).run(sourceId, targetId, relation, strength);
    return { success: true };
  }

  getRelated(memoryId, limit = 10) {
    return this.db.prepare(`
      SELECT m.id, m.content, m.memory_type, ml.relation, ml.strength
      FROM memory_links ml JOIN memories m ON m.id = ml.target_id
      WHERE ml.source_id = ? AND m.is_deleted = 0
      ORDER BY ml.strength DESC LIMIT ?
    `).all(memoryId, limit);
  }

  getStats(tag = CONTAINER_TAG) {
    const total = this.db.prepare(`SELECT COUNT(*) as count FROM memories WHERE container_tag = ? AND is_deleted = 0`).get(tag);
    const byType = this.db.prepare(`SELECT memory_type, COUNT(*) as count FROM memories WHERE container_tag = ? AND is_deleted = 0 GROUP BY memory_type`).all(tag);
    const byImportance = this.db.prepare(`SELECT importance, COUNT(*) as count FROM memories WHERE container_tag = ? AND is_deleted = 0 GROUP BY importance`).all(tag);
    return {
      total: total.count,
      byType: Object.fromEntries(byType.map(r => [r.memory_type, r.count])),
      byImportance: Object.fromEntries(byImportance.map(r => [r.importance, r.count])),
    };
  }

  cleanup(tag = CONTAINER_TAG, maxAgeDays = 90) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      UPDATE memories SET is_deleted = 1 WHERE container_tag = ? AND memory_type = 'dynamic'
      AND is_deleted = 0 AND updated_at < ? AND importance NOT IN ('critical', 'high') AND access_count < 3
    `).run(tag, cutoff);
    return { cleaned: result.changes };
  }
}

// ========================
// MCP TOOL DEFINITIONS
// ========================
const mem = new MemoryDB(DB_PATH);

const TOOLS = [
  {
    name: 'search_memories',
    description: 'Search memories about the user, project, or past conversations. Use when you need context about past decisions, preferences, or project details.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memories' },
        types: { type: 'array', items: { type: 'string', enum: ['static', 'dynamic', 'episodic', 'semantic'] }, description: 'Filter by memory types' },
        min_importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'Minimum importance level' },
        limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_memory',
    description: 'Save important information to long-term memory. Use when the user shares preferences, decisions, project facts, or anything worth remembering.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The information to remember' },
        type: { type: 'string', enum: ['static', 'dynamic', 'episodic', 'semantic'], description: 'static=permanent facts, dynamic=context, episodic=conversations, semantic=concepts', default: 'dynamic' },
        importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'critical=vital, high=strong preference, normal=general, low=minor', default: 'normal' },
      },
      required: ['content'],
    },
  },
  {
    name: 'update_memory',
    description: 'Update an existing memory with new information.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to update' },
        content: { type: 'string', description: 'New content' },
        type: { type: 'string', enum: ['static', 'dynamic', 'episodic', 'semantic'], description: 'New type' },
        importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'New importance' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a specific memory by its ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory ID to delete' } },
      required: ['id'],
    },
  },
  {
    name: 'get_user_profile',
    description: 'Get the full user profile — all stored facts and recent context. Use at session start for comprehensive context.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_memories',
    description: 'List all stored memories, optionally filtered by type.',
    inputSchema: {
      type: 'object',
      properties: {
        types: { type: 'array', items: { type: 'string', enum: ['static', 'dynamic', 'episodic', 'semantic'] }, description: 'Filter by types' },
        limit: { type: 'number', description: 'Max results (default: 50)', default: 50 },
      },
      required: [],
    },
  },
  {
    name: 'link_memories',
    description: 'Create a relationship between two memories.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: 'Source memory ID' },
        target_id: { type: 'string', description: 'Target memory ID' },
        relation: { type: 'string', description: 'Relation type (e.g., "related", "contradicts", "supports")', default: 'related' },
      },
      required: ['source_id', 'target_id'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Get statistics about stored memories — total count, breakdown by type and importance.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ========================
// TOOL HANDLER
// ========================
function handleToolCall(name, args) {
  switch (name) {
    case 'search_memories': {
      const results = mem.search(args.query, CONTAINER_TAG, args.limit || 10, args.types || [], args.min_importance);
      return {
        content: [{
          type: 'text',
          text: results.length > 0
            ? results.map((r, i) =>
              `[${i + 1}] id:${r.id}\n    type: ${r.memory_type} | importance: ${r.importance} | score: ${Math.round(r.score * 100)}%\n    ${r.content}`
            ).join('\n\n')
            : 'No memories found matching that query.',
        }],
      };
    }

    case 'add_memory': {
      const result = mem.add(args.content, CONTAINER_TAG, args.type || 'dynamic', args.importance || 'normal');
      return {
        content: [{ type: 'text', text: `Memory saved (id: ${result.id}, type: ${result.type}, importance: ${result.importance})` }],
      };
    }

    case 'update_memory': {
      const result = mem.update(args.id, { content: args.content, type: args.type, importance: args.importance });
      return {
        content: [{ type: 'text', text: result.success ? `Memory ${args.id} updated.` : `Failed: ${result.error}` }],
      };
    }

    case 'delete_memory': {
      mem.delete(args.id);
      return { content: [{ type: 'text', text: `Memory ${args.id} deleted.` }] };
    }

    case 'get_user_profile': {
      const profile = mem.getProfile(CONTAINER_TAG);
      const stats = mem.getStats(CONTAINER_TAG);
      const parts = [];

      parts.push(`Memory Stats: ${stats.total} total memories`);

      if (profile.static.length > 0) {
        parts.push('\n## Core Facts (Static)');
        parts.push(profile.static.map(m => {
          const prefix = m.importance === 'critical' ? '[!] ' : m.importance === 'high' ? '[*] ' : '';
          return `- ${prefix}${m.content}`;
        }).join('\n'));
      }
      if (profile.dynamic.length > 0) {
        parts.push('\n## Recent Context (Dynamic)');
        parts.push(profile.dynamic.map(m => `- ${m.content}`).join('\n'));
      }

      return {
        content: [{ type: 'text', text: parts.length > 1 ? parts.join('\n') : 'No user profile data yet. Start by adding memories!' }],
      };
    }

    case 'list_memories': {
      const all = mem.listAll(CONTAINER_TAG, args.limit || 50, args.types || []);
      return {
        content: [{
          type: 'text',
          text: all.length > 0
            ? all.map((r, i) =>
              `[${i + 1}] id:${r.id}\n    type: ${r.memory_type} | importance: ${r.importance} | accessed: ${r.access_count}x\n    ${r.content}`
            ).join('\n\n')
            : 'No memories stored yet.',
        }],
      };
    }

    case 'link_memories': {
      mem.link(args.source_id, args.target_id, args.relation || 'related');
      return { content: [{ type: 'text', text: `Linked ${args.source_id} -> ${args.target_id} (${args.relation || 'related'})` }] };
    }

    case 'memory_stats': {
      const stats = mem.getStats(CONTAINER_TAG);
      const lines = [
        `Total memories: ${stats.total}`,
        '',
        'By type:',
        ...Object.entries(stats.byType).map(([t, c]) => `  ${t}: ${c}`),
        '',
        'By importance:',
        ...Object.entries(stats.byImportance).map(([i, c]) => `  ${i}: ${c}`),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ========================
// STDIO JSON-RPC TRANSPORT
// ========================
const rl = createInterface({ input: process.stdin, terminal: false });

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`${msg}\n`);
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`${msg}\n`);
}

rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    return;
  }

  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'self-hosted-memory', version: '2.0.0' },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call':
      try {
        const result = handleToolCall(params.name, params.arguments || {});
        sendResponse(id, result);
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;

    default:
      if (id) sendError(id, -32601, `Method not found: ${method}`);
  }
});

process.stdin.resume();
process.stderr.write(`[memory-mcp] v2.0 Started. DB: ${DB_PATH}, Container: ${CONTAINER_TAG}\n`);
