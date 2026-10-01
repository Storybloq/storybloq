# Development rules

## Booking invariants

- Courts are numbered 1 through 3. A booking begins on a club-local clock hour and lasts exactly one elapsed hour.
- Use timezone-aware instants. The club timezone is configurable and initially UTC. Reject nonexistent local hours and distinguish repeated hours by explicit offsets and UTC instants.
- A start must be strictly in the future and no later than now plus 168 hours. Show every eligible start, even when the rolling window spans eight calendar dates.
- Never allow two active bookings for the same court and instant. Enforce this in the database and verify simultaneous requests. Preserve existing uniqueness until its replacement is safely installed.
- A member may hold at most two active bookings whose start is strictly after now. Enforce quota and slot allocation transactionally under concurrent requests. Canceled and past bookings do not count.
- A member may cancel only their own booking, with at least two hours remaining. Exactly two hours is allowed; less is denied. Repeated cancellation is safe.
- Retain canceled records, release their slot and quota, and preserve these invariants during concurrent booking/cancellation.
- Use a SQLite-supported write serialization strategy with bounded contention handling and rollback. Do not treat select_for_update as an effective SQLite row lock.

## Identity and data safety

- Resolve booking ownership from the authenticated account, never a client-supplied member identity. Protect mutations with CSRF and ownership checks.
- Staff provisions accounts and resets passwords. Keep account administration restricted to staff. Do not expose other members' identities in availability or authorization errors.
- Require explicit mapping of existing free-text booking members during migration. Unresolved mappings block migration; never guess ownership or silently discard records.
- Keep secrets and local databases out of Git. Document external secrets, DEBUG off, allowed hosts, HTTPS and secure cookies before real deployment.

## Verification

- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- Run `make test` for relevant implementation changes. Test cutoff/window boundaries, quota races, duplicate races, canceled-slot reuse, ownership, migrations and rollback.
- Use independent database connections and file-backed SQLite for concurrency evidence; mocks alone do not demonstrate the invariants.
- Provide accessible labels, keyboard navigation, focus/error feedback, empty states and clear conflict recovery. Verify the integrated member journey.
- Preserve append-only Storybloq handovers. Record out-of-scope discoveries as issues. Do not mark planned behavior complete without evidence.
