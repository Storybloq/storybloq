/**
 * ISS-1222: hook registration is idempotent on the SEMANTIC command and on
 * matcher coverage, never on the exact launcher path, and only the validated
 * global launcher may replace or collapse rows. Also pins the global launcher
 * probe (npm root -g agreeing with the PATH walk) and the Bus normalisation
 * finding our rows by semantic key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  enableClaudeBusHooks,
  migrateLegacyHookVariants,
  globalLauncher,
  registerPreCompactHook,
  registerPresenceHooks,
  registerSessionStartHook,
  registerStopHook,
  resolveGlobalStorybloqBin,
  formatHookCommand,
  CLAUDE_BUS_SESSION_START_MATCHER,
} from "../../../src/cli/commands/setup-skill.js";
import { reconcileDuplicateHookRows } from "../../../src/core/hook-duplicates.js";

const NVM = "/fake/nvm/bin/storybloq";
const NPX = "/fake/.npm/_npx/573f/node_modules/.bin/storybloq";
const OLD = "/fake/old/storybloq";
const FULL = "startup|resume|clear|compact";
const row = (command: string, extra: Record<string, unknown> = {}) => ({ type: "command", command, ...extra });

interface Group { matcher?: string; hooks: Array<{ type: string; command: string; [k: string]: unknown }> }

describe("registerHook by semantic command and coverage (ISS-1222)", () => {
  let dir: string;
  let settingsPath: string;
  beforeEach(async () => {
    dir = join(tmpdir(), `iss1222-reg-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    settingsPath = join(dir, "settings.json");
    globalLauncher.override = (rest) => formatHookCommand(NVM, rest);
  });
  afterEach(async () => {
    globalLauncher.override = null;
    globalLauncher.memo = null;
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(hooks: Record<string, Group[]>): Promise<void> {
    await writeFile(settingsPath, JSON.stringify({ model: "opus", hooks }, null, 2));
  }
  async function groupsOf(event: string): Promise<Array<{ matcher: string; commands: string[] }>> {
    const s = JSON.parse(await readFile(settingsPath, "utf-8")) as { hooks: Record<string, Group[]> };
    return (s.hooks[event] ?? []).map((g) => ({ matcher: g.matcher ?? "", commands: g.hooks.map((h) => h.command) }));
  }

  // T-534: the retired limit registrars were the vehicles here; PreCompact
  // (matcher "") and SessionStart "compact" carry the same rules.
  it("an npx row is rewritten in place to the global command; one row remains; result registered", async () => {
    await seed({ PreCompact: [{ matcher: "", hooks: [row(`${NPX} session compact-prepare`)] }] });
    expect(await registerPreCompactHook(settingsPath, NVM)).toBe("registered");
    expect(await groupsOf("PreCompact")).toEqual([{ matcher: "", commands: [`${NVM} session compact-prepare`] }]);
  });

  it("a non-global candidate never adds a row beside a covering row; result exists", async () => {
    await seed({ PreCompact: [{ matcher: "", hooks: [row(`${NVM} session compact-prepare`)] }] });
    expect(await registerPreCompactHook(settingsPath, NPX)).toBe("exists");
    expect(await groupsOf("PreCompact")).toEqual([{ matcher: "", commands: [`${NVM} session compact-prepare`] }]);
  });

  it("the exact command in a covering group is exists, with no write", async () => {
    await seed({ PreCompact: [{ matcher: "", hooks: [row(`${NVM} session compact-prepare`)] }] });
    const before = await readFile(settingsPath, "utf-8");
    expect(await registerPreCompactHook(settingsPath, NVM)).toBe("exists");
    expect(await readFile(settingsPath, "utf-8")).toBe(before);
  });

  it("two stale variants then the global command leave exactly one row", async () => {
    await seed({ PreCompact: [{ matcher: "", hooks: [row(`${NPX} session compact-prepare`), row(`${OLD} session compact-prepare`)] }] });
    expect(await registerPreCompactHook(settingsPath, NVM)).toBe("registered");
    expect(await groupsOf("PreCompact")).toEqual([{ matcher: "", commands: [`${NVM} session compact-prepare`] }]);
  });

  it("with no validated global launcher a colliding candidate is exists and nothing is written", async () => {
    globalLauncher.override = () => null;
    await seed({ PreCompact: [{ matcher: "", hooks: [row(`${NPX} session compact-prepare`)] }] });
    const before = await readFile(settingsPath, "utf-8");
    expect(await registerPreCompactHook(settingsPath, NVM)).toBe("exists");
    expect(await readFile(settingsPath, "utf-8")).toBe(before);
  });

  it("the live shape: the full group's global row covers compact, so the registration adds no second group and leaves the npx compact row to the reconcile", async () => {
    await seed({ SessionStart: [
      { matcher: FULL, hooks: [row(`${NVM} session resume-prompt`)] },
      { matcher: "compact", hooks: [row(`${NPX} session resume-prompt`)] },
    ] });
    expect(await registerSessionStartHook(settingsPath, NVM)).toBe("exists");
    expect(await groupsOf("SessionStart")).toEqual([
      { matcher: FULL, commands: [`${NVM} session resume-prompt`] },
      { matcher: "compact", commands: [`${NPX} session resume-prompt`] },
    ]);
  });

  it("compact-only npx row, then the global registration: rewritten in place, one row", async () => {
    await seed({ SessionStart: [{ matcher: "compact", hooks: [row(`${NPX} session resume-prompt`)] }] });
    expect(await registerSessionStartHook(settingsPath, NVM)).toBe("registered");
    expect(await groupsOf("SessionStart")).toEqual([{ matcher: "compact", commands: [`${NVM} session resume-prompt`] }]);
  });

  it("a global candidate overlapping a partial npx group collapses to one row with the union matcher", async () => {
    await seed({ SessionStart: [{ matcher: "startup|compact", hooks: [row(`${NPX} session resume-prompt`)] }] });
    // The registration targets "compact": the seeded group overlaps but does not cover it.
    expect(await registerSessionStartHook(settingsPath, NVM)).toBe("registered");
    expect(await groupsOf("SessionStart")).toEqual([{ matcher: "startup|compact", commands: [`${NVM} session resume-prompt`] }]);
  });

  it("a global candidate whose target is disjoint from an npx group installs its own group", async () => {
    await seed({ SessionStart: [{ matcher: "resume", hooks: [row(`${NPX} session resume-prompt`)] }] });
    // registerSessionStartHook targets "compact": disjoint from "resume", so it installs its own group.
    expect(await registerSessionStartHook(settingsPath, NVM)).toBe("registered");
    expect(await groupsOf("SessionStart")).toEqual([
      { matcher: "resume", commands: [`${NPX} session resume-prompt`] },
      { matcher: "compact", commands: [`${NVM} session resume-prompt`] },
    ]);
  });

  it("a compact-only group re-registers as exists, however often", async () => {
    await seed({ SessionStart: [{ matcher: "compact", hooks: [row(`${NVM} session resume-prompt`)] }] });
    expect(await registerSessionStartHook(settingsPath, NVM)).toBe("exists");
    expect(await registerSessionStartHook(settingsPath, NVM)).toBe("exists");
    expect(await groupsOf("SessionStart")).toEqual([{ matcher: "compact", commands: [`${NVM} session resume-prompt`] }]);
  });

  it("a lone resume-group row no longer counts as compact coverage", async () => {
    await seed({ SessionStart: [{ matcher: "resume", hooks: [row(`${NVM} session resume-prompt`)] }] });
    expect(await registerSessionStartHook(settingsPath, NVM)).toBe("registered");
    expect((await groupsOf("SessionStart")).map((g) => g.matcher)).toEqual(["resume", "compact"]);
  });

  it("presence hooks (another basename) keep the exact-string rule and are untouched by a storybloq collision", async () => {
    const presence = "/fake/nvm/bin/storybloq-presence hook";
    await seed({ Stop: [{ matcher: "", hooks: [row(presence, { timeout: 5 }), row(`${NPX} hook-status`)] }] });
    const results = await registerPresenceHooks(settingsPath, "/fake/nvm/bin/storybloq-presence");
    expect(results!.Stop).toBe("exists");
    expect(await registerStopHook(settingsPath, NVM)).toBe("registered");
    expect(await groupsOf("Stop")).toEqual([{ matcher: "", commands: [presence, `${NVM} hook-status`] }]);
  });

  it("with the global Stop row already present beside a stale one, registration is exists and leaves the collision to the reconcile", async () => {
    await seed({ Stop: [{ matcher: "", hooks: [row(`${NPX} hook-status`, { async: true, timeout: 99 }), row(`${NVM} hook-status`, { timeout: 5 })] }] });
    expect(await registerStopHook(settingsPath, NVM)).toBe("exists");
    const s = JSON.parse(await readFile(settingsPath, "utf-8")) as { hooks: { Stop: Group[] } };
    expect(s.hooks.Stop[0]!.hooks).toEqual([{ type: "command", command: `${NPX} hook-status`, async: true, timeout: 99 }, { type: "command", command: `${NVM} hook-status`, timeout: 5 }]);
  });

  it("a lone stale row rewritten in place to the global command keeps its own options", async () => {
    await seed({ Stop: [{ matcher: "", hooks: [row(`${NPX} hook-status`, { async: true, timeout: 99 })] }] });
    expect(await registerStopHook(settingsPath, NVM)).toBe("registered");
    const s = JSON.parse(await readFile(settingsPath, "utf-8")) as { hooks: { Stop: Group[] } };
    expect(s.hooks.Stop[0]!.hooks).toEqual([{ type: "command", command: `${NVM} hook-status`, async: true, timeout: 99 }]);
  });

  it("ISS-1226: the live shape run through the migration and then the reconcile leaves no empty group", async () => {
    await seed({ SessionStart: [
      { matcher: FULL, hooks: [row(`${NVM} session resume-prompt`), row(`${NVM} session intel-start`, { timeout: 5 })] },
      { matcher: "resume", hooks: [row(`${NPX} session resume-prompt`)] },
    ] });
    expect(await migrateLegacyHookVariants("SessionStart", "session resume-prompt", `${NVM} session resume-prompt`, settingsPath)).toBe(1);
    expect(await groupsOf("SessionStart")).toEqual([{ matcher: FULL, commands: [`${NVM} session resume-prompt`, `${NVM} session intel-start`] }]);
    // A shell left by any earlier writer is cleaned by the reconcile on the next setup-skill.
    await seed({ SessionStart: [
      { matcher: FULL, hooks: [row(`${NVM} session resume-prompt`)] },
      { matcher: "resume", hooks: [] },
    ] });
    const out = await reconcileDuplicateHookRows(settingsPath, (rest) => formatHookCommand(NVM, rest));
    expect(out.pruned).toEqual([{ hookType: "SessionStart", matcher: "resume" }]);
    expect(await groupsOf("SessionStart")).toEqual([{ matcher: FULL, commands: [`${NVM} session resume-prompt`] }]);
  });

  it("enableClaudeBusHooks keeps the validated global row and drops the stale npx row, whichever group order the file has (post-hoc Codex finding)", async () => {
    await seed({
      SessionStart: [
        { matcher: CLAUDE_BUS_SESSION_START_MATCHER, hooks: [row(`${NVM} session resume-prompt`, { timeout: 7 })] },
        { matcher: "resume", hooks: [row(`${NPX} session resume-prompt`)] },
      ],
      Stop: [{ matcher: "", hooks: [row(`${NVM} hook-status`)] }],
    });
    const r = await enableClaudeBusHooks(settingsPath, NVM);
    expect(r).toEqual({ changed: true, skipped: false });
    const s = JSON.parse(await readFile(settingsPath, "utf-8")) as { hooks: { SessionStart: Group[] } };
    expect(s.hooks.SessionStart).toEqual([{ matcher: CLAUDE_BUS_SESSION_START_MATCHER, hooks: [{ type: "command", command: `${NVM} session resume-prompt`, timeout: 7 }] }]);
  });

  it("enableClaudeBusHooks with no validated global launcher leaves a same-key collision untouched and reports skipped", async () => {
    globalLauncher.override = () => null;
    await seed({
      SessionStart: [
        { matcher: CLAUDE_BUS_SESSION_START_MATCHER, hooks: [row(`${NVM} session resume-prompt`)] },
        { matcher: "resume", hooks: [row(`${NPX} session resume-prompt`)] },
      ],
      Stop: [{ matcher: "", hooks: [row(`${NVM} hook-status`)] }],
    });
    const before = await readFile(settingsPath, "utf-8");
    const r = await enableClaudeBusHooks(settingsPath, NVM);
    expect(r).toEqual({ changed: false, skipped: true });
    expect(await readFile(settingsPath, "utf-8")).toBe(before);
  });

  it("enableClaudeBusHooks finds our rows by semantic key when only an alternate-path row exists", async () => {
    globalLauncher.override = () => null;
    await seed({
      SessionStart: [{ matcher: "compact", hooks: [row(`${NPX} session resume-prompt`)] }],
      Stop: [{ matcher: "", hooks: [row(`${NPX} hook-status`, { async: true })] }],
    });
    const r = await enableClaudeBusHooks(settingsPath, NVM);
    expect(r).toEqual({ changed: true, skipped: false });
    const groups = await groupsOf("SessionStart");
    expect(groups).toEqual([{ matcher: CLAUDE_BUS_SESSION_START_MATCHER, commands: [`${NPX} session resume-prompt`] }]);
    const s = JSON.parse(await readFile(settingsPath, "utf-8")) as { hooks: { Stop: Group[] } };
    expect(s.hooks.Stop[0]!.hooks[0]).toEqual({ type: "command", command: `${NPX} hook-status` });
  });
});

describe("resolveGlobalStorybloqBin (ISS-1222)", () => {
  const root = "/Users/o/.nvm/versions/node/v22/lib/node_modules";
  const launcher = "/Users/o/.nvm/versions/node/v22/bin/storybloq";
  const real = "/Users/o/Developer/CPM/storybloq/dist/cli.js";
  const probe = (over: Partial<Parameters<typeof resolveGlobalStorybloqBin>[0]> = {}) => ({
    run: () => `${root}\n`,
    pathWalk: () => launcher,
    realpath: (p: string) => (p === launcher ? real : p === "/Users/o/.npm/_npx/573f/node_modules/.bin/storybloq" ? "/Users/o/.npm/_npx/573f/node_modules/@storybloq/storybloq/dist/cli.js" : null),
    isExecutable: (p: string) => p === launcher,
    platform: "darwin",
    ...over,
  });

  it("accepts the npm-derived launcher when the PATH walk resolves to the same real file", () => {
    expect(resolveGlobalStorybloqBin(probe())).toBe(launcher);
  });
  it("is null under npx, where the PATH walk finds the cache copy", () => {
    expect(resolveGlobalStorybloqBin(probe({ pathWalk: () => "/Users/o/.npm/_npx/573f/node_modules/.bin/storybloq" }))).toBeNull();
  });
  it("is null when npm fails, prints nothing, the launcher is missing, or nothing is on PATH", () => {
    expect(resolveGlobalStorybloqBin(probe({ run: () => null }))).toBeNull();
    expect(resolveGlobalStorybloqBin(probe({ run: () => "\n" }))).toBeNull();
    expect(resolveGlobalStorybloqBin(probe({ isExecutable: () => false }))).toBeNull();
    expect(resolveGlobalStorybloqBin(probe({ pathWalk: () => null }))).toBeNull();
    expect(resolveGlobalStorybloqBin(probe({ realpath: () => null }))).toBeNull();
  });
  it("on Windows the two realpaths agree regardless of drive-letter case", () => {
    const winLauncher = "C:\\Users\\o\\AppData\\Roaming\\npm\\storybloq.cmd";
    const out = resolveGlobalStorybloqBin({
      run: () => "C:\\Users\\o\\AppData\\Roaming\\npm\\node_modules\r\n",
      pathWalk: () => winLauncher.replace(/^C:/, "c:"),
      realpath: (p) => p,
      isExecutable: (p) => p === winLauncher,
      platform: "win32",
    });
    expect(out).toBe(winLauncher);
  });
  it("maps the Windows global root to <prefix>/storybloq.cmd", () => {
    const winRoot = "C:\\Users\\o\\AppData\\Roaming\\npm\\node_modules";
    const winLauncher = "C:\\Users\\o\\AppData\\Roaming\\npm\\storybloq.cmd";
    const seen: string[] = [];
    const out = resolveGlobalStorybloqBin({
      run: (cmd) => { seen.push(cmd); return `${winRoot}\r\n`; },
      pathWalk: () => winLauncher,
      realpath: (p) => p,
      isExecutable: (p) => p === winLauncher,
      platform: "win32",
    });
    expect(out).toBe(winLauncher);
    expect(seen).toEqual(["npm.cmd"]);
  });
});
