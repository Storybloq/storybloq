#!/usr/bin/env tsx
/**
 * Writes `test/fixtures/ticket-count-vectors.json` (ISS-1377, ISS-1378): the
 * ticket boards the CLI and the Mac app both pin, with what the CLI's
 * `ProjectState` and `queries.ts` compute for each: the counts, the blocked
 * tickets, phase and umbrella status and progress, and every record's
 * dependency release. It also carries the calendar dates `DateSchema` accepts
 * or refuses, which the withdrawal view reads. Every expected value comes from
 * the CLI code; a drift test regenerates the file in memory and compares.
 *
 * Records are written as the loader hands them to `ProjectState`: a legacy
 * display-id record (`T-001`) carries its `displayId`, as `loadProject` gives it.
 *
 * Usage:
 *   tsx scripts/ticket-count-vectors.ts            # write the file
 *   tsx scripts/ticket-count-vectors.ts --stdout   # print it
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectState } from "../src/core/project-state.js";
import { blockedTickets, umbrellaProgress } from "../src/core/queries.js";
import { isEffectivelyWithdrawn } from "../src/core/resolution-kind.js";
import { TicketSchema, type Ticket } from "../src/models/ticket.js";
import { DateSchema } from "../src/models/types.js";
import { RoadmapSchema } from "../src/models/roadmap.js";
import { ConfigSchema } from "../src/models/config.js";
import { checkpoint } from "./owner-checkpoint-vectors.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VECTORS_OUT = join(pkgRoot, "test", "fixtures", "ticket-count-vectors.json");

type Raw = Record<string, unknown>;

const DONE = "2026-02-01";
const WITHDRAWAL = { kind: "withdrawn", closedOn: DONE, reason: "Superseded by the redesign." };
const DEL = { lifecycle: "deleted", deletedAt: "2026-03-01T00:00:00.000Z" };
const ARC = { lifecycle: "archived" };

function t(id: string, extra: Raw = {}): Raw {
  return {
    id,
    title: id,
    description: "",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    ...(/^T-\d+$/.test(id) ? { displayId: id } : {}),
    ...extra,
  };
}
const done = (id: string, extra: Raw = {}) => t(id, { status: "complete", completedDate: DONE, ...extra });
const wd = (id: string, extra: Raw = {}) => done(id, { resolutionKind: WITHDRAWAL, ...extra });

const approved = checkpoint({ resolved: {} });
const retired = checkpoint({ lifecycle: "retired", events: ["created", "retired"] });
const pending = checkpoint({ resolved: null, generation: 1, events: ["created"] });

export interface BoardSpec {
  readonly name: string;
  readonly tickets: readonly Raw[];
}

export const BOARD_SPECS: readonly BoardSpec[] = [
  {
    name: "sidebar u2-3a",
    tickets: [
      t("T-001", { order: 1 }),
      done("T-002", { parentTicket: "T-001", order: 2 }),
      t("T-003", { parentTicket: "T-001", status: "inprogress", order: 3 }),
      done("T-004", { phase: "p2", order: 4 }),
      t("t-zz11yy22xx33ww44", { displayId: "T-005", phase: "p2", order: 5, blockedBy: ["T-003"] }),
      t("T-006", { phase: "p3", order: 6, blockedBy: ["T-999"] }),
      t("T-007", { phase: "p3", order: 7, lifecycle: "deleted" }),
      t("T-020", { order: 20 }),
      t("T-021", { order: 21, blockedBy: ["T-003"] }),
      done("T-022", { order: 22 }),
      t("t-aa11aa11aa11aa11", { displayId: "T-010", phase: "p3", order: 10 }),
      t("t-bb22bb22bb22bb22", { displayId: "T-010", phase: "p3", order: 11 }),
      t("t-cc33cc33cc33cc33", { displayId: "T-011", previousDisplayIds: ["T-010"], phase: "p3", order: 12 }),
      t("T-013", { parentTicket: "T-010", phase: "p3", order: 13 }),
    ],
  },
  {
    name: "duplicate id",
    tickets: [
      done("T-001"),
      t("T-001"),
      done("T-002"),
      t("T-003", { blockedBy: ["T-001"] }),
      t("T-004", { parentTicket: "T-001" }),
      done("T-005"),
      t("T-005"),
    ],
  },
  {
    name: "duplicated dependents",
    tickets: [t("T-009"), t("T-002", { blockedBy: ["T-009"] }), t("T-002", { blockedBy: ["T-009"] }), t("T-003", { blockedBy: ["T-009"] })],
  },
  {
    name: "id shadows displayId",
    // A renumbered legacy record: id T-020, current displayId T-099. The
    // canonical id wins over B's displayId, so A is the umbrella.
    tickets: [t("T-020", { displayId: "T-099" }), t("t-0000000000000a02", { displayId: "T-020" }), t("T-021", { parentTicket: "T-020" })],
  },
  {
    name: "ambiguous shadows alias",
    tickets: [
      t("t-0000000000000b01", { displayId: "T-010" }),
      t("t-0000000000000b02", { displayId: "T-010" }),
      t("t-0000000000000b03", { displayId: "T-012", previousDisplayIds: ["T-010"] }),
      t("T-013", { parentTicket: "T-010" }),
    ],
  },
  {
    name: "alias with no current holder",
    tickets: [t("t-0000000000000c01", { displayId: "T-031", previousDisplayIds: ["T-030"] }), done("T-032", { parentTicket: "T-030" })],
  },
  {
    name: "whitespace displayId parent",
    tickets: [t("t-0000000000000c11", { displayId: " T-040" }), t("T-041", { parentTicket: "T-040" })],
  },
  {
    name: "withdrawn and stale blockers",
    tickets: [
      wd("T-050"),
      t("T-051", { blockedBy: ["T-050"] }),
      wd("T-052", { completedDate: "2026-03-01" }),
      t("T-053", { blockedBy: ["T-052"] }),
      wd("T-054", { phase: "p2" }),
      done("T-055", { phase: "p2" }),
    ],
  },
  {
    name: "deleted blockers",
    tickets: [
      t("T-060", DEL),
      wd("T-061", DEL),
      done("T-062", { ownerCheckpoint: approved, ...DEL }),
      t("T-063", { blockedBy: ["T-060"] }),
      t("T-064", { blockedBy: ["T-061"] }),
      t("T-065", { blockedBy: ["T-062"] }),
    ],
  },
  {
    name: "umbrella withholds",
    tickets: [
      done("T-070"),
      wd("T-071", { parentTicket: "T-070" }),
      done("T-072", { parentTicket: "T-070" }),
      t("T-073", { blockedBy: ["T-070"] }),
      done("T-074"),
      done("T-075", { parentTicket: "T-074" }),
      wd("T-076", { parentTicket: "T-075" }),
      t("T-077", { blockedBy: ["T-074"] }),
      wd("T-078"),
      done("T-079", { parentTicket: "T-078" }),
      t("T-080", { blockedBy: ["T-078"] }),
      done("T-081"),
      done("T-082", { parentTicket: "T-081" }),
      t("T-083", { blockedBy: ["T-081"] }),
    ],
  },
  {
    name: "withheld in counted walk only",
    tickets: [
      t("t-0000000000000d01", { displayId: "T-050" }),
      t("t-0000000000000d01", { displayId: "T-050" }),
      done("t-0000000000000d02", { displayId: "T-050" }),
      wd("t-0000000000000d03", { displayId: "T-051", parentTicket: "T-050" }),
      t("T-070", { blockedBy: ["t-0000000000000d02"] }),
    ],
  },
  {
    name: "withheld in all-records walk only",
    tickets: [
      t("t-0000000000000d11", { displayId: "T-060" }),
      t("t-0000000000000d11", { displayId: "T-060" }),
      done("t-0000000000000d12", { displayId: "T-061" }),
      wd("t-0000000000000d14", { displayId: "T-060", parentTicket: "t-0000000000000d12" }),
      done("t-0000000000000d15", { displayId: "T-062", parentTicket: "T-060" }),
      t("T-080", { blockedBy: ["t-0000000000000d12"] }),
    ],
  },
  {
    // A withdrawn leaf in the counted list whose only child is a duplicated
    // record (all-records list only): one merged walk would descend through it.
    name: "merged walk masks leaf",
    tickets: [
      done("T-300"),
      wd("T-301", { parentTicket: "T-300" }),
      done("T-302", { parentTicket: "T-301" }),
      done("T-302", { parentTicket: "T-301" }),
      t("T-303", { blockedBy: ["T-300"] }),
    ],
  },
  {
    name: "archived withdrawals",
    tickets: [
      done("T-090"),
      wd("T-091", { parentTicket: "T-090", ...ARC }),
      t("T-092", { blockedBy: ["T-090"] }),
      done("T-093"),
      t("T-094", { parentTicket: "T-093" }),
      wd("T-095", { parentTicket: "T-094", ...ARC }),
      t("T-096", { blockedBy: ["T-093"] }),
      done("T-097"),
      done("T-098", { parentTicket: "T-097", ...ARC }),
      t("T-099", { blockedBy: ["T-097"] }),
    ],
  },
  {
    name: "deleted intermediates",
    tickets: [
      done("T-100"),
      done("T-101", { parentTicket: "T-100", ...DEL }),
      wd("T-102", { parentTicket: "T-101" }),
      t("T-103", { blockedBy: ["T-100"] }),
      done("T-110"),
      done("T-111", { parentTicket: "T-110", ...DEL }),
      done("T-112", { parentTicket: "T-111", ...DEL }),
      wd("T-113", { parentTicket: "T-112", ...DEL }),
      t("T-114", { blockedBy: ["T-110"] }),
      done("T-120"),
      done("T-121", { parentTicket: "T-120", ...DEL }),
      done("T-122", { parentTicket: "T-121", ...DEL }),
      t("T-123", { blockedBy: ["T-120"] }),
      done("T-124", { parentTicket: "T-121" }),
    ],
  },
  {
    name: "duplicate visits",
    tickets: [
      done("T-130"),
      done("T-131", { parentTicket: "T-130" }),
      wd("T-131", { parentTicket: "T-130" }),
      done("T-132", { parentTicket: "T-130" }),
      t("T-133", { blockedBy: ["T-130"] }),
    ],
  },
  {
    name: "umbrella in a cycle",
    tickets: [
      done("T-140", { parentTicket: "T-141" }),
      done("T-141", { parentTicket: "T-140" }),
      done("T-142", { parentTicket: "T-140" }),
      t("T-143", { blockedBy: ["T-140"] }),
      done("T-144"),
      done("T-145", { parentTicket: "T-144" }),
      t("T-146", { blockedBy: ["T-144"] }),
    ],
  },
  {
    name: "withheld beside cycle",
    tickets: [
      done("T-150", { parentTicket: "T-151" }),
      done("T-151", { parentTicket: "T-150" }),
      wd("T-152", { parentTicket: "T-150" }),
      t("T-153", { blockedBy: ["T-150"] }),
    ],
  },
  {
    name: "checkpoints",
    tickets: [
      done("T-160", { ownerCheckpoint: approved }),
      t("T-161", { ownerCheckpoint: retired }),
      done("T-162", { ownerCheckpoint: {} }),
      done("T-163", { ownerCheckpoint: null }),
      done("T-164", { ownerCheckpoint: pending }),
      t("T-165", { ownerCheckpoint: pending }),
      t("T-170", { blockedBy: ["T-160"] }),
      t("T-171", { blockedBy: ["T-161"] }),
      t("T-172", { blockedBy: ["T-162"] }),
      t("T-173", { blockedBy: ["T-163"] }),
      t("T-174", { blockedBy: ["T-164"] }),
      done("T-175", { blockedBy: ["T-164"] }),
      wd("T-176", { ownerCheckpoint: approved }),
      // Stored status, not derivesComplete, decides blockedCount.
      done("T-177", { ownerCheckpoint: pending, blockedBy: ["T-165"] }),
    ],
  },
  {
    // Stored open, derives complete: still counted as blocked.
    name: "retired checkpoint stored open",
    tickets: [t("T-185", { ownerCheckpoint: pending }), t("T-186", { ownerCheckpoint: retired, blockedBy: ["T-185"] })],
  },
  {
    name: "checkpoint progress",
    tickets: [
      t("T-180"),
      done("T-181", { parentTicket: "T-180", ownerCheckpoint: pending }),
      t("T-182", { parentTicket: "T-180", ownerCheckpoint: retired }),
      done("T-183", { parentTicket: "T-180" }),
      t("T-184", { parentTicket: "T-180", ownerCheckpoint: retired }),
    ],
  },
  {
    name: "mixed siblings",
    tickets: [
      done("T-190"),
      t("T-191", { parentTicket: "T-190" }),
      done("T-192", { parentTicket: "T-190", ...DEL }),
      done("T-193", { parentTicket: "T-190", ...ARC }),
      t("T-199", { blockedBy: ["T-190"] }),
    ],
  },
  {
    name: "archived intermediate",
    tickets: [t("T-200"), done("T-201", { parentTicket: "T-200", ...ARC }), done("T-202", { parentTicket: "T-201" }), t("T-203", { parentTicket: "T-200" })],
  },
];

export const DATE_CASES: readonly string[] = [
  "2026-02-28", "2026-02-29", "2024-02-29", "1900-02-29", "2000-02-29", "0000-02-29", "0000-01-01",
  "9999-12-31", "2026-13-01", "2026-00-10", "2026-04-31", "2026-04-30", "2026-1-01", "2026-02-01T00", "",
];

const roadmap = RoadmapSchema.parse({
  title: "vectors",
  date: "2026-01-01",
  phases: [
    { id: "p1", label: "P1", name: "One", description: "" },
    { id: "p2", label: "P2", name: "Two", description: "" },
    { id: "p3", label: "P3", name: "Three", description: "" },
  ],
  blockers: [],
});
const config = ConfigSchema.parse({
  version: 2, project: "vectors", type: "npm", language: "TypeScript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
});

function progressOf(leaves: readonly Ticket[]) {
  const complete = leaves.filter((x) => x.status === "complete");
  return { total: leaves.length, complete: complete.length, withdrawn: complete.filter((x) => isEffectivelyWithdrawn(x)).length };
}

function buildBoard(spec: BoardSpec) {
  const tickets = spec.tickets.map((r) => TicketSchema.parse(r)) as Ticket[];
  const state = new ProjectState({ tickets, issues: [], notes: [], roadmap, config, handoverFilenames: [] });
  const phases: Raw = {};
  for (const phase of ["p1", "p2", "p3"]) {
    phases[phase] = { status: state.phaseStatus(phase), ...progressOf(state.countedPhaseTickets(phase)) };
  }
  const umbrellas: Raw = {};
  for (const id of [...state.umbrellaIDs].sort()) {
    const p = umbrellaProgress(id, state);
    if (p) umbrellas[id] = { status: p.status, total: p.total, complete: p.complete, withdrawn: p.withdrawn ?? 0 };
  }
  return {
    name: spec.name,
    tickets: spec.tickets,
    expected: {
      counts: {
        leaf: state.leafTicketCount,
        terminal: state.completeLeafTicketCount,
        delivered: state.deliveredLeafTicketCount,
        withdrawn: state.withdrawnLeafTicketCount,
        active: state.openTicketCount,
        blocked: state.blockedCount,
      },
      umbrellaIds: [...state.umbrellaIDs].sort(),
      blockedIds: blockedTickets(state).map((x) => x.id),
      phases,
      umbrellas,
      releases: tickets.map((x) => {
        const r = state.dependencyRelease(x);
        return { id: x.id, releases: r.releases, reason: r.reason, detail: [...r.detail] };
      }),
    },
  };
}

export function buildVectors() {
  return {
    generatedBy: "scripts/ticket-count-vectors.ts",
    dates: DATE_CASES.map((value) => ({ value, valid: DateSchema.safeParse(value).success })),
    boards: BOARD_SPECS.map(buildBoard),
  };
}

export function serializeVectors(): string {
  return JSON.stringify(buildVectors(), null, 2) + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--stdout")) process.stdout.write(serializeVectors());
  else writeFileSync(VECTORS_OUT, serializeVectors());
}
