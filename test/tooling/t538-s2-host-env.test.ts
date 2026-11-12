/**
 * T-538 signed-in note v5 section 12, S2: the host env. The signed-in client column (HOME the password-database
 * home, no CLAUDE_CONFIG_DIR, no token), the signed-in isolationProblems branch and the effective-path expectation.
 * The refusal stays active: nothing here launches a client. Every home is a fixture; no credential value is read.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envFor, type EnvInputs } from "../../scripts/onboarding-eval-host.js";
import { effectivePathProblems, isolationProblems } from "../../scripts/onboarding-eval-run.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = "/fake/real-home";
const SECRET = "SECRET-VALUE-NEVER-PRINTED";
const BASE: EnvInputs = {
  client: "claude", path: "/w/cli-bin:/usr/bin:/bin", home: "/w/home", tmp: "/w/tmp", lang: "en_US.UTF-8",
  runnerHome: "/w/sandbox-runner-home", globalDir: "/w/storybloq-global", events: "/w/eval-events/events.jsonl", fault: null, reviewStore: "/w/storybloq-setup-review-store",
  outside: "/w/outside-probe", tools: "/pkg/scripts/onboarding-eval-tools.json", degraded: false,
};
const SIGNED: EnvInputs = { ...BASE, isolation: "signed-in", realHome: REAL };
const FRESH: EnvInputs = { ...BASE, claudeConfigDir: "/w/claude-config", oauthToken: SECRET };

describe("S2: the signed-in client column", () => {
  it("is exactly the fresh column's keys without CLAUDE_CONFIG_DIR and the token, with HOME the real home", () => {
    expect(envFor("client", SIGNED)).toEqual({
      PATH: BASE.path, HOME: REAL, TMPDIR: "/w/tmp", LANG: "en_US.UTF-8", NO_UPDATE_NOTIFIER: "1", STORYBLOQ_CLIENT: "claude",
      STORYBLOQ_GLOBAL_DIR: "/w/storybloq-global", STORYBLOQ_EVAL_EVENTS: BASE.events, STORYBLOQ_SETUP_REVIEW_DIR: BASE.reviewStore,
    });
    const fresh = Object.keys(envFor("client", FRESH)).filter((k) => k !== "CLAUDE_CONFIG_DIR" && k !== "CLAUDE_CODE_OAUTH_TOKEN").sort();
    expect(Object.keys(envFor("client", SIGNED)).sort()).toEqual(fresh);
    expect(envFor("client", { ...SIGNED, degraded: true }).ENABLE_TOOL_SEARCH).toBe("true");
  });

  it("takes HOME from the real-home input, never from the scratch home", () => {
    expect(envFor("client", { ...SIGNED, home: "/somewhere/else" }).HOME).toBe(REAL);
  });

  it.each([
    ["a config dir", { claudeConfigDir: "/w/claude-config" }, "CLAUDE_CONFIG_DIR"],
    ["a token", { oauthToken: SECRET }, "CLAUDE_CODE_OAUTH_TOKEN"],
    ["both", { claudeConfigDir: SECRET, oauthToken: SECRET }, "CLAUDE_CONFIG_DIR and CLAUDE_CODE_OAUTH_TOKEN"],
    ["an empty token", { oauthToken: "" }, "CLAUDE_CODE_OAUTH_TOKEN"],
  ])("refuses %s by name only", (_n, extra, names) => {
    let message = "";
    try { envFor("client", { ...SIGNED, ...extra }); } catch (e) { message = (e as Error).message; }
    expect(message).toBe(`onboarding-eval: the signed-in client column refuses ${names}`);
    expect(message).not.toContain(SECRET);
  });

  it("refuses a missing or empty real home", () => {
    expect(() => envFor("client", { ...SIGNED, realHome: undefined })).toThrow("onboarding-eval: HOME has no value for the client environment");
    expect(() => envFor("client", { ...SIGNED, realHome: "" })).toThrow("onboarding-eval: HOME has no value for the client environment");
  });

  it("is the Claude client's only: a signed-in Codex column is refused", () => {
    expect(() => envFor("client", { ...SIGNED, client: "codex", clientCodexHome: "/w/home/.codex" })).toThrow(/signed-in client column is the Claude client's only/);
  });

  it("leaves the server column alone: scratch HOME and the runner home, as under fresh", () => {
    expect(envFor("server", SIGNED)).toEqual(envFor("server", FRESH));
    expect(envFor("server", SIGNED).HOME).toBe("/w/home");
  });

  it("an explicit fresh isolation is the fresh column, unchanged", () => {
    expect(envFor("client", { ...FRESH, isolation: "fresh" })).toEqual(envFor("client", FRESH));
    expect(envFor("client", FRESH)).toMatchObject({ HOME: "/w/home", CLAUDE_CONFIG_DIR: "/w/claude-config", CLAUDE_CODE_OAUTH_TOKEN: SECRET });
  });
});

describe("S2: signed-in isolation", () => {
  const sig = (): Record<string, string> => envFor("client", SIGNED);
  const si = { realHome: REAL };

  it("the signed-in column itself is isolated", () => {
    expect(isolationProblems({ ...sig() }, "/w", "claude", sig(), si)).toEqual([]);
    expect(isolationProblems({ ...sig() }, "/w", "claude", undefined, si)).toEqual([]);
  });

  it("HOME must be the real home exactly", () => {
    expect(isolationProblems({ ...sig(), HOME: "/w/home" }, "/w", "claude", sig(), si)).toEqual(["HOME=/w/home is not the real home"]);
    expect(isolationProblems({ ...sig(), HOME: `${REAL}/` }, "/w", "claude", sig(), si)).toEqual([`HOME=${REAL}/ is not the real home`]);
    const { HOME: _h, ...noHome } = sig();
    expect(isolationProblems(noHome, "/w", "claude", undefined, si)).toEqual(["HOME is not set"]);
  });

  it("CLAUDE_CONFIG_DIR must be absent, named and never inherited twice", () => {
    expect(isolationProblems({ ...sig(), CLAUDE_CONFIG_DIR: "/w/claude-config" }, "/w", "claude", sig(), si)).toEqual(["CLAUDE_CONFIG_DIR is set", "CLAUDE_CONFIG_DIR is not in the client column"]);
  });

  it("a token or API-key name is refused by name; its value never appears", () => {
    const p = isolationProblems({ ...sig(), CLAUDE_CODE_OAUTH_TOKEN: SECRET, ANTHROPIC_API_KEY: SECRET }, "/w", "claude", undefined, si);
    expect(p).toEqual(["ANTHROPIC_API_KEY is set", "CLAUDE_CODE_OAUTH_TOKEN is set"]);
    expect(p.join("\n")).not.toContain(SECRET);
  });

  it("TMPDIR stays under the scratch directory, and so does any CODEX_HOME", () => {
    expect(isolationProblems({ ...sig(), TMPDIR: "/tmp" }, "/w", "claude", undefined, si)).toEqual(["TMPDIR=/tmp is outside the scratch directory"]);
    expect(isolationProblems({ ...sig(), CODEX_HOME: `${REAL}/.codex` }, "/w", "claude", undefined, si)).toEqual([`CODEX_HOME=${REAL}/.codex is outside the scratch directory`]);
  });

  it("an inherited client variable is a problem, as under fresh", () => {
    expect(isolationProblems({ ...sig(), CLAUDECODE: "1" }, "/w", "claude", undefined, si)).toEqual(["CLAUDECODE is inherited"]);
  });

  it("is the Claude client's only", () => {
    expect(isolationProblems({ ...sig() }, "/w", "codex", undefined, si)).toEqual(["signed-in isolation is the Claude client's only"]);
  });

  it("the fresh column is isolated as fresh and refused as signed-in; fresh without the option is unchanged", () => {
    const fresh = envFor("client", FRESH);
    expect(isolationProblems({ ...fresh }, "/w", "claude", fresh)).toEqual([]);
    const p = isolationProblems({ ...fresh }, "/w", "claude", fresh, si);
    expect(p).toEqual(expect.arrayContaining(["HOME=/w/home is not the real home", "CLAUDE_CONFIG_DIR is set", "CLAUDE_CODE_OAUTH_TOKEN is set"]));
    expect(p.join("\n")).not.toContain(SECRET);
    expect(isolationProblems({ ...sig() }, "/w", "claude", sig())).toEqual(expect.arrayContaining([`HOME=${REAL} is outside the scratch directory`, "CLAUDE_CONFIG_DIR is not set"]));
  });
});

describe("S2: the effective paths", () => {
  it("fresh: what the shell resolved must be what the environment set, CLAUDE_CONFIG_DIR included", () => {
    const env = { HOME: "/w/home", CLAUDE_CONFIG_DIR: "/w/claude-config" };
    expect(effectivePathProblems({ home: "/w/home", codexHome: "", claudeConfigDir: "/w/claude-config" }, env)).toEqual([]);
    expect(effectivePathProblems({ home: "/w/home", codexHome: "", claudeConfigDir: "" }, env)).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(effectivePathProblems({ home: "/elsewhere", codexHome: "", claudeConfigDir: "/w/claude-config" }, env)).toEqual(["HOME"]);
    expect(effectivePathProblems({ home: "/w/home", codexHome: "/w/home/.codex", claudeConfigDir: "/w/claude-config" }, env)).toEqual(["CODEX_HOME"]);
    expect(effectivePathProblems({ home: "/w/home", codexHome: "/w/home/.codex", claudeConfigDir: "" }, { HOME: "/w/home", CODEX_HOME: "/w/home/.codex" })).toEqual([]);
  });

  it("signed-in: HOME the real home and no config dir", () => {
    const env = { HOME: REAL };
    expect(effectivePathProblems({ home: REAL, codexHome: "", claudeConfigDir: "" }, env, { realHome: REAL })).toEqual([]);
    expect(effectivePathProblems({ home: REAL, codexHome: "", claudeConfigDir: "/w/claude-config" }, env, { realHome: REAL })).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(effectivePathProblems({ home: "/w/home", codexHome: "", claudeConfigDir: "" }, { HOME: "/w/home" }, { realHome: REAL })).toEqual(["HOME is not the real home"]);
    expect(effectivePathProblems({ home: REAL, codexHome: "", claudeConfigDir: "/w/claude-config" }, { HOME: REAL, CLAUDE_CONFIG_DIR: "/w/claude-config" }, { realHome: REAL })).toEqual(["CLAUDE_CONFIG_DIR"]);
  });

  it("a real shell under the signed-in column resolves the fixture real home and no config dir", () => {
    const col = envFor("client", { ...SIGNED, path: "/usr/bin:/bin" });
    const out = spawnSync("/bin/sh", ["-c", 'printf "%s\\n%s\\n%s\\n" "$HOME" "${CODEX_HOME-}" "${CLAUDE_CONFIG_DIR-}"'], { env: col, encoding: "utf-8" }).stdout.split("\n");
    const effective = { home: out[0] ?? "", codexHome: out[1] ?? "", claudeConfigDir: out[2] ?? "" };
    expect(effective).toEqual({ home: REAL, codexHome: "", claudeConfigDir: "" });
    expect(effectivePathProblems(effective, col, { realHome: REAL })).toEqual([]);
  });

  it("the run checks its effective paths with effectivePathProblems", () => {
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8");
    expect(src).toContain("if (effectivePathProblems(effectivePaths, env).length > 0) throw new Error(`onboarding-eval: effective paths differ from the provisioned ones");
  });
});
