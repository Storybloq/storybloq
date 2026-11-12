// ISS-1497: the continuity runner keeps a work folder when an attempt or pilot does not end clean, and names it in
// the raw dir. A test's after hook removes those too, so a row that proves the keep leaves nothing behind.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { RETAINED_WORKDIR_FILE } from "../../scripts/continuity-run.js";

/** Removes every work folder a runner kept under the given roots; only continuity work folders are touched. */
export function removeKeptWorkdirs(roots: readonly string[]): void {
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === RETAINED_WORKDIR_FILE) {
        try {
          const kept = (JSON.parse(readFileSync(p, "utf-8")) as { path?: unknown }).path;
          if (typeof kept === "string" && /^continuity-(pilot-)?work-/.test(basename(kept))) rmSync(kept, { recursive: true, force: true });
        } catch { /* best effort */ }
      }
    }
  };
  for (const r of roots) walk(r);
}
