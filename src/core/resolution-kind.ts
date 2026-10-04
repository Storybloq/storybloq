/**
 * T-486: why an issue was closed, and the evidence behind a disposition, read
 * through one projection each.
 *
 * Both facts are stored as plain passthrough keys that older clients load,
 * preserve and never update. An older CLI that reopens and re-closes an issue
 * leaves the old `resolutionKind` behind; an older driver that merges a
 * disposition change from one branch with evidence written on another
 * combines them. So the stored keys are never read directly. Each carries the
 * facts it was written against, and it counts only while those facts still
 * hold:
 *
 *  - `resolutionKind` binds to the closure: `closedOn` must equal
 *    `resolvedDate` and `resolutionDigest` must match the resolution text.
 *  - `dispositionReason`/`dispositionRef` bind to `dispositionFor`, which must
 *    equal the current `disposition`.
 *
 * The load schema accepts ANY value for these keys (models/issue.ts). A shape
 * refused at load would drop the whole issue from state and refuse every
 * strict write on the board, so a hand edit or a bad merge could brick it.
 * The strict shapes below are used only here and at the write boundary.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { DateSchema } from "../models/types.js";
import { IssueDispositionSchema } from "../models/issue.js";

/** Every resolution kind. `withdrawn` is the one ticket kind (T-486 U2). */
export const RESOLUTION_KINDS = [
  "fixed",
  "wontfix",
  "duplicate",
  "superseded",
  "not_reproducible",
  "withdrawn",
] as const;

/** The kinds an issue may carry. */
export const ISSUE_RESOLUTION_KINDS = [
  "fixed",
  "wontfix",
  "duplicate",
  "superseded",
  "not_reproducible",
] as const;

export type IssueResolutionKind = (typeof ISSUE_RESOLUTION_KINDS)[number];

export const IssueResolutionKindShape = z
  .object({
    kind: z.enum(ISSUE_RESOLUTION_KINDS),
    closedOn: DateSchema,
    resolutionDigest: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .passthrough();

export const DispositionEvidenceShape = z.object({
  dispositionReason: z.string().min(1),
  dispositionRef: z.string().min(1),
  dispositionFor: IssueDispositionSchema,
});

export type ResolutionKindState = "effective" | "absent" | "stale" | "malformed" | "wrong-entity";
export type DispositionEvidenceState = "effective" | "absent" | "unbound" | "malformed";

export interface ResolutionKindView {
  readonly kind: IssueResolutionKind | null;
  readonly state: ResolutionKindState;
}

export interface DispositionEvidenceView {
  readonly reason: string | null;
  readonly ref: string | null;
  readonly state: DispositionEvidenceState;
}

/** First 16 hex characters of sha256 over the UTF-8 resolution text ("" when null). */
export function resolutionDigest(resolution: string | null | undefined): string {
  return createHash("sha256").update(resolution ?? "", "utf8").digest("hex").slice(0, 16);
}

type Loose = Readonly<Record<string, unknown>>;

export function resolutionKindView(issue: Loose): ResolutionKindView {
  if (!Object.prototype.hasOwnProperty.call(issue, "resolutionKind")) {
    return { kind: null, state: "absent" };
  }
  const raw = issue.resolutionKind;
  const parsed = IssueResolutionKindShape.safeParse(raw);
  if (!parsed.success) {
    const isRecord = typeof raw === "object" && raw !== null && !Array.isArray(raw);
    const wrongEntity = isRecord && (raw as Loose).kind === "withdrawn";
    return { kind: null, state: wrongEntity ? "wrong-entity" : "malformed" };
  }
  // A hand-edited file can carry a non-string resolution. It cannot match any
  // digest, so the kind does not count; hashing it would throw.
  const resolution = issue.resolution;
  if (resolution !== null && resolution !== undefined && typeof resolution !== "string") {
    return { kind: null, state: "stale" };
  }
  const bound =
    issue.status === "resolved" &&
    parsed.data.closedOn === issue.resolvedDate &&
    parsed.data.resolutionDigest === resolutionDigest(resolution);
  return bound ? { kind: parsed.data.kind, state: "effective" } : { kind: null, state: "stale" };
}

/** The effective kind, or null. */
export function effectiveResolutionKind(issue: Loose): IssueResolutionKind | null {
  return resolutionKindView(issue).kind;
}

const EVIDENCE_KEYS = ["dispositionReason", "dispositionRef", "dispositionFor"] as const;

export function dispositionEvidenceView(issue: Loose): DispositionEvidenceView {
  const present = EVIDENCE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(issue, k));
  if (!present) return { reason: null, ref: null, state: "absent" };
  const parsed = DispositionEvidenceShape.safeParse({
    dispositionReason: issue.dispositionReason,
    dispositionRef: issue.dispositionRef,
    dispositionFor: issue.dispositionFor,
  });
  if (!parsed.success) return { reason: null, ref: null, state: "malformed" };
  if (parsed.data.dispositionFor !== issue.disposition) return { reason: null, ref: null, state: "unbound" };
  return { reason: parsed.data.dispositionReason, ref: parsed.data.dispositionRef, state: "effective" };
}

/**
 * Keys reserved for JSON output (T-486 A6). `effective` carries the derived
 * views beside the loaded record: the stored fields plus the loader-derived
 * `displayId` on a legacy display-id file. When a record already uses either
 * name, the response returns the untouched loaded record under `stored`
 * instead of spreading it, so no stored value is overwritten or hidden.
 */
export const RESERVED_RESPONSE_KEYS = ["effective", "stored"] as const;

export interface IssueEffectiveJson {
  readonly resolutionKind: IssueResolutionKind | null;
  readonly resolutionKindState: ResolutionKindState;
  readonly dispositionEvidence: { readonly reason: string; readonly ref: string } | null;
  readonly dispositionEvidenceState: DispositionEvidenceState;
}

/** The derived values every JSON surface reports beside the loaded record. */
export function issueEffectiveJson(issue: Loose): IssueEffectiveJson {
  const kind = resolutionKindView(issue);
  const evidence = dispositionEvidenceView(issue);
  return {
    resolutionKind: kind.kind,
    resolutionKindState: kind.state,
    dispositionEvidence: evidence.state === "effective" ? { reason: evidence.reason!, ref: evidence.ref! } : null,
    dispositionEvidenceState: evidence.state,
  };
}

/**
 * One issue as a JSON response body: the loaded record (the stored fields
 * plus the loader-derived `displayId` on a legacy display-id file), any
 * caller extras, and `effective`. A record that already uses a reserved name
 * is returned untouched under `stored` rather than spread, so neither its
 * value nor the derived one is lost.
 */
export function issueJsonBody(issue: Loose, extras: Record<string, unknown> = {}): Record<string, unknown> {
  const effective = issueEffectiveJson(issue);
  const collides = RESERVED_RESPONSE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(issue, k));
  return collides ? { stored: issue, ...extras, effective } : { ...issue, ...extras, effective };
}

/** `resolved (wontfix)` when the kind is effective, else the bare status. */
export function issueStatusLabel(issue: Loose): string {
  const kind = effectiveResolutionKind(issue);
  return kind ? `${String(issue.status)} (${kind})` : String(issue.status);
}
