/**
 * T-481 T2: the content projection and `touchUpdated`. updatedDate is stamped
 * only when a write changes content: updatedDate itself, an earmark and the
 * sweep's acquisition marker are not content, and the loader's displayId fill
 * is not a change.
 */
import { describe, it, expect } from "vitest";
import { contentProjection, touchUpdated } from "../../src/core/metadata-touch.js";

type Rec = Record<string, unknown>;
const DAY = "2026-10-17";
const earmark = {
  stage: "assigned", holderRole: "worker", holderSession: "11111111-1111-4111-8111-111111111111",
  reservedBy: { client: "claude", id: "test-session" }, arrangementId: "a-0123456789abcdef",
  since: "2026-08-28T00:00:00.000Z",
};
function prior(extra: Rec = {}): Rec {
  return {
    id: "T-001", displayId: "T-001", title: "Title", description: "", type: "task", status: "open",
    phase: "p1", order: 10, createdDate: "2020-01-01", completedDate: null, blockedBy: [],
    parentTicket: null, updatedDate: "2020-01-01", ...extra,
  };
}

describe("T-481 T2: touchUpdated", () => {
  it("a changed field stamps the given date", () => {
    expect(touchUpdated({ ...prior(), title: "New" }, prior(), DAY).updatedDate).toBe(DAY);
  });

  it("a no-op write does not stamp", () => {
    expect(touchUpdated(prior(), prior(), DAY).updatedDate).toBe("2020-01-01");
  });

  it("a different updatedDate alone is not a change", () => {
    expect(touchUpdated(prior({ updatedDate: "2021-05-05" }), prior(), DAY).updatedDate).toBe("2021-05-05");
  });

  it("key order is not a change", () => {
    const p = prior();
    const reordered = Object.fromEntries(Object.entries(p).reverse());
    expect(touchUpdated(reordered, p, DAY).updatedDate).toBe("2020-01-01");
  });

  it("a legacy prior with no displayId and an unchanged next (displayId filled by the loader) does not stamp", () => {
    const { displayId: _d, ...legacy } = prior();
    expect(touchUpdated(prior(), legacy, DAY).updatedDate).toBe("2020-01-01");
    expect(touchUpdated(prior({ displayId: null }), legacy, DAY).updatedDate).toBe("2020-01-01");
  });

  it("a real displayId change stamps", () => {
    expect(touchUpdated(prior({ displayId: "T-002" }), prior(), DAY).updatedDate).toBe(DAY);
    const { displayId: _d, ...legacy } = prior();
    expect(touchUpdated(prior({ displayId: "T-009" }), legacy, DAY).updatedDate).toBe(DAY);
  });

  it("an earmark-only change does not stamp, in either direction", () => {
    expect(touchUpdated(prior({ earmark }), prior(), DAY).updatedDate).toBe("2020-01-01");
    expect(touchUpdated(prior(), prior({ earmark }), DAY).updatedDate).toBe("2020-01-01");
    expect(touchUpdated(prior({ earmark: { ...earmark, stage: "reserved" } }), prior({ earmark }), DAY).updatedDate).toBe("2020-01-01");
  });

  it("a sweepAcquisition-only change does not stamp", () => {
    const acq = { sessionId: "s", transitionId: "t" };
    expect(touchUpdated(prior({ sweepAcquisition: acq }), prior(), DAY).updatedDate).toBe("2020-01-01");
    expect(touchUpdated(prior(), prior({ sweepAcquisition: acq }), DAY).updatedDate).toBe("2020-01-01");
  });

  it("an earmark change together with a claim stamps", () => {
    const next = prior({ earmark, claimedBySession: "s-1", status: "inprogress" });
    expect(touchUpdated(next, prior(), DAY).updatedDate).toBe(DAY);
  });

  it("a removed key is a change; an undefined member is not", () => {
    const { description: _x, ...dropped } = prior();
    expect(touchUpdated(dropped, prior(), DAY).updatedDate).toBe(DAY);
    expect(touchUpdated(prior({ extra: undefined }), prior(), DAY).updatedDate).toBe("2020-01-01");
  });

  it("no prior (a create) never stamps", () => {
    const { updatedDate: _u, ...fresh } = prior();
    expect(touchUpdated(fresh, null, DAY).updatedDate).toBeUndefined();
  });

  it("returns a copy and leaves its inputs alone", () => {
    const next = { ...prior(), title: "New" };
    const out = touchUpdated(next, prior(), DAY);
    expect(next.updatedDate).toBe("2020-01-01");
    expect(out).not.toBe(next);
  });
});

describe("T-481 T2: contentProjection", () => {
  it("drops updatedDate, earmark and sweepAcquisition, fills displayId, and sorts keys", () => {
    const { displayId: _d, ...legacy } = prior({ earmark, sweepAcquisition: { sessionId: "s", transitionId: "t" } });
    const proj = contentProjection(legacy);
    const parsed = JSON.parse(proj) as Rec;
    expect(parsed.updatedDate).toBeUndefined();
    expect(parsed.earmark).toBeUndefined();
    expect(parsed.sweepAcquisition).toBeUndefined();
    expect(parsed.displayId).toBe("T-001");
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });
});
