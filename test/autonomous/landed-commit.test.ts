/**
 * T-534: the landed-commit evidence and the two rules applied to it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn(),
  gitDiffTreeNames: vi.fn(),
  gitIsAncestor: vi.fn(),
}));

import { gitHead, gitDiffTreeNames, gitIsAncestor } from "../../src/autonomous/git-inspector.js";
import {
  classifyLandedCommit,
  finalizeEnterRoute,
  inspectLandedCommit,
  type LandedCommitEvidence,
} from "../../src/autonomous/landed-commit.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

const head = vi.mocked(gitHead);
const tree = vi.mocked(gitDiffTreeNames);
const ancestor = vi.mocked(gitIsAncestor);
const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

const state = (over: Record<string, unknown> = {}) =>
  ({ finalizeCheckpoint: null, ticket: { id: "T-001" }, currentIssue: null, ...over }) as unknown as FullSessionState;
const ev = (over: Partial<LandedCommitEvidence>): LandedCommitEvidence => ({
  checkpoint: false,
  baseline: BASE,
  head: HEAD,
  headMoved: true,
  tree: "hasItem",
  ancestry: "descendant",
  ...over,
});

beforeEach(() => {
  head.mockReset();
  tree.mockReset();
  ancestor.mockReset();
  head.mockResolvedValue({ ok: true, data: { hash: HEAD, branch: "main" } });
  tree.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] });
  ancestor.mockResolvedValue({ ok: true, data: true });
});

describe("inspectLandedCommit", () => {
  it("reads HEAD, the commit's files and, only when asked, ancestry", async () => {
    expect(await inspectLandedCommit("/r", state(), BASE, { ancestry: false })).toEqual(ev({ ancestry: null }));
    expect(ancestor).not.toHaveBeenCalled();
    expect(await inspectLandedCommit("/r", state(), BASE, { ancestry: true })).toEqual(ev({}));
    expect(ancestor).toHaveBeenCalledWith("/r", BASE, HEAD);
  });

  it("stops early on a committed checkpoint, a missing baseline, an unreadable or unmoved HEAD", async () => {
    expect(await inspectLandedCommit("/r", state({ finalizeCheckpoint: "committed" }), BASE, { ancestry: true })).toMatchObject({ checkpoint: true, head: null });
    expect(await inspectLandedCommit("/r", state(), null, { ancestry: true })).toMatchObject({ baseline: null, head: null });
    head.mockResolvedValueOnce({ ok: false, reason: "git_error", message: "x" });
    expect(await inspectLandedCommit("/r", state(), BASE, { ancestry: true })).toMatchObject({ head: null, headMoved: false });
    head.mockResolvedValueOnce({ ok: true, data: { hash: BASE, branch: "main" } });
    expect(await inspectLandedCommit("/r", state(), BASE, { ancestry: true })).toMatchObject({ head: BASE, headMoved: false, tree: null });
    expect(tree).not.toHaveBeenCalled();
  });

  it("classifies the commit's files against the ticket or the issue", async () => {
    tree.mockResolvedValue({ ok: true, data: ["src/x.ts"] });
    expect((await inspectLandedCommit("/r", state(), BASE, { ancestry: false })).tree).toBe("lacksItem");
    tree.mockResolvedValue({ ok: true, data: [".story/issues/ISS-9.json"] });
    expect((await inspectLandedCommit("/r", state({ currentIssue: { id: "ISS-9" } }), BASE, { ancestry: false })).tree).toBe("hasItem");
    tree.mockResolvedValue({ ok: false, reason: "git_error", message: "x" });
    expect((await inspectLandedCommit("/r", state(), BASE, { ancestry: false })).tree).toBe("unavailable");
    expect((await inspectLandedCommit("/r", state({ ticket: null }), BASE, { ancestry: false })).tree).toBe("noItem");
    ancestor.mockResolvedValue({ ok: false, reason: "git_error", message: "x" });
    expect((await inspectLandedCommit("/r", state(), BASE, { ancestry: true })).ancestry).toBe("unknown");
    ancestor.mockResolvedValue({ ok: true, data: false });
    expect((await inspectLandedCommit("/r", state(), BASE, { ancestry: true })).ancestry).toBe("divergent");
  });
});

describe("finalizeEnterRoute (enter()'s rule, ancestry ignored)", () => {
  it.each([
    [ev({ checkpoint: true }), "committed"],
    [ev({ headMoved: false }), "staging"],
    [ev({ tree: "hasItem", ancestry: "divergent" }), "fast-path"],
    [ev({ tree: "hasItem", ancestry: "unknown" }), "fast-path"],
    [ev({ tree: "noItem" }), "fast-path"],
    [ev({ tree: "lacksItem" }), "staging"],
    [ev({ tree: "unavailable" }), "staging"],
  ] as const)("%o -> %s", (e, route) => {
    expect(finalizeEnterRoute(e)).toBe(route);
  });
});

describe("classifyLandedCommit (the retirement's rule)", () => {
  it.each([
    [ev({ checkpoint: true }), "committed"],
    [ev({ baseline: null }), "unavailable"],
    [ev({ head: null, headMoved: false }), "unavailable"],
    [ev({ headMoved: false }), "nothing-landed"],
    [ev({ tree: "noItem" }), "unattributed"],
    [ev({ tree: "unavailable" }), "unavailable"],
    [ev({ ancestry: "unknown" }), "unavailable"],
    [ev({ ancestry: null }), "unavailable"],
    [ev({ ancestry: "divergent" }), "unrelated"],
    [ev({ tree: "lacksItem" }), "unrelated"],
    [ev({}), "verified"],
  ] as const)("%o -> %s", (e, cls) => {
    expect(classifyLandedCommit(e)).toBe(cls);
  });
});
