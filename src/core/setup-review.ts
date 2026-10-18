/**
 * T-536: the setup review store, the review packet and the package's two
 * review lines.
 *
 * A setup review counts only when the CLI itself ran the reviewer on a review
 * packet, stored the reviewer's raw answer bound to the exact packet bytes, and
 * produced the package's lines from that record. Everything here reads or
 * writes the store under the OS temp directory, never the project folder: the
 * setup flow promises nothing is written there until the owner approves.
 *
 * The hash checks below catch accidental damage and mismatches. They are not a
 * defence against deliberate forgery: the store is the user's, and so is any
 * key the CLI could keep in it.
 */
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isUtf8 } from "node:buffer";
import { parseReviewerOutput, type SetupReviewBackend } from "./setup-review-backends.js";

export const PACKET_SECTIONS = ["Source requirements", "Owner answers and decisions", "Existing-state evidence", "Plan"] as const;
export type PacketSection = (typeof PACKET_SECTIONS)[number];

export const STOP_LINES = [
  "No supported reviewer is available to review this plan.",
  "How should I proceed?",
  "Retry the review",
  "Continue without independent review",
] as const;

export const SETUP_ID_PATTERN = /^SS-[0-9a-f]{8}$/;
export const RECORD_ID_PATTERN = /^SR-[0-9a-f]{8}$/;
export const ROUNDS_PER_CYCLE = 2;
export const PLAN_VERDICTS = ["approve", "revise", "reject"] as const;
export type PlanVerdict = (typeof PLAN_VERDICTS)[number];

/** A usage problem: exit 2, nothing spawned, nothing recorded. */
export class SetupReviewUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupReviewUsageError";
  }
}

export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
export const digest12 = (revisionSha256: string): string => revisionSha256.slice(0, 12);

export interface ReviewPacket {
  readonly bytes: Buffer;
  readonly revisionSha256: string;
  readonly sections: Record<PacketSection, string>;
  readonly sectionSha256s: Record<PacketSection, string>;
}

/**
 * The packet is exactly four level-2 headings in order, each non-empty, and
 * nothing before the first. Any other level-2 heading is refused rather than
 * folded into a neighbour, so a section cannot hide inside another.
 */
export function parsePacket(bytes: Buffer): ReviewPacket {
  if (!isUtf8(bytes)) throw new SetupReviewUsageError("The review packet is not valid UTF-8.");
  const text = bytes.toString("utf-8");
  const lines = text.split("\n");
  const headings: Array<{ name: string; line: number }> = [];
  lines.forEach((line, i) => {
    const m = /^## (.*?)\r?$/.exec(line);
    if (m) headings.push({ name: m[1]!, line: i });
  });
  if (headings.length === 0 || headings[0]!.line !== 0) {
    throw new SetupReviewUsageError("The review packet must start with the heading \"## Source requirements\".");
  }
  for (const h of headings) {
    if (!(PACKET_SECTIONS as readonly string[]).includes(h.name)) {
      throw new SetupReviewUsageError(`The review packet has an unknown section "## ${h.name}".`);
    }
  }
  const names = headings.map((h) => h.name);
  if (new Set(names).size !== names.length) throw new SetupReviewUsageError("The review packet repeats a section.");
  for (const name of PACKET_SECTIONS) {
    if (!names.includes(name)) throw new SetupReviewUsageError(`The review packet is missing the section "## ${name}".`);
  }
  if (names.some((n, i) => n !== PACKET_SECTIONS[i])) {
    throw new SetupReviewUsageError(`The review packet sections are out of order; they must be: ${PACKET_SECTIONS.join(", ")}.`);
  }
  const sections = {} as Record<PacketSection, string>;
  const sectionSha256s = {} as Record<PacketSection, string>;
  headings.forEach((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1]!.line : lines.length;
    const body = lines.slice(h.line + 1, end).join("\n");
    if (body.trim() === "") throw new SetupReviewUsageError(`The review packet section "## ${h.name}" is empty; write "none" if there is nothing.`);
    sections[h.name as PacketSection] = body.trim();
    sectionSha256s[h.name as PacketSection] = sha256(body);
  });
  return { bytes, revisionSha256: sha256(bytes), sections, sectionSha256s };
}

/**
 * The only normalisation the package comparison allows, applied identically to
 * both sides: CRLF to LF, trailing spaces and tabs removed, each run of blank
 * lines collapsed to one, blank lines removed from both ends.
 */
export function normalizeBlock(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

// --- Store layout -----------------------------------------------------------

export function storeRoot(env: NodeJS.ProcessEnv): string {
  const override = env.STORYBLOQ_SETUP_REVIEW_DIR;
  if (override) return override;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `storybloq-setup-review-${uid}`);
}

export function projectKeyFor(cwd: string): string {
  return sha256(realpathSync(cwd)).slice(0, 16);
}

export interface SetupPaths {
  readonly setupId: string;
  readonly projectKey: string;
  readonly dir: string;
  readonly setupFile: string;
  readonly records: string;
  readonly revisions: string;
  readonly lock: string;
}

export function setupPaths(env: NodeJS.ProcessEnv, cwd: string, setupId: string): SetupPaths {
  if (!SETUP_ID_PATTERN.test(setupId)) throw new SetupReviewUsageError(`"${setupId}" is not a setup id.`);
  const projectKey = projectKeyFor(cwd);
  const dir = join(storeRoot(env), projectKey, setupId);
  return { setupId, projectKey, dir, setupFile: join(dir, "setup.json"), records: join(dir, "records"), revisions: join(dir, "revisions"), lock: join(dir, "run.lock") };
}

export interface ProbeResult {
  readonly backend: SetupReviewBackend;
  readonly version: string;
}

export interface SetupState {
  setupId: string;
  projectKey: string;
  createdAt: string;
  cycle: number;
  cycleReasons: Record<string, string>;
  probe: ProbeResult | null;
  probedAt: string;
  skipped?: { at: string };
}

export function readSetup(paths: SetupPaths): SetupState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.setupFile, "utf-8"));
  } catch {
    throw new SetupReviewUsageError("No such setup. Run storybloq setup-review gate first and keep its setup id.");
  }
  const s = raw as SetupState;
  if (!s || typeof s !== "object" || typeof s.cycle !== "number" || !Number.isInteger(s.cycle) || s.cycle < 1
    || s.setupId !== paths.setupId || s.projectKey !== paths.projectKey) {
    throw new SetupReviewUsageError("The setup record is damaged. Run storybloq setup-review gate to open a new setup.");
  }
  return s;
}

/**
 * Write, fsync, rename into place, then fsync the directory, so a reader sees
 * the old file or the new one and the new one survives a crash once this
 * returns. `sync` is the fsync used for both, a seam for tests.
 */
export function writeFileDurable(path: string, data: string | Buffer, sync: (fd: number) => void = fsyncSync): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, data);
    sync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path), sync);
}

export function writeFileSynced(path: string, data: string | Buffer): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The codes a filesystem that cannot sync a directory at all answers with; any other failure is real. */
const DIR_SYNC_UNSUPPORTED: readonly string[] = process.platform === "win32" ? ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EPERM"] : ["EINVAL", "ENOTSUP", "EOPNOTSUPP"];

export function fsyncDir(path: string, sync: (fd: number) => void = fsyncSync): void {
  try {
    const fd = openSync(path, "r");
    try {
      sync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    if (DIR_SYNC_UNSUPPORTED.includes((e as NodeJS.ErrnoException).code ?? "")) return;
    throw e;
  }
}

/**
 * Content-addressed revision artifact: every packet `run` or `status` receives
 * is kept, reviewed or not, so a revision a package names always exists.
 */
export function persistRevision(paths: SetupPaths, packet: ReviewPacket): void {
  mkdirSync(paths.revisions, { recursive: true, mode: 0o700 });
  const file = join(paths.revisions, `${packet.revisionSha256}.md`);
  if (existsSync(file)) {
    if (sha256(readFileSync(file)) === packet.revisionSha256) return;
  }
  writeFileDurable(file, packet.bytes);
}

// --- Records ----------------------------------------------------------------

export type FailureKind = "timeout" | "exit" | "schema-invalid" | "spawn" | "persist";

export interface CompletedRecord {
  state: "completed";
  recordId: string;
  setupId: string;
  cycle: number;
  round: number;
  revisionSha256: string;
  sectionSha256s: Record<PacketSection, string>;
  backend: SetupReviewBackend;
  backendVersion: string;
  startedAt: string;
  endedAt: string;
  exitCode: 0;
  outputSha256: string;
  verdict: PlanVerdict;
  findingsCount: number;
  reviewerSessionId: string | null;
  newCycleReason: string | null;
}

export interface FailedRecord {
  state: "failed";
  recordId: string;
  setupId: string;
  cycle: number;
  revisionSha256: string;
  backend: SetupReviewBackend;
  backendVersion: string;
  startedAt: string;
  endedAt: string;
  failure: FailureKind;
  exitCode: number | null;
  outputSha256: string | null;
  error: string;
}

export type SetupReviewRecord = CompletedRecord | FailedRecord;

const isStr = (v: unknown): v is string => typeof v === "string";
const isHex64 = (v: unknown): v is string => isStr(v) && /^[0-9a-f]{64}$/.test(v);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const BACKENDS: readonly string[] = ["codex", "claude"];
const FAILURES: readonly string[] = ["timeout", "exit", "schema-invalid", "spawn", "persist"];

function baseFieldsValid(r: Record<string, unknown>, recordId: string): boolean {
  return r.recordId === recordId && isStr(r.setupId) && isPosInt(r.cycle) && isHex64(r.revisionSha256)
    && BACKENDS.includes(r.backend as string) && isStr(r.backendVersion) && isStr(r.startedAt) && isStr(r.endedAt);
}

/** The record's own shape, without its artifacts. Null when it matches neither schema. */
export function recordShape(raw: unknown, recordId: string): SetupReviewRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!baseFieldsValid(r, recordId)) return null;
  if (r.state === "completed") {
    const ok = isPosInt(r.round) && (r.round as number) <= ROUNDS_PER_CYCLE && r.exitCode === 0 && isHex64(r.outputSha256)
      && (PLAN_VERDICTS as readonly string[]).includes(r.verdict as string)
      && typeof r.findingsCount === "number" && Number.isInteger(r.findingsCount) && (r.findingsCount as number) >= 0
      && (r.reviewerSessionId === null || isStr(r.reviewerSessionId))
      && (r.newCycleReason === null || isStr(r.newCycleReason))
      && !!r.sectionSha256s && typeof r.sectionSha256s === "object"
      && PACKET_SECTIONS.every((s) => isHex64((r.sectionSha256s as Record<string, unknown>)[s]));
    return ok ? (r as unknown as CompletedRecord) : null;
  }
  if (r.state === "failed") {
    const ok = FAILURES.includes(r.failure as string) && !("round" in r) && !("verdict" in r) && !("findingsCount" in r)
      && (r.exitCode === null || (typeof r.exitCode === "number" && Number.isInteger(r.exitCode)))
      && (r.outputSha256 === null || isHex64(r.outputSha256)) && isStr(r.error);
    return ok ? (r as unknown as FailedRecord) : null;
  }
  return null;
}

function fileSha(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Artifacts against the record. A completed record needs its packet and its
 * raw output, both hashing to their stored values, and the verdict re-parsed
 * from that output must equal the stored one. A failed record needs its packet;
 * its output exists exactly when its hash is stored, and is never parsed: an
 * invalid or absent answer is what a failed record records.
 */
export function artifactsValid(dir: string, rec: SetupReviewRecord): boolean {
  if (fileSha(join(dir, "packet.md")) !== rec.revisionSha256) return false;
  const outputPath = join(dir, "reviewer-output.json");
  if (rec.state === "completed") {
    if (fileSha(outputPath) !== rec.outputSha256) return false;
    try {
      const review = parseReviewerOutput(rec.backend, readFileSync(outputPath));
      return review.verdict === rec.verdict && review.findings.length === rec.findingsCount;
    } catch {
      return false;
    }
  }
  if (rec.outputSha256 === null) return !existsSync(outputPath);
  return fileSha(outputPath) === rec.outputSha256;
}

export type LoadedRecord =
  | { readonly recordId: string; readonly kind: "valid"; readonly record: SetupReviewRecord }
  | { readonly recordId: string; readonly kind: "invalid"; readonly record: SetupReviewRecord }
  | { readonly recordId: string; readonly kind: "unparsed" };

/**
 * Every published record; staging directories are never records. A record
 * naming another setup was copied here and is checked like a damaged one: it
 * neither certifies nor counts.
 */
export function loadRecords(paths: SetupPaths): LoadedRecord[] {
  let names: string[];
  try {
    names = readdirSync(paths.records);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: LoadedRecord[] = [];
  for (const recordId of names.filter((n) => RECORD_ID_PATTERN.test(n)).sort()) {
    const dir = join(paths.records, recordId);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, "record.json"), "utf-8"));
    } catch {
      out.push({ recordId, kind: "unparsed" });
      continue;
    }
    const record = recordShape(raw, recordId);
    if (!record) {
      out.push({ recordId, kind: "unparsed" });
      continue;
    }
    out.push({ recordId, kind: record.setupId === paths.setupId && artifactsValid(dir, record) ? "valid" : "invalid", record });
  }
  return out;
}

const byEnd = (a: SetupReviewRecord, b: SetupReviewRecord): number => a.endedAt.localeCompare(b.endedAt) || a.recordId.localeCompare(b.recordId);

/** Completed rounds in a cycle, in order. */
export function completedInCycle(records: readonly LoadedRecord[], cycle: number): CompletedRecord[] {
  return records
    .filter((r): r is Extract<LoadedRecord, { kind: "valid" }> => r.kind === "valid")
    .map((r) => r.record)
    .filter((r): r is CompletedRecord => r.state === "completed" && r.cycle === cycle)
    .sort((a, b) => a.round - b.round || byEnd(a, b));
}

export type Classification =
  | { readonly kind: "unreadable"; readonly recordId: string; readonly record: SetupReviewRecord | null }
  | { readonly kind: "completed"; readonly record: CompletedRecord }
  | { readonly kind: "round-limit"; readonly last: CompletedRecord }
  | { readonly kind: "failed"; readonly record: FailedRecord }
  | { readonly kind: "absent" };

/**
 * The status classification for one revision, in the plan's order. A record
 * whose revision cannot be known blocks every revision; a record for this
 * revision that fails its own schema's checks blocks this one. A valid failed
 * record is never unreadable, and a completed record supersedes failed ones.
 */
export function classify(records: readonly LoadedRecord[], revisionSha256: string, cycle: number): Classification {
  const unparsed = records.find((r) => r.kind === "unparsed");
  if (unparsed) return { kind: "unreadable", recordId: unparsed.recordId, record: null };
  const mine = records.filter((r) => r.kind !== "unparsed" && r.record.revisionSha256 === revisionSha256) as Array<Exclude<LoadedRecord, { kind: "unparsed" }>>;
  const invalid = mine.find((r) => r.kind === "invalid");
  if (invalid) return { kind: "unreadable", recordId: invalid.recordId, record: invalid.record };
  const completed = mine.map((r) => r.record).filter((r): r is CompletedRecord => r.state === "completed").sort(byEnd);
  if (completed.length > 0) return { kind: "completed", record: completed[completed.length - 1]! };
  const rounds = completedInCycle(records, cycle);
  if (rounds.length >= ROUNDS_PER_CYCLE) return { kind: "round-limit", last: rounds[rounds.length - 1]! };
  const failed = mine.map((r) => r.record).filter((r): r is FailedRecord => r.state === "failed").sort(byEnd);
  if (failed.length > 0) return { kind: "failed", record: failed[failed.length - 1]! };
  return { kind: "absent" };
}

// --- Lines --------------------------------------------------------------------

export const probeLine = (probe: ProbeResult | null): string =>
  probe ? `Reviewer probe: ${probe.backend} ${probe.version}` : "Reviewer probe: none available";

export const probeOf = (rec: SetupReviewRecord): ProbeResult => ({ backend: rec.backend, version: rec.backendVersion });

export const completedLine = (rec: CompletedRecord): string =>
  `Independent review: ${rec.verdict}, invocation ${rec.recordId}, revision ${digest12(rec.revisionSha256)}`;

export const roundLimitLine = (revisionSha256: string, last: CompletedRecord): string =>
  `Independent review: revision ${digest12(revisionSha256)} not reviewed, round limit reached; last review ${last.verdict}, invocation ${last.recordId}, revision ${digest12(last.revisionSha256)}`;

/**
 * T-538 (review r1 #7): the full revision status names, the value a material
 * resolution sends as reviewRevision. Never part of the package's two lines.
 */
export const revisionLine = (revisionSha256: string): string => `Revision: ${revisionSha256}`;

export const absentLine = (revisionSha256: string): string => `Independent review: none for revision ${digest12(revisionSha256)}`;

export const failedLine = (revisionSha256: string, recordId: string): string =>
  `Independent review: failed for revision ${digest12(revisionSha256)}, invocation ${recordId}`;

export const unreadableLine = (recordId: string): string => `Independent review: record unreadable, invocation ${recordId}`;

export const SKIPPED_LINE = "Independent review: skipped at the owner's request";
