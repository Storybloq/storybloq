/**
 * C-v4.1 commit 6, ISS-1433 (4) with pen ruling Q2 and the commit 6 gate:
 * the opt-in completion check. With `gitState.requireCommitOnComplete: true`,
 * completing a ticket refuses while no commit names it (gitState `none`) and
 * while git cannot say (`unknown`: absence is not proven, so it fails closed
 * with the reason). It never refuses at built, landed or released. Items on
 * `proof.nonCodeItems` are exempt. Tickets only: issue resolve is unchanged.
 *
 * Every writer that sets a ticket complete asks `completionGate` with its
 * own name; no path decides for itself.
 */
import { canonicalRef, readBoardId } from "./board-id.js";
import { readGitFacts } from "./git-facts/facts.js";
import type { ProjectState } from "./project-state.js";
import { nonCodeRefs } from "./proof.js";

export const COMPLETION_CHECK_KEY = "gitState.requireCommitOnComplete";

/** Every writer that sets a ticket's status to complete. */
export type CompletingWriter = "ticket-update" | "guide" | "checkpoint-resolve" | "setup-verify" | "setup-apply-import";

/** Exempt writers, by construction, with the reason; a writer absent here is checked. */
const EXEMPT: Partial<Record<CompletingWriter, string>> = {
  "checkpoint-resolve": "a checkpoint ticket records a decision, not code",
  "setup-verify": "a setup ticket checks setup, not a commit",
  "setup-apply-import": "history imported at setup time",
};

const ESCAPE: Record<"ticket-update" | "guide", (displayId: string) => string> = {
  "ticket-update": () => `Pass --no-git-check (MCP noGitCheck) to complete it anyway, or turn off ${COMPLETION_CHECK_KEY}.`,
  guide: (displayId) => `The session did not complete it. Complete it by hand with \`storybloq ticket update ${displayId} --status complete --no-git-check\`, or turn off ${COMPLETION_CHECK_KEY}, then retry the same call.`,
};

export type CompletionGate =
  | { readonly kind: "exempt"; readonly reason: string }
  | { readonly kind: "check"; readonly refusal: (root: string, state: ProjectState, ticketId: string, displayId: string) => Promise<string | null> };

/** The one decision every completing writer asks. */
export function completionGate(writer: CompletingWriter): CompletionGate {
  const reason = EXEMPT[writer];
  if (reason !== undefined) return { kind: "exempt", reason };
  const escape = ESCAPE[writer as "ticket-update" | "guide"];
  return { kind: "check", refusal: (root, state, ticketId, displayId) => refusalFor(root, state, ticketId, displayId, escape(displayId)) };
}

/** Only a literal `true` turns the check on. */
export function completionCheckEnabled(config: unknown): boolean {
  return (config as { gitState?: { requireCommitOnComplete?: unknown } } | undefined)?.gitState?.requireCommitOnComplete === true;
}

async function refusalFor(root: string, state: ProjectState, ticketId: string, displayId: string, escape: string): Promise<string | null> {
  const config = (state as unknown as { config?: unknown }).config;
  if (!completionCheckEnabled(config)) return null;
  const board = readBoardId(root);
  if (board !== undefined && nonCodeRefs(config).has(canonicalRef(board, ticketId))) return null;
  const s = (await readGitFacts(root, state)).stateOf(ticketId);
  if (s.state === "none") return `git_check: no commit names ${displayId} (gitState none), and ${COMPLETION_CHECK_KEY} is on. ${escape}`;
  if (s.state === "unknown") return `git_check: git cannot say whether a commit names ${displayId} (gitState unknown: ${s.reason}${s.detail !== undefined ? `, ${s.detail}` : ""}), and ${COMPLETION_CHECK_KEY} is on. ${escape}`;
  return null;
}

/** ticket update's check (CLI and MCP). */
export async function completionCheckRefusal(root: string, state: ProjectState, ticketId: string, displayId: string): Promise<string | null> {
  const gate = completionGate("ticket-update");
  return gate.kind === "check" ? gate.refusal(root, state, ticketId, displayId) : null;
}

/** For a writer the gate exempts by construction: asks the gate, and fails loudly if the gate ever stops exempting it. */
export function exemptCompletion(writer: "checkpoint-resolve" | "setup-verify" | "setup-apply-import"): string {
  const gate = completionGate(writer);
  if (gate.kind !== "exempt") throw new Error(`internal: ${writer} completes tickets without the completion check, but the gate no longer exempts it`);
  return gate.reason;
}
