/**
 * ISS-1222: storybloq hook rows are deduplicated by semantic command (owned
 * basename plus subcommand) and source coverage, never by the full command
 * string, and only a validated global launcher ever drops a row.
 *
 * Cross-layer trust violation guard: registration deduped by exact string,
 * housekeeping registered from whichever binary ran, and nothing reconciled
 * the file, so a settings file could carry the same hook twice.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hookRowKey,
  matcherCoverage,
  coverageOverlaps,
  coverageCovers,
  findHookCollisions,
  dedupeHookRows,
  reconcileDuplicateHookRows,
} from "../../src/core/hook-duplicates.js";
import { formatHookCommand } from "../../src/core/hook-migration.js";

const NVM = "/Users/o/.nvm/versions/node/v22.18.0/bin/storybloq";
const NPX = "/Users/o/.npm/_npx/573f0a688c465d03/node_modules/.bin/storybloq";
const FULL = "startup|resume|clear|compact";
const globalFor = (bin: string | null) => (rest: string) => (bin ? formatHookCommand(bin, rest) : null);

function row(command: string, extra: Record<string, unknown> = {}) {
  return { type: "command", command, ...extra };
}

/** The live shape from the field finding, plus a T-424 disjoint pair, a foreign row and a malformed entry. */
function liveSettings() {
  return {
    model: "opus",
    hooks: {
      PreCompact: [{ matcher: "", hooks: [row(`${NVM} session compact-prepare`)] }],
      Stop: [
        { matcher: "", hooks: [row("/Users/o/.until/bin/do-until-hook-stop")] },
        { matcher: "", hooks: [row(`${NVM} hook-status`)] },
      ],
      SessionStart: [
        { matcher: FULL, hooks: [row(`${NVM} session resume-prompt`), row(`${NVM} session intel-start`, { timeout: 5 })] },
        { matcher: "resume", hooks: [row(`${NPX} session resume-prompt`)] },
      ],
      StopFailure: [
        { matcher: "rate_limit", hooks: [row(`${NVM} session limit-stop`), row(`${NPX} session limit-stop`), null, { type: "command" }] },
      ],
      UserPromptSubmit: [{ matcher: "", hooks: [row(`${NVM} session intel-prompt`, { timeout: 10 })] }],
      PreToolUse: [
        { matcher: "compact", hooks: [row(`${NVM} session resume-prompt`)] },
        { matcher: "resume", hooks: [row(`${NVM} session resume-prompt`)] },
      ],
    },
  };
}

type Settings = ReturnType<typeof liveSettings>;
const groups = (s: Settings, ev: keyof Settings["hooks"]) => s.hooks[ev] as Array<{ matcher: string; hooks: unknown[] }>;
const commands = (s: Settings, ev: keyof Settings["hooks"]) =>
  groups(s, ev).map((g) => ({ matcher: g.matcher, commands: g.hooks.map((h) => (h && typeof h === "object" ? (h as { command?: string }).command ?? null : null)) }));

describe("hookRowKey", () => {
  it("keys an owned binary by subcommand, canonicalising the basename, and ignores other tools", () => {
    expect(hookRowKey(`${NVM} session limit-stop`)).toEqual({ key: "storybloq:session limit-stop", rest: "session limit-stop", binBasename: "storybloq" });
    expect(hookRowKey("/opt/claudestory session limit-stop")?.binBasename).toBe("claudestory");
    expect(hookRowKey(`${NPX} session limit-stop`)?.key).toBe("storybloq:session limit-stop");
    expect(hookRowKey("/opt/claudestory session limit-stop")?.key).toBe("storybloq:session limit-stop");
    expect(hookRowKey("'/Users/o/My Apps/storybloq' hook-status")?.key).toBe("storybloq:hook-status");
    expect(hookRowKey("/Users/o/.until/bin/do-until-hook-stop")).toBeNull();
    expect(hookRowKey("/usr/local/bin/storybloq-presence hook")).toBeNull();
    expect(hookRowKey("storybloq hook-status | tee log")).toBeNull();
    expect(hookRowKey("storybloq hook-status; echo done")).toBeNull();
    expect(hookRowKey("storybloq hook-status && echo done")).toBeNull();
    expect(hookRowKey("storybloq hook-status > /tmp/out")).toBeNull();
    expect(hookRowKey("storybloq hook-status $(date)")).toBeNull();
  });
});

describe("matcher coverage", () => {
  it("classifies universal, literal alternatives and opaque matchers", () => {
    expect(matcherCoverage("")).toEqual({ kind: "universal" });
    expect(matcherCoverage(undefined)).toEqual({ kind: "universal" });
    expect(matcherCoverage(FULL)).toEqual({ kind: "sources", sources: new Set(["startup", "resume", "clear", "compact"]) });
    expect(matcherCoverage("rate_limit.*")).toEqual({ kind: "opaque", matcher: "rate_limit.*" });
    // A dangling or doubled pipe is an empty alternative, which a regex engine reads as "anything": not a literal set.
    expect(matcherCoverage("resume|")).toEqual({ kind: "opaque", matcher: "resume|" });
    expect(matcherCoverage("|resume")).toEqual({ kind: "opaque", matcher: "|resume" });
    expect(matcherCoverage("startup||resume")).toEqual({ kind: "opaque", matcher: "startup||resume" });
  });
  it("overlap and cover follow the source sets, and opaque matchers only match themselves", () => {
    const full = matcherCoverage(FULL);
    const resume = matcherCoverage("resume");
    const compact = matcherCoverage("compact");
    const uni = matcherCoverage("");
    const opaque = matcherCoverage("rate_limit.*");
    expect(coverageOverlaps(full, resume)).toBe(true);
    expect(coverageOverlaps(compact, resume)).toBe(false);
    expect(coverageOverlaps(uni, resume)).toBe(true);
    expect(coverageOverlaps(opaque, matcherCoverage("rate_limit"))).toBe(false);
    expect(coverageOverlaps(opaque, matcherCoverage("rate_limit.*"))).toBe(true);
    expect(coverageCovers(full, resume)).toBe(true);
    expect(coverageCovers(resume, full)).toBe(false);
    expect(coverageCovers(uni, full)).toBe(true);
    expect(coverageCovers(full, uni)).toBe(false);
    expect(coverageCovers(opaque, matcherCoverage("rate_limit.*"))).toBe(true);
    expect(coverageCovers(uni, opaque)).toBe(true);
  });
});

describe("findHookCollisions", () => {
  it("finds the two live collisions and nothing else", () => {
    const found = findHookCollisions(liveSettings());
    expect(found.map((c) => [c.hookType, c.key, c.rows.map((r) => r.matcher)])).toEqual([
      ["SessionStart", "storybloq:session resume-prompt", [FULL, "resume"]],
      ["StopFailure", "storybloq:session limit-stop", ["rate_limit", "rate_limit"]],
    ]);
  });
  it("a claudestory row and a storybloq row for the same subcommand collide", () => {
    const s = { hooks: { Stop: [{ matcher: "", hooks: [row("/opt/claudestory hook-status"), row(`${NVM} hook-status`)] }] } };
    expect(findHookCollisions(s)).toHaveLength(1);
  });
  it("is empty on absent or malformed hooks", () => {
    expect(findHookCollisions({})).toEqual([]);
    expect(findHookCollisions({ hooks: "nope" })).toEqual([]);
    expect(findHookCollisions({ hooks: { Stop: "nope", SessionStart: [null, 3, { matcher: "", hooks: "x" }] } })).toEqual([]);
  });
});

describe("dedupeHookRows", () => {
  it("keeps the validated global launcher's row with the union matcher, drops the npx rows, leaves everything else", () => {
    const s = liveSettings();
    const out = dedupeHookRows(s, globalFor(NVM));
    expect(out.changed).toBe(true);
    expect(out.unresolved).toEqual([]);
    expect(out.reconciled).toEqual([
      {
        hookType: "SessionStart",
        key: "storybloq:session resume-prompt",
        kept: { matcher: FULL, command: `${NVM} session resume-prompt` },
        dropped: [{ matcher: "resume", command: `${NPX} session resume-prompt` }],
      },
      {
        hookType: "StopFailure",
        key: "storybloq:session limit-stop",
        kept: { matcher: "rate_limit", command: `${NVM} session limit-stop` },
        dropped: [{ matcher: "rate_limit", command: `${NPX} session limit-stop` }],
      },
    ]);
    expect(commands(s, "SessionStart")).toEqual([
      { matcher: FULL, commands: [`${NVM} session resume-prompt`, `${NVM} session intel-start`] },
    ]);
    expect(commands(s, "StopFailure")).toEqual([
      { matcher: "rate_limit", commands: [`${NVM} session limit-stop`, null, null] },
    ]);
    // The T-424 disjoint pair, the foreign Stop row and the intel hooks are untouched.
    expect(commands(s, "PreToolUse")).toEqual([
      { matcher: "compact", commands: [`${NVM} session resume-prompt`] },
      { matcher: "resume", commands: [`${NVM} session resume-prompt`] },
    ]);
    expect(commands(s, "Stop")).toEqual([
      { matcher: "", commands: ["/Users/o/.until/bin/do-until-hook-stop"] },
      { matcher: "", commands: [`${NVM} hook-status`] },
    ]);
    expect(commands(s, "UserPromptSubmit")[0]!.commands).toEqual([`${NVM} session intel-prompt`]);
    expect(s.model).toBe("opus");
    expect(findHookCollisions(s)).toEqual([]);
    expect(dedupeHookRows(s, globalFor(NVM))).toEqual({ changed: false, reconciled: [], unresolved: [], pruned: [] });
  });

  it("two identical global rows collapse to one and the removed twin is reported dropped", () => {
    const s = { hooks: { Stop: [{ matcher: "", hooks: [row(`${NVM} hook-status`), row(`${NVM} hook-status`)] }] } };
    const out = dedupeHookRows(s, globalFor(NVM));
    expect(out.reconciled).toEqual([{ hookType: "Stop", key: "storybloq:hook-status", kept: { matcher: "", command: `${NVM} hook-status` }, dropped: [{ matcher: "", command: `${NVM} hook-status` }] }]);
    expect(commands(s as never, "Stop")).toEqual([{ matcher: "", commands: [`${NVM} hook-status`] }]);
  });

  it("the keeper is the global row even when the npx row is listed first", () => {
    const s = { hooks: { StopFailure: [{ matcher: "rate_limit", hooks: [row(`${NPX} session limit-stop`), row(`${NVM} session limit-stop`)] }] } };
    const out = dedupeHookRows(s, globalFor(NVM));
    expect(out.reconciled[0]!.kept.command).toBe(`${NVM} session limit-stop`);
    expect(commands(s as never, "StopFailure")).toEqual([{ matcher: "rate_limit", commands: [`${NVM} session limit-stop`] }]);
  });

  it("two non-global variants collapse to one row carrying the global command", () => {
    const s = { hooks: { StopFailure: [{ matcher: "rate_limit", hooks: [row(`${NPX} session limit-stop`), row("/opt/old/storybloq session limit-stop")] }] } };
    const out = dedupeHookRows(s, globalFor(NVM));
    expect(out.reconciled[0]!.kept).toEqual({ matcher: "rate_limit", command: `${NVM} session limit-stop` });
    expect(out.reconciled[0]!.dropped).toHaveLength(2);
    expect(commands(s as never, "StopFailure")).toEqual([{ matcher: "rate_limit", commands: [`${NVM} session limit-stop`] }]);
  });

  it("with no validated global launcher it reports the collisions and mutates nothing", () => {
    const s = liveSettings();
    const before = JSON.stringify(s);
    const out = dedupeHookRows(s, globalFor(null));
    expect(out.changed).toBe(false);
    expect(out.reconciled).toEqual([]);
    expect(out.unresolved.map((c) => c.hookType)).toEqual(["SessionStart", "StopFailure"]);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("overlapping partial matchers collapse to one row with the union matcher", () => {
    const s = { hooks: { SessionStart: [
      { matcher: "startup|resume", hooks: [row(`${NPX} session resume-prompt`)] },
      { matcher: "resume|clear", hooks: [row(`${NVM} session resume-prompt`)] },
    ] } };
    const out = dedupeHookRows(s, globalFor(NVM));
    expect(out.reconciled[0]!.kept).toEqual({ matcher: "startup|resume|clear", command: `${NVM} session resume-prompt` });
    expect(commands(s as never, "SessionStart")).toEqual([{ matcher: "startup|resume|clear", commands: [`${NVM} session resume-prompt`] }]);
  });

  it("overlap joins transitively: a|b, b|c and c|d collapse to one row under a|b|c|d though a|b and c|d are disjoint", () => {
    const s = { hooks: { SessionStart: [
      { matcher: "a|b", hooks: [row(`${NPX} session resume-prompt`)] },
      { matcher: "b|c", hooks: [row(`${NVM} session resume-prompt`)] },
      { matcher: "c|d", hooks: [row(`${NPX} session resume-prompt`)] },
    ] } };
    const out = dedupeHookRows(s, globalFor(NVM));
    expect(out.reconciled).toHaveLength(1);
    expect(out.reconciled[0]!.kept).toEqual({ matcher: "a|b|c|d", command: `${NVM} session resume-prompt` });
    expect(commands(s as never, "SessionStart")).toEqual([{ matcher: "a|b|c|d", commands: [`${NVM} session resume-prompt`] }]);
  });

  it("the global row in the narrow group wins over the npx row in the broad group, and lands in the broad group", () => {
    const s = { hooks: { SessionStart: [
      { matcher: FULL, hooks: [row(`${NPX} session resume-prompt`), row("/other/tool start")] },
      { matcher: "resume", hooks: [row(`${NVM} session resume-prompt`)] },
    ] } };
    dedupeHookRows(s, globalFor(NVM));
    expect(commands(s as never, "SessionStart")).toEqual([{ matcher: FULL, commands: [`${NVM} session resume-prompt`, "/other/tool start"] }]);
  });

  it("options come from the global row, not from the first row", () => {
    const s = { hooks: { Stop: [{ matcher: "", hooks: [row(`${NPX} hook-status`, { async: true, timeout: 99 }), row(`${NVM} hook-status`, { timeout: 5 })] }] } };
    dedupeHookRows(s, globalFor(NVM));
    expect((s.hooks.Stop[0]!.hooks as unknown[])).toEqual([{ type: "command", command: `${NVM} hook-status`, timeout: 5 }]);
  });

  it("options come from the first row when no row is the global command", () => {
    const s = { hooks: { Stop: [{ matcher: "", hooks: [row(`${NPX} hook-status`, { async: true }), row("/opt/old/storybloq hook-status", { timeout: 5 })] }] } };
    dedupeHookRows(s, globalFor(NVM));
    expect((s.hooks.Stop[0]!.hooks as unknown[])).toEqual([{ type: "command", command: `${NVM} hook-status`, async: true }]);
  });

  it("an opaque matcher is never merged with a literal one, and identical opaque matchers still dedupe", () => {
    const s = { hooks: { StopFailure: [
      { matcher: "rate_limit.*", hooks: [row(`${NPX} session limit-stop`)] },
      { matcher: "rate_limit", hooks: [row(`${NVM} session limit-stop`)] },
      { matcher: "(x|y)", hooks: [row(`${NPX} session limit-stop`), row(`${NVM} session limit-stop`)] },
    ] } };
    const out = dedupeHookRows(s, globalFor(NVM));
    expect(commands(s as never, "StopFailure")).toEqual([
      { matcher: "rate_limit.*", commands: [`${NPX} session limit-stop`] },
      { matcher: "rate_limit", commands: [`${NVM} session limit-stop`] },
      { matcher: "(x|y)", commands: [`${NVM} session limit-stop`] },
    ]);
    expect(out.reconciled).toHaveLength(1);
  });
});

describe("dedupeHookRows keeper placement (ISS-1222 post-hoc Codex finding)", () => {
  it("a keeper with no slot lands at the FIRST collision row's group position, even when the global row sits later in the file", () => {
    const s = { hooks: { SessionStart: [
      { matcher: "startup|resume", hooks: [row(`${NPX} session resume-prompt`)] },
      { matcher: "", hooks: [row("/other/tool start")] },
      { matcher: "resume|clear", hooks: [row(`${NVM} session resume-prompt`)] },
    ] } };
    dedupeHookRows(s, globalFor(NVM));
    expect(commands(s as never, "SessionStart")).toEqual([
      { matcher: "startup|resume|clear", commands: [`${NVM} session resume-prompt`] },
      { matcher: "", commands: ["/other/tool start"] },
    ]);
  });

  it("two placements in one event, separated by retained unrelated groups, each land before their own anchor", () => {
    const s = { hooks: { SessionStart: [
      { matcher: "a|b", hooks: [row(`${NPX} session resume-prompt`)] },
      { matcher: "", hooks: [row("/other/tool one")] },
      { matcher: "b|c", hooks: [row(`${NVM} session resume-prompt`)] },
      { matcher: "x|y", hooks: [row(`${NPX} session intel-start`)] },
      { matcher: "", hooks: [row("/other/tool two")] },
      { matcher: "y|z", hooks: [row(`${NVM} session intel-start`)] },
    ] } };
    dedupeHookRows(s, globalFor(NVM));
    expect(commands(s as never, "SessionStart")).toEqual([
      { matcher: "a|b|c", commands: [`${NVM} session resume-prompt`] },
      { matcher: "", commands: ["/other/tool one"] },
      { matcher: "x|y|z", commands: [`${NVM} session intel-start`] },
      { matcher: "", commands: ["/other/tool two"] },
    ]);
  });
});

describe("reconcileDuplicateHookRows", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  it("the real machine shape: an nvm launcher symlinked to dist/cli.js, an npx cache duplicate, resume versus the full group", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "iss1222-")));
    // The launcher the global install exposes is a symlink into a checkout (npm link).
    mkdirSync(join(dir, "checkout", "dist"), { recursive: true });
    writeFileSync(join(dir, "checkout", "dist", "cli.js"), "#!/usr/bin/env node\n");
    chmodSync(join(dir, "checkout", "dist", "cli.js"), 0o755);
    mkdirSync(join(dir, "nvm", "bin"), { recursive: true });
    const nvmBin = join(dir, "nvm", "bin", "storybloq");
    symlinkSync(join(dir, "checkout", "dist", "cli.js"), nvmBin);
    const npxBin = join(dir, ".npm", "_npx", "573f", "node_modules", ".bin", "storybloq");
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        SessionStart: [
          { matcher: FULL, hooks: [row(`${nvmBin} session resume-prompt`), row(`${nvmBin} session intel-start`, { timeout: 5 })] },
          { matcher: "resume", hooks: [row(`${npxBin} session resume-prompt`)] },
        ],
        StopFailure: [{ matcher: "rate_limit", hooks: [row(`${nvmBin} session limit-stop`), row(`${npxBin} session limit-stop`)] }],
      },
    }, null, 2));

    const out = await reconcileDuplicateHookRows(settingsPath, globalFor(nvmBin));
    expect(out.changed).toBe(true);
    expect(out.reconciled.map((r) => [r.hookType, r.kept.matcher, r.dropped.map((d) => d.command)])).toEqual([
      ["SessionStart", FULL, [`${npxBin} session resume-prompt`]],
      ["StopFailure", "rate_limit", [`${npxBin} session limit-stop`]],
    ]);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as Settings & { permissions: unknown };
    expect(after.permissions).toEqual({ allow: ["Bash(git status)"] });
    expect(commands(after, "SessionStart")).toEqual([
      { matcher: FULL, commands: [`${nvmBin} session resume-prompt`, `${nvmBin} session intel-start`] },
    ]);
    expect(commands(after, "StopFailure")).toEqual([{ matcher: "rate_limit", commands: [`${nvmBin} session limit-stop`] }]);
    expect(findHookCollisions(after)).toEqual([]);
    // Second run: nothing to do, file untouched.
    const text = readFileSync(settingsPath, "utf-8");
    expect(await reconcileDuplicateHookRows(settingsPath, globalFor(nvmBin))).toEqual({ changed: false, reconciled: [], unresolved: [], pruned: [] });
    expect(readFileSync(settingsPath, "utf-8")).toBe(text);
  });

  it("ISS-1226: an empty group under an event Storybloq owns is pruned even with no collision; other events are left alone", async () => {
    dir = mkdtempSync(join(tmpdir(), "iss1226-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: FULL, hooks: [row(`${NVM} session resume-prompt`)] },
          { matcher: "resume", hooks: [] },
        ],
        StopFailure: [{ matcher: "rate_limit", hooks: [] }],
        Notification: [{ matcher: "", hooks: [] }],
      },
    }, null, 2));
    const out = await reconcileDuplicateHookRows(settingsPath, globalFor(NVM));
    // T-534: StopFailure is no longer an event Storybloq registers under, so
    // an empty group there is someone else's and stays, like Notification's.
    expect(out).toEqual({ changed: true, reconciled: [], unresolved: [], pruned: [
      { hookType: "SessionStart", matcher: "resume" },
    ] });
    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as { hooks: Record<string, Array<{ matcher: string; hooks: unknown[] }>> };
    expect(after.hooks.SessionStart.map((g) => g.matcher)).toEqual([FULL]);
    expect(after.hooks.StopFailure).toEqual([{ matcher: "rate_limit", hooks: [] }]);
    expect(after.hooks.Notification).toEqual([{ matcher: "", hooks: [] }]);
    // Second run: nothing left to prune, no write.
    const text = readFileSync(settingsPath, "utf-8");
    expect((await reconcileDuplicateHookRows(settingsPath, globalFor(NVM))).changed).toBe(false);
    expect(readFileSync(settingsPath, "utf-8")).toBe(text);
  });

  it("ISS-1226: with no global launcher the prune still runs, since it drops no row", async () => {
    dir = mkdtempSync(join(tmpdir(), "iss1226-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [row(`${NVM} hook-status`)] }, { matcher: "", hooks: [] }] } }));
    const out = await reconcileDuplicateHookRows(settingsPath, globalFor(null));
    expect(out.changed).toBe(true);
    expect(out.pruned).toEqual([{ hookType: "Stop", matcher: "" }]);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as { hooks: { Stop: unknown[] } };
    expect(after.hooks.Stop).toHaveLength(1);
  });

  it("does not write when the global launcher is unresolved, and survives a missing or malformed file", async () => {
    dir = mkdtempSync(join(tmpdir(), "iss1222-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(liveSettings()));
    const text = readFileSync(settingsPath, "utf-8");
    const out = await reconcileDuplicateHookRows(settingsPath, globalFor(null));
    expect(out.changed).toBe(false);
    expect(out.unresolved).toHaveLength(2);
    expect(readFileSync(settingsPath, "utf-8")).toBe(text);
    expect(await reconcileDuplicateHookRows(join(dir, "missing.json"), globalFor(NVM))).toEqual({ changed: false, reconciled: [], unresolved: [], pruned: [] });
    writeFileSync(settingsPath, "{not json");
    expect(await reconcileDuplicateHookRows(settingsPath, globalFor(NVM))).toEqual({ changed: false, reconciled: [], unresolved: [], pruned: [] });
    expect(readFileSync(settingsPath, "utf-8")).toBe("{not json");
  });
});
