import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLandings } from "../../../src/cli/commands/landings.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import type { CommandContext } from "../../../src/cli/types.js";

/**
 * T-477 section 4.3: `storybloq landings`, end to end -- a real git repo, a
 * real `.story/` project, through the actual CLI handler + formatter. The
 * core `buildLandings` pipeline already has its own thorough unit coverage
 * (test/core/landings.test.ts); this proves the CLI-only surface wraps it
 * correctly (md/json rendering, exit code on `landings-unavailable`).
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newGitProject(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "landings-cli-"));
  tmpDirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await initProject(dir, { name: "test" });
  await writeFile(join(dir, ".gitignore"), ".story/sessions\n.story/snapshots\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: initial commit");
  return { dir };
}

async function ctxFor(dir: string, format: "md" | "json" = "md"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(dir);
  return { state, warnings, root: dir, handoversDir: join(dir, ".story", "handovers"), format };
}

describe("handleLandings", () => {
  it("renders a landing for a commit whose subject names a real ticket", async () => {
    const { dir } = await newGitProject();
    const created = await handleTicketCreate(
      { title: "Landings ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json",
      dir,
    );
    const ticketId = JSON.parse(created.output).data.id as string;
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `feat(${ticketId}): implement the thing`);

    const ctx = await ctxFor(dir, "md");
    const result = handleLandings({}, ctx);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain(ticketId);
    expect(result.output).toContain("implement the thing");
  });

  it("renders the same landing as JSON through the versioned envelope", async () => {
    const { dir } = await newGitProject();
    const created = await handleTicketCreate(
      { title: "Landings ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json",
      dir,
    );
    const ticketId = JSON.parse(created.output).data.id as string;
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `feat(${ticketId}): implement the thing`);

    const ctx = await ctxFor(dir, "json");
    const result = handleLandings({}, ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.status).toBe("ok");
    expect(parsed.data.landings[0].refs[0].ref).toBe(ticketId);
  });

  it("respects --since, excluding the boundary commit itself", async () => {
    const { dir } = await newGitProject();
    const boundary = git(dir, "rev-parse", "HEAD");
    const created = await handleTicketCreate(
      { title: "Since ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json",
      dir,
    );
    const ticketId = JSON.parse(created.output).data.id as string;
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `feat(${ticketId}): after the boundary`);

    const ctx = await ctxFor(dir, "json");
    const result = handleLandings({ since: boundary }, ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.landings).toHaveLength(1);
    expect(parsed.data.landings[0].subject).toContain("after the boundary");
  });

  it("reports no landings found for a genuinely empty range (--since HEAD), without erroring", async () => {
    const { dir } = await newGitProject();
    const head = git(dir, "rev-parse", "HEAD");
    const ctx = await ctxFor(dir, "md");
    const result = handleLandings({ since: head }, ctx);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toBe("No landings found.");
  });

  it("surfaces landings-unavailable as an io_error CLI result, not a thrown error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landings-cli-not-a-repo-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const ctx = await ctxFor(dir, "md");
    const result = handleLandings({}, ctx);
    expect(result.errorCode).toBe("io_error");
    expect(result.exitCode).toBeDefined();
    expect(result.output).toContain("Error [io_error]");
  });

  it("surfaces landings-unavailable through the JSON error envelope too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landings-cli-not-a-repo-json-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const ctx = await ctxFor(dir, "json");
    const result = handleLandings({}, ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.error.code).toBe("io_error");
  });
});
