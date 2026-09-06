#!/usr/bin/env node
/**
 * T-432 observatory: are N roots N projects?
 *
 * They are not, and this script is why the plan says so. Roots carrying
 * `.story/` include the same repository checked out several times and roots with
 * no git origin at all, so a cross-root total is a SUM OF ROOT OBSERVATIONS,
 * never a count of unique fleet activity.
 *
 * ORIGIN GROUPING DOES NOT FIX THIS, and the script reports rather than resolves:
 *  - two checkouts can hold copies of the same session,
 *  - one repository can present different SSH and HTTPS origins,
 *  - some roots present no origin to group by.
 * So a duplicate group holding disjoint session ids is an OBSERVATION on the day
 * it is run, not an invariant to build on.
 *
 * EVERY CLAIM HERE IS CONDITIONED ON COMPLETE READS. Disjointness in particular:
 * it is a claim about what is NOT shared, so one unreadable listing can make it
 * false, and it is withheld rather than asserted whenever a group's listings
 * were incomplete.
 *
 * Usage:
 *   node scripts/observatory/fleet-root-identity.mjs <dir>
 */
import { readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, basename } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * ABSENT and UNREADABLE are different answers and this returns which.
 *
 * The first version collapsed both to null and then reported 35 roots whose
 * listing "could not be read", when almost all of them simply have no sessions
 * directory. That is the exact conflation the rest of this ticket exists to
 * prevent, committed by the script written to check it.
 */
async function listDir(p) {
  try { return { kind: "read", entries: await readdir(p) }; }
  catch (e) { return { kind: e?.code === "ENOENT" ? "absent" : "failed", entries: [], reason: e?.code ?? String(e) }; }
}

/**
 * Four answers, because there are four situations and only one is an error.
 *
 * `git remote get-url origin` exits non-zero when there is no origin, when the
 * tree is not a repository at all, AND when git is missing or the call is
 * denied. Mapping all of those to "no origin" turns an error into affirmative
 * evidence -- but mapping them all to "unknown" is the same mistake mirrored,
 * and manufactures uncertainty where the answer is determinate. So:
 *
 *  - `present`      : a remote named origin, with a url.
 *  - `no-origin`    : a repository whose remote list does not include origin.
 *  - `not-a-repo`   : not a git repository, which determinately has no origin.
 *  - `failed`       : we could not tell. Only this one is unknown.
 */
async function originOf(root) {
  let remotes;
  try {
    remotes = (await run("git", ["-C", root, "remote"])).stdout.split("\n").map((x) => x.trim());
  } catch (e) {
    const stderr = String(e?.stderr ?? "");
    // Determinate: there is no repository here, so there is no origin. Matched
    // on git's own message because the exit code alone (128) covers other
    // failures too.
    if (/not a git repository/i.test(stderr)) return { kind: "not-a-repo" };
    return { kind: "failed", reason: e?.code ?? e?.message ?? String(e) };
  }
  if (!remotes.includes("origin")) return { kind: "no-origin" };
  try {
    const url = (await run("git", ["-C", root, "remote", "get-url", "origin"])).stdout.trim();
    return url === "" ? { kind: "failed", reason: "empty url" } : { kind: "present", url };
  } catch (e) {
    return { kind: "failed", reason: e?.code ?? e?.message ?? String(e) };
  }
}

async function sessionIdsOf(root) {
  const dir = join(root, ".story", "sessions");
  const { kind, entries } = await listDir(dir);
  const ids = [];
  let unclassifiable = 0;
  for (const name of entries) {
    try {
      if ((await stat(join(dir, name))).isDirectory()) ids.push(name);
    } catch { unclassifiable += 1; }
  }
  return { ids, listing: kind, unclassifiable };
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: fleet-root-identity.mjs <dir>");
  process.exit(2);
}

// A DISCOVERY DIRECTORY THAT CANNOT BE READ IS AN ERROR, not zero roots.
// Reporting "0 roots, no duplicates" over an unopenable directory is the
// failure this script exists to expose.
const discovery = await listDir(dir);
if (discovery.kind !== "read") {
  console.error(`cannot read ${dir}: ${discovery.kind} (${discovery.reason ?? "no reason"})`);
  process.exit(1);
}

const roots = [];
let unclassifiableCandidates = 0;
for (const name of discovery.entries) {
  const candidate = join(dir, name);
  try {
    // CLASSIFY THE CANDIDATE FIRST. A plain file cannot contain `.story`, so
    // `stat(file/.story)` returns ENOTDIR -- a DEFINITIVE "not a root", not an
    // unknown. Counting it as unclassifiable manufactures uncertainty that does
    // not exist: this directory holds a .zip, a .pem and a .txt, and the first
    // version reported all 27 such files as candidates it could not classify.
    if (!(await stat(candidate)).isDirectory()) continue;
  } catch (e) {
    if (e?.code !== "ENOENT") unclassifiableCandidates += 1;
    continue;
  }
  try {
    // `.story` MUST BE A DIRECTORY. A directory containing a regular FILE named
    // `.story` was counted as a root, and its sessions listing then failed with
    // ENOTDIR and was reported as unreadable -- manufacturing both a root
    // observation and an uncertainty, where the answer is determinately "not a
    // .story directory".
    if (!(await stat(join(candidate, ".story"))).isDirectory()) continue;
    roots.push(candidate);
  } catch (e) {
    // ENOENT is "not a root". Anything else means we could not tell, and a
    // candidate we could not classify may be a root that is now invisible.
    if (e?.code !== "ENOENT") unclassifiableCandidates += 1;
  }
}

const rows = [];
for (const root of roots) {
  const [origin, sessions] = await Promise.all([originOf(root), sessionIdsOf(root)]);
  rows.push({ root, origin, ...sessions });
}

const failedListings = rows.filter((r) => r.listing === "failed").length;
const totalUnclassifiable = rows.reduce((n, r) => n + r.unclassifiable, 0);
const rootsIncomplete = unclassifiableCandidates > 0;

console.log("# Fleet root identity");
console.log(`\nRoots carrying .story/: ${rows.length}${rootsIncomplete ? " (INCOMPLETE, see below)" : ""}`);
console.log(`Candidates that could not be classified: ${unclassifiableCandidates}`);
if (rootsIncomplete) {
  console.log("  A candidate we could not classify may be a root, so the root count is a");
  console.log("  LOWER BOUND and the duplicate search below may be missing checkouts.");
}
const noOrigin = rows.filter((r) => r.origin.kind === "no-origin").length;
const notARepo = rows.filter((r) => r.origin.kind === "not-a-repo").length;
console.log(`Roots with NO origin, determinately: ${noOrigin + notARepo} `
  + `(${noOrigin} are repositories with no origin remote, ${notARepo} are not repositories at all)`);
console.log(`Roots whose origin could not be determined: ${rows.filter((r) => r.origin.kind === "failed").length}`);
console.log(`Roots with NO sessions directory (absent, not a failure): ${rows.filter((r) => r.listing === "absent").length}`);
console.log(`Roots whose session listing FAILED to read: ${failedListings}`);
console.log(`Entries that could not be classified (a name that may or may not be a session): ${totalUnclassifiable}`);

// Group by the repository NAME as well as the origin url, because one
// repository can present different SSH and HTTPS origins and would otherwise
// look like two. A root whose origin could NOT be determined is grouped alone:
// guessing which repository it belongs to would invent a duplicate or hide one.
const byName = new Map();
for (const r of rows) {
  const key = r.origin.kind === "present"
    ? `repo:${r.origin.url.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "")}`
    : r.origin.kind === "failed"
      // Grouped ALONE: guessing which repository a root with an undetermined
      // origin belongs to would either invent a duplicate or hide one.
      ? `origin-unknown:${r.root}`
      : `path:${basename(r.root)}`;
  byName.set(key, [...(byName.get(key) ?? []), r]);
}

console.log("\n## Repositories checked out more than once");
let duplicates = 0;
for (const [key, group] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
  if (group.length < 2) continue;
  duplicates += 1;
  const withSessions = group.filter((r) => r.ids.length > 0);
  console.log(`\n  ${key} -- ${group.length} checkouts, ${withSessions.length} with sessions`);
  for (const r of group) console.log(`    ${r.root} (${r.ids.length} sessions, listing ${r.listing})`);

  // Do the copies share session ids? Reported, not assumed either way.
  const seen = new Map();
  for (const r of group) for (const id of r.ids) seen.set(id, [...(seen.get(id) ?? []), r.root]);
  const shared = [...seen].filter(([, where]) => where.length > 1);

  // DISJOINTNESS IS A CLAIM ABOUT WHAT IS NOT THERE, so it needs every member's
  // listing to be complete. With one unreadable listing, its ids are simply
  // missing from `seen`, and the script would assert disjointness precisely
  // where the duplicates it cannot see would live.
  const complete = group.every((r) => r.listing !== "failed" && r.unclassifiable === 0);
  if (shared.length > 0) {
    console.log(`    ${shared.length} session id(s) appear under more than one checkout`);
  } else if (complete) {
    console.log("    session ids are DISJOINT across these checkouts (today; not an invariant)");
  } else {
    console.log("    no shared session ids OBSERVED; disjointness UNKNOWN (a listing in this");
    console.log("    group was incomplete, so unseen ids could overlap)");
  }
}
if (duplicates === 0) console.log("  none");

const totalSessions = rows.reduce((n, r) => n + r.ids.length, 0);
console.log(`\n## Totals`);
console.log(`  sumOfRootObservations (sessions): ${totalSessions}`);
console.log("  This is a SUM, not a count of unique fleet activity: duplicate");
console.log("  checkouts and roots without an origin are both present above.");
if (failedListings > 0 || totalUnclassifiable > 0 || rootsIncomplete) {
  console.log("  Reads were INCOMPLETE, so this sum is a lower bound.");
}
