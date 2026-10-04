/**
 * T-537 S4, T-486 D2: a registered checkpoint command, run by a clone whose
 * PATH resolves `storybloq` to a CLI from before owner checkpoints, must
 * refuse: a nonzero exit (git records a conflict) naming the option, and ours
 * byte-identical. The same CLI first merges the same valid tickets through
 * the v3 command, so the refusal is the option's and not the input's. The CLI
 * is the published 1.15.9, the last release without checkpoints or
 * resolution kinds, read from the prefix `npm run compat:fetch` installs
 * (old-dists.ts): skipped without it, a failure in required mode.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MERGE_DRIVER_CMD, MERGE_DRIVER_V4_CMD, MERGE_DRIVER_V5_CMD } from "../../src/core/team-setup.js";
import { requireOldDists } from "./old-dists.js";

const PRE_CHECKPOINT = "1.15.9";
const { dists, skip } = requireOldDists([PRE_CHECKPOINT]);
const bin = dists[0] ? dirname(dists[0].bin) : "";

let scratch: string;
let home: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "t537-oldcli-"));
  home = join(scratch, "home");
  mkdirSync(home);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Valid tickets a pre-checkpoint CLI reads: ours retitles, theirs edits the description, so they merge cleanly. */
const TICKET = {
  id: "T-001", title: "base", type: "task", status: "open", phase: "p1", order: 10,
  description: "", createdDate: "2026-09-27", completedDate: null, blockedBy: [], parentTicket: null,
};

describe.skipIf(skip !== null)(`a pre-checkpoint CLI behind the checkpoint drivers${skip ? ` (${skip})` : ""}`, () => {
  const env = () => ({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });

  function merge(repo: string, template: string, label: string) {
    const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
    const side = (name: string, body: object): string => {
      const p = join(repo, `${label}-${name}.json`);
      writeFileSync(p, JSON.stringify(body, null, 2) + "\n");
      return p;
    };
    const base = side("base", TICKET);
    const ours = side("ours", { ...TICKET, title: "ours" });
    const theirs = side("theirs", { ...TICKET, description: "theirs" });
    const before = readFileSync(ours);
    // Git substitutes %O %A %B %P and runs the string through the shell.
    const command = template
      .replace("%O", quote(base)).replace("%A", quote(ours)).replace("%B", quote(theirs)).replace("%P", quote(".story/tickets/T-001.json"));
    const run = spawnSync("sh", ["-c", command], { cwd: repo, encoding: "utf-8", timeout: 60_000, env: env() });
    return { run, ours, before };
  }

  function repo(): string {
    const r = join(scratch, `repo-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(r, ".story", "tickets"), { recursive: true });
    // A config this CLI reads, so only the driver option can refuse.
    writeFileSync(join(r, ".story", "config.json"), JSON.stringify({ version: 2, project: "t537", type: "t", language: "ts", features: {} }) + "\n");
    return r;
  }

  it("is the pinned version", () => {
    expect(execFileSync(join(bin, "storybloq"), ["--version"], { encoding: "utf-8", env: env() }).trim()).toBe(PRE_CHECKPOINT);
  });

  it("merges valid tickets through the v3 command", () => {
    const v3 = merge(repo(), MERGE_DRIVER_CMD, "v3");
    expect(v3.run.status, v3.run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(v3.ours, "utf-8"))).toMatchObject({ title: "ours", description: "theirs" });
  });

  it.each([["v4", MERGE_DRIVER_V4_CMD], ["v5", MERGE_DRIVER_V5_CMD]])("refuses the same merge through the registered %s command, naming the option, ours untouched", (label, command) => {
    const r = merge(repo(), command, label);
    expect(r.run.status).not.toBe(0);
    expect(r.run.status).not.toBeNull();
    // 1.15.9 prints yargs' "Unknown argument: protocol" on stdout; git shows
    // a merge driver's stdout and stderr alike, so the refusal is read from both.
    expect(r.run.stdout + r.run.stderr).toMatch(/Unknown argument: protocol/);
    expect(readFileSync(r.ours).equals(r.before)).toBe(true);
  });
});
