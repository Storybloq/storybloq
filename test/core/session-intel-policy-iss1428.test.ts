/**
 * ISS-1428 (handover lines slice C), commit 1: the plan's section 10 rows.
 * The context notice is decided once from the record, delivered once per band
 * per compaction era on whichever surface claims it first, answered by a
 * covering stamp, and caught up after a compaction the era did not cover.
 *
 * Every row runs through the real entry points (the prompt hook, the banner
 * pipelines, the guide directive, the handover stamp) over a real transcript,
 * except the rows marked pure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fsDefault, { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, readdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../src/core/init.js";
import { ensureCapture } from "../../src/core/session-intel/capture.js";
import { applyAssumedReset, applyBoundaryReset, claimNotice, noticeSeenOf, readPresenceRecord, stampHandover, type HandoverStampObservation } from "../../src/core/session-intel/presence-bridge.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { resolveSessionIntelConfig } from "../../src/core/session-intel/config.js";
import { decideFromRecord, effectiveThresholds, emptyBandReason, eraCovered, thresholdsForRecord, finalAllowed, noticeHead, renderNotice, resolveFinal, type FinalAction, type NoticeCandidate, type NoticeKind } from "../../src/core/session-intel/policy.js";
import { applyBannerToMcpText, applyStatusPushesToMcpText, deliverBanner, guideDirectiveFor, stampHandoverForCaller, statusPushesFor, tokenPressureBannerFor } from "../../src/core/session-intel/push.js";
import { handleSessionIntelPrompt } from "../../src/cli/commands/session-intel.js";
import { handleSessionAlert, redecideStoredSample, type SessionAlertOptions } from "../../src/cli/commands/session-alert.js";
import { readLineMemo, readLineMemoTip, writeLineMemo } from "../../src/core/handover-line-memo.js";
import type { CommandContext } from "../../src/cli/types.js";
import { handleArrangementUpdate } from "../../src/cli/commands/arrangement.js";
import { writeArrangementUnlocked, loadArrangementsSafe } from "../../src/core/arrangement-loader.js";
import { coordinateDuet } from "../../src/core/duet-coordination.js";
import { ArrangementPartySchema } from "../../src/models/arrangement.js";
import type { DuetOperation } from "../../src/models/duet.js";
import { handleHandoverContinue, handleHandoverCreate } from "../../src/cli/commands/handover.js";
import { registerAllTools, runMcpReadTool, runMcpWriteTool } from "../../src/mcp/tools.js";
import { runReadCommandWithRoot } from "../../src/cli/run.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../../src/core/presence-enrichment.js";
import { emptySessionIntel, shedDisplayText, type SessionIntelPresence, type SessionIntelSample } from "../../src/presence/session-intel-fields.js";
import { SID, assistantRecord, boundaryRecord, writeTranscript } from "./session-intel-fixtures.js";

// ---------------------------------------------------------------------------
// Fixture: a bound session driven sample by sample through the prompt hook
// ---------------------------------------------------------------------------

/**
 * The plan's point: 0.95 x 240,000 = 228,000. Imperative from 205,200 (90%),
 * compact-needed from 223,440 (98%), covered from 155,200 (68%), heal step
 * min(0.05 x 228,000, 25,000) = 11,400.
 */
const POINT = 228_000;
/** 0.925 x 1,000,000: imperative from 875,000 by headroom, compact-needed from 906,500. */
const WIDE = 925_000;

interface Fx { base: string; root: string; projects: string; userSettings: string }

async function makeFixture(window: number, ceilingFraction: number | null): Promise<Fx> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "si-policy-")));
  const root = join(base, "proj");
  mkdirSync(root, { recursive: true });
  await initProject(root, { name: "policy" });
  if (ceilingFraction !== null) setIntelConfig(root, { ceilingFraction });
  const projects = join(base, "home", ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  const userSettings = join(base, "home", ".claude", "settings.json");
  writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: window }));
  // The registered MCP handlers resolve ~/.claude from HOME, as in production.
  process.env.HOME = join(base, "home");
  return { base, root, projects, userSettings };
}

/** Merges keys into the project's `sessionIntel` config. */
function setIntelConfig(root: string, keys: Record<string, unknown>): void {
  const cfgPath = join(root, ".story", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { sessionIntel?: Record<string, unknown> };
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, sessionIntel: { ...cfg.sessionIntel, ...keys } }));
}

const fixtures: Fx[] = [];
/** Default: the plan's 228,000 point. `fixture(1_000_000)`: a 925,000 point at the default fraction. */
async function fixture(window?: number): Promise<Fx> {
  const f = await makeFixture(window ?? 240_000, window === undefined ? 0.95 : null);
  fixtures.push(f);
  return f;
}

const saved = { HOME: process.env.HOME, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, STORYBLOQ_CLIENT: process.env.STORYBLOQ_CLIENT, CLAUDE_PID: process.env.CLAUDE_PID };
beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  process.env.CLAUDE_PID = String(process.pid);
  delete process.env.STORYBLOQ_CLIENT;
  processEra.reset();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  processEra.reset();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const f of fixtures.splice(0)) rmSync(f.base, { recursive: true, force: true });
});

const encoded = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");
const intelOf = (root: string) => readPresenceRecord(root, SID)!.sessionIntel!;
const iso = (ms: number) => new Date(ms).toISOString();

interface Pushed { readonly label: string; readonly kind: NoticeKind; readonly text: string }

interface Sess {
  readonly f: Fx;
  readonly point: number;
  readonly lines: string[];
  readonly path: string;
  readonly era: string;
  t: number;
  readonly step: number;
  readonly pushed: Pushed[];
  readonly all: string[];
}

/** The kind of a pushed text, read from its wording. */
function kindOf(text: string): NoticeKind {
  if (/Write a handover now/.test(text)) return "ask";
  if (/covers this compaction: nothing to write|This compaction is covered by/.test(text)) return "covered";
  if (/handover suppressed by session rule/.test(text)) return "rule";
  if (/No handover that covers this compaction is recorded/.test(text)) return "uncovered";
  if (/No handover is recorded for this session for the auto-compaction that just happened/.test(text)) return "catch-up";
  throw new Error(`unclassified notice: ${text}`);
}

function start(f: Fx, point = POINT, t0 = Date.parse("2026-11-17T08:00:00Z"), step = 60_000): Sess {
  ensureCapture({ root: f.root, sessionId: SID, source: "startup", now: t0 - 30 * 60_000, userSettingsPath: f.userSettings });
  const lines: string[] = [];
  const path = writeTranscript(f.projects, encoded(f.root), SID, lines);
  return { f, point, lines, path, era: processEra.current()!.id, t: t0, step, pushed: [], all: [] };
}

/**
 * The real-time soft budgets (150 ms banner, 500 ms prompt hook) are not under
 * test here; at a machine load near 25 they returned null and failed rows that
 * test the policy. Every direct banner and hook call gets this one instead.
 */
const SOFT = 60_000;

const tokensAt = (s: Sess, pct: number) => Math.round((pct / 100) * s.point);

/** One assistant turn at `pct` of the point, then one prompt-hook call. */
function at(s: Sess, pct: number, label = `${pct}`): ReturnType<typeof handleSessionIntelPrompt> {
  s.t += s.step;
  s.lines.push(assistantRecord({ ts: iso(s.t - 1_000), read: tokensAt(s, pct) - 2 }));
  writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
  return hook(s, label);
}

/** One more prompt-hook call on the transcript as it stands. */
function hook(s: Sess, label: string): ReturnType<typeof handleSessionIntelPrompt> {
  const r = handleSessionIntelPrompt({ sessionId: SID, transcriptPath: s.path, now: s.t, cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings, softBudgetMs: SOFT });
  if (r.status === "emitted") {
    const text = (JSON.parse(r.output!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    s.pushed.push({ label, kind: kindOf(text), text });
    s.all.push(text);
  }
  return r;
}

/**
 * A compaction boundary in the transcript (the next sample reconciles it). Its
 * preTokens is the point itself: the resolver learns the point as the median
 * of this session's own boundaries, so any other value would move it.
 */
function boundary(s: Sess): void {
  s.t += s.step;
  s.lines.push(boundaryRecord({ ts: iso(s.t), pre: s.point }));
}

/** The caller's handover stamp, at the current sample's tokens. */
function handover(s: Sess, file = "2026-11-17-01-mine.md"): HandoverStampObservation {
  const out: HandoverStampObservation = { state: null };
  expect(stampHandover(s.f.root, SID, s.era, null, s.t, { out, cfg: resolveSessionIntelConfig(null) }, "bound", { handoverFile: file }).status).toBe("written");
  return out;
}

const kinds = (s: Sess) => s.pushed.map((p) => `${p.kind}@${p.label}`);

function patchIntel(root: string, fn: (i: SessionIntelPresence) => SessionIntelPresence): void {
  expect(applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: fn(b.sessionIntel!) })).status).toBe("written");
}

const RULE = { handovers: "elsewhere" as const, where: "watch log", setAt: "2026-11-17T08:00:00.000Z" };

// ---------------------------------------------------------------------------
// T1, T2, T3a: the issue's sequence
// ---------------------------------------------------------------------------

describe("T1 bands: 55, 72, 75, 91, 93, 99, boundary, 30", () => {
  it("pushes exactly ask at 91, uncovered at 99 and catch-up at 30, in that order", async () => {
    const s = start(await fixture());
    for (const p of [55, 72, 75, 91, 93, 99]) at(s, p);
    boundary(s);
    at(s, 30);
    expect(kinds(s)).toEqual(["ask@91", "uncovered@99", "catch-up@30"]);
    expect(intelOf(s.f.root).owed).toBeNull(); // the catch-up settled it
  });
});

describe("T2 back-off: a covering handover", () => {
  it("a handover at 75 gives one covered text at 91 naming the file, then nothing at 99 or after the boundary", async () => {
    const s = start(await fixture());
    for (const p of [55, 72, 75]) at(s, p);
    expect(handover(s)).toMatchObject({ covers: true, asked: false });
    for (const p of [91, 93, 99]) at(s, p);
    boundary(s);
    at(s, 30);
    expect(kinds(s)).toEqual(["covered@91"]);
    expect(s.pushed[0]!.text).toContain("Your handover 2026-11-17-01-mine.md covers this compaction: nothing to write. Keep working.");
    expect(s.pushed[0]!.text).not.toMatch(/Write/);
    expect(intelOf(s.f.root).owed).toBeNull(); // mutant: owed set when the era was stamped
  });

  it("a stamp with null tokens does not cover: ask at 91, and the stamp reply says nothing of covering", async () => {
    const f = await fixture();
    const s = start(f);
    at(s, 75);
    patchIntel(f.root, (i) => ({ ...i, handoverWrittenAt: iso(s.t), tokensAtHandover: null, handoverBoundaryAt: i.lastBoundaryAt, policyGen: i.policyGen + 1 }));
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
    expect(eraCovered(intelOf(f.root), effectiveThresholds(resolveSessionIntelConfig(null), null, POINT))).toBe(false);
  });

  it("a handover at 60 percent does not cover (60 is below 90 minus the headroom): ask at 91", async () => {
    const s = start(await fixture());
    at(s, 60);
    expect(handover(s)).toMatchObject({ covers: false });
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("a stamp of the previous era covers nothing in this one (mutant: coverage accepts a stamp of another era)", async () => {
    const s = start(await fixture());
    at(s, 75);
    handover(s);
    at(s, 91);
    boundary(s);
    at(s, 30);
    at(s, 91);
    expect(kinds(s)).toEqual(["covered@91", "ask@91"]);
  });

  it("a stamp a reset left in place (handoverBoundaryAt of an earlier era, as an older writer can leave) does not cover", async () => {
    const s = start(await fixture());
    at(s, 55);
    boundary(s);
    at(s, 30);
    const era = intelOf(s.f.root).lastBoundaryAt;
    expect(era).not.toBeNull();
    // Tokens that would cover, bound to no boundary: the era before this one.
    patchIntel(s.f.root, (i) => ({ ...i, handoverWrittenAt: iso(s.t - 120_000), tokensAtHandover: tokensAt(s, 80), handoverBoundaryAt: null, policyGen: i.policyGen + 1 }));
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("coverage is by the line, not by growth since the stamp: a stamp at 75 still covers at 99 (mutant: coverage by current growth)", async () => {
    const s = start(await fixture());
    at(s, 75);
    handover(s);
    at(s, 99);
    expect(kinds(s)).toEqual([]);
    expect(intelOf(s.f.root).compactNeededEmittedAt).toBeNull();
  });
});

describe("T3a rule (commit 1: a record fixture)", () => {
  it("one rule text at 91, nothing at 99, nothing after the boundary, no 'Write a handover', and the reset sets no owed", async () => {
    const f = await fixture();
    const s = start(f);
    at(s, 55);
    patchIntel(f.root, (i) => ({ ...i, rule: RULE, policyGen: i.policyGen + 1 }));
    for (const p of [72, 91, 93, 99]) at(s, p);
    boundary(s);
    at(s, 30);
    expect(kinds(s)).toEqual(["rule@91"]);
    expect(s.pushed[0]!.text).toContain("No handover is asked for here: handover suppressed by session rule (watch log). Keep working.");
    expect(s.all.join("\n")).not.toMatch(/Write a handover/);
    expect(intelOf(f.root)).toMatchObject({ owed: null, rule: RULE });
  });

  it("a record rule beside a covering handover still gives rule (mutant: the rule consulted after coverage)", async () => {
    const f = await fixture();
    const s = start(f);
    at(s, 75);
    handover(s);
    patchIntel(f.root, (i) => ({ ...i, rule: { ...RULE, where: null }, policyGen: i.policyGen + 1 }));
    at(s, 91);
    expect(kinds(s)).toEqual(["rule@91"]);
    // A rule whose display text was shed still says something true.
    expect(s.pushed[0]!.text).toContain("handover suppressed by session rule (set for this session)");
  });
});

// ---------------------------------------------------------------------------
// T4: no contradiction
// ---------------------------------------------------------------------------

describe("T4 no contradiction", () => {
  it("over five eras of mixed scripts no pushed text says 'no further handovers' or '/compact'", async () => {
    const s = start(await fixture());
    const scripts: Array<Array<number | "stamp" | "rule" | "unrule">> = [
      [55, 91, 99],
      [75, "stamp", 91, 99],
      [91, "stamp", 99],
      ["rule", 91, 99, "unrule"],
      [99, 100],
    ];
    for (const script of scripts) {
      for (const step of script) {
        if (step === "stamp") handover(s);
        else if (step === "rule") patchIntel(s.f.root, (i) => ({ ...i, rule: RULE, policyGen: i.policyGen + 1 }));
        else if (step === "unrule") patchIntel(s.f.root, (i) => ({ ...i, rule: null, policyGen: i.policyGen + 1 }));
        else at(s, step);
      }
      boundary(s);
      at(s, 30);
    }
    expect(s.pushed.length).toBeGreaterThanOrEqual(8);
    for (const text of s.all) expect(text).not.toMatch(/no further handovers|\/compact/i);
  });

  it("the source never says either phrase: session-intel core, the session-intel command, the reply strings and the skill", () => {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const files = [
      ...(readdirSync(join(src, "core", "session-intel"), { recursive: true }) as string[]).map((r) => join(src, "core", "session-intel", r)),
      join(src, "cli", "commands", "session-intel.ts"),
      join(src, "core", "output-formatter.ts"),
      ...(readdirSync(join(src, "skill"), { recursive: true }) as string[]).map((r) => join(src, "skill", r)),
    ].filter((p) => /\.(ts|md)$/.test(p));
    expect(files.length).toBeGreaterThan(10);
    // `/compact` as a command, not the tail of `ok/advisory/imperative/compact-needed`.
    const hits = files.filter((p) => /no further handovers|(^|[^A-Za-z0-9/])\/compact\b/im.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T5, T6, T6b, T6c: one claim
// ---------------------------------------------------------------------------

describe("T5 bursts", () => {
  it("ten prompt-hook calls at 91 push one; ten at 99 push one; ten at 103 push none (mutant: uncovered not claimed)", async () => {
    const s = start(await fixture());
    for (const p of [91, 99, 103]) {
      at(s, p);
      for (let i = 1; i < 10; i++) { s.t += 1_000; hook(s, `${p}`); }
    }
    expect(kinds(s)).toEqual(["ask@91", "uncovered@99"]);
  });
});

describe("T6 one claim across surfaces", () => {
  /** Real clock: the registered handlers and the MCP pipelines take no `now`. */
  async function realClock(pct: number): Promise<Sess> {
    const s = start(await fixture(), POINT, Date.now() - 10_000, 1_000);
    at(s, pct);
    expect(s.pushed).toEqual([]);
    return s;
  }

  it("an MCP write tool result carries ask first; then the prompt hook and the guide are silent (mutant: a claim per surface)", async () => {
    // The hook samples at 72 a minute ago, so the write tool's banner takes a fresh sample.
    const s = start(await fixture(), POINT, Date.now() - 61_000, 1_000);
    at(s, 72);
    s.lines.push(assistantRecord({ ts: iso(Date.now() - 500), read: tokensAt(s, 91) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    const write = await runMcpWriteTool(s.f.root, async () => ({ output: "written" }));
    expect(write.content[0]!.text).toMatch(/^Context: [\s\S]*Write a handover now with storybloq_handover_create[\s\S]*\n\nwritten$/);
    s.t = Date.now();
    expect(hook(s, "after").status).toBe("silent");
    expect(guideDirectiveFor(s.f.root, SID, Date.now())).toBeNull();
    expect(s.pushed).toEqual([]);
  });

  it("the reverse order: the hook carries ask; then the MCP write result and the guide carry nothing", async () => {
    const s = await realClock(72);
    s.t = Date.now() - 1_000;
    s.lines.push(assistantRecord({ ts: iso(s.t - 500), read: tokensAt(s, 91) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    hook(s, "91");
    expect(kinds(s)).toEqual(["ask@91"]);
    const write = await runMcpWriteTool(s.f.root, async () => ({ output: "written" }));
    expect(write.content[0]!.text).toBe("written");
    expect(guideDirectiveFor(s.f.root, SID, Date.now())).toBeNull();
  });
});

describe("T6b delayed claims (commit 1: by fixture)", () => {
  async function decidedAsk(): Promise<{ s: Sess; banner: NonNullable<ReturnType<typeof tokenPressureBannerFor>> }> {
    const s = start(await fixture());
    at(s, 60);
    handover(s); // a non-covering stamp, so a heal has something to clear
    at(s, 91);
    // The hook delivered ask; re-arm it by fixture so a banner decides ask afresh.
    patchIntel(s.f.root, (i) => ({ ...i, lastImperativeEmittedAt: null, noticeTokens: null, policyGen: i.policyGen + 1 }));
    const banner = tokenPressureBannerFor(s.f.root, { now: s.t, cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings, softBudgetMs: SOFT });
    expect(banner).toMatchObject({ notice: "ask" });
    return { s, banner: banner! };
  }

  it("(i) a rule written to the record before the claim: refused, nothing delivered", async () => {
    const { s, banner } = await decidedAsk();
    patchIntel(s.f.root, (i) => ({ ...i, rule: RULE, policyGen: i.policyGen + 1 }));
    expect(deliverBanner(banner)).toBeNull();
    expect(intelOf(s.f.root).lastImperativeEmittedAt).toBeNull();
  });

  it("(ii) a heal before the claim: refused, nothing delivered", async () => {
    const { s, banner } = await decidedAsk();
    const gen = intelOf(s.f.root).policyGen;
    at(s, 30); // more than the heal step below the 60 percent stamp: the stamp heals
    expect(intelOf(s.f.root)).toMatchObject({ handoverWrittenAt: null, tokensAtHandover: null });
    expect(intelOf(s.f.root).policyGen).toBeGreaterThan(gen);
    expect(deliverBanner(banner)).toBeNull();
    expect(intelOf(s.f.root).lastImperativeEmittedAt).toBeNull();
  });

  it("(iii) a stamp before the claim: refused, nothing delivered", async () => {
    const { s, banner } = await decidedAsk();
    handover(s, "2026-11-17-02-late.md");
    expect(deliverBanner(banner)).toBeNull();
    expect(intelOf(s.f.root).lastImperativeEmittedAt).toBeNull();
  });

  it("policyGen alone refuses: the same record with only the generation advanced (mutant: policyGen left out of seen)", async () => {
    const { s, banner } = await decidedAsk();
    patchIntel(s.f.root, (i) => ({ ...i, policyGen: i.policyGen + 1 }));
    expect(deliverBanner(banner)).toBeNull();
  });
});

describe("T6c the locked sample decides", () => {
  const opts = (s: Sess) => ({ now: s.t, cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings, softBudgetMs: SOFT });
  /** Writes a sample straight into the record, as a Stop hook would. */
  function landSample(s: Sess, pct: number): void {
    s.t += 1_000;
    s.lines.push(assistantRecord({ ts: iso(s.t - 500), read: tokensAt(s, pct) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    // A banner refresh at a later clock persists the new sample; its own decision is discarded.
    tokenPressureBannerFor(s.f.root, { ...opts(s), now: s.t + 31_000 });
  }

  it("ask decided at 91, a 30 percent sample lands first: refused with no generation change (mutant: re-decision removed)", async () => {
    const s = start(await fixture());
    s.lines.push(assistantRecord({ ts: iso(s.t), read: tokensAt(s, 91) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    const banner = tokenPressureBannerFor(s.f.root, opts(s))!;
    expect(banner.notice).toBe("ask");
    const gen = intelOf(s.f.root).policyGen;
    landSample(s, 30);
    expect(intelOf(s.f.root).lastSample?.rawState).toBe("ok");
    expect(intelOf(s.f.root).policyGen).toBe(gen);
    expect(deliverBanner(banner)).toBeNull();
    expect(intelOf(s.f.root).lastImperativeEmittedAt).toBeNull();
  });

  it("a 99 percent sample lands first: the ask is refused and the next call delivers uncovered", async () => {
    const s = start(await fixture());
    s.lines.push(assistantRecord({ ts: iso(s.t), read: tokensAt(s, 91) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    const banner = tokenPressureBannerFor(s.f.root, opts(s))!;
    landSample(s, 99);
    expect(deliverBanner(banner)).toBeNull();
    const next = deliverBanner(tokenPressureBannerFor(s.f.root, { ...opts(s), now: s.t + 31_000 }));
    expect(next).toMatchObject({ notice: "uncovered" });
  });

  it("a newer sample in the same band (92) grants the claim, and noticeTokens is the 92 percent sample's (mutant: re-decision on captured facts)", async () => {
    const s = start(await fixture());
    s.lines.push(assistantRecord({ ts: iso(s.t), read: tokensAt(s, 91) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    const banner = tokenPressureBannerFor(s.f.root, opts(s))!;
    landSample(s, 92);
    expect(deliverBanner(banner)).toMatchObject({ notice: "ask" });
    expect(intelOf(s.f.root).noticeTokens).toBe(tokensAt(s, 92));
  });
});

// ---------------------------------------------------------------------------
// T7 heal, T8 after a compaction, T9 long-turn gap, T10 shared folder
// ---------------------------------------------------------------------------

describe("T7 heal (mutants: heal removed; heal by band instead of by fall)", () => {
  it("ask at 91, 30 with no boundary record, 91 again: ask again", async () => {
    const s = start(await fixture());
    for (const p of [91, 30, 91]) at(s, p);
    expect(kinds(s)).toEqual(["ask@91", "ask@91"]);
    expect(intelOf(s.f.root).lastBoundaryAt).toBeNull();
  });

  it("a handover at 91, 30 with no boundary record, 91 again: ask (the old stamp no longer covers)", async () => {
    const s = start(await fixture());
    at(s, 91);
    handover(s);
    for (const p of [30, 91]) at(s, p);
    expect(kinds(s)).toEqual(["ask@91", "ask@91"]);
  });

  it("ask at 91, then imperativePct raised to 0.95 with tokens still rising: no second ask at 96", async () => {
    const s = start(await fixture());
    at(s, 91);
    setIntelConfig(s.f.root, { imperativePct: 0.95 });
    for (const p of [93, 96, 97]) at(s, p);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("a fall smaller than the heal step heals nothing; a larger one inside the era allows one more notice", async () => {
    // Heal step on 228,000: min(0.05 x 228,000, 25,000) = 11,400 tokens.
    const s = start(await fixture());
    const t91 = tokensAt(s, 91);
    at(s, 91);
    const back = (tokens: number, label: string) => {
      s.t += s.step;
      s.lines.push(assistantRecord({ ts: iso(s.t - 1_000), read: tokens - 2 }));
      writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
      hook(s, label);
    };
    back(t91 - 11_000, "small-fall");
    at(s, 91, "91-again");
    expect(kinds(s)).toEqual(["ask@91"]);
    back(t91 - 12_000, "large-fall");
    at(s, 91, "91-healed");
    expect(kinds(s)).toEqual(["ask@91", "ask@91-healed"]);
  });
});

describe("T8 after a compaction", () => {
  it("first samples at 70, 75, 80 push nothing when the era before was stamped, or unstamped but never reached the line", async () => {
    for (const before of [[75, "stamp", 91], [55, 85]] as const) {
      const s = start(await fixture());
      for (const step of before) if (step === "stamp") handover(s); else at(s, step);
      const pushedBefore = s.pushed.length;
      boundary(s);
      for (const p of [70, 75, 80]) at(s, p);
      expect(s.pushed.slice(pushedBefore), JSON.stringify(before)).toEqual([]);
    }
  });

  it("an unstamped era that reached the line: exactly one catch-up, at the first sample after the boundary", async () => {
    const s = start(await fixture());
    at(s, 91);
    boundary(s);
    for (const p of [70, 75, 80]) at(s, p);
    expect(kinds(s)).toEqual(["ask@91", "catch-up@70"]);
    expect(s.pushed[1]!.text).toBe("[storybloq] No handover is recorded for this session for the auto-compaction that just happened. If you wrote one, nothing more is needed. Otherwise write one now with storybloq_handover_create, from the summary above, before new work; then keep working.");
  });
});

describe("T9 long-turn gap", () => {
  it("the first sample of an era at 99 with no stamp pushes uncovered and never the ask text later in that era", async () => {
    const s = start(await fixture());
    for (const p of [99, 99.5, 100]) at(s, p);
    expect(kinds(s)).toEqual(["uncovered@99"]);
    expect(intelOf(s.f.root)).toMatchObject({ lastImperativeEmittedAt: expect.any(String), compactNeededEmittedAt: expect.any(String) });
  });
});

describe("T10 no evidence beyond the stamp (the shared-folder row)", () => {
  it("a peer's newer handover in the shared folder never stamps, never clears owed, never silences a notice, and no text says a stamp did not land", async () => {
    const s = start(await fixture());
    const dir = join(s.f.root, ".story", "handovers");
    mkdirSync(dir, { recursive: true });
    at(s, 85);
    writeFileSync(join(dir, "2026-11-17-09-peer.md"), "# Peer handover\n");
    at(s, 91);
    writeFileSync(join(dir, "2026-11-17-10-peer.md"), "# Peer handover again\n");
    boundary(s);
    at(s, 30);
    expect(kinds(s)).toEqual(["ask@91", "catch-up@30"]);
    for (const text of s.all) expect(text).not.toMatch(/did not land|stamp/i);
    const after = intelOf(s.f.root);
    expect(after).toMatchObject({ handoverWrittenAt: null, handoverFile: null, owed: null });
  });
});

// ---------------------------------------------------------------------------
// T12 (config row), T13, T14, T15, T16
// ---------------------------------------------------------------------------

describe("T12 thresholds (commit 1: the project config row)", () => {
  it("on a 925,000 point a headroom of 10,000 empties the imperative band: nothing at 95 or 97, uncovered at 98, and reason says the band is empty", async () => {
    const f = await fixture(1_000_000);
    setIntelConfig(f.root, { imperativeHeadroomTokens: 10_000 });
    const s = start(f, WIDE);
    const r95 = at(s, 95);
    at(s, 97);
    expect(s.pushed).toEqual([]);
    expect(r95.result?.pressure?.reason).toContain("the imperative band is empty");
    // 832,500 in use with 92,500 left is never asked (mutant: the headroom clause dropped when the band is empty).
    at(s, 90);
    at(s, 98);
    expect(kinds(s)).toEqual(["uncovered@98"]);
  });
});

describe("T13 reply through the CLI and the registered MCP tool", () => {
  const KEEP = "Keep working in this same turn; do not stop, defer the next step, or ask the user whether to continue.";
  function mcpTool(root: string) {
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
    registerAllTools({ registerTool: (name: string, _c: unknown, h: never) => { tools.set(name, h); } } as never, root);
    return tools.get("storybloq_handover_create")!;
  }
  /** The reply sentence, whatever lines (the Git line on MCP) surround it. */
  const replyLine = (out: string) => out.split("\n").find((l) => l.startsWith("Handover recorded"));

  it("covers, after the notice: CLI and MCP give the same exact sentence, with the numbers", async () => {
    const s = start(await fixture(), POINT, Date.now() - 10_000, 1_000);
    s.t = Date.now() - 2_000;
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
    const tokens = tokensAt(s, 91).toLocaleString("en-US");
    const want = `Handover recorded: it covers this compaction and the notice will not ask again before it. Written on the context-pressure notice (${tokens} of about 228,000 tokens in use, 91%). ${KEEP}`;
    const cli = await handleHandoverCreate("# H\n", "cli", "md", s.f.root, { projectsDir: s.f.projects });
    expect(replyLine(cli.output as string)).toBe(want);
    const mcp = await mcpTool(s.f.root)({ content: "# H\n", slug: "mcp" });
    expect(replyLine(mcp.content[0]!.text)).toBe(want);
  });

  it("a landed stamp that does not cover: the written-well-before sentence", async () => {
    const s = start(await fixture(), POINT, Date.now() - 10_000, 1_000);
    s.t = Date.now() - 2_000;
    at(s, 60);
    const cli = await handleHandoverCreate("# H\n", "early", "md", s.f.root, { projectsDir: s.f.projects });
    expect(replyLine(cli.output as string)).toBe(`Handover recorded. It was written well before the compaction point (${tokensAt(s, 60).toLocaleString("en-US")} of about 228,000 tokens in use), so the notice may still ask for one nearer to it. Keep working in this same turn.`);
  });

  it("the empty-band configuration: a stamp at 880,000 on a 925,000 point is past the compact line (878,750) and gets the non-covering reply (mutant: a stamp past the compact line counted as covering)", async () => {
    const f = await fixture(1_000_000);
    // Imperative line max(0.9 x 925,000, 925,000 - 10,000) = 915,000; compact line 0.95 x 925,000 = 878,750; covering needs 905,000.
    setIntelConfig(f.root, { imperativeHeadroomTokens: 10_000, compactNeededPct: 0.95 });
    const s = start(f, WIDE, Date.now() - 10_000, 1_000);
    s.t = Date.now() - 2_000;
    s.lines.push(assistantRecord({ ts: iso(s.t - 500), read: 880_000 - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    hook(s, "880k");
    expect(intelOf(f.root).lastSample!.rawState).toBe("compact-needed");
    // The stamp's own observation, as the CLI reads it: past the compact line, not covering.
    const r = stampHandoverForCaller(s.f.root, { cwd: s.f.root, projectsDir: s.f.projects, handoverFile: "2026-11-17-00-probe.md" });
    expect(r.status).toBe("stamped");
    expect(r.status === "stamped" ? r.observation : null).toMatchObject({ covers: false, pastCompact: true, tokens: 880_000 });
    const th = thresholdsForRecord(intelOf(f.root), resolveSessionIntelConfig({ imperativeHeadroomTokens: 10_000, compactNeededPct: 0.95 }));
    expect({ bandEmpty: th.bandEmpty, compactLine: th.compactLine }).toEqual({ bandEmpty: true, compactLine: 878_750 });
    const cli = await handleHandoverCreate("# H\n", "empty-band", "md", s.f.root, { projectsDir: s.f.projects });
    expect(replyLine(cli.output as string)).toBe("Handover recorded. It was written well before the compaction point (880,000 of about 925,000 tokens in use), so the notice may still ask for one nearer to it. Keep working in this same turn.");
  });

  it("pen condition (ladder ruling): with the display text shed, the compact line still reports coverage from the decision fields alone", async () => {
    const f = await fixture();
    const s = start(f);
    at(s, 75);
    expect(stampHandover(f.root, SID, s.era, null, s.t, undefined, "bound", { coveredBy: "ops/watch.md#2026-11-17", handoverFile: null }).status).toBe("written");
    patchIntel(f.root, (i) => shedDisplayText(i));
    expect(intelOf(f.root)).toMatchObject({ coveredBy: null, handoverFile: null });
    // At 91 the covered text falls back to a sentence that stays true without a name.
    at(s, 91);
    expect(kinds(s)).toEqual(["covered@91"]);
    expect(s.pushed[0]!.text).toMatch(/ Your handover covers this compaction: nothing to write\. Keep working\.$/);
    // At the compact line nothing is pushed: coverage holds from tokensAtHandover and the era.
    at(s, 99);
    expect(kinds(s)).toEqual(["covered@91"]);
    // A stamp at the compact line after the shed: the reply is the covering one.
    const out: HandoverStampObservation = { state: null };
    stampHandover(f.root, SID, s.era, null, s.t, { out, cfg: resolveSessionIntelConfig(null) });
    expect(out).toMatchObject({ covers: true, pastCompact: true });
    // Without the decision fields, nothing says covered.
    patchIntel(f.root, (i) => ({ ...i, tokensAtHandover: null, compactNeededEmittedAt: null, policyGen: i.policyGen + 1 }));
    at(s, 99.5);
    expect(kinds(s)).toEqual(["covered@91", "uncovered@99.5"]);
  });
});

describe("T14 advisory (mutant: the advisory banner pushed on a non-status tool)", () => {
  it("at 72 a non-status MCP result and a non-status CLI read carry nothing; status carries the numbers alone twice in a row", async () => {
    const s = start(await fixture(), POINT, Date.now() - 10_000, 1_000);
    s.t = Date.now() - 2_000;
    at(s, 72);
    const read = await runMcpReadTool(s.f.root, () => ({ output: "hello" }));
    expect(read.content[0]!.text).toBe("hello");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const origCwd = process.cwd();
    process.chdir(s.f.root);
    try {
      await runReadCommandWithRoot("md", s.f.root, () => ({ output: "body" }));
    } finally {
      process.chdir(origCwd);
    }
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toBe("body\n");
    for (let i = 0; i < 2; i++) {
      const p = statusPushesFor(s.f.root, { cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings });
      const text = applyStatusPushesToMcpText("body", "md", p.banner, p.usage);
      expect(text, `status ${i}`).toMatch(/^Context: [0-9,]+ tokens in use; auto-compaction is expected near 228,000 \(setting, high confidence\); about [0-9,]+ left \(72%\)\.\n\nbody$/);
    }
  });

  it("apart from catch-up, no text delivered below the imperative line contains 'handover'", async () => {
    const s = start(await fixture());
    for (const p of [55, 72, 75, 85, 89]) at(s, p);
    boundary(s);
    for (const p of [30, 72, 85]) at(s, p);
    expect(s.pushed).toEqual([]);
  });
});

describe("T15 wide window (mutant: coverage ignores the line bound)", () => {
  it("on a 925,000 point a handover at 72 percent does not cover: ask at 95; a handover at 90 percent covers", async () => {
    const a = start(await fixture(1_000_000), WIDE);
    at(a, 72);
    expect(handover(a)).toMatchObject({ covers: false });
    at(a, 95);
    expect(kinds(a)).toEqual(["ask@95"]);
    const b = start(await fixture(1_000_000), WIDE);
    at(b, 90);
    expect(handover(b)).toMatchObject({ covers: true });
    at(b, 95);
    expect(kinds(b)).toEqual(["covered@95"]);
  });
});

describe("T16 guide", () => {
  it("the directive is the shared text, once per era, and never after another surface claimed", async () => {
    const s = start(await fixture());
    s.lines.push(assistantRecord({ ts: iso(s.t), read: tokensAt(s, 91) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    tokenPressureBannerFor(s.f.root, { now: s.t, cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings, softBudgetMs: SOFT }); // persists the sample, claims nothing
    const sample = intelOf(s.f.root).lastSample!;
    const directive = guideDirectiveFor(s.f.root, SID, s.t);
    expect(directive).toBe(renderNotice("ask", { used: sample.contextTokens!, point: sample.ceiling!, source: sample.ceilingSource, confidence: sample.ceilingConfidence }, "guide"));
    expect(guideDirectiveFor(s.f.root, SID, s.t + 1)).toBeNull();
    at(s, 99);
    expect(kinds(s)).toEqual(["uncovered@99"]);
    expect(guideDirectiveFor(s.f.root, SID, s.t + 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T17 cost
// ---------------------------------------------------------------------------

describe("T17 cost (mutant: the hook lists the folder)", () => {
  type Counts = { readdir: string[]; lstat: string[]; read: string[] };
  function counting(): Counts {
    const c: Counts = { readdir: [], lstat: [], read: [] };
    const wrap = <K extends "readdirSync" | "lstatSync" | "readFileSync">(name: K, into: string[]) => {
      const orig = fsDefault[name] as (...a: unknown[]) => unknown;
      vi.spyOn(fsDefault, name).mockImplementation(((...a: unknown[]) => { into.push(String(a[0])); return orig.apply(fsDefault, a); }) as never);
    };
    wrap("readdirSync", c.readdir);
    wrap("lstatSync", c.lstat);
    wrap("readFileSync", c.read);
    syncBuiltinESMExports();
    return c;
  }
  function stop(): void { vi.restoreAllMocks(); syncBuiltinESMExports(); }
  const touches = (c: Counts, part: string) => [...c.readdir, ...c.lstat, ...c.read].filter((p) => p.includes(part));

  it("ok, and an emitting path, touch no handover and no arrangement; 300 handovers cost what none cost", async () => {
    const totals: number[] = [];
    for (const files of [0, 300]) {
      const s = start(await fixture());
      const dir = join(s.f.root, ".story", "handovers");
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < files; i++) writeFileSync(join(dir, `2026-11-17-${String(i).padStart(3, "0")}-h.md`), "# h\n");
      s.t += s.step;
      s.lines.push(assistantRecord({ ts: iso(s.t - 1_000), read: tokensAt(s, 30) - 2 }));
      writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
      let c = counting();
      hook(s, "30");
      stop();
      expect(touches(c, join(".story", "handovers")), `ok, ${files}`).toEqual([]);
      expect(touches(c, join(".story", "arrangements")), `ok, ${files}`).toEqual([]);
      const okTotal = c.readdir.length + c.lstat.length + c.read.length;
      s.t += s.step;
      s.lines.push(assistantRecord({ ts: iso(s.t - 1_000), read: tokensAt(s, 91) - 2 }));
      writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
      c = counting();
      hook(s, "91");
      stop();
      expect(kinds(s)).toEqual(["ask@91"]);
      expect(touches(c, join(".story", "handovers")), `emit, ${files}`).toEqual([]);
      expect(touches(c, join(".story", "arrangements")), `emit, ${files}`).toEqual([]);
      totals.push(okTotal + c.readdir.length + c.lstat.length + c.read.length);
    }
    expect(totals[1]).toBe(totals[0]);
  });
});

// ---------------------------------------------------------------------------
// T18 record (reset table, generation), T19 numbers first
// ---------------------------------------------------------------------------

describe("T18 record: the reset table and the generation", () => {
  const SAMPLE = (rawState: SessionIntelSample["rawState"]) => ({ rawState, contextTokens: 210_000, ceiling: POINT } as unknown as SessionIntelSample);
  const base = (over: Partial<SessionIntelPresence> = {}): SessionIntelPresence => ({
    ...emptySessionIntel(),
    lastBoundaryAt: "2026-11-17T07:00:00.000Z",
    lastImperativeEmittedAt: "2026-11-17T07:30:00.000Z",
    compactNeededEmittedAt: "2026-11-17T07:40:00.000Z",
    noticeTokens: 400_000,
    policyGen: 7,
    ...over,
  });

  it("both resets clear the marks, noticeTokens and the stamp's display text, keep rule, advance policyGen, and set owed by the table", () => {
    for (const reset of [(i: SessionIntelPresence) => applyBoundaryReset(i, "2026-11-17T08:00:00.000Z"), (i: SessionIntelPresence) => applyAssumedReset(i, "2026-11-17T08:00:00.000Z")]) {
      const reached = reset(base());
      expect(reached).toMatchObject({ lastImperativeEmittedAt: null, compactNeededEmittedAt: null, noticeTokens: null, policyGen: 8, owed: { boundaryAt: "2026-11-17T08:00:00.000Z", eraStartAt: "2026-11-17T07:00:00.000Z" } });
      // Reached by the sample alone, with no mark.
      expect(reset(base({ lastImperativeEmittedAt: null, compactNeededEmittedAt: null, lastSample: SAMPLE("compact-needed") })).owed).not.toBeNull();
      // Never reached: no owed.
      expect(reset(base({ lastImperativeEmittedAt: null, compactNeededEmittedAt: null, lastSample: SAMPLE("advisory") })).owed).toBeNull();
      // Stamped for the ending era: no owed, and the display text goes with the stamp.
      const stamped = reset(base({ handoverWrittenAt: "2026-11-17T07:35:00.000Z", tokensAtHandover: 380_000, handoverBoundaryAt: "2026-11-17T07:00:00.000Z", handoverFile: "x.md", coveredBy: "y" }));
      expect(stamped).toMatchObject({ owed: null });
      // A rule: no owed, and the rule survives.
      expect(reset(base({ rule: RULE }))).toMatchObject({ owed: null, rule: RULE });
    }
  });

  it("policyGen advances on a claim and on a stamp, and on nothing a plain sample does", async () => {
    const s = start(await fixture());
    at(s, 72);
    const g0 = intelOf(s.f.root).policyGen;
    at(s, 75);
    expect(intelOf(s.f.root).policyGen).toBe(g0);
    at(s, 91);
    expect(intelOf(s.f.root).policyGen).toBe(g0 + 1);
    handover(s);
    expect(intelOf(s.f.root).policyGen).toBe(g0 + 2);
  });
});

describe("T19 numbers first (pure)", () => {
  const F = (used: number, point: number) => ({ used, point, source: "setting" as const, confidence: "high" as const });

  it("H is exact for a point above, at and below the tokens in use", () => {
    expect(noticeHead(F(207_480, 228_000))).toBe("Context: 207,480 tokens in use; auto-compaction is expected near 228,000 (setting, high confidence); about 20,520 left (91%).");
    expect(noticeHead(F(228_000, 228_000))).toBe("Context: 228,000 tokens in use; auto-compaction is expected near 228,000 (setting, high confidence); 0 past the expected point (100%).");
    expect(noticeHead(F(235_000, 228_000))).toBe("Context: 235,000 tokens in use; auto-compaction is expected near 228,000 (setting, high confidence); 7,000 past the expected point (103%).");
    expect(noticeHead({ ...F(1, 2), confidence: null })).toBe("Context: 1 tokens in use; auto-compaction is expected near 2 (setting); about 1 left (50%).");
  });

  it("every notice starts with H except catch-up, on every surface", () => {
    const f = F(207_480, 228_000);
    for (const surface of ["hook", "mcp", "cli", "guide"] as const) {
      const prefix = surface === "hook" ? "[storybloq] " : "";
      for (const kind of ["ask", "covered", "rule", "uncovered"] as const) expect(renderNotice(kind, f, surface).startsWith(prefix + noticeHead(f)), `${kind}/${surface}`).toBe(true);
      expect(renderNotice("catch-up", f, surface).startsWith(`${prefix}No handover is recorded`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The pure tables
// ---------------------------------------------------------------------------

describe("pure tables", () => {
  const cfg = resolveSessionIntelConfig(null);
  const th = effectiveThresholds(cfg, null, POINT);
  const sampleOf = (rawState: SessionIntelSample["rawState"]): SessionIntelSample => ({ rawState, state: rawState, contextTokens: 210_000, ceiling: POINT } as unknown as SessionIntelSample);

  it("effectiveThresholds: the later of share and headroom, the compact line, and the empty band", () => {
    expect(th).toMatchObject({ imperativeLine: 205_200, compactLine: 0.98 * POINT, bandEmpty: false, point: POINT });
    expect(effectiveThresholds(cfg, null, WIDE)).toMatchObject({ imperativeLine: 875_000, bandEmpty: false });
    const empty = effectiveThresholds(resolveSessionIntelConfig({ imperativeHeadroomTokens: 10_000 }), null, WIDE);
    expect(empty).toMatchObject({ imperativeLine: 915_000, compactLine: 906_500, bandEmpty: true });
    expect(emptyBandReason(empty)).toContain("the imperative band is empty");
    expect(emptyBandReason(th)).toBeNull();
    expect(effectiveThresholds(cfg, null, null)).toMatchObject({ imperativeLine: null, compactLine: null, bandEmpty: false, point: null });
  });

  it("eraCovered, clause by clause", () => {
    const stamp = (over: Partial<SessionIntelPresence>) => ({ ...emptySessionIntel(), handoverWrittenAt: "t", handoverBoundaryAt: null, lastBoundaryAt: null, tokensAtHandover: 155_200, ...over });
    expect(eraCovered(stamp({}), th)).toBe(true); // exactly line - headroom
    expect(eraCovered(stamp({ tokensAtHandover: 155_199 }), th)).toBe(false);
    expect(eraCovered(stamp({ tokensAtHandover: null }), th)).toBe(false);
    expect(eraCovered(stamp({ handoverWrittenAt: null }), th)).toBe(false);
    expect(eraCovered(stamp({ lastBoundaryAt: "b" }), th)).toBe(false);
    expect(eraCovered(stamp({ lastBoundaryAt: "b", handoverBoundaryAt: "b" }), th)).toBe(true);
    expect(eraCovered(stamp({}), effectiveThresholds(cfg, null, null))).toBe(false);
  });

  it("decideFromRecord over (raw state, marks, covered, rule, owed)", () => {
    const owed = { boundaryAt: "b", eraStartAt: null };
    const cover = { handoverWrittenAt: "t", tokensAtHandover: 200_000 };
    const rows: Array<[SessionIntelSample["rawState"] | null, Partial<SessionIntelPresence>, NoticeCandidate]> = [
      [null, {}, "none"],
      [null, { owed }, "none"],
      ["ok", {}, "none"],
      ["ok", { owed }, "catch-up"],
      ["advisory", { owed }, "catch-up"],
      ["unknown", { owed }, "none"],
      ["imperative", {}, "ask"],
      ["imperative", cover, "covered"],
      ["imperative", { rule: RULE }, "rule"],
      ["imperative", { ...cover, rule: RULE }, "rule"],
      ["imperative", { lastImperativeEmittedAt: "t" }, "none"],
      ["imperative", { lastImperativeEmittedAt: "t", rule: RULE }, "none"],
      ["compact-needed", {}, "uncovered"],
      ["compact-needed", cover, "none"],
      ["compact-needed", { rule: RULE }, "none"],
      ["compact-needed", { compactNeededEmittedAt: "t" }, "none"],
      ["compact-needed", { lastImperativeEmittedAt: "t" }, "uncovered"],
    ];
    for (const [raw, over, want] of rows) {
      const intel = { ...emptySessionIntel(), ...over, lastSample: raw === null ? null : sampleOf(raw) } as SessionIntelPresence;
      expect(decideFromRecord(intel, cfg), `${raw} ${JSON.stringify(over)}`).toBe(want);
    }
  });

  it("resolveFinal and finalAllowed are the same table", () => {
    const rule = { arrangementId: "a-1", where: null };
    const table: Array<[NoticeCandidate, FinalAction, FinalAction]> = [
      ["none", null, null],
      ["covered", "covered", "covered"],
      ["rule", "rule", "rule"],
      ["ask", "ask", "rule"],
      ["uncovered", "uncovered", null],
      ["catch-up", "catch-up", "settle"],
    ];
    const all: FinalAction[] = ["ask", "covered", "rule", "uncovered", "catch-up", "settle", null];
    for (const [candidate, without, withRule] of table) {
      expect(resolveFinal(candidate, null), candidate).toBe(without);
      expect(resolveFinal(candidate, rule), candidate).toBe(withRule);
      const allowed = all.filter((a) => finalAllowed(candidate, a));
      expect(allowed.sort(), candidate).toEqual([without, withRule].filter((a): a is NonNullable<FinalAction> => a !== null).filter((a, i, xs) => xs.indexOf(a) === i).sort());
    }
  });

  it("a settle is claimable on catch-up and never on ask (mutant: finalAllowed accepts any pair)", async () => {
    const s = start(await fixture());
    at(s, 91);
    boundary(s);
    s.t += s.step;
    s.lines.push(assistantRecord({ ts: iso(s.t - 1_000), read: tokensAt(s, 30) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    tokenPressureBannerFor(s.f.root, { now: s.t, cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings, softBudgetMs: SOFT }); // persists, does not deliver
    const intel = intelOf(s.f.root);
    expect(decideFromRecord(intel, cfg)).toBe("catch-up");
    expect(claimNotice(s.f.root, SID, noticeSeenOf(intel), "catch-up", "ask", s.t, cfg)).toBe(false);
    expect(claimNotice(s.f.root, SID, noticeSeenOf(intel), "catch-up", "settle", s.t, cfg)).toBe(true);
    expect(intelOf(s.f.root).owed).toBeNull();
  });
});

// Keeps the MCP banner pipeline import live for the T6 rows' shared helpers.
void applyBannerToMcpText;

// ---------------------------------------------------------------------------
// Commit 2: `storybloq session alert` and the arrangement party rule
// ---------------------------------------------------------------------------

const ARR = "a-0123456789abcdef";
const PEN_TASK = "pen-task";

const alert = (s: Sess, o: Omit<SessionAlertOptions, "root" | "now"> = {}) => handleSessionAlert({ root: s.f.root, now: s.t, ...o });

/** A schema-valid arrangement with this session as the Claude worker; `rule` lands on that party. */
async function arrangement(root: string, rule?: { handovers: "elsewhere"; where?: string }): Promise<void> {
  await writeArrangementUnlocked({
    id: ARR,
    lifecycle: "active",
    bounds: ["ISS-1428"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: PEN_TASK },
      { role: "worker", client: "claude", identityAnchor: SID, ...(rule ? { handoverRule: rule } : {}) },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-11-17",
    updatedAt: "2026-11-17T00:00:00.000Z",
  } as never, root);
}

/** The arrangement file written raw, for shapes the schema refuses (the decoder at notice time is lenient). */
function rawArrangement(root: string, parties: unknown[]): void {
  mkdirSync(join(root, ".story", "arrangements"), { recursive: true });
  writeFileSync(join(root, ".story", "arrangements", `${ARR}.json`), JSON.stringify({ id: ARR, lifecycle: "active", parties }));
}

/** What a status call with this session's task id records on the presence record (T-477). */
function joinArrangement(root: string, lifecycle: "active" | "suspended" = "active"): void {
  expect(applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({
    ...b,
    arrangementPresence: [{ arrangementId: ARR, role: "worker", lifecycle, supervising: null }],
    ownerIdentity: { client: "claude", clientTaskId: SID },
  })).status).toBe("written");
}

describe("T3 rule through the commands (commit 2)", () => {
  it("(a) session alert --handovers elsewhere --where 'watch log': one rule text at 91, nothing at 99 or after the boundary, no owed; here clears it", async () => {
    const s = start(await fixture());
    at(s, 55);
    const set = alert(s, { handovers: "elsewhere", where: "watch log" });
    expect(set).toEqual({ output: "Recorded: handovers for this session live elsewhere (watch log); the context notice reports instead of asking until this session ends.", errorCode: null });
    for (const p of [72, 91, 93, 99]) at(s, p);
    boundary(s);
    at(s, 30);
    expect(kinds(s)).toEqual(["rule@91"]);
    expect(s.pushed[0]!.text).toContain("handover suppressed by session rule (watch log)");
    expect(s.all.join("\n")).not.toMatch(/Write a handover/);
    expect(intelOf(s.f.root)).toMatchObject({ owed: null, rule: { handovers: "elsewhere", where: "watch log" } });
    expect(alert(s, { handovers: "here" }).output).toBe("Cleared: this session's handover rule. The context notice asks for handovers again.");
    expect(intelOf(s.f.root).rule).toBeNull();
  });

  it("(b) the arrangement party rule, set by arrangement update, through the real claim path: one rule text at 91, nothing at 99, nothing after the boundary", async () => {
    const s = start(await fixture());
    await arrangement(s.f.root);
    await handleArrangementUpdate(ARR, { party: SID, handovers: "elsewhere", where: "ops log" }, "json", s.f.root);
    at(s, 55);
    joinArrangement(s.f.root);
    for (const p of [72, 91, 93, 99]) at(s, p);
    boundary(s);
    at(s, 30);
    expect(kinds(s)).toEqual(["rule@91"]);
    expect(s.pushed[0]!.text).toContain("handover suppressed by session rule (ops log)");
    expect(s.all.join("\n")).not.toMatch(/Write a handover/);
  });

  it("(b) a party rule with no where names the arrangement", async () => {
    const s = start(await fixture());
    await arrangement(s.f.root, { handovers: "elsewhere" });
    at(s, 55);
    joinArrangement(s.f.root);
    at(s, 91);
    expect(s.pushed[0]!.text).toContain(`handover suppressed by session rule (set on arrangement ${ARR})`);
  });

  it("(c) the same anchor under claude and codex, the rule on the codex party only: no rule for the Claude session", async () => {
    const s = start(await fixture());
    rawArrangement(s.f.root, [
      { role: "pen", client: "claude", identityAnchor: SID },
      { role: "worker", client: "codex", identityAnchor: SID, handoverRule: { handovers: "elsewhere" } },
    ]);
    at(s, 55);
    joinArrangement(s.f.root);
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("(c) the anchor only on a codex party with the rule: no rule for the Claude session (mutant: the anchor matched without the client)", async () => {
    const s = start(await fixture());
    rawArrangement(s.f.root, [
      { role: "pen", client: "claude", identityAnchor: PEN_TASK },
      { role: "worker", client: "codex", identityAnchor: SID, handoverRule: { handovers: "elsewhere" } },
    ]);
    at(s, 55);
    joinArrangement(s.f.root);
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("no rule from a suspended arrangement entry, or with no owner identity on the record", async () => {
    const s = start(await fixture());
    await arrangement(s.f.root, { handovers: "elsewhere" });
    at(s, 55);
    joinArrangement(s.f.root, "suspended");
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("(d) the arrangement rule removed after one rule line: nothing at 93, uncovered at 99", async () => {
    const s = start(await fixture());
    await arrangement(s.f.root, { handovers: "elsewhere", where: "ops log" });
    at(s, 55);
    joinArrangement(s.f.root);
    at(s, 91);
    await handleArrangementUpdate(ARR, { party: SID, handovers: "here" }, "json", s.f.root);
    at(s, 93);
    at(s, 99);
    expect(kinds(s)).toEqual(["rule@91", "uncovered@99"]);
  });

  it("(e) an arrangement rule with owed set after a boundary: owed is cleared by settle, nothing is pushed", async () => {
    const s = start(await fixture());
    at(s, 55);
    at(s, 91);
    boundary(s);
    await arrangement(s.f.root, { handovers: "elsewhere" });
    joinArrangement(s.f.root);
    at(s, 30);
    expect(kinds(s)).toEqual(["ask@91"]);
    expect(intelOf(s.f.root).owed).toBeNull();
  });

  it("a covering stamp with an arrangement rule gives covered", async () => {
    const s = start(await fixture());
    await arrangement(s.f.root, { handovers: "elsewhere" });
    at(s, 75);
    joinArrangement(s.f.root);
    handover(s);
    at(s, 91);
    expect(kinds(s)).toEqual(["covered@91"]);
  });
});

describe("T6b delayed claims through the command (commit 2)", () => {
  async function decidedAsk(): Promise<{ s: Sess; banner: NonNullable<ReturnType<typeof tokenPressureBannerFor>> }> {
    const s = start(await fixture());
    at(s, 60);
    at(s, 91);
    patchIntel(s.f.root, (i) => ({ ...i, lastImperativeEmittedAt: null, noticeTokens: null, policyGen: i.policyGen + 1 }));
    const banner = tokenPressureBannerFor(s.f.root, { now: s.t, cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings, softBudgetMs: SOFT });
    expect(banner).toMatchObject({ notice: "ask" });
    return { s, banner: banner! };
  }

  it("(i) a rule set by session alert before the claim: refused, nothing delivered", async () => {
    const { s, banner } = await decidedAsk();
    expect(alert(s, { handovers: "elsewhere" }).errorCode).toBeNull();
    expect(deliverBanner(banner)).toBeNull();
    expect(intelOf(s.f.root).lastImperativeEmittedAt).toBeNull();
  });

  it("(iv) an override set before the claim: refused, nothing delivered", async () => {
    const { s, banner } = await decidedAsk();
    expect(alert(s, { imperativePct: 0.8 }).errorCode).toBeNull();
    expect(deliverBanner(banner)).toBeNull();
    expect(intelOf(s.f.root).lastImperativeEmittedAt).toBeNull();
  });
});

describe("T11 external cover (commit 2)", () => {
  const TEXT = "ops/watch.md#2026-11-16";

  it("given at 80: the covering reply, a covered text naming it at 91, nothing at 99", async () => {
    const s = start(await fixture());
    at(s, 80);
    expect(alert(s, { coveredBy: TEXT })).toEqual({ output: `Recorded: this compaction is covered by ${TEXT}.`, errorCode: null });
    at(s, 91);
    at(s, 99);
    expect(kinds(s)).toEqual(["covered@91"]);
    expect(s.pushed[0]!.text).toContain(`This compaction is covered by ${TEXT}: nothing to write. Keep working.`);
    expect(intelOf(s.f.root)).toMatchObject({ coveredBy: TEXT, handoverFile: null });
  });

  it("given after ask: nothing at 99 and no catch-up after the boundary", async () => {
    const s = start(await fixture());
    at(s, 91);
    expect(alert(s, { coveredBy: TEXT }).output).toBe(`Recorded: this compaction is covered by ${TEXT}.`);
    at(s, 99);
    boundary(s);
    at(s, 30);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("given at 60: the non-covering reply, and ask at 91", async () => {
    const s = start(await fixture());
    at(s, 60);
    const used = tokensAt(s, 60).toLocaleString("en-US");
    expect(alert(s, { coveredBy: TEXT }).output).toBe(`Recorded ${TEXT}, but it was given well before the compaction point (${used} of about 228,000 tokens in use), so the notice may still ask near it. Give it again nearer the point.`);
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("given before any sample: the unknown-tokens reply, and ask at 91", async () => {
    const s = start(await fixture());
    expect(alert(s, { coveredBy: TEXT }).output).toBe(`Recorded ${TEXT}, but the context size is not known yet, so the notice may still ask near the compaction point.`);
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });
});

describe("T12 thresholds through the command (commit 2)", () => {
  it("--imperative-pct 0.8: ask at 82 for this session (mutant: the override applied to every session, below)", async () => {
    const s = start(await fixture());
    at(s, 55);
    expect(alert(s, { imperativePct: 0.8 }).output).toBe("Recorded for this session only: imperativePct 0.8.");
    at(s, 78);
    at(s, 82);
    expect(kinds(s)).toEqual(["ask@82"]);
    expect(intelOf(s.f.root).override).toEqual({ imperativePct: 0.8, imperativeHeadroomTokens: null });
  });

  it("the override changes this session only: a second session on the same project is not asked at 82", async () => {
    const s = start(await fixture());
    at(s, 55);
    alert(s, { imperativePct: 0.8 });
    const SID2 = "5e00bbbf-5dcb-4be3-90d3-2b13e0f50b29";
    process.env.CLAUDE_CODE_SESSION_ID = SID2;
    processEra.reset(); // a second Claude process on the same project
    ensureCapture({ root: s.f.root, sessionId: SID2, source: "startup", now: s.t - 60_000, userSettingsPath: s.f.userSettings });
    const lines: string[] = [];
    const path = writeTranscript(s.f.projects, encoded(s.f.root), SID2, lines);
    const pushed: string[] = [];
    for (const pct of [55, 82]) {
      s.t += s.step;
      lines.push(assistantRecord({ ts: iso(s.t - 1_000), read: tokensAt(s, pct) - 2, sessionId: SID2 }));
      writeTranscript(s.f.projects, encoded(s.f.root), SID2, lines);
      const r = handleSessionIntelPrompt({ sessionId: SID2, transcriptPath: path, now: s.t, cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings, softBudgetMs: SOFT });
      if (r.status === "emitted") pushed.push(r.output!);
    }
    expect(readPresenceRecord(s.f.root, SID2)!.sessionIntel!.lastSample!.rawState).toBe("advisory");
    expect(pushed).toEqual([]);
  });

  it("each refusal of 7.3 writes nothing", async () => {
    const s = start(await fixture());
    at(s, 55);
    const gen = intelOf(s.f.root).policyGen;
    const refusals: Array<[Omit<SessionAlertOptions, "root" | "now">, RegExp]> = [
      [{ imperativePct: 0.55 }, /--imperative-pct must be a number from 0.6 to 0.99/],
      [{ imperativePct: 0.995 }, /--imperative-pct must be a number from 0.6 to 0.99/],
      [{ imperativePct: Number.NaN }, /--imperative-pct must be a number/],
      [{ imperativePct: 0.65 }, /above this project's advisoryPct \(0.7\) and below its compactNeededPct \(0.98\)/],
      [{ imperativePct: 0.98 }, /above this project's advisoryPct \(0.7\) and below its compactNeededPct \(0.98\)/],
      [{ imperativeHeadroom: 9_999 }, /--imperative-headroom must be a whole number of tokens from 10,000 to 500,000/],
      [{ imperativeHeadroom: 20_000.5 }, /--imperative-headroom must be a whole number/],
      [{ imperativePct: 0.8, resetThresholds: true }, /--reset-thresholds cannot be combined/],
      [{ handovers: "here", where: "x" }, /--where goes with --handovers elsewhere only/],
      [{ where: "x" }, /--where goes with --handovers elsewhere/],
      [{ handovers: "elsewhere", where: "a".repeat(201) }, /--where must be one line of 1 to 200 bytes/],
      [{ coveredBy: "two\nlines" }, /--covered-by must be one line of 1 to 300 bytes/],
      [{ coveredBy: "c".repeat(301) }, /--covered-by must be one line of 1 to 300 bytes/],
      // A valid group beside an invalid one: nothing from either is written.
      [{ handovers: "elsewhere", imperativePct: 0.5 }, /--imperative-pct must be a number/],
    ];
    for (const [o, msg] of refusals) {
      const r = alert(s, o);
      expect(r.errorCode, JSON.stringify(o)).toBe("invalid_input");
      expect(r.output).toMatch(msg);
    }
    expect(intelOf(s.f.root)).toMatchObject({ policyGen: gen, rule: null, override: null, coveredBy: null });
  });

  it("an override that stops fitting after a config edit is ignored whole and named in reason", async () => {
    const s = start(await fixture());
    at(s, 55);
    alert(s, { imperativePct: 0.8, imperativeHeadroom: 60_000 });
    setIntelConfig(s.f.root, { advisoryPct: 0.85 });
    const r86 = at(s, 86);
    expect(r86.result?.pressure?.reason).toContain("this session's threshold override (imperativePct 0.8) is ignored: it is no longer above the project's advisoryPct 0.85");
    at(s, 89);
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("on a 925,000 point a headroom override of 10,000 empties the band: the set warns, nothing at 95 or 97, uncovered at 98, reason says so", async () => {
    const f = await fixture(1_000_000);
    const s = start(f, WIDE);
    at(s, 50);
    const set = alert(s, { imperativeHeadroom: 10_000 });
    expect(set.output.split("\n")).toEqual([
      "Recorded for this session only: imperativeHeadroomTokens 10,000.",
      expect.stringMatching(/^Warning: on the current expected point the imperative band is empty: its line \(915000, .*\) is at or past the compact line \(906500\)/),
    ]);
    const r95 = at(s, 95);
    at(s, 97);
    expect(s.pushed).toEqual([]);
    expect(r95.result?.pressure?.reason).toContain("the imperative band is empty");
    at(s, 98);
    expect(kinds(s)).toEqual(["uncovered@98"]);
  });

  it("--reset-thresholds clears the override and the project values apply again", async () => {
    const s = start(await fixture());
    at(s, 55);
    alert(s, { imperativePct: 0.8 });
    expect(alert(s, { resetThresholds: true }).output).toBe("Cleared: this session's threshold override. The project's thresholds apply.");
    at(s, 82);
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
  });

  it("groups combine in one locked write, and no flags prints the state", async () => {
    const s = start(await fixture());
    at(s, 80);
    const gen = intelOf(s.f.root).policyGen;
    const r = alert(s, { handovers: "elsewhere", where: "watch log", coveredBy: "ops/x", imperativePct: 0.85 });
    expect(r.output.split("\n")).toEqual([
      "Recorded: handovers for this session live elsewhere (watch log); the context notice reports instead of asking until this session ends.",
      "Recorded for this session only: imperativePct 0.85.",
      "Recorded: this compaction is covered by ops/x.",
    ]);
    expect(intelOf(s.f.root)).toMatchObject({ rule: { where: "watch log" }, override: { imperativePct: 0.85 }, coveredBy: "ops/x", policyGen: gen + 2 });
    const md = alert(s).output;
    expect(md).toContain("- Handover rule: elsewhere (watch log), set on this session");
    expect(md).toContain("- Coverage: covered-by ops/x at");
    expect(md).toContain("(session override applied)");
    const json = JSON.parse(alert(s, { format: "json" }).output) as { ok: boolean; state: { rule: { source: string }; thresholds: { overrideStatus: string } } };
    expect(json).toMatchObject({ ok: true, state: { rule: { source: "session" }, thresholds: { overrideStatus: "applied" } } });
  });

  it("refuses an unbound caller", async () => {
    const s = start(await fixture());
    at(s, 55);
    process.env.CLAUDE_CODE_SESSION_ID = "9f00bbbf-5dcb-4be3-90d3-2b13e0f50b29";
    const r = alert(s, { handovers: "elsewhere" });
    expect(r.errorCode).toBe("not_bound");
    expect(intelOf(s.f.root).rule).toBeNull();
  });
});

describe("T18 the arrangement party rule (commit 2)", () => {
  it("survives arrangement coordinate and arrangement update rewrites, and parses on a decoder without the field", async () => {
    const s = start(await fixture());
    await arrangement(s.f.root);
    await handleArrangementUpdate(ARR, { party: SID, handovers: "elsewhere", where: "ops log" }, "json", s.f.root);
    const ruleOf = () => loadArrangementsSafe(s.f.root).arrangements.find((a) => a.id === ARR)!.parties.find((p) => p.identityAnchor === SID)!.handoverRule;
    expect(ruleOf()).toEqual({ handovers: "elsewhere", where: "ops log" });
    await coordinateDuet(s.f.root, { id: ARR, clientTaskId: PEN_TASK, action: "start", expectedSessionId: null, expectedRevision: 0, newSessionId: "0f5a2b7e-1111-4222-8333-944455556666", mode: "native-return" } as DuetOperation);
    expect(ruleOf()).toEqual({ handovers: "elsewhere", where: "ops log" });
    await handleArrangementUpdate(ARR, { lifecycle: "suspended" }, "json", s.f.root);
    expect(ruleOf()).toEqual({ handovers: "elsewhere", where: "ops log" });
    // An older decoder: the party schema without the field keeps it (passthrough).
    const older = ArrangementPartySchema.omit({ handoverRule: true });
    const raw = JSON.parse(readFileSync(join(s.f.root, ".story", "arrangements", `${ARR}.json`), "utf8")) as { parties: unknown[] };
    expect(older.parse(raw.parties[1])).toMatchObject({ handoverRule: { handovers: "elsewhere", where: "ops log" } });
    await handleArrangementUpdate(ARR, { party: SID, handovers: "here" }, "json", s.f.root);
    expect(ruleOf()).toBeUndefined();
  });

  it("--party must name exactly one party, and the flags are validated before the lock", async () => {
    const s = start(await fixture());
    await arrangement(s.f.root);
    await expect(handleArrangementUpdate(ARR, { party: "nobody", handovers: "elsewhere" }, "json", s.f.root)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(handleArrangementUpdate(ARR, { handovers: "elsewhere" }, "json", s.f.root)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(handleArrangementUpdate(ARR, { party: SID, handovers: "here", where: "x" }, "json", s.f.root)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(handleArrangementUpdate(ARR, { party: SID, handovers: "elsewhere", where: "two\nlines" }, "json", s.f.root)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(handleArrangementUpdate(ARR, { party: SID }, "json", s.f.root)).rejects.toMatchObject({ code: "invalid_input" });
    // A schema-valid arrangement with one anchor on two parties (claude and codex).
    await writeArrangementUnlocked({
      id: ARR, lifecycle: "active", bounds: ["ISS-1428"],
      parties: [{ role: "pen", client: "claude", identityAnchor: SID }, { role: "worker", client: "codex", identityAnchor: SID }],
      gates: [], unreachability: { onIrreversibleWork: "hold" }, createdDate: "2026-11-17", updatedAt: "2026-11-17T00:00:00.000Z",
    } as never, s.f.root);
    const twins = () => loadArrangementsSafe(s.f.root).arrangements.find((a) => a.id === ARR)?.parties;
    const before = twins();
    expect(before).toHaveLength(2);
    await expect(handleArrangementUpdate(ARR, { party: SID, handovers: "elsewhere" }, "json", s.f.root)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining(`2 parties of arrangement ${ARR} have identity anchor`) });
    expect(twins()).toEqual(before);
  });

  it("the record keeps rule and override through both resets; SessionEnd clears the subtree", async () => {
    const s = start(await fixture());
    at(s, 55);
    alert(s, { handovers: "elsewhere", imperativePct: 0.85 });
    const i = intelOf(s.f.root);
    for (const r of [applyBoundaryReset(i, "2026-11-17T09:00:00.000Z"), applyAssumedReset(i, "2026-11-17T09:00:00.000Z")]) {
      expect(r.rule).toEqual(i.rule);
      expect(r.override).toEqual(i.override);
    }
  });
});

describe("commit 2 fixup: an override change and the era check (Codex)", () => {
  it("an override changed after an unclaimed imperative sample: guideDirectiveFor at once, with no new sample, gives no ask (mutant: the stored sample kept)", async () => {
    const s = start(await fixture());
    at(s, 55);
    at(s, 91);
    // Re-arm by fixture: the 91 sample is imperative and unclaimed.
    patchIntel(s.f.root, (i) => ({ ...i, lastImperativeEmittedAt: null, noticeTokens: null, policyGen: i.policyGen + 1 }));
    expect(intelOf(s.f.root).lastSample!.rawState).toBe("imperative");
    // Headroom 10,000 moves the line to 218,000: 91 percent (207,480) is below it.
    expect(alert(s, { imperativeHeadroom: 10_000 }).errorCode).toBeNull();
    expect(guideDirectiveFor(s.f.root, SID, s.t)).toBeNull();
    expect(intelOf(s.f.root).lastImperativeEmittedAt).toBeNull();
    // The next sample is decided under the new thresholds: 91 asks nothing, 96 asks.
    at(s, 91);
    at(s, 96);
    expect(kinds(s)).toEqual(["ask@91", "ask@96"]);
  });

  it("the era changed between the binding and the lock: every flag group refuses and no field changes (mutant: the era check only on the cover)", async () => {
    const s = start(await fixture());
    at(s, 55);
    const live = intelOf(s.f.root).era;
    let before: SessionIntelPresence | null = null;
    const swap = () => { patchIntel(s.f.root, (i) => ({ ...i, era: "1:1" })); before = intelOf(s.f.root); };
    for (const o of [{ handovers: "elsewhere" as const }, { imperativePct: 0.8 }, { resetThresholds: true }, { coveredBy: "ops/x" }]) {
      patchIntel(s.f.root, (i) => ({ ...i, era: live }));
      const r = alert(s, { ...o, afterBinding: swap });
      expect(intelOf(s.f.root)).toEqual(before);
      expect(r.errorCode, JSON.stringify(o)).toBe("not_bound");
      expect(r.output).toMatch(/record era differs/);
    }
  });
});

describe("commit 2 fixup 2: an override re-decides the stored sample in place (Codex)", () => {
  it("(a) an override, then a separate --covered-by and a handover create before any new sample: real tokens are stamped and coverage is judged (mutant: clear instead of recompute)", async () => {
    const s = start(await fixture());
    at(s, 55);
    at(s, 93);
    expect(alert(s, { imperativeHeadroom: 10_000 }).errorCode).toBeNull();
    expect(intelOf(s.f.root).lastSample!.contextTokens).toBe(tokensAt(s, 93));
    const r = alert(s, { coveredBy: "ops/log" });
    expect(r.errorCode).toBeNull();
    expect(r.output).toBe("Recorded: this compaction is covered by ops/log.");
    const out = handover(s);
    expect(out).toMatchObject({ covers: true, tokens: tokensAt(s, 93) });
    expect(intelOf(s.f.root).tokensAtHandover).toBe(tokensAt(s, 93));
  });

  it("(b) an unclaimed imperative sample, a same-value override, then a boundary before resampling: owed is still set (mutant: clear instead of recompute)", async () => {
    const s = start(await fixture());
    at(s, 55);
    at(s, 91);
    patchIntel(s.f.root, (i) => ({ ...i, lastImperativeEmittedAt: null, noticeTokens: null, policyGen: i.policyGen + 1 }));
    expect(alert(s, { imperativePct: resolveSessionIntelConfig(null).imperativePct }).errorCode).toBeNull();
    expect(intelOf(s.f.root).lastSample).toMatchObject({ rawState: "imperative", contextTokens: tokensAt(s, 91) });
    boundary(s);
    at(s, 30);
    // The catch-up delivered is the owed mark acted on (delivery settles it).
    expect(kinds(s)).toEqual(["ask@91", "catch-up@30"]);
  });

  it("decideBand is the sampler's step: the stored sample re-decided equals a fresh sample on the same facts", async () => {
    const s = start(await fixture());
    at(s, 55);
    at(s, 91);
    const fresh = intelOf(s.f.root).lastSample!;
    expect(redecideStoredSample(intelOf(s.f.root), resolveSessionIntelConfig(null)).lastSample).toEqual(fresh);
  });
});

// ---------------------------------------------------------------------------
// Commit 3: the line hint (`{line}` from the caller's line memo)
// ---------------------------------------------------------------------------

const PEER = "2026-11-17-09-peer.md";
const LINE = (tip: string) => ` It continues the line this session is on (${tip}).`;

function peerHandover(root: string): void {
  const dir = join(root, ".story", "handovers");
  mkdirSync(dir, { recursive: true });
  // Two lines: the peer's (a worker line) and a newer pen line that is the
  // head, so the peer's handover is an open tip that is not the head.
  const linked = (role: string) => `# Handover\n\nwork\n\n<!-- storybloq-lineage v1 role="${role}" -->\n`;
  writeFileSync(join(dir, PEER), linked("worker"));
  writeFileSync(join(dir, "2026-11-17-10-head.md"), linked("pen"));
}

async function continueOnto(root: string, fork = false): Promise<void> {
  const ctx = { root, handoversDir: join(root, ".story", "handovers"), format: "md", state: undefined, warnings: [] } as unknown as CommandContext;
  await handleHandoverContinue(ctx, { file: PEER, as: SID, ...(fork ? { fork: true } : {}) });
  expect(readLineMemo(root, SID)).toMatchObject({ tip: PEER, writing: null });
}

describe("T10 the line memo is never evidence (commit 3)", () => {
  for (const fork of [false, true]) {
    it(`(a) a memo pointed at a peer's handover by handover continue${fork ? " --fork" : ""}: ask at 91 and catch-up at 30 still pushed, each with the line hint (mutant: the memo tip stamps or settles)`, async () => {
      const s = start(await fixture());
      peerHandover(s.f.root);
      await continueOnto(s.f.root, fork);
      at(s, 55);
      at(s, 91);
      boundary(s);
      at(s, 30);
      expect(kinds(s)).toEqual(["ask@91", "catch-up@30"]);
      for (const p of s.pushed) expect(p.text).toContain(LINE(PEER));
      expect(intelOf(s.f.root)).toMatchObject({ handoverWrittenAt: null, tokensAtHandover: null, handoverFile: null });
    });
  }

  it("(b) a handover stamped at 60 percent stays non-covering at 91 with its memo active: ask, and tokensAtHandover unchanged", async () => {
    const s = start(await fixture());
    peerHandover(s.f.root);
    await continueOnto(s.f.root);
    at(s, 60);
    expect(stampHandover(s.f.root, SID, s.era, tokensAt(s, 60), s.t, undefined, "bound", { handoverFile: "2026-11-17-01-mine.md" }).status).toBe("written");
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
    expect(s.pushed[0]!.text).toContain(LINE(PEER));
    expect(intelOf(s.f.root).tokensAtHandover).toBe(tokensAt(s, 60));
  });

  it("(c) a stamp with null tokens and an active memo: ask", async () => {
    const s = start(await fixture());
    peerHandover(s.f.root);
    await continueOnto(s.f.root);
    at(s, 75);
    patchIntel(s.f.root, (x) => ({ ...x, handoverWrittenAt: iso(s.t), tokensAtHandover: null, handoverBoundaryAt: x.lastBoundaryAt, policyGen: x.policyGen + 1 }));
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
    expect(s.pushed[0]!.text).toContain(LINE(PEER));
  });

  it("(d) a memo with a pending writing intent gives no line hint", async () => {
    const s = start(await fixture());
    peerHandover(s.f.root);
    await continueOnto(s.f.root);
    const memo = readLineMemo(s.f.root, SID)!;
    expect(writeLineMemo(s.f.root, { ...memo, writing: { file: "2026-11-17-02-next.md", sha256: "0".repeat(64) } })).toBe(true);
    at(s, 91);
    expect(kinds(s)).toEqual(["ask@91"]);
    expect(s.pushed[0]!.text).not.toContain("It continues the line");
    expect(readLineMemoTip(s.f.root, SID)).toBeNull();
  });

  it("no memo: no line hint; a covered or rule text never carries one", async () => {
    const s = start(await fixture());
    at(s, 91);
    expect(s.pushed[0]!.text).not.toContain("It continues the line");
    const r = start(await fixture());
    peerHandover(r.f.root);
    await continueOnto(r.f.root);
    at(r, 75);
    handover(r, "2026-11-17-03-cover.md");
    patchIntel(r.f.root, (i) => ({ ...i, tokensAtHandover: tokensAt(r, 75), policyGen: i.policyGen + 1 }));
    at(r, 91);
    expect(kinds(r)).toEqual(["covered@91"]);
    expect(r.pushed[0]!.text).not.toContain("It continues the line");
  });

  it("the banner carries the same hint", async () => {
    const s = start(await fixture());
    peerHandover(s.f.root);
    await continueOnto(s.f.root);
    at(s, 55);
    s.t += s.step;
    s.lines.push(assistantRecord({ ts: iso(s.t - 1_000), read: tokensAt(s, 91) - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    const banner = tokenPressureBannerFor(s.f.root, { now: s.t, cwd: s.f.root, projectsDir: s.f.projects, userSettingsPath: s.f.userSettings, softBudgetMs: SOFT });
    expect(banner).toMatchObject({ notice: "ask" });
    expect(banner!.text).toContain(LINE(PEER));
  });
});

describe("the guide carries the line hint (commit 3)", () => {
  it("an unclaimed ask decided by the guide names the line", async () => {
    const s = start(await fixture());
    peerHandover(s.f.root);
    await continueOnto(s.f.root);
    at(s, 55);
    at(s, 91);
    patchIntel(s.f.root, (i) => ({ ...i, lastImperativeEmittedAt: null, noticeTokens: null, policyGen: i.policyGen + 1 }));
    const d = guideDirectiveFor(s.f.root, SID, s.t);
    expect(d).toContain(LINE(PEER));
  });
});

describe("T17 cost of the line hint (commit 3)", () => {
  function countOpens(): string[] {
    const opened: string[] = [];
    const orig = fsDefault.openSync;
    vi.spyOn(fsDefault, "openSync").mockImplementation(((...a: unknown[]) => { opened.push(String(a[0])); return (orig as (...x: unknown[]) => number).apply(fsDefault, a); }) as never);
    syncBuiltinESMExports();
    return opened;
  }
  const memoOpens = (o: string[]) => o.filter((p) => p.includes("handover-lines"));

  it("at ok no memo read; on an emitting path at most one", async () => {
    const s = start(await fixture());
    peerHandover(s.f.root);
    await continueOnto(s.f.root);
    let o = countOpens();
    at(s, 30);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    expect(memoOpens(o)).toEqual([]);
    o = countOpens();
    at(s, 91);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    expect(kinds(s)).toEqual(["ask@91"]);
    expect(memoOpens(o).length).toBe(1);
  });

  it("a covered notice reads no memo: the hint is read only for ask and catch-up", async () => {
    const s = start(await fixture());
    peerHandover(s.f.root);
    await continueOnto(s.f.root);
    at(s, 75);
    handover(s, "2026-11-17-03-cover.md");
    patchIntel(s.f.root, (i) => ({ ...i, tokensAtHandover: tokensAt(s, 75), policyGen: i.policyGen + 1 }));
    const o = countOpens();
    at(s, 91);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    expect(kinds(s)).toEqual(["covered@91"]);
    expect(memoOpens(o)).toEqual([]);
  });
});
