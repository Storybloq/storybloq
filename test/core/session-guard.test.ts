import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifySessionGuard,
  evaluateSessionGuard,
  PRE_OWNERSHIP_GATES,
  type GuardAction,
  type GuardVerdict,
  type SessionVerdict,
} from "../../src/core/session-guard.js";
import type { ActiveSessionSummary, SessionLeaseState, SessionScanResult } from "../../src/core/session-scan.js";
import { isContainedSessionDir } from "../../src/autonomous/session-selector.js";
import { currentClientTaskId } from "../../src/autonomous/client-profile.js";
import { WORKFLOW_STATES } from "../../src/autonomous/session-types.js";
import type { OwnerTask } from "../../src/autonomous/client-profile.js";

/**
 * T-446: the session guard, transcribed from the pre-T-446 guard contract.
 *
 * The fixture is the single source of truth: it carries the sentence each row
 * comes from, and the same file generates the shipped fallback prose. Citations
 * are checked against `test/fixtures/skill-step-0.5-pre-t446.md` across three
 * approved regions -- Step 0.5, the client-task-identity paragraph, and the
 * do-not-guess sentence in Step 3 -- as complete sentences, not substrings.
 *
 * That citation rule covers the ownership rows, the indeterminate-state rows,
 * the actions, and the deduplication rule. It does NOT cover the population
 * invariants or the terminal-state rule, which use the constrained
 * observed-classifier basis instead: the
 * source has no sentence about a record whose own fields contradict the array
 * carrying it, and none about a terminal session turning up in one, so those
 * rules cite nothing and instead carry a one-to-one
 * mapping onto a production gate in `PRE_OWNERSHIP_GATES` plus exact domain
 * parity against it. A row with neither a citation nor that mapping does not
 * belong in either file.
 */

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "session-guard-matrix.json");
const MATRIX = JSON.parse(readFileSync(fixturePath, "utf-8")) as MatrixFixture;

interface FixtureRow {
  readonly id: string;
  readonly description: string;
  readonly source: string;
  readonly input: {
    readonly owner: string;
    readonly compact: boolean;
    readonly compactPending: boolean;
    readonly leaseState: SessionLeaseState;
  };
  readonly verdict: Record<string, unknown>;
}

interface MatrixFixture {
  readonly identityAvailable: readonly FixtureRow[];
  readonly identityUnavailable: readonly FixtureRow[];
  readonly noVerdict: readonly {
    readonly id: string;
    readonly description: string;
    readonly input: { compact: boolean; compactPending: boolean; leaseState: SessionLeaseState };
  }[];
  readonly fallbackPolicies: readonly { id: string; rule: string; expectedAction: string }[];
  readonly entryModes: readonly { id: string; name: string; mayCallStatus: boolean }[];
  readonly indeterminateState: readonly {
    readonly id: string;
    readonly description: string;
    readonly state: string;
    readonly source: string;
    readonly verdict: Record<string, unknown>;
  }[];
  readonly actions: readonly { readonly id: string; readonly source: string }[];
  readonly dedupeRule: { readonly id: string; readonly rule: string; readonly source: string };
}

const CALLER: OwnerTask = { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" };
const OTHER: OwnerTask = { client: "claude", id: "other-task", boundAt: "2026-07-01T00:00:00Z" };

const CAPABILITY_FLAGS = [
  "resumable",
  "resumePermittedByProse",
  "requiresTakeover",
  "recoveryRequiresExplicitRequest",
  "bindsOwner",
] as const;

function ownerFor(kind: string): OwnerTask | null {
  switch (kind) {
    case "same":
      return CALLER;
    case "none":
      return null;
    default:
      // "different", "any", "any-owner" all mean a task that is not the caller's.
      return OTHER;
  }
}

function summary(overrides: Partial<ActiveSessionSummary> & { sourceDir?: string } = {}): ActiveSessionSummary {
  return {
    sessionId: "s-1",
    sourceDir: "s-1",
    state: "IMPLEMENT",
    mode: "auto",
    ticketId: "T-020",
    ticketTitle: "Task ownership",
    ownerTask: null,
    leaseExpiresAt: null,
    leaseState: "live",
    compactPending: false,
    ...overrides,
  } as ActiveSessionSummary;
}

/**
 * Build the scan result the scanner would actually produce for a row.
 *
 * Membership is not a free choice: `activeSessions` requires a LIVE lease, and
 * `resumableSessions` requires COMPACT + compactPending + a non-live lease. A
 * test that puts a row in the wrong array would assert against input the
 * scanner can never emit.
 */
function scanFor(row: FixtureRow["input"], owner: OwnerTask | null, sourceDir = "s-1"): SessionScanResult {
  const s = summary({
    sourceDir,
    sessionId: sourceDir,
    state: row.compact ? "COMPACT" : "IMPLEMENT",
    compactPending: row.compactPending,
    leaseState: row.leaseState,
    leaseExpiresAt: row.leaseState === "missing" ? null : "2026-07-01T00:00:00Z",
    ownerTask: owner,
  });
  if (row.leaseState === "live") return { activeSessions: [s], resumableSessions: [] };
  if (row.compact && row.compactPending) return { activeSessions: [], resumableSessions: [s] };
  return { activeSessions: [], resumableSessions: [] };
}

function classify(row: FixtureRow["input"], owner: OwnerTask | null, caller: OwnerTask | null): GuardVerdict {
  return classifySessionGuard(scanFor(row, owner), { task: caller, client: "claude" });
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe("classifySessionGuard: caller identity available", () => {
  for (const row of MATRIX.identityAvailable) {
    it(`row ${row.id}: ${row.description}`, () => {
      const verdict = classify(row.input, ownerFor(row.input.owner), CALLER);
      expect(verdict.sessions).toHaveLength(1);
      const got = verdict.sessions[0] as unknown as Record<string, unknown>;
      for (const [key, expected] of Object.entries(row.verdict)) {
        expect(got[key], `${key} on row ${row.id}`).toBe(expected);
      }
      // A single bearing session must produce a definite aggregate.
      expect(verdict.overallAction).toBe(row.verdict.action);
      expect(verdict.primary?.sessionId).toBe("s-1");
      expect(verdict.identityUnavailable).toBe(false);
    });
  }

  it("every row emits all five capability flags as concrete booleans, never undefined", () => {
    for (const row of MATRIX.identityAvailable) {
      const v = classify(row.input, ownerFor(row.input.owner), CALLER).sessions[0] as unknown as Record<string, unknown>;
      for (const flag of CAPABILITY_FLAGS) {
        expect(typeof v[flag], `${flag} on row ${row.id}`).toBe("boolean");
      }
    }
  });
});

describe("classifySessionGuard: caller identity unavailable", () => {
  for (const row of MATRIX.identityUnavailable) {
    it(`row ${row.id}: ${row.description}`, () => {
      const verdict = classify(row.input, ownerFor(row.input.owner), null);
      expect(verdict.identityUnavailable).toBe(true);
      const got = verdict.sessions[0] as unknown as Record<string, unknown>;
      for (const [key, expected] of Object.entries(row.verdict)) {
        expect(got[key], `${key} on row ${row.id}`).toBe(expected);
      }
    });
  }

  it("never classifies anything as same-owner: an absent identity cannot prove ownership", () => {
    for (const row of MATRIX.identityUnavailable) {
      const v = classify(row.input, ownerFor(row.input.owner), null);
      expect(v.sessions[0]?.relationship, `row ${row.id}`).not.toBe("same-owner");
    }
    // The sharpest case: the session's owner task is byte-identical to what the
    // caller WOULD present if it had an identity. Still not same-owner.
    const v = classify({ owner: "same", compact: false, compactPending: false, leaseState: "live" }, CALLER, null);
    expect(v.sessions[0]?.relationship).toBe("foreign-live");
  });

  /**
   * A data invariant, not a quoted rule. "The guide preserves legacy resume
   * behavior without binding" is scoped to the ownerless live legacy COMPACT
   * cell (U4) and is quoted in that row's own test. Here the reason is simpler
   * and applies to every row: with no caller identity there is no owner to bind,
   * so a verdict claiming otherwise would be describing a call it cannot make.
   */
  it("never binds owner, because there is no identity to bind", () => {
    for (const row of MATRIX.identityUnavailable) {
      const v = classify(row.input, ownerFor(row.input.owner), null);
      expect(v.sessions[0]?.bindsOwner, `row ${row.id}`).toBe(false);
    }
  });

  /**
   * `ownerFor` collapses `"any"` to a single realization (a foreign task), so a
   * row declaring that axis is only ever driven through one point of it. If the
   * classifier branched on owner presence anywhere under that declaration, the
   * ownerless half would go unclassified while the row still read as covering
   * it -- and `bindsOwner: false` would mean two different things depending on
   * which half you landed on. Both realizations must produce the same verdict,
   * or the axis is a fiction and the row needs splitting.
   */
  it("realizes an `any` owner axis at both ends, not just one", () => {
    // BOTH tables. Rows 7, 7b-missing, and 7b-invalid declare the same axis
    // under an available caller, and were reachable only through
    // `ownerFor("any")`, which collapses it to a foreign owner. A classifier
    // branch on owner presence could ship there while the fixture went on
    // claiming the behavior is owner-independent.
    const anyRows = [
      ...MATRIX.identityAvailable.map((r) => ({ row: r, caller: CALLER as OwnerTask | null })),
      ...MATRIX.identityUnavailable.map((r) => ({ row: r, caller: null as OwnerTask | null })),
    ].filter((e) => e.row.input.owner === "any");
    expect(anyRows.length, "no row declares owner: any -- update or drop this test").toBeGreaterThan(1);
    for (const { row, caller } of anyRows) {
      const withOwner = classify(row.input, OTHER, caller).sessions[0] as Record<string, unknown>;
      const ownerless = classify(row.input, null, caller).sessions[0] as Record<string, unknown>;

      // `ownerTask` is the observed input echoed back, so it differs by
      // construction. It is pinned here rather than dropped: excluding a field
      // without checking it is how a real divergence hides inside an exclusion.
      expect(withOwner.ownerTask, `row ${row.id}: owner echo`).toEqual(OTHER);
      expect(ownerless.ownerTask ?? null, `row ${row.id}: owner echo`).toBeNull();

      const { ownerTask: _a, ...classificationWithOwner } = withOwner;
      const { ownerTask: _b, ...classificationOwnerless } = ownerless;
      expect(classificationOwnerless, `row ${row.id}: ownerless realization`).toEqual(classificationWithOwner);
    }
  });
});

/**
 * Undetermined session state.
 *
 * Every ownership row branches on `state === "COMPACT"`, so without a state
 * check each of them silently reads `"unknown"` (what the scanner substitutes
 * for an absent field) and any typo as a valid non-COMPACT state. The sharpest
 * consequence is a same-owner caller being told to `continue` a session that
 * actually needs COMPACT recovery.
 *
 * > If state, lease, or full identity still cannot be determined, stop and tell
 * > the user to run `storybloq session list`; do not guess.
 *
 * The rule names STATE first. Driven through the real scanner rather than a
 * hand-built summary, because "the scanner substitutes unknown" is the premise.
 */
describe("undetermined session state is unverifiable, not non-COMPACT", () => {
  for (const row of MATRIX.indeterminateState) {
    it(`row ${row.id}: ${row.description}`, () => {
      const root = makeRoot();
      writeSession(root, "damaged", {
        // `status: "active"` and a live lease: nothing else about this record is
        // wrong, so only the state check can produce the verdict.
        state: row.state === "unknown" ? undefined : row.state,
        ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
        lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      });

      const v = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });
      const got = v.sessions[0] as unknown as Record<string, unknown>;
      expect(v.sessions, "the scanner must still report the session").toHaveLength(1);
      for (const [key, expected] of Object.entries(row.verdict)) {
        expect(got[key], `${key} on row ${row.id}`).toBe(expected);
      }
      expect(v.overallAction).toBe("unverifiable");
    });
  }

  /**
   * The direct-API seam, which the scanner cannot protect.
   *
   * `classifySessionGuard` is exported and callable with hand-built summaries.
   * A terminal record placed in `activeSessions` is not something a scan can
   * produce, and treating it as an ordinary non-COMPACT state hands back
   * `continue` for a session that has ENDED -- the most permissive verdict
   * there is, for the one input that should never bear.
   */
  it("refuses to certify a terminal SESSION_END record as actionable", () => {
    for (const owner of [CALLER, OTHER, null]) {
      const v = classifySessionGuard(
        { activeSessions: [summary({ ownerTask: owner, state: "SESSION_END" })], resumableSessions: [] },
        { task: CALLER, client: "claude" },
      ).sessions[0]!;
      expect(v.action, `owner ${owner?.id ?? "none"}`).toBe("unverifiable");
      expect(v.relationship).toBe("indeterminate");
      // Specifically not the same-owner shortcut, which is what it would have
      // returned for a caller that owns the finished session.
      expect(v.action).not.toBe("continue");
      expect(v.bindsOwner).toBe(false);
    }
  });

  it("does not depend on ownership: the same state is unverifiable for every owner", () => {
    for (const owner of [null, CALLER, OTHER]) {
      const v = classifySessionGuard(
        { activeSessions: [summary({ ownerTask: owner, state: "unknown" })], resumableSessions: [] },
        { task: CALLER, client: "claude" },
      ).sessions[0]!;
      expect(v.action, `owner ${owner?.id ?? "none"}`).toBe("unverifiable");
      expect(v.relationship).toBe("indeterminate");
    }
  });

  /**
   * The specific hazard, stated as its own test: a same-owner match must not
   * upgrade an undetermined state into permission to proceed.
   */
  it("a same-owner session with an undetermined state never yields `continue`", () => {
    for (const state of ["unknown", "IMPLEMNT", "", "compact"]) {
      const v = classifySessionGuard(
        { activeSessions: [summary({ ownerTask: CALLER, state })], resumableSessions: [] },
        { task: CALLER, client: "claude" },
      ).sessions[0]!;
      expect(v.action, `state ${JSON.stringify(state)}`).toBe("unverifiable");
    }
  });

  /**
   * Iterated over the production union rather than a hand-picked sample: a
   * hard-coded list would miss a regression that rejected a legitimate state the
   * sample happened to omit, and it would duplicate the very authority the gate
   * was written to stop hand-maintaining.
   *
   * Driven through the REAL scanner, because the classifier accepts states the
   * scanner never emits. `SESSION_END` is the case in point: `session-scan.ts`
   * drops it outright (`if (parsed.state === "SESSION_END") continue`), so
   * feeding it straight to `classifySessionGuard` would certify a verdict that
   * cannot occur and would stay green through scanner-level drift.
   */
  it("every state in WORKFLOW_STATES classifies normally through the real scanner", () => {
    expect(WORKFLOW_STATES.length).toBeGreaterThan(10);
    for (const state of WORKFLOW_STATES) {
      const root = makeRoot();
      writeSession(root, "mine", {
        state,
        ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });

      if (state === "SESSION_END") {
        // Terminal: the scanner omits it, so there is nothing to classify.
        expect(v.sessions, "SESSION_END must not reach the classifier").toHaveLength(0);
        expect(v.overallAction).toBe("free");
        continue;
      }

      // COMPACT is the only state that takes the recovery branch; every other
      // valid state is an ordinary same-owner continuation.
      expect(v.sessions, `state ${state}`).toHaveLength(1);
      expect(v.sessions[0]?.action, `state ${state}`).toBe(state === "COMPACT" ? "auto-resume" : "continue");
      expect(v.sessions[0]?.relationship, `state ${state}`).not.toBe("indeterminate");
    }
  });

  /**
   * The gate itself, at the pure-classifier seam. Separate from the test above
   * because that one asks what the scanner can produce; this one asks what the
   * classifier does with a valid state handed to it directly, which is the
   * contract `classifySessionGuard` exposes to any other caller.
   */
  it("accepts every BEARING WORKFLOW_STATES value at the classifier boundary", () => {
    // `SESSION_END` is excluded because it is terminal: the scanner drops it, so
    // no population can contain it, and certifying an actionable verdict for it
    // here would invent one at the only seam the scanner does not guard. Its own
    // behavior is pinned separately below.
    for (const state of WORKFLOW_STATES.filter((s) => s !== "SESSION_END")) {
      const v = classifySessionGuard(
        { activeSessions: [summary({ ownerTask: CALLER, state })], resumableSessions: [] },
        { task: CALLER, client: "claude" },
      ).sessions[0]!;
      expect(v.relationship, `state ${state}`).not.toBe("indeterminate");
      expect(v.action, `state ${state}`).not.toBe("unverifiable");
    }
  });

  /**
   * The other input seam. `classifySessionGuard` is exported and takes a plain
   * `SessionScanResult`, so `resumableSessions` is reachable by any caller, not
   * only by the scanner. `classifyResumable` inspects the LEASE alone, so
   * without the gate at the dispatch point an entry with a typo state and an
   * expired lease would be handed `offer-recovery` -- a recovery menu for a
   * session whose state nobody could read.
   */
  it("gates resumable entries too, not just active ones", () => {
    for (const state of ["unknown", "IMPLEMNT", ""]) {
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [summary({ state, compactPending: true, leaseState: "expired", ownerTask: OTHER })],
        },
        { task: CALLER, client: "claude" },
      ).sessions[0]!;
      expect(v.action, `resumable state ${JSON.stringify(state)}`).toBe("unverifiable");
      expect(v.relationship).toBe("indeterminate");
      for (const flag of CAPABILITY_FLAGS) {
        expect(v[flag], `${flag} on resumable state ${JSON.stringify(state)}`).toBe(false);
      }
    }
  });

  /**
   * A VALID but non-COMPACT state in the recovery population. The scanner never
   * builds this (`state === "COMPACT"` is a membership condition), so it is
   * unknown input rather than a case Step 0.5 describes, and guessing at it is
   * the thing the do-not-guess rule forbids.
   */
  it("refuses a recovery candidate that is valid but not COMPACT", () => {
    const v = classifySessionGuard(
      {
        activeSessions: [],
        resumableSessions: [summary({ state: "IMPLEMENT", compactPending: true, leaseState: "expired", ownerTask: OTHER })],
      },
      { task: CALLER, client: "claude" },
    ).sessions[0]!;
    expect(v.action).toBe("unverifiable");
    expect(v.relationship).toBe("indeterminate");
    expect(v.rationale).toMatch(/must be in COMPACT/i);
  });

  /**
   * The other membership invariants, for the same reason as the state gate:
   * `classifySessionGuard` is exported over a plain `SessionScanResult`, so the
   * arrays' meanings are enforced by the scanner and not by the type.
   */
  it("refuses an active entry whose lease is not live", () => {
    for (const leaseState of ["missing", "invalid", "expired"] as const) {
      const v = classifySessionGuard(
        { activeSessions: [summary({ ownerTask: CALLER, leaseState })], resumableSessions: [] },
        { task: CALLER, client: "claude" },
      ).sessions[0]!;
      // Without this, a same-owner entry with an unestablished lease gets
      // `continue`: permission to proceed from a liveness nobody verified.
      expect(v.action, `active lease ${leaseState}`).toBe("unverifiable");
      expect(v.relationship).toBe("indeterminate");
    }
  });

  it("refuses a recovery candidate without compactPending, which yields no verdict at all", () => {
    const v = classifySessionGuard(
      {
        activeSessions: [],
        resumableSessions: [summary({ state: "COMPACT", compactPending: false, leaseState: "expired", ownerTask: OTHER })],
      },
      { task: CALLER, client: "claude" },
    ).sessions[0]!;
    expect(v.action).toBe("unverifiable");
    expect(v.rationale).toMatch(/compactPending/);
  });

  it("refuses a recovery candidate whose lease is live", () => {
    const v = classifySessionGuard(
      {
        activeSessions: [],
        resumableSessions: [summary({ state: "COMPACT", compactPending: true, leaseState: "live", ownerTask: OTHER })],
      },
      { task: CALLER, client: "claude" },
    ).sessions[0]!;
    expect(v.action).toBe("unverifiable");
  });

  it("still classifies a genuine expired COMPACT recovery candidate", () => {
    // The gate must not swallow the row it sits in front of.
    const v = classifySessionGuard(
      {
        activeSessions: [],
        resumableSessions: [summary({ state: "COMPACT", compactPending: true, leaseState: "expired", ownerTask: OTHER })],
      },
      { task: CALLER, client: "claude" },
    ).sessions[0]!;
    expect(v.action).toBe("offer-recovery");
    expect(v.relationship).toBe("expired-compact");
  });
});

describe("no-verdict cells (rows 8 and 9)", () => {
  for (const row of MATRIX.noVerdict) {
    it(`row ${row.id}: ${row.description} -- appears in neither scanner array`, () => {
      const scan = scanFor({ ...row.input, owner: "different" }, OTHER);
      expect(scan.activeSessions).toHaveLength(0);
      expect(scan.resumableSessions).toHaveLength(0);
      const verdict = classifySessionGuard(scan, { task: CALLER, client: "claude" });
      expect(verdict.sessions).toHaveLength(0);
      expect(verdict.overallAction).toBe("free");
      expect(verdict.primary).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Rows that exist because a specific incident happened
// ---------------------------------------------------------------------------

describe("named regressions", () => {
  it("ISS-848: a live non-COMPACT foreign session is never resumable", () => {
    const v = classify({ owner: "different", compact: false, compactPending: false, leaseState: "live" }, OTHER, CALLER);
    expect(v.sessions[0]?.resumable).toBe(false);
    expect(v.sessions[0]?.resumePermittedByProse).toBe(false);
  });

  it("ISS-554: a live foreign session is monitor-only and authorizes no mutation", () => {
    const v = classify({ owner: "different", compact: false, compactPending: false, leaseState: "live" }, OTHER, CALLER);
    expect(v.overallAction).toBe("monitor-only");
    expect(v.sessions[0]?.resumable).toBe(false);
    expect(v.sessions[0]?.bindsOwner).toBe(false);
  });

  it("ISS-833: the verdict is pure data and never names a question tool", () => {
    const v = classify({ owner: "any", compact: true, compactPending: true, leaseState: "expired" }, OTHER, CALLER);
    const serialized = JSON.stringify(v);
    expect(serialized).not.toMatch(/AskUserQuestion/i);
    expect(serialized).not.toMatch(/structured question/i);
  });

  it("ISS-568: an empty scan is `free`, not an error and not a fallback signal", () => {
    const v = classifySessionGuard({ activeSessions: [], resumableSessions: [] }, { task: CALLER, client: "claude" });
    expect(v.overallAction).toBe("free");
    expect(v.primary).toBeNull();
    expect(v.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row 7b / U6: the do-not-guess rule
// ---------------------------------------------------------------------------

describe("undeterminable lease (rows 7b / U6, the do-not-guess rule)", () => {
  for (const lease of ["missing", "invalid"] as const) {
    for (const caller of [CALLER, null]) {
      it(`lease ${lease}, identity ${caller ? "available" : "unavailable"} -> indeterminate/unverifiable`, () => {
        const v = classify({ owner: "any", compact: true, compactPending: true, leaseState: lease }, OTHER, caller);
        const s = v.sessions[0] as unknown as Record<string, unknown>;
        expect(s.relationship).toBe("indeterminate");
        expect(s.action).toBe("unverifiable");
        for (const flag of CAPABILITY_FLAGS) {
          expect(s[flag], `${flag} with lease ${lease}`).toBe(false);
        }
      });
    }
  }

  it("does NOT sweep `expired` in with them: the three lease states stop being interchangeable here", () => {
    const v = classify({ owner: "any", compact: true, compactPending: true, leaseState: "expired" }, OTHER, CALLER);
    expect(v.sessions[0]?.relationship).toBe("expired-compact");
    expect(v.sessions[0]?.action).toBe("offer-recovery");
    expect(v.sessions[0]?.resumable).toBe(true);
  });

  it("carries the raw leaseState through so the skill can say which it was", () => {
    for (const lease of ["missing", "invalid", "expired"] as const) {
      const v = classify({ owner: "any", compact: true, compactPending: true, leaseState: lease }, OTHER, CALLER);
      expect(v.sessions[0]?.leaseState).toBe(lease);
    }
  });
});

// ---------------------------------------------------------------------------
// Aggregation: the guard declines to invent a multi-session rule
// ---------------------------------------------------------------------------

function twoSessions(a: SessionScanResult, b: SessionScanResult): SessionScanResult {
  return {
    activeSessions: [...a.activeSessions, ...b.activeSessions],
    resumableSessions: [...a.resumableSessions, ...b.resumableSessions],
  };
}

describe("aggregation", () => {
  const sameOwnerLive = () =>
    scanFor({ owner: "same", compact: false, compactPending: false, leaseState: "live" }, CALLER, "a");
  const foreignLive = () =>
    scanFor({ owner: "different", compact: false, compactPending: false, leaseState: "live" }, OTHER, "b");
  const expiredCompact = () =>
    scanFor({ owner: "any", compact: true, compactPending: true, leaseState: "expired" }, OTHER, "c");

  it("zero bearing sessions -> free, primary null", () => {
    const v = classifySessionGuard({ activeSessions: [], resumableSessions: [] }, { task: CALLER, client: "claude" });
    expect(v.overallAction).toBe("free");
    expect(v.primary).toBeNull();
  });

  it("exactly one bearing session -> that session's action, primary is it", () => {
    const v = classifySessionGuard(sameOwnerLive(), { task: CALLER, client: "claude" });
    expect(v.overallAction).toBe("continue");
    expect(v.primary?.sourceDir).toBe("a");
  });

  const multi: [string, () => SessionScanResult][] = [
    ["same-owner beside a live foreign session", () => twoSessions(sameOwnerLive(), foreignLive())],
    ["two live same-owner sessions", () => twoSessions(sameOwnerLive(), {
      activeSessions: [summary({ sessionId: "a2", sourceDir: "a2", ownerTask: CALLER })],
      resumableSessions: [],
    })],
    ["foreign-live beside an expired-compact", () => twoSessions(foreignLive(), expiredCompact())],
  ];

  for (const [label, build] of multi) {
    it(`${label} -> overallAction null, primary null, every verdict intact`, () => {
      const v = classifySessionGuard(build(), { task: CALLER, client: "claude" });
      expect(v.overallAction).toBeNull();
      expect(v.primary).toBeNull();
      expect(v.sessions).toHaveLength(2);
      for (const s of v.sessions) {
        expect(s.relationship).toBeTruthy();
        expect(s.action).toBeTruthy();
      }
    });
  }

  /**
   * The guard rail. Two earlier plan drafts invented a multi-session rule -- a
   * terminal `ambiguous` verdict, then a same-owner-first precedence -- and both
   * were wrong because Step 0.5 supplies no rule for combining sessions. This
   * test is what goes red if either creeps back in.
   */
  it("no multi-session input EVER yields a non-null overallAction", () => {
    const owners: (OwnerTask | null)[] = [CALLER, OTHER, null];
    const leases: SessionLeaseState[] = ["live", "expired", "missing", "invalid"];
    let checked = 0;
    for (const o1 of owners) {
      for (const o2 of owners) {
        for (const l1 of leases) {
          for (const l2 of leases) {
            const s1 = scanFor({ owner: "x", compact: true, compactPending: true, leaseState: l1 }, o1, "d1");
            const s2 = scanFor({ owner: "x", compact: true, compactPending: true, leaseState: l2 }, o2, "d2");
            const scan = twoSessions(s1, s2);
            const bearing = scan.activeSessions.length + scan.resumableSessions.length;
            if (bearing < 2) continue;
            const v = classifySessionGuard(scan, { task: CALLER, client: "claude" });
            expect(v.overallAction, `${l1}/${l2}`).toBeNull();
            expect(v.primary).toBeNull();
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * `overallAction: null` is only honest if the prose beside it is.
   *
   * The aggregate assertions elsewhere check the null and the absent primary,
   * which a rationale reading "apply each session's own rule" satisfies while
   * telling the caller to do precisely the thing the null declines to decide.
   * That is the ISS-554 shape delivered through user-facing text: pick the
   * permissive verdict, work beside the live foreign session.
   */
  it("reports the unresolved multiplicity instead of authorizing an action", () => {
    const v = classifySessionGuard(twoSessions(foreignLive(), sameOwnerLive()), { task: CALLER, client: "claude" });
    expect(v.overallAction).toBeNull();
    expect(v.overallRationale).toMatch(/no aggregate verdict/i);
    // Names the gap and where it is owned, so a reader knows it is unresolved
    // rather than unmentioned.
    expect(v.overallRationale).toMatch(/does not say what to do when two verdicts conflict/i);
    expect(v.overallRationale).toMatch(/ISS-898/);
    expect(v.overallRationale, "a permissive verdict must not read as a permission").toMatch(
      /unresolved hazard, not a permission/i,
    );
    // And it must resolve the conflict in NEITHER direction. Rejecting only the
    // permissive wording would let a future edit turn the null into refusal --
    // the third resolution, equally absent from the source -- while this test
    // stayed green.
    expect(v.overallRationale, "the rationale resolves the conflict permissively").not.toMatch(
      /apply each session's own rule|act on it directly/i,
    );
    expect(v.overallRationale, "the rationale resolves the conflict by refusal").not.toMatch(
      /do not act on any|take no action|refuse to act on/i,
    );
  });

  it("sorts sessions for stable rendering, and the order carries no permission", () => {
    const scan = twoSessions(foreignLive(), sameOwnerLive());
    const v = classifySessionGuard(scan, { task: CALLER, client: "claude" });
    expect(v.sessions.map((s) => s.relationship)).toEqual(["same-owner", "foreign-live"]);
    // Sorting first does not make the first one authoritative.
    expect(v.overallAction).toBeNull();
    expect(v.primary).toBeNull();
  });

  it("breaks ties by sourceDir so rendering is deterministic", () => {
    // Distinct session ids on purpose. Reusing one id here would exercise the
    // deduplication rule below instead of the render-order tiebreak, and the
    // assertion would be about the wrong mechanism.
    const mk = (dir: string) => summary({ sessionId: `id-${dir}`, sourceDir: dir, ownerTask: OTHER });
    const v = classifySessionGuard(
      { activeSessions: [mk("zzz"), mk("aaa")], resumableSessions: [] },
      { task: CALLER, client: "claude" },
    );
    expect(v.sessions.map((s) => s.sourceDir)).toEqual(["aaa", "zzz"]);
  });

  /**
   * > Read both `activeSessions` and `resumableSessions`; deduplicate by full
   * > `sessionId`.
   *
   * A transcribed sentence, and a load-bearing one. Without it, one session
   * recorded under two directories counts twice, which drives `overallAction`
   * to null and routes the caller into the multi-session fallback for what the
   * prose treats as a single session -- a visible behavior change produced by
   * omission rather than by decision.
   */
  describe("deduplicates by full sessionId", () => {
    it("counts one session recorded under two directories once", () => {
      const mk = (dir: string) => summary({ sessionId: "same-id", sourceDir: dir, ownerTask: CALLER });
      const v = classifySessionGuard(
        { activeSessions: [mk("zzz"), mk("aaa")], resumableSessions: [] },
        { task: CALLER, client: "claude" },
      );
      expect(v.sessions).toHaveLength(1);
      // Single bearing session, so an aggregate action exists at all.
      expect(v.overallAction).toBe("continue");
      // The prose names no tiebreak, so the first by read order wins and the
      // choice is deterministic rather than filesystem-dependent.
      expect(v.sessions[0]?.sourceDir).toBe("aaa");
    });

    it("deduplicates across the two arrays, not only within one", () => {
      const live = summary({ sessionId: "shared", sourceDir: "live-dir", ownerTask: CALLER });
      const pending = summary({
        sessionId: "shared",
        sourceDir: "compact-dir",
        ownerTask: CALLER,
        state: "COMPACT",
        compactPending: true,
        leaseState: "expired",
      });
      const v = classifySessionGuard({ activeSessions: [live], resumableSessions: [pending] }, { task: CALLER, client: "claude" });
      expect(v.sessions).toHaveLength(1);
      // `activeSessions` is the array the sentence names first.
      expect(v.sessions[0]?.sourceDir).toBe("live-dir");
    });

    it("records the collapse instead of performing it silently", () => {
      const mk = (dir: string) => summary({ sessionId: "same-id", sourceDir: dir, ownerTask: CALLER });
      const v = classifySessionGuard(
        { activeSessions: [mk("aaa"), mk("zzz")], resumableSessions: [] },
        { task: CALLER, client: "claude" },
      );
      const note = v.transcriptionNotes.find((n) => n.includes("same-id"));
      expect(note, `no note recorded: ${JSON.stringify(v.transcriptionNotes)}`).toBeDefined();
      // The dropped record is exactly the concealment ISS-897 tracks, so the
      // note has to point there rather than reading as a routine collapse.
      expect(note).toContain("ISS-897");
      // BOTH directories, and which is which. Naming only the dropped one hides
      // what survived; naming only the survivor loses the thing to go delete.
      expect(note, "note does not name the dropped directory").toContain("zzz");
      expect(note, "note does not name the retained directory").toContain("aaa");
      expect(note, "note does not say which one survived").toMatch(/kept aaa, dropped zzz/);
    });

    it("leaves distinct session ids alone", () => {
      const a = summary({ sessionId: "a", sourceDir: "a-dir", ownerTask: CALLER });
      const b = summary({ sessionId: "b", sourceDir: "b-dir", ownerTask: OTHER });
      const v = classifySessionGuard({ activeSessions: [a, b], resumableSessions: [] }, { task: CALLER, client: "claude" });
      expect(v.sessions).toHaveLength(2);
      expect(v.overallAction).toBeNull();
    });
  });

  it("renders both sessionId and sourceDir, because the CLI selector is the directory", () => {
    const v = classifySessionGuard(
      { activeSessions: [summary({ sessionId: "embedded-id", sourceDir: "on-disk-dir", ownerTask: OTHER })], resumableSessions: [] },
      { task: CALLER, client: "claude" },
    );
    expect(v.sessions[0]?.sessionId).toBe("embedded-id");
    expect(v.sessions[0]?.sourceDir).toBe("on-disk-dir");
  });
});

// ---------------------------------------------------------------------------
// U2: the one row where the two resume flags diverge (ISS-898)
// ---------------------------------------------------------------------------

describe("U2 and the resumable / resumePermittedByProse split (ISS-898)", () => {
  it("U2 records both facts: the prose permits it, the server will not accept it", () => {
    const v = classify({ owner: "any-owner", compact: true, compactPending: false, leaseState: "live" }, OTHER, null);
    expect(v.sessions[0]?.resumePermittedByProse).toBe(true);
    expect(v.sessions[0]?.resumable).toBe(false);
    expect(v.sessions[0]?.requiresTakeover).toBe(true);
  });

  /**
   * The split must not spread. `resumable` is descriptive only in T-446; if a
   * future edit starts deriving behavior from it, the first symptom is the two
   * flags diverging somewhere they should not.
   */
  it("the two flags are equal on every OTHER row in both tables", () => {
    const rows: [string, FixtureRow, OwnerTask | null][] = [
      ...MATRIX.identityAvailable.map((r) => [`available/${r.id}`, r, CALLER] as [string, FixtureRow, OwnerTask | null]),
      ...MATRIX.identityUnavailable
        .filter((r) => r.id !== "U2")
        .map((r) => [`unavailable/${r.id}`, r, null] as [string, FixtureRow, OwnerTask | null]),
    ];
    for (const [label, row, caller] of rows) {
      const s = classify(row.input, ownerFor(row.input.owner), caller).sessions[0];
      expect(s?.resumable, label).toBe(s?.resumePermittedByProse);
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy id is ignored (ISS-899)
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-guard-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

function writeSession(root: string, dir: string, state: Record<string, unknown>): string {
  const path = join(root, ".story", "sessions", dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "state.json"),
    JSON.stringify({
      sessionId: dir,
      status: "active",
      state: "IMPLEMENT",
      mode: "auto",
      ticket: { id: "T-020", title: "Task ownership" },
      compactPending: false,
      lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      ...state,
    }),
  );
  return path;
}

/**
 * ISS-899. `liveOwnershipConflict` resolves ownership by `ownerTask`, else
 * `claudeCodeSessionId`, else no conflict. Step 0.5 has no such precedence --
 * `claudeCodeSessionId` appears nowhere in SKILL.md, and its only rule for an
 * ownerTask-absent session is the legacy pair, which inspects no id.
 *
 * This must run through `evaluateSessionGuard` over a real tree. The scanner
 * does not project the field into `ActiveSessionSummary`, so a classifier-level
 * assertion would be vacuous: the field is not in its input at all.
 */
describe("legacy claudeCodeSessionId is ignored (ISS-899)", () => {
  const cases = [
    ["matching the caller", "caller-task"],
    ["a different id", "someone-elses-task"],
    ["an id that fails CLIENT_TASK_ID_PATTERN", "not a valid id!!"],
  ] as const;

  for (const [label, legacyId] of cases) {
    it(`a session with no ownerTask and ${label} is unowned-legacy`, () => {
      const root = makeRoot();
      writeSession(root, "legacy", { ownerTask: null, claudeCodeSessionId: legacyId });
      const v = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });
      expect(v.sessions).toHaveLength(1);
      expect(v.sessions[0]?.relationship).toBe("unowned-legacy");
      expect(v.overallAction).toBe("monitor-only");
    });
  }

  it("all three classify identically, flags included", () => {
    const verdicts = cases.map(([, legacyId]) => {
      const root = makeRoot();
      writeSession(root, "legacy", { ownerTask: null, claudeCodeSessionId: legacyId });
      const s = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" }).sessions[0]!;
      return CAPABILITY_FLAGS.map((f) => (s as unknown as Record<string, unknown>)[f]);
    });
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[2]).toEqual(verdicts[0]);
  });
});

// ---------------------------------------------------------------------------
// Preserved fail-open: paths where the scanner conceals a session (ISS-897)
// ---------------------------------------------------------------------------

/**
 * Every fault here uses a WRONG FILE TYPE rather than chmod. A chmod-based
 * EACCES test running as root reads the file anyway and passes for the wrong
 * reason -- which is exactly the failure mode this block exists to catch. The
 * kernel rejects a wrong file type identically for every user.
 */
describe("preserved fail-open: scanner concealment (ISS-897)", () => {
  const evaluate = (root: string) => evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });

  it("state.json is a directory (EISDIR) -> session vanishes, verdict free", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "broken", "state.json"), { recursive: true });
    expect(evaluate(root).overallAction).toBe("free");
  });

  it("state.json is truncated JSON -> session vanishes, verdict free", () => {
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "truncated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), '{"status":"active"');
    expect(evaluate(root).overallAction).toBe("free");
  });

  it(".story/sessions is a file (ENOTDIR) -> empty scan, verdict free", () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-guard-"));
    roots.push(root);
    mkdirSync(join(root, ".story"), { recursive: true });
    writeFileSync(join(root, ".story", "sessions"), "not a directory");
    expect(evaluate(root).overallAction).toBe("free");
  });

  /**
   * Named for the dirent filter, not for containment. `readdirSync` with
   * `withFileTypes` produces lstat-based dirents, so a symlink answers
   * `isSymbolicLink()` and is dropped by `entry.isDirectory()` one line BEFORE
   * `isContainedSessionDir` is consulted. A test claiming to exercise
   * containment here would be asserting against a branch it never reaches.
   */
  it("a symlinked session entry is dropped by the entry.isDirectory() filter", () => {
    const root = makeRoot();
    const real = join(root, "outside-session");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "state.json"), JSON.stringify({ sessionId: "linked", status: "active", state: "IMPLEMENT" }));
    symlinkSync(real, join(root, ".story", "sessions", "linked"));
    expect(evaluate(root).overallAction).toBe("free");
  });

  it("a parseable record with no `status` key vanishes", () => {
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "nostatus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ sessionId: "nostatus", state: "IMPLEMENT" }));
    expect(evaluate(root).overallAction).toBe("free");
  });

  it("a parseable active record in SESSION_END vanishes", () => {
    const root = makeRoot();
    writeSession(root, "ended", { state: "SESSION_END" });
    expect(evaluate(root).overallAction).toBe("free");
  });

  it("an ownerTask that fails validation reads as unowned-legacy, not foreign-live", () => {
    const root = makeRoot();
    writeSession(root, "badowner", { ownerTask: { client: "claude", id: "", boundAt: 1 } });
    const v = evaluate(root);
    expect(v.sessions[0]?.relationship).toBe("unowned-legacy");
    expect(v.sessions[0]?.ownerTask).toBeNull();
  });
});

/**
 * Containment gets its own direct unit test, because through real dirents the
 * branch is defense in depth rather than a reachable path.
 */
describe("isContainedSessionDir rejects an escaping path directly", () => {
  it("rejects a directory resolving outside the canonical sessions root", () => {
    const root = makeRoot();
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    const link = join(root, ".story", "sessions", "escape");
    symlinkSync(outside, link);
    expect(isContainedSessionDir(root, link)).toBe(false);
  });

  it("accepts a real directory under the sessions root", () => {
    const root = makeRoot();
    const inside = join(root, ".story", "sessions", "ok");
    mkdirSync(inside, { recursive: true });
    expect(isContainedSessionDir(root, inside)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateSessionGuard: caller resolution
// ---------------------------------------------------------------------------

describe("evaluateSessionGuard caller resolution", () => {
  const ENV_KEYS = ["STORYBLOQ_CLIENT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"] as const;

  /** Sets exactly the given vars, clears the rest, and restores all three after. */
  const withEnv = (vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void) => {
    const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const key of ENV_KEYS) {
      const value = vars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const key of ENV_KEYS) {
        const value = prev[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  /**
   * Both directions run. If `opts.client` were ignored in only one direction the
   * single-direction test would still pass, which is the whole point.
   */
  it("honors an explicit opts.client over the environment (claude case)", () => {
    withEnv({ STORYBLOQ_CLIENT: "codex" }, () => {
      const root = makeRoot();
      writeSession(root, "owned", {
        ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });
      expect(v.sessions[0]?.relationship).toBe("same-owner");
      expect(v.overallAction).toBe("continue");
    });
  });

  it("honors an explicit opts.client over the environment (codex case)", () => {
    withEnv({ STORYBLOQ_CLIENT: "claude" }, () => {
      const root = makeRoot();
      writeSession(root, "owned", {
        ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "codex" });
      expect(v.sessions[0]?.relationship).toBe("foreign-live");
    });
  });

  it("falls back to the environment when opts.client is omitted", () => {
    withEnv({ STORYBLOQ_CLIENT: "codex" }, () => {
      const root = makeRoot();
      writeSession(root, "owned", {
        ownerTask: { client: "codex", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, { clientTaskId: "caller-task" });
      expect(v.sessions[0]?.relationship).toBe("same-owner");
    });
  });

  it("sets identityUnavailable only when nothing supplies an id, environment included", () => {
    withEnv({}, () => {
      const root = makeRoot();
      writeSession(root, "owned", {
        ownerTask: { client: "claude", id: "someone", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, { clientTaskId: null, client: "claude" });
      expect(v.identityUnavailable).toBe(true);
      expect(v.sessions[0]?.relationship).toBe("foreign-live");
    });
  });

  /**
   * The guide resolves its caller as `explicit ?? environment`
   * (`ownerTaskForCurrentClient` -> `currentClientTaskId`). A guard that skipped
   * the environment fallback would tell a Claude caller that omitted
   * `clientTaskId` -- a path SKILL.md documents as supported -- that its OWN
   * session is foreign, and steer it to monitor-only.
   */
  it("inherits the environment task id when clientTaskId is omitted entirely", () => {
    withEnv({ STORYBLOQ_CLIENT: "claude", CLAUDE_CODE_SESSION_ID: "inherited-task" }, () => {
      const root = makeRoot();
      writeSession(root, "mine", {
        ownerTask: { client: "claude", id: "inherited-task", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, {});
      expect(v.identityUnavailable).toBe(false);
      expect(v.sessions[0]?.relationship).toBe("same-owner");
      expect(v.overallAction).toBe("continue");
    });
  });

  /**
   * `null` and omission are the SAME signal here, and that is a decision rather
   * than an accident: `currentClientTaskId` resolves `explicit ?? environment`,
   * and the guard exists to transcribe the guide, not to improve on it. Making
   * null mean "force identity unavailable" would give the guard a capability the
   * resolver it mirrors does not have, and the MCP schema could not express it
   * anyway (string-or-omitted).
   *
   * The equivalence is asserted against `currentClientTaskId` directly so the
   * two cannot drift: if that resolver ever stops treating null as omission,
   * this goes red rather than the guard quietly disagreeing with the guide.
   */
  it("treats an explicit null the same as omission, exactly as currentClientTaskId does", () => {
    withEnv({ STORYBLOQ_CLIENT: "claude", CLAUDE_CODE_SESSION_ID: "inherited-task" }, () => {
      const root = makeRoot();
      writeSession(root, "mine", {
        ownerTask: { client: "claude", id: "inherited-task", boundAt: "2026-07-01T00:00:00Z" },
      });

      // The resolver this mirrors: both spellings land on the environment id.
      expect(currentClientTaskId(null)).toBe("inherited-task");
      expect(currentClientTaskId()).toBe("inherited-task");

      const viaNull = evaluateSessionGuard(root, { clientTaskId: null });
      const viaOmission = evaluateSessionGuard(root, {});
      expect(viaNull.sessions[0]?.relationship).toBe("same-owner");
      expect(viaNull.identityUnavailable).toBe(false);
      expect(viaNull.overallAction).toBe(viaOmission.overallAction);
      expect(viaNull.identityUnavailable).toBe(viaOmission.identityUnavailable);
    });
  });

  /**
   * The cross-client pairing bug: resolving the environment id through
   * `currentClientTaskId()` re-reads `STORYBLOQ_CLIENT` independently, so an
   * explicit `opts.client` of "claude" could be handed `CODEX_THREAD_ID`. Both
   * directions run, because pairing the wrong variable in only one direction
   * would leave a single-direction test green.
   */
  it("pairs an explicit opts.client with ITS OWN environment variable (claude)", () => {
    withEnv({ STORYBLOQ_CLIENT: "codex", CLAUDE_CODE_SESSION_ID: "claude-task", CODEX_THREAD_ID: "codex-task" }, () => {
      const root = makeRoot();
      writeSession(root, "mine", {
        ownerTask: { client: "claude", id: "claude-task", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, { client: "claude" });
      expect(v.sessions[0]?.relationship).toBe("same-owner");
    });
  });

  it("pairs an explicit opts.client with ITS OWN environment variable (codex)", () => {
    withEnv({ STORYBLOQ_CLIENT: "claude", CLAUDE_CODE_SESSION_ID: "claude-task", CODEX_THREAD_ID: "codex-task" }, () => {
      const root = makeRoot();
      writeSession(root, "mine", {
        ownerTask: { client: "codex", id: "codex-task", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, { client: "codex" });
      expect(v.sessions[0]?.relationship).toBe("same-owner");
    });
  });

  it("does not let the wrong client's environment id prove ownership", () => {
    withEnv({ STORYBLOQ_CLIENT: "codex", CODEX_THREAD_ID: "codex-task" }, () => {
      const root = makeRoot();
      // Session owned by a CODEX task; caller explicitly claims to be Claude and
      // has no Claude id. Reading CODEX_THREAD_ID here would fake a match.
      writeSession(root, "theirs", {
        ownerTask: { client: "codex", id: "codex-task", boundAt: "2026-07-01T00:00:00Z" },
      });
      const v = evaluateSessionGuard(root, { client: "claude" });
      expect(v.identityUnavailable).toBe(true);
      expect(v.sessions[0]?.relationship).toBe("foreign-live");
    });
  });

  it("a project with no .story/ is free, not an error", () => {
    const bare = mkdtempSync(join(tmpdir(), "storybloq-guard-bare-"));
    roots.push(bare);
    const v = evaluateSessionGuard(bare, { clientTaskId: "caller-task", client: "claude" });
    expect(v.overallAction).toBe("free");
    expect(v.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cost: the guard must not touch the ledger
// ---------------------------------------------------------------------------

describe("cost (behavioral half; the no-read claim is proven in session-guard-cost.test.ts)", () => {
  it("is unaffected by a large or malformed ledger", () => {
    const root = makeRoot();
    const tickets = join(root, ".story", "tickets");
    mkdirSync(tickets, { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      const id = `T-${String(i).padStart(3, "0")}`;
      writeFileSync(join(tickets, `${id}.json`), JSON.stringify({ id, title: `Ticket ${i}`, status: "open" }));
    }
    writeSession(root, "live", { ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" } });

    const before = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });
    expect(before.overallAction).toBe("continue");

    // Make every ticket unreadable-as-JSON. This shows the ledger cannot affect
    // the verdict; it does NOT show the files go unread, because a reader that
    // swallowed parse errors would look identical. That claim needs
    // instrumentation, which lives in session-guard-cost.test.ts.
    for (let i = 0; i < 3; i += 1) {
      writeFileSync(join(tickets, `T-${String(i).padStart(3, "0")}.json`), "{ not json");
    }
    const after = evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });
    expect(after.overallAction).toBe("continue");
    expect(after.sessions[0]?.relationship).toBe(before.sessions[0]?.relationship);
  });
});

// ---------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------

/**
 * The matrix tests above use the fixture as BOTH input and expected oracle, and
 * I authored the fixture and the classifier together. That is circular: a row
 * whose expectation matches a wrong implementation passes. These assertions are
 * written directly against the behavior, independent of the fixture, so the two
 * have to agree with something outside themselves.
 */
describe("independent assertions (no fixture)", () => {
  const live = (owner: OwnerTask | null, compact: boolean) =>
    classifySessionGuard(
      { activeSessions: [summary({ ownerTask: owner, state: compact ? "COMPACT" : "IMPLEMENT" })], resumableSessions: [] },
      { task: CALLER, client: "claude" },
    ).sessions[0]!;

  const pending = (lease: SessionLeaseState, caller: OwnerTask | null) =>
    classifySessionGuard(
      { activeSessions: [], resumableSessions: [summary({ state: "COMPACT", compactPending: true, leaseState: lease, ownerTask: OTHER })] },
      { task: caller, client: "claude" },
    ).sessions[0]!;

  it("own live session continues and is not resumable", () => {
    const v = live(CALLER, false);
    expect(v.relationship).toBe("same-owner");
    expect(v.action).toBe("continue");
    expect(v.resumable).toBe(false);
  });

  it("own compacted session auto-resumes and binds", () => {
    const v = live(CALLER, true);
    expect(v.action).toBe("auto-resume");
    expect(v.bindsOwner).toBe(true);
  });

  it("foreign live session is monitor-only with no resume of any kind", () => {
    const v = live(OTHER, false);
    expect(v.action).toBe("monitor-only");
    expect(v.resumable).toBe(false);
    expect(v.resumePermittedByProse).toBe(false);
  });

  it("foreign compacted session stays monitor-only but permits explicit takeover", () => {
    const v = live(OTHER, true);
    expect(v.action).toBe("monitor-only");
    expect(v.requiresTakeover).toBe(true);
    expect(v.recoveryRequiresExplicitRequest).toBe(true);
  });

  it("ownerless live session is unowned-legacy, monitor-only when not compacted", () => {
    expect(live(null, false).relationship).toBe("unowned-legacy");
    expect(live(null, false).action).toBe("monitor-only");
    expect(live(null, true).action).toBe("auto-resume");
  });

  it("expired pending COMPACT offers recovery; missing and invalid do not", () => {
    expect(pending("expired", CALLER).action).toBe("offer-recovery");
    expect(pending("missing", CALLER).action).toBe("unverifiable");
    expect(pending("invalid", CALLER).action).toBe("unverifiable");
  });

  it("U2 alone splits the two resume flags", () => {
    const u2 = live(OTHER, true);
    expect(u2.resumable).toBe(true); // identity available: they agree
    const u2NoIdentity = classifySessionGuard(
      { activeSessions: [summary({ ownerTask: OTHER, state: "COMPACT" })], resumableSessions: [] },
      { task: null, client: "claude" },
    ).sessions[0]!;
    expect(u2NoIdentity.resumePermittedByProse).toBe(true);
    expect(u2NoIdentity.resumable).toBe(false);
  });

  /**
   * `bindsOwner` on the two recovery rows, asserted without the fixture.
   *
   * These are the cells where a wrong value is most costly and least visible: a
   * recovery that binds when it should not silently transfers ownership of
   * someone else's session, and one that fails to bind leaves the ledger naming
   * a task that is gone. The fixture was authored alongside the classifier, so
   * the same mistaken rule in both would stay green through the matrix tests.
   *
   * > Live legacy session without `ownerTask`, COMPACT: call `resume` with the
   * > full `sessionId` and current `clientTaskId`; this migration recovery binds
   * > the current task. If task identity is unavailable, the guide preserves
   * > legacy resume behavior without binding.
   */
  it("ownerless legacy COMPACT binds with a caller identity and not without one", () => {
    const withIdentity = live(null, true);
    expect(withIdentity.relationship).toBe("unowned-legacy");
    expect(withIdentity.action).toBe("auto-resume");
    expect(withIdentity.bindsOwner).toBe(true);

    const withoutIdentity = classifySessionGuard(
      { activeSessions: [summary({ ownerTask: null, state: "COMPACT" })], resumableSessions: [] },
      { task: null, client: "claude" },
    ).sessions[0]!;
    expect(withoutIdentity.action).toBe("auto-resume");
    // "preserves legacy resume behavior WITHOUT binding" -- the resume still
    // happens; only the binding is withheld.
    expect(withoutIdentity.bindsOwner).toBe(false);

    // The rationale is user-facing and reaches `overallRationale`, so a flag and
    // a sentence that disagree ship a contradiction rather than an explanation.
    expect(withIdentity.rationale).toMatch(/resume and bind/i);
    expect(withoutIdentity.rationale).toMatch(/without binding/i);
    expect(withoutIdentity.rationale).not.toMatch(/resume and bind/i);
  });

  /**
   * U5, the row two drafts got wrong in opposite directions.
   *
   * The expired-COMPACT bullet says recovery passes the current `clientTaskId`
   * and rebinds ownership. With no caller identity neither is possible, and the
   * bullet has no variant for that. One draft filled the gap by borrowing "the
   * guide preserves legacy resume behavior without binding" from the OWNERLESS
   * LIVE LEGACY COMPACT bullet, which is a different cell. The next filled it by
   * blocking the offer, citing "If state, lease, or full identity still cannot be
   * determined, stop" -- but that sentence is about a SESSION whose observation
   * is incomplete, not about a caller with no task id, and it sat beside rules on
   * rerunning the guard and inspecting a named session. Quoting exactly is not
   * the same as quoting something that applies.
   *
   * The paragraph that IS about the caller says the opposite of blocking:
   *
   * > Missing or malformed identity never blocks the legacy workflow, but it
   * > cannot prove same-task ownership. Task identity is accidental-concurrency
   * > protection, not a security boundary; when identity is unavailable, guide
   * > ownership checks preserve the legacy fail-open behavior.
   *
   * So the offer stands, and `bindsOwner` is false as a fact of the call rather
   * than by exception. The prose gap is ISS-898 case 3.
   */
  it("expired COMPACT still offers recovery without an identity, binding no new ownerTask", () => {
    const withIdentity = pending("expired", CALLER);
    expect(withIdentity.action).toBe("offer-recovery");
    expect(withIdentity.bindsOwner).toBe(true);

    const withoutIdentity = pending("expired", null);
    // Preserved, not blocked: "missing identity never blocks the legacy workflow".
    expect(withoutIdentity.action).toBe("offer-recovery");
    expect(withoutIdentity.relationship).toBe("expired-compact");
    expect(withoutIdentity.resumePermittedByProse).toBe(true);
    // No new `ownerTask` to bind, because there is no id -- not because a
    // rule says so. The legacy field is a separate question (ISS-899).
    expect(withoutIdentity.bindsOwner).toBe(false);
    // The rationale reaches the user through `overallRationale`, so the
    // field-specific outcome has to be IN it, not merely true of the code.
    expect(withoutIdentity.rationale).toMatch(/no new `ownerTask` is bound/i);
    expect(withoutIdentity.rationale).toMatch(/any `ownerTask` already recorded is preserved/i);
    expect(withoutIdentity.rationale).toMatch(/derives `claudeCodeSessionId` from `ownerTask`/i);
    expect(withoutIdentity.rationale).toMatch(/cleared for a codex owner/i);
    // And the gap is surfaced rather than smoothed over.
    expect(withoutIdentity.rationale).toMatch(/ISS-898/);
  });

  it("compactPending false with a non-live lease is omitted by the scanner contract", () => {
    for (const lease of ["expired", "missing", "invalid"] as const) {
      const scan = scanFor({ owner: "different", compact: true, compactPending: false, leaseState: lease }, OTHER);
      expect(scan.activeSessions.length + scan.resumableSessions.length, lease).toBe(0);

      // Positive control, and not a formality: "zero sessions" is exactly what a
      // fixture that never wrote a session also produces, so without this the
      // assertion above would survive a setup typo and prove nothing. Flipping
      // the one field under test has to produce a session.
      const pendingScan = scanFor({ owner: "different", compact: true, compactPending: true, leaseState: lease }, OTHER);
      expect(
        pendingScan.activeSessions.length + pendingScan.resumableSessions.length,
        `${lease}: the fixture produces no session even with compactPending, so the omission above is vacuous`,
      ).toBe(1);
    }
  });
});

describe("fixture integrity", () => {
  /**
   * Provenance, checked against the actual document rather than by length.
   *
   * This is the assertion that breaks the circle. Everything else in this
   * ticket derives from the fixture -- the classifier tests, the generated
   * fallback, the byte-identity check -- so a fabricated or drifted citation
   * would propagate everywhere and be contradicted by nothing.
   *
   * The oracle is SKILL.md as it stood BEFORE T-446, frozen at
   * `test/fixtures/skill-step-0.5-pre-t446.md`, because that is the text being
   * transcribed: T-446 deliberately moved these sentences out of SKILL.md and
   * into the generated fallback, so checking the current SKILL.md would fail for
   * the wrong reason and checking the fallback would be circular.
   *
   * Two things make this strict rather than decorative:
   *
   * 1. Only three NAMED regions are quotable, not the whole 504-line file. The
   *    guard transcribes Step 0.5, plus the client-task-identity paragraph it
   *    depends on, plus the do-not-guess sentence that lives in Step 3. A
   *    sentence lifted from anywhere else is not provenance for this module.
   * 2. Each citation fragment must equal a run of COMPLETE consecutive
   *    sentences. A substring check would accept a quote with its tail cut off,
   *    and the tails are where the rules live: "do not guess", "do not ask for
   *    another confirmation", "without binding".
   */
  const BASE_DOC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "skill-step-0.5-pre-t446.md"),
    "utf-8",
  );

  const normalize = (text: string): string => text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

  /** Text from `start` up to the next blank line. */
  function paragraphFrom(start: string): string {
    const i = BASE_DOC.indexOf(start);
    expect(i, `frozen document has no paragraph starting "${start}"`).toBeGreaterThan(-1);
    const rest = BASE_DOC.slice(i);
    const end = rest.indexOf("\n\n");
    return end === -1 ? rest : rest.slice(0, end);
  }

  function sectionBetween(start: string, end: string): string {
    const a = BASE_DOC.indexOf(start);
    const b = BASE_DOC.indexOf(end);
    expect(a, `frozen document has no "${start}"`).toBeGreaterThan(-1);
    expect(b, `frozen document has no "${end}"`).toBeGreaterThan(a);
    return BASE_DOC.slice(a, b);
  }

  /** The exact sentence, not the paragraph around it. */
  function sentenceFrom(start: string): string {
    const i = BASE_DOC.indexOf(start);
    expect(i, `frozen document has no sentence starting "${start}"`).toBeGreaterThan(-1);
    const rest = BASE_DOC.slice(i);
    const end = rest.indexOf(".", start.length);
    expect(end, `sentence starting "${start}" is unterminated`).toBeGreaterThan(-1);
    return rest.slice(0, end + 1);
  }

  /**
   * The only quotable text. Three regions, each named because the guard actually
   * depends on it, rather than the whole 504-line file:
   *   - Step 0.5 itself.
   *   - The client-task-identity paragraph, which supplies the rule that an
   *     absent identity cannot prove ownership.
   *   - The do-not-guess SENTENCE from Step 3, taken alone. Its paragraph also
   *     contains unrelated rules about rerunning the guard and inspecting a named
   *     session, and admitting those would let a row cite authority for something
   *     this module does not transcribe.
   */
  const QUOTABLE_REGIONS = [
    sectionBetween("## Step 0.5: Active session guard", "## How to Handle Arguments"),
    paragraphFrom("**Client task identity.**"),
    sentenceFrom("If state, lease, or full identity still cannot be determined"),
  ];

  /**
   * Complete sentences, grouped BY REGION. Flattening into one list would let a
   * fragment join the last sentence of one region to the first of the next and
   * still count as "consecutive", though they never appeared together.
   */
  const SENTENCES_BY_REGION: string[][] = QUOTABLE_REGIONS.map((region) =>
    region
      .split(/\n(?=\s*[-*]\s|\s*\d+\.\s)/)
      // Strip a leading bullet/step marker, and strip a heading LINE rather than
      // discarding its block: prose that follows a heading on the next line is
      // still quotable text, and dropping it would silently make a legitimate
      // citation unprovable.
      .map((block) => normalize(block.replace(/^\s*(?:[-*]\s|\d+\.\s)/, "").replace(/^\s*#{1,6} [^\n]*\n?/, "")))
      .filter((block) => block.length > 0 && !block.startsWith("#"))
      .flatMap((block) => block.split(/(?<=\.)\s+(?=[A-Z`(])/))
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0),
  );

  /** Whether `fragment` is one or more consecutive whole sentences of ONE region. */
  function isCompleteQuote(fragment: string): boolean {
    return SENTENCES_BY_REGION.some((sentences) => {
      for (let i = 0; i < sentences.length; i += 1) {
        let acc = "";
        for (let j = i; j < sentences.length; j += 1) {
          acc = acc.length === 0 ? sentences[j]! : `${acc} ${sentences[j]!}`;
          if (acc === fragment) return true;
          if (acc.length > fragment.length + 5) break;
        }
      }
      return false;
    });
  }

  /**
   * An ACCIDENTAL-DRIFT DETECTOR, not an independent authority. Stating that
   * plainly because the weaker claim is the true one: this constant lives in the
   * same writable change set as the document it pins, so an author who edits the
   * frozen text, updates the citations, and re-runs `shasum` satisfies it. What
   * it does buy is real but bounded -- the frozen document can no longer drift
   * unnoticed, and any intentional change to it becomes a visible, deliberate
   * edit to a hard-coded digest that a reviewer will see rather than a quiet
   * change inside a 504-line fixture.
   *
   * Making it resistant to a determined author means moving the expected digest
   * outside the change set (protected CI configuration, or verification against
   * the pre-T-446 git revision). That is worth doing if this provenance ever
   * needs to hold against someone motivated to fabricate it; it does not hold
   * against that today.
   *
   * To update intentionally: confirm the new content really is the pre-T-446
   * text at the revision you claim, run `shasum -a 256` on the file, and replace
   * the constant in the same commit as the citation changes it enables.
   */
  it("the frozen document is byte-for-byte the artifact the citations were taken from", () => {
    const digest = createHash("sha256").update(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "skill-step-0.5-pre-t446.md"),
    )).digest("hex");
    expect(digest, "the frozen oracle changed; see the update procedure above this test").toBe(
      "a0ebf19d3d997744a47797a2bd2eff4f9b67f5fe3e15fe414821bf2450327cf3",
    );
  });

  it("the frozen document really is the pre-T-446 SKILL.md", () => {
    // Guards the guard. An empty fixture would fail every check below loudly,
    // but one pointing at the WRONG document would not, so identity is asserted.
    expect(BASE_DOC).toContain("## Step 0.5: Active session guard");
    // The prose matrix T-446 removes must still be present.
    expect(BASE_DOC).toContain("**Same owner, non-COMPACT:**");
    expect(BASE_DOC).toContain("**Expired COMPACT session:**");
    // And the tool this ticket introduces must be absent.
    expect(BASE_DOC).not.toContain("storybloq_session_guard");
    expect(SENTENCES_BY_REGION.flat().length, "no quotable sentences were extracted").toBeGreaterThan(40);
    expect(SENTENCES_BY_REGION).toHaveLength(3);
    // The Step 3 region is one sentence, not its whole paragraph: the paragraph's
    // other rules (rerun the guard once, inspect with session_report) are not
    // things this module transcribes and must not be citable as if they were.
    expect(SENTENCES_BY_REGION[2]).toHaveLength(1);
    expect(SENTENCES_BY_REGION[2]![0]).toMatch(/do not guess\.$/);
  });

  /**
   * Rows AND actions. The action names (`continue`, `monitor-only`, ...) are
   * T-446's own vocabulary and appear nowhere in the frozen document, which is
   * exactly why their citations need the same check the rows get: an earlier
   * draft "cited" sentences written in that vocabulary, which is transcribing
   * the implementation and calling it the source.
   */
  /**
   * Exactness is not applicability, and the generic check only proves the first.
   *
   * `dedupeRule` would pass it while citing any complete Step 0.5 sentence at
   * all -- including one about relay or cancellation -- because that check asks
   * whether the text appears in the document, never whether it says what the
   * rule does. This is the same failure U5 had twice, in a place where a
   * mis-citation would justify collapsing sessions with a sentence about
   * something else entirely.
   */
  it("the dedup rule cites the sentence that actually supplies deduplication", () => {
    const source = normalize(MATRIX.dedupeRule.source);
    // EQUALITY, not containment. "Contains the rule, lacks one named neighbour"
    // still admits any other complete sentence appended from the same region,
    // which is how a citation grows scope it was never checked for.
    expect(source, "the dedup citation is not exactly the sentence that supplies the rule").toBe(
      "Read both `activeSessions` and `resumableSessions`; deduplicate by full `sessionId`.",
    );
  });

  it("every row and action quotes the frozen document as complete sentences", () => {
    const cited: { id: string; source: string }[] = [
      ...MATRIX.identityAvailable,
      ...MATRIX.identityUnavailable,
      ...MATRIX.indeterminateState,
      ...MATRIX.actions,
      // The dedup rule is a transcribed sentence like any other, so it is held
      // to the same standard. It was OMITTED entirely from an earlier draft --
      // the one class of defect this whole check exists to catch -- and an
      // unregistered rule is invisible to it.
      MATRIX.dedupeRule,
    ];
    expect(cited.length).toBeGreaterThan(20);

    for (const item of cited) {
      expect(item.source, `${item.id} has no citation`).toBeTruthy();
      // ` / ` joins excerpts from separate places; each must stand alone, so a
      // citation cannot be assembled from pieces that never appeared together.
      const fragments = normalize(item.source)
        .split(" / ")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      expect(fragments.length, `${item.id} has an empty citation`).toBeGreaterThan(0);

      for (const fragment of fragments) {
        expect(
          isCompleteQuote(fragment),
          `${item.id} cites text that is not one or more complete sentences of the quotable regions:\n  ${fragment}`,
        ).toBe(true);
      }
    }
  });

  /**
   * Exactness is not applicability -- the lesson U5 taught twice. A citation can
   * quote perfectly and still fail to justify the verdict it sits under, so the
   * rows where that went wrong get an assertion about WHICH sentences they cite,
   * not merely that the sentences are real.
   */
  it("U5 cites both the rule it follows and the rule that limits it", () => {
    const u5 = MATRIX.identityUnavailable.find((r) => r.id === "U5");
    expect(u5, "U5 is missing").toBeTruthy();
    // The verdict IS the expired-COMPACT menu, so that sentence has to be there:
    // the caller-identity paragraph alone explains why the offer survives, not
    // what the offer is.
    expect(u5!.source, "U5 does not cite the recovery rule it implements").toContain(
      "Expired COMPACT session: offer Resume here, End session, or Back.",
    );
    // And the sentences that explain why an identity-free caller still gets it.
    expect(u5!.source, "U5 does not cite why missing identity does not block it").toContain(
      "Missing or malformed identity never blocks the legacy workflow",
    );
    // Not the ownerless-legacy exception, which belongs to U4 and was borrowed
    // here by an earlier draft.
    expect(u5!.source, "U5 borrowed U4's binding exception again").not.toContain(
      "preserves legacy resume behavior without binding",
    );
    // Not the do-not-guess sentence, which is about a session's observability
    // rather than a caller's identity, and was used here by a later draft.
    expect(u5!.source, "U5 cites the session-observability rule as if it were about the caller").not.toContain(
      "still cannot be determined",
    );
  });

  it("keeps interpretation out of `source` and in `note`", () => {
    for (const row of [
      ...MATRIX.identityAvailable,
      ...MATRIX.identityUnavailable,
      ...MATRIX.indeterminateState,
      ...MATRIX.actions,
    ]) {
      // Elisions and parentheticals are how commentary creeps into a quotation.
      expect(row.source, `${row.id} elides part of its quote`).not.toContain("...");
      expect(row.source, `${row.id} names T-446 inside a quotation`).not.toContain("T-446");
    }
  });

  it("pins every fallback policy's action explicitly", () => {
    const expected: Record<string, string> = {
      "missing-arrays": "unverifiable",
      "json-status-unavailable": "monitor-only",
      // The COMPACT half of the same older-server sentence. Its absence would
      // leave the markdown-status COMPACT path with no rule at all. It maps to a
      // fallback-only procedure rather than a GuardAction: `offer-recovery`
      // presents a Resume / End session / Back menu, and this sentence presents
      // nothing and waits to be asked.
      "json-status-compact": "sessionstart-on-request",
      "do-not-guess": "unverifiable",
    };
    expect(MATRIX.fallbackPolicies.map((p) => p.id).sort()).toEqual(Object.keys(expected).sort());
    for (const policy of MATRIX.fallbackPolicies) {
      expect(policy.expectedAction, `policy ${policy.id}`).toBe(expected[policy.id]);
    }
  });

  /**
   * An absent `activeSessions` or `resumableSessions` key is NOT an empty array.
   * It means the server did not report that population -- an older-server
   * signal. Reading it as "nothing is running" authorizes work beside a session
   * nobody disclosed, which is the exact fail-open this ticket must not add.
   */
  it("never lets a missing status array read as `free`", () => {
    const policy = MATRIX.fallbackPolicies.find((p) => p.id === "missing-arrays")!;
    expect(policy.expectedAction).not.toBe("free");
    expect(policy.rule).toMatch(/not an empty array|never proceed/i);
  });

  it("declares two entry modes, and only mode A may call storybloq_status", () => {
    expect(MATRIX.entryModes).toHaveLength(2);
    expect(MATRIX.entryModes.find((m) => m.id === "A")?.mayCallStatus).toBe(true);
    expect(MATRIX.entryModes.find((m) => m.id === "B")?.mayCallStatus).toBe(false);
  });
});

/**
 * Provenance for the population invariants, which is a DIFFERENT kind of claim
 * from every other row in the fixture.
 *
 * The rows and actions cite the frozen pre-T-446 SKILL.md, and the suite above
 * proves each citation is a run of complete consecutive sentences from a
 * quotable region. These rules cannot: Step 0.5 has no sentence about a record
 * whose own fields contradict the array carrying it, because the prose never
 * contemplates one. So they declare `basis: "observed-classifier"` instead, and
 * that claim needs its own proof -- otherwise "no prose covers this" becomes the
 * loophole through which invented fail-closed policy enters the generated file
 * and passes every citation check by never making one.
 *
 * What is proven here: each rule names a real gate, the gate it names is the one
 * that actually fires for its own declared inputs, and the declared set is
 * exactly the production set.
 */
describe("population-invariant provenance (basis, not citation)", () => {
  const fixtureDoc = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "session-guard-matrix.json"), "utf-8"),
  ) as {
    terminalStateRule: {
      id: string;
      classifierGateId: string;
      basis: string;
      basisNote: string;
      population: string;
      verdict: Record<string, unknown>;
      input: { states: string | string[]; compactPending: string | boolean[]; leaseStates: string | string[] };
    };
    populationInvariantRules: {
      id: string;
      population: string;
      input: { states: string; compactPending: string | boolean[]; leaseStates: string | string[] };
      classifierGateId: string;
      basis: string;
      basisNote: string;
      verdict: Record<string, unknown>;
      source?: string;
    }[];
    gateOrder: { id: string; documentedIn: string }[];
  };

  const STATE_PROBES = [
    ...WORKFLOW_STATES,
    // Probes for `any`, which claims the predicate never reads the field. One
    // bogus token would only catch a narrowing that happened to exclude that
    // token; these cover the shapes a narrowing plausibly takes -- empty, blank,
    // case-shifted, whitespace-padded, and non-ASCII.
    "",
    " ",
    "compact",
    "COMPACT ",
    " COMPACT",
    "session_end",
    "NOT_A_WORKFLOW_STATE",
  ];
  const ALL_STATES = STATE_PROBES;
  const ALL_LEASES = ["live", "expired", "missing", "invalid"];
  const expandStates = (v: string | string[]): string[] =>
    Array.isArray(v) ? v : v === "any" ? ALL_STATES : v === "any-except-COMPACT" ? ALL_STATES.filter((x) => x !== "COMPACT") : JSON.parse(v);
  const expandPending = (v: string | boolean[]): boolean[] => (v === "any" ? [true, false] : (v as boolean[]));
  const expandLeases = (v: string | string[]): string[] => (v === "any" ? ALL_LEASES : (v as string[]));

  it("declares the production gate set exactly, so a new gate cannot go unregistered", () => {
    expect(fixtureDoc.gateOrder.map((g) => g.id)).toEqual(PRE_OWNERSHIP_GATES.map((g) => g.id));
  });

  /**
   * One rule per gate, and the rule IS the gate. Without this, an author can add
   * an arbitrary fifth rule that reuses an existing `classifierGateId`, declares
   * a domain where that gate happens to fire, copies its all-false verdict, and
   * omits `source` -- and every provenance assertion below still passes while the
   * published file gains a rule nothing supports.
   */
  it("maps one-to-one onto the production gates it documents", () => {
    const ids = fixtureDoc.populationInvariantRules.map((r) => r.classifierGateId);
    expect(new Set(ids).size, "two rules claim the same gate").toBe(ids.length);
    for (const rule of fixtureDoc.populationInvariantRules) {
      // The rule's own id must BE the gate's, so a rule cannot be documented
      // under one name and derive its authority from another.
      expect(rule.id, `\`${rule.id}\` is documented under a name that is not its gate`).toBe(rule.classifierGateId);
      // A typo here would otherwise fall through as an activeSessions record and
      // silently test the wrong population.
      expect(["activeSessions", "resumableSessions"]).toContain(rule.population);
    }
    // And the set is exactly the gates the Population invariants section owns:
    // the ones `gateOrder` assigns to it, no more and no fewer.
    const owned = fixtureDoc.gateOrder
      .filter((g) => g.documentedIn === "Population invariants")
      .map((g) => g.id)
      .sort();
    expect(ids.sort(), "the population rules and the gates assigned to that section have diverged").toEqual(owned);
  });

  const expandPopulations = (v: string): string[] =>
    v === "both" ? ["activeSessions", "resumableSessions"] : [v];

  it("constrains the terminal rule the same way, since it publishes gate behavior too", () => {
    const t = fixtureDoc.terminalStateRule;
    expect(t.id).toBe(t.classifierGateId);
    expect(t.basis).toBe("observed-classifier");
    // `both` is load-bearing: the scanner puts SESSION_END in neither array, so
    // a record carrying it is unknown input wherever it turns up.
    expect(t.population).toBe("both");
    expect(expandPopulations(t.population)).toEqual(["activeSessions", "resumableSessions"]);
    expect(PRE_OWNERSHIP_GATES.map((g) => g.id)).toContain(t.classifierGateId);
    expect((t as { source?: string }).source, "the terminal rule claims a prose citation it does not have").toBeUndefined();
  });

  it("names a real gate and claims a basis rather than a citation", () => {
    const known = new Set(PRE_OWNERSHIP_GATES.map((g) => g.id));
    for (const rule of [...fixtureDoc.populationInvariantRules, fixtureDoc.terminalStateRule]) {
      expect(known.has(rule.classifierGateId), `\`${rule.id}\` names a gate that does not exist`).toBe(true);
      expect(rule.basis).toBe("observed-classifier");
      // It must NOT also claim prose authority; that is the mislabel this checks for.
      expect(rule.source, `\`${rule.id}\` claims a prose citation for a rule the prose does not make`).toBeUndefined();
      expect(rule.basisNote).toMatch(/PRE_OWNERSHIP_GATES/);
      expect(rule.basisNote).toMatch(/observed/i);
    }
  });

  it("declares exactly the gate's domain, in both directions and across both populations", () => {
    // Population is part of the key. Fixing `expectCompact` to each rule's own
    // population left a gate free to start firing in the OPPOSITE array without
    // any test noticing -- the published domain would simply omit it.
    const POPULATIONS = [
      { name: "activeSessions", expectCompact: false },
      { name: "resumableSessions", expectCompact: true },
    ];
    const key = (pop: string, st: string, pd: boolean, ls: string): string => `${pop}|${st}|${pd}|${ls}`;
    const make = (st: string, pd: boolean, ls: string): never =>
      ({
        sessionId: "s-p",
        sourceDir: "s-p",
        state: st,
        mode: "auto",
        compactPending: pd,
        leaseState: ls,
        leaseExpiresAt: null,
        ownerTask: null,
      }) as never;

    const rulesWithDomains: {
      id: string;
      classifierGateId: string;
      populations: string[];
      input: { states: string | string[]; compactPending: string | boolean[]; leaseStates: string | string[] };
    }[] = [
      ...fixtureDoc.populationInvariantRules.map((r) => ({
        id: r.id,
        classifierGateId: r.classifierGateId,
        populations: [r.population],
        input: r.input,
      })),
      {
        id: fixtureDoc.terminalStateRule.id,
        classifierGateId: fixtureDoc.terminalStateRule.classifierGateId,
        // Derived from the DECLARED population, not hard-coded: hard-coding it
        // made the field decorative, so changing or deleting it changed nothing.
        populations: expandPopulations(fixtureDoc.terminalStateRule.population),
        input: fixtureDoc.terminalStateRule.input,
      },
    ];

    for (const rule of rulesWithDomains) {
      const gate = PRE_OWNERSHIP_GATES.find((g) => g.id === rule.classifierGateId)!;

      const declared = new Set<string>();
      for (const pop of rule.populations) {
        const expectCompact = pop === "resumableSessions";
        for (const st of expandStates(rule.input.states)) {
          for (const pd of expandPending(rule.input.compactPending)) {
            for (const ls of expandLeases(rule.input.leaseStates)) {
              declared.add(key(pop, st, pd, ls));
              expect(
                gate.applies(make(st, pd, ls), expectCompact),
                `\`${rule.id}\` claims ${pop}/${st}/${pd}/${ls} but its gate does not fire there`,
              ).toBe(true);
            }
          }
        }
      }

      // Sweep BOTH populations regardless of what the rule declares, so a gate
      // that crosses the array boundary shows up as an undeclared point.
      const actual = new Set<string>();
      for (const pop of POPULATIONS) {
        for (const st of ALL_STATES) {
          for (const pd of [true, false]) {
            for (const ls of ALL_LEASES) {
              if (gate.applies(make(st, pd, ls), pop.expectCompact)) actual.add(key(pop.name, st, pd, ls));
            }
          }
        }
      }

      expect([...declared].sort(), `\`${rule.id}\`: declared domain is not the gate's domain`).toEqual(
        [...actual].sort(),
      );
      expect(declared.size, `\`${rule.id}\` declares an empty domain`).toBeGreaterThan(0);
    }
  });

  it("adds no policy the classifier does not already apply", () => {
    // The literal claim in every basisNote. Each declared shape must reach the
    // classifier's own all-false unverifiable verdict, so the fixture cannot
    // tighten behavior the tool does not have.
    //
    // The terminal rule is swept HERE too, across both populations it claims.
    // Excluded, the classifier could stop applying that gate to
    // `resumableSessions` while every domain and provenance test stayed green,
    // leaving mode A publishing a verdict the tool no longer produces.
    const swept = [
      ...fixtureDoc.populationInvariantRules.map((r) => ({ ...r, populations: [r.population] })),
      { ...fixtureDoc.terminalStateRule, populations: expandPopulations(fixtureDoc.terminalStateRule.population) },
    ];
    for (const rule of swept) {
      let perRule = 0;
      for (const population of rule.populations) {
      const expectCompact = population === "resumableSessions";
      for (const state of expandStates(rule.input.states)) {
        for (const pending of expandPending(rule.input.compactPending)) {
          for (const leaseState of expandLeases(rule.input.leaseStates)) {
            const summary = {
              sessionId: "s-p",
              sourceDir: "s-p",
              state,
              mode: "auto",
              compactPending: pending,
              leaseState,
              leaseExpiresAt: null,
              ownerTask: null,
            } as never;
            const v = classifySessionGuard(
              expectCompact
                ? { activeSessions: [], resumableSessions: [summary] }
                : { activeSessions: [summary], resumableSessions: [] },
              { task: null, client: "claude" },
            ).sessions[0]! as unknown as Record<string, unknown>;
            for (const [key, expected] of Object.entries(rule.verdict)) {
              expect(
                v[key],
                `\`${rule.id}\` (${population}/${state}/${pending}/${leaseState}) declares \`${key}\` the classifier does not produce`,
              ).toBe(expected);
            }
            perRule += 1;
          }
        }
      }
      }
      expect(perRule, `\`${rule.id}\` was never exercised: its declared domain is empty`).toBeGreaterThan(0);
    }
  });
});

/**
 * The action-collapse check, generalized from the defect it exists to prevent.
 *
 * One action name can legitimately serve several prose cells -- but only when
 * they prescribe the same procedure. `monitor-only` covered `foreign-live` AND
 * `unowned-legacy` with a single unconditional "render foreign-task UX", which
 * handed a session whose ownership cannot be verified a flow built entirely
 * around an owner task that does not exist. Nothing caught it, because nothing
 * looked at the action-to-relationship mapping at all.
 *
 * So: any action whose rows span more than one relationship must either branch
 * on `relationship` in its instruction, or record why collapsing them is safe.
 * A new row that widens an action across relationships fails this until someone
 * makes that choice deliberately.
 */
describe("population reaches the caller, because the reconciliation needs it", () => {
  /**
   * Step 2 compares a fingerprint of the classification INPUTS. Population is
   * one of them (`expectCompact`), it is not derivable from the other fields for
   * a population-invariant violation, and it was not serialized -- so the
   * reconciliation SKILL.md prescribes could not be performed at all.
   */
  const owner = { client: "claude" as const, id: "caller-task", boundAt: "2026-07-01T00:00:00Z" };

  it("distinguishes two otherwise identical records by the array they arrived in", () => {
    const summary = {
      sessionId: "s-same",
      sourceDir: "s-same",
      state: "COMPACT",
      mode: "auto",
      compactPending: true,
      leaseState: "expired",
      leaseExpiresAt: null,
      ownerTask: owner,
    } as never;

    const asResumable = classifySessionGuard(
      { activeSessions: [], resumableSessions: [summary] },
      { task: owner, client: "claude" },
    ).sessions[0]!;
    expect(asResumable.population).toBe("resumableSessions");

    // The identical record in the other array: same id, state, lease, owner.
    const asActive = classifySessionGuard(
      { activeSessions: [summary], resumableSessions: [] },
      { task: owner, client: "claude" },
    ).sessions[0]!;
    expect(asActive.population).toBe("activeSessions");

    // Same fields everywhere else, so nothing else could have carried it.
    expect(asActive.sessionId).toBe(asResumable.sessionId);
    expect(asActive.state).toBe(asResumable.state);
    expect(asActive.leaseState).toBe(asResumable.leaseState);
  });

  it("carries it on every verdict, including gate rejections", () => {
    const broken = {
      sessionId: "s-broken",
      sourceDir: "s-broken",
      state: "IMPLEMENT",
      mode: "auto",
      compactPending: true,
      leaseState: "expired",
      leaseExpiresAt: null,
      ownerTask: owner,
    } as never;
    const v = classifySessionGuard(
      { activeSessions: [], resumableSessions: [broken] },
      { task: owner, client: "claude" },
    ).sessions[0]!;
    // A population-invariant rejection: the population is exactly what cannot be
    // inferred from the remaining fields here.
    expect(v.action).toBe("unverifiable");
    expect(v.population).toBe("resumableSessions");
  });
});

describe("actions serving several relationships", () => {
  const matrix = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "session-guard-matrix.json"), "utf-8"),
  ) as {
    identityAvailable: { id: string; verdict: { action: string; relationship: string } }[];
    identityUnavailable: { id: string; verdict: { action: string; relationship: string } }[];
    actions: { id: string; instruction: string; collapseJustification?: string }[];
  };

  const spans = new Map<string, Set<string>>();
  for (const row of [...matrix.identityAvailable, ...matrix.identityUnavailable]) {
    const set = spans.get(row.verdict.action) ?? new Set<string>();
    set.add(row.verdict.relationship);
    spans.set(row.verdict.action, set);
  }

  it("each either branches on relationship or justifies the collapse", () => {
    const multi = [...spans.entries()].filter(([, rels]) => rels.size > 1);
    // Guards the guard: if no action spans relationships, this suite proves
    // nothing and the mapping has changed shape.
    expect(multi.length, "no action spans multiple relationships; the check is vacuous").toBeGreaterThan(0);

    for (const [actionId, rels] of multi) {
      const action = matrix.actions.find((a) => a.id === actionId);
      expect(action, `no action entry for \`${actionId}\``).toBeDefined();
      const branches = /BRANCH ON `relationship`/i.test(action!.instruction);
      expect(
        branches || Boolean(action!.collapseJustification),
        `\`${actionId}\` serves ${[...rels].sort().join(" and ")} with one undifferentiated procedure and no ` +
          `recorded reason why that is safe`,
      ).toBe(true);
    }
  });

  it("the one that must branch, does, and names both cells", () => {
    // Named explicitly rather than left to the general rule: this is the cell
    // pair whose collapse was a live defect.
    expect(spans.get("monitor-only")).toEqual(new Set(["foreign-live", "unowned-legacy"]));
    const monitor = matrix.actions.find((a) => a.id === "monitor-only")!;
    expect(monitor.instruction).toMatch(/BRANCH ON `relationship` FIRST/);
    expect(monitor.instruction).toMatch(/`foreign-live`/);
    expect(monitor.instruction).toMatch(/`unowned-legacy`/);
    expect(monitor.instruction).toMatch(/do not offer Open task, do not relay/i);
  });
});

/**
 * Type-level guard rail against an aggregate action creeping back into the
 * union. The previous form was inert: a type alias is legal even when it
 * resolves to `never`, so reintroducing "ambiguous" would not have failed the
 * build. `Assert<T extends true>` forces the constraint to be checked.
 */
type Assert<T extends true> = T;
export type _AssertNoAmbiguousAction = Assert<[Extract<GuardAction, "ambiguous">] extends [never] ? true : false>;
export type _AssertVerdictActionIsGuardAction = Assert<SessionVerdict["action"] extends GuardAction ? true : false>;
