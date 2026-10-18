/**
 * ISS-1297: git keeps no empty directories, so a fresh clone of a project with
 * no issues (or no tickets) yet has no `.story/issues/` (or `.story/tickets/`).
 * The first create must make the directory, under a `.story` whose real path
 * was checked, and a root reached through a symlink must not be called an
 * escape. The directory is made between two containment checks, so a symlink
 * swapped in before the mkdir is refused; a swap after the second check is a
 * named residual (no handle-relative writes).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import {
  entityDirSeams,
  prepareIssueWrite,
  prepareTicketWrite,
  withProjectLock,
} from "../../src/core/project-loader.js";
import { ProjectLoaderError } from "../../src/core/errors.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import type { Issue } from "../../src/models/issue.js";
import type { Ticket } from "../../src/models/ticket.js";

let base: string;
let real: string;
let link: string;
let outside: string;

const defaultSeams = { ...entityDirSeams };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "iss1297-")));
  real = join(base, "real");
  mkdirSync(real);
  link = join(base, "link");
  symlinkSync(real, link);
  outside = join(base, "outside");
  mkdirSync(outside);
});

afterEach(() => {
  Object.assign(entityDirSeams, defaultSeams);
  rmSync(base, { recursive: true, force: true });
});

const issueInput = { title: "a bug", severity: "medium", impact: "it breaks", components: [], relatedTickets: [], location: [] };
const ticketInput = { title: "a task", type: "task", phase: null, description: "", blockedBy: [], parentTicket: null };

const families = [
  {
    family: "issues",
    create: async (root: string) => JSON.parse((await handleIssueCreate(issueInput, "json", root)).output) as { data: { id: string } },
    prepare: (root: string) => prepareIssueWrite(validIssue as Issue, root),
    file: "ISS-001.json",
  },
  {
    family: "tickets",
    create: async (root: string) => JSON.parse((await handleTicketCreate(ticketInput, "json", root)).output) as { data: { id: string } },
    prepare: (root: string) => prepareTicketWrite(validTicket as Ticket, root),
    file: "T-001.json",
  },
] as const;

const validIssue = {
  id: "ISS-001",
  title: "Test issue",
  status: "open",
  severity: "medium",
  components: ["core"],
  impact: "Test impact.",
  resolution: null,
  location: ["file.ts:1"],
  discoveredDate: "2026-01-01",
  resolvedDate: null,
  relatedTickets: [],
};

const validTicket = {
  id: "T-001",
  title: "Test ticket",
  description: "A test.",
  type: "task",
  status: "open",
  phase: "p1",
  order: 10,
  createdDate: "2026-01-01",
  completedDate: null,
  blockedBy: [],
};

async function freshProject(root: string, family: string): Promise<void> {
  await initProject(root, { name: "iss1297" });
  rmSync(join(real, ".story", family), { recursive: true, force: true });
  expect(existsSync(join(real, ".story", family))).toBe(false);
}

async function created<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    return expect.fail(`the create threw: ${String(err)}`);
  }
}

async function rejection(run: () => Promise<unknown>): Promise<ProjectLoaderError> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, "the preparer did not refuse").toBeInstanceOf(ProjectLoaderError);
  return caught as ProjectLoaderError;
}

describe("ISS-1297: the first create in a clone makes its directory", () => {
  for (const f of families) {
    for (const which of ["real", "link"] as const) {
      it(`${f.family}: the first create works on a ${which} root with the directory missing`, async () => {
        const root = which === "real" ? real : link;
        await freshProject(root, f.family);
        const first = await created(() => f.create(root));
        const second = await created(() => f.create(root));
        const files = readdirSync(join(real, ".story", f.family)).filter((n) => n.endsWith(".json"));
        expect(files).toContain(`${first.data.id}.json`);
        expect(files).toContain(`${second.data.id}.json`);
        expect(second.data.id).not.toBe(first.data.id);
      });
    }
  }
});

describe("ISS-1297: the directory is made between two containment checks", () => {
  for (const f of families) {
    it(`${f.family}: a symlink to an outside directory swapped in before the mkdir is refused`, async () => {
      await freshProject(real, f.family);
      entityDirSeams.afterGuard = async (dir: string) => {
        symlinkSync(outside, dir);
      };
      const err = await rejection(() => withProjectLock(real, { strict: true }, async () => { await f.prepare(real); }));
      expect(err.code).toBe("invalid_input");
      expect(err.message).toContain("resolves outside project root");
      expect(readdirSync(outside)).toEqual([]);
    });

    it(`${f.family}: a regular file where the directory belongs is an io_error naming the directory`, async () => {
      await freshProject(real, f.family);
      const occupant = join(real, ".story", f.family);
      // Placed once the lock has loaded the project: a file there would make
      // the load itself refuse, before any write is prepared.
      const err = await rejection(() => withProjectLock(real, { strict: true }, async () => {
        writeFileSync(occupant, "not a directory");
        await f.prepare(real);
      }));
      expect(err.code).toBe("io_error");
      expect(err.message).toContain(`Cannot create the directory ${occupant}`);
      expect(["EEXIST", "ENOTDIR"]).toContain((err.cause as NodeJS.ErrnoException | undefined)?.code);
      expect(readFileSync(occupant, "utf-8")).toBe("not a directory");
      expect(existsSync(join(occupant, f.file))).toBe(false);
    });

    it(`${f.family}: an EACCES from the mkdir is an io_error carrying it`, async () => {
      await freshProject(real, f.family);
      const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      entityDirSeams.mkdir = async () => { throw denied; };
      const err = await rejection(() => withProjectLock(real, { strict: true }, async () => { await f.prepare(real); }));
      expect(err.code).toBe("io_error");
      expect(err.message).toContain(`Cannot create the directory ${join(real, ".story", f.family)}`);
      expect(err.cause).toBe(denied);
      expect(existsSync(join(real, ".story", f.family, f.file))).toBe(false);
    });
  }

  it("the default mkdir seam is the filesystem's", () => {
    expect(defaultSeams.mkdir).toBe(mkdir);
  });
});
