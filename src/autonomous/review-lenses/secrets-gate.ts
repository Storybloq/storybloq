/**
 * Data classification gate -- scans for secrets before fan-out.
 *
 * Uses detect-secrets (Yelp, MIT) on working tree files.
 * Graceful degradation: if not installed, logs warning and proceeds.
 */

import { execFileSync, execSync } from "node:child_process";
import { resolveAndValidate } from "./path-safety.js";
import type { LensFinding } from "./types.js";

export interface SecretsGateResult {
  readonly active: boolean;
  readonly secretsFound: boolean;
  readonly redactedLines: ReadonlyMap<string, readonly number[]>;
  readonly metaFinding: LensFinding | null;
}

export function runSecretsGate(
  changedFiles: readonly string[],
  projectRoot: string,
  requireGate: boolean,
): SecretsGateResult {
  // Check if detect-secrets is installed and get its path
  const binaryPath = findDetectSecrets();
  const installed = binaryPath !== null;

  if (!installed) {
    if (requireGate) {
      throw new Error(
        "detect-secrets is required (requireSecretsGate: true) but not installed. " +
          "Install with: pip install detect-secrets",
      );
    }
    return { active: false, secretsFound: false, redactedLines: new Map(), metaFinding: null };
  }

  // Run detect-secrets on changed files
  const redactedLines = new Map<string, number[]>();
  let secretsFound = false;

  for (const file of changedFiles) {
    // Path traversal + symlink protection
    if (!resolveAndValidate(projectRoot, file)) continue;

    try {
      const output = execFileSync(
        binaryPath!,
        ["scan", "--", file],
        { cwd: projectRoot, encoding: "utf-8", timeout: 10_000 },
      );
      const parsed = JSON.parse(output);
      const results = parsed?.results ?? {};
      for (const [filePath, secrets] of Object.entries(results)) {
        if (Array.isArray(secrets) && secrets.length > 0) {
          secretsFound = true;
          const lines = secrets
            .map((s: { line_number?: number }) => s.line_number)
            .filter((n: unknown): n is number => typeof n === "number");
          redactedLines.set(filePath, lines);
        }
      }
    } catch {
      // detect-secrets failed on this file -- continue
    }
  }

  // T-253: build one EvidenceItem per redacted file. File/line stay null so
  // `enforceLocationInvariant` passes trivially (producer-array path with
  // null legacy components). T-255 exempts the
  // (lens="orchestrator", category="hardcoded-secrets") pair from
  // substring/line verification because the redacted placeholder cannot be
  // matched against the pre-redaction snapshot.
  const metaFinding: LensFinding | null = secretsFound
    ? {
        lens: "orchestrator",
        lensVersion: "gate-v1",
        severity: "critical",
        recommendedImpact: "blocker",
        category: "hardcoded-secrets",
        description:
          "Detected potential secrets in diff. Lines redacted before passing to review lenses.",
        file: null,
        line: null,
        evidence: Array.from(redactedLines.keys()).map((filePath) => ({
          file: filePath,
          startLine: 1,
          endLine: 1,
          code: "[REDACTED -- potential secret]",
        })),
        suggestedFix: "Remove secrets from source code. Use environment variables or a secrets manager.",
        confidence: 0.9,
        assumptions: null,
        requiresMoreContext: false,
      }
    : null;

  return { active: true, secretsFound, redactedLines, metaFinding };
}

function findDetectSecrets(): string | null {
  try {
    // Capture absolute path for reliable invocation regardless of PATH changes
    const cmd = process.platform === "win32" ? "where detect-secrets" : "command -v detect-secrets";
    const path = execSync(cmd, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    return path || null;
  } catch {
    return null;
  }
}

export function redactContent(
  content: string,
  linesToRedact: readonly number[],
): string {
  if (linesToRedact.length === 0) return content;
  const lines = content.split("\n");
  const redactSet = new Set(linesToRedact);
  return lines
    .map((line, i) =>
      redactSet.has(i + 1) ? "[REDACTED -- potential secret]" : line,
    )
    .join("\n");
}
