/**
 * Is THIS RUNNING PROCESS stale relative to the build on disk? (ISS-906)
 *
 * When the running MCP server predates the on-disk CLI build, session
 * operations fail with messages that describe the wrong problem -- "session
 * not found" for a session that exists -- and that diagnosis substitution has
 * cost real time in at least three recorded incidents (N-097 operator 4: "this
 * failure mode has now cost two sessions real time in this repo alone").
 *
 * The comparison is SERVER-RELATIVE by ruling: the fingerprint is captured
 * once at process startup and compared against the disk at error time. The
 * session-relative probe (`probeBinaryFresh` in health-model.ts) cannot serve
 * here because it needs `state.binaryFingerprint`, which is unavailable on
 * exactly the paths this module annotates -- a missing session has no bytes at
 * all. And server-relative is the honest form of the question anyway: the
 * remedy line says "restart the client", which is about this process, not
 * about whichever binary wrote some session file.
 *
 * The note fires ONLY when staleness is POSITIVELY established: startup
 * fingerprint captured, disk fingerprint computable, hashes differ. Null on
 * either side -- the capture never ran (CLI processes do not call it), or
 * `computeBinaryFingerprint` could not resolve a binary (it returns null under
 * vitest, resolving against src/) -- yields silence, never a guessed warning.
 */
import { computeBinaryFingerprint } from "./liveness.js";

let startupFingerprint: { sha256: string } | null | undefined;

/** Test seam for the disk side; production always goes through liveness. */
let diskProbe: (() => { sha256: string } | null) | null = null;

/**
 * Capture the running binary's fingerprint. Called once from MCP server init;
 * deliberately NOT called by CLI entry points -- a CLI process was just
 * spawned from disk, so it cannot be stale relative to it, and an uncaptured
 * process never emits the note.
 */
export function captureStartupFingerprint(): void {
  if (startupFingerprint === undefined) {
    startupFingerprint = computeBinaryFingerprint();
  }
}

/**
 * The one appended sentence, or null when staleness is not established.
 * Wording per the ISS-906 ruling; kept in one place so every surface says
 * the same thing.
 */
export function describeBinaryStaleness(): string | null {
  if (startupFingerprint == null) return null;
  const disk = (diskProbe ?? computeBinaryFingerprint)();
  if (!disk) return null;
  if (disk.sha256 === startupFingerprint.sha256) return null;
  return "Server binary is stale (fingerprint mismatch); restart the client.";
}

/**
 * Compose a base error message with the staleness note. STRICTLY ADDITIVE on
 * whatever message scheme the caller owns (ISS-897's branch texts are never
 * replaced or rewritten); when staleness is not established the base returns
 * byte-identical.
 */
export function withStalenessNote(base: string): string {
  const note = describeBinaryStaleness();
  return note ? `${base} ${note}` : base;
}

// Test-only. Not part of the public API.
export const __testing = {
  setStartupFingerprint(fp: { sha256: string } | null | undefined): void {
    startupFingerprint = fp;
  },
  setDiskProbe(fn: (() => { sha256: string } | null) | null): void {
    diskProbe = fn;
  },
  reset(): void {
    startupFingerprint = undefined;
    diskProbe = null;
  },
};
