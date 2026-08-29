import { describe, it, expect } from "vitest";
import { withOrchestratorAndItemLocks } from "../../src/core/orchestrator-item-lock.js";
import type { withProjectLock } from "../../src/core/project-loader.js";
import type { ProjectState } from "../../src/core/project-state.js";

/**
 * A fake `lockFn` that simulates the REAL lock's non-reentrancy: a root
 * requested while it is already "held" throws immediately, standing in for
 * what the real file lock (project-lock.ts) would do instead more slowly --
 * poll out to its deadline, then fail with io_error. Fast and deterministic
 * for a unit test, while still catching the exact defect (a second `lockFn`
 * call against a root whose lock is already held by an enclosing call).
 */
function fakeLockFn(rootsSeen: string[]): typeof withProjectLock {
  const held = new Set<string>();
  return (async (root: string, _options: unknown, handler: (arg: { state: ProjectState }) => Promise<void>) => {
    if (held.has(root)) {
      throw new Error(`would re-lock already-held root: ${root}`);
    }
    held.add(root);
    rootsSeen.push(root);
    try {
      await handler({ state: { root } as unknown as ProjectState });
    } finally {
      held.delete(root);
    }
  }) as unknown as typeof withProjectLock;
}

describe("withOrchestratorAndItemLocks (codex round-2): self-alias handling", () => {
  it("does not re-lock the orchestrator root when it also appears as an item root alongside another distinct root", async () => {
    const orchRoot = "/tmp/fake-orch";
    const childRoot = "/tmp/fake-child";
    const rootsSeen: string[] = [];
    const perItemRoots: string[] = [];

    const result = await withOrchestratorAndItemLocks(
      orchRoot,
      [orchRoot, childRoot],
      async (_orchestratorState, itemRoot) => { perItemRoots.push(itemRoot); },
      async () => "done",
      fakeLockFn(rootsSeen),
    );

    expect(result).toBe("done");
    expect(perItemRoots).toEqual([orchRoot, childRoot]);
    // The orchestrator root's lock (held by the outer call for the whole
    // window) must never be requested a second time -- only the genuinely
    // distinct child root goes through a nested `lockFn` call. Before the
    // fix, this second entry would have been `orchRoot` again, and the fake
    // lock's non-reentrancy check above would have thrown.
    expect(rootsSeen).toEqual([orchRoot, childRoot]);
  });

  it("still handles a self-alias as the sole item root with no nested lock call at all", async () => {
    const orchRoot = "/tmp/fake-orch-solo";
    const rootsSeen: string[] = [];
    const perItemRoots: string[] = [];

    await withOrchestratorAndItemLocks(
      orchRoot,
      [orchRoot],
      async (_orchestratorState, itemRoot) => { perItemRoots.push(itemRoot); },
      async () => undefined,
      fakeLockFn(rootsSeen),
    );

    expect(perItemRoots).toEqual([orchRoot]);
    // Only the outer lock call -- no nested lockFn call for the same root.
    expect(rootsSeen).toEqual([orchRoot]);
  });

  it("still locks several genuinely distinct item roots exactly once each, sequentially, never simultaneously", async () => {
    const orchRoot = "/tmp/fake-orch-multi";
    const rootA = "/tmp/fake-a";
    const rootB = "/tmp/fake-b";
    const rootsSeen: string[] = [];
    const perItemRoots: string[] = [];

    await withOrchestratorAndItemLocks(
      orchRoot,
      [rootA, rootB],
      async (_orchestratorState, itemRoot) => { perItemRoots.push(itemRoot); },
      async () => undefined,
      fakeLockFn(rootsSeen),
    );

    expect(perItemRoots).toEqual([rootA, rootB]);
    expect(rootsSeen).toEqual([orchRoot, rootA, rootB]);
  });

  it("calls perItem with no item roots at all when itemRoots is empty, going straight to finalize", async () => {
    const orchRoot = "/tmp/fake-orch-empty";
    const rootsSeen: string[] = [];
    const perItemRoots: string[] = [];

    const result = await withOrchestratorAndItemLocks(
      orchRoot,
      [],
      async (_orchestratorState, itemRoot) => { perItemRoots.push(itemRoot); },
      async () => "finalized",
      fakeLockFn(rootsSeen),
    );

    expect(result).toBe("finalized");
    expect(perItemRoots).toEqual([]);
    expect(rootsSeen).toEqual([orchRoot]);
  });
});
