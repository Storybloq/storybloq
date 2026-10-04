/**
 * T-486 2c: the one write boundary for issue resolution metadata.
 *
 * Every issue write passes through `prepareIssueWrite`, and ledger restore,
 * which writes outside it, calls the same check. The rule compares what the
 * write replaces with what it writes, both as raw slots and as the effective
 * views of resolution-kind.ts:
 *
 *  - preserving metadata is never refused, even malformed metadata, so an
 *    unrelated edit on a board with stale or hand-edited keys still works;
 *  - clearing is never refused (an older writer clears too);
 *  - a kind slot that is added or changed, or a write that makes a kind
 *    effective that was not (A3: restoring the matching status, date and
 *    text under an unchanged raw kind is an activation), must carry a valid
 *    bound kind and, on a team board, the fence and the v5 registration;
 *  - added or changed disposition evidence must parse and name the
 *    disposition it is written for. It needs no fence: the binding makes a
 *    one-sided merge safe.
 *
 * Journal forward recovery replays content that already passed this check,
 * so it is not re-checked. The merge driver is the merge and is governed by
 * protocol 5, not by this boundary.
 *
 * A4: the boundary never loads the project and never takes a lock. The
 * context below carries the config and memoises git per operation: one
 * `git config` read per driver name and one `git check-attr` per path.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Config } from "../models/config.js";
import { ProjectLoaderError } from "./errors.js";
import {
  DispositionEvidenceShape,
  IssueResolutionKindShape,
  resolutionDigest,
  resolutionKindView,
} from "./resolution-kind.js";
import { RESOLUTION_KIND_MIN_CLI_VERSION, isTeamModeConfig } from "./team-capabilities.js";
import { gitRead, resolutionWritesReadiness, type GitRead } from "./team-setup.js";

type Loose = Readonly<Record<string, unknown>>;

export interface ResolutionWriteContext {
  /** The project root this context was created for, resolved. */
  readonly root: string;
  /** Identity of the lock operation; shared by `withGit` copies. */
  readonly token: object;
  /** True once the lock it belongs to was released; a released context refuses every use. */
  readonly released: boolean;
  /** Bumped by `invalidate`: a decision taken under an older generation no longer holds. */
  readonly generation: number;
  /** Whether the lock this context belongs to still owns `.story/.lock` (a stolen or replaced lock does not). */
  ownsLock(): boolean;
  /** Records whether the write prepared for `target` was authorised from this generation's config and git answers. */
  recordAuthorisation(target: string, dependsOnBoard: boolean): void;
  /** True when the write prepared for `target` depended on answers `invalidate` or `release` has since dropped. */
  authorisationStale(target: string): boolean;
  /** The config, or null when it could not be read (a kind write then fails closed). */
  config(): Pick<Config, "team"> | null;
  readiness(relPath: string): ReturnType<typeof resolutionWritesReadiness>;
  /** The lock holder's loaded config replaces the lazy read (A4). */
  bindConfig(config: Pick<Config, "team">): void;
  /** Drops the config and every git answer: the operation changed what they were derived from. */
  invalidate(): void;
  /** Marks the context released. Called by the lock in its finally, before the lock is released. */
  release(): void;
  /** The same context (same lock, same released state, same config) reading git through `git`. Test seam. */
  withGit(git: GitRead): ResolutionWriteContext;
}

/** A context that cannot be used: missing, released, for another project, or not held by this operation. */
export class ResolutionWriteContextError extends ProjectLoaderError {
  constructor(message: string) {
    super("conflict", `${message}; resolution-metadata writes need the project lock's own write context`);
  }
}

interface SharedState {
  released: boolean;
  generation: number;
  authorised: Map<string, number>;
  ownsLock: () => boolean;
  config: { value: Pick<Config, "team"> | null } | null;
  memo: Map<string, { out: string } | { err: unknown }>;
}

/**
 * A context for one lock operation, created by the lock after it is
 * acquired. `config` is read from `.story/config.json` on first need unless
 * the holder binds its loaded config (C3: the exported writers hold only
 * `withLock`). Nothing is read unless a kind actually changes.
 */
export function createResolutionWriteContext(root: string, git: GitRead = gitRead, ownsLock: () => boolean = () => true): ResolutionWriteContext {
  return contextOver(resolve(root), { released: false, generation: 0, authorised: new Map(), ownsLock, config: null, memo: new Map() }, git);
}

function contextOver(root: string, shared: SharedState, git: GitRead): ResolutionWriteContext {
  const memoGit: GitRead = (args, cwd) => {
    const key = `${cwd}\0${args.join("\0")}`;
    let hit = shared.memo.get(key);
    if (!hit) {
      try {
        hit = { out: git(args, cwd) };
      } catch (err) {
        hit = { err };
      }
      shared.memo.set(key, hit);
    }
    if ("err" in hit) throw hit.err;
    return hit.out;
  };
  const ctx: ResolutionWriteContext = {
    root,
    token: shared,
    get released() {
      return shared.released;
    },
    get generation() {
      return shared.generation;
    },
    ownsLock() {
      return shared.ownsLock();
    },
    recordAuthorisation(target, dependsOnBoard) {
      if (dependsOnBoard) shared.authorised.set(resolve(target), shared.generation);
      else shared.authorised.delete(resolve(target));
    },
    authorisationStale(target) {
      const at = shared.authorised.get(resolve(target));
      return at !== undefined && (shared.released || at !== shared.generation);
    },
    config() {
      if (shared.config === null) shared.config = { value: readConfigForGuard(root) };
      return shared.config.value;
    },
    readiness(relPath) {
      return resolutionWritesReadiness(root, ctx.config()?.team?.minCliVersion, relPath, memoGit);
    },
    bindConfig(config) {
      shared.config = { value: config };
    },
    invalidate() {
      shared.config = null;
      shared.memo.clear();
      shared.generation += 1;
    },
    release() {
      shared.released = true;
      shared.config = null;
      shared.memo.clear();
    },
    withGit(next) {
      return contextOver(root, shared, next);
    },
  };
  return ctx;
}

function readConfigForGuard(root: string): Pick<Config, "team"> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Pick<Config, "team">) : null;
  } catch {
    return null;
  }
}

const has = (o: Loose, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const EVIDENCE_KEYS = ["dispositionReason", "dispositionRef", "dispositionFor"] as const;

function slotEqual(prior: Loose, proposed: Loose, keys: readonly string[]): boolean {
  return keys.every((k) => has(prior, k) === has(proposed, k) && isDeepStrictEqual(prior[k], proposed[k]));
}

/**
 * Refuses a write whose resolution metadata the board cannot carry safely.
 * `prior` is the record being replaced (`{}` when the file is new, "unknown"
 * when it could not be read or parsed, which treats any present metadata as
 * changed). `relPath` is the target relative to the project root. Returns
 * true when the decision read the board's config and git answers, so the
 * write holds only while they do (see `authorisationStale`).
 */
export function assertResolutionMetadataWrite(
  ctx: ResolutionWriteContext,
  relPath: string,
  prior: Loose | "unknown",
  proposed: Loose,
): boolean {
  // B6 / Codex F1: the context is checked here, at the decision, so a
  // context released or a lock replaced since it was obtained never
  // authorises anything, whoever supplied it.
  if (ctx.released) throw new ResolutionWriteContextError("the write context belongs to a lock that was released");
  if (!ctx.ownsLock()) throw new ResolutionWriteContextError("the project lock this write context belongs to no longer owns .story/.lock");
  const gaps: string[] = [];
  let readinessGap = false;
  let boardDependent = false;

  const proposedHasKind = has(proposed, "resolutionKind");
  const kindRawChanged = prior === "unknown" ? proposedHasKind : !slotEqual(prior, proposed, ["resolutionKind"]);
  const proposedView = resolutionKindView(proposed);
  const priorView = prior === "unknown" ? null : resolutionKindView(prior);
  const activation =
    proposedView.state === "effective" && (priorView === null || priorView.state !== "effective" || priorView.kind !== proposedView.kind);
  if (proposedHasKind && (kindRawChanged || activation)) {
    const shape = IssueResolutionKindShape.safeParse(proposed.resolutionKind);
    if (!shape.success) {
      gaps.push("resolutionKind must be {kind, closedOn, resolutionDigest} with an issue kind");
    } else if (proposedView.state !== "effective") {
      if (proposed.status !== "resolved") gaps.push(`resolutionKind is written on an issue that is ${String(proposed.status)}, not resolved`);
      else if (shape.data.closedOn !== proposed.resolvedDate) gaps.push(`resolutionKind.closedOn ${shape.data.closedOn} is not resolvedDate ${String(proposed.resolvedDate ?? "unset")}`);
      else if (typeof proposed.resolution === "string" || proposed.resolution == null) {
        if (shape.data.resolutionDigest !== resolutionDigest(proposed.resolution as string | null | undefined)) gaps.push("resolutionKind.resolutionDigest does not match the resolution text");
      } else gaps.push("resolutionKind is written on an issue whose resolution is not text");
    }
    if (gaps.length === 0) {
      boardDependent = true;
      const config = ctx.config();
      if (config === null) {
        gaps.push("the project config could not be read, so the board's readiness for resolution kinds is unknown");
      } else if (isTeamModeConfig(config)) {
        const readiness = ctx.readiness(relPath);
        if (!readiness.fenceOk) gaps.push(`team.minCliVersion is ${config.team?.minCliVersion ?? "unset"}, below ${RESOLUTION_KIND_MIN_CLI_VERSION}`);
        if (!readiness.driver.ok) gaps.push(readiness.driver.message);
        readinessGap = !readiness.fenceOk || !readiness.driver.ok;
      }
    }
  }

  const proposedHasEvidence = EVIDENCE_KEYS.some((k) => has(proposed, k));
  const evidenceChanged = prior === "unknown" ? proposedHasEvidence : !slotEqual(prior, proposed, EVIDENCE_KEYS);
  if (proposedHasEvidence && evidenceChanged) {
    const evidence = DispositionEvidenceShape.safeParse({
      dispositionReason: proposed.dispositionReason,
      dispositionRef: proposed.dispositionRef,
      dispositionFor: proposed.dispositionFor,
    });
    if (!evidence.success) gaps.push("disposition evidence needs a non-empty dispositionReason and dispositionRef and a valid dispositionFor");
    else if (evidence.data.dispositionFor !== proposed.disposition) {
      gaps.push(`dispositionFor ${evidence.data.dispositionFor} is not the disposition ${String(proposed.disposition ?? "unset")}`);
    }
  }

  if (gaps.length > 0) {
    const setup = readinessGap ? ` Run storybloq team setup on a ${RESOLUTION_KIND_MIN_CLI_VERSION}+ CLI.` : "";
    throw new ProjectLoaderError("conflict", `Refusing the write to ${relPath}: ${gaps.join("; ")}.${setup}`);
  }
  return boardDependent;
}
