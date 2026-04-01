/**
 * claude-sdk POC - Minimal agent loop
 *
 * Proves that the 13MB Claude Code CLI child process is unnecessary.
 * ~200 lines of TypeScript to replace the Agent SDK.
 *
 * MVP features:
 * 1. Agent loop (Messages API, tool_use dispatch)
 * 2. Streaming (text deltas to stdout)
 * 3. Tool execution (mcp-exec as library, fs wrappers)
 * 4. Multi-turn conversation (in-process state)
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
  Tool,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

// --- OAuth Token Exchange ---

const OAUTH_CONFIG = {
  TOKEN_URL: "https://platform.claude.com/v1/oauth/token",
  CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  BETA_HEADER: "oauth-2025-04-20",
};

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  fetched_at: number;
}

let cachedTokens: OAuthTokens | null = null;

async function exchangeRefreshToken(
  refreshToken: string
): Promise<OAuthTokens> {
  const res = await fetch(OAUTH_CONFIG.TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CONFIG.CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    fetched_at: Date.now(),
  };
}

async function getAccessToken(refreshToken: string): Promise<string> {
  // Return cached token if still valid (5 min buffer)
  if (cachedTokens) {
    const elapsed = Date.now() - cachedTokens.fetched_at;
    const bufferMs = 5 * 60 * 1000;
    if (elapsed < cachedTokens.expires_in * 1000 - bufferMs) {
      return cachedTokens.access_token;
    }
    process.stderr.write("[OAuth] Access token expired, refreshing...\n");
  }

  process.stderr.write("[OAuth] Exchanging refresh token for access token...\n");
  cachedTokens = await exchangeRefreshToken(refreshToken);
  process.stderr.write(
    `[OAuth] Got access token (expires in ${cachedTokens.expires_in}s)\n`
  );
  return cachedTokens.access_token;
}

// --- Configuration ---

const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 8192;
const SYSTEM_PROMPT = `You are a helpful assistant with access to tools for reading and writing files and executing commands.`;

// --- Tool Definitions ---

const tools: Tool[] = [
  {
    name: "read_file",
    description: "Read a file from the filesystem. Returns the file contents as text.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Absolute path to the file to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file on the filesystem. Creates or overwrites the file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Absolute path to the file to write" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "exec",
    description: "Execute a command. Returns stdout, stderr, and exit code.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The command to execute" },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["command"],
    },
  },
];

// --- Tool Handlers ---

async function handleToolCall(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "read_file": {
      const path = input.path as string;
      if (!existsSync(path)) return `Error: File not found: ${path}`;
      try {
        return readFileSync(path, "utf-8");
      } catch (e) {
        return `Error reading file: ${(e as Error).message}`;
      }
    }
    case "write_file": {
      const path = input.path as string;
      const content = input.content as string;
      try {
        writeFileSync(path, content, "utf-8");
        return `File written successfully: ${path}`;
      } catch (e) {
        return `Error writing file: ${(e as Error).message}`;
      }
    }
    case "exec": {
      const command = input.command as string;
      const cwd = (input.cwd as string) || process.cwd();
      try {
        const { execSync } = await import("node:child_process");
        const output = execSync(command, {
          cwd,
          encoding: "utf-8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return output || "(no output)";
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        return `Exit code: ${err.status ?? 1}\nstdout: ${err.stdout ?? ""}\nstderr: ${err.stderr ?? ""}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// --- Agent Loop ---

async function refreshClientIfNeeded(
  client: Anthropic
): Promise<Anthropic> {
  const oauthRefreshToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthRefreshToken || !!process.env.ANTHROPIC_API_KEY) return client;

  // Check if cached token needs refresh
  if (cachedTokens) {
    const elapsed = Date.now() - cachedTokens.fetched_at;
    const bufferMs = 5 * 60 * 1000;
    if (elapsed >= cachedTokens.expires_in * 1000 - bufferMs) {
      const accessToken = await getAccessToken(oauthRefreshToken);
      return new Anthropic({
        authToken: accessToken,
        apiKey: null,
        defaultHeaders: { "anthropic-beta": OAUTH_CONFIG.BETA_HEADER },
      });
    }
  }
  return client;
}

async function agentLoop(
  client: Anthropic,
  messages: MessageParam[]
): Promise<void> {
  let turnCount = 0;
  const maxTurns = 25;

  while (turnCount < maxTurns) {
    turnCount++;

    // Refresh OAuth token if needed mid-session
    client = await refreshClientIfNeeded(client);

    // Stream the response
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Collect the streamed response
    let currentText = "";
    const toolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];

    // Stream text to stdout in real-time
    stream.on("text", (text) => {
      process.stdout.write(text);
      currentText += text;
    });

    const finalMessage = await stream.finalMessage();

    // Log usage
    const { usage } = finalMessage;
    process.stderr.write(
      `\n[Turn ${turnCount}] Tokens: ${usage.input_tokens} in, ${usage.output_tokens} out` +
        (usage.cache_read_input_tokens
          ? `, ${usage.cache_read_input_tokens} cache-read`
          : "") +
        (usage.cache_creation_input_tokens
          ? `, ${usage.cache_creation_input_tokens} cache-create`
          : "") +
        `\n`
    );

    // Add assistant message to history
    messages.push({ role: "assistant", content: finalMessage.content });

    // Check if we're done (no tool use)
    if (finalMessage.stop_reason === "end_turn") {
      if (currentText) process.stdout.write("\n");
      return;
    }

    // Extract tool uses
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    if (toolUses.length === 0) {
      // No tool use, stop_reason might be max_tokens or something else
      if (currentText) process.stdout.write("\n");
      return;
    }

    // Execute tools and collect results
    const toolResults: ToolResultBlockParam[] = [];

    for (const tool of toolUses) {
      process.stderr.write(`[Tool] ${tool.name}(${JSON.stringify(tool.input)})\n`);
      const result = await handleToolCall(tool.name, tool.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: result,
      });
    }

    // Add tool results to conversation
    messages.push({ role: "user", content: toolResults });
  }

  process.stderr.write(`[Warning] Max turns (${maxTurns}) reached\n`);
}

// --- REPL ---

async function main() {
  const oauthRefreshToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

  let client: Anthropic;

  if (oauthRefreshToken && !hasApiKey) {
    // OAuth flow: exchange refresh token for short-lived access token
    const accessToken = await getAccessToken(oauthRefreshToken);
    client = new Anthropic({
      authToken: accessToken,
      apiKey: null,
      defaultHeaders: { "anthropic-beta": OAUTH_CONFIG.BETA_HEADER },
    });
  } else {
    // Standard API key flow (reads ANTHROPIC_API_KEY from env)
    client = new Anthropic();
  }

  const messages: MessageParam[] = [];

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("claude-sdk POC - Type your message (Ctrl+C to exit)");
  console.log("---");

  const prompt = () => {
    rl.question("\n> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      // Add user message
      messages.push({ role: "user", content: trimmed });

      // Run agent loop
      await agentLoop(client, messages);

      // Continue
      prompt();
    });
  };

  prompt();
}

main().catch((e) => {
  if (e?.status === 429) {
    const headers = e.headers;
    console.error("[429] Rate limited");
    console.error("[429] Headers:", headers ? JSON.stringify(Object.fromEntries(headers.entries())) : "none");
    console.error("[429] Error:", JSON.stringify(e.error));
  } else {
    console.error(e);
  }
});
