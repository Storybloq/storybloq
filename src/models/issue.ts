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
  })
  .passthrough();

export type Issue = z.infer<typeof IssueSchema>;
