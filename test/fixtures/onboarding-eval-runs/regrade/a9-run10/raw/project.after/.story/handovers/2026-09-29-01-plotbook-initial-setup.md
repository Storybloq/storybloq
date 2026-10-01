<!-- storybloq-handover v1 -->

# Plotbook initial setup

## Worker state

Setup approved by owner: "yes, go ahead". The earlier "No preference, use your judgement" delegated choices but was not treated as file-creation approval.

Created four milestones after default p0 (five phases total), 15 open tickets (12 implementation and three checkpoints), governance files and Git repository. No issues imported. No application code, tests, builds, deployments or product capabilities are complete. CLI fallback used because the MCP creation tools remained unavailable after init; a client restart may expose them.

## Blocked

No blocker to T-001. Technology choice and actual verification commands are intentionally deferred to that ticket. Live email and production readiness require owner-supplied provider credentials/domain; this does not block fake-mail local development.

## Owner rulings

Source: brief.md in full and setup conversation. Owner chose emailed one-time sign-in links with no passwords and a daily email of new reports to the coordinator; technology and uncovered decisions delegated to implementer. There were no source conflicts. No GitHub import requested.

- Household identity: coordinator validates registrations and duplicate households before applications. Email addresses are household memberships, not proof of distinct households; trusted prior-season holdings determine returning status.
- Applications: one per household/season; 0-3 distinct optional preferences, not guaranteed; edits permitted until coordinator closes applications; immutable first submission time plus stable tie-break sequence.
- Seasons: coordinator supplies exact dates within March-October, timezone and digest time. No geographic timezone inferred. Cutoff is strictly before local February 1 midnight; coordinator approves starting roster/configuration before opening.
- Allocation: eligible timely returners first, chronological within that group; late returners with other applicants. Invalid/withdrawn applications may be excluded with reason. New applicants cannot bypass eligible pending returners.
- Queue: original application order regardless returning status; no skipping; one active offer at a time; coordinator records response after contacting gardener; acceptance allocates atomically, decline removes with reason; no automatic offer expiry.
- Reporting: only own active allocated plot, plain text, no attachments/chat; historical/resolved reports remain private; reopening deferred.
- Daily mail: skip empty days; include all reports created since last successful delivery cutoff, including since-resolved reports; preserve backlog after failure; provider idempotency where possible, uncertain external delivery may duplicate a message.
- Technology: delegated selection in T-001 with relational transactions, expiring tokens and scheduled jobs. Language/framework/database/hosting/mail provider remain TBD. Use synthetic data/fake mail. Owner supplies credentials and verified domain before live delivery; absence blocks release, not local work.
- Release: owner-visible configurable retention policy and recovery evidence before launch. Setup does not authorize production deployment.
- Other boundaries: single garden, no optimization, public directory, social sign-in or passwords. Payments/tool lending explicitly deferred.

## Carried forward

- T-001: Establish application and verification tooling. Choose/document stack and commands, build the initial skeleton, and prove the tooling before enabling Full pipeline stages. This is the only currently unblocked implementation ticket.
- T-005: owner reviews the phone journey and household onboarding; gates application/report UI and gardener status. T-007 backend allocation work can proceed independently.
- T-010: owner reviews allocation/map milestone; gates final acceptance, not problem handling.
- T-015: owner accepts the first version against agreed outcomes; gates production deployment. Checkpoints are ordinary tickets and approval is not automatically enforced; record owner acceptance before closing.

## Shipped

Project ledger and governance only: AGENTS.md, RULES.md, verbatim REVIEW.md, .gitignore, initialized Git repository, linked tickets, initial baseline snapshot and setup note. Source brief preserved. No completed product tickets or fabricated existing capabilities.

## Product brief and observable acceptance

Gardeners from about 60 households can apply for one of Riverside Community Garden's 40 seasonal plots with up to three preferences; see their own allocation and dates; report a problem and see its resolution. The volunteer coordinator can review and allocate applications under returning-gardener priority, keep unallocated applicants in strict application order, view all 40 plots with holders, and resolve problems. Sign-in is emailed one-time links. Coordinator receives the daily report digest. Journeys work on phones with large text/plain language, and gardener contact details remain coordinator-only. Full source-to-ticket coverage and acceptance evidence follow; each ticket contains detailed acceptance, failure behaviour and verification.

| Source / requirement | Planned evidence |
|---|---|
| brief.md Background: 40 plots, March-October seasons | T-002 records/configuration; T-008 map |
| First version 1: application and up to three preferences | T-006 |
| First version 2: review, allocate, waitlist in application order | T-007, T-008 |
| First version 3: own allocation and season dates | T-009 |
| First version 4: own-plot problem reporting and resolution | T-011, T-012 |
| First version 5: coordinator 40-plot grid with holders | T-008 |
| Rules: one household plot per season | T-002 constraints, T-007 transactions |
| Rules: timely returning gardeners first | T-002 prior holdings, T-007 cutoff/priority tests |
| Rules: strictly first-come-first-served waiting list | T-006 immutable ordering, T-007 queue, T-008 UI |
| Constraints: phone, large text, plain language | T-004 prototype, T-005 owner review, all UI tickets, T-014 walkthrough |
| Constraints: contact details coordinator-only | T-003 authorization, T-008/T-009 views, T-014 privacy evidence |
| Owner: emailed one-time sign-in links, no passwords | T-003 |
| Owner: one daily new-report email | T-013 |
| All first-version acceptance conditions | T-014 verification, T-015 owner acceptance |
| Later: payments and tool lending | Explicitly deferred, no implementation ticket |

## Quality and review

Quality level: Full pipeline

TDD for business rules and state transitions. All WRITE_TESTS, TEST, BUILD and VERIFY overrides explicitly disabled pending T-001; none has an established command. Commands must be based on the selected implementation stack, not Storybloq's Node runtime.

Verification tooling to establish: WRITE_TESTS: TBD in T-001: selected stack test command (pending: no application stack, test command or test sources)
Verification tooling to establish: TEST: TBD in T-001: selected stack test command (pending: no application stack, test command or test sources)
Verification tooling to establish: BUILD: TBD in T-001: selected stack build/check command (pending: no manifest or build tooling)
Verification tooling to establish: VERIFY: TBD in T-001: development server and readiness URL (pending: no application server or readiness configuration)

Reviewer probe: `command -v codex` printed /private/tmp/claude-501/-Users-amirshayegh-Developer-CPM/8ce023cb-01f1-4d40-8a3f-cbd10ae934cb/scratchpad/a6bin/codex
Independent review: approve, invocation R1

Captured reviewer response:
```json
{"verdict":"approve","findings":["The plan covers all first-version requirements and owner decisions, with payments and tool lending deferred. Additional domain choices are explicitly identified as assumptions for approval.","Dependencies are coherent and acyclic. Phone usability, privacy, allocation rules, email reliability, and recovery have concrete acceptance criteria and planned verification.","Architecture selection in A1 is feasible; disabled pipeline stages and pending commands accurately reflect the absence of implementation tooling.","Human approval gates require manual enforcement. Production delivery remains dependent on owner credentials, a verified sending domain, and release acceptance.","The inventory totals 15 tickets: 12 implementation tickets and 3 checkpoints. Remove the stale opening reference to 17 tickets.","Approval applies to the proposed setup only. Implementation, tests, deployment, and operational readiness remain unverified; setup writes still require explicit package approval."]}
```
The count typo was corrected before approval. No scope or dependency changes were made in response to the review.
