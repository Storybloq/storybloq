/**
 * T-255 Lens gate — verification procedure tests.
 *
 * Test matrix documented in
 * `.story/sessions/<id>/plan.md` (33 numbered cases + helper-extraction
 * smoke test). Tests are ordered roughly by the reason code they exercise
 * and reuse a shared fixture helper built on top of the T-254 snapshot
 * writer.
 *
 * Every test asserts ONE behavior so failures point to a single step of
 * the 7-step procedure.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  statSync,
  symlinkSync,
  unlinkSync,
  chmodSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, platform } from "node:os";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  writeReviewSnapshot,
  verifyLensFinding,
  normalizeForVerification,
  VERIFY_RECOVERY_WINDOW,
  SnapshotIntegrityError,
  type SnapshotContext,
  type VerifyReasonCode,
  type VerifyResult,
  type VerifyPass,
} from "../../../src/autonomous/review-lenses/index.js";
import {
  _assertValidManifestPath,
  _assertNoSymlinkAncestors,
} from "../../../src/autonomous/review-lenses/review-snapshot.js";
import type { LensFinding } from "../../../src/autonomous/review-lenses/types.js";

// ── Constants ───────────────────────────────────────────────────────

const SESSION_ID = "22222222-3333-4444-5555-666666666666";
const IS_WIN = platform() === "win32";

// Shared Set used by test 31 to confirm every VerifyReasonCode is
// produced by at least one other test in the matrix.
const coveredReasons = new Set<VerifyReasonCode>();

// ── Fixture state ───────────────────────────────────────────────────

let projectRoot: string;
let scratchDir: string;

function seedFile(rel: string, contents: string | Buffer): string {
  const full = join(projectRoot, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return rel;
}

function chmodRecursive(dir: string, mode: number): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    try {
      chmodSync(p, mode);
    } catch {
      /* symlinks / etc. */
    }
    if (entry.isDirectory()) chmodRecursive(p, mode);
  }
}

/**
 * Layout source files under `projectRoot`, call `writeReviewSnapshot`,
 * and return a SnapshotContext usable by verifyLensFinding plus the
 * resolved snapshot directory.
 */
function writeFixtureSnapshot(
  files: Record<string, string>,
  opts: {
    stage?: "plan-review" | "code-review";
    round?: number;
  } = {},
): {
  ctx: SnapshotContext;
  snapshotDir: string;
  manifestSha256: string;
} {
  for (const [path, body] of Object.entries(files)) {
    seedFile(path, body);
  }
  const stage = opts.stage ?? "code-review";
  const round = opts.round ?? 1;
  const reviewId = `${stage}-r${round}`;
  const res = writeReviewSnapshot({
    projectRoot,
    sessionId: SESSION_ID,
    reviewId,
    stage,
    round,
    files: Object.keys(files),
  });
  return {
    ctx: {
      projectRoot,
      sessionId: SESSION_ID,
      reviewId,
      expectedManifestSha256: res.manifestSha256,
    },
    snapshotDir: res.snapshotDir,
    manifestSha256: res.manifestSha256,
  };
}

/**
 * Build a minimal-valid `LensFinding` with the supplied `evidence` array.
 * All other fields match the shape enforced by T-253's Zod schema so the
 * gate is only exercising verification logic, not schema validation.
 */
function makeFinding(
  evidence: ReadonlyArray<{
    file: string;
    startLine: number;
    endLine: number;
    code: string;
  }>,
): LensFinding {
  return {
    lens: "test-lens",
    lensVersion: "test-lens-v1",
    severity: "major",
    recommendedImpact: "needs-revision",
    category: "test-category",
    description: "test finding",
    file: evidence[0]?.file ?? null,
    line: evidence[0]?.startLine ?? null,
    evidence: evidence as unknown as LensFinding["evidence"],
    suggestedFix: null,
    confidence: 0.9,
    assumptions: null,
    requiresMoreContext: false,
  } as LensFinding;
}

function expectFail(result: VerifyResult): asserts result is Extract<
  VerifyResult,
  { pass: false }
> {
  expect(result.pass).toBe(false);
}

function expectPass(result: VerifyResult): asserts result is VerifyPass {
  expect(result.pass).toBe(true);
}

function recordReason(r: VerifyReasonCode): void {
  coveredReasons.add(r);
}

// ── Setup / teardown ────────────────────────────────────────────────

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "verification-test-"));
  scratchDir = mkdtempSync(join(tmpdir(), "verification-scratch-"));
  mkdirSync(join(projectRoot, ".story", "sessions", SESSION_ID), {
    recursive: true,
  });
});

afterEach(() => {
  // Writer chmods payloads to 0o444 — restore before rm.
  try {
    chmodRecursive(projectRoot, 0o755);
  } catch {
    /* ignore */
  }
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

afterAll(() => {
  // Referenced by test 31.
  void coveredReasons;
});

// ─── 1–4  Happy path + outer loop ─────────────────────────────────

describe("verifyLensFinding — happy path and outer loop", () => {
  it("1. valid single-site finding passes", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "line1\nconst SECRET = 42;\nline3\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 2,
        endLine: 2,
        code: "const SECRET = 42;",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence).toHaveLength(1);
    expect(result.verifiedEvidence[0]).toMatchObject({
      file: "src/a.ts",
      startLine: 2,
      endLine: 2,
      matchedStartLine: 2,
      matchedEndLine: 2,
    });
  });

  it("2. valid multi-site finding passes", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "alpha\nconst A = 1;\nomega\n",
      "src/b.ts": "prefix\nprefix\nconst B = 2;\npostfix\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 2, endLine: 2, code: "const A = 1;" },
      { file: "src/b.ts", startLine: 3, endLine: 3, code: "const B = 2;" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence).toHaveLength(2);
    expect(result.verifiedEvidence[0].file).toBe("src/a.ts");
    expect(result.verifiedEvidence[1].file).toBe("src/b.ts");
  });

  it("3. multi-site short-circuits on first failure with failedEvidenceIndex", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "line1\nconst A = 1;\nline3\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 2, endLine: 2, code: "const A = 1;" },
      {
        file: "src/does-not-exist.ts",
        startLine: 1,
        endLine: 1,
        code: "anything",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("file_not_snapshotted");
    expect(result.failedEvidenceIndex).toBe(1);
    recordReason(result.reasonCode);
  });

  it("4. no_evidence gate returns failedEvidenceIndex: -1", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "const A = 1;\n",
    });
    const finding = makeFinding([]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("no_evidence");
    expect(result.failedEvidenceIndex).toBe(-1);
    recordReason(result.reasonCode);
  });
});

// ─── 5, 5a, 5b, 6, 7  invalid_path ───────────────────────────────

describe("verifyLensFinding — invalid_path", () => {
  it("5. posix absolute path rejected", () => {
    const { ctx } = writeFixtureSnapshot({ "src/a.ts": "hello\n" });
    const finding = makeFinding([
      { file: "/etc/passwd", startLine: 1, endLine: 1, code: "root" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("invalid_path");
    recordReason(result.reasonCode);
  });

  it("5a. win32 drive-qualified forward-slash path rejected", () => {
    const { ctx } = writeFixtureSnapshot({ "src/a.ts": "hello\n" });
    const finding = makeFinding([
      { file: "C:/repo/file.ts", startLine: 1, endLine: 1, code: "x" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("invalid_path");
  });

  it("5b. win32 absolute backslash path rejected", () => {
    const { ctx } = writeFixtureSnapshot({ "src/a.ts": "hello\n" });
    const finding = makeFinding([
      { file: "C:\\repo\\file.ts", startLine: 1, endLine: 1, code: "x" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("invalid_path");
  });

  it("6. dotdot path rejected", () => {
    const { ctx } = writeFixtureSnapshot({ "src/a.ts": "hello\n" });
    const finding = makeFinding([
      { file: "../outside.ts", startLine: 1, endLine: 1, code: "x" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("invalid_path");
  });

  it("7. backslash (non-drive) path rejected", () => {
    const { ctx } = writeFixtureSnapshot({ "src/a.ts": "hello\n" });
    const finding = makeFinding([
      { file: "src\\foo.ts", startLine: 1, endLine: 1, code: "x" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("invalid_path");
  });
});

// ─── 8  SnapshotIntegrityError — payload_symlink (use-time) ──────

describe("verifyLensFinding — payload_symlink integrity error", () => {
  it.skipIf(IS_WIN)(
    "8. SnapshotIntegrityError thrown when payload is replaced with a symlink after writer finalization",
    () => {
      const { ctx, snapshotDir } = writeFixtureSnapshot({
        "src/a.ts": "const A = 1;\n",
        "src/b.ts": "const B = 2;\n",
      });
      const storedA = join(snapshotDir, "src", "a.ts");
      // Writer chmods payloads to 0o444; restore write perm on parent + file.
      chmodSync(dirname(storedA), 0o755);
      chmodSync(storedA, 0o644);
      unlinkSync(storedA);
      // Plant a symlink to a sibling file (b.ts) so readFileSync would
      // "succeed" if followed — the gate must throw on the lstat check.
      symlinkSync(join(snapshotDir, "src", "b.ts"), storedA);

      const finding = makeFinding([
        { file: "src/a.ts", startLine: 1, endLine: 1, code: "const A = 1;" },
      ]);
      let thrown: unknown;
      try {
        verifyLensFinding(finding, ctx);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SnapshotIntegrityError);
      expect((thrown as SnapshotIntegrityError).code).toBe("payload_symlink");
    },
  );
});

// ─── 9  file_not_snapshotted ──────────────────────────────────────

describe("verifyLensFinding — file_not_snapshotted", () => {
  it("9. evidence references file absent from manifest", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "const A = 1;\n",
    });
    const finding = makeFinding([
      {
        file: "src/not-in-manifest.ts",
        startLine: 1,
        endLine: 1,
        code: "anything",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("file_not_snapshotted");
    recordReason(result.reasonCode);
  });
});

// ─── 10  snapshot_corrupt — missing payload ──────────────────────

describe("verifyLensFinding — snapshot_corrupt", () => {
  it.skipIf(IS_WIN)(
    "10. payload missing (unlinked after writer) returns fail(snapshot_corrupt)",
    () => {
      const { ctx, snapshotDir } = writeFixtureSnapshot({
        "src/a.ts": "const A = 1;\n",
      });
      const storedA = join(snapshotDir, "src", "a.ts");
      chmodSync(dirname(storedA), 0o755);
      chmodSync(storedA, 0o644);
      unlinkSync(storedA);

      const finding = makeFinding([
        { file: "src/a.ts", startLine: 1, endLine: 1, code: "const A = 1;" },
      ]);
      const result = verifyLensFinding(finding, ctx);
      expectFail(result);
      expect(result.reasonCode).toBe("snapshot_corrupt");
      recordReason(result.reasonCode);
    },
  );
});

// ─── 11  SnapshotIntegrityError — snapshot_tampered (byte substitution) ─

describe("verifyLensFinding — snapshot_tampered integrity error", () => {
  it.skipIf(IS_WIN)(
    "11. byte-level substitution caught by sha256 check (finding-1 regression guard)",
    () => {
      const { ctx, snapshotDir } = writeFixtureSnapshot({
        "src/a.ts": "const A = 1;\n",
      });
      const storedA = join(snapshotDir, "src", "a.ts");
      chmodSync(dirname(storedA), 0o755);
      chmodSync(storedA, 0o644);
      // Overwrite with different bytes that are still valid source — same
      // byte length (16 chars) so a length-only check would miss the tamper.
      writeFileSync(storedA, "const A = 99;\n\n");
      chmodSync(storedA, 0o444);

      const finding = makeFinding([
        { file: "src/a.ts", startLine: 1, endLine: 1, code: "const A = 1;" },
      ]);
      let thrown: unknown;
      try {
        verifyLensFinding(finding, ctx);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SnapshotIntegrityError);
      expect((thrown as SnapshotIntegrityError).code).toBe("snapshot_tampered");
    },
  );
});

// ─── 11a  SnapshotIntegrityError — manifest_load_failed (bad digest) ─

describe("verifyLensFinding — manifest_load_failed integrity error", () => {
  it("11a. bad expectedManifestSha256 throws manifest_load_failed", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "const A = 1;\n",
    });
    // Replace expected digest with something that cannot match the real
    // manifest bytes. The gate MUST throw, not return, because a digest
    // mismatch means the review-time trust anchor has been violated.
    const badCtx: SnapshotContext = {
      ...ctx,
      expectedManifestSha256: "0".repeat(64),
    };
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 1, endLine: 1, code: "const A = 1;" },
    ]);
    let thrown: unknown;
    try {
      verifyLensFinding(finding, badCtx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SnapshotIntegrityError);
    expect((thrown as SnapshotIntegrityError).code).toBe("manifest_load_failed");
  });

  it("11b. corrupted manifest.json bubbles up as manifest_load_failed", () => {
    const { ctx, snapshotDir } = writeFixtureSnapshot({
      "src/a.ts": "const A = 1;\n",
    });
    // Restore write perm on the manifest then truncate to invalid JSON so
    // the T-254 reader throws inside its JSON.parse; verification.ts must
    // wrap the reader throw as manifest_load_failed.
    const manifestPath = join(snapshotDir, "manifest.json");
    chmodSync(snapshotDir, 0o755);
    chmodSync(manifestPath, 0o644);
    writeFileSync(manifestPath, "{ not valid json");
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 1, endLine: 1, code: "const A = 1;" },
    ]);
    // Also clear expectedManifestSha256 so we exercise the reader-throw
    // branch, not the digest-mismatch branch.
    const loaderCtx: SnapshotContext = {
      projectRoot: ctx.projectRoot,
      sessionId: ctx.sessionId,
      reviewId: ctx.reviewId,
    };
    let thrown: unknown;
    try {
      verifyLensFinding(finding, loaderCtx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SnapshotIntegrityError);
    expect((thrown as SnapshotIntegrityError).code).toBe("manifest_load_failed");
  });
});

// ─── 11c  SnapshotIntegrityError — payload_escapes_snapshot ──────
//
// This branch is belt-and-suspenders defensive: by the time the realpath
// containment check runs, `_assertNoSymlinkAncestors` + the leaf
// `lstat().isSymbolicLink()` guard have already rejected every path where
// a segment under `snapshotDir` is a symlink, and hardlinks are
// transparent to realpath. I could not construct a filesystem state that
// reaches the `realResolved` check while passing the prior symlink
// guards, so the functional path is covered by the class-level assertion
// below. If a future bug opens a reachable path, add a writer-boundary
// regression test under T-254 (writer → verify E2E).
describe("verifyLensFinding — payload_escapes_snapshot integrity class", () => {
  it("11c. SnapshotIntegrityError carries payload_escapes_snapshot code", () => {
    const err = new SnapshotIntegrityError(
      "payload_escapes_snapshot",
      "payload realpath /evil/src/a.ts escapes snapshot root /snap",
      "src/a.ts",
    );
    expect(err).toBeInstanceOf(SnapshotIntegrityError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("payload_escapes_snapshot");
    expect(err.file).toBe("src/a.ts");
    expect(err.name).toBe("SnapshotIntegrityError");
    // Grep-once check that the constant still lives in the source so this
    // test fails loudly if the code branch is ever deleted by a refactor
    // that thinks it's dead.
    const verificationSource = readFileSync(
      fileURLToPath(
        new URL(
          "../../../src/autonomous/review-lenses/verification.ts",
          import.meta.url,
        ),
      ),
      "utf-8",
    );
    expect(verificationSource).toContain("payload_escapes_snapshot");
  });
});

// ─── 12–16  line_out_of_range ────────────────────────────────────

describe("verifyLensFinding — line_out_of_range", () => {
  it("12. startLine: 0 is structurally invalid", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "line1\nline2\nline3\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 0, endLine: 1, code: "line1" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("line_out_of_range");
    recordReason(result.reasonCode);
  });

  it("13. endLine < startLine is structurally invalid", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "line1\nline2\nline3\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 3, endLine: 1, code: "line1" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("line_out_of_range");
  });

  it("14. non-integer startLine is structurally invalid", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "line1\nline2\nline3\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 1.5, endLine: 2, code: "line1" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("line_out_of_range");
  });

  it("15. stale startLine > EOF with no quote match anywhere returns line_out_of_range", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "line1\nline2\nline3\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 99,
        endLine: 99,
        code: "not-in-the-file",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("line_out_of_range");
  });

  it("16. stale startLine > EOF rescued by unique quote at a real line", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "line1\nline2-unique-marker\nline3\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 99,
        endLine: 99,
        code: "line2-unique-marker",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence[0].matchedStartLine).toBe(2);
    expect(result.verifiedEvidence[0].matchedEndLine).toBe(2);
  });
});

// ─── 17  quote_mismatch — valid range, no match ──────────────────

describe("verifyLensFinding — quote_mismatch", () => {
  it("17. valid range, no match anywhere in window returns quote_mismatch", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "line1\nline2\nline3\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 1,
        endLine: 1,
        code: "definitely-not-here",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("quote_mismatch");
    recordReason(result.reasonCode);
  });
});

// ─── 18, 19  ambiguous_match ─────────────────────────────────────

describe("verifyLensFinding — ambiguous_match", () => {
  it("18. duplicated quote within window (2 hits) returns ambiguous_match", () => {
    const lines = [
      "const one = 1;",
      "mutex.lock();",
      "doWork();",
      "mutex.unlock();",
      "const two = 2;",
      "mutex.lock();", // second occurrence, line 6
      "doMore();",
      "mutex.unlock();",
    ];
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      // Window [1..12] clamped to [1..8] covers both occurrences.
      { file: "src/a.ts", startLine: 2, endLine: 2, code: "mutex.lock();" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("ambiguous_match");
    expect(result.details.hits).toBeGreaterThanOrEqual(2);
    recordReason(result.reasonCode);
  });

  it("19. ambiguous_match wins over quote_mismatch when multi-hit range is stale", () => {
    // Quote appears twice in the file; startLine exceeds EOF so staleRange
    // triggers whole-file search. ambiguous_match wins at hits.length >= 2.
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "copy()\ncopy()\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 99, endLine: 99, code: "copy()" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("ambiguous_match");
  });
});

// ─── 20, 21, 22  recovery window behaviour ───────────────────────

describe("verifyLensFinding — recovery window", () => {
  it("20. valid quote at line 20 trumps near-drift claim at line 18", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      i === 19 ? "UNIQUE_ANCHOR_TARGET" : `line${i + 1}`,
    );
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 18,
        endLine: 18,
        code: "UNIQUE_ANCHOR_TARGET",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence[0].matchedStartLine).toBe(20);
  });

  it("21. off-by-5 drift passes", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      i === 9 ? "DRIFT_ANCHOR" : `line${i + 1}`,
    );
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 5, endLine: 5, code: "DRIFT_ANCHOR" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence[0].matchedStartLine).toBe(10);
  });

  it("22. off-by-large drift outside ±10 window returns quote_mismatch", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      i === 39 ? "FAR_AWAY_ANCHOR" : `line${i + 1}`,
    );
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      // Window [1-10..5+10] = [1..15] (clamped); line 40 excluded.
      { file: "src/a.ts", startLine: 5, endLine: 5, code: "FAR_AWAY_ANCHOR" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("quote_mismatch");
  });

  it("22a. exact +10 drift passes (inclusive upper boundary)", () => {
    // Claim at line 20, anchor at line 30 → drift = +10. Window
    // [20-10..20+10] = [10..30] inclusive, so line 30 is INSIDE.
    const lines = Array.from({ length: 40 }, (_, i) =>
      i === 29 ? "BOUNDARY_PLUS_TEN" : `line${i + 1}`,
    );
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 20,
        endLine: 20,
        code: "BOUNDARY_PLUS_TEN",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence[0].matchedStartLine).toBe(30);
  });

  it("22b. +11 drift (just outside window) fails with quote_mismatch", () => {
    // Claim at line 20, anchor at line 31 → drift = +11. Window
    // [20-10..20+10] = [10..30] inclusive, so line 31 is OUTSIDE.
    const lines = Array.from({ length: 40 }, (_, i) =>
      i === 30 ? "BOUNDARY_PLUS_ELEVEN" : `line${i + 1}`,
    );
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 20,
        endLine: 20,
        code: "BOUNDARY_PLUS_ELEVEN",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("quote_mismatch");
  });

  it("22c. exact -10 drift passes (inclusive lower boundary)", () => {
    // Claim at line 20, anchor at line 10 → drift = -10. Window
    // [20-10..20+10] = [10..30] inclusive, so line 10 is INSIDE.
    const lines = Array.from({ length: 40 }, (_, i) =>
      i === 9 ? "BOUNDARY_MINUS_TEN" : `line${i + 1}`,
    );
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 20,
        endLine: 20,
        code: "BOUNDARY_MINUS_TEN",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence[0].matchedStartLine).toBe(10);
  });
});

// ─── 23, 24, 25, 26  normalization semantics ─────────────────────

describe("verifyLensFinding — normalization", () => {
  it("23. CRLF file normalized to LF matches LF evidence", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "alpha\r\nconst A = 1;\r\nomega\r\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 2, endLine: 2, code: "const A = 1;" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
  });

  it("24. trailing whitespace stripped by normalizer so evidence matches", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "alpha\nconst A = 1;   \t\nomega\n",
    });
    const finding = makeFinding([
      { file: "src/a.ts", startLine: 2, endLine: 2, code: "const A = 1;" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
  });

  it("25. tab vs 4-space indent is rejected as quote_mismatch (narrowed normalization)", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "function f() {\n\treturn 42;\n}\n",
    });
    const finding = makeFinding([
      // Evidence uses 4-space indent instead of the file's tab indent.
      { file: "src/a.ts", startLine: 2, endLine: 2, code: "    return 42;" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("quote_mismatch");
  });

  it("26. multi-line quote with embedded blank line preserved", () => {
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": "prefix\nif (cond) {\n\n  doIt();\n}\nsuffix\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 2,
        endLine: 5,
        code: "if (cond) {\n\n  doIt();\n}",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence[0].matchedStartLine).toBe(2);
    expect(result.verifiedEvidence[0].matchedEndLine).toBe(5);
  });
});

// ─── 27  real-parallelism concurrency stress ─────────────────────
//
// This test invokes the REAL `verifyLensFinding` inside Node worker
// threads against a shared, immutable snapshot. Because Node workers
// cannot load TypeScript directly, we bundle `verification.ts` (and its
// transitive dependencies under `review-lenses/`) to a standalone ESM
// file via `esbuild.buildSync` in `beforeAll`, write it to a temp path,
// and each worker dynamically imports that bundle and calls
// `verifyLensFinding` on serialized inputs. The compiled bundle lives
// only for the duration of this test file and is unlinked in `afterAll`.

let workerBundlePath: string | undefined;

describe("verifyLensFinding — concurrency", () => {
  beforeAll(async () => {
    if (IS_WIN) return;
    const { buildSync } = await import("esbuild");
    const entry = fileURLToPath(
      new URL(
        "../../../src/autonomous/review-lenses/verification.ts",
        import.meta.url,
      ),
    );
    const result = buildSync({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      logLevel: "silent",
    });
    const output = result.outputFiles?.[0];
    if (!output) throw new Error("esbuild produced no output for verification.ts");
    workerBundlePath = join(
      tmpdir(),
      `verify-worker-bundle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
    );
    writeFileSync(workerBundlePath, output.text);
  });

  afterAll(() => {
    if (workerBundlePath) {
      try {
        unlinkSync(workerBundlePath);
      } catch {
        /* ignore */
      }
      workerBundlePath = undefined;
    }
  });

  it.skipIf(IS_WIN)(
    "27. 4 worker threads × 5 parallel invocations of verifyLensFinding agree",
    async () => {
      if (!workerBundlePath) throw new Error("worker bundle was not built");
      // Shared fixture: single snapshot, same finding verified by all workers.
      const { ctx, snapshotDir } = writeFixtureSnapshot({
        "src/a.ts": "alpha\nconst SHARED = 42;\nomega\n",
      });
      const finding = makeFinding([
        {
          file: "src/a.ts",
          startLine: 2,
          endLine: 2,
          code: "const SHARED = 42;",
        },
      ]);

      // Each worker dynamic-imports the compiled verification bundle and
      // calls the real `verifyLensFinding` 5 times in parallel against the
      // shared ctx. The function is synchronous so Promise.all just queues
      // 5 invocations on the worker's event loop; real OS-level parallelism
      // comes from the 4 workers running in separate threads.
      const workerSource = `
        const { parentPort, workerData } = require("node:worker_threads");
        const { pathToFileURL } = require("node:url");
        (async () => {
          try {
            const mod = await import(pathToFileURL(workerData.bundlePath).href);
            const verifyLensFinding = mod.verifyLensFinding;
            if (typeof verifyLensFinding !== "function") {
              throw new Error("verifyLensFinding not exported from bundle");
            }
            const results = await Promise.all(
              Array.from({ length: 5 }, async () =>
                verifyLensFinding(workerData.finding, workerData.ctx),
              ),
            );
            parentPort.postMessage({
              ok: true,
              count: results.length,
              passes: results.map((r) => r.pass === true),
              matchedStarts: results.map((r) =>
                r.pass === true
                  ? r.verifiedEvidence[0].matchedStartLine
                  : null,
              ),
            });
          } catch (err) {
            parentPort.postMessage({
              ok: false,
              error: String((err && err.message) || err),
            });
          }
        })();
      `;
      const workerData = {
        bundlePath: workerBundlePath,
        finding,
        ctx,
      };
      const workerCount = 4;
      type WorkerReply = {
        ok: boolean;
        count?: number;
        passes?: boolean[];
        matchedStarts?: Array<number | null>;
        error?: string;
      };
      const workers: Promise<WorkerReply>[] = [];
      for (let i = 0; i < workerCount; i++) {
        workers.push(
          new Promise((resolveWorker, rejectWorker) => {
            const w = new Worker(workerSource, {
              eval: true,
              workerData,
            });
            w.once("message", (msg: WorkerReply) => resolveWorker(msg));
            w.once("error", rejectWorker);
            w.once("exit", (code) => {
              if (code !== 0) rejectWorker(new Error(`worker exit ${code}`));
            });
          }),
        );
      }
      const results = await Promise.all(workers);
      expect(results).toHaveLength(workerCount);
      for (const r of results) {
        if (!r.ok) throw new Error(`worker error: ${r.error}`);
        expect(r.count).toBe(5);
        expect(r.passes?.every((p) => p === true)).toBe(true);
        // All 5 invocations inside a worker must have agreed on the
        // matched line (deterministic pass at line 2).
        expect(new Set(r.matchedStarts).size).toBe(1);
        expect(r.matchedStarts?.[0]).toBe(2);
      }
      // Cross-verify: the main-thread gate still produces the same pass
      // against the same snapshot after 20 worker-side invocations.
      const mainResult = verifyLensFinding(finding, ctx);
      expectPass(mainResult);
      expect(mainResult.verifiedEvidence[0].matchedStartLine).toBe(2);
      void snapshotDir;
    },
  );
});

// ─── 28  adversarial distant-span rejection ──────────────────────

describe("verifyLensFinding — adversarial distant-span", () => {
  it("28. quote appearing only far outside the window is rejected", () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      i === 79 ? "ADVERSARIAL_QUOTE" : `line${i + 1}`,
    );
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      // Window [1..15]; target is at line 80.
      { file: "src/a.ts", startLine: 5, endLine: 5, code: "ADVERSARIAL_QUOTE" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectFail(result);
    expect(result.reasonCode).toBe("quote_mismatch");
  });
});

// ─── 29  exact matched line range values ─────────────────────────

describe("verifyLensFinding — matched line range", () => {
  it("29. multi-line quote spanning lines 12-15 returns exact matchedStart/End", () => {
    const lines = [
      "line1",
      "line2",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line9",
      "line10",
      "line11",
      "function target() {",
      "  const x = 1;",
      "  const y = 2;",
      "}",
      "line16",
    ];
    const { ctx } = writeFixtureSnapshot({
      "src/a.ts": lines.join("\n") + "\n",
    });
    const finding = makeFinding([
      {
        file: "src/a.ts",
        startLine: 12,
        endLine: 15,
        code: "function target() {\n  const x = 1;\n  const y = 2;\n}",
      },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);
    expect(result.verifiedEvidence[0].matchedStartLine).toBe(12);
    expect(result.verifiedEvidence[0].matchedEndLine).toBe(15);
  });
});

// ─── 30  purity (no-mutation) ────────────────────────────────────

describe("verifyLensFinding — purity", () => {
  it("30. snapshot bytes and mtime unchanged after verification", () => {
    const { ctx, snapshotDir } = writeFixtureSnapshot({
      "src/a.ts": "alpha\nconst A = 1;\nomega\n",
    });
    const manifestPath = join(snapshotDir, "manifest.json");
    const payloadPath = join(snapshotDir, "src", "a.ts");
    const manifestBefore = readFileSync(manifestPath);
    const payloadBefore = readFileSync(payloadPath);
    const manifestMtimeBefore = statSync(manifestPath).mtimeMs;
    const payloadMtimeBefore = statSync(payloadPath).mtimeMs;

    const finding = makeFinding([
      { file: "src/a.ts", startLine: 2, endLine: 2, code: "const A = 1;" },
    ]);
    const result = verifyLensFinding(finding, ctx);
    expectPass(result);

    const manifestAfter = readFileSync(manifestPath);
    const payloadAfter = readFileSync(payloadPath);
    expect(manifestAfter.equals(manifestBefore)).toBe(true);
    expect(payloadAfter.equals(payloadBefore)).toBe(true);
    expect(statSync(manifestPath).mtimeMs).toBe(manifestMtimeBefore);
    expect(statSync(payloadPath).mtimeMs).toBe(payloadMtimeBefore);
  });
});

// ─── 31  reason-code coverage ─────────────────────────────────────

describe("verifyLensFinding — reason-code coverage", () => {
  it("31. every VerifyReasonCode produced by at least one test in this file", () => {
    // Uses Set populated by recordReason() in earlier tests.
    // snapshot_corrupt is only reachable via the skipIf(IS_WIN) test —
    // skip the assertion for that code on Windows CI.
    const required: VerifyReasonCode[] = [
      "invalid_path",
      "file_not_snapshotted",
      "line_out_of_range",
      "quote_mismatch",
      "ambiguous_match",
      "no_evidence",
    ];
    if (!IS_WIN) required.push("snapshot_corrupt");
    for (const code of required) {
      expect(coveredReasons.has(code)).toBe(true);
    }
  });
});

// ─── 32  SnapshotIntegrityError thrown-not-returned ──────────────

describe("verifyLensFinding — integrity errors are thrown", () => {
  it.skipIf(IS_WIN)(
    "32. integrity failures are thrown as SnapshotIntegrityError instances, not returned",
    () => {
      // Scenario: post-write sha256 substitution — the gate MUST throw.
      const { ctx, snapshotDir } = writeFixtureSnapshot({
        "src/a.ts": "const A = 1;\n",
      });
      const storedA = join(snapshotDir, "src", "a.ts");
      chmodSync(dirname(storedA), 0o755);
      chmodSync(storedA, 0o644);
      writeFileSync(storedA, "const A = 9;\n\n"); // same byte length
      chmodSync(storedA, 0o444);
      const finding = makeFinding([
        { file: "src/a.ts", startLine: 1, endLine: 1, code: "const A = 1;" },
      ]);
      expect(() => verifyLensFinding(finding, ctx)).toThrow(
        SnapshotIntegrityError,
      );
      try {
        verifyLensFinding(finding, ctx);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SnapshotIntegrityError);
        expect((err as SnapshotIntegrityError).code).toBe("snapshot_tampered");
      }
    },
  );
});

// ─── 33  empty / whitespace-only evidence code ───────────────────

describe("verifyLensFinding — whitespace-only evidence", () => {
  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["tab", "\t"],
    ["newlines", "\n\n"],
    ["mixed", "   \n\t"],
  ] as const)(
    "33. whitespace-only code (%s) returns fail(quote_mismatch)",
    (_label, code) => {
      const { ctx } = writeFixtureSnapshot({
        "src/a.ts": "line1\nline2\nline3\n",
      });
      const finding = makeFinding([
        { file: "src/a.ts", startLine: 1, endLine: 1, code },
      ]);
      const result = verifyLensFinding(finding, ctx);
      expectFail(result);
      expect(result.reasonCode).toBe("quote_mismatch");
    },
  );
});

// ─── normalizeForVerification direct exercises ───────────────────

describe("normalizeForVerification", () => {
  it("normalizes CRLF to LF", () => {
    expect(normalizeForVerification("a\r\nb\r\nc")).toBe("a\nb\nc");
  });
  it("normalizes lone CR to LF", () => {
    expect(normalizeForVerification("a\rb\rc")).toBe("a\nb\nc");
  });
  it("trims trailing whitespace per line", () => {
    expect(normalizeForVerification("a   \nb\t\nc")).toBe("a\nb\nc");
  });
  it("preserves interior whitespace byte-for-byte", () => {
    expect(normalizeForVerification('foo("a  b")')).toBe('foo("a  b")');
  });
  it("preserves leading indentation", () => {
    expect(normalizeForVerification("\treturn 42;")).toBe("\treturn 42;");
  });
});

// ─── VERIFY_RECOVERY_WINDOW constant ─────────────────────────────

describe("VERIFY_RECOVERY_WINDOW", () => {
  it("exports the ±10 line recovery constant", () => {
    expect(VERIFY_RECOVERY_WINDOW).toBe(10);
  });
});

// ─── Helper-extraction smoke test ────────────────────────────────

describe("_assertValidManifestPath / _assertNoSymlinkAncestors re-exports", () => {
  it("_assertValidManifestPath rejects absolute paths", () => {
    expect(() =>
      _assertValidManifestPath("/etc/passwd", "smoke test"),
    ).toThrow();
  });
  it("_assertValidManifestPath rejects dotdot", () => {
    expect(() =>
      _assertValidManifestPath("../outside.ts", "smoke test"),
    ).toThrow();
  });
  it.skipIf(IS_WIN)(
    "_assertNoSymlinkAncestors rejects symlink in destination chain",
    () => {
      const base = mkdtempSync(join(tmpdir(), "helper-smoke-"));
      try {
        const realDir = join(base, "real");
        mkdirSync(realDir, { recursive: true });
        const linkDir = join(base, "link");
        symlinkSync(realDir, linkDir, "dir");
        const inner = join(linkDir, "inner.txt");
        writeFileSync(join(realDir, "inner.txt"), "hi");
        expect(() => _assertNoSymlinkAncestors(inner, base)).toThrow();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});

// Reference unused fs helpers so the linter does not complain during the
// stub phase when every body throws.
void lstatSync;
