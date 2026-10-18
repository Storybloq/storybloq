import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Test seam: report the Nth presence write of a test as lock-busy without running its callback. */
const inject: { busyOnCall: number | null; calls: number } = { busyOnCall: null, calls: 0 };
vi.mock("../../src/core/presence-enrichment.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/presence-enrichment.js")>();
  const wrapped: typeof mod.applyPresenceEnrichment = (root, sessionId, budgetMs, source, mutate, now) => {
    if (source === "session-intel") {
      inject.calls++;
      if (inject.busyOnCall === inject.calls) { inject.busyOnCall = null; return { status: "skipped-lock-busy" }; }
    }
    return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, mutate, now);
  };
  return { ...mod, applyPresenceEnrichment: wrapped };
});
import { sampleSession } from "../../src/core/session-intel/query.js";
import { PENDING_SUBDIR, markCompactPending, readPresenceRecord, stampHandover, worktreeDiscoveryStats } from "../../src/core/session-intel/presence-bridge.js";
import { presenceFileBase } from "../../src/presence/types.js";
import { readLedger } from "../../src/core/session-intel/boundary-ledger.js";
import { resetLedgerRoutingCache } from "../../src/core/session-intel/ledger-root.js";
import { createEraIfAbsent } from "../../src/core/session-intel/era-store.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../../src/core/presence-enrichment.js";
import { emptySessionIntel } from "../../src/presence/session-intel-fields.js";
import { handleSessionIntel, formatSessionIntelMd } from "../../src/cli/commands/session-intel.js";
import { SID, assistantRecord, boundaryRecord, growingSession, makeWorktreePair, writeTranscript } from "./session-intel-fixtures.js";

const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

interface Fx { base: string; root: string; projects: string; userSettings: string }

function withFixture(fn: (f: Fx) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "si-query-")));
  try {
    const root = join(base, "proj");
    mkdirSync(join(root, ".story"), { recursive: true });
    writeFileSync(join(root, ".story", "config.json"), "{}\n"); // what project-root discovery looks for
    const projects = join(base, "home", ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    const userSettings = join(base, "home", ".claude", "settings.json");
    fn({ base, root, projects, userSettings });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const saved = { ...process.env };
beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  process.env.CLAUDE_PID = String(process.pid);
  delete process.env.STORYBLOQ_CLIENT;
  processEra.reset();
});
afterEach(() => {
  for (const k of ["CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "STORYBLOQ_CLIENT"]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  processEra.reset();
});

function bindCaller(root: string, window = 450_000): string {
  const era = processEra.current()!.id;
  const entry = { era, pid: process.pid, startedAt: processEra.current()!.startedAt, captureKind: "startup" as const, autoCompactWindowAtStart: window, autoCompactWindowSource: "user" as const, capturedAt: at(-30), endedAt: null, lastVerifiedAt: at(-30), unverifiableStreak: 0, sessionIds: [SID] };
  expect(createEraIfAbsent(root, entry)).toBe("created");
  applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...emptySessionIntel(), era, captureKind: "startup", autoCompactWindowAtStart: window, capturedAt: at(-30) } }));
  return era;
}

const encoded = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");

describe("sampleSession", () => {
  it("bound caller: measures 266,711 against the captured setting, persists, and stamps boundaries inside the era", () => {
    withFixture((f) => {
      const era = bindCaller(f.root);
      const lines = [...growingSession(2, 100_000, 5_000), boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), input: 2, creation: 0, read: 266_709 })];
      writeTranscript(f.projects, encoded(f.root), SID, lines);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(r.binding).toBe("bound");
      expect(r.pressure?.contextTokens).toBe(266_711);
      expect(r.pressure?.ceiling).toMatchObject({ source: "setting", confidence: "high", ceiling: 0.925 * 450_000 });
      expect(r.pressure?.pct).toBeCloseTo(266_711 / 416_250, 4);
      expect(r.pressure?.state).toBe("ok");
      expect(r.usable).toBe(true);
      expect(r.presence).toBe("persisted");
      const intel = readPresenceRecord(f.root, SID)!.sessionIntel!;
      expect(intel.lastSample?.contextTokens).toBe(266_711);
      expect(intel.lastBoundaryAt).toBe(at(1));
      expect(intel.transcriptPath).toMatch(new RegExp(`${SID}\\.jsonl$`));
      const ledger = readLedger(f.root);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ sessionId: SID, era, captureKind: "startup", autoCompactWindowAtStart: 450_000, preTokens: 417_000 });
      // Second call: the ledger now measures the session.
      const r2 = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 6 * 60_000 });
      expect(r2.pressure?.ceiling.source).toBe("measured-session");
      expect(r2.pressure?.ceiling.ceiling).toBe(417_000);
    });
  });

  it("a boundary outside the era's proven interval is recorded unclassified and never measured", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(-60), pre: 300_000 }), assistantRecord({ ts: at(0), read: 10 })]);
      sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 });
      expect(readLedger(f.root)[0]).toMatchObject({ era: null, captureKind: null, autoCompactWindowAtStart: null });
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 });
      expect(r.pressure?.ceiling.source).toBe("setting");
    });
  });

  it("explicit --session-id is read-only: same ceiling as the bound query, nothing persisted, nothing ingested", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 100_000 })]);
      const ro = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", sessionId: SID, projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(ro.binding).toBe("read-only");
      expect(ro.presence).toBe("skipped");
      expect(readLedger(f.root)).toEqual([]);
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastSample).toBeNull();
      const bound = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(ro.pressure?.ceiling.ceiling).toBe(bound.pressure?.ceiling.ceiling);
      expect(ro.pressure?.ceiling.source).toBe("setting");
    });
  });

  it("no project: transcript-only reads never substitute current settings for missing startup evidence", () => {
    withFixture((f) => {
      const cwd = join(f.base, "nostory");
      mkdirSync(cwd);
      writeTranscript(f.projects, encoded(cwd), SID, [assistantRecord({ ts: at(0), read: 50_000 })]);
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 400_000 }));
      const r = sampleSession({ root: null, cwd, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r).toMatchObject({ binding: "read-only", presence: "no-project", usable: false });
      expect(r.pressure?.ceiling).toMatchObject({ source: "unknown", confidence: null, ceiling: null });
      expect(r.pressure?.ceiling.basis).toMatch(/session-start.*not captured/);
      rmSync(f.userSettings);
      const m = sampleSession({ root: null, cwd, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(m.pressure?.ceiling).toMatchObject({ source: "unknown", ceiling: null });
      expect(m.pressure?.state).toBe("unknown");
    });
  });

  it("codex client short-circuits to unknown before any file access; missing transcript is not_found", () => {
    withFixture((f) => {
      process.env.STORYBLOQ_CLIENT = "codex";
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects });
      expect(r).toMatchObject({ client: "codex", usable: false, pressure: null });
      delete process.env.STORYBLOQ_CLIENT;
      const nf = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects });
      expect(nf.unusableReason).toMatch(/not found/);
    });
  });

  it("ISS-1224: an explicit transcript refused by the access contract names the rule that failed, never the path outside the root", () => {
    withFixture((f) => {
      // Rule 1: a readable file OUTSIDE ~/.claude/projects/<dir>/. The path
      // must not be echoed: it is exactly the value the contract refused.
      const outside = join(f.base, `${SID}.jsonl`);
      writeFileSync(outside, assistantRecord({ ts: at(0), read: 10 }) + "\n");
      const r1 = sampleSession({ root: null, cwd: f.base, sampledBy: "query", transcriptPath: outside, sessionId: SID, projectsDir: f.projects });
      expect(r1.usable).toBe(false);
      expect(r1.transcriptPath).toBeNull();
      expect(r1.unusableReason).toBe("transcript refused: it is not exactly one directory below the Claude projects directory (~/.claude/projects/<project>/<sessionId>.jsonl, or under $CLAUDE_CONFIG_DIR/projects when set)");
      expect(r1.unusableReason).not.toContain(f.base);

      // Rule 2: inside the root, but the basename is not the session id.
      const inside = writeTranscript(f.projects, encoded(f.base), "other-session", [assistantRecord({ ts: at(0), read: 10 })]);
      const r2 = sampleSession({ root: null, cwd: f.base, sampledBy: "query", transcriptPath: inside, sessionId: SID, projectsDir: f.projects });
      expect(r2.usable).toBe(false);
      expect(r2.unusableReason).toBe(`transcript refused: its basename is not ${SID}.jsonl`);

      // Rule 3: no session id given and none derivable from the basename.
      const unnamed = join(f.base, "notes.txt");
      writeFileSync(unnamed, "{}\n");
      const r3 = sampleSession({ root: null, cwd: f.base, sampledBy: "query", transcriptPath: unnamed, projectsDir: f.projects });
      expect(r3.usable).toBe(false);
      expect(r3.unusableReason).toBe("transcript refused: no session id given; pass --session-id or name the file <sessionId>.jsonl");
      expect(r3.unusableReason).not.toContain(f.base);

      // The located (no explicit path) failure keeps its original wording.
      const nf = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects });
      expect(nf.unusableReason).toBe("transcript not found or not authorized");
    });
  });

  it("unbound caller (no record) still answers read-only from the live setting, reported as unbound", () => {
    withFixture((f) => {
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 10 })]);
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.binding).toBe("read-only");
      expect(r.bindingReason).toMatch(/no presence record/);
      expect(r.pressure?.ceiling.basis).toMatch(/session-start.*not captured/);
      expect(r.presence).toBe("skipped");
    });
  });

  it("--caller-model mismatch is reported, never overridden; --full within budget is full and persists", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, growingSession(3000, 1_000, 100));
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", callerModel: "claude-sonnet-5", projectsDir: f.projects, now: T0 });
      expect(r.callerModelMismatch).toEqual({ caller: "claude-sonnet-5", transcript: "claude-opus-5" });
      expect(r.pressure?.lastAssistantModel).toBe("claude-opus-5");
      expect(sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", callerModel: "claude-opus-5", projectsDir: f.projects, now: T0 }).callerModelMismatch).toBeNull();
      const full = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", full: true, projectsDir: f.projects, now: T0 });
      expect(full.coverage).toBe("full");
      expect(full.session?.startedAt).toBe(at(0));
      expect(full.presence).toBe("persisted");
    });
  });

  it("--full over budget is partial, non-authoritative, never persists and never ingests", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), ...growingSession(3000, 1_000, 100)]);
      const partial = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", full: true, fullBudgetBytes: 64 * 1024, projectsDir: f.projects, now: T0 });
      expect(partial.coverage).toBe("partial");
      expect(partial.truncationReason).toMatch(/only the last/);
      expect(partial.pressure?.observation.authoritative).toBe(false);
      expect(partial.session?.startedAt).toBeNull();
      expect(partial.presence).toBe("skipped");
      expect(partial.presenceReason).toMatch(/partial scan never persists/);
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastSample).toBeNull();
      expect(readLedger(f.root)).toEqual([]);
    });
  });

  it("a pending compaction of the caller's era makes pressure unusable and persists nothing; null-era and foreign-era files neither block nor reset", () => {
    withFixture((f) => {
      const era = bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 10 })]);
      const dir = join(f.root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      markCompactPending(f.root, SID, { eventId: "n", era: null, at: at(1) });
      markCompactPending(f.root, SID, { eventId: "f", era: "7:7", at: at(-100) });
      const before = readPresenceRecord(f.root, SID)!.sessionIntel!;
      const ok = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 2 * 60_000 });
      expect(ok.usable).toBe(true);
      expect(ok.presence).toBe("persisted");
      expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
      const afterIntel = readPresenceRecord(f.root, SID)!.sessionIntel!;
      expect(afterIntel.revision).toBe(before.revision);
      expect(afterIntel.epoch).toEqual(before.epoch);
      markCompactPending(f.root, SID, { eventId: "e", era, at: at(3) });
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 4 * 60_000 });
      expect(r.usable).toBe(false);
      expect(r.unusableReason).toMatch(/pending/);
      expect(r.presence).toBe("skipped");
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastSample).toEqual(afterIntel.lastSample);
    });
  });

  it("read-only and bound queries agree after a new boundary: a pre-compaction handover suppresses neither, and nothing is written by the read-only one", () => {
    withFixture((f) => {
      const era = bindCaller(f.root);
      const tokens = 416_250 - 60_000;
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: tokens })]);
      expect(sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 }).pressure?.state).toBe("imperative");
      expect(stampHandover(f.root, SID, era, tokens, T0).status).toBe("written");
      expect(sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 60_000 }).pressure).toMatchObject({ state: "advisory", suppressedBy: "handover" });
      // Compaction, then the context climbs back to the same level.
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: tokens }), boundaryRecord({ ts: at(2), pre: tokens }), assistantRecord({ ts: at(3), read: tokens })]);
      const recordBefore = readPresenceRecord(f.root, SID)!;
      const ro = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", sessionId: SID, projectsDir: f.projects, now: T0 + 4 * 60_000 });
      expect(ro.binding).toBe("read-only");
      expect(ro.pressure).toMatchObject({ state: "imperative", suppressedBy: null });
      expect(readPresenceRecord(f.root, SID)).toEqual(recordBefore);
      const bound = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 4 * 60_000 });
      expect(bound.pressure).toMatchObject({ state: "imperative", suppressedBy: null });
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastBoundaryAt).toBe(at(2));
    });
  });

  it("a lock-busy persist skip is unvalidated: not usable, nothing ingested; the next call persists and ingests", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 10 })]);
      // Call 1 is reconciliation (runs), call 2 is the persist (lock busy: none of its checks ran).
      inject.calls = 0;
      inject.busyOnCall = 2;
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(r.presence).toBe("skipped");
      expect(r.presenceReason).toMatch(/lock-busy/);
      expect(r.usable).toBe(false);
      expect(r.unusableReason).toMatch(/unvalidated/);
      expect(readLedger(f.root)).toEqual([]);
      expect(readPresenceRecord(f.root, SID)!.sessionIntel!.lastSample).toBeNull();
      inject.busyOnCall = null;
      const ok = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 6 * 60_000 });
      expect(ok.presence).toBe("persisted");
      expect(readLedger(f.root)).toHaveLength(1);
    });
  });

  it("a sample the persistence rule rejects is neither reported usable nor ingested into the ledger", () => {
    withFixture((f) => {
      bindCaller(f.root);
      const path = writeTranscript(f.projects, encoded(f.root), SID, [boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 10 })]);
      const st = statSync(path);
      // The record claims to have consumed far more of THIS incarnation than exists: baseline broken.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, incarnation: `${st.dev}:${st.ino}`, consumedOffset: st.size + 10_000, baselineAnchor: { offset: st.size + 10_000, sha256: "0".repeat(64) } } }));
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(r.presence).toBe("rejected");
      expect(r.usable).toBe(false);
      expect(r.unusableReason).toMatch(/baseline/);
      expect(readLedger(f.root)).toEqual([]);
      // The detecting call bumped the revision; the next call is accepted and ingests.
      const next = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, now: T0 + 6 * 60_000 });
      expect(next.presence).toBe("persisted");
      expect(next.usable).toBe(true);
      expect(readLedger(f.root)).toHaveLength(1);
    });
  });
});

describe("handleSessionIntel (the shared CLI/MCP handler)", () => {
  it("ISS-1197: the md surface carries the same imperative wording as the banner, the guide directive and the prompt hook", () => {
    withFixture((f) => {
      bindCaller(f.root);
      // T-533: imperative fires at 60,000 tokens of headroom (356,250 of 416,250), before 0.95 x 416,250.
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 360_000 })]);
      const md = formatSessionIntelMd(handleSessionIntel({ cwd: f.root, format: "json", projectsDir: f.projects }).result);
      expect(md).toMatch(/Token pressure: IMPERATIVE/);
      expect(md).toMatch(/Write a handover now \(storybloq handover create \/ storybloq_handover_create\), then keep working in this same turn\./);
      expect(md).toMatch(/auto-compaction that follows is expected and safe: the session continues through it/);
    });
  });

  it("ISS-1197 commit 2: past compactNeededPct the md surface says to run /compact and never to write a handover", () => {
    withFixture((f) => {
      bindCaller(f.root);
      // Ceiling 416,250; 410,000 tokens is 98.5%, past the 407,925 compact line (T-533: 0.98).
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 410_000 })]);
      const md = formatSessionIntelMd(handleSessionIntel({ cwd: f.root, format: "json", projectsDir: f.projects }).result);
      expect(md).toMatch(/Token pressure: COMPACT-NEEDED/);
      expect(md).toMatch(/\/compact/);
      expect(md).not.toMatch(/write a handover/i);
      // The advice line is present, not just the header: a dropped branch
      // would still render the header and the Why line.
      expect(md).toMatch(/no further handovers/i);
    });
  });


  it("md and json carry the same numbers; json is an {ok, data} envelope; the CLI and MCP samplers agree; a nested cwd finds the project", () => {
    withFixture((f) => {
      bindCaller(f.root);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 266_709 })]);
      const cli = handleSessionIntel({ cwd: f.root, format: "json", projectsDir: f.projects });
      const parsed = JSON.parse(cli.output) as { ok: boolean; data: typeof cli.result };
      expect(parsed.ok).toBe(true);
      expect(cli.errorCode).toBeUndefined();
      expect(parsed.data.pressure?.contextTokens).toBe(266_711);
      expect(parsed.data.presence).toBe("persisted");
      const md = formatSessionIntelMd(cli.result);
      expect(md).toMatch(/Token pressure: OK/);
      expect(md).toMatch(/266,711 tokens \(64\.1% of the expected auto-compact point\)/);
      expect(md).toMatch(/source setting \(high confidence\)/);
      expect(md).toMatch(/Presence: persisted/);
      // The MCP surface uses the same handler with sampledBy mcp-refresh: identical numbers.
      const mcp = handleSessionIntel({ cwd: f.root, format: "json", projectsDir: f.projects, sampledBy: "mcp-refresh" });
      const m = JSON.parse(mcp.output) as { data: typeof cli.result };
      expect(m.data.pressure?.contextTokens).toBe(parsed.data.pressure?.contextTokens);
      expect(m.data.pressure?.ceiling).toEqual(parsed.data.pressure?.ceiling);
      expect(m.data.binding).toBe("bound");
      // From a subdirectory the project is still discovered (capture, ledger, record), the cwd is kept for lookup.
      const nested = join(f.root, "src", "deep");
      mkdirSync(nested, { recursive: true });
      writeTranscript(f.projects, encoded(nested), SID, [assistantRecord({ ts: at(0), read: 266_709 })]);
      const sub = handleSessionIntel({ cwd: nested, format: "json", projectsDir: f.projects });
      expect(sub.result.binding).toBe("bound");
      expect(sub.result.provenance.capture?.autoCompactWindowAtStart).toBe(450_000);
    });
  });

  it("no session identity, and a session id with no transcript, are not_found", () => {
    withFixture((f) => {
      process.env.CLAUDE_CODE_SESSION_ID = "no-such-session-0000";
      const cli = handleSessionIntel({ cwd: join(f.base, "nowhere"), format: "json", projectsDir: f.projects });
      const parsed = JSON.parse(cli.output) as { ok: boolean; data: { usable: boolean } };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.usable).toBe(false);
      expect(cli.errorCode).toBe("not_found");
      delete process.env.CLAUDE_CODE_SESSION_ID;
      expect(handleSessionIntel({ cwd: f.root, projectsDir: f.projects }).errorCode).toBe("not_found");
    });
  });
});

function withWorktreeFixture(fn: (f: { base: string; main: string; worktree: string; projects: string }) => void): void {
  const wt = makeWorktreePair("si-query-wt-");
  try {
    for (const root of [wt.main, wt.worktree]) {
      mkdirSync(join(root, ".story"), { recursive: true });
      writeFileSync(join(root, ".story", "config.json"), "{}\n");
    }
    const projects = join(wt.base, "home", ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    fn({ base: wt.base, main: wt.main, worktree: wt.worktree, projects });
  } finally {
    resetLedgerRoutingCache();
    wt.cleanup();
  }
}

describe("ISS-1185: handleSessionIntel's worktree diagnostic", () => {
  it("reports recordRoot (JSON and MD) only when the record lives under a different root than the one sampled; sampleSession's own binding decision is untouched (still unbound, still read-only)", () => {
    withWorktreeFixture((f) => {
      bindCaller(f.worktree);
      const cli = handleSessionIntel({ cwd: f.main, format: "json", projectsDir: f.projects });
      const parsed = JSON.parse(cli.output) as { data: { sessionId: string; binding: string; bindingReason: string; root: string; recordRoot: string | null } };
      // Regression (round-2 finding 1): sampleSession's own binding path is
      // strictly unaffected by the fallback -- unbound, exactly as before
      // this ticket, since query.ts passes no `walk` argument.
      expect(parsed.data.binding).toBe("read-only");
      expect(parsed.data.bindingReason).toMatch(/no presence record/);
      expect(parsed.data.root).toBe(f.main);
      expect(parsed.data.recordRoot).toBe(f.worktree);
      const md = handleSessionIntel({ cwd: f.main, format: "md", projectsDir: f.projects }).output;
      expect(md).toMatch(new RegExp(`Record found under a different root: ${f.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(sampled root: ${f.main.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));

      // A record found directly under the sampled root: no diagnostic noise.
      bindCaller(f.main);
      const direct = JSON.parse(handleSessionIntel({ cwd: f.main, format: "json", projectsDir: f.projects }).output) as { data: { recordRoot: string | null } };
      expect(direct.data.recordRoot).toBeNull();
      expect(handleSessionIntel({ cwd: f.main, format: "md", projectsDir: f.projects }).output).not.toMatch(/Record found under a different root/);
    });
  });
});

describe("ISS-1211: the boundary series is the repo's, not the cwd's", () => {
  const boundariesAt = (root: string) => join(root, ".story", "telemetry", "session-intel", "boundaries.json");

  it("a boundary seen while cwd was a worktree is written to the MAIN checkout and is in evidence from either side", () => {
    withWorktreeFixture((f) => {
      const era = bindCaller(f.worktree);
      const lines = [...growingSession(2, 100_000, 5_000), boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 266_709 })];
      writeTranscript(f.projects, encoded(f.worktree), SID, lines);
      const r = sampleSession({ root: f.worktree, cwd: f.worktree, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(r.binding).toBe("bound");
      expect(r.presence).toBe("persisted");
      // One repo, one series: written to main, never to the checkout the hook
      // happened to be standing in.
      expect(existsSync(boundariesAt(f.main))).toBe(true);
      expect(existsSync(boundariesAt(f.worktree))).toBe(false);
      // Classification survives the routing. The era store stays per-checkout
      // and `stampBoundaries` reads it under the cwd root, so the entry is
      // already attributed by the time it is routed.
      expect(readLedger(f.main)[0]).toMatchObject({ sessionId: SID, era, captureKind: "startup", preTokens: 417_000, trigger: "auto" });
      // Read back through the routing: the session measures itself from the
      // shared file even though its own checkout holds nothing.
      const r2 = sampleSession({ root: f.worktree, cwd: f.worktree, sampledBy: "query", projectsDir: f.projects, now: T0 + 6 * 60_000 });
      expect(r2.pressure?.ceiling.source).toBe("measured-session");
      expect(r2.pressure?.ceiling.ceiling).toBe(417_000);
      // Acceptance 2: run from MAIN, the session's compaction is evidence
      // instead of a session that reads as never having compacted.
      const fromMain = handleSessionIntel({ cwd: f.main, format: "json", projectsDir: f.projects }).result;
      expect(readLedger(f.main).some(entry => entry.preTokens === 417_000)).toBe(true);
      expect(fromMain.pressure?.ceiling.source).toBe("unknown");
    });
  });

  /**
   * Known gap, deliberately NOT fixed by ISS-1211 and not the pen's ruling to
   * make here: the ledger is now per repo but the ERA STORE is still per
   * checkout. `stampBoundaries` classifies a boundary by reading the era under
   * the cwd root, so a session that captured its era in one checkout and then
   * hopped into another (exactly what the orchestrator working style does)
   * records an unclassified entry: era, captureKind and window all null, which
   * the resolver can never use for `measured-session` or `measured-project`.
   * Moving the era store with the ledger is the fix; it needs its own ruling.
   */
  it.skip("GAP: an era captured in the main checkout cannot classify a boundary stamped from a worktree", () => {
    withWorktreeFixture((f) => {
      const era = processEra.current()!.id;
      // Captured while cwd was main...
      expect(createEraIfAbsent(f.main, { era, pid: process.pid, startedAt: processEra.current()!.startedAt, captureKind: "startup", autoCompactWindowAtStart: 450_000, autoCompactWindowSource: "user", capturedAt: at(-30), endedAt: null, lastVerifiedAt: at(-30), unverifiableStreak: 0, sessionIds: [SID] })).toBe("created");
      // ...and the session then works from the worktree.
      applyPresenceEnrichment(f.worktree, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...emptySessionIntel(), era, captureKind: "startup", autoCompactWindowAtStart: 450_000, capturedAt: at(-30) } }));
      writeTranscript(f.projects, encoded(f.worktree), SID, [...growingSession(2, 100_000, 5_000), boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 266_709 })]);
      sampleSession({ root: f.worktree, cwd: f.worktree, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      expect(readLedger(f.main)[0]).toMatchObject({ era, captureKind: "startup", autoCompactWindowAtStart: 450_000 });
    });
  });

  /**
   * The ACTIVE twin of the skipped test above: it asserts today's outcome so
   * the gap cannot change silently. When the era store follows the ledger,
   * this test flips to the skipped one's expectations and the skip is deleted.
   */
  it("GAP (active twin): an era captured in another checkout leaves the boundary unclassified", () => {
    withWorktreeFixture((f) => {
      const era = processEra.current()!.id;
      expect(createEraIfAbsent(f.main, { era, pid: process.pid, startedAt: processEra.current()!.startedAt, captureKind: "startup", autoCompactWindowAtStart: 450_000, autoCompactWindowSource: "user", capturedAt: at(-30), endedAt: null, lastVerifiedAt: at(-30), unverifiableStreak: 0, sessionIds: [SID] })).toBe("created");
      applyPresenceEnrichment(f.worktree, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...emptySessionIntel(), era, captureKind: "startup", autoCompactWindowAtStart: 450_000, capturedAt: at(-30) } }));
      writeTranscript(f.projects, encoded(f.worktree), SID, [...growingSession(2, 100_000, 5_000), boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 266_709 })]);
      sampleSession({ root: f.worktree, cwd: f.worktree, sampledBy: "query", projectsDir: f.projects, now: T0 + 5 * 60_000 });
      // The entry is still routed to the repo's ledger; only its provenance is lost.
      expect(readLedger(f.main)[0]).toMatchObject({ sessionId: SID, preTokens: 417_000, era: null, captureKind: null, autoCompactWindowAtStart: null });
    });
  });

  it("ISS-1211 gate: handleSessionIntel resolves the ledger routing and the presence walk with ONE git spawn", () => {
    withWorktreeFixture((f) => {
      // The record lives under the worktree, so the ISS-1185 walk runs too;
      // the transcript must be reachable from main or the sampler returns
      // before it ever reads the ledger and the routing is never exercised.
      bindCaller(f.worktree);
      writeTranscript(f.projects, encoded(f.main), SID, [assistantRecord({ ts: at(0), read: 100_000 })]);
      resetLedgerRoutingCache();
      worktreeDiscoveryStats.spawns = 0;
      const cli = handleSessionIntel({ cwd: f.main, format: "json", projectsDir: f.projects });
      const parsed = JSON.parse(cli.output) as { data: { recordRoot: string | null; transcriptPath: string | null } };
      expect(parsed.data.transcriptPath).not.toBeNull();
      expect(parsed.data.recordRoot).toBe(f.worktree);
      // One spawn for BOTH the ledger routing and the presence walk.
      expect(worktreeDiscoveryStats.spawns).toBe(1);
    });
  });

  it("ISS-1211 gate: a spent sampling budget keeps the boundary local and spends no git, and the ingest outcome is reported", () => {
    withWorktreeFixture((f) => {
      bindCaller(f.worktree);
      writeTranscript(f.projects, encoded(f.worktree), SID, [...growingSession(2, 100_000, 5_000), boundaryRecord({ ts: at(1), pre: 417_000 }), assistantRecord({ ts: at(2), read: 266_709 })]);
      resetLedgerRoutingCache();
      worktreeDiscoveryStats.spawns = 0;
      // Exactly AT the soft budget: the stage checkpoints (strictly greater)
      // still pass, so the sample is taken and ingested, but the routing's
      // deadline is spent and discovery must not run.
      const started = T0 + 5 * 60_000;
      const r = sampleSession({ root: f.worktree, cwd: f.worktree, sampledBy: "query", projectsDir: f.projects, now: started, budget: { startedAt: started, softMs: 1_000, clock: () => started + 1_000 } });
      expect(r.presence).toBe("persisted");
      expect(r.ledgerIngest).toBe("written");
      expect(worktreeDiscoveryStats.spawns).toBe(0);
      expect(existsSync(boundariesAt(f.worktree))).toBe(true);
      expect(existsSync(boundariesAt(f.main))).toBe(false);
    });
  });

  it("entries stranded in a worktree by the old cwd routing are still counted from main", () => {
    withWorktreeFixture((f) => {
      // Exactly the field state ISS-1211 was filed from: the only record of
      // the boundary sits under the worktree.
      const dir = join(f.worktree, ".story", "telemetry", "session-intel");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "boundaries.json"), JSON.stringify({
        version: 1,
        entries: [{ sessionId: SID, era: "1:2", captureKind: "startup", timestamp: at(1), trigger: "auto", preTokens: 417_000, postTokens: 20_902, autoCompactWindowAtStart: 450_000 }],
      }) + "\n");
      expect(readLedger(f.main).map((e) => e.preTokens)).toEqual([417_000]);
      writeTranscript(f.projects, encoded(f.main), SID, [assistantRecord({ ts: at(2), read: 100_000 })]);
      const fromMain = handleSessionIntel({ cwd: f.main, format: "json", projectsDir: f.projects }).result;
      expect(readLedger(f.main).some(entry => entry.preTokens === 417_000)).toBe(true);
      expect(fromMain.pressure?.ceiling.source).toBe("unknown");
    });
  });
});

// ---------------------------------------------------------------------------
// T-501: the usage-advisory input follows the TARGET's capture, not the
// caller's live environment.
// ---------------------------------------------------------------------------

describe("sampleSession: usage advisory input provenance", () => {
  function bindWithCapture(root: string, intel: Partial<ReturnType<typeof emptySessionIntel>>, eraEntry: { captureKind: "startup" | "late" | "absent"; window: number | null; source: "user" | "project" | "local" | null } | null): string {
    const era = processEra.current()!.id;
    if (eraEntry) {
      expect(createEraIfAbsent(root, { era, pid: process.pid, startedAt: processEra.current()!.startedAt, captureKind: eraEntry.captureKind, autoCompactWindowAtStart: eraEntry.window, autoCompactWindowSource: eraEntry.source, capturedAt: at(-30), endedAt: null, lastVerifiedAt: at(-30), unverifiableStreak: 0, sessionIds: [SID] })).toBe("created");
    }
    applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...emptySessionIntel(), era, ...intel } }));
    return era;
  }

  const oneTurn = (f: Fx) => writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), read: 10 })]);

  it("a captured ABSENT window stays null even after the settings file gains one mid-session", () => {
    withFixture((f) => {
      bindWithCapture(f.root, { captureKind: "absent", autoCompactWindowAtStart: null, capturedAt: at(-30) }, { captureKind: "absent", window: null, source: null });
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
      oneTurn(f);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.pressure?.usageInput).toEqual({ window: null, source: null, provenance: "capture" });
      expect(r.pressure?.usageAdvisory).toBeNull();
    });
  });

  it("no capture object at all: the live setting supplies the window and its source", () => {
    withFixture((f) => {
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
      oneTurn(f);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.provenance.capture).toBeNull();
      expect(r.pressure?.usageInput).toEqual({ window: 1_000_000, source: "user", provenance: "live" });
      expect(r.pressure?.usageAdvisory).toEqual({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000 });
    });
  });

  it("no capture object and no setting anywhere: nothing is claimed", () => {
    withFixture((f) => {
      oneTurn(f);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.pressure?.usageInput).toEqual({ window: null, source: null, provenance: "none" });
    });
  });

  it("the authoritative era entry supplies the source", () => {
    withFixture((f) => {
      bindWithCapture(f.root, { captureKind: "startup", autoCompactWindowAtStart: 600_000, capturedAt: at(-30) }, { captureKind: "startup", window: 600_000, source: "user" });
      oneTurn(f);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.pressure?.usageInput).toEqual({ window: 600_000, source: "user", provenance: "capture" });
    });
  });

  it("the presence fallback (no era entry) supplies the record's own source", () => {
    withFixture((f) => {
      bindWithCapture(f.root, { captureKind: "startup", autoCompactWindowAtStart: 600_000, autoCompactWindowSource: "local", capturedAt: at(-30) }, null);
      oneTurn(f);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.provenance.capture?.autoCompactWindowSource).toBe("local");
      expect(r.pressure?.usageInput).toEqual({ window: 600_000, source: "local", provenance: "capture" });
    });
  });

  it("an older record with a window but no recorded source keeps the window and reports source null", () => {
    withFixture((f) => {
      bindWithCapture(f.root, { captureKind: "startup", autoCompactWindowAtStart: 600_000, capturedAt: at(-30) }, null);
      oneTurn(f);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.pressure?.usageInput).toEqual({ window: 600_000, source: null, provenance: "capture" });
      expect(r.pressure?.usageAdvisory).toEqual({ kind: "window", observed: 600_000, source: null, recommendedMax: 450_000 });
    });
  });

  it("the capture, not the session id, carries the input: a transferred era keeps its window on a new session id", () => {
    withFixture((f) => {
      const era = bindWithCapture(f.root, { captureKind: "startup", autoCompactWindowAtStart: 900_000, capturedAt: at(-30) }, { captureKind: "startup", window: 900_000, source: "project" });
      // `/clear`: a new session id in the SAME process era, the era entry transferred.
      const next = "11111111-2222-3333-4444-555555555555";
      process.env.CLAUDE_CODE_SESSION_ID = next;
      applyPresenceEnrichment(f.root, next, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...emptySessionIntel(), era, captureKind: "startup", autoCompactWindowAtStart: 900_000, capturedAt: at(-30) } }));
      writeTranscript(f.projects, encoded(f.root), next, [assistantRecord({ sessionId: next, ts: at(0), read: 10 })]);
      const r = sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
      expect(r.sessionId).toBe(next);
      expect(r.pressure?.usageInput).toEqual({ window: 900_000, source: "project", provenance: "capture" });
    });
  });
});

it("keeps handover pressure on the captured 450k window after settings change to 300k", () => {
  withFixture(f => {
    bindCaller(f.root, 450_000);
    writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(0), input: 384014, creation: 0, read: 0 })]);
    writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
    const sample = () => sampleSession({ root: f.root, cwd: f.root, sampledBy: "query", projectsDir: f.projects, userSettingsPath: f.userSettings, now: T0 });
    const before = sample();
    writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 300_000 }));
    const after = sample();
    expect(after.pressure?.ceiling.ceiling).toBe(416250);
    expect(after.pressure?.pct).toBeCloseTo(384014 / 416250);
    expect(after.pressure?.state).toBe(before.pressure?.state);
    expect(after.pressure?.ceiling).toEqual(before.pressure?.ceiling);
  });
});
