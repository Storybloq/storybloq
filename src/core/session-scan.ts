/**
 * Lightweight session scanner for status display (ISS-023).
 *
 * Extracts the minimum needed from .story/sessions/ without importing
 * the autonomous subsystem, avoiding an inverted dependency.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isContainedSessionDir } from "../autonomous/session-selector.js";
import { normalizeClientTaskId, type OwnerTask } from "../autonomous/client-profile.js";

export type SessionLeaseState = "live" | "expired" | "missing" | "invalid";

export interface ActiveSessionSummary {
  readonly sessionId: string;
  /**
   * The on-disk directory name (T-446).
   *
   * `sessionId` is file content, so it can differ from the directory it lives
   * in. `resolveSessionSelector` resolves DIRECTORY names, which makes this the
   * selector `storybloq session ...` prefers; guide and MCP calls still take
   * `sessionId`. Rendering only one of the two hands an operator a selector that
   * may not resolve.
   *
   * Not a guarantee of acceptance: this is copied verbatim from the directory
   * entry and never validated, so a legacy or hand-created directory whose name
   * fails the selector's own format check appears here and is still rejected.
   * Treat it as the address to inspect, not as a promise the CLI will take it.
   */
  readonly sourceDir: string;
  readonly state: string;
  readonly mode: string;
  readonly ticketId: string | null;
  readonly ticketTitle: string | null;
  readonly ownerTask?: OwnerTask | null;
  readonly leaseExpiresAt?: string | null;
  readonly leaseState?: SessionLeaseState;
  readonly compactPending?: boolean;
}

export interface SessionScanResult {
  readonly activeSessions: readonly ActiveSessionSummary[];
  readonly resumableSessions: readonly ActiveSessionSummary[];
}

/**
 * Scan .story/sessions/ for active, non-expired sessions.
 * Returns an empty array if no sessions directory or no active sessions.
 */
export function scanActiveSessions(root: string): readonly ActiveSessionSummary[] {
  return scanSessionSummaries(root).activeSessions;
}

/**
 * Scan active sessions and compacted recovery candidates in one filesystem pass.
 * A live compacted session remains in activeSessions for backward compatibility.
 * Expired compacted sessions appear separately in resumableSessions.
 */
export function scanSessionSummaries(root: string): SessionScanResult {
  const sessDir = join(root, ".story", "sessions");
  let entries: Dirent[];
  try {
    entries = readdirSync(sessDir, { withFileTypes: true }) as Dirent[];
  } catch {
    return { activeSessions: [], resumableSessions: [] };
  }

  const activeSessions: ActiveSessionSummary[] = [];
  const resumableSessions: ActiveSessionSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // T-251: drop symlink-escape entries before any filesystem read.
    if (!isContainedSessionDir(root, join(sessDir, entry.name))) continue;
    const statePath = join(sessDir, entry.name, "state.json");
    let raw: string;
    try {
      raw = readFileSync(statePath, "utf-8");
    } catch {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.status !== "active") continue;
    if (parsed.state === "SESSION_END") continue;

    const lease = parsed.lease as Record<string, unknown> | undefined;
    const leaseExpiresAt = typeof lease?.expiresAt === "string" ? lease.expiresAt : null;
    const expires = leaseExpiresAt ? new Date(leaseExpiresAt).getTime() : Number.NaN;
    const leaseState: SessionLeaseState = !leaseExpiresAt
      ? "missing"
      : Number.isNaN(expires)
        ? "invalid"
        : expires <= Date.now()
          ? "expired"
          : "live";

    const ticket = parsed.ticket as Record<string, unknown> | undefined;
    const rawOwner = parsed.ownerTask as Record<string, unknown> | undefined;
    const ownerTaskId = typeof rawOwner?.id === "string"
      ? normalizeClientTaskId(rawOwner.id)
      : null;
    const ownerTask = rawOwner &&
      (rawOwner.client === "claude" || rawOwner.client === "codex") &&
      ownerTaskId !== null &&
      typeof rawOwner.boundAt === "string"
      ? {
          client: rawOwner.client,
          id: ownerTaskId,
          boundAt: rawOwner.boundAt,
        } satisfies OwnerTask
      : null;
    const summary: ActiveSessionSummary = {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : entry.name,
      sourceDir: entry.name,
      state: typeof parsed.state === "string" ? parsed.state : "unknown",
      mode: typeof parsed.mode === "string" ? parsed.mode : "auto",
      ticketId: typeof ticket?.id === "string" ? ticket.id : null,
      ticketTitle: typeof ticket?.title === "string" ? ticket.title : null,
      ownerTask,
      leaseExpiresAt,
      leaseState,
      compactPending: parsed.compactPending === true,
    };

    if (leaseState === "live") activeSessions.push(summary);
    if (summary.state === "COMPACT" && summary.compactPending && leaseState !== "live") {
      resumableSessions.push(summary);
    }
  }

  activeSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  resumableSessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return { activeSessions, resumableSessions };
}
