/**
 * ISS-958: fault injection for state.json publication, shared by the
 * consumer-side suites.
 *
 * A suite installs it with
 *
 *   vi.mock("node:fs", async () => {
 *     const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
 *     const { wrapFs } = await import("./_state-write-fault.js");
 *     return wrapFs(actual);
 *   });
 *
 * and then arms one fault at a time. This module deliberately imports nothing
 * from src: it is loaded from inside the node:fs mock factory, and importing
 * a module that itself imports node:fs from there would recurse into the
 * factory. The caller passes the error constructor and the reader instead.
 *
 * Two faults, both keyed on renames whose TARGET is a session state.json:
 *
 *   - undurable: the real rename runs, then the hook throws the error the
 *     caller builds from the state now on disk. That is exactly the
 *     published-but-undurable outcome: every reader sees the new state, and
 *     the writer reports a typed error. The ordinary writer rethrows the
 *     error object unchanged, so the typed error reaches the caller as is.
 *   - fail: the hook throws a plain Error BEFORE the rename, so nothing is
 *     published.
 */
import type * as fs from "node:fs";

type Rename = (from: fs.PathLike, to: fs.PathLike) => void;

interface Fault {
  readonly kind: "undurable" | "fail";
  /** 1-based: which matching rename fires. */
  readonly nth: number;
  readonly match: (to: string) => boolean;
  readonly onAfter?: (to: string) => never;
  seen: number;
  fired: boolean;
}

let armed: Fault | null = null;

function isStateTarget(to: string): boolean {
  return /[\\/]state\.json$/.test(to);
}

export function wrapFs<T extends typeof fs>(actual: T): T {
  const realRename = actual.renameSync as Rename;
  const renameSync: Rename = (from, to) => {
    const target = String(to);
    const f = armed;
    if (!f || f.fired || !f.match(target)) {
      realRename(from, to);
      return;
    }
    f.seen += 1;
    if (f.seen !== f.nth) {
      realRename(from, to);
      return;
    }
    f.fired = true;
    if (f.kind === "fail") {
      throw Object.assign(new Error(`EIO: injected rename failure for ${target}`), { code: "EIO" });
    }
    realRename(from, to);
    f.onAfter!(target);
  };
  return { ...actual, renameSync } as T;
}

export interface ArmOptions {
  /** Which matching state.json rename fires (1-based). Default 1. */
  readonly nth?: number;
  /** Restrict to one session directory. Default: any state.json. */
  readonly dir?: string;
}

function matcher(opts: ArmOptions): (to: string) => boolean {
  if (!opts.dir) return isStateTarget;
  const dir = opts.dir.replace(/[\\/]+$/, "");
  return (to) => isStateTarget(to) && to.slice(0, -"/state.json".length) === dir;
}

/**
 * Publish the matching state.json, then throw `make(readPublished(dir))`.
 * `readPublished` receives the session directory that was just written.
 */
export function armUndurable(
  make: (published: unknown) => Error,
  readPublished: (dir: string) => unknown,
  opts: ArmOptions = {},
): void {
  armed = {
    kind: "undurable",
    nth: opts.nth ?? 1,
    match: matcher(opts),
    onAfter: (to) => {
      throw make(readPublished(to.slice(0, -"/state.json".length)));
    },
    seen: 0,
    fired: false,
  };
}

/** Throw a plain EIO before the matching rename; nothing is published. */
export function armFail(opts: ArmOptions = {}): void {
  armed = { kind: "fail", nth: opts.nth ?? 1, match: matcher(opts), seen: 0, fired: false };
}

/** True once the armed fault has fired. */
export function faultFired(): boolean {
  return armed?.fired ?? false;
}

export function disarm(): void {
  armed = null;
}
