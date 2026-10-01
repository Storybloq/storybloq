# Plotbook rules

## Allocation and records

- A household holds at most one plot per season; a plot has at most one household per season. Enforce both transactionally, including concurrent requests.
- Maintain 40 plot records and valid March-October seasons. Configure exact dates, application window and garden timezone rather than inventing them.
- One application per household-season; preserve its original server submission timestamp and stable ordering through retries and waiting-list transitions.
- Allow zero to three distinct valid preferred plots. Preferences never guarantee allocation of a particular plot.
- Initial allocation cannot begin before February 1 00:00 garden time. Previous-season holders applying strictly before that instant precede ordinary applicants. At/after-cutoff returning applicants join ordinary applicants; within categories use submission order and stable ties.
- The waiting list is strictly first come, first served using original application order. Returning priority does not reorder it. Direct assignment, reassignment and promotion cannot bypass it. Record withdrawals explicitly and audit changes.
- Coordinator-managed household identity and historical records establish eligibility; do not trust self-claimed returning status.

## Access, privacy and usability

- Use emailed short-lived, single-use links, never passwords. Protect against replay, enumeration, unsafe redirects and abusive requests; keep tokens and secrets out of logs and source control.
- Enforce authorization on the server and every relevant API. Gardeners access their own household only; contact details and other-household records are coordinator-only.
- Problem reports must be linked to the gardener's allocated plot. Validate bounded nonempty text and render it safely. Resolution preserves history.
- Use large readable text, plain language, labeled controls, keyboard/focus support and non-color-only status. Handle loading, empty, failed and recovery states on phones.

## Daily email and recovery

- Send the coordinator at most one successful logical digest per garden-local day. No empty digest. Include new reports even if already resolved, with status, minimal private details and authenticated links.
- Persist a batch/outbox and freeze membership before sending. Use a stable provider idempotency key and delivery reconciliation; never discard reports or advance success state on delivery failure.
- After missed days without an existing batch, consolidate outstanding reports into the next scheduled batch. Reconcile/retry failed or ambiguous frozen batches at subsequent scheduled runs before creating another; newer reports remain pending for a later daily batch.
- Resolve ambiguous delivery before another send. Test concurrent schedulers, downtime, retries, DST, reports arriving during an unresolved batch and the daily delivery limit. Do not claim universal exactly-once email delivery.
- Use fictional records and sandbox mail for tests. Live delivery and deployment require authorization. Rehearse backup restoration and reconcile restored email state against provider records.

## Verification and scope

- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- Verify cutoff boundaries, late-returner ordering, FIFO, uniqueness under concurrency, authorization, idempotency and complete mobile journeys. Record manual accessibility evidence.
- Do not mark work complete based solely on the brief or a plan. Keep pending verification commands disabled until established by real project tooling and tests.
- The coordinator plot map and equivalent holder overview belong to T-018 after first-version launch; they are excluded from first-version acceptance. Payments and tool lending are also deferred.
- Owner checkpoints are ordinary tickets without automatic enforcement. Obtain and record their decisions; do not automatically launch on acceptance.
