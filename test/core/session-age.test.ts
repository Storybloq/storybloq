/**
 * Shared directory-age classification (ISS-945).
 *
 * `computeSessionDirAge` is the ONE helper the scanner and the CLI both call
 * to decide whether a `state.json`-less directory is aged past
 * `AGED_ANOMALY_WINDOW_MS`. These tests pin its own contract in isolation,
 * independent of either caller: `lstat`-only (never follows a symlink),
 * iterative (bounded by explicit caps, not recursion depth), and `unknown`
 * on any ambiguity -- never resolved toward "safe to act on".
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSessionDirAge, AGED_ANOMALY_WINDOW_MS } from "../../src/core/session-age.js";
import { boundedList } from "../../src/core/bounded-list.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-session-age-"));
  roots.push(root);
  return root;
}

describe("computeSessionDirAge", () => {
  it("reports a real, non-aged age for a fresh directory", () => {
    const dir = makeDir();
    const now = Date.now();
    const result = computeSessionDirAge(dir, now);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      expect(result.ageMs).toBeGreaterThanOrEqual(0);
      expect(result.ageMs).toBeLessThan(AGED_ANOMALY_WINDOW_MS);
    }
  });

  it("classifies exactly at the boundary as aged (>=, not >)", () => {
    const dir = makeDir();
    const t0 = Date.now();
    const result = computeSessionDirAge(dir, t0 + AGED_ANOMALY_WINDOW_MS);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      expect(result.ageMs).toBeGreaterThanOrEqual(AGED_ANOMALY_WINDOW_MS);
    }
  });

  it("simulates age via an injected `now` rather than backdating real timestamps", () => {
    // Backdating via `utimesSync` does not work for this purpose: changing a
    // file's mtime is itself a metadata change, so the OS bumps `ctimeMs` to
    // the real current time, which `computeSessionDirAge` also takes the max
    // over -- defeating the backdate. Injecting a future `now` instead is the
    // same technique `deriveLeaseState` uses and needs no filesystem trickery.
    const dir = makeDir();
    const t0 = Date.now();
    const farFuture = t0 + AGED_ANOMALY_WINDOW_MS * 3;
    const result = computeSessionDirAge(dir, farFuture);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      expect(result.ageMs).toBeGreaterThanOrEqual(AGED_ANOMALY_WINDOW_MS);
    }
  });

  it("a recent nested file prevents the tree from reading as aged, even though the top directory's own metadata is old relative to `now`", async () => {
    const dir = makeDir();
    const t0 = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(join(dir, "nested-file"), "fresh content");
    const t1 = Date.now();
    const now = t0 + AGED_ANOMALY_WINDOW_MS + 100;
    // Sanity: the injected `now` really does put the top directory alone past
    // the window, and the nested file's real write time within it.
    expect(now - t0).toBeGreaterThanOrEqual(AGED_ANOMALY_WINDOW_MS);
    expect(now - t1).toBeLessThan(AGED_ANOMALY_WINDOW_MS);

    const result = computeSessionDirAge(dir, now);
    expect(result.kind).toBe("known");
    if (result.kind === "known") {
      // Dominated by the fresh nested file's timestamp (the max across the
      // tree), not the directory's own old-relative-to-`now` metadata.
      expect(result.ageMs).toBeLessThan(AGED_ANOMALY_WINDOW_MS);
    }
  });

  it("returns unknown when a timestamp is in the future relative to `now`", () => {
    const dir = makeDir();
    // A `now` earlier than the directory's real (current) ctime/mtime makes
    // every one of its own timestamps read as "future" relative to it.
    const now = Date.now() - 60_000;
    const result = computeSessionDirAge(dir, now);
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toContain("future");
    }
  });

  it("returns unknown for a symlinked descendant, never following it", () => {
    const dir = makeDir();
    const outside = makeDir();
    writeFileSync(join(outside, "target"), "elsewhere");
    symlinkSync(join(outside, "target"), join(dir, "link"));
    const result = computeSessionDirAge(dir, Date.now());
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toContain("symlink");
    }
  });

  it("returns unknown for a symlinked directory itself, not only a symlinked descendant", () => {
    const outside = makeDir();
    const link = join(makeDir(), "link-to-outside");
    symlinkSync(outside, link);
    const result = computeSessionDirAge(link, Date.now());
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toContain("symlink");
    }
  });

  it("returns unknown when the directory itself cannot be stat'd", () => {
    const dir = join(makeDir(), "does-not-exist");
    const result = computeSessionDirAge(dir, Date.now());
    expect(result.kind).toBe("unknown");
  });

  it("returns unknown once the entry-count traversal cap is exceeded, never partial", () => {
    const dir = makeDir();
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}`), "x");
    const result = computeSessionDirAge(dir, Date.now(), { maxEntries: 5, maxDepth: 32 });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toMatch(/entries/i);
    }
  });

  it("returns unknown once the depth traversal cap is exceeded, never partial", () => {
    const dir = makeDir();
    let nested = dir;
    for (let i = 0; i < 5; i++) {
      nested = join(nested, `d${i}`);
      mkdirSync(nested);
    }
    const result = computeSessionDirAge(dir, Date.now(), { maxEntries: 5000, maxDepth: 2 });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.reason).toMatch(/depth/i);
    }
  });

  it("a traversal cap and an output/preview cap are independent -- a directory with many entries still gets a real age, and a preview list over the same names still reports a truncated count", () => {
    const dir = makeDir();
    const names: string[] = [];
    for (let i = 0; i < 30; i++) {
      const name = `entry-${i}`;
      writeFileSync(join(dir, name), "x");
      names.push(name);
    }
    // Well under the traversal cap, so age is real, not unknown.
    const age = computeSessionDirAge(dir, Date.now(), { maxEntries: 5000, maxDepth: 32 });
    expect(age.kind).toBe("known");

    // A SEPARATE, purely cosmetic output cap on a rendered preview of the same
    // names never touches the age result above -- proven by using the
    // existing, independent `boundedList` utility, not a mechanism coupled to
    // `computeSessionDirAge`.
    const preview = boundedList(names, { budget: 40 });
    expect(preview).toMatch(/showing \d+ of 30/);
    expect(age.kind).toBe("known");
  });
});
