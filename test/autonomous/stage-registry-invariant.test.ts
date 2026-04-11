/**
 * ISS-377: Startup-time invariant — every WorkflowState must be either a
 * registered pipeline stage or an explicitly documented transient state.
 *
 * This catches the class of bug where a new WorkflowState is added but the
 * corresponding stage is forgotten, which would strand any session landing
 * in that state (same failure mode as ISS-377 itself with COMPACT).
 */
import { describe, it, expect } from "vitest";

// CRITICAL: side-effect import — populates the stage registry. Without this,
// importing hasStage alone leaves the registry empty and the invariant test
// would fail for reasons unrelated to the thing it's checking.
import "../../src/autonomous/stages/index.js";

import { hasStage, registeredStageIds } from "../../src/autonomous/stages/registry.js";
import { WORKFLOW_STATES } from "../../src/autonomous/session-types.js";

const KNOWN_TRANSIENT_STATES = new Set<string>([
  "INIT",         // only set briefly inside handleStart
  "LOAD_CONTEXT", // only set briefly inside handleStart
  "COMPACT",      // transient waiting for resume (ISS-377)
  "SESSION_END",  // terminal
]);

describe("stage registry invariant (ISS-377)", () => {
  it("populates the stage registry via side-effect import", () => {
    // Sanity check: if this fails, the side-effect import above is broken
    // and the next test would pass vacuously for the wrong reason.
    expect(registeredStageIds().length).toBeGreaterThan(0);
  });

  it("every WorkflowState is either a registered stage or a known transient state", () => {
    for (const state of WORKFLOW_STATES) {
      const registered = hasStage(state);
      const isTransient = KNOWN_TRANSIENT_STATES.has(state);
      expect(
        registered || isTransient,
        `WorkflowState "${state}" is neither registered as a pipeline stage nor listed as transient. ` +
        `Either register a stage in src/autonomous/stages/index.ts or add it to KNOWN_TRANSIENT_STATES ` +
        `in test/autonomous/stage-registry-invariant.test.ts.`,
      ).toBe(true);
    }
  });
});
