import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRulingCreate } from "../../src/cli/commands/ruling.js";
import { CliValidationError } from "../../src/cli/helpers.js";
import { initProject } from "../../src/core/init.js";
import { RULING_MAX_BYTES } from "../../src/core/ruling-loader.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ruling-cites-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test" });
  return dir;
}

const BASE = {
  text: "Verbatim ruling text.",
  attribution: "owner-direct",
  date: "2026-08-27",
  scopeTags: [] as string[],
  clientTaskId: "test-session-1",
};

/**
 * Writes a ticket at the path its OWN `id` yields, which is what
 * `writeTicketUnlocked` does. A legacy item's id IS its display id, so it lands
 * at `T-001.json`; a post-migration item's id is the hash and its display id is
 * a separate field, so it lands at `t-<hash>.json`. Both forms are canonical and
 * both are live on this ledger, which is why every test that writes an item
 * writes it this way rather than deriving a filename from the display id.
 */
async function writeTicketFixture(
  dir: string,
  ticket: Record<string, unknown> & { id: string },
): Promise<string> {
  const path = join(dir, ".story", "tickets", `${ticket.id}.json`);
  await mkdir(join(dir, ".story", "tickets"), { recursive: true });
  const full = {
    title: `Test ${ticket.id}`,
    description: "Test ticket.",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    createdDate: "2026-03-11",
    completedDate: null,
    blockedBy: [],
    ...ticket,
  };
  await writeFile(path, `${JSON.stringify(full, null, 2)}\n`, "utf-8");
  return path;
}

async function writeIssueFixture(
  dir: string,
  issue: Record<string, unknown> & { id: string },
): Promise<string> {
  const path = join(dir, ".story", "issues", `${issue.id}.json`);
  await mkdir(join(dir, ".story", "issues"), { recursive: true });
  const full = {
    title: `Test ${issue.id}`,
    status: "open",
    severity: "medium",
    components: [],
    impact: "Test.",
    resolution: null,
    location: [],
    discoveredDate: "2026-03-11",
    resolvedDate: null,
    relatedTickets: [],
    ...issue,
  };
  await writeFile(path, `${JSON.stringify(full, null, 2)}\n`, "utf-8");
  return path;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
}

async function rulingIdsOnDisk(dir: string): Promise<string[]> {
  try {
    const names = await readdir(join(dir, ".story", "rulings"));
    return names.filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

const HASH_TICKET_ID = "t-abcdefghjkmnpqrs";
const HASH_ISSUE_ID = "i-abcdefghjkmnpqrs";

describe("ruling create --cites: the citation lands on the item", () => {
  it("appends the new ruling id to a legacy display-id-filename ticket", async () => {
    const dir = await newProject();
    const path = await writeTicketFixture(dir, { id: "T-001" });

    const result = await handleRulingCreate({ ...BASE, cites: ["T-001"] }, "json", dir);
    const rulingId = JSON.parse(result.output).data.id as string;

    expect(await readJson(path)).toMatchObject({ citesRulings: [rulingId] });
  });

  it("appends to a hash-filename ticket at the path its own id yields, not one re-derived from the display id", async () => {
    const dir = await newProject();
    const path = await writeTicketFixture(dir, { id: HASH_TICKET_ID, displayId: "T-002" });

    const result = await handleRulingCreate({ ...BASE, cites: ["T-002"] }, "json", dir);
    const rulingId = JSON.parse(result.output).data.id as string;

    // The citation lands in t-<hash>.json. A path re-derived from the display
    // id would create a second, dark T-002.json that nothing reads.
    expect(await readJson(path)).toMatchObject({ citesRulings: [rulingId] });
    await expect(stat(join(dir, ".story", "tickets", "T-002.json"))).rejects.toThrow();
  });

  it("appends to an issue as well as a ticket in the same call", async () => {
    const dir = await newProject();
    const tPath = await writeTicketFixture(dir, { id: "T-001" });
    const iPath = await writeIssueFixture(dir, { id: "ISS-001" });

    const result = await handleRulingCreate({ ...BASE, cites: ["T-001", "ISS-001"] }, "json", dir);
    const rulingId = JSON.parse(result.output).data.id as string;

    expect(await readJson(tPath)).toMatchObject({ citesRulings: [rulingId] });
    expect(await readJson(iPath)).toMatchObject({ citesRulings: [rulingId] });
  });

  it("UNIONS with existing citations rather than replacing them", async () => {
    const dir = await newProject();
    const path = await writeTicketFixture(dir, {
      id: "T-001",
      citesRulings: ["r-aaaaaaaaaaaaaaaa"],
    });

    const result = await handleRulingCreate({ ...BASE, cites: ["T-001"] }, "json", dir);
    const rulingId = JSON.parse(result.output).data.id as string;

    // `resolveCitesRulingsInput`'s full-replacement convention is right for an
    // explicit --cites-ruling update and catastrophic here: this path adds one
    // citation and must leave every other one standing.
    expect((await readJson(path)).citesRulings).toEqual(["r-aaaaaaaaaaaaaaaa", rulingId]);
  });

  it("accumulates across two creates instead of overwriting the first", async () => {
    const dir = await newProject();
    const path = await writeTicketFixture(dir, { id: "T-001" });

    const first = JSON.parse(
      (await handleRulingCreate({ ...BASE, cites: ["T-001"] }, "json", dir)).output,
    ).data.id as string;
    const second = JSON.parse(
      (await handleRulingCreate({ ...BASE, cites: ["T-001"] }, "json", dir)).output,
    ).data.id as string;

    expect(first).not.toBe(second);
    expect((await readJson(path)).citesRulings).toEqual([first, second]);
  });
});

describe("ruling create --cites: refusals happen before anything is written", () => {
  it("refuses an unresolvable item id and writes NO ruling", async () => {
    const dir = await newProject();

    await expect(
      handleRulingCreate({ ...BASE, cites: ["T-404"] }, "json", dir),
    ).rejects.toThrow(CliValidationError);

    // A ruling created with a citation that silently did not land is worse
    // than no ruling: the pen would believe it is reachable.
    expect(await rulingIdsOnDisk(dir)).toEqual([]);
  });

  it("refuses when one of several cited ids is unresolvable, leaving every item untouched", async () => {
    const dir = await newProject();
    const path = await writeTicketFixture(dir, { id: "T-001" });

    await expect(
      handleRulingCreate({ ...BASE, cites: ["T-001", "ISS-404"] }, "json", dir),
    ).rejects.toThrow(CliValidationError);

    expect(await rulingIdsOnDisk(dir)).toEqual([]);
    expect(await readJson(path)).not.toHaveProperty("citesRulings");
  });

  it("refuses a ruling whose serialized record exceeds RULING_MAX_BYTES before touching any item", async () => {
    const dir = await newProject();
    const path = await writeTicketFixture(dir, { id: "T-001" });

    await expect(
      handleRulingCreate(
        { ...BASE, text: "x".repeat(RULING_MAX_BYTES + 1), cites: ["T-001"] },
        "json",
        dir,
      ),
    ).rejects.toThrow();

    // The reader applies the same bound, so a persisted oversized ruling would
    // be a write-only record: this ticket's own failure mode by another door.
    expect(await rulingIdsOnDisk(dir)).toEqual([]);
    expect(await readJson(path)).not.toHaveProperty("citesRulings");
  });
});

describe("ruling create --cites: duplicate refs are deduplicated, not written twice", () => {
  it("accepts the same display id twice and writes the item once", async () => {
    const dir = await newProject();
    const path = await writeTicketFixture(dir, { id: "T-001" });

    const result = await handleRulingCreate(
      { ...BASE, cites: ["T-001", "T-001"] },
      "json",
      dir,
    );
    const rulingId = JSON.parse(result.output).data.id as string;

    // Two operations on one target share the transaction's deterministic
    // `${target}.${pid}.tmp` path: the first rename consumes it and the second
    // fails ENOENT AFTER commit started. So this is a mid-commit failure, not
    // a harmless no-op, and the dedupe is what prevents it.
    expect((await readJson(path)).citesRulings).toEqual([rulingId]);
  });

  it("accepts a display id and its canonical id naming ONE item and writes it once", async () => {
    const dir = await newProject();
    const path = await writeTicketFixture(dir, { id: HASH_TICKET_ID, displayId: "T-002" });

    const result = await handleRulingCreate(
      { ...BASE, cites: ["T-002", HASH_TICKET_ID] },
      "json",
      dir,
    );
    const rulingId = JSON.parse(result.output).data.id as string;

    expect((await readJson(path)).citesRulings).toEqual([rulingId]);
  });

  it("deduplicates an issue ref given in both forms", async () => {
    const dir = await newProject();
    const path = await writeIssueFixture(dir, { id: HASH_ISSUE_ID, displayId: "ISS-002" });

    const result = await handleRulingCreate(
      { ...BASE, cites: ["ISS-002", HASH_ISSUE_ID] },
      "json",
      dir,
    );
    const rulingId = JSON.parse(result.output).data.id as string;

    expect((await readJson(path)).citesRulings).toEqual([rulingId]);
  });
});

describe("ruling create --cites: writer invariants the transaction does not carry", () => {
  it("creates the FIRST ruling in a project whose .story/rulings directory does not exist", async () => {
    const dir = await newProject();
    await rm(join(dir, ".story", "rulings"), { recursive: true, force: true });
    const path = await writeTicketFixture(dir, { id: "T-001" });

    const result = await handleRulingCreate({ ...BASE, cites: ["T-001"] }, "json", dir);
    const rulingId = JSON.parse(result.output).data.id as string;

    // `writeRulingUnlocked` mkdir -p's this directory and the transaction does
    // not, so dropping the mkdir fails the temp write with ENOENT and breaks
    // the first ruling in every project.
    expect(await rulingIdsOnDisk(dir)).toEqual([`${rulingId}.json`]);
    expect(await readJson(path)).toMatchObject({ citesRulings: [rulingId] });
  });

  it("still creates a ruling with no cites at all", async () => {
    const dir = await newProject();
    const result = await handleRulingCreate(BASE, "json", dir);
    expect(JSON.parse(result.output).data.id).toMatch(/^r-[0-9a-hjkmnp-tv-z]{16}$/);
  });

  it("does not re-acquire the non-reentrant lock the create already holds", async () => {
    const dir = await newProject();
    await writeTicketFixture(dir, { id: "T-001" });

    // `handleRulingCreate` already runs inside `withProjectLock`, and that lock
    // is a non-reentrant `.story/.lock` file lock. Under a nested-acquisition
    // mutant this does not hang forever, which is what an earlier version of
    // this comment claimed: it spins to `project-lock.ts`'s
    // `DEFAULT_DEADLINE_MS` (5,000) and throws a lock-acquisition error. The
    // 3-second budget below is therefore the assertion, not a formality -- it
    // is under that deadline, so a nested acquisition cannot look like a slow
    // success.
    await expect(
      handleRulingCreate({ ...BASE, cites: ["T-001"] }, "json", dir),
    ).resolves.toBeDefined();
  }, 3_000);
});
