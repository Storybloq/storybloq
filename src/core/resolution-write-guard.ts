/**
 * T-486 2c: the one write boundary for issue resolution metadata.
 *
 * Every issue write passes through `prepareIssueWrite`. The few writers that
 * commit issue bytes they built themselves (ledger restore, reconcile, repair)
 * run the same check through `authoriseIssueBytes`. Either way the decision is
 * recorded as a token bound to the exact bytes, the lock's context and the
 * generation of its answers, and every commit refuses issue bytes without a
 * current token (Codex F2). The rule compares what the
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
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Config } from "../models/config.js";
import { ProjectLoaderError } from "./errors.js";
import {
  DispositionEvidenceShape,
  ISSUE_RESOLUTION_KINDS,
  IssueResolutionKindShape,
  TicketResolutionKindShape,
  resolutionDigest,
  resolutionKindView,
  ticketResolutionKindView,
} from "./resolution-kind.js";
import { hasOwnerCheckpoint } from "./owner-checkpoint.js";
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
  /**
   * Records the token for `content` prepared for `target` under this context:
   * its hash, this context, and (when the decision read the board's config or
   * git answers) this generation. It replaces any earlier token for `target`.
   * `withdrawalGated` marks bytes whose ledger refusals run at commit
   * (T-486 U2-6, `assertTicketResolutionWrite`).
   */
  recordPrepared(target: string, content: string, dependsOnBoard: boolean, withdrawalGated?: boolean): void;
  /** Whether committing `content` to `target` is covered by a current token of this context. */
  preparedVerdict(target: string, content: string): PreparedVerdict;
  /** Whether a current token of this context covers exactly `content` for `target` and is withdrawal-gated. */
  preparedWithdrawal(target: string, content: string): boolean;
  /** The config, or null when it could not be read (a kind write then fails closed). */
  config(): Pick<Config, "team"> | null;
  readiness(relPath: string): ReturnType<typeof resolutionWritesReadiness>;
  /** The lock holder's loaded config replaces the lazy read (A4). */
  bindConfig(config: Pick<Config, "team">): void;
  /**
   * ISS-1405: every file claiming `id` in `.story/<dir>/` (relative to the
   * root, sorted) when at least one of them is misnamed; empty otherwise.
   * Throws when the directory or one of its records cannot be read, because
   * then the answer is unknown and a write must not guess. The one exception
   * is a ticket's own unparseable file, which priorForGuard refuses instead.
   */
  misnamedClaimants(dir: MisnamedDir, id: string): readonly string[];
  /**
   * The lock holder's loaded map (`<dir>/<id>` to claimants) replaces the lazy
   * directory read, except for `unverified` directories: the load left a record
   * out of the map there, so an absent entry proves nothing and the directory
   * read answers, with its refusals.
   */
  bindMisnamed(map: ReadonlyMap<string, readonly string[]>, unverified?: ReadonlySet<string>): void;
  /** Drops the config, the misnamed-file answers and every git answer: the operation changed what they were derived from. */
  invalidate(): void;
  /** Marks the context released. Called by the lock in its finally, before the lock is released. */
  release(): void;
  /** The same context (same lock, same released state, same config) reading git through `git`. Test seam. */
  withGit(git: GitRead): ResolutionWriteContext;
}

/**
 * `current`: this context prepared exactly these bytes and the answers they
 * depended on still hold. `missing`: this context prepared nothing for the
 * target. `changed`: it prepared other bytes. `released`: the context's lock
 * was released or no longer owns `.story/.lock`. `stale`: the answers the
 * decision read were dropped by `invalidate`.
 */
/** ISS-1405: the ledger directories whose writers target `<id>.json`. */
export type MisnamedDir = "tickets" | "issues";

export type PreparedVerdict = "current" | "missing" | "released" | "changed" | "stale";

interface PreparedToken {
  readonly owner: SharedState;
  readonly hash: string;
  readonly generation: number | null;
  readonly withdrawal: boolean;
}

/**
 * The latest prepared token per issue path. It outlives the lock that wrote
 * it on purpose: the owner check is what refuses bytes prepared under one
 * lock and committed under another. One entry per path, so it is bounded by
 * the issues this process has written.
 */
const preparedTokens = new Map<string, PreparedToken>();

const contentHash = (content: string) => createHash("sha256").update(content, "utf-8").digest("hex");

/** A context that cannot be used: missing, released, for another project, or not held by this operation. */
export class ResolutionWriteContextError extends ProjectLoaderError {
  constructor(message: string) {
    super("conflict", `${message}; resolution-metadata writes need the project lock's own write context`);
  }
}

interface MisnamedAnswers {
  readonly bound: ReadonlyMap<string, readonly string[]> | null;
  readonly unverified: ReadonlySet<string>;
  readonly read: Map<MisnamedDir, MisnamedRead>;
}

const unboundMisnamed = (): MisnamedAnswers => ({ bound: null, unverified: new Set(), read: new Map() });

interface SharedState {
  released: boolean;
  generation: number;
  ownsLock: () => boolean;
  config: { value: Pick<Config, "team"> | null } | null;
  misnamed: MisnamedAnswers;
  memo: Map<string, { out: string } | { err: unknown }>;
}

/**
 * A context for one lock operation, created by the lock after it is
 * acquired. `config` is read from `.story/config.json` on first need unless
 * the holder binds its loaded config (C3: the exported writers hold only
 * `withLock`). Nothing is read unless a kind actually changes.
 */
export function createResolutionWriteContext(root: string, git: GitRead = gitRead, ownsLock: () => boolean = () => true): ResolutionWriteContext {
  return contextOver(resolve(root), { released: false, generation: 0, ownsLock, config: null, misnamed: unboundMisnamed(), memo: new Map() }, git);
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
    recordPrepared(target, content, dependsOnBoard, withdrawalGated = false) {
      preparedTokens.set(resolve(target), {
        owner: shared,
        hash: contentHash(content),
        generation: dependsOnBoard ? shared.generation : null,
        withdrawal: withdrawalGated,
      });
    },
    preparedVerdict(target, content) {
      const token = preparedTokens.get(resolve(target));
      if (token === undefined || token.owner !== shared) return "missing";
      // Codex H1: a released context, or one whose lock no longer owns
      // .story/.lock, authorises nothing at commit, whatever the write was.
      if (shared.released || !shared.ownsLock()) return "released";
      if (token.hash !== contentHash(content)) return "changed";
      if (token.generation !== null && token.generation !== shared.generation) return "stale";
      return "current";
    },
    preparedWithdrawal(target, content) {
      // No ownership probe: assertPreparedWritesCurrent has just made it, and
      // a second probe would sit between the commit check and the write.
      const token = preparedTokens.get(resolve(target));
      return token !== undefined && token.owner === shared && !shared.released && token.withdrawal &&
        token.hash === contentHash(content) && (token.generation === null || token.generation === shared.generation);
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
    misnamedClaimants(dir, id) {
      if (shared.misnamed.bound !== null && !shared.misnamed.unverified.has(dir)) return shared.misnamed.bound.get(`${dir}/${id}`) ?? [];
      let read = shared.misnamed.read.get(dir);
      if (read === undefined) {
        read = readMisnamedForGuard(root, dir);
        shared.misnamed.read.set(dir, read);
      }
      // A ticket's own file (<id>.json) that does not parse is left to priorForGuard, which every ticket write and
      // delete runs on its target and which refuses it with the repair hint. Tickets only: the issue paths have no
      // own-file refusal, so there an unparseable own file still makes the answer unknown.
      const own = `${id}.json`;
      const bad = read.unparseable.find((u) => !(dir === "tickets" && u.entry === own));
      if (bad) throw unknownMisnamed(dir, `cannot read or parse ${bad.relPath}`, bad.err);
      return read.claimants.get(id) ?? [];
    },
    bindMisnamed(map, unverified = new Set()) {
      shared.misnamed = { bound: map, unverified, read: new Map() };
    },
    invalidate() {
      shared.config = null;
      shared.misnamed = unboundMisnamed();
      shared.memo.clear();
      shared.generation += 1;
    },
    release() {
      shared.released = true;
      shared.config = null;
      shared.misnamed = unboundMisnamed();
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

interface MisnamedRead {
  readonly claimants: ReadonlyMap<string, readonly string[]>;
  /** Records that were read but do not parse; which ids they make unknown is decided per id. */
  readonly unparseable: readonly { entry: string; relPath: string; err: unknown }[];
}

const unknownMisnamed = (dir: MisnamedDir, what: string, err: unknown) =>
  new ProjectLoaderError(
    "io_error",
    `Cannot tell whether a misnamed file in .story/${dir}/ claims this id: ${what}; the write is refused until it can be read`,
    err,
  );

/**
 * ISS-1405: the unbound answer for one directory, read the way the loader
 * reads it (dot files and non-JSON skipped). Unlike `readConfigForGuard` it
 * never reads a failure as "nothing there": a missing directory is empty,
 * and any other failure to enumerate or read refuses, naming the cause. A
 * record that does not parse is kept, and `misnamedClaimants` decides which
 * ids it makes unknown. A record the loader's schema would refuse still
 * claims its id here, which can only refuse more.
 */
function readMisnamedForGuard(root: string, dir: MisnamedDir): MisnamedRead {
  const dirPath = join(root, ".story", dir);
  const unknown = (what: string, err: unknown) => unknownMisnamed(dir, what, err);
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { claimants: new Map(), unparseable: [] };
    throw unknown(`cannot enumerate .story/${dir}`, err);
  }
  const claimants = new Map<string, string[]>();
  const unparseable: { entry: string; relPath: string; err: unknown }[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || extname(entry) !== ".json") continue;
    const relPath = relative(root, join(dirPath, entry));
    let text: string;
    try {
      text = readFileSync(join(dirPath, entry), "utf-8");
    } catch (err) {
      throw unknown(`cannot read or parse ${relPath}`, err);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      unparseable.push({ entry, relPath, err });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as Loose).id !== "string") continue;
    const id = (parsed as Loose).id as string;
    const files = claimants.get(id);
    if (files) files.push(relPath);
    else claimants.set(id, [relPath]);
  }
  return { claimants: misnamedOnly(claimants), unparseable };
}

/** ISS-1405: the claimants of every id at least one of whose files is misnamed, keyed by id, each list sorted. */
export function misnamedOnly(claimants: ReadonlyMap<string, readonly string[]>): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [id, files] of claimants) {
    if (files.some((f) => basename(f, ".json") !== id)) out.set(id, [...files].sort());
  }
  return out;
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
 * write holds only while they do (see `preparedVerdict`).
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

/** What the ticket boundary decided for one write. */
export interface TicketWriteDecision {
  /** The decision read the board's config and git answers (see `preparedVerdict`). */
  readonly dependsOnBoard: boolean;
  /** The bytes carry an effective withdrawal whose ledger refusals run at commit (project-loader.ts). */
  readonly withdrawalGated: boolean;
}

const UNGATED: TicketWriteDecision = { dependsOnBoard: false, withdrawalGated: false };

/**
 * T-486 U2 section 2: the ticket counterpart, for the withdrawal kind. Same
 * context rules as the issue boundary. Removal, preserved metadata and a
 * deactivation pass; an added or changed slot must be a valid withdrawal
 * bound to the proposed completion on a ticket that is not an owner
 * checkpoint. U2-6: an effective withdrawal whose raw slot changed, or that
 * is newly effective, asks what an issue kind asks (a readable config and,
 * on a team board, the fence and the v5 driver), and its bytes are marked
 * so the ledger refusals (ticket-withdrawal.ts) run against disk when they
 * commit. Only an unchanged effective slot is exempt.
 */
export function assertTicketResolutionWrite(
  ctx: ResolutionWriteContext,
  relPath: string,
  prior: Loose | "unknown",
  proposed: Loose,
): TicketWriteDecision {
  if (ctx.released) throw new ResolutionWriteContextError("the write context belongs to a lock that was released");
  if (!ctx.ownsLock()) throw new ResolutionWriteContextError("the project lock this write context belongs to no longer owns .story/.lock");
  if (!has(proposed, "resolutionKind")) return UNGATED;
  const rawChanged = prior === "unknown" || !slotEqual(prior, proposed, ["resolutionKind"]);
  const gaps: string[] = [];
  if (rawChanged) {
    const raw = proposed.resolutionKind;
    const shape = TicketResolutionKindShape.safeParse(raw);
    const rawKind = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Loose).kind : undefined;
    if (typeof rawKind === "string" && (ISSUE_RESOLUTION_KINDS as readonly string[]).includes(rawKind)) {
      gaps.push(`resolutionKind.kind "${rawKind}" is an issue kind; a ticket can only be withdrawn`);
    } else if (!shape.success) {
      gaps.push(`resolutionKind is not a valid withdrawal (${shape.error.issues.map((i) => `${["resolutionKind", ...i.path].join(".")}: ${i.message}`).join("; ")})`);
    } else {
      if (proposed.status !== "complete") gaps.push(`resolutionKind is written on a ticket whose status is ${String(proposed.status)}, not complete`);
      else if (shape.data.closedOn !== proposed.completedDate) gaps.push(`resolutionKind.closedOn ${shape.data.closedOn} is not the completedDate ${String(proposed.completedDate ?? "unset")}`);
      if (hasOwnerCheckpoint(proposed)) gaps.push("resolutionKind is written on an owner checkpoint, which releases by its own resolution");
    }
  }
  let gated = false;
  let readinessGap = false;
  if (gaps.length === 0) {
    const before = prior === "unknown" ? null : ticketResolutionKindView(prior).state;
    const effective = ticketResolutionKindView(proposed).state === "effective";
    const activation = effective && before !== "effective";
    if (effective && (rawChanged || activation)) {
      gated = true;
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
  if (gaps.length > 0) {
    const setup = readinessGap ? ` Run storybloq team setup on a ${RESOLUTION_KIND_MIN_CLI_VERSION}+ CLI.` : "";
    throw new ProjectLoaderError("conflict", `Refusing the write to ${relPath}: ${gaps.join("; ")}.${setup}`);
  }
  return { dependsOnBoard: gated, withdrawalGated: gated };
}
