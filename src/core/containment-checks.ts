/**
 * The one statement of what has to be true of a directory name before anyone
 * opens it (ISS-897).
 *
 * Its own module because the sentence is needed on both sides of an import
 * edge. `session-guard.ts` imports `session-scan.ts`, so a constant defined in
 * the guard cannot reach the scanner, and the scanner emits a diagnostic
 * `reason` that ends in exactly this instruction. The alternative was a second
 * hand-maintained copy, and the whole reason this constant exists is that the
 * copies drifted: the guard's said "no NUL" and the scanner's did not, on the
 * two workflows that end with an operator opening a path.
 *
 * The exclusions carry the weight, not the word "basename". `.` IS a basename,
 * and it resolves. A NUL cannot appear in a filename on any supported
 * filesystem, which is exactly why it is worth excluding here: these values
 * arrive from a caller-supplied payload at a typed seam, not from a directory
 * listing, so one that contains a NUL never came from the filesystem and must
 * be rejected before it reaches a filesystem API that would only throw.
 *
 * Correlation is not validation. Both halves of a diagnostic come out of ONE
 * scan result, so their agreement establishes that the payload is
 * self-consistent and nothing about whether either value names a contained
 * directory. That is what these checks are for, and passing them licenses
 * INSPECTION only -- nothing here establishes which copy of anything is stale.
 */
export const CONTAINMENT_CHECKS =
  "each must be a single directory basename (no path separators, not `.` or `..`, no NUL), it must resolve beneath the canonical " +
  "`.story/sessions` root without escaping it by symlink, and the record on disk must still carry the `sessionId` it was correlated on";
