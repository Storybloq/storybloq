import { lstatSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export interface DirIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface ReaddirSafeResult {
  readonly dirents: readonly Dirent[] | null;
  readonly dirIdentity: DirIdentity | null;
  readonly warning: string | null;
}

/**
 * Symlink-rejecting, identity-revalidated directory listing (T-478 /
 * ISS-1053).
 *
 * True race-freedom (a single verified handle carried from open to read) is
 * not achievable through Node's public fs API: opening a directory with
 * O_DIRECTORY|O_NOFOLLOW yields a verified fd, but neither readdirSync nor
 * opendirSync accept a numeric fd for listing (verified empirically, Node
 * v22.18.0, macOS -- both throw "path argument must be of type string").
 * This is the honest weaker bar instead: lstat the path before listing (a
 * symlink there is rejected outright), list, then lstat again and compare
 * device+inode -- a directory swapped out from under the listing, AND STILL
 * SWAPPED at the moment of either lstat, is detected and reported as
 * ambiguous rather than silently trusted. A swap that both occurs and
 * reverts strictly between two lstat calls is NOT detected by this or any
 * other check in this module -- see `verifyDirIdentity`'s doc comment.
 */
export function readdirSafe(dir: string): ReaddirSafeResult {
  let before;
  try {
    before = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { dirents: null, dirIdentity: null, warning: null };
    }
    return { dirents: null, dirIdentity: null, warning: String(err) };
  }
  if (before.isSymbolicLink()) {
    return { dirents: null, dirIdentity: null, warning: "is a symlink, refusing to enumerate" };
  }
  if (!before.isDirectory()) {
    return { dirents: null, dirIdentity: null, warning: "is not a directory" };
  }

  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Only ambiguous here: the FIRST lstat already proved the directory
      // existed, so this ENOENT means it was removed in the gap between the
      // two calls -- a real race, not the ordinary "no .story/<kind>/ yet"
      // case (which returns silently above, before `before` is assigned).
      return { dirents: null, dirIdentity: null, warning: "was removed during enumeration" };
    }
    return { dirents: null, dirIdentity: null, warning: String(err) };
  }

  let after;
  try {
    after = lstatSync(dir);
  } catch {
    return { dirents: null, dirIdentity: null, warning: "vanished during enumeration, discarding listing" };
  }
  if (after.dev !== before.dev || after.ino !== before.ino) {
    return { dirents: null, dirIdentity: null, warning: "identity changed during enumeration (dev/ino mismatch), discarding listing" };
  }

  return { dirents, dirIdentity: { dev: after.dev, ino: after.ino }, warning: null };
}

/**
 * Verifies that `filename`, joined onto `dir`, resolves to a real path
 * actually contained in `dir` -- catches an entry whose target (or an
 * ancestor path component swapped to a symlink between the listing and this
 * call) escapes the directory. Uses `path.relative`, not a string-prefix
 * comparison: `/foo/bar-evil` starts with the string `/foo/bar` while being
 * a SIBLING, not a descendant, so string-prefix containment is not
 * containment.
 *
 * Deliberately does NOT perform the bounded read itself: the three callers
 * of this module use two DIFFERENT bounded-read primitives, DELIBERATELY,
 * not by drift -- `arrangement-loader.ts` and `ruling-loader.ts` use
 * `readBoundedFile` (`core/limit-config.ts`), which resolves a symlinked
 * leaf via realpath before opening it; `gate-ack-loader.ts` uses
 * `readBoundedRegularFile` (`core/pin-utils.ts`), which refuses a symlinked
 * leaf outright via O_NOFOLLOW with no prior resolution -- a stricter
 * primitive T-474 required specifically because a gate-ack's presence is a
 * PERMISSION decision, not a descriptive read (see that file's own doc
 * comment). This module must not flatten that distinction: a single unified
 * read-and-check wrapper (as originally sketched) would have silently
 * applied one loader's symlink policy to all three. Containment is a
 * property of the PATH, independent of which read primitive a caller goes
 * on to use, so this function stays a pure pass/fail check performed BEFORE
 * either read primitive runs, and each loader keeps its own existing read
 * call -- and its own existing leaf-symlink policy -- completely unchanged.
 * Note that `readBoundedRegularFile`'s O_NOFOLLOW only refuses a symlinked
 * LEAF; it does not check ancestor path components, so gate-ack-loader.ts
 * needs this containment check exactly as much as the other two do.
 *
 * Returns `null` on success (proceed with the caller's own bounded read), or
 * a warning string to record and skip the entry.
 *
 * Resolves `dir` itself via `realpathSync` too, not just `full` -- `dir` can
 * legitimately differ from its own real path even with no attack in play
 * (macOS's `/var` is itself a symlink to `/private/var`; a bare temp-dir
 * fixture path resolves the same way). Comparing `full`'s resolved path
 * against `dir`'s UNRESOLVED string produces a false "escaped containment"
 * warning on every ordinary file under such a path. `readdirSafe` has
 * already confirmed `dir` itself is not a symlink, so resolving it here
 * only normalizes ancestor components, the same class of normalization
 * `full`'s own resolution already performs.
 */
export function verifyContainment(dir: string, filename: string): string | null {
  const full = join(dir, filename);
  let resolvedDir: string;
  let resolved: string;
  try {
    resolvedDir = realpathSync(dir);
    resolved = realpathSync(full);
  } catch (err) {
    return `Could not resolve ${full}: ${String(err)}`;
  }
  const rel = relative(resolvedDir, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return `${full} resolved outside ${dir}, refusing to trust content`;
  }
  return null;
}

/**
 * Re-verifies `dir`'s identity once, after a full per-file scan completes --
 * the third and final of this module's three identity checkpoints (before
 * listing, in `readdirSafe`; after listing, also in `readdirSafe`; after the
 * full per-file scan, here). Combined with `verifyContainment`'s per-file
 * check, this is the complete containment story for all three loaders,
 * regardless of which loader's own read primitive runs in between.
 *
 * Detects a directory that is STILL a different identity than it was at the
 * start of the scan (a persistent or unluckily-timed replacement) -- it does
 * NOT detect a swap that occurs and reverts strictly between two checkpoints
 * (before listing / after listing / after this call): a genuine swap-back
 * restores the ORIGINAL dev/ino before this check runs, so this check
 * reports a match for exactly that scenario. That residual is irreducible
 * without an fd-scoped `openat`-style API Node's public `fs` surface does
 * not expose (see `readdirSafe`'s own doc comment) -- sufficient for
 * ISS-1053's LOW-severity, local-write-access-required threat model;
 * insufficient if this module is ever reused for a higher-severity one
 * without revisiting this assumption.
 */
export function verifyDirIdentity(dir: string, expected: DirIdentity): string | null {
  let after;
  try {
    after = lstatSync(dir);
  } catch {
    return "vanished after enumeration, discarding scan";
  }
  if (after.dev !== expected.dev || after.ino !== expected.ino) {
    return "identity changed after enumeration (dev/ino mismatch), discarding scan";
  }
  return null;
}
