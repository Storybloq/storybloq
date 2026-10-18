/**
 * T-538 S3a-2: `storybloq setup-verify --ticket <id>`. Runs an establishment
 * ticket's test command and, on a verified run, completes the ticket and turns
 * on the stages it serves (core/setup-verify.ts). Prints the engine's lines
 * verbatim; the exit code is the engine's. A write is reported through the
 * board-write recorder with the same `Git:` lines `runBoardWrite` appends,
 * only after exit 0.
 */
import { runWithBoardWriteContext } from "../../core/board-write-recorder.js";
import { reportBoardWrite } from "../../core/board-git-state.js";
import { setupVerify } from "../../core/setup-verify.js";

export interface SetupVerifyIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface SetupVerifyCliResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export async function handleSetupVerify(io: SetupVerifyIo, opts: { ticket: string }): Promise<SetupVerifyCliResult> {
  const { value, context } = await runWithBoardWriteContext("setup-verify", false, () => setupVerify(io.cwd, { ticket: opts.ticket }, { env: io.env }));
  const lines = value.exitCode === 0 ? [...value.lines, ...(await reportBoardWrite(context)).lines] : value.lines;
  return { stdout: lines.map((l) => `${l}\n`).join(""), exitCode: value.exitCode };
}
