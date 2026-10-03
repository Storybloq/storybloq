/**
 * Fixture note: the ticket set is 8, not 6, and a fixed literal reason why.
 *
 * storybloq_recommend does NOT recommend every unblocked ticket -- reading
 * recommend.ts's generator functions directly shows a ticket only becomes a
 * candidate by matching a SPECIFIC category (inprogress, high-impact-unblock,
 * quick-win, phase-momentum, near-complete-umbrella). T-1007/T-1008 exist
 * ONLY to give T-1003 a genuine unblockCount of 2 (high_impact_unblock's own
 * threshold) -- neither is ever itself a candidate (both are blockedBy
 * T-1003). This yields exactly 7 real recommend candidates, verified by
 * direct MCP call against this fixture, not assumed: ISS-2001 (critical),
 * T-1001 (inprogress), T-1003 (high-impact-unblock), T-1006 (phase-momentum),
 * T-1002 (quick-win), ISS-2002 (open, medium), ISS-2003 (open, low). The
 * Ready-to-Work table's "(+2 more)" suffix (7 candidates, top 5 shown) is the
 * corpus property the fixture is sized to exercise.
 *
 * m4 (normalize-before-byte-count) disposition, per the pen's explicit
 * 3-step check: session_guard/status's per-session `sourceDir` is confirmed
 * (by reading session-scan.ts) to be a bare directory NAME, never an
 * absolute path -- no leak there for a clean, guard-free (zero-session)
 * fixture. A `SessionScanDiagnostic`'s `sourcePath` field DOES embed the
 * absolute root (confirmed empirically: a UUID-shaped file, not a directory,
 * under `.story/sessions/` produces one) -- but triggering that diagnostic
 * flips `overallAction` from "free" to "unverifiable", which contradicts the
 * ticket's own "guard-free" framing this whole fixture is built around, so
 * it is not usable here without redesigning the fixture's foundational
 * guard-free property. No other measured step's real response (status is
 * aggregate-only; recap/handover_latest/lesson_digest/recommend carry no
 * paths; ticket/issue `location` fields are relative; `gitUserEmail` returns
 * null rather than surfacing cwd on failure) embeds the root either. m4 is
 * therefore INERT on this corpus: normalization is kept (live mode still
 * needs it against a real, arbitrary project root), but there is no honest
 * end-to-end mutant to prove against this fixture. The unit-level
 * `buildNormalizer` tests below remain the correctness proof for the
 * normalization logic itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  byteLength,
  buildNormalizer,
  FIXTURE_ROOT_PLACEHOLDER,
  deriveRecommendPayload,
  findContinuationSection,
  extractEntityIds,
  deriveEntityActionability,
  reconcileFingerprints,
  isOrchestratorConfig,
  buildFailedRecommendReport,
  buildCrashReport,
  stepReconciliation,
  runReplaySequence,
  stepRecommend,
  stepLineOne,
  stepReconciliationRecovery,
  stepHandoverPrimingAndBrief,
  stepTrajectory,
  renderTrajectoryMd,
  recoverHandoverEvidence,
  needsEvidenceRecovery,
  STEP_NAMES,
  type PrimingCostReport,
  type CapturedMessage,
  type ExchangeMeasurement,
  type ReplayContext,
  type RecommendRow,
  type ExcludedRow,
  type HandoverBriefEntryLike,
} from "../../scripts/priming-cost.js";
import type { ContinuationCandidate, TrajectoryEntry } from "../../src/core/markdown-sections.js";
import { reduceSessionForCompact } from "../../src/core/output-formatter.js";
import type { ActiveSessionSummary } from "../../src/core/session-scan.js";

const execFileAsync = promisify(execFileCb);

const FIXTURE_SRC = resolve(__dirname, "fixtures/priming-cost");
const SCRIPT_PATH = resolve(__dirname, "../../scripts/priming-cost.ts");
const TSX_CLI = resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs");
const STORYBLOQ_ROOT = resolve(__dirname, "../..");

// --- child-process isolation -------------------------------------------------
//
// True process isolation, not just an in-process Date monkeypatch: real
// determinism requires isolating ambient host state (git config, environment
// identity vars), not just the clock. HOME/USERPROFILE point at a fresh empty
// dir, git config files are pointed at /dev/null, TZ is fixed, and client
// identity vars are explicitly unset (not merely inherited).

async function makeIsolatedEnv(): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const homeDir = await mkdtemp(join(tmpdir(), "priming-cost-home-"));
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    USERPROFILE: homeDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    TZ: "UTC",
    PATH: "/usr/bin:/bin:/usr/local/bin",
  };
  return { env, cleanup: () => rm(homeDir, { recursive: true, force: true }) };
}

async function runEmitJson(fixtureRoot: string): Promise<{ report: PrimingCostReport; stdout: string }> {
  const { env, cleanup } = await makeIsolatedEnv();
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [TSX_CLI, SCRIPT_PATH, "--emit-json", fixtureRoot],
      { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
    );
    return { report: JSON.parse(stdout), stdout };
  } finally {
    await cleanup();
  }
}

async function copyFixture(intoDir?: string): Promise<string> {
  const dir = intoDir ?? (await mkdtemp(join(tmpdir(), "priming-cost-fx-")));
  await cp(FIXTURE_SRC, dir, { recursive: true });
  return dir;
}

// --- byteLength --------------------------------------------------------------

describe("byteLength", () => {
  it("matches Buffer.byteLength for ASCII", () => {
    expect(byteLength("hello")).toBe(5);
  });

  it("m3: reports UTF-8 byte length, not UTF-16 .length, for multibyte text", () => {
    const s = "café🎉"; // é: 1 UTF-16 unit / 2 bytes; 🎉: 2 UTF-16 units / 4 bytes
    expect(s.length).toBe(6);
    expect(byteLength(s)).toBe(9);
    expect(byteLength(s)).not.toBe(s.length);
  });
});

// --- normalization (unit-level m4) --------------------------------------------

describe("buildNormalizer", () => {
  it("replaces the exact root path wherever it appears in a string", () => {
    const root = "/tmp/some-fixture-root-abc123";
    const normalize = buildNormalizer(root);
    const input = { a: `${root}/.story/tickets/T-001.json`, b: "unrelated", c: 42 };
    expect(normalize(input)).toEqual({
      a: `${FIXTURE_ROOT_PLACEHOLDER}/.story/tickets/T-001.json`,
      b: "unrelated",
      c: 42,
    });
  });

  it("m4: produces byte-identical serialized output regardless of root path length", () => {
    const shortRoot = "/tmp/a";
    const longRoot = "/tmp/a-much-longer-directory-name-that-changes-the-string-length-considerably";
    const shortNorm = buildNormalizer(shortRoot);
    const longNorm = buildNormalizer(longRoot);

    const shortValue = { path: `${shortRoot}/.story/status.json`, note: "same content" };
    const longValue = { path: `${longRoot}/.story/status.json`, note: "same content" };

    const shortBytes = Buffer.byteLength(JSON.stringify(shortNorm(shortValue)), "utf8");
    const longBytes = Buffer.byteLength(JSON.stringify(longNorm(longValue)), "utf8");
    expect(shortBytes).toBe(longBytes);
    expect(JSON.stringify(shortNorm(shortValue))).toBe(JSON.stringify(longNorm(longValue)));
  });
});

// --- recommend JSON parsing ----------------------------------------------------

describe("deriveRecommendPayload", () => {
  function envelope(data: unknown): string {
    return JSON.stringify({ version: 1, data });
  }

  it("parses recommendations/excluded/unreadableHandoverCount from a well-formed envelope", () => {
    const text = envelope({
      recommendations: [
        { id: "T-1001", kind: "ticket", title: "Wire the ingest retry queue", reason: "quick win, unblocked" },
      ],
      excluded: [
        {
          id: "ISS-2003",
          kind: "issue",
          title: "Snapshot pruning may keep stale entries",
          actionability: { status: "owner_gated", reason: "structured disposition: owner_gated", source: "structured" },
        },
      ],
      unreadableHandoverCount: 0,
    });
    const result = deriveRecommendPayload(text);
    expect(result.parseFailed).toBe(false);
    expect(result.rows).toEqual([
      { id: "T-1001", kind: "ticket", title: "Wire the ingest retry queue", reason: "quick win, unblocked" },
    ]);
    expect(result.excluded).toHaveLength(1);
    expect(result.unreadableHandoverCount).toBe(0);
  });

  it("accepts a genuinely empty recommendations/excluded pair as a valid, non-failed result", () => {
    const result = deriveRecommendPayload(envelope({ recommendations: [], excluded: [], unreadableHandoverCount: 0 }));
    expect(result.parseFailed).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.excluded).toEqual([]);
  });

  it("rejects text that is not valid JSON at all", () => {
    const result = deriveRecommendPayload("# Recommendations\n\nnot json");
    expect(result.parseFailed).toBe(true);
    expect(result.reason).toMatch(/not valid JSON/);
  });

  it("rejects a JSON payload missing the recommendations/excluded arrays", () => {
    const result = deriveRecommendPayload(envelope({ somethingElse: true }));
    expect(result.parseFailed).toBe(true);
    expect(result.reason).toMatch(/missing its recommendations\/excluded arrays/);
  });

  it("treats a null unreadableHandoverCount as null, and a missing/non-numeric one as null", () => {
    const withNull = deriveRecommendPayload(envelope({ recommendations: [], excluded: [], unreadableHandoverCount: null }));
    expect(withNull.unreadableHandoverCount).toBeNull();
    const missing = deriveRecommendPayload(envelope({ recommendations: [], excluded: [] }));
    expect(missing.unreadableHandoverCount).toBeNull();
  });
});

// --- continuation section parsing ---------------------------------------------

describe("findContinuationSection", () => {
  it("extracts from an actionable heading to the next heading of equal-or-higher level", () => {
    const body = [
      "# Session Handover",
      "",
      "## Earlier",
      "irrelevant",
      "",
      "## Next steps",
      "- Continue T-1002: do the thing",
      "",
      "## Notes",
      "not part of the section",
    ].join("\n");
    const section = findContinuationSection(body);
    expect(section).not.toBeNull();
    expect(section!.heading).toBe("## Next steps");
    expect(section!.content).toContain("T-1002");
    expect(section!.content).not.toContain("not part of the section");
  });

  it("returns null when no heading matches next/open/remaining/todo/blocked", () => {
    const body = ["# Handover", "", "## Summary", "nothing actionable here"].join("\n");
    expect(findContinuationSection(body)).toBeNull();
  });
});

describe("extractEntityIds", () => {
  it("returns ticket/issue ids in first-appearance order, deduplicated", () => {
    expect(extractEntityIds("see T-1002 and ISS-2001, also T-1002 again")).toEqual([
      "T-1002",
      "ISS-2001",
    ]);
  });
});

// --- entity actionability parsing (continuation fallback) ---------------------

describe("deriveEntityActionability", () => {
  function envelope(data: unknown): string {
    return JSON.stringify({ version: 1, data });
  }

  it("reads actionability.status and unreadableHandoverCount from a well-formed envelope", () => {
    const result = deriveEntityActionability(
      envelope({ actionability: { status: "actionable", reason: "open, no blocking signal", source: "ledger" }, unreadableHandoverCount: 0 }),
    );
    expect(result.parseFailed).toBe(false);
    expect(result.status).toBe("actionable");
    expect(result.unreadableHandoverCount).toBe(0);
  });

  it("reads a non-actionable status (e.g. blocked, owner_gated) the same way", () => {
    const result = deriveEntityActionability(
      envelope({ actionability: { status: "owner_gated", reason: "structured disposition: owner_gated", source: "structured" }, unreadableHandoverCount: 0 }),
    );
    expect(result.status).toBe("owner_gated");
  });

  it("rejects text that is not valid JSON at all", () => {
    const result = deriveEntityActionability("# T-1005: not json");
    expect(result.parseFailed).toBe(true);
    expect(result.reason).toMatch(/not valid JSON/);
  });

  it("rejects a JSON payload missing actionability.status", () => {
    const result = deriveEntityActionability(envelope({ id: "T-1005" }));
    expect(result.parseFailed).toBe(true);
    expect(result.reason).toMatch(/missing actionability\.status/);
  });

  it("treats a null unreadableHandoverCount as null, and a missing/non-numeric one as null", () => {
    const withNull = deriveEntityActionability(
      envelope({ actionability: { status: "actionable", reason: "r", source: "ledger" }, unreadableHandoverCount: null }),
    );
    expect(withNull.unreadableHandoverCount).toBeNull();
    const missing = deriveEntityActionability(envelope({ actionability: { status: "actionable", reason: "r", source: "ledger" } }));
    expect(missing.unreadableHandoverCount).toBeNull();
  });
});

// --- reconciliation fingerprint comparison (unit level; fixture stays guard-free) ---

describe("reconcileFingerprints", () => {
  const base = {
    sessionId: "s1",
    sourceDir: "dirA",
    population: "activeSessions",
    state: "active",
    compactPending: false,
    leaseState: "held",
    ownerTask: { client: "claude", id: "task-1" },
  };

  it("matches when guard and status carry identical fingerprints", () => {
    const result = reconcileFingerprints([base], [{ ...base }]);
    expect(result.matched).toBe(true);
    expect(result.mismatchedIds).toEqual([]);
  });

  const fieldMutations: Array<[string, unknown]> = [
    ["sourceDir", "dirB"],
    ["population", 4],
    ["state", "stale"],
    ["compactPending", true],
    ["leaseState", "expired"],
  ];

  for (const [field, mutated] of fieldMutations) {
    it(`reports a mismatch when only ${field} differs`, () => {
      const mutatedSession = { ...base, [field]: mutated };
      const result = reconcileFingerprints([base], [mutatedSession]);
      expect(result.matched).toBe(false);
      expect(result.mismatchedFields["s1"]).toEqual([field]);
    });
  }

  it("reports a mismatch when ownerTask client or id differs", () => {
    const result = reconcileFingerprints([base], [{ ...base, ownerTask: { client: "codex", id: "task-1" } }]);
    expect(result.matched).toBe(false);
    expect(result.mismatchedFields["s1"]).toEqual(["ownerTaskClient"]);
  });

  it("reports a mismatch when a session is present on only one side", () => {
    const result = reconcileFingerprints([base], []);
    expect(result.matched).toBe(false);
    expect(result.mismatchedFields["s1"]).toEqual(["presence"]);
  });

  it("dedupe survivor order: first occurrence on each side wins independently (when population is unset)", () => {
    const { population: _pop, ...basePop } = base as any;
    const guard = [
      { ...basePop, sourceDir: "first" },
      { ...basePop, sourceDir: "second" },
    ];
    const status = [{ ...basePop, sourceDir: "first" }];
    const result = reconcileFingerprints(guard, status);
    expect(result.matched).toBe(true);
  });

  it("SKILL.md:133 ordering: an activeSessions duplicate survives over a resumableSessions duplicate, regardless of input array order", () => {
    // The resumable copy appears FIRST in the raw input array; the dedup
    // rule must still prefer the active-population copy.
    const guard = [
      { ...base, population: "resumableSessions", sourceDir: "resumable-copy" },
      { ...base, population: "activeSessions", sourceDir: "active-copy" },
    ];
    const status = [{ ...base, population: "activeSessions", sourceDir: "active-copy" }];
    const result = reconcileFingerprints(guard, status);
    expect(result.matched).toBe(true);
  });

  it("SKILL.md:133 ordering: within the same population, the lexically-first sourceDir survives, regardless of input array order", () => {
    const guard = [
      { ...base, population: "activeSessions", sourceDir: "z-dir" },
      { ...base, population: "activeSessions", sourceDir: "a-dir" },
    ];
    const status = [{ ...base, population: "activeSessions", sourceDir: "a-dir" }];
    const result = reconcileFingerprints(guard, status);
    expect(result.matched).toBe(true);
  });

  it("SKILL.md:133 ordering: a mismatch is correctly detected when the wrong (non-surviving) copy would otherwise have matched", () => {
    // If dedup incorrectly kept the resumable copy (input order) instead of
    // the active copy (population order), this would report matched:true --
    // it must report a mismatch instead.
    const guard = [
      { ...base, population: "resumableSessions", sourceDir: "same-dir" },
      { ...base, population: "activeSessions", sourceDir: "same-dir", state: "active" },
    ];
    const status = [{ ...base, population: "activeSessions", sourceDir: "same-dir", state: "stale" }];
    const result = reconcileFingerprints(guard, status);
    expect(result.matched).toBe(false);
    expect(result.mismatchedFields["s1"]).toEqual(["state"]);
  });
});

/**
 * T-320 commit 3 acceptance: "the existing reconciliation logic run against
 * compact status for matching, changed, duplicate, and unverifiable session
 * populations gives the same verdicts as against full status." `output-formatter.ts`'s
 * `reduceSessionForCompact` is the REAL reduction `formatStatus`'s compact
 * branch applies (not a re-derivation here); `reconcileFingerprints` above is
 * the existing reconciliation logic itself.
 *
 * Only the STATUS side is ever compact in production: `storybloq_session_guard`
 * has no `compact` option and always returns full `ActiveSessionSummary`
 * records, while `storybloq_status --compact` reduces its own. So each
 * "compact" case below feeds the reducer's OUTPUT to only one side (guard
 * stays full) and compares against the all-full baseline verdict -- a
 * symmetric compact-vs-compact comparison would let a reducer regression that
 * drops a fingerprint field from BOTH sides cancel out and pass unnoticed.
 */
describe("reconcileFingerprints: compact status sessions give the same verdict as full status sessions (T-320 commit 3)", () => {
  function makeFullSession(overrides: Partial<ActiveSessionSummary> = {}): ActiveSessionSummary {
    return {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      mode: "autonomous",
      ticketId: "T-900",
      ticketTitle: "A ticket compact drops",
      ownerTask: { client: "claude", id: "task-1" } as never,
      leaseExpiresAt: null,
      leaseState: "live",
      compactPending: false,
      ...overrides,
    };
  }

  function tagged(s: ActiveSessionSummary, population: "activeSessions" | "resumableSessions" = "activeSessions") {
    return { ...s, population };
  }

  function compactTagged(s: ActiveSessionSummary, population: "activeSessions" | "resumableSessions" = "activeSessions") {
    return { ...reduceSessionForCompact(s), population };
  }

  it("matching: identical sessions match whether the status side is full or compact", () => {
    const a = makeFullSession();
    const b = makeFullSession();
    const fullVerdict = reconcileFingerprints([tagged(a)], [tagged(b)]);
    const guardFullStatusCompact = reconcileFingerprints([tagged(a)], [compactTagged(b)]);
    expect(guardFullStatusCompact.matched).toBe(fullVerdict.matched);
    expect(guardFullStatusCompact.matched).toBe(true);
  });

  it("changed: a state transition is caught identically with a full guard against a compact status", () => {
    const before = makeFullSession();
    const after = makeFullSession({ state: "compacted" });
    const fullVerdict = reconcileFingerprints([tagged(before)], [tagged(after)]);
    const guardFullStatusCompact = reconcileFingerprints([tagged(before)], [compactTagged(after)]);
    expect(guardFullStatusCompact.matched).toBe(fullVerdict.matched);
    expect(guardFullStatusCompact.matched).toBe(false);
    expect(guardFullStatusCompact.mismatchedFields["s1"]).toEqual(fullVerdict.mismatchedFields["s1"]);
    expect(guardFullStatusCompact.mismatchedFields["s1"]).toEqual(["state"]);
  });

  it("duplicate: the same dedupe survivor (population, then sourceDir) is picked identically with a full guard against a compact status", () => {
    const resumableCopy = makeFullSession({ sourceDir: "z-dir" });
    const activeCopy = makeFullSession({ sourceDir: "a-dir" });
    const guardFull = [tagged(resumableCopy, "resumableSessions"), tagged(activeCopy, "activeSessions")];
    const statusFull = [tagged(activeCopy, "activeSessions")];
    const statusCompact = [compactTagged(activeCopy, "activeSessions")];
    const fullVerdict = reconcileFingerprints(guardFull, statusFull);
    const guardFullStatusCompact = reconcileFingerprints(guardFull, statusCompact);
    expect(guardFullStatusCompact.matched).toBe(fullVerdict.matched);
    expect(guardFullStatusCompact.matched).toBe(true);
  });

  it("unverifiable: a session present on only the status side reports the same presence mismatch whether that status entry is full or compact", () => {
    const s = makeFullSession();
    const fullVerdict = reconcileFingerprints([], [tagged(s)]);
    const guardEmptyStatusCompact = reconcileFingerprints([], [compactTagged(s)]);
    expect(guardEmptyStatusCompact.matched).toBe(fullVerdict.matched);
    expect(guardEmptyStatusCompact.matched).toBe(false);
    expect(guardEmptyStatusCompact.mismatchedFields["s1"]).toEqual(fullVerdict.mismatchedFields["s1"]);
    expect(guardEmptyStatusCompact.mismatchedFields["s1"]).toEqual(["presence"]);
  });
});

// --- stepReconciliation's retry path (unit level, mock ReplayContext) ---------
//
// The retry issues a REAL storybloq_session_guard call through
// ctx.client.callTool; a mock client here stands in for the real MCP client
// so this exercises stepReconciliation itself (not just reconcileFingerprints
// in isolation), proving the call actually fires and its result -- not the
// original mismatched verdict -- is what gets compared.

function makeMockReconciliationCtx(secondGuardSessions: unknown[]): {
  ctx: ReplayContext;
  calledTools: string[];
} {
  const log: CapturedMessage[] = [];
  const calledTools: string[] = [];
  let nextId = 1;
  const mockClient = {
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calledTools.push(name);
      const id = nextId++;
      log.push({
        seq: log.length,
        direction: "client-to-server",
        message: { method: "tools/call", params: { name, arguments: args }, jsonrpc: "2.0", id },
      });
      const text = JSON.stringify({ sessions: secondGuardSessions });
      log.push({
        seq: log.length,
        direction: "server-to-client",
        message: { result: { content: [{ type: "text", text }] }, jsonrpc: "2.0", id },
      });
      return undefined;
    },
  };
  const ctx: ReplayContext = {
    root: "/mock-root",
    client: mockClient as any,
    log,
    normalize: buildNormalizer("/mock-root"),
    gitLogMode: "fixture",
  };
  return { ctx, calledTools };
}

describe("stepReconciliation retry path (unit level)", () => {
  const activeStatusSession = {
    sessionId: "s1",
    sourceDir: "dirA",
    state: "active",
    compactPending: false,
    leaseState: "held",
    ownerTask: { client: "claude", id: "task-1" },
  };
  const guardVerdict = {
    sessions: [{ ...activeStatusSession, population: "activeSessions", state: "stale" }], // mismatched vs status on first attempt
  };
  const statusPayload = { activeSessions: [activeStatusSession], resumableSessions: [] };

  it("fires exactly one retried guard call, and a retry that now agrees reports matched", async () => {
    const { ctx, calledTools } = makeMockReconciliationCtx([
      { ...activeStatusSession, population: "activeSessions" }, // retried verdict agrees with status
    ]);
    const report = await stepReconciliation(ctx, guardVerdict, statusPayload);
    expect(calledTools).toEqual(["storybloq_session_guard"]);
    expect(report.calls).toBe(1);
    expect((report as any).verdict).toBe("matched");
    expect((report as any).matched).toBe(true);
    expect((report as any).status).toBeUndefined();
  });

  it("a persisting mismatch after the retry reports verdict 'unverifiable', not 'matched'", async () => {
    const { ctx, calledTools } = makeMockReconciliationCtx([
      { ...activeStatusSession, population: "activeSessions", state: "still-stale" }, // retried verdict STILL disagrees
    ]);
    const report = await stepReconciliation(ctx, guardVerdict, statusPayload);
    expect(calledTools).toEqual(["storybloq_session_guard"]);
    expect((report as any).verdict).toBe("unverifiable");
    expect((report as any).matched).toBe(false);
    expect((report as any).status).toBe("incomplete");
  });
});

// --- replay-level: stop-on-unverifiable and partial-progress retention -------
//
// The two tests above prove stepReconciliation's OWN returned report is
// correct. They cannot prove anything about its CALLERS (runFixtureMode /
// runLiveMode, both of which now delegate to the shared runReplaySequence):
// whether an "unverifiable" verdict actually stops the sequence, or whether a
// later crash actually preserves earlier measurements. These tests drive
// runReplaySequence itself (the exact function both modes call) with a full
// mock ReplayContext, so they exercise the real orchestration logic rather
// than a re-implementation of it.

function makeMockReplayCtx(opts: {
  statusPayload: Record<string, unknown>;
  guardSessionsByCall: unknown[][];
  throwOnTool?: string;
  /** Return genuinely-captured, but unparseable, JSON text for storybloq_status. */
  malformedStatusJson?: boolean;
  /** Log ONLY the outgoing request for this tool, then reject -- models a
   * dropped connection / timeout: a request was truly sent, but no response
   * ever arrived. */
  requestOnlyFailOnTool?: string;
  /** For this tool's call, log its request, THEN a stray server-to-client
   * NOTIFICATION (no id), THEN its real response -- proving call-counting
   * matches by JSON-RPC id rather than merely alternating direction (which
   * would mistake the notification for the reply and miscount). */
  injectNotificationMidExchangeForTool?: string;
}): { ctx: ReplayContext; calledTools: string[]; log: CapturedMessage[] } {
  const log: CapturedMessage[] = [];
  const calledTools: string[] = [];
  let nextId = 1;
  let guardCallIndex = 0;

  const pushRequest = (method: string, params: unknown, id: number): void => {
    log.push({
      seq: log.length,
      direction: "client-to-server",
      message: { method, params, jsonrpc: "2.0", id },
    });
  };
  const pushResponse = (result: unknown, id: number): void => {
    log.push({
      seq: log.length,
      direction: "server-to-client",
      message: { result, jsonrpc: "2.0", id },
    });
  };
  const pushExchange = (method: string, params: unknown, result: unknown): void => {
    const id = nextId++;
    pushRequest(method, params, id);
    pushResponse(result, id);
  };

  const mockClient = {
    listTools: async () => {
      pushExchange("tools/list", {}, { tools: [] });
      return { tools: [] };
    },
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      calledTools.push(name);
      if (opts.requestOnlyFailOnTool && name === opts.requestOnlyFailOnTool) {
        // A request was genuinely sent -- logged -- but the call rejects
        // before any response is ever captured.
        pushRequest("tools/call", { name, arguments: args }, nextId++);
        throw new Error(`mock connection drop calling ${name}`);
      }
      if (opts.throwOnTool && name === opts.throwOnTool) {
        throw new Error(`mock failure calling ${name}`);
      }
      let text: string;
      if (name === "storybloq_session_guard") {
        const idx = Math.min(guardCallIndex, opts.guardSessionsByCall.length - 1);
        text = JSON.stringify({ sessions: opts.guardSessionsByCall[idx] });
        guardCallIndex++;
      } else if (name === "storybloq_status") {
        text = opts.malformedStatusJson ? "not valid json {{{" : JSON.stringify(opts.statusPayload);
      } else {
        text = JSON.stringify({});
      }
      if (opts.injectNotificationMidExchangeForTool && name === opts.injectNotificationMidExchangeForTool) {
        const id = nextId++;
        pushRequest("tools/call", { name, arguments: args }, id);
        log.push({
          seq: log.length,
          direction: "server-to-client",
          message: { method: "notifications/message", params: { level: "info" }, jsonrpc: "2.0" },
        });
        pushResponse({ content: [{ type: "text", text }] }, id);
        return undefined;
      }
      pushExchange("tools/call", { name, arguments: args }, { content: [{ type: "text", text }] });
      return undefined;
    },
  };

  const ctx: ReplayContext = {
    root: "/mock-root",
    client: mockClient as any,
    log,
    normalize: buildNormalizer("/mock-root"),
    gitLogMode: "fixture",
  };
  return { ctx, calledTools, log };
}

/** Independent oracle: sums raw JSON-RPC message bytes directly via
 * Buffer.byteLength, bypassing the harness's own measuredBytes/normalize
 * helpers entirely, over log entries in [start, end). Used to prove exact
 * byte retention rather than a weak `> 0` bound that prior-successful
 * exchanges would already satisfy on their own. */
function independentByteSum(log: CapturedMessage[], start: number, end: number): number {
  return log
    .slice(start, end)
    .reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.message), "utf8"), 0);
}

describe("runReplaySequence: stop after an unverifiable reconciliation", () => {
  const activeStatusSession = {
    sessionId: "s1",
    sourceDir: "dirA",
    state: "active",
    compactPending: false,
    leaseState: "held",
    ownerTask: { client: "claude", id: "task-1" },
  };
  const statusPayload = { activeSessions: [activeStatusSession], resumableSessions: [] };
  // Both the first guard call and the retried guard call disagree with
  // status on `state` -- a persisting mismatch.
  const mismatchedGuardSessions = [{ ...activeStatusSession, population: "activeSessions", state: "stale" }];

  it("fires exactly two session_guard calls, one status call, and zero downstream tool calls, retaining prior costs as observed_subtotal", async () => {
    const { ctx, calledTools } = makeMockReplayCtx({
      statusPayload,
      guardSessionsByCall: [mismatchedGuardSessions, mismatchedGuardSessions],
    });

    const { steps, anyIncomplete, orchestrator } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);
    // The early-return (stop) path must carry the same result shape as the
    // full-sequence return -- including fields, like orchestrator, that are
    // easy to leave off an early return by hand.
    expect(typeof orchestrator).toBe("boolean");

    const guardCalls = calledTools.filter((t) => t === "storybloq_session_guard");
    const statusCalls = calledTools.filter((t) => t === "storybloq_status");
    expect(guardCalls).toHaveLength(2);
    expect(statusCalls).toHaveLength(1);
    // No downstream tool beyond discovery/guard/status/reconciliation's retry
    // fires at all.
    expect(calledTools).toEqual([
      "storybloq_session_guard",
      "storybloq_status",
      "storybloq_session_guard",
    ]);

    expect(anyIncomplete).toBe(true);
    expect((steps.reconciliation as any).verdict).toBe("unverifiable");
    // session_guard, status, and reconciliation's own retry genuinely
    // transmitted -- their costs are retained, not zeroed.
    expect(steps.session_guard.calls).toBe(1);
    expect(steps.status.calls).toBe(1);
    expect(steps.reconciliation.calls).toBe(1);
    // Every step after reconciliation never ran: zero cost, incomplete.
    const downstreamNames = STEP_NAMES.filter(
      (n) => n !== "tool_discovery" && n !== "tool_discovery_reference" && n !== "session_guard" && n !== "status" && n !== "reconciliation",
    );
    for (const name of downstreamNames) {
      expect(steps[name].calls).toBe(0);
      expect(steps[name].bytes).toBe(0);
      expect((steps[name] as any).status).toBe("incomplete");
    }
  });

  it("a retry that resolves the mismatch proceeds through the full sequence (regression: matched reconciliation does not stop)", async () => {
    const { ctx, calledTools } = makeMockReplayCtx({
      statusPayload,
      guardSessionsByCall: [
        mismatchedGuardSessions,
        [{ ...activeStatusSession, population: "activeSessions" }], // retry agrees
      ],
    });

    const { steps } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect((steps.reconciliation as any).verdict).toBe("matched");
    // Downstream steps genuinely ran (mock returns empty-shaped payloads, so
    // their own parsing may report incomplete, but they were not SKIPPED --
    // recap made a real call).
    expect(calledTools).toContain("storybloq_recap");
    expect(steps.recap.calls).toBe(1);
  });
});

describe("runReplaySequence: partial progress survives a later crash", () => {
  it("retains session_guard/status/reconciliation's genuine costs when a later step throws", async () => {
    const activeStatusSession = {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      compactPending: false,
      leaseState: "held",
      ownerTask: { client: "claude", id: "task-1" },
    };
    const agreeingGuardSessions = [{ ...activeStatusSession, population: "activeSessions" }];
    const { ctx, calledTools, log } = makeMockReplayCtx({
      statusPayload: { activeSessions: [activeStatusSession], resumableSessions: [] },
      guardSessionsByCall: [agreeingGuardSessions],
      throwOnTool: "storybloq_recap",
    });

    const { steps, anyIncomplete } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect(anyIncomplete).toBe(true);
    // Steps genuinely measured before the crash are RETAINED, not zeroed --
    // exact byte counts via an independent oracle, not a `> 0` bound.
    expect((steps.reconciliation as any).verdict).toBe("matched");
    // tool_discovery's own tools/list exchange occupies log[0,2); session_guard
    // is log[2,4); status is log[4,6).
    expect(steps.session_guard.calls).toBe(1);
    expect(steps.session_guard.bytes).toBe(independentByteSum(log, 2, 4));
    expect(steps.status.calls).toBe(1);
    expect(steps.status.bytes).toBe(independentByteSum(log, 4, 6));
    // Everything from the crashing step onward is zero-cost and incomplete.
    // The mock throws before logging anything for storybloq_recap, so there
    // is genuinely nothing to recover here -- this differs from the tests
    // below, where the failing exchange IS captured before the throw.
    expect(steps.recap.calls).toBe(0);
    expect(steps.recap.bytes).toBe(0);
    expect((steps.recap as any).status).toBe("incomplete");
    expect((steps.recap as any).reason).toMatch(/replay step crashed/);
    expect(steps.node_list.calls).toBe(0);
    expect((steps.node_list as any).status).toBe("incomplete");
    expect(calledTools.filter((t) => t === "storybloq_recap")).toHaveLength(1);
    expect(calledTools).not.toContain("storybloq_handover_latest");
  });

  it("recovers a single-call step's genuine captured cost when its OWN post-processing crashes (malformed status JSON)", async () => {
    const activeStatusSession = {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      compactPending: false,
      leaseState: "held",
      ownerTask: { client: "claude", id: "task-1" },
    };
    const { ctx, calledTools, log } = makeMockReplayCtx({
      statusPayload: { activeSessions: [activeStatusSession], resumableSessions: [] },
      guardSessionsByCall: [[{ ...activeStatusSession, population: "activeSessions" }]],
      malformedStatusJson: true,
    });

    const { steps, anyIncomplete } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect(anyIncomplete).toBe(true);
    // tool_discovery + session_guard genuinely completed and are retained.
    // tool_discovery is log[0,2); session_guard is log[2,4); status is log[4,6).
    expect(steps.session_guard.calls).toBe(1);
    expect(steps.session_guard.bytes).toBe(independentByteSum(log, 2, 4));
    // storybloq_status's own JSON.parse throws on the unparseable text --
    // uncaught by stepStatus itself -- but the exchange WAS genuinely
    // captured (request + response both logged) before that crash. The
    // generic recovery in runReplaySequence's catch must attribute this to
    // "status" specifically (not "reconciliation", which STEP_NAMES lists
    // first but which never actually ran).
    expect(steps.status.calls).toBe(1);
    expect(steps.status.bytes).toBe(independentByteSum(log, 4, 6));
    expect((steps.status as any).status).toBe("incomplete");
    expect((steps.status as any).reason).toMatch(/replay step crashed/);
    // Nothing past status ever ran.
    expect((steps.reconciliation as any).calls).toBe(0);
    expect((steps.reconciliation as any).status).toBe("incomplete");
    expect(steps.recap.calls).toBe(0);
    expect(calledTools).toEqual(["storybloq_session_guard", "storybloq_status"]);
  });

  it("recovers just the request's bytes (zero completed calls) when a call is sent but no response ever arrives", async () => {
    const activeStatusSession = {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      compactPending: false,
      leaseState: "held",
      ownerTask: { client: "claude", id: "task-1" },
    };
    const { ctx } = makeMockReplayCtx({
      statusPayload: { activeSessions: [activeStatusSession], resumableSessions: [] },
      guardSessionsByCall: [[{ ...activeStatusSession, population: "activeSessions" }]],
      requestOnlyFailOnTool: "storybloq_recap",
    });

    const { steps, anyIncomplete } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect(anyIncomplete).toBe(true);
    expect((steps.reconciliation as any).verdict).toBe("matched");
    // The recap request was genuinely sent (real bytes) but no response
    // ever arrived -- that costs real bytes but is not a completed call.
    expect(steps.recap.bytes).toBeGreaterThan(0);
    expect(steps.recap.calls).toBe(0);
    expect((steps.recap as any).status).toBe("incomplete");
  });

  it("counts calls by matching JSON-RPC id, not by alternating direction -- a notification interleaved between a request and its reply is not mistaken for the reply", async () => {
    const activeStatusSession = {
      sessionId: "s1",
      sourceDir: "dirA",
      state: "active",
      compactPending: false,
      leaseState: "held",
      ownerTask: { client: "claude", id: "task-1" },
    };
    const { ctx } = makeMockReplayCtx({
      statusPayload: { activeSessions: [activeStatusSession], resumableSessions: [] },
      guardSessionsByCall: [[{ ...activeStatusSession, population: "activeSessions" }]],
      throwOnTool: "storybloq_lesson_digest",
      // recap's own request is followed by a stray notification (no id)
      // BEFORE recap's real response arrives. A direction-alternation-only
      // counter would treat that notification as recap's reply (counting
      // recap complete one message early) and then have nothing pending
      // when the real response lands.
      injectNotificationMidExchangeForTool: "storybloq_recap",
    });

    const { steps, anyIncomplete } = await runReplaySequence(ctx, "/mock-root", ctx.normalize);

    expect(anyIncomplete).toBe(true);
    // recap completed exactly once, matched to its OWN response by id, not
    // to the notification sitting between its request and reply.
    expect(steps.recap.calls).toBe(1);
    // handover_latest now fires twice (priming + brief, T-498 Commit 3's
    // two-call Step 2) -- both complete normally here since the injected
    // notification targets recap, not handover_latest.
    expect(steps.handover_latest.calls).toBe(2);
    expect((steps.lesson_digest as any).status).toBe("incomplete");
  });
});

// --- callTool resilience: a failing sub-call within a multi-call step must not
// erase the transport cost of exchanges that already completed, INCLUDING its
// own captured-but-unreadable exchange (not just prior successful ones). Both
// stepRecommend now parses recommend's own JSON payload directly -- the
// `recommendations`/`excluded` arrays are already partitioned by
// recommend()'s own partitionByActionability, so this step makes exactly one
// call (recommend itself) and never walks issue_get/ticket_get at all.
// stepContinuationCheck's per-id walk is now a bounded-array lookup first
// (zero calls for an id resolvable from either `recommendations` or
// `excluded`) with at most one fallback `_get` call for an id absent from
// both. These tests prove both zero-call claims and the fallback's own
// failure-retention path. -----------------------------------

function pushJsonExchange(
  log: CapturedMessage[],
  nextId: { value: number },
  method: string,
  params: unknown,
  text: string,
): void {
  const id = nextId.value++;
  log.push({ seq: log.length, direction: "client-to-server", message: { method, params, jsonrpc: "2.0", id } });
  log.push({
    seq: log.length,
    direction: "server-to-client",
    message: { result: { content: [{ type: "text", text }] }, jsonrpc: "2.0", id },
  });
}

describe("stepRecommend: JSON payload parsing, zero sub-calls", () => {
  it("reports zero issue_get calls when the payload carries ten actionable rows", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const rows: RecommendRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `ISS-${100 + i}`,
      kind: "issue" as const,
      title: `Issue ${100 + i}`,
      reason: "quick win",
    }));
    const payloadText = JSON.stringify({ recommendations: rows, excluded: [], unreadableHandoverCount: 0 });

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === "storybloq_recommend") {
          pushJsonExchange(log, nextId, "tools/call", { name, arguments: args }, payloadText);
          return undefined;
        }
        throw new Error(`unexpected sub-call to ${name}: stepRecommend must never walk issue_get/ticket_get`);
      },
    };

    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const { report, rows: outRows, excluded } = await stepRecommend(ctx);

    expect(outRows).toHaveLength(10);
    expect(excluded).toHaveLength(0);
    expect((report as any).status).toBeUndefined();
    // calls: recommend alone. No issue_get walk exists any more.
    expect(report.calls).toBe(1);
    expect((report as any).issueGetCalls).toBe(0);
    expect((report as any).actionableIssueCount).toBe(10);
    expect((report as any).excludedCount).toBe(0);
    expect(report.bytes).toBe(independentByteSum(log, 0, log.length));
  });

  it("surfaces a populated excluded array with no sub-call attempted for any entry", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const rows: RecommendRow[] = [
      { id: "T-1", kind: "ticket", title: "Ticket 1", reason: "quick win" },
      { id: "ISS-1", kind: "issue", title: "Issue 1", reason: "quick win" },
    ];
    const excludedRows: ExcludedRow[] = [
      {
        id: "ISS-2",
        kind: "issue",
        title: "Issue 2",
        actionability: { status: "owner_gated", reason: "owner gated", source: "structured" },
      },
      {
        id: "ISS-3",
        kind: "issue",
        title: "Issue 3",
        actionability: { status: "complete", reason: "already done", source: "derived" },
      },
    ];
    const payloadText = JSON.stringify({ recommendations: rows, excluded: excludedRows, unreadableHandoverCount: 0 });

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        if (name === "storybloq_recommend") {
          pushJsonExchange(log, nextId, "tools/call", { name, arguments: args }, payloadText);
          return undefined;
        }
        throw new Error(`unexpected sub-call to ${name}: excluded entries must never be probed`);
      },
    };

    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const { report, rows: outRows, excluded } = await stepRecommend(ctx);

    expect(outRows).toHaveLength(2);
    expect(excluded).toEqual(excludedRows);
    expect(report.calls).toBe(1);
    expect((report as any).issueGetCalls).toBe(0);
    expect((report as any).excludedCount).toBe(2);
  });
});

function candidate(
  id: string | null,
  kind: "item" | "decision" = "item",
  label = "label",
  rationale = "unknown",
): ContinuationCandidate {
  return { id, kind, label, rationale };
}

function newestEntry(
  candidates: ContinuationCandidate[],
  omittedContinuationCount = 0,
  omittedContinuationIds: string[] = [],
): HandoverBriefEntryLike {
  return {
    filename: "newest.md",
    form: "structured",
    records: [],
    continuationCandidates: { candidates, omittedContinuationCount, omittedContinuationIds },
  };
}

describe("stepLineOne: candidate walk, fallback, and 3-tier recovery (T-498 commit 3)", () => {
  it("resolves an item candidate present in recommendations with zero calls, never reaching the fallback", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async () => {
        throw new Error("recommendations hit must cost zero calls -- fallback must never fire");
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const recommendRows: RecommendRow[] = [{ id: "ISS-100", kind: "issue", title: "Issue 100", reason: "quick win" }];
    const newest = newestEntry([candidate("ISS-100")]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], recommendRows, []);

    expect(resolvedCandidate?.id).toBe("ISS-100");
    expect(report.calls).toBe(0);
  });

  it("a decision-kind candidate resolves immediately, no id, no actionability check, even ahead of an item candidate", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async () => {
        throw new Error("a decision candidate must cost zero calls and must not fall through to the item behind it");
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const decision = candidate(null, "decision", "switched to approach B", "approach A hit a blocker");
    const item = candidate("T-1", "item");
    const newest = newestEntry([decision, item]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], [], []);

    expect(resolvedCandidate).toEqual(decision);
    expect(report.calls).toBe(0);
  });

  it("skips an id present in excluded with zero calls, then resolves the next id via exactly one fallback call reading actionability.status", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const called: string[] = [];

    const excludedRows: ExcludedRow[] = [
      { id: "ISS-200", kind: "issue", title: "Issue 200", actionability: { status: "owner_gated", reason: "gated", source: "structured" } },
    ];

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        called.push(args.id as string);
        expect(args.format).toBe("json");
        expect(args.withActionability).toBe(true);
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ actionability: { status: "actionable", reason: "clear", source: "structured" }, unreadableHandoverCount: 0 }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const newest = newestEntry([candidate("ISS-200"), candidate("ISS-300")]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], [], excludedRows);

    // ISS-200 costs zero calls (already known via excluded); only ISS-300
    // ever reaches the fallback get.
    expect(called).toEqual(["ISS-300"]);
    expect(resolvedCandidate?.id).toBe("ISS-300");
    expect(report.calls).toBe(1);
    expect((report as any).fallbackUnreadableHandoverCount).toBe(0);
  });

  it("retains a fallback call's captured-but-unreadable bytes via CallToolFailure", async () => {
    const log: CapturedMessage[] = [];
    let nextId = 1;

    const pushExchange = (method: string, params: unknown, result: unknown): void => {
      const id = nextId++;
      log.push({ seq: log.length, direction: "client-to-server", message: { method, params, jsonrpc: "2.0", id } });
      log.push({ seq: log.length, direction: "server-to-client", message: { result, jsonrpc: "2.0", id } });
    };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        // Genuinely captured (request + response both logged, real transport
        // cost) but the content shape cannot be read as text.
        pushExchange("tools/call", { name, arguments: args }, { content: [] });
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const newest = newestEntry([candidate("ISS-400")], 0, []);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], [], []);

    expect(resolvedCandidate).toBeNull();
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/ISS-400/);
    expect(report.calls).toBe(1);
    expect(report.bytes).toBe(independentByteSum(log, 0, log.length));
  });

  it("keeps walking past a captured-but-unreadable fallback to resolve a later candidate via recommendations, disclosing the walk as incomplete without losing the resolved candidate", async () => {
    // SKILL.md: an unreadable fallback response is "anything else", the same
    // as a failed (deleted/renamed) get -- the walk must not stop there.
    const log: CapturedMessage[] = [];
    let nextId = 1;
    const called: string[] = [];

    const pushExchange = (method: string, params: unknown, result: unknown): void => {
      const id = nextId++;
      log.push({ seq: log.length, direction: "client-to-server", message: { method, params, jsonrpc: "2.0", id } });
      log.push({ seq: log.length, direction: "server-to-client", message: { result, jsonrpc: "2.0", id } });
    };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        called.push(args.id as string);
        // Genuinely captured but unreadable -- ISS-600 must never reach here
        // at all, since it resolves via `recommendations` at zero cost.
        pushExchange("tools/call", { name, arguments: args }, { content: [] });
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const recommendRows: RecommendRow[] = [{ id: "ISS-600", kind: "issue", title: "Issue 600", reason: "quick win" }];
    const newest = newestEntry([candidate("ISS-500"), candidate("ISS-600")]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], recommendRows, []);

    expect(called).toEqual(["ISS-500"]);
    expect(resolvedCandidate?.id).toBe("ISS-600");
    expect(report.calls).toBe(1);
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/ISS-500/);
    expect(report.bytes).toBe(independentByteSum(log, 0, log.length));
  });

  it("retains a request-only (no-response) fallback failure's bytes via CallToolFailure, then resolves the next candidate via recommendations", async () => {
    const log: CapturedMessage[] = [];
    let nextId = 1;
    const called: string[] = [];

    const pushRequest = (method: string, params: unknown, id: number): void => {
      log.push({ seq: log.length, direction: "client-to-server", message: { method, params, jsonrpc: "2.0", id } });
    };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        called.push(args.id as string);
        // A request was genuinely sent (real bytes) but the call rejects
        // before any response is ever captured -- T-999 must never reach
        // here, since it resolves via `recommendations` at zero cost.
        pushRequest("tools/call", { name, arguments: args }, nextId++);
        throw new Error(`mock connection drop calling ${name} ${args.id}`);
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const recommendRows: RecommendRow[] = [{ id: "T-999", kind: "ticket", title: "Ticket 999", reason: "quick win" }];
    const newest = newestEntry([candidate("ISS-900"), candidate("T-999")]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], recommendRows, []);

    expect(called).toEqual(["ISS-900"]);
    expect(resolvedCandidate?.id).toBe("T-999");
    // A request-only failure costs real bytes (retained below) but is not a
    // completed call -- same convention as callTool's other no-response path.
    expect(report.calls).toBe(0);
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/ISS-900/);
    expect(report.bytes).toBe(independentByteSum(log, 0, log.length));
  });

  it("retains both a completed non-actionable fallback's bytes and a later request-only failure's bytes in the same walk, then resolves via recommendations", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const called: string[] = [];

    const pushRequestOnly = (method: string, params: unknown): void => {
      log.push({ seq: log.length, direction: "client-to-server", message: { method, params, jsonrpc: "2.0", id: nextId.value++ } });
    };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        called.push(args.id as string);
        if (args.id === "ISS-910") {
          // A genuinely completed exchange that reads clean but is not
          // actionable -- the walk continues past it.
          pushJsonExchange(
            log,
            nextId,
            "tools/call",
            { name, arguments: args },
            JSON.stringify({ actionability: { status: "owner_gated", reason: "gated", source: "structured" }, unreadableHandoverCount: 0 }),
          );
          return undefined;
        }
        // ISS-920: request sent, real bytes, but no response ever captured.
        // T-930 must never reach here at all (resolved via recommendations).
        pushRequestOnly("tools/call", { name, arguments: args });
        throw new Error(`mock connection drop calling ${name} ${args.id}`);
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const recommendRows: RecommendRow[] = [{ id: "T-930", kind: "ticket", title: "Ticket 930", reason: "quick win" }];
    const newest = newestEntry([candidate("ISS-910"), candidate("ISS-920"), candidate("T-930")]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], recommendRows, []);

    expect(called).toEqual(["ISS-910", "ISS-920"]);
    expect(resolvedCandidate?.id).toBe("T-930");
    // Exactly one completed call (ISS-910); ISS-920's dangling request costs
    // real bytes but is not a completed call, matching callTool's own
    // no-response convention.
    expect(report.calls).toBe(1);
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/ISS-920/);
    // Exact byte retention across BOTH the completed and the failed
    // exchange, independently summed from the raw log.
    expect(report.bytes).toBe(independentByteSum(log, 0, log.length));
  });

  it("preserves the earliest uncertain unreadableHandoverCount across multiple fallback calls instead of letting a later clean one overwrite it", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        if (args.id === "ISS-700") {
          pushJsonExchange(
            log,
            nextId,
            "tools/call",
            { name, arguments: args },
            JSON.stringify({ actionability: { status: "owner_gated", reason: "gated", source: "structured" }, unreadableHandoverCount: 3 }),
          );
          return undefined;
        }
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ actionability: { status: "actionable", reason: "clear", source: "structured" }, unreadableHandoverCount: 0 }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const newest = newestEntry([candidate("ISS-700"), candidate("ISS-800")]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], [], []);

    expect(resolvedCandidate?.id).toBe("ISS-800");
    expect(report.calls).toBe(2);
    // ISS-700's uncertain count (3) must survive ISS-800's later clean 0.
    expect((report as any).fallbackUnreadableHandoverCount).toBe(3);
    expect((report as any).status).toBeUndefined();
  });

  it("mutant (c) guard: the conflict note names each skipped candidate's id and status, in order, at zero cost", async () => {
    const excludedRows: ExcludedRow[] = [
      { id: "ISS-1", kind: "issue", title: "x", actionability: { status: "owner_gated", reason: "gated", source: "structured" } },
      { id: "ISS-2", kind: "issue", title: "y", actionability: { status: "owner_gated", reason: "gated", source: "structured" } },
    ];
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async () => {
        throw new Error("no fallback expected -- both candidates are already excluded");
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const newest = newestEntry([candidate("ISS-1"), candidate("ISS-2")]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], [], excludedRows);

    expect(resolvedCandidate).toBeNull();
    expect(report.calls).toBe(0);
    expect((report as any).conflictNote).toBe("ISS-1: excluded; ISS-2: excluded");
  });

  it("empty candidates with zero omissions falls back silently, at zero cost, without ever attempting recovery", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async () => {
        throw new Error("no recovery should ever be attempted when nothing was omitted");
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const newest = newestEntry([], 0, []);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], [], []);

    expect(resolvedCandidate).toBeNull();
    expect(report.calls).toBe(0);
    expect((report as any).usedFallback).toBe(true);
  });

  it("mutant (d) guard, tier 1: recovers an omitted candidate from the already-loaded priming raw body (zero extra calls) and resolves it", async () => {
    const primingBody = ["# Title", "", "## Next", "- T-1: first candidate", "- T-2: second candidate", ""].join("\n");
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async () => {
        throw new Error("tier-1 recovery must cost zero calls -- nothing here should ever fire a tool call");
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    // T-1 is the only candidate that survived the 800-byte cap (simulated
    // directly); T-2 was omitted, but its record is still present in the
    // raw body the `priming` call already loaded.
    const excludedRows: ExcludedRow[] = [
      { id: "T-1", kind: "ticket", title: "x", actionability: { status: "owner_gated", reason: "gated", source: "structured" } },
    ];
    const recommendRows: RecommendRow[] = [{ id: "T-2", kind: "ticket", title: "Ticket 2", reason: "quick win" }];
    const newest = newestEntry([candidate("T-1")], 1, ["T-2"]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, primingBody, [newest], recommendRows, excludedRows);

    expect(resolvedCandidate?.id).toBe("T-2");
    expect((report as any).recovered).toBe(true);
    expect((report as any).recoveryTier).toBe("raw-body");
    expect(report.calls).toBe(0);
  });

  it("mutant (d) guard, tier 2: one handover_get call recovers an omitted candidate when no raw body was loaded", async () => {
    const rawBody = ["# Title", "", "## Next", "- T-3: recovered candidate", ""].join("\n");
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const called: string[] = [];

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        called.push(name);
        expect(name).toBe("storybloq_handover_get");
        expect(args.filename).toBe("newest.md");
        expect(args.format).toBe("json");
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ version: 1, data: { filename: "newest.md", content: rawBody } }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const recommendRows: RecommendRow[] = [{ id: "T-3", kind: "ticket", title: "Ticket 3", reason: "quick win" }];
    const newest = newestEntry([], 1, ["T-3"]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], recommendRows, []);

    expect(called).toEqual(["storybloq_handover_get"]);
    expect(resolvedCandidate?.id).toBe("T-3");
    expect((report as any).recoveryTier).toBe("handover-get");
    expect(report.calls).toBe(1);
  });

  it("mutant (d) guard, exhaustion: both recovery tiers failing falls back to disclosure naming the omitted ids, as the true last resort", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async ({ name }: { name: string }) => {
        throw new Error(`mock connection drop calling ${name}`);
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const newest = newestEntry([], 1, ["T-9"]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], [], []);

    expect(resolvedCandidate).toBeNull();
    expect((report as any).usedFallback).toBe(true);
    expect((report as any).disclosed).toBe(true);
    expect((report as any).omittedContinuationIds).toEqual(["T-9"]);
    expect((report as any).reason).toMatch(/could not be recovered/);
  });

  it("Codex round 1 finding 4 guard: recovery re-walk dedupes an already-seen candidate -- no duplicate fallback call or conflict-note entry", async () => {
    const primingBody = ["# Title", "", "## Next", "- T-1: first candidate", "- T-2: second candidate", ""].join("\n");
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const called: string[] = [];

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        called.push(String(args.id));
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ actionability: { status: "owner_gated", reason: "gated", source: "structured" }, unreadableHandoverCount: 0 }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    // T-1 is retained (not omitted) but absent from both recommend and
    // excluded -- resolving it costs a real `get` call, which reports it
    // not actionable. T-2 is only recovered via the raw-body re-scan.
    // Without the finding-4 dedup fix, the recovered candidate list would
    // include T-1 again (the raw body has no notion of "already walked"),
    // spending a second `get` call on it and logging a second conflict-note
    // entry for the same id.
    const recommendRows: RecommendRow[] = [{ id: "T-2", kind: "ticket", title: "Ticket 2", reason: "quick win" }];
    const newest = newestEntry([candidate("T-1")], 1, ["T-2"]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, primingBody, [newest], recommendRows, []);

    expect(called).toEqual(["T-1"]);
    expect(resolvedCandidate?.id).toBe("T-2");
    expect(report.calls).toBe(1);
    expect((report as any).recovered).toBe(true);
    expect((report as any).recoveryTier).toBe("raw-body");
    expect((report as any).conflictNote).toBe("T-1: owner_gated");
  });

  it("Codex round 1 finding 3 guard: a failed primary lookup's uncertainty survives an uncertain recovered-walk resolution", async () => {
    const primingBody = ["# Title", "", "## Next", "- T-1: first candidate", "- T-2: second candidate", ""].join("\n");
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        if (args.id === "T-1") {
          throw new Error("mock connection drop calling storybloq_ticket_get");
        }
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ actionability: { status: "actionable", reason: "clear", source: "structured" }, unreadableHandoverCount: 2 }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    // Primary walk: T-1's fallback `get` throws (walkIncomplete, reason names
    // T-1) and resolves nothing. Recovery then recovers T-2 from the raw
    // body (T-1 is deduped out) and T-2 resolves actionable, but with a
    // nonzero unreadableHandoverCount -- an uncertain resolution. Both
    // uncertainties must survive to the combined report: the primary
    // failure's status/reason, and the recovered walk's disclosed count.
    const recommendRows: RecommendRow[] = [];
    const newest = newestEntry([candidate("T-1")], 1, ["T-2"]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, primingBody, [newest], recommendRows, []);

    expect(resolvedCandidate?.id).toBe("T-2");
    expect((report as any).recovered).toBe(true);
    expect((report as any).recoveryTier).toBe("raw-body");
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/T-1/);
    expect((report as any).fallbackUnreadableHandoverCount).toBe(2);
  });

  it("Codex round 2 finding B guard: a failed primary lookup AND a failed recovery both survive, without one clobbering the other", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async ({ name }: { name: string }) => {
        throw new Error(`mock connection drop calling ${name}`);
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    // T-1's fallback `get` throws (primary walk incomplete) and, since no
    // priming raw body was loaded, recovering the omitted T-9 also throws
    // (tier 3, genuinely unrecoverable). Before the fix, the tier-3
    // disclosure spread the primary walk's own reason over the "could not
    // be recovered" text whenever the primary was incomplete, and never
    // marked the report incomplete at all when the primary walk was clean.
    const newest = newestEntry([candidate("T-1")], 1, ["T-9"]);
    const { report, resolvedCandidate } = await stepLineOne(ctx, null, [newest], [], []);

    expect(resolvedCandidate).toBeNull();
    expect((report as any).disclosed).toBe(true);
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/could not be recovered/);
    expect((report as any).omittedContinuationIds).toEqual(["T-9"]);
    expect((report as any).walkIncompleteReason).toMatch(/T-1/);
  });
});

describe("stepReconciliationRecovery: per-older-handover recovery trigger (T-498 commit 3, design decision 2)", () => {
  it("mutant (e) guard: a fully-present older handover needs no recovery -- zero extra calls, tier not-needed", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async () => {
        throw new Error("no recovery should fire for a fully-present handover");
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const older: HandoverBriefEntryLike = {
      filename: "older.md",
      form: "structured",
      records: [{ id: "T-1", label: "x", disposition: "continuation", rationale: "clear reason", kind: "item", file: "older.md" }],
      index: null,
    };
    const { report, perHandover } = await stepReconciliationRecovery(ctx, [older]);

    expect(report.calls).toBe(0);
    expect(perHandover[0]?.recovered).toBe(false);
    expect(perHandover[0]?.tier).toBe("not-needed");
  });

  it("an index-only older handover triggers recovery via exactly one handover_get call", async () => {
    const rawBody = ["# Title", "", "## Next", "- T-2: something", ""].join("\n");
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        expect(name).toBe("storybloq_handover_get");
        expect(args.filename).toBe("older.md");
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ version: 1, data: { filename: "older.md", content: rawBody } }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const older: HandoverBriefEntryLike = { filename: "older.md", form: "index-only" };
    const { report, perHandover } = await stepReconciliationRecovery(ctx, [older]);

    expect(report.calls).toBe(1);
    expect(perHandover[0]?.recovered).toBe(true);
    expect(perHandover[0]?.tier).toBe("handover-get");
  });

  it("a structured older handover with a per-handover cap loss (index.omittedCount > 0) triggers recovery", async () => {
    const rawBody = ["# Title", "", "## Next", "- T-5: recovered", ""].join("\n");
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ version: 1, data: { filename: "older.md", content: rawBody } }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const older: HandoverBriefEntryLike = {
      filename: "older.md",
      form: "structured",
      records: [{ id: "T-4", label: "x", disposition: "continuation", rationale: "clear", kind: "item", file: "older.md" }],
      index: { omittedCount: 1, ids: ["T-5"], file: "older.md" },
    };
    const { report, perHandover } = await stepReconciliationRecovery(ctx, [older]);

    expect(report.calls).toBe(1);
    expect(perHandover[0]?.recovered).toBe(true);
  });

  it("a retained record whose rationale reads the unknown sentinel triggers recovery even with no omission signal at all", async () => {
    const rawBody = ["# Title", "", "## Next", "- T-6: recovered", ""].join("\n");
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ version: 1, data: { filename: "older.md", content: rawBody } }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const older: HandoverBriefEntryLike = {
      filename: "older.md",
      form: "structured",
      records: [{ id: "T-6", label: "x", disposition: "continuation", rationale: "unknown", kind: "item", file: "older.md" }],
      index: null,
    };
    const { report, perHandover } = await stepReconciliationRecovery(ctx, [older]);

    expect(report.calls).toBe(1);
    expect(perHandover[0]?.recovered).toBe(true);
  });

  it("recovered records are NOT filtered by disposition -- reconciliation sees a non-continuation-disposition decision too", async () => {
    const rawBody = ["# Title", "", "## Owner rulings", "- decided to use approach B instead", ""].join("\n");
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ version: 1, data: { filename: "older.md", content: rawBody } }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const older: HandoverBriefEntryLike = { filename: "older.md", form: "index-only" };
    const { perHandover } = await stepReconciliationRecovery(ctx, [older]);

    const recovered = perHandover[0]?.records ?? [];
    expect(recovered.some((r) => r.disposition === "owner-gated" && r.kind === "decision")).toBe(true);
  });

  it("multiple older handovers: only the ones that need recovery cost anything, totals are additive", async () => {
    const rawBody = ["# Title", "", "## Next", "- T-8: recovered", ""].join("\n");
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const called: string[] = [];

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        called.push((args as any).filename);
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ version: 1, data: { filename: (args as any).filename, content: rawBody } }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const fullyPresent: HandoverBriefEntryLike = {
      filename: "fully-present.md",
      form: "structured",
      records: [{ id: "T-7", label: "x", disposition: "continuation", rationale: "clear", kind: "item", file: "fully-present.md" }],
      index: null,
    };
    const needsRecovery: HandoverBriefEntryLike = { filename: "needs-recovery.md", form: "index-only" };
    const { report, perHandover } = await stepReconciliationRecovery(ctx, [fullyPresent, needsRecovery]);

    expect(called).toEqual(["needs-recovery.md"]);
    expect(report.checkedCount).toBe(2);
    expect(report.recoveredCount).toBe(1);
    expect(perHandover[0]?.recovered).toBe(false);
    expect(perHandover[1]?.recovered).toBe(true);
  });

  it("Codex round 2 finding A guard: a failed older-handover recovery is NOT recorded as recovered, and marks the step incomplete", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async ({ name }: { name: string }) => {
        throw new Error(`mock connection drop calling ${name}`);
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const needsRecovery: HandoverBriefEntryLike = { filename: "unreadable.md", form: "index-only" };
    const { report, perHandover } = await stepReconciliationRecovery(ctx, [needsRecovery]);

    // Before the fix, this branch hardcoded `recovered: true` regardless of
    // whether recovery actually succeeded, discarding the failure and
    // letting `recoveredCount` count it as a success.
    expect(perHandover[0]?.recovered).toBe(false);
    expect(perHandover[0]?.records).toBeNull();
    expect(perHandover[0]?.reason).toBeTruthy();
    expect(report.recoveredCount).toBe(0);
    expect((report as any).status).toBe("incomplete");
    expect((report as any).reason).toMatch(/unreadable\.md/);
  });
});

describe("renderTrajectoryMd / stepTrajectory (T-498 commit 3 round 2 byte-review findings F1/F2)", () => {
  const entries: TrajectoryEntry[] = [
    { id: "T-11", occurrenceCount: 3, firstSeenInWindow: "h1.md", latest: "h1.md", latestDisposition: "continuation" },
    { id: "ISS-4", occurrenceCount: 1, firstSeenInWindow: "h2.md", latest: "h2.md", latestDisposition: "owner-gated" },
  ];

  it("renders the exact F1 line shape, one line per entry, in the array's own order (not sorted, not reversed)", () => {
    const text = renderTrajectoryMd(entries);
    expect(text).toBe(
      [
        "## Trajectory (last 10 handovers)",
        "- T-11: seen in 3 of the last 10 handovers, latest h1.md (continuation)",
        "- ISS-4: seen in 1 of the last 10 handovers, latest h2.md (owner-gated)",
      ].join("\n"),
    );
  });

  it("F2 guard: renders nothing (zero bytes) when trajectory[] is empty", () => {
    expect(renderTrajectoryMd([])).toBe("");
    const report = stepTrajectory([], buildNormalizer("/mock-root"));
    expect(report.bytes).toBe(0);
    expect(report.calls).toBe(0);
    expect(report.includedInTotal).toBe(true);
  });

  it("F2 guard: the constructed step's bytes are pinned to the exact rendered text, not a placeholder or guess", () => {
    const report = stepTrajectory(entries, buildNormalizer("/mock-root"));
    expect(report.bytes).toBe(byteLength(renderTrajectoryMd(entries)));
    expect(report.calls).toBe(0);
  });
});

describe("stepHandoverPrimingAndBrief (T-498 commit 2: future two-call Step 2)", () => {
  it("makes exactly two calls with the exact required argument shape, and reports the newest handover's raw body when priming returns it (Codex round 1 findings: request format:\"json\" explicitly -- storybloq_handover_latest has no format-less JSON path -- and assert the full argument shape, not just the tool name, so dropping count or brief:true would fail this test)", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const calledCalls: { name: string; args: Record<string, unknown> }[] = [];

    const primingPayload = {
      handovers: [{ filename: "2026-06-01-session.md", form: "raw", body: "# Handover\n\n## Next\n- T-1: keep going\n" }],
      trajectory: [],
      skippedHandovers: 0,
      missingHandovers: 0,
    };
    const briefPayload = {
      handovers: [
        { filename: "2026-06-01-session.md", form: "structured", records: [], index: null },
      ],
      trajectory: [{ id: "T-1", occurrenceCount: 1, firstSeenInWindow: "2026-06-01-session.md", latest: "2026-06-01-session.md", latestDisposition: "continuation" }],
      skippedHandovers: 0,
      missingHandovers: 0,
    };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calledCalls.push({ name, args });
        const payload = args.priming ? primingPayload : briefPayload;
        pushJsonExchange(log, nextId, "tools/call", { name, arguments: args }, JSON.stringify({ version: 1, data: payload }));
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const result = await stepHandoverPrimingAndBrief(ctx);

    expect(calledCalls).toEqual([
      { name: "storybloq_handover_latest", args: { count: 1, priming: true, format: "json" } },
      { name: "storybloq_handover_latest", args: { count: 10, brief: true, format: "json" } },
    ]);
    expect(result.report.calls).toBe(2);
    expect(result.primingBody).toBe("# Handover\n\n## Next\n- T-1: keep going\n");
    expect(result.briefHandovers).toHaveLength(1);
    expect((result.trajectory as unknown[]).length).toBe(1);
  });

  it("reports a null primingBody when priming fell back to structured form (oversized handover)", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };

    const primingPayload = {
      handovers: [{ filename: "2026-06-01-session.md", form: "structured", records: [], index: null }],
      trajectory: [],
      skippedHandovers: 0,
      missingHandovers: 0,
    };
    const briefPayload = { handovers: [], trajectory: [], skippedHandovers: 0, missingHandovers: 0 };

    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        const payload = args.priming ? primingPayload : briefPayload;
        pushJsonExchange(log, nextId, "tools/call", { name, arguments: args }, JSON.stringify({ version: 1, data: payload }));
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const result = await stepHandoverPrimingAndBrief(ctx);
    expect(result.primingBody).toBeNull();
    expect((result.report as any).primingHadRawBody).toBe(false);
  });
});

describe("recoverHandoverEvidence (T-498 commit 2: 3-tier recovery)", () => {
  it("tier 1: recovers from an already-loaded raw body with zero extra calls", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async () => {
        throw new Error("tier 1 must cost zero calls -- handover_get must never fire when a raw body is already loaded");
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const rawBody = "# Handover\n\n## Next\n- T-5: an omitted actionable continuation\n\n## Blocked\n\n- T-6: blocked thing\n";
    const result = await recoverHandoverEvidence(ctx, "h.md", rawBody);

    expect(result.tier).toBe("raw-body");
    expect(result.report.calls).toBe(0);
    expect(result.records).not.toBeNull();
    expect(result.records!.some((r) => r.id === "T-5" && r.disposition === "continuation")).toBe(true);
  });

  it("tier 2: fires exactly one handover_get call only when no raw body was already loaded, and recovers records from it (Codex round 2/3 findings: request format:\"json\" explicitly -- storybloq_handover_get's Markdown text and its not_found error text are otherwise indistinguishable from real content -- and assert the requested format)", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    let calls = 0;
    const rawMarkdown = [
      "# Handover",
      "",
      "## Owner rulings",
      "",
      "- T-7: gated decision",
      "",
      "## Next",
      "",
      "- T-8: an omitted actionable continuation, recovered via tier 2",
      "",
    ].join("\n");
    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        calls++;
        expect(name).toBe("storybloq_handover_get");
        expect(args).toEqual({ filename: "h.md", format: "json" });
        // With format:"json" requested, formatHandoverContent's json branch
        // returns successEnvelope({filename, content}) -- the exact shape
        // recoverHandoverEvidence discriminates on.
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ version: 1, data: { filename: "h.md", content: rawMarkdown } }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const result = await recoverHandoverEvidence(ctx, "h.md", null);

    expect(calls).toBe(1);
    expect(result.tier).toBe("handover-get");
    expect(result.report.calls).toBe(1);
    expect(result.records).not.toBeNull();
    expect(result.records!.find((r) => r.id === "T-7")?.disposition).toBe("owner-gated");
    expect(result.records!.find((r) => r.id === "T-8")?.disposition).toBe("continuation");
  });

  it("tier 3: discloses failure (records: null) only when tier 2 itself fails (a rejected call), never as an early exit", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = {
      callTool: async () => {
        throw new Error("handover deleted or renamed");
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const result = await recoverHandoverEvidence(ctx, "h.md", null);

    expect(result.tier).toBe("disclosed");
    expect(result.records).toBeNull();
  });

  it("tier 3: also discloses failure when the client RESOLVES normally but the JSON envelope carries an infrastructure error (isError:true) (Codex round 2 finding: a tool-level error, unlike a rejected call, would otherwise be mis-parsed as recovered content)", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        // Mirrors runMcpReadTool's isError:true branch: the call resolves
        // (no throw), and with format:"json" requested even an infra error
        // renders as a {version, error} envelope, not plain text.
        const id = nextId.value++;
        log.push({ seq: log.length, direction: "client-to-server", message: { method: "tools/call", params: { name, arguments: args }, jsonrpc: "2.0", id } });
        log.push({
          seq: log.length,
          direction: "server-to-client",
          message: {
            result: {
              content: [{ type: "text", text: JSON.stringify({ version: 1, error: { code: "io_error", message: "Cannot read handover: EACCES" } }) }],
              isError: true,
            },
            jsonrpc: "2.0",
            id,
          },
        });
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const result = await recoverHandoverEvidence(ctx, "h.md", null);

    expect(result.tier).toBe("disclosed");
    expect(result.records).toBeNull();
    // The exchange genuinely happened (one real request+response pair) --
    // its cost is real even though it disclosed failure, same accounting
    // discipline as the rejected-call tier-3 path above.
    expect(result.report.calls).toBe(1);
  });

  it("tier 3: discloses failure for a genuinely missing handover -- not_found is a USER error (not in INFRASTRUCTURE_ERROR_CODES), so isError stays unset and only the {version, error} vs {version, data} envelope shape distinguishes it from real content (Codex round 3 finding)", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        // not_found is NOT an infrastructure error code, so runMcpReadTool's
        // isError:true branch never fires for it -- the call resolves as an
        // ordinary "successful" MCP response, isError absent, carrying the
        // handler's own error envelope as its text.
        pushJsonExchange(
          log,
          nextId,
          "tools/call",
          { name, arguments: args },
          JSON.stringify({ version: 1, error: { code: "not_found", message: "Handover not found: h.md" } }),
        );
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const result = await recoverHandoverEvidence(ctx, "h.md", null);

    expect(result.tier).toBe("disclosed");
    expect(result.records).toBeNull();
    expect(result.report.calls).toBe(1);
  });

  it("tier 3: a malformed response (not valid JSON) still discloses failure WITHOUT losing the exchange's already-measured cost (Codex round 4 finding: the completed call's bytes must not collapse to 0 just because parsing it failed afterward)", async () => {
    const log: CapturedMessage[] = [];
    const nextId = { value: 1 };
    const mockClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        // A genuinely malformed response (not the real server's shape at
        // all) -- the request+response exchange still completed and cost
        // real bytes, even though the text is not parseable JSON.
        pushJsonExchange(log, nextId, "tools/call", { name, arguments: args }, "not valid json {{{");
        return undefined;
      },
    };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const result = await recoverHandoverEvidence(ctx, "h.md", null);

    expect(result.tier).toBe("disclosed");
    expect(result.records).toBeNull();
    // The exchange genuinely completed -- its cost must be the measured
    // exchange bytes, not 0, even though parsing it afterward failed.
    expect(result.report.calls).toBe(1);
    expect(result.report.bytes).toBeGreaterThan(0);
  });

  it("returns EVERY disposition, not just continuation (the reconciliation consumer's own requirement)", async () => {
    const log: CapturedMessage[] = [];
    const mockClient = { callTool: async () => { throw new Error("unused"); } };
    const ctx: ReplayContext = {
      root: "/mock-root",
      client: mockClient as any,
      log,
      normalize: buildNormalizer("/mock-root"),
      gitLogMode: "fixture",
    };

    const rawBody = [
      "# Handover",
      "",
      "## Owner rulings",
      "",
      "- T-8: an owner-gated decision, not a continuation",
      "",
    ].join("\n");
    const result = await recoverHandoverEvidence(ctx, "h.md", rawBody);

    expect(result.records!.some((r) => r.disposition === "owner-gated")).toBe(true);
  });
});

describe("needsEvidenceRecovery (T-498 commit 2: two independent triggers)", () => {
  it("fires on a whole-handover index-only demotion", () => {
    expect(needsEvidenceRecovery({ indexOnly: true, omittedCount: 0, records: [] })).toBe(true);
  });

  it("fires on a nonzero per-handover omission count", () => {
    expect(needsEvidenceRecovery({ indexOnly: false, omittedCount: 1, records: [] })).toBe(true);
  });

  it("fires on a retained record whose rationale reads the literal \"unknown\" sentinel, even with no omission signal at all", () => {
    expect(
      needsEvidenceRecovery({
        indexOnly: false,
        omittedCount: 0,
        records: [{ rationale: "a real rationale" }, { rationale: "unknown" }],
      }),
    ).toBe(true);
  });

  it("does not fire when there is no omission and no retained \"unknown\" rationale", () => {
    expect(
      needsEvidenceRecovery({
        indexOnly: false,
        omittedCount: 0,
        records: [{ rationale: "a real rationale" }],
      }),
    ).toBe(false);
  });
});

// --- orchestrator gating (unit level; live-mode node_list step gate) -----------

describe("isOrchestratorConfig", () => {
  it("is false for a plain coding-project config, even one that happens to carry a nodes field", () => {
    expect(isOrchestratorConfig({ version: 2, project: "x", type: "coding" })).toBe(false);
    expect(isOrchestratorConfig({ type: "coding", nodes: { a: { path: "." } } })).toBe(false);
  });

  it("is true only when config.type is exactly 'orchestrator' -- the same gate project-loader.ts/tools.ts/recommend.ts use", () => {
    expect(isOrchestratorConfig({ type: "orchestrator" })).toBe(true);
  });

  it("is false for a non-object config", () => {
    expect(isOrchestratorConfig(null)).toBe(false);
    expect(isOrchestratorConfig(undefined)).toBe(false);
  });
});

// --- continuation section keyword (unit level: "blocked" is rendered, never promoted) ---

describe("findContinuationSection keyword", () => {
  it("reports keyword 'next' for a next-steps heading", () => {
    const body = ["# Handover", "", "## Next steps", "- T-1002", ""].join("\n");
    const section = findContinuationSection(body);
    expect(section?.keyword).toBe("next");
  });

  it("reports keyword 'blocked' for a blocked-items heading, even if it also names an actionable entity", () => {
    const body = ["# Handover", "", "## Blocked items", "- T-1002 is blocked pending review", ""].join("\n");
    const section = findContinuationSection(body);
    expect(section?.keyword).toBe("blocked");
  });

  it("reports keyword 'blocked' even when the SAME heading line also contains another actionable keyword", () => {
    // A greedy regex naively backtracks to the rightmost alternative match
    // ("remaining"), which would silently let a blocked section's entities
    // be promoted -- "blocked" must win regardless of word order.
    const body = ["# Handover", "", "## Blocked work remaining", "- T-1002", ""].join("\n");
    const section = findContinuationSection(body);
    expect(section?.keyword).toBe("blocked");
  });
});

// --- fixture replay (end-to-end, real child process) ---------------------------

describe("fixture replay", () => {
  let fixtureDir: string;
  let report: PrimingCostReport;

  beforeAll(async () => {
    fixtureDir = await copyFixture();
    const result = await runEmitJson(fixtureDir);
    report = result.report;
  }, 60_000);

  afterAll(async () => {
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  it("prints exactly one JSON object and nothing else on stdout", async () => {
    const { stdout } = await runEmitJson(fixtureDir);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("m1b: the full step-name inventory matches a fixed literal array declared here, in order", () => {
    // Declared independently of STEP_NAMES (not imported from the
    // implementation): a mutant that removes a step from both STEP_NAMES and
    // the report must still fail this check.
    expect(Object.keys(report.steps)).toEqual([
      "tool_discovery",
      "tool_discovery_reference",
      "session_guard",
      "reconciliation",
      "status",
      "recap",
      "handover_latest",
      "rules_md",
      "lesson_digest",
      "git_log",
      "recommend",
      "continuation_check",
      "trajectory",
      "context_column_lookup",
      "ready_to_work_table",
      "node_list",
    ]);
  });

  it("reports mode fixture and a complete (never observed_subtotal) total", () => {
    expect(report.mode).toBe("fixture");
    expect(report.totals.status).toBe("complete");
  });

  it("tool_discovery is modeled: zero calls, nonzero bytes, included in the total", () => {
    const step = report.steps.tool_discovery;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBeGreaterThan(0);
    expect(step.includedInTotal).toBe(true);
  });

  it("F2 guard: trajectory is a constructed, zero-call step with an exact pinned byte count on the standard fixture, included in the total", () => {
    const step = report.steps.trajectory;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBe(302);
    expect(step.includedInTotal).toBe(true);
  });

  it("tool_discovery_reference is a real call, excluded from the total", () => {
    const step = report.steps.tool_discovery_reference;
    expect(step.calls).toBe(1);
    expect(step.bytes).toBeGreaterThan(0);
    expect(step.includedInTotal).toBe(false);
  });

  it("session_guard: exactly one call", () => {
    expect(report.steps.session_guard.calls).toBe(1);
    expect(report.steps.session_guard.bytes).toBeGreaterThan(0);
    expect(report.steps.session_guard.bytes).toBeLessThan(5000);
  });

  it("reconciliation: zero calls, zero bytes, and the fingerprint comparison ran and matched", () => {
    const step = report.steps.reconciliation as any;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBe(0);
    expect(step.matched).toBe(true);
    expect(step.verdict).toBe("matched");
    expect(step.mismatchedIds).toEqual([]);
  });

  it("status: exactly one call", () => {
    expect(report.steps.status.calls).toBe(1);
    expect(report.steps.status.bytes).toBeGreaterThan(0);
    expect(report.steps.status.bytes).toBeLessThan(10_000);
  });

  it("recap: exactly one call", () => {
    expect(report.steps.recap.calls).toBe(1);
  });

  it("handover_latest: two calls (priming count:1 + brief count:10), additive, the newest handover's raw body loaded", () => {
    const step = report.steps.handover_latest as any;
    expect(step.calls).toBe(2);
    expect(step.primingHadRawBody).toBe(true);
    expect(step.primingBytes).toBeGreaterThan(0);
    expect(step.briefBytes).toBeGreaterThan(0);
    expect(step.primingBytes + step.briefBytes).toBe(step.bytes);
  });

  it("handover_latest: priming and brief bytes each stay within their own pinned ceiling", () => {
    const step = report.steps.handover_latest as any;
    if (step.primingBytes > 3000) {
      throw new Error(`handover_latest primingBytes ${step.primingBytes} exceeds its pinned 3000 ceiling`);
    }
    if (step.briefBytes > 5000) {
      throw new Error(`handover_latest briefBytes ${step.briefBytes} exceeds its pinned 5000 ceiling`);
    }
  });

  it("rules_md: zero calls, a direct read", () => {
    expect(report.steps.rules_md.calls).toBe(0);
    expect(report.steps.rules_md.bytes).toBeGreaterThan(0);
  });

  it("rules_md: bytes equal the raw UTF-8 byte length of the file on disk, with NO JSON-string-escaping overhead", async () => {
    // Reads RULES.md independently (a fresh fs.readFile, not through the
    // harness) so this catches a regression that routes direct-read bytes
    // through the JSON-message byte contract (measuredBytes) instead of the
    // raw-text one (measuredTextBytes) -- that would inflate the count by at
    // least the 2 wrapping-quote bytes, plus 1 byte per escaped newline.
    const rawContent = await readFile(join(fixtureDir, "RULES.md"), "utf-8");
    expect(report.steps.rules_md.bytes).toBe(byteLength(rawContent));
  });

  it("lesson_digest: exactly one call", () => {
    expect(report.steps.lesson_digest.calls).toBe(1);
  });

  it("git_log: zero calls, the fixed literal", () => {
    expect(report.steps.git_log.calls).toBe(0);
    expect(report.steps.git_log.bytes).toBeGreaterThan(0);
  });

  it("git_log: bytes equal the raw UTF-8 byte length of the fixed literal declared independently here", () => {
    const expectedText = [
      "9f258c50 fix(bus): ISS-1162 bind park byEndpoint to thread participants",
      "eb8765ed docs(story): pen restart checkpoint 2",
      "71dead0a docs(story): pen handover addendum",
      "2df7d1f9 docs(story): ISS-1177 implementation shipped",
      "2dbfcfcb fix(app): ISS-1177 release background project window view trees",
      "49a8b2c2 docs(story): file the /story priming efficiency plan",
      "a1b2c3d4 fix(core): tighten earmark staleness threshold validation",
      "b2c3d4e5 feat(cli): add storybloq reconcile --ci flag",
      "c3d4e5f6 test(bus): cover redeliver refusal on unverified predecessor",
      "d4e5f6a7 chore(release): bump package version",
    ].join("\n");
    expect(report.steps.git_log.bytes).toBe(byteLength(expectedText));
  });

  it("recommend: request carries count 10, zero issue_get calls, and exactly 2 of the 3 open issues are actionable", () => {
    const step = report.steps.recommend as any;
    expect(step.requestCarriesCountTen).toBe(true);
    // recommend()'s own partitionByActionability (ISS-1154) does the
    // excluding server-side now -- this step never walks issue_get at all.
    expect(step.issueGetCalls).toBe(0);
    expect(step.calls).toBe(1);
    // ISS-2001 (open, high, no marker) and ISS-2002 (open, medium, no marker)
    // clear; ISS-2003 (open, low, disposition owner_gated) lands in excluded.
    expect(step.actionableIssueCount).toBe(2);
    expect(step.excludedCount).toBe(1);
  });

  it("continuation_check: line one resolves T-1002 via the recommendations array with zero calls; reconciliation recovery costs the rest", () => {
    const step = report.steps.continuation_check as any;
    expect(step.lineOne.present).toBe(true);
    expect(step.lineOne.resolvedId).toBe("T-1002");
    expect(step.lineOne.calls).toBe(0);
    expect(step.resolvedCandidate.id).toBe("T-1002");
    // This 3-handover fixture has exactly 2 older handovers behind the
    // newest; one of them needs recovery (Commit 2's two independent
    // triggers), the other does not -- the combined step cost is entirely
    // reconciliation recovery's, since line one itself cost zero calls.
    expect(step.reconciliationRecovery.checkedCount).toBe(2);
    expect(step.reconciliationRecovery.recoveredCount).toBe(1);
    expect(step.calls).toBe(step.lineOne.calls + step.reconciliationRecovery.calls);
    expect(step.bytes).toBe(step.lineOne.bytes + step.reconciliationRecovery.bytes);
  });

  it("context_column_lookup: zero cost, n/a plus a diagnostic for every one of the 6 actionable candidates", () => {
    const step = report.steps.context_column_lookup as any;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBe(0);
    expect(step.rows).toHaveLength(6);
    for (const row of step.rows) {
      expect(row.context).toBe("n/a");
      expect(typeof row.diagnostic).toBe("string");
      expect(row.diagnostic.length).toBeGreaterThan(0);
    }
  });

  it("ready_to_work_table: zero calls, constructed text, and shows the (+1 more) suffix", () => {
    const step = report.steps.ready_to_work_table as any;
    expect(step.calls).toBe(0);
    expect(step.bytes).toBeGreaterThan(0);
    expect(step.rowsShown).toBe(5);
    expect(step.moreCount).toBe(1);
    expect(step.text).toContain("(+1 more)");
    // bytes must be the raw-text byte count of the table, not its
    // JSON-message-escaped size.
    expect(step.bytes).toBe(byteLength(step.text));
  });

  it("node_list: gated off (zero cost) for the fixture's non-orchestrator config", () => {
    const step = report.steps.node_list as any;
    expect(step.gated).toBe(true);
    expect(step.calls).toBe(0);
    expect(step.bytes).toBe(0);
  });

  it("totals: sum exactly the steps marked includedInTotal", () => {
    let expectedBytes = 0;
    let expectedCalls = 0;
    for (const name of STEP_NAMES) {
      const step = report.steps[name] as any;
      if (step.includedInTotal) {
        expectedBytes += step.bytes;
        expectedCalls += step.calls;
      }
    }
    expect(report.totals.bytes).toBe(expectedBytes);
    expect(report.totals.calls).toBe(expectedCalls);
  });

  it("meta.measuredRoot is normalized to the fixed placeholder regardless of the real root", () => {
    expect(report.meta.measuredRoot).toBe(FIXTURE_ROOT_PLACEHOLDER);
  });

  // --- m1a: raw-log-derived tool-call sequence (independent of the harness's own summary) ---

  it("m1a: the raw log's tools/call name sequence is exactly the fixed literal array", () => {
    const calls = report.rawLog
      .filter((e) => e.direction === "client-to-server")
      .map((e) => e.message as any)
      .filter((m) => m.method === "tools/call")
      .map((m) => m.params.name as string);

    // No issue_get/ticket_get calls: recommend's own JSON payload already
    // carries the actionability partition (Gate B) and T-1002's presence in
    // its recommendations array (the line-one walk), so ISS-1154 Commit B's
    // zero-call resolution still holds under T-498. `storybloq_handover_latest`
    // now fires twice (priming + brief, T-498 Commit 3's two-call Step 2);
    // the trailing `storybloq_handover_get` is decision 2's reconciliation
    // recovery for the one older handover that needs it.
    expect(calls).toEqual([
      "storybloq_session_guard",
      "storybloq_status",
      "storybloq_recap",
      "storybloq_handover_latest",
      "storybloq_handover_latest",
      "storybloq_lesson_digest",
      "storybloq_recommend",
      "storybloq_handover_get",
    ]);
  });

  // --- m2/m3 corroboration: recompute the recommend exchange's bytes directly from the raw log ---

  it("m2: the raw log carries exactly one storybloq_recommend exchange, matching the harness's own reported calls field", () => {
    const rawCount = report.rawLog.filter(
      (e) =>
        e.direction === "client-to-server" &&
        (e.message as any).method === "tools/call" &&
        (e.message as any).params?.name === "storybloq_recommend",
    ).length;
    expect(rawCount).toBe(1);
    expect((report.steps.recommend as any).calls).toBe(rawCount);
  });

  it("m3 corroboration: independently summing the raw log's recommend exchange matches the harness's own reported recommend.bytes, and its multibyte title survives as real UTF-8 bytes", () => {
    const entries = report.rawLog;
    const normalize = buildNormalizer(fixtureDir);

    function exchangeBytes(toolName: string): number {
      for (let i = 0; i < entries.length; i++) {
        const msg = entries[i]!.message as any;
        if (
          entries[i]!.direction === "client-to-server" &&
          msg.method === "tools/call" &&
          msg.params?.name === toolName
        ) {
          const res = entries.slice(i + 1).find(
            (e) => e.direction === "server-to-client" && (e.message as any).id === msg.id,
          );
          if (!res) continue;
          // Buffer.byteLength directly -- NOT the imported byteLength -- so a
          // mutation of the harness's own byteLength helper cannot silently
          // move both sides of this comparison together.
          return (
            Buffer.byteLength(JSON.stringify(normalize(msg)), "utf8") +
            Buffer.byteLength(JSON.stringify(normalize(res.message)), "utf8")
          );
        }
      }
      throw new Error(`exchangeBytes: no ${toolName} exchange found`);
    }

    const recommendBytes = exchangeBytes("storybloq_recommend");
    expect(recommendBytes).toBe((report.steps.recommend as any).bytes);

    // Corroborates the multibyte title specifically: ISS-2002's title
    // ("café, señor, 🎉") now travels inside the single recommend JSON
    // payload itself. A UTF-16-length-based (buggy) measurement of that
    // payload would be strictly smaller than its true UTF-8 byte count.
    let rawText = "";
    for (const e of entries) {
      const msg = e.message as any;
      if (e.direction === "server-to-client" && typeof msg.result?.content?.[0]?.text === "string") {
        if (msg.result.content[0].text.includes("café")) {
          rawText = msg.result.content[0].text;
          break;
        }
      }
    }
    expect(rawText).not.toBe("");
    expect(byteLength(rawText)).toBeGreaterThan(rawText.length);
  });

  // Pinned per-step byte ceilings and exact call counts (T-497's own stated
  // deliverable). Ceilings carry headroom above the observed value so a
  // small, legitimate future content change doesn't flap the gate; call
  // counts are exact since they are deterministic on this frozen corpus.
  // tool_discovery_reference is excluded: it is informational
  // (includedInTotal: false) and its size tracks the live tool count, not
  // this ticket's corpus.
  const STEP_CEILINGS: Record<string, { maxBytes: number; calls: number }> = {
    tool_discovery: { maxBytes: 3000, calls: 0 },
    session_guard: { maxBytes: 1500, calls: 1 },
    reconciliation: { maxBytes: 0, calls: 0 },
    status: { maxBytes: 6000, calls: 1 },
    recap: { maxBytes: 2500, calls: 1 },
    handover_latest: { maxBytes: 7000, calls: 2 },
    rules_md: { maxBytes: 600, calls: 0 },
    lesson_digest: { maxBytes: 500, calls: 1 },
    git_log: { maxBytes: 900, calls: 0 },
    recommend: { maxBytes: 4000, calls: 1 },
    continuation_check: { maxBytes: 2000, calls: 1 },
    trajectory: { maxBytes: 500, calls: 0 },
    context_column_lookup: { maxBytes: 0, calls: 0 },
    ready_to_work_table: { maxBytes: 1500, calls: 0 },
    node_list: { maxBytes: 0, calls: 0 },
  };

  it("every counted step stays within its pinned byte ceiling and exact call count", () => {
    const failures: string[] = [];
    const table: string[] = [];
    for (const [name, ceiling] of Object.entries(STEP_CEILINGS)) {
      const step = (report.steps as any)[name];
      table.push(
        `${name}: bytes=${step.bytes} (ceiling ${ceiling.maxBytes}), calls=${step.calls} (expected ${ceiling.calls})`,
      );
      if (step.bytes > ceiling.maxBytes) {
        failures.push(`${name}: bytes ${step.bytes} exceeds ceiling ${ceiling.maxBytes}`);
      }
      if (step.calls !== ceiling.calls) {
        failures.push(`${name}: calls ${step.calls} !== expected ${ceiling.calls}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`${failures.join("\n")}\n\nFull measurement table:\n${table.join("\n")}`);
    }
  });

  it("total bytes stay within a pinned ceiling and total calls equal exactly 8", () => {
    expect(report.totals.calls).toBe(8);
    // 20,075 measured at the 1.15 release gate (2026-09-15) with every step
    // inside its own ceiling; the sum crossed 20,000 by 75 bytes. Pinned at
    // 20,500 so the next growth still fails here rather than going unseen.
    // T-522 commit 2b (2026-09-22): 20,579 measured, the tool_discovery step
    // carrying the 14 tool names T-523, T-524 and T-522 added since 1.15;
    // every step still inside its own ceiling. Pinned at 21,000, same rule.
    // ISS-1107: 20,983 -> 21,089. The whole growth is the status step (3,540
    // -> 3,646): non-compact status JSON now carries boardUncommitted
    // {available:false, reason:"not a repository"} on this non-git fixture.
    // Compact status, which the skill's Step 3 uses, is unchanged. Pinned at
    // 21,500, same rule.
    if (report.totals.bytes > 21_500) {
      throw new Error(
        `totals.bytes ${report.totals.bytes} exceeds the pinned 20000 ceiling; ` +
          `per-step: ${JSON.stringify(
            Object.fromEntries(Object.entries(report.steps).map(([k, v]: [string, any]) => [k, v.bytes])),
          )}`,
      );
    }
  });
});

// --- continuation walk suppresses promotion for a blocked-keyword heading (end-to-end) ---

describe("continuation walk suppresses promotion for a blocked-keyword heading", () => {
  it("renders the blocked section but performs zero walk calls and resolves nothing", async () => {
    const dir = await copyFixture();
    try {
      // A newer handover (dated after the existing 3) whose only actionable-
      // heading match is "blocked", naming T-1002 -- independently known
      // actionable via the main fixture replay above. Promotion must not
      // happen even though T-1002 itself would clear the actionability bar.
      await writeFile(
        join(dir, ".story", "handovers", "2026-09-05-blocked-check.md"),
        [
          "SENTINEL-D-blocked-check",
          "# Session Handover - Blocked Check",
          "",
          "**Date:** 2026-09-05",
          "",
          "## Blocked items",
          "- T-1002 is mentioned here but this section describes BLOCKED work, not a promotion target.",
          "",
          "## Notes",
          "- nothing else.",
        ].join("\n"),
        "utf-8",
      );

      const { report } = await runEmitJson(dir);
      const step = report.steps.continuation_check as any;
      // A "blocked"-disposition record is never a continuation candidate at
      // all (design decision 1's `selectContinuationCandidates` is
      // continuation-disposition-only) -- line one sees an empty candidate
      // list and falls back silently, at zero cost, even though T-1002
      // itself would otherwise clear the actionability bar.
      expect(step.lineOne.present).toBe(true);
      expect(step.lineOne.resolvedId).toBeNull();
      expect(step.lineOne.calls).toBe(0);
      expect(step.resolvedCandidate).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// --- m4 end-to-end: two different-length fixture roots, identical reported bytes -----------

// m4 (compute bytes before normalization) is INERT on this fixture: no real
// step response embeds the fixture root for a clean, guard-free (zero
// session) corpus -- see the file-level comment above for the full 3-step
// check the pen asked for. This test remains a genuine structural-equality
// regression check (reported counts must not depend on incidental root
// length even where nothing here currently leaks it) but is not claimed as
// an m4 mutant kill; `buildNormalizer`'s own unit tests above are the actual
// correctness proof for the normalization logic.
describe("temp-root length independence (structural equality check; m4 is inert on this corpus)", () => {
  it("reported per-step byte counts and totals are identical across differently-sized fixture roots", async () => {
    const shortParent = await mkdtemp(join(tmpdir(), "pc-s-"));
    const longParentBase = await mkdtemp(join(tmpdir(), "pc-l-"));
    const longParent = join(
      longParentBase,
      "a-deliberately-much-longer-nested-directory-segment-to-change-the-root-length",
    );
    await mkdir(longParent, { recursive: true });

    const shortDir = await copyFixture(join(shortParent, "fx"));
    const longDir = await copyFixture(join(longParent, "fx"));
    await mkdir(shortDir, { recursive: true }).catch(() => {});

    try {
      const [a, b] = await Promise.all([runEmitJson(shortDir), runEmitJson(longDir)]);
      expect(shortDir.length).not.toBe(longDir.length);

      for (const name of STEP_NAMES) {
        expect(a.report.steps[name].bytes).toBe(b.report.steps[name].bytes);
        expect(a.report.steps[name].calls).toBe(b.report.steps[name].calls);
      }
      expect(a.report.totals.bytes).toBe(b.report.totals.bytes);
      expect(a.report.totals.calls).toBe(b.report.totals.calls);
      expect(a.report.meta.measuredRoot).toBe(b.report.meta.measuredRoot);
    } finally {
      await rm(shortParent, { recursive: true, force: true });
      await rm(longParentBase, { recursive: true, force: true });
    }
  }, 60_000);
});

// --- byte-identical-across-two-runs (full normalized transcript) ---------------------------

function buildNormalizedTranscript(report: PrimingCostReport, root: string): string {
  const normalize = buildNormalizer(root);
  const transcript: unknown[] = [];
  for (const entry of report.rawLog) {
    transcript.push(normalize(entry.message));
  }
  transcript.push(normalize({ measuredRoot: report.meta.measuredRoot }));
  // Content-bearing steps that are NOT reflected in rawLog at all (direct
  // reads, fixed literals, modeled/synthetic requests, constructed text) --
  // the transcript must cover them too, or an equal-length content swap in
  // any of them would change nothing this hash can see.
  const discovery = report.steps.tool_discovery as any;
  const rulesMd = report.steps.rules_md as any;
  const gitLog = report.steps.git_log as any;
  const continuation = report.steps.continuation_check as any;
  const readyTable = report.steps.ready_to_work_table as any;
  transcript.push(normalize({ modeledDiscoveryRequest: discovery.modeledRequest ?? null }));
  transcript.push(normalize({ modeledDiscoveryResponse: discovery.modeledResponse ?? null }));
  transcript.push(normalize({ rulesMdContent: rulesMd.content ?? null }));
  transcript.push(normalize({ gitLogContent: gitLog.content ?? null }));
  transcript.push(normalize({ continuationConstructedText: continuation.constructedText ?? null }));
  transcript.push(normalize({ readyToWorkTableText: readyTable.text ?? null }));
  return JSON.stringify(transcript);
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

describe("determinism: two runs against fresh fixture copies are byte-identical", () => {
  it("produces an identical complete normalized transcript across two independent runs", async () => {
    const dirA = await copyFixture();
    const dirB = await copyFixture();
    try {
      const [a, b] = await Promise.all([runEmitJson(dirA), runEmitJson(dirB)]);
      const transcriptA = buildNormalizedTranscript(a.report, dirA);
      const transcriptB = buildNormalizedTranscript(b.report, dirB);
      expect(sha256(transcriptA)).toBe(sha256(transcriptB));

      for (const name of STEP_NAMES) {
        expect(a.report.steps[name].bytes).toBe(b.report.steps[name].bytes);
      }
      expect(a.report.totals.bytes).toBe(b.report.totals.bytes);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  }, 60_000);

  it("an equal-length content change in a constructed/direct-read step changes the transcript hash", () => {
    const root = "/tmp/whatever-root";
    const makeReport = (rulesMdContent: string): PrimingCostReport => ({
      mode: "fixture",
      meta: { measuredRoot: FIXTURE_ROOT_PLACEHOLDER, generatedAt: "x" },
      steps: {
        tool_discovery: { bytes: 0, calls: 0, includedInTotal: true, modeledRequest: {}, modeledResponse: {} },
        tool_discovery_reference: { bytes: 0, calls: 0, includedInTotal: false },
        session_guard: { bytes: 0, calls: 0, includedInTotal: true },
        reconciliation: { bytes: 0, calls: 0, includedInTotal: true },
        status: { bytes: 0, calls: 0, includedInTotal: true },
        recap: { bytes: 0, calls: 0, includedInTotal: true },
        handover_latest: { bytes: 0, calls: 0, includedInTotal: true },
        rules_md: { bytes: 0, calls: 0, includedInTotal: true, content: rulesMdContent },
        lesson_digest: { bytes: 0, calls: 0, includedInTotal: true },
        git_log: { bytes: 0, calls: 0, includedInTotal: true, content: "x" },
        recommend: { bytes: 0, calls: 0, includedInTotal: true },
        continuation_check: { bytes: 0, calls: 0, includedInTotal: true, constructedText: "x" },
        context_column_lookup: { bytes: 0, calls: 0, includedInTotal: true },
        ready_to_work_table: { bytes: 0, calls: 0, includedInTotal: true, text: "x" },
        node_list: { bytes: 0, calls: 0, includedInTotal: true },
      } as any,
      totals: { bytes: 0, calls: 0, status: "complete" },
      rawLog: [],
    });

    const transcriptA = buildNormalizedTranscript(makeReport("AAAA"), root);
    const transcriptB = buildNormalizedTranscript(makeReport("BBBB"), root); // same length, different content
    expect(transcriptA).not.toBe(transcriptB);
    expect(sha256(transcriptA)).not.toBe(sha256(transcriptB));
  });
});

// --- live mode: genuinely-empty recommend result vs. a synthetic parse failure ------
//
// storybloq_recommend's real output space is closed: reading
// formatRecommendations's source shows it is always either the numbered-list
// shape or one of 3 fixed "no recommendations" strings -- there is no way to
// coax the real tool into returning a THIRD shape that would make
// deriveRecommendRows report parseFailed:true. So the "retain captured bytes
// on parse failure" behaviour is proven at the unit level, directly against
// buildFailedRecommendReport with a synthetic measurement, where the failure
// path is actually reachable; the end-to-end test below instead exercises
// the real, reachable case: a live project with zero real candidates.

describe("live mode: zero real candidates (well-formed, not a parse failure)", () => {
  it("reports totals.status complete, recommend still transmitted, and zero issue_get calls when the project has no tickets or issues", async () => {
    const liveDir = await mkdtemp(join(tmpdir(), "pc-live-"));
    try {
      await cp(FIXTURE_SRC, liveDir, { recursive: true });
      // The real ledger lives under .story/, not at the project root.
      await rm(join(liveDir, ".story", "tickets"), { recursive: true, force: true });
      await rm(join(liveDir, ".story", "issues"), { recursive: true, force: true });
      await mkdir(join(liveDir, ".story", "tickets"));
      await mkdir(join(liveDir, ".story", "issues"));

      const { env, cleanup } = await makeIsolatedEnv();
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, SCRIPT_PATH, "--live", liveDir],
          { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
        );
        const report: PrimingCostReport = JSON.parse(stdout);

        // A zero-candidate result is a legitimate, well-formed response (one
        // of the 3 known "no recommendations" strings), never a parse
        // failure -- recommend itself is never marked incomplete (this
        // fixture copy has no .git directory, so totals.status can still be
        // "observed_subtotal" for the unrelated git_log step; that is not
        // what this test is about).
        expect((report.steps.recommend as any).status).toBeUndefined();
        expect(report.steps.recommend.calls).toBe(1);
        expect(report.steps.recommend.bytes).toBeGreaterThan(0);
        expect((report.steps.recommend as any).issueGetCalls).toBe(0);
        expect((report.steps.recommend as any).actionableIssueCount).toBe(0);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(liveDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("live mode meta: commit, dirty state, session inventory, installed-skill hash, orchestrator flag", () => {
  it("reports a real commit hash, dirty=false, an empty session inventory, and orchestrator=false for a clean non-orchestrator project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-live-meta-"));
    try {
      await cp(FIXTURE_SRC, dir, { recursive: true });
      const { env, cleanup } = await makeIsolatedEnv();
      try {
        await execFileAsync("git", ["init", "-q"], { cwd: dir, env });
        await execFileAsync("git", ["add", "-A"], { cwd: dir, env });
        await execFileAsync(
          "git",
          ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"],
          { cwd: dir, env },
        );

        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, SCRIPT_PATH, "--live", dir],
          { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
        );
        const report: PrimingCostReport = JSON.parse(stdout);

        expect(typeof report.meta.commit).toBe("string");
        expect(report.meta.commit).toHaveLength(40);
        expect(report.meta.dirty).toBe(false);
        expect(report.meta.orchestrator).toBe(false);
        expect(report.meta.sessionInventory).toEqual({ count: 0, ids: [] });
        expect(
          report.meta.installedSkillHash === null || typeof report.meta.installedSkillHash === "string",
        ).toBe(true);
        expect((report.steps.node_list as any).gated).toBe(true);
        expect(report.steps.node_list.calls).toBe(0);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports dirty=true when the live project has an uncommitted change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-live-dirty-"));
    try {
      await cp(FIXTURE_SRC, dir, { recursive: true });
      const { env, cleanup } = await makeIsolatedEnv();
      try {
        await execFileAsync("git", ["init", "-q"], { cwd: dir, env });
        await execFileAsync("git", ["add", "-A"], { cwd: dir, env });
        await execFileAsync(
          "git",
          ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"],
          { cwd: dir, env },
        );
        await writeFile(join(dir, "RULES.md"), "changed\n", "utf-8");

        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, SCRIPT_PATH, "--live", dir],
          { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
        );
        const report: PrimingCostReport = JSON.parse(stdout);
        expect(report.meta.dirty).toBe(true);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports orchestrator=true and does not gate off node_list when config.type is 'orchestrator'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-live-orch-"));
    try {
      await cp(FIXTURE_SRC, dir, { recursive: true });
      const configPath = join(dir, ".story", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf-8"));
      config.type = "orchestrator";
      config.nodes = { root: { path: ".", role: "orchestrator root" } };
      await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

      const { env, cleanup } = await makeIsolatedEnv();
      try {
        const { stdout } = await execFileAsync(
          process.execPath,
          [TSX_CLI, SCRIPT_PATH, "--live", dir],
          { cwd: STORYBLOQ_ROOT, env, maxBuffer: 32 * 1024 * 1024 },
        );
        const report: PrimingCostReport = JSON.parse(stdout);
        expect(report.meta.orchestrator).toBe(true);
        expect((report.steps.node_list as any).gated).toBe(false);
        expect(report.steps.node_list.calls).toBe(1);
      } finally {
        await cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("buildCrashReport (unit level: the live tools already degrade gracefully in every real scenario tried, so this safety net's own end-to-end trigger could not be reproduced against the real MCP server -- proven directly instead, honestly, rather than claiming an unreproduced end-to-end kill)", () => {
  it("produces a minimally-shaped, fully-incomplete report that never throws when serialized", () => {
    const report = buildCrashReport("/some/root", new Error("boom"));
    expect(report.mode).toBe("live");
    expect(report.totals.status).toBe("observed_subtotal");
    expect(report.totals.bytes).toBe(0);
    expect(report.totals.calls).toBe(0);
    expect(Object.keys(report.steps)).toEqual([...STEP_NAMES]);
    for (const name of STEP_NAMES) {
      const step = report.steps[name] as any;
      expect(step.status).toBe("incomplete");
      expect(step.reason).toContain("boom");
    }
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});

describe("buildFailedRecommendReport (unit level: the real tool cannot produce this shape, so this is the only place the retention behaviour is reachable)", () => {
  it("retains the synthetic measurement's exact bytes and call count, and reports status incomplete", () => {
    const measurement: ExchangeMeasurement = {
      requestBytes: 40,
      responseBytes: 123,
      totalBytes: 163,
      calls: 1,
      rawRequest: { params: { arguments: { count: 10 } } },
      rawResponse: {},
    };
    const report = buildFailedRecommendReport(measurement, "response matched neither known shape");
    expect(report.bytes).toBe(163);
    expect(report.calls).toBe(1);
    expect(report.includedInTotal).toBe(true);
    expect(report.status).toBe("incomplete");
    expect(report.issueGetCalls).toBe(0);
    expect(report.actionableIssueCount).toBe(0);
    expect(report.requestCarriesCountTen).toBe(true);
  });
});
