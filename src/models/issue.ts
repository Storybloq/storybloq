import { z } from "zod";
import {
  ISSUE_STATUSES,
  ISSUE_SEVERITIES,
  LIFECYCLE_VALUES,
  DateSchema,
  TimestampSchema,
  IssueIdSchema,
  TicketIdSchema,
  ConflictEntrySchema,
  EarmarkSchema,
  RulingIdSchema,
} from "./types.js";

const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const REVISION_PATTERN = /^[a-f0-9]{4,64}$/i;

function hasNoControlCharacters(value: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(value);
}

function isSafeSourcePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) return false;
  if (!hasNoControlCharacters(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function opaqueId(max: number) {
  return z.string().min(1).max(max).refine(
    hasNoControlCharacters,
    "Value must not contain control characters",
  );
}

const IssueSourceRefObjectSchema = z.object({
  path: z.string().min(1).max(1024).refine(isSafeSourcePath, "Source path must be a safe repo-relative POSIX path"),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  revision: z.string().regex(REVISION_PATTERN, "Revision must be a hexadecimal Git object ID").optional(),
  snapshotId: opaqueId(256).optional(),
  contentHash: z.string().regex(SOURCE_HASH_PATTERN, "Content hash must be a SHA-256 hex digest").optional(),
  reviewId: opaqueId(256).optional(),
});

function validateSourceRefRange(
  ref: z.infer<typeof IssueSourceRefObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  if (ref.endLine !== undefined && ref.endLine < ref.startLine) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endLine"],
      message: "End line must be greater than or equal to start line",
    });
  }
}

/** Input shape accepted at write boundaries before Storybloq captures a hash. */
export const IssueSourceRefInputSchema = IssueSourceRefObjectSchema
  .strict()
  .superRefine(validateSourceRefRange);

/** Durable source reference. A revision or captured line-range hash is required. */
export const IssueSourceRefSchema = IssueSourceRefObjectSchema
  .passthrough()
  .superRefine(validateSourceRefRange)
  .superRefine((ref, ctx) => {
    if (!ref.revision && !ref.contentHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentHash"],
        message: "A durable source reference requires revision or contentHash",
      });
    }
  });

export type IssueSourceRefInput = z.input<typeof IssueSourceRefInputSchema>;
export type IssueSourceRef = z.infer<typeof IssueSourceRefSchema>;

export const IssueDedupeKeySchema = opaqueId(512);

/**
 * ISS-1154, extended by ISS-1113. See the field comment on `IssueSchema`.
 *
 * Named and exported because the create path validates against it BEFORE the
 * ledger lock, beside severity: a disposition this schema would refuse must be
 * rejected at the boundary rather than written and then dropped at load. One
 * enum, two checks, no second copy of the list.
 */
export const ISSUE_DISPOSITIONS = [
  "escalate_only",
  "owner_gated",
  "duplicate",
  "pre_existing",
  "accepted_out_of_scope",
  "forced_landing",
] as const;

export const IssueDispositionSchema = z.enum(ISSUE_DISPOSITIONS);

export type IssueDisposition = z.infer<typeof IssueDispositionSchema>;

export const IssueSchema = z
  .object({
    id: IssueIdSchema,
    title: z.string().min(1),
    status: z.enum(ISSUE_STATUSES),
    severity: z.enum(ISSUE_SEVERITIES),
    components: z.array(z.string()),
    impact: z.string(),
    resolution: z.string().nullable(),
    location: z.array(z.string()),
    sourceRefs: z.array(IssueSourceRefSchema).optional(),
    dedupeKey: IssueDedupeKeySchema.optional(),
    discoveredDate: DateSchema,
    resolvedDate: DateSchema.nullable(),
    relatedTickets: z.array(TicketIdSchema),
    // Optional fields -- older issues may omit these
    order: z.number().int().optional(),
    phase: z.string().nullable().optional(),
    // Attribution fields -- unused in v1
    createdBy: z.string().nullable().optional(),
    assignedTo: z.string().nullable().optional(),
    lastModifiedBy: z.string().nullable().optional(),
    updatedDate: DateSchema.nullable().optional(),
    updatedAt: TimestampSchema,
    displayId: z.string().optional(),
    previousDisplayIds: z.array(z.string()).optional(),
    lifecycle: z.enum(LIFECYCLE_VALUES).optional(),
    rank: z.string().optional(),
    createdAt: z.string().optional(),
    deletedAt: z.string().optional(),
    deletedBy: z.string().optional(),
    _conflicts: z.array(ConflictEntrySchema).optional(),
    // T-475: pick-exclusion state, distinct from assignedTo (legacy free-text
    // attribution). Issues carry no claimedBySession/claim field at all (no
    // per-session acquisition state exists to match an `assigned` earmark's
    // holder against) -- validate's staleness check treats every `assigned`
    // issue earmark as stale-eligible past threshold for exactly this reason.
    earmark: EarmarkSchema.nullable().optional(),
    // T-476: rulings this issue cites -- see TicketSchema's citesRulings.
    citesRulings: z.array(RulingIdSchema).optional(),
    // ISS-1154: durable actionability signal -- see computeActionability's
    // structured tier (src/core/recommend.ts). Additive, no ticket-side
    // equivalent (issues only).
    //
    // ISS-1113 EXTENDED this enum rather than adding a second field: the three
    // values below are set at the moment a review path FILES an issue, so the
    // reason it is not work travels with it from birth instead of being
    // inferred later from its title. Snake_case to match the originals. The
    // non-actionable subset and the guard every consumer asks live in
    // src/core/issue-disposition.ts.
    disposition: IssueDispositionSchema.optional(),
    duplicateOf: z.union([TicketIdSchema, IssueIdSchema]).optional(),
    // T-486: why the issue was closed, and the evidence behind its
    // disposition. Any value loads: a shape refused here would drop the issue
    // from state and refuse every strict write on the board. Readers go
    // through src/core/resolution-kind.ts, which checks the shape and the
    // facts each value was written against; writes are checked at the write
    // boundary.
    resolutionKind: z.unknown().optional(),
    dispositionReason: z.unknown().optional(),
    dispositionRef: z.unknown().optional(),
    dispositionFor: z.unknown().optional(),
  })
  .passthrough();

export type Issue = z.infer<typeof IssueSchema>;
