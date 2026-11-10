/**
 * ISS-1486 G4: a verified pilot for tests. readPilot recomputes the verdict from the evidence, so the pilot is a real
 * one (test/fixtures/continuity-pilot), relabelled for the experiment and arm a test wants: the facts file names them,
 * so it is rewritten and its hash in pilot.json replaced. Every other evidence file is copied byte for byte.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PILOT_EVIDENCE, PILOT_FILE } from "../../scripts/continuity-lib.js";

export const PILOT_TEMPLATE = resolve(__dirname, "../fixtures/continuity-pilot");

const sha256 = (t: string): string => createHash("sha256").update(t).digest("hex");

/** The template's run id, which readPilot returns for a pilot written by writeVerifiedPilot. */
export const PILOT_TEMPLATE_ID = (JSON.parse(readFileSync(join(PILOT_TEMPLATE, PILOT_FILE), "utf-8")) as { id: string }).id;

export function writeVerifiedPilot(expDir: string, experiment: string, arm: number, over: Record<string, unknown> = {}): void {
  mkdirSync(expDir, { recursive: true });
  const pilot = JSON.parse(readFileSync(join(PILOT_TEMPLATE, PILOT_FILE), "utf-8")) as Record<string, unknown> & { evidence: Record<string, string> };
  for (const f of PILOT_EVIDENCE) {
    if (f === "pilot.facts.json") {
      const facts = JSON.parse(readFileSync(join(PILOT_TEMPLATE, f), "utf-8")) as Record<string, unknown>;
      const text = JSON.stringify({ ...facts, experimentHash: experiment, arm }, null, 2);
      writeFileSync(join(expDir, f), text);
      pilot.evidence[f] = sha256(text);
    } else copyFileSync(join(PILOT_TEMPLATE, f), join(expDir, f));
  }
  writeFileSync(join(expDir, PILOT_FILE), JSON.stringify({ ...pilot, experimentHash: experiment, arm, ...over }, null, 2));
}
