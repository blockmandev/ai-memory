// ============================================================
// examples.js v2.0 — Usage Examples
// Shows every feature of the self-hosted memory system
// ============================================================


// =====================================================
// EXAMPLE 1: Basic AI SDK Usage
// =====================================================

import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { selfHostedMemoryTools } from './ai-sdk-tools.js';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

// BEFORE (paid):

// AFTER (self-hosted, FREE, MORE features):
const tools = selfHostedMemoryTools({
  dbPath: './memories.db',
  containerTags: ['user_123'],
});

// Now you have 6 tools instead of 2:
// searchMemories, addMemory, updateMemory, forgetMemory, getUserProfile, getRelatedMemories

async function chat(userMessage) {
  const result = await streamText({
    model: openai('gpt-4o'),
    messages: [{ role: 'user', content: userMessage }],
    tools,
    system: `You are a helpful assistant with long-term memory.
When users share information about themselves, save it using addMemory with appropriate type and importance:
  - type: "static" for permanent facts (name, preferences), "dynamic" for current context
  - importance: "critical" for identity, "high" for strong preferences, "normal" for general info
When they ask questions, search your memories to provide personalized responses.
Use getUserProfile at the start of sessions for full context.`,
  });
  return result;
}


// =====================================================
// EXAMPLE 2: Auto-Memory Middleware with Fact Extraction
// =====================================================

import { withMemory } from './memory-middleware.js';
import { createFactExtractor } from './embeddings.js';

// Set up fact extraction — uses your own LLM to extract facts from conversations
const factExtractor = createFactExtractor({
  generateFn: async (prompt) => {
    const result = await openai('gpt-4o-mini').doGenerate({
      prompt: [{ role: 'user', content: prompt }],
    });
    return result.text;
  },
});

const model = withMemory(openai('gpt-4o'), 'user_123', {
  dbPath: './memories.db',
  mode: 'full',
  addMemory: 'always',
  tokenBudget: 2000,        // never exceed this many tokens for memory context
  onFactsExtracted: factExtractor, // auto-extract facts from every conversation
  verbose: true,
});

async function chatWithMemory(messages) {
  const result = await streamText({
    model,
    messages,
    system: 'You are a personal assistant with perfect memory.',
  });
  return result;
}


// =====================================================
// EXAMPLE 3: OpenAI Direct (replaces createOpenAIMiddleware)
// =====================================================

import OpenAI from 'openai';
import { withOpenAIMemory } from './memory-middleware.js';

const openaiClient = new OpenAI();

withOpenAIMemory(openaiClient, 'user_123', {
  dbPath: './memories.db',
  mode: 'full',
  addMemory: 'always',
  tokenBudget: 2000,
  verbose: true,
});

async function openaiChat() {
  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: "What's my favorite food?" }],
  });
  console.log(response.choices[0].message.content);
}


// =====================================================
// EXAMPLE 4: Framework-Agnostic Middleware
// Works with ANY LLM: Anthropic, Gemini, local models, etc.
// =====================================================

import { withGenericMemory } from './memory-middleware.js';

// Wrap any chat function
const myChat = withGenericMemory(
  async (messages) => {
    // Your LLM call here — Anthropic, Gemini, Ollama, anything
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages }),
    });
    const data = await response.json();
    return data.message.content;
  },
  'user_123',
  { dbPath: './memories.db', addMemory: 'always' }
);


// =====================================================
// EXAMPLE 5: With Local Embeddings (best accuracy, still free)
// =====================================================

import { createLocalEmbedding, createHybridEmbedding, BM25Embedding } from './embeddings.js';

async function setupWithEmbeddings() {
  // Option A: Transformers.js (best quality, ~200ms per embed)
  const embeddingFn = await createLocalEmbedding();

  // Option B: BM25 (zero deps, instant, decent quality)
  const bm25 = new BM25Embedding();
  bm25.buildVocabulary(['...existing memories...']);
  const bm25Fn = bm25.asFunction();

  // Option C: Hybrid — use Transformers.js with BM25 fallback
  const hybridFn = createHybridEmbedding(embeddingFn, bm25Fn);

  const tools = selfHostedMemoryTools({
    dbPath: './memories.db',
    containerTags: ['user_123'],
    embeddingFn: hybridFn,
  });

  return tools;
}


// =====================================================
// EXAMPLE 6: Direct Memory Engine — Full API
// =====================================================

import { MemoryEngine } from './memory-engine.js';

async function directUsage() {
  const engine = new MemoryEngine({ dbPath: './memories.db' });

  // --- Add memories with types and importance ---
  await engine.add({
    content: 'User name is Alex, based in London',
    containerTags: ['user_123'],
    memoryType: 'static',
    importance: 'critical',
  });

  await engine.add({
    content: 'User prefers dark mode and codes in Python/TypeScript',
    containerTags: ['user_123'],
    memoryType: 'static',
    importance: 'high',
  });

  await engine.add({
    content: 'Currently working on a blockchain project called QoraNet',
    containerTags: ['user_123', 'project_qoranet'],  // multi-tag!
    memoryType: 'dynamic',
    importance: 'normal',
  });

  // --- Search with filters ---
  const results = await engine.search({
    q: 'blockchain project',
    containerTags: ['user_123'],
    limit: 5,
    memoryTypes: ['dynamic'],      // only dynamic memories
    minImportance: 'normal',       // skip low-importance stuff
  });
  console.log('Search results:', results);

  // --- Update a memory ---
  await engine.update(results.results[0]?.id, {
    content: 'Working on QoraNet v2 — new consensus algorithm',
    importance: 'high',
  });

  // --- Link related memories ---
  const mem1 = results.results[0];
  if (mem1) {
    engine.link(mem1.id, 'some_other_memory_id', 'related');
    const related = engine.getRelated(mem1.id);
    console.log('Related memories:', related);
  }

  // --- Get profile with search ---
  const profile = await engine.getProfile('user_123', 'what project am I working on?');
  console.log('Profile:', profile);
  console.log('Stats:', profile.stats);

  // --- Save a conversation with auto fact extraction ---
  await engine.addConversation({
    conversationId: 'conv_001',
    messages: [
      { role: 'user', content: 'My name is Alex and I love sushi' },
      { role: 'assistant', content: 'Nice to meet you, Alex! I\'ll remember that you enjoy sushi.' },
    ],
    containerTags: ['user_123'],
    extractFacts: true, // will use onFactsExtracted callback if set
  });

  // --- Cleanup old memories ---
  const cleanupResult = engine.cleanup({ maxAgeDays: 90, dryRun: true });
  console.log('Would clean:', cleanupResult);

  // --- Export all memories ---
  const exported = engine.exportAll(['user_123']);
  console.log('Exported:', exported.length, 'memories');

  // --- Soft delete + restore ---
  if (results.results[0]) {
    engine.delete(results.results[0].id);  // soft delete
    engine.restore(results.results[0].id); // restore
  }

  engine.close();
}


// =====================================================
// EXAMPLE 7: Integration with IPFS/Encrypted DB
// =====================================================

class HybridMemoryEngine {
  constructor(options) {
    this.hotMemory = new MemoryEngine({
      dbPath: options.dbPath || './hot-memories.db',
      embeddingFn: options.embeddingFn,
    });
    this.coldStorage = options.ipfsClient;
    this.encryptionKey = options.encryptionKey;
  }

  async search(query, userId) {
    // Fast search from hot memory
    const hotResults = await this.hotMemory.search({
      q: query,
      containerTags: [userId],
      limit: 5,
    });

    // Deep search from IPFS if available
    let coldResults = [];
    if (this.coldStorage) {
      // Your IPFS search logic here
    }

    return [
      ...hotResults.results.map(r => ({ ...r, source: 'hot' })),
      ...coldResults.map(r => ({ content: r, source: 'cold', score: 0.5 })),
    ];
  }

  async save(content, userId, options = {}) {
    await this.hotMemory.add({
      content,
      containerTags: [userId],
      memoryType: options.memoryType || 'dynamic',
      importance: options.importance || 'normal',
    });

    if (this.coldStorage && options.permanent) {
      // Your encryption + IPFS upload logic
    }
  }
}
