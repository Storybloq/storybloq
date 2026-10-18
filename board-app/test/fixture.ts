import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const ticket = (id = "T-001", extra = {}) => ({
  id,
  title: "Ship the board",
  description: "A useful project board",
  type: "task",
  status: "open",
  phase: "p1",
  order: 10,
  createdDate: "2026-09-29",
  completedDate: null,
  blockedBy: [],
  ...extra,
});
export const issue = (id = "ISS-001", extra = {}) => ({
  id,
  title: "Refresh failure",
  status: "open",
  severity: "high",
  components: [],
  impact: "Refresh should recover",
  resolution: null,
  location: [],
  discoveredDate: "2026-09-29",
  resolvedDate: null,
  relatedTickets: [],
  ...extra,
});
export async function fixture(base = tmpdir()) {
  const root = await mkdtemp(join(base, "story-plugin-"));
  for (const d of ["tickets", "issues"])
    await mkdir(join(root, ".story", d), { recursive: true });
  const put = async (name: string, value: unknown) =>
    writeFile(join(root, ".story", name), JSON.stringify(value));
  await put("config.json", {
    version: 1,
    schemaVersion: 4,
    project: "Demo project",
    type: "app",
    language: "ts",
    features: {
      tickets: true,
      issues: true,
      handovers: true,
      roadmap: true,
      reviews: true,
    },
    privateToken: "DO_NOT_EXPOSE",
  });
  await put("roadmap.json", {
    title: "Roadmap",
    date: "2026-09-29",
    phases: [{ id: "p1", label: "01", name: "First release", description: "" }],
    blockers: [],
  });
  await put("tickets/T-001.json", ticket());
  await put("issues/ISS-001.json", issue());
  return {
    root,
    put,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
