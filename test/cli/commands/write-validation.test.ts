/**
 * ISS-065: Write-path multiset diff - pre-existing errors don't block unrelated writes.
 *
 * Tests the validatePostWriteState and validatePostWriteIssueState behavior
 * indirectly via validateProject pre/post comparison (same logic).
 */
import { describe, it, expect } from "vitest";
import { validateProject } from "../../../src/core/validation.js";
import { ProjectState } from "../../../src/core/project-state.js";
import { makeTicket, makeIssue, makePhase, makeRoadmap, makeState } from "../../core/test-factories.js";

/** Multiset helper matching production code in ticket.ts/issue.ts */
function buildErrorMultiset(findings: readonly { level: string; code: string; entity: string | null; message: string }[]): { counts: Map<string, number>; messages: Map<string, string> } {
  const counts = new Map<string, number>();
  const messages = new Map<string, string>();
  for (const f of findings) {
    if (f.level !== "error") continue;
    const key = `${f.code}|${f.entity ?? ""}|${f.message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    messages.set(key, f.message);
  }
  return { counts, messages };
}

/** Compute new errors introduced by a state change */
function newErrors(pre: ProjectState, post: ProjectState): string[] {
  const { counts: preErrors } = buildErrorMultiset(validateProject(pre).findings);
  const { counts: postErrors, messages: postMessages } = buildErrorMultiset(validateProject(post).findings);
  const result: string[] = [];
  for (const [key, postCount] of postErrors) {
    const preCount = preErrors.get(key) ?? 0;
    if (postCount > preCount) result.push(postMessages.get(key) ?? key);
  }
  return result;
}

describe("ISS-065: Write-path multiset diff", () => {
  const phase = makePhase({ id: "p1" });
  const roadmap = makeRoadmap([phase]);

  it("pre-existing stale issue ref does NOT produce new error when writing unrelated ticket", () => {
    // Pre-state: ISS-001 has stale relatedTickets ref to T-999 (doesn't exist)
    const pre = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-999"] })],
      roadmap,
    });

    // Post-state: T-001 changed to inprogress (unrelated to ISS-001's stale ref)
    const post = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "inprogress" })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-999"] })],
      roadmap,
    });

    expect(newErrors(pre, post)).toHaveLength(0);
  });

  it("adding NEW stale blockedBy produces new error", () => {
    const pre = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", blockedBy: [] })],
      roadmap,
    });

    const post = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", blockedBy: ["T-888"] })],
      roadmap,
    });

    const errors = newErrors(pre, post);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("T-888"))).toBe(true);
  });

  it("duplicate stale ref increases multiset count", () => {
    // Pre: T-001 has one stale blockedBy
    const pre = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", blockedBy: ["T-999"] })],
      roadmap,
    });

    // Post: T-001 has two identical stale blockedBy
    const post = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", blockedBy: ["T-999", "T-999"] })],
      roadmap,
    });

    const errors = newErrors(pre, post);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("cross-entity blocked_by_umbrella produces new error", () => {
    // Pre: T-001 is a regular ticket, T-002 blocks on T-001
    const pre = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }),
        makeTicket({ id: "T-002", phase: "p1", blockedBy: ["T-001"] }),
      ],
      roadmap,
    });

    // Post: T-003 has parentTicket: T-001, making T-001 an umbrella.
    // T-002's blockedBy: [T-001] now triggers blocked_by_umbrella
    const post = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }),
        makeTicket({ id: "T-002", phase: "p1", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", phase: "p1", parentTicket: "T-001" }),
      ],
      roadmap,
    });

    const errors = newErrors(pre, post);
    expect(errors.some((e) => e.includes("umbrella"))).toBe(true);
  });

  it("same errors pre/post means empty diff", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", blockedBy: ["T-999"] })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-888"] })],
      roadmap,
    });

    // Same state before and after (no change)
    expect(newErrors(state, state)).toHaveLength(0);
  });

  it("pre-existing stale issue phase does not block ticket write", () => {
    const pre = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      issues: [makeIssue({ id: "ISS-001", phase: "nonexistent" })],
      roadmap,
    });

    const post = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
      issues: [makeIssue({ id: "ISS-001", phase: "nonexistent" })],
      roadmap,
    });

    expect(newErrors(pre, post)).toHaveLength(0);
  });
});
