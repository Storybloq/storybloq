// T-538 execution envelope (plan section 8). Exit numbers are not interpreted, so a command's own 124,
// 125 or 137 is reported as itself. The timeout lives here, inside the container, because killing the
// docker CLI does not stop what runs inside. Same uid as the turn: this describes a command's own exit,
// the outer status must still agree, and it never clears evidence.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";

export const KILL_AFTER_MS = 30_000;

export function envelope(argv) {
  const [execId, timeoutText, dashes, ...command] = argv;
  if (!execId || !/^[1-9][0-9]*$/.test(timeoutText ?? "") || dashes !== "--" || command.length === 0) process.exit(2);
  // docker exec without -i leaves /dev/null here, and that is what the child gets.
  const noStdin = fs.fstatSync(0).isCharacterDevice();
  let accepted = 0;
  let timedOut = "no";
  let done = false;
  const finish = (status, signal) => {
    if (done) return;
    done = true;
    fs.writeSync(2, `\0EVAL-ENVELOPE ${execId} ${JSON.stringify({ status, signal, timedOut, stdinAccepted: accepted })}\n`);
    process.exit(signal !== null ? 128 + (constants.signals[signal] ?? 0) : status);
  };
  const child = spawn(command[0], command.slice(1), { detached: true, stdio: [noStdin ? "ignore" : "pipe", "inherit", "inherit"] });
  const group = (signal) => { try { process.kill(-child.pid, signal); } catch { /* the group is gone */ } };
  let killTimer = null;
  const timer = setTimeout(() => {
    timedOut = "term";
    group("SIGTERM");
    killTimer = setTimeout(() => { timedOut = "kill"; group("SIGKILL"); }, KILL_AFTER_MS);
  }, Number(timeoutText) * 1000);
  child.on("error", (e) => { clearTimeout(timer); finish(e.code === "EACCES" ? 126 : 127, null); });
  child.on("exit", (status, signal) => {
    clearTimeout(timer);
    if (killTimer !== null) clearTimeout(killTimer);
    if (timedOut !== "no") group("SIGKILL");
    finish(status, signal);
  });
  if (!noStdin) {
    const stop = () => process.stdin.destroy();
    child.stdin.on("error", stop);
    process.stdin.on("error", () => {});
    process.stdin.on("end", () => child.stdin.end());
    process.stdin.on("data", (d) => {
      const more = child.stdin.write(d, (e) => { if (!e) accepted += d.length; });
      if (!more) { process.stdin.pause(); child.stdin.once("drain", () => process.stdin.resume()); }
    });
  }
}

envelope(process.argv.slice(2));
