/**
 * ISS-1092 A7: the destructive-replace guard and append mode through the real
 * `note update` parser (registerNoteCommand on yargs, in process). A refused
 * write with --commit exits with the user-error code, leaves the note, HEAD,
 * the index and unrelated pending changes untouched, prints no git state and
 * records no board target. The guard error propagates out of runBoardWrite and
 * is caught in register.ts, so the observer captures the live context inside
 * the callback rather than relying on a returned one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import yargs from "yargs";
import type { BoardWriteContext } from "../../../src/core/board-write-recorder.js";

const observed = vi.hoisted(() => [] as BoardWriteContext[]);

vi.mock("../../../src/core/board-write-recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/board-write-recorder.js")>();
  return {
    ...actual,
    runWithBoardWriteContext: <T>(tool: string, commit: boolean, fn: () => Promise<T>) =>
      actual.runWithBoardWriteContext(tool, commit, () => {
        const ctx = actual.activeBoardWriteContext();
        if (ctx) observed.push(ctx);
        return fn();
      }),
  };
});

import {
  cleanupTempDirs, git, headFiles, headSha, indexEntries, isolateGit, makeProjectRepo, porcelain,
} from "../../mcp/board-git-fixtures.js";
import { registerNoteCommand } from "../../../src/cli/register.js";
import { handleNoteCreate } from "../../../src/cli/commands/note.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { PROJECT_ROOT_ENV_VAR, LEGACY_PROJECT_ROOT_ENV_VAR } from "../../../src/core/project-root-shared.js";

const OLD_MARKER = "OLD-PRIVATE-7f3a";
const NEW_MARKER = "NEW-PRIVATE-c91e";
const OLD = (OLD_MARKER + " ").repeat(Math.ceil(5000 / (OLD_MARKER.length + 1))).slice(0, 5000);
const NEW = (NEW_MARKER + " ").repeat(20).slice(0, 200);
const NOTE = ".story/notes/N-001.json";

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); observed.length = 0; });
afterEach(() => {
  restoreGit();
  cleanupTempDirs();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function seeded(): Promise<string> {
  const { root } = await makeProjectRepo();
  writeFileSync(join(root, "README.md"), "readme\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "readme");
  await handleNoteCreate({ content: OLD, title: "Big" }, "md", root);
  git(root, "add", "--", NOTE);
  git(root, "commit", "-q", "-m", "note");
  writeFileSync(join(root, "README.md"), "readme edited, unstaged\n");
  writeFileSync(join(root, "other.txt"), "staged, unrelated\n");
  git(root, "add", "other.txt");
  observed.length = 0;
  return root;
}

function snapshot(root: string) {
  return { bytes: readFileSync(join(root, NOTE)), head: headSha(root), index: indexEntries(root), status: porcelain(root) };
}

const stored = (root: string) => (JSON.parse(readFileSync(join(root, NOTE), "utf-8")) as { content: string }).content;

/** Runs `storybloq note update N-001 ...` through the real parser; returns stdout and the exit code. */
async function cli(root: string, args: string[]): Promise<{ out: string; code: number | undefined }> {
  vi.stubEnv(PROJECT_ROOT_ENV_VAR, root);
  vi.stubEnv(LEGACY_PROJECT_ROOT_ENV_VAR, "");
  process.exitCode = undefined;
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  try {
    // Like the real CLI's .fail (src/cli/index.ts), a parse failure throws, so
    // yargs never reaches the command handler after a validation error.
    try {
      await registerNoteCommand(yargs(["note", "update", "N-001", ...args]).scriptName("storybloq"))
        .exitProcess(false)
        .fail((msg, err) => {
          out += msg ?? err?.message ?? "";
          process.exitCode = ExitCode.USER_ERROR;
          throw err ?? new Error(msg);
        })
        .parseAsync();
    } catch {
      // The parse failure was recorded above; yargs may throw it synchronously.
    }
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
  const code = process.exitCode === undefined ? undefined : Number(process.exitCode);
  process.exitCode = undefined;
  return { out, code };
}

describe("note update guard and append on the CLI (ISS-1092 A7)", () => {
  for (const format of ["json", "md"] as const) {
    it(`refuses a shrinking replace with --commit and changes nothing (${format})`, async () => {
      const root = await seeded();
      const before = snapshot(root);

      const run = await cli(root, ["--content", NEW, "--commit", "--format", format]);

      expect(run.code).toBe(ExitCode.USER_ERROR);
      expect(run.out).toContain("--confirm-replace");
      expect(run.out).toContain("--mode append");
      expect(run.out).toContain("5000");
      expect(run.out).not.toContain(OLD_MARKER);
      expect(run.out).not.toContain(NEW_MARKER);
      expect(run.out).not.toMatch(/^Git: /m);
      expect(run.out).not.toMatch(/"git(Commit)?"\s*:/);
      expect(snapshot(root)).toEqual(before);
      expect(porcelain(root, "other.txt")).toEqual(["A  other.txt"]);
      expect(porcelain(root, "README.md")).toEqual([" M README.md"]);
      expect(observed).toHaveLength(1);
      expect(observed[0]!.tool).toBe("note update");
      expect(observed[0]!.targets.size).toBe(0);
    });
  }

  it("commits exactly the note with --confirm-replace --commit (positive control for the refusal)", async () => {
    const root = await seeded();
    const before = headSha(root);

    const run = await cli(root, ["--content", NEW, "--confirm-replace", "--commit"]);

    expect(run.code ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(headSha(root)).not.toBe(before);
    expect(headFiles(root)).toEqual([NOTE]);
    expect(stored(root)).toBe(NEW);
    expect(porcelain(root, "other.txt")).toEqual(["A  other.txt"]);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.targets.size).toBe(1);
  });

  it("appends from --stdin with --mode append", async () => {
    const root = await seeded();
    const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const stdin = Object.assign(Readable.from(["frag"]), { isTTY: false });
    Object.defineProperty(process, "stdin", { configurable: true, get: () => stdin });
    try {
      const run = await cli(root, ["--mode", "append", "--stdin"]);
      expect(run.code ?? ExitCode.OK).toBe(ExitCode.OK);
    } finally {
      Object.defineProperty(process, "stdin", original);
    }
    expect(stored(root)).toBe(OLD + "\n\nfrag");
  });

  it("rejects an unknown --mode at the parser, before any handler or recorder", async () => {
    const root = await seeded();
    const bytes = readFileSync(join(root, NOTE));

    const run = await cli(root, ["--content", "x", "--mode", "prepend"]);

    expect(run.code).not.toBe(ExitCode.OK);
    expect(run.code).not.toBeUndefined();
    expect(run.out).toContain("prepend");
    expect(readFileSync(join(root, NOTE))).toEqual(bytes);
    expect(observed).toHaveLength(0);
  });
});
