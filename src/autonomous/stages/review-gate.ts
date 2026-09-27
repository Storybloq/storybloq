/**
 * ISS-1282: the review stages' side of the bridge receipt gate.
 *
 * `review-gate-receipt.ts` decides whether a receipt proves a gate-grade
 * review; this file supplies what it needs from the session (the real git
 * probe, the item's own diff, the owner's Gemini ruling), counts refusals
 * durably, and renders the one instruction text both stages share, so the
 * wording cannot drift between them (the ISS-1114 rule).
 *
 * Runs BEFORE the provenance gate and `prepareReviewRound`, so a refused
 * report leaves no envelope, no artifact, no round and no repair attempt.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRulingsSafe } from "../../core/ruling-loader.js";
import type { FullSessionState, GuideReportInput } from "../session-types.js";
import {
  assessCodeReceipts,
  assessPlanReceipt,
  MAX_RANGE_LINES,
  parseNumstatZ,
  RANGE_TOKEN,
  RECEIPT_ATTESTATION,
  type GateEvidence,
  type NumstatEntry,
  type ObservedReviewer,
  type ReceiptProbe,
} from "../review-gate-receipt.js";
import { currentStorybloqClient } from "./codex-native.js";
import type { StageContext } from "./types.js";

const GIT_TIMEOUT_MS = 10_000;
/** Third refusal in the session: name the agent fallback. */
export const GATE_ESCAPE_AT = 3;
/** Fifth refusal in the session: stop asking the bridge. */
export const GATE_UNAVAILABLE_AT = 5;

export type GateStage = "code" | "plan";

/** The refusal key, the same shape and ordinal as a repair key. */
export interface GateKey {
  readonly workItemId: string;
  readonly kind: "ticket" | "issue";
  readonly stage: GateStage;
  readonly round: number;
}

/** What a landed round records about the gate. */
export interface ReviewGateRecord {
  readonly observed: readonly ObservedReviewer[];
  readonly disclosure?: string;
}

export type BridgeGateOutcome =
  | { readonly kind: "not-applicable" }
  | {
    readonly kind: "pass";
    readonly reviewGate: ReviewGateRecord;
    /** Provenance built from the receipt, replacing the free-text fields. */
    readonly reportOverride: { readonly reviewerModel: string; readonly reviewerTier: "max"; readonly reviewerEvidence: "observed" };
  }
  | { readonly kind: "retry"; readonly instruction: string };

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/**
 * The bridge review rules, one text for both stages. `baseline` is the
 * item's diff base (`reviewBaseline`); the code rules name it because every
 * reviewed range must chain from it.
 */
export function bridgeReviewRules(stage: GateStage, baseline?: string | null): string {
  const perCall = "`models` (that call's result `models[]` verbatim) and `sessionId` (the session id it returned)";
  if (stage === "plan") {
    return [
      "Call `review_plan` with `tier: \"max\"`, never `model`.",
      "The reviewer must open its summary with `REVIEWED: plan.md (~N lines)`.",
      `Report \`reviewReceipts\` as \`{ "receipt": "<that line>", "planSha256": "<sha256 of the exact plan text you sent>", "models", "sessionId" }\` with ${perCall}.`,
      RECEIPT_ATTESTATION,
    ].join(" ");
  }
  return [
    "Call `review_code` by range in a standalone clone: `cwd`, `base`, `head`, never an inline diff.",
    `Use \`tier: "max"\`, never \`model\`. Keep each range at most ${MAX_RANGE_LINES} changed lines; split with synthetic commits that partition the diff.`,
    `Chain the ranges from the item baseline${baseline ? ` \`${baseline}\`` : ""} to a head holding the working tree: each file's first range starts at the baseline, each later range starts where that file's previous range ended; no gaps, no repeats.`,
    `The reviewer must open each summary with \`REVIEWED: <path> (~N changed lines)\`, where <path> is the range's only changed file, or \`${RANGE_TOKEN}\` when it changes several.`,
    `Report \`reviewReceipts\` as \`[{ "cwd", "base", "head", "receipt", "models", "sessionId" }]\`, one per call in chain order, each with ${perCall}.`,
    RECEIPT_ATTESTATION,
  ].join(" ");
}

/**
 * The commit every bridge review of the current item must start from: the
 * recorded diff base (`mergeBase`), else the commit the item started from,
 * else HEAD at session start. Null when the session recorded none.
 */
export function reviewBaseline(state: FullSessionState): string | null {
  return state.git.mergeBase ?? state.git.itemBaseHead ?? state.git.initHead ?? null;
}

export function isBridgeCodex(reviewerBackend: string): boolean {
  return reviewerBackend === "codex" && currentStorybloqClient() === "claude";
}

/** The record/artifact shape: plain mutable copies, disclosure only when present. */
export function reviewGateField(g: ReviewGateRecord): { observed: { provider: string; model: string }[]; disclosure?: string } {
  return {
    observed: g.observed.map((o) => ({ provider: o.provider, model: o.model })),
    ...(g.disclosure ? { disclosure: g.disclosure } : {}),
  };
}

// ---------------------------------------------------------------------------
// Refusal counting
// ---------------------------------------------------------------------------

type RefusalRecord = FullSessionState["reviewGateRefusals"][number];

const sameKey = (r: RefusalRecord, key: GateKey): boolean =>
  r.workItemId === key.workItemId && r.kind === key.kind && r.stage === key.stage && r.round === key.round;

/** Refusals on one round's key: what `gateRefusalsBeforeAccept` records. */
export function countGateRefusals(refusals: readonly RefusalRecord[] | undefined, key: GateKey | null): number {
  if (key === null) return 0;
  return (refusals ?? []).filter((r) => sameKey(r, key)).length;
}

/** Refusals across the whole session, every item, stage and round: what escalation reads. */
export function sessionGateRefusals(refusals: readonly RefusalRecord[] | undefined): number {
  return (refusals ?? []).length;
}

/** `{ gateRefusalsBeforeAccept }` when nonzero, else nothing, for a record or artifact spread. */
export function refusalsField(state: FullSessionState, key: GateKey | null): { gateRefusalsBeforeAccept?: number } {
  const n = countGateRefusals(state.reviewGateRefusals, key);
  return n > 0 ? { gateRefusalsBeforeAccept: n } : {};
}

/** Why an agent round stood in for the bridge, recorded on the round itself. */
export interface GateFallbackRecord {
  readonly reason: "codex-unavailable" | "bridge-refusals";
  /** Refused bridge reports in the session when the round landed. */
  readonly sessionRefusals: number;
}

/**
 * `{ gateFallback }` for an agent round that stood in for the bridge, else
 * nothing. Recorded when the round lands, from what selected it: Codex marked
 * unavailable steered the round away from Codex, or the round was Codex's and
 * the session had refused bridge reports. The refusals need not be on this
 * round's key, so a fallback after the cutoff is still disclosed.
 */
export function fallbackField(
  state: FullSessionState,
  round: { readonly reviewer: string; readonly computedReviewer: string; readonly backends: readonly string[] },
): { gateFallback?: GateFallbackRecord } {
  if (round.reviewer !== "agent" || !round.backends.includes("codex")) return {};
  const sessionRefusals = sessionGateRefusals(state.reviewGateRefusals);
  if (state.codexUnavailable === true && round.computedReviewer !== "codex") {
    return { gateFallback: { reason: "codex-unavailable", sessionRefusals } };
  }
  if (round.computedReviewer === "codex" && sessionRefusals > 0) {
    return { gateFallback: { reason: "bridge-refusals", sessionRefusals } };
  }
  return {};
}

/**
 * The FINALIZE line for a gate an agent round satisfied in the bridge's place
 * (pen decision 1): the round stays an agent round, and the commit says so and
 * why. A round landed before `gateFallback` existed falls back to its keyed count.
 */
export function agentFallbackLines(state: FullSessionState): string[] {
  const out: string[] = [];
  const last = (rounds: readonly Record<string, unknown>[] | undefined, label: string): void => {
    const r = rounds && rounds.length > 0 ? rounds[rounds.length - 1]! : null;
    if (!r || r.reviewer !== "agent") return;
    const f = r.gateFallback as GateFallbackRecord | undefined;
    const n = r.gateRefusalsBeforeAccept;
    if (f?.reason === "codex-unavailable") {
      out.push(`${label} gate satisfied by agent fallback: Codex was marked unavailable (${f.sessionRefusals} refused bridge reports in this session).`);
    } else if (f?.reason === "bridge-refusals") {
      out.push(`${label} gate satisfied by agent fallback after ${f.sessionRefusals} refused bridge reports in this session.`);
    } else if (typeof n === "number" && n > 0) {
      out.push(`${label} gate satisfied by agent fallback after ${n} bridge refusals.`);
    }
  };
  last(state.reviews.plan as unknown as Record<string, unknown>[], "Plan review");
  last(state.reviews.code as unknown as Record<string, unknown>[], "Code review");
  return out;
}

// ---------------------------------------------------------------------------
// Session inputs
// ---------------------------------------------------------------------------

function run(cwd: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim() || "git failed"));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * The first `n` bytes of a blob, read as a stream and cut off there, so a blob
 * of any size costs `n` bytes and never meets a buffer limit.
 */
function blobHead(cwd: string, oid: string, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "blob", oid], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      if (cut) return;
      chunks.push(b);
      size += b.length;
      if (size >= n) {
        cut = true;
        child.stdout.destroy();
        child.kill();
      }
    });
    child.stderr.on("data", (b: Buffer) => { if (stderr.length < 4096) stderr += b.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (cut || code === 0) resolve(Buffer.concat(chunks).subarray(0, n));
      else reject(new Error(stderr.trim() || `git cat-file ended with ${code ?? signal}`));
    });
  });
}

/**
 * No textconv filter, no external diff, and every submodule counted whatever
 * the local config says: the counts are git's own, of the stored content.
 */
const NUMSTAT = ["diff", "--numstat", "-z", "--no-renames", "--no-textconv", "--no-ext-diff", "--ignore-submodules=none"] as const;
const RAW = ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-textconv", "--no-ext-diff", "--ignore-submodules=none"] as const;
/** Git's own test (`buffer_is_binary`): a NUL in the first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000;

async function entryAt(cwd: string, rev: string, path: string): Promise<{ mode: string; oid: string } | null> {
  const out = await run(cwd, ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", rev, "--", path]);
  const m = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(out);
  return m ? { mode: m[1]!, oid: m[2]! } : null;
}

/** Whether `path` at `rev` is binary by its content, whatever an attribute claims. */
async function binaryAt(cwd: string, rev: string, path: string): Promise<boolean> {
  const e = await entryAt(cwd, rev, path);
  if (e === null || e.mode === "160000") return false;
  return (await blobHead(cwd, e.oid, BINARY_PROBE_BYTES)).includes(0);
}

/** The same test on the working-tree file. A symlink is its target text and a submodule a commit: neither is binary. */
function binaryInWork(root: string, path: string): boolean {
  const abs = join(root, path);
  let st;
  try { st = lstatSync(abs); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (!st.isFile()) return false;
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    return buf.subarray(0, readSync(fd, buf, 0, BINARY_PROBE_BYTES, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * A clone-local attribute (`.git/info/attributes`, `binary`, `-diff`) makes git
 * print `-\t-` for text, which would pass any size under the cap. Content
 * decides, never an attribute: such a path is counted from its two sides by
 * `count`, and a `-\t-` entry stays only where `binary` says one side really is
 * binary. Git's own `--text` cannot be asked: git 2.54 still prints `-\t-` for
 * an attribute-marked path under `--text`. A type change (status `T`) is
 * recounted the same way, attribute or not: git 2.54 diffs its two sides as
 * one blob pair, so a symlink replaced by a file holding its link text shows
 * 0/0, and the gate counts the removed side and the added side instead.
 */
async function countedAsText(
  plain: NumstatEntry[],
  count: (path: string, ends: RawEndpoints) => Promise<NumstatEntry>,
  binary: (path: string) => Promise<boolean>,
  raw: () => Promise<string>,
): Promise<NumstatEntry[]> {
  const endpoints = parseRawZ(await raw());
  if (endpoints === null || endpoints.length !== plain.length) throw new Error("the raw diff does not pair with the numstat");
  const out: NumstatEntry[] = [];
  let recounted = false;
  for (const [i, e] of plain.entries()) {
    const ends = endpoints[i]!;
    if (ends.path !== e.path) throw new Error(`the raw diff does not pair with the numstat at ${e.path}`);
    if ((e.added !== null && ends.status !== "T") || (await binary(e.path))) { out.push(e); continue; }
    out.push(await count(e.path, ends));
    recounted = true;
  }
  return recounted ? out : plain;
}

/** One side of a changed path as `git diff --raw` names it; mode `000000` is absent. */
interface Endpoint { readonly mode: string; readonly oid: string }
interface RawEndpoints { readonly path: string; readonly status: string; readonly from: Endpoint; readonly to: Endpoint }

/**
 * `git diff --raw -z --no-renames` records, one per numstat entry and in the
 * same order. A type change (a symlink replaced by a file, a file by a
 * submodule) is status `T`; the gate counts it as a deletion of the old side
 * plus an addition of the new one, never as a diff between them.
 */
function parseRawZ(raw: string): RawEndpoints[] | null {
  const parts = raw.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  const out: RawEndpoints[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i]!);
    const path = parts[i + 1];
    if (!m || path === undefined) return null;
    out.push({ path, status: m[5]!, from: { mode: m[1]!, oid: m[3]! }, to: { mode: m[2]!, oid: m[4]! } });
  }
  return out;
}

const ABSENT = "000000";
const GITLINK = "160000";
/** What git diffs for a submodule endpoint: one line naming its commit. */
const gitlinkText = (oid: string): string => `Subproject commit ${oid}\n`;

/** Streams a blob into `dest` whole, so its size never meets a buffer limit. */
function blobToFile(cwd: string, oid: string, dest: string): Promise<void> {
  const fd = openSync(dest, "w");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "blob", oid], { cwd, stdio: ["ignore", fd, "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stderr?.on("data", (b: Buffer) => { if (stderr.length < 4096) stderr += b.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git cat-file ended with ${code ?? signal}`));
    });
  }).finally(() => closeSync(fd));
}

/**
 * Writes a stored endpoint into `dest` as git diffs it: nothing for an absent
 * side, the commit line for a gitlink (never `cat-file blob` on a commit), and
 * the blob otherwise, which for a symlink is its link text.
 */
async function endpointToFile(cwd: string, e: Endpoint, dest: string): Promise<void> {
  if (e.mode === ABSENT) writeFileSync(dest, "");
  else if (e.mode === GITLINK) writeFileSync(dest, gitlinkText(e.oid));
  else await blobToFile(cwd, e.oid, dest);
}

/**
 * The same for the working-tree endpoint, read from disk by the mode git reported.
 * A regular file is copied as is, without clean filters or autocrlf: under core.autocrlf=true an
 * LF baseline against a CRLF file counts every line as replaced (item totals only; receipts are unaffected).
 */
async function workToFile(root: string, path: string, e: Endpoint, dest: string): Promise<void> {
  if (e.mode === ABSENT) { writeFileSync(dest, ""); return; }
  if (e.mode === GITLINK) { writeFileSync(dest, gitlinkText((await submoduleEntry(root, path)).slice(GITLINK.length + 1))); return; }
  const abs = join(root, path);
  if (e.mode === "120000") writeFileSync(dest, readlinkSync(abs));
  else copyFileSync(abs, dest);
}

/**
 * Counts one raw record as git does: a type change is its old side removed
 * and its new side added, each against nothing and each exactly once; any
 * other change is its two sides against each other.
 */
async function countEndpoints(path: string, ends: RawEndpoints, write: (e: Endpoint, dest: string) => Promise<void>): Promise<NumstatEntry> {
  if (ends.status !== "T") return countFromSides(path, (before, after) => Promise.all([write(ends.from, before), write(ends.to, after)]).then(() => undefined));
  const removed = await countFromSides(path, async (before, after) => { writeFileSync(before, ""); await write(ends.from, after); });
  const added = await countFromSides(path, async (before, after) => { writeFileSync(before, ""); await write(ends.to, after); });
  return { path, added: added.added, deleted: removed.added };
}

/**
 * Git's line count of two sides of `path`, taken where no attribute reaches:
 * two temp files outside any repository, with no attributes file, no system
 * attributes and repository discovery stopped at the temp directory. A side
 * that cannot be read refuses, so it never passes as ~0 changed lines.
 */
async function countFromSides(path: string, fill: (before: string, after: string) => Promise<void>): Promise<NumstatEntry> {
  const dir = mkdtempSync(join(tmpdir(), "storybloq-gate-"));
  try {
    const before = join(dir, "a");
    const after = join(dir, "b");
    try {
      await fill(before, after);
    } catch (e) {
      throw new Error(`${path} could not be read to count it as text: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["-c", `core.attributesFile=${devNull}`, "diff", "--no-index", "--numstat", "--text", "--no-textconv", "--no-ext-diff", "--", "a", "b"],
        { cwd: dir, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_ATTR_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dirname(dir) } },
        (err, stdout, stderr) => {
          // `--no-index` exits 1 when the two sides differ.
          if (err && (err as { code?: unknown }).code !== 1) reject(new Error(String(stderr || err.message).trim() || "git failed"));
          else resolve(stdout);
        },
      );
    });
    if (out === "") return { path, added: 0, deleted: 0 };
    const m = /^(\d+)\t(\d+)\t/.exec(out);
    if (!m) throw new Error(`git would not count ${path} as text`);
    return { path, added: Number(m[1]), deleted: Number(m[2]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const numstatRecord = (e: NumstatEntry): string => `${e.added ?? "-"}\t${e.deleted ?? "-"}\t${e.path}\0`;

export const realProbe: ReceiptProbe = {
  isDir(path) {
    try { return statSync(path).isDirectory(); } catch { return false; }
  },
  async inWorkTree(cwd) {
    try { return (await run(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true"; } catch { return false; }
  },
  async numstat(cwd, base, head) {
    const range = [base, head, "--"];
    const raw = await run(cwd, [...NUMSTAT, "--end-of-options", ...range]);
    const plain = parseNumstatZ(raw);
    if (plain === null) return raw;
    const out = await countedAsText(
      plain,
      (path, ends) => countEndpoints(path, ends, (e, dest) => endpointToFile(cwd, e, dest)),
      async (path) => (await binaryAt(cwd, base, path)) || (await binaryAt(cwd, head, path)),
      () => run(cwd, [...RAW, "--end-of-options", ...range]),
    );
    return out === plain ? raw : out.map(numstatRecord).join("");
  },
  async entryAt(cwd, rev, path) {
    const e = await entryAt(cwd, rev, path);
    return e === null ? null : `${e.mode} ${e.oid}`;
  },
  async workEntry(root, path) {
    const abs = join(root, path);
    let st;
    try { st = lstatSync(abs); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    // A symlink is stored as its target text; hash-object on the path would follow it.
    if (st.isSymbolicLink()) return `120000 ${(await run(root, ["hash-object", "--stdin"], readlinkSync(abs))).trim()}`;
    if (st.isDirectory()) return submoduleEntry(root, path);
    return `${await regularMode(root, path, st.mode)} ${(await run(root, ["hash-object", "--", path])).trim()}`;
  },
};

/**
 * The mode `git add` would record for a regular file. Git reads only the
 * owner's execute bit, and only when `core.fileMode` trusts the filesystem;
 * when it does not, a tracked file keeps its index mode and a new one is 100644.
 */
async function regularMode(root: string, path: string, statMode: number): Promise<string> {
  if ((await run(root, ["config", "--type=bool", "--default", "true", "--get", "core.fileMode"])).trim() === "true") {
    return (statMode & 0o100) !== 0 ? "100755" : "100644";
  }
  const index = /^(100644|100755) /.exec(await run(root, ["--literal-pathspecs", "ls-files", "-s", "-z", "--", path]));
  return index ? index[1]! : "100644";
}

/**
 * A changed path that is a directory in the working tree is a submodule: its
 * entry is the commit it has checked out. One that is not checked out is the
 * commit the index records, as `git diff` reads it. Uncommitted content in it
 * is in no commit a review could have seen, so it refuses by name.
 */
async function submoduleEntry(root: string, path: string): Promise<string> {
  const index = await run(root, ["--literal-pathspecs", "ls-files", "-s", "-z", "--", path]);
  const m = /^160000 ([0-9a-f]+) \d\t/.exec(index);
  if (!m) throw new Error(`${path} is a directory, not a file or a submodule`);
  const sub = join(root, path);
  let top: string | null = null;
  try { top = (await run(sub, ["rev-parse", "--show-toplevel"])).trim(); } catch { top = null; }
  if (top === null || realpathSync(top) !== realpathSync(sub)) return `160000 ${m[1]!}`;
  if ((await run(sub, ["status", "--porcelain", "-z", "--ignore-submodules=none", "--untracked-files=all"])).length > 0) {
    throw new Error(`submodule ${path} has uncommitted changes, which no reviewed commit holds: commit them in the submodule and review the commit that records it`);
  }
  return `160000 ${(await run(sub, ["rev-parse", "HEAD"])).trim()}`;
}

const inLedger = (path: string): boolean => path.startsWith(".story/");
/** The whole tree except the ledger, as a pathspec, so git never opens a ledger file. */
const OUTSIDE_LEDGER = [":/", ":(top,exclude).story"] as const;

/**
 * The item's own changes, as the review must cover them: the working tree
 * against the baseline, plus untracked files counted as whole additions. The
 * ledger (`.story/`) is excluded in the pathspec itself, so nothing under it is
 * read; it is bookkeeping the review is not asked to judge.
 */
export async function itemNumstat(root: string, baseline: string): Promise<NumstatEntry[]> {
  const plain = parseNumstatZ(await run(root, [...NUMSTAT, "--end-of-options", baseline, "--", ...OUTSIDE_LEDGER]));
  if (plain === null) throw new Error("unparseable numstat for the item diff");
  // The item's endpoints decide which paths are binary (the exemption every
  // reviewed range must agree with), so attribute-marked text counts as text here too.
  const parsed = await countedAsText(
    plain,
    (path, ends) => countEndpoints(path, ends, (e, dest) => (e === ends.to ? workToFile(root, path, e, dest) : endpointToFile(root, e, dest))),
    async (path) => (await binaryAt(root, baseline, path)) || binaryInWork(root, path),
    () => run(root, [...RAW, "--end-of-options", baseline, "--", ...OUTSIDE_LEDGER]),
  );
  const untracked = (await run(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...OUTSIDE_LEDGER])).split("\0").filter((p) => p.length > 0 && !inLedger(p));
  const entries = parsed.filter((e) => !inLedger(e.path));
  for (const path of untracked) {
    let added: number | null;
    let buf: Buffer;
    try {
      // Git stores a symlink as its target text, one line with no newline.
      buf = lstatSync(join(root, path)).isSymbolicLink() ? Buffer.from(readlinkSync(join(root, path))) : readFileSync(join(root, path));
    } catch (e) {
      // Fail closed: an unreadable file must not pass as an exempt binary.
      throw new Error(`untracked ${path} is unreadable: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    // The same test as for tracked content: binary by its first 8000 bytes, as git decides.
    if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) added = null;
    else {
      const text = buf.toString("utf8");
      added = text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
    }
    entries.push({ path, added, deleted: added === null ? null : 0 });
  }
  return entries;
}

export interface GeminiRulingState {
  readonly accepted: boolean;
  /** Why not, for the refusal. Null when accepted or when none is configured. */
  readonly detail: string | null;
}

/**
 * Whether the owner's Gemini ruling, named at
 * `recipeOverrides.reviewGate.geminiRuling`, is in force. Read fresh from disk
 * each time and fails closed: missing, unreadable, withdrawn, superseded or
 * never accepted all leave Codex as the only gate-grade provider.
 */
export function readGeminiRuling(root: string): GeminiRulingState {
  let id: unknown;
  try {
    const cfg = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf8")) as Record<string, unknown>;
    const overrides = cfg.recipeOverrides as Record<string, unknown> | undefined;
    const gate = overrides?.reviewGate as Record<string, unknown> | undefined;
    id = gate?.geminiRuling;
  } catch {
    return { accepted: false, detail: "config.json unreadable" };
  }
  if (id === undefined) return { accepted: false, detail: null };
  if (typeof id !== "string" || id.length === 0) return { accepted: false, detail: "reviewGate.geminiRuling is not a ruling id" };
  const loaded = loadRulingsSafe(root);
  if (loaded.unavailableIds.has(id)) return { accepted: false, detail: `ruling ${id} is unreadable` };
  const lifecycle = loaded.lifecycleById.get(id);
  if (lifecycle === undefined) return { accepted: false, detail: `ruling ${id} not found` };
  if (lifecycle !== "accepted" && lifecycle !== "accepted-legacy") {
    return { accepted: false, detail: `ruling ${id} is ${lifecycle}` };
  }
  return { accepted: true, detail: null };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface BridgeGateInput {
  readonly stage: GateStage;
  readonly reviewerBackend: string;
  readonly report: GuideReportInput;
  readonly key: GateKey | null;
  /** PLAN_REVIEW: the plan the guide holds. */
  readonly planText?: string;
  /** Test seam; the stages pass nothing. */
  readonly probe?: ReceiptProbe;
  readonly itemNumstat?: () => Promise<NumstatEntry[]>;
}

export async function runBridgeReceiptGate(ctx: StageContext, input: BridgeGateInput): Promise<BridgeGateOutcome> {
  if (!isBridgeCodex(input.reviewerBackend)) return { kind: "not-applicable" };

  const reason = await assess(ctx, input);
  if (reason.ok) return reason.outcome;

  // Escalation counts the session, not the round: refusals spread across
  // items, stages and rounds still reach the fallback and the cutoff.
  const refusals = sessionGateRefusals(ctx.state.reviewGateRefusals) + 1;
  const updates: Partial<FullSessionState> = {};
  if (input.key !== null) {
    updates.reviewGateRefusals = [
      ...(ctx.state.reviewGateRefusals ?? []),
      { ...input.key, reason: reason.reason.slice(0, 500), at: new Date().toISOString() },
    ];
  }
  const unavailable = input.key !== null && refusals >= GATE_UNAVAILABLE_AT;
  if (unavailable) {
    updates.codexUnavailable = true;
    updates.codexUnavailableSince = new Date().toISOString();
  }
  if (Object.keys(updates).length > 0) ctx.writeState(updates);

  const lines = [
    `Bridge review not accepted as a gate result: ${reason.reason}. No round was recorded.`,
    "",
    `Re-run it in a fresh bridge session (omit \`session_id\`). ${bridgeReviewRules(input.stage, reviewBaseline(ctx.state))}`,
  ];
  if (unavailable) {
    lines.push("", `Codex is now marked unavailable after ${refusals} refused bridge reports in this session (bridge results not gate-grade). Review this round with the next configured reviewer instead.`);
  } else if (refusals >= GATE_ESCAPE_AT) {
    lines.push("", `This session has ${refusals} refused bridge reports. If the bridge cannot produce a gate-grade result, run an agent review and report \`reviewer: "agent"\` with "codex unavailable: <reason>" in notes; it is recorded as an agent round.`);
  }
  return { kind: "retry", instruction: lines.join("\n") };
}

type Assessed = { readonly ok: true; readonly outcome: BridgeGateOutcome } | { readonly ok: false; readonly reason: string };

async function assess(ctx: StageContext, input: BridgeGateInput): Promise<Assessed> {
  const gemini = readGeminiRuling(ctx.root);
  const opts = { geminiRulingAccepted: gemini.accepted };
  const withRuling = (reason: string): string =>
    gemini.detail !== null && /Gemini/.test(reason) ? `${reason} (${gemini.detail})` : reason;

  let evidence: GateEvidence;
  if (input.stage === "plan") {
    const text = input.planText ?? "";
    const plan = assessPlanReceipt(input.report.reviewReceipts, { text, sha256: createHash("sha256").update(text, "utf8").digest("hex") }, opts);
    if (!plan.ok) return { ok: false, reason: withRuling(plan.reason) };
    evidence = plan.value;
  } else {
    const baseline = reviewBaseline(ctx.state);
    if (baseline === null) return { ok: false, reason: "the session recorded no baseline commit for this item, so no review can be tied to it" };
    let entries: NumstatEntry[];
    try {
      entries = await (input.itemNumstat ?? (() => itemNumstat(ctx.root, baseline)))();
    } catch (e) {
      return { ok: false, reason: `could not read the item diff: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200)}` };
    }
    const code = await assessCodeReceipts(input.report.reviewReceipts, { baseline, entries }, input.probe ?? realProbe, ctx.root, opts);
    if (!code.ok) return { ok: false, reason: withRuling(code.reason) };
    evidence = code.value;
  }

  const { observed, disclosure } = evidence;
  return {
    ok: true,
    outcome: {
      kind: "pass",
      reviewGate: disclosure ? { observed, disclosure } : { observed },
      reportOverride: {
        reviewerModel: observed.map((o) => o.model).join(" + "),
        reviewerTier: "max",
        reviewerEvidence: "observed",
      },
    },
  };
}
