/**
 * ISS-958 5b: the non-COMPACT reverted crash image, with and without the
 * shutdown marker a TC tail writes.
 *
 * The image: a terminal write published, the TC tail wrote the shutdown
 * marker (which also unlinks sidecar.pid), then state.json reverted to the
 * active non-COMPACT preimage. Its twin is the base post-reboot image with no
 * marker: a stale alive file and a dead sidecar pid.
 *
 * What the marker changes (pen ruling (a), Codex-confirmed): the owner
 * liveness verdict is `undetermined` with the marker ("sidecar process
 * identity (no-pid)", because the marker unlinked sidecar.pid) and
 * `gone-candidate` without it. The only consumers of that verdict are the
 * foreign owner-gone candidate takeover and cancel, so the marker image loses
 * exactly that handshake. The guard verdict is the same in all four cells, and
 * recovery stays open:
 *   (a) the owner continues through `report`, or cancels (resume applies only
 *       to an eligible COMPACT session and is refused here);
 *   (b) any task starts a new session, which supersedes this one because its
 *       recorded MCP server pid is dead;
 *   (c) `storybloq session stop <id>`.
 *
 * Reachability: at this head, ordinary writes have no durability barrier yet,
 * so a successful write keeps base's crash exposure (the image is no more
 * reachable than at base; no reduction is claimed). The TC tails write the
 * marker only after a post-rename typed error, where base wrote it after the
 * same rename. Base 84f45034 reaches this image too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateSessionGuard } from "../../src/core/session-guard.js";
import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { collectProbes } from "../../src/autonomous/health-model.js";
import {
  OWNER_STALE_MS,
  discardStagedGeneration,
  newHeartbeatGenerationId,
  readOwnerLiveness,
  stageHeartbeatGeneration,
  telemetryDirPath,
  writeShutdownMarker,
} from "../../src/autonomous/liveness.js";
import { createSession, readSession, writeSessionSync } from "../../src/autonomous/session.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";

const OWNER = { client: "claude" as const, id: "owner-task-958", boundAt: "2026-10-01T00:00:00.000Z" };
const FOREIGN = "foreign-task-958";
const ENV_KEYS = ["STORYBLOQ_GLOBAL_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "STORYBLOQ_CLIENT"];

const roots: string[] = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const global = mkdtempSync(join(tmpdir(), "iss958-s5-global-"));
  roots.push(global);
  process.env.STORYBLOQ_GLOBAL_DIR = global;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.STORYBLOQ_CLIENT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  while (roots.length) {
    const root = roots.pop()!;
    killSidecarsInRoot(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function deadPid(): number {
  for (let candidate = 900_000; candidate < 900_200; candidate++) {
    try { process.kill(candidate, 0); } catch (e: any) {
      if (e?.code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead pid for the fixture");
}

/** The base post-reboot image of an active IMPLEMENT session. */
function image(withMarker: boolean): { root: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iss958-s5-image-")));
  roots.push(root);
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss958-s5", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "iss958", date: "2026-10-04",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));

  const stale = new Date(Date.now() - 2 * 3_600_000);
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const dir = join(story, "sessions", session.sessionId);
  writeSessionSync(dir, {
    ...session,
    state: "IMPLEMENT",
    status: "active",
    ownerTask: OWNER,
    mcpServerPid: deadPid(),
    mcpGuideCallAt: stale.toISOString(),
    lastGuideCall: stale.toISOString(),
    lease: { ...session.lease, lastHeartbeat: stale.toISOString(), expiresAt: new Date(stale.getTime() + 45 * 60_000).toISOString() },
  } as FullSessionState);

  const tDir = telemetryDirPath(dir);
  mkdirSync(tDir, { recursive: true });
  const alive = join(tDir, "alive");
  writeFileSync(alive, String(stale.getTime()));
  utimesSync(alive, stale, stale);
  writeFileSync(join(tDir, "sidecar.pid"), String(deadPid()));

  if (withMarker) writeShutdownMarker(dir);
  return { root, dir };
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

function shutdownMarked(dir: string): boolean {
  const p = join(telemetryDirPath(dir), "shutdown");
  return existsSync(p) && readFileSync(p, "utf-8") === "1";
}

function verdicts(withMarker: boolean): Record<string, unknown> {
  const { root, dir } = image(withMarker);
  const liveness = readOwnerLiveness(
    dir,
    () => readSession(dir)!,
    Date.now(),
    OWNER_STALE_MS,
    () => ({ kind: "observed", servers: [] }),
  );
  const owner = evaluateSessionGuard(root, { clientTaskId: OWNER.id, client: "claude" });
  const foreign = evaluateSessionGuard(root, { clientTaskId: FOREIGN, client: "claude" });
  return {
    liveness: liveness.kind,
    missing: liveness.kind === "undetermined" ? liveness.missing : null,
    ownerGuard: owner.overallAction,
    foreignGuard: foreign.overallAction,
  };
}

describe("ISS-958 5b: non-COMPACT reverted image, verdicts with and without the shutdown marker", () => {
  it("pins the owner-liveness difference and the equal guard verdicts across all four cells", () => {
    expect({ withMarker: verdicts(true), without: verdicts(false) }).toEqual({
      withMarker: {
        liveness: "undetermined",
        missing: ["sidecar process identity (no-pid)"],
        ownerGuard: "free",
        foreignGuard: "free",
      },
      without: { liveness: "gone-candidate", missing: null, ownerGuard: "free", foreignGuard: "free" },
    });
  });

  it.each([true, false])("a foreign start supersedes the session the same way (marker %s)", async (withMarker) => {
    const { root, dir } = image(withMarker);
    process.env.CLAUDE_CODE_SESSION_ID = FOREIGN;
    await handleAutonomousGuide(root, { action: "start", sessionId: null, clientTaskId: FOREIGN });
    const after = readSession(dir)!;
    expect(after.status).toBe("superseded");
    expect(shutdownMarked(dir)).toBe(true);
  });

  it.each([true, false])("the owner continues through report, not refused by any gate (marker %s)", async (withMarker) => {
    const { root, dir } = image(withMarker);
    const before = readSession(dir)!;
    process.env.CLAUDE_CODE_SESSION_ID = OWNER.id;
    const result = await handleAutonomousGuide(root, {
      action: "report", sessionId: before.sessionId, clientTaskId: OWNER.id,
      report: { completedAction: "implementation_done" },
    });
    expect(textOf(result)).not.toContain("Cannot report progress");
    const after = readSession(dir)!;
    expect(after.status).toBe("active");
    expect(after.ownerTask?.id).toBe(OWNER.id);
    expect(Date.parse(after.lease.lastHeartbeat)).toBeGreaterThan(Date.parse(before.lease.lastHeartbeat));
  });

  it("the owner cannot resume the non-COMPACT image: refused, pointed at report", async () => {
    const { root, dir } = image(true);
    const before = readSession(dir)!;
    process.env.CLAUDE_CODE_SESSION_ID = OWNER.id;
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: before.sessionId, clientTaskId: OWNER.id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      `Session ${before.sessionId} is not in COMPACT state (current: IMPLEMENT). Use action: "report" to continue.`,
    );
    expect(readSession(dir)!.revision).toBe(before.revision);
  });
});

describe("ISS-958 5c.1: health reads the canonical state before a stale ended marker", () => {
  function endedBeside(status: "active" | "superseded", state: string): string {
    const { dir } = image(false);
    const s = readSession(dir)!;
    writeSessionSync(dir, { ...s, status, state } as FullSessionState);
    writeFileSync(join(telemetryDirPath(dir), "ended"), JSON.stringify({ reason: "normal", timestamp: new Date().toISOString() }));
    return dir;
  }
  const read = (dir: string) => readSession(dir) as unknown as Record<string, unknown>;

  it("an active, non-terminal canonical is not ended, whatever the marker says", () => {
    const dir = endedBeside("active", "IMPLEMENT");
    expect(collectProbes(dir, Date.now(), read(dir)).notEnded).toBe(true);
  });

  it("a terminal canonical keeps the marker's answer", () => {
    const sup = endedBeside("superseded", "IMPLEMENT");
    expect(collectProbes(sup, Date.now(), read(sup)).notEnded).toBe(false);
    const fin = endedBeside("active", "SESSION_END");
    expect(collectProbes(fin, Date.now(), read(fin)).notEnded).toBe(false);
  });

  it("an unreadable canonical keeps the existence check", () => {
    const dir = endedBeside("active", "IMPLEMENT");
    expect(collectProbes(dir, Date.now(), null).notEnded).toBe(false);
  });

  it("a generation-backed session reads the same session-level marker", () => {
    const dir = endedBeside("active", "IMPLEMENT");
    const s = readSession(dir)!;
    writeSessionSync(dir, { ...s, heartbeatGeneration: newHeartbeatGenerationId() } as FullSessionState);
    expect(collectProbes(dir, Date.now(), read(dir)).notEnded).toBe(true);
  });

  it("an unsuccessful takeover staging leaves the session-level marker and the verdict untouched", () => {
    const dir = endedBeside("active", "IMPLEMENT");
    const marker = readFileSync(join(telemetryDirPath(dir), "ended"), "utf-8");
    const staged = stageHeartbeatGeneration(dir, { intervalMs: 50, readinessTimeoutMs: 2_000, pollMs: 25 });
    expect(staged).not.toBeNull();
    discardStagedGeneration(staged!);
    expect(readFileSync(join(telemetryDirPath(dir), "ended"), "utf-8")).toBe(marker);
    expect(collectProbes(dir, Date.now(), read(dir)).notEnded).toBe(true);
  });
});
