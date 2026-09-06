import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { readSession, sessionDir } from "../../autonomous/session.js";
import { buildReviewContextPacket } from "../../autonomous/review-context-packet.js";

/**
 * Native codex's packet budget. Lower than the guide stages' because this
 * prompt is delivered on stdin to `codex exec` alongside a schema, and the
 * reviewer reads the diff from disk rather than from the prompt.
 */
const NATIVE_CONTEXT_PACKET_BUDGET = 16000;
import type { Finding, GuideReportInput, ReviewVerdict } from "../../autonomous/session-types.js";

export type CodexReviewKind = "plan" | "code";
export type CodexReviewFormat = "guide-report";

export interface CodexFinding {
  readonly severity: "critical" | "major" | "minor" | "suggestion" | "nitpick";
  readonly category?: string;
  readonly description?: string;
  readonly issue?: string;
  readonly file?: string | null;
  readonly line?: number | null;
  readonly suggestion?: string | null;
  readonly recommendedNextState?: "PLAN" | "IMPLEMENT";
  readonly origin?: string;
  readonly originClass?: string;
  readonly sinceRound?: number;
  readonly dispositionReason?: string;
}

interface CodexReviewOutput {
  // ISS-725: derive from the canonical ReviewVerdict so this never drifts from
  // REVIEW_VERDICTS. The per-kind PLAN_REVIEW_VERDICTS/CODE_REVIEW_VERDICTS sets
  // below are intentionally narrower (3 values each) and stay independent.
  readonly verdict: ReviewVerdict;
  readonly summary?: string;
  readonly findings?: readonly CodexFinding[];
}

export interface CodexReviewOptions {
  readonly kind: CodexReviewKind;
  readonly sessionId: string;
  readonly format?: CodexReviewFormat;
}

function reviewSchema(verdicts: readonly string[]): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "findings"],
    properties: {
      verdict: { type: "string", enum: verdicts },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "category", "description", "file", "line", "suggestion"],
          properties: {
            severity: { type: "string", enum: ["critical", "major", "minor", "suggestion", "nitpick"] },
            category: { type: "string" },
            description: { type: "string" },
            file: { anyOf: [{ type: "string" }, { type: "null" }] },
            line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
            suggestion: { anyOf: [{ type: "string" }, { type: "null" }] },
            recommendedNextState: { type: "string", enum: ["PLAN", "IMPLEMENT"] },
            // ISS-1115: provenance. This object is `additionalProperties:
            // false`, so without these four keys a native reviewer CANNOT EMIT
            // a provenance field even when the prompt asks for one, and the
            // laundering guard downstream would be protecting a field that
            // never arrives. Optional, so an older reviewer that omits them
            // still validates.
            //
            // `disposition` is deliberately NOT here. A reviewer REPORTS
            // findings; dispositioning them is a later decision by someone
            // else, and inviting a reviewer to mark its own finding
            // `addressed` would hand it the laundering route directly.
            origin: { type: "string", enum: ["introduced", "pre-existing"] },
            originClass: {
              type: "string",
              enum: ["new", "reintroduced", "unchanged", "introduced-by-fix"],
            },
            sinceRound: { type: "integer", minimum: 1 },
            dispositionReason: { type: "string" },
          },
        },
      },
    },
  };
}

const PLAN_REVIEW_VERDICTS = ["approve", "revise", "reject"] as const;
const CODE_REVIEW_VERDICTS = ["approve", "request_changes", "reject"] as const;

const PLAN_REVIEW_SCHEMA = reviewSchema(PLAN_REVIEW_VERDICTS);
const CODE_REVIEW_SCHEMA = reviewSchema(CODE_REVIEW_VERDICTS);

export function verdictsForKind(kind: CodexReviewKind): readonly string[] {
  return kind === "plan" ? PLAN_REVIEW_VERDICTS : CODE_REVIEW_VERDICTS;
}

export function schemaForKind(kind: CodexReviewKind): object {
  return kind === "plan" ? PLAN_REVIEW_SCHEMA : CODE_REVIEW_SCHEMA;
}

const CODEX_REVIEW_TIMEOUT_MS: Record<CodexReviewKind, number> = {
  plan: 5 * 60 * 1000,
  code: 10 * 60 * 1000,
};

function commandExists(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function formatExecError(command: string, args: string[], err: unknown): string {
  const details = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string; status?: number | null };
  const stderr = Buffer.isBuffer(details.stderr) ? details.stderr.toString("utf-8") : details.stderr;
  const stdout = Buffer.isBuffer(details.stdout) ? details.stdout.toString("utf-8") : details.stdout;
  const message = [stderr, stdout, details.message].filter(Boolean).join("\n").trim();
  const status = typeof details.status === "number" ? ` exited with status ${details.status}` : " failed";
  return `${command} ${args.join(" ")}${status}${message ? `: ${message.split("\n")[0]}` : ""}`;
}

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err: unknown) {
    throw new Error(formatExecError("git", args, err));
  }
}

function runGitDiffAllowExitOne(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: "pipe",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const details = err as { stdout?: Buffer | string; status?: number | null };
    if (details.status === 1) {
      const stdout = Buffer.isBuffer(details.stdout) ? details.stdout.toString("utf-8") : details.stdout;
      return stdout ?? "";
    }
    throw err;
  }
}

function isSafeRelativeGitPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}

export function buildCodeReviewDiffArtifact(root: string, diffBase: string): string {
  const diff = runGit(root, ["diff", diffBase]);
  const untrackedFiles = runGit(root, ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = [diff.trimEnd()].filter(Boolean);
  for (const file of untrackedFiles) {
    if (!isSafeRelativeGitPath(file)) {
      sections.push(`Untracked file skipped because it is not a safe relative path: ${file}`);
      continue;
    }
    const patch = runGitDiffAllowExitOne(root, ["diff", "--no-index", "--", "/dev/null", file]).trimEnd();
    sections.push(patch || `Untracked file with no textual diff: ${file}`);
  }

  const artifact = sections.join("\n\n");
  if (!artifact.trim()) {
    throw new Error(`No code diff found for review against ${diffBase}`);
  }
  return artifact + "\n";
}

/**
 * ISS-1115: the round context packet reaches the NATIVE route too.
 *
 * This route was missed entirely by the first three revisions of the plan,
 * which counted two reviewer routes and then three, while this one returns from
 * both stages BEFORE the packet insertion point. So a native codex reviewer
 * read every round cold, which is the exact failure ISS-1115 was filed about,
 * on the backend whose name is in the issue title.
 *
 * The packet arrives as a prefix rather than through a new channel because this
 * command already resolves the session directory from `--session`, so there is
 * nothing to plumb between processes. `context` is optional so the exported
 * prompt builders stay callable without one.
 */
export function planPrompt(sessionId: string, context?: string): string {
  return [
    ...(context ? [context, ""] : []),
    [
      "You are an independent Storybloq plan reviewer.",
      `Read .story/sessions/${sessionId}/plan.md and any referenced files.`,
      "Do not edit files.",
      "Review for correctness, scope, missing risks, feasibility, and testability.",
      "Return only JSON matching the provided schema.",
      "Use verdict approve, revise, or reject.",
      "If there are no blocking issues, return findings as an empty array.",
    ].join(" "),
  ].join("\n");
}

export function codePrompt(sessionId: string, context?: string): string {
  return [
    ...(context ? [context, ""] : []),
    [
      "You are an independent Storybloq code reviewer.",
      `Review the current ticket diff in .story/sessions/${sessionId}/review/diff.patch and the session artifacts under .story/sessions/${sessionId}/.`,
      "Do not edit files.",
      "Focus on bugs, regressions, security issues, missing tests, and behavior mismatches with the plan.",
      "Return only JSON matching the provided schema.",
      "Use verdict approve, request_changes, or reject.",
      "Include file and line when available.",
    ].join(" "),
  ].join("\n");
}

async function runCodexExec(
  root: string,
  prompt: string,
  schemaPath: string,
  outputPath: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("codex", [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "-C",
      root,
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
      "-",
    ], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      fn();
    };

    child.stdout.on("data", () => { /* drain */ });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      if (timedOut) {
        finish(() => reject(new Error(`codex exec timed out after ${Math.round(timeoutMs / 1000)} seconds`)));
      } else if (code === 0) {
        finish(() => resolve());
      } else {
        finish(() => reject(new Error(`codex exec exited with status ${code}: ${stderr.trim()}`)));
      }
    });
    child.stdin.end(prompt);
  });
}

export function normalizeFinding(finding: CodexFinding, index: number): Finding {
  const severity = finding.severity === "nitpick" ? "suggestion" : finding.severity;
  const location = finding.file
    ? `${finding.file}${finding.line ? `:${finding.line}` : ""}: `
    : "";
  const suggestion = finding.suggestion ? ` Suggestion: ${finding.suggestion}` : "";
  const description = finding.description ?? finding.issue ?? "Codex review finding";
  const result: Finding & { file?: string } = {
    id: `codex-${index + 1}`,
    severity,
    category: finding.category ?? "review",
    description: `${location}${description}${suggestion}`,
    // Still defaulted, and still the reviewer's finding is `open` until someone
    // dispositions it. The schema does not let a reviewer set this.
    disposition: "open",
    recommendedNextState: finding.recommendedNextState,
    // ISS-1115: provenance SURVIVES normalization. This function used to build
    // a fresh object and drop everything it did not name, so even a reviewer
    // that reported `originClass: "reintroduced"` had it discarded here, one
    // layer below the schema that would not have let it through anyway. Both
    // had to be fixed or neither was worth fixing.
    //
    // Copied only when present, so an absent label stays absent rather than
    // becoming a fabricated `new`, which D3 forbids: absent and unrecognised
    // are different claims and neither may be invented.
    ...(finding.origin === undefined ? {} : { origin: finding.origin }),
    ...(finding.originClass === undefined ? {} : { originClass: finding.originClass }),
    ...(finding.sinceRound === undefined ? {} : { sinceRound: finding.sinceRound }),
    ...(finding.dispositionReason === undefined
      ? {}
      : { dispositionReason: finding.dispositionReason }),
  };
  // ISS-598 codex round 2: `Finding` deliberately has no `file` property (see
  // tools.ts's report.findings schema comment), but this normalizer used to
  // fold the path into `description` and drop it entirely -- the ONE place a
  // native codex review's file citation existed. plan-review.ts's drift
  // detector reads `file` defensively off the raw object, so attaching it
  // here (never removing the folded-in text, which every other consumer
  // still reads) is what lets the detector's basename-only tokenization
  // engage on this path at all instead of only ever seeing the full path
  // embedded in prose.
  if (finding.file) result.file = finding.file;
  return result;
}

export async function handleCodexReview(options: CodexReviewOptions): Promise<GuideReportInput> {
  if (options.format && options.format !== "guide-report") {
    throw new Error(`Unsupported format: ${options.format}`);
  }
  if (!commandExists("codex")) {
    throw new Error("codex CLI is not available on PATH");
  }

  const root = discoverProjectRoot();
  if (!root) {
    throw new Error("No .story project found");
  }

  const dir = sessionDir(root, options.sessionId);
  const state = readSession(dir);
  if (!state) {
    throw new Error(`Session not found or invalid: ${options.sessionId}`);
  }

  const reviewDir = join(dir, "review");
  await mkdir(reviewDir, { recursive: true });
  const schemaPath = join(reviewDir, `${options.kind}-schema.json`);
  const promptPath = join(reviewDir, `${options.kind}-prompt.txt`);
  const outputPath = join(reviewDir, `${options.kind}-codex-output.json`);
  await writeFile(schemaPath, JSON.stringify(schemaForKind(options.kind), null, 2) + "\n", "utf-8");

  // The packet is built HERE, from the session directory this command already
  // resolved, and prefixed to the prompt. The capture directive names what this
  // reviewer actually reads, which differs by kind: the native route is told
  // where the file is rather than handed its bytes.
  const priorRounds = options.kind === "plan"
    ? (state.reviews?.plan?.length ?? 0)
    : (state.reviews?.code?.length ?? 0);
  const packet = buildReviewContextPacket({
    sessionDir: dir,
    projectRoot: root,
    target: state.ticket?.id ?? state.currentIssue?.id ?? "unknown",
    stage: options.kind,
    generation: state.itemAttempt?.generation ?? 0,
    roundNum: priorRounds + 1,
    budget: NATIVE_CONTEXT_PACKET_BUDGET,
    captureDirective: options.kind === "plan"
      ? `Read the plan at .story/sessions/${options.sessionId}/plan.md in full.`
      : `Read the diff at .story/sessions/${options.sessionId}/review/diff.patch in full.`,
    planReviews: state.reviews?.plan,
  });
  const prompt = options.kind === "plan"
    ? planPrompt(options.sessionId, packet.text)
    : codePrompt(options.sessionId, packet.text);
  await writeFile(promptPath, prompt + "\n", "utf-8");

  if (options.kind === "plan") {
    const planPath = join(dir, "plan.md");
    if (!existsSync(planPath)) throw new Error(`Plan file not found: ${planPath}`);
  } else {
    const diffBase = state.git.mergeBase ?? "HEAD";
    await writeFile(
      join(reviewDir, "diff.patch"),
      buildCodeReviewDiffArtifact(root, diffBase),
      "utf-8",
    );
  }

  await runCodexExec(root, prompt, schemaPath, outputPath, CODEX_REVIEW_TIMEOUT_MS[options.kind]);
  const raw = await readFile(outputPath, "utf-8");
  let parsed: CodexReviewOutput;
  try {
    parsed = JSON.parse(raw) as CodexReviewOutput;
  } catch {
    throw new Error("Codex output was not valid JSON");
  }

  if (!verdictsForKind(options.kind).includes(parsed.verdict)) {
    throw new Error("Codex output did not include a valid verdict");
  }

  return {
    completedAction: options.kind === "plan" ? "plan_review_round" : "code_review_round",
    verdict: parsed.verdict,
    findings: (parsed.findings ?? []).map(normalizeFinding),
    reviewer: "codex",
    notes: [`route=native`, parsed.summary ?? ""].filter(Boolean).join("; "),
  };
}
