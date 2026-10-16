/**
 * T-486 U3 T22: a synthetic backlog shaped like the N-115 housekeeping pass,
 * worked to its end state through the built CLI only.
 *
 * The pass follows the skill's rubric: a reproducible blocking issue is linked
 * to a ticket, one that needs a product decision is marked owner_gated, and
 * issues not worth doing are resolved in bulk. The bulk step is the L-094
 * shape: the dry run is read, the premise is checked per issue, one issue is
 * dropped, and the checked --ids list is replayed with --apply. The files the
 * apply changes must be exactly the dry run's writable set.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = join(PACKAGE_ROOT, "dist", "cli.js");

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface Entry { id: string; displayId: string; reason?: string }
interface TriageData { applied: string; writable: Entry[]; protected: Entry[]; notApplicable: Entry[] }

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function cli(dir: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home") }, encoding: "utf-8", timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function triage(dir: string, ...args: string[]): TriageData {
  const r = cli(dir, "triage", ...args, "--format", "json");
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { data: TriageData }).data;
}

const ids = (entries: Entry[]): string[] => entries.map((e) => e.displayId).sort();

function issue(dir: string, id: string, fields: Record<string, unknown>): void {
  writeFileSync(join(dir, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [], impact: "",
    resolution: null, location: [], discoveredDate: daysAgo(200), resolvedDate: null, relatedTickets: [], ...fields,
  }, null, 2) + "\n");
}

function issueFiles(dir: string): Map<string, string> {
  const d = join(dir, ".story", "issues");
  return new Map(readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => [f, readFileSync(join(d, f), "utf-8")]));
}

const read = (dir: string, id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, ".story", "issues", `${id}.json`), "utf-8")) as Record<string, unknown>;

describe("T-486 U3 T22: an N-115 shaped pass through the built CLI", () => {
  it("links, gates and resolves to the recorded end state; the replayed apply writes exactly the dry run's writable set", () => {
    expect(existsSync(CLI), "dist/cli.js is built").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "t486-u3-replay-"));
    roots.push(dir);
    expect(cli(dir, "init", "--name", "t486").status).toBe(0);
    expect(cli(dir, "ticket", "create", "--title", "Fix the crash path", "--type", "task").status).toBe(0);

    issue(dir, "ISS-001", { title: "Crash on save, reproducible", severity: "high" });
    issue(dir, "ISS-002", { title: "Pricing copy needs a product call" });
    issue(dir, "ISS-003", { title: "Cosmetic: stray padding" });
    issue(dir, "ISS-004", { title: "Cosmetic: icon misaligned" });
    issue(dir, "ISS-005", { title: "Cosmetic: tooltip wording" });
    issue(dir, "ISS-006", { title: "Cosmetic: blog post contradicts the docs" });
    issue(dir, "ISS-007", { title: "Being worked", status: "inprogress" });
    issue(dir, "ISS-008", { title: "Recent", discoveredDate: daysAgo(5) });

    const survey = triage(dir, "--older-than", "90", "--status", "open,inprogress");
    expect(ids(survey.writable)).toEqual(["ISS-001", "ISS-002", "ISS-003", "ISS-004", "ISS-005", "ISS-006"]);
    expect(ids(survey.protected)).toEqual(["ISS-007"]);

    expect(triage(dir, "--ids", "ISS-001", "--relate", "T-001", "--apply").applied).toBe("all");
    expect(triage(dir, "--ids", "ISS-002", "--set-disposition", "owner_gated", "--reason", "needs a product call", "--ref", "T-001", "--apply").applied).toBe("all");

    const broad = triage(dir, "--older-than", "90", "--title-matches", "^Cosmetic", "--resolve", "--reason", "not worth scheduling", "--kind", "wontfix");
    expect(ids(broad.writable)).toEqual(["ISS-003", "ISS-004", "ISS-005", "ISS-006"]);
    // L-094: the premise is checked per issue; ISS-006 is a live contradiction, not cosmetic, so it leaves the list.
    const checked = ids(broad.writable).filter((id) => id !== "ISS-006");
    const resolveArgs = ["--ids", checked.join(","), "--resolve", "--reason", "not worth scheduling", "--kind", "wontfix"];
    const dry = triage(dir, ...resolveArgs);
    const before = issueFiles(dir);
    const applied = triage(dir, ...resolveArgs, "--apply");
    const after = issueFiles(dir);
    expect(applied.applied).toBe("all");
    expect(ids(applied.writable)).toEqual(ids(dry.writable));
    const changed = [...after.keys()].filter((f) => after.get(f) !== before.get(f)).sort();
    expect(changed).toEqual(ids(dry.writable).map((id) => `${id}.json`));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    expect(read(dir, "ISS-001").relatedTickets).toEqual(["T-001"]);
    expect(read(dir, "ISS-002")).toMatchObject({ disposition: "owner_gated", dispositionReason: "needs a product call", dispositionRef: "T-001" });
    for (const id of checked) {
      expect(read(dir, id), id).toMatchObject({ status: "resolved", resolution: "not worth scheduling", resolutionKind: { kind: "wontfix" } });
    }
    expect(read(dir, "ISS-006").status).toBe("open");
    expect(read(dir, "ISS-007").status).toBe("inprogress");
    const remaining = triage(dir, "--older-than", "90", "--status", "open,inprogress");
    expect(ids([...remaining.writable, ...remaining.protected])).toEqual(["ISS-001", "ISS-002", "ISS-006", "ISS-007"]);
  });
});
