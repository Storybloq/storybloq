/**
 * T-536: the two reviewers the setup review starts itself, codex and claude.
 * Each runs without tools, without project access and without a saved session,
 * answers against SETUP_REVIEW_SCHEMA, and has its raw answer kept byte for
 * byte so the record can be checked against it later.
 */
import { execFile, spawn } from "node:child_process";

export type SetupReviewBackend = "codex" | "claude";
export const SETUP_REVIEW_BACKENDS: readonly SetupReviewBackend[] = ["codex", "claude"];

const VERDICTS: string[] = ["approve", "revise", "reject"];
const SEVERITIES: string[] = ["critical", "major", "minor", "suggestion"];

export const SETUP_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          requirement: { type: "string" },
          description: { type: "string" },
        },
        required: ["severity", "requirement", "description"],
      },
    },
  },
  required: ["verdict", "findings"],
};

export interface SetupReviewFinding {
  readonly severity: string;
  readonly requirement: string;
  readonly description: string;
}

export interface SetupReviewAnswer {
  readonly verdict: "approve" | "revise" | "reject";
  readonly findings: SetupReviewFinding[];
  readonly sessionId?: string;
}

export function codexArgs(schemaFile: string, outFile: string): string[] {
  return ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--output-schema", schemaFile, "-o", outFile, "-"];
}

export function claudeArgs(schemaJson: string): string[] {
  return ["-p", "--output-format", "json", "--json-schema", schemaJson, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none"];
}

/**
 * A claude reviewer started from inside Claude Code would otherwise inherit the
 * parent session's markers; the reviewer must be its own, unattached session.
 */
export function reviewerEnv(backend: SetupReviewBackend, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (backend !== "claude") return env;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  return out;
}

function validateAnswer(value: unknown): SetupReviewAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reviewer answer is not an object");
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.some((k) => k !== "verdict" && k !== "findings")) throw new Error("reviewer answer has fields outside the schema");
  if (!VERDICTS.includes(v.verdict as string)) throw new Error("reviewer verdict is outside the schema");
  if (!Array.isArray(v.findings)) throw new Error("reviewer findings is not a list");
  const findings = v.findings.map((f): SetupReviewFinding => {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("reviewer finding is not an object");
    const r = f as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== "severity" && k !== "requirement" && k !== "description")) throw new Error("reviewer finding has fields outside the schema");
    if (!SEVERITIES.includes(r.severity as string) || typeof r.requirement !== "string" || typeof r.description !== "string") {
      throw new Error("reviewer finding is outside the schema");
    }
    return { severity: r.severity as string, requirement: r.requirement, description: r.description };
  });
  return { verdict: v.verdict as SetupReviewAnswer["verdict"], findings };
}

/**
 * The raw answer as the backend produced it: codex writes the schema object to
 * its -o file, claude prints a result envelope whose structured_output carries
 * it. Anything outside the schema throws.
 */
export function parseReviewerOutput(backend: SetupReviewBackend, raw: Buffer): SetupReviewAnswer {
  const parsed: unknown = JSON.parse(raw.toString("utf-8"));
  if (backend === "codex") return validateAnswer(parsed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("claude output is not a result object");
  const envelope = parsed as Record<string, unknown>;
  if (envelope.is_error !== false) throw new Error("claude reported an error");
  if (!("structured_output" in envelope)) throw new Error("claude returned no structured output");
  const answer = validateAnswer(envelope.structured_output);
  return typeof envelope.session_id === "string" ? { ...answer, sessionId: envelope.session_id } : answer;
}

export const PROBE_TIMEOUT_MS = 5000;

function runProbe(backend: SetupReviewBackend, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(backend, args, { env: reviewerEnv(backend, env), timeout: PROBE_TIMEOUT_MS, encoding: "utf-8" }, (err, stdout) => resolve(err ? null : stdout));
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

/**
 * The backend can start a review: `--version` exits 0 within the probe
 * timeout, and for claude, `--help` lists every flag the review passes. An
 * older claude that lacks one would pass a version probe and then fail the
 * review itself; it takes the unavailable path instead.
 */
export async function probeBackend(backend: SetupReviewBackend, env: NodeJS.ProcessEnv): Promise<string | null> {
  const stdout = await runProbe(backend, ["--version"], env);
  if (stdout === null) return null;
  if (backend === "claude") {
    const help = await runProbe(backend, ["--help"], env);
    if (help === null || !claudeArgs("{}").filter((a) => a.startsWith("--")).every((flag) => help.includes(flag))) return null;
  }
  const version = stdout.trim().split("\n")[0]?.trim();
  return version ? version : "unknown version";
}

export interface ReviewerRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly spawnError: string | null;
}

/** Starts the reviewer with the prompt on stdin; SIGTERM at the timeout, SIGKILL five seconds later. */
export function runReviewer(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<ReviewerRun> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ exitCode: null, timedOut: false, stdout: Buffer.alloc(0), stderr: "", spawnError: (e as Error).message });
      return;
    }
    const out: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, opts.timeoutMs);
    const finish = (r: ReviewerRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(r);
    };
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.stdin.on("error", () => { /* a reviewer that exits before reading its prompt fails below */ });
    child.on("error", (e) => finish({ exitCode: null, timedOut, stdout: Buffer.concat(out), stderr, spawnError: e.message }));
    child.on("close", (code) => finish({ exitCode: code, timedOut, stdout: Buffer.concat(out), stderr, spawnError: null }));
    child.stdin.end(opts.input);
  });
}
