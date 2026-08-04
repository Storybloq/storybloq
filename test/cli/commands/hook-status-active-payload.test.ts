/**
 * T-450 step 7b.2 fixup (G1): `activePayload` is the FOURTH consumer of the
 * owner-heartbeat migration, and it was the one with no test that could have
 * failed.
 *
 * The migration made two claims here. Neither was pinned:
 *
 *  1. An UNUSABLE heartbeat surfaces as an explicit `null`, not as `false`.
 *     `false` asserts that nobody is there; a read fault is a refusal to claim
 *     anything, and the payload field already carries null for exactly that.
 *  2. The generation comes from the session snapshot this payload is being
 *     BUILT FROM, not from a second read of `state.json`. A takeover landing
 *     between the lookup and the build would otherwise leave the heartbeat
 *     describing one owner while the rest of the payload describes another.
 *
 * A revert of either compiled cleanly before this file existed, because
 * `readAliveTimestamp` is still exported and `collectProbes`'s state parameter
 * is optional. The three tests below are written to FAIL on that revert, and
 * the third is the converse of the second so that an implementation which
 * simply always answers `null` cannot satisfy the pair.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activePayload } from "../../../src/cli/commands/hook-status.js";
import { telemetryDirPath } from "../../../src/autonomous/liveness.js";

let root: string;
let sessionId: string;
let sessDir: string;

/** Not a Crockford-16 id, so `resolveTelemetryLocation` refuses it outright. */
const MALFORMED_GENERATION = "not-a-valid-generation-id";

function makeSession(opts: {
  /** What `state.json` on disk says. */
  onDisk: string | undefined;
  /** What the SNAPSHOT handed to the builder says. */
  snapshot: string | undefined;
}): Parameters<typeof activePayload>[0] {
  sessionId = "11111111-2222-4333-8444-555555555555";
  sessDir = join(root, ".story", "sessions", sessionId);
  mkdirSync(sessDir, { recursive: true });

  const base: Record<string, unknown> = {
    sessionId,
    state: "IMPLEMENT",
    status: "active",
    revision: 3,
    startedAt: "2026-08-03T00:00:00.000Z",
    lastGuideCall: "2026-08-03T00:00:00.000Z",
  };

  writeFileSync(
    join(sessDir, "state.json"),
    JSON.stringify(opts.onDisk === undefined ? base : { ...base, heartbeatGeneration: opts.onDisk }),
  );

  // A LEGACY heartbeat that is unambiguously alive. It is the discriminator:
  // any code path that resolves to the legacy directory reads this and answers
  // `true`, so a `null` or a differing answer proves the legacy directory was
  // NOT consulted.
  const tDir = telemetryDirPath(sessDir);
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(tDir, "alive"), String(Date.now()));

  return (opts.snapshot === undefined ? base : { ...base, heartbeatGeneration: opts.snapshot }) as
    Parameters<typeof activePayload>[0];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t450-g1-"));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("T-450 G1: hook-status activePayload pins the heartbeat migration", () => {
  it("surfaces an UNUSABLE generation as alive: null, not false", async () => {
    // A malformed generation is a refusal, not an absence: the resolver will
    // not fall back to the legacy directory, because that directory belongs to
    // whatever owner was there before.
    const session = makeSession({ onDisk: MALFORMED_GENERATION, snapshot: MALFORMED_GENERATION });
    const payload = activePayload(session, root);

    expect(payload.alive).toBeNull();
    // Pinned explicitly: `false` would be a claim that nobody is there, and the
    // pre-migration shape produced exactly that.
    expect(payload.alive).not.toBe(false);
  });

  it("reads the generation from the PASSED SNAPSHOT, not from a re-read of state.json", async () => {
    // state.json carries no generation, so a re-read resolves LEGACY and finds
    // the live `alive` file written above, answering `true`. The snapshot says
    // the session is generation-bound to an unusable id, which answers `null`.
    // The two disagree by construction, so the result names which one was used.
    const session = makeSession({ onDisk: undefined, snapshot: MALFORMED_GENERATION });
    const payload = activePayload(session, root);

    expect(payload.alive).toBeNull();
  });

  it("does not consult state.json even when state.json is the unusable one", async () => {
    // The converse, so the pair cannot both be satisfied by an implementation
    // that simply always answers null. Here the SNAPSHOT has no generation
    // (legacy, alive) while state.json carries the malformed id (unusable). An
    // implementation that re-read state.json would answer null; the shipped one
    // answers true, from the snapshot.
    const session = makeSession({ onDisk: MALFORMED_GENERATION, snapshot: undefined });
    const payload = activePayload(session, root);

    expect(payload.alive).toBe(true);
  });
});
