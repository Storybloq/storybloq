/**
 * T-537 S4: the registered v4 command, run by a clone whose PATH resolves
 * `storybloq` to a CLI from before owner checkpoints, must refuse: a nonzero
 * exit (git records a conflict) naming the option, and ours byte-identical.
 * The same CLI first merges the same valid tickets through the v3 command, so
 * the refusal is the option's and not the input's. The CLI is the real
 * published 1.15.9, the last release without checkpoints (1.16.0 was never
 * published), pinned by the tarball's sha256
 * 10a960b919f63ec57b5b30d10ed13d32a7e188fdeec0cd962057b6c1821ac804 and
 * installed into a scratch prefix without scripts, its dependencies from the
 * npm cache where present. The tarball is STORYBLOQ_PRE_CHECKPOINT_TGZ;
 * without it the test skips, so a plain suite run never touches the network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MERGE_DRIVER_CMD, MERGE_DRIVER_V4_CMD } from "../../src/core/team-setup.js";

const PRE_CHECKPOINT = "1.15.9";
const PRE_CHECKPOINT_SHA256 = "10a960b919f63ec57b5b30d10ed13d32a7e188fdeec0cd962057b6c1821ac804";

const TGZ = process.env.STORYBLOQ_PRE_CHECKPOINT_TGZ;

let scratch: string;
let bin: string;
let home: string;

beforeAll(() => {
  if (!TGZ) return;
  scratch = mkdtempSync(join(tmpdir(), "t537-oldcli-"));
  home = join(scratch, "home");
  mkdirSync(home);
  expect(createHash("sha256").update(readFileSync(TGZ)).digest("hex")).toBe(PRE_CHECKPOINT_SHA256);
  const prefix = join(scratch, "inst");
  execFileSync("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", TGZ], { cwd: scratch, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
  bin = join(prefix, "node_modules", ".bin");
}, 300_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Valid tickets a pre-checkpoint CLI reads: ours retitles, theirs edits the description, so they merge cleanly. */
const TICKET = {
  id: "T-001", title: "base", type: "task", status: "open", phase: "p1", order: 10,
  description: "", createdDate: "2026-09-27", completedDate: null, blockedBy: [], parentTicket: null,
};

describe.skipIf(!TGZ)(`a pre-checkpoint CLI behind the v4 driver${TGZ ? "" : " (skipped: set STORYBLOQ_PRE_CHECKPOINT_TGZ to the pinned 1.15.9 tarball)"}`, () => {
  it("merges valid tickets through the v3 command, and refuses the same merge through the registered v4 command, naming the option", () => {
    expect(execFileSync(join(bin, "storybloq"), ["--version"], { encoding: "utf-8", env: { ...process.env, HOME: home } }).trim()).toBe(PRE_CHECKPOINT);
    const repo = join(scratch, "repo");
    mkdirSync(join(repo, ".story", "tickets"), { recursive: true });
    // A config this CLI reads, so only the driver option can refuse.
    writeFileSync(join(repo, ".story", "config.json"), JSON.stringify({ version: 2, project: "t537", type: "t", language: "ts", features: {} }) + "\n");
    const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
    const merge = (template: string, label: string) => {
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
      const run = spawnSync("sh", ["-c", command], {
        cwd: repo,
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
      });
      return { run, ours, before };
    };

    // The same CLI merges these tickets when asked without --protocol.
    const v3 = merge(MERGE_DRIVER_CMD, "v3");
    expect(v3.run.status, v3.run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(v3.ours, "utf-8"))).toMatchObject({ title: "ours", description: "theirs" });

    const v4 = merge(MERGE_DRIVER_V4_CMD, "v4");
    expect(v4.run.status).not.toBe(0);
    expect(v4.run.status).not.toBeNull();
    // 1.15.9 prints yargs' "Unknown argument: protocol" on stdout; git shows
    // a merge driver's stdout and stderr alike, so the refusal is read from both.
    expect(v4.run.stdout + v4.run.stderr).toMatch(/Unknown argument: protocol/);
    expect(readFileSync(v4.ours).equals(v4.before)).toBe(true);
  });
});
