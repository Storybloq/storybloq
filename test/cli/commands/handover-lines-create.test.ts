/**
 * ISS-1499 slice B, commit 6: `handover create` with the memo (plan section
 * 6; C6, B2 create side, B9, the create steps of B3 and B8).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../../../src/core/init.js";
import { digestBytes, memoFileName, serializeLineMemo, type LineMemo } from "../../../src/core/handover-line-memo.js";
import { appendLineage, serializeLineage, splitLineage, type LineageInput } from "../../../src/core/handover-lineage.js";
import { createMemoSeams, handleHandoverCreate } from "../../../src/cli/commands/handover.js";
import { isolateEnv, runCli, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";
import * as memoModule from "../../../src/core/handover-line-memo.js";

// A targeted fs stub: while armed, a rename onto the armed memo path fails
// with EACCES, as it would for any runner, root included. Everything else
// is the real fs.
const failRenameTo: { path: string | null; hits: number } = { path: null, hits: 0 };
vi.mock("node:fs", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:fs") & { default: typeof import("node:fs") }>();
  const renameSync = (from: import("node:fs").PathLike, to: import("node:fs").PathLike): void => {
    if (failRenameTo.path !== null && String(to) === failRenameTo.path) {
      failRenameTo.hits++;
      throw Object.assign(new Error(`EACCES: permission denied, rename '${String(from)}' -> '${String(to)}'`), { code: "EACCES" });
    }
    m.renameSync(from, to);
  };
  return { ...m, renameSync, default: { ...m.default, renameSync } };
});

// Pass-through spies: the create path's two memo reads, counted.
vi.mock("../../../src/core/handover-line-memo.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../../src/core/handover-line-memo.js")>();
  return { ...m, readLineMemo: vi.fn(m.readLineMemo), resolveLineMemo: vi.fn(m.resolveLineMemo) };
});

const TASK = "task-create.1";
let env: IsolatedEnv;
beforeEach(() => { env = isolateEnv(); });
afterEach(() => {
  createMemoSeams.afterIntent = null;
  createMemoSeams.beforeFinalMemo = null;
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

const body = (id: string): string => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n`;
const linked = (id: string, attrs: LineageInput): string => appendLineage(body(id), serializeLineage(attrs).line);

interface Proj { root: string; hdir: string; mdir: string }
async function project(files: Record<string, string>): Promise<Proj> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "create" });
  const hdir = join(root, ".story", "handovers");
  for (const [n, c] of Object.entries(files)) writeFileSync(join(hdir, n), c);
  return { root, hdir, mdir: join(root, ".story", "telemetry", "handover-lines") };
}
const memoPath = (p: Proj): string => join(p.mdir, memoFileName(TASK));
function seedMemo(p: Proj, memo: Omit<LineMemo, "v" | "task">): void {
  mkdirSync(p.mdir, { recursive: true });
  writeFileSync(memoPath(p), serializeLineMemo({ v: 1, task: TASK, ...memo }));
}
const readMemo = (p: Proj): LineMemo => JSON.parse(readFileSync(memoPath(p), "utf8")) as LineMemo;
const newFiles = (p: Proj, before: readonly string[]): string[] => readdirSync(p.hdir).filter((n) => !before.includes(n));
async function create(p: Proj, args: string[]): Promise<{ exit: number; out: string; file: string; bytes: string }> {
  const before = readdirSync(p.hdir);
  const r = await runCli(p.root, ["handover", "create", "--slug", "c", ...args]);
  const made = newFiles(p, before);
  expect(made).toHaveLength(1);
  return { exit: r.exitCode ?? 0, out: r.stdout, file: made[0]!, bytes: readFileSync(join(p.hdir, made[0]!), "utf8") };
}
const lineOf = (bytes: string) => splitLineage(bytes).lineage?.lineage ?? null;
type Reply = { data: { lineage?: { linked: boolean; continues: string | null; warnings: Array<{ code: string; target: string | null; detail: string | null }>; omittedRecords?: string[] } } };

const A = "2026-11-10-01-a.md";
const O = "2026-11-09-01-o.md";

describe("B2 create side: an active memo is the parent, and the memo follows the write", () => {
  it("no flag and no content line: continues the tip, then the memo names the new file with no intent", async () => {
    const p = await project({ [A]: linked("T-1", { role: "worker" }) });
    seedMemo(p, { tip: A, writing: null });
    const r = await create(p, ["--content", body("T-2"), "--as", TASK, "--format", "json"]);
    expect(r.exit).toBe(0);
    expect(lineOf(r.bytes)?.continues).toEqual({ state: "valid", file: A });
    expect(lineOf(r.bytes)?.role).toBe("worker");
    expect((JSON.parse(r.out) as Reply).data.lineage?.continues).toBe(A);
    expect(readMemo(p)).toEqual({ v: 1, task: TASK, tip: r.file, writing: null });
  });

  it("a crash after the intent and before the file: the old tip stands", async () => {
    const p = await project({ [A]: linked("T-1", {}) });
    seedMemo(p, { tip: A, writing: null });
    let intent: LineMemo | null = null;
    createMemoSeams.afterIntent = () => { intent = readMemo(p); throw new Error("crash"); };
    await runCli(p.root, ["handover", "create", "--slug", "c", "--content", body("T-2"), "--as", TASK]);
    expect(readdirSync(p.hdir).filter((n) => n.endsWith(".md"))).toEqual([A]);
    expect(intent!.tip).toBe(A);
    expect(intent!.writing?.file).toMatch(/-c\.md$/);
    createMemoSeams.afterIntent = null;
    const next = await create(p, ["--content", body("T-3"), "--as", TASK, "--format", "json"]);
    expect(lineOf(next.bytes)?.continues).toEqual({ state: "valid", file: A });
  });

  for (const [label, size] of [["larger than 2 KB", 4_000], ["of 8,388,609 bytes", 8_388_609]] as const) {
    it(`a crash after the file and before the final write, with a handover ${label}: the next create heals by digest`, async () => {
      const p = await project({ [A]: linked("T-1", {}) });
      seedMemo(p, { tip: A, writing: null });
      const big = `${body("T-2")}\n${"x".repeat(size - body("T-2").length - 1)}`;
      createMemoSeams.beforeFinalMemo = () => { throw new Error("crash"); };
      await runCli(p.root, ["handover", "create", "--slug", "c", "--content", big, "--as", TASK]);
      const B = readdirSync(p.hdir).find((n) => n !== A && n.endsWith(".md"))!;
      expect(Buffer.byteLength(readFileSync(join(p.hdir, B)))).toBeGreaterThan(size);
      expect(readMemo(p)).toEqual({ v: 1, task: TASK, tip: A, writing: { file: B, sha256: digestBytes(readFileSync(join(p.hdir, B))) } });
      createMemoSeams.beforeFinalMemo = null;
      const next = await create(p, ["--content", body("T-3"), "--as", TASK]);
      expect(lineOf(next.bytes)?.continues).toEqual({ state: "valid", file: B });
    }, 120_000);
  }

  it("two crashes: tip O, A committed only by its intent, then a create of B dies after its intent: the session is on A", async () => {
    const aBytes = linked("T-1", { continues: O });
    const p = await project({ [O]: linked("T-0", {}), [A]: aBytes });
    seedMemo(p, { tip: O, writing: { file: A, sha256: digestBytes(Buffer.from(aBytes)) } });
    createMemoSeams.afterIntent = () => { throw new Error("crash"); };
    await runCli(p.root, ["handover", "create", "--slug", "c", "--content", body("T-2"), "--as", TASK]);
    expect(readMemo(p).tip).toBe(A);
    createMemoSeams.afterIntent = null;
    const next = await create(p, ["--content", body("T-3"), "--as", TASK]);
    expect(lineOf(next.bytes)?.continues).toEqual({ state: "valid", file: A });
  });

  it("two concurrent creates by one identity make a chain of two, not a fork", async () => {
    const p = await project({ [A]: linked("T-1", {}) });
    seedMemo(p, { tip: A, writing: null });
    process.env.CLAUDE_CODE_SESSION_ID = TASK;
    await Promise.all([
      handleHandoverCreate(body("T-2"), "one", "json", p.root, { stamp: false }),
      handleHandoverCreate(body("T-3"), "two", "json", p.root, { stamp: false }),
    ]);
    const made = readdirSync(p.hdir).filter((n) => n !== A && n.endsWith(".md"));
    expect(made).toHaveLength(2);
    const parents = made.map((n) => (lineOf(readFileSync(join(p.hdir, n), "utf8"))?.continues as { file: string }).file);
    expect(parents).toContain(A);
    expect(parents.filter((x) => made.includes(x))).toHaveLength(1);
    expect(made).toContain(readMemo(p).tip);
    expect(parents).not.toContain(readMemo(p).tip);
  });
});

describe("C6: create never fails because of the memo", () => {
  it("a stale memo naming a deleted tip: written unlinked, memo_stale, the memo's bytes and mtime unchanged", async () => {
    const p = await project({ [A]: body("T-1") });
    seedMemo(p, { tip: "2026-11-01-01-gone.md", writing: null });
    const before = readFileSync(memoPath(p));
    const mtime = statSync(memoPath(p)).mtimeMs;
    const r = await create(p, ["--content", body("T-2"), "--as", TASK, "--format", "json"]);
    expect(r.exit).toBe(0);
    expect(r.bytes).toBe(body("T-2"));
    const l = (JSON.parse(r.out) as Reply).data.lineage!;
    expect(l.linked).toBe(false);
    expect(l.warnings).toEqual([{ code: "memo_stale", target: "2026-11-01-01-gone.md", detail: "missing" }]);
    expect(readFileSync(memoPath(p))).toEqual(before);
    expect(statSync(memoPath(p)).mtimeMs).toBe(mtime);
    const md = await create(p, ["--content", body("T-3"), "--as", TASK]);
    expect(md.out).toContain("Written unlinked, on the default line: this session's handover line could not be found (2026-11-01-01-gone.md: missing).");
  });

  it("a memo whose tip is unreadable: stale unreadable, written unlinked", async () => {
    const p = await project({ [A]: body("T-1") });
    mkdirSync(join(p.hdir, "2026-11-11-01-dir.md"));
    seedMemo(p, { tip: "2026-11-11-01-dir.md", writing: null });
    const r = await create(p, ["--content", body("T-2"), "--as", TASK, "--format", "json"]);
    expect((JSON.parse(r.out) as Reply).data.lineage!.warnings).toEqual([{ code: "memo_stale", target: "2026-11-11-01-dir.md", detail: "unreadable" }]);
    expect(r.bytes).toBe(body("T-2"));
  });

  it("a mismatched writing digest: the intent is ignored and the stored tip is the parent", async () => {
    const p = await project({ [O]: linked("T-0", {}), [A]: linked("T-1", { continues: O }) });
    seedMemo(p, { tip: O, writing: { file: A, sha256: "0".repeat(64) } });
    const r = await create(p, ["--content", body("T-2"), "--as", TASK]);
    expect(lineOf(r.bytes)?.continues).toEqual({ state: "valid", file: O });
  });

  it("an unwritable memo folder: a linked write lands, exits 0 and names memo_not_written", async () => {
    const p = await project({ [A]: linked("T-1", {}) });
    mkdirSync(join(p.root, ".story", "telemetry"), { recursive: true });
    writeFileSync(p.mdir, "not a folder");
    const r = await create(p, ["--content", body("T-2"), "--continues", A, "--as", TASK, "--format", "json"]);
    expect(r.exit).toBe(0);
    expect(lineOf(r.bytes)?.continues).toEqual({ state: "valid", file: A });
    expect((JSON.parse(r.out) as Reply).data.lineage!.warnings).toEqual([{ code: "memo_not_written", target: r.file, detail: null }]);
    expect(readFileSync(p.mdir, "utf8")).toBe("not a folder");
    const md = await create(p, ["--content", body("T-3"), "--continues", r.file, "--as", TASK]);
    expect(md.out).toContain(`This session's line was not recorded; run \`storybloq handover continue ${md.file}\` to stay on it.`);
  });

  it("an invalid --as: written, exit 0, identity_invalid, and no memo read or folder made", async () => {
    const p = await project({ [A]: linked("T-1", {}) });
    // An identity in the environment is not a fallback for an invalid --as.
    process.env.CLAUDE_CODE_SESSION_ID = TASK;
    const r = await create(p, ["--content", body("T-2"), "--continues", A, "--as", "bad id", "--format", "json"]);
    expect(r.exit).toBe(0);
    expect((JSON.parse(r.out) as Reply).data.lineage!.warnings).toEqual([{ code: "identity_invalid", target: null, detail: null }]);
    expect(existsSync(p.mdir)).toBe(false);
    const md = await create(p, ["--content", body("T-3"), "--as", "bad id"]);
    expect(md.out).toContain("\n\nIgnored --as: it is not a valid client task id, so no session line was read or recorded.\n");
  });

  it("an unlinked write with an identity and no memo makes no folder and replies as main does", async () => {
    const p = await project({ [A]: body("T-1") });
    const twin = await project({ [A]: body("T-1") });
    const r = await create(p, ["--content", body("T-2"), "--as", TASK]);
    const main = await create(twin, ["--content", body("T-2")]);
    expect(r.file).toBe(main.file);
    expect(r.out).toBe(main.out);
    expect(r.out.startsWith(`Created handover: ${r.file}\n`)).toBe(true);
    expect(existsSync(p.mdir)).toBe(false);
  });

  it("a linked write with no identity writes no memo", async () => {
    const p = await project({ [A]: linked("T-1", {}) });
    const r = await create(p, ["--content", body("T-2"), "--continues", A]);
    expect(lineOf(r.bytes)?.continues).toEqual({ state: "valid", file: A });
    expect(existsSync(p.mdir)).toBe(false);
  });

  it("a --continues write with an identity still records the resolved tip as the intent's fallback", async () => {
    const p = await project({ [O]: linked("T-0", {}), [A]: linked("T-1", { continues: O }) });
    seedMemo(p, { tip: A, writing: null });
    let intent: LineMemo | null = null;
    createMemoSeams.afterIntent = () => { intent = readMemo(p); };
    const r = await create(p, ["--content", body("T-2"), "--continues", O, "--as", TASK]);
    expect(lineOf(r.bytes)?.continues).toEqual({ state: "valid", file: O });
    expect(intent!.tip).toBe(A);
    expect(readMemo(p).tip).toBe(r.file);
  });

  it("a --new-line write with an identity starts the memo at the new file, with no intent fallback", async () => {
    const p = await project({});
    let intent: LineMemo | null = null;
    createMemoSeams.afterIntent = () => { intent = readMemo(p); };
    const r = await create(p, ["--content", body("T-1"), "--new-line", "--role", "pen", "--as", TASK]);
    expect(intent!.tip).toBeNull();
    expect(intent!.writing).toEqual({ file: r.file, sha256: digestBytes(Buffer.from(r.bytes)) });
    expect(readMemo(p)).toEqual({ v: 1, task: TASK, tip: r.file, writing: null });
  });
});

describe("Codex gate on commit 6: each memo write fails alone", () => {
  it("the intent write fails and the final write lands: no memo_not_written, the memo ends finalised", async () => {
    const p = await project({ [A]: linked("T-1", {}) });
    mkdirSync(memoPath(p), { recursive: true });
    createMemoSeams.afterIntent = () => {
      expect(statSync(memoPath(p)).isDirectory()).toBe(true);
      rmSync(memoPath(p), { recursive: true });
    };
    const r = await create(p, ["--content", body("T-2"), "--continues", A, "--as", TASK, "--format", "json"]);
    expect(r.exit).toBe(0);
    expect((JSON.parse(r.out) as Reply).data.lineage!.warnings).toEqual([]);
    expect(readMemo(p)).toEqual({ v: 1, task: TASK, tip: r.file, writing: null });
  });

  it("the intent lands and the final write fails: no memo_not_written, and the next resolution heals to the new file", async () => {
    const p = await project({ [A]: linked("T-1", {}) });
    seedMemo(p, { tip: A, writing: null });
    // Armed after the intent landed, so only the final write meets the EACCES.
    createMemoSeams.beforeFinalMemo = () => { failRenameTo.path = memoPath(p); failRenameTo.hits = 0; };
    let r: Awaited<ReturnType<typeof create>>;
    try {
      r = await create(p, ["--content", body("T-2"), "--as", TASK, "--format", "json"]);
    } finally {
      failRenameTo.path = null;
    }
    expect(failRenameTo.hits).toBe(1);
    expect(readdirSync(p.mdir).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    expect(r.exit).toBe(0);
    expect((JSON.parse(r.out) as Reply).data.lineage!.warnings).toEqual([]);
    expect(readMemo(p)).toEqual({ v: 1, task: TASK, tip: A, writing: { file: r.file, sha256: digestBytes(Buffer.from(r.bytes)) } });
    createMemoSeams.beforeFinalMemo = null;
    const next = await create(p, ["--content", body("T-3"), "--as", TASK]);
    expect(lineOf(next.bytes)?.continues).toEqual({ state: "valid", file: r.file });
  });

  it("an invalid --as with an active memo for the environment identity: unlinked, the memo untouched and never read", async () => {
    const p = await project({ [A]: linked("T-1", {}) });
    seedMemo(p, { tip: A, writing: null });
    process.env.CLAUDE_CODE_SESSION_ID = TASK;
    const before = readFileSync(memoPath(p));
    const mtime = statSync(memoPath(p)).mtimeMs;
    vi.mocked(memoModule.readLineMemo).mockClear();
    vi.mocked(memoModule.resolveLineMemo).mockClear();
    const r = await create(p, ["--content", body("T-2"), "--as", "bad id", "--format", "json"]);
    expect(r.exit).toBe(0);
    expect(r.bytes).toBe(body("T-2"));
    expect((JSON.parse(r.out) as Reply).data.lineage!.linked).toBe(false);
    expect(vi.mocked(memoModule.readLineMemo)).not.toHaveBeenCalled();
    expect(vi.mocked(memoModule.resolveLineMemo)).not.toHaveBeenCalled();
    expect(readFileSync(memoPath(p))).toEqual(before);
    expect(statSync(memoPath(p)).mtimeMs).toBe(mtime);
  });
});

describe("B9: omitted id-less records", () => {
  const parent = "# H\n\n## Blocked\n\n- waiting on the vendor\n- **T-5** blocked on it\n- (none)\n\n## Owner rulings\n\n- pick a product name\n\n## Next steps\n\n- write tests\n";

  it("lists the parent's id-less owner-gated and blocked labels the content drops, never a kept one or a placeholder; appends nothing", async () => {
    const p = await project({ [A]: appendLineage(parent, serializeLineage({}).line) });
    const content = "# H2\n\n## Blocked\n\n-   Waiting ON  the vendor\n\n## Next steps\n\n- write more tests\n";
    const r = await create(p, ["--content", content, "--continues", A, "--format", "json"]);
    expect((JSON.parse(r.out) as Reply).data.lineage!.omittedRecords).toEqual(["pick a product name"]);
    expect(splitLineage(r.bytes).body).toBe(content);
    const md = await create(p, ["--content", content, "--continues", A]);
    expect(md.out).toContain("Not carried from the parent (keep, close or file):\n- pick a product name\n");
  });

  it("no key when everything is carried, and none for a parent that cannot be read", async () => {
    const p = await project({ [A]: appendLineage(parent, serializeLineage({}).line) });
    const all = "# H2\n\n## Blocked\n\n- waiting on the vendor\n\n## Owner rulings\n\n- Pick a product name\n";
    const r = await create(p, ["--content", all, "--continues", A, "--format", "json"]);
    expect((JSON.parse(r.out) as Reply).data.lineage).not.toHaveProperty("omittedRecords");
    const gone = await create(p, ["--content", all, "--continues", "2026-11-01-01-gone.md", "--format", "json"]);
    expect((JSON.parse(gone.out) as Reply).data.lineage).not.toHaveProperty("omittedRecords");
  });
});

describe("the create steps of B3 and B8", () => {
  it("after continue --fork on an unlinked non-head, the next create links to it and advances the memo", async () => {
    const U1 = "2026-11-08-01-u1.md";
    const p = await project({ [U1]: body("T-1"), "2026-11-09-01-u2.md": body("T-2") });
    const c = await runCli(p.root, ["handover", "continue", U1, "--fork", "--as", TASK]);
    expect(c.exitCode).toBe(0);
    const r = await create(p, ["--content", body("T-3"), "--as", TASK]);
    expect(lineOf(r.bytes)?.continues).toEqual({ state: "valid", file: U1 });
    expect(readMemo(p).tip).toBe(r.file);
  });

  it("an MCP create of the memo scaffold links to the tip and advances the memo", async () => {
    const p = await project({ [A]: linked("T-1", { role: "worker" }) });
    seedMemo(p, { tip: A, writing: null });
    const t = await runCli(p.root, ["handover", "template", "--as", TASK]);
    expect(lineOf(t.stdout.trimEnd())?.continues).toEqual({ state: "valid", file: A });
    process.env.CLAUDE_CODE_SESSION_ID = TASK;
    const before = readdirSync(p.hdir);
    await handleHandoverCreate(t.stdout, "mcp", "md", p.root, { surface: "mcp", stamp: false });
    const [made] = newFiles(p, before);
    expect(lineOf(readFileSync(join(p.hdir, made!), "utf8"))?.continues).toEqual({ state: "valid", file: A });
    expect(readMemo(p)).toEqual({ v: 1, task: TASK, tip: made, writing: null });
  });
});
