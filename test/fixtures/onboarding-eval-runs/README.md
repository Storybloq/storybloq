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
- `run7-review-command.json`: non-npm-tests run 7 (third batch), the
  agent's reviewer launch: a read-only `codex exec` whose schema comes from
  `3<<'SCHEMA'` and whose prompt comes from `<<'REVIEW_PROMPT'`. The prompt's
  prose carries `count > minimum count+1`, which the parser once split into
  its own command and read as a redirect. Under a quoted delimiter the body
  is data: it must read as no write and as review only.
- `run6-interpreter-heredoc.json`: mixed-stack run 6 (third batch), a
  `python3 - <<'PY'` script that makes its ledger writes through
  `subprocess`. The harness cannot read that script, so it is review, never
  clean, and its writes are not counted: `writesAfterApproval` is a lower
  bound whenever a construct under review carries the writes.
- `run7b-redirect-command.json`: non-npm-tests run 7 (fourth batch), the
  agent's reviewer launch: it writes its schema with `printf ... >` into a
  file from `mktemp /tmp/...`. The counter once read that redirect as a
  project write while the tree check saw nothing. A redirect or `tee` target
  is not resolved, so it is never a counted write: it is review ("file
  redirect, target not resolved"), and the tree check is the truth for
  project files. A redirect into the project before approval fails as
  "project changed before approval", not through the counter, so
  `writesAfterApproval` stays a lower bound. Structural writes (storybloq MCP
  and CLI writes, `git init`) still count. The redirect rule is inverted, not
  enumerated: any `>` on the unquoted skeleton outside a proven-safe form (a
  descriptor duplication or close such as `2>&1`, `>&2-` or `{fd}>&-`, a
  redirection into /dev/null, a process substitution) is a file redirect, so
  any unrecognised redirection reads as one.
- Here-document delimiters (a regression class, not a fixture). Only a
  simple delimiter word is modelled: `[A-Za-z0-9_]+` bare, or wrapped whole
  in one pair of single or double quotes, or behind one backslash. Any other
  word (a backslash or quote inside it such as `"E\\OF"`, mixed quoting such
  as `'E'"OF"`, a continuation such as `EO\` then a newline, `$`, a carriage
  return from a CRLF line) needs the shell's quote removal to find its end.
  It is complex: everything after it is read unblanked, fail-closed, and the
  command is review ("complex here-document delimiter"). Earlier readers
  re-implemented quote removal and failed open three ways: a CRLF delimiter
  that never matched its line, an escaped backslash inside double quotes,
  and a continuation read as quoting. Every simple quoted spelling carries a
  termination proof: a write after its delimiter line still counts.
- `run4-tree-changes.json`: empty-scaffold run 4, the runtime state the
  storybloq server minted under `.story/` before approval.
- `a5-run2-discovery1-stop.json`, `a5-run5-discovery1-stop.json`: attempt 5,
  conflicting-briefs run 2 and existing-partial run 5, discovery-1 endings.
  Each shows the package and asks "approve setup, adjust the plan, or inspect
  ticket/file details?" with a paragraph after it. The third label is
  paraphrased, so neither is clean, and the harness once routed both as
  discovery and answered the package with the discovery rulings ("use your
  judgement"), which the agent took as approval. A semantic stop now routes on
  its last question and everything after it: when that text names "approve
  setup" it is the package, and a new question after a package is not,
  while a selection question right after the labels stays the package when
  it is the paragraph's last question and any comma suffix only cites
  (`STOP_RULE_VERSION` 2026-09-27.16). A suffix is judged by form: "given
  [Node.js](x)" passes as a citation, and the judge still sees it because
  the stop is semantic either way.
- `a5-run6-review-command.json`, `a5-run2-review-command.json`: attempt 5
  reviewer launches with their results. A `codex exec --output-schema` whose
  schema comes from process substitution (`<(...)`) or a here-document
  descriptor fails at runtime inside Codex's shell tool ("Bad file
  descriptor", or an empty schema), not in the harness: the launch is recorded
  as a codex-exec candidate with ok false (run 2). A plain file path is
  credited (run 6). A background agent launch is never credited: its final
  response is not a tool result.
- `a6-run1-review-command.json`: attempt 6, brief-only run 1, the skill's own
  review command with its result: `codex exec ... --output-schema '<schema>'
  - <<'STORYBLOQ_PLAN'`, the plan on stdin. Every `<<` once marked a command
  needs review, so the skill's mandated review failed its own package stop.
  `executionCalls` now exempts exactly this shape: a direct `codex exec` (its
  first word is `codex` by basename: no wrapper, no leading assignment) whose
  sole positional operand, after its options and their values are parsed and
  `--` ends them, is `-`, any unknown option refusing, and every here-document delimiter
  simple and quoted (the body is data), with no other unparsed construct in
  the command. Only the skill's own options count as known: `--output-schema`,
  `-m`/`--model`, `-C`/`--cd`, `-i`/`--image`, `--color`, `-s`/`--sandbox`
  with the value `read-only` only, and the flags `--ephemeral`,
  `--skip-git-repo-check`, `--json`. `-o`/`--output-last-message` (a file
  write), `-c`/`--config` and `-p`/`--profile` (an MCP server subprocess) and
  `--full-auto` (a wider sandbox) are unknown and refuse. An unquoted or complex delimiter, an interpreter or any other
  consumer, a `$(`, `<(` or backtick in the same command keeps the mark, and
  a loop beside it keeps its own. The exemption is this README's record: no
  rule version string changed (fixup 5, checkout head identifies it).
