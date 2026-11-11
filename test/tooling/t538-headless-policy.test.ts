/**
 * T-538 commit 1 (ISS-1463, plan section 4 and Addendum A): the Claude launch policy as units. The policy
 * file's exact text, the exact argv, the refusal before spawn, the launch files' integrity, and the readback
 * comparison field by field, against responses shaped as measured (Claude Code 2.1.322).
 */
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeArgvProblems, claudePolicyObject, claudePolicySettings, claudeReadback, claudeTurnArgs, controlRequest, initEventProblems, policyFileProblems, READBACK_REQUESTS,
  readbackProblems, readbackExpected, policyOptionsProblems, ONBOARDING_OPTIONS, userMessage, type ClaudeExpected, type ClaudeSession, type ReadbackExpected, type ReadbackStep,
} from "../../scripts/headless-policy.js";

const ROOTS = ["/w/project", "/w/project/.git", "/w/tmp", "/w/storybloq-global", "/w/eval-events"];
const DEGRADED = ["storybloq_status", "storybloq_init", "storybloq_session_guard"];
const FULL = ["storybloq_status", "storybloq_ticket_get", "storybloq_session_guard"];
const ID = "0f6c2a8e-1b2c-4d3e-8f90-123456789abc";
const E: ClaudeExpected = {
  model: "claude-opus-5-5", policyFile: "/w/claude-policy.json", policySha256: "0".repeat(64), mcpFile: "/w/mcp.json", mcpSha256: "1".repeat(64), project: "/w/project",
  roots: ROOTS, allowedTools: [...FULL, "storybloq_init"], mcpTools: DEGRADED, mcpLaunch: { command: "/usr/bin/node", args: ["/pkg/eval-mcp.js", "--entry", "mcp"] }, maxBudgetUsd: 15,
};
const FIRST: ClaudeSession = { kind: "first", id: ID };
const RESUME: ClaudeSession = { kind: "resume", id: ID };

describe("4.1 the policy file", () => {
  it("is exactly the plan's JSON, keys in order, one Edit rule per root and one allow rule per tool", () => {
    expect(JSON.parse(claudePolicySettings(ROOTS, ["storybloq_status"]))).toEqual({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Read", "Glob", "Grep", "Bash", "Skill", ...ROOTS.map((r) => `Edit(/${r}/**)`), "mcp__storybloq__storybloq_status"],
        deny: ["WebFetch", "WebSearch", "Agent", "Task"],
        disableBypassPermissionsMode: "disable",
      },
      sandbox: {
        enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: [],
        filesystem: { allowWrite: ROOTS }, network: { allowedDomains: [], strictAllowlist: true },
      },
      env: {}, hooks: {},
    });
    const text = claudePolicySettings(ROOTS, []);
    expect(Object.keys(JSON.parse(text))).toEqual(["permissions", "sandbox", "env", "hooks"]);
    expect(text).toContain('"Edit(//w/project/**)"');
  });

  it("refuses a relative root", () => {
    expect(() => claudePolicySettings(["w/project"], [])).toThrow(/not absolute/);
  });
});

describe("4.2 the argv", () => {
  const head = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "claude-opus-5-5", "--tools", "Read,Edit,Write,Glob,Grep,Bash,Skill",
    "--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "user", "--settings", "/w/claude-policy.json", "--strict-mcp-config", "--mcp-config", "/w/mcp.json", "--max-budget-usd", "15"];
  it("first and resumed turns are exactly the plan's sequence, with no prompt and no terminator", () => {
    expect(claudeTurnArgs(E, FIRST)).toEqual([...head, "--session-id", ID]);
    expect(claudeTurnArgs(E, RESUME)).toEqual([...head, "--resume", ID]);
    expect(claudeArgvProblems(claudeTurnArgs(E, FIRST), E, FIRST)).toEqual([]);
    expect(claudeArgvProblems(claudeTurnArgs(E, RESUME), E, RESUME)).toEqual([]);
  });
});

describe("4.3 claudeArgvProblems", () => {
  const good = claudeTurnArgs(E, FIRST);
  const swap = (k: string, v: string): string[] => { const a = [...good]; a[a.indexOf(k) + 1] = v; return a; };
  it.each([
    ["--dangerously-skip-permissions"], ["--allow-dangerously-skip-permissions"], ["--restricted"], ["--add-dir"], ["--append-system-prompt"], ["bypassPermissions"], ["-c"],
  ])("a foreign token %s is refused", (t) => {
    expect(claudeArgvProblems([...good, t], E, FIRST).join("\n")).toMatch(/is refused/);
    expect(claudeArgvProblems([t, ...good], E, FIRST).join("\n")).toMatch(/is refused/);
  });
  it.each(["--model=claude-opus-5-5", "--settings=/w/claude-policy.json", "--permission-mode=bypassPermissions", "--session-id=" + ID])("the = form %s is refused", (t) => {
    const name = t.slice(0, t.indexOf("="));
    const a = good.flatMap((x, i) => (x === name ? [] : good[i - 1] === name ? [] : [x]));
    expect(claudeArgvProblems([...a, t], E, FIRST).join("\n")).toMatch(/no = form/);
  });
  it("a duplicate option is refused even with the same value, and a later value never wins", () => {
    expect(claudeArgvProblems([...good, "--setting-sources", "user"], E, FIRST).join("\n")).toMatch(/--setting-sources appears 2 times/);
    const later = [...good, "--permission-mode", "bypassPermissions"];
    expect(claudeArgvProblems(later, E, FIRST).join("\n")).toMatch(/--permission-mode appears 2 times/);
    expect(claudeArgvProblems(later, E, FIRST).join("\n")).toMatch(/--permission-mode dontAsk \/ bypassPermissions is not dontAsk/);
    const earlier = ["--setting-sources", "project", ...good];
    expect(claudeArgvProblems(earlier, E, FIRST).join("\n")).toMatch(/--setting-sources appears 2 times/);
  });
  it.each([["constructor", "hello"], ["toString", "hello"], ["__proto__", "hello"], ["constructor", "--add-dir"], ["toString", "--add-dir"], ["__proto__", "--add-dir"]])(
    "an inherited object name %s is refused and never swallows the next token %s (F1)", (name, next) => {
      const problems = claudeArgvProblems([...good, name, next], E, FIRST);
      expect(problems).toContain(`${name} is refused`);
      expect(problems).toContain(`${next} is refused`);
    },
  );
  it("a -- terminator is refused, and so is anything after the last value", () => {
    expect(claudeArgvProblems([...good, "--"], E, FIRST).join("\n")).toMatch(/-- is refused/);
    expect(claudeArgvProblems([...good, "--", "hello"], E, FIRST).join("\n")).toMatch(/hello is refused/);
  });
  it("both session options, or neither, are refused", () => {
    expect(claudeArgvProblems([...good, "--resume", ID], E, FIRST).join("\n")).toMatch(/--resume is refused for a first turn/);
    expect(claudeArgvProblems(good.slice(0, -2), E, FIRST).join("\n")).toMatch(/--session-id is missing/);
    expect(claudeArgvProblems(claudeTurnArgs(E, RESUME).slice(0, -2), E, RESUME).join("\n")).toMatch(/--resume is missing/);
  });
  it("a missing option is refused, --setting-sources included", () => {
    const a = good.filter((x, i) => x !== "--setting-sources" && good[i - 1] !== "--setting-sources");
    expect(claudeArgvProblems(a, E, FIRST).join("\n")).toMatch(/--setting-sources is missing/);
    expect(claudeArgvProblems(good.filter((x) => x !== "--strict-mcp-config"), E, FIRST).join("\n")).toMatch(/--strict-mcp-config is missing/);
  });
  it.each(["0F6C2A8E-1B2C-4D3E-8F90-123456789ABC", "not-a-uuid", "", "--dangerously-skip-permissions"])("a session id %j that is not a lowercase UUID is refused", (id) => {
    const s = { kind: "first" as const, id };
    expect(claudeArgvProblems(claudeTurnArgs(E, s), E, s).join("\n")).toMatch(/is not a lowercase UUID|is refused/);
  });
  it.each([["0", 0], ["NaN", Number.NaN], ["1e999", Number.POSITIVE_INFINITY]])("a budget of %s is refused", (v, n) => {
    const e = { ...E, maxBudgetUsd: n };
    expect(claudeArgvProblems(claudeTurnArgs(e, FIRST), e, FIRST).join("\n")).toMatch(/budget/);
    expect(claudeArgvProblems(swap("--max-budget-usd", v), E, FIRST).join("\n")).toMatch(/--max-budget-usd/);
  });
  it.each(["--dangerously-skip-permissions", "bypassPermissions", "bypassPermissions --x", "a b", "-x", ""])("a model %j that is not a model name is refused", (m) => {
    const e = { ...E, model: m };
    expect(claudeArgvProblems(claudeTurnArgs(e, FIRST), e, FIRST).length).toBeGreaterThan(0);
  });
  it.each(["bypassPermissions", "--restricted"])("%s as any option's value is refused as a bypass spelling", (v) => {
    const e = { ...E, model: v };
    expect(claudeArgvProblems(claudeTurnArgs(e, FIRST), e, FIRST).join("\n")).toMatch(new RegExp(`${v} is a bypass spelling`));
  });
  it("each value must be the expected one", () => {
    expect(claudeArgvProblems(swap("--settings", "/other.json"), E, FIRST).join("\n")).toMatch(/--settings \/other.json is not/);
    expect(claudeArgvProblems(swap("--tools", "Read,Edit,Write,Glob,Grep,Bash,Skill,WebFetch"), E, FIRST).join("\n")).toMatch(/--tools/);
    expect(claudeArgvProblems(swap("--permission-prompts", "ask"), E, FIRST).join("\n")).toMatch(/--permission-prompts/);
  });
});

describe("4.3 policyFileProblems", () => {
  let dir = "";
  afterEach(() => { vi.restoreAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
  const setup = (): { file: string; sha: string } => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "t538p-")));
    const file = join(dir, "claude-policy.json");
    const text = claudePolicySettings(["/w"], []);
    writeFileSync(file, text, { mode: 0o400 });
    return { file, sha: createHash("sha256").update(text).digest("hex") };
  };
  it("holds for the file as written", () => {
    const { file, sha } = setup();
    expect(policyFileProblems(file, sha)).toEqual([]);
  });
  it("an edited file fails on its bytes", () => {
    const { file, sha } = setup();
    chmodSync(file, 0o600); writeFileSync(file, "{}\n"); chmodSync(file, 0o400);
    expect(policyFileProblems(file, sha).join("\n")).toMatch(/not the recorded bytes/);
  });
  it("a chmod-ed file fails on its mode", () => {
    const { file, sha } = setup();
    chmodSync(file, 0o600);
    expect(policyFileProblems(file, sha).join("\n")).toMatch(/has mode 600, not 400/);
  });
  it("a file replaced by a link fails, even to the same bytes", () => {
    const { file, sha } = setup();
    copyFileSync(file, join(dir, "real.json"));
    rmSync(file);
    symlinkSync(join(dir, "real.json"), file);
    expect(policyFileProblems(file, sha).join("\n")).toMatch(/not a regular file/);
  });
  it("a file owned by another uid fails", () => {
    const { file, sha } = setup();
    const uid = process.getuid!();
    vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(uid + 1);
    expect(policyFileProblems(file, sha).join("\n")).toMatch(/is owned by uid/);
  });
  it("a byte-identical replacement with the same mode and owner is accepted (the stated contract)", () => {
    const { file, sha } = setup();
    copyFileSync(file, join(dir, "next.json"));
    chmodSync(join(dir, "next.json"), 0o400);
    renameSync(join(dir, "next.json"), file);
    expect(policyFileProblems(file, sha)).toEqual([]);
  });
  it("the MCP file is checked at its own mode", () => {
    const { file, sha } = setup();
    chmodSync(file, 0o600);
    expect(policyFileProblems(file, sha, 0o600)).toEqual([]);
  });
});

// --- 4.4 and Addendum A -------------------------------------------------------------

const X: ReadbackExpected = { project: E.project, roots: ROOTS, policy: claudePolicyObject(ROOTS, E.allowedTools), mcpTools: DEGRADED, mcpLaunch: E.mcpLaunch };

/** The six answers, shaped as measured (Claude Code 2.1.322), shared with the stand-in client. */
const goodResponses = (createRequire(import.meta.url)("../fixtures/t538-claude-sentinel.cjs") as { goodResponses: (x: ReadbackExpected) => Record<string, Record<string, unknown>> }).goodResponses;

const steps = (r: Record<string, Record<string, unknown>>): ReadbackStep[] => READBACK_REQUESTS.map((subtype, i) => ({ requestId: `r${i + 1}`, subtype, outcome: "success", response: r[subtype] }));
/** The good answers with one value replaced at a dotted path. */
function changed(sub: string, path: string, value: unknown, x = X): ReadbackStep[] {
  const r = JSON.parse(JSON.stringify(goodResponses(x))) as Record<string, Record<string, unknown>>;
  const keys = path.split(".");
  let at: Record<string, unknown> = r[sub]!;
  for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[keys.at(-1)!] = typeof value === "function" ? (value as (v: unknown) => unknown)(at[keys.at(-1)!]) : value;
  return steps(r);
}

/** Readback rows: each changes one field and names it as the launch failure. */
const READBACK_ROWS: readonly (readonly [string, string, string, unknown, string])[] = [
  ["a third settings source", "get_settings", "sources", (v: unknown[]) => [...v, { source: "localSettings", settings: {} }], "get_settings.sources"],
  ["a policySettings source", "get_settings", "sources", (v: unknown[]) => [...v, { source: "policySettings", settings: {} }], "get_settings.sources"],
  ["the flag source with another policy", "get_settings", "sources", (v: { source: string; settings: Record<string, unknown> }[]) => v.map((s) => (s.source === "flagSettings" ? { ...s, settings: { ...s.settings, hooks: { Stop: [] } } } : s)), "get_settings.sources"],
  ["sandbox enabled false", "get_sandbox_dialog", "enabled", false, "get_sandbox_dialog.enabled"],
  ["sandbox enabled_in_settings false", "get_sandbox_dialog", "enabled_in_settings", false, "get_sandbox_dialog.enabled_in_settings"],
  ["sandbox locked false", "get_sandbox_dialog", "locked", false, "get_sandbox_dialog.locked"],
  ["the unsandboxed fallback on", "get_sandbox_dialog", "unsandboxed_fallback", true, "get_sandbox_dialog.unsandboxed_fallback"],
  ["a non-empty excluded_commands", "get_sandbox_dialog", "excluded_commands", ["git"], "get_sandbox_dialog.excluded_commands"],
  ["an extra fs_allow_write entry", "get_sandbox_dialog", "restrictions.fs_allow_write", (v: string[]) => [...v, "/"], "get_sandbox_dialog.restrictions"],
  ["a missing root", "get_sandbox_dialog", "restrictions.fs_allow_write", (v: string[]) => v.slice(1), "get_sandbox_dialog.restrictions"],
  ["a non-empty network_allowed_domains", "get_sandbox_dialog", "restrictions.network_allowed_domains", ["example.com"], "get_sandbox_dialog.restrictions"],
  ["an extra allow rule", "list_permission_rules", "state.rules", (v: unknown[]) => [...v, { behavior: "allow", source: "flagSettings", rule: "WebFetch" }], "list_permission_rules.state.rules"],
  ["the project as a workspace directory", "list_permission_rules", "state.workspaceDirectories", ["/w/project"], "list_permission_rules.state.workspaceDirectories"],
  ["a hook", "get_hooks_listing", "hooks", [{ event: "PreToolUse", command: "true" }], "get_hooks_listing.hooks"],
  ["a second MCP server", "mcp_status", "mcpServers", (v: unknown[]) => [...v, { name: "other", status: "connected", tools: [] }], "mcp_status.mcpServers"],
  ["the server launched another way", "mcp_status", "mcpServers", (v: { config: { args: string[] } }[]) => v.map((s) => ({ ...s, config: { ...s.config, args: ["/elsewhere/mcp.js"] } })), "mcp_status.mcpServers.config"],
  ["an API key token source", "initialize", "account.tokenSource", "apiKeyHelper", "initialize.account.tokenSource"],
  ["another API provider", "initialize", "account.apiProvider", "bedrock", "initialize.account.apiProvider"],
  ["another permission mode", "initialize", "current_permission_mode", "bypassPermissions", "initialize.current_permission_mode"],
];

describe("4.4 readbackProblems (Addendum A shapes)", () => {
  it("the measured answers for this launch hold", () => {
    expect(readbackProblems(steps(goodResponses(X)), X)).toEqual([]);
  });

  it.each(READBACK_ROWS)("%s fails as its field", (_name, sub, path, value, field) => {
    expect(readbackProblems(changed(sub, path, value), X)[0]).toBe(field);
  });

  it.each([["degraded", DEGRADED, FULL], ["full", FULL, DEGRADED]] as const)("in the %s state an extra tool, a missing tool and the other state's set each fail", (_s, set, other) => {
    const x = { ...X, mcpTools: set };
    const tools = (names: readonly string[]) => (v: { tools: unknown }[]) => v.map((s) => ({ ...s, tools: names.map((name) => ({ name, annotations: {} })) }));
    expect(readbackProblems(steps(goodResponses(x)), x)).toEqual([]);
    expect(readbackProblems(changed("mcp_status", "mcpServers", tools([...set, "storybloq_bus_send"]), x), x)[0]).toBe("mcp_status.mcpServers.tools");
    expect(readbackProblems(changed("mcp_status", "mcpServers", tools(set.slice(1)), x), x)[0]).toBe("mcp_status.mcpServers.tools");
    expect(readbackProblems(changed("mcp_status", "mcpServers", tools(other), x), x)[0]).toBe("mcp_status.mcpServers.tools");
  });

  it.each([
    ["a null step", (): unknown => [null], X, "readback.steps[0] is malformed"],
    ["a step with an unknown subtype", (): unknown => [{ requestId: "r1", subtype: "get_secrets", outcome: "success", response: {} }], X, "readback.steps[0] is malformed"],
    ["a step with no request id", (): unknown => [{ subtype: "initialize", outcome: "success", response: {} }], X, "readback.steps[0] is malformed"],
    ["a step with an unknown outcome", (): unknown => [{ requestId: "r1", subtype: "initialize", outcome: "maybe", response: {} }], X, "readback.steps[0] is malformed"],
    ["a repeated subtype", (): unknown => [...steps(goodResponses(X)), steps(goodResponses(X))[0]], X, "readback.steps[6] repeats initialize"],
    ["steps that are not a list", (): unknown => null, X, "readback.steps is not a list"],
    ["an empty policy", (): unknown => steps(goodResponses(X)), { ...X, policy: {} }, "readback.expected.policy.permissions is malformed"],
    ["a policy whose allow is not strings", (): unknown => steps(goodResponses(X)), { ...X, policy: { permissions: { allow: [1], deny: [] } } }, "readback.expected.policy.permissions is malformed"],
    ["roots that are not strings", (): unknown => steps(goodResponses(X)), { ...X, roots: null }, "readback.expected is malformed"],
    ["an mcp launch with no command", (): unknown => steps(goodResponses(X)), { ...X, mcpLaunch: { args: [] } }, "readback.expected.mcpLaunch is malformed"],
  ] as const)("%s is a named problem, never a throw (F3)", (_name, make, x, problem) => {
    let got: string[] = [];
    expect(() => { got = readbackProblems(make() as unknown as ReadbackStep[], x as unknown as ReadbackExpected); }).not.toThrow();
    expect(got[0]).toBe(problem);
  });

  it("sources compared exactly: a superset with the right two entries still fails", () => {
    const sup = changed("get_settings", "sources", (v: unknown[]) => [v[0], v[1], v[1]]);
    expect(readbackProblems(sup, X)[0]).toBe("get_settings.sources");
  });

  it("restrictions compared field by field, not on fs_allow_write alone", () => {
    for (const k of ["fs_deny_read", "fs_allow_read", "fs_deny_write", "network_denied_domains", "unix_sockets", "ignored_glob_patterns"]) {
      expect(readbackProblems(changed("get_sandbox_dialog", `restrictions.${k}`, ["/x"]), X)[0], k).toBe("get_sandbox_dialog.restrictions");
    }
    expect(readbackProblems(changed("get_sandbox_dialog", "restrictions.allow_all_unix_sockets", true), X)[0]).toBe("get_sandbox_dialog.restrictions");
    expect(readbackProblems(changed("get_sandbox_dialog", "restrictions.network_managed", true), X)[0]).toBe("get_sandbox_dialog.restrictions");
  });

  it("toolsNarrowing rules are left out; a flagSettings rule with another behaviour fails", () => {
    expect(readbackProblems(changed("list_permission_rules", "state.rules", (v: unknown[]) => [...v, { behavior: "deny", source: "toolsNarrowing", rule: "Task" }]), X)).toEqual([]);
    expect(readbackProblems(changed("list_permission_rules", "state.rules", (v: { rule: string; behavior: string }[]) => v.map((r) => (r.rule === "Bash" ? { ...r, behavior: "ask" } : r))), X)[0]).toBe("list_permission_rules.state.rules");
  });

  it("the original cwd must be the project, managedOnly false, and the hooks policy clean", () => {
    expect(readbackProblems(changed("list_permission_rules", "state.originalCwd", "/elsewhere"), X)[0]).toBe("list_permission_rules.state.originalCwd");
    expect(readbackProblems(changed("list_permission_rules", "state.managedOnly", true), X)[0]).toBe("list_permission_rules.state.managedOnly");
    expect(readbackProblems(changed("get_hooks_listing", "events", ["PreToolUse"]), X)[0]).toBe("get_hooks_listing.events");
    expect(readbackProblems(changed("get_hooks_listing", "policy.policyHookCount", 1), X)[0]).toBe("get_hooks_listing.policy.policyHookCount");
    expect(readbackProblems(changed("get_hooks_listing", "policy.managedOnly", true), X)[0]).toBe("get_hooks_listing.policy.managedOnly");
  });

  it("a missing response, an error response and a timeout each fail as their request", () => {
    const all = steps(goodResponses(X));
    expect(readbackProblems(all.slice(0, 5), X)[0]).toBe("get_hooks_listing: no response");
    expect(readbackProblems([...all.slice(0, 2), { requestId: "r3", subtype: "get_sandbox_dialog", outcome: "error", error: "no" }], X)[0]).toBe("get_sandbox_dialog: error response");
    expect(readbackProblems([{ requestId: "r1", subtype: "initialize", outcome: "timeout" }], X)[0]).toMatch(/^initialize: no response within/);
  });
});

describe("4.4 claudeReadback", () => {
  it("sends r1 to r6 in order, each only after the previous answer, and reports the exchange", async () => {
    const sent: string[] = [];
    const answers = goodResponses(X);
    const r = await claudeReadback({
      write: (l) => { sent.push(l); },
      response: async (id) => {
        expect(sent.length).toBe(Number(id.slice(1)));
        const sub = (JSON.parse(sent.at(-1)!) as { request: { subtype: string } }).request.subtype;
        return { subtype: "success", response: answers[sub] };
      },
    }, X);
    expect(sent).toEqual(READBACK_REQUESTS.map((s, i) => controlRequest(`r${i + 1}`, s)));
    expect(r.problems).toEqual([]);
    expect(r.steps.map((s) => s.requestId)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
  });

  it("stops at the first unanswered request", async () => {
    const sent: string[] = [];
    const r = await claudeReadback({ write: (l) => { sent.push(l); }, response: async (id) => (id === "r2" ? null : { subtype: "success", response: goodResponses(X).initialize }) }, X, 10);
    expect(sent.length).toBe(2);
    expect(r.problems[0]).toMatch(/^get_settings: no response within/);
  });

  it("the user message line carries the prompt as 4.4 states", () => {
    expect(JSON.parse(userMessage("/story hello"))).toEqual({ type: "user", message: { role: "user", content: "/story hello" }, parent_tool_use_id: null, session_id: "" });
  });
});

describe("4.4 the stream's init event", () => {
  const init = (over: Record<string, unknown> = {}): Record<string, unknown>[] => [{
    type: "system", subtype: "init", session_id: ID, permissionMode: "dontAsk", apiKeySource: "none", mcp_servers: [{ name: "storybloq", status: "connected" }],
    tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write", ...DEGRADED.map((t) => `mcp__storybloq__${t}`)], ...over,
  }];
  it("holds as measured", () => { expect(initEventProblems(init(), DEGRADED)).toEqual([]); });
  it.each([
    ["permissionMode", { permissionMode: "bypassPermissions" }, "init.permissionMode"],
    ["apiKeySource", { apiKeySource: "ANTHROPIC_API_KEY" }, "init.apiKeySource"],
    ["a second server", { mcp_servers: [{ name: "storybloq", status: "connected" }, { name: "x", status: "connected" }] }, "init.mcp_servers"],
    ["an extra built-in tool", { tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write", "WebFetch"] }, "init.tools"],
    ["another server's tool", { tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write", "mcp__other__run"] }, "init.tools.mcp"],
    ["an unexpected storybloq tool", { tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write", "mcp__storybloq__storybloq_bus_send"] }, "init.tools.mcp"],
  ] as const)("%s fails", (_n, over, field) => {
    expect(initEventProblems(init(over), DEGRADED)[0]).toBe(field);
  });
  it("no init event fails", () => { expect(initEventProblems([], DEGRADED)[0]).toBe("init: no system init event"); });
});

describe("T-525 E2: settingSources", () => {
  const NONE = { ...ONBOARDING_OPTIONS, settingSources: "none" as const };
  const head = (v: string): string[] => { const a = claudeTurnArgs(E, FIRST); return a.slice(a.indexOf("--setting-sources"), a.indexOf("--setting-sources") + 2).concat(v); };
  it("the default and an explicit \"user\" keep the T-538 argv, argv check and readback expectation byte for byte", () => {
    const user = { ...ONBOARDING_OPTIONS, settingSources: "user" as const };
    expect(claudeTurnArgs(E, FIRST, user)).toEqual(claudeTurnArgs(E, FIRST));
    expect(claudeTurnArgs(E, FIRST)).toContain("user");
    expect(JSON.stringify(readbackExpected(E))).toBe(JSON.stringify(readbackExpected(E, user)));
    expect("settingSources" in readbackExpected(E)).toBe(false);
    expect(head("x").slice(0, 2)).toEqual(["--setting-sources", "user"]);
  });
  it("\"none\" passes an empty source list, and its argv passes only its own check", () => {
    const a = claudeTurnArgs(E, FIRST, NONE);
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(claudeArgvProblems(a, E, FIRST, NONE)).toEqual([]);
    expect(claudeArgvProblems(claudeTurnArgs(E, FIRST), E, FIRST, NONE).length).toBeGreaterThan(0);
    expect(claudeArgvProblems(a, E, FIRST).length).toBeGreaterThan(0);
  });
  it("an unknown value is an options problem", () => {
    expect(policyOptionsProblems({ ...ONBOARDING_OPTIONS, settingSources: "all" as never }).join("\n")).toMatch(/settingSources/);
  });
  const XN: ReadbackExpected = { ...X, settingSources: "none" };
  const flagOnly = (v: { source: string }[]) => v.filter((s) => s.source === "flagSettings");
  it("\"none\": exactly flagSettings holding the policy passes", () => {
    expect(readbackProblems(changed("get_settings", "sources", flagOnly, XN), XN)).toEqual([]);
  });
  it.each([
    ["flagSettings plus userSettings (the T-538 shape)", (v: { source: string }[]) => v],
    ["no sources", () => []],
    ["flagSettings plus projectSettings", (v: { source: string }[]) => [...flagOnly(v), { source: "projectSettings", settings: {} }]],
    ["flagSettings plus localSettings", (v: { source: string }[]) => [...flagOnly(v), { source: "localSettings", settings: {} }]],
    ["flagSettings plus policySettings", (v: { source: string }[]) => [...flagOnly(v), { source: "policySettings", settings: {} }]],
    ["flagSettings with another policy", (v: { source: string; settings?: Record<string, unknown> }[]) => v.filter((s) => s.source === "flagSettings").map((s) => ({ ...s, settings: { ...s.settings, hooks: { Stop: [] } } }))],
  ])("\"none\": %s is refused", (_n, f) => {
    expect(readbackProblems(changed("get_settings", "sources", f, XN), XN)[0]).toBe("get_settings.sources");
  });
  it("readbackExpected carries \"none\" from the options, so the launch's own expectation refuses the user source", () => {
    const xn = readbackExpected(E, NONE);
    expect(xn.settingSources).toBe("none");
    expect(readbackProblems(changed("get_settings", "sources", (v: unknown[]) => v, { ...X, ...xn }), xn)[0]).toBe("get_settings.sources");
  });
  it("the default still refuses flagSettings alone", () => {
    expect(readbackProblems(changed("get_settings", "sources", flagOnly), X)[0]).toBe("get_settings.sources");
  });
});
