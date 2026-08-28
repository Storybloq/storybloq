/**
 * T-477 section 3: `storybloq session milestone` / `storybloq_session_milestone`.
 *
 * A self-reported structural marker of what THIS session is doing right now
 * ("implementing", "gate-hold", "blocked-external", "reviewing"), folded onto
 * the caller's own presence record via the same heavy-path locked
 * read-modify-write `storybloq status` uses (`core/presence-enrichment.ts`),
 * at the longer `MILESTONE_LOCK_BUDGET_MS` budget -- a milestone ping is a
 * deliberate, low-frequency act worth a real wait, and its caller must never
 * see a silent "written" outcome for a ping that was actually dropped.
 *
 * Write-time validation (`MilestoneWriteSchema`) lives here, in the already-
 * heavy CLI/MCP layer -- `presence/record.ts`'s `parseMilestone` stays the
 * tolerant, Zod-free reader on the slim binary's import graph (section 3.3).
 */

import { z } from "zod";
import { ownerTaskForCurrentClient } from "../../autonomous/client-profile.js";
import { applyPresenceEnrichment, MILESTONE_LOCK_BUDGET_MS } from "../../core/presence-enrichment.js";
import { MAX_GATE_NAME_BYTES, MAX_MILESTONE_NOTE_BYTES } from "../../presence/types.js";

/**
 * `MAX_MILESTONE_NOTE_BYTES`/`MAX_GATE_NAME_BYTES` are UTF-8 BYTE ceilings
 * (they bound the serialized presence record -- see `presence/types.ts`'s
 * doc comment), but `z.string().max(n)` counts JavaScript UTF-16 code units.
 * For any non-ASCII input those are different numbers -- a 500-code-unit
 * string of 3-byte-per-character text is 1500 UTF-8 bytes -- so a plain
 * `.max()` here would let a value through that this same input can still
 * trip `applyPresenceEnrichment`'s own `MAX_RECORD_BYTES` ceiling downstream
 * (`skipped-too-large`, non-retryable) instead of being rejected at the
 * schema boundary with a clear, actionable error.
 */
export function utf8ByteLimitedString(maxBytes: number, fieldName: string) {
  return z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, {
    message: `${fieldName} exceeds ${maxBytes} UTF-8 bytes`,
  });
}

const NoteSchema = utf8ByteLimitedString(MAX_MILESTONE_NOTE_BYTES, "note").optional();
// `gate-hold` exists to name a specific gate -- an empty or whitespace-only
// value would write a milestone that renders as an unidentified gate, which
// defeats the one thing this kind of milestone is for.
const GateNameSchema = utf8ByteLimitedString(MAX_GATE_NAME_BYTES, "gateName").refine((value) => value.trim().length > 0, {
  message: "gateName must not be empty",
});

export const MilestoneWriteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("implementing"), note: NoteSchema }),
  z.object({ kind: z.literal("gate-hold"), gateName: GateNameSchema, note: NoteSchema }),
  z.object({ kind: z.literal("blocked-external"), note: NoteSchema }),
  z.object({ kind: z.literal("reviewing"), note: NoteSchema }),
]);
// `at` is never a writer input -- server-stamped at write time, below.

export type MilestoneWriteInput = z.infer<typeof MilestoneWriteSchema>;

export type SessionMilestoneResult =
  | { readonly ok: true; readonly kind: string; readonly at: string }
  | {
      readonly ok: false;
      /** Machine-readable: never collapse this to a generic string for a caller to parse. */
      readonly errorCode: "identity-unresolved" | "lock-busy" | "write-failed";
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * Resolves the caller's identity, then performs the locked read-modify-write.
 * Never returns `{ok: true}` for an outcome other than `EnrichmentOutcome`'s
 * `"written"` -- lock contention and write failure are reported explicitly
 * and distinctly (plan section 3.1's re-flagged requirement), not absorbed
 * into a false success.
 */
export function handleSessionMilestone(
  root: string,
  input: MilestoneWriteInput,
  explicitClientTaskId: string | null | undefined,
  now: () => Date = () => new Date(),
): SessionMilestoneResult {
  const ownerTask = ownerTaskForCurrentClient(explicitClientTaskId);
  if (!ownerTask) {
    return {
      ok: false,
      errorCode: "identity-unresolved",
      message:
        "Could not resolve caller identity: no clientTaskId argument and no CLAUDE_CODE_SESSION_ID/CODEX_THREAD_ID in the environment. Pass clientTaskId explicitly.",
      retryable: false,
    };
  }

  let capturedAt: string | null = null;
  const outcome = applyPresenceEnrichment(
    root,
    ownerTask.id,
    MILESTONE_LOCK_BUDGET_MS,
    "milestone-command",
    (base, nowIso) => {
      capturedAt = nowIso;
      return {
        ...base,
        // Section 3.1's write semantics: a milestone ping is itself proof of
        // life, so it updates the SAME liveness fields tool-open tracking
        // relies on -- never leave it hidden behind a stale lastEventAt or a
        // lingering tombstone.
        lastEventAt: nowIso,
        endedAt: null,
        milestone: {
          kind: input.kind,
          at: nowIso,
          ...(input.kind === "gate-hold" ? { gateName: input.gateName } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        },
      };
    },
    now,
  );

  switch (outcome.status) {
    case "written":
      return { ok: true, kind: input.kind, at: capturedAt! };
    case "skipped-lock-busy":
      return {
        ok: false,
        errorCode: "lock-busy",
        message: "Another process is writing this session's presence record right now. Retry.",
        retryable: true,
      };
    case "skipped-write-failed":
      return {
        ok: false,
        errorCode: "write-failed",
        message: "Presence record write failed.",
        retryable: true,
      };
    case "skipped-no-directory":
      return {
        ok: false,
        errorCode: "write-failed",
        message: "No presence directory could be created under .story/telemetry/presence.",
        retryable: false,
      };
    case "skipped-too-large":
      return {
        ok: false,
        errorCode: "write-failed",
        message: "This session's presence record exceeds the size limit even after shedding.",
        retryable: false,
      };
  }
}
