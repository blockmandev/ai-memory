#!/usr/bin/env node
// ============================================================
// memory-mcp-server.js — MCP Server for Claude Code
// Gives Claude CLI searchMemories + addMemory tools
// 
// Install: npm install better-sqlite3
// Add to Claude: claude mcp add memory -- node D:/QoraNet-Blockchain/memory/memory-mcp-server.js
// ============================================================

import { createInterface } from 'readline';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { resolve } from 'path';

// ========================
// CONFIG
// ========================
const DB_PATH = process.env.MEMORY_DB_PATH || resolve(process.argv[2] || './memories.db');
const CONTAINER_TAG = process.env.MEMORY_CONTAINER || 'claude_memory';

// ========================
// MINI MEMORY ENGINE (embedded, no external deps)
// ========================
class MemoryDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        container_tag TEXT DEFAULT 'default',
        memory_type TEXT DEFAULT 'dynamic',
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_container ON memories(container_tag);
      CREATE INDEX IF NOT EXISTS idx_type ON memories(memory_type);
    `);
  }

  add(content, tag = CONTAINER_TAG, type = 'dynamic') {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO memories (id, content, container_tag, memory_type, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(id, content, tag, type);
    return { id, content };
  }

  search(query, tag = CONTAINER_TAG, limit = 10) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    if (words.length === 0) {
      return this.db.prepare(`
        SELECT id, content, memory_type, created_at FROM memories
        WHERE container_tag = ? ORDER BY updated_at DESC LIMIT ?
      `).all(tag, limit);
    }

    const conditions = words.map(() => `LOWER(content) LIKE ?`).join(' OR ');
    const params = words.map(w => `%${w}%`);

    const rows = this.db.prepare(`
      SELECT id, content, memory_type, created_at FROM memories
      WHERE container_tag = ? AND (${conditions})
      ORDER BY updated_at DESC LIMIT ?
    `).all(tag, ...params, limit);

    // Score results
    return rows.map(row => {
      const lc = row.content.toLowerCase();
      const score = words.filter(w => lc.includes(w)).length / words.length;
      return { ...row, score };
    }).sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  getProfile(tag = CONTAINER_TAG) {
    const staticMems = this.db.prepare(`
      SELECT content FROM memories WHERE container_tag = ? AND memory_type = 'static'
      ORDER BY updated_at DESC
    `).all(tag).map(r => r.content);

    const dynamicMems = this.db.prepare(`
      SELECT content FROM memories WHERE container_tag = ? AND memory_type = 'dynamic'
      ORDER BY updated_at DESC LIMIT 20
    `).all(tag).map(r => r.content);

    return { static: staticMems, dynamic: dynamicMems };
  }

  delete(id) {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return { success: true };
  }

  listAll(tag = CONTAINER_TAG, limit = 50) {
    return this.db.prepare(`
      SELECT id, content, memory_type, created_at FROM memories
      WHERE container_tag = ? ORDER BY updated_at DESC LIMIT ?
    `).all(tag, limit);
  }
}

// ========================
// MCP PROTOCOL HANDLER
// ========================
const mem = new MemoryDB(DB_PATH);

const TOOLS = [
  {
    name: 'search_memories',
    description: 'Search memories/facts about the user, project, or previous conversations. Use when you need context about past decisions, preferences, or project details.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in memories'
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 10)',
          default: 10
        }
      },
      required: ['query']
    }
  },
  {
    name: 'add_memory',
    description: 'Save important information to long-term memory. Use when the user shares preferences, decisions, project facts, or anything worth remembering across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The information to remember'
        },
        type: {
          type: 'string',
          enum: ['static', 'dynamic'],
          description: 'static = permanent facts (name, preferences). dynamic = context (current project, recent decisions)',
          default: 'dynamic'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'get_user_profile',
    description: 'Get the full user profile — all stored facts and recent context. Use at the start of a session or when you need comprehensive context.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'delete_memory',
    description: 'Delete a specific memory by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Memory ID to delete'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'list_memories',
    description: 'List all stored memories. Use to see everything that has been saved.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max results (default: 50)',
          default: 50
        }
      },
      required: []
    }
  }
];

function handleToolCall(name, args) {
  switch (name) {
    case 'search_memories': {
      const results = mem.search(args.query, CONTAINER_TAG, args.limit || 10);
      return {
        content: [{
          type: 'text',
          text: results.length > 0
            ? results.map((r, i) => `[${i + 1}] (${r.memory_type}) ${r.content}`).join('\n\n')
            : 'No memories found matching that query.'
        }]
      };
    }

    case 'add_memory': {
      const result = mem.add(args.content, CONTAINER_TAG, args.type || 'dynamic');
      return {
        content: [{
          type: 'text',
          text: `✅ Memory saved (id: ${result.id}, type: ${args.type || 'dynamic'})`
        }]
      };
    }

    case 'get_user_profile': {
      const profile = mem.getProfile(CONTAINER_TAG);
      const parts = [];
      if (profile.static.length > 0) {
        parts.push('## Core Facts (Static)\n' + profile.static.map(m => `- ${m}`).join('\n'));
      }
      if (profile.dynamic.length > 0) {
        parts.push('## Recent Context (Dynamic)\n' + profile.dynamic.map(m => `- ${m}`).join('\n'));
      }
      return {
        content: [{
          type: 'text',
          text: parts.length > 0 ? parts.join('\n\n') : 'No user profile data yet. Start by adding memories!'
        }]
      };
    }

    case 'delete_memory': {
      mem.delete(args.id);
      return {
        content: [{ type: 'text', text: `✅ Memory ${args.id} deleted.` }]
      };
    }

    case 'list_memories': {
      const all = mem.listAll(CONTAINER_TAG, args.limit || 50);
      return {
        content: [{
          type: 'text',
          text: all.length > 0
            ? all.map((r, i) => `[${i + 1}] id:${r.id}\n    type: ${r.memory_type}\n    ${r.content}`).join('\n\n')
            : 'No memories stored yet.'
        }]
      };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ========================
// STDIO JSON-RPC TRANSPORT
// ========================
const rl = createInterface({ input: process.stdin, terminal: false });
let buffer = '';

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
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'self-hosted-memory',
          version: '1.0.0',
        },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
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
      if (id) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
});

// Keep alive
process.stdin.resume();
process.stderr.write(`[memory-mcp] Started. DB: ${DB_PATH}, Container: ${CONTAINER_TAG}\n`);
