---
name: story
description: Cross-session context persistence for AI coding projects. Load project context, manage sessions, guide setup.
---

# /story — Project Context & Session Management

claudestory tracks tickets, issues, roadmap, and handovers in a `.story/` directory so every AI coding session builds on the last instead of starting from zero.

## How to Handle Arguments

`/story` is one smart command. Parse the user's intent from context:

- `/story` → full context load (default, see Step 2 below)
- `/story handover` → draft a session handover. Summarize the session's work, then call `claudestory_handover_create` with the drafted content and a descriptive slug
- `/story snapshot` → save project state (call `claudestory_snapshot` MCP tool)
- `/story export` → export project for sharing. Ask the user whether to export the current phase or the full project, then call `claudestory_export` with either `phase` or `all` set
- `/story status` → quick status check (call `claudestory_status` MCP tool)
- `/story help` → show all capabilities (read `~/.claude/skills/story/reference.md`)

If the user's intent doesn't match any of these, use the full context load.

## Step 0: Check Setup

Check if the claudestory MCP tools are available by looking for `claudestory_status` in your available tools.

**If MCP tools ARE available** → proceed to Step 1.

**If MCP tools are NOT available:**

1. Check if the `claudestory` CLI is installed: run `claudestory --version` via Bash
2. If NOT installed:
   - Check `node --version` and `npm --version` — both must be available
   - If Node.js is missing, tell the user to install Node.js 20+ first
   - Otherwise, with user permission, run: `npm install -g @anthropologies/claudestory`
   - Then run: `claude mcp add claudestory -s user -- claudestory --mcp`
   - Tell the user to restart Claude Code and run `/story` again
3. If CLI IS installed but MCP not registered:
   - With user permission, run: `claude mcp add claudestory -s user -- claudestory --mcp`
   - Tell the user to restart Claude Code and run `/story` again

**Important:** Always use `npm install -g`, never `npx`, for the CLI. The MCP server needs the global binary.

**If MCP tools are unavailable and user doesn't want to set up**, fall back to CLI mode:
- Run `claudestory status` via Bash
- Run `claudestory recap` via Bash
- Run `claudestory handover latest` via Bash
- Read `RULES.md` and `WORK_STRATEGIES.md` if they exist in the project root
- Run `git log --oneline -10`
- Then continue to Step 3 below

## Step 1: Check Project

- If `.story/` exists in the current working directory (or a parent) → proceed to Step 2
- If no `.story/` but the directory looks like a real project (has package.json, Cargo.toml, go.mod, pyproject.toml, .git, etc.) → offer to initialize: "Want me to set up claudestory? It creates a .story/ directory for tracking tickets, issues, and session handovers." With permission, run `claudestory init --name <project-name>`
- If not a project directory → explain what claudestory is and suggest navigating to a project

## Step 2: Load Context (Default /story Behavior)

Call these in order:

1. **Project status** — call `claudestory_status` MCP tool
2. **Session recap** — call `claudestory_recap` MCP tool (shows changes since last snapshot)
3. **Recent handovers** — call `claudestory_handover_latest` MCP tool with `count: 3` (last 3 sessions' context — ensures reasoning behind recent decisions is preserved, not just the latest session's state)
4. **Development rules** — read `RULES.md` if it exists in the project root
5. **Lessons learned** — read `WORK_STRATEGIES.md` if it exists in the project root
6. **Recent commits** — run `git log --oneline -10`

## Step 3: Present Summary

After loading context, present a concise summary:

- Project progress (X/Y tickets complete, current phase)
- What changed since last snapshot (from recap)
- What the last session accomplished (from handover)
- Next ticket to work on
- Any high-severity issues or blockers
- Key process rules (from WORK_STRATEGIES.md if it exists)

Then ask: **"What would you like to work on?"**

## Session Lifecycle

- **Snapshots** save project state for diffing. They may be auto-taken before context compaction.
- **Handovers** are session continuity documents. Create one at the end of significant sessions.
- **Recaps** show what changed since the last snapshot — useful for understanding drift.

**Never modify or overwrite existing handover files.** Handovers are append-only historical records. Always create new handover files — never edit, replace, or write to an existing one. If you need to correct something from a previous session, create a new handover that references the correction. This prevents accidental data loss during sessions.

Before writing a handover at the end of a session, run `claudestory snapshot` first. This ensures the next session's recap can show what changed. Until the PreCompact hook is automated (T-102), snapshots must be taken manually.

## Ticket and Issue Discipline

**Tickets** are planned work — features, tasks, refactors. They represent intentional, scoped commitments.

**Ticket types:**
- `task` — Implementation work: building features, writing code, fixing bugs, refactoring.
- `feature` — A user-facing capability or significant new functionality. Larger scope than a task.
- `chore` — Maintenance, publishing, documentation, cleanup. No functional change to the product.

**Issues** are discovered problems — bugs, inconsistencies, gaps, risks found during work. If you're not sure whether something is a ticket or an issue, make it an issue. It can be promoted to a ticket later.

When working on a task and you encounter a bug, inconsistency, or improvement opportunity that is out of scope for the current ticket, create an issue using `claudestory issue create` (CLI) with a clear title, severity, and impact description. Don't fix it in the current task, don't ignore it — log it. This keeps the issue tracker growing organically and ensures nothing discovered during work is lost.

When starting work on a ticket, update its status to `inprogress`. When done, update to `complete` in the same commit as the code change.

## Managing Tickets and Issues

Ticket and issue CRUD operations (create, update, delete) are **CLI-only** — there are no MCP tools for these. Use the `claudestory` CLI via Bash:
- `claudestory ticket create --title "..." --type task --phase p0`
- `claudestory ticket update T-001 --status complete`
- `claudestory issue create --title "..." --severity high --impact "..."`

Read operations (list, get, next, blocked) are available via both CLI and MCP.

## Command & Tool Reference

For the full list of CLI commands and MCP tools, read `reference.md` in the same directory as this skill file.
