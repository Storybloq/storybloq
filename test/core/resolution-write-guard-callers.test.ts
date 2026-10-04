/**
 * T-486 B6: the write context is the lock's own, and an issue write with no
 * context fails closed whether or not it touches resolution metadata. A
 * production caller that writes an issue without the lock would therefore
 * brick its command. One real invocation per command family from the caller
 * audit completes an ordinary issue write with the guard active.
 *
 * Families covered elsewhere with the guard active: conflict resolution
 * (resolution-write-guard.test.ts B8), ledger restore (B7), arrangement
 * rebind (arrangement-rebind.test.ts R10), arrangement rotate
 * (arrangement-capacity.test.ts), and the autonomous stages (pick-ticket-
 * earmark, issue-fix, park-issue, issue-sweep-earmark, deferral-disposition,
 * guide-recover-pending-mutation).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import {
  handleIssueCreate,
  handleIssueDelete,
  handleIssueMetaSet,
  handleIssueMetaUnset,
  handleIssueUpdate,
} from "../../src/cli/commands/issue.js";
import { handleEarmarkReserve, handleEarmarkRelease } from "../../src/cli/commands/earmark.js";
import { handleArrangementCreate, handleArrangementUpdate } from "../../src/cli/commands/arrangement.js";
import { handleRulingCreate, handleRulingPropose, handleRulingAccept } from "../../src/cli/commands/ruling.js";
import { handleSelftest } from "../../src/cli/commands/selftest.js";

const PEN = "pen-task-1";
const WORKER = "worker-task-1";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function project(name = "t486"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t486-callers-"));
  dirs.push(dir);
  await initProject(dir, { name });
  return dir;
}

async function createIssue(dir: string): Promise<string> {
  const r = await handleIssueCreate(
    { title: "a bug", severity: "medium", impact: "it breaks", components: [], relatedTickets: [], location: [] },
    "json",
    dir,
  );
  return JSON.parse(r.output).data.id as string;
}

async function issueRaw(dir: string, id: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, ".story", "issues", `${id}.json`), "utf-8"));
}

async function arrangement(dir: string, bound: string): Promise<string> {
  const r = await handleArrangementCreate(
    {
      bounds: [bound],
      parties: [
        { role: "pen", client: "claude", identityAnchor: PEN },
        { role: "worker", client: "claude", identityAnchor: WORKER },
      ],
      onIrreversibleWork: "hold",
    },
    "json",
    dir,
  );
  return JSON.parse(r.output).data.id as string;
}

async function orchestratorWithNode(): Promise<{ orch: string; node: string }> {
  const node = await project("engine");
  const orch = await project("orchestrator");
  const configPath = join(orch, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.type = "orchestrator";
  config.nodes = { engine: { path: node, health: "grey", dependsOn: [], stack: "", role: "", summary: "" } };
  config.federation = { allowNodeWrites: true };
  writeFileSync(configPath, JSON.stringify(config));
  return { orch, node };
}

describe("every audited command family writes an issue with the guard active (B6 requirement 2)", () => {
  it("issue: create, ordinary update, meta set, meta unset and delete complete", async () => {
    const dir = await project();
    const id = await createIssue(dir);
    await handleIssueUpdate(id, { title: "retitled" }, "json", dir);
    expect((await issueRaw(dir, id)).title).toBe("retitled");
    await handleIssueMetaSet(id, "x.note", "kept", "json", dir);
    expect((await issueRaw(dir, id)).x?.note).toBe("kept");
    await handleIssueMetaUnset(id, "x.note", "json", dir);
    expect((await issueRaw(dir, id)).x?.note).toBeUndefined();
    await handleIssueDelete(id, "json", dir);
  });

  it("earmark: reserve and release on an issue complete on the local board", async () => {
    const dir = await project();
    const id = await createIssue(dir);
    await arrangement(dir, id);
    await handleEarmarkReserve({ ref: id, role: "worker", clientTaskId: WORKER }, "json", dir);
    expect((await issueRaw(dir, id)).earmark?.stage).toBe("reserved");
    await handleEarmarkRelease({ ref: id, clientTaskId: WORKER }, "json", dir);
    expect((await issueRaw(dir, id)).earmark ?? null).toBeNull();
  });

  it("earmark: reserve and release on a node issue complete under the orchestrator and item locks", async () => {
    const { orch, node } = await orchestratorWithNode();
    const id = await createIssue(node);
    await arrangement(orch, `engine:${id}`);
    await handleEarmarkReserve({ ref: id, role: "worker", clientTaskId: WORKER }, "json", orch, "engine");
    expect((await issueRaw(node, id)).earmark?.stage).toBe("reserved");
    await handleEarmarkRelease({ ref: id, clientTaskId: WORKER }, "json", orch, "engine");
    expect((await issueRaw(node, id)).earmark ?? null).toBeNull();
  });

  it("arrangement: closing retracts an issue earmark on the local board", async () => {
    const dir = await project();
    const id = await createIssue(dir);
    const arr = await arrangement(dir, id);
    await handleEarmarkReserve({ ref: id, role: "worker", clientTaskId: WORKER }, "json", dir);
    await handleArrangementUpdate(arr, { lifecycle: "closed" }, "json", dir);
    expect((await issueRaw(dir, id)).earmark ?? null).toBeNull();
  });

  it("arrangement: closing retracts a node issue earmark under the orchestrator and item locks", async () => {
    const { orch, node } = await orchestratorWithNode();
    const id = await createIssue(node);
    const arr = await arrangement(orch, `engine:${id}`);
    await handleEarmarkReserve({ ref: id, role: "worker", clientTaskId: WORKER }, "json", orch, "engine");
    await handleArrangementUpdate(arr, { lifecycle: "closed" }, "json", orch);
    expect((await issueRaw(node, id)).earmark ?? null).toBeNull();
  });

  it("ruling: create citing an issue and accepting a proposal for an issue both write the issue", async () => {
    const dir = await project();
    const id = await createIssue(dir);
    const base = { attribution: "owner-direct", date: "2026-09-21", scopeTags: ["logging"], clientTaskId: PEN };
    const created = JSON.parse((await handleRulingCreate({ ...base, text: "R1", cites: [id] }, "json", dir)).output).data;
    expect((await issueRaw(dir, id)).citesRulings).toContain(created.id);
    const proposed = JSON.parse((await handleRulingPropose({ ...base, text: "P", proposedFor: [id] }, "json", dir)).output).data;
    await handleRulingAccept(proposed.id, { revision: proposed.revision, attribution: "owner-direct", date: "2026-09-22", clientTaskId: PEN }, "json", dir);
    expect((await issueRaw(dir, id)).citesRulings).toContain(proposed.id);
  });

  it("selftest: its issue create and update pass", async () => {
    const dir = await project();
    const data = JSON.parse((await handleSelftest(dir, "json")).output).data as { failed: number; results: Array<{ entity: string; passed: boolean; detail: string }> };
    const issueSteps = data.results.filter((r) => r.entity === "issue");
    expect(issueSteps.length).toBeGreaterThan(0);
    expect(issueSteps.filter((r) => !r.passed), JSON.stringify(issueSteps)).toEqual([]);
    expect(data.failed).toBe(0);
  });
});
