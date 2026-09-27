/**
 * T-537 S4: `storybloq resolve` on a checkpoint in conflict. The branches are
 * real lifecycle writes merged by the real driver, so the conflict is the one
 * git would leave. Resolution checks consistency, never "must be approved":
 * a selected approval is displaced back to pending at a new generation, a
 * selected retirement stands with a `retirement-adopted` event, and the side
 * not taken is kept in history as `discarded`. RED at 09e7dade: neither
 * checkpoint-lifecycle nor the conflict branch exists there.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../src/core/errors.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { createCheckpoint, resolveCheckpoint, retireCheckpoint, type ExpectedCheckpoint } from "../../src/core/checkpoint-lifecycle.js";
import { checkpointApproved, checkpointReleases, parseOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import { handleResolve } from "../../src/cli/commands/conflicts.js";

const ACTOR = "owner@example.test";
const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t537-cr-home-"));
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

type Json = Record<string, unknown>;

function expectedOf(t: object): ExpectedCheckpoint {
  const p = parseOwnerCheckpoint(t);
  if (p.kind !== "ok") throw new Error("not a readable checkpoint");
  return { generation: p.checkpoint.generation, revision: p.checkpoint.revision, digest: p.checkpoint.digest };
}

/**
 * One checkpoint and three versions of its file: `base`, then `approved` and
 * `retired`, each written by the lifecycle from `base` as two branches would.
 * The ticket file on disk is left as the driver's merge of `ours` and `theirs`.
 */
async function conflicted(ours: "approved" | "retired", theirs: "approved" | "retired", opts: { evidence?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "t537-cr-"));
  dirs.push(dir);
  await initProject(dir, { name: "t537" });
  const configPath = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const t = await createCheckpoint(dir, { title: "Decision", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Ship?", evidenceRefs: [] }, actor: ACTOR });
  const path = join(dir, ".story", "tickets", `${t.id}.json`);
  const read = async (): Promise<Json> => JSON.parse(await readFile(path, "utf-8")) as Json;
  const base = await read();
  await resolveCheckpoint(dir, t.id, expectedOf(base), { response: "yes", actor: ACTOR });
  const approved = await read();
  await writeFile(path, JSON.stringify(base, null, 2) + "\n");
  await retireCheckpoint(dir, t.id, expectedOf(base), "dropped", ACTOR);
  const retired = await read();
  if (opts.evidence) {
    // A checkpoint attached to a reopened dependent: evidence it already
    // carried, changed differently on each branch.
    const other = await createCheckpoint(dir, { title: "Upstream", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Upstream?", evidenceRefs: [] }, actor: ACTOR });
    const up = expectedOf(other);
    const entry = (state: "approved" | "retired", generation: number) => [{ checkpoint: other.id, generation, revision: up.revision, digest: up.digest, state }];
    base.checkpointEvidence = entry("approved", 1);
    approved.checkpointEvidence = entry("approved", 2);
    retired.checkpointEvidence = entry("retired", 3);
  }
  const sides = { approved, retired };
  const merged = threeWayMerge(base, sides[ours], sides[theirs], "ticket");
  expect(merged.clean).toBe(false);
  await writeFile(path, JSON.stringify(merged.merged, null, 2) + "\n");
  return { dir, id: t.id, read, base, sides };
}

const history = (t: Json) => ((t.ownerCheckpoint as Json).history as Json[]);
const generation = (t: Json) => (t.ownerCheckpoint as Json).generation as number;

/** A retired checkpoint that ours deleted and theirs retired: a delete-edit conflict, left as the driver merged it. */
async function deleteEditConflict() {
  const dir = await mkdtemp(join(tmpdir(), "t537-cr-"));
  dirs.push(dir);
  await initProject(dir, { name: "t537" });
  const configPath = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const cp = await createCheckpoint(dir, { title: "Decision", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Ship?", evidenceRefs: [] }, actor: ACTOR });
  const path = join(dir, ".story", "tickets", `${cp.id}.json`);
  const read = async (): Promise<Json> => JSON.parse(await readFile(path, "utf-8")) as Json;
  const base = await read();
  await retireCheckpoint(dir, cp.id, expectedOf(base), "dropped", ACTOR);
  const retired = await read();
  const other = await createCheckpoint(dir, { title: "Upstream", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Upstream?", evidenceRefs: [] }, actor: ACTOR });
  const up = expectedOf(other);
  const entry = (generation: number) => [{ checkpoint: other.id, generation, revision: up.revision, digest: up.digest, state: "approved" }];
  base.checkpointEvidence = entry(1);
  retired.checkpointEvidence = entry(2);
  // Ours deleted the ticket; theirs retired it: a delete-edit conflict.
  const deleted = { ...base, lifecycle: "deleted", deletedAt: "2026-09-27T00:00:00.000Z", deletedBy: ACTOR };
  const merged = threeWayMerge(base, deleted, retired, "ticket");
  expect(merged.clean).toBe(false);
  await writeFile(path, JSON.stringify(merged.merged, null, 2) + "\n");
  const rawText = () => readFile(path, "utf-8");
  return { dir, cp, read, rawText, retired, entry };
}

describe("resolving a checkpoint in conflict", () => {
  it("taking the approved side displaces the approval: pending again, at a new generation, the retirement discarded", async () => {
    const { dir, id, read, sides } = await conflicted("approved", "retired");
    await handleResolve(id, dir, { use: "ours", actor: ACTOR, format: "json" });
    const t = await read();
    expect(t._conflicts ?? []).toEqual([]);
    expect(t.status).toBe("open");
    expect(t.completedDate).toBeNull();
    expect(checkpointApproved(t)).toBe(false);
    expect(checkpointReleases(t)).toBe(false);
    expect((t.ownerCheckpoint as Json).resolution).toBeUndefined();
    expect(generation(t)).toBeGreaterThan(Math.max(generation(sides.approved), generation(sides.retired)));
    const settled = history(t).at(-1)!;
    expect(settled.event).toBe("conflict-resolved");
    expect(settled.generation).toBe(generation(t));
    // The displaced answer is kept on the settling event.
    expect(settled.resolution).toEqual((sides.approved.ownerCheckpoint as Json).resolution);
    expect(settled.discarded).toBeDefined();
    expect(JSON.stringify(settled.discarded)).toContain("retired");
  });

  it("taking the retired side keeps the retirement and adopts it at the new generation", async () => {
    const { dir, id, read, sides } = await conflicted("approved", "retired");
    await handleResolve(id, dir, { use: "theirs", actor: ACTOR, format: "json" });
    const t = await read();
    expect((t.ownerCheckpoint as Json).lifecycle).toBe("retired");
    expect(checkpointReleases(t)).toBe(true);
    expect(t.status).toBe("open");
    const events = history(t).slice(-2).map((e) => e.event);
    expect(events).toEqual(["conflict-resolved", "retirement-adopted"]);
    expect(history(t).at(-1)!.generation).toBe(generation(t));
    // The original retirement keeps its own generation.
    const original = history(t).find((e) => e.event === "retired")!;
    expect(original.generation).toBe(generation(sides.retired));
    expect(JSON.stringify(history(t).at(-2)!.discarded)).toContain("\"resolution\"");
  });

  it("a checkpoint that also carries evidence settles in one write: the selected side's evidence is adopted verbatim", async () => {
    const { dir, id, read, sides } = await conflicted("approved", "retired", { evidence: true });
    const before = await read();
    expect((before._conflicts as Json[]).some((c) => String(c.fieldPath).includes("checkpointEvidence"))).toBe(true);
    // The file does not hold theirs; taking theirs changes the checkpoint and the evidence together.
    expect(before.checkpointEvidence).not.toEqual(sides.retired.checkpointEvidence);
    await handleResolve(id, dir, { use: "theirs", actor: ACTOR, format: "json" });
    const t = await read();
    expect(t._conflicts ?? []).toEqual([]);
    expect(t.checkpointEvidence).toEqual(sides.retired.checkpointEvidence);
    expect((t.ownerCheckpoint as Json).lifecycle).toBe("retired");
    expect(history(t).at(-1)!.event).toBe("retirement-adopted");
  });

  it("settling advances the generation past every side's, the discarded one included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t537-cr-"));
    dirs.push(dir);
    await initProject(dir, { name: "t537" });
    const configPath = join(dir, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const cp = await createCheckpoint(dir, { title: "Decision", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Ship?", evidenceRefs: [] }, actor: ACTOR });
    const path = join(dir, ".story", "tickets", `${cp.id}.json`);
    const read = async (): Promise<Json> => JSON.parse(await readFile(path, "utf-8")) as Json;
    const base = await read();
    await resolveCheckpoint(dir, cp.id, expectedOf(base), { response: "yes", actor: ACTOR });
    const approved = await read();
    // Theirs approved and then retired: a generation past ours.
    await retireCheckpoint(dir, cp.id, expectedOf(approved), "dropped", ACTOR);
    const retired = await read();
    expect(generation(retired)).toBeGreaterThan(generation(approved));
    const merged = threeWayMerge(base, approved, retired, "ticket");
    expect(merged.clean).toBe(false);
    await writeFile(path, JSON.stringify(merged.merged, null, 2) + "\n");
    // The file holds neither side's checkpoint, so only the discarded side carries its generation.
    expect(generation(await read())).toBeLessThan(generation(retired));
    await handleResolve(cp.id, dir, { use: "ours", actor: ACTOR, format: "json" });
    const t = await read();
    expect(t._conflicts ?? []).toEqual([]);
    expect(generation(t)).toBeGreaterThan(generation(retired));
  });

  it("refuses a whole-entity value whose evidence neither side had, and writes nothing", async () => {
    const { dir, cp, read, retired, entry } = await deleteEditConflict();
    const before = await read();
    const value = { ...retired, checkpointEvidence: entry(7) };
    delete value._conflicts;
    await expect(handleResolve(cp.id, dir, { field: "_entity", value, actor: ACTOR, format: "json" })).rejects.toThrow(/not either side's/);
    expect(await read()).toEqual(before);
  });

  it("refuses a selected lifecycle of deleted on a checkpoint, with or without deletedAt, leaving the file byte-identical", async () => {
    const { dir, cp, rawText, retired } = await deleteEditConflict();
    const before = await rawText();
    const value: Json = { ...retired, lifecycle: "deleted" };
    delete value._conflicts;
    delete value.deletedAt;
    await expect(handleResolve(cp.id, dir, { field: "_entity", value, actor: ACTOR, format: "json" })).rejects.toThrow(/never deleted/);
    expect(await rawText()).toBe(before);
    // Dropping the checkpoint as well does not make the deletion acceptable: the sides carried one.
    const bare: Json = { ...value };
    delete bare.ownerCheckpoint;
    await expect(handleResolve(cp.id, dir, { field: "_entity", value: bare, actor: ACTOR, format: "json" })).rejects.toThrow(/never deleted|never removed/);
    expect(await rawText()).toBe(before);
  });

  it("refuses an ordinary dependent's whole-entity value that brings current approved evidence neither side had", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t537-cr-"));
    dirs.push(dir);
    await initProject(dir, { name: "t537" });
    const configPath = join(dir, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const cp = await createCheckpoint(dir, { title: "Upstream", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Upstream?", evidenceRefs: [] }, actor: ACTOR });
    const cpPath = join(dir, ".story", "tickets", `${cp.id}.json`);
    const pending = JSON.parse(await readFile(cpPath, "utf-8")) as Json;
    await resolveCheckpoint(dir, cp.id, expectedOf(pending), { response: "yes", actor: ACTOR });
    const up = expectedOf(JSON.parse(await readFile(cpPath, "utf-8")) as Json);
    // Evidence the owner's approval would justify, but that no side of this conflict carried.
    const current = [{ checkpoint: cp.id, generation: up.generation, revision: up.revision, digest: up.digest, state: "approved" }];

    const path = join(dir, ".story", "tickets", "T-050.json");
    const read = async (): Promise<Json> => JSON.parse(await readFile(path, "utf-8")) as Json;
    const base: Json = {
      id: "T-050", title: "Dependent", type: "task", status: "open", phase: "p0", order: 50,
      description: "", createdDate: "2026-09-27", completedDate: null, blockedBy: [cp.id], parentTicket: null,
    };
    const deleted = { ...base, lifecycle: "deleted", deletedAt: "2026-09-27T00:00:00.000Z", deletedBy: ACTOR };
    const edited = { ...base, title: "Dependent, edited" };
    const merged = threeWayMerge(base, deleted, edited, "ticket");
    expect(merged.clean).toBe(false);
    await writeFile(path, JSON.stringify(merged.merged, null, 2) + "\n");
    const before = await read();

    const value = { ...edited, checkpointEvidence: current };
    await expect(handleResolve("T-050", dir, { field: "_entity", value, actor: ACTOR, format: "json" })).rejects.toThrow(/not either side's/);
    expect(await read()).toEqual(before);

    // The same conflict settles when the value is a side's own.
    await handleResolve("T-050", dir, { field: "_entity", value: edited, actor: ACTOR, format: "json" });
    const t = await read();
    expect(t._conflicts ?? []).toEqual([]);
    expect(t.checkpointEvidence).toBeUndefined();
    expect(t.title).toBe("Dependent, edited");
  });

  it("adopts the evidence a whole-entity side had, when the other side's is the file's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t537-cr-"));
    dirs.push(dir);
    await initProject(dir, { name: "t537" });
    const configPath = join(dir, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const cp = await createCheckpoint(dir, { title: "Upstream", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Upstream?", evidenceRefs: [] }, actor: ACTOR });
    const cpPath = join(dir, ".story", "tickets", `${cp.id}.json`);
    const pending = expectedOf(JSON.parse(await readFile(cpPath, "utf-8")) as Json);
    await resolveCheckpoint(dir, cp.id, pending, { response: "yes", actor: ACTOR });
    const up = expectedOf(JSON.parse(await readFile(cpPath, "utf-8")) as Json);
    const entry = (generation: number) => [{ checkpoint: cp.id, generation, revision: up.revision, digest: up.digest, state: "approved" }];

    const path = join(dir, ".story", "tickets", "T-050.json");
    const read = async (): Promise<Json> => JSON.parse(await readFile(path, "utf-8")) as Json;
    const base: Json = {
      id: "T-050", title: "Dependent", type: "task", status: "complete", phase: "p0", order: 50,
      description: "", createdDate: "2026-09-27", completedDate: "2026-09-27", blockedBy: [cp.id], parentTicket: null,
    };
    // Each side completed against a different generation; the file holds the edited side's.
    const deleted = { ...base, checkpointEvidence: entry(up.generation - 1), lifecycle: "deleted", deletedAt: "2026-09-27T00:00:00.000Z", deletedBy: ACTOR };
    const edited = { ...base, title: "Dependent, edited", checkpointEvidence: entry(up.generation) };
    const merged = threeWayMerge(base, deleted, edited, "ticket");
    expect(merged.clean).toBe(false);
    await writeFile(path, JSON.stringify(merged.merged, null, 2) + "\n");
    expect((await read()).checkpointEvidence).toEqual(entry(up.generation));

    await handleResolve("T-050", dir, { field: "_entity", use: "ours", actor: ACTOR, format: "json" });
    const t = await read();
    expect(t._conflicts ?? []).toEqual([]);
    expect(t.checkpointEvidence).toEqual(entry(up.generation - 1));
  });

  it("refuses a hand-written value that no longer matches its digest, and writes nothing", async () => {
    const { dir, id, read } = await conflicted("retired", "approved");
    const before = await read();
    const forged = { ...(before._conflicts as Json[]).find((c) => String(c.fieldPath).includes("ownerCheckpoint"))!.ours as Json, question: "Edited by hand" };
    await expect(handleResolve(id, dir, { field: "ownerCheckpoint", value: forged, actor: ACTOR, format: "json" })).rejects.toThrow(/coupled group|digest does not match/);
    expect(await read()).toEqual(before);
  });
});
