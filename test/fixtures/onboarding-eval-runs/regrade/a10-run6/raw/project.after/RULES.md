# Development rules

- First names only; collect no surname or contact details. Public board excludes repair items. Bound inputs and render plain text safely.
- Nothing is retained after the day ends. T-003 must resolve the storage/offline-deletion conflict before T-004; do not silently weaken this requirement.
- Use the configured cafe timezone for day boundaries. Purge expired server data before serving; every client list and form clears at expiry even offline. Expired responses must never restore old data.
- Visitor API responses use no-store. No visitor payloads in logs, browser persistence, backups, source control or Storybloq artifacts. Store local runtime data under ignored `runtime/` if persistence is approved.
- Queue order is FIFO. Claims are atomic across concurrent repairers; a visitor cannot be claimed twice. Finish is harmless when repeated. Refresh uncertain mutation results before retrying.
- Handle empty, invalid, loading, stale and failed states explicitly. Provide labels, keyboard operation, readable display and appropriate focus handling.
- Preserve Vite/JavaScript and FastAPI/Python. Trusted LAN deployment is an assumption, not authorization to expose unauthenticated controls publicly.
- Board privacy expiry belongs to T-007. Ten-second polling, overlap prevention, stale-state indication and recovery belong to T-008.
- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- Verify concurrent claims, duplicate first names, day rollover, offline clients and expired replies with synthetic data. Do not claim tests passed unless run.
