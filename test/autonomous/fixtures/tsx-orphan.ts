/**
 * ISS-1386: a tsx child that leaves a descendant behind. The descendant shares
 * the process group, ignores SIGTERM and parks forever; this script writes its
 * pid to the marker named by argv[2] and exits, so the launcher's completion
 * settles while the group lives on.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
  stdio: "ignore",
});
descendant.unref();
writeFileSync(process.argv[2], String(descendant.pid));
process.exit(0);
