/**
 * ISS-1092 A8: two concurrent appends to one note both land, because the
 * existing content is read and composed under the project lock.
 *
 * A two-arrival barrier sits in front of the real withProjectLock, so both
 * calls finish every pre-lock step before either takes the lock. A build that
 * read the note before locking would compose both appends from the same
 * snapshot and lose one fragment on every run; scheduling cannot hide it.
 * The wrapper always delegates to the actual function, so the real lock, the
 * real load and the real on-disk writes are what the test exercises.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const barrier = vi.hoisted(() => {
  let armed = false;
  let arrivals = 0;
  let release: () => void = () => {};
  let released = Promise.resolve();
  return {
    arm() {
      armed = true;
      arrivals = 0;
      released = new Promise<void>((resolve) => { release = resolve; });
    },
    disarm() { armed = false; arrivals = 0; },
    arrivals: () => arrivals,
    gate(): Promise<void> {
      if (!armed) return Promise.resolve();
      arrivals += 1;
      if (arrivals === 2) release();
      return released;
    },
  };
});

vi.mock("../../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/project-loader.js")>();
  return {
    ...actual,
    withProjectLock: vi.fn((...args: Parameters<typeof actual.withProjectLock>) =>
      barrier.gate().then(() => actual.withProjectLock(...args))),
  };
});

import { handleNoteCreate, handleNoteUpdate } from "../../../src/cli/commands/note.js";
import { initProject } from "../../../src/core/init.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  barrier.disarm();
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function noteOf(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "note-append-race-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test" });
  await handleNoteCreate({ content }, "md", dir);
  return dir;
}

async function content(dir: string): Promise<string> {
  return (JSON.parse(await readFile(join(dir, ".story", "notes", "N-001.json"), "utf-8")) as { content: string }).content;
}

const once = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("note append under concurrency (ISS-1092 A8)", () => {
  it("both appends land when both reach the lock before either takes it", async () => {
    const dir = await noteOf("base");
    barrier.arm();
    await Promise.all([
      handleNoteUpdate("N-001", { content: "fragment-A", mode: "append" }, "json", dir),
      handleNoteUpdate("N-001", { content: "fragment-B", mode: "append" }, "json", dir),
    ]);
    expect(barrier.arrivals()).toBe(2);
    const final = await content(dir);
    expect(["base\n\nfragment-A\n\nfragment-B", "base\n\nfragment-B\n\nfragment-A"]).toContain(final);
    expect(once(final, "fragment-A")).toBe(1);
    expect(once(final, "fragment-B")).toBe(1);
  });

  it("is transparent when the barrier is not armed", async () => {
    const dir = await noteOf("base");
    await Promise.all([
      handleNoteUpdate("N-001", { content: "fragment-A", mode: "append" }, "json", dir),
      handleNoteUpdate("N-001", { content: "fragment-B", mode: "append" }, "json", dir),
    ]);
    expect(barrier.arrivals()).toBe(0);
    const final = await content(dir);
    expect(once(final, "fragment-A")).toBe(1);
    expect(once(final, "fragment-B")).toBe(1);
  });
});
