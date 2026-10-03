---
name: story
description: Track tickets, issues, and progress for your project. Load project context, manage sessions, guide setup.
---

# Storybloq - Project Context & Session Management

storybloq tracks tickets, issues, roadmap, and handovers in a `.story/` directory so every AI coding session builds on the last instead of starting from zero.

Invocation differs by client: use `/story` in Claude Code, `$story` in Codex, or ask naturally to use the Storybloq skill.

**Client profile.** Resolve the profile once per invocation. `STORYBLOQ_CLIENT=codex` selects `{ id: "codex", displayName: "Codex", storyCommand: "$story" }`; unset, `claude`, or an unknown value selects `{ id: "claude", displayName: "Claude Code", storyCommand: "/story" }`. Render the resolved `storyCommand` in user-facing instructions. Capabilities such as structured questions, task navigation, exact-message relay, and subagents are separate exact-name runtime gates, not profile fields. This resolution governs RENDERING ONLY -- which `storyCommand` to display. Step 0's bootstrap fallback below decides the SETUP COMMAND to run when CLI/MCP are missing, using a different, inherent-identity signal (`STORYBLOQ_CLIENT` is set only after that same setup has already run once, so it cannot gate the first run of it); the two resolutions are independent and must not be unified into one.

**Client task identity.** A Codex SessionStart hook may inject `[storybloq-client-task]` with `client=codex` and an opaque `id`. Use that validated id. If the marker is absent, probe only the corresponding variable with the read-only command `printenv CODEX_THREAD_ID` or `printenv CLAUDE_CODE_SESSION_ID`; never dump the environment. IDs must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Missing or malformed identity cannot prove same-task ownership. Task identity is accidental-concurrency protection, not a security boundary, and guide ownership checks preserve the legacy fail-open behavior in the cases that legacy population actually occupies: a session with no recorded `ownerTask`, and any session whose lease has expired. There is ONE exception (ISS-899). A session that records an `ownerTask` AND holds a live, unexpired lease refuses a caller with no identity, at every guide action, and the refusal names how to establish identity plus an escape that needs none. Accepting it would make discarding your identity more permissive than presenting the wrong one. In that cell the guard and the guide now AGREE: the guard advises monitor-only and the guide refuses. Pass a known identity as `clientTaskId` on every autonomous guide call; Claude's inherited session id remains supported when the field is omitted.

**Question tool compatibility.** Whenever this skill says `AskUserQuestion`, use the client's structured question tool if it is available. If the client does not expose that tool, follow the client's higher-priority plain-text rules instead. In Codex Default mode, ask one concise free-form question, name the valid reply shapes in prose when needed, and STOP to wait for the user's reply; do not render a numbered or bulleted option list. Where a mode file fixes a question's exact closing lines (setup-flow.md's setup package), use those lines verbatim instead. Do not infer a default selection or auto-start autonomous/orchestrate mode. A same-owner COMPACT continuation is automatic; unowned-legacy COMPACT continuation is also automatic at the migration boundary. Foreign takeover, expired-session recovery, and destructive cancellation follow the explicit gates below. This fallback is allowed everywhere this file requires `AskUserQuestion`, including settings and active-session guards.

## Continuing in a session that already loaded this skill

Once this skill has run in a session, do not run it again to "reload the
ledger". A continuation reads only what changed.

1. Ordinary continuation (the same session, the same owner, no sign of
   another session on this repo): read the ticket or issue you are working,
   the git state, or `storybloq_recap`. Reuse the context already in hand.
   Do not re-enter the load sequence in Step 2 and do not re-read RULES.md
   or WORK_STRATEGIES.md unless the work needs them.
2. Tool discovery: if a `storybloq_*` tool you need is not callable,
   discover only that tool by exact name (`query: "storybloq_ticket_get"`,
   small result limit). Never re-run the whole-set discovery from the guard
   prelude.
3. Ownership uncertainty: resuming after a blocked goal, starting a new
   autonomous run, a lease that may have expired, a compaction notice, or
   any sign of another session on the same repo. Run the guard checks in
   Step 0.5 once: call `storybloq_session_guard`, read its verdict, take
   the same-owner or COMPACT fast path from the stub. Ownership is never
   settled for good inside a session; what this procedure removes is the
   redundant reload, not the ownership check.
4. Exceptional recovery: only when the guard returns a verdict the stub
   does not settle (foreign takeover, expired-session recovery, destructive
   cancellation, bootstrap self-heal), load `session-guard.md` beside this
   file and follow the procedure for that verdict alone.

## Step 0.5: Active session guard (runs BEFORE argument routing)

This guard runs on EVERY Storybloq invocation regardless of subcommand and
MUST complete before argument routing. Every exception, edge case, and
diagnostic lives in `session-guard.md`, read on demand; this stub is the
ordinary path only. Client task identity is resolved as described above
(the `[storybloq-client-task]` marker or the `printenv` probe); this guard
only consumes the result.

**Prelude.** Before step 1, call tool discovery with `query: "storybloq"`
and a high result limit, once, to force-surface deferred `storybloq_*`
tools. In Codex, use the `limit` field for that result limit. If
`storybloq_session_guard` or `storybloq_status` is still missing,
one targeted follow-up call by exact name. Skip if `ToolSearch` (or
equivalent) is unavailable or errors -- not evidence MCP itself is down.

**Whitelist.** While ownership is unresolved, permitted actions are only:
the prelude, the client task identity probe, `storybloq_session_guard`,
`storybloq_status` (`{"format":"json"}`), `storybloq_session_report`,
structured/plain-text questioning, consulting `session-guard.md` itself
when a numbered item below directs you to it, and the Codex task tools
named in `session-guard.md`'s relay procedure. No other read/write, ledger
mutation, or subcommand dispatch until the guard answers. Full semantics
and every exception's exact scope: `session-guard.md`.

1. Call `storybloq_session_guard` once, `clientTaskId` when resolved.
   Returns `{ primary, sessions, overallAction, overallRationale,
   identityUnavailable, transcriptionNotes, diagnostics, scanCompleteness,
   collisions }`. Read `transcriptionNotes` before acting on `overallAction`.
   Quote `transcriptionNotes` and `overallRationale` as they arrive (already
   rendered safely); every other field is raw data for equality checks,
   never pasted into prose. Rendering rules: `session-guard.md`. If the call
   itself fails to execute (no result, not a returned verdict), report the
   error and apply the **Step 0.5 execution-failure rule** in Step 0; the
   whitelist above authorizes that route even though ownership is still
   unresolved.
2. Act on `overallAction`. Before acting on any verdict, check
   `scanCompleteness`, `diagnostics` and `collisions`: if the scan is not
   complete or either list is non-empty, `session-guard.md`, second axis,
   before continuing.
   - **`free`** -- nothing running. Continue to argument routing.
   - **`continue`** -- your own task (same-owner). No banner, no Resume
     prompt; one concise status line.
   - **`auto-resume`** -- call `storybloq_autonomous_guide`, full
     `sessionId`, `action: "resume"`, `clientTaskId` when resolved; continue
     the pipeline. Identity unavailable: omit `clientTaskId` (unowned-legacy
     COMPACT; legacy resume, no new owner bound).
   - **`monitor-only`** -- possible foreign-live or unowned-legacy session;
     recovery is exceptional. `session-guard.md`, `monitor-only`.
   - **`offer-recovery`** -- a recoverable foreign COMPACT session.
     `session-guard.md`, `offer-recovery`.
   - **`unverifiable`** -- state, lease, identity, or population
     undetermined. `session-guard.md`, `unverifiable`.
   - **`overallAction: null`** -- multiple sessions, no combining rule.
     `session-guard.md`, mode B.
   - **guard confirmed absent** -- `session-guard.md`, mode A.
3. If the current message is an explicit reply for a different live Codex
   task, relay it: `session-guard.md`, item 3 (Codex owner-response relay).
4. If Step 2's status yields a different classification fingerprint than
   this guard's, one second `storybloq_session_guard` call is permitted:
   `session-guard.md`, item 4 (re-trigger rule).
5. Any later `storybloq_autonomous_guide` call with `action: "start"` must
   rerun this guard: `session-guard.md`, item 5 (re-trigger rule).

This guard overrides every no-confirmation rule elsewhere.

## How to Handle Arguments

`/story` is one smart command. Parse the user's intent from context:

- `/story` -> full context load (default, see Step 2 below)
- `/story auto` -> start autonomous mode (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story auto T-183 T-184 ISS-077` -> start targeted autonomous mode with ONLY those items in order (read `autonomous-mode.md`; pass the IDs as `targetWork` array in the start call)
- `/story review T-XXX` -> start review mode for a ticket (read `autonomous-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story plan T-XXX` -> start plan mode for a ticket (read `autonomous-mode.md`)
- `/story handover` -> draft a session handover from `storybloq handover template`'s scaffold (optional `--override`), then call `storybloq_handover_create` with it and a descriptive slug
- `/story snapshot` -> save project state (call `storybloq_snapshot` MCP tool)
- `/story export` -> export project for sharing. Ask the user whether to export the current phase or the full project, then call `storybloq_export` with either `phase` or `all` set
- `/story status` -> quick status (call `storybloq_status`)
- `/story health` -> tooling check on demand (call `storybloq_health`; relay each advise and its fix verbatim, skip reasons in one line, then end)
- `/story settings` -> manage project settings (read `settings.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story design` -> evaluate frontend design (read `design/design.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story design <platform>` -> evaluate for specific platform: web, ios, macos, android (read `design/design.md`)
- `/story review-lenses` -> run multi-lens review on current diff (read `review-lenses/review-lenses.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`). Note: the autonomous guide invokes lenses automatically when `reviewBackends` includes `"lenses"` -- this command is for manual/debug use.
- `/story federation` -> set up multi-repo orchestrator (read `federation-setup.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story orchestrate` -> drive the backlog as orchestrator/pen with tiered background agents (read `orchestrator-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story duet` or an owner-paired manager/worker request -> read `duet-mode.md` beside this file; prove the return route before dispatch (ISS-1155)
- `/story triage` -> read-only triage of the open issue backlog into a prioritized recommendations report (read `triage-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story bus` -> poll or coordinate with the current task-bound Storybloq Bus endpoint (read `bus-mode.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)
- `/story help` -> show all capabilities (read `reference.md` in the same directory as this skill file; if not found, tell user to run `storybloq setup --client all`)

If the user's intent doesn't match any of these, use the full context load.

## Step 0: Check Setup

Check if the storybloq MCP tools are available.

**Deferred tools note.** Some clients may register MCP tools at session start but defer exposing their full schemas to your tool list until you explicitly request them. A naive "look for `storybloq_status` in available tools" check fails on a cold session even when the MCP server is healthy and connected, routing the skill to the CLI fallback unnecessarily. The Step 0.5 guard prelude above has already force-surfaced any deferred tools by this point, so this step only needs to check the current tool list:

0. **STEP 0.5 EXECUTION-FAILURE RULE** (the single authoritative statement; every other mention of it is a reference). If a Step 0.5 tool call FAILED TO EXECUTE this invocation -- the `storybloq_session_guard` call or the mode A `storybloq_status` call -- then for the remainder of this invocation: MCP counts as unavailable no matter what your tool list shows; skip the presence test in step 1 AND the setup cases in 2 and 3; go directly to the **CLI context procedure** below; and do not retry the failed call, including during Step 2 context loading. Each clause is load-bearing. The presence test would see the still-registered tool, call MCP available, and send you back into the call that just failed. The setup cases do not apply either: they cover a missing CLI and an unregistered MCP, and this is neither -- the CLI is typically installed and MCP IS registered, it is just erroring -- so routing through them dead-ends before any context is loaded.
1. **Check for storybloq MCP tools in your tool list.** If any `storybloq_*` tools (for example `storybloq_status`) are present, MCP is available -- proceed to Step 1.
2. **If no `storybloq_*` tools are present**, try a tool discovery call with `query: "storybloq"` and a high result limit (and, if `storybloq_status` is still not listed, a targeted `query: "storybloq_status"` with a small result limit) as a safety net. If the response lists any `storybloq_*` tools, proceed to Step 1.
3. **If tool discovery is unavailable on this harness OR returned no matches**, MCP is genuinely unavailable -- continue with the setup/fallback path below. Missing tool discovery is never by itself evidence that MCP is broken; it just means the harness exposes tools differently.

**If MCP tools are NOT available:**

1. Check if the `storybloq` CLI is installed: run `storybloq --version` via Bash
2. If NOT installed:
   - Check `node --version` and `npm --version` -- both must be available
   - If Node.js is missing, tell the user to install Node.js 20+ first
   - Otherwise, with user permission, run: `npm install -g @storybloq/storybloq@latest`
   - Then run the setup command per the bootstrap-client rule below
   - Tell the user to restart the AI client and run `/story` in Claude Code or `$story` in Codex
3. If CLI IS installed but MCP not registered:
   - With user permission, run the setup command per the bootstrap-client rule below
   - Tell the user to restart the AI client and run `/story` in Claude Code or `$story` in Codex

**Bootstrap-client rule (ISS-834).** This step is reached only from WITHIN an already-loaded `$story`/`/story` session, so by the time you are following it a working skill copy has, by construction, already been read from somewhere valid -- there is never a legitimate case where this self-heal step also needs to (re)create a Codex skill copy. If `STORYBLOQ_CLIENT=codex` is set, use it (this is the ordinary case for an environment where MCP was already registered once). If it is unset -- the normal case for a fresh install, since this variable is itself set by the Codex MCP registration this bootstrap performs (it cannot gate its own first run) -- fall back to your own inherent identity: if you are running as Codex, run `storybloq setup --client codex --skip-skill`; if Claude Code, run `storybloq setup --client all`. `--skip-skill` is always correct for Codex here, regardless of whether the skill was reached via the marketplace plugin or a prior direct `storybloq setup --client codex` -- it prevents this self-heal step from creating a second, competing skill copy next to whichever one is already loaded. It does not leave a prior standalone copy stale: the CLI's version-marker auto-refresh runs before every command and keeps any already-installed skill copy current, so `--skip-skill` only prevents CREATING a copy, never refreshing one that exists.

**Important:** Always use `npm install -g` (pinned to `@latest`), never `npx`, for the CLI. The MCP server and the configured hooks call `storybloq` as a global binary; going through `npx` per invocation would add cold-start latency on every hook fire (PreCompact, SessionStart, Stop).

**CLI context procedure.** Entered from either of two places: the user does not want to set up MCP, OR the Step 0.5 execution-failure rule sends you here. It needs no MCP tool and makes no setup decision, which is why the failure rule can enter it directly. FIRST run `storybloq --version`: a registered MCP server proves nothing about a shell-visible binary, since it can be launched through a local package path, `npx`, a container, or a remote bridge. If that command fails, stop with BOTH errors reported -- the original MCP failure and the missing CLI -- and an actionable install/restart instruction; do NOT retry the MCP call. If it succeeds:
- Run `storybloq status` via Bash
- Run `storybloq recap` via Bash
- Run `storybloq handover latest` via Bash
- Read `RULES.md` if it exists in the project root
- Run `storybloq lesson digest` via Bash
- Run `git log --oneline -10`
- Then continue to Step 3 below

## Step 1: Check Project

- If `.story/` exists in the current working directory (or a parent) -> proceed to Step 2
- If no `.story/` -> read `setup-flow.md` and follow the AI-Assisted Setup Flow, whether the folder holds code, only documents, or nothing but an idea. Only when the user did not ask for setup and the folder is empty: explain storybloq and offer to set it up here

## Step 2: Load Context (Default /story Behavior)

Call these in order:

1. **Project status** -- call `storybloq_status` with `{ "format": "json", "compact": true }` (T-320: reduced payload that still carries every field this step and 1b read; dropped fields: see reference.md), passing `clientTaskId` when a task id resolved above (T-477): this session's own `arrangementPresence`/`ownerIdentity` are enriched onto its presence record as a side effect of this call, using the same identity `storybloq_session_guard` resolved in Step 0.5 -- omit it only when no task id resolved there, exactly as that step does. JSON is required, not a preference: step 1b below deduplicates the `activeSessions` and `resumableSessions` arrays and builds a per-session fingerprint out of their fields, and the Markdown response carries none of that in a form you may parse. Retain this exact payload for both reconciliation and context loading. In fallback mode A you already hold a status payload; reuse it and do not call again. Which KIND of payload decides what happens next, and both cases are supported:
   - **mode A with a JSON payload** -- reuse it, and perform step 1b below against it exactly as the typed-guard path does.
   - **mode A with a MARKDOWN payload**, which the older-server branch permits when JSON format is unavailable -- reuse that response as the Project status result and SKIP step 1b entirely. Skipping is not a concession: step 1b exists to close the window between two separate observations, and this path made exactly ONE, classifying and loading context from the same response. There is nothing to reconcile it against, and no second status call is permitted here to manufacture one. The deduplication and fingerprint rules below are therefore mandatory for the typed-guard path and for JSON-capable mode A, and do not apply to this branch.
1b. **Reconcile it against the guard verdict before doing anything with it.** FIRST apply the SAME deduplication the guard applied to the status populations, before comparing anything, and apply it the SAME WAY, because a different survivor is itself a false difference. The rule, stated here rather than referenced, since the fallback file is not readable on this path: take `activeSessions` first and `resumableSessions` second; within each, order by `sourceDir`; walk that order and keep the FIRST record for each full `sessionId`, dropping later ones. Where `sourceDir` is unavailable on an older payload, keep the server's order rather than inventing one. The guard's `sessions` are already deduplicated; comparing them against raw status would report a difference for every duplicate, twice, and end every such invocation as unverifiable. That would replace the transcribed deduplication with a fail-closed rule nothing supports. THEN compare a per-session FINGERPRINT, not just ids: `sessionId`, the surviving record's `sourceDir` where the payload carries one, which population it is in, `state`, `compactPending`, `leaseState`, and the normalized `ownerTask` client and id. `sourceDir` belongs in the fingerprint because it is what CHOSE the survivor: if a duplicate-id directory appears or disappears between the two observations and the old and new survivors happen to share every classification field, every other component matches while the surviving record -- and the directory an operator would address with `storybloq session list` -- has changed underneath the verdict. On the typed-guard path it must match. Omit it only for a legacy mode A payload that carries none, where there is no cross-observation survivor comparison to make. Those are the inputs the verdict was computed from, and a session can keep its id while every one of them changes -- an id-only check would call that a match and leave a `continue` standing over a session that is now foreign, or COMPACT, or expired. They are two separate observations of `.story/sessions/` with a gap between them, and the guard's verdict is what authorized you to get this far: if a session started in that gap, a stale `free` still reads as permission to route and mutate beside a live one, which is the ISS-554 hazard arriving through a race rather than through a rule. If the fingerprints MATCH, continue. If they DIFFER, call `storybloq_session_guard` once more and compare again against the status payload you already hold. If it now matches, act on that NEW verdict and continue from here -- do NOT restart Step 2 and do NOT call `storybloq_status` again: you already have a payload the verdict agrees with, and a third observation would reopen exactly the window this step closes. If it still does not match, stop and report the state as unverifiable: something is starting or ending sessions concurrently, and no single observation of it is trustworthy. Tell the user to run `storybloq session list`. This retry is once per INVOCATION and cannot be reset by re-entering Step 2 or by a new verdict; a second reconciliation failure ends the invocation.
1c. **Usage-cost advisory (T-501).** When status carries a `usageAdvisory` (json) or an opening "Your Claude Code auto-compact window is ..." / "This session runs a 1M-context model ..." line (md), relay that message VERBATIM once in your summary, then continue: every turn re-sends the whole context, so allowing larger contexts can increase per-turn usage as the context grows. This line is shown once per session and only here, so your relay is the only version the user gets. Never change the setting for them; `settings.md` documents it under "Auto-compact window and usage".
2. **Session recap** -- call `storybloq_recap` MCP tool
3. **Recent handovers** -- call `storybloq_handover_latest` twice: `count: 1, priming: true` (for line one's verbatim quote) and `count: 10, brief: true` (structured records plus trajectory)
4. **Development rules** -- read `RULES.md` if it exists in the project root
5. **Recent commits** -- run `git log --oneline -10` (lessons: call `storybloq_lesson_digest` on demand)
6. **Capability digest** -- `storybloq_capability_list` with `skipCheck: true`: what the project can already DO. A task matching an entry changes that capability rather than adding one. Then `storybloq_term_list` with `digest: true` for the glossary's NAMES (bounded: all of them when there are 40 or fewer, only the ones marked `core` above 40). When `omittedCore` or `omittedNonCore` is non-zero the list is not the whole glossary, so say so and use `storybloq_term_get` for anything else you need rather than assuming a word is undefined
7. **Tooling health** -- once per session call `storybloq_health`; relay each `advise` and its fix verbatim before the summary; nothing when all are ok or skip; never offer fixes

## Step 2b: Empty Scaffold Check

Using the retained status payload, check in order (`setup-flow.md` sits beside this file; if it is missing, tell the user to run `storybloq setup --client all`):

1. **Integrity guard** -- a non-empty top-level `warnings` array (JSON), or a response starting "Warning:" that contains "item(s) skipped due to data integrity issues" (Markdown), means this is NOT an empty scaffold. Tell the user to run `storybloq validate`. Continue Step 2/3 normally.
2. **Scaffold detection (JSON)** -- `data.isEmptyScaffold` is `true`, with or without code: read `setup-flow.md` and follow the AI-Assisted Setup Flow as an interrupted scaffold. After setup completes, restart Step 2 from the top.
3. **Legacy Markdown payload** (mode A, older server) -- the output contains "## Getting Started" AND shows `Tickets: 0/0 complete` + `Handovers: 0`: route exactly as in 2.

## Step 3: Present Summary

After loading context, present a summary with two parts: a conversational intro (2-3 sentences catching the user up), then structured tables showing actionable data.

**If Step 0.5 surfaces a foreign live, legacy live, or expired COMPACT session, use the session variant at the end of this section; it replaces the normal summary. A same-owner session does not use that variant.**

**Recovery token definition.** Use a raw Storybloq session token only for ambiguous COMPACT recovery or explicit administrative cancellation. `<T>` is the shortest unique prefix of the full `sessionId`, starting at eight characters and extending until unique. Guide calls always use the full `sessionId`; the token is only for typed confirmation.

If a guide call reports an existing/resumable session that was absent from status JSON, rerun the guard once. A named session may be inspected with `storybloq_session_report`, but a live session is never offered Resume. If state, lease, or full identity still cannot be determined, stop and tell the user to run `storybloq session list`; do not guess.

**Orchestrate gates (compute BEFORE composing Part 1).**

Execution order is fixed: first obtain the Part 2 `storybloq_recommend` result (with `count: 10`) and evaluate BOTH gates below; then resolve line one below; only then compose Part 1, and render Line one and Trajectory (when present), Part 1, Part 2, Part 3 in that order. The gates decide whether the `/story orchestrate` working style is surfaced at all -- this is a recommendation, never an auto-start; selecting it still routes through the explicit opt-in in `orchestrator-mode.md` Step 1. This fixed order and Parts 1-3 apply to the NORMAL summary only; the foreign/legacy/resumable variant later in this section replaces them.

- **Gate A -- capability (exact-name allowlist, fails closed).** Probe your own harness for background-orchestration tools by EXACT callable tool name or namespace-qualified identifier only. No fuzzy or keyword matching. The allowlist of names that signal capability is exactly `Workflow`, `Agent`, `Task`, `multi_agent_v1.spawn_agent`, `multi_agent_v1__spawn_agent`, and `spawn_agent` -- the documented multi-agent tool names across supported clients (`Workflow` for dynamic-workflow clients, `Agent` / `Task` for subagent clients, and the dotted or normalized `multi_agent_v1` spelling / exact `spawn_agent` for Codex subagent clients). Gate A passes only when at least one of those exact tool names is available to you in this session. A description, namespace, plugin, or skill that merely mentions agents does not pass. Any other or ambiguous tool surface fails closed: Gate A does not pass and the orchestrate option is simply not surfaced.

- **Gate B -- backlog size (deterministic).** Compute over the loaded `storybloq_recommend` result (`count: 10`, already partitioned to actionable candidates): count every `recommendations` row, ticket or issue alike; never count a row whose `kind` is `"action"`. Gate B passes when that count is 5 or more. Federation bypass: on an orchestrator project, Gate B ALSO passes when storybloq_node_list returns at least one configured node (storybloq_node_list is the source of truth for the node count). If `unreadableHandoverCount` is nonzero or `null`, disclose it before presenting Gate B's result.

Record whether both gates passed; Part 1 and Part 3 below branch on that single result.

**Line one (compute before Part 1; renders first when present).**

If the latest actionable continuation and the ranking disagree, the continuation wins. If the continuation's item is no longer actionable, say so and take the next actionable one. You may read an older handover to confirm; say which one and why.

Walk `handovers[0].continuationCandidates` in order. A `decision` candidate is usable immediately. An `item` candidate resolves via the same bounded-array-then-fallback check Part 3 always used: `recommendations` hit -> actionable (zero calls); `excluded` hit -> skip; absent from both -> one `get` with `format: "json", withActionability: true`, its `actionability.status` deciding. The first resolved candidate is line one, rendered verbatim from the `priming` raw body when it covers it, else as structured label/rationale; skipped candidates are named in a conflict note. Disclose per Gate B: a nonzero/null `unreadableHandoverCount` from `recommend` or any fallback `get` here, including a reconciliation alternative's, makes the candidate provisional.

Empty candidates with `omittedContinuationCount` 0 fall back to Ready to Work's top row. A nonzero count recovers first (raw-body re-scan, else one `handover_get`), resolves it the same way, else discloses: "N further continuation entries in the latest handover could not be recovered; treat this ranking as provisional", naming `omittedContinuationIds`.

Before finalizing line one's candidate, check the older handovers (index 1-9) already loaded in the count: 10, brief: true response, across every disposition, not only continuation, for a decision or abandoned-approach record bearing on it. Adopt a correction only if nothing newer than the cited handover has revisited or reversed it, and say which handover and why nothing later supersedes it. An alternative item resolves through the same actionability check as any candidate; an alternative decision is accepted on the citation alone. Recover missing evidence the same way as line one's own candidate.

```
## Trajectory (last 10 handovers)
- <id>: seen in <occurrenceCount> of the last 10 handovers, latest <latest> (<latestDisposition>)
```

Counts and first-seen dates are bounded by the ten-handover window; an item can be older. No handover at all: skip both blocks silently. Otherwise render Trajectory (one line per `trajectory[]` entry, in the array's own order) whenever brief's trajectory[] is non-empty regardless of line one; disclosures above still apply.

**Part 1: Conversational intro (2-3 sentences)**

Open with the project name and progress. Mention what the last session accomplished in one sentence. Note anything important (no git repo, open issues, blockers). Keep it brief -- the tables carry the detail. When BOTH orchestrate gates passed, add one sentence noting the actionable backlog is orchestrate-sized, so driving it with tiered background agents is an option (for example: "The actionable backlog is large enough to orchestrate, so I can drive it with tiered background agents instead of one ticket at a time.").

**Part 2: Structured tables (REQUIRED -- always show these, do not fold into prose)**

You MUST show the following tables after the prose intro. Do not summarize them in paragraph form.

**Ready to Work table (a ranking, not a plan)** -- call `storybloq_recommend` with `count: 10` for context-aware suggestions (the table still renders only the top 5 rows, with "(+N more)"; the full 10 rows feed the orchestrate backlog-size gate below). `storybloq_recommend` MIXES tickets and issues, so render as a neutral markdown table. The recommend table is the ranking and carries actionability. Do not open ticket or issue bodies to rank them; open the item you are about to work on.

```
## Ready to Work (ranking)
| Item | Type | Title | Context | Actionable |
|---|---|---|---|---|
| T-011 | ticket | Rate agreement conditions schema | foundation | yes |
| ISS-042 | issue | Auth token expiry bug | severity: high | yes |
```

Ticket rows show their phase in Context; issue rows show severity. Tickets are filtered to unblocked ones, but issues are ranked by severity and have no blocker model, so a listed issue may be externally blocked -- verify it is actionable before starting.

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

**Resolving "the first recommended item" (agent-facing, not rendered):** when line one resolved a candidate, it IS "the first recommended item" below -- an item keeps "Work on [ID + title]"; a decision has no id, so render "Follow up on: [decision label]" instead, still first, still `(Recommended)`. When line one resolved nothing, it's the Ready table's top row as today.

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

Render only a short intro, one compact session line, and the relevant question. Do not render line one, Trajectory, Ready to Work, Decisions Pending, Open Issues, Key Rules, or the first-session guide.

**Different live task with verified owner:**

```
T-020 is already running in another Codex task (IMPLEMENT).
```

When structured interaction is available, offer at most three choices: `Open task` (recommended when exact task navigation is callable), `Monitor`, and `Work here on something else`. Without a picker ask one free-form question naming those reply shapes in prose. `Open task` calls only `navigate_to_codex_page` or `codex_app__navigate_to_codex_page` with `ownerTask.id`. `Monitor` calls `storybloq_session_report`, summarizes once, and stops. `Work here on something else` asks for the item and permits a collaborative flow, but never starts a second autonomous session or writes inside the live session directory. Never display or offer routine live Resume. For COMPACT only, an explicit request to recover here starts a separate confirmation that the recorded owner is gone; after confirmation call guide `resume` with `clientTaskId` and `takeover: true`.

**Live legacy session without ownerTask:** for a non-COMPACT session, say that the ticket is running but task ownership cannot be verified and offer Monitor or other work. For COMPACT, ATTEMPT recovery with the current `clientTaskId` and let the guide adjudicate; do not promise the bind before it answers (ISS-899). With a resolved `clientTaskId`, a session carrying no legacy `claudeCodeSessionId` recovers and binds ownership, avoiding the wait for lease expiry; a recorded legacy id matches only a Claude caller bearing that same id, so a Codex task holding the same opaque string is still foreign. Without caller identity the guide accepts the recovery but binds nothing, which is what `bindsOwner: false` reports for the `auto-resume` verdict above. A recorded legacy id that does NOT match is refused, because inside the live-lease window that is accidental concurrency: wait out the lease, after which identity-free recovery succeeds, or, where the guide's own evidence gate reaches an owner-gone candidate, use the explicit owner-gone-candidate confirmation flow (`ownerGoneCandidateTakeover` to adopt the session, `ownerGoneCandidateCancel` to end it). That flow replaces the administrative `session stop` this cell used to name; it is gated on the evidence rather than promised, so waiting out the lease remains the route that always resolves. This is the one cell where the guard is LOOSER than the guide: it advises attempting what the guide may refuse, which is why the attempt is described here rather than an outcome promised. Do not expose a raw session token unless recovery is ambiguous.

**Expired COMPACT recovery:** show the ticket/state and offer `Resume here`, `End session`, or `Back`. `Resume here` calls the guide with the full `sessionId`, `action: "resume"`, and current `clientTaskId`; continue directly after success. `End session` requires typed `cancel <T>` confirmation before calling `action: "cancel"` with the matching full `sessionId`. Any nonmatching input aborts without a guide call. Raw tokens are allowed here because recovery is administrative and ambiguous without them.

**Explicit cancellation of a live session:** cancellation is never in the primary live-session choices. Only after the user explicitly asks to cancel, display `<T>` and require the exact lowercase text `cancel <T>` after trimming outer whitespace. On a match call `action: "cancel"` with the full session id; otherwise do nothing. Rerun the guard after successful cancellation.

**Multiple possible sessions:** do not relay, open, resume, or cancel until the user identifies the ticket/session. Monitoring remains read-only. Never write to an owning session directory from the observing task.

## Session Lifecycle

- **Snapshots** save project state for diffing. They may be auto-taken before context compaction.
- **Handovers** are session continuity documents. Create one at the end of significant sessions.
- **Recaps** show what changed since the last snapshot -- useful for understanding drift.

**Never modify or overwrite existing handover files.** Handovers are append-only historical records. Always create new handover files -- never edit, replace, or write to an existing one. If you need to correct something from a previous session, create a new handover that references the correction. This prevents accidental data loss during sessions.

Before writing a handover at the end of a session, run `storybloq snapshot` first. This ensures the next session's recap can show what changed. When client setup has installed hooks, a PreCompact hook prepares Storybloq state before context compaction.

**Context pressure (T-499).** Auto-compaction fires at about 0.925 x `autoCompactWindow` (measured, model-independent), and nothing in the client tells the model how close it is. `storybloq session intel` (CLI) and `storybloq_session_intel` (MCP) return the current context tokens, the expected auto-compact point with its provenance (`measured-session`, `measured-project`, `setting`, `model`, or `unknown`) and a state: `ok`, `advisory` (70%), `imperative` (60k tokens of headroom, or a larger per-turn jump allowance, or 95%, whichever first) or `compact-needed` (98%). Both work without `.story/`; `sessionId` or `transcript` inspects another session read-only. Storybloq also pushes the state on Claude Code: an `advisory`, `imperative` or `compact-needed` banner is prefixed to MCP tool results and appended to CLI output for the caller's own live session; at `imperative` and at `compact-needed` the next prompt carries an `additionalContext` line from the UserPromptSubmit hook, and the autonomous guide adds a directive. At `imperative` write a handover now and keep working in the same turn: one handover per compaction; the line does not repeat within 10 minutes; a stamp that could not bind still counts. At `compact-needed` write none. Cadence ruling: handover before auto-compaction, after a major item completes, and after a batch of issues or one big issue resolves; the pushed line is advice, not one handover per message; never stop at a percentage; one continue after a handover is allowed; no status demands to a worker above 90 percent. The banner never appears for an unbound caller (no `CLAUDE_PID`, an ended session id after `/clear`, or a mismatched process era); `session intel` still answers at reduced confidence. `.story/status.json` carries a coarse `tokenPressure` projection of the autonomous owner's state. Configure under a root-level `sessionIntel` block in `.story/config.json` (see the schema below); the hooks themselves can be disabled machine-wide with `~/.claude/storybloq/config.json` `{"sessionIntel": {"enabled": false}}`. Launch the MCP server from the checkout the hooks actually run in (ISS-1185): a git worktree whose presence record differs from the MCP server's own root falls back to a bounded `git worktree list --porcelain` scan to find it, but that fallback is not a substitute for matching roots.

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

## Rulings

A ruling is a decision that binds an item: an owner's call, an architecture decision, a gate outcome. Rulings reach agents by CITATION, never by paste. A decision pasted into a plan, a handover or a prompt is a copy, and copies drift; a citation means every agent working that item reads one record, and reads the version that is current now.

**Recording one.** `storybloq ruling create --text "<verbatim>" --attribution <source> --date <YYYY-MM-DD> --cites T-123` records the ruling AND adds its id to that item's `citesRulings`, in one transaction. `--cites` is repeatable, takes tickets or issues, and never replaces an item's existing citations. The text is byte-verbatim: no markdown cleanup, no editing inside the quote. `--attribution` is a CLAIM asserted by whoever records it, not something storybloq verifies. The message that tells another agent about the ruling carries the id and a one-line summary, nothing more; the record is what the agent reads.

**Reading one.** `storybloq ticket get T-123` shows the item's cited rulings resolved to their current versions, and `storybloq ruling get <id>` returns a single record. Cited rulings are also delivered into the plan-review, code-review and lens context packets automatically, so a reviewer sees them without being handed them. Delivery follows the ITEM: a lens review takes it from the session, or from `target` when there is no session, and a review that names no item is told nothing rather than told there is nothing.

**Naming one in a plan.** A plan must name the CURRENT id of every ruling its item cites; the plan-pin gate refuses a plan that omits one, and refuses outright if any citation cannot be resolved to a single current ruling. Current is the word that matters: once a ruling has been superseded the item still cites the OLD id, and the one that binds is the successor. Name the current id. Naming the cited id as well is fine.

That gate checks the id is MENTIONED. It does not check that the plan follows the ruling, and it cannot: an id copied out of a truncation marker satisfies it. Whether the work honours the decision is what the review is for.

**Superseding, and duplicate decisions.** `storybloq ruling supersede <old> --text "<new verbatim>" --attribution <source> --date <YYYY-MM-DD>` records the replacement and links it; `--with <id>` links a ruling you already have. Two rulings may not both supersede the same predecessor -- that is a branch, no single ruling is current, and the plan gate refuses the item until it is resolved. Before superseding anything, read the item's cited rulings for a duplicate of it first, so the number of copies is known before the first supersede is written. If the SAME decision was recorded more than once, supersede EVERY copy, one superseding ruling per copy: a ruling supersedes at most one predecessor, so a single new record cannot retire two duplicates, and any copy left current is a copy some item can still cite and some agent can still be shown.

**Proposing, accepting, withdrawing.** `storybloq ruling propose --text "<verbatim>" --attribution <source> --date <YYYY-MM-DD> --for T-123` records a proposal: it binds nothing, no item cites it and no gate enforces it; agents working the item see it beside their citations, marked not enforced. `storybloq ruling accept <id> --revision <digest> --attribution <source> --date <YYYY-MM-DD>` records who ruled and cites the ruling from every `--for` item in one transaction; the digest comes from `ruling get` and is the payload as reviewed, not proof of who approved, so an edited proposal is refused. `storybloq ruling withdraw <id>` retires a proposal; an accepted ruling is superseded, never withdrawn. A proposal that names `--proposes-to-supersede` revokes nothing until accepted. Narrative flags (`--context`, `--alternatives`, `--consequences`, `--reconsider-when`) are recorded beside the verbatim text, never inside it. Boundary for 1.15 readers: they parse every record but show a proposal as an ordinary current ruling and cannot see acceptance, withdrawal or narrative; a team project refuses ruling writes until `storybloq team setup` runs on a 1.16 CLI.

**Checking coverage.** `storybloq validate` reports, as info, every current ruling that no ticket or issue cites: it will never reach an agent working an item. When the ruling scan or the item load was incomplete it says so and claims nothing either way, rather than guessing from a partial picture.

## Managing Tickets and Issues

Ticket and issue create/update operations are available via both CLI and MCP tools. Delete remains CLI-only.

CLI examples:
- `storybloq ticket create --title "..." --type task --phase p0`
- `storybloq ticket update T-001 --status complete`
- `storybloq issue create --title "..." --severity high --impact "..." --created-by "reviewer" --dedupe-key "review-42:finding-3" --source-ref '{"path":"src/file.ts","startLine":42,"revision":"<commit-sha>","reviewId":"review-42"}'`

MCP examples:
- `storybloq_ticket_create` with `title`, `type`, and optional `phase` (omitted: the current phase when the project has phases; null: unphased), `description`, `blockedBy`, `parentTicket`
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

## Glossary

The glossary answers what a word means HERE and what it is NOT: a canonical term, a one-line definition, the distinction that matters, and the capability it belongs to. Step 2 loads names only; `storybloq_term_get` with an `id` fetches one entry.

**Advisory, always.** A match SUGGESTS. It renames nothing, rewrites nothing, and refuses nothing, and no gate consults it. `storybloq_term_match` with `text` set to an item's title and description tells you which terms a brief should define.

**Filing one.** `storybloq term add --id term-<slug> --term "<word>" --definition "<one sentence>" --distinction "<what it is NOT>" --capability cap-<slug>`. One word belongs to one entry, so a term or alias another entry already owns is refused naming that entry. An entry with no distinction or no capability link is THIN: `term check` and `storybloq validate` warn, never error.

## Settings (/story settings)

When the user runs `/story settings` or asks about project config, read `settings.md` in the same directory as this skill file for the full flow (current-config display, the AskUserQuestion change menu, and the complete config schema reference); if not found, tell the user to run `storybloq setup --client all`.

## Support Files

Additional skill documentation, loaded on demand:

- **`setup-flow.md`** -- Project detection and AI-Assisted Setup Flow (new project initialization)
- **`settings.md`** -- Full `/story settings` flow: current-config display, AskUserQuestion change menu, config schema reference
- **`session-guard.md`** -- Active session guard: exceptional verdicts (foreign takeover, expired-COMPACT recovery, unverifiable identity, collisions) and full whitelist semantics
- **`session-guard-fallback.md`** -- Legacy session-guard path for a confirmed-absent guard tool (mode A) and multi-session conflicts with no `overallAction` (mode B)
- **`duet-mode.md`** -- Duet mode: owner-paired manager/worker pairing, return-route proof before dispatch
- **`bus-mode.md`** -- Storybloq Bus mode: polling and coordinating with the current task-bound bus endpoint
- **`autonomous-mode.md`** -- Autonomous mode, review, plan, and guided execution tiers
- **`reference.md`** -- Full CLI command and MCP tool reference
- **`review-contract-template.md`** -- The REVIEW.md review contract template, written verbatim by `setup-flow.md`
- **`setup-review-schema.json`** -- The `--output-schema` file for `setup-flow.md`'s native Codex plan review
- **`design/design.md`** -- Frontend design evaluation and implementation guidance, with platform references in `design/references/`
- **`federation-setup.md`** -- Federation setup flow for multi-repo orchestrator initialization
- **`orchestrator-mode.md`** -- Orchestrator mode: tiered multi-agent backlog drive with enrichment pass, session-model review gates, and batched ships
- **`triage-mode.md`** -- Read-only issue triage: verify findings at HEAD, dedupe, root-cause grouping, prioritized recommendations report
- **`review-lenses/review-lenses.md`** -- Multi-lens review orchestrator (9 specialized parallel reviewers); prompt bodies and merge semantics live in the @storybloq/lenses package
