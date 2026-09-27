import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Capability, CapabilityCatalog } from "../models/capability.js";
import type { GlossaryCatalog, Term } from "../models/glossary.js";
import type { Ruling } from "../models/ruling.js";
import { TicketSchema } from "../models/ticket.js";
import { IssueSchema } from "../models/issue.js";
import type { ProjectState } from "./project-state.js";
import type { Catalog } from "./catalog.js";
import { catalogConflictScope } from "./catalog-conflicts.js";
import { CONFIG_MAX_BYTES, readBoundedFileDetailed, type BoundedRead, type BoundedReader } from "./bounded-read.js";
import { RULING_MAX_BYTES, loadRulingsSafe, loadUpwardBoardAt, type LoadRulingsResult } from "./ruling-loader.js";
import { CATALOG_MAX_BYTES } from "./catalog.js";
import { readdirSafe, verifyContainment, verifyDirIdentity, type DirIdentity } from "./readdir-safe.js";
import { resolveOrchestratorRootFrom, type OrchestratorRootResult } from "../federation/resolver.js";
import {
  buildCitationResolutionContext,
  citationWarningText,
  resolveCitation,
  type CitationResolution,
  type CitationResolutionContext,
  type UpwardBoard,
} from "./ruling.js";
import { classifyLifecycle, isEffectivelyAccepted, proposalsAgainst, type RulingLifecycle } from "./ruling-lifecycle.js";
import type { CapabilityCheckReport, CheckOptions } from "./capability.js";
import { checkTerms, termReferenceIndexFrom, type CapabilityScan } from "./glossary.js";

/**
 * T-528: the decisions projection, the one file the Mac app reads to show
 * rulings, citations, capabilities and terms without re-implementing the
 * CLI's derivations in Swift.
 *
 * Everything here answers one question: "what does the CLI conclude about the
 * ledger it read?", together with a revision that says WHICH ledger that was.
 * The app compares the revision against its own hash of the same inputs and
 * shows anything that disagrees as unverified.
 *
 * Capture is two passes around the build. Pass 1 runs the shipped loaders
 * through a recording reader, so rulings and catalogs parse through exactly
 * the code the CLI uses while the bytes they parsed are kept; tickets, issues
 * and config are read directly. The loaders are bracketed: the inputs they own
 * are hashed before they run and enumerated after, and a capture whose loaders
 * read a file the enumeration no longer lists, or whose bracket disagrees (a
 * ruling added or removed, a catalog created, while the loaders ran), is
 * retried like any other change. The capability check then runs; its reference
 * index reads the rulings and the glossary a second time, unrecorded. Pass 2
 * re-enumerates and re-hashes every input and compares the whole map. Any
 * difference retries, and after three attempts the write fails.
 *
 * RESIDUAL, named rather than closed (the same class accepted on ISS-1273):
 * an input that changes and changes BACK between pass 1 and pass 2 (A-B-A)
 * leaves pass 2 equal to pass 1, so a read inside the window (the check's
 * reference index, a listing) can have seen B while the projection records
 * A. The projection's own parse is always of the recorded A bytes and the
 * revision hashes A, so the file is self-consistent; what can differ is a
 * reference verdict computed from B. Closing it would mean the check reading
 * the recorded bytes as well, which is a change to `checkCapabilities`'
 * reference index that this commit does not make.
 */

export const PROJECTION_SCHEMA_VERSION = 1;
export const LEDGER_REVISION_HEADER = "storybloq-ledger-revision/1\n";
/** Tickets and issues have no shipped read bound; this one is generous and only guards memory. */
export const ITEM_MAX_BYTES = 4_000_000;
export const CAPTURE_ATTEMPTS = 3;

const SINGLETONS: readonly { readonly file: string; readonly maxBytes: number }[] = [
  { file: "capabilities.json", maxBytes: CATALOG_MAX_BYTES },
  { file: "config.json", maxBytes: CONFIG_MAX_BYTES },
  { file: "glossary.json", maxBytes: CATALOG_MAX_BYTES },
];
const DIRECTORIES: readonly { readonly dir: string; readonly maxBytes: number }[] = [
  { dir: "issues", maxBytes: ITEM_MAX_BYTES },
  { dir: "rulings", maxBytes: RULING_MAX_BYTES },
  { dir: "tickets", maxBytes: ITEM_MAX_BYTES },
];

// --- revision ---

export type InputState =
  | { readonly kind: "ok"; readonly sha256: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

export interface RevisionEntry {
  /** Relative to `.story/`, forward slashes, NFC. */
  readonly path: string;
  readonly state: InputState;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The canonical form of an input path: forward slashes, NFC. */
export function revisionPath(rel: string): string {
  return rel.split(sep).join("/").normalize("NFC");
}

/**
 * The revision: sha256 over a header and one `<path>\t<sha256>\n` line per
 * input, sorted by UTF-8 bytes. An absent singleton contributes `<path>\t-`.
 * Any unreadable input makes the revision null: a hash over a set with a hole
 * in it would name a ledger nobody can reproduce.
 */
export function ledgerRevision(entries: readonly RevisionEntry[]): string | null {
  if (entries.some((e) => e.state.kind === "unreadable")) return null;
  const lines = entries.map((e) => `${revisionPath(e.path)}\t${e.state.kind === "ok" ? e.state.sha256 : "-"}\n`);
  lines.sort((a, b) => Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8")));
  return sha256Hex(LEDGER_REVISION_HEADER + lines.join(""));
}

// --- enumeration and passes ---

interface InputSlot {
  readonly rel: string;
  readonly abs: string;
  readonly maxBytes: number;
  readonly singleton: boolean;
  /** The listed directory and entry name, for a directory entry; null for a singleton. */
  readonly dirAbs: string | null;
  readonly name: string;
  readonly isFile: boolean;
}

interface ListedDir {
  readonly rel: string;
  readonly abs: string;
  readonly identity: DirIdentity | null;
}

/**
 * Every input path. A directory is listed with the same symlink-rejecting,
 * identity-checked listing the ruling loader uses; a directory that cannot be
 * listed is itself an unreadable input.
 */
function enumerateInputs(
  storyDir: string,
  only: (name: string) => boolean = () => true,
): { slots: InputSlot[]; dirs: ListedDir[]; unlistable: RevisionEntry[] } {
  const slots: InputSlot[] = [];
  const dirs: ListedDir[] = [];
  const unlistable: RevisionEntry[] = [];
  for (const s of SINGLETONS) {
    if (!only(s.file)) continue;
    slots.push({ rel: s.file, abs: join(storyDir, s.file), maxBytes: s.maxBytes, singleton: true, dirAbs: null, name: s.file, isFile: true });
  }
  for (const d of DIRECTORIES) {
    if (!only(d.dir)) continue;
    const dir = join(storyDir, d.dir);
    const scan = readdirSafe(dir);
    if (scan.warning !== null) {
      unlistable.push({ path: `${d.dir}/`, state: { kind: "unreadable", reason: "directory could not be listed" } });
      continue;
    }
    dirs.push({ rel: d.dir, abs: dir, identity: scan.dirIdentity });
    for (const entry of scan.dirents ?? []) {
      if (!entry.name.endsWith(".json")) continue;
      slots.push({ rel: `${d.dir}/${entry.name}`, abs: join(dir, entry.name), maxBytes: d.maxBytes, singleton: false, dirAbs: dir, name: entry.name, isFile: entry.isFile() });
    }
  }
  return { slots, dirs, unlistable };
}

/**
 * The loader's guard for a directory entry, applied immediately before the
 * read it protects: not a regular file, or resolving outside its directory,
 * is refused and never read.
 */
function refusal(slot: InputSlot): string | null {
  if (slot.dirAbs === null) return null;
  if (!slot.isFile) return "not a regular file";
  return verifyContainment(slot.dirAbs, slot.name) !== null ? "escapes its directory" : null;
}

/**
 * The loader's post-scan checkpoint: a directory whose identity changed while
 * its entries were read (replaced, say, by a symlink to somewhere else) makes
 * every entry read from it unreadable, so no hash of bytes from outside the
 * ledger is ever recorded as a ledger input.
 */
function revalidateDirs(dirs: readonly ListedDir[], entries: RevisionEntry[]): { rel: string; reason: string }[] {
  const failed: { rel: string; reason: string }[] = [];
  for (const d of dirs) {
    if (d.identity === null) continue;
    const warning = verifyDirIdentity(d.abs, d.identity);
    if (warning === null) continue;
    failed.push({ rel: d.rel, reason: warning });
    const prefix = `${d.rel}/`;
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i]!.path.startsWith(prefix)) entries[i] = { path: entries[i]!.path, state: { kind: "unreadable", reason: warning } };
    }
    entries.push({ path: prefix, state: { kind: "unreadable", reason: warning } });
  }
  return failed;
}

/**
 * One input's state from a read. For a singleton, an `absent` read of a path
 * that `lstat` still finds is a dangling symlink, which is unreadable rather
 * than absent: the same rule the catalog loader applies to its leaf.
 */
function stateOf(slot: InputSlot, read: BoundedRead): { state: InputState; bytes: Buffer | null } {
  if (read.kind === "ok") return { state: { kind: "ok", sha256: sha256Hex(read.bytes) }, bytes: read.bytes };
  if (read.kind === "absent") {
    if (!slot.singleton) return { state: { kind: "unreadable", reason: "vanished after listing" }, bytes: null };
    try {
      lstatSync(slot.abs);
      return { state: { kind: "unreadable", reason: "exists but could not be resolved" }, bytes: null };
    } catch {
      return { state: { kind: "absent" }, bytes: null };
    }
  }
  return { state: { kind: "unreadable", reason: read.reason }, bytes: null };
}

/** Pass 2: enumerate and hash, nothing parsed. `only` narrows it to some inputs (the loader bracket). */
export function hashPass(root: string, only?: (name: string) => boolean): RevisionEntry[] {
  const storyDir = resolve(root, ".story");
  const { slots, dirs, unlistable } = enumerateInputs(storyDir, only);
  const out = [...unlistable];
  for (const slot of slots) {
    const refused = refusal(slot);
    if (refused !== null) {
      out.push({ path: revisionPath(slot.rel), state: { kind: "unreadable", reason: refused } });
      continue;
    }
    out.push({ path: revisionPath(slot.rel), state: stateOf(slot, readBoundedFileDetailed(slot.abs, slot.maxBytes)).state });
  }
  revalidateDirs(dirs, out);
  return sortEntries(out);
}

function sortEntries(entries: RevisionEntry[]): RevisionEntry[] {
  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf-8"), Buffer.from(b.path, "utf-8")));
}

export function sameEntries(a: readonly RevisionEntry[], b: readonly RevisionEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => {
    const o = b[i]!;
    if (e.path !== o.path || e.state.kind !== o.state.kind) return false;
    return e.state.kind !== "ok" || e.state.sha256 === (o.state as { sha256: string }).sha256;
  });
}

export interface LedgerCatalogs {
  readonly capabilities: Catalog<CapabilityCatalog>;
  readonly glossary: Catalog<GlossaryCatalog>;
}

export type CatalogOutcome<TDoc> =
  | { readonly kind: "ok"; readonly doc: TDoc; readonly present: boolean }
  | { readonly kind: "error"; readonly reason: string };

export interface CapturedItem {
  readonly kind: "ticket" | "issue";
  readonly id: string;
  readonly displayId: string | null;
  readonly citesRulings: readonly string[];
}

export interface Diagnostic {
  readonly file: string;
  readonly id?: string;
  readonly reason: string;
}

/** Pass 1: everything the build needs, parsed from the bytes whose hashes it records. */
export interface LedgerCapture {
  readonly entries: readonly RevisionEntry[];
  /** False when the loaders saw a different set of inputs than the entries record; the capture is retried. */
  readonly consistent: boolean;
  readonly revision: string | null;
  readonly rulingsScan: LoadRulingsResult;
  readonly capabilities: CatalogOutcome<CapabilityCatalog>;
  readonly glossary: CatalogOutcome<GlossaryCatalog>;
  readonly tickets: readonly CapturedItem[];
  readonly issues: readonly CapturedItem[];
  readonly pointer: OrchestratorRootResult;
  readonly diagnostics: readonly Diagnostic[];
}

/** The inputs the shipped loaders read: the ruling directory and the two catalogs. */
function isLoaderInput(name: string): boolean {
  return name === "rulings" || name === "capabilities.json" || name === "glossary.json";
}

function recordingReader(storyDir: string, record: Map<string, BoundedRead>): BoundedReader {
  return (path, maxBytes) => {
    const read = readBoundedFileDetailed(path, maxBytes);
    record.set(revisionPath(relative(storyDir, resolve(path))), read);
    return read;
  };
}

function loadCatalog<TDoc>(catalog: Catalog<TDoc>, root: string, reader: BoundedReader): CatalogOutcome<TDoc> {
  try {
    const { doc, present } = catalog.load(root, reader);
    return { kind: "ok", doc, present };
  } catch (err: unknown) {
    return { kind: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

function parseItem(kind: "ticket" | "issue", rel: string, bytes: Buffer, diagnostics: Diagnostic[]): CapturedItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch {
    diagnostics.push({ file: rel, reason: "invalid JSON" });
    return null;
  }
  const result = (kind === "ticket" ? TicketSchema : IssueSchema).safeParse(parsed);
  if (!result.success) {
    diagnostics.push({ file: rel, reason: "schema mismatch" });
    return null;
  }
  const data = result.data as { id: string; displayId?: string | null; citesRulings?: readonly string[] };
  return {
    kind,
    id: data.id,
    displayId: typeof data.displayId === "string" && data.displayId.length > 0 ? data.displayId : null,
    citesRulings: [...(data.citesRulings ?? [])],
  };
}

export function capturePass(root: string, catalogs: LedgerCatalogs): LedgerCapture {
  const storyDir = resolve(root, ".story");
  const record = new Map<string, BoundedRead>();
  const reader = recordingReader(storyDir, record);

  // The loader bracket: what the loaders own, hashed before they run.
  const before = hashPass(root, isLoaderInput);
  const rulingsScan = loadRulingsSafe(root, reader);
  const capabilities = loadCatalog(catalogs.capabilities, root, reader);
  const glossary = loadCatalog(catalogs.glossary, root, reader);

  const { slots, dirs, unlistable } = enumerateInputs(storyDir);
  const entries: RevisionEntry[] = [...unlistable];
  const diagnostics: Diagnostic[] = unlistable.map((e) => ({ file: e.path, reason: "directory could not be listed" }));
  const tickets: CapturedItem[] = [];
  const issues: CapturedItem[] = [];
  let config: { state: InputState; bytes: Buffer | null } = { state: { kind: "absent" }, bytes: null };

  for (const slot of slots) {
    const path = revisionPath(slot.rel);
    const refused = refusal(slot);
    if (refused !== null) {
      entries.push({ path, state: { kind: "unreadable", reason: refused } });
      diagnostics.push({ file: path, reason: refused });
      continue;
    }
    // A file a loader read is hashed from THAT read: the bytes it parsed.
    const read = record.get(path) ?? readBoundedFileDetailed(slot.abs, slot.maxBytes);
    const got = stateOf(slot, read);
    entries.push({ path, state: got.state });
    if (got.state.kind === "unreadable") diagnostics.push({ file: path, reason: got.state.reason });
    if (slot.rel === "config.json") config = got;
    if (got.bytes === null || slot.rel.split("/").pop()!.startsWith(".")) continue;
    if (slot.rel.startsWith("tickets/")) {
      const item = parseItem("ticket", path, got.bytes, diagnostics);
      if (item) tickets.push(item);
    } else if (slot.rel.startsWith("issues/")) {
      const item = parseItem("issue", path, got.bytes, diagnostics);
      if (item) issues.push(item);
    }
  }

  // A directory replaced while it was read: nothing read from it is kept.
  for (const f of revalidateDirs(dirs, entries)) {
    diagnostics.push({ file: `${f.rel}/`, reason: f.reason });
    if (f.rel === "tickets") tickets.length = 0;
    if (f.rel === "issues") issues.length = 0;
  }

  // The pointer comes from the config bytes the revision covers, never a second read.
  const pointer = resolveOrchestratorRootFrom(root, () => {
    if (config.bytes !== null) return config.bytes.toString("utf-8");
    if (config.state.kind === "absent") throw Object.assign(new Error("no project config"), { code: "ENOENT" });
    throw new Error(config.state.kind === "unreadable" ? config.state.reason : "unreadable");
  });

  for (const w of rulingsScan.warnings) diagnostics.push({ file: "rulings/", reason: w });
  if (capabilities.kind === "error") diagnostics.push({ file: "capabilities.json", reason: capabilities.reason });
  if (glossary.kind === "error") diagnostics.push({ file: "glossary.json", reason: glossary.reason });

  const sorted = sortEntries(entries);
  // A read the loaders made of a path the enumeration no longer lists (a ruling
  // removed after it was parsed) or a loader input that differs from its state
  // before the loaders ran (added, removed, created or changed meanwhile) means
  // the parsed data and the entries describe different ledgers.
  const listed = new Set(sorted.map((e) => e.path));
  const consistent =
    [...record.keys()].every((path) => listed.has(path)) &&
    sameEntries(before, sorted.filter((e) => isLoaderInput(e.path.split("/")[0]!)));
  return {
    entries: sorted,
    consistent,
    revision: ledgerRevision(sorted),
    rulingsScan,
    capabilities,
    glossary,
    tickets,
    issues,
    pointer,
    diagnostics,
  };
}

// --- build ---

export type FreshnessKind = "current" | "changed" | "unverifiable" | "check-incomplete" | "not-checked";
export type ProjectionMode = "full" | "structural";

export interface ProjectionDeps {
  readonly now: () => Date;
  readonly cliVersion: string;
  /** Provenance only. Null when the site runs no git (SessionStart). */
  readonly headCommit: () => Promise<string | null>;
  /** The capability check; the default is `checkCapabilities` on this root. */
  readonly check: (entries: readonly Capability[], state: ProjectState, options: CheckOptions) => Promise<CapabilityCheckReport>;
  /** The orchestrator's board from a resolved pointer; the default reads it. */
  readonly upwardBoard: (pointer: OrchestratorRootResult) => UpwardBoard | undefined;
}

export const defaultUpwardBoard = (pointer: OrchestratorRootResult): UpwardBoard | undefined => loadUpwardBoardAt(pointer);

/** The closed set of resolution kinds; a decoder that lacks one of these cannot read a real ledger. */
export const PROJECTION_RESOLUTION_KINDS = ["current", "resolves-to", "competing", "cycle", "nonaccepted", "missing", "unreadable", "indeterminate"] as const;

export interface ProjectionResolution {
  readonly kind: (typeof PROJECTION_RESOLUTION_KINDS)[number];
  readonly message: string;
  readonly upwardDependency: boolean;
  readonly board?: "orchestrator";
  readonly target?: string;
  readonly ids?: readonly string[];
  readonly lifecycle?: RulingLifecycle;
  readonly reasons?: readonly string[];
  readonly reason?: string;
}

export const CURRENT_LABEL = "current";

/** The closed kind set, each with its field rules (plan B2). */
export function projectResolution(res: CitationResolution, upwardDependency: boolean): ProjectionResolution {
  const board = "board" in res && res.board === "orchestrator" ? { board: "orchestrator" as const } : {};
  const message = citationWarningText(res);
  const base = { upwardDependency, ...board };
  switch (res.status) {
    case "resolved":
      return res.stale
        ? { kind: "resolves-to", message, target: res.current.id, ...base }
        : { kind: "current", message: message === "" ? CURRENT_LABEL : message, ...base };
    case "branch":
      return { kind: "competing", message, ids: [...res.competingSuccessors], ...base };
    case "cycle":
      return { kind: "cycle", message, ids: [...res.chain], ...base };
    case "nonaccepted":
      return { kind: "nonaccepted", message, lifecycle: res.lifecycle, reasons: res.reasons.map((r) => r.code), ...base };
    case "missing":
      return { kind: "missing", message, ...base };
    case "unreadable":
      return { kind: "unreadable", message, ...base };
    case "indeterminate":
      return {
        kind: "indeterminate",
        message,
        reason: res.reason,
        ...(res.reason === "unverifiable-successor" && res.ids !== undefined && { ids: [...res.ids] }),
        ...base,
      };
  }
}

export function freshnessKind(report: CapabilityCheckReport, id: string, mode: ProjectionMode): FreshnessKind {
  if (mode === "structural") return "not-checked";
  const entry = report.entries.find((e) => e.id === id);
  const codes = new Set((entry?.results ?? []).map((r) => r.code));
  if (codes.has("capability_changed")) return "changed";
  if (codes.has("capability_unverifiable_checkpoint")) return "unverifiable";
  // `capability_check_incomplete` is also a REFERENCE result (a ruling that
  // exists but could not be read), which says nothing about freshness; the
  // freshness side of it always lands the id in `unchecked`.
  if (codes.has("capability_check_timeout") || report.unchecked.includes(id)) return "check-incomplete";
  return "current";
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortedStrings = (xs: Iterable<string>): string[] => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The item state the capability check resolves `items` against: ids and display ids only. */
function itemState(capture: LedgerCapture): ProjectState {
  const shape = (i: CapturedItem) => ({ id: i.id, displayId: i.displayId });
  // `checkCapabilities` reads only `tickets` and `issues` off the state.
  return { tickets: capture.tickets.map(shape), issues: capture.issues.map(shape) } as unknown as ProjectState;
}

export async function buildDecisionsProjection(
  capture: LedgerCapture,
  report: CapabilityCheckReport,
  mode: ProjectionMode,
  deps: Pick<ProjectionDeps, "now" | "cliVersion" | "headCommit" | "upwardBoard">,
): Promise<Record<string, unknown>> {
  const scan = capture.rulingsScan;
  const capabilityDoc = capture.capabilities.kind === "ok" ? capture.capabilities.doc : null;
  const glossaryDoc = capture.glossary.kind === "ok" ? capture.glossary.doc : null;
  const items = [...capture.tickets, ...capture.issues];

  const cited = new Set<string>();
  for (const item of items) for (const id of item.citesRulings) cited.add(id);
  for (const c of capabilityDoc?.capabilities ?? []) for (const id of c.rulings ?? []) cited.add(id);
  const citationIds = sortedStrings([...scan.rulings.map((r) => r.id), ...scan.unavailableIds, ...cited]);

  // The gate `buildCitationInputs` applies, over the set this projection
  // resolves: every local ruling as well as every citation, so a ruling nothing
  // cites is still judged against the orchestrator's board.
  const pointerRecorded = capture.pointer.ok || capture.pointer.code !== "no-pointer";
  const upward = citationIds.length > 0 ? deps.upwardBoard(capture.pointer) : undefined;
  const local = buildCitationResolutionContext(scan.rulings, scan.unavailableIds, scan.scanCompleteness, scan.hasUnrecoverableEntries);
  const ctx: CitationResolutionContext = upward ? { ...local, upward } : local;
  const upwardDependency = ctx.upward !== undefined;

  const citedBy = new Map<string, string[]>();
  for (const item of items) {
    for (const id of item.citesRulings) {
      const list = citedBy.get(id) ?? [];
      list.push(item.displayId ?? item.id);
      citedBy.set(id, list);
    }
  }

  const rulings = [...scan.rulings].sort(byId).map((r: Ruling) => {
    const lifecycle = scan.lifecycleById.get(r.id) ?? classifyLifecycle(r).lifecycle;
    return {
      id: r.id,
      lifecycle,
      reasons: classifyLifecycle(r).reasons.map((x) => ({ code: x.code, detail: x.detail })),
      supersedes: r.supersedes ?? null,
      supersededBy: sortedStrings(local.index.successorsByTarget.get(r.id) ?? []),
      uncertainSuccessors: sortedStrings(local.index.uncertainSuccessorsByTarget.get(r.id) ?? []),
      proposalsAgainst: isEffectivelyAccepted(lifecycle) ? sortedStrings(proposalsAgainst(scan.rulings, r.id).map((p) => p.id)) : [],
      citedBy: sortedStrings(citedBy.get(r.id) ?? []),
      record: r,
    };
  });

  const citations = citationIds.map((citedId) => ({
    citedId,
    resolution: projectResolution(resolveCitation(citedId, ctx), upwardDependency),
  }));

  const storedById = new Map((capabilityDoc?.capabilities ?? []).map((c) => [c.id, c]));
  const capabilities = [...report.entries].sort(byId).map((e) => {
    const stored = storedById.get(e.id);
    return {
      id: e.id,
      storedStatus: e.storedStatus,
      effectiveStatus: e.effectiveStatus,
      reasons: e.results.map((r) => ({ code: r.code, cls: r.cls, detail: r.detail })),
      pendingNote: e.pendingNote,
      freshness: {
        kind: freshnessKind(report, e.id, mode),
        ...(stored?.checkedAt !== undefined && { checkedAt: { sha: stored.checkedAt.sha, date: stored.checkedAt.date } }),
      },
      record: stored ?? null,
    };
  });

  const capScan: CapabilityScan =
    capture.capabilities.kind === "ok" ? { ids: capabilityDoc!.capabilities.map((c) => c.id), incomplete: false } : { ids: [], incomplete: true };
  const termEntries: readonly Term[] = glossaryDoc?.terms ?? [];
  const termReport = checkTerms(termEntries, termReferenceIndexFrom(capScan, scan));
  const termById = new Map(termEntries.map((t) => [t.id, t]));
  const terms = [...termReport.entries].sort(byId).map((e) => ({
    id: e.id,
    effectiveStatus: e.effectiveStatus,
    reasons: e.results.map((r) => ({ code: r.code, cls: r.cls, detail: r.detail })),
    pendingNote: e.pendingNote,
    record: termById.get(e.id) ?? null,
  }));

  const diagnostics = [...capture.diagnostics].sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0,
  );

  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    writtenAt: deps.now().toISOString(),
    cliVersion: deps.cliVersion,
    headCommit: await deps.headCommit(),
    ledgerRevision: capture.revision,
    freshnessInputs: { mode, checkedHead: mode === "full" ? report.head : null },
    upwardBoard: {
      pointer: pointerRecorded ? "recorded" : "none",
      state: upward === undefined ? "not-loaded" : upward.kind,
    },
    rulings,
    citations,
    capabilities,
    terms,
    diagnostics,
  };
}

/**
 * Capture, check, re-hash, build: the whole of one projection, retried while
 * the ledger is moving. `betweenPasses` is a test seam for a concurrent edit.
 */
export async function computeDecisionsProjection(
  root: string,
  catalogs: LedgerCatalogs,
  mode: ProjectionMode,
  deps: ProjectionDeps,
  hooks: { readonly betweenPasses?: () => void | Promise<void>; readonly checkpoint?: (phase: string) => void } = {},
): Promise<{ readonly projection: Record<string, unknown>; readonly revision: string | null }> {
  for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
    const capture = capturePass(root, catalogs);
    hooks.checkpoint?.("capture");
    const doc = capture.capabilities.kind === "ok" ? capture.capabilities.doc : null;
    const scope = doc ? catalogConflictScope(doc, doc.capabilities.map((c) => c.id)) : null;
    const report = await deps.check(doc?.capabilities ?? [], itemState(capture), {
      skipFreshness: mode === "structural",
      ...(scope && { conflictedIds: scope.conflictedIds, problemIds: scope.problemIds }),
    });
    hooks.checkpoint?.("check");
    await hooks.betweenPasses?.();
    const second = hashPass(root);
    hooks.checkpoint?.("rehash");
    if (!capture.consistent || !sameEntries(capture.entries, second)) continue;
    const projection = await buildDecisionsProjection(capture, report, mode, deps);
    hooks.checkpoint?.("build");
    return { projection, revision: capture.revision };
  }
  throw new ProjectionError("ledger changing; projection not written");
}

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}
