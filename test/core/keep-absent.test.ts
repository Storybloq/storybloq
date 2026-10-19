/**
 * ISS-1397: `--keep-absent <field>` on `ticket update` and `issue update`.
 *
 * The Mac app sends every field on an edit, so a field the CLI-written file
 * never had comes back as its absent-equivalent (a null parentTicket or
 * phase, an order of 0). With the option, the CLI leaves such a key absent,
 * deciding under the project lock from the stored record. A present key and a
 * real change are written as before, and without the option a passed flag is
 * saved exactly as today.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { initProject } from "../../src/core/init.js";
import { withProjectLock } from "../../src/core/project-loader.js";
import { handleTicketCreate, handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { handleIssueCreate, handleIssueUpdate } from "../../src/cli/commands/issue.js";
import { registerIssueCommand, registerTicketCommand } from "../../src/cli/register.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keep-absent-"));
  tmpDirs.push(root);
  await initProject(root, { name: "test" });
  return root;
}

const ticketPath = (root: string, id = "T-001") => join(root, ".story", "tickets", `${id}.json`);
const issuePath = (root: string) => join(root, ".story", "issues", "ISS-001.json");

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, "utf-8")) as Json;
}

/** Sets or (with `undefined`) removes `key`, keeping the CLI's file form. */
async function setKey(path: string, key: string, value: unknown): Promise<void> {
  const record = await readJson(path);
  if (value === undefined) delete record[key];
  else record[key] = value;
  const sorted = Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** A ticket as the CLI creates it: no parentTicket key. */
async function cliTicket(root: string, id = "T-001"): Promise<string> {
  await handleTicketCreate(
    { title: "A", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    root,
  );
  const path = ticketPath(root, id);
  expect(Object.hasOwn(await readJson(path), "parentTicket")).toBe(false);
  return path;
}

/** An issue as the CLI creates it, with its phase removed: no order, no phase. */
async function cliIssue(root: string): Promise<string> {
  await handleIssueCreate(
    { title: "B", severity: "medium", impact: "imp", components: [], relatedTickets: [], location: [], phase: "p0" },
    "json",
    root,
  );
  const path = issuePath(root);
  await setKey(path, "phase", undefined);
  const record = await readJson(path);
  expect(Object.hasOwn(record, "order")).toBe(false);
  expect(Object.hasOwn(record, "phase")).toBe(false);
  return path;
}

/** A write-boundary spy: the write path calls it on the final bytes, and it counts the calls. */
function writeSpy(): { calls: number; validatePreparedContent: () => void } {
  const spy = {
    calls: 0,
    validatePreparedContent: () => {
      spy.calls += 1;
    },
  };
  return spy;
}

function dataOf(output: string): Json {
  return (JSON.parse(output) as { data: Json }).data;
}

/** Everything but updatedDate, which a write stamps. */
function withoutStamp(record: Json): Json {
  const { updatedDate: _stamp, ...rest } = record;
  return rest;
}

/**
 * A real write backfills displayId on a legacy display-id record that lacks
 * it. Only that key, only when `before` lacked it, and only with the record's
 * own id, is carried into the expected record.
 */
function withBackfill(before: Json, after: Json, expected: Json, id: string): Json {
  if (Object.hasOwn(before, "displayId") || !Object.hasOwn(after, "displayId")) return expected;
  expect(after.displayId).toBe(id);
  return { ...expected, displayId: after.displayId };
}

describe("ISS-1397 --keep-absent: an absent key with its absent-equivalent stays absent", () => {
  it("K1: a ticket with no parentTicket, sent null with the option, is not written at all", async () => {
    const root = await project();
    const path = await cliTicket(root);
    const before = await readFile(path, "utf-8");
    const spy = writeSpy();

    const result = await handleTicketUpdate("T-001", { parentTicket: null }, "json", root, false, {
      keepAbsent: ["parentTicket"],
      validatePreparedContent: spy.validatePreparedContent,
    } as never);

    expect(spy.calls).toBe(0);
    expect(await readFile(path, "utf-8")).toBe(before);
    const data = dataOf(result.output);
    expect(Object.hasOwn(data, "parentTicket")).toBe(false);
    expect(data.id).toBe("T-001");
    expect(result.exitCode ?? 0).toBe(0);
  });

  it("K2: an issue with no order and no phase, sent 0 and null with the option, is not written at all", async () => {
    const root = await project();
    const path = await cliIssue(root);
    const before = await readFile(path, "utf-8");
    const spy = writeSpy();

    const result = await handleIssueUpdate("ISS-001", { order: 0, phase: null }, "json", root, {
      keepAbsent: ["order", "phase"],
      validatePreparedContent: spy.validatePreparedContent,
    } as never);

    expect(spy.calls).toBe(0);
    expect(await readFile(path, "utf-8")).toBe(before);
    const data = dataOf(result.output);
    expect(Object.hasOwn(data, "order")).toBe(false);
    expect(Object.hasOwn(data, "phase")).toBe(false);
    expect(result.exitCode ?? 0).toBe(0);
  });

  it("K3: with a real change beside them, only that change and the stamp are written", async () => {
    const root = await project();
    const path = await cliIssue(root);
    const before = await readJson(path);

    await handleIssueUpdate("ISS-001", { impact: "imp2", order: 0, phase: null }, "json", root, {
      keepAbsent: ["order", "phase"],
    } as never);

    const after = await readJson(path);
    expect(withoutStamp(after)).toEqual(withBackfill(before, after, { ...withoutStamp(before), impact: "imp2" }, "ISS-001"));
    expect(Object.hasOwn(after, "order")).toBe(false);
    expect(Object.hasOwn(after, "phase")).toBe(false);
  });
});

describe("ISS-1397 --keep-absent: present keys and real values are still written", () => {
  it("K4: present order 0, phase null and parentTicket null stay present", async () => {
    const root = await project();
    const ticket = await cliTicket(root);
    const issue = await cliIssue(root);
    await setKey(ticket, "parentTicket", null);
    await setKey(issue, "order", 0);
    await setKey(issue, "phase", null);

    await handleTicketUpdate("T-001", { title: "A2", parentTicket: null }, "json", root, false, {
      keepAbsent: ["parentTicket"],
    } as never);
    await handleIssueUpdate("ISS-001", { impact: "imp2", order: 0, phase: null }, "json", root, {
      keepAbsent: ["order", "phase"],
    } as never);

    expect((await readJson(ticket)).parentTicket).toBeNull();
    const after = await readJson(issue);
    expect(after.order).toBe(0);
    expect(Object.hasOwn(after, "phase")).toBe(true);
    expect(after.phase).toBeNull();
  });

  it("K5: a present value changed to the absent-equivalent is written", async () => {
    const root = await project();
    await cliTicket(root);
    const child = await cliTicket(root, "T-002");
    await setKey(child, "parentTicket", "T-001");
    const issue = await cliIssue(root);
    await setKey(issue, "order", 30);
    await setKey(issue, "phase", "p0");

    await handleTicketUpdate("T-002", { parentTicket: null }, "json", root, false, {
      keepAbsent: ["parentTicket"],
    } as never);
    await handleIssueUpdate("ISS-001", { order: 0, phase: null }, "json", root, {
      keepAbsent: ["order", "phase"],
    } as never);

    const childAfter = await readJson(child);
    expect(Object.hasOwn(childAfter, "parentTicket")).toBe(true);
    expect(childAfter.parentTicket).toBeNull();
    const after = await readJson(issue);
    expect(after.order).toBe(0);
    expect(Object.hasOwn(after, "phase")).toBe(true);
    expect(after.phase).toBeNull();
  });

  it("K6: an absent key given a real value is written", async () => {
    const root = await project();
    await cliTicket(root);
    await cliTicket(root, "T-002");
    const issue = await cliIssue(root);

    await handleTicketUpdate("T-002", { parentTicket: "T-001" }, "json", root, false, {
      keepAbsent: ["parentTicket"],
    } as never);
    await handleIssueUpdate("ISS-001", { order: 20, phase: "p0" }, "json", root, {
      keepAbsent: ["order", "phase"],
    } as never);

    expect((await readJson(ticketPath(root, "T-002"))).parentTicket).toBe("T-001");
    const after = await readJson(issue);
    expect(after.order).toBe(20);
    expect(after.phase).toBe("p0");
  });
});

describe("ISS-1397 --keep-absent: the meanings without the option are unchanged", () => {
  it("K7: without the option, 0 and null on absent keys are saved as today", async () => {
    const root = await project();
    const ticket = await cliTicket(root);
    const issue = await cliIssue(root);

    await handleTicketUpdate("T-001", { parentTicket: null }, "json", root);
    await handleIssueUpdate("ISS-001", { order: 0, phase: null }, "json", root);

    const t = await readJson(ticket);
    expect(Object.hasOwn(t, "parentTicket")).toBe(true);
    expect(t.parentTicket).toBeNull();
    const i = await readJson(issue);
    expect(i.order).toBe(0);
    expect(Object.hasOwn(i, "phase")).toBe(true);
    expect(i.phase).toBeNull();
  });

  it("K8: the option with no field flag is still refused as an update with no fields", async () => {
    const root = await project();
    await cliTicket(root);
    await cliIssue(root);

    await expect(
      handleTicketUpdate("T-001", {}, "json", root, false, { keepAbsent: ["parentTicket"] } as never),
    ).rejects.toThrow(/No fields to update/);
    await expect(
      handleIssueUpdate("ISS-001", {}, "json", root, { keepAbsent: ["order"] } as never),
    ).rejects.toThrow(/No fields to update/);
  });
});

/**
 * Holds the project lock while the update starts, confirms the update is
 * waiting (its promise unresolved, its precondition hook not run), changes
 * the file, then releases. The update must act on the file as it stood when
 * it got the lock.
 */
async function underHeldLock(
  root: string,
  start: (precondition: () => void) => Promise<unknown>,
  whileHeld: () => Promise<void>,
): Promise<void> {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const holding = new Promise<void>((r) => { entered = r; });
  const holder = withProjectLock(root, { strict: true }, async () => {
    entered();
    await released;
  });
  await holding;

  let ran = false;
  let settled = false;
  const update = start(() => { ran = true; }).finally(() => { settled = true; });
  // ISS-1412: a failure while the lock is held still releases it and lets the
  // update settle, so the test reports its own error, not a hang behind the lock.
  try {
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    expect(ran).toBe(false);
    await whileHeld();
  } finally {
    release();
    await Promise.allSettled([holder, update]);
  }
  await holder;
  await update;
  expect(ran).toBe(true);
}

describe("ISS-1412 underHeldLock", () => {
  it("H1: a throw while the lock is held reports that error, frees the lock and settles the update", async () => {
    const root = await project();
    let updateSettled = false;

    await expect(underHeldLock(
      root,
      (precondition) => withProjectLock(root, { strict: true }, async () => { precondition(); })
        .finally(() => { updateSettled = true; }),
      async () => { throw new Error("boom while held"); },
    )).rejects.toThrow("boom while held");

    expect(updateSettled).toBe(true);
  });
});

describe("ISS-1397 --keep-absent: presence is decided under the lock", () => {
  it("K9: a key added while the update waits is present under the lock, so 0 is written", async () => {
    const root = await project();
    const issue = await cliIssue(root);

    await underHeldLock(
      root,
      (precondition) => handleIssueUpdate("ISS-001", { order: 0 }, "json", root, {
        keepAbsent: ["order"],
        precondition,
      } as never),
      () => setKey(issue, "order", 30),
    );

    expect((await readJson(issue)).order).toBe(0);
  });

  it("K10: a key removed while the update waits is absent under the lock, so it stays absent", async () => {
    const root = await project();
    const issue = await cliIssue(root);
    await setKey(issue, "phase", null);

    await underHeldLock(
      root,
      (precondition) => handleIssueUpdate("ISS-001", { phase: null }, "json", root, {
        keepAbsent: ["phase"],
        precondition,
      } as never),
      () => setKey(issue, "phase", undefined),
    );

    expect(Object.hasOwn(await readJson(issue), "phase")).toBe(false);
  });
});

/** Drives the real ticket and issue yargs trees in-process, strict as the CLI is. */
async function runCli(root: string, args: string[]): Promise<{ stdout: string; error: string | null }> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write;
  const origCwd = process.cwd();
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };
  let error: string | null = null;
  try {
    process.chdir(root);
    process.exitCode = undefined;
    const parser = registerIssueCommand(registerTicketCommand(yargs(args).strict()))
      .exitProcess(false)
      .fail((msg, err) => {
        throw err ?? new Error(msg);
      });
    await parser.parseAsync();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    process.stdout.write = origWrite;
    process.chdir(origCwd);
    process.exitCode = origExit;
  }
  return { stdout: chunks.join(""), error };
}

describe("ISS-1397 --keep-absent: the option on the command line", () => {
  it("K11: a field the command does not take is refused with the allowed choices", async () => {
    const root = await project();
    await cliTicket(root);
    await cliIssue(root);

    const onTicket = await runCli(root, ["ticket", "update", "T-001", "--order", "0", "--keep-absent", "order", "--format", "json"]);
    expect(onTicket.error).toMatch(/Choices: "parentTicket"/);
    const bogus = await runCli(root, ["issue", "update", "ISS-001", "--order", "0", "--keep-absent", "bogus", "--format", "json"]);
    expect(bogus.error).toMatch(/Choices: "order", "phase"/);
  });

  it("K12: the parsed option reaches the issue handler, end to end", async () => {
    const root = await project();
    const path = await cliIssue(root);
    const before = await readFile(path, "utf-8");

    const run = await runCli(root, [
      "issue", "update", "ISS-001", "--order", "0", "--phase", "", "--keep-absent", "order", "--keep-absent", "phase",
      "--format", "json",
    ]);

    expect(run.error).toBeNull();
    expect(await readFile(path, "utf-8")).toBe(before);
    expect(Object.hasOwn(dataOf(run.stdout), "order")).toBe(false);
  });
});
