/**
 * ISS-1307: a subagent's compaction must not move the parent's autonomous
 * session. Inside a subagent, Claude Code fires PreCompact and
 * SessionStart(compact) with the parent's session_id and transcript_path.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { readSession, withSessionLock, writeSessionSync } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import {
  handleSessionCompactPrepare,
  handleSessionResumePrompt,
  readHookStdinContext,
} from "../../src/cli/commands/session-compact.js";
import { handleSessionIntelStart } from "../../src/cli/commands/session-intel.js";
import type { ClassifyOptions } from "../../src/autonomous/subagent-compaction.js";
import { readPresenceRecord } from "../../src/core/session-intel/presence-bridge.js";

// Loaded lazily so the handler tests run (and fail on behaviour) against a
// tree that predates the module.
const subagentCompaction = () => import("../../src/autonomous/subagent-compaction.js");

const SID = "11111111-2222-4333-8444-555555555555";
const AUTO_SESSION = "00000000-0000-0000-0000-000000000041";
const MODEL = "claude-opus-5-5";
const PRE = 100_000;

// ---------------------------------------------------------------------------
// Transcript record builders
// ---------------------------------------------------------------------------

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function assistant(tokens: number, o: { sid?: string; sidechain?: boolean; model?: string; synthetic?: boolean; apiError?: boolean; noUsage?: boolean; usage?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: o.sid ?? SID,
    isSidechain: o.sidechain ?? false,
    timestamp: iso(),
    ...(o.apiError ? { isApiErrorMessage: true } : {}),
    message: {
      role: "assistant",
      model: o.synthetic ? "<synthetic>" : o.model ?? MODEL,
      ...(o.noUsage ? {} : { usage: o.usage ?? { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 2 } }),
      content: [{ type: "text", text: "ok" }],
    },
  });
}

function boundary(o: { pre?: number | null; trigger?: string; ts?: string; sid?: string; sidechain?: boolean } = {}): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    sessionId: o.sid ?? SID,
    isSidechain: o.sidechain ?? false,
    timestamp: o.ts ?? iso(-60 * 60_000),
    compactMetadata: {
      trigger: o.trigger ?? "auto",
      ...(o.pre === null ? {} : { preTokens: o.pre ?? PRE }),
    },
  });
}

function userText(text: string, sid = SID): string {
  return JSON.stringify({ type: "user", sessionId: sid, isSidechain: false, timestamp: iso(), message: { role: "user", content: text } });
}

function modelChange(): string {
  return JSON.stringify({
    type: "system",
    subtype: "local_command",
    sessionId: SID,
    isSidechain: false,
    timestamp: iso(),
    content: "<local-command-stdout>Set model to `Sonnet 5` and saved as your default</local-command-stdout>",
  });
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Never expires: the handler tests must not depend on machine load. The cap itself is pinned with an expired deadline. */
const LIVE = { expired: () => false };

/** Unexpired for its first `n` checks and expired from then on: the deadline passes during the work after check `n`. */
function expiresAfter(n: number): { expired(): boolean; checks(): number } {
  let checks = 0;
  return { expired: () => ++checks > n, checks: () => checks };
}

interface Fixture {
  readonly root: string;
  readonly projects: string;
  readonly transcript: string;
  readonly subagents: string;
  readonly classify: ClassifyOptions;
}

async function makeFixture(): Promise<Fixture> {
  const tmp = await mkdtemp(join(tmpdir(), "storybloq-iss1307-"));
  roots.push(tmp);
  const root = realpathSync(tmp);
  mkdirSync(join(root, ".story"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ name: "test" }), "utf-8");
  const projects = join(root, "claude-projects");
  const proj = join(projects, "-proj");
  mkdirSync(proj, { recursive: true });
  return {
    root,
    projects,
    transcript: join(proj, `${SID}.jsonl`),
    subagents: join(proj, SID, "subagents"),
    classify: { projectsDir: projects, deadline: LIVE },
  };
}

function writeTranscript(f: Fixture, lines: string[], trailing = ""): void {
  writeFileSync(f.transcript, lines.join("\n") + "\n" + trailing, "utf-8");
}

/** A main-thread transcript whose fill is `tokens / PRE` exactly. */
function writeFill(f: Fixture, tokens: number, extra: { before?: string[]; after?: string[] } = {}): void {
  writeTranscript(f, [
    userText("earlier cycle"),
    boundary(),
    ...(extra.before ?? []),
    userText("go"),
    assistant(tokens),
    ...(extra.after ?? []),
  ]);
}

function writeSubagent(f: Fixture, o: { name?: string; withBoundary?: boolean; boundaryTs?: string; mtimeMs?: number } = {}): string {
  mkdirSync(f.subagents, { recursive: true });
  const path = join(f.subagents, o.name ?? "agent-a5737e549e70815f4.jsonl");
  const lines = [
    JSON.stringify({ type: "user", sessionId: SID, agentId: "a5737e549e70815f4", isSidechain: true, timestamp: iso(-30_000), message: { role: "user", content: "task" } }),
    ...(o.withBoundary ? [boundary({ sidechain: true, ts: o.boundaryTs ?? iso(-1_000) })] : []),
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  if (o.mtimeMs !== undefined) utimesSync(path, o.mtimeMs / 1000, o.mtimeMs / 1000);
  return path;
}

function plantSession(
  f: Fixture,
  o: { state?: string; compactPending?: boolean; owner?: string; sessionId?: string } = {},
): string {
  const sessionId = o.sessionId ?? AUTO_SESSION;
  const dir = join(f.root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const compact = o.compactPending === true;
  writeSessionSync(dir, {
    schemaVersion: 1,
    sessionId,
    recipe: "coding",
    state: o.state ?? (compact ? "COMPACT" : "IMPLEMENT"),
    revision: 7,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: f.root, lastHeartbeat: now, expiresAt: new Date(Date.now() + 45 * 60_000).toISOString() },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: compact ? "IMPLEMENT" : null,
    compactPending: compact,
    compactPreparedAt: compact ? now : null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    ownerTask: { client: "claude", id: o.owner ?? SID, boundAt: "2026-09-24T00:00:00Z" },
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  } as unknown as FullSessionState);
  return dir;
}

function events(dir: string, type = "subagent_compaction_ignored"): Array<Record<string, unknown>> {
  const path = join(dir, "events.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

const pendingDir = (f: Fixture): string => join(f.root, ".story", "telemetry", "session-intel-pending");
const markerDir = (f: Fixture): string => join(f.root, ".claude", "rules");

/**
 * Runs a hook handler inside the fixture, with the global storybloq dir
 * pointed into the fixture.
 */
async function inRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const env = {
    STORYBLOQ_PROJECT_ROOT: undefined,
    CLAUDESTORY_PROJECT_ROOT: undefined,
    STORYBLOQ_GLOBAL_DIR: join(root, ".global"),
  } as const;
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    apply(env);
    process.chdir(root);
    return await fn();
  } finally {
    process.chdir(cwd);
    apply(saved);
  }
}

async function preCompact(
  f: Fixture,
  o: Partial<Parameters<typeof handleSessionCompactPrepare>[0]> = {},
): Promise<void> {
  await inRoot(f.root, () => handleSessionCompactPrepare({
    client: "claude",
    clientTaskId: SID,
    transcriptPath: f.transcript,
    trigger: "auto",
    classify: f.classify,
    ...o,
  }));
}

async function sessionStart(
  f: Fixture,
  o: Partial<Parameters<typeof handleSessionResumePrompt>[0]> = {},
): Promise<string> {
  const chunks: string[] = [];
  const oldWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await inRoot(f.root, () => handleSessionResumePrompt({
      source: "compact",
      clientTaskId: SID,
      transcriptPath: f.transcript,
      classify: f.classify,
      ...o,
    }));
  } finally {
    process.stdout.write = oldWrite;
  }
  return chunks.join("");
}

function expectUntouched(dir: string): void {
  const s = readSession(dir)!;
  expect(s.state).toBe("IMPLEMENT");
  expect(s.compactPending).toBe(false);
}

function expectCompacted(dir: string): void {
  const s = readSession(dir)!;
  expect(s.state).toBe("COMPACT");
  expect(s.compactPending).toBe(true);
}

async function stdin(payload: unknown): Promise<Awaited<ReturnType<typeof readHookStdinContext>>> {
  const stream = new PassThrough();
  const p = readHookStdinContext(stream, 500);
  stream.end(JSON.stringify(payload));
  return p;
}

// ---------------------------------------------------------------------------
// 1-4: hook stdin
// ---------------------------------------------------------------------------

describe("readHookStdinContext subagent signals (ISS-1307)", () => {
  it("1: agent_id gives subagent.agentId", async () => {
    const ctx = await stdin({ session_id: SID, agent_id: "a5737e549e70815f4", hook_event_name: "PreCompact" });
    expect(ctx.agentId).toBe("a5737e549e70815f4");
    expect(ctx.subagent).toEqual({ agentId: "a5737e549e70815f4", viaTranscriptPath: false });
  });

  it("2: a subagents/agent-*.jsonl transcript_path gives viaTranscriptPath", async () => {
    const ctx = await stdin({ session_id: SID, transcript_path: `/Users/u/.claude/projects/-p/${SID}/subagents/agent-a1.jsonl` });
    expect(ctx.subagent).toEqual({ viaTranscriptPath: true });
    const win = await stdin({ session_id: SID, transcript_path: `C:\\u\\.claude\\projects\\p\\${SID}\\subagents\\agent-a1.jsonl` });
    expect(win.subagent).toEqual({ viaTranscriptPath: true });
    // A segment that merely contains the word, or a non-agent basename, is not the signal.
    const near = await stdin({ session_id: SID, transcript_path: `/x/my-subagents/agent-a1.jsonl` });
    expect(near.subagent).toBeUndefined();
    const main = await stdin({ session_id: SID, transcript_path: `/x/subagents/${SID}.jsonl` });
    expect(main.subagent).toBeUndefined();
  });

  it("3: agent_type alone is never a subagent signal", async () => {
    const ctx = await stdin({ session_id: SID, agent_type: "reviewer", transcript_path: `/x/-p/${SID}.jsonl`, trigger: "auto" });
    expect(ctx.subagent).toBeUndefined();
    expect(ctx.agentId).toBeUndefined();
  });

  it("4: trigger is parsed; a malformed agent_id is dropped", async () => {
    const ctx = await stdin({ session_id: SID, trigger: "auto" });
    expect(ctx.trigger).toBe("auto");
    expect((await stdin({ agent_id: "" })).subagent).toBeUndefined();
    expect((await stdin({ agent_id: 42 })).subagent).toBeUndefined();
    expect((await stdin({ agent_id: "a".repeat(257) })).subagent).toBeUndefined();
    expect((await stdin({ agent_id: "a".repeat(256) })).agentId).toHaveLength(256);
    expect((await stdin({ trigger: "x".repeat(33) })).trigger).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5-11: PreCompact
// ---------------------------------------------------------------------------

describe("session compact-prepare, subagent guard (ISS-1307)", () => {
  it("5: agent_id leaves the session, marker and intel untouched and records the event", async () => {
    const f = await makeFixture();
    const dir = plantSession(f);
    await preCompact(f, { subagent: { agentId: "a5737e549e70815f4", viaTranscriptPath: false } });
    expectUntouched(dir);
    expect(filesUnder(markerDir(f))).toEqual([]);
    expect(filesUnder(pendingDir(f))).toEqual([]);
    const ev = events(dir);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ rev: readSession(dir)!.revision, data: { hook: "pre_compact", signal: "agent_id", agentId: "a5737e549e70815f4", fill: null, trigger: "auto" } });
  });

  it("6: a subagents transcript_path alone is sufficient", async () => {
    const f = await makeFixture();
    const dir = plantSession(f);
    await preCompact(f, { subagent: { viaTranscriptPath: true } });
    expectUntouched(dir);
    expect(events(dir)[0]).toMatchObject({ data: { signal: "transcript_path", agentId: null } });
  });

  it("7: neither signal compacts as today and publishes the intel pending mark", async () => {
    const f = await makeFixture();
    const dir = plantSession(f);
    writeFill(f, 90_000);
    await preCompact(f);
    expectCompacted(dir);
    expect(filesUnder(markerDir(f)).length).toBeGreaterThan(0);
    // Positive control for test 5: the fixture has presence and intel on.
    expect(filesUnder(pendingDir(f)).length).toBeGreaterThan(0);
    expect(events(dir)).toEqual([]);
  });

  it("8: a --agent main session (agent_type only) compacts", async () => {
    const f = await makeFixture();
    const dir = plantSession(f);
    writeFill(f, 90_000);
    writeSubagent(f);
    await preCompact(f, { subagent: undefined });
    expectCompacted(dir);
  });

  it("9: pins both sides of the fill threshold", async () => {
    expect((await subagentCompaction()).SUBAGENT_FILL_THRESHOLD).toBe(0.6);
    const f = await makeFixture();
    const dir = plantSession(f);
    writeSubagent(f);
    writeFill(f, 59_000);
    await preCompact(f);
    expectUntouched(dir);
    expect(filesUnder(pendingDir(f))).toEqual([]);
    expect(events(dir)[0]).toMatchObject({ data: { hook: "pre_compact", signal: "fill", fill: 0.59, agentId: "a5737e549e70815f4" } });

    writeFill(f, 60_000);
    await preCompact(f);
    expectCompacted(dir);
  });

  describe("10: every doubt case compacts as today", () => {
    const cases: Array<[string, (f: Fixture) => void, Partial<Parameters<typeof handleSessionCompactPrepare>[0]>?]> = [
      ["trigger manual", (f) => writeFill(f, 30_000), { trigger: "manual" }],
      ["trigger missing", (f) => writeFill(f, 30_000), { trigger: undefined }],
      ["no prior boundary", (f) => writeTranscript(f, [userText("go"), assistant(30_000)])],
      ["last boundary manual", (f) => writeTranscript(f, [boundary({ trigger: "manual" }), assistant(30_000)])],
      ["preTokens absent", (f) => writeTranscript(f, [boundary({ pre: null }), assistant(30_000)])],
      ["preTokens zero", (f) => writeTranscript(f, [boundary({ pre: 0 }), assistant(30_000)])],
      ["no usage after the boundary", (f) => writeTranscript(f, [assistant(30_000), boundary(), userText("go")])],
      ["transcript missing", () => undefined],
      ["transcript a symlink", (f) => {
        const target = join(f.projects, "-proj", "real.jsonl");
        writeFileSync(target, [boundary(), assistant(30_000)].join("\n") + "\n");
        symlinkSync(target, f.transcript);
      }],
      ["transcript outside projectsDir", (f) => writeFill(f, 30_000), { classify: { projectsDir: "/nonexistent-projects" } }],
      ["malformed lines only", (f) => writeTranscript(f, ["{not json", "also not json"])],
      ["model change record after the boundary", (f) => writeFill(f, 30_000, { before: [modelChange()] })],
      ["a different model before the newest usage", (f) => writeTranscript(f, [boundary(), assistant(20_000, { model: "claude-sonnet-5" }), assistant(30_000)])],
      ["byte cap", (f) => writeFill(f, 30_000, { before: Array.from({ length: 64 }, (_, i) => userText(`filler ${i} ${"x".repeat(64)}`)) }), { classify: { maxBytes: 1024, chunkBytes: 256 } }],
      ["time cap", (f) => writeFill(f, 30_000), { classify: { deadline: { expired: () => true } } }],
      ["no active subagent", (f) => writeFill(f, 30_000)],
      ["tail bytes lift fill to 0.6 or above", (f) => writeFill(f, 50_000, { after: [userText("t".repeat(40_000))] })],
    ];
    for (const [name, arrange, extra] of cases) {
      it(name, async () => {
        const f = await makeFixture();
        const dir = plantSession(f);
        arrange(f);
        if (name !== "no active subagent") writeSubagent(f);
        const classify = extra?.classify ? { ...f.classify, ...extra.classify } : f.classify;
        await preCompact(f, { ...extra, classify });
        expectCompacted(dir);
        expect(events(dir)).toEqual([]);
      });
    }
  });

  it("11: the event goes only to the caller's own session", async () => {
    const f = await makeFixture();
    const dir = plantSession(f, { owner: "another-live-task" });
    await preCompact(f, { subagent: { agentId: "a1", viaTranscriptPath: false } });
    expectUntouched(dir);
    expect(events(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12-16: SessionStart
// ---------------------------------------------------------------------------

describe("session resume-prompt, subagent guard (ISS-1307)", () => {
  it("12: agent_id prints nothing and leaves a COMPACT session unobserved", async () => {
    const f = await makeFixture();
    const dir = plantSession(f, { compactPending: true });
    const out = await sessionStart(f, { subagent: { agentId: "a1", viaTranscriptPath: false } });
    expect(out).toBe("");
    expect(readSession(dir)?.compactObservedAt ?? null).toBeNull();
    expect(events(dir, "client_compaction_observed")).toEqual([]);
    expect(events(dir)[0]).toMatchObject({ data: { hook: "session_start", signal: "agent_id", source: "compact" } });
  });

  it("13: a transcript_path signal with no autonomous session prints no breadcrumb", async () => {
    const f = await makeFixture();
    const out = await sessionStart(f, { subagent: { viaTranscriptPath: true } });
    expect(out).toBe("");
    // No session, so no lock and no sessions directory is created for the event.
    expect(existsSync(join(f.root, ".story", "sessions"))).toBe(false);
  });

  it("14: low fill with a fresh subagent boundary and no resumable session prints nothing", async () => {
    const f = await makeFixture();
    const dir = plantSession(f);
    writeFill(f, 35_000);
    writeSubagent(f, { withBoundary: true });
    const out = await sessionStart(f);
    expect(out).toBe("");
    expect(events(dir)[0]).toMatchObject({ data: { hook: "session_start", signal: "fill", fill: 0.35, agentId: "a5737e549e70815f4" } });
  });

  it("15: low fill without a fresh subagent boundary keeps the breadcrumb", async () => {
    const f = await makeFixture();
    writeFill(f, 35_000);
    writeSubagent(f); // active, but no boundary of its own
    expect(await sessionStart(f)).toContain("Storybloq project context was compacted.");

    writeSubagent(f, { withBoundary: true, boundaryTs: iso(-10 * 60_000) }); // stale boundary
    expect(await sessionStart(f)).toContain("Storybloq project context was compacted.");
  });

  it("16: low fill with a resumable COMPACT session resumes as today", async () => {
    const f = await makeFixture();
    const dir = plantSession(f, { compactPending: true });
    writeFill(f, 35_000);
    writeSubagent(f, { withBoundary: true });
    const out = await sessionStart(f);
    expect(out).toContain(`"sessionId": "${AUTO_SESSION}"`);
    expect(readSession(dir)?.compactObservedAt).toEqual(expect.any(String));
    expect(events(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 17-18d: the scan and its fail-safes
// ---------------------------------------------------------------------------

describe("readMainFill (ISS-1307)", () => {
  let readMainFill: Awaited<ReturnType<typeof subagentCompaction>>["readMainFill"];
  let recentSubagentEvidence: Awaited<ReturnType<typeof subagentCompaction>>["recentSubagentEvidence"];
  beforeAll(async () => {
    try {
      ({ readMainFill, recentSubagentEvidence } = await subagentCompaction());
    } catch {
      // RED against a tree without the module: each test fails on its own call.
    }
  });

  it("17: lines spanning chunk edges; the trailing partial, sidechain and foreign records are not measurements", async () => {
    const f = await makeFixture();
    const after = [
      assistant(95_000, { sidechain: true }),
      assistant(97_000, { sid: "99999999-2222-4333-8444-555555555555" }),
    ];
    const lines = [userText("old"), boundary(), userText("go"), assistant(42_000), ...after];
    const trailing = assistant(99_000).slice(0, 80);
    writeTranscript(f, lines, trailing);
    const tailBytes = Buffer.byteLength(after.join("\n") + "\n" + trailing);
    for (const chunkBytes of [1, 7, 64, 333, 4096, 1 << 20]) {
      const r = readMainFill(f.transcript, SID, { ...f.classify, chunkBytes });
      expect(r).toMatchObject({ kind: "measured", contextTokens: 42_000, tailBytes, preTokens: PRE });
      if (r.kind === "measured") expect(r.fill).toBeCloseTo((42_000 + Math.ceil(tailBytes / 3)) / PRE, 10);
    }
  });

  it("18: stops at the newest main boundary without reading what precedes it", async () => {
    const f = await makeFixture();
    const junk = Array.from({ length: 3 * 1024 }, () => "#".repeat(1023)).join("\n");
    writeFileSync(f.transcript, junk + "\n" + [boundary(), assistant(40_000)].join("\n") + "\n");
    const r = readMainFill(f.transcript, SID, f.classify);
    expect(r).toMatchObject({ kind: "measured", fill: 0.4 });
    expect(r.scannedBytes).toBeLessThan(1024 * 1024);
  });

  it("18a: an invalid newest boundary, a corrupt line or a usage-less record fails safe at both hooks", async () => {
    const arrangements: Array<(f: Fixture) => void> = [
      (f) => writeTranscript(f, [boundary(), userText("x"), boundary({ ts: "not-a-time" }), assistant(30_000)]),
      (f) => writeFill(f, 30_000, { after: ["{corrupt"] }),
      (f) => writeFill(f, 30_000, { after: [assistant(0, { noUsage: true })] }),
      // A counter the intel classifier would read as 0 must not understate the context.
      (f) => writeFill(f, 90_000, { after: [assistant(0, { usage: { input_tokens: 1_000, cache_read_input_tokens: "250000" } })] }),
      (f) => writeFill(f, 90_000, { after: [assistant(0, { usage: { input_tokens: 1_000, cache_creation_input_tokens: -5 } })] }),
    ];
    const reasons: string[] = [];
    for (const arrange of arrangements) {
      const f = await makeFixture();
      arrange(f);
      const r = readMainFill(f.transcript, SID, f.classify);
      expect(r.kind).toBe("unknown");
      if (r.kind === "unknown") reasons.push(r.reason);

      const dir = plantSession(f);
      writeSubagent(f, { withBoundary: true });
      await preCompact(f);
      expectCompacted(dir);

      const g = await makeFixture();
      arrange(g);
      writeSubagent(g, { withBoundary: true });
      expect(await sessionStart(g)).toContain("Storybloq project context was compacted.");
    }
    expect(reasons).toEqual(["malformed", "malformed", "malformed", "malformed", "malformed"]);
  });

  it("18b: a <synthetic> zero-usage record is not a measurement", async () => {
    const f = await makeFixture();
    writeFill(f, 90_000, { after: [assistant(0, { synthetic: true }), assistant(0, { apiError: true, model: "x" })] });
    const r = readMainFill(f.transcript, SID, f.classify);
    expect(r).toMatchObject({ kind: "measured", contextTokens: 90_000 });
    const dir = plantSession(f);
    writeSubagent(f);
    await preCompact(f);
    expectCompacted(dir);
  });

  it("18c: a passed deadline gives no measurement and no corroboration", async () => {
    const f = await makeFixture();
    writeFill(f, 30_000);
    writeSubagent(f, { withBoundary: true });
    const expired = { expired: () => true };
    const live = LIVE;
    // Nothing is read once the deadline has passed.
    expect(readMainFill(f.transcript, SID, { ...f.classify, deadline: expired })).toEqual({ kind: "unknown", reason: "time-cap", scannedBytes: 0 });
    const real = realpathSync(f.transcript);
    for (const requireBoundary of [false, true]) {
      expect(recentSubagentEvidence(real, SID, Date.now(), { requireBoundary, deadline: live })).toEqual({ agentId: "a5737e549e70815f4" });
      expect(recentSubagentEvidence(real, SID, Date.now(), { requireBoundary, deadline: expired })).toBeNull();
    }
  });

  it("18e: a deadline that passes during the work gives no measurement and no evidence", async () => {
    const f = await makeFixture();
    writeFill(f, 30_000);
    writeSubagent(f, { withBoundary: true });
    const real = realpathSync(f.transcript);
    const evidence = (requireBoundary: boolean, n: number) =>
      recentSubagentEvidence(real, SID, Date.now(), { requireBoundary, deadline: expiresAfter(n) });

    // Passes while the only chunk is read and parsed.
    const scan = readMainFill(f.transcript, SID, { ...f.classify, deadline: expiresAfter(1) });
    expect(scan).toMatchObject({ kind: "unknown", reason: "time-cap" });
    expect(scan.scannedBytes).toBeGreaterThan(0);
    expect(readMainFill(f.transcript, SID, { ...f.classify, deadline: expiresAfter(2) })).toMatchObject({ kind: "measured", fill: 0.3 });

    // Passes during the stats.
    expect(evidence(false, 1)).toBeNull();
    expect(evidence(false, 2)).toEqual({ agentId: "a5737e549e70815f4" });

    // Passes during the tail read that finds the boundary.
    expect(evidence(true, 2)).toBeNull();
    expect(evidence(true, 3)).toEqual({ agentId: "a5737e549e70815f4" });
  });

  it("18e: a deadline that passes at any check leaves both hooks as today", async () => {
    const arrange = async (): Promise<Fixture> => {
      const f = await makeFixture();
      writeFill(f, 35_000);
      writeSubagent(f, { withBoundary: true });
      return f;
    };

    const live = expiresAfter(Infinity);
    const f = await arrange();
    const dir = plantSession(f);
    await preCompact(f, { classify: { ...f.classify, deadline: live } });
    expectUntouched(dir);
    expect(live.checks()).toBeGreaterThan(1);
    for (let n = 0; n < live.checks(); n++) {
      const g = await arrange();
      const gdir = plantSession(g);
      await preCompact(g, { classify: { ...g.classify, deadline: expiresAfter(n) } });
      expectCompacted(gdir);
      expect(events(gdir)).toEqual([]);
    }

    const startLive = expiresAfter(Infinity);
    const s = await arrange();
    expect(await sessionStart(s, { classify: { ...s.classify, deadline: startLive } })).toBe("");
    expect(startLive.checks()).toBeGreaterThan(1);
    for (let n = 0; n < startLive.checks(); n++) {
      expect(await sessionStart(s, { classify: { ...s.classify, deadline: expiresAfter(n) } })).toContain("Storybloq project context was compacted.");
    }
  });

  it("18c: corroboration ignores stale, foreign-named and symlinked subagent files", async () => {
    const f = await makeFixture();
    writeFill(f, 30_000);
    const real = realpathSync(f.transcript);
    writeSubagent(f, { withBoundary: true, mtimeMs: Date.now() - 10 * 60_000 });
    expect(recentSubagentEvidence(real, SID, Date.now(), { requireBoundary: false, deadline: LIVE })).toBeNull();
    writeFileSync(join(f.subagents, "notes.jsonl"), "{}\n");
    symlinkSync(join(f.subagents, "notes.jsonl"), join(f.subagents, "agent-link.jsonl"));
    expect(recentSubagentEvidence(real, SID, Date.now(), { requireBoundary: false, deadline: LIVE })).toBeNull();
    writeSubagent(f, { name: "agent-fresh.jsonl" });
    expect(recentSubagentEvidence(real, SID, Date.now(), { requireBoundary: false, deadline: LIVE })).toEqual({ agentId: "fresh" });
  });

  it("18d: a held session lock drops the event without waiting and changes nothing", async () => {
    const f = await makeFixture();
    const dir = plantSession(f);
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => { acquired = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = withSessionLock(f.root, () => { acquired(); return held; });
    await holding;
    const stderr: string[] = [];
    const oldErr = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    // A lock retry waits on a timer. With timers faked, a recorder that
    // waits never returns, so waiting fails here by assertion, not by an
    // elapsed-time bound that machine load could break.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let ceiling: ReturnType<typeof setTimeout> | undefined;
    let outcome: string;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      outcome = await Promise.race([
        preCompact(f, { subagent: { agentId: "a1", viaTranscriptPath: false } }).then(() => "returned"),
        new Promise<string>((resolve) => { ceiling = realSetTimeout(() => resolve("waited"), 3_000); }),
      ]);
    } finally {
      vi.useRealTimers();
      realClearTimeout(ceiling);
      process.stderr.write = oldErr;
      release();
    }
    await holder;
    expect(outcome).toBe("returned");
    expect(stderr.join("")).toContain("event not recorded");
    expectUntouched(dir);
    expect(events(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 19: session intel
// ---------------------------------------------------------------------------

describe("session intel-start, subagent guard (ISS-1307)", () => {
  it("19: an explicit subagent signal skips capture", async () => {
    const f = await makeFixture();
    const r = handleSessionIntelStart({ client: "claude", source: "compact", sessionId: SID, cwd: f.root, subagent: { agentId: "a1", viaTranscriptPath: false }, projectsDir: f.projects });
    expect(r).toMatchObject({ status: "skipped", reason: "subagent hook" });
    const t = handleSessionIntelStart({ client: "claude", source: "compact", sessionId: SID, cwd: f.root, subagent: { viaTranscriptPath: true }, projectsDir: f.projects });
    expect(t).toMatchObject({ status: "skipped", reason: "subagent hook" });
  });
});

// ---------------------------------------------------------------------------
// 20-27: session intel-start through the classifier (ISS-1310)
// ---------------------------------------------------------------------------

function intelStart(
  f: Fixture,
  o: Partial<Parameters<typeof handleSessionIntelStart>[0]> = {},
): ReturnType<typeof handleSessionIntelStart> {
  return handleSessionIntelStart({
    client: "claude",
    source: "compact",
    sessionId: SID,
    cwd: f.root,
    transcriptPath: f.transcript,
    projectsDir: f.projects,
    userSettingsPath: join(f.root, "no-user-settings.json"),
    classify: f.classify,
    ...o,
  });
}

function expectIntelUntouched(f: Fixture, r: ReturnType<typeof handleSessionIntelStart>): void {
  expect(r).toEqual({ status: "skipped", reason: "subagent compaction (fill)", capture: null, reconcile: null });
  expect(readPresenceRecord(f.root, SID)?.sessionIntel ?? null).toBeNull();
}

function expectIntelRecorded(f: Fixture, r: ReturnType<typeof handleSessionIntelStart>): void {
  expect(r.status).toBe("done");
  expect(r.capture).not.toBeNull();
  expect(readPresenceRecord(f.root, SID)?.sessionIntel ?? null).not.toBeNull();
}

describe("session intel-start, classified subagent compaction (ISS-1310)", () => {
  it("20: low fill with a fresh subagent boundary and no resumable session records nothing", async () => {
    const f = await makeFixture();
    writeFill(f, 35_000);
    writeSubagent(f, { withBoundary: true });
    expectIntelUntouched(f, intelStart(f));
  });

  it("21: low fill without a fresh subagent boundary captures and reconciles as today", async () => {
    const f = await makeFixture();
    writeFill(f, 35_000);
    writeSubagent(f); // active, but no boundary of its own
    const r = intelStart(f);
    expectIntelRecorded(f, r);
    expect(r.reconcile).not.toBeNull();

    const g = await makeFixture();
    writeFill(g, 35_000);
    writeSubagent(g, { withBoundary: true, boundaryTs: iso(-10 * 60_000) }); // stale boundary
    expectIntelRecorded(g, intelStart(g));
  });

  it("22: low fill with a resumable COMPACT session is the parent's own compaction", async () => {
    const f = await makeFixture();
    plantSession(f, { compactPending: true });
    writeFill(f, 35_000);
    writeSubagent(f, { withBoundary: true });
    const r = intelStart(f);
    expectIntelRecorded(f, r);
    expect(r.reconcile).not.toBeNull();
  });

  it("23: fill at or above 0.6 is the parent's own compaction", async () => {
    for (const tokens of [60_000, 90_000]) {
      const f = await makeFixture();
      writeFill(f, tokens);
      writeSubagent(f, { withBoundary: true });
      expectIntelRecorded(f, intelStart(f));
    }
  });

  describe("24: every doubt case records as today", () => {
    const cases: Array<[string, (f: Fixture) => void, Partial<ClassifyOptions>?]> = [
      ["transcript missing", () => undefined],
      ["transcript a symlink", (f) => {
        const target = join(f.projects, "-proj", "real.jsonl");
        writeFileSync(target, [boundary(), assistant(30_000)].join("\n") + "\n");
        symlinkSync(target, f.transcript);
      }],
      ["transcript outside projectsDir", (f) => writeFill(f, 30_000), { projectsDir: "/nonexistent-projects" }],
      ["byte cap", (f) => writeFill(f, 30_000, { before: Array.from({ length: 64 }, (_, i) => userText(`filler ${i} ${"x".repeat(64)}`)) }), { maxBytes: 1024, chunkBytes: 256 }],
      ["time cap", (f) => writeFill(f, 30_000), { deadline: { expired: () => true } }],
      ["no active subagent", (f) => writeFill(f, 30_000)],
    ];
    for (const [name, arrange, extra] of cases) {
      it(name, async () => {
        const f = await makeFixture();
        arrange(f);
        if (name !== "no active subagent") writeSubagent(f, { withBoundary: true });
        const r = intelStart(f, { classify: { ...f.classify, ...extra } });
        expect(r.status).toBe("done");
        expect(r.reason).toBeNull();
      });
    }
  });

  it("25: startup, resume and clear are never classified", async () => {
    for (const source of ["startup", "resume", "clear"]) {
      const f = await makeFixture();
      writeFill(f, 35_000);
      writeSubagent(f, { withBoundary: true });
      expectIntelRecorded(f, intelStart(f, { source }));
    }
  });

  it("26: a deadline that passes at any check records as today", async () => {
    const arrange = async (): Promise<Fixture> => {
      const f = await makeFixture();
      writeFill(f, 35_000);
      writeSubagent(f, { withBoundary: true });
      return f;
    };
    const live = expiresAfter(Infinity);
    const f = await arrange();
    expectIntelUntouched(f, intelStart(f, { classify: { ...f.classify, deadline: live } }));
    expect(live.checks()).toBeGreaterThan(1);
    for (let n = 0; n < live.checks(); n++) {
      const g = await arrange();
      expectIntelRecorded(g, intelStart(g, { classify: { ...g.classify, deadline: expiresAfter(n) } }));
    }
  });

  it("27: a classifier throw is doubt and records as today", async () => {
    const f = await makeFixture();
    writeFill(f, 35_000);
    writeSubagent(f, { withBoundary: true });
    // The scan swallows its own I/O errors; this throw escapes the classifier.
    const throwing: ClassifyOptions = { ...f.classify, get now(): number { throw new Error("boom"); } };
    const r = intelStart(f, { classify: throwing });
    expect(r.reason).toBeNull();
    expectIntelRecorded(f, r);
  });
});
