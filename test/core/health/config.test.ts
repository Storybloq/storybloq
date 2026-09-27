import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHealthCheckConfig, readHealthCheckConfig } from "../../../src/core/health/config.js";
import { ConfigSchema, HealthCheckConfigSchema } from "../../../src/models/config.js";

describe("T-502 healthCheck config", () => {
  it("defaults every switch to on", () => {
    const cfg = resolveHealthCheckConfig(undefined);
    expect(cfg.enabled).toBe(true);
    expect(Object.values(cfg.checks).every((v) => v === true)).toBe(true);
  });

  it("only false switches a check off; a non-boolean falls back for that key alone", () => {
    const cfg = resolveHealthCheckConfig({ checks: { codexBridge: false, cliVersion: "no", skillVersion: 0 } });
    expect(cfg.checks["codex-bridge"]).toBe(false);
    expect(cfg.checks["cli-version"]).toBe(true);
    expect(cfg.checks["skill-version"]).toBe(true);
  });

  it("enabled: false switches the whole command off", () => {
    expect(resolveHealthCheckConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveHealthCheckConfig({ enabled: "no" }).enabled).toBe(true);
  });

  it("reads the block from .story/config.json and tolerates a missing or broken file", () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-health-cfg-"));
    try {
      expect(readHealthCheckConfig(root).enabled).toBe(true);
      mkdirSync(join(root, ".story"), { recursive: true });
      writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ healthCheck: { checks: { usageWindow: false } } }));
      expect(readHealthCheckConfig(root).checks["usage-window"]).toBe(false);
      writeFileSync(join(root, ".story", "config.json"), "{ broken");
      expect(readHealthCheckConfig(root).checks["usage-window"]).toBe(true);
      expect(readHealthCheckConfig(null).enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a bad toggle VALUE falls back for that key alone and never rejects the config", () => {
    // ConfigSchema is parsed, not safe-parsed, by the project loader, so a
    // rejection here would break every ordinary command over one typo.
    const base = {
      version: 1,
      project: "p",
      type: "npm",
      language: "typescript",
      features: { tickets: true, issues: true, notes: true, lessons: true, handovers: true, roadmap: true, reviews: true },
    };
    const parsed = ConfigSchema.parse({
      ...base,
      healthCheck: { enabled: "yes", checks: { cliVersion: "false", codexBridge: false } },
    });
    // The schema keeps the raw values (it is permissive by design) and the
    // resolver is what applies the per-key fallback.
    expect(parsed.healthCheck?.enabled).toBe("yes");
    expect(parsed.healthCheck?.checks?.cliVersion).toBe("false");
    expect(parsed.healthCheck?.checks?.codexBridge).toBe(false);
    // And the resolver turns those fallbacks back into the documented defaults.
    const resolved = resolveHealthCheckConfig(parsed.healthCheck);
    expect(resolved.enabled).toBe(true);
    expect(resolved.checks["cli-version"]).toBe(true);
    expect(resolved.checks["codex-bridge"]).toBe(false);

    // A malformed CONTAINER still rejects, exactly as it does for every other
    // config block (sessionIntel, statusWriter): that is a structural mistake,
    // not a mistyped value, and the resolver is defensive about it anyway.
    expect(() => ConfigSchema.parse({ ...base, healthCheck: "off" })).toThrow();
    expect(resolveHealthCheckConfig("off").enabled).toBe(true);
    expect(resolveHealthCheckConfig({ checks: 7 }).checks["cli-version"]).toBe(true);
  });

  it("the zod schema accepts the block and passes unknown keys through", () => {
    const parsed = HealthCheckConfigSchema.parse({ enabled: true, checks: { cliVersion: false, future: true }, extra: 1 });
    expect(parsed.checks?.cliVersion).toBe(false);
    expect(parsed.enabled).toBe(true);
    expect((parsed as Record<string, unknown>).extra).toBe(1);
  });

  it("ConfigSchema carries healthCheck as an optional block", () => {
    const base = {
      version: 1,
      project: "p",
      type: "npm",
      language: "typescript",
      features: { tickets: true, issues: true, notes: true, lessons: true, handovers: true, roadmap: true, reviews: true },
    };
    expect(() => ConfigSchema.parse(base)).not.toThrow();
    const withBlock = ConfigSchema.parse({ ...base, healthCheck: { checks: { crossSessionInbound: false } } });
    expect(withBlock.healthCheck?.checks?.crossSessionInbound).toBe(false);
    expect(resolveHealthCheckConfig(withBlock.healthCheck).checks["cross-session-inbound"]).toBe(false);
  });
});
