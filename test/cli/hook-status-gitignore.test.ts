/**
 * ISS-947: hook-status.ts's ensureGitignore (called from writeStatus on every
 * status write) already self-heals every STORY_GITIGNORE_ENTRIES line -- this
 * pins that servers/ rides along for free once added to that single array,
 * with no other code change in this file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGitignore } from "../../src/cli/commands/hook-status.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss947-hookstatus-"));
});
afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("ensureGitignore self-heals servers/ (ISS-947)", () => {
  it("adds servers/ to an existing .story/.gitignore that predates it", () => {
    fs.mkdirSync(join(root, ".story"), { recursive: true });
    fs.writeFileSync(join(root, ".story", ".gitignore"), "snapshots/\nstatus.json\n", "utf-8");
    ensureGitignore(root);
    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    expect(content).toContain("snapshots/");
    expect(content).toContain("servers/");
  });

  it("creates .story/.gitignore containing servers/ when no .gitignore exists yet", () => {
    fs.mkdirSync(join(root, ".story"), { recursive: true });
    ensureGitignore(root);
    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    expect(content).toContain("servers/");
  });
});
