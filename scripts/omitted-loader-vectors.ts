#!/usr/bin/env tsx
/**
 * Writes `test/fixtures/omitted-loader-vectors.json` (ISS-1384): ticket
 * directories the CLI's loader and the Mac app's loader both read, with what
 * `loadProject` records for each file it leaves out (T-486 U2-3), in its
 * order, the files it warns about, and every accepted record's dependency
 * release. Every expected value comes from the CLI code; a drift test
 * regenerates the file in memory and compares.
 *
 * Deterministic on purpose: nothing here depends on file permissions or the
 * running user. The unreadable-file case is a separate probe on each side.
 *
 * Every case pairs at least one complete accepted blocker with an open
 * accepted dependent that waits on it, and the generator refuses a case
 * without them, so no release comparison can pass on an empty board.
 *
 * Usage:
 *   tsx scripts/omitted-loader-vectors.ts            # write the file
 *   tsx scripts/omitted-loader-vectors.ts --stdout   # print it
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../src/core/project-loader.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VECTORS_OUT = join(pkgRoot, "test", "fixtures", "omitted-loader-vectors.json");

/** A ticket file with its exact content, or a directory standing where a ticket file is listed. */
export type TicketEntry = { readonly name: string; readonly content: string } | { readonly name: string; readonly directory: true };

export interface LoaderCase {
  readonly name: string;
  /** Entries under `.story/tickets/`, created in this order. */
  readonly entries: readonly TicketEntry[];
  /** [blocker, dependent]: a complete accepted blocker and an open accepted dependent waiting on it. */
  readonly pairs: readonly (readonly [string, string])[];
}

export const CONFIG = JSON.stringify({
  version: 2, project: "vectors", type: "npm", language: "TypeScript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
}, null, 2) + "\n";
export const ROADMAP = JSON.stringify({
  title: "vectors", date: "2026-01-01",
  phases: [{ id: "p1", label: "P1", name: "One", description: "" }],
  blockers: [],
}, null, 2) + "\n";

function ticket(id: string, extra: Record<string, unknown> = {}): TicketEntry {
  const record = {
    id, title: id, description: "", type: "task", status: "open", phase: "p1", order: 10,
    createdDate: "2026-01-01", completedDate: null, blockedBy: [], ...extra,
  };
  return { name: `${id}.json`, content: JSON.stringify(record, null, 2) + "\n" };
}
const done = (id: string, extra: Record<string, unknown> = {}) => ticket(id, { status: "complete", completedDate: "2026-02-01", ...extra });
const raw = (name: string, content: string): TicketEntry => ({ name, content });
/** A record the ticket schema refuses (`title` is a number), with the given extra keys. */
const refused = (name: string, extra: Record<string, unknown>): TicketEntry => raw(name, JSON.stringify({ ...extra, title: 7 }) + "\n");

/** The blocker T-401 and its dependent T-402, beside the file under test. */
const PAIR = [done("T-401"), ticket("T-402", { blockedBy: ["T-401"] })];
const pairCase = (name: string, file: TicketEntry): LoaderCase => ({ name, entries: [...PAIR, file], pairs: [["T-401", "T-402"]] });

const PARENTS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["string parentTicket", { parentTicket: "T-401" }],
  ["null parentTicket", { parentTicket: null }],
  ["no parentTicket", {}],
  ["numeric parentTicket", { parentTicket: 5 }],
];

export const LOADER_CASES: readonly LoaderCase[] = [
  pairCase("invalid json", raw("T-409.json", "{ not json\n")),
  pairCase("json fragment", raw("T-409.json", "7\n")),
  pairCase("json array", raw("T-409.json", "[]\n")),
  ...PARENTS.flatMap(([label, parent]) => [
    pairCase(`schema, ${label}, with id`, refused("T-409.json", { id: "T-409", ...parent })),
    pairCase(`schema, ${label}, no id`, refused("T-409.json", parent)),
  ]),
  pairCase("schema, numeric id", refused("T-409.json", { id: 409, parentTicket: "T-401" })),
  pairCase("directory entry", { name: "T-409.json", directory: true }),
  {
    // Holds the umbrella the refused record names, releases an unrelated leaf.
    name: "selective parentage",
    entries: [
      done("T-430"), ticket("T-431", { blockedBy: ["T-430"] }),
      done("T-432"), ticket("T-433", { blockedBy: ["T-432"] }),
      refused("T-439.json", { id: "T-439", parentTicket: "T-430" }),
    ],
    pairs: [["T-430", "T-431"], ["T-432", "T-433"]],
  },
  {
    // Created in the reverse of the CLI's order. JavaScript sorts by UTF-16
    // code unit, so U+10000 (a surrogate pair, 0xD800 first) sorts before
    // U+E000; Unicode scalar order puts it after.
    name: "filename order",
    entries: [
      done("T-440"), ticket("T-441", { blockedBy: ["T-440"] }),
      refused("T-\u{E000}.json", { parentTicket: "T-440" }),
      refused("T-\u{10000}.json", { parentTicket: "T-440" }),
      refused("T-b.json", { parentTicket: "T-440" }),
      refused("T-a.json", { parentTicket: "T-440" }),
    ],
    pairs: [["T-440", "T-441"]],
  },
];

function requirePairs(c: LoaderCase, accepted: readonly { id: string; status: string; blockedBy: readonly string[] }[]): void {
  if (c.pairs.length === 0) throw new Error(`${c.name}: no blocker and dependent`);
  for (const [blocker, dependent] of c.pairs) {
    const b = accepted.filter((x) => x.id === blocker);
    const d = accepted.filter((x) => x.id === dependent);
    if (b.length !== 1 || b[0]!.status !== "complete") throw new Error(`${c.name}: ${blocker} is not one complete accepted record`);
    if (d.length !== 1 || d[0]!.status === "complete" || !d[0]!.blockedBy.includes(blocker)) {
      throw new Error(`${c.name}: ${dependent} is not one open accepted record waiting on ${blocker}`);
    }
  }
}

async function buildCase(c: LoaderCase) {
  const root = mkdtempSync(join(tmpdir(), "omitted-loader-"));
  try {
    const story = join(root, ".story");
    mkdirSync(join(story, "tickets"), { recursive: true });
    writeFileSync(join(story, "config.json"), CONFIG);
    writeFileSync(join(story, "roadmap.json"), ROADMAP);
    for (const e of c.entries) {
      const path = join(story, "tickets", e.name);
      if ("directory" in e) mkdirSync(path);
      else writeFileSync(path, e.content);
    }
    const { state, warnings } = await loadProject(root);
    requirePairs(c, state.tickets);
    return {
      name: c.name,
      entries: c.entries,
      pairs: c.pairs,
      expected: {
        omitted: state.omittedTickets,
        warningFiles: warnings.map((w) => w.file),
        releases: state.tickets.map((x) => {
          const r = state.dependencyRelease(x);
          return { id: x.id, releases: r.releases, reason: r.reason, detail: [...r.detail] };
        }),
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function buildVectors() {
  const cases = [];
  for (const c of LOADER_CASES) cases.push(await buildCase(c));
  return { generatedBy: "scripts/omitted-loader-vectors.ts", config: CONFIG, roadmap: ROADMAP, cases };
}

export async function serializeVectors(): Promise<string> {
  return JSON.stringify(await buildVectors(), null, 2) + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await serializeVectors();
  if (process.argv.includes("--stdout")) process.stdout.write(text);
  else writeFileSync(VECTORS_OUT, text);
}
