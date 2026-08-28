import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  findGateAck,
  readGateAcksForListing,
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
