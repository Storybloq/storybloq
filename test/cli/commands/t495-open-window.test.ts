/**
 * T-495 WRITER: `storybloq review-stats --open-window` and the config shape it
 * writes.
 *
 * The window is what stops the first live run from being INVALID before it
 * starts. Without one, every artifact this repository already holds precedes
 * the feature and becomes an exclusion, so the exclusion rate is over ninety
 * percent on day one and no measurement is possible. It is also IMMUTABLE by
 * construction: a population that can be re-based after the fact cannot support
 * a threshold verdict about itself.
 *
 * The reader half (`--close-window`, the verdict, the divergence observations)
 * ships in the second commit. Only opening is here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleReviewStats } from "../../../src/cli/commands/review-stats.js";
import { openContractWindow, readContractWindow } from "../../../src/core/review-stats-window.js";
import * as loaded from "../../../src/autonomous/review-contract.js";
import { outsideProjectLock, withProjectLock } from "../../../src/core/project-loader.js";
import type { CommandContext } from "../../../src/cli/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CONTRACT = "# Review contract\n\n## Robustness\n\nBehaves.\n\nBlocking: blocking\n";

/**
 * A REAL project, not just a config file. `openContractWindow` takes the
 * project lock, which loads the project, so a config-only fixture makes the
 * open fail for a reason that has nothing to do with what is being tested.
 */
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "t495-window-"));
  dirs.push(root);
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }, null, 2));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-21",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }, null, 2));
  writeFileSync(join(root, "REVIEW.md"), CONTRACT, "utf-8");
  return root;
}

function ctxFor(root: string): CommandContext {
  return { root } as unknown as CommandContext;
}

function config(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
}

describe("T-495: --open-window", () => {
  it("writes contractMeasurement with the contract's own hash as the baseline", async () => {
    const root = newRoot();
    const res = await handleReviewStats({ openWindow: true }, ctxFor(root));
    expect(res.exitCode ?? 0).toBe(0);
    const cm = config(root).contractMeasurement as Record<string, unknown>;
    expect(cm).toBeDefined();
    expect(typeof cm.openedAt).toBe("string");
    expect(cm.closedAt).toBeNull();
    expect(cm.roots).toEqual([root]);
    // The baseline is the hash the parser computed from the same read that
    // produced the text. A second hash taken here could name a file that
    // changed between the two reads.
    const { createHash } = await import("node:crypto");
    expect(cm.baselineHash)
      .toBe(createHash("sha256").update(Buffer.from(CONTRACT, "utf-8")).digest("hex"));
  });

  it("T41: refuses to run twice, so a week cannot be silently re-based", async () => {
    const root = newRoot();
    await handleReviewStats({ openWindow: true }, ctxFor(root));
    const first = config(root).contractMeasurement as Record<string, unknown>;

    // The contract CHANGES before the second attempt, so a refusal that still
    // rewrote the record would produce a visibly different baseline rather than
    // an accidentally identical one. Without this, a rewrite in the same
    // millisecond against an unchanged file is indistinguishable from a refusal.
    writeFileSync(join(root, "REVIEW.md"), `${CONTRACT}\n## Quality\n\nQ.\n\nBlocking: major\n`, "utf-8");
    const before = readFileSync(join(root, ".story", "config.json"), "utf-8");

    const second = await handleReviewStats({ openWindow: true }, ctxFor(root));
    // An explicit NON-ZERO code. `not.toBe(0)` accepts `undefined`, which is
    // what an unimplemented flag returns, and that weakness was corrected in
    // one test here and left in this one; Codex found the survivor.
    expect(typeof second.exitCode).toBe("number");
    expect(second.exitCode!).toBeGreaterThan(0);
    expect(second.output).toMatch(/already open|already been opened/i);
    // BYTE-identical, not merely deep-equal: a rewrite that reordered keys or
    // changed formatting would still be a rewrite of an immutable record.
    expect(readFileSync(join(root, ".story", "config.json"), "utf-8")).toBe(before);
    expect(config(root).contractMeasurement).toEqual(first);
  });

  it("refuses to open a window with no contract to baseline against", async () => {
    const root = newRoot();
    rmSync(join(root, "REVIEW.md"));
    const res = await handleReviewStats({ openWindow: true }, ctxFor(root));
    // An explicit NON-ZERO code, not merely "not zero": an unrecognised option
    // returns `undefined`, which satisfies `not.toBe(0)` while proving that the
    // flag was never implemented. That vacuous pass is this ticket's own
    // failure class pointed at its tests.
    expect(typeof res.exitCode).toBe("number");
    expect(res.exitCode!).toBeGreaterThan(0);
    expect(res.output).toMatch(/REVIEW\.md|contract/i);
    // Opening against a null baseline would make every delivered hash unequal
    // to it, so every round would read as delivery-unverified for a reason
    // that is about the window rather than about the round.
    expect(config(root).contractMeasurement).toBeUndefined();
  });

  it("is PRESERVED through ConfigSchema, and is declared rather than relying on passthrough", async () => {
    // Two separate claims, because the first alone does not establish the
    // second. The top level is `.passthrough()`, so preservation would hold
    // even with the declaration deleted; the earlier version of this test
    // asserted only preservation while its comment claimed the declaration was
    // what did the work, and attributed `recipeOverrides`' stripping to the top
    // level besides. Codex found it.
    const root = newRoot();
    await handleReviewStats({ openWindow: true }, ctxFor(root));
    expect(config(root).contractMeasurement).toBeDefined();
    const { ConfigSchema } = await import("../../../src/models/config.js");
    const parsed = ConfigSchema.parse(config(root)) as Record<string, unknown>;
    expect(parsed.contractMeasurement).toEqual(config(root).contractMeasurement);

    // The DECLARATION, asserted directly. It is what guarantees a future
    // tightening of the top-level object cannot silently drop the window, and
    // it is what validates the shape rather than carrying anything through.
    expect(ConfigSchema.shape.contractMeasurement).toBeDefined();
    const bad = { ...config(root), contractMeasurement: { openedAt: 42 } };
    expect(() => ConfigSchema.parse(bad)).toThrow();
  });

  it("refuses to open against a contract the evaluator would NOT apply", async () => {
    // Readable and hashable is not enough. An unparseable contract opens an
    // IMMUTABLE week whose baseline declares nothing usable, and every delivered
    // hash matching it then reads as verified delivery of a contract that
    // decides nothing. Codex found it. Two shapes, because they fail for
    // different reasons and only one is empty.
    for (const [label, text] of [
      ["empty", ""],
      ["invalid declaration", `${CONTRACT}\n## Housekeeping\n\nX.\n\nBlocking: nit\n`],
    ] as const) {
      const root = newRoot();
      writeFileSync(join(root, "REVIEW.md"), text, "utf-8");
      const res = await handleReviewStats({ openWindow: true }, ctxFor(root));
      expect(typeof res.exitCode, label).toBe("number");
      expect(res.exitCode!, label).toBeGreaterThan(0);
      expect(config(root).contractMeasurement, label).toBeUndefined();
    }
  });

  it("leaves the rest of the config untouched, byte-for-byte apart from the new key", async () => {
    // The open is a read-modify-write of the whole file. Anything it drops is
    // silently destroyed project configuration, and this command has no reason
    // to touch a single other field.
    const root = newRoot();
    const cfg = config(root);
    cfg.recipeOverrides = { maxTicketsPerSession: 3, blockingPolicy: { neverBlock: ["style"] } };
    cfg.someFutureKey = { nested: [1, 2, 3] };
    writeFileSync(join(root, ".story", "config.json"), JSON.stringify(cfg, null, 2));

    const res = await handleReviewStats({ openWindow: true }, ctxFor(root));
    // The open really SUCCEEDED. Without this the whole comparison below holds
    // trivially on a refusal that wrote nothing at all, which is a pass that
    // establishes nothing.
    expect(res.exitCode ?? 0).toBe(0);
    const after = config(root);
    expect(after.contractMeasurement).toBeDefined();
    expect(after.recipeOverrides).toEqual(cfg.recipeOverrides);
    expect(after.someFutureKey).toEqual(cfg.someFutureKey);
    const { contractMeasurement: _added, ...rest } = after;
    expect(rest).toEqual(cfg);
  });
});

describe("T-495: the baseline is captured UNDER the lock", () => {
  it("the baseline callback runs while `.story/.lock` is held", async () => {
    // A hash captured BEFORE the lock is acquired describes REVIEW.md as it was
    // before the wait. If the file changes while this command queues, the
    // window opens immutably against the old bytes and every delivery of the
    // contract actually in force then fails baseline verification for the whole
    // week. Codex found it AFTER the lock had already been added: taking a lock
    // does not help if the value it protects was read outside it.
    const root = newRoot();
    let lockHeldWhenBaselineRan: boolean | null = null;
    const opened = await openContractWindow(root, {
      roots: [root],
      baseline: () => {
        lockHeldWhenBaselineRan = existsSync(join(root, ".story", ".lock"));
        return { ok: true, hash: "deadbeef" };
      },
    });
    expect(opened.ok).toBe(true);
    expect(lockHeldWhenBaselineRan).toBe(true);
    expect((config(root).contractMeasurement as Record<string, unknown>).baselineHash)
      .toBe("deadbeef");
  });

  it("a REVIEW.md edited before the callback runs is the one that gets recorded", async () => {
    // The consequence of the ordering, stated as behaviour rather than as
    // timing: whatever the callback reads is what the immutable record names.
    const root = newRoot();
    const edited = `${CONTRACT}\n## Quality\n\nQ.\n\nBlocking: major\n`;
    const opened = await openContractWindow(root, {
      roots: [root],
      baseline: () => {
        writeFileSync(join(root, "REVIEW.md"), edited, "utf-8");
        const { loadReviewContract } = loaded;
        return { ok: true, hash: loadReviewContract(root).contentHash! };
      },
    });
    expect(opened.ok).toBe(true);
    const { createHash } = await import("node:crypto");
    expect((config(root).contractMeasurement as Record<string, unknown>).baselineHash)
      .toBe(createHash("sha256").update(Buffer.from(edited, "utf-8")).digest("hex"));
  });

  it("through the CLI: a REVIEW.md changed while the opener WAITS is the one recorded", async () => {
    // The three tests around this one call `openContractWindow` directly with a
    // test-supplied callback, so they would all still pass if
    // `handleReviewStats` regressed to loading REVIEW.md before acquiring the
    // lock and handing over a cached hash. Codex found that in round 3: the
    // ordering was proven for the core function and never for the CLI path that
    // is the actual subject of the race.
    //
    // So the lock is held HERE, the opener is started against it and blocks,
    // REVIEW.md changes during that wait, and the recorded baseline has to be
    // the CHANGED file. Under the regression it would be the original.
    const root = newRoot();
    const originalHash = loaded.loadReviewContract(root).contentHash;
    const edited = `${CONTRACT}\n## Quality\n\nQ.\n\nBlocking: major\n`;
    const { createHash } = await import("node:crypto");
    const editedHash = createHash("sha256").update(Buffer.from(edited, "utf-8")).digest("hex");
    expect(editedHash).not.toBe(originalHash);

    let opening: Promise<{ exitCode?: number; output: string }> | undefined;
    await withProjectLock(root, { strict: false }, async () => {
      // Starts, reaches the lock, and waits: the lock is held by this block.
      // Outside this block's lock context, as a second process would be (T-538 nested_lock).
      opening = outsideProjectLock(() => handleReviewStats({ openWindow: true }, ctxFor(root))) as never;
      await new Promise((r) => setTimeout(r, 50));
      // The contract in force changes DURING the wait.
      writeFileSync(join(root, "REVIEW.md"), edited, "utf-8");
      await new Promise((r) => setTimeout(r, 50));
      // Still blocked: nothing has been written yet.
      expect(config(root).contractMeasurement).toBeUndefined();
    });

    const res = await opening!;
    expect(res.exitCode ?? 0).toBe(0);
    const cm = config(root).contractMeasurement as Record<string, unknown>;
    expect(cm.baselineHash).toBe(editedHash);
    expect(cm.baselineHash).not.toBe(originalHash);
  }, 20_000);

  it("a refusal from the baseline callback leaves the config untouched", async () => {
    const root = newRoot();
    const before = readFileSync(join(root, ".story", "config.json"), "utf-8");
    const opened = await openContractWindow(root, {
      roots: [root],
      baseline: () => ({ ok: false, reason: "the contract is not usable" }),
    });
    expect(opened.ok).toBe(false);
    expect(readFileSync(join(root, ".story", "config.json"), "utf-8")).toBe(before);
  });
});

describe("T-495: reading the window back", () => {
  it("reads an absent window as absent rather than as a malformed one", () => {
    expect(readContractWindow(newRoot())).toBeNull();
  });

  it("reads a written window back with every field", async () => {
    const root = newRoot();
    await handleReviewStats({ openWindow: true }, ctxFor(root));
    const w = readContractWindow(root);
    expect(w).not.toBeNull();
    expect(w!.closedAt).toBeNull();
    expect(typeof w!.baselineHash).toBe("string");
    expect(w!.roots).toEqual([root]);
  });

  it("reads a MALFORMED window as absent, never as a partially usable one", () => {
    const root = newRoot();
    const cfg = config(root);
    cfg.contractMeasurement = { openedAt: 42, baselineHash: null };
    writeFileSync(join(root, ".story", "config.json"), JSON.stringify(cfg));
    // A half-read window would let the reader select a population against a
    // start time it invented, which is worse than having no window at all.
    expect(readContractWindow(root)).toBeNull();
  });
});
