/**
 * ISS-1457 finding 5: a mover that dies by SIGKILL after its copy and before
 * its rename, so its staging folder is left behind for the next mover to clear.
 * argv: project home setupId. TMPDIR names the old store's parent.
 */
import { setupPaths } from "../../../src/core/setup-review.js";
import { migrateSeams, placeSetup } from "../../../src/core/setup-review-migrate.js";

const [project, home, id] = process.argv.slice(2) as [string, string, string];
migrateSeams.beforePublish = () => {
  process.kill(process.pid, "SIGKILL");
};
await placeSetup(setupPaths({ HOME: home }, project, id), { HOME: home }, false);
process.stdout.write("renamed\n");
