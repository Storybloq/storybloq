# Setup Flow -- AI-Assisted Project Initialization

This file is referenced from SKILL.md when no `.story/` directory exists but project indicators are present. SKILL.md has already determined that setup is needed before routing here.

**If arriving from Step 2b (scaffold detection):** The project already has an empty `.story/` scaffold but no tickets. Skip 1a and start at **1b. Existing Project -- Analyze**.

## AI-Assisted Setup Flow

This flow creates a meaningful `.story/` project instead of empty scaffolding. Claude analyzes the project, proposes structure, and creates everything via MCP tools.

#### 1a. Detect Project Type

Check for project indicators to determine if this is an **existing project** or a **new/empty project**:

- `package.json` -> npm/node (read `name`, `description`, check for `typescript` dep)
- `Cargo.toml` -> Rust
- `go.mod` -> Go
- `pyproject.toml` / `requirements.txt` -> Python
- `*.xcodeproj` / `Package.swift` -> Swift/macOS
- `*.sln` / `*.csproj` -> C#/.NET
- `Gemfile` -> Ruby
- `build.gradle.kts` / `build.gradle` -> Android/Kotlin/Java (or Spring Boot)
- `pubspec.yaml` -> Flutter/Dart
- `angular.json` -> Angular
- `svelte.config.js` -> SvelteKit
- `.git/` -> has version history

If none found (empty or near-empty directory) -> skip to **1c. New Project Interview**.

#### 1b. Existing Project -- Analyze

Before diving into analysis, briefly introduce claudestory to the user:

"Claude Story tracks your project's roadmap, tickets, issues, and session handovers in a `.story/` directory. Every Claude Code session starts by reading this context, so you never re-explain your project from scratch. Sessions build on each other: decisions, blockers, and lessons carry forward automatically. I'll analyze your project and propose a structure. You can adjust everything before I create anything."

Keep it to 3-4 sentences. Not a sales pitch, just enough that the user knows what they're opting into and that they're in control.

Read these files to understand the project (skip any that don't exist, skip files > 50KB):

1. **README.md** -- project description, goals, feature list, roadmap/TODO sections
2. **Package manifest** -- project name, dependencies, scripts
3. **CLAUDE.md** -- existing project spec (if any)
4. **Top-level directory listing** -- identify major components (src/, test/, docs/, etc.)
5. **Git summary** -- `git log --oneline -20` for recent work patterns
6. **GitHub issues (ask user first)** -- `gh issue list --limit 30 --state open --json number,title,labels,body,createdAt`. If gh fails (auth, rate limit, no remote), skip cleanly and note "GitHub import skipped: [reason]"
7. **Project brief / PRD scan** -- glob for `*.md` files in project root and `docs/`. For each candidate (exclude CHANGELOG, LICENSE, CONTRIBUTING, README which is already read above):
   - If file is >100 lines and contains headings matching "entities", "schema", "architecture", "tech stack", "roadmap", "phases", "milestones", "screens", or "API" -- treat as a project brief
   - Read at most 2 candidate briefs (prefer the longest matching file)
   - Extract into structured notes for use in later steps: entity schemas (names, fields, relationships), technical decisions (stack choices, architecture), screen/page inventory, business rules and domain logic, key constraints
   - Summarize once here; do not re-read the full brief at later steps

**Brief precedence:** If multiple sources describe the project:
- Existing `CLAUDE.md` is the authority for current project state
- A PRD/brief file is the authority for proposed scope and specifications
- README is a product overview (may be outdated or aspirational)
- If two briefs disagree on stack, entities, or milestones, ask the user to choose

**Framework-specific deep scan** -- after detecting the project type in 1a, scan deeper into framework conventions to understand architecture:

- **Next.js / Nuxt:** Check `app/` vs `pages/` routing, scan `app/api/` or `pages/api/` for API routes, read `next.config.*` / `nuxt.config.*`, check for middleware.
- **Express / Fastify / Koa:** Scan for route files (`routes/`, `src/routes/`), look for `router.get/post` patterns, identify service/controller layers.
- **NestJS:** Read `nest-cli.json`, scan `src/` for `*.module.ts`, check for controllers and services.
- **React (CRA / Vite) / Vue / Svelte:** Check `src/components/` structure, look for state management imports (redux, zustand, pinia), identify routing setup.
- **Angular:** Read `angular.json`, scan `src/app/` for modules and components, check for services and guards.
- **Django / FastAPI / Flask:** Check for `manage.py`, scan for app directories or router files, look at models and migrations.
- **Spring Boot:** Check `pom.xml` or `build.gradle` for Spring deps, scan `src/main/java` for controller/service/repository layers.
- **Rust:** Check `Cargo.toml` for workspace members, scan for `mod.rs` / `lib.rs` structure, identify crate types.
- **Swift / Xcode:** Check `.xcodeproj` or `Package.swift`, identify SwiftUI vs UIKit, scan for targets.
- **Android (Kotlin/Java):** Check `build.gradle.kts`, scan `app/src/main/` for activity/fragment/composable structure, check `AndroidManifest.xml`, identify Compose vs XML layouts.
- **Flutter / Dart:** Check `pubspec.yaml`, scan `lib/` for feature folders (models/, screens/, widgets/, services/), check for state management imports (provider, riverpod, bloc).
- **Go:** Check `go.mod`, scan for `cmd/` and `internal/`/`pkg/`, check for `Makefile`.
- **Monorepo:** If `packages/`, `apps/`, or workspace config detected, list each package with its purpose before proposing phases.
- **Other:** Scan `src/` two levels deep and identify dominant patterns (MVC, service layers, feature folders).

**Derive project metadata:**
- **name**: from package manifest `name` field, or directory name
- **type**: from package manager (npm, cargo, pip, etc.)
- **language**: from file extensions and manifest

**Assess project stage** from the data -- don't use fixed thresholds. A project with 3 commits and a half-written README is greenfield. A project with 500+ commits, test suites, and release tags is mature. A project with 200 commits and active PRs is active development. Use your judgment.

**Propose 3-7 phases** reflecting the project's actual development trajectory. Examples:
- Library: setup -> core-api -> documentation -> testing -> publishing
- App: mvp -> auth -> data-layer -> ui-polish -> deployment
- Mid-development project: capture completed work as early phases, then plan forward

**Propose initial tickets** per active phase (2-5 each), based on:
- README TODOs or roadmap sections (treat as hints, not ground truth)
- GitHub issues if imported -- infer from label semantics: bug/defect labels -> issues, enhancement/feature labels -> tickets
- Brief entity specs and roadmap sections (if a brief was found)
- Obvious gaps (missing tests, no CI, no docs, etc.)
- If more than 30 GitHub issues exist, note "Showing 30 of N. Additional issues can be imported later."

**Important:** Only mark phases complete if explicitly confirmed by user or docs -- do NOT infer completion from git history alone.

#### 1c. New Project -- Interview

Ask the user:
1. "What are you building?" -- project name and purpose
2. "What's the tech stack?" -- language, framework, project type
3. "What are the major milestones?" -- helps define phases
4. "What's the first thing to build?" -- seeds the first ticket

Propose phases and initial tickets from the answers.

#### 1d. Present Proposal

Show the user a structured proposal (table format, not raw JSON):
- **Project:** name, type, language
- **Phases** (table: id, name, description)
- **Tickets per phase** (title, type, status)
- **Issues** (if GitHub import was used)

Before asking for approval, briefly explain what they're looking at:

"**How this works:** Phases are milestones in your project's development. They track progress from setup to shipping. Tickets are specific work items within each phase. After setup, typing `/story` at the start of any Claude Code session loads this context automatically. Claude will know your project's state, what was done last session, and what to work on next."

Then ask for approval with clear interaction guidance:

"Does this look right? You can:
- Adjust any phase (rename, reorder, add, remove)
- Change tickets (add, remove, rephrase, move between phases)
- Mark phases as complete or in-progress
- Split or merge phases

I'll iterate until you're happy, then create everything."

#### 1d2. Refinement Pass (optional)

After the user approves the phase and ticket structure, offer: **"Want me to refine these tickets with detailed descriptions, dependencies, and sizing?"**

If the user declines, skip to **1e. Execute on Approval** -- current behavior is preserved.

If the user accepts, refine the proposal. If a brief/PRD was found in step 1b, use those structured notes. If no brief exists (e.g., the user came through step 1c interview), infer descriptions from the interview answers and propose standard dependencies based on the tech stack.

**Descriptions:** Extract specs from the brief into ticket descriptions -- entity fields, acceptance criteria, API contracts, business rules. If no brief, write descriptions based on the user's interview answers and common patterns for the chosen stack. Cap each description at 3-4 sentences. Keep them actionable, not exhaustive. The goal is "enough to implement without re-reading the brief."

**Dependencies:** Infer `blockedBy` relationships from phase ordering and domain logic:
- Schema/migration tickets block CRUD API tickets
- Auth tickets block protected route tickets
- CRUD/model tickets block business logic that depends on them
- API tickets block UI tickets that consume them

**Sizing check:** Flag tickets that cover more than one major concern:
- Mentions 3+ distinct entities in one ticket
- Covers both API implementation and UI in one ticket
- Handles 3+ distinct models, modes, or billing types in one ticket
- Offer to split flagged tickets into sub-tasks

**Missing entity detection:** Cross-reference entities and concepts mentioned in the brief against the proposed ticket list. Flag entities that appear in the brief but have no corresponding ticket. Common misses: user profile/settings, notification system, seed data, admin/config screens.

**Core differentiator detection:** Identify the ticket(s) covering what the brief emphasizes most (the main value proposition). If the core differentiator is a single ticket, flag it for decomposition -- it likely needs 3-4 sub-tickets.

**Undecided tech choices:** Surface technology decisions mentioned in the brief as "X or Y" that haven't been resolved. Present them as explicit decisions to make before implementation starts (e.g., "ORM: Drizzle or Prisma -- decide before T-002").

After refinement, present the updated proposal showing what changed: added descriptions, new blockedBy links, split tickets, newly created tickets for missing entities, and flagged decisions. Wait for the user to approve the refined proposal before continuing.

#### 1d3. Proposal Review (optional)

After refinement (or after initial approval if refinement was declined), offer: **"Want me to have this proposal independently reviewed before creating everything?"**

If the user declines, skip to **1e. Execute on Approval**.

If the user accepts, run an independent review of the full proposal (phases, tickets, descriptions, dependencies):

**Backend selection:** Use the same review backend selection as autonomous mode -- if the `review_plan` MCP tool is available, use it (pass the full proposal as the plan document); otherwise spawn an independent Claude agent with the brief + proposal and ask it to audit for gaps, sizing issues, missing dependencies, and architectural concerns. If neither is available, skip review with a note.

**Review cap:** Maximum 2 review rounds for setup proposals.

**After review findings come back:**
- Present ALL findings to the user as a summary diff: added tickets, changed descriptions, new dependencies, files to be generated.
- User approves the final version before any execution. Do not auto-incorporate findings.
- If the user requests changes based on findings, update the proposal and optionally re-review.

#### 1e. Execute on Approval

**Two-pass ticket creation:**

1. Call `claudestory_init` with name, type, language -- after this, all MCP tools become available dynamically
2. Call `claudestory_phase_create` for each phase -- first phase with `atStart: true`, subsequent with `after: <previous-phase-id>`
3. **Pass 1:** Call `claudestory_ticket_create` for each ticket WITHOUT `blockedBy` (ticket IDs don't exist until after creation)
4. Call `claudestory_issue_create` for each imported GitHub issue
5. **Pass 2:** Call `claudestory_ticket_update` for each ticket that has `blockedBy` dependencies, now that all IDs exist. Validate: no cycles, no self-references.
6. Call `claudestory_ticket_update` to mark already-complete tickets as `complete`
7. Call `claudestory_snapshot` to save initial baseline

**CLAUDE.md generation:** If a brief/PRD was read in step 1b AND no `CLAUDE.md` exists in the project root:

Generate a `CLAUDE.md` capturing:
- Project purpose (1-2 sentences)
- Tech stack and key dependencies (including any pivots from the brief, with rationale)
- Architecture decisions (from brief's technical decisions table, or inferred from stack)
- Entity model summary (entity names + key relationships, not full field lists)
- Key constraints and non-negotiables
- Undecided tech choices (flagged as TBD with options)

**Sanitization:** Never copy secrets, tokens, credentials, API keys, connection strings, customer-identifying data, or internal-only endpoints into generated files.

Show a preview of the generated content to the user. Only write after explicit approval.

**RULES.md generation:** If development constraints are derivable from the brief AND no `RULES.md` exists:

Generate a `RULES.md` capturing:
- Domain-specific rules (e.g., "all monetary calculations use fixed-point arithmetic, not floats")
- API design constraints (versioning, auth requirements, response format)
- Data integrity rules (soft deletes, audit trails, idempotency requirements)
- Testing requirements for core business logic

Same sanitization and preview rules as CLAUDE.md. Only write after explicit approval.

#### 1f. Post-Setup

After creation completes:
- Confirm what was created (e.g., "Created 5 phases, 18 tickets, 3 issues, CLAUDE.md, and RULES.md")
- Check if `.gitignore` includes `.story/snapshots/` (warn if missing -- snapshots should not be committed)
- Write an initial handover documenting the setup decisions
- Setup complete. Continue with **Step 2: Load Context** in SKILL.md (already in your context). Execute all 6 steps -- the project now has data to load.
