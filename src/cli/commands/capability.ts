/**
 * T-523: the `capability` command surface.
 *
 * Six leaves over one catalog. The division of labour is deliberate and is
 * what the rest of this file keeps: `catalog.ts` owns loading and locking,
 * `capability.ts` owns freshness and matching, and this module owns only the
 * argument shapes, the write transactions and the rendering.
 *
 * Two rules run through every handler here.
 *
 * C-B, the effective status. A reader never sees the STORED status alone. The
 * check runs on read, and what is printed is `effectiveStatus`, so an entry
 * whose files moved under it reads as `review` the moment it is looked at
 * rather than the next time somebody remembers to re-stamp it. `--skip-check`
 * exists for the cases where the git work is not affordable, and it says so in
 * the output rather than quietly printing a status it did not verify.
 *
 * C-C, the bound on a search. `match` reports what it searched and how large
 * the inventory was, on every call including the empty one, because "no match"
 * is a statement about this catalog and never about the repository. The whole
 * ticket exists because a shipped lookup was declared missing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import canonicalize from "canonicalize";
import {
  checkCapabilities,
  matchCapabilities,
  queryPathRefusal,
  matchDisclosure,
  isStampable,
  resolveHead,
  type CapabilityCheckReport,
  type CapabilityCheckEntry,
  type CapabilityMatchResult,
} from "../../core/capability.js";
import { defineCatalog, CatalogLoadError } from "../../core/catalog.js";
import { catalogConflictScope, type CatalogConflictScope } from "../../core/catalog-conflicts.js";
import {
  CapabilityCatalogSchema,
  CapabilitySchema,
  CAPABILITY_STATUSES,
  hasPendingNote,
  normalizeCapabilityName,
  PendingNoteSchema,
  type Capability,
  type CapabilityCatalog,
  type CapabilityStatus,
} from "../../models/capability.js";
import { summarizeZodIssues, describeSchemaIssues } from "../../core/zod-issues.js";
import { sanitizeDisplayPath, sanitizeDisplayText } from "../../core/display-text.js";
import {
  successEnvelope,
  escapeMarkdownInline,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import { restoreRecord, RestoreInputError, RestoreUnsafe, type RestoreResult, type RestoreTarget } from "../../core/ledger-restore.js";
import { CliValidationError } from "../helpers.js";
import { localDateOf } from "../../core/local-date.js";
import type { CommandContext, CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

/** The one catalog this surface reads and writes. */
export const capabilityCatalog = defineCatalog<CapabilityCatalog>({
  file: "capabilities.json",
  key: "capabilities",
  schema: CapabilityCatalogSchema,
  empty: () => ({ version: 1, capabilities: [] }),
});

// --- shared ---

export interface CapabilityWriteInput {
  readonly id: string;
  readonly name?: string;
  readonly summary?: string;
  readonly entryPoints?: readonly string[];
  readonly contract?: string;
  readonly example?: string;
  readonly cli?: readonly string[];
  readonly mcp?: readonly string[];
  readonly app?: readonly string[];
  readonly files?: readonly string[];
  readonly rulings?: readonly string[];
  readonly items?: readonly string[];
  readonly terms?: readonly string[];
  readonly status?: string;
}

/**
 * A checkpoint is written only by a command that MEANS "I just inspected
 * this": `add` and `check --stamp`. `update` never writes one, so editing a
 * summary can never be mistaken for re-reading the code. The date is derived
 * from the same clock the rest of the CLI uses rather than taken as a flag,
 * because a checkpoint whose date the caller chose is not evidence of
 * anything.
 */
async function freshCheckpoint(root: string): Promise<{ sha: string; date: string }> {
  const head = await resolveHead(root);
  if (head === null) {
    throw new CliValidationError(
      "invalid_input",
      "Could not read HEAD. A capability entry records the commit at which its entry points were read, " +
        "so it cannot be stamped outside a git repository with at least one commit.",
    );
  }
  return { sha: head, date: localDateOf(new Date()) };
}

/**
 * Drops keys whose value is undefined before the object reaches the schema.
 *
 * `JSON.stringify` already omits an undefined-valued key, so a document that
 * carried one would lose it on the round trip and compare unequal to what was
 * written. Removing them here means the in-memory document and the file agree,
 * which is what lets `mutate`'s post-write validation mean something.
 */
function defined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

/** Thrown inside a stamp transaction to abort it without a write. */
class NothingToStamp extends Error {}

/**
 * A refusal decided INSIDE a transaction, the `TermRefusal` pattern: `mutate`
 * writes whatever its function returns, the unchanged document included, so a
 * refusal must throw to abort the write. Only `refusing` catches it.
 */
class CapabilityRefusal extends Error {
  constructor(readonly result: CommandResult) {
    super("capability write refused");
  }
}

async function refusing(run: () => Promise<CommandResult>): Promise<CommandResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof CapabilityRefusal) return err.result;
    throw err;
  }
}

/**
 * Pending entries first, then the stored order: a list read by a human or by
 * `/story` Step 2 should open with the work somebody deferred.
 */
function pendingFirst<T extends { cap: Capability }>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => hasPendingNote(r.cap)), ...rows.filter((r) => !hasPendingNote(r.cap))];
}

/**
 * T-529: a name another entry already uses, compared the way the document
 * schema compares them (`normalizeCapabilityName`). Checked inside the
 * transaction, against the document the write will change, so the refusal
 * names the other entry instead of reaching the caller as a schema location.
 */
function nameRefusal(current: readonly Capability[], entry: Capability, format: OutputFormat): CapabilityRefusal | null {
  const key = normalizeCapabilityName(entry.name);
  const owner = current.find((c) => c.id !== entry.id && normalizeCapabilityName(c.name) === key);
  if (owner === undefined) return null;
  return new CapabilityRefusal({
    output: formatError(
      "invalid_input",
      `Capability name ${catalogText(entry.name)} is already used by ${catalogText(owner.id)}. One name belongs to one capability: choose another name, or update that entry.`,
      format,
    ),
    exitCode: ExitCode.USER_ERROR,
    errorCode: "invalid_input",
  });
}

function parseEntry(candidate: unknown): Capability {
  const parsed = CapabilitySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CliValidationError(
      "invalid_input",
      describeSchemaIssues(summarizeZodIssues(parsed.error), parsed.error.issues.length),
    );
  }
  return parsed.data;
}

function surfacesFrom(
  input: CapabilityWriteInput,
  previous: Capability["surfaces"] | undefined,
): Capability["surfaces"] {
  // An omitted flag leaves the existing list alone; a supplied flag REPLACES
  // it. Merging would make a surface impossible to remove through the CLI.
  return defined({
    ...(previous ?? {}),
    cli: input.cli ? [...input.cli] : previous?.cli,
    mcp: input.mcp ? [...input.mcp] : previous?.mcp,
    app: input.app ? [...input.app] : previous?.app,
    files: input.files ? [...input.files] : previous?.files,
  }) as Capability["surfaces"];
}

function statusFrom(value: string | undefined): CapabilityStatus | undefined {
  if (value === undefined) return undefined;
  if (!(CAPABILITY_STATUSES as readonly string[]).includes(value)) {
    throw new CliValidationError(
      "invalid_input",
      `Status must be one of: ${CAPABILITY_STATUSES.join(", ")}`,
    );
  }
  return value as CapabilityStatus;
}

/**
 * The check needs the project's ticket and issue ids to resolve `items`, and
 * `ctx.state` already carries them. A read handler therefore never loads the
 * ledger a second time.
 */
async function reportFor(
  ctx: CommandContext,
  entries: readonly Capability[],
  skipFreshness: boolean,
  scope: CatalogConflictScope,
): Promise<CapabilityCheckReport> {
  return checkCapabilities(ctx.root, entries, ctx.state, {
    skipFreshness,
    conflictedIds: scope.conflictedIds,
    problemIds: scope.problemIds,
  });
}

/**
 * T-529: which entries the file's own open conflict records name. Every read
 * handler hands this to the check (a named entry gets a structural result, so
 * it reads `review` and cannot be stamped) and `match` excludes those entries,
 * listing them, so a conflicted entry is never offered as settled.
 */
export function capabilityConflictScope(doc: CapabilityCatalog): CatalogConflictScope {
  return catalogConflictScope(doc, doc.capabilities.map((c) => c.id));
}

function statusOf(report: CapabilityCheckReport, id: string): CapabilityCheckEntry | undefined {
  return report.entries.find((e) => e.id === id);
}

// --- rendering ---

type MarkdownEscape = (text: string) => string;

/**
 * The two choke points for catalog text. Every catalog-sourced string on its
 * way to a Markdown sink goes through one of them, and so does an id a caller
 * passed that is echoed back: `capabilities.json` is committed content, so a
 * pulled branch can carry ESC, CR or a bidi override in any string field the
 * schema allows, and `escapeMarkdownInline` guards line-start markers only. A
 * sanitize call placed per field would be right today and wrong the day a
 * field is added to the schema and a line to `renderEntry`; one function per
 * kind of value is what a new line has to go through.
 *
 * SANITIZE FIRST, THEN ESCAPE. The escapes insert backslashes, and a backslash
 * is what switches `sanitizeDisplayPath` to its escaped form: escaping first
 * would hand the export's `src/my_file.ts` to the sanitizer as `src/my\_file.ts`
 * and print it as an escaped path that decodes to a name that is not on disk.
 * For text the order is the same BY DESIGN, although today the two orders give
 * identical output: `sanitizeDisplayText`'s "?" is inert to both escapes, so
 * swapping them in `catalogText` is an equivalent mutant (M10d, T-523). It
 * stays equivalent only while the replacement means nothing to Markdown. If
 * the helper ever emits a Markdown-significant replacement, sanitize-then-escape
 * is still right and that mutant has come alive.
 *
 * Text keeps its line structure. `sanitizeDisplayText` marks a newline or a
 * tab like any other control character, so a formatted contract would come
 * out on one line; it is sanitized per line and per tab-separated cell
 * instead, and every other control character, CR included, is marked. There
 * is no length cap: the catalog's own byte limit bounds every field, and
 * truncating the contract `show` was asked for would lose the content the
 * reader came for without saying so.
 *
 * JSON output does not come through here and stays RAW: it is the machine
 * interface, and a consumer acting on an entry needs its real bytes.
 * `JSON.stringify` escapes C0, so ESC cannot reach a terminal through it; it
 * does not escape C1 or bidi controls, a residual recorded in ISS-1281.
 */
export function catalogText(value: string, escape: MarkdownEscape = escapeMarkdownInline): string {
  const safe = value
    .split("\n")
    .map((line) => line.split("\t").map((cell) => sanitizeDisplayText(cell, Number.POSITIVE_INFINITY)).join("\t"))
    .join("\n");
  return escape(safe);
}

/** A catalog path: the reversible form, since an operator acts on it, then the escape. */
export function catalogPath(value: string, escape: MarkdownEscape = escapeMarkdownInline): string {
  return escape(sanitizeDisplayPath(value));
}

function renderResults(entry: CapabilityCheckEntry | undefined): string[] {
  if (!entry || entry.results.length === 0) return [];
  return entry.results.map((r) => `    - [${r.cls}] ${escapeMarkdownInline(r.detail)}`);
}

function renderEntry(cap: Capability, checked: CapabilityCheckEntry | undefined): string[] {
  const status = checked?.effectiveStatus ?? cap.status;
  const lines = [
    `## ${catalogText(cap.name)} (${catalogText(cap.id)}) [${catalogText(status)}]`,
    "",
    catalogText(cap.summary),
    "",
    `- Contract: ${catalogText(cap.contract)}`,
    `- Entry points: ${cap.entryPoints.map((p) => catalogPath(p)).join(", ")}`,
  ];
  const surfaces = cap.surfaces ?? {};
  const surfaceRows = [
    ["cli", "CLI", catalogText],
    ["mcp", "MCP", catalogText],
    ["app", "App", catalogText],
    ["files", "Files", catalogPath],
  ] as const;
  for (const [key, label, render] of surfaceRows) {
    const values = (surfaces as Record<string, string[] | undefined>)[key];
    if (values && values.length > 0) lines.push(`- ${label}: ${values.map((v) => render(v)).join(", ")}`);
  }
  if (cap.example) lines.push(`- Example: ${catalogText(cap.example)}`);
  if (cap.rulings?.length) lines.push(`- Rulings: ${cap.rulings.map((r) => catalogText(r)).join(", ")}`);
  if (cap.items?.length) lines.push(`- Items: ${cap.items.map((i) => catalogText(i)).join(", ")}`);
  if (cap.terms?.length) lines.push(`- Terms: ${cap.terms.map((t) => catalogText(t)).join(", ")}`);
  lines.push(`- Checked at: ${catalogText(cap.checkedAt.sha.slice(0, 12))} (${catalogText(cap.checkedAt.date)})`);
  if (hasPendingNote(cap)) lines.push(`- Pending: review: ${catalogText(cap.pendingNote!)}`);
  if (checked && checked.results.length > 0) {
    lines.push("- Findings:");
    lines.push(...renderResults(checked));
  }
  return lines;
}

/**
 * Every list surface states the size of what was searched and whether
 * freshness actually ran. A reader who sees "3 capabilities" and no caveat
 * knows the check ran; one who sees the caveat knows the statuses printed
 * below fold in structural findings but not freshness.
 */
function freshnessCaveat(report: CapabilityCheckReport, skipped: boolean): string[] {
  if (skipped) return ["_Freshness was not checked (--skip-check): statuses below include structural findings, not freshness._"];
  const notes: string[] = [];
  if (report.head === null) notes.push("_HEAD could not be read, so freshness was not checked._");
  if (report.deadlineHit) notes.push("_The check deadline passed; some entries were not checked._");
  if (report.unchecked.length > 0) notes.push(`_Unchecked: ${report.unchecked.map((id) => catalogText(id)).join(", ")}._`);
  return notes;
}

// --- read handlers ---

export async function handleCapabilityList(
  filters: { status?: string; skipCheck?: boolean },
  ctx: CommandContext,
): Promise<CommandResult> {
  const status = statusFrom(filters.status);
  const skip = filters.skipCheck === true;
  const { doc, present } = capabilityCatalog.load(ctx.root);
  const report = await reportFor(ctx, doc.capabilities, skip, capabilityConflictScope(doc));

  // Filtering runs on the EFFECTIVE status, not the stored one. `--status
  // review` that only matched the manual flag would hide exactly the entries
  // the flag is meant to find: the ones the check just marked.
  const rows = pendingFirst(
    doc.capabilities
      .map((cap) => ({ cap, checked: statusOf(report, cap.id) }))
      .filter(({ cap, checked }) => status === undefined || (checked?.effectiveStatus ?? cap.status) === status),
  );
  const pending = doc.capabilities.filter((c) => hasPendingNote(c)).length;

  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        successEnvelope({
          present,
          inventorySize: doc.capabilities.length,
          pending,
          freshnessChecked: !skip && report.head !== null,
          head: report.head,
          unchecked: report.unchecked,
          capabilities: rows.map(({ cap, checked }) => ({
            ...cap,
            effectiveStatus: checked?.effectiveStatus ?? cap.status,
            results: checked?.results ?? [],
          })),
        }),
        null,
        2,
      ),
    };
  }

  const lines = [`# Capabilities (${rows.length} of ${doc.capabilities.length}${pending > 0 ? `, pending: ${pending}` : ""})`, ""];
  lines.push(...freshnessCaveat(report, skip));
  if (!present) {
    lines.push("", "No capability inventory yet. `storybloq capability add` creates the first entry.");
    return { output: lines.join("\n") };
  }
  if (rows.length === 0) {
    lines.push("", "No capability matches that filter.");
    return { output: lines.join("\n") };
  }
  for (const { cap, checked } of rows) {
    const effective = checked?.effectiveStatus ?? cap.status;
    lines.push("", `- **${catalogText(cap.name)}** (${catalogText(cap.id)}) [${catalogText(effective)}]`);
    lines.push(`  ${catalogText(cap.summary)}`);
    lines.push(`  ${cap.entryPoints.map((p) => catalogPath(p)).join(", ")}`);
    if (hasPendingNote(cap)) lines.push(`  review: ${catalogText(cap.pendingNote!)}`);
    lines.push(...renderResults(checked));
  }
  return { output: lines.join("\n") };
}

export async function handleCapabilityGet(
  id: string,
  options: { skipCheck?: boolean },
  ctx: CommandContext,
): Promise<CommandResult> {
  const skip = options.skipCheck === true;
  const { doc } = capabilityCatalog.load(ctx.root);
  const cap = doc.capabilities.find((c) => c.id === id);
  if (!cap) {
    return {
      output: formatError("not_found", `Capability ${catalogText(id)} not found in the inventory of ${doc.capabilities.length}.`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  const report = await reportFor(ctx, [cap], skip, capabilityConflictScope(doc));
  const checked = statusOf(report, id);
  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        successEnvelope({
          ...cap,
          effectiveStatus: checked?.effectiveStatus ?? cap.status,
          freshnessChecked: !skip && report.head !== null,
          head: report.head,
          results: checked?.results ?? [],
        }),
        null,
        2,
      ),
    };
  }
  const lines = renderEntry(cap, checked);
  const caveat = freshnessCaveat(report, skip);
  if (caveat.length > 0) lines.push("", ...caveat);
  return { output: lines.join("\n") };
}

export async function handleCapabilityMatch(
  criteria: { paths?: readonly string[]; title?: string; phaseId?: string },
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!criteria.paths?.length && !criteria.title && !criteria.phaseId) {
    throw new CliValidationError(
      "invalid_input",
      "match needs at least one of --path, --title or --phase. A match with no criteria would return the whole inventory and say nothing.",
    );
  }
  // One refused path refuses the whole call, before anything is matched: a
  // partial answer would read as a complete one.
  const refusals = (criteria.paths ?? []).flatMap((q) => queryPathRefusal(q) ?? []);
  if (refusals.length > 0) {
    throw new CliValidationError("invalid_input", `match refused: ${refusals.join("; ")}`);
  }
  const { doc } = capabilityCatalog.load(ctx.root);
  const res: CapabilityMatchResult = matchCapabilities(doc.capabilities, criteria, ctx.state, capabilityConflictScope(doc).excluded);

  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        successEnvelope({
          matches: res.matches.map((m) => ({ id: m.capability.id, name: m.capability.name, reasons: m.reasons, capability: m.capability })),
          searched: res.searched,
          inventorySize: res.inventorySize,
          excluded: res.excluded,
          bounded: res.bounded,
          disclosure: matchDisclosure(res),
        }),
        null,
        2,
      ),
    };
  }

  const lines = [`# Capability match (${res.matches.length} of ${res.inventorySize})`, "", matchDisclosure(res)];
  for (const m of res.matches) {
    lines.push("", `- **${catalogText(m.capability.name)}** (${catalogText(m.capability.id)})`);
    lines.push(`  ${catalogText(m.capability.summary)}`);
    for (const r of m.reasons) lines.push(`  - ${r.kind}: ${escapeMarkdownInline(r.detail)}`);
  }
  for (const ex of res.excluded) {
    lines.push("", `- (excluded) ${catalogText(ex.id)}: ${catalogText(ex.reason)}`);
  }
  return { output: lines.join("\n") };
}

// --- write handlers ---

/** The entry with no `pendingNote` key at all, rather than an empty one. */
function withoutPendingNote(entry: Capability): Capability {
  const { pendingNote: _cleared, ...rest } = entry;
  return rest as Capability;
}

export interface CapabilityDeferInput {
  readonly id: string;
  readonly note: string;
  /** A follow-up issue that owns the deferred work; it must exist in the ledger. */
  readonly issue?: string;
}

/**
 * T-526 (3.7): record work owed on an entry without doing it. The narrowest
 * write in this file: it sets `pendingNote` and the stored `review` flag and
 * touches nothing else, and it runs NO structural check, because the reason to
 * defer is usually that the entry is already wrong (its path was renamed or
 * deleted) and a check would refuse the very write that records that.
 *
 * Refused while the file carries any open conflict record (T-529): the
 * ordinary `mutate` refuses a conflicted catalog, naming the entries, so
 * `resolve` is the only writer until the file is clear. An unreadable file
 * refuses through `mutate`'s own load.
 */
export async function handleCapabilityDefer(
  input: CapabilityDeferInput,
  format: OutputFormat,
  root: string,
  ctx?: CommandContext,
): Promise<CommandResult> {
  const note = input.note.trim();
  if (note.length === 0) {
    throw new CliValidationError("invalid_input", "`capability defer` needs --note naming the owed work; an empty note would clear nothing and flag nothing.");
  }
  const parsedNote = PendingNoteSchema.safeParse(note);
  if (!parsedNote.success) throw new CliValidationError("invalid_input", parsedNote.error.issues[0]?.message ?? "invalid note");
  if (input.issue !== undefined && ctx !== undefined) {
    const known = ctx.state.issues.some((i) => i.id === input.issue || (i as { displayId?: string | null }).displayId === input.issue);
    if (!known) throw new CliValidationError("not_found", `Issue ${catalogText(input.issue)} not found: --issue names the follow-up that owns the deferred work.`);
  }
  const text = input.issue !== undefined && !note.includes(input.issue) ? `${note} (follow-up ${input.issue})` : note;
  return refusing(async () => {
    let written: Capability | null = null;
    await capabilityCatalog.mutate(root, (current) => {
      const index = current.capabilities.findIndex((c) => c.id === input.id);
      if (index === -1) {
        throw new CapabilityRefusal({
          output: formatError("not_found", `Capability ${catalogText(input.id)} not found.`, format),
          exitCode: ExitCode.USER_ERROR,
          errorCode: "not_found",
        });
      }
      const next = { ...current.capabilities[index]!, pendingNote: text, status: "review" as const };
      written = next;
      const capabilities = [...current.capabilities];
      capabilities[index] = next;
      return { ...current, capabilities };
    });
    const entry: Capability = written!;
    if (format === "json") return { output: JSON.stringify(successEnvelope({ capability: entry }), null, 2) };
    return {
      output: `Deferred ${catalogText(entry.id)}: review: ${catalogText(text)}. It reads \`review\` until \`capability check --stamp ${catalogText(entry.id)} --clear-pending\`.`,
    };
  });
}

export async function handleCapabilityAdd(
  input: CapabilityWriteInput,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  const checkedAt = await freshCheckpoint(root);
  const candidate = defined({
    id: input.id,
    name: input.name,
    summary: input.summary,
    surfaces: surfacesFrom(input, undefined),
    entryPoints: input.entryPoints ? [...input.entryPoints] : undefined,
    contract: input.contract,
    example: input.example,
    rulings: input.rulings ? [...input.rulings] : undefined,
    items: input.items ? [...input.items] : undefined,
    terms: input.terms ? [...input.terms] : undefined,
    checkedAt,
    status: statusFrom(input.status) ?? "current",
  });
  const entry = parseEntry(candidate);

  // The duplicate check runs INSIDE the transaction rather than against a
  // document read beforehand: two adds racing on the same id would both see an
  // absent entry outside the lock and the second would silently replace the
  // first. The refusal throws: `mutate` writes whatever its function returns,
  // so returning `current` would rewrite (or, with no file, create) the
  // catalog to report a refusal (ISS-1286).
  return refusing(async () => {
    const doc = await capabilityCatalog.mutate(root, (current) => {
      if (current.capabilities.some((c) => c.id === entry.id)) {
        throw new CapabilityRefusal({
          output: formatError("invalid_input", `Capability ${catalogText(entry.id)} already exists. Use \`capability update\` to change it.`, format),
          exitCode: ExitCode.USER_ERROR,
          errorCode: "invalid_input",
        });
      }
      const refusal = nameRefusal(current.capabilities, entry, format);
      if (refusal !== null) throw refusal;
      return { ...current, capabilities: [...current.capabilities, entry] };
    });
    if (format === "json") {
      return { output: JSON.stringify(successEnvelope({ capability: entry, inventorySize: doc.capabilities.length }), null, 2) };
    }
    return {
      output: [
        `Added ${catalogText(entry.id)} (${catalogText(entry.name)}), checkpoint ${catalogText(checkedAt.sha.slice(0, 12))} (${catalogText(checkedAt.date)}).`,
        `Inventory: ${doc.capabilities.length}.`,
      ].join("\n"),
    };
  });
}

export async function handleCapabilityUpdate(
  input: CapabilityWriteInput,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  return refusing(async () => {
    const doc = await capabilityCatalog.mutate(root, (current) => {
      const index = current.capabilities.findIndex((c) => c.id === input.id);
      // Thrown, never "return current": a refusal must not write (ISS-1286).
      if (index === -1) {
        throw new CapabilityRefusal({
          output: formatError("not_found", `Capability ${catalogText(input.id)} not found.`, format),
          exitCode: ExitCode.USER_ERROR,
          errorCode: "not_found",
        });
      }
      const previous = current.capabilities[index]!;
      // `checkedAt` is carried forward untouched. An update is an edit to the
      // DESCRIPTION of a capability, never a claim that its code was re-read, so
      // it must not clear a freshness finding. `check --stamp` is the only
      // command that says "I looked".
      const next = parseEntry(
        defined({
          ...previous,
          name: input.name ?? previous.name,
          summary: input.summary ?? previous.summary,
          surfaces: surfacesFrom(input, previous.surfaces),
          entryPoints: input.entryPoints ? [...input.entryPoints] : previous.entryPoints,
          contract: input.contract ?? previous.contract,
          example: input.example ?? previous.example,
          rulings: input.rulings ? [...input.rulings] : previous.rulings,
          items: input.items ? [...input.items] : previous.items,
          terms: input.terms ? [...input.terms] : previous.terms,
          checkedAt: previous.checkedAt,
          status: statusFrom(input.status) ?? previous.status,
        }),
      );
      const refusal = nameRefusal(current.capabilities, next, format);
      if (refusal !== null) throw refusal;
      const capabilities = [...current.capabilities];
      capabilities[index] = next;
      return { ...current, capabilities };
    });
    const entry = doc.capabilities.find((c) => c.id === input.id)!;
    if (format === "json") return { output: JSON.stringify(successEnvelope({ capability: entry }), null, 2) };
    return {
      output: `Updated ${catalogText(entry.id)}. Checkpoint unchanged at ${catalogText(entry.checkedAt.sha.slice(0, 12))} (${catalogText(entry.checkedAt.date)}); run \`capability check --stamp ${catalogText(entry.id)}\` after re-reading its entry points.`,
    };
  });
}

export interface CapabilityCheckInput {
  readonly stamp?: readonly string[];
  readonly stampAll?: boolean;
  /**
   * T-526 (3.7): remove the pending note in the same write that stamps. A
   * stamp alone is refused while a note is set: the note names work nobody
   * has done, and a stamp says somebody looked.
   */
  readonly clearPending?: boolean;
}

/**
 * The read-only check, and the one command that re-stamps.
 *
 * Stamping is gated on `isStampable`: a freshness finding is exactly what a
 * stamp is for, but a STRUCTURAL finding (a missing path, an unknown ruling)
 * is a defect in the entry that a new sha would hide rather than fix, and an
 * INCOMPLETE result means the check did not finish, so stamping would record a
 * verification that never happened. Both are refused by name in the output
 * rather than silently skipped.
 */
export async function handleCapabilityCheck(
  input: CapabilityCheckInput,
  format: OutputFormat,
  root: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (input.clearPending === true && input.stampAll !== true && (input.stamp ?? []).length === 0) {
    throw new CliValidationError(
      "invalid_input",
      "--clear-pending clears a pending note in the same write as a stamp: pass it with --stamp <id>. A note is only cleared by the act of having looked.",
    );
  }
  const { doc } = capabilityCatalog.load(root);
  const scope = capabilityConflictScope(doc);
  const report = await checkCapabilities(root, doc.capabilities, ctx.state, {
    conflictedIds: scope.conflictedIds,
    problemIds: scope.problemIds,
  });
  const storedById = new Map(doc.capabilities.map((c) => [c.id, c]));

  const requested = input.stampAll === true
    ? report.entries.map((e) => e.id)
    : [...(input.stamp ?? [])];
  const unknown = requested.filter((id) => !report.entries.some((e) => e.id === id));
  if (unknown.length > 0) {
    return {
      output: formatError("not_found", `Not in the inventory: ${unknown.map((id) => catalogText(id)).join(", ")}.`, format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }

  const blockedByNote = (id: string): boolean => input.clearPending !== true && hasPendingNote(storedById.get(id)!);
  const stampable = requested.filter((id) => isStampable(statusOf(report, id)!) && !blockedByNote(id));
  const refused = requested
    .filter((id) => !stampable.includes(id))
    .map((id) => {
      const entry = statusOf(report, id)!;
      const blocking = entry.results.filter((r) => r.cls !== "freshness").map((r) => r.detail);
      if (blockedByNote(id)) {
        blocking.push(
          `a pending note is set (${sanitizeDisplayText(storedById.get(id)!.pendingNote!)}): do the deferred work, then stamp with --clear-pending`,
        );
      }
      return { id, reasons: blocking };
    });

  let stamped: { sha: string; date: string } | null = null;
  let stampedIds: string[] = [];
  if (stampable.length > 0) {
    /**
     * Stamp the commit that was CHECKED, never a freshly resolved HEAD.
     * `checkCapabilities` diffed every entry against `report.head`; resolving
     * HEAD again here would, if a commit landed during the (up to 30s) check,
     * certify a commit nobody checked. The next check would then diff that
     * commit against itself, report `current`, and the intervening change
     * would be invisible for good. A null head means nothing was checked
     * against a commit at all, so there is nothing honest to stamp.
     */
    if (report.head === null) {
      throw new CliValidationError(
        "invalid_input",
        "The check could not read HEAD, so no entry was verified against a commit and nothing can be stamped.",
      );
    }
    const checkpoint = { sha: report.head, date: localDateOf(new Date()) };
    /**
     * A stamp certifies exactly the entry bytes and the HEAD that were
     * checked. The check ran on `doc`, loaded before the lock and up to 30s
     * ago; the mutation reloads under the lock, and an entry edited in
     * between (new entry points, a removed ruling) would otherwise be stamped
     * on the strength of a check it never had. So each entry is compared
     * WHOLE, as canonical JSON, against the form that was checked: never a
     * selected field list, which silently stops covering a field the day one
     * is added. A mismatch, or an entry removed meanwhile, is a race and is
     * refused for that entry alone; the unchanged ones still stamp. Holding
     * the lock across the check instead would block every other writer for
     * the whole git run.
     *
     * Out of scope, deliberately: a referenced ruling or item changing during
     * the check. That is a race against the whole ledger, not this file, and
     * no per-entry comparison can see it.
     */
    const checkedForm = new Map(doc.capabilities.map((c) => [c.id, canonicalize(c)]));
    const raced: string[] = [];
    try {
      await capabilityCatalog.mutate(root, (current) => {
        const now = new Map(current.capabilities.map((c) => [c.id, c]));
        const eligible = new Set<string>();
        raced.length = 0;
        for (const id of stampable) {
          const entry = now.get(id);
          if (entry !== undefined && canonicalize(entry) === checkedForm.get(id)) eligible.add(id);
          else raced.push(id);
        }
        // Nothing left to stamp: abort the transaction rather than rewrite the
        // file with no change in it.
        if (eligible.size === 0) throw new NothingToStamp();
        stampedIds = stampable.filter((id) => eligible.has(id));
        return {
          ...current,
          capabilities: current.capabilities.map((c) =>
            // Stamping clears the manual `review` flag as well as the freshness
            // finding: the flag means "somebody should look", and this command
            // is the act of having looked.
            eligible.has(c.id) ? withoutPendingNote({ ...c, checkedAt: checkpoint, status: "current" as const }) : c,
          ),
        };
      });
      stamped = checkpoint;
    } catch (err: unknown) {
      if (!(err instanceof NothingToStamp)) throw err;
      stampedIds = [];
    }
    for (const id of raced) {
      refused.push({
        id,
        reasons: ["it changed or was removed while the check was running, so the stored entry is not the one that was checked: re-run the check"],
      });
    }
  }

  /**
   * What still needs review AFTER this command: flagged at check time, minus
   * what this call actually stamped. Refused, raced and unrequested entries
   * still need review, so a partial stamp keeps the warning and its PARTIAL
   * exit, and a full stamp clears both. Computed from the pre-stamp report
   * alone, the warning announced review for entries the same output had just
   * reported stamped.
   *
   * A refused stamp warns on its own. An entry that was current when checked
   * and then raced is refused without ever being flagged, so a warning keyed
   * on flagged entries alone let a call whose every requested stamp was
   * refused exit OK.
   */
  const stampedSet = new Set(stampedIds);
  const stillFlagged = report.entries.filter((e) => e.effectiveStatus === "review" && !stampedSet.has(e.id));
  const refusedCount = refused.length;

  if (format === "json") {
    return {
      output: JSON.stringify(
        successEnvelope({
          head: report.head,
          inventorySize: doc.capabilities.length,
          unchecked: report.unchecked,
          deadlineHit: report.deadlineHit,
          entries: report.entries,
          stamped: stampedIds,
          stampedAt: stamped,
          refused,
          statusNote:
            "entries[].effectiveStatus is the status as checked, before any stamp in this call; `stamped` is the post-state: the entries this call re-pointed at HEAD and marked current",
        }),
        null,
        2,
      ),
      ...((stillFlagged.length > 0 || refusedCount > 0) && {
        warnings: [
          ...(stillFlagged.length > 0 ? ["one or more capabilities need review"] : []),
          ...(refusedCount > 0 ? ["one or more requested stamps were refused"] : []),
        ],
      }),
    };
  }

  const lines = [`# Capability check (${report.entries.length} entries)`, ""];
  lines.push(...freshnessCaveat(report, false));
  // By EFFECTIVE status, not by whether any finding exists. An entry a human
  // flagged `review` by hand can have no findings at all, and selecting on
  // findings made it vanish from this list while the line below announced
  // that everything was current: an explicit request for review, erased.
  const flagged = report.entries.filter((e) => e.effectiveStatus === "review");
  if (flagged.length === 0) {
    lines.push("", "Every capability is current at HEAD.");
  }
  for (const entry of flagged) {
    lines.push("", `- ${catalogText(entry.id)} [${catalogText(entry.effectiveStatus)}]`);
    lines.push(...renderResults(entry));
    if (entry.results.length === 0) {
      lines.push("    - flagged for review by hand, with no check finding; stamping it records that someone has looked");
    }
  }
  if (stamped !== null) {
    lines.push("", `Stamped ${stampedIds.length} entr${stampedIds.length === 1 ? "y" : "ies"} at ${catalogText(stamped.sha.slice(0, 12))} (${catalogText(stamped.date)}): ${stampedIds.map((id) => catalogText(id)).join(", ")}.`);
  }
  for (const r of refused) {
    lines.push("", `Refused to stamp ${catalogText(r.id)}: ${r.reasons.map((d) => escapeMarkdownInline(d)).join("; ")}`);
  }
  return {
    output: lines.join("\n"),
    ...((stillFlagged.length > 0 || refusedCount > 0) && {
      warnings: [
        ...(stillFlagged.length > 0
          ? [`${stillFlagged.length} capabilit${stillFlagged.length === 1 ? "y needs" : "ies need"} review`]
          : []),
        ...(refusedCount > 0 ? [`${refusedCount} requested stamp${refusedCount === 1 ? " was" : "s were"} refused`] : []),
      ],
    }),
  };
}

// --- restore (T-526, D4) ---

export interface RestoreInput {
  readonly from: string;
  readonly expect: string;
}

/**
 * The one rendering of a restore, shared by `capability restore`, `term
 * restore` and `ledger restore`. It lives here rather than in `ledger.ts`
 * because this file owns the capability catalog the core needs, and `term.ts`
 * already imports from it: keeping the helper here keeps the import graph
 * acyclic.
 *
 * A refusal is the named outcome `restore_unsafe`, returned through
 * `formatError` like every other refusal on this surface. The envelope has no
 * details field, so the reason and invariant travel in the message, in the
 * fixed order `RestoreUnsafe` writes.
 */
export async function restoreCommand(target: RestoreTarget, input: RestoreInput, format: OutputFormat, root: string): Promise<CommandResult> {
  let result: RestoreResult;
  try {
    result = await restoreRecord(root, target, input.from, input.expect, { capabilityCatalog });
  } catch (err) {
    if (err instanceof RestoreUnsafe) {
      return { output: formatError("restore_unsafe", err.message, format), exitCode: ExitCode.USER_ERROR, errorCode: "restore_unsafe" };
    }
    if (err instanceof RestoreInputError) throw new CliValidationError("invalid_input", err.message);
    throw err;
  }
  if (format === "json") return { output: JSON.stringify(successEnvelope({ outcome: result.outcome, target: result.target }), null, 2) };
  if (result.outcome === "unchanged") {
    return { output: `${catalogText(result.target)} is unchanged: it already equals its projection at ${catalogText(input.from)}. Nothing was written.` };
  }
  return { output: `Restored ${catalogText(result.target)} to its projection at ${catalogText(input.from)}.` };
}

/** T-526 (D4): restore one capability entry to its projection at `--from`, if it still matches `--expect`. */
export async function handleCapabilityRestore(input: RestoreInput & { readonly id: string }, format: OutputFormat, root: string): Promise<CommandResult> {
  return restoreCommand({ kind: "capability", id: input.id }, input, format, root);
}
