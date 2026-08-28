import { z } from "zod";
import { DateSchema, TimestampSchema, RulingIdSchema, OwnerTaskLikeSchema } from "./types.js";

/**
 * T-476's exact three attribution values. `attribution` is a CLAIM asserted
 * by the recorder, never verified by storybloq -- see `recordedBy` below and
 * the anti-laundering caveat in `src/core/ruling.ts`'s module docblock.
 */
export const RULING_ATTRIBUTIONS = [
  "owner-direct",
  "owner-via-manager-with-owner-veto",
  "manager-delegated",
] as const;
export type RulingAttribution = (typeof RULING_ATTRIBUTIONS)[number];

/**
 * A verbatim, attributed decision record with a supersedes-chain.
 *
 * `text` carries NO transform/trim -- verbatim means byte-verbatim, per the
 * ticket's own pitfall list: no markdown cleanup, no em-dash-policy edits
 * inside quoted text. `recordedBy` is WHO WROTE THIS RECORD (session/task
 * identity), independent of and never a substitute for `attribution` (the
 * claimed source of the ruling) -- this is what turns the two-key rule from
 * etiquette into checkable provenance without replacing the second key.
 *
 * `.passthrough()` matches every other T-47x model (`LessonSchema`,
 * `ArrangementSchema`): forward-compatible unknown fields survive a
 * parse/rewrite round trip.
 */
export const RulingSchema = z
  .object({
    id: RulingIdSchema,
    text: z.string().min(1, "Ruling text cannot be empty"),
    attribution: z.enum(RULING_ATTRIBUTIONS),
    recordedBy: OwnerTaskLikeSchema,
    date: DateSchema,
    scopeTags: z.array(z.string()).default([]),
    supersedes: RulingIdSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .passthrough();

export type Ruling = z.infer<typeof RulingSchema>;
