/**
 * T-257 verification-log tests.
 *
 * Tests for appendRejection (JSONL I/O) and buildRejectionEntry
 * (entry construction from LensFinding + VerifyFail).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  appendRejection,
  buildRejectionEntry,
  type RejectionEntry,
} from "../../../src/autonomous/review-lenses/verification-log.js";
import { normalizeForVerification } from "../../../src/autonomous/review-lenses/verification.js";
import type { LensFinding } from "../../../src/autonomous/review-lenses/types.js";
import type { VerifyFail } from "../../../src/autonomous/review-lenses/verification.js";

// ── Fixtures ──────────────────────────────────────────────────────

function makeFinding(overrides?: Partial<LensFinding>): LensFinding {
  return {
    lens: "security",
    lensVersion: "security-v2",
    severity: "major",
    recommendedImpact: "needs-revision",
    category: "injection",
    description: "SQL injection via string concatenation",
    file: "src/db.ts",
    line: 42,
    evidence: [
      { file: "src/db.ts", startLine: 40, endLine: 45, code: "const q = `SELECT * FROM ${table}`;" },
      { file: "src/db.ts", startLine: 50, endLine: 55, code: "db.query(q);" },
    ],
    suggestedFix: "Use parameterized queries",
    confidence: 0.95,
    assumptions: null,
    requiresMoreContext: false,
    issueKey: "SEC-db-ts-42",
    ...overrides,
  };
}

function makeVerifyFail(overrides?: Partial<VerifyFail>): VerifyFail {
  return {
    pass: false as const,
    reasonCode: "quote_mismatch",
    failedEvidenceIndex: 0,
    details: { file: "src/db.ts", startLine: 40, endLine: 45, message: "Normalized quote does not match snapshot" },
    actualExcerpt: "const q = `SELECT * FROM users`;",
    actualHash: createHash("sha256").update("const q = `SELECT * FROM users`;").digest("hex"),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "t257-vlog-"));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("appendRejection", () => {
  it("creates JSONL file on first call", () => {
    const entry: RejectionEntry = {
      findingId: "SEC-db-ts-42",
      lens: "security",
      stage: "code-review",
      reasonCode: "quote_mismatch",
      failedEvidenceIndex: 0,
      claimed: { file: "src/db.ts", startLine: 40, endLine: 45, codeHash: "abc123" },
      actualExcerpt: "actual code here",
      actualHash: "def456",
    };

    const result = appendRejection(sessionDir, entry);
    expect(result.ok).toBe(true);

    const logPath = join(sessionDir, "verification.log");
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.findingId).toBe("SEC-db-ts-42");
  });

  it("appends to existing file (multiple entries)", () => {
    const entry1: RejectionEntry = {
      findingId: "finding-1",
      lens: "security",
      stage: "code-review",
      reasonCode: "quote_mismatch",
      failedEvidenceIndex: 0,
      claimed: { file: "a.ts", startLine: 1, endLine: 2, codeHash: "h1" },
      actualExcerpt: "x",
      actualHash: "y",
    };
    const entry2: RejectionEntry = {
      findingId: "finding-2",
      lens: "clean-code",
      stage: "plan-review",
      reasonCode: "line_out_of_range",
      failedEvidenceIndex: 1,
      claimed: { file: "b.ts", startLine: 10, endLine: 20, codeHash: "h2" },
      actualExcerpt: "z",
      actualHash: "w",
    };

    appendRejection(sessionDir, entry1);
    appendRejection(sessionDir, entry2);

    const lines = readFileSync(join(sessionDir, "verification.log"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).findingId).toBe("finding-1");
    expect(JSON.parse(lines[1]).findingId).toBe("finding-2");
  });

  it("entries parse as valid JSON per line", () => {
    const entry: RejectionEntry = {
      findingId: "test",
      lens: "security",
      stage: "code-review",
      reasonCode: "invalid_path",
      failedEvidenceIndex: 0,
      claimed: null,
      actualExcerpt: "",
      actualHash: "",
    };

    appendRejection(sessionDir, entry);
    appendRejection(sessionDir, entry);

    const raw = readFileSync(join(sessionDir, "verification.log"), "utf-8");
    const lines = raw.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("returns { ok: false } on write failure", () => {
    const readOnlyDir = join(sessionDir, "readonly");
    mkdirSync(readOnlyDir);
    chmodSync(readOnlyDir, 0o444);

    const entry: RejectionEntry = {
      findingId: "test",
      lens: "security",
      stage: "code-review",
      reasonCode: "quote_mismatch",
      failedEvidenceIndex: 0,
      claimed: null,
      actualExcerpt: "",
      actualHash: "",
    };

    const result = appendRejection(readOnlyDir, entry);
    expect(result.ok).toBe(false);

    // Restore permissions for cleanup
    chmodSync(readOnlyDir, 0o755);
  });
});

describe("buildRejectionEntry", () => {
  it("builds entry with correct claimed evidence from finding", () => {
    const finding = makeFinding();
    const result = makeVerifyFail({ failedEvidenceIndex: 0 });

    const entry = buildRejectionEntry(finding, result, "code-review");

    expect(entry.findingId).toBe("SEC-db-ts-42");
    expect(entry.lens).toBe("security");
    expect(entry.stage).toBe("code-review");
    expect(entry.reasonCode).toBe("quote_mismatch");
    expect(entry.failedEvidenceIndex).toBe(0);
    expect(entry.claimed).not.toBeNull();
    expect(entry.claimed!.file).toBe("src/db.ts");
    expect(entry.claimed!.startLine).toBe(40);
    expect(entry.claimed!.endLine).toBe(45);
  });

  it("codeHash is sha256 of normalized evidence code", () => {
    const finding = makeFinding();
    const result = makeVerifyFail({ failedEvidenceIndex: 0 });

    const entry = buildRejectionEntry(finding, result, "code-review");

    const expectedCode = finding.evidence[0].code;
    const expectedHash = createHash("sha256")
      .update(normalizeForVerification(expectedCode))
      .digest("hex");
    expect(entry.claimed!.codeHash).toBe(expectedHash);
  });

  it("actualExcerpt capped at 500 characters", () => {
    const longExcerpt = "x".repeat(1000);
    const finding = makeFinding();
    const result = makeVerifyFail({ actualExcerpt: longExcerpt });

    const entry = buildRejectionEntry(finding, result, "code-review");

    expect(entry.actualExcerpt.length).toBeLessThanOrEqual(500);
  });

  it("no_evidence produces null claimed and empty actualExcerpt/actualHash", () => {
    const finding = makeFinding({ evidence: [{ file: "src/db.ts", startLine: 1, endLine: 1, code: "x" }] });
    const result = makeVerifyFail({
      reasonCode: "no_evidence",
      failedEvidenceIndex: -1,
      actualExcerpt: undefined,
      actualHash: undefined,
    });

    const entry = buildRejectionEntry(finding, result, "code-review");

    expect(entry.claimed).toBeNull();
    expect(entry.actualExcerpt).toBe("");
    expect(entry.actualHash).toBe("");
  });

  it("failedEvidenceIndex > 0 logs correct evidence item", () => {
    const finding = makeFinding();
    const result = makeVerifyFail({ failedEvidenceIndex: 1 });

    const entry = buildRejectionEntry(finding, result, "code-review");

    expect(entry.failedEvidenceIndex).toBe(1);
    expect(entry.claimed).not.toBeNull();
    expect(entry.claimed!.file).toBe("src/db.ts");
    expect(entry.claimed!.startLine).toBe(50);
    expect(entry.claimed!.endLine).toBe(55);
  });

  it("handles missing issueKey gracefully", () => {
    const finding = makeFinding({ issueKey: undefined });
    const result = makeVerifyFail();

    const entry = buildRejectionEntry(finding, result, "code-review");

    expect(entry.findingId).toMatch(/^security-f-unknown$/);
  });

  it("actualHash from VerifyFail is passed through", () => {
    const finding = makeFinding();
    const hash = createHash("sha256").update("test").digest("hex");
    const result = makeVerifyFail({ actualHash: hash });

    const entry = buildRejectionEntry(finding, result, "code-review");

    expect(entry.actualHash).toBe(hash);
  });
});
