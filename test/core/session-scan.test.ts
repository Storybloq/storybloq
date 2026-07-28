import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanActiveSessions, scanSessionSummaries } from "../../src/core/session-scan.js";
import { resolveSessionSelector } from "../../src/autonomous/session-selector.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-session-scan-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

function writeSession(root: string, sessionId: string, state: Record<string, unknown>): void {
  const dir = join(root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    sessionId,
    status: "active",
    state: "IMPLEMENT",
    mode: "auto",
    ticket: { id: "T-020", title: "Task ownership" },
    compactPending: false,
    ...state,
  }));
}

describe("scanSessionSummaries", () => {
  it("preserves activeSessions and adds full task/lease metadata", () => {
    const root = makeRoot();
    writeSession(root, "live-session", {
      ownerTask: { client: "codex", id: "codex-task", boundAt: "2026-07-09T00:00:00Z" },
      lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const result = scanSessionSummaries(root);
    expect(result.resumableSessions).toEqual([]);
    expect(result.activeSessions).toHaveLength(1);
    expect(result.activeSessions[0]).toMatchObject({
      sessionId: "live-session",
      ownerTask: { client: "codex", id: "codex-task" },
      leaseState: "live",
      compactPending: false,
    });
    expect(scanActiveSessions(root)).toEqual(result.activeSessions);
  });

  it("reports an expired COMPACT session as resumable but not live", () => {
    const root = makeRoot();
    writeSession(root, "compact-session", {
      state: "COMPACT",
      compactPending: true,
      ownerTask: null,
      lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions).toEqual([]);
    expect(result.resumableSessions).toHaveLength(1);
    expect(result.resumableSessions[0]).toMatchObject({
      sessionId: "compact-session",
      ownerTask: null,
      leaseState: "expired",
      compactPending: true,
    });
  });

  it("drops malformed owner identity and falls back to the directory session id", () => {
    const root = makeRoot();
    writeSession(root, "safe-session-id", {
      sessionId: 42,
      ownerTask: { client: "codex", id: "bad task id", boundAt: "2026-07-09T00:00:00Z" },
      lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions[0]).toMatchObject({
      sessionId: "safe-session-id",
      ownerTask: null,
      leaseState: "live",
    });
  });

  it("classifies a missing COMPACT lease as resumable", () => {
    const root = makeRoot();
    writeSession(root, "missing-lease", {
      state: "COMPACT",
      compactPending: true,
      ownerTask: null,
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions).toEqual([]);
    expect(result.resumableSessions[0]).toMatchObject({
      sessionId: "missing-lease",
      leaseExpiresAt: null,
      leaseState: "missing",
    });
  });

  it("classifies an invalid COMPACT lease as resumable", () => {
    const root = makeRoot();
    writeSession(root, "invalid-lease", {
      state: "COMPACT",
      compactPending: true,
      ownerTask: null,
      lease: { expiresAt: "not-a-date" },
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions).toEqual([]);
    expect(result.resumableSessions[0]).toMatchObject({
      sessionId: "invalid-lease",
      leaseExpiresAt: "not-a-date",
      leaseState: "invalid",
    });
  });
});

/**
 * T-446 adds `sourceDir`. The guard needs it because `resolveSessionSelector`
 * resolves DIRECTORY names from `readdirSync(sessionsRoot)`, not the `sessionId`
 * embedded in `state.json`. When the two differ, a verdict that rendered only
 * `sessionId` would hand the operator a selector the CLI rejects.
 */
describe("scanSessionSummaries: sourceDir (T-446)", () => {
  // `resolveSessionSelector` validates against SESSION_ID_REGEX (a uuid shape),
  // so an arbitrary string proves only that the scanner copied `entry.name`.
  // These are real directory names the CLI will actually resolve.
  const DIR_UUID = "11111111-2222-4333-8444-555555555555";
  const EMBEDDED_UUID = "99999999-8888-4777-8666-555555555555";

  it("reports the directory name, and the CLI selector resolves it", () => {
    const root = makeRoot();
    writeSession(root, DIR_UUID, {
      ownerTask: null,
      lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const result = scanSessionSummaries(root);
    expect(result.activeSessions[0]).toMatchObject({ sourceDir: DIR_UUID });
    expect(resolveSessionSelector(root, DIR_UUID).kind).toBe("resolved");
  });

  it("keeps sourceDir and sessionId distinct, and only sourceDir resolves as a selector", () => {
    const root = makeRoot();
    writeSession(root, DIR_UUID, {
      sessionId: EMBEDDED_UUID,
      ownerTask: null,
      lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });

    const summary = scanSessionSummaries(root).activeSessions[0];
    expect(summary?.sessionId).toBe(EMBEDDED_UUID);
    expect(summary?.sourceDir).toBe(DIR_UUID);

    // This is the whole reason the field exists: an operator handed the embedded
    // sessionId cannot address the session, because the selector resolves
    // directory names.
    expect(resolveSessionSelector(root, summary!.sourceDir).kind).toBe("resolved");
    expect(resolveSessionSelector(root, summary!.sessionId).kind).not.toBe("resolved");
  });

  it("falls back to the directory name for sessionId when state.json omits it, and both agree", () => {
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "no-embedded-id");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      status: "active",
      state: "IMPLEMENT",
      mode: "auto",
      lease: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    }));

    const summary = scanSessionSummaries(root).activeSessions[0];
    expect(summary?.sessionId).toBe("no-embedded-id");
    expect(summary?.sourceDir).toBe("no-embedded-id");
  });

  it("populates sourceDir on resumable sessions too, not just active ones", () => {
    const root = makeRoot();
    writeSession(root, "22222222-3333-4444-8555-666666666666", {
      sessionId: "77777777-3333-4444-8555-666666666666",
      state: "COMPACT",
      compactPending: true,
      ownerTask: null,
      lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });

    const summary = scanSessionSummaries(root).resumableSessions[0];
    expect(summary?.sourceDir).toBe("22222222-3333-4444-8555-666666666666");
    expect(summary?.sessionId).toBe("77777777-3333-4444-8555-666666666666");
  });
});
