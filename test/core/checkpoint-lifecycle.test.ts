/**
 * T-537 S2: the checkpoint lifecycle handlers, the write-layer guard, the
 * deletion refusal, the two evidence writers and the resolve-with-ruling
 * transaction. RED at 09e7dade: none of core/checkpoint-guard.ts,
 * core/checkpoint-lifecycle.ts or core/checkpoint-evidence.ts exists there,
 * and prepareTicketWrite takes no authority.
 *
 * HOME and git's global config point at a scratch directory for the whole
 * file, so no handler reads the real ones.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject, writeTicket, deleteTicket, withProjectLock, prepareTicketWrite, serializeJSON } from "../../src/core/project-loader.js";
import {
  attachCheckpoint,
  changeCheckpoint,
  createCheckpoint,
  nextCounter,
  reopenCheckpoint,
  resolveCheckpoint,
  retireCheckpoint,
  type ExpectedCheckpoint,
} from "../../src/core/checkpoint-lifecycle.js";
import {
  COMPLETION_EVIDENCE_AUTHORITY,
  CONFLICT_EVIDENCE_AUTHORITY,
  LIFECYCLE_AUTHORITY,
  assertCheckpointWriteAllowed,
  priorForGuard,
} from "../../src/core/checkpoint-guard.js";
import { adoptConflictEvidence, completeDependent } from "../../src/core/checkpoint-evidence.js";
import {
  MAX_CHECKPOINT_COUNTER,
  checkpointApproved,
  checkpointDigest,
  checkpointRetired,
  parseOwnerCheckpoint,
  reassessCheckpoints,
  type OwnerCheckpoint,
} from "../../src/core/owner-checkpoint.js";
import {
  handleTicketCreate,
  handleTicketDelete,
  handleTicketMetaSet,
  handleTicketMetaUnset,
  handleTicketStart,
  handleTicketUpdate,
} from "../../src/cli/commands/ticket.js";
import { CHECKPOINT_SCHEMA_VERSION, ProjectLoaderError } from "../../src/core/errors.js";
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

// Checkpoints need an enabled project (config schemaVersion 4). `checkpoint
// enable` is S4's; until then the fixture stamps the version the way it would.
async function project(team = false, enabled = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t537-s2-"));
  dirs.push(dir);
  await initProject(dir, { name: "t537" });
  if (team || enabled) {
    const path = join(dir, ".story", "config.json");
    const config = JSON.parse(await readFile(path, "utf-8"));
    if (team) config.team = { ...(config.team ?? {}), enabled: true };
    if (enabled) config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return dir;
}

async function ticketOnDisk(dir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8"));
}

async function stateOf(dir: string) {
  return (await loadProject(dir)).state;
}

function checkpointOf(t: object): OwnerCheckpoint {
  const p = parseOwnerCheckpoint(t);
  if (p.kind !== "ok") throw new Error(`not a readable checkpoint: ${p.kind}`);
  return p.checkpoint;
}

const expectedOf = (t: object): ExpectedCheckpoint => {
  const cp = checkpointOf(t);
  return { generation: cp.generation, revision: cp.revision, digest: cp.digest };
};

const EARMARK = { stage: "reserved", reservedBy: { client: "claude", id: "task-1" }, arrangementId: "a-0123456789abcdef", since: "2026-08-28T00:00:00.000Z", holderRole: "worker", holderSession: null };
const DECISION = { kind: "decision" as const, question: "Ship the new onboarding?", evidenceRefs: ["plan.md"] };
const ACCEPTANCE = { kind: "acceptance" as const, criteria: "Screens match the mock", evidenceRefs: [] };

async function newCheckpoint(dir: string, content: typeof DECISION | typeof ACCEPTANCE = DECISION): Promise<Ticket> {
  return createCheckpoint(dir, { title: "Owner decision", description: "", phase: "p0", owner: "owner", content, actor: ACTOR });
}

async function newDependent(dir: string, blockedBy: string[]): Promise<string> {
  const out = await handleTicketCreate({ title: "Dependent", type: "task", phase: "p0", description: "", blockedBy, parentTicket: null }, "json", dir);
  return JSON.parse(out.output).data.id as string;
}

async function rulingFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, ".story", "rulings"))).filter((f) => f.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function rejects(p: Promise<unknown>, match: RegExp): Promise<void> {
  await expect(p).rejects.toThrow(match);
}

describe("create and attach", () => {
  it("create writes an open ticket with a fresh active record and a created event", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const raw = await ticketOnDisk(dir, t.id);
    expect(raw.status).toBe("open");
    const cp = checkpointOf(raw);
    expect(cp).toMatchObject({ kind: "decision", owner: "owner", lifecycle: "active", revision: 1, generation: 1, evidenceRefs: ["plan.md"] });
    expect(cp.digest).toBe(checkpointDigest(cp));
    expect(cp.resolution).toBeUndefined();
    expect(cp.history).toHaveLength(1);
    expect(cp.history[0]).toMatchObject({ event: "created", by: ACTOR, generation: 1, revision: 1, digest: cp.digest, question: DECISION.question });
  });

  it("create refuses a decision without a question and an acceptance without criteria", async () => {
    const dir = await project();
    await rejects(createCheckpoint(dir, { title: "x", description: "", phase: "p0", owner: "o", content: { kind: "decision", evidenceRefs: [] }, actor: ACTOR }), /needs a question/);
    await rejects(createCheckpoint(dir, { title: "x", description: "", phase: "p0", owner: "o", content: { kind: "acceptance", evidenceRefs: [] }, actor: ACTOR }), /needs criteria/);
  });

  it("create and change refuse U+FFFD and a lone surrogate, naming the fix", async () => {
    const dir = await project();
    for (const bad of ["a\uFFFD", "b\uD800"]) {
      await rejects(
        createCheckpoint(dir, { title: "x", description: "", phase: "p0", owner: "o", content: { kind: "decision", question: bad, evidenceRefs: [] }, actor: ACTOR }),
        /U\+FFFD \(the replacement character\).*replace it with the character you meant/,
      );
    }
    const t = await newCheckpoint(dir);
    await rejects(changeCheckpoint(dir, t.id, expectedOf(t), { ...DECISION, evidenceRefs: ["x\uFFFD"] }, ACTOR), /evidenceRefs\[0\] holds a lone UTF-16 surrogate or U\+FFFD/);
  });

  it("attach makes an open, unclaimed ticket a checkpoint", async () => {
    const dir = await project();
    const id = await newDependent(dir, []);
    const t = await attachCheckpoint(dir, id, { owner: "owner", content: DECISION, actor: ACTOR });
    expect(checkpointOf(await ticketOnDisk(dir, t.id)).history[0]!.event).toBe("created");
  });

  it("attach refuses a checkpoint, a non-open ticket and a claimed or earmarked one", async () => {
    const dir = await project();
    const cp = await newCheckpoint(dir);
    await rejects(attachCheckpoint(dir, cp.id, { owner: "o", content: DECISION, actor: ACTOR }), /already an owner checkpoint/);

    const done = await newDependent(dir, []);
    await handleTicketUpdate(done, { status: "complete" }, "json", dir);
    await rejects(attachCheckpoint(dir, done, { owner: "o", content: DECISION, actor: ACTOR }), /it is complete, not open/);

    for (const extra of [{ claimedBySession: "s-1" }, { earmark: EARMARK }]) {
      const id = await newDependent(dir, []);
      const raw = await ticketOnDisk(dir, id);
      await writeFile(join(dir, ".story", "tickets", `${id}.json`), JSON.stringify({ ...raw, ...extra }, null, 2));
      await rejects(attachCheckpoint(dir, id, { owner: "o", content: DECISION, actor: ACTOR }), /claimed or earmarked/);
    }
  });
});

async function ledgerSnapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = join(rel, e.name);
      if (e.isDirectory()) await walk(child);
      else out[child] = await readFile(join(dir, child), "utf-8");
    }
  };
  await walk(".story");
  return out;
}

describe("enablement", () => {
  it("create and attach on a project checkpoint enable has not stamped leave config and ledger unchanged", async () => {
    const dir = await project(false, false);
    const id = await newDependent(dir, []);
    const before = await ledgerSnapshot(dir);
    await rejects(newCheckpoint(dir), /Owner checkpoints are not enabled in this project \(config schemaVersion \d+, needs 4\)/);
    await rejects(attachCheckpoint(dir, id, { owner: "owner", content: DECISION, actor: ACTOR }), /not enabled in this project/);
    expect(await ledgerSnapshot(dir)).toEqual(before);
  });

  it("every lifecycle mutation refuses once the project is below the checkpoint schema", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const path = join(dir, ".story", "config.json");
    const config = JSON.parse(await readFile(path, "utf-8"));
    config.schemaVersion = 3;
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
    const before = await ledgerSnapshot(dir);
    const e = expectedOf(t);
    await rejects(resolveCheckpoint(dir, t.id, e, { response: "yes", actor: ACTOR }), /not enabled/);
    await rejects(changeCheckpoint(dir, t.id, e, { ...DECISION, question: "other" }, ACTOR), /not enabled/);
    await rejects(reopenCheckpoint(dir, t.id, e, ACTOR), /not enabled/);
    await rejects(retireCheckpoint(dir, t.id, e, "r", ACTOR), /not enabled/);
    expect(await ledgerSnapshot(dir)).toEqual(before);
  });
});

describe("resolve", () => {
  it("approves at the current revision, completes the ticket and records the answer", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "Yes, ship it", actor: ACTOR });
    const raw = await ticketOnDisk(dir, ticket.id);
    expect(raw.status).toBe("complete");
    expect(raw.completedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const cp = checkpointOf(raw);
    expect(cp.generation).toBe(2);
    expect(cp.resolution).toMatchObject({ response: "Yes, ship it", respondedBy: ACTOR, generation: 2, revision: 1, digest: cp.digest });
    expect(cp.history[1]).toMatchObject({ event: "resolved", generation: 2, revision: 1 });
    expect(cp.history.map((h) => h.event)).toEqual(["created", "resolved"]);
    expect(cp.history[1]!.resolution).toEqual(cp.resolution);
    expect(checkpointApproved(raw as Ticket)).toBe(true);
  });

  it("refuses a stale expectation on each of generation, revision and digest", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const e = expectedOf(t);
    for (const stale of [{ ...e, generation: 2 }, { ...e, revision: 2 }, { ...e, digest: "0".repeat(64) }]) {
      await rejects(resolveCheckpoint(dir, t.id, stale, { response: "yes", actor: ACTOR }), /changed since you read it/);
    }
    expect((await ticketOnDisk(dir, t.id)).status).toBe("open");
  });

  it("needs a response, and an artifact for an acceptance", async () => {
    const dir = await project();
    const d = await newCheckpoint(dir);
    await rejects(resolveCheckpoint(dir, d.id, expectedOf(d), { response: "  ", actor: ACTOR }), /explicit response/);
    const a = await newCheckpoint(dir, ACCEPTANCE);
    await rejects(resolveCheckpoint(dir, a.id, expectedOf(a), { response: "looks right", actor: ACTOR }), /name the reviewed artifact/);
    const { ticket } = await resolveCheckpoint(dir, a.id, expectedOf(a), { response: "looks right", artifactRef: "build 42", actor: ACTOR });
    expect(checkpointApproved(ticket)).toBe(true);
  });

  it("refuses an already approved checkpoint and a stored digest that does not match the content", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    await rejects(resolveCheckpoint(dir, t.id, expectedOf(ticket), { response: "again", actor: ACTOR }), /already approved/);

    const u = await newCheckpoint(dir);
    const raw = await ticketOnDisk(dir, u.id);
    (raw.ownerCheckpoint as Record<string, unknown>).question = "edited by hand";
    await writeFile(join(dir, ".story", "tickets", `${u.id}.json`), JSON.stringify(raw, null, 2));
    await rejects(resolveCheckpoint(dir, u.id, expectedOf(raw), { response: "yes", actor: ACTOR }), /stored digest does not match/);
  });

  it("with a ruling, commits the ruling and the approval together and names the ruling", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const out = await resolveCheckpoint(dir, t.id, expectedOf(t), {
      response: "Yes",
      actor: ACTOR,
      ruling: { text: "Onboarding ships", attribution: "owner-direct", date: "2026-09-27", scopeTags: ["onboarding"], clientTaskId: "t537-test" },
    });
    expect(out.rulingId).toMatch(/^r-/);
    expect(checkpointOf(await ticketOnDisk(dir, t.id)).resolution!.rulingId).toBe(out.rulingId);
    expect(await rulingFiles(dir)).toEqual([`${out.rulingId}.json`]);
    await expect(readFile(join(dir, ".story", ".txn.json"))).rejects.toThrow();
  });

  it("with a stale expectation, writes neither the ruling nor the approval", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await rejects(resolveCheckpoint(dir, t.id, { ...expectedOf(t), revision: 9 }, {
      response: "Yes",
      actor: ACTOR,
      ruling: { text: "x", attribution: "owner-direct", date: "2026-09-27", scopeTags: [], clientTaskId: "t537-test" },
    }), /changed since you read it/);
    expect(await rulingFiles(dir)).toEqual([]);
    expect(checkpointOf(await ticketOnDisk(dir, t.id)).resolution).toBeUndefined();
  });
});

describe("change, reopen, retire", () => {
  it("change advances the revision, recomputes the digest, keeps the old answer in history and reopens", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    const before = checkpointOf(ticket);
    const changed = await changeCheckpoint(dir, t.id, expectedOf(ticket), { ...DECISION, question: "Ship it in October?" }, ACTOR);
    const raw = await ticketOnDisk(dir, changed.id);
    const cp = checkpointOf(raw);
    expect(cp.revision).toBe(2);
    expect(cp.generation).toBe(3);
    expect(cp.question).toBe("Ship it in October?");
    expect(cp.digest).toBe(checkpointDigest(cp));
    expect(cp.digest).not.toBe(before.digest);
    expect(cp.resolution).toBeUndefined();
    expect(raw.status).toBe("open");
    expect(raw.completedDate).toBeNull();
    const last = cp.history.at(-1)!;
    expect(last).toMatchObject({ event: "changed", generation: 3, revision: 2, digest: cp.digest, question: "Ship it in October?" });
    expect(cp.history.at(-2)).toMatchObject({ event: "resolved", revision: 1, digest: before.digest, question: DECISION.question });
    expect(last.resolution).toEqual(before.resolution);
  });

  it("a history snapshot keeps the kind, so the original digest is reconstructible after a kind change", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const before = checkpointOf(t);
    const changed = await changeCheckpoint(dir, t.id, expectedOf(t), ACCEPTANCE, ACTOR);
    const cp = checkpointOf(await ticketOnDisk(dir, changed.id));
    expect(cp.kind).toBe("acceptance");
    const created = cp.history[0]!;
    expect(created).toMatchObject({ event: "created", kind: "decision" });
    const rebuilt = checkpointDigest({ kind: created.kind, question: created.question, criteria: created.criteria, evidenceRefs: created.evidenceRefs });
    expect(rebuilt).toBe(before.digest);
    expect(rebuilt).toBe(created.digest);
    expect(cp.history.at(-1)).toMatchObject({ event: "changed", kind: "acceptance", digest: cp.digest });
  });

  it("change refuses unchanged content", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await rejects(changeCheckpoint(dir, t.id, expectedOf(t), DECISION, ACTOR), /content is unchanged/);
  });

  it("change refuses to advance a revision already at MAX_SAFE_INTEGER", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const raw = await ticketOnDisk(dir, t.id);
    const cp = raw.ownerCheckpoint as Record<string, unknown>;
    cp.revision = MAX_CHECKPOINT_COUNTER;
    await writeFile(join(dir, ".story", "tickets", `${t.id}.json`), JSON.stringify(raw, null, 2));
    await rejects(changeCheckpoint(dir, t.id, expectedOf(raw), { ...DECISION, question: "other" }, ACTOR), /past 9007199254740991/);
    expect((await ticketOnDisk(dir, t.id)).ownerCheckpoint).toEqual(cp);
  });

  it("resolve, reopen and retire refuse to advance a generation already at MAX_SAFE_INTEGER", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    const path = join(dir, ".story", "tickets", `${t.id}.json`);
    const atMax = async (resolved: boolean) => {
      const raw = await ticketOnDisk(dir, t.id);
      const cp = raw.ownerCheckpoint as Record<string, unknown>;
      cp.generation = MAX_CHECKPOINT_COUNTER;
      if (resolved) (cp.resolution as Record<string, unknown>).generation = MAX_CHECKPOINT_COUNTER;
      await writeFile(path, JSON.stringify(raw, null, 2));
      return raw;
    };
    let raw = await atMax(true);
    await rejects(reopenCheckpoint(dir, t.id, expectedOf(raw), ACTOR), /generation past 9007199254740991/);
    await rejects(retireCheckpoint(dir, t.id, expectedOf(raw), "r", ACTOR), /generation past 9007199254740991/);
    expect(await ticketOnDisk(dir, t.id)).toEqual(raw);
    const plain = { ...raw, status: "open", completedDate: null, ownerCheckpoint: { ...(raw.ownerCheckpoint as object), resolution: undefined } };
    await writeFile(path, JSON.stringify(plain, null, 2));
    raw = await ticketOnDisk(dir, t.id);
    await rejects(resolveCheckpoint(dir, t.id, expectedOf(raw), { response: "yes", actor: ACTOR }), /generation past 9007199254740991/);
    expect(await ticketOnDisk(dir, t.id)).toEqual(raw);
    expect(checkpointOf(ticket).generation).toBe(2);
  });

  it("nextCounter advances below the limit and refuses at it or on a non-integer", () => {
    expect(nextCounter(1, "revision")).toBe(2);
    expect(nextCounter(MAX_CHECKPOINT_COUNTER - 1, "generation")).toBe(MAX_CHECKPOINT_COUNTER);
    for (const bad of [MAX_CHECKPOINT_COUNTER, MAX_CHECKPOINT_COUNTER + 2, 1.5, Number.NaN]) {
      expect(() => nextCounter(bad, "generation")).toThrow(/Cannot advance the checkpoint generation/);
    }
  });

  it("reopen moves the answer into history and reopens; without an answer it is refused", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await rejects(reopenCheckpoint(dir, t.id, expectedOf(t), ACTOR), /no answer to reopen/);
    const { ticket } = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    const reopened = await reopenCheckpoint(dir, t.id, expectedOf(ticket), ACTOR, "new facts");
    const raw = await ticketOnDisk(dir, reopened.id);
    const cp = checkpointOf(raw);
    expect(raw.status).toBe("open");
    expect(cp.resolution).toBeUndefined();
    expect(cp.generation).toBe(3);
    expect(cp.history.at(-1)).toMatchObject({ event: "reopened", reason: "new facts", generation: 3 });
    expect(cp.history.at(-1)!.resolution).toEqual(checkpointOf(ticket).resolution);
    expect(checkpointApproved(raw as Ticket)).toBe(false);
  });

  it("retire needs a reason, keeps the status, releases, and is final", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await rejects(retireCheckpoint(dir, t.id, expectedOf(t), " ", ACTOR), /needs a reason/);
    const retired = await retireCheckpoint(dir, t.id, expectedOf(t), "no longer relevant", ACTOR);
    const raw = await ticketOnDisk(dir, retired.id);
    const cp = checkpointOf(raw);
    expect(raw.status).toBe("open");
    expect(cp.lifecycle).toBe("retired");
    expect(cp.retiredAt).toBeTruthy();
    expect(cp.generation).toBe(2);
    expect(cp.history.at(-1)).toMatchObject({ event: "retired", reason: "no longer relevant", generation: 2 });
    expect(checkpointRetired(raw as Ticket)).toBe(true);
    const e = expectedOf(raw);
    await rejects(resolveCheckpoint(dir, t.id, e, { response: "yes", actor: ACTOR }), /checkpoint is retired/);
    await rejects(changeCheckpoint(dir, t.id, e, { ...DECISION, question: "q2" }, ACTOR), /checkpoint is retired/);
    await rejects(retireCheckpoint(dir, t.id, e, "again", ACTOR), /checkpoint is retired/);
  });

  it("every handler refuses an unrecognized checkpoint and a ticket that is not one", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const e = expectedOf(t);
    const raw = await ticketOnDisk(dir, t.id);
    await writeFile(join(dir, ".story", "tickets", `${t.id}.json`), JSON.stringify({ ...raw, ownerCheckpoint: null }, null, 2));
    await rejects(resolveCheckpoint(dir, t.id, e, { response: "yes", actor: ACTOR }), /cannot read/);
    await rejects(retireCheckpoint(dir, t.id, e, "r", ACTOR), /cannot read/);
    const plain = await newDependent(dir, []);
    await rejects(reopenCheckpoint(dir, plain, e, ACTOR), /is not an owner checkpoint/);
  });
});

describe("the write guard", () => {
  it("refuses a status change on a checkpoint through the ordinary update", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await rejects(handleTicketUpdate(t.id, { status: "complete" }, "json", dir), /is an owner checkpoint: status, completedDate change only through the checkpoint commands/);
    expect((await ticketOnDisk(dir, t.id)).status).toBe("open");
  });

  it("lets an ordinary edit of a checkpoint through", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await handleTicketUpdate(t.id, { title: "Renamed decision" }, "json", dir);
    expect((await ticketOnDisk(dir, t.id)).title).toBe("Renamed decision");
  });

  it("refuses to start a checkpoint", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await rejects(handleTicketStart(t.id, "json", dir), /owner checkpoint/);
    expect((await ticketOnDisk(dir, t.id)).status).toBe("open");
  });

  it("refuses meta set and unset on both protected fields", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await rejects(handleTicketMetaSet(t.id, "ownerCheckpoint", null, "json", dir), /protected core field "ownerCheckpoint"/);
    await rejects(handleTicketMetaSet(t.id, "ownerCheckpoint.lifecycle", "retired", "json", dir), /protected core field "ownerCheckpoint"/);
    await rejects(handleTicketMetaUnset(t.id, "ownerCheckpoint", "json", dir), /protected core field "ownerCheckpoint"/);
    await rejects(handleTicketMetaSet(t.id, "checkpointEvidence", [], "json", dir), /protected core field "checkpointEvidence"/);
  });

  it("refuses, at the writer, removing the record, nulling it, retiring it or changing its content", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const raw = await ticketOnDisk(dir, t.id) as unknown as Ticket;
    const cp = checkpointOf(raw);
    const { ownerCheckpoint: _removed, ...without } = raw as Record<string, unknown>;
    for (const next of [
      without,
      { ...raw, ownerCheckpoint: null },
      { ...raw, ownerCheckpoint: { ...cp, lifecycle: "retired", retiredAt: "2026-09-27T00:00:00Z" } },
      { ...raw, ownerCheckpoint: { ...cp, question: "other" } },
      { ...raw, lifecycle: "archived" },
    ]) {
      await expect(writeTicket(next as Ticket, dir)).rejects.toBeInstanceOf(ProjectLoaderError);
    }
    expect(await ticketOnDisk(dir, t.id)).toEqual(raw);
  });

  it("refuses, at the writer, adding a record to an ordinary ticket without authority", async () => {
    const dir = await project();
    const id = await newDependent(dir, []);
    const raw = await ticketOnDisk(dir, id);
    const cp = checkpointOf(await newCheckpoint(dir));
    await rejects(writeTicket({ ...raw, ownerCheckpoint: cp } as unknown as Ticket, dir), /is an owner checkpoint: ownerCheckpoint/);
  });

  it("refuses claim, earmark, session claim and inprogress on a checkpoint even with lifecycle authority", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const raw = await ticketOnDisk(dir, t.id);
    for (const extra of [
      { status: "inprogress" },
      { claim: { user: "u", branch: "b", since: "2026-09-27T00:00:00Z" } },
      { claimedBySession: "s-1" },
      { earmark: EARMARK },
    ]) {
      expect(() => assertCheckpointWriteAllowed(raw, { ...raw, ...extra }, LIFECYCLE_AUTHORITY)).toThrow(/cannot be started, claimed or earmarked/);
    }
    // Removing a claim is cleanup, not work.
    expect(() => assertCheckpointWriteAllowed({ ...raw, claimedBySession: "s-1" }, raw)).not.toThrow();
  });

  it("refuses a checkpointEvidence change on any ticket without an evidence authority", async () => {
    const dir = await project();
    const id = await newDependent(dir, []);
    const raw = await ticketOnDisk(dir, id);
    const evidence = [{ checkpoint: "T-009", generation: 1, revision: 1, digest: "0".repeat(64), state: "approved" }];
    await rejects(writeTicket({ ...raw, checkpointEvidence: evidence } as unknown as Ticket, dir), /checkpointEvidence is written only when the ticket completes/);
    expect(() => assertCheckpointWriteAllowed(raw, { ...raw, checkpointEvidence: evidence }, LIFECYCLE_AUTHORITY)).toThrow(/checkpointEvidence/);
    expect(() => assertCheckpointWriteAllowed(raw, { ...raw, checkpointEvidence: evidence }, COMPLETION_EVIDENCE_AUTHORITY)).not.toThrow();
    expect(() => assertCheckpointWriteAllowed(raw, { ...raw, checkpointEvidence: evidence }, CONFLICT_EVIDENCE_AUTHORITY)).not.toThrow();
    // Evidence authority does not cover the lifecycle.
    const cpRaw = await ticketOnDisk(dir, (await newCheckpoint(dir)).id);
    expect(() => assertCheckpointWriteAllowed(cpRaw, { ...cpRaw, status: "complete" }, COMPLETION_EVIDENCE_AUTHORITY)).toThrow(/owner checkpoint/);
  });

  it("treats key order as no change; only a missing prior is absent, anything unparseable refuses", () => {
    const a = { id: "T-001", status: "open", checkpointEvidence: [{ state: "approved", checkpoint: "T-002" }] };
    const b = { status: "open", id: "T-001", checkpointEvidence: [{ checkpoint: "T-002", state: "approved" }] };
    expect(() => assertCheckpointWriteAllowed(a, b)).not.toThrow();
    expect(priorForGuard(null, "x")).toBeNull();
    // An escaped protected key in truncated JSON hides from any substring search.
    const escaped = String.raw`{"id":"T-001","\u006fwnerCheckpoint":{"kind":"decision"`;
    expect(escaped.includes("ownerCheckpoint")).toBe(false);
    for (const text of ["{not json", "", escaped, "[]", "null", "3", '"text"']) {
      expect(() => priorForGuard(text, "tickets/T-001.json"), text).toThrow(/does not parse as a ticket object/);
    }
  });

  it("an ordinary write over an unparseable ticket file is refused and leaves the file as it was", async () => {
    const dir = await project();
    const id = await newDependent(dir, []);
    const ticket = await ticketOnDisk(dir, id);
    const path = join(dir, ".story", "tickets", `${id}.json`);
    const corrupt = String.raw`{"id":"` + id + String.raw`","\u006fwnerCheckpoint":{"kind":"decision","owner":"o"`;
    await writeFile(path, corrupt);
    await rejects(writeTicket({ ...ticket, title: "overwrite" } as unknown as Ticket, dir), /does not parse as a ticket object/);
    expect(await readFile(path, "utf-8")).toBe(corrupt);
    for (const options of [undefined, { hard: true }, { force: true }]) {
      await rejects(deleteTicket(id, dir, options), /does not parse as a ticket object.*storybloq repair/);
    }
    expect(await readFile(path, "utf-8")).toBe(corrupt);
  });

  it("the prepared transaction write runs the guard too", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const raw = await ticketOnDisk(dir, t.id);
    await withProjectLock(dir, { strict: true }, async () => {
      await expect(prepareTicketWrite({ ...raw, status: "complete" } as unknown as Ticket, dir)).rejects.toThrow(/owner checkpoint/);
    });
  });
});

describe("deletion", () => {
  it("refuses soft, hard and forced deletion of a checkpoint, in both modes", async () => {
    for (const team of [false, true]) {
      const dir = await project(team);
      const t = await newCheckpoint(dir);
      for (const options of [{}, { hard: true }, { force: true }, { force: true, hard: true }]) {
        await rejects(deleteTicket(t.id, dir, options), /it is an owner checkpoint.*retire it instead/);
      }
      await rejects(handleTicketDelete(t.id, true, "json", dir, true), /owner checkpoint/);
      const raw = await ticketOnDisk(dir, t.id);
      expect(raw.lifecycle).toBeUndefined();
      expect(checkpointOf(raw).lifecycle).toBe("active");
    }
  });

  it("refuses deleting a retired checkpoint too", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await retireCheckpoint(dir, t.id, expectedOf(t), "done", ACTOR);
    await rejects(deleteTicket(t.id, dir, { force: true }), /owner checkpoint/);
  });

  it("still deletes an ordinary ticket", async () => {
    const dir = await project();
    const id = await newDependent(dir, []);
    await deleteTicket(id, dir);
    await expect(readFile(join(dir, ".story", "tickets", `${id}.json`))).rejects.toThrow();
  });
});

describe("completion evidence", () => {
  it("a dependent cannot complete while its checkpoint is pending, and nothing is written", async () => {
    const dir = await project();
    const cp = await newCheckpoint(dir);
    const dep = await newDependent(dir, [cp.id]);
    const before = await ticketOnDisk(dir, dep);
    await rejects(handleTicketUpdate(dep, { status: "complete" }, "json", dir), new RegExp(`waits on owner checkpoint ${cp.id}`));
    expect(await ticketOnDisk(dir, dep)).toEqual(before);
  });

  it("after approval, completion records approved evidence at the current version (row 2a)", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    const dep = await newDependent(dir, [t.id]);
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    const raw = await ticketOnDisk(dir, dep);
    const cp = checkpointOf(ticket);
    expect(raw.checkpointEvidence).toEqual([{ checkpoint: t.id, generation: cp.generation, revision: cp.revision, digest: cp.digest, state: "approved" }]);
    const state = await stateOf(dir);
    expect(reassessCheckpoints(state, state.ticketByID(dep)!)).toEqual([{ checkpoint: t.id, row: "2a", flag: false }]);
  });

  it("after retirement, completion records retired evidence at the current generation (row 2b)", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await retireCheckpoint(dir, t.id, expectedOf(t), "dropped", ACTOR);
    const dep = await newDependent(dir, [t.id]);
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    expect((await ticketOnDisk(dir, dep)).checkpointEvidence).toEqual([expect.objectContaining({ checkpoint: t.id, generation: 2, state: "retired" })]);
    const state = await stateOf(dir);
    expect(reassessCheckpoints(state, state.ticketByID(dep)!)).toEqual([{ checkpoint: t.id, row: "2b", flag: false }]);
  });

  it("a change after completion flags the dependent (row 2c); an explicit re-completion through ticket update clears it", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    const dep = await newDependent(dir, [t.id]);
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    const changed = await changeCheckpoint(dir, t.id, expectedOf(ticket), { ...DECISION, question: "q2" }, ACTOR);
    let state = await stateOf(dir);
    expect(reassessCheckpoints(state, state.ticketByID(dep)!)).toEqual([{ checkpoint: t.id, row: "2c", flag: true }]);

    // While the changed checkpoint is pending, re-completion is refused and writes nothing.
    const pending = await ticketOnDisk(dir, dep);
    await rejects(handleTicketUpdate(dep, { status: "complete" }, "json", dir), new RegExp(`waits on owner checkpoint ${t.id}`));
    expect(await ticketOnDisk(dir, dep)).toEqual(pending);

    const again = await resolveCheckpoint(dir, t.id, expectedOf(changed), { response: "yes to q2", actor: ACTOR });
    // An edit that does not name the status does not refresh the evidence.
    await handleTicketUpdate(dep, { title: "Dependent, renamed" }, "json", dir);
    state = await stateOf(dir);
    expect(reassessCheckpoints(state, state.ticketByID(dep)!)).toEqual([{ checkpoint: t.id, row: "2c", flag: true }]);

    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    state = await stateOf(dir);
    expect(reassessCheckpoints(state, state.ticketByID(dep)!)).toEqual([{ checkpoint: t.id, row: "2a", flag: false }]);
    const cp = checkpointOf(again.ticket);
    expect((await ticketOnDisk(dir, dep)).checkpointEvidence).toEqual([{ checkpoint: t.id, generation: cp.generation, revision: 2, digest: cp.digest, state: "approved" }]);

    // With nothing stale, an explicit complete is the no-op it always was.
    const settled = await readFile(join(dir, ".story", "tickets", `${dep}.json`), "utf-8");
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    expect(await readFile(join(dir, ".story", "tickets", `${dep}.json`), "utf-8")).toBe(settled);
  });

  it("completeDependent called directly also re-completes and clears the flag", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const { ticket } = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    const dep = await newDependent(dir, [t.id]);
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    const changed = await changeCheckpoint(dir, t.id, expectedOf(ticket), { ...DECISION, question: "q2" }, ACTOR);
    let state = await stateOf(dir);
    const again = await resolveCheckpoint(dir, t.id, expectedOf(changed), { response: "yes to q2", actor: ACTOR });
    await withProjectLock(dir, { strict: true }, async ({ state: locked }) => {
      const out = await completeDependent(locked, locked.ticketByID(dep)!, dir);
      expect(out.kind).toBe("completed");
    });
    state = await stateOf(dir);
    expect(reassessCheckpoints(state, state.ticketByID(dep)!)).toEqual([{ checkpoint: t.id, row: "2a", flag: false }]);
    expect((await ticketOnDisk(dir, dep)).checkpointEvidence).toEqual([expect.objectContaining({ revision: 2, digest: checkpointOf(again.ticket).digest })]);
  });

  it("complete, reopen and reapprove with unchanged content flags the dependent (row 2c)", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const first = await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    const dep = await newDependent(dir, [t.id]);
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    const reopened = await reopenCheckpoint(dir, t.id, expectedOf(first.ticket), ACTOR);
    const again = await resolveCheckpoint(dir, t.id, expectedOf(reopened), { response: "yes", actor: ACTOR });
    expect(checkpointOf(again.ticket).digest).toBe(checkpointOf(first.ticket).digest);
    expect(checkpointApproved(again.ticket)).toBe(true);
    let state = await stateOf(dir);
    expect(reassessCheckpoints(state, state.ticketByID(dep)!)).toEqual([{ checkpoint: t.id, row: "2c", flag: true }]);

    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    state = await stateOf(dir);
    expect(reassessCheckpoints(state, state.ticketByID(dep)!)).toEqual([{ checkpoint: t.id, row: "2a", flag: false }]);
    const cp = checkpointOf(again.ticket);
    expect((await ticketOnDisk(dir, dep)).checkpointEvidence).toEqual([{ checkpoint: t.id, generation: cp.generation, revision: cp.revision, digest: cp.digest, state: "approved" }]);
  });

  it("an explicit complete with current persisted evidence is a genuine no-op: another session's claim and earmark survive", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    await resolveCheckpoint(dir, t.id, expectedOf(t), { response: "yes", actor: ACTOR });
    const dep = await newDependent(dir, [t.id]);
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    // Evidence on disk is deep-sorted; the comparison must not read that as stale.
    const path = join(dir, ".story", "tickets", `${dep}.json`);
    const done = await ticketOnDisk(dir, dep);
    expect(Array.isArray(done.checkpointEvidence) && (done.checkpointEvidence as unknown[]).length).toBe(1);
    const foreign = {
      ...done,
      claim: { user: "someone-else@example.test", branch: "other", since: "2026-09-27T00:00:00.000Z" },
      claimedBySession: "s-foreign",
      earmark: EARMARK,
    };
    await writeFile(path, serializeJSON(foreign));
    const before = await readFile(path, "utf-8");
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    const after = await ticketOnDisk(dir, dep);
    expect(after.claim).toEqual(foreign.claim);
    expect(after.claimedBySession).toBe("s-foreign");
    expect(after.earmark).toEqual(EARMARK);
    expect(await readFile(path, "utf-8")).toBe(before);
  });

  it("an ordinary completion writes no evidence key", async () => {
    const dir = await project();
    const dep = await newDependent(dir, []);
    await handleTicketUpdate(dep, { status: "complete" }, "json", dir);
    expect(Object.hasOwn(await ticketOnDisk(dir, dep), "checkpointEvidence")).toBe(false);
  });

  it("completeDependent returns the blocked checkpoints without writing, and refuses a non-completion", async () => {
    const dir = await project();
    const t = await newCheckpoint(dir);
    const dep = await newDependent(dir, [t.id]);
    const before = await ticketOnDisk(dir, dep);
    await withProjectLock(dir, { strict: true }, async ({ state }) => {
      const candidate = { ...state.ticketByID(dep)!, status: "complete" as const };
      expect(await completeDependent(state, candidate, dir)).toEqual({ kind: "checkpoint-blocked", checkpoints: [t.id] });
      await expect(completeDependent(state, state.ticketByID(dep)!, dir)).rejects.toThrow(/is not being completed/);
    });
    expect(await ticketOnDisk(dir, dep)).toEqual(before);
  });

  it("adoptConflictEvidence takes the selected side's evidence verbatim, or none", async () => {
    const dir = await project();
    const dep = await newDependent(dir, []);
    const raw = await ticketOnDisk(dir, dep) as unknown as Ticket;
    const side = { checkpointEvidence: [{ checkpoint: "T-777", generation: 3, revision: 2, digest: "a".repeat(64), state: "retired", extra: "kept" }] };
    await withProjectLock(dir, { strict: true }, async () => {
      await adoptConflictEvidence(raw, side, dir);
    });
    expect((await ticketOnDisk(dir, dep)).checkpointEvidence).toEqual(side.checkpointEvidence);
    await withProjectLock(dir, { strict: true }, async () => {
      await adoptConflictEvidence({ ...raw, checkpointEvidence: side.checkpointEvidence } as Ticket, {}, dir);
    });
    expect(Object.hasOwn(await ticketOnDisk(dir, dep), "checkpointEvidence")).toBe(false);
  });
});

describe("authority imports", () => {
  const SRC = join(__dirname, "..", "..", "src");
  const ALLOWED: Record<string, readonly string[]> = {
    LIFECYCLE_AUTHORITY: ["core/checkpoint-guard.ts", "core/checkpoint-lifecycle.ts"],
    CONFLICT_SETTLEMENT_AUTHORITY: ["core/checkpoint-guard.ts", "core/checkpoint-lifecycle.ts"],
    COMPLETION_EVIDENCE_AUTHORITY: ["core/checkpoint-guard.ts", "core/checkpoint-evidence.ts"],
    CONFLICT_EVIDENCE_AUTHORITY: ["core/checkpoint-guard.ts", "core/checkpoint-evidence.ts"],
  };

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  }

  it("each authority symbol is named only by its owning module", () => {
    const seen: Record<string, string[]> = {};
    for (const file of files(SRC)) {
      const text = readFileSync(file, "utf-8");
      for (const name of Object.keys(ALLOWED)) {
        if (new RegExp(`\\b${name}\\b`).test(text)) (seen[name] ??= []).push(relative(SRC, file).split("\\").join("/"));
      }
    }
    for (const [name, allowed] of Object.entries(ALLOWED)) {
      expect((seen[name] ?? []).sort()).toEqual([...allowed].sort());
    }
  });
});
