import { formatStatus, formatFederatedStatus, type StatusArrangements } from "../../core/output-formatter.js";
import { scanSessionSummaries } from "../../core/session-scan.js";
import { resolveAllNodes } from "../../federation/resolver.js";
import { scanAllSummaries } from "../../federation/scanner.js";
import { buildFederationState } from "../../federation/state.js";
import { writeFederationCache } from "../../federation/cache.js";
import { CrossNodeBlockingResolver } from "../../federation/cross-node-resolver.js";
import { join } from "node:path";
import type { CommandContext, CommandResult } from "../types.js";
import type { LimitStopSummary } from "../../core/limit-ledger.js";
import { busSummary } from "../../bus/store.js";
import { BusError } from "../../bus/errors.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { TICKET_ID_REGEX, TICKET_CANONICAL_ID_REGEX, ISSUE_ID_REGEX, ISSUE_CANONICAL_ID_REGEX } from "../../models/types.js";
import { sanitizeDisplayText } from "../../core/display-text.js";
import type { ProjectState } from "../../core/project-state.js";
import { ownerTaskForCurrentClient } from "../../autonomous/client-profile.js";
import { computeArrangementPresence, applyPresenceEnrichment, ownerIdentityOf, STATUS_ENRICHMENT_LOCK_BUDGET_MS } from "../../core/presence-enrichment.js";
import { arrangementGateRiskWarnings } from "../../core/arrangement-bounds.js";
import { CROSS_NODE_REF_CAPTURE_REGEX } from "../../models/ticket.js";
import { resolveNodeRoot } from "../../mcp/node-resolution.js";
import { loadProject } from "../../core/project-loader.js";

/**
 * T-473: builds the active-only, status-display projection of arrangements,
 * plus a re-validation of each bound ref against the fresh `ProjectState`
 * already loaded for this call. This is the read-time half of "revalidate
 * and report ambiguity" (the create/update-time half lives in
 * cli/commands/arrangement.ts); a bound that was valid when the arrangement
 * was created but has since gone missing or ambiguous is reported as an
 * advisory warning here, never dropped from the arrangement and never a
 * failure of this call (binding item 2).
 *
 * Every string that reaches `arrangementWarnings` is a prose-position field
 * that can embed attacker-controllable content (a filename under
 * `.story/arrangements/`, a user-typed bound ref) -- sanitized here at
 * composition via `sanitizeDisplayText`, the same treatment
 * `transcriptionNotes` gets in `session-guard.ts`, so every consumer (CLI
 * JSON, CLI Markdown, and the guard verdict via `loadArrangementsSafe`'s own
 * warnings) inherits clean strings from one source.
 */
/**
 * ISS-1077 ([R3-FIX 6]): resolves a node-qualified bound's existence, one
 * cached load per node name for the whole `buildStatusArrangements` call --
 * multiple bounds naming the same node share one `loadProject`, not one per
 * bound. Never throws: `buildStatusArrangements` is documented never-throwing,
 * so a bad node config or an unreadable node project becomes an advisory
 * warning string here, exactly like a missing/ambiguous local bound.
 */
async function resolveNodeQualifiedBound(
  nodeName: string,
  itemRef: string,
  pinnedRoot: string,
  nodeStateCache: Map<string, Promise<ProjectState | { error: string }>>,
): Promise<"found" | "missing" | "ambiguous" | "unusable" | { error: string }> {
  let cached = nodeStateCache.get(nodeName);
  if (!cached) {
    cached = (async () => {
      const resolved = resolveNodeRoot(pinnedRoot, nodeName);
      if (!resolved.ok) return { error: resolved.error };
      try {
        const { state } = await loadProject(resolved.root);
        return state;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    })();
    nodeStateCache.set(nodeName, cached);
  }
  const outcome = await cached;
  if ("error" in outcome) return outcome;
  const isTicketRef = TICKET_ID_REGEX.test(itemRef) || TICKET_CANONICAL_ID_REGEX.test(itemRef);
  const result = isTicketRef ? outcome.resolveTicketRef(itemRef) : outcome.resolveIssueRef(itemRef);
  // ISS-1077 fixed post-gate-1 (codex round 1): ambiguous is reported
  // distinctly, matching the local-bound path (lines below) -- treating it
  // as "found" would hide exactly the kind of unresolvable reference A4's
  // widened schema can now admit (e.g. a hand-edited display-form bound that
  // matches more than one item on the node), silently reporting a healthy
  // status for a bound that cannot actually be unambiguously revalidated.
  if (result.kind === "missing") return "missing";
  if (result.kind === "ambiguous") return "ambiguous";
  // codex round-2 finding: a UNIQUELY resolvable bound can still be
  // enforcement-dead. `arrangementCoversNodeItem` (the function actually
  // consulted for earmark authorization) does an EXACT string match of the
  // stored bound against the target's resolved `.id` -- it has no resolver,
  // no displayId lookup, by design (A4's docblock: that job belongs to an
  // earlier/later step, not this narrow membership check). So a bound that
  // resolves here only via `displayId`/`previousDisplayId` (team-mode:
  // `.id` is canonical, the bound stores display form; A4-2's traced
  // residual) is coverage-dead even though it uniquely names a real item --
  // reporting it as plain "found" would be a false-healthy status for a
  // bound that cannot actually authorize anything. `matchedBy !== "id"` is
  // exactly the resolver's own signal for "this ref string does not equal
  // the item's actual `.id`", the same condition `arrangementCoversNodeItem`
  // would fail on.
  if (result.matchedBy !== "id") return "unusable";
  return "found";
}

async function buildStatusArrangements(root: string, state: ProjectState): Promise<StatusArrangements> {
  const { arrangements, warnings } = loadArrangementsSafe(root);
  const active = arrangements.filter((a) => a.lifecycle !== "closed");
  const boundsWarnings: string[] = [];
  const nodeStateCache = new Map<string, Promise<ProjectState | { error: string }>>();
  for (const a of active) {
    for (const ref of a.bounds) {
      const crossNode = CROSS_NODE_REF_CAPTURE_REGEX.exec(ref);
      if (crossNode) {
        const [, nodeName, itemRef] = crossNode as unknown as [string, string, string];
        const outcome = await resolveNodeQualifiedBound(nodeName, itemRef, root, nodeStateCache);
        if (outcome === "missing") {
          boundsWarnings.push(`arrangement ${sanitizeDisplayText(a.id)} bound ${sanitizeDisplayText(ref)} not found on node "${sanitizeDisplayText(nodeName)}"`);
        } else if (outcome === "ambiguous") {
          boundsWarnings.push(`arrangement ${sanitizeDisplayText(a.id)} bound ${sanitizeDisplayText(ref)} is ambiguous on node "${sanitizeDisplayText(nodeName)}"`);
        } else if (outcome === "unusable") {
          boundsWarnings.push(`arrangement ${sanitizeDisplayText(a.id)} bound ${sanitizeDisplayText(ref)} resolves uniquely on node "${sanitizeDisplayText(nodeName)}" but not by its exact id -- it cannot authorize a write there; store the item's own id`);
        } else if (typeof outcome === "object") {
          boundsWarnings.push(`arrangement ${sanitizeDisplayText(a.id)} bound ${sanitizeDisplayText(ref)}: node "${sanitizeDisplayText(nodeName)}" could not be checked (${sanitizeDisplayText(outcome.error)})`);
        }
        continue;
      }
      const isTicketRef = TICKET_ID_REGEX.test(ref) || TICKET_CANONICAL_ID_REGEX.test(ref);
      const isIssueRef = ISSUE_ID_REGEX.test(ref) || ISSUE_CANONICAL_ID_REGEX.test(ref);
      const result = isTicketRef
        ? state.resolveTicketRef(ref)
        : isIssueRef
          ? state.resolveIssueRef(ref)
          : { kind: "missing" as const };
      if (result.kind === "missing") {
        boundsWarnings.push(`arrangement ${sanitizeDisplayText(a.id)} bound ${sanitizeDisplayText(ref)} not found`);
      } else if (result.kind === "ambiguous") {
        boundsWarnings.push(`arrangement ${sanitizeDisplayText(a.id)} bound ${sanitizeDisplayText(ref)} is ambiguous`);
      }
    }
    // ISS-1050 interim: surface a plan-ack-without-pre-commit-ack risk here
    // regardless of how the arrangement got its gates (hand-edit, future
    // create/update once gates become configurable, merge-driver output).
    for (const warning of arrangementGateRiskWarnings(a.gates)) {
      boundsWarnings.push(`arrangement ${sanitizeDisplayText(a.id)}: ${warning}`);
    }
  }
  return {
    items: active.map((a) => ({
      id: a.id,
      lifecycle: a.lifecycle,
      bounds: a.bounds,
      parties: a.parties.map((p) => ({ role: p.role, client: p.client })),
    })),
    // `warnings` (from `loadArrangementsSafe`) are already sanitized at their
    // own composition point inside arrangement-loader.ts; `boundsWarnings`
    // above are sanitized inline where they are built. Neither needs a
    // second pass here.
    warnings: [...warnings, ...boundsWarnings],
  };
}

/**
 * T-477 section 2.1: `storybloq status`'s heavy-path enrichment. A side
 * effect of running for THIS caller's own identity -- computes
 * `arrangementPresence`/`ownerIdentity` and performs a locked
 * read-modify-write onto the caller's own presence record, using the SAME
 * lock file and primitives the slim hook already uses. Best-effort at the
 * hook's own short budget: on contention it silently skips (an enrichment
 * miss is not a status failure), and when identity cannot be resolved at
 * all it silently omits the enrichment for this call (section 2.2) --
 * neither case ever affects `handleStatus`'s returned output.
 */
function enrichPresenceForCaller(root: string, explicitClientTaskId: string | null | undefined): void {
  const ownerTask = ownerTaskForCurrentClient(explicitClientTaskId);
  if (!ownerTask) return; // identity unresolved -- visibility degradation only, per section 2.2
  try {
    const { entries, truncated } = computeArrangementPresence(root, ownerTask);
    applyPresenceEnrichment(root, ownerTask.id, STATUS_ENRICHMENT_LOCK_BUDGET_MS, "status-enrichment", (base) => ({
      ...base,
      arrangementPresence: entries,
      arrangementPresenceTruncated: truncated,
      ownerIdentity: ownerIdentityOf(ownerTask),
    }));
  } catch {
    // Best-effort, matching every other status side-read in this function
    // (limitStops, bus): a broken enrichment path must never fail status.
  }
}

export async function handleStatus(ctx: CommandContext, clientTaskId?: string | null): Promise<CommandResult> {
  enrichPresenceForCaller(ctx.root, clientTaskId);

  const {
    activeSessions,
    resumableSessions,
    expiredLeaseSessions = [],
    diagnostics: sessionDiagnostics = [],
  } = scanSessionSummaries(ctx.root);
  const config = ctx.state.config;

  // T-424: pending limit auto-resumes for this project (best-effort).
  let limitStops: LimitStopSummary[] = [];
  try {
    const { listLimitStopsForProject } = await import("../../core/limit-ledger.js");
    limitStops = listLimitStopsForProject(ctx.root);
  } catch {
    // Status must render even when the global ledger is unreadable.
  }
  // D7: the Bus capability block is always present in JSON (even when disabled);
  // the Markdown formatter stays quiet until the Bus is enabled.
  let bus;
  try {
    bus = await busSummary(ctx.root, ctx.state);
  } catch (err) {
    bus = {
      enabled: true as const,
      error: {
        code: err instanceof BusError ? err.code : "io_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // T-473: never-throwing read (ISS-1077: now async, since a node-qualified
  // bound needs a per-node project load -- see buildStatusArrangements's own
  // docblock). Computed once and shared by both the orchestrator and
  // single-project branches below.
  const arrangements = await buildStatusArrangements(ctx.root, ctx.state);

  const isOrchestrator = config.type === "orchestrator";
  const nodes = config.nodes as Record<string, Record<string, unknown>> | undefined;
  const hasNodes = nodes && typeof nodes === "object" && Object.keys(nodes).length > 0;

  if (isOrchestrator && hasNodes) {
    const nodeEntries = Object.fromEntries(
      Object.entries(nodes)
        .filter(([, v]) => v != null && typeof v === "object")
        .map(([k, v]) => [k, { path: typeof v.path === "string" ? v.path : "" }]),
    );
    const resolvedNodes = resolveAllNodes(nodeEntries, ctx.root);
    const scanResults = await scanAllSummaries(resolvedNodes);
    const fedState = buildFederationState(config, resolvedNodes, scanResults);

    const resolver = await CrossNodeBlockingResolver.build(ctx.state.tickets, resolvedNodes);

    try {
      writeFederationCache(join(ctx.root, ".story"), fedState, resolver.resolvedStatuses);
    } catch {
      // best-effort cache write
    }

    return {
      output: formatFederatedStatus(
        fedState,
        config,
        ctx.format,
        activeSessions,
        resumableSessions,
        bus,
        limitStops,
        sessionDiagnostics,
        expiredLeaseSessions,
        arrangements,
      ),
    };
  }

  return {
    output: formatStatus(
      ctx.state,
      ctx.format,
      activeSessions,
      resumableSessions,
      bus,
      limitStops,
      sessionDiagnostics,
      expiredLeaseSessions,
      arrangements,
    ),
  };
}
