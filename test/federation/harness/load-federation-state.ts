/**
 * ISS-1393 test harness, never shipped: prints the FederationState that
 * loadFederationState returns for the orchestrator at argv[2], loaded as the
 * CLI's recommend command loads it. loadFederationState is in no built bundle,
 * so scripts/build-federation-harness.mjs bundles this file for the Mac app's
 * parity test, which then reads the cache the call left behind.
 */
import { loadProject } from "../../../src/core/project-loader.js";
import { loadFederationState } from "../../../src/federation/recommend-loader.js";

const root = process.argv[2];
if (!root) {
  process.stderr.write("usage: load-federation-state <orchestrator root>\n");
  process.exit(2);
}
const { state } = await loadProject(root);
const fedState = await loadFederationState(root, state.config);
process.stdout.write(JSON.stringify(fedState ?? null));
