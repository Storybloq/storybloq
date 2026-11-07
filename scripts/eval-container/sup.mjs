// T-538 supervisor (amendment A1): the child of --init, running as eval. Relay death ends the
// attempt, with no restart. Its own deadline is best effort: the runner's docker stop is the
// deadline of record, and an exit code here is a hint only, since a same-uid tool can exit with any.
import { spawn } from "node:child_process";
import { constants as fsc, appendFileSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EXIT_RELAY_DIED = 70;
export const EXIT_OWN_DEADLINE = 71;

export function supervise({ deadlineSeconds, logPath, relayPath }) {
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds <= 0) process.exit(2);
  // Output goes to a file, never to any exec's capture. relay.log is not evidence.
  const out = openSync(logPath, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_APPEND | fsc.O_NOFOLLOW, 0o600);
  const relay = spawn(process.execPath, [relayPath], { stdio: ["ignore", out, out] });
  relay.on("exit", (code, signal) => {
    appendFileSync(logPath, `relay-exit ${code} ${signal}\n`);
    process.exit(EXIT_RELAY_DIED);
  });
  process.on("SIGTERM", () => {
    relay.removeAllListeners("exit");
    relay.kill("SIGKILL");
    process.exit(0);
  });
  setTimeout(() => {
    relay.removeAllListeners("exit");
    relay.kill("SIGKILL");
    process.exit(EXIT_OWN_DEADLINE);
  }, deadlineSeconds * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  supervise({ deadlineSeconds: Number(process.argv[2]), logPath: "/vol/att/relay.log", relayPath: join(dirname(fileURLToPath(import.meta.url)), "relay.mjs") });
}
