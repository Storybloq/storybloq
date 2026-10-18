/**
 * ISS-1222: `storybloq health` reports duplicate storybloq hook rows in
 * ~/.claude/settings.json before a reconcile and none after.
 */
import { describe, it, expect } from "vitest";
import { checkHookDuplicates } from "../../../src/core/health/hook-duplicates.js";
import { dedupeHookRows } from "../../../src/core/hook-duplicates.js";
import { formatHookCommand } from "../../../src/core/hook-migration.js";
import { ctxFor, stubDeps, HOME } from "./stub-deps.js";

const SETTINGS = `${HOME}/.claude/settings.json`;
const NVM = "/Users/o/.nvm/versions/node/v22.18.0/bin/storybloq";
const NPX = "/Users/o/.npm/_npx/573f0a688c465d03/node_modules/.bin/storybloq";
const FULL = "startup|resume|clear|compact";
const row = (command: string) => ({ type: "command", command });

function liveSettings() {
  return {
    hooks: {
      SessionStart: [
        { matcher: FULL, hooks: [row(`${NVM} session resume-prompt`), row(`${NVM} session intel-start`)] },
        { matcher: "resume", hooks: [row(`${NPX} session resume-prompt`)] },
      ],
      StopFailure: [{ matcher: "rate_limit", hooks: [row(`${NVM} session limit-stop`), row(`${NPX} session limit-stop`)] }],
      PreToolUse: [
        { matcher: "compact", hooks: [row(`${NVM} session resume-prompt`)] },
        { matcher: "resume", hooks: [row(`${NVM} session resume-prompt`)] },
      ],
    },
  };
}

const run = (settings: unknown, over: Parameters<typeof stubDeps>[0] = {}, client: "claude" | "codex" = "claude") =>
  checkHookDuplicates(ctxFor({ client }), stubDeps({ files: settings === undefined ? {} : { [SETTINGS]: typeof settings === "string" ? settings : JSON.stringify(settings) }, ...over }));

describe("hook-duplicates health check (ISS-1222)", () => {
  it("advises on the live shape, naming each collision, its rows and the fix", async () => {
    const c = await run(liveSettings());
    expect(c.status).toBe("advise");
    expect(c.message).toMatch(/^~\/\.claude\/settings\.json runs the same storybloq hook more than once: /);
    expect(c.message).toContain("SessionStart `storybloq session resume-prompt` x 2");
    expect(c.message).toContain(`matcher "resume": ${NPX} session resume-prompt`);
    expect(c.message).toContain("StopFailure `storybloq session limit-stop` x 2");
    expect(c.message).toContain("Run `storybloq setup-skill` to keep the global binary's row and drop the rest.");
    expect(c.advice).toBe(c.message);
    expect(c.detail).toMatchObject({ collisions: 2, path: SETTINGS });
    // The T-424 disjoint pair is not reported.
    expect(c.message).not.toContain("PreToolUse");
  });

  it("is ok on the same settings once the reconcile has run", async () => {
    const s = liveSettings();
    expect(dedupeHookRows(s, (rest) => formatHookCommand(NVM, rest)).changed).toBe(true);
    const c = await run(s);
    expect(c.status).toBe("ok");
    expect(c.message).toBe("No duplicate storybloq hook rows were found in ~/.claude/settings.json; each hook there runs once per event and source.");
    expect(c.detail).toMatchObject({ collisions: 0 });
  });

  it("is ok when the file is absent and names the scope", async () => {
    const c = await run(undefined);
    expect(c.status).toBe("ok");
    expect(c.message).toContain("~/.claude/settings.json does not exist");
  });

  it("skips, never advises, on an unreadable or unparseable file", async () => {
    const unreadable = await checkHookDuplicates(ctxFor(), stubDeps({ files: { [SETTINGS]: { kind: "indeterminate", reason: "EACCES" } } }));
    expect(unreadable.status).toBe("skip");
    expect(unreadable.detail).toMatchObject({ unreadable: SETTINGS, reason: "settings unreadable" });
    const broken = await run("{not json");
    expect(broken.status).toBe("skip");
    expect(broken.message).toContain("unparseable");
  });

  it("skips under Codex", async () => {
    const c = await run(liveSettings(), {}, "codex");
    expect(c.status).toBe("skip");
    expect(c.detail.reason).toBe("hooks are Claude Code settings");
  });
});

describe("hook-duplicates reads Claude's config dir (ISS-1270)", () => {
  it("reads and names the override's settings.json, not HOME's", async () => {
    const files = { "/cfg/settings.json": JSON.stringify(liveSettings()), [SETTINGS]: JSON.stringify({}) };
    const c = await checkHookDuplicates(ctxFor({ client: "claude" }), stubDeps({ files, claudeConfigDir: "/cfg", claudeSettingsDisplay: "/cfg/settings.json" }));
    expect(c.status).toBe("advise");
    expect(c.message).toMatch(/^\/cfg\/settings\.json runs the same storybloq hook more than once: /);
    expect(c.detail).toMatchObject({ path: "/cfg/settings.json" });
  });
});
