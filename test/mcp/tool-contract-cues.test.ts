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
  { tool: "storybloq_unregister_subprocess", kind: "constraint", cue: "Idempotent" },
  { tool: "storybloq_unregister_subprocess", kind: "precedence", cue: "works even on expired/terminal sessions" },
  { tool: "storybloq_validate", kind: "enum-semantic", cue: "Scan all .story JSON without loading project state" },
  { tool: "storybloq_validate", kind: "selection", cue: "Works even when corrupt JSON blocks project loading" },
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
    // A ratchet, not a target. T-460 measured 45,224 -> 38,504 bytes, so this
    // ceiling leaves ~1.5 KB of headroom and fails once an edit gives back more
    // than that. Raising it is a deliberate act that belongs in a commit
    // message, which is the point. Deliberately NO lower bound: the cues above
    // are what protect against over-trimming, and a floor would fail an honest
    // future trim for being too good.
    const bytes = Buffer.byteLength(await emittedPayload(), "utf8");
    expect(bytes).toBeLessThan(40_000);
  });

  it("still advertises every tool, so the trim cut prose and not surface", async () => {
    const server = new McpServer({ name: "storybloq", version: "0.0.0" });
    registerAllTools(server, process.cwd());
    const client = new Client({ name: "count-test", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const result = await client.listTools();
    await client.close();
    expect(result.tools.length).toBe(60);
  });
});
