# claudestory Reference

## CLI Commands

### init
Initialize a new .story/ project

```
claudestory init [--name <name>] [--type <type>] [--language <lang>] [--force] [--format json|md]
```

### status
Project summary: phase statuses, ticket/issue counts, blockers

```
claudestory status [--format json|md]
```

### ticket list
List tickets with optional filters

```
claudestory ticket list [--status <s>] [--phase <p>] [--type <t>] [--format json|md]
```

### ticket get
Get ticket details by ID

```
claudestory ticket get <id> [--format json|md]
```

### ticket next
Suggest next ticket to work on

```
claudestory ticket next [--format json|md]
```

### ticket blocked
List blocked tickets with their blocking dependencies

```
claudestory ticket blocked [--format json|md]
```

### ticket create
Create a new ticket

```
claudestory ticket create --title <t> --type <type> [--phase <p>] [--description <d>] [--blocked-by <ids>] [--parent-ticket <id>] [--format json|md]
```

### ticket update
Update a ticket

```
claudestory ticket update <id> [--status <s>] [--title <t>] [--phase <p>] [--order <n>] [--description <d>] [--blocked-by <ids>] [--parent-ticket <id>] [--format json|md]
```

### ticket delete
Delete a ticket

```
claudestory ticket delete <id> [--force] [--format json|md]
```

### issue list
List issues with optional filters

```
claudestory issue list [--status <s>] [--severity <sev>] [--format json|md]
```

### issue get
Get issue details by ID

```
claudestory issue get <id> [--format json|md]
```

### issue create
Create a new issue

```
claudestory issue create --title <t> --severity <s> --impact <i> [--components <c>] [--related-tickets <ids>] [--location <locs>] [--format json|md]
```

### issue update
Update an issue

```
claudestory issue update <id> [--status <s>] [--title <t>] [--severity <sev>] [--impact <i>] [--resolution <r>] [--components <c>] [--related-tickets <ids>] [--location <locs>] [--format json|md]
```

### issue delete
Delete an issue

```
claudestory issue delete <id> [--format json|md]
```

### phase list
List all phases with derived status

```
claudestory phase list [--format json|md]
```

### phase current
Show current (first non-complete) phase

```
claudestory phase current [--format json|md]
```

### phase tickets
List tickets in a specific phase

```
claudestory phase tickets --phase <id> [--format json|md]
```

### phase create
Create a new phase

```
claudestory phase create --id <id> --name <n> --label <l> --description <d> [--summary <s>] [--after <id>] [--at-start] [--format json|md]
```

### phase rename
Rename/update phase metadata

```
claudestory phase rename <id> [--name <n>] [--label <l>] [--description <d>] [--summary <s>] [--format json|md]
```

### phase move
Move a phase to a new position

```
claudestory phase move <id> [--after <id>] [--at-start] [--format json|md]
```

### phase delete
Delete a phase

```
claudestory phase delete <id> [--reassign <phase-id>] [--format json|md]
```

### handover list
List handover filenames (newest first)

```
claudestory handover list [--format json|md]
```

### handover latest
Content of most recent handover

```
claudestory handover latest [--format json|md]
```

### handover get
Content of a specific handover

```
claudestory handover get <filename> [--format json|md]
```

### handover create
Create a new handover document

```
claudestory handover create [--content <md>] [--stdin] [--slug <slug>] [--format json|md]
```

### blocker list
List all roadmap blockers

```
claudestory blocker list [--format json|md]
```

### blocker add
Add a new blocker

```
claudestory blocker add --name <n> [--note <note>] [--format json|md]
```

### blocker clear
Clear (resolve) a blocker

```
claudestory blocker clear --name <n> [--note <note>] [--format json|md]
```

### validate
Reference integrity + schema checks on all .story/ files

```
claudestory validate [--format json|md]
```

### snapshot
Save current project state for session diffs

```
claudestory snapshot [--quiet] [--format json|md]
```

### recap
Session diff — changes since last snapshot + suggested actions

```
claudestory recap [--format json|md]
```

### export
Self-contained project document for sharing

```
claudestory export [--phase <id>] [--all] [--format json|md]
```

### reference
Print CLI command and MCP tool reference

```
claudestory reference [--format json|md]
```

### setup-skill
Install the /story skill globally for Claude Code

```
claudestory setup-skill
```

## MCP Tools

- **claudestory_status** — Project summary: phase statuses, ticket/issue counts, blockers
- **claudestory_phase_list** — All phases with derived status
- **claudestory_phase_current** — First non-complete phase
- **claudestory_phase_tickets** (phaseId) — Leaf tickets for a specific phase
- **claudestory_ticket_list** (status?, phase?, type?) — List leaf tickets with optional filters
- **claudestory_ticket_get** (id) — Get a ticket by ID
- **claudestory_ticket_next** — Highest-priority unblocked ticket
- **claudestory_ticket_blocked** — All blocked tickets with dependencies
- **claudestory_issue_list** (status?, severity?) — List issues with optional filters
- **claudestory_issue_get** (id) — Get an issue by ID
- **claudestory_handover_list** — List handover filenames (newest first)
- **claudestory_handover_latest** — Content of most recent handover
- **claudestory_handover_get** (filename) — Content of a specific handover
- **claudestory_handover_create** (content, slug?) — Create a handover from markdown content
- **claudestory_blocker_list** — All roadmap blockers with status
- **claudestory_validate** — Reference integrity + schema checks
- **claudestory_recap** — Session diff — changes since last snapshot
- **claudestory_snapshot** — Save current project state snapshot
- **claudestory_export** (phase?, all?) — Self-contained project document

## Common Workflows

### Session Start
1. `claudestory status` — project overview
2. `claudestory recap` — what changed since last snapshot
3. `claudestory handover latest` — last session context
4. `claudestory ticket next` — what to work on

### Session End
1. `claudestory snapshot` — save state for diffs
2. `claudestory handover create --content <md>` — write session handover

### Project Setup
1. `npm install -g @anthropologies/claudestory` — install CLI
2. `claudestory setup-skill` — install /story skill for Claude Code
3. `claudestory init --name my-project` — initialize .story/ in your project

## Troubleshooting

- **MCP not connected:** Run `claude mcp add claudestory -s user -- claudestory --mcp`
- **CLI not found:** Run `npm install -g @anthropologies/claudestory`
- **Stale data:** Run `claudestory validate` to check integrity
- **/story not available:** Run `claudestory setup-skill` to install the skill
