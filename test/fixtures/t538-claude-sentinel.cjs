/**
 * T-538 commit 1: a stand-in `claude` that speaks the stdin control protocol. It never starts a model. Its
 * answers to the six readback requests have the shapes measured from Claude Code 2.1.322 (control
 * response envelope, bare MCP tool names, the sandbox dialog locked), with paths taken from this launch:
 * the policy from `--settings`, the server launch from `--mcp-config`, the project from its cwd.
 *
 * `goodResponses` is shared with the unit rows. `main(config)` runs the stand-in; the config is embedded by
 * the test that writes the PATH wrapper, so nothing about it travels through the client's environment.
 *   config.log      a JSON-lines log: argv, each request, the user message (with how many answers preceded it)
 *   config.sets     { degraded, full }: picked by whether <cwd>/.story/config.json exists, as the runner does
 *   config.text     the turn's reply text
 *   config.mark     a string that must appear in neither the argv nor the environment; logged as a boolean
 *   config.mutate   { sub, path?, value?, how: "set" | "drop" | "late" | "error" }: one answer changed
 *   config.tamper   "edit" | "chmod" | "link" | "same": done to the policy file after the first turn's result
 *                   T-538 5.6: "skill" edits the provisioned skill, "extra" adds a file to the config folder,
 *                   "plant" writes .claude/settings.json in the project, "state" writes under Claude's own projects/
 *   config.split    a multibyte character: the first turn's assistant line (in its message id) and a stderr line
 *                   each carry it, written as two writes split inside its bytes, 200 ms apart
 *   config.early    true: the init and result events go out with the last readback answer, before any prompt
 *   config.noInit   with early: the init event is left out
 *   config.server   false: start no tool server (T-538 5.2's "no sandboxed server" row); otherwise the server the
 *                   MCP file names is started with its env block over this process's environment, initialized,
 *                   stopped and awaited before the stand-in exits
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function goodResponses(x) {
  const policy = x.policy;
  const rule = (behavior, r, source = "flagSettings") => ({ behavior, source, rule: r, description: { prefix: "Any use of the ", emphasis: r, suffix: " tool" }, editability: "readonly" });
  return {
    initialize: { commands: [], agents: [], account: { tokenSource: "none", apiProvider: "firstParty" }, current_permission_mode: "dontAsk", claude_code_version: "2.1.322" },
    get_settings: { effective: policy, sources: [{ source: "userSettings", settings: { env: {}, hooks: {} } }, { source: "flagSettings", settings: policy }] },
    get_sandbox_dialog: {
      supported: true, locked: true, overrides_locked: true, policy_origins: [], enabled: true, enabled_in_settings: true, mode: "auto-allow", auto_allow_available: true, no_sandbox_allowed: true,
      unsandboxed_fallback: false, dependencies: { errors: [], warnings: [] }, excluded_commands: [],
      restrictions: {
        fs_deny_read: [], fs_allow_read: [], fs_allow_write: [...x.roots], fs_deny_write: [], network_allowed_domains: [], network_denied_domains: [], network_managed: false,
        unix_sockets: [], allow_all_unix_sockets: false, ignored_glob_patterns: [],
      },
    },
    list_permission_rules: {
      state: {
        rules: [...policy.permissions.allow.map((r) => rule("allow", r)), ...policy.permissions.deny.map((r) => rule("deny", r)), rule("deny", "WebFetch", "toolsNarrowing")],
        workspaceDirectories: [], originalCwd: x.project, managedOnly: false,
      },
    },
    mcp_status: {
      mcpServers: [{
        name: "storybloq", status: "connected", serverInfo: { name: "storybloq", version: "1.16.0" }, config: { type: "stdio", command: x.mcpLaunch.command, args: [...x.mcpLaunch.args] },
        transport: "stdio", scope: "dynamic", source: "dynamic", tools: x.mcpTools.map((name) => ({ name, annotations: {} })), capabilities: {},
      }],
    },
    get_hooks_listing: { events: [], hooks: [], eventCatalog: [], policy: { disabledByPolicy: false, managedOnly: false, pluginOnly: false, allDisabled: false, policyHookCount: 0 } },
  };
}

/** `v` with the value at a dotted path set (a function receives the old value). */
function setAt(v, dotted, value) {
  const keys = dotted.split(".");
  let at = v;
  for (const k of keys.slice(0, -1)) at = at[k];
  const last = keys[keys.length - 1];
  at[last] = typeof value === "function" ? value(at[last]) : value;
}

/** Turns a JSON-safe mutation value into one setAt applies: { append } or { drop } act on the old array. */
function valueOf(m) {
  if (m.value && typeof m.value === "object" && !Array.isArray(m.value) && "append" in m.value) return (old) => [...old, m.value.append];
  if (m.value && typeof m.value === "object" && !Array.isArray(m.value) && "dropFirst" in m.value) return (old) => old.slice(1);
  if (m.value && typeof m.value === "object" && !Array.isArray(m.value) && "configArgs" in m.value) return (old) => old.map((s) => ({ ...s, config: { ...s.config, args: m.value.configArgs } }));
  if (m.value && typeof m.value === "object" && !Array.isArray(m.value) && "flagHooks" in m.value) return (old) => old.map((s) => (s.source === "flagSettings" ? { ...s, settings: { ...s.settings, hooks: m.value.flagHooks } } : s));
  return m.value;
}

function tamper(kind, file) {
  const dir = path.dirname(file);
  if (kind === "edit") { fs.chmodSync(file, 0o600); fs.appendFileSync(file, " "); fs.chmodSync(file, 0o400); }
  else if (kind === "chmod") fs.chmodSync(file, 0o600);
  else if (kind === "link") { fs.copyFileSync(file, path.join(dir, "policy-real.json")); fs.rmSync(file); fs.symlinkSync(path.join(dir, "policy-real.json"), file); }
  else if (kind === "skill") fs.appendFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "skills", "story", "SKILL.md"), " ");
  else if (kind === "extra") fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "extra.json"), "{}\n");
  else if (kind === "plant") { fs.mkdirSync(path.join(process.cwd(), ".claude"), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), ".claude", "settings.json"), "{}\n"); }
  else if (kind === "state") { fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "p"), { recursive: true }); fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "p", "s.jsonl"), "{}\n"); }
  else if (kind === "same") { fs.copyFileSync(file, path.join(dir, "policy-next.json")); fs.chmodSync(path.join(dir, "policy-next.json"), 0o400); fs.renameSync(path.join(dir, "policy-next.json"), file); }
}

function main(config) {
  const argv = process.argv.slice(2);
  const log = (o) => fs.appendFileSync(config.log, `${JSON.stringify(o)}\n`);
  const env = Object.values(process.env).some((v) => typeof v === "string" && v.includes(config.mark));
  log({ kind: "argv", argv, markInArgv: argv.some((a) => a.includes(config.mark)), markInEnv: env });
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const policyFile = opt("--settings");
  const policy = JSON.parse(fs.readFileSync(policyFile, "utf-8"));
  const mcp = JSON.parse(fs.readFileSync(opt("--mcp-config"), "utf-8")).mcpServers.storybloq;
  const project = process.cwd();
  // As a real client does at launch: the configured server, with the MCP file's environment block.
  const server = config.server === false ? Promise.resolve(null)
    : require("./t538-server-start.cjs").startServer({ command: mcp.command, args: mcp.args }, { ...process.env, ...(mcp.env || {}) }, project);
  const tools = fs.existsSync(path.join(project, ".story", "config.json")) ? config.sets.full : config.sets.degraded;
  const answers = goodResponses({ project, roots: policy.sandbox.filesystem.allowWrite, policy, mcpTools: tools, mcpLaunch: { command: mcp.command, args: mcp.args } });
  const m = config.mutate ?? null;
  if (m !== null && m.how === "set" && m.sub !== "init") setAt(answers[m.sub], m.path, valueOf(m));
  const sessionId = opt("--session-id") ?? opt("--resume");
  const first = opt("--session-id") !== undefined;
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const initEvent = () => {
    const init = {
      type: "system", subtype: "init", session_id: sessionId, cwd: project, model: opt("--model"), permissionMode: "dontAsk", apiKeySource: "none",
      mcp_servers: [{ name: "storybloq", status: "connected" }], tools: ["Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write", ...tools.map((t) => `mcp__storybloq__${t}`)],
    };
    if (m !== null && m.how === "set" && m.sub === "init") setAt(init, m.path, valueOf(m));
    return init;
  };
  let answered = 0;
  let pending = "";
  const onLine = (text) => {
    if (text.trim() === "") return;
    const msg = JSON.parse(text);
    if (msg.type === "control_request") {
      const sub = msg.request.subtype;
      log({ kind: "request", requestId: msg.request_id, subtype: sub });
      if (m !== null && m.sub === sub && m.how === "drop") return;
      if (m !== null && m.sub === sub && m.how === "late") {
        setTimeout(() => out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: answers[sub] } }), m.ms ?? 2000);
        return;
      }
      if (m !== null && m.sub === sub && m.how === "error") { out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `Unsupported control request subtype: ${sub}` } }); answered += 1; return; }
      if (config.early && sub === "get_hooks_listing") {
        // The result arrives first, in the same write as the last answer, so the runner ends the input before it writes the prompt.
        process.stdout.write([...(config.noInit ? [] : [initEvent()]), { type: "result", subtype: "success", is_error: false, result: config.text, session_id: sessionId, permission_denials: [], usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 },
          { type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: answers[sub] } }].map((o) => `${JSON.stringify(o)}\n`).join(""));
        answered += 1;
        return;
      }
      if (!Object.hasOwn(answers, sub)) { out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `Unsupported control request subtype: ${sub}` } }); return; }
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: answers[sub] } });
      answered += 1;
      return;
    }
    if (msg.type === "user") {
      log({ kind: "user", answered, content: msg.message.content });
      out(initEvent());
      const split = first && typeof config.split === "string" ? config.split : null;
      const assistant = { type: "assistant", parent_tool_use_id: null, session_id: sessionId, message: { id: `msg-sentinel${split ?? ""}`, model: opt("--model"), role: "assistant", content: [{ type: "text", text: config.text }], usage: { input_tokens: 1, output_tokens: 1 } } };
      const rest = () => {
        out({ type: "result", subtype: "success", is_error: false, result: config.text, session_id: sessionId, permission_denials: [], usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
        if (first && config.tamper) tamper(config.tamper, policyFile);
      };
      if (split === null) { out(assistant); rest(); return; }
      // Cut inside the character's bytes: one byte past where it starts.
      const halves = (text) => { const b = Buffer.from(text, "utf-8"); const at = b.indexOf(Buffer.from(split, "utf-8")) + 1; return [b.subarray(0, at), b.subarray(at)]; };
      const [o1, o2] = halves(`${JSON.stringify(assistant)}\n`);
      const [e1, e2] = halves(`sentinel stderr ${split} end\n`);
      process.stdout.write(o1);
      process.stderr.write(e1);
      setTimeout(() => { process.stdout.write(o2); process.stderr.write(e2); rest(); }, 200);
    }
  };
  process.stdin.on("data", (c) => {
    pending += c.toString("utf-8");
    let nl = pending.indexOf("\n");
    while (nl !== -1) { onLine(pending.slice(0, nl)); pending = pending.slice(nl + 1); nl = pending.indexOf("\n"); }
  });
  process.stdin.on("end", () => { server.then(() => { log({ kind: "end" }); process.exit(0); }); });
}

module.exports = { goodResponses, main };
