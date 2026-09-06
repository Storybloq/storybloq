/**
 * T-489 wake runner: the real dependencies behind `attemptWake`.
 *
 * Kept OUT of `sendBusMessage` on purpose. A send is a transactional, lock-held
 * operation over a hash chain; a wake is best-effort network I/O. Wiring the wake
 * into the send would put socket I/O inside that transaction and make failure
 * isolation a matter of remembering a try/catch. Here the isolation is
 * STRUCTURAL: the caller commits the mail first, then calls this, and this never
 * throws.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  connectCodexAppServer,
  type CodexAppServerClient,
} from "./codex-app-server.js";
import { listEndpoints, updateEndpoint } from "./endpoints.js";
import { resolveBusPaths } from "./paths.js";
import { readMailboxHighwater, appendWakeEntry } from "./store.js";
import {
  attemptWake,
  buildTurnStartParams,
  wakeTelemetry,
  type WakeConnection,
  type WakeDeps,
  type WakeOutcome,
  type WakeThreadRecord,
} from "./wake.js";
import type { BusEndpoint } from "./schemas.js";
import { currentCliVersion } from "../core/team-capabilities.js";

/** The daemon control socket. Present only while a daemon is running. */
export function codexControlSocketPath(): string {
  return join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
}

/**
 * Versions this tier is verified against.
 *
 * A transcript verifies the ONE pair it was captured against. Anything else is
 * unverified, and unverified is refused rather than assumed compatible.
 */
export const ACCEPTED_APP_SERVER_VERSIONS = ["0.153.4"] as const;

const DEFAULT_DEADLINE_MS = 10_000;
/** Bounded so an unread pipe cannot stall the child, and a flood cannot grow. */
const STDERR_RING_BYTES = 8 * 1024;

/**
 * Read the daemon's app-server version.
 *
 * Returns null when the daemon is not running, which is a NORMAL state: the
 * control socket exists only while a daemon does. There is no plain `version`
 * field in this output; the names are `cliVersion`, `appServerVersion` and
 * `managedCodexVersion`, and liveness reads as `status: "running"`.
 */
export async function readDaemonVersion(deadlineMs: number): Promise<string | null> {
  const out = await runBounded("codex", ["app-server", "daemon", "version"], deadlineMs);
  if (out === null) return null;
  try {
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record["status"] !== "running") return null;
    const version = record["appServerVersion"];
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Spawn a child, bounded by a deadline, and return stdout or null.
 *
 * Never throws: a spawn error (`ENOENT` when codex is absent) is null, not a
 * crash. stderr is drained into a bounded ring because an UNREAD pipe can stall
 * the child. On timeout the child gets SIGTERM then SIGKILL after a grace, and its
 * exit is observed before returning so nothing is orphaned and no handle keeps the
 * sender alive.
 */
async function runBounded(
  command: string,
  args: readonly string[],
  deadlineMs: number,
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(value);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf-8")).slice(-STDERR_RING_BYTES);
    });
    child.on("error", () => {
      finish(null);
    });
    child.on("close", (code) => {
      finish(code === 0 ? stdout : null);
    });

    let killTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref?.();
      // Deliberately not resolving here: the `close` handler resolves once the
      // child has actually exited, so the wake never returns while a child lives.
    }, deadlineMs);
    timer.unref?.();
  });
}

/** Page `thread/list` for one id, honouring the deadline. */
async function findThreadPaged(
  client: CodexAppServerClient,
  threadId: string,
  deadline: number,
): Promise<WakeThreadRecord | "not-found" | "incomplete"> {
  let cursor: string | null = null;
  for (;;) {
    if (Date.now() >= deadline) return "incomplete";
    const params: Record<string, unknown> = { limit: 50 };
    if (cursor !== null) params["cursor"] = cursor;
    const raw = await client.request("thread/list", params);
    // A malformed page proves NOTHING. Treating an unparseable response as an
    // exhausted listing would record `skipped:thread-not-found`, a positive claim
    // of absence, on the strength of a response we could not read.
    if (typeof raw !== "object" || raw === null) return "incomplete";
    const page = raw as Record<string, unknown>;
    const data = page["data"];
    if (!Array.isArray(data)) return "incomplete";
    // A record we cannot INSPECT is not a record we have ruled out. Skipping it
    // silently and then reporting `not-found` would turn an unreadable element into
    // a positive claim that the thread is absent, which is the same fabrication the
    // malformed-page guard above exists to prevent, one level further in.
    let unusable = 0;
    for (const item of data) {
      if (typeof item !== "object" || item === null) {
        unusable++;
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = record["id"];
      if (typeof id !== "string" || id.length === 0) {
        unusable++;
        continue;
      }
      if (id === threadId) {
        return { id: threadId, status: record["status"] as WakeThreadRecord["status"] };
      }
    }
    // Only reached when the id was NOT on this page. A page carrying unreadable
    // records cannot support "keep looking" either: the very next page ending the
    // listing would conclude absence on evidence this page failed to provide.
    if (unusable > 0) return "incomplete";
    const next = page["nextCursor"];
    // Exhausting every VALID page without the id is the only thing that proves
    // absence. `null` is the documented terminal cursor; anything else that is not
    // a usable cursor is an unreadable pagination state, not an ending.
    if (next === null || next === undefined) return "not-found";
    if (typeof next !== "string" || next.length === 0) return "incomplete";
    cursor = next;
  }
}

/**
 * Ids loaded in this app-server.
 *
 * Tolerant of both a bare id and a record carrying one: the captured transcript
 * returned an EMPTY array, and an empty array does not reveal its element type,
 * so assuming `string[]` here would be asserting something never observed.
 */
async function loadedIds(client: CodexAppServerClient): Promise<string[]> {
  const page = (await client.request("thread/loaded/list", {})) as Record<string, unknown>;
  const data = page["data"];
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const raw of data) {
    if (typeof raw === "string") ids.push(raw);
    else if (typeof raw === "object" && raw !== null) {
      const id = (raw as Record<string, unknown>)["id"];
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

/**
 * The polled-cursor read behind gate 4.
 *
 * Extracted so both of its refusals can be tested directly. They are refusals, not
 * lookups, and each answers a way this gate could otherwise manufacture a
 * conclusion:
 *
 *  - `batchCursorKnown === false`: the cursor this would be COMPARED AGAINST was
 *    never established. Returning a number here lets `polled >= 0` succeed against
 *    a fabricated cursor of zero and record `already-polled-through-batch` for a
 *    batch whose position is unknown.
 *  - the endpoint is re-read from disk rather than taken from the caller's
 *    snapshot, because the peer can poll between the snapshot and this gate, and a
 *    stale cursor would start a turn for mail that has already been read.
 */
export async function readPolledSeqFor(args: {
  readonly root: string;
  readonly paths: Awaited<ReturnType<typeof resolveBusPaths>>;
  readonly endpointId: string;
  readonly batchCursorKnown: boolean;
}): Promise<number | null> {
  if (!args.batchCursorKnown) return null;
  try {
    const highwater = await readMailboxHighwater(args.paths, args.endpointId);
    if (!highwater.known) return null;
    const listed = await listEndpoints(args.root);
    const fresh = listed.endpoints.find(
      (candidate) => candidate.endpointId === args.endpointId,
    );
    if (!fresh) return null;
    return fresh.lastPolledMailboxSeq;
  } catch {
    // A missing or unreadable mailbox is an explicit UNKNOWN, never "nothing
    // pending".
    return null;
  }
}

export interface WakeAfterSendInput {
  readonly root: string;
  /** The thread the triggering message was sent on. */
  readonly threadId: string;
  /** The endpoint that received the mail. */
  readonly recipient: BusEndpoint;
  /** Text the woken turn receives. */
  readonly wakeText: string;
  readonly deadlineMs?: number;
}

/**
 * Attempt one wake for a just-committed send, and record what happened.
 *
 * NEVER THROWS. The mail is already committed; a wake failure must not turn a
 * successful send into an error for the caller.
 */
export async function wakeAfterSend(input: WakeAfterSendInput): Promise<WakeOutcome> {
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  let outcome: WakeOutcome = { kind: "no-attempt" };

  try {
    const paths = await resolveBusPaths(input.root);
    const deps: WakeDeps = {
      deadline,
      acceptedVersions: ACCEPTED_APP_SERVER_VERSIONS,
      readVersion: () => readDaemonVersion(Math.max(0, deadline - Date.now())),
      readPolledSeq: () =>
        readPolledSeqFor({
          root: input.root,
          paths,
          endpointId: input.recipient.endpointId,
          batchCursorKnown,
        }),
      connect: async () => {
        const client = await connectCodexAppServer({
          socketPath: codexControlSocketPath(),
          clientVersion: clientVersion(),
          deadlineMs: Math.max(1, deadline - Date.now()),
        });
        const connection: WakeConnection = {
          loadedThreadIds: () => loadedIds(client),
          findThread: (threadId) => findThreadPaged(client, threadId, deadline),
          startTurn: async (threadId, text) => {
            // buildTurnStartParams is the ONLY constructor of these params: a
            // whitelist by omission, so no caller-supplied override can reach the
            // peer's sandbox, approvals or instructions.
            await client.request("turn/start", buildTurnStartParams(threadId, text));
          },
          close: () => {
            client.close();
          },
        };
        return connection;
      },
    };

    // The cursor is INCLUSIVE. The recipient's mailbox high-water is used because
    // the send result does not expose the delivered sequence; if an unrelated
    // message landed in between, the cursor is slightly HIGH, which only delays
    // `poll_observed` and can never manufacture evidence that a poll happened.
    //
    // AN UNKNOWN HIGH-WATER IS NOT ZERO. Substituting 0 would make every
    // nonnegative polled sequence satisfy `polled >= cursor`, so an endpoint whose
    // mailbox could not be read would record `skipped:already-polled-through-batch`
    // for a cursor that was never established. That is a fabricated conclusion, and
    // it is the exact defect this tier exists to avoid. Unknown propagates as
    // unknown and the pending gate reports `pending-unknown`.
    const highwater = await readMailboxHighwater(paths, input.recipient.endpointId).catch(
      () => ({ known: false }) as const,
    );
    const batchCursorKnown = highwater.known;
    const batchCursor = highwater.known ? highwater.highwater : 0;

    outcome = await attemptWake(
      {
        endpoint: input.recipient,
        batchCursor,
        // For a Codex endpoint the client task id IS the app-server thread id
        // (the session's CODEX_THREAD_ID), which is what makes this reachable at
        // all without storing a second identifier.
        codexThreadId: input.recipient.client === "codex" ? input.recipient.clientTaskId : null,
        wakeText: input.wakeText,
      },
      deps,
    );

    await recordOutcome(input, outcome, batchCursor);
  } catch {
    // Structural isolation: the mail is committed and the caller's send stands,
    // whatever happened here.
    return outcome;
  }
  return outcome;
}

/**
 * Our version, echoed by the server into its userAgent so a wake is ATTRIBUTABLE.
 *
 * Read from the package rather than written here. A literal is a fabricated
 * identity: it drifts from the shipped version the moment either changes, and the
 * one thing this field exists for is telling a reader which storybloq made the
 * call. `currentCliVersion` is the same source `storybloq --version` and the team
 * capability fence use, so all three agree by construction.
 */
function clientVersion(): string {
  return currentCliVersion() ?? "unknown";
}

/**
 * Persist the outcome.
 *
 * ENTRIES go on the thread for the three reserved actions, and only when we
 * actually engaged the peer. TELEMETRY goes on the endpoint for every outcome
 * including skips, because a skip is a LOCAL decision that never touched the peer
 * and does not belong in a shared, hash-chained, peer-visible thread.
 */
async function recordOutcome(
  input: WakeAfterSendInput,
  outcome: WakeOutcome,
  batchCursor: number,
): Promise<void> {
  // `no-attempt` writes nothing at all: there was no decision to record.
  if (outcome.kind === "no-attempt") return;

  const telemetry = wakeTelemetry(outcome);
  if (telemetry !== null) {
    await updateEndpoint(input.root, input.recipient.endpointId, (current) => ({
      ...current,
      lastWakeAt: new Date().toISOString(),
      lastWakeResult: telemetry,
    })).catch(() => undefined);
  }

  if (outcome.kind === "skipped") return;

  await appendWakeEntry(input.root, input.threadId, {
    wakeId: outcome.wakeId,
    endpointId: input.recipient.endpointId,
    // ALWAYS 1 in this cut. The schema's 1..3 range is preserved untouched for a
    // future cut that adds retries.
    attempt: 1,
    batchCursor,
    action: outcome.kind === "requested" ? "requested" : "failed",
    ...(outcome.kind === "failed" ? { reason: outcome.reason } : {}),
  }).catch(() => undefined);
}

/**
 * Internals exposed for tests only.
 *
 * `findThreadPaged` in particular needs direct coverage: its job is to distinguish
 * PROVEN absence from an unreadable response, and that distinction is invisible
 * from the outside once it has collapsed into a skip reason.
 */
export const __wakeRunnerTesting = {
  clientVersion, findThreadPaged, loadedIds, runBounded, readPolledSeqFor };
