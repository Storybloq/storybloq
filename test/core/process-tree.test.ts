/**
 * ISS-1376: the health MCP probe's teardown moved to core/process-tree.ts.
 * The probe must hand it exactly the timings it used before the move (200 ms
 * grace, 100 ms poll, 3000 ms max wait) and must not unref an unconfirmed
 * child, so mcp-probe.test.ts keeps proving the same behaviour.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn as spawnFn } from "node:child_process";

const calls: Array<{ alreadyExited: boolean; opts: Record<string, unknown> }> = [];
vi.mock("../../src/core/process-tree.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/process-tree.js")>();
  return {
    ...real,
    teardownProcessTree: vi.fn((_child: unknown, alreadyExited: boolean, opts: Record<string, unknown>) => {
      calls.push({ alreadyExited, opts });
      return Promise.resolve({ confirmed: true });
    }),
  };
});

const { probeMcpServer } = await import("../../src/core/health/deps.js");
const { realTimers } = await import("../../src/core/process-tree.js");

type FakeChild = EventEmitter & { pid?: number; exitCode: number | null; signalCode: string | null; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 987654;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

describe("ISS-1376: health delegates its teardown with today's timings", () => {
  it("passes 200 / 100 / 3000 ms, the real timers and no unref", async () => {
    const fakeSpawn = (() => fakeChild()) as unknown as typeof spawnFn;
    const r = await probeMcpServer({ argv: ["fake"], envOverrides: {} }, Date.now() + 60_000, 300, { env: process.env, spawn: fakeSpawn, platform: "linux" });
    expect(r).toEqual({ kind: "timeout", allocatedMs: 300 });
    expect(calls.length).toBe(1);
    const { opts, alreadyExited } = calls[0]!;
    expect(alreadyExited).toBe(false);
    expect(opts).toMatchObject({
      platform: "linux",
      termGraceMs: 200,
      pollMs: 100,
      maxWaitMs: 3000,
      unrefOnUnconfirmed: false,
    });
    expect(opts.timers).toBe(realTimers);
    expect(typeof opts.killFn).toBe("function");
    expect(typeof opts.runTaskkill).toBe("function");
  });
});
