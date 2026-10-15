import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Ticket } from "../models/ticket.js";
import type { ProjectState } from "../core/project-state.js";
import type { ResolvedNode } from "./resolver.js";
import { crossNodeObservation, type CrossNodeObservationOptions } from "./cross-node-observation.js";

/**
 * A cross-node ref's live status. Only "complete" releases the dependent;
 * "withdrawn" and "withheld" carry the withdrawn ticket ids, and
 * "checkpoint" is an owner checkpoint not yet approved or retired (T-486 U2-4).
 */
export type CrossNodeRefStatus =
  | { resolved: true; status: "complete" | "open" | "inprogress" | "checkpoint" }
  | { resolved: true; status: "withdrawn" | "withheld"; detail: string[] }
  | { resolved: false; reason: string };

function normalizeStatus(status: string): "complete" | "open" | "inprogress" {
  if (status === "complete" || status === "resolved") return "complete";
  if (status === "inprogress") return "inprogress";
  return "open";
}

/** ISS-687: legacy (T-) and canonical (t-) ticket refs read the tickets directory. */
export function isTicketRef(itemId: string): boolean {
  return itemId.startsWith("T-") || itemId.startsWith("t-");
}

/**
 * T-486 U2-4 (V3A 5c, D1): a ticket ref judged from the target node's whole
 * ticket graph by the node's own release rule. A missing or ambiguous ref is
 * unresolved; a found one is complete only when it releases.
 */
export function ticketRefStatus(graph: ProjectState, itemId: string): CrossNodeRefStatus {
  const found = graph.resolveTicketRef(itemId);
  if (found.kind === "missing") {
    // B1, fail closed: a file the loader could not accept that could be this ref names the cause.
    const files = graph.omittedTickets.filter((o) => o.id === undefined || o.id === itemId).map((o) => o.file);
    if (files.length > 0) return { resolved: false, reason: `ticket files the node could not load: ${files.join(", ")}` };
    return { resolved: false, reason: "item not found in node" };
  }
  if (found.kind === "ambiguous") {
    return { resolved: false, reason: `ambiguous ref ${itemId} in node (${found.matches.map((m) => m.id).join(", ")})` };
  }
  const ticket = found.item;
  const release = graph.dependencyRelease(ticket);
  if (release.releases) return { resolved: true, status: "complete" };
  const reason = release.reason;
  switch (reason) {
    case "withdrawn":
    case "withheld":
      return { resolved: true, status: reason, detail: [...release.detail] };
    case "duplicate":
      return { resolved: false, reason: `duplicate canonical id ${ticket.id} in node` };
    case "cycle":
      return { resolved: false, reason: `parent cycle under ${ticket.id}` };
    case "incomplete":
      return { resolved: false, reason: `ticket files the node could not load: ${release.detail.join(", ")}` };
    case "checkpoint":
      return { resolved: true, status: "checkpoint" };
    case null:
      return { resolved: true, status: ticket.status === "inprogress" ? "inprogress" : "open" };
    default: {
      const unhandled: never = reason;
      return { resolved: false, reason: `unknown release reason ${String(unhandled)}` };
    }
  }
}

const DISPLAY_ISSUE_REGEX = /^ISS-\d+$/;

function issueStatusFromContent(parsed: Record<string, unknown>): CrossNodeRefStatus {
  if (typeof parsed.status === "string") {
    const status = normalizeStatus(parsed.status);
    return { resolved: true, status };
  }
  return { resolved: false, reason: "item not found in node" };
}

/**
 * An issue ref, read from the node's issues directory: the file named by the
 * ref, then a displayId match, then a previousDisplayIds match (ISS-687,
 * N-059). It runs inside the node's job, so the scheduler bounds it.
 */
export async function resolveIssueStatus(storyDir: string, itemId: string, signal?: AbortSignal): Promise<CrossNodeRefStatus> {
  const dir = join(storyDir, "issues");
  try {
    const raw = await readFile(join(dir, `${itemId}.json`), "utf-8");
    return issueStatusFromContent(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    // fall through to the displayId-from-content scan
  }
  signal?.throwIfAborted();
  if (DISPLAY_ISSUE_REGEX.test(itemId)) {
    try {
      const files = await readdir(dir);
      let prevFallback: CrossNodeRefStatus | null = null;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        signal?.throwIfAborted();
        try {
          const parsed = JSON.parse(await readFile(join(dir, file), "utf-8")) as Record<string, unknown>;
          if (parsed.displayId === itemId) return issueStatusFromContent(parsed);
          if (
            prevFallback === null &&
            Array.isArray(parsed.previousDisplayIds) &&
            (parsed.previousDisplayIds as unknown[]).includes(itemId)
          ) {
            prevFallback = issueStatusFromContent(parsed);
          }
        } catch {
          // skip unreadable/malformed file
        }
      }
      if (prevFallback) return prevFallback;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  return { resolved: false, reason: "item not found in node" };
}

export class CrossNodeBlockingResolver {
  private constructor(private readonly statuses: Map<string, CrossNodeRefStatus>) {}

  /** T-486 U2-4: built from one live observation (bounded, one graph load per node). */
  static async build(
    tickets: readonly Ticket[],
    resolvedNodes: Map<string, ResolvedNode>,
    options: Omit<CrossNodeObservationOptions, "tickets" | "resolvedNodes"> = {},
  ): Promise<CrossNodeBlockingResolver> {
    const observation = await crossNodeObservation({ ...options, tickets, resolvedNodes });
    return new CrossNodeBlockingResolver(observation.statuses);
  }

  static fromStatuses(statuses: Map<string, CrossNodeRefStatus>): CrossNodeBlockingResolver {
    return new CrossNodeBlockingResolver(statuses);
  }

  isCrossNodeBlocked(ticket: Ticket): boolean | "unresolved" {
    const refs = ticket.crossNodeBlockedBy;
    if (!refs || refs.length === 0) return false;

    let hasUnresolved = false;

    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      const status = this.statuses.get(ref);
      if (!status) {
        hasUnresolved = true;
        continue;
      }

      if (!status.resolved) {
        hasUnresolved = true;
        continue;
      }

      if (status.status !== "complete") {
        return true;
      }
    }

    return hasUnresolved ? "unresolved" : false;
  }

  getCrossNodeStatus(ref: string): CrossNodeRefStatus | undefined {
    return this.statuses.get(ref);
  }

  get resolvedStatuses(): ReadonlyMap<string, CrossNodeRefStatus> {
    return this.statuses;
  }
}
