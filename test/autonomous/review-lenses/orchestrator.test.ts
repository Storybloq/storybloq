import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareLensReview } from "../../../src/autonomous/review-lenses/orchestrator.js";
import { handleSynthesize } from "../../../src/autonomous/review-lenses/mcp-handlers.js";
import type { LensResult } from "../../../src/autonomous/review-lenses/types.js";
import { writeToCache, buildCacheKey } from "../../../src/autonomous/review-lenses/cache.js";
import { getLensVersion } from "../../../src/autonomous/review-lenses/lenses/index.js";

let projectRoot: string;
let sessionDir: string;

const DIFF = `--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,5 @@
+import { db } from "./db";
+
 export function handler(req) {
-  return "ok";
+  return db.query(req.params.id);
 }
`;

const CHANGED_FILES = ["src/api.ts"];
const TICKET_DESC = "Add database query to handler";

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    stage: "CODE_REVIEW" as const,
    diff: DIFF,
    changedFiles: CHANGED_FILES,
    ticketDescription: TICKET_DESC,
    projectRoot,
    sessionDir,
    ...overrides,
  };
}

function makeFinding(lens: string, overrides: Record<string, unknown> = {}) {
  return {
    lens,
    lensVersion: `${lens}-v1`,
    severity: "major" as const,
    recommendedImpact: "needs-revision" as const,
    category: "test-category",
    description: `Finding from ${lens}`,
    file: "src/api.ts",
    line: 4,
    evidence: [
      { file: "src/api.ts", startLine: 4, endLine: 4, code: "db.query(req.params.id)" },
    ],
    suggestedFix: "Use parameterized query",
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
    ...overrides,
  };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "orch-test-"));
  sessionDir = mkdtempSync(join(tmpdir(), "orch-session-"));
  // Create the source file so context-packager can read it
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "api.ts"), `import { db } from "./db";\n\nexport function handler(req) {\n  return db.query(req.params.id);\n}\n`);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("orchestrator integration", () => {
  it("prepareLensReview returns prompts for active lenses", () => {
    const prepared = prepareLensReview(makeOpts());
    // Core lenses should always activate for .ts files
    expect(prepared.activeLenses).toContain("clean-code");
    expect(prepared.activeLenses).toContain("security");
    expect(prepared.activeLenses).toContain("error-handling");
    // Should have prompts for non-cached lenses
    expect(prepared.subagentPrompts.size).toBeGreaterThan(0);
    expect(prepared.cachedFindings.size).toBe(0);
  });

  it("cache hit short-circuits prompt generation for that lens", async () => {
    const lens = "security";

    // Run 1: prepare + processResults to populate the cache
    const prep1 = prepareLensReview(makeOpts());
    expect(prep1.subagentPrompts.has(lens)).toBe(true);
    expect(prep1.cachedFindings.size).toBe(0);

    const results = new Map<string, LensResult | null>();
    for (const l of prep1.activeLenses) {
      if (l === lens) {
        results.set(l, { status: "complete", findings: [makeFinding(l)] });
      } else {
        results.set(l, { status: "complete", findings: [] });
      }
    }
    await prep1.processResults(results);

    // Run 2: same inputs -- security lens should be a cache hit
    const prep2 = prepareLensReview(makeOpts());
    expect(prep2.cachedFindings.has(lens)).toBe(true);
    expect(prep2.cachedFindings.get(lens)!.length).toBe(1);
    expect(prep2.cachedFindings.get(lens)![0].description).toBe(`Finding from ${lens}`);
    // Cache-hit lens should NOT generate a prompt
    expect(prep2.subagentPrompts.has(lens)).toBe(false);
    // All lenses were cached (all had results in processResults), so no prompts generated
    expect(prep2.subagentPrompts.size).toBe(0);
    // Total cached should equal all active lenses
    expect(prep2.cachedFindings.size).toBe(prep2.activeLenses.length);
  });

  it("processResults handles mixed complete/insufficient-context/null results", async () => {
    const prepared = prepareLensReview(makeOpts());
    const results = new Map<string, LensResult | null>();

    for (const lens of prepared.activeLenses) {
      if (lens === "security") {
        results.set(lens, { status: "complete", findings: [makeFinding(lens)] });
      } else if (lens === "error-handling") {
        results.set(lens, { status: "insufficient-context", findings: [], insufficientContextReason: "Not enough code" });
      } else if (lens === "clean-code") {
        results.set(lens, null); // failed lens
      } else {
        results.set(lens, { status: "complete", findings: [] });
      }
    }

    const output = await prepared.processResults(results);
    expect(output.mergerPrompt).toBeTruthy();
    expect(output.mergerModel).toBeTruthy();

    // Check review-progress.json was written
    const progressPath = join(sessionDir, "review-progress.json");
    const progress = JSON.parse(readFileSync(progressPath, "utf-8"));
    expect(progress.reviewId).toBeTruthy();
    expect(progress.stage).toBe("CODE_REVIEW");
    expect(progress.lensesCompleted).toContain("security");
    expect(progress.lensesInsufficientContext).toContain("error-handling");
    expect(progress.lensesFailed).toContain("clean-code");
    expect(progress.totalFindings).toBeGreaterThanOrEqual(1);
    expect(progress.lensDetails).toBeDefined();
    expect(Array.isArray(progress.lensDetails)).toBe(true);
    // Verdict should be null before judge runs
    expect(progress.verdict).toBeNull();
  });

  it("processResults applies confidence floor and finding budget", async () => {
    const prepared = prepareLensReview(makeOpts({
      config: { confidenceFloor: 0.8, findingBudget: 1 },
    }));
    const results = new Map<string, LensResult | null>();

    for (const lens of prepared.activeLenses) {
      if (lens === "security") {
        results.set(lens, {
          status: "complete",
          findings: [
            makeFinding(lens, { confidence: 0.95, description: "High conf" }),
            makeFinding(lens, { confidence: 0.5, description: "Low conf" }),
            makeFinding(lens, { confidence: 0.85, description: "Med conf" }),
          ],
        });
      } else {
        results.set(lens, { status: "complete", findings: [] });
      }
    }

    const output = await prepared.processResults(results);
    // Check progress to see how many findings survived
    const progress = JSON.parse(readFileSync(join(sessionDir, "review-progress.json"), "utf-8"));
    // Only findings above 0.8 confidence should survive (0.95 and 0.85),
    // but budget is 1, so only 1 finding per lens
    // Total should have at most 1 finding from security
    const securityDetails = progress.lensDetails.find((d: { lens: string }) => d.lens === "security");
    expect(securityDetails).toBeDefined();
    // The finding count in lensDetails reflects post-filter
    expect(securityDetails.findingCount).toBeLessThanOrEqual(1);
  });

  it("fallback verdict when merger parse fails", async () => {
    const prepared = prepareLensReview(makeOpts());
    const results = new Map<string, LensResult | null>();

    for (const lens of prepared.activeLenses) {
      results.set(lens, { status: "complete", findings: [makeFinding(lens)] });
    }

    const output = await prepared.processResults(results);
    // Feed unparseable merger result to trigger fallback
    const judgeInput = output.processMergerResult("This is not valid JSON at all");
    expect(judgeInput.judgePrompt).toBeTruthy();

    // Feed unparseable judge result to trigger buildFallbackResult
    const synthesis = judgeInput.processJudgeResult("Also not valid JSON");
    expect(synthesis.verdict).toBeDefined();
    expect(["approve", "revise", "reject"]).toContain(synthesis.verdict);
    expect(synthesis.verdictReason).toContain("Fallback");
    expect(synthesis.lensesCompleted.length).toBeGreaterThan(0);
    expect(synthesis.isPartial).toBe(false); // no core lenses failed
  });

  it("fallback verdict is partial when core lens fails", async () => {
    const prepared = prepareLensReview(makeOpts());
    const results = new Map<string, LensResult | null>();

    for (const lens of prepared.activeLenses) {
      if (lens === "security") {
        results.set(lens, null); // core lens failed
      } else {
        results.set(lens, { status: "complete", findings: [] });
      }
    }

    const output = await prepared.processResults(results);
    const judgeInput = output.processMergerResult("invalid");
    const synthesis = judgeInput.processJudgeResult("invalid");
    expect(synthesis.isPartial).toBe(true);
    expect(synthesis.lensesFailed).toContain("security");
  });

  it("review-progress.json has correct shape for Mac app", async () => {
    const prepared = prepareLensReview(makeOpts());
    const results = new Map<string, LensResult | null>();

    for (const lens of prepared.activeLenses) {
      results.set(lens, { status: "complete", findings: [] });
    }

    const output = await prepared.processResults(results);

    const progress = JSON.parse(readFileSync(join(sessionDir, "review-progress.json"), "utf-8"));
    // Required fields for Mac app decoding
    expect(typeof progress.reviewId).toBe("string");
    expect(typeof progress.stage).toBe("string");
    expect(typeof progress.activeLensCount).toBe("number");
    expect(Array.isArray(progress.lensesCompleted)).toBe(true);
    expect(Array.isArray(progress.lensesInsufficientContext)).toBe(true);
    expect(Array.isArray(progress.lensesFailed)).toBe(true);
    expect(Array.isArray(progress.lensesSkipped)).toBe(true);
    expect(Array.isArray(progress.lensDetails)).toBe(true);
    expect(typeof progress.totalFindings).toBe("number");
    expect(typeof progress.timestamp).toBe("string");

    // Each lensDetail entry must have these fields
    for (const detail of progress.lensDetails) {
      expect(typeof detail.lens).toBe("string");
      expect(typeof detail.status).toBe("string");
      expect(typeof detail.findingCount).toBe("number");
    }

    // After judge, verdict should be written
    const judgeInput = output.processMergerResult("invalid");
    judgeInput.processJudgeResult("invalid");
    const updated = JSON.parse(readFileSync(join(sessionDir, "review-progress.json"), "utf-8"));
    expect(updated.verdict).toBeTruthy();
    expect(updated.verdictReason).toBeTruthy();
    expect(typeof updated.isPartial).toBe("boolean");
  });

  it("skipped lenses appear in progress lensDetails as skipped", async () => {
    const prepared = prepareLensReview(makeOpts());
    const results = new Map<string, LensResult | null>();

    for (const lens of prepared.activeLenses) {
      results.set(lens, { status: "complete", findings: [] });
    }

    await prepared.processResults(results);
    const progress = JSON.parse(readFileSync(join(sessionDir, "review-progress.json"), "utf-8"));

    for (const skipped of prepared.skippedLenses) {
      const detail = progress.lensDetails.find((d: { lens: string }) => d.lens === skipped);
      expect(detail, `skipped lens ${skipped} should be in lensDetails`).toBeDefined();
      expect(detail.status).toBe("skipped");
      expect(detail.findingCount).toBe(0);
    }
  });

  it("works without sessionDir (no progress file written)", async () => {
    const prepared = prepareLensReview(makeOpts({ sessionDir: undefined }));
    const results = new Map<string, LensResult | null>();

    for (const lens of prepared.activeLenses) {
      results.set(lens, { status: "complete", findings: [] });
    }

    // Should not throw
    const output = await prepared.processResults(results);
    expect(output.mergerPrompt).toBeTruthy();
  });

  it("progress events fire via onProgress callback", async () => {
    const events: Array<{ lens: string; status: string }> = [];
    const prepared = prepareLensReview(makeOpts({
      onProgress: (event: { lens: string; status: string }) => events.push(event),
    }));

    // Should have queued events from preparation
    const queuedEvents = events.filter((e) => e.status === "queued");
    expect(queuedEvents.length).toBeGreaterThan(0);

    const results = new Map<string, LensResult | null>();
    for (const lens of prepared.activeLenses) {
      results.set(lens, { status: "complete", findings: [] });
    }

    await prepared.processResults(results);
    const completeEvents = events.filter((e) => e.status === "complete");
    expect(completeEvents.length).toBeGreaterThan(0);
  });
});

describe("redactArtifactSecrets", () => {
  // The function is not exported, but we can test it through the orchestrator
  // by checking that secrets gate integration works. For the actual redaction
  // logic, we test via the diff that passes through.
  it("orchestrator handles requireSecretsGate=false gracefully", () => {
    // Should not throw when secrets gate is not required
    const prepared = prepareLensReview(makeOpts({ requireSecretsGate: false }));
    expect(prepared.secretsGateActive).toBe(false);
    expect(prepared.secretsMetaFinding).toBeNull();
  });
});

describe("handleSynthesize origin classification (T-192)", () => {
  function makeSynthesizeFinding(lens: string, file: string | null, line: number | null, overrides: Record<string, unknown> = {}) {
    return {
      lens,
      lensVersion: `${lens}-v1`,
      severity: "major" as const,
      recommendedImpact: "needs-revision" as const,
      category: "test-category",
      description: `Finding from ${lens} in ${file ?? "unknown"}`,
      file,
      line,
      evidence: [
        {
          file: file ?? "(unknown)",
          startLine: line ?? 1,
          endLine: line ?? 1,
          code: "test evidence",
        },
      ],
      suggestedFix: "test fix",
      confidence: 0.9,
      assumptions: null,
      requiresMoreContext: false,
      ...overrides,
    };
  }

  it("classifies findings in added lines as introduced", () => {
    const result = handleSynthesize({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: CHANGED_FILES,
      lensResults: [{
        lens: "security",
        status: "complete",
        findings: [makeSynthesizeFinding("security", "src/api.ts", 4)], // line 4 is an added line
      }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: "test" },
      projectRoot,
    });

    expect(result.validatedFindings.length).toBe(1);
    expect(result.validatedFindings[0].origin).toBe("introduced");
    expect(result.preExistingCount).toBe(0);
    expect(result.preExistingFindings.length).toBe(0);
  });

  it("classifies findings in context lines as pre-existing", () => {
    const result = handleSynthesize({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: CHANGED_FILES,
      lensResults: [{
        lens: "security",
        status: "complete",
        findings: [makeSynthesizeFinding("security", "src/api.ts", 3)], // line 3 is context (export function)
      }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: "test" },
      projectRoot,
    });

    expect(result.validatedFindings.length).toBe(1);
    expect(result.validatedFindings[0].origin).toBe("pre-existing");
    // T-257: Without sessionId, verification is skipped and preExistingFindings
    // is suppressed (skip-path filing safety). Origin is still set on validatedFindings.
    expect(result.preExistingCount).toBe(0);
    expect(result.preExistingFindings.length).toBe(0);
  });

  it("classifies findings in files not in diff as pre-existing", () => {
    const result = handleSynthesize({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: CHANGED_FILES,
      lensResults: [{
        lens: "security",
        status: "complete",
        findings: [makeSynthesizeFinding("security", "src/other.ts", 10)],
      }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: "test" },
      projectRoot,
    });

    expect(result.validatedFindings[0].origin).toBe("pre-existing");
    // T-257: preExisting suppressed on skip path (no sessionId)
    expect(result.preExistingCount).toBe(0);
  });

  it("skips origin classification without diff/changedFiles (backward compat)", () => {
    const result = handleSynthesize({
      stage: "CODE_REVIEW",
      lensResults: [{
        lens: "security",
        status: "complete",
        findings: [makeSynthesizeFinding("security", "src/other.ts", 10)],
      }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: "test" },
      projectRoot,
    });

    expect(result.validatedFindings[0].origin).toBeUndefined();
    expect(result.preExistingCount).toBe(0);
    expect(result.preExistingFindings.length).toBe(0);
  });

  it("filters suggestions from pre-existing findings", () => {
    const result = handleSynthesize({
      stage: "CODE_REVIEW",
      diff: DIFF,
      changedFiles: CHANGED_FILES,
      lensResults: [{
        lens: "clean-code",
        status: "complete",
        findings: [
          makeSynthesizeFinding("clean-code", "src/other.ts", 10, { severity: "suggestion" }),
          makeSynthesizeFinding("clean-code", "src/other.ts", 20, { severity: "minor" }),
        ],
      }],
      metadata: { activeLenses: ["clean-code"], skippedLenses: [], reviewRound: 1, reviewId: "test" },
      projectRoot,
    });

    // Both are pre-existing but on skip path (no sessionId), preExistingFindings is empty
    expect(result.validatedFindings.length).toBe(2);
    // T-257: Skip-path filing safety suppresses preExistingFindings
    expect(result.preExistingFindings.length).toBe(0);
  });

  it("PLAN_REVIEW classifies all findings as introduced", () => {
    const result = handleSynthesize({
      stage: "PLAN_REVIEW",
      diff: "Some plan text",
      changedFiles: [],
      lensResults: [{
        lens: "security",
        status: "complete",
        findings: [makeSynthesizeFinding("security", "src/api.ts", 10)],
      }],
      metadata: { activeLenses: ["security"], skippedLenses: [], reviewRound: 1, reviewId: "test" },
      projectRoot,
    });

    // PLAN_REVIEW: all "introduced" per classification rules
    expect(result.preExistingCount).toBe(0);
  });
});
