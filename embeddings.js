// ============================================================
// embeddings.js — Embedding Providers v2.0
// Fixed ESM imports, added caching, batch embedding, and BM25
//
// Options:
//   1. Transformers.js — 100% local, free, best privacy
//   2. OpenAI — cheap ($0.02/1M tokens), most accurate
//   3. Ollama — local + fast, free
//   4. TF-IDF/BM25 — zero deps, lightweight
//   5. No embeddings — keyword search only
// ============================================================

import crypto from 'crypto';

// ========================
// OPTION 1: Transformers.js (100% local, no API, FREE)
// Install: npm install @xenova/transformers
// ========================
export async function createLocalEmbedding(options = {}) {
  const modelName = options.model || 'Xenova/all-MiniLM-L6-v2';
  const { pipeline } = await import('@xenova/transformers');
  const extractor = await pipeline('feature-extraction', modelName);

  // In-memory cache
  const cache = new Map();
  const maxCache = options.cacheSize || 2000;

  async function embed(text) {
    const key = _hash(text);
    if (cache.has(key)) return cache.get(key);

    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(output.data);

    if (cache.size >= maxCache) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, vec);
    return vec;
  }

  // Batch embedding — process multiple texts efficiently
  embed.batch = async function batchEmbed(texts) {
    const results = [];
    for (const text of texts) {
      results.push(await embed(text));
    }
    return results;
  };

  embed.dimensions = 384; // MiniLM-L6 dimensions
  embed.modelName = modelName;
  return embed;
}


// ========================
// OPTION 2: OpenAI Embeddings (cheap, very accurate)
// Install: npm install openai
// ========================
export async function createOpenAIEmbedding(apiKeyOrOptions = {}) {
  const opts = typeof apiKeyOrOptions === 'string'
    ? { apiKey: apiKeyOrOptions }
    : apiKeyOrOptions;

  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  const model = opts.model || 'text-embedding-3-small';

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const cache = new Map();
  const maxCache = opts.cacheSize || 2000;

  async function embed(text) {
    const key = _hash(text);
    if (cache.has(key)) return cache.get(key);

    const response = await client.embeddings.create({ model, input: text });
    const vec = response.data[0].embedding;

    if (cache.size >= maxCache) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, vec);
    return vec;
  }

  // Batch: OpenAI supports up to 2048 inputs at once
  embed.batch = async function batchEmbed(texts) {
    const uncachedIndices = [];
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i++) {
      const key = _hash(texts[i]);
      if (cache.has(key)) {
        results[i] = cache.get(key);
      } else {
        uncachedIndices.push(i);
      }
    }

    if (uncachedIndices.length > 0) {
      // Process in batches of 2048 (OpenAI limit)
      for (let batch = 0; batch < uncachedIndices.length; batch += 2048) {
        const batchIndices = uncachedIndices.slice(batch, batch + 2048);
        const batchTexts = batchIndices.map(i => texts[i]);

        const response = await client.embeddings.create({ model, input: batchTexts });
        for (let j = 0; j < response.data.length; j++) {
          const vec = response.data[j].embedding;
          const idx = batchIndices[j];
          results[idx] = vec;

          const key = _hash(texts[idx]);
          if (cache.size >= maxCache) cache.delete(cache.keys().next().value);
          cache.set(key, vec);
        }
      }
    }

    return results;
  };

  embed.dimensions = model.includes('3-large') ? 3072 : 1536;
  embed.modelName = model;
  return embed;
}


// ========================
// OPTION 3: Ollama (local, free, fast)
// Requires: Ollama running locally
// ========================
export function createOllamaEmbedding(options = {}) {
  const model = options.model || 'nomic-embed-text';
  const baseUrl = options.baseUrl || 'http://localhost:11434';

  const cache = new Map();
  const maxCache = options.cacheSize || 2000;

  async function embed(text) {
    const key = _hash(text);
    if (cache.has(key)) return cache.get(key);

    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });

    if (!response.ok) throw new Error(`Ollama embedding failed: ${response.status}`);
    const data = await response.json();
    const vec = data.embedding;

    if (cache.size >= maxCache) cache.delete(cache.keys().next().value);
    cache.set(key, vec);
    return vec;
  }

  embed.batch = async function batchEmbed(texts) {
    return Promise.all(texts.map(t => embed(t)));
  };

  embed.dimensions = 768; // nomic-embed-text default
  embed.modelName = model;
  return embed;
}


// ========================
// OPTION 4: TF-IDF + BM25 (lightweight, zero AI deps)
// ========================
export class BM25Embedding {
  constructor(options = {}) {
    this.vocabulary = new Map();
    this.idf = new Map();
    this.docCount = 0;
    this.avgDocLength = 0;
    this.dimensions = options.dimensions || 512;
    // BM25 parameters
    this.k1 = options.k1 || 1.5;
    this.b = options.b || 0.75;
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  }

  // Build/update vocabulary from documents
  buildVocabulary(documents) {
    this.docCount = documents.length;
    const docFreq = new Map();
    let totalLength = 0;

    for (const doc of documents) {
      const tokens = new Set(this._tokenize(doc));
      totalLength += tokens.size;
      for (const token of tokens) {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
        if (!this.vocabulary.has(token)) {
          this.vocabulary.set(token, this.vocabulary.size);
        }
      }
    }

    this.avgDocLength = totalLength / (this.docCount || 1);

    // IDF with BM25 variant: log((N - n + 0.5) / (n + 0.5) + 1)
    for (const [token, freq] of docFreq) {
      this.idf.set(token, Math.log((this.docCount - freq + 0.5) / (freq + 0.5) + 1));
    }
  }

  // Generate a fixed-size vector
  embed(text) {
    const tokens = this._tokenize(text);
    const tf = new Map();

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    const docLen = tokens.length;
    const vector = new Array(this.dimensions).fill(0);

    for (const [token, rawTf] of tf) {
      const idf = this.idf.get(token) || Math.log(this.docCount + 1);
      // BM25 TF saturation
      const tfNorm = (rawTf * (this.k1 + 1)) / (rawTf + this.k1 * (1 - this.b + this.b * docLen / (this.avgDocLength || 1)));
      const score = idf * tfNorm;
      const idx = (this.vocabulary.get(token) || _simpleHash(token)) % this.dimensions;
      vector[idx] += score;
    }

    // L2 normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }

    return vector;
  }

  // Make it work as an embedding function
  asFunction() {
    const self = this;
    const fn = (text) => self.embed(text);
    fn.batch = (texts) => texts.map(t => self.embed(t));
    fn.dimensions = this.dimensions;
    fn.modelName = 'bm25-local';
    return fn;
  }
}


// ========================
// OPTION 5: Hybrid — combine multiple embedding sources
// ========================
export function createHybridEmbedding(primaryFn, fallbackFn) {
  async function embed(text) {
    try {
      return await primaryFn(text);
    } catch (e) {
      console.warn('[embeddings] Primary failed, using fallback:', e.message);
      return await fallbackFn(text);
    }
  }

  embed.batch = async function batchEmbed(texts) {
    try {
      if (primaryFn.batch) return await primaryFn.batch(texts);
      return await Promise.all(texts.map(t => primaryFn(t)));
    } catch (e) {
      console.warn('[embeddings] Primary batch failed, using fallback:', e.message);
      if (fallbackFn.batch) return await fallbackFn.batch(texts);
      return await Promise.all(texts.map(t => fallbackFn(t)));
    }
  };

  embed.dimensions = primaryFn.dimensions || fallbackFn.dimensions;
  embed.modelName = `hybrid:${primaryFn.modelName || 'primary'}+${fallbackFn.modelName || 'fallback'}`;
  return embed;
}


// ========================
// FACT EXTRACTION (for conversation memory)
// Uses any LLM to extract structured facts from conversations
// ========================
export function createFactExtractor(options = {}) {
  const generateFn = options.generateFn; // async (prompt) => string

  if (!generateFn) {
    throw new Error('createFactExtractor requires a generateFn option');
  }

  return async function extractFacts(messages, conversationText) {
    const prompt = `Analyze this conversation and extract important facts about the user that should be remembered long-term.

For each fact, output a JSON object on its own line with these fields:
- "content": the fact in a clear, standalone sentence
- "type": "static" for permanent facts (name, preferences, background) or "dynamic" for temporary context (current project, today's mood)
- "importance": "critical" for identity facts, "high" for strong preferences, "normal" for general info, "low" for minor details

Only extract genuinely useful facts. Skip greetings, filler, and obvious things.

Conversation:
${conversationText}

Output ONLY the JSON objects, one per line:`;

    try {
      const response = await generateFn(prompt);
      const facts = [];
      const lines = response.split('\n').filter(l => l.trim().startsWith('{'));

      for (const line of lines) {
        try {
          const fact = JSON.parse(line.trim());
          if (fact.content && typeof fact.content === 'string') {
            facts.push({
              content: fact.content,
              type: ['static', 'dynamic'].includes(fact.type) ? fact.type : 'dynamic',
              importance: ['critical', 'high', 'normal', 'low'].includes(fact.importance) ? fact.importance : 'normal',
            });
          }
        } catch (_) { /* skip malformed lines */ }
      }

      return facts;
    } catch (e) {
      console.warn('[fact-extractor] Failed:', e.message);
      return [];
    }
  };
}


// ========================
// UTILS
// ========================
function _hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function _simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

const STOP_WORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in',
  'with', 'to', 'for', 'of', 'not', 'no', 'can', 'had', 'have', 'was',
  'were', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'do', 'does', 'did', 'be', 'been', 'being', 'am', 'are', 'has', 'he',
  'she', 'it', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'we', 'you', 'me', 'him',
  'from', 'by', 'as', 'into', 'about', 'than', 'then', 'so', 'if',
  'just', 'also', 'very', 'how', 'what', 'when', 'where', 'who', 'why',
]);

export default {
  createLocalEmbedding,
  createOpenAIEmbedding,
  createOllamaEmbedding,
  createHybridEmbedding,
  createFactExtractor,
  BM25Embedding,
};
