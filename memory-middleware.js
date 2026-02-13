// ============================================================
// memory-middleware.js v2.0 — AI Middleware with Memory
// Replaces withSupermemory() and createOpenAIMiddleware()
//
// New in v2:
//   - LLM-based fact extraction from conversations
//   - Smart token budget management (never exceed context limits)
//   - Relevance-based memory selection (not just recency)
//   - Importance-aware prompt building
//   - Configurable memory injection modes
//   - Streaming conversation capture with fact extraction
// ============================================================

import { MemoryEngine } from './memory-engine.js';

// ========================
// TOKEN ESTIMATION
// ========================
const AVG_CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
}

// ========================
// HELPERS
// ========================
function deduplicateMemories({ static: staticMems = [], dynamic: dynamicMems = [], searchResults = [] }) {
  const normalize = (item) => {
    if (!item) return null;
    if (typeof item === 'string') return item.trim() || null;
    if (typeof item?.content === 'string') return item.content.trim() || null;
    if (typeof item?.memory === 'string') return item.memory.trim() || null;
    return null;
  };

  const getImportance = (item) => {
    if (typeof item === 'object' && item?.importance) return item.importance;
    return 'normal';
  };

  const seen = new Set();
  const deduped = { static: [], dynamic: [], searchResults: [] };

  for (const item of staticMems) {
    const text = normalize(item);
    if (text && !seen.has(text)) {
      deduped.static.push({ text, importance: getImportance(item) });
      seen.add(text);
    }
  }
  for (const item of dynamicMems) {
    const text = normalize(item);
    if (text && !seen.has(text)) {
      deduped.dynamic.push({ text, importance: getImportance(item) });
      seen.add(text);
    }
  }
  for (const item of searchResults) {
    const text = normalize(item);
    if (text && !seen.has(text)) {
      deduped.searchResults.push({ text, importance: getImportance(item) });
      seen.add(text);
    }
  }

  return deduped;
}

function buildMemoryPrompt(profile, searchResults, mode = 'full', tokenBudget = 2000) {
  const parts = [];
  let usedTokens = 0;
  const headerTokens = 30; // rough cost of headers

  const IMPORTANCE_ORDER = { critical: 0, high: 1, normal: 2, low: 3 };

  if (mode !== 'query') {
    // Static memories — sorted by importance (critical first)
    if (profile.static?.length > 0) {
      const sorted = [...profile.static].sort((a, b) =>
        (IMPORTANCE_ORDER[a.importance] ?? 2) - (IMPORTANCE_ORDER[b.importance] ?? 2)
      );
      const lines = [];
      for (const m of sorted) {
        const cost = estimateTokens(m.text) + 2;
        if (usedTokens + cost + headerTokens > tokenBudget) break;
        const prefix = m.importance === 'critical' ? '[!] ' : m.importance === 'high' ? '[*] ' : '';
        lines.push(`- ${prefix}${m.text}`);
        usedTokens += cost;
      }
      if (lines.length > 0) {
        parts.push('## User Profile (Core Facts)\n' + lines.join('\n'));
        usedTokens += headerTokens;
      }
    }

    // Dynamic memories — most recent first, with importance boost
    if (profile.dynamic?.length > 0) {
      const lines = [];
      for (const m of profile.dynamic) {
        const cost = estimateTokens(m.text) + 2;
        if (usedTokens + cost + headerTokens > tokenBudget) break;
        lines.push(`- ${m.text}`);
        usedTokens += cost;
      }
      if (lines.length > 0) {
        parts.push('## Recent Context\n' + lines.join('\n'));
        usedTokens += headerTokens;
      }
    }
  }

  if (mode !== 'profile' && searchResults?.length > 0) {
    const lines = [];
    for (const m of searchResults) {
      const cost = estimateTokens(m.text) + 2;
      if (usedTokens + cost + headerTokens > tokenBudget) break;
      lines.push(`- ${m.text}`);
      usedTokens += cost;
    }
    if (lines.length > 0) {
      parts.push('## Relevant Memories for Current Query\n' + lines.join('\n'));
    }
  }

  const content = parts.join('\n\n').trim();
  return content ? `<user_memories>\n${content}\n</user_memories>` : '';
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
 * Wraps a Vercel AI SDK language model to auto-inject memories.
 *
 * Usage:
 *   import { withMemory } from './memory-middleware.js';
 *   const model = withMemory(openai('gpt-4o'), 'user_123', {
 *     dbPath: './memories.db',
 *     mode: 'full',
 *     addMemory: 'always',
 *     tokenBudget: 2000,
 *   });
 */
export function withMemory(baseModel, containerTag, options = {}) {
  const engine = new MemoryEngine({
    dbPath: options.dbPath || './memories.db',
    embeddingFn: options.embeddingFn || null,
    onFactsExtracted: options.onFactsExtracted || null,
  });

  const mode = options.mode || 'full';
  const addMemoryMode = options.addMemory || 'never';
  const tokenBudget = options.tokenBudget || 2000;
  const verbose = options.verbose || false;
  const extractFacts = options.extractFacts ?? (addMemoryMode === 'always');

  const log = verbose
    ? (...args) => console.log('[memory]', ...args)
    : () => {};

  return {
    ...baseModel,

    doGenerate: async (params) => {
      const enrichedParams = await injectMemories(params, engine, containerTag, mode, tokenBudget, log);
      const result = await baseModel.doGenerate(enrichedParams);

      if (addMemoryMode === 'always') {
        await saveConversation(engine, params, result, containerTag, extractFacts, log);
      }

      return result;
    },

    doStream: async (params) => {
      const enrichedParams = await injectMemories(params, engine, containerTag, mode, tokenBudget, log);
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
              await engine.addConversation({
                conversationId: `stream_${Date.now()}`,
                messages: [
                  { role: 'user', content: userMsg },
                  { role: 'assistant', content: fullResponse },
                ],
                containerTags: [containerTag],
                extractFacts,
              });
              log('Saved streamed conversation + extracted facts');
            }
          }
        },
      });

      return { stream: stream.pipeThrough(transformStream), ...rest };
    },
  };
}

async function saveConversation(engine, params, result, containerTag, extractFacts, log) {
  const userMsg = getLastUserMessage(params.prompt);
  if (!userMsg?.trim()) return;

  const assistantText = result.content?.map(c => c.type === 'text' ? c.text : '').join('') || '';
  if (!assistantText.trim()) return;

  await engine.addConversation({
    conversationId: `gen_${Date.now()}`,
    messages: [
      { role: 'user', content: userMsg },
      { role: 'assistant', content: assistantText },
    ],
    containerTags: [containerTag],
    extractFacts,
  });
  log('Saved conversation + extracted facts');
}

async function injectMemories(params, engine, containerTag, mode, tokenBudget, log) {
  const queryText = mode !== 'profile' ? getLastUserMessage(params.prompt) : '';

  if (mode !== 'profile' && !queryText) {
    log('No user message found, skipping memory injection');
    return params;
  }

  log('Searching memories...', { containerTag, mode });

  const profile = await engine.getProfile(containerTag, queryText);

  const deduped = deduplicateMemories({
    static: profile.profile.static,
    dynamic: profile.profile.dynamic,
    searchResults: profile.searchResults?.results?.map(r => ({ content: r.content, importance: r.importance })) || [],
  });

  const memoryText = buildMemoryPrompt(deduped, deduped.searchResults, mode, tokenBudget);

  if (!memoryText) {
    log('No memories found');
    return params;
  }

  log(`Injecting ${estimateTokens(memoryText)} tokens of memory context`);

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
 * Wraps an OpenAI client to auto-inject memories into chat completions.
 *
 * Usage:
 *   import OpenAI from 'openai';
 *   import { withOpenAIMemory } from './memory-middleware.js';
 *
 *   const openai = new OpenAI();
 *   withOpenAIMemory(openai, 'user_123', {
 *     dbPath: './memories.db',
 *     tokenBudget: 2000,
 *   });
 */
export function withOpenAIMemory(openaiClient, containerTag, options = {}) {
  const engine = new MemoryEngine({
    dbPath: options.dbPath || './memories.db',
    embeddingFn: options.embeddingFn || null,
    onFactsExtracted: options.onFactsExtracted || null,
  });

  const mode = options.mode || 'full';
  const addMemoryMode = options.addMemory || 'never';
  const tokenBudget = options.tokenBudget || 2000;
  const verbose = options.verbose || false;
  const extractFacts = options.extractFacts ?? (addMemoryMode === 'always');

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
      searchResults: profile.searchResults?.results?.map(r => ({ content: r.content, importance: r.importance })) || [],
    });

    const memoryText = buildMemoryPrompt(deduped, deduped.searchResults, mode, tokenBudget);

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
      log(`Injected ${estimateTokens(memoryText)} tokens of memory context`);
    }

    const result = await originalCreate.call(openaiClient.chat.completions, {
      ...params,
      messages: enrichedMessages,
    });

    // Save conversation if enabled
    if (addMemoryMode === 'always' && userMsg?.trim()) {
      const assistantContent = result.choices?.[0]?.message?.content || '';
      if (assistantContent.trim()) {
        await engine.addConversation({
          conversationId: `openai_${Date.now()}`,
          messages: [
            { role: 'user', content: userMsg },
            { role: 'assistant', content: assistantContent },
          ],
          containerTags: [containerTag],
          extractFacts,
        });
        log('Saved conversation + extracted facts');
      }
    }

    return result;
  };

  // Also wrap streaming
  const originalCreateStream = openaiClient.chat.completions.create;
  // The create method handles both streaming and non-streaming based on params.stream

  return openaiClient;
}


// ========================
// STANDALONE MIDDLEWARE (framework-agnostic)
// ========================

/**
 * For any framework — wraps a generic chat function with memory.
 *
 * Usage:
 *   const chat = withGenericMemory(myLLMCall, 'user_123', { dbPath: './memories.db' });
 *   const response = await chat([{ role: 'user', content: 'Hello' }]);
 */
export function withGenericMemory(chatFn, containerTag, options = {}) {
  const engine = new MemoryEngine({
    dbPath: options.dbPath || './memories.db',
    embeddingFn: options.embeddingFn || null,
    onFactsExtracted: options.onFactsExtracted || null,
  });

  const mode = options.mode || 'full';
  const addMemoryMode = options.addMemory || 'never';
  const tokenBudget = options.tokenBudget || 2000;
  const extractFacts = options.extractFacts ?? (addMemoryMode === 'always');

  return async function chatWithMemory(messages, chatOptions = {}) {
    const userMsg = getLastUserMessage(messages);

    // Fetch and inject memories
    let enrichedMessages = messages;
    if (userMsg || mode === 'profile') {
      const profile = await engine.getProfile(containerTag, mode === 'profile' ? '' : userMsg);
      const deduped = deduplicateMemories({
        static: profile.profile.static,
        dynamic: profile.profile.dynamic,
        searchResults: profile.searchResults?.results?.map(r => ({ content: r.content, importance: r.importance })) || [],
      });
      const memoryText = buildMemoryPrompt(deduped, deduped.searchResults, mode, tokenBudget);

      if (memoryText) {
        const hasSystem = messages.some(m => m.role === 'system');
        if (hasSystem) {
          enrichedMessages = messages.map(m =>
            m.role === 'system' ? { ...m, content: `${m.content}\n\n${memoryText}` } : m
          );
        } else {
          enrichedMessages = [{ role: 'system', content: memoryText }, ...messages];
        }
      }
    }

    // Call the actual LLM
    const response = await chatFn(enrichedMessages, chatOptions);

    // Save conversation
    if (addMemoryMode === 'always' && userMsg?.trim()) {
      const assistantContent = typeof response === 'string'
        ? response
        : response?.content || response?.choices?.[0]?.message?.content || '';

      if (assistantContent.trim()) {
        await engine.addConversation({
          conversationId: `generic_${Date.now()}`,
          messages: [
            { role: 'user', content: userMsg },
            { role: 'assistant', content: assistantContent },
          ],
          containerTags: [containerTag],
          extractFacts,
        });
      }
    }

    return response;
  };
}

export default { withMemory, withOpenAIMemory, withGenericMemory };
