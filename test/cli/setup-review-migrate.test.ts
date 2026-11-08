/**
 * ISS-1457: setups move from the old temporary store to the user's state
 * folder, data only and validated, the first time they are used; a setup in
 * flight or one that does not validate is refused and nothing is copied; a
 * move and a creation of the same id never interleave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleSetupReviewGate, handleSetupReviewRun, handleSetupReviewStatus, type SetupReviewIo, type SetupReviewResult } from "../../src/cli/commands/setup-review.js";
import { setupPaths, storeRoot, storeRootSeams } from "../../src/core/setup-review.js";
import { legacyStoreRoot, migrateSeams, placeSetup, publicationLockPath } from "../../src/core/setup-review-migrate.js";
import { acquireProjectLockAsync, releaseProjectLock } from "../../src/core/project-lock.js";
import { makeFakeBin, makeScratchDir, removeScratchDirs, REVIEW_PACKET, type FakeBin } from "../helpers/setup-review-fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const FAST = { attemptMs: 1_500, totalMs: 4_000, killGraceMs: 200 };
const realPlatform = storeRootSeams.platform;
const realBefore = migrateSeams.beforePublish;

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

  it("with the override set, the old store is never looked at", async () => {
    const id = idOf(await handleSetupReviewGate(io({ legacy: true }), {}));
    const other = makeScratchDir("sr-mig-other-");
    expect(await placeSetup(setupPaths({ STORYBLOQ_SETUP_REVIEW_DIR: other }, project, id), { STORYBLOQ_SETUP_REVIEW_DIR: other }, false)).toEqual({ kind: "absent" });
  });
});
