#!/usr/bin/env tsx
/**
 * Generates `src/skill/session-guard-fallback.md` from
 * `test/fixtures/session-guard-matrix.json` (T-446).
 *
 * The fixture is the single source of truth for both the classifier tests and
 * this shipped prose, so the tool and the legacy path cannot disagree about
 * classification. Hand-editing the output is pointless: a byte-identity test
 * regenerates it and compares.
 *
 * Usage:
 *   tsx scripts/gen-guard-matrix.ts            # write the file
 *   tsx scripts/gen-guard-matrix.ts --stdout   # print it (used by the test)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(pkgRoot, "test", "fixtures", "session-guard-matrix.json");
const OUT = join(pkgRoot, "src", "skill", "session-guard-fallback.md");

interface Row {
  id: string;
  description: string;
  source: string;
  /** Interpretation, kept OUT of `source` so citations stay verbatim. */
  note?: string;
  input: { owner: string; compact: boolean; compactPending: boolean; leaseState: string };
  verdict: {
    relationship: string;
    action: string;
    resumable: boolean;
    resumePermittedByProse: boolean;
    requiresTakeover: boolean;
    recoveryRequiresExplicitRequest: boolean;
    bindsOwner: boolean;
  };
}

interface Fixture {
  identityAvailable: Row[];
  identityUnavailable: Row[];
  noVerdict: { id: string; description: string; reason: string }[];
  fallbackPolicies: { id: string; rule: string; expectedAction: string }[];
  entryModes: { id: string; name: string; reachedWhen: string; input: string; mayCallStatus: boolean }[];
  actions: { id: string; instruction: string; source: string; note?: string; fallbackOnly?: boolean }[];
  indeterminateState: {
    id: string;
    description: string;
    state: string;
    source: string;
    verdict: Row["verdict"];
  }[];
  validWorkflowStates: string[];
  indeterminateStateRule: string;
  dedupeRule: { id: string; rule: string; source: string };
  terminalStateRule: {
    id: string;
    state: string;
    rule: string;
    classifierGateId: string;
    basis: string;
    population: string;
    input: { states: string | string[]; compactPending: string | boolean[]; leaseStates: string | string[] };
    basisNote: string;
    source?: string;
    verdict: Row["verdict"];
  };
  unknownStateRule: { id: string; basis: string; note: string };
  aggregateRules: {
    id: string;
    condition: string;
    overallAction: string | null;
    rule: string;
    provenance: string;
    /** ISS-897: the second axis. Applies when scan completeness is `incomplete` or `unknown`. */
    overallActionWhenScanIncomplete: string | null;
    /** Population-specific effect only; the shared tail is appended at render time. */
    ruleWhenScanIncomplete: string;
  }[];
  scanCompletenessRule: {
    id: string;
    field: string;
    rule: string;
    /**
     * The address-selection and malformed/unknown remedy procedure, stated ONCE
     * and appended to every `ruleWhenScanIncomplete` row at render time.
     *
     * The rendered document still repeats it under each population size, and it
     * has to: a reader follows exactly one row, so a qualifier present in two of
     * three is a rule with a hole in one population size. What must not be
     * repeated is the SOURCE -- three hand-maintained copies is how a correction
     * lands on one row and leaves the other two contradicting it.
     */
    addressAndRemedyProcedure: string;
    cases: { payload: string; completeness: string; note: string }[];
    /**
     * ISS-897: which category each kind carries. The rule above checks the PAIR,
     * so the pairing has to be rendered or a Mode A reader cannot apply it.
     */
    kindCategoryTable: {
      purpose: string;
      omission: string[];
      undetermined: string[];
      normalized: string[];
      collision: string[];
      examples: { payload: string; completeness: string; note: string }[];
    };
    unknownRemedy: string;
  };
  /** ISS-897: withholds the aggregate when a record the scan ADMITTED has an unreadable OWNER. */
  ownershipRule: {
    id: string;
    trigger: string;
    rule: string;
    whyNotCompleteness: string;
    boundary: string;
    zeroSurvivorNote: string;
    remedy: string;
    provenance: string;
  };
  /**
   * ISS-897: how Mode A must RENDER the untrusted text it is told to print.
   *
   * Mode A reads `sessionDiagnostics` off a status payload and names the values
   * in its report. The typed guard sanitizes its own prose before returning it;
   * Mode A has no layer between the payload and the output, so the rule has to
   * live in the document the reader follows or it does not exist.
   */
  renderingSafety: {
    id: string;
    why: string;
    rule: string;
    whyThatOrder: string;
    /** Per-value AND per-collection limits, since Mode A has no layer applying them. */
    bounds: string;
    /** `ownerTask` and `schemaVersion` need step-zero serialization, whatever their runtime type. */
    structuredValues: string;
    lossyVsReversible: string;
    reasonIsNotInstruction: string;
    scope: string;
  };
  /**
   * ISS-897: an ADMITTED record whose `schemaVersion` this build does not
   * support. Blocks on its own axis, like ownership, and for the same reason:
   * nothing was concealed, so completeness must not be the thing that stops it.
   */
  schemaVersionRule: {
    id: string;
    trigger: string;
    rule: string;
    whyNotCompleteness: string;
    boundary: string;
    remedy: string;
    provenance: string;
  };
  /** ISS-914: the third axis. Applies when one id occurs under two or more DISTINCT directories. */
  collisionRule: {
    id: string;
    trigger: string;
    rule: string;
    appliesEvenWhenRecordsAgree: boolean;
    agreementNote: string;
    zeroSurvivorNote: string;
    independentOfCompleteness: string;
    remedy: string;
    provenance: string;
  };
  /** ISS-897: a repeated `(sessionId, sourceDir)` pair, which is NOT a directory collision. */
  repeatedEntryRule: {
    id: string;
    trigger: string;
    rule: string;
    remedy: string;
    whyNotCollision: string;
    provenance: string;
  };
  populationInvariantRules: {
    id: string;
    population: string;
    violation: string;
    input: { states: string; compactPending: string | boolean[]; leaseStates: string | string[] };
    rule: string;
    basisNote: string;
    verdict: Row["verdict"];
  }[];
  gateOrder: { id: string; documentedIn: string }[];
}

const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Fixture;

const yn = (b: boolean): string => (b ? "yes" : "no");

/**
 * A gate's domain for one field. `any` is the literal string in the fixture and
 * means the predicate never reads that field, so the rule fires for every value.
 * Rendering one sample instead would publish a rule narrower than the tool's.
 */
/** Which array(s) a rule claims. `both` is a real domain, not a shorthand. */
function populationLabel(value: string): string {
  if (value === "both") return "`activeSessions`, `resumableSessions`";
  return `\`${value}\``;
}

function domain(value: string | boolean[] | string[]): string {
  if (value === "any") return "`any`";
  if (value === "any-except-COMPACT") return "any except `COMPACT`";
  if (Array.isArray(value)) return value.map((v) => `\`${String(v)}\``).join(", ");
  throw new Error(`unknown domain value: ${JSON.stringify(value)}`);
}

/**
 * The rendered verdict is taken from the first rule, so every other rule must
 * carry the same one or the file would document a verdict no longer produced.
 * Checked here rather than assumed, because the assumption is invisible at the
 * call site.
 */
function assertUniformVerdicts(): void {
  const [first, ...rest] = fixture.populationInvariantRules;
  if (!first) throw new Error("no population-invariant rules");
  for (const rule of rest) {
    if (JSON.stringify(rule.verdict) !== JSON.stringify(first.verdict)) {
      throw new Error(
        `population rule \`${rule.id}\` has a verdict differing from \`${first.id}\`; the section renders only one, ` +
          "so render a verdict column per row before introducing this",
      );
    }
  }
}

/**
 * `any-owner` and `any` are DIFFERENT domains and collapsing them breaks mode A.
 *
 * `any-owner` (U1, U2) means an `ownerTask` exists but the caller cannot be
 * compared against it. `any` (7, 7b, U5, U6) means present or absent. Rendering
 * both as "any" made U2 -- live, COMPACT, monitor-only -- appear to cover an
 * ownerless live COMPACT session, which is U4's row and prescribes auto-resume.
 * A mode A reader IS the classifier, so two rows matching one session with
 * conflicting actions is not a cosmetic problem: it decides whether a migration
 * recovery happens or not.
 *
 * The default throws. A fixture typo that silently widened a row is exactly the
 * failure this function just had.
 */
function ownerLabel(owner: string): string {
  switch (owner) {
    case "same":
      return "same as caller";
    case "different":
      return "different from caller";
    case "none":
      return "none";
    case "any-owner":
      return "any recorded owner";
    case "any":
      return "present or absent";
    default:
      throw new Error(`unknown owner domain in fixture: ${owner}`);
  }
}

/**
 * `compactPending` is a classification axis, not decoration: it is what decides
 * whether a non-live COMPACT record is a recovery candidate at all or produces
 * no verdict. A table that omits it invites a reader to apply the expired or
 * indeterminate row to a `compactPending: false` session.
 */
function table(rows: Row[]): string {
  const head =
    "| # | Session owner | COMPACT | Pending | Lease | Relationship | Action | Resume permitted | Server accepts | Takeover | Explicit request | Binds new ownerTask |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const body = rows
    .map((r) => {
      const v = r.verdict;
      return `| ${r.id} | ${ownerLabel(r.input.owner)} | ${yn(r.input.compact)} | ${yn(r.input.compactPending)} | ${r.input.leaseState} | \`${v.relationship}\` | \`${v.action}\` | ${yn(v.resumePermittedByProse)} | ${yn(v.resumable)} | ${yn(v.requiresTakeover)} | ${yn(v.recoveryRequiresExplicitRequest)} | ${yn(v.bindsOwner)} |`;
    })
    .join("\n");
  return `${head}\n${body}`;
}

/**
 * A `source` may carry more than one run of sentences, separated by ` / `. That
 * separator is editorial: it is not text of the frozen document, and the
 * fragments on either side of it may come from DIFFERENT quotable regions, which
 * the provenance test checks one fragment at a time. Rendering the joined string
 * after a single blockquote marker would present all of it as one contiguous
 * verbatim quotation -- a stronger claim than anything asserted anywhere. So
 * each fragment gets its own blockquote and the separator is not rendered.
 */
function citation(source: string, indent = "  "): string {
  return source
    .split(" / ")
    .map((fragment) => `${indent}> ${fragment}`)
    .join("\n\n");
}

function sources(rows: Row[]): string {
  return rows
    .map((r) => {
      const quote = `- **${r.id}** (${r.description})\n${citation(r.source)}`;
      // Rendered below the quote, never inside it: the citation has to stay
      // verbatim (a test checks it against the three approved regions of the
      // frozen pre-T-446 document), and
      // interpretation folded into a quotation is how commentary acquires the
      // authority of the text it is commenting on.
      return r.note === undefined ? quote : `${quote}\n\n  Note: ${r.note}`;
    })
    .join("\n");
}

function render(): string {
  assertUniformVerdicts();
  const modeA = fixture.entryModes.find((m) => m.id === "A")!;
  const modeB = fixture.entryModes.find((m) => m.id === "B")!;

  return `<!-- GENERATED by scripts/gen-guard-matrix.ts from test/fixtures/session-guard-matrix.json. Do not edit by hand: a byte-identity test regenerates this file and compares. -->

# Session guard: legacy path

The \`storybloq_session_guard\` tool answers "is anything running, and may I write?"
in one call. This file is what to do when you cannot use its answer directly.
Everything below is the same classification the tool applies, generated from the
same source, so the two cannot drift apart.

## Entry modes

There are two ways to arrive here and **they do not share an input.** Read the one
that applies.

### Mode A: ${modeA.name}

**Reached when:** ${modeA.reachedWhen}

**Input:** ${modeA.input}

### Mode B: ${modeB.name}

**Reached when:** ${modeB.reachedWhen}

**Input:** ${modeB.input} **Do not call \`storybloq_status\` again.**

Rescanning is not a harmless double-check. A second read is a fresh observation of
the filesystem: a session can start, end, or expire in between, so you would apply
these rules to a set that never produced the verdict you are responding to. Worse,
if the rescan happens to return a single bearing session you would silently resolve
a multiplicity the guard deliberately declined to resolve, which is
first-session-wins reintroduced through a race.

**Do not reclassify.** Each entry in that array is already a decided verdict: it
carries its own \`relationship\`, \`action\`, and capability flags. Re-deriving them
from the tables below is how the tool and the legacy path drift apart, and nothing
would catch it -- you would not have rescanned, so a no-rescan check still passes.
Each verdict's \`action\` names what the source procedure prescribes FOR THAT
SESSION, and "Acting on a verdict" below sets out each one in full. The tables in
this file are Mode A's classifier; in Mode B they are reference material only.

**There is no aggregate rule, and this file will not invent one.** Mode B is
reached because the guard already found more than one bearing session, so the
\`multiple\` row of "Aggregating across sessions" below is your case. Read it
there: it is shared with Mode A rather than stated here, because a rule kept in
one mode's block is a rule the other mode never reads.

## Aggregating across sessions

**Both modes reach this section, and Mode A reaches it by the ordinary path.**
Mode A's input is a whole status payload, so it classifies EVERY session that
survives, and can easily hold two verdicts. This section is placed here because
it defines what the final answer looks like, but it is applied LAST: Mode A must
first apply "Deduplicate before classifying", then the ordered gates, then the
ownership tables, all rendered below, and return here only with the surviving
verdicts in hand. Combining them is not left to judgement; there is exactly one
rule per population size, and it is the same rule the tool applies.

### Before any of it, how to RENDER what you report (\`${fixture.renderingSafety.id}\`)

**This applies to every branch below.** ${fixture.renderingSafety.why}

${fixture.renderingSafety.bounds}

${fixture.renderingSafety.structuredValues}

${fixture.renderingSafety.rule}

${fixture.renderingSafety.whyThatOrder}

${fixture.renderingSafety.lossyVsReversible}

${fixture.renderingSafety.reasonIsNotInstruction}

${fixture.renderingSafety.scope}

### First, scan completeness (\`${fixture.scanCompletenessRule.id}\`)

**Derive this FIRST.** It is the second axis of every rule below, and it is not
expressible as an action: \`free\` over a scan with an
observation gap is indistinguishable from \`free\` over a clean one, and that gap
could conceal a live session, which is the failure this rule exists to make
visible. A gap is an entry the scan saw and could not read, OR a fault against
the collection itself where nothing was enumerated at all. The value you derive here selects
which column of each rule below applies.

${fixture.scanCompletenessRule.rule}

| \`${fixture.scanCompletenessRule.field}\` in the payload | Completeness | Why |
|---|---|---|
${fixture.scanCompletenessRule.cases
    .map((c) => `| ${c.payload} | \`${c.completeness}\` | ${c.note} |`)
    .join("\n")}

#### Which category each kind carries

${fixture.scanCompletenessRule.kindCategoryTable.purpose}

| Category | Kinds |
|---|---|
| \`omission\` | ${fixture.scanCompletenessRule.kindCategoryTable.omission.map((k) => `\`${k}\``).join(", ")} |
| \`undetermined\` | ${fixture.scanCompletenessRule.kindCategoryTable.undetermined.map((k) => `\`${k}\``).join(", ")} |
| \`normalized\` | ${fixture.scanCompletenessRule.kindCategoryTable.normalized.map((k) => `\`${k}\``).join(", ")} |
| \`collision\` | ${fixture.scanCompletenessRule.kindCategoryTable.collision.map((k) => `\`${k}\``).join(", ")} |

| Mismatched payload | Completeness | Why |
|---|---|---|
${fixture.scanCompletenessRule.kindCategoryTable.examples
    .map((c) => `| ${c.payload} | \`${c.completeness}\` | ${c.note} |`)
    .join("\n")}

**When completeness is \`unknown\`:** ${fixture.scanCompletenessRule.unknownRemedy}

### Second, collisions (\`${fixture.collisionRule.id}\`)

**Derive this SECOND, still before any population rule.** Like completeness, it
decides whether the population rules may speak at all, and it is not expressible
as an action. It reads the outcome of \`Deduplicate before classifying\`, which is
rendered further down this file for the same reason this whole section is placed
early: reading order and application order are not the same here.

**Trigger:** ${fixture.collisionRule.trigger}

${fixture.collisionRule.rule}

${fixture.collisionRule.agreementNote}

${fixture.collisionRule.zeroSurvivorNote}

${fixture.collisionRule.independentOfCompleteness}

**Remedy:** ${fixture.collisionRule.remedy}

> Provenance: ${fixture.collisionRule.provenance}

### Also a dropped record, and NOT a collision (\`${fixture.repeatedEntryRule.id}\`)

**Trigger:** ${fixture.repeatedEntryRule.trigger}

${fixture.repeatedEntryRule.rule}

${fixture.repeatedEntryRule.whyNotCollision}

**Remedy:** ${fixture.repeatedEntryRule.remedy}

> Provenance: ${fixture.repeatedEntryRule.provenance}

### Third, undetermined ownership (\`${fixture.ownershipRule.id}\`)

**Also before any population rule.** Like a collision, this withholds the
aggregate without making the scan incomplete.

**Trigger:** ${fixture.ownershipRule.trigger}

${fixture.ownershipRule.rule}

${fixture.ownershipRule.whyNotCompleteness}

${fixture.ownershipRule.boundary}

${fixture.ownershipRule.zeroSurvivorNote}

**Remedy:** ${fixture.ownershipRule.remedy}

> Provenance: ${fixture.ownershipRule.provenance}

### Fourth, an unsupported schema version (\`${fixture.schemaVersionRule.id}\`)

**Also before any population rule.** Like undetermined ownership, this withholds
the aggregate without making the scan incomplete.

**Trigger:** ${fixture.schemaVersionRule.trigger}

${fixture.schemaVersionRule.rule}

${fixture.schemaVersionRule.whyNotCompleteness}

${fixture.schemaVersionRule.boundary}

**Remedy:** ${fixture.schemaVersionRule.remedy}

> Provenance: ${fixture.schemaVersionRule.provenance}

### Then, the rule for the population size

${fixture.aggregateRules
    .map(
      (r) =>
        `- **${r.condition}** (\`${r.id}\`)\n\n` +
        `  Scan \`complete\` -> \`overallAction\`: ${
          r.overallAction === null ? "**none** (the tool returns `null`)" : `\`${r.overallAction}\``
        }\n\n  ${r.rule}\n\n` +
        `  Scan \`incomplete\` or \`unknown\` -> \`overallAction\`: ${
          r.overallActionWhenScanIncomplete === null
            ? "**none** (the tool returns `null`)"
            : `\`${r.overallActionWhenScanIncomplete}\``
        }\n\n  ${r.ruleWhenScanIncomplete} ${fixture.scanCompletenessRule.addressAndRemedyProcedure}\n\n  > Provenance: ${r.provenance}`,
    )
    .join("\n\n")}

## Acting on a verdict

Mode A arrives here after classifying with the tables below. In Mode B these are
what each verdict MEANS, not an instruction to execute one while another session's
verdict contradicts it.

These are the procedures in full, not summaries of them. In Mode A an abbreviated
instruction is a behavior change: where the section above yields a single action to
apply, Mode A acts on it, so a dropped argument or a missing branch changes what
gets called. Reaching a procedure at all requires that the aggregate above named
one; under \`multiple\` no procedure is selected. In Mode B
they are REFERENCE definitions -- what each verdict means, for reporting -- and must
not be used to select or execute an action while the aggregate conflict is
unresolved.

\`resumable\` reports whether the server will accept a \`resume\` call. It is
informational: do not use it to DECIDE whether to make one. It appears in one
procedure below, \`monitor-only\`, and only as corroboration when explaining that
a takeover call cannot be formed without a caller identity. What stops that call
is the missing \`clientTaskId\`, a fact about the input rather than a policy read
off this flag.

Be plain about what that costs: stopping there is observably a CLIENT-SIDE
REFUSAL, so the call U2 historically issued is no longer issued and no server
rejection is observed. T-446 took that deliberately, as a recorded exception to
its own transcribe-do-not-fix rule, because the alternative is prescribing a call
that cannot be formed. ISS-898 case 2 now owns only the REPRESENTATION question:
whether this row should advertise the capability at all, or report it unavailable
up front.

${fixture.actions
    .map((a) => `### \`${a.id}\`${a.fallbackOnly === true ? " (fallback only)" : ""}\n\n${a.instruction}`)
    .join("\n\n")}

## Deduplicate before classifying

${citation(fixture.dedupeRule.source, "")}

${fixture.dedupeRule.rule}

## Gate order

A record can violate more than one rule below. It stops at the FIRST gate in this
list, which is the order the tool evaluates them in. Read this list, not the
section order: these gates are deliberately not grouped by topic, and
\`recovery-not-compact\` runs AFTER the terminal and unknown-state gates even
though it sits in the population section with its siblings.

${fixture.gateOrder.map((g, i) => `${i + 1}. \`${g.id}\` -- see "${g.documentedIn}"`).join("\n")}

Every gate here yields \`indeterminate\` / \`unverifiable\` with all capabilities
false. They differ only in which one you cite, so citing the wrong one is a
reporting error rather than an authorization error -- but report the first.

## Terminal sessions

Gate \`${fixture.terminalStateRule.id}\`.\n\n${fixture.terminalStateRule.rule}\n\n| Population | \`state\` | \`compactPending\` | \`leaseState\` |\n|---|---|---|---|\n| ${populationLabel(fixture.terminalStateRule.population)} | ${domain(fixture.terminalStateRule.input.states)} | ${domain(fixture.terminalStateRule.input.compactPending)} | ${domain(fixture.terminalStateRule.input.leaseStates)} |\n\n> Basis: ${fixture.terminalStateRule.basisNote}

| State | Relationship | Action | Resume permitted | Server accepts | Takeover | Explicit request | Binds new ownerTask |
|---|---|---|---|---|---|---|---|
| \`${fixture.terminalStateRule.state}\` | \`${fixture.terminalStateRule.verdict.relationship}\` | \`${fixture.terminalStateRule.verdict.action}\` | ${yn(fixture.terminalStateRule.verdict.resumePermittedByProse)} | ${yn(fixture.terminalStateRule.verdict.resumable)} | ${yn(fixture.terminalStateRule.verdict.requiresTakeover)} | ${yn(fixture.terminalStateRule.verdict.recoveryRequiresExplicitRequest)} | ${yn(fixture.terminalStateRule.verdict.bindsOwner)} |

## Population invariants

Each array carries its own promise about the records inside it. A record that
breaks the promise of the array it arrived in is classified here, BEFORE the
ownership tables, and never by them: its own fields contradict the population, so
no ownership row applies to it. Every one of these is
\`indeterminate\` / \`unverifiable\` with all capabilities false, and the answer is
to tell the user to run \`storybloq session list\`.

Each row states the rule's FULL domain. \`any\` means the rule does not read that
field at all, so it fires for every value: these are conditions, not examples.

| Population | \`state\` | \`compactPending\` | \`leaseState\` | Rule |
|---|---|---|---|---|
${fixture.populationInvariantRules
    .map(
      (r) =>
        `| \`${r.population}\` | ${domain(r.input.states)} | ${domain(r.input.compactPending)} | ${domain(
          r.input.leaseStates,
        )} | \`${r.id}\` |`,
    )
    .join("\n")}

A record can sit in more than one domain above; "Gate order" decides which rule
you cite. Every row yields exactly this verdict, with no exceptions and no
variation by population:

${Object.entries(fixture.populationInvariantRules[0]!.verdict)
    .map(([k, v]) => `- \`${k}\`: \`${JSON.stringify(v)}\``)
    .join("\n")}

${fixture.populationInvariantRules
    .map((r) => `- **\`${r.population}\`, ${r.violation}** (\`${r.id}\`)\n\n  ${r.rule}\n\n  > Basis: ${r.basisNote}`)
    .join("\n\n")}

## Undetermined session state\n\nGate \`${fixture.unknownStateRule.id}\`.

Checked BEFORE ownership, and independent of it, which is why it is placed
ahead of the verdict tables rather than after them: a reader working through
this file in order must decide this question before reaching a row that assumes
the state is valid. The scanner substitutes
\`"unknown"\` for an absent \`state\` and copies through whatever string is present,
while every ownership row branches on \`state === "COMPACT"\` -- so without this
check an undetermined state reads as a valid non-COMPACT one, and a same-owner
caller could be told to \`continue\` a session that actually needs COMPACT
recovery.

**The rule.** ${fixture.indeterminateStateRule}

**The valid set**, which is the same list the classifier checks against:

${fixture.validWorkflowStates.map((s) => `\`${s}\``).join(", ")}

Anything else, without exception. Examples:

${fixture.indeterminateState
    .map((r) => `- **${r.id}** ${r.description} -> \`${r.verdict.relationship}\` / \`${r.verdict.action}\`, every capability false.\n${citation(r.source)}`)
    .join("\n")}

## Verdict table: caller identity available

${table(fixture.identityAvailable)}

## Verdict table: caller identity unavailable

Applies whenever the caller's task id cannot be resolved. Missing or malformed
identity never blocks the legacy workflow, but it cannot prove same-task
ownership, so nothing here classifies as \`same-owner\`, and a resume binds no new
\`ownerTask\`. That flag says nothing about \`claudeCodeSessionId\`, which recovery
can still write; see U5's note.

${table(fixture.identityUnavailable)}

## Configurations that produce no verdict

${fixture.noVerdict.map((r) => `- **${r.id}** ${r.description}. ${r.reason}`).join("\n")}

## Policies

${fixture.fallbackPolicies.map((p) => `- **${p.id}** (\`${p.expectedAction}\`): ${p.rule}`).join("\n")}

## Where each row comes from

Every row and every procedure quotes the guard contract as it stood before the
typed guard existed, frozen at \`test/fixtures/skill-step-0.5-pre-t446.md\`. Three
regions of that document are quotable: Step 0.5 itself, the client task identity
paragraph it depends on, and the do-not-guess sentence in Step 3. A citation is
one or more COMPLETE consecutive sentences from one of them, asserted by test, so
a quote cannot be trimmed to drop the rule in its tail. Where a row rests on more
than one run of sentences, each run is rendered as its OWN blockquote and is
validated separately against a single region: the runs may come from different
regions, so presenting them as one quotation would claim a contiguity the
document does not have. That requirement covers the ownership rows, the state
gate, the deduplication rule, and the procedures below. It does NOT cover the population invariants or the
terminal-session rule: the source has no sentence about a record whose own fields
contradict the array carrying it, nor about a terminal session turning up in one,
because it never contemplates either. Those rules cite nothing and instead
declare \`basis: observed-classifier\` against a named production gate, with their
full domain parity-tested against it in every population they claim. A rule with neither a citation
nor that constrained basis does not belong in this file. Interpretation appears as a Note beneath the
quote, never inside it: the action names below are this tool's own vocabulary and
appear nowhere in the source document.

### Caller identity available

${sources(fixture.identityAvailable)}

### Caller identity unavailable

${sources(fixture.identityUnavailable)}

### Actions

The per-action procedures above transcribe these sentences. They are cited for the
same reason the rows are: in mode A this section is the executable contract; in
mode B it documents each verdict for reporting only and authorizes no selection or
execution while the aggregate conflict is unresolved.

${fixture.actions
    .map((a) => {
      const quote = `- **\`${a.id}\`**\n${citation(a.source)}`;
      return a.note === undefined ? quote : `${quote}\n\n  Note: ${a.note}`;
    })
    .join("\n")}

## Known gaps, filed not fixed

- **ISS-897** -- the scanner conceals damaged sessions. An unreadable or malformed
  \`state.json\`, a symlinked entry, or a record with an unexpected \`status\`
  silently vanishes from the scan, so the verdict reads \`free\` while a live
  session sits beside you.
- **ISS-898** -- (a) no aggregate rule exists for more than one bearing session,
  which is why mode B exists at all; (b) a foreign COMPACT session permits a
  takeover that the guide would reject when the caller has no identity. The OFFER
  is preserved here, because that is today's behavior; the CALL is not, because
  its required \`clientTaskId\` cannot be formed, so the procedure stops before
  any confirmation and no server rejection is observed. That execution half is
  T-446's deliberate exception; what remains open is whether this row should
  advertise the capability at all; (c) expired-COMPACT
  recovery is documented only as passing the current \`clientTaskId\` and
  rebinding ownership, with no variant for a caller that has neither. The offer
  is preserved (missing identity never blocks the legacy workflow) and the call
  is accepted by the guide. Nothing rebinds \`ownerTask\`: no new one is bound and
  any already recorded is preserved. The legacy field is NOT untouched: recovery
  derives \`claudeCodeSessionId\` from \`ownerTask\` wherever one is recorded,
  writing a claude owner's id and CLEARING it for a codex owner, and leaves it
  alone only when there is no owner. Both that acceptance and those
  per-field outcomes are observed rather than inferred, across the whole owner
  axis the row spans: see
  \`test/autonomous/identity-free-expired-resume.test.ts\`.
- **ISS-899** -- RULED AND PARTLY CLOSED. This classification still ignores
  \`claudeCodeSessionId\` because Step 0.5 never consults it for
  ownership classification and the scanner does not project it, while the guide
  still resolves ownership through it. Of the two
  cells that disagreed, one is now CLOSED and one remains open BY DESIGN, and the
  two directions are opposite, so neither describes the other.
  CLOSED: a session recording an \`ownerTask\` with a LIVE lease, met by a caller
  with no identity. The guide used to accept it while this guard advised
  monitor-only; the guide now refuses it too, so the two AGREE. Expired leases are
  untouched and still accept an identity-free caller.
  OPEN BY DESIGN: an ownerless session carrying a legacy id that does not match
  the caller. This guard reads it as unowned-legacy and advises attempting a
  COMPACT recovery; the guide adjudicates against the stored id and may refuse.
  The guard is LOOSER here, and SKILL.md now describes the attempt and the refusal
  path rather than promising the bind. A third cell, an ownerless legacy-id session
  met by an identity-free caller, is deliberately left on its existing split
  behaviour and is filed separately.
- **ISS-900** -- Step 0.5 says what to do when the guard tool is ABSENT (this
  file) but not when it is present and its call FAILS. Today a failure preserves the
  fail-open OUTCOME it always had, through a different ROUTE: the Step 0.5
  execution-failure rule enters the CLI context procedure directly, because the
  generic setup block has no branch for a registered-but-erroring tool.
`;
}

const output = render();
if (process.argv.includes("--stdout")) {
  process.stdout.write(output);
} else {
  writeFileSync(OUT, output);
  process.stderr.write(`wrote ${OUT}\n`);
}
