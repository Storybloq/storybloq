# Plotbook

Plotbook helps Riverside Community Garden's roughly 60 households apply for its 40 seasonal plots and lets its volunteer coordinator allocate plots, maintain a waiting list and resolve plot problems. Source: brief.md; owner decisions recorded in the initial Storybloq handover amend that brief.

## First-version outcome

Gardeners sign in with an emailed one-time link (no passwords), apply for the coming season with up to three preferred plots, see their own allocation and season dates, and report problems with their plot. The coordinator reviews applications, assigns plots through lists and selectors, maintains the chronological waiting list, resolves problems and receives one daily email listing new reports.

The owner explicitly deferred brief requirement 5, the coordinator plot map, until after first-version acceptance. T-014 holds that later work and waits on T-013. No first-version prototype, registry layout, demonstration or acceptance requires a map. Online payment and tool lending also remain deferred.

## State and planned architecture

This is a brief-only project with a populated Storybloq ledger, not an implemented application. All 14 implementation/checkpoint tickets are pending. The roadmap has six phases including p0 Setup.

Approved direction: one TypeScript web application, server-side SQL persistence, email adapter and scheduled daily digest. Metadata is generic/typescript. T-001 selects the framework, database, deployment approach, scheduler and email provider and establishes tooling. These implementation selections are TBD and delegated, not open owner decisions. No purchase or live deployment is authorized by setup.

Core entities: household/account, plot, season, application, allocation, waiting entry, problem report and digest batch. An application belongs to one household and season; allocations join household, plot and season; reports refer to the reporting household's plot; persisted digest batches track new reports and delivery attempts. Coordinator-only registry forms manage previous-season holdings.

## Rules and approved assumptions

- Read RULES.md before implementing business logic. Households hold at most one plot per season, and each plot has at most one household per season.
- Returning gardeners applying before local February 1 receive initial-allocation priority. Subsequent vacancy allocation follows the strict original-application-order waiting list. The initial-round versus later-queue interpretation is an approved assumption, not an additional statement in the brief.
- One verified email represents one household, with coordinator-maintained identity and historical holdings. Preferences are requests, not guarantees.
- Season dates (March to October), timezone and daily email time are configured explicitly. Map positions belong only to T-014.
- Phone usability, large text, plain language, accessibility and coordinator-only contact visibility apply throughout.

## Verification

Quality level: Full pipeline. TDD applies to business logic, including eligibility, ordering, allocation state transitions, authorization and digest batching.

No manifest or collected tests existed at setup. WRITE_TESTS and TEST propose `npm test`; BUILD proposes `npm run build`; VERIFY proposes `npm run dev` with readiness URL TBD. All four are explicitly disabled pending tooling. T-001 must establish, validate and enable them. Do not treat proposed commands as established or claim application tests passed during setup.

Use synthetic fixtures for cutoff boundaries, original order versus enqueue order, concurrent assignment, link replay, role isolation and digest crash/retry. T-012 includes phone/accessibility evidence, restore rehearsal and an operator runbook.

## Work tracking

Use `$story` at session start to load context and work from `.story/`. T-001 and T-004 can begin immediately. Update ticket status when starting and finishing work; record out-of-scope discoveries as issues. Handovers are append-only; snapshot before creating a new one.

T-004, T-011 and T-013 are owner checkpoints. Record actual owner review rather than inferring acceptance. Stage-1 limitation: checkpoint tickets are ordinary records, so Storybloq does not automatically enforce their approval gates.
