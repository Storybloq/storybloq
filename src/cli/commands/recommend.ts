import { readdirSync } from "node:fs";
import { tryReadFile } from "../util/file-io.js";
import { join } from "node:path";
import { recommend, type RecommendOptions } from "../../core/recommend.js";
import { formatRecommendations } from "../../core/output-formatter.js";
import { loadFederationState } from "../../federation/recommend-loader.js";
import { loadClassificationContext } from "../../core/classification-context.js";
import { crossNodeStatusRecord, observeProject } from "../../federation/cross-node-observation.js";
import type { CommandContext, CommandResult } from "../types.js";

export async function handleRecommend(
  ctx: CommandContext,
  count: number,
  withActionability = false,
): Promise<CommandResult> {
  const baseOptions = buildRecommendOptions(ctx);
  const fedState = await loadFederationState(ctx.root, ctx.state.config);
  const classification = loadClassificationContext(ctx.root, ctx.handoversDir);
  // T-486 U2-4: one live observation; the federation cache is not read here.
  const observation = await observeProject(ctx.state, ctx.root);

  let currentUser: string | undefined;
  try {
    const { gitUserEmail } = await import("../../autonomous/git-inspector.js");
    currentUser = (await gitUserEmail(ctx.root)) ?? undefined;
  } catch { /* git not available */ }

  const options: RecommendOptions = {
    ...baseOptions,
    recentHandovers: classification.recentHandovers,
    unreadableHandoverCount: classification.unreadableHandoverCount,
    ...(fedState ? { federationState: fedState } : {}),
    crossNodeRefStatuses: crossNodeStatusRecord(observation),
    crossNodeObservation: observation,
    ...(currentUser ? { currentUser } : {}),
  };
  const result = recommend(ctx.state, count, options);
  return { output: formatRecommendations(result, ctx.state, ctx.format, withActionability) };
}

function buildRecommendOptions(ctx: CommandContext): RecommendOptions {
  const opts: { previousOpenIssueCount?: number } = {};

  // ISS-019: Load previous open issue count from latest snapshot
  try {
    const snapshotsDir = join(ctx.root, ".story", "snapshots");
    const snapFiles = readdirSync(snapshotsDir).filter((f) => f.endsWith(".json")).sort();
    if (snapFiles.length > 0) {
      const snapResult = tryReadFile(join(snapshotsDir, snapFiles[snapFiles.length - 1]));
      if (!snapResult.ok) return opts;
      const raw = snapResult.content;
      const snap = JSON.parse(raw) as { issues?: Array<{ status?: string }> };
      if (snap.issues) {
        opts.previousOpenIssueCount = snap.issues.filter((i) => i.status !== "resolved").length;
      }
    }
  } catch { /* no snapshots */ }

  return opts;
}
