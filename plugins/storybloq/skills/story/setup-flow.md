# Setup Flow -- AI-Assisted Project Initialization

This file is referenced from SKILL.md whenever a project has no `.story/` yet, whatever the folder holds: an idea in the conversation, only documents, or code. SKILL.md has already determined that setup is needed before routing here.

**Skill command name:** When this file references `/story` in user-facing output, use the actual command that invoked you (e.g., `/story` for Claude Code, `$story` for Codex, `/story:go` for plugin install). Same for `/story auto` -- use `$story auto` in Codex or `/story:go auto` if invoked as a plugin.

**If arriving from Step 2b (interrupted scaffold):** `.story/` already exists and the status payload says `isEmptyScaffold: true`. Classify the folder as `interrupted` in 1a and continue from there. Setup reuses that scaffold (see 1e); it never runs init over it.

## Setup Principles

These govern the whole flow.

1. **Product first.** Setup is about what the user wants to exist and how they will know it works, not about picking a stack. Ask about outcomes, not system jargon: "How do people sign in?" not "Auth model?"
2. **Reuse before asking.** Anything the brief, the code or the conversation already answers is never asked again. Every question must be about a gap that changes the plan.
3. **Infer domain concerns from the material.** A collaborative whiteboard implies realtime and presence work; pricing tiers imply billing work. The ticket generator knows what a description implies; do not add a question for it.
4. **Technology stays the user's.** Keep explicit technology choices exactly as given. Recommend a stack, provider or service only when the user asks, or when none is stated and the gap blocks planning; then give the options with their trade-offs and no house favourite.
5. **Nothing invented.** No invented user research, performance targets, domain rules or completion claims. Label an assumption as an assumption.
6. **Nothing is written before approval.** Discovery, questions, planning and review make no setup writes: no `storybloq_init`, no create or update call, no file write, no `git init`.

## AI-Assisted Setup Flow

This flow creates a meaningful `.story/` project instead of empty scaffolding. Your AI client reads the material, agrees what success means, plans and reviews the work, shows one setup package, and creates everything on approval.

Before starting, introduce storybloq in 3-4 sentences, not a sales pitch:

"Storybloq tracks your project's roadmap, tickets, issues, and session handovers in a `.story/` directory. Every Storybloq session starts by reading this context, so you never re-explain your project from scratch. I'll read what's here, ask only about what's missing, and propose a reviewed plan. Nothing is created until you approve it."

#### 1a. Discover

Read the folder once and classify it:

- **`empty`** -- nothing but an idea in the conversation (an empty or near-empty directory).
- **`brief-only`** -- documents (Markdown, text, PDF, design exports) and no code.
- **`existing`** -- code, with or without a manifest or git history.
- **`interrupted`** -- a `.story/` scaffold with `isEmptyScaffold: true` (the Step 2b case). It can also hold code or documents; read those as for the other classes.
- **`setup in progress`** -- an approved setup was cut off: status lists it in `setupInProgress` (or a line `Setup <id> is in progress`), a command refuses with `Setup <id> is bootstrapping this project`, or the folder holds `.story/.setup-bootstrap.json` (its `setupId`) and no `.story/config.json`. Ask nothing: run `storybloq setup-apply --resume --setup <id>` and continue at 1e step 3. With two or more listed, ask the owner which to resume.

There is no manifest or git requirement and no minimum length. Relevant material is manifests, documents, source roots and design files. Skip caches, build outputs, vendored dependencies, lockfile internals and review databases unless the user points at them.

For code, note the manifests and what they declare (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Package.swift`, `*.xcodeproj`, `build.gradle(.kts)`, `pubspec.yaml`, `Gemfile`, `*.csproj`, and so on). A folder can hold several: a frontend and a backend each with its own manifest are two parts of one project, and each part is recorded separately.

Ask the user before importing GitHub issues (`gh issue list --limit 30 --state open --json number,title,labels,body,createdAt`). If `gh` fails (auth, rate limit, no remote), skip cleanly and note "GitHub import skipped: [reason]". With more than 30 issues, note "Showing 30 of N. Additional issues can be imported later."

#### 1b. Understand the Material

Read every candidate brief once: any Markdown, text or PDF document the user names, or that sits at the root or in `docs/`, the README included. There is no size or heading-word filter; read a very large file by section. Skip only changelogs, licences and contribution guides unless they are named. Read `CLAUDE.md`, `AGENTS.md` and `RULES.md` when present, the top-level listing, and for an existing codebase `git log --oneline -20`.

For each fact you will use, keep a source reference (file and heading, or "conversation") and label it:

- **requirement** -- something the first version must do;
- **proposal** -- an idea the material floats but does not commit to;
- **existing behaviour** -- something the code already does;
- **unresolved decision** -- a choice the material leaves open.

**Evidence before completion.** In an existing codebase, a capability named in a brief is complete only when the code has it: grep for the route, model or screen, or read the file, and record that evidence with the fact. A brief that claims more than the code implements is normal; the difference becomes planned work, never a completed ticket.

**Conflicts.** When sources disagree (scope, a domain rule, a technology), list each conflict with its consequence and a recommendation, and let the user rule before planning depends on it. Default precedence: an existing `CLAUDE.md` or `AGENTS.md` describes current state, a brief or PRD describes proposed scope, and a README is an overview that may be outdated or aspirational.

**Inspect only what changes the plan.** Read framework structure (routing layout, API folders, module or feature folders, workspace packages) only as far as it changes the tickets. When a variant changes ticket topology (for example two routing models), confirm it with the user instead of guessing.

**Derive project metadata:** name from the manifest or the directory; type from the package manager; language from the manifest and file extensions. For a mixed stack, record every part. Assess the stage from the evidence (commits, tests, releases) without fixed thresholds.

#### 1c. Establish Success

Reuse what the brief and the conversation already answered. Ask only about **material gaps** -- unresolved questions whose answer would change the plan -- a few at a time, in free text or with `AskUserQuestion`. When the material already answers everything, ask nothing. A decision the user postpones is recorded as an open owner decision: only the work it affects waits on it, and the rest is planned normally.

**Check the material before asking.** An answer is settled when an applicable requirement (1b), or an explicit owner decision, states it and no unresolved source conflict touches it. Conflicts are adjudicated first (1b); only then are settled answers left unasked. A proposal is not a requirement: a floated idea is still open. For every question you draft, search the material for its answer. If it is settled, do not ask; cite the source in the plan instead. A question that joins a settled rule to an open one asks only the open part.

**A discovery turn ends with its question.** In plain text, the question is the last thing in the message: no offer to leave a topic undecided, no default you will assume, no instruction or note after it. With a structured question tool, the question call is the last thing in the turn, and anything you want to say comes before it. When the owner postpones a topic in their answer, it becomes an open owner decision (above).

The topics, where the material leaves them open:

- the intended users, the problem they have, and the primary journey;
- what a successful first version lets them do;
- scope boundaries: what is in the first version, and what is a later ambition;
- product constraints where relevant: design, accessibility, correctness, privacy, reliability, operating cost, and whether this is a sensitive or regulated domain (health, legal, finance, compliance), which adds audit, privacy and stricter verification work;
- what exists to build on: designs, domain expertise, reference examples, representative test data.

Write the result as a concise product brief with observable acceptance conditions ("a signed-in user can export a month of entries as CSV"), each carrying its source reference. Label assumptions as assumptions. Later steps cite these answers; never ask them again.

#### 1c2. Plan and Review

This runs before anything is shown for approval, every time.

**Open the review gate first**, in your first turn, before any question: run `storybloq setup-review gate` as a shell call of its own and follow its output. Keep the setup id it prints. When it prints the stop, send the four lines below as your whole first turn, with no discovery question, draft or review; ask discovery questions only after the owner chooses Continue without independent review.

**When no reviewer can run**, or a `setup-review` command ends with this stop, send it and nothing else (or ask the same two options with `AskUserQuestion`). Stop there until the user answers.

No supported reviewer is available to review this plan.
How should I proceed?
Retry the review
Continue without independent review

A retry runs `storybloq setup-review gate --setup <id>`, then the review again. Continuing records the skip for the whole setup: run `storybloq setup-review status --setup <id> --skipped`, with nothing on standard input, and later adjustments carry its lines and do not ask again. The skip also appears in the package, the setup summary and the initial handover.

**Decompose the entire in-scope brief** by outcomes and real dependencies. There are no phase or ticket quotas: as many phases and tickets as the scope needs.

- Phases are milestones. Each says what the user will be able to demonstrate when it is done.
- Tickets are coherent, demonstrable slices. Foundation work names the capabilities it enables.
- `blockedBy` reflects real prerequisites only, never automatic chaining from phase order.
- Several entities, or an API with its UI, are sizing signals: split a ticket only when one slice cannot be implemented and verified as a unit. Decompose the core differentiator instead of leaving it as one ticket.
- For an existing codebase, verified completed work gets no ticket: it is a coverage row (1e) resting on the evidence from 1b.

**Every implementation ticket's description** follows one template:

```
Outcome: <what the user can do>, from <source reference>
Scope: <included>. Excludes: <explicit exclusions>
Acceptance: <observable criteria>
Behaviour: <failure, empty, loading, recovery and accessibility behaviour, where relevant>
Verification: <how acceptance is shown>. Prerequisites: <...>. Assumptions: <unresolved assumptions>
```

Every label carries content. Where one does not apply, write `none` (for example `Excludes: none`); never leave it empty. Outcome, Scope, Acceptance and Verification always say something concrete.

**Coverage map.** Every requirement from 1b and 1c maps to a ticket, an owner decision, or an explicit deferral. Later-version requirements are listed as deferred and never silently promoted into the first version.

**Owner checkpoints.** Plan them where the work needs the owner's eyes. Three kinds:

- **early artifact review** -- a design, prototype, sample output or API interaction the owner looks at before dependent work continues;
- **milestone demonstration** -- the owner sees a milestone working;
- **first-version acceptance** -- the owner accepts the first version against the agreed outcomes.

Each checkpoint is an ordinary ticket titled `Checkpoint: <what the owner reviews>`. Its description holds `Question:` for a decision, or `Criteria:` for a demonstration or acceptance, and names the artifact the owner reviews. The ticket is `blockedBy` the work that produces what it reviews, and only the follow-on work that the owner's decision actually affects is `blockedBy` the checkpoint; unrelated work stays unblocked. Stage-1 limitation: nothing enforces the gate yet, so a checkpoint ticket can be closed like any other ticket. Say so in the package.

**Independent review, by default.** Only the CLI runs the reviewer. Write the review packet: four sections in this order, each non-empty (`none` when there is nothing): `## Source requirements` (one `R<n>: <requirement> (source: <file>, <section>)` per line), `## Owner answers and decisions`, `## Existing-state evidence`, and `## Plan` (milestones; each ticket as `Ticket: <title>`, its template lines and `Blocked by: <titles or none>`; each checkpoint as `Checkpoint (<kind>, owner <label>): <title>`, kind `decision` for a review that asks a `Question:` and `acceptance` for one with `Criteria:`, label the owner's name or role; the coverage map). Run `storybloq setup-review run --setup <id> <<'STORYBLOQ_PACKET'`, then the packet, then a line `STORYBLOQ_PACKET`.

The review checks coverage and fidelity to the brief, journey completeness and usability, story boundaries and dependency correctness, early feasibility risks, domain correctness and applicable safety requirements, and whether the planned evidence can establish acceptance. Incorporate the findings; a second round runs on the revised packet, and the CLI allows two per cycle. Unresolved findings stay visible in the package, and mandatory acceptance conditions are never weakened to finish a round.

**The package's review lines.** Run `storybloq setup-review status --setup <id>` with the current packet on standard input the same way, or with `--skipped` after the owner's skip, and copy its first two lines into the package verbatim; a `Revision:` line after them is for a resolution (1e) and never goes in the package. Never write either line yourself and never state a review outcome anywhere else. When status prints the round-limit line, say above it what the round-2 findings were and what changed in response. When it prints a failed, absent or unreadable line, the package cannot be shown: send the stop.

**The Plan in the package.** With a completed or round-limit line, it is the `## Plan` section of the packet status was given, unchanged, between two lines of its own: `Plan, revision <digest12>:` before it and `End of plan, revision <digest12>` after it, `<digest12>` being the revision in the status line (the first one in a round-limit line). No ticket, dependency, coverage row or checkpoint line appears outside them. After the owner's skip no revision was reviewed: show the proposed Plan with no markers and no digest.

#### 1d. Present Proposal

Present one setup package. A readable summary comes first:

- the product outcome and the first-version boundary;
- the milestones and what each one demonstrates;
- the important unresolved decisions and labelled assumptions;
- the work that can begin immediately;
- the two review lines from `setup-review status` (1c2), with findings incorporated or still open described above it in prose, and the stage-1 checkpoint limitation when checkpoints are planned.

Then the Plan (1c2), marked when the status line names a revision: the tickets by milestone with their dependencies and checkpoints, and the coverage map. Then what else the approval covers:

- **Project:** name, type, language (every part of a mixed stack).
- **Governance files** to write: `CLAUDE.md` (or `AGENTS.md`), `RULES.md` and `REVIEW.md`, each previewed on request. Omit a file that already exists; it is never overwritten.
- **Quality level** with its recipe stages: **Full pipeline**, **Tests only** or **Minimal**. Propose Full pipeline for business rules, workflows, multiple organisations, AI evaluation needs or a sensitive domain, and say why. Show each stage command as proposed and whether it is established or still pending (see 1e); a test stage reads `TEST: <command> (<wrapper> -> <runner>)`. State the level on one line, `Quality level: <level>`, naming exactly one of the three right after the colon; a reason may follow after a comma or period.
- **Git:** `git init` when the folder is not a repository, and the `.gitignore` entries.
- For an `interrupted` scaffold: the existing `p0` phase kept first, and any difference between the existing config and the package (name, type, language), which is reported, not overwritten.
- Imported GitHub issues, if any.

Explain briefly what they are looking at: "Phases are milestones in your project's development. Tickets are specific work items within each phase. After setup, invoking Storybloq at the start of any supported AI coding session loads this context automatically."

Then ONE `AskUserQuestion`:
- question: "How should I proceed with this setup?"
- header: "Setup"
- options:
  - "Approve setup" -- create everything listed in this package
  - "Adjust the plan" -- change scope, milestones, tickets, files, quality level or git
  - "Inspect details" -- expand a ticket, a file preview or the coverage map

"Inspect details" shows what the user asks for, changes nothing in the plan, and re-asks the same question with the same status line; a change is an adjustment. "Adjust the plan" applies the change, classifies it, re-shows the package and re-asks. A change is **material** when it changes the review packet. A material change is reviewed before the adjusted package is shown: `storybloq setup-review run --setup <id> --new-cycle --reason "<the owner's words>"` on the adjusted packet, then status. For any other change, the package keeps the previous package's status line unchanged and carries one line above it, verbatim: `Review not rerun: <what changed> changes no ticket's scope, dependencies or responsibilities.` After an authorised skip, the adjusted package carries the skip status line instead (1c2). Ask again only for a material change or a genuinely new decision. Stop after asking and wait for the answer: nothing in 1e runs until the user explicitly chooses "Approve setup". An unambiguous affirmative reply to this question ("yes", "approve", "go ahead", "Approve setup") is approval. An answer that delegates judgement, says no preference, or answers a different question is not: ask the same question again: the same probe and status lines, the two fixed lines, one blank line, then the four lines, nothing after them.

**Without a structured question tool**, end the package with exactly these four lines, one per line, no blank line between them and nothing after them:

How should I proceed with this setup?
Approve setup
Adjust the plan
Inspect details

Do not paraphrase a label: the owner, a reviewer or an evaluation harness reads these exact labels. The message ends at `Inspect details`: that line, with no trailing spaces, is the last line of every turn that shows the package (the first, after "Inspect details" and after "Adjust the plan"). The probe and status lines sit above the question line. Directly above the question line, with one blank line between them, put the two lines shown below, verbatim. Do not name or quote the setup skill or its rules in the package; name the governance files you propose as usual. Any other note goes above those lines, never below `Inspect details`, and no line ends in spaces:

```
Your answers shape the plan; creating it is your choice.
Nothing is written until you choose Approve setup.

How should I proceed with this setup?
Approve setup
Adjust the plan
Inspect details
```

#### 1e. Execute on Approval

Everything below runs only after approval as defined in 1d. One engine call writes the whole approved setup: the project, phases, tickets, checkpoints, dependencies, issues, config, governance files, git, the setup note, the initial handover and the snapshot. Never create, update or wire items with individual calls, never run `storybloq init`, and never write those files yourself.

For an `interrupted` scaffold nothing changes: the engine keeps its config and phases, `p0` first, and records them before it writes.

1. **Build the payload** (below) from the approved package and **compare it to the package** before sending: every `Ticket:` in the Plan is one ticket with that title, every checkpoint line one checkpoint with that kind and owner label, every dependency one `blockedBy` or `gates` entry, and nothing the package does not show.
2. **Apply it** in one shell call of its own: `storybloq setup-apply <<'STORYBLOQ_SETUP'`, then the JSON, then a line `STORYBLOQ_SETUP` (over MCP, `storybloq_setup_apply` with `payload`; it is callable before `.story/` exists, and when it is not listed, call the client's tool discovery/search tool by that exact name with a small result limit. In Codex, use the `limit` field for that result limit). Copy its output to the owner verbatim; never summarise it.
3. **Act on the exit code** (MCP prints it first, as `[exit N]`):
   - `0`: done; go to 1f.
   - `2`: refused, nothing written. Correct a payload that misstates the package and send it again; otherwise tell the owner what was refused and stop.
   - `3`: interrupted. Run `storybloq setup-apply --resume --setup <id>`; a resume never duplicates anything.
   - `4`: an edit or a clash only the owner can decide. Each `Ambiguity:` line is one question with its resolutions as the answers. Send all the answers in one call, `storybloq setup-apply --setup <id> --resolve '<json>'`: a JSON array of `{"target": "<the line's target>", "resolution": "<the answer>", "ownerWords": "<the owner's words>"}`. `stop` ends the run with nothing written. A material answer (`accept-current`, `accept-removal`, `keep-current`, `replace`, `drop-checkpoints`, `adopt <id>`) changes the approved plan: review it as an adjustment (1d), show the owner the result, and add `"reviewRevision": "<revision>"` to that answer, `<revision>` being the 64 hex characters of the `Revision:` line `setup-review status` printed for the amended packet. The 12-character digest in a status line is for display only, and setup-apply refuses it. After the owner's skip no review is needed.
   - A `pointer edit owed` stop: show the owner the approved change (the `.proposed` file it names against the current file), make it with your ordinary edit tool once the owner has seen it, then resume. An `enable refused` stop: relay its text verbatim.
   - `7`: another writer holds the project lock; send the same call again when it finishes.

   Exit 5 never comes from setup-apply.

   After setup, `storybloq setup-verify --ticket <id>` exit 4 (`verification evidence unreadable`) is the owner's to answer: an adapter (an argv run with no shell; show the owner any `--drop` and what replaces it), leave-off or stop, sent as `storybloq setup-verify --ticket <id> --resolve <adapter|leave-off|stop> --owner-words '<the owner's words>' --run <hex>`, `<hex>` being the `(run <hex>)` the stop printed (a changed ticket or record makes it stale, exit 5: run again), an adapter adding `--argv <word>` per word and any `--drop <variable>`.

**The payload**, one JSON object: `{"version": 1, "setupId", "review", "ownerLabel", "project", "quality", "governance", "git", "phases", "tickets", "checkpoints", "issues", "coverage"}`. `setupId` is the gate's `SS-` id. Every phase, ticket, checkpoint and issue has its own `key` (`K1` upwards), and references use keys, never ids.

- `review`: `{"reviewer": "<codex|claude|none>", "outcome": "approved|round-limit|skipped", "lines": [<the package's review lines, verbatim>]}`; `ownerLabel`: the owner's name or role; `project`: `{"name", "type", "language"}`.
- `phases`, in milestone order: `{"key", "id": "<lowercase-slug>", "name", "label", "description"}`.
- `tickets`: `{"key", "title", "type": "task|feature|chore", "phase": "<phase key>", "description": "<the template lines>", "blockedBy": [<keys>]}`. Work the repository or brief shows already built is a ticket with `"status": "complete"`, never a deferral; nothing open blocks it and no checkpoint gates it. Under Tests only or Full pipeline, each component whose test stage is pending gets exactly one establishment ticket: a task with `"establishes": {"component": "<id>", "stage": "test", "scaffold": "<key>"}`, no `status`, and `blockedBy` its scaffold alone (the ticket that builds what the tests run against). Its description owes one minimal real test of the scaffold, then `storybloq setup-verify --ticket <id>`, which alone completes it. Work that needs the tests waits on it.
- `checkpoints`: `{"key", "title", "kind": "decision|acceptance", "question"|"criteria", "evidenceRefs": [], "description", "phase", "blockedBy": [<what it reviews>], "gates": [<the work it holds back>]}`.
- `issues` (imported GitHub issues): `{"key", "title", "body", "labels", "source": <number or null>}`.
- `coverage`: `{"requirement": "R<n>", "text", "source", "keys": [<keys>]}`, plus `"deferral": "<why>"` for a deferred requirement.
- `quality`: `{"level": "full|tests-only|minimal", "verifyApplies": <bool>, "components": [{"id", "workdir": "<. or dir>", "test", "build", "verify"}]}`, each stage `{"command", "status": "established|pending", "reason"}`, a test stage adding `"runner": "vitest|jest|pytest|django|go|cargo|flutter"` and `"wrapper": "none|npm|make|django-manage"` (required when an establishment ticket serves it) (`verify`: `{"startCommand", "readinessUrl", "status", "reason"}`), `reason` only when pending, or `null`. The engine writes every recipe stage, with an explicit `enabled`, from these and the level.
- `governance`: `{"canonicalFactsPath": "<CLAUDE.md or AGENTS.md>", "files": [{"path", "content"}]}`, only the approved files that do not exist yet; the engine never overwrites one.
- `git`: `{"init": <true when the package initialises git>, "gitignore": [<the approved entries, at least .story/snapshots/, .story/sessions/ and .story/status.json>]}`.

**Classify every component** (the root counts as one) for `quality.components`: its test command is either established or pending. It is established only when both hold. Nothing is established by running it: never execute an install, test, build or dev server during setup.

1. **A command**, taken in this order of precedence:
   - an explicit repository command: a `test` script in `package.json`, a `test` target in a `Makefile`, or a test command documented in the README or CLAUDE.md;
   - otherwise exactly one configured runner: a runner configuration section or file, such as pytest in `pyproject.toml`, `pytest.ini`, `setup.cfg` or `tox.ini`, or a jest or vitest config;
   - otherwise exactly one runner convention row below.

   When two sources at the same level disagree, the command is pending with the reason "conflicting test command evidence". A higher level wins over a lower one. A Django project whose Makefile runs `pytest` uses `pytest`, not `python manage.py test`.
2. **Test sources the runner collects:** at least one test file exists that the runner would collect. Use the repository's collection configuration first, such as pytest `testpaths` and `python_files`, jest `testMatch` or vitest `include`. The patterns in the table are defaults, used only when nothing is configured.

| Runner convention | Applies when | Default test sources | Command |
|---|---|---|---|
| npm script | `package.json` has a `test` script | files that script's runner collects (vitest `**/*.{test,spec}.*`, jest `**/*.{test,spec}.*` and `__tests__`) | `npm test` |
| pytest | pytest configuration or a pytest dependency | `test_*.py` / `*_test.py` under the component | `pytest` |
| Django | `manage.py` present | `tests.py` or `tests/` in an app | `python manage.py test` |
| Go | `go.mod` | `*_test.go` | `go test ./...` |
| Rust | `Cargo.toml` | `tests/*.rs`, or `#[test]` inside `src` | `cargo test` |
| Flutter | `pubspec.yaml` with `flutter_test` | `test/**/*_test.dart` | `flutter test` |

**`BUILD` and `VERIFY`** are established only from the manifests, never by running anything.

For `BUILD` and `VERIFY`, the candidates to look for (read from the manifest or build file, never values to write unchecked):

| Stack | Dev server | Readiness URL | Build |
|-------|------------|---------------|-------|
| Node (`package.json` scripts) | `npm run dev` | `http://localhost:3000` | `npm run build` |
| Vite / SvelteKit | `npm run dev` | `http://localhost:5173` | `npm run build` |
| Python | per framework | `http://localhost:8000` | -- |
| Django | `python manage.py runserver` | `http://localhost:8000` | -- |
| Go | `go run .` | `http://localhost:8080` | -- |
| Rust | -- | -- | `cargo build` |
| Flutter | -- | -- | `flutter build` |

A Python project with no `package.json` never gets `npm test`. `verifyApplies` is false for static sites, CLIs, libraries, packages, mobile-only apps and projects with no custom server.

**CLAUDE.md generation** (when approved in the package):

*Always present:* project purpose (1-2 sentences); the product outcome and first-version boundary; tech stack as stated by the user or the code; architecture as it exists or is planned; testing strategy (TDD when the RULES.md TDD line applies).

*Present when relevant:* deployment target, core entities and relationships (names, not full schemas), domain rules and workflows, identity model, tenancy, AI pattern and provider as chosen.

*Flagged for resolution:* undecided choices, marked TBD with the options.

**Sanitization:** Never copy secrets, tokens, credentials, API keys, connection strings, customer-identifying data, or internal-only endpoints into generated files.

**RULES.md generation** (when approved) captures domain rules (e.g., "all monetary calculations use fixed-point arithmetic, not floats"), API constraints, data integrity rules (soft deletes, audit trails, idempotency) and testing requirements for core business logic.

**TDD recommendation:** Add it when the material shows business rules or workflows, multiple organisations, AI evaluation needs, or a sensitive domain. It is tied to those facts, not to judgement:

```
- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
```

Same sanitization rules as CLAUDE.md.

**REVIEW.md generation:** REVIEW.md is the project's review contract. Verification backends read it and ordinary coding sessions do not. `storybloq init` does not write it: a contract nobody agreed to is worse than no contract, so it is part of the package and the user edits or rejects it before it lands. `storybloq validate` warns when review backends are configured and REVIEW.md is absent or unparseable.

**Write `review-contract-template.md` verbatim.** Read it from the same directory as this skill file (if it is not found, tell the user to run `storybloq setup --client all`). The six definitions in it are fixed wording. What a project changes is the blocking classes, the Outside line, and whatever repository detail it adds BELOW the principles. Do not paraphrase it and do not reorder it: the lens backend receives only the first 3000 characters of REVIEW.md, head-truncated, so a principle moved below the repository detail is one a lens reviewer is asked to name without ever being shown it.

**The Outside line.** The template ships three lens ids on it. Entries there take a subject OUT of the contract, which means a finding on that subject is never capped and keeps the severity its reviewer gave it -- Outside is the loud side, not a way to silence anything. If the user asked to set exclusions, say that in one sentence, then write what they name as one plain comma-separated line under the heading. Never bullet the entries: the parser reads every line under that heading as entries and does not strip a `- ` prefix, so a bulleted entry matches nothing. An empty line is the widest coverage and the quietest gate, and `storybloq validate` warns about one.

Same sanitization rules as CLAUDE.md.

#### 1f. Post-Setup

**Summary.** A finished `setup-apply` prints the setup report, then `Setup applied: <id>` (a call on an existing project adds `Git:` lines for the files it wrote). Copy the report lines into the message verbatim, never retyped, merged or shortened: the created counts, the quality level and stages, every `Pending:` line, the governance files, the review lines and the first story. The engine already wrote the setup note and the initial handover. `storybloq setup-report --setup <id>` prints the live report later, `--historical` the frozen one.

Present a brief completion message and tell the user how to start:

"Your project is set up -- [X] phases, [Y] tickets, AGENTS.md/CLAUDE.md, and RULES.md created. Type **`/story`** in Claude Code or **`$story`** in Codex at the start of any session to load context and see what to work on. Or use **`/story auto`** / **`$story auto`** to work through the tickets autonomously."

Keep that prose to 2-3 sentences; the report lines are not prose: they are never shortened, merged, bulleted or left to the note or handover instead. The system teaches itself through use -- `/story` loads context, shows status, and suggests next work.

**Hooks note (Claude Code).** When `storybloq setup` registered hooks, the session now carries context-pressure awareness (T-499): a SessionStart hook captures the auto-compact setting for the process, a synchronous UserPromptSubmit hook samples the transcript tail on every prompt and injects one line only when pressure is imperative or compact-needed, and the Stop hook samples at every turn end. Nothing to configure; `storybloq session intel` shows the current numbers. Machine-wide opt-out: `~/.claude/storybloq/config.json` `{"sessionIntel": {"enabled": false}}`, then re-run `storybloq setup` or any CLI command to remove the hooks.

**Design evaluation hint** (show only for a web, mobile or desktop app): add one line after the completion message: "Tip: Run `/story design` anytime to evaluate your frontend against [detected platform] best practices and generate improvement issues." Use the actual command that invoked this flow (e.g., `/story design` for standalone, `/story:go design` for plugin).

**Last check before sending the completion message.** Every `Pending:` line of the report is in the message itself, one per line. The same line in the note or handover does not count.
