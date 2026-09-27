/**
 * T-424: `storybloq limit-status` -- the listing (read-only since T-534),
 * plus the project-scoped summary helper feeding storybloq_status.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deterministic child-identity control for the cancel path. probeArgvSignature
// and signalWakeChild are partial-mocked so tests can model absent / live-
// killable / identity-unknown children WITHOUT ever sending a real signal to an
// arbitrary pid. h.probe null => delegate to the real implementation.
const h = vi.hoisted(() => ({
  probe: null as null | ((pid: number, markers: readonly string[]) => "match" | "absent" | "unknown"),
  signals: [] as Array<{ pid: number; signal: string }>,
  // Populated by the liveness mock factory so signalWakeChild can gate delivery
  // on the SAME identity source when h.probe is null.
  realProbe: null as null | ((pid: number, markers: readonly string[]) => "match" | "absent" | "unknown"),
}));
vi.mock("../../../src/autonomous/liveness.js", async (orig) => {
  const actual = await orig<typeof import("../../../src/autonomous/liveness.js")>();
  h.realProbe = actual.probeArgvSignature;
  return {
    ...actual,
    probeArgvSignature: (pid: number, markers: readonly string[]) =>
      h.probe ? h.probe(pid, markers) : actual.probeArgvSignature(pid, markers),
  };
});
vi.mock("../../../src/autonomous/wake-claim.js", async (orig) => {
  const actual = await orig<typeof import("../../../src/autonomous/wake-claim.js")>();
  return {
    ...actual,
    // Mirror production signalWakeChild: it delivers ONLY to a POSITIVELY-
    // identified child (hasArgvSignature / probeArgvSignature === "match") and
    // returns false WITHOUT signalling an absent or identity-unknown pid. The
    // mock records a signal only when it would actually be delivered, so tests
    // cannot assert deliveries that the real path never makes.
    signalWakeChild: (pid: number, markers: readonly string[], signal: string) => {
      const identity = h.probe ? h.probe(pid, markers) : h.realProbe?.(pid, markers);
      if (identity !== "match") return false;
      h.signals.push({ pid, signal });
      return true;
    },
  };
});

import { handleLimitStatus } from "../../../src/cli/commands/limit-status.js";
import {
  recordDirectStop,
  limitRecordKey,
  mutateLimitLedger,
  listLimitStops,
  listLimitStopsForProject,
  type LimitStopInput,
} from "../../../src/core/limit-ledger.js";

const TASK_ID = "task-limitstatus-0001";
const KEY = limitRecordKey(TASK_ID);

let root: string;
let globalDir: string;
let savedGlobalDir: string | undefined;

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
}

function baseStop(overrides: Partial<LimitStopInput> = {}): LimitStopInput {
  const now = Date.now();
  return {
    clientTaskId: TASK_ID,
    storybloqSessionId: null,
    projectRoot: root,
    cwd: root,
    sessionType: "plain",
    limitType: "session",
    transcriptPath: null,
    detectedAt: now,
    resetAt: now + 3_600_000,
    resetSource: "absolute",
    rawBanner: null,
    mode: "notify",
    gitHead: null,
    ...overrides,
  };
}

let savedWakerSpawn: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t424-ls-"));
  globalDir = mkdtempSync(join(tmpdir(), "t424-ls-global-"));
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  savedWakerSpawn = process.env.STORYBLOQ_DISABLE_WAKER_SPAWN;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  // --requeue makes the record immediately due; without this guard the
  // handler would launch a REAL detached waker using the Vitest argv. This env
  // guard ALSO models the global kill switch: spawnWakerIfNeeded is a no-op, so
  // these tests prove the cancel path finishes SYNCHRONOUSLY (never stranded in
  // `cancelling` waiting for a waker that can never start).
  process.env.STORYBLOQ_DISABLE_WAKER_SPAWN = "1";
  h.probe = null;
  h.signals = [];
  setupProject(root);
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  if (savedWakerSpawn === undefined) delete process.env.STORYBLOQ_DISABLE_WAKER_SPAWN;
  else process.env.STORYBLOQ_DISABLE_WAKER_SPAWN = savedWakerSpawn;
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(globalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("limit-status list", () => {
  it("reports an empty queue", async () => {
    const result = await handleLimitStatus();
    expect(result.output).toContain("No pending limit auto-resumes");
    expect(result.errorCode).toBeUndefined();
  });

  it("lists non-terminal records with key, status, and schedule", async () => {
    recordDirectStop(baseStop());
    const result = await handleLimitStatus();
    expect(result.output).toContain(KEY);
    expect(result.output).toContain("stopped");
    expect(result.output).toContain("plain session");
  });

  it("emits JSON when asked", async () => {
    recordDirectStop(baseStop());
    const result = await handleLimitStatus({ format: "json" });
    const parsed = JSON.parse(result.output) as { ok: boolean; data: { limitStops: Array<{ key: string }> } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.limitStops[0]?.key).toBe(KEY);
  });

  it("hides terminal records", async () => {
    recordDirectStop(baseStop());
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.status = "notified";
      return true;
    });
    const result = await handleLimitStatus();
    expect(result.output).toContain("No pending limit auto-resumes");
  });

  it("ISS-944 test 8c: --recent surfaces a terminal defer_exhausted record that the default listing hides", async () => {
    recordDirectStop(baseStop());
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "failed";
      rec.reasonCode = "defer_exhausted";
      rec.updatedAt = Date.now();
      return true;
    });

    const withoutFlag = await handleLimitStatus();
    expect(withoutFlag.output).toContain("No pending limit auto-resumes");

    const withFlag = await handleLimitStatus({ recent: true });
    expect(withFlag.output).toContain(KEY);
    expect(withFlag.output).toContain("defer_exhausted");
  });
});

describe("limit-status is read-only (T-534)", () => {
  it("refuses --cancel and --requeue and leaves the ledger byte-identical", async () => {
    recordDirectStop(baseStop());
    const before = readFileSync(join(globalDir, "limit-ledger.json"), "utf-8");
    for (const options of [{ cancel: KEY }, { requeue: KEY }, { cancel: TASK_ID }, { cancel: KEY, requeue: KEY }]) {
      const result = await handleLimitStatus(options);
      expect(result.errorCode).toBe("invalid_input");
    }
    expect(readFileSync(join(globalDir, "limit-ledger.json"), "utf-8")).toBe(before);
    expect(h.signals).toEqual([]);
  });

  it("lists without writing the ledger or offering cancel or requeue", async () => {
    recordDirectStop(baseStop());
    const before = readFileSync(join(globalDir, "limit-ledger.json"), "utf-8");
    const result = await handleLimitStatus({ recent: true });
    expect(result.output).not.toMatch(/--cancel|--requeue/);
    expect(readFileSync(join(globalDir, "limit-ledger.json"), "utf-8")).toBe(before);
  });
});

describe("listLimitStopsForProject", () => {
  it("filters by project root, tolerating symlinked path variance", async () => {
    recordDirectStop(baseStop({ projectRoot: realpathSync(root) }));
    const other = mkdtempSync(join(tmpdir(), "t424-ls-other-"));
    try {
      recordDirectStop(baseStop({ clientTaskId: "task-elsewhere", projectRoot: other }));

      expect(listLimitStops()).toHaveLength(2);
      const forRoot = listLimitStopsForProject(root); // non-realpath'd input
      expect(forRoot).toHaveLength(1);
      expect(forRoot[0]?.key).toBe(KEY);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("matches records stored under a symlinked project root when queried by the real path (and vice versa)", async () => {
    // A real directory plus a symlink pointing at it. The ledger stores one
    // form; the query uses the other. Both must resolve to the same record via
    // realpath canonicalization, not raw string equality.
    const realDir = mkdtempSync(join(tmpdir(), "t424-ls-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "t424-ls-link-"));
    const linkDir = join(linkParent, "alias");
    symlinkSync(realDir, linkDir);
    try {
      // Store under the SYMLINK path; query by the REAL path.
      recordDirectStop(baseStop({ clientTaskId: "task-symlinked", projectRoot: linkDir }));
      const bySymlinkKey = limitRecordKey("task-symlinked");

      const byReal = listLimitStopsForProject(realDir);
      expect(byReal.map((r) => r.key)).toContain(bySymlinkKey);

      // And the reverse: query by the symlink path finds it too.
      const byLink = listLimitStopsForProject(linkDir);
      expect(byLink.map((r) => r.key)).toContain(bySymlinkKey);
    } finally {
      // Remove the link's own parent directly; join(linkDir, "..") would
      // traverse THROUGH the symlink to realDir's parent (and fail to resolve
      // once the target is gone), leaking linkParent.
      await rm(realDir, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });
});
