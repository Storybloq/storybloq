/**
 * ISS-556: Asymmetric validation on lensReviewHistory.disposition wedges sessions.
 *
 * Layer 1 (write-side): MCP input schema must reject invalid dispositions.
 *                       buildLensHistoryUpdate must normalize unknown → "open".
 * Layer 2 (read-side):  readSessionResilient recovers ONLY from disposition
 *                       corruption; strict failures on any other field → null.
 *
 * These tests must fail before the fix ships.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  LENS_FINDING_DISPOSITIONS,
  type LensFindingDisposition,
} from "../../src/autonomous/session-types.js";
import { readSession, readSessionResilient, writeSessionSync } from "../../src/autonomous/session.js";
import { buildLensHistoryUpdate } from "../../src/autonomous/stages/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeSessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iss556-"));
  createdRoots.push(dir);
  return dir;
}

/** Minimal valid state.json shape; callers override the fields they want to test. */
function baseState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "INIT",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: null, mergeBase: null },
    lease: {
      workspaceId: "test-ws",
      lastHeartbeat: now,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
    ...overrides,
  };
}

function validLensEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticketId: "T-001",
    stage: "CODE_REVIEW",
    lens: "security",
    category: "hardcoded-secret",
    severity: "high",
    disposition: "addressed",
    description: "token hardcoded",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function writeStateFile(dir: string, state: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// 1. MCP input schema — disposition enum rejects unknown values
// ---------------------------------------------------------------------------

describe("ISS-556 Layer 1: disposition enum at input boundary", () => {
  it("LENS_FINDING_DISPOSITIONS contains exactly the four canonical values", () => {
    expect([...LENS_FINDING_DISPOSITIONS].sort()).toEqual(
      ["addressed", "contested", "deferred", "open"],
    );
  });

  it("z.enum(LENS_FINDING_DISPOSITIONS) rejects 'fixed' with an enumerating error", () => {
    const schema = z.enum(LENS_FINDING_DISPOSITIONS);
    const result = schema.safeParse("fixed");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      // Error enumerates all valid values so the agent can self-correct.
      expect(msg).toMatch(/open/);
      expect(msg).toMatch(/addressed/);
      expect(msg).toMatch(/contested/);
      expect(msg).toMatch(/deferred/);
    }
  });

  it("z.enum(LENS_FINDING_DISPOSITIONS) accepts all four canonical values", () => {
    const schema = z.enum(LENS_FINDING_DISPOSITIONS);
    for (const d of LENS_FINDING_DISPOSITIONS) {
      expect(schema.safeParse(d).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2-4. buildLensHistoryUpdate normalization
// ---------------------------------------------------------------------------

describe("ISS-556 Layer 1b: buildLensHistoryUpdate normalization", () => {
  it("normalizes unknown disposition strings to 'open'", () => {
    const updated = buildLensHistoryUpdate(
      [{ category: "cat-a", severity: "high", description: "d", disposition: "fixed", lens: "security" }],
      [],
      "T-001",
      "CODE_REVIEW",
    );
    expect(updated).not.toBeNull();
    expect(updated![0].disposition).toBe("open");
  });

  it("preserves all four valid dispositions verbatim", () => {
    for (const d of LENS_FINDING_DISPOSITIONS) {
      const updated = buildLensHistoryUpdate(
        [{ category: `cat-${d}`, severity: "high", description: "d", disposition: d, lens: "security" }],
        [],
        "T-001",
        "CODE_REVIEW",
      );
      expect(updated).not.toBeNull();
      expect(updated![0].disposition).toBe(d);
    }
  });

  it("preserves the existing undefined → 'open' fallback", () => {
    const updated = buildLensHistoryUpdate(
      [{ category: "cat-a", severity: "high", description: "d", lens: "security" }],
      [],
      "T-001",
      "CODE_REVIEW",
    );
    expect(updated).not.toBeNull();
    expect(updated![0].disposition).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// 5-9. readSession vs readSessionResilient
// ---------------------------------------------------------------------------

describe("ISS-556 Layer 2: readSessionResilient disposition-only recovery", () => {
  it("strict readSession returns null when a disposition is outside the enum", () => {
    const dir = makeSessionDir();
    writeStateFile(
      dir,
      baseState({ lensReviewHistory: [validLensEntry({ disposition: "fixed" })] }),
    );
    expect(readSession(dir)).toBeNull();
  });

  it("readSessionResilient recovers by dropping entries with invalid dispositions", () => {
    const dir = makeSessionDir();
    const good = validLensEntry({ disposition: "addressed", category: "good" });
    const bad = validLensEntry({ disposition: "fixed", category: "bad" });
    writeStateFile(dir, baseState({ lensReviewHistory: [good, bad] }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const recovered = readSessionResilient(dir);
      expect(recovered).not.toBeNull();
      expect(recovered!.lensReviewHistory).toHaveLength(1);
      expect(recovered!.lensReviewHistory[0].category).toBe("good");
      // One warning line should have been emitted.
      const warnings = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("readSessionResilient"));
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("readSessionResilient does NOT silently recover from null entries in lensReviewHistory", () => {
    // False-positive guard: a null entry produces zod issues at path
    // ["lensReviewHistory", 0] (length 2), not at .disposition. Must fall
    // through and return null rather than "recover" by filtering nulls.
    const dir = makeSessionDir();
    writeStateFile(dir, baseState({ lensReviewHistory: [null] }));
    expect(readSessionResilient(dir)).toBeNull();
  });

  it("readSessionResilient refuses to recover when required top-level fields are missing", () => {
    const dir = makeSessionDir();
    const state = baseState();
    delete (state as Record<string, unknown>).sessionId;
    writeStateFile(dir, state);
    expect(readSessionResilient(dir)).toBeNull();
  });

  it("readSessionResilient refuses mixed corruption (bad disposition + non-disposition issue)", () => {
    // Must NOT partially recover: if ANY zod issue is outside lensReviewHistory.N.disposition,
    // the whole recovery is aborted. This prevents "I fixed the disposition so we're good"
    // masking of unrelated corruption.
    const dir = makeSessionDir();
    const state = baseState({
      lensReviewHistory: [validLensEntry({ disposition: "fixed" })],
    });
    delete (state as Record<string, unknown>).sessionId;
    writeStateFile(dir, state);
    expect(readSessionResilient(dir)).toBeNull();
  });

  it("readSessionResilient refuses structural corruption at the disposition path", () => {
    // Codex round-1 finding: the recovery predicate must distinguish
    // "invalid enum value" (the one recoverable case) from other zod errors
    // at the same path. A null or wrong-type disposition is structural
    // corruption, not the ISS-556 incident pattern — must NOT silent-recover.
    const dir = makeSessionDir();
    writeStateFile(
      dir,
      baseState({
        lensReviewHistory: [validLensEntry({ disposition: null as unknown as string })],
      }),
    );
    expect(readSessionResilient(dir)).toBeNull();
  });

  it("readSessionResilient refuses missing-disposition-field corruption", () => {
    // Another structural-corruption shape: the disposition key is absent.
    // Zod reports this as invalid_type at path [...,"disposition"], but it is
    // NOT an invalid enum value, so recovery must NOT trigger.
    const dir = makeSessionDir();
    const bad = validLensEntry();
    delete (bad as Record<string, unknown>).disposition;
    writeStateFile(dir, baseState({ lensReviewHistory: [bad] }));
    expect(readSessionResilient(dir)).toBeNull();
  });

  it("readSessionResilient returns the strict parse unchanged when the file is valid", () => {
    const dir = makeSessionDir();
    writeStateFile(
      dir,
      baseState({ lensReviewHistory: [validLensEntry({ disposition: "addressed" })] }),
    );
    const strict = readSession(dir);
    const resilient = readSessionResilient(dir);
    expect(resilient).not.toBeNull();
    expect(resilient).toEqual(strict);
  });
});

// ---------------------------------------------------------------------------
// 10. Round-trip invariant
// ---------------------------------------------------------------------------

describe("ISS-556 round-trip", () => {
  it("valid dispositions survive write → read unchanged", () => {
    const dir = makeSessionDir();
    // Seed a valid state via writeStateFile so writeSessionSync has something to increment.
    writeStateFile(dir, baseState());
    const loaded = readSession(dir)!;
    const entries: LensFindingDisposition[] = ["open", "addressed", "contested", "deferred"];
    const history = entries.map((d, i) =>
      validLensEntry({ disposition: d, category: `cat-${i}` }),
    );
    const next = { ...loaded, lensReviewHistory: history as never } as typeof loaded;
    writeSessionSync(dir, next);
    const reread = readSession(dir);
    expect(reread).not.toBeNull();
    expect(reread!.lensReviewHistory.map((e) => e.disposition)).toEqual(entries);
  });
});
