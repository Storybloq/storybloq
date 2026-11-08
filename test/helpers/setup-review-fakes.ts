/**
 * T-536: fake `codex` and `claude` binaries for the setup reviewer tests.
 *
 * Each fake is a small node script placed in a scratch bin directory beside a
 * link to this node, and that directory is the whole PATH: node's own
 * directory and the system bin directories are never on it, so a reviewer the
 * test omits cannot be found anywhere. A fake's
 * behaviour comes from FAKE_<NAME>_MODE in its environment, and every review
 * invocation appends one line to FAKE_LOG, so a test can count how many
 * backends actually started.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeMode = "approve" | "revise" | "timeout" | "invalid" | "exit1" | "slow" | "no-output" | "tamper" | "wrapper" | "escape" | "fatal";

/**
 * ISS-1456: how the fake codex answers the start probe (FAKE_CODEX_PROBE), each
 * one a behaviour codex 0.163.0 was seen to have or a way evidence can mislead.
 */
export type FakeProbeMode =
  | "reach" | "fatal" | "noise-then-fatal" | "netwait" | "badflag" | "silent" | "hang" | "nononce" | "wrongroute" | "flaky" | "reach-twice"
  | "orphan" | "late-then-stubborn" | "slow-reach";

const FAKE_SOURCE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const name = __FAKE_NAME__;
const args = process.argv.slice(2);
if (process.env.FAKE_SPAWN_LOG) fs.appendFileSync(process.env.FAKE_SPAWN_LOG, JSON.stringify({ name, args }) + "\n");
// ISS-1457: what codex 0.163.0 loads, modelled: config.toml unless --ignore-user-config, hooks.json unless
// --disable hooks. Whatever they name after "touch" is created, as a planted MCP server or hook would.
if (name === "codex" && !args.includes("--version") && !args.includes("--help") && args[0] !== "features") {
  const path = require("node:path");
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex");
  const disabled = args.filter((_, i) => args[i - 1] === "--disable");
  const load = (file, off) => {
    if (off) return;
    let text = "";
    try { text = fs.readFileSync(path.join(home, file), "utf-8"); } catch { return; }
    for (const m of text.matchAll(/touch ([^;"\s]+)/g)) fs.writeFileSync(m[1], "");
  };
  load("config.toml", args.includes("--ignore-user-config"));
  load("hooks.json", disabled.includes("hooks"));
}
const providerArg = args.find((a) => a.startsWith("model_providers.storybloq_probe="));
if (providerArg) {
  const base = /base_url = "([^"]+)"/.exec(providerArg)[1];
  const nonce = /"X-Storybloq-Probe" = "([0-9a-f]+)"/.exec(providerArg)[1];
  let probe = process.env.FAKE_CODEX_PROBE || "reach";
  if (process.env.FAKE_PROBE_LOG) fs.appendFileSync(process.env.FAKE_PROBE_LOG, JSON.stringify({ cwd: process.cwd(), key: process.env.STORYBLOQ_PROBE_KEY ? "set" : null, pid: process.pid }) + "\n");
  if (probe === "flaky") {
    const count = process.env.FAKE_PROBE_LOG ? fs.readFileSync(process.env.FAKE_PROBE_LOG, "utf-8").split("\n").filter(Boolean).length : 1;
    probe = count === 1 ? "silent" : "reach";
  }
  const http = require("node:http");
  const post = (path, headers, done) => {
    const req = http.request(base.replace(/\/v1$/, "") + path, { method: "POST", headers }, (res) => { res.resume(); res.on("end", done); });
    req.on("error", done);
    req.end("{}");
  };
  const hang = () => setInterval(() => {}, 1000);
  const fatal = "Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)";
  switch (probe) {
    case "reach": post("/v1/responses", { "X-Storybloq-Probe": nonce }, hang); break;
    case "reach-twice": {
      const answered = (n) => { if (process.env.FAKE_RESP_LOG) fs.appendFileSync(process.env.FAKE_RESP_LOG, n + "\n"); };
      post("/v1/responses", { "X-Storybloq-Probe": nonce }, () => { answered(1); post("/v1/responses", { "X-Storybloq-Probe": nonce }, () => { answered(2); hang(); }); });
      break;
    }
    case "orphan": {
      // A child in this process group, its stdio closed, outlives the leader, which exits without a request.
      const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
      fs.appendFileSync(process.env.FAKE_ORPHAN_LOG, child.pid + "\n");
      child.unref();
      setTimeout(() => process.exit(1), 50);
      break;
    }
    case "slow-reach": setTimeout(() => post("/v1/responses", { "X-Storybloq-Probe": nonce }, hang), Number(process.env.FAKE_LATE_MS)); break;
    case "late-then-stubborn": {
      const count = fs.readFileSync(process.env.FAKE_PROBE_LOG, "utf-8").split("\n").filter(Boolean).length;
      if (count === 1) { setTimeout(() => process.exit(1), Number(process.env.FAKE_LATE_MS)); break; }
      process.on("SIGTERM", () => {});
      hang();
      break;
    }
    case "fatal": process.stderr.write(fatal + "\n"); process.exit(1); break;
    case "noise-then-fatal":
      process.stderr.write("mcp: server started, connection to http://127.0.0.1:1/v1 established\n");
      post("/v1/responses", {}, () => { process.stderr.write(fatal + "\n"); process.exit(1); });
      break;
    case "netwait": process.stderr.write("ERROR: Reconnecting... waiting for network\n"); hang(); break;
    case "badflag": process.stderr.write("error: unexpected argument '--ignore-user-config' found\n"); process.exit(2); break;
    case "silent": process.exit(0); break;
    case "hang": hang(); break;
    case "nononce": post("/v1/responses", {}, () => process.exit(1)); break;
    case "wrongroute": post("/v1/chat/completions", { "X-Storybloq-Probe": nonce }, () => process.exit(1)); break;
  }
  return;
}
if (args.includes("--version")) {
  const up = name.toUpperCase();
  if (process.env["FAKE_" + up + "_VERSION_FAIL"] === "1") process.exit(1);
  if (process.env["FAKE_" + up + "_VERSION_HANG"] === "1") {
    process.on("SIGTERM", () => {});
    if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  const answer = () => { process.stdout.write(name === "codex" ? (process.env.FAKE_CODEX_VERSION_RAW ?? "codex-cli " + (process.env.FAKE_CODEX_VERSION || "0.163.0") + "\n") : "9.9.9 (Claude Code)\n"); process.exit(0); };
  if (process.env["FAKE_" + up + "_VERSION_ESCAPE"] === "1") {
    // A child outside this process group holds the probe's stdout open.
    const child = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
    fs.writeFileSync(process.env.FAKE_PID_FILE, String(child.pid));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env["FAKE_" + up + "_VERSION_TERM_OK"] === "1") { process.on("SIGTERM", answer); setInterval(() => {}, 1000); return; }
  const slow = Number(process.env["FAKE_" + up + "_VERSION_SLOW_MS"] || 0);
  if (slow > 0) setTimeout(answer, slow); else answer();
  return;
}
if (name === "codex" && args[0] === "exec" && args.includes("--help")) {
  // The flags codex 0.163.0 lists; FAKE_CODEX_HELP_DROP removes one, FAKE_CODEX_HELP_FAIL fails the call.
  if (process.env.FAKE_CODEX_HELP_FAIL === "1") process.exit(1);
  // The option lines exactly as 0.163.0 prints them. FAKE_CODEX_HELP_NOSHORT strips one short form.
  const flags = ["      --disable <FEATURE>", "      --strict-config", "  -s, --sandbox <SANDBOX_MODE>", "      --skip-git-repo-check", "      --ephemeral",
    "      --ignore-user-config", "      --ignore-rules", "      --output-schema <FILE>", "  -o, --output-last-message <FILE>"];
  const drop = process.env.FAKE_CODEX_HELP_DROP;
  const noShort = process.env.FAKE_CODEX_HELP_NOSHORT;
  const shown = flags.filter((f) => !f.trim().replace(",", "").split(" ").includes(drop ?? "\0")).map((f) => (noShort && f.trim().startsWith(noShort + ", ") ? "      " + f.trim().slice(noShort.length + 2) : f));
  process.stdout.write("Usage: codex exec [OPTIONS] [PROMPT]\n" + shown.map((f) => f + "\n").join(""));
  process.exit(0);
}
if (name === "codex" && args[0] === "features" && args[1] === "list") {
  if (process.env.FAKE_CODEX_FEATURES_FAIL === "1") process.exit(1);
  const drop = process.env.FAKE_CODEX_FEATURES_DROP;
  const rows = ["apps", "hooks", "plugins", "plugin_hooks"].filter((f) => f !== drop);
  process.stdout.write(rows.map((f) => f.padEnd(41) + "stable             true\n").join(""));
  process.exit(0);
}
if (args.includes("--help")) {
  // FAKE_CLAUDE_OLD: a claude from before --permission-prompts existed.
  const flags = ["--output-format", "--json-schema", "--tools", "--strict-mcp-config", "--no-session-persistence"];
  if (process.env["FAKE_" + name.toUpperCase() + "_OLD"] !== "1") flags.push("--permission-prompts");
  process.stdout.write("Usage: " + name + " [options]\n" + flags.map((f) => "  " + f + "\n").join(""));
  process.exit(0);
}
const mode = process.env["FAKE_" + name.toUpperCase() + "_MODE"] || "approve";
const log = process.env.FAKE_LOG;
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks);
  if (log) fs.appendFileSync(log, JSON.stringify({ name, args, cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, claudeSession: Object.keys(process.env).filter((k) => k.startsWith("CLAUDE_CODE_")) }) + "\n");
  if (process.env.FAKE_STDIN_DIR) fs.writeFileSync(require("node:path").join(process.env.FAKE_STDIN_DIR, name + "-" + Date.now() + "-" + process.pid + ".stdin"), stdin);
  const review = { verdict: mode === "revise" ? "revise" : "approve", findings: mode === "revise" ? [{ severity: "major", requirement: "R3", description: "R3 is covered by no ticket and no coverage row" }] : [] };
  const finish = () => {
    if (mode === "exit1") { process.stderr.write("fake failure\n"); process.exit(1); }
    if (mode === "fatal") { process.stderr.write("Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)\n"); process.exit(1); }
    const body = mode === "invalid" ? JSON.stringify({ verdict: "maybe", findings: "none" }) : JSON.stringify(review);
    if (name === "codex") {
      // No -o, no file: a call without one must never write into whatever folder it runs in.
      const o = args.indexOf("-o");
      if (mode !== "no-output" && o >= 0 && args[o + 1]) fs.writeFileSync(args[o + 1], body);
    } else {
      const structured = JSON.parse(body);
      const answer = JSON.stringify({ type: "result", is_error: false, result: "", structured_output: structured, session_id: "fake-session" });
      // "big" and "huge" pad a valid answer with whitespace, which JSON allows, to 2 MiB and 17 MiB.
      const pad = mode === "big" ? 2 * 1024 * 1024 : mode === "huge" ? 17 * 1024 * 1024 : 0;
      if (pad > 0) { process.stdout.write(answer + " ".repeat(pad), () => process.exit(0)); return; }
      process.stdout.write(answer);
    }
    process.exit(0);
  };
  if (mode === "tamper") fs.appendFileSync("packet.md", "tampered while the reviewer ran\n");
  if (mode === "wrapper" || mode === "escape") {
    // A child that ignores SIGTERM and holds this process's stdout and stderr open;
    // in "escape" it also leaves the reviewer's process group, so no group signal reaches it.
    const child = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: ["ignore", "inherit", "inherit"], detached: mode === "escape" });
    fs.writeFileSync(process.env.FAKE_PID_FILE, String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "timeout") setTimeout(finish, 60000);
  else if (mode === "slow") setTimeout(finish, Number(process.env.FAKE_SLOW_MS || 1500));
  else finish();
});
`;

export interface FakeBin {
  readonly dir: string;
  readonly log: string;
  readonly stdinDir: string;
  /** PATH: the scratch bin alone, holding the fakes that exist and a link to node. */
  readonly path: string;
  invocations(): Array<{ name: string; args: string[]; cwd: string; claudecode: string | null; claudeSession: string[] }>;
  stdins(): Buffer[];
}

/**
 * ISS-1392: every scratch directory these tests make is recorded here, so a run
 * leaves nothing behind in the OS tmpdir. The registry is plain module state
 * rather than a vitest hook, because the worker fixtures import this file for
 * REVIEW_PACKET under plain node, where vitest cannot load.
 */
const live: string[] = [];
const created: string[] = [];

/** A fresh directory under the OS tmpdir, removed by the next `removeScratchDirs()`. */
export function makeScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  live.push(dir);
  created.push(dir);
  return dir;
}

/**
 * Removes every directory made since the last call. A test that runs reviewer
 * processes awaits their exit first, so nothing writes into a directory while
 * it goes; the retries cover a process that has exited but not yet released it.
 */
export function removeScratchDirs(): void {
  for (const dir of live.splice(0)) {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* the absence check reports it */ }
  }
}

/** Every directory made in this process, for a file's closing absence check. */
export function scratchDirsCreated(): readonly string[] {
  return [...created];
}

export function makeFakeBin(names: ReadonlyArray<"codex" | "claude">): FakeBin {
  const root = makeScratchDir("sr-fakes-");
  const dir = join(root, "bin");
  const stdinDir = join(root, "stdin");
  mkdirSync(dir);
  mkdirSync(stdinDir);
  symlinkSync(process.execPath, join(dir, "node"));
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, FAKE_SOURCE.replace("__FAKE_NAME__", JSON.stringify(name)));
    chmodSync(file, 0o755);
  }
  const log = join(root, "log.jsonl");
  return {
    dir,
    log,
    stdinDir,
    path: dir,
    invocations() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    stdins() {
      return readdirSync(stdinDir).sort().map((f) => readFileSync(join(stdinDir, f)));
    },
  };
}

export const REVIEW_PACKET = [
  "## Source requirements",
  "R1: A signed-in member can book a court for a one-hour slot (source: brief.md, Booking)",
  "R2: A member can cancel a booking up to two hours before it starts (source: brief.md, Cancellation)",
  "R3: Club staff can block courts for maintenance (source: brief.md, Staff tools)",
  "",
  "## Owner answers and decisions",
  "D1: Who can sign in? -> Members only, by email link",
  "",
  "## Existing-state evidence",
  "none",
  "",
  "## Plan",
  "Milestone 1: members can book and cancel",
  "",
  "Ticket: Book a court",
  "Outcome: a member books a one-hour slot, from brief.md Booking",
  "Scope: booking form and availability. Excludes: payments",
  "Acceptance: a booked slot shows as taken for other members",
  "Behaviour: a taken slot cannot be booked; an empty day shows all slots free",
  "Verification: an end-to-end test books a slot. Prerequisites: none. Assumptions: none",
  "Blocked by: none",
  "",
  "Ticket: Cancel a booking",
  "Outcome: a member cancels up to two hours before, from brief.md Cancellation",
  "Scope: cancel action. Excludes: refunds",
  "Acceptance: a cancelled slot is free again",
  "Behaviour: a cancel inside two hours is refused with a message",
  "Verification: a test cancels at three hours and at one hour. Prerequisites: none. Assumptions: none",
  "Blocked by: Book a court",
  "",
  "Coverage map:",
  "R1 -> Book a court",
  "R2 -> Cancel a booking",
  "",
].join("\n");
