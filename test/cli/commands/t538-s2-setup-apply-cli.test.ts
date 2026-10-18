/**
 * T-538 S2 commit 6: the setup engine's surfaces (plan v5 1a, 1c, 6c). The
 * CLI and MCP calls hand their input to the one engine and print its lines
 * with its exit code; the degraded MCP surface carries setup_apply and swaps
 * to the full one once the setup has published the project; setup-report
 * prints the live report or the frozen one and writes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadProject } from "../../../src/core/project-loader.js";
import { setupApplySeams } from "../../../src/core/setup-apply.js";
import { handleSetupApply, handleSetupReport } from "../../../src/cli/commands/setup-apply.js";
import { handleTicketCreate, handleTicketUpdate } from "../../../src/cli/commands/ticket.js";
import { parseSetupMeta } from "../../../src/core/setup-meta.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { registerDegradedTools } from "../../../src/mcp/index.js";
import { COMMANDS, MCP_TOOLS } from "../../../src/cli/commands/reference.js";
import { shouldSkipHousekeeping } from "../../../src/cli/housekeeping.js";
import { reportBoardWrite } from "../../../src/core/board-git-state.js";

const SID = "SS-0123abcd";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-cli-home-"));
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
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const d = realpathSync(await mkdtemp(join(tmpdir(), "t538-cli-")));
  dirs.push(d);
  return d;
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved", "Round 1 of 2"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: {
      level: "full",
      verifyApplies: false,
      components: [{ id: "root", workdir: ".", test: { command: "npm test", status: "established" }, build: { command: "npm run build", status: "pending", reason: "no build script yet" }, verify: null }],
    },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [{ path: "CLAUDE.md", content: "# demo\n" }] },
    git: { init: false, gitignore: ["node_modules/"] },
    phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "the first version" }],
    tickets: [
      { key: "K2", title: "Sign in", type: "feature", phase: "K1", description: "d", blockedBy: [] },
      { key: "K3", title: "Profile", type: "feature", phase: "K1", description: "d", blockedBy: ["K2"] },
    ],
    checkpoints: [{ key: "K4", title: "Accept sign in", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: ["K3"] }],
    issues: [],
    coverage: [{ requirement: "R1", text: "sign in", source: "brief", keys: ["K2", "K4"] }],
    ...over,
  };
}

const io = (cwd: string, stdin = "") => ({ cwd, env: process.env, stdin: () => Buffer.from(stdin) });
const linesOf = (stdout: string) => stdout.split("\n").filter((l) => l !== "");
/** The engine's own lines: on an existing project the board-write `Git:` report follows them. */
const engineLines = (stdout: string) => linesOf(stdout).filter((l) => !l.startsWith("Git: "));

async function idOf(root: string, key: string): Promise<string> {
  const { state } = await loadProject(root);
  const t = state.tickets.find((x) => {
    const meta = parseSetupMeta("ticket", x);
    return meta.kind === "item" && meta.meta.key === key;
  });
  return t!.id;
}

async function complete(root: string, id: string): Promise<void> {
  await handleTicketUpdate(id, { status: "complete" }, "json", root);
}

describe("storybloq setup-apply (CLI)", () => {
  it("applies the payload on standard input and prints the engine's lines with its exit code", { timeout: 30_000 }, async () => {
    const root = await folder();
    const result = await handleSetupApply(io(root, JSON.stringify(payload())), {});
    expect(result.exitCode).toBe(0);
    const lines = linesOf(result.stdout);
    expect(lines.at(-1)).toBe(`Setup applied: ${SID}`);
    expect(lines).toContain('First story: T-001 "Sign in"');
    expect(existsSync(join(root, ".story", "config.json"))).toBe(true);
  });

  it("refuses an empty, non-JSON or misplaced input with exit 2 and writes nothing", async () => {
    const root = await folder();
    const cases: Array<[string, Parameters<typeof handleSetupApply>[1], RegExp]> = [
      ["", {}, /^Setup refused: no payload on standard input/],
      ["{not json", {}, /^Setup refused: the payload on standard input is not JSON\./],
      [JSON.stringify(payload()), { setup: SID }, /^Setup refused: --setup goes with --resume or --resolve/],
      ["", { resume: true }, /^Setup refused: --setup <id> is required with --resume\./],
      ["", { resolve: "[]" }, /^Setup refused: --setup <id> is required with --resolve\./],
      ["", { resume: true, resolve: "[]", setup: SID }, /^Setup refused: --resume and --resolve are separate calls/],
      ["", { resolve: "[oops", setup: SID }, /^Setup refused: --resolve is not JSON\./],
    ];
    for (const [stdin, opts, expected] of cases) {
      const result = await handleSetupApply(io(root, stdin), opts);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toMatch(expected);
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("--resume --setup finishes an interrupted setup, and repeats the frozen report once complete", { timeout: 30_000 }, async () => {
    const root = await folder();
    setupApplySeams.fault = (point) => { if (point === "step:item:K3") throw new Error("power cut"); };
    const first = await handleSetupApply(io(root, JSON.stringify(payload())), {});
    expect(first.exitCode).toBe(3);
    expect(first.stdout).toContain(`Resume with storybloq setup-apply --resume --setup ${SID}.`);
    setupApplySeams.fault = () => {};
    const resumed = await handleSetupApply(io(root), { resume: true, setup: SID });
    expect(resumed.exitCode).toBe(0);
    expect(engineLines(resumed.stdout).at(-1)).toBe(`Setup applied: ${SID}`);
    const again = await handleSetupApply(io(root), { resume: true, setup: SID });
    expect(again.exitCode).toBe(0);
    expect(linesOf(again.stdout).at(-1)).toBe(`Setup applied: ${SID} (already complete; nothing written)`);
  });

  it("--resolve hands the owner's answers to the engine: stop is exit 3, an unreviewed material answer exit 2, restore-planned finishes", { timeout: 30_000 }, async () => {
    const root = await folder();
    setupApplySeams.fault = (point) => { if (point === "step:item:K3") throw new Error("power cut"); };
    await handleSetupApply(io(root, JSON.stringify(payload())), {});
    setupApplySeams.fault = () => {};
    const k2 = await idOf(root, "K2");
    await handleTicketUpdate(k2, { title: "Log in" }, "json", root);
    const stopped = await handleSetupApply(io(root), { resume: true, setup: SID });
    expect(stopped.exitCode).toBe(4);
    const target = linesOf(stopped.stdout).find((l) => l.startsWith("Ambiguity:"))!.split(" · ")[1]!;
    const resolved = await handleSetupApply(io(root), { setup: SID, resolve: JSON.stringify([{ target, resolution: "stop", ownerWords: "leave it" }]) });
    expect(resolved.exitCode).toBe(3);
    const material = await handleSetupApply(io(root), { setup: SID, resolve: JSON.stringify([{ target, resolution: "accept-current", ownerWords: "keep my title" }]) });
    expect(material.exitCode).toBe(2);
    const restored = await handleSetupApply(io(root), { setup: SID, resolve: JSON.stringify([{ target, resolution: "restore-planned", ownerWords: "use the plan's title" }]) });
    expect(restored.exitCode).toBe(0);
    expect(engineLines(restored.stdout).at(-1)).toBe(`Setup applied: ${SID}`);
    expect((await loadProject(root)).state.ticketByID(k2)!.title).toBe("Sign in");
  });

  it("is registered with its flags, documented in the reference, and skips housekeeping", () => {
    expect(COMMANDS.find((c) => c.name === "setup-apply")?.flags).toEqual(["--setup", "--resume", "--resolve"]);
    expect(COMMANDS.find((c) => c.name === "setup-report")?.flags).toEqual(["--setup", "--historical"]);
    expect(MCP_TOOLS.find((t) => t.name === "storybloq_setup_apply")?.params).toEqual(["payload?", "resume?", "setup?", "resolutions?"]);
    expect(MCP_TOOLS.find((t) => t.name === "storybloq_setup_report")?.params).toEqual(["setup", "historical?"]);
    expect(shouldSkipHousekeeping(["setup-apply"])).toBe(true);
  });
});

describe("the reference entry (review r1 #8)", () => {
  it("marks --setup optional: required only with --resume or --resolve, and refused with a stdin payload", () => {
    const reference = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "skill", "reference.md"), "utf-8");
    expect(reference).toContain("- **setup-apply** (--setup?, --resume?, --resolve?) - Setup: stdin payload; --setup only with --resume/--resolve\n");
  });
});

describe("storybloq setup-report (plan v5 6c)", () => {
  it("prints the live report and, with --historical, the frozen one; a readiness change moves only the live one", { timeout: 30_000 }, async () => {
    const root = await folder();
    await handleSetupApply(io(root, JSON.stringify(payload())), {});
    const historical = await handleSetupReport(io(root), { setup: SID, historical: true });
    expect(historical.exitCode).toBe(0);
    const live = await handleSetupReport(io(root), { setup: SID });
    expect(live.exitCode).toBe(0);
    expect(linesOf(live.stdout)).toContain('First story: T-001 "Sign in"');
    expect(live.stdout).toBe(historical.stdout);

    await complete(root, await idOf(root, "K2"));
    const after = await handleSetupReport(io(root), { setup: SID });
    expect(linesOf(after.stdout)).toContain("Ready to build: none");
    expect(linesOf(after.stdout)).toContain("First story: none (everything open waits on the owner)");
    expect((await handleSetupReport(io(root), { setup: SID, historical: true })).stdout).toBe(historical.stdout);
  });

  it("names the owner when the only open item is a checkpoint that holds nothing back", { timeout: 30_000 }, async () => {
    const root = await folder();
    const checkpoints = [{ key: "K4", title: "Accept sign in", kind: "acceptance", criteria: "works", evidenceRefs: [], description: "", phase: "K1", blockedBy: ["K2"], gates: [] }];
    expect((await handleSetupApply(io(root, JSON.stringify(payload({ checkpoints }))), {})).exitCode).toBe(0);
    await complete(root, await idOf(root, "K2"));
    await complete(root, await idOf(root, "K3"));
    const live = await handleSetupReport(io(root), { setup: SID });
    expect(linesOf(live.stdout)).toContain("First story: none (everything open waits on the owner)");
  });

  it("names other work when everything open waits on an item outside the setup", { timeout: 30_000 }, async () => {
    const root = await folder();
    const applied = await handleSetupApply(io(root, JSON.stringify(payload({ checkpoints: [], coverage: [{ requirement: "R1", text: "sign in", source: "brief", keys: ["K2"] }] }))), {});
    expect(applied.exitCode).toBe(0);
    const outside = await handleTicketCreate({ title: "Vendor contract", type: "chore", phase: "build", description: "", blockedBy: [], parentTicket: null }, "json", root);
    const outsideId = (JSON.parse(outside.output) as { data: { id: string } }).data.id;
    await handleTicketUpdate(await idOf(root, "K2"), { blockedBy: [outsideId] }, "json", root);
    const live = await handleSetupReport(io(root), { setup: SID });
    expect(linesOf(live.stdout)).toContain("First story: none (everything open waits on other work)");
  });

  it("counts adopted items apart from created ones", { timeout: 30_000 }, async () => {
    const root = await folder();
    setupApplySeams.fault = (point) => { if (point === "step:phase:K1") throw new Error("power cut"); };
    await handleSetupApply(io(root, JSON.stringify(payload())), {});
    setupApplySeams.fault = () => {};
    await handleTicketCreate({ title: "Sign in", type: "feature", phase: "build", description: "d", blockedBy: [], parentTicket: null }, "json", root);
    const stopped = await handleSetupApply(io(root), { resume: true, setup: SID });
    expect(stopped.exitCode).toBe(4);
    const line = linesOf(stopped.stdout).find((l) => l.startsWith("Ambiguity:"))!;
    const adopt = line.split("resolutions: ")[1]!.split(" | ").find((r) => r.startsWith("adopt "))!;
    const done = await handleSetupApply(io(root), { setup: SID, resolve: JSON.stringify([{ target: line.split(" · ")[1]!, resolution: adopt, ownerWords: "that one is it" }]) });
    expect(done.exitCode).toBe(0);
    const live = await handleSetupReport(io(root), { setup: SID });
    expect(linesOf(live.stdout)).toContain("Created: 1 phases, 1 tickets, 1 checkpoints, 0 issues; adopted: 1");
  });

  it("refuses an unknown setup, and a frozen report before the setup has one, with exit 2", { timeout: 30_000 }, async () => {
    const root = await folder();
    const none = await handleSetupReport(io(root), { setup: SID });
    expect(none.exitCode).toBe(2);
    setupApplySeams.fault = (point) => { if (point === "step:item:K3") throw new Error("power cut"); };
    await handleSetupApply(io(root, JSON.stringify(payload())), {});
    setupApplySeams.fault = () => {};
    const early = await handleSetupReport(io(root), { setup: SID, historical: true });
    expect(early.exitCode).toBe(2);
    expect(early.stdout).toMatch(/has no frozen report yet/);
    expect((await handleSetupReport(io(root), { setup: "SS-ffffffff" })).exitCode).toBe(2);
  });
});

interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}
interface Registry { tools: Map<string, RegisteredTool>; removals: string[]; listChanged: number }

function makeRegistry(): { registry: Registry; server: never } {
  const registry: Registry = { tools: new Map(), removals: [], listChanged: 0 };
  const server = {
    registerTool: (name: string, _config: unknown, handler: RegisteredTool["handler"]) => {
      if (registry.tools.has(name)) throw new Error(`Tool ${name} is already registered`);
      registry.tools.set(name, { handler });
      return { remove: () => { registry.removals.push(name); registry.tools.delete(name); } };
    },
    sendToolListChanged: () => { registry.listChanged += 1; },
  } as unknown as never;
  return { registry, server };
}

describe("storybloq_setup_apply and storybloq_setup_report (MCP, plan v5 1c)", () => {
  it("is in the degraded set, and a setup that publishes the project swaps to the full set", { timeout: 30_000 }, async () => {
    const launchDir = await folder();
    const { registry, server } = makeRegistry();
    registerDegradedTools(server, undefined, { launchDir });
    expect(registry.tools.has("storybloq_setup_apply")).toBe(true);
    expect(registry.tools.has("storybloq_setup_report")).toBe(false);
    const out = await registry.tools.get("storybloq_setup_apply")!.handler({ payload: payload() });
    expect(out.isError).toBeUndefined();
    const text = out.content[0]!.text;
    expect(text.split("\n")[0]).toBe("[exit 0]");
    expect(text).toContain(`Setup applied: ${SID}`);
    expect(registry.removals).toContain("storybloq_setup_apply");
    expect(registry.tools.has("storybloq_setup_report")).toBe(true);
    expect(registry.tools.has("storybloq_ticket_get")).toBe(true);
    expect(registry.listChanged).toBeGreaterThan(0);
  });

  it("a fault after the bootstrap still swaps, and the full set's setup_apply resumes in the same process", { timeout: 30_000 }, async () => {
    const launchDir = await folder();
    const { registry, server } = makeRegistry();
    registerDegradedTools(server, undefined, { launchDir });
    setupApplySeams.fault = (point) => { if (point === "step:item:K3") throw new Error("power cut"); };
    const first = await registry.tools.get("storybloq_setup_apply")!.handler({ payload: payload() });
    setupApplySeams.fault = () => {};
    expect(first.content[0]!.text.split("\n")[0]).toBe("[exit 3]");
    expect(first.isError).toBe(true);
    expect(registry.tools.has("storybloq_ticket_get")).toBe(true);
    const resumed = await registry.tools.get("storybloq_setup_apply")!.handler({ resume: true, setup: SID });
    expect(resumed.content[0]!.text.split("\n")[0]).toBe("[exit 0]");
    const report = await registry.tools.get("storybloq_setup_report")!.handler({ setup: SID, historical: true });
    expect(report.content[0]!.text.split("\n")[0]).toBe("[exit 0]");
    expect(report.content[0]!.text).toContain('First story: T-001 "Sign in"');
  });

  it("a refused call in the degraded set stays degraded", async () => {
    const launchDir = await folder();
    const { registry, server } = makeRegistry();
    registerDegradedTools(server, undefined, { launchDir });
    const out = await registry.tools.get("storybloq_setup_apply")!.handler({});
    expect(out.content[0]!.text.split("\n")[0]).toBe("[exit 2]");
    expect(out.isError).toBe(true);
    expect(registry.removals).toEqual([]);
  });

  it("is in the full set beside setup_report", async () => {
    const root = await folder();
    await handleSetupApply(io(root, JSON.stringify(payload())), {});
    const { registry, server } = makeRegistry();
    registerAllTools(server, root, { launchDir: root });
    expect(registry.tools.has("storybloq_setup_apply")).toBe(true);
    const live = await registry.tools.get("storybloq_setup_report")!.handler({ setup: SID });
    expect(live.content[0]!.text.split("\n")[0]).toBe("[exit 0]");
  });
});

/** Every file under `root` but .git, with its bytes' digest. */
async function listing(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (rel === ".git" || rel.startsWith(".git/")) continue;
    out.set(rel, createHash("sha256").update(readFileSync(join(root, rel))).digest("hex"));
  }
  return out;
}

/** Paths created, changed or removed between two listings, sorted. */
const changedPaths = (a: Map<string, string>, b: Map<string, string>): string[] =>
  [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();

describe("write reporting, split by path (ISS-1107; pen ruling w9-a7 d)", () => {
  const gitLines = (stdout: string) => linesOf(stdout).filter((l) => l.startsWith("Git: "));

  it("a fresh bootstrap reports only the engine's lines", { timeout: 30_000 }, async () => {
    const root = await folder();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const result = await handleSetupApply(io(root, JSON.stringify(payload())), {});
    expect(result.exitCode).toBe(0);
    expect(gitLines(result.stdout)).toEqual([]);
  });

  it("a resume on the existing project appends exactly the report runBoardWrite gives for the files it wrote, after the engine's lines", { timeout: 30_000 }, async () => {
    const root = await folder();
    execFileSync("git", ["init", "-q"], { cwd: root });
    setupApplySeams.fault = (point) => { if (point === "step:item:K3") throw new Error("power cut"); };
    await handleSetupApply(io(root, JSON.stringify(payload())), {});
    setupApplySeams.fault = () => {};
    // Review r1 #11: the expected paths come from the filesystem, not from the output under test.
    const before = await listing(root);
    const resumed = await handleSetupApply(io(root), { resume: true, setup: SID });
    expect(resumed.exitCode).toBe(0);
    const changed = changedPaths(before, await listing(root));
    expect(changed).toEqual(expect.arrayContaining([".gitignore", "CLAUDE.md", expect.stringMatching(/^\.story\/tickets\/\S+\.json$/)]));
    const reported = gitLines(resumed.stdout);
    expect(reported.map((l) => /^Git: (\S+) /.exec(l)![1]!).sort()).toEqual(changed);
    const lines = linesOf(resumed.stdout);
    expect(lines.indexOf(`Setup applied: ${SID}`)).toBeLessThan(lines.indexOf(reported[0]!));
    const targets = new Map(changed.map((p) => [join(root, p), "write" as const]));
    const same = await reportBoardWrite({ tool: "setup-apply", commit: false, targets, required: new Set() });
    expect([...reported].sort()).toEqual([...same.lines].sort());
  });

  it("a resume that writes and is then cut off reports nothing, as runBoardWrite reports only a success", { timeout: 30_000 }, async () => {
    const root = await folder();
    execFileSync("git", ["init", "-q"], { cwd: root });
    setupApplySeams.fault = (point) => { if (point === "step:item:K3") throw new Error("power cut"); };
    await handleSetupApply(io(root, JSON.stringify(payload())), {});
    setupApplySeams.fault = (point) => { if (point === "step:config") throw new Error("power cut"); };
    const cut = await handleSetupApply(io(root), { resume: true, setup: SID });
    expect(cut.exitCode).toBe(3);
    expect(await idOf(root, "K3")).toMatch(/^T-/);
    expect(gitLines(cut.stdout)).toEqual([]);
  });

  it("a resolution on the existing project reports its writes; a stop reports nothing", { timeout: 30_000 }, async () => {
    const root = await folder();
    execFileSync("git", ["init", "-q"], { cwd: root });
    setupApplySeams.fault = (point) => { if (point === "step:item:K3") throw new Error("power cut"); };
    await handleSetupApply(io(root, JSON.stringify(payload())), {});
    setupApplySeams.fault = () => {};
    const k2 = await idOf(root, "K2");
    await handleTicketUpdate(k2, { title: "Log in" }, "json", root);
    const stopped = await handleSetupApply(io(root), { resume: true, setup: SID });
    expect(stopped.exitCode).toBe(4);
    expect(gitLines(stopped.stdout)).toEqual([]);
    const target = linesOf(stopped.stdout).find((l) => l.startsWith("Ambiguity:"))!.split(" · ")[1]!;
    const restored = await handleSetupApply(io(root), { setup: SID, resolve: JSON.stringify([{ target, resolution: "restore-planned", ownerWords: "use the plan's title" }]) });
    expect(restored.exitCode).toBe(0);
    expect(gitLines(restored.stdout)).toContainEqual(expect.stringMatching(/^Git: \.story\/tickets\/\S+\.json untracked$/));
  });
});
