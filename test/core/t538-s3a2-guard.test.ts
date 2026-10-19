/**
 * T-538 S3a-2 commit 2: an establishment ticket's metadata, its projection
 * in the owned digest, the write guard's two authorities, and the three
 * replace paths for an establishment key.
 */
import { describe, it, expect, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProject, prepareTicketWrite as prepareUnderLock, withProjectLock } from "../../src/core/project-loader.js";
import { setupApply, setupReport, setupResolve, setupResume, VERIFICATION_TIMEOUT_MS } from "../../src/core/setup-apply.js";
import { parseSetupMeta } from "../../src/core/setup-meta.js";
import { validateProject } from "../../src/core/validation.js";
import { ESTABLISHMENT_CREATION_AUTHORITY, VERIFICATION_RESULT_AUTHORITY } from "../../src/core/setup-verification-guard.js";
import { handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { setupVerify } from "../../src/core/setup-verify.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import type { Ticket } from "../../src/models/ticket.js";
import { SID, editTicket, faultOnce, makeRegistry, payload, pinEnvironment, ticketBytes, ticketFile } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 30_000 });
const { folder } = pinEnvironment("t538-s3a2g");

const SPEC = { setupId: SID, component: "app", stage: "test", workdir: ".", command: "npm test", runner: "vitest", wrapper: "npm", timeoutMs: VERIFICATION_TIMEOUT_MS };

async function applied(): Promise<string> {
  const root = await folder();
  const r = await setupApply(root, payload());
  expect(r.exitCode, r.lines.join("\n")).toBe(0);
  return root;
}

/** The writer needs the project lock held, as every real caller holds it. */
async function prepareTicketWrite(t: Ticket, root: string, opts?: Parameters<typeof prepareUnderLock>[2]) {
  let out: unknown;
  await withProjectLock(root, { strict: false }, async () => { out = await prepareUnderLock(t, root, opts); });
  return out;
}

const guardMessage = /T-002 is an establishment ticket: its setup field, its completion and its reopening are written only by storybloq setup-verify --ticket T-002/;

describe("the establishment ticket setup creates", () => {
  it("carries what it establishes and its spec, and nothing recorded yet", async () => {
    const root = await applied();
    const raw = await ticketFile(root, "T-002");
    expect(raw.setup).toEqual({ setupId: SID, key: "K3", establishes: { component: "app", stage: "test", scaffold: "K2" }, verification: { spec: SPEC } });
    expect(raw.status).toBe("open");
    expect(raw.blockedBy).toEqual(["T-001"]);
    expect(parseSetupMeta("ticket", raw)).toMatchObject({ kind: "item" });
  });

  it("stays an item: validate is clean, the report counts it, and a resume finds the setup complete", async () => {
    const root = await applied();
    const { state } = await loadProject(root);
    expect(validateProject(state).findings.filter((f) => f.code.startsWith("setup_"))).toEqual([]);
    const report = await setupReport(root, SID);
    expect(report.lines.join("\n")).toContain("Created: 1 phases, 3 tickets");
    const resumed = await setupResume(root, SID);
    expect(resumed.lines.at(-1)).toBe(`Setup applied: ${SID} (already complete; nothing written)`);
  });

  it("validate names metadata that does not parse", async () => {
    const root = await applied();
    await editTicket(root, "T-002", (raw) => { (raw.setup as Record<string, unknown>).verification = { spec: { ...SPEC, runner: "mocha" } }; });
    const { state } = await loadProject(root);
    expect(validateProject(state).findings.map((f) => f.code)).toContain("setup_meta_invalid");
  });
});

describe("the metadata schema", () => {
  const base = { setupId: SID, key: "K3" };
  const est = { component: "app", stage: "test", scaffold: "K2" };
  const ok = (setup: unknown, entity: "ticket" | "issue" = "ticket") => parseSetupMeta(entity, { setup }).kind;

  it("accepts a full record", () => {
    expect(ok({ ...base, establishes: est, verification: {
      spec: SPEC,
      result: { status: "verified", counts: { executed: 3, failed: 0 }, tailDigest: "a".repeat(64), at: "2026-10-18T00:00:00Z" },
      decision: { kind: "adapter", adapter: { argv: ["pytest"], drop: ["PYTEST_ADDOPTS"] }, ownerWords: "use pytest", at: "2026-10-18T00:00:00Z" },
      reopened: [{ at: "2026-10-18T00:00:00Z" }],
    } })).toBe("item");
  });

  it("refuses establishes without verification and the reverse, and either on an issue", () => {
    expect(ok({ ...base, establishes: est })).toBe("invalid");
    expect(ok({ ...base, verification: { spec: SPEC } })).toBe("invalid");
    expect(ok({ ...base, establishes: est, verification: { spec: SPEC } }, "issue")).toBe("invalid");
  });

  it("is strict at every level", () => {
    expect(ok({ ...base, establishes: { ...est, extra: 1 }, verification: { spec: SPEC } })).toBe("invalid");
    expect(ok({ ...base, establishes: est, verification: { spec: { ...SPEC, extra: 1 } } })).toBe("invalid");
    expect(ok({ ...base, establishes: est, verification: { spec: SPEC, other: 1 } })).toBe("invalid");
    expect(ok({ ...base, establishes: est, verification: { spec: SPEC, result: { status: "verified", at: "x", extra: 1 } } })).toBe("invalid");
    expect(ok({ ...base, establishes: est, verification: { spec: SPEC, decision: { kind: "adapter", ownerWords: "w", at: "x" } } })).toBe("invalid");
    expect(ok({ ...base, establishes: est, verification: { spec: SPEC, decision: { kind: "stop", adapter: { argv: ["x"], drop: [] }, ownerWords: "w", at: "x" } } })).toBe("invalid");
    expect(ok({ ...base, establishes: est, verification: { spec: SPEC, decision: { kind: "adapter", adapter: { argv: [], drop: [] }, ownerWords: "w", at: "x" } } })).toBe("invalid");
    expect(ok({ ...base, establishes: est, verification: { spec: SPEC, decision: { kind: "adapter", adapter: { argv: ["x"], drop: ["PATH"] }, ownerWords: "w", at: "x" } } })).toBe("invalid");
  });
});

describe("the guard without authority", () => {
  async function prep(root: string, t: Record<string, unknown>, opts?: Parameters<typeof prepareUnderLock>[2]) {
    return prepareTicketWrite(t as unknown as Ticket, root, opts);
  }

  it("refuses a create carrying either field", async () => {
    const root = await applied();
    const src = await ticketFile(root, "T-002");
    await expect(prep(root, { ...src, id: "T-009", displayId: "T-009" })).rejects.toThrow(/T-009 is an establishment ticket/);
    const s = src.setup as Record<string, unknown>;
    await expect(prep(root, { ...src, id: "T-009", displayId: "T-009", setup: { setupId: SID, key: "K9", verification: s.verification } })).rejects.toThrow(/T-009 is an establishment ticket/);
  });

  it("refuses a change to or removal of establishes or the spec", async () => {
    const root = await applied();
    const src = await ticketFile(root, "T-002");
    const s = src.setup as Record<string, Record<string, unknown>>;
    await expect(prep(root, { ...src, setup: { ...s, establishes: { ...s.establishes, scaffold: "K4" } } })).rejects.toThrow(guardMessage);
    await expect(prep(root, { ...src, setup: { ...s, verification: { spec: { ...s.verification!.spec as object, command: "npm run t" } } } })).rejects.toThrow(guardMessage);
    await expect(prep(root, { ...src, setup: { setupId: SID, key: "K3" } })).rejects.toThrow(guardMessage);
    await expect(prep(root, { ...src, setup: undefined })).rejects.toThrow(guardMessage);
  });

  it("refuses a recorded result, decision or reopening", async () => {
    const root = await applied();
    const src = await ticketFile(root, "T-002");
    const s = src.setup as Record<string, Record<string, unknown>>;
    for (const extra of [
      { result: { status: "verified", at: "x" } },
      { decision: { kind: "stop", ownerWords: "w", at: "x" } },
      { reopened: [{ at: "x" }] },
    ]) {
      await expect(prep(root, { ...src, setup: { ...s, verification: { ...s.verification, ...extra } } })).rejects.toThrow(guardMessage);
    }
  });

  it("refuses completing it on both transports, and lets ordinary work through", async () => {
    const root = await applied();
    await expect(handleTicketUpdate("T-002", { status: "complete" }, "json", root)).rejects.toThrow(guardMessage);
    const { tools, server } = makeRegistry();
    registerAllTools(server, root);
    const mcp = await tools.get("storybloq_ticket_update")!.handler({ id: "T-002", status: "complete" });
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]!.text).toMatch(guardMessage);
    expect((await ticketFile(root, "T-002")).status).toBe("open");
    await handleTicketUpdate("T-002", { status: "inprogress", title: "Prove the tests run" }, "json", root);
    expect(await ticketFile(root, "T-002")).toMatchObject({ status: "inprogress", title: "Prove the tests run" });
    const viaMcp = await tools.get("storybloq_ticket_update")!.handler({ id: "T-002", description: "one real test" });
    expect(viaMcp.isError).toBeUndefined();
  });

  it("lets the same owner reopen a ticket with no setup hold on both transports (the control: force proves ownership to status-authority)", async () => {
    const root = await applied();
    const { tools, server } = makeRegistry();
    registerAllTools(server, root);
    const complete = () => editTicket(root, "T-001", (raw) => { raw.status = "complete"; raw.completedDate = "2026-10-18"; });
    await complete();
    await handleTicketUpdate("T-001", { status: "open" }, "json", root, true);
    expect((await ticketFile(root, "T-001")).status).toBe("open");
    await complete();
    const mcp = await tools.get("storybloq_ticket_update")!.handler({ id: "T-001", status: "inprogress", force: true });
    expect(mcp.isError).toBeUndefined();
    expect((await ticketFile(root, "T-001")).status).toBe("inprogress");
  });

  it("refuses a reopen out of complete in every closed state, on both transports, to a caller who proves ownership; setup-verify --reopen recovers", async () => {
    const closed: Record<string, Record<string, unknown> | undefined> = {
      verified: { status: "verified", at: "2026-10-18T00:00:00.000Z" },
      "left-off": { status: "left-off", at: "2026-10-18T00:00:00.000Z" },
      "closed without a result": undefined,
    };
    for (const [state, result] of Object.entries(closed)) {
      const root = await applied();
      await editTicket(root, "T-002", (raw) => {
        raw.status = "complete";
        raw.completedDate = "2026-10-18";
        const v = (raw.setup as { verification: Record<string, unknown> }).verification;
        if (result !== undefined) v.result = result;
      });
      const before = await ticketBytes(root, "T-002");
      for (const status of ["open", "inprogress"]) {
        await expect(handleTicketUpdate("T-002", { status }, "json", root, true), state).rejects.toThrow(guardMessage);
        const { tools, server } = makeRegistry();
        registerAllTools(server, root);
        const mcp = await tools.get("storybloq_ticket_update")!.handler({ id: "T-002", status, force: true });
        expect([state, mcp.isError, mcp.content[0]!.text]).toEqual([state, true, expect.stringMatching(guardMessage)]);
      }
      expect(await ticketBytes(root, "T-002"), state).toBe(before);
      if (result === undefined) {
        const r = await setupVerify(root, { ticket: "T-002", reopen: true });
        expect([r.exitCode, r.lines[0]]).toEqual([0, "Reopened: T-002 is open; run storybloq setup-verify --ticket T-002."]);
        expect((await ticketFile(root, "T-002")).status).toBe("open");
      }
    }
  });

  it("leaves tickets without the fields alone", async () => {
    const root = await applied();
    await handleTicketUpdate("T-001", { status: "complete" }, "json", root);
    expect((await ticketFile(root, "T-001")).status).toBe("complete");
  });
});

describe("the two authorities", () => {
  it("creation: a create carrying a result, a complete create, and any later edit are refused", async () => {
    const root = await applied();
    const src = await ticketFile(root, "T-002");
    const s = src.setup as Record<string, Record<string, unknown>>;
    const auth = { verificationAuthority: ESTABLISHMENT_CREATION_AUTHORITY } as const;
    const withResult = { ...src, id: "T-009", displayId: "T-009", setup: { ...s, verification: { ...s.verification, result: { status: "verified", at: "x" } } } };
    await expect(prepareTicketWrite(withResult as unknown as Ticket, root, auth)).rejects.toThrow(/T-009 is an establishment ticket/);
    await expect(prepareTicketWrite({ ...src, id: "T-009", displayId: "T-009", status: "complete", completedDate: "2026-10-18" } as unknown as Ticket, root, auth)).rejects.toThrow(/T-009 is an establishment ticket/);
    await expect(prepareTicketWrite({ ...src, setup: { ...s, verification: { spec: { ...s.verification!.spec as object, command: "x" } } } } as unknown as Ticket, root, auth)).rejects.toThrow(guardMessage);
    await expect(prepareTicketWrite({ ...src, status: "complete", completedDate: "2026-10-18" } as unknown as Ticket, root, auth)).rejects.toThrow(guardMessage);
    // The settlement case adds supersededBy and changes nothing else.
    await expect(prepareTicketWrite({ ...src, title: "other", setup: { ...s, supersededBy: "T-005" } } as unknown as Ticket, root, auth)).rejects.toThrow(guardMessage);
    await expect(prepareTicketWrite({ ...src, setup: { ...s, supersededBy: "T-005" } } as unknown as Ticket, root, auth)).resolves.toBeDefined();
  });

  it("result: records and completes, never creates or changes the spec", async () => {
    const root = await applied();
    const src = await ticketFile(root, "T-002");
    const s = src.setup as Record<string, Record<string, unknown>>;
    const auth = { verificationAuthority: VERIFICATION_RESULT_AUTHORITY } as const;
    await expect(prepareTicketWrite({ ...src, id: "T-009", displayId: "T-009" } as unknown as Ticket, root, auth)).rejects.toThrow(/T-009 is an establishment ticket/);
    await expect(prepareTicketWrite({ ...src, setup: { ...s, verification: { spec: { ...s.verification!.spec as object, command: "x" } } } } as unknown as Ticket, root, auth)).rejects.toThrow(guardMessage);
    await expect(prepareTicketWrite({ ...src, setup: { ...s, establishes: { ...s.establishes, scaffold: "K4" } } } as unknown as Ticket, root, auth)).rejects.toThrow(guardMessage);
    await expect(prepareTicketWrite({ ...src, setup: { ...s, supersededBy: "T-005" } } as unknown as Ticket, root, auth)).rejects.toThrow(guardMessage);
    const recorded = { ...src, status: "complete", completedDate: "2026-10-18", setup: { ...s, verification: { ...s.verification, result: { status: "verified", at: "x" } } } };
    await expect(prepareTicketWrite(recorded as unknown as Ticket, root, auth)).resolves.toBeDefined();
    const bad = { ...src, setup: { ...s, verification: { ...s.verification, result: { status: "passed", at: "x" } } } };
    await expect(prepareTicketWrite(bad as unknown as Ticket, root, auth)).rejects.toThrow(/T-002: its setup field/);
  });
});

describe("drift and the replace paths for an establishment key", () => {
  it("an outside edit to the spec during an unfinished setup is owned-field drift, stop only", async () => {
    const root = await folder();
    faultOnce("step:wire:K3");
    expect((await setupApply(root, payload())).exitCode).toBe(3);
    await editTicket(root, "T-002", (raw) => { ((raw.setup as Record<string, Record<string, Record<string, unknown>>>).verification!.spec!).command = "npm run other"; });
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines.join("\n")).toContain("Ambiguity: owned field edited · K3 (T-002) · observed its establishes or verification spec differ from what setup wrote");
    expect(r.lines.join("\n")).toMatch(/resolutions: stop$/m);
  });

  it("an outside edit to establishes is drift too", async () => {
    const root = await folder();
    faultOnce("step:wire:K3");
    await setupApply(root, payload());
    await editTicket(root, "T-002", (raw) => { ((raw.setup as Record<string, Record<string, unknown>>).establishes!).scaffold = "K4"; });
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines.join("\n")).toContain("owned field edited · K3 (T-002)");
  });

  it("an unkeyed collision offers replace and stop, never adopt, and replace creates the ticket with its spec", async () => {
    const root = await folder();
    faultOnce("step:item:K2");
    expect((await setupApply(root, payload())).exitCode).toBe(3);
    // A ticket titled like K3 that no setup owns.
    const { handleTicketCreate } = await import("../../src/cli/commands/ticket.js");
    await handleTicketCreate({ title: "K3 title", type: "task", phase: "build", description: "", blockedBy: [], parentTicket: null }, "json", root);
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    const line = r.lines.find((l) => l.startsWith("Ambiguity: unkeyed item matches a planned item"))!;
    expect(line).toMatch(/resolutions: replace \| stop$/);
    const target = line.split(" · ")[1]!;
    const resolved = await setupResolve(root, SID, [{ target, resolution: "replace", ownerWords: "make a new one" }]);
    expect(resolved.exitCode, resolved.lines.join("\n")).toBe(0);
    const { state } = await loadProject(root);
    const created = state.tickets.find((x) => parseSetupMeta("ticket", x).kind === "item" && (x as unknown as { setup: { key: string } }).setup.key === "K3")!;
    expect((created as unknown as { setup: unknown }).setup).toEqual({ setupId: SID, key: "K3", establishes: { component: "app", stage: "test", scaffold: "K2" }, verification: { spec: SPEC } });
  });

  it("a missing receipted establishment ticket stays stop only", async () => {
    const root = await folder();
    faultOnce("step:wire:K3");
    await setupApply(root, payload());
    await rm(join(root, ".story", "tickets", "T-002.json"));
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines.join("\n")).toMatch(/Ambiguity: setup item removed · K3 \(T-002\).*resolutions: stop$/m);
  });

  it("a duplicate-key settlement keeps the loser's establishes and spec, and the winner byte-equal", async () => {
    const root = await folder();
    faultOnce("step:wire:K3");
    await setupApply(root, payload());
    const src = await ticketFile(root, "T-002");
    await writeFile(join(root, ".story", "tickets", "T-009.json"), JSON.stringify({ ...src, id: "T-009", displayId: "T-009" }, null, 2) + "\n");
    const winner = await ticketBytes(root, "T-002");
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    const line = r.lines.find((l) => l.startsWith("Ambiguity: key on two items"))!;
    const resolved = await setupResolve(root, SID, [{ target: line.split(" · ")[1]!, resolution: "keep T-002", ownerWords: "keep the first" }]);
    expect(resolved.exitCode, resolved.lines.join("\n")).toBe(0);
    const loser = await ticketFile(root, "T-009");
    expect(loser.setup).toEqual({ ...(src.setup as object), supersededBy: "T-002" });
    const after = await ticketFile(root, "T-002");
    // The winner was wired after the settlement; nothing but its blockedBy changed.
    expect({ ...after, blockedBy: [], updatedDate: null }).toEqual({ ...JSON.parse(winner), blockedBy: [], updatedDate: null });
  });
});
