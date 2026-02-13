// ============================================================
// ai-sdk-tools.js v2.0 — Memory Tools()
// Works with Vercel AI SDK (import { tool } from 'ai')
//
// New in v2:
//   - 6 tools: search, add, update, forget, getProfile, getRelated
//   - Importance levels (critical/high/normal/low)
//   - Memory type selection (static/dynamic/episodic/semantic)
//   - Multi-tag support
//   - Search filters (type, importance, limit)
//   - OpenAI function calling definitions
// ============================================================

import { tool } from 'ai';
import { z } from 'zod';
import { MemoryEngine } from './memory-engine.js';

// ========================
// TOOL DESCRIPTIONS
// ========================
const TOOL_DESCRIPTIONS = {
  searchMemories: `Search memories about the user, project, or past conversations. Use when you need context about past decisions, preferences, project details, or anything previously discussed. Supports filtering by type and importance.`,
  addMemory: `Save important information to long-term memory. Use when the user shares preferences, decisions, project facts, personal details, or anything worth remembering across sessions. Choose the right type and importance level.`,
  updateMemory: `Update an existing memory with new information. Use when facts change (e.g., user changed preferences, project updated). Merges new content with existing.`,
  forgetMemory: `Delete a specific memory by ID. Use when the user asks you to forget something or when information is outdated/incorrect.`,
  getUserProfile: `Get the user's full profile — all stored facts and recent context. Use at session start or when you need comprehensive context about the user.`,
  getRelatedMemories: `Find memories related to a specific memory. Use to explore connections and build deeper context about a topic.`,
};

// ========================
// CREATE TOOLS
// ========================

/**
 * Memory Tools'
 *
 * Usage:
 *   const tools = selfHostedMemoryTools({ dbPath: './my-memories.db' });
 *   const result = await streamText({
 *     model: openai('gpt-4o'),
 *     messages,
 *     tools,
 *   });
 */
export function selfHostedMemoryTools(config = {}) {
  const engine = new MemoryEngine({
    dbPath: config.dbPath || './memories.db',
    embeddingFn: config.embeddingFn || null,
    onFactsExtracted: config.onFactsExtracted || null,
  });

  const containerTags = config.containerTags || ['default'];

  // --- SEARCH MEMORIES ---
  const searchMemories = tool({
    description: TOOL_DESCRIPTIONS.searchMemories,
    parameters: z.object({
      query: z.string().describe('What to search for in memories'),
      types: z.array(z.enum(['static', 'dynamic', 'episodic', 'semantic'])).optional()
        .describe('Filter by memory types'),
      minImportance: z.enum(['critical', 'high', 'normal', 'low']).optional()
        .describe('Minimum importance level to include'),
      limit: z.number().optional().default(10)
        .describe('Maximum number of results (default: 10)'),
    }),
    execute: async ({ query, types, minImportance, limit = 10 }) => {
      try {
        const result = await engine.search({
          q: query,
          containerTags,
          limit,
          includeFullDocs: true,
          memoryTypes: types || [],
          minImportance: minImportance || null,
        });
        return {
          success: true,
          results: result.results,
          count: result.results?.length || 0,
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  });

  // --- ADD MEMORY ---
  const addMemory = tool({
    description: TOOL_DESCRIPTIONS.addMemory,
    parameters: z.object({
      content: z.string().describe('The information to remember'),
      type: z.enum(['static', 'dynamic', 'episodic', 'semantic']).optional().default('dynamic')
        .describe('static=permanent facts, dynamic=current context, episodic=conversations, semantic=learned concepts'),
      importance: z.enum(['critical', 'high', 'normal', 'low']).optional().default('normal')
        .describe('critical=identity/vital, high=strong preferences, normal=general, low=minor'),
    }),
    execute: async ({ content, type = 'dynamic', importance = 'normal' }) => {
      try {
        const result = await engine.add({
          content,
          containerTags,
          memoryType: type,
          importance,
          source: 'ai_tool',
        });
        return { success: true, memory: result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  });

  // --- UPDATE MEMORY ---
  const updateMemory = tool({
    description: TOOL_DESCRIPTIONS.updateMemory,
    parameters: z.object({
      id: z.string().describe('Memory ID to update'),
      content: z.string().optional().describe('New content (replaces old)'),
      importance: z.enum(['critical', 'high', 'normal', 'low']).optional()
        .describe('New importance level'),
    }),
    execute: async ({ id, content, importance }) => {
      try {
        const result = await engine.update(id, { content, importance });
        return result;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  });

  // --- FORGET MEMORY ---
  const forgetMemory = tool({
    description: TOOL_DESCRIPTIONS.forgetMemory,
    parameters: z.object({
      id: z.string().describe('Memory ID to delete'),
    }),
    execute: async ({ id }) => {
      try {
        return engine.delete(id);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  });

  // --- GET USER PROFILE ---
  const getUserProfile = tool({
    description: TOOL_DESCRIPTIONS.getUserProfile,
    parameters: z.object({
      query: z.string().optional().describe('Optional: search query to find relevant memories alongside profile'),
    }),
    execute: async ({ query } = {}) => {
      try {
        const result = await engine.getProfile(containerTags, query || '');
        return {
          success: true,
          profile: result.profile,
          stats: result.stats,
          relevantResults: result.searchResults?.results?.length || 0,
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  });

  // --- GET RELATED MEMORIES ---
  const getRelatedMemories = tool({
    description: TOOL_DESCRIPTIONS.getRelatedMemories,
    parameters: z.object({
      memoryId: z.string().describe('Memory ID to find related memories for'),
      relation: z.string().optional().describe('Filter by relation type (e.g., "related", "chunk", "contradicts")'),
    }),
    execute: async ({ memoryId, relation }) => {
      try {
        const results = engine.getRelated(memoryId, { relation, limit: 10 });
        return {
          success: true,
          results: results.map(r => ({ id: r.id, content: r.content, relation: r.relation, strength: r.strength })),
          count: results.length,
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
  });

  return { searchMemories, addMemory, updateMemory, forgetMemory, getUserProfile, getRelatedMemories };
}


// ========================
// OPENAI FUNCTION CALLING TOOLS
// ========================
export function getOpenAIToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'searchMemories',
        description: TOOL_DESCRIPTIONS.searchMemories,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' },
            types: { type: 'array', items: { type: 'string', enum: ['static', 'dynamic', 'episodic', 'semantic'] }, description: 'Filter by memory types' },
            minImportance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'Minimum importance' },
            limit: { type: 'number', description: 'Max results', default: 10 },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'addMemory',
        description: TOOL_DESCRIPTIONS.addMemory,
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Memory text to save' },
            type: { type: 'string', enum: ['static', 'dynamic', 'episodic', 'semantic'], default: 'dynamic' },
            importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], default: 'normal' },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'updateMemory',
        description: TOOL_DESCRIPTIONS.updateMemory,
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Memory ID to update' },
            content: { type: 'string', description: 'New content' },
            importance: { type: 'string', enum: ['critical', 'high', 'normal', 'low'] },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forgetMemory',
        description: TOOL_DESCRIPTIONS.forgetMemory,
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Memory ID to delete' } },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'getUserProfile',
        description: TOOL_DESCRIPTIONS.getUserProfile,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Optional search query' } },
          required: [],
        },
      },
    },
  ];
}


// ========================
// OPENAI TOOL CALL EXECUTOR
// ========================
export function createToolCallExecutor(config = {}) {
  const engine = new MemoryEngine({
    dbPath: config.dbPath || './memories.db',
    embeddingFn: config.embeddingFn || null,
    onFactsExtracted: config.onFactsExtracted || null,
  });
  const containerTags = config.containerTags || ['default'];

  return async function executeToolCall(toolCall) {
    const name = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);

    try {
      switch (name) {
        case 'searchMemories': {
          const result = await engine.search({
            q: args.query,
            containerTags,
            limit: args.limit || 10,
            includeFullDocs: true,
            memoryTypes: args.types || [],
            minImportance: args.minImportance || null,
          });
          return JSON.stringify({ success: true, results: result.results, count: result.results?.length || 0 });
        }
        case 'addMemory': {
          const result = await engine.add({
            content: args.content,
            containerTags,
            memoryType: args.type || 'dynamic',
            importance: args.importance || 'normal',
            source: 'ai_tool',
          });
          return JSON.stringify({ success: true, memory: result });
        }
        case 'updateMemory': {
          const result = await engine.update(args.id, { content: args.content, importance: args.importance });
          return JSON.stringify(result);
        }
        case 'forgetMemory': {
          const result = engine.delete(args.id);
          return JSON.stringify(result);
        }
        case 'getUserProfile': {
          const result = await engine.getProfile(containerTags, args.query || '');
          return JSON.stringify({ success: true, profile: result.profile, stats: result.stats });
        }
        default:
          return JSON.stringify({ success: false, error: `Unknown function: ${name}` });
      }
    } catch (error) {
      return JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  };
}

export default selfHostedMemoryTools;
