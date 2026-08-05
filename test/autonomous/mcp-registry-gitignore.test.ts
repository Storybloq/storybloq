/**
 * ISS-947: .story/servers/ was absent from STORY_GITIGNORE_ENTRIES, so every
 * MCP server registration dirtied `git status --porcelain .story/`, and an
 * existing checkout that never re-runs `init` never picks up the fix on its
 * own. registerMcpServer now self-heals .story/.gitignore at registration
 * time (mcp-registry.ts's ensureStoryRuntimeGitignored), inserted between the
 * recursive mkdirSync and the PID writeFileSync so it runs after .story/ is
 * guaranteed to exist -- a Codex round-1 review caught a real bug in an
 * earlier draft that called it BEFORE mkdirSync, which silently failed
 * (ENOENT) against a bare mkdtemp root with no .story/ at all, exactly the
 * fixture shape these tests and the existing registry test suite use.
 *
 * All fixtures are mkdtemp temp roots; the legacy-baseline test below is the
 * only one that touches git, and it does so inside its own disposable
 * temp-root repo, never this workspace's real .story/servers/ (a live MCP
 * server -- this session's own -- has a pid entry there right now).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { registerMcpServer, clearSelfVouch } from "../../src/autonomous/mcp-registry.js";
import { STORY_GITIGNORE_ENTRIES } from "../../src/core/init.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss947-registry-"));
});
afterEach(() => {
  clearSelfVouch(root);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("registerMcpServer self-heals .story/.gitignore (ISS-947)", () => {
  it("against a completely bare root (no .story/ at all), registration succeeds and .story/.gitignore is created containing servers/", () => {
    expect(existsSync(join(root, ".story"))).toBe(false);
    const ok = registerMcpServer(root, null, 12345);
    expect(ok).toBe(true);
    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    expect(content).toContain("servers/");
  });

  it("against a root with an existing .story/.gitignore that lacks servers/, self-heals the missing line", () => {
    fs.mkdirSync(join(root, ".story"), { recursive: true });
    fs.writeFileSync(join(root, ".story", ".gitignore"), "snapshots/\nstatus.json\n", "utf-8");
    const ok = registerMcpServer(root, null, 12346);
    expect(ok).toBe(true);
    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    expect(content).toContain("snapshots/");
    expect(content).toContain("status.json");
    expect(content).toContain("servers/");
  });

  it("is idempotent -- registering twice does not duplicate the servers/ line", () => {
    registerMcpServer(root, null, 12347);
    registerMcpServer(root, null, 12348);
    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() === "servers/");
    expect(lines).toHaveLength(1);
  });

  it("self-heals against a legacy checkout whose committed .gitignore predates servers/, and the servers/ directory itself never appears in porcelain", () => {
    // Built from a HAND-WRITTEN legacy .gitignore that deliberately omits
    // servers/, not from initProject's (already-fixed) output -- pen ratified
    // this construction explicitly: building it from the fixed init output
    // would already ignore servers/ before registration ever ran, proving
    // nothing about the registration-time call site this fix actually adds.
    // Do not "simplify" this fixture to use initProject; that would silence
    // the one test that pins the self-heal call site itself.
    //
    // The committed .gitignore itself SHOWS modified in porcelain after this
    // -- that is the one-time self-heal event landing, expected and correct,
    // not the recurring dirt ISS-947 is about. What must never appear is the
    // servers/ directory / pid file itself, which is the actual recurring
    // problem; that is what this test asserts. The distinct steady-state case
    // (entry already committed, porcelain fully empty) is the next test.
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    };
    git("init", "-q");
    fs.mkdirSync(join(root, ".story"), { recursive: true });
    fs.writeFileSync(
      join(root, ".story", ".gitignore"),
      "snapshots/\nstatus.json\nsessions/\nfederation-cache.json\nchannel-inbox/\n",
      "utf-8",
    );
    fs.writeFileSync(join(root, ".story", "config.json"), "{}\n", "utf-8");
    git("add", ".");
    git("-c", "user.name=Storybloq-Test", "-c", "user.email=storybloq@example.test", "commit", "-q", "-m", "legacy baseline");

    const ok = registerMcpServer(root, null, 12349);
    expect(ok).toBe(true);

    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    const serversLines = content.split("\n").filter((l) => l.trim() === "servers/");
    expect(serversLines).toHaveLength(1);

    const porcelain = execFileSync("git", ["status", "--porcelain", ".story/"], { cwd: root, encoding: "utf-8" });
    expect(porcelain).not.toContain("servers");
  });

  it("acceptance criterion 3, literal, steady state: git status --porcelain .story/ is empty when servers/ is already committed-ignored and a server registers", () => {
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "pipe" });
    };
    git("init", "-q");
    fs.mkdirSync(join(root, ".story"), { recursive: true });
    fs.writeFileSync(
      join(root, ".story", ".gitignore"),
      STORY_GITIGNORE_ENTRIES.join("\n") + "\n",
      "utf-8",
    );
    fs.writeFileSync(join(root, ".story", "config.json"), "{}\n", "utf-8");
    git("add", ".");
    git("-c", "user.name=Storybloq-Test", "-c", "user.email=storybloq@example.test", "commit", "-q", "-m", "clean baseline with servers/ already ignored");

    const ok = registerMcpServer(root, null, 12350);
    expect(ok).toBe(true);

    const porcelain = execFileSync("git", ["status", "--porcelain", ".story/"], { cwd: root, encoding: "utf-8" });
    expect(porcelain.trim()).toBe("");
  });

  it("STORY_GITIGNORE_ENTRIES (single source of truth) includes servers/", () => {
    expect(STORY_GITIGNORE_ENTRIES).toContain("servers/");
  });
});
