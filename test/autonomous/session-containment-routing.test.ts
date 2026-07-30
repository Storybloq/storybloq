/**
 * The two `false` answers of the containment probe route differently, and the
 * integration test that claimed to cover it could not (ISS-897).
 *
 * `probeContainment` answers three ways. A PROVEN escape is dropped in silence
 * -- the guard worked, nothing was concealed. A probe that COULD NOT LOOK
 * establishes nothing, so dropping it would remove a directory that may hold a
 * live session from a listing this command presents as the whole inventory; it
 * becomes an `unavailable` row instead.
 *
 * The existing fixture for this is a symlink loop, and a symlink is reported by
 * `readdirSync(..., { withFileTypes: true })` as a link rather than a
 * directory. `listAllSessionsDetailed` therefore files it under the
 * non-directory branch BEFORE containment is ever consulted, so the assertion
 * about the listing would hold with the containment routing reverted. It pins
 * the probe, not the routing.
 *
 * There is no filesystem shape that produces `probe-failed` for a REAL
 * directory reliably and portably -- that answer comes from EACCES, EIO or a
 * mid-scan replacement, none of which a test can arrange without racing the
 * code under test. So the probe is stubbed and the ROUTING is what is asserted,
 * which is the part that was unpinned.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = vi.hoisted(() => ({
  answer: vi.fn((_root: string, _dir: string): string => "contained"),
}));

vi.mock("../../src/autonomous/session-selector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session-selector.js")>();
  return {
    ...actual,
    probeContainment: (root: string, dir: string) => probe.answer(root, dir),
    isContainedSessionDir: (root: string, dir: string) => probe.answer(root, dir) === "contained",
  };
});

const { listAllSessionsDetailed, createSession } = await import("../../src/autonomous/session.js");

const roots: string[] = [];
afterEach(() => {
  probe.answer.mockReset();
  probe.answer.mockImplementation(() => "contained");
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-containment-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

describe("listAllSessionsDetailed routes the containment probe's three answers (ISS-897)", () => {
  it("reports a directory whose containment could NOT be established", () => {
    const root = makeRoot();
    const id = createSession(root, "default", "ws-1").sessionId;
    // A real, readable session directory. Only the PROBE fails.
    probe.answer.mockImplementation((_r: string, dir: string) =>
      dir.endsWith(id) ? "probe-failed" : "contained",
    );

    const result = listAllSessionsDetailed(root);

    // Not silently dropped: silence here is a live session missing from the
    // inventory, which is the concealment this issue closes.
    expect(result.sessions).toHaveLength(0);
    expect(result.unavailable.map((u) => u.sourceDir)).toEqual([id]);
    // `unreadable-file`, not `missing-state`: nothing opened anything, and
    // `missing-state` asserts an entry IS there with its state file gone.
    expect(result.unavailable[0]!.failure).toEqual({ kind: "unreadable", reason: "unreadable-file" });
    // ...and it is not filed under a name that invites repair or deletion.
    expect(result.damaged).toHaveLength(0);
  });

  it("drops a directory PROVEN to escape, in silence", () => {
    const root = makeRoot();
    const id = createSession(root, "default", "ws-1").sessionId;
    probe.answer.mockImplementation((_r: string, dir: string) =>
      dir.endsWith(id) ? "escaped" : "contained",
    );

    const result = listAllSessionsDetailed(root);

    // The opposite disposition, and it is correct: the guard did its job and
    // nothing was concealed, so an `unavailable` row here would report a fault
    // where there is none.
    expect(result.sessions).toHaveLength(0);
    expect(result.unavailable).toHaveLength(0);
    expect(result.damaged).toHaveLength(0);
    expect(result.incompatible).toHaveLength(0);
  });

  it("lists a contained directory normally, so the stub is not what empties the result", () => {
    const root = makeRoot();
    const id = createSession(root, "default", "ws-1").sessionId;

    const result = listAllSessionsDetailed(root);

    expect(result.sessions.map((s) => s.state.sessionId)).toEqual([id]);
    expect(result.unavailable).toHaveLength(0);
  });

  it("still reaches containment for a directory with no readable state.json", () => {
    // Ordering check. The non-directory branch runs first and a plain directory
    // is not it, so a `probe-failed` here must still produce the unavailable
    // row rather than the `missing-state` one.
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "half-made"), { recursive: true });
    writeFileSync(join(root, ".story", "sessions", "half-made", "note.txt"), "x");
    probe.answer.mockImplementation((_r: string, dir: string) =>
      dir.endsWith("half-made") ? "probe-failed" : "contained",
    );

    const result = listAllSessionsDetailed(root);

    expect(result.unavailable.map((u) => u.sourceDir)).toEqual(["half-made"]);
    expect(result.unavailable[0]!.failure).toEqual({ kind: "unreadable", reason: "unreadable-file" });
  });
});
