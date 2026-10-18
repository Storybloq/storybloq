/**
 * T-499: the transcript ACCESS CONTRACT, step 1 -- authorize before open.
 *
 * A transcript path can arrive from hook stdin, a presence-record hint, or a
 * CLI flag: all user-writable. Nothing here trusts a path; a candidate is
 * authorized only when its basename is exactly `<expectedSessionId>.jsonl`,
 * it is not itself a symlink, and its real path sits exactly one directory
 * below `~/.claude/projects/`. The expected session id is REQUIRED input:
 * there is no "whatever transcript is there" mode.
 *
 * Candidates are tried in a fixed order (presence hint, the cwd-encoded
 * directory, and, only where the caller allows it, a one-level glob), and the
 * first authorized one wins. The synchronous prompt hook never globs.
 */

import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SESSION_ID_PATTERN } from "../../presence/types.js";
import { claudeConfigDir } from "../claude-config-dir.js";

export type TranscriptLocateSource = "hint" | "cwd" | "glob";

export interface LocatedTranscript {
  /** The REAL path (symlinks in parents resolved) that was authorized. */
  readonly path: string;
  readonly source: TranscriptLocateSource;
}

export interface LocateRequest {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly hint: string | null;
  readonly allowGlob: boolean;
  /** Test seam; defaults to `~/.claude/projects`. */
  readonly projectsDir?: string;
}

export function defaultProjectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

/** Claude Code's project-directory encoding of a cwd: every non-alphanumeric byte becomes `-`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function isAuthorizableSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

/**
 * Null unless every rule holds. Returns the resolved real path, which is
 * what the reader then opens O_NOFOLLOW (the final component was already
 * proven not to be a link, so resolving parents does not reopen a swap race
 * at the leaf).
 */
export function authorizeTranscriptPath(
  candidate: string | null | undefined,
  expectedSessionId: string,
  projectsDir: string = defaultProjectsDir(),
): string | null {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) return null;
  if (!isAuthorizableSessionId(expectedSessionId)) return null;
  if (basename(candidate) !== `${expectedSessionId}.jsonl`) return null;
  let real: string;
  let projectsReal: string;
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    real = fs.realpathSync(candidate);
    projectsReal = fs.realpathSync(projectsDir);
  } catch {
    return null;
  }
  if (basename(real) !== `${expectedSessionId}.jsonl`) return null;
  // Exactly one level below the projects directory.
  if (resolve(dirname(dirname(real))) !== resolve(projectsReal)) return null;
  return real;
}

/**
 * ISS-1224: why `authorizeTranscriptPath` refused a candidate, as a sentence
 * naming the rule that failed, or null when the candidate is authorized. The
 * rules are checked in the same order as the authorizer, so the first
 * failure named is the one it stopped on. The candidate path is never
 * echoed: an explicit path outside the allowed root is exactly the value
 * the contract refused to read, and the caller already knows what it passed.
 */
export const REFUSAL_NO_SESSION_ID = "transcript refused: no session id given; pass --session-id or name the file <sessionId>.jsonl";
export const REFUSAL_NOT_A_FILE = "transcript refused: the path is not an existing regular file (a symlink, directory or absent path is never read)";
export const REFUSAL_OUTSIDE_PROJECTS = "transcript refused: it is not exactly one directory below the Claude projects directory (~/.claude/projects/<project>/<sessionId>.jsonl, or under $CLAUDE_CONFIG_DIR/projects when set)";
export const refusalBasename = (expectedSessionId: string): string => `transcript refused: its basename is not ${expectedSessionId}.jsonl`;

export function explainTranscriptRefusal(
  candidate: string | null | undefined,
  expectedSessionId: string,
  projectsDir: string = defaultProjectsDir(),
): string | null {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) return REFUSAL_NOT_A_FILE;
  if (!isAuthorizableSessionId(expectedSessionId)) return REFUSAL_NO_SESSION_ID;
  if (basename(candidate) !== `${expectedSessionId}.jsonl`) return refusalBasename(expectedSessionId);
  let real: string;
  let projectsReal: string;
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) return REFUSAL_NOT_A_FILE;
    real = fs.realpathSync(candidate);
    projectsReal = fs.realpathSync(projectsDir);
  } catch {
    return REFUSAL_NOT_A_FILE;
  }
  if (basename(real) !== `${expectedSessionId}.jsonl`) return refusalBasename(expectedSessionId);
  if (resolve(dirname(dirname(real))) !== resolve(projectsReal)) return REFUSAL_OUTSIDE_PROJECTS;
  return null;
}

export function locateTranscript(req: LocateRequest): LocatedTranscript | null {
  if (!isAuthorizableSessionId(req.sessionId)) return null;
  const projectsDir = req.projectsDir ?? defaultProjectsDir();
  const file = `${req.sessionId}.jsonl`;

  const fromHint = authorizeTranscriptPath(req.hint, req.sessionId, projectsDir);
  if (fromHint) return { path: fromHint, source: "hint" };

  if (req.cwd) {
    const fromCwd = authorizeTranscriptPath(join(projectsDir, encodeProjectDir(req.cwd), file), req.sessionId, projectsDir);
    if (fromCwd) return { path: fromCwd, source: "cwd" };
  }

  if (req.allowGlob) {
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const fromGlob = authorizeTranscriptPath(join(projectsDir, d.name, file), req.sessionId, projectsDir);
      if (fromGlob) return { path: fromGlob, source: "glob" };
    }
  }
  return null;
}
