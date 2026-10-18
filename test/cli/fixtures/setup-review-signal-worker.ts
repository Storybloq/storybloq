/**
 * ISS-1391: a CLI-like process that receives a signal while a reviewer runs.
 * `review` runs a review against the wrapper fake, whose same-group child
 * ignores SIGTERM; `probe` probes a fake whose --version hangs; `overlap` lets
 * a short probe settle while a long review stays live, then reports the SIGINT
 * listener count; `review-exit` writes the reviewer's process group id to
 * `<pidFile>.pgid` (the group is gone by the time a test could look) and calls
 * process.exit(130) with no signal. The optional listener argument installs a
 * caller's own signal listener first. Progress goes to stdout, one word per line.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { handleSetupReviewGate, handleSetupReviewRun } from "../../../src/cli/commands/setup-review.js";
import { probeBackend } from "../../../src/core/setup-review-backends.js";
import { REVIEW_PACKET } from "../../helpers/setup-review-fakes.js";

const [mode, project, store, path, pidFile, listener] = process.argv.slice(2) as [string, string, string, string, string, string | undefined];
const env = { PATH: path, STORYBLOQ_SETUP_REVIEW_DIR: store, HOME: project, FAKE_PID_FILE: pidFile };
// Synchronous, so a word written just before process.exit is not lost on a pipe.
const say = (word: string): void => { writeSync(1, `${word}\n`); };

if (listener === "exit-sync") {
  process.on("SIGINT", () => { say("own"); process.exit(130); });
} else if (listener === "persistent-delayed") {
  process.on("SIGINT", () => { say("own"); setTimeout(() => { say("cleanup-done"); process.exit(130); }, 200); });
} else if (listener === "once-async") {
  process.once("SIGTERM", () => { setTimeout(() => { say("cleanup-done"); process.exit(42); }, 200); });
}
say(`baseline:${process.listenerCount("SIGINT")}`);

const pidWritten = (): Promise<void> => new Promise((resolve) => {
  const poll = setInterval(() => { if (existsSync(pidFile)) { clearInterval(poll); resolve(); } }, 20);
});

async function review(): Promise<void> {
  const deps = { timeoutMs: 60_000, killGraceMs: 200 };
  const gate = await handleSetupReviewGate({ cwd: project, env, stdin: () => Buffer.alloc(0), deps }, {});
  const setup = /^Setup id: (SS-[0-9a-f]{8})$/m.exec(gate.stdout)![1]!;
  const io = { cwd: project, env: { ...env, FAKE_CODEX_MODE: "wrapper" }, stdin: () => Buffer.from(REVIEW_PACKET), deps };
  await handleSetupReviewRun(io, { setup });
}

if (mode === "probe") {
  await probeBackend("codex", { ...env, FAKE_CODEX_VERSION_HANG: "1" }, { timeoutMs: 60_000, killGraceMs: 200 });
} else if (mode === "overlap") {
  void review();
  await pidWritten();
  await probeBackend("codex", { PATH: path }, { timeoutMs: 10_000, killGraceMs: 200 });
  say(`listeners:${process.listenerCount("SIGINT")}`);
  say("ready");
} else if (mode === "review-exit") {
  void review();
  await pidWritten();
  const pid = readFileSync(pidFile, "utf-8").trim();
  writeFileSync(`${pidFile}.pgid`, execFileSync("ps", ["-o", "pgid=", "-p", pid], { encoding: "utf-8" }).trim());
  process.exit(130);
} else {
  await review();
}
