import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { E2ECliFixture, CLI_PATH } from "../helpers/e2e-cli.js";
import { initProject } from "../../src/core/init.js";
import { canonicalHash } from "../../src/bus/canonical.js";
import { acknowledgeBusMessage, pollBus, sendBusMessage } from "../../src/bus/index.js";
import { resolveBusPaths, type BusPaths } from "../../src/bus/paths.js";
import {
  __waitTesting as waitTesting,
  acquireWaiter,
  cleanupWaiter,
  waitForBusMessage,
  WaiterActiveError,
  WAIT_ARGV_MARKERS,
  WAIT_DEFAULT_TIMEOUT_SECONDS,
  WAIT_TIMEOUT_MAX_SECONDS,
  WAIT_TIMEOUT_MIN_SECONDS,
  type WaiterIdentity,
} from "../../src/bus/wait.js";
import { createBusFixture, type BusFixture } from "./helpers.js";
import { runBusCli } from "./cli-harness.js";

const fixtures: BusFixture[] = [];
const extraRoots: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map((f) => rm(f.root, { recursive: true, force: true })),
    ...extraRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

async function fixture(): Promise<BusFixture> {
  const value = await createBusFixture("bus-rendezvous");
  fixtures.push(value);
  return value;
}

// b (claude reviewer) -> a (codex implementer): mail lands in endpoint a's mailbox,
// the endpoint every wait test blocks on.
function sendToA(f: BusFixture, overrides: Record<string, unknown> = {}) {
  return sendBusMessage(f.root, {
    endpointId: f.b.endpointId,
    clientTaskId: f.bTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: "Please verify the wait rendezvous.",
    refs: { ciRun: "ci-wait-1" },
    idempotencyKey: "wait-question-1",
    ...overrides,
  });
}

function waiterFile(paths: BusPaths, endpointId: string): string {
  return join(paths.locks, `waiter-${endpointId}.lock`);
}

function makeIdentity(overrides: Partial<WaiterIdentity> = {}): WaiterIdentity {
  return {
    waiterId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argvMarkers: WAIT_ARGV_MARKERS,
    ...overrides,
  };
}

// Plant a well-formed foreign waiter record (a competing `--wait`) at the slot.
async function writeForeignWaiter(
  paths: BusPaths,
  endpointId: string,
  overrides: Partial<WaiterIdentity> = {},
): Promise<WaiterIdentity> {
  const id = makeIdentity(overrides);
  await writeFile(
    waiterFile(paths, endpointId),
    JSON.stringify({
      schema: "storybloq-bus-waiter/v1",
      waiterId: id.waiterId,
      pid: id.pid,
      startedAt: id.startedAt,
      argvMarkers: [...id.argvMarkers],
    }, null, 2) + "\n",
    "utf-8",
  );
  return id;
}

async function readWaiter(paths: BusPaths, endpointId: string): Promise<{ waiterId: string }> {
  return JSON.parse(await readFile(waiterFile(paths, endpointId), "utf-8")) as { waiterId: string };
}

// Minimal v1 runtime: classifyBusRuntime keys off instance.json's schema only, and
// resolveOwnedEndpoint's v1 branch returns immediately when --endpoint is supplied,
// so a bus-enabled project with just a v1 instance.json classifies as v1.
async function createMinimalV1(): Promise<{ root: string; taskId: string; endpointId: string }> {
  const root = await mkdtemp(join(tmpdir(), "bus-rendezvous-v1-"));
  extraRoots.push(root);
  await initProject(root, { name: "bus-rendezvous-v1" });
  const canonical = await realpath(root);
  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");
  const busRoot = join(root, ".story", "bus");
  await mkdir(busRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(canonical),
    createdAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf-8");
  return { root, taskId: "codex-task-v1wait", endpointId: randomUUID() };
}

function pollWaitArgs(f: BusFixture, timeout: string): string[] {
  return ["bus", "poll", "--wait", "--timeout", timeout, "--endpoint", f.a.endpointId, "--client", "codex", "--task-id", f.aTaskId];
}

describe("T-427 waiter-lock single-waiter protocol", () => {
  it("acquires the slot, frees it on same-identity cleanup, and re-acquires", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const id = makeIdentity();

    await acquireWaiter(paths, f.a.endpointId, id, () => "match");
    expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(true);

    // A second acquire while the slot is held fails closed.
    await expect(acquireWaiter(paths, f.a.endpointId, makeIdentity(), () => "match"))
      .rejects.toBeInstanceOf(WaiterActiveError);

    await cleanupWaiter(paths, f.a.endpointId, id);
    expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(false);

    // Freed -> a fresh acquire succeeds.
    await acquireWaiter(paths, f.a.endpointId, makeIdentity(), () => "absent");
    expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(true);
  });

  it("fails closed (WAITER_ACTIVE) when the incumbent probes match OR unknown", async () => {
    for (const verdict of ["match", "unknown"] as const) {
      const f = await fixture();
      const paths = await resolveBusPaths(f.root, false);
      const incumbent = await writeForeignWaiter(paths, f.a.endpointId);
      await expect(acquireWaiter(paths, f.a.endpointId, makeIdentity(), () => verdict))
        .rejects.toBeInstanceOf(WaiterActiveError);
      // The incumbent record is never disturbed.
      expect((await readWaiter(paths, f.a.endpointId)).waiterId).toBe(incumbent.waiterId);
    }
  });

  it("steals only a positively-absent (dead) incumbent, then owns the slot", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const dead = await writeForeignWaiter(paths, f.a.endpointId);
    const mine = makeIdentity();
    await acquireWaiter(paths, f.a.endpointId, mine, () => "absent");
    const rec = await readWaiter(paths, f.a.endpointId);
    expect(rec.waiterId).toBe(mine.waiterId);
    expect(rec.waiterId).not.toBe(dead.waiterId);
  });

  it("cleanup never removes a record owned by a different identity", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const foreign = await writeForeignWaiter(paths, f.a.endpointId);

    await cleanupWaiter(paths, f.a.endpointId, makeIdentity());
    expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(true);
    expect((await readWaiter(paths, f.a.endpointId)).waiterId).toBe(foreign.waiterId);

    // The true owner still cleans up.
    await cleanupWaiter(paths, f.a.endpointId, foreign);
    expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(false);
  });

  it("cleanup after runtime deletion recreates nothing (no bus evidence resurrected)", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const id = makeIdentity();
    await acquireWaiter(paths, f.a.endpointId, id, () => "match");
    expect(existsSync(paths.locks)).toBe(true);

    // T-428 deletes the whole bus runtime while this wait is still blocked; the waiter
    // record vanishes with it.
    await rm(paths.busRoot, { recursive: true, force: true });
    expect(existsSync(paths.busRoot)).toBe(false);

    // Cleanup must be a benign no-op. It must NOT re-materialize the locks directory (or
    // any bus path) by acquiring a creating guard lock after deletion.
    await cleanupWaiter(paths, f.a.endpointId, id);
    expect(existsSync(paths.busRoot)).toBe(false);
    expect(existsSync(paths.locks)).toBe(false);
    expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(false);
  });

  it("recreates nothing even when the runtime is deleted in the check-to-lock window", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const id = makeIdentity();
    await acquireWaiter(paths, f.a.endpointId, id, () => "match");

    // Delete the runtime in the exact window AFTER cleanup's existsSync precheck passes
    // and BEFORE it acquires the guard. The non-creating (create:false) guard must then
    // refuse rather than mkdir `.story/bus/locks` -- the existsSync precheck alone cannot
    // close this window, so this proves the authoritative guarantee.
    waitTesting.setAfterCleanupExistenceCheckHook(async () => {
      await rm(paths.busRoot, { recursive: true, force: true });
    });
    try {
      await cleanupWaiter(paths, f.a.endpointId, id);
    } finally {
      waitTesting.setAfterCleanupExistenceCheckHook(null);
    }
    expect(existsSync(paths.busRoot)).toBe(false);
    expect(existsSync(paths.locks)).toBe(false);
  });

  it("fails closed on a symlinked waiter path and never follows it", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const secret = join(f.root, "outside-secret.json");
    await writeFile(secret, JSON.stringify({ stolen: true }), "utf-8");
    await symlink(secret, waiterFile(paths, f.a.endpointId));

    await expect(acquireWaiter(paths, f.a.endpointId, makeIdentity(), () => "absent"))
      .rejects.toBeInstanceOf(WaiterActiveError);
    // Cleanup must not delete through the symlink.
    await cleanupWaiter(paths, f.a.endpointId, makeIdentity());
    expect(JSON.parse(await readFile(secret, "utf-8"))).toEqual({ stolen: true });
  });

  it("serializes concurrent acquisitions so exactly one wins (guard closes the steal race)", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    // Two racing acquisitions, each probing any incumbent as live. The per-endpoint
    // guard serializes the read->probe->create so they can never both own the slot.
    const results = await Promise.allSettled([
      acquireWaiter(paths, f.a.endpointId, makeIdentity(), () => "match"),
      acquireWaiter(paths, f.a.endpointId, makeIdentity(), () => "match"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(WaiterActiveError);
  });

  it("a cleanup racing a re-acquire never deletes the new owner's record", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const first = makeIdentity();
    await acquireWaiter(paths, f.a.endpointId, first, () => "match");

    const second = makeIdentity();
    const [, acq] = await Promise.allSettled([
      cleanupWaiter(paths, f.a.endpointId, first), // the departing owner
      acquireWaiter(paths, f.a.endpointId, second, () => "match"), // a fresh waiter
    ]);
    // Whichever order the guard picks, the slot is never left owned by `first`, and a
    // successful acquire is never silently deleted by the cleanup.
    if (acq.status === "fulfilled") {
      expect((await readWaiter(paths, f.a.endpointId)).waiterId).toBe(second.waiterId);
    } else {
      expect((acq as PromiseRejectedResult).reason).toBeInstanceOf(WaiterActiveError);
      expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(false); // first cleaned up
    }
  });
});

describe("T-427 waitForBusMessage engine", () => {
  it("returns a message that is already pending, and cleans up its waiter", async () => {
    const f = await fixture();
    await sendToA(f);
    const outcome = await waitForBusMessage({
      root: f.root,
      endpointId: f.a.endpointId,
      clientTaskId: f.aTaskId,
      timeoutMs: 2000,
    });
    expect(outcome.kind).toBe("message");
    if (outcome.kind === "message") {
      expect(outcome.result.messages.map((m) => m.message.body)).toContain("Please verify the wait rendezvous.");
      expect(outcome.result.cursor).toBeGreaterThan(0);
    }
    const paths = await resolveBusPaths(f.root, false);
    expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(false);
  });

  it("times out with an empty outcome when nothing arrives", async () => {
    const f = await fixture();
    const outcome = await waitForBusMessage({
      root: f.root,
      endpointId: f.a.endpointId,
      clientTaskId: f.aTaskId,
      timeoutMs: 150,
    });
    expect(outcome.kind).toBe("timeout");
    const paths = await resolveBusPaths(f.root, false);
    expect(existsSync(waiterFile(paths, f.a.endpointId))).toBe(false);
  });

  it("wakes and returns a message that arrives during the wait", async () => {
    const f = await fixture();
    const outcome = await waitForBusMessage({
      root: f.root,
      endpointId: f.a.endpointId,
      clientTaskId: f.aTaskId,
      timeoutMs: 4000,
      onArmed: () => { void sendToA(f); },
    });
    expect(outcome.kind).toBe("message");
    if (outcome.kind === "message") {
      expect(outcome.result.messages.length).toBeGreaterThan(0);
    }
  });

  it("refuses to start when a live waiter owns the endpoint and preserves its record", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const incumbent = await writeForeignWaiter(paths, f.a.endpointId);
    await expect(waitForBusMessage({
      root: f.root,
      endpointId: f.a.endpointId,
      clientTaskId: f.aTaskId,
      timeoutMs: 2000,
      probe: () => "match",
    })).rejects.toBeInstanceOf(WaiterActiveError);
    expect((await readWaiter(paths, f.a.endpointId)).waiterId).toBe(incumbent.waiterId);
  });
});

describe("T-427 `bus poll --wait` CLI", () => {
  it("exits 4 on timeout with an empty-poll envelope", async () => {
    const f = await fixture();
    const { stdout, exitCode } = await runBusCli(f.root, pollWaitArgs(f, "1"));
    expect(exitCode).toBe(4);
    expect(stdout).toContain("No pending Bus messages.");
  });

  it("exits 0 and prints a message that is already pending", async () => {
    const f = await fixture();
    await sendToA(f);
    const { stdout, exitCode } = await runBusCli(f.root, pollWaitArgs(f, "5"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Please verify the wait rendezvous.");
  });

  it("honors --limit under --wait (drain returns at most the limit)", async () => {
    const f = await fixture();
    // Two messages are already pending; --limit 1 must bound the drain to a single one.
    await sendToA(f, { idempotencyKey: "wait-limit-1", refs: { ciRun: "ci-limit-1" }, body: "limit msg one" });
    await sendToA(f, { idempotencyKey: "wait-limit-2", refs: { ciRun: "ci-limit-2" }, body: "limit msg two" });
    const args = ["bus", "poll", "--wait", "--timeout", "5", "--limit", "1",
      "--endpoint", f.a.endpointId, "--client", "codex", "--task-id", f.aTaskId, "--format", "json"];
    const { stdout, exitCode } = await runBusCli(f.root, args);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { data: { messages: unknown[] } };
    expect(parsed.data.messages).toHaveLength(1);
  });

  it("rejects a non-integer or out-of-range --timeout as a usage error (exit 1), not a timeout", async () => {
    const f = await fixture();
    for (const bad of ["0", "3601", "1.5", "abc"]) {
      const { stdout, exitCode } = await runBusCli(f.root, pollWaitArgs(f, bad));
      expect(exitCode).toBe(1);
      expect(stdout).toContain("--timeout must be an integer between 1 and 3600");
    }
  });

  it("exits 5 (WAITER_ACTIVE) when the waiter slot is held and cannot be proven dead", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    // A waiter record that cannot be read/validated cannot be proven dead, so the
    // runner fails closed (exit 5) rather than stomping a possibly-live waiter. The
    // engine test above covers the live-argv-match path with an injected probe.
    await writeFile(waiterFile(paths, f.a.endpointId), "{ not valid json", "utf-8");
    const { exitCode } = await runBusCli(f.root, pollWaitArgs(f, "2"));
    expect(exitCode).toBe(5);
  });

  it("refuses a v1 runtime (v2 only)", async () => {
    const v1 = await createMinimalV1();
    const { stdout, exitCode } = await runBusCli(
      v1.root,
      ["bus", "poll", "--wait", "--timeout", "5", "--endpoint", v1.endpointId, "--client", "codex", "--task-id", v1.taskId],
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("requires a v2 Bus runtime");
  });

  it("defaults the wait deadline to 300 seconds (plan compliance)", () => {
    expect(WAIT_DEFAULT_TIMEOUT_SECONDS).toBe(300);
    expect(WAIT_DEFAULT_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(WAIT_TIMEOUT_MIN_SECONDS);
    expect(WAIT_DEFAULT_TIMEOUT_SECONDS).toBeLessThanOrEqual(WAIT_TIMEOUT_MAX_SECONDS);
  });

  it("a timeout envelope carries the endpoint's REAL cursor, not a fabricated 0", async () => {
    const f = await fixture();
    await sendToA(f);
    // Poll + ack to ADVANCE lastPolledMailboxSeq and empty the mailbox.
    const polled = await pollBus(f.root, { endpointId: f.a.endpointId, clientTaskId: f.aTaskId });
    expect(polled.cursor).toBeGreaterThan(0);
    await acknowledgeBusMessage(f.root, {
      endpointId: f.a.endpointId,
      clientTaskId: f.aTaskId,
      messageId: polled.messages[0]!.message.messageId,
      disposition: "accepted",
    });

    const { stdout, exitCode } = await runBusCli(f.root, [...pollWaitArgs(f, "1"), "--format", "json"]);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stdout) as { data: { cursor: number; messages: unknown[] } };
    expect(env.data.messages).toEqual([]);
    expect(env.data.cursor).toBe(polled.cursor); // the advanced cursor, not 0
  });

  it("a live waiter-<id>.lock is not flagged by bus doctor or an ordinary poll", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    await writeForeignWaiter(paths, f.a.endpointId); // simulate an active waiter marker
    const doctor = await runBusCli(f.root, ["bus", "doctor", "--format", "json"]);
    expect(doctor.exitCode).toBe(0); // healthy: the waiter lock is not an integrity finding
    const poll = await runBusCli(f.root, ["bus", "poll", "--endpoint", f.a.endpointId, "--client", "codex", "--task-id", f.aTaskId, "--format", "json"]);
    expect(poll.exitCode).toBe(0);
  });
});

describe("T-427 `bus poll --wait` process signal contract", () => {
  const cliPath = CLI_PATH;

  // ISS-1091: this is the file's only real subprocess spawn (every other
  // CLI-shaped call above routes through the in-process runBusCli() helper
  // and stays untouched); env source swapped to the shared fixture's
  // isolated HOME so the built CLI's preCommandHousekeeping pass never
  // touches the real ~/.claude/skills, spawn call otherwise verbatim.
  let cliFixture: E2ECliFixture;
  beforeAll(async () => {
    cliFixture = await E2ECliFixture.create();
  });
  afterAll(async () => {
    await cliFixture.cleanup();
  });

  async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  // Spawn the REAL built CLI so the SIGINT handler + cleanup run in a genuine process.
  it("exits 130 on SIGINT after draining, and removes its waiter file", async () => {
    const f = await fixture();
    const paths = await resolveBusPaths(f.root, false);
    const marker = waiterFile(paths, f.a.endpointId);
    const child = spawn(process.execPath, [
      cliPath, "bus", "poll", "--wait", "--timeout", "30",
      "--endpoint", f.a.endpointId, "--client", "codex", "--task-id", f.aTaskId,
    ], { cwd: f.root, stdio: "ignore", env: cliFixture.env() });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      // The waiter marker is created AFTER the SIGINT handler is installed (see
      // waitForBusMessage), so its existence is a deterministic readiness handshake: once
      // it exists, the handler is provably registered and interrupting yields 130, never a
      // raw signal death in the handler-installation window.
      expect(await waitForFile(marker, 10_000)).toBe(true);
      child.kill("SIGINT");

      const result = await exit;
      expect(result.code).toBe(130);
      expect(existsSync(marker)).toBe(false); // finally-block cleanup removed the waiter
    } finally {
      // Never leak the child if setup or an assertion above threw before it exited.
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
});
