/**
 * ISS-570: Update-notifier for the storybloq CLI + MCP server.
 *
 * On every CLI invocation and in storybloq_status, we want to know whether
 * a newer @storybloq/storybloq exists on the npm registry. We cache the
 * registry answer for 6 hours in a small JSON file so the check costs at
 * most four HTTP requests per day per machine across ALL entry points, and
 * zero requests when NO_UPDATE_NOTIFIER or CI is set (ISS-777).
 *
 * Cache location: ~/.claude/storybloq/update-check.json
 *   (hidden from git-scoped .story/ by being outside the project)
 *
 * Design:
 * - The 6h freshness gate lives in one helper (isCacheFresh) and is applied
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

import { writeFileSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { readBoundedFile } from "./bounded-read.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@storybloq/storybloq/latest";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (ISS-1237: a day hid a same-day release)
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
 * Whether a cache entry is still within the 6-hour freshness window.
 * Single source of the age math (ISS-777): shared by readCache (which backs
 * checkForUpdate + readUpdateCacheSync) and refreshUpdateCacheInBackground so
 * no entry point can drift from the once-per-six-hours contract.
 */
function isCacheFresh(cache: UpdateCache): boolean {
  return Date.now() - cache.fetchedAt <= CACHE_TTL_MS;
}

/**
 * Read + shape-validate the cache file. Does NOT apply the freshness window,
 * so callers that need to distinguish "stale" from "absent" can.
 */
/**
 * T-502: bounded. This file sits in a user-writable directory and is read on
 * the CLI startup path, in `storybloq_status`, and now synchronously inside
 * `storybloq health` before its fetch timer is even armed. An unbounded
 * `readFileSync` there would hang forever on a FIFO planted at the cache's
 * name and would happily load an oversized replacement into memory. The cap
 * is far above anything this two-field document can legitimately be.
 */
const CACHE_MAX_BYTES = 65_536;

function readCacheRaw(): UpdateCache | null {
  try {
    const body = readBoundedFile(cachePath(), CACHE_MAX_BYTES);
    if (body === null) return null;
    const data = JSON.parse(body) as UpdateCache;
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

/**
 * T-502: write-then-rename, the limit-ledger pattern.
 *
 * Two reasons, both about not making things worse than they were. A truncating
 * `writeFileSync` that fails partway (disk full, interrupted) destroys a
 * previously valid cache and leaves a corrupt one behind. And it FOLLOWS a
 * symlink at the cache path, which would let a cache write land on some other
 * file entirely -- unacceptable for a command whose only permitted write this
 * is. `renameSync` replaces the path itself, symlink included, atomically.
 */
function writeCache(latestVersion: string): void {
  const p = cachePath();
  // The temp path is only ever unlinked once the EXCLUSIVE open has
  // succeeded. Cleaning up on an EEXIST would delete a file this invocation
  // never created, which is another writer's in-flight temp.
  let owned: { path: string; fd: number } | null = null;
  try {
    mkdirSync(join(homedir(), ".claude", "storybloq"), { recursive: true });
    const data: UpdateCache = { latestVersion, fetchedAt: Date.now() };
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${randomBytes(2).toString("hex")}`;
    const fd = openSync(tmp, "wx", 0o600);
    owned = { path: tmp, fd };
    writeFileSync(fd, JSON.stringify(data, null, 2), "utf-8");
    closeSync(fd);
    owned = { path: tmp, fd: -1 };
    renameSync(tmp, p);
    owned = null;
  } catch {
    // Cache write is best-effort: the prior contents survive untouched.
  } finally {
    if (owned !== null) {
      if (owned.fd >= 0) {
        try {
          closeSync(owned.fd);
        } catch {
          // ignore
        }
      }
      try {
        unlinkSync(owned.path);
      } catch {
        // ignore
      }
    }
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

/**
 * T-502: the abort timer stays ARMED through `res.json()` and is cleared in
 * `finally`. Before this, the timer was cleared as soon as the response
 * HEADERS arrived, so a registry (or a captive portal) that answered with
 * headers and then stalled the body left the await hanging with no cap at
 * all -- on the health check's synchronous path that is the difference
 * between a 2 second skip and a wedged command. The timeout is a parameter
 * because the health check budgets it from the remaining run budget; the
 * background caller keeps the original constant.
 */
async function fetchLatestFromNpm(timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string | null> {
  if (shouldSuppressUpdateFetch()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
 * Uses a 6-hour cache. Returns null on network failure or when running a
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
 * fresh -- enforcing the once-per-six-hours, opt-out-respecting contract at the
 * FETCH layer across all entry points.
 */
export function refreshUpdateCacheInBackground(): void {
  if (shouldSuppressUpdateFetch()) return;
  const cached = readCacheRaw();
  if (cached && isCacheFresh(cached)) return;
  void fetchLatestFromNpm(FETCH_TIMEOUT_MS).then((v) => {
    if (v) writeCache(v);
  });
}

/**
 * T-502: the AWAITED refresh the `cli-version` health check needs.
 *
 * One cache, one TTL, one contract: this is the same
 * `~/.claude/storybloq/update-check.json` the startup banner and
 * `storybloq_status` already share, so a health run costs at most the one
 * registry request per day that the CLI already permits itself.
 *
 * Returns the cached answer when it is fresh and `force` is false; otherwise
 * fetches under `timeoutMs` and writes. A failed fetch returns null and
 * leaves the cache file byte-identical, so the caller reports "offline"
 * rather than a stale claim. A corrupt cache counts as absent and is
 * rewritten on the next success.
 *
 * `currentVersion` is needed to shape the `UpdateInfo` verdict; it is not
 * stored, and a dev or non-release version is refused outright because the
 * comparison would be meaningless.
 */
export async function refreshUpdateCache(opts: {
  currentVersion: string;
  force?: boolean;
  timeoutMs?: number;
}): Promise<UpdateInfo | null> {
  const { currentVersion } = opts;
  if (!currentVersion || currentVersion === "0.0.0-dev") return null;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  if (timeoutMs <= 0) return null;
  const cached = readCacheRaw();
  if (!opts.force && cached && isCacheFresh(cached)) {
    return {
      currentVersion,
      latestVersion: cached.latestVersion,
      updateAvailable: compareVersions(currentVersion, cached.latestVersion) < 0,
    };
  }
  const latestVersion = await fetchLatestFromNpm(timeoutMs);
  if (!latestVersion) return null;
  writeCache(latestVersion);
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(currentVersion, latestVersion) < 0,
  };
}

/**
 * Format a one-line stderr banner when an update is available. Returns an
 * empty string if no update is available.
 */
export function formatUpdateBanner(info: UpdateInfo | null): string {
  if (!info || !info.updateAvailable) return "";
  return (
    `\nstorybloq v${info.latestVersion} is available (you have v${info.currentVersion}).\n` +
    `Update: storybloq update\n`
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
