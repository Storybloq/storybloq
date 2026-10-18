/**
 * ISS-1399: what the four callers that name a transaction's outcome say when
 * the change was applied but its journal removal is unconfirmed (a to d), and
 * when the commit marker's rename or sync failed, so recovery may roll the
 * change back or finish it (e to h).
 *
 * Seams: the `.story` sync that follows the journal removal fails (the only
 * `.story` sync made while no journal exists), or the marker sidecar's rename
 * fails.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ failPostRemovalSync: false, failMarkerRename: false }));

vi.mock("../../src/core/durable-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/durable-dir.js")>();
  const { existsSync: exists } = await import("node:fs");
  const { basename, join: joinPath } = await import("node:path");
  return {
    ...actual,
    syncDir: async (path: string) => {
      if (seam.failPostRemovalSync && basename(path) === ".story" && !exists(joinPath(path, ".txn.json"))) {
        seam.failPostRemovalSync = false;
        throw Object.assign(new Error("EIO: injected post-removal sync"), { code: "EIO" });
      }
      return actual.syncDir(path);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename = (async (from: unknown, to: unknown) => {
    if (seam.failMarkerRename && String(from).endsWith(".txn.json.marker.tmp")) {
      seam.failMarkerRename = false;
      throw Object.assign(new Error("EIO: injected marker rename"), { code: "EIO" });
    }
    return actual.rename(from as string, to as string);
  }) as typeof actual.rename;
  return { ...actual, default: { ...actual, rename }, rename };
});

const { initProject } = await import("../../src/core/init.js");
const { handleTicketCreate } = await import("../../src/cli/commands/ticket.js");
const { handleRulingCreate, handleRulingPropose, handleRulingAccept } = await import("../../src/cli/commands/ruling.js");
const { handleTriage } = await import("../../src/cli/commands/triage.js");
const { loadProject } = await import("../../src/core/project-loader.js");
const { loadRulingsSafe } = await import("../../src/core/ruling-loader.js");
const { CHECKPOINT_SCHEMA_VERSION } = await import("../../src/core/errors.js");
const { createCheckpoint, resolveCheckpoint } = await import("../../src/core/checkpoint-lifecycle.js");
const { checkpointApproved, parseOwnerCheckpoint } = await import("../../src/core/owner-checkpoint.js");

const ACTOR = "owner@example.test";
const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "iss1399-home-"));
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

const roots: string[] = [];
afterEach(() => {
  seam.failPostRemovalSync = false;
  seam.failMarkerRename = false;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function project(): Promise<{ root: string; ticketId: string }> {
  const root = mkdtempSync(join(tmpdir(), "iss1399-callers-"));
  roots.push(root);
  await initProject(root, { name: "iss1399" });
  const created = await handleTicketCreate(
    { title: "Cited", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    root,
  );
  return { root, ticketId: JSON.parse(created.output).data.id as string };
}

const failure = (p: Promise<unknown>): Promise<Error | null> => p.then(() => null, (e: Error) => e);
const journalPath = (root: string): string => join(root, ".story", ".txn.json");

function rulingCreate(root: string, cites: string[]) {
  return handleRulingCreate(
    { text: "Owner ruling: recorded once.", attribution: "owner-direct", date: "2026-10-18", scopeTags: [], cites, clientTaskId: "iss1399-test" },
    "json",
    root,
  );
}

async function proposed(root: string, ticketId: string): Promise<{ id: string; args: { revision: string; attribution: string; date: string; clientTaskId: string } }> {
  const p = JSON.parse((await handleRulingPropose(
    { text: "Proposed once.", attribution: "owner-direct", date: "2026-10-18", scopeTags: [], proposedFor: [ticketId], clientTaskId: "iss1399-test" },
    "json",
    root,
  )).output).data as { id: string; revision: string };
  return { id: p.id, args: { revision: p.revision, attribution: "owner-direct", date: "2026-10-18", clientTaskId: "iss1399-test" } };
}

const RULING = { text: "Onboarding ships", attribution: "owner-direct", date: "2026-10-18", scopeTags: ["onboarding"], clientTaskId: "iss1399-test" };

async function checkpoint(): Promise<{ dir: string; id: string; expected: { generation: number; revision: number; digest: string } }> {
  const dir = await mkdtemp(join(tmpdir(), "iss1399-cp-"));
  roots.push(dir);
  await initProject(dir, { name: "iss1399" });
  const configPath = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.schemaVersion = CHECKPOINT_SCHEMA_VERSION;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const t = await createCheckpoint(dir, { title: "Decision", description: "", phase: "p0", owner: "owner", content: { kind: "decision", question: "Ship?", evidenceRefs: [] }, actor: ACTOR });
  const p = parseOwnerCheckpoint(t);
  if (p.kind !== "ok") throw new Error("setup");
  return { dir, id: t.id, expected: { generation: p.checkpoint.generation, revision: p.checkpoint.revision, digest: p.checkpoint.digest } };
}

async function approved(dir: string, id: string): Promise<boolean> {
  const { state } = await loadProject(dir);
  return checkpointApproved(state.tickets.find((t) => t.id === id)!);
}

function issue(dir: string, id: string): void {
  writeFileSync(join(dir, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [], impact: "",
    resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
  }, null, 2) + "\n");
}

async function triageProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "iss1399-triage-"));
  roots.push(dir);
  await initProject(dir, { name: "iss1399" });
  issue(dir, "ISS-001");
  issue(dir, "ISS-002");
  return dir;
}

const triage = (dir: string) =>
  handleTriage({ ids: ["ISS-001", "ISS-002"], resolve: true, reason: "x", apply: true }, "json", dir, { today: "2026-10-18" });

describe("ISS-1399: applied, but the journal removal is unconfirmed", () => {
  it("a: ruling create says the ruling was created, names it, and says do not retry", async () => {
    const { root, ticketId } = await project();
    seam.failPostRemovalSync = true;
    const err = await failure(rulingCreate(root, [ticketId]));
    expect(err).not.toBeNull();
    const id = /\b(r-[0-9a-z]+)\b/.exec(err!.message)?.[1];
    expect(id).toBeTruthy();
    expect(err!.message).toContain(`Ruling ${id} was created`);
    expect(err!.message).toContain("Do NOT retry");
    expect(err!.message).not.toContain("recovery is pending");
    expect(loadRulingsSafe(root).rulings.map((r) => r.id)).toEqual([id]);
    expect(existsSync(journalPath(root))).toBe(false);
  });

  it("b: ruling accept says the ruling was accepted, names it, and says a repeat is a no-op", async () => {
    const { root, ticketId } = await project();
    const { id, args } = await proposed(root, ticketId);
    seam.failPostRemovalSync = true;
    const err = await failure(handleRulingAccept(id, args, "json", root));
    expect(err).not.toBeNull();
    expect(err!.message).toContain(`Ruling ${id} was accepted`);
    expect(err!.message).toContain("safe no-op");
    expect(err!.message).not.toContain("recovery is pending");
    expect(loadRulingsSafe(root).rulings.find((r) => r.id === id)?.status).toBe("accepted");
  });

  it("c: checkpoint resolve with a ruling says the resolution was applied, and do not retry", async () => {
    const { dir, id, expected } = await checkpoint();
    seam.failPostRemovalSync = true;
    const err = await failure(resolveCheckpoint(dir, id, expected, { response: "yes", actor: ACTOR, ruling: RULING }));
    expect(err).not.toBeNull();
    expect(err!.message).toContain("the resolution was applied");
    expect(err!.message).toContain("Do NOT retry");
    expect(err!.message).not.toContain("recovery is pending");
    expect(await approved(dir, id)).toBe(true);
  });

  it("d: triage --apply reports every write applied, warns, and exits non-zero", async () => {
    const dir = await triageProject();
    seam.failPostRemovalSync = true;
    const r = await triage(dir);
    expect(r.exitCode).toBe(1);
    expect((JSON.parse(r.output) as { data: { applied: string } }).data.applied).toBe("all");
    expect(r.warnings?.[0]).toContain("The writes were applied");
    expect(r.warnings?.[0]).toContain("Do not re-run");
    const { state } = await loadProject(dir);
    expect(state.issueByID("ISS-001")?.status).toBe("resolved");
    expect(state.issueByID("ISS-002")?.status).toBe("resolved");
  });
});

describe("ISS-1399: the marker's rename failed, so the change may or may not be applied", () => {
  it("e: ruling create names the ruling and says check it before any retry", async () => {
    const { root, ticketId } = await project();
    seam.failMarkerRename = true;
    const err = await failure(rulingCreate(root, [ticketId]));
    expect(err).not.toBeNull();
    const id = /\b(r-[0-9a-z]+)\b/.exec(err!.message)?.[1];
    expect(id).toBeTruthy();
    expect(err!.message).toContain("may or may not have been applied");
    expect(err!.message).toContain(`storybloq ruling get ${id}`);
    expect(err!.message).toContain("before any retry");
    expect(err!.message).not.toContain("recovery is pending");
  });

  it("f: ruling accept says check it before any retry", async () => {
    const { root, ticketId } = await project();
    const { id, args } = await proposed(root, ticketId);
    seam.failMarkerRename = true;
    const err = await failure(handleRulingAccept(id, args, "json", root));
    expect(err).not.toBeNull();
    expect(err!.message).toContain(id);
    expect(err!.message).toContain("may or may not have been applied");
    expect(err!.message).toContain("before any retry");
    expect(err!.message).not.toContain("recovery is pending");
  });

  it("g: checkpoint resolve says check it before any retry", async () => {
    const { dir, id, expected } = await checkpoint();
    seam.failMarkerRename = true;
    const err = await failure(resolveCheckpoint(dir, id, expected, { response: "yes", actor: ACTOR, ruling: RULING }));
    expect(err).not.toBeNull();
    expect(err!.message).toContain("may or may not have been applied");
    expect(err!.message).toContain("before any retry");
    expect(err!.message).not.toContain("recovery is pending");
  });

  it("h: triage --apply warns that the write may or may not have been applied", async () => {
    const dir = await triageProject();
    seam.failMarkerRename = true;
    const r = await triage(dir);
    expect(r.exitCode).toBe(1);
    expect(r.warnings?.[0]).toContain("may or may not have been applied");
    expect(r.warnings?.[0]).toContain("check the issues before any re-run");
  });
});
