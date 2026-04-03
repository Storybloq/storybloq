# Setup Flow -- AI-Assisted Project Initialization

This file is referenced from SKILL.md when no `.story/` directory exists but project indicators are present. SKILL.md has already determined that setup is needed before routing here.

**Skill command name:** When this file references `/story` in user-facing output, use the actual command that invoked you (e.g., `/story` for standalone install, `/story:go` for plugin install). Same for `/story auto` -- use `/story:go auto` if invoked as a plugin.

**If arriving from Step 2b (scaffold detection):** The project already has an empty `.story/` scaffold but no tickets. Skip 1a and start at **1b. Existing Project -- Analyze**.

## Design Rules

These rules govern the entire setup flow. Follow them at every gate.

1. **Every "Not sure" recommendation must reference at least one prior answer.** Example: "Monolith -- you described a billing tool for solo contractors, keep it simple." Builds trust, teaches why the choice matters.
2. **Three-strike acceleration:** If user picks "Not sure" 3 out of any 4 gates, shift to: "Based on what you've told me, I'll recommend the rest. You can review everything in the proposal." Generate recommendations for remaining gates, surface them in the proposal as **editable assumptions** (clearly marked, not presented as certainties). **Exception:** auth model, sensitive domain, and primary AI pattern are never silently collapsed -- always ask these even in acceleration mode.
3. **Never three bounded-choice gates in a row without a break.** Breaks are: free-text questions, visible mini-summaries, or output. Insert a summary after each cluster of gates.
4. **Infer domain concerns from descriptions and entities, don't add gates.** If someone describes a collaborative whiteboard, detect realtime and generate websocket/presence tickets. If they describe a SaaS with pricing tiers, generate billing/subscription tickets. The interview captures *what*; the ticket generator knows *what that implies*.
5. **Unrecognized types (Other):** ask architecture + deployment, skip domain-specific gates unless free-text mentions data or users.
6. **Deployment recommendations are contextual, not stack-hardcoded.** Long-running processes, websockets, compliance, self-hosting preferences override the stack-based default.
7. **Claude as recommended LLM is a product-opinionated choice.** claudestory is built on Claude. State this explicitly: "Claude is the product default for the claudestory ecosystem. Choose based on your needs."
8. **Phrase gates as outcome decisions, not system jargon.** "How do users log in?" not "Auth model?" "What data does this system store?" not "Data layer?" "How should this go live?" not "Deployment target?"

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

If none found (empty or near-empty directory) -> skip to **1c. New Project -- Interview**.

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

When the detected stack has common architectural variants (e.g., App Router vs Pages Router, Expo vs bare), use AskUserQuestion to confirm instead of guessing. Only ask when the choice changes ticket topology. Otherwise infer silently.

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

After analysis, skip to **1d. Present Proposal**.

#### 1c. New Project -- Interview

This is a guided funnel using a mix of free text and structured choices via the `AskUserQuestion` tool. The flow adapts to the user's confidence level and project complexity.

**--- Cluster 1: Identity ---**

**Step 1:** Ask the user: "What are you building?" (free text -- project name and purpose)

Parse the answer. If the user already named a stack ("billing app in Next.js"), confirm it and skip surface + stack questions. Do NOT skip characteristics -- stack doesn't tell us if it's AI-powered, realtime, or marketplace.

**Step 2a:** Use `AskUserQuestion`:
- question: "What's the primary surface?"
- header: "Surface"
- options:
  - "Web app" -- SaaS, dashboard, admin panel
  - "Mobile app" -- iOS, Android, cross-platform
  - "API / backend service" -- REST, GraphQL, microservice
  - "Website / content site" -- landing page, blog, docs
- (Other always available: desktop, CLI, library, package, etc. If Other, ask one free-text follow-up for primary delivery target.)

**Step 2b:** Use `AskUserQuestion`:
- question: "Any special characteristics?"
- header: "Traits"
- multiSelect: true
- options:
  - "AI / LLM powered" -- chatbot, RAG, agent, AI features
  - "Realtime / collaboration" -- live updates, websockets, multiplayer
  - "Marketplace / multi-role" -- multiple user types, separate views
  - "Content-heavy / CMS" -- admin panel, editorial workflow
- (None of these always available)

Surface drives stack recommendations. Characteristics drive additional gates and inferred tickets. Composes cleanly: AI health app = Web + AI. Marketplace = Web + Marketplace. Scales by adding characteristics, not conflicting top-level types.

**Simple project fast path:** If surface is Website/content + no AI/realtime/marketplace traits + no brief detected, offer early exit: "This looks like a straightforward site. Want me to skip the detailed questions and go straight to milestones?" If yes: default to Astro + Vercel/Netlify, no auth, no data model. Skip clusters 2-4 entirely. Defaults shown in proposal as editable assumptions. Portfolio user flow: name -> Website -> None -> "Skip?" -> milestones -> proposal. ~4 steps total.

**--- Cluster 2: Stack + design ---**

**Step 3:** Use `AskUserQuestion` with top 3-4 stacks from the **Default Stack Recommendations** appendix at the bottom of this file. Context-aware: characteristics influence ranking. AI + Web -> Next.js + Vercel AI SDK rises to top. Skip if stack was already confirmed in Step 1.

**Step 4:** Framework-specific `AskUserQuestion` only when the choice changes ticket topology:
- Next.js: App Router (Recommended) vs Pages Router
- React Native: Expo (Recommended) vs bare
- ORM: Drizzle (SQL-friendly, lightweight) vs Prisma (higher-level DX, generated types)
- Other framework-specific choices from the appendix

**--- Summary break ---**
Show: "So far: [name] is a [surface] + [traits] built with [stack]."

**Step 4a:** Design source (skip for APIs, CLIs, libraries, backends). Use `AskUserQuestion`:
- question: "Do you have designs?"
- header: "Design"
- options:
  - "Yes, mockups / Figma" -- UI tickets reference designs. Usually skip component library question (implied by mockups, though user can override).
  - "Rough idea / sketches" -- UI tickets include design decisions
  - "No, start from scratch" -- generate design foundation tickets (color palette, typography, layout, component selection)
  - "Not sure yet"

Component library is inferred from the stack, not asked as a separate gate. Next.js defaults to shadcn/ui, Flutter to Material, React Native to NativeBase/Paper. Only ask if the stack doesn't have a clear default or the user picked "No, start from scratch" (where the component system is part of the design foundation tickets).

**--- Cluster 3: System structure ---**

**Step 4b:** System shape (skip for static sites, CLIs, libs). Use `AskUserQuestion`:
- question: "How should the system be structured?"
- header: "Shape"
- options:
  - "One app does everything" -- monolith, single deployable. Recommended for solo/small projects.
  - "Frontend + backend separately" -- separate frontend and API
  - "Frontend + managed backend (Supabase/Firebase)" -- BaaS handles DB, auth, storage. You build the frontend. Fastest path to MVP.
  - "Not sure -- recommend one"

BaaS as a first-class path. If selected: skip ORM choice (BaaS handles it), adjust deployment to match (Vercel + Supabase, or Firebase Hosting + Firebase). Auth gate still fires -- the user still decides what kind of auth (no auth, individual, team/org), but tickets generated are BaaS-specific (Supabase RLS policies, Firebase Security Rules) instead of custom middleware. Generates different tickets: BaaS setup, client SDK integration, security rules, instead of custom API + auth tickets.

**BaaS + AI edge case:** If the user also selected "AI / LLM powered" as a characteristic, AI gates still fire normally. For document ownership tickets (RAG + auth), reference "Supabase RLS policies" or "Firebase Security Rules" instead of "custom row-level access." The AI cluster's data model tickets adapt to the BaaS context.

**Step 4b-ii:** Execution model (skip for static sites, CLIs, libs, content sites, BaaS projects). Use `AskUserQuestion`:
- question: "How does processing work?"
- header: "Processing"
- options:
  - "Users request, system responds" -- standard web flow
  - "Background processing needed" -- queues, workers, scheduled tasks
  - "Both" -- user-facing + background processing
  - "Not sure -- recommend one"

Note: realtime/event-driven is inferred from the "Realtime" characteristic (design rule 4), not asked as an option here.

**Step 4b2:** Deployment (skip for libraries, CLIs, packages). Use `AskUserQuestion`:
- question: "How should this go live?"
- header: "Deploy"
- options:
  - "Easiest path" -- Vercel, Netlify, Railway, Fly.io. Connect repo, push to deploy. Minimal infrastructure work.
  - "Full control (AWS/GCP/Azure)" -- you manage everything. More setup: infrastructure-as-code, containers, CI/CD pipelines.
  - "Self-hosted / own servers" -- Docker Compose, nginx. You manage the hardware and networking.
  - "Not sure -- recommend one"

Recommendations are contextual: consider prior answers about compliance, long-running processes, websockets, self-hosting preferences -- not just stack.

**--- Summary break ---**
Show: "[name]: [shape], deploying to [platform]. Now let me understand the data."

**--- Cluster 4: Data + domain + auth ---**

**Step 4c:** Data model (skip for clearly stateless: static sites, simple CLIs, no persistence. Also skip for BaaS -- handled by BaaS schema setup.) Use `AskUserQuestion`:
- question: "What data does this system store?"
- header: "Data"
- options:
  - "I know the main things" -> follow up with free text: "What are the main objects and how they relate? (e.g., users have many projects, invoices belong to projects, projects have status workflows)"
  - "Help me figure it out" -> Claude proposes entities from brief/interview answers
  - "Keep it simple for now" -- start minimal, add later
  - "Nothing -- no database needed"

**Step 4d:** Domain complexity (skip for static sites, CLIs, libs, "no database", "keep it simple", BaaS). Use `AskUserQuestion`:
- question: "What kind of rules does this system have?"
- header: "Rules"
- multiSelect: true
- options:
  - "Workflows / approvals" -- things move through stages, need approval, have status transitions
  - "Multiple organizations / teams" -- different groups see different data, separate access
  - "None of the above" -- straightforward data, no special rules (exclusive: if selected, deselects the others)
  - "Not sure -- recommend one"

Multi-select because these are orthogonal: a system can have both workflows AND org scoping. "None of the above" is the exclusive fallback for simple CRUD projects.

**Step 4e:** Auth / identity (skip for static sites, CLIs, libs, packages. Do NOT skip for "no database" -- auth can be external/stateless: JWT, Clerk, Auth0, API keys). Use `AskUserQuestion`:
- question: "How do users log in?"
- header: "Auth"
- options:
  - "No login needed" -- single user or public access
  - "Individual accounts" -- email/password, social login. Easiest setup: Firebase Auth, Clerk, or Supabase Auth.
  - "Team / organization accounts" -- multi-user, org scoping
  - "External auth / SSO" -- enterprise IdP, OAuth providers
- (Other always available: API keys only, guest+optional, machine clients, etc. + "Not sure -- recommend one")

When recommending auth setup for individual accounts, suggest Firebase Auth or Clerk as the easiest options. These handle email/password, social login, session management, and JWT with minimal code. Only recommend custom auth when the user has specific requirements.

**Step 4f:** Sensitive domain. This is the canonical sensitive domain gate for ALL projects. The AI safety cluster (Cluster 5) references this answer instead of re-asking. Bias toward asking -- skip only for projects that are clearly non-sensitive (portfolio, blog, dev tool, game). Ask for anything with user data, business transactions, or professional use cases. Use `AskUserQuestion`:
- question: "Is this in a sensitive/regulated domain?"
- header: "Domain"
- options:
  - "Yes (health, legal, finance, compliance)" -- audit logging, privacy controls, disclaimers, stricter testing, compliance tickets
  - "No"
  - "Not sure"

This exists outside the AI branch because a non-AI health billing platform still needs audit trails and compliance tickets.

**--- Cluster 5: AI-specific (only when AI characteristic selected in Step 2b) ---**

**AI pattern:** Use `AskUserQuestion`:
- question: "What's the primary AI pattern?"
- header: "AI Pattern"
- options:
  - "RAG" -- knowledge base Q&A, document search, domain answers
  - "Agentic / tool use" -- AI that takes actions, calls APIs
  - "Conversational" -- chatbot, assistant, guided interaction
  - "Structured generation" -- extract data, classify, generate reports, transform inputs to JSON
- (Other + "Not sure -- recommend one")

Follow up: "Any secondary capabilities?" (multiSelect, optional). Same options minus the one already picked. This handles real AI products that are RAG + conversational, or agentic + structured generation.

**LLM provider:** Use `AskUserQuestion`:
- question: "Which LLM provider?"
- header: "LLM"
- options:
  - "Anthropic Claude (product default)" -- Claude API / Agent SDK. claudestory ecosystem default; choose based on your needs.
  - "OpenAI" -- GPT models
  - "Google Gemini" -- multimodal, good pricing
  - "Self-hosted" -- Qwen, Llama, Mistral via Ollama/vLLM
- (Other: multi-provider, custom, etc.)

**AI processing:** Use `AskUserQuestion`:
- question: "How does AI processing work?"
- header: "Processing"
- options:
  - "Synchronous" -- user sends, waits for response
  - "Async / background" -- ingestion, batch, workers
  - "Both" -- sync chat + async ingestion
  - "Not sure -- recommend one"

**Vector database (if RAG primary or secondary):** Use `AskUserQuestion`:
- question: "Vector database?"
- header: "Vector DB"
- options:
  - "pgvector (Recommended)" -- PostgreSQL extension, simple
  - "Pinecone" -- managed, scalable
  - "Qdrant" -- open-source, self-hosted
  - "Not sure -- recommend one"

**AI audience + safety:** Use `AskUserQuestion`:
- question: "Who interacts with the AI output?"
- header: "Audience"
- options:
  - "Public users" -- guardrails, content filtering, rate limiting
  - "Internal users" -- lighter guardrails
  - "Backend / pipeline" -- skip safety layer
  - "Not sure -- recommend one"

If public or internal, check whether sensitive domain was already answered in Step 4f. If yes, use that answer. If Step 4f was skipped (e.g., AI-only project where sensitive domain wasn't obvious from the description), ask now with `AskUserQuestion`:
- question: "Is this a sensitive domain?"
- header: "Domain"
- options:
  - "Yes (health, legal, finance)" -- audit logging, evals, disclaimers, stricter testing
  - "No"

Sensitive domain is orthogonal to audience: an internal health app still needs audit logging.

AI gates generate tickets the current flow would miss:
- LLM client setup (provider SDK, error handling, retries, streaming)
- Prompt engineering / system prompt design
- RAG pipeline (if RAG): ingestion, chunking, embedding, retrieval, reranking
- Secondary AI capabilities as additional tickets
- Guardrails / safety layer (if user-facing)
- Evaluation framework (how do you know it's working?)
- Cost monitoring / token tracking
- Conversation/session storage
- Background workers (if async)
- Document ownership model (if RAG + auth)
- Audit logging + disclaimers (if sensitive domain)

**--- Quality checks (skip for static sites, content-only, simple portfolios) ---**

**Step 4g:** Quality checks for autonomous mode. Use `AskUserQuestion`:
- question: "How should I handle quality checks when working on your tickets?"
- header: "Quality"
- options:
  - "Full pipeline (Recommended)" -- I'll write tests first (TDD), run them after building, smoke test your endpoints, and validate the build
  - "Tests only" -- I'll run tests after building, skip endpoint and build checks
  - "Minimal" -- just build and commit, no automated checks
- (Other always available for custom configuration)

If domain complexity includes workflows/approvals or sensitive domain was selected, bias toward "Full pipeline" and explain why: "Recommended because your project has [business rules / sensitive domain] -- TDD catches bugs before they ship."

Quality level maps to autonomous recipe stages (configured in step 1e):
- **Full pipeline:** WRITE_TESTS + TEST + VERIFY + BUILD (all enabled)
- **Tests only:** TEST (enabled), others disabled
- **Minimal:** all stages disabled

Stage-specific details (test command, dev server URL, build command) are inferred from the stack silently -- never shown to the user.

**--- Milestones ---**

**Step 5:** "What are the major milestones?" (free text)

**Step 6:** "What's the first thing to build?" (free text)

Propose phases and initial tickets from all gathered answers.

#### 1d. Present Proposal

Show the user a structured proposal (table format, not raw JSON):
- **Project:** name, type, language
- **System shape + execution model**
- **Deployment target**
- **Core entities + key relationships** (if defined)
- **Domain complexity** (workflows, org scoping, or simple CRUD)
- **Auth / identity model**
- **AI pattern + provider + processing** (if AI project)
- **Quality checks** (Full pipeline / Tests only / Minimal)
- **Any inferred concerns** (realtime, billing, etc. per design rule 4)
- **Editable assumptions** (if three-strike acceleration was used, clearly marked)
- **Unresolved decisions**
- **Phases** (table: id, name, description)
- **Tickets per phase** (title, type, status)
- **Issues** (if GitHub import was used)

Before asking for approval, briefly explain what they're looking at:

"**How this works:** Phases are milestones in your project's development. They track progress from setup to shipping. Tickets are specific work items within each phase. After setup, typing `/story` at the start of any Claude Code session loads this context automatically. Claude will know your project's state, what was done last session, and what to work on next."

Then use ONE `AskUserQuestion` that combines approval and refinement depth (do not ask two separate questions):
- question: "How should I proceed with this proposal?"
- header: "Proceed"
- options:
  - "Refine + get a second opinion (Recommended)" -- I'll add descriptions, dependencies, and sizing, then have an independent reviewer check my work before creating anything
  - "Refine tickets" -- I'll add descriptions, figure out dependencies, and flag oversized tickets
  - "Create as-is" -- create tickets now as shown
  - "Adjust first" -- I want to change phases or tickets before proceeding
- (Other always available for free-text feedback)

If "Adjust first": ask what they want to change, iterate, then re-show this same AskUserQuestion. Loop until they pick a create/refine option.

If "Create as-is" and no brief exists: warn "Note: tickets will have titles only -- you can add descriptions later." Then proceed to **1e. Execute on Approval**.

#### 1d2. Refinement and Review

**IMPORTANT: Do NOT skip this section. Do NOT go straight to creating tickets.** The user chose refinement and/or review. You must complete all steps below before moving to 1e (Execute).

**Step A: Refine the proposal internally.** Do not show intermediate work to the user. Use brief/PRD notes from 1b, or infer from interview answers if no brief.

What to do:
- Add 3-4 sentence descriptions to each ticket
- Infer `blockedBy` from phase ordering and domain logic
- Flag and split oversized tickets (3+ entities, API+UI in one, 3+ models)
- Cross-reference brief entities against tickets, add missing ones
- Detect core differentiator -- decompose if single ticket
- Surface undecided tech choices

**Step B: Run independent review (if user chose "Refine + review").** This step is REQUIRED when the user selected the review option. Do NOT skip it.
- If `review_plan` MCP tool is available, call it with the full refined proposal.
- Otherwise spawn an independent Claude agent to audit for gaps.
- If neither is available, note "Review skipped -- no review backends available."
- Maximum 2 review rounds.
- Incorporate findings into the proposal.

**Step C: Show the compact summary to the user.** This is REQUIRED. Do NOT go to 1e without showing this. Do NOT show every ticket with its description -- show a summary of what changed:

```
Refinement complete. Here's what changed:

- Added descriptions to 14 tickets
- Added 8 dependency links (blockedBy chains)
- No tickets flagged for splitting (all well-scoped)
- [If review ran] Independent review: 2 suggestions incorporated
  - T-005 split into T-005a/T-005b (was too broad)
  - T-012 added blockedBy T-006 (missing dependency)

Updated proposal:

[Show the same phase + ticket table as before, but now with a "Deps" column]

| Ticket | Title                    | Phase      | Deps      |
|--------|--------------------------|------------|-----------|
| T-001  | Project setup            | foundation | --        |
| T-002  | Database schema design   | foundation | T-001     |
| T-006  | Auth setup               | foundation | T-001     |
| ...    | ...                      | ...        | ...       |
```

**Step D: Ask user to approve before creating.** This is REQUIRED. Do NOT proceed to 1e without this approval.

Use `AskUserQuestion`:
- question: "Ready to create?"
- header: "Create"
- options:
  - "Create everything (Recommended)"
  - "Let me adjust first" -- iterate, then re-ask
  - "Show me the full details" -- expand all ticket descriptions (for users who want to inspect)

Only proceed to **1e. Execute on Approval** after the user selects "Create everything."

#### 1e. Execute on Approval

**Two-pass ticket creation:**

1. Call `claudestory_init` with name, type, language -- after this, all MCP tools become available dynamically

1b. **Configure autonomous recipe stages** based on the quality check answer from Step 4g. Construct a JSON object and apply via Bash:
    ```
    claudestory config set-overrides --json '<JSON>'
    ```

    **Quality level -> stage mapping:**

    Full pipeline:
    ```json
    { "stages": {
      "WRITE_TESTS": { "enabled": true, "onExhaustion": "plan" },
      "TEST": { "enabled": true, "command": "<detected>" },
      "VERIFY": { "enabled": true, "startCommand": "<detected>", "readinessUrl": "<detected>" },
      "BUILD": { "enabled": true, "command": "<detected>" }
    }}
    ```

    Tests only:
    ```json
    { "stages": {
      "TEST": { "enabled": true, "command": "<detected>" }
    }}
    ```

    Minimal: no overrides needed (default recipe handles it).

    **Stack -> command detection (fill in `<detected>` values):**

    | Stack | Test command | Dev server | Readiness URL | Build command |
    |-------|-------------|------------|---------------|---------------|
    | Next.js | `npm test` | `npm run dev` | `http://localhost:3000` | `npm run build` |
    | Nuxt | `npm test` | `npm run dev` | `http://localhost:3000` | `npm run build` |
    | SvelteKit | `npm test` | `npm run dev` | `http://localhost:5173` | `npm run build` |
    | Vite (React/Vue) | `npm test` | `npm run dev` | `http://localhost:5173` | `npm run build` |
    | FastAPI | `pytest` | `uvicorn main:app --reload` | `http://localhost:8000` | -- |
    | Django | `python manage.py test` | `python manage.py runserver` | `http://localhost:8000` | -- |
    | Express/Fastify | `npm test` | `npm run dev` | `http://localhost:3000` | `npm run build` |
    | Go | `go test ./...` | `go run .` | `http://localhost:8080` | -- |
    | Rust | `cargo test` | -- | -- | `cargo build` |
    | Flutter | `flutter test` | -- | -- | `flutter build` |
    | Default | `npm test` | `npm run dev` | `http://localhost:3000` | `npm run build` |

    Skip VERIFY when: static site, CLI, library, package, mobile-only, BaaS (no custom server).
    Skip BUILD when: Python, Go (compiled at test time).

2. Call `claudestory_phase_create` for each phase -- first phase with `atStart: true`, subsequent with `after: <previous-phase-id>`
3. **Pass 1:** Call `claudestory_ticket_create` for each ticket WITHOUT `blockedBy` (ticket IDs don't exist until after creation)
4. Call `claudestory_issue_create` for each imported GitHub issue
5. **Pass 2:** Call `claudestory_ticket_update` for each ticket that has `blockedBy` dependencies, now that all IDs exist. Validate: no cycles, no self-references.
6. Call `claudestory_ticket_update` to mark already-complete tickets as `complete`
7. Call `claudestory_snapshot` to save initial baseline

**CLAUDE.md generation:** If a brief/PRD was read in step 1b AND no `CLAUDE.md` exists in the project root, use `AskUserQuestion` for governance files:
- question: "Write project governance files?"
- header: "Files"
- options:
  - "Write both (Recommended)" -- CLAUDE.md and RULES.md
  - "CLAUDE.md only"
  - "RULES.md only"
  - "Skip" -- I'll write them manually

**If writing CLAUDE.md**, generate with tiered structure:

*Always present:*
- Project purpose (1-2 sentences)
- Tech stack and key dependencies (including any pivots from the brief, with rationale)
- Architecture pattern (shape + execution model) + rationale
- Testing strategy (TDD when applicable -- see RULES.md generation)

*Present when relevant:*
- Deployment target + hosting model
- Core entities + key relationships (names + relationships, not full schemas)
- Domain complexity (workflows, org scoping)
- Auth / identity model
- AI pattern + provider + processing model
- Tenancy model
- State machines / workflows

*Flagged for resolution:*
- Undecided tech choices (flagged as TBD with options)

**Sanitization:** Never copy secrets, tokens, credentials, API keys, connection strings, customer-identifying data, or internal-only endpoints into generated files.

Show a preview of the generated content to the user. Only write after explicit approval.

**If writing RULES.md**, generate capturing:
- Domain-specific rules (e.g., "all monetary calculations use fixed-point arithmetic, not floats")
- API design constraints (versioning, auth requirements, response format)
- Data integrity rules (soft deletes, audit trails, idempotency requirements)
- Testing requirements for core business logic

**TDD recommendation:** Add when domain complexity includes "Workflows/approvals" or "Multiple organizations/teams", or project has AI evaluation needs, or project has a sensitive domain. This is mechanical -- tied directly to gate answers, no judgment calls:

```
- TDD for business logic: write tests first for core functional code
  (calculations, validation rules, state machines, data transformations,
  AI evaluation harnesses). Tests define the contract before implementation.
```

Same sanitization and preview rules as CLAUDE.md. Only write after explicit approval.

#### 1f. Post-Setup

After creation completes:
- Confirm what was created (e.g., "Created 5 phases, 18 tickets, 3 issues, CLAUDE.md, and RULES.md")
- Check if `.gitignore` includes `.story/snapshots/` (warn if missing -- snapshots should not be committed)
- Write an initial handover documenting the setup decisions. Explicitly capture which gates were answered and what was chosen: surface, characteristics, stack, system shape, execution model, deployment, data model, domain complexity, auth model, sensitive domain, quality checks level, AI pattern/provider/processing (if applicable), design source. This handover is the source of truth for decisions; CLAUDE.md is the project description.

Present a brief completion message and tell the user how to start:

"Your project is set up -- [X] phases, [Y] tickets, CLAUDE.md, and RULES.md created. Type **`/story`** at the start of any session to load context and see what to work on. Or type **`/story auto`** to let me work through the tickets autonomously."

Keep it to 2-3 sentences. The system teaches itself through use -- `/story` loads context, shows status, and suggests next work. No need for a manual.

**Design evaluation hint** (show only when project surface is Web app, Mobile app, or Desktop app):

Add one more line after the completion message: "Tip: Run `/story design` anytime to evaluate your frontend against [detected platform] best practices and generate improvement issues."

Note: Use the actual command that invoked this flow (e.g., `/story design` for standalone, `/story:go design` for plugin).

---

## Appendix: Default Stack Recommendations

Choose based on team familiarity, hosting model, and product shape; these are defaults, not absolutes.

### Web application
- Next.js + TypeScript (Recommended) -- full-stack React, SSR, API routes, easiest deploy via Vercel. Best for: solo devs, startups, fast shipping.
- SvelteKit + TypeScript -- lighter, less boilerplate, excellent DX. Best for: minimal framework overhead.
- Django + Python -- batteries-included, built-in admin, ORM, auth. Best for: data-heavy apps, Python teams.
- Rails -- convention-over-config. Best for: fastest 0-to-MVP.

### AI / LLM application
- Next.js + TypeScript + Vercel AI SDK (Recommended for web AI) -- streaming UI, provider-agnostic. Best for: AI products with web interface.
- Python + FastAPI + provider SDK -- direct integration, no orchestration overhead. Best for: most AI apps. Add LangChain only when multi-step orchestration matters.
- Python + FastAPI + LlamaIndex -- simpler for pure retrieval. Best for: knowledge base Q&A.
- TypeScript + Anthropic SDK / Agent SDK -- Claude-native. Best for: agents and tool use.

### BaaS / backendless
- Supabase (Recommended) -- Postgres, auth, realtime, storage built-in. Best for: fast MVP, solo devs, speed over control.
- Firebase -- Google ecosystem, NoSQL, good mobile support. Best for: mobile-first, Google Cloud teams.
- Convex -- reactive database, no REST. Best for: realtime-first apps.

### Website / content site
- Astro (Recommended) -- zero JS default, islands. Best for: marketing, blogs, docs.
- Next.js -- when site needs dynamic features.
- Hugo -- pure static, fast builds. Best for: large content sites.
- Docusaurus -- documentation sites. React-based.

### Mobile app
- Flutter + Dart -- cross-platform, consistent UI, single codebase. Best for: mobile-primary projects wanting one tightly controlled UI system.
- React Native + Expo + TypeScript -- cross-platform, shares logic with web. Best for: teams already using React.
- Swift + SwiftUI -- iOS/macOS native. Best for: iOS-only, deep OS integration.
- Kotlin + Compose -- Android native. Best for: Android-only.

(Neither Flutter nor React Native is a universal winner. Recommendation depends on team context.)

### Full-stack / multi-service
- Next.js + NestJS + PostgreSQL -- TypeScript end-to-end, structured API. Best for: strong typing, module organization.
- Next.js + FastAPI + PostgreSQL -- TS frontend, Python API. Best for: AI features in the API.
- React + Go + PostgreSQL -- lightweight. Best for: high-throughput services.
- Monorepo (Turborepo/Nx) when sharing types/utils; polyrepo when teams are independent.

### Desktop app
- Tauri + TypeScript -- cross-platform, Rust backend, small binaries. Best for: lightweight tools.
- Electron + TypeScript -- cross-platform, largest ecosystem. Best for: feature-rich apps.
- Swift + SwiftUI -- macOS native. Best for: Mac-only.
- .NET MAUI -- Windows + macOS. Best for: C#/.NET teams.

### API / backend
- Node.js + Fastify + TypeScript -- fast, lean. Best for: microservices, performance.
- NestJS + TypeScript -- structured, enterprise-friendly. Best for: larger teams, complex domains.
- Python + FastAPI -- auto-docs, async. Best for: Python teams, AI, data-heavy.
- Go -- compiled, high-throughput. Best for: infrastructure services.
- Rust + Axum -- maximum performance. Best for: systems-level APIs.

### CLI tool
- TypeScript + Node.js -- fast to build, npm distribution.
- Rust -- single binary, fast. Best for: performance, wide distribution.
- Go -- single binary, fast compile. Best for: DevOps, infra CLIs.
- Python + Typer -- fastest to prototype. Best for: internal tools.

### Library / package
- TypeScript -- npm, widest web reach.
- Rust -- crates.io, WASM target.
- Python -- PyPI, data science.

### Framework-specific choices (ask only when it affects tickets)
- Next.js: App Router (Recommended) vs Pages Router
- React Native: Expo (Recommended) vs bare
- Node.js ORM: Drizzle (SQL-friendly, lightweight) vs Prisma (higher-level DX, generated types)
- Python ORM: SQLAlchemy vs Django ORM
- Database: PostgreSQL (Recommended), SQLite (local), MongoDB (documents), MySQL (legacy)
- Component library (web): shadcn/ui (Recommended for Next.js), Material UI, Chakra UI, None/custom
- Component library (mobile): default to framework built-in (Flutter Material, RN Paper/NativeBase)

### Deployment / hosting
- Vercel (Recommended for Next.js/Astro) -- zero-config, git push deploy
- Netlify -- static + serverless
- Railway -- full-stack, databases included
- Fly.io -- containers, global edge
- AWS / GCP / Azure -- maximum control, complex setup
- Self-hosted / VPS -- Docker Compose + nginx, full control

### AI-specific choices
- LLM: Anthropic Claude (product default), OpenAI, Google Gemini, Self-hosted (Qwen/Llama/Mistral), Multi-provider
- Pattern: RAG, Agentic, Conversational, Structured generation (composable: primary + secondary)
- Processing: Sync, Async, Both
- Vector DB: pgvector (Recommended), Pinecone, Qdrant, Chroma
- Safety: by audience (public/internal/backend) + domain sensitivity (separate axis)
