// ============================================================
// examples.js — Usage Examples
// Shows how to replace @supermemory/tools with this self-hosted version
// ============================================================


// =====================================================
// EXAMPLE 1: Basic AI SDK Usage (replaces supermemoryTools)
// =====================================================

import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { selfHostedMemoryTools } from './ai-sdk-tools.js';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

// BEFORE (paid Supermemory):
// import { supermemoryTools } from '@supermemory/tools/ai-sdk';
// const tools = supermemoryTools(process.env.SUPERMEMORY_API_KEY);

// AFTER (self-hosted, FREE):
const tools = selfHostedMemoryTools({
  dbPath: './memories.db',
  containerTags: ['user_123'],
});

async function chat(userMessage) {
  const result = await streamText({
    model: openai('gpt-4o'),
    messages: [{ role: 'user', content: userMessage }],
    tools: {
      ...tools,
      // Add any other custom tools here
    },
    system: `You are a helpful assistant. When users share information about themselves,
    remember it using the addMemory tool. When they ask questions, search your memories
    to provide personalized responses.`,
  });

  return result;
}


// =====================================================
// EXAMPLE 2: Auto-Memory Middleware (replaces withSupermemory)
// =====================================================

import { withMemory } from './memory-middleware.js';

// BEFORE (paid):
// import { withSupermemory } from '@supermemory/tools/ai-sdk';
// const model = withSupermemory(openai('gpt-4o'), 'user_123', { apiKey: '...' });

// AFTER (self-hosted, FREE):
const model = withMemory(openai('gpt-4o'), 'user_123', {
  dbPath: './memories.db',
  mode: 'full',           // 'profile' | 'query' | 'full'
  addMemory: 'always',    // auto-save every conversation
  verbose: true,           // see memory logs
});

// Now every call auto-injects relevant memories!
async function chatWithMemory(messages) {
  const result = await streamText({
    model,  // <-- memories auto-injected
    messages,
    system: 'You are a personal assistant.',
  });
  return result;
}


// =====================================================
// EXAMPLE 3: OpenAI Direct (replaces createOpenAIMiddleware)
// =====================================================

import OpenAI from 'openai';
import { withOpenAIMemory } from './memory-middleware.js';

const openaiClient = new OpenAI();

// BEFORE:
// import { createOpenAIMiddleware } from '@supermemory/tools/openai';
// createOpenAIMiddleware(openaiClient, 'user_123', { verbose: true });

// AFTER (self-hosted):
withOpenAIMemory(openaiClient, 'user_123', {
  dbPath: './memories.db',
  mode: 'full',
  addMemory: 'always',
  verbose: true,
});

// Now openai.chat.completions.create() auto-injects memories!
async function openaiChat() {
  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: "What's my favorite food?" }],
  });
  console.log(response.choices[0].message.content);
}


// =====================================================
// EXAMPLE 4: With Local Embeddings (best accuracy, still free)
// =====================================================

import { createLocalEmbedding } from './embeddings.js';

async function setupWithEmbeddings() {
  // One-time setup — loads the embedding model
  const embeddingFn = await createLocalEmbedding();

  const tools = selfHostedMemoryTools({
    dbPath: './memories.db',
    containerTags: ['user_123'],
    embeddingFn,  // <-- enables semantic/vector search
  });

  return tools;
}


// =====================================================
// EXAMPLE 5: Direct Memory Engine Usage
// =====================================================

import { MemoryEngine } from './memory-engine.js';

async function directUsage() {
  const engine = new MemoryEngine({ dbPath: './memories.db' });

  // Add a static fact (core user info)
  await engine.add({
    content: 'User prefers dark mode and codes in Python',
    containerTags: ['user_123'],
    memoryType: 'static',
  });

  // Add dynamic context (recent conversation)
  await engine.add({
    content: 'User is working on a blockchain project called QoraNet',
    containerTags: ['user_123'],
    memoryType: 'dynamic',
  });

  // Search memories
  const results = await engine.search({
    q: 'blockchain project',
    containerTags: ['user_123'],
    limit: 5,
  });
  console.log('Search results:', results);

  // Get full profile
  const profile = await engine.getProfile('user_123', 'what project am I working on?');
  console.log('Profile:', profile);

  // Save a conversation
  await engine.addConversation({
    conversationId: 'conv_001',
    messages: [
      { role: 'user', content: 'Help me with my blockchain project' },
      { role: 'assistant', content: 'Sure! What aspect of QoraNet do you need help with?' },
    ],
    containerTags: ['user_123'],
  });

  engine.close();
}


// =====================================================
// EXAMPLE 6: Integration with YOUR IPFS/Encrypted DB
// (specific to your project architecture)
// =====================================================

/*
Your architecture from our past conversations:
  User device → search encrypted DB → decrypt → build prompt → AI API

Here's how to plug this memory system into your existing flow:
*/

class HybridMemoryEngine {
  constructor(options) {
    // Hot memory: SQLite for fast semantic search
    this.hotMemory = new MemoryEngine({
      dbPath: options.dbPath || './hot-memories.db',
      embeddingFn: options.embeddingFn,
    });

    // Cold storage: Your IPFS/encrypted DB
    this.coldStorage = options.ipfsClient; // your existing IPFS client
    this.encryptionKey = options.encryptionKey;
  }

  async search(query, userId) {
    // 1. Fast search from hot memory (SQLite)
    const hotResults = await this.hotMemory.search({
      q: query,
      containerTags: [userId],
      limit: 5,
    });

    // 2. Deep search from cold storage (IPFS)
    let coldResults = [];
    if (this.coldStorage) {
      // Your existing IPFS search logic here
      // const cids = await this.coldStorage.search(hash(query));
      // const encrypted = await this.coldStorage.fetch(cids);
      // coldResults = await decrypt(encrypted, this.encryptionKey);
    }

    // 3. Merge and deduplicate
    const allResults = [
      ...hotResults.results.map(r => ({ ...r, source: 'hot' })),
      ...coldResults.map(r => ({ content: r, source: 'cold', score: 0.5 })),
    ];

    return allResults;
  }

  async save(content, userId, options = {}) {
    // Always save to hot memory for fast retrieval
    await this.hotMemory.add({
      content,
      containerTags: [userId],
      memoryType: options.memoryType || 'dynamic',
    });

    // Also save to cold storage (encrypted on IPFS) for permanent record
    if (this.coldStorage && options.permanent) {
      // Your existing encryption + IPFS upload logic
      // const encrypted = encrypt(content, this.encryptionKey);
      // const cid = await this.coldStorage.upload(encrypted);
      // await storeHashOnChain(cid);
    }
  }
}
