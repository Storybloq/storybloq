/**
 * ISS-067: Stage override plumbing -> resolvedPipeline.
 */
import { describe, it, expect } from "vitest";
import { resolveRecipe } from "../../../src/autonomous/recipes/loader.js";

describe("ISS-067: resolveRecipe stage overrides", () => {
  it("BUILD disabled in recipe defaults, enabled via override -> in pipeline", () => {
    const recipe = resolveRecipe("coding", {
      stages: { BUILD: { enabled: true, command: "npm run build" } },
    });
    expect(recipe.pipeline).toContain("BUILD");
  });

  it("BUILD not enabled by default -> not in pipeline", () => {
    const recipe = resolveRecipe("coding");
    expect(recipe.pipeline).not.toContain("BUILD");
  });

  it("VERIFY not enabled by default -> not in pipeline", () => {
    const recipe = resolveRecipe("coding");
    expect(recipe.pipeline).not.toContain("VERIFY");
  });

  it("VERIFY enabled via override -> in pipeline", () => {
    const recipe = resolveRecipe("coding", {
      stages: { VERIFY: { enabled: true, startCommand: "npm run dev", readinessUrl: "http://localhost:3000" } },
    });
    expect(recipe.pipeline).toContain("VERIFY");
  });

  it("override merges with recipe defaults (command overridden)", () => {
    const recipe = resolveRecipe("coding", {
      stages: { BUILD: { enabled: true, command: "pnpm build" } },
    });
    expect(recipe.pipeline).toContain("BUILD");
    const buildConfig = recipe.stages.BUILD as Record<string, unknown>;
    expect(buildConfig.command).toBe("pnpm build");
  });

  it("BUILD explicitly disabled via override -> not in pipeline", () => {
    const recipe = resolveRecipe("coding", {
      stages: { BUILD: { enabled: false } },
    });
    expect(recipe.pipeline).not.toContain("BUILD");
  });

  it("malformed stage override (null value) is ignored", () => {
    const recipe = resolveRecipe("coding", {
      stages: { BUILD: null as unknown as Record<string, unknown> },
    });
    expect(recipe.pipeline).not.toContain("BUILD");
  });
});
