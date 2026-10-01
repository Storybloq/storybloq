# Plotbook development rules

Sources: brief.md / Rules and Constraints; owner sign-in, notification and map-deferral decisions; the approved setup assumptions recorded in the initial handover.

## Allocation and ordering

- Enforce at most one plot per household per season and at most one household per plot per season with atomic persistence constraints, including concurrent writes.
- The registry contains 40 stable plots. Seasons have explicit March–October dates and a configured local timezone.
- Applications accept zero to three distinct valid preferences. Preferences are requests, not guarantees. Duplicate submissions preserve the existing application and its original ordering.
- Record application time on the server with a deterministic sequence for ties. Waiting order is original application order, never enqueue order.
- During the initial allocation round, previous-season holders who applied before local February 1 precede new/late applicants. Within that eligible cohort, use original application order.
- Moving an eligible returning applicant to the waiting list must not clear priority while capacity remains. During initial allocation, waiting placement occurs only after capacity is exhausted. Close the round only when every applicant has allocation or waiting disposition.
- After the initial round, later applicants enter the chronological waiting list and vacancies go to its head. Do not reapply returning priority or bypass the head.

## Identity, privacy and usability

- Passwordless sign-in uses secure expiring single-use emailed links with atomic consume, rate limiting, non-enumerating responses and session/logout support. Never log tokens or credentials.
- Provision the coordinator role through a trusted operator, never public signup. Enforce roles and household ownership server-side on every protected operation.
- Only the coordinator may view gardener contact details. Gardeners see their own applications, allocations and reports, not other households' private data.
- One verified email represents a household; coordinator correction and historic holdings are an approved assumption, not an invitation to infer real household identities.
- Use large text, plain language, phone layouts, keyboard/focus support, sufficient contrast and explicit error/loading/empty/recovery states. Never communicate status solely through color.
- Reports are text-only and concern the reporting household's assigned plot. Prevent duplicate submissions; resolution is idempotent.

## Daily digest and persistence

- Send one logical daily batch of new reports to the coordinator at the configured local time. Skip empty days. Include reports resolved since submission with their status labelled.
- Persist batch identity, membership and progress. Do not advance the successful-delivery boundary on failure, lose reports on retry or create a fresh batch identity for the same retry.
- Catch up after scheduler downtime and expose delivery failures to the operator. Verify provider idempotency before claiming duplicate-free physical email delivery; document provider limitations explicitly.
- Keep contact details and secrets out of digest content. Link to authenticated application views.
- Verify restart and backup/restore preservation of allocations, original waiting order and reports. Use synthetic test data, never real household contact details in fixtures.

## Testing and scope

- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- The Full pipeline stages are pending at setup. T-001 establishes collected tests and build/dev/readiness commands, then validates and enables WRITE_TESTS, TEST, BUILD and VERIFY. Never claim pending commands are established.
- Test cutoff boundaries, priority bypass attempts, enqueue-versus-application ordering, concurrent allocation, authorization isolation, token replay and digest failure/recovery.
- The coordinator map and grid layout are T-014, deferred until T-013 first-version acceptance by owner instruction. No first-version ticket requires map evidence. Payments and tool lending are also deferred.
- Owner checkpoint tickets are not automatically enforced. Record actual owner review; do not silently close them as accepted.
