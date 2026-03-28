---
name: story
description: Cross-session context persistence for AI coding projects. Load project context, manage sessions, guide setup.
---

# /story — Project Context & Session Management

claudestory tracks tickets, issues, roadmap, and handovers in a `.story/` directory so every AI coding session builds on the last instead of starting from zero.

## How to Handle Arguments

`/story` is one smart command. Parse the user's intent from context:

- `/story` → full context load (default, see Step 2 below)
- `/story auto` → start autonomous mode (see Autonomous Mode below)
- `/story review T-XXX` → start review mode for a ticket (see Tiered Access below)
- `/story plan T-XXX` → start plan mode for a ticket (see Tiered Access below)
- `/story guided T-XXX` → start guided mode for a ticket (see Tiered Access below)
- `/story handover` → draft a session handover. Summarize the session's work, then call `claudestory_handover_create` with the drafted content and a descriptive slug
- `/story snapshot` → save project state (call `claudestory_snapshot` MCP tool)
- `/story export` → export project for sharing. Ask the user whether to export the current phase or the full project, then call `claudestory_export` with either `phase` or `all` set
- `/story status` → quick status check (call `claudestory_status` MCP tool)
- `/story help` → show all capabilities (read `~/.claude/skills/story/reference.md`)

If the user's intent doesn't match any of these, use the full context load.

## Step 0: Check Setup

Check if the claudestory MCP tools are available by looking for `claudestory_status` in your available tools.

**If MCP tools ARE available** → proceed to Step 1.

**If MCP tools are NOT available:**

1. Check if the `claudestory` CLI is installed: run `claudestory --version` via Bash
2. If NOT installed:
   - Check `node --version` and `npm --version` — both must be available
   - If Node.js is missing, tell the user to install Node.js 20+ first
   - Otherwise, with user permission, run: `npm install -g @anthropologies/claudestory`
   - Then run: `claude mcp add claudestory -s user -- claudestory --mcp`
   - Tell the user to restart Claude Code and run `/story` again
3. If CLI IS installed but MCP not registered:
   - With user permission, run: `claude mcp add claudestory -s user -- claudestory --mcp`
   - Tell the user to restart Claude Code and run `/story` again

**Important:** Always use `npm install -g`, never `npx`, for the CLI. The MCP server needs the global binary.

**If MCP tools are unavailable and user doesn't want to set up**, fall back to CLI mode:
- Run `claudestory status` via Bash
- Run `claudestory recap` via Bash
- Run `claudestory handover latest` via Bash
- Read `RULES.md` if it exists in the project root
- Run `claudestory lesson digest` via Bash
- Run `git log --oneline -10`
- Then continue to Step 3 below

## Step 1: Check Project

- If `.story/` exists in the current working directory (or a parent) → proceed to Step 2
- If no `.story/` but project indicators exist (code, manifest, .git) → run the **AI-Assisted Setup Flow** below
- If no `.story/` and no project indicators → explain what claudestory is and suggest navigating to a project

### AI-Assisted Setup Flow

This flow creates a meaningful `.story/` project instead of empty scaffolding. Claude analyzes the project, proposes structure, and creates everything via MCP tools.

#### 1a. Detect Project Type

Check for project indicators to determine if this is an **existing project** or a **new/empty project**:

- `package.json` → npm/node (read `name`, `description`, check for `typescript` dep)
- `Cargo.toml` → Rust
- `go.mod` → Go
- `pyproject.toml` / `requirements.txt` → Python
- `*.xcodeproj` / `Package.swift` → Swift/macOS
- `*.sln` / `*.csproj` → C#/.NET
- `Gemfile` → Ruby
- `build.gradle.kts` / `build.gradle` → Android/Kotlin/Java (or Spring Boot)
- `pubspec.yaml` → Flutter/Dart
- `angular.json` → Angular
- `svelte.config.js` → SvelteKit
- `.git/` → has version history

If none found (empty or near-empty directory) → skip to **1c. New Project Interview**.

#### 1b. Existing Project — Analyze

Before diving into analysis, briefly introduce claudestory to the user:

"Claude Story tracks your project's roadmap, tickets, issues, and session handovers in a `.story/` directory. Every Claude Code session starts by reading this context, so you never re-explain your project from scratch. Sessions build on each other: decisions, blockers, and lessons carry forward automatically. I'll analyze your project and propose a structure. You can adjust everything before I create anything."

Keep it to 3-4 sentences. Not a sales pitch, just enough that the user knows what they're opting into and that they're in control.

Read these files to understand the project (skip any that don't exist, skip files > 50KB):

1. **README.md** — project description, goals, feature list, roadmap/TODO sections
2. **Package manifest** — project name, dependencies, scripts
3. **CLAUDE.md** — existing project spec (if any)
4. **Top-level directory listing** — identify major components (src/, test/, docs/, etc.)
5. **Git summary** — `git log --oneline -20` for recent work patterns
6. **GitHub issues (ask user first)** — `gh issue list --limit 30 --state open --json number,title,labels,body,createdAt`. If gh fails (auth, rate limit, no remote), skip cleanly and note "GitHub import skipped: [reason]"

**Framework-specific deep scan** — after detecting the project type in 1a, scan deeper into framework conventions to understand architecture:

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

**Assess project stage** from the data — don't use fixed thresholds. A project with 3 commits and a half-written README is greenfield. A project with 500+ commits, test suites, and release tags is mature. A project with 200 commits and active PRs is active development. Use your judgment.

**Propose 3-7 phases** reflecting the project's actual development trajectory. Examples:
- Library: setup → core-api → documentation → testing → publishing
- App: mvp → auth → data-layer → ui-polish → deployment
- Mid-development project: capture completed work as early phases, then plan forward

**Propose initial tickets** per active phase (2-5 each), based on:
- README TODOs or roadmap sections (treat as hints, not ground truth)
- GitHub issues if imported — infer from label semantics: bug/defect labels → issues, enhancement/feature labels → tickets
- Obvious gaps (missing tests, no CI, no docs, etc.)
- If more than 30 GitHub issues exist, note "Showing 30 of N. Additional issues can be imported later."

**Important:** Only mark phases complete if explicitly confirmed by user or docs — do NOT infer completion from git history alone.

#### 1c. New Project — Interview

Ask the user:
1. "What are you building?" — project name and purpose
2. "What's the tech stack?" — language, framework, project type
3. "What are the major milestones?" — helps define phases
4. "What's the first thing to build?" — seeds the first ticket

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

#### 1e. Execute on Approval

1. Call `claudestory_init` with name, type, language — after this, all MCP tools become available dynamically
2. Call `claudestory_phase_create` for each phase — first phase with `atStart: true`, subsequent with `after: <previous-phase-id>`
3. Call `claudestory_ticket_create` for each ticket
4. Call `claudestory_issue_create` for each imported GitHub issue
5. Call `claudestory_ticket_update` to mark already-complete tickets as `complete`
6. Call `claudestory_snapshot` to save initial baseline

#### 1f. Post-Setup

After creation completes:
- Confirm what was created (e.g., "Created 5 phases, 12 tickets, and 3 issues")
- Check if `.gitignore` includes `.story/snapshots/` (warn if missing — snapshots should not be committed)
- Suggest creating `CLAUDE.md` if it doesn't exist (project spec for AI sessions)
- Suggest creating `RULES.md` if it doesn't exist (development constraints)
- Write an initial handover documenting the setup decisions
- Proceed to Step 2 (Load Context) to show the new project state

## Step 2: Load Context (Default /story Behavior)

Call these in order:

1. **Project status** — call `claudestory_status` MCP tool
2. **Session recap** — call `claudestory_recap` MCP tool (shows changes since last snapshot)
3. **Recent handovers** — call `claudestory_handover_latest` MCP tool with `count: 3` (last 3 sessions' context — ensures reasoning behind recent decisions is preserved, not just the latest session's state)
4. **Development rules** — read `RULES.md` if it exists in the project root
5. **Lessons learned** — call `claudestory_lesson_digest` MCP tool
6. **Recent commits** — run `git log --oneline -10`

## Step 3: Present Summary

After loading context, present a concise summary:

- Project progress (X/Y tickets complete, current phase)
- What changed since last snapshot (from recap)
- What the last session accomplished (from handover)
- Next ticket to work on
- Any high-severity issues or blockers
- Key process rules (from lessons digest)

For collaborative sessions, `claudestory_recommend` provides context-aware suggestions mixing tickets and issues. For autonomous sessions, `claudestory_ticket_next` provides queue-based next ticket.

Then ask: **"What would you like to work on?"**

## Session Lifecycle

- **Snapshots** save project state for diffing. They may be auto-taken before context compaction.
- **Handovers** are session continuity documents. Create one at the end of significant sessions.
- **Recaps** show what changed since the last snapshot — useful for understanding drift.

**Never modify or overwrite existing handover files.** Handovers are append-only historical records. Always create new handover files — never edit, replace, or write to an existing one. If you need to correct something from a previous session, create a new handover that references the correction. This prevents accidental data loss during sessions.

Before writing a handover at the end of a session, run `claudestory snapshot` first. This ensures the next session's recap can show what changed. If `setup-skill` has been run, a PreCompact hook auto-takes snapshots before context compaction.

## Ticket and Issue Discipline

**Tickets** are planned work — features, tasks, refactors. They represent intentional, scoped commitments.

**Ticket types:**
- `task` — Implementation work: building features, writing code, fixing bugs, refactoring.
- `feature` — A user-facing capability or significant new functionality. Larger scope than a task.
- `chore` — Maintenance, publishing, documentation, cleanup. No functional change to the product.

**Issues** are discovered problems — bugs, inconsistencies, gaps, risks found during work. If you're not sure whether something is a ticket or an issue, make it an issue. It can be promoted to a ticket later.

When working on a task and you encounter a bug, inconsistency, or improvement opportunity that is out of scope for the current ticket, create an issue using `claudestory issue create` (CLI) with a clear title, severity, and impact description. Don't fix it in the current task, don't ignore it — log it. This keeps the issue tracker growing organically and ensures nothing discovered during work is lost.

When starting work on a ticket, update its status to `inprogress`. When done, update to `complete` in the same commit as the code change.

## Managing Tickets and Issues

Ticket and issue create/update operations are available via both CLI and MCP tools. Delete remains CLI-only.

CLI examples:
- `claudestory ticket create --title "..." --type task --phase p0`
- `claudestory ticket update T-001 --status complete`
- `claudestory issue create --title "..." --severity high --impact "..."`

MCP examples:
- `claudestory_ticket_create` with `title`, `type`, and optional `phase`, `description`, `blockedBy`, `parentTicket`
- `claudestory_ticket_update` with `id` and optional `status`, `title`, `order`, `description`, `phase`, `parentTicket`
- `claudestory_issue_create` with `title`, `severity`, `impact`, and optional `components`, `relatedTickets`, `location`, `phase`
- `claudestory_issue_update` with `id` and optional `status`, `title`, `severity`, `impact`, `resolution`, `components`, `relatedTickets`, `location`

Read operations (list, get, next, blocked) are available via both CLI and MCP.

## Notes

**Notes** are unstructured brainstorming artifacts — ideas, design thinking, "what if" explorations. Use notes when the content doesn't fit tickets (planned work) or issues (discovered problems).

Create notes via CLI: `claudestory note create --content "..." --tags idea`

Create notes via MCP: `claudestory_note_create` with `content`, optional `title` and `tags`.

List, get, and update notes via MCP: `claudestory_note_list`, `claudestory_note_get`, `claudestory_note_update`. Delete remains CLI-only: `claudestory note delete <id>`.

## Autonomous Mode

`/story auto` starts an autonomous coding session. The guide picks tickets, plans, reviews, implements, and commits — looping until all tickets are done or the session limit is reached.

**How it works:**

1. Call `claudestory_autonomous_guide` with `{ "sessionId": null, "action": "start" }`
2. The guide returns an instruction with ticket candidates and exact JSON for the next call
3. Follow every instruction exactly. Call the guide back after each step.
4. The guide advances through: PICK_TICKET → PLAN → PLAN_REVIEW → IMPLEMENT → CODE_REVIEW → FINALIZE → COMPLETE → loop
5. Continue until the guide returns SESSION_END

**Critical rules for autonomous mode:**
- Do NOT use Claude Code's plan mode — write plans as markdown files
- Do NOT ask the user for confirmation or approval
- Do NOT stop or summarize between tickets — call the guide IMMEDIATELY
- Follow the guide's instructions exactly — it specifies which tools to call, what parameters to use
- After each step completes, call `claudestory_autonomous_guide` with `action: "report"` and the results

**If the guide says to compact:** Call `claudestory_autonomous_guide` with `action: "pre_compact"`, then run `/compact`, then call with `action: "resume"`.

**If something goes wrong:** Call `claudestory_autonomous_guide` with `action: "cancel"` to cleanly end the session.

## Tiered Access — Review, Plan, Guided Modes

The autonomous guide supports four execution tiers. Same guide, same handlers, different entry/exit points.

### `/story review T-XXX`

"I wrote code for T-XXX, review it." Enters at CODE_REVIEW, loops review rounds, exits on approval.

1. Call `claudestory_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "review", "ticketId": "T-XXX" }`
2. The guide enters CODE_REVIEW — follow its diff capture and review instructions
3. On approve: session ends automatically. On revise/reject: fix code, re-review
4. After approval, you can proceed to commit — the guide does NOT auto-commit in review mode

**Note:** Review mode relaxes git constraints — dirty working tree is allowed since the user has code ready for review.

### `/story plan T-XXX`

"Help me plan T-XXX." Enters at PLAN, runs PLAN_REVIEW rounds, exits on approval.

1. Call `claudestory_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "plan", "ticketId": "T-XXX" }`
2. The guide enters PLAN — write the implementation plan as a markdown file
3. On plan review approve: session ends automatically. On revise/reject: revise plan, re-review
4. The approved plan is saved in `.story/sessions/<id>/plan.md`

### `/story guided T-XXX`

"Do T-XXX end to end with review." Full pipeline for a single ticket: PLAN → PLAN_REVIEW → IMPLEMENT → CODE_REVIEW → FINALIZE → COMPLETE → HANDOVER → SESSION_END.

1. Call `claudestory_autonomous_guide` with `{ "sessionId": null, "action": "start", "mode": "guided", "ticketId": "T-XXX" }`
2. Follow every instruction exactly, calling the guide back after each step
3. Session ends automatically after the single ticket is complete

**Guided vs Auto:** Guided mode forces `maxTicketsPerSession: 1` and exits after the ticket. Auto mode loops until all tickets are done or the session limit is reached.

### All tiered modes:
- Require a `ticketId` — no ad-hoc review without a ticket in V1
- Use the same review process as auto mode (same backends, same adaptive depth)
- Can be cancelled with `action: "cancel"` at any point

## Command & Tool Reference

For the full list of CLI commands and MCP tools, read `reference.md` in the same directory as this skill file.
