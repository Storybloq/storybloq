/**
 * ISS-1499 slice B, commit 8: the MCP identity, the skill text and the
 * budgets (plan sections 10 and 11). C3, C7, the opted-in half of C14, B12.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initProject } from "../../../src/core/init.js";
import { memoFileName, readLineMemo, serializeLineMemo } from "../../../src/core/handover-line-memo.js";
import { appendLineage, serializeLineage, splitLineage, type LineageInput } from "../../../src/core/handover-lineage.js";
import { OTHER_LINES_POINTER } from "../../../src/core/output-formatter.js";
import { currentClientTaskId } from "../../../src/autonomous/client-profile.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { handleSessionResumePrompt } from "../../../src/cli/commands/session-compact.js";
import { handleSessionIntelPrompt } from "../../../src/cli/commands/session-intel.js";
import { ensureCapture } from "../../../src/core/session-intel/capture.js";
import { processEra } from "../../../src/core/session-intel/process-era.js";
import { SID, assistantRecord, writeTranscript } from "../../core/session-intel-fixtures.js";
import { callMcp, isolateEnv, runCli, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const SKILL_DIR = resolve(here, "../../../src/skill");
const TASK = "task-mcp.1";
const OTHER = "task-other.1";

let env: IsolatedEnv;
beforeEach(() => { env = isolateEnv(); });
afterEach(() => {
  vi.useRealTimers();
  processEra.reset();
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

const body = (id: string): string => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n`;
const linked = (id: string, attrs: LineageInput): string => appendLineage(body(id), serializeLineage(attrs).line);

interface Proj { root: string; hdir: string }
async function project(files: Record<string, string>): Promise<Proj> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "mcp" });
  const hdir = join(root, ".story", "handovers");
  for (const [n, c] of Object.entries(files)) writeFileSync(join(hdir, n), c);
  return { root, hdir };
}
const memoDir = (p: Proj): string => join(p.root, ".story", "telemetry", "handover-lines");
function seedMemo(p: Proj, task: string, tip: string): void {
  mkdirSync(memoDir(p), { recursive: true });
  writeFileSync(join(memoDir(p), memoFileName(task)), serializeLineMemo({ v: 1, task, tip, writing: null }));
}
const newFile = (p: Proj, before: readonly string[]): string => readdirSync(p.hdir).find((n) => !before.includes(n))!;
interface Envelope { data?: Record<string, unknown> }

const U = "2026-11-10-01-u.md";
const L1 = "2026-11-11-01-l1.md";
const D = "2026-11-12-01-d.md";

describe("MCP identity (variant P): clientTaskId on storybloq_handover_latest and storybloq_handover_create", () => {
  it("latest reads the named identity's line, not the inherited one", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = OTHER;
    const p = await project({ [U]: body("T-1"), [L1]: linked("T-2", { continues: U }), [D]: body("T-3") });
    seedMemo(p, TASK, L1);
    const named = JSON.parse((await callMcp(p.root, "storybloq_handover_latest", { count: 1, clientTaskId: TASK, format: "json" })).text) as Envelope;
    expect(named.data?.filename).toBe(L1);
    const inherited = JSON.parse((await callMcp(p.root, "storybloq_handover_latest", { count: 1, format: "json" })).text) as Envelope;
    expect(inherited.data?.filename).toBe(D);
  });

  it("create continues the named identity's line and advances only its memo", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = OTHER;
    const p = await project({ [U]: body("T-1"), [L1]: linked("T-2", { continues: U }), [D]: body("T-3") });
    seedMemo(p, TASK, L1);
    const before = readdirSync(p.hdir);
    const r = await callMcp(p.root, "storybloq_handover_create", { content: body("T-4"), slug: "named", clientTaskId: TASK });
    expect(r.isError, r.text).toBe(false);
    const made = newFile(p, before);
    expect(splitLineage(readFileSync(join(p.hdir, made), "utf8")).lineage?.lineage.continues).toEqual({ state: "valid", file: L1 });
    expect(readLineMemo(p.root, TASK)?.tip).toBe(made);
    expect(readLineMemo(p.root, OTHER)).toBeNull();
    // Without it, the inherited identity has no memo: an unlinked handover.
    const before2 = readdirSync(p.hdir);
    await callMcp(p.root, "storybloq_handover_create", { content: body("T-5"), slug: "inherited" });
    expect(splitLineage(readFileSync(join(p.hdir, newFile(p, before2)), "utf8")).lineage).toBeNull();
    expect(readLineMemo(p.root, TASK)?.tip).toBe(made);
  });
});

describe("B12: identity", () => {
  it("currentClientTaskId: explicit beats the environment, an invalid explicit is null, only the selected client's variable is read", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "claude-env";
    process.env.CODEX_THREAD_ID = "codex-env";
    expect(currentClientTaskId("explicit.1")).toBe("explicit.1");
    expect(currentClientTaskId()).toBe("claude-env");
    expect(currentClientTaskId("bad id")).toBeNull();
    process.env.STORYBLOQ_CLIENT = "codex";
    expect(currentClientTaskId()).toBe("codex-env");
    delete process.env.CODEX_THREAD_ID;
    expect(currentClientTaskId()).toBeNull();
    process.env.STORYBLOQ_CLIENT = "claude";
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CODEX_THREAD_ID = "codex-env";
    expect(currentClientTaskId()).toBeNull();
  });

  it("an invalid identity: invalid_input on latest, template and continue (CLI and MCP latest); identity_invalid on create (CLI and MCP), which still writes", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = OTHER;
    const p = await project({ [U]: body("T-1") });
    for (const args of [["latest"], ["template"], ["continue", U]]) {
      const r = await runCli(p.root, ["handover", ...args, "--as", "bad id", "--format", "json"]);
      expect((JSON.parse(r.stdout) as { error?: { code: string } }).error?.code, args[0]).toBe("invalid_input");
    }
    const latest = await callMcp(p.root, "storybloq_handover_latest", { count: 1, clientTaskId: "bad id" });
    expect(latest.isError).toBe(true);
    expect(latest.text).toContain("not a valid client task id");
    const before = readdirSync(p.hdir);
    const cli = await runCli(p.root, ["handover", "create", "--content", body("T-2"), "--slug", "cli", "--as", "bad id", "--format", "json"]);
    expect(cli.stdout).toContain("identity_invalid");
    const mcp = await callMcp(p.root, "storybloq_handover_create", { content: body("T-3"), slug: "mcp", clientTaskId: "bad id" });
    expect(mcp.isError).toBe(false);
    expect(mcp.text).toContain("Ignored --as: it is not a valid client task id, so no session line was read or recorded.");
    expect(readdirSync(p.hdir).filter((n) => !before.includes(n))).toHaveLength(2);
    expect(existsSync(memoDir(p))).toBe(false);
  });
});

describe("C3: opting in is explicit", () => {
  const CEILING = 0.925 * 450_000;
  const IMPERATIVE_TOKENS = Math.ceil(0.9 * CEILING) + 5_000;

  it("the skill's read pair, a template, a context alert, the handover it asks for and the compact pointer add no lineage line and no memo folder", async () => {
    const home = join(env.base, "home");
    const projects = join(home, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    const userSettings = join(home, ".claude", "settings.json");
    writeFileSync(userSettings, JSON.stringify({ autoCompactWindow: 450_000 }));
    process.env.CLAUDE_CODE_SESSION_ID = SID;
    process.env.CLAUDE_PID = String(process.pid);
    processEra.reset();
    const p = await project({ [U]: body("T-1"), [D]: body("T-3") });

    for (const args of [{ count: 1, priming: true }, { count: 10, brief: true }]) {
      expect((await callMcp(p.root, "storybloq_handover_latest", { ...args, clientTaskId: SID })).isError).toBe(false);
    }
    // The scaffold `/story handover` drafts from, written as the handover below.
    const scaffold = (await runCli(p.root, ["handover", "template", "--as", SID])).stdout;
    expect(scaffold).not.toBe("");

    const now = Date.now();
    ensureCapture({ root: p.root, sessionId: SID, source: "startup", now: now - 30 * 60_000, userSettingsPath: userSettings });
    const path = writeTranscript(projects, p.root.replace(/[^A-Za-z0-9]/g, "-"), SID, [
      assistantRecord({ ts: new Date(now - 60_000).toISOString(), read: IMPERATIVE_TOKENS }),
    ]);
    const alert = handleSessionIntelPrompt({ sessionId: SID, transcriptPath: path, now, cwd: p.root, projectsDir: projects, userSettingsPath: userSettings });
    expect(alert.status, String(alert.reason)).toBe("emitted");

    expect((await callMcp(p.root, "storybloq_handover_create", { content: scaffold, slug: "alert", clientTaskId: SID })).isError).toBe(false);
    const orig = process.stdout.write;
    (process.stdout.write as unknown) = (): boolean => true;
    try {
      await handleSessionResumePrompt({ source: "compact", cwd: p.root, clientTaskId: SID });
    } finally {
      process.stdout.write = orig;
    }

    const files = readdirSync(p.hdir);
    expect(files).toHaveLength(3);
    for (const f of files) expect(splitLineage(readFileSync(join(p.hdir, f), "utf8")).lineage, f).toBeNull();
    expect(existsSync(memoDir(p))).toBe(false);
  });
});

describe("C14 opted-in half: the skill's read pair through the MCP tool, zero slack", () => {
  /** Ten handovers on the default line; the newest is over 12,000 bytes, and the brief's index alone overruns its budget. */
  function ownTen(): Record<string, string> {
    const own: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const n = i === 9 ? 400 : 60;
      const items = Array.from({ length: n }, (_, k) => `- **T-${i}${String(k).padStart(3, "0")}** ${"label ".repeat(6)}`).join("\n");
      own[`2026-11-${String(5 + i).padStart(2, "0")}-01-own.md`] = `# H${i}\n\n## Next steps\n\n${items}\n`;
    }
    return own;
  }
  const others = {
    "2026-11-15-01-o1.md": linked("T-91", { role: "a" }),
    "2026-11-15-02-o2.md": linked("T-92", { role: "b" }),
    "2026-11-15-03-o3.md": linked("T-93", { role: "c" }),
  };

  it("the priming result carries the block with handovers[] unchanged; the brief result carries none, byte for byte", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T03:00:00Z"));
    process.env.CLAUDE_CODE_SESSION_ID = OTHER;
    const crowded = await project({ ...ownTen(), ...others });
    const alone = await project(ownTen());
    const pair = [{ count: 1, priming: true }, { count: 10, brief: true }] as const;

    const primed = async (root: string, format: "md" | "json") =>
      (await callMcp(root, "storybloq_handover_latest", { ...pair[0], clientTaskId: TASK, format })).text;
    const cj = JSON.parse(await primed(crowded.root, "json")) as Envelope;
    const aj = JSON.parse(await primed(alone.root, "json")) as Envelope;
    expect((cj.data?.handovers as Array<{ form: string }>)[0]!.form).toBe("structured");
    expect(cj.data?.handovers).toEqual(aj.data?.handovers);
    expect((cj.data?.lines as { otherLines: { recent: unknown[] } }).otherLines.recent).toHaveLength(3);
    expect(aj.data?.lines).toBeUndefined();
    expect(await primed(crowded.root, "md")).toContain(OTHER_LINES_POINTER);
    expect(await primed(alone.root, "md")).not.toContain(OTHER_LINES_POINTER);

    for (const format of ["md", "json"]) {
      const a = (await callMcp(alone.root, "storybloq_handover_latest", { ...pair[1], clientTaskId: TASK, format })).text;
      const c = (await callMcp(crowded.root, "storybloq_handover_latest", { ...pair[1], clientTaskId: TASK, format })).text;
      expect(c, format).toBe(a);
      expect(c).not.toContain(OTHER_LINES_POINTER);
    }
  });
});

describe("C7: budgets and the shipped variant", () => {
  it("tools/list is no larger than main's 90,522 bytes, and both handover tools take clientTaskId", async () => {
    const server = new McpServer({ name: "storybloq", version: "0.0.0" });
    registerAllTools(server, env.base);
    const client = new Client({ name: "measure", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const { tools } = await client.listTools();
    await client.close();
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThanOrEqual(90_522);
    for (const name of ["storybloq_handover_latest", "storybloq_handover_create"]) {
      const props = (tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props.clientTaskId, name).toEqual({ type: "string" });
    }
  });

  it("the skill passes clientTaskId on the read pair and the create, and names the several-lines step (variant P)", () => {
    const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    const step = skill.split("\n").find((l) => l.startsWith("3. **Recent handovers**"))!;
    expect(step).toContain("`count: 1, priming: true`");
    expect(step).toContain("`count: 10, brief: true`");
    expect(step).toContain("`clientTaskId` when resolved");
    expect(step).toContain("`storybloq handover continue <file>`");
    const route = skill.split("\n").find((l) => l.startsWith("- `/story handover` ->"))!;
    expect(route).toContain("`storybloq_handover_create`");
    expect(route).toContain("`clientTaskId` when resolved");
    expect(skill).not.toContain("--brief --as <id>");
    const duet = readFileSync(join(SKILL_DIR, "duet-mode.md"), "utf8");
    expect(duet).toContain("A seat's first handover starts its line (`--new-line --role <role>`)");
    expect(duet).toContain("`handover continue <tip>`");
    const reference = readFileSync(join(SKILL_DIR, "reference.md"), "utf8");
    expect(reference).toContain("- **handover continue [<file>]** (--default?, --fork?, --as?, --format?)");
    expect(reference).toContain("- **storybloq_handover_latest** (count?, brief?, priming?, format?, clientTaskId?)");
    expect(reference).toContain("- **storybloq_handover_create** (content, slug?, commit?, clientTaskId?)");
  });
});
