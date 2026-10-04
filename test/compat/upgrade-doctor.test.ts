/**
 * T-486 A9 on the real upgrade image: a team board set up by the
 * pre-capability published CLI (no fence, the legacy driver registered),
 * then checked by this build's dist. Upgrading alone must not fail
 * `team doctor --ci`; neither may a fresh clone of a board this build set up.
 * Only a misconfigured clone or an effective kind under a low fence does.
 * Dists come from the prefix `npm run compat:fetch` installs (old-dists.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_PATH } from "../helpers/e2e-cli.js";
import { resolutionDigest } from "../../src/core/resolution-kind.js";
import { PRE_CAPABILITY, requireOldDists } from "./old-dists.js";

const { dists, skip } = requireOldDists([PRE_CAPABILITY]);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Image {
  root: string;
  home: string;
  run: (cwd: string, ...args: string[]) => ReturnType<typeof spawnSync>;
  old: (cwd: string, ...args: string[]) => ReturnType<typeof spawnSync>;
  cur: (cwd: string, ...args: string[]) => ReturnType<typeof spawnSync>;
}

function image(): Image {
  const base = mkdtempSync(join(tmpdir(), "t486-upgrade-"));
  dirs.push(base);
  const home = join(base, "home");
  mkdirSync(home);
  const root = join(base, "repo");
  mkdirSync(root);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  const run = (cwd: string, ...args: string[]) => spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf-8", timeout: 60_000, env });
  const old = (cwd: string, ...args: string[]) => run(cwd, dists[0]!.bin, ...args);
  const cur = (cwd: string, ...args: string[]) => run(cwd, process.execPath, CLI_PATH, ...args);
  const g = (cwd: string, ...args: string[]) => run(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args);
  expect(g(root, "init", "-q", "-b", "main").status).toBe(0);
  expect(old(root, "init", "--name", "upg").status).toBe(0);
  const configPath = join(root, ".story", "config.json");
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf-8")), team: { enabled: true } }, null, 2) + "\n");
  expect(old(root, "team", "setup").status).toBe(0);
  expect(g(root, "add", "-A").status).toBe(0);
  expect(g(root, "commit", "-qm", "image").status).toBe(0);
  return { root, home, run: g, old, cur };
}

function doctor(img: Image, cwd: string): { status: number | null; findings: Array<{ severity: string; code: string; message: string }> } {
  const r = img.cur(cwd, "team", "doctor", "--ci", "--format", "json");
  return { status: r.status, findings: JSON.parse(String(r.stdout)).data.findings };
}
const kindRows = (findings: Array<{ severity: string; code: string }>) =>
  findings.filter((f) => f.code.startsWith("resolution_kind_")).map((f) => [f.severity, f.code]);

describe.skipIf(skip !== null)(`team doctor --ci on a board ${PRE_CAPABILITY} set up${skip ? ` (${skip})` : ""}`, () => {
  it("before setup: warnings only, exit 0, with the one-line upgrade message", () => {
    const img = image();
    expect(JSON.parse(readFileSync(join(img.root, ".story", "config.json"), "utf-8")).team.minCliVersion).toBeUndefined();
    const { status, findings } = doctor(img, img.root);
    expect(status).toBe(0);
    expect(kindRows(findings)).toEqual([["warning", "resolution_kind_fence"], ["warning", "resolution_kind_clone_setup"]]);
    expect(findings.find((f) => f.code === "resolution_kind_fence")!.message).toBe(
      "team.minCliVersion is unset; resolution-kind writes are refused on this board until someone runs storybloq team setup on a 1.16.0+ CLI and commits the config.",
    );
    expect(findings.find((f) => f.code === "resolution_kind_clone_setup")!.message).toBe(
      "This clone merges issues with storybloq-json, not storybloq-json-v5, so resolution-kind writes are refused here until storybloq team setup runs in this clone.",
    );
  });

  it("after setup in that clone: exit 0 with no resolution-kind finding; a fresh clone of the result: exit 0 with the clone warning", () => {
    const img = image();
    expect(img.cur(img.root, "team", "setup").status).toBe(0);
    const set = doctor(img, img.root);
    expect(set.status).toBe(0);
    expect(kindRows(set.findings)).toEqual([]);
    expect(img.run(img.root, "add", "-A").status).toBe(0);
    expect(img.run(img.root, "commit", "-qm", "setup").status).toBe(0);
    const clone = join(dirname(img.root), "clone");
    expect(img.run(dirname(img.root), "clone", "-q", img.root, clone).status).toBe(0);
    const fresh = doctor(img, clone);
    expect(fresh.status).toBe(0);
    expect(kindRows(fresh.findings)).toEqual([["warning", "resolution_kind_clone_setup"]]);
    expect(fresh.findings.find((f) => f.code === "resolution_kind_clone_setup")!.message).toBe(
      "git would merge .story/issues/i-resolutionprobe.json with storybloq-json, which is not registered in this clone (issue merges fall back to text, and resolution-kind writes are refused) until storybloq team setup runs in this clone.",
    );
  });

  it("a configured-wrong clone exits 1", () => {
    const img = image();
    expect(img.cur(img.root, "team", "setup").status).toBe(0);
    expect(img.run(img.root, "config", "--local", "merge.storybloq-json-v5.driver", "cat %A").status).toBe(0);
    const { status, findings } = doctor(img, img.root);
    expect(status).toBe(1);
    expect(kindRows(findings)).toEqual([["error", "resolution_kind_merge_driver"]]);
  });

  it("an effective kind committed under no fence exits 1", () => {
    const img = image();
    const created = img.old(img.root, "issue", "create", "--title", "a bug", "--severity", "medium", "--impact", "it breaks", "--format", "json");
    expect(created.status).toBe(0);
    const file = readdirSync(join(img.root, ".story", "issues")).find((f) => f.endsWith(".json"))!;
    const path = join(img.root, ".story", "issues", file);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({
      ...raw, status: "resolved", resolvedDate: "2026-09-01", resolution: "fixed it",
      resolutionKind: { kind: "fixed", closedOn: "2026-09-01", resolutionDigest: resolutionDigest("fixed it") },
    }, null, 2) + "\n");
    const { status, findings } = doctor(img, img.root);
    expect(status).toBe(1);
    expect(kindRows(findings)).toEqual([["error", "resolution_kind_unfenced"], ["warning", "resolution_kind_clone_setup"]]);
  });
});
