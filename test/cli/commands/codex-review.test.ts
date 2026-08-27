import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("codex-review helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-codex-review-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Storybloq Test"]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: tempDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  }

  it("builds a code-review diff artifact with tracked and untracked file contents", async () => {
    await writeFile(join(tempDir, "tracked.txt"), "old\n", "utf-8");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "initial"]);

    await writeFile(join(tempDir, "tracked.txt"), "old\nchanged\n", "utf-8");
    await writeFile(join(tempDir, "new-file.txt"), "new\n", "utf-8");

    const { buildCodeReviewDiffArtifact } = await import("../../../src/cli/commands/codex-review.js");
    const artifact = buildCodeReviewDiffArtifact(tempDir, "HEAD");

    expect(artifact).toContain("tracked.txt");
    expect(artifact).toContain("+changed");
    expect(artifact).toContain("new-file.txt");
    expect(artifact).toContain("+new");
  });

  it("rejects code review when there is no diff to review", async () => {
    await writeFile(join(tempDir, "tracked.txt"), "old\n", "utf-8");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "initial"]);

    const { buildCodeReviewDiffArtifact } = await import("../../../src/cli/commands/codex-review.js");

    expect(() => buildCodeReviewDiffArtifact(tempDir, "HEAD")).toThrow("No code diff found");
  });

  it("uses distinct verdict contracts for plan and code review", async () => {
    const { codePrompt, planPrompt, schemaForKind, verdictsForKind } = await import("../../../src/cli/commands/codex-review.js");

    expect(verdictsForKind("plan")).toEqual(["approve", "revise", "reject"]);
    expect(verdictsForKind("code")).toEqual(["approve", "request_changes", "reject"]);

    expect(planPrompt("s-1")).toContain("Use verdict approve, revise, or reject.");
    expect(planPrompt("s-1")).not.toContain("request_changes");
    expect(codePrompt("s-1")).toContain("Use verdict approve, request_changes, or reject.");
    expect(codePrompt("s-1")).not.toContain("revise");

    expect(JSON.stringify(schemaForKind("plan"))).toContain('"revise"');
    expect(JSON.stringify(schemaForKind("plan"))).not.toContain('"request_changes"');
    expect(JSON.stringify(schemaForKind("code"))).toContain('"request_changes"');
    expect(JSON.stringify(schemaForKind("code"))).not.toContain('"revise"');
  });

  /**
   * ISS-598 codex round 2 (API integration): this normalizer used to fold
   * `file`/`line` into `description` and drop `file` entirely -- the ONE
   * place a native codex review's file citation existed, since `Finding` (the
   * canonical interface) has no `file` property. plan-review.ts's scope-drift
   * detector reads `file` defensively off the raw finding object, so without
   * this the detector's basename-only tokenization could never engage on the
   * native-codex review path at all.
   */
  it("attaches the raw file path to the normalized finding, without removing it from the folded description", async () => {
    const { normalizeFinding } = await import("../../../src/cli/commands/codex-review.js");
    const finding = normalizeFinding(
      { severity: "major", category: "correctness", description: "Off-by-one", file: "src/nav/reducer.ts", line: 42 },
      0,
    ) as { file?: string; description: string };

    expect(finding.file).toBe("src/nav/reducer.ts");
    expect(finding.description).toContain("src/nav/reducer.ts:42:");
    expect(finding.description).toContain("Off-by-one");
  });

  it("omits file entirely when codex cited none, rather than defaulting it to an empty string", async () => {
    const { normalizeFinding } = await import("../../../src/cli/commands/codex-review.js");
    const finding = normalizeFinding(
      { severity: "minor", category: "style", description: "Rename this" },
      0,
    ) as { file?: string };

    expect(finding.file).toBeUndefined();
  });
});
