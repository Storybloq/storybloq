/** A well-formed v 1 receipt, for the receipt tests (C-v4.1 section 3). */
export const SHA = "a".repeat(40);
export const BOARD = "b-0123456789abcdef";

export function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rc-0123456789abcdef",
    v: 1,
    kind: "test",
    target: `${BOARD}:T-001`,
    repo: BOARD,
    sha: SHA,
    revisions: { unit: "r1" },
    observation: { head: SHA, headMatchesSha: true, worktree: "clean" },
    attestation: { builtFromSha: SHA, builtClean: true },
    result: "pass",
    data: { passed: 10, failed: 0, skipped: 1, durationMs: 1200 },
    recordedAt: "2026-02-02T02:02:02.000Z",
    recordedBy: "task-1",
    ...over,
  };
}

