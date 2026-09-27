# Autonomous & Tiered Modes

This file is referenced from SKILL.md for `/story auto` / `$story auto`, review, plan, and guided commands.

## Autonomous Mode

`/story auto` in Claude Code, or `$story auto` in Codex, starts an autonomous coding session. The guide picks tickets, plans, reviews, implements, and commits -- looping until all tickets are done or the session limit is reached.

**How it works:**

1. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "clientTaskId": "<known-current-task-id>" }` (omit `clientTaskId` only when unavailable)
2. The guide returns an instruction with ticket candidates and exact JSON for the next call
3. Follow every instruction exactly. Call the guide back after each step.
4. The guide advances through: PICK_TICKET -> PLAN -> PLAN_REVIEW -> IMPLEMENT -> CODE_REVIEW -> FINALIZE -> KNOWLEDGE_REVIEW -> COMPLETE -> loop
5. Continue until the guide returns SESSION_END

While it runs, the Claude Code ledger dashboard tags its In progress card (`T-001 [Code]`), or the heading if none matches, with no footer line; see the storybloq README.

**Ticket review depth:** Optional ticket metadata `reviewRisk` accepts `low`, `medium`, or `high` and sets the minimum PLAN_REVIEW depth to one, two, or three rounds. Set it with `storybloq ticket meta set T-001 reviewRisk '"high"'` or `storybloq_ticket_meta_set`. Legacy `risk` metadata remains compatible. Malformed explicit values fail closed to high, and risk metadata never skips a review stage.

**Review effort:** Optional `reviewEffort` metadata on a ticket or issue accepts `off`, `light`, `standard`, or `thorough` and sets how hard BOTH review stages work for that item. Set it with `storybloq ticket meta set T-001 reviewEffort '"light"'` or `storybloq_ticket_meta_set`. Unset, it is derived per item: risk `high` maps to `thorough`, a `chore` at risk `low` maps to `light`, everything else maps to `standard` (issues map severity `low` or `medium` to `light`, else `standard`). A session-wide default can be set with `recipeOverrides.reviewEffort` or the `reviewEffort` argument on the start call, and an item's own value beats both. Malformed explicit values fail closed to `standard`, so a typo never buys less review than you have today -- the opposite direction from `reviewRisk`, which fails closed to `high`, because both point away from accidentally reviewing less. `reviewRisk` never skips a review stage; only `reviewEffort: off` does, and every level is disclosed on the review instruction, in a `review_effort_resolved` event, on the round record, and in `storybloq session-report`. The dial never overrides an explicit `stages.PLAN_REVIEW`/`stages.CODE_REVIEW` knob.

### Review effort levels

| Level | Plan review | Code review |
|-------|-------------|-------------|
| `off` | skipped | skipped (a plan-mode or review-mode session still runs its own review, at `light`) |
| `light` | 1 round minimum; prefers one fast reviewer | 1 round minimum, cap 4; prefers one fast reviewer |
| `standard` | risk-derived rounds | risk-derived rounds, cap 12 |
| `thorough` | at least 2 rounds | at least 2 rounds |

"Prefers" is exact: the dial narrows WITHIN the configured backends and never adds one, so a per-stage `backends` list you set explicitly is left alone, and a lenses-only project keeps its lens fan-out because there is no other reviewer to fall back to.

`off` is the ONLY level that removes a review stage from the walk. `light` lowers the depth of both stages and never skips either one, which matters because `light` is reachable automatically through size mapping: a heuristic may make a review cheaper, but it never makes a gate disappear.

The fix-then-re-review rule holds at every level. At `off` no review runs, so no change request can exist and the rule is vacuously satisfied; at `light` the landing rule below is what keeps it true under a lower cap.

### Recording what actually ran

When you report a review round or `implementation_done`, you may name the model and tier behind it (`reviewerModel` / `reviewerTier`, `implementerModel` / `implementerTier`). All are optional and NONE is ever inferred. Omitted, a round records `source: "unknown"`, `evidence: "none"`: truthful, where a guessed model name reads as fact to whoever analyses the session later. With no `reviewerSource`/`implementerSource`, a named model still records `source: "unknown"`, never a pin. Send `explicit-pin` or `session-default` only when you know which; a guess inflates the pinned count.

What you pass is recorded as INTENT (`evidence: "configured"`); only a value a backend itself reported may be sent as `reviewerEvidence: "observed"`. The implementer pin binds to the item's own attempt, so a later item cannot inherit it.

**Bridge review gate (ISS-1282).** A codex-bridge round counts only when its receipt proves it: `tier: "max"`, never a model name; code by `base`/`head` range in a standalone clone, at most 300 changed lines each, chained per file from the item baseline to the working tree with no gaps or repeats; the summary opens `REVIEWED: <path or [range]> (~N changed lines)` (plan: `REVIEWED: plan.md (~N lines)`); report `reviewReceipts`, one per call, each with that call's `models[]` verbatim and `sessionId` (plan: also `planSha256`). A receipt is ATTESTED, not authenticated: its models, sessionId and planSha256 are a CLAIM asserted by the reporting agent, not a record the bridge issued. Observed must be Codex, or Gemini under the accepted ruling at `recipeOverrides.reviewGate.geminiRuling`.

**Frontend design:** If the current ticket involves UI, frontend, components, layouts, or styling, read `design/design.md` in the same directory as the skill file for design principles. Load the relevant platform reference from `design/references/`. Apply the priority order (clarity > hierarchy > platform correctness > accessibility > state completeness) during both planning and implementation.

## Context brief

Every PLAN entry (the pick, a plan-mode start, a replan and drift recovery) writes `.story/sessions/<id>/context-brief.md` and points the instruction at it. Read it before planning. It has tiers, and only one binds:

- **Cited rulings** bind: the rulings the item cites (`ticket update --cites-ruling`).
- **Suggested rulings** bind nothing: accepted rulings discovery matched by scope tag, path or capability, each with the reason it was suggested. If one applies, cite it on the item; the plan reviewer is told a suggested ruling that applies and is not cited is a finding.
- **Proposed** rulings bind nothing until accepted.
- **Capabilities** are where inspection starts, not a substitute for reading the code; **Stale or unavailable** entries are not candidates. **Terms** carry the distinction that matters.
- **Disclosure** says what discovery could not see: no match is not evidence that nothing exists.

The plan must carry an EXISTING line, `EXISTING: <reference> ; reuse | extend | replace ; <reason>` or `EXISTING: none found within <modules inspected>; ...`. A bare `EXISTING: none` is sent back.

If a ruling the brief delivered is revised, superseded, withdrawn or newly accepted mid-session, the guide says "governing context changed" and the plan must name that id before it is accepted; CODE_REVIEW sends the item back to PLAN until it is. When a manifest cannot be verified the guide reports "recovery required"; after checking, `storybloq brief --rebase <sessionId> <item> --reason "<why>"` adopts the provisional context. `storybloq brief <id>` prints the same brief on demand.

## Knowledge review

After FINALIZE commits an item, KNOWLEDGE_REVIEW asks what it did to the project's knowledge: capabilities, glossary terms, notes and rulings. The instruction's evidence (changed paths, stale capability entries first, matched capabilities and terms, cited rulings) is display only; every check reads git. Report `knowledge_reviewed` with `knowledgeImpact`: `outcome` `none` or `uncertain` with a `reason`, or `impacts`, each with a disposition:

- `applied`: the record is updated and its check is current.
- `pending`: a marker (`capability defer` / `term defer`, the note naming the id), or for a note an open issue that names it.
- `needs-decision`: a ruling conflict, filed as a proposal (`storybloq_ruling_propose`); the accepted ruling is never rewritten.

Ledger changes go in `.story/`-only commits listed in `maintenanceCommits`, with nothing under `.story/` left uncommitted. Code committed after the item needs `knowledge_rebase` first. A report the ledger does not back is retried with the reason; a branch reset past the item is `knowledge_diverged`. The item completes only when the review is accepted. Each accepted review is stored once (a replayed report changes nothing), shown on COMPLETE, and written into the handover's "Knowledge impact" section and `storybloq session-report`. Compaction, a usage-limit stop and drift resume into the stage like any other.

## Precedence: task-aware active-session guard

Before any guide call that could start, resume, or cancel a session, run SKILL.md Step 0.5. Ownership determines the action:

- A matching `ownerTask` is the current pipeline. Continue normally; after COMPACT, resume automatically with the full `sessionId` and current `clientTaskId`.
- An unowned legacy COMPACT session resumes with the current `clientTaskId`; the guide binds it during recovery. A non-COMPACT legacy session stays conservative: Monitor/Other only.
- A different live owner is foreign. Open/message its task, monitor read-only, or work collaboratively on a different item. If it is COMPACT and the user confirms that the owner task is gone, recover with `takeover: true`; takeover never applies outside COMPACT.
- An expired COMPACT session can be resumed here only after explicit selection; successful resume binds the current task.
- Cancellation always requires an explicit cancel request plus exact typed `cancel <T>` confirmation. `<T>` is the shortest unique session-id prefix defined by SKILL.md; guide calls use the full id.

**Critical rules for autonomous mode:**
- Do NOT use client-native plan mode -- write plans as markdown files in `.story/sessions/<id>/plan.md`.
- Do NOT ask the user for confirmation or approval during the normal pipeline. The guard asks only for foreign/recovery choices; same-owner continuation is automatic.
- Do NOT stop or summarize between tickets unless the guide reaches a context-rotation HANDOVER -- otherwise call the guide IMMEDIATELY
- Do NOT wrap autonomous execution in scheduler or automation loops such as Claude Code's `/loop` skill, `ScheduleWakeup`, `CronCreate`, Codex automations, or thread wakeups. The state machine IS the loop: PICK_TICKET -> PLAN -> ... -> COMPLETE -> PICK_TICKET. "Continue immediately" means advance on THIS turn, not schedule a future wakeup. Scheduler and automation tools persist across compactions independent of conversation state, so a scheduled chain can self-perpetuate through compact/resume and keep burning prompt cache + compute; the user has no natural interrupt point because each turn looks like "just one more small close." The only correct pacing is the guide's `report` -> next-action cadence. See ISS-588 for the observed failure mode. Carve-out: Storybloq's built-in usage-limit waker (T-424) is NOT this pattern -- it is one bounded recovery episode per detected limit reset (wake launches retry only up to a small attempt cap when a launch fails or blocks on approvals, each is verified, and the waker exits once no ACTIONABLE records remain -- inert stood-down `manual` records that await an explicit user `--requeue` do not keep it polling), not a self-perpetuating scheduler chain. The anti-scheduler rule above still stands for everything the model itself could schedule.
- Follow the guide's instructions exactly -- it specifies which tools to call, what parameters to use
- After each step completes, call `storybloq_autonomous_guide` with `action: "report"`, `clientTaskId` when known, and the results

**Recommended setup for long sessions:**

**Claude Code:** run with a model appropriate to the repo and, only in trusted repositories, `--dangerously-skip-permissions` when unattended execution is intentional. Skip-permissions avoids approval prompts consuming context, but disables safety prompts for all tool use.

**Codex:** use a trusted repo and a sandbox/approval profile that allows the intended edits and test commands. Ensure Storybloq MCP is registered with `STORYBLOQ_CLIENT=codex`, then restart Codex or start a new session after setup or MCP source changes so the live MCP process reloads. Check `/hooks` after setup: Codex requires non-managed command hooks to be reviewed and trusted before they run, so an installed `SessionStart`, `PreCompact`, or `Stop` hook is not necessarily active until trusted. `$story auto` does not require Codex subagents; keep the guide loop in the main thread unless the user explicitly chooses `$story orchestrate`.

**Storybloq preserves compaction automatically** when hooks are installed and trusted, but it cannot invoke the client's user-level compaction command. A real client compaction runs PreCompact and then SessionStart; the same session resumes and pressure resets only when SessionStart confirms `source: compact`. `compactThreshold` (`medium`, `high`, or `critical`) selects both pressure limits and the rotation trigger. If pressure reaches the trigger at a clean COMPLETE boundary without confirmed client compaction, the guide ends the bounded session through HANDOVER.

**Context pressure directive (T-499).** Separately from `compactThreshold`, when the owner's measured context pressure is `imperative` (60k tokens of headroom or 95% of the auto-compact point, whichever first) or `compact-needed` (98%), the guide appends one line to its result. At `imperative` the line asks for a handover: write it via `storybloq_handover_create` and keep driving the state machine in the same turn; the stamp holds the state at `advisory` until the context grows another step. One handover per compaction; the line does not repeat within 10 minutes; a stamp that could not bind still counts. At `compact-needed` the line says to write none and keep working through the compaction. Neither is a state transition or a reason to stop. `storybloq_session_intel` returns the full sample at any time. See SKILL.md, Session Lifecycle.

**For an explicit user-triggered compaction:** In the owning task, call the guide with `action: "pre_compact"` and `clientTaskId`, then have the user run the client's compaction command. Do not call `resume` before the post-compaction SessionStart hook runs. The marker/guard then resumes the same full `sessionId` with `clientTaskId`. No second confirmation is needed when `ownerTask` matches or when migrating an unowned legacy session. A different recorded owner requires confirmation that the old task is gone plus `takeover: true`.

**If something goes wrong:**
- Context feels large -- continue the guide. Do not cancel manually; verified client compaction preserves the session, and threshold pressure rotates through HANDOVER at the next clean boundary.
- Compaction happened -- rerun Step 0.5. If `ownerTask` matches or is absent on a legacy COMPACT session, resume automatically. If the compacted lease expired, ask for `Resume here`; if another live task owns it, open/message that task unless the user explicitly confirms it is gone and requests takeover.
- Session stuck after compact -- inspect with `storybloq_session_report`. A verified same owner may run `storybloq session clear-compact <full-sessionId>` for a stale or blocked marker, then resume that same full id with `clientTaskId`. An expired session still requires explicit recovery selection. Never clear a foreign live lease.
- Board tag `[Compacted]` outlives your own compaction -- a subagent's compaction was recorded as the session's (ISS-1307). Resume when your next report asks, then re-report. Residual: a subagent compacting before your first auto compaction, after a model change, or with your context at 60%+ of its compaction point.
- Unrecoverable error -- `storybloq session stop <sessionId>` is destructive and must never be called bare. Require exact typed `cancel <T>` confirmation, resolve `<T>` to the full id, and stop only that session.

## Targeted Mode

`/story auto T-183 T-184 ISS-077 T-185` starts an autonomous session that works ONLY on the specified items, in order, then ends.

**How it works:**

1. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "targetWork": ["T-183", "T-184", "ISS-077", "T-185"], "clientTaskId": "<known-current-task-id>" }`
2. The guide validates all IDs, filters out already-complete items, and presents only target items as candidates
3. Session works through each item via the standard pipeline (T-XXX through PLAN, ISS-XXX through ISSUE_FIX)
4. Session ends when all targets are done (or all remaining are blocked)

**Behavior details:**
- Session cap is auto-set to the number of targets
- PICK_TICKET only shows target items -- the agent cannot pick non-target work
- Array order is respected -- first unworked item is suggested
- Blocked targets are warned about at start but included (completing earlier targets may unblock them)
- Already-complete targets are filtered out at start with a warning
- Invalid IDs cause a hard error before session creation
- Compact/resume preserves targetWork -- the session continues where it left off
- If all remaining targets are blocked by items outside the list, session ends with an explanation

**Use when:**
- Triaging a specific set of high-priority items
- Breaking up work into focused sprints
- Working through a dependency chain in order
- Fixing a cascade of related issues

## Parking an item at the plan gate

Sometimes the plan gate keeps rejecting because the ITEM is defective, not the plan:
an acceptance criterion that contradicts a stated constraint, a cited `file:line` that
does not hold, or a scope item that cannot be sound in isolation from the others. A plan
cannot be written around a contradiction, and an approve verdict must never be faked to
escape one.

From `PLAN` or `PLAN_REVIEW`, report:

```json
{ "completedAction": "park_item", "notes": "<the contradiction, specifically>" }
```

The guide releases the claim, records your reason on the item, returns it to `open`,
and moves this session to the next item. The rest of a targeted queue is preserved.

In a duet, where a pen commissions the gates and a worker executes them, the pen is the dispatcher and the pins above are how it says what it commissioned. It passes the reviewer pin with the round it asked for and the implementer pin with the work it handed down, and both land as `configured` -- a pen naming the tier it dispatched is stating what it intended, which is exactly what a later reader needs and exactly what must not be confused with what executed. A pen that does not know what ran passes nothing, and the round records unknown rather than the pen's own model.

| | `park_item` | `skip_ticket` |
|---|---|---|
| Where | `PLAN`, `PLAN_REVIEW` | `PLAN`, `PLAN_REVIEW`, `CODE_REVIEW` |
| Session | continues to the next item | ends with a handover |
| Reason | required, written onto the item | optional, written into the handover |

Notes:
- The reason is mandatory. An unexplained park is indistinguishable from someone
  releasing the claim by hand, which is what the guard machinery is there to catch.
- After three plan-review rounds without approval the guide surfaces this option
  itself, with the "this may be a filing defect" hypothesis attached.
- Park only for a defect in the item. Ordinary review findings get addressed and
  re-reviewed as usual.
- If the claim moved to another session in the meantime, the guide writes nothing to
  the item and tells you so; file the defect as an issue instead.

## Tiered Access -- Review, Plan, Guided Modes

The autonomous guide supports four execution tiers. Same guide, same handlers, different entry/exit points.

### `/story review T-XXX`

"I wrote code for T-XXX, review it." Enters at CODE_REVIEW, loops review rounds, exits on approval.

1. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "review", "ticketId": "T-XXX", "clientTaskId": "<known-current-task-id>" }`
2. The guide enters CODE_REVIEW -- follow its diff capture and review instructions
3. On approve: session ends automatically. On revise/reject: fix code, re-review
4. After approval, you can proceed to commit -- the guide does NOT auto-commit in review mode

**Note:** Review mode relaxes git constraints -- dirty working tree is allowed since the user has code ready for review.

### `/story plan T-XXX`

"Help me plan T-XXX." Enters at PLAN, runs PLAN_REVIEW rounds, exits on approval.

1. Call `storybloq_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "plan", "ticketId": "T-XXX", "clientTaskId": "<known-current-task-id>" }`
2. The guide enters PLAN -- write the implementation plan as a markdown file
3. On plan review approve: session ends automatically. On revise/reject: revise plan, re-review
4. The approved plan is saved in `.story/sessions/<id>/plan.md`

### `/story guided T-XXX` (deprecated -- alias for targeted auto)

Use `/story auto T-XXX` instead. A single-ticket targeted auto session is equivalent. The guide handler still accepts `mode: "guided"` for backward compatibility but routes to the same targeted auto path.

### All tiered modes:
- Require a `ticketId` -- no ad-hoc review without a ticket in V1
- Use the same review process as auto mode (same backends, same adaptive depth)
- Can be cancelled with `action: "cancel"` at any point

### The review contract (REVIEW.md)

A project may declare a review contract in REVIEW.md: named principles, each with a blocking class, plus an "Outside this contract" line naming what it does not cover. Contract PROJECTION and enforcement are not wired: the projection helpers exist and are covered by tests, but nothing in CODE_REVIEW or PLAN_REVIEW calls them, no projection is persisted, and no severity or verdict is changed by the contract. The file is not inert, though, and the difference matters. Lens prompts already receive REVIEW.md as raw text (head-truncated), so it already shapes what reviewers report. `storybloq validate` is the only production consumer of the PARSED contract, and it parses it to warn when review backends are configured and the file is absent or unparseable -- which is where a project learns its checklist-style REVIEW.md declares no classes at all. Wiring the evaluation and recording it is workstream G; until that lands, do not report a measured session, an observation week, or a contract projection, because none was produced. Do not write or repair a project's REVIEW.md mid-review either: report the warning and let the setup flow propose one.

### Code-review landing cap

`recipeOverrides.stages.CODE_REVIEW.maxReviewRounds` defaults to 12. The effective cap is the larger of that value and the ticket risk's required review rounds; `0` explicitly disables the cap. `reject`, plan redirects, and unresolved critical findings remain blocking at any round. At the cap, `revise` or `request_changes` with zero unresolved critical findings advances to FINALIZE and converts unresolved major/minor findings into deduplicated follow-up issues. A `landingDecision.reason` of `max_review_rounds_no_blocking` is an instruction to land the ticket, not reopen implementation. PLAN_REVIEW convergence remains separate.

**Coverage-only change requests (ISS-950).** Report the lens judge's `capReasons` with every lens-backed round. A `revise` whose caps all name an uncovered core lens and that carries no blocking or major findings is coverage-only: nothing was found, a lens did not look. It never reaches the implementer -- the guide returns a scoped re-run of exactly those lenses, twice at most, and counts no round. Never clear such a cap by resubmitting a skip as `ok` with zero findings; that is recorded as a relabel and is never coverage. See review-lenses.md.

At `reviewEffort: light` the cap is 4 rather than 12, and it becomes a routing point rather than a landing point: a change request AT the cap goes back to IMPLEMENT like any other, and its fix gets exactly one more review round, during which landing is permitted again. The bound is therefore 5. Without that grace round a lower cap would land unreviewed fixes as a matter of course, which is the one rule that holds at every level. Setting `maxReviewRounds` explicitly beats the dial and opts out of both the cap and the grace round.

### The hard ceiling

The cap above does not bound a review that keeps producing blocking findings, and it was never meant to: forced landing requires nothing blocking to be outstanding, so `reject` and unresolved criticals continue instead of finalizing at every round -- normally back to IMPLEMENT, or to PLAN when a finding asks for a replan. A reviewer that keeps finding the same class of problem therefore loops without limit.

Three rounds past the effective cap, the session STOPS working on that item. It files the outstanding findings as open issues in the ledger (critical stays critical, major becomes high, minor becomes medium; suggestions are exempt) and goes to HANDOVER. When the session still owns the item's claim it also records the reason on the ticket, releases the claim, and the item returns to `open`. When the claim has moved to another session, or the item is no longer readable, nothing is written to it: the session drops it unchanged, and its current ledger state is what to check.

It ends the session rather than moving to the next item because the parked item's work is still uncommitted in the working tree, and nothing re-checks the tree mid-session; ending puts it in front of the start-of-session dirty-tree guard instead of letting the next item build on top of it. An item released back to `open` can be picked again once a person has dealt with the tree.

`maxReviewRounds: 0` disables the ceiling along with the cap, deliberately: a project that turned the cap off explicitly did not ask for a bound three rounds later. Rounds are counted per ticket and survive both a plan redirect and a compaction recovery, either of which clears the review history the cap's own round number is derived from. The issue-fix path and PLAN_REVIEW have no ceiling yet (ISS-1032, ISS-1031).

## Review findings and dispositions

When you report a review round (`action: "report"` with `findings`), each finding
carries a `disposition`. The four values are not interchangeable, and one has a
side effect worth knowing before you choose it:

- `open` -- unresolved this round (the round will not converge to approve)
- `addressed` -- fixed in this round
- `contested` -- you judge the finding a false positive. This feeds the false-positive
  learning loop and files no issue. Do NOT use it to park a valid finding you simply
  will not fix now; that pollutes the learning signal.
- `deferred` -- the finding is valid but out of scope for this ticket. This AUTO-FILES
  a storybloq issue so the work is tracked. A `deferred` finding whose severity is the
  canonical lowercase `suggestion` is exempt and is not filed (severity is normalized to
  lowercase before this check, so `Suggestion`/`SUGGESTION` are treated the same). Use
  `deferred` only when you genuinely want a new issue created.

So the rule of thumb: park valid-but-out-of-scope work as `deferred` (it becomes an
issue), and reserve `contested` for genuine false positives.

## Branch Affinity

When running `/story auto` (standard mode, no targetWork), the guide checks if the
current git branch contains a ticket or issue ID (e.g. `story/T-012-rebrand`).

**Behavior:**
- If the branch implies a specific ticket, the candidate list shows it first with a
  `[Branch affinity]` marker. The guide expects you to pick that ticket.
- If you pick a DIFFERENT ticket, the guide blocks the pick and routes to HANDOVER.
  This prevents unrelated commits from contaminating a feature branch.
- If the branch contains multiple IDs (ambiguous), a warning is shown but no blocking
  occurs.

**If you pick a different ticket, the guide offers three escapes.** The first mismatch is a
retry, not the end of the session. Report exactly one of:

| Report | What the guide does |
|---|---|
| `{ "completedAction": "new_branch_from_main" }` | Resolves main, creates this item's branch from it, and proceeds with the pick. The guide runs git itself; you do not run any command. |
| `{ "completedAction": "skip_ticket" }` | Records the item as skipped for this session and returns to the pick stage. It will not be offered again. |
| `{ "completedAction": "end_session" }` | Ends the session with a handover, the pre-existing behavior. |

You may also simply pick one of the ids the branch is scoped to.

Each of these acts on the pending item only. Send no id, or the id matching it; a different
id is rejected rather than silently ignored. Re-reporting the same mismatched pick, or
failing to resolve the mismatch repeatedly, ends the session with a handover.

## branchStrategy

Set under `recipeOverrides` in `.story/config.json`.

| Value | Behavior |
|---|---|
| `"current"` (default) | Work on whatever branch is checked out. Branch affinity guards against contaminating a feature branch. |
| `"per-ticket"` | Create a branch per item automatically (`story/` for tickets, `fix/` for issues). The mismatch check is skipped, since each item gets its own branch. |
| `"main"` | Switch to main before working. The mismatch check is skipped for the same reason. |
| `"none"` | Deprecated spelling of `"current"`. Still accepted so existing configs keep working; never written by the CLI. |

**What `"main"` resolves to.** The local branch named `main`, falling back to `master` when
no local `main` exists. It is main-preferred, not default-branch-aware: a repository that
keeps a vestigial `main` while `master` is its real default gets `main`. Resolution is
local-only, with no fetch and no fast-forward, so a stale local `main` is used as-is.

**Where branches are cut from.** These deliberately differ:

- `new_branch_from_main` always bases the new branch on the resolved local main. Its whole
  purpose is to get off a branch whose history you do not want.
- `per-ticket` bases branches on the session's starting commit, which is the behavior that
  shipped. Changing it to main is an open decision, not an oversight: someone who starts a
  session from a release or integration branch today gets ticket branches rooted there, and
  moving them silently would relocate their work.

**Targeted mode (`/story auto T-XXX ISS-YYY`):**
Branch affinity is skipped entirely. The targetWork list constrains picks regardless of
branch name, so no mismatch episode can arise.
