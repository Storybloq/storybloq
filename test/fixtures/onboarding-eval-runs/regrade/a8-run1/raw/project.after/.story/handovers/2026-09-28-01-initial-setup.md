<!-- storybloq-handover v1 -->

# Plotbook initial setup

## Worker state
- Setup approved and completed; no application implementation performed, no install/test/build/dev commands run.
- Created six total phases (p0 Setup plus Foundation, Applications, Problems, Launch, Later), 17 open tickets: 16 first-version and 1 deferred map. No issues imported.
- Git initialized; governance files read back: AGENTS.md 3593 bytes, RULES.md 3041 bytes, REVIEW.md 4726 bytes (verbatim skill template). .gitignore includes snapshots, sessions, status.
- CLI used after init because client retained pre-init MCP tools; restart may be needed to expose full MCP surface.
- Snapshot saved before this handover.

## Blocked
- No external blocker to T-001 foundation work.
- Framework in T-001 and hosting/email provider, configured garden timezone/sender/recipient and finite retention periods in owning implementation tickets remain to establish. No owner answer is needed to begin.
- All four verification recipe stages explicitly disabled while tooling is pending.

## Owner rulings
- Owner: "Sign-in: gardeners sign in with an emailed one-time link; no passwords."
- Owner: "Problem notifications: the coordinator gets one email a day listing new problem reports."
- Owner delegated judgement on unspecified choices and stated no technology preference.
- Owner: "Defer the plot map view to after the first version." This supersedes brief.md First version item 5. Keep source brief intact. Ordinary plot records and allocation lists/forms remain first-version.
- Owner: "Approve setup." This approves the R3 package, not future product acceptance or automatic autonomous execution.

## Product brief and accepted assumptions
Plotbook replaces paper forms and a wall chart for Riverside Community Garden: 40 plots, approximately 60 households and one coordinator, March–October seasons. First version demonstrates seasonal applications, priority allocation and FIFO waiting list, own allocation/dates, own-plot reporting and coordinator resolution, with phone usability, plain language, large text and coordinator-only contact details.
Technology planned: TypeScript/npm responsive web application with PostgreSQL; framework chosen in T-001. No functionality is claimed complete.
Assumptions: one stable coordinator-confirmed household may have verified member accounts; duplicates reconciled before allocation and earliest valid application order retained. Seasons default March 1–October 31, editable; set garden-local timezone before cutoff-sensitive use. Returning priority is for last-season holders whose application arrives strictly before February 1 local midnight; no final new-applicant allocations before cutoff or while eligible returners remain unresolved. Late returners are ordinary applicants. Preferences are advisory. FIFO applies globally across eligible unallocated applicants, including returners; original timestamp plus stable sequence breaks ties. Unresolved household declarations require reconciliation before vacancy assignment without losing order. No automatic offer expiry.
Digest assumption: 09:00 local; no empty emails; include newly created reports even if resolved before sending; durable delivery and catch-up, contacts omitted. Finite retention/deletion including backup expiry and deletion replay after restore is implemented in T-013 and reviewed by coordinator before launch.
Only source conflict: original map requirement vs latest owner deferral; owner decision takes precedence. No invented research, target latency, or completed application work.

## Coverage map
| Source | Requirement / observable acceptance | Tickets |
|---|---|---|
| brief.md First version 1 | Coming-season application with 0–3 distinct preferred plots, confirmed once despite retry | T-005 |
| brief.md First version 2 | Coordinator allocates and waitlists in original application order | T-006, T-007 |
| brief.md First version 3 | Gardener sees own plot and season dates, including empty/pending states | T-004, T-008 |
| brief.md First version 4 | Gardener reports own plot problem; coordinator sees open reports and resolves persistently | T-010, T-011 |
| brief.md First version 5, superseded by owner | DEFERRED: coordinator 40-plot map after first-version acceptance | T-017, blocked by T-004, T-006, T-016 |
| brief.md Rules | One plot per confirmed household per season and one holder/plot, including concurrency | T-003, T-004, T-006 |
| brief.md Rules | Prior-season holders applying before February 1 get priority; deadline tests | T-004, T-006 |
| brief.md Rules | Global FIFO: original timestamps/sequence, full eligible population, no selective queue bypass | T-005, T-007 |
| brief.md Constraints | Phone use, large text, plain language, keyboard/screen-reader and state coverage | T-001, T-002, all UI tickets, T-014 |
| brief.md Constraints | Contacts coordinator-only; server-side negative authorization tests; no sensitive logs | T-003, feature tickets, T-013, T-014 |
| Owner decision | Emailed single-use link, no passwords; expiry/replay/resend/inbox evidence | T-003, T-013, T-014 |
| Owner decision | Daily new-report email; retry/catch-up, DST, resolved-since-created cases | T-012, T-013, T-014 |
| brief.md Later | Payments DEFERRED; no first-version implementation | none |
| brief.md Later | Tool lending DEFERRED; no first-version implementation | none |
| Supporting work | Staging, provider configuration, backup/restore, implemented retention/deletion | T-013 |
| Supporting work | Full staging acceptance before production release | T-014, T-015 |
| Owner checkpoints | Prototype, local allocation milestone, released first-version acceptance | T-002, T-009, T-016 |

## Quality and review
Quality level: Full pipeline.
Business logic uses TDD. No established verification commands. T-001 establishes actual scripts and collected tests before enabling stages; pending commands are proposals, not runnable evidence.
Verification tooling to establish: WRITE_TESTS: npm test (pending: no application manifest, test script or collected test sources)
Verification tooling to establish: TEST: npm test (pending: no application manifest, test script or collected test sources)
Verification tooling to establish: BUILD: npm run build (pending: no application manifest or build script)
Verification tooling to establish: VERIFY: npm run dev (pending: no application manifest, dev script or established readiness URL; proposed http://localhost:3000)

Independent review: pass, invocation R3
Captured R3 response: {"verdict":"pass","findings":[]}
Earlier reviews prompted explicit cutoff protection, complete-population FIFO, household confirmation/merge semantics, correct prototype gating, local allocation artifact, implemented retention, and staging verification before production. R3 reviewed the complete map-deferred package; no outstanding findings.

## Owner checkpoints
- T-002 reviews T-001 fictional phone prototype and gates subsequent UI work; map excluded.
- T-009 reviews a LOCAL working allocation/waitlist/own-status demonstration, blocked by T-007/T-008; no map or staging prerequisite.
- T-016 accepts released first version with T-014/T-015 evidence, blocked by T-015; map/payments/tool lending excluded.
- Stage-1 limitation: checkpoints are ordinary tickets; Storybloq does not mechanically enforce owner review. Record actual owner acceptance.
- T-017 deferred map depends on T-004, T-006 and T-016. No first-version ticket depends on it. Map-specific design review belongs to its later implementation.

## Proposal reference mapping
- A: T-001
- B: T-002
- C: T-003
- D: T-004
- E: T-005
- F: T-006
- G: T-007
- H: T-008
- J: T-009
- K: T-010
- L: T-011
- M: T-012
- N: T-013
- O: T-014
- Q: T-015
- P: T-016
- I: T-017

## Carried forward
- Start T-001: establish app, database, actual tooling and phone prototype. All tickets are open.
- Use $story for context; autonomous mode is not started.
- Do not accidentally restore map scope from the unchanged original brief.

## Shipped
- Approved Storybloq setup and governance only, not application functionality.
