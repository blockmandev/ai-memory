# Project Memory Instructions

You have access to a persistent memory system via MCP tools. USE IT ACTIVELY.

## When to SAVE memories (add_memory):
- When I share personal info (name, preferences, background, location)
- When I make decisions about the project (tech choices, architecture)
- When I mention preferences (coding style, tools, workflows)
- When I share goals, deadlines, or plans
- When important context comes up that would be useful in future sessions

### Memory types:
- `static` — permanent facts (my name, preferences, skills, background)
- `dynamic` — current context (what I'm working on now, recent decisions)
- `episodic` — conversation highlights worth remembering
- `semantic` — learned concepts or patterns

### Importance levels:
- `critical` — identity facts, vital project info
- `high` — strong preferences, key decisions
- `normal` — general useful info
- `low` — minor details

## When to SEARCH memories (search_memories):
- At the start of every session — run `get_user_profile` first to load context
- When I ask about something we discussed before
- When I reference past decisions or preferences
- When you need context to give a personalized answer

## Rules:
- ALWAYS run `get_user_profile` at the beginning of a new session
- ALWAYS save important new information immediately — don't wait
- When updating old info, use `update_memory` instead of adding duplicates
- Use `link_memories` to connect related topics
- Prefer `static` type for facts that won't change, `dynamic` for things that will
