<!--
  MAINTENANCE: The lens registry, prompt bodies, and merge semantics live in
  the @storybloq/lenses package (single source of truth, ISS-822 Option A).
  The storybloq MCP tools wrap that package; this file documents the manual
  workflow around those tools. When the flow changes, update the stage
  instructions in src/autonomous/stages/*.ts first, then sync this file.
-->

# Multi-Lens Review -- Evaluation Protocol

This file is referenced from SKILL.md for `/story review-lenses` and when reviewing plans or code.

**Skill command name:** When this file references `/story` in user-facing output, use the actual command that invoked you.

## When to Use

- After writing a plan (any mode -- /story plan, native plan mode, manual)
- Before committing code (after implementation, before merge)
- When explicitly invoked via `/story review-lenses`

The autonomous guide invokes lenses automatically during CODE_REVIEW/PLAN_REVIEW stages when `reviewBackends` includes `"lenses"`. This protocol is for manual/standalone use.

## How It Works

The review is backed by the `@storybloq/lenses` package: a 9-lens registry (security, error-handling, clean-code, concurrency as CORE; performance, api-design, test-quality, accessibility, data-safety surface-activated), package-built prompts, and a fully programmatic merger pipeline (evidence anchoring, dedup, blocking policy, tension detection, coverage caps, verdict computation). There is NO merger agent and NO judge agent: after the lens subagents return, everything else is deterministic tool logic.

## When to Combine with Single-Agent Review

Lenses excel at **breadth and static analysis** -- catching duplicated code, missing validation, unused imports, schema gaps, test coverage holes. For **complex state machines, session lifecycles, or multi-file behavioral reasoning** (e.g., "what happens when session resumes after compaction?"), also run a focused single-agent review.

Best workflow: single agent for deep reasoning first, then lenses for breadth/defense-in-depth. The combination is more effective than either alone.

---

## Path A: storybloq MCP Available (Primary)

Use this path when `storybloq_review_lenses_prepare` is available as an MCP tool.

### Step 1: Determine review stage

- If reviewing a **plan** (plan text, implementation design, architecture doc): stage = `PLAN_REVIEW`
- If reviewing **code** (uncommitted diff, PR, implementation): stage = `CODE_REVIEW`

### Step 2: Capture the artifact

- **CODE_REVIEW:** Run `git diff` to capture the current diff. Run `git diff --name-only` for changed file list.
  - **Round 2+:** Use `git diff <commit-at-last-review>..HEAD` to capture only changes since the last review.
- **PLAN_REVIEW:** Read the plan file (from `.story/sessions/<id>/plan.md` or the current plan in context).

### Step 3: Prepare the review

Call `storybloq_review_lenses_prepare` with:
```json
{
  "stage": "CODE_REVIEW",
  "diff": "<full diff text>",
  "changedFiles": ["src/foo.ts", "src/bar.ts"],
  "ticketDescription": "T-XXX: description of the ticket (or 'Manual review -- brief description' if no ticket)",
  "reviewRound": 1,
  "priorDeferrals": []
}
```

For rounds 2+, increment `reviewRound` and pass issueKeys of findings you intentionally deferred:
```json
{
  "reviewRound": 2,
  "priorDeferrals": ["clean-code:src/foo.ts:42:dead-param", "test-quality:::handleStart-untested"]
}
```

The tool returns `lensPrompts` (one per active lens, complete prompts built by @storybloq/lenses) and `metadata` (including `activeLenses`, `skippedLenses`, per-lens `activationReasons`, and the `reviewId`).

### Step 4: Spawn lens agents in parallel

For each lens prompt where `cached: false`, launch a subagent in a **single message with multiple Agent tool calls**:
- **Prompt:** Use the `prompt` string returned by the prepare tool **as-is**. It already contains the full lens instructions with the review artifact (diff or plan) embedded, with secrets redacted. Do NOT append the artifact again -- that duplicates the diff inside the dispatched prompt and re-introduces unredacted content (the separate top-level `artifact` field is returned only for reference, not for re-appending).
- **If `promptTruncated: true`:** The assembled prompt exceeded the size cap, so `prompt` is empty (rare -- the cap is large). Reduce the review scope (review fewer files, or split the diff across smaller `prepare` calls) and re-run, or surface it as an error -- do not dispatch a blank prompt.
- **Model:** The `model` string returned (sonnet or opus)
- **Tools:** Read, Grep, Glob (read-only)

Skip lenses where `cached: true` -- their findings are already available in `cachedFindings`. You will include them in Step 5.

### Step 5: Synthesize (programmatic; no merger agent)

Each lens returns a single JSON object: `{ "status": "ok" | "error" | "skipped", "findings": [...], "error": null, "notes": null }`.

Call `storybloq_review_lenses_synthesize` with one entry per active lens, passing each lens's raw output through unmodified. For cached lenses, echo the cached findings as an `ok` output with `cached: true`:
```json
{
  "lensResults": [
    { "lens": "security", "output": { "status": "ok", "findings": [], "error": null, "notes": null } },
    { "lens": "clean-code", "output": { "status": "ok", "findings": [/* the cachedFindings array from Step 3, verbatim -- package LensFinding objects, not a placeholder string */], "error": null, "notes": null }, "cached": true }
  ],
  "activeLenses": ["security", "error-handling", "clean-code", "concurrency"],
  "skippedLenses": ["performance", "api-design", "test-quality", "accessibility", "data-safety"],
  "reviewRound": 1,
  "reviewId": "lens-xxx",
  "diff": "<full diff text>",
  "changedFiles": ["src/foo.ts", "src/bar.ts"],
  "sessionId": "<the SAME session UUID passed to prepare>"
}
```

Pass the same `sessionId` you gave `prepare`. It is required for the prepare-to-synthesize handoff: synthesize anchors against the redacted artifact prepare persisted (not the raw `diff`), replays the persisted secrets meta-finding, and does cache write-back + telemetry only when it can find that session state. Omit it and anchoring falls back to the raw diff and the secrets gate is lost.

Include ALL active lenses -- both spawned and cached -- otherwise the missing lenses are disclosed as uncovered and a missing CORE lens caps the verdict below approve.

The tool runs the package merger pipeline programmatically (per-lens schema parsing, evidence anchoring against the reviewed artifact, dedup, blocking policy, tension detection, coverage caps, verdict computation) and returns:
- `reviewVerdict` -- the full ReviewVerdict envelope (verdict, findings, tensions, severity counts, `lensCoverage`, `coverage`, `errorCodes`, `deferred`, `parseErrors`, anchoring disclosures)
- `preExistingFindings` / `preExistingCount` -- findings classified pre-existing off the diff scope (harness output). The MCP tool response additionally carries `filedIssues` when it auto-files those as issues.
- `lensesCompleted` / `lensesFailed` / `lensesSkipped`

Auto-filed pre-existing findings stay `open` and carry a deterministic `dedupeKey`, lens attribution in `createdBy`, and a structured `sourceRefs` entry with the review ID. Storybloq hashes the referenced line range and does not persist the lens snippet. Repeating synthesis returns the existing issue instead of filing a duplicate. The implementing agent, not the reviewer, owns later status and resolution changes.

### Step 6: Judge (deterministic; no judge agent)

Call `storybloq_review_lenses_judge` with the `reviewVerdict` from Step 5 (plus `convergenceHistory` on round 2+):
```json
{
  "reviewVerdict": { "<the reviewVerdict object from synthesize>": "..." },
  "convergenceHistory": [
    { "round": 1, "verdict": "revise", "blocking": 3, "important": 7, "newCode": "--" }
  ]
}
```

The mapping is deterministic:
- pipeline `reject` (any blocking finding) -> **reject**
- pipeline `revise` -> **revise**
- pipeline `approve` carrying major findings or partial lens coverage -> **approve with `recommendFixRound: true`**
- otherwise -> **approve**

Convergence history damps repeated majors-only recommendations once rounds stabilize (blocking at 0 for two consecutive rounds, major counts stable or decreasing). Coverage gaps are never damped.

### Step 7: Present output

Format the judge's output using the **Standardized Output Format** below. Report finding severity `blocking` as `critical` in user-facing output and reports.

**Narrate high-severity findings live.** Before (or alongside) the standardized output, surface every `blocking` and `major` finding as a one-line agent-visible narration so the user sees lenses earning their keep in real time, not tomorrow in a handover. Format:

```
-> storybloq · <lens>-lens · <severity> · <file>:<line> · <one-line summary>
```

Examples:
- `-> storybloq · security-lens · critical · auth.ts:47 · hardcoded API key in fallback path`
- `-> storybloq · performance-lens · major · feed.tsx:120 · O(n^2) render in message list`
- `-> storybloq · test-quality-lens · major · user.service.ts:89 · happy-path only, missing error cases`

Show these narrations during the autonomous CODE_REVIEW stage too -- this is the differentiating moment for storybloq (multi-AI review catching things single-AI misses) and it's wasted if the findings only surface after the commit lands. Lower-severity findings (`minor`, `suggestion`) roll up into the standardized output; don't narrate those individually.

---

## Path B: storybloq MCP Unavailable (Fallback)

The lens prompt bodies and merge semantics live exclusively in the `@storybloq/lenses` package -- there are no local prompt copies to fall back on. When the storybloq MCP tools are unavailable:

1. **Preferred:** register the standalone lenses MCP server and use its native two-hop protocol:
   ```sh
   npm install -g @storybloq/lenses
   claude mcp add lenses -s user -- lenses --mcp
   ```
   Then drive the review with `lens_review_start` -> spawn agents from `lens_review_get_prompt` -> `lens_review_complete` (see the package README for the envelope semantics).
2. **Otherwise:** tell the user to install the storybloq MCP server (`storybloq setup --client all`) and fall back to a single-agent review for this round.

---

## Error Handling

- **Lens returns malformed output:** Pass it through anyway -- synthesize records it in `parseErrors[]` and coverage marks the lens `parse_failed`.
- **Lens agent fails or times out:** Omit it from `lensResults` -- coverage marks it uncovered; a missing CORE lens (security, error-handling, clean-code, concurrency) caps the verdict below approve.
- **Judge tool errors on the payload:** Re-pass the exact `reviewVerdict` object from synthesize without edits; hand-built verdict objects fail schema validation.

---

## Acknowledged Deferrals

After each round, classify findings you received:
- **"I'll fix this"** -> fixed (verify next round)
- **"Out of scope / architectural"** -> deferred (pass issueKey to `priorDeferrals` next round, file as issue)
- **"I disagree"** -> contested (pass to `priorDeferrals`, adds to knownFalsePositives)

This prevents the same findings from being re-reported across rounds.

---

## Standardized Output Format

Every lens review produces this structure, regardless of invocation path:

```markdown
## Multi-Lens Review

**Verdict: APPROVE | REVISE | REJECT** (recommend fix round: yes/no)
_One sentence explaining what drove the verdict._

**Lenses:** security, error-handling, clean-code, concurrency, test-quality (5 ran, 4 skipped)
**Coverage:** full | partial (list uncovered lenses)
**Round:** R3 | **Recommend next round:** No -- blocking at 0 for 2 rounds, important stable

### Blocking Findings

1. **[severity] description** (lenses, confidence)
   File: `path/to/file.ts:42` | Origin: introduced
   Evidence: `snippet quote`
   Fix: actionable recommendation

### Non-Blocking Findings

| # | Severity | Lenses | File | Finding | Confidence | Origin |
|---|----------|--------|------|---------|------------|--------|
| 3 | minor | clean-code | src/foo.ts:15 | Function exceeds 80 lines | 0.92 | introduced |

### Pre-Existing Issues Discovered

_Found in surrounding code, not introduced by this diff. Filed as issues, excluded from verdict._

| # | Severity | File | Finding | Filed As |
|---|----------|------|---------|----------|
| P1 | high | src/stages/plan.ts:42 | Unguarded loadProject | ISS-089 |

### Tensions

| Lens A | Lens B | Category | Tradeoff |
|--------|--------|----------|----------|
| security | performance | validation | Security wants validation; performance flags overhead |

### Deferred / Suppressed

_Findings the pipeline dropped (below confidence floor, evidence unverified) or retained at adjusted severity, from `reviewVerdict.deferred`._

### Convergence

| Round | Verdict | Blocking | Important | New Code |
|-------|---------|----------|-----------|----------|
| R1 | revise | 5 | 9 | -- |
| R2 | approve | 0 | 3 | 1 file, 12 lines |

### JSON Summary

{ "verdict": "approve", "recommendFixRound": false, "blocking": 0, "major": 3, "preExisting": 1, "coverage": "full" }
```

### Verdict Rules (computed by the pipeline; do not override)

- **APPROVE** -- No blocking findings and no majors forcing revise. "Approve with findings" is valid; `recommendFixRound` carries the pressure instead of an inflated verdict.
- **REVISE** -- The pipeline found majors (or capped an approve: retries pending, uncovered CORE lens, interim envelope).
- **REJECT** -- At least one blocking finding survived the pipeline (alwaysBlock categories, corroborated blocking severity).
- **Pre-existing findings** are excluded from filing pressure but still appear in the verdict findings; they are auto-filed as issues by synthesize.
- Severity vocabulary: the package uses `blocking | major | minor | suggestion`. Report `blocking` as `critical` in user-facing output.
