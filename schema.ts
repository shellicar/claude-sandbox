import { z } from "zod";

// ============================================================================
// Bash++ — A structured replacement for the Claude Bash tool
// ============================================================================
// Design goals:
//   1. Every command is individually identifiable for validation
//   2. No freeform shell syntax needed for 95% of use cases
//   3. Pipes, chaining, stdin, env vars — all structural
//   4. Validation is array traversal, not regex/parsing
//   5. Redirections are structured — no > >> 2>&1 syntax
// ============================================================================

// --- Redirect: structured output redirection ---
const RedirectSchema = z.object({
  /** File path to redirect to */
  path: z.string().describe("File path to redirect output to"),

  /** Which stream to redirect */
  stream: z.enum(["stdout", "stderr", "both"])
    .default("stdout")
    .describe("Which output stream to redirect"),

  /** Append instead of overwrite */
  append: z.boolean().default(false).describe("Append to file instead of overwriting"),
});

// --- Atomic command: one program invocation ---
const CommandSchema = z.object({
  /** The program to execute (e.g. "git", "node", "curl") */
  program: z.string().describe("The program/binary to execute"),

  /** Arguments as an array — no shell escaping needed */
  args: z.array(z.string()).default([]).describe("Arguments to the program"),

  /** Optional stdin content — replaces heredocs entirely */
  stdin: z.string().optional().describe("Content to pipe to stdin (replaces heredocs)"),

  /** Optional output redirection — replaces >, >>, 2>&1 */
  redirect: RedirectSchema.optional().describe("Redirect output to a file"),

  /** Optional working directory override for this command */
  cwd: z.string().optional().describe("Working directory for this command"),

  /** Optional environment variables for this command */
  env: z.record(z.string()).optional().describe("Environment variables to set"),
});

// --- Pipeline: commands connected by pipes ---
// e.g. cat file.txt | grep pattern | sort -u | head -5
const PipelineSchema = z.object({
  type: z.literal("pipeline"),

  /** Ordered list of commands, stdout of each piped to stdin of next */
  commands: z.array(CommandSchema).min(2).describe("Commands connected by pipes (stdout → stdin)"),
});

// --- Single command (no piping) ---
const SingleCommandSchema = z.object({
  type: z.literal("command"),
  ...CommandSchema.shape,
});

// --- A step is either a single command or a pipeline ---
const StepSchema = z.discriminatedUnion("type", [
  SingleCommandSchema,
  PipelineSchema,
]);

// --- The tool schema ---
export const BashPlusPlusSchema = z.object({
  /** Human-readable description of what this invocation does */
  description: z.string().describe("Brief description of what these commands do"),

  /** The commands to execute */
  steps: z.array(StepSchema).min(1).describe("Commands to execute"),

  /** How to chain multiple steps */
  chaining: z.enum(["sequential", "independent", "bail_on_error"])
    .default("bail_on_error")
    .describe(
      "sequential: run all regardless of exit codes (;). " +
      "bail_on_error: stop on first failure (&&). " +
      "independent: run all, report individual results."
    ),

  /** Optional timeout in milliseconds (applies to entire invocation) */
  timeout: z.number().max(600000).optional().describe("Timeout in ms (max 600000)"),

  /** Run in background — results collected later */
  background: z.boolean().default(false).describe("Run in background, collect results later"),
});

// ============================================================================
// Type exports
// ============================================================================
export type Redirect = z.infer<typeof RedirectSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type Pipeline = z.infer<typeof PipelineSchema>;
export type SingleCommand = z.infer<typeof SingleCommandSchema>;
export type Step = z.infer<typeof StepSchema>;
export type BashPlusPlus = z.infer<typeof BashPlusPlusSchema>;

// ============================================================================
// Examples — what Claude would generate
// ============================================================================

export const examples: { name: string; input: BashPlusPlus }[] = [
  {
    name: "Simple: git status",
    input: {
      description: "Show working tree status",
      steps: [
        { type: "command", program: "git", args: ["status"] },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
  {
    name: "Chained: build and test",
    input: {
      description: "Build the project then run tests",
      steps: [
        { type: "command", program: "pnpm", args: ["build"] },
        { type: "command", program: "pnpm", args: ["test"] },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
  {
    name: "Pipeline: search and count",
    input: {
      description: "Find TODO comments and count them",
      steps: [
        {
          type: "pipeline",
          commands: [
            { program: "grep", args: ["-r", "TODO", "src/"] },
            { program: "wc", args: ["-l"] },
          ],
        },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
  {
    name: "Heredoc replacement: git commit with message",
    input: {
      description: "Create a git commit with a multi-line message",
      steps: [
        { type: "command", program: "git", args: ["add", "src/parse-audit.ts"] },
        {
          type: "command",
          program: "git",
          args: ["commit", "-m", "Add column alignment for report output\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"],
        },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
  {
    name: "Stdin: write JSON to a script",
    input: {
      description: "Send JSON payload to the ADO PR creation script",
      steps: [
        {
          type: "command",
          program: "/tmp/scripts/create-pr.sh",
          args: [],
          stdin: '{"title": "Fix build", "description": "Resolves CI failure", "targetBranch": "main"}',
        },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
  {
    name: "Environment variables",
    input: {
      description: "Run tests with specific Node environment",
      steps: [
        {
          type: "command",
          program: "pnpm",
          args: ["test"],
          env: { "NODE_ENV": "test", "CI": "true" },
        },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
  {
    name: "Redirect: save command output to file",
    input: {
      description: "Save curl response to a JSON file",
      steps: [
        {
          type: "command",
          program: "curl",
          args: ["-s", "https://api.example.com/data"],
          redirect: { path: "/tmp/response.json", stream: "stdout", append: false },
        },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
  {
    name: "Redirect: append logs",
    input: {
      description: "Run build and append output to log file",
      steps: [
        {
          type: "command",
          program: "pnpm",
          args: ["build"],
          redirect: { path: "/tmp/build.log", stream: "both", append: true },
        },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
  {
    name: "Complex: pipeline with env vars",
    input: {
      description: "List Azure resources filtered by tag",
      steps: [
        {
          type: "pipeline",
          commands: [
            { program: "az", args: ["resource", "list", "--tag", "env=dev", "-o", "json"] },
            { program: "jq", args: [".[] | .name"] },
            { program: "sort" },
          ],
        },
      ],
      chaining: "bail_on_error",
      background: false,
    },
  },
];

// ============================================================================
// Validation — the whole point
// ============================================================================

export interface ValidationRule {
  /** Rule name for error messages */
  name: string;
  /** Return error message if blocked, undefined if allowed */
  check: (step: Step) => string | undefined;
}

/** Extract all programs from a step */
function extractPrograms(step: Step): Command[] {
  if (step.type === "command") {
    const { type, ...cmd } = step;
    return [cmd];
  }
  return step.commands;
}

/** Validate all steps against a set of rules */
export function validate(
  input: BashPlusPlus,
  rules: ValidationRule[],
): { allowed: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const step of input.steps) {
    for (const rule of rules) {
      const error = rule.check(step);
      if (error) {
        errors.push(`[${rule.name}] ${error}`);
      }
    }
  }

  return { allowed: errors.length === 0, errors };
}

// ============================================================================
// Example rules
// ============================================================================

export const exampleRules: ValidationRule[] = [
  {
    name: "no-destructive-commands",
    check: (step) => {
      const blocked = new Set(["rm", "rmdir", "mkfs", "dd", "shred"]);
      for (const cmd of extractPrograms(step)) {
        if (blocked.has(cmd.program)) {
          return `Command '${cmd.program}' is not permitted. Use a safer alternative.`;
        }
      }
    },
  },
  {
    name: "no-force-push",
    check: (step) => {
      for (const cmd of extractPrograms(step)) {
        if (cmd.program === "git" && cmd.args.includes("push") &&
            (cmd.args.includes("--force") || cmd.args.includes("-f"))) {
          return "Force push is not permitted. Use --force-with-lease instead.";
        }
      }
    },
  },
  {
    name: "no-sudo",
    check: (step) => {
      for (const cmd of extractPrograms(step)) {
        if (cmd.program === "sudo") {
          return "sudo is not permitted. Run commands directly.";
        }
      }
    },
  },
  {
    name: "no-env-leaks",
    check: (step) => {
      const blocked = new Set(["env", "printenv", "export"]);
      for (const cmd of extractPrograms(step)) {
        if (blocked.has(cmd.program) && cmd.args.length === 0) {
          return `'${cmd.program}' without arguments would dump all environment variables. Specify which variable to read.`;
        }
      }
    },
  },
];
