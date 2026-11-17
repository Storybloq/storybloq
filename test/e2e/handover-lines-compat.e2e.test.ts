/**
 * ISS-1499 slice B, commit 9: end to end through the built dist, and the
 * pinned 1.16.0 dist on an opted-in project (plan section 13: C1, C5).
 *
 * C1: no existing file is rewritten, renamed or migrated by any command of
 * slices A and B, and no config key moves. Each command runs as a subprocess
 * of dist/cli.js against a tree snapshot taken before and after it; only
 * `.story/telemetry/handover-lines/` is excluded (B1 to B3 and C6 pin it).
 *
 * C5: storybloq 1.16.0, named literally (old-dists.ts installs it with
 * `npm run compat:fetch`; skipped without it, a failure in required mode),
 * lists linked handovers as ordinary files in folder order, and its own
 * create joins the default line.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { memoFileName } from "../../src/core/handover-line-memo.js";
import { appendLineage, serializeLineage, splitLineage, type LineageInput } from "../../src/core/handover-lineage.js";
import { requireOldDists } from "../compat/old-dists.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const CLI = resolve(here, "../../dist/cli.js");
const { dists, skip } = requireOldDists(["1.16.0"]);
const OLD = dists[0]?.bin ?? "";
const TASK = "task-e2e.1";

let scratch: string;
let home: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "handover-lines-e2e-")));
  home = join(scratch, "home");
  mkdirSync(home);
  writeFileSync(join(home, "gitconfig"), "");
});
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** No inherited identity, no real home, no system git config. */
const env = (): NodeJS.ProcessEnv => ({
  HOME: home,
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  STORYBLOQ_GLOBAL_DIR: join(home, "global"),
});

interface Run { status: number | null; stdout: string; stderr: string }
function run(bin: "new" | "old", root: string, args: readonly string[]): Run {
  const r = bin === "new"
    ? spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: env(), encoding: "utf8", timeout: 60_000 })
    : spawnSync(OLD, [...args], { cwd: root, env: env(), encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const body = (id: string): string => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n`;
const linked = (id: string, attrs: LineageInput): string => appendLineage(body(id), serializeLineage(attrs).line);

const U1 = "2026-11-10-01-u1.md";
const L1 = "2026-11-11-01-l1.md";
const U2 = "2026-11-12-01-u2.md";
const L2 = "2026-11-13-01-l2.md";
const O = "2026-11-14-01-o.md";
const FILES: Record<string, string> = {
  [U1]: body("T-1"),
  [L1]: linked("T-2", { role: "pen" }),
  [U2]: body("T-3"),
  [L2]: linked("T-4", { continues: L1, role: "pen" }),
  [O]: linked("T-5", { role: "worker" }),
};

function project(): string {
  const root = join(scratch, `p-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root);
  const init = run("new", root, ["init", "--name", "e2e", "--format", "json"]);
  expect(init.status, init.stderr).toBe(0);
  for (const [n, c] of Object.entries(FILES)) writeFileSync(join(root, ".story", "handovers", n), c);
  return root;
}

const MEMO_DIR = join(".story", "telemetry", "handover-lines");
/** Every file under the project, path to sha256, minus the memo folder. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (rel === MEMO_DIR || rel.startsWith(MEMO_DIR + "/")) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

describe("C1: no command rewrites, renames or migrates an existing file", () => {
  /** [label, args, whether it creates exactly one new handover] */
  const COMMANDS: ReadonlyArray<readonly [string, readonly string[], boolean]> = [
    ["list", ["handover", "list", "--format", "json"], false],
    ["latest", ["handover", "latest"], false],
    ["latest 3 json", ["handover", "latest", "--count", "3", "--format", "json"], false],
    ["latest brief", ["handover", "latest", "--count", "10", "--brief"], false],
    ["latest priming", ["handover", "latest", "--priming"], false],
    ["latest as", ["handover", "latest", "--as", TASK], false],
    ["get", ["handover", "get", L2], false],
    ["template", ["handover", "template"], false],
    ["template new line", ["handover", "template", "--new-line", "--role", "w"], false],
    ["lines", ["handover", "lines"], false],
    ["lines all", ["handover", "lines", "--all", "--format", "json"], false],
    ["continue", ["handover", "continue", L2, "--as", TASK], false],
    ["template on the line", ["handover", "template", "--as", TASK], false],
    ["create on the memo's line", ["handover", "create", "--content", body("T-6"), "--slug", "memo", "--as", TASK], true],
    ["continue default", ["handover", "continue", "--default", "--as", TASK], false],
    ["continue fork", ["handover", "continue", L1, "--fork", "--as", TASK], false],
    ["create unlinked", ["handover", "create", "--content", body("T-7"), "--slug", "plain"], true],
    ["create new line", ["handover", "create", "--content", body("T-8"), "--slug", "fresh", "--new-line", "--role", "qa"], true],
    ["create continues", ["handover", "create", "--content", body("T-9"), "--slug", "next", "--continues", O], true],
    ["validate", ["validate", "--format", "json"], false],
  ];

  it("a tree snapshot before and after every command: existing files unchanged, the only new file a created handover", () => {
    const root = project();
    const config = readFileSync(join(root, ".story", "config.json"), "utf8");
    for (const [label, args, creates] of COMMANDS) {
      const before = snapshot(root);
      const r = run("new", root, args);
      expect(r.status, `${label}: ${r.stderr}`).toBe(0);
      const after = snapshot(root);
      for (const [path, sha] of before) expect(after.get(path), `${label}: ${path}`).toBe(sha);
      const added = [...after.keys()].filter((p) => !before.has(p));
      if (creates) {
        expect(added, label).toHaveLength(1);
        expect(added[0]!, label).toMatch(/^\.story\/handovers\/[^/]+\.md$/);
      } else {
        expect(added, label).toEqual([]);
      }
    }
    expect(readFileSync(join(root, ".story", "config.json"), "utf8")).toBe(config);
    // The memo folder holds exactly the identity that opted in.
    expect(readdirSync(join(root, MEMO_DIR))).toEqual([memoFileName(TASK)]);
  }, 120_000);
});

describe.skipIf(skip !== null)(`C5: storybloq 1.16.0 on an opted-in project${skip ? ` (${skip})` : ""}`, () => {
  const json = (r: Run): unknown => {
    expect(r.status, r.stderr).toBe(0);
    return (JSON.parse(r.stdout) as { data: unknown }).data;
  };
  const docs = (r: Run): Array<{ filename: string; content: string }> => {
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split(/\n(?=\{)/).map((d) => (JSON.parse(d) as { data: { filename: string; content: string } }).data);
  };

  it("linked handovers are ordinary files in folder order, and its own create joins the default line", () => {
    const root = project();
    const hdir = join(root, ".story", "handovers");
    expect(run("new", root, ["handover", "continue", L2, "--as", TASK]).status).toBe(0);
    const memoPath = join(root, MEMO_DIR, memoFileName(TASK));
    const memo = readFileSync(memoPath);

    const folder = readdirSync(hdir).filter((n) => n.endsWith(".md")).sort().reverse();
    expect(json(run("old", root, ["handover", "list", "--format", "json"]))).toEqual(folder);
    const latest = docs(run("old", root, ["handover", "latest", "--count", String(folder.length), "--format", "json"]));
    expect(latest.map((d) => d.filename)).toEqual(folder);
    for (const d of latest) expect(d.content.trimEnd(), d.filename).toBe(readFileSync(join(hdir, d.filename), "utf8").trimEnd());

    const before = readdirSync(hdir);
    expect(run("old", root, ["handover", "create", "--content", body("T-10"), "--slug", "old", "--format", "json"]).status).toBe(0);
    const made = readdirSync(hdir).find((n) => !before.includes(n))!;
    expect(splitLineage(readFileSync(join(hdir, made), "utf8")).lineage).toBeNull();

    const lines = json(run("new", root, ["handover", "lines", "--format", "json"])) as { defaultLine: { head: string } };
    expect(lines.defaultLine.head).toBe(made);
    expect((json(run("new", root, ["handover", "latest", "--format", "json"])) as { filename: string }).filename).toBe(made);
    // The identity on another line still reads its own tip, and its memo is untouched.
    expect((json(run("new", root, ["handover", "latest", "--as", TASK, "--format", "json"])) as { filename: string }).filename).toBe(L2);
    expect(readFileSync(memoPath).equals(memo)).toBe(true);
    expect(existsSync(join(root, ".story", "config.json"))).toBe(true);
  }, 60_000);
});
