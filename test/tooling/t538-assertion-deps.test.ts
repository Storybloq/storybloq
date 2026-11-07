/**
 * T-538 S5b-0 commit 4: every check the harness can record has a declared-dependency row, and every row
 * names a check that exists (plan section 9). The keys are derived from the sources, by rule number for
 * the two checksets and by finding source or message for the session and inspect checks, so a rule whose
 * body changes keeps its key and a rule added or removed fails here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSERTION_DEPS } from "../../scripts/onboarding-eval-assertion-deps.js";

const SCRIPTS = join(__dirname, "..", "..", "scripts");
const src = (f: string): string => readFileSync(join(SCRIPTS, f), "utf-8");

const ruleKeys = (fn: string, text: string): string[] => [...new Set([...text.matchAll(/\bRule (\d+)\b/g)].map((m) => `${fn}:rule-${m[1]}`))];

/** inspectAfter's body, from its declaration to the first closing brace at column 0. */
function inspectBody(text: string): string {
  const start = text.indexOf("export function inspectAfter(");
  if (start < 0) throw new Error("inspectAfter not found");
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end);
}
const slug = (template: string): string => template.replace(/\$\{[^}]*\}/g, "x").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** One key per fail site: the finding source a loop iterates, else the message template's slug. */
function inspectKeys(body: string): string[] {
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    if (!/\bfail\(s,/.test(line)) continue;
    const loop = /for \(const f of ([A-Za-z_.]+)/.exec(line);
    if (loop) { keys.push(`inspect:${loop[1]}`); continue; }
    const msg = /\bfail\(s, \{[^}]*\}, (["`])(.*?)\1\)/.exec(line);
    if (!msg) throw new Error(`a fail site the key rule cannot read: ${line.trim()}`);
    keys.push(`inspect:${slug(msg[2]!)}`);
  }
  return keys;
}
/** The variant checks variantFindings dispatches to, and the artifact check applySessionChecks adds first. */
function sessionKeys(text: string): string[] {
  const names = new Set([...text.matchAll(/\b(\w+)Findings\(i\)/g)].map((m) => m[1]!));
  if (/\.\.\.artifactFindings\(/.test(text)) names.add("artifact");
  return [...names].map((n) => `session:${n}`);
}

function sourceKeys(sources: { checkset6: string; checkset7: string[]; sessions: string; drive: string }): string[] {
  return [
    ...ruleKeys("setup-review", sources.checkset6),
    ...ruleKeys("setup-run", sources.checkset7.join("\n")),
    ...sessionKeys(sources.sessions),
    ...inspectKeys(inspectBody(sources.drive)),
  ];
}
function compareKeys(fromSources: readonly string[], rows: readonly string[]): { readonly missingRows: string[]; readonly orphanRows: string[]; readonly duplicates: string[] } {
  const s = new Set(fromSources);
  const r = new Set(rows);
  return {
    missingRows: [...s].filter((k) => !r.has(k)).sort(),
    orphanRows: [...r].filter((k) => !s.has(k)).sort(),
    duplicates: fromSources.filter((k, i) => fromSources.indexOf(k) !== i),
  };
}
const real = () => ({
  checkset6: src("onboarding-eval-checkset6.ts"),
  checkset7: ["onboarding-eval-checkset7.ts", "onboarding-eval-checkset7-events.ts", "onboarding-eval-checkset7-writes.ts"].map(src),
  sessions: src("onboarding-eval-sessions.ts"),
  drive: src("onboarding-eval-drive.ts"),
});

describe("assertion-deps covers every check, and only checks that exist", () => {
  it("the rows and the sources name the same checks, each once", () => {
    expect(compareKeys(sourceKeys(real()), Object.keys(ASSERTION_DEPS))).toEqual({ missingRows: [], orphanRows: [], duplicates: [] });
  });
  it("the inventory is the one the plan names: 4 review rules, 10 run rules, 6 session checks, 17 inspect sites", () => {
    const k = sourceKeys(real());
    const count = (p: string): number => k.filter((x) => x.startsWith(p)).length;
    expect([count("setup-review:"), count("setup-run:"), count("session:"), count("inspect:")]).toEqual([4, 10, 6, 17]);
  });
  it("a rule in a source without a row fails, and a row naming a rule no source has fails", () => {
    const s = real();
    const added = sourceKeys({ ...s, checkset6: `${s.checkset6}\n// Rule 5: a new rule\n` });
    expect(compareKeys(added, Object.keys(ASSERTION_DEPS)).missingRows).toEqual(["setup-review:rule-5"]);
    const removed = sourceKeys({ ...s, checkset7: s.checkset7.map((t) => t.replace(/\bRule 10\b/g, "Rule ten")) });
    expect(compareKeys(removed, Object.keys(ASSERTION_DEPS)).orphanRows).toEqual(["setup-run:rule-10"]);
    const newSite = sourceKeys({ ...s, drive: s.drive.replace("export function inspectAfter(", "export function inspectAfter(\n  fail(s, { kind: \"inspection\" }, \"a new site\");\n") });
    expect(compareKeys(newSite, Object.keys(ASSERTION_DEPS)).missingRows).toEqual(["inspect:a-new-site"]);
  });
  it("a rule whose body changes keeps its key (cpm-w12's rule 4 edit changes the body, not the number)", () => {
    const s = real();
    const at = s.checkset6.indexOf("Rule 4");
    expect(at).toBeGreaterThan(-1);
    const edited = `${s.checkset6.slice(0, at + 6)} (rewritten body for the test)${s.checkset6.slice(at + 6).replace(/[a-z]{6,}/g, "rewritten")}`;
    expect(ruleKeys("setup-review", edited).sort()).toEqual(ruleKeys("setup-review", s.checkset6).sort());
  });
  it("what a check reads blocks it, and what it does not read does not", async () => {
    const { blockedBy } = await import("../../scripts/onboarding-eval-assertion-deps.js");
    const x = (o: object) => ({ complete: true, rootsMissing: [] as string[], notMaterialized: [] as never[], omitted: [] as string[], ...o });
    const storeHidden = x({ notMaterialized: [{ path: "store/rec/SR-1", class: "symlink" }] });
    expect(blockedBy(ASSERTION_DEPS["setup-review:rule-2"]!, storeHidden)).toBe("evidence-blocked: store/rec/SR-1, symlink");
    for (const k of ["setup-review:rule-1", "setup-review:rule-3", "setup-review:rule-4", "inspect:no-final-turn", "setup-run:rule-1"]) expect(blockedBy(ASSERTION_DEPS[k]!, storeHidden), k).toBeNull();
    const noEvents = x({ rootsMissing: ["eval-events"] });
    for (const k of ["setup-run:rule-1", "setup-run:rule-7", "setup-run:rule-10", "session:artifact", "session:restart"]) expect(blockedBy(ASSERTION_DEPS[k]!, noEvents), k).toMatch(/missing root eval-events/);
    for (const k of ["inspect:ticketFindings", "setup-review:rule-2", "inspect:no-story-after-approval"]) expect(blockedBy(ASSERTION_DEPS[k]!, noEvents), k).toBeNull();
    const ticketLink = x({ notMaterialized: [{ path: "project/.story/tickets/T-1.json", class: "symlink" }] });
    for (const k of ["inspect:ticketFindings", "inspect:degradedFindings", "session:interrupted", "setup-run:rule-8", "setup-run:rule-9"]) expect(blockedBy(ASSERTION_DEPS[k]!, ticketLink), k).toMatch(/T-1\.json, symlink/);
    for (const k of ["inspect:no-story-after-approval", "setup-run:rule-7", "setup-run:rule-1"]) expect(blockedBy(ASSERTION_DEPS[k]!, ticketLink), k).toBeNull();
    const handover = x({ omitted: ["project/.story/handovers/big"] });
    expect(blockedBy(ASSERTION_DEPS["inspect:no-coverage-map-in-the-setup-note-or-handover"]!, handover)).toMatch(/omitted/);
    expect(blockedBy(ASSERTION_DEPS["session:edited"]!, handover)).toBeNull();
    const snapshot = x({ notMaterialized: [{ path: "eval-events/events.jsonl.setup-snapshot.json", class: "special" }] });
    for (const k of ["setup-run:rule-1", "setup-run:rule-6", "setup-run:rule-9", "session:demo"]) expect(blockedBy(ASSERTION_DEPS[k]!, snapshot), k).toMatch(/snapshot\.json, special/);
    for (const k of ["setup-run:rule-7", "setup-run:rule-8", "setup-run:rule-10"]) expect(blockedBy(ASSERTION_DEPS[k]!, snapshot), k).toBeNull();
  });
  it("every declared path lies under a root the attempt archive carries", () => {
    for (const [k, deps] of Object.entries(ASSERTION_DEPS)) {
      for (const d of deps) expect(["project/", "store", "eval-events"].some((r) => ("file" in d ? d.file : d.tree).startsWith(r)), k).toBe(true);
    }
  });
});
