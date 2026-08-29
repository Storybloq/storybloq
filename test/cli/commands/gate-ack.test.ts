import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleGateAckGet,
  handleGateAckList,
  handleGateAckCreate,
  handleGateAckContest,
} from "../../../src/cli/commands/gate-ack.js";
import { handleArrangementCreate } from "../../../src/cli/commands/arrangement.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { makeState } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/types.js";
import type { Arrangement } from "../../../src/models/arrangement.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

const PARTIES = [
  { role: "pen" as const, client: "claude" as const, identityAnchor: "pen-session" },
  { role: "worker" as const, client: "claude" as const, identityAnchor: "worker-session" },
];

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newProjectWithTicket(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "gate-ack-cli-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test" });
  await handleTicketCreate(
    { title: "Duet gate-ack ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "md",
    dir,
  );
  return { dir };
}

/** Creates an arrangement via the ordinary handler, then rewrites its file to add gates -- `handleArrangementCreate` always writes `gates: []` (no CLI/MCP surface to set gates on create, by T-473's own design). */
async function newArrangementWithGates(dir: string, gateNames: string[]): Promise<string> {
  const created = await handleArrangementCreate(
    { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
    "json",
    dir,
  );
  const id = JSON.parse(created.output).data.id as string;
  const path = join(dir, ".story", "arrangements", `${id}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8")) as Arrangement;
  raw.gates = gateNames.map((name) => ({ name, ackRole: "pen" as const }));
  await writeFile(path, JSON.stringify(raw));
  return id;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
}

describe("handleGateAckCreate", () => {
  it("creates a plan-hash ack from --plan-file and writes it to disk", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "# The plan\n\nSome content.\n");

    const result = await handleGateAckCreate(
      { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile },
      "json",
      dir,
    );
    const ack = JSON.parse(result.output).data;
    expect(ack.id).toMatch(/^g-[0-9a-f]{16}$/);
    expect(ack.pin.kind).toBe("plan-hash");
    expect(ack.ackRole).toBe("pen"); // derived from the gate's own declaration

    const raw = await readFile(join(dir, ".story", "arrangement-acks", `${ack.id}.json`), "utf-8");
    expect(JSON.parse(raw).id).toBe(ack.id);
  });

  it("creates a tree-digest ack from --from-staged", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["pre-commit-ack"]);
    initGitRepo(dir);
    await writeFile(join(dir, "staged.txt"), "staged content");
    execFileSync("git", ["add", "staged.txt"], { cwd: dir });

    const result = await handleGateAckCreate(
      { arrangement: arrangementId, gate: "pre-commit-ack", ticket: "T-001", fromStaged: true },
      "json",
      dir,
    );
    const ack = JSON.parse(result.output).data;
    expect(ack.pin.kind).toBe("tree-digest");
    expect(ack.pin.parentSha).toMatch(/^[0-9a-f]{40}$/);
    expect(ack.pin.treeId).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rejects when neither --plan-file nor --from-staged is given", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    await expect(
      handleGateAckCreate({ arrangement: arrangementId, gate: "plan-ack", ticket: "T-001" }, "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects when both --plan-file and --from-staged are given", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    await expect(
      handleGateAckCreate(
        { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile, fromStaged: true },
        "md",
        dir,
      ),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects an unknown arrangement id", async () => {
    const { dir } = await newProjectWithTicket();
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    await expect(
      handleGateAckCreate({ arrangement: "a-0000000000000000", gate: "plan-ack", ticket: "T-001", planFile }, "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("T-478: refuses a conflicted arrangement BEFORE ever reading its gates (a nonexistent gate name still surfaces the conflict error, not 'no such gate')", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const path = join(dir, ".story", "arrangements", `${arrangementId}.json`);
    const raw = JSON.parse(await readFile(path, "utf-8")) as Arrangement;
    await writeFile(path, JSON.stringify({
      ...raw,
      _conflicts: [{ fieldPath: "gates", kind: "field", base: [], ours: [], theirs: [] }],
    }));
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");

    await expect(
      handleGateAckCreate({ arrangement: arrangementId, gate: "no-such-gate", ticket: "T-001", planFile }, "md", dir),
    ).rejects.toThrow(/unresolved merge conflicts/);
  });

  it("rejects a gate name not declared on the arrangement", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    await expect(
      handleGateAckCreate({ arrangement: arrangementId, gate: "no-such-gate", ticket: "T-001", planFile }, "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("rejects a ticket ref that does not resolve", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    await expect(
      handleGateAckCreate({ arrangement: arrangementId, gate: "plan-ack", ticket: "T-999", planFile }, "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("is idempotent: retrying with the same deltas returns the existing record", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    const first = await handleGateAckCreate(
      { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile, deltas: "condition A" },
      "json",
      dir,
    );
    const second = await handleGateAckCreate(
      { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile, deltas: "condition A" },
      "json",
      dir,
    );
    expect(JSON.parse(second.output).data.id).toBe(JSON.parse(first.output).data.id);
    expect(JSON.parse(second.output).data.decidedAt).toBe(JSON.parse(first.output).data.decidedAt);
  });

  it("throws a conflict when retried at the same pin with different deltas", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    await handleGateAckCreate(
      { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile, deltas: "condition A" },
      "json",
      dir,
    );
    await expect(
      handleGateAckCreate(
        { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile, deltas: "condition B" },
        "json",
        dir,
      ),
    ).rejects.toThrow(/conflict/);
  });

  it("records an independent-review trail when verdict is given (acceptance 7)", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    const result = await handleGateAckCreate(
      {
        arrangement: arrangementId,
        gate: "plan-ack",
        ticket: "T-001",
        planFile,
        codexSessionId: "sess-1",
        verdict: "approve",
        rounds: 2,
      },
      "json",
      dir,
    );
    const ack = JSON.parse(result.output).data;
    expect(ack.reviewTrail).toEqual({ present: true, codexSessionId: "sess-1", verdict: "approve", rounds: 2 });
  });

  it("[ISS-1049] --ticket accepts an ISSUE ref, resolved to its canonical id, same as a ticket ref", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gate-ack-cli-issue-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const { handleIssueCreate } = await import("../../../src/cli/commands/issue.js");
    const createdIssue = await handleIssueCreate(
      { title: "Duet gate-ack issue", severity: "medium", impact: "test", components: [], relatedTickets: [], location: [] },
      "json",
      dir,
    );
    const issueCanonicalId = JSON.parse(createdIssue.output).data.id as string;

    const created = await handleArrangementCreate(
      { bounds: ["ISS-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      dir,
    );
    const arrangementId = JSON.parse(created.output).data.id as string;
    const arrPath = join(dir, ".story", "arrangements", `${arrangementId}.json`);
    const raw = JSON.parse(await readFile(arrPath, "utf-8")) as Arrangement;
    raw.gates = [{ name: "pre-commit-ack", ackRole: "pen" }];
    await writeFile(arrPath, JSON.stringify(raw));

    initGitRepo(dir);
    const result = await handleGateAckCreate(
      { arrangement: arrangementId, gate: "pre-commit-ack", ticket: "ISS-001", fromStaged: true },
      "json",
      dir,
    );
    const ack = JSON.parse(result.output).data;
    expect(ack.ticketRef).toBe(issueCanonicalId);
  });
});

describe("handleGateAckGet / handleGateAckList", () => {
  it("gets a created gate-ack by its id", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    const created = await handleGateAckCreate(
      { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile },
      "json",
      dir,
    );
    const id = JSON.parse(created.output).data.id as string;
    const result = handleGateAckGet(id, makeCtx({ root: dir }));
    expect(result.output).toContain(id);
  });

  it("returns not_found for a missing gate-ack", () => {
    const result = handleGateAckGet("g-0000000000000000", makeCtx({ root: "/nonexistent" }));
    expect(result.errorCode).toBe("not_found");
  });

  it("lists created gate-acks and filters by arrangement and ticket", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    const created = await handleGateAckCreate(
      { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile },
      "json",
      dir,
    );
    const id = JSON.parse(created.output).data.id as string;

    const byArrangement = handleGateAckList({ arrangement: arrangementId }, makeCtx({ root: dir }));
    expect(byArrangement.output).toContain(id);
    const byOtherArrangement = handleGateAckList({ arrangement: "a-0000000000000000" }, makeCtx({ root: dir }));
    expect(byOtherArrangement.output).not.toContain(id);
    const byTicket = handleGateAckList({ ticket: "t-0000000000000001" }, makeCtx({ root: dir }));
    expect(byTicket.output).not.toContain(id);
  });
});

describe("handleGateAckContest", () => {
  it("marks a gate-ack contested with a reason", async () => {
    const { dir } = await newProjectWithTicket();
    const arrangementId = await newArrangementWithGates(dir, ["plan-ack"]);
    const planFile = join(dir, "plan.md");
    await writeFile(planFile, "content");
    const created = await handleGateAckCreate(
      { arrangement: arrangementId, gate: "plan-ack", ticket: "T-001", planFile },
      "json",
      dir,
    );
    const id = JSON.parse(created.output).data.id as string;
    const result = await handleGateAckContest(id, "the pin was based on a stale plan", "json", dir);
    expect(JSON.parse(result.output).data.contested).toBe(true);
  });

  it("rejects an empty --reason", async () => {
    const { dir } = await newProjectWithTicket();
    await expect(handleGateAckContest("g-0000000000000000", "   ", "md", dir)).rejects.toThrow(CliValidationError);
  });

  it("rejects contesting a nonexistent gate-ack", async () => {
    const { dir } = await newProjectWithTicket();
    await expect(handleGateAckContest("g-0000000000000000", "a reason", "md", dir)).rejects.toThrow();
  });
});
