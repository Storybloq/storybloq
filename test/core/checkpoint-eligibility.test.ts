/**
 * T-537 S3: a checkpoint blocks its dependents until it releases (approved or
 * retired, whatever its status says), is never selected, started or claimed as
 * work, and shows in recommend as owner-gated; a completed dependent whose
 * checkpoint changed shows a reassessment line until it is re-completed. RED
 * at 09e7dade: core/checkpoint-lifecycle.ts and core/checkpoint-evidence.ts do
 * not exist there.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../src/core/errors.js";
import { changeCheckpoint, createCheckpoint, resolveCheckpoint, retireCheckpoint, type ExpectedCheckpoint } from "../../src/core/checkpoint-lifecycle.js";
import { assertCheckpointEligible, describeIneligible } from "../../src/core/checkpoint-evidence.js";
import { parseOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import { nextTicket, nextTickets, ticketsUnblockedBy } from "../../src/core/queries.js";
import { recommend } from "../../src/core/recommend.js";
import { handleTicketCreate, handleTicketStart, handleTicketUpdate } from "../../src/cli/commands/ticket.js";
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
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t537-s3-"));
  dirs.push(dir);
  await initProject(dir, { name: "t537" });
  const path = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(path, "utf-8"));
  config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  return dir;
}

const DECISION = { kind: "decision" as const, question: "Ship the new onboarding?", evidenceRefs: [] };

const newCheckpoint = (dir: string): Promise<Ticket> =>
  createCheckpoint(dir, { title: "Owner decision", description: "", phase: "p0", owner: "owner", content: DECISION, actor: ACTOR });

async function newTicket(dir: string, blockedBy: string[] = [], title = "Dependent"): Promise<string> {
  const out = await handleTicketCreate({ title, type: "task", phase: "p0", description: "", blockedBy, parentTicket: null }, "json", dir);
  return JSON.parse(out.output).data.id as string;
}

function expectedOf(t: object): ExpectedCheckpoint {
  const p = parseOwnerCheckpoint(t);
  if (p.kind !== "ok") throw new Error("not a readable checkpoint");
  return { generation: p.checkpoint.generation, revision: p.checkpoint.revision, digest: p.checkpoint.digest };
}

async function stateOf(dir: string) {
  return (await loadProject(dir)).state;
}

async function rewrite(dir: string, id: string, edit: (raw: Record<string, unknown>) => void): Promise<void> {
  const path = join(dir, ".story", "tickets", `${id}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  edit(raw);
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
}

describe("blocking", () => {
  it("a pending checkpoint blocks; approval and retirement release, whatever the status says", async () => {
    const dir = await project();
    const approved = await newCheckpoint(dir);
    const retired = await newCheckpoint(dir);
    const pending = await newCheckpoint(dir);
    const depA = await newTicket(dir, [approved.id]);
    const depR = await newTicket(dir, [retired.id]);
    const depP = await newTicket(dir, [pending.id]);
    await resolveCheckpoint(dir, approved.id, expectedOf(approved), { response: "yes", actor: ACTOR });
    await retireCheckpoint(dir, retired.id, expectedOf(retired), "dropped", ACTOR);

    const state = await stateOf(dir);
    expect(state.ticketByID(retired.id)!.status).toBe("open");
    expect(state.isBlocked(state.ticketByID(depA)!)).toBe(false);
    expect(state.isBlocked(state.ticketByID(depR)!)).toBe(false);
    expect(state.isBlocked(state.ticketByID(depP)!)).toBe(true);
  });

  it("a complete checkpoint whose approval no longer matches its content blocks, and so does an unreadable one", async () => {
    const dir = await project();
    const stale = await newCheckpoint(dir);
    const unreadable = await newCheckpoint(dir);
    const depS = await newTicket(dir, [stale.id]);
    const depU = await newTicket(dir, [unreadable.id]);
    await resolveCheckpoint(dir, stale.id, expectedOf(stale), { response: "yes", actor: ACTOR });
    await rewrite(dir, stale.id, (raw) => { (raw.ownerCheckpoint as Record<string, unknown>).question = "Edited by hand"; });
    await rewrite(dir, unreadable.id, (raw) => { raw.ownerCheckpoint = { kind: "vote" }; raw.status = "complete"; });

    const state = await stateOf(dir);
    expect(state.ticketByID(stale.id)!.status).toBe("complete");
    expect(state.isBlocked(state.ticketByID(depS)!)).toBe(true);
    expect(state.isBlocked(state.ticketByID(depU)!)).toBe(true);
    // An ordinary blocker keeps its status-based rule.
    const plain = await newTicket(dir, [], "Plain blocker");
    const depPlain = await newTicket(dir, [plain], "Waits on plain");
    await handleTicketUpdate(plain, { status: "complete" }, "json", dir);
    const after = await stateOf(dir);
    expect(after.isBlocked(after.ticketByID(depPlain)!)).toBe(false);
  });

  it("unblock impact counts a checkpoint as released only when it is", async () => {
    const dir = await project();
    const cp = await newCheckpoint(dir);
    const other = await newTicket(dir, [], "Other blocker");
    const dep = await newTicket(dir, [cp.id, other]);
    let state = await stateOf(dir);
    expect(ticketsUnblockedBy(other, state).map((t) => t.id)).toEqual([]);
    await retireCheckpoint(dir, cp.id, expectedOf(cp), "dropped", ACTOR);
    state = await stateOf(dir);
    expect(ticketsUnblockedBy(other, state).map((t) => t.id)).toEqual([dep]);
  });
});

describe("selection", () => {
  it("next never offers a checkpoint; its dependent is offered once it releases", async () => {
    const dir = await project();
    const cp = await newCheckpoint(dir);
    const dep = await newTicket(dir, [cp.id]);
    let state = await stateOf(dir);
    const single = nextTicket(state);
    expect(single.kind).toBe("all_blocked");
    const many = nextTickets(state, 5);
    expect(many.kind === "found" ? many.candidates.map((c) => c.ticket.id) : []).not.toContain(cp.id);

    await resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "yes", actor: ACTOR });
    state = await stateOf(dir);
    const found = nextTicket(state);
    expect(found.kind === "found" && found.ticket.id).toBe(dep);
  });
});

describe("phase derivation", () => {
  it("a retired checkpoint never holds its phase open: the next phase's ticket is offered", async () => {
    const dir = await project();
    const roadmapPath = join(dir, ".story", "roadmap.json");
    const roadmap = JSON.parse(await readFile(roadmapPath, "utf-8"));
    roadmap.phases.push({ id: "p1", label: "P1", name: "Phase 1", description: "Second phase" });
    await writeFile(roadmapPath, JSON.stringify(roadmap, null, 2) + "\n");

    const cp = await newCheckpoint(dir);
    const done = await newTicket(dir, [], "Done in phase 0");
    await handleTicketUpdate(done, { status: "complete" }, "json", dir);
    await retireCheckpoint(dir, cp.id, expectedOf(cp), "dropped", ACTOR);
    const out = await handleTicketCreate({ title: "Phase 1 work", type: "task", phase: "p1", description: "", blockedBy: [], parentTicket: null }, "json", dir);
    const next = JSON.parse(out.output).data.id as string;

    const state = await stateOf(dir);
    expect(state.ticketByID(cp.id)!.status).toBe("open");
    expect(state.phaseStatus("p0")).toBe("complete");
    // The counts derive the same way: a retired checkpoint is done, though its status is open.
    expect(state.completeLeafTicketCount).toBe(2);
    expect(state.completeTicketCount).toBe(2);
    expect(state.openTicketCount).toBe(1);
    const found = nextTicket(state);
    expect(found.kind === "found" && found.ticket.id).toBe(next);
  });

  it("a pending checkpoint keeps its phase open, and a stale stored complete does not count", async () => {
    const dir = await project();
    const pending = await newCheckpoint(dir);
    const stale = await newCheckpoint(dir);
    await resolveCheckpoint(dir, stale.id, expectedOf(stale), { response: "yes", actor: ACTOR });
    await rewrite(dir, stale.id, (raw) => { (raw.ownerCheckpoint as Record<string, unknown>).question = "Edited by hand"; });
    let state = await stateOf(dir);
    expect(state.phaseStatus("p0")).not.toBe("complete");
    // A stale stored complete is not complete in the counts either.
    expect(state.ticketByID(stale.id)!.status).toBe("complete");
    expect(state.completeLeafTicketCount).toBe(0);
    expect(state.completeTicketCount).toBe(0);
    expect(state.openTicketCount).toBe(2);
    await retireCheckpoint(dir, pending.id, expectedOf(pending), "dropped", ACTOR);
    state = await stateOf(dir);
    expect(state.phaseStatus("p0")).not.toBe("complete");
  });
});

describe("eligibility", () => {
  it("returns a typed result and never throws", async () => {
    const dir = await project();
    const cp = await newCheckpoint(dir);
    const dep = await newTicket(dir, [cp.id]);
    const free = await newTicket(dir, [], "Free");
    const state = await stateOf(dir);
    const self = assertCheckpointEligible(state, state.ticketByID(cp.id)!, "start");
    expect(self).toEqual({ kind: "is-checkpoint" });
    const waiting = assertCheckpointEligible(state, state.ticketByID(dep)!, "claim");
    expect(waiting).toEqual({ kind: "checkpoint-blocked", checkpoints: [cp.id] });
    expect(assertCheckpointEligible(state, state.ticketByID(free)!, "complete")).toEqual({ kind: "eligible" });
    if (waiting.kind !== "eligible") {
      expect(describeIneligible(state, state.ticketByID(dep)!, "claim", waiting)).toMatch(new RegExp(`Cannot claim .*waits on owner checkpoint ${cp.id}`));
    }
  });

  it("ticket start refuses a checkpoint and a ticket waiting on one, writing nothing", async () => {
    const dir = await project();
    const cp = await newCheckpoint(dir);
    const dep = await newTicket(dir, [cp.id]);
    for (const id of [cp.id, dep]) {
      const path = join(dir, ".story", "tickets", `${id}.json`);
      const before = await readFile(path, "utf-8");
      await expect(handleTicketStart(id, "json", dir)).rejects.toThrow(/Cannot start/);
      expect(await readFile(path, "utf-8")).toBe(before);
    }
    await resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "yes", actor: ACTOR });
    await handleTicketStart(dep, "json", dir);
    expect((await stateOf(dir)).ticketByID(dep)!.status).toBe("inprogress");
  });
});

describe("recommend", () => {
  it("a pending checkpoint and its dependent are owner-gated, never recommended as work", async () => {
    const dir = await project();
    const cp = await newCheckpoint(dir);
    const dep = await newTicket(dir, [cp.id]);
    const result = recommend(await stateOf(dir), 10);
    const ids = result.recommendations.map((r) => r.id);
    expect(ids).not.toContain(cp.id);
    expect(ids).not.toContain(dep);
    const excluded = new Map(result.excluded.map((e) => [e.id, e.actionability]));
    // The open, unblocked checkpoint is a candidate, so it must surface as excluded;
    // the dependent may be filtered earlier as blocked, which is also correct.
    expect(excluded.get(cp.id)?.status).toBe("owner_gated");
    for (const [id, reason] of [[cp.id, /awaiting the owner's answer/], [dep, new RegExp(`waits on owner checkpoint ${cp.id}`)]] as const) {
      const verdict = excluded.get(id);
      if (verdict) {
        expect(verdict.status).toBe("owner_gated");
        expect(verdict.reason).toMatch(reason);
      }
    }
  });

  it("a completed dependent whose checkpoint changed shows a reassessment line until it is re-completed", async () => {
    const dir = await project();
    const cp = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "yes", actor: ACTOR });
    const dep = await newTicket(dir, [cp.id]);
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    expect(recommend(await stateOf(dir), 10).recommendations.map((r) => r.category)).not.toContain("checkpoint_reassess");

    const changed = await changeCheckpoint(dir, cp.id, expectedOf(ticket), { ...DECISION, question: "Ship it in October?" }, ACTOR);
    const flagged = recommend(await stateOf(dir), 10).recommendations.find((r) => r.category === "checkpoint_reassess");
    expect(flagged).toMatchObject({ id: `checkpoint-reassess:${dep}`, kind: "action" });
    expect(flagged!.title).toContain(cp.id);

    await resolveCheckpoint(dir, cp.id, expectedOf(changed), { response: "yes, October", actor: ACTOR });
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    expect(recommend(await stateOf(dir), 10).recommendations.map((r) => r.category)).not.toContain("checkpoint_reassess");
  });
});
