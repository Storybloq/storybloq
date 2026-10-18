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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeMode = "approve" | "revise" | "timeout" | "invalid" | "exit1" | "slow" | "no-output" | "tamper" | "wrapper" | "escape";

const FAKE_SOURCE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const name = __FAKE_NAME__;
const args = process.argv.slice(2);
if (args.includes("--version")) {
  const up = name.toUpperCase();
  if (process.env["FAKE_" + up + "_VERSION_FAIL"] === "1") process.exit(1);
  if (process.env["FAKE_" + up + "_VERSION_HANG"] === "1") {
    process.on("SIGTERM", () => {});
    if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  const answer = () => { process.stdout.write(name === "codex" ? "codex-cli 9.9.9\n" : "9.9.9 (Claude Code)\n"); process.exit(0); };
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
    const body = mode === "invalid" ? JSON.stringify({ verdict: "maybe", findings: "none" }) : JSON.stringify(review);
    if (name === "codex") {
      const out = args[args.indexOf("-o") + 1];
      if (mode !== "no-output") fs.writeFileSync(out, body);
    } else {
      const structured = JSON.parse(body);
      process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: structured, session_id: "fake-session" }));
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

export function makeFakeBin(names: ReadonlyArray<"codex" | "claude">): FakeBin {
  const root = mkdtempSync(join(tmpdir(), "sr-fakes-"));
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
