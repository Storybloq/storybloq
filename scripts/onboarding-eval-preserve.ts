/**
 * T-538 commit 3 (plan v5 6.1): what an interrupted setup must preserve, as findings. One function serves the
 * no-model rows (test/tooling/t538-host-faults.test.ts), the live attempts and the regrade, so the three apply
 * the same rules to the same bytes.
 *
 * Inputs are tree snapshots in the kill snapshot's form (`{files: {path: base64}, links, truncated}`,
 * eval-fault-mcp.ts treeSnapshot): the baseline (the kill snapshot of the first armed session, or for
 * `interrupted-edited` the snapshot taken after the owner's edits) and the project at the end of the attempt.
 */
import type { EventsLog } from "./onboarding-eval-checkset7-events.js";
import { readBounded, walkNoFollow, type WalkHook } from "./onboarding-eval-walk.js";

/**
 * 6.1: the bounds of the kill snapshot's walk. Past any of them, the snapshot says `truncated` and the attempt's
 * preservation check fails. Codex round 1 P2: the count is of entries (folders and links too, so a tree of empty
 * folders cannot run the walk long), and the depth is bounded.
 */
export const KILL_SNAPSHOT_MAX_FILES = 4000;
export const KILL_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const KILL_SNAPSHOT_MAX_DEPTH = 64;

/**
 * 6.1: the project tree as the collector sees it at the kill: every regular file's bytes (base64) by its
 * POSIX path from the root, the root's `.git` and every `node_modules` left out (R2 (a): an install folder is
 * provisioned state at any depth), links recorded as links and never followed.
 *
 * Codex round 1 P2: the walk is the harness's no-follow walker (onboarding-eval-walk.ts). A file is opened with
 * O_NOFOLLOW, proven by fstat on the descriptor to be the entry that was listed, and read through that descriptor
 * at most to the bytes left, so a file swapped for a link is never followed and a growing file stops at the
 * bound. An entry the walk cannot read safely (swapped, unreadable, not a file, folder or link) is a problem the
 * snapshot carries, and a snapshot with a problem fails the preservation check.
 *
 * Codex round 2 Q1: the entry bound is the walker's own (`maxEntries`), so a folder's listing reads at most the
 * entries left plus one and nothing past the bound is listed or lstat'd. Every lstat counts, the left-out `.git`
 * and `node_modules` included. Past the depth or byte bound the visitor says its budget is spent and the walk ends
 * at once. Either way the snapshot is truncated and carries a problem naming the bound.
 */
export function treeSnapshot(root: string, maxFiles = KILL_SNAPSHOT_MAX_FILES, maxBytes = KILL_SNAPSHOT_MAX_BYTES, maxDepth = KILL_SNAPSHOT_MAX_DEPTH, hook?: WalkHook): string {
  const files: Record<string, string> = {};
  const links: string[] = [];
  let left = maxBytes;
  let bound: string | null = null;
  const walked = walkNoFollow(root, "project", {
    include: (rel) => {
      const parts = rel.split("/");
      if ((parts.length === 1 && parts[0] === ".git") || parts[parts.length - 1] === "node_modules") return false;
      if (parts.length > maxDepth) { bound = `depth bound (${maxDepth})`; return false; }
      return true;
    },
    link: (rel) => { links.push(rel); },
    file: (rel, fd) => {
      const r = readBounded(fd, left);
      if ("code" in r) return r.code;
      if ("over" in r) { bound = `byte bound (${maxBytes})`; return null; }
      left -= r.bytes.length;
      files[rel] = r.bytes.toString("base64");
      return null;
    },
    spent: () => bound !== null,
  }, { hook, maxEntries: maxFiles });
  if (walked.stopped === "entries") bound = `entry bound (${maxFiles})`;
  const truncated = bound !== null;
  const problems = [...walked.problems, ...(bound !== null ? [`project: the snapshot stopped at its ${bound as string}`] : [])];
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]!]));
  return JSON.stringify({ files: sorted, links: links.sort(), truncated, problems }) + "\n";
}

export interface TreeSnap {
  readonly files: Readonly<Record<string, string>>;
  readonly links: readonly string[];
  readonly truncated: boolean;
  /** P2: what the walk could not read safely; any one fails the preservation check. Absent in an older snapshot. */
  readonly problems: readonly string[];
}

/** The raw names the runner writes them under and the regrade reads them from. */
export const killRaw = (id: string): string => `fault-kill.${id}.json`;
export const EDITED_RAW = "fault-edited.json";
export const END_RAW = "fault-end.json";
/** Every raw name above, so the regrade can find them by shape. */
export const FAULT_RAW = /^fault-(kill\.[A-Za-z0-9_-]{1,32}|edited|end)\.json$/;

export class TreeSnapError extends Error {}

/**
 * The fixture's own files outside `.story/`, from its manifest hashes: setup never creates them. The runner's
 * entries read `project/<path>` (fixtureEvidence) and the regrade's `fixture/project/<path>` (regradeInputFrom).
 */
export const protectedPathsOf = (hashes: readonly { readonly path: string }[]): string[] =>
  hashes.map((h) => h.path.replace(/^fixture\//, "")).filter((p) => p.startsWith("project/") && !p.startsWith("project/.story/")).map((p) => p.slice("project/".length)).sort();

/**
 * R2 (a): the lockfiles provisioning copied into the project, project-relative, from the record's
 * `dependencyInstalls`. They are starting state like the fixture's own files: protected, so a change the model
 * makes to one shows, and never credited to the model as created. Anything not of that shape gives none.
 */
export function provisionedLockfiles(installs: unknown): string[] {
  if (!Array.isArray(installs)) return [];
  return installs.flatMap((i) => (i !== null && typeof i === "object" && typeof (i as { path?: unknown }).path === "string" && (i as { copied?: unknown }).copied === true
    ? [(i as { path: string }).path === "." ? "package-lock.json" : `${(i as { path: string }).path}/package-lock.json`] : []));
}

/** A snapshot file's bytes as a TreeSnap, or a TreeSnapError naming what is wrong. */
export function parseTreeSnap(text: string): TreeSnap {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new TreeSnapError("not JSON"); }
  const o = v as { files?: unknown; links?: unknown; truncated?: unknown; problems?: unknown } | null;
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new TreeSnapError("not an object");
  if (o.files === null || typeof o.files !== "object" || Array.isArray(o.files) || Object.values(o.files).some((b) => typeof b !== "string")) throw new TreeSnapError("files is not a map of base64 strings");
  if (!Array.isArray(o.links) || o.links.some((l) => typeof l !== "string")) throw new TreeSnapError("links is not a list of paths");
  if (typeof o.truncated !== "boolean") throw new TreeSnapError("truncated is not a boolean");
  if (o.problems !== undefined && (!Array.isArray(o.problems) || o.problems.some((l) => typeof l !== "string"))) throw new TreeSnapError("problems is not a list of findings");
  return { files: o.files as Record<string, string>, links: o.links as string[], truncated: o.truncated, problems: (o.problems as string[] | undefined) ?? [] };
}

/**
 * The fields a wire step may change in an item published before the kill: setup-apply.ts:935 (stepWire) writes
 * the loaded item back with only `blockedBy` changed (a checkpoint gates a ticket through the gated ticket's
 * `blockedBy`, see setupBlockers); prepareTicketWrite stamps `updatedDate`; and the loader fills `displayId`
 * with `id` on a display-id-named file that has none (project-loader.ts:2478), which the write keeps.
 */
export const WIRE_FIELDS: readonly string[] = ["blockedBy", "updatedDate", "displayId"];

const BOOTSTRAP = ".story/.setup-bootstrap.json";
const CONFIG = ".story/config.json";

/** Every path that is a lock: setup's own `.story/.lock`, its link temps `.lock.tmp.<pid>.<uuid>`, and any `*.lock`. */
export const lockPaths = (files: Readonly<Record<string, string>>): string[] => Object.keys(files).filter((p) => /(^|\/)\.lock(\/|$)|\.lock\.tmp\.|\.lock$/.test(p));

/**
 * A killed session's lock temp, the one leftover allowed (ISS-1184, open): project-lock.ts:550 creates
 * `.story/.lock.tmp.<pid>.<uuid>` and links it to `.story/.lock`, only a release unlinks it (project-lock.ts:676),
 * and the resume steals the dead lock without removing the dead holder's temp. Allowed only for a pid that was
 * killed; any other lock path is a finding.
 */
export const killedTemp = (path: string, killed: readonly number[]): boolean => {
  const m = /^\.story\/\.lock\.tmp\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(path);
  return m !== null && killed.includes(Number(m[1]));
};

/** The pids of the attempts a fired record names: the sessions the faults killed. */
export const killedPids = (log: EventsLog): number[] => (log.fired ?? []).map((f) => log.attempts.find((a) => a.attempt === f.attempt)?.pid).filter((p): p is number => typeof p === "number");

const decode = (b64: string): string => Buffer.from(b64, "base64").toString("utf-8");
function parsed(files: Readonly<Record<string, string>>, path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(decode(files[path]!)) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** Items setup published, by key: tickets and checkpoints (and issues) carry `setup.key`. */
export function keyedItems(files: Readonly<Record<string, string>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const path of Object.keys(files).filter((p) => /^\.story\/(tickets|issues)\/[^/]+\.json$/.test(p)).sort()) {
    const key = (parsed(files, path)?.setup as { key?: unknown } | undefined)?.key;
    if (typeof key === "string") out.set(key, [...(out.get(key) ?? []), path]);
  }
  return out;
}

/** The progress note (setup.record "progress"), or null. */
export function progressNote(files: Readonly<Record<string, string>>): { path: string; note: Record<string, unknown> } | null {
  for (const path of Object.keys(files).filter((p) => /^\.story\/notes\/[^/]+\.json$/.test(p)).sort()) {
    const note = parsed(files, path);
    if ((note?.setup as { record?: unknown } | undefined)?.record === "progress") return { path, note: note! };
  }
  return null;
}

export interface PreserveInputs {
  readonly baseline: TreeSnap;
  readonly end: TreeSnap;
  /** The fixture's own files outside `.story/` (setup never creates them), compared byte for byte. */
  readonly protectedPaths: readonly string[];
  /** The first armed entry's selector: `archive-committed` is the one class whose baseline holds the archive. */
  readonly selector: string;
  /**
   * Codex round 2 Q2: the events-log line of the fired record whose kill snapshot is the baseline. step:config
   * committed before it means config.json is frozen from that kill on.
   */
  readonly firedLine: number;
  readonly log: EventsLog;
}

/** The plan's preservation table, checked between the baseline and the end. Empty when everything holds. */
export function preservationFindings(v: string, i: PreserveInputs): string[] {
  const out: string[] = [];
  const { baseline, end } = i;
  if (baseline.truncated) out.push(`${v}: the baseline snapshot is truncated`);
  if (end.truncated) out.push(`${v}: the end snapshot is truncated`);
  for (const p of baseline.problems) out.push(`${v}: the baseline snapshot: ${p}`);
  for (const p of end.problems) out.push(`${v}: the end snapshot: ${p}`);
  if (JSON.stringify([...baseline.links].sort()) !== JSON.stringify([...end.links].sort())) out.push(`${v}: the project's links changed after the baseline`);
  // Protected content: the fixture's own files, byte for byte.
  for (const p of i.protectedPaths) if (end.files[p] !== baseline.files[p]) out.push(`${v}: ${p} changed after the baseline`);
  // Setup-owned state, by the table.
  if (end.files[BOOTSTRAP] !== undefined) out.push(`${v}: the bootstrap manifest is still there after the resume`);
  const killed = killedPids(i.log);
  for (const l of lockPaths(end.files)) if (!killedTemp(l, killed)) out.push(`${v}: ${l} is still there after the resume`);
  const before = progressNote(baseline.files);
  const after = progressNote(end.files);
  if (after === null) out.push(`${v}: no progress note after the resume`);
  else {
    if (after.note.status !== "archived") out.push(`${v}: the progress note ends ${String(after.note.status)}, not archived`);
    if (before !== null) {
      if (after.path !== before.path || after.note.id !== before.note.id || after.note.createdDate !== before.note.createdDate) out.push(`${v}: the progress note is not the one at the baseline (path, id or created date changed)`);
      const want = i.selector === "archive-committed" ? "archived" : "active";
      if (before.note.status !== want) out.push(`${v}: the progress note was ${String(before.note.status)} at the baseline, not ${want}`);
    }
  }
  const was = keyedItems(baseline.files);
  const now = keyedItems(end.files);
  for (const [key, paths] of was) {
    if (JSON.stringify(now.get(key) ?? []) !== JSON.stringify(paths)) { out.push(`${v}: ${key} is not at its baseline path after the resume`); continue; }
    const a = parsed(baseline.files, paths[0]!);
    const b = parsed(end.files, paths[0]!);
    if (a === null || b === null) { out.push(`${v}: ${key}'s file is not a JSON object`); continue; }
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
    const extra = changed.filter((f) => !WIRE_FIELDS.includes(f));
    if (extra.length > 0) out.push(`${v}: ${key} changed ${extra.join(", ")} after the baseline, which no remaining step owns`);
    if (changed.includes("displayId") && (a.displayId !== undefined || b.displayId !== b.id)) out.push(`${v}: ${key}'s displayId changed to something other than its id`);
    const edges = (x: Record<string, unknown>): unknown[] => (Array.isArray(x.blockedBy) ? x.blockedBy : []);
    if (edges(a).some((e) => !edges(b).includes(e))) out.push(`${v}: ${key} lost a blockedBy edge it had at the baseline`);
  }
  for (const [key, paths] of now) if (paths.length !== 1) out.push(`${v}: ${key} is published ${paths.length} times`);
  // config.json: once step:config committed before this baseline's fault, the remaining steps never touch it.
  const config = i.log.events.find((e) => e.point === "step:config");
  if (config !== undefined && config.line < i.firedLine && baseline.files[CONFIG] !== undefined && end.files[CONFIG] !== baseline.files[CONFIG]) out.push(`${v}: config.json changed after step:config committed before the fault`);
  const archives = i.log.events.filter((e) => e.point === "archive-committed").length;
  if (archives !== 1) out.push(`${v}: the archive committed ${archives} times, not once`);
  return out;
}

export interface OwnerEdits { readonly edgeTicket: string; readonly blocker: string; readonly describedTicket: string; readonly description: string }

/**
 * `interrupted-edited`'s second snapshot must differ from the kill snapshot in exactly the recorded owner edits:
 * the edged ticket gains the blocker in `blockedBy`, the described ticket's description becomes the edit, each
 * may restamp `updatedDate` and gain `displayId` equal to its id, and nothing else in the tree changes.
 */
export function editedSnapshotFindings(kill: TreeSnap, edited: TreeSnap, e: OwnerEdits): string[] {
  const out: string[] = [];
  const v = "interrupted-edited";
  const find = (files: Readonly<Record<string, string>>, ref: string): string | undefined =>
    Object.keys(files).filter((p) => /^\.story\/(tickets|issues)\/[^/]+\.json$/.test(p)).find((p) => { const t = parsed(files, p); return t !== null && (t.id === ref || t.displayId === ref); });
  const edgePath = find(kill.files, e.edgeTicket);
  const describedPath = find(kill.files, e.describedTicket);
  const blockerPath = find(kill.files, e.blocker);
  if (edgePath === undefined || describedPath === undefined || blockerPath === undefined) return [`${v}: the kill snapshot does not hold the edited tickets`];
  const blockerId = parsed(kill.files, blockerPath)!.id;
  const paths = [...new Set([...Object.keys(kill.files), ...Object.keys(edited.files)])].sort();
  for (const p of paths) {
    if (kill.files[p] === edited.files[p]) continue;
    if (p !== edgePath && p !== describedPath) { out.push(`${v}: ${p} differs between the kill snapshot and the edited snapshot, and no owner edit names it`); continue; }
    const a = parsed(kill.files, p);
    const b = parsed(edited.files, p);
    if (a === null || b === null) { out.push(`${v}: ${p} is not a JSON object in both snapshots`); continue; }
    const allowed = new Set(["updatedDate", ...(p === edgePath ? ["blockedBy"] : []), ...(p === describedPath ? ["description"] : [])]);
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
    // The CLI's write keeps the loader's `displayId` fill (project-loader.ts:2478), so it may appear, equal to the id.
    const filled = (f: string): boolean => f === "displayId" && a.displayId === undefined && b.displayId === b.id;
    const extra = changed.filter((f) => !allowed.has(f) && !filled(f));
    if (extra.length > 0) out.push(`${v}: ${p} changed ${extra.join(", ")}, which the owner edits do not name`);
  }
  const edgedNow = parsed(edited.files, edgePath);
  const before = (parsed(kill.files, edgePath)?.blockedBy as unknown[] | undefined) ?? [];
  const after = (edgedNow?.blockedBy as unknown[] | undefined) ?? [];
  // The CLI stores the blocker by id; the display id is accepted too, as editedFindings does on the final ledger.
  const refs = [blockerId, e.blocker];
  const added = after.filter((x) => !before.includes(x));
  const kept = JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before);
  const holds = kept && (added.length === 0 ? before.some((x) => refs.includes(x)) : added.length === 1 && refs.includes(added[0]));
  if (!holds) out.push(`${v}: ${e.edgeTicket}'s blockedBy is not the kill snapshot's plus ${e.blocker}`);
  if (parsed(edited.files, describedPath)?.description !== e.description) out.push(`${v}: ${e.describedTicket}'s description is not the owner's edit`);
  return out;
}
