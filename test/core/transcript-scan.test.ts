import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, appendFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  anchorStillMatches,
  isSyntheticAssistantRecord,
  parseSetModel,
  parseTranscriptRecord,
  scanBackwardForBoundary,
  scanFull,
  scanTail,
  type ScanRequest,
} from "../../src/core/session-intel/transcript-scan.js";
import { openTranscriptReadOnly } from "../../src/core/transcript-open.js";
import { SID, assistantRecord, boundaryRecord, growingSession, localCommandRecord, metaRecord, userRecord, writeTranscript } from "./session-intel-fixtures.js";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "si-scan-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function req(path: string, over: Partial<ScanRequest> = {}): ScanRequest {
  return { path, sessionId: SID, era: "1:2", revisionSeen: 3, epochSince: null, ...over };
}

/** ISS-1308: Claude Code's API-error / "Not logged in" placeholder: an assistant record with all-zero usage. */
function syntheticRecord(o: { ts: string; apiError?: boolean; model?: string }): string {
  const rec = JSON.parse(assistantRecord({ ts: o.ts, model: o.model ?? "<synthetic>", input: 0 })) as Record<string, unknown>;
  if (o.apiError) rec.isApiErrorMessage = true;
  (rec.message as Record<string, unknown>).usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  return JSON.stringify(rec);
}

const T = (m: number) => new Date(Date.parse("2026-09-09T12:00:00Z") + m * 60_000).toISOString();

describe("parseTranscriptRecord", () => {
  it("context = input + cache_creation + cache_read, never cumulative or output", () => {
    const p = parseTranscriptRecord(assistantRecord({ ts: T(0), input: 2, creation: 68_711, read: 26_681 }), SID);
    expect(p.kind).toBe("assistant");
    if (p.kind === "assistant") expect(p.contextTokens).toBe(95_394);
  });

  it("refuses evidence from another session, sidechains and meta assistants; id-less metadata is display only", () => {
    expect(parseTranscriptRecord(assistantRecord({ ts: T(0), sessionId: "other" }), SID).kind).toBe("skip");
    expect(parseTranscriptRecord(assistantRecord({ ts: T(0), sidechain: true }), SID).kind).toBe("skip");
    expect(parseTranscriptRecord(assistantRecord({ ts: T(0), isMeta: true }), SID).kind).toBe("skip");
    expect(parseTranscriptRecord(boundaryRecord({ ts: T(0), pre: 1, sessionId: "other" }), SID).kind).toBe("skip");
    expect(parseTranscriptRecord(metaRecord({ type: "ai-title", value: "x", sessionId: null }), SID).kind).toBe("meta");
    expect(parseTranscriptRecord(metaRecord({ type: "ai-title", value: "x", sessionId: "other" }), SID).kind).toBe("skip");
    expect(parseTranscriptRecord("not json", SID).kind).toBe("skip");
    expect(parseTranscriptRecord("[1]", SID).kind).toBe("skip");
  });

  it("both 1M forms parse equal, and a non-1M set-model line reads false", () => {
    const a = parseTranscriptRecord(localCommandRecord({ ts: T(0), form: "backtick", oneMillion: true }), SID);
    const b = parseTranscriptRecord(localCommandRecord({ ts: T(0), form: "ansi", oneMillion: true }), SID);
    const c = parseTranscriptRecord(localCommandRecord({ ts: T(0), form: "backtick", oneMillion: false }), SID);
    expect(a).toEqual({ kind: "model", ts: T(0), oneMillion: true });
    expect(b).toEqual({ kind: "model", ts: T(0), oneMillion: true });
    expect(c).toEqual({ kind: "model", ts: T(0), oneMillion: false });
    expect(parseSetModel("nothing here")).toBeNull();
  });

  it("an ordinary prompt or peer message quoting 'Set model to' is a user turn, never model evidence", () => {
    const quoted = userRecord({ ts: T(0), text: "Earlier the log said Set model to `Opus 5 (1M context)` and saved, ignore that" });
    expect(parseTranscriptRecord(quoted, SID).kind).toBe("user");
    // Envelope present but malformed body: metadata, not a flag.
    const malformed = userRecord({ ts: T(0), text: "<local-command-stdout>Set model to Opus 5 (1M context)</local-command-stdout>" });
    expect(parseTranscriptRecord(malformed, SID).kind).toBe("meta");
    // Envelope must wrap the WHOLE content.
    const partial = userRecord({ ts: T(0), text: "note <local-command-stdout>Set model to `Opus 5 (1M context)`</local-command-stdout>" });
    expect(parseTranscriptRecord(partial, SID).kind).toBe("user");
    // A system record only counts under the local_command subtype.
    const sys = JSON.stringify({ type: "system", subtype: "other", sessionId: SID, content: "<local-command-stdout>Set model to `Opus 5 (1M context)`</local-command-stdout>", timestamp: T(0) });
    expect(parseTranscriptRecord(sys, SID).kind).toBe("meta");
    const sysLocal = JSON.stringify({ type: "system", subtype: "local_command", sessionId: SID, content: "<local-command-stdout>Set model to `Opus 5 (1M context)`</local-command-stdout>", timestamp: T(0) });
    expect(parseTranscriptRecord(sysLocal, SID)).toEqual({ kind: "model", ts: T(0), oneMillion: true });
  });

  it("a boundary with a missing or unexpected trigger is 'unknown', never 'auto'", () => {
    const missing = JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: SID, timestamp: T(0), compactMetadata: { preTokens: 5 } });
    expect(parseTranscriptRecord(missing, SID)).toMatchObject({ kind: "boundary", boundary: { trigger: "unknown", preTokens: 5 } });
    const odd = JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: SID, timestamp: T(0), compactMetadata: { trigger: "AUTO", preTokens: 5 } });
    expect(parseTranscriptRecord(odd, SID)).toMatchObject({ kind: "boundary", boundary: { trigger: "unknown" } });
  });

  it("boundary carries trigger, pre and post", () => {
    const p = parseTranscriptRecord(boundaryRecord({ ts: T(1), trigger: "manual", pre: 331_000, post: 20_000 }), SID);
    expect(p).toMatchObject({ kind: "boundary", boundary: { timestamp: T(1), trigger: "manual", preTokens: 331_000, postTokens: 20_000 } });
  });
});

describe("ISS-1308: synthetic and API-error assistant records are not measurements", () => {
  it("isSyntheticAssistantRecord: the <synthetic> model or a literal true isApiErrorMessage, nothing else", () => {
    expect(isSyntheticAssistantRecord({ type: "assistant", message: { model: "<synthetic>" } })).toBe(true);
    expect(isSyntheticAssistantRecord({ type: "assistant", isApiErrorMessage: true, message: { model: "claude-opus-5" } })).toBe(true);
    expect(isSyntheticAssistantRecord({ type: "assistant", message: { model: "claude-opus-5" } })).toBe(false);
    expect(isSyntheticAssistantRecord({ type: "assistant" })).toBe(false);
    expect(isSyntheticAssistantRecord({ type: "assistant", message: "<synthetic>" })).toBe(false);
    expect(isSyntheticAssistantRecord({ type: "assistant", isApiErrorMessage: "true", message: { model: "claude-opus-5" } })).toBe(false);
  });

  it("the parser skips both forms", () => {
    expect(parseTranscriptRecord(syntheticRecord({ ts: T(0) }), SID).kind).toBe("skip");
    expect(parseTranscriptRecord(syntheticRecord({ ts: T(0), apiError: true, model: "claude-opus-5" }), SID).kind).toBe("skip");
  });

  it("a transcript ending on a synthetic record reports the preceding real context, not 0, and no <synthetic> model", () => {
    for (const apiError of [false, true]) {
      withDir((dir) => {
        const lines = [
          assistantRecord({ ts: T(0), read: 80_000 }),
          syntheticRecord({ ts: T(1), apiError, model: apiError ? "claude-opus-5" : undefined }),
        ];
        const path = writeTranscript(dir, "p", SID, lines);
        const r = scanTail(req(path))!;
        expect(r.contextTokens).toBe(80_002);
        expect(r.lastAssistantAt).toBe(T(0));
        expect(r.lastAssistantModel).toBe("claude-opus-5");
        expect(r.session.turns?.assistant).toBe(1);
        expect(r.session.models.map((m) => m.model)).toEqual(["claude-opus-5"]);
      });
    }
  });

  it("a synthetic record between two real ones leaves only the real growth in deltas", () => {
    withDir((dir) => {
      const lines = [
        assistantRecord({ ts: T(0), read: 80_000 }),
        syntheticRecord({ ts: T(1) }),
        assistantRecord({ ts: T(2), read: 85_000 }),
      ];
      const path = writeTranscript(dir, "p", SID, lines);
      const r = scanFull(req(path))!;
      expect(r.contextTokens).toBe(85_002);
      expect(r.deltas).toEqual([5_000]);
      expect(r.highWaterMark).toBe(85_002);
      expect(r.session.turns?.assistant).toBe(2);
      expect(r.lastAssistantModel).toBe("claude-opus-5");
    });
  });

  it("a synthetic record does not mark a pending set-model as applied", () => {
    withDir((dir) => {
      const lines = [
        assistantRecord({ ts: T(0), read: 80_000, model: "claude-opus-5" }),
        localCommandRecord({ ts: T(1), form: "backtick", oneMillion: true }),
        syntheticRecord({ ts: T(2) }),
        assistantRecord({ ts: T(3), read: 81_000, model: "claude-opus-5-1m" }),
        assistantRecord({ ts: T(4), read: 82_000, model: "claude-opus-5-1m" }),
      ];
      const path = writeTranscript(dir, "p", SID, lines);
      const r = scanTail(req(path))!;
      // Had the placeholder applied the command, the real transition to the
      // 1M model would be "unrelated" and discard the flag.
      expect(r.oneMillionFlag).toBe(true);
    });
  });

  it("the fill scan imports the predicate instead of carrying a second copy of the rule", () => {
    const src = readFileSync(new URL("../../src/autonomous/subagent-compaction.ts", import.meta.url), "utf8");
    expect(src).toContain("isSyntheticAssistantRecord");
    expect(src).not.toContain('"<synthetic>"');
    expect(src).not.toContain("isApiErrorMessage");
  });
});

describe("scanTail", () => {
  it("returns the last assistant's context, an authoritative observation whose consumedOffset is EOF, and a matching anchor", () => {
    withDir((dir) => {
      const lines = [
        metaRecord({ type: "permission-mode", value: "bypassPermissions" }),
        metaRecord({ type: "ai-title", value: "Title" }),
        ...growingSession(3, 100_000, 5_000),
      ];
      const path = writeTranscript(dir, "p", SID, lines);
      const size = statSync(path).size;
      const r = scanTail(req(path))!;
      expect(r.coverage).toBe("tail");
      expect(r.contextTokens).toBe(2 + 110_000);
      expect(r.observation).toMatchObject({ era: "1:2", revisionSeen: 3, sizeAtOpen: size, consumedOffset: size, authoritative: true, epoch: { kind: "unobserved" } });
      expect(r.observation.incarnation).toMatch(/^\d+:\d+$/);
      const tail = Buffer.from(lines.join("\n") + "\n").subarray(-64);
      expect(r.observation.anchor).toEqual({ offset: size, sha256: createHash("sha256").update(tail).digest("hex") });
      expect(r.session.permissionMode).toBe("bypassPermissions");
      expect(r.session.aiTitle).toBe("Title");
      expect(r.session.turns).toEqual({ assistant: 3, user: 3, userIncludesPeerMessages: true, observed: true });
      expect(r.session.startedAt).toBeNull(); // tail cannot see the head
      expect(r.session.version).toBe("2.1.266");
      expect(r.modelEvidence).toBe("none");
      expect(r.oneMillionFlag).toBeNull();
    });
  });

  it("walks back over a truncated last line: consumedOffset stops at the last complete record", () => {
    withDir((dir) => {
      const lines = growingSession(2, 100_000, 5_000);
      const path = writeTranscript(dir, "p", SID, lines);
      const complete = statSync(path).size;
      appendFileSync(path, '{"type":"assistant","sessionId":"' + SID + '","message":{"usage":{"input_tokens":9');
      const r = scanTail(req(path))!;
      expect(r.contextTokens).toBe(2 + 105_000);
      expect(r.observation.consumedOffset).toBe(complete);
      expect(r.observation.sizeAtOpen).toBeGreaterThan(complete);
    });
  });

  it("skips sidechain and meta records, and a 'Set model' line is not a user turn", () => {
    withDir((dir) => {
      const lines = [
        assistantRecord({ ts: T(0), read: 50_000 }),
        assistantRecord({ ts: T(1), read: 900_000, sidechain: true }),
        userRecord({ ts: T(2), isMeta: true }),
        localCommandRecord({ ts: T(3), form: "backtick", oneMillion: true }),
        assistantRecord({ ts: T(4), read: 60_000 }),
      ];
      const path = writeTranscript(dir, "p", SID, lines);
      const r = scanTail(req(path))!;
      expect(r.contextTokens).toBe(60_002);
      expect(r.session.turns).toEqual({ assistant: 2, user: 0, userIncludesPeerMessages: true, observed: true });
      expect(r.oneMillionFlag).toBe(true);
      expect(r.modelEvidence).toBe("tail");
      expect(r.highWaterMark).toBe(60_002);
    });
  });

  it("a model command survives the transition it caused and is discarded by a later unrelated one", () => {
    withDir((dir) => {
      // A -> set B (1M) -> B: the flag belongs to B.
      const caused = [
        assistantRecord({ ts: T(0), read: 50_000, model: "claude-opus-5" }),
        localCommandRecord({ ts: T(1), form: "ansi", oneMillion: true, model: "Sonnet 5" }),
        assistantRecord({ ts: T(2), read: 51_000, model: "claude-sonnet-5" }),
      ];
      const r1 = scanTail(req(writeTranscript(dir, "a", SID, caused)))!;
      expect(r1.oneMillionFlag).toBe(true);
      expect(r1.modelEvidence).toBe("tail");
      expect(r1.lastAssistantModel).toBe("claude-sonnet-5");
      // ... then C: an unrelated transition supersedes it.
      const r2 = scanTail(req(writeTranscript(dir, "b", SID, [...caused, assistantRecord({ ts: T(3), read: 52_000, model: "claude-haiku-4-5" })])))!;
      expect(r2.oneMillionFlag).toBeNull();
      expect(r2.modelEvidence).toBe("none");
      expect(r2.session.models.map((m) => m.model)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]);
      // Same model re-set with 1M (assistant model name carries no suffix): applied, no transition, flag kept.
      const same = [assistantRecord({ ts: T(0), model: "claude-opus-5" }), localCommandRecord({ ts: T(1), form: "backtick", oneMillion: true }), assistantRecord({ ts: T(2), model: "claude-opus-5" })];
      expect(scanTail(req(writeTranscript(dir, "c", SID, same)))!.oneMillionFlag).toBe(true);
    });
  });

  it("boundaries in the window set the observed epoch; deltas and the high-water mark count only after epochSince", () => {
    withDir((dir) => {
      const lines = [
        ...growingSession(4, 400_000, 5_000),                 // T(0..3)
        boundaryRecord({ ts: T(10), pre: 417_737 }),
        assistantRecord({ ts: T(11), read: 30_000 }),
        assistantRecord({ ts: T(12), read: 40_000 }),
        assistantRecord({ ts: T(13), read: 38_000 }),
      ];
      const path = writeTranscript(dir, "p", SID, lines);
      const all = scanTail(req(path))!;
      expect(all.observation.epoch).toEqual({ kind: "observed", at: T(10) });
      expect(all.boundaries).toHaveLength(1);
      expect(all.session.compactions).toMatchObject({ autoObserved: 1, manualObserved: 0, unknownObserved: 0 });
      const mixed = [
        boundaryRecord({ ts: T(20), pre: 1 }),
        boundaryRecord({ ts: T(21), pre: 1, trigger: "manual" }),
        JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: SID, timestamp: T(22), compactMetadata: { preTokens: 1 } }),
        assistantRecord({ ts: T(23), read: 5 }),
      ];
      expect(scanTail(req(writeTranscript(dir, "m", SID, mixed)))!.session.compactions).toMatchObject({ autoObserved: 1, manualObserved: 1, unknownObserved: 1 });
      const since = scanTail(req(path, { epochSince: T(10) }))!;
      expect(since.deltas).toEqual([10_000]);
      expect(since.highWaterMark).toBe(40_002);
      // A boundary in the window resets the pressure history even with an
      // older (or null) epochSince: nothing from before it may size the jump.
      expect(all.deltas).toEqual([10_000]);
      expect(all.highWaterMark).toBe(40_002);
      expect(all.contextTokens).toBe(38_002);
      expect(scanTail(req(path, { epochSince: T(0) }))!.deltas).toEqual([10_000]);
    });
  });

  it("a transcript ending at a boundary has unknown current usage, while counts survive", () => {
    withDir((dir) => {
      const lines = [...growingSession(3, 400_000, 5_000), boundaryRecord({ ts: T(10), pre: 417_737 })];
      const r = scanTail(req(writeTranscript(dir, "p", SID, lines)))!;
      expect(r.contextTokens).toBeNull();
      expect(r.lastAssistantAt).toBeNull();
      expect(r.highWaterMark).toBeNull();
      expect(r.deltas).toEqual([]);
      expect(r.observation.epoch).toEqual({ kind: "observed", at: T(10) });
      expect(r.session.turns!.assistant).toBe(3);
      expect(r.lastAssistantModel).toBe("claude-opus-5");
    });
  });

  it("tailLines bounds the records considered", () => {
    withDir((dir) => {
      const path = writeTranscript(dir, "p", SID, growingSession(50, 1000, 10));
      const r = scanTail(req(path, { tailLines: 4 }))!;
      expect(r.session.turns!.assistant).toBe(2);
    });
  });

  it("is null for an unopenable, symlinked or directory path", () => {
    withDir((dir) => {
      expect(scanTail(req(join(dir, "missing.jsonl")))).toBeNull();
      mkdirSync(join(dir, "d.jsonl"));
      expect(scanTail(req(join(dir, "d.jsonl")))).toBeNull();
    });
  });

  it("reads only the tail of a large file (> 512 KiB) and drops the partial first line of the window", () => {
    withDir((dir) => {
      const lines = growingSession(3000, 1_000, 100); // ~1.3 MB
      const path = writeTranscript(dir, "p", SID, lines);
      const r = scanTail(req(path, { tailLines: 100_000 }))!;
      expect(r.scannedBytes).toBeLessThanOrEqual(512 * 1024);
      expect(r.contextTokens).toBe(2 + 1_000 + 2999 * 100);
      expect(r.observation.consumedOffset).toBe(statSync(path).size);
      expect(r.session.turns!.assistant).toBeLessThan(3000);
    });
  });
});

describe("scanBackwardForBoundary", () => {
  it("finds the newest boundary beyond the 512 KiB tail, within 4 MiB", () => {
    withDir((dir) => {
      const lines = [boundaryRecord({ ts: T(0), pre: 400_000 }), ...growingSession(3000, 1_000, 100), boundaryRecord({ ts: T(5), pre: 410_000 }), ...growingSession(3000, 1_000, 100)];
      const path = writeTranscript(dir, "p", SID, lines);
      expect(scanTail(req(path))!.boundaries).toHaveLength(0);
      const b = scanBackwardForBoundary(req(path))!;
      expect(b.boundary?.timestamp).toBe(T(5));
      expect(b.scannedBytes).toBeGreaterThan(512 * 1024);
    });
  });

  it("is null-boundary when none is present and null when unopenable", () => {
    withDir((dir) => {
      const path = writeTranscript(dir, "p", SID, growingSession(2, 1, 1));
      expect(scanBackwardForBoundary(req(path))).toEqual({ boundary: null, scannedBytes: statSync(path).size });
      expect(scanBackwardForBoundary(req(join(dir, "x.jsonl")))).toBeNull();
    });
  });
});

describe("scanFull", () => {
  it("streams the whole file: startedAt from the head, full counts, authoritative", () => {
    withDir((dir) => {
      const lines = [metaRecord({ type: "slug", value: "s" }), ...growingSession(2500, 1_000, 100), boundaryRecord({ ts: T(9999), pre: 1 }), localCommandRecord({ ts: T(10_000), form: "backtick", oneMillion: false }), assistantRecord({ ts: T(10_001), read: 5 })];
      const path = writeTranscript(dir, "p", SID, lines);
      const r = scanFull(req(path))!;
      expect(r.coverage).toBe("full");
      expect(r.session.startedAt).toBe(T(0));
      expect(r.session.slug).toBe("s");
      expect(r.session.turns!.assistant).toBe(2501);
      expect(r.observation.authoritative).toBe(true);
      expect(r.observation.consumedOffset).toBe(statSync(path).size);
      expect(r.modelEvidence).toBe("full");
      expect(r.oneMillionFlag).toBe(false);
      expect(r.contextTokens).toBe(7);
      const tail = scanTail(req(path))!;
      expect(tail.contextTokens).toBe(r.contextTokens);
      expect(tail.observation.anchor).toEqual(r.observation.anchor);
    });
  });

  it("over budget degrades to partial: last bytes only, non-authoritative, head facts null, reason set", () => {
    withDir((dir) => {
      const lines = growingSession(3000, 1_000, 100);
      const path = writeTranscript(dir, "p", SID, lines);
      const r = scanFull(req(path), 256 * 1024)!;
      expect(r.coverage).toBe("partial");
      expect(r.observation.authoritative).toBe(false);
      expect(r.scannedBytes).toBeLessThanOrEqual(256 * 1024);
      expect(r.truncationReason).toMatch(/only the last 262144 were read/);
      expect(r.session.startedAt).toBeNull();
      expect(r.session.turns!.assistant).toBeLessThan(3000);
      expect(r.contextTokens).toBe(2 + 1_000 + 2999 * 100);
    });
  });
});

describe("anchorStillMatches / openTranscriptReadOnly", () => {
  it("matches an untouched file, fails after truncation, and fails on an equal-length rewrite", () => {
    withDir((dir) => {
      const path = writeTranscript(dir, "p", SID, growingSession(3, 1_000, 100));
      const r = scanTail(req(path))!;
      expect(anchorStillMatches(path, r.observation.anchor).ok).toBe(true);
      const size = statSync(path).size;
      truncateSync(path, size - 10);
      expect(anchorStillMatches(path, r.observation.anchor)).toMatchObject({ ok: false, size: size - 10 });
      writeFileSync(path, "x".repeat(size));
      expect(anchorStillMatches(path, r.observation.anchor).ok).toBe(false);
    });
  });

  it("openTranscriptReadOnly refuses a directory and closes on refusal; the caller closes on success", () => {
    withDir((dir) => {
      mkdirSync(join(dir, "d"));
      expect(openTranscriptReadOnly(join(dir, "d"))).toBeNull();
      const path = writeTranscript(dir, "p", SID, ["{}"]);
      const o = openTranscriptReadOnly(path)!;
      expect(o.size).toBe(3);
      expect(o.incarnation).toMatch(/^\d+:\d+$/);
      const { closeSync } = require("node:fs") as typeof import("node:fs");
      closeSync(o.fd);
    });
  });
});
