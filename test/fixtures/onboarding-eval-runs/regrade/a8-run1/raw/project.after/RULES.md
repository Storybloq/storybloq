# Plotbook rules
Sources: brief.md / Rules and Constraints; owner sign-in, digest and map-deferral decisions; approved setup assumptions.

- Enforce at most one plot per confirmed household per season and one holder per plot per season transactionally, including concurrent requests.
- Coordinator confirms household declarations. Unresolved duplicates block allocation. Merges preserve earliest valid application receipt/sequence, verified membership and history; resolve conflicting holdings explicitly.
- Last-season holders applying strictly before February 1 garden-local midnight take allocation priority over new applicants. No final new-applicant allocations before that cutoff or while eligible returning applications remain unresolved. Late returners are ordinary applicants.
- Waiting-list vacancies use global FIFO across all eligible unallocated applications. Reconcile the complete population before assignment; never permit selective waitlisting to bypass an earlier application. Preserve immutable original receipt timestamps and a stable tie-break sequence.
- A seasonal application has zero to three distinct preferred plots; preferences are advisory. Retried submissions and state changes must not duplicate records.
- Sign-in uses expiring, single-use emailed links, no passwords. Use hashed tokens, secure sessions, safe return URLs, generic request responses and rate limits; never log tokens or contacts.
- Only the coordinator sees gardener contact details. Enforce role and household access server-side; gardeners see only their own household and report only against their allocated plot.
- Keep historical report plot/season associations after reallocation. Resolution is idempotent.
- Daily digest includes reports created since last successful delivery, even if subsequently resolved. Use durable delivery state/cursor and retry/catch-up; failed delivery does not advance success. Omit contacts from emails. Surface ambiguous delivery; use provider deduplication when available.
- Use large text, plain language, accessible labels and keyboard operation on phones. Provide clear loading, empty, validation, error and recovery states.
- TDD for business logic: write tests first for core functional code (calculations, validation rules, state machines, data transformations, AI evaluation harnesses). Tests define the contract before implementation.
- Implement and verify finite contact/report retention, deletion, backup expiry and deletion replay after restore in T-013; retain only necessary allocation history. Owner reviews retention periods before launch.
- Verify complete first-version journeys on staging in T-014 before production release T-015; use backups and a rollback procedure.
- The plot map is explicitly after first-version acceptance (T-017 depends on T-016). It is excluded from the first-version prototype and acceptance. Payments and tool lending are deferred.
- Owner checkpoints need recorded owner review; do not infer approval from ticket closure. Never overwrite an existing handover.
