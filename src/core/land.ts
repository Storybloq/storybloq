/**
 * ISS-1432: `storybloq land <sha>` puts exactly one reviewed commit on top of
 * a remote branch, or refuses and names the check that failed.
 *
 * Steps, in order, each refusing at its first failure:
 *   0 preflight     repository, replace objects, partial clone, branch name,
 *                   pinned destination, commit, receipt item
 *   1 fast-forward  the commit is exactly one commit on the remote tip
 *   2 trailers      no attribution trailers in the message
 *   3 hygiene       no home paths, private IPv4 or socket paths in added
 *                   lines; changed .story JSON parses and is a regular file
 *   4 secrets       gitleaks over the range (or skipped by flag)
 *   5 push          a compare-and-swap on the tip read in step 1
 *   6 verify        the remote branch now equals the commit
 *   7 receipt       with an item, a landing receipt on the board
 *
 * It never writes the index, the working tree, the object store or a ref of
 * the repository it lands from. Every subprocess runs through one injectable
 * runner under a sanitised environment, so the parent environment can never
 * select the repository or redirect the push.
 */
import { execFile } from "node:child_process";
import { access, constants as fsConstants, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { issueFilePath, loadProjectNoRecover, ticketFilePath, transactionJournalPresent, PENDING_JOURNAL_MESSAGE } from "./project-loader.js";
import { resolveAndNormalizeIssueRef, resolveAndNormalizeTicketRef, RefResolutionError } from "./ref-normalization.js";
import { displayIdOf } from "./resolver.js";

export type LandStep = "preflight" | "fast-forward" | "trailers" | "hygiene" | "secrets" | "push" | "verify" | "receipt";
export type LandStepOutcome = "passed" | "skipped" | "held";

export const LAND_STEPS: readonly LandStep[] = ["preflight", "fast-forward", "trailers", "hygiene", "secrets", "push", "verify", "receipt"];

export interface LandStepRecord {
  readonly step: LandStep;
  readonly number: number;
  readonly outcome: LandStepOutcome;
  readonly detail?: string;
}

export interface LandReceiptEntry {
  readonly sha: string;
  readonly remote: string;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly priorTip: string;
  readonly landedAt: string;
  readonly steps: { step: LandStep; outcome: LandStepOutcome }[];
}

export type LandReceipt =
  | { status: "not-requested" }
  | { status: "not-attempted"; item: string; reason: string }
  | { status: "written"; item: string; entry: LandReceiptEntry }
  | { status: "failed"; item: string; error: string };

export interface LandResult {
  status: "landed" | "held";
  sha: string;
  repo: string | null;
  boardRoot: string | null;
  remote: string;
  remoteUrl: string | null;
  branch: string;
  priorTip: string | null;
  steps: LandStepRecord[];
  held?: { step: LandStep; number: number; reason: string; outcomeUnknown: boolean };
  receipt: LandReceipt;
  /** "git report unavailable: <message>" when the CLI report step threw. */
  gitReport?: string;
}

export interface RunRequest {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

export type RunResult =
  | { kind: "exit"; code: number; stdout: Buffer; stderr: string }
  | { kind: "failed"; reason: "timeout" | "signal" | "overflow" | "spawn" | "decode"; detail: string; stdout?: Buffer; stderr?: string };

export type Runner = (req: RunRequest) => Promise<RunResult>;

export type LandItemKind = "ticket" | "issue";

export interface LandItemTarget {
  readonly kind: LandItemKind;
  readonly id: string;
  readonly displayId: string;
  readonly path: string;
}

/** Writes one receipt; throws on any failure. */
export type ReceiptWriter = (boardRoot: string, target: LandItemTarget, entry: LandReceiptEntry) => Promise<void>;

export interface LandHooks {
  /** Test seam: runs after step 0 passed. */
  readonly afterPreflight?: () => Promise<void> | void;
  /** Test seam: runs after step 4 passed, before the push. */
  readonly beforePush?: () => Promise<void> | void;
  /** Test seam: runs after step 6 passed, before the receipt. */
  readonly afterVerify?: () => Promise<void> | void;
}

export interface LandOptions {
  readonly sha: string;
  readonly repo: string;
  readonly remote: string;
  readonly branch: string;
  /** Board root for the receipt; null when no project was found. */
  readonly boardRoot: string | null;
  /** Why board discovery failed; with an item it holds the landing at preflight. */
  readonly boardError?: string;
  readonly item?: string;
  readonly secretsScan: boolean;
  /** Extra trailer patterns (added to the defaults, never replacing them). */
  readonly trailerPatterns?: readonly string[];
  /** Extra hygiene patterns as `name=regex` (added to the defaults). */
  readonly hygienePatterns?: readonly string[];
  /** gitleaks binary; when absent it is looked up on the sanitised PATH. */
  readonly gitleaksPath?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly clock?: () => Date;
  readonly runner?: Runner;
  readonly writeReceipt?: ReceiptWriter;
  readonly hooks?: LandHooks;
}

export const LAND_MAX_BUFFER = 10 * 1024 * 1024;
const LOCAL_TIMEOUT_MS = 10_000;
const NETWORK_TIMEOUT_MS = 30_000;
const GITLEAKS_TIMEOUT_MS = 120_000;

/** Kept from the parent environment; everything else is dropped. */
export const LAND_ENV_KEEP = ["PATH", "HOME", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "TMPDIR", "USER", "LOGNAME", "LANG"] as const;

/** Set on every git and gitleaks call. */
export const LAND_ENV_SET: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
};

/** The sanitised environment every git and gitleaks call runs under. */
export function landEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LAND_ENV_KEEP) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...LAND_ENV_SET };
}

/** The default runner: execFile with an explicit buffer and timeout; never throws. */
export const defaultRunner: Runner = (req) =>
  new Promise((resolvePromise) => {
    try {
      execFile(
        req.cmd,
        [...req.args],
        { cwd: req.cwd, env: req.env, timeout: req.timeoutMs, maxBuffer: LAND_MAX_BUFFER, encoding: "buffer", killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
          const errText = Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : String(stderr ?? "");
          if (!err) {
            resolvePromise({ kind: "exit", code: 0, stdout: out, stderr: errText });
            return;
          }
          const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string | null };
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolvePromise({ kind: "failed", reason: "overflow", detail: "output exceeded 10 MB", stdout: out, stderr: errText });
          } else if (typeof e.code === "number") {
            resolvePromise({ kind: "exit", code: e.code, stdout: out, stderr: errText });
          } else if (e.killed) {
            resolvePromise({ kind: "failed", reason: "timeout", detail: `timed out after ${req.timeoutMs} ms`, stdout: out, stderr: errText });
          } else if (e.signal) {
            resolvePromise({ kind: "failed", reason: "signal", detail: `killed by ${e.signal}`, stdout: out, stderr: errText });
          } else {
            resolvePromise({ kind: "failed", reason: "spawn", detail: String(e.code ?? e.message) });
          }
        },
      );
    } catch (err) {
      resolvePromise({ kind: "failed", reason: "spawn", detail: (err as Error).message });
    }
  });

class Held extends Error {
  constructor(
    readonly step: LandStep,
    readonly reason: string,
    readonly outcomeUnknown = false,
  ) {
    super(reason);
  }
}

const STEP_NUMBER: Record<LandStep, number> = {
  preflight: 0, "fast-forward": 1, trailers: 2, hygiene: 3, secrets: 4, push: 5, verify: 6, receipt: 7,
};

/** Default trailer patterns: any co-author and the Claude session marker. */
export const DEFAULT_TRAILER_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: "co-authored-by", re: /^\s*co-authored-by\s*:/i },
  { name: "claude-session", re: /^\s*claude-session\s*:/i },
];

interface HygienePattern {
  readonly name: string;
  readonly test: (line: string) => boolean;
}

const HOME_PATH = /\/(?:Users|home)\/[^/\r\n]+/;
const SOCKET_PATH = /\/[^/\s]*\.sock(?![A-Za-z0-9_.\-])/;
const IPV4_CANDIDATE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g;

/** True when the line holds an RFC 1918 IPv4 address with valid octets. */
export function hasPrivateIpv4(line: string): boolean {
  for (const m of line.matchAll(IPV4_CANDIDATE)) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) continue;
    const [a, b] = o as [number, number, number, number];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export const DEFAULT_HYGIENE_PATTERNS: readonly HygienePattern[] = [
  { name: "home path", test: (line) => HOME_PATH.test(line) },
  { name: "private IPv4", test: hasPrivateIpv4 },
  { name: "socket path", test: (line) => SOCKET_PATH.test(line) },
];

const SHA_LINE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

function decodeUtf8(buf: Buffer, step: LandStep, what: string, fatal = true): string {
  try {
    return new TextDecoder("utf-8", { fatal }).decode(buf);
  } catch {
    throw new Held(step, `${what}: output is not valid UTF-8`);
  }
}

/** Decodes a C-quoted git path (`"a \"q\".txt"`, octal escapes as UTF-8 bytes). */
export function unquoteGitPath(raw: string): string | null {
  if (!raw.startsWith("\"")) return raw;
  if (!raw.endsWith("\"") || raw.length < 2) return null;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf-8"));
      continue;
    }
    const next = body[++i];
    if (next === undefined) return null;
    const simple: Record<string, number> = { "\\": 0x5c, "\"": 0x22, t: 0x09, n: 0x0a, r: 0x0d, a: 0x07, b: 0x08, f: 0x0c, v: 0x0b };
    if (next in simple) {
      bytes.push(simple[next]!);
    } else if (/[0-7]/.test(next)) {
      const oct = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString("utf-8");
}

const HEADER_PREFIXES = [
  "index ", "old mode ", "new mode ", "deleted file mode ", "new file mode ", "similarity index ",
  "dissimilarity index ", "rename from ", "rename to ", "copy from ", "copy to ", "Binary files ", "--- ",
];

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Scans the added lines of a `--unified=0` diff with fixed prefixes and
 * indicators. Fails closed: any line it does not recognise is a refusal.
 * Returns the first match as "<path>:<line> <pattern name>", or null.
 */
export function scanAddedLines(diff: string, patterns: readonly HygienePattern[]): string | null {
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let state: "none" | "header" | "hunk" = "none";
  let path: string | null = null;
  let newLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = i + 1;
    if (line.startsWith("diff --git ")) {
      state = "header";
      path = null;
      continue;
    }
    if (state === "none") throw new Held("hygiene", `unrecognised diff output at line ${at}`);
    if (line.startsWith("@@")) {
      const m = HUNK_HEADER.exec(line);
      if (!m) throw new Held("hygiene", `unrecognised diff output at line ${at}`);
      newLine = Number(m[1]);
      state = "hunk";
      continue;
    }
    if (state === "header") {
      if (line.startsWith("+++ ")) {
        // git appends a tab to a ---/+++ name that contains a space
        const v = line.slice(4).replace(/\t$/, "");
        if (v === "/dev/null") {
          path = null;
          continue;
        }
        const unq = unquoteGitPath(v);
        if (unq === null || !unq.startsWith("b/")) throw new Held("hygiene", `unrecognised diff output at line ${at}`);
        path = unq.slice(2);
        continue;
      }
      if (HEADER_PREFIXES.some((p) => line.startsWith(p))) continue;
      throw new Held("hygiene", `unrecognised diff output at line ${at}`);
    }
    // hunk state
    const indicator = line[0];
    if (indicator === "+") {
      const content = line.slice(1);
      for (const p of patterns) {
        if (p.test(content)) return `${path ?? "(unknown)"}:${newLine} ${p.name}`;
      }
      newLine++;
    } else if (indicator === " ") {
      newLine++;
    } else if (indicator === "-" || indicator === "\\") {
      // removed line or "\ No newline at end of file"
    } else {
      throw new Held("hygiene", `unrecognised diff output at line ${at}`);
    }
  }
  return null;
}

/**
 * True for a URL whose userinfo carries a secret: any password, or any userinfo
 * on a non-ssh scheme (where a bare userinfo is a token). Plain ssh user@host
 * forms, scp-like or ssh://, stay allowed.
 */
function carriesCredentials(u: string): boolean {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)@/.exec(u);
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  const userinfo = m[2]!;
  if (userinfo.includes(":")) return true;
  return !/^(ssh|git\+ssh|ssh\+git)$/.test(scheme);
}

function isUrlLike(u: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(u)) return true;
  // scp-like [user@]host:path, where no slash comes before the first colon
  const colon = u.indexOf(":");
  if (colon <= 0) return false;
  const slash = u.indexOf("/");
  return slash === -1 || colon < slash;
}

async function findOnPath(name: string, pathVar: string | undefined): Promise<string | null> {
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** Runs `storybloq land`. Never throws for a gate failure; returns HELD instead. */
export async function land(opts: LandOptions): Promise<LandResult> {
  const runner = opts.runner ?? defaultRunner;
  const env = landEnv(opts.baseEnv ?? process.env);
  const clock = opts.clock ?? (() => new Date());
  const steps: LandStepRecord[] = [];
  const result: LandResult = {
    status: "held",
    sha: opts.sha,
    repo: null,
    boardRoot: opts.boardRoot,
    remote: opts.remote,
    remoteUrl: null,
    branch: opts.branch,
    priorTip: null,
    steps,
    receipt: { status: "not-requested" },
  };
  let current: LandStep = "preflight";
  let top = "";
  let gitDir = "";

  const run = (cmd: string, args: readonly string[], cwd: string, timeoutMs: number) => runner({ cmd, args, cwd, env, timeoutMs });
  const git = (args: readonly string[], timeoutMs = LOCAL_TIMEOUT_MS) =>
    run("git", ["--git-dir", gitDir, "--work-tree", top, ...args], top, timeoutMs);
  /** A gate call: any runner failure or a nonzero exit outside `okCodes` refuses. */
  const need = async (what: string, r: Promise<RunResult>, okCodes: readonly number[] = [0]): Promise<{ code: number; stdout: Buffer; stderr: string }> => {
    const res = await r;
    if (res.kind === "failed") {
      throw new Held(current, res.reason === "timeout" ? `${what} timed out` : `${what} failed (${res.reason}): ${res.detail}`);
    }
    if (!okCodes.includes(res.code)) {
      throw new Held(current, `${what} failed: ${firstLine(res.stderr) || `exit ${res.code}`}`);
    }
    return res;
  };
  const pass = (step: LandStep, outcome: LandStepOutcome = "passed", detail?: string) => {
    steps.push({ step, number: STEP_NUMBER[step], outcome, ...(detail ? { detail } : {}) });
  };

  let target: LandItemTarget | null = null;
  let tip = "";
  let destination = "";

  try {
    // ---- step 0: preflight -------------------------------------------------
    current = "preflight";
    const trailerPatterns = [...DEFAULT_TRAILER_PATTERNS];
    for (const [i, src] of (opts.trailerPatterns ?? []).entries()) {
      // An empty regex matches everything; refuse it by name rather than let it hold every commit.
      if (src === "") throw new Held("preflight", `invalid pattern trailer-pattern ${i + 1}: empty`);
      try {
        trailerPatterns.push({ name: `trailer-pattern ${i + 1}`, re: new RegExp(src, "i") });
      } catch (err) {
        throw new Held("preflight", `invalid pattern trailer-pattern ${i + 1}: ${(err as Error).message}`);
      }
    }
    const hygienePatterns: HygienePattern[] = [...DEFAULT_HYGIENE_PATTERNS];
    for (const [i, spec] of (opts.hygienePatterns ?? []).entries()) {
      if (spec === "") throw new Held("preflight", `invalid pattern hygiene-pattern ${i + 1}: empty`);
      const eq = spec.indexOf("=");
      const name = eq > 0 ? spec.slice(0, eq) : spec;
      if (eq <= 0) throw new Held("preflight", `invalid pattern ${name}: expected name=regex`);
      if (eq === spec.length - 1) throw new Held("preflight", `invalid pattern ${name}: empty regex`);
      try {
        const re = new RegExp(spec.slice(eq + 1));
        hygienePatterns.push({ name, test: (line) => re.test(line) });
      } catch (err) {
        throw new Held("preflight", `invalid pattern ${name}: ${(err as Error).message}`);
      }
    }

    const repoArg = resolve(opts.repo);
    const discovery = await runner({
      cmd: "git",
      args: ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
      cwd: repoArg,
      env,
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    if (discovery.kind === "failed") {
      if (discovery.reason === "spawn") throw new Held("preflight", `repository ${repoArg} could not be opened: ${discovery.detail}`);
      throw new Held("preflight", discovery.reason === "timeout" ? "repository discovery timed out" : `repository discovery failed (${discovery.reason}): ${discovery.detail}`);
    }
    if (discovery.code !== 0) {
      const bare = await runner({ cmd: "git", args: ["rev-parse", "--is-bare-repository"], cwd: repoArg, env, timeoutMs: LOCAL_TIMEOUT_MS });
      if (bare.kind === "exit" && bare.code === 0 && bare.stdout.toString("utf-8").trim() === "true") {
        throw new Held("preflight", "not a working repository");
      }
      throw new Held("preflight", `not a git repository: ${firstLine(discovery.stderr)}`);
    }
    const [topRaw, gitDirRaw, commonRaw] = decodeUtf8(discovery.stdout, "preflight", "repository discovery").split("\n");
    if (!topRaw || !gitDirRaw || !commonRaw) throw new Held("preflight", "repository discovery returned unexpected output");
    top = await realpath(topRaw);
    const gitDirReal = await realpath(gitDirRaw);
    const commonReal = await realpath(commonRaw);
    if (gitDirReal !== commonReal) throw new Held("preflight", "linked worktree: land from the main checkout or a standalone clone");
    gitDir = gitDirReal;
    result.repo = top;

    let graftsPresent = true;
    try {
      await stat(join(commonReal, "info", "grafts"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") graftsPresent = false;
      else throw new Held("preflight", `could not probe info/grafts: ${(err as Error).message}`);
    }
    const replaceRefs = await need("for-each-ref refs/replace/", git(["for-each-ref", "refs/replace/"]));
    if (graftsPresent || replaceRefs.stdout.toString("utf-8").trim() !== "") {
      throw new Held("preflight", "replacement refs or grafts present");
    }

    const partial = await need("config extensions.partialclone", git(["config", "--get", "extensions.partialclone"]), [0, 1]);
    const promisor = await need("config remote promisor", git(["config", "--type=bool", "--get-regexp", "^remote\\..*\\.promisor$"]), [0, 1]);
    const promisorOn = promisor.code === 0 && promisor.stdout.toString("utf-8").split("\n").some((l) => l.trim().endsWith(" true"));
    if (partial.code === 0 || promisorOn) throw new Held("preflight", "partial clone: land from a full clone");

    const refOk = await need("check-ref-format", git(["check-ref-format", `refs/heads/${opts.branch}`]), [0, 1]);
    if (refOk.code !== 0 || opts.branch.length === 0) throw new Held("preflight", `invalid branch name ${opts.branch}`);

    const remotes = (await need("remote", git(["remote"]))).stdout.toString("utf-8").split("\n").map((l) => l.trim()).filter(Boolean);
    // The configured values, NUL-delimited: never split on newline, never trimmed,
    // and an empty value is kept so it is refused rather than dropped.
    const configValues = async (key: string): Promise<string[]> => {
      const res = await need(`config ${key}`, git(["config", "-z", "--get-all", `remote.${opts.remote}.${key}`]), [0, 1]);
      if (res.code !== 0) return [];
      const values = res.stdout.toString("utf-8").split("\0");
      if (values[values.length - 1] === "") values.pop();
      return values;
    };
    const fetchUrls = await configValues("url");
    if (fetchUrls.length === 0 || !remotes.includes(opts.remote)) throw new Held("preflight", `remote ${opts.remote} not found`);
    const configuredPush = await configValues("pushurl");
    const pushUrls = configuredPush.length > 0 ? configuredPush : fetchUrls;
    // Every value is checked before any comparison or any message that would echo it.
    for (const u of [...fetchUrls, ...configuredPush]) {
      if (u.includes("\n") || u.includes("\0")) throw new Held("preflight", `remote ${opts.remote} URL contains a newline or NUL`);
      if (u === "") throw new Held("preflight", `remote ${opts.remote} has an empty URL`);
      if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(u)) throw new Held("preflight", `remote ${opts.remote} URL uses a transport helper`);
      if (carriesCredentials(u)) throw new Held("preflight", `remote ${opts.remote} URL carries credentials; use a credential helper`);
    }
    const rawUrl = fetchUrls[0]!;
    if (pushUrls.length !== 1) throw new Held("preflight", `remote ${opts.remote} has ${pushUrls.length} push URLs`);
    if (pushUrls[0] !== rawUrl) throw new Held("preflight", "push URL differs from fetch URL");
    if (remotes.includes(rawUrl)) throw new Held("preflight", `destination ${rawUrl} collides with remote name`);
    if (rawUrl.startsWith("-")) throw new Held("preflight", `destination ${rawUrl} begins with "-"`);
    if (isUrlLike(rawUrl)) {
      destination = rawUrl;
    } else {
      try {
        destination = await realpath(isAbsolute(rawUrl) ? rawUrl : resolve(top, rawUrl));
      } catch {
        throw new Held("preflight", `destination ${rawUrl} not found`);
      }
      if (remotes.includes(destination)) throw new Held("preflight", `destination ${destination} collides with remote name`);
    }
    // NUL-delimited records ("key\nvalue\0") so a key whose URL subsection holds a
    // space parses whole; an empty prefix matches every destination, as git applies it.
    const rewrites = await need("config url rewrites", git(["config", "-z", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"]), [0, 1]);
    if (rewrites.code === 0) {
      const records = rewrites.stdout.toString("utf-8").split("\0");
      if (records[records.length - 1] === "") records.pop();
      for (const record of records) {
        const nl = record.indexOf("\n");
        const prefix = nl >= 0 ? record.slice(nl + 1) : "";
        if (rawUrl.startsWith(prefix) || destination.startsWith(prefix)) throw new Held("preflight", `url rewrite configured for ${destination}`);
      }
    }
    result.remoteUrl = destination;

    const resolved = await need("rev-parse", git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${opts.sha}^{commit}`]), [0, 1, 128]);
    const full = resolved.stdout.toString("utf-8").trim();
    if (resolved.code !== 0 || !SHA_LINE.test(full)) throw new Held("preflight", `${opts.sha} does not resolve to a commit`);
    result.sha = full;

    if (opts.item !== undefined) {
      if (opts.boardError !== undefined) throw new Held("preflight", `board could not be discovered: ${opts.boardError}`);
      if (!opts.boardRoot) throw new Held("preflight", "no storybloq project found for --item");
      let journal: boolean;
      try {
        journal = await transactionJournalPresent(join(opts.boardRoot, ".story"));
      } catch (err) {
        throw new Held("preflight", (err as Error).message);
      }
      if (journal) throw new Held("preflight", PENDING_JOURNAL_MESSAGE);
      let kind: LandItemKind;
      if (/^T-/.test(opts.item) || /^t-/.test(opts.item)) kind = "ticket";
      else if (/^ISS-/.test(opts.item) || /^i-/.test(opts.item)) kind = "issue";
      else throw new Held("preflight", "item must be a ticket or an issue");
      let loaded;
      try {
        loaded = await loadProjectNoRecover(opts.boardRoot);
      } catch (err) {
        throw new Held("preflight", `board could not be read: ${(err as Error).message}`);
      }
      let id: string;
      try {
        id = kind === "ticket" ? resolveAndNormalizeTicketRef(loaded.state, opts.item) : resolveAndNormalizeIssueRef(loaded.state, opts.item);
      } catch (err) {
        if (err instanceof RefResolutionError && err.reason === "ambiguous") throw new Held("preflight", `item ${opts.item} is ambiguous`);
        throw new Held("preflight", `item ${opts.item} not found`);
      }
      const record = kind === "ticket" ? loaded.state.ticketByID(id) : loaded.state.issueByID(id);
      if (!record) throw new Held("preflight", `item ${opts.item} not found`);
      target = {
        kind,
        id: record.id,
        displayId: displayIdOf(record),
        path: kind === "ticket" ? ticketFilePath(opts.boardRoot, record.id) : issueFilePath(opts.boardRoot, record.id),
      };
    }
    pass("preflight");
    await opts.hooks?.afterPreflight?.();

    // ---- step 1: fast-forward, exactly one commit --------------------------
    current = "fast-forward";
    const remoteRef = `refs/heads/${opts.branch}`;
    const readTip = async (stepUnknown: boolean): Promise<string | null> => {
      const ls = await git(["ls-remote", destination, remoteRef], NETWORK_TIMEOUT_MS);
      if (ls.kind === "failed") {
        throw new Held(current, ls.reason === "timeout" ? (stepUnknown ? "" : "ls-remote timed out") : `ls-remote failed (${ls.reason}): ${ls.detail}`, stepUnknown);
      }
      if (ls.code !== 0) throw new Held(current, stepUnknown ? "" : `ls-remote failed: ${firstLine(ls.stderr) || `exit ${ls.code}`}`, stepUnknown);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(ls.stdout);
      const lines = text.split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) return null;
      const m = lines.length === 1 ? /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(.+)$/.exec(lines[0]!) : null;
      if (!m || m[2] !== remoteRef) throw new Held(current, stepUnknown ? "" : "unexpected ls-remote output", stepUnknown);
      return m[1]!;
    };
    const t = await readTip(false);
    if (t === null) throw new Held("fast-forward", `branch ${opts.branch} does not exist at ${destination}`);
    tip = t;
    result.priorTip = tip;
    if (tip === result.sha) throw new Held("fast-forward", `already on ${destination} ${opts.branch}`);
    const known = await need("cat-file", git(["cat-file", "-e", `${tip}^{commit}`]), [0, 1, 128]);
    if (known.code !== 0) throw new Held("fast-forward", `${destination} ${opts.branch} is at ${tip}, which this clone lacks; fetch first`);
    const parentsOut = (await need("rev-list --parents", git(["rev-list", "--parents", "-n", "1", result.sha]))).stdout.toString("utf-8").trim().split(/\s+/);
    const parents = parentsOut.slice(1);
    if (parents.length !== 1 || parents[0] !== tip) {
      throw new Held("fast-forward", `${result.sha} is not exactly one commit on top of ${destination} ${opts.branch} (${tip}); parents: ${parents.join(" ") || "none"}`);
    }
    pass("fast-forward");

    // ---- step 2: trailers --------------------------------------------------
    current = "trailers";
    const message = decodeUtf8((await need("log", git(["log", "-1", "--format=%B", result.sha]))).stdout, "trailers", "commit message");
    for (const line of message.split("\n")) {
      for (const p of trailerPatterns) {
        if (p.re.test(line)) throw new Held("trailers", `${result.sha.slice(0, 12)} carries "${line.trimEnd()}"`);
      }
    }
    pass("trailers");

    // ---- step 3: hygiene ---------------------------------------------------
    current = "hygiene";
    const diff = await need("diff", git([
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0",
      "--src-prefix=a/", "--dst-prefix=b/", "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= ",
      tip, result.sha,
    ]));
    const hit = scanAddedLines(new TextDecoder("utf-8", { fatal: false }).decode(diff.stdout), hygienePatterns);
    if (hit) throw new Held("hygiene", hit);
    const names = (await need("diff --name-only", git(["diff", "--no-renames", "--name-only", "-z", "--diff-filter=AMT", tip, result.sha, "--", ".story"])))
      .stdout.toString("utf-8").split("\0").filter(Boolean);
    for (const path of names) {
      if (!path.endsWith(".json")) continue;
      const entry = (await need("ls-tree", run("git", ["--literal-pathspecs", "--git-dir", gitDir, "--work-tree", top, "ls-tree", "-z", result.sha, "--", path], top, LOCAL_TIMEOUT_MS)))
        .stdout.toString("utf-8").split("\0").filter(Boolean);
      const m = entry.length === 1 ? /^(\d{6}) (\w+) ([0-9a-f]+)\t/.exec(entry[0]!) : null;
      if (!m || (m[1] !== "100644" && m[1] !== "100755") || m[2] !== "blob") throw new Held("hygiene", `${path} is not a regular file`);
      const blob = await need("cat-file blob", git(["cat-file", "blob", m[3]!]));
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(blob.stdout);
      } catch {
        throw new Held("hygiene", `${path} is not valid JSON: not valid UTF-8`);
      }
      try {
        JSON.parse(text);
      } catch (err) {
        throw new Held("hygiene", `${path} is not valid JSON: ${(err as Error).message}`);
      }
    }
    pass("hygiene");

    // ---- step 4: secrets ---------------------------------------------------
    current = "secrets";
    if (!opts.secretsScan) {
      pass("secrets", "skipped", "--no-secrets-scan");
    } else {
      let gitleaks: string | null = null;
      if (opts.gitleaksPath !== undefined) {
        try {
          await access(opts.gitleaksPath, fsConstants.X_OK);
          gitleaks = opts.gitleaksPath;
        } catch {
          gitleaks = null;
        }
      } else {
        gitleaks = await findOnPath("gitleaks", env.PATH);
      }
      if (!gitleaks) throw new Held("secrets", "gitleaks not found; install it or pass --no-secrets-scan");
      const probe = await run(gitleaks, ["git", "--help"], top, LOCAL_TIMEOUT_MS);
      if (probe.kind === "failed" && probe.reason === "timeout") throw new Held("secrets", "gitleaks timed out");
      if (probe.kind !== "exit" || probe.code !== 0) throw new Held("secrets", "gitleaks has no git subcommand");
      const drivers = await need("config diff drivers", git(["config", "--get-regexp", "^diff\\..*\\.(textconv|command)$|^diff\\.external$"]), [0, 1]);
      if (drivers.code === 0 && drivers.stdout.toString("utf-8").trim() !== "") {
        throw new Held("secrets", "diff driver configured; gitleaks could scan converted text");
      }
      const scan = await run(gitleaks, ["git", "--no-banner", "--redact", "--exit-code", "1", `--log-opts=${tip}..${result.sha}`, top], top, GITLEAKS_TIMEOUT_MS);
      if (scan.kind === "failed") {
        throw new Held("secrets", scan.reason === "timeout" ? "gitleaks timed out" : `gitleaks failed: ${scan.reason}`);
      }
      if (scan.code === 1) {
        const text = `${scan.stdout.toString("utf-8")}\n${scan.stderr}`;
        const rules = [...new Set([...text.matchAll(/RuleID:\s*(\S+)/g)].map((m) => m[1]!))];
        throw new Held("secrets", rules.length ? `secrets found (rules: ${rules.join(", ")})` : "secrets found");
      }
      if (scan.code !== 0) throw new Held("secrets", `gitleaks failed: ${firstLine(scan.stderr) || `exit ${scan.code}`}`);
      pass("secrets");
    }

    // ---- step 5: push ------------------------------------------------------
    current = "push";
    await opts.hooks?.beforePush?.();
    const unknown = `outcome unknown, check ${destination} ${opts.branch} by hand`;
    const pushed = await git([
      "push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no",
      `--force-with-lease=${remoteRef}:${tip}`, destination, `${result.sha}:${remoteRef}`,
    ], NETWORK_TIMEOUT_MS);
    if (pushed.kind === "failed") {
      if (pushed.reason === "spawn") throw new Held("push", `git could not start: ${pushed.detail}`, false);
      throw new Held("push", unknown, true);
    }
    const records = new TextDecoder("utf-8", { fatal: false }).decode(pushed.stdout).split("\n")
      .map((l) => /^(.)\t([^\t]*):([^\t]*)\t?(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null && m[3] === remoteRef);
    const record = records.length === 1 ? records[0]! : null;
    if (pushed.code === 0) {
      if (!record) throw new Held("push", "unexpected push result", true);
      if (record[1] === "=") throw new Held("push", `already on ${destination} ${opts.branch} when pushed`, false);
      if (record[1] !== " ") throw new Held("push", "unexpected push result", true);
    } else {
      if (record && record[1] === "!") {
        const summary = record[4] ?? "";
        if (summary.includes("stale info")) throw new Held("push", `${destination} ${opts.branch} moved since step 1`, false);
        const remoteLines = pushed.stderr.split("\n").filter((l) => l.startsWith("remote:")).map((l) => l.slice(7).trim()).filter(Boolean);
        throw new Held("push", `rejected ${summary}${remoteLines.length ? `: ${remoteLines.join("; ")}` : ""}`, false);
      }
      throw new Held("push", unknown, true);
    }
    pass("push");

    // ---- step 6: verify ----------------------------------------------------
    current = "verify";
    let after: string | null;
    try {
      after = await readTip(true);
    } catch (err) {
      if (err instanceof Held) throw new Held("verify", unknown, true);
      throw err;
    }
    if (after === null) throw new Held("verify", unknown, true);
    if (after !== result.sha) throw new Held("verify", `push reported success but ${destination} ${opts.branch} is ${after}`, true);
    pass("verify");
    result.status = "landed";
  } catch (err) {
    if (!(err instanceof Held)) throw err;
    const reason = err.reason || `outcome unknown, check ${destination || opts.remote} ${opts.branch} by hand`;
    steps.push({ step: err.step, number: STEP_NUMBER[err.step], outcome: "held", detail: reason });
    result.held = { step: err.step, number: STEP_NUMBER[err.step], reason, outcomeUnknown: err.outcomeUnknown };
    result.status = "held";
    if (opts.item !== undefined) result.receipt = { status: "not-attempted", item: opts.item, reason: `held at step ${STEP_NUMBER[err.step]} ${err.step}` };
    return result;
  }

  // ---- step 7: receipt (only after a confirmed landing) ----------------------
  if (opts.item !== undefined && target && opts.boardRoot) {
    await opts.hooks?.afterVerify?.();
    try {
      // Built inside the try: a throwing clock or an invalid Date after the remote
      // landed fails only the receipt (exit 3), never the LANDED result.
      const entry: LandReceiptEntry = {
        sha: result.sha,
        remote: opts.remote,
        remoteUrl: destination,
        branch: opts.branch,
        priorTip: tip,
        landedAt: clock().toISOString(),
        steps: steps.map((s) => ({ step: s.step, outcome: s.outcome })),
      };
      if (!opts.writeReceipt) throw new Error("no receipt writer configured");
      await opts.writeReceipt(opts.boardRoot, target, entry);
      result.receipt = { status: "written", item: opts.item, entry };
      steps.push({ step: "receipt", number: 7, outcome: "passed" });
    } catch (err) {
      result.receipt = { status: "failed", item: opts.item, error: (err as Error).message };
    }
  }
  return result;
}

/** The exit code for a result: 0 landed, 1 held, 3 landed with a failed receipt. */
export function landExitCode(result: LandResult): number {
  if (result.status === "held") return 1;
  return result.receipt.status === "failed" ? 3 : 0;
}

/** The text rendering: disclosure, one line per step, then the verdict. */
export function formatLandText(result: LandResult): string {
  const lines = [
    `land: repo ${result.repo ?? "unresolved"} board ${result.boardRoot ?? "none"} remote ${result.remote} ${result.remoteUrl ?? "unresolved"} branch ${result.branch} sha ${result.sha}`,
  ];
  for (const s of result.steps) lines.push(`${s.number} ${s.step} ${s.outcome}${s.detail ? `: ${s.detail}` : ""}`);
  if (result.status === "held" && result.held) {
    lines.push(`HELD ${result.held.number} ${result.held.step}: ${result.held.reason}`);
  } else if (result.receipt.status === "failed") {
    lines.push(`LANDED ${result.sha} (receipt not written: ${result.receipt.error})`);
  } else {
    lines.push(`LANDED ${result.sha}`);
  }
  return lines.join("\n");
}
