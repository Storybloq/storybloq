# Review contract

Verification backends read this file: they receive it alongside the diff and are asked to name the principle a finding violates. Ordinary coding sessions do not read it.

A finding names the principle it violates. Name it and judge severity independently: the class governs blocking only, and it never lowers what you reported. A `blocking` class ADDS blocking to a finding already at critical or major severity. `major` and `suggestion` add nothing and leave your own decision untouched, so a finding the reviewer blocked on still blocks. `correctness` is a seventh value a finding may name and it blocks like security; it is the floor beneath the six, not one of them. Once capping is enabled, a finding inside this contract that names no principle is capped at suggestion.

## Outside this contract

accessibility, performance, data-safety

## Coherence

The change fits the design it lands in: one concept has one home, and new code follows the boundaries and data flow the project already has.

Violations: a second copy of an existing abstraction; logic placed in a layer the project keeps it out of; a reverse dependency between modules; a suggested ruling that applies and is not cited.

Blocking: major

## Uniformity

Same things look the same: naming, error shapes, file layout, and interfaces match the project's existing patterns.

Violations: a new naming scheme beside the existing one; an error returned where the project throws; a hand-rolled utility where a shared one exists.

Blocking: major

## Maintainability

The next reader can change it safely: intent is stated where it is not obvious, and the change is no larger or more coupled than its job requires.

Violations: a load-bearing decision with no recorded reason; a function that needs the whole file read to be changed; dead or duplicated paths left behind.

Blocking: major

## Robustness

The code behaves under the inputs and failures it will actually meet: bounds, absence, concurrency, partial failure, restart.

Violations: an unbounded read or loop; an absent value treated as zero; a write with no durability barrier where one is expected; a resource not released on the failure path.

Blocking: blocking

## Security

No new way for untrusted input or a less trusted party to act with more authority than intended.

Violations: unvalidated external input reaching a command, query, path, or privileged call; secrets or credentials in code or logs; a permission or sandbox setting widened without an explicit decision.

Blocking: blocking

## Quality

The change is verified to do what it claims: tests exist for the behaviour, they fail without the change, and the claim in the description matches what shipped.

Violations: a test that passes with the change removed; a green suite over code that is never executed; a description that names work the diff does not contain; a grep transcript in EXISTING.

Blocking: major

## Notes on this file

Ordering is load-bearing. The lens backend receives only the first 3000 characters of this file, head-truncated, so the six principles stay above anything this project adds. A principle pushed below that line is one a lens reviewer is asked to name without ever being shown it.

The "Outside this contract" line is read literally. Every line under that heading is split on commas and newlines into entries, trailing punctuation is stripped, and a `- ` bullet prefix is NOT stripped, so a bulleted entry matches nothing and prose written there becomes junk entries. One plain comma-separated line, or nothing at all. Entries are matched against a finding's category and, for a merged lens finding, against every contributing lens id.

A finding outside the contract is never capped and keeps the severity its reviewer gave it. Outside is therefore the LOUD side: the shorter the line, the more this contract covers and the more it quiets. An empty line is the widest coverage and the quietest gate, which is why `storybloq validate` warns about one. Silencing a category is a different mechanism and lives in `.story/config.json` under `recipeOverrides.blockingPolicy.neverBlock`.

The Outside line ships with three lens ids on it because the six principles above genuinely say nothing
about those subjects, and a finding is better passed through on its reviewer's judgement than capped for
naming no principle. Remove an entry to bring that subject under the contract; add one, as a category
string or a lens id, to take a subject out. Do not use this line to silence a category: a finding outside
the contract keeps the severity its reviewer gave it, which is louder, not quieter. Silencing lives in
`.story/config.json` under `recipeOverrides.blockingPolicy.neverBlock`.
