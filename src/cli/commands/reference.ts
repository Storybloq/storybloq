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
    usage: "storybloq init [--name <name>] [--type <type>] [--language <lang>] [--force] [--format json|md]",
    flags: ["--name", "--type", "--language", "--force"],
  },
  {
    name: "status",
    description: "Project summary: phase statuses, ticket/issue counts, blockers",
    usage: "storybloq status [--format json|md]",
  },
  {
    name: "ticket list",
    description: "List tickets with optional filters",
    usage: "storybloq ticket list [--status <s>] [--phase <p>] [--type <t>] [--format json|md]",
    flags: ["--status", "--phase", "--type"],
  },
  {
    name: "ticket get",
    description: "Get ticket details by ID",
    usage: "storybloq ticket get <id> [--format json|md]",
  },
  {
    name: "ticket next",
    description: "Suggest next ticket(s) to work on",
    usage: "storybloq ticket next [--count N] [--format json|md]",
  },
  {
    name: "ticket blocked",
    description: "List blocked tickets with their blocking dependencies",
    usage: "storybloq ticket blocked [--format json|md]",
  },
  {
    name: "ticket create",
    description: "Create a new ticket",
    usage: "storybloq ticket create --title <t> --type <type> [--phase <p>] [--description <d>] [--blocked-by <ids>] [--parent-ticket <id>] [--format json|md]",
    flags: ["--title", "--type", "--phase", "--description", "--blocked-by", "--parent-ticket"],
  },
  {
    name: "ticket update",
    description: "Update a ticket",
    usage: "storybloq ticket update <id> [--status <s>] [--title <t>] [--type <type>] [--phase <p>] [--order <n>] [--description <d>] [--blocked-by <ids>] [--parent-ticket <id>] [--format json|md]",
    flags: ["--status", "--title", "--type", "--phase", "--order", "--description", "--blocked-by", "--parent-ticket"],
  },
  {
    name: "ticket meta",
    description: "Get, set, or unset custom passthrough metadata on a ticket",
    usage: "storybloq ticket meta get|set|unset <id> [path] [value] [--format json|md]",
  },
  {
    name: "ticket delete",
    description: "Delete a ticket",
    usage: "storybloq ticket delete <id> [--force] [--format json|md]",
    flags: ["--force"],
  },
  {
    name: "issue list",
    description: "List issues with optional filters",
    usage: "storybloq issue list [--status <s>] [--severity <sev>] [--format json|md]",
    flags: ["--status", "--severity"],
  },
  {
    name: "issue get",
    description: "Get issue details by ID",
    usage: "storybloq issue get <id> [--format json|md]",
  },
  {
    name: "issue create",
    description: "Create a new issue",
    usage: "storybloq issue create --title <t> --severity <s> --impact <i> [--components <c>] [--related-tickets <ids>] [--location <locs>] [--phase <p>] [--format json|md]",
    flags: ["--title", "--severity", "--impact", "--components", "--related-tickets", "--location", "--phase"],
  },
  {
    name: "issue update",
    description: "Update an issue",
    usage: "storybloq issue update <id> [--status <s>] [--title <t>] [--severity <sev>] [--impact <i>] [--resolution <r>] [--components <c>] [--related-tickets <ids>] [--location <locs>] [--order <n>] [--phase <p>] [--format json|md]",
    flags: ["--status", "--title", "--severity", "--impact", "--resolution", "--components", "--related-tickets", "--location", "--order", "--phase"],
  },
  {
    name: "issue meta",
    description: "Get, set, or unset custom passthrough metadata on an issue",
    usage: "storybloq issue meta get|set|unset <id> [path] [value] [--format json|md]",
  },
  {
    name: "issue delete",
    description: "Delete an issue",
    usage: "storybloq issue delete <id> [--format json|md]",
  },
  {
    name: "phase list",
    description: "List all phases with derived status",
    usage: "storybloq phase list [--format json|md]",
  },
  {
    name: "phase current",
    description: "Show current (first non-complete) phase",
    usage: "storybloq phase current [--format json|md]",
  },
  {
    name: "phase tickets",
    description: "List tickets in a specific phase",
    usage: "storybloq phase tickets --phase <id> [--format json|md]",
    flags: ["--phase"],
  },
  {
    name: "phase create",
    description: "Create a new phase",
    usage: "storybloq phase create --id <id> --name <n> --label <l> --description <d> [--summary <s>] [--after <id>] [--at-start] [--format json|md]",
    flags: ["--id", "--name", "--label", "--description", "--summary", "--after", "--at-start"],
  },
  {
    name: "phase rename",
    description: "Rename/update phase metadata",
    usage: "storybloq phase rename <id> [--name <n>] [--label <l>] [--description <d>] [--summary <s>] [--format json|md]",
    flags: ["--name", "--label", "--description", "--summary"],
  },
  {
    name: "phase move",
    description: "Move a phase to a new position",
    usage: "storybloq phase move <id> [--after <id>] [--at-start] [--format json|md]",
    flags: ["--after", "--at-start"],
  },
  {
    name: "phase delete",
    description: "Delete a phase",
    usage: "storybloq phase delete <id> [--reassign <phase-id>] [--format json|md]",
    flags: ["--reassign"],
  },
  {
    name: "handover list",
    description: "List handover filenames (newest first)",
    usage: "storybloq handover list [--format json|md]",
  },
  {
    name: "handover latest",
    description: "Content of most recent handover",
    usage: "storybloq handover latest [--format json|md]",
  },
  {
    name: "handover get",
    description: "Content of a specific handover",
    usage: "storybloq handover get <filename> [--format json|md]",
  },
  {
    name: "handover create",
    description: "Create a new handover document",
    usage: "storybloq handover create [--content <md>] [--stdin] [--slug <slug>] [--format json|md]",
    flags: ["--content", "--stdin", "--slug"],
  },
  {
    name: "blocker list",
    description: "List all roadmap blockers",
    usage: "storybloq blocker list [--format json|md]",
  },
  {
    name: "blocker add",
    description: "Add a new blocker",
    usage: "storybloq blocker add --name <n> [--note <note>] [--format json|md]",
    flags: ["--name", "--note"],
  },
  {
    name: "blocker clear",
    description: "Clear (resolve) a blocker",
    usage: "storybloq blocker clear --name <n> [--note <note>] [--format json|md]",
    flags: ["--name", "--note"],
  },
  {
    name: "note list",
    description: "List notes with optional status/tag filters",
    usage: "storybloq note list [--status <s>] [--tag <t>] [--format json|md]",
    flags: ["--status", "--tag"],
  },
  {
    name: "note get",
    description: "Get a note by ID",
    usage: "storybloq note get <id> [--format json|md]",
  },
  {
    name: "note create",
    description: "Create a new note",
    usage: "storybloq note create --content <c> [--title <t>] [--tags <tags>] [--format json|md]",
    flags: ["--content", "--title", "--tags"],
  },
  {
    name: "note update",
    description: "Update a note",
    usage: "storybloq note update <id> [--content <c>] [--title <t>] [--tags <tags>] [--clear-tags] [--status <s>] [--format json|md]",
    flags: ["--content", "--title", "--tags", "--clear-tags", "--status"],
  },
  {
    name: "note delete",
    description: "Delete a note",
    usage: "storybloq note delete <id> [--format json|md]",
  },
  {
    name: "validate",
    description: "Reference integrity + schema checks on all .story/ files",
    usage: "storybloq validate [--format json|md]",
  },
  {
    name: "snapshot",
    description: "Save current project state for session diffs",
    usage: "storybloq snapshot [--quiet] [--format json|md]",
    flags: ["--quiet"],
  },
  {
    name: "recap",
    description: "Session diff — changes since last snapshot + suggested actions",
    usage: "storybloq recap [--format json|md]",
  },
  {
    name: "export",
    description: "Self-contained project document for sharing",
    usage: "storybloq export [--phase <id>] [--all] [--format json|md]",
    flags: ["--phase", "--all"],
  },
  {
    name: "recommend",
    description: "Context-aware work suggestions",
    usage: "storybloq recommend [--count N] [--format json|md]",
  },
  {
    name: "reference",
    description: "Print CLI command and MCP tool reference",
    usage: "storybloq reference [--format json|md]",
  },
  {
    name: "selftest",
    description: "Run integration smoke test — create/update/delete cycle across all entity types",
    usage: "storybloq selftest [--format json|md]",
  },
  {
    name: "codex-review",
    description: "Run native Codex plan or code review for an autonomous session",
    usage: "storybloq codex-review plan|code --session <id> --format guide-report",
    flags: ["--session", "--format"],
  },
  {
    name: "setup",
    description: "Install Storybloq skill, MCP, and hooks for Claude, Codex, or both",
    usage: "storybloq setup [--client claude|codex|all] [--skip-hooks]",
    flags: ["--client", "--skip-hooks"],
  },
  {
    name: "setup-skill",
    description: "Compatibility alias for `storybloq setup --client claude`",
    usage: "storybloq setup-skill [--skip-hooks]",
    flags: ["--skip-hooks"],
  },
];

export const MCP_TOOLS: readonly McpToolEntry[] = [
  { name: "storybloq_status", description: "Project summary: phase statuses, ticket/issue counts, blockers" },
  { name: "storybloq_phase_list", description: "All phases with derived status" },
  { name: "storybloq_phase_current", description: "First non-complete phase" },
  { name: "storybloq_phase_tickets", description: "Leaf tickets for a specific phase", params: ["phaseId"] },
  { name: "storybloq_ticket_list", description: "List leaf tickets with optional filters", params: ["status?", "phase?", "type?"] },
  { name: "storybloq_ticket_get", description: "Get a ticket by ID", params: ["id"] },
  { name: "storybloq_ticket_meta_get", description: "Get custom passthrough metadata from a ticket", params: ["id", "path?"] },
  { name: "storybloq_ticket_next", description: "Highest-priority unblocked ticket(s)", params: ["count?"] },
  { name: "storybloq_ticket_blocked", description: "All blocked tickets with dependencies" },
  { name: "storybloq_issue_list", description: "List issues with optional filters", params: ["status?", "severity?", "component?"] },
  { name: "storybloq_issue_get", description: "Get an issue by ID", params: ["id"] },
  { name: "storybloq_issue_meta_get", description: "Get custom passthrough metadata from an issue", params: ["id", "path?"] },
  { name: "storybloq_handover_list", description: "List handover filenames (newest first)" },
  { name: "storybloq_handover_latest", description: "Content of most recent handover" },
  { name: "storybloq_handover_get", description: "Content of a specific handover", params: ["filename"] },
  { name: "storybloq_handover_create", description: "Create a handover from markdown content", params: ["content", "slug?"] },
  { name: "storybloq_blocker_list", description: "All roadmap blockers with status" },
  { name: "storybloq_validate", description: "Reference integrity + schema checks" },
  { name: "storybloq_recap", description: "Session diff — changes since last snapshot" },
  { name: "storybloq_recommend", description: "Context-aware ranked work suggestions", params: ["count?"] },
  { name: "storybloq_snapshot", description: "Save current project state snapshot" },
  { name: "storybloq_export", description: "Self-contained project document", params: ["phase?", "all?"] },
  { name: "storybloq_note_list", description: "List notes", params: ["status?", "tag?"] },
  { name: "storybloq_note_get", description: "Get note by ID", params: ["id"] },
  { name: "storybloq_note_create", description: "Create note", params: ["content", "title?", "tags?"] },
  { name: "storybloq_note_update", description: "Update note", params: ["id", "content?", "title?", "tags?", "status?"] },
  { name: "storybloq_ticket_create", description: "Create ticket", params: ["title", "type", "phase?", "description?", "blockedBy?", "parentTicket?"] },
  { name: "storybloq_ticket_update", description: "Update ticket", params: ["id", "status?", "title?", "type?", "order?", "description?", "phase?", "parentTicket?", "blockedBy?"] },
  { name: "storybloq_ticket_meta_set", description: "Set custom passthrough metadata on a ticket", params: ["id", "path", "value"] },
  { name: "storybloq_ticket_meta_unset", description: "Unset custom passthrough metadata from a ticket", params: ["id", "path"] },
  { name: "storybloq_issue_create", description: "Create issue", params: ["title", "severity", "impact", "components?", "relatedTickets?", "location?", "phase?"] },
  { name: "storybloq_issue_update", description: "Update issue", params: ["id", "status?", "title?", "severity?", "impact?", "resolution?", "components?", "relatedTickets?", "location?", "order?", "phase?"] },
  { name: "storybloq_issue_meta_set", description: "Set custom passthrough metadata on an issue", params: ["id", "path", "value"] },
  { name: "storybloq_issue_meta_unset", description: "Unset custom passthrough metadata from an issue", params: ["id", "path"] },
  { name: "storybloq_phase_create", description: "Create phase in roadmap", params: ["id", "name", "label", "description", "summary?", "after?", "atStart?"] },
  { name: "storybloq_lesson_list", description: "List lessons", params: ["status?", "tag?", "source?"] },
  { name: "storybloq_lesson_get", description: "Get lesson by ID", params: ["id"] },
  { name: "storybloq_lesson_digest", description: "Ranked digest of active lessons for context loading" },
  { name: "storybloq_lesson_create", description: "Create lesson", params: ["title", "content", "context", "source", "tags?", "supersedes?"] },
  { name: "storybloq_lesson_update", description: "Update lesson", params: ["id", "title?", "content?", "context?", "tags?", "status?", "supersedes?"] },
  { name: "storybloq_lesson_reinforce", description: "Reinforce lesson — increment count and update lastValidated", params: ["id"] },
  { name: "storybloq_selftest", description: "Integration smoke test — create/update/delete cycle" },
  { name: "storybloq_review_lenses_prepare", description: "Prepare multi-lens review — activation, secrets gate, context packaging, prompt building", params: ["stage", "diff", "changedFiles", "ticketDescription?", "reviewRound?", "priorDeferrals?"] },
  { name: "storybloq_review_lenses_synthesize", description: "Synthesize lens results — schema validation, blocking policy, merger prompt generation", params: ["stage?", "lensResults", "activeLenses", "skippedLenses", "reviewRound?", "reviewId?"] },
  { name: "storybloq_review_lenses_judge", description: "Prepare judge prompt — verdict calibration, convergence tracking", params: ["mergerResultRaw", "stage?", "lensesCompleted", "lensesFailed", "lensesInsufficientContext?", "lensesSkipped?", "convergenceHistory?"] },
];

export function handleReference(format: OutputFormat): string {
  return formatReference(COMMANDS, MCP_TOOLS, format);
}
