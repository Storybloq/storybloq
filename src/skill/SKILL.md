---
name: story
description: Track tickets, issues, and progress for your project. Load project context, manage sessions, guide setup.
---

# /story -- Project Context & Session Management

storybloq tracks tickets, issues, roadmap, and handovers in a `.story/` directory so every AI coding session builds on the last instead of starting from zero.

## Step 0.5: Active session guard (runs BEFORE argument routing)

This guard runs on EVERY `/story` invocation regardless of subcommand (`/story`, `/story auto`, `/story review`, `/story plan`, `/story guided`, `/story handover`, `/story snapshot`, `/story export`, `/story design`, `/story review-lenses`, `/story settings`, `/story help`, `/story status`, etc.). It MUST complete before ANY other action in this invocation.

**Guard prelude: force-surface deferred MCP tools.** Before running step 1 of this guard, make a single `ToolSearch` call with `query: "storybloq"` (max_results: 20). On Claude Code desktop/web, `storybloq_*` tool schemas are deferred — without this prelude the subsequent `storybloq_status` call in step 1 is not dispatchable. The prelude is explicitly part of the guard, not a separate pre-guard step; it satisfies the whitelist below.

- If `ToolSearch` itself is not available or returns an error on this harness, SKIP the prelude and continue to step 1. Do NOT treat a missing `ToolSearch` tool as evidence that MCP is unavailable — step 1's `storybloq_status` call will either succeed (MCP already surfaced) or its failure will route the skill to the Step 0 setup/CLI-fallback path below.
- The prelude is idempotent: on terminal CLI sessions where `storybloq_*` tools are already in the base list, it simply returns the same tool set.

**Whitelist semantics (not blacklist).** While the guard is unresolved, the ONLY actions permitted are: (a) the guard's `ToolSearch` prelude described above, (b) the guard's own `storybloq_status` call as defined in step 1 below, (c) reading the surfaced session metadata, and (d) the guard's `AskUserQuestion` flow. NO other MCP call, file write, file read, or skill-file dispatch is permitted -- this includes `storybloq_handover_create`, `storybloq_snapshot`, `storybloq_export`, `storybloq_ticket_create`, `storybloq_ticket_update`, `storybloq_issue_*`, `storybloq_note_*`, `storybloq_autonomous_guide` with any action other than the user-authorized `resume` / `cancel`, and any read or write inside `.story/sessions/<active-sessionId>/`. Subcommand-specific dispatch (to `autonomous-mode.md`, `design/design.md`, `review-lenses/review-lenses.md`, `setup-flow.md`, `reference.md`, etc.) is also blocked. The guard is a hard gate, not a soft warning.

1. Call `storybloq_status` once. If the output contains a `## Active Sessions` heading, OR any subsequent guide call in this invocation fails with an "existing session" / "resumable session" error, you must STOP and surface the situation to the user:
   - Extract for each surfaced session: the **full `sessionId`** (required for every guide call), plus state, mode, and ticket (if any). Derive the displayed token `<T>` from the full `sessionId` per the Step 3 definition. If `storybloq_status` exposes only a truncated/rendered ID and no way to recover the full `sessionId` for a surfaced session (and the guide-error fallback in Step 3 also does not name a full `sessionId`), STOP. Do NOT offer Resume or Cancel. Tell the user: "A session appears to be active but its full `sessionId` cannot be recovered from the skill's tools. Please inspect `.story/sessions/` or run `storybloq session list` before retrying."
   - Render one **Active Autonomous Session** block per session (format defined in Step 3).
   - End with the session-aware `AskUserQuestion` defined in Step 3.
   - Until the user chooses, no other action is permitted (see whitelist semantics above).
   - Do NOT write any file under `.story/sessions/<active-sessionId>/`. That directory is owned by the running instance and any cross-instance write races with the owner.

2. If there are no active sessions AND no subsequent "existing/resumable session" errors from any MCP call in this invocation, proceed to the "How to Handle Arguments" routing table and the rest of the normal flow. Reuse the `storybloq_status` response from this step when Step 2 asks for it; do NOT call `storybloq_status` again in the same invocation **except** in the Step 3 guide-error augmentation path explicitly described there.

3. **Re-trigger rule for `start`.** Any later `storybloq_autonomous_guide` call with `action: "start"` in the SAME `/story` invocation MUST re-run Step 0.5 from the top first, regardless of any prior user choices in this invocation. The guard's prior resolution authorizes only the specific Resume/Cancel/Other branch chosen at that moment; it never authorizes starting a new autonomous session later.

This guard has precedence over every "do not ask the user" rule elsewhere in this skill file and in `autonomous-mode.md`. Foreign-session resume or cancel ALWAYS requires explicit user confirmation through `AskUserQuestion`.

## How to Handle Arguments

`/story` is one smart command. Parse the user's intent from context:

- `/story` -> full context load (default, see Step 2 below)
- `/story auto` -> start autonomous mode (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup-skill`)
- `/story auto T-183 T-184 ISS-077` -> start targeted autonomous mode with ONLY those items in order (read `autonomous-mode.md`; pass the IDs as `targetWork` array in the start call)
- `/story review T-XXX` -> start review mode for a ticket (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup-skill`)
- `/story plan T-XXX` -> start plan mode for a ticket (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup-skill`)
- `/story handover` -> draft a session handover. Summarize the session's work, then call `storybloq_handover_create` with the drafted content and a descriptive slug
- `/story snapshot` -> save project state (call `storybloq_snapshot` MCP tool)
- `/story export` -> export project for sharing. Ask the user whether to export the current phase or the full project, then call `storybloq_export` with either `phase` or `all` set
- `/story status` -> quick status check (call `storybloq_status` MCP tool)
- `/story settings` -> manage project settings (see Settings section below)
- `/story design` -> evaluate frontend design (read `design/design.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup-skill`)
- `/story design <platform>` -> evaluate for specific platform: web, ios, macos, android (read `design/design.md` in the same directory as this skill file)
- `/story review-lenses` -> run multi-lens review on current diff (read `review-lenses/review-lenses.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup-skill`). Note: the autonomous guide invokes lenses automatically when `reviewBackends` includes `"lenses"` -- this command is for manual/debug use.
- `/story help` -> show all capabilities (read `reference.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup-skill`)

If the user's intent doesn't match any of these, use the full context load.

## Step 0: Check Setup

Check if the storybloq MCP tools are available.

**Deferred tools note (Claude Code app).** Claude Code desktop/web may register MCP tools at session start but defer exposing their full schemas to your tool list until you explicitly request them. A naive "look for `storybloq_status` in available tools" check fails on a cold session even when the MCP server is healthy and connected, routing the skill to the CLI fallback unnecessarily. The Step 0.5 guard prelude above (the `ToolSearch` call) has already force-surfaced any deferred tools by this point, so this step only needs to check the current tool list:

1. **Check for storybloq MCP tools in your tool list.** If any `storybloq_*` tools (for example `storybloq_status`) are present, MCP is available -- proceed to Step 1.
2. **If no `storybloq_*` tools are present**, try a second `ToolSearch` call with `query: "storybloq"` (max_results: 20) as a safety net in case the guard prelude was skipped or failed silently. If the response lists any `storybloq_*` tools, proceed to Step 1.
3. **If `ToolSearch` is unavailable on this harness OR returned no matches**, MCP is genuinely unavailable -- continue with the setup/fallback path below. Missing `ToolSearch` is never by itself evidence that MCP is broken; it just means the harness exposes tools differently.

**If MCP tools are NOT available:**

1. Check if the `storybloq` CLI is installed: run `storybloq --version` via Bash
2. If NOT installed:
   - Check `node --version` and `npm --version` -- both must be available
   - If Node.js is missing, tell the user to install Node.js 20+ first
   - Otherwise, with user permission, run: `npm install -g @storybloq/storybloq`
   - Then run: `claude mcp add storybloq -s user -- storybloq --mcp`
   - Tell the user to restart Claude Code and run `/story` again
3. If CLI IS installed but MCP not registered:
   - With user permission, run: `claude mcp add storybloq -s user -- storybloq --mcp`
   - Tell the user to restart Claude Code and run `/story` again

**Important:** Always use `npm install -g`, never `npx`, for the CLI. The MCP server needs the global binary.

**If MCP tools are unavailable and user doesn't want to set up**, fall back to CLI mode:
- Run `storybloq status` via Bash
- Run `storybloq recap` via Bash
- Run `storybloq handover latest` via Bash
- Read `RULES.md` if it exists in the project root
- Run `storybloq lesson digest` via Bash
- Run `git log --oneline -10`
- Then continue to Step 3 below

## Step 1: Check Project

- If `.story/` exists in the current working directory (or a parent) -> proceed to Step 2
- If no `.story/` but project indicators exist (code, manifest, .git) -> read `setup-flow.md` in the same directory as this skill file and follow the AI-Assisted Setup Flow (if not found, tell user to run `storybloq setup-skill`)
- If no `.story/` and no project indicators -> explain what storybloq is and suggest navigating to a project

## Step 2: Load Context (Default /story Behavior)

Call these in order:

1. **Project status** -- call `storybloq_status` MCP tool
2. **Session recap** -- call `storybloq_recap` MCP tool (shows changes since last snapshot)
3. **Recent handovers** -- call `storybloq_handover_latest` MCP tool with `count: 3` (last 3 sessions' context -- ensures reasoning behind recent decisions is preserved, not just the latest session's state)
4. **Development rules** -- read `RULES.md` if it exists in the project root
5. **Lessons learned** -- call `storybloq_lesson_digest` MCP tool
6. **Recent commits** -- run `git log --oneline -10`

## Step 2b: Empty Scaffold Check

After `storybloq_status` returns, check in order:

1. **Integrity guard** -- if the response starts with "Warning:" and contains "item(s) skipped due to data integrity issues", this is NOT an empty scaffold. Tell the user to run `storybloq validate`. Continue Step 2/3 normally.
2. **Scaffold detection** -- check BOTH: output contains "## Getting Started" AND shows `Tickets: 0/0 complete` + `Handovers: 0`. If met AND the project has code indicators (git history, package manifest, source files), read `setup-flow.md` in the same directory as this skill file and follow the AI-Assisted Setup Flow (section 1b). After setup completes, restart Step 2 from the top (the project now has data to load).
3. **Empty without code** -- if scaffold detected but no code indicators (truly empty directory), continue to Step 3 which will show: "Your project is set up but has no tickets yet. Would you like me to help you create your first phase and tickets?"

## Step 3: Present Summary

After loading context, present a summary with two parts: a conversational intro (2-3 sentences catching the user up), then structured tables showing actionable data.

**IF Step 0.5 surfaced any active session, see the "Active session variant" at the end of this section -- it REPLACES the normal summary. Do NOT render Ready to Work, Decisions Pending, Open Issues, Key Rules, or the First session guide in that case.**

**Session token definition.** Throughout this section and in `autonomous-mode.md`, the symbol `<T>` (or `<T1>`, `<T2>`, ...) refers to the **session token**: the shortest prefix of a session's full `sessionId` that is unique among all sessions surfaced by the current guard invocation. Start with `min(8, len(sessionId))` characters; if any two surfaced sessions share that same prefix, extend the displayed prefix for ALL sessions in this invocation until every token is distinct. The full `sessionId` always satisfies uniqueness and is the ultimate fallback.

All guide calls (`action: "resume"`, `action: "cancel"`) MUST pass the full `sessionId`, not `<T>`. The token exists so the user can type a short readable confirmation; the agent resolves the token back to the full `sessionId` by matching it against the surfaced session list before calling the guide.

If the guard fired via a guide error path, apply these rules in order:

1. If the error names exactly ONE blocking full `sessionId`, use that full `sessionId` directly as the sole session token and render `Resume <full-sessionId>` / `Cancel <full-sessionId>` from the error. Do NOT depend on `storybloq_status` for this path -- the blocking session may be stale or resumable and absent from the status scan while still being what the guide error refers to.
2. Optionally, re-call `storybloq_status` to augment the banner with state/ticket/mode details. If the status response includes the same sessionId, use the enriched info for the banner; if not, render the banner with only the sessionId and the error's description.
3. If the error does NOT name a resolvable full `sessionId` AND `storybloq_status` returns no matching session, STOP. Do NOT offer any Resume or Cancel action in that state. Tell the user: "A session appears to block this action but cannot be safely identified. Please inspect `.story/sessions/` or run `storybloq session list` before retrying."

**Part 1: Conversational intro (2-3 sentences)**

Open with the project name and progress. Mention what the last session accomplished in one sentence. Note anything important (no git repo, open issues, blockers). Keep it brief -- the tables carry the detail.

**Part 2: Structured tables (REQUIRED -- always show these, do not fold into prose)**

You MUST show the following tables after the prose intro. Do not summarize them in paragraph form.

**Ready to Work table** -- call `storybloq_recommend` for context-aware suggestions. Always render as a markdown table:

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
  /story auto T-XXX ISS-YYY  Autonomous mode scoped to specific tickets/issues
  /story review T-XXX        Review code you already wrote
  /story plan T-XXX          Plan a ticket with review rounds
  /story design              Evaluate frontend against platform best practices
  /story review-lenses       Run multi-lens review on current plan or diff
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

**Active session variant (REPLACES the normal summary when Step 0.5 surfaced any active session):**

Render ONLY:

1. The conversational intro (2-3 sentences). Do NOT reference Ready to Work or recommend a ticket.
2. One Active Autonomous Session banner per surfaced session, in this format:

```
## Active Autonomous Session
Session `<T>` is running in <state> state, ticket <ticketId>: <title> (or "no ticket").
```

   (Where `<T>` is the session token defined at the top of Step 3.)

3. The session-aware `AskUserQuestion` described below.

Do NOT render Ready to Work, Decisions Pending, Open Issues, Key Rules, or the First session guide in this variant. If the user wants a specific non-session ticket, they will name it via the free-form "Other" option.

**AskUserQuestion -- single active session** (let `<T>` = that session's token, typically 8 characters since the single-session case is always unique):

- "Monitor -- read-only, don't interfere (Recommended)"
  -> READ-ONLY PAUSE (no guide calls unless the nested follow-up question below selects Resume or Cancel). Re-render the Active Autonomous Session banner only. Do NOT show Ready to Work. Do NOT call the guide. Do NOT write to the session's directory. End with a follow-up `AskUserQuestion` whose options are exactly: "Resume `<T>`", "Cancel `<T>`", and "Back" (returns to the previous question without action). The guard remains in force on any subsequent `/story` invocation.
- "Resume `<T>` -- take over (only safe if the owning instance is gone)"
  -> call `storybloq_autonomous_guide` with `action: "resume"` and the full `sessionId` that `<T>` resolves to. The guide arbitrates the lease and will fail if another instance still holds it. This selection IS the explicit user authorization that `autonomous-mode.md`'s recovery instructions require FOR THAT SPECIFIC `sessionId` ONLY.
- "Cancel `<T>` -- destructive"
  -> Ask the user to type `cancel <T>` to confirm. **Match rules:** trim leading/trailing whitespace, then require an exact lowercase match of the literal string `cancel <T>` where `<T>` matches the displayed token character-for-character (case-sensitive). Any other input -- including `Cancel <T>`, `cancel  <T>` (extra whitespace inside), `cancel <full-sessionId>` when the displayed token was a prefix, or `back` -- aborts the cancel flow and returns to the guard's top-level question without calling the guide. On a matching confirmation, call the guide with `action: "cancel"` and the full `sessionId` that `<T>` resolves to. Only after the cancel succeeds may the agent proceed to normal `/story` flow.
- (Other always available) -- user may type a specific ticket ID to work on. If they do:
  - Treat the named ticket as explicitly user-chosen.
  - Proceed with a **collaborative single-ticket flow**: read the ticket via `storybloq_ticket_get`, discuss, and work on it directly with the user in this session.
  - Do NOT call `storybloq_autonomous_guide` with `action: "start"` as part of accepting this branch. Starting a new autonomous session while another is live defeats the guard. If the user later asks to "go autonomous on this ticket" mid-flow, the re-trigger rule in Step 0.5 item 3 applies: re-run Step 0.5 from the top before any `action: "start"` call.
  - Do NOT write to any `.story/sessions/<active-sessionId>/` directory. Normal project-level writes (tickets, issues, code) are fine.
  - Do NOT auto-pick or auto-suggest a ticket; act only on the name the user typed.

**AskUserQuestion -- multiple active sessions** (tokens `<T1>`, `<T2>`, ... -- each token is the shortest prefix unique across this guard invocation):

Render one banner per session, then ask a single `AskUserQuestion` with one Resume option and one Cancel option per session:

- "Monitor -- read-only, don't interfere (Recommended)"
  -> Same READ-ONLY PAUSE as the single-session case, but the nested follow-up question offers "Resume `<T1>`", "Cancel `<T1>`", "Resume `<T2>`", "Cancel `<T2>`", ..., "Back".
- "Resume `<T1>`" / "Resume `<T2>`" / ...
  -> Each targets exactly the named session; call the guide with `action: "resume"` and the full `sessionId` that the token resolves to. Authorization is scoped to that `sessionId` ONLY.
- "Cancel `<T1>`" / "Cancel `<T2>`" / ...
  -> Each targets exactly the named session. Require typed `cancel <Ti>` confirmation before calling `action: "cancel"` with the matching full `sessionId`. The same match rules apply as single-session Cancel (trim outer whitespace, exact lowercase match of `cancel <Ti>` with `<Ti>` matching its displayed token character-for-character; any deviation aborts without a guide call).
- (Other) -- free-form. User may type a non-session ticket ID to work on. Same rules as the single-session "Other" branch: collaborative single-ticket flow, no new autonomous-session start as part of accepting this branch, no writes to any active-session directory. Any later `action: "start"` request triggers the Step 0.5 re-trigger rule (item 3).

**Post-action behavior depends on the action type (Resume vs Cancel):**

- After a successful `Resume <Ti>`: do NOT re-run Step 0.5 as a prerequisite to continuing INTO that resumed session. The user's selection authorizes that specific full `sessionId` **only for the duration of driving that resumed session**. Hand off to `autonomous-mode.md` and drive the resumed session through its normal pipeline. **Deterministic re-entry rules (apply in either branch):**
  1. If a later guide call in the resumed flow surfaces a DIFFERENT blocking `sessionId` via the guide-error path, Step 0.5 re-fires immediately for that new session.
  2. If the resumed session ends, completes, errors out, or otherwise yields control back to general `/story` flow in the same invocation -- AND/OR if the agent is asked to perform any non-resume action against this project (other tickets, snapshots, handovers, exports, settings, design, lenses, help, status, or starting a new autonomous session) -- re-run Step 0.5 from the top BEFORE acting. This is unconditional in BOTH the single-session and multi-session branches; do not guess whether other sessions still exist. Authorization for the just-resumed `sessionId` does not extend to anything else.
- After a successful `Cancel <Ti>`: re-run Step 0.5 from the top before returning to normal `/story` flow. If other active or resumable sessions remain, stay in the Active session variant and render it again with the updated session list. Only proceed to the normal summary once Step 0.5 surfaces zero active sessions and zero guide-error paths.

Never auto-select. Never skip the question. Never write to any active session's directory until one of these choices is made.

## Session Lifecycle

- **Snapshots** save project state for diffing. They may be auto-taken before context compaction.
- **Handovers** are session continuity documents. Create one at the end of significant sessions.
- **Recaps** show what changed since the last snapshot -- useful for understanding drift.

**Never modify or overwrite existing handover files.** Handovers are append-only historical records. Always create new handover files -- never edit, replace, or write to an existing one. If you need to correct something from a previous session, create a new handover that references the correction. This prevents accidental data loss during sessions.

Before writing a handover at the end of a session, run `storybloq snapshot` first. This ensures the next session's recap can show what changed. If `setup-skill` has been run, a PreCompact hook auto-takes snapshots before context compaction.

**Lessons** capture non-obvious process learnings that should carry forward across sessions. At the end of a significant session, review what you learned and create lessons via `storybloq_lesson_create` for:
- Patterns that worked (or failed) and why
- Architecture decisions with non-obvious rationale
- Tool/framework quirks discovered during implementation
- Process improvements (review workflows, testing strategies)

Don't duplicate what's already in the handover -- lessons are structured, tagged, and ranked. Handovers are narrative. Use `storybloq_lesson_digest` to check existing lessons before creating duplicates. Use `storybloq_lesson_reinforce` when an existing lesson proves true again.

## Ticket and Issue Discipline

**Tickets** are planned work -- features, tasks, refactors. They represent intentional, scoped commitments.

**Ticket types:**
- `task` -- Implementation work: building features, writing code, fixing bugs, refactoring.
- `feature` -- A user-facing capability or significant new functionality. Larger scope than a task.
- `chore` -- Maintenance, publishing, documentation, cleanup. No functional change to the product.

**Issues** are discovered problems -- bugs, inconsistencies, gaps, risks found during work. If you're not sure whether something is a ticket or an issue, make it an issue. It can be promoted to a ticket later.

When working on a task and you encounter a bug, inconsistency, or improvement opportunity that is out of scope for the current ticket, create an issue using `storybloq issue create` (CLI) with a clear title, severity, and impact description. Don't fix it in the current task, don't ignore it -- log it. This keeps the issue tracker growing organically and ensures nothing discovered during work is lost.

When starting work on a ticket, update its status to `inprogress`. When done, update to `complete` in the same commit as the code change.

**Frontend design guidance:** When working on UI or frontend tickets, read `design/design.md` in the same directory as this skill file for design principles and platform-specific best practices. Follow its priority order (clarity > hierarchy > platform correctness > accessibility > state completeness) and load the relevant platform reference. This applies to any ticket involving components, layouts, styling, or visual design.

**Plan and code review:** Before implementing any plan, review it with the multi-lens review system. Read `review-lenses/review-lenses.md` in the same directory as this skill file and follow its workflow. This applies whether you used `/story plan`, native plan mode, or wrote the plan manually. The lens system runs 8 specialized reviewers in parallel (clean code, security, error handling, performance, API design, concurrency, test quality, accessibility) and synthesizes findings into a single verdict. After implementation, review the code diff the same way before committing.

## Managing Tickets and Issues

Ticket and issue create/update operations are available via both CLI and MCP tools. Delete remains CLI-only.

CLI examples:
- `storybloq ticket create --title "..." --type task --phase p0`
- `storybloq ticket update T-001 --status complete`
- `storybloq issue create --title "..." --severity high --impact "..."`

MCP examples:
- `storybloq_ticket_create` with `title`, `type`, and optional `phase`, `description`, `blockedBy`, `parentTicket`
- `storybloq_ticket_update` with `id` and optional `status`, `title`, `order`, `description`, `phase`, `parentTicket`
- `storybloq_issue_create` with `title`, `severity`, `impact`, and optional `components`, `relatedTickets`, `location`, `phase`
- `storybloq_issue_update` with `id` and optional `status`, `title`, `severity`, `impact`, `resolution`, `components`, `relatedTickets`, `location`

Read operations (list, get, next, blocked) are available via both CLI and MCP.

## Notes

**Notes** are unstructured brainstorming artifacts -- ideas, design thinking, "what if" explorations. Use notes when the content doesn't fit tickets (planned work) or issues (discovered problems).

Create notes via CLI: `storybloq note create --content "..." --tags idea`

Create notes via MCP: `storybloq_note_create` with `content`, optional `title` and `tags`.

List, get, and update notes via MCP: `storybloq_note_list`, `storybloq_note_get`, `storybloq_note_update`. Delete remains CLI-only: `storybloq note delete <id>`.

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

Note: this sets the top-level `reviewBackends`. If the config has per-stage overrides in `stages.PLAN_REVIEW.backends` or `stages.CODE_REVIEW.backends`, those take precedence. When displaying settings, check for per-stage overrides and show them if present.

**Handover frequency:**
```
AskUserQuestion: "Write a handover after every N tickets?"
header: "Handover"
options: "Every ticket", "Every 3 tickets (default)", "Every 5 tickets", "Manual only"
```

**Step 4: Apply changes.** Run via Bash:
```
storybloq config set-overrides --json '<constructed JSON>'
```

**IMPORTANT:** The `--json` argument takes only the `recipeOverrides` object, NOT the full config. Top-level fields (version, project, type, language) are NOT settable via this command.
```
# Correct:
storybloq config set-overrides --json '{"maxTicketsPerSession": 10}'

# Correct (stages):
storybloq config set-overrides --json '{"stages": {"VERIFY": {"enabled": true}}}'

# WRONG -- do not include top-level fields:
storybloq config set-overrides --json '{"version": 2, "project": "foo"}'
```

Show a confirmation of what changed, then ask if the user wants to change anything else or is done. If done, return to normal session.

### Config Schema Reference

Do NOT search source code for this. The full config.json schema is shown below. Only the `recipeOverrides` section is settable via `config set-overrides`.

```json
{
  "version": 2,
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
    "maxTicketsPerSession": "number (0 = unlimited, default: 0)",
    "compactThreshold": "string (high/medium/low, default: high)",
    "reviewBackends": ["codex", "agent"],
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
    },
    "lensConfig": {
      "lenses": "\"auto\" | string[] (default: \"auto\")",
      "maxLenses": "number (1-8, default: 8)",
      "lensTimeout": "number | { default: number, opus: number } (default: { default: 60, opus: 120 })",
      "findingBudget": "number (default: 10)",
      "confidenceFloor": "number 0-1 (default: 0.6)",
      "tokenBudgetPerLens": "number (default: 32000)",
      "hotPaths": "string[] (glob patterns for Performance lens, default: [])",
      "lensModels": "Record<string, string> (default: { default: sonnet, security: opus, concurrency: opus })"
    },
    "blockingPolicy": {
      "neverBlock": "string[] (lens names that never produce blocking findings, default: [])",
      "alwaysBlock": "string[] (categories that always block, default: [injection, auth-bypass, hardcoded-secrets])",
      "planReviewBlockingLenses": "string[] (default: [security, error-handling])"
    },
    "requireSecretsGate": "boolean (default: false, require detect-secrets for lens reviews)",
    "requireAccessibility": "boolean (default: false, make accessibility findings blocking)"
  }
}
```

## Support Files

Additional skill documentation, loaded on demand:

- **`setup-flow.md`** -- Project detection and AI-Assisted Setup Flow (new project initialization)
- **`autonomous-mode.md`** -- Autonomous mode, review, plan, and guided execution tiers
- **`reference.md`** -- Full CLI command and MCP tool reference
- **`design/design.md`** -- Frontend design evaluation and implementation guidance, with platform references in `design/references/`
- **`review-lenses/review-lenses.md`** -- Multi-lens review orchestrator (8 specialized parallel reviewers), with lens prompts in `review-lenses/references/`
