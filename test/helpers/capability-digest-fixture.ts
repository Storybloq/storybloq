/**
 * ISS-1283: the catalog behind the committed list capture in
 * test/fixtures/capability-digest/. The capture was taken from the BASE source
 * (before the digest existed) with this exact builder, so the comparison test
 * proves the unbounded list did not change, rather than comparing the new code
 * with itself. Edit this file and the capture stops meaning anything: retake
 * it from the base commit instead.
 *
 * It holds one entry of each kind the list renders differently: current, stored
 * review, pending, a dangling item reference and a missing entry point. The
 * capture runs with skipCheck, so no HEAD sha reaches the output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHECKPOINT = { sha: "0123456789abcdef0123456789abcdef01234567", date: "2026-10-18" };

export const D0_CATALOG = {
  version: 1,
  capabilities: [
    { id: "cap-alpha", name: "Alpha", summary: "Current and clean.", entryPoints: ["src/core/a.ts"], contract: "Alpha holds.", checkedAt: CHECKPOINT, status: "current" },
    { id: "cap-beta", name: "Beta", summary: "Stored review.", entryPoints: ["src/core/b.ts"], contract: "Beta holds.", checkedAt: CHECKPOINT, status: "review" },
    { id: "cap-gamma", name: "Gamma", summary: "Deferred work.", entryPoints: ["src/core/a.ts"], contract: "Gamma holds.", checkedAt: CHECKPOINT, status: "current", pendingNote: "owe a regression test" },
    { id: "cap-delta", name: "Delta", summary: "Dangling item.", entryPoints: ["src/core/b.ts"], contract: "Delta holds.", items: ["T-999"], checkedAt: CHECKPOINT, status: "current" },
    { id: "cap-eps", name: "Epsilon", summary: "Missing entry point.", entryPoints: ["src/core/missing.ts"], contract: "Epsilon holds.", checkedAt: CHECKPOINT, status: "current" },
  ],
};

/** Writes the source files and the catalog into an initialised project root. */
export function writeD0Fixture(root: string): void {
  mkdirSync(join(root, "src", "core"), { recursive: true });
  writeFileSync(join(root, "src", "core", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "core", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(root, ".story", "capabilities.json"), JSON.stringify(D0_CATALOG, null, 2) + "\n");
}
