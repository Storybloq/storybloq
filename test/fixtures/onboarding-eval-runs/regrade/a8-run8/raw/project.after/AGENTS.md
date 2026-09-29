# Plotbook

Plotbook replaces paper applications and a wall chart for Riverside Community Garden: 40 plots, roughly 60 households and one volunteer coordinator. Seasons run March–October. This is a brief-only project with an approved backlog; no application functionality is implemented yet.

## Approved first version

Gardeners sign in with emailed one-time links, apply for the coming season with up to three preferred plots, see their allocation and season dates, and report a problem with their own plot. The coordinator reviews and allocates applications, manages a strictly first-come-first-served waiting list, resolves problems and receives one daily email of new reports.

The plot map is explicitly post-v1, in T-012, blocked by first-version acceptance T-016. Do not add a substitute whole-garden holder dashboard to v1. Online fee payments and tool lending are also deferred. The 40-plot registry and available-plot selection remain necessary in v1.

## Planned architecture

- Python/Django, responsive server-rendered pages and PostgreSQL.
- Email adapter for passwordless links, invitations and daily digest; externally scheduled management command for the digest.
- Core records: household/member, season, plot, prior holding, application, allocation, waiting entry, problem report, digest batch and audit record.
- Coordinator verifies household membership and historical holdings and initiates enrollment/invitations. Email address is not household identity.
- Authenticated access is scoped by role and household. Contacts are coordinator-only.

## Workflow and approved assumptions

Preferences are optional, distinct, advisory and unranked. Record original application time plus a stable sequence for ties. At most one plot per household and one household per plot per season.

Returning gardeners with a prior-season holding qualify for initial priority only if they apply before midnight beginning 1 February of the target season year in the garden timezone. New-applicant allocation and round finalization cannot happen before that cutoff. After finalization, promotion uses original application order without a returning-priority override. See RULES.md and T-007–T-009.

Proposed link expiry is 15 minutes. Address recovery is independently verified by the coordinator, audited, preserves the household and revokes old sessions/tokens. Reports are text-only and tied to a current allocation; historical associations are retained. Self-service application edits, withdrawals and allocation reassignments are excluded; validated coordinator correction procedures belong to T-015.

Digest default is 08:00 garden local time, skips empty days and includes reports created since the last successful batch even if now resolved. Persist batches and retries; uncertain provider delivery is surfaced for reconciliation. Do not promise exactly-once SMTP delivery.

## Verification and delivery

Quality level: Full pipeline. All four recipe stages are disabled initially because no application, manifest, runner or collected test sources exist. T-001 establishes and verifies commands before enabling applicable stages.

- WRITE_TESTS / TEST proposal: `python manage.py test`.
- BUILD: TBD genuine deployment artifact command; keep disabled if no build is required. `python manage.py check` is validation, not packaging evidence.
- VERIFY proposal: `python manage.py runserver 127.0.0.1:8000`, readiness `http://127.0.0.1:8000/`.
- TDD for core business logic, allocation rules, persistence invariants and digest state transitions. Include authorization, concurrency, retry and phone/keyboard journeys.
- Use synthetic data until launch prerequisites are satisfied.

## Decisions to establish during implementation

T-001 selects hosting, email delivery and scheduler arrangements and documents costs/provisioning. Owner supplies accounts. Exact March–October season dates, garden timezone and contact-retention policy must be recorded before live use (T-002/T-015). These are implementation/launch prerequisites, not permission to invent existing infrastructure.

## Storybloq continuity

Use `$story` to load `.story/` context. Initial setup handover records the approved brief, coverage, assumptions and review. Start with T-001 or T-004. Mark work in progress when started; never claim completion without verification. T-005, T-010 and T-016 are owner checkpoints. Their gates are ordinary ticket dependencies, not mechanically enforced owner approval; record an explicit owner response before completion. Read REVIEW.md for the review contract. Do not overwrite historical handovers.
