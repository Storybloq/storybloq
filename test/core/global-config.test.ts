import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHealthCheckGloballyDisabled } from "../../src/core/global-config.js";

// T-502: the machine-wide health switch, beside the limitResume and
// sessionIntel ones. Absence means enabled: the command exists to tell the
// user things, and a missing config is not consent to stay quiet.
describe("isHealthCheckGloballyDisabled (T-502)", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "storybloq-health-switch-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeGlobalConfig(body: string): void {
    mkdirSync(join(home, ".claude", "storybloq"), { recursive: true });
    writeFileSync(join(home, ".claude", "storybloq", "config.json"), body, "utf-8");
  }

  it("absence means enabled", () => {
    expect(isHealthCheckGloballyDisabled()).toBe(false);
  });

  it("only an explicit false disables", () => {
    writeGlobalConfig(JSON.stringify({ healthCheck: { enabled: false } }));
    expect(isHealthCheckGloballyDisabled()).toBe(true);
    writeGlobalConfig(JSON.stringify({ healthCheck: { enabled: true } }));
    expect(isHealthCheckGloballyDisabled()).toBe(false);
    writeGlobalConfig(JSON.stringify({ healthCheck: {} }));
    expect(isHealthCheckGloballyDisabled()).toBe(false);
  });

  it("a broken or unrelated config is enabled, and the sibling switches are independent", () => {
    writeGlobalConfig("{ not json");
    expect(isHealthCheckGloballyDisabled()).toBe(false);
    writeGlobalConfig(JSON.stringify({ sessionIntel: { enabled: false } }));
    expect(isHealthCheckGloballyDisabled()).toBe(false);
  });
});
