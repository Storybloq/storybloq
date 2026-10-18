import { describe, it, expect, vi } from "vitest";
import { checkCodexBridge } from "../../../src/core/health/codex-bridge.js";
import { ctxFor, stubDeps, runStub, probeStub, PROBE_OK, HOME, PROJECT, type FileMap, type StubOptions } from "./stub-deps.js";
import type { HealthRead, McpProbe } from "../../../src/core/health/types.js";
import type { BundledBridge } from "../../../src/core/bridge-resolve.js";

const CLAUDE_JSON = `${HOME}/.claude.json`;
const MCP_JSON = `${PROJECT}/.mcp.json`;
const NODE_BRIDGE = { command: "node", args: ["/opt/codex-claude-bridge/dist/index.js"] };
const NPX_BRIDGE = { command: "npx", args: ["-y", "codex-claude-bridge@latest"] };
const UNREADABLE: HealthRead = { kind: "indeterminate", reason: "EACCES" };

const INSTALLED: BundledBridge = { kind: "installed", packageDir: "/opt/sb/node_modules/codex-claude-bridge", entry: "/opt/sb/node_modules/codex-claude-bridge/dist/index.js", version: "1.8.0" };

/** Codex present, the bundle installed, every probe answering ok, unless overridden. */
function bridgeDeps(files: FileMap, over: Partial<StubOptions> = {}) {
  return stubDeps({ files, run: runStub({ kind: "ok", stdout: "codex 1.0.0\n" }), bundledBridge: INSTALLED, probeMcp: probeStub(PROBE_OK), ...over });
}

function claudeJson(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

const run = (files: FileMap) => checkCodexBridge(ctxFor(), bridgeDeps(files));

describe("T-502 codex-bridge check: the Codex probe", () => {
  it("skips with 'Codex is not installed' on ENOENT", async () => {
    const check = await checkCodexBridge(ctxFor(), stubDeps({ run: runStub({ kind: "enoent" }) }));
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("Codex is not installed");
  });

  it("skips with 'did not answer' on a timeout or a non-zero exit, never 'not installed'", async () => {
    for (const result of [{ kind: "timeout" } as const, { kind: "failed", code: 1 } as const]) {
      const check = await checkCodexBridge(ctxFor(), stubDeps({ run: runStub(result) }));
      expect(check.status).toBe("skip");
      expect(check.detail.reason).toBe("codex --version did not answer");
      expect(check.message).not.toContain("not installed");
    }
  });

  it("caps the probe at 2000 ms from the remaining budget", async () => {
    const spawn = runStub({ kind: "enoent" });
    await checkCodexBridge(ctxFor({ deadline: 90_000 }), stubDeps({ now: () => 1_000, run: spawn }));
    expect(spawn.mock.calls[0]![2]).toBe(2000);
    const spawn2 = runStub({ kind: "enoent" });
    await checkCodexBridge(ctxFor({ deadline: 1_500 }), stubDeps({ now: () => 1_000, run: spawn2 }));
    expect(spawn2.mock.calls[0]![2]).toBe(500);
  });

  it("skips under the Codex client", async () => {
    const check = await checkCodexBridge(ctxFor({ client: "codex" }), stubDeps());
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("the bridge is a Claude Code MCP server");
  });
});

describe("T-502 codex-bridge check: registration evidence", () => {
  it("is ok for a user-scope node launch of the bridge", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }) });
    expect(check.status).toBe("ok");
    expect(check.detail).toMatchObject({ scope: "user", name: "codex-bridge" });
  });

  it("is ok for a user-scope npx -y launch", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NPX_BRIDGE } }) });
    expect(check.status).toBe("ok");
    expect(check.detail.scope).toBe("user");
  });

  it("is ok for the bridge's own binary under any arguments", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": { command: "/usr/local/bin/codex-claude-bridge", args: ["--verbose"] } } }),
    });
    expect(check.status).toBe("ok");
  });

  it("is ok for a project-scope .mcp.json entry", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({}),
      [MCP_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }),
    });
    expect(check.status).toBe("ok");
    expect(check.detail.scope).toBe("project");
  });

  it("does not count a .mcp.json entry named in disabledMcpjsonServers", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ projects: { [PROJECT]: { disabledMcpjsonServers: ["codex-bridge"] } } }),
      [MCP_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }),
    });
    expect(check.status).toBe("advise");
  });

  // Mutant (g): matching in any scope instead of the winning one reddens this.
  it("does not count a user bridge shadowed by a local entry of the same name", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({
        mcpServers: { "codex-bridge": NODE_BRIDGE },
        projects: { [PROJECT]: { mcpServers: { "codex-bridge": { command: "false", args: [] } } } },
      }),
    });
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("cannot verify codex-bridge");
  });

  it("a shadowing entry under a name that is not bridge-related advises instead", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({
        mcpServers: { reviewer: NODE_BRIDGE },
        projects: { [PROJECT]: { mcpServers: { reviewer: { command: "false", args: [] } } } },
      }),
    });
    expect(check.status).toBe("advise");
  });

  it("a local entry under a DIFFERENT name leaves the user bridge winning", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({
        mcpServers: { "codex-bridge": NODE_BRIDGE },
        projects: { [PROJECT]: { mcpServers: { other: { command: "false", args: [] } } } },
      }),
    });
    expect(check.status).toBe("ok");
    expect(check.detail.scope).toBe("user");
  });

  it("advises with the pinned text when nothing bridge-shaped is registered and the bundle is installed", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ mcpServers: {} }) });
    expect(check.status).toBe("advise");
    expect(check.message).toBe(
      "Codex is installed but the bundled codex-claude-bridge review backend is not registered for Claude Code. Run storybloq setup-skill.",
    );
    expect(check.advice).toBe(check.message);
  });
});

describe("T-502 codex-bridge check: grammar edges", () => {
  const unverifiable = [
    ["a wrapper we do not recognise", { command: "echo", args: ["codex-claude-bridge@latest"] }],
    ["npx -p installing the package and running something else", { command: "npx", args: ["-p", "codex-claude-bridge@latest", "echo"] }],
    ["node -e inline code", { command: "node", args: ["-e", "require('codex-claude-bridge')"] }],
    ["node -r before the path", { command: "node", args: ["-r", "x", "/y/codex-claude-bridge/dist/index.js"] }],
    ["a leading npx flag other than -y", { command: "npx", args: ["--port", "1", "codex-claude-bridge"] }],
    ["an unrelated interpreter", { command: "python", args: ["/x/codex-claude-bridge/y"] }],
    ["args that are not an array", { command: "node", args: "string" }],
    ["a command that is not a string", { command: 7, args: [] }],
    ["a shell wrapper", { command: "sh", args: ["-c", "codex-claude-bridge"] }],
  ] as const;

  for (const [label, entry] of unverifiable) {
    it(`skips 'cannot verify' for a bridge-related name with ${label}`, async () => {
      const check = await run({ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": entry } }) });
      expect(check.status).toBe("skip");
      expect(check.detail.reason).toBe("cannot verify codex-bridge");
    });
  }

  // Mutant (j): skipping flags in the npx grammar reddens the -p case above.
  it("accepts trailing application arguments after the package", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": { command: "npx", args: ["-y", "codex-claude-bridge@latest", "--port", "1"] } } }),
    });
    expect(check.status).toBe("ok");
  });

  it("accepts npx without the -y flag", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": { command: "npx", args: ["codex-claude-bridge"] } } }),
    });
    expect(check.status).toBe("ok");
  });

  // Mutant (e): classifying by argument alone reddens this.
  it("a lookalike path segment under a name that is not bridge-related is simply not the bridge", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ mcpServers: { tools: { command: "node", args: ["/x/codex-claude-bridge-lookalike/i.js"] } } }),
    });
    expect(check.status).toBe("advise");
  });

  it("a name containing the package string is bridge-related", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ mcpServers: { "my-codex-claude-bridge": { command: "false", args: [] } } }),
    });
    expect(check.detail.reason).toBe("cannot verify my-codex-claude-bridge");
  });
});

describe("T-502 codex-bridge check: unreadable scopes", () => {
  // Mutant (f): treating an indeterminate layer as absent reddens both of these.
  it("skips when ~/.claude.json is unreadable even with a readable .mcp.json bridge", async () => {
    const check = await run({ [CLAUDE_JSON]: UNREADABLE, [MCP_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }) });
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe(`unreadable: ${CLAUDE_JSON}`);
  });

  it("skips when .mcp.json is unreadable, even with a user bridge it could shadow", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }),
      [MCP_JSON]: UNREADABLE,
    });
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe(`unreadable: ${MCP_JSON}`);
  });

  it("skips when .mcp.json is unreadable and nothing else is registered", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ mcpServers: {} }), [MCP_JSON]: UNREADABLE });
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe(`unreadable: ${MCP_JSON}`);
  });

  it("a proven bridge outranks an unreadable sibling scope", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ projects: { [PROJECT]: { mcpServers: { "codex-bridge": NODE_BRIDGE } } } }),
      [MCP_JSON]: UNREADABLE,
    });
    expect(check.status).toBe("ok");
    expect(check.detail.scope).toBe("local");
  });

  it("reports the inspected project directory", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({}) });
    expect(check.detail.projectDir).toBe(PROJECT);
  });
});

// A nested field that is PRESENT but the wrong shape leaves registration
// evidence unresolved. Treating it as an empty map would let a lower scope
// look like the winner, or produce a register-the-bridge advisory, on evidence
// that was never actually read.
describe("T-502 codex-bridge check: malformed nested shapes", () => {
  it("a malformed projects block makes the local scope unknown, invalidating a user bridge", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ projects: 7, mcpServers: { "codex-bridge": NODE_BRIDGE } }) });
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe(`unreadable: ${CLAUDE_JSON}`);
  });

  it("a malformed project record makes the local scope unknown", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ projects: { [PROJECT]: "nope" }, mcpServers: { "codex-bridge": NODE_BRIDGE } }),
    });
    expect(check.detail.reason).toBe(`unreadable: ${CLAUDE_JSON}`);
  });

  it("a malformed local mcpServers map makes the local scope unknown", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ projects: { [PROJECT]: { mcpServers: [] } }, mcpServers: { "codex-bridge": NODE_BRIDGE } }),
    });
    expect(check.detail.reason).toBe(`unreadable: ${CLAUDE_JSON}`);
  });

  it("a malformed user mcpServers map makes the user scope unknown and cannot advise", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ mcpServers: 5 }) });
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe(`unreadable: ${CLAUDE_JSON}`);
  });

  it("a malformed disabledMcpjsonServers list makes the project scope unknown, naming the file the list lives in", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ projects: { [PROJECT]: { disabledMcpjsonServers: "codex-bridge" } } }),
      [MCP_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }),
    });
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe(`unreadable: ${CLAUDE_JSON}`);
  });

  // The bridge sits in the USER scope, which the project scope would shadow.
  // A local winner would report ok even if the project scope were wrongly
  // tainted, so it could not prove the malformed list was ignored.
  it("a malformed disablement list does not matter when .mcp.json registers nothing", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({
        mcpServers: { "codex-bridge": NODE_BRIDGE },
        projects: { [PROJECT]: { disabledMcpjsonServers: 1 } },
      }),
      [MCP_JSON]: claudeJson({ mcpServers: {} }),
    });
    expect(check.status).toBe("ok");
    expect(check.detail.scope).toBe("user");
  });

  it("a malformed .mcp.json mcpServers map makes the project scope unknown", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }),
      [MCP_JSON]: claudeJson({ mcpServers: "nope" }),
    });
    expect(check.detail.reason).toBe(`unreadable: ${MCP_JSON}`);
  });

  it("a null nested field is absent, not malformed", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ projects: null, mcpServers: { "codex-bridge": NODE_BRIDGE } }) });
    expect(check.status).toBe("ok");
    expect(check.detail.scope).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// T-509 part 3: registration is not health. Every trustworthy bridge is
// LAUNCHED and must answer initialize; the bundled copy decides the no-bridge
// answer.
// ---------------------------------------------------------------------------
describe("T-509 codex-bridge check: the probe", () => {
  const USER_BRIDGE = { [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }) };

  it("ok names the answering server and records the probe detail", async () => {
    const check = await run(USER_BRIDGE);
    expect(check.status).toBe("ok");
    expect(check.message).toContain("answers");
    expect(check.message).toContain("`codex-bridge`");
    expect(check.detail).toMatchObject({ scope: "user", name: "codex-bridge" });
    expect(JSON.parse(String(check.detail.bridges))).toEqual([
      { name: "codex-bridge", scope: "user", probe: "ok", serverName: "codex-claude-bridge", allocatedMs: 5000 },
    ]);
  });

  // M-REGISTRATION-ONLY: a check that reports ok from the registration alone
  // never calls the probe; this pins one call per bridge and a failure on it.
  it("calls the probe exactly once per bridge and cannot be ok when the probe fails", async () => {
    const probe = probeStub({ kind: "failed", reason: "exited before answering", code: 1, signal: null, stderr: "boom\nmore", allocatedMs: 5000 });
    const check = await checkCodexBridge(ctxFor(), bridgeDeps(USER_BRIDGE, { probeMcp: probe }));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(check.status).toBe("advise");
    expect(check.message).toContain("`codex-bridge` (user scope)");
    expect(check.message).toContain("boom");
    expect(check.message).not.toContain("more");
    expect(check.message).toContain("exit code 1");
    expect(check.message).toContain("launch it by hand to see the error");
  });

  it("hands the probe the registered argv verbatim and the entry's env as overrides", async () => {
    const probe = probeStub(PROBE_OK);
    const entry = { command: "npx", args: ["-y", "codex-claude-bridge@latest", "--port", "1"], env: { CODEX_HOME: "/x", N: 5 } };
    await checkCodexBridge(ctxFor(), bridgeDeps({ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": entry } }) }, { probeMcp: probe }));
    expect(probe.mock.calls[0]![0]).toEqual({ argv: ["npx", "-y", "codex-claude-bridge@latest", "--port", "1"], envOverrides: { CODEX_HOME: "/x" } });
  });

  for (const [label, entry] of [
    ["the binary", { command: "/usr/local/bin/codex-claude-bridge", args: ["--verbose"] }],
    ["node", { command: "node", args: ["/opt/codex-claude-bridge/dist/index.js"] }],
    ["bun", { command: "bun", args: ["/opt/codex-claude-bridge/dist/index.js"] }],
    ["npx without -y", { command: "npx", args: ["codex-claude-bridge"] }],
    ["bunx", { command: "bunx", args: ["-y", "codex-claude-bridge@1.8.0"] }],
  ] as const) {
    it(`argv fidelity for ${label}`, async () => {
      const probe = probeStub(PROBE_OK);
      await checkCodexBridge(ctxFor(), bridgeDeps({ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": entry } }) }, { probeMcp: probe }));
      expect(probe.mock.calls[0]![0]!.argv).toEqual([entry.command, ...entry.args]);
      expect(probe.mock.calls[0]![0]!.envOverrides).toEqual({});
    });
  }

  it("passes the run deadline and a 5000 ms cap bounded by the remaining budget", async () => {
    const probe = probeStub(PROBE_OK);
    await checkCodexBridge(ctxFor({ deadline: 90_000 }), bridgeDeps(USER_BRIDGE, { probeMcp: probe, now: () => 1_000 }));
    expect(probe.mock.calls[0]![1]).toBe(90_000);
    expect(probe.mock.calls[0]![2]).toBe(5000);
    const probe2 = probeStub(PROBE_OK);
    await checkCodexBridge(ctxFor({ deadline: 4_000 }), bridgeDeps(USER_BRIDGE, { probeMcp: probe2, now: () => 1_000 }));
    expect(probe2.mock.calls[0]![2]).toBe(3000);
  });

  // M-FIRST-ONLY: probing only the first winner reddens this.
  it("probes every trustworthy bridge and advises naming the one that failed with its scope", async () => {
    const probe = probeStub(PROBE_OK, { kind: "timeout", allocatedMs: 2500 });
    const check = await checkCodexBridge(
      ctxFor(),
      bridgeDeps(
        {
          [CLAUDE_JSON]: claudeJson({
            mcpServers: { "codex-bridge": NODE_BRIDGE },
            projects: { [PROJECT]: { mcpServers: { "codex-bridge-local": NPX_BRIDGE } } },
          }),
        },
        { probeMcp: probe },
      ),
    );
    expect(probe).toHaveBeenCalledTimes(2);
    // Exactly these launches, in precedence order (local before user).
    expect(probe.mock.calls.map(([launch]) => launch.argv)).toEqual([
      ["npx", "-y", "codex-claude-bridge@latest"],
      ["node", "/opt/codex-claude-bridge/dist/index.js"],
    ]);
    expect(check.status).toBe("advise");
    expect(check.message).toContain("`codex-bridge` (user scope)");
    expect(check.message).toContain("did not answer the initialize request within 2500 ms");
    expect(check.message).toContain("launch it by hand (node /opt/codex-claude-bridge/dist/index.js) and check it prints a JSON-RPC answer");
    expect(check.message).not.toContain("`codex-bridge-local` (local scope) did not");
    const bridges = JSON.parse(String(check.detail.bridges)) as Array<{ name: string; probe: string }>;
    expect(bridges.map((b) => [b.name, b.probe])).toEqual([["codex-bridge-local", "ok"], ["codex-bridge", "timeout"]]);
  });

  // M-STOP-AT-FIRST-FAILURE: an implementation that stops probing once a
  // bridge fails still passes the case above (ok first). Fail FIRST here.
  it("keeps probing after a failure: first fails, second answers, both launched and both in the detail", async () => {
    const probe = probeStub({ kind: "enoent", allocatedMs: 5000 }, PROBE_OK);
    const check = await checkCodexBridge(
      ctxFor(),
      bridgeDeps(
        { [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE }, projects: { [PROJECT]: { mcpServers: { "codex-bridge-local": NPX_BRIDGE } } } }) },
        { probeMcp: probe },
      ),
    );
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls.map(([launch]) => launch.argv)).toEqual([
      ["npx", "-y", "codex-claude-bridge@latest"],
      ["node", "/opt/codex-claude-bridge/dist/index.js"],
    ]);
    expect(check.status).toBe("advise");
    expect(check.message).toContain("`codex-bridge-local` (local scope) cannot be launched");
    expect(check.message).not.toContain("`codex-bridge` (user scope) cannot");
    const bridges = JSON.parse(String(check.detail.bridges)) as Array<{ name: string; probe: string }>;
    expect(bridges.map((b) => [b.name, b.probe])).toEqual([["codex-bridge-local", "enoent"], ["codex-bridge", "ok"]]);
  });

  it("two answering bridges are ok naming both", async () => {
    const check = await run({
      [CLAUDE_JSON]: claudeJson({
        mcpServers: { "codex-bridge": NODE_BRIDGE },
        projects: { [PROJECT]: { mcpServers: { "codex-bridge-local": NPX_BRIDGE } } },
      }),
    });
    expect(check.status).toBe("ok");
    expect(check.message).toContain("`codex-bridge-local`");
    expect(check.message).toContain("`codex-bridge`");
  });

  it("never probes for the Codex client, a shadowed bridge, an unverifiable name or an unreadable scope", async () => {
    const cases: Array<[FileMap, Partial<StubOptions>]> = [
      [USER_BRIDGE, { }],
      [{ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE }, projects: { [PROJECT]: { mcpServers: { "codex-bridge": { command: "false", args: [] } } } } }) }, {}],
      [{ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": { command: "sh", args: ["-c", "codex-claude-bridge"] } } }) }, {}],
      [{ [CLAUDE_JSON]: UNREADABLE, [MCP_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }) }, {}],
      [{ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }), [MCP_JSON]: UNREADABLE }, {}],
    ];
    const probe0 = probeStub(PROBE_OK);
    await checkCodexBridge(ctxFor({ client: "codex" }), bridgeDeps(cases[0]![0], { probeMcp: probe0 }));
    expect(probe0).not.toHaveBeenCalled();
    for (const [files, over] of cases.slice(1)) {
      const probe = probeStub(PROBE_OK);
      const check = await checkCodexBridge(ctxFor(), bridgeDeps(files, { ...over, probeMcp: probe }));
      expect(probe).not.toHaveBeenCalled();
      expect(check.status).toBe("skip");
    }
  });

  it("a native-binding failure advises the rebuild in the directory that owns better-sqlite3, shell-quoted", async () => {
    const stderr = "Error: Could not locate the bindings file. Tried:\n -> /x/better_sqlite3.node";
    const probe = probeStub({ kind: "failed", reason: "exited before answering", code: 1, signal: null, stderr, allocatedMs: 5000 });
    const owner = vi.fn(() => "/opt/my bridge");
    const check = await checkCodexBridge(ctxFor(), bridgeDeps(USER_BRIDGE, { probeMcp: probe, nativeRebuildDir: owner }));
    expect(owner).toHaveBeenCalledWith("/opt/codex-claude-bridge/dist/index.js");
    expect(check.status).toBe("advise");
    expect(check.message).toContain("Run: (cd '/opt/my bridge' && npm rebuild better-sqlite3)");
  });

  it("the binary grammar asks the owner of the command itself", async () => {
    const probe = probeStub({ kind: "failed", reason: "exited before answering", code: 1, signal: null, stderr: "NODE_MODULE_VERSION 115", allocatedMs: 5000 });
    const owner = vi.fn(() => "/opt/b");
    await checkCodexBridge(ctxFor(), bridgeDeps({ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": { command: "/usr/local/bin/codex-claude-bridge", args: [] } } }) }, { probeMcp: probe, nativeRebuildDir: owner }));
    expect(owner).toHaveBeenCalledWith("/usr/local/bin/codex-claude-bridge");
  });

  it("a native-binding failure with no owning package names the registration and the replace steps", async () => {
    const probe = probeStub({ kind: "failed", reason: "exited before answering", code: 1, signal: null, stderr: "ERR_DLOPEN_FAILED", allocatedMs: 5000 });
    const check = await checkCodexBridge(ctxFor(), bridgeDeps({ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NPX_BRIDGE } }) }, { probeMcp: probe }));
    expect(check.status).toBe("advise");
    expect(check.message).toContain("could not be established from this registration (user codex-bridge: npx -y codex-claude-bridge@latest)");
    expect(check.message).toContain("claude mcp remove codex-bridge -s user");
    expect(check.message).toContain("storybloq setup-skill");
  });

  it("an ok answer whose stderr reports the native module as unloadable is advise with the rebuild command (bridge 1.8.0 degrades instead of exiting)", async () => {
    const stderr = "[codex-bridge] review storage unavailable; reviews will run without history: SQLite native addon could not load. Original error: Could not locate the bindings file. Tried:\n -> /opt/x/better_sqlite3.node\n";
    const probe = probeStub({ ...PROBE_OK, stderr });
    const owner = vi.fn(() => "/opt/codex-claude-bridge");
    const check = await checkCodexBridge(ctxFor(), bridgeDeps(USER_BRIDGE, { probeMcp: probe, nativeRebuildDir: owner }));
    expect(check.status).toBe("advise");
    expect(check.message).toContain("answers but cannot load its native module");
    expect(check.message).toContain("Run: (cd /opt/codex-claude-bridge && npm rebuild better-sqlite3)");
    expect(owner).toHaveBeenCalledWith("/opt/codex-claude-bridge/dist/index.js");
    expect(JSON.parse(check.detail!["bridges"] as string)[0]).toMatchObject({ probe: "ok", degraded: "native-module" });
  });

  it("a failed exit quotes the first Error line of stderr, not a Node loader frame", async () => {
    const stderr = "node:internal/modules/cjs/loader:1368\n  throw err;\n  ^\n\nError: Cannot find module '/opt/codex-claude-bridge/dist/index.js'\n    at Module._resolveFilename\n";
    const probe = probeStub({ kind: "failed", reason: "exited before answering", code: 1, signal: null, stderr, allocatedMs: 5000 });
    const check = await checkCodexBridge(ctxFor(), bridgeDeps(USER_BRIDGE, { probeMcp: probe }));
    expect(check.status).toBe("advise");
    expect(check.message).toContain("exit code 1: Error: Cannot find module '/opt/codex-claude-bridge/dist/index.js'");
    expect(check.message).not.toContain("loader:1368");
  });

  it("a not-attempted probe reads as not probed, never as broken", async () => {
    const probe = probeStub({ kind: "not-attempted", reason: "budget exhausted" });
    const check = await checkCodexBridge(ctxFor(), bridgeDeps(USER_BRIDGE, { probeMcp: probe }));
    expect(check.status).toBe("advise");
    expect(check.message).toContain("was not probed (budget exhausted)");
    expect(check.message).toContain("re-run storybloq health --only codex-bridge");
    expect(check.message).not.toMatch(/broken|failed/);
  });

  it("an enoent probe says the registered command cannot be launched", async () => {
    const probe = probeStub({ kind: "enoent", allocatedMs: 5000 });
    const check = await checkCodexBridge(ctxFor(), bridgeDeps(USER_BRIDGE, { probeMcp: probe }));
    expect(check.status).toBe("advise");
    expect(check.message).toContain("cannot be launched: node was not found (registered as node /opt/codex-claude-bridge/dist/index.js)");
    expect(check.message).toContain("install it or fix the registered command (claude mcp remove codex-bridge -s user, then storybloq setup-skill registers the bundled bridge)");
  });

  it("a malformed shadowing codex-bridge entry never crashes the repair text", async () => {
    const probe = probeStub({ kind: "failed", reason: "exited before answering", code: 1, signal: null, stderr: "ERR_DLOPEN_FAILED", allocatedMs: 5000 });
    const check = await checkCodexBridge(
      ctxFor(),
      bridgeDeps(
        { [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge-local": NPX_BRIDGE }, projects: { [PROJECT]: { mcpServers: { "codex-bridge": { args: 3 } } } } }) },
        { probeMcp: probe },
      ),
    );
    expect(check.status).toBe("advise");
    expect(check.message).toContain("claude mcp remove codex-bridge -s local");
  });
});

describe("T-509 codex-bridge check: no registered bridge, the bundle decides", () => {
  const NONE = { [CLAUDE_JSON]: claudeJson({ mcpServers: {} }) };

  it("bundle absent: skip 'no bridge resolves', probe untouched", async () => {
    const probe = probeStub(PROBE_OK);
    const check = await checkCodexBridge(ctxFor(), bridgeDeps(NONE, { bundledBridge: { kind: "absent" }, probeMcp: probe }));
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("no bridge resolves");
    expect(check.message).toBe("No codex-claude-bridge is registered and the bundled copy did not install, so there is no Codex review backend to check.");
    expect(probe).not.toHaveBeenCalled();
  });

  it("bundle unusable: advise with the reason and the reinstall command", async () => {
    const check = await checkCodexBridge(ctxFor(), bridgeDeps(NONE, { bundledBridge: { kind: "unusable", reason: "entry file missing: /x" } }));
    expect(check.status).toBe("advise");
    expect(check.message).toContain("unusable (entry file missing: /x)");
    expect(check.message).toContain("npm install -g @storybloq/storybloq@latest");
  });

  // The T-502 rule wins: a name that claims to be the bridge is never
  // contradicted with setup advice, even when the bundle is installed.
  it("bundle installed with a foreign user codex-bridge still skips 'cannot verify'", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": { command: "python", args: ["/srv/x.py"] } } }) });
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("cannot verify codex-bridge");
  });

  it("bundle installed with an unrelated name registered still advises setup", async () => {
    const check = await run({ [CLAUDE_JSON]: claudeJson({ mcpServers: { reviewer: { command: "python", args: ["/srv/x.py"] } } }) });
    expect(check.status).toBe("advise");
    expect(check.message).toContain("Run storybloq setup-skill.");
  });

  it("a foreign local codex-bridge shadowing a bundled user registration names the local entry", async () => {
    const probe = probeStub({ kind: "failed", reason: "exited before answering", code: 1, signal: null, stderr: "better-sqlite3 missing", allocatedMs: 5000 });
    const check = await checkCodexBridge(
      ctxFor(),
      bridgeDeps(
        { [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge-local": NPX_BRIDGE }, projects: { [PROJECT]: { mcpServers: { "codex-bridge": { command: "python", args: ["/srv/x.py"] } } } } }) },
        { probeMcp: probe },
      ),
    );
    expect(check.status).toBe("advise");
    expect(check.message).toContain("remove the local-scope `codex-bridge` entry first (claude mcp remove codex-bridge -s local), then the failing registration (claude mcp remove codex-bridge-local -s user), then run storybloq setup-skill");
    // The foreign python entry was never launched: one probe, the bridge's argv.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0]!.argv).toEqual(["npx", "-y", "codex-claude-bridge@latest"]);
  });
});

describe("codex-bridge reads the selected .claude.json (ISS-1270)", () => {
  const over = { claudeJsonPath: "/cfg/.claude.json" };

  it("finds the registration in the override's registry", async () => {
    const check = await checkCodexBridge(ctxFor(), bridgeDeps({ "/cfg/.claude.json": claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }), [CLAUDE_JSON]: claudeJson({}) }, over));
    expect(check.status).toBe("ok");
    expect(check.detail).toMatchObject({ scope: "user" });
  });

  it("does not count a registration that exists only in HOME's registry", async () => {
    const check = await checkCodexBridge(ctxFor(), bridgeDeps({ "/cfg/.claude.json": claudeJson({}), [CLAUDE_JSON]: claudeJson({ mcpServers: { "codex-bridge": NODE_BRIDGE } }) }, over));
    expect(check.status).not.toBe("ok");
  });
});
