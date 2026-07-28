import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * T-446 cost claim, instrumented.
 *
 * The point of the guard is that it answers the ownership question WITHOUT the
 * full `storybloq_status` payload, so "it does not read the ledger" has to be
 * proven, not inferred. A behavioral test cannot prove it: code that enumerated
 * every ticket, swallowed the parse failures, and returned the same verdict
 * would pass one. So this file wraps `node:fs` and records every path the guard
 * touches.
 *
 * It lives alone because the module mock is process-wide within a test file.
 */

/**
 * Hoisted because `vi.mock` factories are hoisted above the module body: a
 * factory that CALLS a top-level helper hits the temporal dead zone, since
 * `node:fs` is imported before these consts would run.
 */
const recorder = vi.hoisted(() => {
  const reads: string[] = [];

  /**
   * Paths arrive as string, Buffer, or URL depending on the caller, and a
   * recorder that only understood strings would silently miss the other two:
   * it would report zero reads and pass vacuously.
   */
  const toPath = (p: unknown): string | null => {
    if (typeof p === "string") return p;
    if (p instanceof URL) return p.pathname;
    if (p instanceof Uint8Array) return Buffer.from(p).toString("utf-8");
    return null;
  };

  const wrap = <T extends object>(actual: T, names: readonly string[]): T => {
    const out: Record<string, unknown> = { ...actual };
    for (const name of names) {
      const fn = (actual as Record<string, unknown>)[name];
      if (typeof fn !== "function") continue;
      const wrapped = (path: unknown, ...rest: unknown[]): unknown => {
        const resolved = toPath(path);
        if (resolved !== null) reads.push(resolved);
        return (fn as (...a: unknown[]) => unknown).call(actual, path, ...rest);
      };
      // Copy own properties across. `realpathSync.native` is a real call site
      // (`session-selector.ts:33`), and a wrapper that dropped it would make the
      // scan throw, report zero sessions, and turn every assertion here vacuous.
      for (const key of Object.getOwnPropertyNames(fn)) {
        if (key === "length" || key === "name" || key === "prototype") continue;
        const value = (fn as Record<string, unknown>)[key];
        (wrapped as Record<string, unknown>)[key] =
          typeof value === "function"
            ? (p: unknown, ...r: unknown[]) => {
                const resolved = toPath(p);
                if (resolved !== null) reads.push(resolved);
                return (value as (...a: unknown[]) => unknown).call(fn, p, ...r);
              }
            : value;
      }
      out[name] = wrapped;
    }
    return out as T;
  };

  return { reads, wrap };
});

const reads = recorder.reads;

/**
 * Every read and enumeration entry point a ledger loader could plausibly use,
 * sync and async.
 *
 * Recording only `readFileSync` and `readdirSync` would let a ledger read added
 * through `node:fs/promises`, `openSync`, or a stream leave every test here
 * green while the claim they exist to prove is false.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // `import { promises as fs } from "node:fs"` reaches the async API through
  // THIS object, which a shallow copy would pass through unwrapped -- a whole
  // read path escaping the recorder while every assertion stayed green.
  const wrapped = recorder.wrap(actual, [
    "readFileSync",
    "readdirSync",
    "openSync",
    "opendirSync",
    "createReadStream",
    "realpathSync",
    // Link resolution, glob expansion, and watchers all take a path and are all
    // ways to reach the ledger without calling anything named "read": `globSync`
    // enumerates it in one call, `readlinkSync` walks into it, and a watcher
    // registration opens it. `wrap` skips names the runtime does not define, so
    // listing the newer ones costs nothing on older Node.
    "readlinkSync",
    "globSync",
    "watch",
    "watchFile",
    // Callback forms too. A loader written as `readFile(path, cb)` would escape
    // a sync-only recorder entirely and leave every negative assertion here
    // green while reading the whole ledger.
    "readFile",
    "readdir",
    "open",
    "opendir",
    "realpath",
    "readlink",
    "glob",
    // Inspection and enumeration, not just content reads. A guard that probed
    // `.story/config.json` with `existsSync` or walked the ledger with `statSync`
    // would otherwise satisfy both "touches no path" and "reads only sessions".
    "existsSync",
    "statSync",
    "lstatSync",
    "accessSync",
    "stat",
    "lstat",
    "access",
  ]) as typeof actual;
  return {
    ...wrapped,
    promises: recorder.wrap(actual.promises, [
      "readFile",
      "readdir",
      "open",
      "opendir",
      "realpath",
      "readlink",
      "glob",
      "stat",
      "lstat",
      "access",
    ]),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return recorder.wrap(actual, ["readFile", "readdir", "open", "opendir", "realpath", "readlink", "glob", "stat", "lstat", "access"]);
});

const { evaluateSessionGuard } = await import("../../src/core/session-guard.js");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  reads.length = 0;
});

function projectWithLedger(ticketCount: number): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-guard-cost-"));
  roots.push(root);

  const tickets = join(root, ".story", "tickets");
  const issues = join(root, ".story", "issues");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(issues, { recursive: true });
  for (let i = 0; i < ticketCount; i += 1) {
    const id = `T-${String(i).padStart(3, "0")}`;
    writeFileSync(join(tickets, `${id}.json`), JSON.stringify({ id, title: `Ticket ${i}`, status: "open" }));
    writeFileSync(join(issues, `ISS-${String(i).padStart(3, "0")}.json`), JSON.stringify({ id: `ISS-${i}` }));
  }
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({ phases: [] }));
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ name: "cost" }));

  const dir = join(root, ".story", "sessions", "live");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      sessionId: "live",
      status: "active",
      state: "IMPLEMENT",
      mode: "auto",
      ticket: { id: "T-020", title: "Task ownership" },
      compactPending: false,
      ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
      lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
    }),
  );
  return root;
}

describe("the guard does not read the ledger", () => {
  /**
   * The recorder wraps the sync and async read entry points a ledger loader
   * would use (see the two `vi.mock` factories above), not every syscall
   * `node:fs` exposes. A read
   * performed through an unwrapped API would escape it, so this proves what the
   * guard does through those paths rather than proving no I/O of any kind.
   */
  it("touches no path under .story/tickets, .story/issues, or the roadmap", () => {
    const root = projectWithLedger(3);
    const verdict = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });
    expect(verdict.overallAction).toBe("continue");

    const forbidden = [
      `${sep}.story${sep}tickets`,
      `${sep}.story${sep}issues`,
      `${sep}.story${sep}roadmap.json`,
      `${sep}.story${sep}config.json`,
    ];
    const violations = reads.filter((p) => forbidden.some((f) => p.includes(f)));
    expect(violations, `guard read ledger paths: ${violations.slice(0, 5).join(", ")}`).toEqual([]);
  });

  it("captures an existence probe, not only content reads", async () => {
    // The cheapest way to touch the ledger is to ask whether a file is there.
    // If that escapes the recorder, "touches no path under .story/tickets" is
    // true only of reads the recorder happens to know about.
    const root = projectWithLedger(1);
    const fs = await import("node:fs");
    reads.length = 0;
    fs.existsSync(join(root, ".story", "config.json"));
    fs.statSync(join(root, ".story", "roadmap.json"));
    expect(reads, "existsSync was not recorded").toContain(join(root, ".story", "config.json"));
    expect(reads, "statSync was not recorded").toContain(join(root, ".story", "roadmap.json"));
  });

  it("captures a read through the `promises` property of node:fs", async () => {
    // The other async entry point. `fs.promises.readFile` is a distinct object
    // from the `node:fs/promises` module, so mocking only the latter leaves it
    // uninstrumented.
    const root = projectWithLedger(1);
    const target = join(root, ".story", "roadmap.json");
    const fs = await import("node:fs");
    reads.length = 0;
    await fs.promises.readFile(target, "utf-8");
    expect(reads, "fs.promises.readFile was not recorded").toContain(target);
  });

  it("captures a callback-API read, not only the synchronous forms", async () => {
    // Self-test of the instrumentation itself. The negative assertions below are
    // only as good as the recorder's reach, and a callback API that slipped
    // through would make every one of them vacuous for that code path.
    const root = projectWithLedger(1);
    const fs = await import("node:fs");
    const target = join(root, ".story", "roadmap.json");
    reads.length = 0;
    await new Promise<void>((resolve, reject) => {
      fs.readFile(target, "utf-8", (err) => (err ? reject(err) : resolve()));
    });
    expect(reads, "callback readFile was not recorded").toContain(target);
  });

  it("records reads at all, so a silent no-op recorder cannot pass the suite", () => {
    // The negative tests above are only meaningful if the recorder actually
    // fires. A Buffer or URL path that fell through `toPath` would produce an
    // empty `reads` array and vacuously satisfy every "no forbidden path" check.
    const root = projectWithLedger(3);
    evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.some((p) => p.endsWith("state.json"))).toBe(true);
  });

  it("reads only the sessions directory and its state.json files", () => {
    const root = projectWithLedger(50);
    evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });

    expect(reads.length).toBeGreaterThan(0);
    for (const path of reads) {
      expect(path, `unexpected read: ${path}`).toContain(`${sep}.story${sep}sessions`);
    }
  });

  it("read count does not grow with ledger size", () => {
    evaluateSessionGuard(projectWithLedger(10), { clientTaskId: "caller-task", client: "claude" });
    const small = reads.length;
    reads.length = 0;
    evaluateSessionGuard(projectWithLedger(3), { clientTaskId: "caller-task", client: "claude" });
    expect(reads.length).toBe(small);
  });
});
