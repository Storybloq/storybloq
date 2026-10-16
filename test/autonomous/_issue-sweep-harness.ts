/**
 * T-486 U4-1: the fixture the two issue-sweep suites share. A project with one
 * complete ticket, a session planted in ISSUE_SWEEP (or COMPACT on its way
 * back to it), and the guide calls the tests drive. Fault injection lives in
 * each suite's own vi.mock; nothing here mocks.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { entityFingerprint } from "../../src/autonomous/pending-artifacts.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { resolutionDigest } from "../../src/core/resolution-kind.js";

export const DAY = "2026-10-16";
export const OTHER_SESSION = "00000000-0000-0000-0000-00000000beef";

export type SweepLists = {
  remaining: string[];
  current: string | null;
  resolved: string[];
  disposed?: Array<{ id: string; kind: string }>;
  deferred?: Array<{ id: string; disposition: string; reason: string; ref: string }>;
  conflicted?: Array<{ id: string; reason: string }>;
};

export function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: DAY,
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Done", description: "A test.", type: "task", status: "complete",
    phase: "p1", order: 10, createdDate: DAY, completedDate: DAY, blockedBy: [],
  }));
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
}

export function issueRecord(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: `Issue ${id}`, status: "open", severity: "high", components: [],
    impact: `Impact of ${id}`, resolution: null, location: [], discoveredDate: DAY,
    resolvedDate: null, relatedTickets: [],
    ...extra,
  };
}

export function writeIssue(root: string, id: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify(issueRecord(id, extra), null, 2) + "\n");
}

export function issueText(root: string, id: string): string {
  return readFileSync(join(root, ".story", "issues", `${id}.json`), "utf-8");
}

export function readIssue(root: string, id: string): Record<string, unknown> {
  return JSON.parse(issueText(root, id)) as Record<string, unknown>;
}

/** This session's acquisition, as the sweep writes it. */
export function acquiredBy(sessionId: string): Record<string, unknown> {
  return { status: "inprogress", sweepAcquisition: { sessionId, transitionId: "issue-sweep-acquire-fixture" } };
}

/** A resolved issue closed with a bound kind (the kind counts only when bound). */
export function resolvedAs(kind: string, resolution: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "resolved", resolution, resolvedDate: DAY,
    resolutionKind: { kind, closedOn: DAY, resolutionDigest: resolutionDigest(resolution) },
    ...extra,
  };
}

export function deferredAs(disposition: string, reason: string | undefined, ref: string | undefined, dispositionFor: string = disposition): Record<string, unknown> {
  return {
    disposition,
    ...(reason !== undefined ? { dispositionReason: reason } : {}),
    ...(ref !== undefined ? { dispositionRef: ref } : {}),
    dispositionFor,
  };
}

export async function loadedFingerprint(root: string, id: string): Promise<string> {
  const { loadProject } = await import("../../src/core/project-loader.js");
  const { state } = await loadProject(root);
  const issue = state.issues.find((i) => i.id === id);
  if (!issue) throw new Error(`fixture issue ${id} not found`);
  const fp = entityFingerprint(issue);
  if (!fp) throw new Error(`fixture issue ${id} has no fingerprint`);
  return fp;
}

export function readState(dir: string): FullSessionState {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as FullSessionState;
}

export function stateText(dir: string): string {
  return readFileSync(join(dir, "state.json"), "utf-8");
}

export function eventsOfType(dir: string, type: string): Array<Record<string, unknown>> {
  const logPath = join(dir, "events.log");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

/** Every file under a directory, by relative path, to its sha256. */
export function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out[r] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

/**
 * A live session in ISSUE_SWEEP with the sweep enabled, or (compact: true) a
 * session parked in COMPACT that resumes into ISSUE_SWEEP.
 */
export function plant(
  root: string,
  sweep: SweepLists | null,
  opts: { marker?: Record<string, unknown> | null; compact?: boolean } = {},
): { sessionId: string; dir: string } {
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const dir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(dir, {
    ...session,
    state: opts.compact ? "COMPACT" : "ISSUE_SWEEP",
    previousState: "COMPLETE",
    ...(opts.compact ? { preCompactState: "ISSUE_SWEEP", compactPending: true, compactPreparedAt: new Date().toISOString() } : {}),
    pipelinePhase: "postComplete",
    completedTickets: [{ id: "T-001" }],
    resolvedPostComplete: ["ISSUE_SWEEP", "HANDOVER"],
    resolvedStages: { ISSUE_SWEEP: { enabled: true } },
    issueSweepState: sweep,
    pendingProjectMutation: opts.marker ?? null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, dir };
}

export type GuideCall = { text: string; isError: boolean; thrown: Error | null };

async function call(root: string, input: Parameters<typeof handleAutonomousGuide>[1]): Promise<GuideCall> {
  try {
    const r = await handleAutonomousGuide(root, input);
    const text = (r.content ?? []).map((c) => ("text" in c ? String(c.text) : "")).join("\n");
    return { text, isError: Boolean(r.isError), thrown: null };
  } catch (err) {
    return { text: "", isError: true, thrown: err instanceof Error ? err : new Error(String(err)) };
  }
}

export function report(root: string, sessionId: string): Promise<GuideCall> {
  return call(root, { action: "report", sessionId, report: { completedAction: "issue_fixed" } });
}

export function resume(root: string, sessionId: string): Promise<GuideCall> {
  return call(root, { action: "resume", sessionId });
}

export function cancel(root: string, sessionId: string): Promise<GuideCall> {
  return call(root, { action: "cancel", sessionId });
}
