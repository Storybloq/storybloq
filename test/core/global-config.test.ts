import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHealthCheckGloballyDisabled, storybloqGlobalDir } from "../../src/core/global-config.js";

// T-502: the machine-wide health switch, beside the sessionIntel one. Absence means enabled: the command exists to tell the
// user things, and a missing config is not consent to stay quiet.
describe("isHealthCheckGloballyDisabled (T-502)", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalGlobalDir: string | undefined;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "storybloq-health-switch-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    // ISS-1331: the global dir resolves from STORYBLOQ_GLOBAL_DIR before HOME, and a gate env sets it, so the
    // fixture pins it to the HOME stub's own dir; CODEX_HOME is cleared for the same reason.
    originalGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
    originalCodexHome = process.env.CODEX_HOME;
    process.env.STORYBLOQ_GLOBAL_DIR = join(home, ".claude", "storybloq");
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
    else process.env.STORYBLOQ_GLOBAL_DIR = originalGlobalDir;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeGlobalConfig(body: string): void {
    mkdirSync(join(home, ".claude", "storybloq"), { recursive: true });
    writeFileSync(join(home, ".claude", "storybloq", "config.json"), body, "utf-8");
  }

  it("reads the config from the fixture's global dir, whatever the gate env set (ISS-1331)", () => {
    expect(storybloqGlobalDir()).toBe(join(home, ".claude", "storybloq"));
  });

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
