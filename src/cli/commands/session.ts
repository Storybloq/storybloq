/**
 * T-251: `claudestory session` CLI — list, show, repair, delete.
 *
 * Four admin subcommands for inspecting and repairing session state. Every
 * user-supplied selector flows through resolveSessionSelector for path
 * containment. Every bulk enumerator is already hardened in session.ts and
 * core/session-scan.ts.
 *
 * repair is the manual escape hatch for T-250 auto-supersede. It supersedes
 *   - `finished_orphan` bucket always (same predicate as T-250)
 *   - `stale_other` bucket only with --all (and interactive confirmation)
 * and never mutates a session whose revision/status drifted between scan and
 * write (under-lock re-validation).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findStaleSessions,
  findResumableSession,
  isLeaseExpired,
  listAllSessions,
  readSession,
  writeSessionWithEvent,
  withSessionLock,
  deleteSessionDir,
  type ActiveSessionInfo,
} from "../../autonomous/session.js";
import { resolveSessionSelector } from "../../autonomous/session-selector.js";
import { isFinishedOrphan } from "../../autonomous/orphan-detector.js";
import type { FullSessionState } from "../../autonomous/session-types.js";

// ---------------------------------------------------------------------------
// Testing hook: revision-drift injection (test 12)
// ---------------------------------------------------------------------------

interface InjectedState {
  scannedRevisionFor: Record<string, number> | null;
}

let injectedState: InjectedState = { scannedRevisionFor: null };

/**
 * Testing-only hook. Forces a stale scannedRevision for specified session IDs
 * so tests can prove the under-lock drift check skips mismatched entries.
 * Pass `{ scannedRevisionFor: null }` to clear.
 */
export function __t251RepairInject(state: InjectedState): void {
  injectedState = state;
}

// ---------------------------------------------------------------------------
// session list
// ---------------------------------------------------------------------------

export interface ListOpts {
  status: "active" | "completed" | "superseded" | "all";
  format: "text" | "json";
}

export async function handleSessionList(root: string, opts: ListOpts): Promise<string> {
  const all = listAllSessions(root);
  const filtered = opts.status === "all"
    ? all
    : all.filter((s) => s.state.status === opts.status);

  filtered.sort((a, b) => {
    const at = a.state.lastGuideCall ? new Date(a.state.lastGuideCall).getTime() : 0;
    const bt = b.state.lastGuideCall ? new Date(b.state.lastGuideCall).getTime() : 0;
    if (Number.isNaN(at) || Number.isNaN(bt)) return 0;
    if (bt !== at) return bt - at;
    return a.state.sessionId.localeCompare(b.state.sessionId);
  });

  if (opts.format === "json") {
    return JSON.stringify(
      {
        sessions: filtered.map((s) => ({
          sessionId: s.state.sessionId,
          status: s.state.status,
          state: s.state.state,
          leaseExpiresAt: s.state.lease?.expiresAt ?? null,
          ticketId: (s.state as FullSessionState & { ticket?: { id?: string } }).ticket?.id ?? null,
          mode: s.state.mode ?? "auto",
          lastGuideCall: s.state.lastGuideCall ?? null,
        })),
      },
      null,
      2,
    );
  }

  if (filtered.length === 0) {
    return "No sessions found.";
  }

  const lines: string[] = [];
  lines.push("Session ID                            Status      State        Lease              Ticket   Mode");
  lines.push("------------------------------------  ----------  -----------  -----------------  -------  ------");
  for (const s of filtered) {
    const ticketId =
      (s.state as FullSessionState & { ticket?: { id?: string } }).ticket?.id ?? "-";
    lines.push(
      [
        s.state.sessionId.padEnd(36),
        s.state.status.padEnd(10),
        s.state.state.padEnd(11),
        formatLease(s.state.lease?.expiresAt).padEnd(17),
        ticketId.padEnd(7),
        (s.state.mode ?? "auto").padEnd(6),
      ].join("  "),
    );
  }
  return lines.join("\n");
}

function formatLease(expiresAt: string | null | undefined): string {
  if (!expiresAt) return "-";
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return "-";
  const diffMs = t - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  if (mins < 60) return diffMs >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return diffMs >= 0 ? `in ${days}d` : `${days}d ago`;
}

// ---------------------------------------------------------------------------
// session show
// ---------------------------------------------------------------------------

export interface ShowOpts {
  format: "text" | "json";
  events: number;
}

export async function handleSessionShow(
  root: string,
  selector: string,
  opts: ShowOpts,
): Promise<string> {
  const res = resolveSessionSelector(root, selector);
  if (res.kind === "invalid") throw new Error(res.reason);
  if (res.kind === "not_found") throw new Error(`Session ${selector} not found`);
  if (res.kind === "ambiguous") {
    throw new Error(
      `Session selector "${selector}" matches ${res.matches.length} sessions: ${res.matches.join(
        ", ",
      )}. Use a longer prefix.`,
    );
  }
  if (res.corrupt) {
    throw new Error(
      `Session ${res.sessionId} state.json is corrupt or unreadable. ` +
        `Use 'session delete ${res.sessionId} --yes' to remove it, or edit state.json by hand.`,
    );
  }

  const state = res.state!;
  const events = readTailEvents(res.dir, opts.events);

  if (opts.format === "json") {
    return JSON.stringify({ state, recentEvents: events }, null, 2);
  }

  const lines: string[] = [];
  lines.push(`Session: ${state.sessionId}`);
  lines.push(`Status:  ${state.status}`);
  lines.push(`State:   ${state.state}`);
  lines.push(`Mode:    ${state.mode ?? "auto"}`);
  lines.push(`Recipe:  ${state.recipe}`);
  lines.push(`Lease:   ${formatLease(state.lease?.expiresAt)} (${state.lease?.expiresAt ?? "n/a"})`);
  const ticket = (state as FullSessionState & { ticket?: { id?: string; title?: string } }).ticket;
  if (ticket?.id) {
    lines.push(`Ticket:  ${ticket.id} — ${ticket.title ?? ""}`);
  }
  if (state.completedTickets.length) {
    lines.push("");
    lines.push("Completed tickets:");
    for (const t of state.completedTickets) {
      lines.push(`  ${t.id} (${t.commitHash?.slice(0, 8) ?? "no-hash"})`);
    }
  }
  if ((state.resolvedIssues ?? []).length) {
    lines.push("");
    lines.push("Resolved issues:");
    for (const i of state.resolvedIssues ?? []) {
      lines.push(`  ${i.id}`);
    }
  }
  if (events.length) {
    lines.push("");
    lines.push(`Recent events (last ${events.length}):`);
    for (const ev of events) {
      lines.push(`  [rev ${ev.rev}] ${ev.type} ${ev.timestamp}`);
    }
  }
  return lines.join("\n");
}

interface TailEvent {
  rev: number;
  type: string;
  timestamp: string;
}

function readTailEvents(dir: string, limit: number): TailEvent[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "events.log"), "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-limit);
  const parsed: TailEvent[] = [];
  for (const line of tail) {
    try {
      const e = JSON.parse(line) as TailEvent;
      if (typeof e.rev === "number" && typeof e.type === "string") {
        parsed.push(e);
      }
    } catch {
      // skip malformed
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// session repair
// ---------------------------------------------------------------------------

export interface RepairOpts {
  selector?: string;
  dryRun: boolean;
  all: boolean;
  yes: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

type RepairBucket = "finished_orphan" | "stale_other";

interface RepairCandidate {
  sessionId: string;
  dir: string;
  state: FullSessionState;
  scannedRevision: number;
  bucket: RepairBucket;
  action: "supersede" | "skip";
  skipReason?: string;
}

export async function handleSessionRepair(
  root: string,
  opts: RepairOpts,
): Promise<string> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  // --- Candidate collection (no lock) ---
  const raw: ActiveSessionInfo[] = [];

  if (opts.selector) {
    const res = resolveSessionSelector(root, opts.selector);
    if (res.kind === "invalid") throw new Error(res.reason);
    if (res.kind === "not_found") throw new Error(`Session ${opts.selector} not found`);
    if (res.kind === "ambiguous") {
      throw new Error(
        `Session selector "${opts.selector}" matches ${res.matches.length} sessions: ${res.matches.join(
          ", ",
        )}. Use a longer prefix.`,
      );
    }
    if (res.corrupt) {
      throw new Error(
        `Session ${res.sessionId} state.json is corrupt; 'session repair' can only operate on parseable sessions. Use 'session delete' instead.`,
      );
    }
    if (res.state!.status !== "active") {
      throw new Error(
        `Session ${res.sessionId} is ${res.state!.status}, not active. 'repair' only supersedes active orphan sessions; 'delete' is the destructive escape hatch for terminal records.`,
      );
    }
    raw.push({ state: res.state!, dir: res.dir });
  } else {
    const stale = findStaleSessions(root);
    const resumable = findResumableSession(root);
    const seen = new Set<string>();
    for (const s of stale) {
      if (s.state.status !== "active") continue;
      if (seen.has(s.state.sessionId)) continue;
      seen.add(s.state.sessionId);
      raw.push(s);
    }
    if (resumable) {
      const r = resumable.info;
      if (r.state.status === "active" && !seen.has(r.state.sessionId)) {
        seen.add(r.state.sessionId);
        raw.push(r);
      }
    }
  }

  // --- Classification ---
  const classified: RepairCandidate[] = [];
  for (const info of raw) {
    const isOrphan = await isFinishedOrphan(info.state, info.dir, root);
    const bucket: RepairBucket = isOrphan ? "finished_orphan" : "stale_other";
    const injection = injectedState.scannedRevisionFor?.[info.state.sessionId];
    const scannedRevision = injection !== undefined ? injection : info.state.revision;
    let action: "supersede" | "skip" = "supersede";
    let skipReason: string | undefined;
    if (bucket === "stale_other" && !opts.all) {
      action = "skip";
      skipReason = "requires_--all";
    }
    classified.push({
      sessionId: info.state.sessionId,
      dir: info.dir,
      state: info.state,
      scannedRevision,
      bucket,
      action,
      skipReason,
    });
  }

  const toSupersede = classified.filter((c) => c.action === "supersede");
  const skippedPreLock = classified.filter((c) => c.action === "skip");

  // --- Dry run ---
  if (opts.dryRun) {
    return renderRepairSummary(toSupersede, skippedPreLock, [], { mutated: 0 });
  }

  // --- Confirmation ---
  if (toSupersede.length > 0 && !opts.yes) {
    const isTty = (stdin as { isTTY?: boolean }).isTTY === true;
    if (!isTty) {
      throw new Error("session repair requires --yes when stdin is not a TTY.");
    }
    stdout.write(`Supersede ${toSupersede.length} session(s)? [y/N] `);
    const answer = (await readOneLine(stdin)).trim();
    if (!/^y(es)?$/i.test(answer)) {
      return "Repair aborted by user.";
    }
  }

  // --- Mutation under lock ---
  let mutated = 0;
  const mutationSkipped: { sessionId: string; reason: string }[] = [];

  if (toSupersede.length > 0) {
    await withSessionLock(root, async () => {
      for (const c of toSupersede) {
        if (!existsSync(c.dir)) {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "directory_missing" });
          continue;
        }
        const fresh = readSession(c.dir);
        if (!fresh) {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "state_unreadable" });
          continue;
        }
        if (fresh.status !== "active") {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "not_active" });
          continue;
        }
        if (fresh.revision !== c.scannedRevision) {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "state_changed_during_repair" });
          continue;
        }
        if (c.bucket === "finished_orphan") {
          const still = await isFinishedOrphan(fresh, c.dir, root);
          if (!still) {
            mutationSkipped.push({ sessionId: c.sessionId, reason: "no_longer_orphan" });
            continue;
          }
        } else if (!isLeaseExpired(fresh)) {
          mutationSkipped.push({ sessionId: c.sessionId, reason: "lease_refreshed" });
          continue;
        }

        const terminationReason =
          c.bucket === "finished_orphan"
            ? "auto_superseded_finished_orphan"
            : "admin_recovery";
        const leaseExpiredMinutesAgo = fresh.lease?.expiresAt
          ? Math.max(
              0,
              Math.floor((Date.now() - new Date(fresh.lease.expiresAt).getTime()) / 60000),
            )
          : null;

        const nextState: FullSessionState = {
          ...fresh,
          status: "superseded",
          terminationReason,
        };

        writeSessionWithEvent(c.dir, nextState, {
          rev: fresh.revision + 1,
          type: "manual_repair",
          timestamp: new Date().toISOString(),
          data: {
            reason: terminationReason,
            bucket: c.bucket,
            leaseExpiredMinutesAgo,
            repairedBy: "cli",
          },
        });
        mutated++;
      }
    });
  }

  return renderRepairSummary(toSupersede, skippedPreLock, mutationSkipped, { mutated });
}

function renderRepairSummary(
  toSupersede: RepairCandidate[],
  skippedPreLock: RepairCandidate[],
  mutationSkipped: { sessionId: string; reason: string }[],
  result: { mutated: number },
): string {
  const lines: string[] = [];
  lines.push(
    `Repaired ${result.mutated} session(s). ${skippedPreLock.length + mutationSkipped.length} skipped.`,
  );
  if (toSupersede.length > 0) {
    lines.push("");
    lines.push("Planned:");
    for (const c of toSupersede) {
      lines.push(`  ${c.sessionId} (${c.bucket})`);
    }
  }
  if (skippedPreLock.length > 0) {
    lines.push("");
    lines.push("Skipped (pre-lock):");
    for (const c of skippedPreLock) {
      lines.push(`  ${c.sessionId} (${c.skipReason ?? "unknown"})`);
    }
  }
  if (mutationSkipped.length > 0) {
    lines.push("");
    lines.push("Skipped (under lock):");
    for (const m of mutationSkipped) {
      lines.push(`  ${m.sessionId} (${m.reason})`);
    }
  }
  return lines.join("\n");
}

async function readOneLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const onData = (chunk: Buffer | string) => {
      if (done) return;
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        done = true;
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = () => {
      if (done) return;
      done = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      resolve(buf);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}

// ---------------------------------------------------------------------------
// session delete
// ---------------------------------------------------------------------------

export interface DeleteOpts {
  yes: boolean;
}

export async function handleSessionDelete(
  root: string,
  selector: string,
  opts: DeleteOpts,
): Promise<string> {
  const res = resolveSessionSelector(root, selector);
  if (res.kind === "invalid") throw new Error(res.reason);
  if (res.kind === "not_found") throw new Error(`Session ${selector} not found`);
  if (res.kind === "ambiguous") {
    throw new Error(
      `Session selector "${selector}" matches ${res.matches.length} sessions: ${res.matches.join(
        ", ",
      )}. Use a longer prefix.`,
    );
  }
  if (!opts.yes) {
    throw new Error("session delete requires --yes (destructive, removes the session directory).");
  }

  return withSessionLock(root, async () => {
    if (!existsSync(res.dir)) {
      return `Session ${res.sessionId} already deleted.`;
    }

    // Always re-read under lock — the corrupt flag observed during resolution
    // is stale by the time we hold the lock. A session that was corrupt at
    // resolution time may have been repaired in the gap; refuse to delete a
    // now-active session even if the pre-lock snapshot looked deletable.
    const fresh = readSession(res.dir);
    if (fresh && fresh.status === "active" && !isLeaseExpired(fresh)) {
      throw new Error(
        `Session ${res.sessionId} is active. Stop it first with 'session stop ${res.sessionId}'.`,
      );
    }

    deleteSessionDir(root, res.sessionId);
    return `Session ${res.sessionId} deleted.`;
  });
}
