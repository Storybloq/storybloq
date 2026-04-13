/**
 * Lightweight session scanner for status display (ISS-023).
 *
 * Extracts the minimum needed from .story/sessions/ without importing
 * the autonomous subsystem, avoiding an inverted dependency.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isContainedSessionDir } from "../autonomous/session-selector.js";

export interface ActiveSessionSummary {
  readonly sessionId: string;
  readonly state: string;
  readonly mode: string;
  readonly ticketId: string | null;
  readonly ticketTitle: string | null;
}

/**
 * Scan .story/sessions/ for active, non-expired sessions.
 * Returns an empty array if no sessions directory or no active sessions.
 */
export function scanActiveSessions(root: string): readonly ActiveSessionSummary[] {
  const sessDir = join(root, ".story", "sessions");
  let entries: Dirent[];
  try {
    entries = readdirSync(sessDir, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  const results: ActiveSessionSummary[] = [];

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

    // Only active sessions with non-expired lease
    if (parsed.status !== "active") continue;
    if (parsed.state === "SESSION_END") continue;

    const lease = parsed.lease as Record<string, unknown> | undefined;
    if (lease?.expiresAt) {
      const expires = new Date(lease.expiresAt as string).getTime();
      if (!Number.isNaN(expires) && expires <= Date.now()) continue;
    } else {
      continue; // No lease or missing expiresAt — treat as expired/invalid
    }

    const ticket = parsed.ticket as Record<string, unknown> | undefined;
    results.push({
      sessionId: (parsed.sessionId as string) ?? entry.name,
      state: (parsed.state as string) ?? "unknown",
      mode: (parsed.mode as string) ?? "auto",
      ticketId: (ticket?.id as string) ?? null,
      ticketTitle: (ticket?.title as string) ?? null,
    });
  }

  return results;
}
