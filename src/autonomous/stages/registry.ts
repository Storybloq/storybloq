import type { WorkflowStage, StageContext } from "./types.js";

// ---------------------------------------------------------------------------
// Stage registry — maps stage IDs to WorkflowStage implementations
// ---------------------------------------------------------------------------

const stages = new Map<string, WorkflowStage>();

/** Register a stage implementation. Throws if ID already registered. */
export function registerStage(stage: WorkflowStage): void {
  if (stages.has(stage.id)) {
    throw new Error(`Stage "${stage.id}" is already registered`);
  }
  stages.set(stage.id, stage);
}

/** Get a registered stage by ID. Returns undefined if not found. */
export function getStage(id: string): WorkflowStage | undefined {
  return stages.get(id);
}

/** Check if a stage ID is registered. */
export function hasStage(id: string): boolean {
  return stages.has(id);
}

/** Get all registered stage IDs. */
export function registeredStageIds(): readonly string[] {
  return [...stages.keys()];
}

/** Clear all registered stages. For test isolation only. */
export function resetStageRegistry(): void {
  stages.clear();
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

export type NextStageResult =
  | { kind: "found"; stage: WorkflowStage }
  | { kind: "unregistered"; id: string }
  | { kind: "exhausted" };

/**
 * Find the next non-skipping stage in the pipeline after the current stage.
 *
 * Returns { kind: "found", stage } for a registered, non-skipping stage.
 * Returns { kind: "unregistered", id } if the next pipeline entry is not
 * registered (hybrid dispatch: walker must delegate to legacy handler).
 * Returns { kind: "exhausted" } if the pipeline has no more entries.
 */
export function findNextStage(
  pipeline: readonly string[],
  currentId: string,
  ctx: StageContext,
): NextStageResult {
  const currentIndex = pipeline.indexOf(currentId);
  if (currentIndex === -1) return { kind: "exhausted" };

  for (let i = currentIndex + 1; i < pipeline.length; i++) {
    const stage = stages.get(pipeline[i]);
    if (!stage) {
      // Pipeline entry not registered — cannot advance past it
      return { kind: "unregistered", id: pipeline[i] };
    }
    if (stage.skip?.(ctx)) continue;
    return { kind: "found", stage };
  }

  return { kind: "exhausted" };
}

/**
 * Find the first non-skipping stage in the postComplete pipeline.
 * Same discriminated result as findNextStage — stops at unregistered entries.
 */
export function findFirstPostComplete(
  postComplete: readonly string[],
  ctx: StageContext,
): NextStageResult {
  if (postComplete.length === 0) return { kind: "exhausted" };
  for (const id of postComplete) {
    const stage = stages.get(id);
    if (!stage) {
      return { kind: "unregistered", id };
    }
    if (stage.skip?.(ctx)) continue;
    return { kind: "found", stage };
  }
  return { kind: "exhausted" };
}

/**
 * Find the next non-skipping stage in postComplete AFTER the given stage ID.
 * Used by processAdvance to advance through postComplete without looping.
 */
export function findNextPostComplete(
  postComplete: readonly string[],
  currentId: string,
  ctx: StageContext,
): NextStageResult {
  const currentIndex = postComplete.indexOf(currentId);
  // Start after current stage; if not found, scan from start (fallback)
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
  for (let i = startIndex; i < postComplete.length; i++) {
    const id = postComplete[i]!;
    const stage = stages.get(id);
    if (!stage) return { kind: "unregistered", id };
    if (stage.skip?.(ctx)) continue;
    return { kind: "found", stage };
  }
  return { kind: "exhausted" };
}

/**
 * Validate that all stage IDs in a pipeline are registered.
 * Returns array of unregistered IDs (empty = valid).
 */
export function validatePipeline(pipeline: readonly string[]): string[] {
  return pipeline.filter(id => !stages.has(id));
}
