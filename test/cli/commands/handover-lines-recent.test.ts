/**
 * ISS-1499 slice B, commit 5: recent activity on other lines in `handover
 * latest` (plan sections 8 and 9; amendment M1, C4, C9, C9a, C10, B6). The
 * clock and the time zone are pinned: 2026-11-16 03:00 UTC is 2026-11-15
 * 19:00 in Los Angeles, so a local and a UTC filename date differ by one day.
 * Local cutoff 2026-11-01, team (UTC) cutoff 2026-11-02.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../../../src/core/init.js";
import { memoFileName, serializeLineMemo } from "../../../src/core/handover-line-memo.js";
import { appendLineage, serializeLineage, type LineageInput } from "../../../src/core/handover-lineage.js";
import { LIMIT_NOTICE } from "../../../src/core/handover-selection.js";
import { OTHER_LINES_LABEL, OTHER_LINES_POINTER } from "../../../src/core/output-formatter.js";
import { withLedgerState } from "../../../src/core/ledger-state.js";
import { isolateEnv, runCli, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

/** C-v4.1 commit 7 (main): `latest` and `get` show the ledger-state line; these fixtures are not git repositories. */
const led = (text: string): string => withLedgerState(text, "md", null);

const TASK = "task-recent.1";
const NOW = new Date("2026-11-16T03:00:00Z");
let savedTz: string | undefined;
beforeAll(() => { savedTz = process.env.TZ; process.env.TZ = "America/Los_Angeles"; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

let env: IsolatedEnv;
beforeEach(() => {
  env = isolateEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

const body = (id: string): string => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n`;
const linked = (id: string, attrs: LineageInput): string => appendLineage(body(id), serializeLineage(attrs).line);

interface Proj { root: string; hdir: string }
async function project(files: Record<string, string>, opts: { team?: boolean } = {}): Promise<Proj> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "recent" });
  if (opts.team) {
    const cfgPath = join(root, ".story", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, team: { enabled: true } }, null, 2));
  }
  const hdir = join(root, ".story", "handovers");
  for (const [n, c] of Object.entries(files)) writeFileSync(join(hdir, n), c);
  return { root, hdir };
}
function seedMemo(p: Proj, tip: string): void {
  const mdir = join(p.root, ".story", "telemetry", "handover-lines");
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(mdir, memoFileName(TASK)), serializeLineMemo({ v: 1, task: TASK, tip, writing: null }));
}
interface Envelope { data?: Record<string, unknown>; error?: { code: string; message: string } }
async function run(root: string, args: readonly string[]): Promise<string> {
  const r = await runCli(root, args);
  return r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
}
const envelopes = (out: string): Envelope[] => out.split(/\n(?=\{\n)/).map((s) => JSON.parse(s) as Envelope);
const lastLines = async (root: string, args: string[]): Promise<unknown> => {
  const js = envelopes(await run(root, [...args, "--format", "json"]));
  return js[js.length - 1]!.data?.lines;
};
const entry = (file: string, role: string | null = null, by: string | null = null) => ({ file, role, by });
const blockMd = (items: Array<{ file: string; role: string | null; by: string | null }>, more = false): string =>
  [OTHER_LINES_POINTER, OTHER_LINES_LABEL, ...items.map((i) => `- ${i.file} role=${i.role ?? "-"} by=${i.by ?? "-"}`), ...(more ? ["and more"] : [])].join("\n");

describe("C4: a session with no memo after another session opted in", () => {
  it("gets the unlinked handovers in today's order plus the recent-activity entries, raw Markdown and JSON", async () => {
    const p = await project({
      "2026-11-10-01-u1.md": body("T-1"),
      "2026-11-12-01-u2.md": body("T-2"),
      "2026-11-14-01-o.md": linked("T-9", { role: "pen", by: "amir" }),
    });
    const md = await run(p.root, ["handover", "latest", "--count", "3"]);
    expect(md).toBe([led(body("T-2")), led(body("T-1")), blockMd([entry("2026-11-14-01-o.md", "pen", "amir")])].join("\n\n---\n\n"));
    const js = envelopes(await run(p.root, ["handover", "latest", "--count", "3", "--format", "json"]));
    expect(js.map((e) => e.data?.filename)).toEqual(["2026-11-12-01-u2.md", "2026-11-10-01-u1.md"]);
    expect(js[0]!.data).not.toHaveProperty("lines");
    expect(js[1]!.data?.lines).toEqual({ notices: [], otherLines: { pointer: true, recent: [entry("2026-11-14-01-o.md", "pen", "amir")], more: false } });
  });

  it("--priming alone carries the same block, outside the budget", async () => {
    const p = await project({ "2026-11-12-01-u.md": body("T-1"), "2026-11-14-01-o.md": linked("T-9", { role: "pen" }) });
    const js = JSON.parse(await run(p.root, ["handover", "latest", "--priming", "--format", "json"])) as Envelope;
    expect(js.data?.lines).toEqual({ notices: [], otherLines: { pointer: true, recent: [entry("2026-11-14-01-o.md", "pen")], more: false } });
  });
});

describe("C10: more than five recent lines", () => {
  it("lists five, newest first, says and more, and never a total", async () => {
    const files: Record<string, string> = { "2026-11-03-01-u.md": body("T-1") };
    for (let i = 1; i <= 7; i++) files[`2026-11-0${i + 2}-02-o${i}.md`] = linked(`T-${i}`, { role: `r${i}` });
    const p = await project(files);
    const md = await run(p.root, ["handover", "latest"]);
    const names = [9, 8, 7, 6, 5].map((d, k) => entry(`2026-11-0${d}-02-o${7 - k}.md`, `r${7 - k}`));
    expect(md).toBe(`${led(body("T-1"))}\n\n---\n\n${blockMd(names, true)}`);
    expect(md).not.toMatch(/\b7\b|seven/);
    expect(await lastLines(p.root, ["handover", "latest"])).toEqual({ notices: [], otherLines: { pointer: true, recent: names, more: true } });
  });

  it("a child or absorber inside the window removes a candidate; a child outside it does not", async () => {
    const p = await project({
      "2026-11-03-01-u.md": body("T-1"),
      "2026-11-05-01-a.md": linked("T-2", { role: "a" }),
      "2026-11-06-01-a2.md": linked("T-3", { continues: "2026-11-05-01-a.md", role: "a" }),
      "2026-11-07-01-b.md": linked("T-4", { role: "b" }),
      "2026-11-08-01-c.md": linked("T-5", { role: "c", absorbs: ["2026-11-07-01-b.md"] }),
      "2026-11-09-01-d.md": linked("T-6", { role: "d" }),
      "2026-10-01-01-dchild.md": linked("T-7", { continues: "2026-11-09-01-d.md", role: "d" }),
    });
    expect(await lastLines(p.root, ["handover", "latest"])).toEqual({
      notices: [],
      otherLines: { pointer: true, recent: [entry("2026-11-09-01-d.md", "d"), entry("2026-11-08-01-c.md", "c"), entry("2026-11-06-01-a2.md", "a")], more: false },
    });
  });
});

describe("B6: the caller's own set", () => {
  it("the default line's head is listed for a memo caller and not for a default caller", async () => {
    const files = {
      "2026-11-10-01-u.md": body("T-1"),
      "2026-11-12-01-mine.md": linked("T-2", { role: "worker" }),
      "2026-11-14-01-o.md": linked("T-3", { role: "pen" }),
    };
    const p = await project(files);
    seedMemo(p, "2026-11-12-01-mine.md");
    expect(await lastLines(p.root, ["handover", "latest", "--as", TASK])).toEqual({
      notices: [], otherLines: { pointer: true, recent: [entry("2026-11-14-01-o.md", "pen"), entry("2026-11-10-01-u.md")], more: false },
    });
    expect(await lastLines(p.root, ["handover", "latest"])).toEqual({
      notices: [], otherLines: { pointer: true, recent: [entry("2026-11-14-01-o.md", "pen"), entry("2026-11-12-01-mine.md", "worker")], more: false },
    });
  });

  it("an own ancestor inside the window whose connecting child is outside it is not listed", async () => {
    const p = await project({
      "2026-11-05-01-anc.md": linked("T-1", { role: "worker" }),
      "2026-10-01-01-mid.md": linked("T-2", { continues: "2026-11-05-01-anc.md" }),
      "2026-11-15-01-tip.md": linked("T-3", { continues: "2026-10-01-01-mid.md" }),
    });
    seedMemo(p, "2026-11-15-01-tip.md");
    expect(await lastLines(p.root, ["handover", "latest", "--as", TASK])).toBeUndefined();
  });

  it("a file in the selection never appears in recent, though its ancestor lies past ten names outside the window", async () => {
    const old = Array.from({ length: 10 }, (_, i) => `2026-10-${String(20 - i).padStart(2, "0")}-01-x${i}.md`);
    const files: Record<string, string> = { "2026-11-05-01-anc.md": linked("T-1", { role: "worker" }) };
    old.forEach((n, i) => { files[n] = linked(`T-${10 + i}`, { continues: i === old.length - 1 ? "2026-11-05-01-anc.md" : old[i + 1]! }); });
    files["2026-11-15-01-tip.md"] = linked("T-3", { continues: old[0]! });
    const p = await project(files);
    seedMemo(p, "2026-11-15-01-tip.md");
    // Count 12 reaches the ancestor: it is the caller's own handover.
    const js = envelopes(await run(p.root, ["handover", "latest", "--count", "12", "--as", TASK, "--format", "json"]));
    expect(js.map((e) => e.data?.filename)).toContain("2026-11-05-01-anc.md");
    expect(js[js.length - 1]!.data?.lines).toBeUndefined();
    // Count 1 does not: the marking walk stopped after ten names outside the window, so it is listed.
    expect(await lastLines(p.root, ["handover", "latest", "--as", TASK])).toEqual({
      notices: [], otherLines: { pointer: true, recent: [entry("2026-11-05-01-anc.md", "worker")], more: false },
    });
  });

  it("ten recent ancestors past the 500-name cap still count as inside the window: the scanned ancestor beyond them is not listed", async () => {
    // Listing order is by name, so the line's oldest handover can sort first.
    const chain = Array.from({ length: 10 }, (_, i) => `2026-11-13-${String(i + 10)}-x.md`);
    const files: Record<string, string> = {
      "2026-11-15-99-anc.md": linked("T-1", { role: "worker" }),
      "2026-11-15-50-tip.md": linked("T-2", { continues: chain[0]! }),
    };
    chain.forEach((n, i) => { files[n] = linked(`T-${10 + i}`, { continues: i === chain.length - 1 ? "2026-11-15-99-anc.md" : chain[i + 1]! }); });
    for (let i = 0; i < 498; i++) files[`2026-11-14-${String(1000 + i)}-f.md`] = body(`T-${100 + i}`);
    const p = await project(files);
    seedMemo(p, "2026-11-15-50-tip.md");
    const lines = (await lastLines(p.root, ["handover", "latest", "--as", TASK])) as { otherLines?: { recent: Array<{ file: string }> } };
    expect(lines.otherLines?.recent.map((r) => r.file) ?? []).not.toContain("2026-11-15-99-anc.md");
  });

  it("a line with twelve ancestors older than the window ends the marking walk normally: no N3", async () => {
    const old = Array.from({ length: 12 }, (_, i) => `2026-10-${String(20 - i).padStart(2, "0")}-01-x${i}.md`);
    const files: Record<string, string> = {};
    old.forEach((n, i) => { files[n] = i === old.length - 1 ? linked(`T-${i}`, { role: "worker" }) : linked(`T-${i}`, { continues: old[i + 1]! }); });
    files["2026-11-15-01-tip.md"] = linked("T-99", { continues: old[0]! });
    const p = await project(files);
    seedMemo(p, "2026-11-15-01-tip.md");
    expect(await run(p.root, ["handover", "latest", "--as", TASK])).toBe(led(body("T-99")));
    expect(await lastLines(p.root, ["handover", "latest", "--as", TASK])).toBeUndefined();
  });

  it("a line longer than the marking read bound sets limited and N3", async () => {
    const files: Record<string, string> = { "2026-11-15-01-tip.md": body("T-1"), "2026-11-14-01-o.md": linked("T-2", { role: "pen" }) };
    for (let i = 0; i < 205; i++) files[`2026-09-01-${String(1000 - i).padStart(4, "0")}-l.md`] = linked(`T-${i}`, { role: "z" });
    files["2026-08-01-01-old.md"] = body("T-3");
    const p = await project(files);
    seedMemo(p, "2026-11-15-01-tip.md");
    expect(await lastLines(p.root, ["handover", "latest", "--as", TASK])).toEqual({
      notices: [LIMIT_NOTICE], otherLines: { pointer: true, recent: [entry("2026-11-14-01-o.md", "pen")], more: false },
    });
    const brief = JSON.parse(await run(p.root, ["handover", "latest", "--brief", "--as", TASK, "--format", "json"])) as Envelope;
    expect((brief.data?.lines as { notices: string[] }).notices).toEqual([LIMIT_NOTICE]);
  });
});

describe("C14: a structured priming entry", () => {
  it("--priming alone keeps the block when the caller's own body is over 12,000 bytes", async () => {
    const big = `# Big\n\n## Next steps\n\n${Array.from({ length: 400 }, (_, k) => `- **T-${k}** ${"word ".repeat(8)}`).join("\n")}\n`;
    expect(Buffer.byteLength(big)).toBeGreaterThan(12_000);
    const p = await project({ "2026-11-12-01-u.md": big, "2026-11-14-01-o.md": linked("T-9", { role: "pen" }) });
    const js = JSON.parse(await run(p.root, ["handover", "latest", "--priming", "--format", "json"])) as Envelope;
    expect((js.data?.handovers as Array<{ form: string }>)[0]!.form).toBe("structured");
    expect(js.data?.lines).toEqual({ notices: [], otherLines: { pointer: true, recent: [entry("2026-11-14-01-o.md", "pen")], more: false } });
  });
});

describe("C9 and C9a: a brief with no budget left", () => {
  /** Ten structured handovers with many ids each: the index-only reserve alone overruns the budget. */
  function ownTen(): Record<string, string> {
    const own: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const items = Array.from({ length: 60 }, (_, k) => `- **T-${i}${String(k).padStart(3, "0")}** ${"label ".repeat(6)}`).join("\n");
      own[`2026-11-${String(5 + i).padStart(2, "0")}-01-own.md`] = `# H${i}\n\n## Next steps\n\n${items}\n`;
    }
    return own;
  }
  const others = {
    "2026-11-15-01-o1.md": linked("T-91", { role: "a" }),
    "2026-11-15-02-o2.md": linked("T-92", { role: "b" }),
    "2026-11-15-03-o3.md": linked("T-93", { role: "c" }),
  };

  it("the raw result lists the three lines; the brief equals the brief without them, byte for byte, in JSON and Markdown", async () => {
    const crowded = await project({ ...ownTen(), ...others });
    const alone = await project(ownTen());
    const raw = await lastLines(crowded.root, ["handover", "latest"]);
    expect((raw as { otherLines: { recent: unknown[] } }).otherLines.recent).toHaveLength(3);
    for (const format of ["json", "md"]) {
      const args = ["handover", "latest", "--count", "10", "--brief", "--format", format];
      const a = await run(alone.root, args);
      const c = await run(crowded.root, args);
      expect(c, format).toBe(a);
      expect(c).not.toContain("lines");
      expect(c).not.toContain(OTHER_LINES_POINTER);
    }
  });
});

describe("the brief with room left", () => {
  it("carries the other line's full entry under its sub-heading and leaves the caller's window unchanged", async () => {
    const own = { "2026-11-10-01-own.md": body("T-1") };
    const p = await project({ ...own, "2026-11-14-01-o.md": linked("T-9", { role: "pen" }) });
    const alone = await project(own);
    const args = ["handover", "latest", "--count", "10", "--brief", "--format", "json"];
    const c = JSON.parse(await run(p.root, args)) as Envelope;
    const a = JSON.parse(await run(alone.root, args)) as Envelope;
    expect(c.data?.handovers).toEqual(a.data?.handovers);
    expect(c.data?.trajectory).toEqual(a.data?.trajectory);
    const ol = (c.data?.lines as { otherLines: { recent: Array<{ entry?: { records: Array<{ id: string | null }> } }> } }).otherLines;
    expect(ol.recent[0]!.entry?.records.map((r) => r.id)).toEqual(["T-9"]);
    const md = await run(p.root, ["handover", "latest", "--count", "10", "--brief"]);
    expect(md).toContain(`${OTHER_LINES_LABEL}\n### 2026-11-14-01-o.md (role=pen by=-)\n## 2026-11-14-01-o.md\n- **T-9**`);
    expect(md.endsWith("carry on with T-9")).toBe(true);
  });
});

describe("the window's edge follows the board's filename date", () => {
  const files = { "2026-11-10-01-u.md": body("T-1"), "2026-11-01-01-edge.md": linked("T-9", { role: "pen" }) };

  it("local dates: 2026-11-01 is inside the window", async () => {
    const p = await project(files);
    expect(await lastLines(p.root, ["handover", "latest"])).toEqual({
      notices: [], otherLines: { pointer: true, recent: [entry("2026-11-01-01-edge.md", "pen")], more: false },
    });
  });

  it("team mode (UTC dates): 2026-11-01 is outside the window", async () => {
    const p = await project(files, { team: true });
    expect(await lastLines(p.root, ["handover", "latest"])).toBeUndefined();
    expect(await run(p.root, ["handover", "latest"])).toBe(led(body("T-1")));
  });

  it("handover create names a local file with the local date at this clock", async () => {
    const p = await project({});
    await runCli(p.root, ["handover", "create", "--content", body("T-1"), "--slug", "edge"]);
    expect(readdirSync(p.hdir)).toEqual(["2026-11-15-01-edge.md"]);
  });
});
