/**
 * T-536: runs one setup-review handler in its own process for the crash test.
 * `run-pause` stops inside the publishing step, after record.json is written
 * and before the rename, tells the parent over IPC and blocks until it is
 * killed; `run` and `status` report their result over IPC and exit.
 */
import { handleSetupReviewRun, handleSetupReviewStatus } from "../../../src/cli/commands/setup-review.js";

const [mode, project, store, setupId, path, packet] = process.argv.slice(2) as [string, string, string, string, string, string];
const io = {
  cwd: project,
  env: { PATH: path, STORYBLOQ_SETUP_REVIEW_DIR: store, HOME: project },
  stdin: () => Buffer.from(packet),
  deps: {
    timeoutMs: 10_000,
    ...(mode === "run-pause"
      ? {
          beforePublish: () => {
            process.send!("paused");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          },
        }
      : {}),
  },
};

const result = mode === "status" ? await handleSetupReviewStatus(io, { setup: setupId }) : await handleSetupReviewRun(io, { setup: setupId });
process.send!(result, () => process.exit(0));
