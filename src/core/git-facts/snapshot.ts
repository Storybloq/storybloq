/**
 * C-v4.1 commit 4, plan sections 4.2 and 4.4: one git facts snapshot of the
 * board's own repository.
 *
 * Order: identity (toplevel, common dir, shallow state, object format), HEAD
 * (detached allowed), the default target, then refs. Tags are peeled
 * recursively in one batched `cat-file --batch-check` pass. The graph is read
 * with merges included, from the captured object ids (never ref names), and
 * stops at limit + 1 commits. After the walk, HEAD, the default target and
 * the refs are read again; a difference retries once, then is
 * `incomplete-history` (refs moved).
 *
 * Per-commit state and ancestry are lookups in the index; no per-query git.
 */
import { runGitFacts, type GitFactsResult } from "./runner.js";
import { GraphIndex } from "./graph-index.js";
import { graphCache, graphKey, type GraphEntry } from "./cache.js";
import { PatternTimeoutError, sandboxTests } from "./pattern-sandbox.js";

export const DEFAULT_MAX_GRAPH_COMMITS = 200_000;
export const DEFAULT_MAX_REFS = 10_000;
/** Plan 4.2 release default (pen ruling 2026-11-16): optional v, three numeric parts, any suffix. */
export const DEFAULT_RELEASE_TAG_PATTERN = "^v?\\d+\\.\\d+\\.\\d+";
/** A pattern is user input on a read path: its length is capped and it must compile. */
export const MAX_PATTERN_LENGTH = 200;
/** Patterns are matched only against strings cut to this length (subjects and tag names). */
export const MAX_MATCH_INPUT_LENGTH = 1_000;

export type GitState = "released" | "landed" | "built" | "none";

export type UnknownReason =
  | "scan disabled"
  | "pattern timeout"
  | "not a git repository"
  | "shallow repository"
  | "missing default"
  | "graph over limit"
  | "refs over limit"
  | "incomplete-history"
  | "git timeout"
  | "git output over limit"
  | "git failed"
  /** Defined in commit 4, produced from commit 5 (federation refs in proof). */
  | "unresolved repo"
  /** Defined in commit 4, produced from commit 5 (federation refs in proof). */
  | "mismatched repo";

export interface TagFact {
  readonly ref: string;
  readonly kind: "commit" | "non-commit" | "dangling";
  readonly commit?: string;
}

export interface SnapshotOptions {
  readonly maxGraphCommits?: number;
  readonly maxRefs?: number;
  readonly defaultBranch?: string;
  readonly releaseTagPattern?: string;
  /** Test seam: skip the graph cache. */
  readonly noCache?: boolean;
}

export type GitSnapshot =
  | {
      readonly status: "ok";
      readonly key: string;
      readonly tags: readonly TagFact[];
      readonly diagnostics: readonly string[];
      readonly stateOf: (sha: string) => GitState;
      readonly isAncestor: (a: string, b: string) => boolean;
      readonly touchesCode: (sha: string) => boolean;
      readonly graph: GraphIndex;
    }
  | { readonly status: "unknown"; readonly reason: UnknownReason; readonly detail?: string };

type Unknown = Extract<GitSnapshot, { status: "unknown" }>;

function unknownFromRun(r: Extract<GitFactsResult, { kind: "failed" }>): Unknown {
  if (r.reason === "timeout") return { status: "unknown", reason: "git timeout", detail: r.detail };
  if (r.reason === "output") return { status: "unknown", reason: "git output over limit", detail: r.detail };
  return { status: "unknown", reason: "git failed", detail: r.detail };
}

/** Compile a user pattern with the length cap; throws a message naming the field. */
export function compileBoundedPattern(field: string, pattern: string): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`${field}: the pattern is longer than ${MAX_PATTERN_LENGTH} characters.`);
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`${field}: the pattern does not compile (${(e as Error).message}).`);
  }
}

export function boundedTest(re: RegExp, input: string): boolean {
  re.lastIndex = 0;
  return re.test(input.length > MAX_MATCH_INPUT_LENGTH ? input.slice(0, MAX_MATCH_INPUT_LENGTH) : input);
}

interface Surface {
  readonly head: string | null;
  readonly defaultRef: string;
  readonly defaultTip: string;
  readonly refs: readonly { oid: string; type: string; ref: string }[];
}

async function git(root: string, args: string[], extra: { input?: string; maxNuls?: number } = {}): Promise<GitFactsResult> {
  return runGitFacts({ cwd: root, args, ...extra });
}

async function readDefaultName(root: string, configured: string | undefined): Promise<string | null> {
  if (configured !== undefined) return configured;
  const sym = await git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.kind === "ok") {
    const v = sym.stdout.toString("utf8").trim();
    if (v.length > 0) return v.startsWith("origin/") ? v.slice("origin/".length) : v;
  }
  const cfg = await git(root, ["config", "init.defaultBranch"]);
  if (cfg.kind === "ok") {
    const v = cfg.stdout.toString("utf8").trim();
    if (v.length > 0) return v;
  }
  return null;
}

async function readSurface(root: string, defaultName: string, maxRefs: number): Promise<Surface | Unknown> {
  const head = await git(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  const headId = head.kind === "ok" ? head.stdout.toString("utf8").trim() || null : null;

  // The default target: origin's remote-tracking branch when present, else the local branch.
  let defaultRef = "";
  let defaultTip = "";
  for (const ref of [`refs/remotes/origin/${defaultName}`, `refs/heads/${defaultName}`]) {
    const r = await git(root, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
    if (r.kind === "ok") {
      defaultRef = ref;
      defaultTip = r.stdout.toString("utf8").trim();
      break;
    }
  }
  if (defaultTip === "") return { status: "unknown", reason: "missing default", detail: defaultName };

  // One NUL-separated record per ref: three fields, newline-terminated.
  const refs = await git(root, ["for-each-ref", "--format=%(objectname)%00%(objecttype)%00%(refname)", "refs/heads", "refs/remotes", "refs/tags"], { maxNuls: 2 * maxRefs });
  if (refs.kind === "failed") {
    if (refs.reason === "records") return { status: "unknown", reason: "refs over limit" };
    return unknownFromRun(refs);
  }
  const rows = refs.stdout.toString("utf8").split("\n").filter((l) => l.length > 0).map((line) => {
    const [oid = "", type = "", ref = ""] = line.split("\0");
    return { oid, type, ref };
  });
  if (rows.length > maxRefs) return { status: "unknown", reason: "refs over limit" };
  return { head: headId, defaultRef, defaultTip, refs: rows };
}

function sameSurface(a: Surface, b: Surface): boolean {
  if (a.head !== b.head || a.defaultRef !== b.defaultRef || a.defaultTip !== b.defaultTip) return false;
  if (a.refs.length !== b.refs.length) return false;
  return a.refs.every((r, i) => r.oid === b.refs[i]!.oid && r.ref === b.refs[i]!.ref && r.type === b.refs[i]!.type);
}

async function peelTags(root: string, surface: Surface, diagnostics: string[]): Promise<TagFact[] | Unknown> {
  const tags = surface.refs.filter((r) => r.ref.startsWith("refs/tags/"));
  const facts: TagFact[] = [];
  const toPeel = tags.filter((t) => t.type === "tag");
  for (const t of tags) {
    if (t.type === "commit") facts.push({ ref: t.ref, kind: "commit", commit: t.oid });
    else if (t.type !== "tag") facts.push({ ref: t.ref, kind: "non-commit" });
  }
  if (toPeel.length === 0) return facts;
  // `<oid>^{}` peels recursively to the first non-tag object.
  const r = await git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: toPeel.map((t) => `${t.oid}^{}\n`).join("") });
  if (r.kind === "failed") return unknownFromRun(r);
  const lines = r.stdout.toString("utf8").split("\n").filter((l) => l.length > 0);
  toPeel.forEach((t, i) => {
    const line = lines[i] ?? "";
    const [oid = "", type = ""] = line.split(" ");
    if (type === "commit") facts.push({ ref: t.ref, kind: "commit", commit: oid });
    else if (type === "tree" || type === "blob") facts.push({ ref: t.ref, kind: "non-commit" });
    else {
      facts.push({ ref: t.ref, kind: "dangling" });
      diagnostics.push(`tag ${t.ref} could not be peeled: ${line}`);
    }
  });
  return facts;
}

async function walk(root: string, tips: readonly string[], maxGraph: number): Promise<{ parents: Map<string, string[]>; subjects: Map<string, string>; code: Set<string> } | Unknown> {
  const parents = new Map<string, string[]>();
  const subjects = new Map<string, string>();
  const code = new Set<string>();
  if (tips.length === 0) return { parents, subjects, code };
  // -z ends each entry with NUL and the format holds two more, so limit
  // records carry at most 3 * limit NULs; limit + 1 records carry more, and
  // the stream is stopped there.
  const log = await git(root, ["log", "-z", "--format=%H%x00%P%x00%s", ...tips, "--"], { maxNuls: 3 * maxGraph });
  if (log.kind === "failed") {
    if (log.reason === "records") return { status: "unknown", reason: "graph over limit" };
    return unknownFromRun(log);
  }
  const fields = log.stdout.toString("utf8").split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const sha = fields[i]!.replace(/^\n/, "");
    if (sha === "") continue;
    parents.set(sha, fields[i + 1]!.length > 0 ? fields[i + 1]!.split(" ") : []);
    subjects.set(sha, fields[i + 2]!);
  }
  if (parents.size > maxGraph) return { status: "unknown", reason: "graph over limit" };
  const touched = await git(root, ["log", "-z", "--format=%H", "--full-history", "-m", ...tips, "--", ".", ":(exclude).story"]);
  if (touched.kind === "failed") return unknownFromRun(touched);
  for (const s of touched.stdout.toString("utf8").split("\0")) {
    const sha = s.trim();
    if (sha.length > 0) code.add(sha);
  }
  return { parents, subjects, code };
}

/** Test seam: runs after the walk, before the inputs are read again. */
export const snapshotSeams: { afterWalk: () => Promise<void> } = { afterWalk: async () => {} };

interface Inputs {
  readonly toplevel: string;
  readonly commonDir: string;
  readonly shallow: string;
  readonly format: string;
  readonly defaultName: string;
}

async function readInputs(root: string, configured: string | undefined): Promise<Inputs | Unknown> {
  const id = await git(root, ["rev-parse", "--show-toplevel", "--git-common-dir", "--is-shallow-repository", "--show-object-format"]);
  // No detail: git's own message adds nothing a caller can act on.
  if (id.kind === "failed") return { status: "unknown", reason: "not a git repository" };
  const [toplevel = "", commonDir = "", shallowRaw = "", format = ""] = id.stdout.toString("utf8").split("\n");
  const shallow = shallowRaw.trim();
  if (shallow === "true") return { status: "unknown", reason: "shallow repository" };
  const defaultName = await readDefaultName(root, configured);
  if (defaultName === null) return { status: "unknown", reason: "missing default" };
  return { toplevel, commonDir, shallow, format, defaultName };
}

function sameInputs(a: Inputs, b: Inputs): boolean {
  return a.toplevel === b.toplevel && a.commonDir === b.commonDir && a.shallow === b.shallow && a.format === b.format && a.defaultName === b.defaultName;
}

export async function takeGitSnapshot(root: string, opts: SnapshotOptions = {}): Promise<GitSnapshot> {
  const maxGraph = opts.maxGraphCommits ?? DEFAULT_MAX_GRAPH_COMMITS;
  const maxRefs = opts.maxRefs ?? DEFAULT_MAX_REFS;
  if (maxGraph === 0) return { status: "unknown", reason: "scan disabled" };
  const releaseRe = compileBoundedPattern("gitState.releaseTagPattern", opts.releaseTagPattern ?? DEFAULT_RELEASE_TAG_PATTERN);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Codex finding 4: identity, shallow state and the resolved default are captured inside each attempt
    // and read again with HEAD and the refs before the walk is accepted.
    const inputs = await readInputs(root, opts.defaultBranch);
    if ("status" in inputs) return inputs;
    const { toplevel, commonDir, shallow, format, defaultName } = inputs;
    const diagnostics: string[] = [];
    const surface = await readSurface(root, defaultName, maxRefs);
    if ("status" in surface) return surface;
    const tags = await peelTags(root, surface, diagnostics);
    if ("status" in tags) return tags;

    const branchTips = surface.refs.filter((r) => (r.ref.startsWith("refs/heads/") || r.ref.startsWith("refs/remotes/")) && r.type === "commit").map((r) => r.oid);
    if (surface.head !== null) branchTips.push(surface.head);
    const commitTags = tags.filter((t) => t.kind === "commit");
    let releaseHits: boolean[];
    if (opts.releaseTagPattern === undefined) releaseHits = commitTags.map((t) => boundedTest(releaseRe, t.ref.slice("refs/tags/".length)));
    else {
      // Codex finding 1: a configured pattern runs in the sandbox with a deadline.
      try {
        releaseHits = sandboxTests("gitState.releaseTagPattern", releaseRe, commitTags.map((t) => t.ref.slice("refs/tags/".length)));
      } catch (e) {
        if (e instanceof PatternTimeoutError) return { status: "unknown", reason: "pattern timeout", detail: e.field };
        throw e;
      }
    }
    const releaseTips = commitTags.filter((_, i) => releaseHits[i]).map((t) => t.commit!);
    const allTips = [...new Set([...branchTips, ...tags.filter((t) => t.kind === "commit").map((t) => t.commit!), surface.defaultTip])].sort();

    const key = graphKey({
      repo: `${toplevel}\0${commonDir}\0${format}`,
      shallow,
      head: surface.head ?? "",
      refs: surface.refs.map((r) => `${r.ref}=${r.oid}`),
      peeled: tags.map((t) => `${t.ref}=${t.commit ?? t.kind}`),
      defaultTarget: `${surface.defaultRef}=${surface.defaultTip}`,
      config: `${maxGraph}\0${maxRefs}\0${opts.defaultBranch ?? ""}\0${opts.releaseTagPattern ?? ""}`,
    });

    let entry: GraphEntry | undefined = opts.noCache === true ? undefined : graphCache.get(key);
    if (entry === undefined) {
      const w = await walk(root, allTips, maxGraph);
      if ("status" in w) return w;
      await snapshotSeams.afterWalk();
      const inputsAgain = await readInputs(root, opts.defaultBranch);
      if ("status" in inputsAgain) {
        if (attempt === 0) continue;
        return inputsAgain;
      }
      const again = await readSurface(root, inputsAgain.defaultName, maxRefs);
      if ("status" in again) return again;
      if (!sameInputs(inputs, inputsAgain) || !sameSurface(surface, again)) {
        if (attempt === 0) continue;
        return { status: "unknown", reason: "incomplete-history", detail: "refs moved" };
      }
      const graph = new GraphIndex(w.parents, w.subjects, w.code, {
        fromDefault: [surface.defaultTip],
        fromRelease: releaseTips,
        fromBranch: branchTips,
      });
      entry = { key, graph };
      if (opts.noCache !== true) graphCache.set(entry);
    }
    const graph = entry.graph;
    return {
      status: "ok",
      key,
      tags,
      diagnostics,
      graph,
      stateOf: (sha) => graph.stateOf(sha),
      isAncestor: (a, b) => graphCache.isAncestor(entry!, a, b),
      touchesCode: (sha) => graph.touchesCode(sha),
    };
  }
  return { status: "unknown", reason: "incomplete-history", detail: "refs moved" };
}
