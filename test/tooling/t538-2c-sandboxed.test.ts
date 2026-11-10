/**
 * T-538 commit 2c, plan 5.7: every harness command on the project runs under the sandbox wrapper with the five
 * roots, in its own group, under one deadline, with its streams capped. The stand-in wrapper is the test
 * fixture's; the rows that need the real `codex sandbox` are opt-in (STORYBLOQ_REAL_CODEX=1 with
 * STORYBLOQ_REAL_CODEX_BIN), skipped without it and failing when it is asked for and missing.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOXED_STREAM_BYTES, sandboxedRun, sandboxSettings } from "../../scripts/onboarding-eval-host.js";
import { shellWords } from "../../scripts/onboarding-eval-run.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = process.env.STORYBLOQ_REAL_CODEX === "1";
const CODEX = process.env.STORYBLOQ_REAL_CODEX_BIN ?? "";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "t538sbx-"))); dirs.push(d); return d; };

/** A stand-in `codex`: logs its argv, then runs the command after `--` as the test fixture's wrapper does. */
function standIn(dir: string): { bin: string; argvLog: string } {
  const bin = join(dir, "codex");
  const argvLog = join(dir, "argv.json");
  writeFileSync(bin, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\nrequire(${JSON.stringify(join(PKG, "test", "fixtures", "t538-server-start.cjs"))}).sandboxStandIn(process.argv.slice(2));\n`);
  chmodSync(bin, 0o755);
  return { bin, argvLog };
}

function layout(): { work: string; project: string; roots: string[]; env: NodeJS.ProcessEnv } {
  const work = scratch();
  const project = join(work, "project");
  const tmp = join(work, "tmp");
  for (const d of [join(project, ".git"), tmp, join(work, "runner-home")]) mkdirSync(d, { recursive: true });
  const roots = [project, join(project, ".git"), tmp];
  return { work, project, roots, env: { PATH: "/usr/bin:/bin", HOME: join(tmp, "harness-home"), TMPDIR: tmp, LANG: "C", CODEX_HOME: join(work, "runner-home") } };
}

describe("the harness's sandboxed command (5.7)", () => {
  it("runs `codex sandbox <the 5.2 settings> -- /bin/sh -c <command>` in the project, with only the given environment", async () => {
    const l = layout();
    const { bin, argvLog } = standIn(l.work);
    const r = await sandboxedRun({ codexBin: bin, roots: l.roots, cwd: l.project, command: 'pwd; printf "%s|%s\\n" "$CODEX_HOME" "${CLAUDE_CODE_OAUTH_TOKEN-unset}"', deadlineMs: 20_000, env: l.env });
    expect(r).toMatchObject({ status: 0, signal: null, timedOut: false, truncated: false, spawnError: null, cleanup: "confirmed" });
    expect(r.stdout).toBe(`${l.project}\n${join(l.work, "runner-home")}|unset\n`);
    expect(JSON.parse(readFileSync(argvLog, "utf-8"))).toEqual(["sandbox", ...sandboxSettings(l.roots).flatMap((s) => ["-c", s]), "--", "/bin/sh", "-c", expect.stringContaining("pwd")]);
  });

  it("a demo that never exits is stopped at the deadline: no exit status, timed out, its group confirmed gone", async () => {
    const l = layout();
    const { bin } = standIn(l.work);
    const started = Date.now();
    const r = await sandboxedRun({ codexBin: bin, roots: l.roots, cwd: l.project, command: "echo started; sleep 600 & wait", deadlineMs: 1500, graceMs: 500, env: l.env });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r).toMatchObject({ status: null, timedOut: true, cleanup: "confirmed" });
    expect(r.stdout).toBe("started\n");
  }, 30_000);

  it("each stream is kept to its cap and the cut is named", async () => {
    const l = layout();
    const { bin } = standIn(l.work);
    const r = await sandboxedRun({ codexBin: bin, roots: l.roots, cwd: l.project, command: `head -c ${SANDBOXED_STREAM_BYTES + 4096} /dev/zero; echo err >&2`, deadlineMs: 20_000, env: l.env });
    expect(r.status).toBe(0);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout, "utf-8")).toBe(SANDBOXED_STREAM_BYTES);
    expect(r.stderr).toBe("err\n");
  });

  it("refuses a codex executable that is not an absolute path", async () => {
    const l = layout();
    await expect(sandboxedRun({ codexBin: "codex", roots: l.roots, cwd: l.project, command: "true", deadlineMs: 1000, env: l.env })).rejects.toThrow("is not an absolute path");
  });

  it("shell words survive quotes, spaces and dollars as single arguments", async () => {
    const l = layout();
    const { bin } = standIn(l.work);
    const words = ["printf", "%s\\n", "it's", "a b", "$HOME", "`x`"];
    const r = await sandboxedRun({ codexBin: bin, roots: l.roots, cwd: l.project, command: shellWords(words), deadlineMs: 20_000, env: l.env });
    expect(r.stdout).toBe("it's\na b\n$HOME\n`x`\n");
  });
});

describe("no harness process runs in the project but through the wrapper (5.7)", () => {
  it("every launch in the evaluation scripts that names the project as its folder is one of the known ones", () => {
    const hits: string[] = [];
    for (const f of readdirSync(join(PKG, "scripts")).filter((n) => /^onboarding-eval-.*\.ts$/.test(n)).sort()) {
      for (const line of readFileSync(join(PKG, "scripts", f), "utf-8").split("\n")) {
        if (/cwd:\s*(?:project|ctx\.project|o\.cwd)\b/.test(line)) hits.push(`${f}: ${line.trim().slice(0, 60)}`);
      }
    }
    expect(hits).toEqual([
      // sandboxedRun: the wrapper itself.
      "onboarding-eval-host.ts: cwd: o.cwd, env: o.env, timeoutMs: o.deadlineMs, killGraceMs",
      // The served review command (5.5): the host runs this checkout's CLI by design, with its own environment.
      "onboarding-eval-run.ts: command: process.execPath, args: [cli, \"setup-review\", ...ar",
      // The model's own turn.
      "onboarding-eval-run.ts: command: bin, args, cwd: ctx.project, env: ctx.env, timeoutM",
      // harnessCli, the demo and the bypass: through sandboxedRun.
      "onboarding-eval-run.ts: const inSandbox = async (command: string): Promise<Sandboxed",
    ]);
  });
});

const REAL_SKIP = REAL ? "" : " [skipped: set STORYBLOQ_REAL_CODEX=1 and STORYBLOQ_REAL_CODEX_BIN=<codex executable> to run]";

describe("the real codex wrapper holds the harness's command (5.7)", () => {
  it.skipIf(!REAL)(`a command that writes outside the roots and connects out is denied both, and what it printed is still recorded${REAL_SKIP}`, async () => {
    expect(existsSync(CODEX), `STORYBLOQ_REAL_CODEX_BIN=${CODEX}`).toBe(true);
    const l = layout();
    const outside = join(l.work, "outside");
    mkdirSync(outside);
    const rota = join(l.project, "rota.js");
    writeFileSync(rota, [
      'const fs = require("node:fs");',
      'console.log("rota: Mon Robin");',
      `try { fs.writeFileSync(${JSON.stringify(join(outside, "planted"))}, "x"); console.log("write: allowed"); } catch (e) { console.log("write: " + e.code); }`,
      'const s = require("node:net").connect(443, "1.1.1.1");',
      's.setTimeout(4000, () => { console.log("net: timeout"); s.destroy(); });',
      's.on("connect", () => { console.log("net: connected"); s.destroy(); });',
      's.on("error", (e) => console.log("net: " + e.code));',
    ].join("\n"));
    const r = await sandboxedRun({ codexBin: realpathSync(CODEX), roots: l.roots, cwd: l.project, command: shellWords([process.execPath, rota]), deadlineMs: 30_000, env: l.env });
    // F14: the process completed (status 0, not stopped at the deadline) and the connect was refused by the sandbox;
    // a timeout or any other error fails the row.
    expect(r.timedOut).toBe(false);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("rota: Mon Robin\n");
    expect(r.stdout).toMatch(/write: E(?:PERM|ACCES)/);
    expect(r.stdout).toMatch(/^net: E(?:PERM|ACCES)$/m);
    expect(existsSync(join(outside, "planted"))).toBe(false);
  }, 60_000);
});
