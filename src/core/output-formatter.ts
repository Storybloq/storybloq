import { computeIssueFlow, formatIssueFlow, ISSUE_FLOW_SEMANTICS } from "./issue-flow.js";
import type { ArrangementCompactResult, ArrangementRebindResult, ArrangementRotateResult, DuetRoute, DuetView } from "./duet-coordination.js";
import { arrangementCapacity, type ArrangementCapacity } from "./arrangement-compaction.js";
import { assignmentIdOf, isCompactedAssignment } from "../models/duet.js";
import { displayIdOf } from "./resolver.js";
import { ENABLE_GIT_REFS_REMEDY } from "./branch-allocation-warning.js";
import type { OutputFormat, ErrorCode } from "../models/types.js";
import type { FederationState, FederationNodeEntry } from "../federation/state.js";
import type { Config } from "../models/config.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import { dispositionEvidenceView, issueJsonBody, issueStatusLabel, effectiveResolutionKind } from "./resolution-kind.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { Roadmap } from "../models/roadmap.js";
import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";
import type { ValidationResult, ValidationFinding, ValidationLevel } from "./validation.js";
import type { LedgerIntegrityResult } from "./ledger-integrity.js";
import type { NextTicketOutcome, NextTicketsOutcome } from "./queries.js";
import type { RecommendResult } from "./recommend.js";
import { isHandoverWindowIncomplete } from "./recommend.js";
import { describeRepeatInterval } from "./session-intel/sampler.js";
import type { HandoverBriefResult, HandoverBriefEntry } from "./handover-brief.js";
import type { SectionRecord, TrajectoryEntry } from "./markdown-sections.js";
import type { ReconcileResult } from "./reconcile.js";
import type { DoctorResult } from "./team-doctor.js";
import type { ActiveSessionSummary, SessionScanDiagnostic } from "./session-scan.js";
import type { StatusRoster } from "./roster-view.js";
import type { Arrangement, ArrangementLifecycle, ArrangementRole } from "../models/arrangement.js";
import type { GateAck } from "../models/gate-ack.js";
import type { LandingsResult } from "./landings.js";
import type { Earmark } from "../models/types.js";
import type { StorybloqClient } from "../autonomous/client-profile.js";
import { sanitizeDisplayText, sanitizeDisplayPath, MAX_PROSE_LENGTH } from "./display-text.js";
import { boundedLines } from "./bounded-list.js";
import { checkpointCounts, checkpointSummary, type CheckpointCounts, type CheckpointSummary } from "./checkpoint-display.js";
import type { CitationResolution } from "./ruling.js";
import { renderCitation, rulingAttributionCaveat } from "./ruling.js";
import type { Ruling } from "../models/ruling.js";
import { payloadDigest, type LifecycleReason, type RulingLifecycle } from "./ruling-lifecycle.js";

/**
 * How many diagnostic lines the human-readable section may carry (ISS-897).
 *
 * Enough that a real incident -- a handful of unreadable directories -- is
 * reported in full, and few enough that a directory built to flood cannot take
 * the response. The JSON payload is unaffected and still carries every entry.
 */
const MAX_DIAGNOSTIC_LINES = 20;

/**
 * How many session rows either status formatter renders (ISS-897).
 *
 * One pen per repo is the invariant this output exists to protect, so a real
 * project has a handful of sessions; a hundred is a signal in itself, and the
 * count says so without the rows.
 */
const MAX_SESSION_ROWS = 25;
import type { SelftestResult } from "../cli/commands/selftest.js";
import type { BusSummary } from "../bus/schemas.js";
import { describeDeliveryTiers } from "../bus/schemas.js";

type BusStatusInput =
  | BusSummary
  | { readonly enabled: true; readonly error: { readonly code: string; readonly message: string } }
  | undefined;

// Bus line(s) for the Markdown status views. D7: stays quiet until the Bus is
// enabled. T-428 adds the runtime_lost line and, for a disabled-but-evidenced
// checkout, surfaces the config-revert diagnostic (carried in nextActions) instead
// of staying silent, so a reverted `features.bus` is visible outside JSON.
function busStatusLines(bus: BusStatusInput): string[] {
  if (!bus) return [];
  if ("error" in bus) {
    return [`Bus: unavailable [${bus.error.code}] ${escapeMarkdownInline(bus.error.message)}`];
  }
  if (bus.setupState === "disabled") {
    const revert = bus.nextActions.find((action) => action.includes("config.features.bus"));
    return revert ? [`Bus: ${revert}`] : [];
  }
  if (bus.setupState === "ready") {
    // T-427: honest per-tier wording; never the raw `deliveryMode` enum (which can
    // read "live delivery" and oversell a notify-on-boundary channel as push).
    return [`Bus: ready; ${bus.endpoints} connected; delivery: ${describeDeliveryTiers(bus.deliveryCapabilities)}`];
  }
  if (bus.setupState === "waiting_for_peer") {
    return ["Bus: waiting for peer; run `storybloq bus setup` in the other task"];
  }
  if (bus.setupState === "runtime_lost") {
    // Neutral wording: runtime_lost covers both an absent runtime and one whose
    // instance no longer matches this checkout's evidence. BusSummary does not carry
    // the loss reason, so avoid asserting "deleted" for the mismatch case.
    return ["Bus: runtime lost; `.story/bus/` is absent or no longer matches this checkout's deletion-evidence; run `storybloq bus setup` to re-establish it"];
  }
  if (bus.setupState === "invalid") {
    // A present-but-broken runtime: corrupt layout or unreadable deletion-evidence.
    // Never fall through to the "not set up" line, which would misdescribe it.
    return ["Bus: invalid; the runtime or its deletion-evidence is corrupt; run `storybloq bus doctor`"];
  }
  return bus.initialized
    ? [`Bus: ${bus.setupState}`]
    : ["Bus: enabled, not set up in this checkout; run `storybloq bus setup`"];
}
import { phasesWithStatus, isBlockerCleared, openUnphasedLeaves } from "./queries.js";

function resolveTicketRefDisplay(ref: string, state: ProjectState): string {
  const result = state.resolveTicketRef(ref);
  if (result.kind === "found") {
    return displayIdOf(result.item);
  }
  return ref;
}

function resolveLessonRefDisplay(ref: string, state: ProjectState): string {
  const result = state.resolveLessonRef(ref);
  if (result.kind === "found") {
    return displayIdOf(result.item);
  }
  return ref;
}

/** SKILL PROTOCOL: SKILL.md Step 2b matches this literal string. Do not change without updating SKILL.md. */
export const EMPTY_SCAFFOLD_HEADING = "## Getting Started";

// --- Exit Codes ---

export const ExitCode = {
  OK: 0,
  USER_ERROR: 1,
  VALIDATION_ERROR: 2,
  PARTIAL: 3,
  // T-427 rendezvous long-poll: distinct codes so a background `bus poll --wait`
  // consumer can tell a timeout (nothing arrived) and a contended waiter (another
  // --wait already owns this endpoint) apart from a delivered message (OK) or a
  // usage/validation error. Signals (SIGINT=130, SIGTERM=143) are set directly by
  // the wait runner and are intentionally not enum members.
  TIMEOUT: 4,
  WAITER_ACTIVE: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

// --- JSON Envelopes ---

export interface SuccessEnvelope<T> {
  readonly version: 1;
  readonly data: T;
}

export interface ErrorEnvelope {
  readonly version: 1;
  readonly error: { readonly code: ErrorCode; readonly message: string };
}

export interface PartialEnvelope<T> {
  readonly version: 1;
  readonly data: T;
  readonly warnings: readonly { type: string; file: string; message: string }[];
  readonly partial: true;
}

export function successEnvelope<T>(data: T): SuccessEnvelope<T> {
  return { version: 1, data };
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
): ErrorEnvelope {
  return { version: 1, error: { code, message } };
}

/**
 * The "no .story/ project" failure, rendered in whichever JSON family the
 * calling command documents (ISS-910).
 *
 * These guards sit in the yargs adapter, ahead of the shared run.ts pipeline,
 * so they never passed through a formatter and answered in prose even under
 * --format json. That hands an automated caller non-JSON on stdout for the
 * most routine failure there is -- the same parser breakage this issue exists
 * to close, one layer above the handlers.
 *
 * `family` is the command's documented JSON shape: "envelope" for the shared
 * {version, error} contract, "ok" for the {"ok", ...} commands. The Markdown
 * rendering is byte-identical to what these guards emitted before.
 *
 * It lives HERE, beside errorEnvelope, rather than in cli/helpers.ts: helpers
 * is in the type-fixture program for ISS-886 (via cli/array-options.ts), and
 * giving it an edge to this module widens that fixture's tsc program to the
 * whole repo, surfacing unrelated pre-existing errors as fixture failures.
 */
export function noProjectFoundOutput(format: unknown, family: "envelope" | "ok"): string {
  const message = "No .story/ project found.";
  if (format !== "json") return message;
  return family === "ok"
    ? JSON.stringify({ ok: false, error: message }, null, 2)
    : JSON.stringify(errorEnvelope("not_found", message), null, 2);
}

export function partialEnvelope<T>(
  data: T,
  warnings: readonly LoadWarning[],
): PartialEnvelope<T> {
  return {
    version: 1,
    data,
    warnings: warnings.map((w) => ({
      type: w.type,
      file: w.file,
      message: w.message,
    })),
    partial: true,
  };
}

// --- Markdown Safety ---

/**
 * Escapes only heading and list markers at the start of a line (unordered and
 * ordered) so an embedded field cannot start a new Markdown block inside the
 * formatter's own `md` output.
 *
 * This is NOT a Markdown or HTML sanitizer. Inline-structural, HTML-entity, and
 * backslash escaping were intentionally removed: the only consumers of formatter
 * output are plain-text sinks (CLI stdout and MCP `text` results to the model),
 * neither of which decodes entities or renders Markdown, so that escaping never
 * got decoded and instead leaked as visible noise like `&amp;`, `\(`, `\[`.
 * Blockquotes (`>`) and inline characters are passed through for plain-text
 * readability. Do not reintroduce inline/HTML escaping unless a real
 * Markdown/HTML renderer is added downstream.
 */
export function escapeMarkdownInline(text: string): string {
  return text
    .replace(/(^|\n)([#\-+*])/g, "$1\\$2")
    .replace(/(^|\n)(\d+)\./g, "$1$2\\.");
}

/**
 * Full Markdown + HTML escaping for content embedded in a rendered, shareable
 * document (the `storybloq export` output). Unlike escapeMarkdownInline (which
 * only guards line-start markers for plain-text sinks), this also neutralizes
 * inline structure, HTML, and link injection, because the export document is
 * meant to be opened in a Markdown viewer where an unescaped title could inject
 * a link or raw HTML.
 */
export function escapeMarkdownDocument(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_~\[\]()|])/g, "\\$1")
    .replace(/(^|\n)([#\-+*])/g, "$1\\$2")
    .replace(/(^|\n)(\d+)\./g, "$1$2\\.");
}

/**
 * Break the syntax a Markdown renderer AUTOLINKS, without hiding the text.
 *
 * `escapeMarkdownDocument` kills the explicit `[text](url)` form by escaping
 * the brackets and parentheses, which is the dangerous shape -- a link whose
 * visible text and destination disagree. It leaves a BARE
 * `https://elsewhere.example` alone, and GitHub-flavoured Markdown turns that
 * into a clickable link on its own, so a payload that simply omits the wrapper
 * gets a live link out of an escaper that appears to have neutralized it.
 *
 * `&#58;`, `&#46;` and `&#64;` render as `:`, `.` and `@`, so the address stays
 * readable and a reader can still see exactly what was claimed. What it cannot
 * do is form the contiguous `://` or `www.` an autolinker scans for.
 *
 * The `@` rule is unconditional, and the narrower `word@word` form it replaced
 * was wrong for the same reason bracket-escaping alone was wrong about links:
 * it neutralized the shape being thought about and left the shorter one live.
 * An email address is not the only thing an `@` produces -- `@admin` is a
 * MENTION on the surfaces that render this, so it notifies, links, and lends
 * a session-controlled string the appearance of naming a person.
 *
 * Deliberately NOT folded into `escapeMarkdownDocument`. That function is what
 * `storybloq export` uses, where a URL in a ticket description is content the
 * author put there and a working link is the point. The distinction is the
 * sink, not the syntax.
 */
export function neutralizeAutolinks(text: string): string {
  return text
    .replace(/:\/\//g, "&#58;//")
    .replace(/\bwww\./gi, "www&#46;")
    .replace(/@/g, "&#64;");
}

/**
 * The full document treatment: escape structure, then break autolinks.
 *
 * For a value that is ALREADY sanitized -- a `sanitizeDisplayText` label or a
 * `sanitizeDisplayPath` address -- since those two are not interchangeable and
 * the caller is the only one who knows which it holds. Sanitizing here would
 * either re-cap an address to a label width or leave a label unbounded.
 */
export function escapeMarkdownDocumentStrict(text: string): string {
  return neutralizeAutolinks(escapeMarkdownDocument(text));
}

/**
 * Wraps multi-line content in a fenced code block.
 * Uses a fence length longer than any backtick sequence in the content.
 */
export function fencedBlock(content: string, lang?: string): string {
  let maxTicks = 2;
  const matches = content.match(/`+/g);
  if (matches) {
    for (const m of matches) {
      if (m.length > maxTicks) maxTicks = m.length;
    }
  }
  const fence = "`".repeat(maxTicks + 1);
  return `${fence}${lang ?? ""}\n${content}\n${fence}`;
}

/**
 * ISS-1192: inverts `fencedBlock`. When the ENTIRE input, after trimming only
 * outer whitespace, is one fenced block whose opening and closing fences are
 * equal runs of 4+ backticks with no info string, returns the inner text
 * (byte-identical to what was fenced). Otherwise returns the input unchanged.
 *
 * Never strips a 3-backtick fence (that is ordinary user content -- 3 is
 * `fencedBlock`'s own minimum for content with no backticks at all, so a
 * lower threshold here would eat legitimate user-authored fences). Never
 * strips when the fence does not span the whole input, or when it carries an
 * info string. The closing fence is matched only at the true end of input --
 * greedy backtracking naturally finds the LAST `\n<fence>` in the string, so
 * a same-length backtick run inside the content is never mistaken for the
 * close.
 */
export function stripRenderFence(input: string): { text: string; stripped: boolean } {
  const trimmed = input.trim();
  const match = /^(`{4,})\n([\s\S]*)\n\1$/.exec(trimmed);
  if (!match) return { text: input, stripped: false };
  return { text: match[2] as string, stripped: true };
}

/**
 * T-476: markdown rendering for a citing item's resolved rulings.
 * `resolutions` defaults to empty everywhere it is threaded through, so an
 * existing caller that never resolves citations renders byte-identically to
 * before this ticket -- this returns "" for an empty list.
 */
/**
 * Shared "## Cited Rulings" markdown block, also reused verbatim by the
 * autonomous-mode instruction builders (T-476 acceptance 4) -- an agent
 * reading PLAN/issue-fix instructions gets the same rendering, including the
 * unconditional anti-laundering caveat, as a human reading `ticket get`.
 */
export function formatCitedRulingsSection(resolutions: readonly CitationResolution[]): string {
  return formatCitedRulingsSectionBounded(resolutions, Number.POSITIVE_INFINITY).text;
}

/** What a bounded render produced, and what it had to leave out. */
export interface BoundedCitedRulings {
  readonly text: string;
  /** Rulings whose TEXT was replaced by a marker. Metadata is never dropped. */
  readonly truncatedIds: readonly string[];
}

/**
 * T-494: the ONE renderer, with an optional bound on ruling TEXT.
 *
 * Two tiers, because they fail differently. Id, status, stale label,
 * attribution, recorder and date are ALWAYS present and never truncated: that
 * is what makes a ruling's existence undeniable even when its text will not
 * fit. Only TEXT is subject to the budget, and a dropped text is replaced by a
 * marker naming how to fetch it, never by a silent slice.
 *
 * The bound is on text and NOT on the rendered block on purpose. Slicing the
 * rendered block would cut mid-ruling and delete every id, caveat and status
 * after the cut, which is precisely the guarantee this exists to provide.
 *
 * Inclusion is all-or-nothing per ruling and in CITATION ORDER: a ruling's text
 * goes in only if the running total still fits after adding it. Best-fit
 * packing would reorder rulings by length, and citation order is the order the
 * recorder chose.
 */
export function formatCitedRulingsSectionBounded(
  resolutions: readonly CitationResolution[],
  textBudget: number,
): BoundedCitedRulings {
  if (resolutions.length === 0) return { text: "", truncatedIds: [] };
  const truncatedIds: string[] = [];
  let spent = 0;
  const lines = resolutions.map((resolution) => {
    const rendered = renderCitation(resolution);
    if (rendered.status === "resolved" && rendered.current) {
      const staleNote = rendered.stale ? ` (superseded by ${rendered.current.id})` : "";
      const body = escapeMarkdownInline(rendered.current.text);
      // Measured on the ESCAPED text, which is what actually lands in the
      // block: escaping expands, so budgeting the raw text would under-count.
      const fits = spent + body.length <= textBudget;
      if (fits) spent += body.length;
      else truncatedIds.push(rendered.current.id);
      const head = fits
        ? `- **${escapeMarkdownInline(rendered.citedId)}**${staleNote}: "${body}"`
        : `- **${escapeMarkdownInline(rendered.citedId)}**${staleNote}: [text truncated, read with ruling_get ${rendered.current.id}]`;
      return [
        head,
        `  ${rendered.current.attribution}, recorded by ${rendered.current.recordedBy.client}/${rendered.current.recordedBy.id} on ${rendered.current.date}`,
        `  > ${rendered.current.caveat}`,
      ].join("\n");
    }
    return `- **${escapeMarkdownInline(rendered.citedId)}**: ${rendered.warning ?? rendered.status}`;
  });
  return { text: `\n\n## Cited Rulings\n\n${lines.join("\n")}`, truncatedIds };
}

/** T-476: JSON-safe embedding for a citing item's resolved rulings. */
function citedRulingsForJson(resolutions: readonly CitationResolution[]): unknown[] {
  return resolutions.map(renderCitation);
}

/**
 * One session line's worth of state-derived strings, made safe to PRINT (ISS-897).
 *
 * Every field here is read straight out of `state.json`, and several are free
 * strings by design -- `state` is deliberately unconstrained (T-328) so a newer
 * workflow state does not brick an older reader, and `mode`, `ticketId`, and
 * `ticketTitle` are equally open. `escapeMarkdownInline` protects line-leading Markdown markers -- it does not touch control characters, and it deliberately leaves inline links, HTML, code spans and emphasis alone;
 * it does not touch control characters, so an ESC or a newline in any of them
 * forges a line in the section an operator reads to decide whether another agent
 * is running. Sanitize FIRST, then escape. JSON output keeps the decoded values
 * unmodified,
 * because a consumer diffing against the file needs what is actually there.
 */
/**
 * Every session-row field, rendered inert for a Markdown DOCUMENT (ISS-897).
 *
 * `escapeMarkdownInline` was the wrong pass here and the suite pinned it as
 * intended. It guards line-leading markers and deliberately preserves inline
 * structure, which is right for a plain-text sink; the non-JSON branch of both
 * status formatters is not one. It emits `#` headings and `**bold**`, clients
 * render it, and every field below is read back out of a `state.json` -- so a
 * `ticketTitle` could author a live link, a raw element or a code span in the
 * status output an operator reads during an incident.
 *
 * The inconsistency is what settled it: `sessionDiagnosticLines` in this same
 * file already escapes strictly, and its values come from the SAME files. One
 * document cannot neutralize a directory name and leave the ticket title beside
 * it live.
 *
 * Sanitize FIRST, escape SECOND, as everywhere else: the strict pass doubles
 * backslashes, so running it before the encoder would double the ones the
 * encoder is about to write and hand back a live marker.
 *
 * Scope: session fields only. The ledger-sourced values on the same document
 * (project name, phase names, summaries) still take the inline pass, and that
 * boundary is ISS-915's -- a different source, a different set of callers, and
 * not something to change under cover of this one.
 */
function safeSessionFields(s: {
  sessionId: string;
  state: string;
  mode: string;
  ticketId: string | null;
  ticketTitle: string | null;
}): { ticket: string; state: string; mode: string; shortId: string } {
  const id = sanitizeDisplayText(s.ticketId ?? "");
  const title = escapeMarkdownDocumentStrict(sanitizeDisplayText(s.ticketTitle ?? ""));
  return {
    ticket: s.ticketId ? `${escapeMarkdownDocumentStrict(id)}: ${title}` : "",
    state: escapeMarkdownDocumentStrict(sanitizeDisplayText(s.state)),
    mode: escapeMarkdownDocumentStrict(sanitizeDisplayText(s.mode)),
    // By CODE POINT, not by UTF-16 unit. `sanitizeDisplayText` is careful not
    // to split a surrogate pair and this `slice` immediately could: an id whose
    // eighth unit lands inside an astral character leaves a lone high
    // surrogate, which draws as the replacement glyph -- so two different
    // sessions can produce the same short id, on the resumable rows an operator
    // reads to tell them apart during an incident.
    shortId: escapeMarkdownDocumentStrict([...sanitizeDisplayText(s.sessionId)].slice(0, 8).join("")),
  };
}

function formatConfigHints(state: ProjectState): string[] {
  const overrides = state.config.recipeOverrides as Record<string, unknown> | undefined;
  const backends = overrides?.reviewBackends as string[] | undefined;
  const lines: string[] = [];
  if (backends && backends.length > 0) {
    lines.push(`Review backends: ${backends.join(", ")}`);
  } else {
    lines.push("Review backends: codex, agent (default). Change with `/story settings` or `storybloq config set-overrides --json '{\"reviewBackends\": [\"codex\", \"agent\"]}'`");
  }
  lines.push("");
  return lines;
}

// --- Format Functions ---

/**
 * Markdown for the faults a session scan could not account for (ISS-897).
 *
 * Rendered only when non-empty, so an empty diagnostics collection adds no
 * Session Scan Warnings section at all. (Not a claim that the whole output is
 * unchanged from before this work: session rows now take document escaping and
 * are bounded, and a non-expired resumable lease is worded differently.) `omission` entries come first and
 * are labelled as such, because those are the ones where a session may be
 * running and was not seen -- the rest are annotations on records the scan
 * ADMITTED, which appear in the reported populations unless deduplication later
 * drops them.
 */
function sessionDiagnosticLines(diagnostics: readonly SessionScanDiagnostic[]): string[] {
  if (diagnostics.length === 0) return [];
  const concealing = diagnostics.filter((d) => d.category === "omission");
  const header = ["", "## Session Scan Warnings", ""];
  const lines: string[] = [];
  if (concealing.length > 0) {
    header.push(
      `The scan reported ${concealing.length} gap${concealing.length === 1 ? "" : "s"} under \`.story/sessions\`, ` +
        "so whether a session is running here cannot be established from this output alone." +
        (concealing.some((d) => d.sourceDir === null)
          ? " At least one is a fault against the collection itself, where nothing was enumerated and no entry was ever observed, so it names a path rather than a directory."
          : ""),
      "",
    );
  }
  for (const d of [...concealing, ...diagnostics.filter((d) => d.category !== "omission")]) {
    // Both the name and the reason carry filesystem input, and BOTH get the
    // document treatment rather than the line-start-only one the rest of this
    // formatter uses.
    //
    // The rest of this formatter is the way it is by an explicit decision:
    // inline and HTML escaping were removed because they leaked visible
    // `&amp;` and `\[` noise onto plain-text consumers. That decision is now
    // wrong for a `format: "md"` MCP result, which a client may render -- but
    // re-deciding it for every ticket title in the ledger is ISS-915, not this
    // change. What this change may not do is ADD a surface with the problem.
    // These lines are new here, they carry a directory name straight off disk,
    // and they are the incident warning itself: a name that authors a link in
    // the sentence telling an operator a session may be concealed is the worst
    // place in the output to put one. Partial protection beats none; the
    // inconsistency is recorded in ISS-915 rather than used as a reason to
    // leave the new surface open.
    //
    // BOTH renderings when there is a directory name, because they answer
    // different questions and neither substitutes for the other. The name is a
    // LABEL: short, readable, capped at a label width, and the thing a reader
    // scans a list by. It is also LOSSY -- `sanitizeDisplayText` maps every
    // control character, bidi mark and invisible to `?`, and `?` is itself a
    // legal filename character -- so `dir<ESC>x`, `dir<U+202E>x` and a directory
    // genuinely named `dir?x` all print as `dir?x`. On the one line in this
    // output that says a session may be CONCEALED, that is the failure the line
    // exists to report, manufactured by the line reporting it.
    //
    // So the reversible `sourcePath` comes too, as the ADDRESS. It is bounded by
    // `PATH_MAX` rather than a label width (truncating an address does not
    // shorten it, it makes it wrong) and it is injective, so the three names
    // above stay three names. Collection-level faults have `sourceDir: null` by
    // design and have only the address, which is why that branch prints it
    // alone rather than printing an empty label beside it.
    //
    // Sanitize FIRST, neutralize Markdown SECOND, in both branches -- but for
    // different reasons, and only one of them is a hazard. For the `sourcePath`
    // ADDRESS the order is load-bearing: `sanitizeDisplayPath` introduces and
    // doubles backslashes, and `escapeMarkdownDocumentStrict` doubles them as
    // its first step, so running the escaper last is what leaves those escapes
    // as literal text. Reversed, the encoder would double the backslash the
    // Markdown pass had just inserted and `\[` would become `\\[` -- an
    // escaped backslash followed by a live `[`. For the `sourceDir` LABEL the
    // same order is a convention: `sanitizeDisplayText` substitutes `?` and
    // touches no backslash, so it cannot suffer that. Keep it anyway, so one
    // order covers every prose sink and a call site is checkable at a glance.
    const address = escapeMarkdownDocumentStrict(sanitizeDisplayPath(d.sourcePath));
    const where =
      d.sourceDir !== null
        ? `**${escapeMarkdownDocumentStrict(sanitizeDisplayText(d.sourceDir))}** (path: ${address})`
        : `**${address}**`;
    lines.push(
      `- ${where} (${d.kind}, ${d.category}) -- ` +
        // A PROSE budget, not the label width the name above takes. The label
        // cap truncated these paragraphs mid-remedy, and the remedy is the
        // part that says not to delete anything.
        `${escapeMarkdownDocumentStrict(sanitizeDisplayText(d.reason, MAX_PROSE_LENGTH))}`,
    );
  }
  // Bounded as a SECTION, not only per entry. Each reason is capped and each
  // name is capped; the NUMBER of diagnostics is neither, and a
  // workspace-controlled sessions directory decides it -- so an md status
  // response can still be flooded with every per-value bound in place. What
  // survives the cut is the count and where the complete set is, because a
  // shortened section that does not say so reads as a complete one.
  return [
    ...header,
    ...boundedLines(lines, {
      maxLines: MAX_DIAGNOSTIC_LINES,
      noun: "scan warnings",
      fullSetHint: "The complete set is in `sessionDiagnostics` of the JSON output.",
    }),
  ];
}

/**
 * Markdown for records the scan observed but could place in neither
 * `activeSessions` nor `resumableSessions` because their lease is
 * determinately expired (ISS-943).
 *
 * Membership proves only that the LEASE is expired, never that the owning
 * process is dead -- worded accordingly, and rendered through
 * `safeSessionFields` exactly as the other two session populations are,
 * since this shares the identical `ActiveSessionSummary` shape and the
 * identical hostile-field exposure.
 */
function expiredLeaseSessionsSection(expiredLeaseSessions: readonly ActiveSessionSummary[]): string[] {
  if (expiredLeaseSessions.length === 0) return [];
  const lines = ["", "## Expired-Lease Sessions", ""];
  const rows = expiredLeaseSessions.map((s) => {
    const f = safeSessionFields(s);
    const ticket = f.ticket || `session ${f.shortId}`;
    return `- ${ticket} -- ${f.state} (${f.mode} mode), lease determinately expired; process liveness not established`;
  });
  lines.push(
    ...boundedLines(rows, {
      maxLines: MAX_SESSION_ROWS,
      noun: "expired-lease sessions",
      fullSetHint: "The complete set is in `expiredLeaseSessions` of the JSON output.",
    }),
  );
  return lines;
}

/**
 * Markdown for active duet-mode arrangements (T-473). Rendered only when
 * non-empty. `arrangementWarnings` is advisory text composed elsewhere
 * (`arrangement-loader.ts`'s `loadArrangementsSafe`, `handleStatus`'s bounds
 * staleness check) and already passed through `sanitizeDisplayText` at that
 * composition point (control/bidi characters neutralized); this function
 * additionally runs every string through `escapeMarkdownInline` before
 * rendering, same as every other piece of prose in this file, since
 * sanitizing control characters and neutralizing Markdown structure are two
 * separate concerns.
 */
function arrangementsSection(arrangements: StatusArrangements): string[] {
  if (arrangements.items.length === 0 && arrangements.warnings.length === 0) return [];
  const lines = ["", "## Arrangements", ""];
  for (const a of arrangements.items) {
    const parties = a.parties.map((p) => `${p.role} (${p.client})`).join(", ");
    lines.push(
      `- ${escapeMarkdownInline(a.id)} [${a.lifecycle}] -- bounds: ${escapeMarkdownInline(a.bounds.join(", "))}; parties: ${escapeMarkdownInline(parties)}${a.route ? `; communication: ${escapeMarkdownInline(a.route.status)}${a.route.mode ? ` (${escapeMarkdownInline(a.route.mode)})` : ""}` : ""}`,
    );
  }
  for (const w of arrangements.warnings) {
    lines.push(`- warning: ${escapeMarkdownInline(w)}`);
  }
  return lines;
}

/** Active-only projection of an Arrangement for status display (T-473). */
export interface StatusArrangementSummary {
  readonly route?: DuetRoute;
  readonly id: string;
  readonly lifecycle: ArrangementLifecycle;
  readonly bounds: readonly string[];
  readonly parties: readonly { readonly role: ArrangementRole; readonly client: StorybloqClient }[];
}

export interface StatusArrangements {
  readonly items: readonly StatusArrangementSummary[];
  readonly warnings: readonly string[];
}

/**
 * T-432: the 30-day issue-flow window, computed once over the records the
 * project load already parsed.
 *
 * `new Date()` lives HERE and nowhere deeper: `computeIssueFlow` takes `now` as
 * a parameter so its behaviour at a window boundary is testable, and a function
 * that reads the clock internally is not.
 *
 * RETURNS NULL WHEN THE RECORDS ARE NOT THERE, and the caller then prints the
 * plain open count with no window at all. Several callers here pass a partial
 * state carrying only the counts, and the previous line survived that because
 * `activeIssueCount` is a number while this reads the array. The fix is not a
 * defensive default: printing `+0 opened / -0 resolved` over records we never
 * saw is a fabricated zero, which is the one thing this whole ticket exists to
 * prevent. No records, no window.
 */
function statusIssueFlow(state: ProjectState): ReturnType<typeof computeIssueFlow> | null {
  if (!Array.isArray(state.activeIssues)) return null;
  return computeIssueFlow(state.activeIssues, 30, new Date());
}

/** The md line: the window when we have the records, the plain count when not. */
function issueLine(state: ProjectState): string {
  const flow = statusIssueFlow(state);
  const base = flow === null ? `Issues: ${state.activeIssueCount} open` : formatIssueFlow(flow);
  return `${base}${nonActionableSuffix(state)}`;
}

/**
 * ISS-1113: one clause naming how many of those open issues nobody is going to
 * act on, and why they are still counted as open.
 *
 * Printed only when there ARE some. A permanent "0 non-actionable" would be
 * noise on every project that never files one, and the number it would be
 * reporting is already implied by the open count it sits beside.
 *
 * Guarded on the field being a number because several callers here pass a
 * partial state carrying only counts (the same reason `statusIssueFlow`
 * returns null rather than fabricating a window), and a fabricated zero here
 * would claim the ledger was read when it was not.
 */
function nonActionableSuffix(state: ProjectState): string {
  const actionable = state.actionableOpenIssueCount;
  if (typeof actionable !== "number" || typeof state.activeIssueCount !== "number") return "";
  const nonActionable = state.activeIssueCount - actionable;
  if (nonActionable <= 0) return "";
  return ` (${nonActionable} non-actionable, not ranked as work)`;
}

/**
 * T-320 commit 3: the eight session fields Step 2's reconciliation reads
 * (SKILL.md 1b's fingerprint plus `mode`/`leaseExpiresAt`). Drops
 * `ticketId`/`ticketTitle`, which reconciliation never reads. Exported so the
 * acceptance test (`scripts/priming-cost.ts`'s `reconcileFingerprints`, the
 * harness's own transcription of that reconciliation logic) can run against
 * this SAME reduction rather than a second, test-local one.
 */
export function reduceSessionForCompact(s: ActiveSessionSummary): Pick<ActiveSessionSummary, "sessionId" | "sourceDir" | "state" | "mode" | "ownerTask" | "leaseState" | "leaseExpiresAt" | "compactPending"> {
  return {
    sessionId: s.sessionId,
    sourceDir: s.sourceDir,
    state: s.state,
    mode: s.mode,
    ownerTask: s.ownerTask,
    leaseState: s.leaseState,
    leaseExpiresAt: s.leaseExpiresAt,
    compactPending: s.compactPending,
  };
}

/**
 * T-320 commit 3: reduces `bus` to the six fields the ticket's amendment
 * names, dropping `participants`, `wake`, `hookDelivery`, and
 * `deliveryCapabilities` (named explicitly) plus `initialized`, `setupState`,
 * `endpoints`, `openThreads`, `parkedThreads`, `undeliverable`, and
 * `quarantined` (also outside the kept list). The error variant (bus runtime
 * unreachable) carries none of those fields to begin with, so it passes
 * through unchanged.
 */
function reduceBusForCompact(bus: BusStatusInput): unknown {
  if (!bus) return bus;
  if ("error" in bus) return bus;
  return {
    enabled: bus.enabled,
    daemonState: bus.daemonState,
    deliveryMode: bus.deliveryMode,
    pendingMessages: bus.pendingMessages,
    unacknowledgedCritical: bus.unacknowledgedCritical,
    nextActions: bus.nextActions,
  };
}

/**
 * T-320 commit 3: the compact JSON payload. Only the single-project status
 * shape is defined by the ticket (no federated/compact combination is
 * specified), so `compact` has no effect on `formatFederatedStatus`. JSON
 * only, by the ticket's own text -- callers reach this branch regardless of
 * the `format` argument, since no Markdown compact rendering exists to keep
 * byte-compatible.
 *
 * T-508: exported so the ledger sidebar Mod's projection can be checked
 * against it rather than forked. A hooks module cannot import this file (the
 * client admits only relative imports inside the plugin's own folder, and
 * this module's graph reaches `node:` code), so the sidebar carries its own
 * pure projection and one vitest asserts the two agree on a fixture `.story/`.
 * That test is what "do not fork the projection" means here; this export
 * exists to give it the other side of the equality.
 */
export function buildCompactStatusData(
  state: ProjectState,
  activeSessions: readonly ActiveSessionSummary[],
  resumableSessions: readonly ActiveSessionSummary[],
  bus: BusStatusInput,
  sessionDiagnostics: readonly SessionScanDiagnostic[] | undefined,
  expiredLeaseSessions: readonly ActiveSessionSummary[],
  arrangements: StatusArrangements,
) {
  const phases = phasesWithStatus(state);
  return {
    project: state.config.project,
    totalTickets: state.leafTicketCount,
    completeTickets: state.completeLeafTicketCount,
    openTickets: state.leafTicketCount - state.completeLeafTicketCount,
    blockedTickets: state.blockedCount,
    openIssues: state.activeIssueCount,
    // ISS-1113: `actionableOpenIssues` is deliberately NOT here, only in the
    // full payload below. T-320 pinned this key list as an exact contract --
    // `status-roster.test.ts` asserts `Object.keys(...)` equals it verbatim --
    // and widening another ticket's reduced shape is not this slice's to do.
    // Nothing reads the number programmatically; the markdown line carries it
    // for a reader either way.
    //
    // No `semantics` here (unlike full status): the compact schema explicitly
    // omits `issueFlow.semantics`.
    issueFlow: statusIssueFlow(state),
    activeNotes: state.activeNoteCount,
    activeLessons: state.activeLessonCount,
    handovers: state.handoverFilenames.length,
    isEmptyScaffold: state.isEmptyScaffold,
    phases: phases.map((p) => ({
      id: p.phase.id,
      name: p.phase.name,
      status: p.status,
      leafCount: p.leafCount,
    })),
    activeSessions: activeSessions.map(reduceSessionForCompact),
    resumableSessions: resumableSessions.map(reduceSessionForCompact),
    expiredLeaseSessions: expiredLeaseSessions.map(reduceSessionForCompact),
    ...(sessionDiagnostics ? { sessionDiagnostics } : {}),
    ...(bus ? { bus: reduceBusForCompact(bus) } : {}),
    arrangements: arrangements.items,
    arrangementWarnings: arrangements.warnings,
  };
}

/** T-507: one line, live and stale only; terminal seats are hidden from status (they stay in `roster list --all`). */
function rosterStatusLines(roster: StatusRoster | undefined): string[] {
  if (!roster) return [];
  // An unreadable roster is not an empty one, and a cut scan is not the
  // population: the line says so instead of presenting the counts as whole.
  if (roster.diagnostics.some((d) => d.startsWith("roster unreadable"))) {
    return ["Seats: unknown (roster unreadable; see roster list)"];
  }
  const partial = roster.scanTruncated || roster.resultTruncated || roster.busScanTruncated || roster.diagnostics.length > 0;
  const qualifier = partial ? " (partial; see roster list)" : "";
  return [`Seats: ${roster.live} live, ${roster.stale} stale${qualifier}`];
}

export function formatStatus(
  state: ProjectState,
  format: OutputFormat,
  activeSessions: readonly ActiveSessionSummary[] = [],
  resumableSessions: readonly ActiveSessionSummary[] = [],
  bus?: BusSummary | { readonly enabled: true; readonly error: { readonly code: string; readonly message: string } },
  // T-534: the usage-limit auto-resume is retired and status no longer
  // reports limit stops. The positional slot stays (ignored) so callers
  // passing the later arguments by position are not shifted.
  _retiredLimitStops: readonly unknown[] = [],
  sessionDiagnostics?: readonly SessionScanDiagnostic[],
  // ISS-943, APPENDED LAST and deliberately not inserted beside
  // `activeSessions`/`resumableSessions`: `formatStatus` is positional and
  // exported from the package root (`core/index.ts` -> `src/index.ts`), so
  // inserting a parameter anywhere but the end would shift `bus`/the retired slot/
  // `sessionDiagnostics` for any external caller still using positional args.
  expiredLeaseSessions: readonly ActiveSessionSummary[] = [],
  // T-473, same APPENDED-LAST discipline as `expiredLeaseSessions` above.
  // Always present, empty-when-none (same ISS-891 convention as
  // `activeSessions`) -- `arrangementWarnings` is advisory prose text and is
  // NEVER folded into `sessionDiagnostics`/any integrity-warning channel:
  // doing so would change this command's exit classification for a merely
  // degraded, non-blocking arrangement read.
  arrangements: StatusArrangements = { items: [], warnings: [] },
  // T-320 commit 3, same APPENDED-LAST discipline. JSON only: when true, this
  // returns the compact payload regardless of `format`, since the ticket
  // defines no Markdown compact rendering. Omitting it (or passing `false`)
  // leaves every prior positional caller byte-identical.
  compact: boolean = false,
  // T-507, same APPENDED-LAST discipline. The seat roster (running seats plus
  // counts), non-compact JSON and one Markdown line only: the compact payload
  // is T-320's pinned schema and does not gain a key. Omitted means unknown,
  // not empty, so a bare formatter call carries no `roster` key at all.
  roster?: StatusRoster,
): string {
  if (compact) {
    return JSON.stringify(
      successEnvelope(
        buildCompactStatusData(
          state,
          activeSessions,
          resumableSessions,
          bus,
          sessionDiagnostics,
          expiredLeaseSessions,
          arrangements,
        ),
      ),
      null,
      2,
    );
  }
  const phases = phasesWithStatus(state);
  // ISS-1112: formatStatus is exported from the package root, and a caller
  // holding only the counts passes a partial state with no phaseTickets. That
  // count is unknown, not zero: the key and the line are omitted.
  const unphasedOpenTickets = typeof state.phaseTickets === "function" ? openUnphasedLeaves(state).length : undefined;
  const data = {
    project: state.config.project,
    totalTickets: state.leafTicketCount,
    completeTickets: state.completeLeafTicketCount,
    openTickets: state.leafTicketCount - state.completeLeafTicketCount,
    blockedTickets: state.blockedCount,
    openIssues: state.activeIssueCount,
    // ISS-1113: the subset that is work. ADDED beside `openIssues`, never
    // folded into it -- see the field's own comment on ProjectState.
    actionableOpenIssues: state.actionableOpenIssueCount,
    // T-432: the same numbers the md line prints, so the two cannot disagree.
    // `semantics` travels WITH them because "opened / resolved" is a balance of
    // record dates, not a backlog delta, and a consumer reading only the numbers
    // would have no way to know that.
    issueFlow: (() => {
      const flow = statusIssueFlow(state);
      // NULL, not a zeroed object: a consumer must be able to tell "no
      // issues opened in 30 days" from "the window could not be computed".
      return flow === null ? null : { ...flow, semantics: ISSUE_FLOW_SEMANTICS };
    })(),
    activeNotes: state.activeNoteCount,
    archivedNotes: state.archivedNoteCount,
    activeLessons: state.activeLessonCount,
    deprecatedLessons: state.deprecatedLessonCount,
    handovers: state.handoverFilenames.length,
    isEmptyScaffold: state.isEmptyScaffold,
    phases: phases.map((p) => ({
      id: p.phase.id,
      name: p.phase.name,
      status: p.status,
      leafCount: p.leafCount,
    })),
    // ISS-891: always present, empty when there are none. Omitting them made
    // "no sessions" and "server too old to report sessions" the same observation,
    // so every consumer -- the skill's active-session guard most of all -- had to
    // fail closed and re-verify through the CLI. Presence is now the capability
    // signal and the contents are the answer.
    activeSessions,
    resumableSessions,
    // ISS-943: same always-present, empty-when-none contract as the two
    // populations above -- a record whose lease is determinately expired but
    // whose process may still be alive, held in neither of those two.
    expiredLeaseSessions,
    // ISS-897: everything the scan could NOT account for.
    //
    // Serialized ONLY when the caller actually supplied it, which is why this
    // parameter has no default. An empty array is a positive claim -- "the scan
    // ran and concealed nothing" -- and defaulting to one would make every
    // caller that performed NO scan assert a verified-clean result, which is
    // exactly the fail-open the field exists to close. `handleStatus` always
    // passes the scanner's own output, so real status responses always carry it;
    // a bare formatter call omits it, and an absent key means "unknown", not
    // "clean".
    ...(sessionDiagnostics ? { sessionDiagnostics } : {}),
    // `bus` stays conditional, and is NOT the same defect: it is an optional
    // parameter of these exported formatters, not an answer withheld when
    // empty. The CLI always supplies a summary -- busSummary returns one with
    // `enabled: false` for a disabled project rather than undefined -- so its
    // absence here means only that a caller omitted the argument.
    ...(bus ? { bus } : {}),
    // T-473: active-only arrangements, same always-present/empty-when-none
    // convention. `arrangementWarnings` is a separate, purely advisory key --
    // never merged into `sessionDiagnostics` or any other channel this
    // command's exit code reads from.
    arrangements: arrangements.items,
    arrangementWarnings: arrangements.warnings,
    // T-507: present only when the caller read the roster (handleStatus
    // always does); an absent key means "not read", never "no seats".
    ...(roster ? { roster } : {}),
    // T-537 S5: always present, zeros when there are none. Not in the compact
    // payload, whose schema T-320 pinned.
    checkpoints: checkpointCounts(state.tickets),
    // ISS-1112: open unphased leaves, appended last; the compact payload
    // (T-320's pinned schema) does not gain it.
    ...(unphasedOpenTickets !== undefined ? { unphasedOpenTickets } : {}),
  };

  if (format === "json") {
    return JSON.stringify(successEnvelope(data), null, 2);
  }

  const lines: string[] = [
    `# ${escapeMarkdownInline(state.config.project)}`,
    "",
    `Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete, ${state.blockedCount} blocked`,
    ...checkpointStatusLines(data.checkpoints),
    issueLine(state),
    `Notes: ${state.activeNoteCount} active, ${state.archivedNoteCount} archived`,
    `Lessons: ${state.activeLessonCount} active, ${state.deprecatedLessonCount} deprecated`,
    `Handovers: ${state.handoverFilenames.length}`,
    ...rosterStatusLines(roster),
    ...busStatusLines(bus),
    "",
    ...formatConfigHints(state),
    "## Phases",
    "",
  ];
  for (const p of phases) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    const summary = p.phase.summary ?? truncate(p.phase.description, 80);
    lines.push(`${indicator} **${escapeMarkdownInline(p.phase.name)}** (${p.leafCount} tickets) -- ${escapeMarkdownInline(summary)}`);
  }
  if (unphasedOpenTickets !== undefined && unphasedOpenTickets > 0) {
    lines.push(`Unphased (${unphasedOpenTickets}): assign a phase to control roadmap priority`);
  }

  const resumableIds = new Set(resumableSessions.map((session) => session.sessionId));
  const ordinaryActiveSessions = activeSessions.filter((session) => !resumableIds.has(session.sessionId));
  if (ordinaryActiveSessions.length > 0) {
    lines.push("");
    lines.push("## Active Sessions");
    lines.push("");
    // Bounded across the POPULATION: the sessions directory decides how many
    // rows there are, and an unbounded list pushes the scan warnings below it
    // out of view. The JSON payload stays complete.
    lines.push(
      ...boundedLines(
        ordinaryActiveSessions.map((s) => {
          const f = safeSessionFields(s);
          const ticket = f.ticket || "no ticket";
          const owner = s.ownerTask ? ` in a ${s.ownerTask.client === "codex" ? "Codex" : "Claude Code"} task` : "";
          return `- ${ticket} -- ${f.state}${owner} (${f.mode} mode)`;
        }),
        {
          maxLines: MAX_SESSION_ROWS,
          noun: "active sessions",
          fullSetHint: "The complete set is in `activeSessions` of the JSON output.",
        },
      ),
    );
  }

  if (resumableSessions.length > 0) {
    lines.push("");
    lines.push("## Resumable Sessions");
    lines.push("");
    const resumableRows = resumableSessions.map((s) => {
      const f = safeSessionFields(s);
      const ticket = f.ticket || `session ${f.shortId}`;
      // ISS-897: membership in this population does NOT mean resumable. Only a
      // positively EXPIRED lease is. `missing` and `invalid` mean the lease was
      // never established, so announcing recovery for them offers recovery
      // against a liveness nobody observed -- which is what the old wording,
      // "COMPACT recovery available (missing lease)", did for every member.
      return s.leaseState === "expired"
        ? `- ${ticket} -- COMPACT recovery available (expired lease)`
        : `- ${ticket} -- COMPACT, but its lease is ${s.leaseState ?? "unknown"}, so its liveness is undetermined and it is NOT resumable; run \`storybloq session list\``;
    });
    lines.push(
      ...boundedLines(resumableRows, {
        maxLines: MAX_SESSION_ROWS,
        noun: "resumable sessions",
        fullSetHint: "The complete set is in `resumableSessions` of the JSON output.",
      }),
    );
  }

  lines.push(...expiredLeaseSessionsSection(expiredLeaseSessions));
  lines.push(...sessionDiagnosticLines(sessionDiagnostics ?? []));
  lines.push(...arrangementsSection(arrangements));

  if (state.isEmptyScaffold) {
    lines.push("");
    lines.push(EMPTY_SCAFFOLD_HEADING);
    lines.push("");
    lines.push("This project has been initialized but has no tickets, issues, or handovers yet.");
    lines.push("Run the /story setup flow to analyze your project and create an initial roadmap.");
  }

  return lines.join("\n");
}

export function formatFederatedStatus(
  fedState: FederationState,
  config: Config,
  format: OutputFormat,
  activeSessions: readonly ActiveSessionSummary[] = [],
  resumableSessions: readonly ActiveSessionSummary[] = [],
  bus?: BusSummary | { readonly enabled: true; readonly error: { readonly code: string; readonly message: string } },
  // T-534: the usage-limit auto-resume is retired and status no longer
  // reports limit stops. The positional slot stays (ignored) so callers
  // passing the later arguments by position are not shifted.
  _retiredLimitStops: readonly unknown[] = [],
  sessionDiagnostics?: readonly SessionScanDiagnostic[],
  // ISS-943: appended last, matching `formatStatus`'s placement, for signature
  // symmetry between the two -- this function is not in `core/index.ts`'s
  // export list and has exactly one in-repo call site, so it carries no
  // external-compatibility risk of its own, but drifting the two functions
  // into different parameter orders for the same concept would be its own
  // hazard.
  expiredLeaseSessions: readonly ActiveSessionSummary[] = [],
  // T-473: appended last, matching `formatStatus`'s placement, same reasons.
  arrangements: StatusArrangements = { items: [], warnings: [] },
  // T-507: appended last, matching `formatStatus`'s placement, same reasons.
  roster?: StatusRoster,
): string {
  // NO ISSUE-FLOW LINE HERE, deliberately, and this comment is the plan's
  // "or an explicit comment saying why not".
  //
  // The window is computed from `discoveredDate` and `resolvedDate` on issue
  // RECORDS. This function receives `FederationState` and `Config`, never a
  // `ProjectState`, and a federated node reaches it as a scan summary carrying
  // `issueCount` and `openIssues` -- COUNTS, not dated records. A window cannot
  // be derived from a count, and summing per-node counts into a "+N opened"
  // would be a fabricated number of exactly the kind this whole ticket exists to
  // prevent. Delivering it properly means re-scanning each node's issue files,
  // which is a separate change and is not in this cut.
  const sanitizedNodes = fedState.nodes.map((node) => ({
    name: node.name,
    rawPath: node.rawPath,
    health: node.health,
    role: node.role,
    summary: node.summary,
    dependsOn: node.dependsOn,
    reachable: node.reachable,
    scanSummary: node.scanSummary,
  }));
  const data = {
    federation: { ...fedState, nodes: sanitizedNodes },
    project: config.project,
    type: config.type,
    // ISS-891: always present, empty when there are none. Omitting them made
    // "no sessions" and "server too old to report sessions" the same observation,
    // so every consumer -- the skill's active-session guard most of all -- had to
    // fail closed and re-verify through the CLI. Presence is now the capability
    // signal and the contents are the answer.
    activeSessions,
    resumableSessions,
    // ISS-943: same always-present, empty-when-none contract as the two
    // populations above.
    expiredLeaseSessions,
    // ISS-897: everything the scan could NOT account for.
    //
    // Serialized ONLY when the caller actually supplied it, which is why this
    // parameter has no default. An empty array is a positive claim -- "the scan
    // ran and concealed nothing" -- and defaulting to one would make every
    // caller that performed NO scan assert a verified-clean result, which is
    // exactly the fail-open the field exists to close. `handleStatus` always
    // passes the scanner's own output, so real status responses always carry it;
    // a bare formatter call omits it, and an absent key means "unknown", not
    // "clean".
    ...(sessionDiagnostics ? { sessionDiagnostics } : {}),
    // `bus` stays conditional, and is NOT the same defect: it is an optional
    // parameter of these exported formatters, not an answer withheld when
    // empty. The CLI always supplies a summary -- busSummary returns one with
    // `enabled: false` for a disabled project rather than undefined -- so its
    // absence here means only that a caller omitted the argument.
    ...(bus ? { bus } : {}),
    // T-473: active-only arrangements, same always-present/empty-when-none
    // convention. `arrangementWarnings` is a separate, purely advisory key --
    // never merged into `sessionDiagnostics` or any other channel this
    // command's exit code reads from.
    arrangements: arrangements.items,
    arrangementWarnings: arrangements.warnings,
    // T-507: present only when the caller read the roster (handleStatus
    // always does); an absent key means "not read", never "no seats".
    ...(roster ? { roster } : {}),
  };

  if (format === "json") {
    return JSON.stringify(successEnvelope(data), null, 2);
  }

  const lines: string[] = [
    `# ${escapeMarkdownInline(fedState.orchestratorProject)} (orchestrator)`,
    "",
    `Federation: ${fedState.nodeCount} nodes (${fedState.reachableCount} reachable${fedState.unreachableCount > 0 ? `, ${fedState.unreachableCount} unreachable` : ""})`,
    `Tickets: ${fedState.totalCompleteTickets}/${fedState.totalTickets} across all nodes | Issues: ${fedState.totalOpenIssues} open`,
    ...rosterStatusLines(roster),
    ...busStatusLines(bus),
    "",
  ];

  const overrides = config.recipeOverrides as Record<string, unknown> | undefined;
  const backends = overrides?.reviewBackends as string[] | undefined;
  if (backends && backends.length > 0) {
    lines.push(`Review backends: ${backends.join(", ")}`);
    lines.push("");
  }

  lines.push("## Nodes");
  lines.push("");
  lines.push("| Node | Health | Tickets | Issues | Last Activity | Role |");
  lines.push("|------|--------|---------|--------|---------------|------|");

  for (const node of fedState.nodes) {
    if (node.reachable && node.scanSummary) {
      const s = node.scanSummary;
      lines.push(
        `| ${escapeMarkdownInline(node.name)} | ${escapeMarkdownInline(node.health)} | ${s.completeTickets}/${s.ticketCount} | ${s.openIssues} open | ${escapeMarkdownInline(s.lastHandoverDate ?? "none")} | ${escapeMarkdownInline(node.role)} |`,
      );
    } else {
      lines.push(
        `| ${escapeMarkdownInline(node.name)} | ${escapeMarkdownInline(node.health)} | -- | -- | unreachable | ${escapeMarkdownInline(node.role)} |`,
      );
    }
  }

  const resumableIds = new Set(resumableSessions.map((session) => session.sessionId));
  const ordinaryActiveSessions = activeSessions.filter((session) => !resumableIds.has(session.sessionId));
  if (ordinaryActiveSessions.length > 0) {
    lines.push("");
    lines.push("## Active Sessions");
    lines.push("");
    // Bounded across the POPULATION: the sessions directory decides how many
    // rows there are, and an unbounded list pushes the scan warnings below it
    // out of view. The JSON payload stays complete.
    lines.push(
      ...boundedLines(
        ordinaryActiveSessions.map((s) => {
          const f = safeSessionFields(s);
          return `- ${f.ticket || "no ticket"} -- ${f.state} (${f.mode} mode)`;
        }),
        {
          maxLines: MAX_SESSION_ROWS,
          noun: "active sessions",
          fullSetHint: "The complete set is in `activeSessions` of the JSON output.",
        },
      ),
    );
  }

  if (resumableSessions.length > 0) {
    lines.push("");
    lines.push("## Resumable Sessions");
    lines.push("");
    const resumableRows = resumableSessions.map((s) => {
      const f = safeSessionFields(s);
      const ticket = f.ticket || `session ${f.shortId}`;
      // Same rule as the standard formatter, and it has to be stated twice
      // because the two build their rows independently (ISS-897). Membership in
      // this population does NOT mean resumable: only a positively EXPIRED
      // lease is. `missing` and `invalid` mean the lease was never established,
      // so announcing recovery for them offers recovery against a liveness
      // nobody observed -- and a federation operator sees only this surface.
      return s.leaseState === "expired"
        ? `- ${ticket} -- COMPACT recovery available (expired lease)`
        : `- ${ticket} -- COMPACT, but its lease is ${s.leaseState ?? "unknown"}, so its liveness is undetermined and it is NOT resumable; run \`storybloq session list\``;
    });
    lines.push(
      ...boundedLines(resumableRows, {
        maxLines: MAX_SESSION_ROWS,
        noun: "resumable sessions",
        fullSetHint: "The complete set is in `resumableSessions` of the JSON output.",
      }),
    );
  }

  lines.push(...expiredLeaseSessionsSection(expiredLeaseSessions));
  lines.push(...sessionDiagnosticLines(sessionDiagnostics ?? []));
  lines.push(...arrangementsSection(arrangements));

  return lines.join("\n");
}

export function formatPhaseList(
  state: ProjectState,
  format: OutputFormat,
): string {
  const phases = phasesWithStatus(state);
  const data = phases.map((p) => ({
    id: p.phase.id,
    label: p.phase.label,
    name: p.phase.name,
    description: p.phase.summary ?? p.phase.description,
    status: p.status,
    leafCount: p.leafCount,
  }));

  if (format === "json") {
    return JSON.stringify(successEnvelope(data), null, 2);
  }

  const lines: string[] = [];
  for (const p of data) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    lines.push(`${indicator} **${escapeMarkdownInline(p.name)}** (${p.id}) -- ${p.leafCount} tickets -- ${escapeMarkdownInline(truncate(p.description, 80))}`);
  }
  return lines.join("\n");
}

export function formatPhaseTickets(
  phaseId: string,
  state: ProjectState,
  format: OutputFormat,
  citedRulingsByTicketId: ReadonlyMap<string, readonly CitationResolution[]> = new Map(),
): string {
  const tickets = state.phaseTickets(phaseId);
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(
        tickets.map((t) => ({ ...t, ...checkpointJson(t), citedRulings: citedRulingsForJson(citedRulingsByTicketId.get(t.id) ?? []) })),
      ),
      null,
      2,
    );
  }
  if (tickets.length === 0) return "No tickets in this phase.";
  const lines: string[] = [];
  for (const t of tickets) {
    lines.push(formatTicketOneLiner(t, state));
    const rulingsSection = formatCitedRulingsSection(citedRulingsByTicketId.get(t.id) ?? []);
    if (rulingsSection) lines.push(rulingsSection);
  }
  return lines.join("\n");
}

/** The derived checkpoint view a ticket's JSON carries beside its raw `ownerCheckpoint`; absent when it has none. */
function checkpointJson(ticket: Ticket): { checkpoint?: CheckpointSummary } {
  const summary = checkpointSummary(ticket);
  return summary ? { checkpoint: summary } : {};
}

const checkpointText = (s: string) => escapeMarkdownInline(sanitizeDisplayText(s));

/** One line for a checkpoint, as `checkpoint list` prints it. */
export function formatCheckpointLine(s: CheckpointSummary): string {
  const what = s.kind === "acceptance" ? s.criteria : s.question;
  const parts = [`${checkpointText(s.id)} [checkpoint ${s.state}]`, checkpointText(s.title)];
  if (s.owner) parts.push(`owner ${checkpointText(s.owner)}`);
  if (what) parts.push(`${s.kind === "acceptance" ? "criteria" : "question"}: ${checkpointText(what)}`);
  if (s.expected) parts.push(`expected ${expectedFlags(s)}`);
  if (s.reason) parts.push(`unrecognized: ${checkpointText(s.reason)}`);
  return `- ${parts.join(" | ")}`;
}

function expectedFlags(s: CheckpointSummary): string {
  return s.expected ? `--generation ${s.expected.generation} --revision ${s.expected.revision} --digest ${s.expected.digest}` : "";
}

function checkpointDetailLines(s: CheckpointSummary): string[] {
  const lines = ["", "## Owner checkpoint", "", `State: ${s.state}${s.kind ? ` | Kind: ${s.kind}` : ""}${s.owner ? ` | Owner: ${checkpointText(s.owner)}` : ""}`];
  if (s.question !== undefined) lines.push(`Question: ${checkpointText(s.question)}`);
  if (s.criteria !== undefined) lines.push(`Criteria: ${checkpointText(s.criteria)}`);
  if (s.expected) lines.push(`Expected state: ${expectedFlags(s)}`);
  if (s.reason) lines.push(`Unrecognized: ${checkpointText(s.reason)}`);
  return lines;
}

function checkpointStatusLines(c: CheckpointCounts): string[] {
  if (c.pending + c.approved + c.retired + c.unrecognized === 0) return [];
  const unrecognized = c.unrecognized > 0 ? `, ${c.unrecognized} unrecognized` : "";
  return [`Checkpoints: ${c.pending} pending, ${c.approved} approved, ${c.retired} retired${unrecognized}`];
}

export function formatTicket(
  ticket: Ticket,
  state: ProjectState,
  format: OutputFormat,
  citedRulings: readonly CitationResolution[] = [],
  /** ISS-1154 2h: `{ actionability, unreadableHandoverCount }` when `withActionability` was requested. JSON-only. */
  extraJsonFields?: Record<string, unknown>,
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ ...ticket, ...checkpointJson(ticket), citedRulings: citedRulingsForJson(citedRulings), ...extraJsonFields }),
      null,
      2,
    );
  }

  const blocked = state.isBlocked(ticket) ? " [BLOCKED]" : "";
  const lines: string[] = [
    `# ${escapeMarkdownInline(displayIdOf(ticket))}: ${escapeMarkdownInline(ticket.title)}${blocked}`,
    "",
    `Status: ${ticket.status} | Type: ${ticket.type} | Phase: ${ticket.phase ?? "none"} | Order: ${ticket.order}`,
    `Created: ${ticket.createdDate}${ticket.completedDate ? ` | Completed: ${ticket.completedDate}` : ""}`,
  ];
  if (ticket.blockedBy.length > 0) {
    lines.push(`Blocked by: ${ticket.blockedBy.map((ref) => resolveTicketRefDisplay(ref, state)).join(", ")}`);
  }
  if (ticket.crossNodeBlockedBy && ticket.crossNodeBlockedBy.length > 0) {
    lines.push(`Cross-node blocked by: ${ticket.crossNodeBlockedBy.join(", ")}`);
  }
  if (ticket.parentTicket) {
    lines.push(`Parent: ${resolveTicketRefDisplay(ticket.parentTicket, state)}`);
  }
  const checkpoint = checkpointSummary(ticket);
  if (checkpoint) lines.push(...checkpointDetailLines(checkpoint));
  if (ticket.description) {
    lines.push("", "## Description", "", fencedBlock(ticket.description));
  }
  return lines.join("\n") + formatCitedRulingsSection(citedRulings);
}

export function formatNextTicketOutcome(
  outcome: NextTicketOutcome,
  state: ProjectState,
  format: OutputFormat,
  citedRulings: readonly CitationResolution[] = [],
): string {
  if (format === "json") {
    const enriched =
      outcome.kind === "found"
        ? { ...outcome, ticket: { ...outcome.ticket, citedRulings: citedRulingsForJson(citedRulings) } }
        : outcome;
    return JSON.stringify(successEnvelope(enriched), null, 2);
  }

  switch (outcome.kind) {
    case "empty_project":
      return "No phased tickets found.";

    case "all_complete":
      return "All phases complete.";

    case "all_blocked": {
      return `All ${outcome.blockedCount} incomplete tickets in phase "${escapeMarkdownInline(outcome.phaseId)}" are blocked.`;
    }

    case "found": {
      const t = outcome.ticket;
      const lines: string[] = [
        `# Next: ${escapeMarkdownInline(displayIdOf(t))} -- ${escapeMarkdownInline(t.title)}`,
        "",
        `Phase: ${t.phase ?? "none"} | Order: ${t.order} | Type: ${t.type}`,
      ];

      if (outcome.unblockImpact.wouldUnblock.length > 0) {
        const ids = outcome.unblockImpact.wouldUnblock.map((u) => displayIdOf(u)).join(", ");
        lines.push(`Completing this unblocks: ${ids}`);
      }

      if (outcome.umbrellaProgress) {
        const p = outcome.umbrellaProgress;
        lines.push(`Parent progress: ${p.complete}/${p.total} complete (${p.status})`);
      }

      if (t.description) {
        lines.push("", fencedBlock(t.description));
      }

      return lines.join("\n") + formatCitedRulingsSection(citedRulings);
    }
  }
}

export function formatNextTicketsOutcome(
  outcome: NextTicketsOutcome,
  state: ProjectState,
  format: OutputFormat,
  citedRulingsByTicketId: ReadonlyMap<string, readonly CitationResolution[]> = new Map(),
): string {
  if (format === "json") {
    const enriched =
      outcome.kind === "found"
        ? {
            ...outcome,
            candidates: outcome.candidates.map((c) => ({
              ...c,
              ticket: { ...c.ticket, citedRulings: citedRulingsForJson(citedRulingsByTicketId.get(c.ticket.id) ?? []) },
            })),
          }
        : outcome;
    return JSON.stringify(successEnvelope(enriched), null, 2);
  }

  switch (outcome.kind) {
    case "empty_project":
      return "No phased tickets found.";

    case "all_complete":
      return "All phases complete.";

    case "all_blocked": {
      const details = outcome.phases
        .map((p) => `${escapeMarkdownInline(p.phaseId)} (${p.blockedCount} blocked)`)
        .join(", ");
      return `All incomplete tickets are blocked across ${outcome.phases.length} phase${outcome.phases.length === 1 ? "" : "s"}: ${details}`;
    }

    case "found": {
      const { candidates, skippedBlockedPhases } = outcome;
      const lines: string[] = [];

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const t = c.ticket;

        if (i > 0) lines.push("", "---", "");

        // Single candidate: use # Next: format; multiple: use numbered format
        const tLabel = displayIdOf(t);
        if (candidates.length === 1) {
          lines.push(`# Next: ${escapeMarkdownInline(tLabel)} -- ${escapeMarkdownInline(t.title)}`);
        } else {
          lines.push(`# ${i + 1}. ${escapeMarkdownInline(tLabel)} -- ${escapeMarkdownInline(t.title)}`);
        }
        lines.push("", `Phase: ${t.phase ?? "none"} | Order: ${t.order} | Type: ${t.type}`);

        if (c.unblockImpact.wouldUnblock.length > 0) {
          const ids = c.unblockImpact.wouldUnblock.map((u) => displayIdOf(u)).join(", ");
          lines.push(`Completing this unblocks: ${ids}`);
        }

        if (c.umbrellaProgress) {
          const p = c.umbrellaProgress;
          lines.push(`Parent progress: ${p.complete}/${p.total} complete (${p.status})`);
        }

        if (t.description) {
          lines.push("", fencedBlock(t.description));
        }
        const rulingsSection = formatCitedRulingsSection(citedRulingsByTicketId.get(t.id) ?? []);
        if (rulingsSection) lines.push(rulingsSection);
      }

      if (skippedBlockedPhases.length > 0) {
        const details = skippedBlockedPhases
          .map((p) => `${escapeMarkdownInline(p.phaseId)} (${p.blockedCount} blocked)`)
          .join(", ");
        lines.push("", "---", "", `Skipped blocked phases: ${details}`);
      }

      return lines.join("\n");
    }
  }
}

export function formatTicketList(
  tickets: readonly Ticket[],
  format: OutputFormat,
  citedRulingsByTicketId: ReadonlyMap<string, readonly CitationResolution[]> = new Map(),
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(
        tickets.map((t) => ({ ...t, ...checkpointJson(t), citedRulings: citedRulingsForJson(citedRulingsByTicketId.get(t.id) ?? []) })),
      ),
      null,
      2,
    );
  }
  if (tickets.length === 0) return "No tickets found.";
  const lines: string[] = [];
  for (const t of tickets) {
    const status = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
    const checkpoint = checkpointSummary(t);
    const mark = checkpoint ? ` [checkpoint ${checkpoint.state}]` : "";
    lines.push(`${status} ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)}${mark} (${t.phase ?? "none"})`);
    const rulingsSection = formatCitedRulingsSection(citedRulingsByTicketId.get(t.id) ?? []);
    if (rulingsSection) lines.push(rulingsSection);
  }
  return lines.join("\n");
}

export function formatIssue(
  issue: Issue,
  format: OutputFormat,
  state?: ProjectState,
  citedRulings: readonly CitationResolution[] = [],
  /** ISS-1154 2h: `{ actionability, unreadableHandoverCount }` when `withActionability` was requested. JSON-only. */
  extraJsonFields?: Record<string, unknown>,
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(issueJsonBody(issue, { citedRulings: citedRulingsForJson(citedRulings), ...extraJsonFields })),
      null,
      2,
    );
  }

  const lines: string[] = [
    `# ${escapeMarkdownInline(displayIdOf(issue))}: ${escapeMarkdownInline(issue.title)}`,
    "",
    `Status: ${issueStatusLabel(issue)} | Severity: ${issue.severity} | Phase: ${issue.phase ?? "none"} | Order: ${issue.order ?? "none"}`,
    `Components: ${issue.components.join(", ") || "none"}`,
    `Discovered: ${issue.discoveredDate}${issue.resolvedDate ? ` | Resolved: ${issue.resolvedDate}` : ""}`,
  ];
  if (issue.disposition) {
    const evidence = dispositionEvidenceView(issue);
    const detail = evidence.state === "effective"
      ? `: ${escapeMarkdownInline(evidence.reason!)} [${escapeMarkdownInline(evidence.ref!)}]`
      : "";
    lines.push(`Disposition: ${issue.disposition}${detail}`);
  }
  if (issue.duplicateOf) {
    lines.push(`Duplicate of: ${issue.duplicateOf}`);
  }
  if (issue.location.length > 0) {
    lines.push(`Location: ${issue.location.join(", ")}`);
  }
  if (issue.sourceRefs && issue.sourceRefs.length > 0) {
    const refs = issue.sourceRefs.map((ref) => {
      const end = ref.endLine ?? ref.startLine;
      const revision = ref.revision ? ` @ ${ref.revision.slice(0, 12)}` : "";
      const review = ref.reviewId ? ` [${ref.reviewId}]` : "";
      return `${ref.path}:${ref.startLine}-${end}${revision}${review}`;
    });
    lines.push(`Source evidence: ${refs.join(", ")}`);
  }
  if (issue.relatedTickets.length > 0) {
    const display = state
      ? issue.relatedTickets.map((ref) => resolveTicketRefDisplay(ref, state)).join(", ")
      : issue.relatedTickets.join(", ");
    lines.push(`Related: ${display}`);
  }
  lines.push("", "## Impact", "", fencedBlock(issue.impact));
  if (issue.resolution) {
    lines.push("", "## Resolution", "", fencedBlock(issue.resolution));
  }
  return lines.join("\n") + formatCitedRulingsSection(citedRulings);
}

export function formatIssueList(
  issues: readonly Issue[],
  format: OutputFormat,
  citedRulingsByIssueId: ReadonlyMap<string, readonly CitationResolution[]> = new Map(),
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(
        issues.map((i) => issueJsonBody(i, { citedRulings: citedRulingsForJson(citedRulingsByIssueId.get(i.id) ?? []) })),
      ),
      null,
      2,
    );
  }
  if (issues.length === 0) return "No issues found.";
  const lines: string[] = [];
  for (const i of issues) {
    const status = i.status === "resolved" ? "[x]" : "[ ]";
    const kind = effectiveResolutionKind(i);
    const tags = `${kind ? ` (${kind})` : ""}${i.disposition ? ` {${i.disposition}}` : ""}`;
    lines.push(`${status} ${displayIdOf(i)} [${i.severity}]: ${escapeMarkdownInline(i.title)} (${i.phase ?? "none"})${tags}`);
    const rulingsSection = formatCitedRulingsSection(citedRulingsByIssueId.get(i.id) ?? []);
    if (rulingsSection) lines.push(rulingsSection);
  }
  return lines.join("\n");
}

export function formatBlockedTickets(
  tickets: readonly Ticket[],
  state: ProjectState,
  format: OutputFormat,
  citedRulingsByTicketId: ReadonlyMap<string, readonly CitationResolution[]> = new Map(),
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(
        tickets.map((t) => ({
          ...t,
          blockers: t.blockedBy.map((bid) => ({
            id: bid,
            status: state.ticketByID(bid)?.status ?? "unknown",
          })),
          citedRulings: citedRulingsForJson(citedRulingsByTicketId.get(t.id) ?? []),
        })),
      ),
      null,
      2,
    );
  }
  if (tickets.length === 0) return "No blocked tickets.";
  const lines: string[] = [];
  for (const t of tickets) {
    const blockerInfo = t.blockedBy
      .map((bid) => {
        const resolved = state.resolveTicketRef(bid);
        if (resolved.kind === "found") {
          return `${displayIdOf(resolved.item)} (${resolved.item.status})`;
        }
        return `${bid} (unknown)`;
      })
      .join(", ");
    lines.push(`${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} -- blocked by: ${blockerInfo}`);
    const rulingsSection = formatCitedRulingsSection(citedRulingsByTicketId.get(t.id) ?? []);
    if (rulingsSection) lines.push(rulingsSection);
  }
  return lines.join("\n");
}

/** Findings listed per group before the remainder is summarized (ISS-890). */
export const VALIDATION_GROUP_LIST_LIMIT = 10;

const VALIDATION_LEVEL_ORDER = { error: 0, warning: 1, info: 2 } as const;

const VALIDATION_LEVEL_PREFIX = { error: "ERROR", warning: "WARN", info: "INFO" } as const;

/**
 * Orders finding groups so the specific sits above the systemic (ISS-890).
 *
 * Level first, so an error is never below a warning. Within a level, SMALLEST
 * group first: a finding that occurs three times is a specific defect you go and
 * fix, while one that occurs ninety-two times is a pattern you triage as a batch,
 * and reading it line by line tells you nothing the count did not. Sorting by
 * count rather than by code keeps that true whichever code happens to be the bulk
 * one in a given project. Ties break on code so the output is deterministic.
 */
function compareValidationGroups(
  a: { level: ValidationLevel; code: string; findings: ValidationFinding[] },
  b: { level: ValidationLevel; code: string; findings: ValidationFinding[] },
): number {
  const byLevel = VALIDATION_LEVEL_ORDER[a.level] - VALIDATION_LEVEL_ORDER[b.level];
  if (byLevel !== 0) return byLevel;
  const byCount = a.findings.length - b.findings.length;
  if (byCount !== 0) return byCount;
  return a.code.localeCompare(b.code);
}

export function formatValidation(
  result: ValidationResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    // Always complete: grouping and the per-group list limit below are a reading
    // aid for humans, never a filter on what the data says.
    return JSON.stringify(successEnvelope(result), null, 2);
  }

  const lines: string[] = [
    result.valid ? "Validation passed." : "Validation failed.",
    `Errors: ${result.errorCount} | Warnings: ${result.warningCount} | Info: ${result.infoCount}`,
  ];

  if (result.findings.length > 0) {
    // Grouped by code rather than printed flat (ISS-890). A flat list makes a
    // handful of actionable findings visually indistinguishable from a hundred
    // lines of accumulated drift, so the actionable ones stop being read.
    const groups = new Map<string, { level: ValidationLevel; code: string; findings: ValidationFinding[] }>();
    for (const finding of result.findings) {
      const key = `${finding.level}:${finding.code}`;
      const group = groups.get(key);
      if (group) group.findings.push(finding);
      else groups.set(key, { level: finding.level, code: finding.code, findings: [finding] });
    }

    for (const group of [...groups.values()].sort(compareValidationGroups)) {
      const prefix = VALIDATION_LEVEL_PREFIX[group.level];
      const count = group.findings.length;
      lines.push("");
      lines.push(`## ${group.code} -- ${count} ${count === 1 ? "finding" : "findings"}`);

      // Errors are never abbreviated: they are what makes validation fail, so
      // every one has to be readable without a second command.
      const limit = group.level === "error" ? count : VALIDATION_GROUP_LIST_LIMIT;
      for (const finding of group.findings.slice(0, limit)) {
        const entity = finding.entity ? `[${escapeMarkdownInline(finding.entity)}] ` : "";
        lines.push(`${prefix}: ${entity}${escapeMarkdownInline(finding.message)}`);
      }
      const hidden = count - Math.min(count, limit);
      if (hidden > 0) {
        // Stated, never silent: an abbreviated group says exactly how much it is
        // holding back and where the rest is.
        lines.push(`... and ${hidden} more. Run \`storybloq validate --format json\` for the full list.`);
      }
    }
  }

  return lines.join("\n");
}

export function formatLedgerIntegrity(
  result: LedgerIntegrityResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }

  const lines = [
    result.valid ? "Ledger integrity passed." : "Ledger integrity failed.",
    `Scanned: ${result.scannedFiles} JSON file(s) | Errors: ${result.errorCount}`,
    `Critical: ${result.criticalErrorCount} | Items: ${result.itemErrorCount} | Auxiliary: ${result.auxiliaryErrorCount}`,
  ];
  if (result.skippedSymlinks > 0) {
    lines.push(`Skipped symlinks: ${result.skippedSymlinks}`);
  }
  if (result.findings.length > 0) {
    lines.push("");
    for (const finding of result.findings) {
      const position = finding.line
        ? ` at line ${finding.line}${finding.column ? `, column ${finding.column}` : ""}`
        : "";
      lines.push(
        `ERROR [${finding.classification}] ${escapeMarkdownInline(finding.file)}${position}: ${escapeMarkdownInline(finding.message)}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatBlockerList(
  roadmap: Roadmap,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(
        roadmap.blockers.map((b) => ({
          name: b.name,
          cleared: isBlockerCleared(b),
          note: b.note ?? null,
          createdDate: b.createdDate ?? null,
          clearedDate: b.clearedDate ?? null,
        })),
      ),
      null,
      2,
    );
  }

  if (roadmap.blockers.length === 0) return "No blockers.";
  const lines: string[] = [];
  for (const b of roadmap.blockers) {
    const status = isBlockerCleared(b) ? "[x]" : "[ ]";
    const note = b.note ? ` -- ${escapeMarkdownInline(b.note)}` : "";
    lines.push(`${status} ${escapeMarkdownInline(b.name)}${note}`);
  }
  return lines.join("\n");
}

export function formatNote(
  note: Note,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(note), null, 2);
  }

  const title = note.title ?? `${note.createdDate} -- ${displayIdOf(note)}`;
  const statusBadge = note.status === "archived" ? " (archived)" : "";
  const lines: string[] = [
    `# ${escapeMarkdownInline(title)}${statusBadge}`,
    "",
    `Status: ${note.status}`,
  ];
  if (note.tags.length > 0) {
    lines.push(`Tags: ${note.tags.join(", ")}`);
  }
  lines.push(`Created: ${note.createdDate} | Updated: ${note.updatedDate}`);
  lines.push("", fencedBlock(note.content));
  return lines.join("\n");
}

export function formatNoteList(
  notes: readonly Note[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(notes), null, 2);
  }
  if (notes.length === 0) return "No notes found.";
  const lines: string[] = [];
  for (const n of notes) {
    const title = n.title ?? displayIdOf(n);
    const status = n.status === "archived" ? "[x]" : "[ ]";
    const tagInfo = n.status === "archived"
      ? " (archived)"
      : n.tags.length > 0
        ? ` (${n.tags.join(", ")})`
        : "";
    lines.push(`${status} ${displayIdOf(n)}: ${escapeMarkdownInline(title)}${tagInfo}`);
  }
  return lines.join("\n");
}

export function formatNoteCreateResult(
  note: Note,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(note), null, 2);
  }
  const displayId = displayIdOf(note);
  return `Created note ${displayId}: ${note.title ?? displayId}`;
}

export function formatNoteUpdateResult(
  note: Note,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(note), null, 2);
  }
  const displayId = displayIdOf(note);
  return `Updated note ${displayId}: ${note.title ?? displayId}`;
}

export function formatNoteDeleteResult(
  id: string,
  format: OutputFormat,
  alreadyDeleted = false,
): string {
  // ISS-757: team-mode re-delete of a tombstoned note is a silent success
  // (exit 0) that preserves the existing tombstone; surface it distinctly.
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ id, deleted: true, ...(alreadyDeleted ? { alreadyDeleted: true } : {}) }),
      null,
      2,
    );
  }
  if (alreadyDeleted) {
    return `Note ${id} is already deleted; existing tombstone preserved.`;
  }
  return `Deleted note ${id}.`;
}

// --- Arrangement formatters (T-473) ---

export function formatArrangement(
  arrangement: Arrangement,
  format: OutputFormat,
  citedRulings: readonly CitationResolution[] = [],
  coordination?: DuetView,
): string {
  // ISS-1191: capacity is reported on every read, so a pen sees the wall
  // approaching instead of discovering it as a refused write.
  const capacity = arrangementCapacity(arrangement);
  if (format === "json") {
    return JSON.stringify(successEnvelope({ ...arrangement, capacity, citedRulings: citedRulingsForJson(citedRulings), ...(coordination && { state: coordination.state, route: coordination.route }) }), null, 2);
  }
  const parties = arrangement.parties.map((p) => `${p.role} (${p.client})`).join(", ");
  const lines: string[] = [
    `# Arrangement ${escapeMarkdownInline(arrangement.id)} [${arrangement.lifecycle}]`,
    "",
    `Capacity: ${capacity.bytes} of ${capacity.max} bytes (${capacity.pct}%); checkpoint ${capacity.checkpointBytes}`,
    `Bounds: ${escapeMarkdownInline(arrangement.bounds.join(", "))}`,
    `Parties: ${escapeMarkdownInline(parties)}`,
    `Unreachability (irreversible): ${arrangement.unreachability.onIrreversibleWork}`,
  ];
  if (coordination) lines.push("", ...duetCoordinationLines(coordination));
  return lines.join("\n") + formatCitedRulingsSection(citedRulings);
}

function duetCoordinationLines(view: DuetView): string[] {
  const safe = (text: string) => escapeMarkdownDocumentStrict(sanitizeDisplayText(text));
  const lines = [`Communication: ${safe(view.route.status)}${view.route.mode ? ` (${safe(view.route.mode)})` : ""}`];
  if (view.route.reason) lines.push(safe(view.route.reason));
  if (view.state) {
    lines.push(`Coordination session: ${safe(view.state.start.sessionId)}; revision: ${view.state.revision}`, `Handshake nonce: ${safe(view.state.nonce)}`);
    for (const assignment of view.state.assignments.slice(0, 20)) {
      // ISS-1191: a compacted assignment kept its identity and status, not
      // its scope text -- say so rather than printing an empty scope.
      const detail = isCompactedAssignment(assignment) ? "compacted resolved history" : safe(assignment.input.scope.slice(0, 240));
      lines.push(`- ${safe(assignmentIdOf(assignment))}: ${safe(assignment.status)}; ${detail}`);
    }
    if (view.state.assignments.length > 20) lines.push(`(${view.state.assignments.length - 20} more assignments)`);
    lines.push("Full runtime, events, obligations and cursors: arrangement get with format json. Route readiness does not grant write authority.");
  }
  return lines;
}

export function formatDuetCoordination(view: DuetView, format: OutputFormat): string {
  return format === "json" ? JSON.stringify(successEnvelope(view), null, 2) : formatArrangement(view.arrangement, format, [], view);
}

/** ISS-1191: what `storybloq arrangement compact` reports. */
export function formatArrangementCompactResult(result: ArrangementCompactResult, format: OutputFormat): string {
  const { view, changed, before, after } = result;
  if (format === "json") {
    return JSON.stringify(successEnvelope({ id: view.arrangement.id, changed, before, after, route: view.route }), null, 2);
  }
  if (!changed) {
    return `Arrangement ${escapeMarkdownInline(view.arrangement.id)} is already compact: ${before.bytes} of ${before.max} bytes (${before.pct}%).`;
  }
  return [
    `Compacted arrangement ${escapeMarkdownInline(view.arrangement.id)}.`,
    `Before: ${before.bytes} bytes (${before.pct}%), checkpoint ${before.checkpointBytes}`,
    `After: ${after.bytes} bytes (${after.pct}%), checkpoint ${after.checkpointBytes}`,
    `Communication: ${escapeMarkdownInline(sanitizeDisplayText(view.route.status))}`,
  ].join("\n");
}

/** ISS-1191: what `storybloq arrangement rotate` reports. */
export function formatArrangementRotateResult(result: ArrangementRotateResult, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({
      id: result.predecessor.id,
      successor: result.successorId,
      alreadyRotated: result.alreadyRotated,
      carriedAssignments: result.carriedAssignments,
      carriedEarmarks: result.carriedEarmarks,
    }), null, 2);
  }
  const successor = escapeMarkdownInline(result.successorId);
  if (result.alreadyRotated) {
    return `Arrangement ${escapeMarkdownInline(result.predecessor.id)} was already rotated; its successor is ${successor}.`;
  }
  return [
    `Rotated ${escapeMarkdownInline(result.predecessor.id)} into ${successor}.`,
    `Carried assignments: ${result.carriedAssignments.length === 0 ? "none" : escapeMarkdownInline(result.carriedAssignments.join(", "))}`,
    `Carried earmarks: ${result.carriedEarmarks.length === 0 ? "none" : escapeMarkdownInline(result.carriedEarmarks.join(", "))}`,
    `History stays in the closed arrangement; coordinate against ${successor} from now on.`,
  ].join("\n");
}

const REBIND_LIVENESS_NOTE = "Liveness is machine-local: a pen on another machine reads as not live, so this rebind is an attributed claim backed by the evidence above.";

/** ISS-1290: what `storybloq arrangement rebind` reports. */
export function formatArrangementRebindResult(result: ArrangementRebindResult, format: OutputFormat): string {
  const who = (i: { client: string; id: string }) => `${i.client}:${i.id}`;
  if (format === "json") {
    return JSON.stringify(successEnvelope({
      id: result.predecessor.id,
      successor: result.successorId,
      role: result.role,
      from: result.from,
      to: result.to,
      recordedBy: result.recordedBy,
      penLiveness: result.penLiveness,
      liveness: { observed: result.penLiveness, scope: "machine-local", cause: result.livenessCause, note: REBIND_LIVENESS_NOTE },
      carriedAssignments: result.carriedAssignments,
      archivedAssignments: result.archivedAssignments,
      carriedEarmarks: result.carriedEarmarks,
      coordinationSession: null,
      next: "start",
    }), null, 2);
  }
  const successor = escapeMarkdownInline(result.successorId);
  const list = (ids: readonly string[]) => ids.length === 0 ? "none" : escapeMarkdownInline(ids.join(", "));
  const observed = result.penLiveness === "live" ? "live"
    : result.penLiveness === "inconclusive" ? `inconclusive (${escapeMarkdownInline(sanitizeDisplayText(result.livenessCause ?? "unknown cause"))})`
    : "not observed on this machine";
  return [
    `Rebound ${result.role} of ${escapeMarkdownInline(result.predecessor.id)} into ${successor}: ${escapeMarkdownInline(who(result.from))} -> ${escapeMarkdownInline(who(result.to))}.`,
    `Recorded by ${escapeMarkdownInline(who(result.recordedBy))}; evidence: ${escapeMarkdownInline(sanitizeDisplayText(result.evidence, MAX_PROSE_LENGTH))}.`,
    `Pen liveness: ${observed}. ${REBIND_LIVENESS_NOTE}`,
    `Carried assignments: ${list(result.carriedAssignments)}`,
    `Archived ids (still refused): ${list(result.archivedAssignments)}`,
    `Carried earmarks: ${list(result.carriedEarmarks)}`,
    `No coordination session was copied. The new pen runs start on ${successor} and proves the return route before dispatch.`,
  ].join("\n");
}

export function formatArrangementList(
  arrangements: readonly Arrangement[],
  format: OutputFormat,
  citedRulingsByArrangementId: ReadonlyMap<string, readonly CitationResolution[]> = new Map(),
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(
        arrangements.map((a) => ({ ...a, citedRulings: citedRulingsForJson(citedRulingsByArrangementId.get(a.id) ?? []) })),
      ),
      null,
      2,
    );
  }
  if (arrangements.length === 0) return "No arrangements found.";
  return arrangements
    .map((a) => {
      const parties = a.parties.map((p) => p.role).join("/");
      return `- ${escapeMarkdownInline(a.id)} [${a.lifecycle}] (${escapeMarkdownInline(parties)}) -- bounds: ${escapeMarkdownInline(a.bounds.join(", "))}`;
    })
    .join("\n");
}

export function formatArrangementCreateResult(
  arrangement: Arrangement,
  format: OutputFormat,
  citedRulings: readonly CitationResolution[] = [],
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ ...arrangement, citedRulings: citedRulingsForJson(citedRulings) }), null, 2);
  }
  return `Created arrangement ${arrangement.id}.`;
}

export function formatArrangementUpdateResult(
  arrangement: Arrangement,
  format: OutputFormat,
  citedRulings: readonly CitationResolution[] = [],
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ ...arrangement, citedRulings: citedRulingsForJson(citedRulings) }), null, 2);
  }
  return `Updated arrangement ${arrangement.id} [${arrangement.lifecycle}].`;
}

// --- Gate-ack formatters (T-474) ---

// --- Ruling formatters (T-476) ---

/**
 * T-522: what `ruling get` shows beyond the record and its chain status. All
 * optional so every pre-existing caller renders exactly as before.
 */
export interface RulingViewExtras {
  readonly lifecycle?: RulingLifecycle;
  readonly reasons?: readonly LifecycleReason[];
  /** Ids of proposals whose `proposesToSupersede` names this ruling. */
  readonly proposalsAgainst?: readonly string[];
}

export function formatRuling(
  ruling: Ruling,
  format: OutputFormat,
  resolution?: CitationResolution,
  extras: RulingViewExtras = {},
): string {
  const rendered = resolution ? renderCitation(resolution) : undefined;
  const lifecycle = extras.lifecycle;
  // The revision is what `ruling accept --revision` must quote: the digest of
  // the payload as it is on disk right now. Shown for every record whose
  // caller supplied a lifecycle (the `get` surface) so a reader can check an
  // acceptance by hand; a caller that passes no extras renders as in 1.15.
  const revision = lifecycle !== undefined ? payloadDigest(ruling) : undefined;
  if (format === "json") {
    // Codex round-3 finding 4: the caveat must be unconditional at the TOP
    // level too -- relying on chainStatus.current.caveat (renderCitation's
    // "resolved" case only) means an indeterminate/missing/unreadable/branch/
    // cycle resolution -- or no resolution at all -- exposed the ruling's
    // attribution with no caveat anywhere in the JSON output.
    return JSON.stringify(
      successEnvelope({
        ...ruling,
        attributionCaveat: rulingAttributionCaveat(ruling.recordedBy),
        chainStatus: rendered ?? null,
        ...(lifecycle !== undefined && { lifecycle, revision }),
        ...(extras.reasons && extras.reasons.length > 0 && { lifecycleViolations: extras.reasons }),
        ...(extras.proposalsAgainst && { proposalsAgainst: extras.proposalsAgainst }),
      }),
      null,
      2,
    );
  }
  const lines: string[] = [
    `# Ruling ${escapeMarkdownInline(ruling.id)}${lifecycle ? ` [${lifecycle}]` : ""}`,
    "",
    `Attribution: ${ruling.attribution} | Recorded by: ${ruling.recordedBy.client}/${ruling.recordedBy.id} | Date: ${ruling.date}`,
  ];
  if (ruling.scopeTags.length > 0) {
    lines.push(`Scope: ${ruling.scopeTags.map((t) => escapeMarkdownInline(t)).join(", ")}`);
  }
  if (ruling.supersedes) {
    lines.push(`Supersedes: ${escapeMarkdownInline(ruling.supersedes)}`);
  }
  if (lifecycle === "proposed" || lifecycle === "withdrawn") {
    if (ruling.proposesToSupersede) lines.push(`Proposes to supersede: ${escapeMarkdownInline(ruling.proposesToSupersede)}`);
    if ((ruling.proposedFor ?? []).length > 0) lines.push(`Proposed for: ${(ruling.proposedFor ?? []).map(escapeMarkdownInline).join(", ")}`);
  }
  if (revision !== undefined) lines.push(`Revision: ${revision}`);
  lines.push("", "## Text", "", fencedBlock(ruling.text));
  lines.push("", rulingAttributionCaveat(ruling.recordedBy));
  if (lifecycle === "proposed") {
    lines.push("", "This is a PROPOSAL. It is not policy and binds nothing until `storybloq ruling accept` records who accepted it.");
  } else if (lifecycle === "withdrawn") {
    lines.push("", `Withdrawn${ruling.withdrawal?.reason ? `: ${escapeMarkdownInline(ruling.withdrawal.reason)}` : ""}. It binds nothing.`);
  } else if (lifecycle === "quarantined" || lifecycle === "conflicted") {
    lines.push("", `QUARANTINED (${lifecycle}): this record claims a state its evidence does not support. It binds nothing and its edges are not trusted.`);
    for (const reason of extras.reasons ?? []) lines.push(`- ${reason.code}: ${escapeMarkdownInline(reason.detail)}`);
  }
  if (ruling.acceptance && lifecycle !== undefined && lifecycle !== "quarantined" && lifecycle !== "conflicted") {
    lines.push("", `Accepted: ${ruling.acceptance.attribution} (claimed), recorded by ${ruling.acceptance.recordedBy.client}/${ruling.acceptance.recordedBy.id} on ${ruling.acceptance.date}`);
  }
  // Narrative, like revision, belongs to the lifecycle-aware `get` surface: a
  // caller passing no extras renders exactly as 1.15 did, narrative or not.
  const narrative = lifecycle !== undefined ? ruling.narrative : undefined;
  if (narrative && Object.values(narrative).some((v) => typeof v === "string" && v.length > 0)) {
    lines.push("", `## Narrative (recorded by ${ruling.recordedBy.client}/${ruling.recordedBy.id}, commentary, not the decision)`, "");
    for (const key of ["context", "alternatives", "consequences", "reconsiderWhen"] as const) {
      const v = narrative[key];
      if (typeof v === "string" && v.length > 0) lines.push(`- ${key}: ${escapeMarkdownInline(v)}`);
    }
  }
  if (extras.proposalsAgainst && extras.proposalsAgainst.length > 0) {
    lines.push("", `${extras.proposalsAgainst.length} proposal(s) against this ruling (not binding): ${extras.proposalsAgainst.map(escapeMarkdownInline).join(", ")}`);
  }
  if (rendered) {
    if (rendered.status === "resolved") {
      lines.push(
        "",
        rendered.stale ? `Status: superseded by ${rendered.current!.id}` : "Status: current",
      );
    } else {
      lines.push("", `Status: ${rendered.warning ?? rendered.status}`);
    }
  }
  return lines.join("\n");
}

export function formatRulingList(
  rulings: readonly Ruling[],
  format: OutputFormat,
  lifecycleById?: ReadonlyMap<string, RulingLifecycle>,
): string {
  if (format === "json") {
    // Codex round-2 finding 2: attribution is a CLAIM (see
    // rulingAttributionCaveat's binding constraint) and must render
    // unconditionally everywhere a ruling's attribution is shown, including
    // the list surface -- not only single-ruling get/create/supersede.
    return JSON.stringify(
      successEnvelope(rulings.map((r) => ({
        ...r,
        attributionCaveat: rulingAttributionCaveat(r.recordedBy),
        ...(lifecycleById?.has(r.id) && { lifecycle: lifecycleById.get(r.id) }),
      }))),
      null,
      2,
    );
  }
  if (rulings.length === 0) return "No rulings found.";
  return rulings
    .map((r) => {
      const preview = r.text.length > 80 ? `${r.text.slice(0, 80)}...` : r.text;
      const lc = lifecycleById?.get(r.id);
      return [
        `- ${escapeMarkdownInline(r.id)}${lc ? ` [${lc}]` : ""} [${r.attribution}] (${r.date}): "${escapeMarkdownInline(preview)}"`,
        `  ${rulingAttributionCaveat(r.recordedBy)}`,
      ].join("\n");
    })
    .join("\n");
}

// --- T-522 lifecycle write results ---

export function formatRulingProposeResult(ruling: Ruling, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ ...ruling, revision: payloadDigest(ruling), attributionCaveat: rulingAttributionCaveat(ruling.recordedBy) }),
      null,
      2,
    );
  }
  return [
    `Proposed ruling ${ruling.id} (revision ${payloadDigest(ruling)}).`,
    `A proposal binds nothing. Accept it with \`storybloq ruling accept ${ruling.id} --revision <revision> --attribution <a> --date <d>\`.`,
  ].join("\n");
}

export function formatRulingAcceptResult(ruling: Ruling, noop: boolean, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ ...ruling, noop, revision: payloadDigest(ruling), attributionCaveat: rulingAttributionCaveat(ruling.recordedBy) }),
      null,
      2,
    );
  }
  const edge = ruling.supersedes ? ` It supersedes ${ruling.supersedes}.` : "";
  return noop
    ? `Ruling ${ruling.id} was already accepted at this revision (no-op).`
    : `Accepted ruling ${ruling.id}.${edge} Acceptance records a CLAIM of who ruled; the revision proves what was accepted.`;
}

export function formatRulingWithdrawResult(ruling: Ruling, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ ...ruling, attributionCaveat: rulingAttributionCaveat(ruling.recordedBy) }),
      null,
      2,
    );
  }
  return `Withdrew proposal ${ruling.id}.`;
}

/** T-522 plan section 7: how many proposals a review packet names, and the share of the round budget the block may spend. */
export const PROPOSALS_MAX = 5;
export const PROPOSALS_TEXT_BUDGET_FRACTION = 0.05;
const PROPOSALS_BLOCK_HEADER = "\n\n## Proposed, not binding\n\nThese are PROPOSALS against this item or its rulings. None is policy; none is enforced by this review.\n\n";

export interface BoundedProposals {
  readonly text: string;
  /** Proposal ids the packet could not name within its bounds. */
  readonly omittedIds: readonly string[];
}

/**
 * The "Proposed, not binding" block of a review packet. Bounded on TWO axes:
 * at most `PROPOSALS_MAX` entries, and a total text budget the caller derives
 * from the round budget, measured on the COMPLETE returned block (header,
 * separators and escaped entry lines), so the text never exceeds the budget.
 * A proposal's text is shown whole (escaped inline, as the Cited Rulings block
 * shows a citation) or not at all: never sliced, because a cut sentence can
 * read as a different proposal. No narrative, ever: a reviewer who wants
 * either reads the record with ruling_get. Nothing here is a citation and the
 * block says so.
 */
export function formatProposalsSectionBounded(
  proposals: readonly Ruling[],
  textBudget: number,
): BoundedProposals {
  if (proposals.length === 0) return { text: "", omittedIds: [] };
  const lines: string[] = [];
  const omittedIds: string[] = [];
  let spent = PROPOSALS_BLOCK_HEADER.length;
  for (const p of proposals) {
    if (lines.length >= PROPOSALS_MAX) {
      omittedIds.push(p.id);
      continue;
    }
    const target = p.proposesToSupersede ? ` (proposes to supersede ${escapeMarkdownInline(p.proposesToSupersede)})` : "";
    const line = `- **${escapeMarkdownInline(p.id)}**${target}: "${escapeMarkdownInline(p.text)}"`;
    const separator = lines.length === 0 ? 0 : 1;
    if (spent + separator + line.length > textBudget) {
      omittedIds.push(p.id);
      continue;
    }
    spent += separator + line.length;
    lines.push(line);
  }
  if (lines.length === 0) return { text: "", omittedIds };
  return { text: `${PROPOSALS_BLOCK_HEADER}${lines.join("\n")}`, omittedIds };
}

export function formatRulingCreateResult(ruling: Ruling, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ ...ruling, attributionCaveat: rulingAttributionCaveat(ruling.recordedBy) }),
      null,
      2,
    );
  }
  return `Created ruling ${ruling.id}.`;
}

export function formatRulingSupersedeResult(ruling: Ruling, noop: boolean, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ ...ruling, noop, attributionCaveat: rulingAttributionCaveat(ruling.recordedBy) }),
      null,
      2,
    );
  }
  return noop
    ? `Ruling ${ruling.id} already supersedes ${ruling.supersedes} (no-op).`
    : `Ruling ${ruling.id} now supersedes ${ruling.supersedes}.`;
}

/**
 * T-477 section 4.3: `storybloq landings` is the CLI-only surface for the
 * full feed -- no MCP tool, no `storybloq_status` field (plan 4.3's explicit
 * non-goal). JSON is the same versioned envelope every other read command
 * uses; `landings-unavailable` renders as a `formatError`-style envelope,
 * translated at the CLI layer -- the library itself never throws for it.
 */
export function formatLandings(result: LandingsResult, format: OutputFormat): string {
  if (result.status === "landings-unavailable") {
    return format === "json"
      ? JSON.stringify(errorEnvelope("io_error", result.reason), null, 2)
      : `Error [io_error]: ${escapeMarkdownInline(result.reason)}`;
  }
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }
  if (result.landings.length === 0) return "No landings found.";
  const lines: string[] = [];
  for (const landing of result.landings) {
    const shortSha = landing.sha.slice(0, 12);
    lines.push(`### ${shortSha} -- ${escapeMarkdownInline(landing.subject)}`);
    lines.push(`  authored: ${landing.authoredAt} | summary: ${landing.summary}`);
    if (landing.refs.length === 0) {
      lines.push("  refs: (none)");
    } else {
      for (const ref of landing.refs) {
        const cov = ref.coverage;
        const evidenceNote = cov.reviewEvidence === "present" ? ", evidence present" : cov.reviewEvidence === "absent" ? ", evidence absent" : "";
        const multi = cov.multipleMatches ? ", multiple matches" : "";
        const crossConfirmed = ref.crossConfirmed ? ", cross-confirmed" : "";
        lines.push(
          `  - ${escapeMarkdownInline(ref.ref)} (${ref.source}${crossConfirmed}): ${cov.gateAckCoverage}${evidenceNote}${multi}`,
        );
      }
    }
    if (landing.unresolvedTokens.length > 0) {
      lines.push(`  unresolved tokens: ${landing.unresolvedTokens.map((t) => escapeMarkdownInline(t)).join(", ")}`);
    }
    lines.push("");
  }
  if (result.unresolvedResolutionShas.length > 0) {
    lines.push("### Unresolved resolution-field shas");
    for (const u of result.unresolvedResolutionShas) {
      lines.push(`  - ${escapeMarkdownInline(u.issueRef)}: ${escapeMarkdownInline(u.token)} (${u.reason})`);
    }
    lines.push("");
  }
  if (result.unattributedGateAckWarnings.length > 0) {
    lines.push("### Unattributed gate-ack warnings (force every ticket-shaped ref to \"unknown\" this run)");
    for (const w of result.unattributedGateAckWarnings) {
      lines.push(`  - ${escapeMarkdownInline(w)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatGateAckPin(ack: GateAck): string {
  return ack.pin.kind === "plan-hash"
    ? `plan-hash:${sanitizeDisplayText(ack.pin.sha256).slice(0, 12)}...`
    : `tree-digest:${sanitizeDisplayText(ack.pin.treeId).slice(0, 12)}... (parent ${sanitizeDisplayText(ack.pin.parentSha).slice(0, 12)}...)`;
}

export function formatGateAck(ack: GateAck, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(ack), null, 2);
  }
  const contestedBadge = ack.contested ? " [CONTESTED]" : "";
  const lines: string[] = [
    `# Gate-ack ${escapeMarkdownInline(sanitizeDisplayText(ack.id))}${contestedBadge}`,
    "",
    `Arrangement: ${escapeMarkdownInline(sanitizeDisplayText(ack.arrangementId))} | Gate: ${escapeMarkdownInline(sanitizeDisplayText(ack.gateName))} | Acked by: ${escapeMarkdownInline(sanitizeDisplayText(ack.ackRole))}`,
    `Ticket: ${escapeMarkdownInline(sanitizeDisplayText(ack.ticketRef))}`,
    `Pin: ${formatGateAckPin(ack)}`,
    `Decided: ${escapeMarkdownInline(sanitizeDisplayText(ack.decidedAt ?? "unknown"))}`,
    `Review trail: ${ack.reviewTrail.present ? `${escapeMarkdownInline(sanitizeDisplayText(ack.reviewTrail.verdict ?? "present"))}${ack.reviewTrail.rounds !== undefined ? ` (${ack.reviewTrail.rounds} rounds)` : ""}` : "none (acked on inspection)"}`,
  ];
  if (ack.deltas) lines.push("", "## Deltas", "", sanitizeDisplayText(ack.deltas, MAX_PROSE_LENGTH));
  if (ack.contested) lines.push("", `Contested: ${escapeMarkdownInline(sanitizeDisplayText(ack.contestedReason ?? ""))}`);
  return lines.join("\n");
}

export function formatGateAckList(acks: readonly GateAck[], format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(acks), null, 2);
  }
  if (acks.length === 0) return "No gate-acks found.";
  return acks
    .map((a) => {
      const contestedBadge = a.contested ? " [CONTESTED]" : "";
      return `- ${escapeMarkdownInline(sanitizeDisplayText(a.id))}${contestedBadge} -- ${escapeMarkdownInline(sanitizeDisplayText(a.gateName))} on ${escapeMarkdownInline(sanitizeDisplayText(a.ticketRef))} (${escapeMarkdownInline(sanitizeDisplayText(a.ackRole))})`;
    })
    .join("\n");
}

export function formatGateAckCreateResult(ack: GateAck, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(ack), null, 2);
  }
  return `Created gate-ack ${escapeMarkdownInline(sanitizeDisplayText(ack.id))} (${escapeMarkdownInline(sanitizeDisplayText(ack.gateName))} on ${escapeMarkdownInline(sanitizeDisplayText(ack.ticketRef))}).`;
}

export function formatGateAckContestResult(ack: GateAck, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(ack), null, 2);
  }
  return `Gate-ack ${escapeMarkdownInline(sanitizeDisplayText(ack.id))} marked contested: ${escapeMarkdownInline(sanitizeDisplayText(ack.contestedReason ?? ""))}`;
}

// --- Earmark formatters (T-475) ---

function formatEarmarkLine(earmark: Earmark): string {
  const holder =
    earmark.stage === "assigned"
      ? `assigned to session ${escapeMarkdownInline(sanitizeDisplayText(earmark.holderSession))}`
      : `reserved for role ${escapeMarkdownInline(sanitizeDisplayText(earmark.holderRole))}`;
  return (
    `${holder} (role ${escapeMarkdownInline(sanitizeDisplayText(earmark.holderRole))}), ` +
    `reserved by ${escapeMarkdownInline(sanitizeDisplayText(earmark.reservedBy.client))}:${escapeMarkdownInline(sanitizeDisplayText(earmark.reservedBy.id))}, ` +
    `arrangement ${escapeMarkdownInline(sanitizeDisplayText(earmark.arrangementId))}, since ${escapeMarkdownInline(sanitizeDisplayText(earmark.since))}`
  );
}

/**
 * ISS-1191: the earmark's authorizing arrangement carries a hard 64 KiB
 * cap, so its capacity is reported here too -- the pen reads this surface
 * far more often than `arrangement get`. `capacity` is null (with a reason)
 * whenever the arrangement cannot be resolved in the root being read, which
 * is the normal case for a federated node read: never a fabricated number.
 */
export function formatEarmarkGetResult(
  ref: string,
  earmark: Earmark | null,
  format: OutputFormat,
  capacity?: { capacity: ArrangementCapacity | null; reason?: string },
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ ref, earmark, ...(capacity && { capacity: capacity.capacity, ...(capacity.reason !== undefined && { capacityReason: capacity.reason }) }) }), null, 2);
  }
  if (!earmark) return `${escapeMarkdownInline(sanitizeDisplayText(ref))} has no earmark.`;
  const lines = [`Earmark on ${escapeMarkdownInline(sanitizeDisplayText(ref))}: ${formatEarmarkLine(earmark)}`];
  if (capacity?.capacity) {
    const c = capacity.capacity;
    lines.push(`Arrangement capacity: ${c.bytes} of ${c.max} bytes (${c.pct}%); checkpoint ${c.checkpointBytes}`);
  } else if (capacity?.reason) {
    lines.push(`Arrangement capacity: unavailable (${escapeMarkdownInline(sanitizeDisplayText(capacity.reason))})`);
  }
  return lines.join("\n");
}

export function formatEarmarkActionResult(
  action: "reserved" | "assigned" | "released",
  ref: string,
  earmark: Earmark | null,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ ref, action, earmark }), null, 2);
  }
  const target = escapeMarkdownInline(sanitizeDisplayText(ref));
  if (action === "released") return `Released earmark on ${target}.`;
  return `${action === "reserved" ? "Reserved" : "Assigned"} ${target}: ${formatEarmarkLine(earmark!)}`;
}

// --- Lesson formatters ---

export function formatLesson(
  lesson: Lesson,
  format: OutputFormat,
  state?: ProjectState,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }

  const statusBadge = lesson.status !== "active" ? ` (${lesson.status})` : "";
  const lines: string[] = [
    `# ${escapeMarkdownInline(lesson.title)}${statusBadge}`,
    "",
    `Status: ${lesson.status} | Source: ${lesson.source} | Reinforcements: ${lesson.reinforcements}`,
  ];
  if (lesson.tags.length > 0) {
    lines.push(`Tags: ${lesson.tags.join(", ")}`);
  }
  lines.push(`Created: ${lesson.createdDate} | Updated: ${lesson.updatedDate} | Last validated: ${lesson.lastValidated}`);
  if (lesson.supersedes) {
    lines.push(`Supersedes: ${state ? resolveLessonRefDisplay(lesson.supersedes, state) : lesson.supersedes}`);
  }
  lines.push("", "## Content", "", lesson.content);
  if (lesson.context) {
    lines.push("", "## Context", "", lesson.context);
  }
  return lines.join("\n");
}

export function formatLessonList(
  lessons: readonly Lesson[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lessons), null, 2);
  }
  if (lessons.length === 0) return "No lessons found.";
  const lines: string[] = [];
  for (const l of lessons) {
    const status = l.status === "active" ? "[ ]" : "[x]";
    const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements})` : "";
    const tagInfo = l.tags.length > 0 ? ` [${l.tags.join(", ")}]` : "";
    lines.push(`${status} ${displayIdOf(l)}: ${escapeMarkdownInline(l.title)}${reinforced}${tagInfo}`);
  }
  return lines.join("\n");
}

export function formatLessonDigest(
  digest: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ digest }), null, 2);
  }
  if (!digest) return "No active lessons.";
  return digest;
}

export function formatLessonCreateResult(
  lesson: Lesson,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }
  return `Created lesson ${displayIdOf(lesson)}: ${lesson.title}`;
}

export function formatLessonUpdateResult(
  lesson: Lesson,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }
  return `Updated lesson ${displayIdOf(lesson)}: ${lesson.title}`;
}

export function formatLessonReinforceResult(
  lesson: Lesson,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }
  return `Reinforced lesson ${displayIdOf(lesson)}: ${lesson.title} (×${lesson.reinforcements})`;
}

export function formatLessonDeleteResult(
  id: string,
  format: OutputFormat,
  alreadyDeleted = false,
): string {
  // ISS-757: team-mode re-delete of a tombstoned lesson is a silent success
  // (exit 0) that preserves the existing tombstone; surface it distinctly.
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ id, deleted: true, ...(alreadyDeleted ? { alreadyDeleted: true } : {}) }),
      null,
      2,
    );
  }
  if (alreadyDeleted) {
    return `Lesson ${id} is already deleted; existing tombstone preserved.`;
  }
  return `Deleted lesson ${id}.`;
}

export function formatError(
  code: ErrorCode,
  message: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(errorEnvelope(code, message), null, 2);
  }
  return `Error [${code}]: ${escapeMarkdownInline(message)}`;
}

export function formatInitResult(
  result: { root: string; created: readonly string[]; warnings: readonly string[] },
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }
  const lines = [`Initialized .story/ at ${escapeMarkdownInline(result.root)}`, "", ...result.created.map((f) => `  ${f}`)];
  if (result.warnings.length > 0) {
    lines.push("", `Warning: ${result.warnings.length} corrupt file(s) found. Run \`storybloq validate\` to inspect.`);
  }
  // T-487: REVIEW.md is deliberately NOT written here. A review contract nobody
  // agreed to is worse than none, so the setup flow proposes it and the user
  // edits or rejects it before it lands. Say so, or its absence reads as a bug.
  lines.push("", "Note: REVIEW.md (the review contract) is not created here. Run the storybloq skill and it proposes one you can edit before it lands.");
  lines.push("", "Tip: Run `storybloq setup --client all` to install the Storybloq skill, MCP, and hooks.");
  return lines.join("\n");
}

export function formatHandoverList(
  filenames: readonly string[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(filenames), null, 2);
  }
  if (filenames.length === 0) return "No handovers found.";
  return filenames.join("\n");
}

export function formatHandoverContent(
  filename: string,
  content: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ filename, content }), null, 2);
  }
  // MD mode: raw content as-is (it's already markdown)
  return content;
}

export function formatHandoverTemplate(content: string, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ content }), null, 2);
  }
  return content;
}

function formatRecordLine(record: SectionRecord): string {
  const idPart = record.id ? `**${record.id}**` : `*(${record.kind})*`;
  const rationalePart = record.rationale === "unknown" ? "" : ` -- ${record.rationale}`;
  return `- ${idPart} ${record.label}${rationalePart}`;
}

function formatHandoverBriefEntryMd(entry: HandoverBriefEntry): string {
  const lines: string[] = [`## ${entry.filename}`];
  if (entry.form === "raw") {
    lines.push("", entry.body);
    return lines.join("\n");
  }
  if (entry.form === "index-only") {
    lines.push(
      "",
      `(${entry.index.omittedCount} item(s) omitted; ids: ${entry.index.ids.join(", ") || "none"})`,
    );
    return lines.join("\n");
  }
  if (entry.records.length === 0) {
    lines.push("", "(no continuation, blocked, owner-gated, or carried items)");
  }
  for (const record of entry.records) {
    lines.push(formatRecordLine(record));
  }
  if (entry.index) {
    lines.push(
      `(${entry.index.omittedCount} more omitted; ids: ${entry.index.ids.join(", ") || "none"})`,
    );
  }
  return lines.join("\n");
}

function formatTrajectoryMd(trajectory: readonly TrajectoryEntry[]): string {
  if (trajectory.length === 0) return "";
  const lines = ["## Trajectory"];
  for (const entry of trajectory) {
    // ISS-1219: occurrenceCount counts only continuation/blocked/owner-gated/
    // carried mentions while latest takes any mention, so a shipped-only id
    // has count 0 beside a named latest. Say that plainly instead of the
    // single-sentence form, which read as a contradiction.
    if (entry.occurrenceCount === 0) {
      lines.push(`- ${entry.id}: no open mention; last named as ${entry.latestDisposition} in ${entry.latest}`);
      continue;
    }
    lines.push(
      `- ${entry.id}: seen in ${entry.occurrenceCount} handover(s), latest ${entry.latest} (${entry.latestDisposition})`,
    );
  }
  return lines.join("\n");
}

/**
 * T-320 commit 2: renders `handover_latest`'s brief/priming result. JSON
 * mode is the exact `{handovers, trajectory, skippedHandovers,
 * missingHandovers}` shape from `buildHandoverBrief`, wrapped in the
 * standard success envelope. MD mode groups each handover's records under
 * its filename, falling back to the raw body for an entry priming kept
 * unstructured, and appends a trajectory section when non-empty.
 */
export function formatHandoverBrief(
  result: HandoverBriefResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }
  const sections = result.handovers.map(formatHandoverBriefEntryMd);
  const trajectorySection = formatTrajectoryMd(result.trajectory);
  if (trajectorySection) sections.push(trajectorySection);
  if (result.skippedHandovers > 0) {
    sections.push(`(${result.skippedHandovers} handover(s) skipped: filename too long)`);
  }
  if (result.missingHandovers > 0) {
    sections.push(`(${result.missingHandovers} handover(s) skipped: no longer on disk)`);
  }
  return sections.join("\n\n");
}

/** T-499: the continuation line after a handover that was stamped on the caller's presence record. */
export const HANDOVER_STAMPED_CONTINUE_LINE =
  "Handover recorded against your current compaction boundary: context pressure is held at advisory. Keep working in this same turn; do not stop, defer the next step, or ask the user whether to continue.";

/**
 * ISS-1197 commit 2: the same stamp, at compact-needed. The line above is a
 * false claim here -- the stamp lands, but nothing is suppressed past the
 * compact line, and it would print directly under a COMPACT-NEEDED banner
 * telling the caller the opposite.
 */
export const HANDOVER_STAMPED_COMPACT_NEEDED_LINE =
  "Handover recorded, but context is past the compact line, so this does not lower the pressure. Auto-compaction will follow and is expected: keep working through it, and write no further handovers.";

/**
 * ISS-1263: a binding failure on a server that is ALSO stale. The staleness
 * is a coincident condition, never the cause: the stamp path never consults
 * it, and a restart loads the new build without binding the caller (the
 * field reports reproduced the skip on a freshly started server). Printed
 * only where staleness was positively established, in place of the line below.
 */
export const HANDOVER_STAMP_STALE_NOTE =
  "Also: the server binary is stale; a restart loads the new build but does not fix the binding.";

/**
 * A binding failure without positive staleness: what is known, and no remedy
 * (ISS-1263: the old "restart the client" advice was wrong for a live pen).
 */
export const HANDOVER_STAMP_UNBOUND_LINE =
  "The caller could not be bound to a live presence record.";

/**
 * ISS-1214: why an attempted stamp did not land. `reason` is display text;
 * `kind` is what may be concluded from it, decided by the stamp path that
 * knows -- this formatter never re-derives cause from message text.
 */
export interface HandoverStampFailure {
  readonly reason: string;
  readonly kind: "binding" | "outcome" | "refused" | "error";
}

/**
 * ISS-1214: the line a reply carries when a stamp was attempted and did not
 * land. Before this, `handover_create` returned exactly "Created handover:
 * <file>" on every failure path, so an agent read the reply as success while
 * `handoverWrittenAt` stayed null and the prompt hook re-fired the imperative
 * with no visible cause.
 *
 * `serverStale` must come from a POSITIVE staleness check (the caller's own
 * `describeBinaryStaleness`), never from the shape of the reason: the hint is
 * a causal claim, and a false one sends a reader to restart a client that was
 * never the problem.
 */
/** ISS-1263: the line quoting the re-arm interval; zero means there is none. */
const NO_REPEAT_INTERVAL = "The pressure line has no minimum repeat interval (handoverRearmIntervalMs is 0).";

export function formatHandoverStampFailure(failure: HandoverStampFailure, serverStale = false, rearmIntervalMs = 600_000): string {
  // ISS-1263: the reply never promises another imperative. The line is rate
  // limited at delivery whether or not a stamp lands, and the old promise is
  // what sent a worker into a handover every turn.
  const interval = rearmIntervalMs > 0 ? `The pressure line repeats at most once every ${describeRepeatInterval(rearmIntervalMs)}.` : NO_REPEAT_INTERVAL;
  const base = `Handover stamp did not land (${failure.reason}). ${interval}`;
  // Only a binding failure is about the caller's link to a record at all; an
  // outcome, a refusal and a thrown error each have their own causes, and a
  // restart addresses none of them.
  if (failure.kind !== "binding") return base;
  return `${base} ${serverStale ? HANDOVER_STAMP_STALE_NOTE : HANDOVER_STAMP_UNBOUND_LINE}`;
}

/**
 * ISS-1185: `stampedRoot`/`mcpRoot` report the actually-stamped root only
 * when it diverges from the MCP server's own root (the common single-root
 * case stays exactly as before, no added noise).
 */
export function formatHandoverCreateResult(
  filename: string,
  format: OutputFormat,
  stamped = false,
  stampedRoot: string | null = null,
  mcpRoot: string | null = null,
  /** ISS-1197 commit 2: the stamp landed, but on a compact-needed sample. */
  compactNeeded = false,
  /**
   * ISS-1214: why an attempted stamp did not land. Null when it landed, when
   * none was attempted, and when the skip was a precondition this surface
   * cannot act on (session intel off, a non-Claude client on the CLI).
   */
  stampFailure: HandoverStampFailure | null = null,
  /**
   * ISS-1214: whether the running server was POSITIVELY established as older
   * than the on-disk build. Only the MCP surface can answer this; a caller
   * that cannot must leave it false rather than infer it.
   */
  serverStale = false,
  /**
   * ISS-1263: how the landed stamp was bound. "unbound-era" (the caller's
   * process era could not be proven) gets the acknowledgement by artifact
   * instead of the bound continuation line.
   */
  stampBinding: "bound" | "unbound-era" = "bound",
  /** ISS-1263: the configured re-arm interval, quoted exactly in the reply. */
  rearmIntervalMs = 600_000,
): string {
  const diverged = stamped && stampedRoot !== null && mcpRoot !== null && stampedRoot !== mcpRoot;
  const failure = stamped ? null : stampFailure;
  if (format === "json") {
    const data: Record<string, unknown> = stamped ? { filename, tokenPressureStamped: true } : { filename };
    if (stamped && stampBinding === "unbound-era") data.tokenPressureStampBinding = "unbound-era";
    if (diverged) data.tokenPressureStampedRoot = stampedRoot;
    if (failure !== null) data.tokenPressureStampReason = failure.reason;
    return JSON.stringify(successEnvelope(data), null, 2);
  }
  if (!stamped) {
    const base = `Created handover: ${filename}`;
    return failure === null ? base : `${base}\n\n${formatHandoverStampFailure(failure, serverStale, rearmIntervalMs)}`;
  }
  const note = diverged ? ` (stamped under a different root: ${stampedRoot})` : "";
  const line = compactNeeded
    ? HANDOVER_STAMPED_COMPACT_NEEDED_LINE
    : stampBinding === "unbound-era"
      ? `Handover recorded at ${filename}. ${rearmIntervalMs > 0 ? `The pressure line will not repeat for ${describeRepeatInterval(rearmIntervalMs)}.` : NO_REPEAT_INTERVAL}`
      : HANDOVER_STAMPED_CONTINUE_LINE;
  return `Created handover: ${filename}\n\n${line}${note}`;
}

// --- Snapshot / Recap / Export ---

import type { RecapResult, SnapshotDiff } from "./snapshot.js";

export function formatSnapshotResult(
  result: { filename: string; retained: number; pruned: number },
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }
  let line = `Snapshot saved: ${result.filename} (${result.retained} retained`;
  if (result.pruned > 0) line += `, ${result.pruned} pruned`;
  line += ")";
  return line;
}

export function formatRecap(
  recap: RecapResult,
  state: ProjectState,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(recap), null, 2);
  }

  const lines: string[] = [];

  if (!recap.snapshot) {
    // No snapshot fallback -- show status + note
    lines.push(`# ${escapeMarkdownInline(state.config.project)} -- Recap`);
    lines.push("");
    lines.push("No snapshot found. Run `storybloq snapshot` to enable session diffs.");
    lines.push("");
    lines.push(`Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete, ${state.blockedCount} blocked`);
    lines.push(issueLine(state));
  } else {
    lines.push(`# ${escapeMarkdownInline(state.config.project)} -- Recap`);
    lines.push("");
    lines.push(`Since snapshot: ${recap.snapshot.createdAt}`);
    // The SAME line status prints, on BOTH recap branches. It was wired only
    // into the no-snapshot fallback below, so the branch a reader actually
    // reaches -- the one with a snapshot -- never showed it, and the plan
    // recorded the line as delivered on the strength of the other branch.
    lines.push(issueLine(state));
    if (recap.partial) {
      lines.push("**Note:** Snapshot was taken from a project with integrity warnings. Diff may be incomplete.");
    }
    if (recap.staleness) {
      if (recap.staleness.status === "diverged") {
        // Genuinely anomalous: the snapshot's commit is no longer in history, so
        // the diff below may compare against work that no longer exists. Keeps the
        // Warning prefix.
        lines.push("**Warning:** Snapshot commit is not an ancestor of current HEAD (history diverged; possible rebase, force-push, or branch switch).");
      } else if (recap.staleness.status === "behind" && (recap.staleness.commitsBehind ?? 0) > 0) {
        // ISS-889: being behind HEAD is the ORDINARY state of a snapshot -- you
        // take one, then you keep working. Labelling routine progress a warning
        // teaches readers to skip the prefix, which costs the diverged case above
        // the attention it actually needs. Stated as the plain fact it is; the
        // count is there for anyone who wants to judge how stale that is.
        const commits = recap.staleness.commitsBehind ?? 0;
        lines.push(`Snapshot is ${commits} commit${commits === 1 ? "" : "s"} behind HEAD.`);
      }
    }

    const changes = recap.changes!;
    const hasChanges = hasAnyChanges(changes);

    if (!hasChanges) {
      lines.push("");
      lines.push("No changes since last snapshot.");
    } else {
      // Phase transitions
      if (changes.phases.statusChanged.length > 0) {
        lines.push("");
        lines.push("## Phase Transitions");
        for (const p of changes.phases.statusChanged) {
          lines.push(`- **${escapeMarkdownInline(p.name)}** (${p.id}): ${p.from} → ${p.to}`);
        }
      }

      // Ticket changes
      const ticketChanges = changes.tickets;
      if (ticketChanges.added.length > 0 || ticketChanges.removed.length > 0 || ticketChanges.statusChanged.length > 0 || ticketChanges.descriptionChanged.length > 0) {
        lines.push("");
        lines.push("## Tickets");
        for (const t of ticketChanges.statusChanged) {
          lines.push(`- ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} -- ${t.from} → ${t.to}`);
        }
        for (const t of ticketChanges.added) {
          lines.push(`- ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} -- **new**`);
        }
        for (const t of ticketChanges.removed) {
          lines.push(`- ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} -- **removed**`);
        }
        for (const t of ticketChanges.descriptionChanged) {
          lines.push(`- ${displayIdOf(t)}: description updated`);
        }
      }

      // Issue changes
      const issueChanges = changes.issues;
      if (issueChanges.added.length > 0 || issueChanges.resolved.length > 0 || issueChanges.statusChanged.length > 0 || issueChanges.impactChanged.length > 0) {
        lines.push("");
        lines.push("## Issues");
        for (const i of issueChanges.resolved) {
          lines.push(`- ${displayIdOf(i)}: ${escapeMarkdownInline(i.title)} -- **resolved**`);
        }
        for (const i of issueChanges.statusChanged) {
          lines.push(`- ${displayIdOf(i)}: ${escapeMarkdownInline(i.title)} -- ${i.from} → ${i.to}`);
        }
        for (const i of issueChanges.added) {
          lines.push(`- ${displayIdOf(i)}: ${escapeMarkdownInline(i.title)} -- **new**`);
        }
        for (const i of issueChanges.impactChanged) {
          lines.push(`- ${displayIdOf(i)}: impact updated`);
        }
      }

      // Blocker changes
      if (changes.blockers.added.length > 0 || changes.blockers.cleared.length > 0) {
        lines.push("");
        lines.push("## Blockers");
        for (const name of changes.blockers.cleared) {
          lines.push(`- ${escapeMarkdownInline(name)} -- **cleared**`);
        }
        for (const name of changes.blockers.added) {
          lines.push(`- ${escapeMarkdownInline(name)} -- **new**`);
        }
      }

      // Handover changes
      if (changes.handovers && (changes.handovers.added.length > 0 || changes.handovers.removed.length > 0)) {
        lines.push("");
        lines.push("## Handovers");
        for (const h of changes.handovers.added) {
          lines.push(`- ${h} -- **new**`);
        }
        for (const h of changes.handovers.removed) {
          lines.push(`- ${h} -- removed`);
        }
      }

      // Note changes
      if (changes.notes && (changes.notes.added.length > 0 || changes.notes.removed.length > 0 || changes.notes.updated.length > 0)) {
        lines.push("");
        lines.push("## Notes");
        for (const n of changes.notes.added) {
          lines.push(`- ${displayIdOf(n)}: added`);
        }
        for (const n of changes.notes.removed) {
          lines.push(`- ${displayIdOf(n)}: removed`);
        }
        for (const n of changes.notes.updated) {
          lines.push(`- ${displayIdOf(n)}: updated (${n.changedFields.join(", ")})`);
        }
      }

      // Lesson changes
      if (changes.lessons && (changes.lessons.added.length > 0 || changes.lessons.removed.length > 0 || changes.lessons.updated.length > 0 || changes.lessons.reinforced.length > 0)) {
        lines.push("");
        lines.push("## Lessons");
        for (const l of changes.lessons.added) {
          lines.push(`- ${displayIdOf(l)}: ${escapeMarkdownInline(l.title)} -- **new**`);
        }
        for (const l of changes.lessons.removed) {
          lines.push(`- ${displayIdOf(l)}: ${escapeMarkdownInline(l.title)} -- removed`);
        }
        for (const l of changes.lessons.updated) {
          lines.push(`- ${displayIdOf(l)}: updated (${l.changedFields.join(", ")})`);
        }
        for (const l of changes.lessons.reinforced) {
          lines.push(`- ${displayIdOf(l)}: ${escapeMarkdownInline(l.title)} -- reinforced (${l.from} → ${l.to})`);
        }
      }
    }
  }

  // Suggested actions (always shown)
  const actions = recap.suggestedActions;
  lines.push("");
  lines.push("## Suggested Actions");

  if (actions.nextTicket) {
    lines.push(`- **Next:** ${displayIdOf(actions.nextTicket)} -- ${escapeMarkdownInline(actions.nextTicket.title)}${actions.nextTicket.phase ? ` (${actions.nextTicket.phase})` : ""}`);
  }

  if (actions.highSeverityIssues.length > 0) {
    // T-320 commit 4: show at most the first five (already sorted
    // critical-before-high, then discoveredDate, then displayId by
    // buildRecap); report anything past that as a per-severity overflow line
    // rather than silently dropping it.
    const shown = actions.highSeverityIssues.slice(0, 5);
    for (const i of shown) {
      lines.push(`- **${i.severity} issue:** ${displayIdOf(i)} -- ${escapeMarkdownInline(i.title)}`);
    }
    const omitted = actions.highSeverityIssues.slice(5);
    if (omitted.length > 0) {
      const criticalOmitted = omitted.filter((i) => i.severity === "critical").length;
      const highOmitted = omitted.filter((i) => i.severity === "high").length;
      const parts: string[] = [];
      if (criticalOmitted > 0) parts.push(`${criticalOmitted} critical`);
      if (highOmitted > 0) parts.push(`${highOmitted} high`);
      lines.push(`- *(${omitted.length} more issue${omitted.length === 1 ? "" : "s"} omitted: ${parts.join(", ")})*`);
    }
  }

  if (actions.recentlyClearedBlockers.length > 0) {
    lines.push(`- **Recently cleared:** ${actions.recentlyClearedBlockers.map(escapeMarkdownInline).join(", ")}`);
  }

  // ISSUE-FLOW NUDGE. Fires on the RECORD-DATE BALANCE and says so in the same
  // breath, because the two are not the same claim: a single `resolvedDate`
  // cannot represent a close-reopen-close cycle and a deleted issue leaves no
  // record at all, so this balance and the open backlog can move in opposite
  // directions. Asserting backlog growth here would be a claim the records do
  // not support.
  //
  // NULL means the issue records were not available to this caller, and that is
  // NOT a balance of zero: no line, no nudge.
  const nudgeFlow = statusIssueFlow(state);
  const nudged = nudgeFlow !== null && nudgeFlow.net > 0;
  if (nudged) {
    lines.push(
      `- **Issue flow:** ${nudgeFlow.opened} opened / ${nudgeFlow.resolved} resolved `
      + `in the last ${nudgeFlow.windowDays}d by record date (net +${nudgeFlow.net}). `
      + "That is a balance of record dates among retained issues, NOT a change in "
      + "the open backlog.",
    );
  }

  if (!actions.nextTicket && actions.highSeverityIssues.length === 0 && actions.recentlyClearedBlockers.length === 0 && !nudged) {
    lines.push("- No urgent actions.");
  }

  return lines.join("\n");
}

export function formatExport(
  state: ProjectState,
  mode: "all" | "phase",
  phaseId: string | null,
  format: OutputFormat,
): string {
  if (mode === "phase" && phaseId) {
    return formatPhaseExport(state, phaseId, format);
  }
  return formatFullExport(state, format);
}

function formatPhaseExport(
  state: ProjectState,
  phaseId: string,
  format: OutputFormat,
): string {
  const phase = state.roadmap.phases.find((p) => p.id === phaseId);
  if (!phase) {
    // Should be caught upstream, but defensive
    return formatError("not_found", `Phase "${phaseId}" not found`, format);
  }

  const phaseStatus = state.phaseStatus(phaseId);
  const leaves = state.phaseTickets(phaseId);

  // Collect umbrella ancestors
  const umbrellaAncestors = new Map<string, Ticket>();
  for (const leaf of leaves) {
    if (leaf.parentTicket) {
      const parent = state.ticketByID(leaf.parentTicket);
      if (parent && !umbrellaAncestors.has(parent.id)) {
        umbrellaAncestors.set(parent.id, parent);
      }
    }
  }

  // Cross-phase dependencies
  const crossPhaseDeps = new Map<string, Ticket>();
  for (const leaf of leaves) {
    for (const blockerId of leaf.blockedBy) {
      const blocker = state.ticketByID(blockerId);
      if (blocker && blocker.phase !== phaseId && !crossPhaseDeps.has(blocker.id)) {
        crossPhaseDeps.set(blocker.id, blocker);
      }
    }
  }

  // Related issues
  const relatedIssues = state.activeIssues.filter(
    (i) =>
      i.status !== "resolved" &&
      (i.phase === phaseId ||
        i.relatedTickets.some((tid) => {
          const t = state.ticketByID(tid);
          return t && t.phase === phaseId;
        })),
  );

  // Active blockers
  const activeBlockers = state.roadmap.blockers.filter(
    (b) => !isBlockerCleared(b),
  );

  if (format === "json") {
    return JSON.stringify(
      successEnvelope({
        phase: { id: phase.id, name: phase.name, description: phase.description, status: phaseStatus },
        tickets: leaves.map((t) => ({ id: t.id, title: t.title, status: t.status, type: t.type, order: t.order })),
        umbrellaAncestors: [...umbrellaAncestors.values()].map((t) => ({ id: t.id, title: t.title })),
        crossPhaseDependencies: [...crossPhaseDeps.values()].map((t) => ({ id: t.id, title: t.title, status: t.status, phase: t.phase })),
        issues: relatedIssues.map((i) => issueJsonBody(i)),
        blockers: activeBlockers.map((b) => ({ name: b.name, note: b.note ?? null })),
      }),
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`# ${escapeMarkdownDocument(phase.name)} (${phase.id})`);
  lines.push("");
  lines.push(`Status: ${phaseStatus}`);
  if (phase.description) {
    lines.push(`Description: ${escapeMarkdownDocument(phase.description)}`);
  }

  if (leaves.length > 0) {
    lines.push("");
    lines.push("## Tickets");
    for (const t of leaves) {
      const indicator = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
      const parentLabel = t.parentTicket && umbrellaAncestors.has(t.parentTicket) ? ` (under ${resolveTicketRefDisplay(t.parentTicket, state)})` : "";
      lines.push(`${indicator} ${displayIdOf(t)}: ${escapeMarkdownDocument(t.title)}${parentLabel}`);
    }
  }

  if (crossPhaseDeps.size > 0) {
    lines.push("");
    lines.push("## Cross-Phase Dependencies");
    for (const [, dep] of crossPhaseDeps) {
      lines.push(`- ${displayIdOf(dep)}: ${escapeMarkdownDocument(dep.title)} [${dep.status}] (${dep.phase ?? "unphased"})`);
    }
  }

  if (relatedIssues.length > 0) {
    lines.push("");
    lines.push("## Open Issues");
    for (const i of relatedIssues) {
      lines.push(`- ${displayIdOf(i)} [${i.severity}]: ${escapeMarkdownDocument(i.title)}${exportDispositionTag(i)}`);
    }
  }

  if (activeBlockers.length > 0) {
    lines.push("");
    lines.push("## Active Blockers");
    for (const b of activeBlockers) {
      lines.push(`- ${escapeMarkdownDocument(b.name)}${b.note ? ` -- ${escapeMarkdownDocument(b.note)}` : ""}`);
    }
  }

  return lines.join("\n");
}

/**
 * An exported issue line's disposition, as list shows it, with the evidence
 * only while it is bound: ` {owner_gated: reason [ref]}`, or "" when none.
 */
function exportDispositionTag(issue: Issue): string {
  if (!issue.disposition) return "";
  const evidence = dispositionEvidenceView(issue);
  const detail = evidence.state === "effective"
    ? `: ${escapeMarkdownDocument(evidence.reason!)} [${escapeMarkdownDocument(evidence.ref!)}]`
    : "";
  return ` {${issue.disposition}${detail}}`;
}

function formatFullExport(
  state: ProjectState,
  format: OutputFormat,
): string {
  const phases = phasesWithStatus(state);

  if (format === "json") {
    return JSON.stringify(
      successEnvelope({
        project: state.config.project,
        phases: phases.map((p) => ({
          id: p.phase.id,
          name: p.phase.name,
          description: p.phase.description,
          status: p.status,
          tickets: state.phaseTickets(p.phase.id).map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            type: t.type,
          })),
        })),
        issues: state.activeIssues.map((i) => issueJsonBody(i)),
        notes: state.activeNotes.map((n) => ({
          id: n.id,
          title: n.title,
          status: n.status,
          tags: n.tags,
        })),
        lessons: state.activeLessons.filter((l) => l.status === "active").map((l) => ({
          id: l.id,
          title: l.title,
          content: l.content,
          tags: l.tags,
          reinforcements: l.reinforcements,
        })),
        blockers: state.roadmap.blockers.map((b) => ({
          name: b.name,
          cleared: isBlockerCleared(b),
          note: b.note ?? null,
        })),
      }),
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`# ${escapeMarkdownDocument(state.config.project)} -- Full Export`);
  lines.push("");
  lines.push(`Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete`);
  lines.push(`Issues: ${state.activeIssueCount} open`);
  lines.push(`Notes: ${state.activeNoteCount} active, ${state.archivedNoteCount} archived`);
  lines.push(`Lessons: ${state.activeLessonCount} active, ${state.deprecatedLessonCount} deprecated`);

  lines.push("");
  lines.push("## Phases");
  for (const p of phases) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    lines.push("");
    lines.push(`### ${indicator} ${escapeMarkdownDocument(p.phase.name)} (${p.phase.id})`);
    if (p.phase.description) {
      lines.push(escapeMarkdownDocument(p.phase.description));
    }
    const tickets = state.phaseTickets(p.phase.id);
    if (tickets.length > 0) {
      lines.push("");
      for (const t of tickets) {
        const ti = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
        lines.push(`${ti} ${displayIdOf(t)}: ${escapeMarkdownDocument(t.title)}`);
      }
    }
  }

  if (state.activeIssues.length > 0) {
    lines.push("");
    lines.push("## Issues");
    for (const i of state.activeIssues) {
      const kind = effectiveResolutionKind(i);
      const resolved = i.status === "resolved" ? ` ✓${kind ? ` (${kind})` : ""}` : "";
      lines.push(`- ${displayIdOf(i)} [${i.severity}]: ${escapeMarkdownDocument(i.title)}${resolved}${exportDispositionTag(i)}`);
    }
  }

  const activeNotes = state.activeNotes.filter((n) => n.status === "active");
  if (activeNotes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    for (const n of activeNotes) {
      const title = n.title ?? displayIdOf(n);
      const tagInfo = n.tags.length > 0 ? ` (${n.tags.map(escapeMarkdownDocument).join(", ")})` : "";
      lines.push(`- ${displayIdOf(n)}: ${escapeMarkdownDocument(title)}${tagInfo}`);
    }
  }

  const activeLessons = state.activeLessons.filter((l) => l.status === "active");
  if (activeLessons.length > 0) {
    lines.push("");
    lines.push("## Lessons");
    for (const l of activeLessons) {
      const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements})` : "";
      const tagInfo = l.tags.length > 0 ? ` [${l.tags.map(escapeMarkdownDocument).join(", ")}]` : "";
      lines.push(`- ${displayIdOf(l)}: ${escapeMarkdownDocument(l.title)}${reinforced}${tagInfo}`);
    }
  }

  const blockers = state.roadmap.blockers;
  if (blockers.length > 0) {
    lines.push("");
    lines.push("## Blockers");
    for (const b of blockers) {
      const cleared = isBlockerCleared(b) ? "[x]" : "[ ]";
      lines.push(`${cleared} ${escapeMarkdownDocument(b.name)}${b.note ? ` -- ${escapeMarkdownDocument(b.note)}` : ""}`);
    }
  }

  return lines.join("\n");
}

function hasAnyChanges(diff: SnapshotDiff): boolean {
  return (
    diff.tickets.added.length > 0 ||
    diff.tickets.removed.length > 0 ||
    diff.tickets.statusChanged.length > 0 ||
    diff.tickets.descriptionChanged.length > 0 ||
    diff.issues.added.length > 0 ||
    diff.issues.resolved.length > 0 ||
    diff.issues.statusChanged.length > 0 ||
    diff.issues.impactChanged.length > 0 ||
    diff.blockers.added.length > 0 ||
    diff.blockers.cleared.length > 0 ||
    diff.phases.added.length > 0 ||
    diff.phases.removed.length > 0 ||
    diff.phases.statusChanged.length > 0 ||
    (diff.notes?.added.length ?? 0) > 0 ||
    (diff.notes?.removed.length ?? 0) > 0 ||
    (diff.notes?.updated.length ?? 0) > 0 ||
    (diff.handovers?.added.length ?? 0) > 0 ||
    (diff.handovers?.removed.length ?? 0) > 0 ||
    (diff.lessons?.added.length ?? 0) > 0 ||
    (diff.lessons?.removed.length ?? 0) > 0 ||
    (diff.lessons?.updated.length ?? 0) > 0 ||
    (diff.lessons?.reinforced.length ?? 0) > 0
  );
}

// --- Selftest ---

export function formatSelftestResult(
  result: SelftestResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }

  const lines: string[] = ["# Self-test Report", ""];

  // Group results by entity
  const entities: Array<"ticket" | "issue" | "note" | "lesson"> = ["ticket", "issue", "note", "lesson"];
  for (const entity of entities) {
    const checks = result.results.filter((r) => r.entity === entity);
    if (checks.length === 0) continue;
    lines.push(`## ${entity.charAt(0).toUpperCase() + entity.slice(1)}`);
    for (const check of checks) {
      const mark = check.passed ? "[x]" : "[ ]";
      const suffix = check.passed ? "" : ` -- ${check.detail}`;
      lines.push(`- ${mark} ${check.step}${suffix}`);
    }
    lines.push("");
  }

  if (result.cleanupErrors.length > 0) {
    lines.push("## Cleanup Warnings");
    lines.push("");
    for (const err of result.cleanupErrors) {
      lines.push(`- ${err}`);
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push(`Result: ${result.passed}/${result.total} passed`);
  return lines.join("\n");
}

// --- Private Helpers ---

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function formatTicketOneLiner(t: Ticket, state: ProjectState): string {
  const status = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
  const blocked = state.isBlocked(t) ? " [BLOCKED]" : "";
  // T-537: a checkpoint's stored status says nothing about its answer.
  const checkpoint = checkpointSummary(t);
  const mark = checkpoint ? ` [checkpoint ${checkpoint.state}]` : "";
  return `${status} ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)}${mark}${blocked}`;
}

// --- Reference ---

export interface CommandEntry {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly flags?: readonly string[];
}

export interface McpToolEntry {
  readonly name: string;
  readonly description: string;
  readonly params?: readonly string[];
}

export function formatReference(
  commands: readonly CommandEntry[],
  mcpTools: readonly McpToolEntry[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ commands, mcpTools }), null, 2);
  }

  const lines: string[] = [];
  lines.push("# storybloq Reference");
  lines.push("");
  lines.push("## CLI Commands");
  lines.push("");
  lines.push("### JSON output envelope");
  lines.push("");
  lines.push('`--format json` normally returns `{"version":1,"data":...}` or `{"version":1,"error":{"code":...,"message":...}}`. Partial loads add `warnings` and exit 3. `--raw` emits only `data`, retaining error envelopes but dropping partial-load warnings; the exit code still signals them. Exceptions: `gc`, `conflicts list`, `conflicts show`, `resolve`, and `team reserve` return `{"ok","data"}`; `team init` and `team setup` return bare objects; `session list/show` use their own text/json shapes; Bus commands use their versioned wire format. Those exceptions reject `--raw` during argument validation, before execution. Each command names its shape in `--help`. Use JSON to round-trip description/impact/content: markdown render fences grow when fed back through `update --stdin`; updates strip them and warn (ISS-1192).');
  lines.push("");
  lines.push("Run `storybloq <command>`. Positional arguments appear after the command; ? marks optional flags. Use `<command> --help` for value types and choices, or `storybloq reference --format json` for full usage strings.");
  lines.push("");
  for (const cmd of commands) {
    // A usage with alternatives ("storybloq x <a> | storybloq x --b") renders each form with its own flags.
    const forms = cmd.usage.split(" | storybloq ").map((u, i) => (i === 0 ? u : `storybloq ${u}`));
    const rendered = forms.map((form) => {
      const suffix = form.slice(`storybloq ${cmd.name}`.length);
      const positionals = suffix.split(/\s+\[?--/)[0]!.trim();
      const flags = (cmd.flags ?? [])
        .filter((flag) => forms.length === 1 || form.includes(flag))
        .map((flag) => flag + (form.includes(`[${flag}`) ? "?" : ""));
      const argumentsList = flags.length ? ` (${flags.join(", ")})` : "";
      return `**${cmd.name}${positionals ? ` ${positionals}` : ""}**${argumentsList}`;
    });
    lines.push(`- ${rendered.join(" | ")} - ${cmd.description}`);
  }
  lines.push("");

  lines.push("## MCP Tools");
  lines.push("");
  lines.push("The base tools below are registered in full mode (inside a .story/ project). The storybloq_bus_* tools are always registered in full mode; when the Bus is disabled or uninitialized they return setup guidance pointing at `storybloq bus setup`, with no MCP restart required.");
  lines.push("");
  lines.push("Arguments marked ? are optional in the registered schema; handlers may require combinations depending on the action. Use the client’s tool schema for types and constraints.");
  lines.push("");
  for (const tool of mcpTools) {
    const params = tool.params?.length ? ` (${tool.params.join(", ")})` : "";
    lines.push(`- **${tool.name}**${params} - ${tool.description}`);
  }

  lines.push("");
  lines.push("### MCP Tools (degraded mode)");
  lines.push("");
  lines.push("With no .story/ project on the path, the MCP server starts degraded and registers only:");
  lines.push("");
  lines.push("- **storybloq_session_guard** (clientTaskId?) -- the ownership verdict, available here because the no-project case is exactly where the skill runs its Step 0.5 guard first (T-446)");
  lines.push("- **storybloq_session_intel** (format?, sessionId?, transcript?, callerModel?, full?, clientTaskId?) -- context usage and session facts without a project");
  lines.push("- **storybloq_health** (format?, only?, refresh?) -- read-only tooling checks without a project");
  lines.push("- **storybloq_init** (name, type?, language?) -- bootstrap a .story/ project, then dynamically register the full tool set");
  lines.push("- **storybloq_status** (format?) -- returns setup guidance instead of a project summary");
  lines.push("");
  lines.push("Destructive, admin, and git-integration workflows (delete, reconcile, conflicts, resolve, merge-driver, team, gc, repair, config, feedback) are CLI-only in both modes; see the CLI Commands section above.");

  lines.push("");
  lines.push("## Review verdict artifacts");
  lines.push("");
  lines.push("Review JSON lives in `.story/sessions/<sessionId>/telemetry/reviews/<target>-<stage>-r<round>.json`. Generations above the first append `-g<generation>` before `.json`, preserving the `*-code-r*.json` glob. Generation also appears in the payload. Redirects and plan-review rejects restart round numbering; old artifacts may mix pre-generation rounds whose colliding files were silently dropped.");
  lines.push("");
  lines.push("### Joining a round to what produced it");
  lines.push("");
  lines.push("`backendRunIdKind` defines the scope of `backendRunId`; derive join quality from the ids rather than storing a potentially contradictory summary:");
  lines.push("");
  lines.push("| Kind | Scope | Exact join requires |");
  lines.push("|---|---|---|");
  lines.push("| `codex-session` | Thread spanning turns | `backendTurnId` too |");
  lines.push("| `agent-dispatch` | One dispatch/turn | Run id alone |");
  lines.push("| `lens-review` | One review invocation | Run id alone |");
  lines.push("");
  lines.push("A turn id without its parent run id joins nothing (`none`), as does a record with neither. Absence is never `exact`. `reviewAttemptId` identifies a round across state, artifact, and event sinks; deduplicate best-effort events by it. `itemAttemptId` identifies one work-item attempt across its rounds.");
  lines.push("");
  lines.push("With `itemAttemptId`, `generation` tracks replans within that attempt: redirects advance it when numbering restarts. Without `itemAttemptId`, there was no work item; generation only prevents filename collisions among unrelated `unknown` targets. Never count those generations as attempts or replans.");
  lines.push("");
  lines.push("### Reading absent values");
  lines.push("");
  lines.push("Fields are optional. Missing means unrecorded, not measured-empty or old: current records can omit backend ids when none were supplied, or work/item ids when no item existed. Missing `normalizerVersion` permits unnormalized severities such as `blocking`; missing `artifactStatus` means existence is unknown. `reviewerIdentity.evidence` distinguishes observed execution from configuration: `configured` proves intent only; prefer `unknown`/`none` to a guessed model.");
  lines.push("");
  lines.push("`payloadConsistent` compares a verdict with its findings. Change-requesting verdicts with zero findings are repaired before becoming rounds and counted in `reviewRepairAttempts`; these populations must never be summed.");
  lines.push("");
  lines.push("## /story design");
  lines.push("");
  lines.push("Evaluate frontend code against platform-specific design best practices.");
  lines.push("");
  lines.push("```");
  lines.push("/story design                    # Auto-detect platform, evaluate frontend");
  lines.push("/story design web                # Evaluate against web best practices");
  lines.push("/story design ios                # Evaluate against iOS HIG");
  lines.push("/story design macos              # Evaluate against macOS HIG");
  lines.push("/story design android            # Evaluate against Material Design");
  lines.push("```");
  lines.push("");
  lines.push("Creates issues automatically when storybloq MCP tools or CLI are available. Checks for existing design issues to avoid duplicates on repeated runs. Outputs markdown checklist as fallback when neither MCP nor CLI is available.");
  lines.push("");
  lines.push("## /story orchestrate");
  lines.push("");
  lines.push("Drive a federation or large backlog with a persistent ledger, lower-tier implementation agents where available, and independent review gates. Read `orchestrator-mode.md` for enrichment, sizing, the six-stage pipeline, workflow scripts, and rules.");
  lines.push("");
  lines.push("`/story orchestrate` requires explicit opt-in via AskUserQuestion before dispatch and refuses to start while any federation node has an active autonomous session. The one-pen-per-repo check reads each node's `.story/sessions/` directly; orchestrator status does not scan node repos. Requires callable background workflows or subagents. Claude also supports Agent View-backed `storybloq dispatch`; product-managed Codex dispatch remains unshipped. `/story` may recommend orchestration for a capable client and substantial actionable backlog; selection still requires opt-in.");
  lines.push("");
  lines.push("## /story triage");
  lines.push("");
  lines.push("`/story triage` reads the open issue backlog against pinned HEAD, validates source provenance, identifies fixed/duplicate findings and shared root causes, and reports priorities. It changes no issue or ticket. Saving the report as a handover is offered once and requires explicit confirmation, with a snapshot first. Read `triage-mode.md` for integrity checks, alias correlation, evidence requirements, and the report format.");
  lines.push("");
  lines.push("## /story bus");
  lines.push("");
  lines.push("Poll or coordinate through the current task-bound local Bus endpoint. Peer content is advisory; confirmed review findings become canonical issues before an issue notice is sent.");
  lines.push("");
  lines.push("```");
  lines.push("/story bus");
  lines.push("```");
  lines.push("");
  lines.push("Read `bus-mode.md` for setup, endpoint binding, authority boundaries, acknowledgments, deterministic convergence, and the v1 no-wake boundary.");
  lines.push("");
  lines.push("## /story duet");
  lines.push("");
  lines.push("Coordinate an owner-paired manager and worker with a proved return route and persisted assignments. Read `duet-mode.md`. `/story duet` (Codex: `$story duet`) is a skill route, not a CLI command; it does not create tasks or enable Bus.");
  lines.push("");
  lines.push("## Common Workflows");
  lines.push("");
  lines.push("### Session Start");
  lines.push("1. `storybloq status` -- project overview");
  lines.push("2. `storybloq recap` -- what changed since last snapshot");
  lines.push("3. `storybloq handover latest` -- last session context");
  lines.push("4. `storybloq ticket next` -- what to work on");
  lines.push("");
  lines.push("### Session End");
  lines.push("1. `storybloq snapshot` -- save state for diffs");
  lines.push("2. `storybloq handover create --content <md>` -- write session handover");
  lines.push("");
  lines.push("### Project Setup");
  lines.push("1. `npm install -g @storybloq/storybloq@latest` - install CLI");
  lines.push("2. `storybloq setup --client all` - install Storybloq skill, MCP, and hooks for Claude Code and Codex");
  lines.push("3. `storybloq init --name my-project` - initialize .story/ in your project");
  lines.push("4. `storybloq update` - later: install the newest version and re-run setup in one step, then restart the client");
  lines.push("");
  lines.push("## Troubleshooting");
  lines.push("");
  lines.push("- **MCP not connected:** Run `storybloq setup --client all`");
  lines.push("- **CLI not found:** Run `npm install -g @storybloq/storybloq@latest`");
  lines.push("- **Stale data:** Run `storybloq validate` to check integrity");
  lines.push("- **Storybloq skill not available:** Run `storybloq setup --client all` to install the skill");

  return lines.join("\n");
}

/**
 * ISS-1154: without `withActionability`, markdown output is byte-identical
 * to before this ticket -- the flag opt-in gates every new rendering
 * addition (actionability suffixes, the Excluded section, the
 * window-incomplete warning). MCP's JSON envelope carries the new fields
 * unconditionally regardless of this flag (2f) -- this gate is CLI-only.
 */
export function formatRecommendations(
  result: RecommendResult,
  state: ProjectState,
  format: OutputFormat,
  withActionability = false,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ ...result, isEmptyScaffold: state.isEmptyScaffold }), null, 2);
  }

  const windowIncomplete = isHandoverWindowIncomplete(result.unreadableHandoverCount);
  const hasNothingToShow = withActionability
    ? result.recommendations.length === 0 && result.excludedCount === 0 && !windowIncomplete
    : result.recommendations.length === 0;

  if (hasNothingToShow) {
    if (state.isEmptyScaffold) {
      return "No recommendations yet -- this project needs tickets and phases. Run the /story setup flow to get started.";
    }
    if (state.config.type === "orchestrator") {
      return "No recommendations. Run storybloq status for federation overview.";
    }
    return "No recommendations -- all work is complete or blocked.";
  }

  const lines: string[] = ["# Recommendations", ""];

  if (withActionability && windowIncomplete) {
    lines.push(
      result.unreadableHandoverCount === null
        ? "_Warning: handover history could not be listed -- results may be incomplete._"
        : `_Warning: ${result.unreadableHandoverCount} handover file(s) could not be read -- results may be incomplete._`,
    );
    lines.push("");
  }

  for (let i = 0; i < result.recommendations.length; i++) {
    const rec = result.recommendations[i]!;
    const suffix =
      withActionability && rec.actionability
        ? ` (${rec.actionability.status} -- ${escapeMarkdownInline(rec.actionability.reason)})`
        : "";
    lines.push(
      `${i + 1}. **${escapeMarkdownInline(displayIdOf(rec))}** (${rec.kind}) -- ${escapeMarkdownInline(rec.title)}${suffix}`,
    );
    lines.push(`   _${escapeMarkdownInline(rec.reason)}_`);
    lines.push("");
  }

  if (result.totalCandidates > result.recommendations.length) {
    lines.push(
      `Showing ${result.recommendations.length} of ${result.totalCandidates} candidates.`,
    );
  }

  if (withActionability && result.excludedCount > 0) {
    lines.push("");
    const shown = result.excluded.length;
    lines.push(
      shown === result.excludedCount
        ? `## Excluded (${result.excludedCount})`
        : `## Excluded (${result.excludedCount} total, showing ${shown})`,
    );
    lines.push("");
    for (const entry of result.excluded) {
      lines.push(
        `- ${escapeMarkdownInline(displayIdOf(entry))}: ${escapeMarkdownInline(entry.title)} (${entry.actionability.status} -- ${escapeMarkdownInline(entry.actionability.reason)})`,
      );
    }
  }

  return lines.join("\n");
}

export function formatReconcileResult(
  result: ReconcileResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    if (!result.ok) return JSON.stringify({ ok: false, errors: result.errors }, null, 2);
    const remedy = result.plan.renames.length > 0 ? ENABLE_GIT_REFS_REMEDY : undefined;
    return JSON.stringify(successEnvelope({ ...result.plan, ...(remedy && { remedy }) }), null, 2);
  }
  if (!result.ok) {
    const lines = ["# Reconcile Failed", ""];
    for (const err of result.errors) {
      lines.push(`- ${escapeMarkdownInline(err)}`);
    }
    return lines.join("\n");
  }
  const { plan } = result;
  if (plan.renames.length === 0) {
    return "No duplicate displayIds found. Project is clean.";
  }
  const lines = ["# Reconcile Plan", "", `${plan.renames.length} rename(s) needed:`, ""];
  lines.push("| Type | ID | Old DisplayId | New DisplayId | Reason |");
  lines.push("|------|----|---------------|---------------|--------|");
  for (const r of plan.renames) {
    lines.push(`| ${r.entityType} | ${escapeMarkdownInline(r.id)} | ${escapeMarkdownInline(r.oldDisplayId)} | ${escapeMarkdownInline(r.newDisplayId)} | ${escapeMarkdownInline(r.reason)} |`);
  }
  if (plan.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const w of plan.warnings) {
      lines.push(`- ${escapeMarkdownInline(w.message)}`);
    }
  }
  // ISS-1190: the same one-line remedy the create-time warning and team
  // doctor print, whenever this collision-finding run actually found one.
  lines.push("", `${escapeMarkdownInline(ENABLE_GIT_REFS_REMEDY)}`);
  return lines.join("\n");
}

export function formatDoctorResult(
  result: DoctorResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }
  if (result.findings.length === 0) {
    return "Team doctor: all checks passed.";
  }
  const lines = ["# Team Doctor", ""];
  lines.push(`${result.errorCount} error(s), ${result.warningCount} warning(s), ${result.infoCount} info`);
  lines.push("");

  const grouped: Record<string, typeof result.findings> = { error: [], warning: [], info: [] };
  for (const f of result.findings) {
    grouped[f.severity]!.push(f);
  }

  for (const severity of ["error", "warning", "info"] as const) {
    const group = grouped[severity]!;
    if (group.length === 0) continue;
    lines.push(`## ${severity.charAt(0).toUpperCase() + severity.slice(1)}s`, "");
    for (const f of group) {
      const entityPart = f.entity ? ` (${escapeMarkdownInline(f.entity)})` : "";
      lines.push(`- **${f.code}**${entityPart}: ${escapeMarkdownInline(f.message)}`);
      if (f.repair) {
        if ("command" in f.repair) {
          lines.push(`  Fix: \`${f.repair.command.map(shellQuote).join(" ")}\``);
        } else {
          for (const step of f.repair.manualSteps) {
            lines.push(`  Fix: ${escapeMarkdownInline(step)}`);
          }
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9_./@:-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
