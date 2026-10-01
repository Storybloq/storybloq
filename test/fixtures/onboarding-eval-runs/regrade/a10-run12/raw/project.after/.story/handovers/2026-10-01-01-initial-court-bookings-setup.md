<!-- storybloq-handover v1 -->

# Session Handover: approved Court bookings setup

## Worker state

Setup complete; implementation has not started. Four phases (p0, foundation, reservations, acceptance), nine tickets, zero imported issues. T-001 alone is complete by source inspection. T-002 and T-003 are ready.
Created and read back AGENTS.md (2938 bytes), RULES.md (1868 bytes), REVIEW.md (4726 bytes, verbatim skill template) and .gitignore (115 bytes). Git initialized; no commit made. CLI used after init because this session retained the pre-init MCP tool list; restart client if full tools remain absent.
Validation passed with zero errors/warnings. make test is established but was not run. No dependency installation, build or dev server execution occurred. Snapshot saved before this handover.

## Blocked

- No unresolved blocking owner decision.
- VERIFY remains disabled pending runnable Django URL/server configuration.

## Owner rulings

- Source README.md: three courts, one-hour bookings, no double booking of same court/slot, cancellation up to two hours before start; guest payments later.
- Owner answers: about 80 club members, each with own club account; bookings up to seven days ahead; at most two upcoming bookings per member; keep Django; use judgement for other questions.
- Owner asked to inspect coverage, then requested the booking ticket be split so preventing double bookings is its own ticket. R2 package implements that split.
- Owner explicitly approved the revised package with "Approve setup."
- No source conflicts found. Staff accounts, UTC/full-day hourly availability and exact boundary conventions are assumptions adopted under delegated judgement, not independently stated owner requirements.

## Carried forward

- T-002: build member accounts and authenticated shell first; source-inspected Django auth is installed but pages are absent.
- T-003: build data integrity/migrations; preserve legacy data with explicit member mapping.
- T-004: owner reviews member shell/account workflow/slot assumptions before T-008.
- T-005 owns the shared atomic reservation path and prevention of double bookings. T-006 adds seven-day/member-limit checks inside the SAME serialized transaction. Do not separate the count check from the write.
- T-009: owner accepts the first version after T-008. Checkpoints are ordinary tickets: stage-1 does not enforce owner gates.

## Shipped

- Storybloq setup only: roadmap, tickets/dependencies, recipe overrides, governance documents, git ignore and repository, initial snapshot.
- T-001 captures existing Booking fields and unique court/start declaration in bookings/models.py. bookings/tests.py only tests assignment. No existing booking/cancellation workflow claimed complete.

## Product brief and acceptance

A server-rendered Django website lets about 80 club members sign in with individual accounts, browse availability on three courts, book one-hour slots within seven days, hold no more than two upcoming bookings and cancel until two hours before start.
Acceptance: separate accounts protect ownership; competing same-slot requests persist one reservation; concurrent requests by one member never exceed two upcoming bookings; seven-day and two-hour boundaries work; cancellation releases court and quota; members complete the accessible website journey without exposing identifying details of others.
First-version demonstration is local. Guest payments are deferred; public signup, recurring bookings, public API and production deployment are excluded.

## Approved assumptions

Staff provision accounts and reset credentials. Django templates and SQLite retained unless implementation evidence requires an owner decision. Club timezone configurable, initially UTC; all 24 hourly starts initially available.
Start strictly in future, hour-aligned and <= now + seven days; upcoming means starts_at > now; cancellation allowed at >= two hours remaining, including equality.
Cancellation may delete the reservation; no audit retention requirement stated. Old member strings need explicit mapping; ambiguity must stop migration rather than discard data. 80 members is context, no invented latency/throughput targets.
Privacy: availability visible to members; identifying booking details visible only to the owner. Auth identity is server-derived and mutations are CSRF-protected.
SQLite select_for_update is not a row-lock guarantee. Shared atomic transactions, bounded contention/retry handling and separate-connection concurrency tests are required.

## Coverage map

| Source | Requirement | Tickets | Evidence planned |
|---|---|---|---|
| README | Three courts; one-hour bookings | T-003, T-006, T-008 | Invalid courts rejected; aligned one-hour slots |
| README; owner split request | No double booking | T-001 existing declaration, T-003 preserved constraint, T-005 dedicated prevention, T-008 integration | Competing separate connections create one reservation |
| README | Cancellation until two hours before start | T-007, T-008 | Exact cutoff, ownership, repeat and concurrent cancellation tests; capacity released |
| Owner | Individual club accounts | T-002, T-003, T-008 | Sign-in/out, protected access and ownership tests |
| Owner | About 80 members | T-002 | Staff provisions accounts; no fabricated performance target |
| Owner | Up to seven days ahead | T-006, T-008 | Inclusive boundary accepted; past/later start rejected |
| Owner | At most two upcoming bookings | T-006, T-007, T-008 | Third and concurrent excess rejected; cancellation restores allowance |
| Owner | Keep Django | T-002 through T-008 | Extend existing Django application |
| README | Guest payments later | Deferred | No payment work in first version |
| Setup package | Early artifact and first-version acceptance | T-004, T-009 | Owner walkthroughs; stage-1 gates not enforced |

## Dependency map

T-001 none (complete); T-002 none; T-003 -> T-001; T-004 -> T-002; T-005 -> T-002,T-003; T-006 -> T-005; T-007 -> T-006; T-008 -> T-004,T-006,T-007; T-009 -> T-008.
All dependency edges reference earlier tickets, so no cycle or self-reference.

## Quality and verification tooling

Quality level: Full pipeline, for concurrent booking business rules. TDD applies to core business logic.
WRITE_TESTS enabled: make test, onExhaustion plan.
TEST enabled: make test.
Established by README and Makefile invoking pytest, pytest.ini collection patterns tests.py/test_*.py and existing bookings/tests.py. Not executed during setup.
BUILD disabled: no established or required artifact build command; no pending build proposal.
VERIFY disabled: proposed python manage.py runserver with readiness http://localhost:8000.
Verification tooling to establish: VERIFY: python manage.py runserver (pending: runnable Django URL/server configuration is not established)

## Independent review and approval

R1 covered the initial eight-ticket plan. After the owner's requested split, native Codex reviewed the full nine-ticket R2 plan. Its findings noted requirement coverage, distinct double-booking ownership, member limits in the same serialized transaction, complete journey dependencies, separate-connection SQLite tests and appropriately limited completion claims. No unresolved finding.
Reviewer probe: `command -v codex` printed /private/tmp/claude-501/-Users-amirshayegh-Developer-CPM/c83cfa81-e710-4332-a3e2-6497fd0fdaf2/scratchpad/a6bin/codex
Independent review: approve, invocation R2
Approved package creates the project/tracking/governance/git setup described above, not the application implementation.
