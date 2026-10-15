import { displayIdOf } from "../../core/resolver.js";
import { recommend, type RecommendOptions } from "../../core/recommend.js";
import { buildDispatchPlan, buildFederationDispatchPlan, type DispatchPlan } from "../../core/dispatch-plan.js";
import { detectClaudeVersion, spawnBackgroundAgent } from "../../autonomous/agent-view.js";
import type { CommandContext, CommandResult } from "../types.js";
import { ExitCode } from "../../core/output-formatter.js";
import type { Config } from "../../models/config.js";
import { loadFederationState } from "../../federation/recommend-loader.js";
import { loadNodeRecommendations, type NodeRecommendationLoadWarning } from "../../federation/node-recommend.js";
import { crossNodeStatusRecord, observeProject } from "../../federation/cross-node-observation.js";

export interface DispatchOptions {
  readonly ids: readonly string[] | "all";
  readonly count: number;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

function getMaxAgents(config: Config): number {
  return config.recipeOverrides?.maxParallelAgents ?? 3;
}

function formatPlan(plan: DispatchPlan): string {
  const lines: string[] = [];
  const versionStatus = plan.claudeVersionOk
    ? `available (v${plan.claudeVersion})`
    : plan.claudeVersion
      ? `too old (v${plan.claudeVersion}, need >= 2.1.139)`
      : "not found";

  lines.push("# Dispatch Plan");
  lines.push("");
  lines.push(`**Mode:** ${plan.mode} | **Agents:** ${plan.entries.length} | **Agent View:** ${versionStatus}`);
  lines.push("");

  if (plan.entries.length === 0) {
    lines.push("No dispatchable items found.");
  } else {
    lines.push("| # | ID | Kind | Title |");
    lines.push("|---|------|------|-------|");
    plan.entries.forEach((entry, i) => {
      const title = entry.target.title || "(explicit)";
      lines.push(`| ${i + 1} | ${displayIdOf(entry.target)} | ${entry.target.kind} | ${title} |`);
    });
  }

  if (plan.skipped.length > 0) {
    lines.push("");
    lines.push(`**Skipped:** ${plan.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}`);
  }

  return lines.join("\n");
}

function formatPlanJson(plan: DispatchPlan): string {
  return JSON.stringify(plan, null, 2);
}

function titleLookup(ctx: CommandContext): (id: string) => string | undefined {
  return (id) => {
    if (id.startsWith("ISS-")) return ctx.state.issueByID(id)?.title;
    return ctx.state.ticketByID(id)?.title;
  };
}

function appendNodeRecommendationWarnings(
  plan: DispatchPlan,
  warnings: readonly NodeRecommendationLoadWarning[],
): DispatchPlan {
  if (warnings.length === 0) return plan;
  return {
    ...plan,
    skipped: [
      ...plan.skipped,
      ...warnings.map((warning) => ({
        id: `node:${warning.node}`,
        reason: `recommendation scan skipped: ${warning.reason}`,
      })),
    ],
  };
}

/**
 * T-486 U2-4: one live observation per command, over this ledger's tickets.
 * Node tickets' refs are looked up in the same map, as before; the
 * federation cache is not read.
 */
async function crossNodeRefStatuses(ctx: CommandContext): Promise<Record<string, string>> {
  return crossNodeStatusRecord(await observeProject(ctx.state, ctx.root));
}

export async function handleDispatchRecommend(ctx: CommandContext, count: number): Promise<CommandResult> {
  const config = ctx.state.config as Config;
  if (config.type === "orchestrator") {
    return handleFederationDispatchRecommend(ctx, count);
  }
  const options: RecommendOptions = { crossNodeRefStatuses: await crossNodeRefStatuses(ctx) };
  const { recommendations } = recommend(ctx.state, count, options);
  const claudeVersion = detectClaudeVersion();
  const plan = buildDispatchPlan(recommendations, "all", ctx.root, claudeVersion, getMaxAgents(config));

  const output = ctx.format === "json" ? formatPlanJson(plan) : formatPlan(plan);
  return { output };
}

async function handleFederationDispatchRecommend(ctx: CommandContext, count: number): Promise<CommandResult> {
  const config = ctx.state.config as Config;
  const fedState = await loadFederationState(ctx.root, config);
  if (!fedState) {
    return {
      output: "No federation state available. Run `storybloq status` first.",
      exitCode: ExitCode.USER_ERROR,
    };
  }
  const statuses = await crossNodeRefStatuses(ctx);
  const nodeRecs = await loadNodeRecommendations(fedState, count, statuses);
  const claudeVersion = detectClaudeVersion();
  const plan = appendNodeRecommendationWarnings(
    buildFederationDispatchPlan(nodeRecs.recommendationsByNode, claudeVersion, getMaxAgents(config)),
    nodeRecs.warnings,
  );
  const output = ctx.format === "json" ? formatPlanJson(plan) : formatPlan(plan);
  return { output };
}

export async function handleDispatch(ctx: CommandContext, options: DispatchOptions): Promise<CommandResult> {
  const config = ctx.state.config as Config;

  if (config.type === "orchestrator" && options.ids !== "all") {
    return {
      output: "Cannot dispatch explicit ticket IDs on an orchestrator project. Orchestrator tickets are coordination milestones.\nUse `storybloq dispatch --recommend` for federation dispatch, or dispatch directly in node projects.",
      exitCode: ExitCode.USER_ERROR,
    };
  }

  let plan: DispatchPlan;
  const claudeVersion = detectClaudeVersion();

  if (config.type === "orchestrator") {
    const fedState = await loadFederationState(ctx.root, config);
    if (!fedState) {
      return {
        output: "No federation state available. Run `storybloq status` first.",
        exitCode: ExitCode.USER_ERROR,
      };
    }
    const statuses = await crossNodeRefStatuses(ctx);
    const nodeRecs = await loadNodeRecommendations(fedState, options.count, statuses);
    plan = appendNodeRecommendationWarnings(
      buildFederationDispatchPlan(nodeRecs.recommendationsByNode, claudeVersion, getMaxAgents(config)),
      nodeRecs.warnings,
    );
  } else {
    const recOptions: RecommendOptions = { crossNodeRefStatuses: await crossNodeRefStatuses(ctx) };
    const { recommendations } = recommend(ctx.state, options.count, recOptions);
    plan = buildDispatchPlan(recommendations, options.ids, ctx.root, claudeVersion, getMaxAgents(config), titleLookup(ctx));
  }

  if (options.dryRun) {
    const output = ctx.format === "json" ? formatPlanJson(plan) : formatPlan(plan);
    return { output };
  }

  if (!plan.claudeVersionOk) {
    const reason = plan.claudeVersion
      ? `Claude Code v${plan.claudeVersion} is too old. Agent View requires >= 2.1.139.`
      : "Claude Code CLI not found in PATH.";
    return {
      output: `Error: ${reason}\nInstall or update: https://docs.anthropic.com/en/docs/claude-code`,
      exitCode: ExitCode.USER_ERROR,
    };
  }

  if (plan.entries.length === 0) {
    return { output: "No dispatchable items found. Run `storybloq recommend` to see available work." };
  }

  if (!options.yes) {
    const output = formatPlan(plan) + "\n\nRun with `--yes` to execute.";
    return { output };
  }

  const results: { id: string; success: boolean; error?: string }[] = [];
  for (const entry of plan.entries) {
    const name = `${entry.target.id}: ${entry.target.title}`.slice(0, 60);
    const result = spawnBackgroundAgent({
      cwd: entry.cwd,
      ids: [entry.target.id],
      name,
    });
    results.push({ id: entry.target.id, ...result });
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);

  const lines: string[] = [];
  lines.push(`Dispatched ${succeeded}/${results.length} agents.`);
  if (failed.length > 0) {
    lines.push("");
    lines.push("**Failed:**");
    for (const f of failed) {
      lines.push(`- ${f.id}: ${f.error}`);
    }
  }
  lines.push("");
  lines.push("Monitor with: `claude agents`");

  const exitCode = failed.length > 0 ? ExitCode.PARTIAL : ExitCode.OK;
  return { output: lines.join("\n"), exitCode };
}
