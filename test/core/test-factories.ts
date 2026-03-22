import { ProjectState } from "../../src/core/project-state.js";
import type { Ticket } from "../../src/models/ticket.js";
import type { Issue } from "../../src/models/issue.js";
import type { Note } from "../../src/models/note.js";
import type { Roadmap, Phase } from "../../src/models/roadmap.js";
import type { Config } from "../../src/models/config.js";

export function makeTicket(
  overrides: Partial<Ticket> & { id: string },
): Ticket {
  return {
    title: `Test ${overrides.id}`,
    description: "Test ticket.",
    type: "task",
    status: "open",
    phase: "p1",
    order: 10,
    createdDate: "2026-03-11",
    completedDate: null,
    blockedBy: [],
    ...overrides,
  } as Ticket;
}

export function makeIssue(
  overrides: Partial<Issue> & { id: string },
): Issue {
  return {
    title: `Test ${overrides.id}`,
    status: "open",
    severity: "medium",
    components: [],
    impact: "Test.",
    resolution: null,
    location: [],
    discoveredDate: "2026-03-11",
    resolvedDate: null,
    relatedTickets: [],
    ...overrides,
  } as Issue;
}

export function makeNote(
  overrides: Partial<Note> & { id: string },
): Note {
  return {
    title: `Test ${overrides.id}`,
    content: "Test note content.",
    tags: [],
    status: "active",
    createdDate: "2026-03-20",
    updatedDate: "2026-03-20",
    ...overrides,
  } as Note;
}

export function makePhase(
  overrides: Partial<Phase> & { id: string },
): Phase {
  return {
    label: overrides.id.toUpperCase(),
    name: `Phase ${overrides.id}`,
    description: `Description for ${overrides.id}.`,
    ...overrides,
  } as Phase;
}

export const emptyRoadmap: Roadmap = {
  title: "test",
  date: "2026-03-11",
  phases: [],
  blockers: [],
};

export const minimalConfig: Config = {
  version: 2,
  project: "test",
  type: "macapp",
  language: "swift",
  features: {
    tickets: true,
    issues: true,
    handovers: true,
    roadmap: true,
    reviews: true,
  },
};

export function makeRoadmap(phases: Phase[]): Roadmap {
  return { ...emptyRoadmap, phases };
}

export function makeState(
  opts: {
    tickets?: Ticket[];
    issues?: Issue[];
    notes?: Note[];
    roadmap?: Roadmap;
    handoverFilenames?: string[];
  } = {},
): ProjectState {
  return new ProjectState({
    tickets: opts.tickets ?? [],
    issues: opts.issues ?? [],
    notes: opts.notes ?? [],
    roadmap: opts.roadmap ?? emptyRoadmap,
    config: minimalConfig,
    handoverFilenames: opts.handoverFilenames ?? [],
  });
}
