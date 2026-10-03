import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/mcp/tools.js";

/**
 * T-460: the tool-description contract, pinned against erosion.
 *
 * Trimming schema prose is a one-way door if nobody records what was load
 * bearing. Every cue below is something a CALLER relies on and cannot infer
 * from the schema: a destructive warning, a default, a constraint, the meaning
 * of an enum value, a precedence rule, or the sentence that lets a model pick
 * this tool over its sibling. Prose that explained WHY a field exists is not
 * here, and its removal is what paid for the trim (45,224 -> 38,504 bytes).
 *
 * These assert on the EMITTED tools/list payload rather than on the source, so
 * a cue deleted by a zod refactor, stripped by the SDK's schema conversion, or
 * lost to a lean-schema shim fails here the same way an edited string does.
 *
 * Scope, stated honestly: this locks TODAY's contract surface against future
 * erosion. It did not validate the trim that produced it -- that was an
 * adversarial pass per tool group, which caught 21 losses including one edit
 * whose line number would have deleted a field's range constraints. A cue is a
 * literal substring, which makes it brittle against rewording; if you reword a
 * cue deliberately, update it here in the same commit and say why.
 */

interface ContractCue {
  readonly tool: string;
  readonly kind: "destructive" | "default" | "constraint" | "enum-semantic" | "precedence" | "selection";
  readonly cue: string;
}

const CONTRACT_CUES: readonly ContractCue[] = [
  { tool: "storybloq_arrangement_coordinate", kind: "constraint", cue: "only the bound pen may write" },
  { tool: "storybloq_arrangement_coordinate", kind: "constraint", cue: "current session/revision" },
  { tool: "nodeParam (shared param, 8 tools)", kind: "constraint", cue: "(orchestrator only)" },
  { tool: "nodeParam (shared param, 8 tools)", kind: "selection", cue: "Operate on this node's .story/" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "(severity 'suggestion' is exempt)" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "Cancel only, and requires an explicit sessionId" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "Codex passes CODEX_THREAD_ID" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "LIVE non-COMPACT session" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "Markdown content" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "Required for non-auto modes" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "Required for report action" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "Resume only, with takeover: true" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "Resume only: recover a COMPACT session" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "T-XXX and ISS-XXX IDs" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "approve|revise|request_changes|reject" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "do NOT park a valid finding here" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "in work order" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "null for start action" },
  { tool: "storybloq_autonomous_guide", kind: "constraint", cue: "recorded owner task is confirmed gone" },
  { tool: "storybloq_autonomous_guide", kind: "default", cue: "Claude is auto-detected" },
  { tool: "storybloq_autonomous_guide", kind: "default", cue: "Default: mapped per item from type and risk" },
  { tool: "storybloq_autonomous_guide", kind: "default", cue: "Defaults to 'open'" },
  { tool: "storybloq_autonomous_guide", kind: "destructive", cue: "(ISS-982)" },
  { tool: "storybloq_autonomous_guide", kind: "destructive", cue: "AUTO-FILES a storybloq issue" },
  { tool: "storybloq_autonomous_guide", kind: "destructive", cue: "When true, bypasses FINALIZE's commit-attribution mismatch" },
  { tool: "storybloq_autonomous_guide", kind: "destructive", cue: "every use is audited" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "'PLAN' = the approach must be replanned" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "'contested' = false positive, files no issue" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "'deferred' = valid but out of scope" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "Actual reviewer backend used" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "END the session rather than adopt it" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "Empty or omitted = standard auto mode" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "auto=full autonomous" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "guided=single ticket" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "plan=plan+review" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "review=code review only" },
  { tool: "storybloq_autonomous_guide", kind: "enum-semantic", cue: "unresolved this round" },
  { tool: "storybloq_autonomous_guide", kind: "precedence", cue: "Per-item reviewEffort metadata still wins" },
  { tool: "storybloq_autonomous_guide", kind: "precedence", cue: "Start action only." },
  { tool: "storybloq_autonomous_guide", kind: "precedence", cue: "explicit project stage knobs always win" },
  { tool: "storybloq_autonomous_guide", kind: "precedence", cue: "on a non-approve verdict" },
  { tool: "storybloq_autonomous_guide", kind: "precedence", cue: "routes the session back to PLAN" },
  { tool: "storybloq_autonomous_guide", kind: "selection", cue: "(ISS-720)" },
  { tool: "storybloq_autonomous_guide", kind: "selection", cue: "Autonomous session orchestrator. Call at every decision point" },
  { tool: "storybloq_autonomous_guide", kind: "selection", cue: "For commit_done" },
  { tool: "storybloq_autonomous_guide", kind: "selection", cue: "For issue_picked" },
  { tool: "storybloq_autonomous_guide", kind: "selection", cue: "For ticket_picked" },
  { tool: "storybloq_autonomous_guide", kind: "selection", cue: "From review_lenses_prepare/synthesize" },
  { tool: "storybloq_autonomous_guide", kind: "selection", cue: "pass on lens-backed review_round reports" },
  { tool: "storybloq_bus_ack", kind: "constraint", cue: "From the Storybloq Bus SessionStart marker" },
  { tool: "storybloq_bus_ack", kind: "constraint", cue: "id from the storybloq-client-task marker" },
  { tool: "storybloq_bus_ack", kind: "precedence", cue: "does not resolve canonical work" },
  { tool: "storybloq_bus_ack", kind: "selection", cue: "addressed to this endpoint" },
  { tool: "storybloq_bus_poll", kind: "constraint", cue: "From the Storybloq Bus SessionStart marker" },
  { tool: "storybloq_bus_poll", kind: "constraint", cue: "id from the storybloq-client-task marker" },
  { tool: "storybloq_bus_poll", kind: "precedence", cue: "advisory peer authority" },
  { tool: "storybloq_bus_poll", kind: "precedence", cue: "must be independently verified" },
  { tool: "storybloq_bus_poll", kind: "selection", cue: "unacknowledged peer-agent messages" },
  { tool: "storybloq_bus_redeliver", kind: "constraint", cue: "From the Storybloq Bus SessionStart marker" },
  { tool: "storybloq_bus_redeliver", kind: "constraint", cue: "The hop-capped thread" },
  { tool: "storybloq_bus_redeliver", kind: "constraint", cue: "exact refused artifact" },
  { tool: "storybloq_bus_redeliver", kind: "constraint", cue: "hop-cap automatic park entry" },
  { tool: "storybloq_bus_redeliver", kind: "constraint", cue: "id from the storybloq-client-task marker" },
  { tool: "storybloq_bus_redeliver", kind: "precedence", cue: "Idempotent: repeat calls" },
  { tool: "storybloq_bus_redeliver", kind: "precedence", cue: "including from a successor endpoint, return the same successor" },
  { tool: "storybloq_bus_redeliver", kind: "selection", cue: "hop-cap-parked" },
  { tool: "storybloq_bus_send", kind: "constraint", cue: "Existing thread id for a reply" },
  { tool: "storybloq_bus_send", kind: "constraint", cue: "From the Storybloq Bus SessionStart marker" },
  { tool: "storybloq_bus_send", kind: "constraint", cue: "Required when creating a thread" },
  { tool: "storybloq_bus_send", kind: "constraint", cue: "Resolved predecessor for a successor thread" },
  { tool: "storybloq_bus_send", kind: "constraint", cue: "Storybloq Bus SessionStart marker" },
  { tool: "storybloq_bus_send", kind: "constraint", cue: "canonical unresolved critical issue" },
  { tool: "storybloq_bus_send", kind: "constraint", cue: "id from the storybloq-client-task marker" },
  { tool: "storybloq_bus_send", kind: "destructive", cue: "advisory peer-agent message" },
  { tool: "storybloq_bus_send", kind: "precedence", cue: "Deprecated and ignored" },
  { tool: "storybloq_bus_thread_get", kind: "constraint", cue: "From the Storybloq Bus SessionStart marker" },
  { tool: "storybloq_bus_thread_get", kind: "constraint", cue: "id from the storybloq-client-task marker" },
  { tool: "storybloq_bus_thread_get", kind: "precedence", cue: "never owner authority" },
  { tool: "storybloq_bus_thread_get", kind: "selection", cue: "verified prefix and folded state" },
  { tool: "storybloq_bus_thread_update", kind: "constraint", cue: "From the Storybloq Bus SessionStart marker" },
  { tool: "storybloq_bus_thread_update", kind: "constraint", cue: "evidence-backed reopen" },
  { tool: "storybloq_bus_thread_update", kind: "constraint", cue: "id from the storybloq-client-task marker" },
  { tool: "storybloq_bus_thread_update", kind: "selection", cue: "Apply one explicit park" },
  { tool: "storybloq_export", kind: "constraint", cue: "Export a single phase by ID" },
  { tool: "storybloq_export", kind: "constraint", cue: "Export entire project" },
  { tool: "storybloq_gate_ack_create", kind: "constraint", cue: "Exactly one of planFile or fromStaged is required" },
  { tool: "storybloq_gate_ack_create", kind: "constraint", cue: "ackRole is derived from the arrangement's own gate declaration, never freely chosen" },
  { tool: "storybloq_gate_ack_create", kind: "constraint", cue: "restricted BY CONVENTION to non-mutating caveats" },
  { tool: "storybloq_gate_ack_create", kind: "constraint", cue: "the commit it applies to has already been made" },
  { tool: "storybloq_gate_ack_create", kind: "enum-semantic", cue: "computes a plan-hash pin" },
  { tool: "storybloq_gate_ack_create", kind: "enum-semantic", cue: "Compute a tree-digest pin from the currently staged index" },
  { tool: "storybloq_gate_ack_contest", kind: "precedence", cue: "not a reopen workflow" },
  { tool: "storybloq_handover_create", kind: "constraint", cue: "from markdown content" },
  { tool: "storybloq_handover_create", kind: "constraint", cue: "phase5b-wrapup" },
  { tool: "storybloq_handover_create", kind: "default", cue: "Default: session" },
  { tool: "storybloq_handover_get", kind: "constraint", cue: "e.g. 2026-03-20-session.md" },
  { tool: "storybloq_handover_latest", kind: "default", cue: "default: 1" },
  { tool: "storybloq_handover_list", kind: "selection", cue: "newest first" },
  { tool: "storybloq_issue_create", kind: "default", cue: "Missing hashes are captured from the reviewed revision or working tree." },
  { tool: "storybloq_issue_create", kind: "precedence", cue: "A repeated create returns the existing issue." },
  { tool: "storybloq_issue_create", kind: "selection", cue: "Create a new issue" },
  { tool: "storybloq_issue_get", kind: "constraint", cue: "Issue ID (e.g. ISS-001, i-[canonical])" },
  { tool: "storybloq_issue_get", kind: "selection", cue: "Get an issue by ID" },
  { tool: "storybloq_issue_list", kind: "selection", cue: "List issues" },
  { tool: "storybloq_issue_meta_get", kind: "constraint", cue: "dot notation for nested values" },
  { tool: "storybloq_issue_meta_get", kind: "default", cue: "Omitting path returns all" },
  { tool: "storybloq_issue_meta_get", kind: "selection", cue: "Get custom passthrough metadata for an issue" },
  { tool: "storybloq_issue_meta_set", kind: "constraint", cue: "Core issue fields are protected" },
  { tool: "storybloq_issue_meta_set", kind: "constraint", cue: "Issue ID (e.g. ISS-001, i-[canonical])" },
  { tool: "storybloq_issue_meta_set", kind: "constraint", cue: "JSON-compatible metadata value" },
  { tool: "storybloq_issue_meta_set", kind: "constraint", cue: "dot notation for nested values" },
  { tool: "storybloq_issue_meta_set", kind: "selection", cue: "Set custom passthrough metadata on an issue" },
  { tool: "storybloq_issue_meta_unset", kind: "constraint", cue: "Core issue fields are protected" },
  { tool: "storybloq_issue_meta_unset", kind: "constraint", cue: "Issue ID (e.g. ISS-001, i-[canonical])" },
  { tool: "storybloq_issue_meta_unset", kind: "constraint", cue: "dot notation for nested values" },
  { tool: "storybloq_issue_meta_unset", kind: "selection", cue: "Unset custom passthrough metadata on an issue" },
  { tool: "storybloq_issue_update", kind: "constraint", cue: "Issue ID (e.g. ISS-001, i-[canonical])" },
  { tool: "storybloq_issue_update", kind: "enum-semantic", cue: "null clears the phase" },
  { tool: "storybloq_issue_update", kind: "enum-semantic", cue: "null clears the resolution" },
  { tool: "storybloq_issue_update", kind: "precedence", cue: "Replaces existing source refs" },
  { tool: "storybloq_issue_update", kind: "selection", cue: "Update an existing issue" },
  { tool: "storybloq_issue_update", kind: "constraint", cue: "Mutually exclusive with clearCitesRulings" },
  { tool: "storybloq_lesson_create", kind: "constraint", cue: "The actionable rule (1-3 sentences)" },
  { tool: "storybloq_lesson_create", kind: "constraint", cue: "evidence, ticket/issue refs" },
  { tool: "storybloq_lesson_create", kind: "selection", cue: "Create a new lesson" },
  { tool: "storybloq_lesson_digest", kind: "selection", cue: "active lessons" },
  { tool: "storybloq_lesson_digest", kind: "selection", cue: "primary read interface for context loading" },
  { tool: "storybloq_lesson_get", kind: "constraint", cue: "e.g. L-001 or l-[canonical]" },
  { tool: "storybloq_lesson_get", kind: "selection", cue: "Get a lesson by ID" },
  { tool: "storybloq_lesson_list", kind: "selection", cue: "List lessons" },
  { tool: "storybloq_lesson_reinforce", kind: "destructive", cue: "increment reinforcement count" },
  { tool: "storybloq_lesson_reinforce", kind: "destructive", cue: "update lastValidated date" },
  { tool: "storybloq_lesson_update", kind: "precedence", cue: "Replaces existing" },
  { tool: "storybloq_lesson_update", kind: "selection", cue: "Update an existing lesson" },
  { tool: "storybloq_node_add", kind: "constraint", cue: "(absolute or ~/relative). Must exist." },
  { tool: "storybloq_node_add", kind: "constraint", cue: "One-line status summary" },
  { tool: "storybloq_node_add", kind: "constraint", cue: "cycles rejected" },
  { tool: "storybloq_node_add", kind: "constraint", cue: "lowercase alphanumeric, hyphens, underscores" },
  { tool: "storybloq_node_add", kind: "enum-semantic", cue: "e.g. library, service, app" },
  { tool: "storybloq_node_add", kind: "enum-semantic", cue: "e.g. npm, swift-spm, cargo" },
  { tool: "storybloq_node_add", kind: "precedence", cue: "Absolute paths outside the orchestrator workspace are allowed" },
  { tool: "storybloq_node_add", kind: "selection", cue: "Runtime links to other nodes" },
  { tool: "storybloq_node_init", kind: "constraint", cue: "Node name from orchestrator config" },
  { tool: "storybloq_node_init", kind: "destructive", cue: "Overwrite existing config if .story/ already exists" },
  { tool: "storybloq_node_init", kind: "enum-semantic", cue: "e.g. npm, macapp, swift-spm" },
  { tool: "storybloq_node_init", kind: "precedence", cue: "Does not require allowNodeWrites" },
  { tool: "storybloq_node_update", kind: "precedence", cue: "Replace runtime links" },
  { tool: "storybloq_node_update", kind: "precedence", cue: "Replaces the list" },
  { tool: "storybloq_node_update", kind: "precedence", cue: "Shallow-merges provided fields" },
  { tool: "storybloq_node_update", kind: "precedence", cue: "preserving health and passthrough fields" },
  { tool: "storybloq_node_update", kind: "selection", cue: "Node name to update" },
  { tool: "storybloq_note_create", kind: "selection", cue: "Create a new note" },
  { tool: "storybloq_note_get", kind: "constraint", cue: "e.g. N-001 or n-[canonical]" },
  { tool: "storybloq_note_get", kind: "selection", cue: "Get a note by ID" },
  { tool: "storybloq_note_list", kind: "selection", cue: "List notes" },
  { tool: "storybloq_note_update", kind: "enum-semantic", cue: "null to clear" },
  { tool: "storybloq_note_update", kind: "precedence", cue: "Replaces existing" },
  { tool: "storybloq_note_update", kind: "selection", cue: "Update an existing note" },
  { tool: "storybloq_phase_create", kind: "constraint", cue: "(e.g. 'my-phase')" },
  { tool: "storybloq_phase_create", kind: "constraint", cue: "Exactly one of after or atStart is required" },
  { tool: "storybloq_phase_create", kind: "constraint", cue: "Lowercase alphanumeric with hyphens" },
  { tool: "storybloq_phase_create", kind: "constraint", cue: "One-line summary" },
  { tool: "storybloq_phase_create", kind: "constraint", cue: "e.g. 'PHASE 1'" },
  { tool: "storybloq_phase_create", kind: "precedence", cue: "Insert after this phase ID" },
  { tool: "storybloq_phase_create", kind: "precedence", cue: "Insert at beginning of roadmap" },
  { tool: "storybloq_phase_current", kind: "selection", cue: "First non-complete phase" },
  { tool: "storybloq_phase_list", kind: "enum-semantic", cue: "complete/inprogress/notstarted" },
  { tool: "storybloq_phase_tickets", kind: "constraint", cue: "e.g. p5b, dogfood" },
  { tool: "storybloq_phase_tickets", kind: "selection", cue: "Leaf tickets" },
  { tool: "storybloq_phase_tickets", kind: "selection", cue: "sorted by order" },
  { tool: "storybloq_recommend", kind: "default", cue: "default: 5" },
  { tool: "storybloq_register_subprocess", kind: "selection", cue: "distinguish slow builds from hung agents" },
  { tool: "storybloq_review_lenses_judge", kind: "constraint", cue: "From storybloq_review_lenses_synthesize; object or JSON string" },
  { tool: "storybloq_review_lenses_judge", kind: "enum-semantic", cue: "approve, revise, or reject" },
  { tool: "storybloq_review_lenses_judge", kind: "enum-semantic", cue: "recommendFixRound true" },
  { tool: "storybloq_review_lenses_judge", kind: "precedence", cue: "coverage gaps are never damped" },
  { tool: "storybloq_review_lenses_judge", kind: "selection", cue: "Step 3 of the multi-lens review" },
  { tool: "storybloq_review_lenses_prepare", kind: "constraint", cue: "issueKeys of findings deferred" },
  { tool: "storybloq_review_lenses_prepare", kind: "enum-semantic", cue: "plan text for PLAN_REVIEW" },
  { tool: "storybloq_review_lenses_prepare", kind: "precedence", cue: "same sessionId, reviewRound, and returned reviewId" },
  { tool: "storybloq_review_lenses_prepare", kind: "precedence", cue: "then call storybloq_review_lenses_synthesize" },
  { tool: "storybloq_review_lenses_prepare", kind: "selection", cue: "Step 1 of the multi-lens review" },
  { tool: "storybloq_review_lenses_prepare", kind: "selection", cue: "spawn as parallel subagents" },
  { tool: "storybloq_review_lenses_synthesize", kind: "constraint", cue: "Lens id from prepare's activeLenses" },
  { tool: "storybloq_review_lenses_synthesize", kind: "constraint", cue: "One entry per active lens" },
  { tool: "storybloq_review_lenses_synthesize", kind: "constraint", cue: "as an object or JSON string" },
  { tool: "storybloq_review_lenses_synthesize", kind: "constraint", cue: "{status, findings, error, notes}" },
  { tool: "storybloq_review_lenses_synthesize", kind: "default", cue: "Defaults to CODE_REVIEW" },
  { tool: "storybloq_review_lenses_synthesize", kind: "destructive", cue: "auto-files the pre-existing ones as new issues" },
  { tool: "storybloq_review_lenses_synthesize", kind: "enum-semantic", cue: "echoes cachedFindings returned by prepare" },
  { tool: "storybloq_review_lenses_synthesize", kind: "precedence", cue: "dedup of auto-filed pre-existing issues across rounds" },
  { tool: "storybloq_review_lenses_synthesize", kind: "precedence", cue: "not classified introduced vs pre-existing" },
  { tool: "storybloq_review_lenses_synthesize", kind: "precedence", cue: "pass reviewVerdict to storybloq_review_lenses_judge" },
  { tool: "storybloq_review_lenses_synthesize", kind: "selection", cue: "Step 2 of the multi-lens review" },
  { tool: "storybloq_review_lenses_synthesize", kind: "selection", cue: "classifies findings introduced vs pre-existing" },
  { tool: "storybloq_ruling_create", kind: "constraint", cue: "not verified by storybloq" },
  { tool: "storybloq_ruling_create", kind: "constraint", cue: "does not replace the second key" },
  { tool: "storybloq_ruling_get", kind: "selection", cue: "current chain status" },
  { tool: "storybloq_ruling_list", kind: "enum-semantic", cue: "omit for all" },
  { tool: "storybloq_ruling_list", kind: "selection", cue: "not a terminal one" },
  { tool: "storybloq_ruling_supersede", kind: "constraint", cue: "Refuses outright while any ruling" },
  { tool: "storybloq_ruling_supersede", kind: "default", cue: "omit to create-and-supersede" },
  { tool: "storybloq_ruling_supersede", kind: "precedence", cue: "never attempted against an unverifiable graph" },
  { tool: "storybloq_selftest", kind: "destructive", cue: "creates, updates, and deletes test entities" },
  { tool: "storybloq_session_guard", kind: "constraint", cue: "treated as no identity rather than rejected" },
  { tool: "storybloq_session_guard", kind: "precedence", cue: "CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID" },
  { tool: "storybloq_session_guard", kind: "precedence", cue: "overallAction is null when more than one session bears" },
  { tool: "storybloq_session_guard", kind: "selection", cue: "Reads only .story/sessions/ (no ledger load)" },
  { tool: "storybloq_snapshot", kind: "destructive", cue: ".story/snapshots/" },
  { tool: "storybloq_snapshot", kind: "destructive", cue: "Saves project state" },
  { tool: "storybloq_status", kind: "default", cue: "default: md" },
  { tool: "storybloq_ticket_blocked", kind: "selection", cue: "blocking dependencies" },
  { tool: "storybloq_ticket_create", kind: "precedence", cue: "Makes this a sub-ticket" },
  { tool: "storybloq_ticket_create", kind: "precedence", cue: "distinct sequential IDs" },
  { tool: "storybloq_ticket_get", kind: "constraint", cue: "T-001, T-079b, t-[canonical]" },
  { tool: "storybloq_ticket_get", kind: "selection", cue: "includes umbrella tickets" },
  { tool: "storybloq_ticket_list", kind: "selection", cue: "leaf tickets" },
  { tool: "storybloq_ticket_meta_get", kind: "constraint", cue: "Dot notation for nested values" },
  { tool: "storybloq_ticket_meta_get", kind: "precedence", cue: "Omitting path returns all" },
  { tool: "storybloq_ticket_meta_set", kind: "constraint", cue: "Core ticket fields are protected" },
  { tool: "storybloq_ticket_meta_set", kind: "constraint", cue: "Dot notation for nested values" },
  { tool: "storybloq_ticket_meta_set", kind: "constraint", cue: "Must be JSON-compatible" },
  { tool: "storybloq_ticket_meta_unset", kind: "constraint", cue: "Core ticket fields are protected" },
  { tool: "storybloq_ticket_meta_unset", kind: "constraint", cue: "Dot notation for nested values" },
  { tool: "storybloq_ticket_next", kind: "default", cue: "default: 1" },
  { tool: "storybloq_ticket_next", kind: "selection", cue: "Highest-priority unblocked" },
  { tool: "storybloq_ticket_update", kind: "constraint", cue: "(ISS-981)" },
  { tool: "storybloq_ticket_update", kind: "constraint", cue: "T-001, t-[canonical]" },
  { tool: "storybloq_ticket_update", kind: "constraint", cue: "engine:T-061" },
  { tool: "storybloq_ticket_update", kind: "constraint", cue: "reopening leaves existing claim material unchanged" },
  { tool: "storybloq_ticket_update", kind: "enum-semantic", cue: "Null to clear" },
  { tool: "storybloq_ticket_update", kind: "precedence", cue: "Does not take over a claim" },
  { tool: "storybloq_ticket_update", kind: "precedence", cue: "complete a ticket claimed by another session, or reopen a complete one" },
  { tool: "storybloq_ticket_update", kind: "constraint", cue: "Mutually exclusive with clearCitesRulings" },
  { tool: "storybloq_unregister_subprocess", kind: "constraint", cue: "Idempotent" },
  { tool: "storybloq_unregister_subprocess", kind: "precedence", cue: "works even on expired/terminal sessions" },
  { tool: "storybloq_validate", kind: "enum-semantic", cue: "Scan all .story JSON without loading project state" },
  { tool: "storybloq_validate", kind: "selection", cue: "Works even when corrupt JSON blocks project loading" },
  { tool: "storybloq_checkpoint_* (expected state, 4 tools)", kind: "constraint", cue: "a stale one is refused" },
  { tool: "storybloq_checkpoint_create", kind: "constraint", cue: "Needs `checkpoint enable` first" },
  { tool: "storybloq_checkpoint_resolve", kind: "constraint", cue: "An acceptance needs artifactRef" },
];

async function emittedPayload(): Promise<string> {
  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  registerAllTools(server, process.cwd());
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  await client.close();
  return JSON.stringify(result.tools);
}

describe("tool description contract (T-460)", () => {
  it("keeps every contract cue in the payload a client receives", async () => {
    const payload = await emittedPayload();
    const missing = CONTRACT_CUES.filter((c) => !payload.includes(c.cue));
    expect(
      missing.map((c) => `[${c.kind}] ${c.tool}: ${c.cue}`),
      "contract cues dropped from tools/list",
    ).toEqual([]);
  });

  it("holds the payload under its post-trim ceiling", async () => {
    // A ratchet, not a target. T-460 measured 45,224 -> 38,504 bytes; T-473
    // added three arrangement tools (get/create/update), measured at 40,307
    // bytes; T-474 added three gate-ack tools (get/create/contest), measured
    // at 42,632 bytes; T-475 added four earmark tools (get/reserve/assign/
    // release), measured at 45,615 bytes; T-476 added four ruling tools
    // (get/list/create/supersede), measured at 48,458 bytes, then section 10's
    // citesRuling/clearCitesRulings fields on ticket/issue create/update,
    // measured at 49,347 bytes; T-477 added storybloq_session_milestone and
    // storybloq_status's clientTaskId field, measured at 50,361 bytes; run 7
    // (ISS-1074/1076/1077) added a `node` param + description to ~15
    // federation-parity-relevant tools (ticket/issue create/update,
    // ticket_next/blocked, recommend, phase_tickets, earmark get/reserve/
    // assign/release) plus board-labeling and collision-preflight behavior,
    // measured at 51,711 bytes -- a deliberate, necessary growth (every one
    // of those tools needed federation awareness per ISS-1074/1076's own
    // acceptance criteria), not a prose bloat to trim; T-488 added nine
    // optional provenance inputs to the autonomous_guide report object
    // (reviewer/implementer model, tier, source, evidence, plus a backend turn
    // id), measured at 52,692 bytes. That last growth is FIELD SURFACE, not
    // prose: the descriptions were cut to two short lines precisely because of
    // this ratchet, and the full guidance lives in autonomous-mode.md and
    // `storybloq reference`, which are read once by whoever needs them rather
    // than shipped to every client on every tools/list. The nine cannot be
    // reduced further without losing something true -- dropping `source` would
    // record an unpinned session default as an explicit pin, which is the exact
    // fabrication the ticket exists to prevent. ISS-1115 added four optional
    // provenance fields to the same report finding object (dispositionReason,
    // origin, originClass, sinceRound), measured at 53,302 bytes. Same
    // character as T-488's growth and trimmed the same way first: the initial
    // descriptions restated the whole originClass taxonomy and gave back 381
    // bytes when cut, because that taxonomy already ships in the round context
    // packet's ORIGIN_RULE -- mandatory payload, every round, all three
    // reviewer routes. What remains is the field surface itself and cannot go
    // without losing the item's mechanism: a reviewer cannot label a re-raise
    // through a schema that does not declare the field, and an undeclared key
    // is stripped by the SDK before the stage ever sees it. T-494 added two
    // optional fields to the lens-review pair -- `target` on prepare and
    // `citedRulingsUndelivered` on synthesize -- measured at 53,975 bytes.
    // Field surface again, and the same undeclared-key argument is not an
    // analogy here but the actual defect being fixed: a synthesize schema with
    // no way to receive the delivery map let a review that never saw its item's
    // rulings reach approve, because the SDK stripped the key the handler was
    // ready to read. Trimmed first, as the ratchet intends: both descriptions
    // were cut to the sentence that is not already in review-lenses.md and
    // `storybloq reference`, giving back 208 bytes, and neither can go further
    // without losing which field to echo or when it stops being optional.
    // ISS-1155 adds one typed coordination operation union and optional get
    // format, measured below 61 KB. Most growth is required field surface
    // (identities, fences, evidence and assignment events), not descriptions;
    // its description was trimmed before raising this explicit budget.
    // T-499 adds storybloq_session_intel: one tool, six optional fields,
    // measured at 61,920 after its description was cut to the sentence not
    // already in `storybloq reference` and four field descriptions were
    // dropped to their names. The remaining growth is field surface, so the
    // budget is raised from 61,500 to 62,500 as a deliberate act.
    // T-502 adds storybloq_health: one tool, three optional fields, measured
    // at 62,587 after its description was cut to the one sentence not already
    // in `storybloq reference` and settings.md plus the relay instruction, and
    // two of its three field descriptions were dropped. What remains is field
    // surface -- `only` cannot be a free string without letting a client ask
    // for a check that does not exist, and the enum IS the surface. So the
    // budget is raised from 62,500 to 63,500 as a deliberate act.
    // T-320 commit 5 then adds two optional fields (limit, select) to
    // storybloq_lesson_digest after the same trim (its own measurement was
    // 62,745 without T-502); the combined payload is re-measured at landing.
    // ISS-1154 Commit A adds `format` and `withActionability` to
    // storybloq_ticket_get and storybloq_issue_get after the same trim
    // (`format` described as "default: md", `withActionability` undescribed);
    // measured at 63,633 on main with T-502 and T-320 present, so the budget
    // is raised from 63,500 to 64,000 as a deliberate act.
    // T-498 commit 2 adds one optional `format` field ("default: md") to
    // storybloq_handover_latest, so a caller can request the JSON envelope
    // (continuationCandidates/trajectory included) instead of the Markdown
    // rendering that field has no representation for, and the same field to
    // storybloq_handover_get so a caller (recovery code, not a human) can
    // machine-detect a not_found/io_error result via {version, error} vs
    // {version, data} instead of string-sniffing Markdown error text;
    // measured at 63,795, still under the existing 64,000 ceiling, no raise
    // needed.
    // ISS-950 then added one optional `capReasons` array to the
    // autonomous_guide report object, so a reviewer can echo
    // reviewVerdict.capReasons and the stage can tell a coverage-only cap from
    // a findings cap; measured at 63,997, which is +197 over 63,800 and left
    // THREE bytes of headroom without raising this budget. That was the
    // mistake: the growth was honest (field surface plus one describe line),
    // the silence about it was not, and the next legitimate edit inherited a
    // ceiling it could not clear. T-509 part 4 was that edit, adding 45 bytes
    // to storybloq_health's description so it says the Codex bridge is
    // launched and answered rather than merely registered; measured at 64,042
    // and red. Both growths were trimmed before this raise, per the ratchet's
    // own order of operations: `capReasons` can be cut to about 60 characters,
    // which lands the payload at 63,991, and nine bytes of headroom is the
    // same trap as three. So the budget is raised from 64,000 to 64,500 as a
    // deliberate act, restoring ~458 bytes of real headroom and keeping both
    // descriptions readable.
    // T-523 raises this from 64,500 to 71,000 for the six capability tools,
    // and records a FLOOR rather than only a number, because the last raise's
    // ~458 bytes of headroom is what put the next edit in this position. The
    // measurements, in order: 69,985 as first written, then 69,527 after
    // trimming every description to only the contract a caller cannot infer
    // from the tool's name. That trim kept exactly five things -- the bound on
    // match, the computed status on list, the HEAD stamp on add, the untouched
    // checkpoint on update, and the stamp refusal on check -- and cutting
    // further would cut contract rather than prose, which is what the cues
    // above exist to prevent. So ~69,527 is the floor for this surface, and
    // 71,000 is that floor plus deliberate headroom: a ratchet whose headroom
    // is smaller than one feature's worth of contract is a tripwire for
    // whoever arrives next rather than a budget.
    // T-524 raises this from 71,000 to 76,000 for the five glossary tools, and
    // records BOTH measurements the raise rests on, per T-523's floor rule.
    // Measured: 69,567 without them (the payload as it stood), 72,748 as first
    // written, 72,696 after trimming the two sentences that were prose rather
    // than contract -- "a session load wants" on list, and "omitted fields are
    // left alone" on update, which is inferable from the word update. That is
    // a 52-byte trim on a 3,181-byte surface, and the smallness is the honest
    // finding rather than a shortfall: these five descriptions were written
    // under T-523's rule already, so each carries only what a caller cannot
    // infer from the tool's name (the match is advisory, the digest has a cap
    // with core-only above it, one word belongs to one entry, supplied lists
    // replace). Cutting further would cut contract, which the cues above exist
    // to prevent. Then 72,703, seven bytes back, when review found the `core`
    // parameter claiming a core term always loads: above the cap the digest is
    // still capped and the excess core terms are only counted, so the text now
    // says "eligible". A true 7 bytes over a false 0. So 72,703 is the floor
    // for this surface.
    //
    // The headroom is 3,297 bytes, chosen as roughly what this feature itself
    // cost (3,136 for five tools) rather than as a round number. T-523 wrote
    // down the rule that a ratchet whose headroom is smaller than one
    // feature's worth of contract is a tripwire for whoever arrives next, and
    // then left 1,473 against a 5,900-byte addition; this is the first raise
    // to actually size the headroom by that rule.
    //
    // Raising this is a deliberate act that belongs in a commit message, which
    // is the point. Deliberately NO lower bound: the cues above are what
    // protect against over-trimming, and a floor would fail an honest future
    // trim for being too good.
    const bytes = Buffer.byteLength(await emittedPayload(), "utf8");
    // T-522 commit 2b: three ruling lifecycle tools plus `status` on list,
    // `branch` on supersede and four narrative fields on create/supersede/
    // propose, measured at 77,269 bytes; ceiling sized to headroom by T-523's
    // rule (feature cost 4,566 bytes; headroom 2,731).
    // T-537 S5 adds the six owner checkpoint write tools. Measured: 78,477
    // bytes without them, 82,915 as first written, 82,718 after trimming each
    // description to its reference.md one-liner (197 bytes). What remains,
    // 4,241 bytes, is schema: the expected-state triple and the content
    // fields with their bounds, which are contract, as are the three cues
    // above. Then 83,019 once resolve gained its ruling provenance
    // (rulingAttribution, rulingScopeTags, clientTaskId: 301 bytes), so the
    // feature costs 4,542. The old ceiling left 1,523 bytes, under one
    // feature's worth, so it is raised to 87,600: the 83,019 floor plus this
    // feature's own cost, rounded up to the hundred, per T-523's rule.
    expect(bytes).toBeLessThan(87_600);
  });

  it("still advertises every tool, so the trim cut prose and not surface", async () => {
    const server = new McpServer({ name: "storybloq", version: "0.0.0" });
    registerAllTools(server, process.cwd());
    const client = new Client({ name: "count-test", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const result = await client.listTools();
    await client.close();
    // T-473 added storybloq_arrangement_get/create/update (60 -> 63); no
    // _list tool, per amendment A3 (status's activeArrangements covers
    // discovery). T-474 added storybloq_gate_ack_get/create/contest
    // (63 -> 66); no _list tool either, same ruling. T-475 added
    // storybloq_earmark_get/reserve/assign/release (66 -> 70); no _list
    // tool either -- earmarks are a field on the item, not a standalone
    // entity, so there is nothing to enumerate independently. T-476 added
    // storybloq_ruling_get/list/create/supersede (70 -> 74); unlike the
    // three prior additions, section 11 of the ratified plan explicitly
    // calls for a _list tool here (citation resolution should be
    // discoverable without shelling out to the CLI). T-477 added
    // storybloq_session_milestone (74 -> 75); no _list tool, matching the
    // arrangement/gate-ack/earmark precedent -- a milestone is a field on
    // the caller's own presence record, not a standalone enumerable entity.
    // ISS-1155 adds one coordinated operation tool (75 -> 76). T-499 adds
    // storybloq_session_intel (76 -> 77), registered in the full AND the
    // degraded set because the no-project case is where an agent most needs
    // to know its context pressure; no _list tool, nothing to enumerate.
    // T-502 adds storybloq_health (77 -> 78), registered in the full AND the
    // degraded set for the same reason: a user with no `.story/` yet is
    // exactly the one running a stale CLI with no review bridge. No _list
    // tool; the six check ids are a closed enum in the schema.
    // T-507 adds storybloq_roster_get (78 -> 79), f2c12b23. T-523 adds
    // storybloq_capability_match/list/get/add/update/check (79 -> 85). All six
    // leaves reach MCP, `list` included: the ruling that kept arrangement,
    // gate-ack and earmark lists CLI-only rested on their consumer being a
    // human at a terminal, and the capability inventory's consumer is the
    // agent deciding whether a task is already built. T-524 adds
    // storybloq_term_match/list/get/add/update (85 -> 90): FIVE, not six --
    // `term remove` stays CLI-only under the standing ruling that keeps
    // destructive catalog operations off MCP, and unlike the arrangement and
    // gate-ack cases `list` does reach MCP here for the same reason the
    // capability list did, since the agent reading a brief is the consumer.
    // T-522 commit 2b adds storybloq_ruling_propose/accept/withdraw (90 -> 93):
    // the proposal lifecycle has an agent consumer (a worker proposes, the pen
    // accepts with the reviewed digest), so all three reach MCP.
    // T-526 adds storybloq_context_brief (93 -> 94): the brief's consumer is
    // the agent about to plan. `brief --rebase` writes session state and
    // stays CLI-only.
    // T-528 adds storybloq_projection_write (94 -> 95): the Mac app's reader
    // needs a full-freshness projection an agent can regenerate on request.
    // T-537 S5 adds six checkpoint tools (95 -> 101): create, attach,
    // resolve, change, reopen, retire. enable, resolve-conflict and list stay
    // CLI-only: enable changes how git merges the ledger, a conflict is the
    // merging person's to settle, and ticket get/list already show checkpoints.
    // ISS-1290 adds storybloq_arrangement_rebind (101 -> 102): the successor's new pen is an agent consumer; the spec names an MCP tool.
    expect(result.tools.length).toBe(102);
  });
});
