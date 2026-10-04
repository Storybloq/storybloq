/**
 * T-486 T0 and CK4 against published CLIs. The kind and evidence keys are
 * plain passthrough keys, so every pinned old dist must load a board that
 * carries them, validate it, and keep them byte-for-byte through a strict
 * write. And once this build's team setup has raised the fence, the newest
 * published CLI, in a clone that never ran it, must refuse to write at all.
 * Dists come from the prefix `npm run compat:fetch` installs (old-dists.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../helpers/git-fixture.js";
import { initProject } from "../../src/core/init.js";
import { teamSetup } from "../../src/core/team-setup.js";
import { RESOLUTION_KIND_MIN_CLI_VERSION, meetsVersionMinimum } from "../../src/core/team-capabilities.js";
import { NEWEST_PUBLISHED, OLD_DISTS, requireOldDists } from "./old-dists.js";

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

  it(`CK4: once team setup raises the fence, ${NEWEST_PUBLISHED} in a clone that never ran it refuses to write`, async () => {
    const newest = dists.find((d) => d.version === NEWEST_PUBLISHED)!;
    const repo = temp();
    const home = join(repo, ".home");
    mkdirSync(home);
    git(repo, ["init", "-q", "-b", "main"]);
    await initProject(repo, { name: "t486" });
    const configPath = join(repo, ".story", "config.json");
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf-8")), team: { enabled: true } }, null, 2) + "\n");
    await teamSetup(repo);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).team.minCliVersion).toBe(RESOLUTION_KIND_MIN_CLI_VERSION);

    const path = join(repo, ".story", "issues", "ISS-001.json");
    writeFileSync(path, JSON.stringify(ISSUE, null, 2) + "\n");
    const before = readFileSync(path);
    const update = run(newest.bin, repo, home, "issue", "update", "ISS-001", "--title", "fenced", "--format", "json");
    expect(update.status).not.toBe(0);
    expect(JSON.parse(update.stdout).error).toMatchObject({ code: "version_mismatch" });
    expect(update.stdout).toContain(`requires storybloq CLI ${RESOLUTION_KIND_MIN_CLI_VERSION} or later; current CLI is ${NEWEST_PUBLISHED}`);
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});

describe("the resolution-kind minimum is unpublished (Q2b)", () => {
  // A minimum equal to a published version whose dist lacks the capability
  // would admit that dist. NEWEST_PUBLISHED is the old-dists.json pin, which
  // RELEASE.md has the publisher advance, so this is as fresh as that pin.
  it(`${NEWEST_PUBLISHED} is below ${RESOLUTION_KIND_MIN_CLI_VERSION}`, () => {
    expect(meetsVersionMinimum(NEWEST_PUBLISHED, RESOLUTION_KIND_MIN_CLI_VERSION)).toBe(false);
    expect(OLD_DISTS.map((d) => d.version)).toContain(NEWEST_PUBLISHED);
  });
});
