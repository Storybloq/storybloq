# Plotbook

Plotbook serves Riverside Community Garden: about 60 households applying for 40 plots allocated per March-October season. The first version supports applications with up to three preferred plots, coordinator allocation and a chronological waiting list, own allocation and season dates, plot problem reporting/resolution, and a coordinator grid of all 40 plots.

## Sources and project state

- Product source: brief.md (Background, Users, First version must, Rules, Constraints, Later).
- Owner decisions: emailed single-use sign-in links, no passwords; one daily email of new problem reports to the coordinator; technology and unspecified details delegated to the implementer.
- Approved setup decisions and requirement coverage are in the initial .story/handovers/ setup handover. Tickets hold acceptance conditions and dependencies.
- No product code exists yet. All 15 tickets are open. Four milestones follow the default Setup phase.
- Payments and tool lending are outside version one. Multi-garden support, optimization, attachments, chat and per-report notifications are excluded from the approved plan.

## Planned architecture and tooling

Language, framework, database product, hosting, mail provider and scheduler: TBD in T-001. Choose a stack with relational transactions, expiring single-use sign-in tokens and reliable scheduled jobs. Use local fake email and synthetic data before provider credentials are available. Do not infer Node/npm tooling from Storybloq's own implementation.

Planned records: households with associated sign-in emails, coordinator/gardener roles, plots, seasons, prior holdings, applications and preferences, allocations, waiting-list offers, problem reports and digest delivery records. Server-side authorization separates household views from coordinator administration. Database uniqueness and transactions protect allocations; scheduled delivery has durable progress and retry state.

## Approved assumptions

Coordinator verifies household identity and duplicate registrations before applying, and approves prior-season holdings before opening a season. Preferences are optional (0-3 distinct valid plots) and are not guarantees. Applications can be edited until closed, preserving their first submission timestamp and stable ordering sequence.

Returning households with a prior-season holding and applications strictly before local midnight on February 1 have initial-allocation priority. Late returners join other applicants. Within priority groups, use original application order. The waiting list itself is strictly chronological, regardless of returning status. Coordinator records offers and acceptance/decline; no automatic expiry. Exact season dates, garden timezone and daily digest time are configured by the coordinator.

No digest is sent on empty days. New reports include reports resolved before the digest; failed delivery preserves pending data. Uncertain external email delivery may produce a duplicate; do not promise exactly-once delivery.

## Development and acceptance

Follow RULES.md. Use TDD for core rules, validations, state transitions and data transformations. Quality level: Full pipeline. WRITE_TESTS, TEST, BUILD and VERIFY are disabled until T-001 establishes commands, collected tests and applicable server readiness evidence. Then configure the approved stages from actual project tooling.

T-005 reviews the phone journey and household onboarding; T-010 demonstrates allocation; T-015 accepts version one. These are ordinary tickets: the tool does not enforce human approval. Record explicit owner acceptance before closing checkpoints. Production deployment is not authorized by project setup.

Use $story at session start to load progress. When implementing a ticket, mark it inprogress; complete it only with implementation and verification evidence. Keep handovers append-only. The immediate next work is T-001.
