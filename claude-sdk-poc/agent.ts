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

// --- Configuration ---

const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 8192;

// Identity prefix — required by the API for Claude Code billing tier.
// Without this, Sonnet/Opus requests return 429 when subscription is at limit.
// Must be a separate content block, verbatim, as the first system block.
const AGENT_IDENTITY = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`;

const CUSTOM_PROMPT = `You are a helpful assistant with access to tools for reading and writing files and executing commands.`;

const SYSTEM_PROMPT = [
  { type: "text" as const, text: AGENT_IDENTITY },
  { type: "text" as const, text: CUSTOM_PROMPT },
];

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

async function agentLoop(
  client: Anthropic,
  messages: MessageParam[]
): Promise<void> {
  let turnCount = 0;
  const maxTurns = 25;

  while (turnCount < maxTurns) {
    turnCount++;

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
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

  const client = new Anthropic({
    ...(oauthToken && !hasApiKey
      ? {
          authToken: oauthToken,
          apiKey: null,
          defaultHeaders: {
            "anthropic-beta": "oauth-2025-04-20",
          },
        }
      : {}),
  });
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
