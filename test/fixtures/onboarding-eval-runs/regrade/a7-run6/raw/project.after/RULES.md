# Queue board rules

- Scope follows BRIEF.md: add, take next, finish and automatically refreshed board. SMS is deferred.
- T-002 resolves ordering, access, privacy, storage/durability, retention, deployment and completed-entry visibility. FIFO is a proposal, not an established domain rule.
- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- Validate first name/item and queue transitions at the API boundary. Invalid operations leave queue state unchanged.
- Claim the next visitor atomically. Concurrent repairers must never receive the same visitor; retry after a lost response must recover the original claim rather than claim another visitor.
- Guard repeated visitor submissions and repair completion requests against duplicate effects.
- Follow agreed privacy/access rules for every read and mutation; never copy secrets, credentials or customer data into tracked documentation.
- Preserve last known board data with stale/offline feedback during connection failures. Older refresh responses must not overwrite newer state; clean up background work on navigation.
- Test domain transitions, concurrency, retry/recovery and the agreed restart/retention behaviour. Use integrated evidence to accept the full journey.
- Report source inspection and executed verification separately; a test file is not evidence that tests passed.
