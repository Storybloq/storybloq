// T-430: the detached auto-attach child. Runs OFF the SessionStart hook's critical path with
// normal locks, single-flighted by a task-scoped hardened try-lock, and ALWAYS finalizes its
// outcome record + releases its lock (never leaves a `running` orphan). It never installs
// global client hooks (bootstrap did that) and never disturbs a live peer.

import { normalizeClientTaskId } from "../autonomous/client-profile.js";
import { loadProject } from "../core/project-loader.js";
import { classifyBusRuntime } from "./admin.js";
import { isBusAutoAttachEnabled } from "./config.js";
import { convergeProjectDelivery } from "./delivery.js";
import {
  endpointLiveness,
  joinEndpoint,
  listEndpoints,
} from "./endpoints.js";
import { BusError } from "./errors.js";
import { releaseHardenedLock, tryAcquireHardenedLock } from "./lock.js";
import { hashKeyLockPath, resolveBusPaths } from "./paths.js";
import { materializeSuccessorMailbox } from "./store.js";
import {
  autoAttachDecision,
  type AutoAttachCandidate,
} from "./auto-attach-decision.js";
import {
  autoAttachOutcomeKey,
  removeAutoAttachOutcome,
  writeAutoAttachOutcome,
  type AutoAttachKind,
  type AutoAttachReason,
} from "./auto-attach-outcome.js";
import type { BusEndpoint } from "./schemas.js";
import type { BusClient, BusSurface } from "./schemas.js";

export interface AttemptAutoAttachInput {
  readonly root: string;
  readonly client: BusClient;
  readonly clientTaskId: string;
  readonly surface: BusSurface;
  // Injectable clock (real by default). Real CLI/hook processes stamp `at`; tests inject.
  readonly now?: () => string;
}

// Public result, chiefly for tests/observability. "busy" = single-flight lost the lock;
// "removed" = a not-applicable gate (feature/flag off, or no runtime) removed any record.
export interface AttemptAutoAttachResult {
  readonly kind: AutoAttachKind | "busy" | "removed";
  readonly reason?: AutoAttachReason;
  readonly endpointId?: string;
}

// Internal terminal disposition returned by the guarded body; the wrapper turns it into an
// outcome record write (terminal) or a removal (not-applicable gate).
type RunResult =
  | { readonly terminal: AutoAttachKind; readonly endpointId?: string; readonly reason?: AutoAttachReason }
  | { readonly remove: true };

function chainFindingReason(findings: readonly string[]): AutoAttachReason | null {
  return findings.some((finding) => finding.includes("succession chain")) ? "succession_chain_corrupt" : null;
}

// Materialize inherited mail into a successor's physical mailbox, mirroring runBusSetup's
// classification: a succession-chain finding or an endpoint_inactive result or a throw is a
// DEGRADED outcome (mail left for the idempotent next poll); a clean materialize is success.
async function materializeAndClassify(
  root: string,
  endpoint: BusEndpoint,
  successKind: AutoAttachKind,
  endpointId: string,
): Promise<RunResult> {
  try {
    const result = await materializeSuccessorMailbox(root, endpoint);
    const chainReason = chainFindingReason(result.findings);
    if (chainReason) return { terminal: "degraded", endpointId, reason: chainReason };
    if (result.status === "endpoint_inactive") {
      return { terminal: "degraded", endpointId, reason: "endpoint_inactive" };
    }
    return { terminal: successKind, endpointId };
  } catch {
    return { terminal: "degraded", endpointId, reason: "materialization_failed" };
  }
}

// Converge project-local delivery (Stop policy + Claude-only on-tool). A Stop-policy failure
// is degraded (delivery_policy_failed); a best-effort on-tool failure is degraded
// (tool_hook_failed) but never downgrades a successful attach/replace below degraded on its
// own -- it is only surfaced when the primary step otherwise succeeded.
async function convergeAndClassify(
  root: string,
  client: BusClient,
  primary: RunResult,
): Promise<RunResult> {
  if ("remove" in primary) return primary;
  const converged = await convergeProjectDelivery(root, client);
  // A materialization shortfall is the primary, more specific failure: preserve its reason
  // even when delivery also degrades. Delivery still ran above for its side effects, so a
  // recoverable policy converges; only the surfaced reason is kept as the materialization one.
  if (primary.terminal === "degraded") return primary;
  if (!converged.policy.ok) {
    return { terminal: "degraded", endpointId: primary.endpointId, reason: "delivery_policy_failed" };
  }
  if (converged.toolHook.applicable && !converged.toolHook.ok) {
    return { terminal: "degraded", endpointId: primary.endpointId, reason: "tool_hook_failed" };
  }
  return primary;
}

async function runAutoAttach(input: AttemptAutoAttachInput): Promise<RunResult> {
  // clientTaskId is pre-normalized by attemptAutoAttach so the lock key, outcome key, own
  // lookup, and decision self-identity all agree.
  const { root, client, clientTaskId, surface } = input;

  // Gate: feature + opt-in flag. A flag flipped off between spawn and run means "do nothing" --
  // remove any record rather than write a misleading terminal kind.
  const { state } = await loadProject(root);
  if (!isBusAutoAttachEnabled(state.config)) return { remove: true };

  // Gate: runtime must be a healthy v2. "none" = not bootstrapped; anything else = incompatible.
  let runtime: Awaited<ReturnType<typeof classifyBusRuntime>>;
  try {
    runtime = await classifyBusRuntime(root);
  } catch {
    return { terminal: "failed", reason: "runtime_incompatible" };
  }
  if (runtime !== "v2") {
    return { terminal: "failed", reason: runtime === "none" ? "runtime_absent" : "runtime_incompatible" };
  }

  // Never auto-mutate a corrupt registry.
  const { endpoints, findings } = await listEndpoints(root);
  if (findings.length > 0) return { terminal: "failed", reason: "registry_corrupt" };

  const active = endpoints.filter((endpoint) => !endpoint.retiredAt);

  // Recovery branch: this task already owns an active endpoint. Do not re-attach; re-run
  // idempotent materialization (a prior child may have joined then died before materializing)
  // and re-converge delivery, so a partially-converged session heals.
  const own = active.find((endpoint) => endpoint.client === client && endpoint.clientTaskId === clientTaskId);
  if (own) {
    let primary: RunResult = { terminal: "converged", endpointId: own.endpointId };
    if (own.predecessorEndpointId) {
      primary = await materializeAndClassify(root, own, "converged", own.endpointId);
    }
    return convergeAndClassify(root, client, primary);
  }

  // Decide against the current active set with resolved liveness.
  const candidates: AutoAttachCandidate[] = await Promise.all(
    active.map(async (endpoint) => ({
      endpointId: endpoint.endpointId,
      client: endpoint.client,
      clientTaskId: endpoint.clientTaskId,
      joinedAt: endpoint.joinedAt,
      liveness: await endpointLiveness(endpoint),
    })),
  );
  const decision = autoAttachDecision(candidates, { client, clientTaskId });

  if (decision.action === "skip") {
    return { terminal: "skipped_full", reason: "capacity_full" };
  }

  try {
    const joined = decision.action === "replace"
      ? await joinEndpoint(root, { client, clientTaskId, surface, replace: decision.replaceId })
      : await joinEndpoint(root, { client, clientTaskId, surface });

    if (decision.action === "replace") {
      const primary = await materializeAndClassify(root, joined.endpoint, "replaced", joined.endpoint.endpointId);
      return convergeAndClassify(root, client, primary);
    }
    return convergeAndClassify(root, client, { terminal: "attached", endpointId: joined.endpoint.endpointId });
  } catch (err) {
    // A revived-dead replace target or a peer that filled the last slot between decision and
    // join surfaces as a conflict: yield, never a 3rd endpoint, never a stolen live peer.
    if (err instanceof BusError && err.code === "conflict") {
      return decision.action === "replace"
        ? { terminal: "failed", reason: "race_lost" }
        : { terminal: "skipped_full", reason: "capacity_full" };
    }
    return { terminal: "failed", reason: "internal_failure" };
  }
}

export async function attemptAutoAttach(input: AttemptAutoAttachInput): Promise<AttemptAutoAttachResult> {
  // Safe clock: an injected now() must never escape and crash the detached child (it must always
  // exit 0). A throwing clock falls back to the real wall clock.
  const rawNow = input.now ?? (() => new Date().toISOString());
  const now = (): string => {
    try {
      return rawNow();
    } catch {
      return new Date().toISOString();
    }
  };
  const { root, client } = input;
  // Normalize the task id ONCE so the lock key, outcome key, own lookup, and decision
  // self-identity all key off the identical string (two ids differing only by whitespace must
  // never diverge into two locks). A malformed id is REJECTED outright -- the hidden child
  // subcommand is directly callable, so a bogus id must not be able to acquire a lock or litter
  // outcome records before joinEndpoint would reject it downstream.
  const clientTaskId = normalizeClientTaskId(input.clientTaskId);
  if (!clientTaskId) return { kind: "removed" };
  const normalizedInput: AttemptAutoAttachInput = { ...input, clientTaskId };

  // No runtime at all -> no lock dir, nowhere to record; silently exit (user re-bootstraps).
  let lockPath: string;
  try {
    const paths = await resolveBusPaths(root, false);
    lockPath = hashKeyLockPath(paths, "auto-attach", autoAttachOutcomeKey(client, clientTaskId));
  } catch {
    return { kind: "removed" };
  }

  let handle;
  try {
    // create:false so acquiring the lock never re-materializes `.story/bus/locks` after the
    // runtime was deleted between spawn and run: an absent parent fails closed (-> removed),
    // never resurrects a partial runtime.
    handle = await tryAcquireHardenedLock(lockPath, { create: false });
  } catch {
    // Lock corruption or an absent (deleted) runtime: best-effort child, do not fight it.
    return { kind: "removed" };
  }
  if (!handle) return { kind: "busy" };

  let result: RunResult = { terminal: "failed", reason: "internal_failure" };
  try {
    await writeAutoAttachOutcome(root, { client, clientTaskId, kind: "running", at: now() }).catch(() => undefined);
    result = await runAutoAttach(normalizedInput);
  } catch {
    result = { terminal: "failed", reason: "internal_failure" };
  } finally {
    try {
      if ("remove" in result) {
        await removeAutoAttachOutcome(root, client, clientTaskId).catch(() => undefined);
      } else {
        await writeAutoAttachOutcome(root, {
          client,
          clientTaskId,
          kind: result.terminal,
          endpointId: result.endpointId,
          reason: result.reason,
          at: now(),
        }).catch(() => undefined);
      }
    } finally {
      await releaseHardenedLock(handle).catch(() => undefined);
    }
  }

  if ("remove" in result) return { kind: "removed" };
  return { kind: result.terminal, reason: result.reason, endpointId: result.endpointId };
}
