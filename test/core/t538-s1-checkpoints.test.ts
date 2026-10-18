/**
 * T-538 S1: checkpoints after setup. The ready state, immutable evidence mode
 * behind the schema-5 fence, the evidence command, the explicit
 * immutable-evidence enable, and the atomic add-prerequisites step on ticket
 * update. RED at 0f40e09d: none of checkpointReady, parseEvidenceMode,
 * IMMUTABLE_EVIDENCE_SCHEMA_VERSION, addCheckpointEvidence, the evidenceMode
 * create input, the immutableEvidence enable option or addBlockedBy exists
 * there, and the loader refuses schemaVersion 5.
 *
 * HOME and git's global config point at a scratch directory for the whole
 * file, so no handler reads the real ones.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject, writeTicket } from "../../src/core/project-loader.js";
import {
  addCheckpointEvidence,
  attachCheckpoint,
  changeCheckpoint,
  createCheckpoint,
  reopenCheckpoint,
  resolveCheckpoint,
  retireCheckpoint,
  type ExpectedCheckpoint,
} from "../../src/core/checkpoint-lifecycle.js";
import { assertCheckpointWriteAllowed } from "../../src/core/checkpoint-guard.js";
import { checkpointReady, parseEvidenceMode, parseOwnerCheckpoint, type OwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import { checkpointSummary } from "../../src/core/checkpoint-display.js";
import { enableCheckpoints, type CheckpointEnableDeps } from "../../src/core/checkpoint-enable.js";
import { computeActionability } from "../../src/core/recommend.js";
import { validateProject } from "../../src/core/validation.js";
import { handleTicketCreate, handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { handleCheckpointList } from "../../src/cli/commands/checkpoint.js";
import { mergeDriverCapabilities } from "../../src/cli/commands/merge-driver.js";
import {
  CHECKPOINT_SCHEMA_VERSION,
  IMMUTABLE_EVIDENCE_SCHEMA_VERSION,
  MAX_SUPPORTED_SCHEMA_VERSION,
} from "../../src/core/errors.js";
import type { Ticket } from "../../src/models/ticket.js";

const ACTOR = "owner@example.test";
const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-s1-home-"));
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

/** A project stamped at `schema` (unset leaves init's own version). */
async function project(schema?: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t538-s1-"));
  dirs.push(dir);
  await initProject(dir, { name: "t538" });
  if (schema !== undefined) {
    const path = join(dir, ".story", "config.json");
    const config = JSON.parse(await readFile(path, "utf-8"));
    config.schemaVersion = schema;
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return dir;
}

const configOf = async (dir: string) => JSON.parse(await readFile(join(dir, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
const ticketFile = (dir: string, id: string) => join(dir, ".story", "tickets", `${id}.json`);
const ticketOnDisk = async (dir: string, id: string) => JSON.parse(await readFile(ticketFile(dir, id), "utf-8")) as Record<string, unknown>;
const stateOf = async (dir: string) => (await loadProject(dir)).state;

function checkpointOf(t: object): OwnerCheckpoint {
  const p = parseOwnerCheckpoint(t);
  if (p.kind !== "ok") throw new Error(`not a readable checkpoint: ${p.kind}`);
  return p.checkpoint;
}
const expectedOf = (t: object): ExpectedCheckpoint => {
  const cp = checkpointOf(t);
  return { generation: cp.generation, revision: cp.revision, digest: cp.digest };
};

const DECISION = { kind: "decision" as const, question: "Ship the new onboarding?", evidenceRefs: [] as string[] };
const ACCEPTANCE = { kind: "acceptance" as const, criteria: "The demo prints the greeting", evidenceRefs: [] as string[] };

async function newCheckpoint(
  dir: string,
  opts: { content?: typeof DECISION | typeof ACCEPTANCE; blockedBy?: string[]; evidenceMode?: "immutable" } = {},
): Promise<Ticket> {
  return createCheckpoint(dir, {
    title: "Owner checkpoint",
    description: "",
    phase: "p0",
    owner: "owner",
    content: opts.content ?? DECISION,
    actor: ACTOR,
    ...(opts.blockedBy ? { blockedBy: opts.blockedBy } : {}),
    ...(opts.evidenceMode ? { evidenceMode: opts.evidenceMode } : {}),
  });
}

async function newTicket(dir: string, blockedBy: string[] = []): Promise<string> {
  const out = await handleTicketCreate({ title: "Work", type: "task", phase: "p0", description: "", blockedBy, parentTicket: null }, "json", dir);
  return JSON.parse(out.output).data.id as string;
}

async function complete(dir: string, id: string): Promise<void> {
  await handleTicketUpdate(id, { status: "complete" }, "json", dir, true);
}

async function evidenceSource(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------

describe("schema fence", () => {
  it("the loader accepts schemaVersion 5 and refuses 6", async () => {
    expect(MAX_SUPPORTED_SCHEMA_VERSION).toBe(5);
    expect(IMMUTABLE_EVIDENCE_SCHEMA_VERSION).toBe(5);
    const five = await project(5);
    expect((await loadProject(five)).state.config.schemaVersion).toBe(5);
    const six = await project(6);
    await expect(loadProject(six)).rejects.toThrow(/schemaVersion 6|exceeds/);
  });

  it("the merge driver reports schema 5 as its maximum", () => {
    expect(mergeDriverCapabilities().maxSchemaVersion).toBe(5);
  });
});

describe("ready state", () => {
  it("a pending checkpoint with no prerequisites is ready", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const cp = await newCheckpoint(dir);
    const state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(cp.id)!)).toBe(true);
  });

  it("an incomplete prerequisite makes it not ready; completing it makes it ready", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const work = await newTicket(dir);
    const cp = await newCheckpoint(dir, { blockedBy: [work] });
    let state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(cp.id)!)).toBe(false);
    await complete(dir, work);
    state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(cp.id)!)).toBe(true);
  });

  it("a prerequisite that is a pending checkpoint makes it not ready; an approved one does not", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const first = await newCheckpoint(dir);
    const second = await newCheckpoint(dir, { blockedBy: [first.id] });
    let state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(second.id)!)).toBe(false);
    await resolveCheckpoint(dir, first.id, expectedOf(first), { response: "yes", actor: ACTOR });
    state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(second.id)!)).toBe(true);
  });

  it("a retired prerequisite releases a pending checkpoint", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const first = await newCheckpoint(dir);
    const second = await newCheckpoint(dir, { blockedBy: [first.id] });
    let state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(second.id)!)).toBe(false);
    await retireCheckpoint(dir, first.id, expectedOf(first), "no longer needed", ACTOR);
    state = await stateOf(dir);
    expect(checkpointOf(state.ticketByID(first.id)!).lifecycle).toBe("retired");
    expect(checkpointReady(state, state.ticketByID(second.id)!)).toBe(true);
  });

  it("a retired checkpoint is never ready, even with nothing before it", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const cp = await newCheckpoint(dir);
    let state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(cp.id)!)).toBe(true);
    await retireCheckpoint(dir, cp.id, expectedOf(cp), "no longer needed", ACTOR);
    state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(cp.id)!)).toBe(false);
  });

  it("an approved or non-checkpoint ticket is never ready", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const cp = await newCheckpoint(dir);
    await resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "yes", actor: ACTOR });
    const work = await newTicket(dir);
    const state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(cp.id)!)).toBe(false);
    expect(checkpointReady(state, state.ticketByID(work)!)).toBe(false);
  });

  it("an unrecognized checkpoint is never ready", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const cp = await newCheckpoint(dir);
    const raw = await ticketOnDisk(dir, cp.id);
    (raw.ownerCheckpoint as Record<string, unknown>).kind = "mystery";
    await writeFile(ticketFile(dir, cp.id), JSON.stringify(raw, null, 2) + "\n");
    const state = await stateOf(dir);
    expect(checkpointReady(state, state.ticketByID(cp.id)!)).toBe(false);
  });

  it("recommend keeps the checkpoint owner_gated and names the ready state in its reason", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const work = await newTicket(dir);
    const cp = await newCheckpoint(dir, { blockedBy: [work] });
    let state = await stateOf(dir);
    let a = computeActionability("ticket", state.ticketByID(cp.id)!, { state } as never);
    expect(a.status).toBe("owner_gated");
    expect(a.reason).toBe("owner checkpoint awaiting the owner's answer");
    await complete(dir, work);
    state = await stateOf(dir);
    a = computeActionability("ticket", state.ticketByID(cp.id)!, { state } as never);
    expect(a.status).toBe("owner_gated");
    expect(a.reason).toBe("owner checkpoint ready: prepare the evidence and ask the owner");
  });

  it("checkpoint list prints ready and the JSON summary carries it", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const work = await newTicket(dir);
    const waiting = await newCheckpoint(dir, { blockedBy: [work] });
    const ready = await newCheckpoint(dir);
    const md = (await handleCheckpointList("md", dir)).output;
    const lines = md.split("\n");
    expect(lines.find((l) => l.includes(ready.displayId ?? ready.id))).toContain("[checkpoint pending, ready]");
    expect(lines.find((l) => l.includes(waiting.displayId ?? waiting.id))).toContain("[checkpoint pending]");
    const json = JSON.parse((await handleCheckpointList("json", dir)).output).data as Array<{ id: string; ready?: boolean }>;
    expect(json.find((s) => s.id === (ready.displayId ?? ready.id))?.ready).toBe(true);
    expect(json.find((s) => s.id === (waiting.displayId ?? waiting.id))?.ready).toBe(false);
  });
});

describe("immutable evidence mode", () => {
  it("is refused below schema 5, naming the enable command", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    await expect(newCheckpoint(dir, { evidenceMode: "immutable" })).rejects.toThrow(/checkpoint enable --immutable-evidence/);
    const work = await newTicket(dir);
    await expect(attachCheckpoint(dir, work, { owner: "owner", content: DECISION, actor: ACTOR, evidenceMode: "immutable" })).rejects.toThrow(/checkpoint enable --immutable-evidence/);
    expect((await ticketOnDisk(dir, work)).checkpointEvidenceMode).toBeUndefined();
  });

  it("is recorded at create and attach at schema 5, beside the record and outside its digest", async () => {
    const dir = await project(5);
    const cp = await newCheckpoint(dir, { evidenceMode: "immutable" });
    const raw = await ticketOnDisk(dir, cp.id);
    expect(raw.checkpointEvidenceMode).toBe("immutable");
    expect((raw.ownerCheckpoint as Record<string, unknown>).checkpointEvidenceMode).toBeUndefined();
    const work = await newTicket(dir);
    await attachCheckpoint(dir, work, { owner: "owner", content: DECISION, actor: ACTOR, evidenceMode: "immutable" });
    expect((await ticketOnDisk(dir, work)).checkpointEvidenceMode).toBe("immutable");
    expect(parseEvidenceMode(raw)).toEqual({ kind: "immutable" });
    expect(parseEvidenceMode({})).toEqual({ kind: "legacy" });
  });

  it("attach refuses a ticket that already carries a mode, nothing written", async () => {
    const dir = await project(5);
    const work = await newTicket(dir);
    const path = ticketFile(dir, work);
    await writeFile(path, JSON.stringify({ ...(await ticketOnDisk(dir, work)), checkpointEvidenceMode: "immutable" }, null, 2) + "\n");
    const before = await readFile(path, "utf-8");
    for (const evidenceMode of [undefined, "immutable" as const]) {
      await expect(attachCheckpoint(dir, work, { owner: "owner", content: DECISION, actor: ACTOR, ...(evidenceMode ? { evidenceMode } : {}) }))
        .rejects.toThrow(/already carries checkpointEvidenceMode/);
    }
    expect(await readFile(path, "utf-8")).toBe(before);
  });

  it("a checkpoint created without a mode at schema 5 stays legacy", async () => {
    const dir = await project(5);
    const cp = await newCheckpoint(dir);
    expect((await ticketOnDisk(dir, cp.id)).checkpointEvidenceMode).toBeUndefined();
  });

  it("only the lifecycle authority may set, change or remove the mode", () => {
    const prior = { id: "t-1", ownerCheckpoint: { kind: "decision" } };
    expect(() => assertCheckpointWriteAllowed(prior, { ...prior, checkpointEvidenceMode: "immutable" })).toThrow(/checkpointEvidenceMode/);
    const immutable = { ...prior, checkpointEvidenceMode: "immutable" };
    expect(() => assertCheckpointWriteAllowed(immutable, prior)).toThrow(/checkpointEvidenceMode/);
    // On a ticket that is not a checkpoint too.
    expect(() => assertCheckpointWriteAllowed({ id: "t-2" }, { id: "t-2", checkpointEvidenceMode: "immutable" })).toThrow(/checkpointEvidenceMode/);
  });

  it("an ordinary ticket update keeps the mode", async () => {
    const dir = await project(5);
    const cp = await newCheckpoint(dir, { evidenceMode: "immutable" });
    await handleTicketUpdate(cp.id, { title: "Renamed" }, "json", dir);
    expect((await ticketOnDisk(dir, cp.id)).checkpointEvidenceMode).toBe("immutable");
  });

  it.each([["a typo", "imutable"], ["a future mode", "signed"], ["a wrong type", 1]])(
    "an unknown value (%s) is unsupported, never legacy: resolve, change and evidence refuse, validate reports",
    async (_label, value) => {
      const dir = await project(5);
      const cp = await newCheckpoint(dir, { evidenceMode: "immutable" });
      const raw = await ticketOnDisk(dir, cp.id);
      raw.checkpointEvidenceMode = value;
      await writeFile(ticketFile(dir, cp.id), JSON.stringify(raw, null, 2) + "\n");
      expect(parseEvidenceMode(raw).kind).toBe("unsupported");
      const exp = expectedOf(raw);
      await expect(resolveCheckpoint(dir, cp.id, exp, { response: "yes", actor: ACTOR })).rejects.toThrow(/evidence mode/);
      await expect(changeCheckpoint(dir, cp.id, exp, { ...DECISION, question: "Other?" }, ACTOR)).rejects.toThrow(/evidence mode/);
      const src = await evidenceSource(dir, "demo.txt", "hello");
      await expect(addCheckpointEvidence(dir, cp.id, exp, { file: src, actor: ACTOR })).rejects.toThrow(/evidence mode/);
      const findings = validateProject(await stateOf(dir)).findings;
      expect(findings.some((f) => f.code === "checkpoint_evidence_mode_unsupported")).toBe(true);
      expect(await ticketOnDisk(dir, cp.id)).toEqual(raw);
    },
  );
});

describe("checkpoint evidence", () => {
  async function immutableAcceptance(dir: string): Promise<Ticket> {
    return newCheckpoint(dir, { content: ACCEPTANCE, evidenceMode: "immutable" });
  }

  it("copies the file to docs/checkpoints/<id>/<sha16>.<ext> and adds that ref as a new revision", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const src = await evidenceSource(dir, "demo-output.txt", "hello world\n");
    const before = checkpointOf(await ticketOnDisk(dir, cp.id));
    const out = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    const ref = `docs/checkpoints/${cp.id}/${sha("hello world\n").slice(0, 16)}.txt`;
    expect(out.ref).toBe(ref);
    expect(out.reused).toBe(false);
    expect(await readFile(join(dir, ref), "utf-8")).toBe("hello world\n");
    const after = checkpointOf(await ticketOnDisk(dir, cp.id));
    expect(after.evidenceRefs).toEqual([ref]);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.generation).toBe(before.generation + 1);
    // The source is never moved or edited.
    expect(await readFile(src, "utf-8")).toBe("hello world\n");
  });

  it("adding the same content again is idempotent: no write, same tokens", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const src = await evidenceSource(dir, "demo.txt", "same\n");
    await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    const once = await readFile(ticketFile(dir, cp.id), "utf-8");
    const out = await addCheckpointEvidence(dir, cp.id, expectedOf(JSON.parse(once)), { file: src, actor: ACTOR });
    expect(out.reused).toBe(true);
    expect(await readFile(ticketFile(dir, cp.id), "utf-8")).toBe(once);
  });

  it("changed content adds a second ref and keeps the first file byte-equal", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const src = await evidenceSource(dir, "demo.txt", "v1\n");
    const first = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    await writeFile(src, "v2\n");
    const second = await addCheckpointEvidence(dir, cp.id, expectedOf(first.ticket), { file: src, actor: ACTOR });
    expect(second.ref).not.toBe(first.ref);
    expect(checkpointOf(await ticketOnDisk(dir, cp.id)).evidenceRefs).toEqual([first.ref, second.ref]);
    expect(await readFile(join(dir, first.ref), "utf-8")).toBe("v1\n");
    expect(await readFile(join(dir, second.ref), "utf-8")).toBe("v2\n");
  });

  it("a planted file with other bytes at the target name is refused and nothing is written", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const src = await evidenceSource(dir, "demo.txt", "real\n");
    const target = join(dir, "docs", "checkpoints", cp.id, `${sha("real\n").slice(0, 16)}.txt`);
    await mkdir(join(dir, "docs", "checkpoints", cp.id), { recursive: true });
    await writeFile(target, "planted\n");
    const before = await readFile(ticketFile(dir, cp.id), "utf-8");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR })).rejects.toThrow(/already holds other content/);
    expect(await readFile(target, "utf-8")).toBe("planted\n");
    expect(await readFile(ticketFile(dir, cp.id), "utf-8")).toBe(before);
  });

  it("a stale token is refused before any file is written", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const src = await evidenceSource(dir, "demo.txt", "x\n");
    const stale = { ...expectedOf(cp), generation: 99 };
    await expect(addCheckpointEvidence(dir, cp.id, stale, { file: src, actor: ACTOR })).rejects.toThrow(/changed since you read it/);
    expect(existsSync(join(dir, "docs", "checkpoints"))).toBe(false);
  });

  it("a source outside the project is refused", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const outside = await mkdtemp(join(tmpdir(), "t538-s1-outside-"));
    dirs.push(outside);
    const src = join(outside, "secret.txt");
    await writeFile(src, "secret\n");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR })).rejects.toThrow(/inside the project/);
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: join(dir, "..", "x.txt"), actor: ACTOR })).rejects.toThrow(/inside the project/);
    expect(existsSync(join(dir, "docs", "checkpoints"))).toBe(false);
  });

  it("a link inside the project to a file outside it is refused", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const outside = await mkdtemp(join(tmpdir(), "t538-s1-outside-"));
    dirs.push(outside);
    const target = join(outside, "secret.txt");
    await writeFile(target, "secret\n");
    await symlink(target, join(dir, "demo.txt"));
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: join(dir, "demo.txt"), actor: ACTOR })).rejects.toThrow(/inside the project/);
    expect(existsSync(join(dir, "docs", "checkpoints"))).toBe(false);
  });

  it("is refused on a legacy checkpoint, naming checkpoint change", async () => {
    const dir = await project(5);
    const cp = await newCheckpoint(dir, { content: ACCEPTANCE });
    const src = await evidenceSource(dir, "demo.txt", "x\n");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR })).rejects.toThrow(/checkpoint change/);
  });

  it("an extension that is not plain becomes .bin", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const src = await evidenceSource(dir, "weird.t x;t", "y\n");
    const out = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    expect(out.ref.endsWith(".bin")).toBe(true);
  });

  it("evidence added after approval voids the approval", async () => {
    const dir = await project(5);
    const cp = await immutableAcceptance(dir);
    const src = await evidenceSource(dir, "demo.txt", "a\n");
    const first = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    await resolveCheckpoint(dir, cp.id, expectedOf(first.ticket), { response: "approved", artifactRef: first.ref, actor: ACTOR });
    const approved = await ticketOnDisk(dir, cp.id);
    expect(approved.status).toBe("complete");
    await writeFile(src, "b\n");
    await addCheckpointEvidence(dir, cp.id, expectedOf(approved), { file: src, actor: ACTOR });
    const after = await ticketOnDisk(dir, cp.id);
    expect(after.status).toBe("open");
    expect(checkpointOf(after).resolution).toBeUndefined();
  });
});

describe("resolve on an immutable checkpoint", () => {
  it("requires artifactRef to be one of the current evidence refs", async () => {
    const dir = await project(5);
    const cp = await newCheckpoint(dir, { content: ACCEPTANCE, evidenceMode: "immutable" });
    const src = await evidenceSource(dir, "demo.txt", "a\n");
    const ev = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    const exp = expectedOf(ev.ticket);
    await expect(resolveCheckpoint(dir, cp.id, exp, { response: "ok", artifactRef: "build 42", actor: ACTOR })).rejects.toThrow(/one of its evidence revisions/);
    await expect(resolveCheckpoint(dir, cp.id, exp, { response: "ok", artifactRef: "demo.txt", actor: ACTOR })).rejects.toThrow(/one of its evidence revisions/);
    const { ticket } = await resolveCheckpoint(dir, cp.id, exp, { response: "ok", artifactRef: ev.ref, actor: ACTOR });
    expect(ticket.status).toBe("complete");
  });

  it("a decision with an artifactRef outside the refs is refused; without one it resolves", async () => {
    const dir = await project(5);
    const cp = await newCheckpoint(dir, { evidenceMode: "immutable" });
    await expect(resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "yes", artifactRef: "x", actor: ACTOR })).rejects.toThrow(/one of its evidence revisions/);
    const { ticket } = await resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "yes", actor: ACTOR });
    expect(ticket.status).toBe("complete");
  });

  it("a legacy checkpoint still accepts any artifactRef, at schema 4 and at 5", async () => {
    for (const schema of [CHECKPOINT_SCHEMA_VERSION, 5]) {
      const dir = await project(schema);
      const cp = await newCheckpoint(dir, { content: ACCEPTANCE });
      const { ticket } = await resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "ok", artifactRef: "build 42", actor: ACTOR });
      expect(ticket.status).toBe("complete");
    }
  });
});

describe("checkpoint enable --immutable-evidence", () => {
  const READY: CheckpointEnableDeps = { capabilities: async (_root, protocol) => mergeDriverCapabilities(protocol) };

  it.each([[2], [4]])("stamps a non-team schema-%i project to 5, and a second run changes nothing", async (from) => {
    const dir = await project(from);
    expect(await enableCheckpoints(dir, READY, { immutableEvidence: true })).toEqual({ status: "enabled", team: false });
    expect((await configOf(dir)).schemaVersion).toBe(5);
    const before = await readFile(join(dir, ".story", "config.json"), "utf-8");
    expect(await enableCheckpoints(dir, READY, { immutableEvidence: true })).toEqual({ status: "already", team: false });
    expect(await readFile(join(dir, ".story", "config.json"), "utf-8")).toBe(before);
  });

  it("a plain enable on a schema-5 project is already done and never lowers it", async () => {
    const dir = await project(2);
    await enableCheckpoints(dir, READY, { immutableEvidence: true });
    expect(await enableCheckpoints(dir, READY)).toEqual({ status: "already", team: false });
    expect((await configOf(dir)).schemaVersion).toBe(5);
  });

  it("a plain enable on a schema-5 project whose enable step is unfinished finishes it at 5", async () => {
    const dir = await project(5);
    expect((await configOf(dir)).checkpointEnable).toBeUndefined();
    expect(await enableCheckpoints(dir, READY)).toEqual({ status: "enabled", team: false });
    const config = await configOf(dir);
    expect(config.schemaVersion).toBe(5);
    expect((config.checkpointEnable as Record<string, unknown>).step).toBe("complete");
  });

  it("a plain enable still stamps 4, never 5", async () => {
    const dir = await project(2);
    await enableCheckpoints(dir, READY);
    expect((await configOf(dir)).schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
  });

  async function teamProject(schema: number): Promise<string> {
    const { execFileSync } = await import("node:child_process");
    const { teamSetup } = await import("../../src/core/team-setup.js");
    const dir = await project(schema);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const path = join(dir, ".story", "config.json");
    const config = await configOf(dir);
    config.team = { enabled: true };
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
    await teamSetup(dir);
    return dir;
  }
  const SCHEMA4_DRIVER: CheckpointEnableDeps = { capabilities: async (_root, protocol) => ({ ...mergeDriverCapabilities(protocol), maxSchemaVersion: 4 }) };

  it("a plain enable on a team schema-5 project checks the driver against 5, not 4: refused, nothing written", async () => {
    const dir = await teamProject(5);
    const path = join(dir, ".story", "config.json");
    const before = await readFile(path, "utf-8");
    await expect(enableCheckpoints(dir, SCHEMA4_DRIVER)).rejects.toThrow(/reads schema 4 at most, not 5[\s\S]*Nothing was written/);
    expect(await readFile(path, "utf-8")).toBe(before);
  });

  it("an upgrade to 5 landing during a plain enable's preflight is decided again against 5: refused, the upgrade kept", async () => {
    const dir = await teamProject(2);
    const path = join(dir, ".story", "config.json");
    let upgraded = false;
    const deps: CheckpointEnableDeps = {
      ...SCHEMA4_DRIVER,
      async afterDecision(root) {
        if (upgraded) return;
        upgraded = true;
        const config = JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8"));
        config.schemaVersion = 5;
        await writeFile(join(root, ".story", "config.json"), JSON.stringify(config, null, 2) + "\n");
      },
    };
    await expect(enableCheckpoints(dir, deps)).rejects.toThrow(/reads schema 4 at most, not 5[\s\S]*Nothing was written/);
    const config = JSON.parse(await readFile(path, "utf-8"));
    expect(config.schemaVersion).toBe(5);
    expect(config.checkpointEnable).toBeUndefined();
  });

  it("a team clone whose binary reports only schema 4 is refused for immutable evidence, nothing written", async () => {
    const { execFileSync } = await import("node:child_process");
    const { teamSetup } = await import("../../src/core/team-setup.js");
    const dir = await project(2);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const path = join(dir, ".story", "config.json");
    const config = await configOf(dir);
    config.team = { enabled: true };
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
    await teamSetup(dir);
    const before = await readFile(path, "utf-8");
    const attributes = existsSync(join(dir, ".story", ".gitattributes")) ? await readFile(join(dir, ".story", ".gitattributes"), "utf-8") : null;
    const SCHEMA4: CheckpointEnableDeps = { capabilities: async (_root, protocol) => ({ ...mergeDriverCapabilities(protocol), maxSchemaVersion: 4 }) };
    await expect(enableCheckpoints(dir, SCHEMA4, { immutableEvidence: true })).rejects.toThrow(/immutable checkpoint evidence[\s\S]*Nothing was written/);
    expect(await readFile(path, "utf-8")).toBe(before);
    const attributesAfter = existsSync(join(dir, ".story", ".gitattributes")) ? await readFile(join(dir, ".story", ".gitattributes"), "utf-8") : null;
    expect(attributesAfter).toBe(attributes);
    // With a binary that knows schema 5, the same clone enables.
    expect(await enableCheckpoints(dir, READY, { immutableEvidence: true })).toEqual({ status: "enabled", team: true });
    expect((await configOf(dir)).schemaVersion).toBe(5);
  });
});

describe("ticket update --add-blocked-by", () => {
  it("records what plain --blocked-by does on a pending and an approved checkpoint today", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const a = await newTicket(dir);
    const pending = await newCheckpoint(dir);
    await handleTicketUpdate(pending.id, { blockedBy: [a] }, "json", dir);
    expect((await ticketOnDisk(dir, pending.id)).blockedBy).toEqual([a]);
    const approved = await newCheckpoint(dir);
    await resolveCheckpoint(dir, approved.id, expectedOf(approved), { response: "yes", actor: ACTOR });
    // Plain replacement is not refused on an approved checkpoint: it replaces the set.
    await handleTicketUpdate(approved.id, { blockedBy: [a] }, "json", dir);
    expect((await ticketOnDisk(dir, approved.id)).blockedBy).toEqual([a]);
  });

  it("adds to the existing prerequisites, keeping them, and an id already present is not repeated", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const a = await newTicket(dir);
    const b = await newTicket(dir);
    const cp = await newCheckpoint(dir, { blockedBy: [a] });
    await handleTicketUpdate(cp.id, { addBlockedBy: [b, a] }, "json", dir);
    expect((await ticketOnDisk(dir, cp.id)).blockedBy).toEqual([a, b]);
  });

  it("works on an ordinary ticket", async () => {
    const dir = await project();
    const a = await newTicket(dir);
    const b = await newTicket(dir, [a]);
    const c = await newTicket(dir);
    await handleTicketUpdate(b, { addBlockedBy: [c] }, "json", dir);
    expect((await ticketOnDisk(dir, b)).blockedBy).toEqual([a, c]);
  });

  it("refuses a cycle with nothing written", async () => {
    const dir = await project();
    const a = await newTicket(dir);
    const b = await newTicket(dir, [a]);
    const before = await readFile(ticketFile(dir, a), "utf-8");
    await expect(handleTicketUpdate(a, { addBlockedBy: [b] }, "json", dir)).rejects.toThrow(/cycle/i);
    expect(await readFile(ticketFile(dir, a), "utf-8")).toBe(before);
  });

  it("refuses a dependent of the checkpoint as its prerequisite", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const cp = await newCheckpoint(dir);
    const dependent = await newTicket(dir, [cp.id]);
    const before = await readFile(ticketFile(dir, cp.id), "utf-8");
    await expect(handleTicketUpdate(cp.id, { addBlockedBy: [dependent] }, "json", dir)).rejects.toThrow(/cycle/i);
    expect(await readFile(ticketFile(dir, cp.id), "utf-8")).toBe(before);
  });

  it.each(["approved", "retired", "unrecognized"])("refuses a %s checkpoint, naming reopen first", async (which) => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const a = await newTicket(dir);
    const cp = await newCheckpoint(dir);
    if (which === "approved") await resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "yes", actor: ACTOR });
    if (which === "retired") {
      const { retireCheckpoint } = await import("../../src/core/checkpoint-lifecycle.js");
      await retireCheckpoint(dir, cp.id, expectedOf(cp), "not needed", ACTOR);
    }
    if (which === "unrecognized") {
      const raw = await ticketOnDisk(dir, cp.id);
      (raw.ownerCheckpoint as Record<string, unknown>).kind = "mystery";
      await writeFile(ticketFile(dir, cp.id), JSON.stringify(raw, null, 2) + "\n");
    }
    const before = await readFile(ticketFile(dir, cp.id), "utf-8");
    await expect(handleTicketUpdate(cp.id, { addBlockedBy: [a] }, "json", dir)).rejects.toThrow(/pending/);
    expect(await readFile(ticketFile(dir, cp.id), "utf-8")).toBe(before);
  });

  it("a reopened checkpoint takes prerequisites again", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const a = await newTicket(dir);
    const cp = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "yes", actor: ACTOR });
    await reopenCheckpoint(dir, cp.id, expectedOf(ticket), ACTOR, "changes requested");
    await handleTicketUpdate(cp.id, { addBlockedBy: [a] }, "json", dir);
    expect((await ticketOnDisk(dir, cp.id)).blockedBy).toEqual([a]);
  });

  it("cannot be combined with --blocked-by", async () => {
    const dir = await project();
    const a = await newTicket(dir);
    const b = await newTicket(dir);
    await expect(handleTicketUpdate(b, { blockedBy: [a], addBlockedBy: [a] }, "json", dir)).rejects.toThrow(/either/);
  });

  it("two concurrent additions both survive", async () => {
    const dir = await project(CHECKPOINT_SCHEMA_VERSION);
    const a = await newTicket(dir);
    const b = await newTicket(dir);
    const cp = await newCheckpoint(dir);
    await Promise.all([
      handleTicketUpdate(cp.id, { addBlockedBy: [a] }, "json", dir),
      handleTicketUpdate(cp.id, { addBlockedBy: [b] }, "json", dir),
    ]);
    expect(new Set((await ticketOnDisk(dir, cp.id)).blockedBy as string[])).toEqual(new Set([a, b]));
  });
});

describe("summary", () => {
  it("names the evidence mode", async () => {
    const dir = await project(5);
    const cp = await newCheckpoint(dir, { evidenceMode: "immutable" });
    const state = await stateOf(dir);
    expect(checkpointSummary(state.ticketByID(cp.id)!, state)?.evidenceMode).toBe("immutable");
    const legacy = await newCheckpoint(dir);
    const s2 = await stateOf(dir);
    expect(checkpointSummary(s2.ticketByID(legacy.id)!, s2)?.evidenceMode).toBe("legacy");
  });

  it("writeTicket with an unchanged mode is allowed without authority", async () => {
    const dir = await project(5);
    const cp = await newCheckpoint(dir, { evidenceMode: "immutable" });
    const raw = await ticketOnDisk(dir, cp.id);
    await expect(writeTicket({ ...(raw as unknown as Ticket), title: "x" }, dir)).resolves.toBeUndefined();
    void readdir;
  });
});

describe("three-way merge of the evidence mode", () => {
  it("one side's attach carries the mode with the record; both sides setting it differently conflicts", async () => {
    const { threeWayMerge } = await import("../../src/core/merge-driver.js");
    const dir = await project(5);
    const base = await ticketOnDisk(dir, await newTicket(dir));
    const attached = { ...base, checkpointEvidenceMode: "immutable", ownerCheckpoint: { kind: "decision" } };
    const retitled = { ...base, title: "ours" };
    const clean = threeWayMerge(base, retitled, attached, "ticket");
    expect(clean.merged.checkpointEvidenceMode).toBe("immutable");
    expect(clean.merged.title).toBe("ours");
    expect(clean.conflicts.some((c) => c.field === "checkpointEvidenceMode")).toBe(false);
    const diverged = threeWayMerge(base, { ...base, checkpointEvidenceMode: "signed" }, attached, "ticket");
    expect(diverged.conflicts.some((c) => c.field === "checkpointEvidenceMode")).toBe(true);
  });
});
