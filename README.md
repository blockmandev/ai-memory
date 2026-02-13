# Self-Hosted AI Memory System v2.0

## FREE drop-in replacement for Supermemory, Mem0, Zep

```
User message -> search relevant memories -> inject into system prompt -> AI responds -> auto-extract facts -> save
```

### What paid tools charge $20-50/mo for:

- Vector search (semantic similarity)
- Profile extraction (static facts + dynamic context)
- Document storage & retrieval
- Deduplication

### What this gives you FREE + more:

- FTS5 full-text search with BM25 ranking
- Vector search with 5 embedding options (local, OpenAI, Ollama, BM25, hybrid)
- Hybrid search (FTS + vector + importance + recency + access frequency)
- 4 memory types: static, dynamic, episodic, semantic
- 4 importance levels: critical, high, normal, low
- Memory deduplication & auto-merge
- Time-decay scoring (recent memories rank higher)
- Memory relationships (graph — link related memories)
- Auto semantic chunking for long texts
- LLM-based fact extraction from conversations
- Soft delete + restore
- Export/import, bulk ops, cleanup/maintenance
- MCP server for Claude CLI (8 tools)
- Vercel AI SDK middleware
- OpenAI middleware
- Framework-agnostic middleware (any LLM)
- SQLite storage (no cloud, no API keys)

---

## Project Structure

```
D:\Betting\
|
|-- memory\
|   +-- memory-mcp-server.js      <- MCP server for Claude CLI (8 tools)
|
|-- memory-engine.js               <- Core engine (FTS5, vector, graph, dedup)
|-- embeddings.js                  <- 5 embedding providers + fact extractor
|-- memory-middleware.js            <- Auto-inject middleware (Vercel, OpenAI, generic)
|-- ai-sdk-tools.js                <- Vercel AI SDK tools (6 tools)
|-- examples.js                    <- Usage examples for every feature
|-- test-memory.js                 <- Test suite (36 tests)
|-- package.json
|
|-- .mcp.json                      <- Project-level MCP config (auto-starts server)
|-- CLAUDE.md                      <- Instructions for Claude to use memory
|-- memories.db                    <- SQLite database (created on first use)
```

---

## Setup for Claude CLI

### Prerequisites

- Node.js 18+
- `better-sqlite3` installed (`npm install better-sqlite3`)
- Windows: needs Windows SDK 10.0.26100.0 for native build (VS Installer > Individual Components)

### Option 1: Project-level (this project only)

Already configured. The `.mcp.json` file auto-registers the server:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["D:/Betting/memory/memory-mcp-server.js"],
      "env": {
        "MEMORY_DB_PATH": "D:/Betting/memories.db",
        "MEMORY_CONTAINER": "claude_memory"
      }
    }
  }
}
```

### Option 2: Global (all projects)

Run this in a **regular terminal** (NOT inside Claude Code):

```powershell
claude mcp add memory --scope user -- node D:/Betting/memory/memory-mcp-server.js
```

Verify:

```powershell
claude mcp list
```

### Option 3: JSON config (if command doesn't work)

```powershell
claude mcp add-json memory "{\"command\":\"node\",\"args\":[\"D:/Betting/memory/memory-mcp-server.js\"]}"
```

### Auto-approve MCP servers

In `~/.claude/settings.json` (already configured):

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["memory"]
}
```

---

## Claude CLI Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `.mcp.json` | `D:\Betting\.mcp.json` | Registers MCP server for this project |
| `CLAUDE.md` | `D:\Betting\CLAUDE.md` | Tells Claude when/how to use memory tools |
| `settings.json` | `C:\Users\ravik\.claude\settings.json` | Global settings + auto-approve MCP |
| `memories.db` | `D:\Betting\memories.db` | SQLite database (all memories stored here) |

---

## 8 Tools Claude Gets

| Tool | Description |
|------|-------------|
| `search_memories` | Search by keyword, filter by type/importance |
| `add_memory` | Save with type (static/dynamic/episodic/semantic) + importance (critical/high/normal/low) |
| `update_memory` | Update existing memory content or importance |
| `delete_memory` | Soft-delete a memory (recoverable) |
| `get_user_profile` | Load all static facts + recent dynamic context |
| `list_memories` | List all memories, optionally filter by type |
| `link_memories` | Create relationships between memories |
| `memory_stats` | Total count, breakdown by type and importance |

---

## Test It

Restart Claude Code in `D:\Betting`, then:

```
> My name is Ravi and I prefer dark mode
> What do you know about me?
```

Close and reopen:

```
> What's my name?
```

It remembers.

Run the test suite:

```bash
node test-memory.js
```

Expected: 36/36 PASS.

---

## For Your AI App (not just Claude CLI)

### Vercel AI SDK

```js
import { selfHostedMemoryTools } from './ai-sdk-tools.js';

const tools = selfHostedMemoryTools({
  dbPath: './memories.db',
  containerTags: ['user_123'],
});

// 6 tools: searchMemories, addMemory, updateMemory,
//          forgetMemory, getUserProfile, getRelatedMemories
```

### Auto-inject middleware (any model)

```js
import { withMemory } from './memory-middleware.js';

const model = withMemory(openai('gpt-4o'), 'user_123', {
  dbPath: './memories.db',
  addMemory: 'always',
  tokenBudget: 2000,
});
```

### OpenAI direct

```js
import { withOpenAIMemory } from './memory-middleware.js';

withOpenAIMemory(openaiClient, 'user_123', {
  dbPath: './memories.db',
  addMemory: 'always',
});
// openai.chat.completions.create() now auto-injects memories
```

### Any LLM (Anthropic, Gemini, Ollama, etc.)

```js
import { withGenericMemory } from './memory-middleware.js';

const chat = withGenericMemory(myLLMFunction, 'user_123', {
  dbPath: './memories.db',
  addMemory: 'always',
});
```

See `examples.js` for 7 complete examples.

---

## Custom Environment Variables

```powershell
# Custom database path
set MEMORY_DB_PATH=D:\my-path\memories.db

# Separate memories by project
set MEMORY_CONTAINER=my_project

# With MCP registration
claude mcp add memory -e MEMORY_DB_PATH=D:/path/memories.db -e MEMORY_CONTAINER=my_project --scope user -- node D:/Betting/memory/memory-mcp-server.js
```

---

## vs Paid Tools

| Feature | Supermemory ($29/mo) | Mem0 ($20/mo) | Zep ($49/mo) | This (FREE) |
|---------|---------------------|---------------|-------------|-------------|
| FTS5 search | Cloud only | No | No | Yes |
| Vector search | Yes | Yes | Yes | Yes (5 options) |
| Hybrid ranking | No | No | Partial | Yes |
| Importance levels | No | No | No | 4 levels |
| Time decay | No | Partial | Yes | Yes |
| Memory dedup/merge | Server-side | Basic | No | Yes |
| Fact extraction | No | Yes ($) | No | Yes (any LLM) |
| Memory graph | No | No | No | Yes |
| 4 memory types | 2 | 1 | 2 | 4 |
| Chunking | No | No | Yes | Yes |
| Token budget | No | No | No | Yes |
| Soft delete | No | No | No | Yes |
| Export/import | No | No | No | Yes |
| MCP for Claude CLI | No | No | No | 8 tools |
| Self-hosted | No | No | No | Yes |
