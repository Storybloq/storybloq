/**
 * T-450 step 6a commit B2a: the temp-file ownership rules, forced.
 *
 * These properties are invisible while `randomUUID` really is random: nothing
 * ever collides, so the exclusive create never fails and the ownership
 * bookkeeping never has to be right. Pinning the uuid makes the collision
 * reachable, which is the only way these guards can be tested rather than
 * merely asserted.
 *
 * Mocking is legitimate HERE, and it is worth saying why, because the same move
 * is invalid three files over: `randomUUID` lives in `node:crypto`, a DIFFERENT
 * module from its caller, so replacing the module's export really does replace
 * what the caller resolves. When a caller and callee share a module the call
 * binds lexically and no module-path interception can see it (L-041).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const control = vi.hoisted(() => ({ uuid: null as string | null, failEntropy: false }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => {
      if (control.failEntropy) throw new Error("simulated entropy source failure");
      return control.uuid ?? actual.randomUUID();
    },
  };
});

import { writeCompletionMarker, classifyCompletionMarker } from "../../src/autonomous/cancellation-transition.js";

const TID = "11111111-2222-4333-8444-555555555555";
const ISO = "2026-08-01T12:00:00.000Z";
const PINNED = "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb";

describe("T-450: a temp path another writer already holds is never touched", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-collide-"));
    control.uuid = null;
    control.failEntropy = false;
  });
  afterEach(() => {
    control.uuid = null;
    control.failEntropy = false;
    rmSync(dir, { recursive: true, force: true });
  });

  function occupiedTempPath(): string {
    // Exactly the path this writer will derive once the uuid is pinned, which
    // is what a writer in another PID namespace would be holding.
    return join(dir, "telemetry", `cancellation-complete.json.${process.pid}.${PINNED}.tmp`);
  }

  it("refuses rather than clobbering, and leaves the other writer's file intact", () => {
    // Two failures are being ruled out at once. Creating non-exclusively would
    // TRUNCATE the other writer's in-flight payload and then rename it into
    // place, so this writer would publish someone else's data and report
    // success. Claiming ownership of the temp path before the exclusive create
    // has actually succeeded would send the catch-path cleanup after a file
    // this attempt never created, so the collision defence would delete the
    // very file it exists to protect.
    control.uuid = PINNED;
    mkdirSync(join(dir, "telemetry"), { recursive: true });
    writeFileSync(occupiedTempPath(), "the other writer's in-flight payload");

    expect(writeCompletionMarker(dir, TID, ISO)).toBe(false);

    expect(readFileSync(occupiedTempPath(), "utf-8")).toBe("the other writer's in-flight payload");
    // And nothing was published from it.
    expect(classifyCompletionMarker(dir, TID).kind).toBe("absent");
  });

  it("still succeeds, and cleans up, once the other writer's temp is gone", () => {
    // The refusal above must be a genuine collision response, not this writer
    // being broken whenever the uuid happens to be pinned.
    control.uuid = PINNED;
    expect(writeCompletionMarker(dir, TID, ISO)).toBe(true);
    expect(classifyCompletionMarker(dir, TID).kind).toBe("matching");
    expect(readdirSync(join(dir, "telemetry"))).toEqual(["cancellation-complete.json"]);
  });

  it("reports failure rather than throwing when the entropy source fails", () => {
    // The temp name is generated INSIDE the guarded region precisely so this
    // cannot escape. A throw here would abort the cancellation tail, when the
    // contract is that a failed artifact write merely leaves recovery open.
    control.failEntropy = true;
    expect(() => writeCompletionMarker(dir, TID, ISO)).not.toThrow();
    expect(writeCompletionMarker(dir, TID, ISO)).toBe(false);
  });
});
