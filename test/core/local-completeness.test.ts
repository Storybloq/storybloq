/**
 * T-486 U2-4 (B1, local, fail closed): a ticket file the loader could not
 * accept holds the release of every ticket it could sit under, the blocked
 * output names it, and validate names it with what is wrong and the fix.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { handleValidateWithSourceRefs } from "../../src/cli/commands/validate.js";
import { handleTicketBlocked } from "../../src/cli/commands/ticket.js";
import type { CommandContext } from "../../src/cli/types.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u24-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchHome, { recursive: true, force: true });
});
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Raw = Record<string, unknown>;
const DONE = "2026-02-01";
function ticket(id: string, extra: Raw = {}): Raw {
  return {
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p0",
    order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
    ...extra,
  };
}
const delivered = (id: string, extra: Raw = {}) => ticket(id, { status: "complete", completedDate: DONE, ...extra });

/** Umbrella T-2 (complete, child T-3 delivered), an invalid child T-4 under it, and T-7 blocked by T-2. */
async function board(): Promise<CommandContext> {
  const root = mkdtempSync(join(tmpdir(), "t486-u24-local-"));
  dirs.push(root);
  await initProject(root, { name: "local" });
  const write = (body: Raw) => writeFileSync(join(root, ".story", "tickets", `${String(body.id)}.json`), JSON.stringify(body));
  write(delivered("T-2"));
  write(delivered("T-3", { parentTicket: "T-2" }));
  write(ticket("T-4", { status: "bogus", parentTicket: "T-2" }));
  write(ticket("T-7", { blockedBy: ["T-2"] }));
  const { state, warnings } = await loadProject(root);
  return { state, warnings, root, handoversDir: join(root, ".story", "handovers"), format: "md" };
}

describe("T-486 U2-4: a ticket file the loader could not accept holds the releases it could affect", () => {
  it("B1-G4: an umbrella with a schema-invalid child does not release its dependent, reason incomplete", async () => {
    const ctx = await board();
    const t2 = ctx.state.ticketByID("T-2")!;
    const t7 = ctx.state.ticketByID("T-7")!;
    expect(ctx.state.isBlocked(t7)).toBe(true);
    const release = ctx.state.dependencyRelease(t2);
    expect(release.releases).toBe(false);
    expect(release.reason).toBe("incomplete");
    expect(release.detail.join(" ")).toContain("T-4.json");
  });

  it("L-omit: validate names each omitted ticket file with what is wrong and the fix, and the blocked reason names the file", async () => {
    const ctx = await board();
    const validate = await handleValidateWithSourceRefs({ ...ctx, format: "json" });
    const findings = JSON.parse(validate.output).data.findings as Array<{ code: string; message: string; level: string }>;
    const omitted = findings.filter((f) => f.code === "omitted_ticket_file");
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.message).toContain("T-4.json");
    expect(omitted[0]!.message).toContain("fails the ticket schema");
    expect(omitted[0]!.message).toContain("fix the fields named in the loader warning");
    expect(omitted[0]!.message).toContain("T-2");
    const blocked = await handleTicketBlocked(ctx);
    expect(blocked.output).toContain("T-7");
    expect(blocked.output).toContain("T-4.json");
  });
});
