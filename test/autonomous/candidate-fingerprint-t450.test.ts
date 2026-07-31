/**
 * T-450 step 2: the evidence fingerprint.
 *
 * The fingerprint answers exactly one question, "did the picture the human was
 * shown change?", and it is NOT the eligibility check. That split exists
 * because the first design folded the observation time and the computed ages
 * into the digest and then required an exact match against a recomputation, so
 * a legitimate confirmation self-invalidated a second later even though no
 * underlying signal had moved.
 *
 * The consequence is subtler than "exclude observedAt". Several signal fields
 * that LOOK like observations are actually verdicts about the clock:
 * `activity.kind` flips `fresh` -> `stale` with nothing but elapsed time, and
 * `lease.kind` flips `live` -> `expired` the same way. Digesting either would
 * reintroduce the defect through a different field. So the rule is: where a
 * usable stored value exists, digest the VALUE and not its fresh/stale or
 * live/expired classification. Where none exists, the reason IS digested,
 * including the clock-derived `future`, because absent, unparseable and
 * clock-skewed are three different pictures and collapsing them would let one
 * confirm against another.
 *
 * Whether the owner is still eligible NOW is the separate in-lock re-evaluation
 * and is deliberately not this function's job.
 */
import { describe, it, expect } from "vitest";
import {
  evidenceFingerprint,
  OWNER_STALE_MS,
  type OwnerLivenessSignals,
} from "../../src/autonomous/liveness.js";
import type { OwnerTask } from "../../src/autonomous/client-profile.js";

const AT = "2027-01-15T00:00:00.000Z";
const OWNER: OwnerTask = { client: "claude", id: "owner-task-aaa", boundAt: AT };
const OTHER: OwnerTask = { client: "claude", id: "other-task-bbb", boundAt: AT };
const LEASE_AT = "2027-01-15T00:40:00.000Z";

/** A complete, realistic candidate-shaped signal set. */
function signals(overrides: Partial<OwnerLivenessSignals> = {}): OwnerLivenessSignals {
  return {
    activity: { kind: "stale", at: AT, ageMs: 11 * 60_000 },
    lease: { kind: "live", expiresAt: LEASE_AT, remainingMs: 5 * 60_000 },
    deathMarker: { kind: "shutdown-marker", at: AT },
    markerValidity: { kind: "not-invalidated", pid: 4242, recordedAt: AT },
    sidecarProbe: { kind: "absent", pid: 4242 },
    observedAt: "2027-01-15T00:35:00.000Z",
    staleThresholdMs: OWNER_STALE_MS,
    successors: { kind: "observed", servers: [] },
    ...overrides,
  } as OwnerLivenessSignals;
}

describe("T-450: the fingerprint identifies the picture, not the moment", () => {
  it("is stable across a different observation time", () => {
    const a = evidenceFingerprint(signals());
    const b = evidenceFingerprint(signals({ observedAt: "2027-01-15T09:99:00.000Z".replace("99", "59") }));
    expect(b).toBe(a);
  });

  it("is stable across a changed activity AGE with the same timestamp", () => {
    const a = evidenceFingerprint(signals());
    const b = evidenceFingerprint(signals({
      activity: { kind: "stale", at: AT, ageMs: 99 * 60_000 },
    }));
    expect(b).toBe(a);
  });

  it("is stable when activity RECLASSIFIES fresh to stale on the same timestamp", () => {
    // The trap: `kind` is a verdict about the clock, not an observation. A
    // confirmation must not be invalidated purely because time passed.
    const a = evidenceFingerprint(signals({
      activity: { kind: "fresh", at: AT, ageMs: 5_000 },
    }));
    const b = evidenceFingerprint(signals({
      activity: { kind: "stale", at: AT, ageMs: 11 * 60_000 },
    }));
    expect(b).toBe(a);
  });

  it("is stable when the lease RECLASSIFIES live to expired on the same expiry", () => {
    const a = evidenceFingerprint(signals({
      lease: { kind: "live", expiresAt: LEASE_AT, remainingMs: 60_000 },
    }));
    const b = evidenceFingerprint(signals({
      lease: { kind: "expired", expiresAt: LEASE_AT, agoMs: 60_000 },
    }));
    expect(b).toBe(a);
  });

  it("is stable across the whole set of clock-derived fields at once", () => {
    const a = evidenceFingerprint(signals());
    const b = evidenceFingerprint(signals({
      activity: { kind: "fresh", at: AT, ageMs: 1 },
      lease: { kind: "expired", expiresAt: LEASE_AT, agoMs: 7 },
      observedAt: "2027-02-01T12:00:00.000Z",
    }));
    expect(b).toBe(a);
  });
});

describe("T-450: the fingerprint changes when the picture actually changes", () => {
  const base = () => evidenceFingerprint(signals());

  it("a different lastGuideCall timestamp", () => {
    expect(evidenceFingerprint(signals({
      activity: { kind: "stale", at: "2027-01-14T00:00:00.000Z", ageMs: 11 * 60_000 },
    }))).not.toBe(base());
  });

  it("activity present versus absent", () => {
    expect(evidenceFingerprint(signals({
      activity: { kind: "unknown", reason: "absent" },
    }))).not.toBe(base());
  });

  it("absent and unparseable activity are distinguishable", () => {
    const absent = evidenceFingerprint(signals({ activity: { kind: "unknown", reason: "absent" } }));
    const bad = evidenceFingerprint(signals({ activity: { kind: "unknown", reason: "unparseable" } }));
    expect(bad).not.toBe(absent);
  });

  it("future is distinguishable from absent and unparseable", () => {
    // Kept deliberately: three different pictures, and collapsing them would
    // let one confirm against another.
    const fps = ["absent", "unparseable", "future"].map((reason) =>
      evidenceFingerprint(signals({ activity: { kind: "unknown", reason } as never })));
    expect(new Set(fps).size).toBe(3);
  });

  it("a different lease expiry", () => {
    expect(evidenceFingerprint(signals({
      lease: { kind: "live", expiresAt: "2027-01-15T01:40:00.000Z", remainingMs: 5 * 60_000 },
    }))).not.toBe(base());
  });

  it("a different death marker kind", () => {
    expect(evidenceFingerprint(signals({
      deathMarker: { kind: "alive-zero", at: AT },
    }))).not.toBe(base());
  });

  it("a different death marker timestamp", () => {
    expect(evidenceFingerprint(signals({
      deathMarker: { kind: "shutdown-marker", at: "2027-01-14T00:00:00.000Z" },
    }))).not.toBe(base());
  });

  it("a live alive-file value, which is a raw observation and not a derived age", () => {
    const one = evidenceFingerprint(signals({ deathMarker: { kind: "none", aliveAt: 1_800_000_000_000 } }));
    const two = evidenceFingerprint(signals({ deathMarker: { kind: "none", aliveAt: 1_800_000_001_000 } }));
    expect(two).not.toBe(one);
  });

  it("a different recorded MCP pid", () => {
    expect(evidenceFingerprint(signals({
      markerValidity: { kind: "not-invalidated", pid: 9999, recordedAt: AT },
    }))).not.toBe(base());
  });

  it("a different marker-validity disposition", () => {
    expect(evidenceFingerprint(signals({
      markerValidity: { kind: "unknown", reason: "successors-unavailable", pid: 4242 },
    }))).not.toBe(base());
  });

  it("a different sidecar probe disposition", () => {
    expect(evidenceFingerprint(signals({
      sidecarProbe: { kind: "match", pid: 4242 },
    }))).not.toBe(base());
  });

  it("a different sidecar identity at the same disposition", () => {
    expect(evidenceFingerprint(signals({
      sidecarProbe: { kind: "absent", pid: 5151 },
    }))).not.toBe(base());
  });

  it("a successor appearing", () => {
    expect(evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 77, identity: OWNER, registeredAt: AT }] },
    }))).not.toBe(base());
  });

  it("an unavailable registry versus an empty one", () => {
    expect(evidenceFingerprint(signals({
      successors: { kind: "unavailable", reason: "registry directory does not exist" },
    }))).not.toBe(base());
  });

  it("a successor's IDENTITY changing at the same pid", () => {
    // Identity is what the predicate reads (ruling C-2), so two listings that
    // differ only in whose server is running are two different pictures. A
    // fingerprint that missed this would let a confirmation carry over the
    // moment the owner's client was replaced by somebody else's.
    const owner = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 77, identity: OWNER, registeredAt: AT }] },
    }));
    const other = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 77, identity: OTHER, registeredAt: AT }] },
    }));
    expect(other).not.toBe(owner);
  });

  it("an attributable successor versus an unattributable one", () => {
    const attributed = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 77, identity: OWNER, registeredAt: AT }] },
    }));
    const anonymous = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 77, identity: null, registeredAt: AT }] },
    }));
    expect(anonymous).not.toBe(attributed);
  });

  it("a successor's boundAt, which the PREDICATE ignores, still changes it", () => {
    // Deliberate, and the reasoning is worth keeping because the opposite is
    // arguable. `boundAt` is not part of identity matching, so digesting it can
    // make a human reconfirm on a change that could not have altered the
    // verdict.
    //
    // It stays in for two reasons. This function's rule is to digest stored
    // VALUES and exclude only clock-DERIVED classifications, and `boundAt` is a
    // stored value: it moves when a client rebinds, not with the passage of
    // time, so it cannot self-invalidate a confirmation the way `activity.kind`
    // would. And `registeredAt`, which the predicate also ignores, is digested
    // for exactly the same reason. Normalizing one and not the other would buy
    // nothing and leave the rule incoherent.
    const before = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 77, identity: OWNER, registeredAt: AT }] },
    }));
    const rebound = evidenceFingerprint(signals({
      successors: {
        kind: "observed",
        servers: [{ pid: 77, identity: { ...OWNER, boundAt: "2027-06-01T00:00:00.000Z" }, registeredAt: AT }],
      },
    }));
    expect(rebound).not.toBe(before);
  });

  it("the same task id under a different CLIENT", () => {
    // The two are different tasks, and the predicate treats them as such, so
    // the evidence has to distinguish them too.
    const claude = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 77, identity: OWNER, registeredAt: AT }] },
    }));
    const codex = evidenceFingerprint(signals({
      successors: {
        kind: "observed",
        servers: [{ pid: 77, identity: { ...OWNER, client: "codex" }, registeredAt: AT }],
      },
    }));
    expect(codex).not.toBe(claude);
  });
});

describe("T-450: the fingerprint is canonical", () => {
  it("does not depend on key insertion order", () => {
    const a = evidenceFingerprint(signals());
    const reordered = {
      successors: { kind: "observed", servers: [] },
      staleThresholdMs: OWNER_STALE_MS,
      observedAt: "2027-01-15T00:35:00.000Z",
      sidecarProbe: { kind: "absent", pid: 4242 },
      markerValidity: { kind: "not-invalidated", pid: 4242, recordedAt: AT },
      deathMarker: { kind: "shutdown-marker", at: AT },
      lease: { kind: "live", expiresAt: LEASE_AT, remainingMs: 5 * 60_000 },
      activity: { kind: "stale", at: AT, ageMs: 11 * 60_000 },
    } as OwnerLivenessSignals;
    expect(evidenceFingerprint(reordered)).toBe(a);
  });

  it("does not depend on key order INSIDE a nested signal", () => {
    // The top-level order never reaches the digest, because `canonical` is
    // rebuilt in a fixed order. Nested signals are passed through as-is, so
    // this is where canonicalization actually has to do work.
    const a = evidenceFingerprint(signals({
      markerValidity: { kind: "not-invalidated", pid: 4242, recordedAt: AT },
    }));
    const b = evidenceFingerprint(signals({
      markerValidity: { recordedAt: AT, pid: 4242, kind: "not-invalidated" } as never,
    }));
    expect(b).toBe(a);
  });

  it("does not depend on successorPids enumeration order", () => {
    // successorPids comes from the same directory listing as `servers`, so
    // normalizing one and not the other digests identical evidence two ways.
    const a = evidenceFingerprint(signals({
      markerValidity: { kind: "invalidated", reason: "superseded-by-owner-identity", pid: 4242, recordedAt: AT, successorPids: [3, 8, 11] },
    }));
    const b = evidenceFingerprint(signals({
      markerValidity: { kind: "invalidated", reason: "superseded-by-owner-identity", pid: 4242, recordedAt: AT, successorPids: [11, 3, 8] },
    }));
    expect(b).toBe(a);
  });

  it("does not depend on key order inside a successor entry", () => {
    const a = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 7, identity: OWNER, registeredAt: AT }] },
    }));
    const b = evidenceFingerprint(signals({
      successors: { servers: [{ registeredAt: AT, identity: OWNER, pid: 7 }], kind: "observed" } as never,
    }));
    expect(b).toBe(a);
  });

  it("does not depend on successor enumeration order", () => {
    const one = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 5, identity: OWNER, registeredAt: AT }, { pid: 9, identity: OTHER, registeredAt: AT }] },
    }));
    const two = evidenceFingerprint(signals({
      successors: { kind: "observed", servers: [{ pid: 9, identity: OTHER, registeredAt: AT }, { pid: 5, identity: OWNER, registeredAt: AT }] },
    }));
    expect(two).toBe(one);
  });

  it("is a stable opaque token, safe to persist and echo back", () => {
    const fp = evidenceFingerprint(signals());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceFingerprint(signals())).toBe(fp);
  });
});
