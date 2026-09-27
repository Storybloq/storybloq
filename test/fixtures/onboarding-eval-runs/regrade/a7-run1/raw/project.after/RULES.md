# Plotbook rules

## Allocation integrity

- Maintain exactly 40 stable plot identifiers. Enforce at most one active holding per household per season and one active household per plot per season transactionally. Preserve ended holdings and decision history.
- Determine returning status from the immediately prior season. Applicants who apply strictly before 1 February 00:00 in the configured garden timezone receive initial priority. Never finalize initial allocation before that cutoff.
- Before allocating to a nonpriority applicant, all eligible active priority applicants must have holdings or capacity must be exhausted. Do not invent a rejection to bypass priority. Only recorded household withdrawal or evidenced duplicate/ineligibility correction removes eligibility; an unmatched preference is not disqualification.
- Preferences are advisory, zero to three distinct plots. Break ties inside initial priority groups by application order.
- Waiting list is strictly FIFO by server submission timestamp and deterministic sequence. Do not reorder it for returning status or silently skip an active head. New applications after initial finalization join the queue while applications remain open.
- Duplicate submissions/retries preserve original application order. Household reconciliation preserves earliest valid submission, resolves competing active holdings explicitly and never silently discards history.
- Application windows are distinct from occupancy dates and the priority cutoff. Configure timezone and window; do not assume a location. Default occupancy is 1 March–31 October.
- Withdrawn/released households cannot reapply that season under the approved provisional assumption. Reassign released plots to the next active waiting household, retaining historical allocations.
- Use transactions and idempotency for allocation, finalization, queue moves, reporting and resolution. Reject stale/conflicting requests with actionable recovery; preserve history across season rollover.

## Access and privacy

- Emailed links expire, are single-use, validate redirects and do not reveal account existence. Apply rate limits and accessible resend/recovery. Never expose tokens in logs.
- Enforce authorization server-side on lists, details, mutations and direct-ID requests. Gardeners can see their own account entry as needed and allocation; other gardener contact information is coordinator-only.
- Coordinator role is never self-selectable. Bootstrap/recovery requires secure out-of-band action with an audit record.
- Gardeners submit plain-text problems against their own active plot only. Stored reports and resolution history are coordinator-only. New plot holders must not inherit prior reporters' private data.
- Test access after household merging, plot release/reassignment and season rollover. Use synthetic fixtures; keep credentials, tokens and personal data out of source, logs and generated project context.

## Daily digest

- Send one daily batch of new reports at the configured time (default 08:00 garden local time); skip empty days. Include reports resolved before delivery and catch up after downtime.
- Persist batch membership, fixed upper watermark and stable provider idempotency key. Concurrent jobs share one batch; arrivals during a send belong to a later batch.
- Retain failed batches and expose recovery. Use a provider with documented idempotent acceptance/retry window. Do not promise exactly-once mailbox delivery; reconcile ambiguous sends beyond the provider window instead of blindly resending or dropping them.
- Minimize email personal data and require coordinator authorization at linked details.

## Quality and scope

- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- Verify boundary and transition scenarios: cutoff/finalization, late application/vacancy, competing allocations, reconciliation, rollover, report privacy and digest crash/concurrency recovery.
- Phone-first flows use large text, plain language, labels, visible focus, keyboard access and explicit loading/empty/error/retry feedback; retain user input after recoverable errors.
- Full pipeline commands are pending T-001, which must enable applicable stages before completion. Release evidence includes deployment smoke check, backup restoration and coordinator runbook.
- First-version acceptance excludes the plot map. T-018 waits for T-017; payments and tool lending remain deferred. Do not close an owner checkpoint without recording the owner's answer; the ticket system does not enforce this gate.
