# Shelfmate rules

- V1 covers find, lend, return and restart persistence. Overdue work T-008 remains deferred until owner acceptance T-007.
- Keep Node.js/JavaScript and the existing npm structure. Default planned deployment is local-only, one teacher, no pupil accounts.
- One record is one physical copy; at most one active loan per copy. Validate pupil label and real date-only due date. Return is safe to repeat and makes the copy available.
- Acknowledge mutations only after the durable commit boundary. Serialize writes, reject competing writers, preserve corrupt files and fail closed rather than silently resetting data.
- Pre-replacement failure preserves previous state. Post-replacement uncertainty requires disk reconciliation before further writes. Never claim every failed response means rollback.
- Stable mutation tokens make retries idempotent. Persist identifier/status replay results without pupil labels or original request bodies.
- Keep runtime data private under data/ and out of git. Do not log pupil labels. Remove labels from current application-managed state on return; document historical backup retention/deletion separately.
- Browser persistent recovery contains only token/action/resource IDs, never pupil labels or form payloads. Clear resolved recovery records; retain unsent/error form input only in memory until resolved/cancelled.
- Bound and validate HTTP input; expose consistent errors without stack/private-data leakage. Use safe text rendering, semantic controls, keyboard support, labels and accessible error/focus behaviour.
- Use synthetic data for tests and owner demonstrations. Test forced interruption, write/rename/sync failures, competing startup, abandoned lock recovery and retry safety.
- TDD for business logic: write tests first for core functional code (calculations, validation rules, state machines, data transformations, AI evaluation harnesses). Tests define the contract before implementation.
- Do not close ordinary owner checkpoints without recorded owner review/acceptance; their gate is not technically enforced.
