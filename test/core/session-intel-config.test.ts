import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SESSION_INTEL_CONFIG,
  SESSION_INTEL_BOUNDS,
  readSessionIntelConfig,
  resolveSessionIntelConfig,
} from "../../src/core/session-intel/config.js";
import { SessionIntelConfigSchema, ConfigSchema } from "../../src/models/config.js";
import { minimalConfig } from "./test-factories.js";

function withProject(config: unknown, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "si-config-"));
  try {
    mkdirSync(join(root, ".story"), { recursive: true });
    if (config !== undefined) {
      writeFileSync(join(root, ".story", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("sessionIntel config: hot-path reader", () => {
  it("absent block, absent file, and malformed file are the defaults with no notes", () => {
    for (const body of [undefined, "{}", "{not json", JSON.stringify({ sessionIntel: 7 }), JSON.stringify({ sessionIntel: [1] })]) {
      withProject(body, (root) => {
        const cfg = readSessionIntelConfig(root);
        expect(cfg).toEqual({ ...DEFAULT_SESSION_INTEL_CONFIG, notes: [] });
      });
    }
  });

  it("takes in-bounds values as written", () => {
    const cfg = resolveSessionIntelConfig({
      enabled: false, advisoryPct: 0.6, imperativePct: 0.9, ceilingFraction: 0.9, boundarySampleCount: 5,
      jumpAllowanceFloorTokens: 10_000, jumpAllowanceCapTokens: 20_000, maxSampleAgeMs: 0, compactPendingTtlMs: 10_000,
      stepPct: 0.1, banner: false, promptHook: false, guideDirective: false,
    });
    expect(cfg.notes).toEqual([]);
    expect(cfg.enabled).toBe(false);
    expect(cfg.advisoryPct).toBe(0.6);
    expect(cfg.imperativePct).toBe(0.9);
    expect(cfg.boundarySampleCount).toBe(5);
    expect(cfg.jumpAllowanceFloorTokens).toBe(10_000);
    expect(cfg.maxSampleAgeMs).toBe(0);
    expect(cfg.banner).toBe(false);
  });

  it("an out-of-bounds, non-integer, non-finite or wrong-typed number falls back per field with a note", () => {
    const cfg = resolveSessionIntelConfig({
      advisoryPct: 0.99, boundarySampleCount: 2.5, maxSampleAgeMs: "10", stepPct: Number.NaN, compactPendingTtlMs: 1,
    });
    expect(cfg.advisoryPct).toBe(DEFAULT_SESSION_INTEL_CONFIG.advisoryPct);
    expect(cfg.boundarySampleCount).toBe(DEFAULT_SESSION_INTEL_CONFIG.boundarySampleCount);
    expect(cfg.maxSampleAgeMs).toBe(DEFAULT_SESSION_INTEL_CONFIG.maxSampleAgeMs);
    expect(cfg.stepPct).toBe(DEFAULT_SESSION_INTEL_CONFIG.stepPct);
    expect(cfg.compactPendingTtlMs).toBe(DEFAULT_SESSION_INTEL_CONFIG.compactPendingTtlMs);
    expect(cfg.notes).toHaveLength(5);
    for (const key of ["advisoryPct", "boundarySampleCount", "maxSampleAgeMs", "stepPct", "compactPendingTtlMs"]) {
      expect(cfg.notes.some((n) => n.includes(`sessionIntel.${key}`))).toBe(true);
    }
  });

  it("ISS-1197: the three handover re-arm keys default, are taken as written, and clamp per field", () => {
    expect(resolveSessionIntelConfig(null)).toMatchObject({ handoverRearmStepCapTokens: 25_000, handoverRearmIntervalMs: 600_000, handoverRearmPrompts: 3 });
    const taken = resolveSessionIntelConfig({ handoverRearmStepCapTokens: 1_000, handoverRearmIntervalMs: 0, handoverRearmPrompts: 0 });
    expect(taken).toMatchObject({ handoverRearmStepCapTokens: 1_000, handoverRearmIntervalMs: 0, handoverRearmPrompts: 0 });
    expect(taken.notes).toEqual([]);
    const clamped = resolveSessionIntelConfig({ handoverRearmStepCapTokens: 999, handoverRearmIntervalMs: 3_600_001, handoverRearmPrompts: 51 });
    expect(clamped).toMatchObject({ handoverRearmStepCapTokens: 25_000, handoverRearmIntervalMs: 600_000, handoverRearmPrompts: 3 });
    expect(clamped.notes).toHaveLength(3);
  });

  it("T-533, r-awey8xrtwqf1r005: the imperative defaults to 0.9 with 50000 tokens of headroom, and compact-needed to 0.98", () => {
    expect(resolveSessionIntelConfig(null)).toMatchObject({ advisoryPct: 0.7, imperativePct: 0.9, imperativeHeadroomTokens: 50_000, compactNeededPct: 0.98 });
  });

  it("T-533: imperativeHeadroomTokens is taken as written in 10000..500000, falls back per field outside it, and joins no pair rule", () => {
    for (const value of [10_000, 500_000, 123_456]) {
      const cfg = resolveSessionIntelConfig({ imperativeHeadroomTokens: value });
      expect(cfg.imperativeHeadroomTokens, String(value)).toBe(value);
      expect(cfg.notes, String(value)).toEqual([]);
    }
    for (const value of [9_999, 500_001, 60_000.5, "60000", null, Number.NaN]) {
      const cfg = resolveSessionIntelConfig({ imperativeHeadroomTokens: value });
      expect(cfg.imperativeHeadroomTokens, `${String(value)} reader`).toBe(50_000);
      expect(cfg.notes, `${String(value)} note`).toHaveLength(1);
      expect(cfg.notes[0], `${String(value)} note`).toMatch(/^sessionIntel\.imperativeHeadroomTokens ignored \(.*\); default 50000 used$/);
      expect(SessionIntelConfigSchema.safeParse({ imperativeHeadroomTokens: value }).success, `${String(value)} schema`).toBe(false);
    }
    // A headroom is not ordered against the percentages: extreme pairs pass.
    const cfg = resolveSessionIntelConfig({ imperativeHeadroomTokens: 500_000, advisoryPct: 0.5, imperativePct: 0.6, compactNeededPct: 0.85 });
    expect(cfg).toMatchObject({ imperativeHeadroomTokens: 500_000, advisoryPct: 0.5, imperativePct: 0.6, compactNeededPct: 0.85 });
    expect(cfg.notes).toEqual([]);
  });

  it("ISS-1197 commit 2: compactNeededPct defaults to 0.98 (T-533), is taken as written in 0.85..1, and clamps outside it", () => {
    expect(resolveSessionIntelConfig(null).compactNeededPct).toBe(0.98);
    expect(resolveSessionIntelConfig({}).compactNeededPct).toBe(0.98);
    const taken = resolveSessionIntelConfig({ compactNeededPct: 1 });
    expect(taken.compactNeededPct).toBe(1);
    expect(taken.notes).toEqual([]);
    for (const value of [0.84, 1.01, "0.9"]) {
      const cfg = resolveSessionIntelConfig({ compactNeededPct: value });
      expect(cfg.compactNeededPct, `${String(value)} reader`).toBe(0.98);
      expect(cfg.notes.some((n) => n.startsWith("sessionIntel.compactNeededPct ignored")), `${String(value)} note`).toBe(true);
      expect(SessionIntelConfigSchema.safeParse({ compactNeededPct: value }).success, `${String(value)} schema`).toBe(false);
    }
  });

  it("ISS-1197 commit 2: compactNeededPct at or below imperativePct falls back to the DEFAULT PAIR", () => {
    const equal = resolveSessionIntelConfig({ imperativePct: 0.92, compactNeededPct: 0.92 });
    expect(equal.imperativePct).toBe(0.9);
    expect(equal.compactNeededPct).toBe(0.98);
    expect(equal.notes).toHaveLength(1);
    expect(equal.notes[0]).toMatch(/compactNeededPct \(0\.92\) must exceed imperativePct \(0\.92\)/);

    // Only imperativePct raised: the pair rule still governs against the default.
    const onlyImperative = resolveSessionIntelConfig({ imperativePct: 0.99 });
    expect(onlyImperative.imperativePct).toBe(0.9);
    expect(onlyImperative.compactNeededPct).toBe(0.98);
    expect(onlyImperative.notes).toHaveLength(1);
    expect(onlyImperative.notes[0]).toMatch(/defaults 0\.9\/0\.98 used for the pair/);
    // T-533: 0.97 now sits under the default compact-needed line and is legal.
    expect(resolveSessionIntelConfig({ imperativePct: 0.97 })).toMatchObject({ imperativePct: 0.97, compactNeededPct: 0.98, notes: [] });

    // A legal chain passes untouched.
    const ok = resolveSessionIntelConfig({ advisoryPct: 0.75, imperativePct: 0.88, compactNeededPct: 0.97 });
    expect(ok).toMatchObject({ advisoryPct: 0.75, imperativePct: 0.88, compactNeededPct: 0.97 });
    expect(ok.notes).toEqual([]);

    // The restored default imperative is still ordered against advisory: the
    // advisory rule runs after this one and reports its own fallback.
    const cascade = resolveSessionIntelConfig({ advisoryPct: 0.95, imperativePct: 0.94, compactNeededPct: 0.92 });
    expect(cascade).toMatchObject({ advisoryPct: 0.7, imperativePct: 0.9, compactNeededPct: 0.98 });
    expect(cascade.notes).toHaveLength(2);
    // T-533: advisoryPct at its 0.95 maximum is above the default imperative (0.9), so it falls back alone.
    const top = resolveSessionIntelConfig({ advisoryPct: 0.95 });
    expect(top).toMatchObject({ advisoryPct: 0.7, imperativePct: 0.9, compactNeededPct: 0.98 });
    expect(top.notes).toHaveLength(1);
    expect(top.notes[0]).toMatch(/defaults 0\.7\/0\.9 used for the pair/);
  });

  it("ISS-1197 commit 2: the advisory/imperative fallback can RAISE imperativePct into compactNeededPct, and the chain is restored afterwards", () => {
    // Both inputs are individually in bounds and pass the compact rule on the
    // way in; the advisory rule then resets imperativePct to 0.9 (r-awey8xrtwqf1r005), at
    // or above the value compactNeededPct was allowed to keep.
    for (const raw of [
      { advisoryPct: 0.75, imperativePct: 0.7, compactNeededPct: 0.9 },
      { advisoryPct: 0.85, imperativePct: 0.8, compactNeededPct: 0.9 },
      { advisoryPct: 0.88, imperativePct: 0.86, compactNeededPct: 0.88 },
    ]) {
      const cfg = resolveSessionIntelConfig(raw);
      expect(cfg.advisoryPct, JSON.stringify(raw)).toBeLessThan(cfg.imperativePct);
      expect(cfg.imperativePct, JSON.stringify(raw)).toBeLessThan(cfg.compactNeededPct);
      expect(cfg.compactNeededPct, JSON.stringify(raw)).toBe(0.98);
      expect(cfg.notes.some((n) => n.includes("compactNeededPct") && n.includes("imperativePct")), JSON.stringify(raw)).toBe(true);
    }
    // The defaults themselves always satisfy the chain, so the re-check can
    // never leave a config it cannot repair.
    expect(DEFAULT_SESSION_INTEL_CONFIG.advisoryPct).toBeLessThan(DEFAULT_SESSION_INTEL_CONFIG.imperativePct);
    expect(DEFAULT_SESSION_INTEL_CONFIG.imperativePct).toBeLessThan(DEFAULT_SESSION_INTEL_CONFIG.compactNeededPct);
  });

  it("a non-boolean flag falls back silently (flags have no bounds to report)", () => {
    const cfg = resolveSessionIntelConfig({ enabled: "no", banner: 0 });
    expect(cfg.enabled).toBe(true);
    expect(cfg.banner).toBe(true);
    expect(cfg.notes).toEqual([]);
  });

  it("imperative at or below advisory falls back to the DEFAULT PAIR, not just the offender", () => {
    const equal = resolveSessionIntelConfig({ advisoryPct: 0.8, imperativePct: 0.8 });
    expect(equal.advisoryPct).toBe(0.7);
    expect(equal.imperativePct).toBe(0.9);
    expect(equal.notes).toHaveLength(1);
    expect(equal.notes[0]).toMatch(/imperativePct \(0\.8\) must exceed advisoryPct \(0\.8\)/);

    // The user set only advisoryPct at the default imperative (0.9, r-awey8xrtwqf1r005): the pair rule still governs.
    const onlyAdvisory = resolveSessionIntelConfig({ advisoryPct: 0.9 });
    expect(onlyAdvisory.advisoryPct).toBe(0.7);
    expect(onlyAdvisory.imperativePct).toBe(0.9);
    expect(onlyAdvisory.notes).toHaveLength(1);
  });

  it("jump-allowance floor above cap falls back to the default pair", () => {
    const cfg = resolveSessionIntelConfig({ jumpAllowanceFloorTokens: 200_000, jumpAllowanceCapTokens: 100_000 });
    expect(cfg.jumpAllowanceFloorTokens).toBe(25_000);
    expect(cfg.jumpAllowanceCapTokens).toBe(150_000);
    expect(cfg.notes).toHaveLength(1);
    expect(cfg.notes[0]).toMatch(/jumpAllowanceFloorTokens \(200000\) exceeds jumpAllowanceCapTokens \(100000\)/);
    // Equal floor and cap is legal.
    expect(resolveSessionIntelConfig({ jumpAllowanceFloorTokens: 5, jumpAllowanceCapTokens: 5 }).notes).toEqual([]);
  });

  it("a per-field fallback that then violates the pair rule is reported twice, once per rule", () => {
    // advisoryPct out of bounds -> default 0.7; imperativePct 0.65 is in bounds but below 0.7.
    const cfg = resolveSessionIntelConfig({ advisoryPct: 2, imperativePct: 0.65 });
    expect(cfg.notes).toHaveLength(2);
    expect(cfg.imperativePct).toBe(0.9);
  });

  it("unknown keys pass through untouched", () => {
    expect(resolveSessionIntelConfig({ futureKey: { nested: true } }).notes).toEqual([]);
  });
});

describe("sessionIntel config: hot-path reader agrees with the zod schema", () => {
  const numericKeys = Object.keys(SESSION_INTEL_BOUNDS) as Array<keyof typeof SESSION_INTEL_BOUNDS>;

  it("every numeric field: min and max accepted, just outside rejected, integer rule identical", () => {
    for (const key of numericKeys) {
      const b = SESSION_INTEL_BOUNDS[key];
      const step = b.integer ? 1 : 0.001;
      for (const value of [b.min, b.max]) {
        expect(SessionIntelConfigSchema.safeParse({ [key]: value }).success, `${key}=${value} schema`).toBe(true);
        // Pair rules can fire on a legal single value; only the per-field note must be absent.
        const notes = resolveSessionIntelConfig({ [key]: value }).notes;
        expect(notes.some((n) => n.startsWith(`sessionIntel.${key} ignored`)), `${key}=${value} reader`).toBe(false);
      }
      for (const value of [b.min - step, b.max + step]) {
        expect(SessionIntelConfigSchema.safeParse({ [key]: value }).success, `${key}=${value} schema`).toBe(false);
        const notes = resolveSessionIntelConfig({ [key]: value }).notes;
        expect(notes.some((n) => n.startsWith(`sessionIntel.${key} ignored`)), `${key}=${value} reader`).toBe(true);
      }
      if (b.integer) {
        const frac = b.min + 0.5;
        expect(SessionIntelConfigSchema.safeParse({ [key]: frac }).success).toBe(false);
        expect(resolveSessionIntelConfig({ [key]: frac }).notes.some((n) => n.startsWith(`sessionIntel.${key} ignored`))).toBe(true);
      }
    }
  });

  it("the schema and the reader name the same set of keys", () => {
    const schemaKeys = Object.keys(SessionIntelConfigSchema.shape).sort();
    const readerKeys = Object.keys(DEFAULT_SESSION_INTEL_CONFIG).sort();
    expect(schemaKeys).toEqual(readerKeys);
  });

  it("the block is optional at the ConfigSchema root and passes unknown keys through", () => {
    const parsed = ConfigSchema.parse({ ...minimalConfig, sessionIntel: { advisoryPct: 0.6, futureKey: 1 } });
    expect(parsed.sessionIntel).toEqual({ advisoryPct: 0.6, futureKey: 1 });
    expect(ConfigSchema.parse(minimalConfig).sessionIntel).toBeUndefined();
  });

  it("the pair rules are NOT in the schema: a violated pair still parses, so it falls back instead of throwing", () => {
    expect(SessionIntelConfigSchema.safeParse({ advisoryPct: 0.9, imperativePct: 0.8 }).success).toBe(true);
    expect(SessionIntelConfigSchema.safeParse({ jumpAllowanceFloorTokens: 9, jumpAllowanceCapTokens: 1 }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-501: recommendedWindowMax -- 0 (disabled) or 100,000 to 1,000,000.
// ---------------------------------------------------------------------------

describe("sessionIntel.recommendedWindowMax", () => {
  it("defaults to 450000", () => {
    expect(resolveSessionIntelConfig(null).recommendedWindowMax).toBe(450_000);
    expect(resolveSessionIntelConfig({}).recommendedWindowMax).toBe(450_000);
  });

  it("0 is accepted as the disable value by both the reader and the schema", () => {
    const cfg = resolveSessionIntelConfig({ recommendedWindowMax: 0 });
    expect(cfg.recommendedWindowMax).toBe(0);
    expect(cfg.notes).toEqual([]);
    expect(SessionIntelConfigSchema.safeParse({ recommendedWindowMax: 0 }).success).toBe(true);
  });

  it("50,000, 1,500,000 and -1 are rejected with the documented fallback", () => {
    for (const value of [50_000, 1_500_000, -1]) {
      const cfg = resolveSessionIntelConfig({ recommendedWindowMax: value });
      expect(cfg.recommendedWindowMax, `${value} reader`).toBe(450_000);
      expect(cfg.notes.some((n) => n.startsWith("sessionIntel.recommendedWindowMax ignored")), `${value} note`).toBe(true);
      expect(SessionIntelConfigSchema.safeParse({ recommendedWindowMax: value }).success, `${value} schema`).toBe(false);
    }
  });

  it("both ends of the live range are accepted", () => {
    expect(resolveSessionIntelConfig({ recommendedWindowMax: 100_000 }).notes).toEqual([]);
    expect(resolveSessionIntelConfig({ recommendedWindowMax: 1_000_000 }).notes).toEqual([]);
  });
});
