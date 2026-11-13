import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { boardRegistry, canonicalRef, checkBoardIdLanded, isBoardId, resolveAlias, resolveBoardRef } from "./board-id.js";
import { DEFAULT_HYGIENE_PATTERNS } from "./command-hygiene.js";
import { resolveDefaultBranch } from "./default-branch.js";
import { ProjectLoaderError } from "./errors.js";
import { loadProject } from "./project-loader.js";
import { appendReceipt, mintReceiptId, type ProjectStateLike } from "./receipt-append.js";
import { RECEIPT_BOUNDS, ReceiptSchema, receiptElementId } from "./receipts.js";
import { recordRevision } from "./record-revision.js";
import { worktreeState } from "./worktree-state.js";

/**
 * C-v4.1 section 3 (commit 3): the one handler behind `storybloq receipt add`
 * and `storybloq_receipt_add`. Both clients pass the same input here, so both
 * store the same record. Every caller field is validated (3.1, 3.2), the tool
 * fields are filled in, and the append runs through `appendReceipt` under
 * `RECEIPT_APPEND_AUTHORITY`. `supersedes` is checked under the append lock
 * against the record as reloaded from disk (7).
 */

/** The fields the tool writes; a caller value for any of them is refused by name (3.1). */
export const RECEIPT_TOOL_FIELDS = ["id", "v", "revisions", "observation", "recordedAt", "recordedBy"] as const;

/** The caller fields (3.1). Anything else is refused. `repo` is a registry alias; the stored repo is its boardId. */
const CALLER_FIELDS = new Set([
  "repo", "target", "kind", "unitRef", "covers", "sha", "base", "attestation", "supersedes", "result", "data", "command", "evidence",
]);

export interface ReceiptAddInput {
  readonly target: string;
  readonly kind: string;
  readonly sha: string;
  readonly result: string;
  readonly base?: string;
  readonly unitRef?: string;
  readonly covers?: readonly string[];
  readonly attestation?: { readonly builtFromSha: string; readonly builtClean: boolean };
  readonly supersedes?: readonly string[];
  readonly data?: Record<string, unknown>;
  readonly command?: string;
  readonly evidence?: string;
  /** A registry alias naming the repo the sha belongs to; omitted, the cwd board. */
  readonly repo?: string;
}

/** 2.1 and 2.4: a referenced board's id, landed on its default branch, or a refusal by name. */
export function landedBoardId(path: string): string {
  const branch = resolveDefaultBranch(path);
  if (branch === null) {
    return refuse(`default_branch_unresolved: the default branch of ${path} does not resolve (no origin/HEAD and no init.defaultBranch). Run \`git remote set-head origin --auto\` there, then retry.`);
  }
  const landed = checkBoardIdLanded(path, `origin/${branch}`);
  if (!landed.ok) return refuse(landed.message);
  return landed.boardId;
}

function defaultRecordedBy(): string {
  const id = process.env.STORYBLOQ_CLIENT === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID;
  return typeof id === "string" && id.length > 0 ? id : "unattributed";
}

/** Test seams: the id source, the clock, the recorder identity, and a hook between the caller's reads and the append lock. */
export const receiptAddSeams: { mintId: () => string; now: () => string; recordedBy: () => string; beforeLock: () => Promise<void> } = {
  mintId: mintReceiptId,
  now: () => new Date().toISOString(),
  recordedBy: defaultRecordedBy,
  beforeLock: async () => {},
};

const refuse = (message: string): never => {
  throw new ProjectLoaderError("invalid_input", `${message} Nothing was written.`);
};

function gitOut(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function gitOk(root: string, args: string[]): boolean {
  return gitOut(root, args) !== undefined;
}

/** A full object id in the repo's object format that names a commit here. */
function checkCommit(root: string, field: "sha" | "base", value: string): void {
  const format = gitOut(root, ["rev-parse", "--show-object-format"]) === "sha256" ? 64 : 40;
  if (!new RegExp(`^[0-9a-f]{${format}}$`).test(value)) {
    refuse(`invalid_${field}: ${field} ${JSON.stringify(value)} is not a full ${format}-character object id.`);
  }
  if (!gitOk(root, ["cat-file", "-e", `${value}^{commit}`])) {
    refuse(`invalid_${field}: ${field} ${value} is not a commit in this repository.`);
  }
}

/** 3.1 evidence: a normalised repo-relative path with no `..` whose symlink stays inside the repo, or a sha256. */
function checkEvidence(repoTop: string, evidence: string): void {
  if (/^[0-9a-f]{64}$/.test(evidence)) return;
  if (isAbsolute(evidence) || evidence.includes("\\")) refuse(`invalid_evidence: evidence ${JSON.stringify(evidence)} is not a repo-relative path or a sha256.`);
  if (evidence.split("/").includes("..")) refuse(`invalid_evidence: evidence ${JSON.stringify(evidence)} has a .. segment.`);
  if (posix.normalize(evidence) !== evidence) refuse(`invalid_evidence: evidence ${JSON.stringify(evidence)} is not normalised (${posix.normalize(evidence)}).`);
  const full = join(repoTop, evidence);
  let isLink = false;
  try { isLink = lstatSync(full).isSymbolicLink(); } catch { /* an absent path is a plain reference */ }
  if (!isLink) return;
  let target: string;
  try { target = realpathSync(full); } catch { return refuse(`invalid_evidence: evidence ${evidence} is a symlink that does not resolve.`); }
  const rel = relative(realpathSync(repoTop), target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    refuse(`invalid_evidence: evidence ${evidence} is a symlink that resolves outside the repository.`);
  }
}

/** A supersedes id named twice is refused; the schema bounds the count. */
function checkSupersedesShape(supersedes: readonly string[] | undefined): void {
  if (!supersedes) return;
  const seen = new Set<string>();
  for (const id of supersedes) {
    if (seen.has(id)) refuse(`invalid_supersedes: supersedes names ${id} twice.`);
    seen.add(id);
  }
}

interface ResolvedRef {
  readonly ref: string;
  readonly boardId: string;
  readonly record: Record<string, unknown>;
  readonly kind: "ticket" | "issue";
}

type StateWithRefs = ProjectStateLike & {
  resolveTicketRef(ref: string): { kind: string; item?: { id: string } };
  resolveIssueRef(ref: string): { kind: string; item?: { id: string } };
};

function findItem(state: StateWithRefs, id: string): { record: Record<string, unknown>; kind: "ticket" | "issue" } | "ambiguous" | undefined {
  const t = state.resolveTicketRef(id);
  if (t.kind === "ambiguous") return "ambiguous";
  if (t.kind === "found") return { record: t.item as unknown as Record<string, unknown>, kind: "ticket" };
  const i = state.resolveIssueRef(id);
  if (i.kind === "ambiguous") return "ambiguous";
  if (i.kind === "found") return { record: i.item as unknown as Record<string, unknown>, kind: "issue" };
  return undefined;
}

/**
 * A caller ref (`ID`, `<alias>:ID` or `<boardId>:ID`) to its board and record.
 * This board's records come from the state reloaded under the append lock.
 */
async function resolveItemRef(
  root: string, ownBoard: string, state: StateWithRefs, field: string, ref: string,
): Promise<ResolvedRef> {
  const colon = ref.lastIndexOf(":");
  const prefix = colon > 0 ? ref.slice(0, colon) : undefined;
  const id = colon > 0 ? ref.slice(colon + 1) : ref;
  let boardId = ownBoard;
  let boardPath: string | undefined;
  if (prefix !== undefined && prefix !== ownBoard) {
    const registry = boardRegistry(root);
    if (isBoardId(prefix)) {
      const r = resolveBoardRef(registry, prefix);
      if (r.state !== "ok") refuse(`${field}_unresolved: ${ref}: ${r.state === "duplicate" ? `board ${prefix} is carried by ${r.paths.join(", ")}` : r.reason}.`);
      else { boardId = prefix; boardPath = r.entry.path; }
    } else {
      const r = resolveAlias(registry, prefix);
      if (r.state === "missing") refuse(`board_id_missing: ${prefix} (${r.path}). Run \`storybloq board-id init\` in that board, land it, then retry.`);
      else if (r.state !== "ok") refuse(`${field}_unresolved: ${ref}: ${r.state === "unresolved" ? r.reason : "mismatched"}.`);
      else if (r.entry.boardId !== ownBoard) { boardId = r.entry.boardId; boardPath = r.entry.path; }
    }
  }
  // 2.4: every referenced board carries a landed board id.
  if (boardPath !== undefined && landedBoardId(boardPath) !== boardId) {
    refuse(`${field}_unresolved: ${ref}: the board at ${boardPath} has not landed ${boardId}.`);
  }
  let found: ReturnType<typeof findItem>;
  if (boardPath === undefined) found = findItem(state, id);
  else {
    try {
      const { state: other } = await loadProject(boardPath);
      found = findItem(other as unknown as StateWithRefs, id);
    } catch (e) {
      return refuse(`${field}_unresolved: ${ref}: the board at ${boardPath} could not be read (${e instanceof Error ? e.message : String(e)}).`);
    }
  }
  if (found === "ambiguous") refuse(`${field}_unresolved: ${ref} matches more than one record.`);
  if (found === undefined) {
    refuse(`${field}_unresolved: ${ref} is not a ticket or issue on board ${boardId}. Journey units are refused until journeys land (T-572).`);
  }
  const hit = found as { record: Record<string, unknown>; kind: "ticket" | "issue" };
  return { ref: canonicalRef(boardId, String(hit.record.id)), boardId, record: hit.record, kind: hit.kind };
}

function revisionOf(r: ResolvedRef, field: string): string {
  try {
    return recordRevision(r.record, r.kind);
  } catch (e) {
    return refuse(`${field}_unreadable: ${r.ref} could not be read for its revision (${e instanceof Error ? e.message : String(e)}).`);
  }
}

/** Q5: each supersedes id must name a receipt on this record with the same kind, read under the lock. */
function checkSupersedesOnRecord(record: Readonly<Record<string, unknown>>, kind: string, supersedes: readonly string[] | undefined, newId: string): void {
  if (!supersedes || supersedes.length === 0) return;
  const receipts = Array.isArray(record.receipts) ? record.receipts : [];
  for (const id of supersedes) {
    if (id === newId) refuse(`supersedes_unknown: ${id} is the id of the receipt being added.`);
    const named = receipts.filter((e) => receiptElementId(e) === id && typeof (e as { kind?: unknown }).kind === "string");
    if (named.length === 0) refuse(`supersedes_unknown: ${id} not found among the receipts on this record.`);
    if (!named.some((e) => (e as { kind: string }).kind === kind)) {
      refuse(`supersedes_unknown: ${id} was found with kind ${(named[0] as { kind: string }).kind}, not ${kind}.`);
    }
  }
}

/** Validates the caller input, resolves every ref and appends one receipt. Returns the stored receipt. */
export async function addReceipt(root: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (const f of RECEIPT_TOOL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, f)) refuse(`tool_field: ${f} is written by the tool, never by the caller.`);
  }
  for (const f of Object.keys(raw)) {
    if (!CALLER_FIELDS.has(f)) refuse(`unknown_field: ${f} is not a receipt field.`);
  }
  const input = raw as unknown as ReceiptAddInput;
  if (input.kind === "landing") refuse("landing_refused: landing receipts are written only by `storybloq land` (3.5).");
  if (typeof input.target !== "string" || input.target.length === 0) refuse("invalid_target: target names the ticket or issue the receipt sits on.");

  // Shape, bounds, per-kind data and contradictions (3.1, 3.2), with placeholder tool fields.
  const callerPart: Record<string, unknown> = {};
  for (const f of CALLER_FIELDS) if (f !== "target" && f !== "repo" && raw[f] !== undefined) callerPart[f] = raw[f];
  const probe = ReceiptSchema.safeParse({
    ...callerPart, id: "rc-0000000000000000", v: 1, target: "x", repo: "x", revisions: {},
    observation: { head: null, headMatchesSha: false, worktree: "unavailable" }, recordedAt: "x", recordedBy: "x",
  });
  if (!probe.success) {
    const issue = probe.error.issues[0]!;
    refuse(`invalid_receipt: ${issue.path.join(".") || "receipt"}: ${issue.message}.`);
  }
  checkSupersedesShape(input.supersedes);
  if (input.command !== undefined) {
    for (const p of DEFAULT_HYGIENE_PATTERNS) {
      if (p.test(input.command)) refuse(`command_hygiene: command holds a ${p.name}; record it without one.`);
    }
  }

  // The repo the sha belongs to (3.1): the cwd board, or the board a registry alias names.
  let repoRoot = root;
  if (input.repo !== undefined) {
    if (typeof input.repo !== "string" || input.repo.length === 0) refuse("invalid_repo: repo is a registry alias.");
    const r = resolveAlias(boardRegistry(root), input.repo);
    if (r.state === "missing") refuse(`board_id_missing: ${input.repo} (${r.path}). Run \`storybloq board-id init\` in that board, land it, then retry.`);
    else if (r.state !== "ok") refuse(`repo_unresolved: ${input.repo}: ${r.state === "unresolved" ? r.reason : "mismatched"}.`);
    else repoRoot = r.entry.path;
  }

  // Git facts (3.1), read in the repo: full commit ids, the review range, evidence.
  const top = gitOut(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (top === undefined) refuse("not_a_repo: receipts are recorded inside a git repository.");
  checkCommit(repoRoot, "sha", input.sha);
  if (input.base !== undefined) {
    checkCommit(repoRoot, "base", input.base);
    if (!gitOk(repoRoot, ["merge-base", "--is-ancestor", input.base, input.sha])) {
      refuse(`invalid_base: base ${input.base} is not an ancestor of ${input.sha}.`);
    }
  }
  if (input.evidence !== undefined) checkEvidence(top!, input.evidence);
  if (input.covers && input.covers.length > RECEIPT_BOUNDS.covers) refuse(`invalid_receipt: covers: at most ${RECEIPT_BOUNDS.covers} refs.`);

  // Board identity (2.1, 2.4): the target board and the repo board each have a landed id.
  const ownBoard = landedBoardId(root);
  const repo = repoRoot === root ? ownBoard : landedBoardId(repoRoot);

  // The target, resolved before the lock to its canonical id; the record itself is reloaded under the lock.
  const { state: outer } = await loadProject(root);
  const pre = findItem(outer as unknown as StateWithRefs, input.target);
  if (pre === "ambiguous") refuse(`invalid_target: ${input.target} matches more than one record.`);
  if (pre === undefined) refuse(`invalid_target: ${input.target} is not a ticket or issue on this board.`);
  const targetHit = pre as { record: Record<string, unknown>; kind: "ticket" | "issue" };
  const targetId = String(targetHit.record.id);

  const head = gitOut(repoRoot, ["rev-parse", "HEAD"]) ?? null;
  const worktree = worktreeState(repoRoot);
  const recordedAt = receiptAddSeams.now();
  const recordedBy = receiptAddSeams.recordedBy();

  // Refs on other boards resolve outside the lock (their own reads); this board's resolve inside it.
  const preparedRefs = new Map<string, ResolvedRef>();
  const refsToResolve: Array<[string, string]> = [];
  if (input.unitRef !== undefined) refsToResolve.push(["unit", input.unitRef]);
  for (const c of input.covers ?? []) refsToResolve.push(["covers", c]);

  const resolveAll = async (state: StateWithRefs): Promise<void> => {
    for (const [field, ref] of refsToResolve) {
      if (preparedRefs.has(`${field}\u0000${ref}`)) continue;
      const r = await resolveItemRef(root, ownBoard, state, field, ref);
      if (field === "covers" && r.boardId !== repo) refuse(`covers_other_repo: ${ref} belongs to board ${r.boardId}, not ${repo}.`);
      preparedRefs.set(`${field}\u0000${ref}`, r);
    }
  };
  // Async resolution cannot run inside the synchronous build callback, so it runs first against the
  // outer state; same-board refs are then re-read from the locked state inside build.
  await resolveAll(outer as unknown as StateWithRefs);

  await receiptAddSeams.beforeLock();
  return appendReceipt(root, { kind: targetHit.kind, id: targetId }, (id, record, state) => {
    checkSupersedesOnRecord(record, input.kind, input.supersedes, id);
    const s = state as StateWithRefs;
    const fresh = (r: ResolvedRef, field: string): ResolvedRef => {
      if (r.boardId !== ownBoard) return r;
      const again = findItem(s, String(r.record.id));
      if (again === undefined || again === "ambiguous") refuse(`${field}_unreadable: ${r.ref} could not be reloaded under the lock.`);
      const hit = again as { record: Record<string, unknown>; kind: "ticket" | "issue" };
      return { ...r, record: hit.record, kind: hit.kind };
    };
    const target = canonicalRef(ownBoard, targetId);
    const revisions: Record<string, string> = {};
    let unitRef: string | undefined;
    if (input.unitRef !== undefined) {
      const u = fresh(preparedRefs.get(`unit\u0000${input.unitRef}`)!, "unit");
      unitRef = u.ref;
      revisions[u.ref] = revisionOf(u, "unit");
    } else {
      revisions[target] = revisionOf({ ref: target, boardId: ownBoard, record: record as Record<string, unknown>, kind: targetHit.kind }, "target");
    }
    let covers: string[] | undefined;
    if (input.covers !== undefined) {
      covers = [];
      for (const c of input.covers) {
        const r = fresh(preparedRefs.get(`covers\u0000${c}`)!, "covers");
        if (covers.includes(r.ref)) refuse(`invalid_covers: covers names ${r.ref} twice.`);
        covers.push(r.ref);
        revisions[r.ref] = revisionOf(r, "covers");
      }
    }
    return {
      id, v: 1, kind: input.kind, target,
      ...(unitRef !== undefined ? { unitRef } : {}),
      ...(covers !== undefined ? { covers } : {}),
      repo, sha: input.sha,
      ...(input.base !== undefined ? { base: input.base } : {}),
      revisions,
      observation: { head, headMatchesSha: head === input.sha, worktree },
      ...(input.attestation !== undefined ? { attestation: input.attestation } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      result: input.result,
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      recordedAt, recordedBy,
    };
  }, { mintId: receiptAddSeams.mintId });
}

