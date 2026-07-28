import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * ISS-892, end to end through the real MCP server.
 *
 * The two unit suites prove the pieces. This proves the thing that was actually
 * reported: a tool answering "Updated ticket T-XXX" over a file that never
 * changed. It runs against the BUILT bundle, so `npm run build` must have
 * produced a current dist/cli.js.
 */

vi.setConfig({ testTimeout: 60_000 });

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(pkgRoot, "dist", "cli.js");

interface JsonRpcMessage {
  id?: number;
  result?: { tools?: ToolDefinition[]; content?: { text: string }[]; isError?: boolean };
}

interface ToolDefinition {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; additionalProperties?: unknown };
}

/**
 * Runs one MCP session: initialize, then every request in order, and returns the
 * responses keyed by request id. Each call is its own server process, which keeps
 * a failing case from leaking state into the next.
 */
function mcpSession(
  cwd: string,
  requests: { id: number; method: string; params?: unknown }[],
): Promise<Map<number, JsonRpcMessage>> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("node", [cliPath, "--mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map<number, JsonRpcMessage>();
    let buffer = "";
    let stderr = "";

    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as JsonRpcMessage;
          if (message.id !== undefined) responses.set(message.id, message);
        } catch {
          // Not JSON-RPC (banner or log line); ignore.
        }
        if (responses.size > requests.length) break;
      }
      if (requests.every((r) => responses.has(r.id))) {
        proc.kill();
        resolvePromise(responses);
      }
    });

    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "iss892-test", version: "0" },
      },
    });

    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      for (const r of requests) send({ jsonrpc: "2.0", ...r });
    }, 500);

    setTimeout(() => {
      proc.kill();
      if (requests.every((r) => responses.has(r.id))) resolvePromise(responses);
      else reject(new Error(`MCP session timed out. stderr: ${stderr}`));
    }, 25_000);
  });
}

function callTool(cwd: string, name: string, args?: Record<string, unknown>) {
  const params = args === undefined ? { name } : { name, arguments: args };
  return mcpSession(cwd, [{ id: 1, method: "tools/call", params }]).then((r) => {
    const message = r.get(1);
    return {
      isError: message?.result?.isError === true,
      text: message?.result?.content?.[0]?.text ?? "",
    };
  });
}

function cli(cwd: string, ...args: string[]): string {
  return execFileSync("node", [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function newProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  cli(dir, "init", "--name", prefix, "--type", "npm");
  cli(dir, "ticket", "create", "--title", "original title", "--type", "task");
  return dir;
}

function ticketFile(dir: string): string {
  const ticketsDir = join(dir, ".story", "tickets");
  const name = readdirSync(ticketsDir).find((f) => f.endsWith(".json"))!;
  return readFileSync(join(ticketsDir, name), "utf-8");
}

beforeAll(() => {
  expect(
    () => readFileSync(cliPath),
    "dist/cli.js is missing. Run `npm run build` before this suite.",
  ).not.toThrow();
});

describe("ISS-892: a write tool must not report success over an unchanged file", () => {
  it("rejects the reported case: a field name the tool does not implement", async () => {
    // Observed live 2026-07-28: storybloq_ticket_update with appendDescription.
    // The key was stripped, the handler saw a bare id, and the caller was told
    // the ticket was updated.
    const dir = newProject("iss892-unknown");
    const before = ticketFile(dir);

    const result = await callTool(dir, "storybloq_ticket_update", {
      id: "T-001",
      appendDescription: "this field does not exist",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("appendDescription");
    expect(ticketFile(dir)).toBe(before);
  });

  it("rejects an update carrying only an id, and leaves the file untouched", async () => {
    const dir = newProject("iss892-bare");
    const before = ticketFile(dir);

    const result = await callTool(dir, "storybloq_ticket_update", { id: "T-001" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No fields to update");
    expect(ticketFile(dir)).toBe(before);
  });

  it("still performs a real update, so the guard is not simply refusing writes", async () => {
    const dir = newProject("iss892-real");
    const before = ticketFile(dir);

    const result = await callTool(dir, "storybloq_ticket_update", { id: "T-001", title: "changed" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("changed");
    expect(ticketFile(dir)).not.toBe(before);
    expect(ticketFile(dir)).toContain("changed");
  });

  it("guards a tool that declares no arguments at all", async () => {
    // storybloq_snapshot had no inputSchema, so the SDK skipped validation
    // entirely and any stray argument was accepted and ignored.
    const dir = newProject("iss892-noargs");
    const result = await callTool(dir, "storybloq_snapshot", { label: "not a parameter" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("label");
  });

  it("still lets a no-argument tool be called with no arguments field", async () => {
    // Compatibility: those tools were previously unvalidated, and a client may
    // omit `arguments` entirely. Requiring an object would break a working call.
    const dir = newProject("iss892-noargs-ok");
    const result = await callTool(dir, "storybloq_phase_list");
    expect(result.isError).toBe(false);
  });

  it("rejects an unrecognized argument on EVERY registered tool", async () => {
    // Coverage, asserted behaviorally rather than from the advertised schema.
    // The published JSON Schema already carried additionalProperties: false
    // before this fix -- the SDK emits that from the shape regardless of
    // strictness -- so reading tools/list proves nothing: the server was
    // contradicting its own published contract. Only calling each tool shows
    // whether the rule is enforced.
    //
    // The shim is server-level so no registration can miss it; this checks that
    // at runtime instead of trusting the wiring. One session, one request per
    // tool. Validation fails before any handler runs, so nothing is written.
    const dir = newProject("iss892-every-tool");
    const listed = await mcpSession(dir, [{ id: 1, method: "tools/list" }]);
    const tools = listed.get(1)?.result?.tools ?? [];
    expect(tools.length).toBeGreaterThan(40);

    const probe = "__unrecognized_probe__";
    const responses = await mcpSession(
      dir,
      tools.map((tool, i) => ({
        id: i + 1,
        method: "tools/call",
        params: { name: tool.name, arguments: { [probe]: 1 } },
      })),
    );

    // A tool with required arguments also reports those as missing, so asserting
    // on the probe key specifically is what separates "rejected the unknown key"
    // from "rejected the call for some other reason".
    const accepted = tools
      .filter((tool, i) => !(responses.get(i + 1)?.result?.content?.[0]?.text ?? "").includes(probe))
      .map((t) => t.name);
    expect(accepted, "these tools silently dropped an unrecognized argument").toEqual([]);
  });
});

describe("ISS-892: the same guard on the CLI", () => {
  it("rejects a bare update on every entity type, leaving each file untouched", () => {
    const dir = newProject("iss892-cli");
    cli(dir, "issue", "create", "--title", "i", "--severity", "low", "--impact", "x");
    cli(dir, "note", "create", "--content", "c");
    cli(dir, "lesson", "create", "--title", "t", "--content", "c", "--context", "x", "--source", "manual");

    const cases: { args: string[]; dir: string }[] = [
      { args: ["ticket", "update", "T-001"], dir: "tickets" },
      { args: ["issue", "update", "ISS-001"], dir: "issues" },
      { args: ["note", "update", "N-001"], dir: "notes" },
      { args: ["lesson", "update", "L-001"], dir: "lessons" },
    ];

    for (const { args, dir: entityDir } of cases) {
      const path = join(dir, ".story", entityDir);
      const file = join(path, readdirSync(path).find((f) => f.endsWith(".json"))!);
      const before = readFileSync(file, "utf-8");

      let failed = false;
      let output = "";
      try {
        output = cli(dir, ...args);
      } catch (err) {
        failed = true;
        const e = err as { stdout?: string; stderr?: string };
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }

      expect(failed, `${args.join(" ")} should exit nonzero`).toBe(true);
      expect(output).toContain("No fields to update");
      expect(readFileSync(file, "utf-8"), `${args.join(" ")} must not write`).toBe(before);
    }
  });

  it("rejects a bare node update, which reaches the guard by a different route", () => {
    // handleNodeUpdate takes an `opts` object assembled at the yargs layer rather
    // than the `updates` object the other four share, and it holds the two
    // clear-flags (clearDependsOn, clearLinks) that the false-is-not-a-value rule
    // exists for. A defaulted option there would satisfy the guard while the loop
    // above stayed green, so it is checked separately against its own config file.
    const dir = mkdtempSync(join(tmpdir(), "iss892-node-"));
    const child = mkdtempSync(join(tmpdir(), "iss892-node-child-"));
    cli(dir, "init", "--name", "orch", "--type", "orchestrator");
    cli(dir, "node", "add", "child", "--path", child);

    const configPath = join(dir, ".story", "config.json");
    const before = readFileSync(configPath, "utf-8");

    let failed = false;
    let output = "";
    try {
      output = cli(dir, "node", "update", "child");
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    expect(failed, "node update with no flags should exit nonzero").toBe(true);
    expect(output).toContain("No fields to update");
    expect(readFileSync(configPath, "utf-8")).toBe(before);

    // And the guard is not simply refusing every node update.
    expect(cli(dir, "node", "update", "child", "--role", "worker")).toContain("child");
    expect(readFileSync(configPath, "utf-8")).not.toBe(before);
  });

  it("still performs a real CLI update", () => {
    const dir = newProject("iss892-cli-ok");
    expect(cli(dir, "ticket", "update", "T-001", "--title", "changed")).toContain("changed");
    expect(ticketFile(dir)).toContain("changed");
  });
});
