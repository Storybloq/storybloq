import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveNodeRoot,
  checkNodeWritePermission,
  detectNodeCollision,
  createBoundedRunner,
} from "../../src/mcp/node-resolution.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";

const tmpDirs: string[] = [];

async function createOrchestratorProject(opts: {
  nodes?: Record<string, { path: string }>;
  allowNodeWrites?: boolean;
} = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fed-node-res-"));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });

  const nodesConfig: Record<string, Record<string, unknown>> = {};
  for (const [name, node] of Object.entries(opts.nodes ?? {})) {
    nodesConfig[name] = { path: node.path, health: "grey", dependsOn: [], stack: "", role: "", summary: "" };
  }

  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: "orchestrator", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      nodes: nodesConfig,
      federation: { allowNodeWrites: opts.allowNodeWrites ?? false },
    }, null, 2),
  );
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({
    version: 2,
    title: "Test Roadmap",
    date: "2026-01-01",
    phases: [{ id: "p0", label: "Phase 0", name: "Phase 0", description: "" }],
    blockers: [],
  }));
  return dir;
}

async function createNodeProject(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-node-${name}-`));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });
  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: name, type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
  );
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({
    version: 2,
    title: "Test Roadmap",
    date: "2026-01-01",
    phases: [{ id: "p0", label: "Phase 0", name: "Phase 0", description: "" }],
    blockers: [],
  }));
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("resolveNodeRoot", () => {
  it("returns resolved root for valid node", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ nodes: { engine: { path: nodeDir } } });
    const result = resolveNodeRoot(orchDir, "engine");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root).toBeTruthy();
    }
  });

  it("returns error for non-orchestrator config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fed-non-orch-"));
    tmpDirs.push(dir);
    const storyDir = join(dir, ".story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "config.json"), JSON.stringify({
      version: 2, project: "regular", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    const result = resolveNodeRoot(dir, "engine");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("not_orchestrator");
    }
  });

  it("returns error for unknown node name", async () => {
    const orchDir = await createOrchestratorProject({ nodes: {} });
    const result = resolveNodeRoot(orchDir, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("node_not_found");
    }
  });

  it("returns io_error when config.json is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fed-no-config-"));
    tmpDirs.push(dir);
    const result = resolveNodeRoot(dir, "engine");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("io_error");
    }
  });

  it("returns error for unresolvable node path", async () => {
    const orchDir = await createOrchestratorProject({
      nodes: { broken: { path: join(tmpdir(), "fed-nonexistent-" + Date.now() + "-" + Math.random().toString(36).slice(2)) } },
    });
    const result = resolveNodeRoot(orchDir, "broken");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("node_unresolvable");
    }
  });
});

describe("checkNodeWritePermission", () => {
  it("returns false by default", async () => {
    const orchDir = await createOrchestratorProject();
    expect(checkNodeWritePermission(orchDir)).toBe(false);
  });

  it("returns true when federation.allowNodeWrites is true", async () => {
    const orchDir = await createOrchestratorProject({ allowNodeWrites: true });
    expect(checkNodeWritePermission(orchDir)).toBe(true);
  });
});

async function createTicketOn(root: string): Promise<string> {
  const result = await handleTicketCreate(
    { title: "collision test ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    root,
  );
  return (JSON.parse(result.output).data as { id: string }).id;
}

describe("detectNodeCollision (ISS-1074)", () => {
  it("is clear when the id resolves nowhere", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ nodes: { engine: { path: nodeDir } } });
    const result = await detectNodeCollision(orchDir, "T-999", true);
    expect(result.status).toBe("clear");
  });

  it("is clear when the id resolves on exactly one board (orchestrator only)", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ nodes: { engine: { path: nodeDir } } });
    const id = await createTicketOn(orchDir);
    const result = await detectNodeCollision(orchDir, id, true);
    expect(result.status).toBe("clear");
  });

  it("is clear when the id resolves on exactly one board (node only)", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ nodes: { engine: { path: nodeDir } } });
    const id = await createTicketOn(nodeDir);
    const result = await detectNodeCollision(orchDir, id, true);
    expect(result.status).toBe("clear");
  });

  it("is ambiguous and names both candidates when the id collides on the orchestrator and a node", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ nodes: { engine: { path: nodeDir } } });
    // fresh per-project id allocation: the first ticket in each project is T-001
    const orchId = await createTicketOn(orchDir);
    const nodeId = await createTicketOn(nodeDir);
    expect(orchId).toBe(nodeId);
    const result = await detectNodeCollision(orchDir, orchId, true);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      const labels = result.candidates.map((c) => c.label).sort();
      expect(labels).toEqual(["engine", "the orchestrator board"].sort());
    }
  });

  it("is ambiguous when the id collides across two nodes, orchestrator clean", async () => {
    const nodeA = await createNodeProject("alpha");
    const nodeB = await createNodeProject("beta");
    const orchDir = await createOrchestratorProject({ nodes: { alpha: { path: nodeA }, beta: { path: nodeB } } });
    const idA = await createTicketOn(nodeA);
    const idB = await createTicketOn(nodeB);
    expect(idA).toBe(idB);
    const result = await detectNodeCollision(orchDir, idA, true);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((c) => c.label).sort()).toEqual(["alpha", "beta"]);
    }
  });

  it("is indeterminate, never clear, when a configured node cannot be loaded", async () => {
    const orchDir = await createOrchestratorProject({
      nodes: { broken: { path: join(tmpdir(), "fed-does-not-exist-" + Date.now()) } },
    });
    const id = await createTicketOn(orchDir);
    const result = await detectNodeCollision(orchDir, id, true);
    // fail-closed: an id that does NOT collide with anything resolvable must still refuse,
    // because the unresolvable node could not be ruled out (never-fail-open, D1).
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.unresolvedNodes).toContain("broken");
    }
  });

  it("returns clear on a non-orchestrator project without ever touching node config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fed-non-orch-collision-"));
    tmpDirs.push(dir);
    // deliberately no config.json at all -- if this function ever tried to read
    // orchestrator-only fields it would throw, not return "clear"
    const result = await detectNodeCollision(dir, "T-001", true);
    expect(result.status).toBe("clear");
  });

  it("scans configured nodes through the injectable runner, never exceeding its concurrency ceiling", async () => {
    const nodeNames = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"];
    const nodeDirs: Record<string, { path: string }> = {};
    for (const name of nodeNames) {
      nodeDirs[name] = { path: await createNodeProject(name) };
    }
    const orchDir = await createOrchestratorProject({ nodes: nodeDirs });

    let active = 0;
    let maxActive = 0;
    const ceiling = 3;
    const instrumented = createBoundedRunner(ceiling);
    const countingRunner = async <T>(fn: () => Promise<T>): Promise<T> =>
      instrumented(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          return await fn();
        } finally {
          active--;
        }
      });

    const result = await detectNodeCollision(orchDir, "T-999", true, { runner: countingRunner });
    expect(result.status).toBe("clear");
    expect(maxActive).toBeLessThanOrEqual(ceiling);
    expect(maxActive).toBeGreaterThan(1); // proves real concurrency happened, not accidental serialization
  });
});

describe("createBoundedRunner (codex round-1: input validation + sync-throw handling)", () => {
  it("rejects a non-positive or non-integer concurrency ceiling up front", () => {
    expect(() => createBoundedRunner(0)).toThrow(RangeError);
    expect(() => createBoundedRunner(-1)).toThrow(RangeError);
    expect(() => createBoundedRunner(1.5)).toThrow(RangeError);
  });

  it("a synchronous throw from a queued task rejects only that task -- it does not hang the task that dequeued it or strand a later queued task", async () => {
    const run = createBoundedRunner(1);
    const order: string[] = [];

    // Ceiling is 1, so `second` and `third` both queue behind `first` and are
    // dequeued one at a time as each predecessor settles.
    const first = run(async () => {
      order.push("first-start");
      await Promise.resolve();
      order.push("first-end");
      return "first";
    });
    const second = run((): Promise<string> => {
      order.push("second-thrown");
      throw new Error("sync boom");
    });
    const third = run(async () => {
      order.push("third-start");
      return "third";
    });

    await expect(first).resolves.toBe("first");
    await expect(second).rejects.toThrow("sync boom");
    await expect(third).resolves.toBe("third");
    expect(order).toEqual(["first-start", "first-end", "second-thrown", "third-start"]);
  });

  it("codex round-3: a caller reaction that submits new work exactly when a slot frees up never exceeds the concurrency ceiling", async () => {
    const run = createBoundedRunner(1);
    let active = 0;
    let maxActive = 0;
    function track<T>(fn: () => Promise<T>): Promise<T> {
      return run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          return await fn();
        } finally {
          active--;
        }
      });
    }

    const first = track(async () => "first");
    // Queued behind `first` (ceiling is 1) BEFORE `first` settles.
    const second = track(async () => "second");

    let third: Promise<string> | undefined;
    // A reaction on `first`'s OWN returned promise -- fires as a caller
    // reaction right when `first`'s slot frees up, submitting a THIRD task
    // that competes with the already-queued `second` for that same slot.
    // Before the round-3 fix, this could let `second` and `third` both start
    // before either finished, exceeding the ceiling of 1.
    const reaction = first.then(() => {
      third = track(async () => "third");
    });

    await reaction;
    await expect(second).resolves.toBe("second");
    await expect(third).resolves.toBe("third");
    expect(maxActive).toBeLessThanOrEqual(1);
  });

  it("codex round-4 (informal re-check): two settlements in adjacent microtasks cannot let a caller reaction and a queued successor both start past a ceiling greater than one", async () => {
    // Round 3's fix ordered `queueMicrotask(next)` before `onSettled()`
    // WITHIN one settle() call -- correct for a single settlement at
    // ceiling 1, but with ceiling >= 2 and TWO tasks settling back to back,
    // the SECOND settlement's [dispatch, reaction] pair is appended to the
    // microtask queue entirely after the FIRST's -- so the first
    // settlement's own caller reaction can still run before the second's
    // queued dispatch, see a transiently-freed slot (active-- already ran
    // for both), and start new work before the second dispatch also runs
    // and re-increments, exceeding the ceiling. The fix removes the
    // transient free state entirely: a slot handed to a queued successor
    // never touches `active` at all.
    const run = createBoundedRunner(2);
    let active = 0;
    let maxActive = 0;
    function track<T>(fn: () => Promise<T>): Promise<T> {
      return run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          return await fn();
        } finally {
          active--;
        }
      });
    }
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }

    const dX = deferred<string>();
    const dY = deferred<string>();
    const dA = deferred<string>();
    const dB = deferred<string>();

    // Two tasks active immediately (ceiling is 2).
    const x = track(() => dX.promise);
    const y = track(() => dY.promise);
    // Two more queue behind them.
    const a = track(() => dA.promise);
    const b = track(() => dB.promise);

    let c: Promise<string> | undefined;
    // A reaction on X's own returned promise -- fires once X settles,
    // submitting a fifth task right as X's slot is (transiently, pre-fix)
    // freed, racing Y's settlement (which is queuing B) for that slot.
    const reactionOnX = x.then(() => {
      c = track(async () => "c");
    });

    // Settle X then Y back to back, in the same synchronous tick --
    // "adjacent microtasks", not simultaneous, is exactly the shape that
    // slips past a single-settlement-only fix.
    dX.resolve("x");
    dY.resolve("y");
    dA.resolve("a");
    dB.resolve("b");

    await Promise.all([x, y, a, b, reactionOnX]);
    await c;
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("pen byte-review: a task whose fn returns a non-promise value still settles (rather than throwing past the sync-throw guard) and releases its slot for the next queued task", async () => {
    const run = createBoundedRunner(1);

    // `fn` is typed as `() => Promise<T>`, but nothing at runtime stops a
    // caller from returning a plain value -- `pending.then` must not assume
    // `pending` is a real promise.
    const first = run((): Promise<string> => "not actually a promise" as unknown as Promise<string>);
    const second = run(async () => "second");

    await expect(first).resolves.toBe("not actually a promise");
    await expect(second).resolves.toBe("second");
  });
});

