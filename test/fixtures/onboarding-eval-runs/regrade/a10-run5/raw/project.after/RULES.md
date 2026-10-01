# Shelfmate development rules

- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- First version covers search, lending, returns and restart preservation. Overdue functionality belongs exclusively to T-010 after T-009 acceptance; it cannot block the first version.
- One book record is one physical copy. Permit at most one active loan per copy, including concurrent requests. Validate identifiers, pupil labels and calendar dates. Repeated returns preserve the first return timestamp; completed returns must never be resurrected by retries.
- Keep book and loan identifiers stable across restart and migrations. Migrations must preserve existing catalogue records.
- Serialize all mutations through one persistence transaction boundary. Persist operation identifiers/results alongside changes to prevent duplicate additions or loans on retry.
- Acknowledge success only after supported atomic replacement and durability barriers. Pre-replacement failure leaves prior state intact. If replacement may have succeeded but durability confirmation fails, report outcome uncertain, never claim rollback, and stop mutations until disk is reloaded/validated and the operation identifier reconciled. Startup completes the supported durability barrier before accepting mutations. Document filesystem-dependent power-loss limits honestly.
- Only a missing data file initializes empty. Corrupt or unreadable existing data must stop startup without overwriting it. Recovery instructions must be nondestructive. Fault-inject failures before and after replacement and verify restart/retry outcomes.
- Keep runtime data under ignored `data/`; no real pupil data, secrets or credentials in the repository, logs, error responses, fixtures or handovers. Use fictional labels for testing and demos.
- Remove the pupil label in the successful return transaction while retaining book/loan ids and dates. No label may remain in the retry ledger. Old backups may contain labels: document local access restrictions and manual deletion/rotation, without claiming external copies are automatically erased.
- Bind locally; validate the configured loopback Host/port. Mutations require exact same-origin Origin, JSON content type and a same-origin custom header; reject missing/foreign Origin. Reject foreign supplied Origin on reads and do not enable permissive CORS. Tests/API clients must provide required headers.
- Bound request bodies, validate input, and return clear 4xx errors without crashing on malformed JSON. Render user text safely. Do not expose pupil labels in errors or logs.
- UI controls must be labelled and keyboard accessible, with visible focus, announced outcomes and appropriate loading, empty, no-results, error and retry states. Recover uncertain saves by the same operation id, not blind fresh submissions.
- Due dates use local calendar dates with an editable 14-day default. Later overdue logic means outstanding and due before today; test date/month/year boundaries only as part of the deferred feature.
- Keep tests isolated in temporary directories and clean only test-owned data. Verify storage failures, corruption, concurrency, migration, retry idempotency, restart preservation and pupil-label removal. Add manual browser/keyboard and backup/restore evidence for acceptance.
- Record actual owner feedback on checkpoint tickets. A tool allowing closure is not evidence that the teacher accepted the milestone.
