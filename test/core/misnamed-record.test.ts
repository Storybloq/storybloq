/**
 * ISS-1405: the writers target `<id>.json`, so a write to a record loaded
 * from a misnamed file would leave the old file behind (a second claimant,
 * ISS-1404's duplicate) and a delete would remove nothing. They refuse
 * instead, before anything is written, with a rename hint safe to paste when
 * one file is involved, and every path plus the duplicate recovery otherwise.
 *
 * The cases come from test/fixtures/misnamed-record-vectors.json, which the
 * Mac writer reads too, so the refusal bytes cannot drift.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteIssue,
  deleteTicket,
  loadProject,
  misnamedCollisionMessage,
  misnamedRecordMessage,
  shellQuote,
  withBootstrapLock,
  writeIssue,
  writeTicket,
  writeTicketUnlocked,
} from "../../src/core/project-loader.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { createResolutionWriteContext } from "../../src/core/resolution-write-guard.js";
import { RefResolutionError, resolveAndNormalizeIssueRef, resolveAndNormalizeTicketRef } from "../../src/core/ref-normalization.js";
import { handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { handleIssueUpdate } from "../../src/cli/commands/issue.js";
import { handlePhaseDelete } from "../../src/cli/commands/phase.js";
import type { Issue } from "../../src/models/issue.js";
import type { Ticket } from "../../src/models/ticket.js";

interface VectorFile { readonly name: string; readonly id: string; readonly displayId?: string }
interface Vector {
  readonly name: string;
  readonly dir: "tickets" | "issues";
  readonly files: readonly VectorFile[];
  readonly target: string;
  readonly ref: string;
  readonly expected: { readonly verdict: "hint" | "collision" | "allowed"; readonly files: readonly string[] };
  readonly duplicate: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = (JSON.parse(readFileSync(join(here, "..", "fixtures", "misnamed-record-vectors.json"), "utf-8")) as { cases: Vector[] }).cases;
const HINTS = VECTORS.filter((v) => v.expected.verdict === "hint");
const skipIfRoot = process.getuid?.() === 0 ? it.skip : it;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

const ticket = (id: string, title: string, order: number, displayId?: string, phase = "p1") => ({
  id, ...(displayId ? { displayId } : {}), title, type: "task", status: "open", phase, order,
  description: "", createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
});
const issue = (id: string, title: string, order: number, displayId?: string) => ({
  id, ...(displayId ? { displayId } : {}), title, status: "open", severity: "medium", components: [], impact: "x",
  resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [], order, phase: null,
});

/** A team-mode project (hash ids need it) with one directory holding `files`. */
function project(dir: Vector["dir"], files: readonly VectorFile[], dirs: readonly string[] = ["tickets", "issues", "notes"]): string {
  const root = mkdtempSync(join(tmpdir(), "misnamed-record-"));
  roots.push(root);
  const story = join(root, ".story");
  mkdirSync(story, { recursive: true });
  for (const d of dirs) mkdirSync(join(story, d), { recursive: true });
  writeJson(join(story, "config.json"), {
    version: 2, schemaVersion: 2, project: "test", type: "app", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true }, team: { enabled: true },
  });
  writeJson(join(story, "roadmap.json"), {
    title: "Test", date: "2026-05-26", blockers: [],
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "" }, { id: "p2", label: "P2", name: "Phase 2", description: "" }],
  });
  files.forEach((f, i) => {
    const make = dir === "tickets" ? ticket : issue;
    writeJson(join(story, dir, f.name), make(f.id, `${f.name} copy`, 10 * (i + 1), f.displayId));
  });
  return root;
}

/** Every file under `.story/`, relative, with its bytes: what a refused operation must leave alone. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".lock")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, "utf-8");
    }
  };
  walk(join(root, ".story"));
  return out;
}

function record(v: Vector): Ticket | Issue {
  const display = v.files.find((f) => f.id === v.target)?.displayId;
  return (v.dir === "tickets" ? ticket(v.target, "rewritten", 10, display) : issue(v.target, "rewritten", 10, display)) as Ticket | Issue;
}

function refusalOf(v: Vector): string {
  return v.expected.verdict === "hint"
    ? misnamedRecordMessage(v.target, v.dir, v.expected.files[0]!)
    : misnamedCollisionMessage(v.target, v.dir, v.expected.files);
}

/** A handler may throw or return its refusal; either way this is what it said. */
async function said(run: () => Promise<{ output: string }>): Promise<{ ok: boolean; text: string }> {
  return run().then(
    (r) => ({ ok: true, text: r.output }),
    (err: unknown) => ({ ok: false, text: err instanceof Error ? err.message : String(err) }),
  );
}

const canonicalPath = (root: string, v: Vector) => join(root, ".story", v.dir, `${v.target}.json`);

describe("a write to a misnamed record (ISS-1405)", () => {
  it("has vectors of every verdict, so an emptied fixture fails loudly", () => {
    for (const verdict of ["hint", "collision", "allowed"]) {
      expect(VECTORS.some((v) => v.expected.verdict === verdict)).toBe(true);
    }
  });

  it("the hint quotes both paths and names the canonical file", () => {
    expect(misnamedRecordMessage("T-001", "tickets", ".story/tickets/T-001 it's.json")).toBe(
      "T-001 is stored in .story/tickets/T-001 it's.json, whose name does not match its id. Rename it, then retry. " +
        "From the project root: git mv -- '.story/tickets/T-001 it'\\''s.json' '.story/tickets/T-001.json'",
    );
    expect(misnamedCollisionMessage("T-001", "tickets", [".story/tickets/a.json", ".story/tickets/b.json"])).toBe(
      "T-001 is stored in a file whose name does not match its id, and 2 files are involved: .story/tickets/a.json, .story/tickets/b.json. " +
        "Inspect each copy and keep what is intended: merge it into .story/tickets/T-001.json, then move the redundant copy out of .story/tickets/. " +
        "Renaming a file inside the directory does not resolve a duplicate.",
    );
  });

  it.each(["", "a b", "it's", "'", "$(echo INJECTED)", "a; echo INJECTED", "`echo INJECTED`", "a\\b"])(
    "shellQuote(%j) reaches a POSIX shell as exactly one unchanged argument",
    (value) => {
      const r = spawnSync("/bin/sh", ["-c", `printf '%s|' ${shellQuote(value)}`], { encoding: "utf-8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${value}|`);
    },
  );

  it.each(VECTORS.map((v) => [v.name, v] as const))("%s: the load's map names the claimants", async (_name, v) => {
    const { misnamedFiles } = await loadProject(project(v.dir, v.files));
    expect(misnamedFiles.get(`${v.dir}/${v.target}`)).toEqual(v.expected.verdict === "allowed" ? undefined : v.expected.files);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))("%s: a writer holding only the lock (the directory read)", async (_name, v) => {
    const root = project(v.dir, v.files);
    const before = tree(root);
    const canonicalBefore = existsSync(canonicalPath(root, v));
    const write = v.dir === "tickets" ? writeTicket(record(v) as Ticket, root) : writeIssue(record(v) as Issue, root);
    if (v.expected.verdict === "allowed") {
      await write;
      expect(JSON.parse(readFileSync(canonicalPath(root, v), "utf-8")).title).toBe("rewritten");
      return;
    }
    await expect(write).rejects.toThrow(new ProjectLoaderError("conflict", refusalOf(v)));
    expect(tree(root)).toEqual(before);
    expect(existsSync(canonicalPath(root, v))).toBe(canonicalBefore);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))("%s: the CLI update by id or display id (the bound load)", async (_name, v) => {
    const root = project(v.dir, v.files);
    const before = tree(root);
    const update = () =>
      v.dir === "tickets" ? handleTicketUpdate(v.ref, { title: "rewritten" }, "md", root) : handleIssueUpdate(v.ref, { title: "rewritten" }, "md", root);
    const r = await said(update);
    if (v.expected.verdict === "allowed") {
      expect(r.ok, r.text).toBe(true);
      expect(JSON.parse(readFileSync(canonicalPath(root, v), "utf-8")).title).toBe("rewritten");
      return;
    }
    // A duplicate is refused earlier, by the strict lock (ISS-1404).
    expect(r.text).toContain(v.duplicate ? "claimed by" : refusalOf(v));
    expect(tree(root)).toEqual(before);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))("%s: delete by id or display id", async (_name, v) => {
    const root = project(v.dir, v.files);
    const before = tree(root);
    const { state } = await loadProject(root);
    const resolveRef = (ref: string) => v.dir === "tickets" ? resolveAndNormalizeTicketRef(state, ref) : resolveAndNormalizeIssueRef(state, ref);
    if (v.duplicate && v.ref !== v.target) {
      // Both claimants load, so a display id names two records and is refused as ambiguous. The code and the ref
      // only: the message's doubled id is ISS-1418's to fix.
      let refused: unknown;
      try { resolveRef(v.ref); } catch (err) { refused = err; }
      expect(refused).toBeInstanceOf(RefResolutionError);
      expect((refused as RefResolutionError).reason).toBe("ambiguous");
      expect((refused as RefResolutionError).message).toContain(`Ref "${v.ref}"`);
      expect(tree(root)).toEqual(before);
    }
    const id = v.duplicate && v.ref !== v.target ? v.target : resolveRef(v.ref);
    expect(id).toBe(v.target);
    const run = v.dir === "tickets" ? deleteTicket(id, root) : deleteIssue(id, root);
    if (v.expected.verdict === "allowed") {
      await expect(run).resolves.toEqual({ alreadyDeleted: false });
      return;
    }
    await expect(run).rejects.toThrow(new ProjectLoaderError("conflict", refusalOf(v)));
    expect(tree(root)).toEqual(before);
  });

  it("a phase delete that moves a misnamed ticket refuses before anything is written", async () => {
    const root = project("tickets", [{ name: "T-002.json", id: "T-002" }, { name: "T-001 old.json", id: "T-001" }]);
    const before = tree(root);
    const r = await said(() => handlePhaseDelete("p1", "p2", "md", root));
    expect(r.ok).toBe(false);
    expect(r.text).toContain(misnamedRecordMessage("T-001", "tickets", ".story/tickets/T-001 old.json"));
    expect(tree(root)).toEqual(before);
  });

  it.each(HINTS.map((v) => [v.name, v] as const))("%s: the hint, pasted into a shell, is the repair", async (_name, v) => {
    const root = project(v.dir, v.files);
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf-8" });
    expect(git("init", "-q").status).toBe(0);
    expect(git("add", "-A").status).toBe(0);
    const before = tree(root);
    const hint = refusalOf(v).split("From the project root: ")[1]!;
    const ran = spawnSync("/bin/sh", ["-c", hint], { cwd: root, encoding: "utf-8" });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe("");
    // Exactly one move, and nothing else: no injected command ran.
    const moved = { ...before, [`.story/${v.dir}/${v.target}.json`]: before[v.expected.files[0]!]! };
    delete moved[v.expected.files[0]!];
    expect(tree(root)).toEqual(moved);
    expect(readdirSync(root).sort()).toEqual([".git", ".story"]);
    const update = () =>
      v.dir === "tickets" ? handleTicketUpdate(v.ref, { title: "rewritten" }, "md", root) : handleIssueUpdate(v.ref, { title: "rewritten" }, "md", root);
    const r = await said(update);
    expect(r.ok, r.text).toBe(true);
    expect(JSON.parse(readFileSync(canonicalPath(root, v), "utf-8")).title).toBe("rewritten");
  });

  it("a fresh create is unaffected, and a missing directory reads as empty", async () => {
    const root = project("tickets", [], ["issues"]);
    await writeTicket(ticket("T-001", "new", 10) as Ticket, root);
    expect(existsSync(join(root, ".story", "tickets", "T-001.json"))).toBe(true);
  });

  it("a record in the directory that cannot be parsed makes the answer unknown, and the write refuses", async () => {
    const root = project("tickets", [{ name: "T-002.json", id: "T-002" }]);
    writeFileSync(join(root, ".story", "tickets", "zz.json"), "{");
    const before = tree(root);
    await expect(writeTicket(ticket("T-001", "new", 10) as Ticket, root)).rejects.toThrow("cannot read or parse .story/tickets/zz.json");
    expect(tree(root)).toEqual(before);
  });

  // A ticket's own unparseable file is left to priorForGuard (checkpoint-lifecycle's write-guard rows); every other id still cannot tell.
  it("a ticket's own file that cannot be parsed still makes the answer unknown for another id", async () => {
    const root = project("tickets", [{ name: "T-002.json", id: "T-002" }]);
    writeFileSync(join(root, ".story", "tickets", "T-001.json"), "{");
    const before = tree(root);
    await expect(writeTicket(ticket("T-003", "new", 10) as Ticket, root)).rejects.toThrow(
      "Cannot tell whether a misnamed file in .story/tickets/ claims this id: cannot read or parse .story/tickets/T-001.json",
    );
    expect(tree(root)).toEqual(before);
  });

  // The issue paths have no own-file refusal, so the guard keeps judging an issue's own file: refused, never replaced or removed.
  it("an issue's own file that cannot be parsed is refused by the write and by the delete, and stays as it was", async () => {
    const root = project("issues", [{ name: "ISS-002.json", id: "ISS-002" }]);
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), "{");
    const before = tree(root);
    const refusal = "Cannot tell whether a misnamed file in .story/issues/ claims this id: cannot read or parse .story/issues/ISS-001.json";
    await expect(writeIssue(issue("ISS-001", "new", 10) as Issue, root)).rejects.toThrow(refusal);
    expect(tree(root)).toEqual(before);
    for (const options of [undefined, { hard: true }]) {
      await expect(deleteIssue("ISS-001", root, options)).rejects.toThrow(refusal);
      expect(tree(root)).toEqual(before);
    }
  });

  skipIfRoot("a record that cannot be read makes the answer unknown, and the write refuses", async () => {
    const root = project("issues", [{ name: "ISS-002.json", id: "ISS-002" }]);
    const locked = join(root, ".story", "issues", "ISS-002.json");
    chmodSync(locked, 0o000);
    try {
      await expect(writeIssue(issue("ISS-001", "new", 10) as Issue, root)).rejects.toThrow("cannot read or parse .story/issues/ISS-002.json");
      expect(existsSync(join(root, ".story", "issues", "ISS-001.json"))).toBe(false);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  skipIfRoot("a directory that cannot be listed makes the answer unknown, and the write refuses", async () => {
    const root = project("tickets", [{ name: "T-002.json", id: "T-002" }]);
    const before = tree(root);
    const dir = join(root, ".story", "tickets");
    chmodSync(dir, 0o300);
    try {
      // The guard's own read: a writer holding only the lock, with nothing loaded (setup's bootstrap lock), reaches it.
      await expect(withBootstrapLock(root, () => writeTicketUnlocked(ticket("T-001", "new", 10) as Ticket, root))).rejects.toThrow(
        "Cannot tell whether a misnamed file in .story/tickets/ claims this id: cannot enumerate .story/tickets",
      );
      // writeTicket loads the project first (assertNoConflictsFromDisk), and the loader refuses before the guard.
      const loaded = writeTicket(ticket("T-001", "new", 10) as Ticket, root);
      await expect(loaded).rejects.toBeInstanceOf(ProjectLoaderError);
      await expect(loaded).rejects.toMatchObject({ code: "io_error", message: "Cannot enumerate .story/tickets", cause: expect.anything() });
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(tree(root)).toEqual(before);
  });

  it("the directory read is memoised per context and dropped by invalidate", () => {
    const root = project("tickets", [{ name: "T-001 old.json", id: "T-001" }]);
    const ctx = createResolutionWriteContext(root);
    expect(ctx.misnamedClaimants("tickets", "T-001")).toEqual([".story/tickets/T-001 old.json"]);
    renameSync(join(root, ".story", "tickets", "T-001 old.json"), join(root, ".story", "tickets", "T-001.json"));
    expect(ctx.misnamedClaimants("tickets", "T-001")).toEqual([".story/tickets/T-001 old.json"]);
    ctx.invalidate();
    expect(ctx.misnamedClaimants("tickets", "T-001")).toEqual([]);
  });

  it("a bound map replaces the directory read", () => {
    const root = project("tickets", [{ name: "T-001 old.json", id: "T-001" }]);
    const ctx = createResolutionWriteContext(root);
    ctx.bindMisnamed(new Map([["tickets/T-009", [".story/tickets/x.json"]]]));
    expect(ctx.misnamedClaimants("tickets", "T-001")).toEqual([]);
    expect(ctx.misnamedClaimants("tickets", "T-009")).toEqual([".story/tickets/x.json"]);
  });
});
