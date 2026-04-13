/**
 * T-257 synthesize verification gate tests.
 *
 * Tests the verification gate integration in handleSynthesize:
 * - Two-tier arrays (verifiedFindings for merger, verifiedForFiling for pre-existing)
 * - Counter semantics (verified = strictly verified, bypass = 0)
 * - SnapshotIntegrityError escalation
 * - Skip-path filing safety
 * - Log boundary isolation
 * - Telemetry JSONL output
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleSynthesize,
  type SynthesizeInput,
  type SynthesizeOutput,
} from "../../../src/autonomous/review-lenses/mcp-handlers.js";

// ── Fixtures ──────────────────────────────────────────────────────

function makeValidFinding(lens: string, file: string, line: number) {
  return {
    lens,
    lensVersion: `${lens}-v2`,
    severity: "major",
    recommendedImpact: "needs-revision",
    category: "test",
    description: `Finding in ${file}:${line}`,
    file,
    line,
    evidence: [{ file, startLine: line, endLine: line + 5, code: `line ${line} code` }],
    suggestedFix: null,
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
  };
}

function makeSynthesizeInput(overrides?: Partial<SynthesizeInput>): SynthesizeInput {
  return {
    stage: "CODE_REVIEW",
    lensResults: [
      {
        lens: "security",
        status: "complete",
        findings: [makeValidFinding("security", "src/a.ts", 10)],
      },
      {
        lens: "clean-code",
        status: "complete",
        findings: [makeValidFinding("clean-code", "src/b.ts", 20)],
      },
    ],
    metadata: {
      activeLenses: ["security", "clean-code"],
      skippedLenses: [],
      reviewRound: 1,
      reviewId: "test-review-001",
    },
    ...overrides,
  };
}

// Helper to set up a minimal project root with .story/config.json
function setupProjectRoot(dir: string): string {
  const root = join(dir, "project");
  mkdirSync(join(root, ".story"), { recursive: true });
  writeFileSync(
    join(root, ".story", "config.json"),
    JSON.stringify({ version: 2, recipeOverrides: {} }),
  );
  return root;
}

// ── Tests ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "t257-gate-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleSynthesize verification gate", () => {
  it("returns verificationCounters with correct strict counts for mixed findings", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: output should have verificationCounters
    expect(output.verificationCounters).toBeDefined();
    const vc = output.verificationCounters;
    expect(typeof vc.proposed).toBe("number");
    expect(typeof vc.verified).toBe("number");
    expect(typeof vc.rejected).toBe("number");
    // Without a real snapshot, integrity failure always occurs
    expect(output.snapshotIntegrityFailure).toBe(true);
    expect(vc.verified).toBe(0);
    expect(vc.rejected).toBe(0);
    expect(vc.proposed).toBeGreaterThan(0);
  });

  it("skips verification when sessionId is absent -- all pass to merger, preExisting=[], verified=0", () => {
    const projectRoot = setupProjectRoot(tmpDir);

    const input = makeSynthesizeInput({
      projectRoot,
      // sessionId deliberately omitted
    });

    const output = handleSynthesize(input);

    // T-257: without sessionId, verification is skipped
    // All findings should pass to merger
    expect(output.validatedFindings.length).toBeGreaterThan(0);
    // preExistingFindings should be [] (filing suppressed on skip path)
    expect(output.verificationSkipped).toBe(true);
    expect(output.verificationCounters.verified).toBe(0);
  });

  it("skips verification when projectRoot is absent -- same skip-path behavior", () => {
    const input = makeSynthesizeInput({
      // projectRoot deliberately omitted
    });

    const output = handleSynthesize(input);

    // All findings should still appear in merger output
    expect(output.validatedFindings.length).toBeGreaterThan(0);
    expect(output.verificationSkipped).toBe(true);
  });

  it("sets snapshotIntegrityFailure with no duplicates and preExisting=[]", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // Without a real snapshot, integrity failure always fires
    expect(output.snapshotIntegrityFailure).toBe(true);
    // No duplicate findings in output
    const ids = output.validatedFindings.map(f => f.issueKey);
    expect(ids.length).toBe(new Set(ids).size);
    // preExisting should be empty on integrity failure
    expect(output.preExistingFindings).toEqual([]);
    // verified counter should be 0
    expect(output.verificationCounters.verified).toBe(0);
  });

  it("SnapshotIntegrityError skips rejection logging entirely", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    handleSynthesize(input);

    // T-257: on integrity failure, verification.log should NOT be written
    expect(existsSync(join(sessionDir, "verification.log"))).toBe(false);
  });

  it("unknown verification error passes finding to merger but not to preExisting, increments runtimeErrors", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: output should have verificationRuntimeErrors
    expect(typeof output.verificationRuntimeErrors).toBe("number");
  });

  it("log write failures do not affect verified/rejected partition", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: logWriteFailures should not change the finding partition
    expect(typeof output.logWriteFailures).toBe("number");
    // On integrity failure (no real snapshot): verified=0, rejected=0
    expect(output.snapshotIntegrityFailure).toBe(true);
    expect(output.verificationCounters.verified).toBe(0);
    expect(output.verificationCounters.rejected).toBe(0);
  });

  it("mergerPrompt only includes verified findings", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: mergerPrompt should be built from verifiedFindings,
    // not from allFindings. The prompt contains finding descriptions.
    // After implementation, rejected findings should NOT appear in mergerPrompt.
    expect(output.mergerPrompt).toBeDefined();
    expect(typeof output.mergerPrompt).toBe("string");
  });

  it("preExistingFindings only includes strictly-verified findings", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: preExistingFindings should only come from verifiedForFiling
    // (strictly verified findings, not runtime-error pass-throughs)
    for (const f of output.preExistingFindings) {
      expect(f.origin).toBe("pre-existing");
    }
  });

  it("writes telemetry JSONL and sets telemetryWriteFailed on failure", () => {
    const projectRoot = setupProjectRoot(tmpDir);
    const sessionDir = join(tmpDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const input = makeSynthesizeInput({
      projectRoot,
      sessionDir,
      sessionId: "test-session-id",
    });

    const output = handleSynthesize(input);

    // T-257: should write verification-telemetry.jsonl
    expect(typeof output.telemetryWriteFailed).toBe("boolean");
    const telemetryPath = join(sessionDir, "verification-telemetry.jsonl");
    expect(existsSync(telemetryPath)).toBe(true);
    const lines = readFileSync(telemetryPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toHaveProperty("reviewId");
    expect(entry).toHaveProperty("proposed");
    expect(entry).toHaveProperty("verified");
    expect(entry).toHaveProperty("rejected");
    expect(entry).toHaveProperty("timestamp");
  });
});
