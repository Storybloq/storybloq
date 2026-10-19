/**
 * T-538: `storybloq setup-apply` and `storybloq setup-report`.
 *
 * `setup-apply` hands the approved setup payload (standard input), a resume
 * (`--resume --setup <id>`) or the owner's resolutions (`--resolve <json>
 * --setup <id>`) to the one setup engine and prints its lines verbatim; the
 * exit code is the engine's. `setup-report` prints the live report, or the
 * frozen one with `--historical`, and writes nothing.
 *
 * Write reporting (ISS-1107), split by path: a call that starts on an existing
 * project (`.story/config.json` present: a resume, a resolution, or an apply
 * onto a scaffold) runs under the board-write recorder and appends the same
 * `Git:` lines `runBoardWrite` reports, only after exit 0. A call that starts
 * with no project yet (a fresh bootstrap, or resuming one) is the bootstrap
 * path: it reports nothing beyond the engine's own lines.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runWithBoardWriteContext } from "../../core/board-write-recorder.js";
import { reportBoardWrite } from "../../core/board-git-state.js";
import { serializeJSON } from "../../core/project-loader.js";
import { runSetupInvocation, setupApply, setupReport, setupResolve, setupResume, sha256, type InvocationKind, type SetupApplyResult } from "../../core/setup-apply.js";

export interface SetupApplyIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: () => Buffer;
}

export interface SetupApplyCliResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface SetupApplyCliOptions {
  readonly setup?: string;
  readonly resume?: boolean;
  readonly resolve?: string;
}

const out = (r: SetupApplyResult): SetupApplyCliResult => ({ stdout: r.lines.map((l) => `${l}\n`).join(""), exitCode: r.exitCode });
const refused = (why: string): SetupApplyCliResult => ({ stdout: `Setup refused: ${why}\n`, exitCode: 2 });

function parseJson(text: string, what: string): { value: unknown } | { error: SetupApplyCliResult } {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: refused(`${what} is not JSON.`) };
  }
}

/** Runs one engine call, with the board-write report when the project already exists. */
async function reported(cwd: string, run: () => Promise<SetupApplyResult>): Promise<SetupApplyCliResult> {
  if (!existsSync(join(resolve(cwd), ".story", "config.json"))) return out(await run());
  const { value, context } = await runWithBoardWriteContext("setup-apply", false, run);
  if (value.exitCode !== 0) return out(value);
  const report = await reportBoardWrite(context);
  return out({ ...value, lines: [...value.lines, ...report.lines] });
}

/** A JSON argument as parsed, or its text, trimmed, when it does not parse (a here-document ends in a newline). */
function argValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

/**
 * The digest of one setup-apply call's arguments (T-538 S5a): the same for an
 * MCP call and its CLI form, since the MCP tool hands the handler the payload
 * and the resolutions as JSON text. The payload is read only by the call form
 * that takes it from standard input.
 */
export function setupArgSha256(opts: SetupApplyCliOptions, stdinText: string | null): string {
  return sha256(serializeJSON({
    payload: stdinText === null ? null : argValue(stdinText),
    resume: opts.resume === true,
    setup: opts.setup ?? null,
    resolutions: opts.resolve === undefined ? null : argValue(opts.resolve),
  }));
}

interface Routed {
  readonly kind: InvocationKind;
  readonly run: () => Promise<SetupApplyCliResult>;
}

function route(io: SetupApplyIo, opts: SetupApplyCliOptions, stdinText: string | null): Routed {
  const options = { env: io.env };
  const refuse = (r: SetupApplyCliResult): Routed => ({ kind: "refused", run: async () => r });
  if (opts.resume === true && opts.resolve !== undefined) return refuse(refused("--resume and --resolve are separate calls; send one."));
  if (opts.resume === true || opts.resolve !== undefined) {
    if (opts.setup === undefined) return refuse(refused(`--setup <id> is required with ${opts.resume === true ? "--resume" : "--resolve"}.`));
    if (opts.resume === true) return { kind: "resume", run: () => reported(io.cwd, () => setupResume(io.cwd, opts.setup!, options)) };
    const parsed = parseJson(opts.resolve!, "--resolve");
    if ("error" in parsed) return refuse(parsed.error);
    return { kind: "resolve", run: () => reported(io.cwd, () => setupResolve(io.cwd, opts.setup!, parsed.value, options)) };
  }
  if (opts.setup !== undefined) return refuse(refused("--setup goes with --resume or --resolve; a new setup takes its payload on standard input alone."));
  const text = stdinText!;
  if (text.trim() === "") return refuse(refused("no payload on standard input; send the approved payload, or use --resume --setup <id>."));
  const parsed = parseJson(text, "the payload on standard input");
  if ("error" in parsed) return refuse(parsed.error);
  return { kind: "apply", run: () => reported(io.cwd, () => setupApply(io.cwd, parsed.value, options)) };
}

/** Every setup-apply call, MCP or CLI, refused or run, is one invocation with its start and end events. */
export async function handleSetupApply(io: SetupApplyIo, opts: SetupApplyCliOptions): Promise<SetupApplyCliResult> {
  const takesPayload = opts.resume !== true && opts.resolve === undefined && opts.setup === undefined;
  const stdinText = takesPayload ? io.stdin().toString("utf-8") : null;
  const routed = route(io, opts, stdinText);
  return runSetupInvocation(io.cwd, routed.kind, setupArgSha256(opts, stdinText), routed.run);
}

export async function handleSetupReport(io: SetupApplyIo, opts: { setup: string; historical?: boolean }): Promise<SetupApplyCliResult> {
  return out(await setupReport(io.cwd, opts.setup, { historical: opts.historical === true }));
}
