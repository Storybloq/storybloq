# Continuity fixture (T-525)

The release gate for 1.16.0 asks one question: does a fresh session find the existing implementation and the applicable decision, respect them or justify a change, and leave the map accurate? This directory is the project that question is asked on, the rubric it is scored with, and the recorded baseline it is compared against.

## Layout

```
core/                 the project every arm runs: a small Node service (AppLogger, router, handler, JobQueue)
                      with its own .story/ (rulings R1 R2 R3 R5, notes N-1 N-2, tickets T-1..T-4, one handover)
overlays/arm3/        catalogs (.story/capabilities.json, .story/glossary.json); lands with T-523 and T-524
overlays/lifecycle/   R4, a PROPOSED ruling against R1, for the deterministic suite only; lands with T-522
variants/             T-2 as three {title, description} overrides: (a) names src/jobs/, (b) names no path,
                      (c) no "logging" keyword ("Make failed background jobs traceable to the originating request")
facts.json            every behavioural fact and the file that carries it per arm (P-1 equivalence)
fixture-map.json      label -> id for rulings, tickets, notes
rubric.md             the frozen scoring rubric (rubricVersion 1)
baseline/             the recorded arm-1 baseline (sanitised artefacts; raw transcripts live in the private
                      workspace at eval-runs/continuity/)
```

The core has no nested `.git`; the runner and the suite initialise a temporary repository per run.

## Arms (F-A)

| Arm | Workflow | Ledger |
|---|---|---|
| 1 | storybloq 1.15.9, before any 1.16.0 change (the baseline) | core |
| 2 | revised workflow, ordinary notes and rulings only | core |
| 3 | revised workflow with the catalogs | core + overlays/arm3 |

Every fact exists in every arm (`facts.json`); arm 3 adds structure, never facts. R4 is not part of any behavioural arm.

## Running

Fresh isolation is the only mode (ISS-1486) and the default; the owner mints the token with `claude setup-token`.
Each arm needs its pilot first (see "The pilot" below); an ordinary run without a verified pilot spawns nothing and exits 7:

```
export CLAUDE_CODE_OAUTH_TOKEN=...
npx tsx scripts/continuity-run.ts --pilot --arm 1 --model claude-opus-5 --effort high \
  --out test/fixtures/continuity/baseline --raw-out ../eval-runs/continuity
npx tsx scripts/continuity-run.ts --arm 1 --model claude-opus-5 --effort high \
  --out test/fixtures/continuity/baseline --raw-out ../eval-runs/continuity
```

`--isolation shared` and `--owner-exception` are refused, at the command line and again at every entry point.
Tasks and repeats default to the whole preregistered matrix (5 tasks x 3). `--tasks` and `--repeats` select a
smaller LIVE run that still launches real sessions and incurs model usage; a proper subset of the matrix never
qualifies.

Scoring is three steps, because the scorer is Codex reached through the pen's bridge session, not by a script:

```
npx tsx scripts/continuity-score.ts prepare <expDir>                 # scoring-request.rubric<v>.md per valid attempt; behavioural failures are scored mechanically
npx tsx scripts/continuity-score.ts record  <attemptDir> '<json>'    # one Codex verdict, validated and publication-checked, never overwriting
npx tsx scripts/continuity-score.ts report  <expDir>                 # results-<date>-<cli>-rubric<v>.md over the preregistered cells
```

Preflight refuses to start when: an alternate-auth env var is set; the input tree (`src/`, `plugins/`, `scripts/`, package files, this fixture) has uncommitted changes; `vitest` or `jest` is running; `CLAUDE_CODE_OAUTH_TOKEN` is absent; `codex` is not on PATH (the tool server runs inside its sandbox). It then builds `dist/` and the evaluation bundle `.eval-dist/eval-mcp.js` itself and records the hashes; a missing bundle, or one that is not the recorded one at a launch, is refused with a message that says to rebuild it and rerun preflight.

An attempt is `invalid` (kept, listed, never scored) when the server fingerprint recorded in the session does not match the built `dist/mcp.js`, when the ISS-906 stale-server sentence appears, when the main-session model is not the pinned one, when the build or the effective configuration changed under the run, or when the session was interrupted by the runner. A valid attempt that did not complete its ticket is a behavioural failure: it counts, and it fails every criterion.

The experiment QUALIFIES when each of the 15 cells (5 tasks x 3 repeats) has one valid observation and the arm's pilot verifies; only then is `QUALIFYING` written and the results file citable as the release baseline. A `shared`-isolation experiment never qualifies.

## The launch (ISS-1486)

Every attempt and the pilot launch Claude through the shared launch policy (`scripts/headless-policy.ts`), never with a permission bypass:

- The client runs in `dontAsk` mode with a policy file (mode 0400) and an MCP file (mode 0600), both written once per launch outside the writable roots, and checked again immediately before the spawn. The writable roots are the attempt's work folder and its temp folder, each canonical (a temp folder reached through a link is resolved first).
- This runner's options: the onboarding tools plus `Agent`; `Read`, `Glob`, `Grep`, `Bash`, `Skill` and `Agent` allowed; `WebFetch`, `WebSearch` and `Task` denied; `--effort` and `--no-session-persistence` as extras. The storybloq tools are pinned in `scripts/continuity-tools.json`, checked by a test against the built `dist/mcp.js`: the pinned list is what the server advertises less the onboarding inventory's withheld map (`scripts/onboarding-eval-tools.json`), the single source. A list naming a withheld tool is refused before any launch.
- The tool server starts through the onboarding launcher (mode 0500, outside the roots): `codex sandbox` with the work folder, its `.git` and the temp folder as writable roots, running the evaluation bundle with `--entry mcp`, with only the server column in its environment (PATH, HOME, TMPDIR, LANG, CODEX_HOME, STORYBLOQ_PROJECT_ROOT, STORYBLOQ_GLOBAL_DIR and the three evaluation variables). A tools file per launch (mode 0400, outside the roots) names the permitted list for both the degraded and the full set, so the server registers nothing else; the readback compares the registered set with the list. The OAuth token never reaches the server. The launcher, the tools file and the bundle are checked again before the spawn.
- The environment is built from a table (PATH, HOME, TMPDIR, CLAUDE_CONFIG_DIR, STORYBLOQ_PROJECT_ROOT, STORYBLOQ_GLOBAL_DIR under the temp folder, and the OAuth token and locale when set), never copied. The MCP entry pins the project root as well, so the tool server works on the attempt's project and nothing else (the D3 boundary): a `STORYBLOQ_PROJECT_ROOT` or `CLAUDESTORY_PROJECT_ROOT` in the runner's own environment never reaches it.
- Before the prompt, the runner reads the client's state back over stdin (six requests) and compares it with what the launch expects. The prompt is sent only after a clean readback, as one user message on stdin; it is never on the command line.
- A wrong readback answer, a wrong init event, a tampered launch file, or a denial of a tool the task needs is `launch-policy`: the attempt is invalid, consumes no retry, and the matrix stops (exit 7). A child that ends before its prompt is delivered is `input-failure`: invalid, counted toward the retry budget, and the matrix goes on. A timeout, a kill or an operator signal keeps its own class.
- Each attempt publishes `readback.json` and `launch.json` (the exchange and what it was compared against; environment names only, never values), under one path mapping per launch so a mismatch survives publication. Both are required artefacts.
- A fresh config folder holds no plugin inventory. Any inventory file that appears is configuration drift, and the drift message names the file.

A gate rerun repeats every arm: a record made under an older launch (no `launchPolicy: 2` in its hash input) never satisfies a cell.

## The pilot

`--pilot` runs the same launch with a challenge prompt instead of a ticket: one subagent makes five probes (a write inside the work folder, a write outside the roots through Bash, an edit outside the roots, an edit inside, and a connection to a loopback listener the runner holds). It is judged only from evidence the runner holds: the transcript, the files, a canary outside the roots, and the listener (checked by the runner's own control connection). It writes `pilot.json` with `pilot.transcript.jsonl`, `pilot.readback.json` and `pilot.launch.json` beside `experiment.json`. The pilot needs the owner's token and the owner's word; it is not part of any test.

The first live pilot must also settle these, which no model-free test can:

- Whether the real client echoes the server's environment in `mcp_status`. Until a pilot shows it does, a missing echo fails the readback closed (launch-policy), never skipped.
- Whether a logged-in client writes `plugins/installed_plugins.json` or `plugins/known_marketplaces.json` into the fresh config folder during a turn. If it does, every live attempt would drift; the drift message names the file that appeared, so one pilot run shows it.

## Publication rule

Everything under `storybloq/` is projected to the public repository. Only sanitised artefacts (plans, diffs, ledger changes, evidence with paths and identities substituted, scores, manifests) are written here; raw transcripts, stderr and ledger snapshots go to `--raw-out`. The sanitiser refuses to write an artefact that still carries a credential-looking string, except the exact synthetic examples the fixture itself contains (listed per attempt in `redaction.json` as fixture-derived).

## Ledger version log

- v0 (2026-09-20): core as above. No proposal record, no catalogs.
- v1 (2026-09-22): overlays/lifecycle carries R4, the proposed ruling against R1 (T-522). Core unchanged; no behavioural arm includes it.
