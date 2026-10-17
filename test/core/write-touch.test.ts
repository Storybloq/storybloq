/**
 * T-481 T2w and T13d (write boundary): updatedDate through the real writers.
 * `writeTicketUnlocked`/`writeIssueUnlocked` stamp today's LOCAL date when a
 * write changes content, never on a no-op, never with `touch: false`, and
 * with the recorded date for `touch: { date }`. A recorded date that is not a
 * real calendar date throws before anything is written.
 *
 * The TZ case pins 2026-03-10T05:30:00Z in America/Los_Angeles: local
 * 2026-03-09, UTC 2026-03-10 (as local-date-stamps.test.ts). Only Date is
 * faked, so the project lock's timers still run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProjectLock, writeTicketUnlocked, writeIssueUnlocked, serializeJSON } from "../../src/core/project-loader.js";
import { todayISO } from "../../src/cli/helpers.js";

type Rec = Record<string, unknown>;
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "t481-t2w-"));
  roots.push(dir);
  const story = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) mkdirSync(join(story, sub), { recursive: true });
  writeFileSync(join(story, "config.json"), serializeJSON({
    version: 2, project: "t481", type: "npm", language: "ts",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), serializeJSON({
    title: "t481", date: "2026-01-01", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "First." }], blockers: [],
  }));
  return dir;
}

// Legacy shapes: no displayId on disk, as the oldest ledger files are.
const ticketRec = (extra: Rec = {}): Rec => ({
  id: "T-001", title: "Title", description: "", type: "task", status: "open", phase: "p1", order: 10,
  createdDate: "2020-01-01", completedDate: null, blockedBy: [], parentTicket: null, updatedDate: "2020-01-01", ...extra,
});
const issueRec = (extra: Rec = {}): Rec => ({
  id: "ISS-001", title: "Bug", status: "open", severity: "low", components: [], impact: "x", resolution: null,
  location: [], discoveredDate: "2020-01-01", resolvedDate: null, relatedTickets: [], updatedDate: "2020-01-01", ...extra,
});

const kinds = [
  { name: "ticket", dir: "tickets", rec: ticketRec, id: "T-001", pick: (s: { tickets: Rec[] }) => s.tickets, write: writeTicketUnlocked },
  { name: "issue", dir: "issues", rec: issueRec, id: "ISS-001", pick: (s: { issues: Rec[] }) => s.issues, write: writeIssueUnlocked },
] as const;

for (const k of kinds) {
  describe(`T-481 T2w: ${k.name} writes and updatedDate`, () => {
    const path = (root: string) => join(root, ".story", k.dir, `${k.id}.json`);
    const read = (root: string) => JSON.parse(readFileSync(path(root), "utf-8")) as Rec;
    /** Load the project under the lock and write `edit(loaded)` with `options`. */
    async function write(root: string, edit: (x: Rec) => Rec, options?: Rec): Promise<void> {
      await withProjectLock(root, { strict: true }, async (state) => {
        const loaded = (k.pick(state.state as never) as Rec[]).find((x) => x.id === k.id)!;
        await (k.write as (x: never, r: string, o?: Rec) => Promise<void>)(edit(loaded) as never, root, options);
      });
    }

    it("a legacy file loaded and written unchanged keeps 2020-01-01", async () => {
      const root = project();
      writeFileSync(path(root), serializeJSON(k.rec()));
      await write(root, (x) => x);
      expect(read(root).updatedDate).toBe("2020-01-01");
    });

    it("a title edit writes today's local date", async () => {
      const root = project();
      writeFileSync(path(root), serializeJSON(k.rec()));
      await write(root, (x) => ({ ...x, title: "Edited" }));
      const after = read(root);
      expect(after.title).toBe("Edited");
      expect(after.updatedDate).toBe(todayISO());
    });

    it("under a TZ where local and UTC dates differ, the stamp is the local date", async () => {
      vi.stubEnv("TZ", "America/Los_Angeles");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-03-10T05:30:00.000Z"));
      const root = project();
      writeFileSync(path(root), serializeJSON(k.rec()));
      await write(root, (x) => ({ ...x, title: "Evening edit" }));
      expect(read(root).updatedDate).toBe("2026-03-09");
    });

    it("touch: false keeps 2020-01-01 while the edited field lands", async () => {
      const root = project();
      writeFileSync(path(root), serializeJSON(k.rec()));
      await write(root, (x) => ({ ...x, title: "Edited" }), { touch: false });
      const after = read(root);
      expect(after.title).toBe("Edited");
      expect(after.updatedDate).toBe("2020-01-01");
    });

    it("touch: { date } writes that date on a change, and nothing on a no-op", async () => {
      const root = project();
      writeFileSync(path(root), serializeJSON(k.rec()));
      await write(root, (x) => x, { touch: { date: "2025-05-05" } });
      expect(read(root).updatedDate).toBe("2020-01-01");
      await write(root, (x) => ({ ...x, title: "Recorded" }), { touch: { date: "2025-05-05" } });
      expect(read(root).updatedDate).toBe("2025-05-05");
    });

    it("T13d: touch: { date } with an impossible or malformed date throws and writes nothing", async () => {
      const root = project();
      writeFileSync(path(root), serializeJSON(k.rec()));
      const before = readFileSync(path(root), "utf-8");
      for (const date of ["2026-02-30", "20261017", 20261017]) {
        await expect(write(root, (x) => ({ ...x, title: "Never" }), { touch: { date } })).rejects.toThrow();
        expect(readFileSync(path(root), "utf-8")).toBe(before);
      }
    });
  });
}
