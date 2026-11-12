/**
 * ISS-1497: the suite runs the supervisor bundled from the current src by
 * test/setup-review-supervisor.global.ts, never whatever dist holds. The global
 * setup publishes the bundle's path in this variable; test/setup.ts and every
 * worker fixture that runs a review point the seam at it.
 */
import { supervisorSeams } from "../../src/core/setup-review-supervisor.js";

export const TEST_SUPERVISOR_ENV = "STORYBLOQ_TEST_SUPERVISOR_ENTRY";

export function useTestSupervisorEntry(seams: { entry: () => string } = supervisorSeams): void {
  const entry = process.env[TEST_SUPERVISOR_ENV];
  if (entry) seams.entry = () => entry;
}
