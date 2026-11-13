import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CROCKFORD_CLASS } from "../models/types.js";
import { generateCanonicalId } from "./canonical-id.js";
import { ProjectLoaderError } from "./errors.js";
import { resolveAllNodes, resolveOrchestratorRoot } from "../federation/resolver.js";

/**
 * C-v4.1 section 2 (ISS-1433): one durable id per board, shared through git.
 *
 * - `boardId` lives in `.story/config.json`: `b-` plus 16 Crockford characters.
 * - It is minted only by `storybloq init` and `storybloq board-id init`. No
 *   receipt path ever mints one.
 * - Once present it never changes, except through `board-id adopt` under
 *   `BOARD_ID_AUTHORITY`.
 * - Before any receipt, the local id must equal the one on the default branch
 *   (`checkBoardIdLanded`).
 */

export const BOARD_ID_REGEX = new RegExp(`^b-${CROCKFORD_CLASS}{16}$`);
export const BOARD_ID_AUTHORITY: unique symbol = Symbol("board-id-adopt");

export function mintBoardId(): string {
  return generateCanonicalId("b");
}

export function isBoardId(value: unknown): value is string {
  return typeof value === "string" && BOARD_ID_REGEX.test(value);
}

/** 2.1: a config write may add a boardId, never change or remove one, except under the adopt authority. */
export function assertBoardIdWriteAllowed(prior: unknown, next: unknown, authority?: typeof BOARD_ID_AUTHORITY): void {
  if (prior === undefined || prior === next) return;
  if (authority === BOARD_ID_AUTHORITY) return;
  const what = next === undefined ? "remove" : "change";
  throw new ProjectLoaderError(
    "conflict",
    `board_id_immutable: config.json would ${what} the board id ${JSON.stringify(prior)}. ` +
    "The board id never changes once set; `storybloq board-id adopt` is the only way to replace it.",
  );
}

export interface BoardIdMerge {
  readonly present: boolean;
  readonly value?: unknown;
  readonly conflict?: {
    fieldPath: string;
    field: string;
    kind: "board-identity";
    base: unknown;
    ours: unknown;
    theirs: unknown;
  };
}

/**
 * 2.2: the `mergeConfig` branch for `boardId`, run before the generic rules.
 * Any difference among the present values, and any removal on either side,
 * keeps all three values in a `board-identity` conflict. The merged value is
 * base when there is one, otherwise ours (otherwise theirs).
 */
export function mergeBoardId(
  base: unknown, ours: unknown, theirs: unknown,
  has: { base: boolean; ours: boolean; theirs: boolean },
): BoardIdMerge {
  if (!has.base && !has.ours && !has.theirs) return { present: false };
  const present = [has.base ? base : undefined, has.ours ? ours : undefined, has.theirs ? theirs : undefined]
    .filter((v, i) => [has.base, has.ours, has.theirs][i]);
  const allSame = present.every((v) => v === present[0]);
  const removed = has.base && (!has.ours || !has.theirs);
  const value = has.base ? base : has.ours ? ours : theirs;
  if (allSame && !removed) return { present: true, value };
  return {
    present: true,
    value,
    conflict: {
      fieldPath: "/boardId",
      field: "boardId",
      kind: "board-identity",
      base: has.base ? base : null,
      ours: has.ours ? ours : null,
      theirs: has.theirs ? theirs : null,
    },
  };
}

function readConfigRaw(root: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(resolve(root), ".story", "config.json"), "utf-8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The boardId recorded in a board's config, or undefined when absent or not a board id. */
export function readBoardId(root: string): string | undefined {
  const id = readConfigRaw(root)?.boardId;
  return isBoardId(id) ? id : undefined;
}

export function hasBoardIdentityConflict(config: Record<string, unknown> | undefined): boolean {
  const conflicts = config?._conflicts;
  return Array.isArray(conflicts) && conflicts.some((c) => c !== null && typeof c === "object" && (c as { kind?: unknown }).kind === "board-identity");
}

export type BoardIdLandedCode = "board_id_missing" | "board_id_not_landed" | "board_id_diverged" | "board_id_conflicted";

export type BoardIdLanded =
  | { readonly ok: true; readonly boardId: string }
  | { readonly ok: false; readonly code: BoardIdLandedCode; readonly message: string; readonly local?: string; readonly landed?: string };

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** The boardId in `.story/config.json` at `ref`, read only, or undefined when absent there. */
export function readLandedBoardId(root: string, ref: string): string | undefined {
  if (ref.startsWith("-")) return undefined;
  const prefix = (git(root, ["rev-parse", "--show-prefix"]) ?? "").trim();
  const text = git(root, ["show", `${ref}:${prefix}.story/config.json`]);
  if (text === undefined) return undefined;
  try {
    const id = (JSON.parse(text) as Record<string, unknown>).boardId;
    return isBoardId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 2.1: the landed-check every receipt append runs (receipt add, commit 3).
 * The local id and the one on the default branch must both exist and be equal,
 * and no board-identity conflict may be open.
 */
export function checkBoardIdLanded(root: string, defaultRef: string): BoardIdLanded {
  const config = readConfigRaw(root);
  if (hasBoardIdentityConflict(config)) {
    return {
      ok: false, code: "board_id_conflicted",
      message: "board_id_conflicted: config.json has an open board identity conflict. Run `storybloq board-id adopt` to keep the landed id.",
    };
  }
  const local = isBoardId(config?.boardId) ? config!.boardId as string : undefined;
  if (!local) {
    return { ok: false, code: "board_id_missing", message: "board_id_missing: this board has no board id. Run `storybloq board-id init`, then land it." };
  }
  const landed = readLandedBoardId(root, defaultRef);
  if (!landed) {
    return {
      ok: false, code: "board_id_not_landed", local,
      message: `board_id_not_landed: the board id ${local} is not on ${defaultRef} yet. Land the config change (\`storybloq land\`) before recording receipts.`,
    };
  }
  if (landed !== local) {
    return {
      ok: false, code: "board_id_diverged", local, landed,
      message: `board_id_diverged: this clone's board id ${local} differs from ${landed} on ${defaultRef}. Run \`storybloq board-id adopt\` to take the landed id.`,
    };
  }
  return { ok: true, boardId: local };
}

// --- 2.4 federation references, read only ---

export interface BoardEntry {
  /** "." for the orchestrator itself, otherwise the registry alias. */
  readonly alias: string;
  readonly path: string;
  readonly boardId?: string;
  /** Why the board could not be read, when it could not. */
  readonly reason?: string;
}

/**
 * Every board a root can name: the orchestrator and its registered nodes. A
 * node reads its orchestrator's registry, so a receipt resolves the same from
 * the root and from a child. A board outside any federation is its own registry.
 */
export function boardRegistry(root: string): BoardEntry[] {
  const abs = resolve(root);
  const config = readConfigRaw(abs);
  let orchestrator = abs;
  let orchConfig = config;
  if (!(config && config.nodes && typeof config.nodes === "object")) {
    const up = resolveOrchestratorRoot(abs);
    if (up.ok) {
      orchestrator = up.root;
      orchConfig = readConfigRaw(up.root);
    }
  }
  const entries: BoardEntry[] = [{ alias: ".", path: orchestrator, boardId: readBoardId(orchestrator) }];
  const nodes = orchConfig?.nodes;
  if (nodes && typeof nodes === "object" && !Array.isArray(nodes)) {
    const resolved = resolveAllNodes(nodes as Record<string, { path: string }>, orchestrator);
    for (const [alias, node] of resolved) {
      if (node.resolved) entries.push({ alias, path: node.absolutePath, boardId: readBoardId(node.absolutePath) });
      else entries.push({ alias, path: node.absolutePath ?? node.rawPath, reason: node.reason });
    }
  }
  return entries;
}

export type BoardRefResolution =
  | { readonly state: "ok"; readonly entry: BoardEntry }
  | { readonly state: "duplicate"; readonly paths: readonly string[] }
  | { readonly state: "unresolved"; readonly reason: string };

/** A stored boardId to its board. Two boards carrying it make every reference `duplicate`. */
export function resolveBoardRef(registry: readonly BoardEntry[], boardId: string): BoardRefResolution {
  if (!isBoardId(boardId)) return { state: "unresolved", reason: `${JSON.stringify(boardId)} is not a board id` };
  const matches = registry.filter((e) => e.boardId === boardId);
  const paths = [...new Set(matches.map((e) => e.path))];
  if (paths.length > 1) return { state: "duplicate", paths };
  if (matches.length === 0) return { state: "unresolved", reason: `no registered board carries ${boardId}` };
  return { state: "ok", entry: matches[0]! };
}

export type AliasResolution =
  | { readonly state: "ok"; readonly entry: BoardEntry & { boardId: string } }
  | { readonly state: "mismatched"; readonly expected: string; readonly found: string; readonly path: string }
  | { readonly state: "unresolved"; readonly reason: string }
  | { readonly state: "missing"; readonly path: string };

/** An alias to its board; with `expected`, a rebind to a board with another id is `mismatched`. */
export function resolveAlias(registry: readonly BoardEntry[], alias: string, expected?: string): AliasResolution {
  const entry = registry.find((e) => e.alias === alias);
  if (!entry) return { state: "unresolved", reason: `no board is registered as ${JSON.stringify(alias)}` };
  if (entry.reason) return { state: "unresolved", reason: entry.reason };
  if (!entry.boardId) return { state: "missing", path: entry.path };
  if (expected !== undefined && entry.boardId !== expected) {
    return { state: "mismatched", expected, found: entry.boardId, path: entry.path };
  }
  return { state: "ok", entry: entry as BoardEntry & { boardId: string } };
}

/** 2.2: every boardId that two or more registered boards carry, with their paths. */
export function duplicateBoardIds(registry: readonly BoardEntry[]): Array<{ boardId: string; paths: string[] }> {
  const byId = new Map<string, Set<string>>();
  for (const e of registry) {
    if (!e.boardId) continue;
    const set = byId.get(e.boardId) ?? new Set<string>();
    set.add(e.path);
    byId.set(e.boardId, set);
  }
  return [...byId].filter(([, paths]) => paths.size > 1).map(([boardId, paths]) => ({ boardId, paths: [...paths] }));
}

/**
 * 2.4: every board a receipt references must already carry a boardId. A first
 * use across an uninitialised federation refuses once, listing every board
 * that needs `board-id init`. Reads only; never writes another board.
 */
export function assertBoardsInitialised(registry: readonly BoardEntry[], aliases: readonly string[]): void {
  const missing: string[] = [];
  for (const alias of aliases) {
    const r = resolveAlias(registry, alias);
    if (r.state === "missing") missing.push(`${alias} (${r.path})`);
    else if (r.state === "unresolved") missing.push(`${alias} (${r.reason})`);
  }
  if (missing.length > 0) {
    throw new ProjectLoaderError(
      "invalid_input",
      `board_id_missing: ${missing.join(", ")}. Run \`storybloq board-id init\` in each board, land it, then retry.`,
    );
  }
}

/** 2.4: the canonical ref a receipt stores. Display ids and aliases are presentation only. */
export function canonicalRef(boardId: string, canonicalItemId: string): string {
  return `${boardId}:${canonicalItemId}`;
}

/** The receipts on this board whose refs name `boardId` (adopt refuses while any exists). */
export function receiptsNamingBoard(records: readonly Record<string, unknown>[], boardId: string): string[] {
  const names = (v: unknown): boolean => typeof v === "string" && (v === boardId || v.startsWith(`${boardId}:`));
  const out: string[] = [];
  for (const record of records) {
    const receipts = record.receipts;
    if (!Array.isArray(receipts)) continue;
    for (const r of receipts) {
      if (r === null || typeof r !== "object") continue;
      const e = r as Record<string, unknown>;
      const refs = [e.target, e.unitRef, e.repo, ...(Array.isArray(e.covers) ? e.covers : [])];
      if (refs.some(names)) out.push(typeof e.id === "string" ? e.id : `(no id on ${String(record.id)})`);
    }
  }
  return out;
}
