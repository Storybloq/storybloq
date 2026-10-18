/**
 * The compact hooks and commands no longer treat a damaged session as absent
 * (ISS-1347).
 *
 * The active and compact-pending scans skipped any session whose state.json
 * failed to parse, so a damaged session read as "no session". The worst case
 * was `session resume-prompt`: it then deleted the resume marker and the
 * resume was lost. Each scan now reports the entries it could not read, and
 * only "no match and nothing unreadable" may remove the marker.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  findActiveSessionFull,
  findResumableSession,
  describeSessionLookupFailure,
  describeUnreadableSessionEntry,
  type SessionLookupFailure,
} from "../../src/autonomous/session.js";
import { CURRENT_SESSION_SCHEMA_VERSION } from "../../src/autonomous/session-types.js";
import {
  handleSessionClearCompact,
  handleSessionCompactPrepare,
  handleSessionResumePrompt,
  handleSessionStop,
} from "../../src/cli/commands/session-compact.js";
import { COMMANDS } from "../../src/cli/commands/reference.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A project root with a sessions directory, as its real path (the workspace id). */
function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "storybloq-compact-damaged-")));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ name: "test" }));
  return root;
}

function statePathOf(root: string, id: string): string {
  return join(root, ".story", "sessions", id, "state.json");
}

/** A session of this workspace, then its raw state.json rewritten with `over`. */
function rawSession(root: string, over: Record<string, unknown>): string {
  const id = createSession(root, "default", root).sessionId;
  const raw = JSON.parse(readFileSync(statePathOf(root, id), "utf-8")) as Record<string, unknown>;
  writeFileSync(statePathOf(root, id), JSON.stringify({ ...raw, ...over }));
  return id;
}

const PARKED = {
  state: "COMPACT",
  compactPending: true,
  compactPreparedAt: new Date().toISOString(),
  preCompactState: "IMPLEMENT",
};

/** Compact-pending, raw status active, damaged by `startedAt: null` (a required string). */
function damagedParked(root: string, over: Record<string, unknown> = {}): string {
  return rawSession(root, { ...PARKED, startedAt: null, ...over });
}

function markerPath(root: string): string {
  return join(root, ".claude", "rules", "autonomous-resume.md");
}

function writeMarker(root: string): void {
  mkdirSync(join(root, ".claude", "rules"), { recursive: true });
  writeFileSync(markerPath(root), "resume marker\n");
}

const HOOK_ENV = ["STORYBLOQ_PROJECT_ROOT", "CLAUDESTORY_PROJECT_ROOT", "STORYBLOQ_GLOBAL_DIR"] as const;

/** Runs a hook as if started in `root`, capturing stdout and stderr. */
async function inHook(root: string, fn: () => Promise<unknown>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const cwd = process.cwd();
  const saved = HOOK_ENV.map((k) => [k, process.env[k]] as const);
  try {
    delete process.env.STORYBLOQ_PROJECT_ROOT;
    delete process.env.CLAUDESTORY_PROJECT_ROOT;
    process.env.STORYBLOQ_GLOBAL_DIR = join(root, ".global");
    process.chdir(root);
    await fn();
  } finally {
    process.chdir(cwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  }
  return { out: out.join(""), err: err.join("") };
}

const resumePrompt = (root: string) => inHook(root, () => handleSessionResumePrompt({ source: "compact" }));
const compactPrepare = (root: string) => inHook(root, () => handleSessionCompactPrepare({}));

describe("resume-prompt keeps the marker while a session cannot be read", () => {
  it("a damaged compact-pending session keeps the marker and is named on stderr only", async () => {
    const root = makeRoot();
    const id = damagedParked(root);
    writeMarker(root);
    const { out, err } = await resumePrompt(root);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(err).toContain("[storybloq] resume-prompt:");
    expect(err).toContain("startedAt");
    expect(err).toContain(`storybloq session show ${id}`);
    expect(err).not.toContain("session repair");
    expect(out).not.toContain("could not be read");
  });

  it("with no sessions directory the marker is removed as before (T-183)", async () => {
    const root = makeRoot();
    rmSync(join(root, ".story", "sessions"), { recursive: true });
    writeMarker(root);
    const { err } = await resumePrompt(root);
    expect(existsSync(markerPath(root))).toBe(false);
    expect(err).not.toContain("could not be read");
  });

  it.each(["completed", "superseded"])("a damaged session with raw status %s cannot be the one: the marker is removed, silently", async (status) => {
    const root = makeRoot();
    damagedParked(root, { status });
    writeMarker(root);
    const { err } = await resumePrompt(root);
    expect(existsSync(markerPath(root))).toBe(false);
    expect(err).not.toContain("could not be read");
  });

  it("an unknown status string is not a terminal status: the marker stays", async () => {
    const root = makeRoot();
    rawSession(root, { ...PARKED, status: "actve" });
    writeMarker(root);
    const { err } = await resumePrompt(root);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(err).toContain("could not be read");
  });

  it("a newer writer's session is never filtered by its raw status: the marker stays", async () => {
    const root = makeRoot();
    damagedParked(root, { schemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1, status: "completed" });
    writeMarker(root);
    const { err } = await resumePrompt(root);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(err).toContain("newer storybloq");
  });

  it("an unsupported schemaVersion is never filtered by its raw status: the marker stays", async () => {
    const root = makeRoot();
    damagedParked(root, { schemaVersion: 0, status: "completed" });
    writeMarker(root);
    const { err } = await resumePrompt(root);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(err).toContain("Do NOT delete it");
  });

  it("invalid JSON keeps the marker", async () => {
    const root = makeRoot();
    const id = damagedParked(root);
    writeFileSync(statePathOf(root, id), "{ not json");
    writeMarker(root);
    const { err } = await resumePrompt(root);
    expect(existsSync(markerPath(root))).toBe(true);
    expect(err).toContain("not valid JSON");
  });

  it("a damaged session that is not compact-pending cannot be the one: the marker is removed", async () => {
    const root = makeRoot();
    damagedParked(root, { compactPending: false });
    writeMarker(root);
    const { err } = await resumePrompt(root);
    expect(existsSync(markerPath(root))).toBe(false);
    expect(err).not.toContain("could not be read");
  });

  it("a readable compact-pending session is resumed next to a damaged one, with no notice", async () => {
    const root = makeRoot();
    damagedParked(root);
    const healthy = rawSession(root, PARKED);
    writeMarker(root);
    const { out, err } = await resumePrompt(root);
    expect(out).toContain(healthy);
    expect(out).toContain("storybloq_autonomous_guide");
    expect(err).not.toContain("could not be read");
  });
});

describe("compact-prepare names an unreadable active session", () => {
  it("writes the notice on stderr and nothing on stdout", async () => {
    const root = makeRoot();
    const id = rawSession(root, { startedAt: null });
    const { out, err } = await compactPrepare(root);
    expect(err).toContain("[storybloq] compact-prepare:");
    expect(err).toContain("startedAt");
    expect(err).toContain(`storybloq session show ${id}`);
    expect(err.toLowerCase()).not.toContain("no active session");
    expect(out).toBe("");
  });
});

describe("clear-compact and stop give the cause, not 'not found'", () => {
  it("clear-compact with the id", async () => {
    const root = makeRoot();
    const id = damagedParked(root);
    const err = await handleSessionClearCompact(root, id).then(() => null, (e: Error) => e.message);
    expect(err).toContain(id);
    expect(err).toContain("startedAt");
    expect(err).not.toContain("not found");
  });

  it("clear-compact without the id lists the unreadable directory", async () => {
    const root = makeRoot();
    const id = damagedParked(root);
    const err = await handleSessionClearCompact(root).then(() => null, (e: Error) => e.message);
    expect(err).toContain("No compactPending session found, and 1 session directory could not be read:");
    expect(err).toContain(`storybloq session show ${id}`);
    expect(err).toContain("startedAt");
  });

  it("stop with the id", async () => {
    const root = makeRoot();
    const id = rawSession(root, { startedAt: null });
    const err = await handleSessionStop(root, id).then(() => null, (e: Error) => e.message);
    expect(err).toContain("startedAt");
    expect(err).not.toContain("not found");
  });

  it("stop without the id lists the unreadable directory", async () => {
    const root = makeRoot();
    const id = rawSession(root, { startedAt: null });
    const err = await handleSessionStop(root).then(() => null, (e: Error) => e.message);
    expect(err).toContain("No active session found, and 1 session directory could not be read:");
    expect(err).toContain(`storybloq session show ${id}`);
  });

  it("a missing id still says not found, and an empty scan keeps the old messages", async () => {
    const root = makeRoot();
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(handleSessionClearCompact(root, missing)).rejects.toThrow(`Session ${missing} not found`);
    await expect(handleSessionStop(root, missing)).rejects.toThrow(`Session ${missing} not found`);
    await expect(handleSessionClearCompact(root)).rejects.toThrow(
      /^No compactPending session found\. Specify the session ID manually\.$/,
    );
    await expect(handleSessionStop(root)).rejects.toThrow(/^No active session found$/);
  });
});

describe("the legacy scans keep their contract", () => {
  it("return the readable session and ignore the damaged one", () => {
    const root = makeRoot();
    rawSession(root, { startedAt: null });
    damagedParked(root);
    expect(findActiveSessionFull(root)).toBeNull();
    expect(findResumableSession(root)).toBeNull();
    const active = rawSession(root, {});
    const parked = rawSession(root, PARKED);
    expect([active, parked]).toContain(findActiveSessionFull(root)!.state.sessionId);
    expect(findResumableSession(root)!.info.state.sessionId).toBe(parked);
  });
});

describe("every remedy names a real CLI command (ISS-1347)", () => {
  const ID = "11111111-2222-4333-8444-555555555555";
  const failures: SessionLookupFailure[] = [
    { kind: "missing" },
    { kind: "version-skew", writerVersion: 9, readerVersion: 1 },
    { kind: "unreadable", reason: "schema", issues: [], issueCount: 0 },
    { kind: "unreadable", reason: "invalid-json" },
    { kind: "unreadable", reason: "missing-state" },
    { kind: "unreadable", reason: "unreadable-file" },
    { kind: "unreadable", reason: "unsupported-version", rawVersion: 0 },
  ];
  const known = new Set(COMMANDS.map((c) => c.name));

  /** Every `storybloq <words> <ID>` in a message: a command addressed at this session. */
  function commandsNamed(text: string): string[] {
    return [...text.matchAll(new RegExp(`storybloq ([a-z][a-z-]*(?: [a-z][a-z-]*)*) ${ID}`, "g"))].map((m) => m[1]!);
  }

  it("in describeSessionLookupFailure and describeUnreadableSessionEntry", () => {
    const named: string[] = [];
    for (const failure of failures) {
      named.push(...commandsNamed(describeSessionLookupFailure(ID, failure)));
      if (failure.kind !== "missing") {
        named.push(...commandsNamed(describeUnreadableSessionEntry({ sourceDir: ID, dir: `/x/${ID}`, failure })));
      }
    }
    // Not vacuous: the inspecting remedies are all found.
    expect(named.length).toBeGreaterThanOrEqual(9);
    for (const command of named) expect(known, `storybloq ${command}`).toContain(command);
  });
});

describe("an unreadable entry whose name is not a session id", () => {
  it("is described on one line with no raw control bytes", () => {
    const name = "forged\n[storybloq] all clear\u001b[2K";
    for (const failure of [
      { kind: "unreadable", reason: "invalid-json" },
      { kind: "unreadable", reason: "unreadable-file" },
    ] as const) {
      const text = describeUnreadableSessionEntry({ sourceDir: name, dir: `/x/${name}`, failure });
      expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(text.split("\n")).toHaveLength(1);
      // Both places the name appears: the failure line and the Inspect address.
      expect(text.match(/forged/g)).toHaveLength(2);
    }
  });
});
