// ============================================================
// memory-middleware.js — Replaces withSupermemory() and createOpenAIMiddleware()
// Auto-injects memories into system prompt before each AI call
// ============================================================

import { MemoryEngine } from './memory-engine.js';

// ========================
// HELPERS (from Supermemory source)
// ========================

function deduplicateMemories({ static: staticMems = [], dynamic: dynamicMems = [], searchResults = [] }) {
  const normalize = (item) => {
    if (!item) return null;
    if (typeof item === 'string') return item.trim() || null;
    if (typeof item?.memory === 'string') return item.memory.trim() || null;
    return null;
  };

  const seen = new Set();
  const deduped = { static: [], dynamic: [], searchResults: [] };

  for (const item of staticMems) {
    const text = normalize(item);
    if (text && !seen.has(text)) { deduped.static.push(text); seen.add(text); }
  }
  for (const item of dynamicMems) {
    const text = normalize(item);
    if (text && !seen.has(text)) { deduped.dynamic.push(text); seen.add(text); }
  }
  for (const item of searchResults) {
    const text = normalize(item);
    if (text && !seen.has(text)) { deduped.searchResults.push(text); seen.add(text); }
  }

  return deduped;
}

function buildMemoryPrompt(profile, searchResults, mode = 'full') {
  const parts = [];

  if (mode !== 'query') {
    // User profile memories
    if (profile.static?.length > 0) {
      parts.push('## User Profile (Core Facts)');
      parts.push(profile.static.map(m => `- ${m}`).join('\n'));
    }
    if (profile.dynamic?.length > 0) {
      parts.push('## Recent Context');
      parts.push(profile.dynamic.map(m => `- ${m}`).join('\n'));
    }
  }

  if (mode !== 'profile' && searchResults?.length > 0) {
    parts.push("## Relevant Memories for Current Query");
    parts.push(searchResults.map(m => `- ${m}`).join('\n'));
  }

  const content = parts.join('\n\n').trim();
  return content ? `User Supermemories:\n${content}` : '';
}

function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  const lastUser = messages.slice().reverse().find(m => m.role === 'user');
  if (!lastUser) return '';
  if (typeof lastUser.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content.filter(c => c.type === 'text').map(c => c.text || '').join(' ');
  }
  return '';
}

// ========================
// VERCEL AI SDK MIDDLEWARE (replaces withSupermemory())
// ========================

/**
 * Wraps a Vercel AI SDK language model to auto-inject memories
 *
 * Usage:
 *   import { withMemory } from './memory-middleware.js';
 *   const model = withMemory(openai('gpt-4o'), 'user_123', {
 *     dbPath: './memories.db',
 *     mode: 'full',
 *     addMemory: 'always'
 *   });
 */
export function withMemory(baseModel, containerTag, options = {}) {
  const engine = new MemoryEngine({
    dbPath: options.dbPath || './memories.db',
    embeddingFn: options.embeddingFn || null,
  });

  const mode = options.mode || 'full';           // 'profile' | 'query' | 'full'
  const addMemoryMode = options.addMemory || 'never'; // 'always' | 'never'
  const verbose = options.verbose || false;

  const log = verbose
    ? (...args) => console.log('[memory]', ...args)
    : () => {};

  return {
    ...baseModel,

    doGenerate: async (params) => {
      // Inject memories before generation
      const enrichedParams = await injectMemories(params, engine, containerTag, mode, log);
      const result = await baseModel.doGenerate(enrichedParams);

      // Save conversation after response if enabled
      if (addMemoryMode === 'always') {
        const userMsg = getLastUserMessage(params.prompt);
        if (userMsg?.trim()) {
          const assistantText = result.content?.map(c => c.type === 'text' ? c.text : '').join('') || '';
          const fullText = `User: ${userMsg}\n\nAssistant: ${assistantText}`;
          await engine.add({ content: fullText, containerTags: [containerTag], memoryType: 'dynamic' });
          log('Saved conversation to memory');
        }
      }

      return result;
    },

    doStream: async (params) => {
      const enrichedParams = await injectMemories(params, engine, containerTag, mode, log);
      const { stream, ...rest } = await baseModel.doStream(enrichedParams);

      let fullResponse = '';

      const transformStream = new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === 'text-delta') fullResponse += chunk.delta;
          controller.enqueue(chunk);
        },
        flush: async () => {
          if (addMemoryMode === 'always') {
            const userMsg = getLastUserMessage(params.prompt);
            if (userMsg?.trim() && fullResponse.trim()) {
              const fullText = `User: ${userMsg}\n\nAssistant: ${fullResponse}`;
              await engine.add({ content: fullText, containerTags: [containerTag], memoryType: 'dynamic' });
              log('Saved streamed conversation to memory');
            }
          }
        },
      });

      return { stream: stream.pipeThrough(transformStream), ...rest };
    },
  };
}

async function injectMemories(params, engine, containerTag, mode, log) {
  const userMsg = params.prompt?.slice().reverse().find(m => m.role === 'user');
  const queryText = mode !== 'profile' ? getLastUserMessage(params.prompt) : '';

  if (mode !== 'profile' && !queryText) {
    log('No user message found, skipping memory search');
    return params;
  }

  log('Searching memories...', { containerTag, mode });

  const profile = await engine.getProfile(containerTag, queryText);

  const deduped = deduplicateMemories({
    static: profile.profile.static,
    dynamic: profile.profile.dynamic,
    searchResults: profile.searchResults?.results?.map(r => r.content) || [],
  });

  const memoryText = buildMemoryPrompt(deduped, deduped.searchResults, mode);

  if (!memoryText) {
    log('No memories found');
    return params;
  }

  log('Injecting memories:', memoryText.substring(0, 200) + '...');

  // Inject into system prompt
  const hasSystemPrompt = params.prompt?.some(m => m.role === 'system');

  if (hasSystemPrompt) {
    return {
      ...params,
      prompt: params.prompt.map(m =>
        m.role === 'system' ? { ...m, content: `${m.content}\n\n${memoryText}` } : m
      ),
    };
  }

  return {
    ...params,
    prompt: [{ role: 'system', content: memoryText }, ...params.prompt],
  };
}


// ========================
// OPENAI MIDDLEWARE (replaces createOpenAIMiddleware())
// ========================

/**
 * Wraps an OpenAI client to auto-inject memories into chat completions
 *
 * Usage:
 *   import OpenAI from 'openai';
 *   import { withOpenAIMemory } from './memory-middleware.js';
 *
 *   const openai = new OpenAI();
 *   withOpenAIMemory(openai, 'user_123', { dbPath: './memories.db' });
 *   // Now openai.chat.completions.create() auto-injects memories!
 */
export function withOpenAIMemory(openaiClient, containerTag, options = {}) {
  const engine = new MemoryEngine({
    dbPath: options.dbPath || './memories.db',
    embeddingFn: options.embeddingFn || null,
  });

  const mode = options.mode || 'full';
  const addMemoryMode = options.addMemory || 'never';
  const verbose = options.verbose || false;

  const log = verbose
    ? (...args) => console.log('[memory]', ...args)
    : () => {};

  const originalCreate = openaiClient.chat.completions.create;

  openaiClient.chat.completions.create = async function (params) {
    const messages = Array.isArray(params.messages) ? params.messages : [];
    const userMsg = getLastUserMessage(messages);

    if (mode !== 'profile' && !userMsg) {
      log('No user message, skipping memory injection');
      return originalCreate.call(openaiClient.chat.completions, params);
    }

    log('Searching memories for OpenAI call...');

    const profile = await engine.getProfile(containerTag, mode === 'profile' ? '' : userMsg);

    const deduped = deduplicateMemories({
      static: profile.profile.static,
      dynamic: profile.profile.dynamic,
      searchResults: profile.searchResults?.results?.map(r => r.content) || [],
    });

    const memoryText = buildMemoryPrompt(deduped, deduped.searchResults, mode);

    let enrichedMessages = messages;
    if (memoryText) {
      const hasSystem = messages.some(m => m.role === 'system');
      if (hasSystem) {
        enrichedMessages = messages.map(m =>
          m.role === 'system' ? { ...m, content: `${m.content}\n\n${memoryText}` } : m
        );
      } else {
        enrichedMessages = [{ role: 'system', content: memoryText }, ...messages];
      }
      log('Injected memories into messages');
    }

    const result = await originalCreate.call(openaiClient.chat.completions, {
      ...params,
      messages: enrichedMessages,
    });

    // Save conversation if enabled
    if (addMemoryMode === 'always' && userMsg?.trim()) {
      const assistantContent = result.choices?.[0]?.message?.content || '';
      const fullText = `User: ${userMsg}\n\nAssistant: ${assistantContent}`;
      await engine.add({ content: fullText, containerTags: [containerTag], memoryType: 'dynamic' });
      log('Saved conversation to memory');
    }

    return result;
  };

  return openaiClient;
}

export default { withMemory, withOpenAIMemory };
