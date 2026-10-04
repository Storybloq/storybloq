/**
 * T-486 7b: where the compat tests find published CLIs, and what happens when
 * they are missing.
 *
 * `npm run compat:fetch` packs each pinned version into the directory, checks
 * its sha256, and installs it (scripts ignored) under `<dir>/<version>`, once
 * per machine. Tests read only that installed prefix and never the network.
 *
 * Plain mode: a missing or mismatched dist skips its tests, with the reason in
 * the title. Required mode (`STORYBLOQ_COMPAT_REQUIRED=1`, set by
 * prepublishOnly and the preflight stage): the same gap throws, naming the
 * path, version, sha and `npm run compat:fetch`, so nothing ships untested.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OldDistPin {
  readonly version: string;
  readonly sha256: string;
}

const PINS = JSON.parse(readFileSync(join(__dirname, "old-dists.json"), "utf-8")) as { newest: string; dists: OldDistPin[] };

export const OLD_DISTS: readonly OldDistPin[] = PINS.dists;
/** The newest published version when the pins were taken. */
export const NEWEST_PUBLISHED: string = PINS.newest;

export function oldDistDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STORYBLOQ_OLD_DIST_DIR || join(env.HOME || homedir(), ".cache", "storybloq", "old-dists");
}

export function compatRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STORYBLOQ_COMPAT_REQUIRED === "1";
}

export const tarballName = (version: string): string => `storybloq-storybloq-${version}.tgz`;

/** A usable dist, or why not. Pure: never throws. */
export function findOldDist(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; version: string; bin: string } | { ok: false; reason: string } {
  const pin = OLD_DISTS.find((p) => p.version === version);
  if (!pin) return { ok: false, reason: `${version} is not a pinned old dist` };
  const dir = oldDistDir(env);
  const tgz = join(dir, tarballName(version));
  const bin = join(dir, version, "node_modules", ".bin", "storybloq");
  const fix = "run `npm run compat:fetch` in storybloq/";
  if (!existsSync(tgz)) return { ok: false, reason: `missing ${tgz} (storybloq ${version}, sha256 ${pin.sha256}); ${fix}` };
  const sha = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  if (sha !== pin.sha256) return { ok: false, reason: `${tgz} has sha256 ${sha}, expected ${pin.sha256} for storybloq ${version}; delete it and ${fix}` };
  if (!existsSync(bin)) return { ok: false, reason: `storybloq ${version} is not installed at ${bin}; ${fix}` };
  return { ok: true, version, bin };
}

/**
 * The dists a compat file runs: every one present, or in required mode an
 * error naming the first gap. `skip` is the reason to put in a skipped
 * describe's title, null when all are present.
 */
export function requireOldDists(
  versions: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { dists: { version: string; bin: string }[]; skip: string | null } {
  const dists: { version: string; bin: string }[] = [];
  for (const version of versions) {
    const found = findOldDist(version, env);
    if (found.ok) {
      dists.push({ version: found.version, bin: found.bin });
      continue;
    }
    if (compatRequired(env)) throw new Error(`STORYBLOQ_COMPAT_REQUIRED=1: ${found.reason}`);
    return { dists: [], skip: `skipped: ${found.reason}` };
  }
  return { dists, skip: null };
}
