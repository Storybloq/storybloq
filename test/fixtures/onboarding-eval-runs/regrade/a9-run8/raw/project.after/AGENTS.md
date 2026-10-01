# Plotbook

Plotbook replaces Riverside Community Garden's paper applications and wall chart for 40 plots and about 60 households. Gardeners apply and see their own allocation; one volunteer coordinator allocates plots, manages a waiting list and resolves plot problems.

## Approved first version

Source: brief.md, amended by the owner's setup decisions recorded in the initial Storybloq handover.
- Coming-season applications with up to three distinct plot preferences.
- Coordinator allocation workspace using a plain list, with returning-gardener priority and strict FIFO waiting list.
- Gardener's own allocated plot and season dates.
- Gardener problem reporting and coordinator resolution.
- Passwordless emailed one-time sign-in links; one daily coordinator digest of new reports.
- Phone usability, large text, plain language, accessible forms and states; contact details visible only to coordinator.

The owner explicitly deferred brief.md requirement 5 (plot map) until after the first version. T-014 tracks it and depends on first-version acceptance T-013. Payments and tool lending are deferred without implementation tickets. Do not treat the unamended brief's map requirement as part of v1.

## Planned architecture; nothing implemented yet

Approved stack: TypeScript, Next.js, npm and PostgreSQL. Server-side authorization and transactions; configurable transactional-email adapter and durable scheduled digest. Entities: households and approved members, users/roles, 40 plots, seasons, prior-season holdings, applications/preferences, allocations, waiting-list statuses, reports and digest delivery records. T-002 establishes persistence and tooling; T-003 implements email authentication and canonical household onboarding.

## Assumptions and operational decisions

Unknown verified emails get restricted pending access. Coordinator searches for an existing household before linking or creating one, with duplicate checks and an auditable decision. Multiple accounts share the household entitlement. This approach and prototype are reviewed at T-004.

Garden timezone, exact March–October season dates and digest hour are configured. Previous-season history must be entered/validated. Late returning applicants use ordinary priority; timestamp ties use stable IDs; plot preferences are advisory. Those are implementation assumptions reviewed at T-004, not changes to the fixed brief rules.

Deployment target and email provider are TBD until staging in T-012; operator supplies accounts and credentials. Select an email provider supporting delivery deduplication, or surface ambiguous digest delivery for operator resolution. No credentials in source or ledger. T-012 establishes backup/restore, retention and operational recovery.

## Workflow and testing

Use `$story` to load project context. Tickets T-001 and T-002 are initially unblocked. Read each ticket before implementation and keep status accurate. Owner checkpoints T-004, T-009 and T-013 are ordinary tickets: no mechanical gate enforces owner approval. Record the owner's actual demonstration/decision before closing them.

Follow RULES.md. Use TDD for business logic. Approved quality level is Full pipeline. All four verification stages are disabled initially: there is no application manifest or test source yet. Proposed commands pending T-002: WRITE_TESTS and TEST `npm test`; BUILD `npm run build`; VERIFY `npm run dev` with readiness at `http://localhost:3000`. Establish scripts, runner and collected test sources before enabling stages. Do not describe planned tests or capabilities as completed.
