/**
 * ISS-1499 slice A: `storybloq handover lines [--all] [--format json|md]`
 * (plan section 6, acceptance A13 and the lines part of A13b).
 *
 * Every case pins the whole md output and the whole json data object. The
 * incomplete-scan case holds a FIFO, so it runs the real command in a child
 * process with an external deadline: the command must return, not block.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../../src/core/init.js";
import { isolateEnv, runCli, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

// A passthrough of node:fs/promises whose readdir fails with EACCES for one
// chosen folder, so "the folder cannot be listed" is tested as any user.
// `passes` lets that many listings of the folder succeed first, so the
// project loader's listing can succeed while the handler's own one fails.
const denied = vi.hoisted(() => ({ dir: null as string | null, passes: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = ((path: unknown, ...rest: unknown[]) => {
    if (denied.dir !== null && String(path) === denied.dir && denied.passes-- <= 0) {
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${denied.dir}'`), { code: "EACCES" }));
    }
    return (real.readdir as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as typeof real.readdir;
  const m = { ...real, readdir };
  return { ...m, default: m };
});

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

let env: IsolatedEnv;
beforeEach(() => { env = isolateEnv(); });
afterEach(() => {
  denied.dir = null;
  denied.passes = 0;
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

type Seed = (dir: string) => void;

const write = (dir: string, name: string, body: string): void => writeFileSync(join(dir, name), body);
/** A handover body ending in a lineage line with the given attributes. */
const linked = (attrs: string): string => `# Handover\n\nwork\n\n<!-- storybloq-lineage v1${attrs ? " " + attrs : ""} -->\n`;
const plain = "# Handover\n\nwork\n";

async function project(seed: Seed): Promise<{ root: string; dir: string }> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "lineage" });
  const dir = join(root, ".story", "handovers");
  seed(dir);
  return { root, dir };
}

/** `exit` is 0, or 3 (PARTIAL) where the project loader itself warned, as for every read command. */
async function lines(root: string, extra: readonly string[] = [], exit = 0): Promise<{ md: string; json: unknown }> {
  const md = await runCli(root, ["handover", "lines", ...extra]);
  const js = await runCli(root, ["handover", "lines", ...extra, "--format", "json"]);
  expect(md.exitCode ?? 0).toBe(exit);
  expect(js.exitCode ?? 0).toBe(exit);
  const parsed = JSON.parse(js.stdout) as { version: number; data: unknown };
  expect(parsed.version).toBe(1);
  return { md: md.stdout, json: parsed.data };
}

const none = { forks: [], brokenLinks: [], loops: [], unreadable: [] };

describe("A13 handover lines", () => {
  it("no handovers at all", async () => {
    const { root } = await project(() => {});
    const r = await lines(root);
    expect(r.md).toBe("No handovers found.\n");
    expect(r.json).toEqual({ enumerated: true, complete: true, defaultLine: null, lines: [], ...none });
  });

  it("no lineage: the default line row and nothing else", async () => {
    const { root } = await project((d) => {
      write(d, "2026-11-13-02-b.md", plain);
      write(d, "2026-11-13-01-a.md", "# A\n\n<!-- storybloq-lineage v2 continues=\"2026-11-12-01-z.md\" -->\n");
      write(d, "2026-11-12-01-z.md", plain);
    });
    const r = await lines(root);
    expect(r.md).toBe("Default line: 2026-11-13-02-b.md (2026-11-13), 3 handovers\n");
    expect(r.json).toEqual({
      enumerated: true,
      complete: true,
      defaultLine: { head: "2026-11-13-02-b.md", length: 3, provisional: false, continuedBy: [] },
      lines: [],
      ...none,
    });
    expect(await lines(root, ["--all"])).toEqual(r);
  });

  it("two open lines plus the default line", async () => {
    const { root } = await project((d) => {
      write(d, "2026-11-10-01-old.md", plain);
      write(d, "2026-11-10-02-u.md", plain);
      write(d, "2026-11-11-01-m1.md", linked('continues="2026-11-10-02-u.md" role="manager" by="m@x.y"'));
      write(d, "2026-11-12-01-m2.md", linked('continues="2026-11-11-01-m1.md" role="manager" by="m@x.y"'));
      write(d, "2026-11-12-02-w1.md", linked('role="worker" by="w@x.y"'));
    });
    const r = await lines(root);
    expect(r.md).toBe(
      "Default line: 2026-11-10-02-u.md (2026-11-10), 2 handovers, continued by 2026-11-11-01-m1.md\n" +
        "Line: 2026-11-12-02-w1.md (2026-11-12), role worker, by w@x.y, 1 handover\n" +
        "Line: 2026-11-12-01-m2.md (2026-11-12), role manager, by m@x.y, 4 handovers\n",
    );
    expect(r.json).toEqual({
      enumerated: true,
      complete: true,
      defaultLine: { head: "2026-11-10-02-u.md", length: 2, provisional: false, continuedBy: ["2026-11-11-01-m1.md"] },
      lines: [
        { tip: "2026-11-12-02-w1.md", role: "worker", by: "w@x.y", date: "2026-11-12", length: 1, open: true, absorbedBy: [], forkedAt: [], end: "root", brokenTarget: null, brokenReason: null },
        { tip: "2026-11-12-01-m2.md", role: "manager", by: "m@x.y", date: "2026-11-12", length: 4, open: true, absorbedBy: [], forkedAt: [], end: "root", brokenTarget: null, brokenReason: null },
      ],
      ...none,
    });
  });

  it("a fork: both children are lines forked at the parent, and the fork is listed", async () => {
    const { root } = await project((d) => {
      write(d, "2026-11-10-01-u.md", plain);
      write(d, "2026-11-11-01-a.md", linked('continues="2026-11-10-01-u.md"'));
      write(d, "2026-11-11-02-b.md", linked('continues="2026-11-10-01-u.md" role="qa"'));
    });
    const r = await lines(root);
    expect(r.md).toBe(
      "Default line: 2026-11-10-01-u.md (2026-11-10), 1 handover, continued by 2026-11-11-02-b.md, 2026-11-11-01-a.md\n" +
        "Line: 2026-11-11-02-b.md (2026-11-11), role qa, 2 handovers, forked at 2026-11-10-01-u.md\n" +
        "Line: 2026-11-11-01-a.md (2026-11-11), 2 handovers, forked at 2026-11-10-01-u.md\n" +
        "\n" +
        "Forks:\n" +
        "- 2026-11-10-01-u.md: 2026-11-11-02-b.md, 2026-11-11-01-a.md\n",
    );
    expect(r.json).toEqual({
      enumerated: true,
      complete: true,
      defaultLine: { head: "2026-11-10-01-u.md", length: 1, provisional: false, continuedBy: ["2026-11-11-02-b.md", "2026-11-11-01-a.md"] },
      lines: [
        { tip: "2026-11-11-02-b.md", role: "qa", by: null, date: "2026-11-11", length: 2, open: true, absorbedBy: [], forkedAt: ["2026-11-10-01-u.md"], end: "root", brokenTarget: null, brokenReason: null },
        { tip: "2026-11-11-01-a.md", role: null, by: null, date: "2026-11-11", length: 2, open: true, absorbedBy: [], forkedAt: ["2026-11-10-01-u.md"], end: "root", brokenTarget: null, brokenReason: null },
      ],
      forks: [{ parent: "2026-11-10-01-u.md", children: ["2026-11-11-02-b.md", "2026-11-11-01-a.md"] }],
      brokenLinks: [],
      loops: [],
      unreadable: [],
    });
  });

  it("an absorbed tip is hidden by default and shown with --all", async () => {
    const seed: Seed = (d) => {
      write(d, "2026-11-10-01-u.md", plain);
      write(d, "2026-11-11-01-a.md", linked('continues="2026-11-10-01-u.md"'));
      write(d, "2026-11-11-02-c.md", linked('role="side"'));
      write(d, "2026-11-12-01-d.md", linked('continues="2026-11-11-01-a.md" absorbs="2026-11-11-02-c.md"'));
    };
    const { root } = await project(seed);
    const dRow = { tip: "2026-11-12-01-d.md", role: null, by: null, date: "2026-11-12", length: 3, open: true, absorbedBy: [], forkedAt: [], end: "root", brokenTarget: null, brokenReason: null };
    const cRow = { tip: "2026-11-11-02-c.md", role: "side", by: null, date: "2026-11-11", length: 1, open: false, absorbedBy: ["2026-11-12-01-d.md"], forkedAt: [], end: "root", brokenTarget: null, brokenReason: null };
    const head = { head: "2026-11-10-01-u.md", length: 1, provisional: false, continuedBy: ["2026-11-11-01-a.md"] };

    const r = await lines(root);
    expect(r.md).toBe(
      "Default line: 2026-11-10-01-u.md (2026-11-10), 1 handover, continued by 2026-11-11-01-a.md\n" +
        "Line: 2026-11-12-01-d.md (2026-11-12), 3 handovers\n",
    );
    expect(r.json).toEqual({ enumerated: true, complete: true, defaultLine: head, lines: [dRow], ...none });

    const all = await lines(root, ["--all"]);
    expect(all.md).toBe(
      "Default line: 2026-11-10-01-u.md (2026-11-10), 1 handover, continued by 2026-11-11-01-a.md\n" +
        "Line: 2026-11-12-01-d.md (2026-11-12), 3 handovers\n" +
        "Line: 2026-11-11-02-c.md (2026-11-11), role side, 1 handover, absorbed by 2026-11-12-01-d.md\n",
    );
    expect(all.json).toEqual({ enumerated: true, complete: true, defaultLine: head, lines: [dRow, cRow], ...none });
  });

  it("each broken reason, and broken from and absorbs references", async () => {
    const { root } = await project((d) => {
      write(d, "2026-11-13-01-missing.md", linked('continues="2026-01-01-01-gone.md" from="2026-01-01-02-gone.md" absorbs="2026-01-01-03-gone.md"'));
      write(d, "2026-11-13-02-invalid.md", linked('continues="a/b.md"'));
      write(d, "2026-11-13-03-self.md", linked('continues="2026-11-13-03-self.md"'));
      write(d, "2026-11-13-04-unread.md", linked('continues="2026-11-01-01-dir.md" from="2026-11-01-01-dir.md"'));
      mkdirSync(join(d, "2026-11-01-01-dir.md"));
      write(d, "notes.md", linked('role="loose"'));
    });
    const r = await lines(root);
    expect(r.md).toBe(
      "Incomplete scan: 1 file could not be read, so tips, open states and lengths below may be incomplete.\n" +
        "Line: 2026-11-13-04-unread.md (2026-11-13), 1 handover, ends at a broken link to 2026-11-01-01-dir.md (unreadable)\n" +
        "Line: 2026-11-13-03-self.md (2026-11-13), 1 handover, ends at a broken link to 2026-11-13-03-self.md (self)\n" +
        "Line: 2026-11-13-02-invalid.md (2026-11-13), 1 handover, ends at a broken link (invalid)\n" +
        "Line: 2026-11-13-01-missing.md (2026-11-13), 1 handover, ends at a broken link to 2026-01-01-01-gone.md (missing)\n" +
        "Line: notes.md (-), role loose, 1 handover\n" +
        "\n" +
        "Broken links:\n" +
        "- 2026-11-13-04-unread.md continues 2026-11-01-01-dir.md (unreadable)\n" +
        "- 2026-11-13-04-unread.md from 2026-11-01-01-dir.md (unreadable)\n" +
        "- 2026-11-13-03-self.md continues 2026-11-13-03-self.md (self)\n" +
        "- 2026-11-13-02-invalid.md continues (invalid)\n" +
        "- 2026-11-13-01-missing.md continues 2026-01-01-01-gone.md (missing)\n" +
        "- 2026-11-13-01-missing.md from 2026-01-01-02-gone.md (missing)\n" +
        "- 2026-11-13-01-missing.md absorbs 2026-01-01-03-gone.md (missing)\n" +
        "\n" +
        "Unreadable:\n" +
        "- 2026-11-01-01-dir.md (not_regular)\n",
    );
    const row = (tip: string, target: string | null, reason: string) => ({
      tip, role: null, by: null, date: "2026-11-13", length: 1, open: true, absorbedBy: [], forkedAt: [], end: "broken", brokenTarget: target, brokenReason: reason,
    });
    expect(r.json).toEqual({
      enumerated: true,
      complete: false,
      defaultLine: null,
      lines: [
        row("2026-11-13-04-unread.md", "2026-11-01-01-dir.md", "unreadable"),
        row("2026-11-13-03-self.md", "2026-11-13-03-self.md", "self"),
        row("2026-11-13-02-invalid.md", null, "invalid"),
        row("2026-11-13-01-missing.md", "2026-01-01-01-gone.md", "missing"),
        { tip: "notes.md", role: "loose", by: null, date: null, length: 1, open: true, absorbedBy: [], forkedAt: [], end: "root", brokenTarget: null, brokenReason: null },
      ],
      forks: [],
      brokenLinks: [
        { file: "2026-11-13-04-unread.md", attribute: "continues", target: "2026-11-01-01-dir.md", reason: "unreadable" },
        { file: "2026-11-13-04-unread.md", attribute: "from", target: "2026-11-01-01-dir.md", reason: "unreadable" },
        { file: "2026-11-13-03-self.md", attribute: "continues", target: "2026-11-13-03-self.md", reason: "self" },
        { file: "2026-11-13-02-invalid.md", attribute: "continues", target: null, reason: "invalid" },
        { file: "2026-11-13-01-missing.md", attribute: "continues", target: "2026-01-01-01-gone.md", reason: "missing" },
        { file: "2026-11-13-01-missing.md", attribute: "from", target: "2026-01-01-02-gone.md", reason: "missing" },
        { file: "2026-11-13-01-missing.md", attribute: "absorbs", target: "2026-01-01-03-gone.md", reason: "missing" },
      ],
      loops: [],
      unreadable: [{ file: "2026-11-01-01-dir.md", reason: "not_regular" }],
    });
  });

  it("a loop, and a tip leading into it ends with reason repeat", async () => {
    const { root } = await project((d) => {
      write(d, "2026-11-10-01-x.md", linked('continues="2026-11-10-02-y.md"'));
      write(d, "2026-11-10-02-y.md", linked('continues="2026-11-10-01-x.md"'));
      write(d, "2026-11-11-01-t.md", linked('continues="2026-11-10-01-x.md"'));
    });
    const r = await lines(root);
    expect(r.md).toBe(
      "Line: 2026-11-11-01-t.md (2026-11-11), 3 handovers, forked at 2026-11-10-01-x.md, ends at a broken link to 2026-11-10-01-x.md (repeat)\n" +
        "\n" +
        "Forks:\n" +
        "- 2026-11-10-01-x.md: 2026-11-11-01-t.md, 2026-11-10-02-y.md\n" +
        "\n" +
        "Loops:\n" +
        "- 2026-11-10-02-y.md, 2026-11-10-01-x.md\n",
    );
    expect(r.json).toEqual({
      enumerated: true,
      complete: true,
      defaultLine: null,
      lines: [
        { tip: "2026-11-11-01-t.md", role: null, by: null, date: "2026-11-11", length: 3, open: true, absorbedBy: [], forkedAt: ["2026-11-10-01-x.md"], end: "broken", brokenTarget: "2026-11-10-01-x.md", brokenReason: "repeat" },
      ],
      forks: [{ parent: "2026-11-10-01-x.md", children: ["2026-11-11-01-t.md", "2026-11-10-02-y.md"] }],
      brokenLinks: [],
      loops: [["2026-11-10-02-y.md", "2026-11-10-01-x.md"]],
      unreadable: [],
    });
  });

  it("A13b: U1, X (a symlink), U2 and a handover continuing U2: the default line is provisional and no fork is reported", async () => {
    const { root } = await project((d) => {
      write(d, "2026-11-13-03-u1.md", plain);
      write(d, "2026-11-13-01-u2.md", plain);
      symlinkSync(join(d, "2026-11-13-01-u2.md"), join(d, "2026-11-13-02-x.md"));
      write(d, "2026-11-14-01-n.md", linked('continues="2026-11-13-01-u2.md"'));
    });
    const r = await lines(root);
    expect(r.md).toBe(
      "Incomplete scan: 1 file could not be read, so tips, open states and lengths below may be incomplete.\n" +
        "Default line: 2026-11-13-03-u1.md (2026-11-13), 2 handovers, provisional\n" +
        "Line: 2026-11-14-01-n.md (2026-11-14), 2 handovers\n" +
        "\n" +
        "Unreadable:\n" +
        "- 2026-11-13-02-x.md (not_regular)\n",
    );
    expect(r.json).toEqual({
      enumerated: true,
      complete: false,
      defaultLine: { head: "2026-11-13-03-u1.md", length: 2, provisional: true, continuedBy: [] },
      lines: [
        { tip: "2026-11-14-01-n.md", role: null, by: null, date: "2026-11-14", length: 2, open: true, absorbedBy: [], forkedAt: [], end: "root", brokenTarget: null, brokenReason: null },
      ],
      forks: [],
      brokenLinks: [],
      loops: [],
      unreadable: [{ file: "2026-11-13-02-x.md", reason: "not_regular" }],
    });
  });

  it("a folder that cannot be listed: says so and prints no rows", async () => {
    const { root, dir } = await project((d) => {
      write(d, "2026-11-13-01-a.md", linked(""));
    });
    denied.dir = dir;
    // The loader's own listing fails too, so the shared read path exits PARTIAL.
    const r = await lines(root, [], 3);
    expect(r.md).toBe("Could not list the handovers folder, so no lines can be shown.\n");
    expect(r.json).toEqual({ enumerated: false, complete: false, defaultLine: null, lines: [], ...none });
  });

  it("the loader lists the folder but the command's own listing fails: enumerated false and exit 3, from the command itself", async () => {
    const { root, dir } = await project((d) => {
      write(d, "2026-11-13-01-a.md", linked(""));
    });
    for (const format of ["md", "json"] as const) {
      denied.dir = dir;
      denied.passes = 1;
      const r = await runCli(root, ["handover", "lines", "--format", format]);
      expect(denied.passes, "the loader's listing ran and succeeded, the command's was refused").toBe(-1);
      expect(r.exitCode).toBe(3);
      if (format === "json") {
        expect((JSON.parse(r.stdout) as { data: unknown }).data).toEqual({ enumerated: false, complete: false, defaultLine: null, lines: [], ...none });
      } else {
        expect(r.stdout).toBe("Could not list the handovers folder, so no lines can be shown.\n");
      }
    }
  });

  it("an incomplete scan (symlink inside, symlink outside, a directory x.md, a FIFO y.md) returns without blocking (child process, external deadline)", async () => {
    const base = realpathSync(mkdtempSync(join(env.base, "fifo-")));
    const root = join(base, "proj");
    mkdirSync(root);
    await initProject(root, { name: "lineage" });
    const dir = join(root, ".story", "handovers");
    write(dir, "2026-11-13-01-u.md", plain);
    write(dir, "2026-11-13-02-l.md", linked('continues="2026-11-13-01-u.md"'));
    symlinkSync(join(dir, "2026-11-13-02-l.md"), join(dir, "inside.md"));
    writeFileSync(join(base, "outside.md"), linked(""));
    symlinkSync(join(base, "outside.md"), join(dir, "outside.md"));
    mkdirSync(join(dir, "x.md"));
    expect(spawnSync("mkfifo", [join(dir, "y.md")]).status).toBe(0);

    const script = join(base, "lines.mts");
    writeFileSync(
      script,
        `import { runCli } from ${JSON.stringify(join(pkgRoot, "test/fixtures/handover-lineage/harness.ts"))};\n` +
        `const root = ${JSON.stringify(root)};\n` +
        "const md = await runCli(root, [\"handover\", \"lines\"]);\n" +
        "const js = await runCli(root, [\"handover\", \"lines\", \"--format\", \"json\"]);\n" +
        "process.stdout.write(JSON.stringify({ md: md.stdout, json: JSON.parse(js.stdout).data, exits: [md.exitCode ?? 0, js.exitCode ?? 0] }));\n",
    );
    const r = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: pkgRoot, timeout: 20_000, encoding: "utf8", env: process.env });
    expect(r.error, "the command blocked past the deadline").toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { md: string; json: unknown; exits: number[] };
    // A full listing with an incomplete scan is not PARTIAL: the view says complete false.
    expect(out.exits).toEqual([0, 0]);
    expect(out.md).toBe(
      "Incomplete scan: 4 files could not be read, so tips, open states and lengths below may be incomplete.\n" +
        "Default line: 2026-11-13-01-u.md (2026-11-13), 1 handover, continued by 2026-11-13-02-l.md\n" +
        "Line: 2026-11-13-02-l.md (2026-11-13), 2 handovers\n" +
        "\n" +
        "Unreadable:\n" +
        "- inside.md (not_regular)\n" +
        "- outside.md (not_regular)\n" +
        "- x.md (not_regular)\n" +
        "- y.md (not_regular)\n",
    );
    expect(out.json).toEqual({
      enumerated: true,
      complete: false,
      defaultLine: { head: "2026-11-13-01-u.md", length: 1, provisional: false, continuedBy: ["2026-11-13-02-l.md"] },
      lines: [
        { tip: "2026-11-13-02-l.md", role: null, by: null, date: "2026-11-13", length: 2, open: true, absorbedBy: [], forkedAt: [], end: "root", brokenTarget: null, brokenReason: null },
      ],
      forks: [],
      brokenLinks: [],
      loops: [],
      unreadable: [
        { file: "inside.md", reason: "not_regular" },
        { file: "outside.md", reason: "not_regular" },
        { file: "x.md", reason: "not_regular" },
        { file: "y.md", reason: "not_regular" },
      ],
    });
  }, 60_000);
});
