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
import { decideFromRecord, effectiveThresholds, emptyBandReason, eraCovered, finalAllowed, noticeHead, renderNotice, resolveFinal, type FinalAction, type NoticeCandidate, type NoticeKind } from "../../src/core/session-intel/policy.js";
import { applyBannerToMcpText, applyStatusPushesToMcpText, deliverBanner, guideDirectiveFor, statusPushesFor, tokenPressureBannerFor } from "../../src/core/session-intel/push.js";
import { handleSessionIntelPrompt } from "../../src/cli/commands/session-intel.js";
import { handleHandoverCreate } from "../../src/cli/commands/handover.js";
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

  it("the empty-band configuration: a stamp at 880,000 on a 925,000 point is past the compact line and gets the non-covering reply", async () => {
    const f = await fixture(1_000_000);
    setIntelConfig(f.root, { imperativeHeadroomTokens: 10_000 });
    const s = start(f, WIDE, Date.now() - 10_000, 1_000);
    s.t = Date.now() - 2_000;
    s.lines.push(assistantRecord({ ts: iso(s.t - 500), read: 880_000 - 2 }));
    writeTranscript(s.f.projects, encoded(s.f.root), SID, s.lines);
    hook(s, "880k");
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
