/**
 * T-486 T0 and CK4 against published CLIs. The kind and evidence keys are
 * plain passthrough keys, so every pinned old dist must load a board that
 * carries them, validate it, and keep them byte-for-byte through a strict
 * write. And once this build's team setup has raised the fence and the ledger
 * is committed, the pre-capability CLI in a fresh clone of it, which has no
 * driver registration of its own, must refuse to write at all.
 * Dists come from the prefix `npm run compat:fetch` installs (old-dists.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, gitAllowFailure } from "../helpers/git-fixture.js";
import { initProject } from "../../src/core/init.js";
import { handleIssueCreate, handleIssueUpdate } from "../../src/cli/commands/issue.js";
import { MERGE_DRIVER_V4_NAME, MERGE_DRIVER_V5_NAME, teamSetup } from "../../src/core/team-setup.js";
import { RESOLUTION_KIND_MIN_CLI_VERSION, TEAM_FENCE_MINIMUMS, meetsVersionMinimum } from "../../src/core/team-capabilities.js";
import { LATEST_PUBLISHED, OLD_DISTS, PRE_CAPABILITY, requireOldDists } from "./old-dists.js";

const { dists, skip } = requireOldDists(OLD_DISTS.map((d) => d.version));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "t486-oldledger-"));
  dirs.push(d);
  return d;
}

function run(bin: string, cwd: string, home: string, ...args: string[]) {
  return spawnSync(bin, args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
}

/** A resolved issue carrying a kind and bound evidence, as a 1.16 client writes them. */
const ISSUE = {
  id: "ISS-001", title: "Synthetic issue", status: "resolved", severity: "medium", components: [], impact: "synthetic",
  resolution: "Closed as wontfix.", location: [], discoveredDate: "2026-01-01", resolvedDate: "2026-01-02", relatedTickets: [],
  order: 10, phase: null,
  resolutionKind: { kind: "wontfix", closedOn: "2026-01-02", resolutionDigest: "0123456789abcdef" },
  disposition: "owner_gated", dispositionReason: "pricing is the owner's call", dispositionRef: "ISS-002", dispositionFor: "owner_gated",
};
const T486_KEYS = ["resolutionKind", "disposition", "dispositionReason", "dispositionRef", "dispositionFor"] as const;

describe.skipIf(skip !== null)(`published CLIs on a board with resolution kinds${skip ? ` (${skip})` : ""}`, () => {
  it.each(dists.map((d) => [d.version, d.bin]))("T0: %s validates the board and keeps every kind and evidence key through a strict update", (version, bin) => {
    const root = temp();
    const home = join(root, "home");
    mkdirSync(home);
    expect(run(bin, root, home, "init", "--name", "t486").status).toBe(0);
    const path = join(root, ".story", "issues", "ISS-001.json");
    writeFileSync(path, JSON.stringify(ISSUE, null, 2) + "\n");

    const validate = run(bin, root, home, "validate", "--format", "json");
    expect(validate.status, validate.stdout + validate.stderr).toBe(0);
    expect(JSON.parse(validate.stdout).data).toMatchObject({ valid: true, errorCount: 0 });

    const update = run(bin, root, home, "issue", "update", "ISS-001", "--title", `retitled by ${version}`, "--format", "json");
    expect(update.status, update.stdout + update.stderr).toBe(0);
    const after = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(after.title).toBe(`retitled by ${version}`);
    for (const key of T486_KEYS) expect(after[key], key).toEqual(ISSUE[key]);
  });

  /** A board whose one issue the current handler closed with a kind, as a 1.16 user would. */
  async function handlerBoard(): Promise<{ root: string; home: string; path: string; ref: string }> {
    const root = temp();
    const home = join(root, "home");
    mkdirSync(home);
    await initProject(root, { name: "t486" });
    const created = JSON.parse(
      (await handleIssueCreate({ title: "a bug", severity: "medium", impact: "it breaks", components: [], relatedTickets: [], location: [] }, "json", root)).output,
    ).data as { id: string; displayId?: string };
    await handleIssueUpdate(created.id, { status: "resolved", resolution: "Closed as wontfix.", resolutionKind: "wontfix" }, "json", root);
    const files = readdirSync(join(root, ".story", "issues")).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    return { root, home, path: join(root, ".story", "issues", files[0]!), ref: created.displayId ?? created.id };
  }

  it.each(dists.map((d) => [d.version, d.bin]))("T1: %s validates and keeps a kind the current handler wrote", async (version, bin) => {
    const { root, home, path, ref } = await handlerBoard();
    const written = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(written.resolutionKind).toMatchObject({ kind: "wontfix", closedOn: written.resolvedDate });

    const validate = run(bin, root, home, "validate", "--format", "json");
    expect(validate.status, validate.stdout + validate.stderr).toBe(0);
    expect(JSON.parse(validate.stdout).data).toMatchObject({ valid: true, errorCount: 0 });
    const update = run(bin, root, home, "issue", "update", ref, "--title", `retitled by ${version}`, "--format", "json");
    expect(update.status, update.stdout + update.stderr).toBe(0);
    const after = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(after.title).toBe(`retitled by ${version}`);
    expect(after.resolutionKind).toEqual(written.resolutionKind);
  });

  it.each(dists.map((d) => [d.version, d.bin]))("T1b: clearing a kind writes no null, and %s still validates the cleared record", async (_version, bin) => {
    const { root, home, path, ref } = await handlerBoard();
    await handleIssueUpdate(ref, { status: "open" }, "json", root);
    const raw = readFileSync(path, "utf-8");
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(raw), "resolutionKind")).toBe(false);
    expect(raw).not.toMatch(/"resolutionKind"/);
    const validate = run(bin, root, home, "validate", "--format", "json");
    expect(validate.status, validate.stdout + validate.stderr).toBe(0);
    expect(JSON.parse(validate.stdout).data).toMatchObject({ valid: true, errorCount: 0 });
  });

  it(`CK4: a fresh clone of a ledger whose fence team setup raised refuses ${PRE_CAPABILITY}'s writes`, async () => {
    const old = dists.find((d) => d.version === PRE_CAPABILITY)!;
    const repo = temp();
    const home = join(repo, ".home");
    mkdirSync(home);
    const g = (cwd: string, ...args: string[]) => git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args]);
    g(repo, "init", "-q", "-b", "main");
    await initProject(repo, { name: "t486" });
    const configPath = join(repo, ".story", "config.json");
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf-8")), team: { enabled: true } }, null, 2) + "\n");
    await teamSetup(repo);
    const fence = JSON.parse(readFileSync(configPath, "utf-8")).team.minCliVersion as string;
    expect(meetsVersionMinimum(fence, RESOLUTION_KIND_MIN_CLI_VERSION)).toBe(true);
    writeFileSync(join(repo, ".story", "issues", "ISS-001.json"), JSON.stringify(ISSUE, null, 2) + "\n");
    writeFileSync(join(repo, ".gitignore"), ".home/\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "configured ledger");

    const parent = temp();
    const clone = join(parent, "clone");
    g(parent, "clone", "-q", repo, clone);
    // The clone carries the committed fence but none of setup's per-clone state.
    for (const name of [MERGE_DRIVER_V4_NAME, MERGE_DRIVER_V5_NAME]) {
      expect(gitAllowFailure(clone, ["config", "--local", "--get", `merge.${name}.driver`]).status, name).not.toBe(0);
    }
    const info = join(clone, git(clone, ["rev-parse", "--git-path", "info/attributes"]));
    expect(existsSync(info) ? readFileSync(info, "utf-8") : "").not.toContain("storybloq-checkpoint-local-begin");
    expect(JSON.parse(readFileSync(join(clone, ".story", "config.json"), "utf-8")).team.minCliVersion).toBe(fence);

    const path = join(clone, ".story", "issues", "ISS-001.json");
    const before = readFileSync(path);
    const cloneHome = join(parent, "home");
    mkdirSync(cloneHome);
    const update = run(old.bin, clone, cloneHome, "issue", "update", "ISS-001", "--title", "fenced", "--format", "json");
    expect(update.status).not.toBe(0);
    expect(JSON.parse(update.stdout).error).toMatchObject({ code: "version_mismatch" });
    expect(update.stdout).toContain(`requires storybloq CLI ${fence} or later; current CLI is ${PRE_CAPABILITY}`);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe("capability minimums against the published pins (Q2b)", () => {
  const packageVersion = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")).version as string;

  it("the pre-capability pin is a pinned dist, no later than the latest published, and every minimum refuses it", () => {
    expect(OLD_DISTS.map((d) => d.version)).toContain(PRE_CAPABILITY);
    expect(meetsVersionMinimum(LATEST_PUBLISHED, PRE_CAPABILITY)).toBe(true);
    expect(TEAM_FENCE_MINIMUMS).toContain(RESOLUTION_KIND_MIN_CLI_VERSION);
    for (const minimum of TEAM_FENCE_MINIMUMS) expect(meetsVersionMinimum(PRE_CAPABILITY, minimum), minimum).toBe(false);
  });

  // A minimum above the latest published version is unpublished: it must ship
  // in this build. One at or below it is established and never moves; the
  // cell above already holds it above the pre-capability pin.
  it.each([...new Set(TEAM_FENCE_MINIMUMS)].map((m) => [m]))("minimum %s is unpublished and ships in this build, or established", (minimum) => {
    if (meetsVersionMinimum(LATEST_PUBLISHED, minimum)) return;
    expect(meetsVersionMinimum(packageVersion, minimum), `${minimum} is above ${LATEST_PUBLISHED} but not in ${packageVersion}`).toBe(true);
  });
});
