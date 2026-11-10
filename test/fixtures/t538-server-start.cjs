// T-538 commit 2a: what the stand-in clients do with the tool server they are configured with, as a real
// client would: start the configured launch with the delivered environment, initialize it over stdio, then
// stop it and wait for it to exit (the runner's leftover check runs after the turn). Also the stand-in for the
// `codex sandbox` wrapper when the real one is not used: it runs the command after `--` with the server's
// outside probe pointed at a folder it cannot write, so the probe reads as held. That is a stand-in, never a
// sandbox; the rows that need the real wrapper use the real `codex`.
"use strict";
const { spawn } = require("node:child_process");
const { chmodSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");

/** The `[mcp_servers.storybloq]` command and args of a Codex config.toml this runner wrote. */
function codexLaunchFromConfig(configFile) {
  const text = readFileSync(configFile, "utf-8");
  const at = text.indexOf("[mcp_servers.storybloq]\n");
  if (at === -1) return null;
  const table = text.slice(at).split("\n[")[0];
  const command = /^command = (".*")$/m.exec(table);
  const args = /^args = (\[.*\])$/m.exec(table);
  if (command === null || args === null) return null;
  return { command: JSON.parse(command[1]), args: JSON.parse(args[1]) };
}

/** The server environment a Codex turn delivers: every `-c mcp_servers.storybloq.env.<KEY>=<json>`. */
function codexServerEnv(argv) {
  const env = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-c") continue;
    const m = /^mcp_servers\.storybloq\.env\.([A-Z0-9_]+)=(.*)$/.exec(argv[i + 1] || "");
    if (m) env[m[1]] = JSON.parse(m[2]);
  }
  return env;
}

/** Starts the launch, sends initialize, and resolves once the server answered (or exited) and has exited. */
function startServer(launch, env, cwd, timeoutMs = 60000) {
  return new Promise((done) => {
    const child = spawn(launch.command, launch.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let answered = false;
    let err = "";
    const finish = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.on("data", (c) => {
      out += c.toString("utf-8");
      if (!answered && out.includes('"id":1')) { answered = true; finish(); }
    });
    child.stderr.on("data", (c) => { err += c.toString("utf-8"); });
    child.on("error", (e) => { clearTimeout(timer); done({ answered: false, exit: null, signal: null, stderr: String(e) }); });
    child.on("exit", (code, signal) => { clearTimeout(timer); done({ answered, exit: code, signal, stderr: err }); });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t538-stand-in", version: "1" } } }) + "\n");
  });
}

/** `codex sandbox ... -- cmd args`: runs cmd with the outside probe on a folder it cannot write; exits as cmd did. */
function sandboxStandIn(argv) {
  const end = argv.indexOf("--");
  const cmd = argv.slice(end + 1);
  const locked = mkdtempSync(join(process.env.TMPDIR || "/tmp", "locked-"));
  chmodSync(locked, 0o555);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, STORYBLOQ_EVAL_OUTSIDE: locked } });
  const relay = (s) => { if (child.exitCode === null) child.kill(s); };
  process.on("SIGTERM", () => relay("SIGTERM"));
  process.on("SIGINT", () => relay("SIGINT"));
  child.on("exit", (code, signal) => {
    chmodSync(locked, 0o755);
    rmSync(locked, { recursive: true, force: true });
    process.exit(code === null ? 128 + (require("node:os").constants.signals[signal] || 0) : code);
  });
}

module.exports = { codexLaunchFromConfig, codexServerEnv, startServer, sandboxStandIn };
