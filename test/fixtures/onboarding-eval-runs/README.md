Verbatim inputs from the 2026-09-27 Codex eval batch (T-536), kept as
regressions for the harness defects that batch exposed:

- `run1-command.json`: brief-only run 1, the agent's reviewer launch. It
  mentions `git init` inside the prompt text and runs `codex exec` through
  `zsh -lc` with a process substitution. It must read as no write and as
  exactly one construct to review.
- `run1-stop.json`, `run2-stop.json`: the terminal messages of runs 1 and 2.
  Each ends with a paragraph after its question that cites a source but
  carries other words too, so neither strips: both are semantic stops that
  route on their candidate (run 1 package, run 2 discovery) and go to the
  judge. Run 1 names the package options in lowercase bold.

Discovery stops are judge-graded by design: any ending with a question mark
that does not carry the package options is semantic with candidate discovery,
never clean from the harness alone, because no closed form separates a
question that only asks from one that also assumes, answers or acts. Only the
package keeps a closed rule, in exactly two shapes: the closing paragraph is the
option list (at most one prefix line, the skill's package question verbatim or
a listed selection question, then exactly the three option lines, nothing
else), or it is exactly one of the listed selection questions. A closing
paragraph that names an option in prose is semantic.
A pending structured question with any result text before it is semantic
too: that prose is never validated, so the judge rules on it.
- `run3-review-command.json`: empty-idea run 3 (second batch), the agent's
  reviewer launch: `codex exec` with the schema on `/dev/stdin` from a
  heredoc and the plan as a quoted prompt. The heredoc makes the command
  unparsed, and the textual fallback once read the quoted prompt; it must
  read as no write and as review only.
- `run5-probe-command.json`: existing-partial run 5 (second batch), three
  storybloq `--help`/`--version` probes. It must read as no write.

The write classifier reads quoted text the shell runs as code (a nested
shell's `-c` string, eval's operands, a `$(...)` or backtick span inside
double quotes) and every other quoted operand as data. Past nesting depth 3
it reads the text unblanked, which fails closed: a quoted prompt that deep
counts as a write (`WRITE_RULE_VERSION`, named in the packet as
`harnessNormalisation.write`).
- `run4-tree-changes.json`: empty-scaffold run 4, the runtime state the
  storybloq server minted under `.story/` before approval.
