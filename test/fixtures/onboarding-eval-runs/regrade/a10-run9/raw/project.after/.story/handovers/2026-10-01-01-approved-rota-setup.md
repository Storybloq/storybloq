<!-- storybloq-handover v1 -->
# Session Handover: approved Rota setup

## Worker state
Setup completed; no product implementation started. Four phases including default p0, seven tickets (one historical complete, six pending), zero issues. Git initialized, no commit. Source unchanged.

## Blocked
No unresolved owner decisions. Dependencies: T-003 <- T-002; T-004 <- T-003; T-005 <- T-003; T-006 <- T-003,T-004,T-005; T-007 <- T-006. No cycles.

## Owner rulings
Owner decisions and approval are recorded below as setup history. No separate ruling IDs were created.

## Carried forward
Start T-002: Read CSV files and provide examples. T-003 owns validation separately as requested by the owner. Do not start autonomous mode without explicit selection.

## Shipped
Created phases input-contract, scheduling and weekly-cli after p0; T-001 through T-007; N-001 setup coverage note; recipe overrides; AGENTS.md (2419 bytes), RULES.md (1661 bytes), REVIEW.md (4726 bytes, exact template), .gitignore. Read back each file. Snapshot saved before this handover. CLI fallback used because the MCP tool list did not refresh after init; restart client if needed.

## Product brief and acceptance
One organiser uses a local Python CLI to read volunteers/unavailable whole days and weekly shifts, produce the fairest available assignments and print the rota. Observable acceptance: unavailable volunteers never assigned; feasible fairness count range <=1; otherwise optimal rota plus correct over list; unfillable shifts explicitly listed; invalid input explained without partial results. Email deferred.

# Approved setup coverage
Source: README first-version scope; owner conversation; approved revised setup R2.
| Requirement/decision | Tickets | Evidence planned |
|---|---|---|
| Read weekly CSVs | T-002, T-006 | Reader and subprocess tests |
| Validate schema, days, unique identities | T-003, T-006 | Table cases and reader-validator integration |
| Whole-day availability | T-005 | No unavailable assignment |
| Fair count range <=1 when possible | T-005 | Independent exhaustive small-case reference |
| Fairest possible otherwise; list who is over | T-005, T-006 | Optimality reference and exact overload reports |
| Print rota, totals, unfilled warnings | T-006 | End-to-end output checks |
| One organiser, local Python | T-006 | python -m rota local workflow |
| Existing rotation baseline | T-001 complete | rota/schedule.py and tests/test_schedule.py inspection, not execution |
| Early artifact review | T-004 | Owner reviews CSV examples and proposed output |
| First-version acceptance | T-007 | Owner demonstrates fair/unfair/unfilled/error cases |
| Email | Deferred | README later scope |
| Cross-week balancing | Excluded | Approved first-version boundary |

Approved assumptions: separate UTF-8 volunteers.csv (name,unavailable_days) and shifts.csv (shift_id,day); semicolon mon..sun unavailability; blank unavailable days valid; unique nonempty names/IDs; multiple shifts/day and no per-volunteer daily cap. First maximize filled shifts, then globally minimize max-min counts across all listed volunteers, then sum squared counts, deterministic input-order tie-break. Over means count > minimum count+1; show names/counts/excess. No volunteers invalid; header-only shifts valid. Never assign unavailable volunteers; list unfilled shifts. Valid imperfect result exits 0 with warnings; invalid input produces stderr/nonzero and no partial output.

Owner answers: one food-bank organiser weekly on own laptop; whole-day unavailability; impossible fairness returns fairest possible rota and list who is over; retain Python; other decisions delegated. Owner requested separate CSV validation ticket, then approved revised package. No source conflicts remain; no unresolved owner decisions.

Quality level: Full pipeline.
WRITE_TESTS: pytest enabled; TEST: pytest enabled. Established from pyproject.toml pytest configuration and tests/test_schedule.py. No tests/install/build/dev-server run during setup. BUILD disabled: no established command, no proposed build requirement. VERIFY disabled: CLI without server. Pending verification tooling: none; no command proposed pending establishment.
Checkpoint limitation: T-004 and T-007 are ordinary tickets, not mechanically enforced approval gates.

Reviewer probe: `command -v codex` printed nothing
Independent review: approve, invocation R2
R2 completed via independent agent with findings []; earlier R1 preceded the requested CSV split.
