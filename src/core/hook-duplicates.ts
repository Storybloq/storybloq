/**
 * ISS-1222: the same storybloq hook registered through two binary paths.
 *
 * Hook registration was idempotent on the exact command string, so a second
 * launcher path for the same subcommand (an npx cache copy beside the global
 * install) appended a second row, and every session start ran the hook
 * twice, once from stale code. The identity of a row is its SEMANTIC command:
 * an owned binary basename (canonicalised, `claudestory` counts as
 * `storybloq`) plus the subcommand text. Two rows with the same semantic
 * command collide when their matcher groups can fire for the same source.
 *
 * Only a validated global launcher ever drops a row: matcher breadth proves
 * coverage, not that a launcher works, so with no launcher established the
 * reconcile reports the collisions and mutates nothing.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseHookCommand, STORYBLOQ_LEGACY_BASENAMES, type HookEntry, type MatcherGroup } from "./hook-migration.js";
import { atomicWriteFollowingSymlink } from "./symlink-write.js";
import { withSettingsWriteLock } from "./settings-write-lock.js";

export interface HookRowKey {
  /** `storybloq:<subcommand>`, the same for every owned basename. */
  readonly key: string;
  readonly rest: string;
  /** The basename as written (`storybloq` or the legacy `claudestory`). */
  readonly binBasename: string;
}

/** Owned rows share one namespace so a legacy `claudestory` row collides with its `storybloq` twin. */
const KEY_NAMESPACE = "storybloq";
const SHELL_META = /[|&;<>`$()]/;

export function hookRowKey(command: string): HookRowKey | null {
  const parsed = parseHookCommand(command);
  if (parsed === null) return null;
  if (!STORYBLOQ_LEGACY_BASENAMES.has(parsed.binBasename)) return null;
  if (parsed.rest.length === 0) return null;
  // A pipeline or substitution after the binary is inline shell, not one of our subcommands.
  if (SHELL_META.test(parsed.rest)) return null;
  return { key: `${KEY_NAMESPACE}:${parsed.rest}`, rest: parsed.rest, binBasename: parsed.binBasename };
}

/**
 * What a matcher can fire for. An empty matcher is every source. A matcher
 * made only of word characters and `|` is the literal set of its
 * alternatives. Anything else is a regex Storybloq will not reason about:
 * it overlaps or covers only an identical matcher string, so an overlap that
 * cannot be proven never drops a row (a redundant row is harmless, a
 * silently missing one is not).
 */
export type MatcherCoverage =
  | { readonly kind: "universal" }
  | { readonly kind: "sources"; readonly sources: ReadonlySet<string> }
  | { readonly kind: "opaque"; readonly matcher: string };

const LITERAL_MATCHER = /^[A-Za-z0-9_]+(\|[A-Za-z0-9_]+)*$/;

export function matcherCoverage(matcher: string | undefined): MatcherCoverage {
  const m = matcher ?? "";
  if (m === "") return { kind: "universal" };
  if (!LITERAL_MATCHER.test(m)) return { kind: "opaque", matcher: m };
  const sources = new Set(m.split("|").filter((s) => s.length > 0));
  if (sources.size === 0) return { kind: "opaque", matcher: m };
  return { kind: "sources", sources };
}

export function coverageOverlaps(a: MatcherCoverage, b: MatcherCoverage): boolean {
  if (a.kind === "universal" || b.kind === "universal") return true;
  if (a.kind === "opaque" || b.kind === "opaque") {
    return a.kind === "opaque" && b.kind === "opaque" && a.matcher === b.matcher;
  }
  for (const s of a.sources) if (b.sources.has(s)) return true;
  return false;
}

/** Whether every source `target` fires for is one `group` fires for. */
export function coverageCovers(group: MatcherCoverage, target: MatcherCoverage): boolean {
  if (group.kind === "universal") return true;
  if (target.kind === "universal") return false;
  if (group.kind === "opaque" || target.kind === "opaque") {
    return group.kind === "opaque" && target.kind === "opaque" && group.matcher === target.matcher;
  }
  for (const s of target.sources) if (!group.sources.has(s)) return false;
  return true;
}

export interface HookRowRef {
  readonly matcher: string;
  readonly command: string;
}

export interface HookCollision {
  readonly hookType: string;
  readonly key: string;
  readonly rows: readonly HookRowRef[];
}

export interface DedupeReport {
  readonly hookType: string;
  readonly key: string;
  readonly kept: HookRowRef;
  readonly dropped: readonly HookRowRef[];
}

export interface PrunedGroup {
  readonly hookType: string;
  readonly matcher: string;
}

export interface DedupeOutcome {
  readonly changed: boolean;
  readonly reconciled: readonly DedupeReport[];
  /** Collisions left in place because no validated global launcher was available. */
  readonly unresolved: readonly HookCollision[];
  /** ISS-1226: empty matcher groups removed under events Storybloq owns, whoever emptied them. */
  readonly pruned: readonly PrunedGroup[];
}

/**
 * ISS-1226: the events setup-skill registers hooks under. An empty matcher
 * group under one of these is debris from an earlier writer (a migration
 * that removed the group's last row) and is pruned; empty groups under any
 * other event belong to someone else and are never touched.
 */
export const STORYBLOQ_HOOK_EVENTS: ReadonlySet<string> = new Set(["PreCompact", "SessionStart", "Stop", "UserPromptSubmit"]);

/** The validated global launcher's command for a subcommand, or null when none was established. */
export type GlobalCommandFor = (rest: string) => string | null;

interface Row {
  readonly groupIndex: number;
  readonly entryIndex: number;
  readonly group: MatcherGroup;
  readonly entry: HookEntry;
  readonly matcher: string;
  readonly command: string;
  readonly key: HookRowKey;
  readonly coverage: MatcherCoverage;
}

function hooksOf(settings: unknown): Record<string, unknown> | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const hooks = (settings as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  return hooks as Record<string, unknown>;
}

function ownedRows(hookArray: unknown[]): Row[] {
  const rows: Row[] = [];
  hookArray.forEach((group, groupIndex) => {
    if (typeof group !== "object" || group === null) return;
    const g = group as MatcherGroup;
    if (!Array.isArray(g.hooks)) return;
    g.hooks.forEach((entry, entryIndex) => {
      if (typeof entry !== "object" || entry === null) return;
      const e = entry as HookEntry;
      if (e.type !== "command" || typeof e.command !== "string") return;
      const key = hookRowKey(e.command);
      if (key === null) return;
      const matcher = typeof g.matcher === "string" ? g.matcher : "";
      rows.push({ groupIndex, entryIndex, group: g, entry: e, matcher, command: e.command.trim(), key, coverage: matcherCoverage(matcher) });
    });
  });
  return rows;
}

/** Same key, overlapping coverage, joined transitively; components of two or more rows. */
function components(rows: readonly Row[]): Row[][] {
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byKey.get(r.key.key) ?? [];
    list.push(r);
    byKey.set(r.key.key, list);
  }
  const out: Row[][] = [];
  for (const list of byKey.values()) {
    const parent = list.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (coverageOverlaps(list[i]!.coverage, list[j]!.coverage)) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, Row[]>();
    list.forEach((r, i) => {
      const root = find(i);
      const g = groups.get(root) ?? [];
      g.push(r);
      groups.set(root, g);
    });
    for (const g of groups.values()) if (g.length > 1) out.push(g);
  }
  // Report in file order: by first row's position.
  out.sort((a, b) => a[0]!.groupIndex - b[0]!.groupIndex || a[0]!.entryIndex - b[0]!.entryIndex);
  return out;
}

const ref = (r: Row): HookRowRef => ({ matcher: r.matcher, command: r.command });

export function findHookCollisions(settings: unknown): HookCollision[] {
  const hooks = hooksOf(settings);
  if (hooks === null) return [];
  const found: HookCollision[] = [];
  for (const [hookType, hookArray] of Object.entries(hooks)) {
    if (!Array.isArray(hookArray)) continue;
    for (const comp of components(ownedRows(hookArray))) {
      found.push({ hookType, key: comp[0]!.key.key, rows: comp.map(ref) });
    }
  }
  return found;
}

/** The one matcher a collision collapses to: universal if any row is, else the union of the literal sources. */
function unionMatcher(comp: readonly Row[]): string | null {
  if (comp.some((r) => r.coverage.kind === "universal")) return "";
  const first = comp[0]!.coverage;
  if (first.kind === "opaque") {
    // Opaque rows only ever overlap identical matchers, so the component is uniform.
    return first.matcher;
  }
  const seen: string[] = [];
  for (const r of comp) {
    if (r.coverage.kind !== "sources") return null;
    for (const s of r.matcher.split("|")) if (s && !seen.includes(s)) seen.push(s);
  }
  return seen.join("|");
}

/**
 * Collapses every collision to exactly one row: the union matcher for the
 * destination, the validated global launcher's command, and the hook options
 * (timeout, async, anything else) of the row that already carried that
 * command, else of the first row. Mutates `settings` in place. Groups
 * emptied by a drop are removed, and so is any group already empty under an
 * event Storybloq owns (ISS-1226). With no global command for a subcommand
 * the collision is reported under `unresolved` and left exactly as it was.
 */
export function dedupeHookRows(settings: unknown, globalCommandFor: GlobalCommandFor): DedupeOutcome {
  const hooks = hooksOf(settings);
  if (hooks === null) return { changed: false, reconciled: [], unresolved: [], pruned: [] };
  const reconciled: DedupeReport[] = [];
  const unresolved: HookCollision[] = [];
  const pruned: PrunedGroup[] = [];
  for (const [hookType, hookArray] of Object.entries(hooks)) {
    if (!Array.isArray(hookArray)) continue;
    if (STORYBLOQ_HOOK_EVENTS.has(hookType)) {
      const prunedHere: PrunedGroup[] = [];
      for (let i = hookArray.length - 1; i >= 0; i--) {
        const group = hookArray[i];
        if (typeof group !== "object" || group === null) continue;
        const g = group as MatcherGroup;
        if (Array.isArray(g.hooks) && g.hooks.length === 0) {
          hookArray.splice(i, 1);
          prunedHere.unshift({ hookType, matcher: typeof g.matcher === "string" ? g.matcher : "" });
        }
      }
      pruned.push(...prunedHere);
    }
    const comps = components(ownedRows(hookArray));
    if (comps.length === 0) continue;
    const toDrop = new Set<HookEntry>();
    const replaceInPlace = new Map<HookEntry, HookEntry>();
    const placements: Array<{ matcher: string; entry: HookEntry; anchorGroupIndex: number }> = [];
    for (const comp of comps) {
      const rest = comp[0]!.key.rest;
      const global = globalCommandFor(rest);
      const matcher = unionMatcher(comp);
      if (global === null || matcher === null) {
        unresolved.push({ hookType, key: comp[0]!.key.key, rows: comp.map(ref) });
        continue;
      }
      const globalTrimmed = global.trim();
      const source = comp.find((r) => r.command === globalTrimmed) ?? comp[0]!;
      const keeperEntry: HookEntry = { ...source.entry, command: globalTrimmed };
      const kept: HookRowRef = { matcher, command: globalTrimmed };
      // A component row already sitting in the destination group keeps its
      // slot (the source row first), so the file's row order survives.
      const slot = (source.matcher === matcher ? source : undefined) ?? comp.find((r) => r.matcher === matcher);
      // The one row that survives as itself is a slot already carrying the
      // global command; every other row is reported dropped, identical
      // duplicates included, so the log names each row the file loses.
      const survivor = slot && slot.command === globalTrimmed ? slot : null;
      const dropped = comp.filter((r) => r !== survivor).map(ref);
      for (const r of comp) {
        if (slot && r.entry === slot.entry) replaceInPlace.set(r.entry, keeperEntry);
        else toDrop.add(r.entry);
      }
      // A keeper with no slot goes where the collision FIRST appears in the
      // file, not where the global row happened to sit, so the consolidated
      // hook never moves past unrelated groups.
      if (!slot) placements.push({ matcher, entry: keeperEntry, anchorGroupIndex: comp[0]!.groupIndex });
      reconciled.push({ hookType, key: comp[0]!.key.key, kept, dropped });
    }
    if (toDrop.size === 0 && replaceInPlace.size === 0) continue;
    // Rewrite keepers in their slots, remove every other row of every
    // resolved collision, then place the keepers that had no slot.
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      g.hooks = g.hooks
        .filter((entry) => !toDrop.has(entry as HookEntry))
        .map((entry) => replaceInPlace.get(entry as HookEntry) ?? entry);
    }
    // Anchors are indices into the array BEFORE any insertion: place in
    // ascending anchor order and shift each by the insertions already made,
    // so a second placement never lands against a moved group.
    placements.sort((a, b) => a.anchorGroupIndex - b.anchorGroupIndex);
    let inserted = 0;
    for (const p of placements) {
      const target = hookArray.find((group) =>
        typeof group === "object" && group !== null &&
        ((group as MatcherGroup).matcher ?? "") === p.matcher &&
        Array.isArray((group as MatcherGroup).hooks)) as MatcherGroup | undefined;
      if (target) {
        target.hooks!.push(p.entry);
      } else {
        const at = Math.min(p.anchorGroupIndex + inserted, hookArray.length);
        hookArray.splice(at, 0, { matcher: p.matcher, hooks: [p.entry] });
        inserted += 1;
      }
    }
    for (let i = hookArray.length - 1; i >= 0; i--) {
      const group = hookArray[i];
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (Array.isArray(g.hooks) && g.hooks.length === 0) hookArray.splice(i, 1);
    }
  }
  return { changed: reconciled.length > 0 || pruned.length > 0, reconciled, unresolved, pruned };
}

/**
 * Reads a settings file with the same guards as hook removal (a missing,
 * unreadable or malformed file is left alone), dedupes, and writes atomically
 * only when a collision was resolved or an empty owned group was pruned.
 */
export async function reconcileDuplicateHookRows(settingsPath: string, globalCommandFor: GlobalCommandFor): Promise<DedupeOutcome> {
  const nothing: DedupeOutcome = { changed: false, reconciled: [], unresolved: [], pruned: [] };
  return withSettingsWriteLock(settingsPath, nothing, () => reconcileDuplicateHookRowsLocked(settingsPath, globalCommandFor, nothing));
}

async function reconcileDuplicateHookRowsLocked(
  settingsPath: string,
  globalCommandFor: GlobalCommandFor,
  nothing: DedupeOutcome,
): Promise<DedupeOutcome> {
  if (!existsSync(settingsPath)) return nothing;
  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf-8"));
  } catch {
    return nothing;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return nothing;
  const out = dedupeHookRows(settings, globalCommandFor);
  if (!out.changed) return out;
  try {
    await atomicWriteFollowingSymlink(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    return { changed: false, reconciled: [], unresolved: out.unresolved, pruned: [] };
  }
  return out;
}

export type { HookEntry, MatcherGroup };
