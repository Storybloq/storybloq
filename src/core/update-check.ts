/**
 * ISS-570: Update-notifier for the storybloq CLI + MCP server.
 *
 * On every CLI invocation and in storybloq_status, we want to know whether
 * a newer @storybloq/storybloq exists on the npm registry. We cache the
 * registry answer for 24 hours in a small JSON file so the check costs at
 * most one HTTP request per day per machine across ALL entry points, and
 * zero requests when NO_UPDATE_NOTIFIER or CI is set (ISS-777).
 *
 * Cache location: ~/.claude/storybloq/update-check.json
 *   (hidden from git-scoped .story/ by being outside the project)
 *
 * Design:
 * - The 24h freshness gate lives in one helper (isCacheFresh) and is applied
 *   at the FETCH layer (refreshUpdateCacheInBackground), not just when reading
 *   the cache, so no caller can accidentally phone the registry per-invocation.
 * - The NO_UPDATE_NOTIFIER/CI opt-out lives in one helper
 *   (shouldSuppressUpdateFetch) enforced INSIDE fetchLatestFromNpm, the single
 *   fetch site, so every caller (checkForUpdate,
 *   refreshUpdateCacheInBackground, and any future one) inherits it.
 * - Network call is best-effort. Any failure (offline, registry down,
 *   timeout) silently returns null. Updates are opt-in helpful, not
 *   required for correctness.
 * - The CLI banner and MCP status use the same cache, so they don't
 *   double-hit the registry.
 * - Semver compare is done via a minimal inline comparator (no new deps).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@storybloq/storybloq/latest";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 2000; // Short timeout so CLI startup is never delayed.

interface UpdateCache {
  latestVersion: string;
  fetchedAt: number; // ms since epoch
}

/** Public shape returned from checkForUpdate. */
export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

/** ISS-1091 (F10): exported for the e2e acceptance probe's audited-path list. */
export function cachePath(): string {
  return join(homedir(), ".claude", "storybloq", "update-check.json");
}

/**
 * Whether a cache entry is still within the 24-hour freshness window.
 * Single source of the age math (ISS-777): shared by readCache (which backs
 * checkForUpdate + readUpdateCacheSync) and refreshUpdateCacheInBackground so
 * no entry point can drift from the once-per-day contract.
 */
function isCacheFresh(cache: UpdateCache): boolean {
  return Date.now() - cache.fetchedAt <= CACHE_TTL_MS;
}

/**
 * Read + shape-validate the cache file. Does NOT apply the freshness window,
 * so callers that need to distinguish "stale" from "absent" can.
 */
function readCacheRaw(): UpdateCache | null {
  try {
    const p = cachePath();
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf-8")) as UpdateCache;
    if (typeof data.latestVersion !== "string" || typeof data.fetchedAt !== "number") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function readCache(): UpdateCache | null {
  const data = readCacheRaw();
  if (!data) return null;
  return isCacheFresh(data) ? data : null;
}

function writeCache(latestVersion: string): void {
  try {
    const p = cachePath();
    mkdirSync(join(homedir(), ".claude", "storybloq"), { recursive: true });
    const data: UpdateCache = { latestVersion, fetchedAt: Date.now() };
    writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Cache write is best-effort.
  }
}

/**
 * Privacy opt-out for the registry fetch (ISS-777): NO_UPDATE_NOTIFIER or CI
 * set-and-non-empty suppresses ALL update-check network traffic. Same
 * semantics as shouldEmitUpdateBanner's env guards (CI="false" deliberately
 * counts as set; empty string does not). Enforced inside fetchLatestFromNpm,
 * the single fetch site, so every present and future caller inherits it.
 */
function shouldSuppressUpdateFetch(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NO_UPDATE_NOTIFIER !== undefined && env.NO_UPDATE_NOTIFIER !== "") return true;
  if (env.CI !== undefined && env.CI !== "") return true;
  return false;
}

async function fetchLatestFromNpm(): Promise<string | null> {
  if (shouldSuppressUpdateFetch()) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Simple semver comparator. Returns:
 *   -1 if a < b, 0 if a === b, 1 if a > b.
 * Ignores pre-release suffixes (1.2.3-rc.1 compared as 1.2.3).
 * Invalid input returns 0 (treat as equal = no-op).
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split("-")[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Check whether a newer @storybloq/storybloq is available.
 * Uses a 24-hour cache. Returns null on network failure or when running a
 * dev version ("0.0.0-dev") where comparison is meaningless.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  if (!currentVersion || currentVersion === "0.0.0-dev") return null;

  const cached = readCache();
  let latestVersion = cached?.latestVersion ?? null;

  if (!latestVersion) {
    latestVersion = await fetchLatestFromNpm();
    if (latestVersion) writeCache(latestVersion);
  }

  if (!latestVersion) return null;

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(currentVersion, latestVersion) < 0,
  };
}

/**
 * Synchronous cache-only variant. Never hits the network. Used by the
 * storybloq_status MCP tool, which must not block on I/O. If the cache is
 * cold or stale, returns null; a parallel async refresh can be triggered
 * by the caller via refreshUpdateCacheInBackground().
 */
export function readUpdateCacheSync(currentVersion: string): UpdateInfo | null {
  if (!currentVersion || currentVersion === "0.0.0-dev") return null;
  const cached = readCache();
  if (!cached) return null;
  return {
    currentVersion,
    latestVersion: cached.latestVersion,
    updateAvailable: compareVersions(currentVersion, cached.latestVersion) < 0,
  };
}

/**
 * Fire-and-forget background refresh of the update cache. Safe to call from
 * any context; errors are swallowed. Useful from storybloq_status so the
 * next call has fresh data.
 *
 * ISS-777: this runs on EVERY CLI dispatch (via preCommandHousekeeping) and
 * on every storybloq_status call, so it must not hit the network unless a
 * refresh is actually due. It (a) honors the NO_UPDATE_NOTIFIER/CI opt-outs
 * (also enforced at the fetch site itself; the early return here just avoids
 * pointless work), and (b) skips the fetch entirely while the cache is still
 * fresh -- enforcing the once-per-day, opt-out-respecting contract at the
 * FETCH layer across all entry points.
 */
export function refreshUpdateCacheInBackground(): void {
  if (shouldSuppressUpdateFetch()) return;
  const cached = readCacheRaw();
  if (cached && isCacheFresh(cached)) return;
  void fetchLatestFromNpm().then((v) => {
    if (v) writeCache(v);
  });
}

/**
 * Format a one-line stderr banner when an update is available. Returns an
 * empty string if no update is available.
 */
export function formatUpdateBanner(info: UpdateInfo | null): string {
  if (!info || !info.updateAvailable) return "";
  return (
    `\nstorybloq v${info.latestVersion} is available (you have v${info.currentVersion}).\n` +
    `Update: npm install -g @storybloq/storybloq@latest\n`
  );
}

/**
 * Whether the CLI should print the update banner at all (ISS-736).
 *
 * The COMMAND guard is the primary fix for the observed defect: git spawns
 * the merge driver once per merged .story file and the driver inherits git's
 * stderr, which in an interactive `git merge` IS a TTY -- so the TTY guard
 * alone would not have stopped the observed per-file banner pollution. Do
 * not remove the command check as "redundant with TTY".
 *
 * The TTY guard covers pipes, plumbing, and CI runners structurally.
 * NO_UPDATE_NOTIFIER is the conventional opt-out. CI is suppressed whenever
 * set non-empty, deliberately including CI="false" (some tools set it to
 * mean not-CI): a real terminal still gets the banner via the TTY path in
 * practice, and CI-shaped environments never want stderr noise.
 */
export function shouldEmitUpdateBanner(opts: {
  stderrIsTTY: boolean;
  env: Record<string, string | undefined>;
  command?: string;
}): boolean {
  if (opts.command === "merge-driver") return false;
  if (!opts.stderrIsTTY) return false;
  if (opts.env.NO_UPDATE_NOTIFIER !== undefined && opts.env.NO_UPDATE_NOTIFIER !== "") return false;
  if (opts.env.CI !== undefined && opts.env.CI !== "") return false;
  return true;
}
