# Claude Fleet Management — Bootstrap Plan

**Goal:** Set up a memory file for a large monorepo so every fresh Claude/Copilot session starts with the right context, automatically.

**Context:** ~355 Vue files, ~1125 TS files, mixed authorship, 125k context (40k reserved = ~85k usable), fresh sessions every time.

---

## What's a Harness?

The harness is the tooling that auto-loads your memory file into every session. You already have it — it's whatever mechanism your tool uses to inject instructions (e.g. `.github/copilot-instructions.md`, CLAUDE.md, etc). The harness is solved.

The missing piece is the **memory file** — a high-signal summary of the codebase that every session reads automatically.

---

## The Plan

### 1. Open a session in the repo

Point a Claude session at your monorepo root.

### 2. Prompt it

> Explore this codebase. Write a memory file at `[YOUR_MEMORY_FILE_PATH]` that captures:
> - High-level architecture (packages, key directories, how they connect)
> - Tech stack and framework details
> - Naming conventions and patterns in use
> - State management approach
> - API/data layer patterns
> - Known tech debt and gotchas
> - Key files and their purposes (paths, not contents)
>
> Keep it under 100 lines. This file will be auto-loaded into every future session as context, so make every line count.

### 3. Verify the output

Read it. Fix anything wrong. Commit it.

### 4. Done

Every future session auto-loads the memory file via the harness. No manual steps, no pasting, no ceremony.

---

## Maintaining It

Re-run step 2 periodically (monthly, or after major refactors) with:

> Read the current memory file at `[PATH]`. Explore what's changed in the codebase since it was written. Update the memory file. Keep it under 100 lines.

That's it.
