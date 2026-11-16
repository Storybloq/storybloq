/**
 * ISS-1499 slice A: `validate` lineage findings (plan section 7).
 *
 * A14, the opt-in gate (C2 for validate): a project with no valid lineage
 * line gets no new finding of any kind, whatever its handovers end with. The
 * output on such projects, md and json, CLI and MCP, equals goldens captured
 * from main before any lineage code existed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// A14: the lineage findings of plan section 7, each on its own fixture.
// ---------------------------------------------------------------------------

interface Finding { level: string; code: string; message: string; entity: string | null }

const linked = (attrs: string): string => `# Handover\n\nwork\n\n<!-- storybloq-lineage v1${attrs ? " " + attrs : ""} -->\n`;
const plainBody = "# Handover\n\nwork\n";

/** The lineage findings of `validate --format json` through the CLI, plus the result header. */
async function lineageFindings(root: string): Promise<{ findings: Finding[]; valid: boolean; exitCode: number }> {
  const r = await runCli(root, ["validate", "--format", "json"]);
  const data = (JSON.parse(r.stdout) as { data: { valid: boolean; findings: Finding[] } }).data;
  return {
    findings: data.findings.filter((f) => f.code.startsWith("handover_lineage_")),
    valid: data.valid,
    exitCode: r.exitCode ?? 0,
  };
}

describe("A14 lineage findings (gate open: at least one linked handover)", () => {
  it("handover_lineage_malformed: a linked file with a dropped attribute, and an unlinked file whose final line is a failed v1 line", async () => {
    const root = await project((d) => {
      write(d, "2026-11-13-02-bad.md", linked('role="ok" colour="red" role="second"'));
      write(d, "2026-11-13-01-near.md", "# Near\n\nwork\n\n<!-- storybloq-lineage v1 continues=a.md -->\n");
    });
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([
      { level: "warning", code: "handover_lineage_malformed", entity: "2026-11-13-02-bad.md", message: "2026-11-13-02-bad.md: the lineage line had attributes that were ignored: colour (unknown), role (duplicate)." },
      { level: "warning", code: "handover_lineage_malformed", entity: "2026-11-13-01-near.md", message: "2026-11-13-01-near.md: the final line starts like a storybloq-lineage v1 line but does not match its grammar, so the handover is read as unlinked." },
    ]);
    expect(r.valid).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("handover_lineage_parent_missing: each broken reason names the reason and the target", async () => {
    const root = await project((d) => {
      write(d, "2026-11-13-04-missing.md", linked('continues="2026-01-01-01-gone.md"'));
      write(d, "2026-11-13-03-invalid.md", linked('continues="a/b.md"'));
      write(d, "2026-11-13-02-self.md", linked('continues="2026-11-13-02-self.md"'));
      write(d, "2026-11-13-01-unread.md", linked('continues="2026-11-01-01-dir.md"'));
      mkdirSync(join(d, "2026-11-01-01-dir.md"));
    });
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([
      { level: "warning", code: "handover_lineage_parent_missing", entity: "2026-11-13-04-missing.md", message: "2026-11-13-04-missing.md continues 2026-01-01-01-gone.md, which is not in the handovers folder (missing)." },
      { level: "warning", code: "handover_lineage_malformed", entity: "2026-11-13-03-invalid.md", message: "2026-11-13-03-invalid.md: the lineage line had attributes that were ignored: continues (invalid)." },
      { level: "warning", code: "handover_lineage_parent_missing", entity: "2026-11-13-03-invalid.md", message: "2026-11-13-03-invalid.md has a continues value that is not a valid handover filename (invalid)." },
      { level: "warning", code: "handover_lineage_parent_missing", entity: "2026-11-13-02-self.md", message: "2026-11-13-02-self.md continues itself (self)." },
      { level: "warning", code: "handover_lineage_parent_missing", entity: "2026-11-13-01-unread.md", message: "2026-11-13-01-unread.md continues 2026-11-01-01-dir.md, which could not be read (unreadable)." },
    ]);
    expect(r.valid).toBe(true);
  });

  it("handover_lineage_loop: once per loop, on its first member, naming all members; a tip leading into it does not repeat it", async () => {
    const root = await project((d) => {
      write(d, "2026-11-11-01-t.md", linked('continues="2026-11-10-01-x.md"'));
      write(d, "2026-11-10-02-y.md", linked('continues="2026-11-10-01-x.md"'));
      write(d, "2026-11-10-01-x.md", linked('continues="2026-11-10-02-y.md"'));
    });
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([
      { level: "warning", code: "handover_lineage_loop", entity: "2026-11-10-02-y.md", message: "Lineage loop: 2026-11-10-02-y.md, 2026-11-10-01-x.md." },
      { level: "info", code: "handover_lineage_fork", entity: "2026-11-10-01-x.md", message: "2026-11-10-01-x.md is continued by more than one handover: 2026-11-11-01-t.md, 2026-11-10-02-y.md." },
    ]);
  });

  it("handover_lineage_loop: a two-file loop no tip reaches", async () => {
    const root = await project((d) => {
      write(d, "2026-11-12-01-u.md", plainBody);
      write(d, "2026-11-10-02-y.md", linked('continues="2026-11-10-01-x.md"'));
      write(d, "2026-11-10-01-x.md", linked('continues="2026-11-10-02-y.md"'));
    });
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([
      { level: "warning", code: "handover_lineage_loop", entity: "2026-11-10-02-y.md", message: "Lineage loop: 2026-11-10-02-y.md, 2026-11-10-01-x.md." },
    ]);
  });

  it("handover_lineage_fork: a parent with two children on certain edges, including a non-head unlinked parent", async () => {
    const root = await project((d) => {
      write(d, "2026-11-12-01-a.md", linked('continues="2026-11-10-01-old.md"'));
      write(d, "2026-11-11-01-head.md", plainBody);
      write(d, "2026-11-10-01-old.md", plainBody);
    });
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([
      { level: "info", code: "handover_lineage_fork", entity: "2026-11-10-01-old.md", message: "2026-11-10-01-old.md is continued by more than one handover: 2026-11-12-01-a.md, 2026-11-11-01-head.md." },
    ]);
  });

  it("A13b: U1, X (a symlink), U2 and a handover continuing U2: no fork finding", async () => {
    const root = await project((d) => {
      write(d, "2026-11-14-01-n.md", linked('continues="2026-11-13-01-u2.md"'));
      write(d, "2026-11-13-03-u1.md", plainBody);
      write(d, "2026-11-13-01-u2.md", plainBody);
      symlinkSync(join(d, "2026-11-13-01-u2.md"), join(d, "2026-11-13-02-x.md"));
    });
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([]);
  });

  it("handover_lineage_reference_missing: from and absorbs targets not in the listing", async () => {
    const root = await project((d) => {
      write(d, "2026-11-13-01-a.md", linked('from="2026-01-01-01-gone.md" absorbs="2026-01-01-02-gone.md"'));
    });
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([
      { level: "info", code: "handover_lineage_reference_missing", entity: "2026-11-13-01-a.md", message: "2026-11-13-01-a.md: from 2026-01-01-01-gone.md is not in the handovers folder." },
      { level: "info", code: "handover_lineage_reference_missing", entity: "2026-11-13-01-a.md", message: "2026-11-13-01-a.md: absorbs 2026-01-01-02-gone.md is not in the handovers folder." },
    ]);
  });

  const inertSeed = (extra: Seed): Seed => (d) => {
    write(d, "2026-11-13-02-b.md", linked('continues="2026-11-13-01-a.md" absorbs="2026-11-10-01-u.md" absorbs="2026-11-13-02-b.md"'));
    write(d, "2026-11-13-01-a.md", linked('continues="2026-11-10-01-u.md"'));
    write(d, "2026-11-10-01-u.md", plainBody);
    extra(d);
  };

  it("handover_lineage_absorb_inert: an absorbs target in the listing that is not a tip, and one naming the absorber itself", async () => {
    const root = await project(inertSeed(() => {}));
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([
      { level: "info", code: "handover_lineage_absorb_inert", entity: "2026-11-13-02-b.md", message: "2026-11-13-02-b.md: absorbs 2026-11-10-01-u.md has no effect, because 2026-11-10-01-u.md is not the end of a line." },
      { level: "info", code: "handover_lineage_absorb_inert", entity: "2026-11-13-02-b.md", message: "2026-11-13-02-b.md: absorbs itself, which has no effect." },
    ]);
  });

  it("handover_lineage_absorb_inert is suppressed when the scan is incomplete; the other findings are not", async () => {
    const root = await project(inertSeed((d) => {
      symlinkSync(join(d, "2026-11-10-01-u.md"), join(d, "2026-11-09-01-link.md"));
      write(d, "2026-11-08-01-c.md", linked('continues="2026-01-01-01-gone.md"'));
    }));
    const r = await lineageFindings(root);
    expect(r.findings).toEqual([
      { level: "warning", code: "handover_lineage_parent_missing", entity: "2026-11-08-01-c.md", message: "2026-11-08-01-c.md continues 2026-01-01-01-gone.md, which is not in the handovers folder (missing)." },
    ]);
  });

  it("the same findings reach the MCP tool (md and json)", async () => {
    const root = await project((d) => {
      write(d, "2026-11-13-01-a.md", linked('continues="2026-01-01-01-gone.md"'));
    });
    const json = await callMcp(root, "storybloq_validate", { format: "json" });
    const findings = (JSON.parse(json.text) as { data: { findings: Finding[] } }).data.findings.filter((f) => f.code.startsWith("handover_lineage_"));
    expect(findings).toEqual([
      { level: "warning", code: "handover_lineage_parent_missing", entity: "2026-11-13-01-a.md", message: "2026-11-13-01-a.md continues 2026-01-01-01-gone.md, which is not in the handovers folder (missing)." },
    ]);
    const md = await callMcp(root, "storybloq_validate", { format: "md" });
    expect(md.text).toContain("handover_lineage_parent_missing");
    expect(md.text).toContain("2026-11-13-01-a.md continues 2026-01-01-01-gone.md, which is not in the handovers folder (missing).");
  });
});
