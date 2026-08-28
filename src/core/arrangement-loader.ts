import { readdirSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { ArrangementSchema, type Arrangement } from "../models/arrangement.js";
import { ARRANGEMENT_CANONICAL_ID_REGEX } from "../models/types.js";
import { atomicCreate, atomicWrite, guardPath, serializeJSON } from "./project-loader.js";
import { ProjectLoaderError } from "./errors.js";
import { sanitizeDisplayText } from "./display-text.js";
import { readBoundedFile } from "./limit-config.js";

/**
 * A real arrangement (a handful of bounds refs, two-or-so parties, gate
 * names) is a few hundred bytes to a few KB. 64 KiB leaves generous headroom
 * for a large duet-mode record while keeping a corrupt or hostile multi-MB
 * file from being read in full -- `readBoundedFile` enforces this via
 * `fstat` before ever reading, so an oversized file costs one stat call, not
 * a full read.
 */
const ARRANGEMENT_MAX_BYTES = 65_536;

/**
 * Fail-safe, SYNCHRONOUS read of every arrangement on disk (T-473).
 *
 * Synchronous is load-bearing, not incidental: `evaluateSessionGuard` and
 * `handleStatus` are both synchronous and are called without `await` at
 * their real call sites, so an async loader here would force a migration of
 * both call paths -- nowhere in T-473's scope. `scanSessionSummaries`
 * already establishes the sync-reader precedent this mirrors.
 *
 * Never throws. Per file under `.story/arrangements/`: unreadable, invalid
 * JSON, or schema mismatch -- skip and record a (sanitized) warning. This is
 * what makes arrangements incapable of blocking a write or a status call:
 * the caller gets a best-effort list plus an honest account of what could
 * not be read, never an exception.
 *
 * A missing `.story/arrangements/` directory is the ordinary empty-project
 * state (every pre-T-473 project) and produces no warning -- warning here
 * would make every pre-feature project report degradation on its first
 * post-upgrade call. A warning fires only when the directory exists but
 * cannot be enumerated, or an entry inside it cannot be read/validated.
 */
export function loadArrangementsSafe(
  root: string,
): { arrangements: readonly Arrangement[]; warnings: readonly string[] } {
  const dir = resolve(root, ".story", "arrangements");
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { arrangements: [], warnings: [] };
    }
    return {
      arrangements: [],
      warnings: [`Could not read .story/arrangements/: ${sanitizeDisplayText(String(err))}`],
    };
  }

  const arrangements: Arrangement[] = [];
  const warnings: string[] = [];
  for (const entry of dirents) {
    const file = entry.name;
    if (!file.endsWith(".json")) continue;
    // Only ordinary regular files: a symlink (possibly to a FIFO or other
    // blocking device outside the project) or a non-regular node here must
    // never be able to hang or exhaust memory on a synchronous read --
    // binding item 2 (arrangements never block a write or status call).
    if (!entry.isFile()) {
      warnings.push(`arrangements/${sanitizeDisplayText(file)}: not a regular file, skipped`);
      continue;
    }
    const path = join(dir, file);
    // Bounded, non-blocking read (`fstat`-checked size + regular-file
    // re-verification before ever reading a byte): an entry that somehow
    // grew past `entry.isFile()`'s snapshot into a special file, or that is
    // simply oversized, must not be able to hang or exhaust memory --
    // binding item 2 (arrangements never block a write or status call).
    const raw = readBoundedFile(path, ARRANGEMENT_MAX_BYTES);
    if (raw === null) {
      warnings.push(`arrangements/${sanitizeDisplayText(file)}: unreadable, empty, or exceeds size limit, skipped`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnings.push(`arrangements/${sanitizeDisplayText(file)}: invalid JSON`);
      continue;
    }
    const result = ArrangementSchema.safeParse(parsed);
    if (!result.success) {
      warnings.push(`arrangements/${sanitizeDisplayText(file)}: schema mismatch`);
      continue;
    }
    // The filename is the lookup key everywhere else (writeArrangementUnlocked
    // always names the file after the record's own id); a mismatch means a
    // copied or tampered file could otherwise mint a second logical identity
    // for one id, or shadow the wrong record depending on directory
    // enumeration order. This check also makes a same-id duplicate directory
    // entry impossible: a directory cannot hold two dirents with the same
    // literal name, and every accepted file's name is required to equal
    // `${id}.json`, so no second file can ever pass this check for an id
    // already loaded.
    if (file !== `${result.data.id}.json`) {
      warnings.push(`arrangements/${sanitizeDisplayText(file)}: filename does not match record id, skipped`);
      continue;
    }
    arrangements.push(result.data);
  }
  return { arrangements, warnings };
}

/**
 * Writes an arrangement file WITHOUT acquiring the project lock.
 * Use inside `withProjectLock` when the lock is already held -- the CLI/MCP
 * create and update handlers (cli/commands/arrangement.ts) are the only
 * callers, exactly mirroring `writeNoteUnlocked`'s usage.
 */
export async function writeArrangementUnlocked(
  arrangement: Arrangement,
  root: string,
  options?: { createOnly?: boolean },
): Promise<void> {
  const parsed = ArrangementSchema.parse(arrangement);
  if (!ARRANGEMENT_CANONICAL_ID_REGEX.test(parsed.id)) {
    throw new ProjectLoaderError("invalid_input", `Invalid arrangement ID: ${parsed.id}`);
  }
  const wrapDir = resolve(root, ".story");
  const targetPath = join(wrapDir, "arrangements", `${parsed.id}.json`);
  await mkdir(dirname(targetPath), { recursive: true });
  await guardPath(targetPath, wrapDir);
  const json = serializeJSON(parsed);
  if (options?.createOnly) {
    await atomicCreate(targetPath, json);
  } else {
    await atomicWrite(targetPath, json);
  }
}
