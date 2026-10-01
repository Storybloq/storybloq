# Court bookings

A Django application for about 80 tennis-club members to reserve the club's three courts using individual club accounts. The first version supports availability, one-hour bookings up to seven days ahead, at most two upcoming bookings per member, and cancellation until two hours before start.

## Scope and architecture

- Keep Python, Django and SQLite. Use server-rendered Django pages and Django authentication.
- Existing code: `bookings/models.py` declares Booking with court, starts_at, member text and a unique court/start constraint. `bookings/tests.py` only verifies field assignment. Authentication pages, migrations, member ownership, booking services and cancellation are planned, not completed.
- `club/settings.py` contains current project configuration. `manage.py` is the Django entry point.
- Planned: real member foreign keys; one shared atomic reservation path; all time and member-limit checks inside that transaction; cancellation uses compatible transaction rules. Do not assume SQLite provides row locks through select_for_update.
- Guest payments are deferred. Public signup, recurring bookings, a public API and production deployment are outside this first version.

## Approved setup assumptions

- Staff provision accounts and handle credential resets. Members see availability and only their own identifying booking details.
- Configurable club timezone, initially UTC; all 24 hourly starts are initially available. The early owner checkpoint reviews these policies.
- Starts must be strictly future and no later than now plus seven days. Upcoming means starts_at > now. Cancellation is allowed with at least two hours remaining, including equality.
- Cancellation can delete the reservation; no audit retention requirement was stated. Existing member data must be mapped explicitly during migration, never silently discarded.
- About 80 members is context, not a throughput or latency acceptance target. No unresolved blocking owner decision remains.

## Testing and tracking

Use `make test` (Makefile invokes pytest; pytest.ini collects tests.py and test_*.py). Follow TDD for business logic and test time boundaries, permissions, migrations and separate-connection database races. Tests were not run during setup.

The approved quality level is Full pipeline: WRITE_TESTS and TEST use make test; BUILD is disabled because no artifact build is established; VERIFY is disabled pending runnable URL/server configuration. Proposed verification: python manage.py runserver at http://localhost:8000.

Use `$story` to load `.story/` context. T-001 records inspected existing code; T-002 and T-003 are ready to begin. T-005 owns preventing double bookings; T-006 adds member/time rules in the same atomic operation. T-004 and T-009 are owner checkpoints, but Storybloq does not automatically enforce those gates. The initial setup handover records the complete coverage map and approval history.
