/**
 * ISS-1092 A6: the destructive-replace guard and append mode through the
 * registered storybloq_note_update tool. A refused write with commit: true
 * leaves the note, HEAD, the index and unrelated pending changes untouched,
 * reports no git state and records no board target (ISS-1107). The recorder
 * observer wraps the callback handed to the real runWithBoardWriteContext, so
 * it holds the live context whether the handler resolves or rejects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BoardWriteContext } from "../../src/core/board-write-recorder.js";

const observed = vi.hoisted(() => [] as BoardWriteContext[]);

vi.mock("../../src/core/board-write-recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/board-write-recorder.js")>();
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
  captureTools, cleanupTempDirs, git, gitLines, headFiles, headSha, indexEntries, isolateGit, makeProjectRepo, porcelain,
} from "./board-git-fixtures.js";
import { registerAllTools } from "../../src/mcp/tools.js";

const OLD_MARKER = "OLD-PRIVATE-7f3a";
const NEW_MARKER = "NEW-PRIVATE-c91e";
const OLD = (OLD_MARKER + " ").repeat(Math.ceil(5000 / (OLD_MARKER.length + 1))).slice(0, 5000);
const NEW = (NEW_MARKER + " ").repeat(20).slice(0, 200);
const NOTE = ".story/notes/N-001.json";

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); observed.length = 0; });
afterEach(() => { restoreGit(); cleanupTempDirs(); });

/** A committed 5000-char note plus an unrelated staged file and an unstaged edit. */
async function seeded(): Promise<{ root: string; tools: ReturnType<typeof captureTools> }> {
  const { root } = await makeProjectRepo();
  writeFileSync(join(root, "README.md"), "readme\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "readme");
  const tools = captureTools(root);
  const created = await tools.call("storybloq_note_create", { content: OLD, title: "Big" });
  expect(created.isError).toBe(false);
  git(root, "add", "--", NOTE);
  git(root, "commit", "-q", "-m", "note");
  writeFileSync(join(root, "README.md"), "readme edited, unstaged\n");
  writeFileSync(join(root, "other.txt"), "staged, unrelated\n");
  git(root, "add", "other.txt");
  observed.length = 0;
  return { root, tools };
}

function snapshot(root: string) {
  return {
    bytes: readFileSync(join(root, NOTE)),
    head: headSha(root),
    index: indexEntries(root),
    status: porcelain(root),
  };
}

describe("storybloq_note_update guard and append (ISS-1092 A6)", () => {
  it("refuses a shrinking replace with commit: true and changes nothing in git or on disk", async () => {
    const { root, tools } = await seeded();
    const before = snapshot(root);

    const reply = await tools.call("storybloq_note_update", { id: "N-001", content: NEW, commit: true });

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("confirmReplace");
    expect(reply.text).toContain("mode");
    expect(reply.text).toContain("5000");
    expect(reply.text).toContain("200");
    expect(reply.text).not.toContain(OLD_MARKER);
    expect(reply.text).not.toContain(NEW_MARKER);
    expect(gitLines(reply.text)).toEqual([]);
    expect(reply.text).not.toMatch(/"git(Commit)?"\s*:/);
    expect(snapshot(root)).toEqual(before);
    expect(porcelain(root, "other.txt")).toEqual(["A  other.txt"]);
    expect(porcelain(root, "README.md")).toEqual([" M README.md"]);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.tool).toBe("storybloq_note_update");
    expect(observed[0]!.targets.size).toBe(0);
  });

  it("commits exactly the note on a confirmed replace (positive control for the refusal)", async () => {
    const { root, tools } = await seeded();
    const before = headSha(root);

    const reply = await tools.call("storybloq_note_update", { id: "N-001", content: NEW, confirmReplace: true, commit: true });

    expect(reply.isError).toBe(false);
    expect(headSha(root)).not.toBe(before);
    expect(headFiles(root)).toEqual([NOTE]);
    expect(gitLines(reply.text)[0]).toBe(`Git: ${NOTE} committed`);
    expect((JSON.parse(readFileSync(join(root, NOTE), "utf-8")) as { content: string }).content).toBe(NEW);
    expect(porcelain(root, "other.txt")).toEqual(["A  other.txt"]);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.targets.size).toBe(1);
  });

  it("goes through SDK schema validation: an unknown mode is refused before any recorder context, and append appends", async () => {
    const { root } = await seeded();
    const server = new McpServer({ name: "storybloq", version: "0.0.0" });
    registerAllTools(server, root);
    const client = new Client({ name: "iss1092", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const bytes = readFileSync(join(root, NOTE));
      observed.length = 0;
      const bad = await client.callTool({ name: "storybloq_note_update", arguments: { id: "N-001", content: "x", mode: "prepend" } })
        .then(
          (r) => ({ isError: r.isError === true, text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n") }),
          (e: unknown) => ({ isError: true, text: e instanceof Error ? e.message : String(e) }),
        );
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("mode");
      expect(observed).toHaveLength(0);
      expect(readFileSync(join(root, NOTE))).toEqual(bytes);

      const good = await client.callTool({ name: "storybloq_note_update", arguments: { id: "N-001", content: "frag", mode: "append" } });
      expect(good.isError).not.toBe(true);
      expect((JSON.parse(readFileSync(join(root, NOTE), "utf-8")) as { content: string }).content).toBe(OLD + "\n\nfrag");
      expect(observed).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
