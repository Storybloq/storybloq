/**
 * T-538 S5b, plan line 806: no host bypass at any commit. A sentinel client on
 * PATH, the runner's real entry, every variant and argv form. The sentinel
 * records every argv it is started with; the flag never reaches it on the host.
 * These assertions stay unchanged through the commit that adds the container route.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(PKG, "node_modules", "tsx", "dist", "cli.mjs");
const RUNNER = join(PKG, "scripts", "onboarding-eval-run.ts");
const BYPASS = ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto"] as const;

const SENTINEL = `
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.SENTINEL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const lines = [{ type: "thread.started", thread_id: "th-sentinel" }, { type: "item.completed", item: { type: "agent_message", text: process.env.SENTINEL_TEXT } }, { type: "turn.completed", usage: {} }];
process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
`;

/** A setup package, so the runner goes on past the opening to its resumed turns. */
const PACKAGE = "Here is the package.\nPlan, revision 0123456789ab:\nTicket: Sign in\nEnd of plan, revision 0123456789ab\n- Approve setup\n- Adjust the plan\n- Inspect details";

interface Run { readonly status: number | null; readonly output: string; readonly argvs: readonly string[][] }

function runHost(extra: readonly string[]): Run {
  // A short name: tsx's IPC pipe lives under TMPDIR and a long one truncates that socket path.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538h-")));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), `#!${process.execPath}\n${SENTINEL}`, { mode: 0o755 });
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "{}\n");
    const home = join(dir, "home");
    mkdirSync(home);
    const log = join(dir, "sentinel.log");
    const env: NodeJS.ProcessEnv = { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: home, TMPDIR: dir, CODEX_HOME: codexHome, SENTINEL_LOG: log, SENTINEL_TEXT: PACKAGE };
    const r = spawnSync(process.execPath, [TSX, RUNNER, "--client", "codex", "--out", join(dir, "out"), "--raw-out", join(dir, "raw"), ...extra], { cwd: PKG, env, encoding: "utf-8", timeout: 280_000 });
    const argvs = existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
    return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, argvs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The options of an argv: what follows the terminator is the prompt, which may quote anything. */
const optionsOf = (argv: readonly string[]): readonly string[] => { const end = argv.indexOf("--"); return end === -1 ? argv : argv.slice(0, end); };
const carrying = (r: Run): string[][] => r.argvs.filter((a) => optionsOf(a).some((x) => (BYPASS as readonly string[]).includes(x)));
const turns = (r: Run): string[][] => r.argvs.filter((a) => a[0] === "exec");

describe("no host run hands the client its bypass flag", () => {
  it.each([
    ["none", "empty-idea", []],
    ["reviewer-unavailable", "empty-idea", []],
    ["approval-boundary", "brief-only", []],
    ["interrupted", "empty-idea", ["--fault", "step:handover"]],
    ["interrupted-edited", "empty-idea", ["--fault", "step:handover"]],
    ["milestone-demo", "checkpoint-demo", []],
    ["empty-idea-verify", "empty-idea", []],
    ["restart", "empty-idea", []],
  ] as const)("variant %s", (variant, fixture, more) => {
    const r = runHost(["--fixture", fixture, "--variant", variant, ...more]);
    expect(turns(r).length, r.output).toBeGreaterThan(0);
    expect(carrying(r)).toEqual([]);
  }, 300_000);

  it("the first turn and a resumed turn are both seen, and neither carries it", () => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "none"]);
    expect(turns(r).some((a) => a[1] !== "resume"), r.output).toBe(true);
    expect(turns(r).some((a) => a[1] === "resume"), r.output).toBe(true);
    expect(carrying(r)).toEqual([]);
  }, 300_000);

  it.each(BYPASS)("%s on the runner's own command line does not reach the client", (flag) => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "none", flag]);
    expect(carrying(r)).toEqual([]);
  }, 300_000);

  it.each([...BYPASS, "--sandbox=danger-full-access"])("%s smuggled in as the model is refused before any turn starts", (flag) => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "none", "--model", flag]);
    expect(turns(r)).toEqual([]);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toMatch(/the turn's sandbox does not hold/);
  }, 300_000);

  it("the degraded variant stays refused for this client, so it starts nothing", () => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "degraded"]);
    expect(r.status).not.toBe(0);
    expect(r.argvs).toEqual([]);
  }, 300_000);
});

describe("what every host turn carries instead", () => {
  it("the same write policy on the first and the resumed form, naming the attempt's own folders", () => {
    const r = runHost(["--fixture", "empty-idea", "--variant", "none"]);
    expect(turns(r).length, r.output).toBeGreaterThan(1);
    for (const a of turns(r)) {
      expect(a).toContain('sandbox_mode="workspace-write"');
      const roots = JSON.parse(a.find((x) => x.startsWith("sandbox_workspace_write.writable_roots="))!.split("=").slice(1).join("=")) as string[];
      expect(roots.length).toBe(6);
      expect(roots.some((p) => p.endsWith("/tmp"))).toBe(true);
      expect(roots.some((p) => p.endsWith("/.git"))).toBe(true);
    }
  }, 300_000);
});
