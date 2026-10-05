/**
 * T-486 U2-2: dependency release. A withdrawn blocker, or a complete umbrella
 * with withdrawn leaf work under it, never releases its dependents; recommend,
 * PICK_TICKET, ticketsUnblockedBy, the blocker list and validate all read the
 * one projection (ProjectState.dependencyRelease).
 *
 * Withdrawals are written raw: before U2-6 every writer refuses a newly
 * effective one (U2-1), which is exactly the old-writer, hand-edit and merge
 * case these readers must handle.
 *
 * Each blocking case has a partner that releases, so a projection that blocks
 * everything fails the partner.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../src/core/init.js";
import { loadProject, serializeJSON } from "../../src/core/project-loader.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../src/core/errors.js";
import { createCheckpoint } from "../../src/core/checkpoint-lifecycle.js";
import { ticketsUnblockedBy } from "../../src/core/queries.js";
import { recommend } from "../../src/core/recommend.js";
import { validateProject } from "../../src/core/validation.js";
import { formatBlockedTickets } from "../../src/core/output-formatter.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { PickTicketStage } from "../../src/autonomous/stages/pick-ticket.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { git } from "../helpers/git-fixture.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u22-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DONE = "2026-02-01";
const WITHDRAWAL = { kind: "withdrawn", closedOn: DONE, reason: "Superseded by the redesign." };

type Raw = Record<string, unknown>;

function ticket(id: string, extra: Raw = {}): Raw {
  return {
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p0",
    order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
    ...extra,
  };
}
const delivered = (id: string, extra: Raw = {}) => ticket(id, { status: "complete", completedDate: DONE, ...extra });
const withdrawn = (id: string, extra: Raw = {}) => delivered(id, { resolutionKind: WITHDRAWAL, ...extra });
const deleted = { lifecycle: "deleted", deletedAt: "2026-03-01T00:00:00.000Z" };

/** A committed git repository with a project and these tickets written raw. */
async function board(tickets: Raw[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u22-"));
  dirs.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  await initProject(root, { name: "t486-u22" });
  const path = join(root, ".story", "config.json");
  const config = JSON.parse(readFileSync(path, "utf-8"));
  config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  for (const t of tickets) writeRaw(root, t);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

const writeRaw = (root: string, t: Raw) => writeFileSync(join(root, ".story", "tickets", `${String(t.id)}.json`), serializeJSON(t));
const stateOf = async (root: string) => (await loadProject(root)).state;

async function blocked(root: string, id: string): Promise<boolean> {
  const state = await stateOf(root);
  return state.isBlocked(state.ticketByID(id)!);
}

async function recommended(root: string): Promise<string[]> {
  return recommend(await stateOf(root), 10).recommendations.map((r) => r.id);
}

function pickState(): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000486",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
  } as unknown as FullSessionState;
}

const RECIPE = {
  id: "coding",
  pipeline: ["PICK_TICKET", "PLAN", "IMPLEMENT", "FINALIZE", "COMPLETE"],
  postComplete: [], stages: {}, dirtyFileHandling: "block", branchStrategy: "current",
  defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
} as unknown as ResolvedRecipe;

async function pick(root: string, id: string) {
  const sessionDir = join(root, ".story", "sessions", "s");
  mkdirSync(sessionDir, { recursive: true });
  const ctx = new StageContext(root, sessionDir, pickState(), RECIPE);
  return new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: id });
}

async function findings(root: string): Promise<readonly { code: string; message: string }[]> {
  return validateProject(await stateOf(root)).findings;
}

// --- leaves ------------------------------------------------------------------

describe("T-486 U2-2 a withdrawn leaf blocker never releases (R1)", () => {
  it("recommend does not offer the dependent; its partner with a delivered blocker is offered", async () => {
    const root = await board([withdrawn("T-001"), ticket("T-002", { blockedBy: ["T-001"] })]);
    expect(await blocked(root, "T-002")).toBe(true);
    expect(await recommended(root)).not.toContain("T-002");

    const partner = await board([delivered("T-001"), ticket("T-002", { blockedBy: ["T-001"] })]);
    expect(await blocked(partner, "T-002")).toBe(false);
    expect(await recommended(partner)).toContain("T-002");
  });

  it("PICK_TICKET refuses the dependent as blocked; its partner advances", async () => {
    const root = await board([withdrawn("T-001"), ticket("T-002", { blockedBy: ["T-001"] })]);
    const refused = await pick(root, "T-002");
    expect(refused.action).toBe("retry");
    if (refused.action === "retry") expect(refused.instruction).toBe("Ticket T-002 is blocked. Pick an unblocked ticket.");

    const partner = await board([delivered("T-001"), ticket("T-002", { blockedBy: ["T-001"] })]);
    expect((await pick(partner, "T-002")).action).toBe("advance");
  });

  it("a stale withdrawal (reopened then re-completed on another day) releases: only an effective one holds", async () => {
    const root = await board([delivered("T-001", { completedDate: "2026-03-01", resolutionKind: WITHDRAWAL }), ticket("T-002", { blockedBy: ["T-001"] })]);
    expect(await blocked(root, "T-002")).toBe(false);
  });
});

describe("T-486 U2-2 deletion (R5, R6, R14)", () => {
  it("R5: a deleted ordinary blocker releases", async () => {
    const root = await board([ticket("T-001", deleted), ticket("T-002", { blockedBy: ["T-001"] })]);
    expect(await blocked(root, "T-002")).toBe(false);
  });

  it("R14: a deleted blocker carrying an effective withdrawal releases (V3A 3a: deletion is checked before the withdrawal)", async () => {
    const root = await board([withdrawn("T-001", deleted), ticket("T-002", { blockedBy: ["T-001"] })]);
    expect(await blocked(root, "T-002")).toBe(false);
  });

  it("R6: a deleted owner checkpoint keeps its dependent blocked (the checkpoint is checked before deletion)", async () => {
    const root = await board([]);
    const cp = await createCheckpoint(root, {
      title: "Owner decision", description: "", phase: "p0", owner: "owner",
      content: { kind: "decision", question: "Ship it?", evidenceRefs: [] }, actor: "owner@example.test",
    });
    const path = join(root, ".story", "tickets", `${cp.id}.json`);
    writeFileSync(path, serializeJSON({ ...JSON.parse(readFileSync(path, "utf-8")), ...deleted }));
    writeRaw(root, ticket("T-090", { blockedBy: [cp.id] }));
    expect(await blocked(root, "T-090")).toBe(true);
  });
});

// --- umbrellas ---------------------------------------------------------------

describe("T-486 U2-2 umbrellas (R2, R3, R8, R11)", () => {
  const umbrella = (extra: Raw = {}) => delivered("T-010", extra);
  const child = (id: string, make = delivered) => make(id, { parentTicket: "T-010" });

  it("R2: the dependent of a complete umbrella with a withdrawn child stays blocked", async () => {
    const root = await board([umbrella(), child("T-011"), child("T-012", withdrawn), ticket("T-020", { blockedBy: ["T-010"] })]);
    expect(await blocked(root, "T-020")).toBe(true);
    expect(await recommended(root)).not.toContain("T-020");
  });

  it("R2: a withdrawn leaf two umbrellas down still withholds the top umbrella", async () => {
    const root = await board([
      umbrella(),
      delivered("T-011", { parentTicket: "T-010" }),
      withdrawn("T-013", { parentTicket: "T-011" }),
      ticket("T-020", { blockedBy: ["T-010"] }),
    ]);
    expect(await blocked(root, "T-020")).toBe(true);
  });

  it("a deleted withdrawn child does not withhold its umbrella", async () => {
    const root = await board([umbrella(), child("T-011"), withdrawn("T-012", { parentTicket: "T-010", ...deleted }), ticket("T-020", { blockedBy: ["T-010"] })]);
    expect(await blocked(root, "T-020")).toBe(false);
  });

  it("R3: an umbrella with all children delivered releases", async () => {
    const root = await board([umbrella(), child("T-011"), child("T-012"), ticket("T-020", { blockedBy: ["T-010"] })]);
    expect(await blocked(root, "T-020")).toBe(false);
  });

  it("R8: a raw-withdrawn umbrella with delivered children blocks its dependent", async () => {
    const root = await board([umbrella({ resolutionKind: WITHDRAWAL }), child("T-011"), child("T-012"), ticket("T-020", { blockedBy: ["T-010"] })]);
    expect(await blocked(root, "T-020")).toBe(true);
  });

  it("R11: an umbrella in a parent cycle does not release, and the walk terminates", async () => {
    const root = await board([umbrella({ parentTicket: "T-011" }), delivered("T-011", { parentTicket: "T-010" }), ticket("T-020", { blockedBy: ["T-010"] })]);
    expect(await blocked(root, "T-020")).toBe(true);
    const state = await stateOf(root);
    expect(state.dependencyRelease(state.ticketByID("T-010")!)).toEqual({ releases: false, reason: null, detail: [] });
  });

  it("R11: a parent cycle elsewhere on the board neither hangs the walk nor blocks an umbrella outside it", async () => {
    const root = await board([
      umbrella(), child("T-011"),
      delivered("T-030", { parentTicket: "T-031" }), delivered("T-031", { parentTicket: "T-030" }),
      ticket("T-020", { blockedBy: ["T-010"] }),
    ]);
    expect(await blocked(root, "T-020")).toBe(false);
  });
});

// --- archived children --------------------------------------------------------

describe("T-486 U2-2 fixup: archived children count for the release walk (umbrellaIDs counts active children only)", () => {
  const archived = { lifecycle: "archived" };

  /** T-020 waits on T-010 alone; T-021 waits on T-010 and the open T-001. */
  const dependents = [ticket("T-001"), ticket("T-020", { blockedBy: ["T-010"] }), ticket("T-021", { blockedBy: ["T-001", "T-010"] })];

  async function expectWithheld(root: string, umbrellaError: boolean) {
    const state = await stateOf(root);
    expect(state.isBlocked(state.ticketByID("T-020")!)).toBe(true);
    expect(await recommended(root)).not.toContain("T-020");
    expect(ticketsUnblockedBy("T-001", state).map((t) => t.id)).toEqual([]);
    const dependent = [state.ticketByID("T-020")!];
    expect(formatBlockedTickets(dependent, state, "md")).toBe(
      "T-020: Ticket T-020 -- blocked by: T-010 (umbrella, withdrawn work under it: T-012)",
    );
    expect(JSON.parse(formatBlockedTickets(dependent, state, "json")).data[0].blockers).toEqual([
      { id: "T-010", status: "complete", releases: false, reason: "withheld", detail: ["T-012"] },
    ]);
    const codes = validateProject(state).findings.filter((f) => f.entity === "T-020" && f.code.startsWith("blocked_by_"));
    expect(codes.map((f) => f.code).sort()).toEqual(umbrellaError ? ["blocked_by_umbrella", "blocked_by_withheld_umbrella"] : ["blocked_by_withheld_umbrella"]);
    expect(codes.find((f) => f.code === "blocked_by_withheld_umbrella")!.message).toBe(
      "Ticket T-020 is blocked by T-010, which has withdrawn work under it (T-012); retarget or remove the edge.",
    );
  }

  it("an archived withdrawn grandchild under an active child withholds the top umbrella", async () => {
    // T-011 is active but its only child is archived, so T-011 is not in umbrellaIDs.
    const root = await board([
      delivered("T-010"), delivered("T-011", { parentTicket: "T-010" }),
      withdrawn("T-012", { parentTicket: "T-011", ...archived }),
      ...dependents,
    ]);
    const state = await stateOf(root);
    expect(state.umbrellaIDs.has("T-011")).toBe(false);
    await expectWithheld(root, true);
  });

  it("a ticket whose only child is archived and withdrawn withholds, though umbrellaIDs does not name it", async () => {
    const root = await board([delivered("T-010"), withdrawn("T-012", { parentTicket: "T-010", ...archived }), ...dependents]);
    const state = await stateOf(root);
    expect(state.umbrellaIDs.has("T-010")).toBe(false);
    await expectWithheld(root, false);
  });

  it("an archived delivered child under a complete umbrella releases", async () => {
    const root = await board([delivered("T-010"), delivered("T-012", { parentTicket: "T-010", ...archived }), ...dependents]);
    const state = await stateOf(root);
    expect(state.isBlocked(state.ticketByID("T-020")!)).toBe(false);
    expect(ticketsUnblockedBy("T-001", state).map((t) => t.id)).toEqual(["T-021"]);
  });

  it("a deleted withdrawn child, the only one, still releases", async () => {
    const root = await board([delivered("T-010"), withdrawn("T-012", { parentTicket: "T-010", ...deleted }), ...dependents]);
    const state = await stateOf(root);
    expect(state.isBlocked(state.ticketByID("T-020")!)).toBe(false);
    expect(state.dependencyRelease(state.ticketByID("T-010")!)).toEqual({ releases: true, reason: null, detail: [] });
  });
});

// --- ticketsUnblockedBy ------------------------------------------------------

describe("T-486 U2-2 ticketsUnblockedBy reads the same projection as isBlocked (R7, R12, R13)", () => {
  const unblockedBy = async (root: string, id: string) => ticketsUnblockedBy(id, await stateOf(root)).map((t) => t.id);

  it("R7: a dependent whose other blocker is withdrawn is not listed; with that blocker delivered it is", async () => {
    const root = await board([ticket("T-001"), withdrawn("T-002"), ticket("T-003", { blockedBy: ["T-001", "T-002"] })]);
    expect(await unblockedBy(root, "T-001")).toEqual([]);
    const partner = await board([ticket("T-001"), delivered("T-002"), ticket("T-003", { blockedBy: ["T-001", "T-002"] })]);
    expect(await unblockedBy(partner, "T-001")).toEqual(["T-003"]);
  });

  it("R7: a dependent whose other blocker is a withheld umbrella is not listed", async () => {
    const root = await board([
      ticket("T-001"), delivered("T-010"), withdrawn("T-011", { parentTicket: "T-010" }),
      ticket("T-003", { blockedBy: ["T-001", "T-010"] }),
    ]);
    expect(await unblockedBy(root, "T-001")).toEqual([]);
  });

  const X = "t-000000000000000x";
  const Y = "t-000000000000000y";

  it("R12: blockers named by displayId resolve like isBlocked: the simulated one is skipped and a delivered one releases", async () => {
    const root = await board([
      ticket(X, { displayId: "T-040" }),
      delivered(Y, { displayId: "T-041" }),
      ticket("T-003", { blockedBy: ["T-040", "T-041"] }),
    ]);
    expect(await unblockedBy(root, X)).toEqual(["T-003"]);
  });

  it("R13: a missing or ambiguous other blocker keeps the dependent unlisted, as isBlocked keeps it blocked", async () => {
    const root = await board([
      ticket("T-001"),
      delivered("t-0000000000000a01", { displayId: "T-050" }),
      delivered("t-0000000000000a02", { displayId: "T-050" }),
      ticket("T-003", { blockedBy: ["T-001", "T-999"] }),
      ticket("T-004", { blockedBy: ["T-001", "T-050"] }),
    ]);
    const state = await stateOf(root);
    for (const id of ["T-003", "T-004"]) expect(state.isBlocked(state.ticketByID(id)!), id).toBe(true);
    expect(await unblockedBy(root, "T-001")).toEqual([]);
  });
});

// --- blocker list ------------------------------------------------------------

describe("T-486 U2-2 the blocker list names the withdrawal (R9)", () => {
  it("md names a withdrawn blocker and an umbrella's withdrawn work; JSON adds releases, reason and detail beside status", async () => {
    const root = await board([
      withdrawn("T-001"),
      delivered("T-010"), delivered("T-011", { parentTicket: "T-010" }), withdrawn("T-012", { parentTicket: "T-010" }),
      delivered("T-005"),
      ticket("T-020", { blockedBy: ["T-001", "T-010", "T-005"] }),
    ]);
    const state = await stateOf(root);
    const dependent = [state.ticketByID("T-020")!];
    expect(formatBlockedTickets(dependent, state, "md")).toBe(
      "T-020: Ticket T-020 -- blocked by: T-001 (withdrawn), T-010 (umbrella, withdrawn work under it: T-012), T-005 (complete)",
    );
    const body = JSON.parse(formatBlockedTickets(dependent, state, "json")).data[0];
    expect(body.blockers).toEqual([
      { id: "T-001", status: "complete", releases: false, reason: "withdrawn", detail: ["T-001"] },
      { id: "T-010", status: "complete", releases: false, reason: "withheld", detail: ["T-012"] },
      { id: "T-005", status: "complete", releases: true, reason: null, detail: [] },
    ]);
  });
});

// --- validate and merged edges ------------------------------------------------

describe("T-486 U2-2 validate names edges on withdrawn work (R4, R10)", () => {
  it("R10: an open ticket blocked by a withdrawn leaf warns, naming the edge", async () => {
    const root = await board([withdrawn("T-001"), ticket("T-002", { blockedBy: ["T-001"] })]);
    expect((await findings(root)).filter((f) => f.code === "blocked_by_withdrawn").map((f) => f.message)).toEqual([
      "Ticket T-002 is blocked by T-001, which was withdrawn; retarget or remove the edge.",
    ]);
  });

  it("a complete or deleted dependent, or a delivered blocker, is not reported", async () => {
    const root = await board([
      withdrawn("T-001"), delivered("T-005"),
      delivered("T-002", { blockedBy: ["T-001"] }),
      ticket("T-003", { blockedBy: ["T-001"], ...deleted }),
      ticket("T-004", { blockedBy: ["T-005"] }),
    ]);
    expect((await findings(root)).filter((f) => f.code.startsWith("blocked_by_with"))).toEqual([]);
  });

  it("R4: an edge to a withdrawn umbrella merged in from another branch keeps the dependent blocked, and validate names it", async () => {
    // In process through the real three-way merge (blockedBy merges by union),
    // not the global merge-driver binary.
    const base = ticket("T-020");
    const ours = { ...base, title: "Retitled on our branch" };
    const theirs = { ...base, blockedBy: ["T-010"] };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(true);
    expect(r.merged.blockedBy).toEqual(["T-010"]);

    const root = await board([delivered("T-010"), delivered("T-011", { parentTicket: "T-010" }), withdrawn("T-012", { parentTicket: "T-010" }), r.merged]);
    expect(await blocked(root, "T-020")).toBe(true);
    expect(await recommended(root)).not.toContain("T-020");
    expect((await pick(root, "T-020")).action).toBe("retry");
    const codes = (await findings(root)).filter((f) => f.code.startsWith("blocked_by_"));
    expect(codes.map((f) => f.code).sort()).toEqual(["blocked_by_umbrella", "blocked_by_withheld_umbrella"]);
    expect(codes.find((f) => f.code === "blocked_by_withheld_umbrella")!.message).toBe(
      "Ticket T-020 is blocked by T-010, which has withdrawn work under it (T-012); retarget or remove the edge.",
    );
  });
});
