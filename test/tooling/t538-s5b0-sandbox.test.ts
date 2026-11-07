/**
 * T-538 S5b-0, ISS-1455: the Codex launcher runs under a real sandbox on the
 * first and on every resumed turn. The setting does not persist in a session
 * (a resume with no policy falls back to read-only), so each form must carry it.
 */
import { describe, expect, it } from "vitest";
import { codexSandboxArgs, codexSandboxProblems, turnArgs } from "../../scripts/onboarding-eval-lib.js";

const roots = ["/w/home", "/w/tmp"];
const base = { client: "codex" as const, model: "m", project: "/w/project", claudeArgs: [], sessionId: "s", writableRoots: roots };

describe.each([[true], [false]])("the Codex turn argv, first=%s", (first) => {
  const args = turnArgs({ ...base, first }, "hello");
  it("never carries the bypass", () => {
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
  it("carries the whole policy", () => {
    expect(codexSandboxProblems(args)).toEqual([]);
    for (const part of codexSandboxArgs(roots)) expect(args).toContain(part);
  });
  it("keeps the prompt behind the option terminator", () => {
    expect(args.slice(-2)).toEqual(["--", "hello"]);
  });
  it("refuses to build a turn with no writable roots", () => {
    expect(() => turnArgs({ ...base, first, writableRoots: undefined }, "x")).toThrow(/writable roots/);
  });
});

describe("the preflight's reading of an argv", () => {
  const good = turnArgs({ ...base, first: true }, "x");
  const withOption = (...extra: string[]): string[] => { const end = good.indexOf("--"); return [...good.slice(0, end), ...extra, ...good.slice(end)]; };
  it("reads a flag after the terminator as the prompt, not an option", () => {
    expect(codexSandboxProblems([...good, "--dangerously-bypass-approvals-and-sandbox"])).toEqual([]);
  });
  it.each([
    ["the bypass flag", withOption("--dangerously-bypass-approvals-and-sandbox")],
    ["a wider --sandbox", withOption("--sandbox", "danger-full-access")],
    ["a wider -s", withOption("-s", "danger-full-access")],
    ["a wider mode by config", withOption("-c", 'sandbox_mode="danger-full-access"')],
    ["network on", withOption("-c", "sandbox_workspace_write.network_access=true")],
    ["/tmp allowed again", good.filter((a) => !a.includes("exclude_slash_tmp"))],
    ["TMPDIR allowed again", good.filter((a) => !a.includes("exclude_tmpdir_env_var"))],
    ["web search left on", good.filter((a) => !a.includes("web_search"))],
    ["multi-agent left on", good.filter((a) => !a.includes("multi_agent"))],
  ])("refuses %s", (_name, args) => {
    expect(codexSandboxProblems(args).length).toBeGreaterThan(0);
  });
});
