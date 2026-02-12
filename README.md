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

