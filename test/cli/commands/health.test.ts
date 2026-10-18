import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHealth } from "../../../src/cli/commands/health.js";
import { configureRawMode, rawRejectionPending, resetRawMode, transformForRawMode } from "../../../src/cli/raw-mode.js";
import { commandTokensFrom, shouldSkipHousekeeping } from "../../../src/cli/housekeeping.js";
import { initProject } from "../../../src/core/init.js";
import { readAutoCompactWindowDiagnostic } from "../../../src/core/claude-settings.js";
import type { HealthDeps } from "../../../src/core/health/types.js";

/**
 * T-502: the CLI surface. Two things are load-bearing here and nothing else:
 * `projectDir` is the INVOCATION directory (not the ledger root), and the
 * command is inert -- it runs with or without `.story/`, exits 0 in every
 * case, and writes nothing except the shared version cache.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const d = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** Every file under `dir`, by relative path, with its exact bytes. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out[rel] = readFileSync(full, "utf-8");
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Every adapter that would otherwise let the developer's own machine decide
 * these assertions.
 *
 * `homeDir` alone is not enough: several default adapters call `homedir()`
 * themselves rather than reading `deps.homeDir`, so the user settings layer,
 * skill-marker discovery and the update cache are overridden explicitly too.
 * What is deliberately NOT overridden is `readFile`, because the point of the
 * nested-directory test is that the project layers under `projectDir` are
 * read for real.
 */
async function pinnedDeps(): Promise<Partial<HealthDeps>> {
  const home = await tempDir("health-cli-home-");
  return {
    env: {},
    homeDir: home,
    claudeConfigDir: join(home, ".claude"),
    claudeJsonPath: join(home, ".claude.json"),
    claudeSettingsDisplay: "~/.claude/settings.json",
    globalConfig: () => null,
    // Real project layers, isolated user layer.
    settings: {
      autoCompactWindow: (projectDir: string) =>
        readAutoCompactWindowDiagnostic(projectDir, join(home, ".claude", "settings.json")),
    },
    // No installed skill, no network, no spawned Codex: these three checks
    // report deterministically and none of the assertions depend on them.
    skillMarker: { targets: () => [], installed: () => false, marker: () => ({ kind: "absent" }) },
    versionCache: { read: () => null, refresh: async () => null },
    run: () => ({ kind: "enoent" }),
    callerSample: () => null,
  };
}

interface HealthBody {
  projectDir: string;
  cliVersion: string;
  client: string;
  checks: Array<{ id: string; status: string; message: string; advice: string | null; detail: Record<string, unknown> }>;
}
// ISS-1223: the CLI json is the shared {version, data} envelope; `parsed`
// unwraps it the way every caller of the other commands does.
const envelope = (output: string) => JSON.parse(output) as { version: number; data: HealthBody };
const parsed = (output: string): HealthBody & { version: number } => {
  const e = envelope(output);
  return { version: e.version, ...e.data };
};

describe("storybloq health (CLI)", () => {
  it("json is the shared {version, data} envelope, and --raw unwraps it to the result alone (ISS-1223)", async () => {
    const root = await tempDir("health-cli-envelope-");
    await initProject(root, { name: "p", type: "npm" });
    const result = await handleHealth({ ledgerRoot: root, projectDir: root }, "json", { deps: await pinnedDeps() });
    const body = envelope(result.output);
    expect(Object.keys(body).sort()).toEqual(["data", "version"]);
    expect(body.version).toBe(1);
    expect(body.data.projectDir).toBe(root);
    expect(body.data.checks).toHaveLength(6);
    // The write seam's --raw unwrap accepts this shape; before ISS-1223 it
    // rejected health as a deviant top-level shape.
    configureRawMode(true, "json");
    try {
      const raw = transformForRawMode(result.output);
      expect(rawRejectionPending()).toBe(false);
      expect(JSON.parse(raw)).toEqual(body.data);
    } finally {
      resetRawMode();
    }
  });

  it("lists the six checks in json and exits 0", async () => {
    const root = await tempDir("health-cli-");
    await initProject(root, { name: "p", type: "npm" });
    const result = await handleHealth({ ledgerRoot: root, projectDir: root }, "json", { deps: await pinnedDeps() });
    expect(result.exitCode ?? 0).toBe(0);
    const body = parsed(result.output);
    expect(body.version).toBe(1);
    expect(body.checks.map((c) => c.id)).toEqual([
      "usage-window",
      "cli-version",
      "codex-bridge",
      "skill-version",
      "cross-session-inbound",
      "hook-duplicates",
    ]);
    expect(body.projectDir).toBe(root);
  });

  it("renders md with one line per check and names the inspected directory", async () => {
    const root = await tempDir("health-cli-md-");
    await initProject(root, { name: "p", type: "npm" });
    const result = await handleHealth({ ledgerRoot: root, projectDir: root }, "md", { deps: await pinnedDeps() });
    expect(result.output).toContain("# Health check");
    expect(result.output).toContain(`settings inspected for ${root}`);
    for (const id of ["usage-window", "cli-version", "codex-bridge", "skill-version", "cross-session-inbound", "hook-duplicates"]) {
      expect(result.output).toMatch(new RegExp(`\\[(ok|advise|skip|error)\\] ${id}:`));
    }
  });

  it("runs with no .story/ at all", async () => {
    const dir = await tempDir("health-cli-bare-");
    const result = await handleHealth({ ledgerRoot: null, projectDir: dir }, "json", { deps: await pinnedDeps() });
    expect(result.exitCode ?? 0).toBe(0);
    expect(parsed(result.output).checks).toHaveLength(6);
  });

  it("reads the project layers of the INVOCATION directory, not the ledger root", async () => {
    const root = await tempDir("health-cli-nested-");
    await initProject(root, { name: "p", type: "npm" });
    const nested = join(root, "packages", "app");
    await mkdir(join(nested, ".claude"), { recursive: true });
    await writeFile(join(nested, ".claude", "settings.local.json"), JSON.stringify({ crossSessionInbound: "hold" }));
    // The ledger root has no crossSessionInbound anywhere.
    const result = await handleHealth({ ledgerRoot: root, projectDir: nested }, "json", { deps: await pinnedDeps() });
    const body = parsed(result.output);
    const inbound = body.checks.find((c) => c.id === "cross-session-inbound")!;
    expect(body.projectDir).toBe(nested);
    expect(inbound.detail.projectDir).toBe(nested);
    expect(inbound.detail.local).toBe("hold");
  });

  it("only filters and refresh is accepted", async () => {
    const dir = await tempDir("health-cli-only-");
    const result = await handleHealth({ ledgerRoot: null, projectDir: dir }, "json", { only: ["cross-session-inbound"], deps: await pinnedDeps() });
    expect(parsed(result.output).checks.map((c) => c.id)).toEqual(["cross-session-inbound"]);
  });

  it("honours the project config switches", async () => {
    const root = await tempDir("health-cli-cfg-");
    await initProject(root, { name: "p", type: "npm" });
    const cfgPath = join(root, ".story", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    cfg.healthCheck = { checks: { codexBridge: false } };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    const body = parsed((await handleHealth({ ledgerRoot: root, projectDir: root }, "json", { deps: await pinnedDeps() })).output);
    const bridge = body.checks.find((c) => c.id === "codex-bridge")!;
    expect(bridge.status).toBe("skip");
    expect(bridge.detail.reason).toBe("disabled in .story/config.json");
  });

  it("leaves the ledger byte-identical: the only write it may make is the version cache", async () => {
    const root = await tempDir("health-cli-inert-");
    await initProject(root, { name: "p", type: "npm" });
    const before = snapshotTree(join(root, ".story"));
    expect(Object.keys(before).length).toBeGreaterThan(0);
    await handleHealth({ ledgerRoot: root, projectDir: root }, "json", { deps: await pinnedDeps() });
    expect(snapshotTree(join(root, ".story"))).toEqual(before);
  });

  it("never throws: a check that fails is reported as error while the others answer", async () => {
    const dir = await tempDir("health-cli-throw-");
    const result = await handleHealth({ ledgerRoot: null, projectDir: dir }, "json", {
      deps: {
        ...(await pinnedDeps()),
        settings: {
          autoCompactWindow: () => {
            throw new TypeError("boom");
          },
        },
      },
    });
    const body = parsed(result.output);
    expect(body.checks.find((c) => c.id === "usage-window")!.status).toBe("error");
    expect(body.checks.filter((c) => c.status === "error")).toHaveLength(1);
    expect(result.exitCode ?? 0).toBe(0);
  });
});

describe("health skips pre-command housekeeping", () => {
  it("is in the skip list, so no skill refresh, hook reconcile or background registry fetch runs first", () => {
    expect(shouldSkipHousekeeping(["health"])).toBe(true);
    expect(shouldSkipHousekeeping(["health", "--format", "json"])).toBe(true);
  });

  // yargs accepts options BEFORE the command, and for this command the skip is
  // the whole point: housekeeping running first would repair what the command
  // was asked to describe.
  it("skips when options precede the command name, including a boolean with an explicit value", () => {
    expect(shouldSkipHousekeeping(["--format=json", "health"])).toBe(true);
    expect(shouldSkipHousekeeping(["--format", "json", "health"])).toBe(true);
    expect(shouldSkipHousekeeping(["--format", "json", "health", "--refresh"])).toBe(true);
    expect(shouldSkipHousekeeping(["--refresh", "health"])).toBe(true);
    expect(shouldSkipHousekeeping(["--refresh", "false", "health"])).toBe(true);
  });

  it("resolves a subcommand relative to the command, not to argv[0]", () => {
    expect(shouldSkipHousekeeping(["session", "intel-start"])).toBe(true);
    expect(shouldSkipHousekeeping(["--format=json", "session", "intel-start"])).toBe(true);
    expect(shouldSkipHousekeeping(["--format", "json", "session", "intel-start"])).toBe(true);
    // Options BETWEEN the command and its subcommand, which index arithmetic missed.
    expect(shouldSkipHousekeeping(["session", "--format=json", "intel-start"])).toBe(true);
    expect(shouldSkipHousekeeping(["session", "--format", "json", "intel-start"])).toBe(true);
    // A `session` subcommand that is NOT a hook keeps housekeeping.
    expect(shouldSkipHousekeeping(["--format=json", "session", "list"])).toBe(false);
  });

  it("does not change the answer for ordinary commands", () => {
    expect(shouldSkipHousekeeping(["status"])).toBe(false);
    expect(shouldSkipHousekeeping(["selftest"])).toBe(false);
    expect(shouldSkipHousekeeping(["--format=json", "status"])).toBe(false);
    expect(shouldSkipHousekeeping([])).toBe(false);
    expect(shouldSkipHousekeeping(["--help"])).toBe(false);
  });

  // Options may sit before a command, between a command and its subcommand,
  // and a boolean flag may carry an explicit value. Hand-rolled index
  // arithmetic got all three wrong, so yargs' own parser decides.
  it("commandTokensFrom matches yargs' parsing of options around positionals", () => {
    expect(commandTokensFrom(["health"])).toEqual({ command: "health" });
    expect(commandTokensFrom(["--format=json", "health"])).toEqual({ command: "health" });
    expect(commandTokensFrom(["--format", "json", "health"])).toEqual({ command: "health" });
    expect(commandTokensFrom(["--refresh", "health"])).toEqual({ command: "health" });
    expect(commandTokensFrom(["--refresh", "false", "health"])).toEqual({ command: "health" });
    expect(commandTokensFrom(["health", "--format", "json"])).toEqual({ command: "health" });
    expect(commandTokensFrom(["session", "--format=json", "intel-start"])).toEqual({ command: "session", subcommand: "intel-start" });
    expect(commandTokensFrom(["session", "--format", "json", "intel-start"])).toEqual({ command: "session", subcommand: "intel-start" });
    expect(commandTokensFrom([])).toEqual({});
    expect(commandTokensFrom(["--format", "json"])).toEqual({});
  });
});
