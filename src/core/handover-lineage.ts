/**
 * ISS-1499 slice A: the handover lineage line, as a pure module.
 *
 * A linked handover ends with one line:
 *
 *   <!-- storybloq-lineage v1 continues="FILE" from="FILE" absorbs="FILE" role="LABEL" at="HEX" by="WHO" -->
 *
 * This module owns the grammar (parse and serialise), the tail rule that
 * decides whether a file or a string is linked, the removal and addition of
 * the line, and the Parent / tip / fork / loop computations over a scan
 * result. It performs no I/O: the only reader of files is
 * `handover-lineage-scan.ts`, which applies `readLineageTail` below to the
 * final bytes of each file, so a string in memory and a file on disk can
 * never disagree about whether they are linked.
 */

/** The tail rule reads at most this many final bytes. */
export const LINEAGE_TAIL_BYTES = 2048;
/** A lineage line is at most this many bytes. */
export const LINEAGE_MAX_LINE_BYTES = 1024;
/** At most this many `absorbs` values are kept. */
export const LINEAGE_MAX_ABSORBS = 8;

const FILE_MAX_BYTES = 255;
const ROLE_MAX_BYTES = 64;
const BY_MAX_BYTES = 128;

const LINE_RE = /^<!-- storybloq-lineage v1((?: [a-z]+="[^"]*")*) -->$/;
const ATTR_RE = / ([a-z]+)="([^"]*)"/g;
const LINE_PREFIX = "<!-- storybloq-lineage v1 ";
const AT_RE = /^[0-9a-f]{7,40}$/;

export type LineageAttribute = "continues" | "from" | "absorbs" | "role" | "at" | "by";
export type DroppedReason = "invalid" | "unknown" | "duplicate" | "count_limit" | "size";

/** An attribute that did not survive. The value is never carried, only the name. */
export interface DroppedAttribute {
  readonly attribute: string;
  readonly reason: DroppedReason;
}

export type ContinuesState =
  | { readonly state: "absent" }
  | { readonly state: "valid"; readonly file: string }
  | { readonly state: "invalid" };

export interface Lineage {
  readonly continues: ContinuesState;
  readonly from: string | null;
  readonly absorbs: readonly string[];
  readonly role: string | null;
  readonly at: string | null;
  readonly by: string | null;
}

export interface ParsedLineage {
  readonly lineage: Lineage;
  readonly dropped: readonly DroppedAttribute[];
}

// ---------------------------------------------------------------------------
// Value rules (3.1)
// ---------------------------------------------------------------------------

function isSafeValue(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
    if (c === 0x22 || c === 0x3c || c === 0x3e || c === 0x5c) return false;
  }
  return true;
}

/** A FILE value: safe, no `/`, no `..`, ends in `.md`, at most 255 bytes. */
export function isLineageFileValue(value: string): boolean {
  return (
    isSafeValue(value) &&
    value.length <= FILE_MAX_BYTES &&
    !value.includes("/") &&
    !value.includes("..") &&
    value.endsWith(".md")
  );
}

/** A `role` value: safe, at most 64 bytes. */
export function isLineageRoleValue(value: string): boolean {
  return isSafeValue(value) && value.length <= ROLE_MAX_BYTES;
}

/** A `by` value: safe, at most 128 bytes. */
export function isLineageByValue(value: string): boolean {
  return isSafeValue(value) && value.length <= BY_MAX_BYTES;
}

/** An `at` value: 7 to 40 lowercase hex characters. */
export function isLineageAtValue(value: string): boolean {
  return AT_RE.test(value);
}

function valueIsValid(attribute: LineageAttribute, value: string): boolean {
  switch (attribute) {
    case "continues":
    case "from":
    case "absorbs":
      return isLineageFileValue(value);
    case "role":
      return isLineageRoleValue(value);
    case "by":
      return isLineageByValue(value);
    case "at":
      return isLineageAtValue(value);
  }
}

const KNOWN: ReadonlySet<string> = new Set(["continues", "from", "absorbs", "role", "at", "by"]);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parses one candidate line. Returns null when the line is longer than
 * 1,024 bytes or does not match the grammar; then it is not a lineage line.
 * The line is taken as latin1 text so that one character is one byte: any
 * byte outside printable ASCII makes the attribute that holds it invalid.
 */
export function parseLineageLine(line: string): ParsedLineage | null {
  if (Buffer.byteLength(line, "latin1") > LINEAGE_MAX_LINE_BYTES) return null;
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const dropped: DroppedAttribute[] = [];
  const seen = new Set<string>();
  let continues: ContinuesState = { state: "absent" };
  let from: string | null = null;
  let role: string | null = null;
  let at: string | null = null;
  let by: string | null = null;
  const absorbs: string[] = [];
  for (const a of m[1]!.matchAll(ATTR_RE)) {
    const name = a[1]!;
    const value = a[2]!;
    if (!KNOWN.has(name)) {
      dropped.push({ attribute: name, reason: "unknown" });
      continue;
    }
    const attribute = name as LineageAttribute;
    if (attribute === "absorbs") {
      if (!isLineageFileValue(value)) {
        dropped.push({ attribute, reason: "invalid" });
        continue;
      }
      if (absorbs.includes(value)) continue;
      if (absorbs.length >= LINEAGE_MAX_ABSORBS) {
        dropped.push({ attribute, reason: "count_limit" });
        continue;
      }
      absorbs.push(value);
      continue;
    }
    if (seen.has(attribute)) {
      dropped.push({ attribute, reason: "duplicate" });
      continue;
    }
    seen.add(attribute);
    const valid = valueIsValid(attribute, value);
    if (attribute === "continues") {
      continues = valid ? { state: "valid", file: value } : { state: "invalid" };
      if (!valid) dropped.push({ attribute, reason: "invalid" });
      continue;
    }
    if (!valid) {
      dropped.push({ attribute, reason: "invalid" });
      continue;
    }
    if (attribute === "from") from = value;
    else if (attribute === "role") role = value;
    else if (attribute === "at") at = value;
    else by = value;
  }
  return { lineage: { continues, from, absorbs, role, at, by }, dropped };
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

export interface LineageInput {
  readonly continues?: string | null;
  readonly from?: string | null;
  readonly absorbs?: readonly string[];
  readonly role?: string | null;
  readonly at?: string | null;
  readonly by?: string | null;
}

export interface SerializedLineage {
  readonly line: string;
  /** What the line actually carries, after every rule. */
  readonly lineage: Lineage;
  readonly dropped: readonly DroppedAttribute[];
}

function compose(l: {
  continues: string | null;
  from: string | null;
  absorbs: readonly string[];
  role: string | null;
  at: string | null;
  by: string | null;
}): string {
  let out = "<!-- storybloq-lineage v1";
  if (l.continues !== null) out += ` continues="${l.continues}"`;
  if (l.from !== null) out += ` from="${l.from}"`;
  for (const a of l.absorbs) out += ` absorbs="${a}"`;
  if (l.role !== null) out += ` role="${l.role}"`;
  if (l.at !== null) out += ` at="${l.at}"`;
  if (l.by !== null) out += ` by="${l.by}"`;
  return out + " -->";
}

/**
 * Writes a line in canonical order. A value that breaks its rule is dropped
 * and named; `absorbs` is de-duplicated and capped at 8. When the line is
 * over 1,024 bytes it drops, in order until it fits, `absorbs` from the last
 * to the first, then `from`, then `by`, then `role`. An invalid `continues`
 * is a caller error: such a link cannot be written, and writing the line
 * without it would start a new line, which section 5.2 forbids.
 */
export function serializeLineage(
  input: LineageInput,
  /**
   * The size limit. Only tests pass a smaller one: with valid values a line
   * without absorbs is at most 812 bytes, so at 1,024 the later steps of the
   * drop order are a guarantee, not a path the default limit reaches.
   */
  maxBytes: number = LINEAGE_MAX_LINE_BYTES,
): SerializedLineage {
  const dropped: DroppedAttribute[] = [];
  const keep = (attribute: LineageAttribute, v: string | null | undefined): string | null => {
    if (v === null || v === undefined) return null;
    if (!valueIsValid(attribute, v)) {
      dropped.push({ attribute, reason: "invalid" });
      return null;
    }
    return v;
  };
  if (input.continues !== null && input.continues !== undefined && !isLineageFileValue(input.continues)) {
    throw new Error("serializeLineage: an invalid continues cannot be written");
  }
  const l = {
    continues: input.continues ?? null,
    from: keep("from", input.from),
    absorbs: [] as string[],
    role: keep("role", input.role),
    at: keep("at", input.at),
    by: keep("by", input.by),
  };
  for (const a of input.absorbs ?? []) {
    if (!isLineageFileValue(a)) {
      dropped.push({ attribute: "absorbs", reason: "invalid" });
      continue;
    }
    if (l.absorbs.includes(a)) continue;
    if (l.absorbs.length >= LINEAGE_MAX_ABSORBS) {
      dropped.push({ attribute: "absorbs", reason: "count_limit" });
      continue;
    }
    l.absorbs.push(a);
  }
  let line = compose(l);
  const tooLong = () => Buffer.byteLength(line, "latin1") > maxBytes;
  while (tooLong() && l.absorbs.length > 0) {
    l.absorbs.pop();
    dropped.push({ attribute: "absorbs", reason: "size" });
    line = compose(l);
  }
  for (const attribute of ["from", "by", "role"] as const) {
    if (!tooLong()) break;
    if (l[attribute] !== null) {
      l[attribute] = null;
      dropped.push({ attribute, reason: "size" });
      line = compose(l);
    }
  }
  if (tooLong()) throw new Error("serializeLineage: continues and at exceed the line limit");
  const lineage: Lineage = {
    continues: l.continues === null ? { state: "absent" } : { state: "valid", file: l.continues },
    from: l.from,
    absorbs: [...l.absorbs],
    role: l.role,
    at: l.at,
    by: l.by,
  };
  return { line, lineage, dropped };
}

// ---------------------------------------------------------------------------
// The tail rule (3.2)
// ---------------------------------------------------------------------------

export type TailResult =
  | { readonly kind: "linked"; readonly parsed: ParsedLineage; readonly lineStart: number }
  | { readonly kind: "unlinked"; readonly nearMiss: boolean };

function isTrailingWs(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;
}

/**
 * Applies the tail rule to the final bytes of a content. `tail` is the final
 * `min(size, 2048)` bytes and `whole` says whether that is the whole
 * content. `lineStart` is the offset of the line inside `tail`.
 * `nearMiss` is true when the candidate line starts with the v1 prefix and
 * still is not a lineage line (validate reports it once a project opts in).
 */
export function readLineageTail(tail: Buffer, whole: boolean): TailResult {
  let end = tail.length;
  while (end > 0 && isTrailingWs(tail[end - 1]!)) end--;
  if (end === 0) return { kind: "unlinked", nearMiss: false };
  const lf = tail.lastIndexOf(0x0a, end - 1);
  if (lf === -1 && !whole) return { kind: "unlinked", nearMiss: false };
  const start = lf + 1;
  const candidate = tail.subarray(start, end);
  const text = candidate.toString("latin1");
  const parsed = candidate.length > LINEAGE_MAX_LINE_BYTES ? null : parseLineageLine(text);
  if (parsed) return { kind: "linked", parsed, lineStart: start };
  return { kind: "unlinked", nearMiss: text.startsWith(LINE_PREFIX) };
}

/** The tail rule over a whole content held in memory. */
export function readLineageFromBuffer(buf: Buffer): TailResult & { readonly offset: number } {
  const offset = Math.max(0, buf.length - LINEAGE_TAIL_BYTES);
  const r = readLineageTail(buf.subarray(offset), offset === 0);
  return { ...r, offset };
}

/** The tail rule over a string. */
export function readLineage(content: string): TailResult {
  const r = readLineageFromBuffer(Buffer.from(content, "utf8"));
  if (r.kind === "linked") return { kind: "linked", parsed: r.parsed, lineStart: r.lineStart };
  return { kind: "unlinked", nearMiss: r.nearMiss };
}

// ---------------------------------------------------------------------------
// Removing and adding the line (3.3)
// ---------------------------------------------------------------------------

function isWsOnlyLine(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d) return false;
  }
  return true;
}

/**
 * Removes trailing lines that are empty or hold only space, tab or CR, and
 * the final line terminator. Never changes a character of the last
 * non-blank line (a CR at its end stays: only LF terminates a line, as in
 * the tail rule).
 */
function trimTrailingBlankLines(text: string): string {
  const lines = text.split("\n");
  while (lines.length > 0 && isWsOnlyLine(lines[lines.length - 1]!)) lines.pop();
  return lines.join("\n");
}

export interface SplitLineage {
  /** The content with every lineage line removed; `content` itself when unlinked. */
  readonly body: string;
  /** The effective lineage: the one from the content's final line. */
  readonly lineage: ParsedLineage | null;
  /** Earlier stacked lineage lines that were also removed, nearest first. */
  readonly discarded: readonly ParsedLineage[];
}

/**
 * Removes the lineage line, and then any further line that the tail rule
 * finds in what is left, until the remainder is unlinked. `body` is the
 * content before the first removed line with trailing blank lines removed,
 * ending in exactly one LF (the empty string when nothing is left).
 * Invariant: `readLineage(body)` is always unlinked.
 */
export function splitLineage(content: string): SplitLineage {
  let buf = Buffer.from(content, "utf8");
  let r = readLineageFromBuffer(buf);
  if (r.kind !== "linked") return { body: content, lineage: null, discarded: [] };
  const lineage = r.parsed;
  const discarded: ParsedLineage[] = [];
  let body = "";
  for (;;) {
    const before = buf.subarray(0, r.offset + r.lineStart).toString("utf8");
    const trimmed = trimTrailingBlankLines(before);
    body = trimmed.length === 0 ? "" : trimmed + "\n";
    buf = Buffer.from(body, "utf8");
    r = readLineageFromBuffer(buf);
    if (r.kind !== "linked") break;
    discarded.push(r.parsed);
  }
  return { body, lineage, discarded };
}

/**
 * Appends a lineage line: the body with trailing blank lines and its final
 * line terminator removed, then a blank line, the line, and one LF.
 */
export function appendLineage(body: string, line: string): string {
  return trimTrailingBlankLines(body) + "\n\n" + line + "\n";
}

// ---------------------------------------------------------------------------
// Parent, tips, forks, loops (section 4)
// ---------------------------------------------------------------------------

export type ScanState = "linked" | "unlinked" | "unknown";
export type UnknownReason = "name_too_long" | "not_regular" | "unreadable";

export interface ScannedFile {
  readonly name: string;
  readonly state: ScanState;
  /** Set when `state` is `unknown`. */
  readonly reason?: UnknownReason;
  /** Set when `state` is `linked`. */
  readonly lineage?: ParsedLineage;
  /** Set when `state` is `unlinked`: the final line looked like a v1 line and was not one. */
  readonly nearMiss?: boolean;
}

export interface LineageScan {
  readonly files: readonly ScannedFile[];
  /** False when the folder could not be listed. */
  readonly enumerated: boolean;
  /** `enumerated` and no file `unknown`. */
  readonly complete: boolean;
}

export type BrokenReason = "missing" | "invalid" | "self" | "unreadable";

export type ParentResult =
  | { readonly kind: "file"; readonly file: string; readonly certain: boolean }
  | { readonly kind: "root" }
  | { readonly kind: "broken"; readonly reason: BrokenReason; readonly target: string | null };

export interface LineageGraph {
  readonly scan: LineageScan;
  /** Parent of every `linked` and `unlinked` file. `unknown` files have none. */
  readonly parent: ReadonlyMap<string, ParentResult>;
  /** Children by every edge, certain and provisional, in listing order. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Children by certain edges only, in listing order. */
  readonly certainChildren: ReadonlyMap<string, readonly string[]>;
  /** Files on a line with no children, in listing order. */
  readonly tips: readonly string[];
  /** Tips not absorbed, in listing order. */
  readonly openTips: readonly string[];
  /** For each absorbed tip, the handovers that absorb it, in listing order. */
  readonly absorbedBy: ReadonlyMap<string, readonly string[]>;
  /** Parents with two or more certain children. */
  readonly forks: readonly { readonly parent: string; readonly children: readonly string[] }[];
  /** Each loop once, members in listing order; loops in order of their first member. */
  readonly loops: readonly (readonly string[])[];
  /** The unlinked files in listing order. */
  readonly defaultLine: readonly string[];
  readonly head: string | null;
}

/** Builds Parent, children, tips, forks and loops from a scan. Pure and deterministic. */
export function buildLineageGraph(scan: LineageScan): LineageGraph {
  const files = scan.files;
  const byName = new Map<string, ScannedFile>();
  for (const f of files) if (!byName.has(f.name)) byName.set(f.name, f);
  const order = new Map<string, number>();
  files.forEach((f, i) => { if (!order.has(f.name)) order.set(f.name, i); });

  const parent = new Map<string, ParentResult>();
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (f.state === "unknown") continue;
    if (f.state === "linked") {
      const c = f.lineage!.lineage.continues;
      if (c.state === "absent") parent.set(f.name, { kind: "root" });
      else if (c.state === "invalid") parent.set(f.name, { kind: "broken", reason: "invalid", target: null });
      else if (c.file === f.name) parent.set(f.name, { kind: "broken", reason: "self", target: c.file });
      else {
        const t = byName.get(c.file);
        if (!t) parent.set(f.name, { kind: "broken", reason: "missing", target: c.file });
        else if (t.state === "unknown") parent.set(f.name, { kind: "broken", reason: "unreadable", target: c.file });
        else parent.set(f.name, { kind: "file", file: c.file, certain: true });
      }
      continue;
    }
    let certain = true;
    let next: string | null = null;
    for (let j = i + 1; j < files.length; j++) {
      const g = files[j]!;
      if (g.state === "unknown") { certain = false; continue; }
      if (g.state === "unlinked") { next = g.name; break; }
    }
    parent.set(f.name, next === null ? { kind: "root" } : { kind: "file", file: next, certain });
  }

  const children = new Map<string, string[]>();
  const certainChildren = new Map<string, string[]>();
  for (const f of files) {
    const p = parent.get(f.name);
    if (!p || p.kind !== "file") continue;
    (children.get(p.file) ?? children.set(p.file, []).get(p.file)!).push(f.name);
    if (p.certain) (certainChildren.get(p.file) ?? certainChildren.set(p.file, []).get(p.file)!).push(f.name);
  }

  const onLine = files.filter((f) => f.state !== "unknown").map((f) => f.name);
  const tips = onLine.filter((n) => !children.has(n));
  const tipSet = new Set(tips);

  const absorbedBy = new Map<string, string[]>();
  for (const f of files) {
    if (f.state !== "linked") continue;
    for (const a of f.lineage!.lineage.absorbs) {
      if (a === f.name || !tipSet.has(a)) continue;
      const list = absorbedBy.get(a) ?? absorbedBy.set(a, []).get(a)!;
      if (!list.includes(f.name)) list.push(f.name);
    }
  }
  const openTips = tips.filter((t) => !absorbedBy.has(t));

  const forks: { parent: string; children: string[] }[] = [];
  for (const n of onLine) {
    const c = certainChildren.get(n);
    if (c && c.length >= 2) forks.push({ parent: n, children: [...c] });
  }

  // Loops: every file has at most one parent, so follow Parent from each
  // file with a per-pass colour. A pass that meets its own colour has found
  // a new cycle; one that meets an earlier colour or a root has not.
  const colour = new Map<string, number>();
  const loops: string[][] = [];
  let pass = 0;
  for (const start of onLine) {
    if (colour.has(start)) continue;
    pass++;
    const path: string[] = [];
    let cur: string | null = start;
    while (cur !== null && !colour.has(cur)) {
      colour.set(cur, pass);
      path.push(cur);
      const p = parent.get(cur);
      cur = p && p.kind === "file" ? p.file : null;
    }
    if (cur !== null && colour.get(cur) === pass) {
      const cycle = path.slice(path.indexOf(cur));
      cycle.sort((a, b) => order.get(a)! - order.get(b)!);
      loops.push(cycle);
    }
  }
  loops.sort((a, b) => order.get(a[0]!)! - order.get(b[0]!)!);

  const defaultLine = files.filter((f) => f.state === "unlinked").map((f) => f.name);
  return {
    scan,
    parent,
    children,
    certainChildren,
    tips,
    openTips,
    absorbedBy,
    forks,
    loops,
    defaultLine,
    head: defaultLine[0] ?? null,
  };
}

export interface LineWalk {
  /** The tip first, then each ancestor; each file at most once. */
  readonly files: readonly string[];
  readonly end: "root" | "broken";
  readonly brokenTarget: string | null;
  readonly brokenReason: BrokenReason | "repeat" | null;
  /** True when any edge followed was provisional. */
  readonly provisional: boolean;
}

/**
 * Follows Parent from `start` until a root, a broken link or a repeat. The
 * walk keeps a visited set and is also bounded by the number of files in
 * the scan, so it terminates even if the visited set were wrong.
 */
export function walkLine(graph: LineageGraph, start: string): LineWalk {
  const visited = new Set<string>();
  const out: string[] = [];
  let provisional = false;
  let cur = start;
  const bound = graph.scan.files.length;
  for (let steps = 0; steps <= bound; steps++) {
    visited.add(cur);
    out.push(cur);
    const p = graph.parent.get(cur);
    if (!p || p.kind === "root") return { files: out, end: "root", brokenTarget: null, brokenReason: null, provisional };
    if (p.kind === "broken") return { files: out, end: "broken", brokenTarget: p.target, brokenReason: p.reason, provisional };
    if (visited.has(p.file)) return { files: out, end: "broken", brokenTarget: p.file, brokenReason: "repeat", provisional };
    if (!p.certain) provisional = true;
    cur = p.file;
  }
  return { files: out, end: "broken", brokenTarget: cur, brokenReason: "repeat", provisional };
}

// ---------------------------------------------------------------------------
// What `handover create` reports (plan 5.4)
// ---------------------------------------------------------------------------

export type LineageWarningCode =
  | "new_line_ignored" | "modifier_ignored" | "from_dropped" | "content_line_discarded"
  | "continues_invalid" | "parent_not_in_checkout" | "parent_unreadable"
  | "absorb_dropped" | "attribute_dropped" | "parser_check_failed" | "scan_incomplete" | "scan_failed";

export type AbsorbDropReason = "not_found" | "not_a_tip" | "is_parent" | "invalid" | "scan_incomplete";

export interface LineageWarning {
  readonly code: LineageWarningCode;
  /** A filename, only when it passed the value rule. A failed value is never carried. */
  readonly target: string | null;
  readonly detail: string | null;
}

/** The `lineage` key of a create reply. Every field describes what was persisted. */
export interface CreateLineageResult {
  readonly linked: boolean;
  readonly continues: string | null;
  readonly from: string | null;
  readonly absorbs: readonly string[];
  readonly role: string | null;
  readonly at: string | null;
  readonly by: string | null;
  readonly forkChildren: readonly string[];
  readonly warnings: readonly LineageWarning[];
}

// ---------------------------------------------------------------------------
// What `handover lines` reports (plan 6)
// ---------------------------------------------------------------------------

export interface LinesDefaultLine {
  readonly head: string;
  readonly length: number;
  /** True when any edge of the default chain crosses an unreadable entry. */
  readonly provisional: boolean;
  /** Linked handovers that continue the head, in listing order. */
  readonly continuedBy: readonly string[];
}

export interface LinesRow {
  readonly tip: string;
  readonly role: string | null;
  readonly by: string | null;
  readonly date: string | null;
  readonly length: number;
  readonly open: boolean;
  readonly absorbedBy: readonly string[];
  readonly forkedAt: readonly string[];
  readonly end: "root" | "broken";
  readonly brokenTarget: string | null;
  readonly brokenReason: BrokenReason | "repeat" | null;
}

export interface LinesBrokenLink {
  readonly file: string;
  readonly attribute: "continues" | "from" | "absorbs";
  readonly target: string | null;
  readonly reason: BrokenReason;
}

/** The `handover lines` view. Keys are never omitted; null where there is no value. */
export interface LinesView {
  readonly enumerated: boolean;
  readonly complete: boolean;
  readonly defaultLine: LinesDefaultLine | null;
  readonly lines: readonly LinesRow[];
  readonly forks: readonly { readonly parent: string; readonly children: readonly string[] }[];
  readonly brokenLinks: readonly LinesBrokenLink[];
  readonly loops: readonly (readonly string[])[];
  readonly unreadable: readonly { readonly file: string; readonly reason: UnknownReason }[];
}

/**
 * Builds the lines view from a scan. Pure: `dateOf` gives a handover's date
 * from its filename, or null. Rows: each open linked tip, and with `all`
 * every absorbed tip, in listing order. The default line's head is shown by
 * the default line itself, never as a row of its own while it is open.
 */
export function buildLinesView(
  scan: LineageScan,
  all: boolean,
  dateOf: (name: string) => string | null,
): LinesView {
  if (!scan.enumerated) {
    return { enumerated: false, complete: false, defaultLine: null, lines: [], forks: [], brokenLinks: [], loops: [], unreadable: [] };
  }
  const graph = buildLineageGraph(scan);
  const byName = new Map<string, ScannedFile>();
  for (const f of scan.files) if (!byName.has(f.name)) byName.set(f.name, f);
  const forkParents = new Set(graph.forks.map((f) => f.parent));

  let defaultLine: LinesDefaultLine | null = null;
  if (graph.head !== null) {
    const provisional = graph.defaultLine.some((n) => {
      const p = graph.parent.get(n);
      return p !== undefined && p.kind === "file" && !p.certain;
    });
    const continuedBy = (graph.children.get(graph.head) ?? []).filter((c) => byName.get(c)?.state === "linked");
    defaultLine = { head: graph.head, length: graph.defaultLine.length, provisional, continuedBy };
  }

  const open = new Set(graph.openTips);
  const lines: LinesRow[] = [];
  for (const tip of graph.tips) {
    const f = byName.get(tip)!;
    const isOpen = open.has(tip);
    if (isOpen ? f.state !== "linked" : !all) continue;
    const walk = walkLine(graph, tip);
    const l = f.state === "linked" ? f.lineage!.lineage : null;
    lines.push({
      tip,
      role: l?.role ?? null,
      by: l?.by ?? null,
      date: dateOf(tip),
      length: walk.files.length,
      open: isOpen,
      absorbedBy: [...(graph.absorbedBy.get(tip) ?? [])],
      forkedAt: walk.files.slice(1).filter((n) => forkParents.has(n)),
      end: walk.end,
      brokenTarget: walk.brokenTarget,
      brokenReason: walk.brokenReason,
    });
  }

  const reference = (owner: string, target: string): BrokenReason | null => {
    if (target === owner) return "self";
    const t = byName.get(target);
    if (t === undefined) return "missing";
    return t.state === "unknown" ? "unreadable" : null;
  };
  const brokenLinks: LinesBrokenLink[] = [];
  for (const f of scan.files) {
    if (f.state !== "linked" || byName.get(f.name) !== f) continue;
    const p = graph.parent.get(f.name);
    if (p !== undefined && p.kind === "broken") {
      brokenLinks.push({ file: f.name, attribute: "continues", target: p.target, reason: p.reason });
    }
    const l = f.lineage!.lineage;
    if (l.from !== null) {
      const r = reference(f.name, l.from);
      if (r !== null) brokenLinks.push({ file: f.name, attribute: "from", target: l.from, reason: r });
    }
    for (const a of l.absorbs) {
      const r = reference(f.name, a);
      if (r !== null) brokenLinks.push({ file: f.name, attribute: "absorbs", target: a, reason: r });
    }
  }

  return {
    enumerated: true,
    complete: scan.complete,
    defaultLine,
    lines,
    forks: graph.forks.map((f) => ({ parent: f.parent, children: [...f.children] })),
    brokenLinks,
    loops: graph.loops.map((l) => [...l]),
    unreadable: scan.files.filter((f) => f.state === "unknown").map((f) => ({ file: f.name, reason: f.reason! })),
  };
}
