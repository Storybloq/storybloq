import { z } from "zod";
import { CROCKFORD_CLASS } from "../models/types.js";

/**
 * C-v4.1 section 3 (ISS-1435): the proof receipt record, v 1, and its raw
 * reader. Commit 1 carries the model and the reader only; the write guard is
 * commit 2 and `receipt add` is commit 3.
 *
 * A record stores `receipts` as `z.unknown()`, so nothing here can block a
 * record load. `readReceipts` classifies the field and each entry; only `ok`
 * entries ever count.
 */

export const RECEIPT_ID_REGEX = new RegExp(`^rc-${CROCKFORD_CLASS}{16}$`);
export const RECEIPT_KINDS = ["test", "mutant", "review", "device"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const RECEIPT_BOUNDS = {
  dataKeys: 8,
  dataBytes: 2048,
  supersedes: 32,
  covers: 64,
  refBytes: 200,
  commandBytes: 1000,
  evidenceBytes: 512,
} as const;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const boundedString = (max: number) => z.string().min(1).refine((s) => bytes(s) <= max, { message: `at most ${max} bytes` });

const VERDICTS = ["approve", "request_changes", "revise", "reject"] as const;

/** Per-kind data keys (3.2). Unknown keys are refused; `builtFromSha` lives only in `attestation`. */
const DATA_SCHEMAS: Record<ReceiptKind, z.ZodTypeAny> = {
  test: z.object({
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
  }).strict(),
  mutant: z.object({
    applied: z.number().int().nonnegative().optional(),
    killed: z.number().int().nonnegative().optional(),
    survived: z.number().int().nonnegative().optional(),
  }).strict(),
  review: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    sessionId: z.string().optional(),
    verdict: z.enum(VERDICTS).optional(),
  }).strict(),
  device: z.object({
    deviceClass: z.enum(["real", "simulator", "emulator"]).optional(),
    deviceLabel: z.string().optional(),
    build: z.string().optional(),
  }).strict(),
};

const AttestationSchema = z.object({ builtFromSha: z.string().min(1), builtClean: z.boolean() }).strict();

export const ReceiptSchema = z.object({
  id: z.string().regex(RECEIPT_ID_REGEX),
  v: z.literal(1),
  kind: z.enum(RECEIPT_KINDS),
  target: z.string().min(1),
  unitRef: boundedString(RECEIPT_BOUNDS.refBytes).optional(),
  covers: z.array(boundedString(RECEIPT_BOUNDS.refBytes)).max(RECEIPT_BOUNDS.covers).optional(),
  repo: z.string().min(1),
  sha: z.string().min(1),
  base: z.string().min(1).optional(),
  revisions: z.record(z.unknown()),
  observation: z.object({
    head: z.string().nullable(),
    headMatchesSha: z.boolean(),
    worktree: z.unknown(),
  }).strict(),
  attestation: AttestationSchema.optional(),
  supersedes: z.array(z.string().regex(RECEIPT_ID_REGEX)).max(RECEIPT_BOUNDS.supersedes).optional(),
  result: z.enum(["pass", "fail", "error"]),
  data: z.record(z.unknown()).optional(),
  command: boundedString(RECEIPT_BOUNDS.commandBytes).optional(),
  evidence: boundedString(RECEIPT_BOUNDS.evidenceBytes).optional(),
  recordedAt: z.string().min(1),
  recordedBy: z.string().min(1),
}).strict().superRefine((r, ctx) => {
  const data = r.data ?? {};
  if (Object.keys(data).length > RECEIPT_BOUNDS.dataKeys) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: `at most ${RECEIPT_BOUNDS.dataKeys} keys` });
    return;
  }
  if (bytes(JSON.stringify(data)) > RECEIPT_BOUNDS.dataBytes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: `at most ${RECEIPT_BOUNDS.dataBytes} bytes` });
  }
  const parsed = DATA_SCHEMAS[r.kind].safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["data", ...issue.path] });
    return;
  }
  const d = parsed.data as Record<string, unknown>;
  const needsAttestation = r.kind === "test" || r.kind === "device";
  if (needsAttestation && !r.attestation) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attestation"], message: `${r.kind} receipts carry an attestation` });
  if (r.kind === "review" && !r.base) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["base"], message: "review receipts carry the base of the reviewed range" });
  if (r.kind !== "review" && r.base !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["base"], message: "only review receipts carry a base" });
  if (r.kind === "device" && !r.unitRef) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unitRef"], message: "device receipts name the unit they prove" });
  if (r.kind !== "device" && (r.unitRef !== undefined || r.covers !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [r.unitRef !== undefined ? "unitRef" : "covers"], message: "only device receipts carry unitRef and covers" });
  }
  // Contradictions refused at write (3.2).
  if (r.kind === "test" && r.result === "pass" && typeof d.failed === "number" && d.failed > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result"], message: "a passing test receipt reports no failures" });
  }
  if (r.kind === "mutant" && typeof d.applied === "number" && ((d.killed as number | undefined) ?? 0) + ((d.survived as number | undefined) ?? 0) > d.applied) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: "killed plus survived exceeds applied" });
  }
  if (r.kind === "review" && r.result === "pass" && d.verdict !== "approve") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result"], message: "a passing review receipt carries an approve verdict" });
  }
  if (r.kind === "device" && r.result === "pass" && r.attestation && r.attestation.builtFromSha !== r.sha) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attestation", "builtFromSha"], message: "a passing device receipt was built from its sha" });
  }
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export type ReceiptEntryRead =
  | { state: "ok"; index: number; receipt: Receipt }
  | { state: "malformed"; index: number; path: (string | number)[]; message: string }
  | { state: "no-id"; index: number }
  | { state: "unsupported-version"; index: number; id: string; v: unknown }
  | { state: "conflicted"; index: number; id: string }
  | { state: "conflicted-kept"; index: number; id: string };

export type ReceiptsRead =
  | { state: "missing" }
  | { state: "malformed" }
  | { state: "ok"; entries: ReceiptEntryRead[] };

/** The receipt ids an open `receipt` conflict entry names on this record. */
export function conflictedReceiptIds(record: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const conflicts = record._conflicts;
  if (!Array.isArray(conflicts)) return out;
  for (const c of conflicts) {
    if (c && typeof c === "object" && (c as { kind?: unknown }).kind === "receipt") {
      const id = (c as { id?: unknown }).id;
      if (typeof id === "string") out.add(id);
    }
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The id of a receipts element, when it has a string one. */
export function receiptElementId(element: unknown): string | undefined {
  return isObject(element) && typeof element.id === "string" && element.id.length > 0 ? element.id : undefined;
}

/**
 * Reads a record's receipts without ever throwing (3.4). `missing` and
 * `malformed` describe the field; `ok` carries one state per element.
 */
export function readReceipts(record: Record<string, unknown>): ReceiptsRead {
  if (!Object.prototype.hasOwnProperty.call(record, "receipts") || record.receipts === undefined) return { state: "missing" };
  const raw = record.receipts;
  if (!Array.isArray(raw)) return { state: "malformed" };
  const conflicted = conflictedReceiptIds(record);
  const counts = new Map<string, number>();
  for (const element of raw) {
    const id = receiptElementId(element);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const entries = raw.map((element, index): ReceiptEntryRead => {
    if (!isObject(element)) return { state: "malformed", index, path: [], message: "not an object" };
    const id = receiptElementId(element);
    if (!id) return { state: "no-id", index };
    if (typeof element.v === "number" && element.v > 1) return { state: "unsupported-version", index, id, v: element.v };
    if (conflicted.has(id)) return { state: "conflicted", index, id };
    if ((counts.get(id) ?? 0) > 1) return { state: "conflicted-kept", index, id };
    const parsed = ReceiptSchema.safeParse(element);
    if (!parsed.success) {
      const first = parsed.error.issues[0]!;
      return { state: "malformed", index, path: first.path, message: first.message };
    }
    return { state: "ok", index, receipt: parsed.data };
  });
  return { state: "ok", entries };
}

/** The receipt ids `storybloq resolve --keep both` recorded: their bodies share one id by the owner's choice. */
function keptBothIds(record: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const history = record.receiptResolutions;
  if (!Array.isArray(history)) return out;
  for (const e of history) {
    if (isObject(e) && e.kind === "receipt" && e.keep === "both" && typeof e.conflictId === "string") out.add(e.conflictId);
  }
  return out;
}

/**
 * C-v4.1 commit 7, ISS-1435 (pen ruling): the duplicate_id contradictions on a
 * record. A receipt id carried by two or more elements, with no open merge
 * conflict naming it (the merge driver already marks those through
 * _conflicts) and no keep-both resolution recorded for it, came from a union
 * made without the driver or by hand. Every copy already reads
 * `conflicted-kept` (never `ok`), so none counts; this is the hold. A later
 * `ok` receipt whose supersedes names the id supersedes every copy and lifts
 * it, the repair the hold text names. Sorted.
 */
export function duplicateReceiptHolds(record: Record<string, unknown>): string[] {
  const raw = record.receipts;
  if (!Array.isArray(raw)) return [];
  const counts = new Map<string, number>();
  for (const element of raw) {
    const id = receiptElementId(element);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const conflicted = conflictedReceiptIds(record);
  const kept = keptBothIds(record);
  const superseded = new Set<string>();
  const read = readReceipts(record);
  if (read.state === "ok") for (const e of read.entries) if (e.state === "ok") for (const s of e.receipt.supersedes ?? []) superseded.add(s);
  return [...counts]
    .filter(([id, n]) => n > 1 && !conflicted.has(id) && !kept.has(id) && !superseded.has(id))
    .map(([id]) => id)
    .sort();
}

/** The hold text for one duplicate_id contradiction: it names the repair. */
export const duplicateHoldText = (id: string): string => `duplicate receipt id ${id}: add a new receipt that supersedes ${id}`;

// --- 3.7 current attempts: the one place attempt order is decided ---

export type AttemptOutcome = "none" | "concurrent" | "failing" | "pass";

export interface CurrentAttempts {
  readonly outcome: AttemptOutcome;
  /** The current set itself; callers never read `pass` without it (A1). */
  readonly current: Receipt[];
}

/**
 * C-v4.1 3.7, shared by landing-ready (7) and proof (5.5). `inScope` is the
 * caller's scope tuple. Current attempts are the in-scope `ok` receipts that
 * no in-scope receipt supersedes; a superseder counts whatever its result or
 * device class (fail closed), and one outside the scope does not count. Ids,
 * array order and timestamps never decide.
 */
export function currentAttempts(receipts: readonly Receipt[], inScope: (r: Receipt) => boolean): CurrentAttempts {
  const scoped = receipts.filter(inScope);
  const superseded = new Set<string>();
  for (const r of scoped) for (const s of r.supersedes ?? []) superseded.add(s);
  const current = scoped.filter((r) => !superseded.has(r.id));
  if (current.length === 0) return { outcome: "none", current };
  const passes = current.some((r) => r.result === "pass");
  const fails = current.some((r) => r.result !== "pass");
  if (passes && fails) return { outcome: "concurrent", current };
  if (fails) return { outcome: "failing", current };
  return { outcome: "pass", current };
}
