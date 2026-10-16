/**
 * T-486 U3 T17: what `storybloq triage --apply` reports when its one
 * transaction fails after the commit began.
 *
 * The failure is injected at `rename` for one issue file only, the same way
 * test/core/ruling-transaction-recovery.test.ts does it, so the first issue is
 * already in place when the second fails. The run must say recovery is
 * pending, not that nothing was written; the next lock holder completes it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const inject = vi.hoisted(() => ({ only: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: async (from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
      const dest = String(to).replace(/\\/g, "/");
      if (inject.only !== null && dest.endsWith(inject.only)) {
        throw Object.assign(new Error("EIO: injected commit-phase failure"), { code: "EIO" });
      }
      return actual.rename(from, to);
    },
  };
});

const { initProject } = await import("../../../src/core/init.js");
const { handleTriage } = await import("../../../src/cli/commands/triage.js");
const { loadProject } = await import("../../../src/core/project-loader.js");

const roots: string[] = [];
afterEach(() => {
  inject.only = null;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function issue(dir: string, id: string): void {
  writeFileSync(join(dir, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [], impact: "",
    resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
  }, null, 2) + "\n");
}

describe("T-486 U3 triage: a failure after the commit began", () => {
  it("T17: reports recovery-pending; the next lock holder completes it; a re-run finds nothing to do", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t486-u3-recovery-"));
    roots.push(dir);
    await initProject(dir, { name: "t486" });
    issue(dir, "ISS-001");
    issue(dir, "ISS-002");

    inject.only = "/.story/issues/ISS-002.json";
    const r = await handleTriage({ ids: ["ISS-001", "ISS-002"], resolve: true, reason: "x", apply: true }, "json", dir, { today: "2026-10-15" });
    inject.only = null;
    expect(r.exitCode).toBe(1);
    const data = (JSON.parse(r.output) as { data: { applied: string; writable: Array<{ id: string }> } }).data;
    expect(data.applied).toBe("recovery-pending");
    expect(data.writable.map((e) => e.id)).toEqual(["ISS-001", "ISS-002"]);
    expect(r.warnings?.[0]).toContain("do not re-run");

    const { state } = await loadProject(dir);
    expect(state.issueByID("ISS-001")?.status).toBe("resolved");
    expect(state.issueByID("ISS-002")?.status).toBe("resolved");

    const again = await handleTriage({ ids: ["ISS-001", "ISS-002"], status: ["open", "resolved"], resolve: true, reason: "x", apply: true }, "json", dir, { today: "2026-10-15" });
    const second = (JSON.parse(again.output) as { data: { applied: string; notApplicable: Array<{ id: string; reason: string }> } }).data;
    expect(second.applied).toBe("none");
    expect(second.notApplicable.map((e) => [e.id, e.reason])).toEqual([["ISS-001", "already resolved"], ["ISS-002", "already resolved"]]);
  });
});
