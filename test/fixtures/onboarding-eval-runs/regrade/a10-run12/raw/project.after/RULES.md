# Development rules

- Keep Django. First-version requirements come from README.md and the owner-approved setup handover; distinguish requirements from labelled assumptions.
- Courts are 1, 2 and 3. Reservations are one-hour, timezone-aware, hour-aligned slots. Never allow duplicate bookings of one court/start.
- Accept only future starts no later than now plus seven days, inclusive. A member may hold at most two upcoming bookings (starts_at > now).
- A member may cancel only their own booking, at least two hours before start, including equality. Successful cancellation releases both slot and member allowance.
- Derive member identity from the authenticated server session, never caller-supplied ownership. Protect mutations against CSRF and do not expose identifying details of other members.
- Enforce uniqueness and member limits atomically in one shared reservation write path. Preserve guarantees under concurrent booking/cancellation and bounded retries; do not rely on SQLite select_for_update for row locking.
- Preserve existing data in migrations; explicitly map legacy member strings and refuse ambiguous mappings. Do not silently drop data.
- Show actionable validation/conflict errors and accessible labels, keyboard paths and error associations. Never report success for failed writes.
- TDD for business logic: write tests first for core functional code (calculations, validation rules, state machines, data transformations, AI evaluation harnesses). Tests define the contract before implementation.
- Use make test. Test rule boundaries with a controlled clock and race conditions with separate database connections. Do not infer workflow completion from model declarations alone.
- Keep secrets, credentials and member data out of committed documentation and fixtures. Production deployment and guest payments are outside first-version scope.
