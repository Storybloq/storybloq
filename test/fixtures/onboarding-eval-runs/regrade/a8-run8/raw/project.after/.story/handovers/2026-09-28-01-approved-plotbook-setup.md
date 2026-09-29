<!-- storybloq-handover v1 -->

# Plotbook approved setup

## Worker state

- Setup complete; application implementation has not started. Folder initially contained only brief.md, with no code, Git or .story.
- Created default p0 plus five milestones, 16 planned tickets (15 v1 and one post-v1), wired dependencies, governance files, Git ignores/repository, setup note N-001 and baseline snapshot.
- All tickets remain pending. No existing capability was claimed complete. No installs, application tests, builds or servers ran during setup.
- Governance read-back: AGENTS.md 4611 bytes, RULES.md 4545 bytes, REVIEW.md 4726 bytes; REVIEW.md matches the skill template byte-for-byte.
- CLI used for post-init creation because client tool list remained at pre-init MCP tools; restart may be needed to expose full MCP tools.

## Blocked

- No setup blocker. T-001 must establish application/tooling before recipe stages are enabled.
- Owner supplies provider accounts/credentials, exact season dates and garden timezone before launch. Contact-retention policy must be recorded before live data. Hosting/email/scheduler choices and costs belong to T-001.

## Owner rulings

- Source brief.md: Plotbook serves Riverside Community Garden, 40 plots, about 60 households and one volunteer coordinator; seasons March–October.
- Owner answer verbatim: "Sign-in: gardeners sign in with an emailed one-time link; no passwords."
- Owner answer verbatim: "Problem notifications: the coordinator gets one email a day listing new problem reports."
- Owner gave no technology preference and delegated other unspecified choices to agent judgment.
- Owner scope change verbatim: "Defer the plot map view to after the first version."
- Owner approval verbatim: "Approve setup."
- The map deferral supersedes brief.md item 5's original first-version placement; original brief was not edited. T-012 is post-v1, blocked by T-016. All v1 prototype, readiness and acceptance references to map removed. No substitute whole-garden holder dashboard.
- No other source conflicts. Payments and tool lending remain later ambitions.

## Carried forward

- Start T-001: establish application/email/verification foundation; T-004 prototype is independently actionable.
- Use $story at session start to load context. Setup approval does not start autonomous implementation.
- Owner checkpoint tickets: T-005 early prototype/rule examples, T-010 allocation demonstration, T-016 first-version acceptance. They are ordinary tickets; stage-1 owner gates are not mechanically enforced. Record owner response before completion.

## Shipped

- Project ledger and approved planning/documentation only; no application capabilities shipped.
- Metadata: Plotbook, type generic, language python. Planned architecture Python/Django server-rendered responsive web app, PostgreSQL, email adapter, externally scheduled management command.
- Git initialized; .gitignore includes .story/snapshots/, .story/sessions/, .story/status.json, Python caches/virtualenv/secrets. No commit made.

## Product brief and observable acceptance

First version lets a verified household sign in without a password and submit an upcoming-season application with at most three preferred plots; the coordinator reviews and assigns plots without violating household/plot uniqueness and initial returning priority, then manages unallocated applicants in strict original application order. A gardener sees their own plot and season dates and can submit a problem; the coordinator sees open problems and resolves them and receives a daily new-report digest. All primary flows work on phones with large text, plain language, keyboard access and clear recovery. Contacts remain coordinator-only, including direct-request checks and avoidance of log/email leakage.

Acceptance evidence is scoped in each ticket: persisted receipts/status, rejected invalid/concurrent assignments, cutoff fake-clock scenarios, queue head-only promotion, private access tests, idempotent reports, delivered digest and recovery tests, staging restore and owner walkthrough. T-016 covers brief items 1–4 plus owner email requirements and operational/accessibility evidence. The map is excluded until after T-016.

## Approved assumptions

- Coordinator independently verifies household membership and prior holdings; manual paper-record entry; email alone is not household identity. Coordinator enrollment/invitations and audited email recovery with old-session/token revocation.
- Preferred plots optional, distinct, advisory and unranked; no automatic preference optimizer. Immutable application timestamp and stable sequence tie-break.
- One household per plot and one plot per household per season. Initial cohort ordering returning-first and FCFS within cohorts.
- Exclusive midnight beginning Feb 1 in target season year and configured garden timezone is cutoff. Returning allocations may happen earlier; new-applicant allocation and round finalization cannot occur before cutoff.
- Explicit atomic audited initial-to-finalized transition; eligible initial returners processed or capacity exhausted. Serialize against submissions, retain every applicant. After finalization use strictly original application order without priority override.
- 15-minute single-use link expiry. Exact garden timezone and season dates are pre-launch inputs.
- No self-service application editing, withdrawal or reassignment; validated audited coordinator correction procedures preserve invariants.
- Reports plain text for current allocation, historical associations retained; request idempotency prevents retry duplicates.
- Digest defaults to 08:00 local, skips empty days, includes reports created since last successful batch even if now resolved; no contact data in email, authenticated links. Persist batching/retries; surface uncertain acknowledgements; no exactly-once SMTP claim.
- Hosting/email providers selected in T-001 with costs and provisioning documented. Synthetic records until operational/privacy prerequisites satisfied.

## Independent review

Independent review: approve, invocation R3

Captured R3 verdict: approve.
Captured R3 findings:
- No remaining blockers. The cutoff safeguards resolve the R2 priority finding, and all R1 corrections remain incorporated.
- The owner's map deferral is consistently reflected in milestones, prototype scope, operational readiness, acceptance criteria, and coverage. P12 depends on P16 without creating a dependency cycle; the 40-plot registry and allocation controls remain appropriately within v1.
- Planned verification adequately covers household enrollment and recovery, authorization and contact privacy, allocation priority, concurrent finalization and FCFS promotion, report retry safety, digest recovery, and operational acceptance.

Review references used provisional Pxx labels; these now map one-to-one to T-0xx. R1/R2 feedback incorporated explicit round state/finalization, coordinator enrollment/recovery, application dependency, packaging distinction, retry idempotency and pre-cutoff guards. R3 reviewed owner map deferral and cumulative corrections.

## Quality and verification tooling

Quality level: Full pipeline.
All four stage overrides explicitly enabled:false at setup because there is no application, manifest, runner or test source. T-001 establishes real commands and collected tests before enabling applicable stages. TDD for business logic. BUILD remains disabled if deployment needs no build. python manage.py check is validation, not packaging evidence.

Verification tooling to establish: WRITE_TESTS: python manage.py test (pending: no application, configured runner or collected test sources)
Verification tooling to establish: TEST: python manage.py test (pending: no application, configured runner or collected test sources)
Verification tooling to establish: BUILD: TBD deployment artifact command (pending: hosting and packaging approach to establish in T-001; stays disabled if no build is needed)
Verification tooling to establish: VERIFY: python manage.py runserver 127.0.0.1:8000 (pending: application and readiness endpoint http://127.0.0.1:8000/ do not exist)

## Coverage map

| Source | Requirement / decision | Tickets and evidence |
|---|---|---|
| brief.md Background | 40 plots, March–October seasons | T-002/T-015: validated registry, exact season configuration and verified paper holdings. |
| brief.md Users | Gardeners and one coordinator | T-002/T-003: verified household enrollment, invitations and role/household access. |
| brief.md First version 1 | Apply for upcoming season with up to 3 preferences | T-006: durable receipt; invalid/duplicate/excess choices rejected; retry creates one application. |
| brief.md First version 2 | Coordinator review and allocation | T-007/T-008: valid assignments, priority cohort display, atomic uniqueness and conflict rejection. |
| brief.md First version 2 / Rules | Unallocated applicants queued in original application order; strict FCFS | T-008/T-009/T-010: safe finalization, durable ordering, head-only promotion and concurrency tests. |
| brief.md First version 3 | Own plot and season dates | T-011: correct persisted allocation/status/dates after reload, household isolation. |
| brief.md First version 4 | Gardener reports own plot problem; coordinator resolves | T-013: authorization, durable report, duplicate-safe retry and idempotent resolution with history retained. |
| brief.md First version 5; owner deferral | Coordinator map of 40 plots and holders | DEFERRED to post-v1 T-012, blocked by T-016; no first-version dependency. Grid and accessible list alternative are both deferred. |
| brief.md Rules | One plot per household per season | T-002/T-006/T-007/T-010: verified household records plus application and concurrent allocation uniqueness. |
| brief.md Rules | Returning gardeners applying before Feb 1 allocated first | T-002/T-007/T-008/T-010: prior holding evidence, cutoff boundary and early-new-allocation/finalization rejection tests. |
| brief.md Constraints | Phone, large text, plain language | T-004/T-005 and T-006/T-008/T-011/T-013, T-016: primary journeys with keyboard/focus, labelled errors and recovery. Post-v1 map checked in T-012. |
| brief.md Constraints | Contacts coordinator-only | T-002/T-003/T-014/T-015/T-016: direct-request access checks; no contact leaks in gardener pages, logs or digest. T-012 verifies map permissions after v1. |
| Owner sign-in answer | Emailed one-time links; no passwords | T-003: single use/expiry, invitations, secure recovery, revocation; enrollment-to-application integration in T-006. |
| Owner notification answer | One daily coordinator email of new reports | T-014: persisted batch accounting, empty days, failure/restart/catch-up/concurrency/DST and sandbox email. |
| Derived operational support | Foundation, deployment/recovery, audited corrections | T-001/T-015: startup/email/runner evidence, restore and transaction-safe corrections. |
| Owner checkpoints | Early artifact, allocation demo, first-version acceptance | T-005/T-010/T-016: owner response recorded; ordinary gates not mechanically enforced. |
| brief.md Later | Online fee payments; tool-lending shelf | Explicitly deferred, no first-version implementation tickets. |

## Ticket inventory

| Ticket | Phase | Outcome | Blocked by |
|---|---|---|---|
| T-001 | foundation | Establish application, email and verification tooling | none |
| T-002 | foundation | Register plots, seasons, households and verified enrollment | T-001 |
| T-003 | foundation | Implement passwordless access, invitations and recovery | T-001, T-002 |
| T-004 | foundation | Prototype accessible first-version phone journeys | none |
| T-005 | foundation | Checkpoint: phone journeys and allocation examples | T-004 |
| T-006 | allocation | Build seasonal plot applications | T-002, T-003, T-005 |
| T-007 | allocation | Enforce allocation priority and atomic persistence | T-002, T-005, T-006 |
| T-008 | allocation | Build coordinator allocation and round finalization | T-003, T-006, T-007 |
| T-009 | allocation | Implement strict FCFS waiting list and promotion | T-006, T-007, T-008 |
| T-010 | allocation | Checkpoint: allocation and waiting-list demonstration | T-008, T-009 |
| T-011 | daily-use | Show gardener allocation and season dates | T-003, T-005, T-006, T-007 |
| T-012 | post-v1-map | Post-v1: coordinator plot map | T-002, T-003, T-005, T-007, T-016 |
| T-013 | daily-use | Report plot problems and resolve them | T-003, T-005, T-007 |
| T-014 | daily-use | Send daily new-problem email digest | T-001, T-013 |
| T-015 | launch | Establish deployment, recovery and correction procedures | T-008, T-009, T-011, T-013, T-014 |
| T-016 | launch | Checkpoint: first-version acceptance | T-010, T-011, T-013, T-014, T-015 |
