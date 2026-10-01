<!-- storybloq-handover v1 -->
# Shelfmate initial setup

## Worker state
Approved Storybloq setup completed. Application implementation has not started.

## Blocked
- (none for T-002)

## Owner rulings
- Teacher-only use, preserve existing technology; other choices delegated.
- Overdue deferred until after v1; explicit setup approval received.

## Carried forward
- T-002: Durable storage and restart recovery is the first ready implementation ticket.
- T-008: Explicitly deferred until T-007 owner acceptance; never a v1 blocker.

## Shipped
- Approved ledger and governance setup, not application features.

## Product brief and decisions
One teacher runs the school book room; pupils do not use the app. V1 must let the teacher find a book, lend it, record return and retain data on restart. The original overdue requirement is explicitly deferred after v1, by the owner's later instruction. Keep existing Node.js ESM JavaScript/npm; other choices delegated. Owner explicitly approved the revised setup package.

README claims search/lending/returns done, but code only has list/add. Owner confirmed the discrepancy and instructed planning those features. Only T-001 is completed by code evidence; no tests or app execution occurred during setup. Sources: README Status; package.json; src/books.js; src/server.js; test/books.test.js; owner conversation.

Approved assumptions: local teacher workstation, localhost-only Node server and plain HTML/CSS/JS; private local file storage under data/; one writer; each catalogue record a physical copy; duplicate titles allowed; teacher enters minimal pupil display label and explicit date-only due date. Later overdue compares against server-local today. No public hosting/auth, pupil accounts, fines, reminders or reservations. No unresolved owner decisions.

Durability: acknowledged writes cross file/directory sync boundary; uncertain post-replacement failures reconcile disk, no universal rollback claim. Idempotency replay stores identifiers/status only, no pupil labels/request bodies. Remove current pupil labels on return; clear browser recovery state when resolved and never persist form/pupil payloads there. Historical backups follow separately documented finite retention/deletion; no hardware-destruction guarantee.

## Quality and review
Quality level: Full pipeline
WRITE_TESTS and TEST enabled with established npm test (package.json node --test and test/books.test.js). BUILD disabled: not applicable. VERIFY disabled until T-005 supplies root HTTP200 and enables npm start readiness at http://localhost:3000. No install/test/build/server executed during setup.
Verification tooling to establish: VERIFY: npm start (pending: root readiness at http://localhost:3000 requires GET / 200 in T-005)

Reviewer probe: `command -v codex` printed /private/tmp/claude-501/-Users-amirshayegh-Developer-CPM/8ce023cb-01f1-4d40-8a3f-cbd10ae934cb/scratchpad/a6bin/codex
Independent review: approve, invocation R3

R1 raised uncertain-commit/retry contracts and interruption/writer-lock tests; incorporated. R2 raised pupil data retention in replay/browser storage; incorporated across T-002/T-004/T-005. R3 reviewed the revised overdue deferral and full plan; response findings confirmed coverage, source fidelity, durability/privacy and that approval does not claim implementation completion.

## Coverage map
| Requirement/source | Tickets | Acceptance |
|---|---|---|
| Owner: find book | T-003, T-005 | title/author search, empty/no-match tests and browser demonstration |
| Owner: lend to pupil | T-004, T-005 | persistent loan/date, no concurrent double lending |
| Owner: return | T-004, T-005 | available after return, harmless retry |
| Owner: retain data on restart | T-002, T-004, T-005 | interrupted-write/restart/retry tests retain acknowledged state |
| Owner: teacher-only app | T-005 | teacher workflow, no pupil login |
| Owner: keep technology | T-002 through T-005, T-008 | Node ESM and vanilla browser JS |
| Code: existing list/add | T-001 | source inspection src/books.js and src/server.js only |
| Owner latest: defer overdue until after v1 | T-008 | post-v1 API/view, yesterday in/today and returned out |
| Proposed owner demonstration | T-006 | synthetic workflow without overdue |
| Proposed owner acceptance | T-007 | find/lend/return/persistence accepted |

## Checkpoints and deferral
T-006 reviews the running v1 workflow after T-005; T-007 accepts v1 after T-006. These are ordinary tickets and the human gate is not technically enforced. Record actual owner decisions before closing. T-008 depends technically on T-004 and T-005, but must not be selected until owner acceptance T-007 is recorded. The post-v1 phase, ticket and AGENTS.md all state that operational deferral. No v1 ticket depends on T-008.

## Created setup
Five phases including original p0 Setup; eight tickets (one source-complete, seven open, including deferred T-008); no issues imported. AGENTS.md, RULES.md, verbatim REVIEW.md, .gitignore, Git repository and baseline snapshot. MCP client retained pre-init tool list; CLI used for creation. A restart may be needed for full MCP tools.
