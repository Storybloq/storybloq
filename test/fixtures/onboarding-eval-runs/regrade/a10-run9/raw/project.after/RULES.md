# Rota rules

- Never assign a volunteer on an unavailable day; unavailability covers the whole day.
- Count every listed volunteer in fairness calculations, including zero assignments. Fair means maximum count minus minimum count is at most one.
- Maximize filled shifts first; then globally minimize count range; then sum squared counts; break remaining ties deterministically by input order. No silent heuristic substitution for the exact optimum.
- When perfect fairness is impossible, return the best rota and report each volunteer exceeding minimum count + 1, with their count and excess.
- Explicitly report unfilled shifts. No daily assignment cap or cross-week fairness is part of version one.
- CSV reading owns file/decoding/syntax errors. Validation owns headers, row structure, uniqueness, day values and normalized records. Never accept partial invalid input.
- Reject no volunteers; permit an empty set of shifts. Preserve distinct shift IDs for multiple shifts on one day.
- Keep the workflow local, in Python. Do not add email or network services to first-version scope.
- Keep volunteer-identifying data out of committed examples; use synthetic fixtures.
- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- Verify scheduling against an independent exhaustive small-case reference and verify CLI errors and results end-to-end.
- T-004 and T-007 record owner review of sample artifacts and first-version acceptance. They are ordinary tickets, not mechanically enforced gates.
