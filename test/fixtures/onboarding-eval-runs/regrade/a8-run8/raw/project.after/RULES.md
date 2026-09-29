# Plotbook rules

Source: brief.md, owner's email authentication/daily digest decisions, map deferral and approved setup package (independent review invocation R3). Rules below distinguish approved implementation assumptions from the brief where needed.

## Allocation and data integrity

- A household holds at most one plot per season. Also enforce one household per plot per season transactionally, including concurrent writes.
- Coordinator verifies household membership and prior-season holdings. Never infer household identity solely from an email address; reconcile duplicate records explicitly.
- An application records at most three distinct valid preferred plots. Approved assumption: preferences are optional, advisory and unranked. Preserve original submission time and a stable tie-break sequence; retry must not create another application.
- Prior-season holders applying before 1 February receive initial allocation priority. Approved cutoff interpretation: exclusive midnight starting 1 February in the configured garden timezone and target season year. An application at the cutoff is not eligible.
- Never allocate to new applicants or finalize the initial round before the cutoff. Process eligible returning applicants first, using FCFS within each initial cohort.
- Finalization is explicit, confirmed, audited, durable and idempotent. It requires the cutoff to have passed and eligible returners to be processed or capacity exhausted. Serialize against submissions so no applicant is lost or misplaced.
- Waiting-list order is strictly original application order. Promote only the head after finalization; neither returning status nor plot preferences may override FCFS. A stale or concurrent action must fail safely rather than overwrite data.
- Preserve allocation constraints and queue order through audited coordinator correction procedures. Never silently delete historical holdings, reports or audit evidence.

## Access and privacy

- No passwords. Use expiring, single-use emailed links/invitations, rate limits, generic request responses and validated redirects.
- Verify authorization server-side on every role/household-scoped action, including direct requests. Gardener contact details are visible only to the coordinator.
- Address recovery requires independent coordinator verification, is audited, preserves household identity and revokes old sessions and tokens.
- Never put credentials, link tokens or gardener contacts in logs, repository files or digest emails. Use synthetic data for development and initial verification.

## Reports and email reliability

- A gardener reports only for their current allocated plot; retain the original association historically. Reports are plain text; attachments are excluded.
- Persist per-household submission idempotency keys. A timed-out successful submission retried by the client returns the same report; resolution is also idempotent.
- Daily coordinator digest batches include newly created reports even if now resolved. Skip empty days; use authenticated detail links without contact information.
- Persist digest accounting, unsent batches and retry state. Prevent duplicate concurrent batches and recover after missed scheduling. Surface uncertain provider delivery for reconciliation; do not assert exactly-once SMTP delivery.

## Usability, scope and verification

- Phone usability, large text and plain language apply to every primary flow. Include labelled inputs, keyboard focus, non-colour status, empty/loading/error states and safe recovery.
- Plot map T-012 is post-v1 and blocked by T-016. Payments and tool lending are deferred. No v1 acceptance or deployment gate may depend on the map.
- TDD for business logic: write tests first for core functional code (calculations, validation rules, state machines, data transformations, AI evaluation harnesses). Tests define the contract before implementation.
- Test cutoff boundaries, priority, household/plot uniqueness, concurrent submissions/finalization/promotion, unauthorized access, report retries, digest recovery and backup restore. Demonstrate phone and keyboard journeys.
- Full pipeline is the intended quality level; all recipe stages start disabled pending real commands and collected test sources. Establish tooling in T-001 before enabling stages. Never treat Django system checks as proof of packaging/deployability.
- Record owner decisions at T-005/T-010/T-016. Checkpoint completion is not automatically enforced by the tool; do not substitute agent judgment for owner acceptance.
