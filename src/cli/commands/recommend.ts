import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { recommend, type RecommendOptions } from "../../core/recommend.js";
import { formatRecommendations } from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";

export function handleRecommend(ctx: CommandContext, count: number): CommandResult {
  const options = buildRecommendOptions(ctx);
  const result = recommend(ctx.state, count, options);
  return { output: formatRecommendations(result, ctx.state, ctx.format) };
}

function buildRecommendOptions(ctx: CommandContext): RecommendOptions {
  const opts: { latestHandoverContent?: string; previousOpenIssueCount?: number } = {};

  // ISS-018: Load latest handover content
  try {
    const files = readdirSync(ctx.handoversDir).filter((f) => f.endsWith(".md")).sort();
    if (files.length > 0) {
      opts.latestHandoverContent = readFileSync(join(ctx.handoversDir, files[files.length - 1]), "utf-8");
    }
  } catch { /* no handovers */ }

  // ISS-019: Load previous open issue count from latest snapshot
  try {
    const snapshotsDir = join(ctx.root, ".story", "snapshots");
    const snapFiles = readdirSync(snapshotsDir).filter((f) => f.endsWith(".json")).sort();
    if (snapFiles.length > 0) {
      const raw = readFileSync(join(snapshotsDir, snapFiles[snapFiles.length - 1]), "utf-8");
      const snap = JSON.parse(raw) as { issues?: Array<{ status?: string }> };
      if (snap.issues) {
        opts.previousOpenIssueCount = snap.issues.filter((i) => i.status !== "resolved").length;
      }
    }
  } catch { /* no snapshots */ }

  return opts;
}
