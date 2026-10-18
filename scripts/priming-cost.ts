/**
 * T-497: replay the guard-free /story invocation (Step 0.5 through the
 * Ready-to-Work table, per ~/.claude/skills/story/SKILL.md) against a frozen
 * fixture project, measuring real per-step byte counts and call counts.
 *
 * Two modes:
 *   --emit-json <fixtureRoot>   One measurement pass. Prints exactly one JSON
 *                               object to stdout, nothing else on stdout.
 *   --live [root]               Observational report against a real project
 *                               (default: cwd). Unfrozen clock, real git log.
 *
 * Every mutant-killing assertion in the test suite is re-derived from the raw
 * transport-capture log (`rawLog` below), never trusted from this script's own
 * derived per-step fields alone -- a mutant that fakes its own summary while
 * the raw log shows different real activity is still caught.
 */
import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../src/mcp/tools.js";
import { claudeConfigDir } from "../src/core/claude-config-dir.js";
import {
  parseHandoverMarkdown,
  type SectionRecord,
  type ContinuationCandidate,
  type ContinuationCandidatesResult,
  type ContinuationIndex,
  type TrajectoryEntry,
} from "../src/core/markdown-sections.js";

const execFileAsync = promisify(execFileCb);

// --- byte accounting -------------------------------------------------------

/** UTF-8 byte length, never UTF-16 `.length` (T-497 m3). */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// --- temp-root normalization (T-497 m4) -------------------------------------
//
// Two child-process runs against two different mkdtemp() copies of the fixture
// use two DIFFERENT root paths, which can differ in string length. Computing
// byte counts from the RAW captured content (which can embed that root path,
// directly or via a symlink-resolved realpath) makes the pinned byte counts
// flap between runs even when the semantic content is identical. Every string
// value is normalized -- on a COPY, before serialization and byte counting --
// so the numeric fields themselves are computed from already-normalized
// content, never patched after the fact. The raw (unnormalized) capture is
// kept only for `rawLog`, which the mutant tests read for structural
// assertions (tool names, call counts) that must reflect what was genuinely
// transmitted.

export const FIXTURE_ROOT_PLACEHOLDER = "<FIXTURE_ROOT>";

export interface Normalizer {
  (value: unknown): unknown;
}

/** Longest-match-first so a nested longer candidate never loses to a shorter prefix. */
export function buildNormalizer(root: string): Normalizer {
  const abs = resolve(root);
  const candidates = new Set<string>([abs]);
  if (existsSync(abs)) {
    try {
      candidates.add(realpathSync(abs));
    } catch {
      // best-effort; abs alone still covers the common case
    }
  }
  const sorted = [...candidates].sort((a, b) => b.length - a.length);

  function normalizeString(s: string): string {
    let out = s;
    for (const candidate of sorted) {
      if (candidate.length === 0) continue;
      out = out.split(candidate).join(FIXTURE_ROOT_PLACEHOLDER);
    }
    return out;
  }

  function normalizeValue(value: unknown): unknown {
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) return value.map((v) => normalizeValue(v));
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = normalizeValue(v);
      }
      return result;
    }
    return value;
  }

  return normalizeValue;
}

/** Bytes of the normalized-then-serialized value. Route JSON-RPC message / sub-part-of-a-JSON-string byte counting through this. */
function measuredBytes(value: unknown, normalize: Normalizer): number {
  return byteLength(JSON.stringify(normalize(value)));
}

/**
 * Bytes of normalized RAW TEXT, with no JSON-string escaping overhead. Route
 * every direct-read or constructed-text step (RULES.md content, git log
 * text, the Continuation block, the Ready-to-Work table) through this, never
 * through `measuredBytes` -- that would count wrapping quotes and escaped
 * newlines that were never actually transmitted or read as such.
 */
function measuredTextBytes(text: string, normalize: Normalizer): number {
  return byteLength(normalize(text) as string);
}

// --- transport capture -------------------------------------------------------

export type TransportDirection = "client-to-server" | "server-to-client";

export interface CapturedMessage {
  readonly seq: number;
  readonly direction: TransportDirection;
  /** Raw, UNNORMALIZED JSON-RPC message exactly as sent. */
  readonly message: Record<string, unknown>;
}

export interface CapturingTransports {
  readonly clientTransport: InMemoryTransport;
  readonly serverTransport: InMemoryTransport;
  readonly log: CapturedMessage[];
}

export function createCapturingLinkedPair(): CapturingTransports {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const log: CapturedMessage[] = [];
  let seq = 0;

  function wrap(transport: InMemoryTransport, direction: TransportDirection): void {
    const originalSend = transport.send.bind(transport);
    transport.send = async (message: unknown, options?: unknown) => {
      log.push({ seq: seq++, direction, message: message as Record<string, unknown> });
      return (originalSend as (m: unknown, o?: unknown) => Promise<void>)(message, options);
    };
  }

  wrap(clientTransport, "client-to-server");
  wrap(serverTransport, "server-to-client");

  return { clientTransport, serverTransport, log };
}

/** Slices `log` to the entries appended since `since` (call is awaited, so no interleaving). */
function since(log: CapturedMessage[], mark: number): CapturedMessage[] {
  return log.slice(mark);
}

function findByDirection(
  entries: readonly CapturedMessage[],
  direction: TransportDirection,
): CapturedMessage | undefined {
  return entries.find((e) => e.direction === direction);
}

// --- step measurement --------------------------------------------------------

export interface ExchangeMeasurement {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
  readonly calls: number;
  readonly rawRequest: unknown;
  readonly rawResponse: unknown;
}

/** Extracts a JSON-RPC message's `id`, or undefined for a notification (which carries none). */
function messageId(message: unknown): unknown {
  return (message as { id?: unknown } | null)?.id;
}

function measureExchange(
  log: CapturedMessage[],
  mark: number,
  normalize: Normalizer,
): ExchangeMeasurement {
  const entries = since(log, mark);
  const req = findByDirection(entries, "client-to-server");
  if (!req) {
    throw new Error(`measureExchange: expected a request+response pair, got ${entries.length} entries`);
  }
  // Match the response to THIS request by JSON-RPC id, not merely "the first
  // server-to-client entry" -- a notification interleaved between them (no
  // id of its own) would otherwise be mistaken for, or mask, the real reply.
  const reqId = messageId(req.message);
  const res = entries.find((e) => e.direction === "server-to-client" && messageId(e.message) === reqId);
  if (!res) {
    throw new Error(`measureExchange: expected a request+response pair, got ${entries.length} entries`);
  }
  const requestBytes = measuredBytes(req.message, normalize);
  const responseBytes = measuredBytes(res.message, normalize);
  return {
    requestBytes,
    responseBytes,
    totalBytes: requestBytes + responseBytes,
    calls: 1,
    rawRequest: req.message,
    rawResponse: res.message,
  };
}

/**
 * Sums whatever transport activity the log genuinely captured in [start,
 * end), regardless of whether requests and responses paired up cleanly --
 * unlike measureExchange, this never throws. Used to recover a step's real
 * cost when it crashed partway through its own post-processing (a JSON.parse
 * on an already-captured response, for example): every entry's bytes count
 * toward the total (a dangling, unanswered request still cost real bytes),
 * while `calls` counts only genuinely completed request+response pairs,
 * matched by JSON-RPC id (not merely by alternating direction, which a
 * notification interleaved between a request and its reply would miscount).
 */
function measureLogRange(
  log: CapturedMessage[],
  start: number,
  end: number,
  normalize: Normalizer,
): { bytes: number; calls: number } {
  const entries = log.slice(start, end);
  let bytes = 0;
  let calls = 0;
  const pendingRequestIds = new Set<unknown>();
  for (const entry of entries) {
    bytes += measuredBytes(entry.message, normalize);
    const id = messageId(entry.message);
    if (entry.direction === "client-to-server") {
      if (id !== undefined) pendingRequestIds.add(id);
    } else if (entry.direction === "server-to-client") {
      if (id !== undefined && pendingRequestIds.has(id)) {
        calls += 1;
        pendingRequestIds.delete(id);
      }
    }
  }
  return { bytes, calls };
}

function responseText(rawResponse: unknown): string {
  const content = (rawResponse as { result?: { content?: Array<{ type?: string; text?: string }> } })
    .result?.content;
  const first = content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("responseText: expected a single text content block");
  }
  return first.text;
}

// --- recommend response parsing ---------------------------------------------
//
// storybloq_recommend ALWAYS returns its JSON envelope now (ISS-1154 Commit A:
// the tools.ts registration passes "json" unconditionally to runMcpReadTool).
// `recommendations` is already partitioned to actionable candidates by
// recommend()'s own partitionByActionability, so there is no per-row
// actionability check left for this harness to perform -- the numbered-
// Markdown-list grammar this section used to parse, and the issue_get walk it
// existed to drive, are both retired.

export interface RecommendActionability {
  readonly status: string;
  readonly reason: string;
  readonly source: string;
}

export interface RecommendRow {
  readonly id: string;
  readonly displayId?: string;
  readonly kind: "ticket" | "issue" | "action";
  readonly title: string;
  readonly reason: string;
  readonly actionability?: RecommendActionability;
}

export interface ExcludedRow {
  readonly id: string;
  readonly displayId?: string;
  readonly kind: "ticket" | "issue";
  readonly title: string;
  readonly actionability: RecommendActionability;
}

export interface RecommendPayload {
  readonly rows: RecommendRow[];
  readonly excluded: ExcludedRow[];
  readonly unreadableHandoverCount: number | null;
  readonly parseFailed: boolean;
  readonly reason?: string;
}

export function deriveRecommendPayload(text: string): RecommendPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      rows: [],
      excluded: [],
      unreadableHandoverCount: null,
      parseFailed: true,
      reason: `recommend response was not valid JSON: ${(err as Error).message}`,
    };
  }
  const data = (parsed as { data?: unknown })?.data ?? parsed;
  const d = data as { recommendations?: unknown; excluded?: unknown; unreadableHandoverCount?: unknown };
  if (!Array.isArray(d?.recommendations) || !Array.isArray(d?.excluded)) {
    return {
      rows: [],
      excluded: [],
      unreadableHandoverCount: null,
      parseFailed: true,
      reason: "recommend JSON payload is missing its recommendations/excluded arrays",
    };
  }
  return {
    rows: d.recommendations as RecommendRow[],
    excluded: d.excluded as ExcludedRow[],
    unreadableHandoverCount:
      typeof d.unreadableHandoverCount === "number" || d.unreadableHandoverCount === null
        ? (d.unreadableHandoverCount as number | null)
        : null,
    parseFailed: false,
  };
}

/**
 * The retained-on-parse-failure report: the step's own already-transmitted-
 * and-measured request/response bytes and call count are kept exactly as
 * captured (the exchange genuinely happened), never zeroed or discarded, even
 * though `rows`/`excluded` -- and therefore every downstream step that
 * depends on them (Gate B, the continuation walk, the Ready to Work table) --
 * come back empty. Exported standalone so the retention behaviour is
 * unit-testable against a synthetic measurement, independent of whether the
 * real tool's output space can ever actually produce an unparseable response.
 */
export function buildFailedRecommendReport(
  measurement: ExchangeMeasurement,
  reason: string | undefined,
): StepReport {
  return {
    bytes: measurement.totalBytes,
    calls: measurement.calls,
    includedInTotal: true,
    status: "incomplete",
    reason,
    issueGetCalls: 0,
    actionableIssueCount: 0,
    excludedCount: 0,
    requestCarriesCountTen: (measurement.rawRequest as any)?.params?.arguments?.count === 10,
  };
}

// --- continuation-check parsing ----------------------------------------------
//
// SKILL.md: "an actionable heading -- a heading matching next/open/remaining/
// todo/blocked, case-insensitively... Take the section from that heading to
// the next heading of equal or higher level."

const ACTIONABLE_HEADING_RE = /^(#{1,6})\s+.*\b(next|open|remaining|todo|blocked)\b/i;
const HEADING_RE = /^(#{1,6})\s+/;
const ENTITY_ID_RE = /\b(T-\d+[a-z]?|ISS-\d+)\b/g;
const DATE_LINE_RE = /^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})\s*$/m;

export interface ContinuationSection {
  readonly heading: string;
  readonly content: string;
  readonly slug: string;
  /** The actionable keyword that matched (next/open/remaining/todo/blocked), lowercased. */
  readonly keyword: string;
}

export function findContinuationSection(handoverBody: string): ContinuationSection | null {
  const lines = handoverBody.split("\n");
  let startIdx = -1;
  let level = 0;
  let keyword = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = ACTIONABLE_HEADING_RE.exec(line);
    if (m) {
      startIdx = i;
      level = m[1]!.length;
      // "blocked" always wins as the reported keyword when it appears
      // anywhere in the heading, independent of which alternative the
      // greedy regex above happened to capture (a heading like "## Blocked
      // work remaining" contains both "blocked" and "remaining"; greedy
      // backtracking finds the rightmost candidate, which would otherwise
      // silently report "remaining" and let promotion proceed).
      keyword = /\bblocked\b/i.test(line) ? "blocked" : m[2]!.toLowerCase();
      break;
    }
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i] ?? "");
    if (h && h[1]!.length <= level) {
      endIdx = i;
      break;
    }
  }

  const sectionLines = lines.slice(startIdx, endIdx);
  const dateMatch = DATE_LINE_RE.exec(handoverBody);
  const slug = dateMatch ? `handover dated ${dateMatch[1]}` : "the latest handover";
  return {
    heading: sectionLines[0] ?? "",
    content: sectionLines.join("\n").replace(/\n+$/, ""),
    slug,
    keyword,
  };
}

/** Ids in the order they first appear in the section text, deduplicated. */
export function extractEntityIds(sectionText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of sectionText.matchAll(ENTITY_ID_RE)) {
    const id = m[0];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// --- Ready-to-Work table construction -----------------------------------------

export interface ContextLookupRow {
  readonly id: string;
  readonly context: string;
  readonly diagnostic: string;
}

/**
 * Context is sourced ONLY from the already-captured storybloq_status JSON
 * payload's per-item fields, per the pen's ruling (never re-fetch, never
 * substitute the recommend response's own `reason` field). The JSON payload
 * is aggregate-only (confirmed by reading formatStatus's JSON branch) -- no
 * per-ticket phase field, no per-issue severity field -- so every row falls
 * back to "n/a" plus a diagnostic line. This is the ruling's own anticipated
 * outcome for a corpus that doesn't carry the data, not a new gap.
 */
export function lookupContextColumn(rows: readonly RecommendRow[]): ContextLookupRow[] {
  return rows.map((row) => ({
    id: row.id,
    context: "n/a",
    diagnostic:
      row.kind === "ticket"
        ? `${row.id}: status payload carries no per-ticket phase field`
        : `${row.id}: status payload carries no per-issue severity field`,
  }));
}

export function renderReadyToWorkTable(
  rows: readonly RecommendRow[],
  contextById: ReadonlyMap<string, { context: string; diagnostic: string }>,
): string {
  const lines: string[] = [
    "## Ready to Work (ranking)",
    "| Item    | Type   | Title                            | Context        | Actionable |",
    "|---------|--------|-----------------------------------|----------------|------------|",
  ];
  const shown = rows.slice(0, 5);
  const diagnosticLines: string[] = [];
  for (const row of shown) {
    const entry = contextById.get(row.id);
    const context = entry?.context ?? "n/a";
    // T-498 Commit 3, design decision 4: every `recommendations` row is
    // already partitioned-actionable by recommend() itself (ISS-1154) -- this
    // column is a transparency/consistency signal, not a new classification.
    lines.push(`| ${row.id} | ${row.kind} | ${row.title} | ${context} | actionable |`);
    if (entry?.diagnostic) diagnosticLines.push(`- ${row.id}: ${entry.diagnostic}`);
  }
  if (rows.length > shown.length) {
    lines.push(`(+${rows.length - shown.length} more)`);
  }
  if (diagnosticLines.length > 0) {
    lines.push("", ...diagnosticLines);
  }
  return lines.join("\n");
}

// --- reconciliation fingerprint comparison (SKILL.md's guard/status cross-check) ---
//
// Per-session fingerprint: sessionId, surviving sourceDir, population, state,
// compactPending, leaseState, and normalized ownerTask (client + id). A
// mismatch on any field is a reconciliation failure, which triggers a second
// session_guard call before the reported verdict can be trusted.

export interface SessionFingerprint {
  readonly sessionId: string;
  readonly sourceDir: string;
  readonly population: unknown;
  readonly state: unknown;
  readonly compactPending: unknown;
  readonly leaseState: unknown;
  readonly ownerTaskClient: string | null;
  readonly ownerTaskId: string | null;
}

function normalizeOwnerTask(ownerTask: unknown): { client: string | null; id: string | null } {
  if (!ownerTask || typeof ownerTask !== "object") return { client: null, id: null };
  const o = ownerTask as Record<string, unknown>;
  return {
    client: typeof o.client === "string" ? o.client : null,
    id: typeof o.id === "string" ? o.id : null,
  };
}

/** One fingerprint per unique sessionId; first occurrence in iteration order survives (this harness's own deterministic dedupe convention for comparing two differently-shaped session lists). */
/**
 * SKILL.md:133's stated dedup rule (what the MODEL applies, in prose,
 * because the fallback path cannot read `session-guard.ts`'s own
 * ISS-914 collision/survivor system): activeSessions first, resumableSessions
 * second, ordered by sourceDir within each population, keep the first record
 * per full sessionId. `SessionVerdict.population` already carries this tag
 * natively on the guard side; the status side is tagged by the caller before
 * reaching here (see `stepReconciliation`), since `ActiveSessionSummary` has
 * no `population` field of its own -- it is purely positional (which array
 * it came from).
 */
function orderSessionsForDedupe(sessions: readonly unknown[]): unknown[] {
  const active: unknown[] = [];
  const resumable: unknown[] = [];
  const unpopulated: unknown[] = []; // defensive: no population tag at all -- kept last, stable order
  for (const raw of sessions) {
    const p = (raw as Record<string, unknown>)?.population;
    if (p === "activeSessions") active.push(raw);
    else if (p === "resumableSessions") resumable.push(raw);
    else unpopulated.push(raw);
  }
  const bySourceDir = (a: unknown, b: unknown): number => {
    const sa = String((a as Record<string, unknown>)?.sourceDir ?? "");
    const sb = String((b as Record<string, unknown>)?.sourceDir ?? "");
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  active.sort(bySourceDir);
  resumable.sort(bySourceDir);
  return [...active, ...resumable, ...unpopulated];
}

export function buildFingerprints(sessions: readonly unknown[]): Map<string, SessionFingerprint> {
  const ordered = orderSessionsForDedupe(sessions);
  const out = new Map<string, SessionFingerprint>();
  for (const raw of ordered) {
    const s = raw as Record<string, unknown>;
    const id = s?.sessionId;
    if (typeof id !== "string" || out.has(id)) continue;
    const owner = normalizeOwnerTask(s?.ownerTask);
    out.set(id, {
      sessionId: id,
      sourceDir: typeof s?.sourceDir === "string" ? (s.sourceDir as string) : "",
      population: s?.population ?? null,
      state: s?.state ?? null,
      compactPending: s?.compactPending ?? null,
      leaseState: s?.leaseState ?? null,
      ownerTaskClient: owner.client,
      ownerTaskId: owner.id,
    });
  }
  return out;
}

export interface ReconciliationResult {
  readonly matched: boolean;
  readonly mismatchedIds: string[];
  readonly mismatchedFields: Record<string, string[]>;
}

const FINGERPRINT_FIELDS: (keyof SessionFingerprint)[] = [
  "sourceDir",
  "population",
  "state",
  "compactPending",
  "leaseState",
  "ownerTaskClient",
  "ownerTaskId",
];

export function reconcileFingerprints(
  guardSessions: readonly unknown[],
  statusSessions: readonly unknown[],
): ReconciliationResult {
  const guardFp = buildFingerprints(guardSessions);
  const statusFp = buildFingerprints(statusSessions);
  const allIds = new Set<string>([...guardFp.keys(), ...statusFp.keys()]);
  const mismatchedIds: string[] = [];
  const mismatchedFields: Record<string, string[]> = {};
  for (const id of allIds) {
    const a = guardFp.get(id);
    const b = statusFp.get(id);
    if (!a || !b) {
      mismatchedIds.push(id);
      mismatchedFields[id] = ["presence"];
      continue;
    }
    const fields = FINGERPRINT_FIELDS.filter(
      (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
    );
    if (fields.length > 0) {
      mismatchedIds.push(id);
      mismatchedFields[id] = fields;
    }
  }
  return { matched: mismatchedIds.length === 0, mismatchedIds, mismatchedFields };
}

// --- orchestrator gating (live-mode storybloq_node_list step) -----------------

/** Matches the codebase's own orchestrator gate (project-loader.ts, tools.ts, recommend.ts): `config.type === "orchestrator"`. */
export function isOrchestratorConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  return c.type === "orchestrator";
}

// --- entity actionability parsing (storybloq_ticket_get / storybloq_issue_get fallback) ---
//
// ISS-1154 Commit B: the continuation walk's fallback path requests
// format:"json", withActionability:true and reads the real, server-computed
// `actionability.status` directly -- both tools' inputSchema gained these
// fields in Commit A, so there is no markdown heuristic left to approximate
// what "clears the bar" means.

export interface EntityActionabilityResult {
  readonly status: string | null;
  readonly unreadableHandoverCount: number | null;
  readonly parseFailed: boolean;
  readonly reason?: string;
}

export function deriveEntityActionability(text: string): EntityActionabilityResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      status: null,
      unreadableHandoverCount: null,
      parseFailed: true,
      reason: `entity response was not valid JSON: ${(err as Error).message}`,
    };
  }
  const data = (parsed as { data?: unknown })?.data ?? parsed;
  const d = data as { actionability?: { status?: unknown }; unreadableHandoverCount?: unknown };
  if (typeof d?.actionability?.status !== "string") {
    return {
      status: null,
      unreadableHandoverCount: null,
      parseFailed: true,
      reason: "entity JSON payload is missing actionability.status",
    };
  }
  return {
    status: d.actionability.status,
    unreadableHandoverCount:
      typeof d.unreadableHandoverCount === "number" || d.unreadableHandoverCount === null
        ? (d.unreadableHandoverCount as number | null)
        : null,
    parseFailed: false,
  };
}

// --- fixed step inventory (T-497 m1b) -----------------------------------------

export const STEP_NAMES = [
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
] as const;

export type StepName = (typeof STEP_NAMES)[number];

// --- fixture-mode git log (no .git directory in the fixture) -----------------

const FIXTURE_GIT_LOG_LINES = [
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
];
const FIXTURE_GIT_LOG_TEXT = FIXTURE_GIT_LOG_LINES.join("\n");

// --- report types --------------------------------------------------------------

export interface StepReport {
  readonly bytes: number;
  readonly calls: number;
  readonly includedInTotal: boolean;
  readonly [key: string]: unknown;
}

export interface PrimingCostReport {
  readonly mode: "fixture" | "live";
  readonly meta: {
    readonly measuredRoot: string;
    readonly generatedAt: string;
    // Live-mode-only observational metadata (T-497's 1a text: commit, dirty
    // state, session inventory, installed-skill hash, orchestrator flag).
    // Absent in fixture mode, whose meta stays a clean deterministic pair.
    readonly commit?: string | null;
    readonly dirty?: boolean | null;
    readonly sessionInventory?: { readonly count: number; readonly ids: readonly string[] };
    readonly installedSkillHash?: string | null;
    readonly orchestrator?: boolean;
  };
  readonly steps: Record<StepName, StepReport>;
  readonly totals: {
    readonly bytes: number;
    readonly calls: number;
    readonly status: "complete" | "observed_subtotal";
  };
  readonly rawLog: readonly CapturedMessage[];
}

// --- core replay (shared by fixture and live mode) ----------------------------

export interface ReplayContext {
  readonly root: string;
  readonly client: Client;
  readonly log: CapturedMessage[];
  readonly normalize: Normalizer;
  readonly gitLogMode: "fixture" | "live";
}

/**
 * Thrown by callTool whenever the exchange cannot be interpreted as a
 * successful {measurement, text} pair -- the underlying client call
 * rejected, or the response could not be read as text. `partialBytes` /
 * `partialCalls` carry whatever the transport genuinely captured for THIS
 * specific exchange (a full request+response pair still costs real bytes
 * even when the SDK surfaces it as an error), so a caller that catches this
 * can retain that cost instead of silently losing it.
 */
export class CallToolFailure extends Error {
  readonly partialBytes: number;
  readonly partialCalls: number;
  constructor(message: string, partialBytes: number, partialCalls: number) {
    super(message);
    this.name = "CallToolFailure";
    this.partialBytes = partialBytes;
    this.partialCalls = partialCalls;
  }
}

async function callTool(
  ctx: ReplayContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ measurement: ExchangeMeasurement; text: string }> {
  const mark = ctx.log.length;
  let callError: Error | null = null;
  try {
    await ctx.client.callTool({ name, arguments: args });
  } catch (err) {
    callError = err as Error;
  }

  let measurement: ExchangeMeasurement;
  try {
    measurement = measureExchange(ctx.log, mark, ctx.normalize);
  } catch {
    // No response was ever captured (a timeout, a dropped connection) -- but
    // a request was still genuinely SENT, and that costs real bytes even
    // though the exchange never completed. Recover just the request side;
    // this does not count as a completed call.
    const entries = since(ctx.log, mark);
    const req = findByDirection(entries, "client-to-server");
    const partialBytes = req ? measuredBytes(req.message, ctx.normalize) : 0;
    throw new CallToolFailure(callError ? callError.message : `${name}: no response captured`, partialBytes, 0);
  }

  if (callError) {
    // The transport genuinely captured a request+response pair even though
    // the client call itself rejected -- that traffic really happened and
    // its cost is real.
    throw new CallToolFailure(callError.message, measurement.totalBytes, measurement.calls);
  }

  let text: string;
  try {
    text = responseText(measurement.rawResponse);
  } catch (err) {
    throw new CallToolFailure((err as Error).message, measurement.totalBytes, measurement.calls);
  }

  return { measurement, text };
}

async function stepToolDiscovery(ctx: ReplayContext): Promise<{
  modeled: StepReport;
  reference: StepReport;
  realToolNames: string[];
}> {
  // Modeled: what a client's own discovery call looks like, names-only,
  // counted in the total. NOT a real transport call -- synthetic by design.
  const modeledRequest = { query: "storybloq", max_results: 100 };

  // Real reference call: actual client.listTools(), full payload including
  // schemas/descriptions (T-460 Leg B's subject) -- informational only.
  const mark = ctx.log.length;
  const result = await ctx.client.listTools();
  const referenceMeasurement = measureExchange(ctx.log, mark, ctx.normalize);
  const realToolNames = result.tools.map((t) => t.name).sort();

  const modeledResponse = { tools: realToolNames };
  const modeledRequestBytes = measuredBytes(modeledRequest, ctx.normalize);
  const modeledResponseBytes = measuredBytes(modeledResponse, ctx.normalize);

  return {
    modeled: {
      bytes: modeledRequestBytes + modeledResponseBytes,
      calls: 0,
      includedInTotal: true,
      modeled: true,
      modeledRequest: ctx.normalize(modeledRequest),
      modeledResponse: ctx.normalize(modeledResponse),
    },
    reference: {
      bytes: referenceMeasurement.totalBytes,
      calls: referenceMeasurement.calls,
      includedInTotal: false,
      modeled: false,
    },
    realToolNames,
  };
}

async function stepSessionGuard(ctx: ReplayContext): Promise<{ report: StepReport; verdict: any }> {
  const { measurement, text } = await callTool(ctx, "storybloq_session_guard", {});
  const verdict = JSON.parse(text);
  return {
    report: { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true },
    verdict,
  };
}

/** Tags each status-payload session with the population it came from -- `ActiveSessionSummary` carries no such field itself; it is purely positional (which array it was read from). */
function tagStatusSessionPopulations(statusPayload: any): unknown[] {
  const active = ((statusPayload.activeSessions ?? []) as Record<string, unknown>[]).map((s) => ({
    ...s,
    population: "activeSessions",
  }));
  const resumable = ((statusPayload.resumableSessions ?? []) as Record<string, unknown>[]).map((s) => ({
    ...s,
    population: "resumableSessions",
  }));
  return [...active, ...resumable];
}

export async function stepReconciliation(
  ctx: ReplayContext,
  guardVerdict: any,
  statusPayload: any,
): Promise<StepReport> {
  const guardSessions = (guardVerdict.sessions ?? []) as unknown[];
  const statusSessions = tagStatusSessionPopulations(statusPayload);
  const result = reconcileFingerprints(guardSessions, statusSessions);
  if (result.matched) {
    return { bytes: 0, calls: 0, includedInTotal: true, matched: true, verdict: "matched", mismatchedIds: [] };
  }
  // A fingerprint mismatch re-verifies with a second guard call before the
  // reconciliation outcome is trusted (SKILL.md's guard/status cross-check).
  // The retried verdict is actually re-compared, not discarded: only if it
  // STILL disagrees does reconciliation stay unresolved -- reported as
  // "unverifiable", the same vocabulary the real guard uses for "stop, do
  // not guess", not silently folded into a bare matched:false.
  const { measurement, text } = await callTool(ctx, "storybloq_session_guard", {});
  const retriedVerdict = JSON.parse(text);
  const retriedSessions = (retriedVerdict.sessions ?? []) as unknown[];
  const retryResult = reconcileFingerprints(retriedSessions, statusSessions);
  return {
    bytes: measurement.totalBytes,
    calls: measurement.calls,
    includedInTotal: true,
    matched: retryResult.matched,
    verdict: retryResult.matched ? "matched" : "unverifiable",
    mismatchedIds: retryResult.mismatchedIds,
    ...(retryResult.matched
      ? {}
      : { status: "incomplete", reason: "reconciliation mismatch persisted after a retried guard call" }),
  };
}

async function stepStatus(ctx: ReplayContext): Promise<{ report: StepReport; payload: any }> {
  const { measurement, text } = await callTool(ctx, "storybloq_status", { format: "json" });
  const payload = JSON.parse(text).data ?? JSON.parse(text);
  return {
    report: { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true },
    payload,
  };
}

async function stepRecap(ctx: ReplayContext): Promise<StepReport> {
  const { measurement } = await callTool(ctx, "storybloq_recap", {});
  return { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true };
}

// --- T-498 commit 3: the two-call Step 2 shape (live -- SKILL.md now drives
// this directly; see stepHandoverPrimingAndBrief below) ---------------------

export interface HandoverBriefEntryLike {
  readonly filename: string;
  readonly form: "raw" | "structured" | "index-only";
  readonly body?: string;
  readonly records?: SectionRecord[];
  /** Structured entries only: the per-handover cap-loss signal (ISS-1154 Commit A/B). Absent/null when nothing was capped. */
  readonly index?: ContinuationIndex | null;
  /** Only ever present on `briefHandovers[0]` (Commit 2's `buildHandoverBrief` wiring). */
  readonly continuationCandidates?: ContinuationCandidatesResult;
}

export interface HandoverPrimingAndBriefResult {
  readonly report: StepReport;
  /** The newest handover's raw body, when `priming:true` returned it (small-handover case); null when it fell back to structured form instead. */
  readonly primingBody: string | null;
  readonly briefHandovers: readonly HandoverBriefEntryLike[];
  readonly trajectory: readonly TrajectoryEntry[];
}

/**
 * T-498 design decision 1/2: models Step 2's two-call shape -- `count:1
 * priming:true` (the latest handover, raw when small enough) PLUS `count:10
 * brief:true` (the ten-handover structured window with trajectory) -- as its
 * own harness function, ground-truthed against a fixture exactly like
 * ISS-1154 Commit B's old `stepContinuationCheck`. Commit 3 flips SKILL.md's
 * live Step 2 text to this same two-call shape, retiring the single
 * `count: 3` call this function itself replaced back in commit 2.
 */
export async function stepHandoverPrimingAndBrief(
  ctx: ReplayContext,
): Promise<HandoverPrimingAndBriefResult> {
  // Codex round 1 finding: storybloq_handover_latest's MCP schema had no
  // format option, so brief/priming ALWAYS rendered Markdown (via
  // runMcpReadTool's "md" default) -- JSON.parse below would have thrown
  // against a real server. Fixed by adding format:"json" to the tool's
  // schema (src/mcp/tools.ts); requesting it explicitly here makes this
  // harness's byte/call counts and parsing genuinely match what commit 3's
  // skill text will get if it requests the same format.
  const priming = await callTool(ctx, "storybloq_handover_latest", { count: 1, priming: true, format: "json" });
  const brief = await callTool(ctx, "storybloq_handover_latest", { count: 10, brief: true, format: "json" });

  const primingData = (JSON.parse(priming.text) as { data: { handovers: HandoverBriefEntryLike[] } }).data;
  const briefData = (
    JSON.parse(brief.text) as { data: { handovers: HandoverBriefEntryLike[]; trajectory: TrajectoryEntry[] } }
  ).data;

  const newest = primingData.handovers[0];
  const primingBody = newest && newest.form === "raw" ? (newest.body ?? null) : null;

  const bytes = priming.measurement.totalBytes + brief.measurement.totalBytes;
  const calls = priming.measurement.calls + brief.measurement.calls;

  return {
    report: {
      bytes,
      calls,
      includedInTotal: true,
      primingBytes: priming.measurement.totalBytes,
      briefBytes: brief.measurement.totalBytes,
      primingHadRawBody: primingBody !== null,
    },
    primingBody,
    briefHandovers: briefData.handovers,
    trajectory: briefData.trajectory,
  };
}

/**
 * T-498 Commit 3 round-2 byte-review finding F1/F2: SKILL.md's Trajectory
 * block renders each `trajectory[]` entry with this exact line shape (a
 * ten-handover-window-specific instantiation of `formatTrajectoryMd`'s
 * shape in output-formatter.ts, not a second invented format), in the
 * array's own order (newest id first, per `buildTrajectory`'s insertion
 * order -- NOT "oldest first"). Every constructed block this harness
 * renders is its own byte-accounted step (T-497's rule, the retired
 * Continuation block's own convention); this is the Trajectory block's.
 */
export function renderTrajectoryMd(trajectory: readonly TrajectoryEntry[]): string {
  if (trajectory.length === 0) return "";
  const lines = ["## Trajectory (last 10 handovers)"];
  for (const entry of trajectory) {
    lines.push(
      `- ${entry.id}: seen in ${entry.occurrenceCount} of the last 10 handovers, latest ${entry.latest} (${entry.latestDisposition})`,
    );
  }
  return lines.join("\n");
}

export function stepTrajectory(trajectory: readonly TrajectoryEntry[], normalize: Normalizer): StepReport {
  const text = renderTrajectoryMd(trajectory);
  return {
    bytes: measuredTextBytes(text, normalize),
    calls: 0,
    includedInTotal: true,
    entryCount: trajectory.length,
    text: normalize(text),
  };
}

export type RecoveryTier = "raw-body" | "handover-get" | "disclosed";

export interface EvidenceRecoveryResult {
  readonly report: StepReport;
  /** Full ordered records for the handover, EVERY disposition -- null only on tier 3 (disclosed), where no evidence could be recovered at all. */
  readonly records: SectionRecord[] | null;
  readonly tier: RecoveryTier;
}

/**
 * T-498 design decision 1 (shared by decision 2's reconciliation): the
 * 3-tier recovery for a handover whose continuation candidates were
 * omitted, OR whose retained rationale reads the literal "unknown"
 * sentinel. Cheapest tier first:
 *   1. `rawBodyIfLoaded` -- the SAME raw body a `priming:true` call already
 *      put in context (zero extra calls). Re-parses it directly.
 *   2. One `storybloq_handover_get` read, only when tier 1 does not apply.
 *   3. Disclosed failure -- `records: null` -- only when tier 2 itself
 *      throws (the get fails or the handover is genuinely gone).
 * Returns the FULL, unfiltered-by-disposition record list either way: the
 * line-one consumer filters to `disposition === "continuation"` itself;
 * the reconciliation consumer (decision 2) uses every disposition as-is.
 */
export async function recoverHandoverEvidence(
  ctx: ReplayContext,
  filename: string,
  rawBodyIfLoaded: string | null,
): Promise<EvidenceRecoveryResult> {
  if (rawBodyIfLoaded !== null) {
    const records = parseHandoverMarkdown(rawBodyIfLoaded, filename).records;
    return {
      report: { bytes: 0, calls: 0, includedInTotal: true, tier: "raw-body" },
      records,
      tier: "raw-body",
    };
  }

  // Codex round 2/3 findings: neither a rejected call nor isError:true
  // covers every failure -- a not_found result is a USER error (not an
  // INFRASTRUCTURE_ERROR_CODES entry), so it resolves normally with isError
  // left unset, and its Markdown text ("Error [not_found]: ...") would
  // otherwise be mis-parsed as recovered content. Requesting format:"json"
  // gets the same {version, error:{code,message}} vs {version, data}
  // discriminant every other JSON-mode read tool already uses, covering
  // infrastructure AND user errors alike without string-sniffing an error
  // prefix in Markdown text.
  let measurement: { totalBytes: number; calls: number };
  let text: string;
  try {
    ({ measurement, text } = await callTool(ctx, "storybloq_handover_get", { filename, format: "json" }));
  } catch (err) {
    const partialBytes = err instanceof CallToolFailure ? err.partialBytes : 0;
    const partialCalls = err instanceof CallToolFailure ? err.partialCalls : 0;
    return {
      report: {
        bytes: partialBytes,
        calls: partialCalls,
        includedInTotal: true,
        tier: "disclosed",
        reason: (err as Error).message,
      },
      records: null,
      tier: "disclosed",
    };
  }

  // Codex round 4 finding: a malformed response (bad JSON, or JSON missing
  // the expected shape) must not lose the exchange's already-measured cost
  // -- `measurement` is captured above, outside this try, specifically so
  // this catch can still report it instead of falling back to 0/0.
  try {
    const parsed = JSON.parse(text) as { data?: { content: string } } | { error?: { code: string; message: string } };
    if (!("data" in parsed) || parsed.data === undefined) {
      const reason = "error" in parsed && parsed.error ? `[${parsed.error.code}] ${parsed.error.message}` : text;
      return {
        report: {
          bytes: measurement.totalBytes,
          calls: measurement.calls,
          includedInTotal: true,
          tier: "disclosed",
          reason,
        },
        records: null,
        tier: "disclosed",
      };
    }
    const records = parseHandoverMarkdown(parsed.data.content, filename).records;
    return {
      report: { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true, tier: "handover-get" },
      records,
      tier: "handover-get",
    };
  } catch (err) {
    return {
      report: {
        bytes: measurement.totalBytes,
        calls: measurement.calls,
        includedInTotal: true,
        tier: "disclosed",
        reason: (err as Error).message,
      },
      records: null,
      tier: "disclosed",
    };
  }
}

/**
 * Design decision 1's two independent recovery triggers: an observable
 * omission (a whole-handover index-only demotion, or a per-handover cap
 * loss reported as a nonzero count), OR a retained record whose rationale
 * reads the literal "unknown" sentinel -- `tryAdmit`'s own shrink path can
 * produce that with NO omission signal at all (round 4 finding 3).
 */
export function needsEvidenceRecovery(params: {
  readonly indexOnly: boolean;
  readonly omittedCount: number;
  readonly records: readonly { readonly rationale: string }[];
}): boolean {
  if (params.indexOnly) return true;
  if (params.omittedCount > 0) return true;
  return params.records.some((r) => r.rationale === "unknown");
}

async function stepRulesMd(root: string, normalize: Normalizer): Promise<StepReport> {
  const path = join(root, "RULES.md");
  const content = await readFile(path, "utf-8");
  return {
    bytes: measuredTextBytes(content, normalize),
    calls: 0,
    includedInTotal: true,
    content: normalize(content),
  };
}

async function stepLessonDigest(ctx: ReplayContext): Promise<StepReport> {
  const { measurement } = await callTool(ctx, "storybloq_lesson_digest", {});
  return { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true };
}

async function stepGitLogFixture(normalize: Normalizer): Promise<StepReport> {
  return {
    bytes: measuredTextBytes(FIXTURE_GIT_LOG_TEXT, normalize),
    calls: 0,
    includedInTotal: true,
    content: normalize(FIXTURE_GIT_LOG_TEXT),
  };
}

async function stepGitLogLive(root: string, normalize: Normalizer): Promise<StepReport> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-10"], { cwd: root });
    return {
      bytes: measuredTextBytes(stdout, normalize),
      calls: 0,
      includedInTotal: true,
      content: normalize(stdout),
    };
  } catch (err) {
    return {
      bytes: 0,
      calls: 0,
      includedInTotal: true,
      status: "incomplete",
      reason: `git log failed: ${(err as Error).message}`,
    };
  }
}

interface RecommendStepResult {
  report: StepReport;
  rows: RecommendRow[];
  excluded: ExcludedRow[];
}

export async function stepRecommend(ctx: ReplayContext): Promise<RecommendStepResult> {
  const mark = ctx.log.length;
  await ctx.client.callTool({ name: "storybloq_recommend", arguments: { count: 10 } });
  const measurement = measureExchange(ctx.log, mark, ctx.normalize);
  const text = responseText(measurement.rawResponse);
  const parsed = deriveRecommendPayload(text);
  if (parsed.parseFailed) {
    return { report: buildFailedRecommendReport(measurement, parsed.reason), rows: [], excluded: [] };
  }

  return {
    report: {
      bytes: measurement.totalBytes,
      calls: measurement.calls,
      includedInTotal: true,
      // Always 0: `recommendations` is already partitioned to actionable
      // candidates by recommend() itself (ISS-1154), so Gate B and this step
      // need no per-row issue_get walk at all -- kept as a field (rather
      // than dropped) so the zero-cost claim stays a pinned assertion.
      issueGetCalls: 0,
      actionableIssueCount: parsed.rows.filter((r) => r.kind === "issue").length,
      excludedCount: parsed.excluded.length,
      unreadableHandoverCount: parsed.unreadableHandoverCount,
      requestCarriesCountTen:
        (measurement.rawRequest as any)?.params?.arguments?.count === 10,
    },
    rows: parsed.rows,
    excluded: parsed.excluded,
  };
}

function idMatchesRow(row: { id: string; displayId?: string }, id: string): boolean {
  return row.id === id || row.displayId === id;
}

// ---------------------------------------------------------------------------
// T-498 Commit 3: line one -- resolves handovers[0].continuationCandidates
// (Commit 2's primitive) via the SAME bounded-array-then-fallback
// actionability walk the old heading-scanned Continuation check always used.
// Replaces stepContinuationCheck (heading-scan + verbatim block), which is
// retired along with SKILL.md's standalone "## Continuation from ..." block.
// ---------------------------------------------------------------------------

interface CandidateSkip {
  readonly id: string | null;
  readonly status: string;
}

interface WalkOutcome {
  readonly resolved: ContinuationCandidate | null;
  readonly skipped: CandidateSkip[];
  readonly walkBytes: number;
  readonly walkCalls: number;
  readonly walkIncomplete: boolean;
  readonly walkIncompleteReason?: string;
  readonly fallbackUnreadableHandoverCount?: number | null;
}

/**
 * Mutant (b) guard: an `excluded`-pool hit is already known non-actionable
 * (zero calls) -- it is skipped, never treated as absent-from-both (which
 * would spend a needless fallback `get`). Mutant (a)/(c) guard: every
 * skipped candidate before the resolved one (or before exhaustion) is
 * recorded in `skipped`, in order, so the caller can render an exact
 * conflict note naming each one.
 */
async function walkCandidatesForActionability(
  ctx: ReplayContext,
  candidates: readonly ContinuationCandidate[],
  recommendRows: readonly RecommendRow[],
  excludedRows: readonly ExcludedRow[],
): Promise<WalkOutcome> {
  let resolved: ContinuationCandidate | null = null;
  const skipped: CandidateSkip[] = [];
  const walkCalls: ExchangeMeasurement[] = [];
  let walkIncomplete = false;
  let walkIncompleteReason: string | undefined;
  let failedCallBytes = 0;
  let failedCallCount = 0;
  let fallbackUnreadableHandoverCount: number | null | undefined;

  for (const candidate of candidates) {
    // A decision-kind candidate is id-less and usable immediately -- no
    // actionability bar applies to it (design decision 3).
    if (candidate.kind === "decision") {
      resolved = candidate;
      break;
    }

    const id = candidate.id;
    if (id === null) {
      skipped.push({ id: null, status: "item-with-no-id" });
      continue;
    }

    if (recommendRows.some((r) => idMatchesRow(r, id))) {
      resolved = candidate;
      break;
    }
    if (excludedRows.some((r) => idMatchesRow(r, id))) {
      skipped.push({ id, status: "excluded" });
      continue;
    }

    try {
      const isIssue = id.startsWith("ISS-");
      const toolName = isIssue ? "storybloq_issue_get" : "storybloq_ticket_get";
      const { measurement, text } = await callTool(ctx, toolName, {
        id,
        format: "json",
        withActionability: true,
      });
      walkCalls.push(measurement);
      const parsed = deriveEntityActionability(text);
      if (parsed.parseFailed) {
        walkIncomplete = true;
        walkIncompleteReason ??= `line one fallback response for ${id} could not be parsed: ${parsed.reason}`;
        skipped.push({ id, status: "unreadable" });
        continue;
      }
      if (fallbackUnreadableHandoverCount === undefined || fallbackUnreadableHandoverCount === 0) {
        fallbackUnreadableHandoverCount = parsed.unreadableHandoverCount;
      }
      if (parsed.status === "actionable") {
        resolved = candidate;
        break;
      }
      skipped.push({ id, status: parsed.status ?? "unknown" });
    } catch (err) {
      walkIncomplete = true;
      walkIncompleteReason ??= `line one walk failed on ${id}: ${(err as Error).message}`;
      if (err instanceof CallToolFailure) {
        failedCallBytes += err.partialBytes;
        failedCallCount += err.partialCalls;
      }
      skipped.push({ id, status: "failed" });
      continue;
    }
  }

  return {
    resolved,
    skipped,
    walkBytes: walkCalls.reduce((a, m) => a + m.totalBytes, 0) + failedCallBytes,
    walkCalls: walkCalls.length + failedCallCount,
    walkIncomplete,
    walkIncompleteReason,
    fallbackUnreadableHandoverCount,
  };
}

function renderConflictNote(skipped: readonly CandidateSkip[]): string | undefined {
  if (skipped.length === 0) return undefined;
  return skipped.map((s) => `${s.id ?? "(id-less decision)"}: ${s.status}`).join("; ");
}

/**
 * Codex round 1 finding 3: a recovered walk's own uncertainty must not
 * silently replace or be replaced by the primary walk's -- both are real,
 * both must survive to the final report. `walkIncomplete`/its reason are
 * OR'd (either walk being uncertain makes the whole resolution uncertain,
 * first reason wins); `fallbackUnreadableHandoverCount` keeps the same
 * "earliest uncertain value wins" rule each individual walk already applies
 * internally, but now across walk boundaries too.
 */
function mergeWalkUncertainty(...walks: readonly WalkOutcome[]): {
  readonly walkIncomplete: boolean;
  readonly walkIncompleteReason?: string;
  readonly fallbackUnreadableHandoverCount?: number | null;
} {
  let walkIncomplete = false;
  let walkIncompleteReason: string | undefined;
  let fallbackUnreadableHandoverCount: number | null | undefined;
  for (const w of walks) {
    if (w.walkIncomplete) {
      walkIncomplete = true;
      walkIncompleteReason ??= w.walkIncompleteReason;
    }
    if (w.fallbackUnreadableHandoverCount !== undefined) {
      if (fallbackUnreadableHandoverCount === undefined || fallbackUnreadableHandoverCount === 0) {
        fallbackUnreadableHandoverCount = w.fallbackUnreadableHandoverCount;
      }
    }
  }
  return { walkIncomplete, walkIncompleteReason, fallbackUnreadableHandoverCount };
}

export interface LineOneStepResult {
  readonly report: StepReport;
  readonly resolvedCandidate: ContinuationCandidate | null;
}

/**
 * T-498 Commit 3, design decisions 1 and 3: walk `handovers[0].continuation-
 * Candidates` in document order via `walkCandidatesForActionability`. When
 * nothing resolves and `omittedContinuationCount` is nonzero, recover before
 * falling back (mutant (d)/(e) guard) via Commit 2's shared 3-tier
 * `recoverHandoverEvidence`, filtering the recovered full-disposition record
 * list down to `disposition === "continuation"` (the line-one-specific
 * filter -- decision 2's reconciliation consumer uses the unfiltered result
 * instead, see `stepReconciliationRecovery`), then re-walks the recovered
 * candidates the SAME way. Only when both the primary walk and the
 * recovered walk fail to resolve does this fall back to Ready to Work's top
 * row (signaled by `resolvedCandidate: null`), disclosing `omittedContinuation-
 * Ids` when the omission was never actually recovered.
 */
export async function stepLineOne(
  ctx: ReplayContext,
  primingBody: string | null,
  briefHandovers: readonly HandoverBriefEntryLike[],
  recommendRows: readonly RecommendRow[] = [],
  excludedRows: readonly ExcludedRow[] = [],
): Promise<LineOneStepResult> {
  const newest = briefHandovers[0];
  if (!newest || !newest.continuationCandidates) {
    return {
      report: { bytes: 0, calls: 0, includedInTotal: true, present: false },
      resolvedCandidate: null,
    };
  }

  const cc = newest.continuationCandidates;
  const primary = await walkCandidatesForActionability(ctx, cc.candidates, recommendRows, excludedRows);

  if (primary.resolved) {
    return {
      report: {
        bytes: primary.walkBytes,
        calls: primary.walkCalls,
        includedInTotal: true,
        present: true,
        resolvedId: primary.resolved.id,
        resolvedKind: primary.resolved.kind,
        recovered: false,
        conflictNote: renderConflictNote(primary.skipped),
        ...(primary.fallbackUnreadableHandoverCount !== undefined
          ? { fallbackUnreadableHandoverCount: primary.fallbackUnreadableHandoverCount }
          : {}),
        ...(primary.walkIncomplete ? { status: "incomplete", reason: primary.walkIncompleteReason } : {}),
      },
      resolvedCandidate: primary.resolved,
    };
  }

  if (cc.omittedContinuationCount === 0) {
    const uncertainty = mergeWalkUncertainty(primary);
    return {
      report: {
        bytes: primary.walkBytes,
        calls: primary.walkCalls,
        includedInTotal: true,
        present: true,
        resolvedId: null,
        usedFallback: true,
        conflictNote: renderConflictNote(primary.skipped),
        ...(uncertainty.fallbackUnreadableHandoverCount !== undefined
          ? { fallbackUnreadableHandoverCount: uncertainty.fallbackUnreadableHandoverCount }
          : {}),
        ...(uncertainty.walkIncomplete ? { status: "incomplete", reason: uncertainty.walkIncompleteReason } : {}),
      },
      resolvedCandidate: null,
    };
  }

  const recovery = await recoverHandoverEvidence(ctx, newest.filename, primingBody);

  if (recovery.records === null) {
    // Tier 3: recovery itself failed (the target handover could not be
    // read at all) -- this is the ONLY branch that says "could not be
    // recovered", and that disclosure is a genuinely incomplete outcome on
    // its own, independent of whether the primary walk also struggled.
    // Codex round 1 finding 3 / round 2 finding B: the primary walk's own
    // uncertainty (an unreadable/failed fallback `get` before recovery was
    // ever attempted) must still surface here too, in a field of its own --
    // not spliced into `reason`, where it would silently overwrite the
    // "could not be recovered" disclosure text.
    const uncertainty = mergeWalkUncertainty(primary);
    return {
      report: {
        bytes: primary.walkBytes + recovery.report.bytes,
        calls: primary.walkCalls + recovery.report.calls,
        includedInTotal: true,
        present: true,
        resolvedId: null,
        usedFallback: true,
        disclosed: true,
        status: "incomplete",
        recoveryTier: recovery.tier,
        omittedContinuationIds: cc.omittedContinuationIds,
        reason:
          "N further continuation entries in the latest handover could not be recovered; treat this ranking as provisional",
        conflictNote: renderConflictNote(primary.skipped),
        ...(uncertainty.fallbackUnreadableHandoverCount !== undefined
          ? { fallbackUnreadableHandoverCount: uncertainty.fallbackUnreadableHandoverCount }
          : {}),
        ...(uncertainty.walkIncomplete ? { walkIncompleteReason: uncertainty.walkIncompleteReason } : {}),
      },
      resolvedCandidate: null,
    };
  }

  // Codex round 1 finding 4: only re-resolve candidates the primary walk
  // never saw at all -- re-walking every recovered candidate (including
  // ones already checked) would spend a second fallback `get` and log a
  // second conflict-note entry for the same candidate. Dedupe by id where
  // present; an id-less decision has no id to key on, so its label is the
  // only available identity.
  const alreadySeenKeys = new Set(cc.candidates.map((c) => c.id ?? `label:${c.label}`));
  const recoveredCandidates: ContinuationCandidate[] = recovery.records
    .filter((r) => r.disposition === "continuation")
    .map((r) => ({ id: r.id, kind: r.kind, label: r.label, rationale: r.rationale }))
    .filter((c) => !alreadySeenKeys.has(c.id ?? `label:${c.label}`));
  const recoveredWalk = await walkCandidatesForActionability(ctx, recoveredCandidates, recommendRows, excludedRows);
  const combinedSkipped = [...primary.skipped, ...recoveredWalk.skipped];
  const combinedBytes = primary.walkBytes + recovery.report.bytes + recoveredWalk.walkBytes;
  const combinedCalls = primary.walkCalls + recovery.report.calls + recoveredWalk.walkCalls;
  const combinedUncertainty = mergeWalkUncertainty(primary, recoveredWalk);

  if (recoveredWalk.resolved) {
    return {
      report: {
        bytes: combinedBytes,
        calls: combinedCalls,
        includedInTotal: true,
        present: true,
        resolvedId: recoveredWalk.resolved.id,
        resolvedKind: recoveredWalk.resolved.kind,
        recovered: true,
        recoveryTier: recovery.tier,
        conflictNote: renderConflictNote(combinedSkipped),
        ...(combinedUncertainty.fallbackUnreadableHandoverCount !== undefined
          ? { fallbackUnreadableHandoverCount: combinedUncertainty.fallbackUnreadableHandoverCount }
          : {}),
        ...(combinedUncertainty.walkIncomplete
          ? { status: "incomplete", reason: combinedUncertainty.walkIncompleteReason }
          : {}),
      },
      resolvedCandidate: recoveredWalk.resolved,
    };
  }

  // Codex round 1 finding 5: recovery SUCCEEDED here (records !== null) --
  // it is the ACTIONABILITY walk over the recovered candidates that found
  // nothing, a different outcome from tier 3's "could not be recovered".
  // Falling back with that wording would misreport evidence that was, in
  // fact, fully recovered and simply not actionable.
  return {
    report: {
      bytes: combinedBytes,
      calls: combinedCalls,
      includedInTotal: true,
      present: true,
      resolvedId: null,
      usedFallback: true,
      recovered: true,
      recoveryTier: recovery.tier,
      note: "recovered evidence for the omitted continuation entries; none resolved actionable",
      conflictNote: renderConflictNote(combinedSkipped),
      ...(combinedUncertainty.fallbackUnreadableHandoverCount !== undefined
        ? { fallbackUnreadableHandoverCount: combinedUncertainty.fallbackUnreadableHandoverCount }
        : {}),
      ...(combinedUncertainty.walkIncomplete
        ? { status: "incomplete", reason: combinedUncertainty.walkIncompleteReason }
        : {}),
    },
    resolvedCandidate: null,
  };
}

export interface ReconciliationRecoveryResult {
  readonly report: StepReport;
  readonly perHandover: ReadonlyArray<{
    readonly filename: string;
    readonly recovered: boolean;
    readonly tier: RecoveryTier | "not-needed";
    readonly records: readonly SectionRecord[] | null;
    readonly reason?: string;
  }>;
}

/**
 * T-498 Commit 3, design decision 2: before finalizing line one, the older
 * handovers already loaded in the `brief` response (index 1-9) are checked
 * across every disposition for a decision or abandoned-approach record. Any
 * older handover that itself needs recovery (Commit 2's two independent
 * triggers: an omission signal, or a retained record whose rationale reads
 * the "unknown" sentinel) recovers via the SAME shared 3-tier helper line
 * one's own candidate uses -- but UNFILTERED by disposition (mutant guard:
 * reconciliation must see a non-continuation-disposition record too, e.g. an
 * `owner-gated` decision). A handover that needs no recovery costs zero
 * calls and is used exactly as already loaded (mutant (e) guard).
 */
export async function stepReconciliationRecovery(
  ctx: ReplayContext,
  olderHandovers: readonly HandoverBriefEntryLike[],
): Promise<ReconciliationRecoveryResult> {
  let bytes = 0;
  let calls = 0;
  const perHandover: Array<ReconciliationRecoveryResult["perHandover"][number]> = [];
  // Codex round 2 finding A: a failed recovery (tier 3, `records === null`)
  // must not be recorded as `recovered: true` -- that discarded the failure
  // diagnostic, let `recoveredCount` count it as a success, and left the
  // overall replay reporting complete despite missing reconciliation
  // evidence. Track the first such failure to surface on the step's own
  // report, alongside every handover's own `reason` when it failed.
  let firstFailure: { filename: string; reason?: string } | undefined;

  for (const h of olderHandovers) {
    const records = h.records ?? [];
    const indexOnly = h.form === "index-only";
    const omittedCount = h.index?.omittedCount ?? 0;
    if (!needsEvidenceRecovery({ indexOnly, omittedCount, records })) {
      perHandover.push({ filename: h.filename, recovered: false, tier: "not-needed", records });
      continue;
    }
    const recovery = await recoverHandoverEvidence(ctx, h.filename, null);
    bytes += recovery.report.bytes;
    calls += recovery.report.calls;
    const recovered = recovery.records !== null;
    const reason = recovered ? undefined : (recovery.report as { reason?: string }).reason;
    if (!recovered) firstFailure ??= { filename: h.filename, reason };
    perHandover.push({
      filename: h.filename,
      recovered,
      tier: recovery.tier,
      records: recovery.records,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  return {
    report: {
      bytes,
      calls,
      includedInTotal: true,
      checkedCount: olderHandovers.length,
      recoveredCount: perHandover.filter((p) => p.recovered).length,
      ...(firstFailure
        ? {
            status: "incomplete",
            reason: `reconciliation recovery for ${firstFailure.filename} could not be recovered${firstFailure.reason ? `: ${firstFailure.reason}` : ""}`,
          }
        : {}),
    },
    perHandover,
  };
}

function stepContextColumnLookup(rows: readonly RecommendRow[]): {
  report: StepReport;
  contextById: Map<string, { context: string; diagnostic: string }>;
} {
  const lookup = lookupContextColumn(rows);
  const contextById = new Map(lookup.map((r) => [r.id, { context: r.context, diagnostic: r.diagnostic }]));
  return {
    report: { bytes: 0, calls: 0, includedInTotal: true, rows: lookup },
    contextById,
  };
}

function stepReadyToWorkTable(
  rows: readonly RecommendRow[],
  contextById: ReadonlyMap<string, { context: string; diagnostic: string }>,
  normalize: Normalizer,
): StepReport {
  const table = renderReadyToWorkTable(rows, contextById);
  const shown = Math.min(5, rows.length);
  return {
    bytes: measuredTextBytes(table, normalize),
    calls: 0,
    includedInTotal: true,
    rowsShown: shown,
    moreCount: rows.length - shown,
    text: normalize(table),
  };
}

async function stepNodeList(ctx: ReplayContext, orchestrator: boolean): Promise<StepReport> {
  if (!orchestrator) {
    return { bytes: 0, calls: 0, includedInTotal: true, gated: true, reason: "non-orchestrator project" };
  }
  const { measurement } = await callTool(ctx, "storybloq_node_list", {});
  return { bytes: measurement.totalBytes, calls: measurement.calls, includedInTotal: true, gated: false };
}

async function readOrchestratorFlag(root: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, ".story", "config.json"), "utf-8");
    return isOrchestratorConfig(JSON.parse(raw));
  } catch {
    return false;
  }
}

// --- fixture mode --------------------------------------------------------------

// --- shared step sequence ----------------------------------------------------
//
// Both fixture and live mode drive the exact same step sequence through the
// exact same stop/retention rules; only the surrounding setup (how the ctx is
// built, which extra live-only meta fields get computed afterward) differs.
// Sharing one sequence means a rule fixed here (stop-on-unverifiable
// reconciliation, partial-progress retention on a late failure) cannot drift
// between the two modes the way two independently maintained copies can.
//
// Retention contract: when a step's downstream PARSING genuinely cannot be
// interpreted, its own already-captured transport bytes/calls are RETAINED
// (the request/response were genuinely sent and measured); only steps that
// DEPEND on that failed parse are marked incomplete. If reconciliation comes
// back "unverifiable" (a fingerprint mismatch persisting after a retried
// guard call), the guard's own vocabulary for that state is "stop; do not
// guess" -- so every downstream step is left unexecuted (zero-cost,
// status:"incomplete") rather than continuing to call tools that the skill
// itself would not have called at that point. If ANYTHING in the sequence
// throws unexpectedly, whatever steps completed before the throw are
// retained as-is; only the remaining, not-yet-run steps are filled with a
// zero-cost crash placeholder. This function never throws.

export async function runReplaySequence(
  ctx: ReplayContext,
  root: string,
  normalize: Normalizer,
): Promise<{
  steps: Record<StepName, StepReport>;
  anyIncomplete: boolean;
  guardVerdict: unknown;
  orchestrator: boolean;
}> {
  let anyIncomplete = false;
  let guardVerdict: unknown = null;
  let orchestrator = false;
  const steps: Partial<Record<StepName, StepReport>> = {};

  // Tracks which step is CURRENTLY running and the log position right
  // before it started. STEP_NAMES' declared order does not match execution
  // order (reconciliation is declared before status but runs after it), so
  // recovery cannot infer "which step crashed" from declaration order --
  // `enter` records it explicitly, right before that step's own work
  // begins. If it throws (a JSON.parse or similar post-processing failure
  // after a call already transmitted), the catch below recovers whatever
  // landed in the log between this mark and the crash and attributes it to
  // the step `enter` named, rather than silently zeroing it.
  let stepBoundaryMark = ctx.log.length;
  let currentStepName: StepName | null = null;
  const enter = (name: StepName): void => {
    currentStepName = name;
    stepBoundaryMark = ctx.log.length;
  };

  const fillRemaining = (reason: string): void => {
    for (const name of STEP_NAMES) {
      if (!(name in steps)) {
        steps[name] = { bytes: 0, calls: 0, includedInTotal: true, status: "incomplete", reason };
      }
    }
  };

  // Single exit point: both the early "unverifiable" return and the normal
  // end-of-sequence return go through this, so the two paths cannot drift
  // on which fields the result carries or how step order is normalized.
  const finalize = (): {
    steps: Record<StepName, StepReport>;
    anyIncomplete: boolean;
    guardVerdict: unknown;
    orchestrator: boolean;
  } => {
    const orderedSteps = Object.fromEntries(
      STEP_NAMES.map((name) => [name, steps[name] as StepReport]),
    ) as Record<StepName, StepReport>;
    return { steps: orderedSteps, anyIncomplete, guardVerdict, orchestrator };
  };

  try {
    enter("tool_discovery");
    const discovery = await stepToolDiscovery(ctx);
    steps.tool_discovery = discovery.modeled;
    steps.tool_discovery_reference = discovery.reference;

    enter("session_guard");
    const guard = await stepSessionGuard(ctx);
    steps.session_guard = guard.report;
    guardVerdict = guard.verdict;

    enter("status");
    const status = await stepStatus(ctx);
    steps.status = status.report;

    enter("reconciliation");
    const reconciliation = await stepReconciliation(ctx, guard.verdict, status.payload);
    steps.reconciliation = reconciliation;
    if ((reconciliation as any).status === "incomplete") anyIncomplete = true;

    if ((reconciliation as any).verdict === "unverifiable") {
      anyIncomplete = true;
      fillRemaining(
        "skipped: reconciliation reported an unverifiable session-guard verdict; per the guard's own 'unverifiable: stop, do not guess' semantics the replay does not proceed past this point",
      );
      return finalize();
    }

    enter("recap");
    const recap = await stepRecap(ctx);
    steps.recap = recap;

    enter("handover_latest");
    const handover = await stepHandoverPrimingAndBrief(ctx);
    steps.handover_latest = handover.report;

    enter("rules_md");
    let rulesMd: StepReport;
    try {
      rulesMd = await stepRulesMd(root, normalize);
    } catch {
      rulesMd = { bytes: 0, calls: 0, includedInTotal: true, status: "incomplete", reason: "RULES.md not readable" };
      anyIncomplete = true;
    }
    steps.rules_md = rulesMd;

    enter("lesson_digest");
    const lessonDigest = await stepLessonDigest(ctx);
    steps.lesson_digest = lessonDigest;

    enter("git_log");
    const gitLog = ctx.gitLogMode === "live" ? await stepGitLogLive(root, normalize) : await stepGitLogFixture(normalize);
    if (gitLog.status === "incomplete") anyIncomplete = true;
    steps.git_log = gitLog;

    // stepRecommend never throws on a parse failure: it retains the already-
    // captured request/response bytes and call count in the returned report
    // (status: "incomplete") rather than discarding them, since the exchange
    // genuinely transmitted. `rows`/`excluded` come back empty in that case,
    // which is what correctly starves the downstream Gate B / continuation /
    // context / table steps of anything to depend on below.
    enter("recommend");
    const { report: recommend, rows: recommendRows, excluded: excludedRows } = await stepRecommend(ctx);
    if (recommend.status === "incomplete") anyIncomplete = true;
    steps.recommend = recommend;

    // `briefHandovers[0]` is the newest handover, the one line one resolves
    // against; `briefHandovers[1..]` are the older window decision 2's
    // reconciliation check consults. Both `recommendRows` and `excludedRows`
    // are threaded through so a candidate already resolved by recommend()'s
    // own partition costs zero further calls.
    enter("continuation_check");
    const { report: lineOne, resolvedCandidate } = await stepLineOne(
      ctx,
      handover.primingBody,
      handover.briefHandovers,
      recommendRows,
      excludedRows,
    );
    const reconciliation2 = await stepReconciliationRecovery(ctx, handover.briefHandovers.slice(1));
    const continuation: StepReport = {
      bytes: lineOne.bytes + reconciliation2.report.bytes,
      calls: lineOne.calls + reconciliation2.report.calls,
      includedInTotal: true,
      lineOne,
      reconciliationRecovery: reconciliation2.report,
      resolvedCandidate,
    };
    if (lineOne.status === "incomplete") anyIncomplete = true;
    if ((reconciliation2.report as { status?: string }).status === "incomplete") anyIncomplete = true;
    steps.continuation_check = continuation;

    enter("trajectory");
    steps.trajectory = stepTrajectory(handover.trajectory, normalize);

    enter("context_column_lookup");
    let contextLookup: { report: StepReport; contextById: Map<string, { context: string; diagnostic: string }> };
    let readyTable: StepReport;
    if (recommend.status === "incomplete") {
      contextLookup = { report: { bytes: 0, calls: 0, includedInTotal: true, status: "incomplete", reason: "depends on recommend" }, contextById: new Map() };
      readyTable = { bytes: 0, calls: 0, includedInTotal: true, status: "incomplete", reason: "depends on recommend" };
      anyIncomplete = true;
    } else {
      contextLookup = stepContextColumnLookup(recommendRows);
      readyTable = stepReadyToWorkTable(recommendRows, contextLookup.contextById, normalize);
    }
    steps.context_column_lookup = contextLookup.report;
    steps.ready_to_work_table = readyTable;

    enter("node_list");
    orchestrator = await readOrchestratorFlag(root);
    const nodeList = await stepNodeList(ctx, orchestrator);
    steps.node_list = nodeList;
  } catch (err) {
    anyIncomplete = true;
    const reason = `replay step crashed: ${(err as Error).message}`;
    // Recover whatever transport activity the currently in-progress step
    // (tracked by `enter`, not inferred from STEP_NAMES' declared order --
    // reconciliation is declared before status but runs after it) genuinely
    // captured before it crashed. A JSON.parse or similar post-processing
    // failure after a real call still leaves that call's cost sitting in
    // the log; a step that never got as far as calling a tool recovers
    // zero, which is still accurate.
    const recovered = measureLogRange(ctx.log, stepBoundaryMark, ctx.log.length, normalize);
    if (currentStepName && !(currentStepName in steps)) {
      steps[currentStepName] = {
        bytes: recovered.bytes,
        calls: recovered.calls,
        includedInTotal: true,
        status: "incomplete",
        reason,
      };
    }
    fillRemaining(reason);
  }

  return finalize();
}

async function runFixtureMode(fixtureRoot: string): Promise<PrimingCostReport> {
  const root = resolve(fixtureRoot);
  const normalize = buildNormalizer(root);

  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  registerAllTools(server, root);
  const client = new Client({ name: "priming-cost", version: "0.0.0" });
  const { clientTransport, serverTransport, log } = createCapturingLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const ctx: ReplayContext = { root, client, log, normalize, gitLogMode: "fixture" };

  const { steps, anyIncomplete } = await runReplaySequence(ctx, root, normalize);

  await client.close();

  let totalBytes = 0;
  let totalCalls = 0;
  for (const name of STEP_NAMES) {
    const step = steps[name];
    if (step.includedInTotal) {
      totalBytes += step.bytes;
      totalCalls += step.calls;
    }
  }

  return {
    mode: "fixture",
    meta: {
      measuredRoot: normalize(root) as string,
      generatedAt: new Date().toISOString(),
    },
    steps,
    totals: { bytes: totalBytes, calls: totalCalls, status: anyIncomplete ? "observed_subtotal" : "complete" },
    rawLog: log,
  };
}

// --- live mode -------------------------------------------------------------------
//
// Same step sequence and parsing logic as fixture mode (see runReplaySequence
// above). Never throws; always exits 0.

/** sha256 of the installed /story SKILL.md in Claude's config dir (ISS-1270: CLAUDE_CONFIG_DIR when set), or null. */
export async function readInstalledSkillHash(): Promise<string | null> {
  try {
    const content = await readFile(join(claudeConfigDir(), "skills", "story", "SKILL.md"), "utf-8");
    return createHash("sha256").update(content, "utf8").digest("hex");
  } catch {
    return null;
  }
}

async function runLiveMode(root: string): Promise<PrimingCostReport> {
  const absRoot = resolve(root);
  const normalize = buildNormalizer(absRoot);

  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  registerAllTools(server, absRoot);
  const client = new Client({ name: "priming-cost-live", version: "0.0.0" });
  const { clientTransport, serverTransport, log } = createCapturingLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const ctx: ReplayContext = { root: absRoot, client, log, normalize, gitLogMode: "live" };

  const { steps, anyIncomplete, guardVerdict, orchestrator } = await runReplaySequence(ctx, absRoot, normalize);

  await client.close();

  let totalBytes = 0;
  let totalCalls = 0;
  for (const name of STEP_NAMES) {
    const step = steps[name];
    if (step.includedInTotal) {
      totalBytes += step.bytes;
      totalCalls += step.calls;
    }
  }

  let commit: string | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: absRoot });
    commit = stdout.trim();
  } catch {
    commit = null;
  }

  let dirty: boolean | null = null;
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: absRoot });
    dirty = stdout.trim().length > 0;
  } catch {
    dirty = null;
  }

  const guardSessions = ((guardVerdict as { sessions?: unknown[] } | null)?.sessions ?? []) as unknown[];
  const sessionInventory = {
    count: guardSessions.length,
    ids: guardSessions
      .map((s) => (s as { sessionId?: unknown })?.sessionId)
      .filter((id): id is string => typeof id === "string"),
  };

  const installedSkillHash = await readInstalledSkillHash();

  return {
    mode: "live",
    meta: {
      measuredRoot: normalize(absRoot) as string,
      generatedAt: new Date().toISOString(),
      commit,
      dirty,
      sessionInventory,
      installedSkillHash,
      orchestrator,
    },
    steps,
    totals: { bytes: totalBytes, calls: totalCalls, status: anyIncomplete ? "observed_subtotal" : "complete" },
    rawLog: log,
  };
}

// --- CLI entry ---------------------------------------------------------------

export function buildCrashReport(root: string, error: Error): PrimingCostReport {
  const zeroStep: StepReport = {
    bytes: 0,
    calls: 0,
    includedInTotal: true,
    status: "incomplete",
    reason: `live replay crashed: ${error.message}`,
  };
  const steps = Object.fromEntries(STEP_NAMES.map((name) => [name, zeroStep])) as Record<
    StepName,
    StepReport
  >;
  return {
    mode: "live",
    meta: { measuredRoot: root, generatedAt: new Date().toISOString() },
    steps,
    totals: { bytes: 0, calls: 0, status: "observed_subtotal" },
    rawLog: [],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--emit-json") {
    const fixtureRoot = args[1];
    if (!fixtureRoot) {
      console.error("--emit-json requires a fixture root argument");
      process.exit(1);
    }
    const report = await runFixtureMode(fixtureRoot);
    console.log(JSON.stringify(report));
    return;
  }
  if (args[0] === "--live") {
    const root = args[1] ?? process.cwd();
    // Live mode's own design goal is "never throws, always exits 0" -- but
    // no single step can guarantee that against an arbitrary real project
    // (a corrupted ledger file, a tool that genuinely rejects). This is the
    // last line of defense: if anything anywhere in the live replay throws
    // regardless, still emit a valid, minimally-shaped report rather than a
    // bare stack trace and a nonzero exit.
    try {
      const report = await runLiveMode(root);
      console.log(JSON.stringify(report, null, 2));
    } catch (err) {
      console.log(JSON.stringify(buildCrashReport(root, err as Error), null, 2));
    }
    return;
  }
  console.error("usage: priming-cost.ts --emit-json <fixtureRoot> | --live [root]");
  process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
