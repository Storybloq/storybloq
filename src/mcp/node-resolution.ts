import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNodePath } from "../federation/resolver.js";
import { NodesMapSchema } from "../models/federation-config.js";
import { loadProject } from "../core/project-loader.js";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type NodeResolutionResult =
  | { ok: true; root: string }
  | { ok: false; error: string; errorCode: string };

export function readOrchestratorConfig(pinnedRoot: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(pinnedRoot, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolveNodeRoot(
  pinnedRoot: string,
  nodeName: string,
  config?: Record<string, unknown>,
): NodeResolutionResult {
  if (!config) {
    config = readOrchestratorConfig(pinnedRoot) ?? undefined;
    if (!config) {
      return { ok: false, error: "Cannot read orchestrator config", errorCode: "io_error" };
    }
  }

  if (config.type !== "orchestrator") {
    return {
      ok: false,
      error: "Node parameter is only supported on orchestrator projects.",
      errorCode: "not_orchestrator",
    };
  }

  const rawNodes = config.nodes;
  if (!rawNodes || typeof rawNodes !== "object" || Array.isArray(rawNodes)) {
    return { ok: false, error: `Node "${nodeName}" not found in orchestrator config.`, errorCode: "node_not_found" };
  }

  const nodeEntries = rawNodes as Record<string, unknown>;
  if (!(nodeName in nodeEntries)) {
    return { ok: false, error: `Node "${nodeName}" not found in orchestrator config.`, errorCode: "node_not_found" };
  }

  const parsed = NodesMapSchema.safeParse({ [nodeName]: nodeEntries[nodeName] });
  if (!parsed.success) {
    return {
      ok: false,
      error: `Node "${nodeName}" has invalid config: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      errorCode: "node_unresolvable",
    };
  }

  const nodeConfig = parsed.data[nodeName]!;
  const resolved = resolveNodePath(nodeConfig.path, pinnedRoot);

  if (!resolved.resolved) {
    return {
      ok: false,
      error: `Node "${nodeName}" path unresolvable: ${resolved.reason}`,
      errorCode: "node_unresolvable",
    };
  }

  return { ok: true, root: resolved.absolutePath };
}

export function checkNodeWritePermission(pinnedRoot: string, config?: Record<string, unknown>): boolean {
  if (!config) {
    config = readOrchestratorConfig(pinnedRoot) ?? undefined;
    if (!config) return false;
  }
  const federation = config.federation as Record<string, unknown> | undefined;
  return federation?.allowNodeWrites === true;
}

// --- ISS-1074: omitted-node collision detection ---

export interface NodeCollisionCandidate {
  readonly label: string;
  readonly root: string;
}

export type CollisionScanResult =
  | { status: "clear" }
  | { status: "ambiguous"; candidates: NodeCollisionCandidate[] }
  | { status: "indeterminate"; unresolvedNodes: string[]; reason: string };

/**
 * A small bounded-concurrency runner. Production default for
 * `detectNodeCollision`'s per-node fan-out (R3-FIX 5: unbounded `Promise.all`
 * over every configured node competes for file descriptors and I/O, and a
 * federation's node count has no enforced ceiling). Exported so a test can
 * wrap it to count in-flight calls and assert the ceiling holds -- ordinary
 * dependency injection (Amendment A2), not a test-only branch: production
 * code always calls through the same `runner` parameter, defaulted to this.
 */
export function createBoundedRunner(maxConcurrent: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(`createBoundedRunner: maxConcurrent must be a positive integer, got ${maxConcurrent}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const attempt = () => {
        // codex round-4 (informal re-check) finding: round 3's fix ordered
        // `queueMicrotask(next)` before `onSettled()` within ONE settle()
        // call, which closes the race for a SINGLE settlement at
        // maxConcurrent=1 -- but `active--` still happens immediately,
        // exposing a WINDOW (from that decrement until the dequeued `next`
        // actually runs and re-increments) where the slot counter reads
        // "free" even though `next` already has a claim on it. With
        // maxConcurrent >= 2 and TWO tasks settling in nearby (not
        // necessarily simultaneous) microtask turns, each settle() call's
        // own [dispatch-next, own-reaction] pair is internally ordered
        // correctly, but the SECOND settle() call's pair is appended to the
        // microtask queue entirely AFTER the FIRST settle() call's pair --
        // so the first settlement's OWN caller reaction can still run before
        // the SECOND settlement's queued dispatch, see a transiently-free
        // slot, and start new work, letting more than maxConcurrent run at
        // once. Fixed by never exposing that transient free state at all:
        // when there is a queued successor, the slot transfers to it
        // directly (`active` is left UNCHANGED -- no decrement paired with
        // a later increment, so no window where the count is momentarily
        // wrong); `active` is decremented only when the queue is empty and
        // the slot is genuinely free for a brand-new `run()` call to claim
        // via its own synchronous check-then-increment below. `attempt`
        // itself no longer touches `active` at all -- both call sites
        // (initial dispatch, and settle's handoff) manage it explicitly, so
        // there is exactly one place a slot is created (the initial
        // check-and-increment) and exactly one place it is destroyed (settle
        // finding no queued successor).
        const settle = (onSettled: () => void) => {
          const next = queue.shift();
          if (next) {
            // codex round-2's anti-recursion reasoning still applies here:
            // a direct call would risk stack growth for a run of
            // synchronously-throwing queued tasks. `active` is deliberately
            // NOT touched on this branch -- the slot this task held passes
            // straight to `next` without ever being counted as free.
            queueMicrotask(next);
          } else {
            active--;
          }
          onSettled();
        };
        // codex round-1 finding: `fn` is caller-supplied and typed as
        // returning a Promise, but a SYNCHRONOUS throw from it (before it
        // ever produces a promise) is a real possibility this runner must
        // not assume away. Without this try/catch, a sync throw from a
        // QUEUED task's `fn` -- invoked via `next()` from inside a DIFFERENT,
        // already-settled task's `.then()` handler -- would propagate into
        // that unrelated handler instead of this task's own promise: the
        // just-completed task's `resolve`/`reject` (whichever line follows
        // `next()`) would never run (hanging its caller forever), the throw
        // would become an unobserved rejection on the throwaway `.then()`
        // promise, and this task's own dequeue bookkeeping would never
        // happen either (leaking a concurrency slot). Routing every outcome
        // -- sync throw, async resolve, async reject -- through the same
        // `settle` ensures bookkeeping and this task's own resolve/reject
        // always run together, regardless of which case fired.
        let pending: Promise<T>;
        try {
          pending = fn();
        } catch (err) {
          settle(() => reject(err));
          return;
        }
        // pen byte-review finding: `fn` is typed as returning a Promise, but
        // that type is not enforced at runtime -- a caller (or a mock) whose
        // `fn` returns a non-promise value made `pending.then` a property
        // access on a value that might not have one, throwing OUTSIDE the
        // try/catch above and leaking this task's concurrency slot (settle
        // never runs). `Promise.resolve(pending)` adopts a plain value or a
        // thenable without ever throwing synchronously -- same defect family
        // as the round-1 sync-throw fix, just at the second point this
        // function touches caller-supplied output instead of the first.
        Promise.resolve(pending).then(
          (value) => settle(() => resolve(value)),
          (err) => settle(() => reject(err)),
        );
      };
      if (active < maxConcurrent) {
        active++;
        attempt();
      } else {
        queue.push(attempt);
      }
    });
  };
}

const DEFAULT_COLLISION_SCAN_CONCURRENCY = 6;

async function resolvesOnRoot(
  root: string,
  displayId: string,
  isTicketShaped: boolean,
): Promise<boolean | "indeterminate"> {
  try {
    const { state } = await loadProject(root);
    const result = isTicketShaped ? state.resolveTicketRef(displayId) : state.resolveIssueRef(displayId);
    // "ambiguous" (a duplicate display id already present on that one board,
    // a Team Mode transient) still counts as "this board has something here"
    // for collision purposes -- only "missing" means nothing resolves there.
    return result.kind !== "missing";
  } catch {
    return "indeterminate";
  }
}

/**
 * ISS-1074: when `node` is omitted on an orchestrator project, checks
 * whether `displayId` resolves on the pinned root AND/OR on one or more
 * configured child nodes. Never called for a non-orchestrator project (the
 * caller's own gate per binding item 5) -- but also safe to call regardless,
 * since a missing/non-orchestrator config short-circuits to "clear" before
 * touching anything node-shaped.
 *
 * A node that fails to resolve or load (bad path, unreadable config, corrupt
 * project) is NEVER silently skipped -- it makes the whole scan
 * `indeterminate`, which the caller must treat as a refusal: an incomplete
 * scan cannot rule out a collision the way a complete, clean scan can
 * (never-fail-open, D1).
 */
export async function detectNodeCollision(
  pinnedRoot: string,
  displayId: string,
  isTicketShaped: boolean,
  options?: { runner?: <T>(fn: () => Promise<T>) => Promise<T> },
): Promise<CollisionScanResult> {
  const config = readOrchestratorConfig(pinnedRoot);
  if (!config || config.type !== "orchestrator") {
    return { status: "clear" };
  }
  const rawNodes = config.nodes;
  const nodeNames =
    rawNodes && typeof rawNodes === "object" && !Array.isArray(rawNodes)
      ? Object.keys(rawNodes as Record<string, unknown>)
      : [];
  if (nodeNames.length === 0) {
    return { status: "clear" };
  }

  const candidates: NodeCollisionCandidate[] = [];
  const unresolvedNodes: string[] = [];
  const run = options?.runner ?? createBoundedRunner(DEFAULT_COLLISION_SCAN_CONCURRENCY);

  const pinnedMatch = await run(() => resolvesOnRoot(pinnedRoot, displayId, isTicketShaped));
  if (pinnedMatch === "indeterminate") {
    unresolvedNodes.push("(orchestrator)");
  } else if (pinnedMatch) {
    candidates.push({ label: "the orchestrator board", root: pinnedRoot });
  }

  await Promise.all(
    nodeNames.map((nodeName) =>
      run(async () => {
        const resolved = resolveNodeRoot(pinnedRoot, nodeName, config);
        if (!resolved.ok) {
          unresolvedNodes.push(nodeName);
          return;
        }
        const match = await resolvesOnRoot(resolved.root, displayId, isTicketShaped);
        if (match === "indeterminate") {
          unresolvedNodes.push(nodeName);
        } else if (match) {
          candidates.push({ label: nodeName, root: resolved.root });
        }
      }),
    ),
  );

  if (unresolvedNodes.length > 0) {
    return {
      status: "indeterminate",
      unresolvedNodes,
      reason: "one or more configured nodes could not be loaded",
    };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", candidates };
  }
  return { status: "clear" };
}

