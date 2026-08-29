import type { z } from "zod";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { arrangementCoversTicket } from "../../core/arrangement-bounds.js";
import { isArrangementConflicted } from "../../core/arrangement-authority.js";
import type { ArrangementGateSchema } from "../../models/arrangement.js";
import type { GateAckLookupResult } from "../../core/gate-ack-loader.js";
import { sanitizeDisplayText } from "../../core/display-text.js";
import type { FullSessionState } from "../session-types.js";
import type { StageContext } from "./types.js";

export type ArrangementGate = z.infer<typeof ArrangementGateSchema>;

/** T-474 section 5: the discriminated `frozenGate` shape, minus `undefined` (the "not yet resolved" case handled by the resolver below). */
export type FrozenGate = NonNullable<FullSessionState["frozenGate"]>;

/**
 * T-474 section 5: resolve a ticket's duet-mode gate posture from
 * `.story/arrangements/` fresh.
 *
 * Any scan warning (an unreadable arrangement anywhere in the project) makes
 * the WHOLE result "unresolved", regardless of whether a positive match is
 * also found among the successfully parsed entries -- an unreadable entry
 * could itself be a second arrangement covering the same ticket, so a scan
 * is trusted only when completely clean.
 *
 * More than one `active` arrangement matching the same ticket also resolves
 * "unresolved" -- write-time uniqueness at `arrangement update` should
 * prevent this, but it is checked defensively here rather than picking one
 * arbitrarily.
 */
export function resolveGateStatus(
  root: string,
  canonicalTicketId: string,
  resolver: Parameters<typeof arrangementCoversTicket>[2],
): FrozenGate {
  const { arrangements, warnings } = loadArrangementsSafe(root);
  if (warnings.length > 0) {
    return { status: "unresolved", reason: warnings.join("; ").slice(0, 1024) };
  }

  let matched: { arrangementId: string; gates: ArrangementGate[] } | null = null;
  let sawUnresolved = false;
  for (const arrangement of arrangements) {
    // T-478: checked BEFORE the lifecycle skip below, not after -- a
    // conflicted arrangement's retained `lifecycle` could itself be the
    // disputed field and could happen to read "closed", which would let the
    // skip below silently resolve the ticket ungated instead of flagging it
    // unresolved. Ordering is load-bearing here.
    if (isArrangementConflicted(arrangement)) {
      sawUnresolved = true;
      continue;
    }
    if (arrangement.lifecycle !== "active") continue;
    const coverage = arrangementCoversTicket(arrangement, canonicalTicketId, resolver);
    if (coverage === "unresolved") {
      sawUnresolved = true;
      continue;
    }
    if (coverage === "matched") {
      if (matched) {
        // A second match: defensive-only (write-time uniqueness should
        // prevent this), never picks one arbitrarily.
        sawUnresolved = true;
        continue;
      }
      matched = { arrangementId: arrangement.id, gates: arrangement.gates };
    }
  }

  if (sawUnresolved) {
    return { status: "unresolved", reason: "more than one active arrangement's coverage of this ticket could not be conclusively resolved" };
  }
  if (matched) return { status: "gated", arrangementId: matched.arrangementId, gates: matched.gates };
  return { status: "ungated" };
}

/**
 * Read `ctx.state.frozenGate` if PICK_TICKET already resolved it this run.
 * `undefined` means a legacy session that predates this field -- resolved
 * lazily, once, and cached via `ctx.writeState` so every later check in the
 * same session reads the same frozen value rather than re-scanning.
 *
 * Ticket-only (T-474 section 7, ISS-1032-shaped descope): an issue-fix
 * session (`ctx.state.ticket` absent) always resolves to `{status:
 * "ungated"}` here -- there is no ticket to resolve gates against.
 */
export async function resolveOrReadFrozenGateStatus(ctx: StageContext): Promise<FrozenGate> {
  if (ctx.state.frozenGate !== undefined) return ctx.state.frozenGate;

  const ticketId = ctx.state.ticket?.id;
  if (!ticketId) {
    const resolved: FrozenGate = { status: "ungated" };
    ctx.writeState({ frozenGate: resolved });
    return resolved;
  }
  // Binding scope item 4: "Enforcement never fails open," unqualified. A
  // project that cannot load at all is a BIGGER failure than a single
  // unreadable arrangement file -- resolving it to "ungated" would make the
  // gate strongest against the mildest corruption and absent against the
  // worst, and would let anything that makes the project transiently
  // unloadable at exactly the enforcement moment (I/O error, half-written
  // file, disk pressure) silently delete the gate. Blocks-with-explanation
  // instead, the same posture as an unreadable ack store: a false block
  // costs a retry instruction; a false pass here is an unacked plan
  // entering IMPLEMENT or an unacked commit accepted -- the exact event
  // this ticket exists to prevent.
  let resolved: FrozenGate;
  try {
    const { state: projectState } = await ctx.loadProject();
    resolved = resolveGateStatus(ctx.root, ticketId, projectState);
  } catch (err) {
    resolved = { status: "unresolved", reason: `project load failed: ${sanitizeDisplayText(String(err))}`.slice(0, 1024) };
  }
  ctx.writeState({ frozenGate: resolved });
  return resolved;
}

/** Rendered when the gate posture itself could not be resolved (unreadable arrangement data) -- never treated as approved. */
export function renderUnresolvedHold(reason: string): string {
  return [
    `This ticket's duet-mode gate status could not be resolved: ${reason}.`,
    "Do NOT treat this as approved. Escalate to your operator -- an arrangement file under .story/arrangements/ may be corrupt or unreadable.",
  ].join("\n");
}

/**
 * Rendered whenever a gate is declared but the current content has no valid
 * (or has a contested) gate-ack. `lookup.status === "valid"` never reaches
 * this function -- a valid lookup means the gate is satisfied, not held --
 * so callers must branch on that status themselves before rendering a hold.
 */
export function renderGateAckHold(lookup: GateAckLookupResult, gate: ArrangementGate): string {
  switch (lookup.status) {
    case "absent":
      return [
        `Holding: gate "${gate.name}" requires a gate-ack from ${gate.ackRole} before this can proceed.`,
        "None has been recorded yet for the current content. Wait, then re-report to check again.",
      ].join("\n");
    case "unreadable":
      return `Holding: gate "${gate.name}" has a gate-ack record that could not be read (${lookup.reason}). Escalate to your operator.`;
    case "contested":
      return [
        `Holding: gate "${gate.name}"'s gate-ack was recorded but has since been marked contested (${lookup.ack.contestedReason ?? "no reason given"}).`,
        "A fresh ack is required. Escalate to your operator.",
      ].join("\n");
    case "valid":
      return `Gate "${gate.name}" is satisfied; this hold should not have been rendered. Escalate to your operator.`;
  }
}
