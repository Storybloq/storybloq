/**
 * ISS-1107: the recorder holds exactly the logical board targets an operation
 * applied: nothing for an aborted transaction, nothing for a recovery run,
 * nothing for a delete that found nothing, and one entry per path.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { atomicCreate, loadProject, runTransactionUnlocked, withProjectLock } from "../../src/core/project-loader.js";
import { activeBoardWriteContext, recordBoardTarget, runWithBoardWriteContext } from "../../src/core/board-write-recorder.js";
import { cleanupTempDirs, tempDir } from "../mcp/board-git-fixtures.js";

afterEach(() => cleanupTempDirs());

async function project(): Promise<string> {
  const root = tempDir("rec");
  await initProject(root, { name: "fixture" });
  return root;
}

describe("board write recorder (ISS-1107)", () => {
  it("R1: an aborted transaction records nothing", async () => {
    const root = await project();
    const good = join(root, ".story", "notes", "N-001.json");
    const bad = join(root, ".story", "config.json", "child.json");
    const { context } = await runWithBoardWriteContext("t", false, async () => {
      await expect(withProjectLock(root, {}, async () => {
        await runTransactionUnlocked(root, [
          { op: "write", target: good, content: "{}\n" },
          { op: "write", target: bad, content: "{}\n" },
        ]);
      })).rejects.toThrow();
    });
    expect(existsSync(good)).toBe(false);
    expect([...context.targets]).toEqual([]);
  });

  it("R2: a transaction delete that finds nothing records nothing", async () => {
    const root = await project();
    const written = join(root, ".story", "notes", "N-001.json");
    const missing = join(root, ".story", "notes", "N-404.json");
    const { context } = await runWithBoardWriteContext("t", false, async () => {
      await withProjectLock(root, {}, async () => {
        await runTransactionUnlocked(root, [
          { op: "write", target: written, content: "{}\n" },
          { op: "delete", target: missing },
        ]);
      });
    });
    expect([...context.targets]).toEqual([[written, "write"]]);
  });

  it("R3: a recovery run records nothing", async () => {
    const root = await project();
    const target = join(root, ".story", "notes", "N-001.json");
    const temp = `${target}.999999.tmp`;
    writeFileSync(temp, "{}\n");
    writeFileSync(join(root, ".story", ".txn.json"), JSON.stringify({
      entries: [{ op: "write", target, tempPath: temp }],
      commitStarted: true,
    }));
    const { context } = await runWithBoardWriteContext("t", false, async () => {
      await loadProject(root);
    });
    expect(readFileSync(target, "utf-8")).toBe("{}\n");
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
    expect([...context.targets]).toEqual([]);
  });

  it("R4: atomicCreate records after the link, and not when the link fails", async () => {
    const root = await project();
    const target = join(root, ".story", "notes", "N-001.json");
    const first = await runWithBoardWriteContext("t", false, async () => {
      await atomicCreate(target, "{}\n");
      return [...activeBoardWriteContext()!.targets];
    });
    expect(first.value).toEqual([[target, "write"]]);
    const second = await runWithBoardWriteContext("t", false, async () => {
      await expect(atomicCreate(target, "{}\n")).rejects.toThrow();
    });
    expect([...second.context.targets]).toEqual([]);
  });

  it("R5: one entry per path, and the last kind wins", async () => {
    const a = "/x/.story/notes/N-001.json";
    const b = "/x/.story/notes/N-002.json";
    const { context } = await runWithBoardWriteContext("t", false, async () => {
      recordBoardTarget(a, "write");
      recordBoardTarget(b, "delete");
      recordBoardTarget(a, "delete");
      recordBoardTarget(b, "write");
      recordBoardTarget("/x/outside/file.json", "write");
    });
    expect([...context.targets]).toEqual([[a, "delete"], [b, "write"]]);
    // Outside a context the call is a no-op.
    expect(() => recordBoardTarget(a, "write")).not.toThrow();
    expect(activeBoardWriteContext()).toBeUndefined();
  });
});
