import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTicketMove } from "../../../src/cli/commands/move.js";
import { initProject } from "../../../src/core/init.js";
import { validateRank, compareByRank } from "../../../src/core/fractional-index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTeamProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "move-test-"));
  dirs.push(dir);
  await initProject(dir, { name: "move-test" });
  const configPath = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.team = { ...(config.team ?? {}), enabled: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return dir;
}

async function writeTicket(
  dir: string,
  id: string,
  rank: string,
  order: number,
): Promise<void> {
  const ticket = {
    id,
    title: `Ticket ${id}`,
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    rank,
  };
  await writeFile(
    join(dir, ".story", "tickets", `${id}.json`),
    JSON.stringify(ticket, null, 2) + "\n",
    "utf-8",
  );
}

async function rankOf(dir: string, id: string): Promise<string | undefined> {
  const raw = JSON.parse(await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8"));
  return raw.rank;
}

/** Writes a ticket with arbitrary field overrides (rank omitted unless provided). */
async function writeTicketRaw(
  dir: string,
  id: string,
  order: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const ticket = {
    id,
    title: `Ticket ${id}`,
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    ...extra,
  };
  await writeFile(
    join(dir, ".story", "tickets", `${id}.json`),
    JSON.stringify(ticket, null, 2) + "\n",
    "utf-8",
  );
}

async function readTicketFile(dir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8"));
}

/** Reads every ticket file and returns ids in displayed (compareByRank) order. */
async function displayedOrder(dir: string): Promise<string[]> {
  const ticketsDir = join(dir, ".story", "tickets");
  const files = (await readdir(ticketsDir)).filter((f) => f.endsWith(".json"));
  const items = await Promise.all(
    files.map(async (f) => {
      const raw = JSON.parse(await readFile(join(ticketsDir, f), "utf-8"));
      return {
        id: raw.id as string,
        rank: raw.rank as string | undefined,
        order: raw.order as number | undefined,
        displayId: raw.displayId as string | undefined,
      };
    }),
  );
  items.sort(compareByRank);
  return items.map((i) => i.id);
}

describe("handleTicketMove (ISS-688: duplicate sibling ranks)", () => {
  it("moves --after a target whose next sibling has an equal rank (no io_error)", async () => {
    const dir = await makeTeamProject();
    // T-002 and T-003 share rank "a1V" (duplicate ranks are spec-allowed). Moving
    // T-001 after T-002 used to throw midpoint("a1V","a1V") -> opaque io_error.
    await writeTicket(dir, "T-001", "a0", 10);
    await writeTicket(dir, "T-002", "a1V", 20);
    await writeTicket(dir, "T-003", "a1V", 30);

    const result = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(validateRank(newRank)).toBe(true);
    // Placed after the target's (duplicated) rank group.
    expect(newRank > "a1V").toBe(true);
    expect(await rankOf(dir, "T-001")).toBe(newRank);
  });

  it("moves --before a target whose previous sibling has an equal rank", async () => {
    const dir = await makeTeamProject();
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "a1V", 20);
    await writeTicket(dir, "T-003", "a1V", 30);

    // siblings sorted by rank: T-002("a1V"), T-003("a1V"), T-001("z0").
    // Move T-001 before T-003 -> prev is T-002 with the same rank "a1V".
    const result = await handleTicketMove("T-001", dir, { before: "T-003", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(validateRank(newRank)).toBe(true);
    expect(newRank < "a1V").toBe(true);
  });

  it("--after a duplicate group lands before the next distinct sibling, not past it", async () => {
    const dir = await makeTeamProject();
    // Group "a1V","a1V" is bounded above by the distinct "a1W". Moving T-001 after
    // the first "a1V" must land in ("a1V","a1W), never past "a1W".
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "a1V", 20);
    await writeTicket(dir, "T-003", "a1V", 30);
    await writeTicket(dir, "T-004", "a1W", 40);

    const result = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(newRank > "a1V").toBe(true);
    expect(newRank < "a1W").toBe(true);
  });

  it("--before a duplicate group lands after the previous distinct sibling, not past it", async () => {
    const dir = await makeTeamProject();
    // Group "a1V","a1V" bounded below by distinct "a1A". Moving T-001 before the
    // second "a1V" must land in ("a1A","a1V), never below "a1A".
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "a1A", 20);
    await writeTicket(dir, "T-003", "a1V", 30);
    await writeTicket(dir, "T-004", "a1V", 40);

    const result = await handleTicketMove("T-001", dir, { before: "T-004", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(newRank > "a1A").toBe(true);
    expect(newRank < "a1V").toBe(true);
  });

  it("still slots strictly between two distinct sibling ranks", async () => {
    const dir = await makeTeamProject();
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "a0", 20);
    await writeTicket(dir, "T-003", "a2", 30);

    const result = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    const newRank = parsed.data.rank as string;
    expect(newRank > "a0").toBe(true);
    expect(newRank < "a2").toBe(true);
  });
});

// Canonical ids for team-shaped fixtures (16 Crockford base32 chars, no i/l/o/u).
const CANON_A = "t-3fg59pn3sfeja1v1";
const CANON_B = "t-a2b3c4d5e6f7g8h9";
const CANON_C = "t-jkmn1pqr2stv3wxy";

describe("handleTicketMove (ISS-753: rank backfill for unranked siblings)", () => {
  it("all-unranked phase: move X --after Y yields the full expected phase order", async () => {
    const dir = await makeTeamProject();
    // No ticket has a rank (the default state: creation never assigns ranks).
    await writeTicketRaw(dir, "T-001", 10);
    await writeTicketRaw(dir, "T-002", 20);
    await writeTicketRaw(dir, "T-003", 30);
    await writeTicketRaw(dir, "T-004", 40);

    const result = await handleTicketMove("T-001", dir, { after: "T-003", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    expect(result.exitCode ?? 0).toBe(0);

    // Pre-fix, only T-001 got a rank and compareByRank sorts ranked before
    // unranked, so T-001 yanked to the top. The full displayed order must be:
    // T-002, T-003, T-001 (immediately after T-003), T-004.
    expect(await displayedOrder(dir)).toEqual(["T-002", "T-003", "T-001", "T-004"]);
  });

  it("mixed ranked/unranked: backfill preserves the displayed order and stamps rank + displayId", async () => {
    const dir = await makeTeamProject();
    // Displayed order pre-move: T-002("a0"), T-004("a1"), then unranked by order:
    // T-001(10), T-003(30), T-005(50).
    await writeTicketRaw(dir, "T-001", 10);
    await writeTicketRaw(dir, "T-002", 20, { rank: "a0" });
    await writeTicketRaw(dir, "T-003", 30);
    await writeTicketRaw(dir, "T-004", 40, { rank: "a1" });
    await writeTicketRaw(dir, "T-005", 50);

    const result = await handleTicketMove("T-005", dir, { before: "T-002", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);

    // T-005 lands before T-002; the sibling displayed order is preserved exactly.
    expect(await displayedOrder(dir)).toEqual(["T-005", "T-002", "T-004", "T-001", "T-003"]);

    // Decided disclosure: backfill materializes rank AND the loader-derived
    // displayId (= id) onto legacy sibling files. Assert both so the write shape
    // is locked, not latent.
    for (const id of ["T-001", "T-003"]) {
      const raw = await readTicketFile(dir, id);
      expect(typeof raw.rank).toBe("string");
      expect(validateRank(raw.rank as string)).toBe(true);
      expect(raw.displayId).toBe(id);
    }
  });

  it("second move after backfill rewrites only the moved ticket (siblings untouched)", async () => {
    const dir = await makeTeamProject();
    await writeTicketRaw(dir, "T-001", 10);
    await writeTicketRaw(dir, "T-002", 20);
    await writeTicketRaw(dir, "T-003", 30);
    await writeTicketRaw(dir, "T-004", 40);

    const first = await handleTicketMove("T-001", dir, { after: "T-003", format: "json" });
    expect(JSON.parse(first.output).ok).toBe(true);

    const siblingsBefore: Record<string, string> = {};
    for (const id of ["T-002", "T-003", "T-004"]) {
      siblingsBefore[id] = await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8");
    }
    const movedBefore = await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8");

    const second = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    expect(JSON.parse(second.output).ok).toBe(true);

    // Backfill already happened; the second move must not rewrite any sibling.
    for (const id of ["T-002", "T-003", "T-004"]) {
      const after = await readFile(join(dir, ".story", "tickets", `${id}.json`), "utf-8");
      expect(after).toBe(siblingsBefore[id]);
    }
    const movedAfter = await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8");
    expect(movedAfter).not.toBe(movedBefore);
    expect(await displayedOrder(dir)).toEqual(["T-002", "T-001", "T-003", "T-004"]);
  });
});

describe("handleTicketMove (ISS-753: display-id resolution)", () => {
  it("resolves display IDs for both the moved ticket and the target in a team-shaped project", async () => {
    const dir = await makeTeamProject();
    await writeTicketRaw(dir, CANON_A, 10, { displayId: "T-401" });
    await writeTicketRaw(dir, CANON_B, 20, { displayId: "T-402" });
    await writeTicketRaw(dir, CANON_C, 30, { displayId: "T-403" });

    const result = await handleTicketMove("T-401", dir, { after: "T-402", format: "json" });
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(true);
    expect(result.exitCode ?? 0).toBe(0);

    expect(await displayedOrder(dir)).toEqual([CANON_B, CANON_A, CANON_C]);
    // The write landed on the canonical file.
    const raw = await readTicketFile(dir, CANON_A);
    expect(typeof raw.rank).toBe("string");
  });

  it("self-move via mixed refs (canonical id vs own displayId) errors with exitCode 1", async () => {
    const dir = await makeTeamProject();
    await writeTicketRaw(dir, CANON_A, 10, { displayId: "T-401" });
    await writeTicketRaw(dir, CANON_B, 20, { displayId: "T-402" });

    const result = await handleTicketMove(CANON_A, dir, { after: "T-401" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("relative to itself");
  });
});

describe("handleTicketMove (ISS-753: error paths set exitCode 1)", () => {
  it("moved ticket not found: md and json", async () => {
    const dir = await makeTeamProject();
    await writeTicketRaw(dir, "T-001", 10);

    const md = await handleTicketMove("T-999", dir, { after: "T-001" });
    expect(md.exitCode).toBe(1);
    expect(md.output).toContain("not found");

    const json = await handleTicketMove("T-999", dir, { after: "T-001", format: "json" });
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.output).ok).toBe(false);
  });

  it("target ticket not found: md and json", async () => {
    const dir = await makeTeamProject();
    await writeTicketRaw(dir, "T-001", 10);

    const md = await handleTicketMove("T-001", dir, { after: "T-999" });
    expect(md.exitCode).toBe(1);
    expect(md.output).toContain("not found");

    const json = await handleTicketMove("T-001", dir, { after: "T-999", format: "json" });
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.output).ok).toBe(false);
  });

  it("cross-phase move: md and json", async () => {
    const dir = await makeTeamProject();
    await writeTicketRaw(dir, "T-001", 10, { phase: "p1" });
    await writeTicketRaw(dir, "T-002", 20, { phase: "p2" });

    const md = await handleTicketMove("T-001", dir, { after: "T-002" });
    expect(md.exitCode).toBe(1);
    expect(md.output).toContain("different phases");

    const json = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.output).ok).toBe(false);
  });

  it("ambiguous display-id (two tickets share it) lists canonical ids: id side md, target side json", async () => {
    const dir = await makeTeamProject();
    // Both canonical tickets claim displayId T-500.
    await writeTicketRaw(dir, CANON_A, 10, { displayId: "T-500" });
    await writeTicketRaw(dir, CANON_B, 20, { displayId: "T-500" });
    await writeTicketRaw(dir, CANON_C, 30, { displayId: "T-403" });

    const md = await handleTicketMove("T-500", dir, { after: "T-403" });
    expect(md.exitCode).toBe(1);
    expect(md.output).toContain("ambiguous");
    expect(md.output).toContain(CANON_A);
    expect(md.output).toContain(CANON_B);

    const json = await handleTicketMove("T-403", dir, { after: "T-500", format: "json" });
    expect(json.exitCode).toBe(1);
    const parsed = JSON.parse(json.output);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain(CANON_A);
    expect(parsed.error).toContain(CANON_B);
  });

  it("rank exhaustion path sets exitCode 1", async () => {
    const dir = await makeTeamProject();
    // "0" is the minimum single-char rank; nothing fits before it.
    await writeTicket(dir, "T-001", "z0", 10);
    await writeTicket(dir, "T-002", "0", 20);

    const result = await handleTicketMove("T-001", dir, { before: "T-002" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("rebalance-ranks");
  });
});

describe("ISS-805: early-validation --format json envelopes", () => {
  // These validations return before withProjectLock, so no real project is needed.
  const stubRoot = "/nonexistent-move-root";

  it("both --after and --before with format json is parseable with ok:false", async () => {
    const result = await handleTicketMove("T-001", stubRoot, {
      after: "T-002",
      before: "T-003",
      format: "json",
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });

  it("neither --after nor --before with format json is parseable with ok:false", async () => {
    const result = await handleTicketMove("T-001", stubRoot, { format: "json" });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(false);
  });

  it("self-move with format json is parseable with ok:false", async () => {
    const result = await handleTicketMove("T-001", stubRoot, {
      after: "T-001",
      format: "json",
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.output);
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error)).toContain("itself");
  });

  it("keeps the plain-text md shape for early validations", async () => {
    const result = await handleTicketMove("T-001", stubRoot, { format: "md" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("Error: specify --after or --before.");
  });
});

// T-481 T14: a rank move is ordering, not content; it never stamps updatedDate.
describe("T-481 T14: handleTicketMove keeps updatedDate", () => {
  it("moving a ticket changes its rank and keeps updatedDate 2020-01-01", async () => {
    const dir = await makeTeamProject();
    await writeTicketRaw(dir, "T-001", 10, { rank: "a0", updatedDate: "2020-01-01" });
    await writeTicketRaw(dir, "T-002", 20, { rank: "a1", updatedDate: "2020-01-01" });

    const result = await handleTicketMove("T-001", dir, { after: "T-002", format: "json" });
    expect(JSON.parse(result.output).ok).toBe(true);
    const raw = JSON.parse(await readFile(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(raw.rank).not.toBe("a0");
    expect(raw.updatedDate).toBe("2020-01-01");
  });
});
