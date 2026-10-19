/**
 * T-538 S2: the `setup` field that ties a ledger item to one setup (plan v5
 * 1e). It is a passthrough field on tickets, issues and notes, so a client
 * that does not know it keeps it byte for byte.
 *
 * - A ticket (checkpoints included) or an issue carries an item key:
 *   `{setupId, key}`, with `key` K1 to K9999 in one namespace across phases,
 *   tickets and issues. An item that gave its key up to another (a merge
 *   duplicate the owner resolved) carries `supersededBy` and no longer owns it.
 * - A note carries an internal record instead: `{setupId, record}`, where
 *   `record` is `progress` (the progress note) or `final` (the setup note).
 *   The handover is a record too, but it is a file, found by its slug.
 *
 * A note with a key, or a ticket or issue with a record, is refused.
 *
 * T-538 S3a-2: an establishment ticket's item key also carries what it
 * establishes and its verification: the spec setup fixed when it created the
 * ticket, and what `storybloq setup-verify` recorded since (result, the
 * owner's decision, reopenings). Both are written only under their
 * authorities (setup-verification-guard.ts); only tickets carry them.
 */
import { z } from "zod";
import { SETUP_ID_PATTERN } from "./setup-review.js";

export const SETUP_KEY_PATTERN = /^K[1-9][0-9]{0,3}$/;
export const SETUP_RECORDS = ["progress", "final", "handover"] as const;
export type SetupRecord = (typeof SETUP_RECORDS)[number];
/** The records a note can carry; the handover is a file, not a note. */
export const NOTE_SETUP_RECORDS = ["progress", "final"] as const;

const setupId = z.string().regex(SETUP_ID_PATTERN, "is not a setup id (SS-<8 hex>)");
const key = z.string().regex(SETUP_KEY_PATTERN, "is not an item key (K1 to K9999)");

const text = z.string().min(1);

/** The runners setup-verify reads evidence from, and what the stage command wraps them in. */
export const TEST_RUNNERS = ["vitest", "jest", "pytest", "django", "go", "cargo", "flutter"] as const;
export type TestRunner = (typeof TEST_RUNNERS)[number];
export const TEST_WRAPPERS = ["none", "npm", "make", "django-manage"] as const;
export type TestWrapper = (typeof TEST_WRAPPERS)[number];

export const VERIFICATION_DROPPABLE = ["PYTEST_ADDOPTS", "GOFLAGS"] as const;
export type VerificationDroppable = (typeof VERIFICATION_DROPPABLE)[number];

/** The component stages an establishment ticket can establish (T-538 S3b adds BUILD and VERIFY). */
export const ESTABLISHABLE_STAGES = ["test", "build", "verify"] as const;
export type EstablishableStage = (typeof ESTABLISHABLE_STAGES)[number];

export const EstablishesSchema = z.object({
  component: text,
  stage: z.enum(ESTABLISHABLE_STAGES),
  scaffold: key,
}).strict();

const ms = z.number().int().positive();

export const TestSpecSchema = z.object({
  setupId,
  component: text,
  stage: z.literal("test"),
  workdir: text,
  command: text,
  runner: z.enum(TEST_RUNNERS),
  wrapper: z.enum(TEST_WRAPPERS),
  timeoutMs: ms,
}).strict();

/** A build establishment: the approved build command succeeds on the scaffold, and leaves no process behind. */
export const BuildSpecSchema = z.object({
  setupId,
  component: text,
  stage: z.literal("build"),
  workdir: text,
  command: text,
  timeoutMs: ms,
}).strict();

/**
 * A verify establishment: the approved start command serves a 2xx at
 * 127.0.0.1:port + readinessPath from a listener its own process group owns,
 * and the group is gone after shutdown.
 */
export const VerifySpecSchema = z.object({
  setupId,
  component: text,
  stage: z.literal("verify"),
  workdir: text,
  command: text,
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
  readinessPath: z.string().regex(/^\/[^\s#]*$/, "is not an absolute path"),
  startupTimeoutMs: ms,
  shutdownTimeoutMs: ms,
}).strict();

export const VerificationSpecSchema = z.discriminatedUnion("stage", [TestSpecSchema, BuildSpecSchema, VerifySpecSchema]);
export type TestSpec = z.infer<typeof TestSpecSchema>;
export type BuildSpec = z.infer<typeof BuildSpecSchema>;
export type VerifySpec = z.infer<typeof VerifySpecSchema>;
export type VerificationSpec = z.infer<typeof VerificationSpecSchema>;

/** The owner's adapter: an argv run with no shell, and the inherited variables it drops before the evidence options are added. */
export const AdapterDecisionSchema = z.object({
  argv: z.array(text).min(1),
  drop: z.array(z.enum(VERIFICATION_DROPPABLE)),
}).strict();
export type AdapterDecision = z.infer<typeof AdapterDecisionSchema>;

export const VerificationDecisionSchema = z.object({
  kind: z.enum(["adapter", "leave-off", "stop"]),
  adapter: AdapterDecisionSchema.optional(),
  ownerWords: text,
  at: text,
}).strict().refine((d) => (d.kind === "adapter") === (d.adapter !== undefined), { message: "carries an adapter exactly when its kind is adapter" });
export type VerificationDecision = z.infer<typeof VerificationDecisionSchema>;

export const VerificationResultSchema = z.object({
  status: z.enum(["verified", "left-off"]),
  counts: z.object({ executed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict().optional(),
  tailDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  at: text,
}).strict();
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const VerificationSchema = z.object({
  spec: VerificationSpecSchema,
  result: VerificationResultSchema.optional(),
  decision: VerificationDecisionSchema.optional(),
  reopened: z.array(z.object({ at: text }).strict()).optional(),
}).strict();
export type Verification = z.infer<typeof VerificationSchema>;

export const SetupItemMetaSchema = z.object({
  setupId,
  key,
  supersededBy: z.string().min(1).optional(),
}).strict();

/** A ticket's item key: an establishment ticket carries `establishes` and `verification` together. */
export const SetupTicketMetaSchema = SetupItemMetaSchema.extend({
  establishes: EstablishesSchema.optional(),
  verification: VerificationSchema.optional(),
}).strict().refine((m) => (m.establishes === undefined) === (m.verification === undefined), {
  message: "carries establishes and verification together, or neither",
}).refine((m) => m.establishes === undefined || m.verification === undefined
  || (m.establishes.stage === m.verification.spec.stage && m.establishes.component === m.verification.spec.component), {
  message: "establishes one stage of one component and its spec is for another",
});
export type SetupItemMeta = z.infer<typeof SetupTicketMetaSchema>;

export const SetupRecordMetaSchema = z.object({
  setupId,
  record: z.enum(NOTE_SETUP_RECORDS),
}).strict();
export type SetupRecordMeta = z.infer<typeof SetupRecordMetaSchema>;

export type SetupEntity = "ticket" | "issue" | "note";

export type ParsedSetupMeta =
  | { readonly kind: "none" }
  | { readonly kind: "item"; readonly meta: SetupItemMeta }
  | { readonly kind: "record"; readonly meta: SetupRecordMeta }
  | { readonly kind: "invalid"; readonly reason: string };

function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "is not valid";
  const at = issue.path.length > 0 ? `${issue.path.join(".")} ` : "";
  return `${at}${issue.message}`;
}

/** Reads an entity's `setup` field; `none` when the field is absent. */
export function parseSetupMeta(entity: SetupEntity, item: object): ParsedSetupMeta {
  if (!Object.hasOwn(item, "setup")) return { kind: "none" };
  const raw = (item as { setup?: unknown }).setup;
  const isObject = typeof raw === "object" && raw !== null && !Array.isArray(raw);
  if (entity === "note") {
    if (isObject && Object.hasOwn(raw, "key")) return { kind: "invalid", reason: "a note carries a setup record, never an item key" };
    const parsed = SetupRecordMetaSchema.safeParse(raw);
    return parsed.success ? { kind: "record", meta: parsed.data } : { kind: "invalid", reason: firstIssue(parsed.error) };
  }
  if (isObject && Object.hasOwn(raw, "record")) return { kind: "invalid", reason: `a ${entity} carries an item key, never a setup record` };
  const parsed = (entity === "ticket" ? SetupTicketMetaSchema : SetupItemMetaSchema).safeParse(raw);
  return parsed.success ? { kind: "item", meta: parsed.data } : { kind: "invalid", reason: firstIssue(parsed.error) };
}
