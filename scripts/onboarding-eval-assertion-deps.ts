// T-538 S5b-0 commit 4: what every assertion reads from the attempt's archive (plan section 9,
// Declared dependencies). One row per check in applySetupRunChecks, applySetupReviewChecks,
// applySessionChecks and inspectAfter, keyed function:rule. A row whose evidence was not materialized,
// was omitted, or lies under a missing root blocks the assertion: it does not execute and records
// `evidence-blocked: <path>, <class>`, which section 17 treats as unexecuted. Paths are relative to the
// attempt archive's root (/vol/att). Nothing calls this yet; the conversion commit does.
import type { Extraction } from "./onboarding-eval-reader.js";

export type Dep = { readonly file: string } | { readonly tree: string };

const EVENTS = "eval-events/events.jsonl";
const SNAPSHOT = "eval-events/events.jsonl.setup-snapshot.json";
const STORY = "project/.story";
const TICKETS = `${STORY}/tickets`;
/** inspectAfter reads all of these before its first check, so every check after the config gate depends on them. */
const INSPECT_READS: readonly Dep[] = [
  { file: `${STORY}/config.json` }, { file: `${STORY}/roadmap.json` }, { tree: TICKETS }, { tree: `${STORY}/handovers` }, { tree: `${STORY}/notes` },
];
/** Rules 1 to 6 judge the calls up to the boundary the events log fixes, against the archive's snapshot (checkset7.ts header). */
const BEFORE_BOUNDARY: readonly Dep[] = [{ file: EVENTS }, { file: SNAPSHOT }];
/** The variant checks read the events log, its mapping, the snapshot's tickets and the final tickets. */
const SESSION_READS: readonly Dep[] = [{ file: EVENTS }, { file: SNAPSHOT }, { tree: TICKETS }];

export const ASSERTION_DEPS: Readonly<Record<string, readonly Dep[]>> = {
  // applySetupReviewChecks (checkset6.ts): the turns, and rule 2's stored revisions.
  "setup-review:rule-1": [],
  "setup-review:rule-2": [{ tree: "store" }],
  "setup-review:rule-3": [],
  "setup-review:rule-4": [],
  // applySetupRunChecks (checkset7.ts, checkset7-events.ts, checkset7-writes.ts).
  "setup-run:rule-1": BEFORE_BOUNDARY,
  "setup-run:rule-2": BEFORE_BOUNDARY,
  "setup-run:rule-3": BEFORE_BOUNDARY,
  "setup-run:rule-4": BEFORE_BOUNDARY,
  "setup-run:rule-5": BEFORE_BOUNDARY,
  "setup-run:rule-6": BEFORE_BOUNDARY,
  "setup-run:rule-7": [{ file: EVENTS }],
  "setup-run:rule-8": [{ file: EVENTS }, { tree: STORY }],
  "setup-run:rule-9": [{ file: EVENTS }, { file: SNAPSHOT }, { tree: STORY }],
  "setup-run:rule-10": [{ file: EVENTS }],
  // applySessionChecks (sessions.ts): the artifacts the variant requires, then its variant's checks.
  "session:artifact": [{ tree: "eval-events" }],
  "session:interrupted": SESSION_READS,
  "session:edited": SESSION_READS,
  "session:demo": SESSION_READS,
  "session:order": SESSION_READS,
  "session:restart": SESSION_READS,
  // inspectAfter (drive.ts), one row per failure it can record.
  "inspect:no-final-turn": [],
  "inspect:no-story-after-approval": [{ file: `${STORY}/config.json` }],
  "inspect:ticketFindings": INSPECT_READS,
  "inspect:recipe-x": INSPECT_READS,
  "inspect:approvedLevel.findings": INSPECT_READS,
  "inspect:recipeFindings": INSPECT_READS,
  "inspect:no-coverage-map-in-the-setup-note-or-handover": INSPECT_READS,
  "inspect:the-review-skip-is-not-recorded": INSPECT_READS,
  "inspect:no-completed-review-outcome-recorded": INSPECT_READS,
  "inspect:pendingFindings": INSPECT_READS,
  "inspect:pending-verification-tooling-not-listed-in-the-summary": INSPECT_READS,
  "inspect:summary-says-x-tickets-disk-has-x": INSPECT_READS,
  "inspect:summary-says-x-phases-disk-has-x-created": INSPECT_READS,
  "inspect:scaffold-x-is-not-the-first-phase": INSPECT_READS,
  "inspect:scaffold-config-x-overwritten": INSPECT_READS,
  "inspect:scaffold-init-was-called": INSPECT_READS,
  "inspect:degradedFindings": INSPECT_READS,
};

const within = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`);

/**
 * Why a check cannot run on this extraction, or null. A file is blocked if it, or any folder above
 * it, was not materialized, was omitted, or lies under a missing root. A tree is blocked as a file is,
 * and also by anything below it at any depth that was not materialized or was omitted.
 */
export function blockedBy(deps: readonly Dep[], x: Pick<Extraction, "notMaterialized" | "omitted" | "rootsMissing" | "complete">): string | null {
  if (!x.complete) return "evidence-blocked: the archive, incomplete";
  for (const d of deps) {
    const at = "file" in d ? d.file : d.tree;
    const root = x.rootsMissing.find((r) => within(at, r));
    if (root !== undefined) return `evidence-blocked: ${at}, under the missing root ${root}`;
    for (const n of x.notMaterialized) {
      if (within(at, n.path) || ("tree" in d && within(n.path, at))) return `evidence-blocked: ${n.path}, ${n.class}`;
    }
    for (const o of x.omitted) {
      if (within(at, o) || ("tree" in d && within(o, at))) return `evidence-blocked: ${o}, omitted`;
    }
  }
  return null;
}
