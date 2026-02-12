# 🧠 Self-Hosted AI Memory System
## FREE, no API key needed
### The core flow is simple:
```
User message → search for relevant memories → inject into system prompt → AI responds → optionally save conversation
```

### What you're paying for:
- Vector search (semantic similarity)
- Profile extraction (static facts + dynamic context)
- Document storage & retrieval
- Deduplication

### What this replacement gives you — FREE:
- ✅ Same vector search using local embeddings
- ✅ Same profile system (static + dynamic memories)
- ✅ Same AI SDK tool interface
- ✅ Same middleware pattern
- ✅ SQLite storage (no cloud dependency)
- ✅ Works with your IPFS/encrypted DB architecture
```
D:\(project-Folder)\
│
├── memory\                          ← For Claude CLI (use NOW)
│   ├── memory-mcp-server.js         ← ONLY this file needed
│   ├── package.json                 ← created by npm init -y
│   └── node_modules\                ← created by npm install
│
│
└── your-ai-app\                     ← For your PRODUCT (use LATER)
    ├── memory-engine.js
    ├── ai-sdk-tools.js
    ├── memory-middleware.js
    ├── embeddings.js
    ├── examples.js
    └── package.json
```
#How to Use in Claude CLI
```

# 1. Create folder & install dependency
mkdir D:\(project-Folder)\memory
cd D:\(project-Folder)\memory
npm init -y
npm install better-sqlite3

# 2. Copy memory-mcp-server.js into D:\(project-Folder)\memory\

# 3. Register with Claude Code (run in regular terminal, NOT inside Claude)
claude mcp add memory --scope user -- node D:/(project-Folder)/memory/memory-mcp-server.js

# 4. Verify
claude mcp list
```

Then restart Claude Code and try:
```
> remember that my project is .....
> what do you know about my project?

# 🧠 Add Self-Hosted Memory to Claude Code
## Step-by-Step for Windows (your Project setup)

---

## OPTION A: MCP Server (RECOMMENDED — Best Integration)

Claude Code sees `search_memories`, `add_memory`, `get_user_profile` as native tools.

### Step 1: Create the memory folder

```powershell
mkdir D:\(project-Folder)\memory
```

### Step 2: Copy `memory-mcp-server.js` into that folder

Copy the `memory-mcp-server.js` file to `D:\(project-Folder)\memory\`

### Step 3: Install the dependency

```powershell
cd D:\(project-Folder)\memory
npm init -y
npm install better-sqlite3
```

### Step 4: Add the MCP server to Claude Code

Run this in your **regular terminal** (NOT inside Claude Code):

```powershell
claude mcp add memory -- node D:/(project-Folder)/memory/memory-mcp-server.js
```

Or if you want it available across ALL projects:

```powershell
claude mcp add memory --scope user -- node D:/(project-Folder)/memory/memory-mcp-server.js
```

### Step 5: Verify it works

```powershell
claude mcp list
```

You should see `memory` in the list.

### Step 6: Restart Claude Code and test!

```
> remember that I prefer TypeScript and my project uses Docker
> what do you know about me?
> search my memories for blockchain
```

Claude will use the `add_memory` and `search_memories` tools automatically!

---

## Alternative: Add via JSON config (if the command doesn't work)

```powershell
claude mcp add-json memory '{"command":"node","args":["D:/(project-Folder)/memory/memory-mcp-server.js"]}'
```

Or manually edit the config file.

### Config file locations:

**Project-level** (just this project):
```
D:\(project-Folder)\.mcp.json
```

**User-level** (all projects):
```
Windows: %APPDATA%\Claude\settings.json
```

### Add this to the config:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["D:/(project-Folder)/memory/memory-mcp-server.js"]
    }
  }
}
```

---

## OPTION B: Hooks (Simple — loads memory as context)

Uses your existing hooks to auto-load memory at session start.
Less powerful than MCP but simpler.

### Step 1: Update `session-start.sh`

Edit `D:/(project-Folder)/.claude/hooks/session-start.sh`:

```bash
#!/bin/bash
echo "=== Project ==="
echo ""

# Load project context
CONTEXT_FILE="D:/(project-Folder)/.claude/context.md"
if [ -f "$CONTEXT_FILE" ]; then
    cat "$CONTEXT_FILE"
fi

# Load recent memories from SQLite
MEMORY_DB="D:/(project-Folder)/memory/memories.db"
if [ -f "$MEMORY_DB" ]; then
    echo ""
    echo "=== Recent Memories ==="
    sqlite3 "$MEMORY_DB" "SELECT '- [' || memory_type || '] ' || content FROM memories WHERE container_tag='claude_memory' ORDER BY updated_at DESC LIMIT 20;"
fi
```

### Step 2: Update `user-prompt-submit.sh` (auto-save conversations)

Edit `D:/(project-Folder)/.claude/hooks/user-prompt-submit.sh`:

```bash
#!/bin/bash
# This hook receives the user's prompt via stdin
# Save it to the memory database for future reference

MEMORY_DB="D:/(project-Folder)/memory/memories.db"
PROMPT=$(cat)

if [ -n "$PROMPT" ] && [ ${#PROMPT} -gt 10 ]; then
    sqlite3 "$MEMORY_DB" "INSERT INTO memories (id, content, container_tag, memory_type, updated_at) VALUES (lower(hex(randomblob(16))), '$PROMPT', 'claude_memory', 'dynamic', datetime('now'));"
fi
```

---

## Which should you pick?

| Feature              | MCP Server (Option A)     | Hooks (Option B)      |
|----------------------|---------------------------|-----------------------|
| Claude sees tools    | ✅ Yes (native tools)     | ❌ No (just context)  |
| Claude can save      | ✅ Yes (add_memory tool)  | ⚠️ Basic (stdin hook) |
| Claude can search    | ✅ Yes (search_memories)  | ❌ Just loads recent   |
| Setup difficulty     | Medium                    | Easy                  |
| Works with /resume   | ✅ Yes                    | ✅ Yes                |
| Works across projects| ✅ With --scope user      | ❌ Per-project only   |

**I recommend Option A (MCP)** — it gives Claude actual memory tools it can use intelligently.

---

## Custom Environment Variables (optional)

You can customize the memory server:

```powershell
# Custom database path
set MEMORY_DB_PATH=D:\my-custom-path\memories.db

# Custom container tag (for separating memories by project)
set MEMORY_CONTAINER=your_project

claude mcp add memory -e MEMORY_DB_PATH=D:/(project-Folder)/memory/memories.db -e MEMORY_CONTAINER=project -- node D:/(project-Folder)/memory/memory-mcp-server.js
```

---

## Tools Claude Gets Access To

Once set up, Claude Code will have these 5 tools:

1. **search_memories** — Find relevant past memories
2. **add_memory** — Save new information (static facts or dynamic context)  
3. **get_user_profile** — Load full user profile
4. **delete_memory** — Remove a specific memory
5. **list_memories** — See all stored memories

Claude will use them automatically when relevant! 🎉

