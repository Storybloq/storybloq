# Plotbook development rules

## Allocation and integrity
- A household holds at most one plot per season; a plot has at most one holder per season. Enforce with database constraints and transactions, not UI checks alone.
- Household identity is distinct from email; reconcile duplicates before allocation while preserving history and original application timestamps.
- Use only last-season holdings for returning eligibility. Applications strictly before February 1 00:00 of the season year in configured garden timezone qualify.
- Do not allocate initially before that deadline. Eligible active returning households receive available plots before ordinary applicants. A recorded reason or waitlisted status never bypasses this rule; explicit withdrawals must be audited.
- Apply timestamp/stable ID order within initial groups. Late returners are ordinary applicants.
- Finalize initial allocation at/after the deadline only when plots are exhausted or all active applicants allocated. Queue all remaining active applicants in original application order.
- Waiting list is strictly FIFO across all households after finalization. Edits never improve position. Promote only the head; no arbitrary reorder, skipping or automatic expiry.
- Retry and concurrent requests must not duplicate applications, allocations or promotions. Failed mutations roll back. Audit corrections, releases, withdrawals and reconciliation.
- Validate 0-3 distinct existing plot preferences. Preferences are advisory, not guaranteed.

## Access and privacy
- Check authorization server-side for every HTML/API request. Gardeners see only their own allocation/reports; coordinator alone sees contact details and plot-holder grid.
- Coordinator role is provisioned independently; never self-selectable by a gardener.
- Use expiring hashed single-use email tokens, atomic redemption, throttling and generic request responses. No passwords. GET/link scanners must not consume tokens before confirmation.
- Keep secrets, login tokens and contact details out of repository, logs and public responses. Test with synthetic data and captured email.
- Reports retain historical plot/household/season links after allocation changes. Escape untrusted text.

## Daily digest
- Send one scheduled daily digest to the coordinator; include no-new-reports summary on empty days.
- Track durable coverage, batch and delivery state. Include newly created reports even if since resolved.
- Handle cutoff arrivals, overlap, retry, outage and ambiguous provider responses without report loss or duplicate delivery. Prove provider/delivery deduplication before release.
- Keep contact details out of the digest; links require coordinator authentication.

## Usability and verification
- Large readable text, plain language, responsive phone layouts, labelled inputs, keyboard/focus support and non-colour-only status.
- Every UI covers empty, loading, success, validation failure and recovery; preserve input on error.
- TDD for business logic: write tests first for core functional code (calculations, validation rules, state machines, data transformations, AI evaluation harnesses). Tests define the contract before implementation.
- Use PostgreSQL for database constraints and concurrency evidence. Test exact date boundaries, initial-priority bypass, FIFO, unauthorized access, token races and digest delivery faults.
- Keep pending recipe stages disabled until commands and supporting sources/configuration exist. No invented performance targets or completion claims.
- Checkpoints T-003, T-011 and T-017 require owner evidence; acknowledge that Storybloq does not technically enforce human approval.
- Online payment and tool lending remain outside V1.
