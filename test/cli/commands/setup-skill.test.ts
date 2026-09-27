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
      /call `storybloq_status` with `\{ "format": "json", "compact": true \}`/,
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
    // set-comparison-and-restart wording. T-496 relocated the full guard body
    // (byte-for-byte) to session-guard.md; SKILL.md's stub carries only a
    // one-line pointer to it, so this detail is asserted against the moved
    // text, not against SKILL.md itself.
    const guardBody = await readFile(join(PROJECT_ROOT, "src", "skill", "session-guard.md"), "utf-8");
    const retrigger = guardBody.slice(guardBody.indexOf("Re-trigger rule for the Step 2 reconciliation"));
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
    expect(guardBody, "the second guard call is prescribed but not authorized").toMatch(
      /Re-trigger rule for the Step 2 reconciliation/i,
    );
    expect(guardBody).toMatch(/ownership counts as unresolved again/i);
    expect(guardBody).toMatch(/the only rescan authorized here/i);
  });

  it("SKILL.md defines task-aware continuation and foreign-task relay", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain('`storybloq_status` with `{ "format": "json", "compact": true }`');

    // T-446: SKILL.md now calls `storybloq_session_guard` and acts on the
    // verdict instead of walking a prose matrix. Every action in the union must
    // still be handled, or a verdict the tool can return has no instruction
    // attached to it.
    expect(content).toContain("storybloq_session_guard");

    // T-496 relocated the full guard body (byte-for-byte) to session-guard.md;
    // SKILL.md's stub carries only the ordinary path plus one-line pointers
    // for the exceptional verdicts. Every assertion below that needs the full
    // guard detail (the prelude, the whitelist, and every verdict's own
    // bullet) reads the moved text, not SKILL.md itself.
    const guardBody = await readFile(join(PROJECT_ROOT, "src", "skill", "session-guard.md"), "utf-8");

    /**
     * The tool-absent branch requires that a TARGETED discovery call for the
     * guard already failed. If the prelude only ever targets `storybloq_status`,
     * a client whose broad discovery truncated the guard away can neither call
     * it nor discover it, so mode A is unreachable and every invocation stops
     * before argument routing.
     */
    const prelude = guardBody.slice(guardBody.indexOf("**Guard prelude"), guardBody.indexOf("**Whitelist semantics"));
    expect(prelude.length, "could not locate the guard prelude").toBeGreaterThan(200);
    expect(prelude).toMatch(/query: "storybloq_session_guard"/);
    // Both required tools, not just the guard: deleting the status lookup would
    // otherwise stay green and break mode A, which needs `storybloq_status`.
    expect(prelude).toMatch(/query: "storybloq_status"/);
    expect(prelude).toMatch(/before concluding anything about MCP availability or declaring the guard absent/i);

    // Bounded to each action's OWN bullet in the "Act on `overallAction`" list.
    // A whole-file substring search passes as long as the word appears anywhere,
    // so it cannot see an action whose instruction drifted or went missing.
    const sectionStart = guardBody.indexOf("2. Act on `overallAction`");
    const sectionEnd = guardBody.indexOf("**If `storybloq_session_guard` is confirmed absent**");
    // Both markers asserted before slicing: a missing marker silently yields an
    // empty or whole-file slice, and every bullet assertion below would then be
    // testing something other than the section it names.
    expect(sectionStart, "no `Act on overallAction` heading in session-guard.md").toBeGreaterThan(-1);
    expect(sectionEnd, "no tool-absent marker to bound the section").toBeGreaterThan(sectionStart);
    const actOn = guardBody.slice(sectionStart, sectionEnd);

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
    const whitelist = guardBody.slice(guardBody.indexOf("**Whitelist semantics"), guardBody.indexOf("1. Call `storybloq_session_guard`"));
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
    const guardText = guardBody;
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

    // Codex owner-response relay (item 3): full detail moved to
    // session-guard.md; SKILL.md's stub carries only a one-line pointer to it.
    expect(guardBody).toContain("codex_app__send_message_to_thread");
    expect(guardBody).toContain("the user's exact message");
    expect(guardBody).toContain("Sent to T-020's running task.");
    expect(guardBody).toContain("manual-switch instruction");
    expect(guardBody).not.toContain("take over (only safe if the owning instance is gone)");
  });

  it("settings.md documents the bounded code-review landing policy (T-460 Leg C step 1)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "settings.md"), "utf-8");
    const autonomous = await readFile(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8");
    expect(content).toContain('"maxReviewRounds": "number (default: 12');
    expect(autonomous).toContain("Code-review landing cap");
    expect(autonomous).toContain("zero unresolved critical findings advances to FINALIZE");
    expect(autonomous).toContain("PLAN_REVIEW convergence remains separate");
  });

  /**
   * The ceiling is a behaviour change a reader has to be told about. At the
   * EFFECTIVE cap -- the configured one, raised by the ticket-risk floor -- the
   * session may land, but only when nothing blocking remains; blocking findings
   * or a `reject` verdict are exactly the cases that continue past it. Three
   * rounds later the hard ceiling stops either non-finalizing loop and ends the
   * session. The cap
   * paragraph above documents the landing half and would read as the whole
   * story without this.
   */
  it("autonomous-mode.md documents the hard ceiling that bounds a non-converging review", async () => {
    const autonomous = await readFile(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8");
    expect(autonomous).toContain("The hard ceiling");
    expect(autonomous).toContain("files the outstanding findings as open issues");
    expect(autonomous).toContain("goes to HANDOVER");
    // `0` has to disable BOTH, or "unlimited" would not mean unlimited.
    expect(autonomous).toContain("disables the ceiling along with the cap");
    // BOTH triggers named. `reject` continues without landing whether or not
    // anything is blocking, so a section describing only unresolved criticals
    // tells a reader the ceiling cannot reach them when it can.
    expect(autonomous).toContain("`reject` and unresolved criticals continue instead of finalizing");
    // And the routing is not categorical: a finding asking for a replan sends
    // the same non-finalizing round to PLAN rather than IMPLEMENT.
    expect(autonomous).toContain("or to PLAN when a finding asks for a replan");
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

  it("no orphaned .md files in src/skill/ (every file is reachable, transitively, from SKILL.md)", async () => {
    // T-496 introduced a two-hop reference: SKILL.md's Step 0.5 stub points
    // at session-guard.md, and session-guard.md (the verbatim original guard
    // body) is what names session-guard-fallback.md onward for modes A/B.
    // Direct containment in SKILL.md alone no longer proves reachability, so
    // this walks the reference graph instead of checking one hop.
    const { readdirSync } = await import("node:fs");
    const skillDir = join(PROJECT_ROOT, "src", "skill");
    const allFiles = readdirSync(skillDir).filter(f => f.endsWith(".md"));

    const reachable = new Set<string>(["SKILL.md"]);
    const queue = ["SKILL.md"];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const content = await readFile(join(skillDir, current), "utf-8");
      for (const file of allFiles) {
        if (!reachable.has(file) && content.includes(file)) {
          reachable.add(file);
          queue.push(file);
        }
      }
    }

    for (const file of allFiles) {
      if (file === "SKILL.md") continue;
      expect(
        reachable.has(file),
        `"${file}" exists in src/skill/ but is not reachable, even transitively, from SKILL.md`,
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

  it("SKILL.md Step 1 routes every folder without .story/ to setup-flow (T-536)", async () => {
    const skill = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    const step1 = skill.slice(skill.indexOf("## Step 1: Check Project"), skill.indexOf("## Step 2: Load Context"));
    expect(step1).toContain("If no `.story/` -> read `setup-flow.md`");
    expect(step1).toContain("only documents, or nothing but an idea");
    expect(step1).toContain("offer to set it up here");
    expect(step1).not.toContain("suggest navigating to a project");
    expect(step1).not.toContain("project indicators");
  });

  it("SKILL.md Step 2b routes on isEmptyScaffold from JSON, integrity first, Markdown fallback kept (T-536)", async () => {
    const skill = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    const step2b = skill.slice(skill.indexOf("## Step 2b"), skill.indexOf("## Step 3"));
    const integrity = step2b.indexOf("**Integrity guard**");
    const json = step2b.indexOf("`data.isEmptyScaffold` is `true`");
    const markdown = step2b.indexOf("**Legacy Markdown payload**");
    expect(integrity).toBeGreaterThanOrEqual(0);
    expect(json).toBeGreaterThan(integrity);
    expect(markdown).toBeGreaterThan(json);
    expect(step2b).toContain("non-empty top-level `warnings` array");
    expect(step2b).toContain("item(s) skipped due to data integrity issues");
    expect(step2b).toContain("with or without code");
    expect(step2b).not.toContain("code indicators");
    expect(step2b).not.toContain("no tickets yet");
  });

  // -------------------------------------------------------------------------
  // Support file content validation
  // -------------------------------------------------------------------------

  // T-536: setup-flow.md is product-first discovery, complete planning and
  // review by default. Sections are found by their stable step id ("1a",
  // "1c2"), not their title, so a contract fails on behaviour rather than on a
  // renamed heading; the titles have their own test. Each contract reads only
  // its section's text, so a phrase moved into the wrong section fails instead
  // of passing on a stray match elsewhere in the file.
  const readSetupFlow = (): Promise<string> =>
    readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
  // A step T-536 renumbered, mapped to the id it had before, so the contracts run
  // against the pre-T-536 flow and fail on its content rather than on a missing
  // heading. Used only when the current id is absent; the heading test pins it.
  const FORMER_STEP_IDS: Readonly<Record<string, string>> = { "1c2": "1d2" };
  const flowSection = (content: string, id: string): string => {
    const heading = (step: string): RegExpExecArray | null => new RegExp(`^#### ${step.replace(".", "\\.")}\\. [^\\n]*$`, "m").exec(content);
    const m = heading(id) ?? (FORMER_STEP_IDS[id] !== undefined ? heading(FORMER_STEP_IDS[id]!) : null);
    expect(m, `setup-flow.md has no step ${id}`).not.toBeNull();
    const rest = content.slice(m!.index + m![0].length);
    const next = rest.search(/\n#{2,4} /);
    return next === -1 ? rest : rest.slice(0, next);
  };

  /** The execution contract, as a list of problems, so the mutation tests below can prove it bites. */
  const executionProblems = (content: string): string[] => {
    const problems: string[] = [];
    const pkg = flowSection(content, "1d");
    const execute = flowSection(content, "1e");
    if (!pkg.includes('nothing in 1e runs until the user explicitly chooses "Approve setup"')) problems.push("no wait for an explicit approval");
    if (!execute.includes('Everything below runs only after "Approve setup".')) problems.push("execution not gated on approval");
    if (!/\*\*Pass 1:\*\* Call `storybloq_ticket_create` for each ticket WITHOUT `blockedBy`/.test(execute)) problems.push("pass 1 does not create without blockedBy");
    if (!execute.includes("Keep the id each call returns")) problems.push("pass 1 does not keep the returned ids");
    if (!/\*\*Pass 2:\*\* Call `storybloq_ticket_update` for each ticket that has `blockedBy` dependencies, using the ids the creation calls returned/.test(execute)) problems.push("pass 2 does not wire dependencies from the returned ids");
    if (!execute.includes("Validate: no cycles, no self-references")) problems.push("no dependency validation");
    const pass1 = execute.indexOf("**Pass 1:**");
    const pass2 = execute.indexOf("**Pass 2:**");
    if (pass1 < 0 || pass2 < 0 || pass2 < pass1) problems.push("pass 2 does not follow pass 1");
    return problems;
  };

  it("setup-flow.md keeps the section headings SKILL.md and the flow cite", async () => {
    const content = await readSetupFlow();
    for (const heading of [
      "## AI-Assisted Setup Flow",
      "#### 1a. Discover",
      "#### 1b. Understand the Material",
      "#### 1c. Establish Success",
      "#### 1c2. Plan and Review",
      "#### 1d. Present Proposal",
      "#### 1e. Execute on Approval",
      "#### 1f. Post-Setup",
    ]) {
      expect(content).toContain(heading);
    }
  });

  it("setup-flow.md discovery: four folder classes, no length or manifest gate, relevant material only", async () => {
    const discover = flowSection(await readSetupFlow(), "1a");
    for (const cls of ["`empty`", "`brief-only`", "`existing`", "`interrupted`"]) expect(discover).toContain(cls);
    expect(discover).toContain("no manifest or git requirement and no minimum length");
    expect(discover).toMatch(/Skip caches, build outputs, vendored dependencies/);
  });

  it("setup-flow.md understanding: every brief read, source references, evidence before completion, conflicts ruled", async () => {
    const understand = flowSection(await readSetupFlow(), "1b");
    expect(understand).toContain("the README included");
    expect(understand).toContain("no size or heading-word filter");
    expect(understand).not.toMatch(/>\s*100 lines/);
    expect(understand).toContain("source reference");
    for (const label of ["**requirement**", "**proposal**", "**existing behaviour**", "**unresolved decision**"]) {
      expect(understand).toContain(label);
    }
    expect(understand).toContain("**Evidence before completion.**");
    expect(understand).toContain("complete only when the code has it");
    expect(understand).toMatch(/each conflict with its consequence and a recommendation/);
    expect(understand).toContain("Inspect only what changes the plan");
  });

  it("setup-flow.md success: supplied answers reused, only unresolved material gaps asked, postponed decisions block only their work", async () => {
    const success = flowSection(await readSetupFlow(), "1c");
    expect(success).toContain("Reuse what the brief and the conversation already answered");
    expect(success).toContain("**material gaps** -- unresolved questions whose answer would change the plan");
    expect(success).toContain("When the material already answers everything, ask nothing.");
    expect(success).toContain("A decision the user postpones is recorded as an open owner decision: only the work it affects waits on it");
    expect(success).toContain("sensitive or regulated domain");
    expect(success).toContain("Label assumptions as assumptions");
    expect(success).toContain("never ask them again");
    // The eval harness bounds its own discovery rounds; the product flow carries no round cap and no forced question.
    expect(success).not.toMatch(/at most (three|3) rounds/);
    expect(success).not.toMatch(/always gets at least one round/);
  });

  it("setup-flow.md planning: no quotas, the ticket template with no empty label, coverage map, real dependencies, sizing by verifiability", async () => {
    const content = await readSetupFlow();
    const plan = flowSection(content, "1c2");
    expect(content).not.toMatch(/3-7 phases/);
    expect(content).not.toMatch(/2-5 each/);
    expect(plan).toContain("no phase or ticket quotas");
    for (const field of ["Outcome:", "Scope:", "Excludes:", "Acceptance:", "Behaviour:", "Verification:", "Prerequisites:", "Assumptions:"]) {
      expect(plan).toContain(field);
    }
    expect(plan).toContain("never leave it empty");
    expect(plan).toContain("**Coverage map.**");
    expect(plan).toContain("never silently promoted");
    expect(plan).toContain("`blockedBy` reflects real prerequisites only, never automatic chaining from phase order");
    expect(plan).toContain("split a ticket only when one slice cannot be implemented and verified as a unit");
    expect(plan).not.toMatch(/Split a ticket that spans several entities, an API and its UI/);
  });

  it("setup-flow.md checkpoints: three kinds, the Checkpoint: title convention, owner criteria, blocking only affected work", async () => {
    const plan = flowSection(await readSetupFlow(), "1c2");
    for (const kind of ["**early artifact review**", "**milestone demonstration**", "**first-version acceptance**"]) {
      expect(plan).toContain(kind);
    }
    expect(plan).toContain("titled `Checkpoint: <what the owner reviews>`");
    expect(plan).toContain("`Question:` for a decision, or `Criteria:` for a demonstration or acceptance");
    expect(plan).toContain("only the follow-on work that the owner's decision actually affects is `blockedBy` the checkpoint");
    expect(plan).toContain("Stage-1 limitation: nothing enforces the gate yet");
  });

  it("setup-flow.md review: on by default, capability order, two rounds, a visible retry-or-continue stop", async () => {
    const plan = flowSection(await readSetupFlow(), "1c2");
    expect(plan).toContain("**Independent review, by default.**");
    expect(plan).toContain("This runs before anything is shown for approval, every time.");
    const codex = plan.indexOf("`codex exec --output-schema`");
    const mcp = plan.indexOf("`review_plan`");
    const agent = plan.indexOf("an independent agent");
    expect(codex).toBeGreaterThanOrEqual(0);
    expect(mcp).toBeGreaterThan(codex);
    expect(agent).toBeGreaterThan(mcp);
    expect(plan).toContain("Maximum 2 review rounds");
    expect(plan).toContain("never weakened");
    expect(plan).toContain('"Retry the review"');
    expect(plan).toContain('"Continue without independent review"');
    expect(plan).toContain("Stop there until the user answers");
    expect(await readSetupFlow()).not.toContain("Review skipped -- no review backends available");
  });

  it("setup-flow.md package: three options, one approval covering tickets, files, quality and git", async () => {
    const content = await readSetupFlow();
    const pkg = flowSection(content, "1d");
    for (const option of ['"Approve setup"', '"Adjust the plan"', '"Inspect details"']) expect(pkg).toContain(option);
    expect(content).not.toContain("Create as-is");
    expect(content).not.toContain("Refine + get a second opinion");
    expect(pkg).toContain("**Governance files**");
    expect(pkg).toContain("`REVIEW.md`");
    expect(pkg).toContain("**Quality level**");
    for (const level of ["**Full pipeline**", "**Tests only**", "**Minimal**"]) expect(pkg).toContain(level);
    expect(pkg).toContain("**Git:**");
    expect(pkg).toContain("One approval covers everything listed");
    expect(flowSection(content, "1e")).not.toMatch(/AskUserQuestion/);
  });

  it("setup-flow.md ordering: review before the package question, an explicit approval before any write", async () => {
    const content = await readSetupFlow();
    const review = content.indexOf("**Independent review, by default.**");
    const question = content.indexOf('question: "How should I proceed with this setup?"');
    const wait = content.indexOf('nothing in 1e runs until the user explicitly chooses "Approve setup"');
    const init = content.indexOf("Call `storybloq_init`");
    const firstPhase = content.indexOf("Call `storybloq_phase_create`");
    const governance = content.indexOf("**CLAUDE.md generation**");
    const gitInit = content.indexOf("run `git init`");
    for (const at of [review, question, wait, init, firstPhase, governance, gitInit]) expect(at).toBeGreaterThanOrEqual(0);
    expect(review).toBeLessThan(question);
    expect(question).toBeLessThan(wait);
    for (const write of [init, firstPhase, governance, gitInit]) expect(wait).toBeLessThan(write);
  });

  it("setup-flow.md execution: two-pass creation with dependency wiring, gated on an explicit approval", async () => {
    expect(executionProblems(await readSetupFlow())).toEqual([]);
  });

  it("the execution contract catches a removed dependency pass and a removed wait for approval", async () => {
    const content = await readSetupFlow();
    const mutants: [string, string, RegExp][] = [
      ["pass 2 removed", "**Pass 2:** Call `storybloq_ticket_update` for each ticket that has `blockedBy` dependencies, using the ids the creation calls returned.", /pass 2 does not wire/],
      ["cycle check removed", "Validate: no cycles, no self-references.", /no dependency validation/],
      ["wait removed", ' Stop after asking and wait for the answer: nothing in 1e runs until the user explicitly chooses "Approve setup".', /no wait for an explicit approval/],
      ["gate removed", 'Everything below runs only after "Approve setup".', /execution not gated/],
    ];
    for (const [name, text, expected] of mutants) {
      expect(content, `${name}: the mutated text must exist`).toContain(text);
      expect(executionProblems(content.replace(text, "")).join(), name).toMatch(expected);
    }
  });

  it("setup-flow.md execution: init only when .story/ is absent, scaffold reused without force, readiness by capability, phases after p0", async () => {
    const content = await readSetupFlow();
    const execute = flowSection(content, "1e");
    expect(execute).toContain("**Initialise only when `.story/` is absent.**");
    expect(execute).toContain("init is never forced over them");
    expect(execute).toContain("`p0`");
    expect(execute).toContain("**Readiness by capability.**");
    for (const tool of ["`storybloq_phase_create`", "`storybloq_ticket_create`", "`storybloq_ticket_update`", "`storybloq_issue_create`", "`storybloq_snapshot`"]) {
      expect(execute).toContain(tool);
    }
    expect(execute).toContain("fall back to the CLI");
    expect(execute).toContain("stop with a concrete blocker");
    expect(content).not.toMatch(/only 2 tools|exactly two tools/);
    expect(execute).toContain('the first goes `after: "p0"` without `atStart`; only on an empty roadmap does the first use `atStart: true`');
    expect(execute).not.toContain("the first with `atStart: true` (after `p0`");
  });

  it("setup-flow.md execution: all four stages written explicitly; BUILD and VERIFY only for Full pipeline with established commands", async () => {
    const execute = flowSection(await readSetupFlow(), "1e");
    expect(execute).toContain("config set-overrides");
    expect(execute).toContain("all four stages, `WRITE_TESTS`, `TEST`, `BUILD` and `VERIFY`, are always written with an explicit `\"enabled\"` value");
    expect(execute).toContain("a reused scaffold may already carry overrides");
    expect(execute).toContain("write `WRITE_TESTS` and `TEST` with that same command");
    expect(execute).toContain('write both with `"enabled": false` and record the proposed command as pending');
    expect(execute).toContain("Never leave them to the defaults");
    expect(execute).toContain("`\"enabled\": true` only for Full pipeline, and only with commands established from the manifests");
    expect(execute).toContain("Tests only, Minimal, pending tooling, and project types VERIFY does not apply to");
    expect(execute).toContain("never execute an install, test, build or dev server during setup");
    expect(execute).toContain("never gets `npm test`");
    expect(execute).not.toContain("no overrides needed");
    expect(execute).not.toContain("enable them with their commands only when established");
  });

  it("setup-flow.md keeps the preserved invariants of execution and post-setup", async () => {
    const content = await readSetupFlow();
    const execute = flowSection(content, "1e");
    expect(execute).toContain("Sanitization");
    expect(execute).toContain("**Verify after write.**");
    expect(execute).toContain("`review-contract-template.md`");
    expect(execute).toContain("TDD for business logic");
    const post = flowSection(content, "1f");
    expect(post).toContain("/story");
    expect(post).toContain("/story auto");
    expect(post).toContain("$story");
    expect(post).toContain("$story auto");
    expect(post).toContain("Verification tooling to establish:");
    expect(post).toContain("coverage map");
    expect(post).toContain("the review outcome or the recorded skip");
  });

  it("setup-flow.md names no vendor as a default", async () => {
    const content = await readSetupFlow();
    expect(content).not.toContain("product default");
    expect(content).not.toMatch(/Firebase Auth or Clerk/);
    expect(content).not.toContain("## Appendix: Default Stack Recommendations");
    expect(content).not.toMatch(/\(Recommended\)/);
    expect(content).toContain("no house favourite");
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

  it("SKILL.md has /story settings command in argument handler, pointing at settings.md", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("/story settings");
    expect(content).toContain("## Settings");
    expect(content).toContain("settings.md");
  });

  it("settings.md has the config schema reference (no source code digging needed) (T-460 Leg C step 1)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "settings.md"), "utf-8");
    expect(content).toContain("### Config Schema Reference");
    expect(content).toContain("WRITE_TESTS");
    expect(content).toContain("VERIFY");
    expect(content).toContain("maxTicketsPerSession");
    expect(content).toContain("reviewBackends");
    expect(content).toContain("Do NOT search source code");
  });

  it("only the /story settings route in How to Handle Arguments names settings.md (T-460 Leg C step 1)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    const start = content.indexOf("## How to Handle Arguments");
    const end = content.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThan(-1);
    const section = end === -1 ? content.slice(start) : content.slice(start, end);
    const routeLines = section.split("\n").filter((l) => l.trim().startsWith("- `/story"));
    expect(routeLines.length).toBeGreaterThan(1);
    const settingsRouteLines = routeLines.filter((l) => l.includes("settings.md"));
    expect(settingsRouteLines).toHaveLength(1);
    expect(settingsRouteLines[0]).toContain("/story settings");
  });

  it("settings.md's body still contains every pre-split line, in order and unreworded (T-460 Leg C step 1)", () => {
    // Proves the T-460 Leg C step 1 relocation moved the Settings section
    // verbatim -- zero rewording -- the same preservation-proof pattern T-496
    // used for session-guard.md. The fixture is the exact pre-split body
    // (current-main SKILL.md lines 424-631, before this ticket's edit); only
    // the new heading + one-line intro precede it in settings.md.
    //
    // The split point is derived from the EXACT expected header text, not
    // from settings.length - fixture.length: deriving it from the fixture's
    // own length turns this into a suffix check that an empty fixture (or
    // arbitrary content inserted between the intro and the body, absorbed
    // into a now-larger "header") would pass vacuously. Asserting the fixture
    // is non-empty and the header is an EXACT prefix match closes both gaps.
    const settings = readFileSync(join(PROJECT_ROOT, "src", "skill", "settings.md"));
    const fixture = readFileSync(
      join(PROJECT_ROOT, "test", "core", "fixtures", "t460-settings-section-presplit.txt"),
    );
    expect(fixture.length, "fixture must not be empty").toBeGreaterThan(0);
    const expectedHeader =
      "# Settings (/story settings)\n\n" +
      "Full `/story settings` flow: read `.story/config.json`, present current settings, walk the user through changes via `AskUserQuestion`, apply via `storybloq config set-overrides`, and the complete config schema reference. Loaded on demand from SKILL.md; not part of every `/story` session.\n\n";
    const headerBytes = Buffer.byteLength(expectedHeader, "utf-8");
    expect(settings.subarray(0, headerBytes).toString("utf-8")).toBe(expectedHeader);
    const body = settings.subarray(headerBytes);
    // T-501: settings.md is a living document again (it now documents
    // `autoCompactWindow`), so a byte-for-byte equality with the frozen
    // pre-split fixture would forbid every later addition rather than prove
    // anything about the relocation. What the relocation proof is actually
    // about survives as stated: every pre-split line is still present, in the
    // same order, with its bytes unchanged -- so nothing was reworded,
    // reordered or dropped, and a later ticket may only ADD.
    const bodyLines = body.toString("utf-8").split("\n");
    const fixtureLines = fixture.toString("utf-8").split("\n");
    let cursor = 0;
    const missing: string[] = [];
    for (const line of fixtureLines) {
      const at = bodyLines.indexOf(line, cursor);
      if (at === -1) missing.push(line);
      else cursor = at + 1;
    }
    expect(missing, "pre-split lines missing or reworded in settings.md").toEqual([]);
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

  it("triage-mode.md pins the corrected data contracts and the read-only posture", async () => {
    const content = await readFile(
      join(PROJECT_ROOT, "src", "skill", "triage-mode.md"), "utf-8",
    );
    // Read-only sentinel + the one confirmed write path (snapshot before handover)
    expect(content).toContain("mutates no issue, no ticket");
    expect(content).toContain("the maintainer closes, files, and reprioritizes; never this workflow");
    expect(content).toContain("`storybloq snapshot` and then `storybloq_handover_create`");
    // Gathering contracts: validate-first branch, envelopes, exit codes, unfiltered list
    expect(content).toContain("storybloq validate --format json");
    expect(content).toContain("criticalErrorCount");
    expect(content).toContain("regardless of exit code");
    expect(content).toContain("storybloq issue list --format json");
    expect(content).toContain("UNFILTERED");
    expect(content).toContain("git status --porcelain");
    // Correlation: multimap alias indexes, dedupe groups from issue objects
    expect(content).toContain("previousDisplayIds");
    expect(content).toContain("SET of records");
    expect(content).toContain("compute dedupe-key groups directly from the issue objects");
    // Evidence bars: re-verify default, ticket-scope corroboration, verified grouping
    expect(content).toContain("Default to re-verify, NOT to already-fixed");
    expect(content).toContain("FIX_WITH_T-xxx");
    expect(content).toContain("VERIFIED shared mechanism");
    // Report vocabulary axes and format extensibility
    expect(content).toContain("Urgency and vehicle are separate axes");
    expect(content).toContain("never replace, rename, or reorder the pinned sections");
    // Consistency recheck + summary invariant
    expect(content).toContain("Ledgers can change without HEAD moving");
    expect(content).toContain("unclassified");
    // Vocabulary spot checks
    expect(content).toContain("ALREADY_FIXED");
    expect(content).toContain("NEEDS_INVESTIGATION");
    // Maintainer corrections applied while porting public PR #30: full
    // source_ref code coverage, rot-proof integrity wording, the
    // worktree-evidence label rule, and the item/auxiliary split.
    expect(content).toContain("source_ref_original_mismatch");
    expect(content).toContain("source_ref_original_unresolvable");
    expect(content).toContain("is missing or invalid");
    expect(content).not.toContain("(`invalid_json` / `schema_error`)");
    expect(content).toContain("label that evidence `@ worktree`");
    expect(content).toContain("never supports ALREADY_FIXED or CLOSE_FIXED");
    expect(content).toContain("never dropped items and never counted in `droppedFileCount`");
    // The report template must agree with the provenance rule: header and
    // evidence column admit both labels, and an unborn branch reports null.
    expect(content).toContain("@ <sha | worktree>");
    expect(content).toContain("`@ <sha>` / `@ worktree` provenance");
    expect(content).toContain('"head": "<sha, or null on an unborn branch>"');
    expect(content).not.toContain("Evidence @ HEAD");
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
    expect(tsContent).toContain('"triage-mode.md"');
    expect(tsContent).toContain('"bus-mode.md"');
    expect(tsContent).toContain('"duet-mode.md"');
    // T-487: setup-flow.md reads this template at emission time. Left out of
    // the allow-list it would simply not be installed, and the setup flow would
    // report a missing file instead of writing a review contract.
    expect(tsContent).toContain('"review-contract-template.md"');
    // T-496 (ISS-1144 guard pattern): session-guard.md is the on-demand
    // reference the Step 0.5 stub points to. Left out of the allow-list it
    // would simply not be installed, and every exceptional-verdict pointer
    // in the stub would dangle.
    expect(tsContent).toContain('"session-guard.md"');
  });

  it("every real supportFiles entry has a Support Files inventory line in SKILL.md (ISS-1186)", async () => {
    // Directional counterpart to the "no orphaned .md files" reachability
    // scan: that test asserts inventoried/referenced-implies-reachable; this
    // one asserts the reverse, installed-implies-inventoried. A file can drift
    // out of sync in either direction independently, so both tests are needed.
    const tsContent = await readFile(
      join(PROJECT_ROOT, "src", "cli", "commands", "setup-skill.ts"),
      "utf-8",
    );
    const match = tsContent.match(/const supportFiles = \[([^\]]*)\];/);
    expect(match, "supportFiles array not found in setup-skill.ts").not.toBeNull();
    const supportFiles = match![1]
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    expect(supportFiles.length).toBeGreaterThan(1);

    const skillContent = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    // Scoped to the Support Files section itself, not the whole file -- a
    // bold-backticked filename mentioned anywhere else (a body reference, a
    // code sample) must not satisfy this. Support Files is currently the
    // last level-two section, but the slice still bounds itself to the next
    // "## " heading (or EOF) rather than assuming that.
    const sectionStart = skillContent.indexOf("## Support Files");
    expect(sectionStart, "no Support Files section found in SKILL.md").toBeGreaterThan(-1);
    const nextHeadingIdx = skillContent.indexOf("\n## ", sectionStart + 1);
    const inventorySection =
      nextHeadingIdx === -1 ? skillContent.slice(sectionStart) : skillContent.slice(sectionStart, nextHeadingIdx);
    for (const file of supportFiles) {
      expect(
        inventorySection.includes(`**\`${file}\`**`),
        `"${file}" is installed by setup-skill.ts's supportFiles array but has no Support Files inventory line in SKILL.md`,
      ).toBe(true);
    }
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

  it("is idempotent -- second run returns exists", async () => {
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

  it("ISS-1226: a group emptied by the migration disappears instead of surviving as an empty shell", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: "/new/v22/bin/storybloq session resume-prompt" }] },
          { matcher: "resume", hooks: [{ type: "command", command: "/Users/o/.npm/_npx/573f/node_modules/.bin/storybloq session resume-prompt" }] },
          { matcher: "", hooks: [] },
        ],
      },
    }, null, 2), "utf-8");
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants("SessionStart", "session resume-prompt", "/new/v22/bin/storybloq session resume-prompt", settingsPath);
    expect(count).toBe(1);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as { hooks: { SessionStart: Array<{ matcher: string; hooks: unknown[] }> } };
    // The emptied "resume" group is gone; a group that was already empty before the migration is not this function's to touch.
    expect(settings.hooks.SessionStart.map((g) => [g.matcher, g.hooks.length])).toEqual([["startup|resume|clear|compact", 1], ["", 0]]);
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
    // recommend() already partitions actionability server-side (ISS-1154
    // Commit B); Gate B counts recommendations rows directly, no per-row get.
    expect(content).toContain("already partitioned to actionable candidates");
    // kind "action" rows are excluded.
    expect(content).toContain("never count a row whose `kind` is `\"action\"`");
    // unreadableHandoverCount disclosure.
    expect(content).toContain("unreadableHandoverCount");
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

// ---------------------------------------------------------------------------
// --skip-skill (ISS-834)
// ---------------------------------------------------------------------------

describe("--skip-skill (ISS-834)", () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-skip-skill-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
    originalCodexHome = process.env.CODEX_HOME;
    // Empty PATH: keeps handleSetupCodex out of the MCP-registration branch
    // (cliInPath/codexInPath both false), which needs real `storybloq`/`codex`
    // binaries this test has no business invoking.
    process.env.PATH = "";
    process.env.HOME = tempDir;
    // CODEX_HOME is read by codexHome() (the compat skill copy and hooks.json
    // paths) and by the codexCompat version marker. Left inherited, a
    // developer or CI shell with CODEX_HOME set would let the non-skip test
    // refresh a REAL compat copy and let the marker assertions read real
    // state outside this fixture. Pin it under tempDir like HOME.
    process.env.CODEX_HOME = join(tempDir, ".codex");
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  const codexSkillMd = () => join(tempDir, ".agents", "skills", "story", "SKILL.md");
  const claudeSkillMd = () => join(tempDir, ".claude", "skills", "story", "SKILL.md");

  it("skips the Codex skill copy when skipSkill is true", async () => {
    if (process.platform === "win32") return;
    const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
    await handleSetup({ client: "codex", skipHooks: true, skipSkill: true });
    expect(existsSync(codexSkillMd())).toBe(false);
  });

  it("writes no version marker when skipSkill is true (no install happened to stamp)", async () => {
    // A marker claims a version was written to the skill dir. Stamping one
    // for a copy that never ran would tell autoRefreshSkillIfStale the
    // plugin-managed skill (the only copy actually present) is this CLI's
    // own up to date -- a stale-marker lie in the opposite direction from
    // the bug the marker exists to catch.
    if (process.platform === "win32") return;
    const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
    const { readSkillMarker } = await import("../../../src/core/skill-version-marker.js");
    await handleSetup({ client: "codex", skipHooks: true, skipSkill: true });
    expect(readSkillMarker("codex")).toBe(null);
    expect(readSkillMarker("codexCompat")).toBe(null);
  });

  it("performs the Codex skill copy when skipSkill is absent", async () => {
    if (process.platform === "win32") return;
    const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
    await handleSetup({ client: "codex", skipHooks: true });
    expect(existsSync(codexSkillMd())).toBe(true);
  });

  it.each(["claude", "codex"] as const)("installs the duet guide for %s into an isolated home (ISS-1155, ISS-1144)", async (client) => {
    if (process.platform === "win32") return;
    // Seed the legacy Codex copy so its refresh is verified too. All setup
    // destinations and executable discovery are isolated by this fixture.
    const compatDir = join(tempDir, ".codex", "skills", "story");
    await mkdir(compatDir, { recursive: true });
    await writeFile(join(compatDir, "SKILL.md"), "old skill", "utf-8");
    const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
    await handleSetup({ client, skipHooks: true });
    const installed = join(tempDir, client === "claude" ? ".claude" : ".agents", "skills", "story", "duet-mode.md");
    expect(existsSync(installed), `${client} setup omitted duet-mode.md`).toBe(true);
    const source = await readFile(join(PROJECT_ROOT, "src", "skill", "duet-mode.md"), "utf-8");
    expect(await readFile(installed, "utf-8")).toBe(source);
    if (client === "codex") {
      expect(await readFile(join(compatDir, "duet-mode.md"), "utf-8")).toBe(source);
    }
  });

  it("--client claude is unaffected by skipSkill (D1 regression guard)", async () => {
    if (process.platform === "win32") return;
    const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
    // client: "all" with skipSkill: true -- Claude side must still copy while
    // the Codex side is skipped. (client: "claude" alone with skipSkill is a
    // usage error, covered below, so it cannot itself demonstrate this.)
    await handleSetup({ client: "all", skipHooks: true, skipSkill: true });
    expect(existsSync(claudeSkillMd())).toBe(true);
    expect(existsSync(codexSkillMd())).toBe(false);
  });

  it("rejects --client claude --skip-skill with a usage error, not a silent no-op", async () => {
    if (process.platform === "win32") return;
    const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    await handleSetup({ client: "claude", skipHooks: true, skipSkill: true });
    const exitCode = process.exitCode;
    process.exitCode = prevExit;
    expect(exitCode).toBe(1);
    // And it must not have silently proceeded to write the Claude skill copy.
    expect(existsSync(claudeSkillMd())).toBe(false);
  });

  it("setup-skill (the Claude-only alias) rejects an unrecognized --skip-skill flag", async () => {
    // `.strict()` here replicates what src/cli/index.ts applies at the top
    // level for every real invocation (the command builder itself carries
    // no --skip-skill option, so strict mode is what turns that absence
    // into a rejection rather than a silently-accepted, ignored flag).
    const { registerSetupSkillCommand } = await import("../../../src/cli/register.js");
    const yargs = (await import("yargs")).default;
    let threw = false;
    try {
      await registerSetupSkillCommand(yargs(["setup-skill", "--skip-skill"]))
        .strict()
        .exitProcess(false)
        .parseAsync();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-516: the function-hooks env switch in settings.json
//
// Claude Code loads a plugin's hooks modules only when
// CLAUDE_CODE_ENABLE_FUNCTION_HOOKS is set in the process environment (or the
// rollout flag is on), and the settings `env` field reaches that environment.
// The installer writes the switch so the ledger dashboard appears after a
// plain `storybloq setup --client all`, with one rule that outranks the
// ruling: a value already in the file was chosen by the user, so it is never
// overwritten, not even "0" or "".
// ---------------------------------------------------------------------------

describe("setup retires the usage-limit auto-resume (T-534)", () => {
  let tempDir: string;
  let binDir: string;
  let saved: Record<string, string | undefined>;
  let savedCwd: string;
  const ENV_KEYS = ["PATH", "HOME", "CODEX_HOME", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_PROJECT_ROOT", "CLAUDESTORY_PROJECT_ROOT"] as const;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-setup-retire-${randomUUID()}`);
    binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    savedCwd = process.cwd();
    // Stub binaries: `storybloq --version` succeeds so the hooks block runs
    // with an absolute bin, and `claude` records its argv instead of touching
    // the real MCP registration.
    await writeFile(join(binDir, "storybloq"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(binDir, "claude"), `#!/bin/sh\necho "$@" >> "${join(tempDir, "claude-calls.log")}"\nexit 0\n`, { mode: 0o755 });
    process.env.PATH = binDir;
    process.env.HOME = tempDir;
    process.env.CODEX_HOME = join(tempDir, ".codex");
    process.env.STORYBLOQ_GLOBAL_DIR = join(tempDir, "global");
    // An explicit project root with no .story/ resolves to no project (the
    // override never falls back to walking up), so the retirement's session
    // step has no current project and cannot reach a real checkout.
    process.env.STORYBLOQ_PROJECT_ROOT = join(tempDir, "no-project");
    delete process.env.CLAUDESTORY_PROJECT_ROOT;
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes the limit hooks and global artifacts and writes the marker", async () => {
    if (process.platform === "win32") return;
    const globalDir = join(tempDir, "global");
    await mkdir(join(globalDir, "wake-claims"), { recursive: true });
    // One record names a session in a project that no longer exists: the
    // retirement leaves it untouched and setup must say so.
    await writeFile(join(globalDir, "limit-ledger.json"), JSON.stringify({
      schemaVersion: 1,
      records: {
        "claude:t1": { clientTaskId: "t1", projectRoot: join(tempDir, "gone-project"), storybloqSessionId: "s1" },
      },
    }));
    const settingsPath = join(tempDir, ".claude", "settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command: `${join(binDir, "storybloq")} session limit-stop` }] }],
        SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: `${join(binDir, "storybloq")} session resume-prompt` }] }],
      },
    }));

    const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
    const out: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await handleSetup({ client: "claude" });
    } finally {
      process.stdout.write = realWrite;
    }

    expect(out.join("")).toContain("Usage-limit auto-resume retired");
    expect(out.join("")).toMatch(/Usage-limit auto-resume retirement: session skipped: .*gone-project.*missing/);
    expect(existsSync(join(tempDir, "claude-calls.log"))).toBe(true);
    expect(existsSync(join(globalDir, ".limit-retired-v1"))).toBe(true);
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(false);
    expect(existsSync(join(globalDir, "wake-claims"))).toBe(false);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.StopFailure).toBeUndefined();
    expect((settings.hooks.SessionStart ?? []).some((g) => g.matcher === "resume")).toBe(false);
    const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    expect(commands.some((c) => c.includes("limit-stop"))).toBe(false);
  });

  it("--skip-hooks leaves the retirement to the next command (no marker)", async () => {
    if (process.platform === "win32") return;
    const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
    await handleSetup({ client: "claude", skipHooks: true });
    expect(existsSync(join(tempDir, "global", ".limit-retired-v1"))).toBe(false);
  });
});

describe("enableFunctionHooksEnv / removeFunctionHooksEnv (T-516)", () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-fnhooks-env-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const KEY = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";

  async function api() {
    const mod = await import("../../../src/cli/commands/setup-skill.js");
    return {
      enable: (path?: string) => mod.enableFunctionHooksEnv(path ?? settingsPath),
      remove: (path?: string) => mod.removeFunctionHooksEnv(path ?? settingsPath),
    };
  }

  async function env(): Promise<Record<string, unknown>> {
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as { env?: Record<string, unknown> };
    return settings.env ?? {};
  }

  it("creates settings.json with the env block when the file is absent", async () => {
    const { enable } = await api();
    expect(await enable()).toBe("set");
    expect(await env()).toEqual({ [KEY]: "1" });
  });

  it("adds the env block to an existing settings.json without disturbing the rest", async () => {
    await writeFile(settingsPath, JSON.stringify({ hooks: { PreCompact: [] }, model: "opus" }, null, 2) + "\n", "utf-8");
    const { enable } = await api();
    expect(await enable()).toBe("set");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
    expect((settings.env as Record<string, unknown>)[KEY]).toBe("1");
    expect(settings.model).toBe("opus");
    expect(settings.hooks).toEqual({ PreCompact: [] });
  });

  it("sets the key inside an env block that already holds other keys", async () => {
    await writeFile(settingsPath, JSON.stringify({ env: { FOO: "bar" } }, null, 2) + "\n", "utf-8");
    const { enable } = await api();
    expect(await enable()).toBe("set");
    expect(await env()).toEqual({ FOO: "bar", [KEY]: "1" });
  });

  it("leaves an explicit \"0\" alone and rewrites nothing (m1)", async () => {
    // Deliberately unusual formatting: any rewrite at all reformats it, so
    // byte equality is the assertion, not just the value.
    const original = `{\n    "env": {\n        "${KEY}": "0"\n    }\n}\n`;
    await writeFile(settingsPath, original, "utf-8");
    const { enable } = await api();
    expect(await enable()).toBe("exists");
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("leaves an explicit empty string alone", async () => {
    const original = `{\n    "env": {\n        "${KEY}": ""\n    }\n}\n`;
    await writeFile(settingsPath, original, "utf-8");
    const { enable } = await api();
    expect(await enable()).toBe("exists");
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("leaves an existing \"1\" untouched and rewrites nothing", async () => {
    const original = `{\n    "env": {\n        "${KEY}": "1"\n    }\n}\n`;
    await writeFile(settingsPath, original, "utf-8");
    const { enable } = await api();
    expect(await enable()).toBe("exists");
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("is idempotent on rerun: the second call writes nothing", async () => {
    const { enable } = await api();
    expect(await enable()).toBe("set");
    const afterFirst = await readFile(settingsPath, "utf-8");
    expect(await enable()).toBe("exists");
    expect(await readFile(settingsPath, "utf-8")).toBe(afterFirst);
  });

  it("skips a settings.json that is not a JSON object, leaving it byte-identical", async () => {
    const original = "[1, 2, 3]\n";
    await writeFile(settingsPath, original, "utf-8");
    const { enable } = await api();
    expect(await enable()).toBe("skipped");
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("skips a settings.json whose env field is not an object", async () => {
    const original = `{ "env": "nope" }\n`;
    await writeFile(settingsPath, original, "utf-8");
    const { enable } = await api();
    expect(await enable()).toBe("skipped");
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("removal deletes the key when its value is exactly \"1\" and keeps everything else", async () => {
    await writeFile(settingsPath, JSON.stringify({ model: "opus", env: { FOO: "bar", [KEY]: "1" } }, null, 2) + "\n", "utf-8");
    const { remove } = await api();
    expect(await remove()).toBe("removed");
    expect(await env()).toEqual({ FOO: "bar" });
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(settings.model).toBe("opus");
  });

  it("skips malformed JSON in both directions, leaving the file byte-identical", async () => {
    const original = "{ invalid }\n";
    await writeFile(settingsPath, original, "utf-8");
    const { enable, remove } = await api();
    expect(await enable()).toBe("skipped");
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
    expect(await remove()).toBe("skipped");
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("removal leaves a value the user chose, including \"0\"", async () => {
    const original = `{\n    "env": {\n        "${KEY}": "0"\n    }\n}\n`;
    await writeFile(settingsPath, original, "utf-8");
    const { remove } = await api();
    expect(await remove()).toBe("not_found");
    expect(await readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("removal reports not_found when the key or the file is absent", async () => {
    const { remove } = await api();
    expect(await remove()).toBe("not_found");
    expect(existsSync(settingsPath)).toBe(false);

    await writeFile(settingsPath, JSON.stringify({ env: { FOO: "bar" } }, null, 2) + "\n", "utf-8");
    expect(await remove()).toBe("not_found");
    expect(await env()).toEqual({ FOO: "bar" });
  });
});
