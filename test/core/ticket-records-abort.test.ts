import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * T-486 U2-3a (N8): loadTicketRecords checks its signal between files. One
 * hook on readFile records which ticket files were read and aborts after the
 * first; everything else is the real implementation.
 */
const fsHooks = vi.hoisted(() => ({
  reads: [] as string[],
  abortAfterFirst: null as AbortController | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args);
    const path = String(args[0]);
    if (path.includes("/tickets/") && path.endsWith(".json")) {
      fsHooks.reads.push(path.slice(path.lastIndexOf("/") + 1));
      fsHooks.abortAfterFirst?.abort();
    }
    return result;
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

import { loadTicketRecords, serializeJSON } from "../../src/core/project-loader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  fsHooks.reads = [];
  fsHooks.abortAfterFirst = null;
});

function storyWithTickets(ids: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "t486-u23-abort-"));
  dirs.push(root);
  mkdirSync(join(root, ".story", "tickets"), { recursive: true });
  for (const id of ids) {
    writeFileSync(join(root, ".story", "tickets", `${id}.json`), serializeJSON({
      id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p0",
      order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
    }));
  }
  return join(root, ".story");
}

describe("T-486 U2-3a loadTicketRecords stops between files on abort (N8)", () => {
  it("an abort during the first file rejects with AbortError before the second file is read", async () => {
    const story = storyWithTickets(["T-001", "T-002", "T-003"]);
    const controller = new AbortController();
    fsHooks.abortAfterFirst = controller;
    await expect(loadTicketRecords(story, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fsHooks.reads).toEqual(["T-001.json"]);
  });

  it("an already-aborted signal reads no file", async () => {
    const story = storyWithTickets(["T-001", "T-002"]);
    const controller = new AbortController();
    controller.abort();
    await expect(loadTicketRecords(story, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fsHooks.reads).toEqual([]);
  });

  it("without an abort every file is read and accepted", async () => {
    const story = storyWithTickets(["T-001", "T-002", "T-003"]);
    const r = await loadTicketRecords(story, { signal: new AbortController().signal });
    expect(r.records.map((t) => t.id)).toEqual(["T-001", "T-002", "T-003"]);
    expect(fsHooks.reads).toEqual(["T-001.json", "T-002.json", "T-003.json"]);
  });
});
