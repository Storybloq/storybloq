// ISS-1457: stands in for the CLI. It starts the built supervisor holding the
// only write end of its fd 3, relays each supervisor line to stdout, and
// stops where the phase says so the test can SIGKILL it there.
//   argv: entry phase command json-args
//   phase: ready (never sends start), start (SIGKILLs itself once start is written),
//          started (waits for started), completed (waits for completed),
//          saturated (stops reading the supervisor once started is relayed),
//          stdin (sends a 5 MiB prompt the reviewer never reads)
import { spawn } from "node:child_process";
const [entry, phase, command, argsJson, signalLog, holdFile] = process.argv.slice(2);
const sup = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "inherit", "pipe"], detached: true,
  env: { PATH: process.env.PATH ?? "", ...(signalLog ? { STORYBLOQ_SUPERVISOR_SIGNAL_LOG: signalLog } : {}), ...(holdFile ? { STORYBLOQ_SUPERVISOR_HOLD_AFTER_COMPLETED: holdFile } : {}) },
});
process.stdout.write(JSON.stringify({ type: "supervisor", pid: sup.pid }) + "\n");
let buf = "";
sup.stdout.setEncoding("utf-8");
sup.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    process.stdout.write(line + "\n");
    const msg = JSON.parse(line);
    if (msg.type === "started" && phase === "saturated") sup.stdout.pause();
    if (msg.type === "ready" && phase !== "ready") {
      const start = { type: "start", command, args: JSON.parse(argsJson), cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, stdin: phase === "stdin" ? Buffer.alloc(5 * 1024 * 1024, 65).toString("base64") : "", timeoutMs: 60000, killGraceMs: 200 };
      sup.stdin.write(JSON.stringify(start) + "\n", () => { if (phase === "start") process.kill(process.pid, "SIGKILL"); });
    }
  }
});
setInterval(() => {}, 1000);
