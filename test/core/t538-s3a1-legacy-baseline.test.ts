/**
 * T-538 S3a-1: byte identity for payloads that carry none of the S3a fields.
 * The golden files were written on 25b0ec11, before any S3a-1 change: a
 * legacy payload must keep producing the same output lines and the same
 * bytes in every file setup writes (the payload and its receipts in the
 * progress note, config, tickets, the frozen setup note, the handover and the
 * historical report), on a fresh apply, an interrupted apply finished by
 * resume, and a restore-planned resolution.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setupApply, setupApplySeams, setupResolve, setupResume } from "../../src/core/setup-apply.js";

vi.setConfig({ testTimeout: 30_000 });

const SID = "SS-0123abcd";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-s3a1-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(async () => {
  setupApplySeams.fault = () => {};
  vi.useRealTimers();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "t538-s3a1-"));
  dirs.push(d);
  return d;
}

/** The S2 test payload: a complete ticket status, establishment fields and runners are all absent. */
function payload(): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: {
      level: "full",
      verifyApplies: false,
      components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "pending", reason: "no tests yet" }, build: { command: "npm run build", status: "established" }, verify: null }],
    },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] },
    git: { init: false, gitignore: ["node_modules/"] },
    phases: [
      { key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" },
      { key: "K6", id: "polish", name: "Polish", label: "POLISH", description: "" },
    ],
    tickets: [
      { key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] },
      { key: "K3", title: "Profile", type: "feature", phase: "K6", description: "d", blockedBy: ["K2"] },
    ],
    checkpoints: [{ key: "K4", title: "Accept sign in", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: ["K3"] }],
    issues: [{ key: "K5", title: "Imported", body: "b", labels: ["bug"], source: 7 }],
    coverage: [
      { requirement: "R1", text: "sign in", source: "brief", keys: ["K2", "K4"] },
      { requirement: "R2", text: "export", source: "brief", keys: [], deferral: "already built" },
    ],
  };
}

/** Every file setup wrote, by path, plus the output lines of each call. Snapshots are excluded: their names carry the clock. */
async function capture(root: string, calls: Record<string, string[]>): Promise<string> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      const rel = relative(root, path);
      if (rel === join(".story", "snapshots") || rel === join(".story", "sessions") || rel === ".git") continue;
      if (e.isDirectory()) await walk(path);
      else files[rel] = await readFile(path, "utf-8");
    }
  };
  await walk(root);
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]!]));
  return `${JSON.stringify({ calls, files: sorted }, null, 2)}\n`;
}

function clock(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
}

describe("a legacy payload (no S3a fields) is byte-identical", () => {
  it("on a fresh apply", async () => {
    const root = await folder();
    clock("2026-10-20T12:00:00");
    const result = await setupApply(root, payload());
    expect(result.exitCode).toBe(0);
    await expect(await capture(root, { apply: result.lines })).toMatchFileSnapshot("./__golden__/t538-s3a1-legacy-fresh.json");
  });

  it("on an apply interrupted at wiring and finished by resume on a later day", async () => {
    const root = await folder();
    clock("2026-10-20T12:00:00");
    let fired = false;
    setupApplySeams.fault = (p) => {
      if (p === "step:wire:K3" && !fired) {
        fired = true;
        throw new Error(`injected fault at ${p}`);
      }
    };
    const first = await setupApply(root, payload());
    expect(first.exitCode).toBe(3);
    setupApplySeams.fault = () => {};
    clock("2026-10-22T09:00:00");
    const resumed = await setupResume(root, SID);
    expect(resumed.exitCode).toBe(0);
    await expect(await capture(root, { apply: first.lines, resume: resumed.lines })).toMatchFileSnapshot("./__golden__/t538-s3a1-legacy-resumed.json");
  });

  it("on a restore-planned resolution of an owner edit, then resume", async () => {
    const root = await folder();
    clock("2026-10-20T12:00:00");
    let fired = false;
    setupApplySeams.fault = (p) => {
      if (p === "step:config" && !fired) {
        fired = true;
        throw new Error(`injected fault at ${p}`);
      }
    };
    const first = await setupApply(root, payload());
    expect(first.exitCode).toBe(3);
    setupApplySeams.fault = () => {};
    const path = join(root, ".story", "tickets", "T-001.json");
    const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    raw.title = "the owner's title";
    raw.status = "inprogress";
    await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
    clock("2026-10-21T09:00:00");
    const stopped = await setupResume(root, SID);
    expect(stopped.exitCode).toBe(4);
    const resolved = await setupResolve(root, SID, [{ target: "K2 (T-001)", resolution: "restore-planned", ownerWords: "put it back" }]);
    expect(resolved.exitCode).toBe(0);
    const resumed = await setupResume(root, SID);
    expect(resumed.exitCode).toBe(0);
    await expect(await capture(root, { apply: first.lines, stopped: stopped.lines, resolved: resolved.lines, resume: resumed.lines }))
      .toMatchFileSnapshot("./__golden__/t538-s3a1-legacy-restored.json");
  });
});
