<!-- storybloq-handover v1 -->

# Plotbook initial setup — approved 2026-09-27

## Worker state

- Setup completed; no product code exists and no product tickets are marked complete.
- Continue with T-001 (establish tooling) or T-002 (phone prototype), the two initially ready tickets. No autonomous session was started.
- Folder originally contained only brief.md; project is generic, language TBD, technology/provider/hosting TBD in T-001.
- Seven phases including default p0 Setup; 18 open tickets, 17 first-version and one deferred map; zero imported issues.
- Git initialized. AGENTS.md (4242 bytes), RULES.md (4699 bytes), REVIEW.md (4726 bytes) and .gitignore (54 bytes) were read back. REVIEW.md matches the skill template byte-for-byte.
- Initial snapshot taken before this handover. CLI fallback used after initialization because cached MCP list did not expose creation tools; a client restart may expose them.

## Blocked

- No external setup blockers. T-003 must record owner review before dependent model/application work; dependencies encode the remaining work order.
- Verification commands and garden timezone are not yet established. Do not silently use npm defaults.

## Owner rulings

- Source: conversation. "Sign-in: gardeners sign in with an emailed one-time link; no passwords."
- Source: conversation. "Problem notifications: the coordinator gets one email a day listing new problem reports."
- Source: conversation. "Technology: no preference." Remaining choices were delegated: "No preference, use your judgement."
- Source: conversation amendment. "Defer the plot map view to after the first version."
- Source: conversation approval. "Approve setup."
- The map amendment supersedes brief.md First version feature 5. Original brief is preserved unchanged. T-018 sits after Release and depends on T-005, T-008, T-017. No first-version ticket depends on the map.
- No other source conflicts were found. Operational/setup assumptions below are labelled, not asserted as original brief requirements.

## Carried forward

- T-001: choose/document stack and establish verification tooling; enable all applicable Full pipeline stages before completing.
- T-002: prototype phone journeys using synthetic data, without requiring map.
- T-003, T-007, T-011, T-015, T-017: owner checkpoints for early artifact review, milestone demonstrations and first-version acceptance. These are ordinary tickets; there is no technical owner-approval gate. Record explicit owner answers and do not infer acceptance.

## Shipped

- Storybloq ledger, roadmap, dependency wiring, governance files, git ignore configuration and initial snapshot. This is setup, not implemented product functionality.

## Product brief and acceptance

Riverside Community Garden has 40 plots and about 60 households. The volunteer coordinator currently uses paper forms and a wall chart. First version enables phone application with up to three preferences, fair seasonal initial allocation, FIFO waiting/vacancy handling, own allocation/dates, plot problem submission/resolution, email one-time-link sign-in and daily coordinator notifications. Large text and plain language serve less confident users; contact privacy is coordinator-only. Coordinator uses an allocation list in first version. Map is post-first-version; payments and tool lending remain deferred.

Observable acceptance and evidence are mapped below; implementation tickets also specify failure/recovery behavior and concrete verification.

| Source | Requirement / acceptance | Tickets or disposition |
|---|---|---|
| brief.md Background | 40 stable plots; seasonal March–October occupancy, history retained | T-004, T-008, T-010 |
| brief.md First version 1 | Phone application with zero to three distinct preferences; safe repeat submission preserves order | T-005, T-006 |
| brief.md First version 2 | Coordinator reviews/preferences and allocates without conflicting holdings | T-008 |
| brief.md First version 2 | Unallocated households enter original-application-order waiting list; late arrivals and vacancy assignment respect FIFO | T-009 |
| brief.md First version 3 | Gardener sees own plot/dates or waiting/unallocated state | T-010 |
| brief.md First version 4 | Gardener reports problem on own plot, coordinator views and resolves | T-012, T-013 |
| brief.md First version 5; latest owner amendment | Plot map is explicitly after first version; accurate 40-cell grid with list alternative | T-018, blocked by T-017 |
| brief.md Rules | Household at most one active plot per season; unique active plot holder and retained history | T-004, T-008, T-009 |
| brief.md Rules | Prior-season holders applying before 1 February receive initial priority; no early finalization/bypass | T-004, T-008 |
| brief.md Rules | Strict FIFO waiting list, including tie ordering and vacancy handling | T-006, T-009 |
| brief.md Constraints | Phone usable; large text/plain language; accessible labels/focus/loading/error states | T-002, T-003, T-006, T-010, T-012, T-016 |
| brief.md Constraints | Coordinator-only gardener contact access, tested across merges, reassignment and direct-ID requests | T-005, T-010, T-012, T-013, T-014, T-016 |
| conversation sign-in decision | Emailed expiring single-use links, no passwords; secure coordinator bootstrap/recovery | T-005 |
| conversation notification decision | One daily coordinator email of new reports; failures/concurrency safely handled | T-014 |
| brief.md Later | Online payment and tool lending | Deferred; no first-version implementation |
| approved operational work | Deployment, recovery, backup restoration and coordinator runbook | T-016 |
| first-version owner acceptance | Accept features 1–4, sign-in, digest, domain rules, privacy and accessibility; map excluded | T-017 |


## Answers and assumptions

Approved provisional assumptions: one household account initially with coordinator reconciliation; occupancy defaults to March 1–October 31; coordinator supplies local timezone and distinct application window; cutoff strictly before February 1 at 00:00 local; returning means held a plot immediately prior season; no final initial allocations before cutoff; advisory preferences and application-order ties inside initial priority groups; FIFO thereafter. Active holdings are unique but ended history preserved; released plots can be reassigned and withdrawn/released households cannot reapply that season. Problems concern own active plot, with coordinator-only stored-report access. Digest defaults to 08:00 local, skips empty days and includes new reports already resolved. T-003 reviews these choices. Physical grid layout remains unknown and only affects deferred T-018.

## Approved quality and pending tooling

Full pipeline was approved for allocation business rules, privacy and workflows. TDD for core business logic is recorded in RULES.md. No commands were established from the initial brief-only folder, so WRITE_TESTS, TEST, BUILD and VERIFY each have explicit enabled:false overrides. T-001 must establish real commands and enable applicable stages before completion; truly inapplicable stages need a recorded reason. No installation, test/build command or dev server was run during setup.

Verification tooling to establish: WRITE_TESTS: TBD in T-001 (pending: no manifest or test command exists)
Verification tooling to establish: TEST: TBD in T-001 (pending: no manifest or test command exists)
Verification tooling to establish: BUILD: TBD in T-001 (pending: no manifest or build command exists)
Verification tooling to establish: VERIFY: TBD server command and readiness URL in T-001 (pending: no application server exists)

## Independent review

Independent native Codex CLI plan review was completed read-only with the skill's setup-review-schema.json. Original plan review identified cutoff/priority bypass, release history, application lifecycle, waiting-state dependency, coordinator recovery, digest guarantees and report privacy gaps; these were incorporated. Owner then deferred the map, prompting a new review. Its findings required blocking T-018 on T-017 and requiring T-001 to enable applicable Full pipeline stages. Both were incorporated; final verdict: "approved". Final reviewer finding: "Counts are consistent: 7 phases, 18 tickets, 17 first-version and 1 deferred. No remaining changes requested." Review verifies the plan, not product implementation. No review was skipped.

## Checkpoint artifacts

- T-003: phone prototype and written domain examples; depends on T-002; gates T-004 and T-006 (and downstream work).
- T-007: running passwordless application and privacy evidence; depends on T-006.
- T-011: priority, FIFO, allocation and list-view demonstration; depends on T-009/T-010.
- T-015: report/resolution workflow and sandbox daily email; depends on T-013/T-014.
- T-017: release candidate and mapped first-version evidence; depends on T-016; gates deferred map T-018.
