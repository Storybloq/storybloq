/**
 * T-507 commit B: `storybloq roster start|heartbeat|end|list [--all]` and the
 * read-only `storybloq_roster_get`.
 *
 * The write commands are shaped for a caller that runs them through a
 * function-hooks `$.process.run` (the roster Mod was removed by owner ruling
 * on 2026-09-15; the core and this CLI stay), so their contract is
 * machine-first: one JSON envelope on stdout whatever happens, `no_project`
 * when the cwd is not inside a ledger (such a caller caches that per cwd and stops
 * calling), `invalid_input` for a bad body, and `core/roster.ts`'s own
 * refusal reasons passed through verbatim as `refused_transition`,
 * `skipped_contention`, `write_failed`. A write never loads project state:
 * it needs the root and nothing else, and it runs on every tool call.
 *
 * Identity defaults come from the environment the way every other CLI
 * surface resolves them (`ownerTaskForCurrentClient`): `client` from
 * STORYBLOQ_CLIENT, `clientTaskId` from CLAUDE_CODE_SESSION_ID or
 * CODEX_THREAD_ID. A body field always wins over the environment.
 */

import { z } from "zod";

import { ownerTaskForCurrentClient } from "../../autonomous/client-profile.js";
import { escapeMarkdownInline, errorEnvelope, successEnvelope, ExitCode } from "../../core/output-formatter.js";
import {
  MAX_AGENT_ID_BYTES,
  MAX_CLIENT_TASK_ID_BYTES,
  MAX_DESCRIPTION_BYTES,
  MAX_SESSION_ID_BYTES,
  ROSTER_TERMINAL_STATES,
  upsertSeat,
  type RosterSeatEvent,
  type RosterTerminalState,
  type UpsertResult,
} from "../../core/roster.js";
import { readRosterWithBus, type BusRosterView } from "../../core/roster-view.js";
import { CLIENT_TASK_ID_PATTERN, type ErrorCode } from "../../models/types.js";
import type { CommandContext, CommandResult } from "../types.js";

export type RosterWriteKind = "start" | "heartbeat" | "end";

/** A UTF-8 BYTE ceiling (the caps bound the serialized record), applied after the string's own shape rules. */
const bytes = (schema: z.ZodString, max: number, name: string) =>
  schema.refine((v) => Buffer.byteLength(v, "utf8") <= max, { message: `${name} exceeds ${max} UTF-8 bytes` });

const IdentityShape = {
  client: z.enum(["claude", "codex"]).optional(),
  clientTaskId: bytes(z.string().regex(CLIENT_TASK_ID_PATTERN, "clientTaskId must match the client task id grammar"), MAX_CLIENT_TASK_ID_BYTES, "clientTaskId").optional(),
  agentId: bytes(z.string().min(1), MAX_AGENT_ID_BYTES, "agentId").nullable().optional(),
};

export const RosterStartBodySchema = z
  .object({
    ...IdentityShape,
    sessionId: bytes(z.string().min(1), MAX_SESSION_ID_BYTES, "sessionId").optional(),
    description: bytes(z.string(), MAX_DESCRIPTION_BYTES, "description").nullable().optional(),
  })
  .strict();

export const RosterHeartbeatBodySchema = z
  .object({ ...IdentityShape, generation: z.number().int().positive() })
  .strict();

export const RosterEndBodySchema = z
  .object({
    ...IdentityShape,
    generation: z.number().int().positive(),
    state: z.enum(ROSTER_TERMINAL_STATES as unknown as [RosterTerminalState, ...RosterTerminalState[]]),
  })
  .strict();

export interface RosterCommandOutput {
  readonly output: string;
  readonly exitCode: number;
}

/** The environment's answer for the identity fields the body left out. */
export interface RosterIdentityFallback {
  readonly client: "claude" | "codex";
  readonly clientTaskId: string;
}

export function identityFallbackFromEnvironment(explicitTaskId?: string | null): RosterIdentityFallback | null {
  const owner = ownerTaskForCurrentClient(explicitTaskId);
  return owner ? { client: owner.client, clientTaskId: owner.id } : null;
}

/** `--stdin` body: an empty body is `{}`; anything but a JSON object is refused with a reason. */
export function parseRosterBody(text: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (text.trim().length === 0) return { ok: true, body: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `body is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "body must be a JSON object" };
  return { ok: true, body: raw as Record<string, unknown> };
}

function failure(code: ErrorCode, message: string): RosterCommandOutput {
  return { output: JSON.stringify(errorEnvelope(code, message), null, 2), exitCode: ExitCode.USER_ERROR };
}

const REASON_CODES: Record<Exclude<UpsertResult, { ok: true }>["reason"], string> = {
  "no-roster-dir": "no_roster_dir",
  "skipped-contention": "skipped_contention",
  "refused-transition": "refused_transition",
  "write-failed": "write_failed",
  "invalid-input": "invalid_input",
};

/**
 * One write, one envelope. `root === null` is the no-project case and is
 * answered before anything is validated, so a caller running outside a ledger
 * learns that first and cheaply.
 */
export function handleRosterWrite(
  root: string | null,
  kind: RosterWriteKind,
  body: unknown,
  fallback: RosterIdentityFallback | null,
  nowIso: string = new Date().toISOString(),
): RosterCommandOutput {
  if (root === null) return failure("no_project", "No .story/ project found for this working directory.");
  const schema = kind === "start" ? RosterStartBodySchema : kind === "heartbeat" ? RosterHeartbeatBodySchema : RosterEndBodySchema;
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return failure("invalid_input", `Invalid roster ${kind} body: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`);
  }
  const b = parsed.data as {
    client?: "claude" | "codex";
    clientTaskId?: string;
    agentId?: string | null;
    sessionId?: string;
    description?: string | null;
    generation?: number;
    state?: RosterTerminalState;
  };
  const client = b.client ?? fallback?.client;
  const clientTaskId = b.clientTaskId ?? fallback?.clientTaskId;
  if (!client || !clientTaskId) {
    return failure("invalid_input", "clientTaskId (and client) are required: pass them in the body or set CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID.");
  }
  const agentId = b.agentId ?? null;
  let event: RosterSeatEvent;
  if (kind === "start") {
    event = { kind, client, clientTaskId, agentId, sessionId: b.sessionId ?? clientTaskId, description: b.description ?? null };
  } else if (kind === "heartbeat") {
    event = { kind, client, clientTaskId, agentId, generation: b.generation! };
  } else {
    event = { kind, client, clientTaskId, agentId, generation: b.generation!, state: b.state! };
  }
  const result = upsertSeat(root, event, nowIso);
  if (!result.ok) {
    // The core's reason is the machine-readable code; a caller branches on it
    // (`refused_transition` after a restart is expected, `write_failed` is not).
    return {
      output: JSON.stringify({ version: 1, error: { code: REASON_CODES[result.reason], message: result.message } }, null, 2),
      exitCode: ExitCode.USER_ERROR,
    };
  }
  return {
    output: JSON.stringify(
      successEnvelope({
        ok: true,
        seatId: result.seatId,
        generation: result.seat.generation,
        state: result.seat.state,
        seat: result.seat,
      }),
      null,
      2,
    ),
    exitCode: 0,
  };
}

export interface RosterListOptions {
  readonly all?: boolean;
}

export function rosterListMarkdown(view: BusRosterView, includesTerminal: boolean, seats: BusRosterView["seats"]): string {
  const lines: string[] = [
    "# Roster",
    "",
    `Seats: ${view.live} live, ${view.stale} stale, ${view.terminal} terminal${includesTerminal ? "" : " (hidden; pass --all)"}`,
    "",
  ];
  if (seats.length === 0) {
    lines.push("No seats.");
  } else {
    lines.push("| Seat | State | Stale | Provenance | Gen | Last seen | Description |");
    lines.push("|------|-------|-------|------------|-----|-----------|-------------|");
    for (const s of seats) {
      lines.push(
        `| ${escapeMarkdownInline(s.seatId)} | ${s.state} | ${s.stale ? "yes" : "no"} | ${s.provenance} | ${s.generation} | ${s.lastSeenAt} | ${escapeMarkdownInline(s.description ?? "")} |`,
      );
    }
  }
  if (view.scanTruncated || view.resultTruncated || view.busScanTruncated) {
    lines.push("");
    lines.push("Bounded: the roster was cut (scan or result cap); the counts above cover the seats read, not the population.");
  }
  if (view.diagnostics.length > 0) {
    lines.push("");
    lines.push("## Diagnostics");
    lines.push("");
    for (const d of view.diagnostics) lines.push(`- ${escapeMarkdownInline(d)}`);
  }
  return lines.join("\n");
}

/** `storybloq roster list [--all]` and `storybloq_roster_get`: Bus merged, terminal hidden unless asked for. */
export async function handleRosterList(ctx: CommandContext, opts: RosterListOptions = {}, now = Date.now()): Promise<CommandResult> {
  const view = await readRosterWithBus(ctx.root, ctx.state.config, now);
  const includesTerminal = opts.all === true;
  const seats = includesTerminal ? view.seats : view.seats.filter((s) => s.state === "running");
  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        successEnvelope({
          seats,
          live: view.live,
          stale: view.stale,
          terminal: view.terminal,
          includesTerminal,
          scanTruncated: view.scanTruncated,
          resultTruncated: view.resultTruncated,
          busScanTruncated: view.busScanTruncated,
          diagnostics: view.diagnostics,
        }),
        null,
        2,
      ),
    };
  }
  return { output: rosterListMarkdown(view, includesTerminal, seats) };
}
