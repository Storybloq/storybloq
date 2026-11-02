/**
 * ISS-1405: a session gives back its own claim past a record that does not
 * parse, and nothing else does. Each path that ends a session's hold reports a
 * release that failed, and names the file a release was written past.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownClaimReleaseNote, releaseOwnClaim } from "../../src/core/own-claim-release.js";
import { prepareTicketWriteSeams, releaseOwnClaimUnlocked, withProjectLock } from "../../src/core/project-loader.js";
import type { Ticket } from "../../src/models/ticket.js";

const SID = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const own = { claimedBySession: SID };
const EARMARK_OWNER = { client: "claude", id: "task-1" };
const earmarkOf = (holderSession: string) => ({ stage: "assigned", holderRole: "worker", holderSession, reservedBy: EARMARK_OWNER, arrangementId: "a-0000000000000000", since: "2026-07-02T00:00:00.000Z" });

let root: string;
const ticketPath = (name = "T-001") => join(root, ".story", "tickets", `${name}.json`);
const readTicket = () => JSON.parse(readFileSync(ticketPath(), "utf-8")) as Record<string, unknown>;
const ticketJson = (extra: Record<string, unknown>) => JSON.stringify({
  id: "T-001", title: "Test ticket", description: "A test.", type: "task", status: "inprogress",
  phase: "p1", order: 10, createdDate: "2026-07-02", completedDate: null, blockedBy: [], ...extra,
});
const breakSibling = () => writeFileSync(ticketPath("T-009"), "{not json");

function strip(t: Ticket): Ticket {
  const { claimedBySession: _c, claim: _k, ...rest } = t as unknown as Record<string, unknown>;
  return { ...rest, status: "open" } as unknown as Ticket;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "own-claim-release-"));
  mkdirSync(join(root, ".story", "tickets"), { recursive: true });
  mkdirSync(join(root, ".story", "issues"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "t", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "t", date: "2026-07-02", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
});
afterEach(() => {
  try { chmodSync(ticketPath("T-009"), 0o644); } catch { /* not every case made it */ }
  rmSync(root, { recursive: true, force: true });
});

describe("what the release may write past a record that does not parse", () => {
  it("releases this session's own claim and names the record", async () => {
    writeFileSync(ticketPath(), ticketJson(own));
    breakSibling();
    const outcome = await releaseOwnClaim(root, "T-001", SID, strip);
    expect(outcome).toEqual({ kind: "released", file: ".story/tickets/T-001.json", writtenPast: [".story/tickets/T-009.json"] });
    expect(readTicket().claimedBySession).toBeUndefined();
    expect(readTicket().status).toBe("open");
    expect(ownClaimReleaseNote(outcome)).toContain(".story/tickets/T-009.json");
  });

  it("names nothing when no record was written past", async () => {
    writeFileSync(ticketPath(), ticketJson(own));
    const outcome = await releaseOwnClaim(root, "T-001", SID, strip);
    expect(outcome).toEqual({ kind: "released", file: ".story/tickets/T-001.json", writtenPast: [] });
    expect(ownClaimReleaseNote(outcome)).toBe("");
  });

  it.each([
    ["another session's claim", { claimedBySession: OTHER }, strip],
    ["a ticket with no claim at all", {}, strip],
    ["a write that gives nothing back", { claimedBySession: OTHER }, (t: Ticket) => t],
    ["a write that changes anything else", own, (t: Ticket) => ({ ...strip(t), title: "changed" }) as Ticket],
    ["a status other than open", own, (t: Ticket) => ({ ...strip(t), status: "complete" }) as Ticket],
    ["another session's earmark", { ...own, earmark: earmarkOf(OTHER) }, (t: Ticket) => ({ ...strip(t), earmark: null }) as Ticket],
  ])("refuses %s and names the ticket's file", async (_name, extra, decide) => {
    writeFileSync(ticketPath(), ticketJson(extra));
    const before = readFileSync(ticketPath(), "utf-8");
    breakSibling();
    const outcome = await releaseOwnClaim(root, "T-001", SID, decide);
    expect(outcome.kind).toBe("not-released");
    expect(readFileSync(ticketPath(), "utf-8")).toBe(before);
    const note = ownClaimReleaseNote(outcome);
    expect(note).toContain("NOT released");
    expect(note).toContain(".story/tickets/T-001.json");
    expect(note).toContain("T-009.json");
  });

  it("still refuses a misnamed claimant it can see", async () => {
    writeFileSync(ticketPath(), ticketJson(own));
    writeFileSync(ticketPath("T-050"), ticketJson(own));
    breakSibling();
    const before = readFileSync(ticketPath(), "utf-8");
    const outcome = await releaseOwnClaim(root, "T-001", SID, strip);
    expect(outcome.kind).toBe("not-released");
    expect(readFileSync(ticketPath(), "utf-8")).toBe(before);
    expect(ownClaimReleaseNote(outcome)).toContain("T-050.json");
  });

  const skipIfRoot = process.getuid?.() === 0 ? it.skip : it;
  skipIfRoot("does not write past a record it cannot read at all", async () => {
    writeFileSync(ticketPath(), ticketJson(own));
    writeFileSync(ticketPath("T-009"), "{}");
    chmodSync(ticketPath("T-009"), 0o000);
    const outcome = await releaseOwnClaim(root, "T-001", SID, strip);
    expect(outcome.kind).toBe("not-released");
    expect(readTicket().claimedBySession).toBe(SID);
    expect(ownClaimReleaseNote(outcome)).toContain("T-009.json");
  });

  it("leaves a completed ticket that carries a stale claim of this session unchanged", async () => {
    writeFileSync(ticketPath(), ticketJson({ ...own, status: "complete", completedDate: "2026-07-02" }));
    breakSibling();
    const before = readFileSync(ticketPath(), "utf-8");
    const outcome = await releaseOwnClaim(root, "T-001", SID, strip);
    expect(outcome.kind).toBe("not-released");
    expect(readFileSync(ticketPath(), "utf-8")).toBe(before);
  });

  it("a refusal other than the unparseable one never reaches the release path", async () => {
    writeFileSync(ticketPath(), ticketJson(own));
    const original = prepareTicketWriteSeams.readPrior;
    let calls = 0;
    prepareTicketWriteSeams.readPrior = async (path) => {
      calls += 1;
      if (calls === 1) throw new Error("injected refusal");
      return original(path);
    };
    try {
      const outcome = await releaseOwnClaim(root, "T-001", SID, strip);
      expect(outcome).toMatchObject({ kind: "not-released", reason: "injected refusal" });
      expect(readTicket().claimedBySession).toBe(SID);
    } finally {
      prepareTicketWriteSeams.readPrior = original;
    }
  });

  it("the release API checks the record on disk, not what its caller says was loaded", async () => {
    writeFileSync(ticketPath(), ticketJson({ claimedBySession: OTHER }));
    breakSibling();
    const forged = JSON.parse(ticketJson({ status: "open" })) as Ticket;
    await expect(withProjectLock(root, { strict: false }, async () => {
      await releaseOwnClaimUnlocked(forged, SID, root);
    })).rejects.toThrow(/T-009\.json/);
    expect(readTicket().claimedBySession).toBe(OTHER);
  });

  it("writes nothing when the decision is to write nothing, broken record or not", async () => {
    writeFileSync(ticketPath(), ticketJson(own));
    breakSibling();
    const before = readFileSync(ticketPath(), "utf-8");
    expect(await releaseOwnClaim(root, "T-001", SID, () => null)).toEqual({ kind: "no-write" });
    expect(await releaseOwnClaim(root, "T-404", SID, strip)).toEqual({ kind: "no-write" });
    expect(readFileSync(ticketPath(), "utf-8")).toBe(before);
  });
});

describe("the exemption has one door", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
  const users = (word: string) => files(src).filter((p) => readFileSync(p, "utf-8").includes(word)).map((p) => p.slice(src.length + 1)).sort();

  it("the bypass writer is private and only the release function calls the release API", () => {
    const loader = readFileSync(join(src, "core", "project-loader.ts"), "utf-8");
    expect(users("releaseOwnClaimUnlocked")).toEqual(["core/own-claim-release.ts", "core/project-loader.ts"]);
    expect(users("writeTicketPastUnparseable")).toEqual(["core/project-loader.ts"]);
    expect(loader).not.toMatch(/export[^\n]*writeTicketPastUnparseable/);
    expect(users("misnamedPastUnparseable")).toEqual(["core/project-loader.ts", "core/resolution-write-guard.ts"]);
    expect(loader.match(/misnamedPastUnparseable/g)).toHaveLength(2);
    expect(readFileSync(join(src, "core", "index.ts"), "utf-8")).not.toContain("own-claim-release");
  });

  it("the six paths that give a claim back all go through it", () => {
    expect(users("releaseOwnClaim(").filter((p) => !p.endsWith("own-claim-release.ts"))).toEqual([
      "autonomous/guide.ts", "autonomous/stages/code-review.ts", "autonomous/stages/handover.ts",
      "autonomous/stages/plan-review.ts", "autonomous/stages/plan.ts", "cli/commands/session-compact.ts",
    ]);
  });
});
