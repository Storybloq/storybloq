/**
 * T-525 Addendum E5: the real-home classification and the metadata-only inventory, on a planted fake home.
 * Nothing here touches the real HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStatePath, inventory, inventoryViolations, sessionOf } from "../../scripts/continuity-home.js";

const OURS = "11111111-2222-4333-8444-555555555555";
const THEIRS = "99999999-8888-4777-8666-555555555555";
let home: string;
const put = (rel: string, body = "x"): void => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), body);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "e5-home-"));
  put(".claude.json", "{}");
  put(".claude/settings.json", "{}");
  put(".claude/skills/story/SKILL.md", "# skill");
  put(".claude/plugins/installed_plugins.json", "{}");
  mkdirSync(join(home, ".claude", "projects", "-w-project"), { recursive: true });
});
afterEach(() => {
  for (const rel of [".claude/.credentials.json", ".claude/locked"]) { try { chmodSync(join(home, rel), 0o700); } catch { /* absent */ } }
  rmSync(home, { recursive: true, force: true });
});

describe("E5 classifyStatePath", () => {
  it.each([
    [".claude.json", "credential"], [".claude.json.backup", "credential"], [".claude/.credentials.json", "credential"],
    [".claude/oauth-cache", "credential"], [".claude/some-token.json", "credential"],
    [`.claude/projects/-w-project/${OURS}.jsonl`, "transcript"],
    [`.claude/session-env/${OURS}/x`, "runtime"], [`.claude/todos/${OURS}-agent-1.json`, "runtime"], [".claude/shell-snapshots/snap.sh", "runtime"],
    [".claude/settings.json", "unknown"], [".claude/skills/story/SKILL.md", "unknown"], [".claude/statsig/x", "unknown"],
  ])("%s is %s", (rel, cls) => {
    expect(classifyStatePath(rel)).toBe(cls);
  });
  it("binds transcript and runtime paths to their session id", () => {
    expect(sessionOf(`.claude/projects/-w-project/${OURS}.jsonl`)).toBe(OURS);
    expect(sessionOf(`.claude/todos/${OURS}-agent.json`)).toBe(OURS);
    expect(sessionOf(".claude/settings.json")).toBeNull();
  });
});

describe("E5 inventory: metadata only, never opened, never followed", () => {
  it("a FIFO named .claude.json and an unreadable credentials file are listed without hanging or failing", () => {
    rmSync(join(home, ".claude.json"));
    execFileSync("mkfifo", [join(home, ".claude.json")]);
    put(".claude/.credentials.json", "secret");
    chmodSync(join(home, ".claude", ".credentials.json"), 0o000);
    const inv = inventory(home).entries;
    expect(inv.find((e) => e.rel === ".claude.json")).toMatchObject({ type: "other", class: "credential" });
    expect(inv.find((e) => e.rel === ".claude/.credentials.json")).toMatchObject({ type: "file", size: 6, class: "credential" });
  });
  it("a symlink out of the home is recorded and not followed", () => {
    const outside = mkdtempSync(join(tmpdir(), "e5-outside-"));
    writeFileSync(join(outside, "planted"), "x");
    symlinkSync(outside, join(home, ".claude", "link-out"));
    const inv = inventory(home).entries;
    expect(inv.find((e) => e.rel === ".claude/link-out")?.type).toBe("symlink");
    expect(inv.some((e) => e.rel.startsWith(".claude/link-out/"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });
  it("records no content: every entry has exactly the metadata fields", () => {
    for (const e of inventory(home).entries) expect(Object.keys(e).sort()).toEqual(["class", "mode", "mtimeMs", "rel", "size", "type"]);
  });
});

describe("E5 inventory problems: only ENOENT is absence", () => {
  it("an unreadable directory is a problem, not silence, and stops the arm by path", () => {
    put(".claude/locked/inner.json");
    const before = inventory(home);
    expect(before.problems).toEqual([]);
    chmodSync(join(home, ".claude", "locked"), 0o000);
    const after = inventory(home);
    expect(after.problems).toEqual([{ rel: ".claude/locked", op: "readdir", code: "EACCES" }]);
    expect(inventoryViolations(before, after, [OURS]).filter((c) => c.kind === "unreadable").map((c) => c.rel)).toEqual([".claude/locked"]);
  });
  it.each([["EIO"], ["ELOOP"], ["EACCES"]])("an injected lstat %s is a problem; ENOENT is plain absence", (code) => {
    const fail = (c: string) => (p: string) => { if (p.endsWith(".claude/settings.json")) throw Object.assign(new Error(c), { code: c }); return lstatSync(p); };
    const inv = inventory(home, { lstat: fail(code), readdir: (p) => readdirSync(p) });
    expect(inv.problems).toEqual([{ rel: ".claude/settings.json", op: "lstat", code }]);
    const gone = inventory(home, { lstat: fail("ENOENT"), readdir: (p) => readdirSync(p) });
    expect(gone.problems).toEqual([]);
    expect(gone.entries.some((e) => e.rel === ".claude/settings.json")).toBe(false);
    expect(inventoryViolations(inventory(home), inv, [OURS]).map((c) => c.kind)).toContain("unreadable");
  });
});

describe("E5 inventoryViolations", () => {
  const touch = (rel: string): void => { const t = new Date(Date.now() + 5_000); utimesSync(join(home, rel), t, t); };
  it("this run's transcript and runtime files, and a .claude.json metadata change, are allowed", () => {
    const before = inventory(home);
    put(`.claude/projects/-w-project/${OURS}.jsonl`, "{}\n");
    put(`.claude/session-env/${OURS}/env`, "x");
    put(`.claude/todos/${OURS}-agent-1.json`, "[]");
    writeFileSync(join(home, ".claude.json"), '{"numStartups":2}');
    touch(".claude.json");
    expect(inventoryViolations(before, inventory(home), [OURS])).toEqual([]);
  });
  it.each([
    ["another session's transcript", () => put(`.claude/projects/-w-project/${THEIRS}.jsonl`, "{}\n")],
    ["a new skill", () => put(".claude/skills/other/SKILL.md")],
    ["a new plugin file", () => put(".claude/plugins/new.json")],
    ["a changed user settings file", () => { writeFileSync(join(home, ".claude", "settings.json"), '{"hooks":{}}'); touch(".claude/settings.json"); }],
    ["a credentials file's mtime", () => { put(".claude/.credentials.json"); }],
    ["a removed skill", () => rmSync(join(home, ".claude", "skills"), { recursive: true })],
    ["a shell snapshot (not bound to a session)", () => put(".claude/shell-snapshots/snap.sh")],
  ])("%s stops the arm, named by path", (_n, act) => {
    const before = inventory(home);
    act();
    const v = inventoryViolations(before, inventory(home), [OURS]);
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((c) => typeof c.rel === "string" && c.rel.length > 0)).toBe(true);
  });
  it("an allowed transcript add with a parent chmod stops on the parent", () => {
    const before = inventory(home);
    put(`.claude/projects/-w-project/${OURS}.jsonl`, "{}\n");
    const dir = join(home, ".claude", "projects", "-w-project");
    chmodSync(dir, (lstatSync(dir).mode & 0o777) ^ 0o050);
    expect(inventoryViolations(before, inventory(home), [OURS]).map((c) => c.rel)).toEqual([".claude/projects/-w-project"]);
  });
  it("a holding path that was a file and is now a directory stops, even with this run's file inside", () => {
    put(".claude/session-env", "was a file");
    const before = inventory(home);
    rmSync(join(home, ".claude", "session-env"));
    put(`.claude/session-env/${OURS}/env`, "x");
    expect(inventoryViolations(before, inventory(home), [OURS]).map((c) => c.rel)).toContain(".claude/session-env");
  });
  it("a holding file replaced by a directory of the same mode stops on the type alone", () => {
    put(".claude/session-env", "was a file");
    chmodSync(join(home, ".claude", "session-env"), 0o755);
    const before = inventory(home);
    rmSync(join(home, ".claude", "session-env"));
    mkdirSync(join(home, ".claude", "session-env"), { mode: 0o755 });
    chmodSync(join(home, ".claude", "session-env"), 0o755);
    put(`.claude/session-env/${OURS}/env`, "x");
    expect(inventoryViolations(before, inventory(home), [OURS]).map((c) => c.rel)).toEqual([".claude/session-env"]);
  });
  it("this run's own transcript retyped from a file to a directory stops", () => {
    put(`.claude/projects/-w-project/${OURS}.jsonl`, "{}\n");
    const before = inventory(home);
    rmSync(join(home, ".claude", "projects", "-w-project", `${OURS}.jsonl`));
    mkdirSync(join(home, ".claude", "projects", "-w-project", `${OURS}.jsonl`));
    expect(inventoryViolations(before, inventory(home), [OURS]).map((c) => c.rel)).toContain(`.claude/projects/-w-project/${OURS}.jsonl`);
  });
  it.each([
    ["replaced by a symlink", () => { rmSync(join(home, ".claude.json")); symlinkSync(join(home, ".claude", "settings.json"), join(home, ".claude.json")); }],
    ["replaced by a FIFO", () => { rmSync(join(home, ".claude.json")); execFileSync("mkfifo", [join(home, ".claude.json")]); }],
    ["chmodded", () => chmodSync(join(home, ".claude.json"), 0o604)],
  ])(".claude.json %s stops", (_n, act) => {
    chmodSync(join(home, ".claude.json"), 0o644);
    const before = inventory(home);
    act();
    expect(inventoryViolations(before, inventory(home), [OURS]).map((c) => c.rel)).toContain(".claude.json");
  });
  it(".claude.json changing only size and mtime still passes", () => {
    const before = inventory(home);
    writeFileSync(join(home, ".claude.json"), '{"numStartups":3,"more":true}');
    touch(".claude.json");
    expect(inventoryViolations(before, inventory(home), [OURS])).toEqual([]);
  });
  it("removing this run's own transcript is still a violation", () => {
    put(`.claude/projects/-w-project/${OURS}.jsonl`, "{}\n");
    const before = inventory(home);
    rmSync(join(home, ".claude", "projects", "-w-project", `${OURS}.jsonl`));
    expect(inventoryViolations(before, inventory(home), [OURS]).map((c) => c.rel)).toContain(`.claude/projects/-w-project/${OURS}.jsonl`);
  });
});
