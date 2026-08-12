# Authoring rules for agent-facing text

Scope: everything storybloq injects into an agent's context. Skill files under `src/skill/`, tool descriptions and zod `.describe()` strings in `src/mcp/tools.ts`, stage instruction strings under `src/autonomous/stages/`, hook output, CLI messages agents parse. Every token here is paid by a user, in every session, before any work happens.

## The delete test

For each sentence: does it change model behavior versus the default? If not, delete the whole sentence. Do not trim words from a sentence that fails the test; the sentence is the unit.

The test is model-relative, so a disagreement about whether a line is dead is settled by running the document, not by argument: exercise the behavior the line claims to govern, with and without it, and keep the line only if behavior differs.

## Rules over reasons

An agent needs the rule. It rarely needs the why. When a paragraph explains a rule's history or justification, keep the rule, cut the narrative, and leave the provenance as a bare pointer (an issue id in parentheses). A reader who needs the why follows the pointer; every other reader stops paying for it.

Incident-driven additions are the main growth pressure: each misread tends to add a defensive paragraph explaining what a reader must not conclude. State what to do instead, once. If a new guard sentence cannot name the behavior it changes, it fails the delete test on arrival.

## Structure beats prose

A matrix of cases renders as a table, not as paragraphs walking each case. Repeated qualifiers ("only when", "except if") signal a table trying to be prose.

## Single source of truth

State each rule once, in the file that owns it, and point to it from everywhere else. When the environment already enforces something (a schema rejects it, a gate blocks it, a tool refuses it), the text describing that enforcement is a candidate deletion: the environment is the source of truth.

## Sediment and no-ops

Sediment: text that was load-bearing under an old design and survived the redesign. When code makes prose obsolete, deleting the prose is part of the change, not a cleanup for later.

No-ops: instructions the model already follows without being told ("be careful", "read the file first", restating a tool's own description). Delete on sight.

## Budgets

The always-loaded entry file is the most expensive surface in the product; hold it near 12k tokens. Mode files load per invocation of that mode; hold each near 10k. Tool descriptions and schema field descriptions are paid on clients that load schemas upfront; a field description that restates the field name fails the delete test.

Measure before and after any substantial edit (`wc -c` / 4 approximates tokens) and record both numbers in the ledger item that owns the change.

## Removal condition

Text added to prevent a specific failure states, or traces via its pointer to, the failure it prevents. When that failure becomes impossible (the seam closed, the tool now enforces it), the text goes.
