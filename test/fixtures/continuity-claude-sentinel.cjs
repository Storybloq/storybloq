/**
 * ISS-1486: a stand-in `claude` for the continuity runner. It never starts a model. It answers the six readback
 * requests through the T-538 sentinel's measured shapes (Agent advertised, the server's environment echoed),
 * reads the prompt from stdin, and then plays one of two sessions:
 *   - `/story auto <ticket>`: what the runner's in-process fake child plays (ledger writes, fingerprint, plan,
 *     handover, a commit), with the stream the runner parses;
 *   - the pilot's challenge: one Agent call whose subagent makes the five probes, with the sandbox's refusals
 *     played by the stand-in itself (it is not a sandbox; the pilot's judge is what is under test).
 * `main(config)` runs it; the config is embedded by the wrapper the test writes.
 *   config.log         JSON-lines log: argv, each request, the user message, end of input
 *   config.tools       the storybloq tool names the server advertises
 *   config.builtIns    the built-in tools the init event reports
 *   config.fingerprint the dist/mcp.js sha256 the session's state carries
 *   config.mutate      { sub, path, value } one readback answer changed, or { sub: "init", path, value }
 *   config.denials     the result event's permission_denials
 *   config.pilot       { skip?: probe, main?: probe, noId?: probe, claim?: probe, outside?: true, reach?: true, canary?: true,
 *                        echo?: probe (an `echo <mark>` no-op in place of the command), bare?: "network" (the network
 *                        command without its printf payload), retarget?: probe (the probe aimed at another path),
 *                        plant?: { probe, kind: "dir" | "link" | "unreadable" } (that probe's target left as a folder,
 *                        a dangling link or a file nobody can read, while the call itself is refused),
 *                        netText?: string (the network refusal's text; by default the sandbox's EPERM line, as nc prints it) }
 *   config.realServer  true (ISS-1486 G1, G2): before answering, start the server the MCP file names, as a client does
 *                      (this process's environment under the entry's), list its tools over stdio, stop it, and
 *                      report those tools (not config.tools) in mcp_status and the init event; logged as kind "server"
 *   config.hang        true: after the prompt, play nothing and wait to be killed
 *   config.noInit      true: the session stream carries no init event
 */
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { goodResponses } = require("./t538-claude-sentinel.cjs");

function setAt(v, dotted, value) {
  const keys = dotted.split(".");
  let at = v;
  for (const k of keys.slice(0, -1)) at = at[k];
  at[keys[keys.length - 1]] = value;
}

const SID = "11111111-2222-4333-8444-555555555555";

/** G1, G2: the tool names the configured server registers, as a client would see them: initialize, then tools/list. */
function listServerTools(server, cwd) {
  return new Promise((done) => {
    const child = spawn(server.command, server.args, { cwd, env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    let tools = null;
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stdout.on("data", (c) => {
      buf += c.toString("utf-8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }); }
        else if (m.id === 2) { tools = ((m.result && m.result.tools) || []).map((t) => t.name); child.kill("SIGTERM"); }
      }
    });
    child.stderr.on("data", (c) => { stderr += c.toString("utf-8"); });
    child.stdin.on("error", () => {});
    child.on("exit", (code, signal) => { clearTimeout(timer); done({ tools, code, signal, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); done({ tools: null, code: null, signal: null, stderr: String(e) }); });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "continuity-sentinel", version: "1" } } });
  });
}

function main(config) {
  if (!config.realServer) return run(config);
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--mcp-config");
  const server = JSON.parse(fs.readFileSync(argv[i + 1], "utf-8")).mcpServers.storybloq;
  listServerTools(server, process.cwd()).then((r) => {
    fs.appendFileSync(config.log, `${JSON.stringify({ kind: "server", tools: r.tools, code: r.code, signal: r.signal, stderr: r.stderr.slice(0, 4000) })}\n`);
    run({ ...config, tools: r.tools || [] });
  });
}

function run(config) {
  const argv = process.argv.slice(2);
  const log = (o) => fs.appendFileSync(config.log, `${JSON.stringify(o)}\n`);
  log({ kind: "argv", argv, env: Object.keys(process.env).sort() });
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const policy = JSON.parse(fs.readFileSync(opt("--settings"), "utf-8"));
  const server = JSON.parse(fs.readFileSync(opt("--mcp-config"), "utf-8")).mcpServers.storybloq;
  const project = process.cwd();
  const answers = goodResponses({ project, roots: policy.sandbox.filesystem.allowWrite, policy, mcpTools: config.tools, mcpLaunch: { command: server.command, args: server.args } });
  for (const s of answers.mcp_status.mcpServers) s.config = { ...s.config, env: { ...server.env } };
  const m = config.mutate ?? null;
  if (m !== null && m.sub !== "init") setAt(answers[m.sub], m.path, m.value);
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const init = () => {
    const e = { type: "system", subtype: "init", session_id: SID, cwd: project, model: opt("--model"), permissionMode: "dontAsk", apiKeySource: "none",
      mcp_servers: [{ name: "storybloq", status: "connected" }], tools: [...config.builtIns, ...config.tools.map((t) => `mcp__storybloq__${t}`)] };
    if (m !== null && m.sub === "init") setAt(e, m.path, m.value);
    return e;
  };
  let pending = "";
  const onLine = (text) => {
    if (text.trim() === "") return;
    const msg = JSON.parse(text);
    if (msg.type === "control_request") {
      const sub = msg.request.subtype;
      log({ kind: "request", subtype: sub });
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: answers[sub] } });
      return;
    }
    if (msg.type === "user") {
      const prompt = msg.message.content;
      log({ kind: "user", content: prompt });
      const ticket = /^\/story auto (T-\d+)$/.exec(prompt);
      if (config.hang) return;
      if (ticket) autoSession(ticket[1]);
      else pilotSession(prompt);
    }
  };
  const result = (extra = {}) => out({ type: "result", subtype: "success", is_error: false, session_id: SID, num_turns: 4, total_cost_usd: 0.5, usage: {}, permission_denials: config.denials ?? [], ...extra });

  function autoSession(ticketId) {
    const sessionDir = path.join(project, ".story", "sessions", SID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "plan.md"), "# plan\n\nEXISTING: src/http/router.ts\n");
    fs.writeFileSync(path.join(sessionDir, "context-digest.md"), "# digest\n");
    const ticket = path.join(project, ".story", "tickets", `${ticketId}.json`);
    fs.writeFileSync(ticket, JSON.stringify({ ...JSON.parse(fs.readFileSync(ticket, "utf-8")), status: "complete" }, null, 2));
    fs.mkdirSync(path.join(project, ".story", "handovers"), { recursive: true });
    fs.writeFileSync(path.join(project, ".story", "handovers", `2026-09-20-${ticketId.toLowerCase()}.md`), `# handover\n\n${ticketId} done\n`);
    const g = (a) => execFileSync("git", a, { cwd: project, stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    g(["add", "-A"]); g(["commit", "-q", "-m", `${ticketId}: done`]);
    fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({ state: "SESSION_END", status: "completed", terminationReason: "normal", completedTickets: [{ id: ticketId }], binaryFingerprint: { mtime: 1, sha256: config.fingerprint } }));
    const guide = "mcp__storybloq__storybloq_autonomous_guide";
    const use = (r, id, name, input) => out({ type: "assistant", parent_tool_use_id: null, message: { id: r, model: opt("--model"), role: "assistant", content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 10, output_tokens: 1 } } });
    const res = (id, text) => out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
    const state = (s) => `instruction\n\n---\n**Session:** ${SID}\n**State:** ${s}\n`;
    if (!config.noInit) out(init());
    use("r1", "t1", guide, { sessionId: null, action: "start", targetWork: [ticketId] }); res("t1", state("PLAN"));
    use("r2", "t2", guide, { sessionId: SID, action: "report", report: { completedAction: "plan_written" } }); res("t2", state("PLAN_REVIEW"));
    result();
  }

  function pilotSession(prompt) {
    const id = /pilot id (\S+)/.exec(prompt)[1];
    const target = (k) => new RegExp(`\\d\\. ${k}: (\\S+)`).exec(prompt)[1];
    const p = config.pilot ?? {};
    out(init());
    out({ type: "assistant", parent_tool_use_id: null, message: { id: "m0", model: opt("--model"), role: "assistant", content: [{ type: "tool_use", id: "agent-1", name: "Agent", input: { prompt: "run the probes" } }], usage: {} } });
    const denials = [];
    const probes = [
      ["bash-inside", "Bash", () => ({ command: `printf '${id} bash-inside\\n' > ${target("bash-inside")} # ${id}-bash-inside` }), () => fs.writeFileSync(target("bash-inside"), `${id} bash-inside\n`), true],
      ["bash-outside", "Bash", () => ({ command: `printf '${id} bash-outside\\n' > ${target("bash-outside")} # ${id}-bash-outside` }), () => fs.writeFileSync(target("bash-outside"), `${id} bash-outside\n`), p.outside === true],
      ["edit-outside", "Edit", () => ({ file_path: target("edit-outside"), old_string: "", new_string: `${id} edit-outside\n`, note: `${id}-edit-outside` }), () => fs.writeFileSync(target("edit-outside"), `${id} edit-outside\n`), false],
      ["edit-inside", "Edit", () => ({ file_path: target("edit-inside"), old_string: "", new_string: `${id} edit-inside\n`, note: `${id}-edit-inside` }), () => fs.writeFileSync(target("edit-inside"), `${id} edit-inside\n`), true],
      ["network", "Bash", () => ({ command: `printf '${id}' | nc 127.0.0.1 ${target("network")} # ${id}-network` }), null, false],
    ];
    const steps = [];
    for (const [probe, tool, input, act, runs] of probes) {
      if (p.skip === probe) continue;
      const callId = `probe-${probe}`;
      const parent = p.main === probe ? null : "agent-1";
      let inp = input();
      if (p.noId === probe) inp = JSON.parse(JSON.stringify(inp).split(id).join("X"));
      if (p.echo === probe) inp = { command: `echo ${id}-${probe}` };
      if (p.bare === probe) inp = { command: `nc 127.0.0.1 ${target("network")} # ${id}-network` };
      if (p.retarget === probe) inp = JSON.parse(JSON.stringify(inp).split(target(probe)).join(`${target(probe)}.x`));
      if (p.claim === probe) { steps.push(() => out({ type: "assistant", parent_tool_use_id: parent, message: { id: `m-${probe}`, role: "assistant", content: [{ type: "text", text: `${probe} done for ${id}` }], usage: {} } })); continue; }
      steps.push(async () => {
        out({ type: "assistant", parent_tool_use_id: parent, message: { id: `m-${probe}`, role: "assistant", content: [{ type: "tool_use", id: callId, name: tool, input: inp }], usage: {} } });
        let ok = runs;
        if (runs && act) act();
        if (p.plant && p.plant.probe === probe) {
          const at = target(probe);
          if (p.plant.kind === "dir") fs.mkdirSync(at);
          else if (p.plant.kind === "link") fs.symlinkSync(`${at}.missing`, at);
          else { fs.writeFileSync(at, `${id} ${probe}\n`); fs.chmodSync(at, 0); }
        }
        if (probe === "network" && p.reach) ok = await new Promise((done) => { const s = net.connect(Number(target("network")), "127.0.0.1", () => s.end(id, () => done(true))); s.on("error", () => done(false)); });
        if (probe === "edit-outside" && !runs) denials.push({ tool_name: "Edit", tool_use_id: callId, tool_input: inp });
        const refusal = probe === "network" ? (p.netText ?? `nc: connectx to 127.0.0.1 port ${target("network")} (tcp) failed: Operation not permitted`) : "refused";
        out({ type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, is_error: !ok, content: ok ? "ok" : refusal }] } });
      });
    }
    if (p.canary) steps.push(() => fs.appendFileSync(path.join(path.dirname(target("bash-outside")), "canary.txt"), "x"));
    (async () => {
      for (const s of steps) await s();
      result({ permission_denials: [...denials, ...(config.denials ?? [])] });
    })();
  }

  process.stdin.on("data", (c) => {
    pending += c.toString("utf-8");
    let nl = pending.indexOf("\n");
    while (nl !== -1) { onLine(pending.slice(0, nl)); pending = pending.slice(nl + 1); nl = pending.indexOf("\n"); }
  });
  process.stdin.on("end", () => { log({ kind: "end" }); process.exit(0); });
}

module.exports = { main };
