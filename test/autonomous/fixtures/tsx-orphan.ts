/**
 * ISS-1386: a tsx child that leaves a descendant behind. The descendant shares
 * the process group, ignores SIGTERM and parks forever; it writes its own pid
 * to the marker named by argv[2] only after its SIGTERM handler is installed,
 * so a teardown that reads the marker always meets a descendant that needs the
 * SIGKILL escalation. This script exits at once, so the launcher's completion
 * settles while the group lives on.
 */
import { spawn } from "node:child_process";

const park = [
  "process.on('SIGTERM', () => {});",
  "const fs = require('node:fs');",
  "fs.writeFileSync(process.argv[1] + '.tmp', String(process.pid));",
  "fs.renameSync(process.argv[1] + '.tmp', process.argv[1]);",
  "setInterval(() => {}, 1000);",
].join(" ");
const descendant = spawn(process.execPath, ["-e", park, process.argv[2]], { stdio: "ignore" });
descendant.unref();
process.exit(0);
