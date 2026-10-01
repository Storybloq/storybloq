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
6. **Nothing is written before approval.** Discovery, questions, planning and review make no setup writes: no `storybloq_init`, no create or update call, no file write, no `git init`. One approval of the setup package authorises all of it.

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

**Probe the reviewers first**, before drafting the plan. Run `command -v codex` as a shell call of its own, nothing else in that call, and keep exactly what it printed. Then check the other two reviewers in the order below. When none of the three can run (the probe printed nothing, `review_plan` is not in your tool list after one exact-name discovery call, and you cannot start an agent), send the unavailable stop below now, without calling a wait, before drafting; do not draft or describe a review.

1. a native Codex CLI, when `command -v codex` prints a path, as a read-only review with the plan on standard input: `codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema '<skill dir>/setup-review-schema.json' - <<'STORYBLOQ_PLAN'`, then the review request and the full plan, then a line `STORYBLOQ_PLAN`. `<skill dir>` is the absolute path of the directory you read this file from, kept in that one quoted argument. The schema must be that file: a schema from `<(...)`, a here-document or `/dev/fd` fails to load in some clients' shells;
2. the `review_plan` MCP tool, when it is in your tool list (after one exact-name tool discovery call where the client defers tools);
3. an independent agent, when the client can start one with a prompt you write and return its final message, either as the start call's own result or through a wait on that agent. A wait with no agent started, or a wait that returned no message, is a wait on nothing, not a review.

**When no reviewer can run**, or every reviewer call fails, send this stop and nothing else (or ask the same two options with `AskUserQuestion`). Stop there until the user answers.

No supported reviewer is available to review this plan.
How should I proceed?
Retry the review
Continue without independent review

A retry runs the probes again. Continuing records the skip for the whole setup: later adjustments carry the skip status line and do not ask again. The skip also appears in the package, the setup summary and the initial handover.

**Decompose the entire in-scope brief** by outcomes and real dependencies. There are no phase or ticket quotas: as many phases and tickets as the scope needs.

- Phases are milestones. Each says what the user will be able to demonstrate when it is done.
- Tickets are coherent, demonstrable slices. Foundation work names the capabilities it enables.
- `blockedBy` reflects real prerequisites only, never automatic chaining from phase order.
- Several entities, or an API with its UI, are sizing signals: split a ticket only when one slice cannot be implemented and verified as a unit. Decompose the core differentiator instead of leaving it as one ticket.
- For an existing codebase, capture verified completed work as completed tickets only when the evidence from 1b supports it.

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

**Independent review, by default.** Review the full plan with the first reviewer whose probe passed, in the capability order above.

Give every review a review id, `R1`, `R2` and so on in order, and put `Review id: R<n>` as the first line of the plan you send (the here-document body, the `review_plan` plan text, or the agent's prompt). Ask for the answer in the schema's shape, a `verdict` and `findings`. An id exists only once you send it as the first line of a reviewer call's input; a status line cites only an id you sent and whose response you captured, never an id for a review that did not run.

The review checks coverage and fidelity to the brief, journey completeness and usability, story boundaries and dependency correctness, early feasibility risks, domain correctness and applicable safety requirements, and whether the planned evidence can establish acceptance. Maximum 2 review rounds; incorporate the findings. Unresolved findings stay visible in the package, and mandatory acceptance conditions are never weakened to finish a round.

**The review status line.** Every package and the setup summary carries exactly one review status line, on its own line, in one of two forms, verbatim:

- `Independent review: <verdict>, invocation R<n>`: `<verdict>` is the captured response's `verdict` value exactly, and `R<n>` is the review id of the call that returned it.
- `Independent review: skipped at the owner's request`: only after the owner chose "Continue without independent review".

Describe findings in your own words elsewhere if useful, but never state a review outcome outside the status line.

**The probe line.** The line directly above every review status line, in each package and the setup summary, is the probe line, verbatim in one of two forms: `Reviewer probe: `command -v codex` printed <path>`, where `<path>` is exactly what your most recent probe printed, or `Reviewer probe: `command -v codex` printed nothing`. After a probe that printed nothing, a review result can only come from the `review_plan` tool or an agent you started after that probe. Unless the owner has already chosen Continue without independent review, if neither ran and returned a review, send the unavailable stop. After an authorised skip, continue with the probe line and the skip status line without asking again.

**What counts as a review.** A review counts only when a supported reviewer returned a completed response with a verdict and findings about the plan you supplied, captured in this session and quoted in the package. Never narrate a review you have no captured output for: not "Independent review passed", not "I have sent it for review", not a verdict you inferred or remember. Error output, a launch acknowledgement, a refusal or incomplete output is not a review. An agent is reviewed only once its completed final message is captured, from the start call's own result or from a wait on it; keep waiting on a running agent rather than reporting it. When no supported reviewer returned such a response, the stop above is mandatory: never report a review as passed without one.

#### 1d. Present Proposal

Present one setup package. A readable summary comes first:

- the product outcome and the first-version boundary;
- the milestones and what each one demonstrates;
- the important unresolved decisions and labelled assumptions;
- the work that can begin immediately;
- the review status line in its exact form (1c2), with findings incorporated or still open described above it in prose, and the stage-1 checkpoint limitation when checkpoints are planned.

Then the ticket inventory grouped by milestone. Each ticket shows its purpose, its dependencies and any checkpoint it waits on. Then what else the approval covers:

- **Project:** name, type, language (every part of a mixed stack).
- **Governance files** to write: `CLAUDE.md` (or `AGENTS.md`), `RULES.md` and `REVIEW.md`, each previewed on request. Omit a file that already exists; it is never overwritten.
- **Quality level** with its recipe stages: **Full pipeline**, **Tests only** or **Minimal**. Propose Full pipeline for business rules, workflows, multiple organisations, AI evaluation needs or a sensitive domain, and say why. Show each stage command as proposed and whether it is established or still pending (see 1e). State the level on one line, `Quality level: <level>`, naming exactly one of the three right after the colon; a reason may follow after a comma or period.
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

"Inspect details" shows what the user asks for, changes nothing in the plan, and re-asks the same question with the same status line; a change is an adjustment. "Adjust the plan" applies the change, classifies it, re-shows the package and re-asks. A change is **material** when it alters any ticket's scope (what it includes or excludes), its dependencies, or where a persistence, reliability, security or privacy responsibility sits, including moving work from one ticket to another. A material change reruns the reviewer on the adjusted plan with a new review id before the adjusted package is shown, and that package's status line cites the new id. For any other change, the package keeps the previous package's status line unchanged and carries one line above it, verbatim: `Review not rerun: <what changed> changes no ticket's scope, dependencies or responsibilities.` After an authorised skip, the adjusted package carries the skip status line instead (1c2). One approval covers everything listed. Ask again only for a material change or a genuinely new decision. Stop after asking and wait for the answer: nothing in 1e runs until the user explicitly chooses "Approve setup". An unambiguous affirmative reply to this question ("yes", "approve", "go ahead", "Approve setup") is approval. An answer that delegates judgement, says no preference, or answers a different question is not: ask the same question again: the same probe and status lines, the fixed line, one blank line, then the four lines, nothing after them.

**Without a structured question tool**, end the package with exactly these four lines, one per line, no blank line between them and nothing after them:

How should I proceed with this setup?
Approve setup
Adjust the plan
Inspect details

Do not paraphrase a label: the owner, a reviewer or an evaluation harness reads these exact labels. The message ends at `Inspect details`: that line, with no trailing spaces, is the last line of every turn that shows the package (the first, after "Inspect details" and after "Adjust the plan"). The probe and status lines sit above the question line. Directly above the question line, with one blank line between them, put the line `Nothing is written until you choose Approve setup.`, verbatim. Do not cite, quote or link this file in the package. Any other note goes above that line, never below `Inspect details`, and no line ends in spaces:

```
Nothing is written until you choose Approve setup.

How should I proceed with this setup?
Approve setup
Adjust the plan
Inspect details
```

#### 1e. Execute on Approval

Everything below runs only after approval as defined in 1d.

1. **Initialise only when `.story/` is absent.** Call `storybloq_init` with name, type and language. For an `interrupted` scaffold, skip init: its config and phases are reused as they are, and init is never forced over them. An owner's instruction about the config is applied as given, never widened or narrowed. Scaffold metadata (name, type, language) is always preserved. The recipe stages are a separate item in the package (quality level) and are written only as approved there. If the owner forbids any config change, the package says which defaults then stay enabled (`WRITE_TESTS` and `TEST` with `npm test`) and asks the owner to decide about them before approval. A default `p0` "Setup" phase (which a fresh init also writes) stays first, and setup phases go after it. If the scaffold is no longer empty (tickets, issues, handovers or non-default phases appeared), stop and name what you found.

2. **Readiness by capability.** The creation tools are `storybloq_phase_create`, `storybloq_ticket_create`, `storybloq_ticket_update`, `storybloq_issue_create` and `storybloq_snapshot`. After init (or at once for a reused scaffold), check which are callable. For any that are not, call the client's tool discovery/search tool (`ToolSearch`, `tool_search`, or equivalent) by exact name, with a small result limit. In Codex, use the `limit` field for that result limit. Some clients cache the pre-init tool list and only refresh when asked. If a tool is still missing, fall back to the CLI via `Bash` (`storybloq phase create ...`, `storybloq ticket create ...`, `storybloq ticket update ...`, `storybloq issue create ...`, `storybloq snapshot`) and note that a client restart may be needed. Run one storybloq command per shell call, never through an interpreter script, a loop or a here-document, and check the result with `storybloq ticket list` or `storybloq phase list`, not a script. If the CLI is unavailable too, stop with a concrete blocker naming the missing tools and the restart step.

3. **Configure the recipe stages** for the approved quality level. Construct one JSON object and apply it via Bash:
   ```
   storybloq config set-overrides --json '<JSON>'
   ```
   The default recipe enables `WRITE_TESTS` and `TEST` with `npm test`, an override only replaces what it names, and a reused scaffold may already carry overrides. So all four stages, `WRITE_TESTS`, `TEST`, `BUILD` and `VERIFY`, are always written with an explicit `"enabled"` value.

   **When a test command is established.** Classify every component first (the root counts as one): its test command is either established or pending. It is established only when both hold. Nothing is established by running it: never execute an install, test, build or dev server during setup.

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

   **Then build one test command from the established components only.** With one, it is that component's command, run from the root, or `cd <dir> && <command>` for a component in a subdirectory. With several, write one plain sequence of `cd` steps and test commands joined only by `&&`, for example `cd backend && pytest` or `cd frontend && npm test && cd ../backend && pytest`. Use no subshell `( ... )`, no `;`, `||` or `|`, and no other command. **Then apply the approved quality level:** Full pipeline and Tests only write `WRITE_TESTS` and `TEST` with that same command, Full pipeline enabling both and Tests only enabling `TEST` and writing `WRITE_TESTS` with `"enabled": false`; Minimal writes both with `"enabled": false`, even when a command is established. When no component is established, write both with `"enabled": false` and record the proposed command as pending. Never leave them to the defaults.

   **Every pending component gets its pending lines** (1f), one per test stage the quality level uses, whether or not the stages are enabled for the others.

   **`BUILD` and `VERIFY`:** `"enabled": true` only for Full pipeline, and only with commands established from the manifests (VERIFY also needs an applicable project type, below). Everything else writes them with `"enabled": false`: Tests only, Minimal, pending tooling, and project types VERIFY does not apply to. Record a pending proposal as pending.

   Full pipeline with an established test command, for example:
   ```json
   { "stages": {
     "WRITE_TESTS": { "enabled": true, "command": "<established>", "onExhaustion": "plan" },
     "TEST": { "enabled": true, "command": "<established>" },
     "BUILD": { "enabled": true, "command": "<established>" },
     "VERIFY": { "enabled": true, "startCommand": "<established>", "readinessUrl": "<established>" }
   }}
   ```

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

   A Python project with no `package.json` never gets `npm test`. Skip VERIFY for static sites, CLIs, libraries, packages, mobile-only apps and projects with no custom server.

4. Call `storybloq_phase_create` for each phase. When `p0` exists (a fresh init writes it, and a reused scaffold keeps it), the first goes `after: "p0"` without `atStart`; only on an empty roadmap does the first use `atStart: true`. Each later phase goes `after:` the id the previous call returned.
5. **Pass 1:** Call `storybloq_ticket_create` for each ticket WITHOUT `blockedBy` (ticket IDs don't exist until after creation). Keep the id each call returns.
6. Call `storybloq_issue_create` for each imported GitHub issue.
7. **Pass 2:** Call `storybloq_ticket_update` for each ticket that has `blockedBy` dependencies, using the ids the creation calls returned. Validate: no cycles, no self-references.
8. Call `storybloq_ticket_update` to mark already-complete tickets as `complete` (only those with code evidence).
9. Write the approved governance files (below), then git (below).
10. Call `storybloq_snapshot` to save the initial baseline.

**Narrate every MCP call as it happens**, one line each, never a bulk summary:
- `-> storybloq · phase "foundation" created`
- `-> storybloq · ticket T-003 "Account sign-in" created (phase: foundation)`
- `-> storybloq · T-015 wired: blocked by T-010, T-014`

**CLAUDE.md generation** (when approved in the package):

*Always present:* project purpose (1-2 sentences); the product outcome and first-version boundary; tech stack as stated by the user or the code; architecture as it exists or is planned; testing strategy (TDD when the RULES.md TDD line applies).

*Present when relevant:* deployment target, core entities and relationships (names, not full schemas), domain rules and workflows, identity model, tenancy, AI pattern and provider as chosen.

*Flagged for resolution:* undecided choices, marked TBD with the options.

**Sanitization:** Never copy secrets, tokens, credentials, API keys, connection strings, customer-identifying data, or internal-only endpoints into generated files.

**Verify after write.** After each `Write`, `Read` the file back and record its byte count. If the read fails, the write did not land -- the summary must say so ("CLAUDE.md write failed -- please create manually") rather than claim success. If it succeeds, include the size ("CLAUDE.md created (2,814 chars)"). A hallucinated "created" is indistinguishable from a real one without this step.

**RULES.md generation** (when approved) captures domain rules (e.g., "all monetary calculations use fixed-point arithmetic, not floats"), API constraints, data integrity rules (soft deletes, audit trails, idempotency) and testing requirements for core business logic.

**TDD recommendation:** Add it when the material shows business rules or workflows, multiple organisations, AI evaluation needs, or a sensitive domain. It is tied to those facts, not to judgement:

```
- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
```

Same sanitization and read-back rules as CLAUDE.md.

**REVIEW.md generation:** REVIEW.md is the project's review contract. Verification backends read it and ordinary coding sessions do not. `storybloq init` does not write it: a contract nobody agreed to is worse than no contract, so it is part of the package and the user edits or rejects it before it lands. `storybloq validate` warns when review backends are configured and REVIEW.md is absent or unparseable.

**Write `review-contract-template.md` verbatim.** Read it from the same directory as this skill file (if it is not found, tell the user to run `storybloq setup --client all`). The six definitions in it are fixed wording. What a project changes is the blocking classes, the Outside line, and whatever repository detail it adds BELOW the principles. Do not paraphrase it and do not reorder it: the lens backend receives only the first 3000 characters of REVIEW.md, head-truncated, so a principle moved below the repository detail is one a lens reviewer is asked to name without ever being shown it.

**The Outside line.** The template ships three lens ids on it. Entries there take a subject OUT of the contract, which means a finding on that subject is never capped and keeps the severity its reviewer gave it -- Outside is the loud side, not a way to silence anything. If the user asked to set exclusions, say that in one sentence, then write what they name as one plain comma-separated line under the heading. Never bullet the entries: the parser reads every line under that heading as entries and does not strip a `- ` prefix, so a bulleted entry matches nothing. An empty line is the widest coverage and the quietest gate, and `storybloq validate` warns about one.

Same sanitization and read-back rules as CLAUDE.md -- a REVIEW.md reported as created but never written is worse than none, because the warning that would have caught it stops firing.

**Git (autonomous mode depends on it).** Run `git rev-parse --show-toplevel` via `Bash`. If it errors and the package included git initialisation, run `git init` and narrate `-> git · repository initialized at <path>`. Then create or append to `.gitignore` any missing entries:
```
.story/snapshots/
.story/sessions/
.story/status.json
```

#### 1f. Post-Setup

**Summary.** Confirm what was created with concrete, verified counts: do not say "CLAUDE.md created" unless the read-back confirmed it, and do not give a ticket count unless every create call returned success; the counts must equal what is on disk. Example: "Created 5 phases, 18 tickets, 3 issues, CLAUDE.md (2,814 chars), RULES.md (1,206 chars). Git repo initialized." Then:

- the review status line of the approved package, in its exact form (1c2);
- one line per pending stage, and per component when the project has several, verbatim in this form: "Verification tooling to establish: <stage>: <proposed command> (pending: <reason>)", or with a component "Verification tooling to establish: <stage> (<component>): <proposed command> (pending: <reason>)".

**Initial handover and setup note.** Write an initial handover that records the product brief and its acceptance conditions, the coverage map, the answers from 1c, the conflicts and how they were ruled, the approved quality level with its established and pending commands, the review outcome or the recorded skip, and the checkpoint tickets with the stage-1 limitation. Also create a setup note (`storybloq_note_create`, tag `setup`) holding the coverage map and the pending verification tooling. The handover is the source of truth for setup decisions; CLAUDE.md is the project description.

Present a brief completion message and tell the user how to start:

"Your project is set up -- [X] phases, [Y] tickets, AGENTS.md/CLAUDE.md, and RULES.md created. Type **`/story`** in Claude Code or **`$story`** in Codex at the start of any session to load context and see what to work on. Or use **`/story auto`** / **`$story auto`** to work through the tickets autonomously."

Keep that prose to 2-3 sentences; the pending lines are not prose: they are never shortened, merged, bulleted or left to the note or handover instead. The system teaches itself through use -- `/story` loads context, shows status, and suggests next work.

**Hooks note (Claude Code).** When `storybloq setup` registered hooks, the session now carries context-pressure awareness (T-499): a SessionStart hook captures the auto-compact setting for the process, a synchronous UserPromptSubmit hook samples the transcript tail on every prompt and injects one line only when pressure is imperative or compact-needed, and the Stop hook samples at every turn end. Nothing to configure; `storybloq session intel` shows the current numbers. Machine-wide opt-out: `~/.claude/storybloq/config.json` `{"sessionIntel": {"enabled": false}}`, then re-run `storybloq setup` or any CLI command to remove the hooks.

**Design evaluation hint** (show only for a web, mobile or desktop app): add one line after the completion message: "Tip: Run `/story design` anytime to evaluate your frontend against [detected platform] best practices and generate improvement issues." Use the actual command that invoked this flow (e.g., `/story design` for standalone, `/story:go design` for plugin).

**Last check before sending the completion message.** Every stage, and every component, whose command you recorded as pending has its own line in the message itself, `WRITE_TESTS` and `TEST` on separate lines. The same line in the note or handover does not count.
