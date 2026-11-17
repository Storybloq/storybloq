/**
 * T-575 commit 3: `duet spawn` runs the opening stage between the role and
 * script and the launch (C11), and `--recover --open-line` replays it
 * (plan section 9: the replay surface and its safety rows). Every spawn here
 * drives an injected launcher; no client is ever started.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDuetSpawn, reconcileSpawnJournal, type DuetSpawnDeps } from "../../../src/cli/commands/duet-spawn.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { handleHandoverCreate } from "../../../src/cli/commands/handover.js";
import { initProject } from "../../../src/core/init.js";
import { memoFileName, readLineMemo } from "../../../src/core/handover-line-memo.js";
import { splitLineage } from "../../../src/core/handover-lineage.js";
import { readOpeningRecord, serializeOpeningRecord } from "../../../src/core/duet-spawn-line.js";
import { readSpawnJournal, writeSpawnJournal, type Launcher } from "../../../src/core/duet-spawn.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { runCli } from "../../fixtures/handover-lineage/harness.js";

// A read spy: while armed, every path opened through openSync or readFileSync is recorded.
const opened: { on: boolean; paths: string[] } = { on: false, paths: [] };
vi.mock("node:fs", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:fs") & { default: typeof import("node:fs") }>();
  const openSync = ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
    if (opened.on) opened.paths.push(String(path));
    return (m.openSync as (...a: unknown[]) => number)(path, ...rest);
  }) as typeof m.openSync;
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (opened.on && typeof path !== "number") opened.paths.push(String(path));
    return (m.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof m.readFileSync;
  return { ...m, openSync, readFileSync, default: { ...m.default, openSync, readFileSync } };
});

const PEN = "11111111-2222-4333-8444-555555555555";
const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("STORYBLOQ_CLIENT", "claude");
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.stubEnv("CODEX_THREAD_ID", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

async function newProject(name = "pen"): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `duet-line-${name}-`)));
  dirs.push(dir);
  await initProject(dir, { name });
  await handleTicketCreate({ title: "Bound ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", dir);
  return dir;
}

const hdir = (dir: string) => join(dir, ".story", "handovers");
const mdFiles = (dir: string) => (existsSync(hdir(dir)) ? readdirSync(hdir(dir)).filter((n) => n.endsWith(".md")).sort() : []);
const memoPath = (dir: string, task: string) => join(dir, ".story", "telemetry", "handover-lines", memoFileName(task));
const jsonData = (out: string): Record<string, any> => JSON.parse(out).data;
const body = (id: string) => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n`;

function deps(over: Partial<DuetSpawnDeps> = {}): DuetSpawnDeps {
  return { launcher: () => "fake-open", detect: () => null, client: "claude", ...over };
}
const auto = (over: Record<string, unknown> = {}) => ({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, ...over });
function onlyJournal(dir: string): string {
  const root = join(dir, ".story", "spawn");
  const found = readdirSync(root).filter((d) => !d.startsWith(".")).flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".json")).map((f) => join(root, d, f)));
  expect(found).toHaveLength(1);
  return found[0]!;
}
const recordOf = (journal: string) => journal.replace(/\.json$/, ".opening");
/** A journal writer that records the entry, then crashes once the named stage is on disk. */
const crashAfter = (stage: string) => (path: string, entry: Record<string, unknown>) => {
  writeSpawnJournal(path, entry);
  if (entry.stage === stage) throw new Error(`crash after ${stage}`);
};
async function replay(dir: string, id: string, format: "md" | "json" = "md") {
  return handleDuetSpawn({ recover: true, openLine: id }, format, dir);
}
async function refusal(p: Promise<unknown>): Promise<CliValidationError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CliValidationError);
  return err as CliValidationError;
}

describe("T-575 C11: an automatic spawn opens the worker's own line before the launch", () => {
  it("one linked worker handover, written before the launcher ran; the worker reads it, the manager does not", async () => {
    const dir = await newProject();
    let seenAtLaunch: { files: string[]; outcome: string | null } | null = null;
    const stages: string[] = [];
    const launcher: Launcher = () => {
      const j = onlyJournal(dir);
      const rec = readOpeningRecord(recordOf(j), readSpawnJournal(j)!.workerTaskId as string);
      seenAtLaunch = { files: mdFiles(dir), outcome: rec.kind === "ok" ? rec.record.outcome : null };
      return "fake-open";
    };
    const journal = (path: string, entry: Record<string, unknown>) => { stages.push(entry.stage as string); expect(entry.opening).toEqual({ mode: "new-line", board: dir, continueFile: null }); writeSpawnJournal(path, entry); };
    expect(existsSync(memoPath(dir, PEN))).toBe(false);
    const data = jsonData((await handleDuetSpawn(auto(), "json", dir, deps({ launcher, journal }))).output);
    const W = data.workerTaskId as string;
    expect(stages).toEqual(["intent", "created", "start-attempted", "started", "artifacts", "launch-attempted", "launched"]);
    const files = mdFiles(dir);
    expect(files).toHaveLength(1);
    expect(seenAtLaunch).toEqual({ files, outcome: "opened" });
    expect(data.line).toEqual({ outcome: "opened", file: files[0], from: null, board: dir, note: null });
    const text = readFileSync(join(hdir(dir), files[0]!), "utf8");
    expect(splitLineage(text).lineage?.lineage).toMatchObject({ role: "worker" });
    expect(text).toContain(`- Worker: w (task ${W})`);
    expect(text).toContain("- T-001");
    expect(readLineMemo(dir, W)?.tip).toBe(files[0]);
    const latest = await runCli(dir, ["handover", "latest", "--as", W]);
    expect(latest.stdout).toContain(`- Worker: w (task ${W})`);
    const fresh = await runCli(dir, ["handover", "latest", "--as", "fresh-identity.1"]);
    expect(fresh.stdout).not.toContain(`- Worker: w (task ${W})`);
    expect(existsSync(memoPath(dir, PEN))).toBe(false);
    const mgr = JSON.parse((await handleHandoverCreate(body("M"), "m", "json", dir, { stamp: false, clientTaskId: PEN })).output);
    expect(mgr.data.lineage?.linked ?? false).toBe(false);
    expect(existsSync(memoPath(dir, PEN))).toBe(false);
  });

  it("from is the default head when the folder has one; the md output prints the verified line", async () => {
    const dir = await newProject();
    mkdirSync(hdir(dir), { recursive: true });
    writeFileSync(join(hdir(dir), "2026-11-16-01-u.md"), body("U"));
    const out = (await handleDuetSpawn(auto(), "md", dir, deps())).output;
    const opened = mdFiles(dir).find((n) => n !== "2026-11-16-01-u.md")!;
    expect(out).toContain(`Worker handover line: opened with ${opened} (role worker), from 2026-11-16-01-u.md`);
    expect(splitLineage(readFileSync(join(hdir(dir), opened), "utf8")).lineage?.lineage.from).toBe("2026-11-16-01-u.md");
  });

  it("a stop never launches: the error names the replay and the script; --recover lists the opening as pending", async () => {
    const dir = await newProject();
    mkdirSync(join(dir, ".story", "telemetry"), { recursive: true });
    writeFileSync(join(dir, ".story", "telemetry", "handover-lines"), "not a folder");
    let launched = 0;
    const err = await handleDuetSpawn(auto(), "json", dir, deps({ launcher: () => { launched++; return "x"; } })).then(() => null, (e: Error) => e);
    expect(launched).toBe(0);
    expect(err?.message).toContain("handover line could not be established");
    const j = onlyJournal(dir);
    const entry = readSpawnJournal(j)!;
    expect(entry.stage).toBe("artifacts");
    expect(err?.message).toContain(`storybloq duet spawn --recover --open-line ${entry.workerTaskId}`);
    expect(err?.message).toContain(`then run ${entry.scriptPath}; or `);
    expect(mdFiles(dir)).toEqual([]);
    const listed = jsonData((await handleDuetSpawn({ recover: true }, "json", dir)).output).candidates[0];
    expect(listed).toMatchObject({ opening: "pending", launch: "not-launched" });
    rmSync(join(dir, ".story", "telemetry", "handover-lines"));
    const out = (await replay(dir, entry.workerTaskId as string)).output;
    expect(out).toContain("Worker handover line: opened with");
    expect(out).toContain(`Start the worker with: ${entry.scriptPath}`);
    expect(readSpawnJournal(j)!.stage).toBe("artifacts");
    expect(launched).toBe(0);
  });

  it("an intent that cannot be recorded launches on the default line and prints that row", async () => {
    const dir = await newProject();
    let launched = 0;
    const res = await handleDuetSpawn(auto(), "md", dir, deps({ launcher: () => { launched++; return "x"; }, opening: { writeRecord: () => { throw new Error("EROFS"); } } }));
    expect(launched).toBe(1);
    expect(res.output).toContain("Worker handover line: the default line (the opening intent could not be recorded). To move it: `storybloq handover continue <file>` in the worker.");
    expect(mdFiles(dir)).toEqual([]);
  });

  it("a manual arrangement runs no stage and writes no record", async () => {
    const dir = await newProject();
    const data = jsonData((await handleDuetSpawn({ name: "w", pen: "p", arrangement: "none" }, "json", dir, deps())).output);
    expect(data.line).toBeNull();
    const j = onlyJournal(dir);
    expect(readSpawnJournal(j)!.opening).toEqual({ mode: "none", board: dir, continueFile: null });
    expect(existsSync(recordOf(j))).toBe(false);
    expect(mdFiles(dir)).toEqual([]);
  });
});

describe("T-575 section 9: duet spawn --recover --open-line", () => {
  it("refuses without --recover, a malformed id, and an unknown id", async () => {
    const dir = await newProject();
    expect((await refusal(handleDuetSpawn({ name: "w", pen: "p", openLine: PEN }, "md", dir))).code).toBe("invalid_input");
    expect((await refusal(replay(dir, "not an id"))).code).toBe("invalid_input");
    expect((await refusal(replay(dir, "22222222-2222-4333-8444-555555555555"))).code).toBe("not_found");
  });

  it("a journal at artifacts with no record completes the opening and prints the script; the journal is unchanged", async () => {
    const dir = await newProject();
    await handleDuetSpawn(auto(), "json", dir, deps({ journal: crashAfter("artifacts") })).catch(() => null);
    const j = onlyJournal(dir);
    const bytes = readFileSync(j, "utf8");
    const entry = readSpawnJournal(j)!;
    expect(existsSync(recordOf(j))).toBe(false);
    const data = jsonData((await replay(dir, entry.workerTaskId as string, "json")).output);
    expect(data.line.outcome).toBe("opened");
    expect(data.startWith).toBe(entry.scriptPath);
    expect(readFileSync(j, "utf8")).toBe(bytes);
    expect(mdFiles(dir)).toHaveLength(1);
  });

  it("a journal that stopped before its artifacts is refused", async () => {
    const dir = await newProject();
    const failAt = (path: string, entry: Record<string, unknown>) => { if (entry.stage === "artifacts") throw new Error("stop"); writeSpawnJournal(path, entry); };
    await handleDuetSpawn(auto(), "json", dir, deps({ journal: failAt })).catch(() => null);
    const entry = readSpawnJournal(onlyJournal(dir))!;
    expect(entry.stage).toBe("started");
    const err = await refusal(replay(dir, entry.workerTaskId as string));
    expect(err.message).toContain("stopped before its role and script were written");
    expect(mdFiles(dir)).toEqual([]);
  });

  it("a --dir given through a symlink opens on the real board, and a replay re-derives the same board", async () => {
    const dir = await newProject();
    const node = realpathSync(mkdtempSync(join(tmpdir(), "duet-line-node-")));
    dirs.push(node);
    await initProject(node, { name: "node" });
    const link = join(mkdtempSync(join(tmpdir(), "duet-line-link-")), "node-link");
    dirs.push(join(link, ".."));
    symlinkSync(node, link);
    await handleDuetSpawn(auto({ dir: link }), "json", dir, deps({ journal: crashAfter("artifacts") })).catch(() => null);
    const entry = readSpawnJournal(onlyJournal(dir))!;
    expect(entry.opening).toEqual({ mode: "new-line", board: node, continueFile: null });
    const data = jsonData((await replay(dir, entry.workerTaskId as string, "json")).output);
    expect(data.line).toMatchObject({ outcome: "opened", board: node, from: null });
    expect(mdFiles(node)).toHaveLength(1);
    expect(mdFiles(dir)).toEqual([]);
  });

  it("a journal already launched reports the line, prints no script, and stays launched", async () => {
    const dir = await newProject();
    const first = jsonData((await handleDuetSpawn(auto(), "json", dir, deps())).output);
    const j = onlyJournal(dir);
    const bytes = readFileSync(j, "utf8");
    const out = (await replay(dir, first.workerTaskId)).output;
    expect(out).toBe(`Worker handover line: ${first.line.file} (already written; record repaired)`);
    expect(readFileSync(j, "utf8")).toBe(bytes);
    const rec = reconcileSpawnJournal(dir, readSpawnJournal(j)!, j);
    expect(rec).toMatchObject({ launch: "launched", opening: "repaired" });
    expect(mdFiles(dir)).toHaveLength(1);
  });

  describe("safety: each stops, nothing is rewritten", () => {
    async function crashed(): Promise<{ dir: string; j: string; id: string; bytes: string }> {
      const dir = await newProject();
      await handleDuetSpawn(auto(), "json", dir, deps({ journal: crashAfter("artifacts") })).catch(() => null);
      const j = onlyJournal(dir);
      return { dir, j, id: readSpawnJournal(j)!.workerTaskId as string, bytes: readFileSync(j, "utf8") };
    }
    const edit = (j: string, f: (e: Record<string, any>) => void) => {
      const e = JSON.parse(readFileSync(j, "utf8")) as Record<string, any>;
      f(e);
      writeFileSync(j, JSON.stringify(e, null, 2) + "\n");
    };

    it("a journal that is a symlink or a FIFO is never read (not found); the FIFO under an external deadline", async () => {
      const { dir, j, id, bytes } = await crashed();
      const kept = `${j}.kept`;
      renameSync(j, kept);
      // The symlink first: a reader that follows links finds the journal here and fails fast, before the FIFO could block it.
      symlinkSync(kept, j);
      expect((await refusal(replay(dir, id))).code).toBe("not_found");
      rmSync(j);
      execFileSync("mkfifo", [j]);
      const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error("blocked on a FIFO")), 5000));
      expect((await Promise.race([refusal(replay(dir, id)), deadline]) as CliValidationError).code).toBe("not_found");
      expect(readFileSync(kept, "utf8")).toBe(bytes);
      expect(mdFiles(dir)).toEqual([]);
    });

    it("a spawn directory that is a symlink is not enumerated", async () => {
      const { dir, j, id } = await crashed();
      const spawnDir = join(j, "..");
      const moved = join(dir, ".story", "elsewhere");
      renameSync(spawnDir, moved);
      symlinkSync(moved, spawnDir);
      expect((await refusal(replay(dir, id))).code).toBe("not_found");
      expect(mdFiles(dir)).toEqual([]);
    });

    it("a record that is a FIFO, a symlink or names ../ stops with the record named; the record is untouched", async () => {
      for (const kind of ["fifo", "symlink", "dotdot"] as const) {
        const { dir, j, id } = await crashed();
        const rec = recordOf(j);
        if (kind === "fifo") execFileSync("mkfifo", [rec]);
        if (kind === "symlink") { writeFileSync(join(dir, "outside.json"), "{}"); symlinkSync(join(dir, "outside.json"), rec); }
        if (kind === "dotdot") writeFileSync(rec, serializeOpeningRecord({ v: 1, task: id, intent: null, attempt: null, outcome: null, file: null }).replace('"intent": null', '"intent": { "file": "../x.md", "sha256": "' + "a".repeat(64) + '" }'));
        const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error("blocked on a FIFO")), 5000));
        const err = await Promise.race([replay(dir, id).then(() => null, (e: Error) => e), deadline]) as Error | null;
        expect(err?.message, kind).toContain(`the opening record ${rec} cannot be read`);
        expect(mdFiles(dir), kind).toEqual([]);
      }
    });

    it("a board that is not its own realpath, one that differs from the re-derived board, a bad name, a missing or non-directory workerDir: each refused", async () => {
      const cases: Array<[string, (e: Record<string, any>, dir: string, j: string) => void]> = [
        ["board via symlink", (e, dir) => { const l = join(tmpdir(), `duet-line-bl-${process.pid}-${Math.random().toString(36).slice(2)}`); symlinkSync(dir, l); dirs.push(l); e.opening.board = l; }],
        ["board mismatch", (e) => { const other = realpathSync(mkdtempSync(join(tmpdir(), "duet-line-other-"))); dirs.push(other); mkdirSync(join(other, ".story")); e.opening.board = other; }],
        ["name with a separator", (e) => { e.name = "a/w"; }],
        ["name differs from the file", (e) => { e.name = "x"; }],
        ["workerDir missing", (e) => { e.workerDir = join(tmpdir(), "duet-line-missing-dir"); }],
        ["workerDir a file", (e, dir) => { e.workerDir = join(dir, ".story", "config.json"); }],
      ];
      for (const [label, f] of cases) {
        const { dir, j, id } = await crashed();
        edit(j, (e) => f(e, dir, j));
        const before = readFileSync(j, "utf8");
        opened.paths = []; opened.on = true;
        const err = await refusal(replay(dir, id)).finally(() => { opened.on = false; });
        const spawnRoot = join(dir, ".story", "spawn") + "/";
        expect(opened.paths.filter((p) => !p.startsWith(spawnRoot)), label).toEqual([]);
        expect(err.code, label).toBe("invalid_input");
        expect(err.message, label).toContain(j);
        expect(readFileSync(j, "utf8"), label).toBe(before);
        expect(existsSync(recordOf(j)), label).toBe(false);
        expect(mdFiles(dir), label).toEqual([]);
      }
    });
  });
});
