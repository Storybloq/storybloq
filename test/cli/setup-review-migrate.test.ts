/**
 * ISS-1457: setups move from the old temporary store to the user's state
 * folder, data only and validated, the first time they are used; a setup in
 * flight or one that does not validate is refused and nothing is copied; a
 * move and a creation of the same id never interleave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { handleSetupReviewGate, handleSetupReviewRun, handleSetupReviewStatus, type SetupReviewIo, type SetupReviewResult } from "../../src/cli/commands/setup-review.js";
import { setupPaths, storeRoot, storeRootSeams, storeSeams } from "../../src/core/setup-review.js";
import { legacyStoreRoot, migrateSeams, placeSetup, publicationLockPath } from "../../src/core/setup-review-migrate.js";
import { acquireProjectLockAsync, releaseProjectLock } from "../../src/core/project-lock.js";
import { makeFakeBin, makeScratchDir, removeScratchDirs, REVIEW_PACKET, type FakeBin } from "../helpers/setup-review-fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const FAST = { attemptMs: 1_500, totalMs: 4_000, killGraceMs: 200 };
const realPlatform = storeRootSeams.platform;
const realBefore = migrateSeams.beforePublish;
const realFsyncFile = migrateSeams.fsyncFile;
const realWriteProbe = storeSeams.writeProbe;

let project: string;
let home: string;
let tmp: string;
let fake: FakeBin;

beforeEach(() => {
  project = makeScratchDir("sr-mig-project-");
  home = realpathSync(makeScratchDir("sr-mig-home-"));
  tmp = realpathSync(makeScratchDir("sr-mig-tmp-"));
  vi.stubEnv("TMPDIR", tmp);
  storeRootSeams.platform = () => "darwin";
  fake = makeFakeBin(["codex"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  storeRootSeams.platform = realPlatform;
  migrateSeams.beforePublish = realBefore;
  migrateSeams.fsyncFile = realFsyncFile;
  storeSeams.writeProbe = realWriteProbe;
  removeScratchDirs();
});

/** The environment before ISS-1457 is simulated by naming the old store as the override. */
function io(opts: { legacy?: boolean; stdin?: string } = {}): SetupReviewIo {
  return {
    cwd: project,
    env: { PATH: fake.path, FAKE_LOG: fake.log, FAKE_STDIN_DIR: fake.stdinDir, FAKE_CODEX_PROBE: "reach", HOME: home, ...(opts.legacy ? { STORYBLOQ_SETUP_REVIEW_DIR: legacyStoreRoot() } : {}) },
    stdin: () => {
      if (opts.stdin === undefined) throw new Error("stdin must not be read");
      return Buffer.from(opts.stdin);
    },
    deps: { timeoutMs: 2_000, killGraceMs: 200, probeLimits: FAST },
  };
}
const idOf = (r: SetupReviewResult): string => /^Setup id: (SS-[0-9a-f]{8})$/m.exec(r.stdout)![1]!;
const newPaths = (id: string) => setupPaths({ HOME: home }, project, id);
const oldPaths = (id: string) => setupPaths({ STORYBLOQ_SETUP_REVIEW_DIR: legacyStoreRoot() }, project, id);
/** Every file under a folder with its bytes, so "unchanged" is compared byte for byte. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const p = join(dir, name);
    try {
      out[name] = readFileSync(p, "base64");
    } catch {
      out[name] = "<dir>";
    }
  }
  return out;
}

describe("the store's default place", () => {
  it("is the state folder on each platform, and the override still wins", () => {
    expect(storeRoot({ HOME: "/h" })).toBe("/h/Library/Application Support/storybloq/setup-review");
    storeRootSeams.platform = () => "linux";
    expect(storeRoot({ HOME: "/h", XDG_STATE_HOME: "/x" })).toBe("/x/storybloq/setup-review");
    expect(storeRoot({ HOME: "/h", XDG_STATE_HOME: "relative" })).toBe("/h/.local/state/storybloq/setup-review");
    expect(storeRoot({ HOME: "/h" })).toBe("/h/.local/state/storybloq/setup-review");
    expect(storeRoot({ HOME: "/h", STORYBLOQ_SETUP_REVIEW_DIR: "/o" })).toBe("/o");
  });

  it("is never the temporary folder", () => {
    expect(storeRoot({ HOME: home }).startsWith(tmp)).toBe(false);
  });
});

describe("moving a setup from the old store", () => {
  it("a completed setup reads the same after the upgrade, and the old copy is left in place", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    const run = await handleSetupReviewRun(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    expect(run.exitCode).toBe(0);
    const before = await handleSetupReviewStatus(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    expect(existsSync(newPaths(id).dir)).toBe(false);
    const after = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(after).toEqual(before);
    expect(readFileSync(newPaths(id).setupFile, "utf-8")).toBe(readFileSync(oldPaths(id).setupFile, "utf-8"));
    expect(existsSync(oldPaths(id).setupFile)).toBe(true);
    expect(readdirSync(newPaths(id).dir).sort()).toEqual(["records", "revisions", "setup.json"]);
  });

  it("a skipped setup stays skipped", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    await handleSetupReviewStatus(io({ legacy: true }), { setup: id, skipped: true });
    const skip = JSON.parse(readFileSync(oldPaths(id).setupFile, "utf-8")).skipped;
    expect(skip).toBeDefined();
    const before = await handleSetupReviewStatus(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    const after = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(after).toEqual(before);
    expect(JSON.parse(readFileSync(newPaths(id).setupFile, "utf-8")).skipped).toEqual(skip);
  });

  it("a setup with a review in flight is refused, naming the old path, and nothing is copied", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    mkdirSync(join(oldPaths(id).records, ".staging-SR-0000000000000000"), { recursive: true });
    const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain(oldPaths(id).dir);
    expect(r.stdout).toMatch(/in flight/);
    expect(existsSync(newPaths(id).dir)).toBe(false);
  });

  it("a setup whose run lock is live is refused and nothing is copied", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    const held = await acquireProjectLockAsync(oldPaths(id).lock, { deadlineMs: 250, pollMs: 25 });
    try {
      const r = await handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: id });
      expect(r.stdout).toMatch(new RegExp(`old store at ${oldPaths(id).dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is in use`));
      expect(fake.invocations()).toHaveLength(0);
      expect(existsSync(newPaths(id).dir)).toBe(false);
    } finally {
      releaseProjectLock(held);
    }
  });

  it("a record that fails validation is refused, named, and nothing is copied", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    await handleSetupReviewRun(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    const rec = readdirSync(oldPaths(id).records).find((n) => n.startsWith("SR-"))!;
    writeFileSync(join(oldPaths(id).records, rec, "packet.md"), "tampered\n");
    const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(r.stdout).toContain(`record ${rec} does not validate`);
    expect(existsSync(newPaths(id).dir)).toBe(false);
  });

  it("a half-made folder in the new store is refused, not overwritten", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    mkdirSync(join(newPaths(id).dir, "records"), { recursive: true });
    const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(r.stdout).toMatch(/half-made setup/);
    expect(existsSync(newPaths(id).setupFile)).toBe(false);
  });

  it("a move and a creation of the same id never interleave: one moves it, the other finds it whole", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    const paths = newPaths(id);
    let entered = 0;
    migrateSeams.beforePublish = async () => {
      entered += 1;
      await new Promise((r) => setTimeout(r, 300));
    };
    const env = { HOME: home };
    const [a, b] = await Promise.all([placeSetup(paths, env, false), placeSetup(paths, env, true)]);
    expect([a.kind, b.kind].sort()).toEqual(["migrated", "present"]);
    expect(entered).toBe(1);
    expect(readFileSync(paths.setupFile, "utf-8")).toBe(readFileSync(oldPaths(id).setupFile, "utf-8"));
    expect(readdirSync(join(paths.dir, "..")).filter((n) => n.startsWith(".migrate-"))).toEqual([]);
  });

  it("a creation waits for the publication lock another process holds, and refuses rather than half-making", async () => {
    const paths = newPaths("SS-0123abcd");
    mkdirSync(join(paths.dir, ".."), { recursive: true });
    const held = await acquireProjectLockAsync(publicationLockPath(paths), { deadlineMs: 250, pollMs: 25 });
    try {
      expect(await placeSetup(paths, { HOME: home }, true)).toMatchObject({ kind: "refused" });
      expect(existsSync(paths.dir)).toBe(false);
    } finally {
      releaseProjectLock(held);
    }
    expect(await placeSetup(paths, { HOME: home }, true)).toEqual({ kind: "created" });
  });

  it("a legacy-only setup with a destination that cannot be written: run and status exit 3, nothing is moved, the old copy is unchanged", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    await handleSetupReviewRun(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    const before = tree(oldPaths(id).dir);
    storeSeams.writeProbe = () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    const run = await handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toMatch(/review store: cannot be written from here \(EPERM\)/);
    const status = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(status.exitCode).toBe(3);
    expect(status.stdout).toMatch(/review store: cannot be written from here \(EPERM\)/);
    expect(existsSync(newPaths(id).dir)).toBe(false);
    expect(existsSync(publicationLockPath(newPaths(id)))).toBe(false);
    expect(tree(oldPaths(id).dir)).toEqual(before);
  });

  it("with a destination that cannot be written, a plain status of a setup already moved still reads it", async () => {
    const id = idOf(await handleSetupReviewGate(io(), {}));
    const want = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    storeSeams.writeProbe = () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    expect(await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id })).toEqual(want);
  });

  it("each copied file is synced before the copy is published (mechanism row: a crash cannot be reproduced here)", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    await handleSetupReviewRun(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    const log: string[] = [];
    migrateSeams.fsyncFile = (p) => {
      log.push(p);
      realFsyncFile(p);
    };
    migrateSeams.beforePublish = () => {
      log.push("publish");
    };
    expect((await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id })).exitCode).toBe(0);
    const published = log.indexOf("publish");
    expect(published).toBeGreaterThan(0);
    expect(log.slice(published + 1)).toEqual([]);
    const synced = log.slice(0, published).map((p) => p.replace(/^.*\/\.migrate-[^/]+\//, "")).sort();
    const files = (readdirSync(newPaths(id).dir, { recursive: true }) as string[]).filter((f) => statSync(join(newPaths(id).dir, f)).isFile()).sort();
    expect(files.some((f) => f.endsWith("record.json"))).toBe(true);
    expect(files.some((f) => f.startsWith("revisions/"))).toBe(true);
    expect(synced).toEqual(files);
  });

  it("a moved copy missing a record's file is refused and reported, never deleted, and the old copy is unchanged", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    await handleSetupReviewRun(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    expect((await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id })).exitCode).toBe(0);
    const before = tree(oldPaths(id).dir);
    const recordDir = readdirSync(newPaths(id).records).find((n) => n.startsWith("SR-"))!;
    rmSync(join(newPaths(id).records, recordDir, "record.json"));
    const left = tree(newPaths(id).dir);
    for (const call of [
      () => handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id }),
      () => handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: id }),
    ]) {
      const r = await call();
      expect(r.exitCode).toBe(6);
      expect(r.stdout).toContain(`${newPaths(id).dir} is an incomplete copy of the setup (record ${recordDir} does not validate)`);
      expect(r.stdout).toContain(`The setup is still at ${oldPaths(id).dir}`);
    }
    expect(tree(newPaths(id).dir)).toEqual(left);
    expect(tree(oldPaths(id).dir)).toEqual(before);
  });

  it("a mover killed before its rename leaves its staging folder; the next mover removes it and succeeds", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    const want = await handleSetupReviewStatus(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    const worker = join(import.meta.dirname, "fixtures", "setup-review-migrate-worker.ts");
    const child = spawn(process.execPath, ["--import", "tsx", worker, project, home, id], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, TMPDIR: tmp } });
    let out = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    const signal = await new Promise<NodeJS.Signals | null>((res) => child.once("close", (_code, sig) => res(sig)));
    expect(signal).toBe("SIGKILL");
    expect(out).toBe("");
    const parent = dirname(newPaths(id).dir);
    const abandoned = readdirSync(parent).filter((n) => n.startsWith(`.migrate-${id}-`));
    expect(abandoned).toHaveLength(1);
    expect(existsSync(newPaths(id).dir)).toBe(false);
    const status = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(status).toEqual(want);
    expect(readdirSync(parent).filter((n) => n.startsWith(`.migrate-`))).toEqual([]);
    expect(existsSync(newPaths(id).setupFile)).toBe(true);
  });

  it("a never-moved setup with a revision file cut short refuses as damaged, naming the file and the recovery", async () => {
    const id = idOf(await handleSetupReviewGate(io(), {}));
    await handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: id });
    const rev = readdirSync(newPaths(id).revisions)[0]!;
    writeFileSync(join(newPaths(id).revisions, rev), "cut sh");
    const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(r.exitCode).toBe(6);
    expect(r.stdout).toContain(`the setup record at ${newPaths(id).dir} is damaged (revision ${rev} does not match its hash)`);
    expect(r.stdout).toContain(`move ${newPaths(id).dir} aside, then run storybloq setup-review gate without --setup from a terminal outside the agent and keep the new setup id`);
    expect(existsSync(join(newPaths(id).revisions, rev))).toBe(true);
  });

  it("a never-moved setup whose record names a revision that was deleted refuses as damaged", async () => {
    const id = idOf(await handleSetupReviewGate(io(), {}));
    await handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: id });
    const rev = readdirSync(newPaths(id).revisions)[0]!;
    rmSync(join(newPaths(id).revisions, rev));
    const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(r.exitCode).toBe(6);
    expect(r.stdout).toMatch(new RegExp(`is damaged \\(revision ${rev}, which record SR-[0-9a-f]+ names, is missing\\)`));
  });

  it("a never-moved setup whose revisions folder was deleted refuses as damaged", async () => {
    const id = idOf(await handleSetupReviewGate(io(), {}));
    await handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: id });
    rmSync(newPaths(id).revisions, { recursive: true });
    const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(r.exitCode).toBe(6);
    expect(r.stdout).toMatch(/is damaged \(revision [0-9a-f]{64}\.md, which record SR-[0-9a-f]+ names, is missing\)/);
  });

  it("a moved copy whose revisions folder was deleted is refused as incomplete, and the old copy is unchanged", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    await handleSetupReviewRun(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    expect((await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id })).exitCode).toBe(0);
    const before = tree(oldPaths(id).dir);
    rmSync(newPaths(id).revisions, { recursive: true });
    const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(r.exitCode).toBe(6);
    expect(r.stdout).toMatch(/is an incomplete copy of the setup \(revision [0-9a-f]{64}\.md, which record SR-[0-9a-f]+ names, is missing\)/);
    expect(tree(oldPaths(id).dir)).toEqual(before);
  });

  it("an old setup whose record names a deleted revision is not moved", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    await handleSetupReviewRun(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    rmSync(oldPaths(id).revisions, { recursive: true });
    const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    expect(r.stdout).toMatch(new RegExp(`the setup at ${oldPaths(id).dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} cannot be moved: revision [0-9a-f]{64}\\.md, which record SR-[0-9a-f]+ names, is missing`));
    expect(existsSync(newPaths(id).dir)).toBe(false);
  });

  it("a plain status whose store check fails with EIO is exit 6, over a setup in place and over a legacy-only setup, with no placement write", async () => {
    const here = idOf(await handleSetupReviewGate(io(), {}));
    await handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: here });
    const old = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    const hereBefore = tree(newPaths(here).dir);
    const oldBefore = tree(oldPaths(old).dir);
    storeSeams.writeProbe = () => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    };
    for (const id of [here, old]) {
      const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
      expect(r.exitCode).toBe(6);
      expect(r.stdout).toContain("the review store is not writable: EIO: i/o error");
    }
    expect(tree(newPaths(here).dir)).toEqual(hereBefore);
    expect(existsSync(newPaths(old).dir)).toBe(false);
    expect(existsSync(publicationLockPath(newPaths(old)))).toBe(false);
    expect(tree(oldPaths(old).dir)).toEqual(oldBefore);
  });

  it.skipIf(process.getuid?.() === 0)("an existing setup whose whole store tree denies writes: a plain status reads and reports it, and writes nothing (no lock, no revision)", async () => {
    const id = idOf(await handleSetupReviewGate(io(), {}));
    await handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: id });
    const want = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
    const root = storeRoot({ HOME: home });
    const before = tree(root);
    // Every folder read-only and every file read-only, from the store root down, not only a failing probe.
    const all = [root, ...(readdirSync(root, { recursive: true }) as string[]).map((n) => join(root, n))];
    const dirs = all.filter((p) => statSync(p).isDirectory());
    const files = all.filter((p) => !dirs.includes(p));
    for (const f of files) chmodSync(f, 0o400);
    for (const d of dirs) chmodSync(d, 0o500);
    try {
      const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
      expect(r).toEqual(want);
    } finally {
      for (const d of dirs) chmodSync(d, 0o700);
      for (const f of files) chmodSync(f, 0o600);
    }
    expect(tree(root)).toEqual(before);
    expect(existsSync(publicationLockPath(newPaths(id)))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("a legacy-only setup with a destination that denies every write: status exit 3, no lock, no revision, nothing moved", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    await handleSetupReviewRun(io({ legacy: true, stdin: REVIEW_PACKET }), { setup: id });
    const before = tree(oldPaths(id).dir);
    const root = storeRoot({ HOME: home });
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o500);
    try {
      const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET.replace("one-hour", "three-hour") }), { setup: id });
      expect(r.exitCode).toBe(3);
      expect(r.stdout).toMatch(/review store: cannot be written from here \((EACCES|EPERM)\)/);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      chmodSync(root, 0o700);
    }
    expect(tree(oldPaths(id).dir)).toEqual(before);
  });

  it("with the override set, the old store is never looked at", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    const other = makeScratchDir("sr-mig-other-");
    expect(await placeSetup(setupPaths({ STORYBLOQ_SETUP_REVIEW_DIR: other }, project, id), { STORYBLOQ_SETUP_REVIEW_DIR: other }, false)).toEqual({ kind: "absent" });
  });
  describe("a setup folder whose setup.json is not there to judge, or is there but wrong, with no old copy", () => {
    async function damaged(change: (file: string) => void) {
      const id = idOf(await handleSetupReviewGate(io(), {}));
      await handleSetupReviewRun(io({ stdin: REVIEW_PACKET }), { setup: id });
      change(newPaths(id).setupFile);
      const before = tree(newPaths(id).dir);
      const calls = fake.invocations().length;
      const status = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET.replace("one-hour", "four-hour") }), { setup: id });
      const run = await handleSetupReviewRun(io({ stdin: REVIEW_PACKET.replace("one-hour", "four-hour") }), { setup: id });
      expect(fake.invocations().length).toBe(calls);
      expect(tree(newPaths(id).dir)).toEqual(before);
      return { id, status, run };
    }
    const RECOVERY = "then run storybloq setup-review gate without --setup from a terminal outside the agent and keep the new setup id";

    it("missing: exit 6, damaged, with the recovery", async () => {
      const { id, status, run } = await damaged((f) => rmSync(f));
      for (const r of [status, run]) {
        expect(r.exitCode).toBe(6);
        expect(r.stdout).toContain(`the setup record at ${newPaths(id).dir} is damaged (its setup.json is missing)`);
        expect(r.stdout).toContain(RECOVERY);
      }
    });

    it.skipIf(process.getuid?.() === 0)("unreadable: exit 6, naming the errno, with the recovery", async () => {
      let file = "";
      try {
        const { id, status, run } = await damaged((f) => {
          file = f;
          chmodSync(f, 0o000);
        });
        for (const r of [status, run]) {
          expect(r.exitCode).toBe(6);
          expect(r.stdout).toContain(`the setup record at ${newPaths(id).dir} is damaged (its setup.json cannot be read (EACCES))`);
          expect(r.stdout).toContain(RECOVERY);
        }
      } finally {
        if (file) chmodSync(file, 0o600);
      }
    });

    // T-536's readSetup answers a record that does not parse with its "No such setup" text and a
    // record that parses but is wrong with its "damaged" text; both stay exit 2 and keep T-536's words.
    const NO_SUCH = "No such setup. Run storybloq setup-review gate first and keep its setup id.";
    const DAMAGED = "The setup record is damaged. Run storybloq setup-review gate to open a new setup.";
    for (const [name, write, message] of [
      ["unparseable", (f: string) => writeFileSync(f, "{ not json"), NO_SUCH],
      ["the wrong shape", (f: string) => writeFileSync(f, JSON.stringify({ cycle: "one" })), DAMAGED],
      ["naming another setup", (f: string) => writeFileSync(f, readFileSync(f, "utf-8").replace(/"setupId": "SS-[0-9a-f]{8}"/, '"setupId": "SS-00000000"')), DAMAGED],
    ] as const) {
      it(`${name}: T-536's answer, exit 2`, async () => {
        const { status, run } = await damaged(write);
        for (const r of [status, run]) {
          expect(r.exitCode).toBe(2);
          expect(r.stdout).toContain(message);
        }
      });
    }

    it("an empty folder is still an unknown setup, exit 2", async () => {
      const id = "SS-0badf00d";
      mkdirSync(newPaths(id).dir, { recursive: true });
      const r = await handleSetupReviewStatus(io({ stdin: REVIEW_PACKET }), { setup: id });
      expect(r.exitCode).toBe(2);
      expect(readdirSync(newPaths(id).dir)).toEqual([]);
    });
  });

});
