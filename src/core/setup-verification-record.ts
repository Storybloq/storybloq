/**
 * T-538 S3a-2: the setup verification record, `config.setupVerification`.
 * A setup whose payload establishes any stage writes it with the recipe
 * stages: the quality level and every component with each stage's live
 * status. `storybloq setup-verify` reads it to bind a ticket's spec to its
 * component, moves a component's test status to `verified` or `left-off`, and
 * records the owner's decision beside the ticket's copy. The recipe stages a
 * verified component serves are rebuilt from it with `establishStage`.
 *
 * A config without it is an older setup: setup-verify refuses there rather
 * than guess the components.
 */
import { z } from "zod";
import { SETUP_ID_PATTERN } from "./setup-review.js";
import { TEST_RUNNERS, TEST_WRAPPERS, VerificationDecisionSchema } from "./setup-meta.js";
import { QUALITY_LEVELS, type SetupPayload } from "./setup-payload.js";
import type { ActivationInput } from "./verification-activation.js";
import type { Config } from "../models/config.js";

export const SETUP_VERIFICATION_RECORD_VERSION = 1;

const text = z.string().min(1);
const liveStatus = z.enum(["established", "verified", "pending", "left-off"]);

const RecordStage = z.object({ command: text, status: liveStatus, reason: text.optional() }).strict();
const RecordTestStage = RecordStage.extend({ runner: z.enum(TEST_RUNNERS).optional(), wrapper: z.enum(TEST_WRAPPERS).optional() }).strict();
const RecordVerify = z.object({ startCommand: text, readinessUrl: text, status: liveStatus, reason: text.optional() }).strict();

export const SetupVerificationRecordSchema = z.object({
  version: z.literal(SETUP_VERIFICATION_RECORD_VERSION),
  setupId: z.string().regex(SETUP_ID_PATTERN, "is not a setup id (SS-<8 hex>)"),
  level: z.enum(QUALITY_LEVELS),
  verifyApplies: z.boolean(),
  components: z.array(z.object({
    id: text,
    workdir: text,
    test: RecordTestStage.nullable(),
    build: RecordStage.nullable(),
    verify: RecordVerify.nullable(),
    decision: VerificationDecisionSchema.optional(),
  }).strict()).min(1),
}).strict();

export type SetupVerificationRecord = z.infer<typeof SetupVerificationRecordSchema>;
export type RecordComponent = SetupVerificationRecord["components"][number];

/** The record a setup writes: its quality plan as approved, every stage at its planned status. */
export function initialRecord(p: SetupPayload): SetupVerificationRecord {
  return {
    version: SETUP_VERIFICATION_RECORD_VERSION,
    setupId: p.setupId,
    level: p.quality.level,
    verifyApplies: p.quality.verifyApplies,
    components: p.quality.components.map((c) => ({ id: c.id, workdir: c.workdir, test: c.test, build: c.build, verify: c.verify })),
  };
}

export type RecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "ok"; readonly record: SetupVerificationRecord };

export function readRecord(config: Config): RecordRead {
  if (!Object.hasOwn(config, "setupVerification")) return { kind: "absent" };
  const parsed = SetupVerificationRecordSchema.safeParse((config as Config & { setupVerification?: unknown }).setupVerification);
  if (parsed.success) return { kind: "ok", record: parsed.data };
  const issue = parsed.error.issues[0];
  return { kind: "invalid", reason: issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "is not valid" };
}

/** The record as the quality matrix reads it. */
export function recordActivation(r: SetupVerificationRecord): ActivationInput {
  return { level: r.level, verifyApplies: r.verifyApplies, components: r.components.map(({ decision: _d, ...c }) => c) };
}
