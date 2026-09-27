#!/usr/bin/env tsx
/**
 * Writes `test/fixtures/owner-checkpoint-vectors.json` (T-537): the owner
 * checkpoint vectors the CLI and the Mac app both pin. Digest vectors record
 * the canonical projection and its sha256; scenario vectors record small
 * ticket sets and what the predicates in `src/core/owner-checkpoint.ts`
 * return for them. Every expected value comes from the CLI code, never from a
 * hand-typed hash; a drift test regenerates the file in memory and compares.
 *
 * Usage:
 *   tsx scripts/owner-checkpoint-vectors.ts            # write the file
 *   tsx scripts/owner-checkpoint-vectors.ts --stdout   # print it
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/bus/canonical.js";
import {
  MAX_CHECKPOINT_COUNTER,
  checkpointDigest,
  checkpointProjection,
  checkpointState,
  checkpointReleases,
  pendingCheckpointBlockers,
  reassessCheckpoints,
  type CheckpointContent,
  type CheckpointEvent,
} from "../src/core/owner-checkpoint.js";
import { ProjectState } from "../src/core/project-state.js";
import { TicketSchema, type Ticket } from "../src/models/ticket.js";
import { RoadmapSchema } from "../src/models/roadmap.js";
import { ConfigSchema } from "../src/models/config.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VECTORS_OUT = join(pkgRoot, "test", "fixtures", "owner-checkpoint-vectors.json");

// --- digest vectors ------------------------------------------------------------------

export interface DigestSpec {
  readonly name: string;
  readonly content: CheckpointContent;
}

export const DIGEST_SPECS: readonly DigestSpec[] = [
  { name: "decision", content: { kind: "decision", question: "Ship with dark mode?", evidenceRefs: [] } },
  { name: "acceptance", content: { kind: "acceptance", criteria: "Signup works end to end", evidenceRefs: ["docs/demo.md", "T-001"] } },
  { name: "evidence-order-kept", content: { kind: "acceptance", criteria: "Signup works end to end", evidenceRefs: ["T-001", "docs/demo.md"] } },
  { name: "null-question-omitted", content: { kind: "acceptance", question: null, criteria: "c", evidenceRefs: [] } },
  { name: "nfd-normalised", content: { kind: "decision", question: "Cafe\u0301 or te\u0301?", evidenceRefs: ["re\u0301sume\u0301.md"] } },
  { name: "nfc-equivalent", content: { kind: "decision", question: "Caf\u00e9 or t\u00e9?", evidenceRefs: ["r\u00e9sum\u00e9.md"] } },
  { name: "escapes", content: { kind: "decision", question: "quote \" backslash \\ newline \n tab \t bell \u0007 del \u007f sep \u2028 emoji \u{1F600}", evidenceRefs: ["a/\"b\"", "\u0000"] } },
  { name: "both-texts", content: { kind: "decision", question: "q", criteria: "c", evidenceRefs: ["x"] } },
];

// --- scenario vectors ----------------------------------------------------------------

const AT = "2026-09-27T00:00:00.000Z";

function ticket(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    title: id,
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order: 10,
    createdDate: "2026-09-27",
    completedDate: null,
    blockedBy: [],
    ...fields,
  };
}

interface CpOptions {
  readonly kind?: "decision" | "acceptance";
  readonly question?: string;
  readonly criteria?: string;
  readonly lifecycle?: "active" | "retired";
  readonly revision?: number;
  readonly generation?: number;
  /** Override the stored digest (default: computed from the content). */
  readonly digest?: string;
  readonly resolved?: { readonly revision?: number; readonly generation?: number; readonly digest?: string; readonly artifactRef?: string } | null;
  readonly events?: readonly CheckpointEvent[];
}

function checkpoint(o: CpOptions): Record<string, unknown> {
  const kind = o.kind ?? "decision";
  const content: CheckpointContent = kind === "decision" ? { kind, question: o.question ?? "Proceed?", evidenceRefs: [] } : { kind, criteria: o.criteria ?? "Works", evidenceRefs: ["demo.md"] };
  const digest = o.digest ?? checkpointDigest(content);
  const revision = o.revision ?? 1;
  const generation = o.generation ?? 2;
  const events = o.events ?? ["created", "resolved"];
  const cp: Record<string, unknown> = {
    ...content,
    owner: "owner",
    lifecycle: o.lifecycle ?? "active",
    revision,
    digest,
    generation,
    history: events.map((event, i) => ({ event, kind, at: AT, by: "owner", generation: i + 1, revision, digest, evidenceRefs: content.evidenceRefs })),
  };
  if (o.lifecycle === "retired") cp.retiredAt = AT;
  if (o.resolved !== null && o.resolved !== undefined) {
    cp.resolution = {
      response: "yes",
      respondedBy: "owner",
      respondedAt: AT,
      revision: o.resolved.revision ?? revision,
      digest: o.resolved.digest ?? digest,
      generation: o.resolved.generation ?? generation,
      ...(o.resolved.artifactRef !== undefined ? { artifactRef: o.resolved.artifactRef } : {}),
    };
  }
  return cp;
}

/** Evidence as a completed dependent records it for `cp` (ticket id `id`). */
function evidence(id: string, cp: Record<string, unknown>, state: "approved" | "retired", generation?: number): Record<string, unknown> {
  return { checkpoint: id, generation: generation ?? cp.generation, revision: cp.revision, digest: cp.digest, state };
}

export interface ScenarioSpec {
  readonly name: string;
  readonly description: string;
  readonly tickets: readonly Record<string, unknown>[];
}

const done = { status: "complete", completedDate: "2026-09-27" };
const approvedCp = checkpoint({ resolved: {} });
const retiredCp = checkpoint({ lifecycle: "retired", events: ["created", "retired"] });
const reapprovedCp = checkpoint({ generation: 5, resolved: {}, events: ["created", "resolved", "reopened", "resolved"] });
const adoptedCp = checkpoint({ lifecycle: "retired", generation: 5, events: ["created", "resolved", "changed", "retired", "retirement-adopted"] });

export const SCENARIO_SPECS: readonly ScenarioSpec[] = [
  { name: "pending", description: "an open checkpoint with no resolution blocks its dependent", tickets: [ticket("T-001", { ownerCheckpoint: checkpoint({ resolved: null, generation: 1, events: ["created"] }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "approved", description: "a complete checkpoint with a current resolution releases; evidence at the current values is clear (2a)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: approvedCp }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", approvedCp, "approved")] })] },
  { name: "approved-status-open", description: "a resolution alone does not approve: the checkpoint ticket must be complete", tickets: [ticket("T-001", { ownerCheckpoint: approvedCp }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "stale-stored-digest", description: "the content changed while the stored digest did not: recomputation refuses the approval (2c for the dependent)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: { ...approvedCp, question: "Proceed differently?" } }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", approvedCp, "approved")] })] },
  { name: "resolution-generation-mismatch", description: "a resolution from an earlier generation does not approve", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ generation: 3, resolved: { generation: 2 } }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "acceptance-without-artifact", description: "an acceptance needs the reviewed artifact", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ kind: "acceptance", resolved: {} }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "acceptance-with-artifact", description: "an acceptance with its artifact approves", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ kind: "acceptance", resolved: { artifactRef: "demo.md@abc" } }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "retired", description: "a retired checkpoint releases with its status open; completion after retirement is clear (2b)", tickets: [ticket("T-001", { ownerCheckpoint: retiredCp }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", retiredCp, "retired")] })] },
  { name: "approved-evidence-on-retired", description: "evidence state approved against a retired checkpoint flags (2c)", tickets: [ticket("T-001", { ownerCheckpoint: retiredCp }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", retiredCp, "approved")] })] },
  { name: "retired-evidence-on-approved", description: "evidence state retired against an approved checkpoint flags (2c)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: approvedCp }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", approvedCp, "retired")] })] },
  { name: "approved-generation-mismatch", description: "a reopen and reapproval with unchanged content moves the generation: old approved evidence flags (2c)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: reapprovedCp }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", reapprovedCp, "approved", 2)] })] },
  { name: "legacy-approved", description: "legacy completion, no evidence, history only created and resolved, checkpoint approved: clear (3b)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: approvedCp }), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "legacy-reopened", description: "legacy completion whose checkpoint was reopened and reapproved: flags (3a)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: reapprovedCp }), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "legacy-retirement", description: "legacy completion, checkpoint retired: retirement is a release, clear (3b)", tickets: [ticket("T-001", { ownerCheckpoint: retiredCp }), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "legacy-pending", description: "legacy completion, checkpoint still pending: flags (3c)", tickets: [ticket("T-001", { ownerCheckpoint: checkpoint({ resolved: null, generation: 1, events: ["created"] }) }), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "legacy-approved-side-conflict", description: "an approved-side conflict leaves the checkpoint pending: legacy dependents flag (3c)", tickets: [ticket("T-001", { ownerCheckpoint: checkpoint({ resolved: null, generation: 3, events: ["created", "resolved", "conflict-resolved"] }) }), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "legacy-retired-side-conflict", description: "retirement adopted by a conflict: every event is release-preserving, clear (3b)", tickets: [ticket("T-001", { ownerCheckpoint: checkpoint({ lifecycle: "retired", generation: 4, events: ["created", "retired", "conflict-resolved", "retirement-adopted"] }) }), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "retirement-adopted", description: "retire at 4, conflict to 5: evidence at 5 is clear (2b); evidence at 4, completed before the conflict, flags (2c)", tickets: [ticket("T-001", { ownerCheckpoint: adoptedCp }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", adoptedCp, "retired")] }), ticket("T-003", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", adoptedCp, "retired", 4)] })] },
  { name: "unknown-kind", description: "an unrecognized checkpoint blocks and never releases (1)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: { ...approvedCp, kind: "vote" } }), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "null-checkpoint", description: "JSON null is present, not absent: unrecognized, blocks (1)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: null }), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "soft-deleted-checkpoint", description: "a soft-deleted checkpoint never releases (1)", tickets: [ticket("T-001", { ...done, lifecycle: "deleted", ownerCheckpoint: approvedCp }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: [evidence("T-001", approvedCp, "approved")] })] },
  { name: "missing-checkpoint", description: "evidence naming a checkpoint that no longer exists flags (1)", tickets: [ticket("T-002", { ...done, checkpointEvidence: [evidence("T-009", approvedCp, "approved")] })] },
  { name: "malformed-evidence", description: "malformed evidence flags every checkpoint blocker (2c)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: approvedCp }), ticket("T-002", { ...done, blockedBy: ["T-001"], checkpointEvidence: "approved" })] },
  { name: "open-dependent", description: "a dependent that is not complete is never reassessed", tickets: [ticket("T-001", { ownerCheckpoint: reapprovedCp }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "ordinary-blocker", description: "a blocker without a checkpoint is not a checkpoint blocker", tickets: [ticket("T-001", {}), ticket("T-002", { ...done, blockedBy: ["T-001"] })] },
  { name: "resolution-revision-mismatch", description: "a resolution for another revision does not approve", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ revision: 2, resolved: { revision: 1 } }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "resolution-digest-mismatch", description: "a resolution for another digest does not approve", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ resolved: { digest: "0".repeat(64) } }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "counter-at-limit", description: "generation and revision at 9007199254740991 (MAX_SAFE_INTEGER) are valid", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ revision: MAX_CHECKPOINT_COUNTER, generation: MAX_CHECKPOINT_COUNTER, resolved: {} }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "generation-above-limit", description: "a generation above MAX_SAFE_INTEGER is unrecognized", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ generation: MAX_CHECKPOINT_COUNTER + 1, resolved: {} }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "replacement-character", description: "U+FFFD in reviewed text is unrecognized in both languages (the app's decoder substitutes it for a lone surrogate)", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ question: "x\uFFFD", resolved: {} }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
  { name: "revision-above-limit", description: "a revision above MAX_SAFE_INTEGER is unrecognized", tickets: [ticket("T-001", { ...done, ownerCheckpoint: checkpoint({ revision: MAX_CHECKPOINT_COUNTER + 1, resolved: {} }) }), ticket("T-002", { blockedBy: ["T-001"] })] },
];

// --- build ---------------------------------------------------------------------------

const ROADMAP = RoadmapSchema.parse({ title: "vectors", date: "2026-09-27", phases: [], blockers: [] });
const CONFIG = ConfigSchema.parse({ version: 2, project: "vectors", type: "app", language: "ts", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } });

export function buildVectors() {
  const digests = DIGEST_SPECS.map((d) => ({ name: d.name, content: d.content, projection: canonicalJson(checkpointProjection(d.content)), digest: checkpointDigest(d.content) }));
  const scenarios = SCENARIO_SPECS.map((s) => {
    const tickets: Ticket[] = s.tickets.map((t) => TicketSchema.parse(t));
    const state = new ProjectState({ tickets, issues: [], notes: [], roadmap: ROADMAP, config: CONFIG, handoverFilenames: [] });
    const expect = tickets.map((t) => ({
      id: t.id,
      checkpointState: checkpointState(t),
      releases: checkpointState(t) === null ? null : checkpointReleases(t),
      pendingCheckpointBlockers: pendingCheckpointBlockers(state, t),
      reassessment: reassessCheckpoints(state, t),
    }));
    return { name: s.name, description: s.description, tickets: s.tickets, expect };
  });
  return { schemaVersion: 1, digests, scenarios };
}

export function serializeVectors(): string {
  return JSON.stringify(buildVectors(), null, 2) + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--stdout")) process.stdout.write(serializeVectors());
  else writeFileSync(VECTORS_OUT, serializeVectors());
}
