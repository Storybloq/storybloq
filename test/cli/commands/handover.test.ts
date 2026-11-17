import { describe, it, expect, afterEach } from "vitest";
import {
  handleHandoverList,
  handleHandoverLatest,
  handleHandoverGet,
  handleHandoverCreate,
  handleHandoverTemplate,
  normalizeSlug,
} from "../../../src/cli/commands/handover.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { makeState } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";
import { mkdtemp, writeFile, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPresenceRecord } from "../../../src/core/session-intel/presence-bridge.js";
import { createEraIfAbsent } from "../../../src/core/session-intel/era-store.js";
import { processEra } from "../../../src/core/session-intel/process-era.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../../../src/core/presence-enrichment.js";
import { emptySessionIntel, type SessionIntelSample } from "../../../src/presence/session-intel-fields.js";
import { makeWorktreePair, SID } from "../../core/session-intel-fixtures.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

describe("handleHandoverList", () => {
  it("returns handover filenames", () => {
    const ctx = makeCtx({
      state: makeState({ handoverFilenames: ["2026-03-19-session.md", "2026-03-18-session.md"] }),
    });
    const result = handleHandoverList(ctx);
    expect(result.output).toContain("2026-03-19-session.md");
    expect(result.output).toContain("2026-03-18-session.md");
  });

  it("returns empty message when no handovers", () => {
    const ctx = makeCtx();
    const result = handleHandoverList(ctx);
    expect(result.output).toContain("No handovers");
  });

  it("returns valid JSON", () => {
    const ctx = makeCtx({
      format: "json",
      state: makeState({ handoverFilenames: ["2026-03-19-session.md"] }),
    });
    const result = handleHandoverList(ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data).toContain("2026-03-19-session.md");
  });
});

describe("handleHandoverLatest", () => {
  it("returns latest handover content", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    await writeFile(join(handoversDir, "2026-03-19-session.md"), "# Session Notes\nHello world");

    const ctx = makeCtx({
      state: makeState({ handoverFilenames: ["2026-03-19-session.md"] }),
      handoversDir,
    });
    const result = await handleHandoverLatest(ctx);
    expect(result.output).toContain("Hello world");
  });

  it("returns not_found when no handovers", async () => {
    const ctx = makeCtx();
    const result = await handleHandoverLatest(ctx);
    expect(result.output).toContain("not_found");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });

  describe("T-320 brief/priming wiring", () => {
    it("brief:true returns a structured digest instead of the raw body", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
      const handoversDir = join(tmpDir, "handovers");
      await mkdir(handoversDir, { recursive: true });
      await writeFile(
        join(handoversDir, "2026-03-19-session.md"),
        "# Handover: session\n\n## Next\n- T-900: keep going\n",
      );

      const ctx = makeCtx({
        state: makeState({ handoverFilenames: ["2026-03-19-session.md"] }),
        handoversDir,
      });
      const result = await handleHandoverLatest(ctx, 1, { brief: true });
      expect(result.output).toContain("T-900");
      // The structured path never emits the raw body's exact heading line
      // verbatim as a full-content dump the way the default path does --
      // it renders through formatHandoverBrief instead.
      expect(result.output).not.toContain("## Next\n- T-900: keep going");
    });

    it("priming:true returns the raw body verbatim for a small handover", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
      const handoversDir = join(tmpDir, "handovers");
      await mkdir(handoversDir, { recursive: true });
      const body = "# Handover: session\n\n## Next\n- T-901: keep going\n";
      await writeFile(join(handoversDir, "2026-03-19-session.md"), body);

      const ctx = makeCtx({
        state: makeState({ handoverFilenames: ["2026-03-19-session.md"] }),
        handoversDir,
      });
      const result = await handleHandoverLatest(ctx, 1, { priming: true });
      expect(result.output).toContain(body);
    });

    it("neither brief nor priming set keeps the default full-body path byte-identical", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
      const handoversDir = join(tmpDir, "handovers");
      await mkdir(handoversDir, { recursive: true });
      await writeFile(join(handoversDir, "2026-03-19-session.md"), "# Session Notes\nHello world");

      const ctx = makeCtx({
        state: makeState({ handoverFilenames: ["2026-03-19-session.md"] }),
        handoversDir,
      });
      const withEmptyOpts = await handleHandoverLatest(ctx, 1, {});
      const withNoOpts = await handleHandoverLatest(ctx, 1);
      expect(withEmptyOpts.output).toEqual(withNoOpts.output);
      expect(withNoOpts.output).toContain("Hello world");
    });

    it("returns not_found through the brief path when no handovers exist", async () => {
      const ctx = makeCtx();
      const result = await handleHandoverLatest(ctx, 1, { brief: true });
      expect(result.output).toContain("not_found");
      expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    });

    it("skips an oversized-filename symlink without throwing (admission gate runs before filesystem validation)", async () => {
      // A raw filename under any real OS length limit (255 bytes) can still
      // exceed FILENAME_ADMISSION_MAX_BYTES once JSON-escaped, if it is rich
      // in characters JSON must escape (quotes here: each becomes \" -- two
      // bytes). parseHandoverFilename's own lstat check throws on a symlink,
      // so if the admission gate did not run FIRST, this would fail the
      // whole request instead of just being skipped and counted.
      const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
      const handoversDir = join(tmpDir, "handovers");
      await mkdir(handoversDir, { recursive: true });
      const normalName = "2026-03-19-session.md";
      const normalBody = "# Handover: session\n\n## Next\n- T-904: keep going\n";
      await writeFile(join(handoversDir, normalName), normalBody);

      const oversizedName = "x".repeat(50) + '"'.repeat(150) + ".md";
      expect(Buffer.byteLength(JSON.stringify(oversizedName), "utf-8")).toBeGreaterThan(300);
      await symlink(join(handoversDir, normalName), join(handoversDir, oversizedName));

      const ctx = makeCtx({
        state: makeState({ handoverFilenames: [normalName, oversizedName] }),
        handoversDir,
      });
      const result = await handleHandoverLatest(ctx, 2, { brief: true });
      expect(result.output).toContain("T-904");
      expect(result.exitCode).toBeUndefined();
    });

    it("returns not_found through the brief path when a listed file is missing on disk", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
      const handoversDir = join(tmpDir, "handovers");
      await mkdir(handoversDir, { recursive: true });
      // Listed in state but never written -- exercises buildHandoverBrief's
      // own ENOENT branch, distinct from the top-level empty-list check above.
      const ctx = makeCtx({
        state: makeState({ handoverFilenames: ["2026-03-19-ghost.md"] }),
        handoversDir,
      });
      const result = await handleHandoverLatest(ctx, 1, { priming: true });
      expect(result.output).toContain("not_found");
      expect(result.exitCode).toBe(ExitCode.USER_ERROR);
    });

    it("pen finding: one missing file out of a multi-file window survives, matching the default path's own count>1 tolerance", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
      const handoversDir = join(tmpDir, "handovers");
      await mkdir(handoversDir, { recursive: true });
      await writeFile(
        join(handoversDir, "2026-03-19-a.md"),
        "# Handover: a\n\n## Next\n- T-906: keep going\n",
      );
      // "2026-03-18-ghost.md" is listed (as a state scan would list it) but
      // was never written -- e.g. deleted between the scan and this call.
      const ctx = makeCtx({
        state: makeState({ handoverFilenames: ["2026-03-19-a.md", "2026-03-18-ghost.md"] }),
        handoversDir,
      });
      const result = await handleHandoverLatest(ctx, 2, { priming: true });
      expect(result.exitCode).toBeUndefined();
      expect(result.output).toContain("T-906");
      expect(result.output).toContain("no longer on disk");
    });

    it("Codex finding: an all-oversized window is NOT not_found -- the files exist, only their names were rejected", async () => {
      // The admission check runs before any read, so no file needs to exist
      // on disk for this name to be rejected (see the symlink test above).
      const oversizedName = "a".repeat(310) + ".md";
      const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
      const handoversDir = join(tmpDir, "handovers");
      await mkdir(handoversDir, { recursive: true });
      const ctx = makeCtx({
        state: makeState({ handoverFilenames: [oversizedName] }),
        handoversDir,
      });
      const result = await handleHandoverLatest(ctx, 1, { brief: true });
      expect(result.exitCode).toBeUndefined();
      expect(result.output).toContain("skipped: filename too long");
      expect(result.output).not.toContain("not_found");
    });

    it("Codex finding: a mixed oversized + missing window renders both counts, not not_found", async () => {
      const oversizedName = "a".repeat(310) + ".md";
      const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
      const handoversDir = join(tmpDir, "handovers");
      await mkdir(handoversDir, { recursive: true });
      const ctx = makeCtx({
        state: makeState({ handoverFilenames: [oversizedName, "2026-03-19-ghost2.md"] }),
        handoversDir,
      });
      const result = await handleHandoverLatest(ctx, 2, { brief: true });
      expect(result.exitCode).toBeUndefined();
      expect(result.output).toContain("skipped: filename too long");
      expect(result.output).toContain("no longer on disk");
    });
  });
});

describe("handleHandoverGet", () => {
  it("returns specific handover content", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    await writeFile(join(handoversDir, "2026-03-19-session.md"), "# My Session");

    const ctx = makeCtx({ handoversDir });
    const result = await handleHandoverGet("2026-03-19-session.md", ctx);
    expect(result.output).toContain("My Session");
  });

  it("returns not_found for missing file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });

    const ctx = makeCtx({ handoversDir });
    const result = await handleHandoverGet("nonexistent.md", ctx);
    expect(result.output).toContain("not_found");
    expect(result.exitCode).toBe(ExitCode.USER_ERROR);
  });

  it("returns JSON for handover content", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    await writeFile(join(handoversDir, "2026-03-19-session.md"), "content here");

    const ctx = makeCtx({ handoversDir, format: "json" });
    const result = await handleHandoverGet("2026-03-19-session.md", ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.filename).toBe("2026-03-19-session.md");
    expect(parsed.data.content).toBe("content here");
  });
});

describe("normalizeSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(normalizeSlug("Phase 5B Wrapup")).toBe("phase-5b-wrapup");
  });

  it("strips special characters", () => {
    expect(normalizeSlug("test!@#$%^&*()")).toBe("test");
  });

  it("collapses consecutive hyphens", () => {
    expect(normalizeSlug("a---b")).toBe("a-b");
  });

  it("trims leading/trailing hyphens", () => {
    expect(normalizeSlug("-test-")).toBe("test");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(80);
    expect(normalizeSlug(long).length).toBeLessThanOrEqual(60);
  });

  it("throws on empty result", () => {
    expect(() => normalizeSlug("###")).toThrow(CliValidationError);
    expect(() => normalizeSlug("")).toThrow(CliValidationError);
    expect(() => normalizeSlug("   ")).toThrow(CliValidationError);
  });
});

describe("handleHandoverCreate", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("creates a handover file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleHandoverCreate("# Session\nDone.", "session", "md", dir);
    expect(result.output).toContain("Created handover:");
    expect(result.output).toMatch(/01-session\.md/);

    const files = await readdir(join(dir, ".story", "handovers"));
    const created = files.find((f) => f.includes("01-session.md"));
    expect(created).toBeDefined();

    const content = await readFile(join(dir, ".story", "handovers", created!), "utf-8");
    expect(content).toBe("# Session\nDone.");
  });

  it("generates globally monotonic sequence numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const r1 = await handleHandoverCreate("First", "session", "md", dir);
    expect(r1.output).toMatch(/01-session\.md/);

    const r2 = await handleHandoverCreate("Second", "notes", "md", dir);
    expect(r2.output).toMatch(/02-notes\.md/);

    const r3 = await handleHandoverCreate("Third", "session", "md", dir);
    expect(r3.output).toMatch(/03-session\.md/);
  });

  it("normalizes slug in filename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleHandoverCreate("Content", "Phase 5B Wrapup!", "md", dir);
    expect(result.output).toMatch(/01-phase-5b-wrapup\.md/);
  });

  it("returns JSON format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleHandoverCreate("# Notes", "session", "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.filename).toMatch(/01-session\.md/);
  });

  it("rejects empty content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await expect(
      handleHandoverCreate("", "session", "md", dir),
    ).rejects.toThrow("empty");
  });

  it("rejects whitespace-only content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await expect(
      handleHandoverCreate("   \n  ", "session", "md", dir),
    ).rejects.toThrow("empty");
  });

  it("rejects invalid slug", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await expect(
      handleHandoverCreate("content", "###", "md", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("sequenced files sort after legacy files on same date", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    // Simulate a legacy handover (no sequence number)
    const handoversDir = join(dir, ".story", "handovers");
    await writeFile(join(handoversDir, "2026-03-21-legacy-notes.md"), "old content");

    // Create a new sequenced handover
    await handleHandoverCreate("new content", "session", "md", dir);

    const files = await readdir(handoversDir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();
    // Legacy file: 2026-03-21-legacy-notes.md
    // Sequenced: 2026-03-21-01-session.md
    // In reverse lex, "l" > "0" so legacy sorts first. But our custom sort
    // should put sequenced files first. Verify via listHandovers.
    const { listHandovers } = await import("../../../src/core/handover-parser.js");
    const warnings: Array<{ type: string; file: string; message: string }> = [];
    const sorted = await listHandovers(handoversDir, dir, warnings);
    // Sequenced file should be first (newest)
    expect(sorted[0]).toMatch(/01-session\.md/);
  });

  it("handover latest returns most recently created regardless of slug", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-test-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await handleHandoverCreate("First", "zzz", "md", dir);
    await handleHandoverCreate("Second", "aaa", "md", dir);

    // Second created file (02-aaa) should sort after first (01-zzz) in reverse lex
    // because 02 > 01, so handover latest returns the second-created file
    const files = await readdir(join(dir, ".story", "handovers"));
    const sorted = files.filter((f) => f.endsWith(".md")).sort().reverse();
    expect(sorted[0]).toMatch(/02-aaa\.md/);
  });
});

describe("ISS-1185: handleHandoverCreate's stamped-root diagnostic", () => {
  function bindCallerAt(root: string): void {
    const era = processEra.current()!.id;
    const now = new Date().toISOString();
    const entry = { era, pid: process.pid, startedAt: processEra.current()!.startedAt, captureKind: "startup" as const, autoCompactWindowAtStart: 450_000, autoCompactWindowSource: "user" as const, capturedAt: now, endedAt: null, lastVerifiedAt: now, unverifiableStreak: 0, sessionIds: [SID] };
    createEraIfAbsent(root, entry);
    const r = applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...emptySessionIntel(), era } }));
    expect(r.status).toBe("written");
  }

  /**
   * ISS-1197 commit 2: a fresh, reconcilable compact-needed sample. `sampledAt`
   * is the caller's argument so the test can put it inside the 30 s freshness
   * window the stamp now requires.
   */
  function compactNeededSample(sampledAt: string): SessionIntelSample {
    return {
      sampledAt,
      sampledBy: "stop-hook",
      state: "compact-needed",
      rawState: "compact-needed",
      pct: 0.985,
      contextTokens: 410_000,
      ceiling: 416_250,
      ceilingSource: "setting",
      ceilingConfidence: "high",
      observation: {
        era: null,
        incarnation: "1:1",
        sizeAtOpen: 10,
        consumedOffset: 10,
        anchor: { offset: 10, sha256: "a".repeat(64) },
        authoritative: true,
        revisionSeen: 0,
        lastRecordTimestamp: sampledAt,
        epoch: { kind: "unobserved" },
      },
      imperativeSince: sampledAt,
      suppressedBy: null,
      usageInput: null,
    };
  }

  it("reports the stamped root (MD parenthetical, JSON tokenPressureStampedRoot) only when it diverges from the MCP root", async () => {
    const wt = makeWorktreePair("hc-wt-");
    const saved = { CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID, CLAUDE_PID: process.env.CLAUDE_PID };
    try {
      await initProject(wt.main, { name: "hc-main" });
      await initProject(wt.worktree, { name: "hc-wt" });
      process.env.CLAUDE_CODE_SESSION_ID = SID;
      process.env.CLAUDE_PID = String(process.pid);
      processEra.reset();
      // The caller's record lives ONLY under the worktree: the MCP root (main) has none.
      bindCallerAt(wt.worktree);
      expect(readPresenceRecord(wt.main, SID)).toBeNull();

      const md = await handleHandoverCreate("# H\nDone.", "session", "md", wt.main);
      expect(md.output).toMatch(/\n\nHandover recorded[:.]/);
      expect(md.output).toMatch(new RegExp(`\\(stamped under a different root: ${wt.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
      expect(readPresenceRecord(wt.worktree, SID)!.sessionIntel!.handoverWrittenAt).not.toBeNull();

      // A second call, bound the same way, checked in JSON.
      const json = await handleHandoverCreate("# H2", "session-json", "json", wt.main);
      const parsed = JSON.parse(json.output as string) as { data: { tokenPressureStamped?: boolean; tokenPressureStampedRoot?: string } };
      expect(parsed.data.tokenPressureStamped).toBe(true);
      expect(parsed.data.tokenPressureStampedRoot).toBe(wt.worktree);

      // ISS-1197 commit 2: compact-needed AND a diverged root in one reply.
      // The parenthetical is appended to whichever line was chosen, so a
      // divergence must not silently restore the covering wording.
      const at = new Date().toISOString();
      applyPresenceEnrichment(wt.worktree, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({
        ...b,
        sessionIntel: { ...b.sessionIntel!, handoverWrittenAt: null, tokensAtHandover: null, handoverBoundaryAt: null, lastSample: compactNeededSample(at) },
      }));
      const both = await handleHandoverCreate("# H-compact", "session-compact", "md", wt.main);
      expect(both.output).toMatch(/Handover recorded\. Auto-compaction is close and expected: keep working through it\./);
      expect(both.output).not.toMatch(/held at advisory|will not ask again/);
      expect(both.output).toMatch(new RegExp(`\\(stamped under a different root: ${wt.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));

      // A record found directly under the MCP root itself: no divergence note.
      bindCallerAt(wt.main);
      const direct = await handleHandoverCreate("# H3", "session-direct", "md", wt.main);
      expect(direct.output).toMatch(/\n\nHandover recorded[:.]/);
      expect(direct.output).not.toMatch(/stamped under a different root/);
      const directJson = await handleHandoverCreate("# H4", "session-direct-json", "json", wt.main);
      const parsedDirect = JSON.parse(directJson.output as string) as { data: { tokenPressureStamped?: boolean; tokenPressureStampedRoot?: string } };
      expect(parsedDirect.data.tokenPressureStamped).toBe(true);
      expect(parsedDirect.data.tokenPressureStampedRoot).toBeUndefined();
    } finally {
      if (saved.CLAUDE_CODE_SESSION_ID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved.CLAUDE_CODE_SESSION_ID;
      if (saved.CLAUDE_PID === undefined) delete process.env.CLAUDE_PID; else process.env.CLAUDE_PID = saved.CLAUDE_PID;
      processEra.reset();
      wt.cleanup();
    }
  });
});

describe("handleHandoverTemplate", () => {
  it("renders a scaffold with no prior handovers", async () => {
    const ctx = makeCtx();
    const result = await handleHandoverTemplate(ctx);
    expect(result.output).toContain("<!-- storybloq-handover v1 -->");
    expect(result.output).toContain("## Carried forward");
    expect(result.output).toContain("- (nothing carried forward)");
  });

  it("carries an open continuation id forward with its first-seen date", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    await writeFile(
      join(handoversDir, "2026-06-01-session.md"),
      "# Handover: session\n\n## Next\n- T-910: still going\n",
    );

    const ctx = makeCtx({
      state: makeState({ handoverFilenames: ["2026-06-01-session.md"] }),
      handoversDir,
    });
    const result = await handleHandoverTemplate(ctx);
    expect(result.output).toContain("T-910: still going (carried since 2026-06-01)");
  });

  it("preserves an earlier carried-since date recorded by the previous template run", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    // The newest handover already carries the marker and an earlier date for
    // T-910 than the trajectory's own firstSeenInWindow would derive here.
    await writeFile(
      join(handoversDir, "2026-06-10-session.md"),
      [
        "<!-- storybloq-handover v1 -->",
        "",
        "# Session Handover",
        "",
        "## Next",
        "- T-910: still going",
        "",
        "## Carried forward",
        "",
        "- T-910: still going (carried since 2026-01-01)",
        "",
      ].join("\n"),
    );

    const ctx = makeCtx({
      state: makeState({ handoverFilenames: ["2026-06-10-session.md"] }),
      handoversDir,
    });
    const result = await handleHandoverTemplate(ctx);
    expect(result.output).toContain("T-910: still going (carried since 2026-01-01)");
  });

  it("renders a validated override line", async () => {
    const ctx = makeCtx();
    const result = await handleHandoverTemplate(ctx, {
      override: "recommended=T-1 worked=T-2 because=owner said so",
    });
    expect(result.output).toContain("Override: recommended=T-1 worked=T-2 because=owner said so");
  });

  it("rejects a malformed override grammar", async () => {
    const ctx = makeCtx();
    await expect(
      handleHandoverTemplate(ctx, { override: "recommended=T-1 worked=T-2" }),
    ).rejects.toThrow(CliValidationError);
  });

  it("returns valid JSON when format is json", async () => {
    const ctx = makeCtx({ format: "json" });
    const result = await handleHandoverTemplate(ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.content).toContain("<!-- storybloq-handover v1 -->");
  });

  it("Codex finding: rejects a symlinked newest handover instead of reading through it", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    const secretPath = join(tmpDir, "secret.md");
    await writeFile(secretPath, "outside the handovers directory");
    await symlink(secretPath, join(handoversDir, "2026-06-01-session.md"));

    const ctx = makeCtx({
      state: makeState({ handoverFilenames: ["2026-06-01-session.md"] }),
      handoversDir,
    });
    await expect(handleHandoverTemplate(ctx)).rejects.toThrow(CliValidationError);
  });

  it("Codex finding: a real read failure inside buildHandoverBrief's own window propagates instead of rendering a falsely-empty scaffold", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "handover-test-"));
    const handoversDir = join(tmpDir, "handovers");
    await mkdir(handoversDir, { recursive: true });
    // A valid newest handover (so the newest-handover readHandover call
    // above succeeds and is not what this test exercises) ...
    await writeFile(
      join(handoversDir, "2026-06-02-session.md"),
      "# Handover: session\n\n## Next\n- T-911: still going\n",
    );
    // ... plus a directory second in the window where a handover file is
    // expected: not ENOENT (tolerated), so buildHandoverBrief must
    // propagate it as a real failure, not collapse into a successful
    // "(nothing carried forward)" render.
    await mkdir(join(handoversDir, "2026-06-01-session.md"));

    const ctx = makeCtx({
      state: makeState({ handoverFilenames: ["2026-06-02-session.md", "2026-06-01-session.md"] }),
      handoversDir,
    });
    await expect(handleHandoverTemplate(ctx)).rejects.toThrow();
  });
});
