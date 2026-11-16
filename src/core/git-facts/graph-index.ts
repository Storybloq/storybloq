/**
 * C-v4.1 commit 4, plan sections 4.3 and 4.4: the reachability index over one
 * captured graph.
 *
 * Commits get dense numbers and topological positions (every parent before
 * its children). Three bitsets record reachability from the default target,
 * from release tags and from any branch head or HEAD.
 */
import type { GitState } from "./snapshot.js";

export interface IndexTips {
  readonly fromDefault: readonly string[];
  readonly fromRelease: readonly string[];
  readonly fromBranch: readonly string[];
}

export class GraphIndex {
  readonly ids: readonly string[];
  readonly num: ReadonlyMap<string, number>;
  readonly parentNums: readonly Int32Array[];
  readonly pos: Int32Array;
  readonly subjects: ReadonlyMap<string, string>;
  private readonly code: ReadonlySet<string>;
  private readonly released: Uint8Array;
  private readonly landed: Uint8Array;
  private readonly built: Uint8Array;

  constructor(parents: ReadonlyMap<string, readonly string[]>, subjects: ReadonlyMap<string, string>, code: ReadonlySet<string>, tips: IndexTips) {
    const ids = [...parents.keys()];
    const num = new Map<string, number>();
    ids.forEach((id, i) => num.set(id, i));
    this.ids = ids;
    this.num = num;
    this.parentNums = ids.map((id) => Int32Array.from((parents.get(id) ?? []).map((p) => num.get(p) ?? -1).filter((x) => x >= 0)));
    this.subjects = subjects;
    this.code = code;
    this.pos = this.topo();
    this.released = this.reach(tips.fromRelease);
    this.landed = this.reach(tips.fromDefault);
    this.built = this.reach(tips.fromBranch);
  }

  /** Positions with every parent before its child (iterative DFS post-order). */
  private topo(): Int32Array {
    const n = this.ids.length;
    const pos = new Int32Array(n).fill(-1);
    const state = new Uint8Array(n);
    let next = 0;
    for (let s = 0; s < n; s += 1) {
      if (state[s] !== 0) continue;
      const stack: number[] = [s];
      const iter: number[] = [0];
      state[s] = 1;
      while (stack.length > 0) {
        const v = stack[stack.length - 1]!;
        const ps = this.parentNums[v]!;
        const k = iter[iter.length - 1]!;
        if (k < ps.length) {
          iter[iter.length - 1] = k + 1;
          const p = ps[k]!;
          if (state[p] === 0) {
            state[p] = 1;
            stack.push(p);
            iter.push(0);
          }
        } else {
          stack.pop();
          iter.pop();
          state[v] = 2;
          pos[v] = next++;
        }
      }
    }
    return pos;
  }

  private reach(tips: readonly string[]): Uint8Array {
    const seen = new Uint8Array(this.ids.length);
    const queue: number[] = [];
    for (const t of tips) {
      const i = this.num.get(t);
      if (i !== undefined && seen[i] === 0) { seen[i] = 1; queue.push(i); }
    }
    for (let q = 0; q < queue.length; q += 1) {
      for (const p of this.parentNums[queue[q]!]!) {
        if (seen[p] === 0) { seen[p] = 1; queue.push(p); }
      }
    }
    return seen;
  }

  stateOf(sha: string): GitState {
    const i = this.num.get(sha);
    if (i === undefined) return "none";
    if (this.released[i] === 1) return "released";
    if (this.landed[i] === 1) return "landed";
    if (this.built[i] === 1) return "built";
    return "none";
  }

  touchesCode(sha: string): boolean {
    return this.code.has(sha);
  }

  /** Every ancestor of b (b included), as a bitset; the cache memoises it per (graph key, b). */
  ancestorsOf(b: number): Uint8Array {
    const seen = new Uint8Array(this.ids.length);
    seen[b] = 1;
    const queue = [b];
    for (let q = 0; q < queue.length; q += 1) {
      for (const p of this.parentNums[queue[q]!]!) {
        if (seen[p] === 0) { seen[p] = 1; queue.push(p); }
      }
    }
    return seen;
  }

  /** A byte estimate of the tables, for the cache cap. */
  byteEstimate(): number {
    let n = this.ids.length * (40 + 8 + 4 + 3 + 16);
    for (const p of this.parentNums) n += p.byteLength + 16;
    for (const s of this.subjects.values()) n += s.length * 2 + 16;
    n += this.code.size * 48;
    return n;
  }
}
