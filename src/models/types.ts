import { z } from "zod";

// --- Canonical ID alphabet (single source of truth, ISS-703) ---

/**
 * The 32-character Crockford base32 alphabet used to encode canonical IDs
 * (excludes i, l, o, u). The encoder (canonical-id.ts) and every consuming
 * regex derive from these two constants so the alphabet and its matching regex
 * character class can never silently drift.
 */
export const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/**
 * Regex character class matching exactly the Crockford alphabet, built by listing
 * the alphabet verbatim inside brackets (equivalent to the hand-written range
 * [0-9a-hjkmnp-tvwxyz]). Safe because the alphabet contains no char-class
 * metacharacters. Interpolate into `new RegExp` to build canonical-ID patterns.
 */
export const CROCKFORD_CLASS = `[${CROCKFORD_ALPHABET}]`;

// --- ID format regexes ---

/** Matches legacy T-001, T-077a, T-079b */
export const TICKET_ID_REGEX = /^T-\d+[a-z]?$/;
/** Matches canonical t-[crockford16] */
export const TICKET_CANONICAL_ID_REGEX = new RegExp(`^t-${CROCKFORD_CLASS}{16}$`);

/** Matches legacy ISS-001, ISS-009 */
export const ISSUE_ID_REGEX = /^ISS-\d+$/;
/** Matches canonical i-[crockford16] */
export const ISSUE_CANONICAL_ID_REGEX = new RegExp(`^i-${CROCKFORD_CLASS}{16}$`);

/**
 * Arrangements have no legacy era (T-473): born after the canonical-id
 * migration, so there is no display-form regex to pair with this one and no
 * sequential allocator. Canonical-only, deliberately.
 */
export const ARRANGEMENT_CANONICAL_ID_REGEX = new RegExp(`^a-${CROCKFORD_CLASS}{16}$`);

/** Canonical-only (T-474): a gate-ack has no legacy display-id era. */
export const GATE_ACK_CANONICAL_ID_REGEX = new RegExp(`^g-${CROCKFORD_CLASS}{16}$`);

/**
 * Canonical-only (T-476), same reasoning as `ARRANGEMENT_CANONICAL_ID_REGEX`:
 * rulings are born after the canonical-id migration, so there is no legacy
 * display-form to pair with this one.
 */
export const RULING_CANONICAL_ID_REGEX = new RegExp(`^r-${CROCKFORD_CLASS}{16}$`);

/**
 * The client-task-identity contract (T-473), duplicated from
 * `autonomous/client-profile.ts`'s own copy so `ArrangementPartySchema` can
 * depend on it without importing `client-profile.ts` into the models layer.
 * NOT re-exported from there: `client-profile.ts` sits in the presence-entry
 * hook's zero-dependency import closure (ISS-1022), and importing this file
 * from there pulls zod and the whole models module into that closure. Keep
 * the two copies in sync by hand.
 */
export const CLIENT_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// --- Ticket enums ---

export const TICKET_STATUSES = ["open", "inprogress", "complete"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_TYPES = ["task", "feature", "chore"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

// --- Issue enums ---

export const ISSUE_STATUSES = ["open", "inprogress", "resolved"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

// --- Note enums ---

export const NOTE_STATUSES = ["active", "archived"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export const NOTE_ID_REGEX = /^N-\d+$/;
export const NOTE_CANONICAL_ID_REGEX = new RegExp(`^n-${CROCKFORD_CLASS}{16}$`);
export const NoteIdSchema = z
  .string()
  .refine(
    (v) => NOTE_ID_REGEX.test(v) || NOTE_CANONICAL_ID_REGEX.test(v),
    "Note ID must match N-NNN or n-[canonical]",
  );

// --- Lesson enums ---

export const LESSON_STATUSES = ["active", "deprecated", "superseded"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];
export const LESSON_SOURCES = ["review", "correction", "postmortem", "manual"] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];
export const LESSON_ID_REGEX = /^L-\d+$/;
export const LESSON_CANONICAL_ID_REGEX = new RegExp(`^l-${CROCKFORD_CLASS}{16}$`);
export const LessonIdSchema = z
  .string()
  .refine(
    (v) => LESSON_ID_REGEX.test(v) || LESSON_CANONICAL_ID_REGEX.test(v),
    "Lesson ID must match L-NNN or l-[canonical]",
  );

// --- Team-mode enums ---

export const LIFECYCLE_VALUES = ["active", "archived", "deleted"] as const;
export type Lifecycle = (typeof LIFECYCLE_VALUES)[number];

export const ConflictEntrySchema = z.object({
  fieldPath: z.string(),
  field: z.string().optional(),
  kind: z.enum(["field", "array-element", "coupled", "delete-edit"]),
  group: z.string().optional(),
  base: z.unknown(),
  ours: z.unknown(),
  theirs: z.unknown(),
}).passthrough();
export type ConflictEntry = z.infer<typeof ConflictEntrySchema>;

export const ClaimSchema = z.object({
  user: z.string(),
  branch: z.string(),
  since: z.string(),
});
export type Claim = z.infer<typeof ClaimSchema>;

// --- Output/error types ---

export const OUTPUT_FORMATS = ["json", "md"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const ERROR_CODES = [
  "not_found",
  "validation_failed",
  "io_error",
  "project_corrupt",
  "invalid_input",
  "conflict",
  "version_mismatch",
  "file_exists",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// --- Date validation ---

export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Regex check + calendar validity. The `startsWith` check catches Date constructor
// rollover (e.g. "2026-02-29" rolls to "2026-03-01", so toISOString won't match).
export const DateSchema = z
  .string()
  .regex(DATE_REGEX, "Date must be YYYY-MM-DD")
  .refine(
    (val) => {
      const d = new Date(val + "T00:00:00Z");
      return !isNaN(d.getTime()) && d.toISOString().startsWith(val);
    },
    { message: "Invalid calendar date" },
  );

// Loose ISO-8601 timestamp (e.g. "2026-05-28T10:00:00Z"). Kept permissive to match the existing
// `createdAt` treatment and to avoid rejecting legacy passthrough data; the merge layer treats
// unparseable values as ambiguous rather than failing to load.
export const TimestampSchema = z.string().nullable().optional();

// --- Reusable ID schemas ---

export const TicketIdSchema = z
  .string()
  .refine(
    (v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v),
    "Ticket ID must match T-NNN, T-NNNx, or t-[canonical]",
  );

export const IssueIdSchema = z
  .string()
  .refine(
    (v) => ISSUE_ID_REGEX.test(v) || ISSUE_CANONICAL_ID_REGEX.test(v),
    "Issue ID must match ISS-NNN or i-[canonical]",
  );

// --- Ref schemas (user-provided references, resolved before persisting) ---

export const TicketRefSchema = z
  .string()
  .refine(
    (v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v),
    "Ticket ref must match T-NNN, T-NNNx, or t-[canonical]",
  );

export const IssueRefSchema = z
  .string()
  .refine(
    (v) => ISSUE_ID_REGEX.test(v) || ISSUE_CANONICAL_ID_REGEX.test(v),
    "Issue ref must match ISS-NNN or i-[canonical]",
  );

export const NoteRefSchema = z
  .string()
  .refine(
    (v) => NOTE_ID_REGEX.test(v) || NOTE_CANONICAL_ID_REGEX.test(v),
    "Note ref must match N-NNN or n-[canonical]",
  );

export const LessonRefSchema = z
  .string()
  .refine(
    (v) => LESSON_ID_REGEX.test(v) || LESSON_CANONICAL_ID_REGEX.test(v),
    "Lesson ref must match L-NNN or l-[canonical]",
  );

/** Canonical-only (T-473): no legacy form exists, so id and ref are the same shape. */
export const ArrangementIdSchema = z
  .string()
  .refine((v) => ARRANGEMENT_CANONICAL_ID_REGEX.test(v), "Arrangement ID must match a-[canonical]");

export const ArrangementRefSchema = z
  .string()
  .refine((v) => ARRANGEMENT_CANONICAL_ID_REGEX.test(v), "Arrangement ref must match a-[canonical]");

/** Canonical-only (T-476): no legacy form exists, so id and ref are the same shape. */
export const RulingIdSchema = z
  .string()
  .refine((v) => RULING_CANONICAL_ID_REGEX.test(v), "Ruling ID must match r-[canonical]");

export const RulingRefSchema = z
  .string()
  .refine((v) => RULING_CANONICAL_ID_REGEX.test(v), "Ruling ref must match r-[canonical]");

export const EARMARK_ROLES = ["pen", "worker"] as const;
export type EarmarkRole = (typeof EARMARK_ROLES)[number];

/**
 * Mirrors `autonomous/client-profile.ts`'s real `OwnerTask` ({client, id,
 * boundAt}) minus `boundAt`, which is provenance, not identity -- a
 * placement/retraction identity is compared for equality, never recency.
 * Duplicated here rather than imported: `models/` never depends on
 * `autonomous/` (one-directional layering), so this is a structural mirror,
 * kept in sync by hand the same way `ArrangementPartySchema`'s `client`
 * field already is.
 */
export const OwnerTaskLikeSchema = z.object({
  client: z.enum(["claude", "codex"]),
  id: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN),
});
export type OwnerTaskLike = z.infer<typeof OwnerTaskLikeSchema>;

/**
 * T-475: pick-exclusion state for assignment coordination between a duet's
 * pen and worker. Unrelated to `reconcile.ts`'s "reservations" (git-ref
 * duplicate-display-id tie-breaking) -- deliberately never named
 * "reservation" to keep the two concepts from being confused in code or
 * conversation.
 *
 * A discriminated union on `stage` so the invalid states (an `assigned`
 * earmark with no `holderSession`, a `reserved` earmark bound to a session)
 * are unrepresentable, the same discipline as `frozenGate`
 * (autonomous/session-types.ts). The choke point that acquires an earmarked
 * item (autonomous/stages/pick-ticket.ts) CONVERTS `reserved` -> `assigned`
 * in place rather than clearing it -- an `assigned` earmark persists for the
 * item's whole active life as its assignment record, cleared only at an
 * explicit release seam (see earmarks.ts), never by acquisition itself.
 */
const EarmarkBaseSchema = z.object({
  reservedBy: OwnerTaskLikeSchema,
  arrangementId: ArrangementIdSchema,
  since: z.string().datetime(),
});

export const EarmarkSchema = z.discriminatedUnion("stage", [
  EarmarkBaseSchema.extend({
    stage: z.literal("reserved"),
    holderRole: z.enum(EARMARK_ROLES),
    holderSession: z.null(),
  }),
  EarmarkBaseSchema.extend({
    stage: z.literal("assigned"),
    holderRole: z.enum(EARMARK_ROLES),
    holderSession: z.string().uuid(),
  }),
]);
export type Earmark = z.infer<typeof EarmarkSchema>;

/**
 * Canonical-only (T-474), and content-derived rather than randomly minted
 * (see gate-ack.ts's `computeGateAckId`) -- no legacy form, no allocator.
 */
export const GateAckIdSchema = z
  .string()
  .refine((v) => GATE_ACK_CANONICAL_ID_REGEX.test(v), "Gate-ack ID must match g-[canonical]");
