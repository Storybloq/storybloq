# storybloq

An agentic development framework. Track tickets, issues, and progress for your project in a `.story/` directory that AI tools read and write natively.

**[storybloq.com](https://storybloq.com)** | **[Documentation](https://storybloq.com/cli)** | **[Privacy Policy](https://storybloq.com/privacy)**

## Installation

```bash
npm install -g @storybloq/storybloq
```

Requires Node.js 20+.

## Quick Start

```bash
# Initialize in your project
storybloq init --name "my-project"

# See project state
storybloq status

# What should I work on next?
storybloq ticket next

# Check for data integrity issues
storybloq validate
```

## CLI Commands

All commands support `--format json|md` (default: `md`).

### Project

| Command | Description |
|---------|-------------|
| `storybloq init [--name] [--force]` | Scaffold `.story/` directory |
| `storybloq status` | Project summary with phase statuses |
| `storybloq validate` | Reference integrity + schema checks |

### Phases

| Command | Description |
|---------|-------------|
| `storybloq phase list` | All phases with derived status |
| `storybloq phase current` | First non-complete phase |
| `storybloq phase tickets --phase <id>` | Leaf tickets for a phase |
| `storybloq phase create --id --name --label --description [--summary] --after/--at-start` | Create phase |
| `storybloq phase rename <id> [--name] [--label] [--description] [--summary]` | Update phase metadata |
| `storybloq phase move <id> --after/--at-start` | Reorder phase |
| `storybloq phase delete <id> [--reassign <target>]` | Delete phase |

### Tickets

| Command | Description |
|---------|-------------|
| `storybloq ticket list [--status] [--phase] [--type]` | List leaf tickets |
| `storybloq ticket get <id>` | Ticket detail |
| `storybloq ticket next` | Highest-priority unblocked ticket |
| `storybloq ticket blocked` | All blocked tickets |
| `storybloq ticket create --title --type --phase [--description] [--blocked-by] [--parent-ticket]` | Create ticket |
| `storybloq ticket update <id> [--status] [--title] [--phase] [--order] ...` | Update ticket |
| `storybloq ticket delete <id> [--force]` | Delete ticket |

### Issues

| Command | Description |
|---------|-------------|
| `storybloq issue list [--status] [--severity]` | List issues |
| `storybloq issue get <id>` | Issue detail |
| `storybloq issue create --title --severity --impact [--components] [--related-tickets] [--location]` | Create issue |
| `storybloq issue update <id> [--status] [--title] [--severity] ...` | Update issue |
| `storybloq issue delete <id>` | Delete issue |

### Handovers

| Command | Description |
|---------|-------------|
| `storybloq handover list` | List handover filenames (newest first) |
| `storybloq handover latest` | Content of most recent handover |
| `storybloq handover get <filename>` | Content of specific handover |

### Blockers

| Command | Description |
|---------|-------------|
| `storybloq blocker list` | List all blockers with dates |
| `storybloq blocker add --name [--note]` | Add a blocker |
| `storybloq blocker clear <name> [--note]` | Clear an active blocker |

## MCP Server

The MCP server provides 19 tools for Claude Code integration. It imports the same TypeScript modules as the CLI directly — no subprocess spawning.

### Setup with Claude Code

```bash
npm install -g @storybloq/storybloq
claude mcp add storybloq -s user -- storybloq --mcp
```

Two commands: install globally, register as MCP server. Works in every project that has a `.story/` directory. The MCP server auto-discovers the project root by walking up from the working directory.

### MCP Tools

| Tool | Description |
|------|-------------|
| `storybloq_status` | Project summary |
| `storybloq_phase_list` | All phases with status |
| `storybloq_phase_current` | Current phase |
| `storybloq_phase_tickets` | Tickets for a phase |
| `storybloq_ticket_list` | List tickets (filterable) |
| `storybloq_ticket_get` | Get ticket by ID |
| `storybloq_ticket_next` | Priority ticket |
| `storybloq_ticket_blocked` | Blocked tickets |
| `storybloq_issue_list` | List issues (filterable) |
| `storybloq_issue_get` | Get issue by ID |
| `storybloq_handover_list` | List handovers |
| `storybloq_handover_latest` | Latest handover |
| `storybloq_handover_get` | Specific handover |
| `storybloq_blocker_list` | List blockers |
| `storybloq_validate` | Integrity checks |
| `storybloq_recap` | Session diff + suggested actions |
| `storybloq_snapshot` | Save state for session diffs |
| `storybloq_export` | Self-contained project document |

## Session Lifecycle

### Session Start (recommended hook)

Auto-inject project recap at session start — shows what changed since last snapshot and what to work on next:

```bash
#!/bin/bash
storybloq recap --format md 2>/dev/null
```

### PreCompact Hook (auto-snapshot)

`setup-skill` configures a PreCompact hook that runs `storybloq snapshot --quiet` before context compaction. This ensures `recap` always shows changes since the last compaction — no manual snapshots needed.

Installed automatically by `setup-skill`. To skip: `storybloq setup-skill --skip-hooks`.

Manual configuration (add to `~/.claude/settings.json`):

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "storybloq snapshot --quiet"
          }
        ]
      }
    ]
  }
}
```

### Session End

Save a snapshot before ending your session so the next `recap` can show diffs:

```bash
storybloq snapshot
```

### Export

Generate a self-contained document for sharing:

```bash
storybloq export --phase p5b          # single phase
storybloq export --all                # entire project
storybloq export --all --format json  # structured JSON
```

## Library Usage

```typescript
import { loadProject, ProjectState } from "@storybloq/storybloq";

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

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) -- free for personal and noncommercial use. For commercial licensing, contact shayegh@me.com.
