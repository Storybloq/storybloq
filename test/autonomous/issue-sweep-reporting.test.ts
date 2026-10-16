/**
 * T-486 U4-2: what the issue sweep reports. The completion event and the
 * handover carry the disposed, deferred and conflicted issues with their
 * reasons (R13); `owner_gated` reads "owner decision requested", never
 * "accepted" (R14); and the instruction names the three exits, the premise
 * check and what `owner_gated` means (T20).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
  gitUserEmail: vi.fn().mockResolvedValue("me@example.com"),
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { writeSessionSync } from "../../src/autonomous/session.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";
import { setupProject, writeIssue, readState, eventsOfType, plant, report } from "./_issue-sweep-harness.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t486-u42-report-"));
  setupProject(root);
});
afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

/** A finished sweep with one issue in every list. */
const FINISHED = {
  remaining: [] as string[], current: null, resolved: ["ISS-001"],
  disposed: [{ id: "ISS-002", kind: "wontfix" }],
  deferred: [{ id: "ISS-003", disposition: "owner_gated", reason: "Owner decides pricing.", ref: "T-001" }],
  conflicted: [{ id: "ISS-004", reason: "unresolved merge conflicts" }],
};

const SECTIONS = [
  "Deferred by the issue sweep:",
  "- ISS-003: owner decision requested (Owner decides pricing.; evidence T-001)",
  "",
  "Disposed:",
  "- ISS-002: wontfix",
  "",
  "Left by the issue sweep, not finished:",
  "- ISS-004: unresolved merge conflicts",
].join("\n");

describe("issue sweep reporting (T-486 U4-2)", () => {
  it("T17, T19 (R13, R14): issue_sweep_complete carries every list with its reasons, and owner_gated reads as requested", async () => {
    const { sessionId, dir } = plant(root, FINISHED);

    await report(root, sessionId);

    const events = eventsOfType(dir, "issue_sweep_complete");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({
      resolved: 1,
      disposed: [{ id: "ISS-002", kind: "wontfix" }],
      deferred: [{ id: "ISS-003", disposition: "owner decision requested", reason: "Owner decides pricing.", ref: "T-001" }],
      conflicted: [{ id: "ISS-004", reason: "unresolved merge conflicts" }],
    });
    expect(JSON.stringify(events[0]!.data)).not.toMatch(/accepted/);
  });

  it("T18, T19 (R13, R14): the handover and the session summary list deferred, disposed and conflicted issues with reasons", async () => {
    const { sessionId, dir } = plant(root, FINISHED);
    writeSessionSync(dir, { ...readState(dir), state: "HANDOVER", previousState: "ISSUE_SWEEP" });

    const r = await handleAutonomousGuide(root, {
      action: "report", sessionId,
      report: { completedAction: "handover_written", handoverContent: "# Handover\n\nWork done.\n" },
    });
    expect(r.isError).toBeFalsy();
    const summary = (r.content ?? []).map((c) => ("text" in c ? String(c.text) : "")).join("\n");

    const files = readdirSync(join(root, ".story", "handovers")).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    const body = readFileSync(join(root, ".story", "handovers", files[0]!), "utf-8");
    expect(body).toContain(SECTIONS);
    expect(body).not.toMatch(/accepted/);
    expect(summary).toContain(SECTIONS);
    expect(summary).not.toMatch(/accepted/);
  });

  it("T20: the instruction names the three exits, the premise check and what owner_gated means, verbatim", async () => {
    const { sessionId } = plant(root, { remaining: ["ISS-001"], current: null, resolved: [] });
    writeIssue(root, "ISS-001");

    const r = await report(root, sessionId);

    expect(r.text).toContain("Fix **ISS-001**");
    expect(r.text).toContain("Fix it and set it resolved; or resolve it with a kind (`wontfix`, `superseded`, `not_reproducible`, or `duplicate` with `duplicateOf`) and a reason; or set a non-actionable disposition with a reason and an evidence reference.");
    expect(r.text).toContain("Verify the issue's premise against the code before acting on it.");
    expect(r.text).toContain("`owner_gated` requests an owner decision; it does not record one.");
  });
});
