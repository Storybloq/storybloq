// ISS-1348: a fake `codex` for the judge runner tests. The test writes a wrapper named `codex` that runs
// `node fake-codex.mjs --fake-root <dir> --fake-wrapper <wrapper> <codex argv...>`, so the runner's scrubbed
// environment never has to carry the fake's own settings. Every invocation appends one line to <root>/log.jsonl
// (argv, cwd, environment, config.toml, and for exec the sha256 and length of every stdin byte read); the
// scenario is <root>/scenario.json. No real auth is read or needed.
// ISS-1349: it answers `--version` (scenario.version), scenario.fail = { call, exit, stderr } makes one named
// preflight call fail, and scenario.retargetOnFeatures = { link, to } replaces (or, with no `to`, removes) a
// symlink during the features-list call; scenario.versionStderr is written by a `--version` that still exits 0. Each log line also names the launcher that ran and the entries of
// CODEX_HOME (names only).
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const raw = process.argv.slice(2);
const root = raw[1];
const wrapper = raw[3];
const argv = raw.slice(4);
const scenario = existsSync(join(root, "scenario.json")) ? JSON.parse(readFileSync(join(root, "scenario.json"), "utf-8")) : {};
const codexHome = process.env.CODEX_HOME ?? "";
const configPath = join(codexHome, "config.toml");
const config = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
const cwdEntries = readdirSync(process.cwd());
const homeEntries = existsSync(codexHome) ? readdirSync(codexHome).sort() : [];
const log = (entry) => appendFileSync(join(root, "log.jsonl"), `${JSON.stringify({ ...entry, argv, wrapper, cwd: process.cwd(), cwdEntries, homeEntries, env: process.env, config })}\n`);
const failFor = (call) => {
  if (scenario.fail?.call !== call) return;
  process.stderr.write(scenario.fail.stderr ?? "");
  process.exit(scenario.fail.exit ?? 1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);

if (argv[0] === "--version") {
  log({ kind: "version" });
  failFor("version");
  if (scenario.versionStderr) process.stderr.write(scenario.versionStderr);
  process.stdout.write(`${scenario.version ?? "codex-cli 0.153.4"}\n`);
  process.exit(0);
}

if (argv[0] === "debug" && argv[1] === "prompt-input") {
  const invalid = argv.includes('web_search="storybloq-invalid"');
  log({ kind: "probe", invalid });
  failFor(invalid ? "invalid-web-search" : "config-as-written");
  const probe = scenario.probe ?? "default";
  const reject = () => {
    process.stderr.write("Error: unknown variant `storybloq-invalid`, expected one of `disabled`, `cached`, `indexed`, `live`\nin `web_search`\n");
    process.exit(1);
  };
  if (invalid) {
    if (probe === "accept-invalid") { process.stdout.write("prompt\n"); process.exit(0); }
    reject();
  }
  if (probe === "reject-config") { process.stderr.write("Error: the config does not load\n"); process.exit(1); }
  process.stdout.write("prompt\n");
  process.exit(0);
}

if (argv[0] === "features" && argv[1] === "list") {
  log({ kind: "features" });
  failFor("features-list");
  if (scenario.retargetOnFeatures) {
    rmSync(scenario.retargetOnFeatures.link);
    if (scenario.retargetOnFeatures.to) symlinkSync(scenario.retargetOnFeatures.to, scenario.retargetOnFeatures.link);
  }
  if (scenario.probe === "chmod-after-preflight") chmodSync(wrapper, 0o644);
  if (scenario.touchOnFeatures) appendFileSync(scenario.touchOnFeatures, " ");
  // The pinned 0.153.4 output for the lockdown config, abridged: unified_exec and
  // tool_search_always_defer_mcp_tools stay effective true, and two names carry the stage "removed" (ISS-1350).
  const removed = ["tool_search_always_defer_mcp_tools", "unified_exec_zsh_fork"];
  for (const [name, on] of [["apps", false], ["browser_use", false], ["browser_use_external", false], ["browser_use_full_cdp_access", false], ["code_mode_host", false], ["computer_use", false], ["hooks", false], ["image_generation", false], ["in_app_browser", false], ["multi_agent", false], ["plugins", false], ["shell_tool", false], ["skill_search", false], ["sleep_tool", false], ["tool_search_always_defer_mcp_tools", true], ["tool_suggest", false], ["unified_exec", true], ["unified_exec_zsh_fork", false], ["view_image", false]]) {
    process.stdout.write(`${name.padEnd(41)}${(removed.includes(name) ? "removed" : "stable").padEnd(19)}${on}\n`);
  }
  process.exit(0);
}

if (argv[0] !== "exec") { log({ kind: "other" }); process.exit(64); }

const hash = createHash("sha256");
let stdinBytes = 0;
let stdinText = "";
if (scenario.readStdin !== false) {
  // Decoded once, after the last chunk: a character split across two chunks stays whole.
  const chunks = [];
  for await (const chunk of process.stdin) { hash.update(chunk); stdinBytes += chunk.length; chunks.push(chunk); }
  stdinText = Buffer.concat(chunks).toString("utf-8");
}
const n = existsSync(join(root, "log.jsonl")) ? readFileSync(join(root, "log.jsonl"), "utf-8").split("\n").filter(Boolean).length : 0;
writeFileSync(join(root, `stdin-${n}.txt`), stdinText);
log({ kind: "exec", stdinSha256: scenario.readStdin === false ? null : hash.digest("hex"), stdinBytes });
if (scenario.readStdin === false) process.exit(scenario.exitCode ?? 0);

const thread = scenario.threadId ?? "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });
if (scenario.floodBytes) {
  const line = `${JSON.stringify({ type: "item.completed", item: { id: "flood", type: "reasoning", text: "x".repeat(1000) } })}\n`;
  for (let sent = 0; sent < scenario.floodBytes; sent += line.length) {
    if (!process.stdout.write(line)) await new Promise((r) => process.stdout.once("drain", r));
  }
}
out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Reading the evidence." } });
// What the real binary would let a model do without the lockdown: a config that leaves the shell or web search on shows up as a tool item.
if (config === null || !config.includes("shell_tool = false")) out({ type: "item.completed", item: { id: "item_shell", type: "command_execution", command: "true", aggregated_output: "", exit_code: 0, status: "completed" } });
if (config === null || !config.includes('web_search = "disabled"')) out({ type: "item.completed", item: { id: "item_web", type: "web_search", query: "x" } });
if (scenario.malformedLine) process.stdout.write(`${scenario.malformedLine}\n`);
if (scenario.toolItem) out({ type: "item.completed", item: { id: "item_1", type: scenario.toolItem, command: "cat ~/.codex/auth.json", aggregated_output: "", exit_code: 0, status: "completed" } });
if (scenario.rewriteRecord) appendFileSync(scenario.rewriteRecord, "\n");
if (scenario.deleteFile) rmSync(scenario.deleteFile);
for (const file of [scenario.replaceFile ?? []].flat()) writeFileSync(file, "{");
if (scenario.chmodDir) chmodSync(scenario.chmodDir, 0o555);
// An ephemeral session writes no rollout, so the runner has no observed model.
if (scenario.models !== null && !argv.includes("--ephemeral")) {
  const dir = join(codexHome, "sessions", "2026", "10", "01");
  mkdirSync(dir, { recursive: true });
  const lines = [{ type: "session_meta", payload: { id: thread } }, ...(scenario.models ?? ["gpt-6-astra"]).map((model) => ({ type: "turn_context", payload: { model } }))];
  writeFileSync(join(dir, `rollout-2026-10-01T00-00-00-${thread}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}
if (scenario.sleepMs) await sleep(scenario.sleepMs);
if (scenario.selfSignal) process.kill(process.pid, scenario.selfSignal);
const finalText = scenario.finalText ?? (existsSync(join(root, "response.txt")) ? readFileSync(join(root, "response.txt"), "utf-8") : "{}");
if (scenario.terminal !== "turn.failed") out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: finalText } });
if (scenario.terminal === "turn.failed") out({ type: "turn.failed", error: { message: "the model stream ended" } });
else if (scenario.terminal !== null) out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
process.exitCode = scenario.exitCode ?? 0;
