/**
 * T-534 Part B: the retired usage-limit park normalisation primitive, its
 * surviving-attempt check and the best-effort project pass. Decisions come
 * from the keys persisted in state.json, so every fixture writes the raw file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/autonomous/git-inspector.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, gitHead: vi.fn(), gitDiffTreeNames: vi.fn(), gitIsAncestor: vi.fn() };
});

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitDiffTreeNames, gitHead, gitIsAncestor } from "../../src/autonomous/git-inspector.js";
import {
  checkSurvivingWakeAttempts,
  normalizeProjectParksLocked,
  normalizeRetiredLimitPark,
  normalizeRetiredParksBestEffort,
} from "../../src/autonomous/retired-limit-park.js";
import { createSession, readEvents, withoutLimitKeys, writeSessionSync } from "../../src/autonomous/session.js";
import { deriveWorkspaceId, parseSessionState } from "../../src/autonomous/session-types.js";
import type { AttemptProbes } from "../../src/core/limit-retirement.js";

const head = vi.mocked(gitHead);
const tree = vi.mocked(gitDiffTreeNames);
const ancestor = vi.mocked(gitIsAncestor);
const BASE = "b".repeat(40);
const MOVED = "a".repeat(40);

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

beforeEach(() => {
  globalDir = mkdtempSync(join(tmpdir(), "t534-global-"));
  roots.push(globalDir);
  head.mockReset();
  tree.mockReset();
  ancestor.mockReset();
  head.mockResolvedValue({ ok: true, data: { hash: BASE } } as never);
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "t534-park-"));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
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
  // A planted fixture must be a session the reader accepts, or a test would
  // pass on a parse refusal instead of reaching the normalisation.
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

const raw = (dir: string) => JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as Record<string, unknown>;
const rawText = (dir: string) => readFileSync(join(dir, "state.json"), "utf-8");
const noLimitKeys = (dir: string) => expect(Object.keys(raw(dir)).filter((k) => LIMIT_KEY_NAMES.includes(k))).toEqual([]);

function ledger(records: Record<string, unknown>): void {
  writeFileSync(join(globalDir, "limit-ledger.json"), JSON.stringify({ schemaVersion: 1, records }));
}

const probes = (
  child: "match" | "absent" | "unknown",
  claimant: "alive" | "dead" | "unknown",
  scan: "present" | "absent" | "unknown" = "absent",
): AttemptProbes => ({
  probeChild: () => child,
  inspectClaimant: () => claimant,
  scanForChild: () => scan,
});

describe("normalizeRetiredLimitPark: shapes", () => {
  it("leaves a session with no persisted limit key unchanged and unwritten", async () => {
    const root = project();
    const { id, dir } = plant(root, { state: "IMPLEMENT" });
    const before = rawText(dir);
    const r = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(r.kind).toBe("unchanged");
    expect(rawText(dir)).toBe(before);
  });

  it("strips inert keys only, leaving every other field as it was", async () => {
    const root = project();
    const { id, dir } = plant(root, { state: "IMPLEMENT", interruptionKind: null, limitStopPending: false, limitPermissionMode: null });
    const before = raw(dir);
    const r = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(r).toMatchObject({ kind: "normalized", transition: "stripped" });
    const after = raw(dir);
    noLimitKeys(dir);
    // Compared as the reader sees both: the writer materialises schema
    // defaults the reader already returns, and nothing else may move.
    const read = (v: unknown) => {
      const parsed = parseSessionState(v);
      if (!parsed.success) throw new Error("unreadable state");
      const { revision: _r, ...rest } = withoutLimitKeys(parsed.data) as Record<string, unknown>;
      return JSON.parse(JSON.stringify(rest)) as unknown;
    };
    expect(read(after)).toEqual(read(before));
  });

  it("strips stale limit metadata from a terminal session without reviving it", async () => {
    const root = project();
    const { id, dir } = plant(root, park({ status: "completed", state: "SESSION_END", compactPending: false }));
    const r = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(r).toMatchObject({ kind: "normalized", transition: "stripped" });
    expect(raw(dir)).toMatchObject({ status: "completed", state: "SESSION_END" });
    noLimitKeys(dir);
  });

  it("turns a non-FINALIZE park into an ordinary compact park, refreshing compactPreparedAt once", async () => {
    const root = project();
    const { id, dir } = plant(root, park());
    const r = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(r).toMatchObject({ kind: "normalized", transition: "compact-park" });
    const after = raw(dir);
    expect(after).toMatchObject({ state: "COMPACT", compactPending: true, preCompactState: "IMPLEMENT" });
    expect(after.compactPreparedAt).not.toBe("2026-09-01T00:00:00.000Z");
    noLimitKeys(dir);
    expect(readEvents(dir).events.some((e) => e.type === "limit_park_retired")).toBe(true);

    const text = rawText(dir);
    expect((await normalizeRetiredLimitPark(root, id, { globalDir })).kind).toBe("unchanged");
    expect(rawText(dir)).toBe(text);
  });

  it.each([
    ["COMPACT without compactPending", { compactPending: false }],
    ["compactPending without preCompactState", { preCompactState: null }],
    ["an unknown preCompactState", { preCompactState: "NOT_A_STATE" }],
  ])("fails without writing on an inconsistent park: %s", async (_label, over) => {
    const root = project();
    const { id, dir } = plant(root, park(over));
    const before = rawText(dir);
    const r = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain("inconsistent usage-limit park");
    expect(rawText(dir)).toBe(before);
  });
});

describe("normalizeRetiredLimitPark: the caller's authority", () => {
  it("leaves a park the caller may not act on byte-identical, deciding on the state read under the lock", async () => {
    const root = project();
    const { id, dir } = plant(root, park());
    const before = rawText(dir);
    const seen: string[] = [];
    const r = await normalizeRetiredLimitPark(root, id, { globalDir, mayAct: (state) => { seen.push(state.sessionId); return false; } });
    expect(r.kind).toBe("unchanged");
    expect(seen).toEqual([id]);
    expect(rawText(dir)).toBe(before);
    expect(await normalizeRetiredLimitPark(root, id, { globalDir, mayAct: () => true })).toMatchObject({ kind: "normalized" });
  });
});

describe("surviving wake attempts", () => {
  const record = (sessionId: string, attempt: Record<string, unknown>) => ({
    clientTaskId: "task-1",
    projectRoot: "/p",
    storybloqSessionId: sessionId,
    attempt,
  });

  it("holds a park whose wake child is alive, and releases it once the child is gone", async () => {
    const root = project();
    const { id, dir } = plant(root, park());
    ledger({ "claude:task-1": record(id, { id: "a1", childPid: 42 }) });
    const before = rawText(dir);

    const held = await normalizeRetiredLimitPark(root, id, { globalDir, probes: probes("match", "dead") });
    expect(held.kind).toBe("failed");
    if (held.kind === "failed") expect(held.reason).toContain("a1");
    expect(rawText(dir)).toBe(before);
    expect(readdirSync(globalDir)).toContain("limit-ledger.json");

    const released = await normalizeRetiredLimitPark(root, id, { globalDir, probes: probes("absent", "dead") });
    expect(released).toMatchObject({ kind: "normalized", transition: "compact-park" });
  });

  it("holds a key-free session a wake attempt may still run, and leaves a terminal one to the key rule", async () => {
    const root = project();
    const { id, dir } = plant(root, { state: "COMPACT", compactPending: true, preCompactState: "IMPLEMENT" });
    ledger({ "claude:task-1": record(id, { id: "a1", childPid: 42 }) });
    const before = rawText(dir);
    const held = await normalizeRetiredLimitPark(root, id, { globalDir, probes: probes("match", "dead") });
    expect(held.kind).toBe("failed");
    if (held.kind === "failed") {
      expect(held.reason).toContain("a1");
      expect(held.cause).toEqual({ kind: "recorded-attempt", attemptId: "a1" });
    }
    expect(rawText(dir)).toBe(before);

    const ended = plant(root, { status: "completed", state: "SESSION_END" });
    ledger({ "claude:task-1": record(ended.id, { id: "a2", childPid: 42 }) });
    expect((await normalizeRetiredLimitPark(root, ended.id, { globalDir, probes: probes("match", "dead") })).kind).toBe("unchanged");
  });

  it("the project pass reports a key-free session a wake attempt may still run, byte-identical", async () => {
    const root = project();
    const { id, dir } = plant(root, { state: "IMPLEMENT" });
    ledger({ "claude:task-1": record(id, { id: "a1", childPid: 42 }) });
    const before = rawText(dir);
    const failed = await normalizeProjectParksLocked(root, () => true, { globalDir, probes: probes("match", "dead") });
    expect(failed).toEqual([expect.objectContaining({ dir, sessionId: id, cause: { kind: "recorded-attempt", attemptId: "a1" } })]);
    expect(rawText(dir)).toBe(before);
  });

  it("holds on a live bare claimant and on an unverifiable one", async () => {
    const root = project();
    const { id } = plant(root, park());
    ledger({ k: record(id, { id: "a1", childPid: null, claimantPid: 7, claimantSignature: "sig" }) });
    expect(checkSurvivingWakeAttempts(id, { globalDir, probes: probes("absent", "alive") }).kind).toBe("held");
    expect(checkSurvivingWakeAttempts(id, { globalDir, probes: probes("absent", "unknown") }).kind).toBe("held");
    // A dead claimant may have spawned the child before recording its pid:
    // only a process scan that finds no child lets the attempt go.
    expect(checkSurvivingWakeAttempts(id, { globalDir, probes: probes("absent", "dead", "present") }).kind).toBe("held");
    expect(checkSurvivingWakeAttempts(id, { globalDir, probes: probes("absent", "dead", "unknown") }).kind).toBe("held");
    expect(checkSurvivingWakeAttempts(id, { globalDir, probes: probes("absent", "dead", "absent") }).kind).toBe("clear");
  });

  it("ignores attempts recorded for other sessions", () => {
    ledger({ k: record("someone-else", { id: "a1", childPid: 42 }) });
    expect(checkSurvivingWakeAttempts("mine", { globalDir, probes: probes("match", "alive") }).kind).toBe("clear");
  });

  it("holds a legacy park on a malformed ledger, naming the file", async () => {
    const root = project();
    const { id, dir } = plant(root, park());
    writeFileSync(join(globalDir, "limit-ledger.json"), "{not json");
    const before = rawText(dir);
    const r = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") expect(r.reason).toContain(join(globalDir, "limit-ledger.json"));
    expect(rawText(dir)).toBe(before);
  });

  it("holds a park on a ledger it cannot read safely: a symlink or a directory in its place", async () => {
    const root = project();
    const { id, dir } = plant(root, park());
    const path = join(globalDir, "limit-ledger.json");
    // Followed, the target would read as an empty ledger and clear the park.
    const target = join(globalDir, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, records: {} }));
    symlinkSync(target, path);
    const before = rawText(dir);
    const linked = checkSurvivingWakeAttempts(id, { globalDir });
    expect(linked.kind).toBe("held");
    if (linked.kind === "held") expect(linked.reason).toContain(`${path}: symlink`);
    expect((await normalizeRetiredLimitPark(root, id, { globalDir })).kind).toBe("failed");
    expect(rawText(dir)).toBe(before);

    rmSync(path);
    mkdirSync(path);
    const directory = checkSurvivingWakeAttempts(id, { globalDir });
    expect(directory.kind).toBe("held");
    if (directory.kind === "held") expect(directory.reason).toContain("not a regular file");
    expect(rawText(dir)).toBe(before);
  });

  it("checks the ledger before stripping any nonterminal session, and never for a terminal one (T-534 round 2)", async () => {
    const root = project();
    const running = plant(root, { state: "IMPLEMENT", limitStopPending: false });
    const ended = plant(root, park({ status: "completed", state: "SESSION_END", compactPending: false }));
    writeFileSync(join(globalDir, "limit-ledger.json"), "{not json");
    const before = rawText(running.dir);
    expect((await normalizeRetiredLimitPark(root, running.id, { globalDir })).kind).toBe("failed");
    expect(rawText(running.dir)).toBe(before);
    expect(await normalizeRetiredLimitPark(root, ended.id, { globalDir })).toMatchObject({ kind: "normalized", transition: "stripped" });
  });

  it("clears with no ledger at all", () => {
    expect(checkSurvivingWakeAttempts("s", { globalDir }).kind).toBe("clear");
  });
});

describe("FINALIZE parks", () => {
  const finalize = (over: Record<string, unknown> = {}) => park({ preCompactState: "FINALIZE", finalizeCheckpoint: null, ...over });

  it("keeps FINALIZE when the checkpoint says committed, without reading git", async () => {
    const root = project();
    const { id, dir } = plant(root, finalize({ finalizeCheckpoint: "committed" }));
    expect(await normalizeRetiredLimitPark(root, id, { globalDir })).toMatchObject({ transition: "finalize-kept" });
    expect(raw(dir)).toMatchObject({ preCompactState: "FINALIZE", state: "COMPACT", compactPending: true });
    expect(head).not.toHaveBeenCalled();
  });

  it("keeps FINALIZE for a verified item commit", async () => {
    const root = project();
    const { id, dir } = plant(root, finalize());
    head.mockResolvedValue({ ok: true, data: { hash: MOVED } } as never);
    tree.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json", "src/a.ts"] } as never);
    ancestor.mockResolvedValue({ ok: true, data: true } as never);
    expect(await normalizeRetiredLimitPark(root, id, { globalDir })).toMatchObject({ transition: "finalize-kept" });
    expect(raw(dir).preCompactState).toBe("FINALIZE");
    noLimitKeys(dir);
  });

  it.each([
    ["nothing landed", () => undefined],
    ["a divergent HEAD", () => {
      head.mockResolvedValue({ ok: true, data: { hash: MOVED } } as never);
      tree.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] } as never);
      ancestor.mockResolvedValue({ ok: true, data: false } as never);
    }],
    ["a commit without the item", () => {
      head.mockResolvedValue({ ok: true, data: { hash: MOVED } } as never);
      tree.mockResolvedValue({ ok: true, data: ["src/a.ts"] } as never);
      ancestor.mockResolvedValue({ ok: true, data: true } as never);
    }],
  ])("recovers to IMPLEMENT on %s", async (_label, arrange) => {
    const root = project();
    const { id, dir } = plant(root, finalize({ finalizeCheckpoint: "precommit_passed" }));
    arrange();
    expect(await normalizeRetiredLimitPark(root, id, { globalDir })).toMatchObject({ transition: "finalize-recovered" });
    const after = raw(dir);
    expect(after).toMatchObject({ state: "COMPACT", compactPending: true, preCompactState: "IMPLEMENT", finalizeCheckpoint: null });
    const expectedHead = (await head.mock.results[0]!.value as { data: { hash: string } }).data.hash;
    expect(after.git).toMatchObject({ expectedHead, mergeBase: expectedHead, itemBaseHead: expectedHead });
    noLimitKeys(dir);
    expect((await normalizeRetiredLimitPark(root, id, { globalDir })).kind).toBe("unchanged");
  });

  it("fails on an unreadable git answer and recovers only when forced", async () => {
    const root = project();
    const { id, dir } = plant(root, finalize());
    head.mockResolvedValue({ ok: true, data: { hash: MOVED } } as never);
    tree.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] } as never);
    ancestor.mockResolvedValue({ ok: false, reason: "git_error", message: "boom" } as never);
    const before = rawText(dir);

    const refused = await normalizeRetiredLimitPark(root, id, { globalDir });
    expect(refused.kind).toBe("failed");
    if (refused.kind === "failed") expect(refused.reason).toContain("clear-compact");
    expect(rawText(dir)).toBe(before);

    const forced = await normalizeRetiredLimitPark(root, id, { globalDir, forceUnavailableGit: true });
    expect(forced).toMatchObject({ transition: "finalize-recovered" });
    expect(raw(dir).preCompactState).toBe("IMPLEMENT");
    expect((raw(dir).git as Record<string, unknown>).expectedHead).toBe(BASE);
  });
});

describe("project passes", () => {
  it("normalises every park in the project under a held lock and reports failures by directory", async () => {
    const root = project();
    const good = plant(root, park());
    const bad = plant(root, park({ compactPending: false }));
    const plain = plant(root, { state: "IMPLEMENT" });
    const plainText = rawText(plain.dir);

    const failed = await normalizeProjectParksLocked(root, () => true, { globalDir });
    expect(failed).toEqual([expect.objectContaining({ dir: bad.dir, sessionId: bad.id, cause: { kind: "legacy-park" } })]);
    noLimitKeys(good.dir);
    expect(rawText(plain.dir)).toBe(plainText);
  });

  it("skips a missing repo and creates nothing in a repo without sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "t534-nosessions-"));
    roots.push(root);
    const gone = join(root, "gone");
    const skipped = await normalizeRetiredParksBestEffort(
      [{ projectRoot: gone, sessionId: "s1" }, { projectRoot: root, sessionId: "s2" }] as never,
      null,
      { globalDir },
    );
    expect(skipped).toEqual([`${gone}: missing`]);
    expect(readdirSync(root)).toEqual([]);
  });
});
