/**
 * T-538 S3a-2 shared fixtures: a tests-only setup whose one component's test
 * stage is pending behind a scaffold ticket (K2), established by K3, with K4
 * waiting on K3. Each test file pins TZ and a scratch HOME the same way.
 */
import { beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupApplySeams } from "../../src/core/setup-apply.js";

export const SID = "SS-0123abcd";

export function pinEnvironment(prefix: string): { home: () => string; folder: () => Promise<string> } {
  const saved: Record<string, string | undefined> = {};
  let home = "";
  const dirs: string[] = [];
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), `${prefix}-home-`));
    for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "TZ", "PYTEST_ADDOPTS", "GOFLAGS"]) saved[k] = process.env[k];
    process.env.TZ = "UTC";
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    delete process.env.PYTEST_ADDOPTS;
    delete process.env.GOFLAGS;
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(home, { recursive: true, force: true });
  });
  afterEach(async () => {
    setupApplySeams.fault = () => {};
    vi.useRealTimers();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  return {
    home: () => home,
    folder: async () => {
      const d = await mkdtemp(join(tmpdir(), `${prefix}-`));
      dirs.push(d);
      return d;
    },
  };
}

export type PT = { key: string; title: string; type: string; phase: string; description: string; blockedBy: string[]; status?: string; establishes?: unknown };

export const t = (key: string, blockedBy: string[], extra: Partial<PT> = {}): PT => ({ key, title: `${key} title`, type: "task", phase: "K1", description: "", blockedBy, ...extra });
export const est = (key: string, scaffold: string, component = "app"): PT => t(key, [scaffold], { establishes: { component, stage: "test", scaffold } });

export interface CompOpts { readonly id?: string; readonly workdir?: string; readonly command?: string; readonly runner?: string; readonly wrapper?: string }

export const comp = (o: CompOpts = {}) => ({
  id: o.id ?? "app",
  workdir: o.workdir ?? ".",
  test: { command: o.command ?? "npm test", status: "pending", reason: "no tests yet", runner: o.runner ?? "vitest", wrapper: o.wrapper ?? "npm" },
  build: null,
  verify: null,
});

export function payload(over: { tickets?: PT[]; components?: unknown[]; level?: string; checkpoints?: unknown[] } = {}): Record<string, unknown> {
  return {
    version: 1,
    setupId: SID,
    review: { reviewer: "codex", outcome: "approved", lines: ["Plan review: approved"] },
    ownerLabel: "Sam",
    project: { name: "demo", type: "npm", language: "typescript" },
    quality: { level: over.level ?? "tests-only", verifyApplies: false, components: over.components ?? [comp()] },
    governance: { canonicalFactsPath: "CLAUDE.md", files: [] },
    git: { init: false, gitignore: [] },
    phases: [{ key: "K1", id: "build", name: "Build", label: "BUILD", description: "" }],
    tickets: over.tickets ?? [t("K2", []), est("K3", "K2"), t("K4", ["K3"])],
    checkpoints: over.checkpoints ?? [],
    issues: [],
    coverage: [{ requirement: "R1", text: "x", source: "brief", keys: ["K2"] }],
  };
}

export async function ticketFile(root: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, ".story", "tickets", `${id}.json`), "utf-8")) as Record<string, unknown>;
}

export async function ticketBytes(root: string, id: string): Promise<string> {
  return readFile(join(root, ".story", "tickets", `${id}.json`), "utf-8");
}

export async function editTicket(root: string, id: string, edit: (raw: Record<string, unknown>) => void): Promise<void> {
  const path = join(root, ".story", "tickets", `${id}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  edit(raw);
  await writeFile(path, JSON.stringify(raw, null, 2) + "\n");
}

export function faultOnce(point: string): void {
  let fired = false;
  setupApplySeams.fault = (p) => {
    if (p === point && !fired) {
      fired = true;
      throw new Error(`injected fault at ${p}`);
    }
  };
}

interface RegisteredTool { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }

/** A recording stand-in for the MCP server: registerAllTools fills it, and a test calls a tool's handler directly. */
export function makeRegistry(): { tools: Map<string, RegisteredTool>; server: never } {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: RegisteredTool["handler"]) => {
      tools.set(name, { handler });
      return { remove: () => tools.delete(name) };
    },
    sendToolListChanged: () => {},
  } as unknown as never;
  return { tools, server };
}
