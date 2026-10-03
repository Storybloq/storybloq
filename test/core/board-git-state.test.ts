/**
 * ISS-1107: the git-state module against real git. The porcelain parser, the
 * state table, the raw runner, the read-side budget and output cap, the commit
 * verbs, and the commit's changed-set rule.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOARD_GIT_TEXT, COMMIT_VERBS, boardUncommitted, commitVerbKey, parseStatusZ, renderBoardUncommitted,
  reportBoardWrite, runGitRaw, stateOf,
} from "../../src/core/board-git-state.js";
import { runWithBoardWriteContext, recordBoardTarget } from "../../src/core/board-write-recorder.js";
import { BOARD_WRITE_TOOLS } from "../../src/mcp/board-write-tools.js";
import { COMMANDS } from "../../src/cli/commands/reference.js";
import { cleanupTempDirs, git, headFiles, headSha, isolateGit, makeProjectRepo, tempDir } from "../mcp/board-git-fixtures.js";

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); });
afterEach(() => { restoreGit(); cleanupTempDirs(); });

async function rowState(cwd: string, path: string): Promise<string> {
  const status = await runGitRaw(cwd, ["status", "--porcelain=v1", "-z", "-uall", "--ignored=matching", "--", path]);
  const entries = parseStatusZ(status.stdout, status.truncated).entries;
  const row = entries.find((e) => e.path === path || (e.path.endsWith("/") && path.startsWith(e.path)));
  return row ? stateOf(row.xy) : "no row";
}

function repo(): string {
  const dir = tempDir("state");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  for (const name of ["mod.txt", "staged-mod.txt", "del.txt", "type.txt", "conflict.txt"]) writeFileSync(join(dir, name), `${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

describe("board git state module (ISS-1107)", () => {
  it("U1: every row of the state table, from real git", async () => {
    const dir = repo();
    writeFileSync(join(dir, "new.txt"), "new\n");
    mkdirSync(join(dir, "ignored"));
    writeFileSync(join(dir, "ignored", "x.json"), "{}\n");
    writeFileSync(join(dir, "mod.txt"), "changed\n");
    writeFileSync(join(dir, "added.txt"), "added\n");
    git(dir, "add", "added.txt");
    writeFileSync(join(dir, "staged-mod.txt"), "staged\n");
    git(dir, "add", "staged-mod.txt");
    writeFileSync(join(dir, "staged-mod.txt"), "and modified\n");
    unlinkSync(join(dir, "del.txt"));
    unlinkSync(join(dir, "type.txt"));
    symlinkSync("mod.txt", join(dir, "type.txt"));

    expect(await rowState(dir, "new.txt")).toBe("untracked");
    expect(await rowState(dir, "ignored/x.json")).toBe("ignored");
    expect(await rowState(dir, "mod.txt")).toBe("modified");
    expect(await rowState(dir, "added.txt")).toBe("staged");
    expect(await rowState(dir, "staged-mod.txt")).toBe("staged, modified");
    expect(await rowState(dir, "del.txt")).toBe("deleted");
    expect(await rowState(dir, "type.txt")).toBe("modified");
    expect(await rowState(dir, "conflict.txt")).toBe("no row");

    // A real merge conflict.
    git(dir, "checkout", "-q", "-b", "other");
    git(dir, "stash", "-q", "-u");
    writeFileSync(join(dir, "conflict.txt"), "other\n");
    git(dir, "commit", "-q", "-am", "other");
    git(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "conflict.txt"), "main\n");
    git(dir, "commit", "-q", "-am", "main");
    try { git(dir, "merge", "-q", "other"); } catch { /* conflict expected */ }
    expect(await rowState(dir, "conflict.txt")).toBe("conflict");
    expect(stateOf("AA")).toBe("conflict");
    expect(stateOf("DD")).toBe("conflict");
    expect(stateOf("RM")).toBe("staged, modified");
    expect(stateOf("XY")).toBe("unknown (XY)");
  });

  it("U2: a rename consumes both of its paths", async () => {
    const parsed = parseStatusZ("R  new.txt\0old.txt\0 M other.txt\0", false);
    expect(parsed).toEqual({
      entries: [{ xy: "R ", path: "new.txt", origPath: "old.txt" }, { xy: " M", path: "other.txt" }],
      incomplete: false,
    });
    const dir = repo();
    git(dir, "mv", "mod.txt", "moved.txt");
    writeFileSync(join(dir, "del.txt"), "edited\n");
    const status = await runGitRaw(dir, ["status", "--porcelain=v1", "-z"]);
    expect(parseStatusZ(status.stdout, false).entries).toEqual([
      { xy: " M", path: "del.txt" },
      { xy: "R ", path: "moved.txt", origPath: "mod.txt" },
    ]);
  });

  it("U3: the raw runner keeps porcelain's leading space", async () => {
    const dir = repo();
    writeFileSync(join(dir, "mod.txt"), "changed\n");
    const result = await runGitRaw(dir, ["status", "--porcelain=v1", "--", "mod.txt"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(" M mod.txt\n");
  });

  it("U4: an exhausted deadline reports timed out, and renders it", async () => {
    const { root } = await makeProjectRepo();
    const state = await boardUncommitted(root, { deadlineMs: 0 });
    expect(state).toEqual({ available: false, reason: "timed out" });
    expect(renderBoardUncommitted(state)).toBe(`${BOARD_GIT_TEXT.sectionHeading}\n\nBoard git state unavailable: timed out`);
    expect(renderBoardUncommitted({ available: false, reason: "not a repository" })).toBe("");
  });

  describe("U6: an output cap drops the trailing partial record", () => {
    const head = "?? a.json\0?? b.json\0?? c.json\0";
    const N = 3;
    it("(a) an ordinary entry cut mid-path", () => {
      const parsed = parseStatusZ(`${head}?? d.js`, true);
      expect(parsed.entries).toHaveLength(N);
      expect(parsed.incomplete).toBe(true);
    });
    it("(b) a rename cut right after its first field", () => {
      const parsed = parseStatusZ(`${head}R  new.json\0`, true);
      expect(parsed.entries).toHaveLength(N);
      expect(parsed.entries.some((e) => e.path === "new.json")).toBe(false);
      expect(parsed.incomplete).toBe(true);
    });
    it("(c) a rename cut inside its second field", () => {
      const parsed = parseStatusZ(`${head}R  new.json\0ol`, true);
      expect(parsed.entries).toHaveLength(N);
      expect(parsed.incomplete).toBe(true);
    });
    it("(d) a complete rename, then a cut ordinary entry", () => {
      const parsed = parseStatusZ(`${head}R  new.json\0old.json\0?? e.js`, true);
      expect(parsed.entries).toHaveLength(N + 1);
      expect(parsed.entries.filter((e) => e.path === "new.json")).toEqual([{ xy: "R ", path: "new.json", origPath: "old.json" }]);
      expect(parsed.incomplete).toBe(true);
    });
    it("a capped real scan is partial and truncated", async () => {
      const { root } = await makeProjectRepo();
      for (let i = 0; i < 40; i++) writeFileSync(join(root, ".story", "notes", `N-${String(i).padStart(3, "0")}.json`), "{}\n");
      const state = await boardUncommitted(root, { maxBytes: 300 });
      expect(state.available).toBe(true);
      if (!state.available) return;
      expect(state.partial).toContain("local");
      expect(state.untracked.truncated).toBe(true);
      expect(state.untracked.count).toBeGreaterThan(0);
      expect(state.untracked.count).toBeLessThan(40);
      expect(renderBoardUncommitted(state)).toContain(`Untracked (at least ${state.untracked.count})`);
    });
  });

  it("U5: every board write tool and --commit command has a commit verb", () => {
    const missing: string[] = [];
    for (const tool of BOARD_WRITE_TOOLS) {
      if (tool === "storybloq_snapshot") continue;
      if (!COMMIT_VERBS[commitVerbKey(tool)]) missing.push(tool);
    }
    for (const command of COMMANDS) {
      // `bus send --commit <sha>` predates ISS-1107: a string naming a git commit the message refers to.
      if (!command.flags.includes("--commit") || command.name === "snapshot" || command.name === "bus send") continue;
      if (!COMMIT_VERBS[commitVerbKey(command.name)]) missing.push(command.name);
    }
    expect(missing).toEqual([]);
    expect(COMMIT_VERBS.snapshot).toBeUndefined();
  });

  it("U7: the commit takes only changed files, once each; an identical rewrite reads committed", async () => {
    const { root } = await makeProjectRepo();
    const same = join(root, ".story", "notes", "N-001.json");
    const changed = join(root, ".story", "notes", "N-002.json");
    writeFileSync(same, `${JSON.stringify({ id: "N-001" })}\n`);
    writeFileSync(changed, `${JSON.stringify({ id: "N-002" })}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "notes");
    const parent = headSha(root);
    const { context } = await runWithBoardWriteContext("storybloq_note_update", true, async () => {
      writeFileSync(same, readFileSync(same, "utf-8"));
      recordBoardTarget(same, "write");
      writeFileSync(changed, `${JSON.stringify({ id: "N-002", content: "new" })}\n`);
      recordBoardTarget(changed, "write");
      recordBoardTarget(changed, "write");
    });
    const report = await reportBoardWrite(context);
    expect(git(root, "rev-list", "--count", `${parent}..HEAD`).trim()).toBe("1");
    expect(headFiles(root)).toEqual([".story/notes/N-002.json"]);
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("docs(story): N-002 updated");
    const sha = git(root, "rev-parse", "--short", "HEAD").trim();
    expect(report.lines).toEqual([
      "Git: .story/notes/N-001.json committed",
      "Git: .story/notes/N-002.json committed",
      `Git: committed ${sha}`,
    ]);
    expect(report.gitCommit).toEqual([{ repo: root, outcome: "committed", sha, paths: [".story/notes/N-002.json"] }]);
  });
});
