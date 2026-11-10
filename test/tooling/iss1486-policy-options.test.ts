/**
 * ISS-1486 commit A (plan D1): the shared launch policy takes its per-runner differences as options. The onboarding
 * options reproduce T-538 commit 1 byte for byte; a second options value serialises a policy, an argv and readback
 * expectations that agree with each other, and the checks refuse the other runner's launch.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_INIT_TOOLS, CLAUDE_TOOLS, claudeArgvProblems, claudePolicyObject, claudePolicySettings, claudeTurnArgs, initEventProblems, ONBOARDING_OPTIONS,
  policyOptionsProblems, READBACK_REQUESTS, readbackExpected, readbackProblems, type ClaudeExpected, type ClaudePolicyOptions, type ClaudeSession,
  type ReadbackExpected, type ReadbackStep,
} from "../../scripts/headless-policy.js";

const ROOTS = ["/w/project", "/w/project/.git", "/w/tmp", "/w/storybloq-global", "/w/eval-events"];
const ID = "0f6c2a8e-1b2c-4d3e-8f90-123456789abc";
const FIRST: ClaudeSession = { kind: "first", id: ID };
const RESUME: ClaudeSession = { kind: "resume", id: ID };
const E: ClaudeExpected = {
  model: "claude-opus-5-5", policyFile: "/w/claude-policy.json", policySha256: "0".repeat(64), mcpFile: "/w/mcp.json", mcpSha256: "1".repeat(64), project: "/w/project",
  roots: ROOTS, allowedTools: ["storybloq_status", "storybloq_init"], mcpTools: ["storybloq_status"], mcpLaunch: { command: "/usr/bin/node", args: ["/pkg/eval-mcp.js"] }, maxBudgetUsd: 15,
};
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A second runner's options, shaped as the continuity runner's (D2): Agent allowed, two extras. */
const SECOND: ClaudePolicyOptions = {
  builtInTools: [...CLAUDE_TOOLS, "Agent"], allowBuiltIns: ["Read", "Glob", "Grep", "Bash", "Skill", "Agent"], deny: ["WebFetch", "WebSearch", "Task"],
  extraArgs: [["--effort", "high"]], extraFlags: ["--no-session-persistence"],
};

const goodResponses = (createRequire(import.meta.url)("../fixtures/t538-claude-sentinel.cjs") as { goodResponses: (x: ReadbackExpected) => Record<string, Record<string, unknown>> }).goodResponses;
const steps = (r: Record<string, Record<string, unknown>>): ReadbackStep[] => READBACK_REQUESTS.map((subtype, i) => ({ requestId: `r${i + 1}`, subtype, outcome: "success", response: r[subtype] }));
const withConfig = (x: ReadbackExpected, config: (c: Record<string, unknown>) => Record<string, unknown>): ReadbackStep[] => {
  const r = JSON.parse(JSON.stringify(goodResponses(x))) as Record<string, Record<string, unknown>>;
  const servers = r.mcp_status!.mcpServers as { config: Record<string, unknown> }[];
  r.mcp_status!.mcpServers = servers.map((s) => ({ ...s, config: config(s.config) }));
  return steps(r);
};
const initEvent = (builtIns: readonly string[]): Record<string, unknown>[] => [{
  type: "system", subtype: "init", permissionMode: "dontAsk", apiKeySource: "none", mcp_servers: [{ name: "storybloq", status: "connected" }],
  tools: [...builtIns, "mcp__storybloq__storybloq_status"],
}];

describe("D1 the onboarding options are T-538 commit 1's constants", () => {
  it("names exactly the seven tools, the five allowed built-ins and the four denials, with no extras", () => {
    expect(ONBOARDING_OPTIONS).toEqual({
      builtInTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill"], allowBuiltIns: ["Read", "Glob", "Grep", "Bash", "Skill"],
      deny: ["WebFetch", "WebSearch", "Agent", "Task"], extraArgs: [], extraFlags: [],
    });
    expect(Object.isFrozen(ONBOARDING_OPTIONS)).toBe(true);
    expect([...ONBOARDING_OPTIONS.builtInTools].sort()).toEqual([...CLAUDE_INIT_TOOLS]);
  });

  it("the policy text, the argv and the readback expectations hash as they did before the options (base b1b0ae7d source)", () => {
    expect(sha(claudePolicySettings(ROOTS, E.allowedTools))).toBe("49db4729c91add0352784229f7af86248e0e3c7bd632323e1eb34a9765b06604");
    expect(sha(JSON.stringify([claudeTurnArgs(E, FIRST), claudeTurnArgs(E, RESUME)]))).toBe("0ad6ebc0f7074775ecfb3ef6438c509c06c118cf8feca3a2ced4cd5db61307f1");
    expect(sha(JSON.stringify(readbackExpected(E)))).toBe("25aa0060cd164134e6a792647615204e9f26bf0a10b3884c882360984be54207");
  });

  it("the default and the explicit onboarding options are the same launch", () => {
    expect(claudePolicySettings(ROOTS, E.allowedTools, ONBOARDING_OPTIONS)).toBe(claudePolicySettings(ROOTS, E.allowedTools));
    expect(claudeTurnArgs(E, FIRST, ONBOARDING_OPTIONS)).toEqual(claudeTurnArgs(E, FIRST));
    expect(readbackExpected(E, ONBOARDING_OPTIONS)).toEqual(readbackExpected(E));
    expect("env" in readbackExpected(E).mcpLaunch).toBe(false);
  });
});

describe("D1 a second options value: policy, argv and readback agree with each other", () => {
  const policy = claudePolicyObject(ROOTS, E.allowedTools, SECOND) as { permissions: { allow: string[]; deny: string[] } };
  const argv = claudeTurnArgs(E, FIRST, SECOND);
  const x = readbackExpected(E, SECOND);

  it("the policy allows Agent and writes the allow list as given, Edit rules from the roots only", () => {
    expect(policy.permissions.allow).toEqual(["Read", "Glob", "Grep", "Bash", "Skill", "Agent", ...ROOTS.map((r) => `Edit(/${r}/**)`), "mcp__storybloq__storybloq_status", "mcp__storybloq__storybloq_init"]);
    expect(policy.permissions.deny).toEqual(["WebFetch", "WebSearch", "Task"]);
    expect((claudePolicyObject(ROOTS, E.allowedTools) as typeof policy).permissions.deny).toContain("Agent");
    expect((claudePolicyObject(ROOTS, E.allowedTools) as typeof policy).permissions.allow).not.toContain("Agent");
  });

  it("the argv names the options' tools and each extra exactly once, after the budget and before the session", () => {
    expect(argv.slice(argv.indexOf("--max-budget-usd"))).toEqual(["--max-budget-usd", "15", "--effort", "high", "--no-session-persistence", "--session-id", ID]);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep,Bash,Skill,Agent");
    expect(claudeArgvProblems(argv, E, FIRST, SECOND)).toEqual([]);
    expect(claudeArgvProblems(claudeTurnArgs(E, RESUME, SECOND), E, RESUME, SECOND)).toEqual([]);
    // No allow rule rides on the command line: the argv carries no tool rule beyond --tools.
    expect(argv.filter((a) => a.startsWith("Edit(") || a.startsWith("mcp__"))).toEqual([]);
  });

  it("the argv check holds each extra to exactly once with its value", () => {
    const without = (name: string, valued: boolean): string[] => { const i = argv.indexOf(name); return [...argv.slice(0, i), ...argv.slice(i + (valued ? 2 : 1))]; };
    expect(claudeArgvProblems(without("--effort", true), E, FIRST, SECOND)).toEqual(["--effort is missing"]);
    expect(claudeArgvProblems(without("--no-session-persistence", false), E, FIRST, SECOND)).toEqual(["--no-session-persistence is missing"]);
    const low = [...argv]; low[argv.indexOf("--effort") + 1] = "low";
    expect(claudeArgvProblems(low, E, FIRST, SECOND)).toEqual(["--effort low is not high"]);
    expect(claudeArgvProblems([...argv, "--no-session-persistence"], E, FIRST, SECOND)).toEqual(["--no-session-persistence appears 2 times"]);
    expect(claudeArgvProblems([...argv, "--effort", "high"], E, FIRST, SECOND)).toEqual(["--effort appears 2 times"]);
  });

  it("each runner's argv is refused under the other's options", () => {
    expect(new Set(claudeArgvProblems(argv, E, FIRST))).toEqual(new Set(["--tools Read,Edit,Write,Glob,Grep,Bash,Skill,Agent is not Read,Edit,Write,Glob,Grep,Bash,Skill", "--effort is refused", "high is refused", "--no-session-persistence is refused"]));
    expect(new Set(claudeArgvProblems(claudeTurnArgs(E, FIRST), E, FIRST, SECOND))).toEqual(new Set(["--tools Read,Edit,Write,Glob,Grep,Bash,Skill is not Read,Edit,Write,Glob,Grep,Bash,Skill,Agent", "--no-session-persistence is missing", "--effort is missing"]));
  });

  it("the readback expectations carry the same policy, and the measured answers for it hold while the onboarding policy's do not", () => {
    expect(x.policy).toEqual(claudePolicyObject(ROOTS, E.allowedTools, SECOND));
    expect(readbackProblems(steps(goodResponses(x)), x)).toEqual([]);
    const onboardingAnswers = steps(goodResponses(readbackExpected(E)));
    expect(readbackProblems(onboardingAnswers, x)).toEqual(["get_settings.sources", "list_permission_rules.state.rules"]);
  });

  it("the init event is checked against the options' tools: Agent holds here and fails for onboarding", () => {
    expect(initEventProblems(initEvent([...SECOND.builtInTools]), ["storybloq_status"], SECOND)).toEqual([]);
    expect(initEventProblems(initEvent([...SECOND.builtInTools]), ["storybloq_status"])).toEqual(["init.tools"]);
    expect(initEventProblems(initEvent([...CLAUDE_INIT_TOOLS]), ["storybloq_status"], SECOND)).toEqual(["init.tools"]);
    expect(initEventProblems(initEvent([...CLAUDE_INIT_TOOLS]), ["storybloq_status"])).toEqual([]);
  });
});

describe("D1 an options value that cannot build a launch is refused", () => {
  const bad = (over: Partial<ClaudePolicyOptions>): ClaudePolicyOptions => ({ ...SECOND, ...over });
  it.each([
    ["an extra reusing a base option", { extraArgs: [["--model", "x"]] as const }, "options: --model is a base option"],
    ["an extra given twice", { extraFlags: ["--no-session-persistence", "--no-session-persistence"] }, "options: --no-session-persistence is given twice"],
    ["a bypass flag as an extra", { extraFlags: ["--dangerously-skip-permissions"] }, "options: --dangerously-skip-permissions is a bypass spelling"],
    ["a bypass as an extra's value", { extraArgs: [["--effort", "bypassPermissions"]] as const }, "options: bypassPermissions is a bypass spelling"],
    ["an = form name", { extraArgs: [["--effort=high", "x"]] as const }, "options: --effort=high is not a plain long option"],
    ["a prototype name", { extraArgs: [["__proto__", "x"]] as const }, "options: __proto__ is not a plain long option"],
    ["a tool both allowed and denied", { deny: ["Agent"] }, "options: Agent is both allowed and denied"],
  ] as const)("%s", (_n, over, problem) => {
    const o = bad(over as Partial<ClaudePolicyOptions>);
    expect(policyOptionsProblems(o)).toContain(problem);
    expect(claudeArgvProblems(claudeTurnArgs(E, FIRST), E, FIRST, o)).toContain(problem);
    expect(() => claudeTurnArgs(E, FIRST, o)).toThrow(problem);
    expect(() => claudePolicySettings(ROOTS, [], o)).toThrow(problem);
  });
  it("the onboarding and second options have no problems", () => {
    expect(policyOptionsProblems(ONBOARDING_OPTIONS)).toEqual([]);
    expect(policyOptionsProblems(SECOND)).toEqual([]);
  });
});

describe("D3 the server launch's environment is part of the readback when the runner pins one", () => {
  const ENV = { STORYBLOQ_PROJECT_ROOT: "/w/project" };
  const e = { ...E, mcpLaunch: { ...E.mcpLaunch, env: ENV } };
  const x = readbackExpected(e, SECOND);
  it("the expectations copy the environment", () => {
    expect(x.mcpLaunch).toEqual({ command: "/usr/bin/node", args: ["/pkg/eval-mcp.js"], env: ENV });
  });
  it("the same environment holds; a missing one, another root and an added name each fail as the config", () => {
    expect(readbackProblems(withConfig(x, (c) => ({ ...c, env: { ...ENV } })), x)).toEqual([]);
    expect(readbackProblems(withConfig(x, (c) => c), x)).toEqual(["mcp_status.mcpServers.config"]);
    expect(readbackProblems(withConfig(x, (c) => ({ ...c, env: { STORYBLOQ_PROJECT_ROOT: "/elsewhere" } })), x)).toEqual(["mcp_status.mcpServers.config"]);
    expect(readbackProblems(withConfig(x, (c) => ({ ...c, env: { ...ENV, CLAUDESTORY_PROJECT_ROOT: "/elsewhere" } })), x)).toEqual(["mcp_status.mcpServers.config"]);
  });
  it("with no environment expected (onboarding), the comparison is as before", () => {
    const o = readbackExpected(E);
    expect(readbackProblems(withConfig(o, (c) => c), o)).toEqual([]);
  });
  it("an expected environment that is not strings is a named problem", () => {
    expect(readbackProblems(steps(goodResponses(x)), { ...x, mcpLaunch: { ...x.mcpLaunch, env: { A: 1 } } } as unknown as ReadbackExpected)).toEqual(["readback.expected.mcpLaunch is malformed"]);
    expect(readbackProblems(steps(goodResponses(x)), { ...x, mcpLaunch: { ...x.mcpLaunch, env: null } } as unknown as ReadbackExpected)).toEqual(["readback.expected.mcpLaunch is malformed"]);
  });
});
