// ============================================================
// memory-engine.js — Core Memory Engine (replaces Supermemory API)
// Uses: SQLite + local embeddings for vector search
// ============================================================

import Database from 'better-sqlite3';
import crypto from 'crypto';

export class MemoryEngine {
  constructor(options = {}) {
    this.dbPath = options.dbPath || './memories.db';
    this.embeddingFn = options.embeddingFn || null; // custom embedding function
    this.db = new Database(this.dbPath);
    this._initDB();
  }

  _initDB() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        container_tag TEXT DEFAULT 'default',
        custom_id TEXT,
        memory_type TEXT DEFAULT 'dynamic',  -- 'static' or 'dynamic'
        metadata TEXT DEFAULT '{}',
        embedding TEXT,  -- JSON array of floats
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_container ON memories(container_tag);
      CREATE INDEX IF NOT EXISTS idx_custom_id ON memories(custom_id);
      CREATE INDEX IF NOT EXISTS idx_type ON memories(memory_type);

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        messages TEXT NOT NULL,  -- JSON array
        container_tag TEXT DEFAULT 'default',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_conv_id ON conversations(conversation_id);
    `);
  }

  // ========================
  // ADD MEMORY
  // ========================
  async add({ content, containerTags = ['default'], customId, metadata = {}, memoryType = 'dynamic' }) {
    const id = customId || crypto.randomUUID();
    const tag = Array.isArray(containerTags) ? containerTags[0] : containerTags;

    // Generate embedding if we have an embedding function
    let embedding = null;
    if (this.embeddingFn) {
      embedding = await this.embeddingFn(content);
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, content, container_tag, custom_id, memory_type, metadata, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(
      id,
      content,
      tag,
      customId || null,
      memoryType,
      JSON.stringify(metadata),
      embedding ? JSON.stringify(embedding) : null
    );

    return { id, content, containerTag: tag };
  }

  // ========================
  // SEARCH MEMORIES (vector similarity + keyword fallback)
  // ========================
  async search({ q, containerTags = ['default'], limit = 10, includeFullDocs = true }) {
    const tag = Array.isArray(containerTags) ? containerTags[0] : containerTags;

    // If we have embeddings, do vector search
    if (this.embeddingFn) {
      return this._vectorSearch(q, tag, limit, includeFullDocs);
    }

    // Fallback: keyword search using SQLite FTS-like matching
    return this._keywordSearch(q, tag, limit, includeFullDocs);
  }

  async _vectorSearch(query, tag, limit, includeFullDocs) {
    const queryEmbedding = await this.embeddingFn(query);

    const rows = this.db.prepare(`
      SELECT id, content, memory_type, metadata, embedding, custom_id
      FROM memories
      WHERE container_tag = ? AND embedding IS NOT NULL
    `).all(tag);

    // Calculate cosine similarity
    const scored = rows.map(row => {
      const docEmbedding = JSON.parse(row.embedding);
      const similarity = this._cosineSimilarity(queryEmbedding, docEmbedding);
      return { ...row, similarity };
    });

    // Sort by similarity, take top N
    scored.sort((a, b) => b.similarity - a.similarity);
    const results = scored.slice(0, limit);

    return {
      results: results.map(r => ({
        content: includeFullDocs ? r.content : r.content.substring(0, 200),
        documentId: r.custom_id || r.id,
        score: r.similarity,
        metadata: JSON.parse(r.metadata || '{}')
      }))
    };
  }

  _keywordSearch(query, tag, limit, includeFullDocs) {
    // Simple keyword matching - searches for any word in the query
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    if (words.length === 0) {
      // Return recent memories if no meaningful keywords
      const rows = this.db.prepare(`
        SELECT id, content, memory_type, metadata, custom_id
        FROM memories
        WHERE container_tag = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(tag, limit);

      return {
        results: rows.map(r => ({
          content: includeFullDocs ? r.content : r.content.substring(0, 200),
          documentId: r.custom_id || r.id,
          score: 0.5,
          metadata: JSON.parse(r.metadata || '{}')
        }))
      };
    }

    // Build LIKE clauses for each word
    const conditions = words.map(() => `LOWER(content) LIKE ?`).join(' OR ');
    const params = words.map(w => `%${w}%`);

    const rows = this.db.prepare(`
      SELECT id, content, memory_type, metadata, custom_id
      FROM memories
      WHERE container_tag = ? AND (${conditions})
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(tag, ...params, limit);

    // Score by how many keywords matched
    const results = rows.map(row => {
      const lowerContent = row.content.toLowerCase();
      const matchCount = words.filter(w => lowerContent.includes(w)).length;
      return {
        content: includeFullDocs ? row.content : row.content.substring(0, 200),
        documentId: row.custom_id || row.id,
        score: matchCount / words.length,
        metadata: JSON.parse(row.metadata || '{}')
      };
    });

    results.sort((a, b) => b.score - a.score);
    return { results };
  }

  // ========================
  // PROFILE (replaces /v4/profile endpoint)
  // ========================
  async getProfile(containerTag, queryText = '') {
    const tag = containerTag || 'default';

    // Get static memories (core facts about user)
    const staticMemories = this.db.prepare(`
      SELECT content FROM memories
      WHERE container_tag = ? AND memory_type = 'static'
      ORDER BY updated_at DESC
    `).all(tag).map(r => r.content);

    // Get dynamic memories (recent context)
    const dynamicMemories = this.db.prepare(`
      SELECT content FROM memories
      WHERE container_tag = ? AND memory_type = 'dynamic'
      ORDER BY updated_at DESC
      LIMIT 20
    `).all(tag).map(r => r.content);

    // Search results based on query
    let searchResults = { results: [] };
    if (queryText) {
      searchResults = await this.search({
        q: queryText,
        containerTags: [tag],
        limit: 10,
        includeFullDocs: false
      });
    }

    return {
      profile: {
        static: staticMemories,
        dynamic: dynamicMemories
      },
      searchResults: searchResults
    };
  }

  // ========================
  // CONVERSATIONS
  // ========================
  async addConversation({ conversationId, messages, containerTags = ['default'] }) {
    const id = crypto.randomUUID();
    const tag = Array.isArray(containerTags) ? containerTags[0] : containerTags;

    this.db.prepare(`
      INSERT INTO conversations (id, conversation_id, messages, container_tag)
      VALUES (?, ?, ?, ?)
    `).run(id, conversationId, JSON.stringify(messages), tag);

    // Also save each message as a memory for future retrieval
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : ''}`)
      .join('\n\n');

    if (conversationText.trim()) {
      await this.add({
        content: conversationText,
        containerTags,
        customId: `conversation:${conversationId}`,
        memoryType: 'dynamic'
      });
    }

    return { id, conversationId };
  }

  // ========================
  // DELETE
  // ========================
  delete(id) {
    this.db.prepare('DELETE FROM memories WHERE id = ? OR custom_id = ?').run(id, id);
    return { success: true };
  }

  // ========================
  // UTILS
  // ========================
  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  close() {
    this.db.close();
  }
}

export default MemoryEngine;
