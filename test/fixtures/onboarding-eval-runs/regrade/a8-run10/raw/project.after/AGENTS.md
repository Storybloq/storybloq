# Plotbook

## Purpose and first-version outcome
Plotbook serves the Riverside Community Garden's roughly 60 households and one volunteer coordinator managing 40 seasonal plots. The first version lets a gardener apply with up to three preferences, see an allocation and season dates, and report a plot problem. The coordinator reviews applications, allocates fairly, manages a FIFO waiting list, sees a 40-plot grid, resolves reports, and receives one daily digest.

Source of requirements: brief.md, plus owner decisions captured in the initial Storybloq setup handover. Online payments and tool lending are deferred.

## State and architecture
This repository started with only brief.md. No application capabilities are implemented. The approved planned stack is Python/Django, PostgreSQL, server-rendered HTML/CSS and minimal JavaScript, an email transport adapter, and a scheduled Django digest command. Hosting/email/scheduler choices are established in T-001; no provider is assumed purchased or configured.

Core entities: household, email login/session, plot, season, prior allocation, application/preferences, allocation, waiting-list position, problem report, digest batch/delivery and audit event. Household identity is independent of email. One coordinator role is provisioned separately; gardeners cannot grant roles. All permissions are server-enforced.

## Identity and privacy
Emailed single-use links, no passwords. Proposed expiry: 15 minutes. Tokens must expire, resist replay and concurrent redemption, and remain out of logs. Link scanners must not consume a token on GET. Gardener contact details are visible to the coordinator only; no public contact directory. Use synthetic data in code, tests and demos.

## Approved domain assumptions
- One email login represents a household; coordinator reconciles duplicate household records without losing history or application order.
- Preferences are optional, distinct, ordered and advisory (0-3). No promise of preferred or prior plot.
- Season defaults March 1-October 31, editable within March-October. Garden timezone must be configured.
- Initial allocation starts at February 1 00:00 of the season year in garden time. Last-season holders applying strictly before that instant receive available plots before ordinary applicants. A reason or waitlisted status cannot bypass priority. Explicit withdrawal is audited.
- Within initial priority groups, application timestamp then stable ID breaks ties; late returners join ordinary pool. With more eligible returners than plots, no ordinary applicant is allocated.
- Finalize initial allocation only after the deadline when capacity is exhausted or every active applicant is allocated. Remaining applicants enter global FIFO order; returner priority does not reorder that queue.
- Edits preserve original submission timestamp. Only queue head receives a vacancy; no automatic expiry or arbitrary skipping.
- Daily report email defaults to 09:00 garden local time, with an empty-day summary. Include reports created since the previous covered interval even if now resolved. Failed delivery retains backlog; prove delivery deduplication before release.
- No attachments, public discussion, or report reopen workflow in V1.

## Work and verification
Use $story to load project context. Start with T-001 (foundation) or T-002 (prototype). Read the ticket and RULES.md before implementation; maintain ticket status. Tests first for core functional/business logic.

Quality level: Full pipeline. All four recipe stages are disabled initially because tooling is not established. T-001 must establish runner plus collected tests, static collection configuration, server and /health/ endpoint before enabling the matching stages. Proposed commands:
- WRITE_TESTS: python manage.py test
- TEST: python manage.py test
- BUILD: python manage.py collectstatic --noinput
- VERIFY: python manage.py runserver 127.0.0.1:8000; readiness http://127.0.0.1:8000/health/

Use real PostgreSQL for constraint and concurrency verification, captured/sandbox email for delivery tests, and manual phone/keyboard checks alongside automated regressions. Do not infer passing tests or completed work from this plan.

## Owner checkpoints and operating inputs
T-003 reviews the mobile prototype; T-011 demonstrates applications/allocation; T-017 accepts V1 after T-016 verification. Stage-1 limitation: checkpoints are ordinary tickets, not technically enforced human approval gates.

Pending implementation inputs: garden timezone, actual plot labels/layout, household reconciliation and last-season paper records, verified sender/coordinator address, hosting credentials, retention/lifecycle detail and browser matrix. Address in their tickets; no need to repeat settled product questions. No deployment or purchase is authorized merely by setup approval.
