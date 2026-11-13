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
/**
 * RED commit stub: every function throws. The implementation lands in commit 2.
 */
/** The tail rule reads at most this many final bytes. */
export const LINEAGE_TAIL_BYTES = 2048;

/** A lineage line is at most this many bytes. */
export const LINEAGE_MAX_LINE_BYTES = 1024;

/** At most this many `absorbs` values are kept. */
export const LINEAGE_MAX_ABSORBS = 8;

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

export function isLineageFileValue(value: string): boolean {
  void value;
  throw new Error("ISS-1499: isLineageFileValue is not implemented in the RED commit");
}

export function isLineageRoleValue(value: string): boolean {
  void value;
  throw new Error("ISS-1499: isLineageRoleValue is not implemented in the RED commit");
}

export function isLineageByValue(value: string): boolean {
  void value;
  throw new Error("ISS-1499: isLineageByValue is not implemented in the RED commit");
}

export function isLineageAtValue(value: string): boolean {
  void value;
  throw new Error("ISS-1499: isLineageAtValue is not implemented in the RED commit");
}

export function parseLineageLine(line: string): ParsedLineage | null {
  void line;
  throw new Error("ISS-1499: parseLineageLine is not implemented in the RED commit");
}

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

export function serializeLineage(
  input: LineageInput,
  /**
   * The size limit. Only tests pass a smaller one: with valid values a line
   * without absorbs is at most 812 bytes, so at 1,024 the later steps of the
   * drop order are a guarantee, not a path the default limit reaches.
   */
  maxBytes: number = LINEAGE_MAX_LINE_BYTES,
): SerializedLineage {
  void input;
  throw new Error("ISS-1499: serializeLineage is not implemented in the RED commit");
}

export type TailResult =
  | { readonly kind: "linked"; readonly parsed: ParsedLineage; readonly lineStart: number }
  | { readonly kind: "unlinked"; readonly nearMiss: boolean };

export function readLineageTail(tail: Buffer, whole: boolean): TailResult {
  void tail;
  void whole;
  throw new Error("ISS-1499: readLineageTail is not implemented in the RED commit");
}

export function readLineage(content: string): TailResult {
  void content;
  throw new Error("ISS-1499: readLineage is not implemented in the RED commit");
}

export interface SplitLineage {
  /** The content with every lineage line removed; `content` itself when unlinked. */
  readonly body: string;
  /** The effective lineage: the one from the content's final line. */
  readonly lineage: ParsedLineage | null;
  /** Earlier stacked lineage lines that were also removed, nearest first. */
  readonly discarded: readonly ParsedLineage[];
}

export function splitLineage(content: string): SplitLineage {
  void content;
  throw new Error("ISS-1499: splitLineage is not implemented in the RED commit");
}

export function appendLineage(body: string, line: string): string {
  void body;
  void line;
  throw new Error("ISS-1499: appendLineage is not implemented in the RED commit");
}

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

export function buildLineageGraph(scan: LineageScan): LineageGraph {
  void scan;
  throw new Error("ISS-1499: buildLineageGraph is not implemented in the RED commit");
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

export function walkLine(graph: LineageGraph, start: string): LineWalk {
  void graph;
  void start;
  throw new Error("ISS-1499: walkLine is not implemented in the RED commit");
}
