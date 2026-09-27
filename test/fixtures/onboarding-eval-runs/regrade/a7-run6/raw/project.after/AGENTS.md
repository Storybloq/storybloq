# Queue board

A walk-in repair cafe queue for door volunteers, repairers and visitors. Source: BRIEF.md.

## First version

Add a visitor's first name and repair item, take the next visitor, mark a repair finished, and show waiting/helped visitors on a board that refreshes automatically. SMS alerts are deferred.

## Stack and architecture

- frontend/: JavaScript ESM, npm, Vite and Vitest. Current source renders only a title.
- backend/: Python >=3.11, FastAPI and pytest. Current source provides GET /health and a health test; execution has not been verified.
- Planned: shared backend queue lifecycle/storage, staff API/UI actions and a board read API/UI. Board page (T-009) and automatic refresh (T-010) are separate slices.
- Storybloq root type is generic because this is a mixed project; retain each component's tools.

## Decisions still open

T-002 owns queue ordering (FIFO proposed, not decided), completed-entry visibility, deployment/network, view/mutation access, display privacy, storage/restart durability and retention. No storage provider, authentication model or refresh mechanism has been selected. Domain decisions must precede T-004.

## Verification

Full pipeline was approved. TDD applies to core queue logic as specified in RULES.md.
- WRITE_TESTS and TEST: `(cd frontend && npm test) && (cd backend && python -m pytest)`.
- BUILD: `cd frontend && npm run build`.
- VERIFY: disabled pending T-003's combined startup command and readiness URLs.
Commands derive from manifests; no installs, tests, build or server runs occurred during setup. T-003 establishes dependencies, meaningful frontend tests and startup commands. Do not infer passing tests from the existing health test source.

## Work tracking

Use `$story` to load .story context. T-002 and T-003 are ready first. Mark work in progress when starting and complete only with supporting evidence. Owner review checkpoints are ordinary tickets and are not technically enforced. See the initial setup handover for approved coverage and independent review.
