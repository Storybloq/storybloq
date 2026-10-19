/**
 * ISS-1283: a check the deadline cut short must never read as a complete one in
 * the digest. The list's own `freshnessChecked` is true whenever HEAD resolved,
 * timeout or not; the digest does not inherit that.
 *
 * The partial report is made by the REAL check through its existing clock seam
 * (`CheckOptions.now`), then handed to the real handler through a mocked
 * checker, because the handler has no clock seam and gets none. The mock lives
 * in this file alone: vi.mock is file-wide.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCapabilityList } from "../../../src/cli/commands/capability.js";
import { CapabilitySchema, type Capability } from "../../../src/models/capability.js";
import { initProject } from "../../../src/core/init.js";
import { makeState } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";
import type { CapabilityCheckReport, GitRunner } from "../../../src/core/capability.js";

const hooks = vi.hoisted(() => ({ report: null as null | CapabilityCheckReport }));
vi.mock("../../../src/core/capability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/capability.js")>();
  return {
    ...actual,
    checkCapabilities: async (...args: Parameters<typeof actual.checkCapabilities>) =>
      hooks.report ?? actual.checkCapabilities(...args),
  };
});

const actual = await vi.importActual<typeof import("../../../src/core/capability.js")>("../../../src/core/capability.js");

const roots: string[] = [];
afterEach(() => {
  hooks.report = null;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

/** Real git, synchronously, local objects only: no timeout or abort signal can change what is measured. */
const controlledGit: GitRunner = async (root, args) => {
  try {
    const stdout = execFileSync("git", ["-C", root, ...args], { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { ok: typeof e.status === "number", stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: typeof e.status === "number" ? e.status : null };
  }
};

/**
 * Two entries on two DISTINCT checkpoints, so they form two scheduling groups.
 * The clock reads 0 for the check's start and for the first scheduling test,
 * then past the deadline for every later one: the first group is checked, the
 * second is never scheduled.
 */
async function partial(): Promise<{ root: string; entries: Capability[]; report: CapabilityCheckReport }> {
  const root = mkdtempSync(join(tmpdir(), "cap-digest-to-"));
  roots.push(root);
  await initProject(root, { name: "Cap", type: "npm" });
  mkdirSync(join(root, "src", "core"), { recursive: true });
  writeFileSync(join(root, "src", "core", "a.ts"), "1\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  const first = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "docs.md"), "unrelated\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "two");
  const second = git(root, "rev-parse", "HEAD");
  const entries = [
    CapabilitySchema.parse({ id: "cap-one", name: "One", summary: "s", entryPoints: ["src/core/a.ts"], contract: "c", checkedAt: { sha: first, date: "2026-10-18" } }),
    CapabilitySchema.parse({ id: "cap-two", name: "Two", summary: "s", entryPoints: ["src/core/a.ts"], contract: "c", checkedAt: { sha: second, date: "2026-10-18" } }),
  ];
  writeFileSync(join(root, ".story", "capabilities.json"), JSON.stringify({ version: 1, capabilities: entries }, null, 2) + "\n");
  let reads = 0;
  const now = (): number => (reads++ < 2 ? 0 : actual.CHECK_DEADLINE_MS + 1);
  const report = await actual.checkCapabilities(root, entries, null, { now, runGit: controlledGit });
  return { root, entries, report };
}

function ctxFor(root: string, format: "md" | "json"): CommandContext {
  return { state: makeState(), warnings: [], root, handoversDir: join(root, ".story", "handovers"), format };
}

describe("a deadline-cut check reads incomplete in the digest (ISS-1283)", () => {
  it("the real check schedules the first group and times out the second", async () => {
    const { report } = await partial();
    const codes = Object.fromEntries(report.entries.map((e) => [e.id, e.results.map((r) => r.code)]));
    // The receipt: one entry really ran (nothing changed under it), one never did.
    expect(codes).toEqual({ "cap-one": [], "cap-two": ["capability_check_timeout"] });
    expect(report.deadlineHit).toBe(true);
    expect(report.head).not.toBeNull();
    expect(report.unchecked).toEqual(["cap-two"]);
  });

  it("the core digest says incomplete with one unchecked, and lists the timed-out entry", async () => {
    const { entries, report } = await partial();
    expect(actual.capabilityDigest(entries, report, false)).toMatchObject({
      freshness: "incomplete",
      unchecked: 1,
      review: 1,
      entries: [{ id: "cap-two", name: "Two" }],
    });
  });

  it("the real handler reports freshnessChecked false and the md caveat for that report", async () => {
    const { root, report } = await partial();
    hooks.report = report;
    const data = JSON.parse((await handleCapabilityList({ digest: true }, ctxFor(root, "json"))).output).data;
    expect(data).toMatchObject({ freshness: "incomplete", unchecked: 1, freshnessChecked: false });
    hooks.report = report;
    expect((await handleCapabilityList({ digest: true }, ctxFor(root, "md"))).output).toBe(
      "Capabilities in review: 1: Two (freshness incomplete: 1 unchecked, `storybloq capability check`)",
    );
  });
});
