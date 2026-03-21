# claudestory

Cross-session context persistence for AI coding assistants. Tracks tickets, issues, roadmap phases, blockers, and session handovers in a `.story/` directory that AI tools read and write natively.

## Installation

```bash
npm install -g @anthropologies/claudestory
```

Requires Node.js 20+.

## Quick Start

```bash
# Initialize in your project
claudestory init --name "my-project"

# See project state
claudestory status

# What should I work on next?
claudestory ticket next

# Check for data integrity issues
claudestory validate
```

## CLI Commands

All commands support `--format json|md` (default: `md`).

### Project

| Command | Description |
|---------|-------------|
| `claudestory init [--name] [--force]` | Scaffold `.story/` directory |
| `claudestory status` | Project summary with phase statuses |
| `claudestory validate` | Reference integrity + schema checks |

### Phases

| Command | Description |
|---------|-------------|
| `claudestory phase list` | All phases with derived status |
| `claudestory phase current` | First non-complete phase |
| `claudestory phase tickets --phase <id>` | Leaf tickets for a phase |
| `claudestory phase create --id --name --label --description [--summary] --after/--at-start` | Create phase |
| `claudestory phase rename <id> [--name] [--label] [--description] [--summary]` | Update phase metadata |
| `claudestory phase move <id> --after/--at-start` | Reorder phase |
| `claudestory phase delete <id> [--reassign <target>]` | Delete phase |

### Tickets

| Command | Description |
|---------|-------------|
| `claudestory ticket list [--status] [--phase] [--type]` | List leaf tickets |
| `claudestory ticket get <id>` | Ticket detail |
| `claudestory ticket next` | Highest-priority unblocked ticket |
| `claudestory ticket blocked` | All blocked tickets |
| `claudestory ticket create --title --type --phase [--description] [--blocked-by] [--parent-ticket]` | Create ticket |
| `claudestory ticket update <id> [--status] [--title] [--phase] [--order] ...` | Update ticket |
| `claudestory ticket delete <id> [--force]` | Delete ticket |

### Issues

| Command | Description |
|---------|-------------|
| `claudestory issue list [--status] [--severity]` | List issues |
| `claudestory issue get <id>` | Issue detail |
| `claudestory issue create --title --severity --impact [--components] [--related-tickets] [--location]` | Create issue |
| `claudestory issue update <id> [--status] [--title] [--severity] ...` | Update issue |
| `claudestory issue delete <id>` | Delete issue |

### Handovers

| Command | Description |
|---------|-------------|
| `claudestory handover list` | List handover filenames (newest first) |
| `claudestory handover latest` | Content of most recent handover |
| `claudestory handover get <filename>` | Content of specific handover |

### Blockers

| Command | Description |
|---------|-------------|
| `claudestory blocker list` | List all blockers with dates |
| `claudestory blocker add --name [--note]` | Add a blocker |
| `claudestory blocker clear <name> [--note]` | Clear an active blocker |

## MCP Server

The MCP server provides 19 tools for Claude Code integration. It imports the same TypeScript modules as the CLI directly — no subprocess spawning.

### Setup with Claude Code

```bash
claude mcp add claudestory -s user -- npx -y @anthropologies/claudestory --mcp
```

That's it. One command, global — works in every project that has a `.story/` directory. No global install required. The MCP server auto-discovers the project root by walking up from the working directory.

### MCP Tools

| Tool | Description |
|------|-------------|
| `claudestory_status` | Project summary |
| `claudestory_phase_list` | All phases with status |
| `claudestory_phase_current` | Current phase |
| `claudestory_phase_tickets` | Tickets for a phase |
| `claudestory_ticket_list` | List tickets (filterable) |
| `claudestory_ticket_get` | Get ticket by ID |
| `claudestory_ticket_next` | Priority ticket |
| `claudestory_ticket_blocked` | Blocked tickets |
| `claudestory_issue_list` | List issues (filterable) |
| `claudestory_issue_get` | Get issue by ID |
| `claudestory_handover_list` | List handovers |
| `claudestory_handover_latest` | Latest handover |
| `claudestory_handover_get` | Specific handover |
| `claudestory_blocker_list` | List blockers |
| `claudestory_validate` | Integrity checks |
| `claudestory_recap` | Session diff + suggested actions |
| `claudestory_snapshot` | Save state for session diffs |
| `claudestory_export` | Self-contained project document |

## Session Lifecycle

### Session Start (recommended hook)

Auto-inject project recap at session start — shows what changed since last snapshot and what to work on next:

```bash
#!/bin/bash
claudestory recap --format md 2>/dev/null
```

### Session End

Save a snapshot before ending your session so the next `recap` can show diffs:

```bash
claudestory snapshot
```

### Export

Generate a self-contained document for sharing:

```bash
claudestory export --phase p5b          # single phase
claudestory export --all                # entire project
claudestory export --all --format json  # structured JSON
```

## Library Usage

```typescript
import { loadProject, ProjectState } from "@anthropologies/claudestory";

const { state, warnings } = await loadProject("/path/to/project");
console.log(state.tickets.length); // all tickets
console.log(state.phaseTickets("p1")); // tickets in phase p1
```

## Git Guidance

Commit your `.story/` directory. Add to `.gitignore`:

```
.story/snapshots/
```

Everything else in `.story/` should be tracked.

## License

MIT
