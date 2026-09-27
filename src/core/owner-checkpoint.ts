/**
 * T-537: owner checkpoints. A checkpoint is an ordinary ticket carrying an
 * `ownerCheckpoint` record; dependents wait on it through `blockedBy`. This
 * module holds the model, the canonical digest and the release and
 * reassessment predicates. The Mac app's `OwnerCheckpoint.swift` carries the
 * same logic and pins it against `test/fixtures/owner-checkpoint-vectors.json`,
 * generated from this file by `scripts/owner-checkpoint-vectors.ts`.
 *
 * Both ticket fields are read leniently: a value that does not parse is
 * UNRECOGNIZED, which keeps the ticket loadable and never releases. JSON null
 * counts as present, so nulling the field cannot release a checkpoint.
 */
import { z } from "zod";
import { canonicalHash } from "../bus/canonical.js";
import type { Ticket } from "../models/ticket.js";
import { RulingIdSchema } from "../models/types.js";
import type { ResolveResult } from "./resolver.js";

export const CHECKPOINT_KINDS = ["decision", "acceptance"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const CHECKPOINT_LIFECYCLES = ["active", "retired"] as const;

export const CHECKPOINT_EVENTS = [
  "created",
  "resolved",
  "changed",
  "reopened",
  "retired",
  "retirement-adopted",
  "conflict-resolved",
] as const;
export type CheckpointEvent = (typeof CHECKPOINT_EVENTS)[number];

/** History events a legacy completion survives (reassessment row 3b): each is a release or preserves one. */
export const RELEASE_PRESERVING_EVENTS: ReadonlySet<CheckpointEvent> = new Set([
  "created",
  "resolved",
  "retired",
  "retirement-adopted",
  "conflict-resolved",
]);

/** The largest revision or generation: beyond it JS numbers stop being exact, so increments would collide. */
export const MAX_CHECKPOINT_COUNTER = Number.MAX_SAFE_INTEGER;

const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Counter = z.number().int().min(1).max(MAX_CHECKPOINT_COUNTER);

/**
 * Ill-formed reviewed text: a lone UTF-16 surrogate (`canonicalJson` refuses
 * it, so it must never reach the digest) or U+FFFD, which is what the Mac
 * app's JSON decoder substitutes for one. Refusing both keeps the two
 * languages in agreement: text the CLI cannot hash is never text the app
 * accepts.
 * Rule (pen ruling, T-537): cross-language digest agreement outranks a legitimate U+FFFD in reviewed text.
 */
const REPLACEMENT_CHARACTER = "\uFFFD";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const isWellFormedText = (s: string): boolean => !LONE_SURROGATE.test(s) && !s.includes(REPLACEMENT_CHARACTER);
const NonEmpty = z.string().min(1);

export const CheckpointResolutionSchema = z
  .object({
    response: NonEmpty,
    respondedBy: NonEmpty,
    respondedAt: NonEmpty,
    artifactRef: NonEmpty.optional(),
    rulingId: RulingIdSchema.optional(),
    revision: Counter,
    digest: Digest,
    generation: Counter,
  })
  .passthrough();
export type CheckpointResolution = z.infer<typeof CheckpointResolutionSchema>;

export const CheckpointHistoryEntrySchema = z
  .object({
    event: z.enum(CHECKPOINT_EVENTS),
    // The reviewed content as of the event; `kind` is part of the digest, so
    // the snapshot carries it to reconstruct the digest after a change.
    kind: z.enum(CHECKPOINT_KINDS),
    at: NonEmpty,
    by: NonEmpty,
    generation: Counter,
    revision: Counter,
    digest: Digest,
    question: z.string().optional(),
    criteria: z.string().optional(),
    evidenceRefs: z.array(z.string()),
    resolution: CheckpointResolutionSchema.optional(),
    reason: z.string().optional(),
    discarded: z.unknown().optional(),
  })
  .passthrough();
export type CheckpointHistoryEntry = z.infer<typeof CheckpointHistoryEntrySchema>;

export const OwnerCheckpointSchema = z
  .object({
    kind: z.enum(CHECKPOINT_KINDS),
    owner: NonEmpty,
    question: z.string().optional(),
    criteria: z.string().optional(),
    evidenceRefs: z.array(z.string()),
    lifecycle: z.enum(CHECKPOINT_LIFECYCLES),
    retiredAt: NonEmpty.optional(),
    revision: Counter,
    digest: Digest,
    generation: Counter,
    resolution: CheckpointResolutionSchema.optional(),
    history: z.array(CheckpointHistoryEntrySchema),
  })
  .passthrough()
  .superRefine((cp, ctx) => {
    if (cp.kind === "decision" && !cp.question) ctx.addIssue({ code: "custom", message: "a decision checkpoint needs a question" });
    if (cp.kind === "acceptance" && !cp.criteria) ctx.addIssue({ code: "custom", message: "an acceptance checkpoint needs criteria" });
    if (cp.lifecycle === "retired" && !cp.retiredAt) ctx.addIssue({ code: "custom", message: "a retired checkpoint needs retiredAt" });
    if (cp.lifecycle === "active" && cp.retiredAt !== undefined) ctx.addIssue({ code: "custom", message: "an active checkpoint has no retiredAt" });
    // The digest covers these strings; ill-formed text makes the checkpoint unrecognized instead of making hashing throw.
    for (const text of [cp.question, cp.criteria, ...cp.evidenceRefs]) {
      if (text !== undefined && !isWellFormedText(text)) ctx.addIssue({ code: "custom", message: "reviewed content holds a lone UTF-16 surrogate or U+FFFD" });
    }
  });
export type OwnerCheckpoint = z.infer<typeof OwnerCheckpointSchema>;

export const CheckpointEvidenceEntrySchema = z
  .object({
    checkpoint: NonEmpty,
    generation: Counter,
    revision: Counter,
    digest: Digest,
    state: z.enum(["approved", "retired"]),
  })
  .passthrough();
export type CheckpointEvidenceEntry = z.infer<typeof CheckpointEvidenceEntrySchema>;
export const CheckpointEvidenceSchema = z.array(CheckpointEvidenceEntrySchema);

// --- digest ------------------------------------------------------------------------

/** The reviewed content a digest covers. */
export interface CheckpointContent {
  readonly kind: string;
  readonly question?: string | null;
  readonly criteria?: string | null;
  readonly evidenceRefs: readonly string[];
}

/**
 * The canonical projection: `{kind, question, criteria, evidenceRefs}`, a
 * missing or null value omitted, evidenceRefs in their given order, every
 * string NFC-normalised.
 */
export function checkpointProjection(content: CheckpointContent): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: content.kind.normalize("NFC") };
  if (content.question !== undefined && content.question !== null) out.question = content.question.normalize("NFC");
  if (content.criteria !== undefined && content.criteria !== null) out.criteria = content.criteria.normalize("NFC");
  out.evidenceRefs = content.evidenceRefs.map((r) => r.normalize("NFC"));
  return out;
}

/** sha256 (hex) of the projection serialised by `canonicalJson` (RFC 8785: sorted keys). */
export function checkpointDigest(content: CheckpointContent): string {
  return canonicalHash(checkpointProjection(content));
}

// --- lenient reads -----------------------------------------------------------------

export type ParsedCheckpoint =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly checkpoint: OwnerCheckpoint }
  | { readonly kind: "unrecognized"; readonly reason: string };

/** True when the ticket carries the field at all (any value, null included). */
export function hasOwnerCheckpoint(ticket: object): boolean {
  return Object.prototype.hasOwnProperty.call(ticket, "ownerCheckpoint") && (ticket as Record<string, unknown>).ownerCheckpoint !== undefined;
}

export function parseOwnerCheckpoint(ticket: object): ParsedCheckpoint {
  if (!hasOwnerCheckpoint(ticket)) return { kind: "absent" };
  const parsed = OwnerCheckpointSchema.safeParse((ticket as Record<string, unknown>).ownerCheckpoint);
  if (!parsed.success) return { kind: "unrecognized", reason: parsed.error.issues.map((i) => `${i.path.join(".") || "ownerCheckpoint"}: ${i.message}`).join("; ") };
  return { kind: "ok", checkpoint: parsed.data };
}

export type ParsedEvidence =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly entries: readonly CheckpointEvidenceEntry[] }
  | { readonly kind: "malformed" };

export function parseCheckpointEvidence(ticket: object): ParsedEvidence {
  const raw = (ticket as Record<string, unknown>).checkpointEvidence;
  if (raw === undefined) return { kind: "absent" };
  const parsed = CheckpointEvidenceSchema.safeParse(raw);
  return parsed.success ? { kind: "ok", entries: parsed.data } : { kind: "malformed" };
}

// --- predicates --------------------------------------------------------------------

type CheckpointTicket = Pick<Ticket, "id" | "status"> & { readonly lifecycle?: unknown };

/** A ticket archived or soft-deleted (ticket lifecycle, not the checkpoint's) never releases. */
const softDeleted = (t: { lifecycle?: unknown }): boolean => t.lifecycle != null && t.lifecycle !== "active";

/**
 * Approved: lifecycle active, status complete, a resolution whose generation,
 * revision and digest equal the current values, the stored digest equal to
 * the one recomputed from the current content, and (for acceptance) a
 * reviewed artifact.
 */
export function checkpointApproved(ticket: CheckpointTicket): boolean {
  if (softDeleted(ticket)) return false;
  const p = parseOwnerCheckpoint(ticket);
  if (p.kind !== "ok") return false;
  const cp = p.checkpoint;
  const r = cp.resolution;
  if (cp.lifecycle !== "active" || ticket.status !== "complete" || r === undefined) return false;
  if (r.generation !== cp.generation || r.revision !== cp.revision || r.digest !== cp.digest) return false;
  if (checkpointDigest(cp) !== cp.digest) return false;
  return cp.kind !== "acceptance" || r.artifactRef !== undefined;
}

export function checkpointRetired(ticket: CheckpointTicket): boolean {
  if (softDeleted(ticket)) return false;
  const p = parseOwnerCheckpoint(ticket);
  return p.kind === "ok" && p.checkpoint.lifecycle === "retired";
}

/** Approved OR retired. An unrecognized, malformed, archived or soft-deleted checkpoint never releases. */
export function checkpointReleases(ticket: CheckpointTicket): boolean {
  return checkpointApproved(ticket) || checkpointRetired(ticket);
}

export type CheckpointDisplayState = "approved" | "retired" | "pending" | "unrecognized";

export function checkpointState(ticket: CheckpointTicket): CheckpointDisplayState | null {
  const p = parseOwnerCheckpoint(ticket);
  if (p.kind === "absent") return null;
  if (p.kind === "unrecognized" || softDeleted(ticket)) return "unrecognized";
  if (checkpointApproved(ticket)) return "approved";
  if (checkpointRetired(ticket)) return "retired";
  return "pending";
}

/** What the predicates need from a project: resolving a blockedBy ref. */
export interface CheckpointResolver {
  resolveTicketRef(ref: string): ResolveResult<Ticket>;
}

/** blockedBy entries that are checkpoints and do not release, as their canonical ids. */
export function pendingCheckpointBlockers(resolver: CheckpointResolver, ticket: Pick<Ticket, "blockedBy">): string[] {
  const out: string[] = [];
  for (const ref of ticket.blockedBy) {
    const r = resolver.resolveTicketRef(ref);
    if (r.kind === "found" && hasOwnerCheckpoint(r.item) && !checkpointReleases(r.item)) out.push(r.item.id);
  }
  return out;
}

// --- reassessment ------------------------------------------------------------------

export type ReassessmentRow = "1" | "2a" | "2b" | "2c" | "3a" | "3b" | "3c";

export interface ReassessmentVerdict {
  /** The checkpoint as referenced (canonical id when it resolves). */
  readonly checkpoint: string;
  readonly row: ReassessmentRow;
  readonly flag: boolean;
}

/**
 * For a completed ticket, one verdict per checkpoint it depended on: every
 * blockedBy entry that resolves to a checkpoint, plus every checkpoint named in
 * its evidence. The rows are ordered and exhaustive; the first match decides:
 *
 * 1  checkpoint unrecognized, malformed, archived, soft-deleted or unresolvable: FLAG
 * 2a evidence approved, checkpoint approved, generation/revision/digest current: CLEAR
 * 2b evidence retired, checkpoint retired, evidence generation = current generation: CLEAR
 * 2c evidence present, anything else (malformed evidence included): FLAG
 * 3a no evidence entry, history holds `changed` or `reopened`: FLAG
 * 3b no evidence entry, every history event release-preserving, checkpoint releases: CLEAR
 * 3c no evidence entry, anything else: FLAG
 *
 * Nothing compares timestamps. A flag clears only by re-completion, which writes new evidence.
 */
export function reassessCheckpoints(resolver: CheckpointResolver, ticket: Ticket): ReassessmentVerdict[] {
  if (ticket.status !== "complete") return [];
  const evidence = parseCheckpointEvidence(ticket);
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (key: string, ref: string) => {
    if (!seen.has(key)) { seen.add(key); refs.push(ref); }
  };
  for (const ref of ticket.blockedBy) {
    const r = resolver.resolveTicketRef(ref);
    if (r.kind === "found" && hasOwnerCheckpoint(r.item)) add(r.item.id, ref);
  }
  if (evidence.kind === "ok") {
    for (const e of evidence.entries) {
      const r = resolver.resolveTicketRef(e.checkpoint);
      add(r.kind === "found" ? r.item.id : `?${e.checkpoint}`, e.checkpoint);
    }
  }
  return refs.map((ref) => reassessOne(resolver, ref, evidence));
}

function reassessOne(resolver: CheckpointResolver, ref: string, evidence: ParsedEvidence): ReassessmentVerdict {
  const r = resolver.resolveTicketRef(ref);
  if (r.kind !== "found") return { checkpoint: ref, row: "1", flag: true };
  const item = r.item;
  const p = parseOwnerCheckpoint(item);
  if (p.kind !== "ok" || softDeleted(item)) return { checkpoint: item.id, row: "1", flag: true };
  const cp = p.checkpoint;
  const verdict = (row: ReassessmentRow, flag: boolean): ReassessmentVerdict => ({ checkpoint: item.id, row, flag });

  if (evidence.kind === "malformed") return verdict("2c", true);
  const entry = evidence.kind === "ok"
    ? evidence.entries.find((e) => {
        const er = resolver.resolveTicketRef(e.checkpoint);
        return er.kind === "found" && er.item.id === item.id;
      })
    : undefined;

  if (entry !== undefined) {
    if (entry.state === "approved" && checkpointApproved(item) && entry.generation === cp.generation && entry.revision === cp.revision && entry.digest === cp.digest) return verdict("2a", false);
    if (entry.state === "retired" && checkpointRetired(item) && entry.generation === cp.generation) return verdict("2b", false);
    return verdict("2c", true);
  }
  if (cp.history.some((h) => h.event === "changed" || h.event === "reopened")) return verdict("3a", true);
  if (cp.history.every((h) => RELEASE_PRESERVING_EVENTS.has(h.event)) && checkpointReleases(item)) return verdict("3b", false);
  return verdict("3c", true);
}

/** True when any checkpoint the completed ticket depended on flags. */
export function needsReassessment(resolver: CheckpointResolver, ticket: Ticket): boolean {
  return reassessCheckpoints(resolver, ticket).some((v) => v.flag);
}
