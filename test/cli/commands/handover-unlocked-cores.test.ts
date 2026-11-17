/**
 * T-575 commit 1 (plan section 3): the three pure refactors. The unlocked
 * create core with its per-candidate `beforeWrite` hook, the unlocked
 * continue core with typed refusals, and `spawnWorker` split into
 * `prepareWorkerArtifacts` and `launchWorker`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../../../src/core/init.js";
import { digestBytes, memoFileName, readLineMemo } from "../../../src/core/handover-line-memo.js";
import { appendLineage, serializeLineage, type LineageInput } from "../../../src/core/handover-lineage.js";
import { continueLineUnlocked, createHandoverUnlocked } from "../../../src/cli/commands/handover.js";
import { withProjectLock } from "../../../src/core/project-loader.js";
import {
  launchWorker, mintWorkerTaskId, prepareSpawnDir, prepareWorkerArtifacts, resolveWorkerDir, writeSpawnJournal,
  type SpawnStage,
} from "../../../src/core/duet-spawn.js";
import { isolateEnv, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

// The team filename generator, scripted: while `forced` holds names, each call
// takes the next one; otherwise the real generator runs.
const forced: { names: string[] } = { names: [] };
vi.mock("../../../src/core/handover-filename.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../../src/core/handover-filename.js")>();
  return { ...m, generateTeamHandoverFilename: (slug: string) => forced.names.shift() ?? m.generateTeamHandoverFilename(slug) };
});

const TASK = "task-cores.1";
let env: IsolatedEnv;
beforeEach(() => { env = isolateEnv(); forced.names = []; });
afterEach(() => { env.restore(); rmSync(env.base, { recursive: true, force: true }); });

const body = (id: string): string => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n`;
const linked = (id: string, attrs: LineageInput): string => appendLineage(body(id), serializeLineage(attrs).line);

interface Proj { root: string; hdir: string; memo: string }
async function project(files: Record<string, string> = {}, team = false): Promise<Proj> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "cores" });
  if (team) {
    const cfgPath = join(root, ".story", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.team = { enabled: true };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  }
  const hdir = join(root, ".story", "handovers");
  mkdirSync(hdir, { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(hdir, n), c);
  return { root, hdir, memo: join(root, ".story", "telemetry", "handover-lines", memoFileName(TASK)) };
}
const locked = <T>(root: string, fn: () => Promise<T>): Promise<T> => {
  let out: T;
  return withProjectLock(root, { strict: false }, async () => { out = await fn(); }).then(() => out!);
};
const NEW_LINE = { content: body("open"), slug: "opened", lineage: { newLine: true, role: "worker", as: TASK } } as const;

describe("T-575 refactor 1: createHandoverUnlocked and its beforeWrite hook", () => {
  it("calls the hook once with the allocated name and the digest of the exact final bytes, before the memo intent and the file exist", async () => {
    const p = await project();
    const seen: Array<{ file: string; sha256: string; fileExisted: boolean; memoExisted: boolean }> = [];
    const r = await locked(p.root, () => createHandoverUnlocked(p.root, NEW_LINE, {
      beforeWrite: (planned) => seen.push({ ...planned, fileExisted: existsSync(join(p.hdir, planned.file)), memoExisted: existsSync(p.memo) }),
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.file).toBe(r.filename);
    expect(seen[0]!.fileExisted).toBe(false);
    expect(seen[0]!.memoExisted).toBe(false);
    expect(seen[0]!.sha256).toBe(digestBytes(readFileSync(join(p.hdir, r.filename))));
    expect(r.lineage?.linked).toBe(true);
    expect(readLineMemo(p.root, TASK)).toMatchObject({ tip: r.filename, writing: null });
  });

  it("a throwing hook writes nothing (no memo intent, no file), is not retried, and its error is rethrown", async () => {
    for (const team of [false, true]) {
      const p = await project({}, team);
      const before = readdirSync(p.hdir);
      let calls = 0;
      // An EEXIST-coded throw must not be mistaken for a lost race in team mode.
      const boom = Object.assign(new Error("intent not persisted"), { code: "EEXIST" });
      await expect(locked(p.root, () => createHandoverUnlocked(p.root, NEW_LINE, { beforeWrite: () => { calls++; throw boom; } }))).rejects.toBe(boom);
      expect(calls).toBe(1);
      expect(readdirSync(p.hdir)).toEqual(before);
      expect(existsSync(p.memo)).toBe(false);
    }
  });

  it("team mode: a first candidate lost to EEXIST was not written, the hook runs again for the next candidate, one file", async () => {
    const taken = "2026-11-17-010101-aaaaaaaa-opened.md";
    const fresh = "2026-11-17-010101-bbbbbbbb-opened.md";
    const p = await project({ [taken]: body("someone-else") }, true);
    forced.names = [taken, fresh];
    const seen: Array<{ file: string; sha256: string }> = [];
    const r = await locked(p.root, () => createHandoverUnlocked(p.root, NEW_LINE, { beforeWrite: (planned) => seen.push(planned) }));
    expect(seen.map((s) => s.file)).toEqual([taken, fresh]);
    expect(r.filename).toBe(fresh);
    expect(readFileSync(join(p.hdir, taken), "utf8")).toBe(body("someone-else"));
    expect(seen[1]!.sha256).toBe(digestBytes(readFileSync(join(p.hdir, fresh))));
    expect(readdirSync(p.hdir).filter((n) => n.endsWith(".md")).sort()).toEqual([taken, fresh]);
  });

  it("with no hook the core writes what a create writes: one file, the memo on it", async () => {
    const p = await project();
    const r = await locked(p.root, () => createHandoverUnlocked(p.root, NEW_LINE));
    expect(readdirSync(p.hdir).filter((n) => n.endsWith(".md"))).toEqual([r.filename]);
    expect(readLineMemo(p.root, TASK)).toMatchObject({ tip: r.filename, writing: null });
  });
});

describe("T-575 refactor 2: continueLineUnlocked returns typed refusals and writes nothing on one", () => {
  const A = "2026-11-10-01-a.md";
  const B = "2026-11-10-02-b.md";
  const U = "2026-11-11-01-u.md";
  async function chain(): Promise<Proj> {
    return project({
      [A]: linked("A", { role: "pen" }),
      [B]: linked("B", { continues: A }),
      [U]: body("U"),
    });
  }

  it("not_found, invalid_input and not_a_tip (with the descendant tips) come back as values; no memo is written", async () => {
    const p = await chain();
    const nf = await locked(p.root, () => continueLineUnlocked(p.root, TASK, "2026-11-12-01-z.md"));
    expect(nf).toMatchObject({ ok: false, refusal: { code: "not_found" } });
    const bad = await locked(p.root, () => continueLineUnlocked(p.root, TASK, "../x.md"));
    expect(bad).toMatchObject({ ok: false, refusal: { code: "invalid_input" } });
    const nt = await locked(p.root, () => continueLineUnlocked(p.root, TASK, A));
    expect(nt).toMatchObject({ ok: false, refusal: { code: "not_a_tip", tips: [B] } });
    expect(existsSync(p.memo)).toBe(false);
  });

  it("a tip writes the memo and returns the reply data; the default head removes it (rule 6)", async () => {
    const p = await chain();
    const ok = await locked(p.root, () => continueLineUnlocked(p.root, TASK, B));
    expect(ok).toMatchObject({ ok: true, result: { action: "continue", tip: B } });
    expect(readLineMemo(p.root, TASK)).toMatchObject({ tip: B, writing: null });
    const head = await locked(p.root, () => continueLineUnlocked(p.root, TASK, U));
    expect(head).toMatchObject({ ok: true, result: { action: "default", memo: "removed" } });
    expect(existsSync(p.memo)).toBe(false);
  });
});

describe("T-575 refactor 3: spawnWorker split into prepareWorkerArtifacts and launchWorker", () => {
  function spawnProject(): string {
    const root = realpathSync(mkdtempSync(join(env.base, "spawn-")));
    mkdirSync(join(root, ".story"), { recursive: true });
    writeFileSync(join(root, ".story", "config.json"), "{}\n");
    return root;
  }

  it("prepare stops at artifacts without calling the launcher; launch journals the rest and calls it once", () => {
    const root = spawnProject();
    const name = "w-split";
    const spawnDir = prepareSpawnDir(root, name);
    const journalPath = join(spawnDir, `${name}.json`);
    const stages: SpawnStage[] = [];
    const journal = (stage: SpawnStage, extra: Record<string, unknown> = {}) => { stages.push(stage); writeSpawnJournal(journalPath, { stage, ...extra }); };
    const w = resolveWorkerDir(root, undefined);
    let launched = 0;
    const prepared = prepareWorkerArtifacts(root, {
      name, pen: "p1", spawnDir, journal, workerTaskId: mintWorkerTaskId(), penProjectRoot: root, workerDir: w.workerDir, workerProjectRoot: w.workerProjectRoot,
    }, () => null);
    expect(stages).toEqual(["artifacts"]);
    expect(existsSync(prepared.scriptPath)).toBe(true);
    expect(existsSync(prepared.rolePath)).toBe(true);
    const r = launchWorker(prepared, () => { launched++; return "fake-open"; });
    expect(launched).toBe(1);
    expect(stages).toEqual(["artifacts", "launch-attempted", "launched"]);
    expect(r).toMatchObject({ launch: "opened", scriptPath: prepared.scriptPath, rolePath: prepared.rolePath });
  });
});
