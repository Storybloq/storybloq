# storybloq Reference

## CLI Commands

### init
Initialize a new .story/ project

```
storybloq init [--name <name>] [--type <type>] [--language <lang>] [--force] [--format json|md]
```

### status
Project summary: phase statuses, ticket/issue counts, blockers

```
storybloq status [--format json|md]
```

### ticket list
List tickets with optional filters

```
storybloq ticket list [--status <s>] [--phase <p>] [--type <t>] [--format json|md]
```

### ticket get
Get ticket details by ID

```
storybloq ticket get <id> [--format json|md]
```

### ticket next
Suggest next ticket(s) to work on

```
storybloq ticket next [--count N] [--format json|md]
```

### ticket blocked
List blocked tickets with their blocking dependencies

```
storybloq ticket blocked [--format json|md]
```

### ticket create
Create a new ticket

```
storybloq ticket create --title <t> --type <type> [--phase <p>] [--description <d>] [--blocked-by <ids>] [--parent-ticket <id>] [--risk <low|medium|high>] [--format json|md]
```

### ticket update
Update a ticket

```
storybloq ticket update <id> [--status <s>] [--title <t>] [--type <type>] [--phase <p>] [--order <n>] [--description <d>] [--blocked-by <ids>] [--parent-ticket <id>] [--risk <low|medium|high>] [--format json|md]
```

### ticket meta
Get, set, or unset custom passthrough metadata on a ticket

```
storybloq ticket meta get|set|unset <id> [path] [value] [--format json|md]
```

### ticket delete
Delete a ticket

```
storybloq ticket delete <id> [--force] [--format json|md]
```

### issue list
List issues with optional filters

```
storybloq issue list [--status <s>] [--severity <sev>] [--component <c>] [--phase <p>] [--format json|md]
```

### issue get
Get issue details by ID

```
storybloq issue get <id> [--format json|md]
```

### issue create
Create a new issue

```
storybloq issue create --title <t> --severity <s> --impact <i> [--components <c>] [--related-tickets <ids>] [--location <locs>] [--phase <p>] [--format json|md]
```

### issue update
Update an issue

```
storybloq issue update <id> [--status <s>] [--title <t>] [--severity <sev>] [--impact <i>] [--resolution <r>] [--components <c>] [--related-tickets <ids>] [--location <locs>] [--order <n>] [--phase <p>] [--format json|md]
```

### issue meta
Get, set, or unset custom passthrough metadata on an issue

```
storybloq issue meta get|set|unset <id> [path] [value] [--format json|md]
```

### issue delete
Delete an issue

```
storybloq issue delete <id> [--format json|md]
```

### phase list
List all phases with derived status

```
storybloq phase list [--format json|md]
```

### phase current
Show current (first non-complete) phase

```
storybloq phase current [--format json|md]
```

### phase tickets
List tickets in a specific phase

```
storybloq phase tickets --phase <id> [--format json|md]
```

### phase create
Create a new phase

```
storybloq phase create --id <id> --name <n> --label <l> --description <d> [--summary <s>] [--after <id>] [--at-start] [--format json|md]
```

### phase rename
Rename/update phase metadata

```
storybloq phase rename <id> [--name <n>] [--label <l>] [--description <d>] [--summary <s>] [--format json|md]
```

### phase move
Move a phase to a new position

```
storybloq phase move <id> [--after <id>] [--at-start] [--format json|md]
```

### phase delete
Delete a phase

```
storybloq phase delete <id> [--reassign <phase-id>] [--format json|md]
```

### handover list
List handover filenames (newest first)

```
storybloq handover list [--format json|md]
```

### handover latest
Content of most recent handover

```
storybloq handover latest [--format json|md]
```

### handover get
Content of a specific handover

```
storybloq handover get <filename> [--format json|md]
```

### handover create
Create a new handover document

```
storybloq handover create [--content <md>] [--stdin] [--slug <slug>] [--format json|md]
```

### blocker list
List all roadmap blockers

```
storybloq blocker list [--format json|md]
```

### blocker add
Add a new blocker

```
storybloq blocker add --name <n> [--note <note>] [--format json|md]
```

### blocker clear
Clear (resolve) a blocker

```
storybloq blocker clear --name <n> [--note <note>] [--format json|md]
```

### note list
List notes with optional status/tag filters

```
storybloq note list [--status <s>] [--tag <t>] [--format json|md]
```

### note get
Get a note by ID

```
storybloq note get <id> [--format json|md]
```

### note create
Create a new note

```
storybloq note create --content <c> [--title <t>] [--tags <tags>] [--format json|md]
```

### note update
Update a note

```
storybloq note update <id> [--content <c>] [--title <t>] [--tags <tags>] [--clear-tags] [--status <s>] [--format json|md]
```

### note delete
Delete a note

```
storybloq note delete <id> [--format json|md]
```

### lesson list
List lessons with optional status/tag/source filters

```
storybloq lesson list [--status <s>] [--tag <t>] [--source <src>] [--format json|md]
```

### lesson get
Get a lesson by ID

```
storybloq lesson get <id> [--format json|md]
```

### lesson digest
Ranked digest of active lessons for context loading

```
storybloq lesson digest [--format json|md]
```

### lesson create
Create a new lesson

```
storybloq lesson create --title <t> --content <c> --context <ctx> --source <src> [--tags <tags>] [--supersedes <id>] [--format json|md]
```

### lesson update
Update a lesson

```
storybloq lesson update <id> [--title <t>] [--content <c>] [--context <ctx>] [--tags <tags>] [--status <s>] [--supersedes <id>] [--format json|md]
```

### lesson reinforce
Reinforce a lesson: increment count and update lastValidated

```
storybloq lesson reinforce <id> [--format json|md]
```

### lesson delete
Delete a lesson

```
storybloq lesson delete <id> [--hard] [--format json|md]
```

### validate
Reference integrity + schema checks on all .story/ files

```
storybloq validate [--format json|md]
```

### snapshot
Save current project state for session diffs

```
storybloq snapshot [--quiet] [--format json|md]
```

### recap
Session diff — changes since last snapshot + suggested actions

```
storybloq recap [--format json|md]
```

### export
Self-contained project document for sharing

```
storybloq export [--phase <id>] [--all] [--format json|md]
```

### recommend
Context-aware work suggestions

```
storybloq recommend [--count N] [--format json|md]
```

### reference
Print CLI command and MCP tool reference

```
storybloq reference [--format json|md]
```

### selftest
Run integration smoke test — create/update/delete cycle across all entity types

```
storybloq selftest [--format json|md]
```

### codex-review
Run native Codex plan or code review for an autonomous session

```
storybloq codex-review plan|code --session <id> --format guide-report
```

### setup
Install Storybloq skill, MCP, and hooks for Claude, Codex, or both

```
storybloq setup [--client claude|codex|all] [--skip-hooks]
```

### setup-skill
Compatibility alias for `storybloq setup --client claude`

```
storybloq setup-skill [--skip-hooks]
```

### reconcile
Detect and fix duplicate displayIds across all entity types

```
storybloq reconcile [--dry-run] [--ci] [--rebalance-ranks] [--format json|md]
```

### conflicts list
List all items with unresolved merge conflicts

```
storybloq conflicts list [--format json|md]
```

### conflicts show
Show field-level conflict detail for an item

```
storybloq conflicts show <id> [--format json|md]
```

### resolve
Resolve merge conflicts on a .story/ item

```
storybloq resolve <id> [--field <f>] [--use ours|theirs] [--value <json>] [--format json|md]
```

### merge-driver
Git merge driver for .story/ JSON files (registered via team setup)

```
storybloq merge-driver <ancestor> <ours> <theirs> <pathname>
```

### team init
Enable team mode on this project

```
storybloq team init [--claim-staleness-hours N] [--id-allocator local|git-refs] [--format json|md]
```

### team setup
Install the git merge driver and .gitattributes for team mode

```
storybloq team setup [--format json|md]
```

### team doctor
Run team health checks on the project

```
storybloq team doctor [--ci] [--format json|md]
```

### team reserve
Reserve display IDs via remote git refs

```
storybloq team reserve <type> [--count N] [--format json|md]
```

### team config
Show or set team configuration

```
storybloq team config get|set [key] [value] [--format json|md]
```

### gc
Remove tombstoned files past retention period

```
storybloq gc [--apply] [--force] [--retention-days N] [--format json|md]
```

### repair
Fix stale references in .story/ data

```
storybloq repair [--dry-run] [--canonicalize-refs]
```

### config
Manage project configuration (recipe overrides)

```
storybloq config <subcommand> [--format json|md]
```

### migrate
Migrate config schema to the latest version

```
storybloq migrate [--dry-run] [--format json|md]
```

### feedback
Community feedback via GitHub Issues

```
storybloq feedback list|create|vote [args] [--format json|md]
```

### dispatch
Dispatch work to Agent View background sessions

```
storybloq dispatch [ids..] [--format json|md]
```

### node add
Add a federation node to an orchestrator project

```
storybloq node add <name> --path <p> [--role <r>] [--kind <k>] [--format json|md]
```

### node update
Update a federation node's metadata

```
storybloq node update <name> [--path <p>] [--role <r>] [--format json|md]
```

### node remove
Remove a federation node from an orchestrator project

```
storybloq node remove <name> [--format json|md]
```

## MCP Tools

The tools below are registered in full mode (inside a .story/ project).

- **storybloq_status** (format?) — Project summary: phase statuses, ticket/issue counts, blockers. Markdown is the default; JSON includes full active/resumable session ownership and lease metadata.
- **storybloq_phase_list** — All phases with derived status
- **storybloq_phase_current** — First non-complete phase
- **storybloq_phase_tickets** (phaseId) — Leaf tickets for a specific phase
- **storybloq_ticket_list** (status?, phase?, type?) — List leaf tickets with optional filters
- **storybloq_ticket_get** (id) — Get a ticket by ID
- **storybloq_ticket_meta_get** (id, path?) — Get custom passthrough metadata from a ticket
- **storybloq_ticket_next** (count?) — Highest-priority unblocked ticket(s)
- **storybloq_ticket_blocked** — All blocked tickets with dependencies
- **storybloq_issue_list** (status?, severity?, component?, phase?) — List issues with optional filters
- **storybloq_issue_get** (id) — Get an issue by ID
- **storybloq_issue_meta_get** (id, path?) — Get custom passthrough metadata from an issue
- **storybloq_handover_list** — List handover filenames (newest first)
- **storybloq_handover_latest** — Content of most recent handover
- **storybloq_handover_get** (filename) — Content of a specific handover
- **storybloq_handover_create** (content, slug?) — Create a handover from markdown content
- **storybloq_blocker_list** — All roadmap blockers with status
- **storybloq_validate** — Reference integrity + schema checks
- **storybloq_recap** — Session diff — changes since last snapshot
- **storybloq_recommend** (count?) — Context-aware ranked work suggestions
- **storybloq_snapshot** — Save current project state snapshot
- **storybloq_export** (phase?, all?) — Self-contained project document
- **storybloq_note_list** (status?, tag?) — List notes
- **storybloq_note_get** (id) — Get note by ID
- **storybloq_note_create** (content, title?, tags?) — Create note
- **storybloq_note_update** (id, content?, title?, tags?, status?) — Update note
- **storybloq_ticket_create** (title, type, phase?, description?, blockedBy?, parentTicket?, risk?) — Create ticket. risk seed drives review depth/skip gates; unset = never skip
- **storybloq_ticket_update** (id, status?, title?, type?, order?, description?, phase?, parentTicket?, blockedBy?, risk?) — Update ticket. risk seed drives review depth/skip gates; unset = never skip
- **storybloq_ticket_meta_set** (id, path, value) — Set custom passthrough metadata on a ticket
- **storybloq_ticket_meta_unset** (id, path) — Unset custom passthrough metadata from a ticket
- **storybloq_issue_create** (title, severity, impact, components?, relatedTickets?, location?, phase?) — Create issue
- **storybloq_issue_update** (id, status?, title?, severity?, impact?, resolution?, components?, relatedTickets?, location?, order?, phase?) — Update issue
- **storybloq_issue_meta_set** (id, path, value) — Set custom passthrough metadata on an issue
- **storybloq_issue_meta_unset** (id, path) — Unset custom passthrough metadata from an issue
- **storybloq_phase_create** (id, name, label, description, summary?, after?, atStart?) — Create phase in roadmap
- **storybloq_lesson_list** (status?, tag?, source?) — List lessons
- **storybloq_lesson_get** (id) — Get lesson by ID
- **storybloq_lesson_digest** — Ranked digest of active lessons for context loading
- **storybloq_lesson_create** (title, content, context, source, tags?, supersedes?) — Create lesson
- **storybloq_lesson_update** (id, title?, content?, context?, tags?, status?, supersedes?) — Update lesson
- **storybloq_lesson_reinforce** (id) — Reinforce lesson — increment count and update lastValidated
- **storybloq_selftest** — Integration smoke test — create/update/delete cycle
- **storybloq_review_lenses_prepare** (stage, diff, changedFiles, ticketDescription?, reviewRound?, priorDeferrals?, sessionId?) — Prepare multi-lens review on @storybloq/lenses: activation, secrets gate, context packaging, complete lens prompts
- **storybloq_review_lenses_synthesize** (stage?, lensResults, activeLenses, skippedLenses, reviewRound?, reviewId?, diff?, changedFiles?, sessionId?) — Run the @storybloq/lenses merger pipeline programmatically over raw lens outputs; returns the ReviewVerdict envelope (no merger agent)
- **storybloq_review_lenses_judge** (reviewVerdict, convergenceHistory?) — Deterministic three-value verdict mapping over the synthesize ReviewVerdict plus convergence history (no judge agent)
- **storybloq_autonomous_guide** (sessionId?, action, mode?, ticketId?, clientTaskId?, takeover?) — Autonomous session orchestrator -- call at every decision point to drive PICK_TICKET through COMPLETE
- **storybloq_session_report** (sessionId) — Structured analysis of an autonomous session (works even if project state is corrupted)
- **storybloq_register_subprocess** (pid, cmd, category?, sessionId?) — Register a running subprocess so monitors can tell slow builds from hung agents
- **storybloq_unregister_subprocess** (pid, sessionId?) — Unregister a subprocess after it completes (idempotent)
- **storybloq_node_list** — List configured federation nodes in an orchestrator project
- **storybloq_node_init** (node, type?, language?) — Initialize .story/ in a federation child node from the orchestrator
- **storybloq_node_add** (name, path, role?, kind?) — Add a federation node to an orchestrator project's config
- **storybloq_node_update** (name, path?, role?) — Update a federation node's metadata (shallow-merge)

### MCP Tools (degraded mode)

With no .story/ project on the path, the MCP server starts degraded and registers only:

- **storybloq_init** — bootstrap a .story/ project, then dynamically register the full tool set
- **storybloq_status** — returns setup guidance instead of a project summary

Destructive, admin, and git-integration workflows (delete, reconcile, conflicts, resolve, merge-driver, team, gc, repair, config, feedback) are CLI-only in both modes; see the CLI Commands section above.

## /story design

Evaluate frontend code against platform-specific design best practices.

```
/story design                    # Auto-detect platform, evaluate frontend
/story design web                # Evaluate against web best practices
/story design ios                # Evaluate against iOS HIG
/story design macos              # Evaluate against macOS HIG
/story design android            # Evaluate against Material Design
```

Creates issues automatically when storybloq MCP tools or CLI are available. Checks for existing design issues to avoid duplicates on repeated runs. Outputs markdown checklist as fallback when neither MCP nor CLI is available.

## /story orchestrate

Drive a multi-repo federation (or a large single-repo backlog) as an orchestrator: durable state in storybloq, implementation in background agents a tier below the session model when the client offers one, adversarial review gates on the session model.

```
/story orchestrate               # guard checks, explicit opt-in, then the wave loop
```

Requires explicit opt-in via AskUserQuestion before any agents are dispatched, and refuses to start while any federation node has an active autonomous session (one pen per repo; the per-node check reads each node's `.story/sessions/` directly because orchestrator status does not scan node repos). The full procedure -- enrichment template, sizing convention, 6-stage pipeline, workflow-script skeleton, critical rules -- is in `orchestrator-mode.md`. Needs a client with background dynamic workflows or subagents; Claude can also use the Agent View-backed `storybloq dispatch` path. Codex users can orchestrate when exact callable subagent tools are present; product-managed Codex dispatch remains unshipped.

`/story` surfaces this option proactively at context load when the client is capable and the actionable backlog is orchestrate-sized, so you do not have to know the command exists; it stays a recommendation, and selecting it still routes through the explicit opt-in.

## Common Workflows

### Session Start
1. `storybloq status` — project overview
2. `storybloq recap` — what changed since last snapshot
3. `storybloq handover latest` — last session context
4. `storybloq ticket next` — what to work on

### Session End
1. `storybloq snapshot` — save state for diffs
2. `storybloq handover create --content <md>` — write session handover

### Project Setup
1. `npm install -g @storybloq/storybloq` - install CLI
2. `storybloq setup --client all` - install Storybloq skill, MCP, and hooks for Claude Code and Codex
3. `storybloq init --name my-project` - initialize .story/ in your project

## Troubleshooting

- **MCP not connected:** Run `storybloq setup --client all`
- **CLI not found:** Run `npm install -g @storybloq/storybloq`
- **Stale data:** Run `storybloq validate` to check integrity
- **Storybloq skill not available:** Run `storybloq setup --client all` to install the skill
