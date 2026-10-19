/**
 * ISS-1408: `claude plugin validate`, run so that a failure says why. A bare
 * execFileSync failure reports only "Command failed", which hides which claude
 * ran, its version and what validate printed; on this machine that has meant a
 * stale claude earlier on PATH. The error names all of them instead.
 */

import { spawnSync } from "node:child_process";

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** Returns validate's stdout on exit 0; throws an Error carrying the diagnostics otherwise. */
export function claudeValidate(dir: string, env: NodeJS.ProcessEnv): string {
  const run = spawnSync("claude", ["plugin", "validate", dir], { encoding: "utf8", env });
  if (run.error === undefined && run.status === 0) return run.stdout;
  const where = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8", env });
  const version = spawnSync("claude", ["--version"], { encoding: "utf8", env });
  const exit = run.error !== undefined ? `spawn error ${run.error.message}` : run.status === null ? `signal ${run.signal}` : `exit ${run.status}`;
  throw new Error(
    [
      `claude plugin validate ${dir} failed (${exit})`,
      `claude: ${firstLine(where.stdout ?? "") || "not found on PATH"}`,
      `version: ${firstLine(version.stdout ?? "") || `unreadable (exit ${version.status})`}`,
      `stdout:\n${run.stdout ?? ""}`,
      `stderr:\n${run.stderr ?? ""}`,
    ].join("\n"),
  );
}
