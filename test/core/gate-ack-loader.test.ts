import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  findGateAck,
  readGateAcksForListing,
  readGateAcksForTicket,
  writeGateAckUnlocked,
  writeGateAckContested,
} from "../../src/core/gate-ack-loader.js";
import { computeGateAckId, type GateAck, type GateAckPin } from "../../src/models/gate-ack.js";

const PIN: GateAckPin = { kind: "plan-hash", sha256: "a".repeat(64) };
const ARRANGEMENT_ID = "a-0123456789abcdef";
const GATE_NAME = "plan-ack";
const TICKET_REF = "t-0123456789abcdef";

function baseAck(overrides: Partial<GateAck> = {}): GateAck {
  return {
    id: computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN),
    arrangementId: ARRANGEMENT_ID,
    gateName: GATE_NAME,
    ackRole: "pen",
    ticketRef: TICKET_REF,
    pin: PIN,
    decidedAt: "2026-08-28T00:00:00.000Z",
    reviewTrail: { present: false },
    contested: false,
    ...overrides,
  } as GateAck;
}

const QUERY = { arrangementId: ARRANGEMENT_ID, gateName: GATE_NAME, ticketRef: TICKET_REF, pin: PIN, expectedAckRole: "pen" as const };

describe("findGateAck", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gate-ack-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns absent when the computed path does not exist", () => {
    expect(findGateAck(root, QUERY)).toEqual({ status: "absent" });
  });

  it("returns absent when .story/arrangement-acks/ itself does not exist", () => {
    expect(findGateAck(root, QUERY).status).toBe("absent");
  });

  it("finds a valid ack written via writeGateAckUnlocked", async () => {
    await writeGateAckUnlocked(baseAck(), root);
    const result = findGateAck(root, QUERY);
    expect(result.status).toBe("valid");
  });

  it("returns unreadable for a file over the size ceiling", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    await mkdir(dir, { recursive: true });
    const id = computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN);
    await writeFile(join(dir, `${id}.json`), "x".repeat(65_536 + 1));
    expect(findGateAck(root, QUERY).status).toBe("unreadable");
  });

  it("returns unreadable for invalid JSON", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    await mkdir(dir, { recursive: true });
    const id = computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN);
    await writeFile(join(dir, `${id}.json`), "{not json");
    expect(findGateAck(root, QUERY).status).toBe("unreadable");
  });

  it("returns unreadable for a schema mismatch", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    await mkdir(dir, { recursive: true });
    const id = computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN);
    await writeFile(join(dir, `${id}.json`), JSON.stringify({ id, lifecycle: "active" }));
    expect(findGateAck(root, QUERY).status).toBe("unreadable");
  });

  it("returns unreadable when a record field doesn't match the query (direct-field-mismatch, distinct from id mismatch)", async () => {
    await writeGateAckUnlocked(baseAck(), root);
    // Same id (computed the same way) but query a DIFFERENT gate name --
    // findGateAck recomputes its own id from the QUERY, so this actually
    // looks up a different path (absent) UNLESS we hand-edit the file at the
    // originally-computed path to claim a field it doesn't own.
    const dir = join(root, ".story", "arrangement-acks");
    const id = computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN);
    const tampered = { ...baseAck(), gateName: "pre-commit-ack" }; // record's OWN gateName no longer matches its filename's implied identity
    await writeFile(join(dir, `${id}.json`), JSON.stringify(tampered));
    expect(findGateAck(root, QUERY).status).toBe("unreadable");
  });

  it("returns unreadable on an ackRole mismatch", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    await mkdir(dir, { recursive: true });
    const id = computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN);
    await writeFile(join(dir, `${id}.json`), JSON.stringify(baseAck({ ackRole: "worker" })));
    expect(findGateAck(root, { ...QUERY, expectedAckRole: "pen" }).status).toBe("unreadable");
  });

  it("returns contested for a contested record", async () => {
    await writeGateAckUnlocked(baseAck(), root);
    const id = computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN);
    await writeGateAckContested(id, "pin was wrong", root);
    expect(findGateAck(root, QUERY).status).toBe("contested");
  });

  it.skipIf(platform() === "win32")("returns unreadable for a symlink rather than following it", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    await mkdir(dir, { recursive: true });
    const id = computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN);
    const target = join(root, "outside.json");
    await writeFile(target, JSON.stringify(baseAck()));
    await symlink(target, join(dir, `${id}.json`));
    expect(findGateAck(root, QUERY).status).toBe("unreadable");
  });
});

describe("writeGateAckUnlocked", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gate-ack-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a new record", async () => {
    const ack = await writeGateAckUnlocked(baseAck(), root);
    expect(ack.id).toBe(computeGateAckId(ARRANGEMENT_ID, GATE_NAME, TICKET_REF, PIN));
  });

  it("is idempotent: an identical retry (same deltas) returns the existing record without rewriting it", async () => {
    await writeGateAckUnlocked(baseAck(), root);
    const second = await writeGateAckUnlocked(baseAck(), root);
    expect(second.decidedAt).toBe("2026-08-28T00:00:00.000Z");
    // no throw -- the whole point of this test
  });

  it("throws a conflict when a retry at the same pin carries DIFFERENT deltas", async () => {
    await writeGateAckUnlocked(baseAck({ deltas: "first condition" }), root);
    await expect(writeGateAckUnlocked(baseAck({ deltas: "second, different condition" }), root)).rejects.toThrow(/conflict/);
  });
});

describe("writeGateAckContested", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gate-ack-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("marks an existing ack contested with a reason", async () => {
    const ack = await writeGateAckUnlocked(baseAck(), root);
    const updated = await writeGateAckContested(ack.id, "the pin was based on a stale plan", root);
    expect(updated.contested).toBe(true);
    expect(updated.contestedReason).toBe("the pin was based on a stale plan");
  });

  it("throws for a nonexistent id", async () => {
    await expect(writeGateAckContested("g-0000000000000000", "reason", root)).rejects.toThrow();
  });
});

describe("readGateAcksForListing", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gate-ack-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns empty with no warnings when the directory does not exist", () => {
    expect(readGateAcksForListing(root)).toEqual({ acks: [], warnings: [] });
  });

  it("lists a valid ack alongside a warning for a broken one", async () => {
    await writeGateAckUnlocked(baseAck(), root);
    const dir = join(root, ".story", "arrangement-acks");
    await writeFile(join(dir, "g-broken0000000.json"), "{not json");
    const result = readGateAcksForListing(root);
    expect(result.acks).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

});

describe("readGateAcksForTicket", () => {
  let root: string;
  const OTHER_TICKET_REF = "t-fedcba9876543210";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gate-ack-loader-"));
    await mkdir(join(root, ".story", "arrangement-acks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns empty with no warnings when the directory does not exist", async () => {
    await rm(join(root, ".story", "arrangement-acks"), { recursive: true, force: true });
    expect(readGateAcksForTicket(root, TICKET_REF)).toEqual({ acks: [], scopedWarnings: [], unattributedWarnings: [] });
  });

  it("includes a valid ack for this ticket and excludes a valid ack for a different ticket", async () => {
    await writeGateAckUnlocked(baseAck(), root);
    await writeGateAckUnlocked(baseAck({
      id: computeGateAckId(ARRANGEMENT_ID, GATE_NAME, OTHER_TICKET_REF, PIN),
      ticketRef: OTHER_TICKET_REF,
    }), root);
    const result = readGateAcksForTicket(root, TICKET_REF);
    expect(result.acks).toHaveLength(1);
    expect(result.acks[0]!.ticketRef).toBe(TICKET_REF);
    expect(result.scopedWarnings).toEqual([]);
    expect(result.unattributedWarnings).toEqual([]);
  });

  it("scopes a warning to this ticket when the broken record's own ticketRef names it", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    // Schema-mismatch (pin missing required fields) but ticketRef is a plain, extractable string.
    await writeFile(
      join(dir, "g-scopedbroken000.json"),
      JSON.stringify({ id: "g-scopedbroken000", arrangementId: ARRANGEMENT_ID, gateName: GATE_NAME, ackRole: "pen", ticketRef: TICKET_REF, pin: { kind: "plan-hash" } }),
    );
    const result = readGateAcksForTicket(root, TICKET_REF);
    expect(result.acks).toEqual([]);
    expect(result.scopedWarnings).toHaveLength(1);
    expect(result.unattributedWarnings).toEqual([]);
  });

  describe("alias-set attribution (T-477 round-4 cap escalation, acceptor's ruling)", () => {
    async function writeOtherTicketBroken(root: string): Promise<void> {
      const dir = join(root, ".story", "arrangement-acks");
      await writeFile(
        join(dir, "g-otherbroken0000.json"),
        JSON.stringify({ id: "g-otherbroken0000", arrangementId: ARRANGEMENT_ID, gateName: GATE_NAME, ackRole: "pen", ticketRef: OTHER_TICKET_REF, pin: { kind: "plan-hash" } }),
      );
    }

    it("branch: shaped-unknown -- with NO resolver (or one that cannot confirm the ref as a real known ticket), a ticket-shaped-but-non-matching ref is FAIL-CLOSED to unattributed, never silently excluded", async () => {
      await writeOtherTicketBroken(root);
      const result = readGateAcksForTicket(root, TICKET_REF); // default resolver: confirms nothing
      expect(result.acks).toEqual([]);
      expect(result.scopedWarnings).toEqual([]);
      expect(result.unattributedWarnings).toHaveLength(1);
    });

    it("branch: known-other -- a ref a resolver CONFIRMS is a different real ticket is excluded entirely, not tainting either bucket", async () => {
      await writeOtherTicketBroken(root);
      const resolveKnownOther = (raw: string) => (raw === OTHER_TICKET_REF ? OTHER_TICKET_REF : null);
      const result = readGateAcksForTicket(root, TICKET_REF, resolveKnownOther);
      expect(result.acks).toEqual([]);
      expect(result.scopedWarnings).toEqual([]);
      expect(result.unattributedWarnings).toEqual([]);
    });

    it("branch: alias-match -- a raw ticketRef that is a DIFFERENT alias of THIS SAME ticket (e.g. a display id when queried by canonical id) is scoped here, not excluded or unattributed", async () => {
      const DISPLAY_ALIAS = "T-477";
      const dir = join(root, ".story", "arrangement-acks");
      await writeFile(
        join(dir, "g-aliasbroken0000.json"),
        JSON.stringify({ id: "g-aliasbroken0000", arrangementId: ARRANGEMENT_ID, gateName: GATE_NAME, ackRole: "pen", ticketRef: DISPLAY_ALIAS, pin: { kind: "plan-hash" } }),
      );
      // Simulates ProjectState.resolveTicketRef: the display alias resolves to the SAME canonical ticket being queried.
      const resolveSameTicketAlias = (raw: string) => (raw === DISPLAY_ALIAS ? TICKET_REF : null);
      const result = readGateAcksForTicket(root, TICKET_REF, resolveSameTicketAlias);
      expect(result.acks).toEqual([]);
      expect(result.scopedWarnings).toHaveLength(1);
      expect(result.unattributedWarnings).toEqual([]);
    });
  });

  it("a raw ticketRef that is present but NOT ticket-shaped (empty, or garbage text) is unattributed, not silently excluded as if it named a real ticket", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    await writeFile(
      join(dir, "g-emptyref00000000.json"),
      JSON.stringify({ id: "g-emptyref00000000", arrangementId: ARRANGEMENT_ID, gateName: GATE_NAME, ackRole: "pen", ticketRef: "", pin: { kind: "plan-hash" } }),
    );
    await writeFile(
      join(dir, "g-garbageref0000000.json"),
      JSON.stringify({ id: "g-garbageref0000000", arrangementId: ARRANGEMENT_ID, gateName: GATE_NAME, ackRole: "pen", ticketRef: "not-a-ticket-shape", pin: { kind: "plan-hash" } }),
    );
    const result = readGateAcksForTicket(root, TICKET_REF);
    expect(result.acks).toEqual([]);
    expect(result.scopedWarnings).toEqual([]);
    expect(result.unattributedWarnings).toHaveLength(2);
  });

  it("surfaces an unparseable file as unattributed rather than tainting this ticket's coverage", async () => {
    const dir = join(root, ".story", "arrangement-acks");
    await writeFile(join(dir, "g-corrupt0000000.json"), "{not json");
    const result = readGateAcksForTicket(root, TICKET_REF);
    expect(result.acks).toEqual([]);
    expect(result.scopedWarnings).toEqual([]);
    expect(result.unattributedWarnings).toHaveLength(1);
  });

  it("readGateAcksForListing remains unaffected by the new scoped function (shared scan, unchanged signature)", async () => {
    await writeGateAckUnlocked(baseAck(), root);
    const dir = join(root, ".story", "arrangement-acks");
    await writeFile(join(dir, "g-broken0000001.json"), "{not json");
    const listing = readGateAcksForListing(root);
    expect(listing.acks).toHaveLength(1);
    expect(listing.warnings).toHaveLength(1);
  });
});
