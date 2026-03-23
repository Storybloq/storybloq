import { formatReference } from "../../core/output-formatter.js";
import type { CommandEntry, McpToolEntry } from "../../core/output-formatter.js";
import type { OutputFormat } from "../../models/types.js";

/**
 * Hardcoded registry of all CLI commands and MCP tools.
 * A drift-detection test verifies this stays in sync with actual registrations.
 */

export type { CommandEntry, McpToolEntry };

export const COMMANDS: readonly CommandEntry[] = [
  {
    name: "init",
    description: "Initialize a new .story/ project",
    usage: "claudestory init [--name <name>] [--type <type>] [--language <lang>] [--force] [--format json|md]",
    flags: ["--name", "--type", "--language", "--force"],
  },
  {
    name: "status",
    description: "Project summary: phase statuses, ticket/issue counts, blockers",
    usage: "claudestory status [--format json|md]",
  },
  {
    name: "ticket list",
    description: "List tickets with optional filters",
    usage: "claudestory ticket list [--status <s>] [--phase <p>] [--type <t>] [--format json|md]",
    flags: ["--status", "--phase", "--type"],
  },
  {
    name: "ticket get",
    description: "Get ticket details by ID",
    usage: "claudestory ticket get <id> [--format json|md]",
  },
  {
    name: "ticket next",
    description: "Suggest next ticket(s) to work on",
    usage: "claudestory ticket next [--count N] [--format json|md]",
  },
  {
    name: "ticket blocked",
    description: "List blocked tickets with their blocking dependencies",
    usage: "claudestory ticket blocked [--format json|md]",
  },
  {
    name: "ticket create",
    description: "Create a new ticket",
    usage: "claudestory ticket create --title <t> --type <type> [--phase <p>] [--description <d>] [--blocked-by <ids>] [--parent-ticket <id>] [--format json|md]",
    flags: ["--title", "--type", "--phase", "--description", "--blocked-by", "--parent-ticket"],
  },
  {
    name: "ticket update",
    description: "Update a ticket",
    usage: "claudestory ticket update <id> [--status <s>] [--title <t>] [--phase <p>] [--order <n>] [--description <d>] [--blocked-by <ids>] [--parent-ticket <id>] [--format json|md]",
    flags: ["--status", "--title", "--phase", "--order", "--description", "--blocked-by", "--parent-ticket"],
  },
  {
    name: "ticket delete",
    description: "Delete a ticket",
    usage: "claudestory ticket delete <id> [--force] [--format json|md]",
    flags: ["--force"],
  },
  {
    name: "issue list",
    description: "List issues with optional filters",
    usage: "claudestory issue list [--status <s>] [--severity <sev>] [--format json|md]",
    flags: ["--status", "--severity"],
  },
  {
    name: "issue get",
    description: "Get issue details by ID",
    usage: "claudestory issue get <id> [--format json|md]",
  },
  {
    name: "issue create",
    description: "Create a new issue",
    usage: "claudestory issue create --title <t> --severity <s> --impact <i> [--components <c>] [--related-tickets <ids>] [--location <locs>] [--format json|md]",
    flags: ["--title", "--severity", "--impact", "--components", "--related-tickets", "--location"],
  },
  {
    name: "issue update",
    description: "Update an issue",
    usage: "claudestory issue update <id> [--status <s>] [--title <t>] [--severity <sev>] [--impact <i>] [--resolution <r>] [--components <c>] [--related-tickets <ids>] [--location <locs>] [--format json|md]",
    flags: ["--status", "--title", "--severity", "--impact", "--resolution", "--components", "--related-tickets", "--location"],
  },
  {
    name: "issue delete",
    description: "Delete an issue",
    usage: "claudestory issue delete <id> [--format json|md]",
  },
  {
    name: "phase list",
    description: "List all phases with derived status",
    usage: "claudestory phase list [--format json|md]",
  },
  {
    name: "phase current",
    description: "Show current (first non-complete) phase",
    usage: "claudestory phase current [--format json|md]",
  },
  {
    name: "phase tickets",
    description: "List tickets in a specific phase",
    usage: "claudestory phase tickets --phase <id> [--format json|md]",
    flags: ["--phase"],
  },
  {
    name: "phase create",
    description: "Create a new phase",
    usage: "claudestory phase create --id <id> --name <n> --label <l> --description <d> [--summary <s>] [--after <id>] [--at-start] [--format json|md]",
    flags: ["--id", "--name", "--label", "--description", "--summary", "--after", "--at-start"],
  },
  {
    name: "phase rename",
    description: "Rename/update phase metadata",
    usage: "claudestory phase rename <id> [--name <n>] [--label <l>] [--description <d>] [--summary <s>] [--format json|md]",
    flags: ["--name", "--label", "--description", "--summary"],
  },
  {
    name: "phase move",
    description: "Move a phase to a new position",
    usage: "claudestory phase move <id> [--after <id>] [--at-start] [--format json|md]",
    flags: ["--after", "--at-start"],
  },
  {
    name: "phase delete",
    description: "Delete a phase",
    usage: "claudestory phase delete <id> [--reassign <phase-id>] [--format json|md]",
    flags: ["--reassign"],
  },
  {
    name: "handover list",
    description: "List handover filenames (newest first)",
    usage: "claudestory handover list [--format json|md]",
  },
  {
    name: "handover latest",
    description: "Content of most recent handover",
    usage: "claudestory handover latest [--format json|md]",
  },
  {
    name: "handover get",
    description: "Content of a specific handover",
    usage: "claudestory handover get <filename> [--format json|md]",
  },
  {
    name: "handover create",
    description: "Create a new handover document",
    usage: "claudestory handover create [--content <md>] [--stdin] [--slug <slug>] [--format json|md]",
    flags: ["--content", "--stdin", "--slug"],
  },
  {
    name: "blocker list",
    description: "List all roadmap blockers",
    usage: "claudestory blocker list [--format json|md]",
  },
  {
    name: "blocker add",
    description: "Add a new blocker",
    usage: "claudestory blocker add --name <n> [--note <note>] [--format json|md]",
    flags: ["--name", "--note"],
  },
  {
    name: "blocker clear",
    description: "Clear (resolve) a blocker",
    usage: "claudestory blocker clear --name <n> [--note <note>] [--format json|md]",
    flags: ["--name", "--note"],
  },
  {
    name: "note list",
    description: "List notes with optional status/tag filters",
    usage: "claudestory note list [--status <s>] [--tag <t>] [--format json|md]",
    flags: ["--status", "--tag"],
  },
  {
    name: "note get",
    description: "Get a note by ID",
    usage: "claudestory note get <id> [--format json|md]",
  },
  {
    name: "note create",
    description: "Create a new note",
    usage: "claudestory note create --content <c> [--title <t>] [--tags <tags>] [--format json|md]",
    flags: ["--content", "--title", "--tags"],
  },
  {
    name: "note update",
    description: "Update a note",
    usage: "claudestory note update <id> [--content <c>] [--title <t>] [--tags <tags>] [--clear-tags] [--status <s>] [--format json|md]",
    flags: ["--content", "--title", "--tags", "--clear-tags", "--status"],
  },
  {
    name: "note delete",
    description: "Delete a note",
    usage: "claudestory note delete <id> [--format json|md]",
  },
  {
    name: "validate",
    description: "Reference integrity + schema checks on all .story/ files",
    usage: "claudestory validate [--format json|md]",
  },
  {
    name: "snapshot",
    description: "Save current project state for session diffs",
    usage: "claudestory snapshot [--quiet] [--format json|md]",
    flags: ["--quiet"],
  },
  {
    name: "recap",
    description: "Session diff — changes since last snapshot + suggested actions",
    usage: "claudestory recap [--format json|md]",
  },
  {
    name: "export",
    description: "Self-contained project document for sharing",
    usage: "claudestory export [--phase <id>] [--all] [--format json|md]",
    flags: ["--phase", "--all"],
  },
  {
    name: "recommend",
    description: "Context-aware work suggestions",
    usage: "claudestory recommend [--count N] [--format json|md]",
  },
  {
    name: "reference",
    description: "Print CLI command and MCP tool reference",
    usage: "claudestory reference [--format json|md]",
  },
  {
    name: "selftest",
    description: "Run integration smoke test — create/update/delete cycle across all entity types",
    usage: "claudestory selftest [--format json|md]",
  },
  {
    name: "setup-skill",
    description: "Install the /story skill globally for Claude Code",
    usage: "claudestory setup-skill",
  },
];

export const MCP_TOOLS: readonly McpToolEntry[] = [
  { name: "claudestory_status", description: "Project summary: phase statuses, ticket/issue counts, blockers" },
  { name: "claudestory_phase_list", description: "All phases with derived status" },
  { name: "claudestory_phase_current", description: "First non-complete phase" },
  { name: "claudestory_phase_tickets", description: "Leaf tickets for a specific phase", params: ["phaseId"] },
  { name: "claudestory_ticket_list", description: "List leaf tickets with optional filters", params: ["status?", "phase?", "type?"] },
  { name: "claudestory_ticket_get", description: "Get a ticket by ID", params: ["id"] },
  { name: "claudestory_ticket_next", description: "Highest-priority unblocked ticket(s)", params: ["count?"] },
  { name: "claudestory_ticket_blocked", description: "All blocked tickets with dependencies" },
  { name: "claudestory_issue_list", description: "List issues with optional filters", params: ["status?", "severity?"] },
  { name: "claudestory_issue_get", description: "Get an issue by ID", params: ["id"] },
  { name: "claudestory_handover_list", description: "List handover filenames (newest first)" },
  { name: "claudestory_handover_latest", description: "Content of most recent handover" },
  { name: "claudestory_handover_get", description: "Content of a specific handover", params: ["filename"] },
  { name: "claudestory_handover_create", description: "Create a handover from markdown content", params: ["content", "slug?"] },
  { name: "claudestory_blocker_list", description: "All roadmap blockers with status" },
  { name: "claudestory_validate", description: "Reference integrity + schema checks" },
  { name: "claudestory_recap", description: "Session diff — changes since last snapshot" },
  { name: "claudestory_recommend", description: "Context-aware ranked work suggestions", params: ["count?"] },
  { name: "claudestory_snapshot", description: "Save current project state snapshot" },
  { name: "claudestory_export", description: "Self-contained project document", params: ["phase?", "all?"] },
  { name: "claudestory_note_list", description: "List notes", params: ["status?", "tag?"] },
  { name: "claudestory_note_get", description: "Get note by ID", params: ["id"] },
  { name: "claudestory_note_create", description: "Create note", params: ["content", "title?", "tags?"] },
  { name: "claudestory_note_update", description: "Update note", params: ["id", "content?", "title?", "tags?", "status?"] },
  { name: "claudestory_ticket_create", description: "Create ticket", params: ["title", "type", "phase?", "description?", "blockedBy?", "parentTicket?"] },
  { name: "claudestory_ticket_update", description: "Update ticket", params: ["id", "status?", "title?", "order?", "description?", "phase?", "parentTicket?"] },
  { name: "claudestory_issue_create", description: "Create issue", params: ["title", "severity", "impact", "components?", "relatedTickets?", "location?", "phase?"] },
  { name: "claudestory_issue_update", description: "Update issue", params: ["id", "status?", "title?", "severity?", "impact?", "resolution?", "components?", "relatedTickets?", "location?"] },
  { name: "claudestory_phase_create", description: "Create phase in roadmap", params: ["id", "name", "label", "description", "summary?", "after?", "atStart?"] },
  { name: "claudestory_selftest", description: "Integration smoke test — create/update/delete cycle" },
];

export function handleReference(format: OutputFormat): string {
  return formatReference(COMMANDS, MCP_TOOLS, format);
}
