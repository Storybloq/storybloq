#!/usr/bin/env tsx
/**
 * Materialises the continuity fixture for the Mac app's decisions integration
 * test (T-528): the core, the arm-3 overlay (capabilities and glossary) and the
 * lifecycle overlay (R4, proposed against R1), into an empty directory. The
 * fixture itself is never written to.
 *
 * Usage:
 *   tsx scripts/materialize-continuity.ts <empty-or-absent-dir>
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./continuity-lib.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTINUITY = join(pkgRoot, "test", "fixtures", "continuity");

export function materializeDecisionsLedger(dest: string): void {
  if (existsSync(dest) && readdirSync(dest).length > 0) throw new Error(`refusing to materialise into a non-empty directory: ${dest}`);
  materialize(CONTINUITY, 3, "T-2.a", dest);
  cpSync(join(CONTINUITY, "overlays", "lifecycle", ".story"), join(dest, ".story"), { recursive: true });
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  const dest = process.argv[2];
  if (!dest || process.argv.length > 3) {
    process.stderr.write("usage: tsx scripts/materialize-continuity.ts <empty-or-absent-dir>\n");
    process.exit(2);
  }
  materializeDecisionsLedger(resolve(dest));
  process.stderr.write(`materialised ${resolve(dest)}\n`);
}
