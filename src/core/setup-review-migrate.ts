/**
 * ISS-1457 (plan v3 section 5): setups used to live under the temporary
 * folder, which the system may empty and other processes share. They now live
 * in the user's state folder. A setup still only in the old place is copied
 * across, data only and validated, the first time it is used; the old copy is
 * left where it is. Copying and creating a setup both publish under one lock
 * per setup id, kept outside the setup's folder, so neither can see the other
 * half done.
 */
import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireProjectLockAsync, releaseProjectLock, type ProjectLockHandle } from "./project-lock.js";
import { fsyncDir, loadRecords, readSetup, sha256, type SetupPaths } from "./setup-review.js";

const LOCK_WAIT = { deadlineMs: 2_000, pollMs: 25 };
const LEGACY_LOCK_WAIT = { deadlineMs: 250, pollMs: 25 };

/** Where setups lived before ISS-1457. */
export function legacyStoreRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `storybloq-setup-review-${uid}`);
}

function pathsAt(dir: string, like: SetupPaths): SetupPaths {
  return { ...like, dir, setupFile: join(dir, "setup.json"), records: join(dir, "records"), revisions: join(dir, "revisions"), lock: join(dir, "run.lock") };
}

/** The lock both migration and creation publish under: one per setup id, beside the setup's folder. */
export function publicationLockPath(paths: SetupPaths): string {
  return join(dirname(paths.dir), `.publish-${paths.setupId}.lock`);
}

export type Placement =
  | { readonly kind: "present" }
  | { readonly kind: "created" }
  | { readonly kind: "migrated"; readonly from: string }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly detail: string };

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Test seams, not reachable through any CLI or MCP input: `beforePublish` runs
 * between the validated copy and its rename; `fsyncFile` makes one copied file
 * durable, so a row can see each one synced before the rename.
 */
export const migrateSeams: { beforePublish: () => Promise<void> | void; fsyncFile: (path: string) => void } = { beforePublish: () => {}, fsyncFile };

/** Whether the setup is already whole in the store, so using it needs no move and no refusal. */
export function setupInPlace(paths: SetupPaths, env: NodeJS.ProcessEnv): boolean {
  return destinationState(paths, legacyOf(paths, env)) === "present";
}

function legacyOf(paths: SetupPaths, env: NodeJS.ProcessEnv): SetupPaths | null {
  if (env.STORYBLOQ_SETUP_REVIEW_DIR) return null;
  const legacy = pathsAt(join(legacyStoreRoot(), paths.projectKey, paths.setupId), paths);
  return existsSync(legacy.setupFile) ? legacy : null;
}

/**
 * The destination as placement sees it. With no copy in the old store, a
 * setup.json that reads is enough, as before. With one, the destination may be
 * a move a crash cut short, so every file in it must be present and valid;
 * otherwise it is broken, and the reason is returned for the refusal. A run in
 * flight in the destination is not a fault.
 */
function destinationState(paths: SetupPaths, legacy: SetupPaths | null): "present" | "absent" | { readonly broken: string } {
  if (!complete(paths)) return "absent";
  if (legacy === null) return "present";
  const problem = dataProblem(paths, true);
  return problem === null ? "present" : { broken: problem };
}

function brokenRefusal(paths: SetupPaths, legacy: SetupPaths, problem: string): Placement {
  return { kind: "refused", detail: `${paths.dir} is an incomplete copy of the setup (${problem}); it was left as it is. The setup is still at ${legacy.dir}: move ${paths.dir} aside, then try again` };
}

function complete(paths: SetupPaths): boolean {
  try {
    readSetup(paths);
    return true;
  } catch {
    return false;
  }
}

/** Why a setup in the old store cannot be copied, or null when every file in it validates. */
function legacyProblem(legacy: SetupPaths): string | null {
  return dataProblem(legacy, false);
}

/** Why a setup's files are not all present and valid, or null; `inFlight` allows a run's staging folder. */
function dataProblem(legacy: SetupPaths, inFlight: boolean): string | null {
  try {
    readSetup(legacy);
  } catch (e) {
    return `its setup.json does not validate (${(e as Error).message})`;
  }
  let names: string[] = [];
  try {
    names = readdirSync(legacy.records);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return `its records cannot be read (${(e as Error).message})`;
  }
  const staging = names.find((n) => n.startsWith(".staging-"));
  if (staging && !inFlight) return `a review is in flight there (${join(legacy.records, staging)})`;
  for (const rec of loadRecords(legacy)) {
    if (rec.kind !== "valid") return `record ${rec.recordId} does not validate`;
  }
  let revisions: string[] = [];
  try {
    revisions = readdirSync(legacy.revisions);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return `its revisions cannot be read (${(e as Error).message})`;
  }
  for (const name of revisions) {
    const m = /^([0-9a-f]{64})\.md$/.exec(name);
    if (!m || !lstatSync(join(legacy.revisions, name)).isFile() || sha256(readFileSync(join(legacy.revisions, name))) !== m[1]) return `revision ${name} does not validate`;
  }
  return null;
}

/** Regular files only, never a link, never a lock or a staging folder. */
function copyData(from: SetupPaths, to: SetupPaths): void {
  mkdirSync(to.dir, { mode: 0o700 });
  copyFileSync(from.setupFile, to.setupFile);
  migrateSeams.fsyncFile(to.setupFile);
  for (const [src, dst, keep] of [[from.records, to.records, /^SR-/], [from.revisions, to.revisions, /^[0-9a-f]{64}\.md$/]] as const) {
    if (!existsSync(src)) continue;
    mkdirSync(dst, { mode: 0o700 });
    for (const name of readdirSync(src)) {
      if (!keep.test(name)) continue;
      const s = join(src, name);
      const st = lstatSync(s);
      if (st.isFile()) {
        copyFileSync(s, join(dst, name));
        migrateSeams.fsyncFile(join(dst, name));
      } else if (st.isDirectory() && src === from.records) {
        mkdirSync(join(dst, name), { mode: 0o700 });
        for (const f of readdirSync(s)) {
          if (!lstatSync(join(s, f)).isFile()) continue;
          copyFileSync(join(s, f), join(dst, name, f));
          migrateSeams.fsyncFile(join(dst, name, f));
        }
        fsyncDir(join(dst, name));
      }
    }
    fsyncDir(dst);
  }
  fsyncDir(to.dir);
}

/**
 * Makes sure the setup's folder is in the store before it is used. With
 * `create`, a setup in neither place is created empty; without it, it is
 * left absent for the caller to report. The legacy setup's own lock is taken
 * first, then the publication lock. A legacy setup with a live lock or a
 * review in flight is refused, never copied; so is one that fails
 * validation, and a half-made folder in the new store.
 */
export async function placeSetup(paths: SetupPaths, env: NodeJS.ProcessEnv, create: boolean): Promise<Placement> {
  const legacy = legacyOf(paths, env);
  const fromLegacy = legacy !== null;
  const first = destinationState(paths, legacy);
  if (first === "present") return { kind: "present" };
  if (first !== "absent") return brokenRefusal(paths, legacy!, first.broken);
  if (!fromLegacy && !create) return { kind: "absent" };

  // The publication lock first: a second caller waits for a move in progress and then finds the setup whole,
  // instead of timing out on the old store's run lock the mover holds.
  mkdirSync(dirname(paths.dir), { recursive: true, mode: 0o700 });
  let lock: ProjectLockHandle;
  try {
    lock = await acquireProjectLockAsync(publicationLockPath(paths), LOCK_WAIT);
  } catch {
    return { kind: "refused", detail: `setup ${paths.setupId} is being created or moved by another process; try again` };
  }
  let legacyLock: ProjectLockHandle | null = null;
  try {
    const state = destinationState(paths, legacy);
    if (state === "present") return { kind: "present" };
    if (state !== "absent") return brokenRefusal(paths, legacy!, state.broken);
    if (fromLegacy) {
      try {
        legacyLock = await acquireProjectLockAsync(legacy.lock, LEGACY_LOCK_WAIT);
      } catch {
        return { kind: "refused", detail: `the setup in the old store at ${legacy.dir} is in use; finish or stop that run, then try again` };
      }
    }
    if (existsSync(paths.dir)) {
      if (!fromLegacy && create && readdirSync(paths.dir).length === 0) return { kind: "created" };
      return { kind: "refused", detail: `${paths.dir} holds a half-made setup; move it aside${fromLegacy ? ` (the setup is still at ${legacy!.dir})` : ""}, then try again` };
    }
    if (!fromLegacy) {
      mkdirSync(paths.dir, { mode: 0o700 });
      fsyncDir(dirname(paths.dir));
      return { kind: "created" };
    }
    const problem = legacyProblem(legacy!);
    if (problem) return { kind: "refused", detail: `the setup at ${legacy!.dir} cannot be moved: ${problem}` };
    // A mover killed before its rename leaves its staging folder; the publication lock is held, so no live mover owns one.
    for (const name of readdirSync(dirname(paths.dir))) {
      if (name.startsWith(`.migrate-${paths.setupId}-`)) rmSync(join(dirname(paths.dir), name), { recursive: true, force: true });
    }
    const staging = pathsAt(join(dirname(paths.dir), `.migrate-${paths.setupId}-${randomBytes(4).toString("hex")}`), paths);
    try {
      copyData(legacy!, staging);
      const copied = legacyProblem(staging);
      if (copied) return { kind: "refused", detail: `the copy of ${legacy!.dir} does not validate: ${copied}` };
      await migrateSeams.beforePublish();
      if (existsSync(paths.dir)) return { kind: "refused", detail: `${paths.dir} appeared while the setup was being moved; try again` };
      renameSync(staging.dir, paths.dir);
      fsyncDir(dirname(paths.dir));
    } finally {
      rmSync(staging.dir, { recursive: true, force: true });
    }
    return { kind: "migrated", from: legacy!.dir };
  } finally {
    if (legacyLock) releaseProjectLock(legacyLock);
    releaseProjectLock(lock);
  }
}
