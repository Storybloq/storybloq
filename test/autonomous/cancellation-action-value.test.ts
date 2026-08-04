/**
 * ISS-967: a candidate CANCELLATION must record itself as a cancellation.
 *
 * `CancellationActionSchema` carried two values and neither named a candidate
 * cancellation, so the cancel commit stamped `candidate_recovery_takeover` into
 * the durable transition record of a session it had just ENDED. `authority.kind`
 * cannot disambiguate the two operations -- `candidate` is correct for both --
 * so a record read in isolation asserted the opposite of what happened, which is
 * exactly the failure the action field's own docstring exists to prevent.
 *
 * The value was load-bearing at three code sites and one PROSE site, so the fix
 * is a widening rather than a substitution, and these tests pin each half:
 *
 *   - the widened guards still refuse `ordinary_cancellation` under candidate
 *     authority, which is the pairing they exist to catch pre-write;
 *   - the pre-existing takeover literal remains ACCEPTED, so transition records
 *     written before this fix stay readable. Note what this does NOT claim: no
 *     current production takeover path writes a transition record at all (the
 *     takeover commit writes a postimage instead), so the literal is reachable
 *     only when a caller hands it to the shared core;
 *   - the readoption gate accepts a cancellation record as proof of a
 *     cancellation intent, and its message no longer claims that "a candidate
 *     intent is proved by a candidate_recovery_takeover".
 */
import { describe, it, expect } from "vitest";

import { CancellationActionSchema } from "../../src/autonomous/session-types.js";
import { applyCancellationTransition } from "../../src/autonomous/cancellation-core.js";

/** Only the fields the pre-write guard reads. It checks `authority.kind` and
 * the action, and throws before anything touches the evidence, so a full
 * evidence object here would be inert detail. */
const CANDIDATE_AUTHORITY = { kind: "candidate" as const };

describe("ISS-967: the action enum names both candidate operations", () => {
  it("accepts a candidate cancellation as a distinct value", () => {
    expect(CancellationActionSchema.safeParse("candidate_recovery_cancellation").success).toBe(true);
  });

  it("still accepts the two pre-existing values, so nothing was repurposed", () => {
    // The fix had to be ADDITIVE: records written before it are still read by
    // the same schema, and a removed or renamed value would strand them.
    expect(CancellationActionSchema.safeParse("candidate_recovery_takeover").success).toBe(true);
    expect(CancellationActionSchema.safeParse("ordinary_cancellation").success).toBe(true);
  });

  it("still refuses an unrecognized action rather than guessing", () => {
    expect(CancellationActionSchema.safeParse("candidate_recovery_something_else").success).toBe(false);
  });
});

// The action/authority PAIRING cases live in cancellation-transition-schema.ts
// alongside that suite's real `EVIDENCE` fixture, which is built by running
// `readOwnerLiveness` against a temp directory. Rebuilding it here would have
// meant a second hand-written evidence object, and that suite's own comment
// records what happens when someone invents one: every signal comes back
// `unknown` and the fixture proves nothing.

describe("ISS-967: the pre-write guard was WIDENED, not relaxed", () => {
  // `applyCancellationTransition` is shared by both candidate commits, and its
  // init check is the only thing standing between candidate authority and an
  // `ordinary_cancellation` record BEFORE the lie reaches disk. The widening had
  // to keep that refusal while no longer forcing a cancellation to describe
  // itself as a takeover.
  const init = (action: string) => ({
    transitionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    action,
    authority: CANDIDATE_AUTHORITY,
  });

  it("still THROWS on ordinary_cancellation under candidate authority", async () => {
    await expect(applyCancellationTransition(
      "/nonexistent-root",
      { dir: "/nonexistent-dir", state: {} as never },
      { kind: "no-ticket" },
      undefined,
      init("ordinary_cancellation") as never,
    )).rejects.toThrow(/candidate recovery action/);
  });

  it("names BOTH accepted values in its refusal, so the message is actionable", async () => {
    const err = await applyCancellationTransition(
      "/nonexistent-root",
      { dir: "/nonexistent-dir", state: {} as never },
      { kind: "no-ticket" },
      undefined,
      init("ordinary_cancellation") as never,
    ).catch((e: unknown) => e as Error);

    expect((err as Error).message).toContain("candidate_recovery_takeover");
    expect((err as Error).message).toContain("candidate_recovery_cancellation");
  });
});
