import type { ProjectState } from "./project-state.js";

export type RefDir = "tickets" | "issues" | "notes" | "lessons";

/** The file each loaded record came from. Kept beside the record so a write never persists it. */
const sourceFiles = new WeakMap<object, string>();

export function noteRecordSourceFile(record: object, file: string): void {
  sourceFiles.set(record, file);
}

/**
 * ISS-1418: the message for a ref that matches more than one record. Distinct ids keep the list. Records that share
 * one id are a duplicate (ISS-1404), where the list would repeat that id, so the message names the claiming files and
 * the recovery, in the loader's own duplicate_id words. Distinct ids name each record's file when the loader read it.
 */
export function ambiguousRefMessage(
  state: Pick<ProjectState, "duplicateMessageOf">,
  dir: RefDir,
  ref: string,
  matches: readonly { readonly id: string }[],
): string {
  const ids = matches.map((m) => m.id);
  const id = ids[0];
  if (id === undefined || ids.some((x) => x !== id)) {
    const named = matches.map((m) => {
      const file = sourceFiles.get(m);
      return file === undefined ? m.id : `${m.id} in ${file}`;
    });
    return `Ref "${ref}" is ambiguous (matches: ${named.join(", ")})`;
  }
  const duplicate = state.duplicateMessageOf(dir, id);
  return `Ref "${ref}" is ambiguous: its ${ids.length} records share one id, ${id}. ` +
    (duplicate ?? "Run `storybloq validate` to list the files that claim it.");
}

export class RefResolutionError extends Error {
  constructor(
    public readonly reason: "missing" | "ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "RefResolutionError";
  }
}

export function resolveAndNormalizeTicketRef(
  state: ProjectState,
  ref: string,
): string {
  const result = state.resolveTicketRef(ref);
  if (result.kind === "found") {
    if (result.matchedBy === "previousDisplayId") {
      const currentDisplay = (result.item as Record<string, unknown>).displayId as string | undefined ?? result.item.id;
      process.stderr.write(`storybloq: ref "${ref}" resolved via previousDisplayId to ${currentDisplay}. Consider updating the reference.\n`);
    }
    return result.item.id;
  }
  if (result.kind === "ambiguous") {
    throw new RefResolutionError("ambiguous", ambiguousRefMessage(state, "tickets", ref, result.matches));
  }
  throw new RefResolutionError("missing", `Ref "${ref}" not found`);
}

export function resolveAndNormalizeTicketRefs(
  state: ProjectState,
  refs: string[],
): string[] {
  if (refs.length === 0) return [];
  const resolved: string[] = [];
  for (const ref of refs) {
    resolved.push(resolveAndNormalizeTicketRef(state, ref));
  }
  return resolved;
}

export function resolveAndNormalizeIssueRef(
  state: ProjectState,
  ref: string,
): string {
  const result = state.resolveIssueRef(ref);
  if (result.kind === "found") {
    if (result.matchedBy === "previousDisplayId") {
      const currentDisplay = (result.item as Record<string, unknown>).displayId as string | undefined ?? result.item.id;
      process.stderr.write(`storybloq: ref "${ref}" resolved via previousDisplayId to ${currentDisplay}. Consider updating the reference.\n`);
    }
    return result.item.id;
  }
  if (result.kind === "ambiguous") {
    throw new RefResolutionError("ambiguous", ambiguousRefMessage(state, "issues", ref, result.matches));
  }
  throw new RefResolutionError("missing", `Ref "${ref}" not found`);
}

export function resolveAndNormalizeNoteRef(
  state: ProjectState,
  ref: string,
): string {
  const result = state.resolveNoteRef(ref);
  if (result.kind === "found") {
    if (result.matchedBy === "previousDisplayId") {
      const currentDisplay = (result.item as Record<string, unknown>).displayId as string | undefined ?? result.item.id;
      process.stderr.write(`storybloq: ref "${ref}" resolved via previousDisplayId to ${currentDisplay}. Consider updating the reference.\n`);
    }
    return result.item.id;
  }
  if (result.kind === "ambiguous") {
    throw new RefResolutionError("ambiguous", ambiguousRefMessage(state, "notes", ref, result.matches));
  }
  throw new RefResolutionError("missing", `Ref "${ref}" not found`);
}

export function resolveAndNormalizeLessonRef(
  state: ProjectState,
  ref: string,
): string {
  const result = state.resolveLessonRef(ref);
  if (result.kind === "found") {
    if (result.matchedBy === "previousDisplayId") {
      const currentDisplay = (result.item as Record<string, unknown>).displayId as string | undefined ?? result.item.id;
      process.stderr.write(`storybloq: ref "${ref}" resolved via previousDisplayId to ${currentDisplay}. Consider updating the reference.\n`);
    }
    return result.item.id;
  }
  if (result.kind === "ambiguous") {
    throw new RefResolutionError("ambiguous", ambiguousRefMessage(state, "lessons", ref, result.matches));
  }
  throw new RefResolutionError("missing", `Ref "${ref}" not found`);
}
