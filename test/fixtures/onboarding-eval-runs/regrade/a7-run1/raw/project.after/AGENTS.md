# Plotbook

Plotbook helps Riverside Community Garden's volunteer coordinator allocate 40 plots to about 60 households for March–October seasons. Gardeners apply, see their allocation and report plot problems from their phones.

## Approved first version

- Emailed one-time-link sign-in, no passwords; secure coordinator bootstrap and recovery.
- Applications with up to three distinct preferred plots; coordinator review and allocation through a simple list.
- Returning-gardener priority for eligible applications before 1 February; strictly FIFO waiting list and vacancy assignment.
- Gardener's own allocation and season dates, or waiting/unallocated state.
- Gardener problem submission, coordinator inbox/resolution, and one daily email digest of new reports.
- Phone usability, large text, plain language and accessible loading, empty, error and recovery states. Gardener contact details are coordinator-only.

The owner's conversation explicitly supersedes brief.md feature 5: defer the plot map until after first-version acceptance. T-018 is in the post-first-version phase and blocked by T-017. Online payments and tool lending are also deferred. Preserve brief.md as the original source, and use the initial setup handover for approved amendments and coverage.

## Architecture and technology

This repository began with brief.md only. No application behavior has been implemented or verified. Project metadata is generic; language, stack, hosting, database, email provider and scheduler are TBD in T-001. No provider or framework was mandated by the owner.

Planned responsibilities: authentication/authorization, household and seasonal data, application/allocation state transitions, problem reporting, and durable daily-email batching. Core entities are households, seasons, 40 stable plot identifiers, applications, active/historical allocations, problems and digest batches. This is one garden, not a multi-organization product.

## Approved provisional assumptions

- One account per household initially; coordinator-assisted reconciliation of duplicates with explicit conflict handling.
- Default season dates 1 March–31 October. Coordinator configures garden timezone and application opening/closing separately; do not guess geographic timezone.
- Returning means held a plot in the immediately previous season. Priority cutoff is strictly before 1 February 00:00 garden local time. Draft allocations do not confer holdings; initial allocation cannot finalize before the cutoff.
- Preferences are advisory. Initial priority groups use application order; waiting list always uses original submission timestamp plus deterministic sequence.
- Active holdings are unique per household/plot/season; ended holdings remain historical. Released plots may be reassigned, but withdrawn/released households cannot reapply in that season.
- Reports concern the gardener's own active plot. Gardener receives submission confirmation; stored report lists/details/history are coordinator-only.
- Digest defaults to 08:00 garden local time, skips empty days and includes new reports even if already resolved. Catch up after downtime.

T-003 reviews phone journeys and provisional domain rules before dependent implementation. Checkpoints T-003, T-007, T-011, T-015 and T-017 are ordinary tickets without a technical owner-approval gate; record explicit owner decisions, never infer acceptance from passing tests.

## Development and verification

Read RULES.md for business and privacy invariants. TDD applies to core business logic, state transitions, authorization and data transformations. Use synthetic households/contact data.

Full pipeline is the approved quality level. WRITE_TESTS, TEST, BUILD and VERIFY are explicitly disabled only because no manifest or commands exist yet. T-001 must establish real commands and enable applicable stages before completion, documenting any truly inapplicable stage. Do not mistake disabled stages for permission to skip verification.

Use `$story` to load project context. T-001 (tooling) and T-002 (phone prototype) are initially ready. Scope implementation to the chosen ticket; record out-of-scope discoveries as issues. No product implementation is authorized merely by setup approval.
