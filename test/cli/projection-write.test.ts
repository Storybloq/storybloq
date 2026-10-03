/**
 * T-528 commit 0: where the decisions projection is written, and where it is
 * not. The call sites run through the REAL yargs trees in-process, so a
 * registration that forgets its refresh (or refreshes twice) is caught here.
 * RED at d38bd676: `src/cli/commands/projection.ts` does not exist there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import yargs, { type Argv } from "yargs";
import {
  registerCapabilityCommand,
  registerRulingCommand,
  registerStatusCommand,
  registerTermCommand,
} from "../../src/cli/register.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { withProjectLock } from "../../src/core/project-loader.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { hashPass, ledgerRevision } from "../../src/core/decisions-projection.js";
import {
  CACHE_GITIGNORE,
  handleProjectionWrite,
  projectionPath,
  projectionTestHooks,
  refreshProjectionAfterWrite,
  refreshProjectionAtSessionStart,
  storedProjectionRevision,
  writeDecisionsProjection,
} from "../../src/cli/commands/projection.js";
import { buildSyntheticLedger } from "../../scripts/projection-fixtures.js";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
let publishes: string[] = [];
beforeEach(() => {
  publishes = [];
  projectionTestHooks.onPublish = (root) => publishes.push(root);
});
afterEach(() => {
  projectionTestHooks.onPublish = undefined;
  for (const r of roots.splice(0)) {
    try { chmodSync(join(r, ".story", "cache"), 0o755); } catch { /* absent */ }
    rmSync(r, { recursive: true, force: true });
  }
});

async function project(git = false): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "projection-write-"));
  roots.push(root);
  await initProject(root, { name: "projection-test" });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "thing.ts"), "export const thing = 1;\n");
  if (git) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const g = (args: string[]): void => { execFileSync("git", args, { cwd: root, env, stdio: "ignore" }); };
    g(["init", "-q", "-b", "main"]); g(["config", "user.name", "t"]); g(["config", "user.email", "t@t.t"]); g(["add", "-A"]); g(["commit", "-q", "-m", "init"]);
  }
  return root;
}

function synthetic(): string {
  const root = mkdtempSync(join(tmpdir(), "projection-write-syn-"));
  roots.push(root);
  buildSyntheticLedger(root, { pointer: true, unreadable: false });
  return root;
}

/** Runs one real yargs tree in-process from `root`; returns exit code and stderr. */
async function run(root: string, register: (y: Argv) => Argv, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origCwd = process.cwd();
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (chunk: string | Uint8Array) => { out.push(String(chunk)); return true; };
  (process.stderr.write as unknown) = (chunk: string | Uint8Array) => { err.push(String(chunk)); return true; };
  try {
    process.chdir(root);
    process.exitCode = undefined;
    await register(yargs(args)).exitProcess(false).fail(false).parseAsync();
    return { code: (process.exitCode as number | undefined) ?? 0, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.chdir(origCwd);
    process.exitCode = origExit;
  }
}

const WHO = ["--attribution", "owner-direct", "--date", "2026-09-22", "--client-task-id", "projection-test"];

type McpHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function tools(root: string): Map<string, McpHandler> {
  const map = new Map<string, McpHandler>();
  registerAllTools({ registerTool: (name: string, _c: unknown, h: McpHandler) => map.set(name, h) } as never, root);
  return map;
}

describe("call sites", () => {
  it("each enumerated CLI call site regenerates exactly once per invocation", async () => {
    const root = await project(true);
    const rulingIds = (): string[] => readdirSync(join(root, ".story", "rulings")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    const byStatus = (status: string | undefined): string => rulingIds().find((id) => (JSON.parse(readFileSync(join(root, ".story", "rulings", `${id}.json`), "utf-8")) as { status?: string }).status === status)!;
    const sites: [string, (y: Argv) => Argv, string[] | (() => string[])][] = [
      ["ruling create", registerRulingCommand, ["ruling", "create", "--text", "R1", ...WHO]],
      ["ruling supersede", registerRulingCommand, () => ["ruling", "supersede", rulingIds()[0]!, "--text", "R2", ...WHO]],
      ["ruling propose", registerRulingCommand, ["ruling", "propose", "--text", "P1", ...WHO]],
      ["ruling withdraw", registerRulingCommand, () => ["ruling", "withdraw", byStatus("proposed"), "--client-task-id", "projection-test"]],
      ["capability add", registerCapabilityCommand, ["capability", "add", "--id", "cap-thing", "--name", "Thing", "--summary", "Does the thing.", "--contract", "Returns the thing.", "--entry", "src/thing.ts"]],
      ["capability update", registerCapabilityCommand, ["capability", "update", "cap-thing", "--summary", "Does the thing well."]],
      ["capability check --stamp", registerCapabilityCommand, ["capability", "check", "--stamp", "cap-thing"]],
      ["capability defer", registerCapabilityCommand, ["capability", "defer", "cap-thing", "--note", "later"]],
      ["term add", registerTermCommand, ["term", "add", "--id", "term-thing", "--term", "thing", "--definition", "The thing."]],
      ["term defer", registerTermCommand, ["term", "defer", "term-thing", "--note", "later"]],
      ["term remove", registerTermCommand, ["term", "remove", "term-thing"]],
      ["status", registerStatusCommand, ["status"]],
    ];
    for (const [name, register, args] of sites) {
      publishes = [];
      const r = await run(root, register, typeof args === "function" ? args() : args);
      expect(r.code, `${name}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(publishes, name).toHaveLength(1);
    }
    // A plain check writes nothing; a stamp is a write.
    publishes = [];
    expect((await run(root, registerCapabilityCommand, ["capability", "check"])).code).toBeGreaterThanOrEqual(0);
    expect(publishes).toHaveLength(0);
  });

  it("a failed write does not regenerate", async () => {
    const root = await project();
    const r = await run(root, registerTermCommand, ["term", "remove", "term-nope"]);
    expect(r.code).not.toBe(0);
    expect(publishes).toHaveLength(0);
  });

  it("a ticket or issue write leaves the projection stale", async () => {
    const root = await project();
    await writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000 });
    const written = storedProjectionRevision(root);
    expect(written).toBe(ledgerRevision(hashPass(root)));
    await handleIssueCreate({ title: "x", severity: "low", impact: "x", components: [], relatedTickets: [], location: [] }, "json", root);
    expect(publishes).toHaveLength(1);
    expect(storedProjectionRevision(root)).toBe(written);
    expect(ledgerRevision(hashPass(root))).not.toBe(written);
  });

  it("the MCP status tool writes nothing", async () => {
    const root = await project();
    const out = await tools(root).get("storybloq_status")!({});
    expect(out.isError).toBeFalsy();
    expect(publishes).toHaveLength(0);
    expect(existsSync(join(root, ".story", "cache"))).toBe(false);
  });
});

describe("failure never fails the command", () => {
  it("a read-only cache/ leaves the ruling write successful with the stderr line", async () => {
    const root = await project();
    await writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000 });
    chmodSync(join(root, ".story", "cache"), 0o500);
    const r = await run(root, registerRulingCommand, ["ruling", "create", "--text", "R1", ...WHO]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stderr).toMatch(/^projection not updated: /m);
    expect(publishes).toHaveLength(1);
  });

  it("a resolver that throws is one stderr line and a false return", async () => {
    const root = synthetic();
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c) => { err.push(String(c)); return true; });
    try {
      const ok = await refreshProjectionAfterWrite(root, { deps: { upwardBoard: () => { throw new Error("resolver exploded"); } } });
      expect(ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(err.join("")).toBe("projection not updated: resolver exploded\n");
    expect(existsSync(projectionPath(root))).toBe(false);
  });
});

describe("locking", () => {
  it("two concurrent writes serialize on the projection lock", async () => {
    const root = await project();
    const spans: [number, number][] = [];
    const one = async (): Promise<void> => {
      let start = 0;
      await writeDecisionsProjection(root, {
        mode: "full",
        deadlineMs: 30_000,
        afterLock: async () => { start = Date.now(); await new Promise((r) => setTimeout(r, 300)); },
      });
      spans.push([start, Date.now()]);
    };
    await Promise.all([one(), one()]);
    spans.sort((a, b) => a[0] - b[0]);
    expect(spans[1]![0]).toBeGreaterThanOrEqual(spans[0]![1] - 5);
    expect(publishes).toHaveLength(2);
  });

  it("a write never takes the ledger lock: it completes while another holder has it", async () => {
    const root = await project();
    let done = false;
    await withProjectLock(root, { strict: false }, async () => {
      await writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000 });
      done = true;
    });
    expect(done).toBe(true);
    expect(publishes).toHaveLength(1);
  });
});

describe("SessionStart and the cache directory", () => {
  it("an equal revision writes nothing; a moved ledger writes once", async () => {
    const root = await project();
    expect(await refreshProjectionAtSessionStart(root)).toBe("written");
    expect(await refreshProjectionAtSessionStart(root)).toBe("unchanged");
    expect(publishes).toHaveLength(1);
    await handleIssueCreate({ title: "x", severity: "low", impact: "x", components: [], relatedTickets: [], location: [] }, "json", root);
    expect(await refreshProjectionAtSessionStart(root)).toBe("written");
    expect(publishes).toHaveLength(2);
  });

  it("SessionStart runs no freshness check and records no head", async () => {
    const root = await project(true);
    expect(await refreshProjectionAtSessionStart(root)).toBe("written");
    const p = JSON.parse(readFileSync(projectionPath(root), "utf-8")) as { headCommit: unknown; freshnessInputs: { mode: string } };
    expect(p.headCommit).toBeNull();
    expect(p.freshnessInputs.mode).toBe("structural");
  });

  it("`.story/cache/.gitignore` is `*`, and init ignores cache/", async () => {
    const root = await project();
    await writeDecisionsProjection(root, { mode: "structural", deadlineMs: 30_000 });
    expect(readFileSync(join(root, ".story", "cache", ".gitignore"), "utf-8")).toBe(CACHE_GITIGNORE);
    expect(CACHE_GITIGNORE).toBe("*\n");
    expect(readFileSync(join(root, ".story", ".gitignore"), "utf-8").split("\n")).toContain("cache/");
  });
});

describe("MCP storybloq_projection_write", () => {
  it("is registered and answers exactly what the CLI handler answers", async () => {
    const root = await project();
    const tool = tools(root).get("storybloq_projection_write");
    expect(tool).toBeDefined();
    const mcp = await tool!({});
    expect(mcp.isError).toBeFalsy();
    const cli = await handleProjectionWrite("md", root);
    // ISS-1107: the MCP reply then carries the git state of the file it wrote
    // (this project is not a repository); the handler's own text is identical.
    const [body, ...gitLines] = mcp.content[0]!.text.split("\n\nGit: ");
    expect(body).toBe(cli.output);
    expect(gitLines.length).toBeGreaterThan(0);
    for (const line of gitLines.join("\n").split("\n")) {
      expect(line.replace(/^Git: /, "")).toMatch(/^\.story\/cache\/\S+ no git \(not a repository\)$/);
    }
    expect(publishes).toHaveLength(2);
  });
});
