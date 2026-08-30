import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { E2ECliFixture, CLI_PATH } from "../helpers/e2e-cli.js";

// ISS-748 regression suite. Runs against the BUILT bundle: `npm run build` must
// have produced a current dist/cli.js before this file can pass (same dependency
// as merge-driver-e2e.test.ts). The dist bundle must resolve its OWN baked version
// for the team minCliVersion write gate, in both a monorepo checkout and a real
// node_modules install layout, where the old relative ../../package.json resolution
// read the wrong file (workspace root) or nothing at all (installed package).

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = CLI_PATH;
const bakedVersion = (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
  version: string;
}).version;

// ISS-1091: isolated HOME/CODEX_HOME/STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME.
// This file's `runCli` accepts an arbitrary CLI script path (one test spawns a
// copy staged under a fake node_modules install, not always CLI_PATH), which
// runE2ECli's fixed CLI_PATH can't express -- so it stays a bespoke spawnSync
// wrapper built directly on fixture.env() rather than routed through
// runE2ECli, unified onto the SAME fixture instance as everything else here.
let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

// Returns stdout only (fix direction d) on both the success and failure path.
function runCli(cliJs: string, cwd: string, ...args: string[]): { code: number; out: string } {
  const result = spawnSync("node", [cliJs, ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: fixture.env(),
    timeout: 30_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  fixture.recordResult({ stdout, stderr });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, out: stdout };
}

function createTeamProject(minCliVersion: string, schemaVersion = 2): string {
  const dir = mkdtempSync(join(tmpdir(), "teamcap-e2e-"));
  const story = join(dir, ".story");
  for (const d of ["tickets", "issues", "handovers", "notes", "lessons"]) {
    mkdirSync(join(story, d), { recursive: true });
  }
  writeFileSync(
    join(story, "config.json"),
    JSON.stringify(
      {
        version: 2,
        schemaVersion,
        project: "teamcap-e2e",
        type: "npm",
        language: "ts",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
        team: { enabled: true, minCliVersion },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(story, "roadmap.json"),
    JSON.stringify(
      {
        title: "teamcap-e2e",
        date: "2026-01-01",
        phases: [{ id: "p0", label: "PHASE 0", name: "Setup", description: "Setup." }],
        blockers: [],
      },
      null,
      2,
    ) + "\n",
  );
  return dir;
}

describe("ISS-748: dist bundle resolves its own version for the team write gate", () => {
  it("monorepo context: write succeeds when minCliVersion equals the CLI's own version", () => {
    const dir = createTeamProject(bakedVersion);
    const r = runCli(cliPath, dir, "ticket", "create", "--title", "probe", "--type", "task");
    expect(r.out).not.toContain("Cannot verify");
    expect(r.code).toBe(0);
  });

  it("gate still fires and reports the real resolved version when below minimum", () => {
    const dir = createTeamProject("999.0.0");
    const r = runCli(cliPath, dir, "ticket", "create", "--title", "probe", "--type", "task");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("999.0.0");
    // Pins the resolved-version path: on the broken build this reported 0.0.1
    // (workspace root manifest) or "Cannot verify" instead.
    expect(r.out).toContain(`current CLI is ${bakedVersion}`);
  });

  it("real install layout (node_modules/@storybloq/storybloq/dist) resolves without ../../package.json", () => {
    const stage = mkdtempSync(join(tmpdir(), "teamcap-install-"));
    const pkgDir = join(stage, "node_modules", "@storybloq", "storybloq");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    copyFileSync(cliPath, join(pkgDir, "dist", "cli.js"));
    copyFileSync(join(pkgRoot, "package.json"), join(pkgDir, "package.json"));
    // The bundle externalizes runtime deps (zod, yargs, ...), so a real install has
    // them under the package's node_modules; borrow the workspace's. The property
    // under test is preserved: ../../package.json from dist/ is still absent.
    symlinkSync(join(pkgRoot, "node_modules"), join(pkgDir, "node_modules"), "dir");

    const dir = createTeamProject(bakedVersion);
    const r = runCli(join(pkgDir, "dist", "cli.js"), dir, "ticket", "create", "--title", "probe", "--type", "task");
    expect(r.out).not.toContain("Cannot verify");
    expect(r.code).toBe(0);
  });

  it("team doctor surfaces the real resolved version on a mismatched project", () => {
    const dir = createTeamProject("999.0.0");
    const r = runCli(cliPath, dir, "team", "doctor", "--format", "json");
    // The load-time version gate fires before runDoctor, so the doctor's own
    // cli_version_mismatch finding is unreachable in this state (filed as its own
    // issue); what MUST hold is that the dist bundle resolved its real version.
    // On the broken build this reported the workspace-root version (0.0.1) or
    // "Cannot verify" instead.
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("999.0.0");
    expect(r.out).toContain(`current CLI is ${bakedVersion}`);
  });
});

// ISS-751: team-init stamps schemaVersion 3 as the old-client fence. The dist
// bundle under test must READ and WRITE schemaVersion-3 team projects, and must
// hard-fail on 4. The other half of the fence is empirical and cannot run in this
// suite (no npm install here): published 1.4.4 was manually verified to hard-fail
// on schemaVersion 3 for both reads and writes with "Config schemaVersion 3
// exceeds max supported 2" and exit code 1. That manual verification is the
// foundation this bump relies on.
describe("ISS-751: schemaVersion-3 old-client fence on the dist bundle", () => {
  it("reads AND writes a schemaVersion-3 team project when minCliVersion matches", () => {
    const dir = createTeamProject(bakedVersion, 3);

    const read = runCli(cliPath, dir, "status");
    expect(read.out).not.toContain("exceeds max supported");
    expect(read.code).toBe(0);

    const write = runCli(cliPath, dir, "ticket", "create", "--title", "probe", "--type", "task");
    expect(write.out).not.toContain("exceeds max supported");
    expect(write.code).toBe(0);
  });

  it("hard-fails on a schemaVersion-4 project with version_mismatch", () => {
    const dir = createTeamProject(bakedVersion, 4);

    const read = runCli(cliPath, dir, "status");
    expect(read.code).not.toBe(0);
    expect(read.out).toContain("exceeds max supported");

    const write = runCli(cliPath, dir, "ticket", "create", "--title", "probe", "--type", "task");
    expect(write.code).not.toBe(0);
    expect(write.out).toContain("exceeds max supported");
  });
});

describe("ISS-753/ISS-758: CLI error paths propagate a nonzero process exit code", () => {
  it("ticket move with a nonexistent ticket exits 1", () => {
    const dir = createTeamProject(bakedVersion);
    const r = runCli(cliPath, dir, "ticket", "move", "T-999", "--after", "T-001");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not found");
  });

  it("gc with a garbage --retention-days exits 1", () => {
    const dir = createTeamProject(bakedVersion);
    const r = runCli(cliPath, dir, "gc", "--retention-days", "garbage");
    expect(r.code).toBe(1);
    expect(r.out).toContain("retention-days");
  });
});

describe("ISS-736: update banner stays out of non-interactive stderr", () => {
  function warmCacheHome(): string {
    const home = mkdtempSync(join(tmpdir(), "banner-home-"));
    const cacheDir = join(home, ".claude", "storybloq");
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, "update-check.json");
    // latestVersion far above the baked version; fetchedAt fresh (24h TTL).
    writeFileSync(cacheFile, JSON.stringify({ latestVersion: "99.0.0", fetchedAt: Date.now() }) + "\n");
    // Housekeeping's unawaited background registry fetch overwrites this file
    // within a single run when online (observed live); writeCache is
    // best-effort, so a read-only file keeps the fixture authoritative.
    chmodSync(cacheFile, 0o444);
    return home;
  }

  // spawnSync (NOT execFileSync): stderr must be observable on exit-0 paths
  // too; execFileSync exposes it only via the thrown error object, which made
  // the first version of these assertions vacuously pass on any build.
  //
  // ISS-1091: DELIBERATE EXCEPTION TO F12, not a bypass -- these tests exist
  // specifically to seed a controlled, non-fixture HOME with a pre-warmed
  // stale update-check cache; the update-banner assertions below depend on
  // that exact HOME, so fixture.env({HOME: home}) (which correctly keeps
  // REJECTING a HOME override, per F12) cannot be used here. Instead this
  // takes the fixture's isolated CODEX_HOME/STORYBLOQ_GLOBAL_DIR/
  // XDG_CONFIG_HOME/STORYBLOQ_DISABLE_WAKER_SPAWN (via fixture.env()) and
  // overrides only HOME/USERPROFILE on the resulting object, rather than
  // going through fixture.env()'s own override parameter (which rejects a
  // HOME override outright, by design, to stop a call site from silently
  // widening its OWN isolation boundary -- not applicable here, since this
  // reuses the fixture's other isolated paths and only swaps in a second,
  // equally-scratch HOME of its own).
  function runWithHome(home: string, cwd: string, ...args: string[]): { status: number | null; stderr: string } {
    const r = spawnSync("node", [cliPath, ...args], {
      cwd,
      encoding: "utf-8",
      env: { ...fixture.env(), HOME: home, USERPROFILE: home },
    });
    fixture.recordResult({ stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("piped status emits no banner despite a warmed stale cache", () => {
    const home = warmCacheHome();
    const dir = createTeamProject(bakedVersion);
    const r = runWithHome(home, dir, "status");
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/is available|99\.0\.0/i);
  });

  it("merge-driver invocation emits no banner despite a warmed stale cache", () => {
    const home = warmCacheHome();
    const stage = mkdtempSync(join(tmpdir(), "banner-md-"));
    const ticket = JSON.stringify({ id: "T-001", title: "t", description: "", type: "task", status: "open", phase: "p0", order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null }) + "\n";
    const mk = (name: string, content: string) => {
      const p = join(stage, name);
      writeFileSync(p, content);
      return p;
    };
    const base = mk("base.json", ticket);
    const ours = mk("ours.json", ticket);
    const theirs = mk("theirs.json", ticket);
    const r = runWithHome(home, stage, "merge-driver", base, ours, theirs, "tickets/T-001.json");
    expect(r.stderr).not.toMatch(/is available|99\.0\.0/i);
  });
});
