/**
 * C-v4.1 commit 4, plan 4.3 and 4.4: attribution of code-touching commits to
 * tickets and issues, and the per-item git state.
 *
 * The attribution cache is keyed by the graph key plus the subject pattern
 * and holds raw tokens only (token -> commits), before any id resolution. Id
 * resolution (token -> canonical id) runs on every read against the current
 * ledger and is never cached, so a reconcile or a rename takes effect at once
 * in a long-lived MCP process.
 *
 * subjectPattern: absent means the landings matcher (ticket and issue ids
 * anywhere in the subject, display ids and hash ids). A configured pattern is
 * applied globally; each match's first capture group, or the whole match when
 * it has none, is a token. Subjects are cut to MAX_MATCH_INPUT_LENGTH first.
 */
import { REF_TOKEN_RE } from "../landings.js";
import type { ProjectState } from "../project-state.js";
import { sandboxTokens } from "./pattern-sandbox.js";
import { MAX_MATCH_INPUT_LENGTH, type GitSnapshot, type GitState, type UnknownReason } from "./snapshot.js";

export const ITEM_SHAS_PER_STATE = 5;
const ATTRIBUTION_MEMO_KEYS = 8;

type OkSnapshot = Extract<GitSnapshot, { status: "ok" }>;

/** Token -> commits, keyed by graph key + pattern source; bounded, oldest out. */
const attributionCache = new Map<string, ReadonlyMap<string, readonly string[]>>();

export function clearAttributionCache(): void {
  attributionCache.clear();
}

export function attributionCacheSize(): number {
  return attributionCache.size;
}

function tokensOf(subject: string, re: RegExp): string[] {
  const text = subject.length > MAX_MATCH_INPUT_LENGTH ? subject.slice(0, MAX_MATCH_INPUT_LENGTH) : subject;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const out = new Set<string>();
  for (const m of text.matchAll(g)) {
    const t = m[1] ?? m[0];
    if (t.length > 0) out.add(t);
  }
  return [...out];
}

export function tokenCommits(snap: OkSnapshot, subjectPattern?: RegExp): ReadonlyMap<string, readonly string[]> {
  const re = subjectPattern ?? REF_TOKEN_RE;
  const key = `${snap.key}\0${re.source}\0${re.flags}`;
  const hit = attributionCache.get(key);
  if (hit !== undefined) {
    attributionCache.delete(key);
    attributionCache.set(key, hit);
    return hit;
  }
  const map = new Map<string, string[]>();
  const shas: string[] = [];
  const subjects: string[] = [];
  for (const [sha, subject] of snap.graph.subjects) {
    if (!snap.touchesCode(sha)) continue;
    shas.push(sha);
    subjects.push(subject);
  }
  // A configured pattern runs in the sandbox with a deadline (Codex finding 1); the built-in matcher runs natively.
  const tokens = subjectPattern === undefined ? subjects.map((s) => tokensOf(s, re)) : sandboxTokens("gitState.subjectPattern", re, subjects);
  for (let i = 0; i < shas.length; i += 1) {
    const sha = shas[i]!;
    for (const t of tokens[i]!) {
      const list = map.get(t);
      if (list === undefined) map.set(t, [sha]);
      else list.push(sha);
    }
  }
  attributionCache.set(key, map);
  while (attributionCache.size > ATTRIBUTION_MEMO_KEYS) {
    const oldest = attributionCache.keys().next().value as string;
    attributionCache.delete(oldest);
  }
  return map;
}

export interface ItemGitFacts {
  readonly state: GitState;
  readonly counts: Readonly<Record<GitState, number>>;
  /** At most ITEM_SHAS_PER_STATE per state. */
  readonly shas: Readonly<Record<GitState, readonly string[]>>;
}

export type ItemGitState = ({ readonly state: GitState } & Omit<ItemGitFacts, "state">) | { readonly state: "unknown"; readonly reason: UnknownReason; readonly detail?: string };

const ORDER: readonly GitState[] = ["released", "landed", "built", "none"];

/** Canonical id -> facts, resolved now against `state`. */
export function itemFacts(snap: OkSnapshot, state: ProjectState, subjectPattern?: RegExp): Map<string, ItemGitFacts> {
  const byItem = new Map<string, Set<string>>();
  for (const [token, shas] of tokenCommits(snap, subjectPattern)) {
    const t = state.resolveTicketRef(token);
    const i = t.kind === "found" ? undefined : state.resolveIssueRef(token);
    const id = t.kind === "found" ? t.item.id : i?.kind === "found" ? i.item.id : undefined;
    if (id === undefined) continue;
    let set = byItem.get(id);
    if (set === undefined) byItem.set(id, (set = new Set()));
    for (const s of shas) set.add(s);
  }
  const out = new Map<string, ItemGitFacts>();
  for (const [id, set] of byItem) {
    const buckets: Record<GitState, string[]> = { released: [], landed: [], built: [], none: [] };
    for (const sha of set) buckets[snap.stateOf(sha)].push(sha);
    const best = ORDER.find((s) => buckets[s].length > 0) ?? "none";
    out.set(id, {
      state: best,
      counts: { released: buckets.released.length, landed: buckets.landed.length, built: buckets.built.length, none: buckets.none.length },
      shas: {
        released: buckets.released.sort().slice(0, ITEM_SHAS_PER_STATE),
        landed: buckets.landed.sort().slice(0, ITEM_SHAS_PER_STATE),
        built: buckets.built.sort().slice(0, ITEM_SHAS_PER_STATE),
        none: buckets.none.sort().slice(0, ITEM_SHAS_PER_STATE),
      },
    });
  }
  return out;
}

const EMPTY: ItemGitFacts = {
  state: "none",
  counts: { released: 0, landed: 0, built: 0, none: 0 },
  shas: { released: [], landed: [], built: [], none: [] },
};

export function itemGitState(snap: GitSnapshot, facts: Map<string, ItemGitFacts> | undefined, id: string): ItemGitState {
  if (snap.status !== "ok") return { state: "unknown", reason: snap.reason, ...(snap.detail !== undefined ? { detail: snap.detail } : {}) };
  return facts?.get(id) ?? EMPTY;
}
