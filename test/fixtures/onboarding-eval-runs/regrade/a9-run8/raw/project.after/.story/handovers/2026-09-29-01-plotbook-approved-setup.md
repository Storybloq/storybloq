<!-- storybloq-handover v1 -->

# Plotbook approved setup

## Worker state

Setup complete; no product implementation or app checks run. Brief-only starting folder, no existing completed capabilities. Created seven phases including default p0, fourteen open tickets, AGENTS.md, RULES.md and verbatim REVIEW.md, git repository and runtime ignores. MCP creation tools remained absent from client surface after init, so installed CLI used; client restart may expose full MCP tools.

## Blocked

- No setup blocker. Hosting/email provider and credentials plus garden calendar/timezone must be configured before staging in T-012; none are claimed established.
- Verification stages all explicitly disabled until tooling is established in T-002.

## Owner rulings

- Sign-in: “gardeners sign in with an emailed one-time link; no passwords.”
- Notifications: “the coordinator gets one email a day listing new problem reports.”
- Technology: no preference. Other unspecified choices delegated to agent judgment.
- Scope adjustment: “Defer the plot map view to after the first version.” This overrides brief.md First version must 5 for v1, without deleting the later requirement. T-014 depends on T-007 and first-version acceptance T-013.
- Owner approved the revised R3 setup package with “Approve setup.”
- No other source conflict identified. Fixed rules in the brief are not reopened at checkpoints.

## Product brief and acceptance coverage

Riverside Community Garden has 40 plots and about 60 households. Replace paper applications and wall chart with phone-friendly applications, fair coordinator allocation, a strict FIFO waiting list, own-allocation information and problem reporting/resolution. V1 includes brief requirements 1–4, emailed passwordless sign-in and a daily coordinator digest. Plain list replaces map for v1. Contacts are coordinator-only; large text and plain language are required. Map is post-v1; payments and tool lending deferred.

| Source | Observable acceptance | Coverage |
|---|---|---|
| brief.md Background | 40 distinct plots and configured March–October seasons/history persist | T-002 |
| brief.md First version must 1 | Verified household submits coming-season application with up to three distinct valid preferences and receives receipt | T-003, T-005 |
| brief.md First version must 2 | Coordinator reviews applications, assigns plots and queues unallocated applications in application order | T-005, T-006, T-007 |
| brief.md First version must 3 | Gardener sees own allocated plot and season dates; pending/waitlisted state is clear | T-008 |
| brief.md First version must 4 | Gardener reports own plot problem; coordinator sees open reports and resolves them | T-010 |
| brief.md First version must 5; owner's later deferral | Coordinator 40-plot map is post-v1 only, after acceptance | T-014; explicitly excluded from T-001/T-007/T-009/T-012/T-013 |
| brief.md Rules: household | At most one plot per household/season, including concurrent attempts and multiple accounts | T-002, T-003, T-006 |
| brief.md Rules: returners | Prior-season holders applying before 1 February get priority; cutoff boundary verified | T-002, T-005, T-006; demonstrated T-009 |
| brief.md Rules: FIFO | Queue/promotion strictly follows original application timestamp, independent of returner priority | T-005, T-006, T-007 |
| brief.md Constraints: phone | Complete v1 journeys usable on phone | T-001, T-003, T-005, T-007, T-008, T-010, T-012 |
| brief.md Constraints: contacts | Only coordinator sees gardener contact details, including direct API attempts | T-003, T-007, T-008, T-010, T-011, T-012 |
| brief.md Constraints: usability | Large text/plain language, accessible controls and clear empty/loading/error/recovery states | T-001 and every UI ticket; T-012 verification |
| Owner sign-in decision | Expiring single-use emailed links, no passwords; unknown household can reach application through coordinator verification | T-003, T-005 |
| Owner notification decision | One daily coordinator email lists new reports, with durable recovery and delivery evidence | T-011, T-012 |
| brief.md Later | Plot-fee payments | Explicitly deferred; no ticket |
| brief.md Later | Tool lending | Explicitly deferred; no ticket |

## Assumptions and operational choices

Approved stack TypeScript/Next.js/npm/PostgreSQL, server authorization, transactions and configurable email transport. Canonical household approval by coordinator; unknown verified email gets restricted pending access and can request household verification; duplicates checked before linking/creating; multiple accounts share entitlement. A household verification request is not an application; queue timestamp begins only on valid application submission. T-004 reviews verification approach and prototype. One plot holder per season is enforced. Zero preferences permitted by 'up to three'; preferences advisory. Late returners use ordinary priority; timestamp ties use stable ID. Garden timezone, March–October exact dates, digest hour and prior-season history are configured. Those interpretations are labelled assumptions, not invented brief requirements.

Digest skips empty days, covers all newly created reports even if already resolved, uses authenticated links/minimal data. Durable delivery state, idempotency and failure handling required; provider must deduplicate or ambiguous delivery requires operator resolution. Provider and hosting remain operational choices before T-012 staging, not fabricated existing infrastructure.

## Review record

Independent agent reviewed full plans. Native CLI probe printed nothing; review_plan tool unavailable. R1 findings: add full first-time household onboarding, and separate settled brief rules from checkpoint implementation questions. R2 incorporated both. Owner then deferred map; R3 reviewed adjusted ticket scopes, dependency graph and v1 acceptance with no findings. Review evidence captured in this conversation.

Reviewer probe: `command -v codex` printed nothing
Independent review: approve, invocation R3

## Quality and verification

Quality level: Full pipeline, due allocation business rules, workflows and privacy requirements. TDD for business logic in RULES.md. No component has established commands or test sources; WRITE_TESTS, TEST, BUILD and VERIFY explicitly disabled in recipe overrides, not left to defaults. T-002 establishes proposed tooling; no installation, app tests, build or dev server run during setup.

Verification tooling to establish: WRITE_TESTS: npm test (pending: no application manifest, runner or collected test sources)
Verification tooling to establish: TEST: npm test (pending: no application manifest, runner or collected test sources)
Verification tooling to establish: BUILD: npm run build (pending: no application manifest or build script)
Verification tooling to establish: VERIFY: npm run dev; readiness http://localhost:3000 (pending: no server configuration or dev script)

## Owner checkpoints

- T-004: prototype, household verification and implementation interpretations; blocked by T-001/T-002, blocks T-005. T-003 can implement proposed workflow and adjust after review. Fixed household/priority/FIFO/privacy rules are not reopened.
- T-009: fairness demonstration, coordinator list and own allocation; blocked by T-007/T-008, blocks final acceptance. Reporting can proceed independently.
- T-013: first-version acceptance for requirements 1–4 plus links/digest; blocked by T-012/T-009. No map required. T-014 waits on it.
- Stage-1 limitation: ordinary tickets, not mechanically enforced owner-approval gates; record actual owner review before completion.

## Carried forward

- Start T-001 Mobile journey prototype or T-002 Persistent garden foundation and verification tooling. Both are open and unblocked. No autonomous session was started.
- T-014 remains explicitly post-v1, not part of launch acceptance. Payments/tool lending have no v1 tickets.

## Shipped

- Approved setup ledger and governance only; no product feature marked complete.
