/**
 * T-538 S3a-2: the write-layer guard for establishment tickets.
 * `prepareTicketWrite` (project-loader.ts) calls
 * `assertVerificationWriteAllowed` after the checkpoint guard, with the
 * ticket as it is on disk and as it is about to be written, so every writer
 * through the ordinary choke point is covered.
 *
 * An establishment ticket's `setup` field (its key, what it establishes, its
 * verification spec and what setup-verify recorded) and its completion are
 * written only under an authority, and so is leaving complete. Authority is an in-process symbol, never
 * persisted and never crossing MCP, and each may be imported only by the
 * module that owns it (pinned by test/core/checkpoint-lifecycle.test.ts):
 *  - ESTABLISHMENT_CREATION_AUTHORITY: core/setup-apply.ts, for exactly two
 *    writes: creating the ticket with `establishes` and `verification.spec`
 *    and nothing else recorded, and a duplicate-key settlement that adds
 *    `supersededBy` and keeps every other field;
 *  - VERIFICATION_RESULT_AUTHORITY: core/setup-verify.ts, for the result,
 *    the owner's decision, reopenings, the completion and the reopen; never
 *    a change to the key, `establishes` or the spec.
 * Writes that touch none of this pass as they always have; a writer outside
 * the choke point (the Mac app, a hand edit) is read by setup-verify as it
 * finds it.
 */
import { ProjectLoaderError } from "./errors.js";
import { sameValue } from "./checkpoint-guard.js";
import { parseSetupMeta } from "./setup-meta.js";

export const ESTABLISHMENT_CREATION_AUTHORITY: unique symbol = Symbol("setup-establishment-creation");
export const VERIFICATION_RESULT_AUTHORITY: unique symbol = Symbol("setup-verification-result");

export type VerificationWriteAuthority = typeof ESTABLISHMENT_CREATION_AUTHORITY | typeof VERIFICATION_RESULT_AUTHORITY;

type Raw = Readonly<Record<string, unknown>>;

const present = (v: unknown): boolean => v !== undefined && v !== null;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const setupOf = (t: Raw | null): Raw | undefined => (t !== null && isObject(t.setup) ? t.setup : undefined);
const verificationOf = (s: Raw | undefined): Raw | undefined => (s !== undefined && isObject(s.verification) ? s.verification : undefined);

/** Whether a ticket carries establishment metadata. */
export function isEstablishment(t: Raw | null): boolean {
  const s = setupOf(t);
  return s !== undefined && (present(s.establishes) || present(s.verification));
}

function label(t: Raw): string {
  return typeof t.displayId === "string" ? t.displayId : String(t.id);
}

/** The ticket without what a settlement may change: the key's supersededBy, and the touch date. */
function settlementBase(t: Raw): unknown {
  const { updatedDate: _u, setup, ...rest } = t;
  if (!isObject(setup)) return rest;
  const { supersededBy: _s, ...kept } = setup;
  return { ...rest, setup: kept };
}

/** The setup field without what setup-verify records. */
function fixedPart(s: Raw | undefined): unknown {
  if (s === undefined) return undefined;
  const v = verificationOf(s);
  return { ...s, verification: v === undefined ? undefined : { spec: v.spec } };
}

/**
 * Refuses a write to an establishment ticket's setup field or completion
 * that the caller's authority does not cover. `prior` is the ticket on disk
 * (null when the write creates it).
 */
export function assertVerificationWriteAllowed(prior: Raw | null, next: Raw, authority?: VerificationWriteAuthority): void {
  if (!isEstablishment(prior) && !isEstablishment(next)) return;
  const priorSetup = setupOf(prior);
  const nextSetup = setupOf(next);
  const setupChanged = !sameValue(priorSetup, nextSetup);
  const completes = next.status === "complete" && prior?.status !== "complete";
  // Leaving complete is as much the verification's business as entering it:
  // a verified, left-off or closed-without-result ticket reopens only through
  // setup-verify --reopen, which runs the recovery checks.
  const reopens = prior?.status === "complete" && next.status !== "complete";
  if (!setupChanged && !completes && !reopens) return;

  let allowed = false;
  if (authority === ESTABLISHMENT_CREATION_AUTHORITY) {
    const v = verificationOf(nextSetup);
    const created = prior === null && nextSetup !== undefined && present(nextSetup.establishes)
      && v !== undefined && present(v.spec) && Object.keys(v).every((k) => k === "spec") && next.status !== "complete";
    const settled = prior !== null && nextSetup !== undefined && present(nextSetup.supersededBy)
      && sameValue(settlementBase(prior), settlementBase(next));
    allowed = created || settled;
  } else if (authority === VERIFICATION_RESULT_AUTHORITY) {
    allowed = prior !== null && isEstablishment(prior) && sameValue(fixedPart(priorSetup), fixedPart(nextSetup));
  }
  if (allowed) {
    // An authorised write still writes metadata that parses.
    const meta = parseSetupMeta("ticket", next);
    if (meta.kind === "item") return;
    throw new ProjectLoaderError("invalid_input", `${label(next)}: its setup field ${meta.kind === "invalid" ? meta.reason : "is missing"}.`);
  }
  throw new ProjectLoaderError(
    "conflict",
    `${label(next)} is an establishment ticket: its setup field, its completion and its reopening are written only by storybloq setup-verify --ticket ${label(next)}.`,
  );
}
