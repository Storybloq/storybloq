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

/**
 * ISS-1117: `CLIENT_TASK_ID_PATTERN` alone accepts a chosen session NAME
 * (e.g. "claude-session-abc") just as readily as a real client task id, since
 * both are ordinary identifier-shaped strings. This is the rejection message
 * shown at both regex sites (`ArrangementPartySchema` and, via reuse rather
 * than a duplicate, the MCP tool boundary), bounded to 190 characters so it
 * survives `core/zod-issues.ts`'s 200-character per-field truncation cap on
 * the CLI/model-handler path unmodified.
 */
export const IDENTITY_ANCHOR_FORMAT_MESSAGE =
  'identityAnchor must be the client task id, never a display name or "name [ref]": ' +
  "Claude uses CLAUDE_CODE_SESSION_ID, Codex uses CODEX_THREAD_ID " +
  '(e.g. "b8df203d-d3f5-4520-8057-96babf59612c").';

/**
 * ISS-1117: a permissive "looks like a real task id, not a chosen name"
 * check, used ONLY to decide whether to WARN (never to reject -- Codex
 * thread ids and future clients are not required to be UUID-shaped, so
 * `CLIENT_TASK_ID_PATTERN` itself must stay loose). Applied identically for
 * both clients: the Codex thread ids observed in practice share this same
 * general shape, just not necessarily RFC 4122 version/variant-conformant.
 */
const LOOKS_LIKE_A_TASK_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function looksLikeClientTaskId(anchor: string): boolean {
  return LOOKS_LIKE_A_TASK_ID.test(anchor);
}

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

/**
 * T-529: the cross-entry collisions a catalog merge can produce and record as
 * an `invariant` conflict. One word owned by two glossary entries, and one
 * capability name used by two capabilities.
 */
export const CATALOG_INVARIANT_RULES = ["term-owner", "capability-name"] as const;
export type CatalogInvariantRule = (typeof CATALOG_INVARIANT_RULES)[number];

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The ENUM is closed on purpose, and `.passthrough()` does not extend it: a
 * record whose kind a build does not know fails this parse. That matters on
 * the merge driver's fallback path, which uses this exact parse as a filter
 * and drops what fails it, so `invariant` is listed here rather than left to
 * passthrough. Only the catalogs (new in 1.16) ever carry one, so no older
 * build that reads a ticket or an issue can meet it.
 *
 * `entityId`, `rule`, `key` and `entityIds` are the catalog record fields. They
 * are OMITTED when absent, never written as null: the conflict identity
 * (`instanceKey`) drops an undefined key but serializes null, so a null would
 * give a legacy record a new identity.
 */
export const ConflictEntrySchema = z.object({
  fieldPath: z.string(),
  field: z.string().optional(),
  kind: z.enum(["field", "array-element", "coupled", "delete-edit", "invariant"]),
  group: z.string().optional(),
  base: z.unknown(),
  ours: z.unknown(),
  theirs: z.unknown(),
  entityId: z.string().min(1).optional(),
  rule: z.enum(CATALOG_INVARIANT_RULES).optional(),
  key: z.string().optional(),
  entityIds: z.array(z.string().min(1)).optional(),
}).passthrough().superRefine((entry, ctx) => {
  if (entry.kind === "invariant") {
    if (entry.rule === undefined || entry.key === undefined || entry.entityIds === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "An invariant conflict names its rule, its key and the entries that collide" });
    } else if (new Set(entry.entityIds).size < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entityIds"], message: "An invariant conflict names at least two distinct entries" });
    }
  }
  // A catalog's verification record carries each side's whole group as an
  // object keyed by member name. A positional array would lose the difference
  // between "delete this member" and "set it to null" on the first JSON round
  // trip (an undefined array element serializes as null), so the schema
  // refuses one rather than trusting every writer to know. A side with no
  // member set is an empty object, never a missing side. Legacy per-member
  // records carry no entityId and keep whatever shape they always had.
  if (entry.kind === "coupled" && entry.entityId !== undefined) {
    for (const side of ["base", "ours", "theirs"] as const) {
      if (!isPlainObject(entry[side])) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [side], message: "A catalog group conflict records each side as an object keyed by member name" });
      }
    }
  }
});
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
  // T-507: a command run outside any .story/ ledger (a function-hooks caller runs
  // in every cwd and caches this answer per cwd).
  "no_project",
  // T-526 (D4): a restore refused before its write (expect-mismatch, conflict,
  // absent-source, invariant, accepted-ruling).
  "restore_unsafe",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// --- Priority and waitingOn (T-481) ---

// Priority is how soon; severity (issues) is how bad. Absent reads as p2.
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_RANK: Readonly<Record<Priority, number>> = { p0: 0, p1: 1, p2: 2, p3: 3 };

// Who the item currently waits on. Absent reads as none.
export const WAITING_ON = ["owner", "external", "none"] as const;
export type WaitingOn = (typeof WAITING_ON)[number];

/**
 * The schemas load any stored value so repair can reach an invalid one; every
 * reader goes through these views, where an unrecognised value reads as the
 * default and never throws.
 */
export function effectivePriority(item: { readonly priority?: unknown }): Priority {
  const v = item.priority;
  return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v) ? (v as Priority) : "p2";
}

export function effectiveWaitingOn(item: { readonly waitingOn?: unknown }): WaitingOn {
  const v = item.waitingOn;
  return typeof v === "string" && (WAITING_ON as readonly string[]).includes(v) ? (v as WaitingOn) : "none";
}

/** True when the item waits on the owner or an external party. */
export function isWaiting(item: { readonly waitingOn?: unknown }): boolean {
  return effectiveWaitingOn(item) !== "none";
}

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
