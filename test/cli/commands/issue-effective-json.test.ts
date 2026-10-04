/**
 * T-486 U1-2: the JSON contract (R3-5, A6, C1), the markdown render, the list
 * filters and the export rows.
 *
 * Every JSON surface keeps the stored record (round trips need it) and adds
 * `effective` beside it. A stored record that already uses `effective` or
 * `stored` comes back untouched under `stored`, so nothing stored is
 * overwritten or hidden. Fixtures are written raw, so no setter is needed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { validateProject } from "../../../src/core/validation.js";
import {
  handleIssueGet,
  handleIssueList,
  handleIssueMetaSet,
  handleIssueUpdate,
} from "../../../src/cli/commands/issue.js";
import { handleExport } from "../../../src/cli/commands/export.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import type { CommandContext } from "../../../src/cli/types.js";

interface Case { name: string; issue: Record<string, unknown> }
const CORPUS = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/resolution-kind/issue-cases.json"), "utf-8"),
) as Case[];
const fixture = (name: string, id: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const c = CORPUS.find((x) => x.name === name);
  if (!c) throw new Error(`corpus case missing: ${name}`);
  return { ...c.issue, id, ...over };
};

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function boardWith(issues: Record<string, unknown>[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u1-2-"));
  roots.push(root);
  await initProject(root, { name: "t486" });
  for (const issue of issues) {
    writeFileSync(join(root, ".story", "issues", `${String(issue.id)}.json`), JSON.stringify(issue, null, 2) + "\n");
  }
  return root;
}

async function ctx(root: string, format: "json" | "md" = "json"): Promise<CommandContext> {
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format };
}

const fileOf = (root: string, id: string) => join(root, ".story", "issues", `${id}.json`);
const data = (output: string): unknown => (JSON.parse(output) as { data: unknown }).data;

type Mcp = (name: string, args: Record<string, unknown>) => Promise<unknown>;
function mcp(root: string): Mcp {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>();
  const server = {
    registerTool: (n: string, _c: unknown, h: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) => tools.set(n, h),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return async (name, args) => {
    const r = await tools.get(name)!({ ...args, format: "json" });
    return data(r.content[0]!.text);
  };
}

/** A row by its id, or by its stored record's id on the collision path. */
const rowOf = (rows: Record<string, unknown>[], id: string): Record<string, unknown> =>
  rows.find((i) => i.id === id || (i.stored as Record<string, unknown> | undefined)?.id === id)!;

/** Export rows are lean (T-486 ruling): the summary, the T-486 raw keys and `effective`, unless the record collides. */
const EXPORT_SURFACES = new Set(["exportRow", "phaseExportRow"]);
const EXPORT_LEAN_KEYS = new Set([
  "id", "title", "severity", "status",
  "disposition", "dispositionReason", "dispositionRef", "dispositionFor", "duplicateOf", "resolutionKind",
  "effective",
]);

/** The id of the board's first phase, which phase export reads. */
const firstPhase = (root: string): string =>
  (JSON.parse(readFileSync(join(root, ".story", "roadmap.json"), "utf-8")) as { phases: Array<{ id: string }> }).phases[0]!.id;

/**
 * Every JSON surface for one issue id, as returned objects. Phase export
 * lists only unresolved issues of the phase, so it joins when the issue is
 * one.
 */
async function surfaces(root: string, id: string): Promise<Record<string, Record<string, unknown>>> {
  const call = mcp(root);
  const get = data(handleIssueGet(id, await ctx(root)).output) as Record<string, unknown>;
  const list = rowOf(data(handleIssueList({}, await ctx(root)).output) as Record<string, unknown>[], id);
  const mcpGet = (await call("storybloq_issue_get", { id })) as Record<string, unknown>;
  const mcpList = rowOf((await call("storybloq_issue_list", {})) as Record<string, unknown>[], id);
  const exportRow = rowOf((data(handleExport(await ctx(root), "all", null).output) as { issues: Record<string, unknown>[] }).issues, id);
  const all: Record<string, Record<string, unknown>> = { get, list, mcpGet, mcpList, exportRow };
  const phaseRows = (data(handleExport(await ctx(root), null, firstPhase(root)).output) as { issues: Record<string, unknown>[] }).issues;
  const phaseRow = rowOf(phaseRows, id);
  if (phaseRow) all.phaseExportRow = phaseRow;
  return all;
}

describe("T-486 JSON contract: effective beside the stored record (J1-J5)", () => {
  it("an effective kind is reported on every surface", async () => {
    const root = await boardWith([fixture("effective wontfix", "ISS-001")]);
    for (const [surface, body] of Object.entries(await surfaces(root, "ISS-001"))) {
      expect(body.effective, surface).toMatchObject({ resolutionKind: "wontfix", resolutionKindState: "effective" });
    }
  });

  for (const [name, state] of [["stale date", "stale"], ["malformed short digest", "malformed"]] as const) {
    it(`${name}: the raw key stays in stored output, the effective kind is null`, async () => {
      const root = await boardWith([fixture(name, "ISS-001")]);
      const all = await surfaces(root, "ISS-001");
      for (const [surface, body] of Object.entries(all)) {
        expect(body.effective, surface).toMatchObject({ resolutionKind: null, resolutionKindState: state });
        expect(body.resolutionKind, surface).toEqual(fixture(name, "ISS-001").resolutionKind);
      }
    });
  }

  it("the update response carries effective", async () => {
    const root = await boardWith([fixture("stale digest", "ISS-001")]);
    const body = data((await handleIssueUpdate("ISS-001", { title: "retitled" }, "json", root)).output) as Record<string, unknown>;
    expect(body.title).toBe("retitled");
    expect(body.effective).toMatchObject({ resolutionKind: null, resolutionKindState: "stale" });
  });

  it("evidence is effective only while bound", async () => {
    const root = await boardWith([
      fixture("evidence effective", "ISS-001"),
      fixture("evidence unbound after a disposition change", "ISS-002"),
    ]);
    for (const [surface, body] of Object.entries(await surfaces(root, "ISS-001"))) {
      expect(body.effective, surface).toMatchObject({ dispositionEvidence: { reason: "pricing is the owner's call", ref: "ISS-002" }, dispositionEvidenceState: "effective" });
      expect(body.dispositionReason, surface).toBe("pricing is the owner's call");
    }
    for (const [surface, body] of Object.entries(await surfaces(root, "ISS-002"))) {
      expect(body.effective, surface).toMatchObject({ dispositionEvidence: null, dispositionEvidenceState: "unbound" });
      expect(body.dispositionFor, surface).toBe(fixture("evidence unbound after a disposition change", "ISS-002").dispositionFor);
    }
  });

  it("get, list and MCP return the whole stored record beside effective; export rows the lean set with every T-486 raw key", async () => {
    const issue = fixture("evidence effective", "ISS-001", {
      phase: "PHASE", duplicateOf: "ISS-009",
      resolutionKind: { kind: "wontfix", closedOn: "2026-01-01", resolutionDigest: "0000000000000000" },
    });
    const root = await boardWith([]);
    issue.phase = firstPhase(root);
    writeFileSync(fileOf(root, "ISS-001"), JSON.stringify(issue, null, 2) + "\n");
    const all = await surfaces(root, "ISS-001");
    expect(Object.keys(all)).toContain("phaseExportRow");
    for (const [surface, body] of Object.entries(all)) {
      const { effective, citedRulings, ...stored } = body;
      void citedRulings;
      const expected = EXPORT_SURFACES.has(surface)
        ? Object.fromEntries(Object.entries(issue).filter(([k]) => EXPORT_LEAN_KEYS.has(k)))
        : issue;
      expect(stored, surface).toEqual(expected);
      expect(effective, surface).toMatchObject({ resolutionKindState: "stale", dispositionEvidenceState: "effective" });
    }
    for (const key of ["disposition", "dispositionReason", "dispositionRef", "dispositionFor", "duplicateOf", "resolutionKind"]) {
      expect(all.exportRow![key], key).toEqual(issue[key]);
    }
  });

  it("a non-colliding export row carries no key outside the lean set, so a new field cannot re-inflate the export", async () => {
    const root = await boardWith([fixture("evidence effective", "ISS-001"), fixture("effective wontfix", "ISS-002", { custom: "x" })]);
    const rows = (data(handleExport(await ctx(root), "all", null).output) as { issues: Record<string, unknown>[] }).issues;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row).filter((k) => !EXPORT_LEAN_KEYS.has(k)), String(row.id)).toEqual([]);
    }
  });
});

describe("T-486 reserved response keys (A6, C1, J6)", () => {
  it("a stored effective and stored key both survive, untouched, under stored; the file is not modified by reads", async () => {
    const issue = fixture("effective wontfix", "ISS-001", { effective: "custom value", stored: { mine: true } });
    const root = await boardWith([issue]);
    const before = readFileSync(fileOf(root, "ISS-001"), "utf-8");
    for (const [surface, body] of Object.entries(await surfaces(root, "ISS-001"))) {
      expect(body.effective, surface).toMatchObject({ resolutionKind: "wontfix" });
      expect(body.stored, surface).toEqual(issue);
    }
    expect(readFileSync(fileOf(root, "ISS-001"), "utf-8")).toBe(before);
  });

  it("an open phased colliding issue comes back whole under stored in phase export too, not projected", async () => {
    const root = await boardWith([]);
    const issue = fixture("evidence effective", "ISS-001", { phase: firstPhase(root), effective: "custom", impact: "kept in full" });
    writeFileSync(fileOf(root, "ISS-001"), JSON.stringify(issue, null, 2) + "\n");
    const all = await surfaces(root, "ISS-001");
    expect(Object.keys(all)).toContain("phaseExportRow");
    for (const surface of ["exportRow", "phaseExportRow"]) {
      expect(all[surface]!.stored, surface).toEqual(issue);
      expect(all[surface]!.effective, surface).toMatchObject({ dispositionEvidenceState: "effective" });
    }
  });

  it("the update response returns the updated stored record under stored", async () => {
    const root = await boardWith([fixture("absent", "ISS-001", { effective: 1 })]);
    const body = data((await handleIssueUpdate("ISS-001", { title: "retitled" }, "json", root)).output) as Record<string, unknown>;
    expect((body.stored as Record<string, unknown>).title).toBe("retitled");
    expect((body.stored as Record<string, unknown>).effective).toBe(1);
  });

  it("the validate collision warning names the raw container", async () => {
    const root = await boardWith([fixture("absent", "ISS-001", { effective: 1 })]);
    const f = validateProject((await loadProject(root)).state).findings.find((x) => x.code === "reserved_key_collision");
    expect(f?.level).toBe("warning");
    expect(f?.message).toContain('one explicit raw container, "stored"');
  });

  for (const key of ["effective", "stored"]) {
    it(`issue meta set refuses ${key} as a protected core field`, async () => {
      const root = await boardWith([fixture("absent", "ISS-001")]);
      await expect(handleIssueMetaSet("ISS-001", key, "x", "json", root)).rejects.toThrow(`targets protected core field "${key}"`);
    });
  }
});

describe("T-486 markdown render", () => {
  it("names the kind only when it is effective", async () => {
    const root = await boardWith([fixture("effective wontfix", "ISS-001"), fixture("stale date", "ISS-002")]);
    const c = await ctx(root, "md");
    expect(handleIssueGet("ISS-001", c).output).toContain("Status: resolved (wontfix)");
    expect(handleIssueGet("ISS-002", c).output).not.toContain("(wontfix)");
    const list = handleIssueList({}, c).output;
    expect(list).toMatch(/ISS-001.*\(wontfix\)/);
    expect(list).not.toMatch(/ISS-002.*\(wontfix\)/);
  });

  it("shows the evidence only while it is bound", async () => {
    const root = await boardWith([
      fixture("evidence effective", "ISS-001"),
      fixture("evidence unbound after a disposition change", "ISS-002"),
    ]);
    const c = await ctx(root, "md");
    expect(handleIssueGet("ISS-001", c).output).toContain("Disposition: owner_gated: pricing is the owner's call [ISS-002]");
    const unbound = handleIssueGet("ISS-002", c).output;
    expect(unbound).toContain("Disposition: owner_gated");
    expect(unbound).not.toContain("pricing is the owner's call");
    expect(handleIssueList({}, c).output).toMatch(/ISS-001.*\{owner_gated\}/);
  });
});

describe("T-486 list filters (L1)", () => {
  const DISPOSITIONS = ["escalate_only", "owner_gated", "duplicate", "pre_existing", "accepted_out_of_scope", "forced_landing"];

  async function board(): Promise<string> {
    const issues = DISPOSITIONS.map((d, n) => fixture("absent", `ISS-00${n + 1}`, { status: "open", resolvedDate: null, resolution: null, disposition: d }));
    issues.push(fixture("absent", "ISS-007", { status: "open", resolvedDate: null, resolution: null }));
    issues.push(fixture("effective wontfix", "ISS-008"));
    issues.push(fixture("stale date", "ISS-009"));
    return boardWith(issues);
  }
  const ids = (output: string): string[] => (data(output) as Array<{ id: string }>).map((i) => i.id).sort();

  it("--actionable keeps only issues with no non-actionable disposition", async () => {
    const c = await ctx(await board());
    expect(ids(handleIssueList({ actionable: true }, c).output)).toEqual(["ISS-007", "ISS-008", "ISS-009"]);
    expect(ids(handleIssueList({ actionable: false }, c).output)).toEqual(["ISS-001", "ISS-002", "ISS-003", "ISS-004", "ISS-005", "ISS-006"]);
  });

  it("--disposition matches one value, and none matches the bare issues", async () => {
    const c = await ctx(await board());
    expect(ids(handleIssueList({ disposition: "owner_gated" }, c).output)).toEqual(["ISS-002"]);
    expect(ids(handleIssueList({ disposition: "none" }, c).output)).toEqual(["ISS-007", "ISS-008", "ISS-009"]);
    expect(() => handleIssueList({ disposition: "later" }, c)).toThrow(/Unknown disposition/);
  });

  it("--resolution-kind matches effective kinds only", async () => {
    const c = await ctx(await board());
    expect(ids(handleIssueList({ resolutionKind: "wontfix" }, c).output)).toEqual(["ISS-008"]);
    expect(() => handleIssueList({ resolutionKind: "withdrawn" }, c)).toThrow(/Unknown resolution kind/);
  });

  it("the MCP list tool takes the same filters", async () => {
    const call = mcp(await board());
    const got = (await call("storybloq_issue_list", { actionable: false, disposition: "duplicate" })) as Array<{ id: string }>;
    expect(got.map((i) => i.id)).toEqual(["ISS-003"]);
    const kinds = (await call("storybloq_issue_list", { resolutionKind: "wontfix" })) as Array<{ id: string }>;
    expect(kinds.map((i) => i.id)).toEqual(["ISS-008"]);
  });
});

describe("T-486 export rows (E1)", () => {
  it("carry the disposition when present and omit it when absent", async () => {
    const root = await boardWith([
      fixture("absent", "ISS-001", { status: "open", resolvedDate: null, resolution: null, disposition: "owner_gated" }),
      fixture("absent", "ISS-002", { status: "open", resolvedDate: null, resolution: null }),
    ]);
    const rows = (data(handleExport(await ctx(root), "all", null).output) as { issues: Record<string, unknown>[] }).issues;
    expect(rows.find((r) => r.id === "ISS-001")!.disposition).toBe("owner_gated");
    expect("disposition" in rows.find((r) => r.id === "ISS-002")!).toBe(false);
  });

  it("the markdown export tags a disposition, with evidence only while bound, escaped", async () => {
    const root = await boardWith([
      fixture("evidence effective", "ISS-001", { dispositionReason: "pricing *is* the owner's call", dispositionRef: "ISS_002" }),
      fixture("evidence unbound after a disposition change", "ISS-002"),
      fixture("absent", "ISS-003", { status: "open", resolvedDate: null, resolution: null }),
    ]);
    for (const id of ["ISS-001", "ISS-002", "ISS-003"]) {
      const p = fileOf(root, id);
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf-8")), phase: firstPhase(root) }, null, 2) + "\n");
    }
    const c = await ctx(root, "md");
    for (const md of [handleExport(c, "all", null).output, handleExport(c, null, firstPhase(root)).output]) {
      expect(md).toContain("{owner_gated: pricing \\*is\\* the owner's call [ISS\\_002]}");
      const unbound = md.split("\n").find((l) => l.includes("ISS-002"))!;
      expect(unbound).toMatch(/\{\w+\}$/);
      expect(unbound).not.toContain("pricing");
      expect(md.split("\n").find((l) => l.includes("ISS-003"))).not.toContain("{");
    }
  });

  it("the markdown export names an effective kind", async () => {
    const root = await boardWith([fixture("effective wontfix", "ISS-001"), fixture("stale date", "ISS-002")]);
    const md = handleExport(await ctx(root, "md"), "all", null).output;
    expect(md).toMatch(/ISS-001.*\(wontfix\)/);
    expect(md).not.toMatch(/ISS-002.*\(wontfix\)/);
  });
});
