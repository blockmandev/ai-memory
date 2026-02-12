// ============================================================
// ai-sdk-tools.js — Drop-in replacement for supermemoryTools()
// Works with Vercel AI SDK (import { tool } from 'ai')
// ============================================================

import { tool } from 'ai';
import { z } from 'zod';
import { MemoryEngine } from './memory-engine.js';

// ========================
// TOOL DESCRIPTIONS (same as Supermemory)
// ========================
const TOOL_DESCRIPTIONS = {
  searchMemories: 'Search (recall) memories/details/information about the user or other facts or entities. Run when explicitly asked or when context about user\'s past choices would be helpful.',
  addMemory: 'Add (remember) memories/details/information about the user or other facts or entities. Run when explicitly asked or when the user mentions any information generalizable beyond the context of the current conversation.'
};

// ========================
// CREATE TOOLS (replaces supermemoryTools())
// ========================

/**
 * Drop-in replacement for: import { supermemoryTools } from '@supermemory/tools/ai-sdk'
 *
 * Usage:
 *   const tools = selfHostedMemoryTools({ dbPath: './my-memories.db' });
 *   // Then in your AI SDK call:
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
  });

  const containerTags = config.containerTags || ['default'];

  const searchMemories = tool({
    description: TOOL_DESCRIPTIONS.searchMemories,
    parameters: z.object({
      informationToGet: z.string().describe('Terms to search for in the user\'s memories'),
      includeFullDocs: z.boolean().optional().default(true).describe('Whether to include full document content'),
      limit: z.number().optional().default(10).describe('Maximum number of results to return'),
    }),
    execute: async ({ informationToGet, includeFullDocs = true, limit = 10 }) => {
      try {
        const result = await engine.search({
          q: informationToGet,
          containerTags,
          limit,
          includeFullDocs,
        });
        return {
          success: true,
          results: result.results,
          count: result.results?.length || 0,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  });

  const addMemory = tool({
    description: TOOL_DESCRIPTIONS.addMemory,
    parameters: z.object({
      memory: z.string().describe('The text content of the memory to add'),
    }),
    execute: async ({ memory }) => {
      try {
        const result = await engine.add({
          content: memory,
          containerTags,
        });
        return { success: true, memory: result };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  });

  return { searchMemories, addMemory };
}


// ========================
// OPENAI FUNCTION CALLING TOOLS (replaces @supermemory/tools/openai)
// ========================

/**
 * For use with OpenAI's function calling API directly
 */
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
            informationToGet: { type: 'string', description: 'Terms to search for' },
            includeFullDocs: { type: 'boolean', description: 'Include full docs', default: true },
            limit: { type: 'number', description: 'Max results', default: 10 },
          },
          required: ['informationToGet'],
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
            memory: { type: 'string', description: 'Memory text to save' },
          },
          required: ['memory'],
        },
      },
    },
  ];
}

/**
 * Process OpenAI tool calls (replaces createToolCallExecutor)
 */
export function createToolCallExecutor(config = {}) {
  const engine = new MemoryEngine({
    dbPath: config.dbPath || './memories.db',
    embeddingFn: config.embeddingFn || null,
  });
  const containerTags = config.containerTags || ['default'];

  return async function executeToolCall(toolCall) {
    const name = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);

    switch (name) {
      case 'searchMemories': {
        const result = await engine.search({
          q: args.informationToGet,
          containerTags,
          limit: args.limit || 10,
          includeFullDocs: args.includeFullDocs ?? true,
        });
        return JSON.stringify({ success: true, results: result.results, count: result.results?.length || 0 });
      }
      case 'addMemory': {
        const result = await engine.add({ content: args.memory, containerTags });
        return JSON.stringify({ success: true, memory: result });
      }
      default:
        return JSON.stringify({ success: false, error: `Unknown function: ${name}` });
    }
  };
}

export default selfHostedMemoryTools;
