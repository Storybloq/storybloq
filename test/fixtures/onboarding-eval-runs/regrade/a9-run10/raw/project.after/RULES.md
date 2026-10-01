# Plotbook rules

Source: brief.md and the owner's approved setup package; implementation tickets provide detailed acceptance conditions.

## Allocation and data integrity

- A household holds at most one plot per season; a plot has at most one holder per season. Enforce both transactionally and in the database, including concurrent requests.
- There are 40 uniquely identified plots. Season dates fall within March-October; require explicit dates and garden timezone.
- Validate household identity and prior-season holdings with the coordinator. Never infer that two emails represent two households.
- Returning prior-season holders who apply strictly before February 1 in the garden timezone are allocated before new applicants. Test the exact cutoff; late returners join the nonpriority group.
- Keep the waiting list strictly first come, first served by original application timestamp and stable tie-break sequence. Editing preserves position; returning status never reorders this list.
- Applications permit up to three distinct valid preferred plots. Preferences are not guarantees. Prevent duplicate household-season applications and duplicate retry writes.
- Allocation, offers and acceptance must remain safe under concurrency. No queue skipping. Invalid/withdrawn application rejection and offer decline require a recorded reason. Failed operations leave data unchanged.
- Imports and household merges are validated, previewed, atomic and auditable.

## Privacy and identity

- Use emailed, expiring, hashed, single-use sign-in tokens; no passwords. Handle expiry/replay safely, rate-limit requests, use neutral responses and validate redirects.
- Authorize on the server for every read and write. Gardeners access only their own household's application, allocation and reports. Coordinator role cannot be self-assigned.
- Gardener contact details are visible only to the coordinator. Do not leak them through gardener responses, markup, logs, maps or emails.
- Keep secrets, credentials and resident-identifying test data out of versioned files. Use synthetic fixtures and fake mail in tests.
- Problem reports derive plot/season from the caller's active allocation, never trust a client-supplied household association. Escape report text.

## Daily email and recovery

- Send one scheduled daily digest of new reports to the coordinator, omitting empty days. Include newly created reports even if already resolved.
- Track cutoffs and delivery state durably. Overlapping jobs and retries must not create separate digest records or silently omit reports. Failed sends retain pending data; delayed runs cover the backlog.
- Authenticate job execution, protect mail links with sign-in, surface operational failures, and use provider idempotency when available. Document ambiguous-send duplicate risk rather than claiming exactly-once external email.
- Demonstrate backups and restoration safely before release; never overwrite production silently. Make retention policy owner-visible and configurable before launch.

## Usability and verification

- Phone-first journeys use large text, plain language, labels, keyboard/focus support, zoom/reflow and non-color-only feedback. Provide accessible empty, loading, success, error and recovery states.
- TDD for business logic: write tests first for core functional code (calculations, validation rules, state machines, data transformations, AI evaluation harnesses). Tests define the contract before implementation.
- Verify boundary dates, ordering, concurrency, unauthorized access, retries, and complete gardener/coordinator journeys. Do not invent performance targets or completion claims.
- Configure quality commands only from established project tooling. No default npm command is valid while the language and framework remain undecided.
- Payments and tool lending are deferred. Record explicit owner acceptance at checkpoint tickets; setup alone does not authorize production deployment.
