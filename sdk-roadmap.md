# SDK POC to MVP Roadmap

## What We Have (POC - Proven 2 April 2026)

`claude-sdk-poc/agent.ts` - 190 lines. Working end-to-end:
- Streaming Messages API with `client.beta.messages.stream()`
- Tool dispatch loop (define tools, model calls them, we execute, send results back)
- Identity string (`"You are a Claude agent, built on Anthropic's Claude Agent SDK."`) as separate system content block - exact match required for billing tier
- OAuth token auth (`CLAUDE_CODE_OAUTH_TOKEN` used as `authToken`, no exchange needed)
- `?beta=true` handled automatically by `client.beta.messages`

## What MVP Needs

### Phase 1: Core Agent Loop (The Minimum)

**1.1 — Tool Implementation**
- Read, Write, Edit, Glob, Grep — file operations
- Bash/Exec — command execution (mcp-exec is already a library, import it)
- WebSearch, WebFetch — HTTP access
- Each tool: schema (JSON Schema for the model) + executor (runs the tool, returns result)
- ~50-100 lines per tool, mostly schema definitions

**1.2 — Conversation State**
- Accumulate messages array across turns (user → assistant → tool_result → assistant → ...)
- Persist to disk (JSON file) for session resume
- Session ID tracking

**1.3 — System Prompt**
- Identity string (verbatim, separate content block)
- Custom prompt (second content block)
- CLAUDE.md / memory file injection (third content block)
- System prompt as array of content blocks, not concatenated string

### Phase 2: Context Management (The Smart Part)

This is where your own SDK has a massive advantage over the Agent SDK — you own the message array.

**2.1 — Token Counting**
- Track `usage` from every API response: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- Calculate context percentage: `totalTokens / contextWindow * 100`
- Know when you're approaching the limit

**2.2 — Server-Side Context Management (The `context_management` Beta)**

This is the feature you asked about. Here's how it works:

You send a `context_management` field in the request body alongside `messages`, `model`, etc:

```typescript
const response = await client.beta.messages.create({
  model: "claude-sonnet-4-6-20250514",
  max_tokens: 8096,
  system: [...],
  messages: [...],
  // This is the magic part:
  context_management: {
    edits: [
      {
        // Strategy 1: Clear old tool results when context gets big
        type: "clear_tool_uses_20250919",
        trigger: { type: "input_tokens", value: 180000 },  // When to start clearing
        clear_at_least: { type: "input_tokens", value: 140000 },  // How much to clear
        clear_tool_inputs: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch"],  // Which tool results to clear
        // exclude_tools: ["Edit", "Write"],  // Alternatively: clear everything EXCEPT these
      },
      {
        // Strategy 2: Clear old thinking blocks
        type: "clear_thinking_20251015",
        keep: { type: "thinking_turns", value: 3 },  // Keep last 3 thinking turns
        // keep: "all"  // Or keep all thinking
      }
    ]
  }
});
```

**What happens server-side:**
1. You send the full message array (unchanged) + the `context_management` config
2. The API evaluates the strategies against your messages
3. If `trigger` threshold is met (e.g. >180K input tokens), it clears old tool results/thinking blocks from the SERVER'S view of the conversation
4. The response comes back as normal — model sees the trimmed context
5. **Your local message array is NOT modified** — the edits are server-side only

**What this means for you:**
- You keep the full conversation history locally (for audit, replay, session resume)
- The API automatically manages what the model actually sees
- No client-side token counting needed for the clearing logic — the API does it
- You still need token counting for your OWN budgeting/cost tracking

**Beta header required:** `context-management-2025-06-27` in the `betas` array.

**Current CLI behaviour:**
- `clear_tool_uses` is ant-only (gated by `USER_TYPE=ant` env var) — may not work for external users yet
- `clear_thinking` works for everyone with thinking enabled
- There's also a `cache_edits` system (cached microcompact) that uses `cache_reference` + `cache_edits` blocks to edit the cached prefix without re-sending — but that's more advanced

**2.3 — Client-Side Compaction (Fallback)**

When context is truly full (can't just trim tool results), you need full compaction:
1. Send the conversation to a cheap model (Haiku) with "summarise this conversation"
2. Replace the message array with: `[{role: "user", content: "Previous conversation summary: ..."}]`
3. Continue from there

The CLI does this at ~90% context. With your own SDK, you control when and how.

**2.4 — Prompt Caching**

The beta header `prompt-caching-scope-2026-01-05` enables prompt caching. The API caches the prefix of your request — identical system prompt + identical message prefix = cache hit. 90% discount on cached tokens.

Key insight from our testing: system prompt changes only invalidate the tail. The expensive prefix (identity string + tools + CLAUDE.md) stays cached.

### Phase 3: Session & Cost Management

**3.1 — Session Persistence**
- Save/load conversation state to disk
- Resume sessions across restarts
- Session ID → file mapping

**3.2 — Cost Tracking**
- Per-turn cost from `usage` response
- Cumulative session cost
- Cost per model tier (Opus vs Sonnet vs Haiku pricing)

**3.3 — Model Selection**
- Default model for normal queries
- Cheap model (Haiku) for compaction
- Model switching based on task complexity (the self-routing state machine concept)

### Phase 4: Integration

**4.1 — MCP Support**
- Import `@modelcontextprotocol/sdk` for MCP client
- Connect to MCP servers (mcp-exec already works as a library)
- Tool discovery via `tools/list`, execution via `tools/call`

**4.2 — Structured Output**
- `outputFormat` / tool-based structured output for typed responses
- Same pattern as banananet's StructuredOutput tool

**4.3 — Thinking Support**
- `thinking` parameter in request
- `effort` level (low/medium/high)
- Beta header: `interleaved-thinking-2025-05-14`

## Key Beta Headers

```typescript
const BETAS = [
  "oauth-2025-04-20",                  // OAuth auth (required for OAuth token)
  "interleaved-thinking-2025-05-14",    // Thinking support
  "context-management-2025-06-27",      // Server-side context management
  "prompt-caching-scope-2026-01-05",    // Prompt caching
  "effort-2025-11-24",                  // Effort levels
  "token-efficient-tools-2026-03-28",   // Tool token optimization
];
```

## What You DON'T Need

- React Ink (terminal rendering) — plain stdout
- Bun — Node.js
- 13MB bundled CLI — ~500 lines
- Agent SDK — direct Messages API
- Permission system — you ARE the permission system
- `settingSources` / skills / hooks — your harness, your rules

## Architecture Principle

The drone, not the tank. Every line of code is yours. Every decision is visible. When it breaks, you know why — because you wrote it.
