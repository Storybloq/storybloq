import { createHash } from "node:crypto";
import { z } from "zod";
import { TimestampSchema, ArrangementIdSchema, TicketRefSchema, IssueRefSchema, GateAckIdSchema } from "./types.js";
import { ARRANGEMENT_ROLES } from "./arrangement.js";

export const GateAckPlanPinSchema = z
  .object({
    kind: z.literal("plan-hash"),
    // SHA-256 of plan.md's raw bytes, computed fresh by sha256Bytes
    // (core/pin-utils.ts) for this purpose alone. Deliberately a SEPARATE
    // value from lastPlanHash (DJB2, autonomous/stages/plan.ts -- a
    // self-comparison of a plan against its own earlier draft, where a
    // collision costs one wasted retry) and from planReviewBaseline.planHash
    // (also SHA-256 via hashPlanContent, plan-review-drift.ts, but a
    // decoded-string hash used only for drift-baseline generation identity --
    // a different, lower-stakes purpose). A gate-ack pin is a cross-party
    // authorization binding: a collision here means an unratified plan
    // satisfies the pen's ratification. Three separate uses of plan-content
    // identity in this codebase now; none is a stand-in for another.
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .passthrough();

// A git tree object id (content-addressed by git itself) plus a parent sha
// (ancestry anchor) -- not a diff hash. See core/arrangement-acks/finalize
// enforcement for the full argument: a tree id needs no comparability
// argument between two separate diff invocations, since git guarantees the
// same content always hashes to the same tree id.
//
// v1 constraint, stated not silent: SHA-1 object format only. A repo with
// `extensions.objectFormat = sha256` (64-hex object ids) is rejected
// explicitly at pin-computation time, never silently mis-shaped.
export const GateAckTreePinSchema = z
  .object({
    kind: z.literal("tree-digest"),
    parentSha: z.string().regex(/^[0-9a-f]{40}$/),
    treeId: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .passthrough();

export const GateAckPinSchema = z.union([GateAckPlanPinSchema, GateAckTreePinSchema]);
export type GateAckPin = z.infer<typeof GateAckPinSchema>;

// An ack renders distinguishably with vs. without an independent-review
// trail (T-474 acceptance 7). `present: false` is an honest default (a gate
// can legitimately be acked on inspection alone), never an error state.
export const GateAckReviewTrailSchema = z
  .object({
    present: z.boolean(),
    codexSessionId: z.string().max(128).optional(),
    verdict: z.string().max(32).optional(),
    rounds: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    if (v.present && !v.verdict) {
      ctx.addIssue({ code: "custom", message: "reviewTrail.present=true requires at least `verdict`" });
    }
    if (!v.present && (v.codexSessionId || v.verdict || v.rounds !== undefined)) {
      ctx.addIssue({ code: "custom", message: "reviewTrail.present=false must not carry review evidence fields" });
    }
  });

export const GateAckSchema = z
  .object({
    id: GateAckIdSchema, // g-<16 hex>, content-derived, see computeGateAckId -- deltas NOT included
    arrangementId: ArrangementIdSchema,
    gateName: z.string().min(1).max(128), // must match an ArrangementGateSchema.name on the arrangement
    ackRole: z.enum(ARRANGEMENT_ROLES), // who acked -- validated at READ time against the gate's declared ackRole, not id material
    // ISS-1049: field NAME kept for backward compatibility (existing gate-ack
    // files on disk), but the value now accepts either a ticket or an issue
    // ref -- canonical form only, resolved via `resolveRef` before write.
    ticketRef: z.union([TicketRefSchema, IssueRefSchema]),
    pin: GateAckPinSchema,
    decidedAt: TimestampSchema,
    decidedBy: z.string().max(128).optional(),
    // Ordinary metadata, NOT id material (see computeGateAckId's doc comment
    // for why). Semantics differ by gate: unrestricted for plan-ack
    // (rendered in IMPLEMENT's instruction); restricted by convention to
    // non-mutating caveats for pre-commit-ack, since by the time that ack is
    // checked the commit it applies to has already been made.
    deltas: z.string().max(4096).optional(),
    reviewTrail: GateAckReviewTrailSchema,
    contested: z.boolean().default(false),
    contestedReason: z.string().max(1024).optional(),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    if (v.contested && !v.contestedReason?.trim()) {
      ctx.addIssue({ code: "custom", message: "contested=true requires a non-empty contestedReason" });
    }
    if (!v.contested && v.contestedReason) {
      ctx.addIssue({ code: "custom", message: "contestedReason must be absent when contested=false" });
    }
  });

export type GateAck = z.infer<typeof GateAckSchema>;

/**
 * Deterministic id, deliberately excluding `deltas`: a lookup only ever has
 * (arrangementId, gateName, ticketRef, pin) in hand -- the worker performing
 * a lookup has no way to know in advance what deltas text, if any, the
 * acking party attached, since that is exactly what the lookup exists to
 * discover. Folding `deltas` into the id would make an ack carrying deltas
 * permanently unfindable. The "two different deltas for one pin must not
 * silently collide" concern is handled at WRITE time instead (see
 * `gate-ack-loader.ts`'s `writeGateAckUnlocked`), where the acking party
 * always knows the exact text they intend.
 */
export function computeGateAckId(
  arrangementId: string,
  gateName: string,
  ticketRef: string,
  pin: GateAckPin,
): string {
  const material = `${arrangementId}|${gateName}|${ticketRef}|${JSON.stringify(pin)}`;
  return `g-${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

export const PLAN_ACK_GATE_NAME = "plan-ack";
export const PRECOMMIT_ACK_GATE_NAME = "pre-commit-ack";
