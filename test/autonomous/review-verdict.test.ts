import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  verdictFilename,
  writeReviewVerdict,
  readReviewVerdict,
  buildTier1Verdict,
  computeContentHash,
  type ReviewVerdictArtifact,
} from "../../src/autonomous/review-verdict.js";

function makeArtifact(overrides?: Partial<ReviewVerdictArtifact>): ReviewVerdictArtifact {
  return {
    target: "T-250",
    stage: "code",
    round: 1,
    reviewer: "codex",
    verdict: "revise",
    findingsCount: 3,
    severityCounts: { critical: 1, major: 1, minor: 0, suggestion: 1 },
    startedAt: "2026-04-11T11:59:55.000Z",
    durationMs: 5000,
    summary: "Found 1 critical issue in error handling",
    findings: [
      { id: "f1", severity: "critical", category: "error-handling", description: "Missing error boundary", disposition: "open" },
      { id: "f2", severity: "major", category: "security", description: "Unsanitized input", disposition: "open" },
      { id: "f3", severity: "suggestion", category: "style", description: "Consider extracting helper", disposition: "open" },
    ],
    timestamp: "2026-04-11T12:00:00.000Z",
    ...overrides,
  };
}

describe("ReviewVerdict (T-263)", () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "review-verdict-test-"));
    sessionDir = join(tmpDir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* cleanup */ }
  });

  // ── verdictFilename ────────────────────────────────────────

  describe("verdictFilename", () => {
    it("produces correct format for ticket target", () => {
      expect(verdictFilename("T-250", "code", 1)).toBe("T-250-code-r1.json");
    });

    it("produces correct format for issue target", () => {
      expect(verdictFilename("ISS-378", "plan", 2)).toBe("ISS-378-plan-r2.json");
    });

    it("lowercases stage name", () => {
      expect(verdictFilename("T-100", "CODE", 3)).toBe("T-100-code-r3.json");
    });

    it("sanitizes slash in target", () => {
      expect(verdictFilename("T/250", "code", 1)).toBe("T-250-code-r1.json");
    });
  });

  // ── computeContentHash ─────────────────────────────────────

  describe("computeContentHash", () => {
    it("produces a hex string", () => {
      const hash = computeContentHash(makeArtifact());
      expect(typeof hash).toBe("string");
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it("same artifact produces same hash", () => {
      const artifact = makeArtifact();
      const h1 = computeContentHash(artifact);
      const h2 = computeContentHash(artifact);
      expect(h1).toBe(h2);
    });

    it("different verdict produces different hash", () => {
      const h1 = computeContentHash(makeArtifact({ verdict: "approve" }));
      const h2 = computeContentHash(makeArtifact({ verdict: "revise" }));
      expect(h1).not.toBe(h2);
    });

    it("excludes timestamp from hash", () => {
      const h1 = computeContentHash(makeArtifact({ timestamp: "2026-01-01T00:00:00Z" }));
      const h2 = computeContentHash(makeArtifact({ timestamp: "2026-12-31T23:59:59Z" }));
      expect(h1).toBe(h2);
    });

    it("excludes durationMs from hash (retry-safe)", () => {
      const h1 = computeContentHash(makeArtifact({ durationMs: 5000 }));
      const h2 = computeContentHash(makeArtifact({ durationMs: 99000 }));
      expect(h1).toBe(h2);
    });

    it("includes startedAt in hash", () => {
      const h1 = computeContentHash(makeArtifact({ startedAt: "2026-04-11T11:00:00Z" }));
      const h2 = computeContentHash(makeArtifact({ startedAt: "2026-04-11T12:00:00Z" }));
      expect(h1).not.toBe(h2);
    });

    it("key ordering does not affect hash (canonical serialization)", () => {
      const a1 = makeArtifact();
      const a2 = {
        verdict: a1.verdict,
        target: a1.target,
        round: a1.round,
        stage: a1.stage,
        reviewer: a1.reviewer,
        findingsCount: a1.findingsCount,
        severityCounts: a1.severityCounts,
        startedAt: a1.startedAt,
        durationMs: a1.durationMs,
        summary: a1.summary,
        findings: a1.findings,
        timestamp: a1.timestamp,
      } as ReviewVerdictArtifact;
      expect(computeContentHash(a1)).toBe(computeContentHash(a2));
    });
  });

  // ── writeReviewVerdict ─────────────────────────────────────

  describe("writeReviewVerdict", () => {
    it("creates telemetry/reviews/ directory", () => {
      const reviewsDir = join(sessionDir, "telemetry", "reviews");
      expect(existsSync(reviewsDir)).toBe(false);
      writeReviewVerdict(sessionDir, makeArtifact());
      expect(existsSync(reviewsDir)).toBe(true);
    });

    it("writes file with correct content", () => {
      const artifact = makeArtifact();
      writeReviewVerdict(sessionDir, artifact);
      const filePath = join(sessionDir, "telemetry", "reviews", "T-250-code-r1.json");
      expect(existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(parsed.target).toBe("T-250");
      expect(parsed.stage).toBe("code");
      expect(parsed.round).toBe(1);
      expect(parsed.reviewer).toBe("codex");
      expect(parsed.verdict).toBe("revise");
      expect(parsed.findingsCount).toBe(3);
      expect(parsed.severityCounts).toEqual({ critical: 1, major: 1, minor: 0, suggestion: 1 });
      expect(parsed.findings).toHaveLength(3);
      expect(typeof parsed._contentHash).toBe("string");
    });

    it("returns { status: 'written', contentHash } on success", () => {
      const result = writeReviewVerdict(sessionDir, makeArtifact());
      expect(result.status).toBe("written");
      expect(typeof (result as { contentHash: string }).contentHash).toBe("string");
    });

    it("returns { status: 'exists', contentHash } on immutability guard", () => {
      writeReviewVerdict(sessionDir, makeArtifact());
      const result = writeReviewVerdict(sessionDir, makeArtifact());
      expect(result.status).toBe("exists");
      expect(typeof (result as { contentHash: string }).contentHash).toBe("string");
    });

    it("does not overwrite existing file (immutability)", () => {
      const artifact = makeArtifact();
      writeReviewVerdict(sessionDir, artifact);
      const filePath = join(sessionDir, "telemetry", "reviews", "T-250-code-r1.json");
      const original = readFileSync(filePath, "utf-8");

      const modified = makeArtifact({ verdict: "approve", summary: "Changed" });
      writeReviewVerdict(sessionDir, modified);
      const afterSecondWrite = readFileSync(filePath, "utf-8");
      expect(afterSecondWrite).toBe(original);
    });

    it("returns { status: 'skipped' } on unwritable directory", () => {
      const result = writeReviewVerdict("/nonexistent/path/that/cannot/exist", makeArtifact());
      expect(result.status).toBe("skipped");
    });

    it("leaves no leftover tmp files after write", () => {
      writeReviewVerdict(sessionDir, makeArtifact());
      const reviewsDir = join(sessionDir, "telemetry", "reviews");
      const files = readdirSync(reviewsDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("leaves no leftover tmp files after failure", () => {
      const reviewsDir = join(sessionDir, "telemetry", "reviews");
      mkdirSync(reviewsDir, { recursive: true });
      const { chmodSync } = require("node:fs");
      try {
        chmodSync(reviewsDir, 0o444);
        writeReviewVerdict(sessionDir, makeArtifact());
      } finally {
        chmodSync(reviewsDir, 0o755);
      }
      const files = readdirSync(reviewsDir);
      const tmpFiles = files.filter((f: string) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  // ── readReviewVerdict ──────────────────────────────────────

  describe("readReviewVerdict", () => {
    it("reads valid artifact when content hash matches", () => {
      const artifact = makeArtifact();
      const result = writeReviewVerdict(sessionDir, artifact);
      const hash = (result as { contentHash: string }).contentHash;
      const read = readReviewVerdict(sessionDir, hash);
      expect(read).not.toBeNull();
      expect(read!.target).toBe("T-250");
      expect(read!.stage).toBe("code");
      expect(read!.round).toBe(1);
      expect(read!.verdict).toBe("revise");
    });

    it("returns null for missing file", () => {
      const result = readReviewVerdict(sessionDir, "nonexistent-hash");
      expect(result).toBeNull();
    });

    it("returns null for malformed JSON", () => {
      const reviewsDir = join(sessionDir, "telemetry", "reviews");
      mkdirSync(reviewsDir, { recursive: true });
      writeFileSync(join(reviewsDir, "T-250-code-r1.json"), "not-valid-json{{{");
      const result = readReviewVerdict(sessionDir, "some-hash");
      expect(result).toBeNull();
    });

    it("returns null when content hash does not match", () => {
      const artifact = makeArtifact();
      writeReviewVerdict(sessionDir, artifact);
      const result = readReviewVerdict(sessionDir, "wrong-hash-value");
      expect(result).toBeNull();
    });
  });

  // ── buildTier1Verdict ──────────────────────────────────────

  describe("buildTier1Verdict", () => {
    it("maps findingsCount to findingCount", () => {
      const tier1 = buildTier1Verdict(makeArtifact({ findingsCount: 7 }));
      expect(tier1.findingCount).toBe(7);
    });

    it("maps severity counts correctly", () => {
      const tier1 = buildTier1Verdict(makeArtifact({
        severityCounts: { critical: 2, major: 3, minor: 1, suggestion: 4 },
      }));
      expect(tier1.criticalCount).toBe(2);
      expect(tier1.majorCount).toBe(3);
      expect(tier1.suggestionCount).toBe(4);
    });

    it("does not include minorCount (lossy projection)", () => {
      const tier1 = buildTier1Verdict(makeArtifact({
        severityCounts: { critical: 0, major: 0, minor: 5, suggestion: 0 },
      }));
      expect(tier1).not.toHaveProperty("minorCount");
    });

    it("findingCount includes all severities including minor", () => {
      const tier1 = buildTier1Verdict(makeArtifact({
        findingsCount: 10,
        severityCounts: { critical: 2, major: 3, minor: 2, suggestion: 3 },
      }));
      expect(tier1.findingCount).toBe(10);
    });

    it("excludes findings array", () => {
      const tier1 = buildTier1Verdict(makeArtifact());
      expect(tier1).not.toHaveProperty("findings");
    });

    it("excludes target, reviewer, timestamp", () => {
      const tier1 = buildTier1Verdict(makeArtifact());
      expect(tier1).not.toHaveProperty("target");
      expect(tier1).not.toHaveProperty("reviewer");
      expect(tier1).not.toHaveProperty("timestamp");
    });

    it("includes stage, round, verdict, durationMs, summary", () => {
      const artifact = makeArtifact({ stage: "plan", round: 3, verdict: "approve", durationMs: 12000, summary: "All clear" });
      const tier1 = buildTier1Verdict(artifact);
      expect(tier1.stage).toBe("plan");
      expect(tier1.round).toBe(3);
      expect(tier1.verdict).toBe("approve");
      expect(tier1.durationMs).toBe(12000);
      expect(tier1.summary).toBe("All clear");
    });
  });

  // ── Multi-target collision ─────────────────────────────────

  describe("multi-target collision", () => {
    it("16 verdicts (4 targets x 2 stages x 2 rounds) produce distinct files", () => {
      const targets = ["T-100", "T-200", "ISS-010", "ISS-020"];
      const stages: Array<"plan" | "code"> = ["plan", "code"];
      const rounds = [1, 2];

      const filenames = new Set<string>();
      for (const target of targets) {
        for (const stage of stages) {
          for (const round of rounds) {
            const artifact = makeArtifact({ target, stage, round });
            const result = writeReviewVerdict(sessionDir, artifact);
            expect(result.status).toBe("written");
            filenames.add(verdictFilename(target, stage, round));
          }
        }
      }

      expect(filenames.size).toBe(16);

      const reviewsDir = join(sessionDir, "telemetry", "reviews");
      const files = readdirSync(reviewsDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(16);
    });
  });

  // ── Tier 1 shape ───────────────────────────────────────────

  describe("Tier 1 shape", () => {
    it("matches SessionState lastReviewVerdict type shape exactly", () => {
      const tier1 = buildTier1Verdict(makeArtifact());
      const expectedKeys = ["stage", "round", "verdict", "findingCount", "criticalCount", "majorCount", "suggestionCount", "durationMs", "summary"];
      const actualKeys = Object.keys(tier1).sort();
      expect(actualKeys).toEqual(expectedKeys.sort());
    });

    it("findings key is NOT present in Tier 1", () => {
      const tier1 = buildTier1Verdict(makeArtifact());
      expect("findings" in tier1).toBe(false);
    });
  });

  // ── Crash recovery ─────────────────────────────────────────

  describe("crash recovery", () => {
    it("exists + matching hash allows Tier 1 recovery", () => {
      const artifact = makeArtifact();
      const firstResult = writeReviewVerdict(sessionDir, artifact);
      expect(firstResult.status).toBe("written");
      const { contentHash } = firstResult as { contentHash: string };

      // Simulate crash: state NOT updated, retry same round
      const secondResult = writeReviewVerdict(sessionDir, artifact);
      expect(secondResult.status).toBe("exists");

      // Read and validate with contentHash
      const recovered = readReviewVerdict(sessionDir, contentHash);
      expect(recovered).not.toBeNull();
      expect(recovered!.target).toBe("T-250");
      expect(recovered!.verdict).toBe("revise");

      // Can build Tier 1 from recovered artifact
      const tier1 = buildTier1Verdict(recovered!);
      expect(tier1.findingCount).toBe(3);
      expect(tier1.verdict).toBe("revise");
    });

    it("exists + mismatched stored hash rejects recovery", () => {
      const artifact = makeArtifact();
      writeReviewVerdict(sessionDir, artifact);

      const filePath = join(sessionDir, "telemetry", "reviews", "T-250-code-r1.json");
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      parsed._contentHash = "tampered-hash";
      writeFileSync(filePath, JSON.stringify(parsed));

      const originalHash = computeContentHash(artifact);
      const result = readReviewVerdict(sessionDir, originalHash);
      expect(result).toBeNull();
    });

    it("content tampered but _contentHash kept rejects recovery", () => {
      const artifact = makeArtifact();
      const writeResult = writeReviewVerdict(sessionDir, artifact);
      const hash = (writeResult as { contentHash: string }).contentHash;

      const filePath = join(sessionDir, "telemetry", "reviews", "T-250-code-r1.json");
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      parsed.verdict = "approve";
      writeFileSync(filePath, JSON.stringify(parsed));

      const result = readReviewVerdict(sessionDir, hash);
      expect(result).toBeNull();
    });

    it("different durationMs on retry still recovers (hash excludes durationMs)", () => {
      const artifact = makeArtifact({ durationMs: 5000 });
      const r1 = writeReviewVerdict(sessionDir, artifact);
      expect(r1.status).toBe("written");

      const retryArtifact = makeArtifact({ durationMs: 99000 });
      const r2 = writeReviewVerdict(sessionDir, retryArtifact);
      expect(r2.status).toBe("exists");
      const { contentHash } = r2 as { contentHash: string };

      const recovered = readReviewVerdict(sessionDir, contentHash);
      expect(recovered).not.toBeNull();
      expect(recovered!.verdict).toBe("revise");
    });
  });

  // ── Fail-closed on skipped ─────────────────────────────────

  describe("fail-closed", () => {
    it("skipped status indicates round should NOT be consumed", () => {
      const result = writeReviewVerdict("/nonexistent/path", makeArtifact());
      expect(result.status).toBe("skipped");
      // Callers must NOT record review round or update Tier 1 on "skipped"
    });
  });
});
