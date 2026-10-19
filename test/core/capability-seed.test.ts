/**
 * ISS-1300: the repository's own capability inventory, loaded through the real
 * catalog loader and checked structurally, so the shipped file is exercised by
 * the suite (the T-523 seed test that never landed).
 *
 * The inventory lives above `storybloq/`, in the workspace's `.story/`, and is
 * read from there, as t-282 reads `macos/`. The public projection carries
 * `storybloq/` only, so this file fails there; a skip on absence would also
 * pass when the inventory is deleted here, which is the failure it exists for.
 *
 * Freshness is skipped: it compares against HEAD, and any unrelated commit
 * touching an entry point would turn the suite red. Validity is pinned, never
 * content, so an honest edit to the inventory needs no test change.
 *
 * Nothing here writes to the repository. `loadProject` can (with a transaction
 * journal present it takes the project lock and runs recovery), so it runs on a
 * temporary copy of the ledger, and the test asserts afterwards that the real
 * journal and lock files are as they were.
 */

import { describe, it, expect, afterAll } from "vitest";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityCatalog } from "../../src/cli/commands/capability.js";
import { catalogConflictScope } from "../../src/core/catalog-conflicts.js";
import { checkCapabilities } from "../../src/core/capability.js";
import { loadProject } from "../../src/core/project-loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");
const LEDGER = join(REPO, ".story");

/** What loadProject must never touch on the real ledger: the journal and every lock. */
function isWriteState(name: string): boolean {
  return name === ".txn.json" || name.startsWith(".lock") || name.endsWith(".lock");
}
/**
 * What loadProject reads: the two singletons and the four record folders. It only
 * lists handovers (absent reads as none), and checkCapabilities reads tickets and
 * issues alone. Copying the whole ledger took 30.1 s of a 40.2 s run at suite start,
 * from file-system contention, against about 1 s alone.
 */
const COPIED: readonly string[] = ["config.json", "roadmap.json", "tickets", "issues", "notes", "lessons"];

function writeStateOf(dir: string): string[] {
  return readdirSync(dir).filter(isWriteState).sort();
}

function jsonCount(dir: string): number {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
}

const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** The ledger inputs loadProject reads, copied away from the real checkout. */
function ledgerCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "capability-seed-"));
  temps.push(root);
  for (const name of COPIED) {
    if (!existsSync(join(LEDGER, name))) continue;
    cpSync(join(LEDGER, name), join(root, ".story", name), {
      recursive: true,
      filter: (src) => !isWriteState(basename(src)),
    });
  }
  return root;
}

describe("the repository's own capability inventory (ISS-1300)", () => {
  it("loads through the catalog loader, present and not empty, with no open conflict", () => {
    const { doc, present } = capabilityCatalog.load(REPO);
    expect(present).toBe(true);
    expect(doc.capabilities.length).toBeGreaterThan(0);
    expect(catalogConflictScope(doc, doc.capabilities.map((e) => e.id)).total).toBe(0);
  });

  it("records every checkpoint as a full 40-hex sha", () => {
    const { doc } = capabilityCatalog.load(REPO);
    const short = doc.capabilities.filter((e) => !/^[0-9a-f]{40}$/.test(e.checkedAt.sha)).map((e) => e.id);
    expect(short).toEqual([]);
  });

  it("passes the structural check against the real ledger and reference registry, with no git call", async () => {
    const before = writeStateOf(LEDGER);
    const { doc } = capabilityCatalog.load(REPO);
    const copy = ledgerCopy();
    for (const dir of ["tickets", "issues"]) {
      expect(jsonCount(join(copy, ".story", dir))).toBe(jsonCount(join(LEDGER, dir)));
    }
    const { state } = await loadProject(copy);
    expect(state.tickets.length).toBe(jsonCount(join(LEDGER, "tickets")));
    expect(state.issues.length).toBe(jsonCount(join(LEDGER, "issues")));
    const report = await checkCapabilities(REPO, doc.capabilities, state, { skipFreshness: true });
    expect(report.gitCalls).toBe(0);
    expect(report.head).toBeNull();
    const findings = Object.fromEntries(
      report.entries.filter((e) => e.results.length > 0).map((e) => [e.id, e.results.map((r) => r.code)]),
    );
    expect(findings).toEqual({});
    expect(report.entries.map((e) => e.id)).toEqual(doc.capabilities.map((e) => e.id));
    expect(writeStateOf(LEDGER)).toEqual(before);
    expect(existsSync(join(LEDGER, ".txn.json"))).toBe(before.includes(".txn.json"));
  }, 30_000);
});
