# Queue board

A walk-in repair cafe queue for one door volunteer, three to six repairers, and visitors viewing a public screen. Version one adds visitors, takes the next waiting visitor, finishes repairs and refreshes the board every ten seconds. SMS alerts are deferred; accounts, history and analytics are outside this version.

## Stack and current architecture

- `frontend/`: npm, JavaScript, Vite, Vitest. Currently a placeholder title only.
- `backend/`: Python 3.11+, FastAPI, pytest. Currently GET `/health` plus a health test source.
- Storybloq config uses npm as its primary project type; both components must be considered for implementation and verification.
- Planned backend owns queue validation, transitions, retention and read-only board projection. Frontend owns operator controls and public display. No queue feature is implemented yet.

## Product contract

Source: BRIEF.md and owner setup answers. Collect first names and the item to repair, never surnames or contact details. Public display contains first names, status and anonymous references, not repair details. Nothing is retained after the day ends. Ten-second refresh is sufficient.

Assumptions chosen under owner delegation: trusted local network without sign-in, FIFO ordering, anonymous references for duplicate names, any repairer may finish a repair, and configured cafe timezone defaulting to host timezone and visible to operators.

TBD before storage implementation: T-003 resolves the conflict between restart-surviving daily SQLite and deletion while the host is powered off. Volatile storage is the alternative. Setup approval did not relax retention. T-004 depends on this decision. All clients clear names and item input at day expiry even offline; no payload logging or browser persistence.

## Work and verification

Use `$story` to load `.story/` context. T-002 establishes verification and full-app startup. T-007 owns board display, initial fetch and privacy expiry; T-008 separately owns polling and reconnection. T-009 is first-version acceptance. Owner checkpoints are ordinary tickets, not technically enforced approval gates.

Quality level: Full pipeline. Use TDD for core validation, queue transitions and retention logic.

- Backend WRITE_TESTS and TEST: `cd backend && pytest`; established by configuration and collected test source, not executed during setup. T-002 audits dependencies including TestClient/httpx.
- Frontend WRITE_TESTS and TEST: `cd frontend && npm test`; pending meaningful test sources, so not in the active recipe yet.
- BUILD: `cd frontend && npm run build`; manifest-established, not executed during setup.
- VERIFY: disabled until T-002 establishes full-app startup/readiness. Proposed commands are `cd backend && python -m uvicorn app.main:app` and `cd frontend && npm run dev`; backend server dependency and readiness address are pending.

Do not treat a declared command as evidence that it passed. Keep visitor data out of source control, Storybloq notes/handovers/snapshots and backups. Use synthetic data in tests and examples.
