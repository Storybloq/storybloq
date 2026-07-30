import { formatStatus, formatFederatedStatus } from "../../core/output-formatter.js";
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

export async function handleStatus(ctx: CommandContext): Promise<CommandResult> {
  const { activeSessions, resumableSessions, diagnostics: sessionDiagnostics = [] } =
    scanSessionSummaries(ctx.root);
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

    return { output: formatFederatedStatus(fedState, config, ctx.format, activeSessions, resumableSessions, bus, limitStops, sessionDiagnostics) };
  }

  return { output: formatStatus(ctx.state, ctx.format, activeSessions, resumableSessions, bus, limitStops, sessionDiagnostics) };
}
