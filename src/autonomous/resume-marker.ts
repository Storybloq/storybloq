import { displayIdOf } from "../core/resolver.js";
/**
 * T-183: Resume marker file for 100% compaction survival.
 *
 * Writes a `.claude/rules/autonomous-resume.md` marker that Claude Code reads
 * automatically on every turn. This is a redundant safety net -- the existing
 * SessionStart hook chain stays as-is.
 *
 * Path assumption: `root` from discoverProjectRoot() is the git/project root
 * where Claude Code reads `.claude/rules/`. This holds for standalone repos
 * and worktrees (each worktree has its own `.claude/`).
 */
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MARKER_FILENAME = "autonomous-resume.md";

/** Strip newlines, collapse whitespace, and limit length to prevent prompt injection via .claude/rules/ marker. */
function sanitize(input: string, maxLen = 120): string {
  return input.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

export function writeResumeMarker(root: string, sessionId: string, state: {
  ticket?: { id: string; displayId?: string; title: string } | null;
  completedTickets: { id: string }[];
  resolvedIssues?: string[];
  preCompactState?: string | null;
}): void {
  try {
    const rulesDir = join(root, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });

    const ticketInfo = state.ticket
      ? `Working on: ${sanitize(displayIdOf(state.ticket), 20)} (${sanitize(state.ticket.title)})`
      : "Between tickets";
    const progress = `Progress: ${state.completedTickets.length} tickets completed, ${(state.resolvedIssues ?? []).length} issues resolved`;

    const lines = [
      "CRITICAL: An autonomous coding session is active and waiting to resume.",
      "",
      `Session: ${sessionId}`,
      ticketInfo,
      progress,
    ];
    if (state.preCompactState) {
      lines.push(`State before compaction: ${state.preCompactState}`);
    }
    lines.push(
      "",
      "You MUST run `/story` before any other work.",
      "Its active-session guard will verify task ownership and resume this session only when safe.",
      "",
      "Do NOT do any other work until you have run `/story`.",
      "Do NOT manually create tickets, issues, or handovers.",
      "The guide manages your workflow.",
    );
    const content = lines.join("\n") + "\n";

    writeFileSync(join(rulesDir, MARKER_FILENAME), content, "utf-8");
  } catch {
    // Best-effort -- marker is redundancy, not primary mechanism
  }
}

/** What the identity-scoped form decided. The one-argument form returns nothing. */
export type ResumeMarkerRemoval =
  | "removed"
  | "absent"
  | "preserved-foreign"
  | "preserved-unstructured";

/**
 * The session a marker names, or null when it names none.
 *
 * `writeResumeMarker` already emits `Session: <id>` on its own line, so identity
 * is available without a format change and without migrating existing markers.
 */
function markerSessionId(content: string): { kind: "none" } | { kind: "one"; id: string } | { kind: "ambiguous" } {
  const found: string[] = [];
  for (const line of content.split("\n")) {
    const match = /^Session:\s*(\S+)\s*$/.exec(line);
    if (match) found.push(match[1] as string);
  }
  if (found.length === 0) return { kind: "none" };
  // MORE THAN ONE identity line is ambiguous, and taking the first would be a
  // fail-OPEN read: a marker naming both this session and a foreign one would
  // be classified as ours and deleted, which is exactly the outcome the foreign
  // rule exists to prevent. Identical repeats are still one identity.
  const distinct = new Set(found);
  if (distinct.size > 1) return { kind: "ambiguous" };
  return { kind: "one", id: found[0] as string };
}

/**
 * Remove the resume marker.
 *
 * WITHOUT `context`, this is the shipped delete-by-path behavior, unchanged.
 *
 * WITH `context`, removal is identity-scoped, and the two passes differ on
 * exactly one case.
 *
 * A marker naming a DIFFERENT session is preserved on both passes: deleting it
 * would strip a live instruction from a session that still needs it.
 *
 * An UNSTRUCTURED marker (no `Session:` line) is deleted on the first pass and
 * preserved during recovery. The asymmetry is deliberate, and it describes the
 * CALLING CONTRACT that T-450 step 6a commit B2 will honor: B2 invokes the
 * first-pass form while holding the session lock, completing a cancellation it
 * has just published, which is the shipped behavior the step 5 fixture pins.
 * At recovery time, possibly much later, nothing proves whose marker it is, and
 * declaring the cancellation complete over it would leave a standing
 * instruction to resume a session that is durably finished.
 *
 * No contextual caller exists until B2; the one-argument form is what ships
 * today.
 */
export function removeResumeMarker(root: string): void;
export function removeResumeMarker(
  root: string,
  context: { readonly sessionId: string; readonly mode: "first-pass" | "recovery" },
): ResumeMarkerRemoval;
export function removeResumeMarker(
  root: string,
  context?: { readonly sessionId: string; readonly mode: "first-pass" | "recovery" },
): ResumeMarkerRemoval | void {
  const markerPath = join(root, ".claude", "rules", MARKER_FILENAME);

  if (!context) {
    try {
      if (existsSync(markerPath)) unlinkSync(markerPath);
    } catch {
      // Best-effort
    }
    return;
  }

  try {
    let content: string;
    try {
      content = readFileSync(markerPath, "utf-8");
    } catch (err) {
      // Absence is the ordinary, satisfied outcome. Any other read failure
      // leaves a file we could not classify, so it is preserved rather than
      // deleted on an assumption.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      return "preserved-unstructured";
    }

    const named = markerSessionId(content);
    if (named.kind === "ambiguous") return "preserved-foreign";
    if (named.kind === "none") {
      if (context.mode === "first-pass") {
        unlinkSync(markerPath);
        return "removed";
      }
      return "preserved-unstructured";
    }
    if (named.id !== context.sessionId) return "preserved-foreign";

    unlinkSync(markerPath);
    return "removed";
  } catch {
    // Best-effort: an unlink that failed leaves the marker in place, which is
    // the safe direction.
    return "preserved-unstructured";
  }
}
