<!-- storybloq-handover v1 -->

# Plotbook initial setup

## Worker state
- Setup complete; application implementation has not started.
- Created default p0 plus foundation, allocation, reporting and readiness phases; 17 open tickets, no imported issues.
- Ready next: T-001 foundation or T-002 mobile prototype.
- Git initialized; no commits, installs, builds, tests or dev server run during setup.
- MCP init succeeded; remaining creation tools not exposed, so CLI used. Restart client if full MCP tools remain unavailable.

## Blocked
- No blocker for T-001/T-002.
- Later operations require garden timezone, actual plot layout/labels, household reconciliation and prior-season paper records, verified sender/coordinator email and hosting credentials. Resolve browser matrix/provider feasibility in T-001; retention/lifecycle in T-015.
- Recipe stages disabled pending actual tooling.

## Owner rulings
- Source brief.md establishes all V1 outcomes, allocation rules and privacy/mobile constraints; no conflicting sources or existing code.
- Owner decision: "Sign-in: gardeners sign in with an emailed one-time link; no passwords."
- Owner decision: "Problem notifications: the coordinator gets one email a day listing new problem reports."
- Owner delegates other choices: "No preference, use your judgement."
- Delegation was not treated as setup approval. Owner subsequently explicitly approved the reviewed package: "yes, go ahead".
- Quality level: Full pipeline, for business rules, workflow and privacy.
- Planned stack: Python/Django with PostgreSQL, HTML/CSS and minimal JavaScript. Email/scheduler/hosting selected in T-001; no provider purchase during setup.

## Carried forward
- T-001: establish application, database, email, smoke tests, static collection, health endpoint and commands.
- T-002: create phone-first synthetic journey prototype.
- T-003, T-011, T-017: owner checkpoints. Stage-1 limitation: ordinary tickets, no technical enforcement of human approval.
- All other ticket dependencies wired to actual IDs. No completed product tickets.

## Shipped
- Storybloq planning ledger, project guidance AGENTS.md, RULES.md, verbatim REVIEW.md, .gitignore and initial snapshot.
- Application features: none.

## Product brief and observable acceptance
Riverside Community Garden has 40 plots and about 60 households. A gardener can sign in by email link, apply for the coming March-October season with up to three preferences, see their allocated plot and dates, and report a problem. The coordinator can review and allocate, manage the FIFO waiting list, inspect a 40-plot grid, resolve problems and receive the daily report email.
Acceptance demonstrates every requirement below with synthetic fixtures and PostgreSQL-backed tests plus phone/keyboard walkthroughs. One plot per household/season, timely-returner initial priority and strict waiting-list order must hold even under retries/concurrency. Contact details remain coordinator-only.
Payment and tool lending are later work, not part of V1.

## Approved assumptions
- One email login represents a household; coordinator reconciles duplicate household records without losing history or application order.
- Preferences are optional, distinct, ordered and advisory (0-3). No promise of preferred or prior plot.
- Season defaults March 1-October 31, editable within March-October. Garden timezone must be configured.
- Initial allocation starts at February 1 00:00 of the season year in garden time. Last-season holders applying strictly before that instant receive available plots before ordinary applicants. A reason or waitlisted status cannot bypass priority. Explicit withdrawal is audited.
- Within initial priority groups, application timestamp then stable ID breaks ties; late returners join ordinary pool. With more eligible returners than plots, no ordinary applicant is allocated.
- Finalize initial allocation only after the deadline when capacity is exhausted or every active applicant is allocated. Remaining applicants enter global FIFO order; returner priority does not reorder that queue.
- Edits preserve original submission timestamp. Only queue head receives a vacancy; no automatic expiry or arbitrary skipping.
- Daily report email defaults to 09:00 garden local time, with an empty-day summary. Include reports created since the previous covered interval even if now resolved. Failed delivery retains backlog; prove delivery deduplication before release.
- No attachments, public discussion, or report reopen workflow in V1.


## Requirement coverage
| Requirement/source | Planned evidence and tickets |
|---|---|
| brief.md Background: 40 plots, March-October, ~60 households | T-004 season/plot/history setup; T-010 grid; T-016 fixtures |
| First version must 1: apply, up to three preferences | T-006 submits and reloads valid preferences; rejects invalid/duplicate/>3 |
| First version must 2: coordinator allocation and waiting list | T-007 priority-safe allocation; T-008 original-order queue and head-only promotion |
| First version must 3: own allocation and season dates | T-009 pending/waiting/allocated dashboard |
| First version must 4: plot report and resolution | T-012 own-plot report; T-013 open list and resolve |
| First version must 5: coordinator plot grid | T-010 exactly 40 labelled plots, correct holders and accessible alternative |
| Rules: one plot per household/season | T-004 constraints; T-007 PostgreSQL transaction/race tests |
| Rules: last-season holders applying before Feb 1 first | T-004 history; T-007 date-boundary/priority enforcement tests |
| Rules: waiting list strictly FCFS | T-008 immutable original timestamp, stable ties, no reorder/skip |
| Constraints: phone, large text, plain language | T-002 prototype; T-003 owner review; all UI tickets; T-016 phone/keyboard evidence |
| Constraints: contacts coordinator-only | T-004/T-005 server roles; T-016 cross-role HTML/API/email checks |
| Owner: emailed single-use link, no passwords | T-005 expiry/replay/race/resend and captured-email walkthrough |
| Owner: one daily email listing new reports | T-014 durable daily batch and retry evidence; T-015 scheduled staging delivery |
| Derived enabling/reliability work | T-001 foundation; T-015 recovery/operations; T-016 integrated evidence |
| Owner milestones/acceptance | T-003 prototype; T-011 allocation demonstration; T-017 V1 acceptance |
| Later: payment and tool lending | Explicitly deferred; no V1 implementation tickets |

## Independent review record
R1 captured findings required preventing reason/waitlisted disposition from bypassing returning priority, and preventing early allocations from consuming capacity before the Feb 1 deadline. The plan was revised to require actual priority allocation and gate initial allocation until Feb 1. R2 captured response: {"verdict":"approve","findings":[]}.

Independent review: approve, invocation R2

## Verification recipe
Quality level: Full pipeline. WRITE_TESTS, TEST, BUILD and VERIFY explicitly disabled initially. No stage command is established because this was a brief-only repository. T-001 establishes supporting configuration and test sources before enabling corresponding stages. VERIFY readiness proposal: http://127.0.0.1:8000/health/.
Verification tooling to establish: WRITE_TESTS: python manage.py test (pending: no runner or collected test sources; establish in T-001)
Verification tooling to establish: TEST: python manage.py test (pending: no runner or collected test sources; establish in T-001)
Verification tooling to establish: BUILD: python manage.py collectstatic --noinput (pending: no application or static configuration; establish in T-001)
Verification tooling to establish: VERIFY: python manage.py runserver 127.0.0.1:8000 (pending: no application or /health/ readiness endpoint; establish in T-001)

## Initial validation
File read-back confirmed AGENTS.md 4847 bytes, RULES.md 3712 bytes, REVIEW.md 4726 bytes and .gitignore 100 bytes. Final ledger validation and dependency audit follow this handover creation; do not infer application test results.
