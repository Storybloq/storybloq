# Triage Mode

This file is referenced from SKILL.md for `/story triage` (`$story triage` on Codex). It instructs the session to run a **read-only triage pass** over the open issue backlog: verify every finding against the current repository, identify already-fixed and duplicate issues, group issues that share one root cause, and produce a prioritized recommendations report the maintainer can act on.

## The contract: report, never write

This workflow mutates no issue, no ticket, no severity, and creates nothing. The classifications and recommendations defined below are OUTPUT VOCABULARY for the report, never values to write into the ledger. Evidence only -- the maintainer closes, files, and reprioritizes; never this workflow. Do not call any `storybloq_*` create/update/delete tool or any `storybloq ... create/update/delete` CLI command during triage.

Two precise qualifications:

- Ordinary Storybloq reads may recover an incomplete transaction journal under lock. That is the loader's own behavior, not a write this workflow performs.
- After the report is presented, this workflow may offer ONE optional persistence step: on explicit user confirmation, run `storybloq snapshot` and then `storybloq_handover_create` to save the report as a handover (snapshot first -- the parent skill requires it before a handover). Disclose both writes in the offer. Never any other write.

Epistemics: backlogs rot. An issue's text is a CLAIM made at discovery time; the repository at the pinned HEAD is the source of truth. Verify every claim before classifying it.

## Step 1: Pin the snapshot

1. Record `git rev-parse HEAD` and the current date. Every verified fact in the report carries a provenance label: `@ <sha>` when the evidence was read at the recorded HEAD, `@ worktree` otherwise.
2. Run `git status --porcelain`. If the worktree is dirty, verify through `git show <sha>:<path>` so evidence stays pinned to HEAD. Where a working-tree read is unavoidable, label that evidence `@ worktree` everywhere it appears -- never `@ <sha>` -- and set `dirtyWorktree: true`; a fix present only in the working tree never supports ALREADY_FIXED or CLOSE_FIXED, because the maintainer would close an issue against a commit that does not contain the fix.
3. If the repository has no HEAD yet (unborn branch), say so in the report, verify against the working tree throughout with `@ worktree` labels, and report `"head": null` in the JSON summary -- this matches how Storybloq's own source-reference validation falls back.

## Step 2: Gather validate FIRST and branch on its payload

Run `storybloq validate --format json` via Bash. Parse stdout regardless of exit code -- a non-zero exit means findings with error level exist, and warning-only runs exit zero; neither is a command failure.

Every Storybloq JSON response is an envelope holding either a `data` key or an `error` key. Branch on which key is present; on an `error` envelope from ANY gather command, disclose the failed surface in the report and never read `data` from it.

The validate payload has two possible shapes. Discriminate explicitly: a ledger integrity result carries `criticalErrorCount` and `itemErrorCount`; a validation result carries `findings` with `warningCount`.

| Payload | Meaning | What to do |
|---|---|---|
| Integrity result, `criticalErrorCount > 0` | `config.json` or `roadmap.json` is missing or invalid; project loading fails, so issue and ticket lists are unavailable | Produce an integrity-only PARTIAL report: name each affected file from the integrity `findings`, state that no issue classification is possible until the maintainer repairs the ledger, and stop after reporting |
| Integrity result, `criticalErrorCount == 0` | Item and/or auxiliary files are malformed; the rest of the ledger loads | Branch on the remaining counters: files behind `itemErrorCount` are dropped ticket/issue/note/lesson records -- name each, count them in `droppedFileCount`, and triage the loadable records. Auxiliary-only findings (for example a malformed root `status.json`) are ledger notes, never dropped items and never counted in `droppedFileCount`. Either way, disclose that source-reference validation, orphan detection, and dedupe-key signals did NOT run; mark the report partial |
| Validation result | Integrity passed; full findings available | Proceed fully |

## Step 3: Gather the ledgers

Run these via Bash, parsing stdout regardless of exit code (list commands can emit complete data and still exit with a partial status when integrity warnings exist):

1. `storybloq issue list --format json` -- UNFILTERED. Record the capture timestamp. Partition `data` into open / inprogress / resolved. Classify only the open issues; report the in-progress and resolved counts as context. Never rely on a `--status` filter to derive the other counts.
2. `storybloq ticket list --format json` -- full ticket objects for related-ticket resolution and scope reading.
3. Optionally `storybloq recommend --format json` -- treat it strictly as a weak comparison signal on ordering (see Step 9); it does not validate classifications or groups.

MCP fallback, only when the CLI is unavailable: `storybloq_issue_list` (unfiltered enumerate) plus `storybloq_issue_get` per issue for detail; `storybloq_ticket_list` plus `storybloq_ticket_get` for each related ticket; `storybloq_validate` with `{"format": "json"}`. The MCP list output is markdown without source references, which is why the per-item get calls are required.

## Step 4: Correlate findings to issues

Validation findings do not share one identifier convention, and display ids can collide. Correlate carefully:

1. Build alias indexes for BOTH issues and tickets, mapping each alias to the SET of records that carry it, over three fields: canonical `id`, `displayId`, and every entry of `previousDisplayIds`. These are multimaps -- duplicate display ids are possible, and Storybloq's own resolver treats an alias as resolvable only when exactly one record matches.
2. A finding's `entity`, or a `relatedTickets` entry, correlates only on a UNIQUE match in the index. Zero matches or multiple matches: route that finding or ticket reference to NEEDS_INVESTIGATION rather than guessing -- attaching evidence or ticket scope to the wrong record is worse than admitting ambiguity.
3. Source-reference findings (`source_ref_*` codes) carry the issue's display id; orphan and related-ticket findings carry the canonical issue id. The alias index absorbs the difference.
4. `duplicate_issue_dedupe_key` findings carry no entity. Do not parse the finding message -- compute dedupe-key groups directly from the issue objects already in hand (group open issues by identical `dedupeKey`).
5. Files the loader dropped are invisible in `issue list`. Name each one in the report under Needs Investigation, sourced from validate: the schema/parse warnings in the normal branch, or the integrity `findings` in the item-error branch.

## Step 5: Verify each finding against the pinned HEAD

For each open issue, use the correlated `source_ref_*` findings as the starting signal, then apply judgment:

| Signal | Default reading |
|---|---|
| `source_ref_changed_at_head` / `source_ref_missing_at_head` | The referenced bytes changed or vanished. That is ALL it proves. Default to re-verify, NOT to already-fixed: read the current code and the file history (`git log --oneline -- <path>`) and decide what actually happened |
| `source_ref_moved_at_head` | The code moved within the file; the claim is likely intact at the new range. Re-verify at the relocated lines |
| `source_ref_ambiguous_at_head`, `source_ref_original_unverifiable`, `source_ref_original_unresolvable`, `source_ref_original_mismatch`, `source_ref_revision_unavailable` | NEEDS_INVESTIGATION unless a manual read settles it -- the original snapshot cannot be resolved or fails its recorded hash, so neither the claim nor its fix can be inferred from the reference alone |
| No findings (intact references) | Proves only that those bytes survived. The described problem may still be real, already mitigated elsewhere, or misdiagnosed -- read the referenced code and judge the behavior |

Evidence bar for ALREADY_FIXED: current behavioral evidence (read the code at the pinned HEAD and confirm the described problem cannot occur) PLUS corroborating history (a commit or a related ticket whose scope actually covered this defect). Changed bytes alone never clear this bar.

Issues WITHOUT source references are common, and the hash machinery's silence about them means nothing. Locate the code manually through the issue's `location` entries, `components`, and by searching for the symbols named in `impact`. If the code cannot be located, classify NEEDS_INVESTIGATION -- never VALID.

## Step 6: Classify

Every classified open issue gets exactly one classification:

| Classification | Meaning |
|---|---|
| VALID | The described problem is confirmed present at the pinned HEAD |
| ALREADY_FIXED | The evidence bar in Step 5 is met: behavior verified plus corroborating history |
| DUPLICATE | Points at the same defect as a specific other open issue. Name the canonical issue; prefer the older or better-evidenced one as canonical |
| SUPERSEDED | The code or design it describes no longer exists, or a newer issue subsumes it entirely |
| NEEDS_INVESTIGATION | Cannot be settled with the evidence gathered: unlocatable code, ambiguous alias, dropped file, or unresolved verification |
| NOT_WORTH_FIXING | Real but the cost exceeds the impact -- say why |

Duplicate detection: a shared `dedupeKey` between two active issues is a high-confidence duplicate CANDIDATE and simultaneously a ledger-integrity problem to report (Storybloq treats it as an error state) -- corroborate the semantic match before classifying DUPLICATE; the key alone is not proof. Beyond keys, compare titles, `impact` prose, overlapping source-reference paths, and `components` -- judgment, not string equality.

## Step 7: Root-cause groups, severity, effort

A root-cause group is a set of VALID issues that one change would fix together. The bar is strict: a VERIFIED shared mechanism -- the same defect demonstrated in each member at the pinned HEAD -- plus ONE bounded change and test plan that plausibly fixes every member. Same file or module, or similar `impact` prose, is NOT sufficient on its own. Prefer recommending ONE ticket per verified group over one ticket per issue.

Severity: reassess against today's codebase -- the recorded severity reflects discovery time. Report it as `recorded -> reassessed` and never edit the issue.

Effort: estimate the FIX (group-level for grouped issues) as XS / S / M / L, matching the orchestrator SIZING convention. This is report vocabulary only; issues and tickets have no effort field.

## Step 8: Map to existing tickets

`relatedTickets` on an issue is an ASSOCIATION, not fix ownership. Before recommending that an issue be folded into an existing ticket:

1. Resolve each related ticket through the ticket alias index (unique match only).
2. Read the ticket's description and scope. Recommend `FIX_WITH_T-xxx` only when the fix genuinely belongs in that ticket's scope -- an open related ticket is not automatically the vehicle.
3. A complete related ticket did not necessarily attempt this fix. If the issue still reproduces beside a complete related ticket, say so explicitly; if the complete ticket's scope did cover the defect, that is corroborating history for ALREADY_FIXED.

`orphan_issue` findings enumerate open issues with no related ticket -- the ticket-creation candidates. When validation did not run (item-error branch), compute the same set directly: open issues whose `relatedTickets` is empty.

## Step 9: Consistency recheck, then recommend

Before writing the report:

1. Re-run `git rev-parse HEAD`. If it moved since Step 1, mark the report stale (or restart when the drift is substantial) and state what changed.
2. Re-run `storybloq issue list --format json` and `storybloq ticket list --format json` and compare the relevant `data` semantically against the Step 3 capture. Ledgers can change without HEAD moving -- another task can write the project's issue or ticket files at any time. On drift, restart or mark the report stale, naming the records that changed.

Then assign each classified issue exactly one recommendation:

| Recommendation | Meaning |
|---|---|
| FIX_NOW | Valid, high impact; belongs at the top of the backlog |
| FIX_SOON | Valid, should be scheduled in the near term |
| BACKLOG | Valid but can wait |
| FIX_WITH_T-xxx | Fold into the named existing ticket (scope verified in Step 8) |
| CLOSE_FIXED | Evidence supports already-fixed; the maintainer closes, never this workflow |
| CLOSE_DUPLICATE_OF_ISS-xxx | Duplicate of the named canonical issue; the maintainer closes |
| CLOSE_SUPERSEDED | Superseded; the maintainer closes |
| INVESTIGATE_FIRST | Needs investigation before any other action |
| WONT_FIX | Recommend not fixing, with the reasoning |

Urgency and vehicle are separate axes: pair a vehicle (`FIX_WITH_T-xxx`, or a proposed NEW ticket) with an urgency tag when both apply -- for example `FIX_WITH_T-050 (FIX_NOW)` or `NEW ticket (BACKLOG)` -- and when an issue is deliberately split across two tickets, name both vehicles.

Cross-check the suggested implementation order against `storybloq recommend` as a WEAK signal on sequencing only -- it knows severity and phase ordering, not your verified groups. Note disagreements in the report rather than silently overriding either source.

## Step 10: The report

Produce the report inline, in this pinned structure:

```markdown
## Issue Triage Report

**Scanned:** N open issues @ <sha | worktree> (<date>, captured <time>) | In progress: I | Resolved: R
**Disclosures:** <dirty worktree / partial run / stale ledger / none>
**Summary verdict:** <one sentence: overall backlog health and the single most important action>

### Recommended Tickets (verified root-cause groups first)
| # | Proposed ticket | Covers | Severity | Effort | Order rationale |
|---|-----------------|--------|----------|--------|-----------------|

### Per-Issue Classification
| ID | Title | Classification | Evidence (with `@ <sha>` / `@ worktree` provenance) | Recommendation | Effort | Related |
|----|-------|----------------|-----------------------------------------------------|----------------|--------|---------|

### Close Candidates
Evidence only -- the maintainer closes, never this workflow.
| ID | Recommendation | Evidence |
|----|----------------|----------|

### Needs Investigation
<one line each, including loader-dropped files and unresolvable aliases>

### Suggested Implementation Order
1. <step, with dependency/risk rationale; note any disagreement with storybloq recommend>

### JSON Summary
{ "loadedOpen": N, "valid": V, "alreadyFixed": A, "duplicates": D, "superseded": S,
  "needsInvestigation": Q, "notWorthFixing": W, "unclassified": U,
  "droppedFileCount": F, "recommendedTickets": T,
  "head": "<sha, or null on an unborn branch>", "captureTime": "<iso>",
  "dirtyWorktree": false, "partialRun": false, "staleLedger": false }
```

Pinned invariants for the JSON summary: the classification counts plus `unclassified` sum exactly to `loadedOpen` (`valid + alreadyFixed + duplicates + superseded + needsInvestigation + notWorthFixing + unclassified == loadedOpen`). `droppedFileCount` stays separate -- dropped files never loaded, so they are not part of `loadedOpen`.

Additional clearly-labeled sections (for example `### Ledger Notes` for hygiene observations that are neither investigation nor classification) may be inserted after Needs Investigation; never replace, rename, or reorder the pinned sections.

## Edge cases

- **Zero open issues:** produce a short report saying so, plus any integrity findings and context counts. No empty tables.
- **Very large backlogs:** triage in severity-ordered batches (critical first). Count every open issue you did not reach in `unclassified` and say the report is partial.
- **In-progress issues:** counted in the header, never classified -- someone is already on them.
- **Integrity-only runs** (critical ledger errors): the report is the integrity section plus repair guidance (`storybloq validate --integrity-only`, `storybloq repair --dry-run`); classification resumes after the maintainer repairs the ledger.

## Saving the report (the one optional write)

After presenting the report, offer once: "Save this triage report as a handover? This writes a snapshot first, then a handover file -- no issue or ticket is touched." Only on explicit confirmation, run `storybloq snapshot`, then call `storybloq_handover_create` with the full report and a descriptive slug such as `issue-triage-<date>`. If the user declines or does not answer, write nothing.
