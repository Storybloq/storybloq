/**
 * T-538 commit 2c, plan 5.6: the manifest of the client's configuration, the check before every turn, the
 * project scan with its git keys, and the attempt tree's ancestors.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ancestorProblems, CODEX_STATE_DIRS, configProblems, credentialLinkEntry, fileEntry, gitConfigKeys, gitKeyProblems, PROJECT_FORBIDDEN, projectScanProblems, treeEntries,
  type Manifest, type ManifestEntry,
} from "../../scripts/onboarding-eval-config.js";
import { codexTrustTable, Collector, isolationProblems } from "../../scripts/onboarding-eval-run.js";
import { GIT_CONFIG_MAX_BYTES } from "../../scripts/onboarding-eval-config.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync as f8Read, renameSync as f7Rename } from "node:fs";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "t538cfg-"))); dirs.push(d); return d; };

/** A Codex client home as the runner provisions it: the auth link (to a path never created), config.toml, the skill, the state folders. */
function codexHome(): { home: string; manifest: Manifest } {
  const home = join(scratch(), "client-home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "story", "refs"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "story", "SKILL.md"), "skill\n");
  writeFileSync(join(home, ".agents", "skills", "story", "refs", "a.md"), "a\n");
  symlinkSync("/nonexistent/auth.json", join(home, ".codex", "auth.json"));
  writeFileSync(join(home, ".codex", "config.toml"), "model = \"m\"\n");
  const entries: ManifestEntry[] = [
    credentialLinkEntry(join(home, ".codex", "auth.json")), fileEntry(join(home, ".codex", "config.toml")), ...treeEntries(join(home, ".agents", "skills", "story")),
    ...CODEX_STATE_DIRS.map((d): ManifestEntry => ({ kind: "runtime-dir", path: join(home, ".codex", d) })),
  ];
  return { home, manifest: { folders: [home], entries } };
}

describe("the manifest check before every turn (5.6)", () => {
  it("holds as provisioned; the auth link's target is never needed", () => {
    expect(configProblems(codexHome().manifest)).toEqual([]);
  });

  it("Codex's own state is allowed: its folders with any content, its sqlite files, its installation id", () => {
    const { home, manifest } = codexHome();
    mkdirSync(join(home, ".codex", "sessions", "2026", "11"), { recursive: true });
    writeFileSync(join(home, ".codex", "sessions", "2026", "11", "rollout.jsonl"), "{}\n");
    for (const f of ["state_5.sqlite", "state_5.sqlite-shm", "state_5.sqlite-wal", "logs_2.sqlite", "installation_id", ".sandbox_migration"]) writeFileSync(join(home, ".codex", f), "");
    mkdirSync(join(home, ".codex", "skills", ".system"), { recursive: true });
    expect(configProblems(manifest)).toEqual([]);
  });

  it("a skill file edited, a config chmod, a config replaced by a link, each is named", () => {
    const { home, manifest } = codexHome();
    writeFileSync(join(home, ".agents", "skills", "story", "refs", "a.md"), "b\n");
    chmodSync(join(home, ".codex", "config.toml"), 0o666);
    expect(configProblems(manifest)).toEqual([`config: ${join(home, ".codex", "config.toml")} changed mode`, `config: ${join(home, ".agents", "skills", "story", "refs", "a.md")} changed`]);
    rmSync(join(home, ".codex", "config.toml"));
    symlinkSync("/etc/hosts", join(home, ".codex", "config.toml"));
    expect(configProblems(manifest)).toContain(`config: ${join(home, ".codex", "config.toml")} is not a regular file`);
  });

  it("the auth link pointed elsewhere, or made a file, is not the credential link", () => {
    const { home, manifest } = codexHome();
    rmSync(join(home, ".codex", "auth.json"));
    symlinkSync("/nonexistent/other.json", join(home, ".codex", "auth.json"));
    expect(configProblems(manifest)).toEqual([`config: ${join(home, ".codex", "auth.json")} is not the credential link`]);
    rmSync(join(home, ".codex", "auth.json"));
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    expect(configProblems(manifest)).toEqual([`config: ${join(home, ".codex", "auth.json")} is not the credential link`]);
  });

  it("an extra file anywhere in the folder, an unknown state name, a new skill file, each is not in the manifest", () => {
    const { home, manifest } = codexHome();
    writeFileSync(join(home, ".codex", "hooks.json"), "{}");
    writeFileSync(join(home, ".codex", "notes.sqlite"), "");
    writeFileSync(join(home, ".agents", "skills", "story", "extra.md"), "x\n");
    mkdirSync(join(home, ".claude"));
    expect(configProblems(manifest).sort()).toEqual([
      `config: ${join(home, ".agents", "skills", "story", "extra.md")} is not in the manifest`,
      `config: ${join(home, ".claude")} is not in the manifest`,
      `config: ${join(home, ".codex", "hooks.json")} is not in the manifest`,
      `config: ${join(home, ".codex", "notes.sqlite")} is not in the manifest`,
    ]);
  });

  it("a state folder made a link or a file is not a folder; a missing file is missing", () => {
    const { home, manifest } = codexHome();
    symlinkSync("/tmp", join(home, ".codex", "sessions"));
    rmSync(join(home, ".agents", "skills", "story", "SKILL.md"));
    expect(configProblems(manifest).sort()).toEqual([
      `config: ${join(home, ".agents", "skills", "story", "SKILL.md")} is missing`,
      `config: ${join(home, ".codex", "sessions")} is not a folder`,
    ]);
  });

  it("an extra file in a Claude config folder is named", () => {
    const d = scratch();
    const cfg = join(d, "claude-config");
    mkdirSync(join(cfg, "skills", "story"), { recursive: true });
    writeFileSync(join(cfg, "skills", "story", "SKILL.md"), "s\n");
    writeFileSync(join(cfg, "settings.json"), "{}\n");
    const manifest: Manifest = { folders: [cfg], entries: [...treeEntries(join(cfg, "skills", "story")), fileEntry(join(cfg, "settings.json")), { kind: "runtime-dir", path: join(cfg, "projects") }] };
    mkdirSync(join(cfg, "projects", "x"), { recursive: true });
    writeFileSync(join(cfg, "projects", "x", "s.jsonl"), "{}\n");
    expect(configProblems(manifest)).toEqual([]);
    writeFileSync(join(cfg, "settings.local.json"), "{}\n");
    expect(configProblems(manifest)).toEqual([`config: ${join(cfg, "settings.local.json")} is not in the manifest`]);
  });

  it("the trust table is the form codex 0.163.0 appends, a blank line first", () => {
    expect(codexTrustTable("/private/var/folders/x/T/sbq-eval/a-1/project")).toBe('\n[projects."/private/var/folders/x/T/sbq-eval/a-1/project"]\ntrust_level = "trusted"\n');
  });
});

describe("the project scan (5.6)", () => {
  function project(): string {
    const p = join(scratch(), "project");
    mkdirSync(join(p, ".git", "hooks"), { recursive: true });
    mkdirSync(join(p, "src", "deep", "er"), { recursive: true });
    writeFileSync(join(p, ".git", "hooks", "pre-commit.sample"), "#!/bin/sh\n");
    writeFileSync(join(p, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote \"origin\"]\n\turl = x\n");
    return p;
  }

  it("a fresh project with sample hooks and plain keys is clean", () => {
    expect(projectScanProblems(project())).toEqual([]);
  });

  it("F7: a .git that is a link is refused, and so is one the walk would skip", () => {
    const p = project();
    const real = join(scratch(), "elsewhere.git");
    f7Rename(join(p, ".git"), real);
    symlinkSync(real, join(p, ".git"));
    expect(projectScanProblems(p)).toEqual([`project: ${join(p, ".git")}: a link`]);
  });

  it("F7: a .git indirection file is refused", () => {
    const p = project();
    rmSync(join(p, ".git"), { recursive: true });
    writeFileSync(join(p, ".git"), "gitdir: /elsewhere/.git\n");
    expect(projectScanProblems(p)).toEqual([`project: ${join(p, ".git")}: a git indirection file`]);
  });

  it("F7: a .git/config and a .git/hooks that are links are each refused", () => {
    const p = project();
    const side = scratch();
    writeFileSync(join(side, "config"), "[core]\n\tfsmonitor = /bin/evil\n");
    mkdirSync(join(side, "hooks"));
    writeFileSync(join(side, "hooks", "pre-commit"), "#!/bin/sh\n");
    rmSync(join(p, ".git", "config"));
    symlinkSync(join(side, "config"), join(p, ".git", "config"));
    expect(projectScanProblems(p)).toEqual([`project: ${join(p, ".git", "config")}: a link`]);
    rmSync(join(p, ".git", "hooks"), { recursive: true });
    symlinkSync(join(side, "hooks"), join(p, ".git", "hooks"));
    expect(projectScanProblems(p).sort()).toEqual([`project: ${join(p, ".git", "config")}: a link`, `project: ${join(p, ".git", "hooks")}: a link`]);
  });

  it("F8: a git config over the byte cap is not scanned and is a scan failure; one at the cap is scanned", () => {
    const p = project();
    const at = "[core]\n" + "#".repeat(GIT_CONFIG_MAX_BYTES - 8) + "\n";
    writeFileSync(join(p, ".git", "config"), at);
    expect(Buffer.byteLength(at)).toBe(GIT_CONFIG_MAX_BYTES);
    expect(projectScanProblems(p)).toEqual([]);
    writeFileSync(join(p, ".git", "config"), at + "x");
    expect(projectScanProblems(p)).toEqual([`project: ${join(p, ".git", "config")}: over ${GIT_CONFIG_MAX_BYTES} bytes, not scanned (a scan failure)`]);
  });

  it("F8: the runner's project scan runs in a collector process under its deadline, with the same findings", async () => {
    const p = project();
    writeFileSync(join(p, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
    const PKGDIR = fileURLToPath(new URL("../..", import.meta.url));
    const c = new Collector(scratch(), { execArgv: ["--import", pathToFileURL(join(PKGDIR, "node_modules", "tsx", "dist", "loader.mjs")).href] });
    expect(await c.projectScan(p)).toEqual(projectScanProblems(p));
    expect(await c.projectScan(p)).toEqual([`project: ${join(p, ".git", "hooks", "post-checkout")}: a git hook`]);
    const hang = join(scratch(), "hang.mjs");
    writeFileSync(hang, "setInterval(() => {}, 1000);\n");
    await expect(new Collector(scratch(), { deadlineMs: 1000, script: hang }).projectScan(p)).rejects.toThrow(/passed its 1000 ms deadline/);
    expect(f8Read(hang, "utf-8")).toContain("setInterval");
  }, 60_000);

  it.each(PROJECT_FORBIDDEN.flatMap((name) => [[name, ""], [name, join("src", "deep", "er")]]))("%s at depth '%s' is named", (name, at) => {
    const p = project();
    writeFileSync(join(p, at, name), "{}\n");
    expect(projectScanProblems(p)).toEqual([`project: ${join(p, at, name)}: a client loads this name`]);
  });

  it("a hook that is not a sample is named; a folder of the name is named too", () => {
    const p = project();
    writeFileSync(join(p, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
    mkdirSync(join(p, "src", ".codex"));
    expect(projectScanProblems(p).sort()).toEqual([`project: ${join(p, ".git", "hooks", "post-checkout")}: a git hook`, `project: ${join(p, "src", ".codex")}: a client loads this name`]);
  });

  it.each([
    ["[core]\n\tfsmonitor = /x\n", "core.fsmonitor"],
    ["[core]\n\thooksPath = /x\n", "core.hookspath"],
    ["[core]\n\tsshCommand = ssh -o x\n", "core.sshcommand"],
    ["[core]\n\tpager = less\n", "core.pager"],
    ["[diff]\n\texternal = /x\n", "diff.external"],
    ["[filter \"lfs\"]\n\tclean = x %f\n", "filter.lfs.clean"],
    ["[alias]\n\tco = !sh -c x\n", "alias.co"],
    ["[include]\n\tpath = /x\n", "include.path"],
    ["[includeIf \"gitdir:/x/\"]\n\tpath = /y\n", "includeif.gitdir:/x/.path"],
    ["[core] fsmonitor = /x\n", "core.fsmonitor"],
    ["[CORE]\n\tFSMonitor\n", "core.fsmonitor"],
  ])("a .git/config that sets %j is named", (text, key) => {
    const p = project();
    writeFileSync(join(p, ".git", "config"), text);
    expect(projectScanProblems(p)).toEqual([`project: ${join(p, ".git", "config")}: sets ${key}`]);
  });

  it("keys are read from the bytes: comments, other sections and values that mention a key are not keys", () => {
    expect(gitKeyProblems("# core.pager = x\n[user]\n\tname = core.pager\n; [alias]\n[branch \"main\"]\n\tremote = origin\n")).toEqual([]);
    expect(gitConfigKeys("[branch \"Main\"]\n\tremote = o\n[core]\n\tbare\n")).toEqual(["branch.Main.remote", "core.bare"]);
  });
});

describe("the attempt tree's ancestors (5.6)", () => {
  it("each name in an ancestor is named, once per ancestor; a clean chain has none", () => {
    const d = scratch();
    const tree = join(d, "a", "b", "attempt");
    mkdirSync(tree, { recursive: true });
    expect(ancestorProblems(tree).filter((p) => p.includes(d))).toEqual([]);
    mkdirSync(join(d, "a", ".agents"));
    symlinkSync("/nonexistent", join(d, "a", "b", ".mcp.json"));
    expect(ancestorProblems(tree).filter((p) => p.includes(d))).toEqual([`ancestor: ${join(d, "a", "b", ".mcp.json")}: a client loads this name`, `ancestor: ${join(d, "a", ".agents")}: a client loads this name`]);
  });
});

describe("the client environment is an allow-list (5.3, 5.6)", () => {
  it("one variable beyond the client column is named", () => {
    const work = scratch();
    const column = { PATH: "/usr/bin:/bin", HOME: join(work, "h"), TMPDIR: join(work, "t"), LANG: "C", CODEX_HOME: join(work, "h", ".codex") };
    expect(isolationProblems({ ...column }, work, "codex", column)).toEqual([]);
    expect(isolationProblems({ ...column, EDITOR: "vi" }, work, "codex", column)).toEqual(["EDITOR is not in the client column"]);
  });
});
