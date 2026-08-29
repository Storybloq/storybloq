import { createRequire } from "node:module";
import type { Config } from "../models/config.js";
import { ProjectLoaderError } from "./errors.js";

// Canonical team-feature vocabulary the CLI implements. ISS-684: this MUST stay
// byte-for-byte identical to the Swift Config.TeamCapabilities.supportedFeatures
// (ClaudeStoryModels/Config.swift) -- both write paths gate on the same set so a
// partially-implemented client fails closed.
export const SUPPORTED_TEAM_FEATURES = new Set([
  "canonical-ids",
  "claims",
  "fractional-rank",
  "global-conflict-blocking",
  "merge-driver",
  "reconcile",
  "remote-ref-reservations",
  "resolver",
  "team-config",
  "tombstones",
]);

// ISS-748: the version MUST come from the build-time constant in bundled builds.
// tsup's `define` replaces the exact dotted expression `process.env.STORYBLOQ_VERSION`
// with the package version literal in every dist bundle (do not rewrite to bracket
// access or destructuring -- esbuild only substitutes the dotted form). The relative
// require below is only correct from the src tree; from dist/ it resolves outside
// the package root (missing on npm installs, the workspace root in this monorepo).
export function currentCliVersion(): string | null {
  const baked = process.env.STORYBLOQ_VERSION;
  if (typeof baked === "string" && baked.trim() !== "") return baked;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function compareVersionStrings(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pb = b.split(/[.-]/).map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export function isTeamModeConfig(config: Pick<Config, "team">): boolean {
  return config.team?.enabled === true;
}

export function assertTeamWriteCapabilities(config: Config): void {
  const team = config.team;
  if (!isTeamModeConfig(config)) return;
  // isTeamModeConfig already guarantees `team` is defined here (it returns
  // early otherwise) -- TS can't narrow across that separate function call,
  // so this guard is pure narrowing, never reachable in practice.
  if (!team) return;

  const minCliVersion = team.minCliVersion;
  if (typeof minCliVersion === "string" && minCliVersion.trim() !== "") {
    const current = currentCliVersion();
    if (!current) {
      throw new ProjectLoaderError(
        "version_mismatch",
        `Cannot verify storybloq CLI version against required ${minCliVersion}. Run: npm update -g @storybloq/storybloq`,
      );
    }
    if (compareVersionStrings(current, minCliVersion) < 0) {
      throw new ProjectLoaderError(
        "version_mismatch",
        `This project requires storybloq CLI ${minCliVersion} or later; current CLI is ${current}. Run: npm update -g @storybloq/storybloq`,
      );
    }
  }

  const requiredFeatures = Array.isArray(team.requiredFeatures) ? team.requiredFeatures : [];
  const unsupported = requiredFeatures.filter((feature) => !SUPPORTED_TEAM_FEATURES.has(feature));
  if (unsupported.length > 0) {
    throw new ProjectLoaderError(
      "version_mismatch",
      `This project requires unsupported team feature(s): ${unsupported.join(", ")}. Run: npm update -g @storybloq/storybloq`,
    );
  }
}
