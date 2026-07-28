import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_READ_ONLY_APPROVAL_TOOLS } from "../../src/cli/commands/setup-skill.js";
import { WORKFLOW_STATES } from "../../src/autonomous/session-types.js";
import { classifySessionGuard, PRE_OWNERSHIP_GATES } from "../../src/core/session-guard.js";

/**
 * T-446: the generated legacy-path file and the SKILL.md contract around it.
 *
 * `session-guard-fallback.md` is generated from `test/fixtures/session-guard-matrix.json`
 * so the tool and the prose cannot disagree about classification. It is a
 * SEPARATE shipped file, never inlined into SKILL.md: SKILL.md loads on every
 * invocation, so inlining two generated tables would increase the fixed token
 * cost this ticket exists to cut.
 */

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fallbackPath = join(pkgRoot, "src", "skill", "session-guard-fallback.md");
const skillPath = join(pkgRoot, "src", "skill", "SKILL.md");
const generatorPath = join(pkgRoot, "scripts", "gen-guard-matrix.ts");
const fixturePath = join(pkgRoot, "test", "fixtures", "session-guard-matrix.json");

const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  identityAvailable: { id: string; verdict: Record<string, unknown> }[];
  identityUnavailable: { id: string; verdict: Record<string, unknown> }[];
  fallbackPolicies: { id: string; rule: string; expectedAction: string }[];
  entryModes: { id: string; name: string; mayCallStatus: boolean }[];
  validWorkflowStates: string[];
  actions: { id: string; instruction: string; source: string; note?: string; fallbackOnly?: boolean }[];
};

function fallback(): string {
  return readFileSync(fallbackPath, "utf-8");
}

describe("session-guard-fallback.md is generated, not hand-maintained", () => {
  it("is byte-identical to a fresh run of the generator", () => {
    const fresh = execFileSync("npx", ["tsx", generatorPath, "--stdout"], {
      cwd: pkgRoot,
      encoding: "utf-8",
    });
    expect(fresh).toBe(fallback());
  });

  it("carries every row id from both tables", () => {
    const text = fallback();
    for (const row of [...fixture.identityAvailable, ...fixture.identityUnavailable]) {
      expect(text, `row ${row.id} missing from generated fallback`).toContain(row.id);
    }
  });

  /**
   * Owner DOMAINS must stay distinguishable in the rendered table.
   *
   * `any-owner` means an `ownerTask` exists; `any` means present or absent. When
   * both rendered as "any", U2 (live COMPACT, monitor-only) appeared to cover an
   * ownerless live COMPACT session -- U4's row, which prescribes auto-resume.
   * Mode A has no classifier but this table, so two rows matching one session
   * with opposite actions decides whether a migration recovery happens. Row-id
   * presence alone never caught it.
   */
  it("renders the two `any` domains distinctly, so no two rows match one session", () => {
    const text = fallback();
    const rowOf = (id: string): string => {
      const line = text.split("\n").find((l) => l.startsWith(`| ${id} |`));
      expect(line, `no rendered row for ${id}`).toBeDefined();
      return line!;
    };
    const labelOf = (id: string): string => rowOf(id).split("|")[2]!.trim();

    const EXPECTED: Record<string, string> = {
      "any-owner": "any recorded owner",
      any: "present or absent",
      none: "none",
      same: "same as caller",
      different: "different from caller",
    };
    let checkedAnyOwner = 0;
    let checkedAny = 0;
    for (const row of [...fixture.identityAvailable, ...fixture.identityUnavailable]) {
      const domain = (row as unknown as { input: { owner: string } }).input.owner;
      const expected = EXPECTED[domain];
      expect(expected, `fixture uses an owner domain with no expected label: ${domain}`).toBeDefined();
      expect(labelOf(row.id), `row ${row.id} (${domain}) rendered the wrong owner label`).toBe(expected);
      if (domain === "any-owner") checkedAnyOwner += 1;
      if (domain === "any") checkedAny += 1;
    }
    // Both domains must actually appear, or the distinction is untested.
    expect(checkedAnyOwner, "no `any-owner` row").toBeGreaterThan(0);
    expect(checkedAny, "no `any` row").toBeGreaterThan(0);
    expect(EXPECTED["any-owner"]).not.toBe(EXPECTED.any);
  });
});

/**
 * Mode A has no classifier: this file IS its classifier. So examples are not
 * enough for the state gate. A reader meeting a typo the fixture never listed
 * has no way to tell it is invalid, falls through to the ownership tables, and
 * reproduces exactly the fail-open the typed gate removes.
 */
describe("the fallback can actually apply the state gate, not just recognize two examples", () => {
  function stateSection(): string {
    const text = fallback();
    const start = text.indexOf("## Undetermined session state");
    expect(start, "no state-gate section").toBeGreaterThan(-1);
    // Bounded to the NEXT heading, whatever it is. Naming a specific following
    // section would silently widen the slice the moment the gate moves.
    const rest = text.slice(start + 1);
    const next = rest.search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("enumerates every valid workflow state", () => {
    const section = stateSection();
    for (const state of WORKFLOW_STATES) {
      expect(section, `valid state ${state} missing from the fallback`).toContain(`\`${state}\``);
    }
  });

  it("states the catch-all rule, so an unlisted value is decidable", () => {
    const section = stateSection();
    expect(section).toMatch(/anything else, without exception/i);
    expect(section).toMatch(/not in that set/i);
    expect(section).toMatch(/`indeterminate`/);
    expect(section).toMatch(/`unverifiable`/);
    // And that it runs BEFORE ownership, which is the whole reason it works.
    expect(section).toMatch(/before classifying ownership/i);
    expect(section).toMatch(/do not fall through to the ownership tables/i);
  });

  /**
   * Saying "before ownership" inside a section printed AFTER the ownership
   * tables does not make Mode A execute it in that order. A reader working
   * through the file sequentially matches an unknown state as non-COMPACT, stops
   * at `continue`, and never reaches the warning -- which is precisely the
   * fail-open the gate exists to remove. So the position is asserted, not just
   * the wording.
   */
  it("is placed ahead of both verdict tables, not merely described as first", () => {
    const text = fallback();
    const gate = text.indexOf("## Undetermined session state");
    const available = text.indexOf("## Verdict table: caller identity available");
    const unavailable = text.indexOf("## Verdict table: caller identity unavailable");
    expect(available, "no identity-available table").toBeGreaterThan(-1);
    expect(unavailable, "no identity-unavailable table").toBeGreaterThan(-1);
    expect(gate, "state gate must precede the identity-available table").toBeLessThan(available);
    expect(gate, "state gate must precede the identity-unavailable table").toBeLessThan(unavailable);
  });

  /**
   * The concrete regression: a typo the fixture does not list. It must not
   * appear as a valid state, and the rule must be general enough to cover it.
   */
  it("a typo absent from the fixture is still decidable from the rule", () => {
    const section = stateSection();
    for (const typo of ["REVIEV", "IMPLEMENTING", "compact"]) {
      expect(section, `${typo} must not be presented as valid`).not.toContain(`\`${typo}\``);
    }
    expect(section).toMatch(/any typo or unrecognized value/i);
  });

  /**
   * The fixture owns the list the prose renders, so it must equal the union the
   * classifier checks. Without this, adding a workflow state to the state
   * machine would silently make Mode A reject a legitimate session.
   */
  it("the fixture's valid set is exactly the production WORKFLOW_STATES", () => {
    const fixtureStates = (JSON.parse(readFileSync(fixturePath, "utf-8")) as { validWorkflowStates: string[] })
      .validWorkflowStates;
    expect(fixtureStates.slice().sort()).toEqual([...WORKFLOW_STATES].sort());
    // Order too: the rendered list should read like the state machine.
    expect(fixtureStates).toEqual([...WORKFLOW_STATES]);
  });
});

/**
 * The deduplication sentence was dropped from an intermediate transcription, and
 * mode A is the copy with no tool behind it: a reader here IS the classifier, so
 * a missing dedup rule makes them count one session twice and land in a
 * multi-session branch this file has no aggregate rule for.
 */
describe("the fallback carries the deduplication rule mode A has to apply", () => {
  function dedupeSection(): string {
    const text = fallback();
    const start = text.indexOf("## Deduplicate before classifying");
    expect(start, "no deduplication section").toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("quotes the sentence and states the rule", () => {
    const section = dedupeSection();
    expect(section).toContain("deduplicate by full `sessionId`");
    expect(section).toMatch(/keep the first occurrence/i);
    // The tiebreak is this file's choice, not the document's, and saying so is
    // what stops a reader from citing it back as prose.
    expect(section).toMatch(/names no tiebreak/i);
  });

  it("is placed before the verdict tables, because it decides what gets classified", () => {
    const text = fallback();
    const dedupe = text.indexOf("## Deduplicate before classifying");
    const available = text.indexOf("## Verdict table: caller identity available");
    expect(dedupe).toBeGreaterThan(-1);
    expect(dedupe, "dedup must precede the tables it feeds").toBeLessThan(available);
  });
});

/**
 * Mode A and the classifier must agree on terminal records.
 *
 * `SESSION_END` is in `WORKFLOW_STATES`, and the state gate below says every
 * member of that set proceeds to the ownership tables. Following that literally,
 * a mode A reader hands a terminal record to the same-owner row and gets
 * `continue` -- an actionable verdict for a session that has ended -- while
 * `classifySessionGuard` returns `unverifiable` for the identical input. A
 * divergence between the tool and its own legacy path is the one failure this
 * generated file exists to make impossible.
 */
describe("the fallback treats a terminal session as the classifier does", () => {
  function terminalSection(): string {
    const text = fallback();
    const start = text.indexOf("## Terminal sessions");
    expect(start, "no terminal-state section").toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("classifies SESSION_END as unverifiable, not as an ordinary non-COMPACT state", () => {
    const section = terminalSection();
    expect(section).toContain("`SESSION_END`");
    expect(section).toMatch(/`unverifiable`/);
    expect(section).toMatch(/`indeterminate`/);
    expect(section).toMatch(/never a BEARING one/i);
    // And the specific misreading it exists to prevent.
    expect(section).toMatch(/membership in the valid set/i);
    expect(section).toMatch(/ends at `continue` for its owner/i);
  });

  it("places the terminal rule before the ownership tables that would otherwise claim it", () => {
    const text = fallback();
    const terminal = text.indexOf("## Terminal sessions");
    const available = text.indexOf("## Verdict table: caller identity available");
    expect(terminal).toBeGreaterThan(-1);
    expect(terminal, "a rule printed after the tables is one a sequential reader never reaches").toBeLessThan(available);
  });

  it("publishes the terminal rule's constrained provenance, not just its verdict", () => {
    const rule = (JSON.parse(readFileSync(fixturePath, "utf-8")) as {
      terminalStateRule: {
        id: string;
        classifierGateId: string;
        basis: string;
        population: string;
        basisNote: string;
        source?: string;
        input: { states: string | string[]; compactPending: string | boolean[]; leaseStates: string | string[] };
      };
    }).terminalStateRule;
    // It cites no prose, so it must publish the alternative basis -- otherwise
    // the shipped file states a policy with neither, which its own provenance
    // section says does not belong in it.
    expect(rule.id).toBe(rule.classifierGateId);
    expect(rule.basis).toBe("observed-classifier");
    expect(rule.population).toBe("both");
    expect(rule.source, "the terminal rule claims a citation it does not have").toBeUndefined();
    const section = terminalSection();
    expect(section, "the shipped file drops the gate id").toContain(rule.classifierGateId);
    expect(section, "the shipped file drops the basis").toContain(rule.basisNote);
    expect(section, "the shipped file drops the declared population").toMatch(
      /`activeSessions`, `resumableSessions`/,
    );
    expect(section).toContain("`SESSION_END`");
  });

  it("agrees with the classifier verdict field for field", () => {
    const rule = (JSON.parse(readFileSync(fixturePath, "utf-8")) as {
      terminalStateRule: { state: string; verdict: Record<string, unknown> };
    }).terminalStateRule;
    const v = classifySessionGuard(
      {
        activeSessions: [
          {
            sessionId: "s-terminal",
            sourceDir: "s-terminal",
            state: rule.state,
            mode: "auto",
            compactPending: false,
            leaseState: "live",
            leaseExpiresAt: null,
            ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
          } as never,
        ],
        resumableSessions: [],
      },
      { task: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" }, client: "claude" },
    ).sessions[0]! as unknown as Record<string, unknown>;

    for (const [key, expected] of Object.entries(rule.verdict)) {
      expect(v[key], `the fallback and the classifier disagree on \`${key}\` for ${rule.state}`).toBe(expected);
    }
  });
});

describe("the fallback applies the population gates the classifier applies", () => {
  type PopulationRule = {
    id: string;
    population: string;
    violation: string;
    input: { states: string; compactPending: string | boolean[]; leaseStates: string | string[] };
    rule: string;
    classifierGateId: string;
    basisNote: string;
    verdict: Record<string, unknown>;
  };

  const STATE_PROBES = [
    ...WORKFLOW_STATES,
    // Probes for `any`, which claims the predicate never reads the field. One
    // bogus token would only catch a narrowing that happened to exclude that
    // token; these cover the shapes a narrowing plausibly takes -- empty, blank,
    // case-shifted, whitespace-padded, and non-ASCII.
    "",
    " ",
    "compact",
    "COMPACT ",
    " COMPACT",
    "session_end",
    "NOT_A_WORKFLOW_STATE",
  ];
  const ALL_STATES = STATE_PROBES;
  const ALL_LEASES = ["live", "expired", "missing", "invalid"];
  const expandStates = (v: string): string[] =>
    v === "any" ? ALL_STATES : v === "any-except-COMPACT" ? ALL_STATES.filter((x) => x !== "COMPACT") : JSON.parse(v);
  const expandPending = (v: string | boolean[]): boolean[] => (v === "any" ? [true, false] : (v as boolean[]));
  const expandLeases = (v: string | string[]): string[] => (v === "any" ? ALL_LEASES : (v as string[]));
  const point = (population: string, state: string, pending: boolean, lease: string): string =>
    `${population}|${state}|${pending}|${lease}`;

  const rules = (JSON.parse(readFileSync(fixturePath, "utf-8")) as {
    populationInvariantRules: PopulationRule[];
  }).populationInvariantRules;

  function populationSection(): string {
    const text = fallback();
    const start = text.indexOf("## Population invariants");
    expect(start, "no population-invariant section").toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("registers every gate PRODUCTION applies, in production's order", () => {
    // Read from the classifier, never from a hand-written list: a list pinned
    // against a copy of itself cannot notice a fifth gate, which is exactly what
    // the previous version of this test did.
    const production = PRE_OWNERSHIP_GATES.map((g) => g.id);
    const declared = (JSON.parse(readFileSync(fixturePath, "utf-8")) as { gateOrder: { id: string }[] }).gateOrder.map(
      (g) => g.id,
    );
    expect(declared, "a gate added to PRE_OWNERSHIP_GATES is unreachable from the fallback until it is declared").toEqual(
      production,
    );
    // And the published order is the order a reader is told to apply.
    const text = fallback();
    const rendered = [...text.matchAll(/^\d+\. `([a-z-]+)` -- see /gm)].map((m) => m[1]);
    expect(rendered).toEqual(production);
  });

  /**
   * Every production gate must be DOCUMENTED, not merely listed. Asserting only
   * that `gateOrder` covers production left a loophole: add a gate, add one
   * `gateOrder` line, and the fallback gains a named gate with no rule, no
   * domain, and no verdict, while every test stays green.
   */
  it("documents every production gate exactly once, in a section that actually carries its rule", () => {
    const doc = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
      gateOrder: { id: string; documentedIn: string }[];
      terminalStateRule: { id: string; rule: string };
      populationInvariantRules: { id: string; classifierGateId: string; rule: string }[];
      unknownStateRule?: { id: string; rule: string };
    };

    // One registration per gate, from the sections that define executable rules.
    const registry = new Map<string, string>();
    const register = (id: string, where: string): void => {
      expect(registry.has(id), `gate \`${id}\` is registered twice`).toBe(false);
      registry.set(id, where);
    };
    register(doc.terminalStateRule.id, "Terminal sessions");
    for (const rule of doc.populationInvariantRules) register(rule.classifierGateId, "Population invariants");
    if (doc.unknownStateRule) register(doc.unknownStateRule.id, "Undetermined session state");
    else register("unknown-workflow-state", "Undetermined session state");

    expect([...registry.keys()].sort(), "a production gate has no documented rule, or a rule names no gate").toEqual(
      PRE_OWNERSHIP_GATES.map((g) => g.id).sort(),
    );

    // And `documentedIn` must point at the section that really carries it.
    const text = fallback();
    for (const entry of doc.gateOrder) {
      expect(registry.get(entry.id), `\`${entry.id}\` is ordered but never documented`).toBe(entry.documentedIn);
      const start = text.indexOf(`## ${entry.documentedIn}`);
      expect(start, `no rendered section "${entry.documentedIn}"`).toBeGreaterThan(-1);
      const rest = text.slice(start + 1);
      const next = rest.search(/\n## /);
      const section = next === -1 ? rest : rest.slice(0, next);
      expect(section, `"${entry.documentedIn}" does not mention \`${entry.id}\``).toContain(entry.id);
    }
  });

  it("puts the precedence list ahead of every gate section, not just ahead of the tables", () => {
    const text = fallback();
    const order = text.indexOf("## Gate order");
    expect(order, "no gate-order section").toBeGreaterThan(-1);
    // After dedup, because dedup decides what gets classified at all.
    expect(text.indexOf("## Deduplicate before classifying")).toBeLessThan(order);
    // Before every section carrying an executable gate. A reader working through
    // the file sequentially would otherwise apply the terminal rule to a
    // compound-invalid record and never learn another gate outranks it.
    for (const section of [
      "## Terminal sessions",
      "## Population invariants",
      "## Undetermined session state",
      "## Verdict table: caller identity available",
      "## Verdict table: caller identity unavailable",
    ]) {
      const at = text.indexOf(section);
      expect(at, `no section ${section}`).toBeGreaterThan(-1);
      expect(order, `"${section}" is reachable before the precedence that governs it`).toBeLessThan(at);
    }
  });

  it("places the gates before the ownership tables that would otherwise claim these records", () => {
    const text = fallback();
    const gates = text.indexOf("## Population invariants");
    const available = text.indexOf("## Verdict table: caller identity available");
    const unavailable = text.indexOf("## Verdict table: caller identity unavailable");
    expect(gates).toBeGreaterThan(-1);
    expect(gates, "a gate printed after the tables is one a sequential reader never reaches").toBeLessThan(available);
    expect(gates).toBeLessThan(unavailable);
  });

  it("says why these are not the `noVerdict` cells, which describe what the scanner never emits", () => {
    const section = populationSection();
    expect(section).toMatch(/BEFORE the\s+ownership tables/);
    expect(section).toMatch(/never by them/);
    expect(section).toMatch(/storybloq session list/);
  });

  it("agrees with the classifier field for field, across each rule's whole domain", () => {
    const owner = { client: "claude" as const, id: "caller-task", boundAt: "2026-07-01T00:00:00Z" };
    let checked = 0;
    for (const rule of rules) {
      let perRule = 0;
      const expectCompact = rule.population === "resumableSessions";
      for (const state of expandStates(rule.input.states)) {
        for (const pending of expandPending(rule.input.compactPending)) {
          for (const lease of expandLeases(rule.input.leaseStates)) {
            const summary = {
              sessionId: `s-${rule.id}`,
              sourceDir: `s-${rule.id}`,
              state,
              mode: "auto",
              compactPending: pending,
              leaseState: lease,
              leaseExpiresAt: null,
              // The caller's OWN task: the ownership row this record would
              // otherwise match is the most permissive one in the table.
              ownerTask: owner,
            } as never;
            const v = classifySessionGuard(
              expectCompact
                ? { activeSessions: [], resumableSessions: [summary] }
                : { activeSessions: [summary], resumableSessions: [] },
              { task: owner, client: "claude" },
            ).sessions[0]! as unknown as Record<string, unknown>;

            for (const [key, expected] of Object.entries(rule.verdict)) {
              expect(
                v[key],
                `the fallback and the classifier disagree on \`${key}\` for \`${rule.id}\` (${state}/${pending}/${lease})`,
              ).toBe(expected);
            }
            checked += 1;
            perRule += 1;
          }
        }
      }
      // Per RULE, not globally: one rule with an empty domain would otherwise
      // ride on the other three and never be exercised, while the test that
      // names it stays green.
      expect(perRule, `\`${rule.id}\` contributed no shapes: its declared domain is empty`).toBeGreaterThan(0);
    }
    expect(checked, "no shapes were checked").toBeGreaterThan(50);
  });

  it("sends a reader who violates several gates to the same one the classifier picks", () => {
    // The precedence no section ordering can express: `recovery-not-compact`
    // runs AFTER the terminal gate, so a reader arranging sections by topic
    // would cite the wrong rule for a compound-invalid record.
    const owner = { client: "claude" as const, id: "caller-task", boundAt: "2026-07-01T00:00:00Z" };
    const order = PRE_OWNERSHIP_GATES.map((g) => g.id);
    const compound: { label: string; population: "activeSessions" | "resumableSessions"; summary: Record<string, unknown>; expected: string }[] = [
      {
        label: "SESSION_END plus a non-live active lease",
        population: "activeSessions",
        summary: { state: "SESSION_END", compactPending: false, leaseState: "expired" },
        expected: "active-lease-not-live",
      },
      {
        label: "SESSION_END plus a resumable entry that is not pending",
        population: "resumableSessions",
        summary: { state: "SESSION_END", compactPending: false, leaseState: "expired" },
        expected: "recovery-not-pending",
      },
      {
        label: "SESSION_END in a pending resumable entry, which is also not COMPACT",
        population: "resumableSessions",
        summary: { state: "SESSION_END", compactPending: true, leaseState: "expired" },
        expected: "terminal-session-end",
      },
      {
        label: "an unknown state in a pending resumable entry, which is also not COMPACT",
        population: "resumableSessions",
        summary: { state: "NOT_A_STATE", compactPending: true, leaseState: "expired" },
        expected: "unknown-workflow-state",
      },
    ];

    for (const c of compound) {
      const summary = { sessionId: "s-c", sourceDir: "s-c", mode: "auto", leaseExpiresAt: null, ownerTask: owner, ...c.summary } as never;
      const v = classifySessionGuard(
        c.population === "activeSessions"
          ? { activeSessions: [summary], resumableSessions: [] }
          : { activeSessions: [], resumableSessions: [summary] },
        { task: owner, client: "claude" },
      ).sessions[0]!;

      // The winning gate is identified by its own rationale text, so this fails
      // if precedence changes even though every verdict field is identical.
      const gate = PRE_OWNERSHIP_GATES.find((g) => g.id === c.expected)!;
      expect(v.rationale, `${c.label}: the classifier cited a different gate`).toBe(
        gate.rationale(summary, c.population === "resumableSessions"),
      );
      // And it really is the earliest applicable one, computed rather than assumed.
      const applicable = PRE_OWNERSHIP_GATES.filter((g) => g.applies(summary, c.population === "resumableSessions"));
      expect(applicable.length, `${c.label} must violate more than one gate to test precedence`).toBeGreaterThan(1);
      expect(order.indexOf(applicable[0]!.id)).toBe(order.indexOf(c.expected));
    }
  });

  it("authorizes nothing through any gate, so a malformed payload can never widen access", () => {
    for (const rule of rules) {
      expect(rule.verdict.relationship, rule.id).toBe("indeterminate");
      expect(rule.verdict.action, rule.id).toBe("unverifiable");
      for (const capability of [
        "resumable",
        "resumePermittedByProse",
        "requiresTakeover",
        "recoveryRequiresExplicitRequest",
        "bindsOwner",
      ]) {
        expect(rule.verdict[capability], `\`${rule.id}\` grants \`${capability}\``).toBe(false);
      }
    }
  });
});

describe("the fallback tells a reader holding several verdicts how to combine them", () => {
  /**
   * Mode A classifies EVERY surviving summary, so it can hold two verdicts. The
   * combining rule used to live inside the Mode B block, which a reader following
   * "read the one that applies" never opens -- the per-session divergence one
   * level up, resolved in practice as first-session-wins.
   */
  const rules = (JSON.parse(readFileSync(fixturePath, "utf-8")) as {
    aggregateRules: { id: string; condition: string; overallAction: string | null; rule: string; provenance: string }[];
  }).aggregateRules;

  const owner = { client: "claude" as const, id: "caller-task", boundAt: "2026-07-01T00:00:00Z" };
  function live(id: string, ownerTask: unknown) {
    return {
      sessionId: id,
      sourceDir: id,
      state: "IMPLEMENT",
      mode: "auto",
      compactPending: false,
      leaseState: "live",
      leaseExpiresAt: null,
      ownerTask,
    } as never;
  }

  function aggregateSection(): string {
    const text = fallback();
    const start = text.indexOf("## Aggregating across sessions");
    expect(start, "no aggregate section").toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.search(/\n## /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  it("covers all three population sizes", () => {
    expect(rules.map((r) => r.id)).toEqual(["none", "single", "multiple"]);
    const section = aggregateSection();
    for (const rule of rules) {
      expect(section).toContain(`\`${rule.id}\``);
      expect(section).toContain(rule.rule);
      expect(section, `\`${rule.id}\` states a rule with no provenance`).toContain(rule.provenance);
    }
  });

  it("is reachable by Mode A, not filed under Mode B where only one mode reads it", () => {
    const text = fallback();
    const modeA = text.indexOf("### Mode A");
    const modeB = text.indexOf("### Mode B");
    const aggregate = text.indexOf("## Aggregating across sessions");
    // A `## ` section is outside both `### ` mode blocks, so both modes reach it.
    expect(aggregate).toBeGreaterThan(modeB);
    expect(modeA).toBeGreaterThan(-1);
    expect(aggregateSection()).toMatch(/Both modes reach this section/);
    expect(aggregateSection()).toMatch(/Mode A/);
    // And it must precede the procedures, which are what a reader would otherwise
    // execute straight from a per-session verdict.
    expect(aggregate).toBeLessThan(text.indexOf("## Acting on a verdict"));
  });

  it("no longer claims Mode A has classified exactly one session", () => {
    expect(fallback()).not.toMatch(/it has classified exactly one session/);
  });

  it("matches what `classifySessionGuard` actually returns for each population size", () => {
    const caller = { task: owner, client: "claude" as const };

    const none = classifySessionGuard({ activeSessions: [], resumableSessions: [] }, caller);
    expect(none.overallAction).toBe(rules.find((r) => r.id === "none")!.overallAction);

    const one = classifySessionGuard({ activeSessions: [live("s-a", owner)], resumableSessions: [] }, caller);
    expect(one.sessions).toHaveLength(1);
    // `single` is stated as "that session's own action", not a fixed literal.
    expect(one.overallAction).toBe(one.sessions[0]!.action);

    const many = classifySessionGuard(
      {
        activeSessions: [
          live("s-a", owner),
          live("s-b", { client: "claude", id: "someone-else", boundAt: "2026-07-01T00:00:00Z" }),
        ],
        resumableSessions: [],
      },
      caller,
    );
    expect(many.sessions).toHaveLength(2);
    expect(many.overallAction).toBe(rules.find((r) => r.id === "multiple")!.overallAction);
    expect(many.overallAction).toBeNull();
    expect(many.primary, "a named primary is first-session-wins by another name").toBeNull();
    // The hazard: a permissive verdict really is present, and must not win.
    expect(many.sessions.map((s) => s.action)).toContain("continue");
  });

  it("forbids every resolution a reader would reach for under `multiple`", () => {
    const rule = rules.find((r) => r.id === "multiple")!;
    expect(rule.overallAction).toBeNull();
    expect(rule.rule).toMatch(/select none of them/i);
    expect(rule.rule).toMatch(/first/i);
    expect(rule.rule).toMatch(/most permissive/i);
    expect(rule.rule).toMatch(/matching your own task/i);
  });
});

describe("SKILL.md keeps the matrix out and points at the fallback", () => {
  it("carries no verdict-table rows of its own", () => {
    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).not.toMatch(/\|\s*`same-owner`\s*\|/);
    expect(skill).not.toMatch(/\|\s*`unowned-legacy`\s*\|/);
    expect(skill).not.toMatch(/\|\s*`expired-compact`\s*\|/);
  });

  it("references session-guard-fallback.md for both entry modes", () => {
    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).toContain("session-guard-fallback.md");
    // Mode A: the tool is confirmed absent. Mode B: overallAction is null.
    expect(skill).toMatch(/overallAction[^\n]*null/);
  });

  /**
   * The aggregate decision belongs to ISS-898, not to the prose. This is what
   * goes red if a future edit quietly reintroduces a precedence rule into
   * SKILL.md rather than filing it.
   */
  it("states no aggregate rule of its own for multiple bearing sessions", () => {
    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).not.toMatch(/most restrictive wins/i);
    expect(skill).not.toMatch(/same-owner takes precedence/i);
    expect(skill).not.toMatch(/pick (?:one|the first) session/i);
  });

  it("adds storybloq_session_guard to the Step 0.5 whitelist", () => {
    const skill = readFileSync(skillPath, "utf-8");
    const whitelist = skill.slice(skill.indexOf("Whitelist semantics"), skill.indexOf("## How to Handle Arguments"));
    expect(whitelist).toContain("storybloq_session_guard");
  });

  /**
   * Three outcomes, three different routes, and the file said two things about
   * one of them.
   *
   * A guard that is ABSENT routes to mode A. A guard that is present and FAILS
   * routed to the Step 0 setup/CLI fallback before this ticket, per the frozen
   * document ("its failure will route the skill to the Step 0 setup/CLI-fallback
   * path below"). An intermediate draft here declared that failure terminal --
   * a fail-closed behavior change with no sentence behind it -- and left the
   * contradictory sentence in the prelude while correcting the one in step 2. A
   * reader following the prelude would stop where the skill has always
   * continued, so the disagreement is the defect, not the wording.
   */
  it("routes a discovered-but-failing guard to the Step 0 fallback, in every place it says so", () => {
    const skill = readFileSync(skillPath, "utf-8");
    const step05 = skill.slice(skill.indexOf("## Step 0.5"), skill.indexOf("## How to Handle Arguments"));

    // Absent and failed must stay distinguishable, with their own routes.
    expect(step05).toMatch(/confirmed absent[\s\S]{0,600}mode A/i);
    // Absent-guard is itself TWO branches, separated by whether `storybloq_status`
    // can be called. Mode A's first instruction is to call it, so routing a
    // reader there with no MCP surface at all strands them in a procedure whose
    // input cannot be obtained -- the same condition covering both cases is what
    // made that reachable.
    expect(step05).toMatch(/whether `storybloq_status` is reachable/i);
    expect(step05).toMatch(/if NEITHER tool is reachable[\s\S]{0,240}Step 0/i);
    expect(step05, "the two absent-tool branches are not distinguished by the guard's absence alone").toMatch(
      /not by the guard's absence alone/i,
    );

    // The third failure: guard absent, status REACHABLE, and the status call
    // then fails. Mode A is entered only because the guard was absent, so
    // without a route this branch dead-ends inside a procedure whose input
    // cannot be obtained.
    expect(step05).toMatch(/its call fails[\s\S]{0,160}execution-failure rule\*\* in Step 0/i);
    // And the whitelist has to authorize it, or the route is prescribed and
    // forbidden in the same document.
    expect(step05).toMatch(/scoped to exactly two branches/i);
    expect(step05).toMatch(/mode A `storybloq_status` call fails to execute/i);
    // A SUCCESSFUL call reporting a problem is not that branch.
    expect(step05).toMatch(/does NOT cover\s+a status call that SUCCEEDS/i);

    // And the prescribed route must be REACHABLE. Step 0 declares MCP available
    // whenever any `storybloq_*` tool is listed, and a tool that errors stays
    // listed -- so without an explicit bypass, "go to Step 0" sends a failed
    // status call straight back into the same call. The route would loop.
    const step0 = skill.slice(skill.indexOf("## Step 0:"), skill.indexOf("## Step 1:"));
    expect(step0, "Step 0 has no execution-failure branch, so the route it is given loops").toMatch(
      /STEP 0.5 EXECUTION-FAILURE RULE/,
    );
    expect(step0).toMatch(/MCP counts as unavailable no matter what your tool list shows/i);
    expect(step0, "Step 0 does not forbid retrying the call that failed").toMatch(
      /do not retry the failed call[\s\S]{0,80}Step 2/i,
    );
    // The DESTINATION has to exist. Bypassing the presence test is not enough:
    // the setup cases cover a missing CLI and an unregistered MCP, and this is
    // neither -- the tool is registered and erroring -- so a route that lands
    // among them dead-ends before any context is loaded.
    expect(step0, "the failure rule does not skip the setup cases it cannot match").toMatch(
      /skip the presence test[\s\S]{0,120}setup cases/i,
    );
    expect(step0).toMatch(/go directly to the \*\*CLI context procedure\*\*/i);
    expect(step0, "the failure rule does not say why the setup cases cannot serve it").toMatch(
      /the CLI is typically installed and MCP IS registered, it is just erroring/i,
    );
    // And that procedure must be entered by this route, not only by a user
    // declining setup, and must actually run CLI context commands.
    const cliProcedure = skill.slice(skill.indexOf("**CLI context procedure.**"));
    expect(cliProcedure.slice(0, 400), "the CLI procedure does not admit the failure route").toMatch(
      /the Step 0.5 execution-failure rule sends you here/i,
    );
    expect(cliProcedure.slice(0, 1200)).toMatch(/storybloq status/);
    expect(cliProcedure.slice(0, 1200)).toMatch(/storybloq recap/);
    // A registered MCP server does not prove a shell-visible binary: it can be
    // launched via a local path, npx, a container, or a remote bridge. Without
    // this check the "fallback" is a command-not-found and no context loads.
    expect(cliProcedure.slice(0, 800), "the CLI procedure assumes a binary it never checks for").toMatch(
      /FIRST run `storybloq --version`/,
    );
    expect(cliProcedure.slice(0, 800)).toMatch(/proves nothing about a shell-visible binary/i);
    expect(cliProcedure.slice(0, 800), "no terminal branch when the CLI is absent too").toMatch(
      /stop with BOTH errors reported/i,
    );
    // Even in that dead end, the failed MCP call is still not retried.
    expect(cliProcedure.slice(0, 800)).toMatch(/do NOT retry the MCP call/i);
    // Stated ONCE and referenced, rather than restated at each dispatch site:
    // three prose copies of a routing rule drift into three routing rules.
    expect(step05.match(/\*\*Step 0.5 execution-failure rule\*\*/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(
      step0.match(/single authoritative statement/i),
      "no single authoritative statement of the failure rule",
    ).not.toBeNull();
    expect(step05).toMatch(/if the tool WAS discovered but its call fails/i);
    expect(step05).toMatch(/report the error and apply the \*\*Step 0.5 execution-failure rule\*\* in Step 0/i);
    // The route CHANGED; only the outcome carried over. Asserting the new route
    // is reachable is not enough, because the file also has to say so.
    expect(step05).toMatch(/preserves the fail-open OUTCOME[\s\S]{0,160}different ROUTE/i);
    expect(step05, "the new route is described as the historical one").not.toMatch(
      /route this skill has always taken|same route it always has/i,
    );
    const gaps = (() => {
      const text = fallback();
      const start = text.indexOf("- **ISS-900**");
      expect(start, "no ISS-900 known-gaps entry").toBeGreaterThan(-1);
      const rest = text.slice(start);
      const end = rest.search(/\n- \*\*|\n## /);
      return end === -1 ? rest : rest.slice(0, end);
    })();
    expect(gaps).toMatch(/preserves the\s+fail-open OUTCOME it always had, through a different ROUTE/i);
    expect(gaps).not.toMatch(/same route it always has/i);

    // And nowhere may it call that failure terminal. Bounded to Step 0.5 so the
    // word "terminal" elsewhere in the file (terminal CLI sessions) is not a
    // false positive.
    expect(step05, "Step 0.5 still calls a discovered tool's execution error terminal").not.toMatch(
      /execution error[^.]{0,120}\bstays terminal\b/i,
    );
    expect(step05).not.toMatch(/execution error[^.]{0,120}\bis terminal\b/i);
  });

  /**
   * Prescribing a route the whitelist forbids is the same defect as prescribing
   * none.
   *
   * Step 0.5's whitelist is authoritative while ownership is unresolved, and a
   * failed guard call leaves it unresolved by definition. Step 2 routes that
   * case to the Step 0 setup/CLI fallback -- CLI calls, file reads, subcommand
   * dispatch -- all of which the same paragraph otherwise forbids. Without an
   * explicit exception a compliant reader stops, which is the fail-closed
   * behavior this ticket reverted, arriving by a different door.
   */
  it("authorizes the Step 0 fallback it routes to, scoped to that branch alone", () => {
    const skill = readFileSync(skillPath, "utf-8");
    const whitelist = skill.slice(skill.indexOf("Whitelist semantics"), skill.indexOf("\n1. Call `storybloq_session_guard`"));
    expect(whitelist.length, "could not slice the whitelist paragraph").toBeGreaterThan(200);

    expect(whitelist, "the whitelist does not authorize the route step 2 prescribes").toMatch(
      /if a DISCOVERED `storybloq_session_guard` call fails[\s\S]{0,320}execution-failure rule\*\* in Step 0 and the CLI context procedure it enters are permitted/i,
    );
    // Scoped, not a general loosening: the prohibition must survive for
    // everything else.
    expect(whitelist).toMatch(/no other branch gains it/i);
    expect(whitelist).toMatch(/No other file read\/write, ledger mutation, subcommand dispatch/);
  });
});

describe("the fallback declares two entry modes with different inputs", () => {
  it("labels both modes explicitly", () => {
    const text = fallback();
    for (const mode of fixture.entryModes) {
      expect(text, `entry mode ${mode.id} missing`).toContain(mode.name);
    }
  });

  /**
   * Mode B must not rescan. A second read is a fresh filesystem observation: if
   * it happens to return one bearing session, the skill would silently resolve a
   * multiplicity the guard declined to resolve -- first-session-wins
   * reintroduced through a race.
   */
  it("separates the three ways mode A can fail to get a payload", () => {
    const text = fallback();
    const modeA = text.slice(text.indexOf("### Mode A"), text.indexOf("### Mode B"));
    // 1. The call itself errors: mode A has no input at all and stops.
    expect(modeA).toMatch(/FAILS TO EXECUTE/);
    // A REFERENCE, not a destination. Naming the generic setup route here is
    // what sent a registered-but-erroring tool into branches that cover a
    // missing CLI and an unregistered MCP, matching neither.
    expect(modeA).toMatch(/apply the \*\*Step 0.5 execution-failure rule\*\*/i);
    expect(modeA).toMatch(/sole authoritative definition lives in Step 0/i);
    expect(modeA, "mode A restates or renames the rule's destination").not.toMatch(/setup\/CLI-fallback route/);
    // 2. The call succeeds but JSON is unavailable on an older server.
    expect(modeA).toMatch(/JSON format is unavailable/);
    // 3. A payload that came back missing an array, handled by Policies.
    expect(modeA).toMatch(/missing an array/);
    // The three must be named as DISTINCT, since the remedies differ: stop and
    // route out, downgrade to Markdown, and treat as unverifiable respectively.
    expect(modeA).toMatch(/distinct/i);
    // And entering mode A at all requires the tool its first instruction calls.
    expect(modeA).toMatch(/AND storybloq_status is reachable/);
    expect(modeA).toMatch(/this mode does not apply/);
  });

  it("tells mode B not to call storybloq_status again", () => {
    const text = fallback();
    const modeB = text.slice(text.indexOf("multi-session"));
    expect(modeB).toMatch(/do not call `?storybloq_status`? again/i);
  });

  it("tells mode A to REUSE the status payload rather than observing twice", () => {
    const text = fallback();
    const modeA = text.slice(text.indexOf("### Mode A"), text.indexOf("### Mode B"));
    // The frozen contract says to reuse the guard's status result during context
    // loading. Dropping that turns one observation into two, with an ownership
    // decision taken between them, so the context presented can describe a
    // different state than the one classified.
    expect(modeA).toMatch(/retain the payload/i);
    expect(modeA).toMatch(/Step 2's\s+Project status result/i);
    expect(modeA).toMatch(/no second `storybloq_status` call/i);
    expect(modeA).toMatch(/fresh observation of the filesystem taken AFTER the ownership\s+decision/i);
  });

  it("hands Markdown-only mode A a payload Step 2 can actually use", () => {
    // Cross-artifact: the fallback permits one Markdown call when JSON is
    // unavailable, and SKILL.md's Step 2 requires JSON. Asserted together,
    // because each file is self-consistent and only the PAIR is wrong.
    const text = fallback();
    const modeA = text.slice(text.indexOf("### Mode A"), text.indexOf("### Mode B"));
    expect(modeA, "the fallback still offers a Markdown call it cannot use downstream").toMatch(
      /classified from the single permitted MARKDOWN response/i,
    );
    expect(modeA).toMatch(/SKIP Step 2's reconciliation/i);
    expect(modeA).toMatch(/ONE observation and reconciliation\s+exists only to close the gap between two/i);
    expect(modeA).toMatch(/no further status call/i);

    const skill = readFileSync(skillPath, "utf-8");
    const step2 = skill.slice(skill.indexOf("## Step 2: Load Context"), skill.indexOf("## Step 2b"));
    expect(step2, "SKILL.md does not honor the Markdown branch the fallback permits").toMatch(
      /mode A with a MARKDOWN payload/i,
    );
    expect(step2).toMatch(/SKIP step 1b entirely/i);
  });

  it("does not restate the execution-failure rule it declared authoritative elsewhere", () => {
    const text = fallback();
    const modeA = text.slice(text.indexOf("### Mode A"), text.indexOf("### Mode B"));
    expect(modeA).toMatch(/is authoritative and is not restated here/i);
    // The load-bearing clauses must live in ONE place, or the copy drifts.
    expect(modeA).not.toMatch(/skip the presence test/i);
    expect(modeA).not.toMatch(/setup cases/i);
  });

  it("tells mode A to obtain status JSON, since it has no verdict in hand", () => {
    const text = fallback();
    const modeA = text.slice(text.indexOf("tool absent"), text.indexOf("multi-session"));
    expect(modeA).toContain("storybloq_status");
  });

  /**
   * Not rescanning is not enough. Mode B's input is an array of DECIDED
   * verdicts; re-deriving them from the tables below is how the tool and the
   * legacy path drift apart, and no rescan check would catch it because no
   * rescan happened.
   */
  it("tells mode B not to reclassify the verdicts it was handed", () => {
    const text = fallback();
    const modeB = text.slice(text.indexOf("multi-session"), text.indexOf("## Verdict table"));
    expect(modeB).toMatch(/do not reclassify/i);
    expect(modeB).toMatch(/already a decided verdict/i);
    // And it must say where the verdicts are explained, without making that
    // section an instruction to execute one.
    expect(modeB).toMatch(/acting on a verdict/i);
  });

  /**
   * Every action the classifier can emit needs prose saying what it MEANS. A
   * verdict with no entry is a dead end for a reader who has one in hand.
   *
   * Deliberately not phrased as "mode B executes these". Mode B is the
   * multi-session case, where the source supplies no rule for combining
   * verdicts, so telling a reader to execute one of them is picking a
   * resolution the document does not contain. Mode A is where these are an
   * executable contract, because there it has classified exactly one session.
   */
  it("documents every action the guard emits", () => {
    const text = fallback();
    const acting = text.slice(text.indexOf("## Acting on a verdict"), text.indexOf("## Verdict table"));
    for (const action of ["continue", "auto-resume", "monitor-only", "offer-recovery", "unverifiable", "free"]) {
      expect(acting, `no entry for \`${action}\``).toContain(`\`${action}\``);
    }
  });

  /**
   * Mode B must not resolve the multiplicity in ANY direction.
   *
   * The earlier text said to "act on each verdict directly" while also warning
   * that a permissive verdict beside a restrictive one settles nothing. A reader
   * holding `continue` and `monitor-only` cannot satisfy both sentences, and the
   * one they are likelier to follow is the instruction. Three resolutions exist
   * -- permissive wins, restrictive wins, refuse to act -- and the source
   * supports none, so this file states the conflict and stops.
   */
  it("states the multi-session conflict without resolving it in either direction", () => {
    const text = fallback();
    const modeB = text.slice(text.indexOf("multi-session"), text.indexOf("## Verdict table"));

    expect(modeB).toMatch(/no aggregate rule/i);
    expect(modeB, "does not say the conflict is undetermined").toMatch(/undetermined|unresolved/i);
    expect(modeB, "does not name the hazard of letting the permissive verdict win").toMatch(/ISS-554/);
    expect(modeB, "does not defer the decision").toMatch(/ISS-898/);

    // Neither resolution may be prescribed. "Act on each verdict" picks the
    // permissive one; a refusal picks the terminal one. Both are inventions.
    expect(modeB, "mode B still instructs per-verdict execution").not.toMatch(/act on it directly/i);
    expect(modeB, "mode B still instructs per-verdict execution").not.toMatch(/apply each session's own rule/i);
    expect(modeB, "mode B invents a refusal the source does not contain").not.toMatch(
      /do not act on any|take no action|refuse to act on/i,
    );
  });

  /**
   * The execution implication hid in the section's own preamble.
   *
   * "A dropped argument changes what actually gets called" is a sentence about
   * EXECUTION, and it sat directly under a paragraph saying mode B does not
   * execute. Naming which mode may execute is what makes the two consistent.
   */
  it("marks the procedures executable in mode A and reference-only in mode B", () => {
    const text = fallback();
    const acting = text.slice(text.indexOf("## Acting on a verdict"), text.indexOf("## Verdict table"));
    // Whitespace-tolerant: the generator hard-wraps this prose, so a literal
    // space would make these assertions depend on where a line happens to break.
    expect(acting, "does not say mode A is where these execute").toMatch(
      /in mode A an\s+abbreviated\s+instruction is a behavior change/i,
    );
    expect(acting, "does not mark mode B reference-only").toMatch(/in mode B\s+they are REFERENCE definitions/i);
    expect(acting, "does not forbid executing one while the conflict is unresolved").toMatch(
      /must\s+not be used to select or execute an action while the aggregate conflict is\s+unresolved/i,
    );
    // The old wording, which implied mode B calls these.
    expect(acting, "the preamble still implies mode B executes").not.toMatch(
      /Mode B has no tables to\s+fall back on/i,
    );
  });

  /**
   * The SAME claim reappeared in a second preamble, 200 lines down. Slicing only
   * the procedures section left the provenance section free to restore
   * executable authority to the very procedures it introduces.
   */
  it("keeps the Actions provenance preamble reference-only for mode B too", () => {
    const text = fallback();
    const actions = text.slice(text.indexOf("### Actions"), text.indexOf("## Known gaps"));
    expect(actions.length, "could not slice the Actions provenance section").toBeGreaterThan(200);
    expect(actions, "the provenance preamble restores mode B execution").not.toMatch(/in mode B it is the only one/i);
    expect(actions).toMatch(/authorizes no selection or\s+execution while the aggregate conflict is unresolved/i);
  });
});

/**
 * Naming an action is not the same as prescribing it. In mode A this section IS
 * the executable contract -- it has classified one session and acts on it -- so a
 * dropped argument or a missing branch is a behavior change even when every
 * classification still matches the fixture byte for byte. In mode B the same
 * text says what a verdict means, not that a reader should execute one while
 * another session's verdict contradicts it.
 *
 * These requirements are written HERE rather than read from the fixture or the
 * generator on purpose. An expectation derived from the same source as the
 * output can only prove the generator copied it; it cannot prove the copy says
 * what Step 0.5 says. Each entry cites the sentence it holds the prose to.
 */
describe("each action procedure carries its load-bearing parameters and branches", () => {
  /** The prose for one action, bounded so a neighbour's text cannot satisfy it. */
  function procedure(id: string): string {
    const text = fallback();
    const start = text.indexOf(`### \`${id}\``);
    expect(start, `no procedure section for \`${id}\``).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const nextHeading = rest.search(/\n#{1,6} /);
    return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  }

  const REQUIREMENTS: Record<string, { cite: string; must: RegExp[]; mustNot?: RegExp[] }> = {
    "auto-resume": {
      cite: "full sessionId, action: resume, clientTaskId WHEN RESOLVED, omitted when identity is unavailable",
      must: [
        /full `sessionId`/,
        /`action: "resume"`/,
        /`clientTaskId`/,
        /do not ask for another confirmation/i,
        // U4 emits this action with no identity at all. A procedure that always
        // demands the field leaves that reader inventing a value or failing,
        // instead of taking the resume-without-binding path the prose preserves.
        // Coupled to identity resolution in both directions, so wording that
        // always omits, or always passes while mentioning omission elsewhere,
        // cannot satisfy it.
        /`clientTaskId` when a task id resolved/i,
        /if identity is UNAVAILABLE, omit `clientTaskId`/i,
        // Field-specific: an unqualified "without binding" reads as a claim
        // about ownership as a whole, and `claudeCodeSessionId` is the half
        // that is not covered by it.
        /without binding a new `ownerTask`/i,
      ],
    },
    "monitor-only": {
      cite: "branch on relationship; recovery reachable only on explicit request AND all three flags true; otherwise explain and stop",
      must: [
        // This action name covers TWO relationships. The flags decide whether
        // RECOVERY is reachable; they do not decide the UX cell, and an
        // ownerless session has no owner task to name, open, or relay to.
        /BRANCH ON `relationship` FIRST/i,
        /`foreign-live`[\s\S]{0,140}foreign-task UX/i,
        /`unowned-legacy`[\s\S]{0,120}no owner task/i,
        /offer ONLY Monitor or work here on something else/i,
        /do not name an owner, do not offer Open task, do not relay/i,
        /recoveryRequiresExplicitRequest/,
        /resumePermittedByProse/,
        /requiresTakeover/,
        // The names alone are not the rule. Swapping `&&` for `||` leaves every
        // individual name matching while authorizing takeover on ONE true flag.
        /recoveryRequiresExplicitRequest\s*&&\s*resumePermittedByProse\s*&&\s*requiresTakeover/,
        // U2 passes all three flags with `resumable: false`, so the branch is
        // reachable with no `clientTaskId` to form the call out of.
        /the prescribed call requires a CURRENT `clientTaskId`/i,
        /do not invent an id, do not pass null, and do not omit it/i,
        /cannot be formed/i,
        // And the reason must stay the missing argument, not the flag: gating on
        // `resumable` is a client-side refusal, which is ISS-898 case 2.
        /it is not the reason for stopping/i,
        /confirm the recorded owner task is gone/i,
        /full `sessionId`/,
        /current `clientTaskId`/,
        /`takeover: true`/,
        // The negative branch. Without it the false-flag case is undefined.
        /if one of those three is false, explain why recovery is unavailable and stop/i,
      ],
    },
    "offer-recovery": {
      cite: "offer Resume here, End session, or Back; Resume only after explicit selection with full sessionId and current clientTaskId; End session enters typed cancellation",
      must: [
        /Resume here, End session, or Back/,
        /only after explicit selection/i,
        /full `sessionId`/,
        /typed cancellation/i,
        // U5 emits this action with NO identity. Conditional in both directions,
        // or a reader meets a required argument it cannot supply.
        /`clientTaskId` when a task id resolved/i,
        /if identity is UNAVAILABLE, omit `clientTaskId`/i,
        // Field-specific, because the two ownership representations behave
        // differently: `ownerTask` is preserved, and the legacy field is not.
        // "Nothing rebinds" alone was compatible with two false readings -- that
        // the session ends up unowned, and that nothing is written at all.
        /no new `ownerTask` is bound/i,
        /any `ownerTask` already recorded is preserved/i,
        /`claudeCodeSessionId`/,
        /derives `claudeCodeSessionId` from (?:an existing )?`ownerTask`/i,
        // The codex half must be stated as CLEARING: the measured behavior
        // removes an existing legacy id there.
        /CLEARS? the field for a codex owner|CLEARED for a codex owner/i,
        /ISS-898 case 3/,
      ],
      mustNot: [
        // Wording this round disproved. "Not mirrored" and "leaves the field
        // alone" both read as preservation, and the measured behavior deletes an
        // existing legacy id. An unqualified ownership claim is the other half:
        // accurate field-specific prose can sit beside a blanket sentence that
        // contradicts it, and only a negative catches that.
        /is not mirrored/i,
        /leaves the field alone/i,
        /ownership is untouched/i,
        /without binding(?! a new `ownerTask`)/i,
      ],
    },
    unverifiable: {
      cite: "stop and tell the user to run storybloq session list; do not guess and do not offer Resume",
      // Named broadly on purpose: `missing-arrays` and `do-not-guess` route here
      // too, so prose that blames the lease would misdiagnose those failures.
      must: [/state, lease, identity, or reported session population/i, /`storybloq session list`/, /do not guess/i, /do not offer Resume/i],
    },
    "sessionstart-on-request": {
      cite: "older-server COMPACT: no menu, no unsolicited offer; follow SessionStart only after the user asks, guide authoritative",
      must: [
        /do not offer recovery/i,
        /only after the user asks to continue/i,
        /SessionStart/,
        /guide remains authoritative/i,
      ],
      // The whole point of splitting it out of `offer-recovery`.
      mustNot: [/End session/, /Back\b/],
    },
    continue: {
      cite: "no banner, no Resume prompt, process owner replies directly",
      must: [
        /do not show an Active Autonomous Session banner/i,
        /do not ask for Resume/i,
        // Dropping this turns the action into "say nothing", which is not what
        // the prose says to do with an owner's reply.
        /process owner replies such as `Ratify T-020` directly/i,
      ],
    },
    free: {
      cite: "nothing is running; continue to argument routing",
      // Without the continuation step this action is a dead end: the guard has
      // answered, and nothing tells the reader to proceed.
      must: [/nothing is running/i, /continue to argument routing/i],
      mustNot: [/resume/i],
    },
  };

  for (const [id, req] of Object.entries(REQUIREMENTS)) {
    it(`\`${id}\`: ${req.cite}`, () => {
      const prose = procedure(id);
      for (const pattern of req.must) {
        expect(prose, `\`${id}\` procedure is missing ${String(pattern)}`).toMatch(pattern);
      }
      for (const pattern of req.mustNot ?? []) {
        expect(prose, `\`${id}\` procedure should not mention ${String(pattern)}`).not.toMatch(pattern);
      }
    });
  }

  /**
   * Action notes explain where one action name collapses several prose cells.
   * The generator can drop them and byte identity stays green, because it
   * compares the file to what the generator produces, not to the fixture's
   * content.
   */
  it("checks caller identity BEFORE walking the user through owner-gone confirmation", () => {
    const text = fallback();
    const start = text.indexOf("## `monitor-only`");
    expect(start, "no monitor-only procedure").toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.search(/\n## /);
    const proc = next === -1 ? rest : rest.slice(0, next);

    const identity = proc.search(/CHECK CALLER IDENTITY BEFORE ANYTHING ELSE/i);
    const confirm = proc.search(/confirm the recorded owner task is gone/i);
    expect(identity, "no identity check in the recovery branch").toBeGreaterThan(-1);
    expect(confirm, "no owner-gone confirmation").toBeGreaterThan(-1);
    // Order is the whole point: asking for a destructive-looking confirmation
    // and only then revealing that no call can be formed is the worse failure.
    expect(identity, "identity is checked only after the user has been asked to confirm").toBeLessThan(confirm);
    expect(proc).toMatch(/do NOT ask the user to confirm the recorded owner is gone/i);

    // And the cost is recorded as what it is, in EVERY place that speaks to it.
    // A whole-file search passed while the `resumable` preamble and the known-gaps
    // entry still called withholding the call a future ISS-898 decision, which is
    // exactly the intra-file contradiction this should catch.
    const regionBetween = (from: string, to: RegExp): string => {
      const start = text.indexOf(from);
      expect(start, `no region starting "${from}"`).toBeGreaterThan(-1);
      const rest = text.slice(start + from.length);
      const end = rest.search(to);
      return end === -1 ? rest : rest.slice(0, end);
    };

    const regions: [string, string][] = [
      ["the `resumable` preamble", regionBetween("`resumable` reports whether", /\n## /)],
      ["the monitor-only action note", regionBetween("One action name for three prose cells", /\n- \*\*|\n## /)],
      ["the ISS-898 known-gaps entry", regionBetween("- **ISS-898**", /\n- \*\*ISS-899\*\*/)],
    ];
    for (const [label, region] of regions) {
      expect(region.length, `${label} came back empty`).toBeGreaterThan(80);
      // Each must say the call is not issued...
      expect(region, `${label} does not say the call is no longer issued`).toMatch(
        /(not issued|no longer issued|CLIENT-SIDE REFUSAL|stops before\s+any confirmation|CALL is not)/i,
      );
      // ...and must NOT assign withholding the CALL to future ISS-898 work.
      expect(region, `${label} still assigns withholding the call to ISS-898`).not.toMatch(
        /withholding the (offer or the )?call[^.]{0,80}(belongs to|is) ISS-898/i,
      );
    }
    expect(text, "the file does not admit the refusal it performs").toMatch(/observably a CLIENT-SIDE REFUSAL/i);
    expect(text, "the remaining open question is not stated").toMatch(/REPRESENTATION question/i);
  });

  it("renders each action note below its citation, never inside the quote", () => {
    let multiFragmentActions = 0;
    const text = fallback();
    const noted = fixture.actions.filter((a) => a.note !== undefined);
    expect(noted.length, "no action carries a note").toBeGreaterThan(0);

    // Bounded to each action's own citation entry, so a note that drifted under
    // a DIFFERENT action would not satisfy its owner's assertion.
    // Bounded to the Actions section, THEN to each entry. Slicing to EOF would
    // let the last action's entry swallow the Known gaps section, so a note
    // parked there would still satisfy its owner's placement check.
    const actionsAt = text.indexOf("### Actions");
    const gapsAt = text.indexOf("## Known gaps");
    expect(actionsAt, "no Actions citation section").toBeGreaterThan(-1);
    expect(gapsAt, "no Known gaps section to bound Actions against").toBeGreaterThan(actionsAt);
    const citations = text.slice(actionsAt, gapsAt);
    for (const action of noted) {
      const start = citations.indexOf(`- **\`${action.id}\`**`);
      expect(start, `citation entry for \`${action.id}\` is missing`).toBeGreaterThan(-1);
      const rest = citations.slice(start + 1);
      const next = rest.search(/\n- \*\*`/);
      const entry = next === -1 ? rest : rest.slice(0, next);

      expect(entry, `note for \`${action.id}\` was dropped`).toContain(action.note!);
      // Below the blockquote, not folded into it: interpretation must not
      // acquire the authority of the quoted sentence.
      //
      // Each ` / ` fragment must appear as its OWN blockquote. The separator is
      // editorial, not document text, and the fragments can come from different
      // frozen regions -- the provenance check validates them one at a time. A
      // single blockquote holding the joined string would render as one
      // contiguous verbatim quotation and claim a contiguity nothing asserts.
      const fragments = action.source.split(" / ");
      let quoteAt = -1;
      for (const fragment of fragments) {
        const at = entry.indexOf(`> ${fragment}`);
        expect(at, `fragment not rendered as its own quote for \`${action.id}\`: ${fragment.slice(0, 40)}`).toBeGreaterThan(-1);
        quoteAt = Math.max(quoteAt, at);
      }
      if (fragments.length > 1) {
        multiFragmentActions += 1;
        // The joined form, separator and all, must appear nowhere: that string
        // is what a single-blockquote render would emit.
        expect(entry, `\`${action.id}\` rendered its fragments as one quotation`).not.toContain(action.source);
      }
      expect(entry.indexOf(action.note!)).toBeGreaterThan(quoteAt);
      // And rendered as its own paragraph, not as another blockquote line.
      expect(entry, `note for \`${action.id}\` is inside the quote`).toContain(`\n\n  Note: ${action.note!}`);
      expect(action.source, `\`${action.id}\` folded its note into the quote`).not.toContain(action.note!);
      // The NOTE is prose a reader takes as authoritative too, and the disproven
      // ownership wording survived there twice after the procedure was fixed.
      for (const forbidden of [
        /is not mirrored/i,
        /leaves the field alone/i,
        /ownership is untouched/i,
        // The same blanket claim in its other form. A note may say "without
        // binding" only when it names the field that is not bound.
        /without binding(?! a new `ownerTask`)/i,
      ]) {
        expect(action.note ?? "", `\`${action.id}\` note contains disproven wording ${forbidden}`).not.toMatch(forbidden);
      }
    }
    // The split-rendering assertions above are only meaningful if some action
    // actually carries more than one fragment. If the fixture ever stops having
    // one, this check goes red instead of passing vacuously.
    expect(multiFragmentActions, "no multi-fragment action was checked").toBeGreaterThan(0);
  });

  it("cites a complete sentence from an approved frozen-document region for every action", () => {
    const text = fallback();
    const citations = text.slice(text.indexOf("### Actions"));
    for (const id of Object.keys(REQUIREMENTS)) {
      expect(citations, `no citation for \`${id}\``).toContain(`**\`${id}\`**`);
    }
  });

  it("covers every action the fixture defines, so a new one cannot ship unasserted", () => {
    const ids = (JSON.parse(readFileSync(fixturePath, "utf-8")) as { actions: { id: string }[] }).actions.map((a) => a.id);
    expect(ids.slice().sort()).toEqual(Object.keys(REQUIREMENTS).sort());
  });
});

/**
 * These policies are the fallback's answers for the cases with no verdict row,
 * so the ACTION each one prescribes is the whole content. A test that only
 * checked an id exists and some wording appears somewhere would pass while a
 * policy said the opposite of what it should -- which is exactly how
 * `missing-arrays` briefly said `free`, authorizing work beside a session the
 * server declined to report.
 */
describe("fallbackPolicies prescribe the right action", () => {
  const CANONICAL: Record<string, { action: string; match: RegExp; why: string }> = {
    "missing-arrays": {
      action: "unverifiable",
      match: /an absent key means the server did not report that population/i,
      why: "an absent key is an unknown population, not an empty one",
    },
    "json-status-unavailable": {
      action: "monitor-only",
      match: /unverifiable legacy/i,
      why: "Step 0.5 allows Monitor or other work on a markdown-only status",
    },
    // The other half of the same sentence. Losing it leaves the older-server
    // COMPACT path with no rule at all, which is a compatibility regression
    // rather than a classification one, so nothing else in this file catches it.
    //
    // Deliberately NOT `offer-recovery`: that procedure presents a Resume /
    // End session / Back menu, and the older-server sentence presents nothing
    // and waits to be asked. Forcing a compatibility rule into the nearest
    // GuardAction is how an unsolicited offer gets added to a legacy path.
    "json-status-compact": {
      action: "sessionstart-on-request",
      match: /only after the user asks to continue; the guide remains authoritative/i,
      why: "the markdown-status sentence has a COMPACT half, and Mode A replaces the prose that carried it",
    },
    "do-not-guess": {
      action: "unverifiable",
      match: /do not guess/i,
      why: "undeterminable state stops rather than assumes",
    },
  };

  for (const [id, expected] of Object.entries(CANONICAL)) {
    it(`${id} is \`${expected.action}\`, because ${expected.why}`, () => {
      const policy = fixture.fallbackPolicies.find((p) => p.id === id);
      expect(policy, `policy ${id} is missing from the fixture`).toBeTruthy();
      expect(policy!.expectedAction).toBe(expected.action);

      // Matched against THIS policy's own text, not the whole document. Phrases
      // like "do not guess" and the SessionStart sentence also appear in the
      // action procedures and the citations, so a whole-file match would stay
      // green while the policy itself lost or contradicted its wording.
      expect(policy!.rule, `policy ${id} rule`).toMatch(expected.match);

      // The generated file states the action, not just the rule text -- and the
      // wording is checked inside that bullet, for the same reason.
      const text = fallback();
      const bulletStart = text.indexOf(`- **${id}** (\`${expected.action}\`)`);
      expect(bulletStart, `no generated bullet for policy ${id}`).toBeGreaterThan(-1);
      const rest = text.slice(bulletStart + 1);
      const nextBullet = rest.search(/\n- \*\*|\n#{1,6} /);
      expect(nextBullet === -1 ? rest : rest.slice(0, nextBullet), `generated bullet for ${id}`).toMatch(expected.match);
    });
  }

  /**
   * Stated as its own assertion because it is the specific regression: `free`
   * means "nothing is running", and the whole point of this policy is that we
   * do not know whether anything is running.
   */
  it("never lets missing-arrays resolve to `free`", () => {
    const policy = fixture.fallbackPolicies.find((p) => p.id === "missing-arrays")!;
    expect(policy.expectedAction).not.toBe("free");
    expect(policy.expectedAction).not.toBe("continue");
    expect(fallback()).not.toMatch(/\*\*missing-arrays\*\* \(`free`\)/);
  });

  /**
   * A policy may name a guard action OR a procedure declared fallback-only.
   * Requiring the former for everything is what forced the older-server COMPACT
   * rule into `offer-recovery` and added a menu the prose never authorized: a
   * compatibility path has no guard verdict to correspond to, because a server
   * that can answer the guard can answer JSON status too.
   */
  it("prescribes only procedures that exist, guard action or declared fallback-only", () => {
    const guardActions = new Set(["continue", "auto-resume", "monitor-only", "offer-recovery", "unverifiable", "free"]);
    const actions = (JSON.parse(readFileSync(fixturePath, "utf-8")) as {
      actions: { id: string; fallbackOnly?: boolean }[];
    }).actions;
    const fallbackOnly = new Set(actions.filter((a) => a.fallbackOnly === true).map((a) => a.id));

    for (const policy of fixture.fallbackPolicies) {
      const known = guardActions.has(policy.expectedAction) || fallbackOnly.has(policy.expectedAction);
      expect(known, `no procedure named ${policy.expectedAction} for policy ${policy.id}`).toBe(true);
    }
    // And a fallback-only id is never one the guard can emit, or the exemption
    // would be a hole rather than a category.
    for (const id of fallbackOnly) {
      expect(guardActions.has(id), `${id} is declared fallback-only but is a real GuardAction`).toBe(false);
    }
  });

  it("covers every policy in the fixture, so a new one cannot slip in unasserted", () => {
    expect(fixture.fallbackPolicies.map((p) => p.id).sort()).toEqual(Object.keys(CANONICAL).sort());
  });
});

describe("Codex approval allowlist", () => {
  it("includes storybloq_session_guard, or Codex prompts on every invocation", () => {
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).toContain("storybloq_session_guard");
  });
});

describe("the fallback file ships", () => {
  /**
   * A generated file that setup-skill does not copy is a file no user ever
   * reads. SKILL.md would point at a path that does not exist on disk, and the
   * two entry modes would both dead-end.
   */
  it("is listed among the skill support files copied by setup-skill", () => {
    const source = readFileSync(join(pkgRoot, "src", "cli", "commands", "setup-skill.ts"), "utf-8");
    const supportFiles = source.slice(source.indexOf("const supportFiles"), source.indexOf("const supportFiles") + 400);
    expect(supportFiles).toContain("session-guard-fallback.md");
  });

  /**
   * Asserted against the PACKED artifact, not against a `files` pattern that
   * looks plausible. A bare `dist` entry does not cover a file under `src/skill`,
   * so a pattern-only check stays green while setup-skill points at a path that
   * is absent from the published tarball.
   */
  it("is included in the published package", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkgRoot, encoding: "utf-8" });
    const packed = JSON.parse(out) as { files: { path: string }[] }[];
    const paths = packed[0]?.files.map((f) => f.path) ?? [];
    expect(paths.length, "npm pack reported no files").toBeGreaterThan(0);
    expect(paths, "session-guard-fallback.md is not in the packed tarball").toContain(
      "src/skill/session-guard-fallback.md",
    );
  });
});
