/**
 * T-424: Extract usage-limit evidence from a Claude Code transcript JSONL.
 *
 * A rate-limit stop lands in the session transcript as a structured API-error
 * entry (format observed in the wild, NOT documented -- parse best-effort,
 * never throw):
 *   { "error":"rate_limit", "isApiErrorMessage":true, "apiErrorStatus":429,
 *     "cwd":..., "sessionId":...,
 *     "message":{"content":[{"type":"text","text":"You've hit your session
 *       limit · resets 6:40pm (Asia/Calcutta)"}]} }
 *
 * Ported from unsnooze (https://github.com/saaranshM/unsnooze, MIT)
 * watchers/claude.js, with the tmux-pane detection engine dropped -- the
 * StopFailure hook already tells us a limit fired; this module only recovers
 * the banner text (for reset-time parsing) and classifies the limit type.
 */

import { readSync, closeSync } from "node:fs";
import { openTranscriptReadOnly } from "../core/transcript-open.js";
import * as fsSync from "node:fs";

/** Sidechain (subagent) entries are skipped -- the resume target is the parent session. */
export interface LimitTranscriptEntry {
  sessionId: string | null;
  cwd: string | null;
  bannerText: string;
  limitType: LimitType;
  timestampMs: number | null;
}

export type LimitType = "session" | "weekly" | "unknown";

const WEEKLY_PATTERNS = [
  /week(?:ly)?\s+limit/i,
  /resets?\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun)/i,
  /limit.*(?:this|per)\s+week/i,
  // Month-date reset form only appears on weekly banners ("resets Jul 4 at 12:30am").
  /resets?\s+(?:on\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i,
];
const SESSION_PATTERNS = [/\d+-hour limit/i, /session limit/i];

export function classifyLimitType(bannerText: string): LimitType {
  if (WEEKLY_PATTERNS.some((p) => p.test(bannerText))) return "weekly";
  if (SESSION_PATTERNS.some((p) => p.test(bannerText))) return "session";
  return "unknown";
}

/** One transcript JSONL line -> limit-stop evidence or null. Never throws. */
export function parseTranscriptLine(line: string): LimitTranscriptEntry | null {
  if (!line || !line.trim()) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!entry || entry.isApiErrorMessage !== true) return null;
  if (entry.error !== "rate_limit") return null;
  if (entry.isSidechain) return null;

  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  const textBlock = Array.isArray(content)
    ? (content as Array<{ type?: string; text?: string }>).find((c) => c?.type === "text")
    : undefined;
  const bannerText = typeof textBlock?.text === "string" ? textBlock.text : "";
  const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;

  return {
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
    cwd: typeof entry.cwd === "string" ? entry.cwd : null,
    bannerText,
    limitType: classifyLimitType(bannerText),
    timestampMs: Number.isFinite(ts) ? ts : null,
  };
}

/** Tail window: the limit entry is at (or very near) the end of the transcript at hook time. */
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_BYTES = 512 * 1024;

/**
 * Read the last `tailLines` lines of a file without loading the whole
 * transcript (long sessions run to hundreds of MB). Returns [] on any error.
 *
 * The path arrives from hook stdin (user-writable), so this must never block
 * the StopFailure hook: the open is O_NONBLOCK + O_NOFOLLOW and anything that
 * is not a regular file (FIFO, device, final-component symlink) is rejected
 * before any read. Short reads are looped and only actually-read bytes are
 * decoded (zero-filled residue would corrupt the final JSONL record).
 */
export function readFileTailLines(filePath: string, tailLines = DEFAULT_TAIL_LINES): string[] {
  let fd: number | null = null;
  try {
    const opened = openTranscriptReadOnly(filePath);
    if (opened === null) return [];
    fd = opened.fd;
    const size = opened.size;
    const readBytes = Math.min(size, MAX_TAIL_BYTES);
    if (readBytes <= 0) return [];
    const buf = Buffer.alloc(readBytes);
    let total = 0;
    while (total < readBytes) {
      const n = readSync(fd, buf, total, readBytes - total, size - readBytes + total);
      if (n <= 0) break;
      total += n;
    }
    const lines = buf.subarray(0, total).toString("utf-8").split("\n");
    // The first line of a mid-file window is almost always a partial record; JSON.parse skips it naturally.
    return lines.slice(-tailLines);
  } catch {
    return [];
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** Identity constraints for scan results: entries whose non-null fields mismatch are skipped. */
export interface TranscriptIdentityFilter {
  /** Expected client session id (the hook payload's session_id). */
  sessionId?: string | null;
  /** Expected project root; compared realpath-tolerantly against the entry's cwd. */
  cwd?: string | null;
}

export function identityMatches(
  entrySessionId: string | null,
  entryCwd: string | null,
  filter: TranscriptIdentityFilter | undefined,
): boolean {
  if (!filter) return true;
  // FAIL CLOSED: the transcript path is user-writable, so a requested filter
  // field must be POSITIVELY matched. An entry that omits the field cannot
  // prove it belongs to this session, so it is rejected (the caller then uses
  // the safe fallback reset rather than trusting unattributed evidence).
  if (filter.sessionId != null && entrySessionId !== filter.sessionId) return false;
  if (filter.cwd != null) {
    if (entryCwd == null) return false;
    if (entryCwd !== filter.cwd) {
      try {
        const { realpathSync } = fsSync;
        if (realpathSync(entryCwd) !== realpathSync(filter.cwd)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

function entryMatchesIdentity(entry: LimitTranscriptEntry, filter: TranscriptIdentityFilter | undefined): boolean {
  return identityMatches(entry.sessionId, entry.cwd, filter);
}

/**
 * Scan the transcript tail bottom-up for the MOST RECENT rate-limit entry
 * (old banners persist in scrollback; the newest one carries the live reset).
 * Returns null when no entry is found -- callers fall back to now + 5h.
 * The transcript path arrives from user-writable hook stdin, so callers pass
 * an identity `filter`: a stale or swapped transcript must not supply another
 * session's reset schedule.
 */
export function scanTranscriptTailForLimit(
  transcriptPath: string | null | undefined,
  tailLines = DEFAULT_TAIL_LINES,
  filter?: TranscriptIdentityFilter,
): LimitTranscriptEntry | null {
  if (!transcriptPath) return null;
  const lines = readFileTailLines(transcriptPath, tailLines);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseTranscriptLine(lines[i]!);
    if (parsed && entryMatchesIdentity(parsed, filter)) return parsed;
  }
  return null;
}

/**
 * Positive resume evidence for a plain wake: does the transcript tail contain a
 * valid, session-attributed conversation turn (assistant/user) NEWER than
 * `sinceMs`? This is stronger than raw byte growth -- an interactive writer,
 * malformed partial data, or an unrelated/foreign entry cannot satisfy it, so a
 * plain record is only terminalized as `resumed` on real turn evidence.
 */
export function transcriptHasTurnAfter(
  transcriptPath: string | null | undefined,
  sinceMs: number,
  filter?: TranscriptIdentityFilter,
): boolean {
  if (!transcriptPath) return false;
  const lines = readFileTailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line || !line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // malformed / partial line is not evidence
    }
    if (!entry || (entry.type !== "assistant" && entry.type !== "user")) continue;
    if (entry.isSidechain) continue; // subagent turn, not the resumed session
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    // STRICTLY after: a turn at exactly `sinceMs` (the stop/spawn boundary) may
    // be the pre-stop turn itself, not new post-resume progress. Requiring
    // `ts > sinceMs` keeps a boundary-timestamp collision from being misread as
    // fresh activity.
    if (!Number.isFinite(ts) || ts <= sinceMs) continue;
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
    const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
    if (identityMatches(sessionId, cwd, filter)) return true;
  }
  return false;
}
