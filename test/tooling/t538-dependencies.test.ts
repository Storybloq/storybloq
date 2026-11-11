/**
 * T-538 commit 3, pen ruling R2 (a): a fixture's declared dependencies are installed from its lockfile at
 * provisioning, before any turn and outside the sandbox, with scripts off, and recorded. Every row runs offline:
 * the packages are local (`file:`), so no registry is reached.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installFixtureDependencies } from "../../scripts/onboarding-eval-run.js";
import { parseTreeSnap, preservationFindings, provisionedLockfiles, treeSnapshot } from "../../scripts/onboarding-eval-preserve.js";
import type { EventsLog } from "../../scripts/onboarding-eval-checkset7-events.js";
import { digestChanges, treeDigest } from "../../scripts/onboarding-eval-lib.js";

const PKG = join(__dirname, "..", "..");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "t538dep-"))); dirs.push(d); return d; };
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const put = (p: string, text: string): void => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const pkg = (name: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ name, version: "1.0.0", private: true, ...extra }, null, 2)}\n`;

/** A lockfile for `dir` from its package.json, written by npm offline (its packages are local folders). */
function lock(dir: string, home: string): void {
  const npm = join(dirname(process.execPath), "npm");
  const r = spawnSync(npm, ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
    cwd: dir, encoding: "utf-8", env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, npm_config_cache: join(home, "cache") },
  });
  expect(r.status, r.stderr).toBe(0);
}

/** A project with a frontend whose one dependency is a local package carrying an install script that leaves a marker. */
function project(): { root: string; front: string; marker: string; home: string } {
  const d = scratch();
  const root = join(d, "project");
  const front = join(root, "frontend");
  const marker = join(d, "script-ran");
  put(join(front, "vendor", "tick", "package.json"), pkg("tick", { scripts: { install: `touch ${marker}`, postinstall: `touch ${marker}` } }));
  put(join(front, "package.json"), pkg("front", { scripts: { install: `touch ${marker}`, test: "node -e 0" }, devDependencies: { tick: "file:./vendor/tick" } }));
  put(join(root, "backend", "pyproject.toml"), "[project]\nname = \"b\"\n");
  const home = join(d, "home");
  lock(front, home);
  return { root, front, marker, home };
}

describe("R2 (a): the fixture's dependencies from its lockfile, at provisioning", () => {
  it("each folder with a lockfile gets npm ci: the record names the folder, the lockfile's sha256, the exit and the installed count", () => {
    const p = project();
    const lockSha = sha(join(p.front, "package-lock.json"));
    const installs = installFixtureDependencies(p.root, join(dirname(p.root), "prov"), null);
    expect(installs).toEqual([{ path: "frontend", lockfileSha256: lockSha, exit: 0, packages: 2, copied: false }]);
    expect(existsSync(join(p.front, "node_modules", "tick", "package.json"))).toBe(true);
    // The lockfile is the fixture's, unchanged by the install.
    expect(sha(join(p.front, "package-lock.json"))).toBe(lockSha);
  });
  it("scripts stay off: neither the project's nor a dependency's install scripts run", () => {
    const p = project();
    installFixtureDependencies(p.root, join(dirname(p.root), "prov"), null);
    expect(existsSync(p.marker)).toBe(false);
  });
  it("npm runs with a scratch HOME and cache under the given folder, never the caller's", () => {
    const p = project();
    const prov = join(dirname(p.root), "prov");
    installFixtureDependencies(p.root, prov, null);
    expect(existsSync(join(prov, "npm-home"))).toBe(true);
    expect(existsSync(join(prov, "npm-cache"))).toBe(true);
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8");
    const body = src.slice(src.indexOf("export function installFixtureDependencies"), src.indexOf("/** PATH with every `codex` executable removed"));
    expect(body).toContain(`HOME: npmHome, TMPDIR: npmHome, npm_config_cache: join(scratch, "npm-cache"), npm_config_update_notifier: "false" },`);
    expect(body).not.toMatch(/process\.env/);
  });
  it("a package.json that declares dependencies and ships no lockfile stops provisioning by cause, before any install", () => {
    const p = project();
    rmSync(join(p.front, "package-lock.json"));
    expect(() => installFixtureDependencies(p.root, join(dirname(p.root), "prov"), null)).toThrow("onboarding-eval: provisioning: dependencies: frontend/package.json declares dependencies and the fixture ships no package-lock.json");
    expect(existsSync(join(p.front, "node_modules"))).toBe(false);
  });
  it("a failed npm ci (the lockfile out of step with package.json) stops provisioning by cause, with the exit", () => {
    const p = project();
    put(join(p.front, "vendor", "tock", "package.json"), pkg("tock"));
    put(join(p.front, "package.json"), pkg("front", { devDependencies: { tick: "file:./vendor/tick", tock: "file:./vendor/tock" } }));
    expect(() => installFixtureDependencies(p.root, join(dirname(p.root), "prov"), null)).toThrow(/^onboarding-eval: provisioning: dependencies: npm ci in frontend failed \(exit \d+\)/);
  });
  it("a package.json with no dependencies and no lockfile needs nothing; .git, .story and node_modules are not searched", () => {
    const d = scratch();
    const root = join(d, "project");
    put(join(root, "package.json"), pkg("plain", { dependencies: {} }));
    for (const skip of [".git", ".story", "node_modules/x"]) put(join(root, skip, "package.json"), pkg("skip", { dependencies: { left: "1.0.0" } }));
    expect(installFixtureDependencies(root, join(d, "prov"), null)).toEqual([]);
  });
  it("mixed-stack ships its frontend lockfile, and no other fixture declares dependencies without one", () => {
    const fixtures = join(PKG, "test", "fixtures", "onboarding");
    const lockfile = JSON.parse(readFileSync(join(fixtures, "mixed-stack", "lockfiles", "frontend", "package-lock.json"), "utf-8")) as { lockfileVersion: number; packages: Record<string, { resolved?: string }> };
    expect(lockfile.lockfileVersion).toBe(3);
    expect(existsSync(join(fixtures, "mixed-stack", "project", "frontend", "package-lock.json"))).toBe(false);
    expect(Object.keys(lockfile.packages)).toEqual(expect.arrayContaining(["", "node_modules/vite", "node_modules/vitest"]));
    for (const [k, v] of Object.entries(lockfile.packages)) if (k !== "" && v.resolved !== undefined) expect(v.resolved, k).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    // Every package.json in every fixture project either declares nothing or has its lockfile beside it.
    const walk = (dir: string): string[] => spawnSync("/usr/bin/find", [dir, "-name", "package.json", "-not", "-path", "*/node_modules/*"], { encoding: "utf-8" }).stdout.split("\n").filter(Boolean);
    for (const f of walk(fixtures)) {
      const j = JSON.parse(readFileSync(f, "utf-8")) as Record<string, Record<string, string> | undefined>;
      const declared = ["dependencies", "devDependencies", "optionalDependencies"].some((k) => Object.keys(j[k] ?? {}).length > 0);
      const lockfiles = f.replace(/\/project\/(.*)package\.json$/, "/lockfiles/$1package-lock.json");
      if (declared) expect(existsSync(join(dirname(f), "package-lock.json")) || existsSync(lockfiles), f).toBe(true);
    }
  });
  it("the runner installs right after the fixture copy, before anything is launched, and records each install", () => {
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8");
    const copy = src.indexOf("const project = materializeFixture(o.fixture, work);");
    const install = src.indexOf("const dependencyInstalls = installFixtureDependencies(project, join(work, \"npm-provision\"), join(FIXTURES, o.fixture, \"lockfiles\"));");
    expect(copy).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(copy);
    expect(src.slice(copy, install)).toBe("const project = materializeFixture(o.fixture, work);\n  // R2 (a): the fixture's declared dependencies, from its lockfile, before any turn and outside the sandbox.\n  ");
    expect(install).toBeLessThan(src.indexOf("installCliLauncher(", copy));
    // The first turn's starting digest is taken after the install, so the copied lockfile is starting state.
    expect(install).toBeLessThan(src.indexOf("const before = await collector.digest(project);", copy));
    expect(src).toContain("protectedPaths: [...protectedPathsOf(fixtureEvidence(join(fixtureDir, \"project\")).hashes), ...provisionedLockfiles(dependencyInstalls)].sort() };");
    expect(readFileSync(join(PKG, "scripts", "onboarding-eval-regrade.ts"), "utf-8")).toContain("protectedPaths: [...protectedPathsOf(input.fixture.files), ...provisionedLockfiles(record.dependencyInstalls)].sort() },");
    expect(src).toMatch(/route: "host-v2",\n\s+\/\/ R2 \(a\)[^\n]*\n\s+dependencyInstalls,\n/);
  });
});

/** No fault fired: an empty events log. */
const NO_LOG: EventsLog = { attempts: [], events: [], overlaps: [], fired: [] };

/** A fixture laid out as the harness reads it: `project/` without the lockfile, `lockfiles/frontend/` with it. */
function fixture(): { fx: string; copy: string; prov: string; lockSha: string } {
  const p = project();
  const fx = dirname(p.root);
  mkdirSync(join(fx, "lockfiles", "frontend"), { recursive: true });
  writeFileSync(join(fx, "lockfiles", "frontend", "package-lock.json"), readFileSync(join(p.front, "package-lock.json")));
  rmSync(join(p.front, "package-lock.json"));
  const copy = join(fx, "copy");
  spawnSync("/bin/cp", ["-R", p.root, copy]);
  return { fx, copy, prov: join(fx, "prov"), lockSha: sha(join(fx, "lockfiles", "frontend", "package-lock.json")) };
}

describe("R2 (a) location ruling: the lockfile lives beside the project and is copied in at provisioning", () => {
  it("lockfiles/frontend/package-lock.json is copied into the copy's frontend and installed; the fixture's project is left as it was", () => {
    const f = fixture();
    const installs = installFixtureDependencies(f.copy, f.prov, join(f.fx, "lockfiles"));
    expect(installs).toEqual([{ path: "frontend", copied: true, lockfileSha256: f.lockSha, exit: 0, packages: 2 }]);
    expect(sha(join(f.copy, "frontend", "package-lock.json"))).toBe(f.lockSha);
    expect(existsSync(join(f.fx, "project", "frontend", "package-lock.json"))).toBe(false);
    expect(provisionedLockfiles(installs)).toEqual(["frontend/package-lock.json"]);
  });
  it("a lockfile for a project folder that does not exist is a provisioning failure by cause", () => {
    const f = fixture();
    mkdirSync(join(f.fx, "lockfiles", "web"));
    writeFileSync(join(f.fx, "lockfiles", "web", "package-lock.json"), "{}\n");
    expect(() => installFixtureDependencies(f.copy, f.prov, join(f.fx, "lockfiles"))).toThrow("onboarding-eval: provisioning: dependencies: lockfiles/web/package-lock.json is for the project folder web, which does not exist");
  });
  it("P3: a lockfile for a project folder with no package.json, or with a link in its place, is a provisioning failure by cause, before any install", () => {
    const f = fixture();
    mkdirSync(join(f.copy, "web"));
    mkdirSync(join(f.fx, "lockfiles", "web"));
    writeFileSync(join(f.fx, "lockfiles", "web", "package-lock.json"), "{}\n");
    expect(() => installFixtureDependencies(f.copy, f.prov, join(f.fx, "lockfiles"))).toThrow("onboarding-eval: provisioning: dependencies: lockfiles/web/package-lock.json is for the project folder web, which holds no package.json");
    expect(existsSync(join(f.copy, "frontend", "node_modules"))).toBe(false);
    const g = fixture();
    mkdirSync(join(g.copy, "web"));
    symlinkSync(join(g.copy, "frontend", "package.json"), join(g.copy, "web", "package.json"));
    mkdirSync(join(g.fx, "lockfiles", "web"));
    writeFileSync(join(g.fx, "lockfiles", "web", "package-lock.json"), "{}\n");
    expect(() => installFixtureDependencies(g.copy, g.prov, join(g.fx, "lockfiles"))).toThrow("lockfiles/web/package-lock.json is for the project folder web, which holds no package.json");
  });
  it("P3: a lockfile copied into a folder the install search does not reach is a provisioning failure, never a silent skip", () => {
    const f = fixture();
    mkdirSync(join(f.copy, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(f.copy, "node_modules", "pkg", "package.json"), pkg("pkg"));
    mkdirSync(join(f.fx, "lockfiles", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(f.fx, "lockfiles", "node_modules", "pkg", "package-lock.json"), "{}\n");
    expect(() => installFixtureDependencies(f.copy, f.prov, join(f.fx, "lockfiles"))).toThrow("onboarding-eval: provisioning: dependencies: lockfiles/node_modules/pkg/package-lock.json was copied into node_modules/pkg and nothing was installed from it");
  });
  it("a lockfile where the project already ships one, or anything else under lockfiles/, is a provisioning failure by cause", () => {
    const f = fixture();
    writeFileSync(join(f.copy, "frontend", "package-lock.json"), "{}\n");
    expect(() => installFixtureDependencies(f.copy, f.prov, join(f.fx, "lockfiles"))).toThrow("onboarding-eval: provisioning: dependencies: lockfiles/frontend/package-lock.json and the project's own frontend/package-lock.json both exist");
    const g = fixture();
    writeFileSync(join(g.fx, "lockfiles", "frontend", "notes.txt"), "x\n");
    expect(() => installFixtureDependencies(g.copy, g.prov, join(g.fx, "lockfiles"))).toThrow("onboarding-eval: provisioning: dependencies: lockfiles/frontend/notes.txt is not a package-lock.json");
  });
  it("an untouched run shows no lockfile change: the turn digest and the preservation rules both start from the provisioned copy", () => {
    const f = fixture();
    const installs = installFixtureDependencies(f.copy, f.prov, join(f.fx, "lockfiles"));
    const before = treeDigest(f.copy);
    expect(before["frontend/package-lock.json"]).toBeDefined();
    expect(digestChanges(before, treeDigest(f.copy))).toEqual([]);
    const snap = parseTreeSnap(treeSnapshot(f.copy));
    expect(Object.keys(snap.files).some((k) => k.includes("node_modules"))).toBe(false);
    const lines = preservationFindings("v", { baseline: snap, end: parseTreeSnap(treeSnapshot(f.copy)), protectedPaths: provisionedLockfiles(installs), selector: "bootstrap:publish", firedLine: Number.POSITIVE_INFINITY, log: NO_LOG });
    expect(lines.filter((l) => l.includes("package-lock"))).toEqual([]);
  });
  it("a run where the model edits the copied lockfile shows that edit, in the turn digest and as a protected file", () => {
    const f = fixture();
    const installs = installFixtureDependencies(f.copy, f.prov, join(f.fx, "lockfiles"));
    const before = treeDigest(f.copy);
    const baseline = parseTreeSnap(treeSnapshot(f.copy));
    writeFileSync(join(f.copy, "frontend", "package-lock.json"), "{\"edited\":true}\n");
    expect(digestChanges(before, treeDigest(f.copy))).toEqual(["frontend/package-lock.json"]);
    const lines = preservationFindings("v", { baseline, end: parseTreeSnap(treeSnapshot(f.copy)), protectedPaths: provisionedLockfiles(installs), selector: "bootstrap:publish", firedLine: Number.POSITIVE_INFINITY, log: NO_LOG });
    expect(lines.filter((l) => l.includes("package-lock"))).toEqual(["v: frontend/package-lock.json changed after the baseline"]);
  });
  it("only copied lockfiles are provisioned paths: a project-shipped one is the fixture's own, and other shapes give none", () => {
    expect(provisionedLockfiles([{ path: ".", copied: true }, { path: "a/b", copied: true }, { path: "c", copied: false }])).toEqual(["package-lock.json", "a/b/package-lock.json"]);
    expect(provisionedLockfiles(undefined)).toEqual([]);
    expect(provisionedLockfiles([null, { path: 1, copied: true }])).toEqual([]);
  });
});
