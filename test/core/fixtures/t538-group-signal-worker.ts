/**
 * T-538 S3a-2: a CLI-like process that receives a signal while setup-verify's
 * test command runs in its own group. The group's leader ignores SIGTERM and
 * writes its pid to the file named on the command line, then waits.
 */
import { runInGroup } from "../../../src/core/process-group.js";

const [pidFile] = process.argv.slice(2) as [string];
await runInGroup({
  command: "/bin/sh",
  args: ["-c", `trap '' TERM; echo $$ > '${pidFile}'; sleep 60`],
  cwd: process.cwd(),
  env: { PATH: "/usr/bin:/bin" },
  timeoutMs: 60_000,
  killGraceMs: 200,
  onData: () => {},
});
