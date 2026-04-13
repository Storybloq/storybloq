import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  chmodSync,
  readdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import { tmpdir, platform } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  writeReviewSnapshot,
  readReviewSnapshotManifest,
  archiveReviewSnapshot,
} from "../../../src/autonomous/review-lenses/index.js";
import { writeReviewSnapshotInto } from "../../../src/autonomous/review-lenses/review-snapshot.js";

// Valid UUID for all tests.
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const IS_WIN = platform() === "win32";

let projectRoot: string;
let scratchDir: string;

function seedFile(rel: string, contents: string | Buffer): string {
  const full = join(projectRoot, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return rel;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function snapshotParentFor(sessionId: string): string {
  return join(projectRoot, ".story", "sessions", sessionId, "review-snapshot");
}

function snapshotDirFor(sessionId: string, reviewId: string): string {
  return join(snapshotParentFor(sessionId), reviewId);
}

function chmodRecursive(dir: string, mode: number): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    try {
      chmodSync(p, mode);
    } catch {
      /* symlinks/etc. */
    }
    if (entry.isDirectory()) chmodRecursive(p, mode);
  }
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "review-snapshot-test-"));
  scratchDir = mkdtempSync(join(tmpdir(), "review-snapshot-scratch-"));
  mkdirSync(join(projectRoot, ".story", "sessions", SESSION_ID), {
    recursive: true,
  });
});

afterEach(() => {
  // The writer chmods payloads to 0o444 — restore to writable before rm.
  const fixWritable = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      try {
        chmodSync(p, 0o755);
      } catch {
        /* symlinks/etc. */
      }
      if (entry.isDirectory()) fixWritable(p);
    }
  };
  try {
    fixWritable(projectRoot);
  } catch {
    /* ignore */
  }
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

// ─── 1–5  Happy path ──────────────────────────────────────────────

describe("writeReviewSnapshot — happy path", () => {
  it("1. writes a normal bundle with a matching manifest", () => {
    seedFile("src/a.ts", "export const A = 1;\n");
    seedFile("src/b.ts", "export const B = 2;\n");
    seedFile("src/c.ts", "export const C = 3;\n");

    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });

    expect(existsSync(result.snapshotDir)).toBe(true);
    expect(existsSync(result.manifestPath)).toBe(true);
    expect(result.manifest.files).toHaveLength(3);
    expect(result.manifest.fileCount).toBe(3);
    // Sorted ascending by path.
    expect(result.manifest.files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    // Recompute sha of each stored file and compare to manifest.
    for (const entry of result.manifest.files) {
      const stored = readFileSync(join(result.snapshotDir, entry.path));
      expect(sha256Hex(stored)).toBe(entry.sha256);
      expect(stored.length).toBe(entry.bytes);
    }
    const totalBytes = result.manifest.files.reduce(
      (a, f) => a + f.bytes,
      0,
    );
    expect(result.manifest.totalBytes).toBe(totalBytes);
  });

  it("2. preserves binary files byte-for-byte", () => {
    const bin = Buffer.from(
      Array.from({ length: 256 }, (_, i) => i),
    );
    seedFile("assets/bytes.bin", bin);

    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["assets/bytes.bin"],
    });

    const stored = readFileSync(join(result.snapshotDir, "assets/bytes.bin"));
    expect(stored.equals(bin)).toBe(true);
  });

  it("3. captures unchanged context files alongside diff targets", () => {
    seedFile("src/changed.ts", "// changed");
    seedFile("src/context.ts", "// unchanged context");
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/changed.ts", "src/context.ts"],
    });
    expect(result.manifest.files.map((f) => f.path).sort()).toEqual([
      "src/changed.ts",
      "src/context.ts",
    ]);
  });

  it("4. canonical project root is stored in manifest", () => {
    // Create a symlink to the real projectRoot and pass it as the root.
    const aliasRoot = join(scratchDir, "alias-root");
    symlinkSync(projectRoot, aliasRoot, "dir");
    mkdirSync(
      join(projectRoot, ".story", "sessions", SESSION_ID, "x"),
      { recursive: true },
    );
    seedFile("src/a.ts", "x");

    const result = writeReviewSnapshot({
      projectRoot: aliasRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });

    expect(result.manifest.canonicalProjectRoot).toBe(
      realpathSync(projectRoot),
    );
  });

  it("5. manifestSha256 matches on-disk manifest bytes", () => {
    seedFile("src/a.ts", "x");
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    const onDisk = readFileSync(result.manifestPath);
    expect(result.manifestSha256).toBe(sha256Hex(onDisk));
  });
});

// ─── 6–9  Source-side path safety ─────────────────────────────────

describe("writeReviewSnapshot — source path safety", () => {
  it("6. rejects an absolute source path", () => {
    expect(() =>
      writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["/etc/passwd"],
      }),
    ).toThrow();
  });

  it("7. rejects a path containing a .. segment", () => {
    expect(() =>
      writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["../escape.txt"],
      }),
    ).toThrow();
  });

  it("8. rejects a symlink whose target escapes the project root", () => {
    const external = join(scratchDir, "outside.txt");
    writeFileSync(external, "secret");
    symlinkSync(external, join(projectRoot, "escape-link"));
    expect(() =>
      writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["escape-link"],
      }),
    ).toThrow();
  });

  it("9. rejects a missing source file cleanly and allows retry", () => {
    seedFile("src/a.ts", "x");
    expect(() =>
      writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["src/a.ts", "src/missing.ts"],
      }),
    ).toThrow();
    // No final dir.
    expect(existsSync(snapshotDirFor(SESSION_ID, "code-review-r1"))).toBe(
      false,
    );
    // Retry with only the present file.
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    expect(result.manifest.files).toHaveLength(1);
  });
});

// ─── 10  Symlink preserves caller path ────────────────────────────

describe("writeReviewSnapshot — in-repo symlink preservation", () => {
  it("10. symlink inside repo stores the caller path in the manifest", () => {
    seedFile("src/target.ts", "real target");
    symlinkSync(
      join(projectRoot, "src/target.ts"),
      join(projectRoot, "src/alias.ts"),
    );
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/alias.ts"],
    });
    expect(result.manifest.files.map((f) => f.path)).toEqual([
      "src/alias.ts",
    ]);
    const stored = readFileSync(join(result.snapshotDir, "src/alias.ts"));
    expect(stored.toString()).toBe("real target");
    // The stored file is a regular file, not a symlink.
    expect(lstatSync(join(result.snapshotDir, "src/alias.ts")).isSymbolicLink()).toBe(
      false,
    );
  });
});

// ─── 11  Dedup ────────────────────────────────────────────────────

describe("writeReviewSnapshot — input deduplication", () => {
  it("11. collapses duplicate caller paths to a single manifest entry", () => {
    seedFile("src/a.ts", "dup");
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts", "src/a.ts"], // exact duplicates
    });
    expect(result.manifest.fileCount).toBe(1);
    expect(result.manifest.files).toHaveLength(1);
    expect(result.manifest.totalBytes).toBe(3); // "dup"
  });
});

// ─── 12–15  ReviewId separation, immutability, retry ──────────────

describe("writeReviewSnapshot — reviewId separation and immutability", () => {
  it("12. plan-review-r1 and code-review-r1 coexist", () => {
    seedFile("src/a.ts", "x");
    writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "plan-review-r1",
      stage: "plan-review",
      round: 1,
      files: ["src/a.ts"],
    });
    writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    expect(existsSync(snapshotDirFor(SESSION_ID, "plan-review-r1"))).toBe(true);
    expect(existsSync(snapshotDirFor(SESSION_ID, "code-review-r1"))).toBe(true);
  });

  it("13. code-review-r1 and code-review-r2 coexist", () => {
    seedFile("src/a.ts", "x");
    writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r2",
      stage: "code-review",
      round: 2,
      files: ["src/a.ts"],
    });
    expect(existsSync(snapshotDirFor(SESSION_ID, "code-review-r1"))).toBe(true);
    expect(existsSync(snapshotDirFor(SESSION_ID, "code-review-r2"))).toBe(true);
  });

  it("14. second write with same reviewId throws collision", () => {
    seedFile("src/a.ts", "x");
    writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    expect(() =>
      writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["src/a.ts"],
      }),
    ).toThrow();
  });

  it("15. retry after a failed write succeeds", () => {
    seedFile("src/a.ts", "x");
    // First attempt fails on missing file.
    expect(() =>
      writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["src/a.ts", "src/missing.ts"],
      }),
    ).toThrow();
    expect(existsSync(snapshotDirFor(SESSION_ID, "code-review-r1"))).toBe(
      false,
    );
    // Retry succeeds.
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    expect(result.manifest.files).toHaveLength(1);
  });
});

// ─── 16–19  Manifest integrity and read-only mode ─────────────────

describe("writeReviewSnapshot — manifest integrity and read-only", () => {
  it("16. bytes field equals stat.size for every captured file", () => {
    seedFile("src/a.ts", "xxxxx");
    seedFile("src/b.ts", "yy");
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts", "src/b.ts"],
    });
    for (const e of result.manifest.files) {
      const s = statSync(join(result.snapshotDir, e.path));
      expect(e.bytes).toBe(s.size);
    }
  });

  it("17. totalBytes equals sum of per-file bytes", () => {
    seedFile("src/a.ts", "xxxxx"); // 5
    seedFile("src/b.ts", "yy"); // 2
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts", "src/b.ts"],
    });
    expect(result.manifest.totalBytes).toBe(7);
  });

  it.skipIf(IS_WIN)(
    "18. captured files are mode 0o444",
    () => {
      seedFile("src/a.ts", "x");
      const result = writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["src/a.ts"],
      });
      const s = statSync(join(result.snapshotDir, "src/a.ts"));
      // Mask to permission bits.
      expect(s.mode & 0o777).toBe(0o444);
    },
  );

  it.skipIf(IS_WIN)("19. manifest.json is mode 0o444", () => {
    seedFile("src/a.ts", "x");
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    const s = statSync(result.manifestPath);
    expect(s.mode & 0o777).toBe(0o444);
  });
});

// ─── 20–27  Reader ────────────────────────────────────────────────

describe("readReviewSnapshotManifest", () => {
  function writeBasic(reviewId = "code-review-r1"): {
    sha256: string;
    reviewId: string;
  } {
    seedFile("src/a.ts", "alpha");
    seedFile("src/b.ts", "bravo");
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId,
      stage: "code-review",
      round: Number(reviewId.split("r").pop()),
      files: ["src/a.ts", "src/b.ts"],
    });
    return { sha256: result.manifestSha256, reviewId };
  }

  it("20. returns parsed manifest matching the writer's return", () => {
    seedFile("src/a.ts", "x");
    const wr = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    const read = readReviewSnapshotManifest(
      projectRoot,
      SESSION_ID,
      "code-review-r1",
    );
    expect(read).toEqual(wr.manifest);
  });

  it("21. matching expectedManifestSha256 succeeds", () => {
    const { sha256, reviewId } = writeBasic();
    expect(() =>
      readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId, sha256),
    ).not.toThrow();
  });

  it("22. mismatched expectedManifestSha256 throws", () => {
    const { reviewId } = writeBasic();
    expect(() =>
      readReviewSnapshotManifest(
        projectRoot,
        SESSION_ID,
        reviewId,
        "0".repeat(64),
      ),
    ).toThrow();
  });

  it("23. tampered payload bytes throws in digest-verified mode", () => {
    const { sha256, reviewId } = writeBasic();
    const target = join(snapshotDirFor(SESSION_ID, reviewId), "src/a.ts");
    chmodSync(target, 0o644);
    writeFileSync(target, "tampered!!!");
    expect(() =>
      readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId, sha256),
    ).toThrow();
  });

  it("24. tampered entry path throws (rewrite manifest with matching digest)", () => {
    const { reviewId } = writeBasic();
    const manifestPath = join(
      snapshotDirFor(SESSION_ID, reviewId),
      "manifest.json",
    );
    chmodSync(manifestPath, 0o644);
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    parsed.files[0].path = "../evil";
    const newBytes = JSON.stringify(parsed, null, 2) + "\n";
    writeFileSync(manifestPath, newBytes);
    const newSha = sha256Hex(Buffer.from(newBytes));
    expect(() =>
      readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId, newSha),
    ).toThrow();
  });

  it("25. is not affected by live repo state", () => {
    const { sha256, reviewId } = writeBasic();
    unlinkSync(join(projectRoot, "src/a.ts"));
    unlinkSync(join(projectRoot, "src/b.ts"));
    expect(() =>
      readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId, sha256),
    ).not.toThrow();
  });

  it("26. rejects a bogus sessionId", () => {
    expect(() =>
      readReviewSnapshotManifest(projectRoot, "not-a-uuid", "code-review-r1"),
    ).toThrow();
    expect(() =>
      readReviewSnapshotManifest(
        projectRoot,
        "../" + SESSION_ID,
        "code-review-r1",
      ),
    ).toThrow();
  });

  it("27. rejects a bogus reviewId", () => {
    expect(() =>
      readReviewSnapshotManifest(
        projectRoot,
        SESSION_ID,
        "plan-review-r1/../evil",
      ),
    ).toThrow();
    expect(() =>
      readReviewSnapshotManifest(projectRoot, SESSION_ID, "plan-review-rfoo"),
    ).toThrow();
  });

  it("27a. parse-only mode returns a valid manifest without touching payload files", () => {
    const { reviewId } = writeBasic();
    // Tamper the payload bytes.
    const a = join(snapshotDirFor(SESSION_ID, reviewId), "src/a.ts");
    chmodSync(a, 0o644);
    writeFileSync(a, "tampered");
    // Parse-only mode still succeeds (payload files not read).
    const m = readReviewSnapshotManifest(
      projectRoot,
      SESSION_ID,
      reviewId,
    );
    expect(m.files).toHaveLength(2);
  });

  it("27b. parse-only mode rejects an escaping entry path", () => {
    const { reviewId } = writeBasic();
    const manifestPath = join(
      snapshotDirFor(SESSION_ID, reviewId),
      "manifest.json",
    );
    chmodSync(manifestPath, 0o644);
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    parsed.files[0].path = "../evil";
    writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + "\n");
    expect(() =>
      readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId),
    ).toThrow();
  });

  it.skipIf(IS_WIN)(
    "27c. rejects symlinked manifest.json in parse-only mode",
    () => {
      const { reviewId } = writeBasic();
      const manifestPath = join(
        snapshotDirFor(SESSION_ID, reviewId),
        "manifest.json",
      );
      const alt = join(scratchDir, "alt-manifest.json");
      writeFileSync(alt, '{"fake": true}');
      unlinkSync(manifestPath);
      symlinkSync(alt, manifestPath);
      expect(() =>
        readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId),
      ).toThrow();
    },
  );

  it.skipIf(IS_WIN)(
    "27d. rejects symlinked manifest.json in digest-verified mode",
    () => {
      const { sha256, reviewId } = writeBasic();
      const manifestPath = join(
        snapshotDirFor(SESSION_ID, reviewId),
        "manifest.json",
      );
      const alt = join(scratchDir, "alt-manifest.json");
      writeFileSync(alt, '{"fake": true}');
      unlinkSync(manifestPath);
      symlinkSync(alt, manifestPath);
      expect(() =>
        readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId, sha256),
      ).toThrow();
    },
  );

  // 27e–27h: manifest path contract (backslash, mixed sep, drive-qualified, non-normalized)
  it("27e. rejects manifest entries with backslashes", () => {
    const { reviewId } = writeBasic();
    const manifestPath = join(
      snapshotDirFor(SESSION_ID, reviewId),
      "manifest.json",
    );
    chmodSync(manifestPath, 0o644);
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    parsed.files[0].path = "..\\evil";
    writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + "\n");
    expect(() =>
      readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId),
    ).toThrow();
  });

  it("27f. rejects manifest entries with mixed separators", () => {
    const { reviewId } = writeBasic();
    const manifestPath = join(
      snapshotDirFor(SESSION_ID, reviewId),
      "manifest.json",
    );
    chmodSync(manifestPath, 0o644);
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    parsed.files[0].path = "a\\b.txt";
    writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + "\n");
    expect(() =>
      readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId),
    ).toThrow();
  });

  it("27g. rejects Windows drive-qualified manifest entries (every form)", () => {
    const { reviewId } = writeBasic();
    const manifestPath = join(
      snapshotDirFor(SESSION_ID, reviewId),
      "manifest.json",
    );
    for (const bad of ["C:evil", "C:/evil", "C:\\evil"]) {
      chmodSync(manifestPath, 0o644);
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      parsed.files[0].path = bad;
      writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + "\n");
      expect(() =>
        readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId),
      ).toThrow();
    }
  });

  it("27h. rejects non-normalized manifest entries", () => {
    const { reviewId } = writeBasic();
    const manifestPath = join(
      snapshotDirFor(SESSION_ID, reviewId),
      "manifest.json",
    );
    for (const bad of ["a/./b.txt", "a//b.txt", "a/b/../c.txt"]) {
      chmodSync(manifestPath, 0o644);
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      parsed.files[0].path = bad;
      writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + "\n");
      expect(() =>
        readReviewSnapshotManifest(projectRoot, SESSION_ID, reviewId),
      ).toThrow();
    }
  });
});

// ─── 28–29  Writer identifier validation ──────────────────────────

describe("writeReviewSnapshot — identifier validation", () => {
  it("28. rejects a bogus sessionId", () => {
    seedFile("src/a.ts", "x");
    for (const bad of ["not-a-uuid", "../" + SESSION_ID, SESSION_ID + "/x", ""]) {
      expect(() =>
        writeReviewSnapshot({
          projectRoot,
          sessionId: bad,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: ["src/a.ts"],
        }),
      ).toThrow();
    }
  });

  it("29. rejects a bogus reviewId", () => {
    seedFile("src/a.ts", "x");
    for (const bad of [
      "plan-review-rfoo",
      "plan-review-r1/../evil",
      "evil",
      "",
      "plan-review-r",
    ]) {
      expect(() =>
        writeReviewSnapshot({
          projectRoot,
          sessionId: SESSION_ID,
          reviewId: bad,
          stage: "plan-review",
          round: 1,
          files: ["src/a.ts"],
        }),
      ).toThrow();
    }
  });
});

// ─── 29a–29i  Destination-side symlink containment ────────────────

describe(
  "writeReviewSnapshot — destination-side symlink containment",
  () => {
    it.skipIf(IS_WIN)(
      "29a. rejects a symlinked review-snapshot parent pointing externally",
      () => {
        seedFile("src/a.ts", "x");
        const sessDir = join(projectRoot, ".story", "sessions", SESSION_ID);
        // Plant a symlink where review-snapshot would be created.
        const external = join(scratchDir, "external-rs");
        mkdirSync(external, { recursive: true });
        symlinkSync(external, join(sessDir, "review-snapshot"), "dir");
        expect(() =>
          writeReviewSnapshot({
            projectRoot,
            sessionId: SESSION_ID,
            reviewId: "code-review-r1",
            stage: "code-review",
            round: 1,
            files: ["src/a.ts"],
          }),
        ).toThrow();
        expect(readdirSync(external)).toHaveLength(0);
      },
    );

    it.skipIf(IS_WIN)(
      "29b. rejects in-tree session aliasing (sessionA → sessionB)",
      () => {
        seedFile("src/a.ts", "x");
        const OTHER = "99999999-8888-7777-6666-555555555555";
        mkdirSync(join(projectRoot, ".story", "sessions", OTHER), {
          recursive: true,
        });
        // Replace sessionId's dir with a symlink to OTHER.
        rmSync(join(projectRoot, ".story", "sessions", SESSION_ID), {
          recursive: true,
          force: true,
        });
        symlinkSync(
          join(projectRoot, ".story", "sessions", OTHER),
          join(projectRoot, ".story", "sessions", SESSION_ID),
          "dir",
        );
        expect(() =>
          writeReviewSnapshot({
            projectRoot,
            sessionId: SESSION_ID,
            reviewId: "code-review-r1",
            stage: "code-review",
            round: 1,
            files: ["src/a.ts"],
          }),
        ).toThrow();
      },
    );

    it.skipIf(IS_WIN)(
      "29c. rejects in-tree review-snapshot aliasing",
      () => {
        seedFile("src/a.ts", "x");
        const OTHER = "99999999-8888-7777-6666-555555555555";
        mkdirSync(
          join(projectRoot, ".story", "sessions", OTHER, "review-snapshot"),
          { recursive: true },
        );
        const target = join(
          projectRoot,
          ".story",
          "sessions",
          OTHER,
          "review-snapshot",
        );
        symlinkSync(
          target,
          join(
            projectRoot,
            ".story",
            "sessions",
            SESSION_ID,
            "review-snapshot",
          ),
          "dir",
        );
        expect(() =>
          writeReviewSnapshot({
            projectRoot,
            sessionId: SESSION_ID,
            reviewId: "code-review-r1",
            stage: "code-review",
            round: 1,
            files: ["src/a.ts"],
          }),
        ).toThrow();
      },
    );

    it.skipIf(IS_WIN)(
      "29d. reader rejects a symlinked finalDir",
      () => {
        seedFile("src/a.ts", "x");
        const wr = writeReviewSnapshot({
          projectRoot,
          sessionId: SESSION_ID,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: ["src/a.ts"],
        });
        // Replace finalDir with a symlink.
        const elsewhere = join(scratchDir, "elsewhere");
        mkdirSync(elsewhere, { recursive: true });
        // Remove the real finalDir (writable first).
        chmodRecursive(wr.snapshotDir, 0o755);
        rmSync(wr.snapshotDir, { recursive: true, force: true });
        symlinkSync(elsewhere, wr.snapshotDir, "dir");
        expect(() =>
          readReviewSnapshotManifest(
            projectRoot,
            SESSION_ID,
            "code-review-r1",
            wr.manifestSha256,
          ),
        ).toThrow();
      },
    );

    it.skipIf(IS_WIN)(
      "29e. reader rejects a symlinked payload file",
      () => {
        seedFile("src/a.ts", "x");
        const wr = writeReviewSnapshot({
          projectRoot,
          sessionId: SESSION_ID,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: ["src/a.ts"],
        });
        const storedA = join(wr.snapshotDir, "src/a.ts");
        chmodSync(storedA, 0o644);
        unlinkSync(storedA);
        // Point at a non-existent external path so the read would ENOENT
        // if it followed the symlink. The reader must throw via lstat first.
        symlinkSync(join(scratchDir, "does-not-exist"), storedA);
        expect(() =>
          readReviewSnapshotManifest(
            projectRoot,
            SESSION_ID,
            "code-review-r1",
            wr.manifestSha256,
          ),
        ).toThrow();
      },
    );

    it.skipIf(IS_WIN)(
      "29f. archive rejects a symlinked finalDir before spawning tar",
      () => {
        seedFile("src/a.ts", "x");
        const wr = writeReviewSnapshot({
          projectRoot,
          sessionId: SESSION_ID,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: ["src/a.ts"],
        });
        const elsewhere = join(scratchDir, "elsewhere-2");
        mkdirSync(elsewhere, { recursive: true });
        chmodRecursive(wr.snapshotDir, 0o755);
        rmSync(wr.snapshotDir, { recursive: true, force: true });
        symlinkSync(elsewhere, wr.snapshotDir, "dir");
        expect(() =>
          archiveReviewSnapshot(projectRoot, SESSION_ID, "code-review-r1"),
        ).toThrow();
      },
    );

    it.skipIf(IS_WIN)(
      "29g. writer rejects a nested directory symlink in a pre-seeded staging dir",
      () => {
        seedFile("src/nested/deep/a.txt", "x");
        // Pre-create the staging dir and plant a symlink.
        const snapshotParent = snapshotParentFor(SESSION_ID);
        mkdirSync(snapshotParent, { recursive: true });
        const staging = join(snapshotParent, "code-review-r1.tmp-test");
        mkdirSync(staging, { recursive: true });
        const external = join(scratchDir, "external-nested");
        mkdirSync(external, { recursive: true });
        symlinkSync(external, join(staging, "src"), "dir");
        expect(() =>
          writeReviewSnapshotInto(
            {
              projectRoot,
              sessionId: SESSION_ID,
              reviewId: "code-review-r1",
              stage: "code-review",
              round: 1,
              files: ["src/nested/deep/a.txt"],
            },
            staging,
          ),
        ).toThrow();
      },
    );

    it.skipIf(IS_WIN)(
      "29h. reader rejects a nested dir symlink inside finalDir",
      () => {
        seedFile("src/a.ts", "alpha");
        const wr = writeReviewSnapshot({
          projectRoot,
          sessionId: SESSION_ID,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: ["src/a.ts"],
        });
        const storedSrc = join(wr.snapshotDir, "src");
        chmodSync(join(storedSrc, "a.ts"), 0o644);
        unlinkSync(join(storedSrc, "a.ts"));
        rmSync(storedSrc, { recursive: true, force: true });
        // Plant a nested directory symlink.
        const external = join(scratchDir, "nested-ext");
        mkdirSync(external, { recursive: true });
        writeFileSync(join(external, "a.ts"), "decoy");
        symlinkSync(external, storedSrc, "dir");
        expect(() =>
          readReviewSnapshotManifest(
            projectRoot,
            SESSION_ID,
            "code-review-r1",
            wr.manifestSha256,
          ),
        ).toThrow();
      },
    );

    it.skipIf(IS_WIN)(
      "29i. archive rejects a nested dir symlink inside finalDir",
      () => {
        seedFile("src/a.ts", "alpha");
        const wr = writeReviewSnapshot({
          projectRoot,
          sessionId: SESSION_ID,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: ["src/a.ts"],
        });
        const storedSrc = join(wr.snapshotDir, "src");
        chmodSync(join(storedSrc, "a.ts"), 0o644);
        unlinkSync(join(storedSrc, "a.ts"));
        rmSync(storedSrc, { recursive: true, force: true });
        const external = join(scratchDir, "nested-ext-arc");
        mkdirSync(external, { recursive: true });
        writeFileSync(join(external, "a.ts"), "decoy");
        symlinkSync(external, storedSrc, "dir");
        expect(() =>
          archiveReviewSnapshot(projectRoot, SESSION_ID, "code-review-r1"),
        ).toThrow();
        // No tar.gz created.
        expect(
          existsSync(join(snapshotParentFor(SESSION_ID), "code-review-r1.tar.gz")),
        ).toBe(false);
      },
    );
  },
);

// ─── 29j–29l  Writer caller-path contract ─────────────────────────

describe("writeReviewSnapshot — manifest-path contract on caller paths", () => {
  it("29j. rejects caller paths with backslashes", () => {
    seedFile("src/ab.txt", "x");
    expect(() =>
      writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["a\\b.txt"],
      }),
    ).toThrow();
  });

  it("29k. rejects Windows drive-qualified caller paths (every form)", () => {
    seedFile("src/a.ts", "x");
    for (const bad of ["C:evil", "C:/evil", "C:\\evil"]) {
      expect(() =>
        writeReviewSnapshot({
          projectRoot,
          sessionId: SESSION_ID,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: [bad],
        }),
      ).toThrow();
    }
  });

  it("29l. rejects non-normalized caller paths", () => {
    seedFile("src/a.ts", "x");
    for (const bad of ["a/./b.txt", "a//b.txt", "a/b/../c.txt"]) {
      expect(() =>
        writeReviewSnapshot({
          projectRoot,
          sessionId: SESSION_ID,
          reviewId: "code-review-r1",
          stage: "code-review",
          round: 1,
          files: [bad],
        }),
      ).toThrow();
    }
  });
});

// ─── 30–32  Archive ───────────────────────────────────────────────

describe("archiveReviewSnapshot", () => {
  it.skipIf(IS_WIN)(
    "30. produces tar.gz, removes the source dir, listing contains every path",
    () => {
      seedFile("src/a.ts", "alpha");
      seedFile("src/b.ts", "bravo");
      writeReviewSnapshot({
        projectRoot,
        sessionId: SESSION_ID,
        reviewId: "code-review-r1",
        stage: "code-review",
        round: 1,
        files: ["src/a.ts", "src/b.ts"],
      });
      const result = archiveReviewSnapshot(
        projectRoot,
        SESSION_ID,
        "code-review-r1",
      );
      expect(existsSync(result.archivePath)).toBe(true);
      expect(existsSync(result.removedDir)).toBe(false);
      const listing = spawnSync("tar", ["-tzf", result.archivePath], {
        encoding: "utf8",
      }).stdout;
      expect(listing).toContain("manifest.json");
      expect(listing).toContain("src/a.ts");
      expect(listing).toContain("src/b.ts");
    },
  );

  it.skipIf(IS_WIN)("31. round-trips byte-exact", () => {
    seedFile("src/a.ts", "alpha");
    writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files: ["src/a.ts"],
    });
    const result = archiveReviewSnapshot(
      projectRoot,
      SESSION_ID,
      "code-review-r1",
    );
    const extract = join(scratchDir, "extract");
    mkdirSync(extract, { recursive: true });
    const r = spawnSync("tar", ["-xzf", result.archivePath, "-C", extract]);
    expect(r.status).toBe(0);
    const extracted = readFileSync(
      join(extract, "code-review-r1", "src/a.ts"),
    );
    expect(extracted.toString()).toBe("alpha");
  });

  it("32. archive rejects bogus ids", () => {
    expect(() =>
      archiveReviewSnapshot(projectRoot, "not-a-uuid", "code-review-r1"),
    ).toThrow();
    expect(() =>
      archiveReviewSnapshot(projectRoot, SESSION_ID, "plan-review-rfoo"),
    ).toThrow();
  });
});

// ─── 33  Integration ──────────────────────────────────────────────

describe("writeReviewSnapshot — integration", () => {
  it("33. fake lens review round: snapshot matches inputs byte-for-byte", () => {
    seedFile("src/api.ts", "export function f() {}\n");
    seedFile(
      "package.json",
      JSON.stringify({ name: "demo", version: "0.0.0" }, null, 2),
    );
    const bin = Buffer.from([0, 1, 2, 3, 255, 254, 128]);
    seedFile("assets/x.bin", bin);
    const files = ["src/api.ts", "package.json", "assets/x.bin"];
    const result = writeReviewSnapshot({
      projectRoot,
      sessionId: SESSION_ID,
      reviewId: "code-review-r1",
      stage: "code-review",
      round: 1,
      files,
    });
    for (const f of files) {
      const original = readFileSync(join(projectRoot, f));
      const stored = readFileSync(join(result.snapshotDir, f));
      expect(stored.equals(original)).toBe(true);
    }
  });
});
