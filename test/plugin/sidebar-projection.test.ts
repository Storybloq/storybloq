import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProject } from "../../src/core/project-loader.js";
import { buildCompactStatusData } from "../../src/core/output-formatter.js";
import {
  extractRecord,
  projectSidebar,
  type SidebarInput,
  type SidebarTicket,
  type SidebarIssue,
} from "../../plugins/storybloq/hooks/sidebar-projection.js";
import { cellWidth, graphemes } from "../../plugins/storybloq/hooks/terminal-text.js";

/**
 * T-508: the ledger sidebar Mod's projection, checked against the one the CLI
 * already ships.
 *
 * The sidebar cannot import `src/core`. The client admits a hooks module's own
 * files by relative path and "claude-code" and refuses everything else, so the
 * projection lives inside the plugin folder and this test is what keeps it
 * from drifting: it loads one fixture `.story/` twice, once through
 * `loadProject` into `buildCompactStatusData` (what `storybloq status
 * --compact` prints) and once through the plugin's own pure projection, and
 * asserts the numbers agree. Change a counting rule on either side and this
 * goes red, which is the point (mutant M-PROJECTION-DRIFT).
 *
 * The fixture is deliberately awkward: an umbrella with children (so leaf
 * counting has something to get wrong), a blocked ticket whose blocker is
 * named by displayId, a blocker that does not exist at all (conservatively
 * blocked), a deleted ticket and a deleted issue (lifecycle), and a resolved
 * issue. Every one of those is a rule the projection has to reproduce rather
 * than approximate.
 */

const config = {
  version: 2,
  project: "sidebar-fixture",
  type: "npm",
  language: "typescript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
};

const roadmap = {
  title: "sidebar-fixture",
  date: "2026-01-01",
  phases: [
    { id: "p1", label: "P1", name: "Phase One", description: "First." },
    { id: "p2", label: "P2", name: "Phase Two", description: "Second." },
    { id: "p3", label: "P3", name: "Phase Three", description: "Third." },
  ],
  blockers: [],
};

function ticket(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "A ticket",
    description: "Body.",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    ...over,
  };
}

function issue(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "An issue",
    status: "open",
    severity: "medium",
    components: ["core"],
    impact: "Impact.",
    resolution: null,
    location: ["file.ts:1"],
    discoveredDate: "2026-01-01",
    resolvedDate: null,
    relatedTickets: [],
    ...over,
  };
}

const tickets: Record<string, Record<string, unknown>> = {
  // An umbrella: a parent is never a leaf, so it must not be counted.
  "T-001.json": ticket({ id: "T-001", title: "Umbrella", phase: "p1", order: 1 }),
  "T-002.json": ticket({ id: "T-002", title: "Child complete", parentTicket: "T-001", status: "complete", phase: "p1", order: 2 }),
  "T-003.json": ticket({ id: "T-003", title: "Child in progress", parentTicket: "T-001", status: "inprogress", phase: "p1", order: 3 }),
  // Phase two: one complete, one blocked by a displayId reference.
  "T-004.json": ticket({ id: "T-004", title: "Done", status: "complete", phase: "p2", order: 4 }),
  "t-zz11yy22xx33ww44.json": ticket({ id: "t-zz11yy22xx33ww44", displayId: "T-005", title: "Blocked by a display id", status: "open", phase: "p2", order: 5, blockedBy: ["T-003"] }),
  // Phase three: nothing started, plus a blocker that does not resolve at all.
  "T-006.json": ticket({ id: "T-006", title: "Blocked by a ghost", status: "open", phase: "p3", order: 6, blockedBy: ["T-999"] }),
  // Deleted: out of every count.
  "T-007.json": ticket({ id: "T-007", title: "Deleted", status: "open", phase: "p3", order: 7, lifecycle: "deleted" }),
  // Phase one, so the board has something in every column: an open ticket, an
  // open one that is blocked, and a second complete one for the Done order.
  "T-020.json": ticket({ id: "T-020", title: "Open one", status: "open", phase: "p1", order: 20 }),
  "T-021.json": ticket({ id: "T-021", title: "Blocked open one", status: "open", phase: "p1", order: 21, blockedBy: ["T-003"] }),
  "T-022.json": ticket({ id: "T-022", title: "Done newer", status: "complete", phase: "p1", order: 22 }),
  // A displayId collision, which is what `storybloq reconcile` exists for.
  // Two tickets answer to T-010 and a third used to, and a fourth names T-010
  // as its parent. The CLI's parent resolution falls through the ambiguous
  // displayId to the unique previous one, so the THIRD is the umbrella; a
  // resolver that stops at "ambiguous" leaves it counted as a leaf.
  "t-aa11aa11aa11aa11.json": ticket({ id: "t-aa11aa11aa11aa11", displayId: "T-010", title: "Collides one", status: "open", phase: "p3", order: 10 }),
  "t-bb22bb22bb22bb22.json": ticket({ id: "t-bb22bb22bb22bb22", displayId: "T-010", title: "Collides two", status: "open", phase: "p3", order: 11 }),
  "t-cc33cc33cc33cc33.json": ticket({ id: "t-cc33cc33cc33cc33", displayId: "T-011", previousDisplayIds: ["T-010"], title: "Renamed away from T-010", status: "open", phase: "p3", order: 12 }),
  "T-013.json": ticket({ id: "T-013", title: "Child of the renamed one", parentTicket: "T-010", status: "open", phase: "p3", order: 13 }),
};

const issues: Record<string, Record<string, unknown>> = {
  "ISS-001.json": issue({ id: "ISS-001", title: "Critical one", severity: "critical" }),
  "ISS-002.json": issue({ id: "ISS-002", title: "High one", severity: "high", status: "inprogress" }),
  "ISS-003.json": issue({ id: "ISS-003", title: "Medium one", severity: "medium" }),
  "ISS-004.json": issue({ id: "ISS-004", title: "Resolved one", severity: "low", status: "resolved", resolvedDate: "2026-01-02" }),
  "ISS-005.json": issue({ id: "ISS-005", title: "Deleted one", severity: "low", lifecycle: "deleted" }),
  // Open and the least severe, and FIRST alphabetically: without it the
  // severity order and the id order agree on this fixture and M-ISSUE-ORDER
  // survives the column assertions below.
  "ISS-000.json": issue({ id: "ISS-000", title: "Low open", severity: "low" }),
};

const handovers: Record<string, string> = {
  "2026-01-01-first.md": "# First",
  "2026-01-03-latest.md": "# Latest",
  "2026-01-02-middle.md": "# Middle",
};

async function writeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "storybloq-sidebar-"));
  const storyDir = join(root, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await writeFile(join(storyDir, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify(roadmap, null, 2));
  for (const [name, data] of Object.entries(tickets)) {
    await writeFile(join(storyDir, "tickets", name), JSON.stringify(data, null, 2));
  }
  for (const [name, data] of Object.entries(issues)) {
    await writeFile(join(storyDir, "issues", name), JSON.stringify(data, null, 2));
  }
  for (const [name, text] of Object.entries(handovers)) {
    await writeFile(join(storyDir, "handovers", name), text);
  }
  return root;
}

/**
 * Reads the fixture the way the Mod does: one text per file, then
 * `extractRecord` per text. Nothing here knows a counting rule; that is the
 * projection's job, which is what makes the equality below meaningful.
 */
async function readAsTheModDoes(root: string): Promise<SidebarInput> {
  const storyDir = join(root, ".story");
  const ticketTexts: string[] = [];
  for (const name of await readdir(join(storyDir, "tickets"))) {
    ticketTexts.push(await readFile(join(storyDir, "tickets", name), "utf8"));
  }
  const issueTexts: string[] = [];
  for (const name of await readdir(join(storyDir, "issues"))) {
    issueTexts.push(await readFile(join(storyDir, "issues", name), "utf8"));
  }
  const parsedTickets: SidebarTicket[] = [];
  for (const text of ticketTexts) {
    const record = extractRecord("ticket", text);
    if (record) parsedTickets.push(record as SidebarTicket);
  }
  const parsedIssues: SidebarIssue[] = [];
  for (const text of issueTexts) {
    const record = extractRecord("issue", text);
    if (record) parsedIssues.push(record as SidebarIssue);
  }
  const roadmapDoc = JSON.parse(await readFile(join(storyDir, "roadmap.json"), "utf8")) as {
    phases: readonly { id: string; name: string }[];
  };
  const configDoc = JSON.parse(await readFile(join(storyDir, "config.json"), "utf8")) as {
    project: string;
  };
  return {
    project: configDoc.project,
    phases: roadmapDoc.phases.map((p) => ({ id: p.id, name: p.name })),
    tickets: parsedTickets,
    issues: parsedIssues,
    handoverFilenames: (await readdir(join(storyDir, "handovers"))).slice(),
  };
}

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("sidebar projection (T-508)", () => {
  it("counts tickets, issues and phases exactly as status --compact does", async () => {
    root = await writeFixture();
    const { state } = await loadProject(root);
    const compact = buildCompactStatusData(state, [], [], undefined, undefined, [], {
      items: [],
      warnings: [],
    });
    const mine = projectSidebar(await readAsTheModDoes(root));

    expect(mine.project).toBe(compact.project);
    expect(mine.totalTickets).toBe(compact.totalTickets);
    expect(mine.completeTickets).toBe(compact.completeTickets);
    expect(mine.openTickets).toBe(compact.openTickets);
    expect(mine.blockedTickets).toBe(compact.blockedTickets);
    expect(mine.openIssues).toBe(compact.openIssues);
    expect(mine.phases).toEqual(
      compact.phases.map((p) => ({ id: p.id, name: p.name, status: p.status, leafCount: p.leafCount })),
    );
  });

  it("is checked against numbers the fixture actually has, not against zero", async () => {
    // Guards the equality above: two projections that both return nothing
    // agree perfectly. These are the fixture's real figures, read off the
    // rules rather than off either implementation.
    root = await writeFixture();
    const { state } = await loadProject(root);
    const compact = buildCompactStatusData(state, [], [], undefined, undefined, [], {
      items: [],
      warnings: [],
    });
    // T-001 is an umbrella, T-007 is deleted, and t-cc33 is an umbrella too
    // because T-013's parent ref T-010 resolves through the historical
    // displayId: eight leaves remain.
    expect(compact.totalTickets).toBe(11);
    expect(compact.completeTickets).toBe(3);
    expect(compact.openTickets).toBe(8);
    // t-zz11yy22xx33ww44 is blocked by T-003 (in progress), T-006 by a ghost
    // ref, and T-021 by T-003 as well.
    expect(compact.blockedTickets).toBe(3);
    // ISS-004 is resolved and ISS-005 is deleted: three remain.
    expect(compact.openIssues).toBe(4);
    expect(compact.phases.map((p) => p.status)).toEqual(["inprogress", "inprogress", "notstarted"]);
  });

  it("resolves a parent through a historical displayId when the current one collides", async () => {
    // The rule this pins, from ProjectState's localResolve: id, then a
    // displayId matching exactly one ticket, then a previousDisplayIds
    // matching exactly one. An ambiguous displayId does not end the search.
    // M-PARENT-AMBIGUOUS returns ambiguous there and this goes red.
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    const leafIds = mine.inProgressTickets.map((t) => t.id);
    expect(leafIds).not.toContain("T-011");
    const { state } = await loadProject(root);
    expect(state.isUmbrella(state.tickets.find((t) => t.id === "t-cc33cc33cc33cc33")!)).toBe(true);
    expect(mine.totalTickets).toBe(11);
  });

  it("splits the whole project's leaves into three columns that partition them", async () => {
    root = await writeFixture();
    const { state } = await loadProject(root);
    const compact = buildCompactStatusData(state, [], [], undefined, undefined, [], {
      items: [],
      warnings: [],
    });
    const mine = projectSidebar(await readAsTheModDoes(root));
    const columns = [...mine.board.open, ...mine.board.inProgress, ...mine.board.done];
    // T-513 put issues on the board, and the CLI's compact payload carries no
    // issue identity at all, so the equalities below are restated rather than
    // extended: the TICKET cards are what the CLI's ticket figures answer to,
    // and the issue side is pinned against a direct read of `.story/issues`
    // further down. Both sides are still multisets by display id, because the
    // fixture deliberately collides two of them.
    const ticketsOf = (cards: readonly { kind: string; id: string }[]): string[] =>
      cards.filter((card) => card.kind === "ticket").map((card) => card.id);
    const issuesOf = (cards: readonly { kind: string; id: string }[]): string[] =>
      cards.filter((card) => card.kind === "issue").map((card) => card.id);
    const ids = ticketsOf(columns).sort();

    // The board is the project's, so its ticket columns are the CLI's own
    // figures: the two unfinished ones add up to openTickets, Done is
    // completeTickets and the three together are every leaf, once each.
    expect(
      ticketsOf(mine.board.open).length + ticketsOf(mine.board.inProgress).length,
    ).toBe(compact.openTickets);
    expect(ticketsOf(mine.board.done).length).toBe(compact.completeTickets);
    expect(ids.length).toBe(compact.totalTickets);
    expect(ticketsOf([...mine.board.open, ...mine.board.inProgress].filter(c => c.blocked)).length).toBe(compact.blockedTickets);
    // No issue is ever blocked: one carries no blockedBy for anything to
    // point at. M-ISSUE-IN-BLOCKED files one there and this fails.
    expect(issuesOf([...mine.board.open, ...mine.board.inProgress].filter(c => c.blocked))).toEqual([]);

    // The other side of the partition, read from the CLI: every active leaf
    // of the project, once each. A multiset and not a set, because this
    // fixture has two tickets answering to the display id T-010 and the board
    // must show both rather than quietly collapse them.
    const leaves = state.tickets
      .filter((t) => {
        const lifecycle = (t as { lifecycle?: string | null }).lifecycle;
        return (lifecycle === undefined || lifecycle === null || lifecycle === "active") && !state.isUmbrella(t);
      })
      .map((t) => (t as { displayId?: string }).displayId ?? t.id)
      .sort();
    expect(ids).toEqual(leaves);
    // Phases two and three are on the board too. M-PHASE-ONLY filters back to
    // the current phase and every one of these equalities breaks.
    expect(ids).toContain("T-004");
    expect(ids).toContain("T-006");

    // The issue side, read from the ledger the same way: every active issue
    // once each, open and in progress in the two live columns and resolved in
    // Done. M-ISSUES-ABSENT leaves the board a ticket board and the first of
    // these fails; M-RESOLVED-IN-OPEN moves the resolved one and the last two
    // do.
    const active = state.issues.filter((i) => {
      const lifecycle = (i as { lifecycle?: string | null }).lifecycle;
      return lifecycle === undefined || lifecycle === null || lifecycle === "active";
    });
    const named = (status: string): string[] =>
      active
        .filter((i) => i.status === status)
        .map((i) => (i as { displayId?: string }).displayId ?? i.id)
        .sort();
    expect(issuesOf(columns).slice().sort()).toEqual(
      active.map((i) => (i as { displayId?: string }).displayId ?? i.id).sort(),
    );
    expect(issuesOf(mine.board.open).slice().sort()).toEqual(named("open"));
    expect(issuesOf(mine.board.inProgress).slice().sort()).toEqual(named("inprogress"));
    expect(issuesOf(mine.board.done).slice().sort()).toEqual(named("resolved"));
    // And the two live columns hold exactly the issues the CLI calls open.
    expect(issuesOf(mine.board.open).length + issuesOf(mine.board.inProgress).length).toBe(compact.openIssues);
  });

  it("puts each status in its own column, newest done first", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    // M-COLUMN-MIX puts a complete ticket in Open and this fails. Open is in
    // ticket order, Done in reverse: the last thing finished reads first.
    // Tickets first in every column, then the issues, worst severity first.
    expect(mine.board.open.map((c) => c.id)).toEqual([
      "T-005",
      "T-006",
      "T-010",
      "T-010",
      "T-013",
      "T-020",
      "T-021",
      "ISS-001",
      "ISS-003",
      "ISS-000",
    ]);
    expect(mine.board.inProgress.map((c) => c.id)).toEqual(["T-003", "ISS-002"]);
    expect(mine.board.done.map((c) => c.id)).toEqual(["T-022", "T-004", "T-002", "ISS-004"]);
  });

  it("marks blocked tickets inside their underlying status column", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    // T-021 stays Open with a blocked attribute, and appears only once.
    expect([...mine.board.open, ...mine.board.inProgress].filter(c => c.blocked).map((c) => c.id)).toEqual(["T-005", "T-006", "T-021"]);
    expect(mine.board.open.map((c) => c.id)).toContain("T-021");
  });

  it("keeps a record whose status is none of the ledger's in a column", async () => {
    // The ledger is hand-editable JSON and the Mod reads it raw, so a leaf can
    // carry a status the CLI's enum does not have: "blocked" and "deferred"
    // both turn up in real projects. Open is therefore the REMAINDER (not
    // complete, not in progress, not waiting on anything), because a column
    // set built from status equality drops those leaves off the board while
    // they still count in leafCount and openTickets, and the reader sees a
    // board that does not add up. M-STATUS-DROPPED filters Open on
    // status === "open" and this goes red.
    const leaf = (over: Partial<SidebarTicket>): SidebarTicket => ({
      kind: "ticket",
      id: "x",
      displayId: null,
      title: "t",
      status: "open",
      phase: "p1",
      order: 1,
      blockedBy: [],
      parentTicket: null,
      previousDisplayIds: [],
      lifecycle: null,
      ...over,
    });
    const input: SidebarInput = {
      project: "odd-statuses",
      phases: [{ id: "p1", name: "Phase One" }],
      tickets: [
        leaf({ id: "T-100", status: "blocked", order: 1, blockedBy: [] }),
        leaf({ id: "T-101", status: "deferred", order: 2, blockedBy: ["T-200"] }),
        leaf({ id: "T-102", status: "blocked", order: 3, blockedBy: ["T-103"] }),
        leaf({ id: "T-103", status: "inprogress", order: 4 }),
        leaf({ id: "T-200", status: "complete", order: 5 }),
      ],
      // The same on the issue side, and for the same reason: `wontfix` is not
      // one of the CLI's three, it is still counted in openIssues, and a
      // column set built from status equality would leave it off a board that
      // claims to partition. M-ISSUE-STATUS-EXACT matches Open on
      // status === "open" and ISS-101 lands in no column at all.
      issues: [
        { kind: "issue", id: "ISS-100", displayId: null, previousDisplayIds: [], title: "Open one", status: "open", severity: "high", lifecycle: null },
        { kind: "issue", id: "ISS-101", displayId: null, previousDisplayIds: [], title: "Neither", status: "wontfix", severity: "low", lifecycle: null },
        { kind: "issue", id: "ISS-102", displayId: null, previousDisplayIds: [], title: "Resolved one", status: "resolved", severity: "low", lifecycle: null },
      ],
      handoverFilenames: [],
    };
    const mine = projectSidebar(input);
    const columns = [...mine.board.open, ...mine.board.inProgress, ...mine.board.done];

    // The partition: five leaves and three issues in, eight cards out, once
    // each.
    expect(columns.map((c) => c.id).sort()).toEqual([
      "ISS-100",
      "ISS-101",
      "ISS-102",
      "T-100",
      "T-101",
      "T-102",
      "T-103",
      "T-200",
    ]);
    expect(mine.totalTickets).toBe(columns.filter((c) => c.kind === "ticket").length);
    // Everything the projection calls an open issue is on the board in one of
    // the two live columns.
    expect(mine.openIssues).toBe(2);
    // No blocker at all, and a blocker that is already complete: both are
    // pickable, so both are Open whatever their stored status says.
    expect(mine.board.open.map((c) => c.id)).toEqual(["T-100", "T-101", "T-102", "ISS-100", "ISS-101"]);
    // An unmet blocker is marked without changing the stored status grouping.
    expect([...mine.board.open, ...mine.board.inProgress].filter(c => c.blocked).map((c) => c.id)).toEqual(["T-102"]);
  });

  it("orders every column the same way whatever order the files were read in", async () => {
    // Blocked and In progress had only the order number to sort on, and the
    // ledger hands the same number out freely, so two tickets could swap
    // places between renders for no reason a reader could see.
    // M-UNORDERED-BLOCKED drops the tie-break and this goes red.
    const leaf = (over: Partial<SidebarTicket>): SidebarTicket => ({
      kind: "ticket",
      id: "x",
      displayId: null,
      title: "t",
      status: "open",
      phase: "p1",
      order: 0,
      blockedBy: [],
      parentTicket: null,
      previousDisplayIds: [],
      lifecycle: null,
      ...over,
    });
    const tickets: SidebarTicket[] = [
      leaf({ id: "T-003", status: "blocked", blockedBy: ["T-900"] }),
      leaf({ id: "T-001", status: "blocked", blockedBy: ["T-900"] }),
      leaf({ id: "T-002", status: "blocked", blockedBy: ["T-900"] }),
      leaf({ id: "T-006", status: "inprogress" }),
      leaf({ id: "T-004", status: "inprogress" }),
      leaf({ id: "T-005", status: "inprogress" }),
      leaf({ id: "T-009", status: "open" }),
      leaf({ id: "T-007", status: "open" }),
    ];
    const input: SidebarInput = {
      project: "ties",
      phases: [{ id: "p1", name: "Phase One" }],
      tickets,
      issues: [],
      handoverFilenames: [],
    };
    // Two tickets sharing an order AND a display id, which is what
    // `storybloq reconcile` exists for: the canonical id is the last word.
    // M-DUP-ID-UNSTABLE drops it and these two swap on read order.
    tickets.push(leaf({ id: "t-bb22bb22bb22bb22", displayId: "T-500", status: "open", title: "second" }));
    tickets.push(leaf({ id: "t-aa11aa11aa11aa11", displayId: "T-500", status: "open", title: "first" }));
    // Done sorts the other way and breaks its ties the other way too, so the
    // same pair among complete tickets comes back reversed. The column had no
    // assertion of its own, so its tie-break was carried by nothing.
    tickets.push(leaf({ id: "t-dd44dd44dd44dd44", displayId: "T-600", status: "complete", title: "later" }));
    tickets.push(leaf({ id: "t-cc33cc33cc33cc33", displayId: "T-600", status: "complete", title: "earlier" }));
    const forwards = projectSidebar(input);
    const backwards = projectSidebar({ ...input, tickets: [...tickets].reverse() });

    expect(forwards.board.open.filter(c => c.blocked).map((c) => c.id)).toEqual(["T-001", "T-002", "T-003"]);
    expect(forwards.board.inProgress.map((c) => c.id)).toEqual(["T-004", "T-005", "T-006"]);
    expect(forwards.board.open.map((c) => c.id)).toEqual(["T-001", "T-002", "T-003", "T-007", "T-009", "T-500", "T-500"]);
    // The pair is ordered by canonical id, so the aa11 one comes first, and
    // the titles say which is which.
    expect(forwards.board.open.slice(-2).map((c) => c.title)).toEqual(["first", "second"]);
    expect(backwards.board.open.slice(-2).map((c) => c.title)).toEqual(["first", "second"]);
    // Same ledger, opposite read order, same board.
    expect(backwards.board.open.filter(c => c.blocked).map((c) => c.id)).toEqual(forwards.board.open.filter(c => c.blocked).map((c) => c.id));
    expect(backwards.board.inProgress.map((c) => c.id)).toEqual(forwards.board.inProgress.map((c) => c.id));
    expect(backwards.board.open.map((c) => c.id)).toEqual(forwards.board.open.map((c) => c.id));

    // Descending canonical id: dd44 before cc33, the same both ways round.
    expect(forwards.board.done.map((c) => c.id)).toEqual(["T-600", "T-600"]);

    expect(forwards.board.done.map((c) => c.title)).toEqual(["later", "earlier"]);
    expect(backwards.board.done.map((c) => c.title)).toEqual(["later", "earlier"]);
  });

  it("names the two newest handovers, newest first", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.latestHandovers).toEqual(["2026-01-03-latest.md", "2026-01-02-middle.md"]);
  });

  it("counts open issues by severity", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.issuesBySeverity).toEqual({ critical: 1, high: 1, medium: 1, low: 1 });
  });

  it("names the in-progress leaf tickets, and never an umbrella", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.inProgressTickets.map((t) => t.id)).toEqual(["T-003"]);
  });

  it("takes the newest handovers by filename, not by the order they were read", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.latestHandovers[0]).toBe("2026-01-03-latest.md");
  });

  it("names the first phase still in progress as the current one", async () => {
    root = await writeFixture();
    const mine = projectSidebar(await readAsTheModDoes(root));
    expect(mine.currentPhase?.id).toBe("p1");
  });

  it("truncates a title at extraction, so the store stays small", async () => {
    const long = "x".repeat(400);
    const record = extractRecord("ticket", JSON.stringify(ticket({ id: "T-100", title: long })));
    expect(record).not.toBeNull();
    expect(record!.title.length).toBeLessThanOrEqual(80);
  });

  it("ISS-1306: cleans a title for display before capping it", () => {
    const title = (raw: string, kind: "ticket" | "issue" = "ticket") => {
      const text = JSON.stringify(kind === "ticket" ? ticket({ id: "T-100", title: raw }) : { id: "ISS-9", title: raw, severity: "high", status: "open" });
      return extractRecord(kind, text)!.title;
    };
    expect(title("Red \u001b[31malert\u001b[0m")).toBe("Red  [31malert [0m");
    expect(title("abc\u202edcba")).toBe("abc dcba");
    expect(title("nul\u0000byte", "issue")).toBe("nul byte");
    expect(title("a\r\nb")).toBe("a b");
    expect(title("\u001b\u0007\u009b")).toBe("");
    expect(title("Plain title, unchanged")).toBe("Plain title, unchanged");
    // The cap counts the cleaned string: a 40-unit control run collapses to
    // one space, so all 80 drawn characters survive, ending in "y".
    const long = title(`x${"\u0000".repeat(40)}${"y".repeat(200)}`);
    expect(long).toBe(`x ${"y".repeat(78)}`);
  });

  it("ISS-1306: removes invisible code points from a title and keeps ZWNJ and ZWJ", () => {
    const title = (raw: string) => extractRecord("ticket", JSON.stringify(ticket({ id: "T-100", title: raw })))!.title;
    expect(title("hid\u200bden\u2060text\ufeff")).toBe("hiddentext");
    expect(title("\u200eLTR\u200f RTL\u061c")).toBe("LTR RTL");
    // A Persian title with ZWNJ (U+200C) comes through byte-identical.
    const persian = "\u062a\u06a9\u0645\u06cc\u0644 \u0628\u0631\u0646\u0627\u0645\u0647\u200c\u0647\u0627";
    expect(title(persian)).toBe(persian);
    // A ZWJ emoji title keeps one grapheme cluster, drawn in two cells.
    const coder = title("\u{1f469}\u200d\u{1f4bb}");
    expect(coder).toBe("\u{1f469}\u200d\u{1f4bb}");
    expect(graphemes(coder)).toHaveLength(1);
    expect(cellWidth(coder)).toBe(2);
  });

  it("returns null for a text that is not a record, rather than throwing", () => {
    expect(extractRecord("ticket", "{not json")).toBeNull();
    expect(extractRecord("ticket", JSON.stringify({ title: "no id" }))).toBeNull();
    expect(extractRecord("issue", JSON.stringify({ id: "ISS-9" }))).toBeNull();
  });
});
