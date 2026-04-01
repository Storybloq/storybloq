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
- `/story settings` -> manage project settings (see Settings section below)
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

After loading context, present a summary with two parts: a conversational intro (2-3 sentences catching the user up), then structured tables showing actionable data.

**Part 1: Conversational intro (2-3 sentences)**

Open with the project name and progress. Mention what the last session accomplished in one sentence. Note anything important (no git repo, open issues, blockers). Keep it brief -- the tables carry the detail.

**Part 2: Structured tables (REQUIRED -- always show these, do not fold into prose)**

You MUST show the following tables after the prose intro. Do not summarize them in paragraph form.

**Ready to Work table** -- call `claudestory_recommend` for context-aware suggestions. Always render as a markdown table:

```
## Ready to Work
| Ticket | Title                              | Phase      |
|--------|-----------------------------------|------------|
| T-001  | Project setup                     | foundation |
| T-011  | Rate agreement conditions schema  | foundation |
| T-012  | Audit trail infrastructure        | foundation |
```

Show up to 5 unblocked tickets. If more exist, note "(+N more unblocked)".

**Decisions Pending** (show only if there are TBD items in CLAUDE.md or undecided tech choices):

```
## Decisions Pending
- PDF generation: managed service vs pure-JS (affects T-030)
- Background jobs: Inngest vs Trigger.dev vs Vercel Cron (affects T-001)
```

**Open Issues** (show only if issues exist with status "open"):

```
## Open Issues
| Issue    | Title                  | Severity |
|----------|------------------------|----------|
| ISS-001  | Auth token expiry bug  | high     |
```

**Key Rules** (from lessons digest or RULES.md -- brief one-line callout, not a full list):

Example: "Rules: integer cents for money, billing engine is pure logic, TDD for billing."

**First session guide (show only when handover count is 0 or 1):**

```
Tip: You can also use these modes anytime:
  /story guided T-XXX   One ticket end-to-end with planning and code review
  /story review T-XXX   Review code you already wrote
```

Show this once or twice, then never again.

**Part 3: AskUserQuestion**

End with `AskUserQuestion`:
- question: "What would you like to do?"
- header: "Next"
- options:
  - "Work on [first recommended ticket ID + title] (Recommended)" -- the top ticket from the Ready table
  - "Something else" -- I'll ask what you have in mind
  - "Autonomous mode" -- I'll pick tickets, plan, review, build, commit, and loop until done
- (Other always available for free-text input)

Autonomous mode is last -- most users want to collaborate, not hand off control.

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

## Settings (/story settings)

When the user runs `/story settings` or asks about project config, show current settings and let them change things via AskUserQuestion. Do NOT dig through source code or JS files -- the schema is documented here.

**Step 1: Read and display current config.** Read `.story/config.json` directly. Show a clean table:

```
## Current Settings

| Setting | Value |
|---------|-------|
| Max tickets per session | 5 |
| Review backends | codex, agent |
| Handover interval | every 3 tickets |
| Compact threshold | high (default) |
| TDD (WRITE_TESTS) | enabled |
| Run tests (TEST) | enabled, command: npm test |
| Smoke test (VERIFY) | disabled |
| Build validation (BUILD) | disabled |
```

**Step 2: Ask what to change.** Use `AskUserQuestion`:
- question: "What would you like to change?"
- header: "Settings"
- options:
  - "Quality pipeline" -- TDD, tests, endpoint checks, build validation
  - "Session limits" -- tickets per session, context compaction
  - "Review backends" -- which reviewers to use
  - "Handover frequency" -- how often to write session handovers

**Step 3: Focused follow-up for each category:**

**Quality pipeline:**
```
AskUserQuestion: "Quality pipeline settings"
header: "Quality"
options:
- "Full pipeline" -- TDD + tests + endpoint checks + build
- "Tests only" -- run tests after building
- "Minimal" -- no automated checks
- "Custom" -- pick individual stages
```

If "Custom", show each stage as a separate AskUserQuestion.

**Session limits:**
```
AskUserQuestion: "Max tickets per autonomous session?"
header: "Limit"
options: "3 (conservative)", "5 (default)", "10 (aggressive)", "Unlimited"
```

**Review backends:**
```
AskUserQuestion: "Which reviewers for code and plan review?"
header: "Review"
options:
- "Codex + Claude agent (Recommended)" -- alternate between both
- "Codex only" -- OpenAI Codex reviews
- "Claude agent only" -- independent Claude agent reviews
- "None" -- skip automated review
```

**Handover frequency:**
```
AskUserQuestion: "Write a handover after every N tickets?"
header: "Handover"
options: "Every ticket", "Every 3 tickets (default)", "Every 5 tickets", "Manual only"
```

**Step 4: Apply changes.** Run via Bash:
```
claudestory config set-overrides --json '<constructed JSON>'
```

Show a confirmation of what changed.

### Config Schema Reference

Do NOT search source code for this. The schema is:

```json
{
  "version": 1,
  "schemaVersion": 1,
  "project": "string",
  "type": "string (npm, cargo, pip, etc.)",
  "language": "string",
  "features": {
    "tickets": true, "issues": true, "handovers": true,
    "roadmap": true, "reviews": true
  },
  "recipe": "string (default: coding)",
  "recipeOverrides": {
    "maxTicketsPerSession": "number (0 = unlimited, default: 5)",
    "compactThreshold": "string (high/medium/low, default: high)",
    "reviewBackends": ["codex", "agent"],  // top-level default; per-stage backends override this
    "handoverInterval": "number (default: 3)",
    "stages": {
      "WRITE_TESTS": {
        "enabled": "boolean",
        "command": "string (test command)",
        "onExhaustion": "plan | advance (default: plan)"
      },
      "TEST": {
        "enabled": "boolean",
        "command": "string (default: npm test)"
      },
      "VERIFY": {
        "enabled": "boolean",
        "startCommand": "string (e.g., npm run dev)",
        "readinessUrl": "string (e.g., http://localhost:3000)",
        "endpoints": ["GET /api/health", "POST /api/users"]
      },
      "BUILD": {
        "enabled": "boolean",
        "command": "string (default: npm run build)"
      },
      "PLAN_REVIEW": {
        "backends": ["codex", "agent"]
      },
      "CODE_REVIEW": {
        "backends": ["codex", "agent"]
      },
      "LESSON_CAPTURE": { "enabled": "boolean" },
      "ISSUE_SWEEP": { "enabled": "boolean" }
    }
  }
}
```

## Support Files

Additional skill documentation, loaded on demand:

- **`setup-flow.md`** -- Project detection and AI-Assisted Setup Flow (new project initialization)
- **`autonomous-mode.md`** -- Autonomous mode, review, plan, and guided execution tiers
- **`reference.md`** -- Full CLI command and MCP tool reference
