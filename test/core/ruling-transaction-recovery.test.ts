/**
 * T-494: what a ruling create says when it fails AFTER the commit began.
 *
 * The pinned plan (section 7) requires that a post-commit failure "reports an
 * uncertain, recovery-pending outcome by name" and does not claim nothing was
 * written. It shipped without that, and the gap is not cosmetic: the generic
 * "Transaction failed" tells a caller nothing, the obvious response to it is to
 * retry the create, and a retry writes a SECOND ruling beside the one that
 * `doRecoverTransaction` is about to complete at the next lock acquisition.
 * With items-first ordering the citations already on disk name the FIRST id, so
 * the retry's ruling is the one nothing cites.
 *
 * The failure is injected at `rename`, which is the only operation in the
 * commit loop, and only for a path under `.story/tickets/` -- so the journal
 * writes (which use `open`/`writeFile`, not `rename`) and every other file
 * operation in the run are untouched.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const inject = vi.hoisted(() => ({
  armed: false,
  only: null as string | null,
  /**
   * Path fragment whose successful rename should CORRUPT the project lock, so
   * the NEXT commit-loop iteration's fencing check throws. Fires once.
   */
  corruptLockAfter: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: async (from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
      const dest = String(to).replace(/\\/g, "/");
      const targeted = inject.only === null
        ? dest.includes("/.story/tickets/")
        : dest.includes(inject.only);
      if (inject.armed && targeted) {
        throw Object.assign(new Error("EIO: injected commit-phase failure"), { code: "EIO" });
      }
      const done = await actual.rename(from, to);
      if (inject.corruptLockAfter !== null && dest.includes(inject.corruptLockAfter)) {
        // Same mechanism `project-lock.test.ts` uses: invalidate the token so
        // `verifyProjectLockOwnership` fails. Doing it AFTER a successful
        // rename is what makes the resulting throw a post-commit one.
        inject.corruptLockAfter = null;
        const lockPath = `${dest.slice(0, dest.indexOf("/.story/"))}/.story/.lock`;
        const body = JSON.parse(await actual.readFile(lockPath, "utf-8")) as Record<string, unknown>;
        await actual.writeFile(lockPath, JSON.stringify({ ...body, token: "corrupted-for-test" }));
      }
      return done;
    },
  };
});

const { initProject } = await import("../../src/core/init.js");
const { handleTicketCreate } = await import("../../src/cli/commands/ticket.js");
const { handleRulingCreate } = await import("../../src/cli/commands/ruling.js");
const { loadProject } = await import("../../src/core/project-loader.js");

const tmpDirs: string[] = [];
afterEach(async () => {
  inject.armed = false;
  inject.only = null;
  inject.corruptLockAfter = null;
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newTicket(root: string, title: string): Promise<string> {
  const created = await handleTicketCreate(
    { title, type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    root,
  );
  return JSON.parse(created.output).data.id as string;
}

async function projectWithTicket(): Promise<{ root: string; ticketId: string }> {
  const root = await mkdtemp(join(tmpdir(), "ruling-txn-"));
  tmpDirs.push(root);
  await initProject(root, { name: "test" });
  return { root, ticketId: await newTicket(root, "Cited") };
}

async function create(root: string, cites: string[]): Promise<void> {
  await handleRulingCreate(
    {
      text: "Owner ruling: recorded once.",
      attribution: "owner-direct",
      date: "2026-09-06",
      scopeTags: [],
      cites,
      clientTaskId: "txn-test",
    },
    "json",
    root,
  );
}

describe("T-494: a ruling create that fails after the commit began", () => {
  it("names the ruling id and says recovery is pending, instead of `Transaction failed`", async () => {
    const { root, ticketId } = await projectWithTicket();
    inject.armed = true;

    const err = await create(root, [ticketId]).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).not.toBeNull();
    const message = err!.message;
    // The id is the only handle the operator has on what recovery completes.
    expect(message).toMatch(/\br-[0-9a-z]+\b/);
    expect(message).toContain("recovery is pending");
    expect(message).toContain("Do NOT retry");
    // The underlying failure survives the translation: an operator responds
    // differently to an I/O error than to a lost lock.
    expect(message).toContain("injected commit-phase failure");
    // The exact claim the plan forbids.
    expect(message).not.toBe("Transaction failed");
  });

  it("still fails GENERICALLY when the failure happened before any rename", async () => {
    // The contrast that makes the test above discriminating: a pre-commit
    // failure wrote nothing, a retry IS the right response, and it must not be
    // dressed up as a recovery-pending outcome.
    const { root } = await projectWithTicket();
    const err = await create(root, ["T-99999"]).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("recovery is pending");
  });
});

describe("T-494: what forward recovery actually completes", () => {
  it("completes the reported ruling AND every citation, so the message is true", async () => {
    // The message tells an operator not to retry because recovery will finish
    // the job. That is a CLAIM, and the earlier test only checked the wording.
    // This one runs the recovery.
    const root = await mkdtemp(join(tmpdir(), "ruling-txn-recover-"));
    tmpDirs.push(root);
    await initProject(root, { name: "test" });
    const first = await newTicket(root, "First");
    const second = await newTicket(root, "Second");

    // Fail the SECOND item's rename only, so the commit is genuinely partial:
    // one target renamed, the rest (including the ruling) still pending.
    inject.only = second;
    inject.armed = true;
    const err = await create(root, [first, second]).then(() => null, (e: Error) => e);
    expect(err).not.toBeNull();
    const rulingId = /\b(r-[0-9a-z]+)\b/.exec(err!.message)?.[1];
    expect(rulingId).toBeTruthy();

    // Recovery runs at the next lock acquisition, which loadProject takes.
    inject.armed = false;
    const { state } = await loadProject(root);

    const { loadRulingsSafe } = await import("../../src/core/ruling-loader.js");
    const { rulings } = loadRulingsSafe(root);
    expect(rulings.map((r) => r.id)).toContain(rulingId);
    // Exactly one: recovery COMPLETES the pending transaction, it does not
    // replay it, so nothing is written twice.
    expect(rulings).toHaveLength(1);
    for (const id of [first, second]) {
      const t = state.resolveTicketRef(id);
      expect(t.kind).toBe("found");
      expect(t.kind === "found" ? t.item.citesRulings : []).toContain(rulingId);
    }
  });
});

describe("T-494: a post-commit failure that is itself a ProjectLoaderError", () => {
  it("still reports recovery-pending when LOCK OWNERSHIP is lost mid-commit", async () => {
    // The case the ordering bug actually reached, and the one an injected EIO
    // cannot cover: mid-commit fencing throws a ProjectLoaderError from inside
    // the rename loop, so a passthrough placed ahead of the phase check sends
    // it out as "write was not applied" -- no ruling id, no do-not-retry -- in
    // precisely the situation where a retry duplicates the ruling.
    const root = await mkdtemp(join(tmpdir(), "ruling-txn-fence-"));
    tmpDirs.push(root);
    await initProject(root, { name: "test" });
    const first = await newTicket(root, "First");
    const second = await newTicket(root, "Second");

    inject.corruptLockAfter = first;
    const err = await create(root, [first, second]).then(() => null, (e: Error) => e);

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/\br-[0-9a-z]+\b/);
    expect(err!.message).toContain("recovery is pending");
    expect(err!.message).toContain("Do NOT retry");
    expect(err!.message).toContain("Lock ownership lost");
  });
});
