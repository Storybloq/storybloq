/**
 * T-526 (plan D4): restore ONE ledger record to its projection at a commit.
 *
 * `capability restore`, `term restore` and `ledger restore` are three surfaces
 * over this one core. Each rewrites only its target: one capability entry, one
 * glossary term, or one single-record file (a ruling, note or issue). Every
 * other entry in the same catalog keeps its bytes, and no other file is
 * touched, so a commit that mixed code with a ledger edit can have its ledger
 * half undone without reverting the code.
 *
 * Both commits are read through `readLedgerSnapshot`, never the working tree:
 * `--from` supplies the record to restore, `--expect` the record the caller
 * believes is current. The snapshots are read OUTSIDE the lock (they are
 * immutable history); everything that reads or writes the working tree runs
 * inside the project lock, the same lock `catalog.mutate` takes, in a fixed
 * order where every refusal precedes the write:
 *
 *   1. load the current record
 *   2. conflict      a `_conflicts` record is never restored over or into
 *   3. expect        the current record's projection must equal --expect's
 *   4. absent-source a restore never deletes
 *   5. accepted-ruling  an effectively accepted ruling is never rewritten
 *   6. invariants    the restored ledger must be one a normal write could make
 *   7. write         or report `unchanged` and write nothing
 *
 * The projection compared at step 3 is the RECORD, not the file: the RFC 8785
 * canonical form of the catalog entry by id (every field, `pendingNote`,
 * `status` and `checkedAt` included), or of the whole parsed single-record
 * file. A reformatted file with the same content matches; an entry deferred
 * since --expect does not.
 *
 * CLI-only by design: a restore is an explicit human decision about history,
 * not an agent tool.
 */

import canonicalize from "canonicalize";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CapabilityCatalogSchema, CapabilitySchema, type Capability, type CapabilityCatalog } from "../models/capability.js";
import { GlossaryCatalogSchema, TermSchema, type GlossaryCatalog, type Term } from "../models/glossary.js";
import { IssueSchema } from "../models/issue.js";
import { NoteSchema } from "../models/note.js";
import { RulingSchema, type Ruling } from "../models/ruling.js";
import type { Catalog } from "./catalog.js";
import { capabilityReferenceProblems } from "./capability.js";
import { sanitizeDisplayText } from "./display-text.js";
import { ProjectLoaderError } from "./errors.js";
import { buildTermReferenceIndex, checkTerms, glossaryCatalog, type CapabilityScan } from "./glossary.js";
import { CAPABILITIES_PATH, GLOSSARY_PATH, readLedgerSnapshot, type LedgerSnapshot, type SnapshotGitRunner } from "./ledger-snapshot.js";
import { atomicWrite, guardPath, resolutionWriteContextFor, withProjectLock } from "./project-loader.js";
import { assertResolutionMetadataWrite } from "./resolution-write-guard.js";
import { claimsAcceptance, isEffectivelyAccepted } from "./ruling-lifecycle.js";
import { loadRulingsSafe } from "./ruling-loader.js";

export type RestoreTarget =
  | { readonly kind: "capability"; readonly id: string }
  | { readonly kind: "term"; readonly id: string }
  /** A repo-relative single-record path: `.story/{rulings,notes,issues}/<id>.json`. */
  | { readonly kind: "record"; readonly path: string };

export type RestoreReason = "expect-mismatch" | "conflict" | "absent-source" | "invariant" | "accepted-ruling";

export interface RestoreResult {
  readonly outcome: "restored" | "unchanged";
  readonly target: string;
}

/**
 * The named refusal. Its message is the whole report in a fixed order,
 * `restore-unsafe: <target>: <reason> (<invariant or ->). <detail>`, because
 * the error envelope carries a message and no details field.
 */
export class RestoreUnsafe extends Error {
  constructor(
    readonly target: string,
    readonly reason: RestoreReason,
    readonly invariant: string | null,
    detail: string,
  ) {
    super(`restore-unsafe: ${sanitizeDisplayText(target)}: ${reason} (${invariant ?? "-"}). ${sanitizeDisplayText(detail)}`);
    this.name = "RestoreUnsafe";
  }
}

/** A target or oid the restore cannot act on at all: the caller's input, not the ledger's state. */
export class RestoreInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreInputError";
  }
}

export interface RestoreDeps {
  /** Instantiated beside its CLI surface, which core cannot import from; the caller passes it. */
  readonly capabilityCatalog: Catalog<CapabilityCatalog>;
  /** Test seam: the git subprocess `readLedgerSnapshot` runs. */
  readonly git?: SnapshotGitRunner;
  /** Test seam: called inside the lock, immediately before the write, and only when there is one. */
  readonly beforeWrite?: () => Promise<void>;
}

const RECORD_FAMILIES = ["rulings", "notes", "issues"] as const;
type RecordFamily = (typeof RECORD_FAMILIES)[number];
const RECORD_SCHEMAS = { rulings: RulingSchema, notes: NoteSchema, issues: IssueSchema } as const;

interface RecordPath {
  readonly path: string;
  readonly family: RecordFamily;
  readonly id: string;
}

/**
 * Direct children of the three single-record families, in either id form (a
 * legacy `N-001.json` or a hash `n-*.json`). Tickets and lessons are refused
 * by name: a ticket carries derived and umbrella structure a one-file restore
 * would not respect, and neither is in D4's scope.
 */
function parseRecordPath(path: string): RecordPath {
  const parts = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || parts.length !== 3 || parts[0] !== ".story") {
    throw new RestoreInputError(
      `ledger restore takes a repo-relative path of the form .story/<rulings|notes|issues>/<id>.json, not ${sanitizeDisplayText(path)}`,
    );
  }
  const [, family, file] = parts as [string, string, string];
  // T-537 audit: owner checkpoints and checkpoint evidence live only on
  // tickets, so refusing tickets here is what keeps a restore from replacing
  // a checkpoint or its evidence. The lock's strict load refuses a schema
  // this build cannot read.
  if (family === "tickets" || family === "lessons") {
    throw new RestoreInputError(`ledger restore does not restore ${family}: it covers rulings, notes and issues only`);
  }
  if (!(RECORD_FAMILIES as readonly string[]).includes(family)) {
    throw new RestoreInputError(`ledger restore covers .story/rulings, .story/notes and .story/issues, not ${sanitizeDisplayText(path)}`);
  }
  const id = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new RestoreInputError(`${sanitizeDisplayText(path)} is not a record file name (<id>.json)`);
  }
  return { path, family: family as RecordFamily, id };
}

function labelOf(target: RestoreTarget): string {
  return target.kind === "record" ? target.path : `${target.kind} ${target.id}`;
}

async function snapshotAt(root: string, flag: string, oid: string, git?: SnapshotGitRunner): Promise<LedgerSnapshot> {
  const snapshot = await readLedgerSnapshot(root, oid, git);
  if (snapshot.availability.kind !== "ok") {
    throw new RestoreInputError(`${flag} ${sanitizeDisplayText(oid, 80)}: ${snapshot.availability.reason}`);
  }
  return snapshot;
}

/** A record at one side of the comparison: absent, or present with its value. */
export type Side<T> = { readonly present: false } | { readonly present: true; readonly value: T };
export const ABSENT = { present: false } as const;

/**
 * The catalog entry by id at a snapshot. An unreadable catalog throws
 * `RestoreInputError`: it is never read as the entry being absent. T-527's
 * knowledge review walks history with this same lookup.
 */
export function catalogEntryAt<T extends { id: string }>(snapshot: LedgerSnapshot, kind: "capability" | "term", id: string, flag: string): Side<T> {
  const read = kind === "capability" ? snapshot.capabilities() : snapshot.terms();
  if (read.kind === "absent") return ABSENT;
  if (read.kind !== "ok") {
    const file = kind === "capability" ? CAPABILITIES_PATH : GLOSSARY_PATH;
    throw new RestoreInputError(`${flag} ${snapshot.commit?.slice(0, 12) ?? snapshot.oid}: ${file} could not be read (${read.reason})`);
  }
  const entry = (read.entries as unknown as readonly T[]).find((e) => e.id === id);
  return entry === undefined ? ABSENT : { present: true, value: entry };
}

/** The committed bytes plus their JSON; a path never fetched is an input error, not an absence. */
function recordAt(snapshot: LedgerSnapshot, path: string, flag: string): Side<{ bytes: Buffer; json: unknown }> {
  const status = snapshot.status(path);
  if (status.kind === "absent") return ABSENT;
  const bytes = snapshot.bytes(path);
  if (bytes === null) {
    const reason = status.kind === "unreadable" ? status.reason : "not readable";
    throw new RestoreInputError(`${flag} ${snapshot.commit?.slice(0, 12) ?? snapshot.oid}: ${sanitizeDisplayText(path)} could not be read (${reason})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf-8"));
  } catch {
    json = undefined;
  }
  return { present: true, value: { bytes, json } };
}

/**
 * The ONE projection: RFC 8785 canonical JSON of the record, null when absent.
 * Restore's --expect compare and T-527's provenance walk both use it, so "the
 * record changed" means the same thing to each.
 */
export function projectionOf(side: Side<unknown>): string | null {
  return side.present ? (canonicalize(side.value) ?? null) : null;
}

function hasConflicts(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const conflicts = (value as Record<string, unknown>)._conflicts;
  return Array.isArray(conflicts) && conflicts.length > 0;
}

/** Steps 2 to 4, shared by every target kind. */
function checkCommon(label: string, current: Side<unknown>, expected: Side<unknown>, source: Side<unknown>, oids: { from: string; expect: string }): void {
  if ((current.present && hasConflicts(current.value)) || (source.present && hasConflicts(source.value))) {
    throw new RestoreUnsafe(label, "conflict", null, "the record carries unresolved _conflicts; resolve them before restoring");
  }
  if (projectionOf(current) !== projectionOf(expected)) {
    throw new RestoreUnsafe(
      label,
      "expect-mismatch",
      null,
      current.present === expected.present
        ? `the current record does not match its projection at ${oids.expect}; it moved since`
        : `the record is ${current.present ? "present" : "absent"} now but ${expected.present ? "present" : "absent"} at ${oids.expect}`,
    );
  }
  if (!source.present) {
    throw new RestoreUnsafe(label, "absent-source", null, `the record is absent at ${oids.from}, and a restore never deletes`);
  }
}

async function beforeWrite(deps: RestoreDeps): Promise<void> {
  if (deps.beforeWrite !== undefined) await deps.beforeWrite();
}

function replaced<T extends { id: string }>(entries: readonly T[], next: T): T[] {
  const index = entries.findIndex((e) => e.id === next.id);
  if (index === -1) return [...entries, next];
  const out = [...entries];
  out[index] = next;
  return out;
}

function currentEntry<T extends { id: string }>(entries: readonly T[], id: string): Side<T> {
  const entry = entries.find((e) => e.id === id);
  return entry === undefined ? ABSENT : { present: true, value: entry };
}

async function restoreCapability(
  root: string,
  label: string,
  id: string,
  from: LedgerSnapshot,
  expect: LedgerSnapshot,
  deps: RestoreDeps,
): Promise<RestoreResult> {
  const source = catalogEntryAt<Capability>(from, "capability", id, "--from");
  const expected = catalogEntryAt<Capability>(expect, "capability", id, "--expect");
  let result!: RestoreResult;
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const doc = deps.capabilityCatalog.load(root).doc;
    const current = currentEntry(doc.capabilities, id);
    checkCommon(label, current, expected, source, { from: from.oid, expect: expect.oid });
    const entry = (source as { value: Capability }).value;

    const parsed = CapabilitySchema.safeParse(entry);
    if (!parsed.success) throw new RestoreUnsafe(label, "invariant", "schema", "the entry at --from does not satisfy the capability schema");
    const name = entry.name.trim().toLowerCase();
    const holder = doc.capabilities.find((c) => c.id !== id && c.name.trim().toLowerCase() === name);
    if (holder !== undefined) {
      throw new RestoreUnsafe(label, "invariant", "capability-name-collision", `the restored name is now held by ${holder.id}`);
    }
    const dangling = capabilityReferenceProblems(root, state, entry).filter((r) => r.cls === "structural" || r.cls === "incomplete");
    if (dangling.length > 0) {
      throw new RestoreUnsafe(label, "invariant", "dangling-reference", dangling.map((r) => r.detail).join("; "));
    }
    const next = { ...doc, capabilities: replaced(doc.capabilities, entry) };
    if (!CapabilityCatalogSchema.safeParse(next).success) {
      throw new RestoreUnsafe(label, "invariant", "schema", "the restored catalog does not satisfy the capability catalog schema");
    }

    if (projectionOf(current) === projectionOf(source)) {
      result = { outcome: "unchanged", target: label };
      return;
    }
    await beforeWrite(deps);
    await deps.capabilityCatalog.writeUnlocked(root, next);
    result = { outcome: "restored", target: label };
  });
  return result;
}

function capabilityScanOf(root: string, catalog: Catalog<CapabilityCatalog>): CapabilityScan {
  try {
    return { ids: new Set(catalog.load(root).doc.capabilities.map((c) => c.id)), incomplete: false };
  } catch {
    return { ids: new Set<string>(), incomplete: true };
  }
}

async function restoreTerm(
  root: string,
  label: string,
  id: string,
  from: LedgerSnapshot,
  expect: LedgerSnapshot,
  deps: RestoreDeps,
): Promise<RestoreResult> {
  const source = catalogEntryAt<Term>(from, "term", id, "--from");
  const expected = catalogEntryAt<Term>(expect, "term", id, "--expect");
  let result!: RestoreResult;
  await withProjectLock(root, { strict: true }, async () => {
    const doc: GlossaryCatalog = glossaryCatalog.load(root).doc;
    const current = currentEntry(doc.terms, id);
    checkCommon(label, current, expected, source, { from: from.oid, expect: expect.oid });
    const entry = (source as { value: Term }).value;

    if (!TermSchema.safeParse(entry).success) {
      throw new RestoreUnsafe(label, "invariant", "schema", "the entry at --from does not satisfy the term schema");
    }
    const next = { ...doc, terms: replaced(doc.terms, entry) };
    // The entry parses on its own, so what the document refuses is ownership:
    // a word (term or alias) another entry now holds.
    if (!GlossaryCatalogSchema.safeParse(next).success) {
      throw new RestoreUnsafe(label, "invariant", "term-collision", "a restored term or alias is now owned by another entry");
    }
    const report = checkTerms([entry], buildTermReferenceIndex(root, capabilityScanOf(root, deps.capabilityCatalog)));
    const dangling = (report.entries[0]?.results ?? []).filter((r) => r.cls === "structural" || r.cls === "incomplete");
    if (dangling.length > 0) {
      throw new RestoreUnsafe(label, "invariant", "dangling-reference", dangling.map((r) => r.detail).join("; "));
    }

    if (projectionOf(current) === projectionOf(source)) {
      result = { outcome: "unchanged", target: label };
      return;
    }
    await beforeWrite(deps);
    await glossaryCatalog.writeUnlocked(root, next);
    result = { outcome: "restored", target: label };
  });
  return result;
}

/** The working-tree record, read inside the lock. Not a regular file is an input error; unparseable is corruption. */
function currentRecordAt(abs: string, path: string): Side<unknown> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
    throw err;
  }
  if (!stat.isFile()) throw new RestoreInputError(`${sanitizeDisplayText(path)} is not a regular file`);
  try {
    return { present: true, value: JSON.parse(readFileSync(abs, "utf-8")) };
  } catch {
    throw new ProjectLoaderError("project_corrupt", `${sanitizeDisplayText(path)} is not valid JSON, so it cannot be compared with --expect`);
  }
}

async function restoreSingleRecord(
  root: string,
  record: RecordPath,
  from: LedgerSnapshot,
  expect: LedgerSnapshot,
  deps: RestoreDeps,
): Promise<RestoreResult> {
  const label = record.path;
  const source = recordAt(from, record.path, "--from");
  const expectedRaw = recordAt(expect, record.path, "--expect");
  if (expectedRaw.present && expectedRaw.value.json === undefined) {
    throw new RestoreInputError(`--expect ${sanitizeDisplayText(expect.oid, 80)}: ${sanitizeDisplayText(record.path)} is not valid JSON there`);
  }
  const expected: Side<unknown> = expectedRaw.present ? { present: true, value: expectedRaw.value.json } : ABSENT;
  const sourceJson: Side<unknown> = source.present ? { present: true, value: source.value.json } : ABSENT;
  const abs = join(resolve(root), record.path);

  let result!: RestoreResult;
  try {
    await withProjectLock(root, { strict: true }, async () => {
      const current = currentRecordAt(abs, record.path);
      checkCommon(label, current, expected, sourceJson, { from: from.oid, expect: expect.oid });
      const { bytes, json } = (source as { value: { bytes: Buffer; json: unknown } }).value;

      if (record.family === "rulings") {
        if (current.present) {
          const scan = loadRulingsSafe(root);
          const lifecycle = scan.lifecycleById.get(record.id);
          if (lifecycle === undefined) {
            throw new RestoreUnsafe(label, "accepted-ruling", null, "the current ruling's lifecycle could not be determined, so it may be accepted");
          }
          if (isEffectivelyAccepted(lifecycle)) {
            throw new RestoreUnsafe(label, "accepted-ruling", null, `the ruling is ${lifecycle} now; an accepted ruling is superseded, never rewritten`);
          }
        }
      }

      const parsed = RECORD_SCHEMAS[record.family].safeParse(json);
      if (json === undefined || !parsed.success) {
        throw new RestoreUnsafe(label, "invariant", "schema", `the record at --from does not satisfy the ${record.family} schema`);
      }
      if ((parsed.data as { id: string }).id !== record.id) {
        throw new RestoreUnsafe(label, "invariant", "filename-id", "the record's id at --from is not its filename");
      }
      if (record.family === "rulings" && claimsAcceptance(parsed.data as Ruling)) {
        throw new RestoreUnsafe(label, "invariant", "acceptance-claim", "the record at --from claims acceptance; acceptance is recorded by ruling accept, never restored");
      }

      // The write takes text, so the blob must survive a UTF-8 round trip: an
      // invalid sequence would be replaced with U+FFFD and the restore would
      // report the exact bytes while writing others.
      const text = bytes.toString("utf-8");
      if (!Buffer.from(text, "utf-8").equals(bytes)) {
        throw new RestoreUnsafe(label, "invariant", "utf-8", "the record at --from is not valid UTF-8, so it cannot be restored byte for byte");
      }

      if (projectionOf(current) === projectionOf(sourceJson)) {
        result = { outcome: "unchanged", target: label };
        return;
      }
      // T-486 2c: restore writes outside prepareIssueWrite, so it runs the
      // same resolution-metadata boundary, against the record it replaces.
      if (record.family === "issues") {
        const prior = current.present && typeof current.value === "object" && current.value !== null && !Array.isArray(current.value)
          ? (current.value as Record<string, unknown>)
          : current.present ? "unknown" : {};
        try {
          assertResolutionMetadataWrite(resolutionWriteContextFor(root), record.path, prior, parsed.data as Record<string, unknown>);
        } catch (err) {
          if (err instanceof ProjectLoaderError && err.code === "conflict") {
            throw new RestoreUnsafe(label, "invariant", "resolution-metadata", err.message);
          }
          throw err;
        }
      }
      const wrapDir = resolve(root, ".story");
      mkdirSync(dirname(abs), { recursive: true });
      await guardPath(abs, wrapDir);
      await beforeWrite(deps);
      await atomicWrite(abs, text);
      result = { outcome: "restored", target: label };
    });
  } catch (err) {
    // The lock's own load refuses ANY conflicted ticket, issue or note before
    // the handler runs. When the conflicted record is this target, that is the
    // restore's conflict refusal; anything else is the project's state and
    // propagates as itself.
    if (err instanceof ProjectLoaderError && err.code === "conflict") {
      let target: Side<unknown> = ABSENT;
      try {
        target = currentRecordAt(abs, record.path);
      } catch {
        // Unreadable now: not classifiable as this target's conflict.
      }
      if (target.present && hasConflicts(target.value)) {
        throw new RestoreUnsafe(label, "conflict", null, "the record carries unresolved _conflicts; resolve them before restoring");
      }
    }
    throw err;
  }
  return result;
}

/**
 * Restore `target` to its projection at `fromOid`, provided it currently
 * equals its projection at `expectOid`. Throws `RestoreUnsafe` for a refusal
 * and `RestoreInputError` for a target or oid it cannot act on.
 */
export async function restoreRecord(
  root: string,
  target: RestoreTarget,
  fromOid: string,
  expectOid: string,
  deps: RestoreDeps,
): Promise<RestoreResult> {
  const record = target.kind === "record" ? parseRecordPath(target.path) : null;
  const from = await snapshotAt(root, "--from", fromOid, deps.git);
  const expect = await snapshotAt(root, "--expect", expectOid, deps.git);
  if (record !== null) return restoreSingleRecord(root, record, from, expect, deps);
  const label = labelOf(target);
  const id = (target as { id: string }).id;
  return target.kind === "capability" ? restoreCapability(root, label, id, from, expect, deps) : restoreTerm(root, label, id, from, expect, deps);
}
