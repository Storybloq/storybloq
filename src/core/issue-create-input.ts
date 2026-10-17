/**
 * The create input for an issue and the three checks every writer of one must
 * apply, in the order `handleIssueCreate` applies them (severity, then, after
 * the caller's own citation check, the dedupe key; the phase only once the
 * ledger is locked). Neutral on purpose: the CLI command and the
 * autonomous recovery-record preparer both consume it, and neither may
 * define it in terms of the other (ISS-1221).
 */
import { ISSUE_SEVERITIES, type IssueSeverity } from "../models/types.js";
import {
  IssueDedupeKeySchema,
  IssueDispositionSchema,
  ISSUE_DISPOSITIONS,
  type IssueSourceRefInput,
} from "../models/issue.js";
import type { ProjectState } from "./project-state.js";

export interface IssueCreateInput {
  title: string;
  severity: string;
  impact: string;
  components: string[];
  relatedTickets: string[];
  location: string[];
  sourceRefs?: IssueSourceRefInput[];
  dedupeKey?: string;
  createdBy?: string;
  /**
   * `undefined` means "not supplied, infer it"; `null` means "resolved to no
   * phase at preparation time, write none". The distinction is what lets a
   * prepared recovery record be written exactly as it was fingerprinted.
   */
  phase?: string | null;
  citesRuling?: string[];
  /** T-481: validated against the enums before the lock; waitingOn "none" stores nothing. */
  priority?: string;
  waitingOn?: string;
  /**
   * ISS-1113: the reason this issue is not work, set by the path that FILES
   * it. Validated against `IssueSchema`'s enum before the ledger lock, the
   * same way severity is, so a bad value is refused rather than written and
   * then rejected at load.
   *
   * Omitted means actionable, and the writer omits the FIELD entirely in that
   * case. An issue filed today must stay byte-identical to one filed
   * yesterday, which `disposition: null` on every record would not be.
   */
  disposition?: string;
  /**
   * ISS-1113: passthrough provenance, written under `metadata.review` by the
   * review filing paths (origin, review/session id, the finding's own
   * disposition). `IssueSchema` is `.passthrough()` so this needs no schema
   * change, but the WRITER still has to emit it -- the issue literal in
   * `handleIssueCreate` builds a fixed field list and drops anything it does
   * not name.
   */
  metadata?: Record<string, unknown>;
}

/** One refused field, named the way the writer names it in its invalid_input message. */
export interface IssueCreateRefusal {
  readonly field: "severity" | "dedupeKey" | "phase" | "disposition" | "metadata";
  readonly message: string;
}

export function validateIssueCreateSeverity(input: Pick<IssueCreateInput, "severity">): IssueCreateRefusal | null {
  if (ISSUE_SEVERITIES.includes(input.severity as IssueSeverity)) return null;
  return {
    field: "severity",
    message: `Unknown issue severity "${input.severity}": must be one of ${ISSUE_SEVERITIES.join(", ")}`,
  };
}

/**
 * ISS-1113: refused pre-lock, beside severity, and against the SCHEMA's enum
 * rather than a second copy of the list -- a value this accepted and the
 * schema refused would be written and then dropped at load, which is worse
 * than either check alone.
 */
export function validateIssueCreateDisposition(
  input: Pick<IssueCreateInput, "disposition">,
): IssueCreateRefusal | null {
  if (input.disposition === undefined) return null;
  const parsed = IssueDispositionSchema.safeParse(input.disposition);
  if (parsed.success) return null;
  return {
    field: "disposition",
    message: `Unknown issue disposition "${input.disposition}": must be one of ${ISSUE_DISPOSITIONS.join(", ")}`,
  };
}

/**
 * ISS-1113: `metadata` is written into a `.passthrough()` schema, so nothing
 * downstream would refuse an array or a primitive -- it would simply land in
 * the ledger and every later reader would have to defend against it. Refused
 * here instead, at the same boundary as the other three, because a bag whose
 * shape is never checked is a bag whose shape is eventually wrong.
 *
 * Only the TOP level is checked. The contents are deliberately unconstrained:
 * that is the entire point of a passthrough bag shared with writers this
 * module knows nothing about.
 */
export function validateIssueCreateMetadata(
  input: Pick<IssueCreateInput, "metadata">,
): IssueCreateRefusal | null {
  if (input.metadata === undefined) return null;
  const value: unknown = input.metadata;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return null;
  return {
    field: "metadata",
    message: `Issue metadata must be an object, received ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`,
  };
}

export function validateIssueCreateDedupeKey(input: Pick<IssueCreateInput, "dedupeKey">): IssueCreateRefusal | null {
  if (input.dedupeKey === undefined) return null;
  const parsed = IssueDedupeKeySchema.safeParse(input.dedupeKey);
  if (parsed.success) return null;
  return { field: "dedupeKey", message: parsed.error.issues.map((issue) => issue.message).join("; ") };
}

/**
 * Truthy on purpose, not non-null: an empty string is not validated here,
 * exactly as before ISS-1221, and is refused later by write validation.
 */
export function validateIssueCreatePhase(state: ProjectState, phase: string | null | undefined): IssueCreateRefusal | null {
  if (phase && !state.roadmap.phases.some((p) => p.id === phase)) {
    return { field: "phase", message: `Phase "${phase}" not found in roadmap` };
  }
  return null;
}
