/**
 * ISS-1384: the omitted-file loader vectors. The Mac app's loader reads the
 * same ticket directories from `test/fixtures/omitted-loader-vectors.json`
 * and must record the same omitted files, in the same order, and give every
 * accepted record the same release. The drift test proves the file is the
 * CLI's current output; the spot checks are written out by hand so a
 * generator bug cannot pin itself.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG, ROADMAP, VECTORS_OUT, buildVectors, serializeVectors } from "../../scripts/omitted-loader-vectors.js";
import { loadProject } from "../../src/core/project-loader.js";

const vectors = await buildVectors();
const vector = (name: string) => {
  const c = vectors.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no case ${name}`);
  return c.expected;
};

describe("omitted loader vectors", () => {
  it("the checked-in file is current", async () => {
    expect(readFileSync(VECTORS_OUT, "utf-8")).toBe(await serializeVectors());
  });

  it("a directory standing where a ticket file is listed is a read omission that holds every release", () => {
    const v = vector("directory entry");
    expect(v.omitted).toEqual([{ file: ".story/tickets/T-409.json", reason: "read", parentage: "unknown" }]);
    expect(v.releases.find((r) => r.id === "T-401")).toEqual({ id: "T-401", releases: false, reason: "incomplete", detail: [".story/tickets/T-409.json"] });
  });

  it("a refused record naming a parent holds that parent and nothing unrelated", () => {
    const v = vector("selective parentage");
    expect(v.releases.find((r) => r.id === "T-430")).toMatchObject({ releases: false, reason: "incomplete" });
    expect(v.releases.find((r) => r.id === "T-432")).toEqual({ id: "T-432", releases: true, reason: null, detail: [] });
  });

  it("omitted files are in UTF-16 code-unit filename order", () => {
    expect(vector("filename order").omitted.map((o) => o.file)).toEqual([
      ".story/tickets/T-a.json", ".story/tickets/T-b.json", ".story/tickets/T-\u{10000}.json", ".story/tickets/T-\u{E000}.json",
    ]);
  });

  it("a JSON fragment is a schema refusal with unknown parentage", () => {
    expect(vector("json fragment").omitted).toEqual([{ file: ".story/tickets/T-409.json", reason: "schema", parentage: "unknown" }]);
  });
});

/**
 * ISS-1384: a ticket file the process cannot open. Kept out of the
 * deterministic fixture because it depends on permissions and the running
 * user; skipped, with the reason, when the file can still be opened.
 */
describe("omitted loader unreadable-file probe", () => {
  it("a mode-000 ticket file is a read omission that holds every release", async (ctx) => {
    const root = mkdtempSync(join(tmpdir(), "omitted-probe-"));
    try {
      const tickets = join(root, ".story", "tickets");
      mkdirSync(tickets, { recursive: true });
      writeFileSync(join(root, ".story", "config.json"), CONFIG);
      writeFileSync(join(root, ".story", "roadmap.json"), ROADMAP);
      const record = (id: string, extra: Record<string, unknown>) => JSON.stringify({
        id, title: id, description: "", type: "task", status: "open", phase: "p1", order: 10,
        createdDate: "2026-01-01", completedDate: null, blockedBy: [], ...extra,
      });
      writeFileSync(join(tickets, "T-401.json"), record("T-401", { status: "complete", completedDate: "2026-02-01" }));
      writeFileSync(join(tickets, "T-402.json"), record("T-402", { blockedBy: ["T-401"] }));
      const locked = join(tickets, "T-409.json");
      writeFileSync(locked, record("T-409", {}));
      chmodSync(locked, 0o000);
      let readable = false;
      try { closeSync(openSync(locked, "r")); readable = true; } catch { /* the expected case */ }
      if (readable) ctx.skip("a mode-000 file is still readable here (running as root, or modes ignored)");

      const { state, warnings } = await loadProject(root);
      expect(state.omittedTickets).toEqual([{ file: ".story/tickets/T-409.json", reason: "read", parentage: "unknown" }]);
      expect(warnings.filter((w) => w.file === ".story/tickets/T-409.json")).toHaveLength(1);
      const blocker = state.tickets.find((x) => x.id === "T-401")!;
      expect(blocker.status).toBe("complete");
      expect(state.dependencyRelease(blocker)).toEqual({ releases: false, reason: "incomplete", detail: [".story/tickets/T-409.json"] });
    } finally {
      try { chmodSync(join(root, ".story", "tickets", "T-409.json"), 0o644); } catch { /* already gone */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
