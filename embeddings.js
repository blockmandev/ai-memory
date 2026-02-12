// ============================================================
// embeddings.js — Free Embedding Options (replaces Supermemory's vector search)
// Choose the one that fits your project
// ============================================================

// ========================
// OPTION 1: Transformers.js (100% local, no API, FREE)
// Best for: Privacy-first apps, your IPFS/encrypted DB project
// Install: npm install @xenova/transformers
// ========================

export async function createLocalEmbedding() {
  const { pipeline } = await import('@xenova/transformers');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  return async function embed(text) {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  };
}

// Usage:
// const embeddingFn = await createLocalEmbedding();
// const engine = new MemoryEngine({ embeddingFn });


// ========================
// OPTION 2: OpenAI Embeddings (cheap, very accurate)
// Cost: ~$0.02 per 1M tokens
// Install: npm install openai
// ========================

export function createOpenAIEmbedding(apiKey) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });

  return async function embed(text) {
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0].embedding;
  };
}


// ========================
// OPTION 3: Ollama (local, free, fast)
// Requires: Ollama installed locally (https://ollama.ai)
// ========================

export function createOllamaEmbedding(model = 'nomic-embed-text') {
  return async function embed(text) {
    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    const data = await response.json();
    return data.embedding;
  };
}


// ========================
// OPTION 4: No embeddings (keyword search only)
// Simplest option — just use the MemoryEngine without an embeddingFn
// Still works well for most use cases!
// ========================

// const engine = new MemoryEngine();  // keyword search fallback


// ========================
// OPTION 5: TF-IDF (lightweight, no dependencies)
// Good balance of speed and relevance without AI models
// ========================

export class TFIDFEmbedding {
  constructor() {
    this.vocabulary = new Map();
    this.idf = new Map();
    this.docCount = 0;
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  // Build vocabulary from existing memories (call periodically)
  buildVocabulary(documents) {
    this.docCount = documents.length;
    const docFreq = new Map();

    for (const doc of documents) {
      const tokens = new Set(this._tokenize(doc));
      for (const token of tokens) {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
        if (!this.vocabulary.has(token)) {
          this.vocabulary.set(token, this.vocabulary.size);
        }
      }
    }

    // Calculate IDF
    for (const [token, freq] of docFreq) {
      this.idf.set(token, Math.log(this.docCount / (1 + freq)));
    }
  }

  // Generate a fixed-size vector for text
  embed(text) {
    const tokens = this._tokenize(text);
    const tf = new Map();

    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Create sparse vector, project to fixed dimensions
    const dims = Math.min(this.vocabulary.size, 256);
    const vector = new Array(dims).fill(0);

    for (const [token, freq] of tf) {
      const idf = this.idf.get(token) || 1;
      const tfidf = (freq / tokens.length) * idf;
      const idx = (this.vocabulary.get(token) || 0) % dims;
      vector[idx] += tfidf;
    }

    // Normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }

    return vector;
  }
}

// Usage:
// const tfidf = new TFIDFEmbedding();
// tfidf.buildVocabulary(existingMemories); // call once
// const engine = new MemoryEngine({ embeddingFn: (text) => tfidf.embed(text) });
