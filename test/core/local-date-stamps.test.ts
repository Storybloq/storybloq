/**
 * ISS-1383: every date-only field the CLI stamps is the LOCAL calendar date
 * of the write's instant, as `todayISO` documents and as the Mac app writes.
 * Full instants (`createdAt`, `deletedAt`) stay UTC ISO. N-059's team wiring
 * (e02ea246) had moved the create paths to `createdAt.slice(0, 10)`, the UTC
 * date, so an evening create read a day later than its own completion.
 *
 * Pinned at 2026-03-10T05:30:00Z in America/Los_Angeles (UTC-7 after the
 * 03-08 daylight change): local 2026-03-09 22:30, UTC 2026-03-10. Only `Date`
 * is faked, so the project lock's timers still run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { handleNoteCreate } from "../../src/cli/commands/note.js";
import { handleLessonCreate } from "../../src/cli/commands/lesson.js";
import { handleCheckpointCreate, handleCheckpointEnable } from "../../src/cli/commands/checkpoint.js";
import { handleReconcile } from "../../src/cli/commands/reconcile.js";
import { handleCapabilityAdd, handleCapabilityCheck, capabilityCatalog } from "../../src/cli/commands/capability.js";
import { handleArrangementCreate } from "../../src/cli/commands/arrangement.js";
import { makeState } from "./test-factories.js";
import type { CommandContext } from "../../src/cli/run.js";

const INSTANT = "2026-03-10T05:30:00.000Z";
const LOCAL = "2026-03-09";

const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv("TZ", "America/Los_Angeles");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(INSTANT));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function project(opts: { team?: boolean } = {}): Promise<string> {
  const dir = tmp("iss1383-");
  await initProject(dir, { name: "iss1383" });
  if (opts.team) {
    const path = join(dir, ".story", "config.json");
    const config = JSON.parse(readFileSync(path, "utf-8"));
    config.team = { ...(config.team ?? {}), enabled: true };
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  }
  return dir;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** The single entity in `.story/<dir>/` whose displayId (or legacy id) is `display`. */
function entity(root: string, dir: string, display: string): Record<string, any> {
  const base = join(root, ".story", dir);
  const hits = readdirSync(base).filter((f) => f.endsWith(".json")).map((f) => readJson(join(base, f)))
    .filter((e) => (e.displayId ?? e.id) === display);
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

describe("ISS-1383: the pinned instant sits inside the UTC/local split", () => {
  it("guard: the local date and the UTC date differ at the pinned instant", () => {
    const now = new Date();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(local).toBe(LOCAL);
    expect(now.toISOString().slice(0, 10)).toBe("2026-03-10");
  });
});

describe("ISS-1383: create paths stamp the local date", () => {
  it("T1: ticket create (non-team) stamps createdDate locally", async () => {
    const root = await project();
    await handleTicketCreate({ title: "A", type: "task", phase: null, description: "", blockedBy: [], parentTicket: null }, "json", root);
    expect(entity(root, "tickets", "T-001").createdDate).toBe(LOCAL);
  });

  it("T2: ticket create (team) stamps createdDate locally from the same instant as createdAt", async () => {
    const root = await project({ team: true });
    await handleTicketCreate({ title: "A", type: "task", phase: null, description: "", blockedBy: [], parentTicket: null }, "json", root);
    const t = entity(root, "tickets", "T-001");
    expect(t.createdDate).toBe(LOCAL);
    expect(t.createdAt).toBe(INSTANT);
  });

  it("T3: checkpoint create stamps its ticket's createdDate locally", async () => {
    const root = await project();
    await handleCheckpointEnable("md", root);
    const r = await handleCheckpointCreate({ title: "Pick", owner: "owner", kind: "decision", question: "a or b?", phase: null }, "json", root);
    const id = JSON.parse(r.output).data.id as string;
    expect(entity(root, "tickets", id).createdDate).toBe(LOCAL);
  });

  it("I1: issue create stamps discoveredDate locally", async () => {
    const root = await project();
    await handleIssueCreate({ title: "Bug", severity: "low", impact: "x", components: [], relatedTickets: [], location: [] }, "json", root);
    expect(entity(root, "issues", "ISS-001").discoveredDate).toBe(LOCAL);
  });

  it("N1: note create stamps createdDate and updatedDate locally", async () => {
    const root = await project();
    await handleNoteCreate({ content: "thought" }, "json", root);
    const n = entity(root, "notes", "N-001");
    expect([n.createdDate, n.updatedDate]).toEqual([LOCAL, LOCAL]);
  });

  it("L1: lesson create stamps createdDate, updatedDate and lastValidated locally", async () => {
    const root = await project();
    await handleLessonCreate({ title: "L", content: "c", context: "T-1", source: "manual" }, "json", root);
    const l = entity(root, "lessons", "L-001");
    expect([l.createdDate, l.updatedDate, l.lastValidated]).toEqual([LOCAL, LOCAL, LOCAL]);
  });

  it("R1: the reconcile mapping note stamps its dates locally", async () => {
    const root = await project({ team: true });
    const tickets = join(root, ".story", "tickets");
    const ticket = (id: string, order: number, createdDate: string) => ({
      id, displayId: "T-001", title: id, type: "task", status: "open", phase: null, order,
      description: "", createdDate, completedDate: null, blockedBy: [], parentTicket: null,
    });
    writeFileSync(join(tickets, "t-0000000000000001.json"), JSON.stringify(ticket("t-0000000000000001", 10, "2026-01-01"), null, 2) + "\n");
    writeFileSync(join(tickets, "t-0000000000000002.json"), JSON.stringify(ticket("t-0000000000000002", 20, "2026-02-01"), null, 2) + "\n");
    const result = await handleReconcile(root, { dryRun: false, ci: false, format: "md" });
    expect(result.exitCode).toBe(0);
    const notesDir = join(root, ".story", "notes");
    const notes = readdirSync(notesDir).map((f) => readJson(join(notesDir, f))).filter((n) => (n.tags ?? []).includes("reconcile"));
    expect(notes).toHaveLength(1);
    expect([notes[0]!.createdDate, notes[0]!.updatedDate]).toEqual([LOCAL, LOCAL]);
  });

  it("P1: initProject stamps roadmap.date locally", async () => {
    const root = await project();
    expect(readJson(join(root, ".story", "roadmap.json")).date).toBe(LOCAL);
  });

  it("A1: arrangement create stamps createdDate locally", async () => {
    const root = await project();
    await handleTicketCreate({ title: "Bound", type: "task", phase: null, description: "", blockedBy: [], parentTicket: null }, "json", root);
    const r = await handleArrangementCreate({
      bounds: ["T-001"],
      parties: [
        { role: "pen", client: "claude", identityAnchor: "pen-task" },
        { role: "worker", client: "claude", identityAnchor: "worker-task" },
      ],
      onIrreversibleWork: "hold",
    } as any, "json", root);
    const id = JSON.parse(r.output).data.id as string;
    expect(readJson(join(root, ".story", "arrangements", `${id}.json`)).createdDate).toBe(LOCAL);
  });
});

describe("ISS-1383: capability checkpoints stamp the local date", () => {
  function git(root: string, ...args: string[]): string {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
  }
  /** Standalone temp repos only (ISS-1220). */
  async function repo(): Promise<string> {
    const root = await project();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "thing.ts"), "export const a = 1;\n");
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@example.invalid");
    git(root, "config", "user.name", "T");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    return root;
  }
  const BASE = { id: "cap-thing", name: "Thing", summary: "Does the thing.", entryPoints: ["src/thing.ts"], contract: "Returns it." };
  const ctxFor = (root: string): CommandContext =>
    ({ state: makeState(), warnings: [], root, handoversDir: join(root, ".story", "handovers"), format: "md" });

  it("C1: capability add stamps checkedAt.date locally", async () => {
    const root = await repo();
    await handleCapabilityAdd(BASE, "md", root);
    expect(capabilityCatalog.load(root).doc.capabilities[0]!.checkedAt.date).toBe(LOCAL);
  });

  it("C2: capability check --stamp stamps checkedAt.date locally", async () => {
    const root = await repo();
    await handleCapabilityAdd(BASE, "md", root);
    // Isolate the check's own stamp from the add's: age the stored date first.
    const path = join(root, ".story", "capabilities.json");
    const doc = readJson(path);
    doc.capabilities[0].checkedAt.date = "2000-01-01";
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    const res = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "md", root, ctxFor(root));
    expect(res.output).toContain("Stamped 1");
    expect(capabilityCatalog.load(root).doc.capabilities[0]!.checkedAt.date).toBe(LOCAL);
  });
});
