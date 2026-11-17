/**
 * ISS-1499 slice B, commit 7: the compact pointer (plan section 9). B10,
 * B11 and the pointer row of B13.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../../src/core/init.js";
import { memoFileName, serializeLineMemo } from "../../../src/core/handover-line-memo.js";
import { appendLineage, serializeLineage, splitLineage, type LineageInput } from "../../../src/core/handover-lineage.js";
import * as scanModule from "../../../src/core/handover-lineage-scan.js";
import { handleSessionResumePrompt } from "../../../src/cli/commands/session-compact.js";
import { isolateEnv, runCli, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

// A pass-through spy: every tail read the pointer makes, counted.
vi.mock("../../../src/core/handover-lineage-scan.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../../src/core/handover-lineage-scan.js")>();
  return { ...m, scanHandoverFile: vi.fn(m.scanHandoverFile) };
});

const here = resolve(fileURLToPath(import.meta.url), "..");
const CLI = resolve(here, "../../../dist/cli.js");
const TASK = "task-p.1";

let env: IsolatedEnv;
beforeEach(() => { env = isolateEnv(); });
afterEach(() => {
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

const body = (id: string): string => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n`;
const linked = (id: string, attrs: LineageInput): string => appendLineage(body(id), serializeLineage(attrs).line);

interface Proj { root: string; hdir: string }
async function project(files: Record<string, string>): Promise<Proj> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "pointer" });
  const hdir = join(root, ".story", "handovers");
  for (const [n, c] of Object.entries(files)) writeFileSync(join(hdir, n), c);
  return { root, hdir };
}
function seedMemo(p: Proj, task: string, tip: string | null): void {
  const mdir = join(p.root, ".story", "telemetry", "handover-lines");
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(mdir, memoFileName(task)), serializeLineMemo({ v: 1, task, tip, writing: null }));
}
async function pointer(root: string, clientTaskId?: string): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write;
  (process.stdout.write as unknown) = (c: string | Uint8Array): boolean => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  };
  try {
    await handleSessionResumePrompt({ source: "compact", cwd: root, ...(clientTaskId ? { clientTaskId } : {}) });
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}
const HEAD = "Storybloq project context was compacted.\n";
const TAIL = "To reload full project state, run: storybloq recap\n";
const named = (file: string, id: string, extra = ""): string =>
  `${HEAD}Latest handover file: ${file} (${file.slice(0, 10)}) -- Handover ${id}\n${extra}${TAIL}`;
const scans = () => vi.mocked(scanModule.scanHandoverFile);

const U = "2026-11-10-01-u.md";
const L1 = "2026-11-11-01-l1.md";
const D = "2026-11-12-01-d.md";
const O = "2026-11-14-01-o.md";

describe("B10: the compact pointer", () => {
  it("an active memo names its tip, older than the newest file, with no notice", async () => {
    const p = await project({ [U]: body("T-1"), [L1]: linked("T-2", { continues: U, role: "worker" }), [D]: body("T-3"), [O]: linked("T-4", {}) });
    seedMemo(p, TASK, L1);
    expect(await pointer(p.root, TASK)).toBe(named(L1, "T-2"));
  });

  it("the heading comes from the stripped body of a tip that has no heading of its own", async () => {
    const tipBody = appendLineage("no heading here\n", serializeLineage({ role: "pen" }).line);
    expect(splitLineage(tipBody).lineage).not.toBeNull();
    const p = await project({ [U]: body("T-1"), [L1]: tipBody, [D]: body("T-3") });
    seedMemo(p, TASK, L1);
    expect(await pointer(p.root, TASK)).toBe(`${HEAD}Latest handover file: ${L1} (2026-11-11)\n${TAIL}`);
  });

  it("a stale memo with another line sorting newest names the default line's handover, with N1", async () => {
    const p = await project({ [U]: body("T-1"), [D]: body("T-3"), [O]: linked("T-4", { role: "pen" }) });
    seedMemo(p, TASK, "2026-11-01-01-gone.md");
    expect(await pointer(p.root, TASK)).toBe(named(D, "T-3",
      "This session's handover line could not be found (2026-11-01-01-gone.md: missing). Showing the default line. To pick a line: `storybloq handover lines`, then `storybloq handover continue <file>`.\n"));
  });

  it("no memo with linked files newest names the newest default handover, with no notice", async () => {
    const p = await project({ [U]: body("T-1"), [D]: body("T-3"), "2026-11-13-01-o1.md": linked("T-5", {}), [O]: linked("T-4", { continues: "2026-11-13-01-o1.md" }) });
    expect(await pointer(p.root)).toBe(named(D, "T-3"));
    expect(await pointer(p.root, TASK)).toBe(named(D, "T-3"));
  });

  it("none of the newest 20 selectable: no file is named, the notice says so, and exactly 20 tails are read", async () => {
    const files: Record<string, string> = { [U]: body("T-1") };
    for (let i = 0; i < 25; i++) files[`2026-11-20-${String(i + 10)}-o.md`] = linked(`T-${100 + i}`, {});
    const p = await project(files);
    scans().mockClear();
    expect(await pointer(p.root)).toBe(`${HEAD}None of the newest 20 handovers is on the default line: \`storybloq handover lines\`.\n${TAIL}`);
    expect(scans()).toHaveBeenCalledTimes(20);
  });

  it("a stale memo over the same listing reads at most 20 plus the memo's own", async () => {
    const files: Record<string, string> = { [U]: body("T-1"), "2026-11-09-01-dir.md": "" };
    for (let i = 0; i < 25; i++) files[`2026-11-20-${String(i + 10)}-o.md`] = linked(`T-${100 + i}`, {});
    const p = await project(files);
    rmSync(join(p.hdir, "2026-11-09-01-dir.md"));
    mkdirSync(join(p.hdir, "2026-11-09-01-dir.md"));
    seedMemo(p, TASK, "2026-11-09-01-dir.md");
    scans().mockClear();
    const out = await pointer(p.root, TASK);
    expect(out).toContain("(2026-11-09-01-dir.md: unreadable)");
    expect(out).toContain("None of the newest 20 handovers is on the default line");
    expect(scans()).toHaveBeenCalledTimes(21);
  });

  it("with no lineage, main's choice after exactly one tail read", async () => {
    const p = await project({ [U]: body("T-1"), [D]: body("T-3") });
    scans().mockClear();
    expect(await pointer(p.root, TASK)).toBe(named(D, "T-3"));
    expect(scans()).toHaveBeenCalledTimes(1);
  });

  it("a symlink sorting newest to a linked handover: named, heading read, never throws", async () => {
    const p = await project({ [U]: body("T-1"), [L1]: linked("T-2", {}) });
    symlinkSync(join(p.hdir, U), join(p.hdir, "2026-11-30-01-link.md"));
    expect(await pointer(p.root)).toBe(named("2026-11-30-01-link.md", "T-1"));
  });

  it("a FIFO sorting newest, with and without lineage: selected as unknown with a null heading, inside the deadline", async () => {
    expect(existsSync(CLI), "dist/cli.js is built").toBe(true);
    for (const withLineage of [false, true]) {
      const p = await project(withLineage ? { [U]: body("T-1"), [O]: linked("T-4", {}) } : { [U]: body("T-1") });
      execFileSync("mkfifo", [join(p.hdir, "2026-11-30-01-pipe.md")]);
      // SIGKILL: a process blocked in open(2) cannot run a SIGTERM handler.
      const r = spawnSync(process.execPath, [CLI, "session", "resume-prompt"], {
        cwd: p.root, env: process.env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
        input: JSON.stringify({ source: "compact", cwd: p.root }),
      });
      expect(r.error, String(withLineage)).toBeUndefined();
      expect(r.signal, String(withLineage)).toBeNull();
      expect(r.stdout).toBe(`${HEAD}Latest handover file: 2026-11-30-01-pipe.md (2026-11-30)\n${TAIL}`);
    }
  }, 120_000);
});

describe("B11: two identities on one checkout, three creates each", () => {
  it("neither reads the other's handovers as its own; each sees the other in recent activity", async () => {
    const p = await project({});
    const A = "task-a.1";
    const B = "task-b.1";
    const made: Record<string, string[]> = { [A]: [], [B]: [] };
    for (let round = 0; round < 3; round++) {
      for (const [who, role] of [[A, "pen"], [B, "worker"]] as const) {
        const before = readdirSync(p.hdir);
        const args = ["handover", "create", "--slug", `${role}${round}`, "--content", body(`T-${role}-${round}`), "--as", who];
        if (round === 0) args.push("--new-line", "--role", role);
        const r = await runCli(p.root, args);
        expect(r.exitCode ?? 0).toBe(0);
        made[who]!.push(readdirSync(p.hdir).find((n) => !before.includes(n))!);
      }
    }
    for (const [me, other] of [[A, B], [B, A]] as const) {
      const mine = made[me]!;
      const theirs = made[other]!;
      const latest = await runCli(p.root, ["handover", "latest", "--count", "3", "--as", me, "--format", "json"]);
      const env3 = latest.stdout.split(/\n(?=\{\n)/).map((s) => JSON.parse(s) as { data: { filename: string; lines?: { otherLines?: { recent: Array<{ file: string }> } } } });
      expect(env3.map((e) => e.data.filename)).toEqual([...mine].reverse());
      expect(env3.at(-1)!.data.lines?.otherLines?.recent.map((x) => x.file)).toContain(theirs.at(-1));
      const template = await runCli(p.root, ["handover", "template", "--as", me]);
      expect(splitLineage(template.stdout.trimEnd()).lineage?.lineage.continues).toEqual({ state: "valid", file: mine.at(-1) });
      const ptr = await pointer(p.root, me);
      expect(ptr).toContain(`Latest handover file: ${mine.at(-1)} `);
      for (const f of theirs) expect(ptr).not.toContain(f);
    }
    expect(readFileSync(join(p.hdir, made[A]![2]!), "utf8")).toContain("T-pen-2");
  });
});
