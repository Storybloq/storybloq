/**
 * ISS-1452: past Number.MAX_SAFE_INTEGER an id's number rounds through a double,
 * so an allocator would mint an id with no relation to its predecessor. The
 * allocators refuse instead, without writing. At the limit itself there is no
 * safe next number.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allocateTeamTicketId, allocateTeamIssueId, allocateTeamNoteId, allocateTeamLessonId, maxSequentialNumber, nextTicketID, TICKET_NUMERIC_REGEX } from "../../src/core/id-allocation.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { E2ECliFixture, parseE2EJson, runE2ECli } from "../helpers/e2e-cli.js";
import { makeTicket } from "./test-factories.js";

const LIMIT = String(Number.MAX_SAFE_INTEGER);
const JUST_BELOW = String(Number.MAX_SAFE_INTEGER - 1);
const REFUSED = [LIMIT, "9007199254740992", "9223372036854775807", "1".repeat(30), "9".repeat(400)];

let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

const KINDS = [
  { dir: "tickets", prefix: "T-", create: ["ticket", "create", "--title", "New", "--type", "task"] },
  { dir: "issues", prefix: "ISS-", create: ["issue", "create", "--title", "New", "--severity", "low", "--impact", "None"] },
  { dir: "notes", prefix: "N-", create: ["note", "create", "--content", "New"] },
  { dir: "lessons", prefix: "L-", create: ["lesson", "create", "--title", "New", "--content", "New", "--context", "New", "--source", "manual"] },
] as const;

function project(): string {
  const root = mkdtempSync(join(fixture.root, "iss1452-"));
  const init = runE2ECli(fixture, ["init", "--name", "probe"], { cwd: root });
  expect(init.status, init.stderr).toBe(0);
  return root;
}

/** Creates one real record, then renumbers it, so the fixture is what the CLI itself writes. */
function seed(root: string, kind: (typeof KINDS)[number], number: string): void {
  const made = runE2ECli(fixture, [...kind.create, "--format", "json"], { cwd: root });
  expect(made.status, made.stderr).toBe(0);
  const dir = join(root, ".story", kind.dir);
  const [file] = readdirSync(dir).filter((name) => name.endsWith(".json"));
  const record = JSON.parse(readFileSync(join(dir, file!), "utf-8")) as { id: string };
  record.id = `${kind.prefix}${number}`;
  writeFileSync(join(dir, file!), JSON.stringify(record, null, 2) + "\n");
  // Past 255 bytes a file cannot carry the id in its name.
  renameSync(join(dir, file!), join(dir, record.id.length > 200 ? "old.json" : `${record.id}.json`));
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, Object.fromEntries(Object.entries(tree(path)).map(([k, v]) => [`${name}/${k}`, v])));
    else out[name] = readFileSync(path, "utf-8");
  }
  return out;
}

const stories = (root: string): Record<string, string> => {
  const all = tree(join(root, ".story"));
  // Snapshots and session state are not the ledger; a refusal is about records.
  return Object.fromEntries(Object.entries(all).filter(([k]) => /^(tickets|issues|notes|lessons)\//.test(k)));
};

describe.each(KINDS)("$dir through the CLI", (kind) => {
  it.each(REFUSED)("a record numbered %s refuses and writes nothing", (number) => {
    const root = project();
    seed(root, kind, number);
    const before = stories(root);
    const out = runE2ECli(fixture, [...kind.create], { cwd: root });
    expect(out.status, out.stdout).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain(`Cannot allocate an id: ${kind.prefix}${number} holds an id whose number is too large`);
    expect(stories(root)).toEqual(before);
  });

  it("the number just below the limit still allocates the limit", () => {
    const root = project();
    seed(root, kind, JUST_BELOW);
    const out = runE2ECli(fixture, [...kind.create, "--format", "json"], { cwd: root });
    expect(out.status, out.stderr).toBe(0);
    expect(parseE2EJson<{ data: { id: string } }>(out).data.id).toBe(`${kind.prefix}${LIMIT}`);
    expect(readdirSync(join(root, ".story", kind.dir))).toContain(`${kind.prefix}${LIMIT}.json`);
  });
});

describe("the allocators directly", () => {
  const refusal = { code: "conflict" };
  const catching = (run: () => unknown): unknown => {
    try {
      run();
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it("the refusal is the typed conflict error", () => {
    const err = catching(() => nextTicketID([makeTicket({ id: `T-${LIMIT}` })]));
    expect(err).toBeInstanceOf(ProjectLoaderError);
    expect(err).toMatchObject(refusal);
  });

  it("a suffixed id counts by its number", () => {
    expect(catching(() => nextTicketID([makeTicket({ id: `T-${LIMIT}a` })]))).toMatchObject(refusal);
    expect(nextTicketID([makeTicket({ id: `T-${JUST_BELOW}a` })])).toBe(`T-${LIMIT}`);
  });

  it.each([
    ["displayId", { id: "t-0000000000000001", displayId: `T-${LIMIT}` }],
    ["previousDisplayIds", { id: "t-0000000000000001", displayId: "T-001", previousDisplayIds: [`T-${LIMIT}`] }],
  ])("the team allocator refuses a number held in %s", (_label, fields) => {
    const items = [makeTicket(fields as never)];
    expect(catching(() => allocateTeamTicketId(items))).toMatchObject(refusal);
    expect(catching(() => maxSequentialNumber(items, TICKET_NUMERIC_REGEX))).toMatchObject(refusal);
  });

  it("every team allocator refuses and the value just below allocates", () => {
    for (const [allocate, prefix] of [[allocateTeamTicketId, "T-"], [allocateTeamIssueId, "ISS-"], [allocateTeamNoteId, "N-"], [allocateTeamLessonId, "L-"]] as const) {
      const run = allocate as (items: never) => { displayId: string };
      expect(catching(() => run([{ id: "x", displayId: `${prefix}${LIMIT}` }] as never))).toMatchObject(refusal);
      expect(run([{ id: "x", displayId: `${prefix}${JUST_BELOW}` }] as never).displayId).toBe(`${prefix}${LIMIT}`);
    }
  });
});
