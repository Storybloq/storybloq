/**
 * T-527 (plan 3.6): verifying a knowledge-impact report against git.
 *
 * The KNOWLEDGE_REVIEW stage asks the agent what the shipped item did to the
 * project's knowledge (capabilities, terms, notes, rulings) and requires the
 * answer to be backed by the ledger's own history. Everything here reads
 * commits, never the working tree, except rule (c), whose whole job is to
 * say the working tree's `.story/` has nothing uncommitted.
 *
 * The order is fixed, and each step only runs once the steps before it hold:
 *
 *   preflight  the implementation commit and the checkpoint resolve and are
 *              on HEAD's history (else `knowledge_diverged`); ranges are only
 *              evaluated after that, so `A..B` never means something odd
 *   (a)        every commit after the checkpoint is ledger-only
 *   (b)        every listed maintenance commit resolves, descends from the
 *              implementation commit, is on HEAD's history, is ledger-only,
 *              and the list is ordered by ancestry
 *   (c)        the working tree's `.story/` equals HEAD's
 *   (e)        an unchanged `.story/` tree allows no impacts and no
 *              maintenance commits
 *   table      every (record, kind, disposition) is a row, with the row's
 *              evidence at HEAD against the baseline at the implementation
 *              commit
 *   (d)        provenance: each target's projection changes only in listed
 *              commits after its restart point, and every change inside a
 *              listed commit is explained by the report
 *   (f)        `confirmHead`, called by the stage immediately before it
 *              persists: HEAD must not have moved
 *
 * A refusal is a retry for the agent, never a verdict about the code. Pure
 * over its git and snapshot readers, which tests replace.
 */

import { readLedgerSnapshot, CAPABILITIES_PATH, GLOSSARY_PATH, type LedgerSnapshot } from "../core/ledger-snapshot.js";
import { ABSENT, catalogEntryAt, projectionOf, RestoreInputError, type Side } from "../core/ledger-restore.js";
import { checkCapabilities } from "../core/capability.js";
import { catalogConflictScope } from "../core/catalog-conflicts.js";
import { buildTermReferenceIndexFromSnapshot, checkTerms } from "../core/glossary.js";
import { isEffectivelyAccepted } from "../core/ruling-lifecycle.js";
import { sanitizeDisplayText } from "../core/display-text.js";
import { hasPendingNote, type Capability } from "../models/capability.js";
import type { Term } from "../models/glossary.js";
import { capabilitySemanticDigest, termSemanticDigest } from "./context-brief.js";
import {
  gitCommitPaths,
  gitFirstParent,
  gitHeadHash,
  gitIsAncestor,
  gitResolveCommit,
  gitRevList,
  gitStoryDirty,
  gitStoryTree,
} from "./git-inspector.js";
import type { GitResult, KnowledgeImpact, KnowledgeImpactItem } from "./session-types.js";

// --- seams ---

/** The git reads verification needs. `realKnowledgeGit` is the production one. */
export interface KnowledgeGit {
  resolve(oid: string): Promise<GitResult<string>>;
  isAncestor(ancestor: string, descendant: string): Promise<GitResult<boolean>>;
  revList(from: string, to: string, firstParent: boolean): Promise<GitResult<string[]>>;
  /** Merge commits on the first-parent chain `from..to`. */
  firstParentMerges(from: string, to: string): Promise<GitResult<string[]>>;
  commitPaths(commit: string): Promise<GitResult<string[]>>;
  firstParent(commit: string): Promise<GitResult<string | null>>;
  storyDirty(): Promise<GitResult<boolean>>;
  storyTree(commit: string): Promise<GitResult<string | null>>;
  head(): Promise<GitResult<string>>;
}

export function realKnowledgeGit(root: string): KnowledgeGit {
  return {
    resolve: (oid) => gitResolveCommit(root, oid),
    isAncestor: (a, d) => gitIsAncestor(root, a, d),
    revList: (from, to, firstParent) => gitRevList(root, from, to, { firstParent }),
    firstParentMerges: (from, to) => gitRevList(root, from, to, { firstParent: true, mergesOnly: true }),
    commitPaths: (c) => gitCommitPaths(root, c),
    firstParent: (c) => gitFirstParent(root, c),
    storyDirty: () => gitStoryDirty(root),
    storyTree: (c) => gitStoryTree(root, c),
    head: () => gitHeadHash(root),
  };
}

export interface KnowledgeVerifyDeps {
  readonly git: KnowledgeGit;
  /** Test seam: the snapshot reader. Defaults to `readLedgerSnapshot(root, oid)`. */
  readonly snapshot?: (oid: string) => Promise<LedgerSnapshot>;
}

/** The part of `state.knowledgeReview` verification reads. */
export interface KnowledgeReviewRef {
  readonly itemId: string;
  readonly implementationCommit: string;
  readonly checkpoint: string;
}

export interface KnowledgeRefusal {
  readonly ok: false;
  /** `knowledge_diverged`: the recorded commits are not on HEAD's history. Everything else is `knowledge_refused`. */
  readonly condition: "knowledge_diverged" | "knowledge_refused";
  readonly message: string;
}

export interface ExternalMaintenance {
  readonly id: string;
  readonly commit: string;
}

export interface KnowledgeVerified {
  readonly ok: true;
  /** HEAD as captured at the start; the stage re-reads it before persisting (rule f). */
  readonly head: string;
  /** The listed maintenance commits as full ids, in the reported order. */
  readonly maintenanceCommits: readonly string[];
  /** Record changes in commits this session did not list: recorded, never required. */
  readonly externalMaintenance: readonly ExternalMaintenance[];
}

export const DIVERGED_MESSAGE =
  "verified implementation commit is not on HEAD's history; return to that history or cancel the session";

function refused(message: string): KnowledgeRefusal {
  return { ok: false, condition: "knowledge_refused", message };
}
function diverged(detail: string): KnowledgeRefusal {
  return { ok: false, condition: "knowledge_diverged", message: `${DIVERGED_MESSAGE} (${detail})` };
}
function short(oid: string): string {
  return oid.slice(0, 12);
}
function isLedgerPath(path: string): boolean {
  return path.startsWith(".story/");
}

// --- preflight and rules (a) to (c), (f) ---

/**
 * Both recorded commits must resolve and be HEAD or an ancestor of it. A
 * failure is `knowledge_diverged` (a branch reset, a rebase, a checkout
 * elsewhere), never a reason to redefine the baseline. A git error that is not
 * an answer is a plain refusal: it proves nothing either way.
 */
export async function preflight(git: KnowledgeGit, review: KnowledgeReviewRef, head: string): Promise<KnowledgeRefusal | null> {
  const recorded: readonly [string, string][] = [
    ["implementation commit", review.implementationCommit],
    ["checkpoint", review.checkpoint],
  ];
  for (const [label, oid] of recorded) {
    const resolved = await git.resolve(oid);
    if (!resolved.ok) return diverged(`the ${label} ${short(oid)} does not resolve`);
    const onHistory = await git.isAncestor(resolved.data, head);
    if (!onHistory.ok) return refused(`git could not say whether the ${label} ${short(oid)} is on HEAD's history: ${sanitizeDisplayText(onHistory.message, 200)}`);
    if (!onHistory.data) return diverged(`the ${label} ${short(oid)} is not an ancestor of HEAD ${short(head)}`);
  }
  return null;
}

/**
 * The commits in `from..to` that change a path outside `.story/`. Every commit
 * reachable is listed, side branches included, and each is diffed against its
 * first parent, so code that arrives through a merge is caught at the merge.
 */
export async function codeCommitsIn(git: KnowledgeGit, from: string, to: string): Promise<GitResult<{ commit: string; path: string }[]>> {
  const commits = await git.revList(from, to, false);
  if (!commits.ok) return commits;
  const found: { commit: string; path: string }[] = [];
  for (const commit of commits.data) {
    const paths = await git.commitPaths(commit);
    if (!paths.ok) return paths;
    const code = paths.data.find((p) => !isLedgerPath(p));
    if (code !== undefined) found.push({ commit, path: code });
  }
  return { ok: true, data: found };
}

/** Rule (a): nothing but ledger commits after the checkpoint. */
export async function ruleCodeAfterCheckpoint(git: KnowledgeGit, checkpoint: string, head: string): Promise<KnowledgeRefusal | null> {
  const code = await codeCommitsIn(git, checkpoint, head);
  if (!code.ok) return refused(`git could not list the commits after the checkpoint: ${sanitizeDisplayText(code.message, 200)}`);
  const first = code.data[0];
  if (first === undefined) return null;
  return refused(
    `code committed after the checkpoint (${short(first.commit)} changes ${sanitizeDisplayText(first.path, 120)}); report knowledge_rebase first`,
  );
}

/**
 * Rule (b). Returns the full ids in the reported order. A listed commit that
 * is the implementation commit itself, off HEAD's history, mixed with code,
 * or out of ancestry order is refused by name.
 */
export async function ruleMaintenanceCommits(
  git: KnowledgeGit,
  implementationCommit: string,
  head: string,
  listed: readonly string[],
): Promise<KnowledgeRefusal | { ok: true; commits: string[] }> {
  const commits: string[] = [];
  for (const oid of listed) {
    const resolved = await git.resolve(oid);
    if (!resolved.ok) return refused(`maintenance commit ${short(oid)} does not resolve`);
    const commit = resolved.data;
    if (commit === implementationCommit) return refused(`maintenance commit ${short(oid)} is the implementation commit itself`);
    const descends = await git.isAncestor(implementationCommit, commit);
    if (!descends.ok) return refused(`git could not place maintenance commit ${short(oid)}: ${sanitizeDisplayText(descends.message, 200)}`);
    if (!descends.data) return refused(`maintenance commit ${short(oid)} does not descend from the implementation commit`);
    const onHead = await git.isAncestor(commit, head);
    if (!onHead.ok) return refused(`git could not place maintenance commit ${short(oid)}: ${sanitizeDisplayText(onHead.message, 200)}`);
    if (!onHead.data) return refused(`maintenance commit ${short(oid)} is not on HEAD's history`);
    const paths = await git.commitPaths(commit);
    if (!paths.ok) return refused(`git could not list maintenance commit ${short(oid)}: ${sanitizeDisplayText(paths.message, 200)}`);
    const code = paths.data.find((p) => !isLedgerPath(p));
    if (code !== undefined) {
      return refused(
        `maintenance commit ${short(oid)} is not ledger-only: it changes ${sanitizeDisplayText(code, 120)}; recover the record with capability restore, term restore or ledger restore in a ledger-only commit and list that instead`,
      );
    }
    const previous = commits[commits.length - 1];
    if (previous !== undefined) {
      const ordered = previous !== commit ? await git.isAncestor(previous, commit) : ({ ok: true, data: false } as const);
      if (!ordered.ok) return refused(`git could not order maintenance commits: ${sanitizeDisplayText(ordered.message, 200)}`);
      if (!ordered.data) return refused(`maintenance commits are not ordered by ancestry: ${short(oid)} does not follow ${short(previous)}`);
    }
    commits.push(commit);
  }
  return { ok: true, commits };
}

/** Rule (c): the working tree's `.story/` has nothing uncommitted. */
export async function ruleCleanLedger(git: KnowledgeGit): Promise<KnowledgeRefusal | null> {
  const dirty = await git.storyDirty();
  if (!dirty.ok) return refused(`git could not read the working tree's .story/ status: ${sanitizeDisplayText(dirty.message, 200)}`);
  return dirty.data ? refused("uncommitted ledger changes under .story/; commit them in a ledger-only commit and list it in maintenanceCommits") : null;
}

/** Rule (f): HEAD is unchanged since `head` was captured. */
export async function confirmHead(git: KnowledgeGit, head: string): Promise<KnowledgeRefusal | null> {
  const now = await git.head();
  if (!now.ok) return refused(`git could not re-read HEAD: ${sanitizeDisplayText(now.message, 200)}`);
  return now.data === head ? null : refused(`HEAD moved from ${short(head)} to ${short(now.data)} during verification; report again`);
}

// --- knowledge_rebase ---

/**
 * `knowledge_rebase`: after the preflight, `checkpoint..head` must hold at
 * least one commit that is not ledger-only. The caller then sets the
 * checkpoint to `head`; the implementation commit, and so the baseline, never
 * move.
 */
export async function verifyKnowledgeRebase(git: KnowledgeGit, review: KnowledgeReviewRef): Promise<KnowledgeRefusal | { ok: true; head: string }> {
  const head = await git.head();
  if (!head.ok) return refused(`git could not read HEAD: ${sanitizeDisplayText(head.message, 200)}`);
  const pre = await preflight(git, review, head.data);
  if (pre !== null) return pre;
  const code = await codeCommitsIn(git, review.checkpoint, head.data);
  if (!code.ok) return refused(`git could not list the commits after the checkpoint: ${sanitizeDisplayText(code.message, 200)}`);
  if (code.data.length === 0) return refused("nothing to rebase: every commit after the checkpoint is ledger-only");
  return { ok: true, head: head.data };
}

// --- projections ---

type Family = "capability" | "term" | "notes" | "rulings" | "issues";
type EntryFamily = "capability" | "term";

/** A projection target: a catalog entry (whole, or only its marker fields) or a single-record file. */
type Target =
  | { readonly kind: "entry"; readonly family: EntryFamily; readonly id: string; readonly part: "record" | "marker" }
  | { readonly kind: "file"; readonly family: "notes" | "rulings" | "issues"; readonly id: string };

/** Fields a stamp (`capability check --stamp`) or a marker (`defer`, `--clear-pending`) may change. */
const STAMP_OR_MARKER_FIELDS: Readonly<Record<EntryFamily, readonly string[]>> = {
  capability: ["checkedAt", "status", "pendingNote"],
  term: ["pendingNote", "updatedAt"],
};

class LedgerUnavailable extends Error {}

function targetLabel(t: Target): string {
  return t.kind === "entry" ? `${t.id}${t.part === "marker" ? " (marker)" : ""}` : t.id;
}

function touches(t: Target, paths: readonly string[]): boolean {
  if (t.kind === "entry") {
    const file = t.family === "capability" ? CAPABILITIES_PATH : GLOSSARY_PATH;
    return paths.includes(file);
  }
  const dir = `.story/${t.family}/`;
  return paths.some((p) => p.startsWith(dir));
}

/** The marker projection's value: stored `status` and `pendingNote`, only the keys that are set. */
function markerOf(entry: { status?: unknown; pendingNote?: unknown }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (entry.status !== undefined) out.status = entry.status;
  if (entry.pendingNote !== undefined) out.pendingNote = entry.pendingNote;
  return out;
}

function entryAt<T extends { id: string }>(snapshot: LedgerSnapshot, family: EntryFamily, id: string): Side<T> {
  try {
    return catalogEntryAt<T>(snapshot, family, id, "ledger");
  } catch (err) {
    if (err instanceof RestoreInputError) throw new LedgerUnavailable(err.message);
    throw err;
  }
}

interface FileRecord {
  readonly id: string;
  readonly displayId?: string;
}

/**
 * A single-record file by id or display id. When the record is not among the
 * parsed ones and any file of the family could not be read, the answer is
 * unavailable: the unreadable file may be this record.
 */
function fileRecordAt(snapshot: LedgerSnapshot, family: "notes" | "rulings" | "issues", id: string): Side<FileRecord> {
  const read = snapshot[family]();
  if (!read.available) throw new LedgerUnavailable(`ledger unavailable at ${short(snapshot.oid)}`);
  const found = (read.records as readonly FileRecord[]).find((r) => r.id === id || r.displayId === id);
  if (found !== undefined) return { present: true, value: found };
  const bad = read.unreadable[0];
  if (bad !== undefined) {
    throw new LedgerUnavailable(`${sanitizeDisplayText(bad.path, 120)} at ${short(snapshot.oid)} could not be read (${sanitizeDisplayText(bad.reason, 160)})`);
  }
  return ABSENT;
}

function projectionAt(snapshot: LedgerSnapshot, t: Target): string | null {
  if (t.kind === "file") return projectionOf(fileRecordAt(snapshot, t.family, t.id));
  const side = entryAt<{ id: string; status?: unknown; pendingNote?: unknown }>(snapshot, t.family, t.id);
  if (!side.present || t.part === "record") return projectionOf(side);
  return projectionOf({ present: true, value: markerOf(side.value) });
}

// --- the history walk ---

/**
 * History from the implementation commit to HEAD along the first parent,
 * with each commit's changed paths and snapshots read once and cached.
 * `chain[0]` is the implementation commit itself.
 */
class History {
  private readonly snaps = new Map<string, Promise<LedgerSnapshot>>();

  constructor(
    readonly chain: readonly string[],
    private readonly paths: ReadonlyMap<string, readonly string[]>,
    private readonly read: (oid: string) => Promise<LedgerSnapshot>,
    readonly listed: ReadonlySet<string>,
    readonly merges: ReadonlySet<string>,
  ) {}

  pathsAt(i: number): readonly string[] {
    return this.paths.get(this.chain[i]!) ?? [];
  }

  async snapshot(oid: string): Promise<LedgerSnapshot> {
    let pending = this.snaps.get(oid);
    if (pending === undefined) {
      pending = this.read(oid);
      this.snaps.set(oid, pending);
    }
    const snap = await pending;
    if (snap.availability.kind !== "ok") throw new LedgerUnavailable(`ledger unavailable at ${short(oid)}: ${snap.availability.reason}`);
    return snap;
  }

  /** The target's projection at every chain index, re-read only at commits that touch its file. */
  async series(t: Target): Promise<(string | null)[]> {
    const values: (string | null)[] = [projectionAt(await this.snapshot(this.chain[0]!), t)];
    for (let i = 1; i < this.chain.length; i++) {
      values.push(touches(t, this.pathsAt(i)) ? projectionAt(await this.snapshot(this.chain[i]!), t) : values[i - 1]!);
    }
    return values;
  }
}

/**
 * The provenance rule over one projection series, from index `start` whose
 * value is the baseline. The restart point is the last index at which the
 * projection equals the baseline; every change after it must be inside a
 * listed commit, and the projection at HEAD must differ from the baseline.
 */
export function provenanceViolation(
  values: readonly (string | null)[],
  chain: readonly string[],
  listed: ReadonlySet<string>,
  start = 0,
): { kind: "unlisted"; commit: string } | { kind: "unchanged" } | null {
  const baseline = values[start];
  let restart = start;
  for (let i = start; i < values.length; i++) if (values[i] === baseline) restart = i;
  for (let i = restart + 1; i < values.length; i++) {
    if (values[i] !== values[i - 1] && !listed.has(chain[i]!)) return { kind: "unlisted", commit: chain[i]! };
  }
  return values[values.length - 1] === baseline ? { kind: "unchanged" } : null;
}

function provenanceMessage(h: History, t: Target, v: NonNullable<ReturnType<typeof provenanceViolation>>): string {
  if (v.kind === "unlisted" && h.merges.has(v.commit)) {
    return `${targetLabel(t)} changed in merge ${v.commit.slice(0, 8)}, which is not listed; list the merge commit if it is ledger-only`;
  }
  return v.kind === "unlisted"
    ? `${targetLabel(t)} changed outside a listed maintenance commit (at ${short(v.commit)})`
    : `${targetLabel(t)} is unchanged since the baseline; an impact needs its change committed in a listed maintenance commit`;
}

async function checkProvenance(h: History, t: Target): Promise<string | null> {
  const v = provenanceViolation(await h.series(t), h.chain, h.listed);
  return v === null ? null : provenanceMessage(h, t, v);
}

/**
 * A pending marker on an entry absent at the baseline. When the entry was
 * created in an unlisted commit its creation is not attributable: the walk
 * starts at the creation commit with the marker as it was created (never a
 * synthetic null), and the creation is recorded as external maintenance.
 */
async function checkMarkerProvenance(h: History, t: Target & { kind: "entry" }, external: ExternalMaintenance[]): Promise<string | null> {
  const record = await h.series({ ...t, part: "record" });
  const marker = await h.series(t);
  let created = -1;
  for (let i = 1; i < record.length; i++) if (record[i] !== null && record[i - 1] === null) created = i;
  if (record[0] !== null || created === -1 || h.listed.has(h.chain[created]!)) {
    const v = provenanceViolation(marker, h.chain, h.listed);
    return v === null ? null : provenanceMessage(h, t, v);
  }
  external.push({ id: t.id, commit: h.chain[created]! });
  const v = provenanceViolation(marker, h.chain, h.listed, created);
  return v === null ? null : provenanceMessage(h, t, v);
}

// --- the table ---

function familyOf(record: string): Family {
  if (record.startsWith("cap-")) return "capability";
  if (record.startsWith("term-")) return "term";
  if (record.startsWith("r-")) return "rulings";
  return "notes";
}

const TABLE: Readonly<Record<string, readonly string[]>> = {
  "capability:stale-reference": ["applied", "pending"],
  "capability:capability-changed": ["applied", "pending"],
  "capability:capability-added": ["applied", "pending"],
  "capability:capability-removed": ["pending"],
  "term:term-drift": ["applied", "pending"],
  "notes:stale-reference": ["applied", "pending"],
  "rulings:ruling-conflict": ["needs-decision"],
};

const ROW_NAMES: Readonly<Record<Family, string>> = {
  capability: "cap-",
  term: "term-",
  notes: "N-",
  rulings: "r-",
  issues: "ISS-",
};

function rowRefusal(impact: KnowledgeImpactItem, family: Family): string {
  const rows = Object.entries(TABLE)
    .filter(([key]) => key.startsWith(`${family}:`))
    .map(([key, dispositions]) => `${key.slice(family.length + 1)} (${dispositions.join(", ")})`);
  return `${impact.record}: no row for ${ROW_NAMES[family]} ${impact.kind} ${impact.disposition}; the ${ROW_NAMES[family]} rows are ${rows.join("; ") || "none"}`;
}

/** The marker rule for a cap- or term- pending disposition, at HEAD against the baseline. */
function markerRuleViolation(id: string, atHead: { pendingNote?: string }, atBaseline: { pendingNote?: string } | null): string | null {
  if (!hasPendingNote(atHead)) return `${id}: a pending disposition needs a pendingNote on the entry (capability defer / term defer)`;
  if (!atHead.pendingNote!.includes(id)) return `${id}: the pendingNote must name the record id`;
  if (atBaseline !== null && atBaseline.pendingNote === atHead.pendingNote) return `${id}: the pendingNote is unchanged since the baseline`;
  return null;
}

interface IssueLike {
  readonly id: string;
  readonly displayId?: string;
  readonly status: string;
  readonly title?: string;
  readonly impact?: string;
}

function issueViolation(head: LedgerSnapshot, issueId: string, names: string): { message: string } | { id: string } {
  const side = fileRecordAt(head, "issues", issueId);
  if (!side.present) return { message: `${names}: issue ${issueId} is not in the ledger at HEAD` };
  const issue = side.value as unknown as IssueLike;
  if (issue.status === "resolved") return { message: `${names}: issue ${issueId} is resolved; a pending follow-up must still be open` };
  // An issue has no `description` field: its prose is the title and `impact`.
  if (!`${issue.title ?? ""}\n${issue.impact ?? ""}`.includes(names)) {
    return { message: `${names}: issue ${issueId} must name ${names} in its title or impact` };
  }
  return { id: issue.id };
}

interface Ctx {
  readonly root: string;
  readonly head: string;
  readonly itemId: string;
  readonly baseline: LedgerSnapshot;
  readonly atHead: LedgerSnapshot;
  readonly history: History;
  readonly external: ExternalMaintenance[];
  /** `family:id` of every record the report owns a change to, with how much of it. */
  readonly explained: Map<string, "whole" | "stamp-or-marker">;
}

function explain(ctx: Ctx, family: Family, id: string, how: "whole" | "stamp-or-marker"): void {
  const key = `${family}:${id}`;
  if (ctx.explained.get(key) !== "whole") ctx.explained.set(key, how);
}

async function currentCapability(ctx: Ctx, entry: Capability): Promise<string | null> {
  // T-529: an entry the file's conflict records name at HEAD is not effectively current.
  const caps = ctx.atHead.capabilities();
  const scope = catalogConflictScope(caps.kind === "ok" ? caps : {}, [entry.id]);
  const report = await checkCapabilities(ctx.root, [entry], null, {
    snapshot: ctx.atHead,
    headOid: ctx.head,
    conflictedIds: scope.conflictedIds,
    problemIds: scope.problemIds,
  });
  const checked = report.entries[0];
  if (checked !== undefined && checked.effectiveStatus === "current") return null;
  const why = (checked?.results ?? []).map((r) => r.detail).join("; ");
  return `${entry.id}: an applied disposition needs the entry effectively current at HEAD${why ? ` (${why})` : checked?.pendingNote ? " (a pendingNote is set)" : " (stored status review)"}`;
}

async function verifyCapability(ctx: Ctx, impact: KnowledgeImpactItem): Promise<string | null> {
  const id = impact.record;
  const base = entryAt<Capability>(ctx.baseline, "capability", id);
  const now = entryAt<Capability>(ctx.atHead, "capability", id);
  if (!now.present) return `${id}: not in the capability catalog at HEAD`;
  if (impact.disposition === "applied") {
    if (impact.kind === "capability-added") {
      if (base.present) return `${id}: capability-added, but the entry exists at the implementation commit`;
    } else {
      if (!base.present) return `${id}: ${impact.kind} needs the entry at the implementation commit; a new entry is capability-added`;
      if (capabilitySemanticDigest(base.value) === capabilitySemanticDigest(now.value)) {
        return `${id}: applied, but the entry's content is unchanged since the implementation commit (only a stamp or marker moved)`;
      }
    }
    const notCurrent = await currentCapability(ctx, now.value);
    if (notCurrent !== null) return notCurrent;
    explain(ctx, "capability", id, "whole");
    return checkProvenance(ctx.history, { kind: "entry", family: "capability", id, part: "record" });
  }
  const marker = markerRuleViolation(id, now.value, base.present ? base.value : null);
  if (marker !== null) return marker;
  if (impact.kind === "capability-removed" && !now.value.pendingNote!.startsWith("retire:")) {
    return `${id}: capability-removed is recorded as a pending marker whose note starts with "retire:"`;
  }
  return verifyPendingFollowUp(ctx, impact, "capability");
}

async function verifyTerm(ctx: Ctx, impact: KnowledgeImpactItem): Promise<string | null> {
  const id = impact.record;
  const base = entryAt<Term>(ctx.baseline, "term", id);
  const now = entryAt<Term>(ctx.atHead, "term", id);
  if (!now.present) return `${id}: not in the glossary at HEAD`;
  if (impact.disposition === "applied") {
    if (!base.present) return `${id}: term-drift needs the term at the implementation commit`;
    if (termSemanticDigest(base.value) === termSemanticDigest(now.value)) {
      return `${id}: applied, but the term's content is unchanged since the implementation commit`;
    }
    const report = checkTerms([now.value], buildTermReferenceIndexFromSnapshot(ctx.atHead));
    const errors = (report.entries[0]?.results ?? []).filter((r) => r.cls === "structural" || r.cls === "incomplete");
    if (errors.length > 0) return `${id}: the term does not check clean at HEAD (${errors.map((r) => r.detail).join("; ")})`;
    explain(ctx, "term", id, "whole");
    return checkProvenance(ctx.history, { kind: "entry", family: "term", id, part: "record" });
  }
  const marker = markerRuleViolation(id, now.value, base.present ? base.value : null);
  if (marker !== null) return marker;
  return verifyPendingFollowUp(ctx, impact, "term");
}

/** A cap- or term- pending: the marker's provenance, plus the filed issue's when one is named. */
async function verifyPendingFollowUp(ctx: Ctx, impact: KnowledgeImpactItem, family: EntryFamily): Promise<string | null> {
  const id = impact.record;
  explain(ctx, family, id, "stamp-or-marker");
  const markerProblem = await checkMarkerProvenance(ctx.history, { kind: "entry", family, id, part: "marker" }, ctx.external);
  if (markerProblem !== null) return markerProblem;
  const issueId = impact.evidence.issueId;
  if (issueId === undefined) return null;
  const issue = issueViolation(ctx.atHead, issueId, id);
  if ("message" in issue) return issue.message;
  explain(ctx, "issues", issue.id, "whole");
  return checkProvenance(ctx.history, { kind: "file", family: "issues", id: issue.id });
}

async function verifyNote(ctx: Ctx, impact: KnowledgeImpactItem): Promise<string | null> {
  const id = impact.record;
  const now = fileRecordAt(ctx.atHead, "notes", id);
  if (!now.present) return `${id}: not in the ledger at HEAD`;
  if (impact.disposition === "applied") {
    const base = fileRecordAt(ctx.baseline, "notes", id);
    if (!base.present) return `${id}: stale-reference needs the note at the implementation commit`;
    explain(ctx, "notes", now.value.id, "whole");
    return checkProvenance(ctx.history, { kind: "file", family: "notes", id: now.value.id });
  }
  const issueId = impact.evidence.issueId;
  if (issueId === undefined) return `${id}: a pending note impact names its follow-up issue (evidence.issueId)`;
  const issue = issueViolation(ctx.atHead, issueId, id);
  if ("message" in issue) return issue.message;
  explain(ctx, "issues", issue.id, "whole");
  return checkProvenance(ctx.history, { kind: "file", family: "issues", id: issue.id });
}

interface RulingLike {
  readonly id: string;
  readonly status?: string;
  readonly proposesToSupersede?: string | null;
  readonly proposedFor?: readonly string[];
}

async function verifyRuling(ctx: Ctx, impact: KnowledgeImpactItem): Promise<string | null> {
  const id = impact.record;
  const lifecycle = ctx.atHead.rulingsScan().lifecycleById.get(id);
  if (lifecycle === undefined || !isEffectivelyAccepted(lifecycle)) {
    return `${id}: ruling-conflict is for an accepted ruling; at HEAD it is ${lifecycle ?? "not readable"}`;
  }
  // The accepted ruling is a lifecycle check only: it is superseded, never rewritten.
  const target: Target = { kind: "file", family: "rulings", id };
  if (projectionAt(ctx.baseline, target) !== projectionAt(ctx.atHead, target)) {
    return `${id}: the accepted ruling changed since the implementation commit; a ruling is superseded by a proposal, never rewritten`;
  }
  const proposalId = impact.evidence.proposalId!;
  const side = fileRecordAt(ctx.atHead, "rulings", proposalId);
  if (!side.present) return `${id}: proposal ${proposalId} is not in the ledger at HEAD`;
  const proposal = side.value as unknown as RulingLike;
  if (proposal.status !== "proposed") return `${id}: ${proposalId} is not a proposed ruling`;
  if (proposal.proposesToSupersede !== id) return `${id}: ${proposalId} does not propose to supersede ${id}`;
  if (!(proposal.proposedFor ?? []).includes(ctx.itemId)) return `${id}: ${proposalId} is not proposed for ${ctx.itemId}`;
  explain(ctx, "rulings", proposal.id, "whole");
  return checkProvenance(ctx.history, { kind: "file", family: "rulings", id: proposal.id });
}

// --- attribution ---

interface Change {
  readonly family: Family;
  readonly id: string;
  /** For catalog entries: whether only stamp or marker fields moved. */
  readonly stampOrMarkerOnly: boolean;
}

function withoutFields(value: unknown, fields: readonly string[]): string | null {
  const copy = { ...(value as Record<string, unknown>) };
  for (const f of fields) delete copy[f];
  return projectionOf({ present: true, value: copy });
}

function catalogChanges(family: EntryFamily, before: LedgerSnapshot, after: LedgerSnapshot): Change[] {
  const read = (s: LedgerSnapshot): readonly { id: string }[] => {
    const r = family === "capability" ? s.capabilities() : s.terms();
    if (r.kind === "absent") return [];
    if (r.kind !== "ok") throw new LedgerUnavailable(`${family === "capability" ? CAPABILITIES_PATH : GLOSSARY_PATH} at ${short(s.oid)} could not be read (${r.reason})`);
    return r.entries;
  };
  const a = new Map(read(before).map((e) => [e.id, e]));
  const b = new Map(read(after).map((e) => [e.id, e]));
  const changes: Change[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id);
    const y = b.get(id);
    const px = x === undefined ? null : projectionOf({ present: true, value: x });
    const py = y === undefined ? null : projectionOf({ present: true, value: y });
    if (px === py) continue;
    const fields = STAMP_OR_MARKER_FIELDS[family];
    const stampOrMarkerOnly = x !== undefined && y !== undefined && withoutFields(x, fields) === withoutFields(y, fields);
    changes.push({ family, id, stampOrMarkerOnly });
  }
  return changes;
}

function fileChanges(family: "notes" | "rulings" | "issues", before: LedgerSnapshot, after: LedgerSnapshot): Change[] {
  const read = (s: LedgerSnapshot): readonly FileRecord[] => {
    const r = s[family]();
    const bad = r.unreadable[0];
    if (bad !== undefined) throw new LedgerUnavailable(`${sanitizeDisplayText(bad.path, 120)} at ${short(s.oid)} could not be read (${sanitizeDisplayText(bad.reason, 160)})`);
    return r.records as readonly FileRecord[];
  };
  const a = new Map(read(before).map((r) => [r.id, r]));
  const b = new Map(read(after).map((r) => [r.id, r]));
  const changes: Change[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id);
    const y = b.get(id);
    const px = x === undefined ? null : projectionOf({ present: true, value: x });
    const py = y === undefined ? null : projectionOf({ present: true, value: y });
    if (px !== py) changes.push({ family, id: (y ?? x)!.id, stampOrMarkerOnly: false });
  }
  return changes;
}

/** Every record change a chain commit made, against the commit before it on the chain. */
function changesAt(h: History, i: number): Promise<Change[]> {
  return changesBetween(h, h.chain[i - 1]!, h.chain[i]!, h.pathsAt(i));
}

/** Every record change from `from` to `to`, where `paths` are the paths that changed between them. */
async function changesBetween(h: History, from: string, to: string, paths: readonly string[]): Promise<Change[]> {
  const touched = (p: string): boolean => paths.includes(p);
  const under = (dir: string): boolean => paths.some((p) => p.startsWith(dir));
  const needed = touched(CAPABILITIES_PATH) || touched(GLOSSARY_PATH) || ["notes", "rulings", "issues"].some((f) => under(`.story/${f}/`));
  if (!needed) return [];
  const before = await h.snapshot(from);
  const after = await h.snapshot(to);
  const changes: Change[] = [];
  if (touched(CAPABILITIES_PATH)) changes.push(...catalogChanges("capability", before, after));
  if (touched(GLOSSARY_PATH)) changes.push(...catalogChanges("term", before, after));
  for (const f of ["notes", "rulings", "issues"] as const) if (under(`.story/${f}/`)) changes.push(...fileChanges(f, before, after));
  return changes;
}

/** A listed commit off HEAD's first-parent chain (on a merged side branch), with what it changed against its own first parent. */
interface OffChainCommit {
  readonly commit: string;
  readonly parent: string;
  readonly paths: readonly string[];
}

/**
 * Only changes inside listed commits belong to this session, and each must be
 * explained: an impact target, or a stamp or marker on an id named in
 * `checked`. Issue changes are the exception (ISS-1340): see `unexplained`.
 * Changes in unlisted chain commits are external maintenance. A listed commit
 * off the chain is held to the same rule against its own first parent:
 * listing it claims its changes, whether or not its merge is listed.
 */
async function attribute(ctx: Ctx, checked: ReadonlySet<string>, offChain: readonly OffChainCommit[]): Promise<string | null> {
  const h = ctx.history;
  for (let i = 1; i < h.chain.length; i++) {
    const commit = h.chain[i]!;
    const changes = await changesAt(h, i);
    if (!h.listed.has(commit)) {
      for (const c of changes) ctx.external.push({ id: c.id, commit });
      continue;
    }
    const problem = unexplained(ctx, checked, commit, changes);
    if (problem !== null) return problem;
  }
  for (const o of offChain) {
    const problem = unexplained(ctx, checked, o.commit, await changesBetween(h, o.parent, o.commit, o.paths));
    if (problem !== null) return problem;
  }
  return null;
}

function unexplained(ctx: Ctx, checked: ReadonlySet<string>, commit: string, changes: readonly Change[]): string | null {
  for (const c of changes) {
    // ISS-1340: an issue is not recorded knowledge. Resolving or editing one is
    // an operational ledger update, like a ticket update, and needs no impact.
    // Issues stay in the changed families only so an issue cited as pending
    // evidence is held to its own checks, which run before attribution: it
    // exists at HEAD, is open, names the record, and passes provenance.
    if (c.family === "issues") continue;
    const how = ctx.explained.get(`${c.family}:${c.id}`);
    if (how === "whole") continue;
    const stampable = c.family === "capability" || c.family === "term";
    if (stampable && c.stampOrMarkerOnly && (how === "stamp-or-marker" || checked.has(c.id))) continue;
    return `${c.id} changed in listed commit ${short(commit)}, but the report does not explain it; name it as an impact, or name it in checked when the change is a stamp or marker`;
  }
  return null;
}

// --- knowledge_reviewed ---

/**
 * Verify a `knowledge_reviewed` report. On success the stage re-reads HEAD
 * with `confirmHead` immediately before persisting the acceptance.
 */
export async function verifyKnowledgeReport(
  root: string,
  review: KnowledgeReviewRef,
  report: KnowledgeImpact,
  deps: KnowledgeVerifyDeps,
): Promise<KnowledgeRefusal | KnowledgeVerified> {
  const git = deps.git;
  if (report.implementationCommit !== review.implementationCommit) {
    return refused(`implementationCommit must be ${review.implementationCommit}, the verified commit this review is for`);
  }
  const headRead = await git.head();
  if (!headRead.ok) return refused(`git could not read HEAD: ${sanitizeDisplayText(headRead.message, 200)}`);
  const head = headRead.data;

  const pre = await preflight(git, review, head);
  if (pre !== null) return pre;
  const codeAfter = await ruleCodeAfterCheckpoint(git, review.checkpoint, head);
  if (codeAfter !== null) return codeAfter;
  const maintenance = await ruleMaintenanceCommits(git, review.implementationCommit, head, report.maintenanceCommits);
  if (!maintenance.ok) return maintenance;
  const dirty = await ruleCleanLedger(git);
  if (dirty !== null) return dirty;

  const impacts = report.impacts ?? [];
  const treeAtImpl = await git.storyTree(review.implementationCommit);
  const treeAtHead = await git.storyTree(head);
  if (!treeAtImpl.ok || !treeAtHead.ok) return refused("git could not read the .story/ tree at the implementation commit or HEAD");
  if (treeAtImpl.data === treeAtHead.data && (impacts.length > 0 || maintenance.commits.length > 0)) {
    return refused("the .story/ tree at HEAD equals the implementation commit's, so there is nothing to attribute: impacts and maintenanceCommits must both be empty");
  }

  const chainRead = await git.revList(review.implementationCommit, head, true);
  if (!chainRead.ok) return refused(`git could not walk HEAD's history: ${sanitizeDisplayText(chainRead.message, 200)}`);
  const chain = [review.implementationCommit, ...chainRead.data];
  const paths = new Map<string, readonly string[]>();
  for (const commit of chainRead.data) {
    const p = await git.commitPaths(commit);
    if (!p.ok) return refused(`git could not list ${short(commit)}: ${sanitizeDisplayText(p.message, 200)}`);
    paths.set(commit, p.data);
  }
  const onChain = new Set(chain);
  const offChain: OffChainCommit[] = [];
  for (const commit of maintenance.commits) {
    if (onChain.has(commit)) continue;
    const parent = await git.firstParent(commit);
    const p = await git.commitPaths(commit);
    if (!parent.ok || parent.data === null || !p.ok) return refused(`git could not read maintenance commit ${short(commit)} against its parent`);
    offChain.push({ commit, parent: parent.data, paths: p.data });
  }
  const read = deps.snapshot ?? ((oid: string) => readLedgerSnapshot(root, oid));
  const mergesRead = await git.firstParentMerges(review.implementationCommit, head);
  if (!mergesRead.ok) return refused(`git could not walk HEAD's history: ${sanitizeDisplayText(mergesRead.message, 200)}`);
  const history = new History(chain, paths, read, new Set(maintenance.commits), new Set(mergesRead.data));

  try {
    let baseline: LedgerSnapshot;
    try {
      baseline = await history.snapshot(review.implementationCommit);
    } catch (err) {
      if (err instanceof LedgerUnavailable) return refused(`baseline unavailable: ${err.message}`);
      throw err;
    }
    const baselineProblem = baselineFamilyProblem(baseline);
    if (baselineProblem !== null) return refused(`baseline unavailable: ${baselineProblem}`);
    const ctx: Ctx = {
      root,
      head,
      itemId: review.itemId,
      baseline,
      atHead: await history.snapshot(head),
      history,
      external: [],
      explained: new Map(),
    };
    for (const impact of impacts) {
      const family = familyOf(impact.record);
      if (!(TABLE[`${family}:${impact.kind}`] ?? []).includes(impact.disposition)) return refused(rowRefusal(impact, family));
      const problem =
        family === "capability" ? await verifyCapability(ctx, impact)
        : family === "term" ? await verifyTerm(ctx, impact)
        : family === "rulings" ? await verifyRuling(ctx, impact)
        : await verifyNote(ctx, impact);
      if (problem !== null) return refused(problem);
    }
    const problem = await attribute(ctx, new Set(report.checked), offChain);
    if (problem !== null) return refused(problem);
    return { ok: true, head, maintenanceCommits: maintenance.commits, externalMaintenance: dedupe(ctx.external) };
  } catch (err) {
    if (err instanceof LedgerUnavailable) return refused(`ledger unavailable: ${err.message}`);
    throw err;
  }
}

/** Any unreadable baseline family is a refusal naming the file: nothing can be concluded against it. */
function baselineFamilyProblem(s: LedgerSnapshot): string | null {
  const caps = s.capabilities();
  if (caps.kind !== "ok" && caps.kind !== "absent") return `${CAPABILITIES_PATH}: ${caps.reason}`;
  const terms = s.terms();
  if (terms.kind !== "ok" && terms.kind !== "absent") return `${GLOSSARY_PATH}: ${terms.reason}`;
  for (const family of ["notes", "rulings", "issues"] as const) {
    const bad = s[family]().unreadable[0];
    if (bad !== undefined) return `${sanitizeDisplayText(bad.path, 120)}: ${sanitizeDisplayText(bad.reason, 160)}`;
  }
  return null;
}

function dedupe(list: readonly ExternalMaintenance[]): ExternalMaintenance[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const key = `${e.id}@${e.commit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
