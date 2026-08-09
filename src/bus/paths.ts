import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { BusError } from "./errors.js";
import { syncDirectory } from "./io.js";

export interface BusPaths {
  readonly projectRoot: string;
  readonly storyRoot: string;
  readonly busRoot: string;
  readonly threads: string;
  readonly endpoints: string;
  readonly succession: string;
  readonly mailboxes: string;
  readonly idempotency: string;
  readonly locks: string;
  // T-430: per-task auto-attach outcome records (created at init, validated no-symlink).
  readonly autoAttach: string;
  // ISS-953: content-addressed refused-message artifacts (refused/<refusedPayloadHash>.json).
  // Same "provisioned at init, not layout-required" treatment as autoAttach: an existing v2
  // runtime created before this feature simply lacks it, and its absence must not surface as
  // a doctor/layout finding. Recreated on demand by the write path under an already-validated
  // busRoot.
  readonly refused: string;
}

const ENDPOINT_FILENAME = /^([0-9a-f-]{36})\.json$/i;
const EndpointIdSchema = z.string().uuid();

async function rejectSymlink(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new BusError("invalid_input", `${label} cannot be a symlink`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function assertBusIgnoreFileSafe(storyRoot: string): Promise<void> {
  const path = join(storyRoot, ".gitignore");
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new BusError("invalid_input", ".story/.gitignore must be a regular file");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function assertBusRuntimeIgnored(storyRoot: string): Promise<void> {
  await assertBusIgnoreFileSafe(storyRoot);
  let raw: string;
  try {
    raw = await readFile(join(storyRoot, ".gitignore"), "utf-8");
  } catch (err) {
    throw new BusError(
      "conflict",
      "Bus runtime is not protected by .story/.gitignore. Run `storybloq bus setup` first.",
      err,
    );
  }
  let ignored = false;
  for (const entry of raw.split(/\r?\n/).map((line) => line.trim())) {
    const normalized = entry.startsWith("/") ? entry.slice(1) : entry;
    const pattern = normalized.startsWith("!/") ? `!${normalized.slice(2)}` : normalized;
    if (pattern === "bus/") ignored = true;
    else if (pattern === "!bus" || pattern.startsWith("!bus/")) ignored = false;
    else if (pattern.startsWith("!")) {
      throw new BusError("conflict", "Bus ignore safety cannot be verified with negation patterns");
    }
  }
  if (!ignored) {
    throw new BusError(
      "conflict",
      "Bus runtime is not protected by .story/.gitignore. Run `storybloq bus setup` first.",
    );
  }
}

export async function resolveBusPaths(projectRoot: string, _create?: false): Promise<BusPaths> {
  let canonicalProject: string;
  try {
    canonicalProject = await realpath(resolve(projectRoot));
  } catch (err) {
    throw new BusError("not_found", `Cannot resolve project root: ${projectRoot}`, err);
  }
  const storyRoot = join(canonicalProject, ".story");
  await rejectSymlink(storyRoot, ".story");
  try {
    const storyStat = await lstat(storyRoot);
    if (!storyStat.isDirectory()) throw new BusError("invalid_input", ".story is not a directory");
  } catch (err) {
    if (err instanceof BusError) throw err;
    throw new BusError("not_found", "No .story project found", err);
  }

  const busRoot = join(storyRoot, "bus");
  await rejectSymlink(busRoot, ".story/bus");
  const paths: BusPaths = {
    projectRoot: canonicalProject,
    storyRoot,
    busRoot,
    threads: join(busRoot, "threads"),
    endpoints: join(busRoot, "endpoints"),
    succession: join(busRoot, "succession"),
    mailboxes: join(busRoot, "mailboxes"),
    idempotency: join(busRoot, "idempotency"),
    locks: join(busRoot, "locks"),
    autoAttach: join(busRoot, "auto-attach"),
    refused: join(busRoot, "refused"),
  };
  for (const [path, label] of [
    [paths.threads, ".story/bus/threads"],
    [paths.endpoints, ".story/bus/endpoints"],
    [paths.succession, ".story/bus/succession"],
    [paths.mailboxes, ".story/bus/mailboxes"],
    [paths.idempotency, ".story/bus/idempotency"],
    [paths.locks, ".story/bus/locks"],
    [paths.autoAttach, ".story/bus/auto-attach"],
    [paths.refused, ".story/bus/refused"],
  ] as const) {
    await rejectSymlink(path, label);
  }
  return paths;
}

// The v2 layout drops the hardcoded implementer/reviewer mailbox subdirs; each
// endpoint owns a mailbox created lazily at join. These are the always-required
// structural directories; per-endpoint mailbox dirs are validated separately.
export function requiredBusDirectories(paths: BusPaths): string[] {
  return [
    paths.busRoot,
    paths.threads,
    paths.endpoints,
    paths.succession,
    paths.mailboxes,
    paths.idempotency,
    paths.locks,
  ];
}

export async function createBusPathsForInitialization(projectRoot: string): Promise<BusPaths> {
  const paths = await resolveBusPaths(projectRoot);
  await assertBusRuntimeIgnored(paths.storyRoot);
  for (const directory of requiredBusDirectories(paths)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rejectSymlink(directory, relative(paths.projectRoot, directory));
  }
  // T-430: the auto-attach outcome dir is provisioned at init but is deliberately NOT a
  // layout-required directory -- an existing v2 runtime created before this feature simply
  // lacks it, and its absence must not surface as a doctor/layout finding. The outcome writer
  // (validatedAutoAttachDir) recreates the leaf under an already-validated busRoot on demand.
  await mkdir(paths.autoAttach, { recursive: true, mode: 0o700 });
  await rejectSymlink(paths.autoAttach, relative(paths.projectRoot, paths.autoAttach));
  // ISS-953: same non-layout-required treatment as autoAttach above.
  await mkdir(paths.refused, { recursive: true, mode: 0o700 });
  await rejectSymlink(paths.refused, relative(paths.projectRoot, paths.refused));
  return paths;
}

export async function busRuntimeExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new BusError("io_error", `Cannot inspect Bus runtime: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

async function endpointMailboxDirectories(paths: BusPaths): Promise<{ directories: string[]; findings: string[] }> {
  let entries;
  try {
    entries = await readdir(paths.endpoints, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { directories: [], findings: [] };
    // A non-ENOENT enumeration failure (EACCES, EIO, ...) must fail CLOSED as a layout
    // finding rather than throw a raw filesystem error out of busLayoutFindings/doctor.
    // An unreadable endpoints dir could hide active endpoint records, so it is treated
    // as corruption the Bus error contract surfaces, not an unhandled exception.
    return { directories: [], findings: [`layout: cannot enumerate ${paths.endpoints}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const directories: string[] = [];
  const findings: string[] = [];
  for (const entry of entries) {
    // Node readdir never yields `.`/`..`; guard them only in case a future API does.
    // A dot-prefixed entry is NOT skipped: durable-write temp files are named
    // `<target>.tmp.<pid>.<uuid>` (never dot-prefixed), so a dot-prefixed name where
    // an endpoint record belongs is always unexpected and must be reported, not
    // hidden (renaming `<uuid>.json` to `.<uuid>.json` would otherwise re-open the
    // fail-open by hiding an active endpoint from the layout scan).
    if (entry.name === "." || entry.name === "..") continue;
    // A symlink, a non-regular file, a dot-prefixed name, or a stem that matches the
    // 36-char filename shape but is not a valid UUID is an unexpected entry where an
    // active endpoint record belongs. Silently skipping it (the previous behavior) let
    // a runtime whose active endpoint record was replaced by a symlink or directory
    // pass assertBusLayout; record a finding instead so the layout assertion rejects it.
    const match = ENDPOINT_FILENAME.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || !match ||
        !EndpointIdSchema.safeParse(match[1]!).success) {
      findings.push(`layout: ${join(paths.endpoints, entry.name)} is not a regular <uuid>.json endpoint record`);
      continue;
    }
    const mailbox = join(paths.mailboxes, match[1]!);
    directories.push(mailbox, join(mailbox, "pending"));
  }
  return { directories, findings };
}

export async function busLayoutFindings(paths: BusPaths): Promise<string[]> {
  const findings: string[] = [];
  const mailboxes = await endpointMailboxDirectories(paths);
  findings.push(...mailboxes.findings);
  const directories = [...requiredBusDirectories(paths), ...mailboxes.directories];
  for (const directory of directories) {
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        findings.push(`layout: ${directory} is not a regular directory`);
      }
    } catch (err) {
      findings.push(`layout: ${directory}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return findings;
}

export async function assertBusLayout(paths: BusPaths): Promise<void> {
  const findings = await busLayoutFindings(paths);
  if (findings.length > 0) throw new BusError("corrupt", findings.join("; "));
}

// Assert ONLY the structural base directories exist as regular directories, not
// each endpoint's per-mailbox children. A missing base directory over an existing
// busRoot is a PARTIAL runtime (an L-031 integrity failure) and must fail closed as
// `corrupt` -- never be silently re-created. Per-endpoint mailbox children are
// healed separately by the join resolver, so they are intentionally not required.
export async function assertBaseBusLayout(paths: BusPaths): Promise<void> {
  for (const directory of requiredBusDirectories(paths)) {
    let entryStat;
    try {
      entryStat = await lstat(directory);
    } catch (err) {
      throw new BusError("corrupt", `Bus runtime layout is incomplete: ${directory}`, err);
    }
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
      throw new BusError("corrupt", `Bus runtime layout is corrupt: ${directory} is not a regular directory`);
    }
  }
}

export function assertContainedPath(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BusError("invalid_input", `Bus path escapes runtime root: ${target}`);
  }
}

export function endpointMailboxPath(paths: BusPaths, endpointId: string): string {
  if (!EndpointIdSchema.safeParse(endpointId).success) {
    throw new BusError("invalid_input", "Invalid endpoint id");
  }
  const path = join(paths.mailboxes, endpointId);
  assertContainedPath(paths.mailboxes, path);
  return path;
}

// ISS-953 Codex round 3 finding #3 residual (order item 9): validate a directory's
// FINAL path component atomically rather than lstat-then-trust. Mirrors io.ts's
// openReadNoFollow exactly, generalized from files to directories: lstat is the
// PORTABLE floor (never follows, so a symlink at `path` is refused on every
// platform, even where O_NOFOLLOW is unavailable at open time), then O_NOFOLLOW
// (when available) makes the open itself fail with ELOOP if `path` is a symlink
// at open time, and the dev/ino identity check closes the residual lstat->open
// gap on platforms lacking O_NOFOLLOW (a mismatch is either a benign concurrent
// replace with a new real directory, or a symlink swap a degraded open followed --
// either way, refuse rather than trust the earlier lstat).
//
// This closes the race for THIS FUNCTION's own check of its one path argument
// only. It does NOT make the returned validity durable for a caller's LATER,
// separate use of a joined child path -- Node has no openat / path-relative-to-fd
// operation (verified against the actual API surface; the pen ruled against
// taking a native dependency to get one), so a subsequent join(dir, filename)
// necessarily re-resolves the ENTIRE path from the root, following symlinks at
// every intermediate component again. That residual is accepted by design (see
// validatedRedeliverMarkerDir's own comment below) and MUST be described as open,
// never as closed by this helper.
// Exported for direct unit testing of the lstat->open identity check in
// isolation (mirrors io.ts's openReadNoFollow, which exposes the equivalent
// seams on readJsonNoFollow itself for the same reason). noFollowFlag/
// afterInspect are test-only: forcing noFollowFlag to 0 exercises the
// degraded-platform branch (proving the portable lstat+identity-check floor
// alone still refuses a symlink even where the kernel-level O_NOFOLLOW
// enforcement is unavailable), and afterInspect runs after the lstat and
// before the open, letting a test deterministically land a symlink swap
// exactly in that window rather than relying on real scheduling races.
export async function openDirNoFollow(
  path: string,
  label: string,
  noFollowFlag?: number,
  afterInspect?: () => Promise<void>,
): Promise<void> {
  const resolvedNoFollowFlag = noFollowFlag ?? (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  const dirFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  const linkStat = await lstat(path);
  // These two checks are functionally redundant with the dev/ino identity
  // check below for DETECTING a symlink: a symlink's own lstat identity can
  // never equal the identity fstat reports for whatever it points at (they
  // are different filesystem objects), so a followed symlink always fails
  // that check too -- confirmed directly, reverting these two throws in
  // isolation flips no test. They are kept for ERROR SHAPE, not detection:
  // verified on this platform (macOS), open()'ing a directory symlink with
  // O_NOFOLLOW|O_DIRECTORY fails with a RAW `ENOTDIR` Error, not a BusError
  // -- without this pre-check, that raw OS error would propagate straight
  // through instead of the clean BusError("corrupt", ...) every caller of
  // this function is entitled to rely on.
  if (linkStat.isSymbolicLink()) throw new BusError("corrupt", `${label} is a symlink`);
  if (!linkStat.isDirectory()) throw new BusError("corrupt", `${label} is not a directory`);
  if (afterInspect) await afterInspect();
  // ISS-953 Codex round 4 finding #3: the pre-check above only catches a symlink
  // already present AT lstat time. A swap landing in the window afterInspect
  // exercises -- after lstat, before this open() -- makes O_NOFOLLOW|O_DIRECTORY
  // throw a RAW ENOTDIR/ELOOP/ENOENT Error, not the documented BusError("corrupt",
  // ...) contract every caller relies on. Translate race-indicating errors here;
  // rethrow anything else (e.g. EACCES) unchanged, since only the race-shaped
  // codes are this function's own contract to keep.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | resolvedNoFollowFlag | dirFlag);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT") {
      throw new BusError("corrupt", `${label} changed during open`, err);
    }
    throw err;
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory() || openedStat.dev !== linkStat.dev || openedStat.ino !== linkStat.ino) {
      throw new BusError("corrupt", `${label} changed identity during open`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ISS-953: resolve a predecessor thread's redeliver-markers directory, mirroring
// validatedRefusedDir's (refused.ts) symlink-safe, lazily-created-on-demand,
// re-validate-after-create contract. Unlike refused.ts's single global directory,
// this one is per-thread and did not exist at all before this feature, so an
// older thread's directory entry at this exact leaf name has never been
// validated by anything -- a pre-existing symlink there would silently redirect
// both durableCreate (write) and readJsonNoFollow (read) outside the Bus root,
// since neither protects anything but the final path component they are given.
// The thread directory itself is ALSO validated below, on every call (not only
// on create): lstat only guards the path's FINAL component, so joining
// "redeliver-markers" under an unvalidated predecessorThreadId and lstat-ing
// only that leaf silently follows an intermediate symlink if the thread
// directory were ever replaced with one after its original, genuinely-safe
// Bus-managed creation (publishNewThread's atomic tempDir-then-rename) -- a
// TOCTOU between that creation and this call, not a concern this function's
// original "Bus already creates it safely" reasoning covered. validatedRefusedDir
// validates its own parent (paths.busRoot) the same way for the same reason.
// No `recursive: true` on the mkdir below: a recursive mkdir SUCCEEDS SILENTLY
// when a path component already exists as a symlink to a directory, which would
// make this whole check unable to fail closed even in principle.
//
// ISS-953 Codex round 3 finding #3 residual (order item 9, pen's ruling): this
// function validates threadDir and the redeliver-markers directory it returns
// via openDirNoFollow (O_NOFOLLOW + dev/ino identity check, not a bare lstat),
// closing the race for ITS OWN check of each path. That does NOT make the
// returned `dir` string durably safe for a caller's LATER use -- Node has no
// openat / path-relative-to-fd operation (the pen ruled against taking a
// native dependency to get one; verified against Node's actual API surface:
// fs.constants.O_NOFOLLOW/O_DIRECTORY exist, fs.openat does not), so a later
// join(dir, filename) necessarily re-resolves the WHOLE path from the root,
// following symlinks at every intermediate component again. This residual is
// ACCEPTED BY DESIGN, not closed by this function or by openDirNoFollow.
//
// ISS-999 (order item 12): the paragraph above was written by inference and
// never executed. Both callers were then run against a real, injected
// post-return swap (store.test.ts's READ and CREATE tests), and the two
// halves turned out to need stating SEPARATELY -- the note above described
// neither accurately.
//
// READ (fold.ts's readRedeliverMarker / store.ts's redeliverBusMessage
// marker-check): the swap DOES reach a forged file at the escape target --
// readJsonNoFollow follows it and parses attacker-controlled content. But
// that content is then independently re-verified by fold.ts's
// verifiedSuccessorState against real on-disk successor-thread state (hash
// chain back to this entryHash, kind/topicRef binding, recipient binding --
// see finding #1's fix above in fold.ts), which a marker naming a
// non-existent or unrelated successor thread cannot satisfy: it is
// classified "pending", never "verified", so its content is never trusted or
// acted on. Content-level impersonation via this route would require forging
// an entire real, hash-chained successor thread, not one JSON file in a
// hijacked directory -- a materially larger attack than the swap alone.
//
// CREATE (store.ts's createHopCapSuccessorThread marker write): this half was
// genuinely exploitable, not merely theoretical. durableCreate's own path
// resolution followed the swap for the WRITE: the legitimate marker silently
// landed in the attacker's directory while the caller received complete,
// unremarkable success (replaySource "none", a real successor thread
// created, no error). store.ts now closes the SILENCE (not the race -- the
// write still lands wherever the swap points, which nothing here prevents)
// with a deterministic post-write check: lstat on the exact validated
// directory string, which never follows its own final component, so a
// symlink planted there is reported truthfully regardless of when it
// happened. This catches a PERSISTENT redirect on every call; a
// swap-then-immediately-revert around the single write remains a live,
// unclosed race, accepted for the same reason as the read side -- it
// achieves nothing an attacker with checkout write access could not already
// do more simply, and Node gives no way to close it.
//
// On "an actor able to swap an intermediate component already has write
// access inside the user's own checkout, so editing store.ts directly is the
// simpler attack": true of CAPABILITY REQUIRED, but not a reason to treat the
// create-path finding as a non-issue (ISS-999's severity argument for HIGH,
// recorded there) -- capability required and cost/detectability are
// different axes. This swap needs no code execution, no restart, no
// recompile, just winning one mkdir window, and before this fix produced a
// silent success with no operator-visible signal, unlike editing source.
export async function validatedRedeliverMarkerDir(
  paths: BusPaths,
  predecessorThreadId: string,
  opts: { create: boolean; afterProbe?: () => Promise<void> },
): Promise<string | null> {
  const threadDir = join(paths.threads, predecessorThreadId);
  const threadExists = await lstat(threadDir).then(
    () => true,
    (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    },
  );
  // Every caller reaches this function only after already folding
  // predecessorThreadId successfully (locating a park entry on it, or
  // processing it as the thread currently being folded), so its directory is
  // guaranteed to exist by the time execution gets here. A missing directory
  // at this point is not "no redeliver-markers dir yet" (the leaf-missing case
  // below, which IS benign and common) -- it means the thread's own storage
  // vanished between that fold and this call, a genuine corruption distinct
  // from an absent marker. Throwing `corrupt` (rather than `not_found`, which
  // fold.ts's readRedeliverMarker treats as benign "no marker present") keeps
  // that distinction visible to every caller.
  if (!threadExists) {
    throw new BusError("corrupt", `Bus thread directory is missing (thread ${predecessorThreadId})`);
  }
  // ISS-953 Codex round 5 finding #5: corrected. openDirNoFollow validates
  // threadDir's FINAL component atomically (O_NOFOLLOW + dev/ino identity
  // check), but that check is against its OWN internal lstat (paths.ts's
  // openDirNoFollow, `linkStat`), never against `threadExists`'s lstat
  // above -- this function receives no stat from that earlier probe and
  // openDirNoFollow accepts none as a parameter. `threadExists`'s only job
  // is error classification (a missing thread directory is "corrupt", not
  // "no marker present yet"); it establishes no continuity with anything
  // openDirNoFollow does next. A swap landing between the `threadExists`
  // lstat above and openDirNoFollow's own internal lstat is NOT detected by
  // comparison with the earlier probe -- only a swap landing AFTER
  // openDirNoFollow's own inspection (its lstat-to-open window) is caught,
  // by its own internal identity check. See the helper's own comment for
  // exactly what it does and does not close.
  await openDirNoFollow(threadDir, `Bus thread directory (thread ${predecessorThreadId})`);
  const dir = join(threadDir, "redeliver-markers");
  const dirExists = await lstat(dir).then(
    () => true,
    (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    },
  );
  // ISS-953 Codex round 3 finding #18 (order item 10): test-only barrier seam,
  // same posture as openDirNoFollow's afterInspect and the ISS-940 seams. The
  // EEXIST branch below is reachable ONLY when two concurrent calls both
  // observe ENOENT above before either commits via mkdir. Relying on Promise.all
  // to interleave that way is a scheduling ASSUMPTION Node does not guarantee:
  // the second call can complete its lstat after the first call's mkdir, take
  // the fast path, and never exercise EEXIST at all -- so the test silently
  // stops testing what it claims while staying green. This hook lets a test
  // hold both calls here until both lstats have returned, making the race
  // deterministic instead of probable. Never passed in production.
  if (opts.afterProbe) await opts.afterProbe();
  if (dirExists) {
    await openDirNoFollow(dir, `redeliver-markers (thread ${predecessorThreadId})`);
    return dir;
  }
  if (!opts.create) return null;
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Replaces a separate post-mkdir lstat: mkdir's own EEXIST recovery and a
  // LATER, separate lstat re-verify is itself a two-syscall gap another
  // process could land a symlink swap inside. openDirNoFollow's open+fstat is
  // the atomic form of the same re-verify.
  await openDirNoFollow(dir, `redeliver-markers (thread ${predecessorThreadId})`);
  // ISS-953: fsync the parent (thread) directory so the "redeliver-markers"
  // entry itself survives a crash -- durableCreate below only syncs the marker
  // FILE's own containing directory, which is this one, but only once it exists;
  // without this, a crash between mkdir and this sync can lose the directory
  // entry while the successor thread it was meant to guard against duplicating
  // still lands, defeating the uniqueness guarantee this exists for.
  //
  // Unconditional, not gated on this call having been the one that created the
  // directory (an earlier version only synced on that branch): a crash-recovery
  // retry hitting EEXIST because a PRIOR call already created the directory has
  // no way to know whether that prior call crashed before reaching ITS OWN sync
  // -- skipping the sync here on the assumption "someone already did it" is
  // exactly the assumption a crash between mkdir and sync falsifies. Syncing a
  // directory that is, in fact, already durable is a cheap, idempotent no-op, so
  // there is no correctness reason to special-case the just-created branch.
  await syncDirectory(threadDir);
  return dir;
}
