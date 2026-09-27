<!-- storybloq-handover v1 -->

# Queue board initial setup

## Worker state

Storybloq setup approved by the owner with "Approve setup." and executed on 2026-09-27. This is an existing source scaffold, not a functioning queue product. Mixed components: frontend JavaScript/npm/Vite/Vitest; backend Python >=3.11/FastAPI/pytest. Root project type generic records the mixed project; both parts are documented in AGENTS.md.

## Blocked

Product lifecycle implementation T-004 waits on T-002 owner decisions and T-003 tooling. VERIFY awaits startup tooling. No setup blocker remains.

## Owner rulings

The owner requested: "Split the board page ticket so that auto-refresh is its own ticket." Implemented as T-009 and T-010, with T-010 blocked by T-009. Setup approval authorizes the planned ledger, governance and Git creation, not product implementation.
No source conflicts were found. No additional product answers were supplied. Queue ordering (FIFO proposed only), completed visibility, deployment/network, access boundaries, display privacy, storage/restart durability and retention remain explicit owner decisions in T-002. No provider or authentication scheme has been invented.

## Carried forward

- Start with T-002: Checkpoint: confirm workflow and deployment. Prepare a workflow/API sketch during that discussion and record the owner's answers.
- T-003: Establish development and verification commands is also ready independently.
- SMS alerts remain deferred beyond the first version.

## Shipped

Setup artifacts only: four phases (default p0 plus p1/p2/p3), 12 tickets with dependencies, AGENTS.md, RULES.md, REVIEW.md, .gitignore, initialized Git and baseline snapshot. T-001 alone is complete, supported by inspected frontend/src/main.js, backend/app/main.py and backend/tests/test_health.py. No working queue feature or successful test run is claimed. No GitHub issues were imported.

## Product brief and acceptance

Source: BRIEF.md. A walk-in repair cafe needs volunteers to add a visitor's first name and repair item, repairers to take the next visitor and finish repairs, and viewers to see waiting/helped visitors on an automatically refreshed board. Observable first-version acceptance: valid entries appear once; next selection follows owner ordering with no duplicate assignment; active repair can finish safely; an open board reflects those actions automatically and recovers after connection loss. User-visible errors, empty/loading/pending states and accessibility are included in implementation tickets. Final acceptance applies decisions recorded in T-002. SMS is later scope.

## Coverage map

| Source / requirement | Coverage | Acceptance |
|---|---|---|
| BRIEF.md: volunteer adds first name and item | T-005, T-004 | One valid waiting entry; invalid and repeated submissions handled safely |
| BRIEF.md: repairer takes next visitor | T-006, T-004 | Agreed ordering; atomic selection; lost-response retry returns original claim |
| BRIEF.md: finish repair | T-007, T-004 | Active-only completion with safe retries |
| BRIEF.md: screen shows waiting/helped | T-009 | Initial load/reload shows current groups and permitted fields |
| BRIEF.md: automatic refresh | T-010 | Changes appear without manual reload; stale/offline/reconnect and delayed-response safety |
| BRIEF.md: SMS later | Explicit deferral | No SMS in first version |
| Material gaps: ordering, access, privacy, durability, retention, deployment | T-002, then T-004 and T-011 | Owner chooses rules before dependent implementation; final evidence checks them |
| Existing manifests: runnable development/tests | T-003 | Establish dependencies, meaningful tests, startup and readiness commands |
| Existing source scaffold | T-001 complete | Frontend title and /health source; health test source present, not run |
| Staff demonstration | T-008 | Owner reviews add/take/finish workflow |
| First-version integration and acceptance | T-011, T-012 | Complete multi-client demonstration and owner acceptance |

## Milestones and checkpoints

- p0 Setup: T-001 source scaffold record.
- p1 Agreed workflow and runnable foundation: T-002 owner discussion, T-003 tooling, T-004 lifecycle/storage.
- p2 Working staff journey: T-005 add, T-006 take, T-007 finish, T-008 staff demonstration checkpoint.
- p3 Live board and first-version acceptance: T-009 page, T-010 refresh, T-011 integrated verification, T-012 owner acceptance.
Checkpoint T-002 is immediately available; T-008 waits for T-005/T-006/T-007; T-012 waits for T-008/T-011. Stage-1 limitation: these are ordinary tickets and owner approval is not technically enforced. Board work need not wait for staff demonstration.
Temporary proposal labels map to real IDs: E=T-001, A=T-002, B=T-003, C=T-004, D=T-005, F=T-006, G=T-007, H=T-008, I=T-009, L=T-010, J=T-011, K=T-012. Ticket descriptions now use real IDs.

## Verification configuration

Approved quality: Full pipeline because the queue has business logic and concurrent workflows.
- WRITE_TESTS enabled, with onExhaustion=plan: `(cd frontend && npm test) && (cd backend && python -m pytest)`.
- TEST enabled: `(cd frontend && npm test) && (cd backend && python -m pytest)`.
- BUILD enabled: `cd frontend && npm run build`.
- Commands are established from frontend/package.json and backend/pyproject.toml, not runtime verified. Python has no build command.
- VERIFY explicitly disabled until T-003 establishes combined frontend/backend startup and readiness URLs. Candidate frontend command is `cd frontend && npm run dev`; backend runner/ports and combined command remain TBD. No invented port or runnable combined command is configured.
Verification tooling to establish: VERIFY: combined Vite/FastAPI startup and browser checks (pending: backend runner, combined command and readiness URLs are not established).
No dependencies were installed, tests/builds executed, or development servers started during setup.

## Independent review

Native Codex read-only independent plan review completed in this session before approval. Both rounds returned "PASS_WITH_MINOR_CLARIFICATIONS".
Round one requested: "retrying the same logical action must recover the original assignment rather than claim another visitor" and "an older refresh cannot overwrite newer board state after reconnect". Incorporated in T-004/T-006 and T-010/T-011 respectively.
After the owner's board/refresh split, round two confirmed: "Coverage is complete: D/F/G cover staff actions, I covers the board page, L separately covers automatic refresh, and J/K verify and accept the whole journey. SMS is explicitly deferred."
Round two corrected the inventory count to 12 tickets, not 13; the approved revised inventory and saved project use 12. No review finding remains unaddressed. Domain decisions remain intentionally open in T-002, not treated as settled findings.
