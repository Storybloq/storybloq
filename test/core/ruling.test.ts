import { describe, it, expect } from "vitest";
import {
  rulingAttributionCaveat,
  buildSuccessorIndex,
  buildCitationResolutionContext,
  resolveCitation,
  citationWarningText,
  validateSupersedeCandidate,
} from "../../src/core/ruling.js";
import type { Ruling } from "../../src/models/ruling.js";

function ruling(overrides: Partial<Ruling> & { id: string }): Ruling {
  return {
    text: "some ruling text",
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "claude-session-abc" },
    date: "2026-08-27",
    scopeTags: [],
    supersedes: null,
    ...overrides,
  } as Ruling;
}

describe("rulingAttributionCaveat", () => {
  it("renders unconditionally regardless of attribution value (binding pen ruling)", () => {
    // The caveat function itself takes no `attribution` parameter at all --
    // this is what makes attribution-conditional rendering structurally
    // impossible for a future refactor to reintroduce by accident.
    const text = rulingAttributionCaveat({ client: "claude", id: "claude-session-abc" });
    expect(text).toContain("Attribution is a CLAIM asserted by the recorder, not verified by storybloq");
    expect(text).toContain("claude/claude-session-abc");
    expect(text).toContain("does not replace the second key");
  });
});

describe("buildSuccessorIndex", () => {
  it("maps a predecessor to its single successor", () => {
    const rulings = [ruling({ id: "r-a" }), ruling({ id: "r-b", supersedes: "r-a" })];
    const index = buildSuccessorIndex(rulings);
    expect(index.successorsByTarget.get("r-a")).toEqual(["r-b"]);
    expect(index.branchedTargets.size).toBe(0);
  });

  it("flags a target with more than one successor as branched", () => {
    const rulings = [
      ruling({ id: "r-a" }),
      ruling({ id: "r-b", supersedes: "r-a" }),
      ruling({ id: "r-c", supersedes: "r-a" }),
    ];
    const index = buildSuccessorIndex(rulings);
    expect(index.branchedTargets.has("r-a")).toBe(true);
  });
});

describe("resolveCitation", () => {
  it("resolves a citation with no successor to itself, not stale", () => {
    const rulings = [ruling({ id: "r-a" })];
    const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
    const res = resolveCitation("r-a", ctx);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.stale).toBe(false);
      expect(res.current.id).toBe("r-a");
      expect(citationWarningText(res)).toBe("");
    }
  });

  it("resolves a chain to its current (latest) ruling, marked stale", () => {
    const rulings = [
      ruling({ id: "r-a", text: "old text" }),
      ruling({ id: "r-b", supersedes: "r-a", text: "new text" }),
    ];
    const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
    const res = resolveCitation("r-a", ctx);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") {
      expect(res.stale).toBe(true);
      expect(res.current.id).toBe("r-b");
      expect(res.current.text).toBe("new text");
      expect(res.cited.text).toBe("old text");
      expect(citationWarningText(res)).toMatch(/superseded by r-b/);
    }
  });

  it("follows a multi-hop chain to the true current ruling", () => {
    const rulings = [
      ruling({ id: "r-a" }),
      ruling({ id: "r-b", supersedes: "r-a" }),
      ruling({ id: "r-c", supersedes: "r-b" }),
    ];
    const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
    const res = resolveCitation("r-a", ctx);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.current.id).toBe("r-c");
  });

  it("reports missing for an id that never existed, when the scan is complete", () => {
    const ctx = buildCitationResolutionContext([], new Set(), "complete");
    const res = resolveCitation("r-nope", ctx);
    expect(res).toEqual({ status: "missing", citedId: "r-nope" });
  });

  it("reports unreadable for a cited id itself in unavailableIds", () => {
    const ctx = buildCitationResolutionContext([], new Set(["r-broken"]), "complete");
    const res = resolveCitation("r-broken", ctx);
    expect(res).toEqual({ status: "unreadable", citedId: "r-broken" });
  });

  it("reports branch when a target has competing successors", () => {
    const rulings = [
      ruling({ id: "r-a" }),
      ruling({ id: "r-b", supersedes: "r-a" }),
      ruling({ id: "r-c", supersedes: "r-a" }),
    ];
    const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
    const res = resolveCitation("r-a", ctx);
    expect(res.status).toBe("branch");
    if (res.status === "branch") {
      expect([...res.competingSuccessors].sort()).toEqual(["r-b", "r-c"]);
    }
  });

  it("reports cycle rather than looping forever on a corrupted supersedes cycle", () => {
    const rulings = [
      ruling({ id: "r-a", supersedes: "r-b" }),
      ruling({ id: "r-b", supersedes: "r-a" }),
    ];
    const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
    const res = resolveCitation("r-a", ctx);
    expect(res.status).toBe("cycle");
  });

  it("ruling #4: every citation is indeterminate (incomplete-scan) when scanCompleteness is not complete, never missing", () => {
    const rulings = [ruling({ id: "r-a" })];
    const ctx = buildCitationResolutionContext(rulings, new Set(), "incomplete");
    const res = resolveCitation("r-a", ctx);
    expect(res).toEqual({ status: "indeterminate", citedId: "r-a", reason: "incomplete-scan" });
    // Even an id that would otherwise resolve cleanly is indeterminate, not "resolved".
    const resUnknownId = resolveCitation("r-does-not-exist-either", ctx);
    expect(resUnknownId).toEqual({ status: "indeterminate", citedId: "r-does-not-exist-either", reason: "incomplete-scan" });
  });

  it("rulings #3/#7: ANY unreadable ruling anywhere taints an otherwise-clean resolution to indeterminate, never `current`", () => {
    // r-broken is a completely unrelated ruling elsewhere in the project.
    // buildSuccessorIndex can never see what r-broken's own (unreadable)
    // supersedes field would have said, so r-a cannot be proven to have no
    // hidden successor -- the resolution must not claim `current`.
    const rulings = [ruling({ id: "r-a" })];
    const ctx = buildCitationResolutionContext(rulings, new Set(["r-broken"]), "complete");
    const res = resolveCitation("r-a", ctx);
    expect(res).toEqual({ status: "indeterminate", citedId: "r-a", reason: "unreadable-successor" });
    expect(citationWarningText(res)).toMatch(/chain state unverifiable/);
  });

  it("resolves cleanly once the project has zero unavailable rulings and a complete scan", () => {
    const rulings = [ruling({ id: "r-a" })];
    const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
    const res = resolveCitation("r-a", ctx);
    expect(res.status).toBe("resolved");
  });
});

describe("validateSupersedeCandidate", () => {
  it("accepts a clean one-time link", () => {
    const rulings = [ruling({ id: "r-a" }), ruling({ id: "r-b" })];
    expect(validateSupersedeCandidate(rulings, "r-b", "r-a")).toBeNull();
  });

  it("rejects a self-link", () => {
    const rulings = [ruling({ id: "r-a" })];
    const refusal = validateSupersedeCandidate(rulings, "r-a", "r-a");
    expect(refusal?.code).toBe("self_link");
  });

  it("rejects a dangling target", () => {
    const rulings = [ruling({ id: "r-b" })];
    const refusal = validateSupersedeCandidate(rulings, "r-b", "r-does-not-exist");
    expect(refusal?.code).toBe("dangling_target");
  });

  it("rejects a branch (target would get a second successor)", () => {
    const rulings = [ruling({ id: "r-a" }), ruling({ id: "r-b", supersedes: "r-a" }), ruling({ id: "r-c" })];
    const refusal = validateSupersedeCandidate(rulings, "r-c", "r-a");
    expect(refusal?.code).toBe("branch");
  });

  it("rejects a candidate that would create a cycle", () => {
    const rulings = [ruling({ id: "r-a" }), ruling({ id: "r-b", supersedes: "r-a" })];
    // r-a would now supersede r-b, but r-b already supersedes r-a: a-> b -> a cycle.
    const refusal = validateSupersedeCandidate(rulings, "r-a", "r-b");
    expect(refusal?.code).toBe("cycle");
  });

  it("accepts a multi-hop candidate graph with no cycle", () => {
    const rulings = [ruling({ id: "r-a" }), ruling({ id: "r-b", supersedes: "r-a" })];
    expect(validateSupersedeCandidate(rulings, "r-c", "r-b")).toBeNull();
  });

  it("rejects a multi-node cycle (a->c, b->a, proposed c->b closes the loop)", () => {
    const rulings = [
      ruling({ id: "r-a", supersedes: "r-c" }),
      ruling({ id: "r-b", supersedes: "r-a" }),
      ruling({ id: "r-c" }),
    ];
    // Proposed: r-c now supersedes r-b. Existing edges: a->c, b->a. Adding
    // c->b closes a 3-node loop: c -> b -> a -> c.
    const refusal = validateSupersedeCandidate(rulings, "r-c", "r-b");
    expect(refusal?.code).toBe("cycle");
  });
});
