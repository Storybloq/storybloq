/**
 * T-489 Bus idle-wake tier.
 *
 * ONE SEND, AT MOST ONE WAKE ATTEMPT. No episodes, no coalescing, no retry
 * budget, no rate limit, no persisted backoff, no scheduled recovery. The v1 spec
 * (14.3) specified all of that, but every one of those rules assumed the DAEMON
 * that owned the sweep and could hold the state centrally. This tier has no
 * daemon, by ruling, and a project-wide budget without one is a shared
 * lock-protected store whose check-and-reserve is not atomic merely because the
 * reservation file is written atomically.
 *
 * THE COST, stated rather than minimised: a burst of sends produces a burst of
 * wake attempts, and a failed wake is not retried until the next send happens to
 * occur. "Wake" is not a recovery promise.
 *
 * Rulings: r-eaxtyhqcxtfaevyk, r-snc9nppxxkrv9rr7 (as amended by
 * r-4gppsdk0z92s6t6r).
 */

import { randomUUID } from "node:crypto";
import { assertNever, type BusEndpoint } from "./schemas.js";

/**
 * What a wake attempt concluded.
 *
 * `kind` separates the three cases that must never be conflated:
 *  - `no-attempt`: the tier is off. Nothing happened and NOTHING is written, not
 *    even telemetry, because there was no decision to record.
 *  - `skipped`: a LOCAL decision not to engage the peer. Recorded as endpoint
 *    telemetry only. It never touched the peer, so it does not belong in the
 *    shared, hash-chained, peer-visible thread.
 *  - `requested` / `failed`: we actually engaged the peer, so these earn a wake
 *    ENTRY as well as telemetry.
 *
 * There is deliberately no `skipped` action in the entry enum (it is exactly
 * `requested | poll_observed | failed`); encoding a skip as `failed` would
 * misreport a deliberate non-attempt as an error.
 */
export type WakeOutcome =
  | { readonly kind: "no-attempt" }
  | { readonly kind: "skipped"; readonly reason: WakeSkipReason }
  | { readonly kind: "requested"; readonly wakeId: string }
  | { readonly kind: "failed"; readonly wakeId: string; readonly reason: string };

export type WakeSkipReason =
  | "not-codex"
  | "surface-unreachable"
  | "already-polled-through-batch"
  | "pending-unknown"
  | "thread-not-found"
  | "status-unknown"
  | "thread-system-error"
  | "active-turn"
  | "ownership-unproven";

/** Thread status as the app-server reports it. Four variants, not a boolean. */
export type CodexThreadStatus =
  | { readonly type: "notLoaded" }
  | { readonly type: "idle" }
  | { readonly type: "systemError" }
  | { readonly type: "active"; readonly activeFlags: unknown };

export interface WakeThreadRecord {
  readonly id: string;
  readonly status: CodexThreadStatus;
}

/**
 * Everything the attempt needs from the outside world, injected so the gate
 * ORDER can be tested without a daemon and, in particular, so "steps 1 to 4 spawn
 * ZERO subprocesses" is an assertion rather than a claim.
 */
export interface WakeDeps {
  /**
   * Absolute deadline (epoch ms) for the WHOLE attempt.
   *
   * Every RPC after the handshake is bounded by the remaining budget. Without
   * this, a server that completes the upgrade and then stops answering leaves the
   * attempt pending forever: `finally` never runs, the socket is never closed, and
   * the sending process blocks on a wake for mail that is ALREADY COMMITTED.
   */
  readonly deadline: number;
  /**
   * Reads the daemon version. THE FIRST SUBPROCESS: nothing before gate 5 may
   * spawn anything. Returns null when the daemon is not running.
   */
  readVersion(): Promise<string | null>;
  /** Opens a transport. Only reached at gate 6. */
  connect(): Promise<WakeConnection>;
  /**
   * FRESH verified pending read at the matching endpoint generation. Returns the
   * endpoint's `lastPolledMailboxSeq`, or null when the mailbox is missing or
   * unreadable, which is an explicit UNKNOWN and never "nothing pending".
   */
  readPolledSeq(): Promise<number | null>;
  /** Accepted daemon versions. An exact-match policy, stated by the caller. */
  readonly acceptedVersions: readonly string[];
}

export interface WakeConnection {
  /** Pages `thread/list` until the id is found or the pages are exhausted. */
  findThread(threadId: string): Promise<WakeThreadRecord | "not-found" | "incomplete">;
  /** Threads loaded in THIS app-server. Ownership evidence, never idleness. */
  loadedThreadIds(): Promise<readonly string[]>;
  /** Starts a turn. Exactly `{ threadId, input }` reaches the wire. */
  startTurn(threadId: string, text: string): Promise<void>;
  close(): void;
}

export interface WakeRequest {
  readonly endpoint: BusEndpoint;
  /** Mailbox sequence of the message just committed. INCLUSIVE (section 6). */
  readonly batchCursor: number;
  /** The codex thread id this endpoint is bound to. */
  readonly codexThreadId: string | null;
  /** Text the woken turn receives. */
  readonly wakeText: string;
}

/**
 * Run the wake gates in order, cheapest first, and attempt at most one wake.
 *
 * GATE ORDER IS LOAD-BEARING, not a micro-optimisation. An earlier revision put
 * the version gate first, which on a desktop endpoint would have recorded
 * `failed:version` instead of `skipped:surface-unreachable` while spawning a
 * subprocess the plan claimed it did not.
 */
export async function attemptWake(request: WakeRequest, deps: WakeDeps): Promise<WakeOutcome> {
  const { endpoint } = request;

  // GATE 1. Tier off: no attempt, and NO telemetry write. There is no decision to
  // record because no decision was reached.
  if (!wakeWanted(endpoint)) return { kind: "no-attempt" };

  // GATE 2.
  if (endpoint.client !== "codex") return { kind: "skipped", reason: "not-codex" };

  // GATE 3. The surface findClientProcess detects most reliably is precisely the
  // one this tier cannot reach: the desktop app-server is a child of ChatGPT.app
  // with no --listen, so stdio, so no external process can connect to it. This
  // skip is the EXPECTED outcome there, not a bug.
  if (endpoint.surface === "codex_desktop") {
    return { kind: "skipped", reason: "surface-unreachable" };
  }

  // GATE 4. A fresh verified pending read that must cover the just-committed
  // send's own mailbox sequence before any negative conclusion.
  const polled = await deps.readPolledSeq();
  if (polled === null) {
    // A missing or unreadable mailbox is an explicit unknown, NEVER "nothing
    // pending". Concluding "already polled" from an absent read would be reading
    // a fact out of silence.
    return { kind: "skipped", reason: "pending-unknown" };
  }
  if (polled >= request.batchCursor) {
    // Named for what it actually proves. `cursor <= lastPolledMailboxSeq` shows
    // only that no NEWER mail has been polled, not that nothing is pending, since
    // unacknowledged messages can remain.
    return { kind: "skipped", reason: "already-polled-through-batch" };
  }

  // Everything above this line spawns NOTHING. The first subprocess is below.
  const wakeId = randomUUID();

  // GATE 5. FIRST SUBPROCESS.
  const version = await deps.readVersion();
  if (version === null || !deps.acceptedVersions.includes(version)) {
    // Plain `version`, NOT `version:<observed>`. Two reasons, and the second is the
    // load-bearing one: it matches the documented vocabulary, and the observed
    // string is daemon-supplied text that has no business being concatenated into a
    // bounded telemetry field that humans and `review-stats` both read.
    return { kind: "failed", wakeId, reason: "version" };
  }

  if (request.codexThreadId === null) {
    return { kind: "skipped", reason: "ownership-unproven" };
  }

  // GATE 6. Hoisted so the narrowing survives into the deadline closures below.
  const codexThreadId = request.codexThreadId;
  let connection: WakeConnection | null = null;
  let timedOut = false;
  try {
    // A connect that LOSES the race would otherwise be lost entirely: `connection`
    // stays null, `finally` has nothing to close, and a socket that finishes
    // connecting a moment later is abandoned OPEN. Close it if it arrives late.
    connection = await bounded(() => {
      const pending = deps.connect();
      pending.then(
        (late) => {
          if (timedOut) late.close();
        },
        () => undefined,
      );
      return pending;
    }, deps.deadline);

    // Ownership BEFORE idleness. thread/loaded/list is the OWNERSHIP source and
    // nothing else: its emptiness means nothing is loaded HERE, which is a
    // different claim from "the thread is idle".
    const loaded = await bounded(() => connection!.loadedThreadIds(), deps.deadline);
    if (!loaded.includes(codexThreadId)) {
      return { kind: "skipped", reason: "ownership-unproven" };
    }

    const found = await bounded(() => connection!.findThread(codexThreadId), deps.deadline);
    if (found === "not-found") return { kind: "skipped", reason: "thread-not-found" };
    if (found === "incomplete") {
      // Ran out of deadline mid-paging. NOT a negative conclusion.
      return { kind: "failed", wakeId, reason: "lookup-incomplete" };
    }

    const verdict = classifyStatus(found.status);
    if (verdict !== "idle") return { kind: "skipped", reason: verdict };

    await bounded(() => connection!.startTurn(codexThreadId, request.wakeText), deps.deadline);
    // `requested` proves a turn was ACCEPTED and nothing more. It never proves
    // mail reached anyone; that evidence is `poll_observed`, and it comes from the
    // delivery layer, not from here.
    return { kind: "requested", wakeId };
  } catch (err) {
    if (err instanceof WakeTimeout) {
      timedOut = true;
      return { kind: "failed", wakeId, reason: "timeout" };
    }
    const reason = err instanceof Error && "reason" in err ? String(err.reason) : "io";
    return { kind: "failed", wakeId, reason };
  } finally {
    // An open socket keeps a handle alive and would outlive the wake.
    connection?.close();
  }
}

class WakeTimeout extends Error {
  constructor() {
    super("wake deadline exceeded");
    this.name = "WakeTimeout";
  }
}

/**
 * Bound one operation by the attempt's absolute deadline.
 *
 * Takes a FACTORY, not a promise, for two reasons that are defects otherwise:
 *
 *  - the deadline is checked BEFORE the operation starts, so an already-expired
 *    budget cannot still write a `turn/start` to the peer. Passing a promise means
 *    the call has already happened by the time this function looks at the clock.
 *  - every promise this starts gets a settlement handler attached, so a rejection
 *    arriving after the race has been lost (socket teardown, for instance) is
 *    absorbed here rather than surfacing as an unhandled rejection.
 *
 * The losing operation is abandoned rather than cancelled; destroying the socket
 * in the caller's `finally` is what actually stops it.
 */
async function bounded<T>(start: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new WakeTimeout();
  // `Promise.race` below SUBSCRIBES to `operation`, and that subscription is what
  // keeps a rejection arriving after the timeout has won from surfacing as an
  // unhandled rejection. An extra `operation.catch(...)` here would be unreachable
  // by any mutant, so it is not carried: a future refactor that replaces the race
  // has to re-establish the handler, and `test/bus/wake.test.ts` pins the
  // consequence rather than either mechanism.
  const operation = start();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WakeTimeout()), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map a thread status to `"idle"` or the skip reason it earns.
 *
 * The `switch` is exhaustive over the four KNOWN variants and its default hands
 * the value to `assertNever`, so adding a variant to the union fails the BUILD.
 * That guard does NOT make the runtime check below redundant: a newer server can
 * send a fifth tag our union does not contain, and no type checking can catch
 * that. Both are required, and they answer different questions.
 */
export function classifyStatus(status: unknown): "idle" | WakeSkipReason {
  if (typeof status !== "object" || status === null || !("type" in status)) {
    return "status-unknown";
  }
  const tag = (status as { type: unknown }).type;
  if (
    tag !== "idle" &&
    tag !== "active" &&
    tag !== "notLoaded" &&
    tag !== "systemError"
  ) {
    // A fifth state added by a later server must never read as idle.
    return "status-unknown";
  }
  const known = tag as CodexThreadStatus["type"];
  switch (known) {
    case "idle":
      return "idle";
    case "active":
      return "active-turn";
    case "notLoaded":
      // Not loaded in the app-server we can reach: we cannot prove we own it.
      return "ownership-unproven";
    case "systemError":
      return "thread-system-error";
    default:
      return assertNever(known, "classifyStatus");
  }
}

/**
 * The telemetry string recorded on the endpoint for an outcome.
 *
 * Returns null for `no-attempt`, which writes nothing at all.
 */
export function wakeTelemetry(outcome: WakeOutcome): string | null {
  switch (outcome.kind) {
    case "no-attempt":
      return null;
    case "skipped":
      return `skipped:${outcome.reason}`;
    case "requested":
      return "requested";
    case "failed":
      return `failed:${outcome.reason}`;
    default:
      return assertNever(outcome, "wakeTelemetry");
  }
}

/**
 * Exactly the params that may reach `turn/start`.
 *
 * A WHITELIST BY OMISSION, and a security boundary rather than a style rule:
 * TurnStartParams accepts thirteen fields beyond the two required, several of
 * which change the peer's sandbox, approvals or developer instructions. Building
 * the object literally here means a caller cannot pass one through by accident.
 */
export function buildTurnStartParams(threadId: string, text: string): {
  threadId: string;
  input: { type: "text"; text: string }[];
} {
  return { threadId, input: [{ type: "text", text }] };
}

/**
 * Decide whether a setup run should rewrite the endpoint's wake policy.
 *
 * OMITTED AND EXPLICIT `never` ARE DIFFERENT INTENTS, and collapsing them is the
 * bug this exists to prevent:
 *  - omitted (`undefined`) PRESERVES the stored policy, so rerunning setup cannot
 *    silently downgrade an endpoint someone deliberately set to `idle`;
 *  - explicit `never` is a decision and DISABLES the tier.
 * A CLI default of "never" erases that distinction and makes `--wake never` a
 * no-op on an endpoint that is already `idle`, leaving waking enabled.
 *
 * Returns the policy to write, or null when nothing should be written.
 */
/**
 * The text the woken turn receives, from the T-489 ticket verbatim.
 *
 * Defined ONCE and never built at a call site: it is the only thing the peer's
 * agent sees, and two surfaces sending different words would make the tier
 * unrecognisable to the reader on the other end.
 */
export const BUS_WAKE_TEXT =
  "Storybloq Bus: a message from your peer is waiting. Run `storybloq bus poll` and act on it.";

/**
 * Whether this endpoint has opted into being woken.
 *
 * The single source for the policy decision, shared by gate 1 and by the send
 * call site, so the two cannot drift into disagreeing about what `idle` means.
 */
export function wakeWanted(endpoint: BusEndpoint): boolean {
  return endpoint.wakePolicy === "idle";
}

export function resolveWakePolicyUpdate(
  current: BusEndpoint["wakePolicy"],
  requested: BusEndpoint["wakePolicy"] | undefined,
): BusEndpoint["wakePolicy"] | null {
  if (requested === undefined) return null;
  if (requested === current) return null;
  return requested;
}

/**
 * Internals reachable from tests.
 *
 * `bounded`'s pre-invocation deadline check cannot be observed end to end: an
 * operation that starts and then loses the race produces the SAME
 * `failed:timeout` as one that was never started. The difference is whether a
 * `turn/start` reached the peer, so it is asserted here directly rather than
 * inferred from an outcome that cannot distinguish the two.
 */
export const __wakeTesting = { bounded, WakeTimeout };
