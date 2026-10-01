<!-- storybloq-handover v1 -->

# Plotbook initial setup handover

## Worker state

Approved Storybloq setup completed from a brief-only directory. Six phases including p0 Setup and fourteen pending tickets are saved; no product implementation is complete. Project metadata: Plotbook, generic, typescript. Git initialized; no initial commit was requested. Governance files verified by read-back: AGENTS.md 4280 bytes, RULES.md 4383 bytes, REVIEW.md 4726 bytes (verbatim skill template); .gitignore 54 bytes. Storybloq validation before this handover returned zero errors, warnings and info. Baseline snapshot was taken before writing this handover.

## Blocked

- No unresolved owner product decisions. Framework, SQL database, deployment approach, scheduler and email provider are delegated implementation selections in T-001.
- Pipeline tooling is pending, not a completed capability.
- T-014 is intentionally blocked by T-013 first-version acceptance and by registry/allocation prerequisites.

## Owner rulings

Source: owner conversation during setup, approved in full with "Approve setup."
- "Sign-in: gardeners sign in with an emailed one-time link; no passwords."
- "Problem notifications: the coordinator gets one email a day listing new problem reports."
- "Technology: no preference."
- "No preference, use your judgement."
- "Defer the plot map view to after the first version."

Conflict and resolution: brief.md / First version must 5 originally required the map in v1. The later explicit owner instruction overrides that scope. T-014 retains the requirement after first-version acceptance. P08 was narrowed to the gardener's personal allocation view (T-008); grid positions moved from registry to T-014; prototype, demonstration and v1 acceptance contain no map requirement. Other brief requirements are unchanged.

## Carried forward

- T-001 Foundation and feasibility: establish implementation architecture and enable verified Full pipeline stages.
- T-004 Checkpoint: phone journey prototype can proceed independently of foundation. Review must include actual owner feedback.
- All other tickets follow the saved dependency graph. Do not start the deferred map before T-013 acceptance.

## Shipped

- Setup artifacts only: .story/ roadmap/tickets/dependencies/config, AGENTS.md, RULES.md, REVIEW.md, git initialization and Storybloq ignore entries.
- No application features, tests, purchased services or live deployment.

## Product brief and observable success

Riverside Community Garden has 40 plots and approximately 60 households, coordinated by one volunteer. Plots are seasonal, March to October (brief.md / Background and Users).
Version one lets gardeners sign in without passwords, apply for the coming season with up to three preferences, see their own allocation and dates, and report a problem on their own plot. The coordinator reviews/allocates using application lists and plot selectors, maintains the ordered waiting list, resolves reported problems and receives a daily email summary. A successful demonstration includes returning priority before the local February 1 cutoff, strict chronological vacancy allocation, allocation uniqueness, contact privacy, accessible phone journeys and recovery from report/email failures. Every outcome is mapped below.
The map is deferred to T-014 after v1. Payments and lending are later ambitions, not implementation scope.

## Approved assumptions

- One verified email account represents a household; coordinator maintains household identity and prior-season records.
- At most one plot per household-season and one household per plot-season. Preferences are advisory; zero preferences is valid.
- Initial allocation gives qualifying returning applicants priority. Moving one to waiting cannot clear priority while capacity exists. If demand exceeds capacity, use application time and deterministic sequence within the cohort. Once the initial round ends, the chronological queue governs subsequent vacancies and new applicants. This two-stage interpretation was explicitly labelled in the approved package.
- Server application time and deterministic tie sequence control waiting order, not time of joining the waiting list. No arbitrary bypass of the head.
- Coordinator sets season dates, timezone and digest time. Plot grid positions are post-v1 only.
- Problems are text-only; gardeners may see their own report status. No attachments, chat or self-service application cancellation/amendment workflow.
- Skip empty daily digests; include newly reported problems since resolved with status labelled. Persistent batch identity and retries prevent loss; provider idempotency determines physical duplicate-email guarantees and must be verified.
- One TypeScript web application with SQL persistence and an email adapter. Provider/framework choices occur in T-001; no paid purchase or live deployment authorized.

## Verification and quality

Quality level: Full pipeline

No manifests, command definitions, runner configuration or collected tests existed at setup. No install, test, build or dev server was run. All four recipe stages are explicitly disabled. T-001 must establish, validate and enable the real commands and readiness URL.

Verification tooling to establish: WRITE_TESTS: npm test (pending: no manifest or collected tests)
Verification tooling to establish: TEST: npm test (pending: no manifest or collected tests)
Verification tooling to establish: BUILD: npm run build (pending: no build script)
Verification tooling to establish: VERIFY: npm run dev (pending: no dev script or established readiness URL)

## Checkpoints

- T-004: early phone prototype, gates T-005/T-008/T-009; does not gate independent server foundation.
- T-011: allocation demonstration, gates T-012.
- T-013: v1 acceptance, gates T-014.
Stage-1 limitation: these are ordinary tickets, so their owner approval gates are not automatically enforced. Record actual review and acceptance.

## Coverage map

| Source | Requirement or decision | Ticket / disposition | Acceptance evidence |
|---|---|---|---|
| brief.md / Background | 40 plots; March–October seasons | T-002 | 40 stable plot records and explicit valid season dates |
| brief.md / First version must 1 | Coming-season application, up to three preferred plots | T-005 | Persist 0–3 distinct valid preferences; reject duplicates/invalid plots; repeated submission retains application order |
| brief.md / First version must 2 | Coordinator allocates from applications | T-006 | Authorized list/selector assignment, preferences visible, priority and uniqueness enforced |
| brief.md / First version must 2 | Unallocated applicants wait in application order | T-007 | Original timestamps and tie sequence control ordering regardless of enqueue order |
| brief.md / First version must 3 | Gardener sees own allocation and dates | T-008 | Allocated/waiting/unallocated states with correct dates and household isolation |
| brief.md / First version must 4 | Report own-plot problem | T-009 | Persistent report, duplicate protection, cross-household report rejection |
| brief.md / First version must 4 | Coordinator reviews open reports and resolves them | T-009 | Open queue and idempotent resolution with gardener status |
| brief.md / First version must 5; owner scope override | Coordinator grid of 40 plots and holders | T-014, DEFERRED until T-013 | All 40 plots exactly once, current holder/vacancy, persistent layout, coordinator-only access, accessible alternative; not a v1 acceptance criterion |
| brief.md / Rules | At most one plot per household per season | T-002, T-006 | Atomic uniqueness and race tests; approved reciprocal plot-season uniqueness |
| brief.md / Rules | Previous-season holders applying before February 1 have priority | T-005, T-006 | Local cutoff boundary, prior holdings and no waiting-list bypass of priority |
| brief.md / Rules | Waiting strictly first come, first served | T-007 | Original application order, deterministic ties, head-only vacancy allocation |
| brief.md / Constraints | Phone usability | T-004, T-005, T-008, T-009, T-012 | Prototype review and end-to-end phone evidence |
| brief.md / Constraints | Contact details coordinator-only | T-003, T-008, T-012 | Server-side role/ownership and response data-isolation tests |
| brief.md / Constraints | Large text and plain language | T-004, UI tickets, T-012 | Readability, keyboard, focus, contrast and recovery checks |
| Owner conversation | Emailed one-time links; no passwords | T-003 | Expiry, replay prevention, atomic consume, resend/failure and session tests |
| Owner conversation | One daily coordinator email listing new reports | T-010 | Durable batch membership/cursor, timezone boundaries, crash/retry and delivery-failure checks |
| brief.md / Later | Online plot-fee payment | DEFERRED, no v1 ticket | Explicit exclusion |
| brief.md / Later | Shared tool-lending shelf | DEFERRED, no v1 ticket | Explicit exclusion |

Supporting evidence: T-001 establishes and enables the Full pipeline; T-011 is the allocation demonstration; T-012 verifies complete v1 operation and recovery; T-013 is owner v1 acceptance. Map design/layout/test evidence is only T-014, never a v1 prerequisite.

## Independent plan review record

Native reviewer probe printed nothing; review_plan was unavailable; the independent setup_review agent returned completed responses in this session. R1 identified pipeline activation, priority bypass and queue insertion-order ambiguity. R2 incorporated those corrections. After the owner's map deferral, R3 reviewed the revised scope, responsibilities, dependencies and coverage; captured response: {"verdict":"approve","findings":[]}. No unresolved findings.
Reviewer probe: `command -v codex` printed nothing
Independent review: approve, invocation R3

## Deferred tooling and next session

Use $story to load project context. Post-init MCP creation tools were not exposed in this client; CLI v1.16.0 successfully created and checked the ledger. Restart the client if the expanded tool list remains unavailable. The brief is unchanged; this handover records its approved scope override.
