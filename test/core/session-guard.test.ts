import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifySessionGuard,
  collisionBlocksAggregate,
  completenessFromDiagnostics,
  evaluateSessionGuard,
  POLICY_SIGNATURE_FIELDS,
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

describe("fixture ids", () => {
  it("does not collide across the directory names this file uses", () => {
    // `idFor` is a 32-bit FNV-1a, so uniqueness is a property of THIS set and
    // not of the function. Without this, a colliding pair would make two
    // unrelated sessions share an id and quietly exercise deduplication --
    // changing what an unrelated test measures rather than failing it.
    const ids = FIXTURE_DIRS.map(idFor);
    expect(new Set(ids).size, `colliding fixture ids: ${ids.join(", ")}`).toBe(FIXTURE_DIRS.length);
    // ...and each is a session id the production contract accepts, which is why
    // the helper exists at all.
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

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
      // The prose names no tiebreak, so the first by read order wins and the
      // choice is deterministic rather than filesystem-dependent.
      expect(v.sessions[0]?.sourceDir).toBe("aaa");
      // The RECORD's own verdict stands -- it is correct for the record that was
      // observed, and the caller still needs to know what was found.
      expect(v.sessions[0]?.action).toBe("continue");
      // The AGGREGATE now stands too, and this is the expectation ISS-914
      // changed. The dropped record is classified and compared against the
      // survivor on the policy signature; here both records name the same owner
      // and the same state, so the signatures match, the dropped record could
      // not have changed the answer, and withholding would have stopped the
      // operator over a difference that does not exist.
      //
      // A collision whose records DISAGREE still withholds, unchanged: see the
      // `duplicate sessionId with conflicting owners (ISS-914)` block below.
      expect(v.overallAction).toBe("continue");
      // Waiving the BLOCK is not waiving the REPORT. All three carriers still
      // name the collision.
      expect(v.collisions).toHaveLength(1);
      expect(v.transcriptionNotes.join(" ")).toContain("kept aaa, dropped zzz");
      expect(v.overallRationale).toContain("matched its survivor on the policy signature");
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

/**
 * A UUID derived from a directory name, stable and distinct per name.
 *
 * `sessionId: dir` was convenient and unfaithful: `SessionStateSchema` declares
 * `z.string().uuid()`, so `"true-legacy"` is a value no writer in this codebase
 * can produce and every strict reader rejects. Fixtures carrying one made the
 * scanner's `session-id-invalid` path fire across the whole suite once that
 * contract was enforced -- which is the fixture being wrong, not the rule.
 *
 * Derived rather than random so a test can still reason about which record is
 * which. The hash is 32-bit, so this is NOT injective in general -- two
 * directory names could in principle collide and quietly exercise
 * duplicate-session-id behaviour in a test that meant nothing of the kind. It
 * is safe here because the fixture set is small and fixed, and `FIXTURE_DIRS`
 * below pins that it does not collide; a wider set would need a wider digest. Tests that need two directories to SHARE
 * an id pass `sessionId` explicitly and are unaffected.
 */
function idFor(dir: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < dir.length; i += 1) {
    h = Math.imul(h ^ dir.charCodeAt(i), 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, "0");
  return `${hex}-1111-4222-8333-${hex}44444444`.slice(0, 36);
}

/**
 * Every directory name this file feeds through `idFor`.
 *
 * Listed rather than derived, because the point is to fail when the set grows:
 * a 32-bit hash is not injective, so a new fixture directory that happens to
 * collide with an existing one would silently turn an unrelated test into a
 * duplicate-session-id test. Adding a directory means adding it here.
 */
const FIXTURE_DIRS = [
  // Every directory name passed through `writeSession`/`idFor`, which is
  // narrower than "every directory this file creates": a name missing from
  // here is a GENERATED id the collision check below never looked at, and
  // `damaged-owner` was exactly that. Directories created by hand for scanner
  // faults (`broken`, `truncated`, and the like) receive no generated id and
  // need no entry; `writeSession` throws for anything else, so the two cannot
  // drift again.
  "aaa-first", "badowner", "damaged", "damaged-owner", "ended", "from-the-future",
  "legacy", "live", "mine", "nostatus", "owned", "readable-owner",
  "stale-looking", "theirs", "true-legacy", "weirdstatus", "zzz-second",
] as const;

const REGISTERED_FIXTURE_DIRS = new Set<string>(FIXTURE_DIRS);

function writeSession(root: string, dir: string, state: Record<string, unknown>): string {
  // ENFORCED, not documented. `FIXTURE_DIRS` claims to be every fixture name
  // and the uniqueness check below is only as good as that claim; nothing
  // connected the two, so a new directory could be written here, collide with
  // an existing generated id, and leave the check green. `damaged-owner` was
  // exactly that case.
  if (!REGISTERED_FIXTURE_DIRS.has(dir)) {
    throw new Error(`fixture directory "${dir}" is not registered in FIXTURE_DIRS; add it there so its generated id is checked for collisions`);
  }
  const path = join(root, ".story", "sessions", dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "state.json"),
    JSON.stringify({
      sessionId: idFor(dir),
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
 * ISS-899. The guide resolves ownership by `ownerTask`, else
 * `claudeCodeSessionId`, else no conflict. Step 0.5 has no such precedence:
 * `claudeCodeSessionId` gives it no ownership rule, and its only rule for an
 * ownerTask-absent session is the legacy pair, which inspects no id.
 *
 * STILL GREEN AFTER ISS-899 WAS RULED, and that is the point of this note
 * rather than an accident. The ruling closed the OTHER cell (a live
 * `ownerTask` session met by a caller with no identity, where the guide now
 * refuses as this guard always advised) and deliberately left THIS one split:
 * the guard keeps classifying on `ownerTask` alone, the guide keeps
 * adjudicating the legacy id, and SKILL.md now describes that adjudication
 * instead of promising a bind. So these cases pin unchanged behaviour on
 * purpose. Enforcement's side of both cells is pinned in
 * `test/autonomous/ownership-iss899.test.ts`; if this block ever goes red,
 * read that file before changing anything here.
 *
 * Note also what these cases are NOT: `writeSession` defaults `state` to
 * `IMPLEMENT` with a live lease, so every one of them is the live
 * non-COMPACT unowned-legacy cell. The divergence the issue names bites on the
 * COMPACT variant, which the enforcement file covers.
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
 * This block used to be named "preserved fail-open" and asserted `free` for
 * every fault below. That was T-446 recording today's WRONG answer on purpose,
 * with a comment saying that changing these tests would be the signal ISS-897
 * had been fixed. This is that change.
 *
 * SIX of the seven now withhold the aggregate. Only the positively terminal
 * `SESSION_END` case is unchanged, and that matters as much: a fix that also
 * flipped it would be failing closed on a record that is fully accounted for
 * and finished.
 *
 * The six do not all withhold for the same REASON, and the block below keeps
 * them apart. Five are concealment -- something the scan could not see, so
 * `scanCompleteness` is `incomplete`. The sixth, a malformed `ownerTask`, is
 * not: that record is admitted and classified, its relationship stays T-446's
 * frozen `unowned-legacy`, and the scan stays `complete`. What it withholds the
 * aggregate for is that nobody can say WHO owns it.
 *
 * Every fault here uses a WRONG FILE TYPE rather than chmod. A chmod-based
 * EACCES test running as root reads the file anyway and passes for the wrong
 * reason -- which is exactly the failure mode this block exists to catch. The
 * kernel rejects a wrong file type identically for every user.
 */
describe("scanner concealment is reported, not silent (ISS-897)", () => {
  const evaluate = (root: string) => evaluateSessionGuard(root, { clientTaskId: "caller-task", client: "claude" });

  /** Asserts the verdict stopped AND that it can say what to go and look at. */
  const expectConcealed = (root: string, kind: string, sourceDir: string | null) => {
    const v = evaluate(root);
    expect(v.overallAction, "verdict did not stop on an incomplete scan").toBe("unverifiable");
    expect(v.scanCompleteness).toBe("incomplete");
    const d = v.diagnostics.find((x) => x.kind === kind);
    expect(d, `no ${kind} diagnostic: ${JSON.stringify(v.diagnostics)}`).toBeDefined();
    expect(d!.category).toBe("omission");
    expect(d!.sourceDir).toBe(sourceDir);
    // Naming the fault without naming the file is the complaint ISS-897 makes
    // about `unverifiable` with nothing attached.
    expect(d!.sourcePath.length, "diagnostic carries no path to inspect").toBeGreaterThan(0);
    return v;
  };

  it("state.json is a directory (EISDIR) -> unverifiable, naming the directory", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "broken", "state.json"), { recursive: true });
    expectConcealed(root, "state-unreadable", "broken");
  });

  it("state.json is truncated JSON -> unverifiable", () => {
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "truncated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), '{"status":"active"');
    expectConcealed(root, "state-invalid-json", "truncated");
  });

  it(".story/sessions is a file (ENOTDIR) -> unverifiable, naming the sessions root", () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-guard-"));
    roots.push(root);
    mkdirSync(join(root, ".story"), { recursive: true });
    writeFileSync(join(root, ".story", "sessions"), "not a directory");
    // A collection-level fault has no entry to name, so `sourceDir` is null and
    // `sourcePath` carries the sessions root instead.
    const v = expectConcealed(root, "sessions-dir-unreadable", null);
    expect(v.diagnostics[0]!.sourcePath).toContain(join(".story", "sessions"));
  });

  /**
   * Named for the dirent filter, not for containment. `readdirSync` with
   * `withFileTypes` produces lstat-based dirents, so a symlink answers
   * `isSymbolicLink()` and is dropped by `entry.isDirectory()` one line BEFORE
   * `isContainedSessionDir` is consulted. A test claiming to exercise
   * containment here would be asserting against a branch it never reaches.
   *
   * Note the name: `linked` is NOT a canonical session id. The symlink half of
   * the rule is deliberately name-independent, so a rule keyed on UUID shape
   * would leave this exact fixture silent.
   */
  it("a symlinked session entry -> unverifiable, though its name is not a session id", () => {
    const root = makeRoot();
    const real = join(root, "outside-session");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "state.json"), JSON.stringify({ sessionId: "linked", status: "active", state: "IMPLEMENT" }));
    symlinkSync(real, join(root, ".story", "sessions", "linked"));
    expectConcealed(root, "entry-not-a-directory", "linked");
  });

  it("a parseable record with NO `status` key is active, because the schema says so", () => {
    // The inverse of the rule beside it, and the correction to an earlier
    // version of this test that asserted the opposite.
    //
    // `SessionStateSchema` declares `.default("active")` on `status`, so a
    // record written before the field existed parses as ACTIVE in every strict
    // reader here. A scanner that answers `status-undetermined` for the same
    // file drops it from both populations and drives the guard to
    // `unverifiable` -- concealing a valid session with the code added to stop
    // sessions being concealed, and disagreeing with the schema about a file
    // both are reading.
    //
    // "Unestablished" is the claim that does not survive. An absent optional
    // field with a declared default is not unknown; its value is the default.
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "nostatus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        sessionId: idFor("nostatus"),
        state: "IMPLEMENT",
        lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      }),
    );
    const v = evaluate(root);

    expect(v.scanCompleteness).toBe("complete");
    expect(v.diagnostics.map((d) => d.kind)).not.toContain("status-undetermined");
    expect(v.sessions).toHaveLength(1);
    expect(v.sessions[0]!.sourceDir).toBe("nostatus");
  });

  it("but a PRESENT status outside the known set is still undetermined", () => {
    // The control that keeps the default from swallowing the real case. A
    // value that is there and unrecognized is not a legacy record taking a
    // default; it is a field this build cannot interpret, and retiring the
    // record on it would be the silent drop the rule exists to stop.
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "weirdstatus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ sessionId: idFor("weirdstatus"), status: "paused", state: "IMPLEMENT" }),
    );
    expectConcealed(root, "status-undetermined", "weirdstatus");
  });

  // --- The two that do NOT flip -------------------------------------------

  it("a parseable active record in SESSION_END still vanishes, silently", () => {
    const root = makeRoot();
    writeSession(root, "ended", { state: "SESSION_END" });
    const v = evaluate(root);
    // Positively terminal. Nothing is concealed by dropping a session that has
    // ended, and diagnosing it would put a finished project into `unverifiable`.
    expect(v.overallAction).toBe("free");
    expect(v.diagnostics).toEqual([]);
    expect(v.scanCompleteness).toBe("complete");
  });

  it("names a deduplicated owner-fault directory without claiming it survived", () => {
    // End-to-end over a real tree, because the interaction only exists once the
    // scanner's admission and the guard's deduplication both run: the scanner
    // admits both directories and emits the ownership diagnostic for the second,
    // then dedup drops that one. The rationale has to name it as observed rather
    // than as reported above -- the wording contradicted the verdict beside it.
    const root = makeRoot();
    const shared = "aaaa1111-2222-4333-8444-555555555555";
    writeSession(root, "aaa-first", {
      sessionId: shared,
      ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-01-01T00:00:00.000Z" },
    });
    writeSession(root, "zzz-second", {
      sessionId: shared,
      ownerTask: { client: "claude", id: "", boundAt: "2026-01-01T00:00:00.000Z" },
    });

    const v = evaluate(root);
    expect(v.overallAction).toBe("unverifiable");
    expect(v.sessions.map((s) => s.sourceDir)).toEqual(["aaa-first"]);
    expect(v.diagnostics.some((d) => d.kind === "owner-task-undetermined" && d.sourceDir === "zzz-second")).toBe(true);
    expect(v.overallRationale).toContain("zzz-second");
    expect(v.overallRationale).not.toContain("IS reported above");
    // Both blockers apply here and both must be visible: the collision and the
    // unreadable owner are separate facts with separate remedies.
    expect(v.overallRationale).toContain("ISS-914");
    expect(v.overallRationale).toContain("WHO owns it");
  });

  it("a newer-schema live session cannot produce a permissive verdict", () => {
    // The end-to-end statement of the scanner fence: a session written under a
    // newer schema, whose condition this build did not determine, must not be
    // read under THIS build's schema and turned into a green light. Its fields
    // may mean something else now, so it fails CLOSED -- and the remedy is an
    // upgrade, never a deletion.
    const root = makeRoot();
    writeSession(root, "from-the-future", { schemaVersion: 99 });
    const v = evaluate(root);
    expect(v.overallAction).toBe("unverifiable");
    expect(v.sessions).toEqual([]);
    expect(v.scanCompleteness).toBe("incomplete");
    expect(v.diagnostics.map((d) => d.kind)).toContain("state-version-skew");
    expect(v.overallRationale).toContain("from-the-future");
  });

  it("an UNSUPPORTED-schema session that looks stale cannot produce `free` either", () => {
    // The newer-schema case above exits through `state-version-skew`, which is
    // its own kind and its own branch. This is the other half of the version
    // contract and it walks a longer path: `status: "active"` clears the
    // terminal pre-gate, a known non-COMPACT state keeps it out of
    // `resumableSessions`, and an expired lease keeps it out of
    // `activeSessions`. Admitted by neither, it used to leave without a
    // diagnostic -- so the guard saw an empty population on a scan reporting
    // itself complete and answered `free`, the most permissive verdict it has,
    // over a session whose fields it had just declared it could not interpret.
    //
    // Only the end-to-end path can catch this. The hand-built classifier tests
    // above start from a scan RESULT, so they cannot see a record the scanner
    // dropped before building one.
    const root = makeRoot();
    writeSession(root, "stale-looking", {
      schemaVersion: 0,
      status: "active",
      state: "IMPLEMENT",
      lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const v = evaluate(root);

    expect(v.overallAction).toBe("unverifiable");
    expect(v.sessions).toEqual([]);
    expect(v.scanCompleteness).toBe("incomplete");
    expect(v.diagnostics.map((d) => d.kind)).toContain("unadmitted-schema-version-undetermined");
    expect(v.overallRationale).toContain("stale-looking");
  });

  it("an ownerTask that fails validation reads as unowned-legacy, not foreign-live", () => {
    const root = makeRoot();
    writeSession(root, "badowner", { ownerTask: { client: "claude", id: "", boundAt: 1 } });
    const v = evaluate(root);
    // T-446's transcription, unchanged: the RELATIONSHIP is still what it was.
    expect(v.sessions[0]?.relationship).toBe("unowned-legacy");
    expect(v.sessions[0]?.ownerTask).toBeNull();
    // ISS-897: the AGGREGATE is withheld, because the substitution that produced
    // that relationship is itself the thing that could not be read. See the
    // takeover test below for why this is not merely tidy.
    expect(v.overallAction).toBe("unverifiable");
    expect(v.diagnostics.map((d) => d.kind)).toContain("owner-task-undetermined");
  });

  /**
   * PRESENT but unusable is not ABSENT, and collapsing them is a takeover.
   *
   * A null `ownerTask` means "legacy session, no owner recorded", and a LIVE
   * COMPACT legacy session is auto-resumed -- that is the documented migration
   * path. A session whose owner id is DAMAGED is not that: it belongs to
   * somebody. The scanner used to normalize both to null, which turned
   * `foreign-live` into `unowned-legacy` and `monitor-only` into `auto-resume`.
   *
   * This is the ISS-554 shape reached through a malformed field, and the pair of
   * assertions below is the whole argument: identical records, one with a
   * readable foreign owner and one with a damaged one, must not differ by
   * "monitor it" versus "take it over".
   */
  it("a LIVE COMPACT session with a DAMAGED owner is not auto-resumed", () => {
    const root = makeRoot();
    const compactLive = {
      state: "COMPACT",
      compactPending: true,
      lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
    };

    const damaged = makeRoot();
    writeSession(damaged, "damaged-owner", {
      ...compactLive,
      ownerTask: { client: "claude", id: "", boundAt: new Date().toISOString() },
    });
    const dv = evaluate(damaged);
    expect(dv.overallAction).toBe("unverifiable");
    expect(dv.overallAction).not.toBe("auto-resume");
    expect(dv.diagnostics.map((d) => d.kind)).toContain("owner-task-undetermined");

    // The control: the same record with a READABLE foreign owner is monitored,
    // never resumed. The damaged one must not be treated more permissively than
    // the one whose owner this build can actually read.
    writeSession(root, "readable-owner", {
      ...compactLive,
      ownerTask: { client: "claude", id: "someone-else", boundAt: new Date().toISOString() },
    });
    const rv = evaluate(root);
    expect(rv.sessions[0]?.relationship).toBe("foreign-live");
    expect(rv.overallAction).toBe("monitor-only");
  });

  it("a genuinely ABSENT ownerTask still gets the legacy migration path", () => {
    // The distinction has to be present-but-unreadable versus absent, not
    // "anything unusual blocks". A real legacy session -- written before owner
    // binding existed -- must keep its documented recovery, or the fix costs
    // every pre-migration project its continuity.
    const root = makeRoot();
    writeSession(root, "true-legacy", {
      state: "COMPACT",
      compactPending: true,
      lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const v = evaluate(root);
    expect(v.overallAction).toBe("offer-recovery");
    expect(v.diagnostics).toEqual([]);
    expect(v.scanCompleteness).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// The concealment axis of the aggregate (ISS-897)
// ---------------------------------------------------------------------------

/**
 * `overallAction` alone cannot express scan completeness: `free` over a scan
 * that dropped an unreadable directory is indistinguishable from `free` over a
 * clean one, and that is the ISS-554 shape. So the aggregate has two axes, and
 * this block is one test per CELL of the 3x2 table -- the population counts down
 * the side, completeness across the top.
 */
describe("aggregate: population count x scan completeness (ISS-897)", () => {
  const CALLER_TASK = { client: "claude", id: "caller-task", boundAt: "2026-01-01T00:00:00.000Z" } as const;
  const caller = { task: CALLER_TASK, client: "claude" } as const;
  const omission = {
    kind: "state-unreadable",
    category: "omission",
    sourceDir: "broken",
    sourcePath: "/p/.story/sessions/broken/state.json",
    sessionId: null,
    reason: "unreadable",
  } as const;
  const benign = { ...omission, kind: "session-id-invalid", category: "normalized" } as const;

  const mine = () => summary({ sessionId: "a", sourceDir: "a", ownerTask: CALLER_TASK });
  const theirs = () =>
    summary({
      sessionId: "b",
      sourceDir: "b",
      ownerTask: { client: "claude", id: "other-task", boundAt: "2026-01-01T00:00:00.000Z" },
    });

  describe("no session visible", () => {
    it("clean scan -> free", () => {
      const v = classifySessionGuard({ activeSessions: [], resumableSessions: [], diagnostics: [] }, caller);
      expect(v.overallAction).toBe("free");
      expect(v.scanCompleteness).toBe("complete");
    });

    it("omission -> unverifiable, and the rationale names the directory to inspect", () => {
      const v = classifySessionGuard(
        { activeSessions: [], resumableSessions: [], diagnostics: [omission] },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.primary).toBeNull();
      expect(v.overallRationale).toContain("broken");
      expect(v.diagnostics).toHaveLength(1);
    });
  });

  describe("one session visible", () => {
    it("clean scan -> that session's own action", () => {
      const v = classifySessionGuard(
        { activeSessions: [mine()], resumableSessions: [], diagnostics: [] },
        caller,
      );
      expect(v.overallAction).toBe("continue");
    });

    it("omission -> unverifiable, but `primary` and `sessions` are PRESERVED", () => {
      const v = classifySessionGuard(
        { activeSessions: [mine()], resumableSessions: [], diagnostics: [omission] },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      // Discarding the observed record would leave the caller unable to say
      // what was found OR what failed. Only the AGGREGATE is withheld.
      expect(v.primary?.sourceDir).toBe("a");
      expect(v.primary?.action).toBe("continue");
      expect(v.sessions).toHaveLength(1);
    });
  });

  describe("two sessions visible", () => {
    it("clean scan -> null, the existing multiplicity answer", () => {
      const v = classifySessionGuard(
        { activeSessions: [mine(), theirs()], resumableSessions: [], diagnostics: [] },
        caller,
      );
      expect(v.overallAction).toBeNull();
    });

    it("omission -> STILL null, and the concealment is reported beside the conflict", () => {
      const v = classifySessionGuard(
        { activeSessions: [mine(), theirs()], resumableSessions: [], diagnostics: [omission] },
        caller,
      );
      // `null` is a STRONGER stop than `unverifiable` -- it means no aggregate
      // rule exists at all -- so overwriting it would trade the multiplicity
      // signal for a weaker one.
      expect(v.overallAction).toBeNull();
      // But it must not SUPPRESS the concealment: a reader who saw only the
      // multiplicity would not know the population it was computed over is
      // incomplete.
      expect(v.overallRationale).toContain("More than one session");
      expect(v.overallRationale).toContain("incomplete");
      expect(v.overallRationale).toContain("broken");
      expect(v.diagnostics).toHaveLength(1);
    });
  });

  describe("categories other than omission never change a verdict", () => {
    // `collision` is deliberately NOT in this list, and its exclusion is not a
    // fail-open. The aggregate is withheld on the observed DEDUPLICATION EVENT,
    // never on the category: at this typed seam a caller can attach a
    // `collision`-category diagnostic to a payload whose summaries carry no
    // duplicate `sessionId` at all, and that payload collapsed nothing, so
    // there is nothing to withhold. An actual duplicate DOES withhold the
    // aggregate (ISS-914), which the collision tests below pin. Listing the
    // category here alongside the two that are genuinely harmless would encode
    // "a collision is safe" as a tested contract and lose that distinction.
    // Each pair is a kind WITH ITS OWN category. The earlier version of this
    // test reused one kind and swapped the category under it, which made
    // `session-id-invalid` (a `normalized` kind) arrive as `undetermined` -- a
    // mismatched pair, now correctly unusable. Asserting `continue` for it
    // locked in the fail-open the validator exists to close, so the parameter
    // has to be the pair, not the category alone.
    it.each([
      ["session-id-invalid", "normalized"],
      ["lease-undetermined", "undetermined"],
    ])("%s/%s alone leaves the action alone", (kind, category) => {
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [{ ...benign, kind, category } as never],
        },
        caller,
      );
      // CATEGORY-level behaviour only. This asserts that a non-omission
      // category does not by itself force `unverifiable`, which would fail
      // closed with no hazard behind it. It deliberately does NOT assert
      // correlation: the diagnostic is spread from `benign`, so it carries
      // `sessionId: null` and `sourceDir: "broken"` while the classified record
      // is (a, a). The pass comes from the category being ignored for blocking,
      // not from the annotation belonging to that record -- placement is
      // covered by the ownership correlation tests below.
      expect(v.overallAction).toBe("continue");
      expect(v.scanCompleteness).toBe("complete");
      expect(v.diagnostics).toHaveLength(1);
    });

    it.each([
      ["state-unreadable", "normalized"],
      ["state-unreadable", "undetermined"],
      ["state-unreadable", "collision"],
      ["owner-task-undetermined", "normalized"],
    ])("but %s labelled %s is a MISMATCHED pair, and mismatched is unusable", (kind, category) => {
      // Both values are individually recognized, which is exactly the problem:
      // validating them separately let this through as usable, so completeness
      // stayed `complete` and the aggregate rose to `continue`. Yet
      // `state-unreadable` means a record was CONCEALED, and no rule fires on a
      // `normalized` entry to say so -- a payload that is merely wrong, not even
      // hostile, hides a session. One kind means one category.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [{ ...benign, kind, category } as never],
        },
        caller,
      );
      expect(v.scanCompleteness).toBe("unknown");
      expect(v.overallAction).toBe("unverifiable");
      expect(v.diagnostics).toHaveLength(0);
    });

    it("still drops a mismatched pair that CLAIMS omission, but keeps the claim", () => {
      // The other direction, and it resolves the opposite way. `session-id-invalid`
      // labelled `omission` is just as mismatched, but the claim it makes is that
      // something was CONCEALED -- and the category-only rule outranks the pairing
      // check precisely so a concealment claim is never softened. The entry is
      // still unusable and still dropped; what survives is the warning.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [{ ...benign, kind: "session-id-invalid", category: "omission" }] as never,
        },
        caller,
      );
      expect(v.scanCompleteness).toBe("incomplete");
      expect(v.overallAction).toBe("unverifiable");
      expect(v.diagnostics).toHaveLength(0);
    });

    it("keeps the CATEGORY-only omission rule, which outranks the pairing check", () => {
      // `{ category: "omission" }` has no kind to pair at all, and it must stay
      // `incomplete` rather than becoming `unknown`: the category alone already
      // says the scan concealed something, and answering `unknown` there would
      // trade a specific warning for a vaguer one. The pairing check applies to
      // entries that claim a kind, not to this one.
      const v = classifySessionGuard(
        { activeSessions: [mine()], resumableSessions: [], diagnostics: [{ category: "omission" }] as never },
        caller,
      );
      expect(v.scanCompleteness).toBe("incomplete");
    });
  });

  /**
   * The collision block (ISS-914).
   *
   * Two directories claiming one `sessionId` are collapsed to one record BEFORE
   * classification, so the survivor would otherwise decide the aggregate alone.
   * When the dropped record is a live FOREIGN session, that produced `continue`
   * off a scan reported as `complete` -- the ISS-554 shape, reached through a
   * green light, which is the failure this whole guard exists to prevent.
   *
   * Detecting the collision was ISS-897's scope. Shipping the detection while
   * leaving the aggregate permissive would have meant shipping a document that
   * calls a collision "an unresolved hazard, not a permission" directly above a
   * rule that grants one, so the block ships with the detection.
   *
   * What is still open in ISS-914 is the PRECISION of the rule: this fires on
   * any collision, including one where both records agree, because deciding that
   * requires classifying the dropped record and dedup discards it first.
   */
  describe("duplicate sessionId with conflicting owners (ISS-914)", () => {
    const collided = (task: string, dir: string): ActiveSessionSummary => ({
      ...mine(),
      sourceDir: dir,
      sessionId: "aaaa1111-2222-3333-4444-555555555555",
      ownerTask: { client: "claude", id: task },
    });

    it("withholds the aggregate rather than answering from the survivor alone", () => {
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("some-other-task", "bbb-theirs")],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "duplicate-session-id",
              category: "collision",
              sourceDir: "bbb-theirs",
              sessionId: "aaaa1111-2222-3333-4444-555555555555",
              conflictingSourceDirs: ["aaa-mine", "bbb-theirs"],
            } as never,
          ],
        },
        caller,
      );

      // The block. A live foreign record was dropped by dedup, so no
      // project-wide answer is available at all.
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("kept aaa-mine, dropped bbb-theirs");
      expect(v.overallRationale).toContain("ISS-914");

      // The scan itself is genuinely complete -- nothing was concealed FROM the
      // scan. The two axes are independent, and conflating them would have made
      // this look like a scanner fault.
      expect(v.scanCompleteness).toBe("complete");

      // The survivor's own verdict is preserved, not erased. The caller still
      // needs to know what was found, and only the aggregate is withheld.
      expect(v.sessions).toHaveLength(1);
      expect(v.sessions[0]!.relationship).toBe("same-owner");
      expect(v.sessions[0]!.action).toBe("continue");
      expect(v.primary).not.toBeNull();

      // And the reporting half from ISS-897 still holds.
      expect(v.diagnostics.some((d) => d.kind === "duplicate-session-id")).toBe(true);
      expect(v.transcriptionNotes.join(" ")).toContain("kept aaa-mine, dropped bbb-theirs");
      expect(v.transcriptionNotes.join(" ")).toContain("duplicate-session-id");
    });

    it("does not claim the diagnostics array is empty when it merely lacks THIS collision", () => {
      // The note's fallback branch fires on the absence of a matching
      // `duplicate-session-id` diagnostic, which is not the same as an absent
      // `diagnostics` array. A hand-built result can carry unrelated entries --
      // an ownership fault here -- and saying "this scan result carries no
      // diagnostics" beside a non-empty `diagnostics` array is two incompatible
      // claims in one result.
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("some-other-task", "bbb-theirs")],
          resumableSessions: [],
          diagnostics: [
            { ...benign, kind: "owner-task-undetermined", category: "undetermined", sourceDir: "aaa-mine" } as never,
          ],
        },
        caller,
      );
      const notes = v.transcriptionNotes.join(" ");
      expect(notes).toContain("kept aaa-mine, dropped bbb-theirs");
      // The fallback still has to fire -- no `duplicate-session-id` was supplied,
      // so this sentence really is the only record of the collision.
      expect(notes).toContain("no structured `duplicate-session-id` diagnostic listing EVERY directory");
      // ...but it must not misdescribe the array returned beside it.
      expect(notes).not.toContain("This scan result carries no diagnostics");
      expect(v.diagnostics).toHaveLength(1);
    });

    it("does not defer to a matching diagnostic that does not carry this pair", () => {
      // `conflictingSourceDirs` is OPTIONAL on the type, so a diagnostic can
      // match on kind and id while holding none of the directories -- and the
      // structured sentence promises the entry carries every one of them and
      // tells the reader to act on it instead of parsing the note. Deferring to
      // a carrier that lost the pair would send the operator to structured data
      // missing exactly what the note just stopped recording.
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("some-other-task", "bbb-theirs")],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "duplicate-session-id",
              category: "collision",
              sourceDir: "bbb-theirs",
              sessionId: "aaaa1111-2222-3333-4444-555555555555",
            } as never,
          ],
        },
        caller,
      );
      const notes = v.transcriptionNotes.join(" ");
      expect(notes).toContain("kept aaa-mine, dropped bbb-theirs");
      expect(notes).toContain("no structured `duplicate-session-id` diagnostic listing EVERY directory");
      expect(notes).not.toContain("which this verdict returns in `diagnostics`");
    });

    it("does not defer to a diagnostic that carries only part of a three-way collision", () => {
      // The note fires once per DROPPED record, so a pairwise check -- does the
      // diagnostic hold THIS iteration's kept and dropped pair -- passes on a
      // carrier that omits the third directory. The sentence it gates says the
      // diagnostic carries every directory and to act on it rather than parse
      // the note, so the operator would remove two copies, never learn about
      // the third, and be blocked again by a guard whose instruction reads as
      // though it had already been followed.
      const v = classifySessionGuard(
        {
          activeSessions: [
            collided(caller.task!.id, "aaa-mine"),
            collided("task-b", "bbb-theirs"),
            collided("task-c", "ccc-third"),
          ],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "duplicate-session-id",
              category: "collision",
              sourceDir: "bbb-theirs",
              sessionId: "aaaa1111-2222-3333-4444-555555555555",
              conflictingSourceDirs: ["aaa-mine", "bbb-theirs"],
            } as never,
          ],
        },
        caller,
      );
      const notes = v.transcriptionNotes.join(" ");
      // Every dropped directory is still named by the notes themselves.
      expect(notes).toContain("kept aaa-mine, dropped bbb-theirs");
      expect(notes).toContain("kept aaa-mine, dropped ccc-third");
      // And the incomplete carrier is not held out as the complete one.
      expect(notes).not.toContain("carrying every directory");
      expect(notes).toContain("listing EVERY directory that holds THIS session id");
    });

    it("reports the SAME directory arriving twice as a repeated entry, not a collision", () => {
      // Dedup keys on `sessionId` alone, so it drops the second record whether
      // the two carry different directories or the identical one -- and from
      // the `seen` map the two shapes are indistinguishable. They are not the
      // same event. One directory reported twice is a malformed payload, and
      // giving it the collision remedy sends an operator to compare directories
      // and delete a stale copy that does not exist: either a no-op that leaves
      // the guard blocking on input they cannot change, or a deletion of the
      // only live session. Unreachable from this build's scanner (a record is
      // live or resumable, never both), reachable at this seam and from mode A.
      const same = { ...mine(), sessionId: "dup-id", sourceDir: "only-dir" };
      const v = classifySessionGuard(
        { activeSessions: [same], resumableSessions: [same], diagnostics: [] },
        caller,
      );
      // Still fails CLOSED: a record was dropped before classification.
      expect(v.overallAction).toBe("unverifiable");
      expect(v.sessions).toHaveLength(1);
      const all = `${v.overallRationale} ${v.transcriptionNotes.join(" ")}`;
      expect(all).toContain("only-dir");
      expect(all).toContain("more than once for the SAME directory");
      // ...but it must NOT describe two directories or prescribe a deletion.
      expect(all).not.toContain("appears under more than one directory");
      // Forbid the ACT, not one phrasing of it. Pinning the sweep to the exact
      // sentence the collision path happened to use in one build makes it pass
      // the day that sentence is reworded, which is exactly when the repeat
      // path is most likely to have inherited a deletion instruction.
      for (const destructive of [/remove every stale/i, /keep the canonical/i, /session delete/i, /\brm\b/]) {
        expect(all, `repeat path carries a destructive instruction: ${destructive}`).not.toMatch(destructive);
      }
      // The word itself cannot simply be banned -- this path REFUSES deletion
      // out loud, twice, and that refusal is the point. So require that every
      // mention of it is negated: an instruction to delete would arrive without
      // the negation, and a reworded refusal still passes.
      for (const m of all.matchAll(/delet\w*/gi)) {
        const before = all.slice(Math.max(0, m.index - 25), m.index);
        expect(before, `unnegated deletion in the repeat path: "${before}${m[0]}"`).toMatch(
          /\b(no|not|never|nothing)\b/i,
        );
      }
    });

    it("reports A, B, B as ONE collision plus one repeat, not two collisions", () => {
      // The ordering that breaks a kept-directory comparison. A is kept, the
      // first B is a genuine collision against it, and the second B is an
      // identical repeat -- but compared against KEPT A it looks like a second
      // collision, so the payload fault vanishes and the collision count is
      // inflated by the very record that proves the payload is malformed. The
      // operator is then told twice to remove a stale copy of B, and never told
      // their scan result duplicated a record. Detection keys on the PAIR,
      // checked before the kept map, which is what makes both statements appear.
      const b = collided("some-other-task", "bbb-theirs");
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), b],
          resumableSessions: [b],
          diagnostics: [],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.sessions).toHaveLength(1);
      const all = `${v.overallRationale} ${v.transcriptionNotes.join(" ")}`;
      // Exactly ONE collision statement for the A/B pair.
      const collisionCount = v.transcriptionNotes.filter((n) =>
        n.includes("appears under more than one directory"),
      ).length;
      expect(collisionCount).toBe(1);
      expect(all).toContain("kept aaa-mine, dropped bbb-theirs");
      // ...and the repeat of B reported separately, as a repeat.
      const repeatCount = v.transcriptionNotes.filter((n) =>
        n.includes("arrives more than once for the SAME directory"),
      ).length;
      expect(repeatCount).toBe(1);
      expect(all).toContain("One repeated entry was received");
    });

    it("reports A, A, B, B as two repeated pairs without claiming two sessions", () => {
      // Several DIFFERENT pairs can repeat in one payload, and the counts then
      // come apart: 2 repeats, 2 pairs, ONE session id, TWO directories. A
      // rationale that derives its noun from the pair count says "2 sessions"
      // here, which is false -- and because A and B share an id, this payload
      // ALSO contains a genuine A/B collision, so a rule that describes the
      // whole payload as one directory contradicts the deletion remedy printed
      // beside it. Each claim has to come from its own count.
      const a = collided(caller.task!.id, "aaa-mine");
      const b = collided("some-other-task", "bbb-theirs");
      const v = classifySessionGuard(
        { activeSessions: [a, a, b, b], resumableSessions: [], diagnostics: [] },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      const repeatNotes = v.transcriptionNotes.filter((n) =>
        n.includes("arrives more than once for the SAME directory"),
      );
      expect(repeatNotes).toHaveLength(2);
      const collisionNotes = v.transcriptionNotes.filter((n) =>
        n.includes("appears under more than one directory"),
      );
      expect(collisionNotes).toHaveLength(1);
      // Both directories named, one session id, and NOT "2 sessions".
      expect(v.overallRationale).toContain("2 repeated entries were received");
      expect(v.overallRationale).toContain("2 session/directory pairs");
      expect(v.overallRationale).toContain("one session id");
      expect(v.overallRationale).toContain("2 directories");
      expect(v.overallRationale).not.toContain("2 session ids");
      // And the genuine collision keeps its own statement, separate from the
      // repeat's -- but its remedy names no directory for removal either. The
      // sanitized rationale is not the unmodified name, so it points at
      // `collisions` and at the containment checks instead.
      expect(v.overallRationale).toContain("nothing may be deleted on the strength of this sentence");
      expect(v.overallRationale).toContain("`collisions` on this verdict carries the raw names");
      expect(v.overallRationale).toContain("before it is safe even to OPEN");
      // ...and the checks stop at safe-to-open. They establish that a name is a
      // real participant in this collision; nothing here establishes WHICH
      // participant is stale, and `kept` is only the first by read order.
      expect(v.overallRationale).toContain("they do not establish which participant is stale");
      expect(v.overallRationale).toContain("report what each one holds, and STOP");
      expect(v.overallRationale).toContain("authorizes no deletion");
      // This rationale opened by refusing deletion and then closed by
      // instructing it -- "delete only a copy established as stale, keep both
      // when none is" -- and the assertions above passed the whole time,
      // because each of them checked one fragment and none of them read the
      // paragraph. An operator gets the last instruction, not the first.
      //
      // So sweep it. Every mention of deletion must sit inside a refusal, and
      // no imperative or command may appear at all. Same treatment the
      // repeated-entry path already gets, applied to the one that can actually
      // destroy a live session.
      for (const forbidden of [
        "delete only a copy",
        "keep both when none is",
        "remove only a copy",
        "session delete",
        "rm -rf",
      ]) {
        expect(v.overallRationale, forbidden).not.toContain(forbidden);
      }
      for (const m of v.overallRationale.matchAll(/delet\w*/gi)) {
        const window = v.overallRationale.slice(Math.max(0, m.index - 40), m.index + 40);
        expect(window, `unqualified deletion: ${window}`).toMatch(
          /\b(NO|no|not|never|nothing|without|refus\w*)\b/,
        );
      }
      // The raw targets live in the typed field, and BOTH directories are there.
      expect(v.collisions).toHaveLength(1);
      expect(v.collisions[0]).toEqual({
        sessionId: "aaaa1111-2222-3333-4444-555555555555",
        kept: "aaa-mine",
        dropped: "bbb-theirs",
      });
    });

    it("counts three copies of one record as two repeats over one directory", () => {
      // Two counts that differ, and each is a false statement in place of the
      // other: `repeatedEntries` counts dropped REPEATS (three copies produce
      // two), the unique pairs count the DIRECTORIES involved (one). Saying
      // "2 sessions arrived more than once" over a single duplicated session is
      // the same class of miscount as calling a repeat a collision.
      const same = { ...mine(), sessionId: "dup-id", sourceDir: "only-dir" };
      const v = classifySessionGuard(
        { activeSessions: [same, same], resumableSessions: [same], diagnostics: [] },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("2 repeated entries were received");
      expect(v.overallRationale).toContain("a session/directory pair already reported in this same scan");
      expect(v.overallRationale).toContain("spanning one session id and one directory");
      expect(v.overallRationale).not.toContain("2 sessions");
    });

    it("keeps a real collision and a repeated entry as separate statements", () => {
      // Both can be true at once, and each has its own remedy. A reader shown
      // only one would either delete nothing or delete the wrong thing.
      const dupe = collided(caller.task!.id, "aaa-mine");
      const v = classifySessionGuard(
        {
          activeSessions: [dupe, collided("some-other-task", "bbb-theirs")],
          resumableSessions: [dupe],
          diagnostics: [],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      const all = `${v.overallRationale} ${v.transcriptionNotes.join(" ")}`;
      // The genuine collision keeps its own statement...
      expect(all).toContain("kept aaa-mine, dropped bbb-theirs");
      expect(all).toContain("before it is safe even to OPEN");
      expect(all).toContain("they do not establish which participant is stale");
      expect(v.collisions).toEqual([
        { sessionId: "aaaa1111-2222-3333-4444-555555555555", kept: "aaa-mine", dropped: "bbb-theirs" },
      ]);
      // ...and the repeat is reported as what it is, beside it.
      expect(all).toContain("more than once for the SAME directory");
      expect(all).toContain("authorizes no deletion");
    });

    it("blocks even with NO diagnostics supplied -- the collapse is observed directly", () => {
      // The block keys off the dedup event, not off the `duplicate-session-id`
      // diagnostic. Keying it off the diagnostic would make the safety of the
      // verdict depend on whether the caller happened to supply one, and this
      // seam treats an absent `diagnostics` field as `complete` by design.
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("some-other-task", "bbb-theirs")],
          resumableSessions: [],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.scanCompleteness).toBe("complete");
    });

    /**
     * The zero-survivor cell is UNREACHABLE, and the guard against it is kept
     * anyway.
     *
     * A collision implies at least two input records, dedup keeps one, and the
     * classification loop pushes a verdict for every kept record without
     * exception -- the gates change a verdict's ACTION (`unverifiable`,
     * `monitor-only`), they never remove it from the population. So there is no
     * input to this function that produces a collision and zero verdicts.
     *
     * The same holds one level up: the scanner emits `duplicate-session-id` only
     * over records it ADMITTED, so a pair of unadmitted colliding records never
     * reaches the guard's arrays at all.
     *
     * The zero-verdict branch still checks `droppedDuplicates`, because a rule
     * documented as "zero or one" and implemented as "one" is a rule that stops
     * being true the day a gate learns to filter -- and it would fail silently,
     * as `free`. This test pins the invariant that makes it unreachable, so that
     * change breaks HERE rather than in production.
     */
    it("cannot produce zero verdicts while a collision was recorded", () => {
      // Each shape carries its MEASURED aggregate, because ISS-914 made that
      // answer shape-dependent while the invariant under test (a collision can
      // never yield zero verdicts) stayed independent of it. Asserting a flat
      // `unverifiable` would now be asserting the old policy in a test whose
      // subject is the population count.
      const shapes: { records: ActiveSessionSummary[]; overall: string; why: string }[] = [
        {
          records: [collided(caller.task!.id, "aaa"), collided("other", "bbb")],
          overall: "unverifiable",
          why: "survivor is same-owner/continue, dropped is foreign-live/monitor-only: the signatures disagree, so it blocks",
        },
        {
          records: [
            { ...collided(caller.task!.id, "aaa"), leaseState: "missing" },
            { ...collided("other", "bbb"), leaseState: "missing" },
          ],
          overall: "unverifiable",
          why: "both gated to indeterminate/unverifiable, so the collision is WAIVED and this is the survivor's own action, not the block",
        },
        {
          records: [
            { ...collided(caller.task!.id, "aaa"), state: "NOT_A_STATE" },
            { ...collided("other", "bbb"), state: "NOT_A_STATE" },
          ],
          overall: "unverifiable",
          why: "same as above: waived, and the survivor's own action happens to be unverifiable",
        },
        {
          records: [
            { ...collided(caller.task!.id, "aaa"), ownerTask: null },
            { ...collided("other", "bbb"), ownerTask: null },
          ],
          overall: "monitor-only",
          why: "both unowned-legacy/monitor-only: waived, and here the waiver is VISIBLE because the survivor's action is not unverifiable",
        },
      ];
      for (const { records, overall, why } of shapes) {
        const v = classifySessionGuard({ activeSessions: records, resumableSessions: [] }, caller);
        // The invariant this test exists for, unchanged by ISS-914.
        expect(v.sessions.length, `zero verdicts for ${JSON.stringify(records[0])}`).toBeGreaterThan(0);
        expect(v.overallAction, why).toBe(overall);
        // Blocking or waived, the collision is ACCOUNTED FOR in the rationale.
        // Waiving the block never waives the report.
        expect(v.overallRationale, why).toContain("ISS-914");
      }
    });

    it("reports BOTH the collision and the incomplete scan when both apply", () => {
      // Two independent reasons the aggregate is withheld, with two different
      // remedies. A reader shown only one would draw the wrong conclusion about
      // how much of the population is accounted for.
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("some-other-task", "bbb-theirs")],
          resumableSessions: [],
          diagnostics: [{ ...omission, sourceDir: "half-created" } as never],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.scanCompleteness).toBe("incomplete");
      expect(v.overallRationale).toContain("half-created");
      expect(v.overallRationale).toContain("kept aaa-mine, dropped bbb-theirs");
    });

    it("blocks an empty population carrying an ownership fault -- a payload that broke its own invariant", () => {
      // Unreachable from real scanner output: the scanner emits
      // `owner-task-undetermined` only for an ADMITTED record. But a hand-built
      // scan result can report one beside an empty population, and that is the
      // last input whose emptiness should be trusted -- it just violated the
      // invariant that would justify trusting it. Both seams answer the same way.
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [
            { ...benign, kind: "owner-task-undetermined", category: "undetermined", sourceDir: "ghost" } as never,
          ],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallAction).not.toBe("free");
      expect(v.scanCompleteness).toBe("complete");
      // The message must not also claim the session is reported above, which is
      // what the ordinary ownership rationale says and what is necessarily false
      // here. Two contradictory statements in one incident message is worse than
      // either alone.
      expect(v.overallRationale).toContain("no session produced a verdict at all");
      expect(v.overallRationale).toContain("violates the invariant");
      expect(v.overallRationale).not.toContain("IS reported above");
    });

    it("blocks a NON-empty population whose ownership fault names no record it can place", () => {
      // The same invariant violation, seen from a populated scan, and the branch
      // that used to miss it. The zero-verdict branch checked for this; the
      // non-empty rationale simply ASSERTED the disjunction -- "the record is
      // among the sessions above, or among the dropped duplicates" -- which is
      // guaranteed for scanner output and is not guaranteed at this seam, where
      // a hand-built result (or mode A reading an untrusted status payload) can
      // name a third directory that is in neither set. Stating where a record is
      // without looking is the same class of error as claiming it survived.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [
            { ...benign, kind: "owner-task-undetermined", category: "undetermined", sourceDir: "ghost" } as never,
          ],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      // The survivor is still reported, and is NOT described as the affected one.
      expect(v.sessions.map((s) => s.sourceDir)).toEqual(["a"]);
      expect(v.overallRationale).toContain("ghost");
      expect(v.overallRationale).toContain("neither a reported session nor a dropped duplicate");
      expect(v.overallRationale).toContain("violates that invariant");
      // And it must not place the record anywhere, in either direction.
      expect(v.overallRationale).not.toContain("ghost is reported among the sessions above");
      expect(v.overallRationale).not.toContain("ghost was observed and admitted, then dropped");
    });

    it("places an ownership fault that DOES identify a surviving session", () => {
      // The control for the correlation above: a diagnostic matching a survivor
      // on BOTH identifiers is stated as surviving, plainly, with no hedging
      // disjunction and no invariant-violation language. `mine()` is
      // sessionId "a" in sourceDir "a", so the diagnostic must carry both.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "owner-task-undetermined",
              category: "undetermined",
              sessionId: "a",
              sourceDir: "a",
            } as never,
          ],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("a is reported among the sessions above");
      expect(v.overallRationale).not.toContain("violates that invariant");
      expect(v.overallRationale).not.toContain("dropped by deduplication");
    });

    it("does NOT place an ownership fault that only borrows a survivor's directory", () => {
      // `sourceDir` is not an identifier at this seam. An untrusted payload can
      // put a survivor's directory string on a diagnostic carrying a different
      // embedded id, and correlating on the directory alone would report an
      // unrelated ownership fault as though it were the session listed above --
      // placing a record the guard cannot actually place, which is the whole
      // defect the correlation exists to stop.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "owner-task-undetermined",
              category: "undetermined",
              sessionId: "some-other-id",
              sourceDir: "a",
            } as never,
          ],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("violates that invariant");
      expect(v.overallRationale).not.toContain("a is reported among the sessions above");
    });

    it("does not let a delimiter collision place an ownership fault", () => {
      // The composite key must be INJECTIVE, not a joined string. A separator
      // is only safe if it cannot appear in either field, and nothing is: a JS
      // string can hold any code unit, and this seam accepts hand-built results.
      // Under a NUL-delimited key, the survivor (`a\u0000b`, `c`) and this
      // diagnostic (`a`, `b\u0000c`) hash to one key, and the guard reports an
      // unrelated fault as the session listed above -- the exact misplacement the
      // composite key exists to prevent, reintroduced by the encoding. It also
      // diverges from the fallback document, which compares the fields pairwise.
      const v = classifySessionGuard(
        {
          activeSessions: [
            { ...mine(), sessionId: "a\u0000b", sourceDir: "c" },
          ],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "owner-task-undetermined",
              category: "undetermined",
              sessionId: "a",
              sourceDir: "b\u0000c",
            } as never,
          ],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("violates that invariant");
      expect(v.overallRationale).not.toContain("reported among the sessions above");
    });

    it("does not THROW on a malformed diagnostics array -- it fails closed", () => {
      // `completenessFromDiagnostics` was already defensive here and answered
      // `unknown`, and then the classifier ran `.filter((d) => d.category ...)`
      // over the same array and threw on the first `null`. A guard whose entire
      // contract is to fail closed on an untrusted payload cannot fail by
      // crashing: the caller is left with no verdict at all, which is strictly
      // worse than the `unverifiable` the completeness check went to the
      // trouble of computing. Both seams see this input -- a hand-built result
      // and mode A reading a status payload off an unknown server.
      for (const bad of [[null], [undefined], [42], [["nested"]], [{ nope: true }]]) {
        const v = classifySessionGuard(
          { activeSessions: [mine()], resumableSessions: [], diagnostics: bad as never },
          caller,
        );
        expect(v.overallAction, JSON.stringify(bad)).toBe("unverifiable");
        expect(v.scanCompleteness, JSON.stringify(bad)).toBe("unknown");
        // Not silently dropped: the reader is told entries existed and could
        // not be classified, which is why the aggregate is withheld.
        expect(v.transcriptionNotes.join(" ")).toContain("could not be read by this build");
        // And the returned array holds only what a typed consumer can read,
        // so the crash is not simply moved downstream.
        for (const d of v.diagnostics) expect(typeof d.category).toBe("string");
      }
    });

    it("does not THROW on a recognized category whose FIELDS are malformed", () => {
      // The same crash one property over. Validating only `category` let
      // `{ category: "omission" }` through, and `namedDirectories` then called
      // `sanitizeDisplayPath(undefined)` -- so the guard threw instead of
      // returning the fail-closed verdict the category check had just earned.
      // Every field a consumer reads has to be checked, not just the one the
      // completeness rule needs.
      const shapes: unknown[] = [
        { category: "omission" },
        { category: "omission", kind: 7, sourceDir: "d", sourcePath: "p", sessionId: null, reason: "r" },
        { category: "omission", kind: "k", sourceDir: 7, sourcePath: "p", sessionId: null, reason: "r" },
        { category: "omission", kind: "k", sourceDir: "d", sourcePath: null, sessionId: null, reason: "r" },
        { category: "omission", kind: "k", sourceDir: "d", sourcePath: ["p"], sessionId: null, reason: "r" },
        { category: "omission", kind: "k", sourceDir: "d", sourcePath: "p", sessionId: 7, reason: "r" },
        { category: "omission", kind: "k", sourceDir: "d", sourcePath: "p", sessionId: null, reason: 7 },
        { category: "undetermined", kind: "owner-task-undetermined" },
      ];
      for (const bad of shapes) {
        const v = classifySessionGuard(
          { activeSessions: [mine()], resumableSessions: [], diagnostics: [bad] as never },
          caller,
        );
        expect(v.overallAction, JSON.stringify(bad)).toBe("unverifiable");
        expect(v.transcriptionNotes.join(" "), JSON.stringify(bad)).toContain("could not be read by this build");
        expect(v.diagnostics, JSON.stringify(bad)).toHaveLength(0);
        // And dropping it must never RAISE the verdict. A malformed
        // `owner-task-undetermined` is a fault that would have withheld the
        // aggregate; losing it silently would turn `unverifiable` into
        // `continue`, which is the one direction this axis must not move.
        expect(v.scanCompleteness, JSON.stringify(bad)).not.toBe("complete");
      }
    });

    it("does not THROW when the diagnostics CONTAINER is not an array", () => {
      // The elements were narrowed; the container was still trusted. `{}` has no
      // iterator and a string iterates into characters, so these crashed or
      // silently mis-derived before any element check could run -- the same
      // fail-by-crashing the element narrowing was added to stop, one level up.
      for (const container of [null, "diagnostics", 7, {}, true]) {
        const v = classifySessionGuard(
          { activeSessions: [mine()], resumableSessions: [], diagnostics: container as never },
          caller,
        );
        expect(v.overallAction, JSON.stringify(container)).toBe("unverifiable");
        expect(v.scanCompleteness, JSON.stringify(container)).toBe("unknown");
        expect(v.diagnostics, JSON.stringify(container)).toEqual([]);
        expect(v.transcriptionNotes.join(" "), JSON.stringify(container)).toContain("is not an array");
      }
    });

    it("treats a well-formed diagnostic with an UNKNOWN kind as unusable", () => {
      // Every blocking rule matches an EXACT kind, so a future
      // `owner-fault-of-some-new-shape` triggers nothing at all. Accepting it as
      // usable would leave completeness `complete` while an ownership fault this
      // build cannot interpret goes unenforced -- losing data raising the
      // verdict, in the one direction this axis must never move.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [
            {
              category: "undetermined",
              kind: "future-owner-fault",
              sourceDir: "d",
              sourcePath: "/p",
              sessionId: null,
              reason: "something a newer build understands",
            },
          ] as never,
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.scanCompleteness).toBe("unknown");
      expect(v.diagnostics).toHaveLength(0);
    });

    it("withholds `free` when an unsupported-version diagnostic sits beside ZERO sessions", () => {
      // Unreachable from real scanner output -- the kind is emitted only at the
      // admission point -- which is exactly why the rule has to cover it. A
      // hand-built result, or Mode A reading an untrusted payload, can produce
      // it, and that is a payload which just violated the invariant that would
      // justify trusting its emptiness.
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [
            { ...benign, kind: "schema-version-undetermined", category: "undetermined" } as never,
          ],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.scanCompleteness).toBe("complete");
      expect(v.overallRationale).toContain("no session produced a verdict at all");
    });

    it("keeps `null` and REPORTS it beside more than one session", () => {
      // `null` already withholds, so the action does not change -- the failure
      // mode here is silence. A reader shown the multiplicity and not this would
      // not know one of the listed sessions was read under a schema it does not
      // claim.
      const v = classifySessionGuard(
        {
          activeSessions: [mine(), theirs()],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "schema-version-undetermined",
              category: "undetermined",
              sessionId: "a",
              sourceDir: "a",
            } as never,
          ],
        },
        caller,
      );
      expect(v.overallAction).toBeNull();
      expect(v.overallRationale).toContain("is not one this build supports");
      // CORRELATED: it matched a surviving record, so the sentence places it
      // there rather than claiming no verdict exists -- and describes that
      // verdict as PROVISIONAL. "Informational but correct" was the overclaim:
      // the whole reason this diagnostic blocks is that the fields were read
      // under a schema the record does not claim, so their meanings are exactly
      // what has not been established.
      expect(v.overallRationale).toContain("reported among the sessions above");
      expect(v.overallRationale).toContain("PROVISIONAL");
      expect(v.overallRationale).toContain("field meanings are undetermined");
      expect(v.overallRationale).not.toContain("correct for the record as read");
    });

    it("does not claim placement for an unsupported-version entry it cannot correlate", () => {
      // The untrusted seam again. "Reported above" is false for an entry that
      // matches neither a surviving record nor a dropped duplicate, and naming a
      // state.json to inspect asserts a repair target that was never established.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "schema-version-undetermined",
              category: "undetermined",
              sessionId: null,
              sourceDir: null,
            } as never,
          ],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("matches neither a reported session nor a dropped duplicate");
      expect(v.overallRationale).toContain("No directory can be named here");
      expect(v.overallRationale).not.toContain("reported among the sessions above");
    });

    it("returns RAW directory names in `collisions`, which the notes cannot", () => {
      // The notes are the operator's explanation and are sanitized for display,
      // so `sanitizeDisplayText` maps every control character to `?`. Two raw
      // directory names can therefore render as ONE, and a rendered name can
      // equal an unrelated literal `?` directory. That is harmless in prose and
      // wrong in anything an operator will act on, so the raw participant set
      // is carried separately, built from the deduplication this guard performed
      // rather than from any supplied payload. It is a CANDIDATE set: each name
      // still needs the containment and identity checks, and comparing the
      // validated records may establish that neither copy is stale.
      const ESC = "\u001b";
      const v = classifySessionGuard(
        {
          activeSessions: [
            { ...mine(), sessionId: "dup-id", sourceDir: `dir${ESC}x` },
            { ...mine(), sessionId: "dup-id", sourceDir: "dir?x" },
          ],
          resumableSessions: [],
          diagnostics: [],
        },
        caller,
      );
      expect(v.collisions).toHaveLength(1);
      const [c] = v.collisions;
      // Unmodified by the guard: the two directories are still distinguishable here...
      expect([c!.kept, c!.dropped].sort()).toEqual([`dir${ESC}x`, "dir?x"].sort());
      expect(c!.sessionId).toBe("dup-id");
      // ...while in the prose they have collapsed into the same rendered name,
      // which is exactly why the prose may not be used to choose what to delete.
      const notes = v.transcriptionNotes.join(" ");
      expect(notes).toContain("dir?x");
      expect(notes).not.toContain(ESC);
    });

    it("derives `collisions` from the DEDUP EVENT, not from the supplied diagnostics", () => {
      // A padded carrier names a directory no deduplication ever touched. This
      // contract authorizes no deletion at all -- diagnostics are cross-checks,
      // inspection candidates come from `collisions`, and the operator decides
      // what to do with what they read. What a padded carrier can still do is
      // CORROBORATE: riding along with a real collision, it would make the note
      // claim the carrier lists every participant, and move an unrelated
      // directory from "mentioned somewhere" to "part of this collision" in a
      // reader's account of it. That is the property under test.
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("other", "bbb-theirs")],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "duplicate-session-id",
              category: "collision",
              sourceDir: "bbb-theirs",
              sessionId: "aaaa1111-2222-3333-4444-555555555555",
              conflictingSourceDirs: ["aaa-mine", "bbb-theirs", "unrelated-dir"],
            } as never,
          ],
        },
        caller,
      );
      expect(v.collisions).toEqual([
        { sessionId: "aaaa1111-2222-3333-4444-555555555555", kept: "aaa-mine", dropped: "bbb-theirs" },
      ]);
    });

    it("reports NO collisions when nothing was deduplicated", () => {
      // The empty case is the one that authorizes nothing. A caller reading
      // `collisions` must not have to also check whether a diagnostic invented
      // one.
      //
      // The carrier is fully POPULATED on purpose. Spreading `benign` alone
      // leaves `sessionId` null, and an implementation that derived collisions
      // from diagnostics whenever they carried a string id would have passed
      // that fixture while failing the contract -- the hostile carrier is a
      // complete-looking one, not a malformed one.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "duplicate-session-id",
              category: "collision",
              sessionId: "9999aaaa-2222-4333-8444-555555555555",
              sourceDir: "ghost-a",
              conflictingSourceDirs: ["ghost-a", "ghost-b"],
            } as never,
          ],
        },
        caller,
      );
      expect(v.collisions).toEqual([]);
    });

    it("renders an unknown workflow STATE under the same prose contract", () => {
      // The two pre-ownership gates interpolated `state` with a bare
      // `JSON.stringify`, which escapes control characters and nothing else.
      // The field they write into is `transcriptionNotes`, whose stated
      // contract is that the guard has already rendered it safely -- SKILL.md
      // tells the reader to quote it as it arrives and not to clean it up. So
      // a link authored here is a link the reader is instructed to reproduce.
      const EVIL = "IMPLEMENT[click](javascript:alert(1)) <img src=x> https://evil.test @admin";
      const v = classifySessionGuard(
        { activeSessions: [{ ...mine(), state: EVIL }], resumableSessions: [] },
        caller,
      );
      const prose = [...v.transcriptionNotes, v.overallRationale ?? ""].join(" ");

      // The gate fired at all -- otherwise everything below is vacuous.
      expect(prose).toContain("is not a known workflow state");
      expect(prose).not.toContain("](javascript:");
      expect(prose).not.toContain("<img");
      expect(prose).not.toContain("https://evil.test");
      expect(prose).not.toContain("@admin");
      // ...and it is still legible, because the operator has to see what the
      // record claimed its state was.
      expect(prose).toContain("IMPLEMENT");
    });

    it("bounds an enormous workflow STATE", () => {
      // No bound at all before: `state` is caller-supplied at the typed seam,
      // and this note is what a reader sees when the guard cannot decide.
      const v = classifySessionGuard(
        { activeSessions: [{ ...mine(), state: "Q".repeat(50_000) }], resumableSessions: [] },
        caller,
      );
      const prose = [...v.transcriptionNotes, v.overallRationale ?? ""].join(" ");
      expect(prose).toContain("is not a known workflow state");
      expect(prose.length, "the note is unbounded").toBeLessThan(2_000);
      expect(prose).toContain("truncated from");
    });

    it("rejects a collision carrier that lists an UNRELATED directory", () => {
      // A superset is not a better carrier. This diagnostic is a CROSS-CHECK
      // against what the guard itself deduplicated, and nothing downstream of
      // it deletes anything -- that was removed deliberately. What a padded
      // carrier buys instead is a false corroboration: an unrelated directory
      // presented as a confirmed participant in a collision no deduplication
      // ever saw, which sends the operator to inspect the wrong session while
      // they are working out which one is real. Subset was already rejected;
      // both directions have to be.
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("other", "bbb-theirs")],
          resumableSessions: [],
          diagnostics: [
            {
              ...benign,
              kind: "duplicate-session-id",
              category: "collision",
              sourceDir: "bbb-theirs",
              sessionId: "aaaa1111-2222-3333-4444-555555555555",
              conflictingSourceDirs: ["aaa-mine", "bbb-theirs", "unrelated-dir"],
            } as never,
          ],
        },
        caller,
      );
      const notes = v.transcriptionNotes.join(" ");
      expect(notes).toContain("kept aaa-mine, dropped bbb-theirs");
      // Not held out as the authoritative carrier...
      expect(notes).not.toContain("carrying every directory");
      expect(notes).toContain("listing EVERY directory that holds THIS session id");
      // ...and the note, which is now the complete record, never names the
      // directory the payload tried to smuggle in.
      expect(notes).not.toContain("unrelated-dir");
    });

    it("trusts a malformed OMISSION's category even while dropping the entry", () => {
      // Completeness needs only `category`, and an `omission` whose other fields
      // are garbage still means the scan concealed something. Downgrading that
      // to `unknown` would trade a specific warning for a vaguer one, so the
      // category is honoured even though the entry itself is unusable.
      const v = classifySessionGuard(
        { activeSessions: [mine()], resumableSessions: [], diagnostics: [{ category: "omission" }] as never },
        caller,
      );
      expect(v.scanCompleteness).toBe("incomplete");
      expect(v.overallAction).toBe("unverifiable");
      expect(v.diagnostics).toHaveLength(0);
      // And the RATIONALE must not contradict that. Falling through to the
      // ordinary incomplete sentence rendered "0 gaps ()" -- an empty list, a
      // zero count, and no remedy, beside a completeness value that says
      // something WAS concealed.
      expect(v.overallRationale).toContain("could not be read by this build");
      expect(v.overallRationale).not.toContain("0 gaps");
      expect(v.overallRationale).not.toContain("()");
      expect(v.overallRationale).toContain("upgrade storybloq");
      // ...and it must not borrow the `unknown` explanation, which opens by
      // saying the scan did not report whether it observed everything. It DID
      // report: the category-only rule read `omission` off this very entry, and
      // completeness is `incomplete` because of it. Pasting both into one
      // paragraph gives the operator two incompatible accounts of one payload.
      expect(v.overallRationale).not.toContain("did not report whether it observed everything");
      expect(v.overallRationale).toContain("The gap itself is established");
    });

    it("says the same thing in the MULTI-session rationale, which had its own copy", () => {
      // A separate clause with a separate template, so it rendered "0 gaps ()"
      // long after the single-session paths stopped -- and here beside a list of
      // real sessions, where it reads as though the scan had accounted for them.
      const v = classifySessionGuard(
        {
          activeSessions: [mine(), theirs()],
          resumableSessions: [],
          diagnostics: [{ category: "omission" }] as never,
        },
        caller,
      );
      expect(v.scanCompleteness).toBe("incomplete");
      expect(v.overallAction).toBeNull();
      expect(v.overallRationale).toContain("The scan is ALSO incomplete");
      expect(v.overallRationale).not.toContain("0 gap");
      expect(v.overallRationale).not.toContain("()");
      expect(v.overallRationale).toContain("The gap itself is established");
    });

    it("emits ONE repeat note per distinct pair while counting every occurrence", () => {
      // The split the fallback document states: events are counted per
      // occurrence, notes are emitted per distinct pair. Repeating an identical
      // sentence twice tells the reader nothing the count does not carry, and
      // emitting per event made the two seams disagree about A, A, A.
      const same = { ...mine(), sessionId: "dup-id", sourceDir: "only-dir" };
      const v = classifySessionGuard(
        { activeSessions: [same, same, same], resumableSessions: [], diagnostics: [] },
        caller,
      );
      const repeatNotes = v.transcriptionNotes.filter((n) =>
        n.includes("arrives more than once for the SAME directory"),
      );
      expect(repeatNotes).toHaveLength(1);
      expect(v.overallRationale).toContain("2 repeated entries were received");
    });

    it("keeps a recognized diagnostic while dropping the malformed ones beside it", () => {
      // The mixed payload: an unrecognized element must not cost the reader the
      // omission sitting next to it, which is the entry that names the
      // directory to inspect.
      const v = classifySessionGuard(
        {
          activeSessions: [mine()],
          resumableSessions: [],
          diagnostics: [null, omission] as never,
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.diagnostics).toHaveLength(1);
      expect(v.overallRationale).toContain("broken");
      expect(v.transcriptionNotes.join(" ")).toContain("could not be read by this build");
    });

    it.each([
      ["no session", []],
      ["one session", [1]],
      ["two sessions", [1, 2]],
    ])("reports a malformed omission BESIDE a usable one (%s)", (_label, ids) => {
      // The combination the all-or-nothing branch could not express. Two passes
      // disagree by design: completeness takes a recognized `omission` on its
      // CATEGORY alone, while every count and address list is built from the
      // USABLE set. So `{ category: "omission" }` sets `incomplete` and then
      // contributes to nothing.
      //
      // Handled only when it was the ONLY omission. Put a usable one beside it
      // and the rationale said "1 gap" with an address and never mentioned the
      // second -- the one gap with no address at all, which is precisely the
      // one an operator cannot go and look at without being told.
      const sessions = ids.map((n) => ({
        ...mine(),
        sessionId: `aaaa1111-2222-3333-4444-55555555555${n}`,
        sourceDir: `dir-${n}`,
      }));
      const v = classifySessionGuard(
        {
          activeSessions: sessions,
          resumableSessions: [],
          diagnostics: [omission, { category: "omission" }] as never,
        },
        caller,
      );

      expect(v.scanCompleteness).toBe("incomplete");
      // The usable one keeps its address...
      expect(v.overallRationale).toContain(omission.sourceDir);
      // ...and the malformed one is reported as a further, ADDRESSLESS gap
      // rather than silently folded into the count beside it.
      expect(v.overallRationale).toContain("1 further gap was reported whose diagnostic this build could not read");
      expect(v.overallRationale).toContain("no address to name");
      expect(v.overallRationale).toContain("not counted above");
      // And the remedy names no path, since there is none to name.
      expect(v.overallRationale).toContain("so no path is named here");
      expect(v.overallRationale).not.toContain("inspect `.story/sessions` directly");
    });

    it("counts repeated pairs by RAW value, not by how they render", () => {
      // The rationale sanitizes directory names for display, and two genuinely
      // different raw pairs can render identically once control characters are
      // replaced. Deduplicating the RENDERED strings would fold them into one
      // and undercount the pairs and directories being reported -- a miscount
      // in the same sentence that tells an operator how much of their payload
      // is malformed.
      // These two RENDER identically: `sanitizeDisplayText` replaces the ESC
      // with `?`, so `dir<ESC>x` and the literal `dir?x` are the same displayed
      // string while being different raw values. (The earlier pair here did NOT
      // collide -- one ESC became `?` and two became `??` -- so a rendered-string
      // dedup would have passed it, and the test proved nothing.)
      const ESC = "\u001b";
      const a = { ...mine(), sessionId: "dup-id", sourceDir: `dir${ESC}x` };
      const b = { ...mine(), sessionId: "dup-id", sourceDir: "dir?x" };
      const v = classifySessionGuard(
        { activeSessions: [a, b, a, b], resumableSessions: [], diagnostics: [] },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("2 repeated entries were received");
      expect(v.overallRationale).toContain("2 session/directory pairs");
      expect(v.overallRationale).toContain("one session id");
      expect(v.overallRationale).toContain("2 directories");
      // And the rendered text must still be safe to print into a terminal.
      expect(v.overallRationale).not.toContain(ESC);
    });

    it("a genuinely empty population remains free", () => {
      // The CONTROL for the invariant above, and only that. It records no
      // collision, so it does not exercise the defensive zero-verdict branch --
      // nothing can, which is what the invariant test establishes. What it does
      // prove is that adding the branch did not cost an ordinary empty project
      // its `free`.
      const v = classifySessionGuard(
        { activeSessions: [], resumableSessions: [], diagnostics: [] },
        caller,
      );
      expect(v.overallAction).toBe("free");
    });

    it("handles THREE directories on one id, naming every one", () => {
      // Two is the shape everything was written for, and it is not the only one.
      // A remedy that says "remove the stale one" after a three-way collision
      // leaves one stale copy behind, the guard blocks again, and the
      // instruction reads as though it had already been followed.
      const v = classifySessionGuard(
        {
          activeSessions: [
            collided(caller.task!.id, "aaa-mine"),
            collided("task-b", "bbb-theirs"),
            collided("task-c", "ccc-third"),
          ],
          resumableSessions: [],
        },
        caller,
      );
      expect(v.sessions).toHaveLength(1);
      expect(v.overallAction).toBe("unverifiable");
      // BOTH dropped directories, not just the first.
      expect(v.overallRationale).toContain("dropped bbb-theirs");
      expect(v.overallRationale).toContain("dropped ccc-third");
      expect(v.overallRationale).toContain("aaa-mine");
      // And what an operator would ACT on covers all of them. The rationale
      // never names a deletion target -- its names went through
      // `sanitizeDisplayText` and are not the unmodified names -- so the coverage
      // that matters is in `collisions`, which carries the raw strings.
      expect(v.overallRationale).not.toContain("remove the stale one");
      expect(v.overallRationale).toContain("nothing may be deleted on the strength of this sentence");
      expect(v.collisions.map((c) => c.dropped).sort()).toEqual(["bbb-theirs", "ccc-third"]);
      expect(v.collisions.every((c) => c.kept === "aaa-mine")).toBe(true);
      expect(v.transcriptionNotes.filter((n) => n.includes("appears under more than one"))).toHaveLength(2);
    });

    it("keeps `null`, not `unverifiable`, when distinct sessions ALSO collide", () => {
      // `null` is the stronger stop: it means no aggregate rule exists at all.
      // Downgrading it to `unverifiable` would trade the multiplicity signal for
      // a weaker one -- but the collision must still be reported, because the
      // count of survivors reads as the whole population otherwise.
      const other = { ...theirs(), sessionId: "cccc2222-3333-4444-5555-666666666666" };
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("some-other-task", "bbb-theirs"), other],
          resumableSessions: [],
        },
        caller,
      );
      expect(v.overallAction).toBeNull();
      expect(v.overallRationale).toContain("More than one session");
      expect(v.overallRationale).toContain("kept aaa-mine, dropped bbb-theirs");
    });

    it("reports the collision beside the multiplicity AND an incomplete scan", () => {
      const other = { ...theirs(), sessionId: "cccc2222-3333-4444-5555-666666666666" };
      const v = classifySessionGuard(
        {
          activeSessions: [collided(caller.task!.id, "aaa-mine"), collided("some-other-task", "bbb-theirs"), other],
          resumableSessions: [],
          diagnostics: [{ ...omission, sourceDir: "half-created" } as never],
        },
        caller,
      );
      // `null` survives both: it is already the strongest stop, and downgrading
      // it to `unverifiable` would trade the multiplicity signal away.
      expect(v.overallAction).toBeNull();
      expect(v.overallRationale).toContain("kept aaa-mine, dropped bbb-theirs");
      expect(v.overallRationale).toContain("ALSO incomplete");
      expect(v.overallRationale).toContain("half-created");
      // And the blind/listable remedy split reaches this row too, rather than
      // stopping at a bare list of names.
      expect(v.overallRationale).toContain("storybloq session list");
    });
  });

  /**
   * Prose is sanitized; structured fields are not.
   *
   * `overallRationale` and `transcriptionNotes` are read by a human during an
   * incident, and every one of them embeds a directory name taken off the
   * filesystem. `sessions[].sourceDir` and `diagnostics` are the carriers a
   * consumer diffs against a directory listing, so they keep the decoded
   * strings unmodified.
   */
  describe("untrusted directory names are neutralized in prose only", () => {
    const ESC = String.fromCharCode(27);
    const NEWLINE = String.fromCharCode(10);
    const HOSTILE = `bad${ESC}[31m${NEWLINE}- forged`;

    it("sanitizes the incomplete-scan rationale", () => {
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [{ ...omission, sourceDir: HOSTILE } as never],
        },
        caller,
      );
      expect(v.overallRationale).not.toContain(ESC);
      expect(v.overallRationale).not.toContain(`${NEWLINE}- forged`);
      // ...while the structured carrier keeps exactly the value passed to the classifier.
      expect(v.diagnostics[0]!.sourceDir).toBe(HOSTILE);
    });

    it("sanitizes the multi-session rationale and leaves `sessions[].sourceDir` raw", () => {
      const v = classifySessionGuard(
        { activeSessions: [{ ...mine(), sourceDir: HOSTILE }, theirs()], resumableSessions: [] },
        caller,
      );
      expect(v.overallRationale).not.toContain(ESC);
      expect(v.sessions.some((sv) => sv.sourceDir === HOSTILE)).toBe(true);
    });

    it("sanitizes the duplicate-id note", () => {
      const dup = (dir: string): ActiveSessionSummary => ({
        ...mine(),
        sourceDir: dir,
        sessionId: "aaaa1111-2222-3333-4444-555555555555",
      });
      const v = classifySessionGuard(
        { activeSessions: [dup("aaa"), dup(HOSTILE)], resumableSessions: [] },
        caller,
      );
      expect(v.transcriptionNotes.join(" ")).not.toContain(ESC);
      // The ESC is gone AND the `[` it was wearing is inert. `sanitizeDisplayText`
      // answers the terminal half of the threat; this note is also returned as
      // unfenced MCP text, so a `[` that survives into a rendering client is a
      // link waiting for a `(` -- in the sentence naming which session directory
      // to look at during a collision.
      expect(v.transcriptionNotes.join(" ")).toContain("dropped bad?\\[31m?- forged");
      expect(v.transcriptionNotes.join(" ")).not.toContain("bad?[31m");
    });

    it("neutralizes Markdown STRUCTURE in the notes, not only terminal escapes", () => {
      // A directory name is an arbitrary string and this note is rendered, so every
      // structural form has to arrive as text: a link, a raw HTML sink, a table
      // cell boundary, and a bare URL that a renderer would autolink on its own.
      const EVIL = "a](javascript:alert(1)) <img src=x onerror=alert(1)> | b https://evil.test @admin";
      const dup = (dir: string): ActiveSessionSummary => ({
        ...mine(),
        sourceDir: dir,
        sessionId: "aaaa1111-2222-3333-4444-555555555555",
      });
      const v = classifySessionGuard(
        { activeSessions: [dup("aaa"), dup(EVIL)], resumableSessions: [] },
        caller,
      );
      const note = v.transcriptionNotes.join(" ");

      expect(note).not.toContain("](javascript:");
      expect(note).not.toContain("<img");
      expect(note).toContain("&lt;img");
      // A raw `|` in a rendered table row splits the cell it is sitting in.
      expect(note).not.toContain(" | b");
      // Bare URL and mention broken at the character a renderer keys on.
      expect(note).not.toContain("https://evil.test");
      expect(note).not.toContain("@admin");
      // ...and the name is still on the structured field UNMODIFIED. Not "byte
     // for byte": this test hands the classifier a JavaScript string, and on
     // the real path `readdirSync` has already decoded the filesystem bytes, so
     // no layer here can make a byte-level claim. What is pinned is that the
     // guard passes through exactly what it was given.
      expect(v.collisions.some((c) => c.dropped === EVIL || c.kept === EVIL)).toBe(true);
    });

    it("counts SESSIONS, not diagnostic array entries, when a payload repeats one", () => {
      // Both copies are fully usable by every gate -- recognized kind, paired
      // category, well-typed fields -- so completeness stays `complete` and
      // neither is filtered out. Reading `.length` as a session count then told
      // the operator "2 sessions" for one record, with plural candidate grammar
      // and the placement sentence twice. The scan result is caller-supplied at
      // the typed seam, so nothing prevents the repeat.
      const entry = {
        ...benign,
        kind: "schema-version-undetermined",
        category: "undetermined",
        sessionId: "a",
        sourceDir: "a",
      };
      const v = classifySessionGuard(
        {
          activeSessions: [{ ...mine(), sessionId: "a", sourceDir: "a" }],
          resumableSessions: [],
          diagnostics: [entry as never, { ...entry } as never],
        },
        caller,
      );
      const prose = [...v.transcriptionNotes, v.overallRationale ?? ""].join(" ");

      expect(prose).toContain("a session");
      expect(prose, "counted the array, not the sessions").not.toContain("2 sessions");
      // Counted on the per-entry SENTENCES, not on the directory name. The
      // name here is the single letter `a`, which occurs inside almost every
      // word of the rationale, and the backticked form this used to count does
      // not occur at all -- so `<= 1` was measuring nothing and would have been
      // satisfied by prose that named no directory whatsoever. What the
      // duplicate entry must not do is emit either sentence twice.
      for (const sentence of ["is reported among the sessions above", "is a CANDIDATE to inspect"]) {
        expect(prose.split(sentence).length - 1, `"${sentence}" not emitted exactly once`).toBe(1);
      }
      // ...and the address is actually in there, which is the half the old
      // assertion silently stopped checking.
      expect(prose).toContain("a is a CANDIDATE to inspect");
      // ...and both raw entries are still passed through untouched, because a
      // consumer comparing against the payload needs what actually arrived.
      expect(v.diagnostics).toHaveLength(2);
    });

    it("hands the operator the FULL basename checklist, NUL included", () => {
      // A caller-supplied `sourceDir` can hold any code unit, including one no
      // filesystem name can contain. The checklist is stated in four places --
      // this prose, SKILL.md, and both fallback remedies -- and this copy is
      // the one an operator reads straight off the verdict. It had dropped the
      // NUL clause, so a reader following the verdict would carry the candidate
      // on to a filesystem call that throws rather than rejecting it as invalid
      // before ever touching the disk.
      const NUL = String.fromCharCode(0);
      // CORRELATED to a real record, because the checklist is only reached for
      // an entry that matched one. An uncorrelated entry gets the
      // invariant-violation sentence instead and names no candidate at all.
      const v = classifySessionGuard(
        {
          activeSessions: [{ ...mine(), sessionId: "a", sourceDir: `sess${NUL}x` }],
          resumableSessions: [],
          diagnostics: [
            {
              ...omission,
              kind: "schema-version-undetermined",
              category: "undetermined",
              sessionId: "a",
              sourceDir: `sess${NUL}x`,
              sourcePath: `/p/.story/sessions/sess${NUL}x/state.json`,
            } as never,
          ],
        },
        caller,
      );
      const prose = [...v.transcriptionNotes, v.overallRationale ?? ""].join(" ");

      expect(prose).toContain("no path separators");
      expect(prose).toContain("not `.` or `..`");
      expect(prose, "the checklist an operator reads omits the NUL clause").toContain("no NUL");
      // And the name itself is still rendered rather than passed through.
      expect(prose).not.toContain(NUL);
    });

    it("escapes the ADDRESS list without destroying its reversibility", () => {
      // The two halves of the rule meet here. `sanitizeDisplayPath` renders the
      // ESC as the six characters `\\u001b` so the operator can decode it back;
      // `escapeMarkdownDocumentStrict` then doubles that backslash, which is
      // what makes the escape survive rendering as literal text instead of
      // being eaten. Applied in the other order, the Markdown pass inserts its
      // backslash first and `sanitizeDisplayPath` then doubles THAT one, which
      // renders as an escaped backslash followed by a live `[`.
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [
            {
              ...omission,
              sourceDir: null,
              sourcePath: `/tmp/s/bad${ESC}[31m`,
            } as never,
          ],
        },
        caller,
      );
      const prose = [...v.transcriptionNotes, v.overallRationale ?? ""].join(" ");

      expect(prose).not.toContain(ESC);
      // Reversible escape present, and Markdown-escaped so it renders as itself.
      expect(prose).toContain("\\\\u001b");
      // The `[` that followed it is not structural any more.
      expect(prose).not.toContain("u001b[31m");
    });
  });

  /**
   * The remedy has to name a command that can actually show the fault.
   *
   * `storybloq session list` reaches a damaged row only through a contained
   * subdirectory of a readable `.story/sessions`. A fault against the sessions
   * directory itself, a non-directory entry, and an uncontained path are all
   * outside that reach, so sending an operator there prints nothing and reads as
   * "no problem" -- which is the dead end ISS-897 exists to close, reappearing in
   * the sentence written to close it.
   */
  describe("the incomplete-scan remedy is per-fault", () => {
    const conceal = (kind: string, sourceDir: string | null, sourcePath: string) =>
      ({ ...omission, kind, sourceDir, sourcePath }) as never;

    it("sends the operator to the PATH for faults `session list` cannot show", () => {
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [conceal("sessions-dir-unreadable", null, "/p/.story/sessions")],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("outside what `storybloq session list` can show");
      expect(v.overallRationale).toContain("/p/.story/sessions");
    });

    it("still names `session list` for faults it CAN show", () => {
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [conceal("state-missing", "half-created", "/p/.story/sessions/half-created/state.json")],
        },
        caller,
      );
      expect(v.overallRationale).toContain("Inspect half-created with `storybloq session list`");
      expect(v.overallRationale).not.toContain("outside what");
    });

    it("does not start a sentence with a lower-case conjunction", () => {
      // The gap census, the collection-shape note and the remedy are three
      // independently-assembled strings, and the shape note is CONDITIONAL, so
      // every assertion about the finished paragraph was written against the
      // branch where it is absent. With it present the rationale read "...an
      // entry the scan observed. so whether a session is running here cannot be
      // established." -- a sentence beginning mid-clause, in the one paragraph
      // an operator reads while deciding whether to intervene.
      //
      // Asserted over every shape that reaches this rationale rather than the
      // one that broke, because the defect is in how the pieces JOIN and the
      // next piece added will join the same way.
      const shapes: [string, { sourceDir: string | null; path: string }[]][] = [
        ["named only", [{ sourceDir: "a", path: "/p/.story/sessions/a/state.json" }]],
        ["collection only", [{ sourceDir: null, path: "/p/.story/sessions" }]],
        [
          "mixed",
          [
            { sourceDir: "a", path: "/p/.story/sessions/a/state.json" },
            { sourceDir: null, path: "/p/.story/sessions" },
          ],
        ],
        [
          "two collection-level",
          [
            { sourceDir: null, path: "/p/.story/sessions" },
            { sourceDir: null, path: "/q/.story/sessions" },
          ],
        ],
      ];
      for (const [label, gaps] of shapes) {
        const v = classifySessionGuard(
          {
            activeSessions: [],
            resumableSessions: [],
            diagnostics: gaps.map((g) => conceal("state-missing", g.sourceDir, g.path)),
          },
          caller,
        );
        expect(v.overallRationale, `${label}: lower-case sentence start`).not.toMatch(
          /\.\s+(?:so|and|but|or|which|because|then)\b/,
        );
      }
    });

    it("routes a LISTABLE kind with no directory name to the path instead", () => {
      // The combination the two tests above miss between them: one uses a blind
      // kind with a null `sourceDir`, the other a listable kind with a real one,
      // so the pair reads as complete while testing only the diagonal.
      //
      // `isUsableDiagnostic` accepts this shape, and correctly: it validates
      // `kind` and `sourceDir` separately because a null `sourceDir` is
      // legitimate on its own. Nothing upstream rules the pairing out, so if
      // the remedy splits on kind ALONE it hands `storybloq session list` a
      // fault with no directory name to look up and prints the raw path beside
      // a command that takes no path. The operator runs it, sees nothing, and
      // reads that as "no problem" -- which is the exact dead end this issue
      // exists to close.
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [conceal("state-missing", null, "/p/.story/sessions")],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("outside what `storybloq session list` can show");
      expect(v.overallRationale).toContain("/p/.story/sessions");
      // The claim that fails if the split is on kind alone.
      expect(v.overallRationale).not.toContain("with `storybloq session list`.");
    });

    it("keeps BOTH halves when one fault has a name and the other does not", () => {
      // Same kind, differing only in whether a directory name is available, so
      // the split cannot be explained by kind at all. Both sentences must
      // appear, each carrying only its own fault.
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [
            conceal("state-missing", "half-created", "/p/.story/sessions/half-created/state.json"),
            conceal("state-missing", null, "/p/.story/sessions"),
          ],
        },
        caller,
      );
      expect(v.overallRationale).toContain("Inspect half-created with `storybloq session list`");
      expect(v.overallRationale).toContain("outside what `storybloq session list` can show");
      // Scoped to the `session list` CLAUSE, not to the rationale. The opening
      // gap census names every gap by whatever address it has, including the
      // collection-level path -- that sentence reports what was missed and is
      // right to. The claim under test is narrower: the clause that hands names
      // to a command must contain only the fault that has one.
      const from = v.overallRationale.indexOf("Inspect ");
      const to = v.overallRationale.indexOf("with `storybloq session list`.");
      expect(from, "no session-list clause").toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      expect(v.overallRationale.slice(from, to)).not.toContain("/p/.story/sessions");
    });

    it("renders a collection-level path as an ADDRESS, not a label", () => {
      // `sourceDir` is null by design for a fault against the sessions directory
      // itself, so `sourcePath` is the only actionable address it has -- and the
      // 300-char label cap would turn a deeply nested one into a wrong path
      // rather than a shorter one.
      const deep = `/${"nested-project-directory/".repeat(20)}.story/sessions`;
      expect(deep.length).toBeGreaterThan(300);
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [conceal("sessions-dir-unreadable", null, deep)],
        },
        caller,
      );
      expect(v.overallRationale).toContain(deep);
      expect(v.overallRationale).not.toContain("(truncated)");
    });

    it("gives BOTH remedies when both kinds are present", () => {
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [
            conceal("state-missing", "half-created", "/p/.story/sessions/half-created/state.json"),
            conceal("entry-not-contained", "escapee", "/elsewhere/state.json"),
          ],
        },
        caller,
      );
      expect(v.overallRationale).toContain("Inspect half-created with `storybloq session list`");
      expect(v.overallRationale).toContain("outside what `storybloq session list` can show");
      expect(v.overallRationale).toContain("/elsewhere/state.json");
    });

    it("treats `entry-not-a-directory` as LISTABLE, because that command now shows it", () => {
      // This kind used to be blind, and correctly: `listAllSessionsDetailed`
      // dropped every non-directory with a bare `continue`, so naming
      // `storybloq session list` sent the operator to a command that printed
      // nothing -- the dead end this issue exists to close, moved one surface
      // downstream instead of removed.
      //
      // That function now surfaces the two shapes the scanner diagnoses (a
      // symlink of any name, a session-shaped name on a non-directory) in
      // `unavailable`, so the remedy has to follow. The membership of
      // `SESSION_LIST_BLIND_KINDS` is a claim about what that command reports,
      // and the two drifting apart is silent in both directions: blind-when-
      // visible hides a fault the operator could have seen, and
      // visible-when-blind sends them somewhere empty.
      const v = classifySessionGuard(
        {
          activeSessions: [],
          resumableSessions: [],
          diagnostics: [conceal("entry-not-a-directory", "dangling-link", "/p/.story/sessions/dangling-link")],
        },
        caller,
      );
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("Inspect dangling-link with `storybloq session list`");
      expect(v.overallRationale).not.toContain("outside what");
    });
  });

  /**
   * Absence means different things at the two seams, and this asymmetry is
   * deliberate. Here the argument was built in-process by a caller inside this
   * build, so absence is `complete` and every input written before the field
   * existed keeps its exact verdict. At the mode A boundary -- an untrusted
   * status payload off a server that may predate the field -- absence is
   * `unknown` and stops. Do not "fix" one to match the other.
   */
  it("omitting `diagnostics` entirely is backward compatible, NOT unknown", () => {
    const v = classifySessionGuard({ activeSessions: [mine()], resumableSessions: [] }, caller);
    expect(v.overallAction).toBe("continue");
    expect(v.scanCompleteness).toBe("complete");
    expect(v.diagnostics).toEqual([]);

    const empty = classifySessionGuard({ activeSessions: [], resumableSessions: [] }, caller);
    expect(empty.overallAction).toBe("free");
  });
});

/**
 * Unit coverage for the TYPED derivation only.
 *
 * Mode A does not execute this function -- it interprets the rendered prose in
 * `session-guard-fallback.md`. These tests can therefore stay green while that
 * table says something different, which is exactly what happened once: the
 * "no omission" row overlapped the malformed-element row and a mode A reader
 * could have classified `[null]` as complete. The rendered table is asserted in
 * `test/cli/session-guard-fallback.test.ts`; this block is not a substitute.
 */
describe("completenessFromDiagnostics (typed derivation)", () => {
  it("an empty array is a VERIFIED clean scan", () => {
    expect(completenessFromDiagnostics([])).toBe("complete");
  });

  it("a recognized non-omission category is clean when the entry is USABLE", () => {
    // Category alone is not enough for `complete`. A recognized non-omission
    // entry whose fields are garbage gets dropped before it can act, and
    // `owner-task-undetermined` is exactly a kind that WITHHOLDS the aggregate
    // -- so calling that payload clean would let losing data raise the verdict.
    const usable = {
      category: "normalized",
      kind: "mode-normalized",
      sourceDir: "d",
      sourcePath: "/p",
      sessionId: null,
      reason: "r",
    };
    expect(completenessFromDiagnostics([usable])).toBe("complete");
    expect(completenessFromDiagnostics([{ category: "normalized" }])).toBe("unknown");
    expect(completenessFromDiagnostics([{ ...usable, sourcePath: 7 }])).toBe("unknown");
  });

  it("a recognized omission is incomplete", () => {
    expect(completenessFromDiagnostics([{ category: "omission" }])).toBe("incomplete");
  });

  it.each([[null], [7], ["x"], [[]], [{}], [{ category: 7 }], [{ category: "future-thing" }]])(
    "an element this build cannot classify (%j) makes completeness unknown",
    (element) => {
      // A newer writer's category could perfectly well be concealing, so
      // reading an unrecognized one as harmless is a fail-open at the
      // deserialization boundary.
      expect(completenessFromDiagnostics([element])).toBe("unknown");
    },
  );

  it("a recognized omission WINS over malformed elements beside it", () => {
    // A positively identified concealment is not weakened by malformed
    // neighbours. Reporting `unknown` here would weaken a definite gap into
    // generic uncertainty, which is a strictly worse thing to hand an operator.
    // Note what is NOT being preserved: this fixture is `{ category: "omission" }`
    // and carries no address at all, so there is no `sourceDir` to lose. The
    // address stays unavailable until a FULLY USABLE omission supplies one --
    // that is a separate rule, and conflating the two is how the address claim
    // gets attached to a payload that cannot support it.
    expect(completenessFromDiagnostics([{ category: "omission" }, null, { category: "??" }])).toBe(
      "incomplete",
    );
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

// ---------------------------------------------------------------------------
// ISS-914: a collision withholds the aggregate only when a dropped record
// disagrees with its survivor on the policy signature, or when no survivor
// exists to compare it against. A matched comparison is waived.
// ---------------------------------------------------------------------------

describe("ISS-914 collision equivalence waiver", () => {
  const ME: OwnerTask = { client: "claude", id: "my-task" } as OwnerTask;
  const THEM: OwnerTask = { client: "claude", id: "other-task" } as OwnerTask;
  const CALLER_914 = { task: ME, client: "claude" as const };
  const ID = "cccc1111-2222-3333-4444-555555555555";

  const rec = (dir: string, over: Partial<ActiveSessionSummary> = {}): ActiveSessionSummary =>
    summary({ sessionId: ID, sourceDir: dir, ownerTask: ME, ...over });

  const judge = (activeSessions: ActiveSessionSummary[], resumableSessions: ActiveSessionSummary[] = []) =>
    classifySessionGuard({ activeSessions, resumableSessions }, CALLER_914);

  describe("the waiver itself", () => {
    it("waives an agreeing collision and returns the survivor's own action (AC 1)", () => {
      const v = judge([rec("aaa"), rec("zzz")]);
      expect(v.overallAction).toBe("continue");
      // Aggregate-only. The dropped record is still not a reported session:
      // the waiver decides what the AGGREGATE may say, not what is published.
      expect(v.sessions).toHaveLength(1);
      // Waiving the block never waives the report, in all three carriers.
      expect(v.collisions).toEqual([{ sessionId: ID, kept: "aaa", dropped: "zzz" }]);
      expect(v.transcriptionNotes.join(" ")).toContain("kept aaa, dropped zzz");
      expect(v.overallRationale).toContain("matched its survivor on the policy signature");
      expect(v.overallRationale).toContain("authorizes no deletion");
    });

    it("still blocks when the owners differ (AC 2)", () => {
      const v = judge([rec("aaa"), rec("zzz", { ownerTask: THEM })]);
      expect(v.overallAction).toBe("unverifiable");
      expect(v.overallRationale).toContain("cannot be computed from the survivors alone");
    });

    it("blocks a COMPACT/non-COMPACT pair that agrees on relationship AND action", () => {
      // THE case that separates the shipped rule from the filing's option 2.
      // Both records are a foreign owner holding a LIVE lease, so both resolve
      // to `foreign-live` / `monitor-only` -- and every capability flag inverts
      // between them. Comparing only relationship and action would waive a
      // collision between a record offering an owner-gone recovery path and one
      // offering none.
      const nonCompact = rec("aaa", { ownerTask: THEM });
      const compact = rec("zzz", { ownerTask: THEM, state: "COMPACT", compactPending: true });
      const solo = (r: ActiveSessionSummary) => judge([r]).sessions[0]!;
      const a = solo(nonCompact);
      const b = solo(compact);
      expect(a.relationship).toBe(b.relationship);
      expect(a.action).toBe(b.action);
      expect(a.resumable, "premise broken: the capabilities no longer differ").not.toBe(b.resumable);

      expect(judge([nonCompact, compact]).overallAction).toBe("unverifiable");
    });

    it("blocks a live record colliding with an expired COMPACT one (AC 3)", () => {
      // Membership is not free: `activeSessions` requires a live lease and
      // `resumableSessions` requires COMPACT + compactPending + a non-live
      // lease, so "one live, one expired" is necessarily the cross-array shape.
      //
      // Measured, and contrary to the filing's premise: this case does NOT
      // separate options 1 and 2. The survivor is `same-owner`/`continue` and
      // the dropped record is `expired-compact`/`offer-recovery`, so it blocks
      // on relationship AND action, and option 1 would block it too. The case
      // that actually separates them is the COMPACT/non-COMPACT pair above.
      const v = judge(
        [rec("live-dir")],
        [rec("compact-dir", { state: "COMPACT", compactPending: true, leaseState: "expired" })],
      );
      expect(v.sessions[0]?.relationship).toBe("same-owner");
      expect(v.overallAction).toBe("unverifiable");
    });

    it("waives when only NON-policy fields differ", () => {
      // The other direction: option 3 (also comparing `state`, `ticketId`,
      // `mode`) was rejected, and this pins that it was not adopted by accident.
      const v = judge([
        rec("aaa", { state: "IMPLEMENT", ticketId: "T-001", mode: "auto" }),
        rec("zzz", { state: "FINALIZE", ticketId: "T-999", mode: "manual" }),
      ]);
      expect(v.overallAction).toBe("continue");
    });
  });

  describe("the predicate, per field", () => {
    const base: SessionVerdict = {
      sessionId: ID, sourceDir: "a", population: "activeSessions",
      relationship: "same-owner", action: "continue", state: "IMPLEMENT", mode: "auto",
      ticketId: "T-1", ticketTitle: "t", leaseState: "live", leaseExpiresAt: null,
      compactPending: false, ownerTask: ME, rationale: "r",
      resumable: false, resumePermittedByProse: false, requiresTakeover: false,
      recoveryRequiresExplicitRequest: false, bindsOwner: false,
    } as SessionVerdict;

    const flipped = (field: (typeof POLICY_SIGNATURE_FIELDS)[number]): SessionVerdict => {
      const cur = base[field];
      const next = field === "relationship" ? "foreign-live" : field === "action" ? "monitor-only" : !cur;
      return { ...base, [field]: next } as SessionVerdict;
    };

    it("waives two identical verdicts", () => {
      expect(collisionBlocksAggregate({ ...base }, base)).toBe(false);
    });

    // One test per field. Required: the COMPACT/non-COMPACT case above flips all
    // five capabilities at once, so it cannot detect the removal of any single
    // one from the tuple.
    for (const field of POLICY_SIGNATURE_FIELDS) {
      it(`blocks when only \`${field}\` differs`, () => {
        expect(collisionBlocksAggregate(flipped(field), base)).toBe(true);
      });
    }

    it("ignores fields outside the signature", () => {
      const other = { ...base, state: "FINALIZE", ticketId: "T-2", mode: "manual", sourceDir: "b" } as SessionVerdict;
      expect(collisionBlocksAggregate(other, base)).toBe(false);
    });

    it("fails closed with no survivor to compare against", () => {
      // UNREACHABLE through `classifySessionGuard`: a dropped record's id was
      // seen, so its kept record is deduped and the verdict loop pushes a
      // verdict for every deduped entry. Tested here directly rather than
      // claimed to be covered by the classifier.
      expect(collisionBlocksAggregate(base, undefined)).toBe(true);
    });
  });

  describe("reporting", () => {
    it("keeps the dropped record's own classification note", () => {
      // A dropped record can be the ONLY carrier of a note: with identity
      // unavailable, a foreign COMPACT record emits the U2 note while the
      // non-COMPACT record at the same relationship and action emits none.
      const v = classifySessionGuard(
        {
          activeSessions: [
            rec("aaa", { ownerTask: THEM }),
            rec("zzz", { ownerTask: THEM, state: "COMPACT", compactPending: true }),
          ],
          resumableSessions: [],
        },
        { task: null, client: "claude" },
      );
      const notes = v.transcriptionNotes.join(" ");
      expect(notes, "the dropped participant's own note was suppressed").toContain("U2:");
      // ...and it must say the record is not among the reported sessions, or the
      // note reads as though it described one of them.
      expect(notes).toContain("Dropped collision participant");
      expect(notes).toContain("is NOT reported among the sessions above");
    });

    it("retains the OTHER note site too: an expired-COMPACT dropped participant", () => {
      // There are exactly two classification note sites, and they run through
      // DIFFERENT classifiers. Covering only the live-population one would let a
      // wrong population dispatch, or a loss specific to `classifyResumable`,
      // pass unnoticed. This is the cross-array shape: the survivor arrives in
      // `activeSessions` and the dropped participant in `resumableSessions`, so
      // it is also the case where the population discriminator matters.
      const v = classifySessionGuard(
        {
          activeSessions: [rec("live-dir")],
          resumableSessions: [rec("compact-dir", { state: "COMPACT", compactPending: true, leaseState: "expired" })],
        },
        { task: null, client: "claude" },
      );
      const dropped = v.transcriptionNotes.find((n) => n.includes("Dropped collision participant"));
      expect(dropped, "the expired-COMPACT participant's note was lost").toBeDefined();
      expect(dropped).toContain("U5:");
      expect(dropped).toContain("compact-dir");
      expect(dropped).toContain("is NOT reported among the sessions above");
    });

    it("orders notes deterministically: collision, then survivor, then dropped", () => {
      // BOTH participants must emit a classification note, or this test cannot
      // detect the survivor's note moving after the dropped one. Two foreign
      // COMPACT records with no caller identity each emit U2; only the dropped
      // one is prefixed, which is what tells them apart here.
      const v = classifySessionGuard(
        {
          activeSessions: [
            rec("aaa", { ownerTask: THEM, state: "COMPACT", compactPending: true }),
            rec("zzz", { ownerTask: THEM, state: "COMPACT", compactPending: true }),
          ],
          resumableSessions: [],
        },
        { task: null, client: "claude" },
      );
      const collisionNote = v.transcriptionNotes.findIndex((n) => n.includes("kept aaa, dropped zzz"));
      const survivorNote = v.transcriptionNotes.findIndex((n) => n.startsWith("U2:"));
      const droppedNote = v.transcriptionNotes.findIndex((n) => n.includes("Dropped collision participant"));
      expect(collisionNote, "no collision note").toBeGreaterThan(-1);
      expect(survivorNote, "the survivor emitted no note, so ordering is untestable").toBeGreaterThan(-1);
      expect(droppedNote, "no dropped-participant note").toBeGreaterThan(-1);
      // Not the order a classify-before-deduplicate pipeline would produce. The
      // claim this change makes is about VERDICTS, which are order-independent
      // because the classifiers are pure; note order is pinned here so it
      // cannot drift silently.
      expect(collisionNote).toBeLessThan(survivorNote);
      expect(survivorNote).toBeLessThan(droppedNote);
    });

    it("reports a waived collision even when an INDEPENDENT blocker withholds", () => {
      // Without this, re-gating the collision clause on blocking-only would make
      // an agreeing collision vanish from the one field a reader looks at first.
      const v = classifySessionGuard(
        {
          activeSessions: [rec("aaa"), rec("zzz")],
          resumableSessions: [],
          diagnostics: [{ kind: "unreadable-session", category: "omission", sourceDir: "gone" }],
        } as unknown as SessionScanResult,
        CALLER_914,
      );
      expect(v.overallAction, "the independent blocker stopped blocking").toBe("unverifiable");
      expect(v.overallRationale, "the waived collision vanished").toContain(
        "matched its survivor on the policy signature",
      );
    });

    it("reports BOTH sets when one collision blocks and another is waived", () => {
      const OTHER_ID = "dddd1111-2222-3333-4444-555555555555";
      const v = judge([
        rec("agree-a"), rec("agree-b"),
        summary({ sessionId: OTHER_ID, sourceDir: "differ-a", ownerTask: ME }),
        summary({ sessionId: OTHER_ID, sourceDir: "differ-b", ownerTask: THEM }),
      ]);
      // Two surviving verdicts, so the aggregate is `null` on population
      // grounds; the point here is that the RATIONALE accounts for both
      // collisions rather than only the blocking one.
      expect(v.collisions).toHaveLength(2);
      // Counts alone are not enough: with several ids colliding at once an
      // operator cannot tell WHICH participant blocked. Each outcome names its
      // own directories.
      expect(v.overallRationale).toContain("(dropped differ-b)");
      expect(v.overallRationale).toContain("disagrees with its survivor about what the caller may do");
      expect(v.overallRationale).toContain("(dropped agree-b)");
      expect(v.overallRationale).toContain("matched its survivor on the policy signature");
      expect(v.overallRationale).toContain("not lost from a result that blocks for a different one");
    });
  });

  it("compares exactly the fields the generated fallback tells mode A to compare", () => {
    // The signature would otherwise live twice, as this tuple and as prose in
    // the fixture, with nothing tying them together. The byte-identity test
    // proves only that the Markdown matches the fixture; it cannot detect the
    // typed guard comparing a different set than mode A is instructed to.
    const fixture = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "session-guard-matrix.json"), "utf-8"),
    ) as { collisionWaiverRule: { policySignatureFields: string[] } };
    expect(fixture.collisionWaiverRule.policySignatureFields).toEqual([...POLICY_SIGNATURE_FIELDS]);
  });
});
