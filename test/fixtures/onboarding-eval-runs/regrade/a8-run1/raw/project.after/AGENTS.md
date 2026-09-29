# Plotbook
Plotbook replaces paper applications and a wall chart for Riverside Community Garden: 40 plots, approximately 60 households and one volunteer coordinator.

## Approved first version
Gardeners apply with up to three preferred plots, see their own allocation and season dates, and report problems with their own plots. The coordinator allocates via ordinary lists/forms, maintains a FIFO waiting list and resolves problems. Sign-in uses emailed one-time links without passwords; the coordinator gets a daily digest of new reports.
The owner explicitly deferred the plot map until after first-version acceptance, superseding brief.md / First version item 5. T-017 is in Later and depends on T-016 acceptance. Online payments and tool lending are also deferred. Keep brief.md as the original source; the initial setup handover records the approved amendment.

## Architecture and status
Planned: responsive TypeScript/npm web application with PostgreSQL. No application code is implemented yet. T-001 selects the framework and establishes migrations, local setup, a real test runner, build and development scripts. T-013 selects hosting/email providers and establishes staging, durable scheduled email, backup/restore and retention handling. Production follows verified staging (T-014 -> T-015).
Entities: household, verified member account, coordinator role, plot, season, prior holding, application, allocation, waiting-list entry, problem report and digest delivery record. Keep allocation and waiting-list rules testable independently from UI. All authorization is server-side.

## Assumptions and unresolved implementation choices
Coordinator confirms household declarations and reconciles duplicates before allocation; merges preserve original application order and history. Seasons default to March 1–October 31 with editable dates; configure garden-local timezone before cutoff-sensitive use. The cutoff is strictly before February 1 local midnight. New-applicant allocations cannot become final before the cutoff or while timely eligible returners remain unresolved. Preferences are advisory; late returners are ordinary applicants; the waiting list itself is global FIFO. No automatic vacancy-offer expiry.
Daily digest assumes 09:00 local time and no email when there are no new reports. Framework, hosting/email provider, actual timezone/sender/recipient and finite retention periods are TBD in their owning implementation tickets; none blocks ledger setup.

## Verification
Quality level: Full pipeline.
Use TDD for core business logic as specified in RULES.md. Current recipe stages WRITE_TESTS, TEST, BUILD and VERIFY are all explicitly disabled because no scripts or collected tests exist. Proposed commands: npm test (WRITE_TESTS and TEST), npm run build (BUILD), npm run dev with http://localhost:3000 readiness (VERIFY). Establish actual commands and real tests in T-001 before enabling stages.
Test priority deadlines, uniqueness, concurrency, FIFO, retries and authorization; verify phone/keyboard/screen-reader journeys and controlled inbox delivery. No completion claims based only on the brief.
Owner checkpoints: T-002 prototype, T-009 local allocation demonstration, T-016 first-version acceptance. These ordinary tickets do not mechanically enforce owner approval.

## Session continuity
Use $story to load the ledger. Work starts with T-001. Update ticket status when starting/completing work; preserve append-only handovers and snapshot before a new handover. The initial handover and setup note contain the full coverage map, review and pending tooling.
