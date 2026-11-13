import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { ensureCapture } from "../../src/core/session-intel/capture.js";
import { applyBannerToMcpText, applyStatusPushesToMcpText, basisText, cliBannerFor, cliStatusPushesFor, describeStampFailure, guideDirectiveFor, renderUsageAdvisory, stampHandoverForCaller, statusPushesFor, tokenPressureBannerFor, usageAdvisoryFor } from "../../src/core/session-intel/push.js";
import type { UsageAdvisory } from "../../src/core/session-intel/types.js";
import { markCompactPending, readPresenceRecord, stampHandover, type HandoverStampObservation } from "../../src/core/session-intel/presence-bridge.js";
import { resolveSessionIntelConfig } from "../../src/core/session-intel/config.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { handleSessionIntel, handleStopHookSample } from "../../src/cli/commands/session-intel.js";
import { handleHandoverCreate } from "../../src/cli/commands/handover.js";
import { runMcpReadTool, runMcpWriteTool, registerAllTools } from "../../src/mcp/tools.js";
import * as staleness from "../../src/autonomous/binary-staleness.js";
import { runReadCommandWithRoot } from "../../src/cli/run.js";
import { registerStatusCommand } from "../../src/cli/register.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS, type EnrichmentOutcome } from "../../src/core/presence-enrichment.js";
import type { SessionPresence } from "../../src/presence/types.js";
import yargs from "yargs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SID, assistantRecord, boundaryRecord, git, makeWorktreePair, writeTranscript } from "./session-intel-fixtures.js";

/**
 * Test seam: a one-shot transform of the locked base record, standing in for
 * another writer (a sampler, a compaction hook) that landed between an
 * unlocked read and this write acquiring the lock.
 */
const inject: { transformBase: ((base: SessionPresence) => SessionPresence) | null; onCall: number; calls: number; forceOutcome: EnrichmentOutcome | null } = { transformBase: null, onCall: 1, calls: 0, forceOutcome: null };
vi.mock("../../src/core/presence-enrichment.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/presence-enrichment.js")>();
  const wrapped: typeof mod.applyPresenceEnrichment = (root, sessionId, budgetMs, source, mutate, now) => {
    // A forced outcome stands in for a busy lock or a failed write on the next session-intel write: nothing is written.
    if (source !== "session-intel" || (!inject.forceOutcome && !inject.transformBase)) return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, mutate, now);
    // Applied on the `onCall`-th session-intel write only (1 = the first).
    if (++inject.calls !== inject.onCall) return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, mutate, now);
    if (inject.forceOutcome) { const o = inject.forceOutcome; inject.forceOutcome = null; return o; }
    const transform = inject.transformBase!;
    inject.transformBase = null;
    return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, (base, nowIso) => mutate(transform(base), nowIso), now);
  };
  return { ...mod, applyPresenceEnrichment: wrapped };
});

/**
 * ISS-1185 test seam: force `revalidateCandidateIdentity` to fail on its Nth
 * call (1 = on resolution, 2 = pre-reconcile, 3 = pre-stamp), one-shot. Also
 * counts `reconcileUnderLock` calls, so a test can assert the write path was
 * never reached rather than only inferring it from one output field.
 */
const identityInject: { forceFailOnCall: number | null; calls: number; reconcileCalls: number; bindingCalls: number; consumeCalls: number; throwOnConsume: boolean } = { forceFailOnCall: null, calls: 0, reconcileCalls: 0, bindingCalls: 0, consumeCalls: 0, throwOnConsume: false };
vi.mock("../../src/core/session-intel/presence-bridge.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/session-intel/presence-bridge.js")>();
  const wrappedIdentity: typeof mod.revalidateCandidateIdentity = (candidate, expected) => {
    identityInject.calls++;
    if (identityInject.forceFailOnCall === identityInject.calls) {
      identityInject.forceFailOnCall = null;
      return false;
    }
    return mod.revalidateCandidateIdentity(candidate, expected);
  };
  const wrappedReconcile: typeof mod.reconcileUnderLock = (input, budgetMs) => {
    identityInject.reconcileCalls++;
    return mod.reconcileUnderLock(input, budgetMs);
  };
  // T-501 seams: count acquisitions (one per push pipeline is the contract),
  // and let a test make the stamp itself throw.
  const wrappedBinding: typeof mod.resolveCallerBinding = (root, explicit, walk, opts) => {
    identityInject.bindingCalls++;
    return mod.resolveCallerBinding(root, explicit, walk, opts);
  };
  const wrappedConsume: typeof mod.consumeUsageAdvisory = (root, binding, sample, revisionSeen, now) => {
    identityInject.consumeCalls++;
    if (identityInject.throwOnConsume) { identityInject.throwOnConsume = false; throw new Error("injected stamp failure"); }
    return mod.consumeUsageAdvisory(root, binding, sample, revisionSeen, now);
  };
  return { ...mod, revalidateCandidateIdentity: wrappedIdentity, reconcileUnderLock: wrappedReconcile, resolveCallerBinding: wrappedBinding, consumeUsageAdvisory: wrappedConsume };
});

/**
 * ISS-1185 test seam: a one-shot REAL swap (not a mocked identity result) run
 * from inside the genuine `locateTranscript` call site push.ts invokes
 * between the pre-reconcile identity check and `reconcileUnderLock`. Proves
 * the guard against an actual filesystem substitution, not only against a
 * forced `revalidateCandidateIdentity` return value.
 */
const locateSwap: { hook: (() => void) | null } = { hook: null };
vi.mock("../../src/core/session-intel/transcript-locate.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/session-intel/transcript-locate.js")>();
  const wrapped: typeof mod.locateTranscript = (req) => {
    const hook = locateSwap.hook;
    locateSwap.hook = null;
    hook?.();
    return mod.locateTranscript(req);
  };
  return { ...mod, locateTranscript: wrapped };
});

const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const CEILING = 0.925 * 450_000;
const ADVISORY_TOKENS = Math.ceil(0.7 * CEILING) + 1_000;
const IMPERATIVE_TOKENS = Math.ceil(0.9 * CEILING) + 1_000;
/** ISS-1197 commit 2: past the default compactNeededPct of 0.98 (T-533). */
const COMPACT_TOKENS = Math.ceil(0.98 * CEILING) + 1_000;

interface Fx { base: string; root: string; projects: string; userSettings: string }

async function makeFixture(): Promise<Fx> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "si-push-")));
  const root = join(base, "proj");
  mkdirSync(root, { recursive: true });
  await initProject(root, { name: "push" });
  const projects = join(base, "home", ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  const userSettings = join(base, "home", ".claude", "settings.json");
  writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
  return { base, root, projects, userSettings };
}

async function withFixture(fn: (f: Fx) => Promise<void> | void): Promise<void> {
  const f = await makeFixture();
  try { await fn(f); } finally { rmSync(f.base, { recursive: true, force: true }); }
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
  vi.restoreAllMocks();
  identityInject.forceFailOnCall = null;
  identityInject.calls = 0;
  identityInject.reconcileCalls = 0;
  identityInject.bindingCalls = 0;
  identityInject.consumeCalls = 0;
  identityInject.throwOnConsume = false;
  locateSwap.hook = null;
  staleness.__testing.reset();
});

const encoded = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");
const intelOf = (root: string) => readPresenceRecord(root, SID)!.sessionIntel!;

/** Binds the caller and persists one Stop-hook sample at `tokens`. */
function primed(f: Fx, tokens: number, now = T0 + 5 * 60_000): string {
  ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
  writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(2), read: tokens - 2 })]);
  const r = handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now, projectsDir: f.projects, userSettingsPath: f.userSettings });
  expect(r.result?.presence).toBe("persisted");
  return processEra.current()!.id;
}

const seams = (f: Fx) => ({ cwd: f.root, projectsDir: f.projects, userSettingsPath: f.userSettings });

describe("basisText (ISS-1249)", () => {
  // Only the sampler-reason shape is reachable from renderPromptDirective today
  // (a suppressed sample is advisory and a null reason is state ok, both silent);
  // the other two shapes are pinned here so they cannot rot unnoticed.
  it("states a sampler reason as written, since it names the clause that fired (T-533)", () => {
    expect(basisText("356250 leaves headroom 60000 <= 60000 (the larger of imperativeHeadroomTokens 60000 and jump allowance 25000)")).toBe(
      " Basis: 356250 leaves headroom 60000 <= 60000 (the larger of imperativeHeadroomTokens 60000 and jump allowance 25000).",
    );
    expect(basisText("1900000 >= 0.95 x 2000000")).toBe(" Basis: 1900000 >= 0.95 x 2000000.");
  });
  it("states the rule in words when the sample carries no reason", () => {
    expect(basisText(null)).toBe(" Basis: the imperative fires once the context is both at the imperative share of the expected auto-compact point and within the headroom floor of it, whichever comes later.");
    expect(basisText(undefined)).toBe(basisText(null));
  });
  it("states a suppression reason without the threshold parenthetical", () => {
    expect(basisText("suppressed by handover stamp 2 prompts ago")).toBe(" Basis: suppressed by handover stamp 2 prompts ago.");
  });
});

describe("tokenPressureBannerFor", () => {
  it("advisory and imperative produce a banner from a fresh stored sample; ok produces none; the sample must be the caller's own bound record", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull(); // no record yet
      primed(f, ADVISORY_TOKENS, now);
      const adv = tokenPressureBannerFor(f.root, { now, ...seams(f) });
      expect(adv).toMatchObject({ state: "advisory", ceilingSource: "setting", ceilingConfidence: "high", suppressedBy: null });
      expect(adv!.text).toMatch(/^Context pressure ADVISORY: 7[0-9]% of the expected auto-compact point/);
      expect(adv!.text).toMatch(/Plan a handover/);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(3), read: IMPERATIVE_TOKENS - 2 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 1000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      const imp = tokenPressureBannerFor(f.root, { now: now + 1000, ...seams(f) }, "cli");
      expect(imp?.state).toBe("imperative");
      expect(imp!.text).toMatch(/Write a handover now via storybloq handover create/);
      // ISS-1197: the banner says compaction after the handover is expected.
      expect(imp!.text).toMatch(/auto-compaction that follows is expected and safe: the session continues through it/);
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(4), read: 10 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 2000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(tokenPressureBannerFor(f.root, { now: now + 2000, ...seams(f) })).toBeNull();
    });
  });

  it("ISS-1197 commit 2: the compact-needed banner tells the user to run /compact and never says write a handover", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, COMPACT_TOKENS, now);
      for (const surface of ["mcp", "cli"] as const) {
        const b = tokenPressureBannerFor(f.root, { now, ...seams(f) }, surface);
        expect(b?.state, surface).toBe("compact-needed");
        expect(b!.text, surface).toMatch(/^Context pressure COMPACT-NEEDED: 9[0-9]% of the expected auto-compact point/);
        expect(b!.text, surface).toMatch(/\/compact/);
        expect(b!.text, surface).not.toMatch(/write a handover/i);
      }
    });
  });

  it("binding rule: an ended id, an era mismatch, a null era, and a Codex client all push nothing; config and presence gates too", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })?.state).toBe("imperative");
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(5) }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: null, sessionIntel: { ...b.sessionIntel!, era: "9:9" } }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      const era = processEra.current()!.id;
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, era } }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })?.state).toBe("imperative");
      delete process.env.CLAUDE_PID;
      processEra.reset();
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      process.env.CLAUDE_PID = String(process.pid);
      processEra.reset();
      process.env.STORYBLOQ_CLIENT = "codex";
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      delete process.env.STORYBLOQ_CLIENT;
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { banner: false } }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ statusWriter: { presence: false } }));
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
    });
  });

  it("a stale sample is refreshed by one bound tail sample that persists; a pending compaction or a blown budget yields nothing", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      const era = primed(f, IMPERATIVE_TOKENS, now);
      // A compaction APPENDS a boundary and a small post-compaction turn; the stored sample is 31 s old.
      const path = join(f.projects, encoded(f.root), `${SID}.jsonl`);
      appendFileSync(path, [boundaryRecord({ ts: at(6), pre: IMPERATIVE_TOKENS }), assistantRecord({ ts: at(7), read: 10 })].join("\n") + "\n");
      const later = now + 31_000;
      expect(tokenPressureBannerFor(f.root, { now: later, ...seams(f) })).toBeNull();
      expect(intelOf(f.root).lastSample?.sampledBy).toBe("mcp-refresh");
      expect(intelOf(f.root).lastSample?.state).toBe("ok");
      expect(intelOf(f.root).lastBoundaryAt).toBe(at(6));
      // Back up to imperative, fresh; then a pending event of this era blocks the banner.
      appendFileSync(path, assistantRecord({ ts: at(8), read: IMPERATIVE_TOKENS - 2 }) + "\n");
      const t2 = later + 60_000;
      expect(tokenPressureBannerFor(f.root, { now: t2, ...seams(f) })?.state).toBe("imperative");
      markCompactPending(f.root, SID, { eventId: "p", era, at: new Date(t2 + 1000).toISOString() });
      expect(tokenPressureBannerFor(f.root, { now: t2 + 2000, ...seams(f) })).toBeNull();
      rmSync(join(f.root, ".story", "telemetry", "session-intel-pending"), { recursive: true });
      // Budget: a clock past the budget after binding produces nothing and persists nothing new.
      const before = intelOf(f.root).lastSample?.sampledAt;
      let calls = 0;
      expect(tokenPressureBannerFor(f.root, { now: t2 + 60_000, ...seams(f), clock: () => (++calls >= 2 ? 10_000 : 0) })).toBeNull();
      expect(intelOf(f.root).lastSample?.sampledAt).toBe(before);
    });
  });

  it("applyBannerToMcpText: md prefix, json sibling key on an object, any other json shape untouched", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, ADVISORY_TOKENS, now);
      const b = tokenPressureBannerFor(f.root, { now, ...seams(f) })!;
      expect(applyBannerToMcpText("body", "md", b)).toBe(`${b.text}\n\nbody`);
      const json = JSON.parse(applyBannerToMcpText(JSON.stringify({ version: 1, data: { x: 1 } }), "json", b)) as Record<string, unknown>;
      expect(json.data).toEqual({ x: 1 });
      expect(json.tokenPressure).toMatchObject({ state: "advisory", ceilingSource: "setting" });
      expect((json.tokenPressure as Record<string, unknown>).text).toBeUndefined();
      expect(applyBannerToMcpText("[1,2]", "json", b)).toBe("[1,2]");
      expect(applyBannerToMcpText("not json", "json", b)).toBe("not json");
      expect(applyBannerToMcpText("body", "md", null)).toBe("body");
    });
  });
});

describe("MCP and CLI pipelines", () => {
  it("runMcpReadTool prefixes md and adds the json sibling at advisory; never on isError; runMcpWriteTool prefixes md", async () => {
    await withFixture(async (f) => {
      primed(f, ADVISORY_TOKENS, Date.now());
      const md = await runMcpReadTool(f.root, () => ({ output: "hello" }));
      expect(md.content[0]!.text).toMatch(/^Context pressure ADVISORY:[\s\S]*\n\nhello$/);
      const json = await runMcpReadTool(f.root, () => ({ output: JSON.stringify({ version: 1, data: 1 }) }), undefined, "json");
      expect((JSON.parse(json.content[0]!.text) as Record<string, unknown>).tokenPressure).toMatchObject({ state: "advisory" });
      const err = await runMcpReadTool(f.root, () => ({ output: "boom", errorCode: "io_error" }));
      expect(err.isError).toBe(true);
      expect(err.content[0]!.text).not.toMatch(/Context pressure/);
      const write = await runMcpWriteTool(f.root, async () => ({ output: "written" }));
      expect(write.content[0]!.text).toMatch(/^Context pressure ADVISORY:[\s\S]*\n\nwritten$/);
      // ok: nothing.
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(4), read: 10 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, projectsDir: f.projects, userSettingsPath: f.userSettings });
      const quiet = await runMcpReadTool(f.root, () => ({ output: "hello" }));
      expect(quiet.content[0]!.text).toBe("hello");
    });
  });

  it("CLI: md appends the line to stdout; json emits one stderr line and leaves the stdout envelope untouched", async () => {
    await withFixture(async (f) => {
      // ISS-1263: this pins the pipelines' formats across three deliveries, not
      // the rate limit, so the interval is zero and every delivery may claim.
      const configPath = join(f.root, ".story", "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      writeFileSync(configPath, JSON.stringify({ ...config, sessionIntel: { handoverRearmIntervalMs: 0 } }));
      primed(f, IMPERATIVE_TOKENS, Date.now());
      const cli = cliBannerFor(f.root, "json", seams(f));
      expect(cli.stdout).toBeNull();
      expect(cli.stderr).toMatch(/^\[storybloq\] Context pressure IMPERATIVE:.*storybloq handover create/);
      const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const errw = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const origCwd = process.cwd();
      process.chdir(f.root);
      try {
        await runReadCommandWithRoot("md", f.root, () => ({ output: "body" }));
        const stdout = out.mock.calls.map((c) => String(c[0])).join("");
        expect(stdout).toMatch(/^body\n\nContext pressure IMPERATIVE:/);
        out.mockClear();
        errw.mockClear();
        await runReadCommandWithRoot("json", f.root, () => ({ output: JSON.stringify({ version: 1, data: 1 }) }));
        expect(out.mock.calls.map((c) => String(c[0])).join("")).toBe(JSON.stringify({ version: 1, data: 1 }) + "\n");
        expect(errw.mock.calls.map((c) => String(c[0])).join("")).toMatch(/^\[storybloq\] Context pressure IMPERATIVE:/);
      } finally {
        process.chdir(origCwd);
      }
    });
  });
});

describe("guide directive and handover stamp", () => {
  it("ISS-1197 commit 2: the compact-needed guide directive tells the user to run /compact and never says write a handover", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, COMPACT_TOKENS, now);
      const directive = guideDirectiveFor(f.root, SID, now);
      expect(directive).toMatch(/^Context pressure compact-needed \(9[0-9]% of ceiling, source setting, high confidence\)/);
      expect(directive).toMatch(/\/compact/);
      expect(directive).not.toMatch(/write a handover/i);
      // Still gated by guideDirective, like the imperative line.
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { guideDirective: false } }));
      expect(guideDirectiveFor(f.root, SID, now)).toBeNull();
    });
  });

  it("the directive appears only for an imperative, usable owner sample and only when enabled", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      expect(guideDirectiveFor(f.root, SID, now)).toBeNull();
      const era = primed(f, ADVISORY_TOKENS, now);
      expect(guideDirectiveFor(f.root, SID, now)).toBeNull();
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(3), read: IMPERATIVE_TOKENS - 2 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 1000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      // ISS-1263: the directive claims the one imperative line, so it is read
      // once and both properties are checked on that one delivery.
      const directive = guideDirectiveFor(f.root, SID, now + 1000);
      expect(directive).toMatch(/^Context pressure imperative \(9[0-7]% of ceiling, source setting, high confidence\): write a handover now via storybloq_handover_create, then keep working in this same turn\./);
      // ISS-1197: the directive says compaction after the handover is expected.
      expect(directive).toMatch(/auto-compaction that follows is expected and safe: the session continues through it/);
      expect(guideDirectiveFor(f.root, null, now + 1000)).toBeNull();
      markCompactPending(f.root, SID, { eventId: "p", era, at: new Date(now + 2000).toISOString() });
      expect(guideDirectiveFor(f.root, SID, now + 3000)).toBeNull();
      rmSync(join(f.root, ".story", "telemetry", "session-intel-pending"), { recursive: true });
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { guideDirective: false } }));
      expect(guideDirectiveFor(f.root, SID, now + 1000)).toBeNull();
    });
  });

  it("handover create stamps the bound caller's record against the current boundary and holds the next imperative sample at advisory; an unbound caller is untouched; stamp:false skips", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      expect(intelOf(f.root).lastSample?.state).toBe("imperative");
      // ISS-1197: a live prompt count and imperative latch from before the stamp.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, promptsSinceHandover: 5, lastImperativeAt: at(4) } }));
      const r = await handleHandoverCreate("# Handover\nDone.", "session", "md", f.root, { now, projectsDir: f.projects });
      expect(r.output).toContain("Created handover:");
      // The reply itself tells the caller to keep working (the pause-after-handover field finding, 2026-09-09).
      expect(r.output).toMatch(/Keep working in this same turn; do not stop/);
      // Every reader drops to advisory at once, before any new sample lands.
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toMatchObject({ state: "advisory", suppressedBy: "handover" });
      expect(guideDirectiveFor(f.root, SID, now)).toBeNull();
      const intel = intelOf(f.root);
      expect(intel.handoverWrittenAt).toBe(new Date(now).toISOString());
      expect(intel.tokensAtHandover).toBe(intel.lastSample?.contextTokens);
      expect(intel.handoverBoundaryAt).toBe(intel.lastBoundaryAt);
      // ISS-1197: the stamp zeroes both re-arm counters.
      expect(intel.promptsSinceHandover).toBe(0);
      expect(intel.lastImperativeAt).toBeNull();
      // The next sample at the same level is held at advisory.
      const next = handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 1000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(next.result?.pressure).toMatchObject({ state: "advisory", rawState: "imperative", suppressedBy: "handover" });
      expect(tokenPressureBannerFor(f.root, { now: now + 1000, ...seams(f) })?.text).toMatch(/A recent handover holds this at advisory/);
      // Direct API: unbound caller (ended) is refused, stamp:false skips.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, handoverWrittenAt: null, tokensAtHandover: null, handoverBoundaryAt: null }, endedAt: at(9) }));
      expect(stampHandoverForCaller(f.root, { now: now + 2000, projectsDir: f.projects })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/ended/) });
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: null }));
      const two = await handleHandoverCreate("# Two", "two", "md", f.root, { stamp: false, now: now + 3000 });
      expect(intelOf(f.root).handoverWrittenAt).toBeNull();
      // No stamp, no continuation line: the reply never claims a suppression that did not happen.
      expect(two.output).not.toMatch(/Keep working/);
      const asJson = await handleHandoverCreate("# Three", "three", "json", f.root, { now: now + 4000, projectsDir: f.projects });
      expect(JSON.parse(asJson.output as string).data).toMatchObject({ tokenPressureStamped: true });
    });
  });

  it("ISS-1197 commit 2: a handover stamped at compact-needed never claims the pressure is held at advisory", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      // Ceiling 416,250 (0.925 x 450,000); 410,000 tokens is 98.5%, past the
      // 407,925 compact line (T-533).
      primed(f, 410_000, now);
      expect(intelOf(f.root).lastSample?.state).toBe("compact-needed");
      const r = await handleHandoverCreate("# Handover\nDone.", "session", "md", f.root, { now, projectsDir: f.projects });
      expect(r.output).toContain("Created handover:");
      // The imperative continuation line is a lie here: the stamp lands, but
      // nothing is suppressed and the banner above it still says COMPACT-NEEDED.
      expect(r.output).not.toMatch(/held at advisory/);
      expect(r.output).not.toMatch(/context pressure is held/i);
      expect(r.output).toMatch(/past the compact line/);
      expect(r.output).toMatch(/auto-compaction/i);
      expect(r.output).toMatch(/no further handovers/i);
      // The stamp itself still lands, and the sample is NOT rewritten to advisory.
      expect(intelOf(f.root)).toMatchObject({ handoverWrittenAt: new Date(now).toISOString(), lastSample: { state: "compact-needed", suppressedBy: null } });
      // json keeps its envelope (it carries no continuation line at all).
      const asJson = await handleHandoverCreate("# Two", "two", "json", f.root, { now: now + 1000, projectsDir: f.projects });
      expect(JSON.parse(asJson.output as string).data).toMatchObject({ tokenPressureStamped: true });
      // The same handler is what MCP storybloq_handover_create calls, with
      // format "md": the branch both surfaces reach is the one asserted above.
      const viaMcpShape = await handleHandoverCreate("# Three", "three", "md", f.root, { now: now + 2000, projectsDir: f.projects });
      expect(viaMcpShape.output).not.toMatch(/held at advisory/);
      expect(viaMcpShape.output).toMatch(/past the compact line/);
    });
  });

  // ISS-1197 commit 2 round 3: the reply line and the banner prefixed to the
  // SAME response must not contradict each other. An AGE gate was the wrong
  // way to get that: context grows monotonically within an epoch and
  // compact-needed is never suppressed, so an old stored compact-needed
  // re-samples to compact-needed when the banner refreshes AFTER the handler
  // (runMcpWriteTool runs the handler, then the banner). Only the
  // reconciliation gate is left, which is what actually catches a sample the
  // banner would refuse.
  it("ISS-1197 commit 2 round 3: an OLD stored compact-needed sample still gets the compact line, and the banner on the same response agrees", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, 410_000, now);
      expect(intelOf(f.root).lastSample?.state).toBe("compact-needed");
      // 31 s on: past maxSampleAgeMs, so the banner will re-sample rather than
      // reuse the stored reading.
      const late = await handleHandoverCreate("# Late", "late", "md", f.root, { now: now + 31_000, projectsDir: f.projects });
      expect(intelOf(f.root).handoverWrittenAt).toBe(new Date(now + 31_000).toISOString());
      expect(late.output).toMatch(/past the compact line/);
      expect(late.output).not.toMatch(/held at advisory/);
      // The agreement IS the assertion: the banner that prints above this
      // reply re-measures and still reads compact-needed, so a continuation
      // line here would contradict the banner directly above it.
      expect(tokenPressureBannerFor(f.root, { now: now + 31_000, ...seams(f) }, "mcp")?.state).toBe("compact-needed");
    });
  });

  it("ISS-1197 commit 2 round 3: an EXPIRED pending event reconciles to complete with the sample CLEARED, and only the identity clause catches it", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      const era = primed(f, 410_000, now);
      expect(intelOf(f.root).lastSample?.state).toBe("compact-needed");
      // Older than compactPendingTtlMs (300,000 ms): reconcileIntel takes the
      // ASSUMED reset, which reports status "complete" while nulling the
      // sample. The status alone would say the record is fine.
      markCompactPending(f.root, SID, { eventId: "p", era, at: new Date(now - 400_000).toISOString() });
      // Called directly: handleHandoverCreate reconciles under its own lock
      // first, which would clear the stored sample before the stamp ever sees
      // it and so exercise the null guard instead of this clause.
      const observed: HandoverStampObservation = { state: null };
      const outcome = stampHandover(f.root, SID, era, null, now, { out: observed, cfg: resolveSessionIntelConfig(null) });
      expect(outcome.status).toBe("written");
      expect(intelOf(f.root).lastSample?.state).toBe("compact-needed"); // the stamp did NOT clear it
      expect(observed.state).toBeNull();
      // End to end the caller keeps the continuation line.
      const r = await handleHandoverCreate("# Expired", "expired", "md", f.root, { now, projectsDir: f.projects });
      expect(r.output).toMatch(/held at advisory/);
      expect(r.output).not.toMatch(/past the compact line/);
    });
  });

  it("ISS-1197 commit 2 round 3: a bound record with NO sample stamps without throwing and keeps the continuation line", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
      expect(intelOf(f.root).lastSample).toBeNull();
      const r = await handleHandoverCreate("# NoSample", "no-sample", "md", f.root, { now, projectsDir: f.projects });
      // The stamp lands and the line is the pre-existing one: nothing about
      // the sample can be said, and silence is what ISS-1185 forbids.
      expect(intelOf(f.root).handoverWrittenAt).toBe(new Date(now).toISOString());
      expect(r.output).toMatch(/held at advisory/);
      expect(r.output).not.toMatch(/past the compact line/);
    });
  });

  it("ISS-1197 commit 2 round 2: a pending compaction over a fresh compact-needed sample falls back to the continuation line", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      const era = primed(f, 410_000, now);
      expect(intelOf(f.root).lastSample?.state).toBe("compact-needed");
      markCompactPending(f.root, SID, { eventId: "p", era, at: new Date(now + 1000).toISOString() });
      const pending = await handleHandoverCreate("# Pending", "pending", "md", f.root, { now: now + 2000, projectsDir: f.projects });
      expect(pending.output).toMatch(/held at advisory/);
      expect(pending.output).not.toMatch(/past the compact line/);
    });
  });

  it("the continuation line and tokenPressureStamped ride only on a stamp whose locked write LANDED: busy lock, failed write, and a refusal under the lock all yield the bare reply and leave the record imperative", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      for (const forced of [{ status: "skipped-lock-busy" }, { status: "skipped-write-failed" }] as const) {
        // The stamp's reconcile is session-intel write 1; the stamp itself is write 2.
        inject.calls = 0;
        inject.onCall = 2;
        inject.forceOutcome = forced;
        const r = await handleHandoverCreate("# H", `h-${forced.status}`, "json", f.root, { now, projectsDir: f.projects });
        expect(inject.forceOutcome).toBeNull();
        // ISS-1214 adds the reason beside `filename`; `tokenPressureStamped`
        // is still absent, which is what this test pins.
        expect(JSON.parse(r.output as string).data).toEqual({ filename: expect.any(String), tokenPressureStampReason: expect.any(String) });
        expect(r.output).not.toMatch(/Keep working/);
        expect(intelOf(f.root)).toMatchObject({ handoverWrittenAt: null, lastSample: { state: "imperative" } });
      }
      // Refused under the lock: the record's era changes between the binding check and the locked write.
      inject.calls = 0;
      inject.onCall = 2;
      inject.transformBase = (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, era: "999:1" } });
      const md = await handleHandoverCreate("# H", "h-refused", "md", f.root, { now, projectsDir: f.projects });
      expect(inject.transformBase).toBeNull();
      // ISS-1214: the continuation line is still absent; what the reply now
      // carries instead is the reason the stamp did not land.
      expect(md.output).toMatch(/^Created handover: [^\n]+\n\nHandover stamp did not land \(/);
      expect(md.output).not.toMatch(/Keep working/);
      expect(intelOf(f.root).handoverWrittenAt).toBeNull();
    });
  });

  it("a compaction and a new sample landing between the stamp's reconcile and its lock: the stamp pairs the NEW boundary with the NEW token count, never the old count", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      const old = intelOf(f.root);
      expect(old.lastBoundaryAt).toBeNull();
      // The other writer lands between the stamp's reconcile (session-intel
      // write 1) and the stamp itself (write 2): seen only inside the
      // stamp's lock, after any unlocked read would have happened.
      inject.calls = 0;
      inject.onCall = 2;
      inject.transformBase = (base) => ({
        ...base,
        sessionIntel: {
          ...base.sessionIntel!,
          lastBoundaryAt: at(6),
          epoch: { kind: "observed", at: at(6) },
          revision: base.sessionIntel!.revision + 1,
          lastSample: { ...base.sessionIntel!.lastSample!, contextTokens: 12_345, state: "ok", rawState: "ok", sampledAt: at(7) },
        },
      });
      const r = stampHandoverForCaller(f.root, { now: now + 2 * 60_000, projectsDir: f.projects });
      expect(r).toMatchObject({ status: "stamped", outcome: { status: "written" } });
      const intel = intelOf(f.root);
      expect(intel.handoverBoundaryAt).toBe(at(6));
      expect(intel.tokensAtHandover).toBe(12_345);
      expect(intel.tokensAtHandover).not.toBe(old.lastSample?.contextTokens);
    });
  });
});

describe("ISS-1185: worktree fallback (push surfaces)", () => {
  interface WtFx { base: string; main: string; worktree: string; projects: string; userSettings: string }

  async function withWorktreeFixture(fn: (f: WtFx) => Promise<void> | void): Promise<void> {
    const wt = makeWorktreePair("si-push-wt-");
    try {
      await initProject(wt.main, { name: "push-main" });
      await initProject(wt.worktree, { name: "push-wt" });
      const projects = join(wt.base, "home", ".claude", "projects");
      mkdirSync(projects, { recursive: true });
      const userSettings = join(wt.base, "home", ".claude", "settings.json");
      writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
      await fn({ base: wt.base, main: wt.main, worktree: wt.worktree, projects, userSettings });
    } finally {
      wt.cleanup();
    }
  }

  /** Binds the caller and persists one Stop-hook sample at `tokens` under `root` (the hook's own cwd). */
  function primedUnder(f: WtFx, root: string, tokens: number, now = T0 + 5 * 60_000): string {
    ensureCapture({ root, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: f.userSettings });
    writeTranscript(f.projects, encoded(root), SID, [assistantRecord({ ts: at(2), read: tokens - 2 })]);
    const r = handleStopHookSample({ root, sessionId: SID, cwd: root, now, projectsDir: f.projects, userSettingsPath: f.userSettings });
    expect(r.result?.presence).toBe("persisted");
    return processEra.current()!.id;
  }

  it("ACCEPTANCE: a record created under the worktree by a stop-hook sample is found by tokenPressureBannerFor, guideDirectiveFor and stampHandoverForCaller when the MCP root is the main checkout; a later imperative sample is suppressed", async () => {
    await withWorktreeFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primedUnder(f, f.worktree, IMPERATIVE_TOKENS, now);
      // The MCP root (main) has no record at all for this session: the direct read misses entirely.
      expect(readPresenceRecord(f.main, SID)).toBeNull();
      expect(tokenPressureBannerFor(f.main, { now, projectsDir: f.projects, userSettingsPath: f.userSettings })).toMatchObject({ state: "imperative" });
      expect(guideDirectiveFor(f.main, SID, now)).toMatch(/^Context pressure imperative/);
      const r = await handleHandoverCreate("# H\nDone.", "session", "md", f.main, { now, projectsDir: f.projects });
      expect(r.output).toMatch(/Keep working in this same turn; do not stop/);
      // The stamp landed on the WORKTREE's record, never on the main checkout.
      expect(readPresenceRecord(f.main, SID)).toBeNull();
      const stamped = readPresenceRecord(f.worktree, SID)!.sessionIntel!;
      expect(stamped.handoverWrittenAt).toBe(new Date(now).toISOString());
      // Every reader drops to advisory at once, still resolved via the fallback.
      expect(tokenPressureBannerFor(f.main, { now, projectsDir: f.projects, userSettingsPath: f.userSettings })).toMatchObject({ state: "advisory", suppressedBy: "handover" });
      expect(guideDirectiveFor(f.main, SID, now)).toBeNull();
      // The next Stop sample at the same level, still under the worktree, is held at advisory.
      const next = handleStopHookSample({ root: f.worktree, sessionId: SID, cwd: f.worktree, now: now + 1000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(next.result?.pressure).toMatchObject({ state: "advisory", rawState: "imperative", suppressedBy: "handover" });
    });
  });

  it("mutant-2 proof: a DIFFERENT session's record in the first-listed worktree is never mistaken for the bound session's own record in the second-listed worktree", async () => {
    const base = mkdtempSync(join(tmpdir(), "si-push-tri-wt-"));
    try {
      const main = join(base, "main");
      mkdirSync(main, { recursive: true });
      git(main, ["init", "-q", "--object-format=sha1"]);
      git(main, ["config", "user.email", "test@example.com"]);
      git(main, ["config", "user.name", "Test"]);
      writeFileSync(join(main, "f.txt"), "x\n");
      git(main, ["add", "-A"]);
      git(main, ["commit", "-q", "-m", "init"]);
      const wtA = join(base, "wtA");
      const wtB = join(base, "wtB");
      git(main, ["worktree", "add", "-q", "-b", "a", wtA]);
      git(main, ["worktree", "add", "-q", "-b", "b", wtB]);
      await initProject(main, { name: "tri-main" });
      await initProject(wtA, { name: "tri-a" });
      await initProject(wtB, { name: "tri-b" });
      const projects = join(base, "home", ".claude", "projects");
      mkdirSync(projects, { recursive: true });
      const userSettings = join(base, "home", ".claude", "settings.json");
      writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
      const f: WtFx = { base, main, worktree: wtB, projects, userSettings };

      const OTHER_SID = "9c1a2b3d-4e5f-6071-8293-a4b5c6d7e8f9";
      const now = T0 + 5 * 60_000;
      // A different session's own bound record, seeded in wtA (the first-listed worktree).
      process.env.CLAUDE_CODE_SESSION_ID = OTHER_SID;
      processEra.reset();
      ensureCapture({ root: wtA, sessionId: OTHER_SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: userSettings });
      writeTranscript(projects, encoded(wtA), OTHER_SID, [assistantRecord({ ts: at(2), read: 10, sessionId: OTHER_SID })]);
      handleStopHookSample({ root: wtA, sessionId: OTHER_SID, cwd: wtA, now, projectsDir: projects, userSettingsPath: userSettings });
      const otherBefore = readPresenceRecord(wtA, OTHER_SID)!.sessionIntel!;

      // Back to SID as the caller (beforeEach set it; OTHER_SID above overrode it), bound under wtB (the second-listed worktree).
      process.env.CLAUDE_CODE_SESSION_ID = SID;
      processEra.reset();
      primedUnder(f, wtB, IMPERATIVE_TOKENS, now);

      const r = await handleHandoverCreate("# H", "session", "md", main, { now, projectsDir: projects });
      expect(r.output).toMatch(/Keep working/);
      // The bound session's own record (wtB) was stamped.
      expect(readPresenceRecord(wtB, SID)!.sessionIntel!.handoverWrittenAt).not.toBeNull();
      // The other session's record (wtA) is byte-for-byte untouched.
      expect(readPresenceRecord(wtA, OTHER_SID)!.sessionIntel).toEqual(otherBefore);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("TOCTOU: a failed identity revalidation refuses the stamp at all three check points (on resolution, before reconciliation, before the write); the first two checks never reach reconcileUnderLock at all, the third reaches it exactly once but never writes the handover stamp; a clean revalidation stamps normally", async () => {
    await withWorktreeFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primedUnder(f, f.worktree, IMPERATIVE_TOKENS, now);
      const before = readPresenceRecord(f.worktree, SID)!.sessionIntel;

      identityInject.calls = 0;
      identityInject.reconcileCalls = 0;
      identityInject.forceFailOnCall = 1; // on resolution, before any read
      expect(stampHandoverForCaller(f.main, { now, projectsDir: f.projects })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/candidate root changed/) });
      expect(identityInject.reconcileCalls).toBe(0); // the write path is never reached
      expect(readPresenceRecord(f.worktree, SID)!.sessionIntel).toEqual(before);

      identityInject.calls = 0;
      identityInject.reconcileCalls = 0;
      identityInject.forceFailOnCall = 2; // immediately before reconcileUnderLock (the first write)
      expect(stampHandoverForCaller(f.main, { now, projectsDir: f.projects })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/candidate root changed/) });
      // This is the finding the code-review's call-2 fixed: a check that only
      // ran BEFORE locateTranscript/scanTail would let this pass through to
      // reconcileUnderLock. Asserting zero calls here, not just that
      // handoverWrittenAt stayed null, catches a regression that moved the
      // guard after reconcileUnderLock but reconciliation itself happens not
      // to touch handoverWrittenAt.
      expect(identityInject.reconcileCalls).toBe(0);
      expect(readPresenceRecord(f.worktree, SID)!.sessionIntel).toEqual(before);

      identityInject.calls = 0;
      identityInject.reconcileCalls = 0;
      identityInject.forceFailOnCall = 3; // immediately before stampHandover
      expect(stampHandoverForCaller(f.main, { now, projectsDir: f.projects })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/candidate root changed/) });
      expect(identityInject.reconcileCalls).toBe(1); // reconciliation itself already ran by this point
      expect(readPresenceRecord(f.worktree, SID)!.sessionIntel!.handoverWrittenAt).toBeNull(); // but the stamp write never happened

      identityInject.calls = 0;
      identityInject.reconcileCalls = 0;
      expect(stampHandoverForCaller(f.main, { now, projectsDir: f.projects })).toMatchObject({ status: "stamped", outcome: { status: "written" } });
      expect(identityInject.reconcileCalls).toBe(1);
      expect(readPresenceRecord(f.worktree, SID)!.sessionIntel!.handoverWrittenAt).not.toBeNull();
    });
  });

  it("TOCTOU (real swap, not a mocked identity result): the worktree root is replaced on disk from inside the genuine locateTranscript call, between the pre-read and pre-reconcile checks; the real (unmocked) revalidateCandidateIdentity refuses the stamp, reconcileUnderLock is never reached, and the original record is left byte-for-byte untouched", async () => {
    await withWorktreeFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primedUnder(f, f.worktree, IMPERATIVE_TOKENS, now);
      const before = readPresenceRecord(f.worktree, SID)!.sessionIntel;

      const movedAside = `${f.worktree}-moved-aside`;
      const replacement = mkdtempSync(join(tmpdir(), "si-push-swap-replacement-"));
      identityInject.reconcileCalls = 0;
      locateSwap.hook = () => {
        // A real substitution of the candidate root, not a forced mock
        // return value: the original directory (with its real record) is
        // moved aside, and an unrelated real directory takes its place at
        // the exact path `stampHandoverForCaller` captured identity for.
        renameSync(f.worktree, movedAside);
        renameSync(replacement, f.worktree);
      };
      try {
        expect(stampHandoverForCaller(f.main, { now, projectsDir: f.projects })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/candidate root changed/) });
        expect(identityInject.reconcileCalls).toBe(0);
        expect(readPresenceRecord(movedAside, SID)!.sessionIntel).toEqual(before);
      } finally {
        rmSync(f.worktree, { recursive: true, force: true });
        renameSync(movedAside, f.worktree);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// T-501: the usage-cost advisory. Its own line, its own gate, once per
// session, and only on the priming call.
// ---------------------------------------------------------------------------

describe("usage advisory: rendering", () => {
  const win = (over: Partial<Extract<UsageAdvisory, { kind: "window" }>> = {}): UsageAdvisory =>
    ({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000, ...over });

  it("names the settings file for each source and never guesses one it does not know", () => {
    expect(renderUsageAdvisory(win())).toBe(
      "Your Claude Code auto-compact window is 1,000,000 tokens, set in ~/.claude/settings.json. Larger contexts increase usage on every turn. Set `autoCompactWindow` to 450,000 or lower in that file (see /story settings). It takes effect on the next Claude Code start.",
    );
    expect(renderUsageAdvisory(win({ source: "project" }))).toContain("set in .claude/settings.json.");
    expect(renderUsageAdvisory(win({ source: "local" }))).toContain("set in .claude/settings.local.json.");
    const unknown = renderUsageAdvisory(win({ source: null, observed: 600_000 }));
    expect(unknown).toBe(
      "Your Claude Code auto-compact window is 600,000 tokens, set in your Claude Code settings. Larger contexts increase usage on every turn. Set `autoCompactWindow` to 450,000 or lower in your Claude Code settings (see /story settings). It takes effect on the next Claude Code start.",
    );
    expect(unknown).not.toContain("settings.json");
  });

  it("the model message claims only what was observed and carries no cost multiplier", () => {
    const text = renderUsageAdvisory({ kind: "model", nativeWindow: 1_000_000, recommendedMax: 450_000 });
    expect(text).toBe(
      "This session runs a 1M-context model, and Storybloq did not observe an `autoCompactWindow` setting, so context can grow toward 1,000,000 tokens and usage rises with it on every turn. Set `autoCompactWindow` to 450,000 or lower in ~/.claude/settings.json (see /story settings). It takes effect on the next Claude Code start.",
    );
    for (const forbidden of ["half", "twice", "4x", "2x", "double"]) expect(text).not.toContain(forbidden);
  });
});

describe("usageAdvisoryFor", () => {
  /** Binds the caller with a 1,000,000 window captured at start, then persists one ok sample. */
  function primedWide(f: Fx, now = T0 + 5 * 60_000): string {
    writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
    return primed(f, 10_000, now);
  }

  it("an ok sample still yields the advisory: it bypasses the pressure gate entirely", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      expect(tokenPressureBannerFor(f.root, { now, ...seams(f) })).toBeNull();
      const a = usageAdvisoryFor(f.root, { now, ...seams(f) });
      expect(a?.advisory).toEqual({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000 });
      expect(a!.text).toContain("~/.claude/settings.json");
    });
  });

  it("is not yielded before it is stamped, and never a second time once it is", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      const first = usageAdvisoryFor(f.root, { now, ...seams(f) })!;
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      expect(first.commit()).toBe(true);
      expect(intelOf(f.root).usageAdvisoryShownAt).not.toBeNull();
      expect(usageAdvisoryFor(f.root, { now: now + 1000, ...seams(f) })).toBeNull();
    });
  });

  it("enabled=false, banner=false, a Codex client, an unbound caller and a blown budget all yield nothing", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })).not.toBeNull();
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { banner: false } }));
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })).toBeNull();
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { enabled: false } }));
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })).toBeNull();
      writeFileSync(join(f.root, ".story", "config.json"), "{}");
      process.env.STORYBLOQ_CLIENT = "codex";
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })).toBeNull();
      delete process.env.STORYBLOQ_CLIENT;
      let ticks = 0;
      expect(usageAdvisoryFor(f.root, { now, ...seams(f), clock: () => T0 + (ticks++ === 0 ? 0 : 10_000) })).toBeNull();
      // Nothing was consumed by any of the refusals.
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })).not.toBeNull();
    });
  });

  it("eligibility is recomputed from the CURRENT config against the cached inputs, and 0 disables without consuming the stamp", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 600_000 }));
      primed(f, 10_000, now);
      expect(intelOf(f.root).lastSample?.usageInput).toEqual({ window: 600_000, source: "user", oneMillionFlag: null });
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })?.advisory).toMatchObject({ observed: 600_000, recommendedMax: 450_000 });
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { recommendedWindowMax: 800_000 } }));
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })).toBeNull();
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { recommendedWindowMax: 0 } }));
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })).toBeNull();
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { recommendedWindowMax: 500_000 } }));
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })?.advisory).toMatchObject({ recommendedMax: 500_000 });
    });
  });

  it("a window that only becomes excessive after the max is lowered is advised then, with no new sample", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 500_000 }));
      primed(f, 10_000, now);
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { recommendedWindowMax: 600_000 } }));
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })).toBeNull();
      writeFileSync(join(f.root, ".story", "config.json"), JSON.stringify({ sessionIntel: { recommendedWindowMax: 450_000 } }));
      expect(usageAdvisoryFor(f.root, { now, ...seams(f) })?.advisory).toEqual({ kind: "window", observed: 500_000, source: "user", recommendedMax: 450_000 });
    });
  });

  it("the worktree-fallback binding still finds the record (ISS-1185)", async () => {
    const pair = makeWorktreePair("si-t501-wt-");
    const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      await initProject(pair.worktree, { name: "wt" });
      const projects = join(pair.base, "projects");
      mkdirSync(projects, { recursive: true });
      const userSettings = join(pair.base, "settings.json");
      writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
      const now = T0 + 5 * 60_000;
      ensureCapture({ root: pair.worktree, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: userSettings });
      writeTranscript(projects, encoded(pair.worktree), SID, [assistantRecord({ ts: at(2), read: 9_000, cwd: pair.worktree })]);
      expect(handleStopHookSample({ root: pair.worktree, sessionId: SID, cwd: pair.worktree, now, projectsDir: projects, userSettingsPath: userSettings }).result?.presence).toBe("persisted");
      // Called with the MAIN checkout as root: the record lives under the worktree.
      const a = usageAdvisoryFor(pair.main, { now, cwd: pair.worktree, projectsDir: projects, userSettingsPath: userSettings });
      expect(a?.advisory).toMatchObject({ kind: "window", observed: 1_000_000 });
      expect(a!.commit()).toBe(true);
      expect(readPresenceRecord(pair.worktree, SID)!.sessionIntel!.usageAdvisoryShownAt).not.toBeNull();
    } finally {
      if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
      pair.cleanup();
    }
  });
});

describe("usage advisory: surfaces", () => {
  function primedWide(f: Fx, now = T0 + 5 * 60_000): void {
    writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
    primed(f, 10_000, now);
  }

  it("applyStatusPushesToMcpText: md gets one line, json one sibling key, and the stamp is consumed exactly once", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      const md = applyStatusPushesToMcpText("body", "md", null, usageAdvisoryFor(f.root, { now, ...seams(f) }));
      expect(md.split("auto-compact window is")).toHaveLength(2);
      expect(md).toMatch(/^Your Claude Code auto-compact window is 1,000,000 tokens/);
      expect(md).toMatch(/body$/);
      expect(intelOf(f.root).usageAdvisoryShownAt).not.toBeNull();
      // Second call: nothing to attach.
      expect(applyStatusPushesToMcpText("body", "md", null, usageAdvisoryFor(f.root, { now: now + 1000, ...seams(f) }))).toBe("body");
    });
  });

  it("json: the sibling key sits beside tokenPressure; a non-object json shape attaches nothing and consumes nothing", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      const array = applyStatusPushesToMcpText("[1,2]", "json", null, usageAdvisoryFor(f.root, { now, ...seams(f) }));
      expect(array).toBe("[1,2]");
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      const broken = applyStatusPushesToMcpText("not json", "json", null, usageAdvisoryFor(f.root, { now, ...seams(f) }));
      expect(broken).toBe("not json");
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      // Both siblings together: the advisory must not displace the pressure
      // banner, and a failed stamp must not take the banner with it.
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(6), read: Math.ceil(0.7 * 0.925 * 1_000_000) })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 1000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      const both = statusPushesFor(f.root, { now: now + 1000, ...seams(f) });
      expect(both.banner?.state).toBe("advisory");
      expect(both.usage).not.toBeNull();
      const json = JSON.parse(applyStatusPushesToMcpText(JSON.stringify({ version: 1, data: { x: 1 } }), "json", both.banner, both.usage)) as Record<string, unknown>;
      expect(json.usageAdvisory).toEqual({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000, message: expect.stringContaining("~/.claude/settings.json") });
      expect(json.tokenPressure).toMatchObject({ state: "advisory" });
      expect(json.data).toEqual({ x: 1 });
      expect(intelOf(f.root).usageAdvisoryShownAt).not.toBeNull();
      // Failed stamp: the banner and the payload survive, the advisory does not.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, usageAdvisoryShownAt: null } }));
      const again = statusPushesFor(f.root, { now: now + 2000, ...seams(f) });
      inject.forceOutcome = { status: "skipped-lock-busy" };
      inject.calls = 0;
      inject.onCall = 1;
      const stripped = JSON.parse(applyStatusPushesToMcpText(JSON.stringify({ version: 1, data: { x: 1 } }), "json", again.banner, again.usage)) as Record<string, unknown>;
      expect(stripped.usageAdvisory).toBeUndefined();
      expect(stripped.tokenPressure).toMatchObject({ state: "advisory" });
      expect(stripped.data).toEqual({ x: 1 });
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
    });
  });

  it("a failed stamp strips the line again: nothing is ever shown unstamped", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      const push = usageAdvisoryFor(f.root, { now, ...seams(f) });
      expect(push).not.toBeNull();
      inject.forceOutcome = { status: "skipped-lock-busy" };
      inject.calls = 0;
      inject.onCall = 1;
      expect(applyStatusPushesToMcpText("body", "md", null, push)).toBe("body");
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
    });
  });

  it("only the status surface attaches it: an unrelated read tool and every write tool leave the stamp alone", async () => {
    await withFixture(async (f) => {
      primedWide(f, Date.now());
      const other = await runMcpReadTool(f.root, () => ({ output: "hello" }));
      expect((other.content[0] as { text: string }).text).toBe("hello");
      const written = await runMcpWriteTool(f.root, async () => ({ output: "wrote" }));
      expect((written.content[0] as { text: string }).text).toBe("wrote");
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      const status = await runMcpReadTool(f.root, () => ({ output: "hello" }), undefined, "md", { usageAdvisory: true });
      expect((status.content[0] as { text: string }).text).toMatch(/^Your Claude Code auto-compact window/);
      expect(intelOf(f.root).usageAdvisoryShownAt).not.toBeNull();
    });
  });

  it("an isError result attaches nothing and consumes nothing", async () => {
    await withFixture(async (f) => {
      primedWide(f, Date.now());
      const err = await runMcpReadTool(f.root, () => ({ output: "boom", errorCode: "io_error" }), undefined, "md", { usageAdvisory: true });
      expect(err.isError).toBe(true);
      expect((err.content[0] as { text: string }).text).not.toMatch(/auto-compact window/);
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
    });
  });

  it("CLI status: md appends the line, json emits it on stderr, and both stamp exactly once", async () => {
    await withFixture(async (f) => {
      primedWide(f, Date.now());
      const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const errw = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const origCwd = process.cwd();
      process.chdir(f.root);
      try {
        await runReadCommandWithRoot("md", f.root, () => ({ output: "body" }), { usageAdvisory: true });
        expect(out.mock.calls.map((c) => String(c[0])).join("")).toMatch(/Your Claude Code auto-compact window is 1,000,000 tokens/);
        expect(intelOf(f.root).usageAdvisoryShownAt).not.toBeNull();
        // A second command in the same session shows nothing.
        out.mockClear();
        await runReadCommandWithRoot("md", f.root, () => ({ output: "body" }), { usageAdvisory: true });
        expect(out.mock.calls.map((c) => String(c[0])).join("")).not.toMatch(/auto-compact window/);
      } finally {
        process.chdir(origCwd);
      }
      // json, on a fresh stamp.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, usageAdvisoryShownAt: null } }));
      out.mockClear();
      errw.mockClear();
      process.chdir(f.root);
      try {
        await runReadCommandWithRoot("json", f.root, () => ({ output: JSON.stringify({ version: 1, data: 1 }) }), { usageAdvisory: true });
        expect(out.mock.calls.map((c) => String(c[0])).join("")).toBe(JSON.stringify({ version: 1, data: 1 }) + "\n");
        expect(errw.mock.calls.map((c) => String(c[0])).join("")).toMatch(/^\[storybloq\] Your Claude Code auto-compact window/m);
        expect(intelOf(f.root).usageAdvisoryShownAt).not.toBeNull();
      } finally {
        process.chdir(origCwd);
      }
      // An ordinary read command never attaches it.
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, usageAdvisoryShownAt: null } }));
      out.mockClear();
      process.chdir(f.root);
      try {
        await runReadCommandWithRoot("md", f.root, () => ({ output: "body" }));
        expect(out.mock.calls.map((c) => String(c[0])).join("")).not.toMatch(/auto-compact window/);
        expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      } finally {
        process.chdir(origCwd);
      }
    });
  });

  it("session intel reports the advisory on every call and never stamps it", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
      primed(f, 10_000, now);
      for (const pass of [1, 2]) {
        const r = handleSessionIntel({ cwd: f.root, format: "json", now: undefined, projectsDir: f.projects, userSettingsPath: f.userSettings });
        const data = JSON.parse(r.output).data as { pressure: { usageAdvisory: unknown } };
        expect(data.pressure.usageAdvisory, `pass ${pass}`).toEqual({ kind: "window", observed: 1_000_000, source: "user", recommendedMax: 450_000 });
        expect(intelOf(f.root).usageAdvisoryShownAt, `pass ${pass}`).toBeNull();
      }
      const md = handleSessionIntel({ cwd: f.root, format: "md", projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(md.output).toMatch(/Usage advisory: /);
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// T-501, Codex round 1: one acquisition per push pipeline, and a commit that
// re-checks everything the acquisition proved.
// ---------------------------------------------------------------------------

describe("usage advisory: one budget, one acquisition, a guarded commit", () => {
  function primedWide(f: Fx, now = T0 + 5 * 60_000): void {
    writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
    primed(f, 10_000, now);
  }

  it("statusPushesFor binds ONCE for both pushes, where the two separate entry points bind twice", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      identityInject.bindingCalls = 0;
      statusPushesFor(f.root, { now, ...seams(f) });
      const shared = identityInject.bindingCalls;
      expect(shared).toBe(1);
      identityInject.bindingCalls = 0;
      tokenPressureBannerFor(f.root, { now, ...seams(f) });
      usageAdvisoryFor(f.root, { now, ...seams(f) });
      expect(identityInject.bindingCalls).toBeGreaterThan(shared);
    });
  });

  it("the MCP status surface acquires once per call and the CLI status surface too", async () => {
    await withFixture(async (f) => {
      primedWide(f, Date.now());
      identityInject.bindingCalls = 0;
      await runMcpReadTool(f.root, () => ({ output: "hello" }), undefined, "md", { usageAdvisory: true });
      expect(identityInject.bindingCalls).toBe(1);
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, usageAdvisoryShownAt: null } }));
      const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const origCwd = process.cwd();
      process.chdir(f.root);
      try {
        identityInject.bindingCalls = 0;
        await runReadCommandWithRoot("md", f.root, () => ({ output: "body" }), { usageAdvisory: true });
        expect(identityInject.bindingCalls).toBe(1);
        expect(out.mock.calls.map((c) => String(c[0])).join("")).toMatch(/auto-compact window/);
      } finally {
        process.chdir(origCwd);
      }
    });
  });

  it("a budget spent AFTER acquisition refuses the stamp at commit time", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      // The clock is inside budget for every acquisition read, then jumps
      // past the deadline before `commit()` runs.
      let jumped = false;
      const push = usageAdvisoryFor(f.root, { now, ...seams(f), clock: () => (jumped ? T0 + 10_000 : T0) });
      expect(push).not.toBeNull();
      jumped = true;
      expect(push!.commit()).toBe(false);
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      expect(identityInject.consumeCalls).toBe(0);
    });
  });

  it("a stamp that throws is absorbed: commit reports false and the response is left alone", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primedWide(f, now);
      const push = usageAdvisoryFor(f.root, { now, ...seams(f) })!;
      identityInject.throwOnConsume = true;
      expect(applyStatusPushesToMcpText("body", "md", null, push)).toBe("body");
      expect(intelOf(f.root).usageAdvisoryShownAt).toBeNull();
      // Same through the CLI pipeline.
      const push2 = usageAdvisoryFor(f.root, { now, ...seams(f) })!;
      identityInject.throwOnConsume = true;
      expect(push2.commit()).toBe(false);
    });
  });

  it("a fallback record root swapped between acquisition and commit refuses the stamp (ISS-1185)", async () => {
    const pair = makeWorktreePair("si-t501-swap-");
    const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      await initProject(pair.worktree, { name: "wt" });
      const projects = join(pair.base, "projects");
      mkdirSync(projects, { recursive: true });
      const userSettings = join(pair.base, "settings.json");
      writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
      const now = T0 + 5 * 60_000;
      ensureCapture({ root: pair.worktree, sessionId: SID, source: "startup", now: T0 - 30 * 60_000, userSettingsPath: userSettings });
      writeTranscript(projects, encoded(pair.worktree), SID, [assistantRecord({ ts: at(2), read: 9_000, cwd: pair.worktree })]);
      expect(handleStopHookSample({ root: pair.worktree, sessionId: SID, cwd: pair.worktree, now, projectsDir: projects, userSettingsPath: userSettings }).result?.presence).toBe("persisted");
      const push = usageAdvisoryFor(pair.main, { now, cwd: pair.worktree, projectsDir: projects, userSettingsPath: userSettings })!;
      expect(push).not.toBeNull();
      // The candidate root's identity no longer matches: the write is refused
      // rather than landing in whatever now sits at that path.
      identityInject.forceFailOnCall = identityInject.calls + 1;
      expect(push.commit()).toBe(false);
      expect(readPresenceRecord(pair.worktree, SID)!.sessionIntel!.usageAdvisoryShownAt).toBeNull();
      expect(identityInject.consumeCalls).toBe(0);
    } finally {
      if (savedSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = savedSid;
      pair.cleanup();
    }
  });

  it("cliStatusPushesFor puts the advisory before the banner and emits both on one acquisition", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
      primed(f, Math.ceil(0.7 * 0.925 * 1_000_000), now);
      identityInject.bindingCalls = 0;
      const md = cliStatusPushesFor(f.root, "md", { now, ...seams(f) });
      expect(identityInject.bindingCalls).toBe(1);
      expect(md.stdout).toHaveLength(2);
      expect(md.stdout[0]).toMatch(/^Your Claude Code auto-compact window/);
      expect(md.stdout[1]).toMatch(/^Context pressure ADVISORY/);
      expect(md.stderr).toEqual([]);
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, usageAdvisoryShownAt: null } }));
      const json = cliStatusPushesFor(f.root, "json", { now, ...seams(f) });
      expect(json.stdout).toEqual([]);
      expect(json.stderr).toHaveLength(2);
      expect(json.stderr[0]).toMatch(/^\[storybloq\] Your Claude Code auto-compact window/);
    });
  });
});

/**
 * T-320 commit 3, pen byte-review round 1 finding: `compact` forces a JSON
 * body regardless of `format` in the response BODY, but before this fix
 * `format` itself still defaulted to "md" when the caller omitted
 * `--format`/`format` -- so `emitCliBanner` (CLI) and
 * `applyStatusPushesToMcpText` (MCP) took the MARKDOWN branch and prepended
 * prose lines ahead of the compact JSON body whenever the advisory or
 * pressure banner fired, corrupting it exactly when T-501's push is most
 * likely to trigger. The fix resolves `format` to "json" whenever `compact`
 * is set, at the CLI/MCP surface itself (register.ts / mcp/tools.ts), before
 * it ever reaches the push pipeline. These tests go through the REAL
 * registered command/tool (registerStatusCommand / registerAllTools), not a
 * direct handleStatus/formatStatus call, since the bug lived in that
 * resolution, not in formatStatus itself.
 */
describe("T-320 commit 3: --compact/compact forces json even when format is omitted, so a firing push cannot corrupt it", () => {
  function primedWide(f: Fx, now = T0 + 5 * 60_000): void {
    writeFileSync(f.userSettings, JSON.stringify({ autoCompactWindow: 1_000_000 }));
    primed(f, Math.ceil(0.7 * 0.925 * 1_000_000), now);
  }

  it("CLI: `status --compact` with no --format still emits parseable JSON on stdout, advisory on stderr", async () => {
    await withFixture(async (f) => {
      primedWide(f, Date.now());
      const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const errw = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const origCwd = process.cwd();
      process.chdir(f.root);
      try {
        await registerStatusCommand(yargs().exitProcess(false)).parseAsync(["status", "--compact"]);
      } finally {
        process.chdir(origCwd);
      }
      const stdout = out.mock.calls.map((c) => String(c[0])).join("");
      // A pre-fix regression prepends Markdown prose ahead of the JSON body,
      // which fails this parse; the fix keeps stdout pure JSON.
      const parsed = JSON.parse(stdout) as { data: Record<string, unknown> };
      expect(parsed.data.activeSessions).toBeDefined();
      expect(errw.mock.calls.map((c) => String(c[0])).join("")).toMatch(/^\[storybloq\] Your Claude Code auto-compact window/m);
    });
  });

  async function callStatus(root: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
    const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
    registerAllTools(server, root);
    const client = new Client({ name: "status-compact-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "storybloq_status", arguments: args });
    await client.close();
    const content = result.content as { text: string }[];
    return { isError: result.isError as boolean | undefined, text: content[0]!.text };
  }

  it("MCP: storybloq_status with compact:true and no format still returns parseable JSON with the advisory as a sibling key", async () => {
    await withFixture(async (f) => {
      primedWide(f, Date.now());
      const { text } = await callStatus(f.root, { compact: true });
      // Same failure mode as the CLI case: a pre-fix regression prepends
      // prose ahead of the JSON body here too, which fails this parse.
      const parsed = JSON.parse(text) as { data: Record<string, unknown>; usageAdvisory?: unknown };
      expect(parsed.data.activeSessions).toBeDefined();
      expect(parsed.usageAdvisory).toBeDefined();
    });
  });
});

/**
 * ISS-1214: field report, 2026-09-14. Two `storybloq_handover_create` calls
 * through a stale MCP server returned only "Created handover: <file>"; the
 * presence record kept `handoverWrittenAt: null`, so the ISS-1197 re-arm
 * gates had nothing to hold and the prompt hook re-fired the imperative two
 * prompts later. The reply must say why the stamp did not land, and a server
 * binary older than the on-disk build must say so on every write tool.
 */
describe("ISS-1214: the reply names a stamp that did not land", () => {
  const HINT = "Also: the server binary is stale; a restart loads the new build but does not fix the binding.";
  const NEUTRAL = "The caller could not be bound to a live presence record.";

  it("describeStampFailure classifies every shape; the formatter is never asked to read the text", () => {
    // Every enrichment outcome a stamp can end on, plus the fallback.
    const outcomes: ReadonlyArray<readonly [string, string]> = [
      ["skipped-lock-busy", "lock busy"],
      ["skipped-write-failed", "write failed"],
      ["skipped-no-directory", "no presence directory"],
      ["skipped-too-large", "record too large"],
      ["aborted", "aborted"],
    ];
    for (const [status, reason] of outcomes) {
      expect(describeStampFailure({ status: "stamped", sessionId: SID, outcome: { status }, root: "/r", pressureState: null } as never), status)
        .toEqual({ reason, kind: "outcome" });
    }
    // An outcome status with no mapping falls back to the status itself.
    expect(describeStampFailure({ status: "stamped", sessionId: SID, outcome: { status: "skipped-unheard-of" }, root: "/r", pressureState: null } as never))
      .toEqual({ reason: "skipped-unheard-of", kind: "outcome" });
    // A landed write is not a failure.
    expect(describeStampFailure({ status: "stamped", sessionId: SID, outcome: { status: "written" }, root: "/r", pressureState: null } as never)).toBeNull();
    // The refused shape keeps its own reason and its own kind.
    expect(describeStampFailure({ status: "stamped", sessionId: SID, outcome: { status: "refused", reason: "caller session has ended" }, root: "/r", pressureState: null } as never))
      .toEqual({ reason: "refused: caller session has ended", kind: "refused" });
    // Both process-era binding reasons are binding, on both surfaces.
    for (const reason of ["process era ended", "process era unverifiable", "process era unknown"]) {
      for (const surface of ["cli", "mcp"] as const) {
        expect(describeStampFailure({ status: "skipped", reason, kind: "binding" }, surface), `${reason}/${surface}`)
          .toEqual({ reason: `skipped: ${reason}`, kind: "binding" });
      }
    }
    // The outer catch is an error, not a binding failure.
    expect(describeStampFailure({ status: "skipped", reason: "boom", kind: "error" }, "cli")).toEqual({ reason: "error: boom", kind: "error" });
    // Config gates are silent on every surface.
    for (const reason of ["sessionIntel disabled", "presence disabled"]) {
      for (const surface of ["cli", "mcp"] as const) {
        expect(describeStampFailure({ status: "skipped", reason, kind: "config" }, surface), `${reason}/${surface}`).toBeNull();
      }
    }
    // The surface split: a terminal cannot act on these, an MCP caller can.
    expect(describeStampFailure({ status: "skipped", reason: "no caller session id", kind: "binding" }, "cli")).toBeNull();
    expect(describeStampFailure({ status: "skipped", reason: "no caller session id", kind: "binding" }, "mcp"))
      .toEqual({ reason: "skipped: no caller session id", kind: "binding" });
    expect(describeStampFailure({ status: "skipped", reason: "client is not Claude", kind: "binding" }, "cli")).toBeNull();
    expect(describeStampFailure({ status: "skipped", reason: "client is not Claude", kind: "binding" }, "mcp"))
      .toEqual({ reason: "skipped: client is not Claude", kind: "binding" });
    for (const surface of ["cli", "mcp"] as const) {
      expect(describeStampFailure({ status: "skipped", reason: "no project", kind: "binding" }, surface), surface).toBeNull();
    }
  });

  it("ISS-1263: a real unresolvable process era no longer skips the stamp; it lands unbound-era and the reply says the line will not repeat", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      delete process.env.CLAUDE_PID;
      processEra.reset();
      const r = stampHandoverForCaller(f.root, { now, projectsDir: f.projects });
      expect(r).toMatchObject({ status: "stamped", binding: "unbound-era", outcome: { status: "written" } });
      const md = await handleHandoverCreate("# H", "h-1214-era-real", "md", f.root, { now, projectsDir: f.projects });
      expect(md.output).toMatch(/^Created handover: ([^\n]+)\n\nHandover recorded at \1\. The pressure line will not repeat for 10 minutes\.$/);
      expect(md.output).not.toContain("did not land");
      const json = await handleHandoverCreate("# H", "h-1214-era-real-json", "json", f.root, { now, projectsDir: f.projects });
      expect(JSON.parse(json.output as string).data).toEqual({ filename: expect.any(String), tokenPressureStamped: true, tokenPressureStampBinding: "unbound-era" });
    });
  });

  it("ISS-1263: the unbound-era reply uses the configured interval, and compact-needed still wins", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      const cfgPath = join(f.root, ".story", "config.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      writeFileSync(cfgPath, JSON.stringify({ ...cfg, sessionIntel: { handoverRearmIntervalMs: 150_000 } }));
      primed(f, IMPERATIVE_TOKENS, now);
      delete process.env.CLAUDE_PID;
      processEra.reset();
      const md = await handleHandoverCreate("# H", "h-1263-interval", "md", f.root, { now, projectsDir: f.projects });
      expect(md.output).toMatch(/The pressure line will not repeat for 150 seconds\.$/);
    });
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      // The first fixture left the server unable to resolve its era; the
      // hook side of this one binds again before priming.
      process.env.CLAUDE_PID = String(process.pid);
      processEra.reset();
      primed(f, 410_000, now);
      delete process.env.CLAUDE_PID;
      processEra.reset();
      const md = await handleHandoverCreate("# H", "h-1263-compact", "md", f.root, { now, projectsDir: f.projects });
      expect(md.output).toMatch(/context is past the compact line/);
      expect(md.output).not.toMatch(/will not repeat/);
    });
  });

  it("ISS-1263: no source file tells the caller the next imperative is expected, and none advises a restart for a binding failure", () => {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const hits = (readdirSync(src, { recursive: true }) as string[])
      .filter((rel) => rel.endsWith(".ts"))
      .filter((rel) => /next imperative is expected|if this repeats, restart/.test(readFileSync(join(src, rel), "utf8")));
    expect(hits).toEqual([]);
  });

  it("a throw inside the stamp is reported as an error kind, message kept", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      locateSwap.hook = () => { throw new Error("injected stamp failure"); };
      const md = await handleHandoverCreate("# H", "h-1214-throw", "md", f.root, { now, projectsDir: f.projects });
      expect(locateSwap.hook).toBeNull();
      expect(md.output).toContain("Handover stamp did not land (error: injected stamp failure). The pressure line repeats at most once every 10 minutes.");
      // An error is not a binding failure: neither sentence belongs on it.
      expect(md.output).not.toContain(NEUTRAL);
      expect(md.output).not.toContain(HINT);
      expect(intelOf(f.root).handoverWrittenAt).toBeNull();
    });
  });

  it("MCP surface: an unbound caller with no session id is reported, where the same skip stays bare on the CLI", async () => {
    await withFixture(async (f) => {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      const cli = await handleHandoverCreate("# H", "h-1214-nosid-cli", "md", f.root, { projectsDir: f.projects });
      expect(cli.output).toMatch(/^Created handover: [^\n]+$/);

      const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
      registerAllTools(server, f.root);
      const client = new Client({ name: "iss1214-nosid", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "storybloq_handover_create", arguments: { content: "# H", slug: "h-1214-nosid-mcp" } });
      await client.close();
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).toContain("Handover stamp did not land (skipped: no caller session id). The pressure line repeats at most once every 10 minutes.");
      // A fresh server: the neutral sentence, never the causal claim.
      expect(text).toContain(NEUTRAL);
      expect(text).not.toContain(HINT);
    });
  });

  it("a busy lock: md names the reason under the unchanged first line, json carries tokenPressureStampReason", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      // The stamp's reconcile is session-intel write 1; the stamp itself is write 2.
      inject.calls = 0;
      inject.onCall = 2;
      inject.forceOutcome = { status: "skipped-lock-busy" };
      const md = await handleHandoverCreate("# H", "h-1214-busy", "md", f.root, { now, projectsDir: f.projects });
      expect(inject.forceOutcome).toBeNull();
      expect(md.output).toMatch(/^Created handover: [^\n]+\n\nHandover stamp did not land \(lock busy\)\. The pressure line repeats at most once every 10 minutes\.$/);
      expect(intelOf(f.root).handoverWrittenAt).toBeNull();

      inject.calls = 0;
      inject.onCall = 2;
      inject.forceOutcome = { status: "skipped-lock-busy" };
      const json = await handleHandoverCreate("# H", "h-1214-busy-json", "json", f.root, { now, projectsDir: f.projects });
      expect(inject.forceOutcome).toBeNull();
      expect(JSON.parse(json.output as string).data).toEqual({ filename: expect.any(String), tokenPressureStampReason: "lock busy" });
    });
  });

  it("a refusal under the lock names the refused era, and gets neither the neutral sentence nor the hint", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      inject.calls = 0;
      inject.onCall = 2;
      inject.transformBase = (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, era: "999:1" } });
      const md = await handleHandoverCreate("# H", "h-1214-refused", "md", f.root, { now, projectsDir: f.projects });
      expect(inject.transformBase).toBeNull();
      expect(md.output).toContain("Handover stamp did not land (refused: record era differs from the caller's live era). The pressure line repeats at most once every 10 minutes.");
      expect(md.output).not.toContain(NEUTRAL);
      expect(md.output).not.toContain(HINT);
      expect(intelOf(f.root).handoverWrittenAt).toBeNull();
    });
  });

  it("a skipped binding failure reports its reason and, on a fresh server, the neutral sentence", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(5) }));
      const ended = await handleHandoverCreate("# H", "h-1214-ended", "md", f.root, { now, projectsDir: f.projects });
      expect(ended.output).toContain("Handover stamp did not land (skipped: caller session has ended). The pressure line repeats at most once every 10 minutes.");
      expect(ended.output).toContain(NEUTRAL);
      expect(ended.output).not.toContain(HINT);

      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: null, sessionIntel: { ...b.sessionIntel!, era: "9:9" } }));
      const era = await handleHandoverCreate("# H", "h-1214-era", "md", f.root, { now, projectsDir: f.projects });
      expect(era.output).toContain("Handover stamp did not land (skipped: record era differs from the live process era). The pressure line repeats at most once every 10 minutes.");
      expect(era.output).toContain(NEUTRAL);
      expect(era.output).not.toContain(HINT);
    });
  });

  it("the CLI-surface not-applicable skips stay silent: session intel off, presence off, and no session id all return the bare line", async () => {
    await withFixture(async (f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      const cfgPath = join(f.root, ".story", "config.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;

      writeFileSync(cfgPath, JSON.stringify({ ...cfg, sessionIntel: { enabled: false } }));
      const off = await handleHandoverCreate("# H", "h-1214-off", "md", f.root, { now, projectsDir: f.projects });
      expect(off.output).toMatch(/^Created handover: [^\n]+$/);
      const json = await handleHandoverCreate("# H", "h-1214-off-json", "json", f.root, { now, projectsDir: f.projects });
      expect(JSON.parse(json.output as string).data).toEqual({ filename: expect.any(String) });

      writeFileSync(cfgPath, JSON.stringify({ ...cfg, statusWriter: { presence: false } }));
      const noPresence = await handleHandoverCreate("# H", "h-1214-nopresence", "md", f.root, { now, projectsDir: f.projects });
      expect(noPresence.output).toMatch(/^Created handover: [^\n]+$/);

      writeFileSync(cfgPath, JSON.stringify(cfg));
      delete process.env.CLAUDE_CODE_SESSION_ID;
      const noSid = await handleHandoverCreate("# H", "h-1214-nosid", "md", f.root, { now, projectsDir: f.projects });
      expect(noSid.output).toMatch(/^Created handover: [^\n]+$/);
    });
  });

  it("MCP: a server binary older than the on-disk build attaches the stale-server line, and the failure block then asserts the cause", async () => {
    await withFixture(async (f) => {
      staleness.__testing.setStartupFingerprint({ sha256: "aaaa" });
      staleness.__testing.setDiskProbe(() => ({ sha256: "bbbb" }));
      const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
      registerAllTools(server, f.root);
      const client = new Client({ name: "iss1214-test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "storybloq_handover_create", arguments: { content: "# H", slug: "h-1214-stale" } });
      await client.close();
      const text = (result.content as { text: string }[])[0]!.text;
      expect(text).toContain("Created handover:");
      expect(text).toContain("Server binary is stale (fingerprint mismatch); restart the client.");
      // The caller is unbound here (no presence record), and staleness IS
      // established, so the causal hint is earned rather than guessed.
      expect(text).toContain("Handover stamp did not land (skipped: no presence record for the caller)");
      expect(text).toContain(HINT);
      expect(text).not.toContain(NEUTRAL);
    });
  });
});

describe("ISS-1263: the unbound-era stamp through stampHandoverForCaller", () => {
  it("process era unknown on a live record: the stamp lands, marked unbound-era", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      delete process.env.CLAUDE_PID;
      processEra.reset();
      const r = stampHandoverForCaller(f.root, { now, projectsDir: f.projects });
      expect(r).toMatchObject({ status: "stamped", binding: "unbound-era", outcome: { status: "written" } });
      expect(intelOf(f.root)).toMatchObject({ handoverWrittenAt: new Date(now).toISOString(), handoverStampBinding: "unbound-era" });
      expect(intelOf(f.root).lastSample).toMatchObject({ state: "advisory", suppressedBy: "handover" });
    });
  });

  it("process era unverifiable (ps timed out): the stamp lands, marked unbound-era", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      vi.spyOn(processEra, "revalidate").mockReturnValue("unverifiable");
      expect(stampHandoverForCaller(f.root, { now, projectsDir: f.projects })).toMatchObject({ status: "stamped", binding: "unbound-era", outcome: { status: "written" } });
    });
  });

  it("a bound caller's stamp is marked bound", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      expect(stampHandoverForCaller(f.root, { now, projectsDir: f.projects })).toMatchObject({ status: "stamped", binding: "bound" });
      expect(intelOf(f.root).handoverStampBinding).toBe("bound");
    });
  });

  it("positive evidence refuses: a proven-ended process, a live different era, an ended record, no record", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      expect(stampHandoverForCaller(f.root, { now, projectsDir: f.projects })).toMatchObject({ status: "skipped", kind: "binding", reason: "no presence record for the caller" });
      primed(f, IMPERATIVE_TOKENS, now);
      const spy = vi.spyOn(processEra, "revalidate").mockReturnValue("ended");
      expect(stampHandoverForCaller(f.root, { now, projectsDir: f.projects })).toMatchObject({ status: "skipped", kind: "binding", reason: "process era ended" });
      spy.mockRestore();
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, era: "9:9" } }));
      expect(stampHandoverForCaller(f.root, { now, projectsDir: f.projects })).toMatchObject({ status: "skipped", kind: "binding", reason: "record era differs from the live process era" });
      applyPresenceEnrichment(f.root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(9) }));
      delete process.env.CLAUDE_PID;
      processEra.reset();
      expect(stampHandoverForCaller(f.root, { now, projectsDir: f.projects })).toMatchObject({ status: "skipped", kind: "binding", reason: "caller session has ended" });
      expect(intelOf(f.root).handoverWrittenAt).toBeNull();
    });
  });
});

describe("ISS-1263: every delivery path claims the one imperative line", () => {
  it("MCP md: repeated reads of one fresh cached imperative sample show it once, then the rate-limited advisory", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      const first = applyBannerToMcpText("body", "md", tokenPressureBannerFor(f.root, { now, ...seams(f) }));
      expect(first).toMatch(/^Context pressure IMPERATIVE/);
      expect(intelOf(f.root).lastImperativeEmittedAt).toBe(new Date(now).toISOString());
      const second = applyBannerToMcpText("body", "md", tokenPressureBannerFor(f.root, { now: now + 1000, ...seams(f) }));
      expect(second).toMatch(/^Context pressure ADVISORY/);
      expect(second).toMatch(/shown recently/);
      expect(second).not.toMatch(/Write a handover now/);
      expect(intelOf(f.root).lastImperativeEmittedAt).toBe(new Date(now).toISOString());
    });
  });

  it("MCP json: a response that cannot carry the banner consumes no claim; a json object carries the degraded shape after a claim", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      expect(applyBannerToMcpText("[1,2]", "json", tokenPressureBannerFor(f.root, { now, ...seams(f) }))).toBe("[1,2]");
      expect(intelOf(f.root).lastImperativeEmittedAt).toBeNull();
      const one = JSON.parse(applyBannerToMcpText("{\"a\":1}", "json", tokenPressureBannerFor(f.root, { now, ...seams(f) })));
      expect(one.tokenPressure).toMatchObject({ state: "imperative" });
      expect(one.tokenPressure).not.toHaveProperty("claim");
      const two = JSON.parse(applyBannerToMcpText("{\"a\":1}", "json", tokenPressureBannerFor(f.root, { now: now + 1000, ...seams(f) })));
      expect(two.tokenPressure).toMatchObject({ state: "advisory", suppressedBy: "rate-limit" });
    });
  });

  it("status pushes claim once per response, not once per rendering attempt", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      const pushes = statusPushesFor(f.root, { now, ...seams(f) });
      const text = applyStatusPushesToMcpText("body", "md", pushes.banner, pushes.usage);
      expect(text.match(/Context pressure IMPERATIVE/g)?.length).toBe(1);
      expect(intelOf(f.root).lastImperativeEmittedAt).toBe(new Date(now).toISOString());
    });
  });

  it("CLI: the banner prints once, then the degraded line", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      expect(cliBannerFor(f.root, "md", { now, ...seams(f) }).stdout).toMatch(/^Context pressure IMPERATIVE/);
      expect(cliBannerFor(f.root, "md", { now: now + 1000, ...seams(f) }).stdout).toMatch(/^Context pressure ADVISORY.*shown recently/);
      expect(cliStatusPushesFor(f.root, "md", { now: now + 2000, ...seams(f) }).stdout.join("\n")).not.toMatch(/IMPERATIVE/);
    });
  });

  it("the guide directive claims too: after it, the banner is degraded; after a banner delivery, the directive is null", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      primed(f, IMPERATIVE_TOKENS, now);
      expect(guideDirectiveFor(f.root, SID, now)).toMatch(/write a handover now/);
      expect(applyBannerToMcpText("b", "md", tokenPressureBannerFor(f.root, { now: now + 1000, ...seams(f) }))).toMatch(/^Context pressure ADVISORY/);
      expect(guideDirectiveFor(f.root, SID, now + 2000)).toBeNull();
      // compact-needed is never limited.
      writeTranscript(f.projects, encoded(f.root), SID, [assistantRecord({ ts: at(6), read: COMPACT_TOKENS - 2 })]);
      handleStopHookSample({ root: f.root, sessionId: SID, cwd: f.root, now: now + 3000, projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(guideDirectiveFor(f.root, SID, now + 3000)).toMatch(/compact-needed/);
      expect(guideDirectiveFor(f.root, SID, now + 4000)).toMatch(/compact-needed/);
    });
  });

  it("an acquisition that fails a later gate consumes nothing", async () => {
    await withFixture((f) => {
      const now = T0 + 5 * 60_000;
      const era = primed(f, IMPERATIVE_TOKENS, now);
      markCompactPending(f.root, SID, { eventId: "p", era, at: new Date(now + 500).toISOString() });
      expect(tokenPressureBannerFor(f.root, { now: now + 1000, ...seams(f) })).toBeNull();
      expect(guideDirectiveFor(f.root, SID, now + 1000)).toBeNull();
      expect(intelOf(f.root).lastImperativeEmittedAt).toBeNull();
    });
  });
});

describe("ISS-1263: session intel says why the line is quiet", () => {
  it("after a delivery, the diagnostic reports the rate limit and its reason", async () => {
    await withFixture((f) => {
      // handleSessionIntel samples at the real clock (it takes no `now`), so
      // the delivery is made at the real clock too.
      const now = Date.now();
      primed(f, IMPERATIVE_TOKENS, now);
      expect(applyBannerToMcpText("b", "md", tokenPressureBannerFor(f.root, { now, ...seams(f) }))).toMatch(/IMPERATIVE/);
      const md = handleSessionIntel({ cwd: f.root, format: "md", projectsDir: f.projects, userSettingsPath: f.userSettings });
      expect(md.output).toMatch(/Token pressure: ADVISORY \(imperative rate-limited: shown recently\)/);
      expect(md.output).toMatch(/- Why: .*rate-limited: the imperative was shown \d+ s ago; it repeats at most once every 10 minutes/);
    });
  });
});
