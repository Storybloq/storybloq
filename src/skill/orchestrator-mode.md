# Orchestrator Mode

This file is referenced from SKILL.md for `/story orchestrate`. It instructs the main session to act as an **orchestrator/pen**: durable state lives in storybloq, implementation runs in background subagents (pinned to the cheapest tier that does the work well -- often below an expensive session tier), adversarial review gates run at or above the session model, and the main context holds only conclusions.

## The two planes

Storybloq is the durable STATE plane, background agents are the ephemeral EXECUTION plane, and the main session is the pen. Every storybloq unit maps to an orchestration role:

| storybloq unit | orchestration role |
|---|---|
| ticket / issue | the unit of work an agent receives -- one pipeline run each |
| enriched description | the portable, byte-verified spec (it carries the context so the implementer does not have to) |
| note | ratified owner constraints + decision briefs, injected verbatim into prompts |
| lesson | compounding rails, injected at every context load via the digest |
| handover | crash-safe loop boundary AND intra-wave checkpoint -- the re-entry point after any disruption |
| snapshot | diff baseline so recaps stay meaningful |
| sizing (free-text convention, see below) | the labor-scheduling signal inside the enriched description |

Recovery falls out for free: after any disruption, re-entry is "read the ledger, verify against git, continue." The ledger is the program counter.

## When to use

- The project is a storybloq **orchestrator** (federation `nodes` configured in `.story/config.json`), or a single repo with a large multi-ticket backlog the user wants driven autonomously.
- The user invoked `/story orchestrate` -- that invocation is the explicit opt-in to multi-agent orchestration (see the capability matrix below), confirmed for scope and scale in Step 1. Orchestration is never inferred from a large backlog alone.
- NOT for single-ticket collaborative work, and NOT a replacement for `/story auto` (the guide-driven state machine). Orchestrate replicates the guide's pipeline manually: it folds the guide's WRITE_TESTS and TEST stages into IMPLEMENT (the enriched spec's ACCEPTANCE carries the test plan; RED->GREEN is proven inside the stage and re-derived at byte-review), and it adds an enrichment stage plus two verification stages.

### What your client must support

Requirements are stated as tools the client exposes. Orchestrate keys off what is available:

| Client capability | Orchestrate runs as |
|---|---|
| Claude Code v2.1.154 or newer with dynamic workflows (all paid plans; terminal, desktop, IDE, web, and the Agent SDK) | Full orchestrate: waves as dynamic-workflow scripts, parallel per-repo pipelines, per-subagent `model` overrides, resumable runs. |
| Claude Code with subagents only (no dynamic workflows) | The same 6-stage pipeline dispatched as individual subagents from the main session. No script determinism and no cache-resume, but gates, enrichment, sizing, and one-pen rules are identical. This is a first-class path, not a footnote. |
| Codex with callable subagent tooling (`multi_agent_v1.spawn_agent`, its normalized `multi_agent_v1__spawn_agent` identifier, or an exact `spawn_agent` tool) | The same 6-stage pipeline dispatched as Codex subagents from the main session. No dynamic-workflow script determinism and no cache-resume, but gates, enrichment, sizing, one-pen rules, and wave-boundary handovers are identical. Follow the current Codex tool policy for model overrides; when a dispatch must inherit the session tier, record it as an explicit equal-tier decision rather than an unspecified tier. |
| Claude Code, via `storybloq dispatch` | Agent View background sessions running `/story auto` through the guide state machine -- no harness agent tooling needed. No per-item model tiering yet: `dispatch` does not expose a model flag (planned follow-up). This backend is Claude-specific. |
| Codex without callable background-agent tooling | Do not run orchestrate. Point the user at `$story auto`; product-managed Codex `storybloq dispatch` is a planned backend, not shipped behavior. |
| No agent capability at all | Refuse orchestrate cleanly and point the user at `/story auto`. |

`/story orchestrate` or `$story orchestrate` is your explicit opt-in to multi-agent orchestration. In Claude Code, the skill directs Claude to run the waves as dynamic workflows. If your Claude Code version does not accept skill-directed workflows, the documented triggers are including the word ultracode in your prompt or setting `/effort ultracode` for the session (a session-only setting -- this skill mentions it, never requires it). In Codex, exact callable subagent tooling such as `multi_agent_v1.spawn_agent` or `multi_agent_v1__spawn_agent` satisfies the background-agent requirement; otherwise refuse cleanly and point the user at `$story auto`. Expect scale: an enrichment pass plus a wave can spawn dozens of agents, and token usage scales accordingly.

## Step 1: Active-session guard + opt-in (REQUIRED, before anything else)

SKILL.md Step 0.5 has already run for the orchestrator project itself. It does NOT cover federation nodes: the orchestrator's `storybloq_status` never scans node repos for sessions, and only the ticket/issue read tools accept the `node` parameter. So:

1. Call `storybloq_node_list` to enumerate the nodes. An empty list means there are no federation nodes to guard, and it resolves two ways: if the result notes single-repo mode (not an orchestrator project), skip the per-node session checks in step 2 and run this as a single-repo pass; if it is an orchestrator project that simply has zero configured nodes, there are no per-node checks to run but it REMAINS an orchestrator, so proceed to the scope-and-scale confirmation in step 4. A non-empty list is the normal federation case: run step 2 for each node.
2. For EACH node, check for an active session directly. Prefer `storybloq status` via Bash with the node's path as the working directory and look for the `## Active Sessions` heading -- it reports only LIVE sessions. Fall back to listing the node's `.story/sessions/` directory ONLY when the CLI is unavailable there: a bare directory listing over-signals, because stale terminal session dirs are normal (dozens accumulate in a busy node), so a non-empty `.story/sessions/` is never on its own proof of an active session.
3. If ANY node has an active session, REFUSE to start. One pen per repo. Surface the node and session to the user via `AskUserQuestion` (options: Monitor / Proceed excluding that node / Abort). Never dispatch any agent into a node that has an active session, even if the user proceeds elsewhere.
4. Only then confirm scope and scale via `AskUserQuestion`: "Orchestrate will run an enrichment pass plus waves that can spawn dozens of background agents across <N> repos, some possibly on a cheaper tier, and will push at wave boundaries. Proceed?" Options: Proceed / Scope to one repo / Cancel. The recorded opt-in to multi-agent orchestration is either the prior /story orchestrate invocation or the Orchestrate-the-backlog selection from the `/story` context-load question; this scope-and-scale question confirms the blast radius (repos, scale, pushes) before any agent is dispatched, and is required either way (a recommendation from context load never bypasses it). Single-repo run: name the one repo and drop the cross-repo framing (for example "an enrichment pass plus waves that can spawn dozens of background agents in <repo>, some possibly on a cheaper tier, and will push at wave boundaries"); the blast radius is still scale and pushes.

This guard has precedence over every "do not ask the user" rule in this file, exactly as in `autonomous-mode.md`. `maxTicketsPerSession` does NOT apply to orchestrate; the user-visible unit of scope is the wave -- its contents are presented at planning and re-presented in every wave-boundary handover.

## Model economy: where judgment lives

Dispatch is a BALANCE of two SEPARATE axes -- performance (how well a tier does THIS task) and cost -- chosen for value and LEANING TOWARD PERFORMANCE. It is NOT a single ladder where cheaper means weaker, and it is NOT "always go cheaper" (that would floor everything). Cut cost only where a cheaper tier loses no significant performance on the task; when the performance delta is uncertain, err UP. The strongest tier available is frequently the most EXPENSIVE, and the session often runs on it, so spending it on work a cheaper tier does just as well is pure waste.

**Dispatch rubric -- classify, route, pin.** For every unit of work you dispatch, decide the tier in this order, then pin it:

1. **Judgment** -- a gate (PLAN_REVIEW, CODE_REVIEW/BYTE-REVIEW), a ruling, a security or design decision, or an L-sized or risk-flagged implementation (auth, RLS, money paths, anything that can brick login or deploys) -> the strongest available tier. Never traded down for cost.
2. **Trivial or mechanical** -- rote edits, pure plumbing, tool-driving, relaying prompts or output -> the floor: the cheapest tier that still does it RELIABLY, not the absolute cheapest. A stronger tier buys nothing here, but a tier whose output you cannot trust is BELOW the floor and is never dispatched, even for trivial work.
3. **Ordinary labor** -- XS/S/M coding against an enriched spec, structured-output scans, fix rounds, batched ships (push/watch/verify) -> the tier whose performance is worth its cost (hands): default a strong tier below an expensive pen (equivalent quality on ordinary enriched work, less cost). Do NOT spend the pen on labor by inheritance or default, and never the floor (that loses performance). Use the top tier deliberately -- not by inheritance -- when it is the only tier available or when the item's complexity or evidence shows it measurably changes the outcome.

Then PIN the chosen tier explicitly on the dispatch, and keep the reviewer never below the item's inspector target. The three roles the rubric routes to:

- **The PEN = the session, and it is spent sparingly.** Wave planning, acceptance, the rulings only it should make, and ledger writes stay at the session tier because they ARE the session. Everything it can hand down, it hands down: on an expensive session tier, labor typed by the pen is the single most wasteful thing the loop can do.
- **HANDS = the tier whose performance on the labor is worth its cost -- NOT "one tier below because coding is easy."** Real implementation goes to the tier that does it well for the least cost; under an expensive top-tier pen that is usually a strong tier one step down (equivalent quality on ordinary enriched work, far cheaper), escalated back up when the item genuinely needs the top tier. It is never the floor (that loses performance) and never the pen by default (no better result for the premium).
- **INSPECTOR = the most capable tier available, never below the implementer.** The gates and release-gate audits run here, routed UP via per-call `model` overrides when a stronger tier than the session exists. Judgment is chosen on performance alone; it is never traded down for price.

**Pin every dispatch; inheritance is the bug.** A dispatch with no `model` INHERITS the session model -- and on an expensive pen that silently runs labor at the priciest rate in the room, chosen by no one. "Are you on the cheap tier for that?" must never be answerable with "I don't know, it inherited whatever I run on." Explicit pinning is BOTH the accountability (you can always account for what a dispatch cost) AND the only way the tradeoff gets made (you cannot balance cost against performance on a choice you never consciously made). The one legitimate omission on a dispatch is a consciously-chosen session-tier run on a client that exposes no explicit override -- a recorded equal-tier decision, never the default that lets labor ride the pen (the pen's own loop also runs at the session tier, but that is the session itself, not a dispatch).

**The safety axis is CAPABILITY, not cost.** Two invariants hold in every configuration:

1. **The reviewer is never LESS CAPABLE than the implementer.** Rank reviewers by capability, never by price: a reviewer may cost less than its implementer, but it may never be the weaker judge. (This is the old "never a cheaper reviewer" rule, restated on the axis that actually carries the safety -- "cheaper" always meant "weaker.")
2. **The session tier is the CAPABILITY FLOOR for judgment, not the ceiling, and not a target for labor.** Judgment runs at the most capable tier available and never below the session; labor runs where its performance justifies its cost, which on an expensive session tier is usually a tier below it, never automatically at the pen.

| Session tier | HANDS -- real coding | Floor -- trivial/mechanical | INSPECTOR -- gates + audits |
|---|---|---|---|
| Expensive top tier (nothing stronger exists) | a strong tier below: equivalent quality on ordinary work, less cost; escalate genuinely complex items up | the cheapest RELIABLE tier | the session (nothing above to route to) |
| Cheaper mid tier (a stronger, pricier tier exists) | the same tier (peer), a step down only for simpler slices | the cheapest RELIABLE tier | route UP to the stronger tier |
| Single-model client (no other tier) | the session -- an EXPLICIT equal-tier pin, or documented session-tier omission where no override exists | the session | the session |

Tiers described here are illustrative; the rule is the SHAPE -- balance cost against performance, lean toward performance, pin the choice, rank the inspector by capability -- and no rule in this file names a model. The bottom row still pays: the value is the STRUCTURE (enrichment pass, byte-verified gates, one pen per repo, batched ships), not the cost gap, and even there the choice is pinned. Upward routing depends on the stronger tier being available on the user's plan; when it is not, judgment stays at the session tier and the cross-model `reviewBackends` leg carries the independence. In-product precedent: storybloq's lens system already ranks by capability -- `lensConfig.lensModels` defaults the security and concurrency lenses to a stronger tier than the default lens model, because those are judgment lenses.

- **An audit or review agent runs at the inspector tier when its task is judgment,** even when it looks like fan-out labor. Cost-trimming applies to LABOR; pinning a reviewer below its implementer's tier to save tokens is the classic misuse -- judgment is the one thing you never trade down.
- **The inverse misuse is running plumbing at the inspector tier.** An agent that merely drives a tool -- generates a diff, calls an MCP endpoint, relays prompts or output -- is labor no matter how important the pipeline it serves: the judgment lives in the tool and the prompt, not the driver. Prepare steps, review-backend drivers, and mergers run at the hands tier (the floor of it, for pure plumbing); only the judges, adversarial reviewers, and the spec-authoring enrichment pass (it gates every downstream tier) get the inspector tier. Burning inspector budget on drivers is how sessions hit limits mid-gate.
- **Sizing classifies the LABOR; risk flags classify the JUDGMENT.** Judgment never gets downgraded.
- The riskiest items get a staged rollout (audit -> shadow -> enforce): the first pass ships only observe-only stages; enforcement ships separately after shadow evidence. The plan states the stage boundary explicitly.

Shipped vs convention: there is no `recipeOverrides.stages.*.model` config key. Tiering is done with per-subagent `model` overrides (a per-call parameter, or the agent definition's model frontmatter). Pin EVERY dispatch: omitting the override inherits the session model, which is the accountability hole and the tradeoff hole at once -- on an expensive pen it runs labor at the top rate no one chose. The legitimate inherits are two: the pen's own loop, because that IS the session and not a dispatch; and a recorded session-tier dispatch on a client that exposes no explicit session-tier override. Every other dispatch pins a model explicitly. Downgraded hands are only safe AFTER the enrichment pass below -- any model on a stale spec produces confident nonsense; the same tier on a byte-verified spec with the inspector behind it produces shippable work.

## The enrichment pass (run once per wave, before dispatching hands)

There is no `storybloq enrich` command; the pass is a hand-authored fan-out of read-only **verify-and-enrich** agents over the wave's items. They touch no code and commit nothing; their only writes are storybloq updates to their assigned items. Enrichment matters MORE as the hands get cheaper; when hands run at the session tier it still pays -- smaller specs, less drift, fewer wasted runs. For each item:

1. **Byte-verify every claim at current HEAD.** Backlogs rot: re-derive line numbers, confirm each gap still exists, check whether the work already shipped (fully or partially).
2. **Classify:** `valid-enriched` / `partially-done-rescoped` (name what shipped, with the commit) / `recommend-close` (evidence only -- the orchestrator closes, never the agent).
3. **Rewrite into the junior-proof template** below. The enriched text IS the spec; implementer prompts collapse to "read the item, follow it, stop if reality differs from VERIFIED STATE."
4. **Write with read-modify-write, never blind.** `storybloq_ticket_update` with `{ "id": "T-310", "description": "<full new text>" }` REPLACES the description wholesale. Read the item first (`storybloq_ticket_get`), carry the full prior text into HISTORY, and re-read immediately before writing.
5. **Issues have NO description field.** Enrichment for issues targets `impact`: `storybloq_issue_update` with `{ "id": "ISS-042", "impact": "<enriched impact incl. template + HISTORY>" }`. Leave `resolution` for the eventual fix. Same read-modify-write discipline via `storybloq_issue_get`.
6. **Never enrich items belonging to a wave whose chain is currently running.** Read-only in code is not write-safe in the ledger; enrich between waves, or only items scheduled for future waves.

Template (SIZING is a free-text convention; there is no `ticket.sizing` field):

```
CONTEXT: <what + why, 2-3 sentences>
VERIFIED STATE @ <sha> (<date>): <exact file:line facts, re-derived at HEAD, that a lower-cost execution tier can trust>
SCOPE: <numbered concrete steps, each naming exact files; smallest-correct-change bias>
OUT OF SCOPE: <explicit list -- the fence for eager models>
ACCEPTANCE: <item-scoped testable criteria + test plan (the item's suites, NEW tests, RED-without-the-change expectation); require the item's own tests green with no NEW failures vs the recorded tip baseline, never a global "npm test green">
PITFALLS: <repo-specific hazards: deploy-on-push, drift gates, ratified postures, secrets>
VERIFICATION: <what the post-ship probe must show on production bytes for THIS item, judged independently of unrelated branch state>
SIZING: XS | S | M | L
HISTORY: <the full prior text, quoted -- descriptions are corrected additively, never clobbered>
```

## Sizing -> scheduling

- **Trivial/mechanical** -> the floor (the cheapest tier that still does it reliably). **XS/S/M** -> hands. **L or risk-flagged** -> the inspector tier. Review gates run at the inspector tier for all of them.
- **Sizing sets `reviewEffort`, and tier and effort are separate axes.** The tier decides WHO does the work; the effort dial decides how hard review works, and a wave FILES both per item: trivial/mechanical -> `light`, XS/S/M -> `standard`, L or risk-flagged -> `thorough`. This is a filing policy, not the automatic mapping: left unset, autonomous mode selects `light` only for a low-risk `chore` (there is no size field to read), so a wave that wants a trivial item reviewed lightly has to say so in metadata. `off` is never a wave default: an item nobody reviews is an item nobody can ship on evidence.
- Order waves **smallest-first** so progress banks early and an interruption costs the least.
- **Batch ships:** collect ~3 review-clean items per ship (one push, one deploy, per-item live verification from each spec's VERIFICATION section). A risky item always ships alone, fenced by a ship immediately before and after it.

## How it works

1. **Context load.** `storybloq_status` -> `storybloq_recap` -> `storybloq_handover_latest` with `{ "count": 3 }` -> read `RULES.md` -> `storybloq_lesson_digest` -> `git log --oneline -10`. Federation: `storybloq_node_list`.
2. **Ground-truth scouts.** Never trust ledger state; verify it. Dispatch one read-only scout per node/repo: git state (branch, HEAD, ahead/behind, dirty files), open tickets/issues, latest 3 handovers summarized. Scouts read the node's `.story/` files DIRECTLY -- handover, note, and lesson reads have no `node` parameter; only `storybloq_ticket_list`/`_get` and `storybloq_issue_list`/`_get` accept `node`. Reconcile scout reports against the orchestrator ledger and file corrections BEFORE planning (stale blocker edges, already-done "open" items, unfiled follow-ups).
3. **Wave planning.** Group actionable work into waves by (repo, dependency, theme). One wave per repo at a time; waves in different repos may run in parallel; severity and time-sensitivity first; owner-gated items go on the register (step 8), never into a wave.
4. **Enrichment pass** for the wave (section above), then assign models by sizing and risk.
5. **Execute the wave as a dynamic workflow** running the 6-stage pipeline per item (below), with per-item model assignment. The orchestrator does not implement; it launches, accepts, and verifies.
6. **Accept via the byte-review verdict, never the implementer's report.** On wave completion: read the reports, file every follow-up the agents surfaced (agents report, the orchestrator files -- check the node's existing items first, concurrent duplicates are the failure mode), close recommend-close items with evidence.
7. **Wave boundary:** re-read every ticket or issue filed this wave and upgrade any that misses the enrichment-template bar before writing the handover, then `storybloq_snapshot`, then `storybloq_handover_create` (deltas + evidence + owner-gate register + next wave), then commit and push every touched ledger. Node-scoped MCP writes land UNCOMMITTED in the node's tree -- sweep them into a commit here. Any enrichment or audit output a handover references must land in the ledger (an item's enriched text, or a note) or in the repo, never only a scratchpad or session directory: those are ephemeral, and a later session that needs the detail will find it gone.
8. **Owner-gate register** in every handover: decisions awaiting ratification, external errands, posture sign-offs. Per gated decision: a decision-brief note (file:line evidence, options, exact proposed ratification text), real blocker edges via `crossNodeBlockedBy` with qualified IDs (`orchestrator:T-XXX`, never bare). On ratification: log it, lift the edges, inject the ratified text verbatim into implementer prompts, and make deviation from it a BLOCKING review finding.
9. **Loop** to the next wave until every node's agent-actionable queue is empty. Session end: lessons via `storybloq_lesson_create` / `storybloq_lesson_reinforce`, including lessons that supersede a disproven lesson in place, with the evidence.

**While waves run,** keep a visible wave board -- a task list of the wave's items with each item's live stage -- and narrate dispatches and completions at every stage boundary. A bare workflow spinner with no narrative leaves the user unable to tell progress from a stall; the board plus stage-boundary narration is the confirmed-preferred pattern.

## Review backends

PLAN_REVIEW and CODE_REVIEW/BYTE-REVIEW SHOULD use the project's configured backends: `recipeOverrides.reviewBackends` in `.story/config.json`, with per-stage `stages.PLAN_REVIEW.backends` / `stages.CODE_REVIEW.backends` taking precedence. Both per-stage keys are wired and honored. `reviewEffort` narrows WITHIN whichever list applies -- at `light` it prefers a single fast reviewer and drops the lens fan-out -- and never adds a backend the project did not configure, so a cheaper level can never make a review cost more. When codex is configured (via codex-bridge), use it -- a second model with different training catches what the authoring model is blind to. A configured backend REPLACES the inspector-tier reviewer only when it is known to be at least as capable as the selected inspector tier for that gate (judgment is never traded below the strongest tier); when it is only at or above the implementer's tier, it is an independence leg, not a replacement, and the inspector-tier byte-review still runs. Inspector-tier adversarial subagents are the fallback when no backend is configured, and the second leg alongside codex: byte-verifying the report against repo reality is their job even when codex has reviewed the diff. On modest session tiers with no stronger tier to route up to, lean HARDER on the cross-model leg: reviewer independence compensates for tier.

## Handover cadence

The wave boundary (step 7) is the FLOOR for handovers, not the whole rule. A single item can be a multi-stage, multi-hour, locally-committed-but-unpushed unit of work; if handovers fire only at wave boundaries, a compaction or crash mid-item loses everything since the last boundary. The trigger is reconstruction cost, not the wave:

- **Checkpoint whenever the cost to reconstruct your unrecorded state, if the session died right now, exceeds the cost of writing the checkpoint.** These states are examples, not a whitelist; when unsure, checkpoint (a handover is cheap; re-deriving a multi-round plan approval from a transcript is not):
  - a local commit that is not yet pushed (git has it, origin does not),
  - a gate or decision milestone landed -- a plan approved after review rounds, an architecture ruling, an owner ratification -- EVEN with no commit yet,
  - substantial uncommitted work in flight, especially before any expensive or irreversible step (a deploy-on-push, a paid-API probe, a long build),
  - you can no longer summarize what happened since the last handover in one line.
- **Two weights.** Wave-boundary handovers are the full synthesis of step 7 (deltas, evidence, owner-gate register, next wave). Intra-wave checkpoints are light deltas: what shipped, what was decided, the current fragile state (local-only commits, in-flight stage), and the immediate next step. Only the latest handovers are reloaded on re-entry, so more-frequent-lighter is strictly safer at low cost.
- **Decisions land in the ledger the moment they are made, not only in a handover.** A reconstruction-expensive decision -- a plan approved after N rounds, an architecture ruling -- is captured as a note or folded into the item's enriched description immediately, exactly as enrichment and audit output must (step 7). The handover then points at it. This is the primary durability mechanism; checkpoint handovers are the re-entry net. A decision that lives only in session context is one compaction away from gone.

Compaction note: `/story auto` gets an automatic post-compaction resume prompt; an orchestrate/pen session driving directly has no autonomous session, so on compaction the resume hook injects only a lightweight continuity breadcrumb (latest handover + `storybloq recap`). That breadcrumb restores only what is already durable -- which is why decisions must reach the ledger continuously, above.

## The 6-stage per-item pipeline (inside dynamic workflows)

1. **PLAN** *(hands; inspector tier for L/risk)* -- read the enriched item + cited notes + the ACTUAL code; re-verify VERIFIED STATE with cheap greps; write a markdown plan: exact edits, tests, migration/deploy safety, post-deploy probe, explicit out-of-scope.
2. **PLAN_REVIEW** *(inspector tier / configured backends)* -- verify the plan implements SCOPE exactly, stays out of OUT OF SCOPE, meets ACCEPTANCE, respects every PITFALL. Verdict `approve`/`revise`; on revise, one revision round addressing EVERY finding (address or rebut in the plan text).
3. **IMPLEMENT** *(floor for trivial/mechanical; hands; inspector tier for L/risk)* -- follow the approved plan exactly (deviations justified in the report). Meet the item's ACCEPTANCE: the item's tests green, at least one proven RED->GREEN, and no NEW suite failures vs the recorded tip baseline (report run counts before/after; a pre-existing red test is not this item's stop). Item status updated via storybloq CLI in the same commit as the code. Commit locally; do NOT push.
4. **CODE_REVIEW + BYTE-REVIEW** *(inspector tier / configured backends -- this verdict gates the ship)* -- byte-verify the REPORT against repo reality: commits exist as described, RED->GREEN re-derived (not trusted), logs show real EXECUTED test counts (runner totals include skips; subtract them), ledger matches bytes, no invented wire/contract codes. When the implementer reports a suite failure as pre-existing or unrelated, do NOT hard-block on it: re-derive the claim in the parent-commit worktree (it must fail there identically, untouched by the diff) and accept it only if it holds; a false pre-existing claim is itself a `revise`. On revise: fix round -> re-review; still dirty -> stop the chain and return to the orchestrator.
5. **SHIP** *(hands, batched)* -- fetch first; push; watch CI + deploy to conclusion; live-verify health plus each shipped item's VERIFICATION section against production bytes. Deploy failure -> documented remediation only, never a blind retry.
6. **PROBE-LOOP** -- exercise the real production path; verify actual bytes/artifacts, never status codes; fix the root layer; LOCK every probe as a regression test or a documented manual-probe checklist entry. Cheap probes fold into stage 5's live-verify; anything unprobeable is stated as an honest boundary with its test-lock named.

XS/chore items may collapse stages 1-2 into the implementation prompt, DISCLOSED (the report states the 5-line plan). No stage is ever skipped silently. `reviewEffort: light` is the autonomous analogue in SPIRIT, not in mechanism: it lowers the depth of both review stages and discloses it, but it never skips either gate. Only `reviewEffort: off` removes a stage there.

Acceptance is item-scoped at every gate: an item passes on ITS tests and probe with no NEW failures vs the recorded tip baseline. Overall branch health is a wave-level concern, not an item gate -- a red branch state (a pre-existing failing test) becomes its own wave item and never silently stops an unrelated item at the implement or ship gate.

**Standard wave-prompt furniture.** Every wave-stage prompt carries the branch's KNOWN CAVEATS -- pre-existing failures with their tracking IDs, known flakes, and any expected local-only commits -- so agents neither rediscover them, misclassify them as regressions, nor recommend filing items that already exist in the queue. Every IMPLEMENT prompt also states the ledger precedence explicitly: the ledger is orchestrator-owned, so the implementer does NOT create or close any storybloq ticket or issue and touches no ledger item other than updating its OWN assigned item's status when the IMPLEMENT stage requires it (this overrides a repo's own "log ISS-XXX for out-of-scope items" rule). Out-of-scope work and follow-ups it surfaces go back in a `followUps` field of its structured report, for the orchestrator to file.

## Dynamic-workflow skeleton (tiered models)

```js
// Pin EVERY tier explicitly. An omitted `model` inherits the session model -- on an expensive
// pen that silently runs labor at the priciest rate no one chose. Resolve these to concrete
// model ids for THIS session before dispatching: named and accountable, never undefined.
const HANDS     = '<cheapest tier that codes WELL>'                  // real implementation + ships; often a strong tier below an expensive pen
const FLOOR     = '<cheapest tier that does trivial work RELIABLY>'  // rote edits / pure plumbing / tool-driving ONLY; never an unreliable tier
const INSPECTOR = '<most capable available tier>'                    // gates + judgment; never below HANDS; == the session when nothing is stronger, routed UP when it is
// Single-model client: no other tier exists. Pin all three to the session model's OWN id by name
// (an explicit equal-tier decision); where the client exposes no model override, running at the
// session tier via omission is the one acknowledged fallback -- a recorded equal-tier choice, not a silent inherit.
const ITEMS = [
  { id: 'ISS-201', trivial: true, collapsed: true },       // trivial/mechanical -> FLOOR; XS also collapses stages 1-2 (disclosed)
  { id: 'T-310' },                                         // S/M real coding -> HANDS
  { id: 'T-295', judgment: true, risky: true },            // L / risk-flagged -> INSPECTOR-tier implementer
]
let shipQueue = []
for (const it of ITEMS) {                                  // sequential: same repo = one pen
  const exec = it.judgment ? INSPECTOR : it.trivial ? FLOOR : HANDS   // every branch an explicit pinned tier -- no inherit
  let plan = it.collapsed ? null
    : await agent(planPrompt(it), { label: `plan:${it.id}`, schema: PLAN, model: exec })
  if (plan) {
    const pr = await agent(planReviewPrompt(it, plan), { label: `plan-review:${it.id}`, schema: REVIEW, model: INSPECTOR })
    if (pr.verdict === 'revise') plan = await agent(revise(plan, pr.findings), { schema: PLAN, model: exec })
  }
  const impl = await agent(implementPrompt(it, plan), { label: `impl:${it.id}`, schema: RESULT, model: exec })
  const review = await agent(byteReviewPrompt(it, impl), { label: `byte-review:${it.id}`, schema: REVIEW, model: INSPECTOR })
  if (review.verdict === 'revise') { /* fix round (exec) -> re-review (inspector); still dirty -> break */ }
  shipQueue.push(it.id)
  if (shipQueue.length >= 3 || isLast(it) || it.risky) {   // batched ships; risky items deploy alone
    const ship = await agent(shipPrompt(shipQueue), { label: `ship:${shipQueue.length}`, schema: RESULT, model: HANDS })  // ship is operational labor -> hands, never the inspector tier even for a risky item
    shipQueue = []
    if (!ship || ship.status === 'blocked') break          // stop for the orchestrator
  }
}
```

Waves in different repos: wrap per-repo chains in `parallel([...])`. The enrichment pass is its own earlier run: `parallel(GROUPS.map(g => () => agent(enrichPrompt(g), { schema: OUT, model: INSPECTOR })))` -- inspector-tier because enrichment authors the specs that gate every downstream tier; pinned, never inherited; read-only in code, ledger-writes only, and only against items outside any running chain's wave.

**Codex subagent mapping.** The JavaScript above is a logical pipeline, not a script to execute in Codex. When `multi_agent_v1.spawn_agent`, `multi_agent_v1__spawn_agent`, or `spawn_agent` is callable, map each `agent(...)` stage to that exact spawn tool, keep independent repo/item stages parallel, and continue non-overlapping pen work while agents run. Use the matching wait tool only when the next gate depends on the result; send a fix-round prompt back through the matching send-input tool rather than spawning a duplicate worker; close completed agents when the wave no longer needs them. Give every coding worker a disjoint file/write scope and say that other work may be in flight. Follow the callable tool's current model-override policy: an omitted override must be recorded as an intentional equal-tier dispatch, never accidental inheritance. The main task remains the pen and owns verdict acceptance, cross-item ledger filings, handovers, and ship decisions.

**Script practicalities (dynamic-workflow clients).** Hardcode the wave's item constants inside the script: workflow args can arrive stringified on some clients, so an args-marshalled ITEMS array is unreliable. The script is plain JS, not a template -- an apostrophe inside a single-quoted string reads as a syntax error, so quote prompt strings with backticks or escape the apostrophe. The RESULT schema for IMPLEMENT and fix rounds carries a `followUps` array (each entry: title, rationale, evidence) so out-of-scope work the implementer surfaces returns as structured output the orchestrator can file, never as prose a strict-output client could silently drop. Resume is PREFIX-CACHED on the sequence of agent calls: a recovery edit must touch ONLY post-processing logic and not-yet-run prompts. Editing a completed agent's prompt, a shared prompt constant, or a schema invalidates the cache from that point and re-pays that agent's work, so leave those bytes untouched when re-launching with `resumeFromRunId`.

## Critical rules

- **DO keep one pen per repo.** Never two waves, or an orchestrator edit and a wave, in the same repo concurrently. Read-only scout/enrichment agents are the only exception (with the ledger-write restriction above).
- **DO run the second-pen protocol.** A shared working tree has no private commits: any pen's push publishes ALL local commits, which on a deploy-on-push repo can bypass the ship gate. Before pushing, check `git log origin/main..HEAD` and either wait or explicitly accept carrying the other pen's commits. Ship agents treat origin==HEAD as a verifiable arrival state (check WHAT landed and that CI ran green on that sha), not an anomaly.
- **DO gate every irreversible action on the byte-review verdict.** Nothing pushes to a prod-deploying branch on an implementer's word, regardless of which model implemented. The gates catch real bugs: ISS-767..770 were four confirmed release-gating defects surfaced by this pattern's adversarial reviewers.
- **DO pin every dispatch's model as a deliberate choice -- know what you dispatched.** Prefer an explicit tier id on every dispatch; inheritance is the ABSENCE of a decision, and on an expensive pen it runs labor at the top rate no one chose, so "I do not know what tier it ran, it inherited" is never an acceptable answer to the owner. The one acceptable omission is a consciously-chosen session-tier run on a client that exposes no explicit override -- a recorded equal-tier decision, never the default that lets labor ride the pen. Match each dispatch to the tier whose performance is worth its cost; keep judgment at the strongest tier, never traded down for price. See "Model economy".
- **DO verify-then-trust, including yourself:** `git fetch` before trusting ahead/behind counts; prefer CI/deploy run state over local ref math; after any disruption, verify pen ownership before writing -- the run journals show who holds the pen (L-021).
- **DO recover, never redo.** On dynamic-workflow clients, re-launch a failed run with `resumeFromRunId` (completed agents return cached; only the failed stage re-runs); on subagent or dispatch paths, re-dispatch only the failed stage. If the dead agent left commits, edit the failed stage's prompt into verify-and-complete: byte-verify the inherited commits against the approved plan, run the suites, finish the remainder. If subagent capacity is throttled, the main loop may take over a SHIP stage directly.
- **DO keep the cadence:** the wave boundary is the floor, not the ceiling. Snapshot -> handover -> ledger commit+push after every wave loop, PLUS a light checkpoint handover whenever unrecorded state would be expensive to reconstruct (any local-but-unpushed commit, a landed plan or decision even without a commit, or before any irreversible step), AND land reconstruction-expensive decisions in the ledger (a note or the enriched item) the moment they are made. Owner-gate register in every handover; lessons at session end. See "Handover cadence".
- **DO file every follow-up ticket or issue in the enrichment template.** Every ticket or issue the orchestrator files during a run is born in the template (CONTEXT / VERIFIED STATE @ sha / SCOPE / OUT OF SCOPE / ACCEPTANCE / PITFALLS / VERIFICATION / SIZING) with byte-verified file:line facts. Anything the orchestrator files for later execution must be portable enough for the lowest permitted execution tier, so it is born in the enrichment template rather than paying the enrichment debt downstream. A bare-paragraph ticket or issue filing is a defect in wave acceptance. This covers actionable follow-up work only: decision-brief notes, lessons, handovers, and non-actionable ledger corrections keep their own formats.
- **DO NOT amend, rebase, or force-push.** Fix-round commits are NEW commits, even on local unpushed work. One-commit-per-item is a nicety, never a reason to `git commit --amend`: amending collides with the standing no-amend rule and rewrites shared history.
- **DO NOT let agents file or close items.** Agents report; the orchestrator files (after checking existing items) and closes (on evidence).
- **DO NOT let an agent fake its way to done.** Prompts must permit the honest-open off-ramp: "this cannot be completed legitimately -- leave OPEN with a dated disposition note." Never a faked fixture, hand-edited vendored data, or fabricated probe.
- **DO NOT blind-retry a failed deploy or gate.** Expected gate failures get documented remediations spelled out in the ship prompt (for example hash-pinned infra files); anything else stops the chain.
- **DO NOT take over IMPLEMENT in the main loop.** It bloats the orchestrator context; SHIP takeover (push/watch/verify) is the only main-loop-safe substitution.
- **DO NOT leave node writes uncommitted past a wave boundary,** and DO NOT use bare cross-node IDs (`cloud:T-139`, never `T-139`).
- **DO NOT run probes carelessly:** live probes that hit paid APIs state their spend; restore every binding/config a probe touched and verify the restoration.

## Evidence

- 2026-07-02, first in-house run (the 1.5.0 fix train): ISS-767 (XS) and ISS-770 (S) were implemented by hands-tier agents (Opus, in that run) against enriched specs; both passed the session-model byte-review and codex gates cleanly on post-hoc verification. The train was interrupted mid-L-item, and the session model completed that item directly (ISS-768/769). The interruption exercised the disruption-recovery rules for real: `resumeFromRunId` returned completed agents from cache, and pen ownership was re-verified from the run journals before takeover (L-021).
- The T-400 release-gate audits ran as the same pattern -- parallel background auditors returning structured findings, filed by the orchestrator as ISS-775..784.
