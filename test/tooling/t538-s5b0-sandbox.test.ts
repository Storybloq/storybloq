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
    expect(codexSandboxProblems(args, roots)).toEqual([]);
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
  /** The argv with a whole setting gone: the -c and its value together. */
  const without = (key: string): string[] => { const i = good.findIndex((a) => a.includes(key)); return [...good.slice(0, i - 1), ...good.slice(i + 1)]; };
  it("reads a flag after the terminator as the prompt, not an option", () => {
    expect(codexSandboxProblems([...good, "--dangerously-bypass-approvals-and-sandbox"], roots)).toEqual([]);
  });
  it.each([
    ["the bypass flag", withOption("--dangerously-bypass-approvals-and-sandbox")],
    ["a wider --sandbox", withOption("--sandbox", "danger-full-access")],
    ["a wider -s", withOption("-s", "danger-full-access")],
    ["a wider mode by config", withOption("-c", 'sandbox_mode="danger-full-access"')],
    ["network on", withOption("-c", "sandbox_workspace_write.network_access=true")],
    ["/tmp allowed again", without("exclude_slash_tmp")],
    ["TMPDIR allowed again", without("exclude_tmpdir_env_var")],
    ["web search left on", without("web_search")],
    ["multi-agent left on", without("multi_agent")],
    ["approvals left on", without("approval_policy")],
    ["the mode left out", without("sandbox_mode")],
    ["the writable roots left out", without("writable_roots")],
    ["/tmp allowed by a later override", withOption("-c", "sandbox_workspace_write.exclude_slash_tmp=false")],
    ["TMPDIR allowed by a later override", withOption("-c", "sandbox_workspace_write.exclude_tmpdir_env_var=false")],
    ["web search on by a later override", withOption("-c", 'web_search="live"')],
    ["multi-agent on by a later override", withOption("-c", "features.multi_agent=true")],
    ["the filesystem root as a later writable root", withOption("-c", 'sandbox_workspace_write.writable_roots=["/"]')],
    ["approvals changed by a later override", withOption("-c", 'approval_policy="on-request"')],
    ["a later override in the --config= form", withOption("--config=features.multi_agent=true")],
    ["a later override with spaces round the equals", withOption("-c", "features.multi_agent = true")],
    ["a later override with a quoted key", withOption("-c", '"features".multi_agent=true')],
    ["the whole features table", withOption("-c", "features={multi_agent=true}")],
    ["the whole write-policy table", withOption("-c", "sandbox_workspace_write={exclude_slash_tmp=false}")],
    ["a settings profile", withOption("-c", 'profile="wide"')],
    ["a setting this policy does not name", withOption("-c", 'tools.web_search=true')],
    ["a config with no value", withOption("-c", "web_search")],
    ["an extra writable folder by flag", withOption("--add-dir", "/")],
    ["a flag as the model", ["exec", "--model", "--yolo", ...good.slice(3)]],
    ["a flag as the resumed session", ["exec", "resume", "--yolo", ...good.slice(1)]],
    ["roots that differ from the attempt's", turnArgs({ ...base, first: true, writableRoots: ["/"] }, "x")],
    ["the attempt's roots with one added", turnArgs({ ...base, first: true, writableRoots: [...roots, "/"] }, "x")],
    ["the attempt's roots in another order", turnArgs({ ...base, first: true, writableRoots: [...roots].reverse() }, "x")],
  ])("refuses %s", (_name, args) => {
    expect(codexSandboxProblems(args, roots).length).toBeGreaterThan(0);
  });
});
