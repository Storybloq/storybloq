/**
 * T-486 U3: `storybloq triage`, the bulk disposition surface.
 *
 * Boards are written file by file so every field is exact. Time is pinned:
 * the handler takes `today`, and every age below is counted from TODAY.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";

import { initProject } from "../../../src/core/init.js";
import { handleTriage, type TriageFlags } from "../../../src/cli/commands/triage.js";
import { handleIssueUpdate } from "../../../src/cli/commands/issue.js";
import { prepareIssueWriteSeams } from "../../../src/core/project-loader.js";
import { resolutionDigest } from "../../../src/core/resolution-kind.js";
import { todayISO } from "../../../src/cli/helpers.js";
import { registerTriageCommand } from "../../../src/cli/register.js";
import { PROJECT_ROOT_ENV_VAR, LEGACY_PROJECT_ROOT_ENV_VAR } from "../../../src/core/project-root-shared.js";

const TODAY = "2026-10-15";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const PHASES = [
  { id: "p1", label: "P1", name: "Phase 1", description: "" },
  { id: "p2", label: "P2", name: "Phase 2", description: "" },
];

async function project(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "t486-u3-triage-"));
  roots.push(dir);
  await initProject(dir, { name: "t486", phases: PHASES });
  writeJson(dir, "tickets/T-001.json", {
    id: "T-001", title: "Resolving work", description: "", type: "task", status: "open", phase: "p1",
    order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
  });
  writeJson(dir, "tickets/T-002.json", {
    id: "T-002", title: "More resolving work", description: "", type: "task", status: "open", phase: "p1",
    order: 20, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
  });
  return dir;
}

function writeJson(dir: string, rel: string, value: unknown): void {
  writeFileSync(join(dir, ".story", rel), JSON.stringify(value, null, 2) + "\n");
}

function readJson(dir: string, rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, ".story", rel), "utf-8")) as Record<string, unknown>;
}

function issue(dir: string, id: string, fields: Record<string, unknown> = {}): void {
  writeJson(dir, `issues/${id}.json`, {
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [], impact: "",
    resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null,
    relatedTickets: [], phase: null, ...fields,
  });
}

const EARMARK_RESERVED = {
  reservedBy: { client: "claude", id: "pen-task" }, arrangementId: "a-ffffffffffffffff",
  since: "2026-10-01T00:00:00.000Z", stage: "reserved", holderRole: "worker", holderSession: null,
};
const EARMARK_ASSIGNED = {
  ...EARMARK_RESERVED, stage: "assigned", holderSession: "11111111-2222-4333-8444-555555555555",
};
const CONFLICT = [{ fieldPath: "severity", kind: "field", base: "low", ours: "high", theirs: "medium" }];

/**
 * The selector board. Open: ISS-001, ISS-002, ISS-003, ISS-006.
 * Resolved: ISS-004, ISS-005. ISS-006 is exactly 90 days old.
 */
async function selectorBoard(): Promise<string> {
  const dir = await project();
  issue(dir, "ISS-001", { title: "Old cli crash", severity: "high", components: ["cli"], discoveredDate: "2026-01-01" });
  issue(dir, "ISS-002", {
    title: "Recent mac glitch", severity: "low", components: ["mac"], discoveredDate: "2026-10-01",
    relatedTickets: ["T-001"], phase: "p1", disposition: "owner_gated",
  });
  issue(dir, "ISS-003", { title: "Old mcp drift", components: ["cli", "mcp"], discoveredDate: "2026-03-01", relatedTickets: ["T-001"], phase: "p1" });
  issue(dir, "ISS-004", {
    title: "Closed as not worth it", status: "resolved", resolution: "wontfix: not worth it",
    resolvedDate: "2026-02-01", relatedTickets: ["T-001"], phase: "p1",
  });
  issue(dir, "ISS-005", {
    title: "Closed by a fix", status: "resolved", resolution: "fixed in abc1234",
    resolvedDate: "2026-02-02", relatedTickets: ["T-001"], phase: "p1",
  });
  issue(dir, "ISS-006", { title: "Boundary age", severity: "low", components: ["mac"], discoveredDate: "2026-07-17", relatedTickets: ["T-001"], phase: "p1" });
  return dir;
}

interface Entry { id: string; displayId: string; ageDays: number; severity: string; title: string; reason?: string }
interface TriageData {
  action: unknown;
  applied: string;
  writable: Entry[];
  protected: Entry[];
  notApplicable: Entry[];
  truncatedInputs?: Array<{ id: string; displayId: string; field: string }>;
}

async function triage(dir: string, flags: TriageFlags): Promise<TriageData> {
  const r = await handleTriage(flags, "json", dir, { today: TODAY });
  const parsed = JSON.parse(r.output) as { version: number; data: TriageData };
  return parsed.data;
}

async function refusal(dir: string, flags: TriageFlags): Promise<Error> {
  const err = await handleTriage(flags, "json", dir, { today: TODAY }).then(() => null, (e: unknown) => e as Error);
  expect(err, "expected a refusal").toBeInstanceOf(Error);
  return err!;
}

const ids = (entries: Entry[]): string[] => entries.map((e) => e.id);
const matched = (d: TriageData): string[] => [...ids(d.writable), ...ids(d.protected), ...ids(d.notApplicable)].sort();

/** Every file under .story/ with its bytes. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (p: string): void => {
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(dir, full), readFileSync(full, "utf-8"));
    }
  };
  walk(join(dir, ".story"));
  return out;
}

/** Runs `storybloq triage ...` through the real parser; returns stdout and the exit code. */
async function cli(dir: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  vi.stubEnv(PROJECT_ROOT_ENV_VAR, dir);
  vi.stubEnv(LEGACY_PROJECT_ROOT_ENV_VAR, "");
  let stdout = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await registerTriageCommand(yargs(["triage", ...args]).scriptName("storybloq"))
      .exitProcess(false)
      .fail(false)
      .parseAsync()
      .catch(() => undefined);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { stdout, exitCode };
}

describe("T-486 U3 triage: selectors", () => {
  it("T1: each selector alone matches exactly its set", async () => {
    const dir = await selectorBoard();
    const cases: Array<[TriageFlags, string[]]> = [
      [{ olderThan: 90 }, ["ISS-001", "ISS-003"]],
      [{ severity: ["high"] }, ["ISS-001"]],
      [{ component: ["mcp"] }, ["ISS-003"]],
      [{ status: ["resolved"] }, ["ISS-004", "ISS-005"]],
      [{ orphan: true }, ["ISS-001"]],
      [{ unphased: true }, ["ISS-001"]],
      [{ disposition: "owner_gated" }, ["ISS-002"]],
      [{ disposition: "none" }, ["ISS-001", "ISS-003", "ISS-006"]],
      [{ titleMatches: "MAC" }, ["ISS-002"]],
      [{ ids: ["ISS-003"] }, ["ISS-003"]],
      [{ status: ["resolved"], resolutionMatches: "^wontfix:" }, ["ISS-004"]],
    ];
    for (const [flags, want] of cases) {
      expect(matched(await triage(dir, flags)), JSON.stringify(flags)).toEqual(want);
    }
  });

  it("T1: --older-than counts whole days from discoveredDate and is strict", async () => {
    const dir = await selectorBoard();
    const d = await triage(dir, { olderThan: 89 });
    expect(matched(d)).toEqual(["ISS-001", "ISS-003", "ISS-006"]);
    expect(d.writable.find((e) => e.id === "ISS-006")!.ageDays).toBe(90);
    expect(d.writable.find((e) => e.id === "ISS-001")!.ageDays).toBe(287);
  });

  it("T2: two and three selectors compose with AND", async () => {
    const dir = await selectorBoard();
    expect(matched(await triage(dir, { olderThan: 90, severity: ["high", "medium"] }))).toEqual(["ISS-001", "ISS-003"]);
    expect(matched(await triage(dir, { olderThan: 90, severity: ["high", "medium"], orphan: true }))).toEqual(["ISS-001"]);
    expect(matched(await triage(dir, { component: ["cli"], titleMatches: "drift" }))).toEqual(["ISS-003"]);
  });

  it("T16: --ids refuses an id that names no issue, by name; duplicates collapse", async () => {
    const dir = await selectorBoard();
    const err = await refusal(dir, { ids: ["ISS-001", "ISS-999"] });
    expect(err.message).toContain("ISS-999");
    const d = await triage(dir, { ids: ["ISS-001", "ISS-001", "ISS-003"] });
    expect(ids(d.writable)).toEqual(["ISS-001", "ISS-003"]);
  });
});

describe("T-486 U3 triage: dry run and output", () => {
  it("T3: a dry run writes nothing and prints the set", async () => {
    const dir = await selectorBoard();
    const before = snapshot(dir);
    const r = await handleTriage({ olderThan: 90, resolve: true, reason: "not worth doing" }, "md", dir, { today: TODAY });
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, ".story", ".txn.json"))).toBe(false);
    expect(r.output).toContain("(dry run)");
    expect(r.output).toContain("ISS-001  287d  high  Old cli crash");
    expect(r.output).toContain("ISS-003  228d  medium  Old mcp drift");
  });

  it("T6: the json output is the {version, data} envelope with the three lists", async () => {
    const dir = await selectorBoard();
    const r = await handleTriage({ olderThan: 90, resolve: true, reason: "x" }, "json", dir, { today: TODAY });
    const parsed = JSON.parse(r.output) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["data", "version"]);
    expect(parsed.version).toBe(1);
    const data = parsed.data as TriageData;
    expect(Object.keys(data).sort()).toEqual(["action", "applied", "notApplicable", "protected", "writable"]);
    expect(data.applied).toBe("none");
    expect(data.action).toEqual({ kind: "resolve", reason: "x", resolutionKind: "wontfix" });
    expect(data.writable[0]).toEqual({ id: "ISS-001", displayId: "ISS-001", ageDays: 287, severity: "high", title: "Old cli crash" });
  });

  it("T6: the command is registered and runs through the parser", async () => {
    const dir = await selectorBoard();
    const r = await cli(dir, ["--severity", "high", "--format", "json"]);
    expect(r.exitCode).toBe(0);
    expect(ids((JSON.parse(r.stdout) as { data: TriageData }).data.writable)).toEqual(["ISS-001"]);
  });
});

describe("T-486 U3 triage: refusals before the lock", () => {
  it("T5: --resolve without --reason, or with a blank one, is refused", async () => {
    const dir = await selectorBoard();
    expect((await refusal(dir, { olderThan: 90, resolve: true })).message).toContain("--reason");
    expect((await refusal(dir, { olderThan: 90, resolve: true, reason: "   " })).message).toContain("--reason");
  });

  it("T7: --kind fixed and --kind duplicate are refused in bulk", async () => {
    const dir = await selectorBoard();
    for (const kind of ["fixed", "duplicate"]) {
      const err = await refusal(dir, { olderThan: 90, resolve: true, reason: "x", kind });
      expect(err.message).toContain(`--kind ${kind} is not a bulk resolution`);
    }
    expect(matched(await triage(dir, { olderThan: 90, resolve: true, reason: "x", kind: "superseded" }))).toEqual(["ISS-001", "ISS-003"]);
  });

  it("refuses a run with no selector, two actions, or an action flag without its action", async () => {
    const dir = await selectorBoard();
    expect((await refusal(dir, { resolve: true, reason: "x" })).message).toContain("at least one selector");
    expect((await refusal(dir, { olderThan: 1, resolve: true, reason: "x", relate: "T-001" })).message).toContain("one action per run");
    expect((await refusal(dir, { olderThan: 1, kind: "wontfix" })).message).toContain("--kind goes with --resolve");
    expect((await refusal(dir, { olderThan: 1, ref: "T-001" })).message).toContain("--ref goes with --set-disposition");
    expect((await refusal(dir, { olderThan: 1, reason: "x" })).message).toContain("--reason goes with");
    expect((await refusal(dir, { severity: ["urgent"] })).message).toContain("Unknown --severity");
  });

  it("T14: a pattern over 256 characters is refused, and so is one that does not compile", async () => {
    const dir = await selectorBoard();
    expect((await refusal(dir, { titleMatches: "a".repeat(257) })).message).toContain("the limit is 256");
    expect(matched(await triage(dir, { titleMatches: `${"(?:x)?".repeat(40)}cli.{0,2}` }))).toEqual(["ISS-001"]);
    expect((await refusal(dir, { titleMatches: "(" })).message).toContain("does not compile");
    expect((await refusal(dir, { status: ["resolved"], resolutionMatches: "[" })).message).toContain("does not compile");
  });

  it("T26: --set-disposition needs a non-blank --reason and --ref, refuses an unknown ref, and refuses duplicate", async () => {
    const dir = await selectorBoard();
    expect((await refusal(dir, { olderThan: 90, setDisposition: "owner_gated", reason: "r" })).message).toContain("--ref");
    expect((await refusal(dir, { olderThan: 90, setDisposition: "owner_gated", reason: "r", ref: "  " })).message).toContain("--ref");
    expect((await refusal(dir, { olderThan: 90, setDisposition: "owner_gated", ref: "T-001" })).message).toContain("--reason");
    expect((await refusal(dir, { olderThan: 90, setDisposition: "owner_gated", reason: "r", ref: "T-999" })).message).toContain("T-999");
    expect((await refusal(dir, { olderThan: 90, setDisposition: "duplicate", reason: "r", ref: "T-001" })).message).toContain("--set-disposition duplicate");
    expect((await refusal(dir, { olderThan: 90, setDisposition: "none", reason: "r" })).message).toContain("--reason");
    const d = await triage(dir, { olderThan: 90, setDisposition: "owner_gated", reason: "r", ref: "T-001" });
    expect(d.action).toEqual({ kind: "set-disposition", disposition: "owner_gated", reason: "r", ref: "T-001" });
  });

  it("T19: --relate an unknown ticket and --set-phase an unknown phase refuse the run", async () => {
    const dir = await selectorBoard();
    expect((await refusal(dir, { olderThan: 90, relate: "T-999" })).message).toContain("T-999");
    expect((await refusal(dir, { olderThan: 90, setPhase: "p9" })).message).toContain("p9");
    expect(ids((await triage(dir, { olderThan: 90, setPhase: "p2" })).writable)).toEqual(["ISS-001", "ISS-003"]);
  });
});

describe("T-486 U3 triage: classification", () => {
  async function protectedBoard(): Promise<string> {
    const dir = await selectorBoard();
    issue(dir, "ISS-010", { title: "Reserved", earmark: EARMARK_RESERVED });
    issue(dir, "ISS-011", { title: "Being worked", status: "inprogress" });
    issue(dir, "ISS-012", { title: "Conflicted", _conflicts: CONFLICT });
    issue(dir, "ISS-013", { title: "Tombstoned", lifecycle: "deleted", deletedAt: "2026-10-01T00:00:00.000Z", deletedBy: "test" });
    return dir;
  }

  it("T9: earmarked, in-progress, conflicted and tombstoned issues are protected, with the reason", async () => {
    const dir = await protectedBoard();
    const d = await triage(dir, {
      ids: ["ISS-001", "ISS-010", "ISS-011", "ISS-012", "ISS-013"], status: ["open", "inprogress"], resolve: true, reason: "x",
    });
    expect(ids(d.writable)).toEqual(["ISS-001"]);
    expect(d.protected.map((e) => [e.id, e.reason])).toEqual([
      ["ISS-010", "earmarked (reserved)"],
      ["ISS-011", "in progress"],
      ["ISS-012", "has unresolved merge conflicts"],
      ["ISS-013", "deleted"],
    ]);
  });

  it("T23: a conflicted issue does not stop the run; it is reported beside the writable one", async () => {
    const dir = await protectedBoard();
    const before = readFileSync(join(dir, ".story", "issues", "ISS-012.json"), "utf-8");
    const d = await triage(dir, { ids: ["ISS-001", "ISS-012"], resolve: true, reason: "x" });
    expect(ids(d.writable)).toEqual(["ISS-001"]);
    expect(ids(d.protected)).toEqual(["ISS-012"]);
    expect(readFileSync(join(dir, ".story", "issues", "ISS-012.json"), "utf-8")).toBe(before);
  });

  it("T24: a conflict on config, on the roadmap, or on a ticket refuses the run", async () => {
    for (const rel of ["config.json", "roadmap.json", "tickets/T-001.json"]) {
      const dir = await selectorBoard();
      writeJson(dir, rel, { ...readJson(dir, rel), _conflicts: CONFLICT });
      const before = snapshot(dir);
      const err = await refusal(dir, { olderThan: 90, resolve: true, reason: "x" });
      expect(err.message, rel).toContain("Cannot triage");
      expect(snapshot(dir)).toEqual(before);
    }
  });

  it("T28: reserved and assigned earmarks protect open and resolved issues alike", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-020", { title: "Open reserved", earmark: EARMARK_RESERVED });
    issue(dir, "ISS-021", { title: "Open assigned", earmark: EARMARK_ASSIGNED });
    issue(dir, "ISS-022", { title: "Resolved reserved", status: "resolved", resolution: "wontfix: dropped", resolvedDate: "2026-02-01", earmark: EARMARK_RESERVED });
    issue(dir, "ISS-023", { title: "Resolved assigned", status: "resolved", resolution: "wontfix: dropped", resolvedDate: "2026-02-01", earmark: EARMARK_ASSIGNED });
    const d = await triage(dir, { ids: ["ISS-020", "ISS-021", "ISS-022", "ISS-023", "ISS-004"], status: ["open", "resolved"], setResolutionKind: "wontfix" });
    expect(d.protected.map((e) => [e.id, e.reason])).toEqual([
      ["ISS-020", "earmarked (reserved)"],
      ["ISS-021", "earmarked (assigned)"],
      ["ISS-022", "earmarked (reserved)"],
      ["ISS-023", "earmarked (assigned)"],
    ]);
    expect(ids(d.writable)).toEqual(["ISS-004"]);
  });

  it("T10: an action with no effect for an issue puts it under not applicable, with the reason", async () => {
    const dir = await selectorBoard();
    const cases: Array<[TriageFlags, Array<[string, string]>]> = [
      [{ status: ["resolved"], ids: ["ISS-004"], resolve: true, reason: "x" }, [["ISS-004", "already resolved"]]],
      [{ ids: ["ISS-003"], relate: "T-001" }, [["ISS-003", "already related to T-001"]]],
      [{ ids: ["ISS-003"], setPhase: "p1" }, [["ISS-003", "already in phase p1"]]],
      [{ ids: ["ISS-001"], setPhase: "none" }, [["ISS-001", "already in phase none"]]],
      [{ status: ["open", "resolved"], ids: ["ISS-001"], setResolutionKind: "wontfix" }, [["ISS-001", "not resolved (open)"]]],
      [{ ids: ["ISS-001"], setDisposition: "none" }, [["ISS-001", "has no disposition"]]],
    ];
    for (const [flags, want] of cases) {
      const d = await triage(dir, flags);
      expect(d.writable, JSON.stringify(flags)).toEqual([]);
      expect(d.notApplicable.map((e) => [e.id, e.reason]), JSON.stringify(flags)).toEqual(want);
    }
    expect(ids((await triage(dir, { ids: ["ISS-001"], relate: "T-001" })).writable)).toEqual(["ISS-001"]);
  });
});

describe("T-486 U3 triage: bounded patterns", () => {
  it("T13: a catastrophic pattern is refused at the deadline, and the lock is released", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-030", { title: `${"a".repeat(40)}b` });
    const before = snapshot(dir);
    const started = Date.now();
    const err = await refusal(dir, { titleMatches: "^(a+)+$" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(err.message).toContain("matching deadline");
    expect(snapshot(dir)).toEqual(before);
    await handleIssueUpdate("ISS-030", { severity: "low" }, "json", dir);
    expect(readJson(dir, "issues/ISS-030.json").severity).toBe("low");
  });

  it("T15: a long title is matched on its first 4096 characters and reported as truncated", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-031", { title: `${"x".repeat(4100)} needle` });
    const miss = await triage(dir, { titleMatches: "needle" });
    expect(matched(miss)).toEqual([]);
    expect(miss.truncatedInputs).toEqual([{ id: "ISS-031", displayId: "ISS-031", field: "title" }]);
    const hit = await triage(dir, { titleMatches: "^x{4096}$" });
    expect(matched(hit)).toEqual(["ISS-031"]);
    expect(hit.truncatedInputs).toEqual([{ id: "ISS-031", displayId: "ISS-031", field: "title" }]);
    expect((await triage(dir, { titleMatches: "cli" })).truncatedInputs).toEqual([{ id: "ISS-031", displayId: "ISS-031", field: "title" }]);
    expect((await triage(dir, { titleMatches: "cli", ids: ["ISS-001", "ISS-003"] })).truncatedInputs).toBeUndefined();
  });

  it("T30: --set-resolution-kind puts a resolved issue with no resolution text or no resolvedDate under not applicable", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-008", { title: "No text", status: "resolved", resolution: null, resolvedDate: "2026-02-02" });
    issue(dir, "ISS-009", { title: "No date", status: "resolved", resolution: "wontfix: dropped", resolvedDate: null });
    const d = await triage(dir, { ids: ["ISS-004", "ISS-008", "ISS-009"], status: ["resolved"], setResolutionKind: "wontfix" });
    expect(ids(d.writable)).toEqual(["ISS-004"]);
    expect(d.notApplicable.map((e) => [e.id, e.reason])).toEqual([["ISS-008", "no resolution text"], ["ISS-009", "no resolvedDate"]]);
  });

  it("T29: a pattern with backticks, quotes and ${ is matched as a literal pattern", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-032", { title: "use `${x}` and \"q\" and 'q' here" });
    const d = await triage(dir, { titleMatches: "`\\$\\{x\\}` and \"q\" and 'q'" });
    expect(matched(d)).toEqual(["ISS-032"]);
  });

  it("T21: the built CLI enforces the deadline", () => {
    const cli = join(PACKAGE_ROOT, "dist", "cli.js");
    expect(existsSync(cli), "dist/cli.js is built").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "t486-u3-dist-"));
    roots.push(dir);
    const home = join(dir, "home");
    const init = spawnSync(process.execPath, [cli, "init", "--name", "t486"], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf-8" });
    expect(init.status, init.stdout + init.stderr).toBe(0);
    writeFileSync(join(dir, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: `${"a".repeat(40)}b`, status: "open", severity: "medium", components: [], impact: "",
      resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
    }, null, 2) + "\n");
    const started = Date.now();
    const r = spawnSync(process.execPath, [cli, "triage", "--title-matches", "^(a+)+$", "--format", "json"], {
      cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: home }, encoding: "utf-8", timeout: 20_000,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("matching deadline");
  });
});

describe("T-486 U3 triage: apply", () => {
  const fileOf = (dir: string, id: string): string => readFileSync(join(dir, ".story", "issues", `${id}.json`), "utf-8");

  async function apply(dir: string, flags: TriageFlags, today = TODAY): Promise<TriageData> {
    const r = await handleTriage({ ...flags, apply: true }, "json", dir, { today });
    expect(r.exitCode ?? 0).toBe(0);
    return (JSON.parse(r.output) as { data: TriageData }).data;
  }

  it("T4: --apply writes exactly the writable set and nothing else", async () => {
    const dir = await selectorBoard();
    const before = snapshot(dir);
    const d = await apply(dir, { olderThan: 90, resolve: true, reason: "not worth doing" });
    expect(d.applied).toBe("all");
    expect(ids(d.writable)).toEqual(["ISS-001", "ISS-003"]);
    const after = snapshot(dir);
    const changed = [...after.keys()].filter((k) => after.get(k) !== before.get(k)).sort();
    expect(changed).toEqual([join(".story", "issues", "ISS-001.json"), join(".story", "issues", "ISS-003.json")]);
    expect([...before.keys()].sort()).toEqual([...after.keys()].sort());
    const written = readJson(dir, "issues/ISS-001.json");
    expect(written).toMatchObject({ status: "resolved", resolution: "not worth doing", resolvedDate: TODAY });
    expect(written.resolutionKind).toEqual({ kind: "wontfix", closedOn: TODAY, resolutionDigest: resolutionDigest("not worth doing") });
  });

  it("T12: a bulk resolve writes the same bytes as a single issue update", async () => {
    const bulk = await selectorBoard();
    const single = await selectorBoard();
    await apply(bulk, { ids: ["ISS-003"], resolve: true, reason: "replaced by T-001", kind: "superseded" }, todayISO());
    await handleIssueUpdate("ISS-003", { status: "resolved", resolution: "replaced by T-001", resolutionKind: "superseded" }, "json", single);
    expect(fileOf(bulk, "ISS-003")).toBe(fileOf(single, "ISS-003"));
  });

  it("T25: a bulk disposition writes the same bytes as a single issue update", async () => {
    const bulk = await selectorBoard();
    const single = await selectorBoard();
    await apply(bulk, { ids: ["ISS-003"], setDisposition: "owner_gated", reason: "needs a product call", ref: "T-001" });
    await handleIssueUpdate("ISS-003", { disposition: "owner_gated", dispositionReason: "needs a product call", dispositionRef: "T-001" }, "json", single);
    expect(fileOf(bulk, "ISS-003")).toBe(fileOf(single, "ISS-003"));
  });

  it("T27: --set-disposition none clears the four keys, keeping duplicateOf only on an issue resolved as a duplicate", async () => {
    const dir = await selectorBoard();
    const evidence = { disposition: "duplicate", dispositionReason: "same crash", dispositionRef: "ISS-001", dispositionFor: "duplicate", duplicateOf: "ISS-001" };
    issue(dir, "ISS-040", { title: "Open with a disposition", ...evidence });
    issue(dir, "ISS-041", {
      title: "Resolved as a duplicate", status: "resolved", resolution: "duplicate of ISS-001", resolvedDate: "2026-02-01", ...evidence,
      resolutionKind: { kind: "duplicate", closedOn: "2026-02-01", resolutionDigest: resolutionDigest("duplicate of ISS-001") },
    });
    const d = await apply(dir, { ids: ["ISS-040", "ISS-041"], status: ["open", "resolved"], setDisposition: "none" });
    expect(ids(d.writable)).toEqual(["ISS-040", "ISS-041"]);
    const open = readJson(dir, "issues/ISS-040.json");
    const resolved = readJson(dir, "issues/ISS-041.json");
    for (const key of ["disposition", "dispositionReason", "dispositionRef", "dispositionFor"]) {
      expect(open, key).not.toHaveProperty(key);
      expect(resolved, key).not.toHaveProperty(key);
    }
    expect(open).not.toHaveProperty("duplicateOf");
    expect(resolved.duplicateOf).toBe("ISS-001");
  });

  it("T20: --set-resolution-kind binds each issue's own resolvedDate and resolution", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-007", { title: "Another closure", status: "resolved", resolution: "wontfix: out of scope", resolvedDate: "2026-03-03" });
    const d = await apply(dir, { status: ["resolved"], resolutionMatches: "^wontfix:", setResolutionKind: "wontfix" });
    expect(ids(d.writable)).toEqual(["ISS-004", "ISS-007"]);
    expect(readJson(dir, "issues/ISS-004.json").resolutionKind).toEqual({ kind: "wontfix", closedOn: "2026-02-01", resolutionDigest: resolutionDigest("wontfix: not worth it") });
    expect(readJson(dir, "issues/ISS-007.json").resolutionKind).toEqual({ kind: "wontfix", closedOn: "2026-03-03", resolutionDigest: resolutionDigest("wontfix: out of scope") });
    const again = await apply(dir, { status: ["resolved"], resolutionMatches: "^wontfix:", setResolutionKind: "wontfix" });
    expect(again.notApplicable.map((e) => e.id)).toEqual(["ISS-004", "ISS-007"]);
  });

  it("T8: more than 50 writable issues needs --force; the cap counts writable issues only", async () => {
    const dir = await project();
    for (let n = 100; n < 151; n++) issue(dir, `ISS-${n}`, { title: `Bulk ${n}` });
    const before = snapshot(dir);
    const err = await handleTriage({ status: ["open"], resolve: true, reason: "x", apply: true }, "json", dir, { today: TODAY }).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toContain("over the cap of 50");
    expect(snapshot(dir)).toEqual(before);
    issue(dir, "ISS-150", { title: "Bulk 150", status: "inprogress" });
    const capped = await apply(dir, { status: ["open", "inprogress"], resolve: true, reason: "x" });
    expect(capped.writable).toHaveLength(50);
    expect(capped.protected).toHaveLength(1);
    expect(capped.applied).toBe("all");
    issue(dir, "ISS-151", { title: "Bulk 151" });
    issue(dir, "ISS-152", { title: "Bulk 152" });
    for (let n = 153; n < 202; n++) issue(dir, `ISS-${n}`, { title: `Bulk ${n}` });
    const forced = await apply(dir, { status: ["open"], resolve: true, reason: "x", force: true });
    expect(forced.writable).toHaveLength(51);
    expect(forced.applied).toBe("all");
  });

  it("T9: protected issues are never written, even with --force", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-010", { title: "Reserved", earmark: EARMARK_RESERVED });
    issue(dir, "ISS-011", { title: "Being worked", status: "inprogress" });
    issue(dir, "ISS-012", { title: "Conflicted", _conflicts: CONFLICT });
    issue(dir, "ISS-013", { title: "Tombstoned", lifecycle: "deleted", deletedAt: "2026-10-01T00:00:00.000Z", deletedBy: "test" });
    const before = snapshot(dir);
    const d = await apply(dir, { ids: ["ISS-001", "ISS-010", "ISS-011", "ISS-012", "ISS-013"], status: ["open", "inprogress"], resolve: true, reason: "x", force: true });
    expect(ids(d.writable)).toEqual(["ISS-001"]);
    for (const id of ["ISS-010", "ISS-011", "ISS-012", "ISS-013"]) {
      const rel = join(".story", "issues", `${id}.json`);
      expect(snapshot(dir).get(rel), id).toBe(before.get(rel));
    }
  });

  it("T28: earmarked resolved issues are not written by --set-resolution-kind --apply --force", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-022", { title: "Resolved reserved", status: "resolved", resolution: "wontfix: dropped", resolvedDate: "2026-02-01", earmark: EARMARK_RESERVED });
    issue(dir, "ISS-023", { title: "Resolved assigned", status: "resolved", resolution: "wontfix: dropped", resolvedDate: "2026-02-01", earmark: EARMARK_ASSIGNED });
    const before = [fileOf(dir, "ISS-022"), fileOf(dir, "ISS-023")];
    const d = await apply(dir, { status: ["resolved"], resolutionMatches: "^wontfix:", setResolutionKind: "wontfix", force: true });
    expect(ids(d.writable)).toEqual(["ISS-004"]);
    expect([fileOf(dir, "ISS-022"), fileOf(dir, "ISS-023")]).toEqual(before);
  });

  it("T10: a not-applicable issue is never written", async () => {
    const dir = await selectorBoard();
    const before = fileOf(dir, "ISS-003");
    const d = await apply(dir, { ids: ["ISS-001", "ISS-003"], relate: "T-001" });
    expect(ids(d.notApplicable)).toEqual(["ISS-003"]);
    expect(fileOf(dir, "ISS-003")).toBe(before);
    expect(readJson(dir, "issues/ISS-001.json").relatedTickets).toEqual(["T-001"]);
    await apply(dir, { ids: ["ISS-003"], relate: "T-002" });
    expect(readJson(dir, "issues/ISS-003.json").relatedTickets).toEqual(["T-001", "T-002"]);
  });

  it("T23: an apply beside a conflicted issue writes only the writable one", async () => {
    const dir = await selectorBoard();
    issue(dir, "ISS-012", { title: "Conflicted", _conflicts: CONFLICT });
    const before = fileOf(dir, "ISS-012");
    const d = await apply(dir, { ids: ["ISS-001", "ISS-012"], setPhase: "p2" });
    expect(ids(d.writable)).toEqual(["ISS-001"]);
    expect(readJson(dir, "issues/ISS-001.json").phase).toBe("p2");
    expect(fileOf(dir, "ISS-012")).toBe(before);
  });

  it("T11: each run computes its set under its own lock; an issue resolved after a dry run is not written", async () => {
    const dir = await selectorBoard();
    const dry = await triage(dir, { olderThan: 90, resolve: true, reason: "x" });
    expect(ids(dry.writable)).toEqual(["ISS-001", "ISS-003"]);
    await handleIssueUpdate("ISS-001", { status: "resolved", resolution: "fixed elsewhere" }, "json", dir);
    const between = fileOf(dir, "ISS-001");
    const d = await apply(dir, { olderThan: 90, resolve: true, reason: "x" });
    expect(ids(d.writable)).toEqual(["ISS-003"]);
    expect(fileOf(dir, "ISS-001")).toBe(between);
  });

  it("T18: a refusal while preparing one write writes none of the set", async () => {
    const dir = await selectorBoard();
    const before = snapshot(dir);
    const original = prepareIssueWriteSeams.readPrior;
    prepareIssueWriteSeams.readPrior = async (path: string) => {
      if (path.endsWith("ISS-003.json")) throw new Error("injected refusal for ISS-003");
      return original(path);
    };
    try {
      const err = await handleTriage({ olderThan: 90, resolve: true, reason: "x", apply: true }, "json", dir, { today: TODAY }).then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toContain("injected refusal for ISS-003");
    } finally {
      prepareIssueWriteSeams.readPrior = original;
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it("refuses --force without --apply, and --apply without an action", async () => {
    const dir = await selectorBoard();
    expect((await refusal(dir, { olderThan: 90, resolve: true, reason: "x", force: true })).message).toContain("--force goes with --apply");
    expect((await refusal(dir, { olderThan: 90, apply: true })).message).toContain("--apply needs an action");
  });

  it("T6: --apply runs through the parser", async () => {
    const dir = await selectorBoard();
    const r = await cli(dir, ["--ids", "ISS-001", "--set-phase", "p2", "--apply", "--format", "json"]);
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout) as { data: TriageData }).data.applied).toBe("all");
    expect(readJson(dir, "issues/ISS-001.json").phase).toBe("p2");
  });
});
