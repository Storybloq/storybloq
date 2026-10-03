/**
 * ISS-1107: status and recap say which board files are not committed, and on
 * a non-default branch which differ from origin/<default>. Compact status is
 * byte-for-byte what it was before ISS-1107.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureTools, cleanupTempDirs, git, isolateGit, makeFederation, makeProjectRepo, tempDir,
} from "./board-git-fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const COMPACT_FIXTURE = join(here, "..", "fixtures", "board-git", "compact-status.json");

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); });
afterEach(() => { vi.useRealTimers(); restoreGit(); cleanupTempDirs(); });

const ISSUE = { title: "Board state", severity: "low", impact: "none" };

function section(text: string): string | null {
  const at = text.indexOf("## Board not committed");
  if (at < 0) return null;
  const rest = text.slice(at);
  const next = rest.indexOf("\n## ", 3);
  return (next < 0 ? rest : rest.slice(0, next)).trimEnd();
}

async function statusJson(root: string): Promise<Record<string, unknown>> {
  const reply = await captureTools(root).call("storybloq_status", { format: "json" });
  return (JSON.parse(reply.text) as { data: Record<string, unknown> }).data;
}

/** A feature branch with a bare origin whose HEAD is main. */
/** Team mode names new records by hash, with the display id inside the file. */
function enableTeam(root: string, top: string): void {
  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, team: { enabled: true, minCliVersion: "1.4.4" } }, null, 2) + "\n");
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "team");
}

/** Creates two hash-named issues, committed; returns their repo-relative paths in creation order. */
async function hashIssues(root: string): Promise<string[]> {
  const tools = captureTools(root);
  const paths: string[] = [];
  for (const title of ["first", "kept"]) {
    const reply = await tools.call("storybloq_issue_create", { ...ISSUE, title, commit: true });
    const line = reply.text.split("\n").find((l) => l.startsWith("Git: .story/issues/"))!;
    paths.push(line.split(" ")[1]!);
  }
  for (const path of paths) expect(path).toMatch(/^\.story\/issues\/i-[0-9a-z]+\.json$/);
  return paths;
}

const stemOf = (path: string) => path.slice(path.lastIndexOf("/") + 1, -".json".length);

function addOrigin(top: string): string {
  const bare = tempDir("origin");
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(top, "remote", "add", "origin", bare);
  git(top, "push", "-q", "origin", "main");
  git(top, "remote", "set-head", "origin", "main");
  return bare;
}

describe("board not committed in status and recap (ISS-1107)", () => {
  it("S1: status markdown lists ids, a hash-named item by its displayId", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    await tools.call("storybloq_issue_create", ISSUE);
    await tools.call("storybloq_note_create", { content: "second" });
    // A post-migration item: hash filename, display id in the file.
    const legacy = join(root, ".story", "notes", "N-001.json");
    const note = JSON.parse(readFileSync(legacy, "utf-8")) as Record<string, unknown>;
    const hashed = join(root, ".story", "notes", "n-0123456789abcdef.json");
    writeFileSync(hashed, JSON.stringify({ ...note, id: "n-0123456789abcdef", displayId: "N-001" }, null, 2) + "\n");
    rmSync(legacy);
    const reply = await tools.call("storybloq_status", { format: "md" });
    expect(section(reply.text)).toBe([
      "## Board not committed",
      "",
      "Untracked (2): ISS-001, N-001",
      "Branch comparison skipped: no default branch",
    ].join("\n"));
    expect(reply.text).not.toContain("n-0123456789abcdef");
  });

  it("S2: status JSON carries data.boardUncommitted", async () => {
    const { root } = await makeProjectRepo();
    await captureTools(root).call("storybloq_issue_create", ISSUE);
    const data = await statusJson(root);
    expect(data.boardUncommitted).toEqual({
      available: true,
      untracked: { count: 1, ids: ["ISS-001"], truncated: false },
      modified: { count: 0, ids: [], truncated: false },
      branch: { skipped: "no default branch" },
    });
  });

  it("S3: compact status JSON is byte-identical to the pre-ISS-1107 capture", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    await tools.call("storybloq_issue_create", ISSUE);
    await tools.call("storybloq_ticket_create", { title: "A ticket", type: "task" });
    const reply = await tools.call("storybloq_status", { format: "json", compact: true });
    const normalized = reply.text.split(root).join("<root>");
    if (process.env.ISS1107_CAPTURE_COMPACT === "1") {
      mkdirSync(dirname(COMPACT_FIXTURE), { recursive: true });
      writeFileSync(COMPACT_FIXTURE, normalized);
    }
    expect(normalized).toBe(readFileSync(COMPACT_FIXTURE, "utf-8"));
    expect(normalized).not.toContain("boardUncommitted");
  });

  it("S5: recap on a feature branch lists a board file origin/main lacks", async () => {
    const { root, top } = await makeProjectRepo();
    addOrigin(top);
    git(top, "checkout", "-q", "-b", "feat");
    const tools = captureTools(root);
    await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    const recap = await tools.call("storybloq_recap", {});
    expect(section(recap.text)).toBe([
      "## Board not committed",
      "",
      "On feat, differs from origin/main (1): ISS-001",
    ].join("\n"));
  });

  it("S6: with no origin the branch comparison is skipped and says why", async () => {
    const { root, top } = await makeProjectRepo();
    git(top, "config", "init.defaultBranch", "main");
    git(top, "checkout", "-q", "-b", "feat");
    const reply = await captureTools(root).call("storybloq_status", { format: "md" });
    expect(section(reply.text)).toBe([
      "## Board not committed",
      "",
      "Branch comparison skipped: no origin/main",
    ].join("\n"));
  });

  it("S7: detached HEAD skips the branch comparison", async () => {
    const { root, top } = await makeProjectRepo();
    addOrigin(top);
    git(top, "checkout", "-q", "--detach");
    const data = await statusJson(root);
    expect((data.boardUncommitted as { branch: unknown }).branch).toEqual({ skipped: "detached HEAD" });
  });

  it("S8: the registered status (JSON) and recap (markdown) both carry it", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    await tools.call("storybloq_issue_create", ISSUE);
    const data = await statusJson(root);
    expect((data.boardUncommitted as { untracked: unknown }).untracked).toEqual({ count: 1, ids: ["ISS-001"], truncated: false });
    const recap = await tools.call("storybloq_recap", {});
    expect(section(recap.text)).toContain("Untracked (1): ISS-001");
  });

  it("S9: a project nested in a repository scans only its own board, locally and against origin", async () => {
    const { root, top } = await makeProjectRepo({ nested: "app" });
    addOrigin(top);
    git(top, "checkout", "-q", "-b", "feat");
    const tools = captureTools(root);
    await tools.call("storybloq_issue_create", { ...ISSUE, commit: true });
    await tools.call("storybloq_note_create", { content: "local only" });
    writeFileSync(join(top, "outside.json"), JSON.stringify({ id: "X-1" }));
    mkdirSync(join(top, ".story"), { recursive: true });
    writeFileSync(join(top, ".story", "stray.json"), JSON.stringify({ id: "STRAY-1" }));
    git(top, "add", "outside.json", ".story/stray.json");
    git(top, "commit", "-q", "-m", "outside the project");
    const data = await statusJson(root);
    expect(data.boardUncommitted).toEqual({
      available: true,
      untracked: { count: 1, ids: ["N-001"], truncated: false },
      modified: { count: 0, ids: [], truncated: false },
      branch: { head: "feat", base: "main", differing: { count: 1, ids: ["ISS-001"], truncated: false } },
    });
  });

  it("S10: an unstaged deletion of a hash-named record shows its display id from the index", async () => {
    const { root, top } = await makeProjectRepo();
    enableTeam(root, top);
    const [deleted] = await hashIssues(root);
    rmSync(join(root, deleted!));
    const data = await statusJson(root);
    expect((data.boardUncommitted as { modified: unknown }).modified).toEqual({ count: 1, ids: ["ISS-001"], truncated: false });
    expect(JSON.stringify(data.boardUncommitted)).not.toContain(stemOf(deleted!));
  });

  it("S11: a staged deletion of a hash-named record origin lacks shows its display id from HEAD", async () => {
    const { root, top } = await makeProjectRepo();
    enableTeam(root, top);
    addOrigin(top);
    git(top, "checkout", "-q", "-b", "feat");
    const paths = await hashIssues(root);
    git(top, "rm", "-q", "--", paths[0]!);
    const data = await statusJson(root);
    const state = data.boardUncommitted as { modified: unknown; branch: { differing: { ids: string[] } } };
    expect(state.modified).toEqual({ count: 1, ids: ["ISS-001"], truncated: false });
    // Differing paths sort by hash filename, so compare the ids as a set.
    expect([...state.branch.differing.ids].sort()).toEqual(["ISS-001", "ISS-002"]);
    expect(state.branch).toMatchObject({ head: "feat", base: "main", differing: { count: 2, truncated: false } });
    for (const path of paths) expect(JSON.stringify(state)).not.toContain(stemOf(path));
  });

  it("S12: federated status carries the section for the orchestrator", async () => {
    const { orch } = await makeFederation();
    const tools = captureTools(orch);
    await tools.call("storybloq_issue_create", ISSUE);
    const reply = await tools.call("storybloq_status", { format: "md" });
    expect(section(reply.text)).toContain("Untracked (1): ISS-001");
  });
});
