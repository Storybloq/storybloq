---
name: story
description: Track tickets, issues, and progress for your project. Load project context, manage sessions, guide setup.
---

# Storybloq - Project Context & Session Management

storybloq tracks tickets, issues, roadmap, and handovers in a `.story/` directory so every AI coding session builds on the last instead of starting from zero.

Invocation differs by client: use `/story` in Claude Code, `$story` in Codex, or ask naturally to use the Storybloq skill.

**Client profile.** Resolve the profile once per invocation. `STORYBLOQ_CLIENT=codex` selects `{ id: "codex", displayName: "Codex", storyCommand: "$story" }`; unset, `claude`, or an unknown value selects `{ id: "claude", displayName: "Claude Code", storyCommand: "/story" }`. Render the resolved `storyCommand` in user-facing instructions. Capabilities such as structured questions, task navigation, exact-message relay, and subagents are separate exact-name runtime gates, not profile fields.

**Client task identity.** A Codex SessionStart hook may inject `[storybloq-client-task]` with `client=codex` and an opaque `id`. Use that validated id. If the marker is absent, probe only the corresponding variable with the read-only command `printenv CODEX_THREAD_ID` or `printenv CLAUDE_CODE_SESSION_ID`; never dump the environment. IDs must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Missing or malformed identity never blocks the legacy workflow, but it cannot prove same-task ownership. Task identity is accidental-concurrency protection, not a security boundary; when identity is unavailable, guide ownership checks preserve the legacy fail-open behavior. Pass a known identity as `clientTaskId` on every autonomous guide call; Claude's inherited session id remains supported when the field is omitted.

**Question tool compatibility.** Whenever this skill says `AskUserQuestion`, use the client's structured question tool if it is available. If the client does not expose that tool, follow the client's higher-priority plain-text rules instead. In Codex Default mode, ask one concise free-form question, name the valid reply shapes in prose when needed, and STOP to wait for the user's reply; do not render a numbered or bulleted option list. Do not infer a default selection or auto-start autonomous/orchestrate mode. A same-owner COMPACT continuation is automatic; unowned-legacy COMPACT continuation is also automatic at the migration boundary. Foreign takeover, expired-session recovery, and destructive cancellation follow the explicit gates below. This fallback is allowed everywhere this file requires `AskUserQuestion`, including settings and active-session guards.

## Step 0.5: Active session guard (runs BEFORE argument routing)

This guard runs on EVERY Storybloq invocation regardless of subcommand. It MUST complete before argument routing.

**Guard prelude: force-surface deferred MCP tools.** Before running step 1 of this guard, call the client's tool discovery/search tool (`ToolSearch`, `tool_search`, or equivalent) with `query: "storybloq"` and a result limit high enough to surface the full `storybloq_*` tool set (currently ~53 tools) in one call. In Codex, use the `limit` field for that result limit. A smaller cap can truncate alphabetically and drop `storybloq_status`. On clients with deferred MCP schemas, this prelude makes the subsequent `storybloq_status` call in step 1 dispatchable. If `storybloq_status` is still not available after that call, make a second targeted tool discovery call with `query: "storybloq_status"` and a small result limit, which ranks that exact tool to the top, before concluding anything about MCP availability. The prelude is explicitly part of the guard, not a separate pre-guard step; it satisfies the whitelist below.

- If `ToolSearch` itself is not available or returns an error on this harness, SKIP the prelude and continue to step 1. Do NOT treat a missing `ToolSearch` tool as evidence that MCP is unavailable — step 1's `storybloq_status` call will either succeed (MCP already surfaced) or its failure will route the skill to the Step 0 setup/CLI-fallback path below.
- The prelude is idempotent: on terminal CLI sessions where `storybloq_*` tools are already in the base list, it simply returns the same tool set.

**Whitelist semantics (not blacklist).** While ownership is unresolved, the ONLY permitted actions are the tool-discovery prelude, the exact identity probe above, `storybloq_status` with `{ "format": "json" }`, `storybloq_session_report`, structured/plain-text questioning, and the exact Codex task tools named below. `storybloq_autonomous_guide` is allowed only for automatic same-owner or unowned-legacy COMPACT continuation, explicit expired-COMPACT recovery, confirmed-owner-gone COMPACT takeover, or typed cancellation. The five `storybloq_bus_*` tools are a narrow exception only for an explicit bus invocation or an injected endpoint marker with pending work; they require the current task-bound endpoint and never authorize autonomous-session mutation. A confirmed Bus review finding may also use one idempotent `storybloq_issue_create` call with `dedupeKey`, `sourceRefs`, and reviewer attribution before sending its issue notice. No other file read/write, ledger mutation, subcommand dispatch, or direct access to `.story/sessions/` is permitted. Monitoring is read-only and ends after the report; it never opens a nested Resume/Cancel prompt.

1. Call `storybloq_status` once with `{ "format": "json" }`. Read both `activeSessions` and `resumableSessions`; deduplicate by full `sessionId`. Each record may include `ownerTask`, `leaseState`, `leaseExpiresAt`, and `compactPending`. Both arrays are always present and are empty when there are no sessions, so an EMPTY array means "no sessions" and a MISSING key means the server predates that contract; treat the missing case as unverifiable and fall back as below rather than reading it as "none". If JSON format is unavailable from an older server, call Markdown status once and treat a live non-COMPACT session as unverifiable legacy (Monitor or other work only). For a COMPACT session, follow a SessionStart resume instruction only after the user asks to continue; the guide remains authoritative. Reuse this status result during context loading.

2. Compare each session's `ownerTask` with the resolved client profile and current task id:
   - **Same owner, non-COMPACT:** this is the current autonomous task, not a foreign session. Do not show an Active Autonomous Session banner and do not ask for Resume. Process owner replies such as `Ratify T-020` directly. On a normal context load, one concise line such as `Continuing T-020 in IMPLEMENT` is enough.
   - **Same owner, COMPACT:** call `storybloq_autonomous_guide` automatically with the full `sessionId`, `action: "resume"`, and `clientTaskId`, then continue the pipeline. Do not ask for another confirmation.
   - **Different live owner, non-COMPACT:** never call or offer `resume`. Follow the foreign-task UX in Step 3.
   - **Different live owner, COMPACT:** do not resume automatically. Prefer Open task or Monitor. If the user explicitly asks to recover here, confirm that the recorded owner task is gone, then call `resume` once with the full `sessionId`, current `clientTaskId`, and `takeover: true`.
   - **Live legacy session without `ownerTask`, non-COMPACT:** ownership cannot be verified. Offer only Monitor or work here on something else.
   - **Live legacy session without `ownerTask`, COMPACT:** call `resume` with the full `sessionId` and current `clientTaskId`; this migration recovery binds the current task. If task identity is unavailable, the guide preserves legacy resume behavior without binding.
   - **Expired COMPACT session:** offer Resume here, End session, or Back. Resume only after explicit selection, passing the full `sessionId` and current `clientTaskId`; successful recovery rebinds ownership. End session enters the typed cancellation flow.

3. **Codex owner-response relay.** When the current user message is an explicit response for a different live Codex task, relay it automatically if it names that task's active ticket/session or answers a prior guard prompt that identified exactly one session. Use only the exact callable tool `send_message_to_thread` or its namespace-qualified `codex_app__send_message_to_thread`, with the owner's task id and the user's exact message. Send it once, perform no Storybloq call or write, then respond exactly: `Sent to T-020's running task.` (substitute the ticket). If multiple sessions could match, ask the user to name the ticket/session first. If relay is unavailable or fails, use only `navigate_to_codex_page` or `codex_app__navigate_to_codex_page` to open the owner task and tell the user to repeat the response there; otherwise give one concise manual-switch instruction.

4. **Re-trigger rule for start.** Any later `storybloq_autonomous_guide` call with `action: "start"` must rerun this guard. Choosing Monitor or other work never authorizes a second autonomous session.

This guard overrides every no-confirmation rule elsewhere. A non-COMPACT live lease is never taken over; a foreign COMPACT lease requires explicit confirmation that its recorded owner is gone. Cancellation is absent from the primary picker and is exposed only after an explicit cancel request, followed by exact typed confirmation `cancel <token>`.

## How to Handle Arguments

`/story` is one smart command. Parse the user's intent from context:

- `/story` -> full context load (default, see Step 2 below)
- `/story auto` -> start autonomous mode (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story auto T-183 T-184 ISS-077` -> start targeted autonomous mode with ONLY those items in order (read `autonomous-mode.md`; pass the IDs as `targetWork` array in the start call)
- `/story review T-XXX` -> start review mode for a ticket (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story plan T-XXX` -> start plan mode for a ticket (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story handover` -> draft a session handover. Summarize the session's work, then call `storybloq_handover_create` with the drafted content and a descriptive slug
- `/story snapshot` -> save project state (call `storybloq_snapshot` MCP tool)
- `/story export` -> export project for sharing. Ask the user whether to export the current phase or the full project, then call `storybloq_export` with either `phase` or `all` set
- `/story status` -> quick status check (call `storybloq_status` MCP tool)
- `/story settings` -> manage project settings (see Settings section below)
- `/story design` -> evaluate frontend design (read `design/design.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story design <platform>` -> evaluate for specific platform: web, ios, macos, android (read `design/design.md` in the same directory as this skill file)
- `/story review-lenses` -> run multi-lens review on current diff (read `review-lenses/review-lenses.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`). Note: the autonomous guide invokes lenses automatically when `reviewBackends` includes `"lenses"` -- this command is for manual/debug use.
- `/story federation` -> set up multi-repo orchestrator (read `federation-setup.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story orchestrate` -> drive the backlog as orchestrator/pen with tiered background agents (read `orchestrator-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story bus` -> poll or coordinate with the current task-bound Storybloq Bus endpoint (read `bus-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story help` -> show all capabilities (read `reference.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)

If the user's intent doesn't match any of these, use the full context load.

## Step 0: Check Setup

Check if the storybloq MCP tools are available.

**Deferred tools note.** Some clients may register MCP tools at session start but defer exposing their full schemas to your tool list until you explicitly request them. A naive "look for `storybloq_status` in available tools" check fails on a cold session even when the MCP server is healthy and connected, routing the skill to the CLI fallback unnecessarily. The Step 0.5 guard prelude above has already force-surfaced any deferred tools by this point, so this step only needs to check the current tool list:

1. **Check for storybloq MCP tools in your tool list.** If any `storybloq_*` tools (for example `storybloq_status`) are present, MCP is available -- proceed to Step 1.
2. **If no `storybloq_*` tools are present**, try a tool discovery call with `query: "storybloq"` and a high result limit (and, if `storybloq_status` is still not listed, a targeted `query: "storybloq_status"` with a small result limit) as a safety net in case the guard prelude was skipped or failed silently. If the response lists any `storybloq_*` tools, proceed to Step 1.
3. **If tool discovery is unavailable on this harness OR returned no matches**, MCP is genuinely unavailable -- continue with the setup/fallback path below. Missing tool discovery is never by itself evidence that MCP is broken; it just means the harness exposes tools differently.

**If MCP tools are NOT available:**

1. Check if the `storybloq` CLI is installed: run `storybloq --version` via Bash
2. If NOT installed:
   - Check `node --version` and `npm --version` -- both must be available
   - If Node.js is missing, tell the user to install Node.js 20+ first
   - Otherwise, with user permission, run: `npm install -g @storybloq/storybloq@latest`
   - Then run: `storybloq setup --client all`
   - Tell the user to restart the AI client and run `/story` in Claude Code or `$story` in Codex
3. If CLI IS installed but MCP not registered:
   - With user permission, run: `storybloq setup --client all`
   - Tell the user to restart the AI client and run `/story` in Claude Code or `$story` in Codex

**Important:** Always use `npm install -g` (pinned to `@latest`), never `npx`, for the CLI. The MCP server and the configured hooks call `storybloq` as a global binary; going through `npx` per invocation would add cold-start latency on every hook fire (PreCompact, SessionStart, Stop).

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
- If no `.story/` but project indicators exist (code, manifest, .git) -> read `setup-flow.md` in the same directory as this skill file and follow the AI-Assisted Setup Flow (if not found, tell user to run `storybloq setup --client all`)
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

**If Step 0.5 surfaces a foreign live, legacy live, or expired COMPACT session, use the session variant at the end of this section; it replaces the normal summary. A same-owner session does not use that variant.**

**Recovery token definition.** Use a raw Storybloq session token only for ambiguous COMPACT recovery or explicit administrative cancellation. `<T>` is the shortest unique prefix of the full `sessionId`, starting at eight characters and extending until unique. Guide calls always use the full `sessionId`; the token is only for typed confirmation.

If a guide call reports an existing/resumable session that was absent from status JSON, rerun the guard once. A named session may be inspected with `storybloq_session_report`, but a live session is never offered Resume. If state, lease, or full identity still cannot be determined, stop and tell the user to run `storybloq session list`; do not guess.

**Orchestrate gates (compute BEFORE composing Part 1).**

Execution order is fixed: first obtain the Part 2 `storybloq_recommend` result (with `count: 10`) and evaluate BOTH gates below; only then compose Part 1, and render Part 1, Part 2, Part 3 in that order. The gates decide whether the `/story orchestrate` working style is surfaced at all -- this is a recommendation, never an auto-start; selecting it still routes through the explicit opt-in in `orchestrator-mode.md` Step 1.

- **Gate A -- capability (exact-name allowlist, fails closed).** Probe your own harness for background-orchestration tools by EXACT callable tool name or namespace-qualified identifier only. No fuzzy or keyword matching. The allowlist of names that signal capability is exactly `Workflow`, `Agent`, `Task`, `multi_agent_v1.spawn_agent`, `multi_agent_v1__spawn_agent`, and `spawn_agent` -- the documented multi-agent tool names across supported clients (`Workflow` for dynamic-workflow clients, `Agent` / `Task` for subagent clients, and the dotted or normalized `multi_agent_v1` spelling / exact `spawn_agent` for Codex subagent clients). Gate A passes only when at least one of those exact tool names is available to you in this session. A description, namespace, plugin, or skill that merely mentions agents does not pass. Any other or ambiguous tool surface fails closed: Gate A does not pass and the orchestrate option is simply not surfaced.

- **Gate B -- backlog size (deterministic).** Compute over the loaded `storybloq_recommend` result (`count: 10`): count every row whose `kind` is `"ticket"`; for every row whose `kind` is `"issue"`, call `storybloq_issue_get` and count it ONLY when its status is `open` or `inprogress` AND no explicit blocker or owner-gated marker appears in its `impact` or `resolution` fields; never count a row whose `kind` is `"action"`. Gate B passes when that count is 5 or more. Federation bypass: on an orchestrator project, Gate B ALSO passes when storybloq_node_list returns at least one configured node (storybloq_node_list is the source of truth for the node count).

Record whether both gates passed; Part 1 and Part 3 below branch on that single result.

**Part 1: Conversational intro (2-3 sentences)**

Open with the project name and progress. Mention what the last session accomplished in one sentence. Note anything important (no git repo, open issues, blockers). Keep it brief -- the tables carry the detail. When BOTH orchestrate gates passed, add one sentence noting the actionable backlog is orchestrate-sized, so driving it with tiered background agents is an option (for example: "The actionable backlog is large enough to orchestrate, so I can drive it with tiered background agents instead of one ticket at a time.").

**Part 2: Structured tables (REQUIRED -- always show these, do not fold into prose)**

You MUST show the following tables after the prose intro. Do not summarize them in paragraph form.

**Ready to Work table** -- call `storybloq_recommend` with `count: 10` for context-aware suggestions (the table still renders only the top 5 rows, with "(+N more)"; the full 10 rows feed the orchestrate backlog-size gate below). `storybloq_recommend` MIXES tickets and issues, so render as a neutral markdown table:

```
## Ready to Work
| Item    | Type   | Title                            | Context        |
|---------|--------|----------------------------------|----------------|
| T-011   | ticket | Rate agreement conditions schema | foundation     |
| ISS-042 | issue  | Auth token expiry bug            | severity: high |
```

Ticket rows show their phase in Context; issue rows show severity. Show up to 5 recommendations. If more exist, note "(+N more)". Note: tickets are filtered to unblocked ones, but issues are ranked by severity and have no blocker model, so a listed issue may be externally blocked -- verify it is actionable before starting.

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

End with `AskUserQuestion`. Which variant depends on the orchestrate-gate result computed above.

Default state (the orchestrate gates did NOT both pass):
- question: "What would you like to do?"
- header: "Next"
- options:
  - "Work on [first recommended item ID + title] (Recommended)" -- the top item from the Ready table, whether ticket or issue
  - "Something else" -- I'll ask what you have in mind
  - "Autonomous mode" -- I'll pick tickets, plan, review, build, commit, and loop until done
- (Other always available for free-text input)

Autonomous mode is last -- most users want to collaborate, not hand off control.

Orchestrate variant (ONLY when Gate A and Gate B BOTH passed): render exactly THREE explicit options and DROP "Something else" (the question tool's built-in free-text Other path covers it):
- "Work on [first recommended item ID + title]" -- the top item from the Ready table, whether ticket or issue
- "Orchestrate the backlog" -- drive the backlog with tiered background agents: enrichment pass, review gates, batched ships
- "Autonomous mode" -- I'll pick tickets, plan, review, build, commit, and loop until done

Note (agent-facing meta-rules, do NOT render as option text): "Orchestrate the backlog" sits directly above "Autonomous mode". Mark exactly one option `(Recommended)`: give it to "Orchestrate the backlog" ONLY when the backlog is large AND there is no single obvious in-progress thread; otherwise the top item keeps `(Recommended)` and orchestrate is offered without the marker. Never exceed three explicit options in this state. Selecting "Orchestrate the backlog" routes to `orchestrator-mode.md` with Step 1 unchanged (node guard + blast-radius confirmation), so the recommendation never bypasses the explicit opt-in.

**Foreign/legacy/resumable session variant:**

Render only a short intro, one compact session line, and the relevant question. Do not render Ready to Work, Decisions Pending, Open Issues, Key Rules, or the first-session guide.

**Different live task with verified owner:**

```
T-020 is already running in another Codex task (IMPLEMENT).
```

When structured interaction is available, offer at most three choices: `Open task` (recommended when exact task navigation is callable), `Monitor`, and `Work here on something else`. Without a picker ask one free-form question naming those reply shapes in prose. `Open task` calls only `navigate_to_codex_page` or `codex_app__navigate_to_codex_page` with `ownerTask.id`. `Monitor` calls `storybloq_session_report`, summarizes once, and stops. `Work here on something else` asks for the item and permits a collaborative flow, but never starts a second autonomous session or writes inside the live session directory. Never display or offer routine live Resume. For COMPACT only, an explicit request to recover here starts a separate confirmation that the recorded owner is gone; after confirmation call guide `resume` with `clientTaskId` and `takeover: true`.

**Live legacy session without ownerTask:** for a non-COMPACT session, say that the ticket is running but task ownership cannot be verified and offer Monitor or other work. For COMPACT, recover the existing session with the current `clientTaskId`; this binds ownership and avoids waiting for lease expiry. Do not expose a raw session token unless recovery is ambiguous.

**Expired COMPACT recovery:** show the ticket/state and offer `Resume here`, `End session`, or `Back`. `Resume here` calls the guide with the full `sessionId`, `action: "resume"`, and current `clientTaskId`; continue directly after success. `End session` requires typed `cancel <T>` confirmation before calling `action: "cancel"` with the matching full `sessionId`. Any nonmatching input aborts without a guide call. Raw tokens are allowed here because recovery is administrative and ambiguous without them.

**Explicit cancellation of a live session:** cancellation is never in the primary live-session choices. Only after the user explicitly asks to cancel, display `<T>` and require the exact lowercase text `cancel <T>` after trimming outer whitespace. On a match call `action: "cancel"` with the full session id; otherwise do nothing. Rerun the guard after successful cancellation.

**Multiple possible sessions:** do not relay, open, resume, or cancel until the user identifies the ticket/session. Monitoring remains read-only. Never write to an owning session directory from the observing task.

## Session Lifecycle

- **Snapshots** save project state for diffing. They may be auto-taken before context compaction.
- **Handovers** are session continuity documents. Create one at the end of significant sessions.
- **Recaps** show what changed since the last snapshot -- useful for understanding drift.

**Never modify or overwrite existing handover files.** Handovers are append-only historical records. Always create new handover files -- never edit, replace, or write to an existing one. If you need to correct something from a previous session, create a new handover that references the correction. This prevents accidental data loss during sessions.

Before writing a handover at the end of a session, run `storybloq snapshot` first. This ensures the next session's recap can show what changed. When client setup has installed hooks, a PreCompact hook prepares Storybloq state before context compaction.

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

When working on a task and you encounter a bug, inconsistency, or improvement opportunity that is out of scope for the current ticket, create an issue using `storybloq issue create` (CLI) with a clear title, severity, and impact description. Don't fix it in the current task, don't ignore it -- log it. This keeps the issue tracker growing organically and ensures nothing discovered during work is lost. When orchestrating (`/story orchestrate`), anything the orchestrator files for later execution must be portable enough for the lowest permitted execution tier, so every ticket or issue you file is born in the enrichment template documented in `orchestrator-mode.md`, not a bare paragraph.

**External and manual review filing:** Confirmed findings belong in the ledger directly, without a human copy/paste relay. Search for an existing issue first, then call `storybloq_issue_create` with reviewer attribution in `createdBy`, a stable retry identity in `dedupeKey`, and structured `sourceRefs` containing the review ID plus the reviewed path, line range, and revision when known. A good cross-agent key is `<review-id>:<finding-id>`; retries with the same key return the existing issue. Keep the new issue `open`. The implementing agent owns status and resolution. File uncertain design questions as notes or ask the owner instead of presenting them as confirmed defects. Never store source excerpts in custom metadata; Storybloq captures a line-range hash.

When starting work on a ticket, update its status to `inprogress`. When done, update to `complete` in the same commit as the code change.

**Frontend design guidance:** When working on UI or frontend tickets, read `design/design.md` in the same directory as this skill file for design principles and platform-specific best practices. Follow its priority order (clarity > hierarchy > platform correctness > accessibility > state completeness) and load the relevant platform reference. This applies to any ticket involving components, layouts, styling, or visual design.

**Plan and code review:** Before implementing any plan, review it with the multi-lens review system. Read `review-lenses/review-lenses.md` in the same directory as this skill file and follow its workflow. This applies whether you used `/story plan`, native plan mode, or wrote the plan manually. The lens system runs 9 specialized reviewers in parallel (security, error handling, clean code, concurrency, performance, API design, test quality, accessibility, data safety) via the @storybloq/lenses registry and merges findings programmatically into a single verdict. After implementation, review the code diff the same way before committing.

## Managing Tickets and Issues

Ticket and issue create/update operations are available via both CLI and MCP tools. Delete remains CLI-only.

CLI examples:
- `storybloq ticket create --title "..." --type task --phase p0`
- `storybloq ticket update T-001 --status complete`
- `storybloq issue create --title "..." --severity high --impact "..." --created-by "reviewer" --dedupe-key "review-42:finding-3" --source-ref '{"path":"src/file.ts","startLine":42,"revision":"<commit-sha>","reviewId":"review-42"}'`

MCP examples:
- `storybloq_ticket_create` with `title`, `type`, and optional `phase`, `description`, `blockedBy`, `parentTicket`
- `storybloq_ticket_update` with `id` and optional `status`, `title`, `order`, `description`, `phase`, `parentTicket`
- `storybloq_issue_create` with `title`, `severity`, `impact`, and optional `components`, `relatedTickets`, `location`, `sourceRefs`, `dedupeKey`, `createdBy`, `phase`
- `storybloq_issue_update` with `id` and optional `status`, `title`, `severity`, `impact`, `resolution`, `components`, `relatedTickets`, `location`, `sourceRefs`

Read operations (list, get, next, blocked) are available via both CLI and MCP.

## Team Mode

Some projects have team mode enabled (`.story/config.json` contains `"team": { "enabled": true }`). No special workflow is needed: the CLI and MCP tools enforce the guard rails on their own (claims on in-progress tickets, structured three-way merges of `.story/` JSON, write-blocking while records carry unresolved `_conflicts`). When a command refuses to proceed, two recoveries cover almost every case: if writes are blocked by unresolved conflicts, run `storybloq conflicts list` and `storybloq resolve <id>` (also `resolve config` / `resolve roadmap`); if a merge produced duplicate display ids because both branches created items, run `storybloq reconcile`. The full merge model, the local-vs-git-refs id allocator tradeoff, and migration notes are documented in the storybloq package README under "Team mode".

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
| Code review round cap | 12 (minimum still follows ticket risk) |
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

Note: this sets the top-level `reviewBackends`. If the config has per-stage overrides in `stages.PLAN_REVIEW.backends` or `stages.CODE_REVIEW.backends`, those take precedence. `stages.CODE_REVIEW.maxReviewRounds` defaults to 12 and is clamped upward to the ticket-risk minimum; `0` explicitly disables the cap. When displaying settings, show both per-stage backends and this cap when present.

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
  "type": "string (npm, cargo, pip, orchestrator, etc.)",
  "language": "string",
  "features": {
    "tickets": true, "issues": true, "handovers": true,
    "roadmap": true, "reviews": true
  },
  "recipe": "string (default: coding)",
  "recipeOverrides": {
    "maxTicketsPerSession": "number (0 = unlimited, default: 0)",
    "compactThreshold": "string (medium/high/critical; selects pressure limits and rotation trigger; default: high)",
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
        "backends": ["codex", "agent"],
        "maxReviewRounds": "number (default: 12; 0 disables; otherwise effective cap is max(value, required risk rounds))"
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
  },
  "nodes": {
    "<name (lowercase, alphanumeric, hyphens, underscores)>": {
      "path": "string (required, existing directory -- absolute or ~/relative)",
      "stack": "string (optional, max 40 chars, e.g. npm, swift-spm)",
      "role": "string (optional, max 120 chars, human-readable purpose)",
      "summary": "string (optional, max 200 chars, status snapshot)",
      "health": "green | yellow | red | grey (default: grey)",
      "dependsOn": "string[] (node names, build-order deps, validated for cycles)",
      "kind": "string (optional, max 32 chars, e.g. library, service, app)",
      "links": [{"to": "node-name", "via": "string (optional, max 60 chars, integration description)"}]
    }
  },
  "federation": {
    "allowNodeWrites": "boolean (default: false, permits orchestrator MCP tools to write to node .story/ dirs)"
  }
}
```

## Support Files

Additional skill documentation, loaded on demand:

- **`setup-flow.md`** -- Project detection and AI-Assisted Setup Flow (new project initialization)
- **`autonomous-mode.md`** -- Autonomous mode, review, plan, and guided execution tiers
- **`reference.md`** -- Full CLI command and MCP tool reference
- **`design/design.md`** -- Frontend design evaluation and implementation guidance, with platform references in `design/references/`
- **`federation-setup.md`** -- Federation setup flow for multi-repo orchestrator initialization
- **`orchestrator-mode.md`** -- Orchestrator mode: tiered multi-agent backlog drive with enrichment pass, session-model review gates, and batched ships
- **`review-lenses/review-lenses.md`** -- Multi-lens review orchestrator (9 specialized parallel reviewers); prompt bodies and merge semantics live in the @storybloq/lenses package
