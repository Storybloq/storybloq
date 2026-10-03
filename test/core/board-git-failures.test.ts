/**
 * ISS-1107 round 1: git failures that real repositories rarely produce on
 * demand. A spawn stub answers the named git command with a chosen exit code
 * and stderr; every other git call runs for real against a real repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";

interface Stub { readonly command: string; readonly code: number; readonly stderr: string }
const stubs = vi.hoisted(() => ({ list: [] as Stub[], hits: [] as string[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fake = (code: number, stderr: string) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end(stderr);
      setTimeout(() => child.emit("close", code), 5);
    });
    return child;
  };
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (args[0] === "git") {
        const command = (args[1] as string[]).filter((a) => a !== "--literal-pathspecs").join(" ");
        const stub = stubs.list.find((s) => s.command === command);
        if (stub) {
          stubs.hits.push(command);
          return fake(stub.code, stub.stderr) as unknown as ReturnType<typeof actual.spawn>;
        }
      }
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});

import { boardUncommitted, renderBoardUncommitted, reportBoardWrite } from "../../src/core/board-git-state.js";
import { recordBoardTarget, runWithBoardWriteContext } from "../../src/core/board-write-recorder.js";
import { cleanupTempDirs, git, headSha, isolateGit, makeProjectRepo, porcelain } from "../mcp/board-git-fixtures.js";

let restoreGit: () => void;
beforeEach(() => {
  restoreGit = isolateGit();
  stubs.list = [];
  stubs.hits = [];
});
afterEach(() => { stubs.list = []; restoreGit(); cleanupTempDirs(); });

const REL = ".story/notes/N-001.json";

/** Writes a note and reports it, with `commit` as given. */
async function writeAndReport(root: string, commit: boolean) {
  const abs = join(root, REL);
  const { context } = await runWithBoardWriteContext("storybloq_note_create", commit, async () => {
    writeFileSync(abs, `${JSON.stringify({ id: "N-001" })}\n`);
    recordBoardTarget(abs, "write");
  });
  return reportBoardWrite(context);
}

describe("board git failures (ISS-1107 round 1)", () => {
  it("F1: an untracked symlink to a FIFO reads as its stem, marks the scan partial, and does not block", async () => {
    const { root } = await makeProjectRepo();
    const fifo = join(root, "pipe");
    execFileSync("mkfifo", [fifo]);
    symlinkSync(fifo, join(root, ".story", "notes", "N-777.json"));
    const started = Date.now();
    const state = await boardUncommitted(root, { deadlineMs: 2000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(state.available).toBe(true);
    if (!state.available) return;
    expect(state.untracked.ids).toEqual(["N-777"]);
    expect(state.partial).toEqual(["ids"]);
    expect(renderBoardUncommitted(state)).toContain("Partial scan: ids");
  });

  it("F1: a regular file still yields its display id", async () => {
    const { root } = await makeProjectRepo();
    mkdirSync(join(root, ".story", "issues"), { recursive: true });
    writeFileSync(join(root, ".story", "issues", "i-abc.json"), `${JSON.stringify({ id: "i-abc", displayId: "ISS-042" })}\n`);
    const state = await boardUncommitted(root);
    expect(state.available && state.untracked.ids).toEqual(["ISS-042"]);
    expect(state.available && state.partial).toBeUndefined();
  });

  it("F2: a HEAD lookup failing for any reason but 'no such ref' skips before staging", async () => {
    const { root } = await makeProjectRepo();
    const before = headSha(root);
    stubs.list = [{ command: "rev-parse --verify -q HEAD", code: 128, stderr: "fatal: bad object HEAD\n" }];
    const report = await writeAndReport(root, true);
    expect(stubs.hits).toContain("rev-parse --verify -q HEAD");
    expect(headSha(root)).toBe(before);
    expect(porcelain(root, REL)).toEqual([`?? ${REL}`]);
    expect(report.lines).toEqual([`Git: ${REL} untracked`, "Git: commit skipped (commit failed: fatal: bad object HEAD)"]);
    expect(report.gitCommit).toEqual([{ repo: root, outcome: "skipped", reason: "commit failed: fatal: bad object HEAD", paths: [REL] }]);
  });

  it("F2: a failed parent lookup skips before staging", async () => {
    const { root } = await makeProjectRepo();
    const before = headSha(root);
    stubs.list = [{ command: "rev-parse HEAD", code: 128, stderr: "fatal: unable to read HEAD\n" }];
    const report = await writeAndReport(root, true);
    expect(stubs.hits).toContain("rev-parse HEAD");
    expect(headSha(root)).toBe(before);
    expect(porcelain(root, REL)).toEqual([`?? ${REL}`]);
    expect(report.gitCommit).toEqual([{ repo: root, outcome: "skipped", reason: "commit failed: fatal: unable to read HEAD", paths: [REL] }]);
  });

  describe("F2: a SHA lookup failing after the commit is a verification failure, never skipped", () => {
    for (const [label, stub, detail] of [
      ["a failed lookup", { code: 128, stderr: "fatal: short lookup failed\n" }, "fatal: short lookup failed"],
      ["an empty lookup", { code: 0, stderr: "" }, "empty output"],
    ] as const) {
      it(label, async () => {
        const { root } = await makeProjectRepo();
        const before = headSha(root);
        stubs.list = [{ command: "rev-parse --short HEAD", ...stub }];
        const report = await writeAndReport(root, true);
        expect(stubs.hits).toContain("rev-parse --short HEAD");
        // The commit happened: HEAD advanced by one and took exactly the note.
        expect(git(root, "rev-parse", "HEAD~1").trim()).toBe(before);
        expect(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim()).toBe(REL);
        const reason = `commit created; SHA lookup failed: ${detail}`;
        expect(report.gitCommit).toEqual([{ repo: root, outcome: "verification_failed", reason, paths: [REL] }]);
        expect(report.gitCommit?.[0]).not.toHaveProperty("sha");
        expect(report.lines).toEqual([`Git: ${REL} committed`, `Git: commit verification failed (${reason})`]);
        const text = report.lines.join("\n");
        expect(text).not.toContain("skipped");
        expect(text).not.toContain("commit failed");
      });
    }
  });

  it("F2: an unborn branch (exit 1, nothing else) still commits as the root commit", async () => {
    const { root } = await makeProjectRepo({ commit: false });
    const report = await writeAndReport(root, true);
    expect(report.gitCommit?.[0]?.outcome).toBe("committed");
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  it("F3: dubious ownership is unavailable, not 'not a repository', on the write side", async () => {
    const { root } = await makeProjectRepo();
    const stderr = `fatal: detected dubious ownership in repository at '${root}'\nTo add an exception for this directory, call:\n`;
    stubs.list = [{ command: "rev-parse --show-toplevel", code: 128, stderr }];
    const report = await writeAndReport(root, false);
    const detail = `fatal: detected dubious ownership in repository at '${root}'`;
    expect(report.lines).toEqual([`Git: ${REL} unavailable (${detail})`]);
    expect(report.git).toEqual([{ path: REL, state: `unavailable (${detail})` }]);
    expect(report.gitUnavailable).toEqual({ reason: `unavailable: ${detail}` });
  });

  it("F3: permission denied is unavailable on the read side, and renders", async () => {
    const { root } = await makeProjectRepo();
    stubs.list = [{ command: "rev-parse --show-toplevel --show-prefix", code: 128, stderr: "fatal: cannot change to '.git': Permission denied\n" }];
    const state = await boardUncommitted(root);
    expect(state).toEqual({ available: false, reason: "unavailable: fatal: cannot change to '.git': Permission denied" });
    expect(renderBoardUncommitted(state)).toBe("## Board not committed\n\nBoard git state unavailable: fatal: cannot change to '.git': Permission denied");
  });

  it("F3: a real non-repository is still 'not a repository' on both sides", async () => {
    const { root } = await makeProjectRepo();
    stubs.list = [
      { command: "rev-parse --show-toplevel", code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" },
      { command: "rev-parse --show-toplevel --show-prefix", code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" },
    ];
    const report = await writeAndReport(root, false);
    expect(report.lines).toEqual([`Git: ${REL} no git (not a repository)`]);
    expect(await boardUncommitted(root)).toEqual({ available: false, reason: "not a repository" });
  });
});
