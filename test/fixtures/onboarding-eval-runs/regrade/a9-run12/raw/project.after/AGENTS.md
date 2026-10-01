# Court bookings

Build a small Django website for approximately 80 tennis club members to book the club's three courts. The approved first version provides individual club-account login, hourly court bookings up to seven days ahead, at most two upcoming bookings per member, and cancellation until two hours before the start.

## Scope and sources

README.md defines the court, duration, uniqueness and cancellation requirements. Owner instructions during Storybloq setup add individual accounts, the seven-day window, the two-upcoming-booking limit and retaining Django. Guest payments are later work. Public signup, notifications, recurring bookings and public deployment execution are outside this first version.

The owner delegated remaining choices: server-rendered Django forms; staff-created accounts with admin password reset; configurable club timezone initially UTC; clock-hour starts; a rolling inclusive 168-hour booking window; cancellation allowed at exactly two hours remaining. Hosting is TBD and does not block local implementation.

## Current architecture and planned work

The existing Python/Django project has `club/settings.py`, `bookings/models.py`, `manage.py`, pytest configuration and a small model-field test. The Booking model currently stores court, starts_at and a free-text member, with a court/start uniqueness constraint. This is baseline code, not a completed booking journey. Authentication routes, member screens, migrations and cancellation remain planned.

Retain Django and SQLite. Use Django session authentication and server-rendered forms. Move ownership to authenticated accounts with explicit legacy-data mapping. Booking services must enforce validation, database-backed active-slot uniqueness and the member quota with a SQLite-supported write transaction strategy. Do not rely on SQLite row locking through select_for_update. Preserve cancellation history and allow canceled slots to be reused.

## Verification and development

`make test` is the established test command: the Makefile runs pytest, and pytest.ini collects tests.py and test_*.py with club.settings. Use TDD for business logic as specified in RULES.md. Concurrency evidence requires independent connections against a file-backed SQLite database. Include time-boundary, migration, authorization, CSRF and full-journey checks, plus keyboard walkthroughs for the screens.

Storybloq quality level is Full pipeline. WRITE_TESTS and TEST use `make test`. BUILD is disabled because no build command is established. VERIFY is disabled until server routing/readiness is established; the proposed command is `python manage.py runserver 127.0.0.1:8000`, with the login page as readiness URL. Setup did not run tests, install dependencies, build or start a server.

## Project context

Use `$story` at the start of a Codex session to load `.story/` context. The initial handover records approved setup decisions and coverage. Begin with T-001. Double-booking prevention is a dedicated ticket, T-005, following slot validation/persistence T-004 and preceding quota enforcement T-006. Checkpoints T-003 and T-010 are ordinary dependency tickets; owner approval is not mechanically enforced.
