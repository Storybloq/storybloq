/**
 * T-254 Lens gate — review snapshot writer/reader/archive.
 *
 * Captures a byte-exact, tamper-evident copy of every file a lens review
 * round is permitted to cite, with a sha256 manifest. T-255 consumes this
 * snapshot to verify findings.
 *
 * CONCURRENCY CONTRACT: every public function in this module uses
 * lstat/realpath preflight followed by separate pathname-based I/O. These
 * are not atomic pairs — a concurrent attacker with write access to
 * `.story/sessions/<id>/review-snapshot/` can swap a validated path for
 * a symlink after the preflight. This module explicitly assumes no
 * concurrent filesystem tampering with the snapshot directory during a
 * call. The preflight walks defend against accidental damage and
 * non-adversarial symlink plants; they are not a TOCTOU-hardened boundary
 * against an active attacker.
 */

import {
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve, sep, posix, win32 } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────────

export interface ReviewSnapshotInput {
  projectRoot: string;
  sessionId: string;
  reviewId: string;
  stage: "plan-review" | "code-review";
  round: number;
  files: ReadonlyArray<string>;
}

export interface ReviewSnapshotManifestFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ReviewSnapshotManifest {
  reviewId: string;
  sessionId: string;
  stage: "plan-review" | "code-review";
  round: number;
  createdAt: string;
  snapshotRoot: string;
  canonicalProjectRoot: string;
  files: ReviewSnapshotManifestFileEntry[];
  fileCount: number;
  totalBytes: number;
}

export interface WriteReviewSnapshotResult {
  snapshotDir: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: ReviewSnapshotManifest;
}

export interface ArchiveReviewSnapshotResult {
  archivePath: string;
  removedDir: string;
}

// ── Identifier validation ─────────────────────────────────────────

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_ID_RE = /^(plan-review|code-review)-r\d+$/;

function assertValidSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `review-snapshot: invalid sessionId (must be canonical UUID): ${JSON.stringify(sessionId)}`,
    );
  }
}

function assertValidReviewId(reviewId: unknown): asserts reviewId is string {
  if (typeof reviewId !== "string" || !REVIEW_ID_RE.test(reviewId)) {
    throw new Error(
      `review-snapshot: invalid reviewId (must match <stage>-r<n>): ${JSON.stringify(reviewId)}`,
    );
  }
}

function assertReviewIdMatchesStageRound(
  reviewId: string,
  stage: "plan-review" | "code-review",
  round: number,
): void {
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(
      `review-snapshot: round must be a positive integer, got ${round}`,
    );
  }
  const expected = `${stage}-r${round}`;
  if (reviewId !== expected) {
    throw new Error(
      `review-snapshot: reviewId mismatch: reviewId=${JSON.stringify(reviewId)} does not match expected ${JSON.stringify(expected)} from stage/round`,
    );
  }
}

// ── Manifest-path contract (writer + reader, same rules) ──────────

function assertValidManifestPath(entryPath: unknown, label: string): void {
  if (typeof entryPath !== "string" || entryPath.length === 0) {
    throw new Error(`review-snapshot: ${label}: empty or non-string path`);
  }
  if (entryPath.includes("\\")) {
    throw new Error(
      `review-snapshot: ${label}: backslash not permitted in manifest path: ${entryPath}`,
    );
  }
  if (posix.isAbsolute(entryPath)) {
    throw new Error(
      `review-snapshot: ${label}: absolute path not permitted: ${entryPath}`,
    );
  }
  if (win32.isAbsolute(entryPath)) {
    throw new Error(
      `review-snapshot: ${label}: Windows-absolute path not permitted: ${entryPath}`,
    );
  }
  if (/^[A-Za-z]:/.test(entryPath)) {
    throw new Error(
      `review-snapshot: ${label}: Windows drive-qualified path not permitted: ${entryPath}`,
    );
  }
  for (const segment of entryPath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(
        `review-snapshot: ${label}: invalid segment (empty, '.', or '..'): ${entryPath}`,
      );
    }
  }
  if (posix.normalize(entryPath) !== entryPath) {
    throw new Error(
      `review-snapshot: ${label}: path is not posix-normalized: ${entryPath}`,
    );
  }
}

// ── Destination-tree symlink containment ──────────────────────────

function assertNoSymlinkAncestors(targetPath: string, stopAt: string): void {
  const stopReal = resolve(stopAt);
  const target = resolve(targetPath);
  if (!target.startsWith(stopReal + sep) && target !== stopReal) {
    throw new Error(
      `review-snapshot: assertNoSymlinkAncestors: target ${target} is not under stopAt ${stopReal}`,
    );
  }
  const suffix = target === stopReal ? "" : target.slice(stopReal.length + 1);
  const segments = suffix.length > 0 ? suffix.split(sep) : [];
  let current = stopReal;
  for (const segment of segments) {
    current = join(current, segment);
    let st;
    try {
      st = lstatSync(current);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `review-snapshot: symlink not permitted in destination chain: ${current}`,
      );
    }
  }
}

// ── Canonical roots / finalDir derivation ─────────────────────────

interface CanonicalPaths {
  canonicalProjectRoot: string;
  canonicalSessionsRoot: string;
  sessionDir: string;
  snapshotParent: string;
  finalDir: string;
}

function deriveCanonicalPaths(
  projectRoot: string,
  sessionId: string,
  reviewId: string,
): CanonicalPaths {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const storyDir = join(canonicalProjectRoot, ".story");
  if (!existsSync(storyDir)) {
    mkdirSync(storyDir, { recursive: true });
  }
  const sessionsDir = join(storyDir, "sessions");
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  const storyLstat = lstatSync(storyDir);
  if (storyLstat.isSymbolicLink()) {
    throw new Error(`review-snapshot: .story is a symlink: ${storyDir}`);
  }
  const sessionsLstat = lstatSync(sessionsDir);
  if (sessionsLstat.isSymbolicLink()) {
    throw new Error(
      `review-snapshot: sessions root is a symlink: ${sessionsDir}`,
    );
  }
  const canonicalSessionsRoot = realpathSync(sessionsDir);

  const sessionDir = join(canonicalSessionsRoot, sessionId);
  if (!sessionDir.startsWith(canonicalSessionsRoot + sep)) {
    throw new Error(
      `review-snapshot: sessionDir escapes sessions root: ${sessionDir}`,
    );
  }

  const snapshotParent = join(sessionDir, "review-snapshot");
  const finalDir = join(snapshotParent, reviewId);
  if (!finalDir.startsWith(snapshotParent + sep)) {
    throw new Error(
      `review-snapshot: finalDir escapes snapshot parent: ${finalDir}`,
    );
  }

  return {
    canonicalProjectRoot,
    canonicalSessionsRoot,
    sessionDir,
    snapshotParent,
    finalDir,
  };
}

// ── Source-side canonicalization ──────────────────────────────────

function resolveSourcePath(
  canonicalRoot: string,
  callerPath: string,
): { resolvedTarget: string } {
  if (!canonicalRoot.endsWith(sep)) canonicalRoot = canonicalRoot + sep;
  const rootNoSep = canonicalRoot.slice(0, -1);

  const fullPath = resolve(rootNoSep, callerPath);
  if (!fullPath.startsWith(canonicalRoot) && fullPath !== rootNoSep) {
    throw new Error(
      `review-snapshot: source path escapes project root: ${callerPath}`,
    );
  }

  let realPath: string;
  try {
    realPath = realpathSync(fullPath);
  } catch (err) {
    throw new Error(
      `review-snapshot: source file unreadable: ${callerPath}: ${(err as Error).message}`,
    );
  }
  if (!realPath.startsWith(canonicalRoot) && realPath !== rootNoSep) {
    throw new Error(
      `review-snapshot: source symlink escapes project root: ${callerPath}`,
    );
  }
  return { resolvedTarget: realPath };
}

// ── Writer ────────────────────────────────────────────────────────

function randomStagingName(reviewId: string): string {
  return `${reviewId}.tmp-${randomBytes(8).toString("hex")}`;
}

export function writeReviewSnapshot(
  input: ReviewSnapshotInput,
): WriteReviewSnapshotResult {
  assertValidSessionId(input.sessionId);
  assertValidReviewId(input.reviewId);
  assertReviewIdMatchesStageRound(input.reviewId, input.stage, input.round);

  const paths = deriveCanonicalPaths(
    input.projectRoot,
    input.sessionId,
    input.reviewId,
  );

  // Check destination chain up to sessionDir for symlinks before we
  // create any intermediate dirs under it.
  assertNoSymlinkAncestors(paths.sessionDir, paths.canonicalSessionsRoot);

  // Create snapshotParent if missing, then verify no symlink ancestors.
  if (!existsSync(paths.snapshotParent)) {
    mkdirSync(paths.snapshotParent, { recursive: true });
  }
  assertNoSymlinkAncestors(paths.snapshotParent, paths.canonicalSessionsRoot);

  // Reject if finalDir already exists (immutability).
  if (existsSync(paths.finalDir)) {
    throw new Error(
      `review-snapshot: immutable snapshot collision: ${paths.finalDir} already exists`,
    );
  }

  const stagingDir = join(
    paths.snapshotParent,
    randomStagingName(input.reviewId),
  );
  mkdirSync(stagingDir, { recursive: false });
  const stagingLstat = lstatSync(stagingDir);
  if (stagingLstat.isSymbolicLink()) {
    throw new Error(
      `review-snapshot: staging dir is a symlink after mkdir: ${stagingDir}`,
    );
  }

  try {
    return writeReviewSnapshotInto(input, stagingDir);
  } catch (err) {
    // Best-effort cleanup.
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function writeReviewSnapshotInto(
  input: ReviewSnapshotInput,
  stagingDir: string,
): WriteReviewSnapshotResult {
  assertValidSessionId(input.sessionId);
  assertValidReviewId(input.reviewId);
  assertReviewIdMatchesStageRound(input.reviewId, input.stage, input.round);

  const paths = deriveCanonicalPaths(
    input.projectRoot,
    input.sessionId,
    input.reviewId,
  );

  // Re-verify destination chain — the writeReviewSnapshotInto entry is
  // callable from tests and must not trust its own pre-state.
  assertNoSymlinkAncestors(paths.sessionDir, paths.canonicalSessionsRoot);
  assertNoSymlinkAncestors(paths.snapshotParent, paths.canonicalSessionsRoot);

  if (existsSync(paths.finalDir)) {
    throw new Error(
      `review-snapshot: immutable snapshot collision: ${paths.finalDir} already exists`,
    );
  }

  // Verify stagingDir is itself a real directory under snapshotParent,
  // and not a symlink.
  const stagingLstat = lstatSync(stagingDir);
  if (stagingLstat.isSymbolicLink()) {
    throw new Error(
      `review-snapshot: staging dir is a symlink: ${stagingDir}`,
    );
  }
  if (!stagingLstat.isDirectory()) {
    throw new Error(
      `review-snapshot: staging dir is not a directory: ${stagingDir}`,
    );
  }
  const realStagingDir = realpathSync(stagingDir);
  const realSnapshotParent = realpathSync(paths.snapshotParent);
  if (!realStagingDir.startsWith(realSnapshotParent + sep)) {
    throw new Error(
      `review-snapshot: staging dir is not under snapshot parent: ${stagingDir}`,
    );
  }

  // Phase 1: lexical validation of every caller path.
  for (const p of input.files) {
    assertValidManifestPath(p, `caller path`);
  }

  // Phase 2: resolve sources, dedup, sort.
  const dedup = new Map<
    string,
    { callerPath: string; resolvedTarget: string }
  >();
  for (const callerPath of input.files) {
    const { resolvedTarget } = resolveSourcePath(
      paths.canonicalProjectRoot,
      callerPath,
    );
    if (!dedup.has(callerPath)) {
      dedup.set(callerPath, { callerPath, resolvedTarget });
    }
  }
  const resolved = Array.from(dedup.values()).sort((a, b) =>
    a.callerPath < b.callerPath ? -1 : a.callerPath > b.callerPath ? 1 : 0,
  );

  // Phase 3: per-file write loop.
  const manifestEntries: ReviewSnapshotManifestFileEntry[] = [];
  let totalBytes = 0;
  for (const entry of resolved) {
    const bytes = readFileSync(entry.resolvedTarget);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const dest = join(stagingDir, entry.callerPath);
    if (!dest.startsWith(stagingDir + sep)) {
      throw new Error(
        `review-snapshot: destination escapes staging dir: ${dest}`,
      );
    }
    const destDir = dirname(dest);

    // Pre-mkdir symlink walk on any existing prefix under stagingDir.
    assertNoSymlinkAncestors(destDir, stagingDir);
    mkdirSync(destDir, { recursive: true });
    // Post-mkdir symlink walk to catch a mid-call symlink plant.
    assertNoSymlinkAncestors(destDir, stagingDir);

    const tmpDest = dest + ".tmp";
    writeFileSync(tmpDest, bytes, { flag: "wx" });
    renameSync(tmpDest, dest);
    try {
      chmodSync(dest, 0o444);
    } catch {
      /* best effort */
    }

    manifestEntries.push({
      path: entry.callerPath,
      sha256,
      bytes: bytes.length,
    });
    totalBytes += bytes.length;
  }

  // Manifest is written last inside the staging dir.
  const manifest: ReviewSnapshotManifest = {
    reviewId: input.reviewId,
    sessionId: input.sessionId,
    stage: input.stage,
    round: input.round,
    createdAt: new Date().toISOString(),
    snapshotRoot: paths.finalDir,
    canonicalProjectRoot: paths.canonicalProjectRoot,
    files: manifestEntries,
    fileCount: manifestEntries.length,
    totalBytes,
  };
  const manifestBytes = Buffer.from(
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  const stagingManifestPath = join(stagingDir, "manifest.json");
  writeFileSync(stagingManifestPath, manifestBytes, { flag: "wx" });
  try {
    chmodSync(stagingManifestPath, 0o444);
  } catch {
    /* best effort */
  }
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");

  // Atomic claim: rename staging → finalDir.
  assertNoSymlinkAncestors(paths.snapshotParent, paths.canonicalSessionsRoot);
  try {
    renameSync(stagingDir, paths.finalDir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST" || e.code === "ENOTEMPTY") {
      throw new Error(
        `review-snapshot: immutable snapshot collision: ${paths.finalDir}`,
      );
    }
    throw err;
  }

  return {
    snapshotDir: paths.finalDir,
    manifestPath: join(paths.finalDir, "manifest.json"),
    manifestSha256,
    manifest,
  };
}

// ── Reader ────────────────────────────────────────────────────────

/**
 * Parse-only manifest load. Returns both the parsed, cross-checked manifest
 * and the raw `manifest.json` bytes that produced the parse so callers can
 * verify an expected sha256 against exactly those bytes (avoiding a TOCTOU
 * re-read). Used by `verifyLensFinding` in the digest-verified bootstrap
 * and by `readReviewSnapshotManifest` itself.
 */
export function readReviewSnapshotManifestWithBytes(
  projectRoot: string,
  sessionId: string,
  reviewId: string,
): {
  manifest: ReviewSnapshotManifest;
  manifestBytes: Buffer;
  paths: CanonicalPaths;
  realFinalDir: string;
} {
  assertValidSessionId(sessionId);
  assertValidReviewId(reviewId);

  const paths = deriveCanonicalPaths(projectRoot, sessionId, reviewId);

  // Destination-chain guard: lstat walk first, realpath containment second.
  assertNoSymlinkAncestors(paths.finalDir, paths.canonicalSessionsRoot);

  const finalLstat = lstatSync(paths.finalDir);
  if (finalLstat.isSymbolicLink()) {
    throw new Error(
      `review-snapshot: finalDir is a symlink: ${paths.finalDir}`,
    );
  }
  const realFinalDir = realpathSync(paths.finalDir);
  if (
    !realFinalDir.startsWith(paths.canonicalSessionsRoot + sep) &&
    realFinalDir !== paths.canonicalSessionsRoot
  ) {
    throw new Error(
      `review-snapshot: finalDir escapes sessions root: ${paths.finalDir}`,
    );
  }

  // Treat manifest.json as a stored artifact — lstat + realpath before read.
  const manifestPath = join(paths.finalDir, "manifest.json");
  const manifestLstat = lstatSync(manifestPath);
  if (manifestLstat.isSymbolicLink()) {
    throw new Error(
      `review-snapshot: manifest.json is a symlink: ${manifestPath}`,
    );
  }
  const realManifestPath = realpathSync(manifestPath);
  if (!realManifestPath.startsWith(realFinalDir + sep)) {
    throw new Error(
      `review-snapshot: manifest.json escapes finalDir: ${manifestPath}`,
    );
  }
  const manifestBytes = readFileSync(manifestPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch (err) {
    throw new Error(
      `review-snapshot: manifest.json is invalid JSON: ${(err as Error).message}`,
    );
  }
  const manifest = validateManifestShape(parsed);

  // Manifest identity cross-checks — verify the manifest matches the
  // requested (sessionId, reviewId) and the canonical paths we derived.
  // Run before lexical path validation so identity mismatches fail first.
  assertValidSessionId(manifest.sessionId);
  assertValidReviewId(manifest.reviewId);
  assertReviewIdMatchesStageRound(
    manifest.reviewId,
    manifest.stage,
    manifest.round,
  );
  if (manifest.sessionId !== sessionId) {
    throw new Error(
      `review-snapshot: manifest sessionId mismatch: requested ${JSON.stringify(sessionId)}, manifest ${JSON.stringify(manifest.sessionId)}`,
    );
  }
  if (manifest.reviewId !== reviewId) {
    throw new Error(
      `review-snapshot: manifest reviewId mismatch: requested ${JSON.stringify(reviewId)}, manifest ${JSON.stringify(manifest.reviewId)}`,
    );
  }
  if (manifest.canonicalProjectRoot !== paths.canonicalProjectRoot) {
    throw new Error(
      `review-snapshot: manifest canonicalProjectRoot mismatch: derived ${JSON.stringify(paths.canonicalProjectRoot)}, manifest ${JSON.stringify(manifest.canonicalProjectRoot)}`,
    );
  }
  if (manifest.snapshotRoot !== paths.finalDir) {
    throw new Error(
      `review-snapshot: manifest snapshotRoot mismatch: derived ${JSON.stringify(paths.finalDir)}, manifest ${JSON.stringify(manifest.snapshotRoot)}`,
    );
  }

  // Always-on lexical validation of every manifest entry.
  for (const entry of manifest.files) {
    assertValidManifestPath(entry.path, `manifest entry`);
    const stored = join(paths.finalDir, entry.path);
    if (!stored.startsWith(paths.finalDir + sep)) {
      throw new Error(
        `review-snapshot: manifest entry escapes finalDir: ${entry.path}`,
      );
    }
  }

  return { manifest, manifestBytes, paths, realFinalDir };
}

export function readReviewSnapshotManifest(
  projectRoot: string,
  sessionId: string,
  reviewId: string,
  expectedManifestSha256?: string,
): ReviewSnapshotManifest {
  const { manifest, manifestBytes, paths, realFinalDir } =
    readReviewSnapshotManifestWithBytes(projectRoot, sessionId, reviewId);

  if (expectedManifestSha256 !== undefined) {
    const actualSha = createHash("sha256")
      .update(manifestBytes)
      .digest("hex");
    if (actualSha !== expectedManifestSha256) {
      throw new Error(
        `review-snapshot: manifest digest mismatch: expected ${expectedManifestSha256}, got ${actualSha}`,
      );
    }
    // Per-file verification.
    for (const entry of manifest.files) {
      const stored = join(paths.finalDir, entry.path);
      assertNoSymlinkAncestors(dirname(stored), paths.finalDir);
      const st = lstatSync(stored);
      if (st.isSymbolicLink()) {
        throw new Error(
          `review-snapshot: payload file is a symlink: ${stored}`,
        );
      }
      const realStored = realpathSync(stored);
      if (!realStored.startsWith(realFinalDir + sep)) {
        throw new Error(
          `review-snapshot: payload file escapes finalDir: ${stored}`,
        );
      }
      const bytes = readFileSync(stored);
      if (bytes.length !== entry.bytes) {
        throw new Error(
          `review-snapshot: payload byte length mismatch: ${entry.path}`,
        );
      }
      const fileSha = createHash("sha256").update(bytes).digest("hex");
      if (fileSha !== entry.sha256) {
        throw new Error(
          `review-snapshot: payload sha256 mismatch: ${entry.path}`,
        );
      }
    }
  }

  return manifest;
}

function validateManifestShape(value: unknown): ReviewSnapshotManifest {
  if (!value || typeof value !== "object") {
    throw new Error("review-snapshot: manifest is not an object");
  }
  const m = value as Record<string, unknown>;
  if (typeof m.reviewId !== "string")
    throw new Error("review-snapshot: manifest.reviewId missing");
  if (typeof m.sessionId !== "string")
    throw new Error("review-snapshot: manifest.sessionId missing");
  if (m.stage !== "plan-review" && m.stage !== "code-review")
    throw new Error("review-snapshot: manifest.stage invalid");
  if (typeof m.round !== "number")
    throw new Error("review-snapshot: manifest.round missing");
  if (typeof m.createdAt !== "string")
    throw new Error("review-snapshot: manifest.createdAt missing");
  if (typeof m.snapshotRoot !== "string")
    throw new Error("review-snapshot: manifest.snapshotRoot missing");
  if (typeof m.canonicalProjectRoot !== "string")
    throw new Error("review-snapshot: manifest.canonicalProjectRoot missing");
  if (!Array.isArray(m.files))
    throw new Error("review-snapshot: manifest.files missing");
  if (typeof m.fileCount !== "number")
    throw new Error("review-snapshot: manifest.fileCount missing");
  if (typeof m.totalBytes !== "number")
    throw new Error("review-snapshot: manifest.totalBytes missing");
  const files: ReviewSnapshotManifestFileEntry[] = [];
  for (const f of m.files as unknown[]) {
    if (!f || typeof f !== "object")
      throw new Error("review-snapshot: manifest.files[] entry invalid");
    const fe = f as Record<string, unknown>;
    if (typeof fe.path !== "string")
      throw new Error("review-snapshot: manifest entry missing path");
    if (typeof fe.sha256 !== "string")
      throw new Error("review-snapshot: manifest entry missing sha256");
    if (typeof fe.bytes !== "number")
      throw new Error("review-snapshot: manifest entry missing bytes");
    files.push({ path: fe.path, sha256: fe.sha256, bytes: fe.bytes });
  }
  // Denormalized integrity checks — fileCount and totalBytes are stored
  // in the manifest but must agree with the actual files array.
  if (m.fileCount !== files.length) {
    throw new Error(
      `review-snapshot: manifest fileCount mismatch: stored ${m.fileCount}, files.length ${files.length}`,
    );
  }
  const summedBytes = files.reduce((s, f) => s + f.bytes, 0);
  if (m.totalBytes !== summedBytes) {
    throw new Error(
      `review-snapshot: manifest totalBytes mismatch: stored ${m.totalBytes}, summed ${summedBytes}`,
    );
  }
  return {
    reviewId: m.reviewId,
    sessionId: m.sessionId,
    stage: m.stage,
    round: m.round,
    createdAt: m.createdAt,
    snapshotRoot: m.snapshotRoot,
    canonicalProjectRoot: m.canonicalProjectRoot,
    files,
    fileCount: m.fileCount,
    totalBytes: m.totalBytes,
  };
}

// ── Archive ───────────────────────────────────────────────────────

function walkForSymlinks(dir: string, finalDirReal: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      throw new Error(
        `review-snapshot: symlink in snapshot subtree: ${p}`,
      );
    }
    const real = realpathSync(p);
    if (!real.startsWith(finalDirReal + sep) && real !== finalDirReal) {
      throw new Error(
        `review-snapshot: subtree entry escapes finalDir: ${p}`,
      );
    }
    if (st.isDirectory()) {
      walkForSymlinks(p, finalDirReal);
    }
  }
}

export function archiveReviewSnapshot(
  projectRoot: string,
  sessionId: string,
  reviewId: string,
): ArchiveReviewSnapshotResult {
  assertValidSessionId(sessionId);
  assertValidReviewId(reviewId);

  const paths = deriveCanonicalPaths(projectRoot, sessionId, reviewId);

  assertNoSymlinkAncestors(paths.snapshotParent, paths.canonicalSessionsRoot);
  assertNoSymlinkAncestors(paths.finalDir, paths.canonicalSessionsRoot);

  const finalLstat = lstatSync(paths.finalDir);
  if (finalLstat.isSymbolicLink()) {
    throw new Error(
      `review-snapshot: finalDir is a symlink: ${paths.finalDir}`,
    );
  }
  const realFinalDir = realpathSync(paths.finalDir);

  walkForSymlinks(paths.finalDir, realFinalDir);

  const archivePath = join(paths.snapshotParent, `${reviewId}.tar.gz`);
  if (existsSync(archivePath)) {
    throw new Error(
      `review-snapshot: archive already exists: ${archivePath}`,
    );
  }

  const result = spawnSync(
    "tar",
    ["-czf", archivePath, "-C", paths.snapshotParent, reviewId],
    { stdio: "pipe" },
  );
  if (result.status !== 0) {
    try {
      if (existsSync(archivePath)) rmSync(archivePath, { force: true });
    } catch {
      /* ignore */
    }
    const stderr = result.stderr ? result.stderr.toString() : "";
    throw new Error(
      `review-snapshot: tar failed (exit ${result.status}): ${stderr}`,
    );
  }

  // Make payload files writable before rm so chmod 0o444 payloads don't
  // block deletion on strict filesystems.
  const rmWalk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      try {
        chmodSync(p, 0o755);
      } catch {
        /* ignore */
      }
      if (entry.isDirectory()) rmWalk(p);
    }
  };
  try {
    rmWalk(paths.finalDir);
  } catch {
    /* ignore */
  }
  rmSync(paths.finalDir, { recursive: true, force: true });

  return { archivePath, removedDir: paths.finalDir };
}

// statSync is imported for potential future use; referenced to avoid
// an unused-import lint error in this module.
void statSync;

// ── Internal helper re-exports (consumed by verification.ts / T-255) ──
//
// `verification.ts` (T-255) needs the exact same lexical path validator
// and destination-chain symlink guard that this module uses when writing
// and reading snapshots. Re-exporting them under an underscore-prefixed
// name signals "internal to the review-lenses subtree, not part of the
// stable public API" while ensuring writer and verifier share a single
// source of truth. These MUST NOT be re-exported from
// `review-lenses/index.ts` — sibling modules import them directly.
export {
  assertValidManifestPath as _assertValidManifestPath,
  assertNoSymlinkAncestors as _assertNoSymlinkAncestors,
};
