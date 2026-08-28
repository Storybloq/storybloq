import { z } from "zod";
import {
  DateSchema,
  TimestampSchema,
  ArrangementIdSchema,
  TicketRefSchema,
  IssueRefSchema,
  CLIENT_TASK_ID_PATTERN,
  RulingIdSchema,
} from "./types.js";

export const ARRANGEMENT_LIFECYCLE = ["active", "suspended", "closed"] as const;
export type ArrangementLifecycle = (typeof ARRANGEMENT_LIFECYCLE)[number];

/** N-109's exact two roles. Duet mode is strictly two-party (see the `superRefine` below). */
export const ARRANGEMENT_ROLES = ["pen", "worker"] as const;
export type ArrangementRole = (typeof ARRANGEMENT_ROLES)[number];

/**
 * `identityAnchor` binds to the existing client-task-identity contract the
 * guard already resolves (`autonomous/client-profile.ts`'s `OwnerTask`), not
 * to a display name -- this is a NAME the guard can match against, never a
 * credential (authentication is out of scope for T-473). Reusing
 * `CLIENT_TASK_ID_PATTERN` exactly (rather than a looser ad hoc string
 * check) means a persisted anchor can actually match a resolved `OwnerTask`;
 * a looser schema here would silently mint anchors that can never match
 * anything.
 */
export const ArrangementPartySchema = z
  .object({
    role: z.enum(ARRANGEMENT_ROLES),
    client: z.enum(["claude", "codex"]),
    identityAnchor: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN),
    modelTier: z.string().max(64).optional(),
    // Reserved per T-473's ACCEPTANCE (5): the schema reserves a per-party
    // outbound-message log reference; logging itself is deferred. Presence
    // of the field (not its content) is what "reserves" it -- no T-473 code
    // path writes to it.
    provenanceLogRef: z.string().max(1024).optional(),
  })
  .passthrough();

export const ArrangementGateSchema = z
  .object({
    name: z.string().min(1).max(128),
    ackRole: z.enum(ARRANGEMENT_ROLES),
  })
  .passthrough();

export const ArrangementBoundsSchema = z
  .object({
    maxReviewRounds: z.number().int().positive().max(20).optional(),
    escalateOnCap: z.boolean().optional(),
  })
  .passthrough();

/**
 * The umbrella's cross-cutting "never fail open" constraint (T-472, sourced
 * from N-108 requirement 3) made structural: `onIrreversibleWork` has
 * exactly two members. "continue"/auto-proceed is not a member anywhere in
 * this schema, so the invalid state is unrepresentable, not merely
 * discouraged by convention.
 */
export const ArrangementUnreachabilitySchema = z
  .object({
    onIrreversibleWork: z.enum(["hold", "escalate"]),
    onReversibleWork: z.enum(["hold", "escalate", "proceed"]).optional(),
  })
  .passthrough();

export const ArrangementSchema = z
  .object({
    id: ArrangementIdSchema,
    lifecycle: z.enum(ARRANGEMENT_LIFECYCLE),
    // Display-form OR canonical, same as every other ref field in this
    // codebase (TicketRefSchema/IssueRefSchema) -- the mixed ledger is
    // permanent, so a canonical-only ref is unimplementable on this
    // project's own data.
    bounds: z.array(z.union([TicketRefSchema, IssueRefSchema])).min(1),
    parties: z.array(ArrangementPartySchema).min(2),
    gates: z.array(ArrangementGateSchema),
    treeProtocol: z
      .object({
        pathScopes: z.array(z.string()).optional(),
        freezePaths: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    reviewBounds: ArrangementBoundsSchema.optional(),
    unreachability: ArrangementUnreachabilitySchema,
    // T-476: rulings this arrangement cites -- see TicketSchema's citesRulings.
    citesRulings: z.array(RulingIdSchema).optional(),
    createdDate: DateSchema,
    updatedAt: TimestampSchema,
    createdBy: z.string().nullable().optional(),
    // Inert in T-473: arrangements are not wired into the merge driver
    // (that is T-478/reconcile territory). The field exists only so a
    // future wire-up is additive, matching the other models' convention of
    // carrying `_conflicts` even before merge support lands.
    _conflicts: z.array(z.unknown()).optional(),
  })
  .passthrough()
  // N-109 duet mode is exactly two parties with distinct roles. Without
  // this, {2 workers, no pen} or {the same identity assigned both roles}
  // parses successfully and has no deterministic meaning for gate
  // acknowledgement or guard announcement. Made a hard schema invariant
  // rather than an app-layer convention because both the guard's matching
  // logic and gate-ack logic depend on the topology being exactly this
  // shape.
  .superRefine((val, ctx) => {
    const pens = val.parties.filter((p) => p.role === "pen");
    const workers = val.parties.filter((p) => p.role === "worker");
    if (pens.length !== 1 || workers.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An arrangement must have exactly one pen and one worker party",
        path: ["parties"],
      });
    }
    const seen = new Set<string>();
    for (const p of val.parties) {
      const key = `${p.client}:${p.identityAnchor}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate party identity: ${key}`,
          path: ["parties"],
        });
      }
      seen.add(key);
    }
  });

export type ArrangementParty = z.infer<typeof ArrangementPartySchema>;
export type Arrangement = z.infer<typeof ArrangementSchema>;
