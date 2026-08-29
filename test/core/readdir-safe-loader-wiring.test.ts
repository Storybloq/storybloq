import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as nodeFs from "node:fs";

/**
 * Proves each of the three loaders is actually WIRED to `verifyContainment`
 * (T-478 / ISS-1053, codex round-3 R3), not just that the shared helper's own
 * unit behavior is correct (covered by `readdir-safe.test.ts`).
 *
 * A plain symlink DIRENT is unreachable via this path: `entry.isFile()`
 * already rejects it at the listing level in all three loaders, before
 * `verifyContainment` ever runs (see each loader's own pre-existing
 * "not a regular file" test). The gap `verifyContainment` actually closes is
 * an ANCESTOR path component swapped to a symlink between the listing and
 * the read, for an entry that WAS a genuine regular file at listing time --
 * not portably reproducible with real symlinks in a deterministic test, so
 * this file mocks `realpathSync` to make ONE specific resolution escape
 * `dir`, simulating exactly that race for a dirent that is, and remains, a
 * real regular file throughout.
 */
var realpathSyncOverride: typeof nodeFs.realpathSync | undefined;
var realRealpathSync: typeof nodeFs.realpathSync;
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  realRealpathSync = actual.realpathSync;
  return {
    ...actual,
    realpathSync: (...args: unknown[]) =>
      realpathSyncOverride ? (realpathSyncOverride as (...a: unknown[]) => unknown)(...args) : (actual.realpathSync as (...a: unknown[]) => unknown)(...args),
  };
});

const { loadArrangementsSafe, writeArrangementUnlocked } = await import("../../src/core/arrangement-loader.js");
const { loadRulingsSafe, writeRulingUnlocked } = await import("../../src/core/ruling-loader.js");
const { readGateAcksForListing, writeGateAckUnlocked } = await import("../../src/core/gate-ack-loader.js");
const { computeGateAckId } = await import("../../src/models/gate-ack.js");

function mockEscapeFor(targetBasename: string, outsidePath: string) {
  realpathSyncOverride = ((p: nodeFs.PathLike, opts?: unknown) => {
    const s = p.toString();
    if (s.endsWith(targetBasename)) return outsidePath;
    return realRealpathSync(p, opts as never);
  }) as typeof nodeFs.realpathSync;
}

describe("verifyContainment wiring per loader", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "readdir-safe-wiring-"));
  });

  afterEach(async () => {
    realpathSyncOverride = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it("arrangement-loader.ts: a regular-file entry whose realpath resolution escapes .story/arrangements/ is warned and excluded, not silently trusted", async () => {
    const arrangement = {
      id: "a-0123456789abcdef",
      lifecycle: "active",
      bounds: ["T-473"],
      parties: [
        { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
        { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
      ],
      gates: [],
      unreachability: { onIrreversibleWork: "hold" },
      createdDate: "2026-08-27",
    };
    await writeArrangementUnlocked(arrangement as never, root, { createOnly: true });
    mockEscapeFor("a-0123456789abcdef.json", join(root, "outside-escaped.json"));
    const result = loadArrangementsSafe(root);
    expect(result.arrangements).toEqual([]);
    expect(result.warnings.some((w) => w.includes("resolved outside"))).toBe(true);
  });

  it("ruling-loader.ts: a regular-file entry whose realpath resolution escapes .story/rulings/ is warned and excluded, not silently trusted", async () => {
    const ruling = {
      id: "r-0123456789abcdef",
      text: "test",
      attribution: "owner-direct",
      recordedBy: { client: "claude", id: "claude-session-abc" },
      date: "2026-08-27",
      scopeTags: [],
      supersedes: null,
    };
    await writeRulingUnlocked(ruling as never, root, { createOnly: true });
    mockEscapeFor("r-0123456789abcdef.json", join(root, "outside-escaped.json"));
    const result = loadRulingsSafe(root);
    expect(result.rulings).toEqual([]);
    expect(result.warnings.some((w) => w.includes("resolved outside"))).toBe(true);
  });

  it("gate-ack-loader.ts: a regular-file entry whose realpath resolution escapes .story/arrangement-acks/ is warned and excluded -- proves the containment check runs independently of readBoundedRegularFile's OWN stricter leaf-symlink refusal", async () => {
    const pin = { kind: "plan-hash" as const, sha256: "a".repeat(64) };
    const ack = {
      id: computeGateAckId("a-0123456789abcdef", "plan-ack", "t-0123456789abcdef", pin),
      arrangementId: "a-0123456789abcdef",
      gateName: "plan-ack",
      ackRole: "pen" as const,
      ticketRef: "t-0123456789abcdef",
      pin,
      decidedAt: "2026-08-28T00:00:00.000Z",
      reviewTrail: { present: false as const },
      contested: false,
    };
    await writeGateAckUnlocked(ack, root);
    mockEscapeFor(`${ack.id}.json`, join(root, "outside-escaped.json"));
    const result = readGateAcksForListing(root);
    expect(result.acks).toEqual([]);
    expect(result.warnings.some((w) => w.includes("resolved outside"))).toBe(true);
  });
});
