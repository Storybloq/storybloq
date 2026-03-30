import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedRecipe } from "../stages/types.js";

// ---------------------------------------------------------------------------
// Recipe schema (raw JSON shape)
// ---------------------------------------------------------------------------

interface RawRecipe {
  id: string;
  schemaVersion: number;
  pipeline?: readonly string[];
  postComplete?: readonly string[];
  stages?: Record<string, Record<string, unknown>>;
  dirtyFileHandling?: string;
  defaults?: {
    maxTicketsPerSession?: number;
    compactThreshold?: string;
    reviewBackends?: string[];
  };
}

// ---------------------------------------------------------------------------
// Default pipeline (matches current hardcoded flow)
// ---------------------------------------------------------------------------

const DEFAULT_PIPELINE: readonly string[] = [
  "PICK_TICKET", "PLAN", "PLAN_REVIEW",
  "IMPLEMENT", "CODE_REVIEW",
  "FINALIZE", "COMPLETE",
];

const DEFAULT_DEFAULTS = {
  maxTicketsPerSession: 3,
  compactThreshold: "high" as const,
  reviewBackends: ["codex", "agent"] as readonly string[],
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load a recipe JSON file by name from the recipes/ directory.
 * Returns the raw recipe object.
 */
export function loadRecipe(recipeName: string): RawRecipe {
  if (!/^[A-Za-z0-9_-]+$/.test(recipeName)) {
    throw new Error(`Invalid recipe name: ${recipeName}`);
  }
  const recipesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "recipes");
  const path = join(recipesDir, `${recipeName}.json`);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as RawRecipe;
}

/**
 * Resolve a recipe into a frozen pipeline configuration.
 *
 * Merges project-level overrides (from config.json recipeOverrides) on top
 * of the recipe's defaults. Inserts conditional stages (TEST) when enabled.
 *
 * The resolved recipe is persisted in session state at start time so the
 * pipeline is frozen for the session's lifetime (survives compact/resume).
 */
export function resolveRecipe(
  recipeName: string,
  projectOverrides?: {
    maxTicketsPerSession?: number;
    compactThreshold?: string;
    reviewBackends?: string[];
  },
): ResolvedRecipe {
  let raw: RawRecipe;
  try {
    raw = loadRecipe(recipeName);
  } catch (err: unknown) {
    // Only fallback for missing file — re-throw parse errors and I/O failures
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      raw = {
        id: recipeName,
        schemaVersion: 1,
      };
    } else {
      throw err;
    }
  }

  // Pipeline: use recipe's pipeline or synthesize default for v1 schemas
  let pipeline: string[] = raw.pipeline
    ? [...raw.pipeline]
    : [...DEFAULT_PIPELINE];

  // Insert conditional stages
  const stages = raw.stages ?? {};

  // WRITE_TESTS: insert BEFORE IMPLEMENT (TDD — write failing tests first)
  if ((stages.WRITE_TESTS as Record<string, unknown>)?.enabled) {
    const implementIdx = pipeline.indexOf("IMPLEMENT");
    if (implementIdx !== -1 && !pipeline.includes("WRITE_TESTS")) {
      pipeline.splice(implementIdx, 0, "WRITE_TESTS");
    }
  }

  // VERIFY: insert AFTER CODE_REVIEW (smoke test endpoints before FINALIZE)
  if ((stages.VERIFY as Record<string, unknown>)?.enabled) {
    const codeReviewIdx = pipeline.indexOf("CODE_REVIEW");
    if (codeReviewIdx !== -1 && !pipeline.includes("VERIFY")) {
      pipeline.splice(codeReviewIdx + 1, 0, "VERIFY");
    }
  }

  // TEST: insert AFTER IMPLEMENT (verify tests pass post-implementation)
  if ((stages.TEST as Record<string, unknown>)?.enabled) {
    const implementIdx = pipeline.indexOf("IMPLEMENT");
    if (implementIdx !== -1 && !pipeline.includes("TEST")) {
      pipeline.splice(implementIdx + 1, 0, "TEST");
    }
  }

  // PostComplete pipeline
  const postComplete = raw.postComplete ? [...raw.postComplete] : [];

  // Merge defaults with project overrides
  const recipeDefaults = raw.defaults ?? {};
  const defaults = {
    maxTicketsPerSession: projectOverrides?.maxTicketsPerSession
      ?? recipeDefaults.maxTicketsPerSession
      ?? DEFAULT_DEFAULTS.maxTicketsPerSession,
    compactThreshold: projectOverrides?.compactThreshold
      ?? recipeDefaults.compactThreshold
      ?? DEFAULT_DEFAULTS.compactThreshold,
    reviewBackends: projectOverrides?.reviewBackends
      ?? recipeDefaults.reviewBackends
      ?? [...DEFAULT_DEFAULTS.reviewBackends],
  };

  return {
    id: raw.id ?? recipeName,
    pipeline,
    postComplete,
    stages,
    dirtyFileHandling: raw.dirtyFileHandling ?? "block",
    defaults,
  };
}
