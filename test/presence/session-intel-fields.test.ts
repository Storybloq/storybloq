/**
 * T-499: the presence-side half of session intel.
 *
 * What the slim hook must guarantee for a subtree it never computes: parse it
 * with the writer's caps, carry it through every event except SessionEnd,
 * and keep the whole record under the reader's bound with the intel present.
 */
import { describe, it, expect } from "vitest";

import {
  MAX_COVERED_BY_BYTES,
  MAX_ERA_BYTES,
  MAX_HANDOVER_FILE_BYTES,
  MAX_INCARNATION_BYTES,
  MAX_RULE_WHERE_BYTES,
  MAX_SESSION_INTEL_BYTES,
  MAX_TRANSCRIPT_PATH_BYTES,
  SESSION_INTEL_SHED_STEPS,
  shedDisplayText,
  emptySessionIntel,
  fitSessionIntel,
  parseSessionIntel,
  sessionIntelBytes,
  type SessionIntelPresence,
  type SessionIntelSample,
} from "../../src/presence/session-intel-fields.js";
import { applyPresenceEvent, parsePresenceRecord, serializePresence, type PresenceEventContext } from "../../src/presence/record.js";
import {
  MAX_AGENT_IDS,
  MAX_ARRANGEMENT_PRESENCE_ENTRIES,
  MAX_CLIENT_TASK_ID_BYTES,
  MAX_CLOSED_TOOL_IDS,
  MAX_GATE_NAME_BYTES,
  MAX_ID_BYTES,
  MAX_MILESTONE_KIND_BYTES,
  MAX_MILESTONE_NOTE_BYTES,
  MAX_RECORD_BYTES,
  MAX_TARGET_BYTES,
  MAX_TOOL_NAME_BYTES,
  type SessionPresence,
} from "../../src/presence/types.js";
import { ensureTelemetrySubdir } from "../../src/presence/io.js";
import { encodeProjectDir, locateTranscript } from "../../src/core/session-intel/transcript-locate.js";
import { SID, writeTranscript } from "../core/session-intel-fixtures.js";
import { mkdtempSync, rmSync, lstatSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SESSION = "sess-intel";
const SHA = "f".repeat(64);

function sample(over: Partial<SessionIntelSample> = {}): SessionIntelSample {
  return {
    sampledAt: "2026-09-09T10:00:00.000Z",
    sampledBy: "stop-hook",
    state: "advisory",
    rawState: "imperative",
    pct: 0.71,
    contextTokens: 296_000,
    ceiling: 417_737,
    ceilingSource: "measured-session",
    ceilingConfidence: "high",
    observation: {
      era: "11442:1788000000",
      incarnation: "16777220:9001",
      sizeAtOpen: 5_000_000,
      consumedOffset: 4_999_990,
      anchor: { offset: 4_999_990, sha256: SHA },
      authoritative: true,
      revisionSeen: 3,
      lastRecordTimestamp: "2026-09-09T09:59:59.000Z",
      epoch: { kind: "observed", at: "2026-09-09T08:00:00.000Z" },
    },
    imperativeSince: "2026-09-09T09:50:00.000Z",
    suppressedBy: "handover",
    usageInput: { window: 1_000_000, source: "user", oneMillionFlag: true },
    ...over,
  };
}

function full(): SessionIntelPresence {
  return {
    era: "11442:1788000000",
    revision: 3,
    captureKind: "startup",
    autoCompactWindowAtStart: 450_000,
    autoCompactWindowSource: "user",
    capturedAt: "2026-09-09T07:00:00.000Z",
    transcriptPath: "/Users/u/.claude/projects/-Users-u-p/sess-intel.jsonl",
    epoch: { kind: "observed", at: "2026-09-09T08:00:00.000Z" },
    lastBoundaryAt: "2026-09-09T08:00:00.000Z",
    consumedOffset: 4_999_990,
    incarnation: "16777220:9001",
    baselineAnchor: { offset: 4_999_990, sha256: SHA },
    lastSample: sample(),
    handoverWrittenAt: "2026-09-09T09:55:00.000Z",
    tokensAtHandover: 290_000,
    handoverBoundaryAt: "2026-09-09T08:00:00.000Z",
    usageAdvisoryShownAt: "2026-09-09T09:00:00.000Z",
    handoverStampBinding: "unbound-era",
    lastImperativeEmittedAt: "2026-09-09T09:51:00.000Z",
    compactNeededEmittedAt: "2026-09-09T09:58:00.000Z",
    noticeTokens: 410_000,
    handoverFile: "2026-09-09-095500-cpm-w15-delta.md",
    coveredBy: "ops/watch.md#2026-09-09",
    owed: { boundaryAt: "2026-09-09T08:00:00.000Z", eraStartAt: "2026-09-09T07:00:00.000Z" },
    rule: { handovers: "elsewhere", where: "watch log", setAt: "2026-09-09T07:30:00.000Z" },
    policyGen: 7,
  };
}

function ctx(over: Partial<PresenceEventContext> & Pick<PresenceEventContext, "event">): PresenceEventContext {
  return { sessionId: SESSION, nowIso: "2026-09-09T10:00:00.000Z", source: null, toolId: null, toolName: null, target: null, agentId: null, suppressed: false, ...over };
}

describe("session intel fields (T-499)", () => {
  it("round-trips a full subtree through JSON and the parser", () => {
    const parsed = parseSessionIntel(JSON.parse(JSON.stringify(full())));
    expect(parsed).toEqual(full());
  });

  it("refuses anything that is not an object, and defaults every field it cannot read", () => {
    expect(parseSessionIntel(null)).toBeNull();
    expect(parseSessionIntel("x")).toBeNull();
    expect(parseSessionIntel([])).toBeNull();
    expect(parseSessionIntel({})).toEqual(emptySessionIntel());
    const junk = parseSessionIntel({
      era: 12, revision: -1, captureKind: "bogus", autoCompactWindowAtStart: 0, autoCompactWindowSource: "policy",
      capturedAt: "not a date", epoch: { kind: "observed" }, lastBoundaryAt: 5, consumedOffset: 1.5,
      baselineAnchor: { offset: 1, sha256: "zz" }, lastSample: { sampledAt: "2026-09-09T10:00:00.000Z" },
      tokensAtHandover: -3, handoverBoundaryAt: "",
    })!;
    expect(junk).toEqual(emptySessionIntel());
  });

  it("ISS-1197 commit 2: compact-needed round-trips as a state, and an unknown state string is still refused", () => {
    const intel = { ...full(), lastSample: sample({ state: "compact-needed", rawState: "compact-needed", suppressedBy: null }) };
    const parsed = parseSessionIntel(JSON.parse(JSON.stringify(intel)))!;
    expect(parsed.lastSample).toMatchObject({ state: "compact-needed", rawState: "compact-needed", suppressedBy: null });
    expect(parsed).toEqual(intel);
    // The set is still closed: an invented state drops the sample, and an
    // invented rawState falls back to the sample's own state.
    expect(parseSessionIntel({ ...full(), lastSample: { ...sample(), state: "compact_needed" } })!.lastSample).toBeNull();
    expect(parseSessionIntel({ ...full(), lastSample: { ...sample(), state: "compact-needed", rawState: "panic" } })!.lastSample).toMatchObject({ state: "compact-needed", rawState: "compact-needed" });
  });

  it("ISS-1428: the retired re-arm counters on an older record are dropped on read, keeping its handover fields", () => {
    const older = { ...full(), promptsSinceHandover: 4, lastImperativeAt: "2026-09-09T09:50:00.000Z" };
    const parsed = parseSessionIntel(JSON.parse(JSON.stringify(older)))!;
    expect(parsed).toEqual(full());
    expect(parsed).not.toHaveProperty("promptsSinceHandover");
    expect(parsed).not.toHaveProperty("lastImperativeAt");
    expect(JSON.stringify(parsed)).not.toMatch(/promptsSinceHandover|lastImperativeAt"/);
  });


  it("drops a malformed sample without dropping the capture", () => {
    const parsed = parseSessionIntel({ ...full(), lastSample: { ...sample(), observation: { incarnation: "x" } } })!;
    expect(parsed.lastSample).toBeNull();
    expect(parsed.captureKind).toBe("startup");
    expect(parsed.autoCompactWindowAtStart).toBe(450_000);
    // An unknown enum inside the sample is a refused sample, never a coerced one.
    expect(parseSessionIntel({ ...full(), lastSample: { ...sample(), state: "panic" } })!.lastSample).toBeNull();
    expect(parseSessionIntel({ ...full(), lastSample: { ...sample(), ceilingSource: "guess" } })!.lastSample).toBeNull();
  });

  it("caps display strings on read, and REFUSES oversized identities rather than truncating them", () => {
    const parsed = parseSessionIntel({ ...full(), transcriptPath: "/p/".repeat(1000) })!;
    expect(Buffer.byteLength(parsed.transcriptPath!, "utf-8")).toBeLessThanOrEqual(MAX_TRANSCRIPT_PATH_BYTES);
    // An era or incarnation is compared for exact equality downstream; a
    // truncated one would be a DIFFERENT, apparently valid provenance.
    const ids = parseSessionIntel({ ...full(), era: "e".repeat(65), incarnation: "i".repeat(65) })!;
    expect(ids.era).toBeNull();
    expect(ids.incarnation).toBeNull();
    expect(parseSessionIntel({ ...full(), era: "e".repeat(64) })!.era).toBe("e".repeat(64));
    // Inside a sample the incarnation is required, so an oversized one drops the sample.
    const obs = sample().observation;
    expect(parseSessionIntel({ ...full(), lastSample: sample({ observation: { ...obs, incarnation: "i".repeat(65) } }) })!.lastSample).toBeNull();
    expect(parseSessionIntel({ ...full(), lastSample: sample({ observation: { ...obs, era: "e".repeat(65) } }) })!.lastSample!.observation.era).toBeNull();
  });

  it("keeps a fractional ceiling through a presence round trip", () => {
    const intel = { ...full(), lastSample: sample({ ceiling: 417_737.5, pct: 0.6385 }) };
    const rec: SessionPresence = { ...applyPresenceEvent(null, ctx({ event: "SessionStart", source: "startup" })), sessionIntel: intel };
    const back = parsePresenceRecord(serializePresence(rec)!, SESSION)!.sessionIntel!.lastSample!;
    expect(back.ceiling).toBe(417_737.5);
    expect(back.pct).toBe(0.6385);
    expect(parseSessionIntel({ ...full(), lastSample: sample({ ceiling: 0 }) })!.lastSample!.ceiling).toBeNull();
    expect(parseSessionIntel({ ...full(), lastSample: sample({ ceiling: Number.POSITIVE_INFINITY }) })!.lastSample!.ceiling).toBeNull();
  });

  /**
   * The cap is on SERIALIZED bytes, escaping included: a path full of quotes
   * and backslashes costs twice its character count once JSON-encoded, and a
   * cap measured before encoding would let it through. The per-field caps keep
   * every LEGAL subtree under the real cap (pinned below), so the ladder is
   * exercised against a tighter cap, deterministically: one fixture needs
   * exactly one step, one needs both, one cannot fit.
   */
  it("sheds in order under a cap (display text, then path, then sample), measured on serialized bytes, and refuses what cannot fit", () => {
    const escapeHeavy = '"\\'.repeat(MAX_TRANSCRIPT_PATH_BYTES / 2); // 1024 chars, 2048 escaped bytes
    expect(Buffer.byteLength(JSON.stringify(escapeHeavy), "utf-8")).toBeGreaterThan(2 * MAX_TRANSCRIPT_PATH_BYTES);
    const subject: SessionIntelPresence = { ...full(), transcriptPath: escapeHeavy };
    const noText = shedDisplayText(subject);
    const noPath = { ...noText, transcriptPath: null };
    const noSample = { ...noPath, lastSample: null };
    const [all, a, b, c] = [subject, noText, noPath, noSample].map(sessionIntelBytes) as [number, number, number, number];
    expect(all).toBeGreaterThan(a);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(noText).toMatchObject({ handoverFile: null, coveredBy: null, rule: { handovers: "elsewhere", where: null }, owed: full().owed, policyGen: full().policyGen });

    expect(fitSessionIntel(subject, a)).toEqual(noText);
    expect(fitSessionIntel(subject, b)).toEqual(noPath);
    expect(fitSessionIntel(subject, c)).toEqual(noSample);
    // Cannot fit: refused, never truncated further.
    expect(fitSessionIntel(subject, c - 1)).toBeNull();
    // A subtree already under the cap is returned untouched.
    expect(fitSessionIntel(subject, all)).toEqual(subject);
    expect(SESSION_INTEL_SHED_STEPS).toHaveLength(3);
  });

  /**
   * ISS-1428 (pen ruling, deviation A): decision fields and the sample are
   * never shed for any legal input. The worst legal subtree: the transcript
   * path at its cap in characters that escape to two bytes, era and
   * incarnation at their caps the same way (on the record and the sample),
   * every counter at MAX_SAFE_INTEGER, every timestamp set, `owed` and `rule`
   * set, and the display text at its caps. It sheds the display text and the
   * path, never the sample. Mutant "old order" (sample before path) fails it.
   */
  it("ISS-1428: the worst legal subtree keeps every decision field and the sample", () => {
    const ts = "2026-09-09T09:55:00.000Z";
    const MAX = Number.MAX_SAFE_INTEGER;
    const worst: SessionIntelPresence = {
      ...full(),
      era: "\\".repeat(MAX_ERA_BYTES),
      incarnation: "\\".repeat(MAX_INCARNATION_BYTES),
      revision: MAX,
      autoCompactWindowAtStart: MAX,
      capturedAt: ts,
      transcriptPath: '"\\'.repeat(MAX_TRANSCRIPT_PATH_BYTES / 2),
      epoch: { kind: "observed", at: ts },
      lastBoundaryAt: ts,
      consumedOffset: MAX,
      baselineAnchor: { offset: MAX, sha256: SHA },
      lastSample: sample({
        pct: 0.123456789012345,
        contextTokens: MAX,
        ceiling: 1_234_567.123456789,
        suppressedBy: "rate-limit",
        usageInput: { window: MAX, source: "user", oneMillionFlag: true },
        observation: { ...sample().observation, era: "\\".repeat(MAX_ERA_BYTES), incarnation: "\\".repeat(MAX_INCARNATION_BYTES), sizeAtOpen: MAX, consumedOffset: MAX, anchor: { offset: MAX, sha256: SHA }, revisionSeen: MAX },
      }),
      handoverWrittenAt: ts,
      tokensAtHandover: MAX,
      handoverBoundaryAt: ts,
      usageAdvisoryShownAt: ts,
      handoverStampBinding: "unbound-era",
      lastImperativeEmittedAt: ts,
      compactNeededEmittedAt: ts,
      noticeTokens: MAX,
      handoverFile: `a${"-".repeat(MAX_HANDOVER_FILE_BYTES - 4)}.md`,
      coveredBy: "\\".repeat(MAX_COVERED_BY_BYTES),
      owed: { boundaryAt: ts, eraStartAt: ts },
      rule: { handovers: "elsewhere", where: "\\".repeat(MAX_RULE_WHERE_BYTES), setAt: ts },
      policyGen: MAX,
    };
    expect(sessionIntelBytes(worst)).toBeGreaterThan(MAX_SESSION_INTEL_BYTES);
    const read = parseSessionIntel(JSON.parse(JSON.stringify(worst)))!;
    const expected = { ...shedDisplayText(worst), transcriptPath: null };
    expect(read).toEqual(expected);
    expect(read.lastSample).toEqual(worst.lastSample);
    expect(sessionIntelBytes(read)).toBe(2_381);
  });

  it("ISS-1428: with the path shed and the sample kept, the transcript is still located through the cwd fallback", () => {
    const subject: SessionIntelPresence = { ...full(), transcriptPath: '"\\'.repeat(MAX_TRANSCRIPT_PATH_BYTES / 2) };
    const shed = fitSessionIntel(subject, sessionIntelBytes({ ...shedDisplayText(subject), transcriptPath: null }))!;
    expect(shed.transcriptPath).toBeNull();
    expect(shed.lastSample).toEqual(full().lastSample);
    const base = realpathSync(mkdtempSync(join(tmpdir(), "w15-locate-")));
    try {
      const projects = join(base, "projects");
      const file = writeTranscript(projects, encodeProjectDir("/Users/x/proj"), SID, ["{}"]);
      expect(locateTranscript({ sessionId: SID, cwd: "/Users/x/proj", hint: shed.transcriptPath, allowGlob: false, projectsDir: projects })).toEqual({ path: file, source: "cwd" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a full subtree with a plain path at its cap sheds nothing", () => {
    const plain: SessionIntelPresence = { ...full(), transcriptPath: "p".repeat(MAX_TRANSCRIPT_PATH_BYTES) };
    expect(parseSessionIntel(JSON.parse(JSON.stringify(plain)))).toEqual(plain);
    expect(sessionIntelBytes(full())).toBeLessThan(MAX_SESSION_INTEL_BYTES * 0.5);
  });
});

describe("ISS-1428 T18: the notice fields decode", () => {
  it("an older record without them decodes every one as null or 0", () => {
    const { compactNeededEmittedAt, noticeTokens, handoverFile, coveredBy, owed, rule, policyGen, ...older } = full();
    void [compactNeededEmittedAt, noticeTokens, handoverFile, coveredBy, owed, rule, policyGen];
    expect(parseSessionIntel(JSON.parse(JSON.stringify(older)))).toMatchObject({
      compactNeededEmittedAt: null, noticeTokens: null, handoverFile: null, coveredBy: null, owed: null, rule: null, policyGen: 0,
    });
  });

  it("each malformed value is refused on its own, never costing the record", () => {
    const bad = parseSessionIntel({
      ...full(),
      compactNeededEmittedAt: "nope",
      noticeTokens: -1,
      handoverFile: "../escape.md",
      coveredBy: "two\nlines",
      owed: { eraStartAt: "2026-09-09T07:00:00.000Z" },
      rule: { handovers: "here", setAt: "2026-09-09T07:30:00.000Z" },
      policyGen: 1.5,
    })!;
    expect(bad).toMatchObject({ compactNeededEmittedAt: null, noticeTokens: null, handoverFile: null, coveredBy: null, owed: null, rule: null, policyGen: 0 });
    expect(bad.lastSample).toEqual(full().lastSample);
    // Over the cap is refused, never truncated.
    expect(parseSessionIntel({ ...full(), coveredBy: "x".repeat(MAX_COVERED_BY_BYTES + 1) })!.coveredBy).toBeNull();
    expect(parseSessionIntel({ ...full(), handoverFile: `${"a".repeat(MAX_HANDOVER_FILE_BYTES)}.md` })!.handoverFile).toBeNull();
    expect(parseSessionIntel({ ...full(), rule: { handovers: "elsewhere", where: "\u2028", setAt: "2026-09-09T07:30:00.000Z" } })!.rule).toBeNull();
    // A rule with no where is legal.
    expect(parseSessionIntel({ ...full(), rule: { handovers: "elsewhere", setAt: "2026-09-09T07:30:00.000Z" } })!.rule).toEqual({ handovers: "elsewhere", where: null, setAt: "2026-09-09T07:30:00.000Z" });
    // "rule" is a legal suppression on a sample.
    expect(parseSessionIntel({ ...full(), lastSample: sample({ suppressedBy: "rule" }) })!.lastSample!.suppressedBy).toBe("rule");
  });
});

describe("presence record carries session intel (T-499)", () => {
  const withIntel = (): SessionPresence => ({
    ...applyPresenceEvent(null, ctx({ event: "SessionStart", source: "startup" })),
    sessionIntel: full(),
  });

  it("preserves the subtree on every tool event, Stop, and every SessionStart source", () => {
    const rec = withIntel();
    const pre = applyPresenceEvent(rec, ctx({ event: "PreToolUse", toolId: "t1", toolName: "Read" }));
    expect(pre.sessionIntel).toEqual(full());
    const post = applyPresenceEvent(pre, ctx({ event: "PostToolUse", toolId: "t1", toolName: "Read" }));
    expect(post.sessionIntel).toEqual(full());
    const stop = applyPresenceEvent(post, ctx({ event: "Stop" }));
    expect(stop.sessionIntel).toEqual(full());
    for (const source of ["startup", "resume", "clear", "compact", "fork", null]) {
      const started = applyPresenceEvent(stop, ctx({ event: "SessionStart", source }));
      expect(started.sessionIntel, `SessionStart source=${source}`).toEqual(full());
    }
  });

  it("clears the subtree on SessionEnd, with the tombstone", () => {
    const ended = applyPresenceEvent(withIntel(), ctx({ event: "SessionEnd" }));
    expect(ended.endedAt).not.toBeNull();
    expect(ended.sessionIntel).toBeNull();
  });

  it("a fresh record starts with no intel, and a parsed record keeps what it had", () => {
    expect(applyPresenceEvent(null, ctx({ event: "SessionStart", source: "startup" })).sessionIntel).toBeNull();
    const text = serializePresence(withIntel())!;
    expect(parsePresenceRecord(text, SESSION)!.sessionIntel).toEqual(full());
    // An unreadable subtree parses as absent, never as a failed record.
    const broken = JSON.stringify({ ...JSON.parse(text), sessionIntel: "nope" });
    const parsed = parsePresenceRecord(broken, SESSION);
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionIntel).toBeNull();
  });

  /**
   * The T-477 worst case, plus a session-intel subtree at EXACTLY its own cap
   * (ISS-1428, record-ladder deviation): the per-field caps let the notice
   * fields take a legal subtree all the way to MAX_SESSION_INTEL_BYTES, and
   * then the record is over its bound. Neither cap moves; the record's own
   * ladder sheds, in the subtree's order: intel's display text first, which
   * alone fits it, so the panel state and the decision sample both survive.
   */
  it("the worst case with intel at exactly its cap fits by shedding only intel's display text, never the sample", () => {
    const exact = (bytes: number, seed: string) => (seed + "z".repeat(bytes)).slice(0, bytes);
    let rec = applyPresenceEvent(null, ctx({ event: "SessionStart", source: "startup" }));
    for (let i = 0; i < MAX_AGENT_IDS; i++) {
      rec = applyPresenceEvent(rec, ctx({
        event: "PreToolUse", toolId: exact(MAX_ID_BYTES, `id${i}-`), toolName: exact(MAX_TOOL_NAME_BYTES, `tool${i}-`),
        target: exact(MAX_TARGET_BYTES, `d/${i}/`), agentId: exact(MAX_ID_BYTES, `agent${i}-`),
      }));
    }
    for (let i = 0; i < MAX_CLOSED_TOOL_IDS; i++) {
      rec = applyPresenceEvent(rec, ctx({ event: "PostToolUse", toolId: exact(MAX_ID_BYTES, `closed${i}-`), toolName: "Read" }));
    }
    // A legal subtree at exactly the cap: the era, incarnation, path and the
    // other display texts at their own caps, then `coveredBy` (escaped characters, two JSON bytes
    // each) trimmed so the subtree lands on MAX_SESSION_INTEL_BYTES.
    const base: SessionIntelPresence = {
      ...full(),
      era: "\\".repeat(MAX_ERA_BYTES),
      incarnation: "\\".repeat(MAX_INCARNATION_BYTES),
      transcriptPath: "p".repeat(MAX_TRANSCRIPT_PATH_BYTES),
      handoverFile: `a${"-".repeat(MAX_HANDOVER_FILE_BYTES - 4)}.md`,
      rule: { handovers: "elsewhere", where: "\\".repeat(MAX_RULE_WHERE_BYTES), setAt: "2026-09-09T07:30:00.000Z" },
      coveredBy: "",
    };
    const room = MAX_SESSION_INTEL_BYTES - sessionIntelBytes(base);
    expect(Math.floor(room / 2)).toBeLessThanOrEqual(MAX_COVERED_BY_BYTES);
    const intel: SessionIntelPresence = { ...base, coveredBy: "\\".repeat(Math.floor(room / 2)) + "z".repeat(room % 2) };
    expect(sessionIntelBytes(intel)).toBe(MAX_SESSION_INTEL_BYTES);
    expect(parseSessionIntel(JSON.parse(JSON.stringify(intel)))).toEqual(intel); // legal: the decoder keeps every byte
    rec = {
      ...rec,
      arrangementPresence: Array.from({ length: MAX_ARRANGEMENT_PRESENCE_ENTRIES }, (_, i) => ({
        arrangementId: exact(MAX_ID_BYTES, `a${i}-`), role: i % 2 === 0 ? "pen" : "worker", lifecycle: "active", supervising: { workerActive: true },
      })),
      arrangementPresenceTruncated: true,
      milestone: { kind: exact(MAX_MILESTONE_KIND_BYTES, "k-"), at: "2026-08-20T12:00:00.000Z", gateName: exact(MAX_GATE_NAME_BYTES, "g-"), note: exact(MAX_MILESTONE_NOTE_BYTES, "n-") },
      ownerIdentity: { client: "codex", clientTaskId: exact(MAX_CLIENT_TASK_ID_BYTES, "t-") },
      sessionIntel: intel,
    };
    // Unshed, the record is over its bound.
    expect(Buffer.byteLength(JSON.stringify(rec) + "\n", "utf-8")).toBeGreaterThan(MAX_RECORD_BYTES);
    const text = serializePresence(rec)!;
    expect(text).not.toBeNull();
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    const back = parsePresenceRecord(text, SESSION)!;
    // The display text went first; every decision field, the path and the
    // sample survived.
    expect(back.sessionIntel).toEqual(shedDisplayText(intel));
    expect(back.sessionIntel!.lastSample).toEqual(intel.lastSample);
    // That one step is enough: the panel state is untouched, and the record
    // lands 104 bytes under its bound, measured.
    expect(back.closedToolIds).toEqual(rec.closedToolIds);
    expect(back.agentIds).toEqual(rec.agentIds);
    expect(back.openTools).toEqual(rec.openTools);
    expect(MAX_RECORD_BYTES - Buffer.byteLength(text, "utf-8")).toBe(104);
  });
});

describe("ensureTelemetrySubdir (T-499)", () => {
  it("creates the validated chain for a portable name and refuses anything else", () => {
    const root = mkdtempSync(join(tmpdir(), "intel-telemetry-"));
    try {
      const dir = ensureTelemetrySubdir(root, "session-intel")!;
      expect(dir).toBe(join(root, ".story", "telemetry", "session-intel"));
      expect(lstatSync(dir).isDirectory()).toBe(true);
      expect(ensureTelemetrySubdir(root, "session-intel")).toBe(dir); // idempotent
      for (const bad of ["", "..", "Presence", "a/b", "-x", "x".repeat(40)]) {
        expect(ensureTelemetrySubdir(root, bad), bad).toBeNull();
      }
      // A symlink squatting on the target level is refused, never written through.
      const elsewhere = mkdtempSync(join(tmpdir(), "intel-elsewhere-"));
      mkdirSync(join(root, ".story", "telemetry"), { recursive: true });
      symlinkSync(elsewhere, join(root, ".story", "telemetry", "eras"));
      expect(ensureTelemetrySubdir(root, "eras")).toBeNull();
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T-501: the advisory's persisted INPUTS and its once-per-session stamp.
// ---------------------------------------------------------------------------

describe("usage advisory persistence (T-501)", () => {
  it("round-trips usageInput and the shown stamp", () => {
    const parsed = parseSessionIntel(JSON.parse(JSON.stringify(full())))!;
    expect(parsed.lastSample!.usageInput).toEqual({ window: 1_000_000, source: "user", oneMillionFlag: true });
    expect(parsed.usageAdvisoryShownAt).toBe("2026-09-09T09:00:00.000Z");
  });

  it("an older record without either field reads null for both, keeping the sample", () => {
    const { usageAdvisoryShownAt: _s, ...noStamp } = full();
    const { usageInput: _u, ...noInput } = full().lastSample!;
    const parsed = parseSessionIntel({ ...noStamp, lastSample: noInput })!;
    expect(parsed.usageAdvisoryShownAt).toBeNull();
    expect(parsed.lastSample).not.toBeNull();
    expect(parsed.lastSample!.usageInput).toBeNull();
  });

  it("a malformed usageInput reads null WITHOUT dropping the sample, and a malformed stamp reads null", () => {
    for (const bad of [42, "x", [], { window: "big", source: "user", oneMillionFlag: true }, { window: 1.5 }, { window: 600_000, source: "policy" }]) {
      const parsed = parseSessionIntel({ ...full(), lastSample: { ...full().lastSample!, usageInput: bad } })!;
      expect(parsed.lastSample, JSON.stringify(bad)).not.toBeNull();
      expect(parsed.lastSample!.usageInput, JSON.stringify(bad)).toBeNull();
    }
    expect(parseSessionIntel({ ...full(), usageAdvisoryShownAt: "not a date" })!.usageAdvisoryShownAt).toBeNull();
  });

  it("a partial usageInput keeps only what validates", () => {
    const parsed = parseSessionIntel({ ...full(), lastSample: { ...full().lastSample!, usageInput: { window: 600_000, source: null, oneMillionFlag: null } } })!;
    expect(parsed.lastSample!.usageInput).toEqual({ window: 600_000, source: null, oneMillionFlag: null });
  });

  it("shedding drops display text, the path, then the sample (and the input with it), and NEVER the stamp", () => {
    const cap = sessionIntelBytes({ ...shedDisplayText(full()), transcriptPath: null }) - 1;
    const shed = fitSessionIntel(full(), cap)!;
    expect(shed.lastSample).toBeNull();
    expect(shed.usageAdvisoryShownAt).toBe("2026-09-09T09:00:00.000Z");
    expect(shed.autoCompactWindowAtStart).toBe(450_000);
  });

  it("a full subtree carrying usageInput and the stamp still fits the real cap", () => {
    expect(sessionIntelBytes(full())).toBeLessThanOrEqual(MAX_SESSION_INTEL_BYTES);
  });
});
