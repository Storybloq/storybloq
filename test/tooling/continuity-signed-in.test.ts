/**
 * T-525 Addendum E1 and E4, and the live guard: the signed-in mode's environment contract and the pinned
 * storybloq launcher, model-free. The launcher rows run the real CLI bundle under a planted "real HOME"
 * and assert nothing lands there.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIGNED_IN_MISSING_GATES, SIGNED_IN_RULING, signedInClientEnv, signedInEnvProblems, signedInSpawnRefusal, storybloqLauncherText, writeStorybloqLauncher,
} from "../../scripts/continuity-signed-in.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(PKG, "dist", "cli.js");

describe("E1 the environment contract", () => {
  it.each([
    ["CLAUDE_CODE_OAUTH_TOKEN"], ["ANTHROPIC_API_KEY"], ["ANTHROPIC_AUTH_TOKEN"], ["OPENAI_API_KEY"], ["SOME_OAUTH_THING"], ["CLAUDE_CONFIG_DIR"],
  ])("%s present refuses, by name only", (k) => {
    const value = "a-value-that-must-never-print-0123456789";
    const problems = signedInEnvProblems({ PATH: "/usr/bin", [k]: value });
    expect(problems).toContain(k);
    expect(problems.join(" ")).not.toContain(value);
  });
  it("a clean environment passes", () => {
    expect(signedInEnvProblems({ PATH: "/usr/bin", HOME: "/h", LANG: "C" })).toEqual([]);
  });
  it("the client gets exactly the table: the real HOME from the passwd entry, no config dir, no token, the launcher first", () => {
    const env = signedInClientEnv({ PATH: "/usr/bin:/bin", HOME: "/scratch/home", CLAUDE_CODE_OAUTH_TOKEN: "t", LANG: "C" }, { work: "/w", tmp: "/t", launcherBin: "/l/bin", shimBin: "/s" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "NO_UPDATE_NOTIFIER", "PATH", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_PROJECT_ROOT", "TMPDIR"]);
    expect(env.HOME).toBe(userInfo().homedir);
    expect(env.PATH).toBe("/l/bin:/s:/usr/bin:/bin");
    expect(env.STORYBLOQ_GLOBAL_DIR).toBe("/t/storybloq-global");
  });
});

describe("the live guard", () => {
  it("without --live-ack the launch is refused, naming the ack and the ruling", () => {
    expect(signedInSpawnRefusal(undefined)).toMatch(/--live-ack/);
    expect(signedInSpawnRefusal(undefined)).toContain(SIGNED_IN_RULING);
  });
  it("with the ack it is still refused, naming every missing gate", () => {
    const r = signedInSpawnRefusal(SIGNED_IN_RULING);
    for (const g of SIGNED_IN_MISSING_GATES) expect(r).toContain(g);
  });
});

describe("E4 the pinned storybloq launcher", () => {
  let root: string;
  let fakeReal: string;
  let scratch: string;
  let launcher: string;
  const snap = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (rel: string): void => {
      const p = join(dir, rel);
      if (!existsSync(p)) return;
      const st = statSync(p);
      out.push(`${rel}:${st.isDirectory() ? "d" : st.size}`);
      if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(rel ? `${rel}/${n}` : n);
    };
    walk("");
    return out;
  };
  const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    // The caller's own env carries the fake real HOME: the launcher must not pass it on.
    const r = spawnSync(launcher, args, { cwd: join(root, "work"), encoding: "utf-8", env: { PATH: "/usr/bin:/bin", HOME: fakeReal }, timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const version = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")).version as string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "e4-"));
    for (const d of ["real", "scratch", "codex", "tmp", "work", "bin", "stub", "npmroot/@storybloq"]) mkdirSync(join(root, d), { recursive: true });
    // Test-only: a stub npm whose global root holds this package, so skill refresh treats this build as the
    // owner (ISS-1493) without touching the machine's global install.
    symlinkSync(PKG, join(root, "npmroot", "@storybloq", "storybloq"));
    writeFileSync(join(root, "stub", "npm"), `#!/bin/sh\necho '${join(root, "npmroot")}'\n`, { mode: 0o755 });
    fakeReal = join(root, "real");
    scratch = join(root, "scratch");
    mkdirSync(join(fakeReal, ".claude"), { recursive: true });
    writeFileSync(join(fakeReal, ".claude", "settings.json"), "{}");
    launcher = writeStorybloqLauncher({
      bin: join(root, "bin"), node: process.execPath, cli: CLI, scratchHome: scratch, codexHome: join(root, "codex"), tmp: join(root, "tmp"), work: join(root, "work"), path: `${join(root, "stub")}:/usr/bin:/bin`,
    }).path;
    // A project in the work dir, so status has something to report.
    expect(run(["init", "--name", "e4"]).status).toBe(0);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is mode 0500 and pins node and the bundle", () => {
    expect(statSync(launcher).mode & 0o777).toBe(0o500);
    const text = readFileSync(launcher, "utf-8");
    expect(text).toContain(process.execPath);
    expect(text).toContain(CLI);
    expect(text).toContain("env -i");
  });
  it.each([
    [["--version"], (out: string) => expect(out.trim()).toBe(version)],
    [["status"], (out: string) => { expect(out).toMatch(/^# e4$/m); expect(out).toMatch(/Tickets: 0\/0 complete/); }],
    [["health"], (out: string) => { expect(out).toMatch(/^# Health check$/m); expect(out).toContain(`storybloq ${version}`); }],
  ] as const)("storybloq %j exits 0 with its own output and writes nothing under the real HOME", (args, check) => {
    const before = snap(fakeReal);
    const r = run([...args]);
    expect(r.status).toBe(0);
    check(r.stdout);
    expect(snap(fakeReal)).toEqual(before);
  }, 60_000);
  it("a stale skill in the scratch home is refreshed there, never under the real HOME", () => {
    const skill = join(scratch, ".claude", "skills", "story");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# stale\n");
    writeFileSync(join(skill, ".storybloq-version"), "0.0.1\n");
    const before = snap(fakeReal);
    expect(run(["status"]).status).toBe(0);
    expect(readFileSync(join(skill, ".storybloq-version"), "utf-8").trim()).toBe(version);
    expect(readFileSync(join(skill, "SKILL.md"), "utf-8")).not.toBe("# stale\n");
    expect(readFileSync(join(skill, "SKILL.md"), "utf-8")).toMatch(/^---\nname: story$/m);
    expect(snap(fakeReal)).toEqual(before);
  }, 60_000);
  it("NO_UPDATE_NOTIFIER is set: no update cache appears in either home", () => {
    expect(storybloqLauncherText({ bin: "/b", node: "/n", cli: "/c", scratchHome: "/s", codexHome: "/x", tmp: "/t", work: "/w", path: "/p" })).toContain("NO_UPDATE_NOTIFIER='1'");
    run(["status"]);
    for (const home of [fakeReal, scratch]) expect(existsSync(join(home, ".claude", "storybloq", "update-check.json"))).toBe(false);
  }, 60_000);
});

describe("signed-in: the runner's entry points, qualification and the experiment hash", async () => {
  const run = await import("../../scripts/continuity-run.js");
  const lib = await import("../../scripts/continuity-lib.js");
  const base = { arm: 2 as const, inputTreeHash: "i", buildManifestHash: "b", model: "m", effort: "high", timeoutMs: 1, maxBudgetUsd: 1, clientVersion: "v", configHash: "c", launchPolicy: lib.LAUNCH_POLICY };
  it("parseArgs accepts --isolation signed-in and --live-ack; shared and the owner exception stay refused", () => {
    const o = run.parseArgs(["--isolation", "signed-in", "--live-ack", SIGNED_IN_RULING]);
    expect(o.isolation).toBe("signed-in");
    expect(o.liveAck).toBe(SIGNED_IN_RULING);
    expect(() => run.parseArgs(["--isolation", "shared"])).toThrow(/refused/);
    expect(() => run.parseArgs(["--owner-exception"])).toThrow(/refused/);
  });
  it("refuseSignedIn names token variables first, then the ack, then the gates", () => {
    expect(() => run.refuseSignedIn({}, { ANTHROPIC_API_KEY: "secret-value-0123456789" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => run.refuseSignedIn({}, {})).toThrow(/--live-ack/);
    expect(() => run.refuseSignedIn({ liveAck: SIGNED_IN_RULING }, {})).toThrow(/missing gates/);
  });
  it("signedInOptions passes an empty source list and its readback expects flagSettings alone", async () => {
    const o = run.signedInOptions("high");
    expect(o.settingSources).toBe("none");
    expect(run.continuityOptions("high").settingSources).toBeUndefined();
  });
  it("a fresh experiment hash is unchanged by the new field (known answer), and signed-in differs", () => {
    const fresh = lib.experimentHash({ ...base, isolation: "fresh" });
    const known = lib.sha256(JSON.stringify({ arm: 2, inputTreeHash: "i", buildManifestHash: "b", model: "m", effort: "high", timeoutMs: 1, maxBudgetUsd: 1, clientVersion: "v", isolation: "fresh", configHash: "c", launchPolicy: lib.LAUNCH_POLICY }));
    expect(fresh).toBe(known);
    const si = { settingSources: "none" as const, launcherSha256: "l", homeClassifierVersion: 1 };
    const signed = lib.experimentHash({ ...base, isolation: "signed-in", signedIn: si });
    expect(signed).not.toBe(fresh);
    expect(lib.experimentHash({ ...base, isolation: "signed-in", signedIn: { ...si, launcherSha256: "l2" } })).not.toBe(signed);
  });
  it("qualifies(signed-in) is false, naming the gates; fresh still qualifies on the same cells", () => {
    const cells = lib.expectedCellKeys().map((k) => { const [task, r] = k.split("#"); return { task: task!, repeat: Number(r), satisfied: true, evidenceComplete: true }; });
    const pilot = { ok: true, reason: "ok" } as never;
    expect(lib.qualifies({ cells, isolation: "fresh", pilot }).qualifying).toBe(true);
    const q = lib.qualifies({ cells, isolation: "signed-in", pilot });
    expect(q.qualifying).toBe(false);
    expect(q.reason).toContain(SIGNED_IN_MISSING_GATES[0]);
  });
});

describe("preflight's concurrent-suite check is counts only", async () => {
  const run = await import("../../scripts/continuity-run.js");
  const { spawn } = await import("node:child_process");
  it("the refusal carries a count and no process arguments; a planted marker never appears", async () => {
    const tag = `w15planted${process.pid}`;
    const marker = "SECRET-ARG-should-never-print-0123456789";
    const child = spawn("/bin/sh", ["-c", "sleep 30; true", tag, marker], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && run.processCount(tag, PKG) === 0; i++) await new Promise((r) => setTimeout(r, 100));
      const problem = run.concurrentSuiteProblem(tag, PKG);
      expect(problem).toMatch(new RegExp(`: \\d+ ${tag} process`));
      expect(problem).not.toContain(marker);
      expect(problem).not.toContain("sleep");
    } finally {
      child.kill("SIGKILL");
    }
    expect(run.concurrentSuiteProblem(`absent-${tag}-x`, PKG)).toBeNull();
  }, 20_000);
});
