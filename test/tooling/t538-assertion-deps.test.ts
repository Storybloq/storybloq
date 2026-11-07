/**
 * T-538 S5b-0 commit 4: every check the harness can record has a declared-dependency row, and every row
 * names a check that exists (plan section 9). The keys are derived from the sources, by the rule number
 * of the checksets' executable failure messages and by finding source or message for the session and
 * inspect checks, so a rule whose body changes keeps its key and a rule added or removed fails here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ASSERTION_DEPS } from "../../scripts/onboarding-eval-assertion-deps.js";

const SCRIPTS = join(__dirname, "..", "..", "scripts");
const src = (f: string): string => readFileSync(join(SCRIPTS, f), "utf-8");

/**
 * The rules a checkset can fail, read from the code that records failures, never from comments or from
 * literals nothing records. A failure site is the argument of a `failures.push` or `findings.push` call, or
 * a string a `rule*` function returns (rule2Plan's shape). Each site's leading text is resolved: string and
 * template literals, `+` over them, and a template that starts with a const bound to such a literal (the
 * `where` of rule 10). A spread, a bare identifier or a call hands over findings made at sites of their own.
 * A site that resolves to "rule" without a readable `rule N:` is refused with its line, never skipped.
 */
function ruleKeys(fn: string, text: string): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const consts = new Map<string, ts.Expression>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const)) consts.set(n.name.text, n.initializer);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  /** The static text a failure expression starts with, or null when it hands over findings made elsewhere. */
  const lead = (e: ts.Expression, depth = 0): string | null => {
    if (depth > 8) return null;
    if (ts.isParenthesizedExpression(e)) return lead(e.expression, depth + 1);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) {
      if (e.head.text !== "") return e.head.text;
      const first = e.templateSpans[0]!;
      const bound = ts.isIdentifier(first.expression) ? consts.get(first.expression.text) : undefined;
      const inner = bound ? lead(bound, depth + 1) : null;
      return inner === null ? "" : inner;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = lead(e.left, depth + 1);
      if (left === null) return null;
      const whole = ts.isStringLiteral(e.left) || ts.isNoSubstitutionTemplateLiteral(e.left) || (ts.isBinaryExpression(e.left) && e.left.operatorToken.kind === ts.SyntaxKind.PlusToken);
      const right = whole ? lead(e.right, depth + 1) : null;
      return right === null ? left : left + right;
    }
    if (ts.isConditionalExpression(e)) { const a = lead(e.whenTrue, depth + 1); return a !== null && /^rule\b/.test(a) ? a : lead(e.whenFalse, depth + 1); }
    return null;
  };
  const found = new Set<string>();
  const site = (e: ts.Expression): void => {
    const t = lead(e);
    if (t === null || !/^rule\b/i.test(t)) return;
    const m = /^rule (\d+):/.exec(t);
    if (!m) throw new Error(`a failure site whose rule cannot be read, line ${sf.getLineAndCharacterOfPosition(e.getStart()).line + 1}: ${e.getText().slice(0, 80)}`);
    found.add(`${fn}:rule-${m[1]}`);
  };
  const ruleFunction = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p)) return p.name !== undefined && /^rule\d/.test(p.name.text);
    return false;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push" && /(^|\.)(failures|findings)$/.test(n.expression.expression.getText())) {
      for (const a of n.arguments) if (!ts.isSpreadElement(a)) site(a);
    }
    if (ts.isReturnStatement(n) && n.expression && ruleFunction(n)) site(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...found];
}

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
    if (!/\bfail\(s,/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
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
    ...new Set(sources.checkset7.flatMap((t) => ruleKeys("setup-run", t))),
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
  it("a failure the code can record without a row fails, and a row whose failures are gone fails, comments either way", () => {
    const s = real();
    // An executable rule 5 with no numbered comment anywhere.
    const added = sourceKeys({ ...s, checkset6: `${s.checkset6}\nexport const extra = (failures: string[]): void => { failures.push("rule 5: a new rule"); };\n` });
    expect(s.checkset6).not.toMatch(/Rule 5\b/);
    expect(compareKeys(added, Object.keys(ASSERTION_DEPS)).missingRows).toEqual(["setup-review:rule-5"]);
    // Rule 10's failures removed, its comments kept.
    const removed = sourceKeys({ ...s, checkset7: s.checkset7.map((t) => t.replace(/([`"])rule 10:/g, "$1check ten:")) });
    expect(s.checkset7.join("\n")).toMatch(/Rule 10\b/);
    expect(compareKeys(removed, Object.keys(ASSERTION_DEPS)).orphanRows).toEqual(["setup-run:rule-10"]);
    // A literal nothing records names no rule: rule 10's failures gone, an unused copy of its text kept.
    const masked = sourceKeys({ ...s, checkset7: s.checkset7.map((t) => `${t.replace(/([`"])rule 10:/g, "$1check ten:")}\nconst old = "rule 10: retired";\n`) });
    expect(compareKeys(masked, Object.keys(ASSERTION_DEPS)).orphanRows).toEqual(["setup-run:rule-10"]);
    // A failure assembled by concatenation is counted.
    const joined = sourceKeys({ ...s, checkset6: `${s.checkset6}\nexport const extra2 = (failures: string[]): void => { failures.push("rule " + "11: new check"); };\n` });
    expect(compareKeys(joined, Object.keys(ASSERTION_DEPS)).missingRows).toEqual(["setup-review:rule-11"]);
    // A failure whose rule is computed cannot be read, and the inventory refuses it by line.
    const dynamic = { ...s, checkset6: `${s.checkset6}\nexport const extra3 = (failures: string[], n: number): void => { failures.push("rule " + n + ": computed"); };\n` };
    expect(() => sourceKeys(dynamic)).toThrow(/a failure site whose rule cannot be read, line \d+: "rule " \+ n/);
    // A comment alone names no rule.
    const commentOnly = sourceKeys({ ...s, checkset6: `${s.checkset6}\n// Rule 6: only a comment\n/** Rule 7: only a doc comment */\n` });
    expect(compareKeys(commentOnly, Object.keys(ASSERTION_DEPS))).toEqual({ missingRows: [], orphanRows: [], duplicates: [] });
    const newSite = sourceKeys({ ...s, drive: s.drive.replace("export function inspectAfter(", "export function inspectAfter(\n  fail(s, { kind: \"inspection\" }, \"a new site\");\n") });
    expect(compareKeys(newSite, Object.keys(ASSERTION_DEPS)).missingRows).toEqual(["inspect:a-new-site"]);
  });
  it("a rule whose body changes keeps its key (cpm-w12's rule 4 edit changes the body, not the number)", () => {
    const s = real();
    expect(s.checkset6).toMatch(/"rule 4:/);
    // Every rule 4 failure reworded after its prefix, and its comment rewritten.
    const edited = s.checkset6.replace(/([`"])rule 4: [^`"]*/g, "$1rule 4: rewritten for the test").replace(/Rule 4: [^\n]*/g, "Rule 4: rewritten");
    expect(edited).not.toBe(s.checkset6);
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
