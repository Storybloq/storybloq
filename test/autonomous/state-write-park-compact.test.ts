/**
 * ISS-958 S4: the CLI hooks, the admin commands and the retired park when a
 * state write is published but its durability is unproven.
 *
 *   - retired park (policy TR): the published normalization is recorded with
 *     exactly the success path's arguments, then refused truthfully; a retry
 *     finds nothing to do and records nothing.
 *   - clear-compact invalid branch (TP8) and session stop (TP9), policy TC:
 *     the ended session's tail runs against the published state, then the
 *     typed error propagates.
 *   - compact-prepare (:185, T/A): a published compactPending still gets its
 *     resume marker.
 *   - resume-prompt (:715, A): a published observation still gets its event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { wrapFs } = await import("./_state-write-fault.js");
  return wrapFs(actual);
});

vi.mock("../../src/autonomous/git-inspector.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, gitHead: vi.fn(), gitDiffTreeNames: vi.fn(), gitIsAncestor: vi.fn() };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitDiffTreeNames, gitHead, gitIsAncestor } from "../../src/autonomous/git-inspector.js";
import { telemetryDirPath } from "../../src/autonomous/liveness.js";
import { writeResumeMarker } from "../../src/autonomous/resume-marker.js";
import { normalizeRetiredLimitPark } from "../../src/autonomous/retired-limit-park.js";
import {
  StateWriteUndurableError,
  createSession,
  readSession,
  withoutLimitKeys,
  writeSessionSync,
} from "../../src/autonomous/session.js";
import { deriveWorkspaceId, parseSessionState, type FullSessionState } from "../../src/autonomous/session-types.js";
import {
  handleSessionClearCompact,
  handleSessionCompactPrepare,
  handleSessionResumePrompt,
  handleSessionStop,
} from "../../src/cli/commands/session-compact.js";
import { armFail, armUndurable, disarm, faultFired } from "./_state-write-fault.js";

const head = vi.mocked(gitHead);
const tree = vi.mocked(gitDiffTreeNames);
const ancestor = vi.mocked(gitIsAncestor);
const BASE = "b".repeat(40);
const MOVED = "a".repeat(40);
const SID = "11111111-2222-4333-8444-555555555555";

const LIMIT = {
  interruptionKind: "limit",
  limitStopPending: true,
  limitResumeAt: Date.parse("2026-09-01T00:00:00.000Z"),
  limitPermissionMode: "bypassPermissions",
  limitEventId: "evt-1",
};
const LIMIT_KEY_NAMES = Object.keys(LIMIT);

const roots: string[] = [];
let globalDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_PROJECT_ROOT", "CLAUDESTORY_PROJECT_ROOT", "CLAUDE_CODE_SESSION_ID"];

beforeEach(() => {
  globalDir = mkdtempSync(join(tmpdir(), "iss958-s4-global-"));
  roots.push(globalDir);
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  delete process.env.STORYBLOQ_PROJECT_ROOT;
  delete process.env.CLAUDESTORY_PROJECT_ROOT;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  head.mockReset();
  tree.mockReset();
  ancestor.mockReset();
  head.mockResolvedValue({ ok: true, data: { hash: BASE } } as never);
});

afterEach(() => {
  disarm();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iss958-s4-")));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ name: "test" }));
  roots.push(root);
  return root;
}

/** Plant a session, then overwrite state.json with raw keys (no schema defaults). */
function plant(root: string, fields: Record<string, unknown>): { id: string; dir: string } {
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const dir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(dir, { ...session, ticket: { id: "T-001", title: "t", risk: "low", claimed: true } } as never);
  const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...withoutLimitKeys(raw), ...fields };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  expect(parseSessionState(next).success).toBe(true);
  writeFileSync(join(dir, "state.json"), JSON.stringify(next, null, 2) + "\n");
  return { id: session.sessionId, dir };
}

const park = (over: Record<string, unknown> = {}) => ({
  state: "COMPACT",
  compactPending: true,
  preCompactState: "IMPLEMENT",
  compactPreparedAt: "2026-09-01T00:00:00.000Z",
  git: { branch: "main", mergeBase: BASE, initHead: BASE, expectedHead: BASE, itemBaseHead: BASE },
  ...LIMIT,
  ...over,
});
const finalize = (over: Record<string, unknown> = {}) => park({ preCompactState: "FINALIZE", finalizeCheckpoint: null, ...over });

function events(dir: string, type: string): Array<Record<string, unknown>> {
  const p = join(dir, "events.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

const raw = (dir: string) => JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as Record<string, unknown>;
const limitKeysOf = (dir: string) => Object.keys(raw(dir)).filter((k) => LIMIT_KEY_NAMES.includes(k));

function armTyped(dir: string): void {
  armUndurable(
    (published) => new StateWriteUndurableError(published as FullSessionState, new Error("EIO: injected dir fsync failure")),
    (d) => readSession(d),
    { dir },
  );
}

function shutdownMarked(dir: string): boolean {
  const t = telemetryDirPath(dir);
  return existsSync(join(t, "shutdown")) && readFileSync(join(t, "shutdown"), "utf-8") === "1"
    && readFileSync(join(t, "alive"), "utf-8") === "0";
}

const markerPath = (root: string) => join(root, ".claude", "rules", "autonomous-resume.md");

// ---------------------------------------------------------------------------
// Retired park, TR (section 1d)
// ---------------------------------------------------------------------------

const parkCases: Array<[string, Record<string, unknown>, () => void]> = [
  ["stripped", { state: "IMPLEMENT", interruptionKind: null, limitStopPending: false, limitPermissionMode: null }, () => {}],
  ["compact-park", park(), () => {}],
  ["finalize-kept", finalize({ finalizeCheckpoint: "committed" }), () => {}],
  ["finalize-recovered", finalize({ finalizeCheckpoint: "precommit_passed" }), () => {
    head.mockResolvedValue({ ok: true, data: { hash: MOVED } } as never);
    tree.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] } as never);
    ancestor.mockResolvedValue({ ok: true, data: false } as never);
  }],
];

describe.each(parkCases)("ISS-958 S4: retired park %s (policy TR)", (transition, fields, arrange) => {
  it("records the published normalization once, refuses truthfully, and a retry records nothing", async () => {
    // The success path on a twin fixture fixes the exact record to expect.
    const twinRoot = project();
    const twin = plant(twinRoot, fields);
    arrange();
    const ok = await normalizeRetiredLimitPark(twinRoot, twin.id, { globalDir });
    expect(ok).toMatchObject({ kind: "normalized", transition });
    const [expected] = events(twin.dir, "limit_park_retired");

    const root = project();
    const { id, dir } = plant(root, fields);
    arrange();
    armTyped(dir);
    const r = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(faultFired()).toBe(true);
    expect(r.kind).toBe("failed");
    const published = readSession(dir)!;
    if (r.kind === "failed") {
      expect(r.reason).toContain(`normalization published at revision ${published.revision}`);
      expect(r.reason).toContain("retry is safe");
    }
    expect(limitKeysOf(dir)).toEqual([]);
    const recorded = events(dir, "limit_park_retired");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.rev).toBe(published.revision);
    expect(recorded[0]!.data).toEqual(expected!.data);

    disarm();
    const retry = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(retry.kind).toBe("unchanged");
    expect(events(dir, "limit_park_retired")).toHaveLength(1);
  });

  it("a pre-rename failure records nothing and keeps the generic refusal", async () => {
    const root = project();
    const { id, dir } = plant(root, fields);
    arrange();
    armFail({ dir });
    const r = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(faultFired()).toBe(true);
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("write failed");
    expect(events(dir, "limit_park_retired")).toEqual([]);
    expect(limitKeysOf(dir).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TP8 clear-compact invalid branch and TP9 session stop (TC)
// ---------------------------------------------------------------------------

const tails = [
  {
    name: "TP8 clear-compact, invalid preCompactState",
    event: "admin_recovery",
    fields: { state: "COMPACT", compactPending: true, preCompactState: null, compactPreparedAt: "2026-09-01T00:00:00.000Z" },
    run: (root: string, id: string) => handleSessionClearCompact(root, id),
  },
  {
    name: "TP9 session stop",
    event: "admin_stop",
    fields: { state: "IMPLEMENT", ticket: undefined },
    run: (root: string, id: string) => handleSessionStop(root, id),
  },
] as const;

describe.each(tails)("ISS-958 S4: $name (policy TC)", ({ event, fields, run }) => {
  it("undurable: the tail runs against the published state, then the typed error propagates", async () => {
    const root = project();
    const { id, dir } = plant(root, fields);
    writeResumeMarker(root, id, { ticket: undefined, completedTickets: [], resolvedIssues: [], preCompactState: "IMPLEMENT" } as never);
    expect(existsSync(markerPath(root))).toBe(true);

    armTyped(dir);
    await expect(run(root, id)).rejects.toBeInstanceOf(StateWriteUndurableError);
    expect(faultFired()).toBe(true);
    const published = readSession(dir)!;
    expect(published.state).toBe("SESSION_END");
    expect(published.status).toBe("completed");
    expect(shutdownMarked(dir)).toBe(true);
    const recorded = events(dir, event);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.rev).toBe(published.revision);
    expect(existsSync(markerPath(root))).toBe(false);
  });

  it("a pre-rename failure runs none of the tail", async () => {
    const root = project();
    const { id, dir } = plant(root, fields);
    writeResumeMarker(root, id, { ticket: undefined, completedTickets: [], resolvedIssues: [], preCompactState: "IMPLEMENT" } as never);

    armFail({ dir });
    const err = await run(root, id).then(() => null, (e: unknown) => e);
    expect(faultFired()).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StateWriteUndurableError);
    expect(readSession(dir)!.state).toBe(fields.state);
    expect(shutdownMarked(dir)).toBe(false);
    expect(events(dir, event)).toEqual([]);
    expect(existsSync(markerPath(root))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compact-prepare :185 (T/A) and resume-prompt :715 (A)
// ---------------------------------------------------------------------------

function owned(root: string, fields: Record<string, unknown>): { id: string; dir: string } {
  return plant(root, {
    ownerTask: { client: "claude", id: SID, boundAt: "2026-09-24T00:00:00Z" },
    lease: {
      workspaceId: deriveWorkspaceId(root),
      lastHeartbeat: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    },
    ...fields,
  });
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return await fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("ISS-958 S4: compact-prepare keeps the resume marker of a published park (:185)", () => {
  it("undurable: compactPending is published and the resume marker is written", async () => {
    const root = project();
    const { dir } = owned(root, { state: "IMPLEMENT" });
    armTyped(dir);
    await quietly(() => handleSessionCompactPrepare({ client: "claude", clientTaskId: SID, cwd: root }));
    expect(faultFired()).toBe(true);
    const s = readSession(dir)!;
    expect(s.state).toBe("COMPACT");
    expect(s.compactPending).toBe(true);
    expect(existsSync(markerPath(root))).toBe(true);
  });

  it("a pre-rename failure writes no marker, as before", async () => {
    const root = project();
    const { dir } = owned(root, { state: "IMPLEMENT" });
    armFail({ dir });
    await quietly(() => handleSessionCompactPrepare({ client: "claude", clientTaskId: SID, cwd: root }));
    expect(faultFired()).toBe(true);
    expect(readSession(dir)!.state).toBe("IMPLEMENT");
    expect(existsSync(markerPath(root))).toBe(false);
  });
});

describe("ISS-958 S4: resume-prompt records a published compaction observation (:715)", () => {
  const compact = { state: "COMPACT", compactPending: true, preCompactState: "IMPLEMENT", compactPreparedAt: new Date().toISOString() };

  it("undurable: the observation is published and its event appended once at the published revision", async () => {
    const root = project();
    const { dir } = owned(root, compact);
    armTyped(dir);
    await quietly(() => handleSessionResumePrompt({ source: "compact", clientTaskId: SID, cwd: root }));
    expect(faultFired()).toBe(true);
    const s = readSession(dir)!;
    expect(s.compactObservedAt).toBeTruthy();
    const recorded = events(dir, "client_compaction_observed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.rev).toBe(s.revision);
  });

  it("a pre-rename failure appends no event, as before", async () => {
    const root = project();
    const { dir } = owned(root, compact);
    armFail({ dir });
    await quietly(() => handleSessionResumePrompt({ source: "compact", clientTaskId: SID, cwd: root }));
    expect(faultFired()).toBe(true);
    expect(readSession(dir)!.compactObservedAt ?? null).toBeNull();
    expect(events(dir, "client_compaction_observed")).toEqual([]);
  });
});
