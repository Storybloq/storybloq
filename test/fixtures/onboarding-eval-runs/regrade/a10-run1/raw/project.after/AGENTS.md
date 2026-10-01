# Plotbook

Plotbook supports Riverside Community Garden's volunteer coordinator and about 60 households managing 40 plots. Source requirements are in brief.md; approved setup decisions and coverage are recorded in the initial .story/ handover. Use $story to load project context.

## First version

Gardeners sign in with emailed one-time links, apply for the coming season with up to three preferred plots, see their own allocation and season dates, and report problems with their allocated plot. The coordinator manages households, applications, priority allocation, the FIFO waiting list and problem resolution, and receives one daily email listing new reports.

The coordinator plot map is explicitly deferred to T-018, after first-version launch T-017. Its original first-version designation in brief.md is superseded by the owner's setup decision. Payments and tool lending remain deferred. No implementation is complete.

## Planned architecture and technology

One web application with server-side authorization, transactional relational persistence, email delivery and a durable scheduled job. Core records: household, plot, season, historical holding, application, allocation, problem report and email batch. Gardeners access their household only; the coordinator alone accesses other households and contact details.

Language, framework, database product, email provider and hosting are TBD in T-001; the owner delegated these choices. Select and document choices after evaluating delivery, scheduler and idempotency feasibility. No manifest, application code or test runner existed at setup. Do not mistake proposed architecture for existing behaviour.

## Approved assumptions and remaining configuration

The coordinator maintains household records and historical occupancy; each household uses one sign-in email. Initial allocation opens on February 1 at 00:00 in garden time. Qualifying prior-season holders applying before that cutoff receive priority; all nonqualifying applicants, including late returning applicants, use ordinary submission order. Preferences are optional and not guaranteed. Waiting lists remain FIFO regardless of returning status.

Exact March-October season dates, garden timezone, application window, digest time/address, retention arrangements and deployment credentials must be established before launch. No empty digest is sent. Newly reported but since-resolved problems remain in the digest with their status. See RULES.md and T-012 for delivery recovery.

## Workflow and verification

Quality level: Full pipeline. Use TDD for core business logic per RULES.md. All four recipe stages are deliberately disabled pending tooling: WRITE_TESTS and TEST need the same established test command and collected tests; BUILD needs an established build command; VERIFY needs an applicable server start command and readiness URL. T-001 establishes these and enables supported stages. Never assume npm test exists.

T-001 and T-002 can start immediately. T-003, T-009, T-013 and T-016 are owner review checkpoints; their gates are not automatically enforced by Storybloq, so record the owner's decision before closing them. T-017 additionally requires launch authorization. Set a ticket inprogress when starting and complete only with verified acceptance; track out-of-scope discovered problems as issues. Handovers are append-only; snapshot before creating one. Read REVIEW.md when conducting verification review.
