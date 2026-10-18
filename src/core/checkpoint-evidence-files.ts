/**
 * T-538: the file side of immutable checkpoint evidence. Every read opens the
 * file once, without following a link in its last component, checks that the
 * handle is a regular file no larger than EVIDENCE_MAX_BYTES and is the same
 * file (device and inode) that was checked by path, and reads from that
 * handle only. Every write goes into `docs/checkpoints/<id>/` through
 * directories that are real directories, never links, and that are still the
 * same directories after the write.
 *
 * Node has no openat, so a directory swapped between the last check and the
 * create can still receive the file for an instant; the check after the create
 * catches that, removes what was created through the swapped path only when
 * that path still reaches the very file created (same device and inode), and
 * otherwise leaves it and reports it as an orphan. Not detected: an ancestor
 * directory swapped and restored by another process during the command. That
 * process could rewrite the ledger itself; these checks guard against
 * mistakes and planted links, not a concurrent writer in the project.
 */
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CliValidationError } from "../cli/helpers.js";
import { ProjectLoaderError } from "./errors.js";
import { atomicCreate } from "./project-loader.js";

/** The largest evidence file read or copied, source and stored revision alike. */
export const EVIDENCE_MAX_BYTES = 32 * 1024 * 1024;

/** A stored revision: `docs/checkpoints/<ticket id>/<first 16 hex of sha256>.<ext>`. */
export const STORED_REVISION_PATTERN = /^docs\/checkpoints\/([^/]+)\/([0-9a-f]{16})\.([a-z0-9]{1,16})$/;

/** Test seams between a check and the action it guards; never set by the CLI or MCP. */
export interface EvidenceIoHooks {
  afterSourceCheck?(): Promise<void>;
  afterDestinationCheck?(): Promise<void>;
  afterCreate?(): Promise<void>;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

function inside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function tooLarge(label: string): CliValidationError {
  return new CliValidationError("invalid_input", `${label} is larger than ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MiB; evidence must be smaller.`);
}

/**
 * Reads `checked` through one no-follow handle. `checkedStat` is the lstat
 * taken when the path was checked; the handle must be that same regular file.
 */
async function readCheckedFile(checked: string, checkedStat: Stats, label: string, afterCheck?: () => Promise<void>): Promise<Buffer> {
  if (checkedStat.isSymbolicLink()) throw new CliValidationError("invalid_input", `${label} is a link; evidence is read only from a regular file.`);
  if (!checkedStat.isFile()) throw new CliValidationError("invalid_input", `${label} is not a regular file.`);
  if (checkedStat.size > EVIDENCE_MAX_BYTES) throw tooLarge(label);
  await afterCheck?.();
  let handle;
  try {
    handle = await open(checked, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new CliValidationError("invalid_input", `${label} is a link; evidence is read only from a regular file.`);
    if (code === "ENOENT") throw new CliValidationError("conflict", `${label} changed while it was being read; nothing was written.`);
    throw err;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new CliValidationError("invalid_input", `${label} is not a regular file.`);
    if (!sameFile(opened, checkedStat)) throw new CliValidationError("conflict", `${label} changed while it was being read; nothing was written.`);
    if (opened.size > EVIDENCE_MAX_BYTES) throw tooLarge(label);
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > EVIDENCE_MAX_BYTES) throw tooLarge(label);
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/**
 * The source of `checkpoint evidence`: a regular file inside the project,
 * named by a path whose directories resolve inside the project and whose last
 * component is not a link. Returns its bytes and its resolved path.
 */
export async function readEvidenceSource(root: string, file: string, hooks: EvidenceIoHooks = {}): Promise<{ path: string; bytes: Buffer }> {
  const outside = () => new CliValidationError("invalid_input", `Evidence must be a file inside the project: ${file}`);
  const base = await realpath(root);
  const lexical = resolve(root, file);
  if (!inside(resolve(root), lexical) && !inside(base, lexical)) throw outside();
  let realParent: string;
  try {
    realParent = await realpath(dirname(lexical));
  } catch {
    throw new CliValidationError("not_found", `Evidence file not found: ${file}`);
  }
  const checked = join(realParent, basename(lexical));
  if (!inside(base, checked)) throw outside();
  let checkedStat: Stats;
  try {
    checkedStat = await lstat(checked);
  } catch {
    throw new CliValidationError("not_found", `Evidence file not found: ${file}`);
  }
  const bytes = await readCheckedFile(checked, checkedStat, `Evidence ${file}`, hooks.afterSourceCheck);
  // An ancestor swapped for a link after the check resolves elsewhere now.
  let parentAfter: string | null = null;
  try { parentAfter = await realpath(dirname(lexical)); } catch { /* reported below */ }
  if (parentAfter !== realParent) throw new CliValidationError("conflict", `Evidence ${file} changed while it was being read; nothing was written.`);
  return { path: checked, bytes };
}

interface DirIdentity {
  readonly path: string;
  readonly stat: Stats;
}

function linkedDirectory(rel: string): CliValidationError {
  return new CliValidationError("conflict", `${rel} is a link or not a directory; evidence is never written through one. Replace it with a plain directory by hand.`);
}

/** `docs`, `docs/checkpoints` and `docs/checkpoints/<id>`, each a real directory; created when absent. */
async function evidenceDirectories(root: string, id: string, create: boolean): Promise<DirIdentity[]> {
  const out: DirIdentity[] = [];
  const parts = ["docs", "checkpoints", id];
  for (let i = 0; i < parts.length; i++) {
    const rel = parts.slice(0, i + 1).join("/");
    const path = join(root, ...parts.slice(0, i + 1));
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw new CliValidationError("not_found", `${rel} does not exist.`);
      try {
        await mkdir(path);
      } catch (mkErr) {
        if ((mkErr as NodeJS.ErrnoException).code !== "EEXIST") throw mkErr;
      }
      stat = await lstat(path);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw linkedDirectory(rel);
    out.push({ path, stat });
  }
  return out;
}

async function directoriesUnchanged(chain: readonly DirIdentity[]): Promise<boolean> {
  for (const d of chain) {
    try {
      const now = await lstat(d.path);
      if (now.isSymbolicLink() || !now.isDirectory() || !sameFile(now, d.stat)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Reads a stored revision (or a file already at a revision's name) through the same checks. */
async function readStoredFile(root: string, ref: string): Promise<Buffer> {
  const path = join(root, ...ref.split("/"));
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch {
    throw new CliValidationError("not_found", `${ref} does not exist.`);
  }
  return readCheckedFile(path, stat, ref);
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Publishes `bytes` at `ref` by a no-replace create. A file already there
 * with the same bytes is reused; other bytes, a link, or a directory that is
 * a link anywhere on the way is refused, and nothing is replaced.
 */
export async function publishEvidenceRevision(root: string, id: string, ref: string, bytes: Buffer, hooks: EvidenceIoHooks = {}): Promise<void> {
  const chain = await evidenceDirectories(root, id, true);
  await hooks.afterDestinationCheck?.();
  if (!(await directoriesUnchanged(chain))) throw linkedDirectory(`docs/checkpoints/${id}`);
  const target = join(root, ...ref.split("/"));
  let created: { dev: number; ino: number } | undefined;
  try {
    created = await atomicCreate(target, bytes);
    await hooks.afterCreate?.();
  } catch (err) {
    if (!(err instanceof ProjectLoaderError) || err.code !== "file_exists") throw err;
    const existing = await readStoredFile(root, ref);
    if (sha256(existing) !== sha256(bytes)) {
      throw new CliValidationError("conflict", `${ref} already holds other content; it is never replaced. Move it aside by hand if it is not evidence.`);
    }
  }
  if (!(await directoriesUnchanged(chain))) {
    if (created && !(await removeIfSame(target, created))) {
      throw new CliValidationError(
        "conflict",
        `docs/checkpoints/${id} changed while evidence was written there; nothing was recorded. The copy it created is now an orphan, left where ${target} pointed at the time; remove it by hand.`,
      );
    }
    throw linkedDirectory(`docs/checkpoints/${id}`);
  }
}

/** Unlinks `path` only while it is still the file `created` names; true when it was removed. */
async function removeIfSame(path: string, created: { dev: number; ino: number }): Promise<boolean> {
  try {
    const now = await lstat(path);
    if (now.dev !== created.dev || now.ino !== created.ino) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * On an immutable checkpoint, an evidence ref or an approved artifactRef
 * must be a stored revision of that checkpoint: the pattern, real directories
 * on the way, a regular file, and content whose digest matches its name.
 */
export async function verifyStoredRevision(root: string, id: string, ref: string, label: string): Promise<void> {
  const m = STORED_REVISION_PATTERN.exec(ref);
  if (!m || m[1] !== id) {
    throw new CliValidationError(
      "invalid_input",
      `${label} uses immutable evidence: "${ref}" is not one of its stored revisions (docs/checkpoints/${id}/<sha16>.<ext>); add files with \`checkpoint evidence\`.`,
    );
  }
  await evidenceDirectories(root, id, false);
  const bytes = await readStoredFile(root, ref);
  if (sha256(bytes).slice(0, 16) !== m[2]) {
    throw new CliValidationError("conflict", `${label}: ${ref} no longer holds the content its name records; the revision was modified.`);
  }
}
