/**
 * ISS-1154: shared classification-context loader. Both `handleRecommend`
 * (src/cli/commands/recommend.ts) and the targeted single-id
 * `withActionability` lookup (src/mcp/tools.ts) call this ONE loader, so a
 * ticket with resolved vs. unresolved cross-node dependencies gets the same
 * verdict whether classified via the main `recommend()` pass or via a
 * single-id lookup -- never two divergent code paths reading two different
 * caches.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { tryReadFile } from "../cli/util/file-io.js";
import { computeActionability, buildHandoverClassificationInputs, type Actionability } from "./recommend.js";
import { crossNodeStatusRecord, observeProject } from "../federation/cross-node-observation.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { CommandContext } from "../cli/types.js";

export interface RecentHandover {
  readonly filename: string;
  readonly content: string;
}

export interface ClassificationContext {
  /** Successfully-read handovers, last 10 intended, newest first. */
  readonly recentHandovers: readonly RecentHandover[];
  /** `0` = window fully read; positive = that many intended files failed to read; `null` = the directory itself could not be listed. */
  readonly unreadableHandoverCount: number | null;
}

const HANDOVER_WINDOW = 10;

export function loadClassificationContext(root: string, handoversDir: string): ClassificationContext {
  let recentHandovers: RecentHandover[] = [];
  let unreadableHandoverCount: number | null = 0;

  try {
    const files = readdirSync(handoversDir).filter((f) => f.endsWith(".md")).sort();
    const newestFirst = files.slice(-HANDOVER_WINDOW).reverse();
    let failures = 0;
    for (const filename of newestFirst) {
      const result = tryReadFile(join(handoversDir, filename));
      if (result.ok) {
        recentHandovers.push({ filename, content: result.content });
      } else {
        failures++;
      }
    }
    unreadableHandoverCount = failures;
  } catch {
    recentHandovers = [];
    unreadableHandoverCount = null;
  }

  return { recentHandovers, unreadableHandoverCount };
}

/**
 * ISS-1154 2h: the targeted single-id lookup behind `withActionability` on
 * `storybloq_issue_get`/`storybloq_ticket_get`. Shared by both handlers so
 * an id gets the SAME verdict here as it would via a `recommend()` call in
 * the same project state -- one loader, one classifier, no divergent cache
 * reads. This call's own `unreadableHandoverCount` is independent of any
 * earlier `recommend()` response: it is this handler's own fresh read, and
 * can succeed or fail on its own.
 */
export async function computeTargetedActionability(
  ctx: CommandContext,
  kind: "ticket" | "issue",
  item: Ticket | Issue,
): Promise<{ actionability: Actionability; unreadableHandoverCount: number | null }> {
  const classification = loadClassificationContext(ctx.root, ctx.handoversDir);
  // T-486 U2-4 (ruling 1): the live observation over this one item, as
  // recommend computes it; the federation cache is never read here.
  const observation = await observeProject({ tickets: kind === "ticket" ? [item as Ticket] : [], config: ctx.state.config }, ctx.root);
  const { latestDispositionById } = buildHandoverClassificationInputs(ctx.state, classification.recentHandovers);
  const actionability = computeActionability(kind, item, {
    state: ctx.state,
    crossNodeRefStatuses: crossNodeStatusRecord(observation),
    latestDispositionById,
  });
  return { actionability, unreadableHandoverCount: classification.unreadableHandoverCount };
}
