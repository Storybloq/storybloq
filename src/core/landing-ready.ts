/**
 * C-v4.1 commit 6, plan section 7: is an item ready to land at a candidate?
 *
 * The candidate is required: a full sha, or `base..head`. Per receipt kind the
 * readiness scope of 3.7 applies:
 * - test, mutant and device are in scope only when `receipt.sha` is the
 *   candidate head;
 * - a review is in scope only when it covers the requested range: its sha is
 *   the candidate head and its base is an ancestor of, or equal to, the
 *   candidate base. For a sha-only candidate the review's base must be an
 *   ancestor of the candidate that is reachable from the default branch.
 *
 * Attempt order is `currentAttempts` (3.7), never array position or time:
 * `pass`, `failing`, `concurrent` (not ready) or `none` (missing).
 */
import { readGitFacts, type GitFactsView } from "./git-facts/facts.js";
import type { ProjectState } from "./project-state.js";
import { displayIdOf } from "./resolver.js";
import { loadProject } from "./project-loader.js";
import { findItem, type StateWithRefs } from "./receipt-add.js";
import { conflictedReceiptIds, currentAttempts, readReceipts, type AttemptOutcome, type Receipt, type ReceiptKind } from "./receipts.js";

export type PolicyLevel = "required" | "optional";

export interface LandingPolicy {
  readonly test: PolicyLevel;
  readonly review: PolicyLevel;
  readonly mutant: PolicyLevel;
  /** `real` requires a passing device attempt on a real device. */
  readonly device: PolicyLevel | "real";
}

/** Section 7 default: test and review required, mutant optional (device optional). */
export const DEFAULT_LANDING_POLICY: LandingPolicy = { test: "required", review: "required", mutant: "optional", device: "optional" };

export interface Candidate {
  readonly head: string;
  readonly base?: string;
}

/** The ancestry questions readiness asks of the item's repository. */
export interface AncestryOracle {
  /** True when `a` is an ancestor of `b` or equal to it. */
  readonly isAncestor: (a: string, b: string) => boolean;
  readonly onDefault: (sha: string) => boolean;
}

export interface KindReadiness {
  readonly kind: ReceiptKind;
  readonly level: PolicyLevel | "real";
  readonly outcome: AttemptOutcome;
  readonly current: readonly string[];
  readonly detail?: string;
}

export interface LandingReadiness {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly failing: readonly string[];
  readonly concurrent: readonly string[];
  /** Receipt ids an open receipt merge conflict names: neither side counts until it is resolved. */
  readonly contradictions: readonly string[];
  readonly candidate: { readonly head: string; readonly base: string | null };
  readonly kinds: readonly KindReadiness[];
}

const KINDS: readonly ReceiptKind[] = ["test", "review", "mutant", "device"];

/** Parses `<sha>` or `<base>..<head>`. Shas must be full (40 or 64 hex). */
export function parseCandidate(text: string): Candidate | undefined {
  const full = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  const parts = text.split("..");
  if (parts.length === 1) return full.test(parts[0]!) ? { head: parts[0]! } : undefined;
  if (parts.length === 2 && full.test(parts[0]!) && full.test(parts[1]!)) return { base: parts[0]!, head: parts[1]! };
  return undefined;
}

/** The readiness scope of 3.7 for one receipt. */
export function inReadinessScope(r: Receipt, kind: ReceiptKind, candidate: Candidate, git: AncestryOracle): boolean {
  if (r.kind !== kind || r.sha !== candidate.head) return false;
  if (kind !== "review") return true;
  if (r.base === undefined) return false;
  if (candidate.base !== undefined) return git.isAncestor(r.base, candidate.base);
  return git.isAncestor(r.base, candidate.head) && git.onDefault(r.base);
}

const isReal = (r: Receipt): boolean => (r.data as { deviceClass?: unknown } | undefined)?.deviceClass === "real";

/** The pure calculation over one record's receipts. */
export function computeLandingReadiness(record: Record<string, unknown>, candidate: Candidate, policy: LandingPolicy, git: AncestryOracle): LandingReadiness {
  const read = readReceipts(record);
  const ok: Receipt[] = read.state === "ok" ? read.entries.flatMap((e) => (e.state === "ok" ? [e.receipt] : [])) : [];
  const contradictions = [...conflictedReceiptIds(record)].sort();
  const missing: string[] = [];
  const failing: string[] = [];
  const concurrent: string[] = [];
  const kinds: KindReadiness[] = [];
  for (const kind of KINDS) {
    const level = policy[kind];
    const ca = currentAttempts(ok, (r) => inReadinessScope(r, kind, candidate, git));
    let detail: string | undefined;
    let satisfied = ca.outcome === "pass";
    if (satisfied && level === "real" && !ca.current.some(isReal)) {
      satisfied = false;
      detail = "no real-device pass";
    }
    kinds.push({ kind, level, outcome: ca.outcome, current: ca.current.map((r) => r.id), ...(detail !== undefined ? { detail } : {}) });
    if (level === "optional") {
      // An optional kind never blocks on absence, but a failing or concurrent attempt still holds the candidate.
      if (ca.outcome === "failing") failing.push(kind);
      else if (ca.outcome === "concurrent") concurrent.push(kind);
      continue;
    }
    if (ca.outcome === "none" || (ca.outcome === "pass" && !satisfied)) missing.push(detail !== undefined ? `${kind} (${detail})` : kind);
    else if (ca.outcome === "failing") failing.push(kind);
    else if (ca.outcome === "concurrent") concurrent.push(kind);
  }
  return {
    ready: missing.length === 0 && failing.length === 0 && concurrent.length === 0 && contradictions.length === 0,
    missing,
    failing,
    concurrent,
    contradictions,
    candidate: { head: candidate.head, base: candidate.base ?? null },
    kinds,
  };
}

/**
 * Pen ruling Q1: `receipts.landingPolicy` from the raw config. An invalid
 * value falls back to the default for that kind with a note (the session-intel
 * pattern), never a throw.
 */
export function resolveLandingPolicy(rawConfig: unknown): { policy: LandingPolicy; notes: string[] } {
  const notes: string[] = [];
  const block = (rawConfig as { receipts?: { landingPolicy?: unknown } } | undefined)?.receipts?.landingPolicy;
  if (block === undefined) return { policy: DEFAULT_LANDING_POLICY, notes };
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    notes.push("receipts.landingPolicy ignored (not an object); the default is used");
    return { policy: DEFAULT_LANDING_POLICY, notes };
  }
  const raw = block as Record<string, unknown>;
  const pick = <K extends keyof LandingPolicy>(kind: K, allowed: readonly LandingPolicy[K][]): LandingPolicy[K] => {
    const v = raw[kind];
    if (v === undefined) return DEFAULT_LANDING_POLICY[kind];
    if ((allowed as readonly unknown[]).includes(v)) return v as LandingPolicy[K];
    notes.push(`receipts.landingPolicy.${kind} ignored (${JSON.stringify(v)} is not ${allowed.join(" or ")}); default ${DEFAULT_LANDING_POLICY[kind]} used`);
    return DEFAULT_LANDING_POLICY[kind];
  };
  const levels: readonly PolicyLevel[] = ["required", "optional"];
  return {
    policy: { test: pick("test", levels), review: pick("review", levels), mutant: pick("mutant", levels), device: pick("device", ["optional", "required", "real"]) },
    notes,
  };
}

export type LandingReadyResult =
  | (LandingReadiness & { readonly item: string; readonly notes: readonly string[] })
  | { readonly item: string; readonly ready: false; readonly unknown: string; readonly candidate: { readonly head: string; readonly base: string | null }; readonly notes: readonly string[] };

/** Section 7 on a board: the item's receipts, the board's policy, and its repository's ancestry. Unknown git facts are never ready. */
export async function landingReady(root: string, id: string, candidate: Candidate): Promise<LandingReadyResult> {
  const { state } = await loadProject(root);
  return landingReadyIn(state, await readGitFacts(root, state), id, candidate);
}

/** landingReady over a state and facts already read (land reads them once for every item). */
function landingReadyIn(state: ProjectState, facts: GitFactsView, id: string, candidate: Candidate): LandingReadyResult {
  const found = findItem(state as unknown as StateWithRefs, id);
  if (found === "ambiguous") throw new Error(`invalid_ref: ${id} matches more than one record.`);
  if (found === undefined) throw new Error(`invalid_ref: ${id} is not a ticket or issue on this board.`);
  const { policy, notes } = resolveLandingPolicy((state as unknown as { config?: unknown }).config);
  const itemId = String(found.record.id);
  const snap = facts.snapshot;
  if (snap.status !== "ok") return { item: itemId, ready: false, unknown: `git facts unknown: ${snap.reason}`, candidate: { head: candidate.head, base: candidate.base ?? null }, notes };
  const git: AncestryOracle = { isAncestor: (a, b) => snap.isAncestor(a, b), onDefault: (sha) => snap.graph.onDefault(sha) };
  return { item: itemId, ...computeLandingReadiness(found.record, candidate, policy, git), notes };
}

/** Section 7 as one line per outcome list. */
export function formatLandingReady(r: LandingReadyResult): string {
  const cand = r.candidate.base !== null ? `${r.candidate.base.slice(0, 8)}..${r.candidate.head.slice(0, 8)}` : r.candidate.head.slice(0, 8);
  if ("unknown" in r) return [`${r.item} at ${cand}: not ready (${r.unknown})`, ...r.notes].join("\n");
  const why: string[] = [];
  if (r.missing.length) why.push(`missing ${r.missing.join(", ")}`);
  if (r.failing.length) why.push(`failing ${r.failing.join(", ")}`);
  if (r.concurrent.length) why.push(`concurrent ${r.concurrent.join(", ")}`);
  if (r.contradictions.length) why.push(`conflicted receipts ${r.contradictions.join(", ")}`);
  return [`${r.item} at ${cand}: ${r.ready ? "ready" : `not ready (${why.join("; ")})`}`, ...r.notes].join("\n");
}

export type ReadyView = { readonly json: LandingReadyResult; readonly lines: readonly string[] };

/** The `candidate` view on ticket_get and issue_get: landingReady in JSON, one line in Markdown. */
export async function readyView(root: string, id: string, text: string): Promise<{ ok: true; json: LandingReadyResult; lines: string[] } | { ok: false; message: string }> {
  const candidate = parseCandidate(text);
  if (!candidate) return { ok: false, message: `candidate takes a full sha or <base>..<head> with full shas, not ${JSON.stringify(text)}.` };
  const r = await landingReady(root, id, candidate);
  return { ok: true, json: r, lines: [`Landing: ${formatLandingReady(r)}`] };
}

const ADVISORY = "Readiness (advisory pending ISS-1081)";
const NAMED_MAX = 5;

export interface LandReadiness {
  readonly line: string;
  readonly items: readonly LandingReadyResult[];
}

/**
 * Pen ruling Q3: land's advisory readiness over the items attributed in
 * priorTip..sha, read from the landing board with that board's policy. One
 * summary line, never omitted; the full per-item array goes to JSON.
 */
export async function landReadiness(boardRoot: string | null, priorTip: string | null, sha: string): Promise<LandReadiness> {
  if (boardRoot === null) return { line: `${ADVISORY}: not computed (no board)`, items: [] };
  if (priorTip === null) return { line: `${ADVISORY}: not computed (the prior tip is unknown)`, items: [] };
  const { state } = await loadProject(boardRoot);
  const facts = await readGitFacts(boardRoot, state);
  const snap = facts.snapshot;
  if (snap.status !== "ok" || facts.commits === undefined) return { line: `${ADVISORY}: not computed (git facts unknown${snap.status !== "ok" ? `: ${snap.reason}` : ""})`, items: [] };
  const ids: string[] = [];
  for (const [id, shas] of facts.commits) {
    if ([...shas].some((c) => snap.isAncestor(c, sha) && !snap.isAncestor(c, priorTip))) ids.push(id);
  }
  ids.sort();
  if (ids.length === 0) return { line: `${ADVISORY}: no items attributed in ${priorTip.slice(0, 8)}..${sha.slice(0, 8)}`, items: [] };
  const items: LandingReadyResult[] = [];
  for (const id of ids) items.push(landingReadyIn(state, facts, id, { base: priorTip, head: sha }));
  const notReady = items.filter((r) => !r.ready);
  const display = (r: LandingReadyResult): string => {
    const rec = state.tickets.find((x) => x.id === r.item) ?? state.issues.find((x) => x.id === r.item);
    return rec !== undefined ? displayIdOf(rec) : r.item;
  };
  const why = (r: LandingReadyResult): string => {
    if ("unknown" in r) return r.unknown;
    return [
      ...(r.missing.length ? [`missing ${r.missing.join(", ")}`] : []),
      ...(r.failing.length ? [`failing ${r.failing.join(", ")}`] : []),
      ...(r.concurrent.length ? [`concurrent ${r.concurrent.join(", ")}`] : []),
      ...(r.contradictions.length ? ["conflicted receipts"] : []),
    ].join("; ");
  };
  const named = notReady.slice(0, NAMED_MAX).map((r) => `${display(r)} not ready (${why(r)})`);
  const more = notReady.length > NAMED_MAX ? [`and ${notReady.length - NAMED_MAX} more`] : [];
  const head = `${ADVISORY}: ${items.length} item${items.length === 1 ? "" : "s"}, ${items.length - notReady.length} ready`;
  return { line: [head, ...named, ...more].join("; "), items };
}
