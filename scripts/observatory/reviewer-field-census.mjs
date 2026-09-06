#!/usr/bin/env node
/**
 * T-432 observatory: what the review records actually carry.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. It measures the fleet on the day it is
 * run, and the fleet changes underneath it. Nothing in the suite may depend on
 * its output; it exists so a claim about the data can be CHECKED rather than
 * recalled, which is how the plan's delta about `events.log ticketId` was found
 * to be false for every review event.
 *
 * IT HOLDS ITSELF TO THE SAME RULE AS THE CODE. An unreadable directory is not
 * an empty one, and an exhaustive claim ("no artifact anywhere carries X") is
 * WITHHELD whenever discovery was incomplete, because a census that could not
 * open a directory has not established what is not in it.
 *
 * Usage:
 *   node scripts/observatory/reviewer-field-census.mjs [<dir> ...]
 *
 *   node scripts/observatory/reviewer-field-census.mjs --fleet <dir>
 *
 * With no argument it censuses the current project. Named roots are censused as
 * given. `--fleet <dir>` censuses every `.story/` root beneath <dir>, and is
 * EXPLICIT rather than inferred from whether discovery found anything: inferring
 * it turned an unreadable fleet directory into "a project with no sessions".
 * Root-level results are authoritative; the totals are SUMS OF ROOT OBSERVATIONS
 * and may include duplicate checkouts.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * ABSENT, READ and FAILED are three answers, and collapsing them is the bug
 * this whole ticket is about. `absent` is a fact about the tree; `failed` is a
 * fact about the scan, and only the first supports a conclusion.
 */
async function listDir(p) {
  try { return { kind: "read", entries: await readdir(p) }; }
  catch (e) { return { kind: e?.code === "ENOENT" ? "absent" : "failed", entries: [], reason: e?.code ?? String(e) }; }
}

/**
 * Discover `.story` roots beneath a fleet directory, REPORTING what it could not
 * classify.
 *
 * Swallowing candidate failures let one inaccessible checkout disappear while a
 * readable one went on to report "complete discovery, no suffix anywhere".
 * Reporting those failures in the OTHER script does not qualify THIS script's
 * output.
 */
async function rootsUnder(dir) {
  const listing = await listDir(dir);
  const out = [];
  let unclassifiable = 0;
  for (const name of listing.entries) {
    const candidate = join(dir, name);
    try {
      // A plain file cannot hold `.story`, so ENOTDIR here is determinate.
      if (!(await stat(candidate)).isDirectory()) continue;
      // `.story` MUST BE A DIRECTORY, checked BEFORE descending to `sessions`.
      // Probing `<candidate>/.story/sessions` against a REGULAR FILE named
      // `.story` raises ENOTDIR, which this counted as a candidate it could not
      // classify -- manufacturing uncertainty over a determinate "not a root",
      // and making the exhaustive claims below conditional because of it.
      if (!(await stat(join(candidate, ".story"))).isDirectory()) continue;
    } catch (e) {
      if (e?.code !== "ENOENT") unclassifiable += 1;
      continue;
    }
    try {
      if ((await stat(join(candidate, ".story", "sessions"))).isDirectory()) out.push(candidate);
    } catch (e) {
      if (e?.code !== "ENOENT") unclassifiable += 1;
    }
  }
  return { roots: out, listing: listing.kind, unclassifiable };
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

async function census(roots) {
  const reviewers = new Map();
  const artifactKeys = new Map();
  const findingKeys = new Map();
  const originClasses = new Map();
  const eventKeysByType = new Map();
  let artifacts = 0;
  let findings = 0;
  let generationSuffixed = 0;
  // Failures by SCOPE, the same three the scanner uses.
  const failures = { record: 0, knownSession: 0, rootDiscovery: 0 };
  let schemaInvalid = 0;
  // FILENAME COVERAGE, tracked apart from content validity. Whether a `-gN`
  // suffix exists is decided entirely by names already enumerated, so a file
  // that failed to PARSE cannot invalidate that census -- its name was still
  // read. Only a failure to ENUMERATE can.
  let filenameCoverageIncomplete = false;
  let eventReadFailures = 0;
  let eventParseFailures = 0;
  // EVENT COVERAGE IS ITS OWN AXIS. It was inferred from `incomplete`, which is
  // both too wide and too narrow: a review artifact that failed to PARSE says
  // nothing about the events log beside it, while an inaccessible fleet
  // checkout removes whole sessions of events and did not reach that flag at
  // all. So a root could vanish from the events census without the warning
  // that a missing key does not establish fleet-wide absence.
  let eventCoverageIncomplete = false;

  for (const root of roots) {
    const sessionsDir = join(root, ".story", "sessions");
    const listing = await listDir(sessionsDir);
    // A FAILED root listing can hide whole sessions, so it is root-discovery
    // scope and it disqualifies every exhaustive claim below.
    if (listing.kind === "failed") {
      failures.rootDiscovery += 1;
      filenameCoverageIncomplete = true;
      eventCoverageIncomplete = true;
      continue;
    }

    for (const sid of listing.entries) {
      // CLASSIFY THE ENTRY BEFORE DESCENDING. A regular file sitting in
      // `sessions/` raised ENOTDIR from both reads below, manufacturing a
      // known-session failure and withholding the filename-absence claim, when
      // the answer is determinately "not a session".
      try {
        if (!(await stat(join(sessionsDir, sid))).isDirectory()) continue;
      } catch {
        // ROOT-DISCOVERY scope, ENOENT INCLUDED. `readdir` listed this name, so
        // an entry that is now gone is one we never got to classify, not one
        // that was never there: a session may be invisible either way.
        failures.rootDiscovery += 1;
        filenameCoverageIncomplete = true;
        eventCoverageIncomplete = true;
        continue;
      }

      const reviewsDir = join(sessionsDir, sid, "telemetry", "reviews");
      const reviews = await listDir(reviewsDir);
      // Confined to a session whose existence is established: it hides no other
      // session, but it does hide artifacts, so exhaustive claims still go.
      if (reviews.kind === "failed") {
        failures.knownSession += 1;
        filenameCoverageIncomplete = true;
      }

      for (const f of reviews.entries) {
        if (!f.endsWith(".json")) continue;
        // A `-gN` suffix is what a same-round re-run WOULD write if generations
        // were kept. Counted, because the segmentation convention rests on
        // their absence: with no suffix, a re-run overwrites and erases a real
        // boundary while manufacturing an apparent one.
        if (/-g\d+\.json$/.test(f)) generationSuffixed += 1;
        let d;
        try { d = JSON.parse(await readFile(join(reviewsDir, f), "utf-8")); }
        catch { failures.record += 1; continue; }
        // VALID JSON IS NOT A VALID RECORD. `null` parses and then throws at
        // `Object.keys`, and a non-array `findings` throws in the loop below;
        // either would abort the whole census over one bad file rather than
        // reporting it.
        if (typeof d !== "object" || d === null || Array.isArray(d)) { schemaInvalid += 1; continue; }
        artifacts += 1;
        for (const k of Object.keys(d)) bump(artifactKeys, k);
        if (typeof d.reviewer === "string") bump(reviewers, d.reviewer);
        if (d.findings !== undefined && !Array.isArray(d.findings)) { schemaInvalid += 1; continue; }
        for (const fd of d.findings ?? []) {
          if (typeof fd !== "object" || fd === null) { schemaInvalid += 1; continue; }
          findings += 1;
          for (const k of Object.keys(fd)) bump(findingKeys, k);
          bump(originClasses, String(fd.originClass));
        }
      }

      // P3: the events log. Read for FIELD PRESENCE only. It is not joined to
      // items anywhere in this cut, because session identity does not substitute
      // for item identity: most artifacts sit in sessions carrying more than one
      // target.
      let log;
      try { log = await readFile(join(sessionsDir, sid, "events.log"), "utf-8"); }
      catch (e) {
        // ENOENT is confirmed absence: the session logged no events.
        if (e?.code !== "ENOENT") { eventReadFailures += 1; eventCoverageIncomplete = true; }
        continue;
      }
      for (const line of log.split("\n")) {
        if (line.trim() === "") continue;
        let e;
        try { e = JSON.parse(line); } catch { eventParseFailures += 1; eventCoverageIncomplete = true; continue; }
        if (typeof e !== "object" || e === null || typeof e.type !== "string") {
          eventParseFailures += 1;
          eventCoverageIncomplete = true;
          continue;
        }
        const keys = eventKeysByType.get(e.type) ?? new Map();
        for (const k of Object.keys(e)) bump(keys, k);
        // DESCEND INTO `data`. The rows nest their payload there, so a census
        // of the envelope alone reports `data` on every row and answers
        // nothing -- which is exactly what the first version of this script
        // did, reporting four identical keys for every event type and
        // therefore unable to check the claim it was written to check.
        if (typeof e.data === "object" && e.data !== null && !Array.isArray(e.data)) {
          for (const k of Object.keys(e.data)) bump(keys, `data.${k}`);
        }
        bump(keys, "__rows__");
        eventKeysByType.set(e.type, keys);
      }
    }
  }

  // NO SINGLE `incomplete` AGGREGATE. There was one, and both exhaustive claims
  // below were derived from it, which is how a record-parse failure came to
  // qualify the events census and an inaccessible checkout came to qualify
  // neither. Each population reports its own coverage or it reports nothing.
  return {
    filenameCoverageIncomplete,
    eventCoverageIncomplete,
    roots: roots.length,
    artifacts,
    findings,
    generationSuffixed,
    failures,
    schemaInvalid,
    eventReadFailures,
    eventParseFailures,
    reviewers,
    artifactKeys,
    findingKeys,
    originClasses,
    eventKeysByType,
  };
}

function printMap(title, map, total) {
  console.log(`\n## ${title}`);
  const rows = [...map].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of rows) {
    const share = total > 0 ? ` (${((n / total) * 100).toFixed(1)}%)` : "";
    console.log(`  ${String(n).padStart(6)}${share.padEnd(9)} ${k}`);
  }
  if (rows.length === 0) console.log("  none");
}

// EXPLICIT, not inferred from whether discovery found anything. The old
// fallback turned an UNREADABLE fleet directory into "a project with no
// sessions", which is the conflation this script exists to catch.
const args = process.argv.slice(2);
const fleetMode = args[0] === "--fleet";
const targets = fleetMode ? args.slice(1) : args;
let roots = [];
let discoveryFailures = 0;
if (targets.length === 0) {
  roots = [process.cwd()];
} else if (!fleetMode) {
  roots = targets;
} else {
  for (const dir of targets) {
    const found = await rootsUnder(dir);
    if (found.listing !== "read") {
      console.error(`cannot read fleet directory ${dir}: ${found.listing}`);
      process.exit(1);
    }
    discoveryFailures += found.unclassifiable;
    roots.push(...found.roots);
  }
}

const r = await census(roots);
// A candidate we could not classify may be a ROOT, and a root carries both
// artifact filenames and event rows. It therefore qualifies BOTH populations,
// not just the filename one it used to reach.
if (discoveryFailures > 0) {
  r.filenameCoverageIncomplete = true;
  r.eventCoverageIncomplete = true;
}

console.log("# Reviewer field census");
console.log(`\nRoots: ${r.roots}. Artifacts read: ${r.artifacts}. Findings read: ${r.findings}.`);
console.log(
  `Fleet-discovery candidates that could not be classified: ${discoveryFailures}.`,
);
console.log(
  `Read failures by scope -- record: ${r.failures.record}, `
  + `known-session: ${r.failures.knownSession}, root-discovery: ${r.failures.rootDiscovery}. `
  + `Schema-invalid records: ${r.schemaInvalid}. `
  + `Events read failures: ${r.eventReadFailures}, parse failures: ${r.eventParseFailures}.`,
);
console.log("\nEVERY COUNT BELOW IS AN OBSERVED COUNT over what was successfully read.");

console.log(`\nArtifacts with a -gN generation suffix: ${r.generationSuffixed} (observed).`);
if (r.generationSuffixed > 0) {
  // PRESENCE is established by one observation. An incomplete scan elsewhere
  // cannot unsee a filename that was read, and saying UNKNOWN here would be
  // manufactured uncertainty over determinate evidence.
  console.log("  Generations are present; the overwrite assumption needs revisiting.");
} else if (r.filenameCoverageIncomplete) {
  // ABSENCE is the claim that needs complete ENUMERATION -- of names, not of
  // contents. A record that failed to parse still had its name read.
  console.log("  Filename enumeration was INCOMPLETE, so absence is not established.");
  console.log("  Whether generations exist anywhere is UNKNOWN.");
} else {
  console.log("  Every artifact filename was enumerated and no suffix appears anywhere,");
  console.log("  so a same-round re-run OVERWRITES: segment boundaries are a");
  console.log("  reconstruction, not a record.");
}

printMap("reviewer strings", r.reviewers, r.artifacts);
printMap("artifact keys", r.artifactKeys, r.artifacts);
printMap("finding keys", r.findingKeys, r.findings);
printMap("originClass values (undefined = unlabelled)", r.originClasses, r.findings);

console.log("\n## events.log keys, by event type");
console.log("  Checks whether an event type carries item identity. A review event");
console.log("  that does NOT carry ticketId cannot be joined to a work item.");
if (r.eventCoverageIncomplete) {
  console.log("  Event coverage was INCOMPLETE: absence of a key below is absence IN WHAT");
  console.log("  WAS READ, and does not establish that no row anywhere carries it.");
}
for (const [type, keys] of [...r.eventKeysByType].sort()) {
  const rows = keys.get("__rows__") ?? 0;
  const named = [...keys].filter(([k]) => k !== "__rows__").map(([k, n]) => `${k}:${n}`).sort();
  console.log(`  ${type} (${rows} rows): ${named.join(", ")}`);
}
