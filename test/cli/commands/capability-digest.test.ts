/**
 * ISS-1283: `capability list --digest`, the bounded form /story Step 2 loads.
 *
 * The digest is a consequence of the check, never a cheaper path around it, so
 * the fixtures that matter run real git with no skipCheck: an entry that moved
 * under its checkpoint must surface even when twenty clean entries come first
 * in the file.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { handleCapabilityList } from "../../../src/cli/commands/capability.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { registerCapabilityCommand } from "../../../src/cli/register.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { initProject } from "../../../src/core/init.js";
import { PROJECT_ROOT_ENV_VAR, LEGACY_PROJECT_ROOT_ENV_VAR } from "../../../src/core/project-root-shared.js";
import { makeState } from "../../core/test-factories.js";
import { writeD0Fixture } from "../../helpers/capability-digest-fixture.js";
import type { CommandContext } from "../../../src/cli/run.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "capability-digest");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

async function project(withGit: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "cap-digest-"));
  roots.push(root);
  await initProject(root, { name: "Cap", type: "npm" });
  mkdirSync(join(root, "src", "core"), { recursive: true });
  writeFileSync(join(root, "src", "core", "stable.ts"), "export const s = 1;\n");
  writeFileSync(join(root, "src", "core", "moving.ts"), "export const m = 1;\n");
  if (withGit) {
    git(root, "init", "-q");
    git(root, "config", "user.email", "t@example.invalid");
    git(root, "config", "user.name", "T");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
  }
  return root;
}

function ctxFor(root: string, format: "md" | "json" = "md"): CommandContext {
  return { state: makeState(), warnings: [], root, handoversDir: join(root, ".story", "handovers"), format };
}

type Entry = Record<string, unknown>;

function entry(id: string, name: string, path: string, sha: string, extra: Entry = {}): Entry {
  return { id, name, summary: `${name} summary.`, entryPoints: [path], contract: `${name} holds.`, checkedAt: { sha, date: "2026-10-18" }, status: "current", ...extra };
}

function writeCatalog(root: string, capabilities: Entry[]): void {
  writeFileSync(join(root, ".story", "capabilities.json"), JSON.stringify({ version: 1, capabilities }, null, 2) + "\n");
}

const pad = (i: number): string => String(i).padStart(2, "0");

/**
 * 20 clean entries first in document order, then 21 stored `current` whose
 * entry point changed in a later commit. Slicing the document before the check
 * would return the 20 clean ones and nothing in review.
 */
async function movedBehindClean(): Promise<string> {
  const root = await project(true);
  const base = git(root, "rev-parse", "HEAD");
  writeCatalog(root, [
    ...Array.from({ length: 20 }, (_, i) => entry(`cap-s${pad(i)}`, `S${pad(i)}`, "src/core/stable.ts", base)),
    ...Array.from({ length: 21 }, (_, i) => entry(`cap-m${pad(i)}`, `M${pad(i)}`, "src/core/moving.ts", base)),
  ]);
  writeFileSync(join(root, "src", "core", "moving.ts"), "export const m = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "move");
  return root;
}

async function json(filters: Parameters<typeof handleCapabilityList>[0], root: string): Promise<Record<string, unknown>> {
  return JSON.parse((await handleCapabilityList(filters, ctxFor(root, "json"))).output).data as Record<string, unknown>;
}

describe("capability list --digest: the cap and the order run on the checked report (ISS-1283)", () => {
  it("D1: lists the first 20 entries the check put in review, never the first 20 in the file", async () => {
    const root = await movedBehindClean();
    const d = await json({ digest: true }, root);
    expect(d).toMatchObject({ present: true, total: 41, review: 21, pending: 0, returned: 20, omitted: 1, freshness: "complete", unchecked: 0, freshnessChecked: true });
    expect((d.entries as Entry[]).map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => `cap-m${pad(i)}`));
    for (const e of d.entries as Entry[]) expect(Object.keys(e).sort()).toEqual(["id", "name"]);
    expect(Object.keys(d).sort()).toEqual(["entries", "freshness", "freshnessChecked", "omitted", "pending", "present", "returned", "review", "total", "unchecked"]);
  });

  it("D3: freshness feeds the digest, and skipCheck says it did not run", async () => {
    const root = await project(true);
    const base = git(root, "rev-parse", "HEAD");
    writeCatalog(root, [entry("cap-m", "Moved", "src/core/moving.ts", base)]);
    writeFileSync(join(root, "src", "core", "moving.ts"), "export const m = 2;\n");
    git(root, "commit", "-qam", "move");
    expect(await json({ digest: true }, root)).toMatchObject({ review: 1, returned: 1, freshness: "complete", freshnessChecked: true });
    const skipped = await json({ digest: true, skipCheck: true }, root);
    expect(skipped).toMatchObject({ total: 1, review: 0, returned: 0, freshness: "skipped", unchecked: 1, freshnessChecked: false });
  });

  it("D4: a pending entry leads the review set and is listed exactly once", async () => {
    const root = await project(false);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    writeCatalog(root, [
      ...Array.from({ length: 20 }, (_, i) => entry(`cap-r${pad(i)}`, `R${pad(i)}`, "src/core/stable.ts", sha, { status: "review" })),
      entry("cap-p", "Pending", "src/core/stable.ts", sha, { pendingNote: "owe a test" }),
    ]);
    const d = await json({ digest: true, skipCheck: true }, root);
    expect(d).toMatchObject({ total: 21, review: 21, pending: 1, returned: 20, omitted: 1 });
    const ids = (d.entries as Entry[]).map((e) => e.id);
    expect(ids[0]).toBe("cap-p");
    expect(ids.filter((id) => id === "cap-p")).toHaveLength(1);
    expect(ids.slice(1)).toEqual(Array.from({ length: 19 }, (_, i) => `cap-r${pad(i)}`));
  });
});

describe("capability list: the unbounded form is unchanged (ISS-1283)", () => {
  it("D2: the default and full outputs equal the capture taken from the base source, byte for byte", async () => {
    const root = await project(false);
    writeD0Fixture(root);
    const expectedJson = readFileSync(join(FIXTURE_DIR, "list.json"), "utf-8");
    const expectedMd = readFileSync(join(FIXTURE_DIR, "list.md"), "utf-8");
    expect(expectedJson.length).toBeGreaterThan(0);
    expect(expectedMd.length).toBeGreaterThan(0);
    for (const filters of [{ skipCheck: true }, { skipCheck: true, full: true }]) {
      expect((await handleCapabilityList(filters, ctxFor(root, "json"))).output).toBe(expectedJson);
      expect((await handleCapabilityList(filters, ctxFor(root, "md"))).output).toBe(expectedMd);
    }
  });
});

describe("capability list --digest: the freshness state is stated, never implied (ISS-1283)", () => {
  it("D5: skipCheck never prints a bare 'none'", async () => {
    const root = await project(false);
    writeCatalog(root, [entry("cap-a", "A", "src/core/stable.ts", "0123456789abcdef0123456789abcdef01234567")]);
    const md = (await handleCapabilityList({ digest: true, skipCheck: true }, ctxFor(root))).output;
    expect(md).toBe("Capabilities in review by stored flag and structure (freshness not checked): none");
  });

  it("D5: HEAD unavailable reads incomplete, with every entry unchecked", async () => {
    const root = await project(false);
    writeCatalog(root, [entry("cap-a", "A", "src/core/stable.ts", "0123456789abcdef0123456789abcdef01234567")]);
    const d = await json({ digest: true }, root);
    expect(d).toMatchObject({ freshness: "incomplete", unchecked: 1, freshnessChecked: false, review: 1 });
    const md = (await handleCapabilityList({ digest: true }, ctxFor(root))).output;
    expect(md).toBe("Capabilities in review: 1: A (freshness incomplete: 1 unchecked, `storybloq capability check`)");
  });

  it("an absent catalog is complete and says present: false", async () => {
    const root = await project(true);
    expect(await json({ digest: true }, root)).toEqual({
      present: false, freshnessChecked: true, entries: [], total: 0, review: 0, pending: 0, returned: 0, omitted: 0, freshness: "complete", unchecked: 0,
    });
    expect((await handleCapabilityList({ digest: true }, ctxFor(root))).output).toBe("Capabilities in review: none");
    expect(await json({ digest: true, skipCheck: true }, root)).toMatchObject({ present: false, freshness: "skipped", unchecked: 0 });
  });

  it("a present but empty catalog is complete and says present: true", async () => {
    const root = await project(true);
    writeCatalog(root, []);
    expect(await json({ digest: true }, root)).toMatchObject({ present: true, freshness: "complete", unchecked: 0, freshnessChecked: true, total: 0 });
    expect(await json({ digest: true, skipCheck: true }, root)).toMatchObject({ present: true, freshness: "skipped" });
  });
});

describe("capability list --digest: the md line (ISS-1283)", () => {
  it("D6: complete, with the omitted count and where to find the rest", async () => {
    const root = await movedBehindClean();
    const md = (await handleCapabilityList({ digest: true }, ctxFor(root))).output;
    const names = Array.from({ length: 20 }, (_, i) => `M${pad(i)}`).join(", ");
    expect(md).toBe(`Capabilities in review: 21: ${names} (1 more, \`storybloq capability list --status review\`)`);
  });

  it("D6: complete and nothing in review", async () => {
    const root = await project(true);
    writeCatalog(root, [entry("cap-a", "A", "src/core/stable.ts", git(root, "rev-parse", "HEAD"))]);
    expect((await handleCapabilityList({ digest: true }, ctxFor(root))).output).toBe("Capabilities in review: none");
  });

  it("D6: skipped, with pending listed first and the omitted count", async () => {
    const root = await project(false);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    writeCatalog(root, [
      ...Array.from({ length: 20 }, (_, i) => entry(`cap-r${pad(i)}`, `R${pad(i)}`, "src/core/stable.ts", sha, { status: "review" })),
      entry("cap-p", "Pending", "src/core/stable.ts", sha, { pendingNote: "owe a test" }),
    ]);
    const md = (await handleCapabilityList({ digest: true, skipCheck: true }, ctxFor(root))).output;
    const names = ["Pending", ...Array.from({ length: 19 }, (_, i) => `R${pad(i)}`)].join(", ");
    expect(md).toBe(
      `Capabilities in review by stored flag and structure (freshness not checked): 21: ${names} (1 more, \`storybloq capability list --status review\`) (pending: 1, listed first)`,
    );
  });
});

describe("capability list --digest: refusals in the handler (ISS-1283)", () => {
  it("D5: digest with full, and digest with status, are invalid_input", async () => {
    const root = await project(false);
    for (const filters of [{ digest: true, full: true }, { digest: true, status: "review" }]) {
      const err = await handleCapabilityList(filters, ctxFor(root)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliValidationError);
      expect((err as CliValidationError).code).toBe("invalid_input");
    }
  });
});

/** An oversized inventory that needs no git: 20 current, then 21 stored review. */
async function oversized(): Promise<string> {
  const root = await project(false);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  writeCatalog(root, [
    ...Array.from({ length: 20 }, (_, i) => entry(`cap-s${pad(i)}`, `S${pad(i)}`, "src/core/stable.ts", sha)),
    ...Array.from({ length: 21 }, (_, i) => entry(`cap-r${pad(i)}`, `R${pad(i)}`, "src/core/stable.ts", sha, { status: "review" })),
  ]);
  return root;
}

const BOUNDED_TAIL = "(1 more, `storybloq capability list --status review`)";

describe("D7: digest and full reach the handler through both surfaces (ISS-1283)", () => {
  interface Tool {
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  }
  function listTool(root: string): Tool {
    const tools = new Map<string, Tool>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: Tool["handler"]) => {
        tools.set(name, { handler });
      },
    } as unknown as Parameters<typeof registerAllTools>[0];
    registerAllTools(server, root);
    const tool = tools.get("storybloq_capability_list");
    if (!tool) throw new Error("storybloq_capability_list was not registered");
    return tool;
  }

  async function cli(root: string, args: string[]): Promise<string> {
    vi.stubEnv(PROJECT_ROOT_ENV_VAR, root);
    vi.stubEnv(LEGACY_PROJECT_ROOT_ENV_VAR, "");
    let stdout = "";
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    try {
      await registerCapabilityCommand(yargs(["capability", "list", ...args]).scriptName("storybloq"))
        .exitProcess(false)
        .fail(false)
        .parseAsync()
        .catch(() => undefined);
    } finally {
      out.mockRestore();
      err.mockRestore();
      vi.unstubAllEnvs();
      process.exitCode = undefined;
    }
    return stdout;
  }

  it("MCP: digest is bounded, default equals full, and each conflicting pair is invalid_input", async () => {
    const root = await oversized();
    const tool = listTool(root);
    const digest = (await tool.handler({ digest: true, skipCheck: true })).content[0]!.text;
    expect(digest).toContain(BOUNDED_TAIL);
    expect(digest).not.toContain("R20");
    const plain = (await tool.handler({ skipCheck: true })).content[0]!.text;
    expect(plain).toContain("R20");
    expect((await tool.handler({ skipCheck: true, full: true })).content[0]!.text).toBe(plain);
    for (const args of [{ digest: true, full: true }, { digest: true, status: "review" }]) {
      const res = await tool.handler(args);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain("invalid_input");
    }
  });

  it("CLI: digest is bounded, default equals full, and each conflicting pair is invalid_input", async () => {
    const root = await oversized();
    const digest = JSON.parse(await cli(root, ["--digest", "--skip-check", "--format", "json"])).data;
    expect(digest).toMatchObject({ total: 41, review: 21, returned: 20, omitted: 1 });
    expect(await cli(root, ["--digest", "--skip-check"])).toContain(BOUNDED_TAIL);
    const plain = await cli(root, ["--skip-check"]);
    expect(plain).toContain("R20");
    expect(await cli(root, ["--skip-check", "--full"])).toBe(plain);
    for (const args of [["--digest", "--full"], ["--digest", "--status", "review"]]) {
      expect(await cli(root, [...args, "--format", "json"])).toContain("invalid_input");
    }
  });
});
