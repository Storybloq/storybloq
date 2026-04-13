import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCacheKey,
  getFromCache,
  writeToCache,
  clearCache,
  getCacheMetrics,
  resetCacheMetrics,
} from "../../../src/autonomous/review-lenses/cache.js";
import type { LensFinding } from "../../../src/autonomous/review-lenses/types.js";

let sessionDir: string;

const finding: LensFinding = {
  lens: "security",
  lensVersion: "security-v1",
  severity: "critical",
  recommendedImpact: "blocker",
  category: "injection",
  description: "test finding",
  file: "src/api.ts",
  line: 10,
  evidence: [
    {
      file: "src/api.ts",
      startLine: 10,
      endLine: 10,
      code: "db.query('SELECT * FROM users')",
    },
  ],
  suggestedFix: null,
  confidence: 0.9,
  assumptions: null,
  requiresMoreContext: false,
};

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "lens-cache-test-"));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("lens cache", () => {
  it("returns null for cache miss", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    expect(getFromCache(sessionDir, key)).toBeNull();
  });

  it("stores and retrieves findings", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    writeToCache(sessionDir, key, [finding]);
    const cached = getFromCache(sessionDir, key);
    expect(cached).toHaveLength(1);
    expect(cached![0].category).toBe("injection");
  });

  it("produces different keys for different file content", () => {
    const k1 = buildCacheKey("security", "v1", "CODE_REVIEW", "contentA", "desc", "rules", "fps");
    const k2 = buildCacheKey("security", "v1", "CODE_REVIEW", "contentB", "desc", "rules", "fps");
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different lens versions", () => {
    const k1 = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const k2 = buildCacheKey("security", "v2", "CODE_REVIEW", "content", "desc", "rules", "fps");
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different stages", () => {
    const k1 = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const k2 = buildCacheKey("security", "v1", "PLAN_REVIEW", "content", "desc", "rules", "fps");
    expect(k1).not.toBe(k2);
  });

  it("clearCache removes all cached entries", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    writeToCache(sessionDir, key, [finding]);
    expect(getFromCache(sessionDir, key)).not.toBeNull();
    clearCache(sessionDir);
    expect(getFromCache(sessionDir, key)).toBeNull();
  });

  it("clearCache is safe on non-existent directory", () => {
    clearCache(join(sessionDir, "nonexistent"));
    // No throw
  });

  it("handles empty findings array", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    writeToCache(sessionDir, key, []);
    const cached = getFromCache(sessionDir, key);
    expect(cached).toHaveLength(0);
  });
});

// ── CDX-19 cache invalidation contract ──────────────────────────────

describe("lens cache CDX-19 invalidation contract", () => {
  beforeEach(() => {
    resetCacheMetrics();
  });

  function writeRawCacheEntry(key: string, payload: unknown): void {
    const dir = join(sessionDir, "lens-cache");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({ findings: payload, timestamp: new Date().toISOString() }),
    );
  }

  it("skips invalid findings, returns only valid siblings (CDX-19.1)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const goodA = finding;
    const badZod = { ...finding, evidence: [] }; // empty array rejected by Zod
    const goodB = { ...finding, description: "another finding" };
    writeRawCacheEntry(key, [goodA, badZod, goodB]);
    const cached = getFromCache(sessionDir, key);
    expect(cached).toHaveLength(2);
    const descriptions = (cached ?? []).map((f) => f.description);
    expect(descriptions).toContain("test finding");
    expect(descriptions).toContain("another finding");
  });

  it("increments cache_validation_skip_total by one per invalid finding (CDX-19.2)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const badA = { ...finding, evidence: [] };
    const badB = { ...finding, evidence: undefined };
    const good = finding;
    writeRawCacheEntry(key, [good, badA, badB]);
    getFromCache(sessionDir, key);
    expect(getCacheMetrics().cache_validation_skip_total).toBe(2);
  });

  it("emits exactly one structured warn log line per invalid entry (CDX-19.3)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const bad = { ...finding, evidence: [] };
    writeRawCacheEntry(key, [finding, bad]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    getFromCache(sessionDir, key);
    const warnCalls = warnSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === "string" && first.includes("cache_validation_skip");
    });
    expect(warnCalls).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("does not rewrite the cache file on invalidation (CDX-19.4)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const bad = { ...finding, evidence: [] };
    writeRawCacheEntry(key, [finding, bad]);
    const path = join(sessionDir, "lens-cache", `${key}.json`);
    const before = readFileSync(path, "utf-8");
    getFromCache(sessionDir, key);
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(before);
  });

  it("passes surviving valid findings through unchanged with passthrough fields intact (CDX-19.5)", () => {
    const key = buildCacheKey("security", "v1", "CODE_REVIEW", "content", "desc", "rules", "fps");
    const goodWithMeta = {
      ...finding,
      issueKey: "k-A",
      blocking: true,
      origin: "introduced",
    };
    const bad = { ...finding, evidence: [] };
    writeRawCacheEntry(key, [goodWithMeta, bad]);
    const cached = getFromCache(sessionDir, key);
    expect(cached).toHaveLength(1);
    const survivor = cached![0] as LensFinding & {
      issueKey?: string;
      blocking?: boolean;
      origin?: string;
    };
    expect(survivor.issueKey).toBe("k-A");
    expect(survivor.blocking).toBe(true);
    expect(survivor.origin).toBe("introduced");
  });
});
