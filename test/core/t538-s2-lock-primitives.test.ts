/**
 * T-538 S2 commit 3 (plan v5 1a): one lock owner per operation. A locked
 * handler that calls another locked handler on the same project fails at
 * once with `nested_lock` instead of waiting out the deadline against
 * itself, and the setup engine gets unlocked primitives that return the
 * write instead of making it, so one transaction can carry several.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import {
  loadProject,
  prepareConfigWrite,
  prepareNoteWrite,
  prepareRoadmapWrite,
  runTransactionUnlocked,
  ticketFilePath,
  withProjectLock,
  writeConfigUnlocked,
  writeNoteUnlocked,
  writeRoadmapUnlocked,
} from "../../src/core/project-loader.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { handleNoteCreate } from "../../src/cli/commands/note.js";
import { enableCheckpoints, enableCheckpointsStampUnlocked } from "../../src/core/checkpoint-enable.js";
import { buildCheckpointTicketUnlocked } from "../../src/core/checkpoint-lifecycle.js";
import { CHECKPOINT_SCHEMA_VERSION, IMMUTABLE_EVIDENCE_SCHEMA_VERSION } from "../../src/core/errors.js";
import type { Note } from "../../src/models/note.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-s2-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t538-s2-"));
  dirs.push(dir);
  await initProject(dir, { name: "t538" });
  return dir;
}

const note = (id: string): Note => ({ id, title: null, content: `note ${id}`, tags: [], status: "active", createdDate: "2026-10-18", updatedDate: "2026-10-18" });

describe("nested locks", () => {
  it("a locked handler taking the same project's lock again fails at once with nested_lock", async () => {
    const dir = await project();
    const started = Date.now();
    let caught: unknown;
    await withProjectLock(dir, { strict: true }, async () => {
      caught = await withProjectLock(dir, { strict: true }, async () => {}).catch((e: unknown) => e);
    });
    expect(caught).toBeInstanceOf(ProjectLoaderError);
    expect((caught as ProjectLoaderError).code).toBe("nested_lock");
    expect((caught as Error).message).toMatch(/unlocked primitive/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a nested acquire through a symlink alias of the root fails at once with nested_lock (S2a finding 5)", async () => {
    const dir = await project();
    const aliasParent = await mkdtemp(join(tmpdir(), "t538-s2-alias-"));
    dirs.push(aliasParent);
    const alias = join(aliasParent, "link");
    await symlink(dir, alias);
    const started = Date.now();
    let caught: unknown;
    await withProjectLock(dir, { strict: true }, async () => {
      caught = await withProjectLock(alias, { strict: true }, async () => {}).catch((e: unknown) => e);
    });
    expect((caught as ProjectLoaderError).code).toBe("nested_lock");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a public handler called while holding the lock is caught and writes nothing", async () => {
    const dir = await project();
    let caught: unknown;
    await withProjectLock(dir, { strict: true }, async () => {
      caught = await handleNoteCreate({ content: "inside" }, "json", dir).catch((e: unknown) => e);
    });
    expect((caught as ProjectLoaderError).code).toBe("nested_lock");
    expect((await loadProject(dir)).state.notes).toHaveLength(0);
  });

  it("another project's lock inside this one is still allowed", async () => {
    const a = await project();
    const b = await project();
    await withProjectLock(a, { strict: true }, async () => {
      await handleNoteCreate({ content: "in b" }, "json", b);
    });
    expect((await loadProject(b)).state.notes).toHaveLength(1);
  });

  it("work started inside a lock that runs after it is released takes the lock normally", async () => {
    const dir = await project();
    let later!: Promise<void>;
    await withProjectLock(dir, { strict: true }, async () => {
      later = (async () => {
        await new Promise((r) => setTimeout(r, 50));
        await withProjectLock(dir, { strict: true }, async () => {});
      })();
    });
    await expect(later).resolves.toBeUndefined();
  });
});

describe("unlocked primitives", () => {
  it("prepareNoteWrite, prepareRoadmapWrite and prepareConfigWrite return exactly what the unlocked writers write", async () => {
    const dir = await project();
    await withProjectLock(dir, { strict: true }, async ({ state }) => {
      const n = await prepareNoteWrite(note("N-001"), dir);
      await writeNoteUnlocked(note("N-001"), dir);
      expect(n.target).toBe(join(dir, ".story", "notes", "N-001.json"));
      expect(await readFile(n.target, "utf-8")).toBe(n.content);

      const roadmap = { ...state.roadmap, title: "renamed" };
      const r = await prepareRoadmapWrite(roadmap, dir);
      await writeRoadmapUnlocked(roadmap, dir);
      expect(await readFile(r.target, "utf-8")).toBe(r.content);

      const config = { ...state.config, name: "renamed" };
      const c = await prepareConfigWrite(config, dir);
      await writeConfigUnlocked(config, dir);
      expect(await readFile(c.target, "utf-8")).toBe(c.content);
    });
  });

  it("the prepared writes commit together in one transaction", async () => {
    const dir = await project();
    await withProjectLock(dir, { strict: true }, async ({ state }) => {
      const ops = [
        await prepareNoteWrite(note("N-001"), dir),
        await prepareRoadmapWrite({ ...state.roadmap, title: "together" }, dir),
        await prepareConfigWrite({ ...state.config, name: "together" }, dir),
      ];
      await runTransactionUnlocked(dir, ops.map((o) => ({ op: "write" as const, ...o })));
    });
    const { state } = await loadProject(dir);
    expect(state.notes.map((n) => n.id)).toEqual(["N-001"]);
    expect(state.roadmap.title).toBe("together");
    expect(state.config.name).toBe("together");
  });

  it("a prepare primitive writes nothing", async () => {
    const dir = await project();
    await withProjectLock(dir, { strict: true }, async () => {
      const n = await prepareNoteWrite(note("N-007"), dir);
      expect(existsSync(n.target)).toBe(false);
    });
  });

  it("enableCheckpointsStampUnlocked stamps what the public non-team enable writes, and is already done after it", async () => {
    const dir = await project();
    const before = (await loadProject(dir)).state.config;
    const stamp = enableCheckpointsStampUnlocked(before, CHECKPOINT_SCHEMA_VERSION);
    expect(stamp.status).toBe("stamp");
    await enableCheckpoints(dir);
    const after = (await loadProject(dir)).state.config;
    const { checkpointEnable: a, ...restAfter } = after as typeof after & { checkpointEnable?: { step: string } };
    const { checkpointEnable: s, ...restStamp } = (stamp as { config: typeof before & { checkpointEnable?: { step: string } } }).config;
    expect(restAfter).toEqual(restStamp);
    expect(a?.step).toBe("complete");
    expect(s?.step).toBe("complete");
    expect(enableCheckpointsStampUnlocked(after, CHECKPOINT_SCHEMA_VERSION)).toEqual({ status: "already" });
    const five = enableCheckpointsStampUnlocked(after, IMMUTABLE_EVIDENCE_SCHEMA_VERSION);
    expect(five.status === "stamp" && five.config.schemaVersion).toBe(IMMUTABLE_EVIDENCE_SCHEMA_VERSION);
  });

  it("buildCheckpointTicketUnlocked builds the checkpoint ticket under the held lock and writes nothing", async () => {
    const dir = await project();
    const args = { title: "Accept sign in", description: "", phase: null, owner: "owner", content: { kind: "acceptance" as const, criteria: "works", evidenceRefs: [] } };
    await withProjectLock(dir, { strict: true }, async ({ state }) => {
      await expect(buildCheckpointTicketUnlocked(state, dir, args, "me")).rejects.toThrow(/checkpoint/i);
    });
    await enableCheckpoints(dir);
    await withProjectLock(dir, { strict: true }, async ({ state }) => {
      const ticket = await buildCheckpointTicketUnlocked(state, dir, args, "me");
      expect((ticket as { ownerCheckpoint?: { kind: string } }).ownerCheckpoint?.kind).toBe("acceptance");
      expect(ticket.title).toBe("Accept sign in");
      expect(existsSync(ticketFilePath(dir, ticket.id))).toBe(false);
    });
  });
});
