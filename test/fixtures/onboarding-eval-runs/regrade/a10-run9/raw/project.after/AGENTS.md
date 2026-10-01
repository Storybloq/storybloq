# Rota

Rota is a local Python command-line helper for one food-bank organiser to assign weekly shifts. First version: read volunteers and unavailable days from CSV, respect whole-day availability, generate the fairest possible rota, and print assignments, totals, overloads and unfilled shifts. Email and cross-week balancing are deferred.

## Evidence and architecture
Python >=3.11 (pyproject.toml). Existing rota/schedule.py provides round-robin assign; tests/test_schedule.py specifies rotation. This baseline is not the completed product.
Planned boundaries: raw CSV reading (T-002), validation and normalized models (T-003), optimal assignment (T-005), and python -m rota CLI (T-006).
CLI: python -m rota --volunteers FILE --shifts FILE. No network service or persistent database.

## Approved input and output contract
UTF-8 volunteers CSV: name,unavailable_days; semicolon-separated mon..sun, blank unavailability allowed. Shifts CSV: shift_id,day. Names and shift IDs are unique and nonempty. Multiple shifts per day are allowed, with no daily per-volunteer cap. Invalid files/data fail clearly without partial results; zero volunteers is invalid, header-only shifts is valid.
Maximize filled shifts, then minimize count range across all volunteers including zero counts, then minimize sum squared counts; deterministic input-order tie-break. Never assign unavailable volunteers. Report overload above the minimum count plus one, and every unfilled shift.
Valid imperfect results exit 0 with warnings; invalid input exits nonzero with stderr explanation. Plain text remains understandable without colour.

## Work and verification
Use $story to load the ledger. T-002 is the first pending ticket. T-004 reviews sample inputs/output before CLI implementation; T-007 accepts the full version. These ordinary checkpoint tickets do not mechanically enforce owner approval.
Quality level: Full pipeline. TDD for core business logic; pytest is established by configuration and existing test sources. WRITE_TESTS and TEST use pytest. BUILD is disabled (no established build command); VERIFY is disabled (CLI, no server). Setup did not run tests or install dependencies.
Use independent exhaustive small-case reference checks for scheduler optimality, reader/validator table cases and subprocess CLI tests.
Follow RULES.md; REVIEW.md is the review contract. The initial handover records setup decisions and coverage.
