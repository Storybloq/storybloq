import { describe, it, expect } from "vitest";
import { buildLensPrompt, getLensVersion } from "../../../src/autonomous/review-lenses/lenses/index.js";
import { ALL_LENSES } from "../../../src/autonomous/review-lenses/types.js";
import type { LensPromptVariables, LensName, ReviewStage } from "../../../src/autonomous/review-lenses/types.js";

const baseVars: LensPromptVariables = {
  lensName: "clean-code",
  lensVersion: "clean-code-v1",
  reviewStage: "CODE_REVIEW",
  artifactType: "diff",
  ticketDescription: "Add user search feature",
  projectRules: "Follow SRP",
  fileManifest: "- src/search.ts: searchUsers, buildQuery",
  reviewArtifact: "diff --git a/src/search.ts b/src/search.ts\n+function searchUsers() {}",
  knownFalsePositives: "",
  activationReason: "core lens",
  findingBudget: 10,
  confidenceFloor: 0.6,
};

describe("lens prompt builders", () => {
  for (const lens of ALL_LENSES) {
    describe(lens, () => {
      it("has a version string", () => {
        const version = getLensVersion(lens);
        expect(version).toMatch(/^[a-z-]+-v\d+$/);
      });

      for (const stage of ["CODE_REVIEW", "PLAN_REVIEW"] as ReviewStage[]) {
        it(`builds ${stage} prompt`, () => {
          const vars = {
            ...baseVars,
            lensName: lens,
            lensVersion: getLensVersion(lens),
            reviewStage: stage,
            artifactType: (stage === "CODE_REVIEW" ? "diff" : "plan") as "diff" | "plan",
          };
          const prompt = buildLensPrompt(lens, stage, vars);

          // Should contain shared preamble
          expect(prompt).toContain("## Safety");
          expect(prompt).toContain("## Output rules");
          expect(prompt).toContain(lens);

          // Should contain stage-appropriate label
          if (stage === "CODE_REVIEW") {
            expect(prompt).toContain("Diff to review");
          } else {
            expect(prompt).toContain("Plan to review");
          }

          // Should contain the review artifact
          expect(prompt).toContain("searchUsers");
        });
      }
    });
  }

  it("security prompt includes scanner findings placeholder", () => {
    const vars = {
      ...baseVars,
      lensName: "security",
      lensVersion: "security-v2",
      scannerFindings: "CVE-2024-1234: lodash prototype pollution",
    };
    const prompt = buildLensPrompt("security", "CODE_REVIEW", vars);
    expect(prompt).toContain("CVE-2024-1234");
  });

  it("performance prompt includes hot paths", () => {
    const vars = {
      ...baseVars,
      lensName: "performance",
      lensVersion: "performance-v2",
      hotPaths: "src/engine/**, src/billing/**",
    };
    const prompt = buildLensPrompt("performance", "CODE_REVIEW", vars);
    expect(prompt).toContain("src/engine/**");
  });

  it("all prompts include confidence floor", () => {
    const vars = { ...baseVars, confidenceFloor: 0.7 };
    const prompt = buildLensPrompt("clean-code", "CODE_REVIEW", vars);
    expect(prompt).toContain("0.7");
  });

  it("no unreplaced template variables in any prompt", () => {
    for (const lens of ALL_LENSES) {
      for (const stage of ["CODE_REVIEW", "PLAN_REVIEW"] as const) {
        const vars = {
          ...baseVars,
          lensName: lens,
          lensVersion: `${lens}-v2`,
          reviewStage: stage,
          artifactType: (stage === "CODE_REVIEW" ? "diff" : "plan") as "diff" | "plan",
          scannerFindings: "",
          hotPaths: "",
        };
        const prompt = buildLensPrompt(lens, stage, vars);
        // No literal {{ should remain after variable injection
        expect(prompt).not.toMatch(/\{\{[^}]+\}\}/);
      }
    }
  });

  // ── T-256: Evidence contract & version v2 ──────────────────────

  for (const lens of ALL_LENSES) {
    it(`${lens} version is v2`, () => {
      expect(getLensVersion(lens)).toBe(`${lens}-v2`);
    });
  }

  for (const lens of ALL_LENSES) {
    it(`${lens} CODE_REVIEW prompt contains strict evidence contract`, () => {
      const vars = {
        ...baseVars,
        lensName: lens,
        lensVersion: getLensVersion(lens),
        reviewStage: "CODE_REVIEW" as const,
        artifactType: "diff" as const,
        scannerFindings: "",
        hotPaths: "",
      };
      const prompt = buildLensPrompt(lens, "CODE_REVIEW", vars);
      expect(prompt).toContain("## Evidence contract");
      expect(prompt).toContain("verification gate");
      expect(prompt).toContain("## Finding shape");
    });

    it(`${lens} PLAN_REVIEW prompt contains best-effort evidence contract`, () => {
      const vars = {
        ...baseVars,
        lensName: lens,
        lensVersion: getLensVersion(lens),
        reviewStage: "PLAN_REVIEW" as const,
        artifactType: "plan" as const,
        scannerFindings: "",
        hotPaths: "",
      };
      const prompt = buildLensPrompt(lens, "PLAN_REVIEW", vars);
      expect(prompt).toContain("## Evidence contract");
      expect(prompt).toContain("best-effort");
      expect(prompt).not.toContain("verification gate");
      expect(prompt).toContain("## Finding shape");
    });
  }

  const lensesWithSpecificEvidence: LensName[] = [
    "security",
    "concurrency",
    "error-handling",
    "test-quality",
    "performance",
    "clean-code",
    "api-design",
    "accessibility",
  ];
  for (const lens of lensesWithSpecificEvidence) {
    it(`${lens} CODE_REVIEW has lens-specific evidence section`, () => {
      const vars = {
        ...baseVars,
        lensName: lens,
        lensVersion: getLensVersion(lens),
        reviewStage: "CODE_REVIEW" as const,
        artifactType: "diff" as const,
        scannerFindings: "",
        hotPaths: "",
      };
      const prompt = buildLensPrompt(lens, "CODE_REVIEW", vars);
      expect(prompt).toContain(`Evidence for ${lens}`);
    });
  }

  it("finding shape includes lens and lensVersion fields", () => {
    const vars = {
      ...baseVars,
      lensName: "security",
      lensVersion: "security-v2",
      reviewStage: "CODE_REVIEW" as const,
      artifactType: "diff" as const,
    };
    const prompt = buildLensPrompt("security", "CODE_REVIEW", vars);
    expect(prompt).toContain('"lens": "security"');
    expect(prompt).toContain('"lensVersion": "security-v2"');
  });

  it("PLAN_REVIEW evidence contract documents plan/<ticket-id> placeholder", () => {
    const vars = {
      ...baseVars,
      reviewStage: "PLAN_REVIEW" as const,
      artifactType: "plan" as const,
    };
    const prompt = buildLensPrompt("clean-code", "PLAN_REVIEW", vars);
    expect(prompt).toContain("plan/<ticket-id>");
    expect(prompt).toContain("plan/T-100");
  });

  it("evidence contract prohibits diff prefixes", () => {
    const vars = {
      ...baseVars,
      reviewStage: "CODE_REVIEW" as const,
      artifactType: "diff" as const,
    };
    const prompt = buildLensPrompt("clean-code", "CODE_REVIEW", vars);
    expect(prompt).toMatch(/[Dd]o NOT use diff prefixes/);
  });

  it("security prompt handles empty scannerFindings without outputting 'undefined'", () => {
    const vars = {
      ...baseVars,
      lensName: "security",
      lensVersion: "security-v2",
      scannerFindings: undefined as unknown as string,
    };
    const prompt = buildLensPrompt("security", "CODE_REVIEW", vars);
    expect(prompt).not.toContain("undefined");
  });
});
