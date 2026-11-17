/**
 * ISS-1499 slice B, commit 4: the readers. `handover latest` (raw, brief,
 * priming) and `handover template` read the caller's line through the one
 * selection; every body goes through the one reader and loses its lineage
 * line; notices N1 to N4 ride in `lines`. B4 (command rows), B5, B8 except
 * the create step, the command-level rows of B13 and C8's own window.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../../src/core/init.js";
import { loadClassificationContext } from "../../../src/core/classification-context.js";
import { memoFileName, serializeLineMemo } from "../../../src/core/handover-line-memo.js";
import { appendLineage, serializeLineage } from "../../../src/core/handover-lineage.js";
import { PRIMING_RAW_BODY_MAX_BYTES } from "../../../src/core/handover-brief.js";
import { isolateEnv, runCli, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const CLI = resolve(here, "../../../dist/cli.js");
const TASK = "task-r.1";

let env: IsolatedEnv;
// The recent-activity window (commit 5) follows the clock; these rows pin
// the caller's own window, so the clock sits where no fixture is recent.
// The block itself is pinned in handover-lines-recent.test.ts.
beforeEach(() => {
  env = isolateEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-06-01T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

const body = (id: string, extra = ""): string => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n${extra}`;
const withLine = (content: string, attrs = ""): string => appendLineage(content, `<!-- storybloq-lineage v1${attrs ? " " + attrs : ""} -->`);

interface Proj { root: string; hdir: string }
async function project(seed: (put: (name: string, content: string) => void) => void): Promise<Proj> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "readers" });
  const hdir = join(root, ".story", "handovers");
  seed((name, content) => writeFileSync(join(hdir, name), content));
  return { root, hdir };
}
function seedMemo(p: Proj, tip: string | null): void {
  const mdir = join(p.root, ".story", "telemetry", "handover-lines");
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(mdir, memoFileName(TASK)), serializeLineMemo({ v: 1, task: TASK, tip, writing: null }));
}
interface Envelope { data?: Record<string, unknown>; error?: { code: string; message: string } }
async function run(root: string, args: readonly string[]): Promise<{ exit: number; out: string }> {
  const r = await runCli(root, args);
  // The CLI prints its result with one trailing newline.
  return { exit: r.exitCode ?? 0, out: r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout };
}
/** Raw JSON output is one envelope per body, joined by a newline. */
function envelopes(out: string): Envelope[] {
  return out.split(/\n(?=\{\n)/).map((s) => JSON.parse(s) as Envelope);
}
/** The bytes a reader returns for a project of the given files only. */
async function outputOf(files: Record<string, string>, args: readonly string[]): Promise<string> {
  const p = await project((put) => { for (const [n, c] of Object.entries(files)) put(n, c); });
  return (await run(p.root, args)).out;
}

/** A line U <- L1 <- L2 (memo tip L2), a newer default handover N, and another session's line O sorting newest. */
const LINE = {
  "2026-11-10-01-u.md": body("T-101"),
  "2026-11-11-01-l1.md": withLine(body("T-102"), 'continues="2026-11-10-01-u.md" role="worker"'),
  "2026-11-12-01-l2.md": withLine(body("T-103"), 'continues="2026-11-11-01-l1.md" role="worker"'),
};
const NEWER = { "2026-11-13-01-n.md": body("T-201") };
const OTHER = { "2026-11-14-01-o.md": withLine(body("T-301"), 'role="pen"') };
const STRIPPED_LINE = {
  "2026-11-10-01-u.md": body("T-101"),
  "2026-11-11-01-l1.md": body("T-102"),
  "2026-11-12-01-l2.md": body("T-103"),
};

describe("latest reads the caller's line", () => {
  it("an active memo: the tip, then its line, each body without the lineage line, no lines key without a notice", async () => {
    const p = await project((put) => { for (const [n, c] of Object.entries({ ...LINE, ...NEWER, ...OTHER })) put(n, c); });
    seedMemo(p, "2026-11-12-01-l2.md");
    const md = await run(p.root, ["handover", "latest", "--count", "3", "--as", TASK]);
    expect(md.exit).toBe(0);
    expect(md.out).toBe([body("T-103"), body("T-102"), body("T-101")].join("\n\n---\n\n"));
    const js = envelopes((await run(p.root, ["handover", "latest", "--count", "3", "--as", TASK, "--format", "json"])).out);
    expect(js.map((e) => e.data?.filename)).toEqual(["2026-11-12-01-l2.md", "2026-11-11-01-l1.md", "2026-11-10-01-u.md"]);
    expect(js.every((e) => !("lines" in (e.data ?? {})))).toBe(true);
  });

  it("no memo: the default line in today's order; another session's linked handover is never returned", async () => {
    const p = await project((put) => { for (const [n, c] of Object.entries({ ...LINE, ...NEWER, ...OTHER })) put(n, c); });
    const js = envelopes((await run(p.root, ["handover", "latest", "--count", "3", "--as", TASK, "--format", "json"])).out);
    expect(js.map((e) => e.data?.filename)).toEqual(["2026-11-13-01-n.md", "2026-11-10-01-u.md"]);
  });

  it("a stale memo: the default line and N1, as the last Markdown part and on the last JSON envelope", async () => {
    const p = await project((put) => { for (const [n, c] of Object.entries({ ...NEWER, ...OTHER })) put(n, c); });
    seedMemo(p, "2026-11-01-01-gone.md");
    const n1 = "This session's handover line could not be found (2026-11-01-01-gone.md: missing). Showing the default line. To pick a line: `storybloq handover lines`, then `storybloq handover continue <file>`.";
    const md = await run(p.root, ["handover", "latest", "--as", TASK]);
    expect(md.out).toBe(`${body("T-201")}\n\n---\n\n${n1}`);
    const js = envelopes((await run(p.root, ["handover", "latest", "--as", TASK, "--format", "json"])).out);
    expect(js).toHaveLength(1);
    expect(js[0]!.data).toEqual({ filename: "2026-11-13-01-n.md", content: body("T-201"), lines: { notices: [n1] } });
  });

  it("an empty default is a success carrying N4, in every mode", async () => {
    const p = await project((put) => { for (const [n, c] of Object.entries(OTHER)) put(n, c); });
    const n4 = "No handover on the default line. 1 handover files are on other lines: `storybloq handover lines --all`.";
    const md = await run(p.root, ["handover", "latest"]);
    expect(md).toEqual({ exit: 0, out: n4 });
    const js = JSON.parse((await run(p.root, ["handover", "latest", "--format", "json"])).out) as Envelope;
    expect(js.data).toEqual({ filename: null, content: null, lines: { notices: [n4] } });
    const brief = JSON.parse((await run(p.root, ["handover", "latest", "--count", "10", "--brief", "--format", "json"])).out) as Envelope;
    expect(brief.data).toMatchObject({ handovers: [], lines: { notices: [n4] } });
    const priming = await run(p.root, ["handover", "latest", "--priming"]);
    expect(priming).toEqual({ exit: 0, out: n4 });
  });

  it("an invalid --as is invalid_input", async () => {
    const p = await project((put) => { for (const [n, c] of Object.entries(NEWER)) put(n, c); });
    const js = JSON.parse((await run(p.root, ["handover", "latest", "--as", "bad id", "--format", "json"])).out) as Envelope;
    expect(js.error?.code).toBe("invalid_input");
  });
});

describe("B4 the raw fill at --count 500", () => {
  const names = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `2026-01-01-${String(from + i).padStart(4, "0")}-h.md`);

  it("a linked handover past position 200 is skipped, never returned, and the positions after it are still filled", async () => {
    const all = names(260);
    const linkedOne = all[30]!; // position 229 newest first
    const p = await project((put) => { for (const n of all) put(n, n === linkedOne ? withLine(body("T-9"), 'role="pen"') : body(n)); });
    const js = envelopes((await run(p.root, ["handover", "latest", "--count", "500", "--format", "json"])).out);
    const got = js.map((e) => e.data?.filename);
    expect(got).toHaveLength(259);
    expect(got).not.toContain(linkedOne);
    expect(got).toEqual([...all].reverse().filter((n) => n !== linkedOne));
    expect(js.some((e) => "lines" in (e.data ?? {}))).toBe(false);
  });

  it("a body that is exactly the word missing is a handover, in the first selection and past position 200", async () => {
    const solo = await project((put) => put("2026-11-13-01-m.md", "missing"));
    expect(await run(solo.root, ["handover", "latest"])).toEqual({ exit: 0, out: "missing" });
    const three = await project((put) => { put("2026-11-13-01-m.md", "missing"); put("2026-11-12-01-a.md", body("T-1")); });
    expect(envelopes((await run(three.root, ["handover", "latest", "--count", "3", "--format", "json"])).out).map((e) => e.data?.content)).toEqual(["missing", body("T-1")]);
    const all = names(260);
    const late = all[30]!; // position 229 newest first, reached only by the fill
    const p = await project((put) => { for (const n of all) put(n, n === late ? "missing" : body(n)); });
    const js = envelopes((await run(p.root, ["handover", "latest", "--count", "500", "--format", "json"])).out);
    expect(js).toHaveLength(260);
    expect(js.find((e) => e.data?.filename === late)?.data?.content).toBe("missing");
  });

  it("200 skipped bodies set limited and N3", async () => {
    const plainNew = names(200, 1000);
    const linkedMid = names(205, 500);
    const plainOld = names(5, 0);
    const p = await project((put) => {
      for (const n of [...plainNew, ...plainOld]) put(n, body("T-1"));
      for (const n of linkedMid) put(n, withLine(body("T-2"), 'role="pen"'));
    });
    const js = envelopes((await run(p.root, ["handover", "latest", "--count", "500", "--format", "json"])).out);
    expect(js).toHaveLength(200);
    expect(js[199]!.data?.lines).toEqual({ notices: ["A scan stopped at its limit; `storybloq handover lines` gives the exact view."] });
  });
});

describe("B5 the reader strip", () => {
  it("a linked handover's raw body, brief records and classification input equal those of the same body with no line; get keeps the line", async () => {
    const content = body("T-103", "\n## Blocked\n\n- **T-104** waits on the owner\n");
    const linked = withLine(content, 'role="worker"');
    const p = await project((put) => put("2026-11-12-01-l.md", linked));
    seedMemo(p, "2026-11-12-01-l.md");
    const plainOut = (args: string[]) => outputOf({ "2026-11-12-01-l.md": content }, args);
    for (const args of [["handover", "latest"], ["handover", "latest", "--brief", "--format", "json"], ["handover", "latest", "--priming"]]) {
      expect((await run(p.root, [...args, "--as", TASK])).out, args.join(" ")).toBe(await plainOut(args));
    }
    expect(loadClassificationContext(p.root, p.hdir).recentHandovers).toEqual([{ filename: "2026-11-12-01-l.md", content }]);
    expect((await run(p.root, ["handover", "get", "2026-11-12-01-l.md"])).out).toBe(linked);
  });

  it("the priming trigger measures the body without the line: 12,000 bytes stays raw, one more is structured", async () => {
    for (const extra of [0, 1]) {
      const head = body("T-103");
      const content = head + "x".repeat(PRIMING_RAW_BODY_MAX_BYTES + extra - Buffer.byteLength(head) - 1) + "\n";
      expect(Buffer.byteLength(content)).toBe(PRIMING_RAW_BODY_MAX_BYTES + extra);
      const p = await project((put) => put("2026-11-12-01-l.md", withLine(content, 'role="worker"')));
      seedMemo(p, "2026-11-12-01-l.md");
      const js = JSON.parse((await run(p.root, ["handover", "latest", "--priming", "--as", TASK, "--format", "json"])).out) as Envelope;
      const entry = (js.data?.handovers as Array<{ form: string; body?: string }>)[0]!;
      expect(entry.form).toBe(extra === 0 ? "raw" : "structured");
      if (extra === 0) expect(entry.body).toBe(content);
    }
  });
});

describe("C8 own window: competing lines change nothing in handovers[] and trajectory", () => {
  /** Five other lines, each one linked handover sorting newest. */
  const competing = (): Record<string, string> => Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`2026-12-0${i + 1}-01-c${i}.md`, withLine(body(`T-90${i}`, "x".repeat(4000)), `role="c${i}"`)]),
  );

  it("the tight cross-handover budget fixture under --brief", async () => {
    // Ten structured handovers whose full entries sit near the 14,200 byte budget.
    const own: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const items = Array.from({ length: 12 }, (_, k) => `- **T-${i}${String(k).padStart(2, "0")}** ${"label ".repeat(18)}`).join("\n");
      own[`2026-11-${String(10 + i).padStart(2, "0")}-01-own.md`] = `# H${i}\n\n## Next steps\n\n${items}\n`;
    }
    const args = ["handover", "latest", "--count", "10", "--brief", "--format", "json"];
    const alone = JSON.parse(await outputOf(own, args)) as Envelope;
    const crowded = JSON.parse(await outputOf({ ...own, ...competing() }, args)) as Envelope;
    expect(JSON.stringify(crowded.data?.handovers)).toBe(JSON.stringify(alone.data?.handovers));
    expect(JSON.stringify(crowded.data?.trajectory)).toBe(JSON.stringify(alone.data?.trajectory));
    expect((alone.data?.handovers as Array<{ form: string }>).some((h) => h.form === "index-only")).toBe(true);
  });

  it("the 12,000 byte priming boundary under --priming", async () => {
    for (const extra of [0, 1]) {
      const head = body("T-500");
      const own = { "2026-11-20-01-own.md": head + "y".repeat(PRIMING_RAW_BODY_MAX_BYTES + extra - Buffer.byteLength(head) - 1) + "\n" };
      const args = ["handover", "latest", "--count", "1", "--priming", "--format", "json"];
      const alone = JSON.parse(await outputOf(own, args)) as Envelope;
      const crowded = JSON.parse(await outputOf({ ...own, ...competing() }, args)) as Envelope;
      expect(JSON.stringify(crowded.data?.handovers)).toBe(JSON.stringify(alone.data?.handovers));
      expect(JSON.stringify(crowded.data?.trajectory)).toBe(JSON.stringify(alone.data?.trajectory));
    }
  });
});

describe("B8 template", () => {
  it("--role or --from without --new-line is invalid_input; an invalid value is invalid_input naming the attribute", async () => {
    const p = await project((put) => { for (const [n, c] of Object.entries(NEWER)) put(n, c); });
    for (const args of [["--role", "pen"], ["--from", "2026-11-13-01-n.md"]]) {
      const js = JSON.parse((await run(p.root, ["handover", "template", ...args, "--format", "json"])).out) as Envelope;
      expect(js.error?.code, args.join(" ")).toBe("invalid_input");
    }
    for (const [flag, value] of [["--role", 'bad"role'], ["--from", "../x.md"]]) {
      const js = JSON.parse((await run(p.root, ["handover", "template", "--new-line", flag!, value!, "--format", "json"])).out) as Envelope;
      expect(js.error).toEqual({ code: "invalid_input", message: `Invalid ${flag} value.` });
    }
    const bad = JSON.parse((await run(p.root, ["handover", "template", "--as", "bad id", "--format", "json"])).out) as Envelope;
    expect(bad.error?.code).toBe("invalid_input");
  });

  it("--new-line wins over a no-lineage project and over an active memo: the first-handover scaffold with the serializer's trailer", async () => {
    const empty = await outputOf({}, ["handover", "template"]);
    const line = serializeLineage({ role: "pen", from: "2026-11-13-01-n.md" }).line;
    const plainProject = await project((put) => { for (const [n, c] of Object.entries(NEWER)) put(n, c); });
    expect((await run(plainProject.root, ["handover", "template", "--new-line", "--role", "pen"])).out).toBe(appendLineage(empty, serializeLineage({ role: "pen" }).line));
    const p = await project((put) => { for (const [n, c] of Object.entries({ ...LINE, ...NEWER })) put(n, c); });
    expect((await run(p.root, ["handover", "template", "--new-line", "--role", "pen", "--from", "2026-11-13-01-n.md"])).out).toBe(appendLineage(empty, line));
    seedMemo(p, "2026-11-12-01-l2.md");
    expect((await run(p.root, ["handover", "template", "--new-line", "--as", TASK])).out).toBe(appendLineage(empty, serializeLineage({}).line));
  });

  it("an active memo: the scaffold from the line's own window, ending with the continues trailer", async () => {
    const p = await project((put) => { for (const [n, c] of Object.entries({ ...LINE, ...NEWER, ...OTHER })) put(n, c); });
    seedMemo(p, "2026-11-12-01-l2.md");
    const expected = appendLineage(await outputOf(STRIPPED_LINE, ["handover", "template"]), serializeLineage({ continues: "2026-11-12-01-l2.md" }).line);
    expect((await run(p.root, ["handover", "template", "--as", TASK])).out).toBe(expected);
  });

  it("no memo in an opted-in project: the default line's window, no trailer", async () => {
    const p = await project((put) => { for (const [n, c] of Object.entries({ ...NEWER, ...OTHER, "2026-11-09-01-d.md": body("T-150") })) put(n, c); });
    const expected = await outputOf({ ...NEWER, "2026-11-09-01-d.md": body("T-150") }, ["handover", "template"]);
    expect((await run(p.root, ["handover", "template"])).out).toBe(expected);
    expect(expected).toContain("T-201");
    expect(expected).not.toContain("T-301");
  });
});

describe("B13 command rows: a FIFO sorting newest fails fast, as an unreadable body fails today", () => {
  function fifoProject(): string {
    const root = realpathSync(mkdtempSync(join(env.base, "fifo-")));
    const r = spawnSync(process.execPath, [CLI, "init", "--name", "fifo"], { cwd: root, env: process.env, encoding: "utf8", timeout: 10_000 });
    expect(r.status, r.stderr).toBe(0);
    const hdir = join(root, ".story", "handovers");
    mkdirSync(hdir, { recursive: true });
    writeFileSync(join(hdir, "2026-11-01-01-a.md"), body("T-1"));
    execFileSync("mkfifo", [join(hdir, "2026-11-30-01-pipe.md")]);
    return root;
  }
  // SIGKILL: a process blocked in open(2) cannot run a SIGTERM handler, so a regression would outlive the deadline.
  const cli = (root: string, args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: process.env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });

  it("raw latest at count 1 and 3, --brief, --priming and template: io_error inside the deadline, no body", () => {
    expect(existsSync(CLI), "dist/cli.js is built").toBe(true);
    const root = fifoProject();
    for (const args of [["--count", "1"], ["--count", "3"], ["--count", "3", "--brief"], ["--count", "3", "--priming"]]) {
      const r = cli(root, ["handover", "latest", ...args, "--format", "json"]);
      expect(r.error, args.join(" ")).toBeUndefined();
      expect(r.signal, args.join(" ")).toBeNull();
      const out = JSON.parse(r.stdout) as Envelope;
      expect(out.error?.code, args.join(" ")).toBe("io_error");
      expect(out.error?.message).toMatch(/^Cannot read handover: /);
      expect(r.stdout).not.toContain("T-1");
    }
    const t = cli(root, ["handover", "template", "--format", "json"]);
    expect(t.error).toBeUndefined();
    expect(t.signal).toBeNull();
    expect(t.status).not.toBe(0);
    const te = JSON.parse(t.stdout) as Envelope;
    expect(te.error?.code).toBe("io_error");
    expect(te.error?.message).toContain("2026-11-30-01-pipe.md: not a regular file");
    expect(t.stdout).not.toContain("T-1");
    expect(readFileSync(join(root, ".story", "handovers", "2026-11-01-01-a.md"), "utf8")).toBe(body("T-1"));
  }, 120_000);
});
