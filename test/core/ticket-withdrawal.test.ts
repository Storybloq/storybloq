/**
 * T-486 U2-6: ticket withdrawal through the setter. The boundary asks a ready
 * board (as for issue kinds), and the ledger refusals (dependents, umbrella)
 * run against disk at the withdrawal's own commit, with the operation's own
 * writes applied by file path.
 *
 * Every refusal asserts the file's bytes unchanged and no .txn.json left.
 * Expected values are written out, never computed with the code under test.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../src/core/init.js";
import {
  applyRepairPatches,
} from "../../src/cli/commands/repair.js";
import {
  authoriseTicketBytes,
  invalidateResolutionWriteContext,
  loadProject,
  prepareTicketWrite,
  runTransactionUnlocked,
  serializeJSON,
  withProjectLock,
  writeConfigUnlocked,
  writeTicket,
  writeTicketUnlocked,
} from "../../src/core/project-loader.js";
import { teamSetup } from "../../src/core/team-setup.js";
import { handleTicketGet, handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { handleResolve } from "../../src/cli/commands/conflicts.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { todayISO } from "../../src/cli/helpers.js";
import type { Ticket } from "../../src/models/ticket.js";

// --- boards (same shape as ticket-resolution-kind.test.ts) -------------------

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
let globalConfig: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u26-home-"));
  globalConfig = join(scratchHome, "gitconfig");
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "STORYBLOQ_VERSION"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.STORYBLOQ_VERSION = "1.16.0";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(globalConfig, { force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

type Board = "non-team" | "ready" | "low-fence" | "unregistered";

async function board(kind: Board, tickets: Record<string, unknown>[] = []): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u26-"));
  dirs.push(root);
  git(root, "init", "-q");
  await initProject(root, { name: "t486" });
  if (kind !== "non-team") {
    const path = join(root, ".story", "config.json");
    const config = JSON.parse(readFileSync(path, "utf-8"));
    config.team = { enabled: true };
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    await teamSetup(root);
    if (kind === "low-fence") {
      const c = JSON.parse(readFileSync(path, "utf-8"));
      c.team.minCliVersion = "1.15.0";
      writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
    }
    // The boundary asks for the v5 driver (resolutionWritesReadiness), so
    // "unregistered" removes exactly that registration.
    if (kind === "unregistered") git(root, "config", "--local", "--unset-all", "merge.storybloq-json-v5.driver");
  }
  for (const t of tickets) writeRaw(root, t);
  return root;
}

const ticketPath = (root: string, file: string) => join(root, ".story", "tickets", file.endsWith(".json") ? file : `${file}.json`);
const writeRaw = (root: string, t: Record<string, unknown>, file = String(t.id)) => writeFileSync(ticketPath(root, file), serializeJSON(t));
const bytes = (root: string, file: string) => readFileSync(ticketPath(root, file), "utf-8");
const readTicket = (root: string, file: string) => JSON.parse(bytes(root, file)) as Record<string, unknown>;
const noJournal = (root: string) => expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);

async function refused(root: string, file: string, run: () => Promise<unknown>): Promise<Error> {
  const before = existsSync(ticketPath(root, file)) ? bytes(root, file) : null;
  const err = await run().then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(existsSync(ticketPath(root, file)) ? bytes(root, file) : null).toBe(before);
  noJournal(root);
  return err as Error;
}

const DAY = "2026-03-05";
function t(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: `Ticket ${id}`, type: "task", status: "open", phase: null, order: 10, description: "",
    createdDate: "2026-03-01", completedDate: null, blockedBy: [], parentTicket: null, ...over,
  };
}
const done = (id: string, over: Record<string, unknown> = {}) => t(id, { status: "complete", completedDate: DAY, ...over });
const withdrawn = (id: string, reason = "Superseded", over: Record<string, unknown> = {}) =>
  done(id, { resolutionKind: { kind: "withdrawn", closedOn: DAY, reason }, ...over });
const WITHDRAW = { resolutionKind: "withdrawn", reason: "Folded into T-9" } as const;

// --- the setter ---------------------------------------------------------------

describe("T-486 U2-6 setter", () => {
  it("withdraws a complete ticket bound to its own completedDate (S6)", async () => {
    const root = await board("non-team", [done("T-004")]);
    await handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root);
    expect(readTicket(root, "T-004").resolutionKind).toStrictEqual({ kind: "withdrawn", closedOn: DAY, reason: "Folded into T-9" });
  });

  it("withdrawing on completion binds today's date (S6)", async () => {
    const root = await board("non-team", [t("T-004")]);
    await handleTicketUpdate("T-004", { status: "complete", ...WITHDRAW }, "json", root);
    const after = readTicket(root, "T-004");
    expect(after.completedDate).toBe(todayISO());
    expect(after.resolutionKind).toStrictEqual({ kind: "withdrawn", closedOn: todayISO(), reason: "Folded into T-9" });
  });

  it("the flag on a ticket that is not complete after the update is refused", async () => {
    const root = await board("non-team", [t("T-004")]);
    const err = await refused(root, "T-004", () => handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root));
    expect(err.message).toContain("needs a complete ticket");
  });

  it.each([[undefined], [""], ["   "]])("S3: the flag with reason %j is refused", async (reason) => {
    const root = await board("non-team", [done("T-004")]);
    const err = await refused(root, "T-004", () => handleTicketUpdate("T-004", { resolutionKind: "withdrawn", reason }, "json", root));
    expect(err.message).toBe("A withdrawal needs a non-empty --reason saying why the work is not delivered");
  });

  it("S3: a reason without the flag is refused", async () => {
    const root = await board("non-team", [done("T-004")]);
    const err = await refused(root, "T-004", () => handleTicketUpdate("T-004", { reason: "x" }, "json", root));
    expect(err.message).toBe("--reason is only for a withdrawal: pass it with --resolution-kind withdrawn");
  });

  it("S5: withdrawing an umbrella is refused", async () => {
    const root = await board("non-team", [done("T-002"), done("T-004", { parentTicket: "T-002" })]);
    const err = await refused(root, "T-002", () => handleTicketUpdate("T-002", { ...WITHDRAW }, "json", root));
    expect(err.message).toContain("withdraw its open children instead");
  });

  it("S1: reopening a withdrawn ticket drops the withdrawal", async () => {
    const root = await board("non-team", [withdrawn("T-004")]);
    await handleTicketUpdate("T-004", { status: "open" }, "json", root, true);
    const after = readTicket(root, "T-004");
    expect(after.status).toBe("open");
    expect("resolutionKind" in after).toBe(false);
  });

  it("S2: an explicit re-completion without the flag drops it; a title edit keeps it byte for byte", async () => {
    const root = await board("non-team", [withdrawn("T-004"), withdrawn("T-005")]);
    const slot = JSON.stringify(readTicket(root, "T-005").resolutionKind);
    await handleTicketUpdate("T-005", { title: "Retitled" }, "json", root);
    expect(JSON.stringify(readTicket(root, "T-005").resolutionKind)).toBe(slot);
    await handleTicketUpdate("T-004", { status: "complete" }, "json", root);
    const after = readTicket(root, "T-004");
    expect(after.status).toBe("complete");
    expect("resolutionKind" in after).toBe(false);
  });
});

// --- dependents and umbrellas -----------------------------------------------

describe("T-486 U2-6 ledger refusals", () => {
  it("D1: withdrawing T-004 is refused naming T-009 blockedBy T-004", async () => {
    const root = await board("non-team", [done("T-004"), t("T-009", { blockedBy: ["T-004"] })]);
    const err = await refused(root, "T-004", () => handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root));
    expect(err.message).toContain("T-009 blockedBy T-004");
    expect(err.message).toContain("retarget or remove the edges");
  });

  it.each(["complete", "open"])("D2: a dependent of a %s umbrella ancestor is named", async (umbrellaStatus) => {
    const umbrella = umbrellaStatus === "complete" ? done("T-002") : t("T-002");
    const root = await board("non-team", [umbrella, done("T-004", { parentTicket: "T-002" }), t("T-012", { blockedBy: ["T-002"] })]);
    const err = await refused(root, "T-004", () => handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root));
    expect(err.message).toContain("T-012 blockedBy umbrella T-002 (ancestor of T-004)");
  });

  it("D3: a deleted dependent does not block", async () => {
    const root = await board("non-team", [done("T-004"), t("T-009", { blockedBy: ["T-004"], lifecycle: "deleted" })]);
    await handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root);
    expect((readTicket(root, "T-004").resolutionKind as Record<string, unknown>).kind).toBe("withdrawn");
  });

  it("D4: a dependent by display id on a hash file is found", async () => {
    const hashId = "t-0000000000000e04";
    const root = await board("non-team", [t("T-009", { blockedBy: ["T-050"] })]);
    writeRaw(root, done(hashId, { displayId: "T-050" }));
    const err = await refused(root, hashId, () => handleTicketUpdate("T-050", { ...WITHDRAW }, "json", root));
    expect(err.message).toContain("T-009 blockedBy");
  });

  it("F3: on the R2-1 shape, withdrawing B's counted child is refused naming the ticket blocked by B", async () => {
    const A = "t-0000000000000f01";
    const B = "t-0000000000000f02";
    const C = "t-0000000000000f03";
    const root = await board("non-team", [t("T-070", { blockedBy: [B] })]);
    writeRaw(root, t(A, { displayId: "T-050" }), `${A}-a`);
    writeRaw(root, t(A, { displayId: "T-050" }), `${A}-b`);
    writeRaw(root, done(B, { displayId: "T-050" }));
    writeRaw(root, done(C, { displayId: "T-051", parentTicket: "T-050" }));
    // Through the exported writer: the duplicated canonical id is an
    // integrity warning a strict lock would refuse before the setter runs.
    const err = await refused(root, C, () => writeTicket(withdrawn(C, "x", { displayId: "T-051", parentTicket: "T-050" }) as unknown as Ticket, root));
    expect(err.message).toContain("T-070 blockedBy umbrella T-050 (ancestor of T-051)");
  });

  it("F4d: a reparent plus a withdrawal in one update counts the new parent, before the board check", async () => {
    // A low-fence board: the setter's early check (on the candidate) must name
    // the dependent before the boundary refuses on the fence.
    const root = await board("low-fence", [t("T-002"), done("T-004"), t("T-012", { blockedBy: ["T-002"] }), done("T-003")]);
    const err = await refused(root, "T-004", () =>
      handleTicketUpdate("T-004", { parentTicket: "T-002", ...WITHDRAW }, "json", root));
    expect(err.message).toContain("T-012 blockedBy umbrella T-002 (ancestor of T-004)");
  });

  it("F4d: the same reparent written as one raw prepared record is refused at commit", async () => {
    const root = await board("non-team", [t("T-002"), done("T-004"), t("T-012", { blockedBy: ["T-002"] }), done("T-003")]);
    const err = await refused(root, "T-004", () => writeTicket(withdrawn("T-004", "x", { parentTicket: "T-002" }) as unknown as Ticket, root));
    expect(err.message).toContain("T-012 blockedBy umbrella T-002");
  });
});

// --- the boundary: readiness and commit-time refusals -------------------------

describe("T-486 U2-6 boundary", () => {
  it("W1: a ready board lands a withdrawal through resolve --use theirs", async () => {
    const root = await board("ready");
    const ours = t("T-001", { completedDate: null });
    const theirs = withdrawn("T-001");
    const members = ["status", "completedDate", "resolutionKind"];
    writeRaw(root, {
      ...ours,
      _conflicts: members.map((m) => ({ fieldPath: `/${m}`, field: m, kind: "coupled", group: "ticket-status", base: ours[m], ours: ours[m], theirs: theirs[m] })),
    });
    await handleResolve("T-001", root, { field: "status", use: "theirs", format: "json" });
    expect(readTicket(root, "T-001").resolutionKind).toStrictEqual(theirs.resolutionKind);
  });

  it("W1: a ready board lands a withdrawal through repair and through writeTicket", async () => {
    const root = await board("ready", [done("T-001"), done("T-002")]);
    await withProjectLock(root, { strict: false }, () =>
      applyRepairPatches(root, [{ id: "T-001", type: "ticket", set: { resolutionKind: { kind: "withdrawn", closedOn: DAY, reason: "r" } }, unset: [] }]));
    expect((readTicket(root, "T-001").resolutionKind as Record<string, unknown>).reason).toBe("r");
    await writeTicket(withdrawn("T-002") as unknown as Ticket, root);
    expect((readTicket(root, "T-002").resolutionKind as Record<string, unknown>).kind).toBe("withdrawn");
  });

  it("W1b: a low-fence board refuses naming the fence", async () => {
    const root = await board("low-fence", [done("T-004")]);
    const err = await refused(root, "T-004", () => handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root));
    expect(err.message).toContain("team.minCliVersion is 1.15.0, below");
  });

  it("W2: an unregistered board refuses naming the driver", async () => {
    const root = await board("unregistered", [done("T-004")]);
    const err = await refused(root, "T-004", () => handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root));
    expect(err.message).toContain("merge driver");
  });

  it("W3: an unreadable config refuses the activation", async () => {
    const root = await board("non-team", [done("T-004")]);
    const config = join(root, ".story", "config.json");
    const err = await refused(root, "T-004", async () => {
      // A config write under the lock drops the held context's config
      // (invalidateResolutionWriteContext), so the next write re-reads
      // config.json lazily; a file broken by then reaches the decision.
      await withProjectLock(root, { strict: false }, async () => {
        writeFileSync(config, "{ not json");
        invalidateResolutionWriteContext(root);
        await writeTicketUnlocked(withdrawn("T-004") as unknown as Ticket, root);
      });
    });
    expect(err.message).toContain("config could not be read");
  });

  it("F1a: a reason edit on an already withdrawn ticket is refused on a low-fence board (setter and raw)", async () => {
    const root = await board("low-fence", [withdrawn("T-004", "old")]);
    const viaSetter = await refused(root, "T-004", () => handleTicketUpdate("T-004", { resolutionKind: "withdrawn", reason: "new" }, "json", root));
    expect(viaSetter.message).toContain("team.minCliVersion is 1.15.0");
    const raw = await refused(root, "T-004", () => writeTicket(withdrawn("T-004", "new") as unknown as Ticket, root));
    expect(raw.message).toContain("team.minCliVersion is 1.15.0");
  });

  it("F1b: a raw reason edit on a withdrawn ticket with a live dependent is refused naming it", async () => {
    const root = await board("non-team", [withdrawn("T-004", "old"), t("T-009", { blockedBy: ["T-004"] })]);
    const err = await refused(root, "T-004", () =>
      withProjectLock(root, { strict: false }, async () => {
        const p = await prepareTicketWrite(withdrawn("T-004", "new") as unknown as Ticket, root);
        await runTransactionUnlocked(root, [{ op: "write", ...p }]);
      }));
    expect(err.message).toContain("T-009 blockedBy T-004");
  });

  it("D5: resolve --use theirs activating a withdrawal with a live dependent is refused on a ready board", async () => {
    const root = await board("ready", [t("T-009", { blockedBy: ["T-001"] })]);
    const ours = t("T-001");
    const theirs = withdrawn("T-001");
    const members = ["status", "completedDate", "resolutionKind"];
    writeRaw(root, {
      ...ours,
      _conflicts: members.map((m) => ({ fieldPath: `/${m}`, field: m, kind: "coupled", group: "ticket-status", base: ours[m], ours: ours[m], theirs: theirs[m] })),
    });
    const err = await refused(root, "T-001", () => handleResolve("T-001", root, { field: "status", use: "theirs", format: "json" }));
    expect(err.message).toContain("T-009 blockedBy T-001");
  });

  it("F4a: an abandoned prepared edge removal still refuses", async () => {
    const root = await board("non-team", [done("T-004"), t("T-009", { blockedBy: ["T-004"] })]);
    const err = await refused(root, "T-004", () =>
      withProjectLock(root, { strict: false }, async () => {
        await prepareTicketWrite(t("T-009") as unknown as Ticket, root);
        await writeTicketUnlocked(withdrawn("T-004") as unknown as Ticket, root);
      }));
    expect(err.message).toContain("T-009 blockedBy T-004");
    expect(readTicket(root, "T-009").blockedBy).toEqual(["T-004"]);
  });

  it("F4b: a failed dependent update still refuses", async () => {
    const root = await board("non-team", [done("T-004"), t("T-009", { blockedBy: ["T-004"] })]);
    // An edge removal refused before its commit: the type is not a ticket type.
    await expect(handleTicketUpdate("T-009", { blockedBy: [], type: "nope" }, "json", root)).rejects.toThrow();
    const err = await refused(root, "T-004", () => handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root));
    expect(err.message).toContain("T-009 blockedBy T-004");
  });

  it("F4c: a dependent committed after the withdrawal was prepared is refused at the withdrawal's commit", async () => {
    const root = await board("non-team", [done("T-004")]);
    const err = await refused(root, "T-004", () =>
      withProjectLock(root, { strict: false }, async () => {
        const w = await prepareTicketWrite(withdrawn("T-004") as unknown as Ticket, root);
        await writeTicketUnlocked(t("T-009", { blockedBy: ["T-004"] }) as unknown as Ticket, root);
        await runTransactionUnlocked(root, [{ op: "write", ...w }]);
      }));
    expect(err.message).toContain("T-009 blockedBy T-004");
  });

  it("F4c: a dependent and a withdrawal in one transaction are refused together", async () => {
    const root = await board("non-team", [done("T-004")]);
    const err = await refused(root, "T-004", () =>
      withProjectLock(root, { strict: false }, async () => {
        const d = await prepareTicketWrite(t("T-009", { blockedBy: ["T-004"] }) as unknown as Ticket, root);
        const w = await prepareTicketWrite(withdrawn("T-004") as unknown as Ticket, root);
        await runTransactionUnlocked(root, [{ op: "write", ...d }, { op: "write", ...w }]);
      }));
    expect(err.message).toContain("T-009 blockedBy T-004");
    expect(existsSync(ticketPath(root, "T-009"))).toBe(false);
  });

  it("F4e: two files sharing a canonical id keep their own edges", async () => {
    const root = await board("non-team", [done("T-004")]);
    const dup = "t-0000000000000a09";
    writeRaw(root, t(dup, { displayId: "T-009", blockedBy: ["T-004"] }), `${dup}-a`);
    writeRaw(root, t(dup, { displayId: "T-009", blockedBy: [] }), `${dup}-b`);
    const err = await refused(root, "T-004", () =>
      withProjectLock(root, { strict: false }, async () => {
        // The -b file is rewritten as reconcile and repair rewrite a file
        // the canonical id cannot name: bytes authorised for its own path.
        const bPath = ticketPath(root, `${dup}-b`);
        const bContent = serializeJSON(t(dup, { displayId: "T-009", blockedBy: [], title: "Rewritten" }));
        authoriseTicketBytes(root, bPath, readTicket(root, `${dup}-b`), bContent);
        const w = await prepareTicketWrite(withdrawn("T-004") as unknown as Ticket, root);
        await runTransactionUnlocked(root, [{ op: "write", target: bPath, content: bContent }, { op: "write", ...w }]);
      }));
    expect(err.message).toContain("T-009 blockedBy T-004");
    expect(readTicket(root, `${dup}-b`).title).toBe("Ticket t-0000000000000a09");
  });

  it("F4f: the exported writeTicket refuses a withdrawal with a live dependent", async () => {
    const root = await board("non-team", [done("T-004"), t("T-009", { blockedBy: ["T-004"] })]);
    const err = await refused(root, "T-004", () => writeTicket(withdrawn("T-004") as unknown as Ticket, root));
    expect(err.message).toContain("T-009 blockedBy T-004");
  });

  it("after a config write inside the lock, a withdrawal with a live dependent is still refused", async () => {
    const root = await board("non-team", [done("T-004"), t("T-009", { blockedBy: ["T-004"] })]);
    const err = await refused(root, "T-004", () =>
      withProjectLock(root, { strict: false }, async ({ state }) => {
        await writeConfigUnlocked(state.config, root);
        await writeTicketUnlocked(withdrawn("T-004") as unknown as Ticket, root);
      }));
    expect(err.message).toContain("T-009 blockedBy T-004");
  });
});

// --- MCP ------------------------------------------------------------------------

interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}
function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: RegisteredTool["handler"]) => tools.set(name, { handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

describe("T-486 U2-6 MCP setter", () => {
  it("S7: storybloq_ticket_update with resolutionKind withdrawn writes the withdrawal", async () => {
    const root = await board("non-team", [done("T-004")]);
    const out = await captureTools(root).get("storybloq_ticket_update")!.handler({ id: "T-004", resolutionKind: "withdrawn", reason: "Folded into T-9" });
    expect(out.isError).toBeFalsy();
    expect(readTicket(root, "T-004").resolutionKind).toStrictEqual({ kind: "withdrawn", closedOn: DAY, reason: "Folded into T-9" });
  });

  it("D1 over MCP: the dependent refusal reaches the caller", async () => {
    const root = await board("non-team", [done("T-004"), t("T-009", { blockedBy: ["T-004"] })]);
    const out = await captureTools(root).get("storybloq_ticket_update")!.handler({ id: "T-004", resolutionKind: "withdrawn", reason: "x" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("T-009 blockedBy T-004");
  });

  it("S1 over MCP: reopening drops the withdrawal", async () => {
    const root = await board("non-team", [withdrawn("T-004")]);
    await captureTools(root).get("storybloq_ticket_update")!.handler({ id: "T-004", status: "open", force: true });
    expect("resolutionKind" in readTicket(root, "T-004")).toBe(false);
  });
});

// --- end to end -------------------------------------------------------------------

describe("T-486 U2-6 end to end", () => {
  it("a ticket withdrawn through the setter counts as withdrawn and shows its reason on ticket get", async () => {
    const root = await board("non-team", [done("T-004"), done("T-005")]);
    await handleTicketUpdate("T-004", { ...WITHDRAW }, "json", root);
    const { state } = await loadProject(root);
    expect([state.withdrawnLeafTicketCount, state.deliveredLeafTicketCount]).toEqual([1, 1]);
    const ctx = { state, warnings: [], root, handoversDir: join(root, ".story", "handovers"), format: "md" as const };
    expect(handleTicketGet("T-004", ctx).output).toContain("Status: complete (withdrawn): Folded into T-9");
  });
});
