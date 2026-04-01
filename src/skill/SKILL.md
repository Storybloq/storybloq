---
name: story
description: Cross-session context persistence for AI coding projects. Load project context, manage sessions, guide setup.
---

# /story -- Project Context & Session Management

claudestory tracks tickets, issues, roadmap, and handovers in a `.story/` directory so every AI coding session builds on the last instead of starting from zero.

## How to Handle Arguments

`/story` is one smart command. Parse the user's intent from context:

- `/story` -> full context load (default, see Step 2 below)
- `/story auto` -> start autonomous mode (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `claudestory setup-skill`)
- `/story review T-XXX` -> start review mode for a ticket (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `claudestory setup-skill`)
- `/story plan T-XXX` -> start plan mode for a ticket (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `claudestory setup-skill`)
- `/story guided T-XXX` -> start guided mode for a ticket (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `claudestory setup-skill`)
- `/story handover` -> draft a session handover. Summarize the session's work, then call `claudestory_handover_create` with the drafted content and a descriptive slug
- `/story snapshot` -> save project state (call `claudestory_snapshot` MCP tool)
- `/story export` -> export project for sharing. Ask the user whether to export the current phase or the full project, then call `claudestory_export` with either `phase` or `all` set
- `/story status` -> quick status check (call `claudestory_status` MCP tool)
- `/story help` -> show all capabilities (read `reference.md` in the same directory as this skill file; if not found, tell user to run `claudestory setup-skill`)

If the user's intent doesn't match any of these, use the full context load.

## Step 0: Check Setup

Check if the claudestory MCP tools are available by looking for `claudestory_status` in your available tools.

**If MCP tools ARE available** -> proceed to Step 1.

**If MCP tools are NOT available:**

1. Check if the `claudestory` CLI is installed: run `claudestory --version` via Bash
2. If NOT installed:
   - Check `node --version` and `npm --version` -- both must be available
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
- Read `RULES.md` if it exists in the project root
- Run `claudestory lesson digest` via Bash
- Run `git log --oneline -10`
- Then continue to Step 3 below

## Step 1: Check Project

- If `.story/` exists in the current working directory (or a parent) -> proceed to Step 2
- If no `.story/` but project indicators exist (code, manifest, .git) -> read `setup-flow.md` in the same directory as this skill file and follow the AI-Assisted Setup Flow (if not found, tell user to run `claudestory setup-skill`)
- If no `.story/` and no project indicators -> explain what claudestory is and suggest navigating to a project

## Step 2: Load Context (Default /story Behavior)

Call these in order:

1. **Project status** -- call `claudestory_status` MCP tool
2. **Session recap** -- call `claudestory_recap` MCP tool (shows changes since last snapshot)
3. **Recent handovers** -- call `claudestory_handover_latest` MCP tool with `count: 3` (last 3 sessions' context -- ensures reasoning behind recent decisions is preserved, not just the latest session's state)
4. **Development rules** -- read `RULES.md` if it exists in the project root
5. **Lessons learned** -- call `claudestory_lesson_digest` MCP tool
6. **Recent commits** -- run `git log --oneline -10`

## Step 2b: Empty Scaffold Check

After `claudestory_status` returns, check in order:

1. **Integrity guard** -- if the response starts with "Warning:" and contains "item(s) skipped due to data integrity issues", this is NOT an empty scaffold. Tell the user to run `claudestory validate`. Continue Step 2/3 normally.
2. **Scaffold detection** -- check BOTH: output contains "## Getting Started" AND shows `Tickets: 0/0 complete` + `Handovers: 0`. If met AND the project has code indicators (git history, package manifest, source files), read `setup-flow.md` in the same directory as this skill file and follow the AI-Assisted Setup Flow (section 1b). After setup completes, restart Step 2 from the top (the project now has data to load).
3. **Empty without code** -- if scaffold detected but no code indicators (truly empty directory), continue to Step 3 which will show: "Your project is set up but has no tickets yet. Would you like me to help you create your first phase and tickets?"

## Step 3: Present Summary

After loading context, present a summary that feels like a collaborator catching you up -- conversational, not a status report.

Include:
- Project progress (X/Y tickets complete, current phase)
- What changed since last snapshot (from recap)
- What the last session accomplished (from handover -- keep it to 1-2 sentences)
- The recommended next ticket and why it's next (unblocked, high priority, continues recent work)
- Any high-severity issues or blockers worth knowing about
- Key process rules (from lessons digest -- only if there are lessons)

Use `claudestory_recommend` for context-aware suggestions mixing tickets and issues.

**First session guide (show only when handover count is 0 or 1):** If this is the user's first or second real session (setup handover is the only one), include a brief mode guide after the summary:

```
Tip: You can also use these modes anytime:
  /story auto           I work through tickets autonomously -- plan, review, build, commit, loop
  /story guided T-XXX   One ticket end-to-end with planning and code review
  /story review T-XXX   Review code you already wrote
```

Show this once or twice, then never again. Returning users don't need it.

End with `AskUserQuestion`:
- question: "What would you like to do?"
- header: "Next"
- options:
  - "Work on [recommended ticket title]" -- the ticket you just recommended
  - "Something else" -- I'll ask what you have in mind
  - "Autonomous mode" -- I'll work through tickets on my own
- (Other always available for free-text input)

This replaces the open-ended "What would you like to work on?" with a one-tap default. Most users want the recommended ticket -- make that effortless.

## Session Lifecycle

- **Snapshots** save project state for diffing. They may be auto-taken before context compaction.
- **Handovers** are session continuity documents. Create one at the end of significant sessions.
- **Recaps** show what changed since the last snapshot -- useful for understanding drift.

**Never modify or overwrite existing handover files.** Handovers are append-only historical records. Always create new handover files -- never edit, replace, or write to an existing one. If you need to correct something from a previous session, create a new handover that references the correction. This prevents accidental data loss during sessions.

Before writing a handover at the end of a session, run `claudestory snapshot` first. This ensures the next session's recap can show what changed. If `setup-skill` has been run, a PreCompact hook auto-takes snapshots before context compaction.

**Lessons** capture non-obvious process learnings that should carry forward across sessions. At the end of a significant session, review what you learned and create lessons via `claudestory_lesson_create` for:
- Patterns that worked (or failed) and why
- Architecture decisions with non-obvious rationale
- Tool/framework quirks discovered during implementation
- Process improvements (review workflows, testing strategies)

Don't duplicate what's already in the handover -- lessons are structured, tagged, and ranked. Handovers are narrative. Use `claudestory_lesson_digest` to check existing lessons before creating duplicates. Use `claudestory_lesson_reinforce` when an existing lesson proves true again.

## Ticket and Issue Discipline

**Tickets** are planned work -- features, tasks, refactors. They represent intentional, scoped commitments.

**Ticket types:**
- `task` -- Implementation work: building features, writing code, fixing bugs, refactoring.
- `feature` -- A user-facing capability or significant new functionality. Larger scope than a task.
- `chore` -- Maintenance, publishing, documentation, cleanup. No functional change to the product.

**Issues** are discovered problems -- bugs, inconsistencies, gaps, risks found during work. If you're not sure whether something is a ticket or an issue, make it an issue. It can be promoted to a ticket later.

When working on a task and you encounter a bug, inconsistency, or improvement opportunity that is out of scope for the current ticket, create an issue using `claudestory issue create` (CLI) with a clear title, severity, and impact description. Don't fix it in the current task, don't ignore it -- log it. This keeps the issue tracker growing organically and ensures nothing discovered during work is lost.

When starting work on a ticket, update its status to `inprogress`. When done, update to `complete` in the same commit as the code change.

## Managing Tickets and Issues

Ticket and issue create/update operations are available via both CLI and MCP tools. Delete remains CLI-only.

CLI examples:
- `claudestory ticket create --title "..." --type task --phase p0`
- `claudestory ticket update T-001 --status complete`
- `claudestory issue create --title "..." --severity high --impact "..."`

MCP examples:
- `claudestory_ticket_create` with `title`, `type`, and optional `phase`, `description`, `blockedBy`, `parentTicket`
- `claudestory_ticket_update` with `id` and optional `status`, `title`, `order`, `description`, `phase`, `parentTicket`
- `claudestory_issue_create` with `title`, `severity`, `impact`, and optional `components`, `relatedTickets`, `location`, `phase`
- `claudestory_issue_update` with `id` and optional `status`, `title`, `severity`, `impact`, `resolution`, `components`, `relatedTickets`, `location`

Read operations (list, get, next, blocked) are available via both CLI and MCP.

## Notes

**Notes** are unstructured brainstorming artifacts -- ideas, design thinking, "what if" explorations. Use notes when the content doesn't fit tickets (planned work) or issues (discovered problems).

Create notes via CLI: `claudestory note create --content "..." --tags idea`

Create notes via MCP: `claudestory_note_create` with `content`, optional `title` and `tags`.

List, get, and update notes via MCP: `claudestory_note_list`, `claudestory_note_get`, `claudestory_note_update`. Delete remains CLI-only: `claudestory note delete <id>`.

## Support Files

Additional skill documentation, loaded on demand:

- **`setup-flow.md`** -- Project detection and AI-Assisted Setup Flow (new project initialization)
- **`autonomous-mode.md`** -- Autonomous mode, review, plan, and guided execution tiers
- **`reference.md`** -- Full CLI command and MCP tool reference
