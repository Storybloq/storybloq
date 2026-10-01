# Plotbook rules

## Fixed domain requirements

Source: brief.md Background, Rules and Constraints; owner sign-in, notification and map-deferral decisions in the initial handover.
- Maintain 40 distinct garden plots and season-specific allocation records; seasons run March to October with configured dates and garden timezone.
- A household holds at most one plot per season. A plot has at most one household holder per season. Enforce both transactionally and with database constraints.
- Returning gardeners who held a plot last season and apply strictly before 1 February receive allocation priority before new applicants. Load prior-season evidence rather than guessing.
- Waiting-list order is strictly first come, first served by original application timestamp, independently of returning priority. Retried submissions must not reset that timestamp.
- Accept up to three distinct valid plot preferences. Preferences do not guarantee an assignment (approved assumption).
- Multiple user accounts in one canonical household share one entitlement. Authentication or a household verification request is not a submitted plot application.
- Late returners use ordinary priority and exact timestamp ties use a stable ID (approved assumptions for T-004 review).

## Privacy, authentication and reporting

- Gardener contact details are visible only to coordinator. Authorize every server read/write, not just UI routes. Gardeners access only their own private household records.
- Email sign-in links expire, are single-use and stored as hashes; protect redirects, rate-limit requests and avoid account enumeration. Never log link tokens or contact details.
- Household verification is coordinator-controlled, with duplicate checks and restricted pending access.
- Gardener reports must reference their own current-season allocated plot. Coordinator alone resolves reports.
- Send one daily coordinator digest of new reports, including reports resolved since creation. Skip empty digests (approved assumption). Include minimal data and authenticated links.
- Digest jobs need durable windows/outbox state, stable idempotency keys, concurrency protection and recoverable failures. Do not mark sent before confirmation. Surface ambiguous provider deliveries instead of blindly resending.
- No secrets, credentials or identifying customer data in source, tickets or handovers.

## Usability and scope

- Support phones, large text, plain language, keyboard/screen-reader access, labelled controls and clear loading/empty/error/recovery states.
- V1 uses a coordinator allocation list. Plot map T-014 is after first-version acceptance T-013. Payments and tool lending remain out of scope.
- Owner checkpoint tickets require documented owner review but are not mechanically enforced by Storybloq.

## Verification

- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
- Verify cutoff boundaries/timezones, priority, strict FIFO, database concurrency, duplicate submissions, auth expiry/replay, new household onboarding, privacy boundaries and digest restart/failure recovery.
- Use representative synthetic household/history fixtures; no real gardener data in tests.
- T-012 supplies full phone-journey, usability/accessibility, real staging email and backup-restoration evidence before T-013 acceptance.
- Full pipeline is approved but its stages remain disabled until T-002 establishes tooling. Never claim an unrun check passed.
