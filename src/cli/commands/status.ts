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
function buildStatusArrangements(root: string, state: ProjectState): StatusArrangements {
  const { arrangements, warnings } = loadArrangementsSafe(root);
  const active = arrangements.filter((a) => a.lifecycle !== "closed");
  const boundsWarnings: string[] = [];
  for (const a of active) {
    for (const ref of a.bounds) {
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

export async function handleStatus(ctx: CommandContext): Promise<CommandResult> {
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

  // T-473: synchronous, never-throwing read -- see buildStatusArrangements's
  // own docblock. Computed once and shared by both the orchestrator and
  // single-project branches below.
  const arrangements = buildStatusArrangements(ctx.root, ctx.state);

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
