/**
 * T-489 idle-wake tier: gates, outcomes and the turn/start whitelist.
 *
 * The deps are injected so GATE ORDER is asserted rather than claimed: every
 * gate-1-to-4 case checks that ZERO subprocesses were spawned, which is the
 * regression an earlier revision actually had.
 */

import { describe, expect, it } from "vitest";
import {
  attemptWake,
  resolveWakePolicyUpdate,
  buildTurnStartParams,
  classifyStatus,
  wakeTelemetry,
  type WakeConnection,
  __wakeTesting,
  type WakeDeps,
  type WakeRequest,
} from "../../src/bus/wake.js";
import type { BusEndpoint } from "../../src/bus/schemas.js";

const ACCEPTED = ["0.153.4"];

function endpoint(over: Partial<BusEndpoint> = {}): BusEndpoint {
  return {
    schema: "storybloq-bus-endpoint/v2",
    endpointId: "11111111-1111-4111-8111-111111111111",
    client: "codex",
    surface: "codex_cli",
    clientTaskId: "task-1",
    resumeHandle: null,
    projectRoot: "/tmp/p",
    gitBranch: null,
    worktreeId: "a".repeat(64),
    processRef: null,
    state: "attached",
    joinedAt: "2026-09-06T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z",
    wakePolicy: "idle",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    ...over,
  } as BusEndpoint;
}

interface Spy {
  versionCalls: number;
  connectCalls: number;
  started: { threadId: string; text: string }[];
  closed: number;
}

function makeDeps(
  over: Partial<WakeDeps> = {},
  connection: Partial<WakeConnection> = {},
): { deps: WakeDeps; spy: Spy } {
  const spy: Spy = { versionCalls: 0, connectCalls: 0, started: [], closed: 0 };
  const conn: WakeConnection = {
    loadedThreadIds: async () => ["thread-1"],
    findThread: async () => ({ id: "thread-1", status: { type: "idle" } }),
    startTurn: async (threadId, text) => {
      spy.started.push({ threadId, text });
    },
    close: () => {
      spy.closed++;
    },
    ...connection,
  };
  const deps: WakeDeps = {
    deadline: Date.now() + 5_000,
    acceptedVersions: ACCEPTED,
    readPolledSeq: async () => 0,
    readVersion: async () => {
      spy.versionCalls++;
      return "0.153.4";
    },
    connect: async () => {
      spy.connectCalls++;
      return conn;
    },
    ...over,
  };
  return { deps, spy };
}

function request(over: Partial<WakeRequest> = {}): WakeRequest {
  return {
    endpoint: endpoint(),
    batchCursor: 5,
    codexThreadId: "thread-1",
    wakeText: "new bus mail",
    ...over,
  };
}

describe("T-489 wake gates: nothing before gate 5 spawns a subprocess", () => {
  it("gate 1: a non-idle policy makes no attempt and writes no telemetry", async () => {
    const { deps, spy } = makeDeps();
    const out = await attemptWake(request({ endpoint: endpoint({ wakePolicy: "never" }) }), deps);
    expect(out.kind).toBe("no-attempt");
    // no-attempt writes NOTHING, not even telemetry: there was no decision.
    expect(wakeTelemetry(out)).toBeNull();
    expect(spy.versionCalls).toBe(0);
    expect(spy.connectCalls).toBe(0);
  });

  it("gate 1: offline_only is not idle and does not attempt", async () => {
    const { deps, spy } = makeDeps();
    const out = await attemptWake(
      request({ endpoint: endpoint({ wakePolicy: "offline_only" }) }),
      deps,
    );
    expect(out.kind).toBe("no-attempt");
    expect(spy.versionCalls).toBe(0);
  });

  it("gate 2: a non-codex client skips, with zero subprocesses", async () => {
    const { deps, spy } = makeDeps();
    const out = await attemptWake(
      request({ endpoint: endpoint({ client: "claude" }) }),
      deps,
    );
    expect(wakeTelemetry(out)).toBe("skipped:not-codex");
    expect(spy.versionCalls).toBe(0);
    expect(spy.connectCalls).toBe(0);
  });

  it("gate 3: codex_desktop skips as surface-unreachable, with ZERO subprocesses", async () => {
    // The regression this pins: an earlier revision ordered the version gate
    // first, which here would record failed:version instead, while spawning a
    // subprocess the plan claimed it did not.
    const { deps, spy } = makeDeps();
    const out = await attemptWake(
      request({ endpoint: endpoint({ surface: "codex_desktop" }) }),
      deps,
    );
    expect(wakeTelemetry(out)).toBe("skipped:surface-unreachable");
    expect(spy.versionCalls).toBe(0);
    expect(spy.connectCalls).toBe(0);
  });

  it("gate 4: a poll already covering the batch cursor skips, with zero subprocesses", async () => {
    const { deps, spy } = makeDeps({ readPolledSeq: async () => 5 });
    const out = await attemptWake(request({ batchCursor: 5 }), deps);
    // INCLUSIVE: coverage is `polled >= cursor`. A strict greater-than would leave
    // every successful wake unobserved until unrelated newer mail arrived.
    expect(wakeTelemetry(out)).toBe("skipped:already-polled-through-batch");
    expect(spy.versionCalls).toBe(0);
  });

  it("gate 4: an unreadable mailbox is an explicit unknown, never 'nothing pending'", async () => {
    const { deps, spy } = makeDeps({ readPolledSeq: async () => null });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("skipped:pending-unknown");
    expect(wakeTelemetry(out)).not.toBe("skipped:already-polled-through-batch");
    expect(spy.versionCalls).toBe(0);
  });

  it("gate 4: a poll BELOW the cursor proceeds past the gate", async () => {
    const { deps, spy } = makeDeps({ readPolledSeq: async () => 4 });
    const out = await attemptWake(request({ batchCursor: 5 }), deps);
    expect(out.kind).toBe("requested");
    expect(spy.versionCalls).toBe(1);
  });
});

describe("T-489 wake gates: version and connection", () => {
  it("gate 5: an absent daemon fails as version, and never connects", async () => {
    const { deps, spy } = makeDeps({ readVersion: async () => null });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("failed:version");
    expect(spy.connectCalls).toBe(0);
  });

  it("gate 5: an unaccepted version fails, and never connects", async () => {
    const { deps, spy } = makeDeps({ readVersion: async () => "0.1.0" });
    const out = await attemptWake(request(), deps);
    // The observed version is deliberately NOT interpolated: it is
    // daemon-supplied text and the vocabulary is a closed, documented set.
    expect(wakeTelemetry(out)).toBe("failed:version");
    expect(wakeTelemetry(out)).not.toContain("0.1.0");
    expect(spy.connectCalls).toBe(0);
  });

  it("closes the connection on the success path", async () => {
    const { deps, spy } = makeDeps();
    const out = await attemptWake(request(), deps);
    expect(out.kind).toBe("requested");
    expect(spy.closed).toBe(1);
  });

  it("closes the connection when an RPC throws", async () => {
    const { deps, spy } = makeDeps({}, {
      findThread: async () => {
        throw Object.assign(new Error("boom"), { reason: "frame" });
      },
    });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("failed:frame");
    // An open socket would outlive the wake.
    expect(spy.closed).toBe(1);
  });
});

describe("T-489 wake deadline bounds every RPC", () => {
  // Codex review: the transport bounded only the upgrade and initialize, so a
  // server that completed the handshake and then answered NOTHING left the attempt
  // pending forever. `finally` never ran, the socket was never closed, and the
  // sending process blocked on a wake for mail that was ALREADY COMMITTED.
  const hang = () => new Promise<never>(() => {});

  it("times out a hung thread/loaded/list and still closes the connection", async () => {
    const { deps, spy } = makeDeps({ deadline: Date.now() + 300 }, { loadedThreadIds: hang });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("failed:timeout");
    expect(spy.closed).toBe(1);
  });

  it("times out a hung thread/list and still closes the connection", async () => {
    const { deps, spy } = makeDeps({ deadline: Date.now() + 300 }, { findThread: hang });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("failed:timeout");
    expect(spy.closed).toBe(1);
  });

  it("times out a hung turn/start and still closes the connection", async () => {
    const { deps, spy } = makeDeps({ deadline: Date.now() + 300 }, { startTurn: hang });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("failed:timeout");
    expect(spy.closed).toBe(1);
  });

  it("times out a hung connect", async () => {
    const { deps } = makeDeps({ deadline: Date.now() + 300, connect: hang });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("failed:timeout");
  });

  it("fails closed when the deadline has ALREADY passed before gate 6", async () => {
    const { deps, spy } = makeDeps({ deadline: Date.now() - 1 });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("failed:timeout");
    expect(spy.started).toHaveLength(0);
  });
});

describe("T-489 wake gates: ownership and status", () => {
  it("a thread not loaded here is ownership-unproven, and no turn is started", async () => {
    const { deps, spy } = makeDeps({}, { loadedThreadIds: async () => [] });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("skipped:ownership-unproven");
    expect(spy.started).toHaveLength(0);
  });

  it("an absent codex thread id is ownership-unproven and never connects", async () => {
    const { deps, spy } = makeDeps();
    const out = await attemptWake(request({ codexThreadId: null }), deps);
    expect(wakeTelemetry(out)).toBe("skipped:ownership-unproven");
    expect(spy.connectCalls).toBe(0);
  });

  it("an active turn skips WITHOUT calling turn/start", async () => {
    const { deps, spy } = makeDeps({}, {
      findThread: async () => ({ id: "thread-1", status: { type: "active", activeFlags: {} } }),
    });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("skipped:active-turn");
    expect(spy.started).toHaveLength(0);
  });

  it("a systemError thread skips", async () => {
    const { deps, spy } = makeDeps({}, {
      findThread: async () => ({ id: "thread-1", status: { type: "systemError" } }),
    });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("skipped:thread-system-error");
    expect(spy.started).toHaveLength(0);
  });

  it("a thread absent from every page is thread-not-found, not a failure", async () => {
    const { deps } = makeDeps({}, { findThread: async () => "not-found" });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("skipped:thread-not-found");
  });

  it("running out of deadline mid-paging FAILS rather than concluding absence", async () => {
    const { deps } = makeDeps({}, { findThread: async () => "incomplete" });
    const out = await attemptWake(request(), deps);
    expect(wakeTelemetry(out)).toBe("failed:lookup-incomplete");
    expect(wakeTelemetry(out)).not.toBe("skipped:thread-not-found");
  });

  it("starts exactly one turn on the idle path, carrying the wake text", async () => {
    const { deps, spy } = makeDeps();
    const out = await attemptWake(request({ wakeText: "hello" }), deps);
    expect(out.kind).toBe("requested");
    expect(spy.started).toEqual([{ threadId: "thread-1", text: "hello" }]);
  });
});

describe("T-489 status classification", () => {
  it("maps each of the four known variants", () => {
    expect(classifyStatus({ type: "idle" })).toBe("idle");
    expect(classifyStatus({ type: "active", activeFlags: {} })).toBe("active-turn");
    expect(classifyStatus({ type: "notLoaded" })).toBe("ownership-unproven");
    expect(classifyStatus({ type: "systemError" })).toBe("thread-system-error");
  });

  it("never reads an UNKNOWN fifth state as idle", () => {
    // The compile-time assertNever guard cannot catch this: a newer server can
    // send a tag our union does not contain.
    expect(classifyStatus({ type: "hibernating" })).toBe("status-unknown");
    expect(classifyStatus({ type: 42 })).toBe("status-unknown");
  });

  it("treats a malformed or absent status as unknown, not idle", () => {
    expect(classifyStatus(null)).toBe("status-unknown");
    expect(classifyStatus(undefined)).toBe("status-unknown");
    expect(classifyStatus({})).toBe("status-unknown");
    expect(classifyStatus("idle")).toBe("status-unknown");
  });
});

describe("T-489 turn/start whitelist by omission", () => {
  it("emits EXACTLY the two permitted keys", () => {
    const params = buildTurnStartParams("t-1", "wake up");
    expect(Object.keys(params).sort()).toEqual(["input", "threadId"]);
  });

  it("serializes input as the tagged text variant", () => {
    expect(JSON.parse(JSON.stringify(buildTurnStartParams("t-1", "wake up")))).toEqual({
      threadId: "t-1",
      input: [{ type: "text", text: "wake up" }],
    });
  });

  it("cannot carry a forbidden override even when one is offered", () => {
    // TurnStartParams accepts thirteen fields beyond the two required, several of
    // which change the peer's sandbox, approvals or developer instructions. The
    // builder takes scalars, so a contaminated source object cannot leak through.
    const contaminated = {
      threadId: "t-1",
      text: "wake up",
      approvalPolicy: "never",
      sandboxPolicy: "danger-full-access",
      approvalsReviewer: "nobody",
      personality: "evil",
      turnTrigger: "auto",
      unknownSentinel: "SHOULD-NOT-APPEAR",
    };
    const params = buildTurnStartParams(contaminated.threadId, contaminated.text);
    const wire = JSON.stringify(params);
    for (const forbidden of [
      "approvalPolicy",
      "sandboxPolicy",
      "approvalsReviewer",
      "personality",
      "turnTrigger",
      "SHOULD-NOT-APPEAR",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });
});

describe("T-489 wake policy: omitted and explicit never are different intents", () => {
  it("PRESERVES the stored policy when the flag is omitted", () => {
    // A CLI default would erase this distinction and make a rerun of setup silently
    // downgrade an endpoint someone deliberately enabled.
    expect(resolveWakePolicyUpdate("idle", undefined)).toBeNull();
    expect(resolveWakePolicyUpdate("never", undefined)).toBeNull();
    expect(resolveWakePolicyUpdate("offline_only", undefined)).toBeNull();
  });

  it("DISABLES an enabled tier on an explicit never", () => {
    // With a default of "never" this was a no-op and waking stayed on.
    expect(resolveWakePolicyUpdate("idle", "never")).toBe("never");
  });

  it("enables on an explicit idle", () => {
    expect(resolveWakePolicyUpdate("never", "idle")).toBe("idle");
    expect(resolveWakePolicyUpdate("offline_only", "idle")).toBe("idle");
  });

  it("writes nothing when the requested policy already matches", () => {
    expect(resolveWakePolicyUpdate("idle", "idle")).toBeNull();
    expect(resolveWakePolicyUpdate("never", "never")).toBeNull();
  });
});

describe("T-489 the deadline bounds every peer operation, not just the first", () => {
  it("reports failed:timeout when connect never resolves", async () => {
    const { deps } = makeDeps({
      deadline: Date.now() + 120,
      connect: () => new Promise<WakeConnection>(() => undefined),
    });
    const out = await attemptWake(request(), deps);
    expect(out).toMatchObject({ kind: "failed", reason: "timeout" });
  });

  it("CLOSES a connection that arrives after the deadline has already been lost", async () => {
    // Without this the socket is abandoned OPEN: `connection` is still null when
    // the race is lost, so the `finally` has nothing to close, and a connect that
    // finishes a moment later leaks a live handle for the life of the process.
    let closed = 0;
    const conn: WakeConnection = {
      loadedThreadIds: async () => [],
      findThread: async () => "not-found",
      startTurn: async () => undefined,
      close: () => {
        closed++;
      },
    };
    const { deps } = makeDeps({
      deadline: Date.now() + 60,
      connect: () => new Promise<WakeConnection>((resolve) => setTimeout(() => resolve(conn), 140)),
    });
    const out = await attemptWake(request(), deps);
    expect(out).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(closed).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(1);
  });

  it("does NOT INVOKE an operation whose budget is already spent", async () => {
    // The sharpest form of the defect, and one an end-to-end outcome cannot see: a
    // deadline checked only AFTER the call has been made still writes the
    // `turn/start` to the peer, then reports `failed:timeout`. Both orders produce
    // that same outcome, so the difference is only visible here.
    let invoked = 0;
    await expect(
      __wakeTesting.bounded(() => {
        invoked++;
        return Promise.resolve("started");
      }, Date.now() - 1),
    ).rejects.toBeInstanceOf(__wakeTesting.WakeTimeout);
    expect(invoked).toBe(0);
  });

  it("DOES invoke an operation that still has budget (negative control)", async () => {
    await expect(__wakeTesting.bounded(() => Promise.resolve("ok"), Date.now() + 5_000)).resolves.toBe(
      "ok",
    );
  });

  it("absorbs a rejection that arrives after the race is already lost", async () => {
    // A peer operation that rejects during teardown, after the timeout won, has
    // nothing listening to it. Unhandled, it takes the whole process down.
    //
    // `findThread` and NOT `connect`: the connect call site attaches its own
    // handler so it can close a late arrival, which would mask the defect. The
    // other three call sites have no such handler, so they are where the general
    // guarantee has to be proven.
    //
    // This pins the CONSEQUENCE (no unhandled rejection), not the mechanism, and
    // the two are not the same thing here: `Promise.race` subscribes to what it is
    // handed, so deleting the explicit `operation.catch` leaves this green. That
    // makes the explicit catch an equivalent mutant, recorded as such, and it is
    // this assertion rather than that line that holds the guarantee in place.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { deps } = makeDeps(
        { deadline: Date.now() + 60 },
        {
          findThread: () =>
            new Promise((_resolve, reject) =>
              setTimeout(() => reject(new Error("socket torn down")), 140),
            ),
        },
      );
      const out = await attemptWake(request(), deps);
      expect(out).toMatchObject({ kind: "failed", reason: "timeout" });
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
