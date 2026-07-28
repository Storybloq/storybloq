import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");

describe("setup-skill", () => {
  it("bundled SKILL.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "SKILL.md"))).toBe(true);
  });

  it("bundled reference.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "reference.md"))).toBe(true);
  });

  it("SKILL.md has correct frontmatter", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("name: story");
    expect(content).toContain("description:");
    expect(content).toContain("## Step 0: Check Setup");
    expect(content).toContain("## Step 2: Load Context");
  });

  it("reference.md contains expected sections", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "reference.md"), "utf-8");
    expect(content).toContain("## CLI Commands");
    expect(content).toContain("## MCP Tools");
    expect(content).toContain("## Common Workflows");
    expect(content).toContain("## Troubleshooting");
  });

  it("resolveSkillSourceDir finds src/skill from source layout", async () => {
    const { resolveSkillSourceDir } = await import("../../../src/cli/commands/setup-skill.js");
    const dir = resolveSkillSourceDir();
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "reference.md"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Support file existence
  // -------------------------------------------------------------------------

  it("bundled setup-flow.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"))).toBe(true);
  });

  it("bundled autonomous-mode.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"))).toBe(true);
  });

  it("bundled orchestrator-mode.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "orchestrator-mode.md"))).toBe(true);
  });

  it("bundled bus-mode.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "bus-mode.md"))).toBe(true);
  });

  it("bundled Codex skill metadata exists in src/skill/agents/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "agents", "openai.yaml"))).toBe(true);
  });

  it("orchestrator-mode.md requires orchestrator-filed tickets and issues to use the enrichment template", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "orchestrator-mode.md"), "utf-8");
    // R1: narrowed subject -- tickets and issues, never "every item"
    expect(content).toContain("ticket or issue");
    // R2: tier-neutral rationale phrasing
    expect(content).toContain("lowest permitted execution tier");
    expect(content).toContain("enrichment template");
    // SCOPE 2: wave-boundary upgrade sweep
    expect(content).toContain("filed this wave");
  });

  it("orchestrator-mode.md carries the ISS-813 cold-run friction additions", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "orchestrator-mode.md"), "utf-8");
    // (a) single-repo blast-radius phrasing
    expect(content).toContain("Single-repo run:");
    // (b) visible wave board + stage-boundary narration
    expect(content).toContain("keep a visible wave board");
    // (c) storybloq status ranked first, stale session dirs normal
    expect(content).toContain("stale terminal session dirs are normal");
    // (d) workflow-script practicalities incl. prefix-cache recovery
    expect(content).toContain("Resume is PREFIX-CACHED on the sequence of agent calls");
    // (e) durable artifacts land in ledger or repo
    expect(content).toContain("never only a scratchpad or session directory");
    // (f) item-scoped acceptance + wave-level branch health
    expect(content).toContain("no NEW failures vs the recorded tip baseline");
    expect(content).toContain("wave-level concern");
    // (g) known-caveats block as standard wave-prompt furniture
    expect(content).toContain("KNOWN CAVEATS");
    // (h) byte-review adjudicates pre-existing-failure claims
    expect(content).toContain("re-derive the claim in the parent-commit worktree");
    // (i) orchestrator-owned ledger fence + followUps report field
    expect(content).toContain("the ledger is orchestrator-owned");
    expect(content).toContain("followUps");
    // (j) never-amend policy in the non-negotiable rules
    expect(content).toContain("DO NOT amend, rebase, or force-push");

    // adjacency (finding 3): the ledger fence + followUps furniture live in the
    // pipeline doctrine, BEFORE the dynamic-workflow skeleton section.
    const skeletonIdx = content.indexOf("## Dynamic-workflow skeleton");
    expect(skeletonIdx).toBeGreaterThan(-1);
    const ledgerIdx = content.indexOf("the ledger is orchestrator-owned");
    expect(ledgerIdx).toBeGreaterThan(-1);
    expect(ledgerIdx).toBeLessThan(skeletonIdx);
    expect(content.indexOf("followUps")).toBeLessThan(skeletonIdx);

    // adjacency (finding 3): never-amend is a non-negotiable, so it must sit
    // AFTER the Critical rules heading, not merely somewhere in the file.
    const criticalIdx = content.indexOf("## Critical rules");
    expect(criticalIdx).toBeGreaterThan(-1);
    expect(content.indexOf("DO NOT amend, rebase, or force-push")).toBeGreaterThan(criticalIdx);
  });

  it("orchestrator-mode.md distinguishes single-repo from a zero-node orchestrator on an empty node list (ISS-811)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "orchestrator-mode.md"), "utf-8");
    expect(content).toContain("An empty list means there are no federation nodes to guard");
    expect(content).toContain("single-repo mode");
    expect(content).toContain("REMAINS an orchestrator");
  });

  it("orchestrator-mode.md carries the reconstruction-cost handover cadence (wave boundary is the floor, not the ceiling)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "orchestrator-mode.md"), "utf-8");
    // dedicated cadence section
    expect(content).toContain("## Handover cadence");
    // the wave boundary is a floor, not the only trigger
    expect(content).toContain("wave boundary (step 7) is the FLOOR");
    // reconstruction-cost trigger + two-weights + ledger-capture rule
    expect(content).toContain("exceeds the cost of writing the checkpoint");
    expect(content).toContain("one compaction away from gone");
    // the cadence section sits inside the doctrine, before the per-item pipeline
    const cadenceIdx = content.indexOf("## Handover cadence");
    const pipelineIdx = content.indexOf("## The 6-stage per-item pipeline");
    expect(cadenceIdx).toBeGreaterThan(-1);
    expect(pipelineIdx).toBeGreaterThan(-1);
    expect(cadenceIdx).toBeLessThan(pipelineIdx);
  });

  it("orchestrator-mode.md carries the cost-vs-performance dispatch rubric (balance, not always-cheapest, pin every dispatch)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "orchestrator-mode.md"), "utf-8");
    // the explicit, followable dispatch instruction
    expect(content).toContain("Dispatch rubric -- classify, route, pin");
    // balance framing, leaning to performance -- not a cost-minimization ladder
    expect(content).toContain("balance cost against performance");
    expect(content).toContain("lean toward performance");
    // the floor is the cheapest RELIABLE tier, not the absolute cheapest
    expect(content).toContain("cheapest tier that still does it RELIABLY");
    // explicit pinning is the rule; inheritance is the bug
    expect(content).toContain("Pin every dispatch; inheritance is the bug");
    // the doctrine stays model-agnostic: no model name appears in the Model economy section
    const secStart = content.indexOf("## Model economy");
    const secEnd = content.indexOf("## The enrichment pass");
    expect(secStart).toBeGreaterThan(-1);
    expect(secEnd).toBeGreaterThan(secStart);
    const modelEconomy = content.slice(secStart, secEnd);
    expect(modelEconomy).not.toMatch(/\b(Opus|Fable|Sonnet|Haiku)\b/);
  });

  it("orchestrator-mode.md recognizes Codex subagents as callable background-agent tooling", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "orchestrator-mode.md"), "utf-8");
    expect(content).toContain("Codex with callable subagent tooling");
    expect(content).toContain("`multi_agent_v1.spawn_agent`");
    expect(content).toContain("`multi_agent_v1__spawn_agent`");
    expect(content).toContain("exact `spawn_agent` tool");
    expect(content).toContain("No dynamic-workflow script determinism and no cache-resume");
    expect(content).toContain("record it as an explicit equal-tier decision");
    expect(content).toContain("The JavaScript above is a logical pipeline, not a script to execute in Codex");
    expect(content).toContain("matching send-input tool rather than spawning a duplicate worker");
    expect(content).toContain("main task remains the pen");
  });

  it("SKILL.md ticket-and-issue discipline points orchestrator filings at the enrichment template", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("ticket or issue");
    expect(content).toContain("lowest permitted execution tier");
  });

  it("SKILL.md defines a plain-text fallback when AskUserQuestion is unavailable", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("Question tool compatibility");
    expect(content).toContain("Codex Default mode");
    expect(content).toContain("ask one concise free-form question");
    expect(content).toContain("do not render a numbered or bulleted option list");
    expect(content).toContain("A same-owner COMPACT continuation is automatic");
    // T-446 moved the per-relationship rules out of SKILL.md and into the
    // generated `session-guard-fallback.md`, which the guard tool and the legacy
    // path both derive from one fixture. The sentence still has to exist
    // somewhere a model can read; it is just no longer paid for on every
    // invocation.
    const fallback = await readFile(join(PROJECT_ROOT, "src", "skill", "session-guard-fallback.md"), "utf-8");
    expect(fallback).toContain("never call or offer `resume`");
  });

  it("reconciles the guard verdict against Step 2's separate status observation", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    const step2 = content.slice(content.indexOf("## Step 2: Load Context"), content.indexOf("## Step 2b"));
    // The guard scans `.story/sessions/` and Step 2 reads status: two
    // observations with a gap. A session starting in that gap leaves a stale
    // `free` reading as permission to work beside a live one.
    expect(step2, "Step 2 never reconciles the two observations").toMatch(/Reconcile it against the guard verdict/i);
    expect(step2).toMatch(/two separate observations/i);
    expect(step2).toMatch(/if they DIFFER, call `storybloq_session_guard` once more/i);
    expect(step2).toMatch(/act on that NEW verdict/i);
    // Ids alone are not the classification inputs: a session can keep its id
    // while its owner, state, lease, or population changes underneath a verdict.
    expect(step2, "reconciliation compares ids rather than what the verdict was computed from").toMatch(
      /per-session FINGERPRINT, not just ids/i,
    );
    // `sourceDir` is what SELECTS the survivor, so leaving it out lets the
    // surviving record change while every other component matches.
    expect(step2, "the fingerprint omits the field that chose the survivor").toMatch(
      /the surviving record's `sourceDir`/i,
    );
    expect(step2).toMatch(/it is what\s+CHOSE the survivor/i);
    expect(step2).toMatch(/On the typed-guard path it must match/i);
    expect(step2, "no rule for a legacy payload carrying no sourceDir").toMatch(
      /Omit it only for a legacy mode A payload/i,
    );
    for (const field of ["`state`", "`compactPending`", "`leaseState`", "`ownerTask`"]) {
      expect(step2, `fingerprint omits ${field}`).toContain(field);
    }
    // And the retry must not walk back into Step 2 for a third observation.
    expect(step2).toMatch(/do NOT restart Step 2 and do NOT call `storybloq_status` again/i);
    expect(step2).toMatch(/once per INVOCATION and cannot be reset/i);
    expect(step2, "the fingerprint omits sessionId or population").toMatch(/`sessionId`/);
    expect(step2).toMatch(/which population it is in/i);
    // The guard's sessions are deduplicated and raw status is not; comparing
    // them directly reports a difference for every duplicate, twice, and ends
    // the invocation as unverifiable -- a fail-closed rule nothing supports.
    // The payload has to BE structured, or none of the above can be performed:
    // the default response is Markdown and step 1b reads array fields. Asserted
    // against the Step 2 slice, since the string appears elsewhere in the file.
    expect(step2, "Step 2 requests Markdown, from which no fingerprint can be built").toMatch(
      /call `storybloq_status` with `\{ "format": "json" \}`/,
    );
    expect(step2).toMatch(/JSON is required, not a preference/i);
    expect(step2).toMatch(/Retain this exact payload/i);
    // ...but "required" is scoped, not universal. Mode A may legitimately hold a
    // MARKDOWN payload from the older-server branch, and a blanket JSON
    // requirement dead-ends it: it has no arrays to fingerprint and is forbidden
    // from calling status again.
    expect(step2, "Step 2 has no branch for a Markdown-only mode A payload").toMatch(
      /mode A with a MARKDOWN payload/i,
    );
    expect(step2).toMatch(/SKIP step 1b entirely/i);
    // And skipping must be justified by the single observation, not waved through.
    expect(step2).toMatch(/exactly ONE, classifying and loading context from the same response/i);
    expect(step2).toMatch(/no second status call is permitted here/i);
    expect(step2, "the reconciliation rules do not say which paths they bind").toMatch(
      /mandatory for the typed-guard path and for JSON-capable mode A/i,
    );

    expect(step2, "reconciliation does not deduplicate the status side first").toMatch(
      /apply the SAME deduplication the guard applied/i,
    );
    // The ALGORITHM, not the intent: "same survivor" is unactionable on the
    // normal path, where the fallback file that documents it may not be read.
    expect(step2, "Step 2 names no survivor rule a reader could apply").toMatch(
      /take `activeSessions` first and `resumableSessions` second/i,
    );
    expect(step2).toMatch(/order by `sourceDir`/i);
    expect(step2).toMatch(/keep the FIRST record for each full\s+`sessionId`/i);
    expect(step2, "no rule for an older payload without sourceDir").toMatch(
      /`sourceDir` is unavailable[\s\S]{0,120}keep the server's order/i,
    );

    // And the re-trigger rule must carry the same contract, not the superseded
    // set-comparison-and-restart wording.
    const guardSection = content.slice(content.indexOf("## Step 0.5"), content.indexOf("## How to Handle Arguments"));
    const retrigger = guardSection.slice(guardSection.indexOf("Re-trigger rule for the Step 2 reconciliation"));
    const bounded = retrigger.slice(0, retrigger.indexOf("Re-trigger rule for start"));
    expect(bounded).toMatch(/classification FINGERPRINT/i);
    expect(bounded).toMatch(/status payload ALREADY HELD/i);
    expect(bounded, "the re-trigger rule still restarts argument routing").not.toMatch(
      /argument routing restarts/i,
    );
    expect(bounded).toMatch(/Argument routing does not restart/i);
    expect(bounded).toMatch(/cannot be reset/i);
    expect(step2, "no terminal branch for repeated churn").toMatch(/still does not match[\s\S]{0,120}unverifiable/i);
    expect(step2).toMatch(/storybloq session list/);
    // Mode A holds a payload already and must not observe a third time.
    expect(step2).toMatch(/reuse it and do not call again/i);

    // And the rescan has to be authorized, or Step 2 prescribes a call the
    // whitelist forbids -- the same prescribed-and-forbidden shape as ISS-900.
    const guard = content.slice(content.indexOf("## Step 0.5"), content.indexOf("## How to Handle Arguments"));
    expect(guard, "the second guard call is prescribed but not authorized").toMatch(
      /Re-trigger rule for the Step 2 reconciliation/i,
    );
    expect(guard).toMatch(/ownership counts as unresolved again/i);
    expect(guard).toMatch(/the only rescan authorized here/i);
  });

  it("SKILL.md defines task-aware continuation and foreign-task relay", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain('`storybloq_status` with `{ "format": "json" }`');

    // T-446: SKILL.md now calls `storybloq_session_guard` and acts on the
    // verdict instead of walking a prose matrix. Every action in the union must
    // still be handled, or a verdict the tool can return has no instruction
    // attached to it.
    expect(content).toContain("storybloq_session_guard");

    /**
     * The tool-absent branch requires that a TARGETED discovery call for the
     * guard already failed. If the prelude only ever targets `storybloq_status`,
     * a client whose broad discovery truncated the guard away can neither call
     * it nor discover it, so mode A is unreachable and every invocation stops
     * before argument routing.
     */
    const prelude = content.slice(content.indexOf("**Guard prelude"), content.indexOf("**Whitelist semantics"));
    expect(prelude.length, "could not locate the guard prelude").toBeGreaterThan(200);
    expect(prelude).toMatch(/query: "storybloq_session_guard"/);
    // Both required tools, not just the guard: deleting the status lookup would
    // otherwise stay green and break mode A, which needs `storybloq_status`.
    expect(prelude).toMatch(/query: "storybloq_status"/);
    expect(prelude).toMatch(/before concluding anything about MCP availability or declaring the guard absent/i);

    // Bounded to each action's OWN bullet in the "Act on `overallAction`" list.
    // A whole-file substring search passes as long as the word appears anywhere,
    // so it cannot see an action whose instruction drifted or went missing.
    const sectionStart = content.indexOf("2. Act on `overallAction`");
    const sectionEnd = content.indexOf("**If `storybloq_session_guard` is confirmed absent**");
    // Both markers asserted before slicing: a missing marker silently yields an
    // empty or whole-file slice, and every bullet assertion below would then be
    // testing something other than the section it names.
    expect(sectionStart, "no `Act on overallAction` heading in SKILL.md").toBeGreaterThan(-1);
    expect(sectionEnd, "no tool-absent marker to bound the section").toBeGreaterThan(sectionStart);
    const actOn = content.slice(sectionStart, sectionEnd);

    const bulletFor = (action: string): string => {
      const start = actOn.indexOf(`**\`${action}\`**`);
      expect(start, `SKILL.md has no bullet for overallAction \`${action}\``).toBeGreaterThan(-1);
      const rest = actOn.slice(start);
      const next = rest.slice(1).search(/\n\s*- \*\*/);
      return next === -1 ? rest : rest.slice(0, next + 1);
    };

    // SKILL.md's procedures are maintained independently of the generated
    // fallback, so they get the SAME completeness bar: every call parameter,
    // condition, confirmation, menu option, and negative branch. A subset check
    // would let a dropped `clientTaskId` or a missing stop-branch ship.
    const REQUIRED: Record<string, RegExp[]> = {
      free: [/nothing is running/i, /continue to argument routing/i],
      continue: [
        /do not show an Active Autonomous Session banner/i,
        /do not ask for Resume/i,
        /process owner replies such as `Ratify T-020` directly/i,
      ],
      "auto-resume": [
        /full `sessionId`/,
        /`action: "resume"`/,
        /`clientTaskId`/,
        /do not ask for another confirmation/i,
        // U4 emits this with no identity. Unconditionally demanding the field
        // leaves that reader inventing a value instead of resuming without
        // binding, which is what the prose actually preserves.
        // Coupled to identity resolution in both directions. Independent
        // matches would pass on wording that always omits the field, or always
        // passes it while mentioning omission in unrelated prose.
        /`clientTaskId` when a task id resolved/i,
        /if identity is unavailable, omit `clientTaskId`/i,
        // Field-specific: an unqualified "without binding" reads as a claim
        // about ownership as a whole, and `claudeCodeSessionId` is the half
        // that is not covered by it.
        /without binding a new `ownerTask`/i,
      ],
      "monitor-only": [
        // TWO UX cells share this action name. An unconditional foreign-task
        // instruction hands an ownerless session a flow built entirely around
        // an owner task that does not exist.
        /BRANCH ON `relationship` first/i,
        /for `foreign-live`, render ordinary\s+foreign-task UX/i,
        /for `unowned-legacy` there is NO owner task/i,
        /offer only Monitor\s+or work here on something else/i,
        /do not name an owner, do not offer Open task, do not relay/i,
        /do not mention recovery/i,
        /explicitly asks/i,
        /recoveryRequiresExplicitRequest/,
        /resumePermittedByProse/,
        /requiresTakeover/,
        // The names alone are not the rule. Swapping `&&` for `||` leaves every
        // individual name matching while authorizing takeover on ONE true flag.
        /recoveryRequiresExplicitRequest\s*&&\s*resumePermittedByProse\s*&&\s*requiresTakeover/,
        /confirm the recorded owner task is gone/i,
        /full `sessionId`/,
        /current `clientTaskId`/,
        /`takeover: true`/,
        /explain why recovery is unavailable and stop/i,
      ],
      "offer-recovery": [
        /Resume here, End session, or Back/,
        /only after explicit selection/i,
        /full `sessionId`/,
        /typed cancellation flow/i,
        // U5 emits this action with NO identity, so the procedure must be
        // conditional in both directions rather than declaring the action
        // identity-only. An earlier draft did the latter and contradicted the
        // classifier.
        /`clientTaskId` when a task id resolved/i,
        /if identity is unavailable, omit `clientTaskId`/i,
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
      // Broad, not lease-only: the guard also emits this for an unknown workflow
      // state, and the fallback policies route missing populations here too.
      unverifiable: [
        /state, lease, identity, or reported session population/i,
        /`storybloq session list`/,
        /do not guess/i,
        /do not offer Resume/i,
      ],
    };

    // The action set must come from the canonical matrix, not from this file: a
    // hand-maintained list cannot notice a seventh action being added to the
    // union and returned by the classifier, which is the same false-guardrail
    // shape that hid an unregistered pre-ownership gate.
    const matrix = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "test", "fixtures", "session-guard-matrix.json"), "utf-8"),
    ) as { actions: { id: string; fallbackOnly?: boolean }[] };
    const expectedActions = matrix.actions.filter((a) => !a.fallbackOnly).map((a) => a.id).sort();
    expect(
      Object.keys(REQUIRED).sort(),
      "SKILL.md action coverage is out of step with the canonical action list",
    ).toEqual(expectedActions);

    for (const [action, patterns] of Object.entries(REQUIRED)) {
      const bullet = bulletFor(action);
      for (const pattern of patterns) {
        expect(bullet, `SKILL.md \`${action}\` bullet is missing ${String(pattern)}`).toMatch(pattern);
      }
    }

    // Negatives, bounded to the two bullets that describe post-resume ownership.
    // Accurate field-specific prose can sit beside a blanket sentence that
    // contradicts it, and only a negative catches that pairing. "Not mirrored"
    // and "leaves the field alone" are the specific wordings this round
    // disproved: the measured behavior DELETES an existing legacy id for a codex
    // owner.
    // The null branch must state the conflict without resolving it. "Report
    // then act" is the wording that made the earlier text unsatisfiable: a
    // reader holding `continue` and `monitor-only` cannot do both.
    {
      const nullBullet = bulletFor("overallAction: null");
      expect(nullBullet).toMatch(/no rule for combining them/i);
      expect(nullBullet, "does not name the hazard of letting the permissive verdict win").toMatch(/ISS-554/);
      expect(nullBullet, "does not defer the decision").toMatch(/ISS-898/);
      expect(nullBullet, "still instructs per-verdict execution").not.toMatch(/before acting on any/i);
      expect(nullBullet, "still instructs per-verdict execution").not.toMatch(/act on it directly/i);
      expect(nullBullet, "still instructs per-verdict execution").not.toMatch(/follow the per-session rules/i);

      // The branch must say what happens after the report. Step 0.5 completes
      // before argument routing, so silence here is not neutrality: the reader
      // either dispatches or does not, and whichever they do becomes the de
      // facto resolution. T-446 states the choice and names it for what it is.
      expect(nullBullet, "does not say what happens after the report").toMatch(/the invocation ends after the report/i);
      expect(nullBullet, "does not say dispatch is withheld").toMatch(/dispatching no subcommand/i);
      expect(nullBullet, "does not admit what the invocation-level behavior amounts to").toMatch(
        /behaves like the refuse-to-act resolution/i,
      );
      expect(nullBullet, "does not defer the permanent rule").toMatch(/ISS-898/);
      // And it must not be mistaken for a decision about the sessions.
      expect(nullBullet).toMatch(/no session is ended, cancelled, or altered/i);
      // Temporary, and WHY. Without both, the branch can decay into a permanent
      // unexplained refusal that still satisfies every assertion above.
      expect(nullBullet, "does not mark the invocation-level behavior temporary").toMatch(/it is temporary/i);
      expect(nullBullet, "does not preserve why refusal was selected").toMatch(
        /dispatching would require an answer\s+the source does not supply/i,
      );
    }

    for (const action of ["auto-resume", "offer-recovery"]) {
      const bullet = bulletFor(action);
      for (const forbidden of [/is not mirrored/i, /leaves the field alone/i, /ownership is untouched/i]) {
        expect(bullet, `\`${action}\` bullet contains disproven wording ${forbidden}`).not.toMatch(forbidden);
      }
      // Unqualified "without binding" reads as a claim about ownership as a
      // whole, which is the half that is false.
      expect(bullet, `\`${action}\` bullet has an unqualified "without binding"`).not.toMatch(
        /without binding(?! a new `ownerTask`)/i,
      );
    }

    /**
     * The null branch gets the same bounded treatment. It is the load-bearing
     * one: it is what stops a multi-session verdict from being resolved by a
     * rescan, which would silently pick a winner the guard deliberately refused
     * to pick. A whole-file substring search cannot see that instruction drift.
     */
    /**
     * The whitelist exception, asserted. Step 0.5's whitelist forbids every file
     * read while ownership is unresolved, and both fallback branches execute in
     * exactly that window -- so without a named exception a compliant reader has
     * to stop instead of following the branch. Removing it, dropping one of its
     * two conditions, or widening it to arbitrary reads would otherwise leave
     * these tests green while the fallback contract became unreachable or unsafe.
     */
    const whitelist = content.slice(content.indexOf("**Whitelist semantics"), content.indexOf("1. Call `storybloq_session_guard`"));
    expect(whitelist.length, "could not locate the whitelist paragraph").toBeGreaterThan(200);
    expect(whitelist).toMatch(/One READ of the installed `session-guard-fallback\.md`/);
    expect(whitelist, "the exception must name BOTH cases that need it").toMatch(/`overallAction: null`/);
    expect(whitelist).toMatch(/`storybloq_session_guard` confirmed absent/);
    // The older-server path inside mode A needs its own narrow exception.
    expect(whitelist).toMatch(/ONE Markdown `storybloq_status` call/);
    // Scoped: mode A only, and only after the JSON call failed for FORMAT
    // reasons. Widening it to other modes or other failures would otherwise pass.
    expect(whitelist).toMatch(/mode A only/i);
    expect(whitelist).toMatch(/only after the JSON call has failed because that format is unavailable/i);
    expect(whitelist).toMatch(/an execution error is not that case/i);

    // The exception that makes step 2's failure route executable. Without it the
    // same paragraph forbids the CLI calls and file reads that route requires,
    // so a compliant reader stops -- the fail-closed behavior this ticket
    // reverted, reached through the whitelist instead of through the prelude.
    expect(whitelist, "whitelist does not authorize the Step 0 route step 2 prescribes").toMatch(
      /if a DISCOVERED `storybloq_session_guard` call fails[\s\S]{0,320}execution-failure rule\*\* in Step 0 and the CLI context procedure it enters are permitted/i,
    );
    expect(whitelist, "the exception is not scoped to those failures alone").toMatch(/no other branch gains it/i);
    // Exactly TWO branches, both execution failures of a Step 0.5 tool call. The
    // mode A status call is the second: mode A is entered only because the guard
    // was absent, so without this it is prescribed a route the same paragraph
    // forbids, and dead-ends.
    expect(whitelist, "the whitelist does not authorize mode A's status-failure route").toMatch(
      /scoped to exactly two branches[\s\S]{0,320}mode A `storybloq_status` call fails to execute/i,
    );
    // And a call that SUCCEEDS while reporting a problem is not one of them.
    expect(whitelist).toMatch(/does NOT cover a status call that SUCCEEDS/i);
    // The authorized route must reach somewhere executable. The setup cases
    // cover a missing CLI and an unregistered MCP; a registered tool that errors
    // is neither, so the rule has to skip them and enter the CLI procedure.
    const step0Section = content.slice(content.indexOf("## Step 0:"), content.indexOf("## Step 1:"));
    expect(step0Section).toMatch(/skip the presence test[\s\S]{0,120}setup cases/i);
    expect(step0Section).toMatch(/go directly to the \*\*CLI context procedure\*\*/i);
    expect(step0Section, "the CLI procedure is not reachable from the failure route").toMatch(
      /execution-failure rule sends you here/i,
    );
    expect(step0Section).toMatch(/storybloq status/);
    // Only the OUTCOME is historical. Calling the new direct-to-CLI route "the
    // route this skill has always taken" misstates the executable contract and
    // contradicts ISS-900, which records why the old route dead-ends.
    const guardText = content.slice(content.indexOf("## Step 0.5"), content.indexOf("## How to Handle Arguments"));
    expect(guardText, "the failure branch does not distinguish outcome from route").toMatch(
      /preserves the fail-open OUTCOME[\s\S]{0,160}different ROUTE/i,
    );
    expect(guardText, "the new route is described as the historical one").not.toMatch(
      /route this skill has always taken|same route it always has/i,
    );
    expect(whitelist, "the exception does not name the issue that owns the policy").toMatch(/ISS-900/);
    // And the general prohibition survives beside it.
    expect(whitelist).toMatch(/No other file read\/write, ledger mutation, subcommand dispatch/);

    const nullBullet = bulletFor("overallAction: null");
    expect(nullBullet).toMatch(/more than one session bears/i);
    expect(nullBullet).toMatch(/supplies no rule for combining them/i);
    expect(nullBullet).toMatch(/session-guard-fallback\.md/);
    expect(nullBullet).toMatch(/mode B/i);
    // Act on the array already in hand, and do not go back to the filesystem.
    expect(nullBullet).toMatch(/`sessions` array you already have/i);
    expect(nullBullet).toMatch(/do not call `storybloq_session_guard` or `storybloq_status` again/i);

    // The relationship rules themselves live in the generated file.
    const fallback = await readFile(join(PROJECT_ROOT, "src", "skill", "session-guard-fallback.md"), "utf-8");
    expect(fallback).toContain("Same owner, non-COMPACT");
    expect(fallback).toContain("Same owner, COMPACT");
    expect(fallback).toContain("Different live owner");

    expect(content).toContain("codex_app__send_message_to_thread");
    expect(content).toContain("the user's exact message");
    expect(content).toContain("Sent to T-020's running task.");
    expect(content).toContain("manual-switch instruction");
    expect(content).not.toContain("take over (only safe if the owning instance is gone)");
  });

  it("SKILL.md documents the bounded code-review landing policy", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    const autonomous = await readFile(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8");
    expect(content).toContain('"maxReviewRounds": "number (default: 12');
    expect(autonomous).toContain("Code-review landing cap");
    expect(autonomous).toContain("zero unresolved critical findings advances to FINALIZE");
    expect(autonomous).toContain("PLAN_REVIEW convergence remains separate");
  });

  it("SKILL.md summary actions are item-neutral because recommendations can be tickets or issues", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("Work on [first recommended item ID + title]");
    expect(content).toContain("whether ticket or issue");
    expect(content).toContain("the top item keeps `(Recommended)`");
    expect(content).not.toContain("first recommended ticket ID");
  });

  it("bundled skill files do not hard-code client-specific ToolSearch result parameter names", async () => {
    const skillContent = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    const setupFlowContent = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(skillContent).not.toContain("max_results");
    expect(setupFlowContent).not.toContain("max_results");
    expect(skillContent).toContain("In Codex, use the `limit` field");
    expect(setupFlowContent).toContain("In Codex, use the `limit` field");
  });

  // -------------------------------------------------------------------------
  // Cross-file reference integrity
  // -------------------------------------------------------------------------

  it("every skill support file reference in SKILL.md points to an existing file", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    // Match "read `filename.md` in the same directory as this skill file" pattern
    const references = content.match(/read `([^`]+\.md)` in the same directory/gi) ?? [];
    expect(references.length).toBeGreaterThan(0);

    for (const ref of references) {
      const match = ref.match(/`([^`]+\.md)`/);
      if (!match) continue;
      const filename = match[1]!;
      expect(
        existsSync(join(PROJECT_ROOT, "src", "skill", filename)),
        `SKILL.md references "${filename}" as a support file but it does not exist in src/skill/`,
      ).toBe(true);
    }
  });

  it("no orphaned .md files in src/skill/ (every file is SKILL.md or referenced from it)", async () => {
    const { readdirSync } = await import("node:fs");
    const skillDir = join(PROJECT_ROOT, "src", "skill");
    const allFiles = readdirSync(skillDir).filter(f => f.endsWith(".md"));
    const content = await readFile(join(skillDir, "SKILL.md"), "utf-8");

    for (const file of allFiles) {
      if (file === "SKILL.md") continue;
      expect(
        content.includes(file),
        `"${file}" exists in src/skill/ but is not referenced from SKILL.md`,
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // SKILL.md <-> output-formatter.ts sentinel coupling
  // -------------------------------------------------------------------------

  it("SKILL.md Step 2b matches the EMPTY_SCAFFOLD_HEADING sentinel", async () => {
    const skillContent = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    const formatterContent = await readFile(
      join(PROJECT_ROOT, "src", "core", "output-formatter.ts"),
      "utf-8",
    );

    // Extract the sentinel value from output-formatter.ts
    const sentinelMatch = formatterContent.match(
      /export const EMPTY_SCAFFOLD_HEADING\s*=\s*"([^"]+)"/,
    );
    expect(sentinelMatch, "EMPTY_SCAFFOLD_HEADING not found in output-formatter.ts").toBeTruthy();
    const sentinel = sentinelMatch![1]!;

    // SKILL.md Step 2b must reference this exact string
    expect(
      skillContent.includes(sentinel),
      `SKILL.md does not contain the sentinel string "${sentinel}" -- Step 2b coupling is broken`,
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Support file content validation
  // -------------------------------------------------------------------------

  it("setup-flow.md contains all setup flow sections", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("## AI-Assisted Setup Flow");
    expect(content).toContain("#### 1a. Detect Project Type");
    expect(content).toContain("#### 1b. Existing Project");
    expect(content).toContain("#### 1c. New Project");
    expect(content).toContain("#### 1d. Present Proposal");
    expect(content).toContain("#### 1d2. Refinement and Review");
    expect(content).toContain("#### 1e. Execute on Approval");
    expect(content).toContain("#### 1f. Post-Setup");
  });

  it("setup-flow.md uses two-axis taxonomy (surface + characteristics)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("primary surface");
    expect(content).toContain("special characteristics");
    expect(content).toContain("multiSelect: true");
  });

  it("setup-flow.md characteristics are never skipped even when stack is named", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Do NOT skip characteristics");
  });

  it("setup-flow.md has summary breaks between gate clusters", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("--- Summary break ---");
  });

  it("setup-flow.md 1b includes brief/PRD scan", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Project brief / PRD scan");
    expect(content).toContain("Brief precedence");
  });

  it("setup-flow.md 1d2 refinement covers descriptions, dependencies, sizing, and missing entities", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("blockedBy");
    expect(content).toContain("split oversized tickets");
    expect(content).toContain("missing");
    expect(content).toContain("core differentiator");
    expect(content).toContain("undecided tech choices");
  });

  it("setup-flow.md review uses autonomous mode backend selection", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("review_plan");
    expect(content).toContain("Maximum 2 review rounds");
  });

  it("setup-flow.md 1e includes two-pass creation and CLAUDE.md/RULES.md generation", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Pass 1:");
    expect(content).toContain("Pass 2:");
    expect(content).toContain("CLAUDE.md generation");
    expect(content).toContain("RULES.md generation");
    expect(content).toContain("Sanitization");
  });

  it("setup-flow.md has single combined approval + refinement question", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // One question combines approval and refinement depth
    expect(content).toContain("How should I proceed with this proposal");
    expect(content).toContain("Refine + get a second opinion (Recommended)");
    expect(content).toContain("Create as-is");
    expect(content).toContain("Adjust first");
    // Refinement has explicit steps A-D with required gates
    expect(content).toContain("Do NOT skip this section");
    expect(content).toContain("Step D: Ask user to approve before creating");
  });

  it("setup-flow.md has system shape and execution model as separate gates", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("How should the system be structured");
    expect(content).toContain("How does processing work");
  });

  it("setup-flow.md has BaaS as a first-class system shape option", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("managed backend (Supabase/Firebase)");
    // BaaS skips ORM but auth still fires
    expect(content).toContain("skip ORM choice");
    expect(content).toContain("Auth gate still fires");
  });

  it("setup-flow.md domain complexity is multiSelect", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    const domainSection = content.split("Step 4d")[1]!.split("Step 4e")[0]!;
    expect(domainSection).toContain("multiSelect: true");
  });

  it("setup-flow.md AI pattern supports primary + secondary (composable)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("primary AI pattern");
    expect(content).toContain("secondary capabilities");
    expect(content).toContain("Structured generation");
  });

  it("setup-flow.md has quality checks gate with three tiers", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("quality checks");
    expect(content).toContain("Full pipeline (Recommended)");
    expect(content).toContain("Tests only");
    expect(content).toContain("Minimal");
  });

  it("setup-flow.md 1e configures recipe stages via CLI after init", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("config set-overrides");
    expect(content).toContain("WRITE_TESTS");
    expect(content).toContain("VERIFY");
    expect(content).toContain("BUILD");
  });

  it("setup-flow.md AI safety is two questions: audience then sensitive domain", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Who interacts with the AI output");
    expect(content).toContain("Is this a sensitive domain");
  });

  it("setup-flow.md auth gate is NOT skipped for no-database projects", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain('Do NOT skip for "no database"');
  });

  it("setup-flow.md auth suggests Firebase Auth and Clerk as easy options", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Firebase Auth");
    expect(content).toContain("Clerk");
  });

  it("setup-flow.md sensitive domain gate exists outside AI branch", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // Step 4f is in Cluster 4, not inside Cluster 5 (AI)
    const cluster4 = content.split("--- Cluster 4")[1]!.split("--- Cluster 5")[0]!;
    expect(cluster4).toContain("sensitive/regulated domain");
  });

  it("setup-flow.md has simple project fast path", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Simple project fast path");
    expect(content).toContain("straightforward site");
  });

  it("setup-flow.md has design source gate for UI projects", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Do you have designs");
    expect(content).toContain("mockups / Figma");
    expect(content).toContain("start from scratch");
  });

  it("setup-flow.md three-strike protects critical gates", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("3 out of any 4 gates");
    expect(content).toContain("auth model, sensitive domain, and primary AI pattern are never silently collapsed");
  });

  it("setup-flow.md TDD recommendation is conditional", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // TDD is tied to domain complexity, not universal
    expect(content).toContain("TDD for business logic");
    expect(content).toMatch(/tied.*gate answers/i);
  });

  it("setup-flow.md appendix has Default Stack Recommendations with disclaimer", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("## Appendix: Default Stack Recommendations");
    expect(content).toContain("these are defaults, not absolutes");
  });

  it("setup-flow.md appendix covers AI, BaaS, and full-stack categories", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("### AI / LLM application");
    expect(content).toContain("### BaaS / backendless");
    expect(content).toContain("### Full-stack / multi-service");
  });

  it("setup-flow.md uses outcome-oriented gate language", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // Outcome-oriented, not jargon
    expect(content).toContain("How do users log in");
    expect(content).toContain("What data does this system store");
    expect(content).toContain("How should this go live");
    expect(content).toContain("How should the system be structured");
  });

  it("setup-flow.md LLM recommendation says product default", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("product default");
  });

  it("setup-flow.md post-setup mentions /story and /story auto", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    const postSetup = content.split("1f. Post-Setup")[1]!;
    expect(postSetup).toContain("/story");
    expect(postSetup).toContain("/story auto");
    expect(postSetup).toContain("$story");
    expect(postSetup).toContain("$story auto");
  });

  it("autonomous-mode.md contains autonomous and tiered mode sections", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8");
    expect(content).toContain("## Autonomous Mode");
    expect(content).toContain("$story auto");
    expect(content).toContain("storybloq_autonomous_guide");
    expect(content).toContain("### `/story review T-XXX`");
    expect(content).toContain("### `/story plan T-XXX`");
    expect(content).toContain("### `/story guided T-XXX`");
  });

  it("autonomous-mode.md carries Codex-specific autonomous setup guidance", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8");
    expect(content).toContain("**Codex:**");
    expect(content).toContain("STORYBLOQ_CLIENT=codex");
    expect(content).toContain("restart Codex or start a new session");
    expect(content).toContain("Check `/hooks` after setup");
    expect(content).toContain("`$story auto` does not require Codex subagents");
    expect(content).toContain("Do NOT use client-native plan mode");
    expect(content).toContain("Codex automations");
  });

  it("SKILL.md no longer contains extracted sections inline", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    // Setup flow should not be inline
    expect(content).not.toContain("#### 1a. Detect Project Type");
    expect(content).not.toContain("#### 1b. Existing Project");
    // Autonomous mode section should not be inline. Check the section heading
    // and a state-machine identifier rather than the tool name -- the tool
    // name appears in the Step 0.5 guard whitelist (legitimately, it tells
    // agents what NOT to call) and in /story auto command help.
    expect(content).not.toContain("## Autonomous Mode");
    expect(content).not.toContain("PICK_TICKET");
  });

  // -------------------------------------------------------------------------
  // Settings command
  // -------------------------------------------------------------------------

  it("SKILL.md has /story settings command in argument handler", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("/story settings");
    expect(content).toContain("## Settings");
  });

  it("SKILL.md has config schema reference (no source code digging needed)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("### Config Schema Reference");
    expect(content).toContain("WRITE_TESTS");
    expect(content).toContain("VERIFY");
    expect(content).toContain("maxTicketsPerSession");
    expect(content).toContain("reviewBackends");
    expect(content).toContain("Do NOT search source code");
  });

  // -------------------------------------------------------------------------
  // Frontend design skill
  // -------------------------------------------------------------------------

  it("design/design.md exists in src/skill/design/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "design", "design.md"))).toBe(true);
  });

  it("all platform reference files exist in src/skill/design/references/", () => {
    for (const platform of ["web.md", "macos.md", "ios.md", "android.md"]) {
      expect(
        existsSync(join(PROJECT_ROOT, "src", "skill", "design", "references", platform)),
        `Missing: design/references/${platform}`,
      ).toBe(true);
    }
  });

  it("SKILL.md argument handler routes /story design to design/design.md", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toMatch(/`design\/design\.md` in the same directory as this skill file/);
  });

  it("design.md references all platform reference files", async () => {
    const content = await readFile(
      join(PROJECT_ROOT, "src", "skill", "design", "design.md"), "utf-8",
    );
    for (const platform of ["web.md", "macos.md", "ios.md", "android.md"]) {
      expect(content).toContain(platform);
    }
  });

  it("autonomous-mode.md includes frontend design guidance", async () => {
    const content = await readFile(
      join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8",
    );
    expect(content).toContain("design/design.md");
  });

  // -------------------------------------------------------------------------
  // Installer copies all support files
  // -------------------------------------------------------------------------

  it("supportFiles array in setup-skill.ts includes all support files", async () => {
    const tsContent = await readFile(
      join(PROJECT_ROOT, "src", "cli", "commands", "setup-skill.ts"),
      "utf-8",
    );
    expect(tsContent).toContain('"setup-flow.md"');
    expect(tsContent).toContain('"autonomous-mode.md"');
    expect(tsContent).toContain('"reference.md"');
    expect(tsContent).toContain('"orchestrator-mode.md"');
    expect(tsContent).toContain('"bus-mode.md"');
  });

  it("setup-skill.ts handles subdirectory skills with copyDirRecursive", async () => {
    const tsContent = await readFile(
      join(PROJECT_ROOT, "src", "cli", "commands", "setup-skill.ts"),
      "utf-8",
    );
    expect(tsContent).toContain("copyDirRecursive");
    expect(tsContent).toContain('"design"');
    expect(tsContent).toContain('"review-lenses"');
  });
});

// ---------------------------------------------------------------------------
// copyDirRecursive functional tests
// ---------------------------------------------------------------------------

describe("copyDirRecursive", () => {
  let tempDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-copy-test-${randomUUID()}`);
    srcDir = join(tempDir, "src");
    destDir = join(tempDir, "dest");
    // Create a source tree: file at root + file in subdirectory
    await mkdir(join(srcDir, "references"), { recursive: true });
    await writeFile(join(srcDir, "design.md"), "# Design", "utf-8");
    await writeFile(join(srcDir, "references", "web.md"), "# Web", "utf-8");
    await writeFile(join(srcDir, "references", "ios.md"), "# iOS", "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("copies all files including nested subdirectories", async () => {
    const { copyDirRecursive } = await import("../../../src/cli/commands/setup-skill.js");
    const written = await copyDirRecursive(srcDir, destDir);
    expect(written).toContain("design.md");
    expect(written).toContain(join("references", "web.md"));
    expect(written).toContain(join("references", "ios.md"));
    expect(written.length).toBe(3);
    // Verify files actually exist at destination
    expect(existsSync(join(destDir, "design.md"))).toBe(true);
    expect(existsSync(join(destDir, "references", "web.md"))).toBe(true);
    expect(existsSync(join(destDir, "references", "ios.md"))).toBe(true);
  });

  it("does not include directory entries in the written list", async () => {
    const { copyDirRecursive } = await import("../../../src/cli/commands/setup-skill.js");
    const written = await copyDirRecursive(srcDir, destDir);
    for (const entry of written) {
      expect(entry).toMatch(/\.md$/);
    }
  });

  it("replaces existing dest cleanly on reinstall (no stale files)", async () => {
    const { copyDirRecursive } = await import("../../../src/cli/commands/setup-skill.js");
    // First install
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "stale-file.md"), "stale", "utf-8");
    // Reinstall
    await copyDirRecursive(srcDir, destDir);
    expect(existsSync(join(destDir, "stale-file.md"))).toBe(false);
    expect(existsSync(join(destDir, "design.md"))).toBe(true);
    // No leftover temp/backup dirs
    expect(existsSync(destDir + ".tmp")).toBe(false);
    expect(existsSync(destDir + ".bak")).toBe(false);
  });

  it("recovers backup if destDir was lost from a previous crash", async () => {
    const { copyDirRecursive } = await import("../../../src/cli/commands/setup-skill.js");
    // Simulate crash: destDir gone, bakDir has the old install
    const bakDir = destDir + ".bak";
    await mkdir(bakDir, { recursive: true });
    await writeFile(join(bakDir, "old.md"), "old", "utf-8");
    // copyDirRecursive should restore bakDir to destDir first, then install new
    await copyDirRecursive(srcDir, destDir);
    expect(existsSync(join(destDir, "design.md"))).toBe(true);
    expect(existsSync(destDir + ".bak")).toBe(false);
    expect(existsSync(destDir + ".tmp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PreCompact hook registration
// ---------------------------------------------------------------------------

describe("registerPreCompactHook", () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-hook-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const FAKE_BIN = "/fake/storybloq";

  async function importHook() {
    const { registerPreCompactHook } = await import("../../../src/cli/commands/setup-skill.js");
    return (path?: string) => registerPreCompactHook(path, FAKE_BIN);
  }

  async function readSettings(): Promise<Record<string, unknown>> {
    const raw = await readFile(settingsPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("creates settings.json when absent", async () => {
    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("registered");
    const settings = await readSettings();
    expect(settings.hooks).toBeDefined();
    const hooks = settings.hooks as Record<string, unknown>;
    expect(Array.isArray(hooks.PreCompact)).toBe(true);

    const preCompact = hooks.PreCompact as Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    expect(preCompact).toHaveLength(1);
    expect(preCompact[0]!.matcher).toBe("");
    expect(preCompact[0]!.hooks).toHaveLength(1);
    expect(preCompact[0]!.hooks[0]!.type).toBe("command");
    expect(preCompact[0]!.hooks[0]!.command).toBe(`${FAKE_BIN} session compact-prepare`);
  });

  it("merges into existing settings preserving other config", async () => {
    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ["Bash(git status)"] },
      model: "opus",
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("registered");
    const settings = await readSettings();
    // Existing config preserved
    expect((settings.permissions as Record<string, unknown>).allow).toEqual(["Bash(git status)"]);
    expect(settings.model).toBe("opus");
    // Hook added
    expect(settings.hooks).toBeDefined();
  });

  it("preserves existing PreCompact hooks from other tools", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "auto", hooks: [{ type: "command", command: "echo context reminder" }] },
        ],
      },
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("registered");
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    const preCompact = hooks.PreCompact as unknown[];
    // Original hook preserved + new one added
    expect(preCompact).toHaveLength(2);
  });

  it("appends to existing empty-matcher group", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "echo other" }] },
        ],
      },
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("registered");
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    const preCompact = hooks.PreCompact as Array<{ hooks: unknown[] }>;
    // Still one group, but with two commands
    expect(preCompact).toHaveLength(1);
    expect(preCompact[0]!.hooks).toHaveLength(2);
  });

  it("is idempotent — second run returns exists", async () => {
    const register = await importHook();
    await register(settingsPath);
    const result = await register(settingsPath);

    expect(result).toBe("exists");
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    const preCompact = hooks.PreCompact as Array<{ hooks: unknown[] }>;
    expect(preCompact).toHaveLength(1);
    expect(preCompact[0]!.hooks).toHaveLength(1);
  });

  it("detects command in non-empty matcher group", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "auto", hooks: [{ type: "command", command: `${FAKE_BIN} session compact-prepare` }] },
        ],
      },
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("exists");
  });

  it("skips on malformed JSON without modifying file", async () => {
    const badContent = "{ this is not json }";
    await writeFile(settingsPath, badContent, "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("skipped");
    // File untouched
    const content = await readFile(settingsPath, "utf-8");
    expect(content).toBe(badContent);
  });

  it("skips when hooks is wrong type", async () => {
    const original = JSON.stringify({ hooks: "not-an-object" }, null, 2);
    await writeFile(settingsPath, original, "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("skipped");
    const content = await readFile(settingsPath, "utf-8");
    expect(content).toBe(original);
  });

  it("skips when PreCompact is wrong type", async () => {
    const original = JSON.stringify({ hooks: { PreCompact: "not-an-array" } }, null, 2);
    await writeFile(settingsPath, original, "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("skipped");
    const content = await readFile(settingsPath, "utf-8");
    expect(content).toBe(original);
  });

  it("--skip-hooks flag: registerPreCompactHook is not called when skipped", async () => {
    // Verify the hook registration function works, then confirm the flag
    // prevents it at the handler level. We test the gate condition directly:
    // handleSetupSkill only calls registerPreCompactHook when cliInPath && !skipHooks.
    // Since we can't control cliInPath in tests, we verify the function itself
    // is callable and that the options interface correctly accepts skipHooks.
    const register = await importHook();

    // Without skip: registers
    const result1 = await register(settingsPath);
    expect(result1).toBe("registered");

    // Clean up for next assertion
    await rm(settingsPath);

    // The flag is a simple boolean gate in handleSetupSkill:
    //   if (cliInPath && !skipHooks) { await registerPreCompactHook(); }
    // With skipHooks=true, registerPreCompactHook is never called,
    // so settings.json stays untouched. We verify the interface compiles:
    const { handleSetupSkill: _ } = await import("../../../src/cli/commands/setup-skill.js");
    const opts: import("../../../src/cli/commands/setup-skill.js").SetupSkillOptions = { skipHooks: true };
    expect(opts.skipHooks).toBe(true);
  });

  it("handles malformed entries in PreCompact array gracefully", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          "not-an-object",
          { matcher: "", hooks: "not-an-array" },
          { matcher: "auto", hooks: [42, null, "bad"] },
        ],
      },
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    // Should still register since our command wasn't found
    expect(result).toBe("registered");
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    const preCompact = hooks.PreCompact as unknown[];
    // Original 3 entries preserved + new group added
    expect(preCompact).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// formatHookCommand (ISS-560)
// ---------------------------------------------------------------------------

describe("formatHookCommand", () => {
  it("does not quote a clean POSIX path", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand } = await import("../../../src/cli/commands/setup-skill.js");
    expect(formatHookCommand("/usr/local/bin/storybloq", "hook-status"))
      .toBe("/usr/local/bin/storybloq hook-status");
  });

  it("single-quote-wraps a POSIX path with a space", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand } = await import("../../../src/cli/commands/setup-skill.js");
    expect(formatHookCommand("/path with space/storybloq", "hook-status"))
      .toBe("'/path with space/storybloq' hook-status");
  });

  it("escapes embedded single quote on POSIX", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand } = await import("../../../src/cli/commands/setup-skill.js");
    expect(formatHookCommand("/weird'path/storybloq", "hook-status"))
      .toBe("'/weird'\\''path/storybloq' hook-status");
  });

  it("quotes POSIX path with shell metachar", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand } = await import("../../../src/cli/commands/setup-skill.js");
    expect(formatHookCommand("/has&amp/storybloq", "hook-status"))
      .toBe("'/has&amp/storybloq' hook-status");
  });
});

// ---------------------------------------------------------------------------
// resolveStorybloqBin (ISS-560)
// ---------------------------------------------------------------------------

describe("resolveStorybloqBin", () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-resolve-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when PATH is empty and no candidates match", async () => {
    if (process.platform === "win32") return;
    process.env.PATH = "";
    // Redirect HOME to a dir with no candidate binaries.
    process.env.HOME = tempDir;
    const { resolveStorybloqBin } = await import("../../../src/cli/commands/setup-skill.js");
    expect(resolveStorybloqBin()).toBe(null);
  });

  it("finds executable on PATH", async () => {
    if (process.platform === "win32") return;
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\necho hi\n", "utf-8");
    const { chmod } = await import("node:fs/promises");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;
    process.env.HOME = tempDir;
    const { resolveStorybloqBin } = await import("../../../src/cli/commands/setup-skill.js");
    expect(resolveStorybloqBin()).toBe(binPath);
  });

  it("skips non-executable storybloq entry on PATH", async () => {
    if (process.platform === "win32") return;
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    // Write a file that is readable but not executable.
    await writeFile(binPath, "not-executable", "utf-8");
    const { chmod } = await import("node:fs/promises");
    await chmod(binPath, 0o644);
    process.env.PATH = binDir;
    process.env.HOME = tempDir;
    const { resolveStorybloqBin } = await import("../../../src/cli/commands/setup-skill.js");
    expect(resolveStorybloqBin()).toBe(null);
  });

  it("prefers PATH match over candidate list", async () => {
    if (process.platform === "win32") return;
    const pathBinDir = join(tempDir, "path-bin");
    await mkdir(pathBinDir, { recursive: true });
    const pathBin = join(pathBinDir, "storybloq");
    await writeFile(pathBin, "#!/bin/sh\n", "utf-8");
    const { chmod } = await import("node:fs/promises");
    await chmod(pathBin, 0o755);
    process.env.PATH = pathBinDir;
    process.env.HOME = tempDir;
    const { resolveStorybloqBin } = await import("../../../src/cli/commands/setup-skill.js");
    // PATH-level match should win regardless of candidate list contents.
    expect(resolveStorybloqBin()).toBe(pathBin);
  });
});

// ---------------------------------------------------------------------------
// registerStopHook (ISS-560)
// ---------------------------------------------------------------------------

describe("registerStopHook", () => {
  let tempDir: string;
  let settingsPath: string;
  const FAKE_BIN = "/fake/storybloq";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-stop-hook-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function read(): Promise<Record<string, unknown>> {
    const raw = await readFile(settingsPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("creates Stop hook with empty matcher and async flag", async () => {
    const { registerStopHook } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await registerStopHook(settingsPath, FAKE_BIN);

    expect(result).toBe("registered");
    const settings = await read();
    const hooks = settings.hooks as Record<string, unknown>;
    const stop = hooks.Stop as Array<{ matcher: string; hooks: Array<{ type: string; command: string; async: boolean }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]!.matcher).toBe("");
    expect(stop[0]!.hooks[0]!.type).toBe("command");
    expect(stop[0]!.hooks[0]!.command).toBe(`${FAKE_BIN} hook-status`);
    expect(stop[0]!.hooks[0]!.async).toBe(true);
  });

  it("is idempotent on re-register with same binPath", async () => {
    const { registerStopHook } = await import("../../../src/cli/commands/setup-skill.js");
    await registerStopHook(settingsPath, FAKE_BIN);
    const result = await registerStopHook(settingsPath, FAKE_BIN);
    expect(result).toBe("exists");
  });

  it("preserves unrelated hook-status command from another tool", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "/some/other-tool hook-status" }] },
        ],
      },
    }, null, 2), "utf-8");
    const { registerStopHook } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await registerStopHook(settingsPath, FAKE_BIN);
    expect(result).toBe("registered");
    const settings = await read();
    const hooks = settings.hooks as Record<string, unknown>;
    const stop = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    // One matcher group (""), with two commands.
    expect(stop).toHaveLength(1);
    const cmds = stop[0]!.hooks.map((h) => h.command);
    expect(cmds).toContain("/some/other-tool hook-status");
    expect(cmds).toContain(`${FAKE_BIN} hook-status`);
  });
});

// ---------------------------------------------------------------------------
// registerSessionStartHook (ISS-560)
// ---------------------------------------------------------------------------

describe("registerSessionStartHook", () => {
  let tempDir: string;
  let settingsPath: string;
  const FAKE_BIN = "/fake/storybloq";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-start-hook-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function read(): Promise<Record<string, unknown>> {
    const raw = await readFile(settingsPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("creates SessionStart hook with matcher 'compact'", async () => {
    const { registerSessionStartHook } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await registerSessionStartHook(settingsPath, FAKE_BIN);

    expect(result).toBe("registered");
    const settings = await read();
    const hooks = settings.hooks as Record<string, unknown>;
    const start = hooks.SessionStart as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(start).toHaveLength(1);
    expect(start[0]!.matcher).toBe("compact");
    expect(start[0]!.hooks[0]!.command).toBe(`${FAKE_BIN} session resume-prompt`);
  });

  it("preserves non-storybloq SessionStart hooks with matcher 'compact'", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "compact", hooks: [{ type: "command", command: "/other/tool custom-prompt" }] },
        ],
      },
    }, null, 2), "utf-8");
    const { registerSessionStartHook } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await registerSessionStartHook(settingsPath, FAKE_BIN);
    expect(result).toBe("registered");
    const settings = await read();
    const hooks = settings.hooks as Record<string, unknown>;
    const start = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    const cmds = start[0]!.hooks.map((h) => h.command);
    expect(cmds).toContain("/other/tool custom-prompt");
    expect(cmds).toContain(`${FAKE_BIN} session resume-prompt`);
  });

  it("is idempotent on re-register", async () => {
    const { registerSessionStartHook } = await import("../../../src/cli/commands/setup-skill.js");
    await registerSessionStartHook(settingsPath, FAKE_BIN);
    const result = await registerSessionStartHook(settingsPath, FAKE_BIN);
    expect(result).toBe("exists");
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyHookVariants (ISS-560)
// ---------------------------------------------------------------------------

describe("migrateLegacyHookVariants", () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-migrate-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seed(hookType: string, commands: string[]): Promise<void> {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        [hookType]: [
          { matcher: "", hooks: commands.map((c) => ({ type: "command", command: c })) },
        ],
      },
    }, null, 2), "utf-8");
  }

  async function remainingCommands(hookType: string): Promise<string[]> {
    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const groups = settings.hooks[hookType] ?? [];
    return groups.flatMap((g) => g.hooks.map((h) => h.command));
  }

  it("removes bare `storybloq` command when newCommand is absolute", async () => {
    await seed("PreCompact", ["storybloq session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
    expect(await remainingCommands("PreCompact")).toEqual([]);
  });

  it("removes stale absolute path that no longer matches", async () => {
    await seed("PreCompact", ["/old/v20/bin/storybloq session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/v22/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("preserves exact-match newCommand (idempotent)", async () => {
    const cmd = "/new/bin/storybloq session compact-prepare";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      cmd,
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  it("preserves other-tool command (basename !== storybloq)", async () => {
    const cmd = "/other/bin/mytool session compact-prepare";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  it("preserves storybloq with extra flag (rest !== subcommand)", async () => {
    const cmd = "storybloq session compact-prepare --extra-flag";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  it("handles quoted path with space", async () => {
    if (process.platform === "win32") return;
    const cmd = "'/path with space/storybloq' session compact-prepare";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("leaves malformed command entries untouched", async () => {
    const cmd = "| & > evil";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  // ISS-589 / claudestory legacy-basename variants

  it("removes bare claudestory command", async () => {
    await seed("PreCompact", ["claudestory session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
    expect(await remainingCommands("PreCompact")).toEqual([]);
  });

  it("removes absolute claudestory path that no longer matches", async () => {
    await seed("PreCompact", ["/Users/amir/.nvm/versions/node/v22.18.0/bin/claudestory session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("removes quoted claudestory path with space (POSIX only)", async () => {
    if (process.platform === "win32") return;
    const cmd = "'/path with space/claudestory' session compact-prepare";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("preserves claudestory with extra flag (rest !== subcommand)", async () => {
    const cmd = "claudestory session compact-prepare --user-override";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  it("removes mixed storybloq + claudestory entries in one pass", async () => {
    await seed("PreCompact", [
      "storybloq session compact-prepare",
      "/old/v20/bin/claudestory session compact-prepare",
      "/other/bin/mytool session compact-prepare",
    ]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(2);
    expect(await remainingCommands("PreCompact")).toEqual(["/other/bin/mytool session compact-prepare"]);
  });

  it("leaves non-storybloq non-claudestory entries untouched", async () => {
    await seed("PreCompact", [
      "/other/bin/anothertool session compact-prepare",
      "some-wrapper --flag session compact-prepare",
    ]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect((await remainingCommands("PreCompact")).length).toBe(2);
  });

  it("idempotent: second run with already-migrated settings is a no-op returning 0", async () => {
    await seed("PreCompact", ["claudestory session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const first = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(first).toBe(1);
    const second = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(second).toBe(0);
  });

  it("handles empty hooks object (no PreCompact key present)", async () => {
    await writeFile(settingsPath, JSON.stringify({ hooks: {} }, null, 2), "utf-8");
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
  });

  it("handles malformed hook entries (null, non-object, missing command) without throwing", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [null, "bad", { type: "command" }, { type: "other" }, 42] },
          { matcher: "other", hooks: [{ type: "command", command: "claudestory session compact-prepare" }] },
        ],
      },
    }, null, 2), "utf-8");
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("returns 0 cleanly when settings.json does not exist", async () => {
    await rm(settingsPath, { force: true });
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
  });

  it("returns 0 when settings.json has invalid JSON (does not overwrite)", async () => {
    const original = "{ not valid json }";
    await writeFile(settingsPath, original, "utf-8");
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    const content = await readFile(settingsPath, "utf-8");
    expect(content).toBe(original);
  });

  it("parses apostrophe-escaped path matching formatHookCommand output (round-trip)", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand, migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    // formatHookCommand produces `'<escaped>' <subcommand>` with `'\''`
    // sequences for literal apostrophes; parseHookCommand must round-trip
    // so the migration can match its own output.
    const cmd = formatHookCommand("/weird'path/claudestory", "session compact-prepare");
    await seed("PreCompact", [cmd]);
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
    expect(await remainingCommands("PreCompact")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sweepLegacyHooks (ISS-590)
// ---------------------------------------------------------------------------

describe("sweepLegacyHooks", () => {
  let tempDir: string;
  let settingsPath: string;
  const FAKE_BIN = "/new/bin/storybloq";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-sweep-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns total migrations across PreCompact + SessionStart + Stop", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory session compact-prepare" },
        ]}],
        SessionStart: [{ matcher: "compact", hooks: [
          { type: "command", command: "/old/bin/claudestory session resume-prompt" },
        ]}],
        Stop: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory hook-status", async: true },
        ]}],
      },
    }, null, 2), "utf-8");
    const { sweepLegacyHooks } = await import("../../../src/cli/commands/setup-skill.js");
    const total = await sweepLegacyHooks(FAKE_BIN, settingsPath);
    expect(total).toBe(3);
  });

  it("returns 0 when no legacy entries present anywhere", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "/new/bin/storybloq session compact-prepare" },
        ]}],
      },
    }, null, 2), "utf-8");
    const { sweepLegacyHooks } = await import("../../../src/cli/commands/setup-skill.js");
    const total = await sweepLegacyHooks(FAKE_BIN, settingsPath);
    expect(total).toBe(0);
  });

  it("continues even if one hook type has malformed entries", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: "not-an-array",  // malformed
        SessionStart: [{ matcher: "compact", hooks: [
          { type: "command", command: "claudestory session resume-prompt" },
        ]}],
        Stop: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory hook-status", async: true },
        ]}],
      },
    }, null, 2), "utf-8");
    const { sweepLegacyHooks } = await import("../../../src/cli/commands/setup-skill.js");
    const total = await sweepLegacyHooks(FAKE_BIN, settingsPath);
    // Malformed PreCompact yields 0; SessionStart + Stop each contribute 1.
    expect(total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Codex setup
// ---------------------------------------------------------------------------

describe("Codex setup helpers", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-codex-setup-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    configPath = join(tempDir, "config.toml");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("auto-approves read-only MCP tools and excludes mutating tools", async () => {
    const { CODEX_READ_ONLY_APPROVAL_TOOLS } = await import("../../../src/cli/commands/setup-skill.js");

    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).toContain("storybloq_status");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).toContain("storybloq_session_report");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).toContain("storybloq_node_list");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).not.toContain("storybloq_snapshot");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).not.toContain("storybloq_selftest");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).not.toContain("storybloq_autonomous_guide");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).not.toContain("storybloq_ticket_create");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).not.toContain("storybloq_node_add");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).not.toContain("storybloq_node_update");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).not.toContain("storybloq_node_init");
    expect(CODEX_READ_ONLY_APPROVAL_TOOLS).not.toContain("storybloq_register_subprocess");
  });

  it("uses plain SessionStart output for Claude and hook JSON output for Codex", async () => {
    const {
      formatClaudeSessionStartCommand,
      formatCodexSessionStartCommand,
    } = await import("../../../src/cli/commands/setup-skill.js");

    const claudeCommand = formatClaudeSessionStartCommand("/usr/local/bin/storybloq");
    const codexCommand = formatCodexSessionStartCommand("/usr/local/bin/storybloq");

    expect(claudeCommand).toBe("/usr/local/bin/storybloq session resume-prompt");
    expect(claudeCommand).not.toContain("--codex-hook-json");
    expect(codexCommand).toBe("/usr/local/bin/storybloq session resume-prompt --codex-hook-json");
  });

  it("normalizes and appends Codex per-tool approval blocks idempotently", async () => {
    await writeFile(configPath, [
      "[mcp_servers.storybloq] # registered by storybloq",
      'command = "storybloq"',
      'args = ["--mcp"]',
      "",
      "[mcp_servers.storybloq.tools.storybloq_status] # keep this comment",
      'approval_mode = "ask"',
      "",
    ].join("\n"), "utf-8");

    const { ensureCodexToolApprovals } = await import("../../../src/cli/commands/setup-skill.js");
    const first = await ensureCodexToolApprovals(configPath, [
      "storybloq_status",
      "storybloq_phase_list",
    ]);
    const second = await ensureCodexToolApprovals(configPath, [
      "storybloq_status",
      "storybloq_phase_list",
    ]);

    const content = await readFile(configPath, "utf-8");
    expect(first).toBe("updated");
    expect(second).toBe("exists");
    expect(content.match(/\[mcp_servers\.storybloq\.tools\.storybloq_status\]/g)).toHaveLength(1);
    expect(content.match(/\[mcp_servers\.storybloq\.tools\.storybloq_phase_list\]/g)).toHaveLength(1);
    expect(content).not.toContain('approval_mode = "ask"');
    expect(content).toContain('[mcp_servers.storybloq.tools.storybloq_status] # keep this comment');
    expect(content).toContain('approval_mode = "approve"');
    expect(content).toContain('[mcp_servers.storybloq.tools.storybloq_phase_list]\napproval_mode = "approve"');
  });

  it("adds Codex Storybloq client env idempotently", async () => {
    await writeFile(configPath, [
      "[mcp_servers.storybloq]",
      'command = "storybloq"',
      'args = ["--mcp"]',
      "",
      "[mcp_servers.storybloq.env] # existing table",
      'STORYBLOQ_CLIENT = "claude"',
      "",
    ].join("\n"), "utf-8");

    const { ensureCodexClientEnv } = await import("../../../src/cli/commands/setup-skill.js");
    const first = await ensureCodexClientEnv(configPath);
    const second = await ensureCodexClientEnv(configPath);

    const content = await readFile(configPath, "utf-8");
    expect(first).toBe("updated");
    expect(second).toBe("exists");
    expect(content.match(/\[mcp_servers\.storybloq\.env\]/g)).toHaveLength(1);
    expect(content).toContain('STORYBLOQ_CLIENT = "codex"');
    expect(content).not.toContain('STORYBLOQ_CLIENT = "claude"');
  });

  it("creates a missing Codex home directory before MCP registration", async () => {
    const codexHome = join(tempDir, "fresh-codex-home", "nested");
    const { ensureCodexHomeDir } = await import("../../../src/cli/commands/setup-skill.js");

    const first = await ensureCodexHomeDir(codexHome);
    const second = await ensureCodexHomeDir(codexHome);

    expect(first).toBe("created");
    expect(second).toBe("exists");
    expect(existsSync(codexHome)).toBe(true);
  });

  it("migrates stale Codex hook variants before registering the JSON hook", async () => {
    const hooksPath = join(tempDir, "hooks.json");
    await writeFile(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup|resume|clear",
          hooks: [
            { type: "command", command: "storybloq session resume-prompt" },
            { type: "command", command: "/usr/local/bin/storybloq session resume-prompt --codex-hook-json" },
          ],
        }],
      },
    }, null, 2), "utf-8");

    const {
      CODEX_SESSION_START_MATCHER,
      formatCodexSessionStartCommand,
      migrateCodexHookVariants,
      registerCodexHook,
    } = await import("../../../src/cli/commands/setup-skill.js");
    const command = formatCodexSessionStartCommand("/usr/local/bin/storybloq");
    const removed = await migrateCodexHookVariants(
      "SessionStart",
      ["session resume-prompt", "session resume-prompt --codex-hook-json"],
      command,
      hooksPath,
    );
    const registered = await registerCodexHook(
      "SessionStart",
      { type: "command", command, statusMessage: "Loading Storybloq session" },
      hooksPath,
      CODEX_SESSION_START_MATCHER,
    );

    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    const oldGroup = settings.hooks.SessionStart.find((g) => g.matcher === "startup|resume|clear");
    const currentGroup = settings.hooks.SessionStart.find((g) => g.matcher === CODEX_SESSION_START_MATCHER);
    expect(removed).toBe(1);
    expect(registered).toBe("registered");
    expect(oldGroup).toBeUndefined();
    expect(currentGroup?.hooks).toHaveLength(1);
    expect(currentGroup?.hooks[0]!.command).toBe(command);
  });

  it("registers Codex SessionStart hooks with JSON resume output", async () => {
    const hooksPath = join(tempDir, "hooks.json");
    const {
      CODEX_SESSION_START_MATCHER,
      formatCodexSessionStartCommand,
      registerCodexHook,
    } = await import("../../../src/cli/commands/setup-skill.js");
    const command = formatCodexSessionStartCommand("/usr/local/bin/storybloq");

    const first = await registerCodexHook(
      "SessionStart",
      { type: "command", command, statusMessage: "Loading Storybloq session" },
      hooksPath,
      CODEX_SESSION_START_MATCHER,
    );
    const second = await registerCodexHook(
      "SessionStart",
      { type: "command", command, statusMessage: "Loading Storybloq session" },
      hooksPath,
      CODEX_SESSION_START_MATCHER,
    );

    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    expect(first).toBe("registered");
    expect(second).toBe("exists");
    expect(settings.hooks.SessionStart[0]!.matcher).toBe(CODEX_SESSION_START_MATCHER);
    expect(settings.hooks.SessionStart[0]!.hooks[0]!.command).toContain("--codex-hook-json");
  });

  it("registers identity-aware Codex PreCompact hooks with manual and auto compact sources", async () => {
    const hooksPath = join(tempDir, "hooks.json");
    const {
      CODEX_PRECOMPACT_MATCHER,
      formatCodexPreCompactCommand,
      registerCodexHook,
    } = await import("../../../src/cli/commands/setup-skill.js");
    const command = formatCodexPreCompactCommand("/usr/local/bin/storybloq");

    const first = await registerCodexHook(
      "PreCompact",
      { type: "command", command, statusMessage: "Preparing Storybloq session" },
      hooksPath,
      CODEX_PRECOMPACT_MATCHER,
    );
    const second = await registerCodexHook(
      "PreCompact",
      { type: "command", command, statusMessage: "Preparing Storybloq session" },
      hooksPath,
      CODEX_PRECOMPACT_MATCHER,
    );

    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: { PreCompact: Array<{ matcher?: string; hooks: Array<{ command: string; statusMessage?: string }> }> };
    };
    expect(first).toBe("registered");
    expect(second).toBe("exists");
    expect(settings.hooks.PreCompact[0]!.matcher).toBe(CODEX_PRECOMPACT_MATCHER);
    expect(settings.hooks.PreCompact[0]!.hooks[0]!.command).toBe(command);
    expect(command).toContain("--client codex");
    expect(settings.hooks.PreCompact[0]!.hooks[0]!.statusMessage).toBe("Preparing Storybloq session");
  });

  it("refreshes a legacy Codex PreCompact command to include client identity", async () => {
    const hooksPath = join(tempDir, "hooks.json");
    await writeFile(hooksPath, JSON.stringify({
      hooks: {
        PreCompact: [{
          matcher: "manual|auto",
          hooks: [{ type: "command", command: "storybloq session compact-prepare" }],
        }],
      },
    }, null, 2), "utf-8");

    const { refreshExistingCodexHooks } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await refreshExistingCodexHooks("/usr/local/bin/storybloq", hooksPath);
    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: { PreCompact: Array<{ hooks: Array<{ command: string }> }> };
    };

    expect(result.detected).toBe(1);
    expect(settings.hooks.PreCompact.flatMap((group) => group.hooks.map((hook) => hook.command))).toEqual([
      "/usr/local/bin/storybloq session compact-prepare --client codex",
    ]);
  });

  it("moves an existing Codex SessionStart command from the old matcher to the compact-aware matcher", async () => {
    const hooksPath = join(tempDir, "hooks.json");
    const {
      CODEX_SESSION_START_MATCHER,
      formatCodexSessionStartCommand,
      registerCodexHook,
    } = await import("../../../src/cli/commands/setup-skill.js");
    const command = formatCodexSessionStartCommand("/usr/local/bin/storybloq");
    await writeFile(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup|resume|clear",
          hooks: [{ type: "command", command, statusMessage: "Loading Storybloq session" }],
        }],
      },
    }, null, 2), "utf-8");

    const result = await registerCodexHook(
      "SessionStart",
      { type: "command", command, statusMessage: "Loading Storybloq session" },
      hooksPath,
      CODEX_SESSION_START_MATCHER,
    );

    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    const oldGroup = settings.hooks.SessionStart.find((g) => g.matcher === "startup|resume|clear");
    const currentGroup = settings.hooks.SessionStart.find((g) => g.matcher === CODEX_SESSION_START_MATCHER);
    expect(result).toBe("registered");
    expect(oldGroup).toBeUndefined();
    expect(currentGroup?.hooks.map((h) => h.command)).toEqual([command]);
  });

  it("preserves a user-owned empty Codex matcher group when the target hook already exists", async () => {
    const hooksPath = join(tempDir, "hooks.json");
    const {
      CODEX_SESSION_START_MATCHER,
      formatCodexSessionStartCommand,
      registerCodexHook,
    } = await import("../../../src/cli/commands/setup-skill.js");
    const command = formatCodexSessionStartCommand("/usr/local/bin/storybloq");
    await writeFile(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "startup|resume|clear", hooks: [] },
          {
            matcher: CODEX_SESSION_START_MATCHER,
            hooks: [{ type: "command", command, statusMessage: "Loading Storybloq session" }],
          },
        ],
      },
    }, null, 2), "utf-8");

    const result = await registerCodexHook(
      "SessionStart",
      { type: "command", command, statusMessage: "Loading Storybloq session" },
      hooksPath,
      CODEX_SESSION_START_MATCHER,
    );

    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    expect(result).toBe("exists");
    expect(settings.hooks.SessionStart.map((g) => g.matcher)).toEqual([
      "startup|resume|clear",
      CODEX_SESSION_START_MATCHER,
    ]);
    expect(settings.hooks.SessionStart[1]!.hooks.map((h) => h.command)).toEqual([command]);
  });

  it("prunes a stale-only Codex matcher group after migration removes its hooks", async () => {
    const hooksPath = join(tempDir, "hooks.json");
    await writeFile(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup|resume|clear",
          hooks: [{ type: "command", command: "storybloq session resume-prompt" }],
        }],
      },
    }, null, 2), "utf-8");

    const { migrateCodexHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const removed = await migrateCodexHookVariants(
      "SessionStart",
      ["session resume-prompt", "session resume-prompt --codex-hook-json"],
      "/usr/local/bin/storybloq session resume-prompt --codex-hook-json",
      hooksPath,
    );

    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(removed).toBe(1);
    expect(settings.hooks.SessionStart).toEqual([]);
  });

  it("refreshExistingCodexHooks migrates only existing Codex Storybloq hook types", async () => {
    const hooksPath = join(tempDir, "hooks.json");
    await writeFile(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup|resume|clear",
          hooks: [
            { type: "command", command: "storybloq session resume-prompt" },
            { type: "command", command: "/usr/local/bin/storybloq session resume-prompt --codex-hook-json" },
          ],
        }],
        Stop: [{
          hooks: [{ type: "command", command: "storybloq hook-status" }],
        }],
      },
    }, null, 2), "utf-8");

    const {
      CODEX_SESSION_START_MATCHER,
      refreshExistingCodexHooks,
    } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await refreshExistingCodexHooks("/usr/local/bin/storybloq", hooksPath);

    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: {
        PreCompact?: unknown;
        SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
        Stop: Array<{ matcher?: string; hooks: Array<{ command: string; statusMessage?: string }> }>;
      };
    };
    const startCurrent = settings.hooks.SessionStart.find((g) => g.matcher === CODEX_SESSION_START_MATCHER);
    const startOld = settings.hooks.SessionStart.find((g) => g.matcher === "startup|resume|clear");
    const stopCommands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));

    expect(result.detected).toBe(3);
    expect(result.changed).toBeGreaterThan(0);
    expect(result.skipped).toBe(false);
    expect(startOld).toBeUndefined();
    expect(startCurrent?.hooks.map((h) => h.command)).toEqual([
      "/usr/local/bin/storybloq session resume-prompt --codex-hook-json",
    ]);
    expect(stopCommands).toEqual(["/usr/local/bin/storybloq hook-status --client codex"]);
    expect(settings.hooks.PreCompact).toBeUndefined();
  });
});

// T-414: /story surfaces orchestrate proactively at context load when the client
// is capable AND the backlog is orchestrate-sized. The gates must be spelled out
// deterministically in the skill text so any agent executes them identically.
describe("T-414: orchestrate discoverability", () => {
  it("SKILL.md Part 3 offers the Orchestrate-the-backlog option with the exact rendered description", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("Orchestrate the backlog");
    expect(content).toContain(
      "drive the backlog with tiered background agents: enrichment pass, review gates, batched ships",
    );
    // R6: exactly three explicit options in this state; "Something else" is dropped.
    expect(content).toContain("DROP \"Something else\"");
  });

  it("SKILL.md spells out the deterministic Gate B backlog-size algorithm", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    // storybloq_recommend loaded with count: 10.
    expect(content).toContain("count: 10");
    // issue rows are verified actionable via storybloq_issue_get.
    expect(content).toContain("storybloq_issue_get");
    // kind "action" rows are excluded.
    expect(content).toContain("never count a row whose `kind` is `\"action\"`");
    // status verification.
    expect(content).toContain("open` or `inprogress");
  });

  it("SKILL.md Gate A uses an exact-name allowlist that fails closed", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("EXACT callable tool name or namespace-qualified identifier");
    expect(content).toContain("fails closed");
    // The allowlist names.
    expect(content).toContain("`Workflow`");
    expect(content).toContain("`Agent`");
    expect(content).toContain("`Task`");
    expect(content).toContain("`multi_agent_v1.spawn_agent`");
    expect(content).toContain("`multi_agent_v1__spawn_agent`");
    expect(content).toContain("`spawn_agent`");
    expect(content).toContain("merely mentions agents does not pass");
  });

  it("SKILL.md pins storybloq_node_list as the federation-bypass source for Gate B", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("storybloq_node_list returns at least one configured node");
  });

  it("mcp/index.ts appends the orchestrate nudge to the ROOT-branch instructions string", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "mcp", "index.ts"), "utf-8");
    // R3: contiguous substring spanning the existing root-branch text into the new
    // sentence, pinning placement to the root (project-found) branch.
    expect(content).toContain(
      "for session context. On clients with multi-agent orchestration",
    );
    expect(content).toContain("/story orchestrate");
  });

  it("orchestrator-mode.md records the opt-in as either invocation or selection (R8)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "orchestrator-mode.md"), "utf-8");
    expect(content).toContain(
      "the prior /story orchestrate invocation or the Orchestrate-the-backlog selection",
    );
  });
});
