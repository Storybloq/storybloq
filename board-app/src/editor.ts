import { z } from "zod";
import { handleTicketUpdate, handleIssueUpdate } from "./canonical-writes.mjs";
import { CliValidationError } from "../../src/core/cli-validation-error.js";
import type {
  TicketUpdateInput,
  IssueUpdateInput,
} from "../../src/core/update-inputs.js";
import { hasClaimMaterial } from "../../src/core/claims.js";
import { hasOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import {
  isActiveLifecycle,
  type ProjectState,
} from "../../src/core/project-state.js";
import type { Ticket } from "../../src/models/ticket.js";
import type { Issue } from "../../src/models/issue.js";
import { BoardError, readLedger } from "./ledger-reader.js";
import type { RootAccess } from "./federation.js";
import { selector } from "./history.js";
import { clip } from "./text.js";
import type { ItemEditor, ItemKind, EditableValue } from "./editor-types.js";
import {
  EditError,
  createRootCheck,
  recordRevision as itemRevision,
  validateEditSize,
} from "./edit-policy.js";
export { EditError, recordRevision as itemRevision } from "./edit-policy.js";

const phase = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const title = z.string().min(1).max(2000),
  body = z.string().max(48000);
const localRefs = z.array(z.string().min(1).max(80)).max(200);
export const ticketPatch = z
  .object({
    title: title.optional(),
    description: body.optional(),
    type: z.enum(["task", "feature", "chore"]).optional(),
    status: z.enum(["open", "inprogress", "complete"]).optional(),
    phase: phase.optional(),
    blockedBy: localRefs.optional(),
    crossNodeBlockedBy: z
      .array(z.string().min(1).max(256))
      .max(200)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const issuePatch = z
  .object({
    title: title.optional(),
    impact: body.optional(),
    resolution: body.nullable().optional(),
    severity: z.enum(["critical", "high", "medium", "low"]).optional(),
    status: z.enum(["open", "inprogress", "resolved"]).optional(),
    phase: phase.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);

function find(state: ProjectState, kind: ItemKind, id: string) {
  const item = kind === "tickets" ? state.ticketByID(id) : state.issueByID(id);
  if (!item || !isActiveLifecycle(item))
    throw new EditError(
      "unavailable",
      "This item is no longer available. Refresh the board.",
    );
  return item;
}
function reopenable(item: Ticket | Issue) {
  const t = item as Ticket;
  return (
    t.status === "complete" &&
    isActiveLifecycle(t) &&
    !hasOwnerCheckpoint(t) &&
    !hasClaimMaterial(t) &&
    t.claim == null &&
    t.claimedBySession == null
  );
}
function projectEditor(
  state: ProjectState,
  kind: ItemKind,
  item: Ticket | Issue,
): ItemEditor {
  const ticket = item as Ticket,
    issue = item as Issue;
  const selectedPhase = state.roadmap.phases.find((p) => p.id === item.phase);
  const fields: Record<string, EditableValue> =
    kind === "tickets"
      ? {
          title: ticket.title,
          description: ticket.description,
          type: ticket.type,
          status: ticket.status,
          phase: selectedPhase ? selector(selectedPhase.id) : null,
          blockedBy: ticket.blockedBy,
          crossNodeBlockedBy: ticket.crossNodeBlockedBy ?? [],
        }
      : {
          title: issue.title,
          impact: issue.impact,
          resolution: issue.resolution,
          severity: issue.severity,
          status: issue.status,
          phase: selectedPhase ? selector(selectedPhase.id) : null,
        };
  const limitedFields: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const limit = key === "title" ? 2000 : 48000;
    if (typeof value === "string" && value.length > limit) {
      fields[key] = clip(value, limit - 1);
      limitedFields.push(key);
    } else if (
      Array.isArray(value) &&
      (value.length > 200 ||
        value.some((v) => v.length > (key === "crossNodeBlockedBy" ? 256 : 80)))
    ) {
      fields[key] = value
        .slice(0, 200)
        .map((v) => clip(v, key === "crossNodeBlockedBy" ? 256 : 80));
      limitedFields.push(key);
    }
  }
  if (item.phase !== null && !selectedPhase) limitedFields.push("phase");
  return {
    kind,
    id: item.id,
    displayId: clip(item.displayId ?? item.id, 80),
    revision: itemRevision(item),
    fields,
    limitedFields,
    phases: state.roadmap.phases.map((p) => ({
      key: selector(p.id),
      name: clip(p.name, 240),
    })),
    canReopen: kind === "tickets" && reopenable(item),
  };
}

export function createEditor(root: string, access: Promise<RootAccess>) {
  const checkRoot = createRootCheck(root, access);
  async function read(kind: ItemKind, id: string) {
    await checkRoot();
    const result = await readLedger(root, (state) =>
      projectEditor(state, kind, find(state, kind, id)),
    );
    await checkRoot();
    return result;
  }
  async function mutate(
    kind: ItemKind,
    id: string,
    revision: string,
    patch: unknown,
    reopen = false,
  ) {
    await checkRoot();
    const parsed = (kind === "tickets" ? ticketPatch : issuePatch).safeParse(
      patch,
    );
    if (!parsed.success)
      throw new EditError(
        "invalid_input",
        "Check the editable fields and their limits, then try again.",
      );
    // Preflight is nonmutating. Repeat the safe read while the canonical lock is held.
    await read(kind, id);
    const updates: TicketUpdateInput & IssueUpdateInput = { ...parsed.data };
    let savedState: ProjectState | undefined,
      originalBytes = 0,
      totalBytes = 0;
    const hooks = {
      precondition: async (existing: Ticket | Issue, state: ProjectState) => {
        await checkRoot();
        await readLedger(root, (fresh, scope) => {
          const current = find(fresh, kind, id);
          if (
            itemRevision(existing) !== revision ||
            itemRevision(current) !== revision
          )
            throw new EditError(
              "conflict",
              "This item changed. Your draft is preserved. Reload to compare the current values.",
            );
          if (kind === "tickets" && hasOwnerCheckpoint(current))
            throw new EditError(
              "invalid_input",
              "Owner checkpoints must be changed through their decision workflow.",
            );
          if (reopen && !reopenable(current))
            throw new EditError(
              "invalid_input",
              "Only completed, unclaimed ordinary tickets can be reopened here.",
            );
          if (updates.phase !== undefined && updates.phase !== null) {
            const match = state.roadmap.phases.find(
              (p) => selector(p.id) === updates.phase,
            );
            if (!match)
              throw new EditError(
                "conflict",
                "The selected phase changed. Reload before saving.",
              );
            updates.phase = match.id;
          }
          originalBytes = scope.fileBytes(kind, id + ".json");
          totalBytes = scope.totalBytes();
          savedState = state;
        });
      },
      validatePreparedContent: async (content: string) => {
        await checkRoot();
        validateEditSize(content, originalBytes, totalBytes);
      },
    };
    try {
      const result =
        kind === "tickets"
          ? await handleTicketUpdate(id, updates, "json", root, reopen, hooks)
          : await handleIssueUpdate(id, updates, "json", root, hooks);
      const item = JSON.parse(result.output).data as Ticket | Issue;
      if (!savedState) throw new Error("Missing saved state");
      return projectEditor(savedState, kind, item);
    } catch (error) {
      if (error instanceof EditError || error instanceof BoardError)
        throw error;
      if (error instanceof CliValidationError)
        throw new EditError(
          error.code === "conflict" ? "conflict" : "invalid_input",
          "Storybloq refused this edit. Check dependencies, status, ownership and field values. Your draft is preserved.",
        );
      throw new EditError(
        "unavailable",
        "The save could not be confirmed. Your draft is preserved. Reload before retrying.",
      );
    }
  }
  return {
    read,
    save: (kind: ItemKind, id: string, revision: string, patch: unknown) =>
      mutate(kind, id, revision, patch),
    reopen: (id: string, revision: string) =>
      mutate("tickets", id, revision, { status: "open" }, true),
  };
}
