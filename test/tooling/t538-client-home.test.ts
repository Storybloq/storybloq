/**
 * T-538 commit 3, pen ruling on finding 4 (option A): the CLI's own housekeeping is client-home provisioning.
 * These rows run the real CLI from the eval bundle (never a stand-in home) against client homes laid out as the
 * runner lays them out, with the client column of the environment table.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { folderHashes, pinWrites, provisionClientHome } from "../../scripts/onboarding-eval-client-home.js";
import { configProblems, credentialLinkEntry, treeEntries, type Manifest } from "../../scripts/onboarding-eval-config.js";
import { envFor, type EnvInputs } from "../../scripts/onboarding-eval-host.js";

const PKG = join(__dirname, "..", "..");
const CLI = join(PKG, ".eval-dist", "eval-cli.js");
const VERSION = (JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")) as { version: string }).version;
const SKILL = join(PKG, "src", "skill");
const MARKER_WRITER = { command: join(PKG, "node_modules", ".bin", "tsx"), args: [join(PKG, "scripts", "onboarding-eval-skill-marker.ts")] };
/** Every file under a folder, relative, sorted. */
const filesUnder = (dir: string, rel = ""): string[] => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(dir, join(rel, d.name)) : [join(rel, d.name)])).sort();

beforeAll(async () => {
  const { buildEval } = (await import("../../scripts/build-eval.mjs")) as { buildEval: (root: string) => Promise<unknown> };
  await buildEval(PKG);
}, 300_000);

interface Arm { readonly skill: string; readonly dir: string; readonly folders: string[]; readonly entries: ReturnType<typeof treeEntries>; readonly inputs: EnvInputs; readonly cwd: string }

/** A client home as the runner provisions it: Claude's config folder with the skill and settings, or a Codex home. */
function arm(client: "claude" | "codex"): Arm {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538ch-")));
  const home = join(dir, "client-home");
  mkdirSync(home);
  const cfg = join(dir, "claude-config");
  const skill = client === "claude" ? join(cfg, "skills", "story") : join(home, ".agents", "skills", "story");
  cpSync(SKILL, skill, { recursive: true });
  if (client === "claude") {
    writeFileSync(join(cfg, "settings.json"), `${JSON.stringify({ env: {}, hooks: {} }, null, 2)}\n`);
  } else {
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), "# provisioned\n");
  }
  const folders = client === "claude" ? [home, cfg] : [home];
  const entries = folders.flatMap((f) => treeEntries(f));
  // The Codex credential link, to a target that does not exist: provisioning holds it by readlink and never opens it.
  if (client === "codex") {
    symlinkSync(join(dir, "credential-never-opened"), join(home, ".codex", "auth.json"));
    entries.push(credentialLinkEntry(join(home, ".codex", "auth.json")));
  }
  const cwd = join(dir, "cli-provision");
  mkdirSync(cwd);
  for (const d of ["tmp", "global"]) mkdirSync(join(dir, d));
  const inputs: EnvInputs = {
    client, path: `${dirname(process.execPath)}:/usr/bin:/bin`, home, tmp: join(dir, "tmp"), lang: "en_US.UTF-8",
    ...(client === "codex" ? { clientCodexHome: join(home, ".codex") } : { claudeConfigDir: cfg, oauthToken: "token-not-read" }),
    runnerHome: join(dir, "runner-home"), globalDir: join(dir, "global"), events: join(dir, "events.jsonl"), fault: null,
    reviewStore: join(dir, "review-store"), outside: join(dir, "outside"), tools: join(dir, "tools.json"), degraded: false,
  };
  return { skill, dir, folders, entries, inputs, cwd };
}

const run = (a: Arm, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, "--entry", "cli", ...args], { cwd: a.cwd, env, encoding: "utf-8", timeout: 120_000 });
const cli = (a: Arm, env: Record<string, string>, ...args: string[]): number | null => run(a, env, ...args).status;
const provision = (a: Arm) => provisionClientHome({
  command: process.execPath, args: [CLI, "--entry", "cli"], folders: a.folders, env: envFor("client", a.inputs), provisionDir: a.cwd, root: a.dir,
  version: VERSION, skillSource: SKILL, markers: [a.inputs.client], markerWriter: MARKER_WRITER,
});

describe("finding 4: the CLI's housekeeping is client-home provisioning", () => {
  for (const client of ["claude", "codex"] as const) {
    it(`${client}: provisioning records the settings.json write, and after it --version and status write nothing to HOME or the config folder`, () => {
      const a = arm(client);
      try {
        const p = provision(a);
        const settings = client === "claude" ? "claude-config/settings.json" : "client-home/.claude/settings.json";
        expect(p.command).toBe("storybloq --version");
        expect(p.exit).toBe(0);
        expect(p.markers).toEqual([client]);
        // The skill the model sees is the bundle's source, byte for byte; the marker names the bundle's CLI version.
        const installed = filesUnder(a.skill).filter((f) => !f.startsWith(".storybloq-"));
        expect(installed).toEqual(filesUnder(SKILL));
        for (const f of installed) expect(readFileSync(join(a.skill, f)).equals(readFileSync(join(SKILL, f)))).toBe(true);
        expect(readFileSync(join(a.skill, ".storybloq-version"), "utf-8")).toBe(`${VERSION}\n`);
        expect(run(a, envFor("client", a.inputs), "--version").stdout.trim()).toBe(VERSION);
        expect(p.writes.map((w) => w.path)).toEqual(expect.arrayContaining([relative(a.dir, join(a.skill, ".storybloq-version")), relative(a.dir, join(a.skill, ".storybloq-skill-fingerprint"))]));
        expect(p.writes.map((w) => [w.path, w.change])).toContainEqual([settings, client === "claude" ? "changed" : "created"]);
        for (const w of p.writes) expect(w.sha256).toBe(folderHashes(a.folders).get(join(a.dir, w.path)));
        const manifest: Manifest = { folders: a.folders, entries: pinWrites(a.entries, p, a.dir) };
        expect(configProblems(manifest)).toEqual([]);
        const settled = folderHashes(a.folders);
        const env = envFor("client", a.inputs);
        expect(cli(a, env, "--version")).toBe(0);
        const status = run(a, env, "status");
        // The in-turn call takes no stale-skill path: no ownership probe line to the model, no npm log under HOME.
        expect(status.stderr).not.toContain("not the global install");
        expect(existsSync(join(a.inputs.home, ".npm"))).toBe(false);
        expect(folderHashes(a.folders)).toEqual(settled);
        expect(configProblems(manifest)).toEqual([]);
      } finally {
        rmSync(a.dir, { recursive: true, force: true });
      }
    }, 120_000);
  }

  it("without provisioning, the first ordinary CLI call writes settings.json and trips the client-home stop", () => {
    const a = arm("codex");
    try {
      const manifest: Manifest = { folders: a.folders, entries: a.entries };
      expect(configProblems(manifest)).toEqual([]);
      cli(a, envFor("client", a.inputs), "status");
      expect(configProblems(manifest)).toContain(`config: ${join(a.inputs.home, ".claude", "settings.json")} is not in the manifest`);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("after provisioning, a turn that edits settings.json still trips the stop", () => {
    const a = arm("claude");
    try {
      const manifest: Manifest = { folders: a.folders, entries: pinWrites(a.entries, provision(a), a.dir) };
      const settings = join(a.inputs.claudeConfigDir!, "settings.json");
      writeFileSync(settings, readFileSync(settings, "utf-8").replace("{", '{"model":"x",'));
      expect(configProblems(manifest)).toContain(`config: ${settings} changed`);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  }, 120_000);

  // ISS-1492: before the fix this row pinned the cache landing under HOME/.claude whatever the env said,
  // so only NO_UPDATE_NOTIFIER held the home still. The cache now follows STORYBLOQ_GLOBAL_DIR, which the
  // client env sets to the run's global dir: the home stays still even with the opt-out cleared.
  it("with NO_UPDATE_NOTIFIER cleared, status writes the update cache under the run's global dir, never the client home", async (ctx) => {
    const reachable = await fetch("https://registry.npmjs.org/@storybloq%2fstorybloq/latest", { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    if (!reachable) ctx.skip();
    const a = arm("codex");
    try {
      const manifest: Manifest = { folders: a.folders, entries: pinWrites(a.entries, provision(a), a.dir) };
      const { NO_UPDATE_NOTIFIER, ...cleared } = envFor("client", a.inputs);
      expect(NO_UPDATE_NOTIFIER).toBe("1");
      cli(a, cleared, "status");
      expect(existsSync(join(a.inputs.globalDir, "update-check.json"))).toBe(true);
      expect(existsSync(join(a.inputs.home, ".claude", "storybloq", "update-check.json"))).toBe(false);
      expect(configProblems(manifest)).toEqual([]);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a failed provisioning call is a provisioning failure by cause", () => {
    const a = arm("codex");
    try {
      expect(() => provisionClientHome({ command: "/usr/bin/false", folders: a.folders, env: envFor("client", a.inputs), provisionDir: a.cwd, root: a.dir, version: VERSION, skillSource: SKILL, markers: [], markerWriter: MARKER_WRITER }))
        .toThrow("onboarding-eval: provisioning: client home: storybloq --version failed (exit 1)");
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("a provisioning call that removes a client-home file is a provisioning failure naming the file", () => {
    const a = arm("codex");
    try {
      const gone = join(a.inputs.home, ".codex", "config.toml");
      expect(() => provisionClientHome({ command: "/bin/sh", args: ["-c", `rm "${gone}"; echo ${VERSION}`, "sh"], folders: a.folders, env: envFor("client", a.inputs), provisionDir: a.cwd, root: a.dir, version: VERSION, skillSource: SKILL, markers: [], markerWriter: MARKER_WRITER }))
        .toThrow("onboarding-eval: provisioning: client home: storybloq --version removed client-home/.codex/config.toml");
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
  });

  it("the runner provisions the client home after the client's own provisioning and before the manifest is taken", () => {
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8");
    const call = src.indexOf("const clientHomeProvisioning = provisionClientHome({");
    expect(call).toBeGreaterThan(src.indexOf("const claudeConfig = provisionClaude(work);"));
    expect(call).toBeGreaterThan(src.indexOf("const codex = provisionCodexHome(home, realCodexAuth, \"client\""));
    expect(src.indexOf("manifestEntries.splice(0, manifestEntries.length, ...pinWrites(manifestEntries, clientHomeProvisioning, work));")).toBeGreaterThan(call);
    expect(src.indexOf("const manifest: Manifest = { folders: [...homeFolders, ...shimFolders], entries: manifestEntries };")).toBeGreaterThan(call);
    expect(src).toContain("command: signedInLaunchers?.provision.path ?? launcher, folders: homeFolders, provisionDir: provisionCwd, root: work,");
    expect(src).toContain("    clientHomeProvisioning,\n");
  });
});
