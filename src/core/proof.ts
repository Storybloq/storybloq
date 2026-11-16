/**
 * C-v4.1 section 5 (ISS-1433): the proof contract. Commit 5.
 *
 * `computeProof` is the pure calculation over gathered inputs; `proveRef`
 * gathers them (records, receipts, git facts and worktree per repository
 * partition), computes, and revalidates a `proven` answer against a
 * fingerprint of every input it read (5.6, A4).
 *
 * Unit refs (pen ruling Q2): a caller names a unit as `ID`, `<alias>:ID` or
 * `<boardId>:ID`; it resolves to the canonical `<boardId>:<canonical id>`
 * through the board registry. Receipts store boardIds. A receipt naming this
 * item under a stored boardId other than the one the ref now resolves to
 * makes the item unproven (mismatched repo): the alias was rebound to another
 * board. A stored boardId that no registered board carries makes it unproven
 * (unresolved repo): the board was removed. Two registered boards carrying
 * the partition's boardId make it unproven (duplicate repo).
 *
 * Units (pen ruling Q3): the child projection is a parameter. An item unit is
 * its own single child (`itemProjection`); journeys (T-572) will supply their
 * own projection to the same signature and are refused by name until then.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardRegistry, canonicalRef, isBoardId, readBoardId, resolveAlias, resolveBoardRef, type BoardEntry } from "./board-id.js";
import { canonicalJson } from "./canonical-json.js";
import { ProjectLoaderError } from "./errors.js";
import { readGitFacts, type GitFactsView } from "./git-facts/facts.js";
import { issueFilePath, loadProject, ticketFilePath } from "./project-loader.js";
import type { ProjectState } from "./project-state.js";
import { findItem, type StateWithRefs } from "./receipt-add.js";
import { RECEIPT_CONFLICT_KINDS } from "./receipt-resolve.js";
import { currentAttempts, readReceipts, type AttemptOutcome, type Receipt } from "./receipts.js";
import { BOOKKEEPING, COMPLETION, recordRevision } from "./record-revision.js";
import { worktreeState, type WorktreeState } from "./worktree-state.js";

export type WorkClass = "code" | "non-code" | "unknown";

/** A location entry that names a source path: a relative path, outside `.story/`, with an optional `:line` suffix. */
function namesSourcePath(entry: unknown): boolean {
  if (typeof entry !== "string") return false;
  const path = entry.trim().replace(/:\d+(?::\d+)?$/, "");
  if (path.length === 0 || path.startsWith("/") || path.startsWith(".story/") || path === ".story") return false;
  return /[/.]/.test(path);
}

/**
 * 5.4, the one authoritative rule. Every ticket type is code; an issue is code
 * when it has components and a location naming a source path, otherwise
 * unknown (treated as code). Only the configured `proof.nonCodeItems` list,
 * by canonical ref, makes an item non-code; callers cannot supply the class.
 */
export function classifyWork(
  record: Readonly<Record<string, unknown>>,
  kind: "ticket" | "issue",
  ref: string,
  nonCode: ReadonlySet<string>,
): WorkClass {
  if (nonCode.has(ref)) return "non-code";
  if (kind === "ticket") return "code";
  const components = record.components;
  const location = record.location;
  if (Array.isArray(components) && components.length > 0 && Array.isArray(location) && location.some(namesSourcePath)) return "code";
  return "unknown";
}

// --- 5.3 eligibility ---

export type Eligibility = { readonly eligible: true } | { readonly eligible: false; readonly reason: string };

/** 5.3: deleted, withdrawn, or a merge conflict on a substantive field (bookkeeping per 5.2 is not substantive). */
export function eligibilityOf(record: Readonly<Record<string, unknown>>, kind: "ticket" | "issue"): Eligibility {
  if (record.deletedAt !== undefined && record.deletedAt !== null) return { eligible: false, reason: "deleted" };
  const rk = record.resolutionKind;
  if (rk === "withdrawn" || rk === "dropped") return { eligible: false, reason: `withdrawn (${rk})` };
  const bookkeeping = new Set<string>([...BOOKKEEPING, ...COMPLETION[kind]]);
  if (Array.isArray(record._conflicts)) {
    for (const c of record._conflicts) {
      if (c === null || typeof c !== "object") return { eligible: false, reason: "unreadable merge conflict" };
      const entry = c as { kind?: unknown; field?: unknown };
      if (RECEIPT_CONFLICT_KINDS.has(String(entry.kind))) continue;
      if (typeof entry.field === "string" && bookkeeping.has(entry.field)) continue;
      return { eligible: false, reason: `merge conflict on ${typeof entry.field === "string" ? entry.field : "an unnamed field"}` };
    }
  }
  return { eligible: true };
}

// --- inputs ---

export interface ProofChild {
  /** Canonical `<boardId>:<canonical id>`. */
  readonly ref: string;
  readonly id: string;
  readonly boardId: string;
  readonly revision: string;
  readonly eligibility: Eligibility;
  readonly workClass: WorkClass;
  /** Q2: a mismatched or unresolved repo found in this child's receipts. */
  readonly refProblem?: string;
}

export type RepoPartition =
  | { readonly state: "ok"; readonly boardId: string; readonly facts: GitFactsView; readonly worktree: WorktreeState }
  | { readonly state: "unresolved" | "mismatched" | "duplicate" | "unreadable"; readonly boardId: string; readonly reason: string };

export interface ProofInput {
  readonly unit: { readonly ref: string; readonly revision: string; readonly eligibility: Eligibility };
  readonly children: readonly ProofChild[];
  readonly missing: readonly string[];
  readonly repos: ReadonlyMap<string, RepoPartition>;
  /** Device receipts in state ok whose unitRef is the unit, from the unit's and every child's record, one per id. */
  readonly receipts: readonly Receipt[];
}

// --- output ---

export type ProofOutcome = "proven" | "stale" | "unproven";

export interface ChildProof {
  readonly ref: string;
  readonly outcome: ProofOutcome;
  readonly reason?: string;
  readonly workClass: WorkClass;
  readonly attempts: AttemptOutcome;
  readonly proving: readonly string[];
  readonly stale?: string;
}

export type EvidenceStatus =
  | "proving"
  | "not-counted (deviceClass)"
  | "current"
  | "superseded"
  | "out of scope (revision)"
  | `failed rule ${number}`;

export interface EvidenceRow {
  readonly child: string;
  readonly receipt: string;
  readonly sha: string;
  readonly result: string;
  readonly deviceClass: string | null;
  readonly recordedAt: string;
  readonly status: EvidenceStatus;
  readonly detail?: string;
}

export interface ProofResult {
  readonly unit: string;
  readonly outcome: ProofOutcome;
  readonly reason?: string;
  readonly children: readonly ChildProof[];
  readonly evidence: readonly EvidenceRow[];
  readonly evidenceTotal: number;
  readonly page: number;
  readonly pages: number;
  readonly verifiedAt: string | null;
  /** Whether the inputs moved once and the answer was computed again (5.6). */
  readonly recomputed?: boolean;
}

export const PROOF_EVIDENCE_PAGE_SIZE = 20;

// --- 5.5 rules ---

function cleanWorktree(w: unknown): boolean {
  if (w === null || typeof w !== "object") return false;
  const c = w as Record<string, unknown>;
  return c.staged === 0 && c.unstaged === 0 && c.untracked === 0 && c.submodule === 0;
}

const deviceClassOf = (r: Receipt): string | null => {
  const d = (r.data as { deviceClass?: unknown } | undefined)?.deviceClass;
  return typeof d === "string" ? d : null;
};

interface RuleFailure {
  readonly rule: number;
  readonly detail: string;
  /** Rule 5 failed although C.sha descends from some of X's code: a later code commit (the stale check). */
  readonly later?: boolean;
}

/** Rules 3, 4 and 5 for one attempt (1 and 2 hold by scope; 6 and 7 are checked per partition). */
function attemptRules(c: Receipt, child: ProofChild, repo: Extract<RepoPartition, { state: "ok" }>): RuleFailure | null {
  if (!(c.attestation?.builtFromSha === c.sha && c.attestation.builtClean === true)) return { rule: 3, detail: "not built clean from its sha" };
  if (!c.observation.headMatchesSha) return { rule: 3, detail: "HEAD did not match its sha" };
  if (!cleanWorktree(c.observation.worktree)) return { rule: 3, detail: "its worktree was not clean" };
  const snap = repo.facts.snapshot;
  if (snap.status !== "ok") return { rule: 7, detail: "facts unknown" };
  if (!snap.graph.onDefault(c.sha)) return { rule: 4, detail: "its sha is not on the default branch" };
  if (child.workClass !== "non-code") {
    const commits = [...(repo.facts.commits?.get(child.id) ?? [])];
    if (commits.length === 0) return { rule: 5, detail: "no attributed code commit" };
    const onDefault = commits.filter((sha) => snap.graph.onDefault(sha));
    const ancestors = onDefault.filter((sha) => snap.isAncestor(sha, c.sha));
    if (ancestors.length === 0) return { rule: 5, detail: "its sha lacks the code" };
    if (ancestors.length < onDefault.length) return { rule: 5, detail: "a later code commit", later: true };
  }
  return null;
}

/** 5.6 precedence for one child. */
function proveChild(input: ProofInput, child: ProofChild, rows: EvidenceRow[]): ChildProof {
  const unit = input.unit;
  const repo = input.repos.get(child.boardId);
  const revOf = (r: Receipt): unknown => (r.revisions[child.ref] ?? (child.ref === unit.ref ? r.revisions.unit : undefined));
  // A receipt without covers covers the unit itself (an item unit is its own single child).
  const covers = (r: Receipt): boolean => (r.covers !== undefined ? r.covers.includes(child.ref) : child.ref === unit.ref);
  const related = input.receipts.filter((r) => r.repo === child.boardId && covers(r));
  const inScope = (r: Receipt): boolean => r.revisions.unit === unit.revision && revOf(r) === child.revision;
  const ca = currentAttempts(related, inScope);
  const okRepo = repo?.state === "ok" ? repo : undefined;

  const failures = new Map<string, RuleFailure | null>();
  const ruleOf = (r: Receipt): RuleFailure | null => {
    if (!failures.has(r.id)) failures.set(r.id, okRepo === undefined ? { rule: 7, detail: "facts unknown" } : attemptRules(r, child, okRepo));
    return failures.get(r.id)!;
  };

  // The historical staleness check: an out-of-scope pass once satisfied 1, 3 and 4, or an attempt failed rule 5 for a later code commit.
  let stale: string | undefined;
  for (const r of related) {
    if (r.result !== "pass" || deviceClassOf(r) !== "real") continue;
    const f = ruleOf(r);
    if (!inScope(r) && (f === null || f.rule === 5)) { stale = "evidence is for an older revision"; break; }
    if (inScope(r) && f?.later === true) { stale = "a later code commit"; break; }
  }

  const current = new Set(ca.current.map((r) => r.id));
  const superseded = new Set<string>();
  for (const r of related) if (inScope(r)) for (const s of r.supersedes ?? []) superseded.add(s);
  const proving: Receipt[] = [];
  let firstFailure: RuleFailure | null = null;
  for (const r of ca.current) {
    const f = ruleOf(r);
    if (f !== null && firstFailure === null) firstFailure = f;
    if (f === null && r.result === "pass" && deviceClassOf(r) === "real") proving.push(r);
  }
  for (const r of related) {
    const f = current.has(r.id) ? ruleOf(r) : null;
    const status: EvidenceStatus = !inScope(r)
      ? "out of scope (revision)"
      : superseded.has(r.id) || !current.has(r.id)
        ? "superseded"
        : f !== null
          ? `failed rule ${f.rule}`
          : deviceClassOf(r) !== "real"
            ? "not-counted (deviceClass)"
            : r.result === "pass" && proving.includes(r) ? "proving" : "current";
    rows.push({ child: child.ref, receipt: r.id, sha: r.sha, result: r.result, deviceClass: deviceClassOf(r), recordedAt: r.recordedAt, status, ...(f !== null ? { detail: f.detail } : {}) });
  }

  const base = { ref: child.ref, workClass: child.workClass, attempts: ca.outcome, ...(stale !== undefined ? { stale } : {}) };
  // 1. unproven before anything else.
  const pre: string[] = [];
  if (!child.eligibility.eligible) pre.push(`ineligible: ${child.eligibility.reason}`);
  if (child.refProblem !== undefined) pre.push(child.refProblem);
  if (repo === undefined) pre.push("repo unresolved");
  else if (repo.state !== "ok") pre.push(`${repo.state} repo: ${repo.reason}`);
  else {
    if (repo.facts.snapshot.status !== "ok") pre.push(`facts unknown: ${repo.facts.snapshot.reason}`);
    else if (repo.facts.commits === undefined) pre.push("facts unknown");
    if (repo.worktree === "unavailable") pre.push("worktree unavailable");
    else if (!cleanWorktree(repo.worktree)) pre.push("worktree dirty");
  }
  if (pre.length > 0) return { ...base, outcome: "unproven", reason: pre.join("; "), proving: [] };
  // 2. concurrent or failing.
  if (ca.outcome === "concurrent" || ca.outcome === "failing") return { ...base, outcome: "unproven", reason: ca.outcome, proving: [] };
  // 3. proven: a pass set, every current attempt satisfies the rules, and the proving set is not empty (A1).
  if (ca.outcome === "pass" && firstFailure === null && proving.length > 0) {
    return { ...base, outcome: "proven", proving: proving.map((r) => r.id) };
  }
  // 4. stale.
  if (stale !== undefined) return { ...base, outcome: "stale", reason: stale, proving: [] };
  // 5. unproven.
  const reason = ca.outcome === "none" ? "no current attempt" : firstFailure !== null ? `rule ${firstFailure.rule}: ${firstFailure.detail}` : "no real-device attempt";
  return { ...base, outcome: "unproven", reason, proving: [] };
}

/** The pure calculation (5.5, 5.6). The full calculation runs over every receipt; only the evidence is paged. */
export function computeProof(input: ProofInput, page = 1): ProofResult {
  const rows: EvidenceRow[] = [];
  const children = input.children.map((c) => proveChild(input, c, rows));
  let outcome: ProofOutcome;
  let reason: string | undefined;
  if (!input.unit.eligibility.eligible) { outcome = "unproven"; reason = `ineligible: ${input.unit.eligibility.reason}`; }
  else if (input.missing.length > 0) { outcome = "unproven"; reason = `missing ${input.missing.join(", ")}`; }
  else if (children.length === 0) { outcome = "unproven"; reason = "no children"; }
  else if (children.every((c) => c.outcome === "proven")) outcome = "proven";
  else {
    const blocking = children.find((c) => c.outcome === "unproven") ?? children.find((c) => c.outcome === "stale")!;
    outcome = blocking.outcome;
    reason = children.length === 1 ? blocking.reason : `${blocking.ref}: ${blocking.reason}`;
  }
  const position = (r: EvidenceRow): number => {
    const repo = input.repos.get(r.child.slice(0, r.child.lastIndexOf(":")));
    return repo?.state === "ok" && repo.facts.snapshot.status === "ok" ? repo.facts.snapshot.graph.position(r.sha) : -1;
  };
  rows.sort((a, b) => position(a) - position(b) || (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0) || (a.receipt < b.receipt ? -1 : a.receipt > b.receipt ? 1 : 0) || (a.child < b.child ? -1 : a.child > b.child ? 1 : 0));
  const pages = Math.max(1, Math.ceil(rows.length / PROOF_EVIDENCE_PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.floor(page)), pages);
  const provingIds = new Set(children.flatMap((c) => c.proving));
  const verifiedAt = outcome === "proven"
    ? input.receipts.filter((r) => provingIds.has(r.id)).reduce<string | null>((m, r) => (m === null || r.recordedAt > m ? r.recordedAt : m), null)
    : null;
  return {
    unit: input.unit.ref,
    outcome,
    ...(reason !== undefined ? { reason } : {}),
    children,
    evidence: rows.slice((p - 1) * PROOF_EVIDENCE_PAGE_SIZE, p * PROOF_EVIDENCE_PAGE_SIZE),
    evidenceTotal: rows.length,
    page: p,
    pages,
    verifiedAt,
  };
}

// --- gathering, the fingerprint and revalidation (5.6) ---

/** One resolved item, with the board it lives on. */
export interface ResolvedItem {
  readonly ref: string;
  readonly id: string;
  readonly boardId: string;
  readonly path: string;
  readonly state: ProjectState;
  readonly record: Record<string, unknown>;
  readonly kind: "ticket" | "issue";
}

/** Q3: a unit's children come from a projection. Journeys (T-572) will supply theirs; until then they are refused by name. */
export type UnitProjection = (unit: ResolvedItem) => { readonly children: readonly ResolvedItem[]; readonly missing: readonly string[]; readonly digest?: string };

/** An item unit is its own single child. */
export const itemProjection: UnitProjection = (unit) => ({ children: [unit], missing: [] });

/** Test seam: runs before each revalidating read. */
export const proofSeams: { beforeRevalidate: () => Promise<void> } = { beforeRevalidate: async () => {} };

const refuse = (message: string): never => {
  throw new ProjectLoaderError("invalid_input", message);
};

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

function rawDigest(path: string): string {
  try {
    return sha256(readFileSync(path));
  } catch {
    return "absent";
  }
}

/** The canonical refs `proof.nonCodeItems` lists in a board's config (5.4, pen ruling Q4). */
export function nonCodeRefs(config: unknown): Set<string> {
  const items = (config as { proof?: { nonCodeItems?: unknown } } | undefined)?.proof?.nonCodeItems;
  const out = new Set<string>();
  if (Array.isArray(items)) for (const e of items) if (e !== null && typeof e === "object" && typeof (e as { ref?: unknown }).ref === "string") out.add((e as { ref: string }).ref);
  return out;
}

/** A caller ref (`ID`, `<alias>:ID` or `<boardId>:ID`) to its board path and id. */
function boardOf(registry: readonly BoardEntry[], root: string, ownBoard: string, ref: string): { boardId: string; path: string; id: string; alias?: string } {
  const colon = ref.lastIndexOf(":");
  const prefix = colon > 0 ? ref.slice(0, colon) : undefined;
  const id = colon > 0 ? ref.slice(colon + 1) : ref;
  if (prefix === undefined || prefix === ownBoard) return { boardId: ownBoard, path: root, id };
  if (isBoardId(prefix)) {
    const r = resolveBoardRef(registry, prefix);
    if (r.state === "duplicate") return refuse(`proof_unresolved: ${ref}: board ${prefix} is carried by ${r.paths.join(", ")}.`);
    if (r.state === "unresolved") return refuse(`proof_unresolved: ${ref}: ${r.reason}.`);
    return { boardId: prefix, path: r.entry.path, id };
  }
  const r = resolveAlias(registry, prefix);
  if (r.state === "missing") return refuse(`board_id_missing: ${prefix} (${r.path}). Run \`storybloq board-id init\` in that board.`);
  if (r.state !== "ok") return refuse(`proof_unresolved: ${ref}: ${r.state === "unresolved" ? r.reason : "mismatched"}.`);
  return { boardId: r.entry.boardId, path: r.entry.path, id, alias: prefix };
}

async function resolveItem(registry: readonly BoardEntry[], root: string, ownBoard: string, ref: string, states: Map<string, ProjectState>): Promise<ResolvedItem & { alias?: string }> {
  const b = boardOf(registry, root, ownBoard, ref);
  let state = states.get(b.path);
  if (state === undefined) {
    state = (await loadProject(b.path)).state;
    states.set(b.path, state);
  }
  const found = findItem(state as unknown as StateWithRefs, b.id);
  if (found === "ambiguous") return refuse(`proof_unresolved: ${ref} matches more than one record.`);
  if (found === undefined) return refuse(`proof_unresolved: ${ref} is not a ticket or issue on board ${b.boardId}. Journey units are refused until journeys land (T-572).`);
  const id = String(found.record.id);
  return { ref: canonicalRef(b.boardId, id), id, boardId: b.boardId, path: b.path, state, record: found.record, kind: found.kind, ...(b.alias !== undefined ? { alias: b.alias } : {}) };
}

function okDeviceReceipts(record: Readonly<Record<string, unknown>>): Receipt[] {
  const read = readReceipts(record as Record<string, unknown>);
  if (read.state !== "ok") return [];
  return read.entries.flatMap((e) => (e.state === "ok" && e.receipt.kind === "device" ? [e.receipt] : []));
}

/** Q2: a receipt naming this unit or child under a stored boardId the ref no longer resolves to. */
function refProblemOf(registry: readonly BoardEntry[], unit: ResolvedItem, child: ResolvedItem, receipts: readonly Receipt[]): string | undefined {
  const classify = (stored: string, current: string): string => {
    const r = resolveBoardRef(registry, stored);
    return r.state === "unresolved" ? `unresolved repo: no registered board carries ${stored}` : `mismatched repo: a receipt names ${stored}, the ref now resolves to ${current}`;
  };
  for (const r of receipts) {
    const u = r.unitRef!;
    const colon = u.lastIndexOf(":");
    if (u.slice(colon + 1) === unit.id && u.slice(0, colon) !== unit.boardId) return classify(u.slice(0, colon), unit.boardId);
    const coversChild = r.covers !== undefined ? r.covers.some((c) => c.slice(c.lastIndexOf(":") + 1) === child.id) : child.ref === unit.ref;
    if (u === unit.ref && coversChild && r.repo !== child.boardId) return classify(r.repo, child.boardId);
  }
  return undefined;
}

interface Gathered {
  readonly input: ProofInput;
  readonly fingerprint: string;
}

async function gather(root: string, ref: string, projection: UnitProjection): Promise<Gathered> {
  const registry = boardRegistry(root);
  const ownBoard = readBoardId(root);
  if (ownBoard === undefined) return refuse("board_id_missing: this board has no boardId. Run `storybloq board-id init`, land it, then retry.");
  const states = new Map<string, ProjectState>();
  const unit = await resolveItem(registry, root, ownBoard, ref, states);
  const proj = projection(unit);
  const boards = new Map<string, string>([[unit.path, unit.boardId]]);
  for (const c of proj.children) boards.set(c.path, c.boardId);

  const allRecords = [unit, ...proj.children];
  const receipts = new Map<string, Receipt>();
  const onRecords = new Map<string, Receipt[]>();
  for (const item of allRecords) {
    const list = okDeviceReceipts(item.record);
    onRecords.set(item.ref, list);
    for (const r of list) if (r.unitRef === unit.ref && !receipts.has(r.id)) receipts.set(r.id, r);
  }
  const nearUnit = [...new Set(allRecords.flatMap((i) => onRecords.get(i.ref)!))];

  const repos = new Map<string, RepoPartition>();
  const partitionDigest: Record<string, unknown> = {};
  for (const [path, boardId] of boards) {
    if (repos.has(boardId)) continue;
    const r = resolveBoardRef(registry, boardId);
    if (r.state === "duplicate") {
      repos.set(boardId, { state: "duplicate", boardId, reason: `carried by ${r.paths.join(" and ")}` });
      partitionDigest[boardId] = { duplicate: r.paths };
      continue;
    }
    // Q6: each partition reads its own facts with its own board state; the refs digest is the snapshot key.
    const facts = await readGitFacts(path, states.get(path)!);
    const worktree = worktreeState(path);
    repos.set(boardId, { state: "ok", boardId, facts, worktree });
    partitionDigest[boardId] = { refs: facts.snapshot.status === "ok" ? facts.snapshot.key : `unknown:${facts.snapshot.reason}`, worktree: canonicalJson(worktree) };
  }

  const children: ProofChild[] = proj.children.map((c) => {
    const config = (states.get(c.path) as unknown as { config?: unknown } | undefined)?.config;
    const problem = refProblemOf(registry, unit, c, nearUnit);
    return {
      ref: c.ref,
      id: c.id,
      boardId: c.boardId,
      revision: recordRevision(c.record, c.kind),
      eligibility: eligibilityOf(c.record, c.kind),
      workClass: classifyWork(c.record, c.kind, c.ref, nonCodeRefs(config)),
      ...(problem !== undefined ? { refProblem: problem } : {}),
    };
  });

  const fileOf = (i: ResolvedItem): string => (i.kind === "ticket" ? ticketFilePath(i.path, i.id) : issueFilePath(i.path, i.id));
  const fingerprint = sha256(canonicalJson({
    records: Object.fromEntries(allRecords.map((i) => [i.ref, rawDigest(fileOf(i))])),
    configs: Object.fromEntries([...boards.keys()].map((p) => [p, rawDigest(join(p, ".story", "config.json"))])),
    aliases: registry.map((e) => [e.alias, e.path, e.boardId ?? null]),
    partitions: partitionDigest,
    projection: proj.digest ?? null,
  }));
  return {
    input: {
      unit: { ref: unit.ref, revision: recordRevision(unit.record, unit.kind), eligibility: eligibilityOf(unit.record, unit.kind) },
      children,
      missing: proj.missing,
      repos,
      receipts: [...receipts.values()],
    },
    fingerprint,
  };
}

/**
 * 5.6: computes, and before returning `proven` reads every input again. On a
 * difference it recomputes once; a second difference is `unproven (inputs moved)`.
 */
export async function proveRef(root: string, ref: string, opts: { page?: number; projection?: UnitProjection } = {}): Promise<ProofResult> {
  const projection = opts.projection ?? itemProjection;
  const page = opts.page ?? 1;
  const first = await gather(root, ref, projection);
  const result = computeProof(first.input, page);
  if (result.outcome !== "proven") return result;
  await proofSeams.beforeRevalidate();
  const second = await gather(root, ref, projection);
  if (second.fingerprint === first.fingerprint) return result;
  const again = computeProof(second.input, page);
  await proofSeams.beforeRevalidate();
  const third = await gather(root, ref, projection);
  if (third.fingerprint !== second.fingerprint) {
    return { ...again, outcome: "unproven", reason: "inputs moved", verifiedAt: null, recomputed: true };
  }
  return { ...again, recomputed: true };
}
