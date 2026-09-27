/**
 * T-537 S2: resolve-with-ruling is ONE transaction, and the journal is its
 * only recovery authority. A failure before the commit starts leaves neither
 * write; a failure between the two renames is finished forward at the next
 * lock, never rolled back; recovering twice changes nothing; the approval's
 * rulingId always names a ruling on disk. RED at 09e7dade:
 * core/checkpoint-lifecycle.ts does not exist there.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const faults = vi.hoisted(() => ({ openFail: null as RegExp | null, renameFail: null as RegExp | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (what: string) => {
    const err = new Error(`T-537 simulated ${what} failure`) as NodeJS.ErrnoException;
    err.code = "EIO";
    return err;
  };
  const open = (async (...args: unknown[]) => {
    if (faults.openFail && typeof args[0] === "string" && faults.openFail.test(args[0])) {
      faults.openFail = null;
      throw fail("open");
    }
    return (actual.open as (...a: unknown[]) => Promise<unknown>)(...args);
  }) as typeof actual.open;
  const rename = (async (from: unknown, to: unknown) => {
    if (faults.renameFail && typeof from === "string" && faults.renameFail.test(from)) {
      faults.renameFail = null;
      throw fail("rename");
    }
    return actual.rename(from as string, to as string);
  }) as typeof actual.rename;
  return { ...actual, open, rename };
});

import { mkdtemp, rm, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../src/core/errors.js";
import { loadProject } from "../../src/core/project-loader.js";
import { createCheckpoint, resolveCheckpoint } from "../../src/core/checkpoint-lifecycle.js";
import { checkpointApproved, parseOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import type { Ticket } from "../../src/models/ticket.js";

const ACTOR = "owner@example.test";
const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t537-home-"));
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
  faults.openFail = null;
  faults.renameFail = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const RULING = { text: "Onboarding ships", attribution: "owner-direct", date: "2026-09-27", scopeTags: ["onboarding"], clientTaskId: "t537-test" };

async function setup(): Promise<{ dir: string; id: string; expected: { generation: number; revision: number; digest: string }; before: string }> {
  const dir = await mkdtemp(join(tmpdir(), "t537-txn-"));
  dirs.push(dir);
  await initProject(dir, { name: "t537" });
  const configPath = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const t = await createCheckpoint(dir, { title: "Decision", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Ship?", evidenceRefs: [] }, actor: ACTOR });
  const p = parseOwnerCheckpoint(t);
  if (p.kind !== "ok") throw new Error("setup");
  const before = await readFile(join(dir, ".story", "tickets", `${t.id}.json`), "utf-8");
  return { dir, id: t.id, expected: { generation: p.checkpoint.generation, revision: p.checkpoint.revision, digest: p.checkpoint.digest }, before };
}

async function rulings(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, ".story", "rulings"))).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function journalExists(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".story", ".txn.json"));
    return true;
  } catch {
    return false;
  }
}

async function onDisk(dir: string, id: string): Promise<Ticket> {
  return JSON.parse(await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8")) as Ticket;
}

describe("resolve with a ruling: one transaction", () => {
  it("a failure before the commit starts rolls back: no ruling, no approval, no journal", async () => {
    const { dir, id, expected, before } = await setup();
    faults.openFail = new RegExp(`tickets/${id}\\.json\\.\\d+\\.tmp$`);
    await expect(resolveCheckpoint(dir, id, expected, { response: "yes", actor: ACTOR, ruling: RULING })).rejects.toThrow(/simulated open failure|Transaction failed/);
    expect(await rulings(dir)).toEqual([]);
    expect(await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8")).toBe(before);
    expect(await journalExists(dir)).toBe(false);
  });

  it("a failure between the two renames is finished forward, and recovering again changes nothing", async () => {
    const { dir, id, expected } = await setup();
    faults.renameFail = new RegExp(`tickets/${id}\\.json\\.\\d+\\.tmp$`);
    await expect(resolveCheckpoint(dir, id, expected, { response: "yes", actor: ACTOR, ruling: RULING })).rejects.toThrow(/Do NOT retry/);
    // The ruling renamed first; the checkpoint did not; the journal stays for recovery.
    const landed = await rulings(dir);
    expect(landed).toHaveLength(1);
    expect(checkpointApproved(await onDisk(dir, id))).toBe(false);
    expect(await journalExists(dir)).toBe(true);

    await loadProject(dir);
    const recovered = await onDisk(dir, id);
    expect(checkpointApproved(recovered)).toBe(true);
    const p = parseOwnerCheckpoint(recovered);
    if (p.kind !== "ok") throw new Error("unreadable after recovery");
    expect(`${p.checkpoint.resolution!.rulingId}.json`).toBe(landed[0]);
    expect(await journalExists(dir)).toBe(false);

    const snapshot = await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8");
    await loadProject(dir);
    expect(await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8")).toBe(snapshot);
    expect(await rulings(dir)).toEqual(landed);
  });

  it("on success the approval names the ruling that landed with it", async () => {
    const { dir, id, expected } = await setup();
    const out = await resolveCheckpoint(dir, id, expected, { response: "yes", actor: ACTOR, ruling: RULING });
    expect(await rulings(dir)).toEqual([`${out.rulingId}.json`]);
    const p = parseOwnerCheckpoint(await onDisk(dir, id));
    expect(p.kind === "ok" && p.checkpoint.resolution!.rulingId).toBe(out.rulingId);
  });
});
