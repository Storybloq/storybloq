import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { CommandContext, CommandResult } from "../run.js";
import { validateProject } from "../../core/validation.js";
import { INTEGRITY_WARNING_TYPES, type LoadWarning } from "../../core/errors.js";
import type { ProjectState } from "../../core/project-state.js";
import { serializeJSON, runTransactionUnlocked } from "../../core/project-loader.js";
import { assertCheckpointWriteAllowed } from "../../core/checkpoint-guard.js";
import { CANONICAL_ID_REGEX } from "../../core/canonical-id.js";
import { TICKET_ID_REGEX, ISSUE_ID_REGEX } from "../../models/types.js";

interface RepairFix {
  entity: string;
  field: string;
  description: string;
}

/**
 * ISS-738: repair writes are MINIMAL PATCHES against the raw on-disk JSON,
 * never re-serializations of loader-hydrated entities (which absorb derived
 * fields like displayId and defaulted completedDate into every touched file).
 * `set` holds only the fields repair actually changed, as plain JSON values;
 * `unset` holds keys to delete (the ISS-652 stale-claim strip).
 */
export interface RepairPatch {
  id: string;
  type: "ticket" | "issue";
  set: Record<string, unknown>;
  unset: string[];
}

export interface RepairResult {
  fixes: RepairFix[];
  error?: string;
  patches: RepairPatch[];
}

/**
 * Compute repairs needed for stale references.
 * Returns the list of fixes and the modified entities ready to write.
 */
export interface RepairOptions {
  canonicalizeRefs?: boolean;
}

export function computeRepairs(
  state: ProjectState,
  warnings: readonly LoadWarning[],
  options?: RepairOptions,
): RepairResult {
  // Refuse when load has integrity warnings (partial load could cause false positives)
  const integrityWarning = warnings.find((w) =>
    (INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type),
  );
  if (integrityWarning) {
    return {
      fixes: [],
      error: `Cannot repair: data integrity issue in ${integrityWarning.file}: ${integrityWarning.message}. Fix the corrupt file first, then retry.`,
      patches: [],
    };
  }

  const fixes: RepairFix[] = [];
  const patches: RepairPatch[] = [];

  const ticketIDs = new Set(state.tickets.map((t) => t.id));
  const allTicketRefs = new Set<string>();
  for (const t of state.tickets) {
    allTicketRefs.add(t.id);
    const did = (t as Record<string, unknown>).displayId as string | undefined;
    if (did) allTicketRefs.add(did);
    for (const prev of ((t as Record<string, unknown>).previousDisplayIds as string[] | undefined) ?? []) {
      allTicketRefs.add(prev);
    }
  }
  const phaseIDs = new Set(state.roadmap.phases.map((p) => {
    const id = p.id;
    return typeof id === "object" && id !== null ? (id as { rawValue?: string }).rawValue ?? String(id) : String(id);
  }));

  function resolveTicketRef(ref: string): { resolved: string; kind: "found" | "missing" | "ambiguous" } {
    const result = state.resolveTicketRef(ref);
    if (result.kind === "found") return { resolved: result.item.id, kind: "found" };
    if (result.kind === "ambiguous") return { resolved: ref, kind: "ambiguous" };
    return { resolved: ref, kind: "missing" };
  }

  for (const ticket of state.tickets) {
    let blockedByChanged = false;
    let parentChanged = false;
    let phaseCleared = false;
    let blockedBy = [...ticket.blockedBy];
    let parentTicket = ticket.parentTicket;
    const phase = ticket.phase;

    const newBlockedBy: string[] = [];
    for (const ref of blockedBy) {
      if (options?.canonicalizeRefs) {
        const { resolved, kind } = resolveTicketRef(ref);
        if (kind === "found") {
          if (resolved !== ref) {
            fixes.push({ entity: ticket.id, field: "blockedBy", description: `Canonicalized: ${ref} -> ${resolved}` });
            blockedByChanged = true;
          }
          newBlockedBy.push(resolved);
        } else if (kind === "missing") {
          fixes.push({ entity: ticket.id, field: "blockedBy", description: `Removed stale ref: ${ref}` });
          blockedByChanged = true;
        } else {
          newBlockedBy.push(ref);
        }
      } else if (!allTicketRefs.has(ref)) {
        fixes.push({ entity: ticket.id, field: "blockedBy", description: `Removed stale ref: ${ref}` });
        blockedByChanged = true;
      } else {
        newBlockedBy.push(ref);
      }
    }
    blockedBy = newBlockedBy;

    if (parentTicket) {
      if (options?.canonicalizeRefs) {
        const { resolved, kind } = resolveTicketRef(parentTicket);
        if (kind === "found" && resolved !== parentTicket) {
          fixes.push({ entity: ticket.id, field: "parentTicket", description: `Canonicalized: ${parentTicket} -> ${resolved}` });
          parentTicket = resolved;
          parentChanged = true;
        } else if (kind === "missing") {
          fixes.push({ entity: ticket.id, field: "parentTicket", description: `Cleared stale ref: ${parentTicket}` });
          parentTicket = null;
          parentChanged = true;
        }
      } else if (!allTicketRefs.has(parentTicket)) {
        fixes.push({ entity: ticket.id, field: "parentTicket", description: `Cleared stale ref: ${parentTicket}` });
        parentTicket = null;
        parentChanged = true;
      }
    }

    const phaseRaw = typeof phase === "object" && phase !== null
      ? (phase as { rawValue?: string }).rawValue ?? String(phase)
      : phase != null ? String(phase) : null;
    if (phaseRaw && !phaseIDs.has(phaseRaw)) {
      fixes.push({ entity: ticket.id, field: "phase", description: `Cleared stale phase: ${phaseRaw}` });
      phaseCleared = true;
    }

    // ISS-652: completed tickets must not retain autonomous session claim state.
    // The CLI/MCP update path strips it on completion, but tickets completed by
    // direct edit (or before that cleanup existed) keep a stale claimedBySession
    // (or a residual claim). Strip both keys here -- covers explicit-null too,
    // since claimedBySession is nullable+optional and parse retains the key.
    const tRec = ticket as Record<string, unknown>;
    const staleClaimOnComplete = ticket.status === "complete"
      && (Object.prototype.hasOwnProperty.call(tRec, "claimedBySession") || ticket.claim != null);
    if (staleClaimOnComplete) {
      fixes.push({ entity: ticket.id, field: "claim", description: "Cleared stale claim state on completed ticket" });
    }

    if (blockedByChanged || parentChanged || phaseCleared || staleClaimOnComplete) {
      const set: Record<string, unknown> = {};
      if (blockedByChanged) set.blockedBy = blockedBy;
      if (parentChanged) set.parentTicket = parentTicket;
      if (phaseCleared) set.phase = null;
      const unset = staleClaimOnComplete ? ["claim", "claimedBySession"] : [];
      patches.push({ id: ticket.id, type: "ticket", set, unset });
    }
  }

  for (const issue of state.issues) {
    let relatedChanged = false;
    let phaseCleared = false;
    let relatedTickets = [...issue.relatedTickets];
    const phase = issue.phase;

    const newRelated: string[] = [];
    for (const ref of relatedTickets) {
      if (options?.canonicalizeRefs) {
        const { resolved, kind } = resolveTicketRef(ref);
        if (kind === "found") {
          if (resolved !== ref) {
            fixes.push({ entity: issue.id, field: "relatedTickets", description: `Canonicalized: ${ref} -> ${resolved}` });
            relatedChanged = true;
          }
          newRelated.push(resolved);
        } else if (kind === "missing") {
          fixes.push({ entity: issue.id, field: "relatedTickets", description: `Removed stale ref: ${ref}` });
          relatedChanged = true;
        } else {
          newRelated.push(ref);
        }
      } else if (!allTicketRefs.has(ref)) {
        fixes.push({ entity: issue.id, field: "relatedTickets", description: `Removed stale ref: ${ref}` });
        relatedChanged = true;
      } else {
        newRelated.push(ref);
      }
    }
    relatedTickets = newRelated;

    const issuePhaseRaw = typeof phase === "object" && phase !== null
      ? (phase as { rawValue?: string }).rawValue ?? String(phase)
      : phase != null ? String(phase) : null;
    if (issuePhaseRaw && !phaseIDs.has(issuePhaseRaw)) {
      fixes.push({ entity: issue.id, field: "phase", description: `Cleared stale phase: ${issuePhaseRaw}` });
      phaseCleared = true;
    }

    if (relatedChanged || phaseCleared) {
      const set: Record<string, unknown> = {};
      if (relatedChanged) set.relatedTickets = relatedTickets;
      if (phaseCleared) set.phase = null;
      patches.push({ id: issue.id, type: "issue", set, unset: [] });
    }
  }

  return { fixes, patches };
}

function isValidPatchId(patch: RepairPatch): boolean {
  if (patch.type === "ticket") {
    return TICKET_ID_REGEX.test(patch.id) || (CANONICAL_ID_REGEX.test(patch.id) && patch.id.startsWith("t-"));
  }
  return ISSUE_ID_REGEX.test(patch.id) || (CANONICAL_ID_REGEX.test(patch.id) && patch.id.startsWith("i-"));
}

/**
 * Applies repair patches to the raw on-disk JSON (ISS-738). Two-phase: every
 * target file is read, parsed, and patched in memory FIRST (any failure aborts
 * before a single write), then one transaction writes them all. The base
 * object is the on-disk one, so loader-derived fields are never injected. The
 * caller must hold the project lock.
 */
export async function applyRepairPatches(root: string, patches: RepairPatch[]): Promise<void> {
  interface Group { target: string; set: Record<string, unknown>; unset: Set<string> }
  const groups = new Map<string, Group>();
  for (const patch of patches) {
    if (!isValidPatchId(patch)) {
      throw new Error(`repair: refusing to write "${patch.id}": not a valid ${patch.type} id`);
    }
    const dir = patch.type === "ticket" ? "tickets" : "issues";
    const target = resolve(root, ".story", dir, `${patch.id}.json`);
    const group = groups.get(target) ?? { target, set: {}, unset: new Set<string>() };
    for (const [key, value] of Object.entries(patch.set)) {
      if (group.unset.has(key)) {
        throw new Error(`repair: conflicting patch operations for "${patch.id}.${key}" (set after unset)`);
      }
      if (Object.hasOwn(group.set, key) && JSON.stringify(group.set[key]) !== JSON.stringify(value)) {
        throw new Error(`repair: conflicting duplicate sets for "${patch.id}.${key}"`);
      }
      group.set[key] = value;
    }
    for (const key of patch.unset) {
      if (Object.hasOwn(group.set, key)) {
        throw new Error(`repair: conflicting patch operations for "${patch.id}.${key}" (unset after set)`);
      }
      group.unset.add(key);
    }
    groups.set(target, group);
  }

  const ops: Array<{ op: "write"; target: string; content: string }> = [];
  for (const group of groups.values()) {
    const raw = JSON.parse(await readFile(group.target, "utf-8")) as Record<string, unknown>;
    const prior = { ...raw };
    for (const [key, value] of Object.entries(group.set)) raw[key] = value;
    for (const key of group.unset) delete raw[key];
    // T-537: repair writes raw JSON, outside prepareTicketWrite, so it runs
    // the checkpoint guard itself. No repair touches a protected field today.
    if (group.target.includes(`${sep}tickets${sep}`)) assertCheckpointWriteAllowed(prior, raw);
    ops.push({ op: "write", target: group.target, content: serializeJSON(raw) });
  }
  await runTransactionUnlocked(root, ops);
}

export function handleRepair(ctx: CommandContext, dryRun: boolean): CommandResult {
  const { fixes, error } = computeRepairs(ctx.state, ctx.warnings);

  if (error) {
    return { output: error, errorCode: "project_corrupt" };
  }

  if (fixes.length === 0) {
    return { output: "No stale references found. Project is clean." };
  }

  const lines = [`Found ${fixes.length} stale reference(s)${dryRun ? " (dry run)" : ""}:`, ""];
  for (const fix of fixes) {
    lines.push(`- ${fix.entity}.${fix.field}: ${fix.description}`);
  }

  if (dryRun) {
    lines.push("", "Run without --dry-run to apply fixes.");
  }

  return { output: lines.join("\n") };
}
