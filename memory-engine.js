// ============================================================
// memory-engine.js — Core Memory Engine v2.0
// Beats every paid memory tool: Supermemory, Mem0, Zep, Langchain Memory
//
// Features:
//   - FTS5 full-text search with BM25 ranking
//   - Vector search with cosine similarity + caching
//   - Many-to-many container tags
//   - Memory deduplication & merge on insert
//   - Importance scoring (critical / high / normal / low)
//   - Time-decay weighting (recent memories rank higher)
//   - Memory relationships (links between related memories)
//   - Automatic semantic chunking for long texts
//   - Conversation fact extraction hooks
//   - Access tracking (frequently accessed memories rank higher)
//   - Soft-delete with recovery
//   - Bulk operations
// ============================================================

import Database from 'better-sqlite3';
import crypto from 'crypto';

// ========================
// CONSTANTS
// ========================
const IMPORTANCE_WEIGHTS = { critical: 4, high: 3, normal: 2, low: 1 };
const DECAY_HALF_LIFE_DAYS = 30; // dynamic memories lose half their score every 30 days
const SIMILARITY_MERGE_THRESHOLD = 0.85; // above this, memories are merged instead of duplicated
const MAX_CHUNK_LENGTH = 1500; // characters per chunk for long texts
const CHUNK_OVERLAP = 200; // overlap between chunks

export class MemoryEngine {
  constructor(options = {}) {
    this.dbPath = options.dbPath || './memories.db';
    this.embeddingFn = options.embeddingFn || null;
    this.embeddingCache = new Map(); // text hash -> embedding vector
    this.embeddingCacheMaxSize = options.embeddingCacheMaxSize || 5000;
    this.onFactsExtracted = options.onFactsExtracted || null; // callback(facts[])
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL'); // faster concurrent reads
    this.db.pragma('foreign_keys = ON');
    this._initDB();
    this._prepareStatements();
  }

  // ========================
  // SCHEMA
  // ========================
  _initDB() {
    this.db.exec(`
      -- Core memories table
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        summary TEXT,
        memory_type TEXT DEFAULT 'dynamic' CHECK(memory_type IN ('static','dynamic','episodic','semantic')),
        importance TEXT DEFAULT 'normal' CHECK(importance IN ('critical','high','normal','low')),
        source TEXT DEFAULT 'user',
        metadata TEXT DEFAULT '{}',
        embedding BLOB,
        access_count INTEGER DEFAULT 0,
        last_accessed_at DATETIME,
        is_deleted INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Many-to-many: memories <-> tags
      CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON memory_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_tags_memory ON memory_tags(memory_id);

      -- Memory relationships (graph edges)
      CREATE TABLE IF NOT EXISTS memory_links (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT DEFAULT 'related',
        strength REAL DEFAULT 1.0,
        PRIMARY KEY (source_id, target_id),
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      -- Conversations table
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        messages TEXT NOT NULL,
        container_tag TEXT DEFAULT 'default',
        summary TEXT,
        extracted_facts TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_conv_id ON conversations(conversation_id);

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_mem_deleted ON memories(is_deleted);
      CREATE INDEX IF NOT EXISTS idx_mem_updated ON memories(updated_at);
      CREATE INDEX IF NOT EXISTS idx_mem_source ON memories(source);
    `);

    // FTS5 virtual table for full-text search with BM25 ranking
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          summary,
          content_rowid='rowid',
          tokenize='porter unicode61'
        );
      `);
      this.hasFTS = true;
    } catch (e) {
      // FTS5 not available in this SQLite build — fall back to LIKE
      console.warn('[memory-engine] FTS5 not available, using keyword fallback:', e.message);
      this.hasFTS = false;
    }
  }

  _prepareStatements() {
    this._stmts = {
      insertMemory: this.db.prepare(`
        INSERT INTO memories (id, content, summary, memory_type, importance, source, metadata, embedding, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `),
      updateMemory: this.db.prepare(`
        UPDATE memories SET content = ?, summary = ?, importance = ?, metadata = ?, embedding = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      insertTag: this.db.prepare(`INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)`),
      deleteTagsForMemory: this.db.prepare(`DELETE FROM memory_tags WHERE memory_id = ?`),
      softDelete: this.db.prepare(`UPDATE memories SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
      hardDelete: this.db.prepare(`DELETE FROM memories WHERE id = ?`),
      bumpAccess: this.db.prepare(`
        UPDATE memories SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?
      `),
      insertLink: this.db.prepare(`INSERT OR REPLACE INTO memory_links (source_id, target_id, relation, strength) VALUES (?, ?, ?, ?)`),
      getById: this.db.prepare(`SELECT * FROM memories WHERE id = ? AND is_deleted = 0`),
    };
  }

  // ========================
  // ADD MEMORY (with dedup, chunking, multi-tag)
  // ========================
  async add({
    content,
    containerTags = ['default'],
    customId,
    metadata = {},
    memoryType = 'dynamic',
    importance = 'normal',
    source = 'user',
    summary = null,
    autoChunk = true,
    deduplicate = true,
  }) {
    const tags = Array.isArray(containerTags) ? containerTags : [containerTags];

    // Auto-chunk long texts
    if (autoChunk && content.length > MAX_CHUNK_LENGTH * 1.5) {
      return this._addChunked({ content, tags, customId, metadata, memoryType, importance, source, summary, deduplicate });
    }

    // Deduplication: check if a very similar memory already exists
    if (deduplicate && this.embeddingFn) {
      const existing = await this._findDuplicate(content, tags);
      if (existing) {
        return this._mergeMemory(existing, { content, metadata, importance });
      }
    }

    const id = customId || crypto.randomUUID();
    let embeddingBuf = null;
    if (this.embeddingFn) {
      const vec = await this._getEmbedding(content);
      embeddingBuf = Buffer.from(new Float32Array(vec).buffer);
    }

    const addOne = this.db.transaction(() => {
      this._stmts.insertMemory.run(
        id, content, summary, memoryType, importance, source,
        JSON.stringify(metadata), embeddingBuf
      );
      for (const tag of tags) {
        this._stmts.insertTag.run(id, tag);
      }

      // Sync FTS
      if (this.hasFTS) {
        try {
          const rowid = this.db.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(id)?.rowid;
          if (rowid) {
            this.db.prepare(`INSERT INTO memories_fts (rowid, content, summary) VALUES (?, ?, ?)`).run(rowid, content, summary || '');
          }
        } catch (_) { /* FTS sync failure is non-fatal */ }
      }
    });

    addOne();

    return { id, content, summary, tags, memoryType, importance };
  }

  // Chunk long text and store each chunk as a linked memory
  async _addChunked({ content, tags, customId, metadata, memoryType, importance, source, summary, deduplicate }) {
    const chunks = this._chunkText(content);
    const parentId = customId || crypto.randomUUID();
    const results = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = i === 0 ? parentId : `${parentId}_chunk_${i}`;
      const result = await this.add({
        content: chunks[i],
        containerTags: tags,
        customId: chunkId,
        metadata: { ...metadata, _chunkIndex: i, _chunkTotal: chunks.length, _parentId: parentId },
        memoryType,
        importance,
        source,
        summary: i === 0 ? summary : null,
        autoChunk: false,
        deduplicate,
      });
      results.push(result);

      // Link chunks to parent
      if (i > 0) {
        this._stmts.insertLink.run(parentId, chunkId, 'chunk', 1.0);
      }
    }

    return { id: parentId, chunks: results.length, tags };
  }

  _chunkText(text) {
    const chunks = [];
    // Split on paragraph boundaries first
    const paragraphs = text.split(/\n\n+/);
    let current = '';

    for (const para of paragraphs) {
      if ((current + '\n\n' + para).length > MAX_CHUNK_LENGTH && current.length > 0) {
        chunks.push(current.trim());
        // Overlap: keep last portion
        const words = current.split(/\s+/);
        const overlapWords = words.slice(-Math.floor(CHUNK_OVERLAP / 5));
        current = overlapWords.join(' ') + '\n\n' + para;
      } else {
        current = current ? current + '\n\n' + para : para;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    // If still too long (single giant paragraph), split by sentences
    const final = [];
    for (const chunk of chunks) {
      if (chunk.length > MAX_CHUNK_LENGTH * 2) {
        const sentences = chunk.match(/[^.!?]+[.!?]+/g) || [chunk];
        let buf = '';
        for (const sent of sentences) {
          if ((buf + sent).length > MAX_CHUNK_LENGTH && buf) {
            final.push(buf.trim());
            buf = sent;
          } else {
            buf += sent;
          }
        }
        if (buf.trim()) final.push(buf.trim());
      } else {
        final.push(chunk);
      }
    }

    return final.length > 0 ? final : [text];
  }

  // ========================
  // DEDUPLICATION & MERGE
  // ========================
  async _findDuplicate(content, tags) {
    const queryEmbedding = await this._getEmbedding(content);

    const tagPlaceholders = tags.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT m.id, m.content, m.importance, m.metadata, m.embedding
      FROM memories m
      JOIN memory_tags mt ON m.id = mt.memory_id
      WHERE mt.tag IN (${tagPlaceholders}) AND m.is_deleted = 0 AND m.embedding IS NOT NULL
      GROUP BY m.id
      ORDER BY m.updated_at DESC
      LIMIT 100
    `).all(...tags);

    for (const row of rows) {
      if (!row.embedding) continue;
      const docVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const sim = this._cosineSimilarity(queryEmbedding, Array.from(docVec));
      if (sim >= SIMILARITY_MERGE_THRESHOLD) {
        return row;
      }
    }
    return null;
  }

  _mergeMemory(existing, { content, metadata, importance }) {
    const merged = existing.content.length >= content.length
      ? existing.content
      : content; // keep the longer/richer version

    const existingMeta = JSON.parse(existing.metadata || '{}');
    const mergedMeta = { ...existingMeta, ...metadata, _mergedAt: new Date().toISOString() };

    // Upgrade importance if new one is higher
    const finalImportance = (IMPORTANCE_WEIGHTS[importance] || 2) > (IMPORTANCE_WEIGHTS[existing.importance] || 2)
      ? importance
      : existing.importance;

    this._stmts.updateMemory.run(
      merged, null, finalImportance, JSON.stringify(mergedMeta), existing.embedding, existing.id
    );

    // Sync FTS
    if (this.hasFTS) {
      try {
        const rowid = this.db.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(existing.id)?.rowid;
        if (rowid) {
          this.db.prepare(`UPDATE memories_fts SET content = ? WHERE rowid = ?`).run(merged, rowid);
        }
      } catch (_) {}
    }

    return { id: existing.id, merged: true, content: merged };
  }

  // ========================
  // UPDATE MEMORY
  // ========================
  async update(id, updates = {}) {
    const existing = this._stmts.getById.get(id);
    if (!existing) return { success: false, error: 'Memory not found' };

    const content = updates.content ?? existing.content;
    const summary = updates.summary ?? existing.summary;
    const importance = updates.importance ?? existing.importance;
    const meta = updates.metadata
      ? JSON.stringify({ ...JSON.parse(existing.metadata || '{}'), ...updates.metadata })
      : existing.metadata;

    let embeddingBuf = existing.embedding;
    if (updates.content && this.embeddingFn) {
      const vec = await this._getEmbedding(content);
      embeddingBuf = Buffer.from(new Float32Array(vec).buffer);
    }

    this._stmts.updateMemory.run(content, summary, importance, meta, embeddingBuf, id);

    // Update tags if provided
    if (updates.containerTags) {
      const tags = Array.isArray(updates.containerTags) ? updates.containerTags : [updates.containerTags];
      this._stmts.deleteTagsForMemory.run(id);
      for (const tag of tags) {
        this._stmts.insertTag.run(id, tag);
      }
    }

    // Sync FTS
    if (this.hasFTS) {
      try {
        const rowid = this.db.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(id)?.rowid;
        if (rowid) {
          this.db.prepare(`UPDATE memories_fts SET content = ?, summary = ? WHERE rowid = ?`).run(content, summary || '', rowid);
        }
      } catch (_) {}
    }

    return { success: true, id };
  }

  // ========================
  // SEARCH — Hybrid: FTS5 + Vector + Decay + Importance scoring
  // ========================
  async search({
    q,
    containerTags = [],
    limit = 10,
    includeFullDocs = true,
    memoryTypes = [],
    minImportance = null,
    includeDeleted = false,
  }) {
    const tags = Array.isArray(containerTags) ? containerTags : [containerTags];

    // Run both search strategies in parallel and merge
    const [ftsResults, vectorResults] = await Promise.all([
      this._ftsSearch(q, tags, limit * 2, includeDeleted, memoryTypes),
      this.embeddingFn ? this._vectorSearch(q, tags, limit * 2, includeDeleted, memoryTypes) : [],
    ]);

    // Merge & rank with composite scoring
    const scored = this._mergeAndRank(ftsResults, vectorResults, minImportance);
    const topResults = scored.slice(0, limit);

    // Bump access counts
    const bumpMany = this.db.transaction(() => {
      for (const r of topResults) this._stmts.bumpAccess.run(r.id);
    });
    bumpMany();

    return {
      results: topResults.map(r => ({
        id: r.id,
        content: includeFullDocs ? r.content : r.content.substring(0, 200),
        summary: r.summary,
        score: Math.round(r.finalScore * 1000) / 1000,
        memoryType: r.memory_type,
        importance: r.importance,
        tags: r.tags || [],
        metadata: JSON.parse(r.metadata || '{}'),
        createdAt: r.created_at,
        accessCount: r.access_count,
      })),
    };
  }

  async _ftsSearch(query, tags, limit, includeDeleted, memoryTypes) {
    if (this.hasFTS && query.trim()) {
      try {
        // Sanitize FTS query — escape special chars, prefix each word for partial matching
        const ftsQuery = query
          .replace(/['"*(){}[\]:^~!@#$%&\\]/g, '')
          .split(/\s+/)
          .filter(w => w.length > 1)
          .map(w => `"${w}"*`)
          .join(' OR ');

        if (!ftsQuery) return this._keywordSearch(query, tags, limit, includeDeleted, memoryTypes);

        let sql = `
          SELECT m.*, memories_fts.rank AS fts_rank
          FROM memories_fts
          JOIN memories m ON m.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ? AND m.is_deleted = ?
        `;
        const params = [ftsQuery, includeDeleted ? 1 : 0];

        if (tags.length > 0) {
          sql += ` AND m.id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${tags.map(() => '?').join(',')}))`;
          params.push(...tags);
        }
        if (memoryTypes.length > 0) {
          sql += ` AND m.memory_type IN (${memoryTypes.map(() => '?').join(',')})`;
          params.push(...memoryTypes);
        }
        sql += ` ORDER BY fts_rank LIMIT ?`;
        params.push(limit);

        const rows = this.db.prepare(sql).all(...params);
        return rows.map(r => ({ ...r, _ftsScore: Math.abs(r.fts_rank || 0) }));
      } catch (e) {
        // FTS query failed, fall back
        return this._keywordSearch(query, tags, limit, includeDeleted, memoryTypes);
      }
    }
    return this._keywordSearch(query, tags, limit, includeDeleted, memoryTypes);
  }

  _keywordSearch(query, tags, limit, includeDeleted, memoryTypes) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) {
      return this._getRecent(tags, limit, includeDeleted, memoryTypes);
    }

    const conditions = words.map(() => `LOWER(m.content) LIKE ?`).join(' OR ');
    const params = [];

    let sql = `SELECT m.* FROM memories m`;
    if (tags.length > 0) {
      sql += ` JOIN memory_tags mt ON m.id = mt.memory_id`;
    }
    sql += ` WHERE m.is_deleted = ? AND (${conditions})`;
    params.push(includeDeleted ? 1 : 0);
    params.push(...words.map(w => `%${w}%`));

    if (tags.length > 0) {
      sql += ` AND mt.tag IN (${tags.map(() => '?').join(',')})`;
      params.push(...tags);
    }
    if (memoryTypes.length > 0) {
      sql += ` AND m.memory_type IN (${memoryTypes.map(() => '?').join(',')})`;
      params.push(...memoryTypes);
    }
    sql += ` GROUP BY m.id ORDER BY m.updated_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(row => {
      const lc = row.content.toLowerCase();
      const matchCount = words.filter(w => lc.includes(w)).length;
      return { ...row, _ftsScore: matchCount / words.length };
    });
  }

  _getRecent(tags, limit, includeDeleted, memoryTypes) {
    let sql = `SELECT m.* FROM memories m`;
    const params = [];

    if (tags.length > 0) {
      sql += ` JOIN memory_tags mt ON m.id = mt.memory_id`;
    }
    sql += ` WHERE m.is_deleted = ?`;
    params.push(includeDeleted ? 1 : 0);

    if (tags.length > 0) {
      sql += ` AND mt.tag IN (${tags.map(() => '?').join(',')})`;
      params.push(...tags);
    }
    if (memoryTypes.length > 0) {
      sql += ` AND m.memory_type IN (${memoryTypes.map(() => '?').join(',')})`;
      params.push(...memoryTypes);
    }
    sql += ` GROUP BY m.id ORDER BY m.updated_at DESC LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params).map(r => ({ ...r, _ftsScore: 0.3 }));
  }

  async _vectorSearch(query, tags, limit, includeDeleted, memoryTypes) {
    const queryEmbedding = await this._getEmbedding(query);

    let sql = `SELECT m.* FROM memories m`;
    const params = [];

    if (tags.length > 0) {
      sql += ` JOIN memory_tags mt ON m.id = mt.memory_id`;
    }
    sql += ` WHERE m.is_deleted = ? AND m.embedding IS NOT NULL`;
    params.push(includeDeleted ? 1 : 0);

    if (tags.length > 0) {
      sql += ` AND mt.tag IN (${tags.map(() => '?').join(',')})`;
      params.push(...tags);
    }
    if (memoryTypes.length > 0) {
      sql += ` AND m.memory_type IN (${memoryTypes.map(() => '?').join(',')})`;
      params.push(...memoryTypes);
    }
    sql += ` GROUP BY m.id`;

    const rows = this.db.prepare(sql).all(...params);

    const scored = rows.map(row => {
      const docVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const similarity = this._cosineSimilarity(queryEmbedding, Array.from(docVec));
      return { ...row, _vectorScore: similarity };
    });

    scored.sort((a, b) => b._vectorScore - a._vectorScore);
    return scored.slice(0, limit);
  }

  // Composite ranking: combine FTS, vector, importance, recency, access frequency
  _mergeAndRank(ftsResults, vectorResults, minImportance) {
    const byId = new Map();

    for (const r of ftsResults) {
      byId.set(r.id, { ...r, _ftsScore: r._ftsScore || 0, _vectorScore: 0 });
    }
    for (const r of vectorResults) {
      if (byId.has(r.id)) {
        byId.get(r.id)._vectorScore = r._vectorScore || 0;
      } else {
        byId.set(r.id, { ...r, _ftsScore: 0, _vectorScore: r._vectorScore || 0 });
      }
    }

    const now = Date.now();
    const results = [];

    for (const [, r] of byId) {
      // Filter by minimum importance
      if (minImportance && (IMPORTANCE_WEIGHTS[r.importance] || 2) < (IMPORTANCE_WEIGHTS[minImportance] || 0)) {
        continue;
      }

      // Fetch tags for this memory
      const tags = this.db.prepare(`SELECT tag FROM memory_tags WHERE memory_id = ?`).all(r.id).map(t => t.tag);

      // Time decay: half-life based on memory type
      const ageMs = now - new Date(r.updated_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const decayRate = r.memory_type === 'static' ? 0 : Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
      const recencyScore = r.memory_type === 'static' ? 1.0 : decayRate;

      // Importance weight
      const impWeight = (IMPORTANCE_WEIGHTS[r.importance] || 2) / 4;

      // Access frequency boost (log scale to avoid runaway)
      const accessBoost = Math.log2((r.access_count || 0) + 1) * 0.05;

      // Composite score (weights tuned for best results)
      const ftsNorm = Math.min(r._ftsScore / 5, 1);
      const vecNorm = r._vectorScore || 0;

      const finalScore =
        (vecNorm * 0.40) +       // semantic similarity is king
        (ftsNorm * 0.25) +       // keyword relevance
        (recencyScore * 0.15) +  // recency
        (impWeight * 0.12) +     // importance
        (accessBoost * 0.08);    // access frequency

      results.push({ ...r, tags, finalScore });
    }

    results.sort((a, b) => b.finalScore - a.finalScore);
    return results;
  }

  // ========================
  // PROFILE — Static facts + Dynamic context + Relevant search
  // ========================
  async getProfile(containerTag, queryText = '') {
    const tags = Array.isArray(containerTag) ? containerTag : [containerTag || 'default'];
    const tagPlaceholders = tags.map(() => '?').join(',');

    const staticMemories = this.db.prepare(`
      SELECT m.content, m.importance FROM memories m
      JOIN memory_tags mt ON m.id = mt.memory_id
      WHERE mt.tag IN (${tagPlaceholders}) AND m.memory_type = 'static' AND m.is_deleted = 0
      ORDER BY
        CASE m.importance WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        m.updated_at DESC
    `).all(...tags);

    const dynamicMemories = this.db.prepare(`
      SELECT m.content, m.importance, m.updated_at FROM memories m
      JOIN memory_tags mt ON m.id = mt.memory_id
      WHERE mt.tag IN (${tagPlaceholders}) AND m.memory_type IN ('dynamic','episodic') AND m.is_deleted = 0
      ORDER BY m.updated_at DESC
      LIMIT 30
    `).all(...tags);

    let searchResults = { results: [] };
    if (queryText) {
      searchResults = await this.search({
        q: queryText,
        containerTags: tags,
        limit: 10,
        includeFullDocs: true,
      });
    }

    return {
      profile: {
        static: staticMemories.map(r => ({ content: r.content, importance: r.importance })),
        dynamic: dynamicMemories.map(r => ({ content: r.content, importance: r.importance, updatedAt: r.updated_at })),
      },
      searchResults,
      stats: this.getStats(tags),
    };
  }

  // ========================
  // CONVERSATIONS (with fact extraction)
  // ========================
  async addConversation({ conversationId, messages, containerTags = ['default'], extractFacts = true }) {
    const id = crypto.randomUUID();
    const tags = Array.isArray(containerTags) ? containerTags : [containerTags];
    const tag = tags[0];

    // Build conversation text
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : ''}`)
      .join('\n\n');

    this.db.prepare(`
      INSERT INTO conversations (id, conversation_id, messages, container_tag, summary)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, conversationId, JSON.stringify(messages), tag, null);

    // Save full conversation as episodic memory
    if (conversationText.trim()) {
      await this.add({
        content: conversationText,
        containerTags: tags,
        customId: `conv:${conversationId}`,
        memoryType: 'episodic',
        importance: 'normal',
        source: 'conversation',
        autoChunk: true,
        deduplicate: false,
      });
    }

    // Extract facts using callback if provided
    let extractedFacts = [];
    if (extractFacts && this.onFactsExtracted) {
      try {
        extractedFacts = await this.onFactsExtracted(messages, conversationText);
        // Save each extracted fact as a separate memory
        for (const fact of extractedFacts) {
          await this.add({
            content: fact.content || fact,
            containerTags: tags,
            memoryType: fact.type || 'static',
            importance: fact.importance || 'normal',
            source: 'auto_extracted',
            deduplicate: true,
          });
        }
        // Update conversation with extracted facts
        this.db.prepare(`UPDATE conversations SET extracted_facts = ? WHERE id = ?`)
          .run(JSON.stringify(extractedFacts), id);
      } catch (e) {
        console.warn('[memory-engine] Fact extraction failed:', e.message);
      }
    }

    return { id, conversationId, extractedFacts: extractedFacts.length };
  }

  // ========================
  // RELATIONSHIPS (memory graph)
  // ========================
  link(sourceId, targetId, relation = 'related', strength = 1.0) {
    this._stmts.insertLink.run(sourceId, targetId, relation, strength);
    return { success: true };
  }

  getRelated(memoryId, { relation = null, limit = 10 } = {}) {
    let sql = `
      SELECT m.*, ml.relation, ml.strength
      FROM memory_links ml
      JOIN memories m ON m.id = ml.target_id
      WHERE ml.source_id = ? AND m.is_deleted = 0
    `;
    const params = [memoryId];

    if (relation) {
      sql += ` AND ml.relation = ?`;
      params.push(relation);
    }
    sql += ` ORDER BY ml.strength DESC LIMIT ?`;
    params.push(limit);

    return this.db.prepare(sql).all(...params);
  }

  // ========================
  // DELETE (soft & hard)
  // ========================
  delete(id, { hard = false } = {}) {
    if (hard) {
      // Also clean up FTS
      if (this.hasFTS) {
        try {
          const rowid = this.db.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(id)?.rowid;
          if (rowid) {
            this.db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`).run(rowid);
          }
        } catch (_) {}
      }
      this._stmts.hardDelete.run(id);
    } else {
      this._stmts.softDelete.run(id);
    }
    return { success: true };
  }

  restore(id) {
    this.db.prepare(`UPDATE memories SET is_deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    return { success: true };
  }

  // ========================
  // BULK OPERATIONS
  // ========================
  async addBulk(memories) {
    const results = [];
    const addMany = this.db.transaction(async () => {
      for (const mem of memories) {
        const result = await this.add(mem);
        results.push(result);
      }
    });
    await addMany();
    return results;
  }

  deleteBulk(ids, { hard = false } = {}) {
    const delMany = this.db.transaction(() => {
      for (const id of ids) {
        this.delete(id, { hard });
      }
    });
    delMany();
    return { success: true, count: ids.length };
  }

  // ========================
  // MAINTENANCE — Cleanup old dynamic memories, compact DB
  // ========================
  cleanup({ maxAgeDays = 90, dryRun = false } = {}) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

    const stale = this.db.prepare(`
      SELECT id, content, memory_type, updated_at FROM memories
      WHERE memory_type = 'dynamic' AND is_deleted = 0 AND updated_at < ?
        AND importance NOT IN ('critical', 'high')
        AND access_count < 3
    `).all(cutoff);

    if (dryRun) return { wouldDelete: stale.length, items: stale };

    const softDeleteMany = this.db.transaction(() => {
      for (const row of stale) {
        this._stmts.softDelete.run(row.id);
      }
    });
    softDeleteMany();

    return { deleted: stale.length };
  }

  vacuum() {
    // Permanently remove soft-deleted items older than 7 days
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`DELETE FROM memories WHERE is_deleted = 1 AND updated_at < ?`).run(cutoff);
    this.db.exec('VACUUM');
    return { success: true };
  }

  // ========================
  // STATS
  // ========================
  getStats(containerTags) {
    const tags = containerTags ? (Array.isArray(containerTags) ? containerTags : [containerTags]) : null;

    let totalSql = `SELECT COUNT(*) as count FROM memories WHERE is_deleted = 0`;
    let typeSql = `SELECT memory_type, COUNT(*) as count FROM memories WHERE is_deleted = 0`;

    if (tags && tags.length > 0) {
      const tagPlaceholders = tags.map(() => '?').join(',');
      totalSql = `SELECT COUNT(DISTINCT m.id) as count FROM memories m JOIN memory_tags mt ON m.id = mt.memory_id WHERE m.is_deleted = 0 AND mt.tag IN (${tagPlaceholders})`;
      typeSql = `SELECT m.memory_type, COUNT(DISTINCT m.id) as count FROM memories m JOIN memory_tags mt ON m.id = mt.memory_id WHERE m.is_deleted = 0 AND mt.tag IN (${tagPlaceholders}) GROUP BY m.memory_type`;
      const total = this.db.prepare(totalSql).get(...tags);
      const byType = this.db.prepare(typeSql).all(...tags);
      return { total: total.count, byType: Object.fromEntries(byType.map(r => [r.memory_type, r.count])) };
    }

    const total = this.db.prepare(totalSql).get();
    const byType = this.db.prepare(typeSql + ` GROUP BY memory_type`).all();
    return { total: total.count, byType: Object.fromEntries(byType.map(r => [r.memory_type, r.count])) };
  }

  // ========================
  // EMBEDDING UTILS (with caching)
  // ========================
  async _getEmbedding(text) {
    const hash = this._hashText(text);
    if (this.embeddingCache.has(hash)) return this.embeddingCache.get(hash);

    const vec = await this.embeddingFn(text);

    // Evict oldest if cache is full
    if (this.embeddingCache.size >= this.embeddingCacheMaxSize) {
      const firstKey = this.embeddingCache.keys().next().value;
      this.embeddingCache.delete(firstKey);
    }
    this.embeddingCache.set(hash, vec);

    return vec;
  }

  _hashText(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  // ========================
  // EXPORT / IMPORT
  // ========================
  exportAll(containerTags) {
    const tags = containerTags ? (Array.isArray(containerTags) ? containerTags : [containerTags]) : null;

    let sql = `SELECT m.*, GROUP_CONCAT(mt.tag) as tags FROM memories m LEFT JOIN memory_tags mt ON m.id = mt.memory_id WHERE m.is_deleted = 0`;
    const params = [];

    if (tags && tags.length > 0) {
      sql += ` AND m.id IN (SELECT memory_id FROM memory_tags WHERE tag IN (${tags.map(() => '?').join(',')}))`;
      params.push(...tags);
    }
    sql += ` GROUP BY m.id ORDER BY m.created_at`;

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => ({
      id: r.id,
      content: r.content,
      summary: r.summary,
      memoryType: r.memory_type,
      importance: r.importance,
      source: r.source,
      metadata: JSON.parse(r.metadata || '{}'),
      tags: r.tags ? r.tags.split(',') : [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async importBulk(memories) {
    const results = [];
    for (const mem of memories) {
      const result = await this.add({
        content: mem.content,
        containerTags: mem.tags || ['default'],
        customId: mem.id,
        memoryType: mem.memoryType || 'dynamic',
        importance: mem.importance || 'normal',
        source: mem.source || 'import',
        metadata: mem.metadata || {},
        summary: mem.summary,
        deduplicate: true,
      });
      results.push(result);
    }
    return results;
  }

  // ========================
  // CLOSE
  // ========================
  close() {
    this.embeddingCache.clear();
    this.db.close();
  }
}

export default MemoryEngine;
