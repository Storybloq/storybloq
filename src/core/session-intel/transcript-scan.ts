/**
 * T-499: the transcript ACCESS CONTRACT, steps 2-4 -- bounded reads, session-
 * attributed evidence, and an observation describing exactly what was read.
 *
 * Three scan modes over one open prelude (`openTranscriptReadOnly`):
 *   tail      -- last 512 KiB, the pressure read every entry point does;
 *   backward  -- last 4 MiB, boundary-only, for reconciliation after a
 *                compaction whose boundary is beyond the tail;
 *   full      -- streamed, 64 MiB budget; over budget it degrades to the last
 *                64 MiB and reports `coverage: "partial"`, non-authoritative.
 *
 * Every EVIDENCE record (assistant usage, boundary, model change) must carry
 * `sessionId === expectedSessionId`; id-less records feed only display
 * metadata. Sidechain and meta records never count.
 *
 * Context in use is the last assistant record's
 * `input + cache_creation + cache_read` (never cumulative). The 1M flag
 * comes from a `Set model to ... (1M context)` line, taken only when no
 * model change is observed after it.
 */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, readSync } from "node:fs";
import { openTranscriptReadOnly } from "../transcript-open.js";
import type { Epoch, SessionIntelObservation } from "../../presence/session-intel-fields.js";
import type {
  ModelEvidence,
  ObservedModel,
  ScanCoverage,
  ScanResult,
  ScannedSessionFacts,
  TranscriptBoundary,
} from "./types.js";

export const TAIL_READ_BYTES = 512 * 1024;
export const BACKWARD_READ_BYTES = 4 * 1024 * 1024;
export const FULL_READ_BUDGET_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TAIL_LINES = 400;
const CHUNK_BYTES = 1024 * 1024;
const ANCHOR_BYTES = 64;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface ScanRequest {
  readonly path: string;
  readonly sessionId: string;
  readonly era: string | null;
  readonly revisionSeen: number | null;
  /** Deltas and the high-water mark count only records strictly after this timestamp. */
  readonly epochSince: string | null;
  readonly tailLines?: number;
}

// ---------------------------------------------------------------------------
// Record parsing
// ---------------------------------------------------------------------------

type Parsed =
  | { kind: "assistant"; ts: string | null; model: string | null; contextTokens: number | null; facts: FactBits }
  | { kind: "user"; ts: string | null; oneMillion: boolean | null; facts: FactBits }
  | { kind: "boundary"; boundary: TranscriptBoundary; facts: FactBits }
  | { kind: "model"; ts: string | null; oneMillion: boolean }
  | { kind: "meta"; facts: FactBits }
  | { kind: "skip" };

export type ParsedTranscriptRecord = Parsed;

interface FactBits {
  version?: string;
  entrypoint?: string;
  cwd?: string;
  gitBranch?: string;
  effort?: string;
  permissionMode?: string;
  aiTitle?: string;
  slug?: string;
  bridgeSessionId?: string;
  ts?: string;
}

/**
 * The exact command-result grammar, two observed wrappings of the name:
 *   Set model to `Opus 5 (1M context)` and saved as your default ...
 *   Set model to ESC[1mOpus 5 (1M context)ESC[22m and saved ...
 * The name is one wrapped token; the 1M marker sits inside it. Anything
 * else is not a model change.
 */
const SET_MODEL_BACKTICK = /^Set model to `([^`\n]{1,120})`/;
const SET_MODEL_ANSI = /^Set model to \x1b\[[0-9;]*m([^\x1b\n]{1,120})\x1b\[[0-9;]*m/;
const LOCAL_COMMAND_STDOUT = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= 512 ? v : undefined;
}

function iso(v: unknown): string | null {
  return typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null;
}

function nonNeg(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function factBits(r: Record<string, unknown>): FactBits {
  const f: FactBits = {};
  const version = str(r.version); if (version) f.version = version;
  const entrypoint = str(r.entrypoint); if (entrypoint) f.entrypoint = entrypoint;
  const cwd = str(r.cwd); if (cwd) f.cwd = cwd;
  const gitBranch = str(r.gitBranch); if (gitBranch) f.gitBranch = gitBranch;
  const effort = str(r.effort); if (effort) f.effort = effort;
  const ts = iso(r.timestamp); if (ts) f.ts = ts;
  return f;
}

/** Text of a record's message content, for the model-change line. */
function messageText(r: Record<string, unknown>): string | null {
  const message = r.message;
  if (!message || typeof message !== "object") return typeof r.content === "string" ? r.content : null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === "object" && (c as Record<string, unknown>).type === "text" && typeof (c as Record<string, unknown>).text === "string") {
        parts.push((c as Record<string, unknown>).text as string);
      }
    }
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

/**
 * Null unless `text` is exactly a local-command output envelope whose body
 * is a well-formed model-change result; else whether the set model names a
 * 1M context. Ordinary prompts and peer messages that merely quote the
 * phrase never match: they are not wrapped in the envelope.
 */
export function parseSetModel(text: string | null): boolean | null {
  if (!text) return null;
  const env = LOCAL_COMMAND_STDOUT.exec(text);
  if (!env) return null;
  const body = env[1]!.trim();
  const m = SET_MODEL_BACKTICK.exec(body) ?? SET_MODEL_ANSI.exec(body);
  if (!m) return null;
  return /\(1M context\)\s*$/.test(m[1]!.trim());
}

export function parseTranscriptRecord(line: string, expectedSessionId: string): Parsed {
  if (!line || line.length < 2 || line.length > MAX_LINE_BYTES) return { kind: "skip" };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "skip" };
  }
  return parseTranscriptObject(raw, expectedSessionId);
}

/**
 * ISS-1308: Claude Code's API-error and "Not logged in" placeholders are
 * assistant records with all-zero usage. They are not a measurement of the
 * context, a turn or a model, so every reader skips them.
 */
export function isSyntheticAssistantRecord(r: Record<string, unknown>): boolean {
  if (r.isApiErrorMessage === true) return true;
  const message = r.message;
  return !!message && typeof message === "object" && (message as Record<string, unknown>).model === "<synthetic>";
}

/**
 * ISS-1307: the classification half of `parseTranscriptRecord`, for a
 * caller that parsed the line itself and must tell a malformed line from an
 * ignored one (the subagent-compaction fill scan fails safe on the former).
 */
export function parseTranscriptObject(raw: unknown, expectedSessionId: string): Parsed {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "skip" };
  const r = raw as Record<string, unknown>;
  const sid = typeof r.sessionId === "string" ? r.sessionId : null;
  const attributed = sid === expectedSessionId;
  const type = r.type;

  // Typed metadata records: id-less ones serve display only; an id that
  // names ANOTHER session is refused outright.
  if (sid !== null && !attributed) return { kind: "skip" };
  if (type === "permission-mode") return { kind: "meta", facts: { permissionMode: str(r.permissionMode) } };
  if (type === "ai-title") return { kind: "meta", facts: { aiTitle: str(r.aiTitle) } };
  if (type === "slug") return { kind: "meta", facts: { slug: str(r.slug) } };
  if (type === "bridge-session") return { kind: "meta", facts: { bridgeSessionId: str(r.bridgeSessionId) } };

  // Everything below is EVIDENCE and needs positive attribution.
  if (!attributed) return { kind: "skip" };
  if (r.isSidechain === true) return { kind: "skip" };
  const facts = factBits(r);

  if (type === "system") {
    if (r.subtype === "compact_boundary") {
      const ts = iso(r.timestamp);
      const meta = (r.compactMetadata && typeof r.compactMetadata === "object" ? r.compactMetadata : {}) as Record<string, unknown>;
      if (!ts) return { kind: "skip" };
      return {
        kind: "boundary",
        boundary: {
          timestamp: ts,
          // Only a literal "auto" may ever be measured; anything else is
          // kept for invalidation as "unknown" (or "manual").
          trigger: meta.trigger === "auto" ? "auto" : meta.trigger === "manual" ? "manual" : "unknown",
          preTokens: nonNeg(meta.preTokens),
          postTokens: nonNeg(meta.postTokens),
        },
        facts,
      };
    }
    // A local-command system record is the only other place a model-change
    // result can legitimately appear; any other system record is metadata.
    if (r.subtype === "local_command") {
      const flag = parseSetModel(messageText(r));
      if (flag !== null) return { kind: "model", ts: iso(r.timestamp), oneMillion: flag };
    }
    return { kind: "meta", facts };
  }

  if (type === "assistant") {
    if (r.isMeta === true) return { kind: "skip" };
    if (isSyntheticAssistantRecord(r)) return { kind: "skip" };
    const message = (r.message && typeof r.message === "object" ? r.message : {}) as Record<string, unknown>;
    const usage = (message.usage && typeof message.usage === "object" ? message.usage : null) as Record<string, unknown> | null;
    let contextTokens: number | null = null;
    if (usage) {
      const input = nonNeg(usage.input_tokens);
      const creation = nonNeg(usage.cache_creation_input_tokens) ?? 0;
      const read = nonNeg(usage.cache_read_input_tokens) ?? 0;
      if (input !== null) contextTokens = input + creation + read;
    }
    return { kind: "assistant", ts: iso(r.timestamp), model: str(message.model) ?? null, contextTokens, facts };
  }

  if (type === "user") {
    // A model change surfaces as a user record whose WHOLE content is a
    // `<local-command-stdout>` envelope. Only the envelope is inspected; an
    // ordinary prompt quoting the phrase is a user turn like any other.
    const text = messageText(r);
    if (text !== null && LOCAL_COMMAND_STDOUT.test(text)) {
      const flag = parseSetModel(text);
      return flag === null ? { kind: "meta", facts } : { kind: "model", ts: iso(r.timestamp), oneMillion: flag };
    }
    if (r.isMeta === true) return { kind: "meta", facts };
    return { kind: "user", ts: iso(r.timestamp), oneMillion: null, facts };
  }

  return { kind: "meta", facts };
}

// ---------------------------------------------------------------------------
// Bounded reading with byte offsets
// ---------------------------------------------------------------------------

interface Window {
  readonly incarnation: string;
  readonly sizeAtOpen: number;
  /** Byte offset of the window's first byte. */
  readonly start: number;
  /** Complete lines only; `end` is the byte offset just past the last "\n". */
  readonly lines: readonly string[];
  readonly end: number;
  readonly anchorSha256: string;
}

function readRange(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const n = readSync(fd, buf, total, length - total, offset + total);
    if (n <= 0) break;
    total += n;
  }
  return buf.subarray(0, total);
}

function anchorFor(fd: number, consumedOffset: number): string {
  const len = Math.min(ANCHOR_BYTES, consumedOffset);
  const bytes = len > 0 ? readRange(fd, consumedOffset - len, len) : Buffer.alloc(0);
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads the last `maxBytes` as complete lines with offsets. Null when the open prelude refuses. */
function readTailWindow(path: string, maxBytes: number): Window | null {
  const opened = openTranscriptReadOnly(path);
  if (!opened) return null;
  try {
    const size = opened.size;
    const len = Math.min(size, maxBytes);
    const start = size - len;
    const buf = readRange(opened.fd, start, len);
    const text = buf.toString("utf-8");
    let lines = text.split("\n");
    // The last element is either "" (file ends with "\n") or a partial line
    // still being written; neither is a complete record.
    const lastNl = buf.lastIndexOf(0x0a);
    const end = lastNl < 0 ? start : start + lastNl + 1;
    lines = lines.slice(0, -1);
    // A mid-file window's first line is almost always a partial record.
    if (start > 0 && lines.length > 0) lines = lines.slice(1);
    return { incarnation: opened.incarnation, sizeAtOpen: size, start, lines, end, anchorSha256: anchorFor(opened.fd, end) };
  } catch {
    return null;
  } finally {
    try { closeSync(opened.fd); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

class Accumulator {
  contextTokens: number | null = null;
  lastAssistantAt: string | null = null;
  lastAssistantModel: string | null = null;
  /**
   * The newest model-change command and the assistant model it was observed
   * to produce (`appliedTo`, set by the first assistant record after the
   * command). A later assistant record on a DIFFERENT model is an unrelated
   * transition and discards the evidence.
   */
  setModel: { ts: string | null; flag: boolean; appliedTo: string | null } | null = null;
  boundaries: TranscriptBoundary[] = [];
  deltas: number[] = [];
  highWaterMark: number | null = null;
  assistantTurns = 0;
  userTurns = 0;
  models: ObservedModel[] = [];
  facts: FactBits = {};
  firstTs: string | null = null;
  lastTs: string | null = null;
  private prevContext: number | null = null;

  constructor(private readonly epochSinceMs: number) {}

  private afterEpoch(ts: string | null): boolean {
    if (!Number.isFinite(this.epochSinceMs)) return true;
    const ms = ts ? Date.parse(ts) : NaN;
    return Number.isFinite(ms) && ms > this.epochSinceMs;
  }

  private mergeFacts(f: FactBits): void {
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) continue;
      if (k === "ts") {
        if (this.firstTs === null) this.firstTs = v;
        this.lastTs = v;
        continue;
      }
      // Last write wins for facts that change (branch, effort, title); first for the rest is not needed.
      (this.facts as Record<string, string>)[k] = v;
    }
  }

  feed(line: string, sessionId: string): void {
    const p = parseTranscriptRecord(line, sessionId);
    switch (p.kind) {
      case "skip":
        return;
      case "meta":
        this.mergeFacts(p.facts);
        return;
      case "model":
        this.setModel = { ts: p.ts, flag: p.oneMillion, appliedTo: null };
        return;
      case "boundary":
        this.mergeFacts(p.facts);
        this.boundaries.push(p.boundary);
        // A compaction ends the pressure history: what was in context before
        // it is not what is in context now. Current usage is unknown until a
        // post-boundary assistant record says otherwise; counts are kept.
        this.prevContext = null;
        this.contextTokens = null;
        this.lastAssistantAt = null;
        this.deltas = [];
        this.highWaterMark = null;
        return;
      case "user":
        this.mergeFacts(p.facts);
        this.userTurns++;
        return;
      case "assistant": {
        this.mergeFacts(p.facts);
        this.assistantTurns++;
        if (p.model) {
          if (this.setModel) {
            if (this.setModel.appliedTo === null) this.setModel.appliedTo = p.model;
            else if (p.model !== this.setModel.appliedTo) this.setModel = null;
          }
          if (!this.models.some((m) => m.model === p.model)) this.models.push({ model: p.model, firstSeenAt: p.ts });
          this.lastAssistantModel = p.model;
        }
        if (p.contextTokens !== null) {
          this.contextTokens = p.contextTokens;
          this.lastAssistantAt = p.ts;
          if (this.afterEpoch(p.ts)) {
            if (this.prevContext !== null && p.contextTokens > this.prevContext) this.deltas.push(p.contextTokens - this.prevContext);
            if (this.highWaterMark === null || p.contextTokens > this.highWaterMark) this.highWaterMark = p.contextTokens;
          }
          this.prevContext = p.contextTokens;
        }
        return;
      }
    }
  }

  /** The flag of the newest model-change command that no unrelated transition has superseded. */
  oneMillionFlag(): boolean | null {
    return this.setModel ? this.setModel.flag : null;
  }

  sessionFacts(full: boolean): ScannedSessionFacts {
    const sorted = [...this.boundaries].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return {
      startedAt: full ? this.firstTs : null,
      version: this.facts.version ?? null,
      entrypoint: this.facts.entrypoint ?? null,
      cwd: this.facts.cwd ?? null,
      gitBranch: this.facts.gitBranch ?? null,
      permissionMode: this.facts.permissionMode ?? null,
      aiTitle: this.facts.aiTitle ?? null,
      slug: this.facts.slug ?? null,
      bridgeSessionId: this.facts.bridgeSessionId ?? null,
      effort: this.facts.effort ?? null,
      models: this.models,
      turns: { assistant: this.assistantTurns, user: this.userTurns, userIncludesPeerMessages: true, observed: true },
      compactions: {
        autoObserved: sorted.filter((b) => b.trigger === "auto").length,
        manualObserved: sorted.filter((b) => b.trigger === "manual").length,
        unknownObserved: sorted.filter((b) => b.trigger === "unknown").length,
        last: sorted.length ? sorted[sorted.length - 1]! : null,
      },
    };
  }
}

function epochOf(boundaries: readonly TranscriptBoundary[]): Epoch {
  if (boundaries.length === 0) return { kind: "unobserved" };
  const newest = boundaries.reduce((a, b) => (Date.parse(b.timestamp) > Date.parse(a.timestamp) ? b : a));
  return { kind: "observed", at: newest.timestamp };
}

function buildResult(
  req: ScanRequest,
  acc: Accumulator,
  w: { incarnation: string; sizeAtOpen: number; end: number; anchorSha256: string },
  coverage: ScanCoverage,
  scannedBytes: number,
  truncationReason: string | null,
  authoritative: boolean,
): ScanResult {
  const boundaries = [...acc.boundaries].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const observation: SessionIntelObservation = {
    era: req.era,
    incarnation: w.incarnation,
    sizeAtOpen: w.sizeAtOpen,
    consumedOffset: w.end,
    anchor: { offset: w.end, sha256: w.anchorSha256 },
    authoritative,
    revisionSeen: req.revisionSeen,
    lastRecordTimestamp: acc.lastTs,
    epoch: epochOf(boundaries),
  };
  const flag = acc.oneMillionFlag();
  const modelEvidence: ModelEvidence = flag === null ? "none" : coverage === "full" ? "full" : "tail";
  return {
    observation,
    coverage,
    scannedBytes,
    truncationReason,
    contextTokens: acc.contextTokens,
    lastAssistantAt: acc.lastAssistantAt,
    lastAssistantModel: acc.lastAssistantModel,
    oneMillionFlag: flag,
    modelEvidence,
    boundaries,
    deltas: acc.deltas,
    highWaterMark: acc.highWaterMark,
    session: acc.sessionFacts(coverage === "full"),
  };
}

function epochMs(req: ScanRequest): number {
  return req.epochSince ? Date.parse(req.epochSince) : NaN;
}

/** The pressure read: last 512 KiB, last `tailLines` complete records. Null when the file cannot be opened per the contract. */
export function scanTail(req: ScanRequest): ScanResult | null {
  const w = readTailWindow(req.path, TAIL_READ_BYTES);
  if (!w) return null;
  const acc = new Accumulator(epochMs(req));
  const lines = w.lines.slice(-(req.tailLines ?? DEFAULT_TAIL_LINES));
  for (const line of lines) acc.feed(line, req.sessionId);
  return buildResult(req, acc, w, "tail", w.end - w.start, null, true);
}

/**
 * Boundary-only scan of the last 4 MiB, newest boundary wins. Non-
 * authoritative (it consumed nothing for pressure). Null when unopenable.
 */
export function scanBackwardForBoundary(req: ScanRequest): { boundary: TranscriptBoundary | null; scannedBytes: number } | null {
  const w = readTailWindow(req.path, BACKWARD_READ_BYTES);
  if (!w) return null;
  for (let i = w.lines.length - 1; i >= 0; i--) {
    const p = parseTranscriptRecord(w.lines[i]!, req.sessionId);
    if (p.kind === "boundary") return { boundary: p.boundary, scannedBytes: w.end - w.start };
  }
  return { boundary: null, scannedBytes: w.end - w.start };
}

/**
 * Streamed whole-file read under a 64 MiB budget. Over budget, the LAST
 * 64 MiB are read instead and the result is `partial`: counts are what was
 * observed, session-wide facts that need the head are null, and the
 * observation is non-authoritative so it can never persist.
 */
export function scanFull(req: ScanRequest, budgetBytes = FULL_READ_BUDGET_BYTES): ScanResult | null {
  const opened = openTranscriptReadOnly(req.path);
  if (!opened) return null;
  try {
    const size = opened.size;
    const partial = size > budgetBytes;
    const start = partial ? size - budgetBytes : 0;
    const acc = new Accumulator(epochMs(req));
    let offset = start;
    let carry: Buffer = Buffer.alloc(0);
    let end = start;
    let first = partial;
    while (offset < size) {
      const chunk = readRange(opened.fd, offset, Math.min(CHUNK_BYTES, size - offset));
      if (chunk.length === 0) break;
      offset += chunk.length;
      let buf: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let nl: number;
      let cursor = 0;
      while ((nl = buf.indexOf(0x0a, cursor)) >= 0) {
        const line = buf.subarray(cursor, nl).toString("utf-8");
        cursor = nl + 1;
        end = offset - (buf.length - cursor);
        if (first) { first = false; continue; } // partial first line of a mid-file start
        acc.feed(line, req.sessionId);
      }
      carry = buf.subarray(cursor);
      if (carry.length > MAX_LINE_BYTES) carry = Buffer.alloc(0);
      buf = Buffer.alloc(0);
    }
    const anchorSha256 = anchorFor(opened.fd, end);
    const w = { incarnation: opened.incarnation, sizeAtOpen: size, end, anchorSha256 };
    return buildResult(
      req,
      acc,
      w,
      partial ? "partial" : "full",
      end - start,
      partial ? `transcript is ${size} bytes; only the last ${budgetBytes} were read` : null,
      !partial,
    );
  } catch {
    return null;
  } finally {
    try { closeSync(opened.fd); } catch { /* ignore */ }
  }
}

export interface AnchorsCheck {
  readonly incarnation: string | null;
  readonly size: number | null;
  /** One verdict per anchor, in input order, all read through the SAME descriptor. */
  readonly ok: readonly boolean[];
  /** The authorized pathname still names the descriptor's inode after the reads. */
  readonly pathStillIdentifies: boolean;
}

/**
 * Re-checks several anchors through ONE open descriptor, so a replacement
 * between two separate opens cannot validate one anchor against the old
 * file and another against the new one. After the reads the pathname is
 * lstat'ed again: a replacement after the open is reported as
 * `pathStillIdentifies: false`.
 */
export function anchorsStillMatch(path: string, anchors: ReadonlyArray<{ offset: number; sha256: string }>): AnchorsCheck {
  const opened = openTranscriptReadOnly(path);
  if (!opened) return { incarnation: null, size: null, ok: anchors.map(() => false), pathStillIdentifies: false };
  try {
    const ok = anchors.map((a) => {
      try { return opened.size >= a.offset && anchorFor(opened.fd, a.offset) === a.sha256; } catch { return false; }
    });
    let same = false;
    try {
      const st = lstatSync(path);
      same = st.isFile() && `${st.dev}:${st.ino}` === opened.incarnation;
    } catch { /* gone: not identified */ }
    return { incarnation: opened.incarnation, size: opened.size, ok, pathStillIdentifies: same };
  } finally {
    try { closeSync(opened.fd); } catch { /* ignore */ }
  }
}

/** Re-checks an observation's anchor against the file as it is NOW (the persistence rule's incoming check). */
export function anchorStillMatches(path: string, anchor: { offset: number; sha256: string }): { ok: boolean; incarnation: string | null; size: number | null } {
  const opened = openTranscriptReadOnly(path);
  if (!opened) return { ok: false, incarnation: null, size: null };
  try {
    if (opened.size < anchor.offset) return { ok: false, incarnation: opened.incarnation, size: opened.size };
    return { ok: anchorFor(opened.fd, anchor.offset) === anchor.sha256, incarnation: opened.incarnation, size: opened.size };
  } catch {
    return { ok: false, incarnation: opened.incarnation, size: opened.size };
  } finally {
    try { closeSync(opened.fd); } catch { /* ignore */ }
  }
}
