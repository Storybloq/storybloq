<!-- storybloq-handover v1 -->

# Session Handover: approved Court bookings setup

## Worker state

Setup complete; application implementation has not started. Four phases including default p0, ten planned tickets, no issues imported and no tickets claimed complete.
Next: T-001 Individual accounts and Django foundation. T-005 is the separate double-booking-prevention ticket requested by the owner.
Initial baseline snapshot saved before this handover. Git initialized; no commit was requested or created.

## Blocked

No external blocker to T-001. Server verification remains pending as recorded below. Hosting is TBD but does not block local first-version implementation.

## Owner rulings

The owner specified approximately 80 club members, each with an individual club account; booking up to seven days ahead; at most two upcoming bookings; retain Django. Remaining questions were delegated to judgment.
The owner requested that double-booking prevention be split into its own ticket. The revised package was reviewed as R2 and the owner explicitly replied "Approve setup." Decisions are summarized here as setup context, not separate binding ruling records.

## Carried forward

Start T-001, then follow the actual blockedBy dependencies. T-004 preserves existing uniqueness; T-005 safely installs active-slot uniqueness and owns conflict/concurrency/reuse verification; T-006 adds quota enforcement. Live integration T-008 waits for the preview checkpoint and safe services.
Owner checkpoints T-003 and T-010 are ordinary tickets/dependencies; stage-1 does not enforce human approval before closure.

## Shipped

Storybloq configuration, default p0 plus Accounts and preview / Safe booking / Member experience and acceptance milestones; ten tickets and dependencies; AGENTS.md (3195 bytes), RULES.md (2879 bytes), REVIEW.md (4726 bytes, verbatim template), .gitignore (155 bytes). Every governance file was read back. Git repository initialized. Snapshot saved. No feature implementation, dependency installation, tests, build or dev server run during setup.

## Product brief and observable acceptance

Source README: three tennis courts, one-hour bookings, no double booking of a court/slot, member cancellation until two hours before start. Guest-booking payment is later scope.
Owner additions: approximately 80 individual accounts, seven days ahead, at most two upcoming bookings, keep Django.
First-version acceptance: a member signs in, sees all eligible slots, books a valid court/hour, sees their own upcoming bookings, receives a clear rejection for a third active future booking, cannot double-book even under races, and can cancel only their own booking with at least two hours left. Exactly two hours is allowed; below is denied. Cancellation releases the slot and quota while preserving history.
Acceptance evidence includes independent file-backed SQLite connection races, boundary tests, ownership/CSRF and migration tests, full Django-client journeys, keyboard walkthrough and owner demonstration.

## Approved assumptions and boundaries

Staff provisions accounts and resets passwords; no public signup. Server-rendered Django forms, Django sessions and SQLite retained.
Configurable club timezone initially UTC. Starts align with a local clock hour, duration exactly one elapsed hour; reject nonexistent local times and distinguish repeated hours by offsets/UTC instants.
Start must be strictly future and <= now+168h. The whole rolling window can span eight local dates and every eligible hour must be visible.
Upcoming means active start>now. No additional overlap rule or opening-hour restrictions were introduced.
Member identity resolved server-side; only owners cancel, other member names not exposed.
Safe explicit legacy member mapping; unresolved mappings block migration; no guessed ownership or silent data loss.
Deferred: guest payments, public signup, notifications, recurring bookings, public deployment execution. Hosting undecided.
No source conflicts were found. Existing baseline model and uniqueness are code evidence only, not completed product capabilities.

## Coverage map

| Requirement / decision | Source | Tickets and evidence |
|---|---|---|
| Approximately 80 individual club accounts | Owner instructions | T-001 login/access/provisioning, T-009 staff operating guide |
| Three courts and one-hour slots | README | T-004 court/hour/DST/persistence tests, T-008 UI, T-009 integrated evidence |
| No double bookings | README; owner's explicit split request | T-005 database constraint/migration and real concurrent-request tests; T-008 conflict UI; T-009 evidence |
| Up to seven days ahead | Owner instructions | T-004 rolling inclusive 168h validation; T-002/T-008 full window navigation even across eight dates |
| At most two upcoming bookings | Owner instructions | T-006 atomic quota and concurrent same-member tests; T-008 feedback; T-009 evidence |
| Cancellation until two hours before start | README | T-007 ownership and inclusive-cutoff tests, slot/quota release and race tests; T-008 UI |
| Keep Django | Owner instructions | All implementation tickets retain Python/Django/SQLite and server-rendered forms |
| Staff accounts, no public signup | Delegated judgment | T-001 admin-only provisioning/reset; T-009 guide |
| Configurable UTC initially, hourly starts, aware times | Delegated judgment | T-004 validation/DST, T-002/T-008 labels, T-003 inspection |
| Privacy, ownership and CSRF | Delegated judgment | T-001/T-007/T-008 access and forged-request tests |
| Safe legacy member mapping | Existing Booking.member char field; safeguard | T-001 explicit mapping, unresolved rows block migration |
| Accessible errors, empty states and recovery | Delegated judgment | T-002/T-008 templates and keyboard walkthrough; T-009 evidence |
| Staff operation and recovery | Delegated judgment | T-009 account/timezone setup, backup/restore and deployment configuration checklist |
| Owner checkpoints | Setup workflow | T-003 early artifact review; T-010 first-version acceptance |
| Guest payments | README later scope | Explicitly deferred; no first-version ticket |

## Ticket inventory

- T-001 (A): Individual accounts and Django foundation; phase accounts-preview; blocked by none.
- T-002 (B): Accessible booking-flow preview; phase accounts-preview; blocked by T-001.
- T-003 (C): Checkpoint: member journey and timezone display; phase accounts-preview; blocked by T-002.
- T-004 (D): Court slot validation and booking persistence; phase safe-booking; blocked by T-001.
- T-005 (J): Prevent double bookings; phase safe-booking; blocked by T-004.
- T-006 (E): Enforce two upcoming bookings per member; phase safe-booking; blocked by T-005.
- T-007 (F): Own-booking cancellation and cutoff enforcement; phase safe-booking; blocked by T-006.
- T-008 (G): Live availability, booking and cancellation screens; phase member-experience; blocked by T-003, T-006, T-007.
- T-009 (H): Acceptance evidence and staff operating guide; phase member-experience; blocked by T-008.
- T-010 (I): Checkpoint: first-version acceptance; phase member-experience; blocked by T-009.

## Quality and pending tooling

Quality level: Full pipeline
WRITE_TESTS enabled: make test, onExhaustion plan.
TEST enabled: make test.
Command established from README/Makefile plus pytest.ini collection of bookings/tests.py; no tests run during setup.
BUILD disabled: no build command established or proposed for this Django app.
VERIFY disabled pending runnable routing/readiness; proposed start command python manage.py runserver 127.0.0.1:8000, proposed readiness http://127.0.0.1:8000/accounts/login/.
Verification tooling to establish: VERIFY: python manage.py runserver 127.0.0.1:8000 (pending: runnable routes and readiness endpoint are not established)

## Independent plan review

R1 identified that the rolling window may span eight dates; the clarification was incorporated in preview/integration/acceptance criteria. Following the owner's split request, R2 reviewed the full revised plan, including separate validation/persistence and double-booking responsibilities, migration safety, quota dependencies and full acceptance coverage. No unresolved review changes.
Reviewer probe: `command -v codex` printed /private/tmp/claude-501/-Users-amirshayegh-Developer-CPM/8ce023cb-01f1-4d40-8a3f-cbd10ae934cb/scratchpad/a6bin/codex
Independent review: approve, invocation R2
