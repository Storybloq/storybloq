/**
 * ISS-1107: shared fixtures for the board git-state tests. Imports only
 * modules that exist before ISS-1107, so a test file built on it runs (and
 * fails behaviourally) against the base tree.
 *
 * Every repository is a fresh temp directory. Git runs with no global or
 * system config and a fixed identity, so a developer's hooks, signing or
 * default branch never leak into a fixture.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { registerAllTools } from "../../src/mcp/tools.js";

const GIT_ENV_KEYS = [
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
] as const;

/** Isolates git for the test process; returns the restore function. */
export function isolateGit(): () => void {
  const saved = new Map<string, string | undefined>(GIT_ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_AUTHOR_NAME = "Fixture";
  process.env.GIT_AUTHOR_EMAIL = "fixture@example.invalid";
  process.env.GIT_COMMITTER_NAME = "Fixture";
  process.env.GIT_COMMITTER_EMAIL = "fixture@example.invalid";
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const made: string[] = [];

export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `iss1107-${prefix}-`)));
  made.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Runs git in `cwd`, returning stdout untrimmed. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

export function headSha(cwd: string): string {
  return git(cwd, "rev-parse", "HEAD").trim();
}

/** `git ls-files -s` lines, i.e. the full index. */
export function indexEntries(cwd: string): string[] {
  return git(cwd, "ls-files", "-s").split("\n").filter(Boolean);
}

/** Porcelain v1 rows for the whole worktree, untracked files listed individually. */
export function porcelain(cwd: string, ...pathspec: string[]): string[] {
  return git(cwd, "status", "--porcelain=v1", "-uall", ...(pathspec.length ? ["--", ...pathspec] : [])).split("\n").filter(Boolean);
}

/** Files changed by the HEAD commit (root commits included). */
export function headFiles(cwd: string): string[] {
  return git(cwd, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").filter(Boolean).sort();
}

export function installHook(repo: string, name: string, body: string): void {
  const dir = join(repo, ".git", "hooks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

export interface ProjectRepo {
  /** The repository top level. */
  readonly top: string;
  /** The project root (holds `.story/`); equals `top` unless nested. */
  readonly root: string;
}

/**
 * A git repository with an initialized storybloq project, committed on `main`.
 * `nested` places the project in a subdirectory of the repository.
 */
export async function makeProjectRepo(opts: { nested?: string; commit?: boolean; prefix?: string } = {}): Promise<ProjectRepo> {
  const top = tempDir(opts.prefix ?? "repo");
  git(top, "init", "-q", "-b", "main");
  const root = opts.nested ? join(top, opts.nested) : top;
  mkdirSync(root, { recursive: true });
  await initProject(root, { name: "fixture" });
  if (opts.commit !== false) {
    git(top, "add", "-A");
    git(top, "commit", "-q", "-m", "init");
  }
  return { top, root };
}

export interface ToolReply {
  readonly text: string;
  readonly isError: boolean;
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

export interface CapturedTools {
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>;
  readonly names: string[];
  readonly configs: Map<string, { inputSchema?: Record<string, unknown> }>;
}

/** Registers every MCP tool against a capturing fake server. */
export function captureTools(root: string): CapturedTools {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { inputSchema?: Record<string, unknown> }>();
  const server = {
    registerTool: (name: string, config: { inputSchema?: Record<string, unknown> }, handler: Handler) => {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return {
    names: [...handlers.keys()],
    configs,
    async call(name, args = {}) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`tool ${name} is not registered`);
      const result = await handler(args);
      return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
    },
  };
}

/** The `Git:` lines of a reply, in order. */
export function gitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("Git: "));
}

/** The `.story/` path of the single untracked file porcelain reports under `dir`. */
export function soleUntracked(cwd: string, dir: string): string {
  const rows = porcelain(cwd, dir).filter((row) => row.startsWith("?? "));
  if (rows.length !== 1) throw new Error(`expected one untracked file under ${dir}, got ${JSON.stringify(rows)}`);
  return rows[0]!.slice(3);
}

/** An orchestrator project (its own repo) with one node project in a separate repo. */
export async function makeFederation(opts: { initNode?: boolean } = {}): Promise<{ orch: string; node: string }> {
  const orch = tempDir("orch");
  git(orch, "init", "-q", "-b", "main");
  const story = join(orch, ".story");
  for (const dir of ["tickets", "issues", "handovers", "notes", "lessons"]) mkdirSync(join(story, dir), { recursive: true });
  // The ephemeral entries a real init writes (STORY_GITIGNORE_ENTRIES at base).
  writeFileSync(join(story, ".gitignore"), "snapshots/\nstatus.json\nsessions/\nspawn/\nfederation-cache.json\nchannel-inbox/\nservers/\n/telemetry/\ncache/\n");
  const node = tempDir("node");
  git(node, "init", "-q", "-b", "main");
  writeFileSync(join(node, "README.md"), "node\n");
  if (opts.initNode !== false) await initProject(node, { name: "api" });
  git(node, "add", "-A");
  git(node, "commit", "-q", "-m", "init");
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 2, project: "orchestrator", type: "orchestrator", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    nodes: { api: { path: node, health: "grey", dependsOn: [], stack: "", role: "", summary: "" } },
    federation: { allowNodeWrites: true },
  }, null, 2) + "\n");
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    version: 2, title: "Orchestrator Roadmap", date: "2026-01-01",
    phases: [{ id: "p0", label: "Phase 0", name: "Phase 0", description: "" }], blockers: [],
  }, null, 2) + "\n");
  git(orch, "add", "-A");
  git(orch, "commit", "-q", "-m", "init");
  return { orch, node };
}
