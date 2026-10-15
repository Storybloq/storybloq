/**
 * T-486 U2-3b, code round 1: a node scan settles only once every read it
 * launched has settled. If it settled on the first failure, the scheduler
 * would free its slot and start another node beside reads still running.
 * Reads are held open by wrapping node:fs/promises for the paths a test names.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const held = vi.hoisted(() => new Map<string, { wait: Promise<void>; release: () => void }>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const waitIfHeld = async (path: unknown): Promise<void> => {
    for (const [suffix, gate] of held) if (String(path).endsWith(suffix)) await gate.wait;
  };
  return {
    ...real,
    readdir: (async (path: Parameters<typeof real.readdir>[0], ...rest: unknown[]) => {
      await waitIfHeld(path);
      return (real.readdir as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readdir,
    readFile: (async (path: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
      await waitIfHeld(path);
      return (real.readFile as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readFile,
  };
});

const { scanNodeSummary, runNodeScans, NOT_SCANNED_REASON } = await import("../../src/federation/scanner.js");

function hold(suffix: string): () => void {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  held.set(suffix, { wait, release });
  return () => { held.delete(suffix); release(); };
}

const dirs: string[] = [];

/** A minimal node: config, issues and handovers dirs, and tickets as a dir or (unlistable) a file. */
function nodeDir(opts: { ticketsIsFile?: boolean; issues?: Record<string, string> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "t486-u23b-drain-"));
  dirs.push(root);
  const story = join(root, ".story");
  mkdirSync(join(story, "issues"), { recursive: true });
  mkdirSync(join(story, "handovers"));
  writeFileSync(join(story, "config.json"), JSON.stringify({ project: "n", type: "npm" }));
  if (opts.ticketsIsFile) writeFileSync(join(story, "tickets"), "not a directory");
  else mkdirSync(join(story, "tickets"));
  for (const [name, status] of Object.entries(opts.issues ?? {})) {
    writeFileSync(join(story, "issues", name), JSON.stringify({ id: name, status }));
  }
  return story;
}

function settledFlag(p: Promise<unknown>): { readonly settled: boolean } {
  const flag = { settled: false };
  p.then(() => { flag.settled = true; }, () => { flag.settled = true; });
  return flag;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const gate of held.values()) gate.release();
  held.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("T-486 U2-3b: a node scan settles only after every read it launched", () => {
  it("a ticket load that fails at once does not settle the scan while the issue read is still pending", async () => {
    const story = nodeDir({ ticketsIsFile: true });
    const release = hold(join(story, "issues"));
    const scan = scanNodeSummary(story);
    const flag = settledFlag(scan);
    await pause(60);
    expect(flag.settled).toBe(false);
    release();
    await expect(scan).rejects.toThrow();
  });

  it("an aborted issue count waits for its pending file reads before it settles", async () => {
    const story = nodeDir({ issues: { "a.json": "open", "b.json": "open" } });
    const releaseA = hold(join("issues", "a.json"));
    const releaseB = hold(join("issues", "b.json"));
    const controller = new AbortController();
    const scan = scanNodeSummary(story, controller.signal);
    const flag = settledFlag(scan);
    await pause(30);
    controller.abort();
    releaseA();
    await pause(60);
    expect(flag.settled).toBe(false);
    releaseB();
    await expect(scan).rejects.toThrow();
  });

  it("the scheduler keeps the slot occupied, and stops the queue when that scan's cancellation is not confirmed", async () => {
    const failing = nodeDir({ ticketsIsFile: true });
    const healthy = nodeDir();
    hold(join(failing, "issues"));
    const started: string[] = [];
    const results = await runNodeScans(
      [{ name: "failing", storyDir: failing }, { name: "healthy", storyDir: healthy }],
      {
        concurrency: 1,
        timeoutMs: 40,
        settleGraceMs: 40,
        scan: (dir, signal) => { started.push(dir); return scanNodeSummary(dir, signal); },
      },
    );
    expect(results.get("failing")).toEqual({ reachable: false, reason: "timeout" });
    expect(results.get("healthy")).toEqual({ reachable: false, reason: NOT_SCANNED_REASON });
    expect(started).toEqual([failing]);
  });
});
