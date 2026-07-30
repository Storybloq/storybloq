/**
 * Is the artifact under test the code in the working tree? (ISS-912)
 *
 * An operator got "two confident, completely wrong test results from a stale
 * build, and nothing structural would have stopped me reporting them as a
 * phase boundary" (N-097, operator 3). T-440 seals completion facts and
 * ISS-820 seals review facts, but the artifact UNDER test was never checked,
 * so a green report could attest to code that is not the code in the tree.
 * Same skew family as ISS-902 (schema) and ISS-906 (server binary), third
 * presentation: test artifacts.
 *
 * The probe is deliberately cheap and positive-establishment-only, matching
 * the ISS-906 doctrine: it compares the newest mtime under the source set
 * against the newest mtime under the build-output set, and it only ever
 * blocks (with a bounded rebuild-and-re-run retry) when staleness is
 * POSITIVELY established -- both sides matched at least one file and the
 * newest source is strictly newer than the newest output. Everything else --
 * no build outputs (interpreted projects), no derivable configuration, an
 * unsupported pattern, a scan that hits its entry cap -- is `unestablished`:
 * the stage proceeds and the condition is visible in the event log and the
 * stage instruction, never a hard block on projects that do not build.
 *
 * Globs are recipe-configurable (`stages.TEST.freshness` /
 * `stages.VERIFY.freshness`, with VERIFY falling back to TEST's block so one
 * setting covers both) and default-derived from the project type: a root
 * tsconfig.json `outDir` plus a `src/` directory, or a package.json `build`
 * script plus an existing `dist`/`build`/`out` directory. Patterns support a
 * deliberate lite subset -- `dir`, `dir/**`, and a `dir/**` base with a final
 * `*` or `*.ext` segment -- because this repo carries no glob dependency
 * and the newest-mtime question does not need full glob semantics. An
 * unsupported pattern makes the probe unestablished and names the pattern,
 * never silently narrows it.
 */
import { statSync, lstatSync, realpathSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { sanitizeDisplayText } from "../core/display-text.js";
import { escapeMarkdownDocumentStrict } from "../core/output-formatter.js";

export interface FileStamp {
  readonly path: string;
  readonly mtimeMs: number;
}

export type FreshnessProbe =
  | { readonly kind: "fresh"; readonly newestSource: FileStamp; readonly newestOutput: FileStamp }
  | { readonly kind: "stale"; readonly newestSource: FileStamp; readonly newestOutput: FileStamp }
  | { readonly kind: "unestablished"; readonly reason: string };

export interface ResolvedFreshness {
  readonly sourceGlobs: readonly string[];
  readonly outputGlobs: readonly string[];
  readonly origin: "explicit" | "derived";
}

/** Rebuild-and-re-run attempts per stage entry before failing open. */
export const MAX_FRESHNESS_RETRIES = 2;

const DEFAULT_MAX_ENTRIES = 20_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".story"]);
const DERIVED_OUTPUT_DIRS = ["dist", "build", "out"];

// ---------------------------------------------------------------------------
// Configuration resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the source/output pattern sets for a stage, or null when the probe
 * should not run at all (explicitly disabled, or nothing derivable -- an
 * interpreted project with no build step has nothing to go stale).
 *
 * `stageConfig` is the invoking stage's own config; `testStageConfig` is the
 * TEST stage's config, consulted as a fallback so one `freshness` block
 * covers TEST and VERIFY. A half-explicit config (one side given) keeps the
 * explicit side and fills the other from derivation; if the other side is
 * underivable the probe does not run -- guessing a source set would let a
 * wrong guess manufacture staleness.
 */
export function resolveFreshnessGlobs(
  root: string,
  stageConfig: Record<string, unknown> | undefined,
  testStageConfig: Record<string, unknown> | undefined,
): ResolvedFreshness | null {
  const cfg = (stageConfig?.freshness ?? testStageConfig?.freshness) as
    | Record<string, unknown>
    | undefined;
  if (cfg?.enabled === false) return null;

  const explicitSources = readGlobList(cfg?.sourceGlobs);
  const explicitOutputs = readGlobList(cfg?.outputGlobs);
  if (explicitSources && explicitOutputs) {
    return { sourceGlobs: explicitSources, outputGlobs: explicitOutputs, origin: "explicit" };
  }

  const derived = deriveFreshnessGlobs(root);
  if (explicitSources || explicitOutputs) {
    const sourceGlobs = explicitSources ?? derived?.sourceGlobs;
    const outputGlobs = explicitOutputs ?? derived?.outputGlobs;
    if (sourceGlobs && outputGlobs) {
      return { sourceGlobs, outputGlobs, origin: "explicit" };
    }
    return null;
  }
  return derived;
}

function readGlobList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((v) => typeof v === "string" && v.length > 0)) return null;
  return value as string[];
}

/**
 * Derive default patterns from the project type. Both sides must be
 * establishable or derivation yields null: outputs from tsconfig `outDir` or
 * a conventional output directory that exists beside a `build` script;
 * sources from an existing `src/` directory.
 */
export function deriveFreshnessGlobs(root: string): ResolvedFreshness | null {
  if (!existsSync(join(root, "src"))) return null;
  const sourceGlobs = ["src/**"] as const;

  const outDir = readTsconfigOutDir(root);
  if (outDir) {
    return { sourceGlobs, outputGlobs: [normalizeDirPattern(outDir)], origin: "derived" };
  }

  if (hasBuildScript(root)) {
    for (const dir of DERIVED_OUTPUT_DIRS) {
      if (existsSync(join(root, dir))) {
        return { sourceGlobs, outputGlobs: [`${dir}/**`], origin: "derived" };
      }
    }
  }
  return null;
}

function readTsconfigOutDir(root: string): string | null {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as {
      compilerOptions?: { outDir?: unknown };
    };
    const outDir = parsed.compilerOptions?.outDir;
    if (typeof outDir !== "string" || outDir.length === 0) return null;
    // Only in-project relative outDirs are usable as walk bases; embedded
    // traversal ("build/../../elsewhere") is as out-of-project as a leading
    // one. Both separators, because tsconfig values travel across platforms.
    const segments = outDir.split("/").flatMap((part) => part.split("\\"));
    if (segments.includes("..") || isAbsolute(outDir)) return null;
    return outDir;
  } catch {
    return null;
  }
}

function hasBuildScript(root: string): boolean {
  const path = join(root, "package.json");
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return typeof parsed.scripts?.build === "string";
  } catch {
    return false;
  }
}

function normalizeDirPattern(dir: string): string {
  let d = dir;
  if (d.startsWith("./")) d = d.slice(2);
  while (d.endsWith("/")) d = d.slice(0, -1);
  return `${d}/**`;
}

/**
 * Strip // and block comments from JSONC without touching string contents.
 * tsconfig.json routinely carries comments; a naive regex strip would mangle
 * strings, so this is a small character scanner instead.
 */
function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Remove commas whose next non-whitespace character closes an object or
 * array. TypeScript accepts trailing commas in tsconfig.json and they are
 * common; JSON.parse does not. Runs after comment stripping, so whitespace
 * is the only thing left to look across. String-aware for the same reason
 * the comment pass is: a string can contain ", }".
 */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text.charCodeAt(j) === 9 || text.charCodeAt(j) === 10 || text.charCodeAt(j) === 13)) j++;
      if (j < text.length && (text[j] === "}" || text[j] === "]")) {
        i++; // drop the comma; the whitespace and closer flow through
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * Compare newest source mtime against newest output mtime. Stale only when
 * both sides are established and the newest source is strictly newer;
 * every failure to establish is `unestablished` with a named reason.
 */
export function probeArtifactFreshness(
  root: string,
  globs: ResolvedFreshness,
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): FreshnessProbe {
  const budget = { remaining: maxEntries };

  const source = newestUnder(root, globs.sourceGlobs, budget);
  if (source.unsupported) return unsupported(source.unsupported);
  const output = newestUnder(root, globs.outputGlobs, budget);
  if (output.unsupported) return unsupported(output.unsupported);
  if (budget.remaining <= 0) {
    return {
      kind: "unestablished",
      reason: `scan hit the ${maxEntries}-entry cap before covering both pattern sets; a capped scan can miss the newest file, so nothing is established`,
    };
  }
  if (!source.stamp) {
    return { kind: "unestablished", reason: `no files matched the source patterns (${globs.sourceGlobs.join(", ")})` };
  }
  if (!output.stamp) {
    return { kind: "unestablished", reason: `no build outputs matched (${globs.outputGlobs.join(", ")}); nothing to go stale` };
  }
  return source.stamp.mtimeMs > output.stamp.mtimeMs
    ? { kind: "stale", newestSource: source.stamp, newestOutput: output.stamp }
    : { kind: "fresh", newestSource: source.stamp, newestOutput: output.stamp };
}

function unsupported(pattern: string): FreshnessProbe {
  return {
    kind: "unestablished",
    reason: `unsupported pattern "${pattern}" -- supported forms are dir, dir/**, dir/**/*, dir/**/*.ext with literal base segments`,
  };
}

interface NewestResult {
  stamp: FileStamp | null;
  unsupported: string | null;
}

function newestUnder(
  root: string,
  patterns: readonly string[],
  budget: { remaining: number },
): NewestResult {
  let best: FileStamp | null = null;
  for (const pattern of patterns) {
    const parsed = parseLitePattern(pattern);
    if (!parsed) return { stamp: null, unsupported: pattern };
    const found = newestForPattern(root, parsed, budget);
    if (found && (!best || found.mtimeMs > best.mtimeMs)) best = found;
    if (budget.remaining <= 0) break;
  }
  return { stamp: best, unsupported: null };
}

interface LitePattern {
  readonly base: string;
  /** null = every file; otherwise lowercase extensions without the dot. */
  readonly exts: readonly string[] | null;
}

/**
 * Parse the supported subset: literal base segments optionally followed by
 * a `**` tail, itself optionally followed by one final `*` or `*.ext`
 * segment. Anything else (a `*` in a literal
 * segment, `**` mid-path, brace sets) returns null -- callers surface the
 * pattern rather than guessing at it.
 */
export function parseLitePattern(pattern: string): LitePattern | null {
  if (pattern.length === 0) return null;
  const segments = pattern.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  const literals: string[] = [];
  let i = 0;
  while (i < segments.length && !segments[i]!.includes("*")) {
    const seg = segments[i]!;
    // ".." never enters a base: a pattern must not address anything outside
    // the project root, embedded traversal included. "." is identity.
    if (seg === "..") return null;
    if (seg !== ".") literals.push(seg);
    i++;
  }
  if (i === segments.length) {
    // Fully literal path: a directory (all files) or a single file.
    return { base: literals.join("/"), exts: null };
  }
  if (segments[i] !== "**") return null;
  i++;
  if (i === segments.length) {
    return { base: literals.join("/"), exts: null };
  }
  if (i !== segments.length - 1) return null;
  const tail = segments[i]!;
  if (tail === "*") return { base: literals.join("/"), exts: null };
  if (tail.startsWith("*.")) {
    const ext = tail.slice(2);
    if (ext.length === 0 || ext.includes("*")) return null;
    return { base: literals.join("/"), exts: [ext.toLowerCase()] };
  }
  return null;
}

function newestForPattern(
  root: string,
  pattern: LitePattern,
  budget: { remaining: number },
): FileStamp | null {
  const basePath = pattern.base.length > 0 ? join(root, pattern.base) : root;
  // Containment backstop behind the parse-time ".." rejection: whatever form
  // the base took, the resolved walk base must stay inside the root.
  const rel = relative(root, resolve(basePath));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  let baseStat;
  try {
    // lstat, not stat: a symlinked base would walk a tree outside the one
    // this probe can reason about. It contributes nothing instead.
    baseStat = lstatSync(basePath);
  } catch {
    return null; // Missing base contributes nothing; establishment is decided by the caller.
  }
  if (baseStat.isSymbolicLink()) return null;
  // Canonical containment behind the lexical check and the final-component
  // lstat: an ANCESTOR segment of the base can be a symlink even when the
  // final component is not ("linked/sub" where "linked" points out of the
  // project). realpath resolves the whole chain on both sides, which also
  // keeps a legitimately-symlinked project root (macOS /var -> /private/var)
  // comparing against itself.
  try {
    const realRel = relative(realpathSync(root), realpathSync(basePath));
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return null;
  } catch {
    return null;
  }
  if (baseStat.isFile()) {
    budget.remaining--;
    return matchesExt(pattern.base, pattern.exts)
      ? { path: pattern.base, mtimeMs: baseStat.mtimeMs }
      : null;
  }
  if (!baseStat.isDirectory()) return null;

  let best: FileStamp | null = null;
  const stack: string[] = [pattern.base];
  while (stack.length > 0) {
    if (budget.remaining <= 0) return best;
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(rel.length > 0 ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget.remaining <= 0) return best;
      budget.remaining--;
      const relPath = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(relPath);
        continue;
      }
      // Symlinks are skipped: following them risks cycles and out-of-tree
      // mtimes; a cheap probe stays inside the tree it can reason about.
      if (!entry.isFile()) continue;
      if (!matchesExt(entry.name, pattern.exts)) continue;
      try {
        const st = statSync(join(root, relPath));
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: relPath, mtimeMs: st.mtimeMs };
      } catch {
        continue;
      }
    }
  }
  return best;
}

function matchesExt(name: string, exts: readonly string[] | null): boolean {
  if (!exts) return true;
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(`.${ext}`));
}

// ---------------------------------------------------------------------------
// Stage-facing text
// ---------------------------------------------------------------------------

/**
 * Repo-derived values (paths, globs, commands) render through the standing
 * sanitize-then-escape pair before entering instruction Markdown: a filename
 * can carry backticks, newlines, or instruction-like text as easily as any
 * untrusted string, and a code span does not contain a backtick. Bounded by
 * sanitizeDisplayText's display cap.
 */
function displayValue(value: string): string {
  return escapeMarkdownDocumentStrict(sanitizeDisplayText(value));
}

/** One status line for stage instructions: what the probe will (not) check. */
export function freshnessStatusLine(globs: ResolvedFreshness | null): string {
  if (!globs) {
    return "Artifact freshness: not checked -- no build outputs detected for this project (interpreted projects run source directly; nothing to go stale).";
  }
  return `Artifact freshness: checked before your report is accepted (${displayValue(globs.sourceGlobs.join(", "))} vs ${displayValue(globs.outputGlobs.join(", "))}, ${globs.origin}).`;
}

/** The rebuild-and-re-run instruction returned when staleness is established. */
export function staleRebuildInstruction(
  probe: FreshnessProbe & { kind: "stale" },
  rebuildCommand: string,
  rerunWhat: string,
  attempt: number,
): string {
  return [
    `# Stale Build Artifacts -- Rebuild Required (attempt ${attempt}/${MAX_FRESHNESS_RETRIES})`,
    "",
    `The artifact under test is older than the source tree: newest source ${displayValue(probe.newestSource.path)} (${new Date(probe.newestSource.mtimeMs).toISOString()}) is newer than newest build output ${displayValue(probe.newestOutput.path)} (${new Date(probe.newestOutput.mtimeMs).toISOString()}).`,
    "",
    "A report produced against stale artifacts attests to code that is not the code in the working tree, so this report is not accepted.",
    "",
    `1. Rebuild: ${displayValue(rebuildCommand)}`,
    `2. ${rerunWhat}`,
    "3. Report the fresh results again.",
  ].join("\n");
}
