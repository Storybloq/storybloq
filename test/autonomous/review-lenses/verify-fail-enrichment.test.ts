/**
 * T-257 VerifyFail enrichment tests.
 *
 * Tests that VerifyFail results include actualExcerpt and actualHash
 * for content-level failures (quote_mismatch, line_out_of_range),
 * and omit them for path-level failures (invalid_path, file_not_snapshotted).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  writeReviewSnapshot,
  verifyLensFinding,
  normalizeForVerification,
  type SnapshotContext,
  type VerifyFail,
} from "../../../src/autonomous/review-lenses/index.js";
import type { LensFinding } from "../../../src/autonomous/review-lenses/types.js";

// ── Helpers ───────────────────────────────────────────────────────

let tmpDir: string;
let projectRoot: string;
let sessionId: string;
let reviewId: string;

function makeSnapshotDir(): string {
  const snapshotDir = join(
    projectRoot,
    ".story",
    "sessions",
    sessionId,
    "snapshots",
    reviewId,
  );
  mkdirSync(snapshotDir, { recursive: true });
  return snapshotDir;
}

function writeFinding(
  file: string,
  startLine: number,
  endLine: number,
  code: string,
): LensFinding {
  return {
    lens: "security",
    lensVersion: "security-v2",
    severity: "major",
    recommendedImpact: "needs-revision",
    category: "test",
    description: "Test finding",
    file,
    line: startLine,
    evidence: [{ file, startLine, endLine, code }],
    suggestedFix: null,
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
  };
}

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "t257-enrich-"));
  projectRoot = join(tmpDir, "project");
  sessionId = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";
  reviewId = "code-review-r1";
  mkdirSync(join(projectRoot, ".story", "sessions", sessionId), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("VerifyFail enrichment (T-257)", () => {
  it("quote_mismatch VerifyFail includes actualExcerpt and actualHash", () => {
    // Create a source file and snapshot it
    const srcFile = join(projectRoot, "src", "target.ts");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    const actualCode = "function hello() { return 'world'; }";
    writeFileSync(srcFile, `line1\nline2\n${actualCode}\nline4\n`);

    // Write a snapshot with the actual file content
    writeReviewSnapshot({
      projectRoot,
      sessionId,
      reviewId,
      stage: "code-review",
      round: 1,
      files: ["src/target.ts"],
    });

    const ctx: SnapshotContext = { projectRoot, sessionId, reviewId };

    // Create a finding with mismatched code
    const finding = writeFinding(
      "src/target.ts",
      3,
      3,
      "function hello() { return 'WRONG'; }",
    );

    const result = verifyLensFinding(finding, ctx);

    if (!result.pass) {
      const fail = result as VerifyFail;
      expect(fail.reasonCode).toBe("quote_mismatch");
      // T-257: enrichment fields
      expect(fail).toHaveProperty("actualExcerpt");
      expect(fail).toHaveProperty("actualHash");
      expect(typeof fail.actualExcerpt).toBe("string");
      expect(typeof fail.actualHash).toBe("string");
      expect(fail.actualExcerpt!.length).toBeGreaterThan(0);
      expect(fail.actualHash!.length).toBe(64); // sha256 hex length
    } else {
      // If it passed, the test setup is wrong -- force failure
      expect(result.pass).toBe(false);
    }
  });

  it("line_out_of_range VerifyFail includes actualExcerpt", () => {
    const srcFile = join(projectRoot, "src", "short.ts");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(srcFile, "line1\nline2\nline3\n");

    writeReviewSnapshot({
      projectRoot,
      sessionId,
      reviewId,
      stage: "code-review",
      round: 1,
      files: ["src/short.ts"],
    });

    const ctx: SnapshotContext = { projectRoot, sessionId, reviewId };

    // Claim lines far beyond the file length
    const finding = writeFinding("src/short.ts", 100, 110, "phantom code");

    const result = verifyLensFinding(finding, ctx);

    if (!result.pass) {
      const fail = result as VerifyFail;
      expect(fail.reasonCode).toBe("line_out_of_range");
      // T-257: should have actualExcerpt even for out-of-range
      expect(fail).toHaveProperty("actualExcerpt");
      expect(typeof fail.actualExcerpt).toBe("string");
    } else {
      expect(result.pass).toBe(false);
    }
  });

  it("path-level VerifyFail (invalid_path) has no actualExcerpt/actualHash", () => {
    const srcFile = join(projectRoot, "src", "exists.ts");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(srcFile, "content\n");

    writeReviewSnapshot({
      projectRoot,
      sessionId,
      reviewId,
      stage: "code-review",
      round: 1,
      files: ["src/exists.ts"],
    });

    const ctx: SnapshotContext = { projectRoot, sessionId, reviewId };

    // Claim evidence from a path that traverses upward (invalid)
    const finding = writeFinding("../../../etc/passwd", 1, 1, "root:x:0:0");

    const result = verifyLensFinding(finding, ctx);

    if (!result.pass) {
      const fail = result as VerifyFail;
      expect(fail.reasonCode).toBe("invalid_path");
      // T-257: path-level failures should NOT have enrichment fields
      expect(fail.actualExcerpt).toBeUndefined();
      expect(fail.actualHash).toBeUndefined();
    } else {
      expect(result.pass).toBe(false);
    }
  });
});
