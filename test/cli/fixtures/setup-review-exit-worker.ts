/**
 * T-536: a CLI-like process that must end by itself after a reviewer timeout
 * even when a process the reviewer started outside its group still runs.
 * `review` opens a setup and runs a review against the escaping fake; `probe`
 * probes a fake whose --version leaves an escaped child. The result goes to
 * stdout; nothing here calls process.exit.
 */
import { handleSetupReviewGate, handleSetupReviewRun } from "../../../src/cli/commands/setup-review.js";
import { probeBackend } from "../../../src/core/setup-review-backends.js";
import { REVIEW_PACKET } from "../../helpers/setup-review-fakes.js";

const [mode, project, store, path, pidFile] = process.argv.slice(2) as [string, string, string, string, string];
const env = { PATH: path, STORYBLOQ_SETUP_REVIEW_DIR: store, HOME: project, FAKE_PID_FILE: pidFile };

if (mode === "probe") {
  const version = await probeBackend("codex", { ...env, FAKE_CODEX_VERSION_ESCAPE: "1" }, { timeoutMs: 300, killGraceMs: 200 });
  process.stdout.write(JSON.stringify({ version }));
} else {
  const deps = { timeoutMs: 300, killGraceMs: 200 };
  const gate = await handleSetupReviewGate({ cwd: project, env, stdin: () => Buffer.alloc(0), deps }, {});
  const setup = /^Setup id: (SS-[0-9a-f]{8})$/m.exec(gate.stdout)![1]!;
  const io = { cwd: project, env: { ...env, FAKE_CODEX_MODE: "escape" }, stdin: () => Buffer.from(REVIEW_PACKET), deps };
  process.stdout.write(JSON.stringify(await handleSetupReviewRun(io, { setup })));
}
