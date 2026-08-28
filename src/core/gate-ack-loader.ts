import { readdirSync, type Dirent } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GateAckSchema, computeGateAckId, type GateAck, type GateAckPin } from "../models/gate-ack.js";
import type { ArrangementRole } from "../models/arrangement.js";
import { readBoundedRegularFile } from "./pin-utils.js";
import { sanitizeDisplayText } from "./display-text.js";
import { atomicCreate, atomicWrite, guardPath, serializeJSON } from "./project-loader.js";
import { ProjectLoaderError } from "./errors.js";

/** A real ack record is a few hundred bytes; same reasoning as T-473's arrangement ceiling. */
const GATE_ACK_MAX_BYTES = 65_536;

export type GateAckLookupResult =
  | { status: "absent" }
  | { status: "unreadable"; reason: string }
  | { status: "contested"; ack: GateAck }
  | { status: "valid"; ack: GateAck };

/**
 * Targeted, single-file, permission-decision lookup -- deliberately NOT an
 * enumerate-the-directory-and-warn-and-skip reader like T-473's
 * `loadArrangementsSafe`. That asymmetry is intentional: arrangement data is
 * descriptive (a corrupt entry there degrades an announcement, never blocks
 * a write), whereas a gate-ack's presence is what UNLOCKS a transition, so
 * every failure mode short of a clean, matching, valid (or contested) record
 * reports `unreadable` or `absent` here -- never silently absorbed.
 *
 * Reads via `readBoundedRegularFile` (pin-utils.ts), not a separate
 * `lstatSync` check followed by a second read call: this reader's own
 * contract above requires it to never conflate "absent" with "unreadable",
 * and a two-syscall lstat-then-read pair reintroduces exactly the TOCTOU gap
 * that primitive's single open-fstat-read-on-one-fd design exists to close.
 */
export function findGateAck(root: string, query: {
  arrangementId: string;
  gateName: string;
  ticketRef: string;
  pin: GateAckPin;
  expectedAckRole: ArrangementRole; // deltas is deliberately NOT part of the query -- see gate-ack.ts's computeGateAckId
}): GateAckLookupResult {
  const id = computeGateAckId(query.arrangementId, query.gateName, query.ticketRef, query.pin);
  const path = resolve(root, ".story", "arrangement-acks", `${id}.json`);
  const fileResult = readBoundedRegularFile(path, GATE_ACK_MAX_BYTES);
  if (fileResult.status === "missing") return { status: "absent" };
  if (fileResult.status !== "ok") {
    return { status: "unreadable", reason: `arrangement-acks/${id}.json: ${sanitizeDisplayText(fileResult.reason)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileResult.bytes.toString("utf-8"));
  } catch {
    return { status: "unreadable", reason: `arrangement-acks/${id}.json: invalid JSON` };
  }
  const result = GateAckSchema.safeParse(parsed);
  if (!result.success) return { status: "unreadable", reason: `arrangement-acks/${id}.json: schema mismatch` };
  const rec = result.data;

  // Direct field comparison against the query -- the actual authorization
  // proof, independent of any property of the hash.
  if (
    rec.arrangementId !== query.arrangementId ||
    rec.gateName !== query.gateName ||
    rec.ticketRef !== query.ticketRef ||
    JSON.stringify(rec.pin) !== JSON.stringify(query.pin)
  ) {
    return { status: "unreadable", reason: `arrangement-acks/${id}.json: record fields do not match the queried authorization` };
  }
  // Recompute from the record's OWN fields too, catching a hand-edited field
  // left inconsistent with an unchanged filename/embedded id.
  const recomputed = computeGateAckId(rec.arrangementId, rec.gateName, rec.ticketRef, rec.pin);
  if (recomputed !== id || rec.id !== id) {
    return { status: "unreadable", reason: `arrangement-acks/${id}.json: content id does not match computed id` };
  }
  if (rec.ackRole !== query.expectedAckRole) {
    return {
      status: "unreadable",
      reason: `arrangement-acks/${id}.json: recorded ackRole (${rec.ackRole}) does not match the gate's required role (${query.expectedAckRole})`,
    };
  }
  if (rec.contested) return { status: "contested", ack: rec };
  return { status: "valid", ack: rec };
}

/**
 * Enumerate every ack for the CLI `gate-ack list` command -- informational,
 * warn-and-skip, mirrors `loadArrangementsSafe`'s posture exactly. Never
 * used for a permission decision (that is `findGateAck`'s job alone).
 */
export function readGateAcksForListing(root: string): { acks: readonly GateAck[]; warnings: readonly string[] } {
  const dir = resolve(root, ".story", "arrangement-acks");
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { acks: [], warnings: [] };
    return { acks: [], warnings: [`Could not read .story/arrangement-acks/: ${sanitizeDisplayText(String(err))}`] };
  }

  const acks: GateAck[] = [];
  const warnings: string[] = [];
  for (const entry of dirents) {
    const file = entry.name;
    if (!file.endsWith(".json")) continue;
    if (!entry.isFile()) {
      warnings.push(`arrangement-acks/${sanitizeDisplayText(file)}: not a regular file, skipped`);
      continue;
    }
    const fileResult = readBoundedRegularFile(join(dir, file), GATE_ACK_MAX_BYTES);
    if (fileResult.status !== "ok") {
      warnings.push(`arrangement-acks/${sanitizeDisplayText(file)}: ${fileResult.status === "missing" ? "vanished during scan" : fileResult.reason}, skipped`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fileResult.bytes.toString("utf-8"));
    } catch {
      warnings.push(`arrangement-acks/${sanitizeDisplayText(file)}: invalid JSON`);
      continue;
    }
    const result = GateAckSchema.safeParse(parsed);
    if (!result.success) {
      warnings.push(`arrangement-acks/${sanitizeDisplayText(file)}: schema mismatch`);
      continue;
    }
    if (file !== `${result.data.id}.json`) {
      warnings.push(`arrangement-acks/${sanitizeDisplayText(file)}: filename does not match record id, skipped`);
      continue;
    }
    acks.push(result.data);
  }
  return { acks, warnings };
}

/**
 * Idempotent create. Since the id is a pure function of
 * (arrangementId, gateName, ticketRef, pin) -- ackRole and deltas are
 * deliberately NOT id material -- two writes producing the same id are, by
 * construction, the same core authorization. `deltas` is the one field that
 * can legitimately vary and needs its own conflict rule:
 *   - existing record's deltas === incoming deltas (including both absent)
 *     -> no-op, return the existing record unchanged, never rewritten.
 *   - existing record's deltas !== incoming deltas -> throw. A second
 *     attempt to ack the identical pin with DIFFERENT ratification
 *     conditions is a genuine conflict between two acking attempts, not a
 *     retry, and must never be resolved by silently picking either one.
 */
export async function writeGateAckUnlocked(ack: GateAck, root: string): Promise<GateAck> {
  const parsed = GateAckSchema.parse(ack);
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "arrangement-acks", `${parsed.id}.json`);

  const existing = findGateAck(root, {
    arrangementId: parsed.arrangementId,
    gateName: parsed.gateName,
    ticketRef: parsed.ticketRef,
    pin: parsed.pin,
    expectedAckRole: parsed.ackRole,
  });
  if (existing.status === "valid" || existing.status === "contested") {
    if ((existing.ack.deltas ?? "") === (parsed.deltas ?? "")) return existing.ack;
    throw new ProjectLoaderError(
      "invalid_input",
      `gate-ack ${parsed.id} already exists with different deltas -- this is a conflict between two acking attempts, not a retry`,
    );
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await guardPath(targetPath, wrapDir);
  await atomicCreate(targetPath, serializeJSON(parsed));
  return parsed;
}

/** The one post-creation mutation an ack record permits (acceptance 6). */
export async function writeGateAckContested(id: string, reason: string, root: string): Promise<GateAck> {
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "arrangement-acks", `${id}.json`);
  const fileResult = readBoundedRegularFile(targetPath, GATE_ACK_MAX_BYTES);
  if (fileResult.status !== "ok") {
    throw new ProjectLoaderError("not_found", `gate-ack ${id} not found or unreadable`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileResult.bytes.toString("utf-8"));
  } catch {
    throw new ProjectLoaderError("io_error", `gate-ack ${id} is not valid JSON`);
  }
  const result = GateAckSchema.safeParse(parsed);
  if (!result.success) throw new ProjectLoaderError("io_error", `gate-ack ${id} failed schema validation`);

  const updated = GateAckSchema.parse({ ...result.data, contested: true, contestedReason: reason });
  await guardPath(targetPath, wrapDir);
  await atomicWrite(targetPath, serializeJSON(updated));
  return updated;
}
