/**
 * T-538 S0 (pen ruling G1): the only caller that passes the runner a stand-in admission. Test code spawns this
 * wrapper, never the runner's CLI, to drive a fresh Claude run against a stand-in client. It lives under test/
 * and is never shipped; signed-in stays refused even here.
 */
import { runnerCli } from "../../scripts/onboarding-eval-run.js";

runnerCli(process.argv.slice(2), { kind: "fresh-claude-stand-in" });
