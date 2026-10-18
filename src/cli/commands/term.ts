/**
 * T-524: the `term` surface over the glossary catalog.
 *
 * ADVISORY (G-A). Every handler here either PRINTS terms or EDITS them on an
 * explicit instruction. None of them acts on a match: `term match` returns
 * what it found and changes nothing, and no other command consults the
 * glossary to decide whether to accept its input. A term is something a reader
 * is shown, never a rule applied to them.
 *
 * Shaped after `capability.ts` deliberately, down to the helper names, because
 * the two are one mechanism with two contracts and a reader moving between
 * them should not have to relearn the surface.
 */

import {
  glossaryCatalog,
  checkTerms,
  matchTerms,
  buildTermReferenceIndex,
  type CapabilityScan,
  sortTerms,
  termDigest,
  type TermCheckReport,
  type TermCheckEntry,
} from "../../core/glossary.js";
import { GlossaryCatalogSchema, TermSchema, normalizeTermKey, type Term } from "../../models/glossary.js";
import { hasPendingNote, PendingNoteSchema } from "../../models/capability.js";
import { summarizeZodIssues, describeSchemaIssues } from "../../core/zod-issues.js";
import { sanitizeDisplayText } from "../../core/display-text.js";
import { successEnvelope, escapeMarkdownInline, formatError, ExitCode } from "../../core/output-formatter.js";
import { capabilityCatalog, catalogText, clearedFields, restoreCommand, type RestoreInput } from "./capability.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

export interface TermWriteInput {
  readonly id: string;
  readonly term?: string;
  readonly aliases?: readonly string[];
  readonly definition?: string;
  readonly distinction?: string;
  readonly capabilities?: readonly string[];
  readonly rulings?: readonly string[];
  readonly core?: boolean;
  readonly addedBy?: string;
  /** T-526 (3.7): remove the pending note in this update. */
  readonly clearPending?: boolean;
  /** ISS-1287 (update only): optional fields to remove, from `TERM_CLEARABLE`. */
  readonly clear?: readonly string[];
}

/** ISS-1287: the optional scalar fields `term update --clear` removes (`core` is cleared by setting it false). */
export const TERM_CLEARABLE: readonly string[] = ["distinction", "addedBy"];

// --- shared ---

function defined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function parseEntry(candidate: unknown): Term {
  const parsed = TermSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CliValidationError("invalid_input", describeSchemaIssues(summarizeZodIssues(parsed.error), parsed.error.issues.length));
  }
  return parsed.data;
}

/**
 * The names an entry claims, normalized. Used only to word a FRIENDLY refusal:
 * the schema is what actually enforces ownership, on every write and on every
 * load. This exists because the schema's message can only name an array index,
 * and an author who typed a colliding alias wants the owning ENTRY's id.
 */
function claimsOf(entry: Term): string[] {
  return [entry.term, ...(entry.aliases ?? [])].map(normalizeTermKey);
}

function ownerOf(entries: readonly Term[], claim: string, exceptId?: string): Term | undefined {
  return entries.find((e) => e.id !== exceptId && claimsOf(e).includes(claim));
}

/** Now, in the form the schema requires. Never taken as a flag: a timestamp the caller chose is not evidence of anything. */
function stamp(): string {
  return new Date().toISOString();
}

/**
 * A glossary read must not fail because the OTHER catalog is broken, so a
 * capability file that cannot be loaded leaves the id set empty and the
 * command still runs. The capability surface reports that file's own problems.
 *
 * What it must NOT do is let the empty set read as "no such capability". The
 * `incomplete` flag carries the difference, and `checkTerms` downgrades an
 * unresolved link to unresolved instead of unknown when it is set. Absence is
 * not taint: `load` returns `present: false` without throwing for a catalog
 * that is not there, which IS a determinate answer, so the id is genuinely
 * unknown and the error stands.
 *
 * Exported for `validate`, which builds the same index without going through a
 * handler and would otherwise repeat this distinction and get it wrong.
 */
export function capabilityScan(root: string): CapabilityScan {
  try {
    return { ids: new Set(capabilityCatalog.load(root).doc.capabilities.map((c) => c.id)), incomplete: false };
  } catch {
    return { ids: new Set<string>(), incomplete: true };
  }
}

function reportFor(root: string, entries: readonly Term[]): TermCheckReport {
  return checkTerms(entries, buildTermReferenceIndex(root, capabilityScan(root)));
}

function resultsOf(report: TermCheckReport, id: string): TermCheckEntry | undefined {
  return report.entries.find((e) => e.id === id);
}

function byTerm(entries: readonly Term[]): Term[] {
  return [...entries].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
}

/** T-526 (3.7): pending entries first, each group by term. */
function pendingFirst(entries: readonly Term[]): Term[] {
  const sorted = byTerm(entries);
  return [...sorted.filter((t) => hasPendingNote(t)), ...sorted.filter((t) => !hasPendingNote(t))];
}

// --- rendering ---

function renderResults(entry: TermCheckEntry | undefined): string[] {
  if (!entry || entry.results.length === 0) return [];
  return entry.results.map((r) => `    - [${r.cls}] ${escapeMarkdownInline(sanitizeDisplayText(r.detail))}`);
}

function renderEntry(entry: Term, checked: TermCheckEntry | undefined): string[] {
  const lines = [
    `## ${catalogText(entry.term)} (${catalogText(entry.id)})${entry.core === true ? " [core]" : ""}`,
    "",
    catalogText(entry.definition),
    "",
  ];
  if (entry.distinction) lines.push(`- Distinction: ${catalogText(entry.distinction)}`);
  if (entry.aliases?.length) lines.push(`- Also called: ${entry.aliases.map((a) => catalogText(a)).join(", ")}`);
  if (entry.capabilities?.length) lines.push(`- Capabilities: ${entry.capabilities.map((c) => catalogText(c)).join(", ")}`);
  if (entry.rulings?.length) lines.push(`- Rulings: ${entry.rulings.map((r) => catalogText(r)).join(", ")}`);
  if (entry.addedBy) lines.push(`- Added by: ${catalogText(entry.addedBy)}`);
  lines.push(`- Updated: ${catalogText(entry.updatedAt)}`);
  if (hasPendingNote(entry)) lines.push(`- Pending: review: ${catalogText(entry.pendingNote!)}`);
  if (checked && checked.results.length > 0) {
    lines.push("- Findings:");
    lines.push(...renderResults(checked));
  }
  return lines;
}

/**
 * The line every glossary surface carries. A glossary is advisory, and a
 * reader who does not know that will read a missing term as a verdict.
 */
const ADVISORY = "_Terms are advisory: they say what a word means here, and nothing renames, rewrites or refuses on one._";

// --- read handlers ---

export async function handleTermList(
  options: { core?: boolean; thin?: boolean; digest?: boolean },
  ctx: CommandContext,
): Promise<CommandResult> {
  const { doc, present } = glossaryCatalog.load(ctx.root);

  if (options.digest === true) {
    const digest = termDigest(doc.terms);
    if (ctx.format === "json") {
      return { output: JSON.stringify(successEnvelope({ present, ...digest }), null, 2) };
    }
    const omitted = digest.omittedCore + digest.omittedNonCore;
    const names = digest.names.length > 0 ? digest.names.map((n) => catalogText(n)).join(", ") : "none";
    const tail = omitted > 0 ? ` (${omitted} more, \`storybloq term list\`)` : "";
    const pending = digest.pending > 0 ? ` (pending: ${digest.pending}, listed first)` : "";
    return { output: `Glossary: ${names}${tail}${pending}` };
  }

  const report = reportFor(ctx.root, doc.terms);
  const pending = doc.terms.filter((t) => hasPendingNote(t)).length;
  const rows = pendingFirst(doc.terms)
    .filter((t) => options.core !== true || t.core === true)
    .filter((t) => options.thin !== true || report.thinIds.includes(t.id));

  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        successEnvelope({
          present,
          glossarySize: doc.terms.length,
          pending,
          terms: rows.map((t) => ({ ...t, results: resultsOf(report, t.id)?.results ?? [] })),
        }),
        null,
        2,
      ),
    };
  }

  const lines = [`# Glossary (${rows.length} of ${doc.terms.length}${pending > 0 ? `, pending: ${pending}` : ""})`, "", ADVISORY];
  if (!present) {
    lines.push("", "No glossary yet. `storybloq term add` creates the first entry.");
    return { output: lines.join("\n") };
  }
  if (rows.length === 0) {
    lines.push("", "No term matches that filter.");
    return { output: lines.join("\n") };
  }
  for (const entry of rows) {
    lines.push("", `- **${catalogText(entry.term)}** (${catalogText(entry.id)})${entry.core === true ? " [core]" : ""}`);
    lines.push(`  ${catalogText(entry.definition)}`);
    if (entry.distinction) lines.push(`  Not: ${catalogText(entry.distinction)}`);
    if (hasPendingNote(entry)) lines.push(`  review: ${catalogText(entry.pendingNote!)}`);
    lines.push(...renderResults(resultsOf(report, entry.id)));
  }
  return { output: lines.join("\n") };
}

export async function handleTermGet(id: string, ctx: CommandContext): Promise<CommandResult> {
  const { doc } = glossaryCatalog.load(ctx.root);
  const entry = doc.terms.find((t) => t.id === id);
  if (!entry) {
    return {
      output: formatError("not_found", `Term ${catalogText(id)} not found.`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  const report = reportFor(ctx.root, [entry]);
  if (ctx.format === "json") {
    return { output: JSON.stringify(successEnvelope({ term: entry, results: resultsOf(report, entry.id)?.results ?? [] }), null, 2) };
  }
  return { output: [...renderEntry(entry, resultsOf(report, entry.id)), "", ADVISORY].join("\n") };
}

export async function handleTermMatch(text: string, ctx: CommandContext): Promise<CommandResult> {
  if (text.trim().length === 0) {
    throw new CliValidationError("invalid_input", "`term match --text` needs text to search: pass the item's title and description.");
  }
  const { doc } = glossaryCatalog.load(ctx.root);
  const matches = matchTerms(text, doc.terms);
  const byId = new Map(doc.terms.map((t) => [t.id, t]));

  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        successEnvelope({
          glossarySize: doc.terms.length,
          matches: matches.map((m) => ({
            ...m,
            definition: byId.get(m.id)?.definition,
            distinction: byId.get(m.id)?.distinction,
          })),
          advisory: true,
        }),
        null,
        2,
      ),
    };
  }

  if (matches.length === 0) {
    return { output: [`# Terms matched (0 of ${doc.terms.length})`, "", "No glossary terms matched.", "", ADVISORY].join("\n") };
  }
  const lines = [`# Terms matched (${matches.length} of ${doc.terms.length})`, ""];
  for (const match of matches) {
    const entry = byId.get(match.id);
    lines.push(`- **${catalogText(match.term)}** (matched \`${catalogText(match.matchedWord)}\`${match.viaAlias ? ", an alias" : ""})`);
    if (entry) lines.push(`  ${catalogText(entry.definition)}`);
    if (entry?.distinction) lines.push(`  Not: ${catalogText(entry.distinction)}`);
  }
  lines.push("", ADVISORY);
  return { output: lines.join("\n") };
}

export async function handleTermCheck(ctx: CommandContext): Promise<CommandResult> {
  const { doc, present } = glossaryCatalog.load(ctx.root);
  const report = reportFor(ctx.root, doc.terms);

  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        successEnvelope({ present, glossarySize: doc.terms.length, entries: report.entries, errorIds: report.errorIds, thinIds: report.thinIds, incompleteIds: report.incompleteIds }),
        null,
        2,
      ),
      exitCode: report.errorIds.length > 0 ? ExitCode.USER_ERROR : undefined,
      errorCode: report.errorIds.length > 0 ? "invalid_input" : undefined,
    };
  }

  const lines = [`# Term check (${doc.terms.length} terms)`, ""];
  if (report.errorIds.length === 0 && report.thinIds.length === 0 && report.incompleteIds.length === 0) {
    lines.push("Every term resolves and carries both a distinction and a capability link.");
    return { output: lines.join("\n") };
  }
  for (const entry of report.entries) {
    if (entry.results.length === 0) continue;
    lines.push(`- ${catalogText(entry.id)}`);
    lines.push(...renderResults(entry));
  }
  lines.push("", `Errors: ${report.errorIds.length}. Thin: ${report.thinIds.length}. Unresolved: ${report.incompleteIds.length}.`);
  return {
    output: lines.join("\n"),
    exitCode: report.errorIds.length > 0 ? ExitCode.USER_ERROR : undefined,
    errorCode: report.errorIds.length > 0 ? "invalid_input" : undefined,
  };
}

// --- write handlers ---

function termNotFound(id: string, format: OutputFormat): CommandResult {
  return {
    output: formatError("not_found", `Term ${catalogText(id)} not found.`, format),
    exitCode: ExitCode.USER_ERROR,
    errorCode: "not_found",
  };
}

function termRefused(message: string, format: OutputFormat): CommandResult {
  return { output: formatError("invalid_input", message, format), exitCode: ExitCode.USER_ERROR, errorCode: "invalid_input" };
}

/**
 * A refusal decided INSIDE a transaction. Thrown, never returned, because
 * `mutate` writes whatever document its function returns, the unchanged one
 * included: refusing by returning `current` would still rewrite the file,
 * reformatting a hand-edited one or creating one that was absent, to report
 * that nothing changed. Throwing aborts the transaction before the write.
 *
 * Only `refusing` catches it, and it catches nothing else, so a real failure
 * inside a transaction (a schema refusal, a lost lock) still propagates as
 * itself.
 */
class TermRefusal extends Error {
  constructor(readonly result: CommandResult) {
    super("term write refused");
  }
}

async function refusing(run: () => Promise<CommandResult>): Promise<CommandResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof TermRefusal) return err.result;
    throw err;
  }
}

export async function handleTermAdd(input: TermWriteInput, format: OutputFormat, root: string): Promise<CommandResult> {
  const entry = parseEntry(
    defined({
      id: input.id,
      term: input.term,
      aliases: input.aliases ? [...input.aliases] : undefined,
      definition: input.definition,
      distinction: input.distinction,
      capabilities: input.capabilities ? [...input.capabilities] : undefined,
      rulings: input.rulings ? [...input.rulings] : undefined,
      core: input.core,
      addedBy: input.addedBy,
      updatedAt: stamp(),
    }),
  );

  // Both checks run INSIDE the transaction, against the document the write
  // will actually extend. Checking a document read beforehand would let two
  // adds racing on one id or one word both see it free.
  return refusing(async () => {
    const doc = await glossaryCatalog.mutate(root, (current) => {
      if (current.terms.some((t) => t.id === entry.id)) {
        throw new TermRefusal(termRefused(`Term ${catalogText(entry.id)} already exists. Use \`term update\` to change it.`, format));
      }
      for (const claim of claimsOf(entry)) {
        const owner = ownerOf(current.terms, claim);
        if (owner) {
          throw new TermRefusal(
            termRefused(
              `${catalogText(claim)} is already owned by ${catalogText(owner.id)}. One word belongs to one entry: edit that entry, or choose another name.`,
              format,
            ),
          );
        }
      }
      return { ...current, terms: sortTerms([...current.terms, entry]) };
    });
    if (format === "json") return { output: JSON.stringify(successEnvelope({ term: entry, glossarySize: doc.terms.length }), null, 2) };
    return { output: `Added ${catalogText(entry.id)} (${catalogText(entry.term)}). Glossary: ${doc.terms.length}.` };
  });
}

export async function handleTermUpdate(input: TermWriteInput, format: OutputFormat, root: string): Promise<CommandResult> {
  const cleared = clearedFields(input.clear, TERM_CLEARABLE, input as unknown as Readonly<Record<string, unknown>>, "term update");
  return refusing(async () => {
    const doc = await glossaryCatalog.mutate(root, (current) => {
      const index = current.terms.findIndex((t) => t.id === input.id);
      if (index === -1) throw new TermRefusal(termNotFound(input.id, format));
      const previous = current.terms[index]!;
      // A supplied list flag REPLACES the stored list; an omitted one leaves it
      // alone. Merging would make an alias impossible to remove through the CLI.
      const next = parseEntry(
        defined({
          ...previous,
          term: input.term ?? previous.term,
          aliases: input.aliases ? [...input.aliases] : previous.aliases,
          definition: input.definition ?? previous.definition,
          distinction: cleared.has("distinction") ? undefined : (input.distinction ?? previous.distinction),
          capabilities: input.capabilities ? [...input.capabilities] : previous.capabilities,
          rulings: input.rulings ? [...input.rulings] : previous.rulings,
          core: input.core ?? previous.core,
          addedBy: cleared.has("addedBy") ? undefined : (input.addedBy ?? previous.addedBy),
          pendingNote: input.clearPending === true ? undefined : previous.pendingNote,
          updatedAt: stamp(),
        }),
      );
      for (const claim of claimsOf(next)) {
        const owner = ownerOf(current.terms, claim, next.id);
        if (owner) throw new TermRefusal(termRefused(`${catalogText(claim)} is already owned by ${catalogText(owner.id)}.`, format));
      }
      const terms = [...current.terms];
      terms[index] = next;
      return { ...current, terms: sortTerms(terms) };
    });
    const entry = doc.terms.find((t) => t.id === input.id)!;
    if (format === "json") return { output: JSON.stringify(successEnvelope({ term: entry }), null, 2) };
    return { output: `Updated ${catalogText(entry.id)} (${catalogText(entry.term)}).` };
  });
}

/**
 * T-526 (3.7): record work owed on a term without doing it. Changes only
 * `pendingNote` and runs no reference check, for the reason `capability defer`
 * gives: the term is usually being deferred because something it points at
 * moved. `updatedAt` is left alone too, since the definition did not change.
 * No conflict-record refusal: that mechanism does not exist yet (T-529).
 */
export async function handleTermDefer(input: { id: string; note: string }, format: OutputFormat, root: string): Promise<CommandResult> {
  const note = input.note.trim();
  if (note.length === 0) {
    throw new CliValidationError("invalid_input", "`term defer` needs --note naming the owed work; an empty note would flag nothing.");
  }
  const parsedNote = PendingNoteSchema.safeParse(note);
  if (!parsedNote.success) throw new CliValidationError("invalid_input", parsedNote.error.issues[0]?.message ?? "invalid note");
  return refusing(async () => {
    const doc = await glossaryCatalog.mutate(root, (current) => {
      const index = current.terms.findIndex((t) => t.id === input.id);
      if (index === -1) throw new TermRefusal(termNotFound(input.id, format));
      const terms = [...current.terms];
      terms[index] = { ...terms[index]!, pendingNote: note };
      return { ...current, terms };
    });
    const entry = doc.terms.find((t) => t.id === input.id)!;
    if (format === "json") return { output: JSON.stringify(successEnvelope({ term: entry }), null, 2) };
    return { output: `Deferred ${catalogText(entry.id)}: review: ${catalogText(note)}. Clear with \`term update ${catalogText(entry.id)} --clear-pending\`.` };
  });
}

/**
 * NO CROSS-FILE OPERATION. A term referenced by a capability is not removed
 * and the other file is not edited to make it removable: two atomic renames
 * are not one transaction, and a journal is not worth building for a removal.
 * The refusal lists the referencing ids and the edits that clear them, so the
 * caller can do in two deliberate steps what this will not do in one.
 */
/**
 * Why a term cannot be deleted right now, or null when nothing stops it: a
 * capability references it, or the inventory could not be read (so nothing
 * can say it is unreferenced). One computation for `term remove` and for
 * `resolve glossary --keep` (T-529), which calls it inside the resolution
 * lock so the answer cannot go stale before the write.
 */
export function termDeletionRefusal(id: string, root: string): string | null {
  const referencing = (() => {
    try {
      return capabilityCatalog
        .load(root)
        .doc.capabilities.filter((c) => (c.terms ?? []).includes(id))
        .map((c) => c.id);
    } catch {
      // The inventory could not be read, so this process cannot say the term
      // is unreferenced. Refusing is the only honest answer: a removal made on
      // a scan that failed would break a link it never looked at.
      return null;
    }
  })();

  if (referencing === null) {
    return "The capability inventory could not be read, so whether anything references this term is unknown. Fix `capability check` first; a removal on an unread inventory could break a link.";
  }
  if (referencing.length > 0) {
    const edits = referencing.map((c) => `capability update ${c} --term ...`).join("; ");
    return `Term ${catalogText(id)} is referenced by ${referencing.map((c) => catalogText(c)).join(", ")}. Clear the reference first: ${catalogText(edits)}`;
  }
  return null;
}

export async function handleTermRemove(id: string, format: OutputFormat, root: string): Promise<CommandResult> {
  const refusal = termDeletionRefusal(id, root);
  if (refusal !== null) return termRefused(refusal, format);

  return refusing(async () => {
    const doc = await glossaryCatalog.mutate(root, (current) => {
      if (!current.terms.some((t) => t.id === id)) throw new TermRefusal(termNotFound(id, format));
      return { ...current, terms: current.terms.filter((t) => t.id !== id) };
    });
    if (format === "json") return { output: JSON.stringify(successEnvelope({ removed: id, glossarySize: doc.terms.length }), null, 2) };
    return { output: `Removed ${catalogText(id)}. Glossary: ${doc.terms.length}.` };
  });
}

/** T-526 (D4): restore one term to its projection at `--from`, if it still matches `--expect`. */
export async function handleTermRestore(input: RestoreInput & { readonly id: string }, format: OutputFormat, root: string): Promise<CommandResult> {
  return restoreCommand({ kind: "term", id: input.id }, input, format, root);
}

/** Exported for `validate` and `export`, which read the file without going through a handler. */
export { glossaryCatalog, GlossaryCatalogSchema };
