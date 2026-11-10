/**
 * ISS-1432: `storybloq land <sha>`, the CLI side. The gates live in
 * core/land.ts; this file wires the receipt writers and renders the result.
 */
import { formatLandText, land, landExitCode, type LandOptions, type LandResult, type ReceiptWriter } from "../../core/land.js";
import type { BoardWriteReport } from "../../core/board-git-state.js";
import { successEnvelope } from "../../core/output-formatter.js";
import type { OutputFormat } from "../../models/types.js";
import { appendIssueLanding } from "./issue.js";
import { appendTicketLanding } from "./ticket.js";

/** The CLI JSON envelope's data: the core result plus the board git report. */
export interface LandCliResult extends LandResult {
  git?: BoardWriteReport["git"];
  gitCommit?: BoardWriteReport["gitCommit"];
  gitUnavailable?: BoardWriteReport["gitUnavailable"];
}

/** The default receipt writer: a typed append on the ticket or issue. */
export const writeLandingReceipt: ReceiptWriter = async (boardRoot, target, entry) => {
  const record = { ...entry, steps: entry.steps.map((s) => ({ ...s })) } as Record<string, unknown>;
  const ref = { id: target.id, displayId: target.displayId, path: target.path };
  if (target.kind === "ticket") await appendTicketLanding(boardRoot, ref, record);
  else await appendIssueLanding(boardRoot, ref, record);
};

export interface HandleLandResult {
  readonly output: string;
  readonly exitCode: number;
  readonly result: LandResult;
}

export function renderLand(result: LandResult, format: OutputFormat): string {
  if (format === "json") return JSON.stringify(successEnvelope(result), null, 2);
  return formatLandText(result);
}

export async function handleLand(opts: LandOptions, format: OutputFormat): Promise<HandleLandResult> {
  const result = await land({ writeReceipt: writeLandingReceipt, ...opts });
  return { output: renderLand(result, format), exitCode: landExitCode(result), result };
}
