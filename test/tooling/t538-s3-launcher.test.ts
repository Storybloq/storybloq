/**
 * T-538 signed-in note v5 section 12, S3: the launcher and provisioning (C3, C4). Under signed-in the CLI the
 * client's shell finds is the E4 launcher (`env -i`, the scratch home) carrying the eval names as an allowlisted
 * extra table, and provisioning runs under a launcher's scratch environment, never the client column. The refusal
 * stays active: nothing here launches a client. Every home is a fixture; no credential value is read.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LAUNCHER_EXTRA_NAMES, storybloqLauncherEnv, storybloqLauncherText, writeStorybloqLauncher, type LauncherSpec } from "../../scripts/continuity-signed-in.js";
import { envFor, launcherExtraFor, type EnvInputs } from "../../scripts/onboarding-eval-host.js";
import { clientEnvInputs, isolationProblems, signedInCliLaunchers, storybloqEntry } from "../../scripts/onboarding-eval-run.js";
import { provisionClientHome } from "../../scripts/onboarding-eval-client-home.js";
import { CHECK_SET_VERSION } from "../../scripts/onboarding-eval-lib.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = (JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as { version: string }).version;
const SKILL = join(PKG, "src", "skill");
const MARKER_WRITER = { command: join(PKG, "node_modules", ".bin", "tsx"), args: [join(PKG, "scripts", "onboarding-eval-skill-marker.ts")] };
const SECRET = "SECRET-VALUE-NEVER-PRINTED";
const SPEC: LauncherSpec = { bin: "/b", node: "/n", cli: "/c", scratchHome: "/s", codexHome: "/x", tmp: "/t", work: "/w", path: "/p" };

beforeAll(async () => {
  const { buildEval } = (await import("../../scripts/build-eval.mjs")) as { buildEval: (root: string) => Promise<unknown> };
  await buildEval(PKG);
}, 240_000);

describe("S3: the launcher's extra table", () => {
  it("leaves continuity's launcher byte for byte as it was", () => {
    expect(storybloqLauncherText(SPEC)).toBe(
      "#!/bin/sh\nexec /usr/bin/env -i HOME='/s' PATH='/p' TMPDIR='/t' STORYBLOQ_GLOBAL_DIR='/t/storybloq-global' STORYBLOQ_PROJECT_ROOT='/w' NO_UPDATE_NOTIFIER='1' CODEX_HOME='/x' '/n' '/c' \"$@\"\n",
    );
    expect(storybloqLauncherText({ ...SPEC, lang: "en_US.UTF-8" })).toContain("CODEX_HOME='/x' LANG='en_US.UTF-8' '/n' '/c' \"$@\"\n");
  });

  it("carries the allowlisted extra names after the base table, the fixed arguments after the bundle, and env -i first", () => {
    const text = storybloqLauncherText({ ...SPEC, work: undefined, globalDir: "/g", args: ["--entry", "cli"], extra: { STORYBLOQ_CLIENT: "claude", STORYBLOQ_EVAL_EVENTS: "/e/events.jsonl", STORYBLOQ_EVAL_FAULT: "f'1" } });
    expect(text).toBe(
      "#!/bin/sh\nexec /usr/bin/env -i HOME='/s' PATH='/p' TMPDIR='/t' STORYBLOQ_GLOBAL_DIR='/g' NO_UPDATE_NOTIFIER='1' CODEX_HOME='/x' STORYBLOQ_CLIENT='claude' STORYBLOQ_EVAL_EVENTS='/e/events.jsonl' STORYBLOQ_EVAL_FAULT='f'\\''1' '/n' '/c' '--entry' 'cli' \"$@\"\n",
    );
    expect(LAUNCHER_EXTRA_NAMES).toEqual(["STORYBLOQ_CLIENT", "STORYBLOQ_EVAL_EVENTS", "STORYBLOQ_SETUP_REVIEW_DIR", "STORYBLOQ_EVAL_FAULT", "STORYBLOQ_EVAL_FAULT_ID", "STORYBLOQ_EVAL_REVIEW_RESPONSES"]);
  });

  it.each(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "PATH", "STORYBLOQ_PROJECT_ROOT", "STORYBLOQ_EVAL_TOOLS"])("refuses %s as an extra name, before anything is written", (name) => {
    const dir = mkdtempSync(join(tmpdir(), "s3x-"));
    try {
      const extra = { [name]: SECRET } as LauncherSpec["extra"];
      expect(() => storybloqLauncherEnv({ ...SPEC, extra })).toThrow(`storybloq launcher: ${name} is not an allowed extra variable`);
      let message = "";
      try { writeStorybloqLauncher({ ...SPEC, bin: dir, extra }); } catch (e) { message = (e as Error).message; }
      expect(message).not.toContain(SECRET);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an empty extra value by name", () => {
    expect(() => storybloqLauncherEnv({ ...SPEC, extra: { STORYBLOQ_EVAL_EVENTS: "" } })).toThrow("storybloq launcher: the extra variable STORYBLOQ_EVAL_EVENTS has no value");
  });

  it("the launcher's environment is its text's table: one source", () => {
    const spec: LauncherSpec = { ...SPEC, work: undefined, extra: { STORYBLOQ_CLIENT: "claude", STORYBLOQ_SETUP_REVIEW_DIR: "/r" } };
    const env = storybloqLauncherEnv(spec);
    expect(Object.keys(env)).toEqual(["HOME", "PATH", "TMPDIR", "STORYBLOQ_GLOBAL_DIR", "NO_UPDATE_NOTIFIER", "CODEX_HOME", "STORYBLOQ_CLIENT", "STORYBLOQ_SETUP_REVIEW_DIR"]);
    const text = storybloqLauncherText(spec);
    for (const [k, v] of Object.entries(env)) expect(text).toContain(` ${k}='${v}'`);
  });
});

const BASE: EnvInputs = {
  client: "claude", path: "/w/cli-bin:/usr/bin:/bin", home: "/w/client-home", tmp: "/w/tmp", lang: "en_US.UTF-8",
  runnerHome: "/w/sandbox-runner-home", globalDir: "/w/storybloq-global", events: "/w/eval-events/events.jsonl", fault: "kill#1", faultId: "f1", reviewStore: "/w/store",
  reviewResponses: "/w/review-responses", outside: "/w/outside-probe", tools: "/pkg/tools.json", degraded: false,
};
const SIGNED: EnvInputs = { ...BASE, isolation: "signed-in", realHome: "/fake/real-home" };
const FRESH: EnvInputs = { ...BASE, claudeConfigDir: "/w/claude-config", oauthToken: SECRET };

describe("S3: the eval names move from the signed-in client column into the launcher (C4)", () => {
  it("the signed-in column plus the launcher's extra table is the fresh column without the config dir and the token, value for value", () => {
    const fresh = envFor("client", FRESH);
    const { CLAUDE_CONFIG_DIR: _c, CLAUDE_CODE_OAUTH_TOKEN: _t, HOME: _h, ...rest } = fresh;
    const { HOME, ...signed } = envFor("client", SIGNED);
    expect(HOME).toBe("/fake/real-home");
    expect({ ...signed, ...launcherExtraFor(SIGNED) }).toEqual(rest);
    for (const k of LAUNCHER_EXTRA_NAMES) expect(signed).not.toHaveProperty(k);
    expect(Object.keys(launcherExtraFor(SIGNED)).sort()).toEqual([...LAUNCHER_EXTRA_NAMES].sort());
  });

  it("the extra table keeps the column's rules: the fault id only with a fault, responses only when set, events and the store required", () => {
    expect(launcherExtraFor({ ...SIGNED, fault: null, faultId: "f1", reviewResponses: null })).toEqual({ STORYBLOQ_CLIENT: "claude", STORYBLOQ_EVAL_EVENTS: BASE.events, STORYBLOQ_SETUP_REVIEW_DIR: "/w/store" });
    expect(() => launcherExtraFor({ ...SIGNED, events: "" })).toThrow("onboarding-eval: STORYBLOQ_EVAL_EVENTS has no value for the CLI launcher");
    expect(() => launcherExtraFor({ ...SIGNED, reviewStore: "" })).toThrow("onboarding-eval: STORYBLOQ_SETUP_REVIEW_DIR has no value for the CLI launcher");
  });

  it("the server column and the fresh client column keep their eval names", () => {
    expect(envFor("server", SIGNED)).toEqual(envFor("server", FRESH));
    expect(envFor("server", SIGNED)).toMatchObject({ STORYBLOQ_CLIENT: "claude", STORYBLOQ_EVAL_EVENTS: BASE.events, STORYBLOQ_EVAL_FAULT: "kill#1" });
    expect(envFor("client", FRESH)).toMatchObject({ STORYBLOQ_CLIENT: "claude", STORYBLOQ_EVAL_EVENTS: BASE.events, STORYBLOQ_EVAL_FAULT_ID: "f1", STORYBLOQ_EVAL_REVIEW_RESPONSES: "/w/review-responses" });
  });

  it("signed-in isolation names an eval name left in the client column as inherited", () => {
    const sig = envFor("client", SIGNED);
    expect(isolationProblems({ ...sig }, "/w", "claude", undefined, { realHome: "/fake/real-home" })).toEqual([]);
    expect(isolationProblems({ ...sig, STORYBLOQ_EVAL_EVENTS: BASE.events, STORYBLOQ_EVAL_FAULT: "kill#1" }, "/w", "claude", undefined, { realHome: "/fake/real-home" }))
      .toEqual(["STORYBLOQ_EVAL_EVENTS is inherited", "STORYBLOQ_EVAL_FAULT is inherited"]);
  });
});

describe("S3: the run's own EnvInputs (deviation 2 of S2)", () => {
  const counted = (): { calls: { token: number; home: number }; p: Parameters<typeof clientEnvInputs>[2] } => {
    const calls = { token: 0, home: 0 };
    return { calls, p: { work: "/w", home: "/w/client-home", token: () => { calls.token += 1; return SECRET; }, realHome: () => { calls.home += 1; return "/fake/real-home"; } } };
  };

  it("Claude signed-in: the password-database home and neither the config dir nor the token; the token is never read", () => {
    const { calls, p } = counted();
    expect(clientEnvInputs("claude", "signed-in", p)).toEqual({ isolation: "signed-in", realHome: "/fake/real-home" });
    expect(calls).toEqual({ token: 0, home: 1 });
  });

  it("Claude fresh: the scratch config folder and the token, as before; the real home is never asked", () => {
    const { calls, p } = counted();
    expect(clientEnvInputs("claude", "fresh", p)).toEqual({ claudeConfigDir: "/w/claude-config", oauthToken: SECRET });
    expect(calls).toEqual({ token: 1, home: 0 });
  });

  it("Codex: its scratch CODEX_HOME fresh, and refused signed-in", () => {
    const { calls, p } = counted();
    expect(clientEnvInputs("codex", "fresh", p)).toEqual({ clientCodexHome: "/w/client-home/.codex" });
    expect(() => clientEnvInputs("codex", "signed-in", p)).toThrow("onboarding-eval: signed-in isolation is the Claude client's only; the Codex client runs fresh");
    expect(calls).toEqual({ token: 0, home: 0 });
  });

  it("the signed-in inputs build the signed-in client column", () => {
    const { p } = counted();
    const inputs: EnvInputs = { ...BASE, ...clientEnvInputs("claude", "signed-in", p) };
    expect(envFor("client", inputs)).toEqual(envFor("client", SIGNED));
  });

  it("the run takes its inputs, the launchers, provisioning and both checks from the signed-in branch", () => {
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8");
    expect(src).toContain("const isolation: Options[\"isolation\"] = runAdmission(argv, admission);");
    expect(src).toContain("    ...clientEnvInputs(o.client, o.isolation, { work, home, token: () => process.env.CLAUDE_CODE_OAUTH_TOKEN, realHome }),");
    expect(src).not.toContain("oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN");
    expect(src).toContain("const signedInLaunchers = signedIn ? signedInCliLaunchers(envInputs, { cliBin, provisionBin: join(work, \"provision-bin\"), provisionEvents: join(work, \"provision-events.jsonl\") }) : null;");
    expect(src).toContain("const launcher = signedIn ? join(cliBin, \"storybloq\") : installCliLauncher(cliBin);");
    expect(src).toContain("    env: signedInLaunchers?.provisionEnv ?? { ...envFor(\"client\", { ...envInputs, fault: null, faultId: null }), STORYBLOQ_EVAL_EVENTS: join(work, \"provision-events.jsonl\") },");
    expect(src).toContain("const isolation = isolationProblems(env, work, o.client, envFor(\"client\", envInputs), signedInHome);");
    expect(src).toContain("const homeFolders = o.client === \"claude\" && !signedIn ? [home, envInputs.claudeConfigDir!] : [home];");
    expect(src).toContain("secrets: signedIn ? [] : [process.env.CLAUDE_CODE_OAUTH_TOKEN ?? \"\"]");
    expect(src).toContain("if (signedInLaunchers !== null && signedInLaunchers.client.path !== launcher) throw new Error(\"onboarding-eval: the signed-in launcher is not the one on the client PATH\");");
    expect(src).toContain("    if (!signedIn) {\n      const claudeConfig = provisionClaude(work);");
    expect(src).toContain("    } else if (envInputs.claudeConfigDir !== undefined) throw new Error(\"onboarding-eval: a signed-in run has no Claude config folder\");");
    expect(src).toContain("const harnessLauncher = signedIn ? installCliLauncher(join(work, \"harness-cli-bin\")) : launcher;");
    expect(src.match(/shellWords\(\[harnessLauncher, \.\.\.args\]\)/g)).toHaveLength(2);
    expect(src).not.toContain("shellWords([launcher, ...args])");
  });
});

/** Every entry under a folder by relative path: directories, and files with their content hash. */
const snap = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const p = rel === "" ? dir : join(dir, rel);
    if (!existsSync(p)) return;
    const st = lstatSync(p);
    if (st.isDirectory()) {
      out.push(`${rel}/`);
      for (const n of readdirSync(p).sort()) walk(rel === "" ? n : `${rel}/${n}`);
    } else out.push(`${rel}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
  };
  walk("");
  return out;
};

describe("S3: the signed-in launchers and provisioning, through real invocations", () => {
  let root: string;
  let work: string;
  let fakeReal: string;
  let inputs: EnvInputs;
  let launchers: ReturnType<typeof signedInCliLaunchers>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "s3-"));
    work = join(root, "work");
    fakeReal = join(root, "real");
    for (const d of ["client-home", "tmp", "storybloq-global", "eval-events", "store", "cli-provision", "project", "stub", "npmroot/@storybloq"]) mkdirSync(join(work, d), { recursive: true });
    mkdirSync(join(fakeReal, ".claude", "skills", "story"), { recursive: true });
    writeFileSync(join(fakeReal, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(fakeReal, ".claude", "skills", "story", "SKILL.md"), "# real\n");
    // Test-only: a stub npm whose global root holds this package, so skill refresh treats this build as the owner.
    symlinkSync(PKG, join(work, "npmroot", "@storybloq", "storybloq"));
    writeFileSync(join(work, "stub", "npm"), `#!/bin/sh\necho '${join(work, "npmroot")}'\n`, { mode: 0o755 });
    inputs = {
      client: "claude", isolation: "signed-in", realHome: fakeReal, path: `${join(work, "cli-bin")}:${join(work, "stub")}:${dirname(process.execPath)}:/usr/bin:/bin`, home: join(work, "client-home"),
      tmp: join(work, "tmp"), lang: "en_US.UTF-8", runnerHome: join(work, "runner"), globalDir: join(work, "storybloq-global"), events: join(work, "eval-events", "events.jsonl"),
      fault: "kill#1", faultId: "f1", reviewStore: join(work, "store"), reviewResponses: join(work, "review-responses"), outside: join(work, "outside"), tools: join(work, "tools.json"), degraded: false,
    };
    launchers = signedInCliLaunchers(inputs, { cliBin: join(work, "cli-bin"), provisionBin: join(work, "provision-bin"), provisionEvents: join(work, "provision-events.jsonl") });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a fresh run", () => {
    expect(() => signedInCliLaunchers({ ...inputs, isolation: undefined }, { cliBin: join(root, "x"), provisionBin: join(root, "y"), provisionEvents: join(root, "z") }))
      .toThrow("onboarding-eval: the signed-in CLI launchers are for a signed-in run only");
    expect(existsSync(join(root, "x"))).toBe(false);
  });

  it("writes two 0500 env -i launchers: the client's with the eval names and the fault, provisioning's with its own events and no fault", () => {
    const cli = storybloqEntry(CHECK_SET_VERSION, "cli");
    for (const l of [launchers.client, launchers.provision]) {
      expect(statSync(l.path).mode & 0o777).toBe(0o500);
      const text = readFileSync(l.path, "utf-8");
      expect(text.startsWith("#!/bin/sh\nexec /usr/bin/env -i HOME=")).toBe(true);
      expect(createHash("sha256").update(text).digest("hex")).toBe(l.sha256);
      expect(text).toContain(`'${process.execPath}' '${cli.path}' '--entry' 'cli' "$@"\n`);
      expect(text).not.toContain(fakeReal);
      expect(text).not.toContain("CLAUDE_CONFIG_DIR");
    }
    expect(launchers.client.path).toBe(join(work, "cli-bin", "storybloq"));
    const client = readFileSync(launchers.client.path, "utf-8");
    expect(client).toContain(`STORYBLOQ_EVAL_EVENTS='${inputs.events}'`);
    expect(client).toContain("STORYBLOQ_EVAL_FAULT='kill#1' STORYBLOQ_EVAL_FAULT_ID='f1'");
    expect(client).toContain(`STORYBLOQ_GLOBAL_DIR='${inputs.globalDir}'`);
    expect(client).not.toContain("STORYBLOQ_PROJECT_ROOT");
    const provision = readFileSync(launchers.provision.path, "utf-8");
    expect(provision).toContain(`STORYBLOQ_EVAL_EVENTS='${join(work, "provision-events.jsonl")}'`);
    expect(provision).not.toContain("STORYBLOQ_EVAL_FAULT");
  });

  it("provisioning's environment is its launcher's table: the scratch home, no real home, no config dir, no token", () => {
    expect(launchers.provisionEnv).toEqual({
      HOME: inputs.home, PATH: inputs.path, TMPDIR: inputs.tmp, STORYBLOQ_GLOBAL_DIR: inputs.globalDir, NO_UPDATE_NOTIFIER: "1", CODEX_HOME: join(inputs.home, ".codex"), LANG: "en_US.UTF-8",
      STORYBLOQ_CLIENT: "claude", STORYBLOQ_EVAL_EVENTS: join(work, "provision-events.jsonl"), STORYBLOQ_SETUP_REVIEW_DIR: inputs.reviewStore, STORYBLOQ_EVAL_REVIEW_RESPONSES: inputs.reviewResponses,
    });
  });

  const viaLauncher = (args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } => {
    // The caller's environment is the signed-in client column, the real home in it: the launcher must not pass it on.
    const r = spawnSync(launchers.client.path, args, { cwd, encoding: "utf-8", env: envFor("client", inputs), timeout: 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  it.each([
    [["status"], (out: string) => expect(out).toMatch(/^# s3$/m)],
    [["health"], (out: string) => expect(out).toMatch(/^# Health check$/m)],
  ] as const)("storybloq %j through the client's launcher exits 0 and writes nothing under the real home", (args, check) => {
    const unarmed = signedInCliLaunchers({ ...inputs, fault: null, faultId: null }, { cliBin: join(root, "u-bin"), provisionBin: join(root, "u-prov"), provisionEvents: join(root, "u-events.jsonl") });
    const run = (a: string[]): ReturnType<typeof viaLauncher> => {
      const r = spawnSync(unarmed.client.path, a, { cwd: join(work, "project"), encoding: "utf-8", env: envFor("client", inputs), timeout: 60_000 });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    expect(run(["init", "--name", "s3"]).status).toBe(0);
    const before = snap(fakeReal);
    const r = run([...args]);
    expect(r.status, r.stderr).toBe(0);
    check(r.stdout);
    expect(snap(fakeReal)).toEqual(before);
    expect(readFileSync(join(work, "eval-events", "events.jsonl"), "utf-8").length).toBeGreaterThan(0);
  }, 120_000);

  it("a stale skill in the scratch home is refreshed there, never under the real home", () => {
    const skill = join(inputs.home, ".claude", "skills", "story");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# stale\n");
    writeFileSync(join(skill, ".storybloq-version"), "0.0.1\n");
    const before = snap(fakeReal);
    const r = spawnSync(launchers.provision.path, ["--version"], { cwd: join(work, "cli-provision"), encoding: "utf-8", env: envFor("client", inputs), timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(skill, ".storybloq-version"), "utf-8").trim()).toBe(VERSION);
    expect(readFileSync(join(skill, "SKILL.md"), "utf-8")).toMatch(/^---\nname: story$/m);
    expect(snap(fakeReal)).toEqual(before);
  }, 120_000);

  it("NO_UPDATE_NOTIFIER is its own control: in every launcher's table, and no update cache appears in either home", () => {
    for (const l of [launchers.client, launchers.provision]) expect(readFileSync(l.path, "utf-8")).toContain(" NO_UPDATE_NOTIFIER='1' ");
    expect(launchers.provisionEnv.NO_UPDATE_NOTIFIER).toBe("1");
    const r = spawnSync(launchers.provision.path, ["--version"], { cwd: join(work, "cli-provision"), encoding: "utf-8", env: { ...envFor("client", inputs), NO_UPDATE_NOTIFIER: "" }, timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    for (const home of [fakeReal, inputs.home]) expect(existsSync(join(home, ".claude", "storybloq", "update-check.json"))).toBe(false);
  }, 120_000);

  it("provisioning under the launcher's environment writes the scratch home only, the skill marker included", () => {
    const before = snap(fakeReal);
    const p = provisionClientHome({
      command: launchers.provision.path, folders: [inputs.home], provisionDir: join(work, "cli-provision"), root: work,
      version: VERSION, skillSource: SKILL, markers: ["claude"], markerWriter: MARKER_WRITER, env: launchers.provisionEnv,
    });
    expect(snap(fakeReal)).toEqual(before);
    expect(p.writes.length).toBeGreaterThan(0);
    for (const w of p.writes) expect(w.path.startsWith("client-home/")).toBe(true);
    expect(p.writes.map((w) => w.path)).toContain("client-home/.claude/skills/story/.storybloq-version");
    expect(existsSync(join(work, "provision-events.jsonl"))).toBe(true);
    expect(existsSync(inputs.events)).toBe(false);
  }, 120_000);

  it("the client column under provisioning would write the real home: the row above is a real control", () => {
    const before = snap(fakeReal);
    provisionClientHome({
      command: launchers.provision.path, folders: [inputs.home], provisionDir: join(work, "cli-provision"), root: work,
      version: VERSION, skillSource: SKILL, markers: ["claude"], markerWriter: MARKER_WRITER, env: envFor("client", inputs),
    });
    expect(snap(fakeReal)).not.toEqual(before);
    expect(existsSync(join(fakeReal, ".claude", "skills", "story", ".storybloq-version"))).toBe(true);
  }, 120_000);
});
