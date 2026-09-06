/**
 * Heuristic context packaging for lens subagents (ISS-823 carry-over from the
 * retired review-lenses fork, adapted to the package lens registry).
 *
 * Builds shared context header, file manifest (regex signatures), per-lens
 * file routing, and token-budget truncation for large diffs. No LLM calls --
 * purely deterministic. Prompt construction itself now lives in
 * @storybloq/lenses (buildLensPrompt); this module only decides WHAT each
 * lens sees.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Stage } from "@storybloq/lenses";
import { resolveAndValidate } from "./path-safety.js";

/**
 * Separate budgets on purpose. Sharing one would let the contract evict rules
 * content, which is the failure this split exists to prevent. See ISS-1125 for
 * why the RULES.md number is what it is and why it is not raised here.
 */
const RULES_BUDGET = 2000;
const REVIEW_BUDGET = 3000;

// ── Per-lens file routing ──────────────────────────────────────

const SECURITY_GETS_ALL = true;

const LENS_FILE_FILTERS: Record<string, (file: string) => boolean> = {
  "clean-code": () => true,
  security: () => SECURITY_GETS_ALL,
  "error-handling": () => true,
  performance: () => true, // Activation already filtered
  "api-design": (f) =>
    /\/(api|routes?|controllers?|resolvers?)\//i.test(f) ||
    /\.(controller|resolver|route)\./i.test(f),
  concurrency: () => true, // Core lens in the package registry
  "test-quality": (f) =>
    /\.(test|spec)\./i.test(f) || /__tests__\//i.test(f) || /\/test\//i.test(f),
  accessibility: (f) =>
    /\.(tsx|jsx|html|vue|svelte|css|scss|ejs|hbs|pug)$/i.test(f),
  "data-safety": (f) =>
    /\.sql$/i.test(f) || /(^|\/)(migrations?|migrate)\//i.test(f) || /(^|\/)schema\.prisma$/.test(f),
};

// ── Public API ─────────────────────────────────────────────────

export interface PackagedContext {
  readonly sharedHeader: string;
  readonly projectRules: string;
  readonly fileManifest: string;
  readonly perLensArtifacts: ReadonlyMap<string, string>;
  readonly fileContents: ReadonlyMap<string, string>;
}

export function packageContext(opts: {
  stage: Stage;
  diff: string;
  changedFiles: readonly string[];
  activeLenses: readonly string[];
  ticketDescription: string;
  projectRoot: string;
  tokenBudgetPerLens: number;
}): PackagedContext {
  const { stage, diff, changedFiles, activeLenses, ticketDescription, projectRoot, tokenBudgetPerLens } = opts;

  // Read project rules.
  //
  // The 2000-character slice on RULES.md is PRE-EXISTING and is not fixed here:
  // it silently truncates (this repo's RULES.md is 3497 bytes, so lenses have
  // never seen its last three sections), and both halves of that defect, the
  // missing marker and the too-small budget, are ISS-1125.
  //
  // What matters at THIS seam is that REVIEW.md does not make it worse.
  // Appending the contract into the same 2000 characters would evict rules text
  // that is already being lost, under a change whose whole purpose is to give
  // reviewers more context. So the contract gets its OWN budget, and its
  // truncation says so rather than cutting in silence.
  const rulesPath = join(projectRoot, "RULES.md");
  const rulesText = existsSync(rulesPath)
    ? readFileSync(rulesPath, "utf-8").slice(0, RULES_BUDGET)
    : "(no RULES.md found)";

  const reviewPath = join(projectRoot, "REVIEW.md");
  let reviewText = "";
  if (existsSync(reviewPath)) {
    try {
      const raw = readFileSync(reviewPath, "utf-8");
      // Text, ungated. Nothing here parses REVIEW.md or acts on its headings:
      // a checklist-style REVIEW.md is useful review guidance even when it
      // declares no structure at all, so the reviewer gets the file as written.
      reviewText = raw.length > REVIEW_BUDGET
        ? `${raw.slice(0, REVIEW_BUDGET)}\n\n[REVIEW.md truncated at ${REVIEW_BUDGET} characters]`
        : raw;
    } catch { /* unreadable contract is an absent contract */ }
  }

  const projectRules = reviewText === ""
    ? rulesText
    : `${rulesText}\n\n## REVIEW.md (quality contract)\n\n${reviewText}`;

  // Build file contents map (with path traversal + symlink protection)
  const fileContents = new Map<string, string>();
  for (const file of changedFiles) {
    const safePath = resolveAndValidate(projectRoot, file);
    if (!safePath) continue;
    try {
      fileContents.set(file, readFileSync(safePath, "utf-8"));
    } catch {
      // Skip unreadable files
    }
  }

  // Build file manifest (function signatures via regex)
  const manifest = buildFileManifest(changedFiles, fileContents);

  // Diff stats
  const stats = computeDiffStats(diff);

  // Shared header
  const sharedHeader = [
    `## Review Context`,
    ``,
    `**Stage:** ${stage}`,
    `**Ticket:** ${ticketDescription}`,
    `**Diff stats:** ${stats.filesChanged} files, +${stats.insertions}/-${stats.deletions} lines`,
    ``,
    `**Project rules (excerpt):**`,
    projectRules,
  ].join("\n");

  // Per-lens artifacts: route files to each lens
  const perLensArtifacts = new Map<string, string>();
  for (const lens of activeLenses) {
    const filter = LENS_FILE_FILTERS[lens] ?? (() => true);
    const filtered = changedFiles.filter(filter);
    // The package's activate() already decided this lens is relevant to the
    // review (e.g. test-quality in missing-coverage mode fires on source
    // changes with no test files). An activated lens must never receive the
    // empty-artifact placeholder, so fall back to the full file set when the
    // routing filter matches nothing.
    const relevantFiles = filtered.length > 0 ? filtered : changedFiles;

    if (stage === "PLAN_REVIEW") {
      // Plan review: lens gets the full plan text
      perLensArtifacts.set(lens, diff);
    } else {
      // Code review: route relevant diff hunks
      const artifact = extractDiffForFiles(diff, relevantFiles, tokenBudgetPerLens);
      perLensArtifacts.set(lens, artifact);
    }
  }

  return {
    sharedHeader,
    projectRules,
    fileManifest: manifest,
    perLensArtifacts,
    fileContents,
  };
}

// ── File manifest ──────────────────────────────────────────────

function buildFileManifest(
  files: readonly string[],
  contents: ReadonlyMap<string, string>,
): string {
  const lines: string[] = ["## Changed Files", ""];

  for (const file of files) {
    const content = contents.get(file);
    if (!content) {
      lines.push(`- ${file}`);
      continue;
    }

    const signatures = extractSignatures(content);
    if (signatures.length > 0) {
      lines.push(`- ${file}: ${signatures.join(", ")}`);
    } else {
      lines.push(`- ${file} (${content.split("\n").length} lines)`);
    }
  }

  return lines.join("\n");
}

function extractSignatures(content: string): string[] {
  const sigs: string[] = [];
  const patterns = [
    /^export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^export\s+(?:default\s+)?class\s+(\w+)/gm,
    /^export\s+(?:const|let)\s+(\w+)\s*=/gm,
    /^(?:async\s+)?function\s+(\w+)/gm,
    /^class\s+(\w+)/gm,
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm, // Rust
    /^func\s+(\w+)/gm, // Go/Swift
    /^struct\s+(\w+)/gm, // Swift/Rust/Go
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1] && !sigs.includes(match[1])) {
        sigs.push(match[1]);
      }
    }
  }

  return sigs.slice(0, 10); // Cap at 10 signatures
}

// ── Diff stats ─────────────────────────────────────────────────

interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

function computeDiffStats(diff: string): DiffStats {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) filesChanged++;
    else if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  return { filesChanged, insertions, deletions };
}

// ── Diff extraction per file ───────────────────────────────────

function extractDiffForFiles(
  fullDiff: string,
  files: readonly string[],
  tokenBudget: number,
): string {
  if (files.length === 0) return "(no relevant files in diff)";

  const fileSet = new Set(files);
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentFile = "";

  for (const line of fullDiff.split("\n")) {
    if (line.startsWith("diff --git")) {
      // Flush previous chunk
      if (currentChunk.length > 0 && fileSet.has(currentFile)) {
        chunks.push(currentChunk.join("\n"));
      }
      currentChunk = [line];
      // Extract file path: diff --git a/path b/path
      const match = line.match(/diff --git a\/(.+?) b\//);
      currentFile = match?.[1] ?? "";
    } else {
      currentChunk.push(line);
    }
  }
  // Flush last chunk
  if (currentChunk.length > 0 && fileSet.has(currentFile)) {
    chunks.push(currentChunk.join("\n"));
  }

  const result = chunks.join("\n");

  // Rough token estimate: ~4 chars per token
  const estimatedTokens = result.length / 4;
  if (estimatedTokens > tokenBudget) {
    // Truncate with indicator
    const maxChars = tokenBudget * 4;
    return result.slice(0, maxChars) + "\n\n[TRUNCATED -- diff exceeds token budget]";
  }

  return result;
}
