/**
 * C-v4.1 commit 4, plan section 4.3: the graph cache, per process.
 *
 * LRU over at most GRAPH_CACHE_ENTRIES entries and a total byte estimate cap
 * of GRAPH_CACHE_BYTES. The cap counts each entry's ancestry memo as well as
 * its tables. A memo that would push the total over the cap is dropped first
 * (memos of the oldest entries before newer ones), before a whole entry is
 * evicted. The attribution cache (attribution.ts) is keyed by this key plus
 * the subject pattern; id resolution is never cached.
 */
import { createHash } from "node:crypto";
import type { GraphIndex } from "./graph-index.js";

export const GRAPH_CACHE_ENTRIES = 4;
export const GRAPH_CACHE_BYTES = 64 * 1024 * 1024;

export interface GraphKeyParts {
  readonly repo: string;
  readonly shallow: string;
  readonly head: string;
  readonly refs: readonly string[];
  readonly peeled: readonly string[];
  readonly defaultTarget: string;
  readonly config: string;
}

export function graphKey(p: GraphKeyParts): string {
  const h = createHash("sha256");
  for (const part of [p.repo, p.shallow, p.head, ...p.refs, "\u0001", ...p.peeled, "\u0001", p.defaultTarget, p.config]) {
    h.update(part);
    h.update("\0");
  }
  return h.digest("hex");
}

export interface GraphEntry {
  readonly key: string;
  readonly graph: GraphIndex;
  /** Ancestry memo: b's number to b's ancestor bitset. */
  memo?: Map<number, Uint8Array>;
  memoBytes?: number;
}

export class GraphCache {
  private readonly entries = new Map<string, GraphEntry>();
  private readonly tableBytes = new Map<string, number>();

  constructor(private readonly maxEntries = GRAPH_CACHE_ENTRIES, private readonly maxBytes = GRAPH_CACHE_BYTES) {}

  get size(): number {
    return this.entries.size;
  }

  totalBytes(): number {
    let n = 0;
    for (const [k, e] of this.entries) n += (this.tableBytes.get(k) ?? 0) + (e.memoBytes ?? 0);
    return n;
  }

  get(key: string): GraphEntry | undefined {
    const e = this.entries.get(key);
    if (e === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(entry: GraphEntry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    this.tableBytes.set(entry.key, entry.graph.byteEstimate());
    this.enforce();
  }

  clear(): void {
    this.entries.clear();
    this.tableBytes.clear();
  }

  private enforce(): void {
    while (this.entries.size > this.maxEntries) this.evictOldest();
    // Drop memos first, oldest entry first, then whole entries.
    for (const e of this.entries.values()) {
      if (this.totalBytes() <= this.maxBytes) return;
      if (e.memo !== undefined) {
        e.memo = undefined;
        e.memoBytes = 0;
      }
    }
    while (this.totalBytes() > this.maxBytes && this.entries.size > 1) this.evictOldest();
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    this.entries.delete(oldest);
    this.tableBytes.delete(oldest);
  }

  /** isAncestor(a, b): a is b or an ancestor of b, answered from the index. */
  isAncestor(entry: GraphEntry, a: string, b: string): boolean {
    const g = entry.graph;
    const ia = g.num.get(a);
    const ib = g.num.get(b);
    if (ia === undefined || ib === undefined) return false;
    if (ia === ib) return true;
    if (g.pos[ia]! > g.pos[ib]!) return false;
    let bits = entry.memo?.get(ib);
    if (bits === undefined) {
      bits = g.ancestorsOf(ib);
      const cost = bits.byteLength + 32;
      const live = this.entries.get(entry.key) === entry;
      if (live && this.totalBytes() + cost <= this.maxBytes) {
        if (entry.memo === undefined) entry.memo = new Map();
        entry.memo.set(ib, bits);
        entry.memoBytes = (entry.memoBytes ?? 0) + cost;
      }
    }
    return bits[ia] === 1;
  }
}

export const graphCache = new GraphCache();
