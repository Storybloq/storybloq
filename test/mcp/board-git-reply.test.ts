/**
 * ISS-1107: an MCP board write reports the git state of exactly the files it
 * wrote, and `commit: true` commits exactly those files. Everything here goes
 * through the registered tools against real git repositories.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureTools, cleanupTempDirs, git, gitLines, headFiles, headSha, indexEntries, installHook,
  isolateGit, makeFederation, makeProjectRepo, porcelain, soleUntracked, tempDir,
} from "./board-git-fixtures.js";
import { initProject } from "../../src/core/init.js";

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); });
afterEach(() => { restoreGit(); cleanupTempDirs(); });

const ISSUE = { title: "Board state", severity: "low", impact: "none" };

function enableTeam(root: string): void {
  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, team: { enabled: true, minCliVersion: "1.4.4" } }, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "team");
}

describe("board write git state (ISS-1107)", () => {
  for (const team of [false, true]) {
    it(`W1: issue_create reports the real file as untracked (${team ? "team, hash filename" : "legacy filename"})`, async () => {
      const { root } = await makeProjectRepo();
      if (team) enableTeam(root);
      const tools = captureTools(root);
      const reply = await tools.call("storybloq_issue_create", ISSUE);
      expect(reply.isError).toBe(false);
      const path = soleUntracked(root, ".story/issues");
      // Team mode names the file by hash, never by the display id.
      expect(path).toMatch(team ? /^\.story\/issues\/i-[0-9a-z]+\.json$/ : /^\.story\/issues\/ISS-001\.json$/);
      expect(porcelain(root, path)).toEqual([`?? ${path}`]);
      expect(gitLines(reply.text)).toEqual([`Git: ${path} untracked`]);
    });
  }

  it("W2: issue_update on a committed issue reports modified", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    await tools.call("storybloq_issue_create", ISSUE);
    const path = soleUntracked(root, ".story/issues");
    git(root, "add", "--", path);
    git(root, "commit", "-q", "-m", "issue");
    const reply = await tools.call("storybloq_issue_update", { id: "ISS-001", impact: "changed impact" });
    expect(reply.isError).toBe(false);
    expect(porcelain(root, path)).toEqual([` M ${path}`]);
    expect(gitLines(reply.text)).toEqual([`Git: ${path} modified`]);
  });

  for (const team of [false, true]) {
    it(`W3: handover_create reports the handover untracked and commits it (${team ? "team" : "non-team"} mode)`, async () => {
      const { root } = await makeProjectRepo();
      if (team) enableTeam(root);
      const tools = captureTools(root);
      const reply = await tools.call("storybloq_handover_create", { content: "# Handover\n\nState.\n", slug: "first" });
      expect(reply.isError).toBe(false);
      const path = soleUntracked(root, ".story/handovers");
      expect(path.endsWith(".md")).toBe(true);
      expect(gitLines(reply.text)).toEqual([`Git: ${path} untracked`]);

      const committed = await tools.call("storybloq_handover_create", { content: "# Handover\n\nSecond.\n", slug: "second", commit: true });
      expect(committed.isError).toBe(false);
      const second = headFiles(root);
      expect(second).toHaveLength(1);
      expect(second[0]).toMatch(/^\.story\/handovers\/.*second.*\.md$/);
      expect(gitLines(committed.text)).toEqual([
        `Git: ${second[0]} committed`,
        `Git: committed ${git(root, "rev-parse", "--short", "HEAD").trim()}`,
      ]);
      // The first handover is still untracked: the commit took only its own file.
      expect(porcelain(root, path)).toEqual([`?? ${path}`]);
    });
  }

  it("W4: snapshot reports its file ignored", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    const reply = await tools.call("storybloq_snapshot", {});
    expect(reply.isError).toBe(false);
    const lines = gitLines(reply.text);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Git: \.story\/snapshots\/\S+\.json ignored$/);
  });

  it("W5: outside a repository the write succeeds and says no git", async () => {
    const root = tempDir("nogit");
    await initProject(root, { name: "fixture" });
    const tools = captureTools(root);
    const reply = await tools.call("storybloq_issue_create", ISSUE);
    expect(reply.isError).toBe(false);
    expect(reply.text).toContain("ISS-001");
    expect(gitLines(reply.text)).toEqual(["Git: .story/issues/ISS-001.json no git (not a repository)"]);
  });

  it("W6: commit takes exactly the written file and leaves every other change alone", async () => {
    const { root } = await makeProjectRepo();
    writeFileSync(join(root, "tracked.txt"), "one\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-q", "-m", "tracked");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    writeFileSync(join(root, "tracked.txt"), "two\n");
    writeFileSync(join(root, "loose.txt"), "untracked\n");
    const indexBefore = indexEntries(root);
    const parent = headSha(root);

    const tools = captureTools(root);
    const reply = await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    expect(reply.isError).toBe(false);

    expect(git(root, "rev-list", "--count", `${parent}..HEAD`).trim()).toBe("1");
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("docs(story): ISS-001 created");
    expect(headFiles(root)).toEqual([".story/issues/ISS-001.json"]);
    const indexAfter = indexEntries(root).filter((e) => !e.endsWith("\t.story/issues/ISS-001.json"));
    expect(indexAfter).toEqual(indexBefore);
    expect(porcelain(root, "staged.txt", "tracked.txt", "loose.txt")).toEqual(["A  staged.txt", " M tracked.txt", "?? loose.txt"]);
    expect(gitLines(reply.text)).toEqual([
      "Git: .story/issues/ISS-001.json committed",
      `Git: committed ${git(root, "rev-parse", "--short", "HEAD").trim()}`,
    ]);
  });

  it("W7: detached HEAD skips the commit", async () => {
    const { root } = await makeProjectRepo();
    git(root, "checkout", "-q", "--detach");
    const before = headSha(root);
    const tools = captureTools(root);
    const reply = await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    expect(reply.isError).toBe(false);
    expect(headSha(root)).toBe(before);
    expect(gitLines(reply.text)).toEqual([
      "Git: .story/issues/ISS-001.json untracked",
      "Git: commit skipped (detached HEAD)",
    ]);
  });

  it("W8: a failing pre-commit hook skips the commit and leaves the file staged", async () => {
    const { root } = await makeProjectRepo();
    installHook(root, "pre-commit", "echo 'hook says no' >&2\nexit 1");
    const before = headSha(root);
    const tools = captureTools(root);
    const reply = await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    expect(reply.isError).toBe(false);
    expect(headSha(root)).toBe(before);
    expect(gitLines(reply.text)).toEqual([
      "Git: .story/issues/ISS-001.json staged",
      "Git: commit skipped (commit failed: hook says no)",
    ]);
  });

  it("W9: a change already staged in the same file refuses the commit and touches nothing", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    const path = ".story/issues/ISS-001.json";
    const abs = join(root, path);
    writeFileSync(abs, readFileSync(abs, "utf-8").replace('"impact": "none"', '"impact": "staged by hand"'));
    git(root, "add", "--", path);
    const before = headSha(root);
    const indexBefore = indexEntries(root);

    const reply = await tools.call("storybloq_issue_update", { id: "ISS-001", title: "Renamed", commit: true });
    expect(reply.isError).toBe(false);
    expect(headSha(root)).toBe(before);
    expect(indexEntries(root)).toEqual(indexBefore);
    expect(gitLines(reply.text)).toEqual([
      `Git: ${path} staged, modified`,
      `Git: commit skipped (${path} already staged by another change)`,
    ]);
  });

  it("W10: a node write reports and commits only in the node repository", async () => {
    const { orch, node } = await makeFederation();
    const orchHead = headSha(orch);
    const orchIndex = indexEntries(orch);
    const tools = captureTools(orch);
    const reply = await tools.call("storybloq_issue_create", { ...ISSUE, node: "api", commit: true });
    expect(reply.isError).toBe(false);
    expect(headSha(orch)).toBe(orchHead);
    expect(indexEntries(orch)).toEqual(orchIndex);
    expect(porcelain(orch)).toEqual([]);
    expect(headFiles(node)).toEqual([".story/issues/ISS-001.json"]);
    expect(git(node, "log", "-1", "--format=%s").trim()).toBe("docs(story): ISS-001 created");
    expect(gitLines(reply.text)).toEqual([
      "Git: .story/issues/ISS-001.json committed",
      `Git: committed ${git(node, "rev-parse", "--short", "HEAD").trim()}`,
    ]);
  });

  it("W11: a read tool emits no Git line", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    await tools.call("storybloq_note_create", { content: "a note" });
    const reply = await tools.call("storybloq_note_get", { id: "N-001" });
    expect(reply.isError).toBe(false);
    expect(gitLines(reply.text)).toEqual([]);
  });

  it("W12: two interleaved creates each report only their own file", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    const [a, b] = await Promise.all([
      tools.call("storybloq_issue_create", { ...ISSUE, title: "first" }),
      tools.call("storybloq_issue_create", { ...ISSUE, title: "second" }),
    ]);
    const la = gitLines(a.text);
    const lb = gitLines(b.text);
    expect(la).toHaveLength(1);
    expect(lb).toHaveLength(1);
    expect(la[0]).not.toBe(lb[0]);
    const idA = /ISS-00\d/.exec(a.text.split("\n")[0]!)?.[0];
    const idB = /ISS-00\d/.exec(b.text.split("\n")[0]!)?.[0];
    expect(la[0]).toBe(`Git: .story/issues/${idA}.json untracked`);
    expect(lb[0]).toBe(`Git: .story/issues/${idB}.json untracked`);
  });

  it("W13: node_init reports the files it created", async () => {
    const { orch, node } = await makeFederation({ initNode: false });
    const tools = captureTools(orch);
    const reply = await tools.call("storybloq_node_init", { node: "api" });
    expect(reply.isError).toBe(false);
    const lines = gitLines(reply.text);
    expect(lines).toContain("Git: .story/config.json untracked");
    expect(lines).toContain("Git: .story/roadmap.json untracked");
    for (const line of lines) expect(line).toMatch(/^Git: \.story\/\S+ untracked$/);
    expect(porcelain(orch)).toEqual([]);
    expect(porcelain(node, ".story/config.json")).toEqual(["?? .story/config.json"]);
  });

  it("W15: an unchanged rewrite is reported committed and commits nothing", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    // The first update normalizes the file (it gains displayId); the second rewrites identical bytes.
    await tools.call("storybloq_issue_update", { id: "ISS-001", impact: "none", commit: true });
    const before = headSha(root);
    const reply = await tools.call("storybloq_issue_update", { id: "ISS-001", impact: "none", commit: true });
    expect(reply.isError).toBe(false);
    expect(headSha(root)).toBe(before);
    expect(gitLines(reply.text)).toEqual([
      "Git: .story/issues/ISS-001.json committed",
      "Git: commit skipped (nothing to commit)",
    ]);
  });

  it("W16: a hook that stages another file fails verification", async () => {
    const { root } = await makeProjectRepo();
    installHook(root, "pre-commit", "echo extra > extra.txt\ngit add extra.txt");
    const tools = captureTools(root);
    const reply = await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    expect(reply.isError).toBe(false);
    expect(headFiles(root)).toEqual([".story/issues/ISS-001.json", "extra.txt"]);
    expect(gitLines(reply.text)).toEqual([
      "Git: .story/issues/ISS-001.json committed",
      "Git: commit verification failed (HEAD changed .story/issues/ISS-001.json, extra.txt)",
    ]);
  });

  it("W17: message ids use the file stem for config and roadmap; snapshot never commits", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    const phase = await tools.call("storybloq_phase_create", { id: "p1", name: "P1", label: "P1", description: "d", atStart: true, commit: true });
    expect(phase.isError).toBe(false);
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("docs(story): roadmap created");
    expect(headFiles(root)).toEqual([".story/roadmap.json"]);

    const before = headSha(root);
    const snap = await tools.call("storybloq_snapshot", { commit: true });
    expect(snap.isError).toBe(false);
    expect(headSha(root)).toBe(before);
    expect(gitLines(snap.text).at(-1)).toBe("Git: commit skipped (nothing to commit)");
  });

  it("W17: a config write takes its message id from the stem", async () => {
    const { orch, node } = await makeFederation();
    const tools = captureTools(orch);
    const reply = await tools.call("storybloq_node_update", { name: "api", summary: "changed", commit: true });
    expect(reply.isError).toBe(false);
    expect(git(orch, "log", "-1", "--format=%s").trim()).toBe("docs(story): config updated");
    expect(headFiles(orch)).toEqual([".story/config.json"]);
    expect(porcelain(node)).toEqual([]);
  });

  it("W18: an unborn branch commits only the written file as the root commit", async () => {
    const { root } = await makeProjectRepo({ commit: false });
    writeFileSync(join(root, "unrelated.txt"), "unrelated\n");
    git(root, "add", "unrelated.txt");
    const tools = captureTools(root);
    const reply = await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    expect(reply.isError).toBe(false);
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(headFiles(root)).toEqual([".story/issues/ISS-001.json"]);
    expect(porcelain(root, "unrelated.txt")).toEqual(["A  unrelated.txt"]);
    expect(gitLines(reply.text)).toEqual([
      "Git: .story/issues/ISS-001.json committed",
      `Git: committed ${git(root, "rev-parse", "--short", "HEAD").trim()}`,
    ]);
    expect(reply.text).not.toContain("verification failed");
    rmSync(join(root, "unrelated.txt"));
  });
});
