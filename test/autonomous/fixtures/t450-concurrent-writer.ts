/**
 * A REAL second process for the ISS-954 cross-process regressions.
 *
 * The race lives between the descriptor write and the path-resolving publish
 * (`link` / `rename`), so it cannot be staged from one process: the whole
 * question is what happens when another OS process manipulates the temp
 * namespace inside that window.
 *
 * BOTH writers park, and that is the point. An earlier version parked one and
 * let the other RUN TO COMPLETION, which does fail on the old shared name, but
 * for the wrong reason: completing also unlinks the shared temp, so the parked
 * writer hit ENOENT instead of publishing the other's inode. To reproduce the
 * actual steal, a writer must stop with its temp WRITTEN AND FSYNCED but NOT
 * PUBLISHED, because that is the only instant at which the shared name resolves
 * to its inode while another writer is still committed to publishing through it.
 *
 * MODES: `create` claims the canonical; `supersede` archives the canonical and
 * then replaces it. Before ISS-954 both derived their temp from the CANONICAL
 * pathname, so a create and an archive write collided on one name even though
 * their targets differ. That is the different-target case.
 *
 * argv: <sessionDir> <mode> <resultName>
 * env:  INTENT (JSON), PARK_SEAM, PARK_SIGNAL, PARK_GO
 */
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createCancellationIntent,
  supersedeCancellationIntent,
  __intentTesting,
} from "../../../src/autonomous/candidate-recovery.js";

const [, , sessDir, mode, resultName] = process.argv;
const seam = process.env.PARK_SEAM;
const signal = process.env.PARK_SIGNAL;
const go = process.env.PARK_GO;

/** Sleep without a busy spin: a timed wait on a lock nobody will ever notify. */
function nap(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (seam && signal && go) {
  __intentTesting.at = (point: string): void => {
    if (point !== seam) return;
    writeFileSync(join(sessDir, signal), "1");
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(sessDir, go)) && Date.now() < deadline) nap(20);
  };
}

let payload: string;
try {
  const intent = JSON.parse(process.env.INTENT ?? "{}");
  const result = mode === "supersede"
    ? supersedeCancellationIntent(sessDir, intent)
    : createCancellationIntent(sessDir, intent);
  payload = JSON.stringify(result);
} catch (err) {
  payload = JSON.stringify({ ok: false, reason: "threw", detail: String(err) });
}
writeFileSync(join(sessDir, resultName), payload);
