/**
 * ISS-1307: tell a subagent's compaction from the parent thread's own.
 *
 * Inside a subagent, Claude Code (verified on 2.1.281) fires PreCompact and
 * SessionStart(compact) with the PARENT's session_id and the parent's
 * transcript_path, and without the documented `agent_id`. Recording that fire
 * as the parent's compaction moves the parent's autonomous session to COMPACT
 * although the parent never compacted.
 *
 * Two kinds of signal decide it:
 * - explicit: `agent_id` on the hook input, or a transcript_path under a
 *   `subagents/` directory. `agent_type` is never a signal: a
 *   `claude --agent X` main session carries it on every hook.
 * - fill: the main thread's context at this moment, measured from its own
 *   transcript against the preTokens of its last auto compaction, is below
 *   SUBAGENT_FILL_THRESHOLD, AND a subagent of this session is active (or,
 *   at SessionStart, has just written its own compact boundary).
 *
 * Every doubt is resolved as "the parent's own compaction", which is the
 * behaviour before this module existed. The transcript read is bounded in
 * bytes and in wall-clock time and is never a whole-file parse.
 */

import { closeSync, lstatSync, opendirSync, readSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { openTranscriptReadOnly } from "../core/transcript-open.js";
import { findResumableSession } from "./session.js";
import { authorizeTranscriptPath } from "../core/session-intel/transcript-locate.js";
import { MAX_LINE_BYTES, isSyntheticAssistantRecord, parseTranscriptObject } from "../core/session-intel/transcript-scan.js";

/**
 * Fill below this is a subagent's compaction; exactly this or above is the
 * main thread's. Evidence (ai-notebook session 2cdff16a, 12 compactions on
 * Claude Code 2.1.281): the 8 real main-thread compactions measured 0.87 to
 * 0.98, the 4 subagent compactions 0.34 to 0.40.
 */
export const SUBAGENT_FILL_THRESHOLD = 0.6;

/**
 * Byte cap of the backward scan. A main compaction cycle at a ~270k point
 * is under 2 MB of transcript (about 7 bytes per token); the guard can only
 * fire below 60% of a cycle, and 60% of a 1M-window cycle at that density is
 * about 4 MB, so 8 MiB is twice that. A last boundary farther away than this
 * is deep into a cycle, where treating the fire as real is right anyway.
 */
export const FILL_SCAN_MAX_BYTES = 8 * 1024 * 1024;
export const FILL_SCAN_CHUNK_BYTES = 256 * 1024;

/**
 * Wall-clock cap of one whole classification (the scan plus corroboration).
 * SessionStart is on the resumed turn's critical path and its stdin read
 * already allows 200 ms.
 */
export const FILL_SCAN_MAX_MS = 250;

/**
 * Bytes written after the last usage record count as `ceil(bytes / 3)`
 * extra tokens. JSON overhead makes bytes exceed tokens, so the estimate
 * leans toward "main".
 */
export const TAIL_BYTES_PER_TOKEN = 3;

export const SUBAGENT_ACTIVITY_WINDOW_MS = 120_000;
export const SUBAGENT_FILES_MAX = 8;
export const SUBAGENT_TAIL_BYTES = 64 * 1024;
const SUBAGENT_DIR_ENTRIES_MAX = 2048;
const SUBAGENT_STAT_BATCH = 64;
const SUBAGENT_FUTURE_SKEW_MS = 5_000;
const SUBAGENT_FILE_PATTERN = /^agent-([A-Za-z0-9._-]{1,128})\.jsonl$/;
const NEWLINE = 0x0a;

export type SubagentCompactionSignal = "agent_id" | "transcript_path" | "fill";

export interface SubagentCompactionVerdict {
  readonly signal: SubagentCompactionSignal;
  readonly agentId: string | null;
  readonly fill: number | null;
}

/** The explicit signals parsed from hook stdin. */
export interface SubagentHookSignal {
  readonly agentId?: string;
  readonly viaTranscriptPath: boolean;
}

export interface ClassifyDeadline {
  expired(): boolean;
}

export function createClassifyDeadline(
  ms: number = FILL_SCAN_MAX_MS,
  clock: () => number = () => performance.now(),
): ClassifyDeadline {
  const until = clock() + ms;
  return { expired: () => clock() > until };
}

export interface ClassifyOptions {
  /** Test seam; defaults to `~/.claude/projects`. */
  readonly projectsDir?: string;
  /** Epoch ms for the subagent activity window; defaults to Date.now(). */
  readonly now?: number;
  /** Defaults to a fresh FILL_SCAN_MAX_MS deadline per classification. */
  readonly deadline?: ClassifyDeadline;
  readonly maxBytes?: number;
  readonly chunkBytes?: number;
}

// ---------------------------------------------------------------------------
// Explicit signals
// ---------------------------------------------------------------------------

/** A transcript_path with a path segment exactly `subagents` and an `agent-*` basename. */
export function isSubagentTranscriptPath(path: string): boolean {
  const segments = path.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? "";
  return base.startsWith("agent-") && segments.slice(0, -1).includes("subagents");
}

function explicitVerdict(subagent: SubagentHookSignal | undefined): SubagentCompactionVerdict | null {
  if (!subagent) return null;
  if (subagent.agentId) return { signal: "agent_id", agentId: subagent.agentId, fill: null };
  if (subagent.viaTranscriptPath) return { signal: "transcript_path", agentId: null, fill: null };
  return null;
}

// ---------------------------------------------------------------------------
// Main-thread fill
// ---------------------------------------------------------------------------

export type MainFillUnknownReason =
  | "unauthorized"
  | "unreadable"
  | "malformed"
  | "oversized"
  | "model-changed"
  | "no-usage"
  | "reference-not-auto"
  | "no-pretokens"
  | "no-boundary"
  | "byte-cap"
  | "time-cap";

export type MainFillResult =
  | {
    readonly kind: "measured";
    readonly fill: number;
    readonly contextTokens: number;
    readonly tailBytes: number;
    readonly preTokens: number;
    readonly scannedBytes: number;
  }
  | { readonly kind: "unknown"; readonly reason: MainFillUnknownReason; readonly scannedBytes: number };

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;

/**
 * transcript-scan reads an invalid cache counter as 0, which is right for
 * display but would understate the context here: every counter present must
 * be a non-negative integer, and input_tokens must be present.
 */
function usageIsWellFormed(message: Record<string, unknown>): boolean {
  const usage = message.usage;
  if (!isRecord(usage)) return false;
  for (const key of USAGE_FIELDS) {
    const v = usage[key];
    if (v === undefined && key !== "input_tokens") continue;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return false;
  }
  return true;
}

interface FillScanState {
  contextTokens: number | null;
  tailBytes: number;
  model: string | null;
}

type LineOutcome =
  | { readonly kind: "continue" }
  | { readonly kind: "done"; readonly result: MainFillResult };

/**
 * One complete line, newest to oldest. `lineEnd` is the byte offset just past
 * its "\n". Records not attributed to this session, sidechain records and
 * meta records are ignored under transcript-scan's rules.
 */
function scanLine(
  line: Buffer,
  lineEnd: number,
  sizeAtOpen: number,
  sessionId: string,
  st: FillScanState,
  scannedBytes: () => number,
): LineOutcome {
  const unknown = (reason: MainFillUnknownReason): LineOutcome =>
    ({ kind: "done", result: { kind: "unknown", reason, scannedBytes: scannedBytes() } });
  if (line.length > MAX_LINE_BYTES) return unknown("oversized");
  const text = line.toString("utf-8");
  if (text.trim().length === 0) return { kind: "continue" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unknown("malformed");
  }
  if (!isRecord(raw)) return unknown("malformed");
  const parsed = parseTranscriptObject(raw, sessionId);
  const mainThread = raw.sessionId === sessionId && raw.isSidechain !== true;

  if (mainThread && raw.type === "system" && raw.subtype === "compact_boundary") {
    // Never fall through to an older boundary past one the classifier refused.
    if (parsed.kind !== "boundary") return unknown("malformed");
    if (st.contextTokens === null) return unknown("no-usage");
    const b = parsed.boundary;
    if (b.trigger !== "auto") return unknown("reference-not-auto");
    if (!b.preTokens) return unknown("no-pretokens");
    const estimate = st.contextTokens + Math.ceil(st.tailBytes / TAIL_BYTES_PER_TOKEN);
    return {
      kind: "done",
      result: {
        kind: "measured",
        fill: estimate / b.preTokens,
        contextTokens: st.contextTokens,
        tailBytes: st.tailBytes,
        preTokens: b.preTokens,
        scannedBytes: scannedBytes(),
      },
    };
  }

  if (parsed.kind === "model") return unknown("model-changed");

  if (mainThread && raw.type === "assistant" && raw.isMeta !== true) {
    const message = isRecord(raw.message) ? raw.message : {};
    // A synthetic or API-error record carries zero usage; it is not a
    // measurement of the context (ISS-1308: one rule, shared with the parser).
    if (isSyntheticAssistantRecord(raw)) return { kind: "continue" };
    if (parsed.kind !== "assistant" || parsed.contextTokens === null || !usageIsWellFormed(message)) return unknown("malformed");
    if (st.contextTokens === null) {
      st.contextTokens = parsed.contextTokens;
      st.tailBytes = sizeAtOpen - lineEnd;
      st.model = parsed.model;
    } else if (parsed.model !== st.model) {
      return unknown("model-changed");
    }
  }
  return { kind: "continue" };
}

/**
 * The main thread's context fill: its newest usage (plus the bytes written
 * since, as tokens) over the preTokens of its newest auto compaction.
 * Reads backward in chunks from the size at open and stops at the newest
 * main-thread boundary. A trailing segment without "\n" is a record still
 * being written and is ignored; every other line in the window is parsed
 * once, and a line that does not parse fails safe.
 */
export function readMainFill(
  transcriptPath: string,
  sessionId: string,
  opts: ClassifyOptions = {},
): MainFillResult {
  const deadline = opts.deadline ?? createClassifyDeadline();
  const maxBytes = opts.maxBytes ?? FILL_SCAN_MAX_BYTES;
  const chunkBytes = Math.max(1, opts.chunkBytes ?? FILL_SCAN_CHUNK_BYTES);
  let scanned = 0;
  const scannedBytes = (): number => scanned;
  const unknown = (reason: MainFillUnknownReason): MainFillResult => ({ kind: "unknown", reason, scannedBytes: scanned });
  // A measurement finished after the deadline is not returned: the cap
  // bounds the whole scan, not only the start of each chunk.
  const settle = (result: MainFillResult): MainFillResult =>
    result.kind === "measured" && deadline.expired() ? unknown("time-cap") : result;

  const real = authorizeTranscriptPath(transcriptPath, sessionId, opts.projectsDir);
  if (!real) return unknown("unauthorized");
  const opened = openTranscriptReadOnly(real);
  if (!opened) return unknown("unreadable");
  try {
    const sizeAtOpen = opened.size;
    const st: FillScanState = { contextTokens: null, tailBytes: 0, model: null };
    let pos = sizeAtOpen;
    // Bytes [pos, pos + carry.length): a line whose start is not read yet.
    // `carryTerminated` is false only for the file's trailing segment.
    let carry: Buffer = Buffer.alloc(0);
    let carryTerminated: boolean = false;
    while (true) {
      if (deadline.expired()) return unknown("time-cap");
      if (pos === 0) {
        if (carryTerminated && carry.length > 0) {
          const out = scanLine(carry, carry.length + 1, sizeAtOpen, sessionId, st, scannedBytes);
          if (out.kind === "done") return settle(out.result);
        }
        return unknown("no-boundary");
      }
      if (scanned >= maxBytes) return unknown("byte-cap");
      const n = Math.min(chunkBytes, pos, maxBytes - scanned);
      const chunk = readRange(opened.fd, pos - n, n);
      if (chunk.length !== n) return unknown("unreadable");
      scanned += n;
      pos -= n;
      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let segEnd = combined.length;
      let terminated: boolean = carryTerminated;
      let nl = segEnd > 0 ? combined.lastIndexOf(NEWLINE, segEnd - 1) : -1;
      while (nl >= 0) {
        if (terminated) {
          const out = scanLine(combined.subarray(nl + 1, segEnd), pos + segEnd + 1, sizeAtOpen, sessionId, st, scannedBytes);
          if (out.kind === "done") return settle(out.result);
        }
        segEnd = nl;
        terminated = true;
        nl = segEnd > 0 ? combined.lastIndexOf(NEWLINE, segEnd - 1) : -1;
      }
      carry = Buffer.from(combined.subarray(0, segEnd));
      carryTerminated = terminated;
      if (carry.length > MAX_LINE_BYTES) return unknown("oversized");
    }
  } catch {
    return unknown("unreadable");
  } finally {
    try { closeSync(opened.fd); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Subagent corroboration
// ---------------------------------------------------------------------------

function boundaryInTail(path: string, sessionId: string, now: number, windowMs: number): boolean {
  const opened = openTranscriptReadOnly(path);
  if (!opened) return false;
  try {
    const length = Math.min(opened.size, SUBAGENT_TAIL_BYTES);
    if (length <= 0) return false;
    const start = opened.size - length;
    const buf = readRange(opened.fd, start, length);
    const lines = buf.toString("utf-8").split("\n");
    // The last element is the unterminated trailing segment; the first is
    // partial when the window starts mid-file.
    const first = start > 0 ? 1 : 0;
    for (let i = lines.length - 2; i >= first; i--) {
      let r: unknown;
      try {
        r = JSON.parse(lines[i]!);
      } catch {
        continue;
      }
      if (!isRecord(r) || r.type !== "system" || r.subtype !== "compact_boundary") continue;
      if (r.sessionId !== sessionId || typeof r.timestamp !== "string") continue;
      const ts = Date.parse(r.timestamp);
      if (Number.isFinite(ts) && ts >= now - windowMs && ts <= now + SUBAGENT_FUTURE_SKEW_MS) return true;
    }
    return false;
  } finally {
    try { closeSync(opened.fd); } catch { /* already closed */ }
  }
}

/**
 * A subagent of this session that is active now (PreCompact) or has just
 * written its own compact boundary (SessionStart, `requireBoundary`). Reads
 * `<dirname(transcript)>/<sessionId>/subagents/agent-*.jsonl`, at most
 * SUBAGENT_DIR_ENTRIES_MAX entries and the newest SUBAGENT_FILES_MAX files
 * modified within the activity window. Null on any doubt.
 */
export function recentSubagentEvidence(
  transcriptPath: string,
  sessionId: string,
  now: number,
  opts: { readonly requireBoundary: boolean; readonly deadline: ClassifyDeadline; readonly windowMs?: number },
): { agentId: string } | null {
  const windowMs = opts.windowMs ?? SUBAGENT_ACTIVITY_WINDOW_MS;
  try {
    const dir = join(dirname(transcriptPath), sessionId, "subagents");
    if (!lstatSync(dir).isDirectory()) return null;
    const names: string[] = [];
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry && names.length < SUBAGENT_DIR_ENTRIES_MAX; entry = handle.readSync()) {
        names.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    const candidates: Array<{ name: string; agentId: string; mtimeMs: number }> = [];
    let stats = 0;
    for (const name of names) {
      const m = SUBAGENT_FILE_PATTERN.exec(name);
      if (!m) continue;
      if (stats % SUBAGENT_STAT_BATCH === 0 && opts.deadline.expired()) return null;
      stats++;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(join(dir, name));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs < now - windowMs || st.mtimeMs > now + SUBAGENT_FUTURE_SKEW_MS) continue;
      candidates.push({ name, agentId: m[1]!, mtimeMs: st.mtimeMs });
    }
    // Checked after the stats and after every tail read: no evidence is
    // returned once the deadline has passed.
    if (opts.deadline.expired()) return null;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const c of candidates.slice(0, SUBAGENT_FILES_MAX)) {
      if (!opts.requireBoundary) return { agentId: c.agentId };
      const found = boundaryInTail(join(dir, c.name), sessionId, now, windowMs);
      if (opts.deadline.expired()) return null;
      if (found) return { agentId: c.agentId };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export interface PreCompactClassifyInput {
  readonly client: string;
  readonly trigger?: string;
  readonly subagent?: SubagentHookSignal;
  readonly transcriptPath?: string;
  readonly sessionId?: string;
}

/**
 * PreCompact: explicit signals first; otherwise a Claude auto compaction
 * whose main-thread fill is measured below the threshold while a subagent of
 * this session is active. Null is today's behaviour.
 */
export function classifyPreCompact(
  input: PreCompactClassifyInput,
  opts: ClassifyOptions = {},
): SubagentCompactionVerdict | null {
  const explicit = explicitVerdict(input.subagent);
  if (explicit) return explicit;
  if (input.client !== "claude" || input.trigger !== "auto") return null;
  if (!input.transcriptPath || !input.sessionId) return null;
  const deadline = opts.deadline ?? createClassifyDeadline();
  const measured = readMainFill(input.transcriptPath, input.sessionId, { ...opts, deadline });
  if (measured.kind !== "measured" || !(measured.fill < SUBAGENT_FILL_THRESHOLD)) return null;
  const real = authorizeTranscriptPath(input.transcriptPath, input.sessionId, opts.projectsDir);
  if (!real) return null;
  const evidence = recentSubagentEvidence(real, input.sessionId, opts.now ?? Date.now(), { requireBoundary: false, deadline });
  if (!evidence) return null;
  return { signal: "fill", agentId: evidence.agentId, fill: measured.fill };
}

export interface SessionStartClassifyInput {
  readonly root: string;
  readonly client: string;
  readonly source?: string;
  readonly subagent?: SubagentHookSignal;
  readonly transcriptPath?: string;
  readonly sessionId?: string;
}

/**
 * SessionStart: explicit signals for any source. The fill test applies only
 * to a Claude compact start with NO resumable session: when one exists,
 * PreCompact (which saw the trigger) already judged the fire real and
 * SessionStart follows it. Without one, a manual /compact cannot be told
 * from a subagent by fill alone, so the fire is ignored only on positive
 * evidence that a subagent of this session just wrote its own boundary.
 */
export function classifySessionStart(
  input: SessionStartClassifyInput,
  opts: ClassifyOptions = {},
): SubagentCompactionVerdict | null {
  const explicit = explicitVerdict(input.subagent);
  if (explicit) return explicit;
  if (input.source !== "compact" || input.client !== "claude") return null;
  if (!input.transcriptPath || !input.sessionId) return null;
  if (findResumableSession(input.root)) return null;
  const deadline = opts.deadline ?? createClassifyDeadline();
  const measured = readMainFill(input.transcriptPath, input.sessionId, { ...opts, deadline });
  if (measured.kind !== "measured" || !(measured.fill < SUBAGENT_FILL_THRESHOLD)) return null;
  const real = authorizeTranscriptPath(input.transcriptPath, input.sessionId, opts.projectsDir);
  if (!real) return null;
  const evidence = recentSubagentEvidence(real, input.sessionId, opts.now ?? Date.now(), { requireBoundary: true, deadline });
  if (!evidence) return null;
  return { signal: "fill", agentId: evidence.agentId, fill: measured.fill };
}
