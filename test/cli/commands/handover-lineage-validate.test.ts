/**
 * ISS-1499 slice A: `validate` lineage findings (plan section 7).
 *
 * A14, the opt-in gate (C2 for validate): a project with no valid lineage
 * line gets no new finding of any kind, whatever its handovers end with. The
 * output on such projects, md and json, CLI and MCP, equals goldens captured
 * from main before any lineage code existed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../../src/core/init.js";
import { isolateEnv, runCli, callMcp, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const GOLDENS = join(here, "../../fixtures/handover-lineage/validate-goldens.json");
const UPDATE = process.env.STORYBLOQ_UPDATE_LINEAGE_GOLDENS === "1";

let env: IsolatedEnv;
beforeEach(() => { env = isolateEnv(); });
afterEach(() => {
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

type Seed = (dir: string) => void;

const write = (dir: string, name: string, body: string): void => writeFileSync(join(dir, name), body);

/** Projects with no valid lineage line. The newest handover by listing order is always a regular file. */
const GATE_FIXTURES: Record<string, Seed> = {
  malformedV1: (d) => {
    write(d, "2026-11-13-02-newest.md", "# Newest\n\nwork\n\n<!-- storybloq-lineage v1 continues=a.md -->\n");
    write(d, "2026-11-13-01-older.md", '# Older\n\nwork\n\n<!-- storybloq-lineage v1 role="a" \n');
    write(d, "2026-11-12-01-oldest.md", '# Oldest\n\n<!-- storybloq-lineage v1 continues="a/b.md" x -->\n');
  },
  v2Line: (d) => {
    write(d, "2026-11-13-01-newest.md", '# Newest\n\nwork\n\n<!-- storybloq-lineage v2 continues="2026-11-12-01-old.md" -->\n');
    write(d, "2026-11-12-01-old.md", "# Old\n\nwork\n");
  },
  v10Line: (d) => {
    write(d, "2026-11-13-01-newest.md", '# Newest\n\nwork\n\n<!-- storybloq-lineage v10 continues="2026-11-12-01-old.md" -->\n');
    write(d, "2026-11-12-01-old.md", "# Old\n\nwork\n");
  },
  fifo: (d) => {
    write(d, "2026-11-13-01-newest.md", "# Newest\n\n## Carried forward\n- nothing\n");
    expect(spawnSync("mkfifo", [join(d, "2026-11-10-01-pipe.md")]).status).toBe(0);
  },
  everything: (d) => {
    write(d, "2026-11-13-03-newest.md", "# Newest\n\nwork\n\n<!-- storybloq-lineage v1 continues=a.md -->\n");
    write(d, "2026-11-13-02-v2.md", '# V2\n\n<!-- storybloq-lineage v2 continues="2026-11-13-03-newest.md" -->\n');
    write(d, "2026-11-13-01-v10.md", "# V10\n\n<!-- storybloq-lineage v10 -->\n");
    expect(spawnSync("mkfifo", [join(d, "2026-11-10-01-pipe.md")]).status).toBe(0);
    symlinkSync(join(d, "2026-11-13-02-v2.md"), join(d, "2026-11-09-01-link.md"));
  },
};

async function project(seed: Seed): Promise<string> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "lineage" });
  seed(join(root, ".story", "handovers"));
  return root;
}

interface Golden { output: string; exitCode: number | null; isError: boolean }
type Surface = "cli-md" | "cli-json" | "mcp-md" | "mcp-json";

async function validateVia(surface: Surface, root: string): Promise<Golden> {
  const format = surface.endsWith("json") ? "json" : "md";
  if (surface.startsWith("mcp")) {
    const r = await callMcp(root, "storybloq_validate", { format });
    return { output: r.text.split(root).join("<ROOT>"), exitCode: null, isError: r.isError };
  }
  const r = await runCli(root, ["validate", "--format", format]);
  return { output: r.stdout.split(root).join("<ROOT>"), exitCode: r.exitCode ?? 0, isError: false };
}

describe("A14 opt-in gate: a project with no valid lineage line validates exactly as on main", () => {
  const goldens: Record<string, Golden> = !UPDATE && existsSync(GOLDENS) ? JSON.parse(readFileSync(GOLDENS, "utf8")) as Record<string, Golden> : {};

  for (const [name, seed] of Object.entries(GATE_FIXTURES)) {
    for (const surface of ["cli-md", "cli-json", "mcp-md", "mcp-json"] as const) {
      const key = `${name}/${surface}`;
      it(key, async () => {
        const root = await project(seed);
        const got = await validateVia(surface, root);
        expect(got.output).not.toMatch(/lineage/i);
        if (UPDATE) {
          const all = existsSync(GOLDENS) ? JSON.parse(readFileSync(GOLDENS, "utf8")) as Record<string, Golden> : {};
          all[key] = got;
          writeFileSync(GOLDENS, JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
          return;
        }
        expect(goldens[key], `no golden for ${key}`).toBeDefined();
        expect(got).toEqual(goldens[key]);
      }, 20_000);
    }
  }
});
