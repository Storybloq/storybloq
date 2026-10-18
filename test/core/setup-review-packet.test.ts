/**
 * T-536: the setup review packet. The reviewer reviews the source
 * requirements, the owner's answers and the evidence together with the plan,
 * and the whole packet is the revision a review certifies.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { normalizeBlock, PACKET_SECTIONS, parsePacket, SetupReviewUsageError } from "../../src/core/setup-review.js";
import { REVIEW_PACKET } from "../helpers/setup-review-fakes.js";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

describe("parsePacket (T-536)", () => {
  it("accepts the four sections in order and hashes the exact bytes", () => {
    const bytes = Buffer.from(REVIEW_PACKET);
    const packet = parsePacket(bytes);
    expect(PACKET_SECTIONS).toEqual(["Source requirements", "Owner answers and decisions", "Existing-state evidence", "Plan"]);
    expect(packet.revisionSha256).toBe(sha(bytes));
    expect(Object.keys(packet.sectionSha256s)).toEqual([...PACKET_SECTIONS]);
    expect(packet.sections.Plan.startsWith("Milestone 1: members can book and cancel")).toBe(true);
    expect(packet.sections["Existing-state evidence"]).toBe("none");
  });

  it("rejects a missing, reordered, duplicated, extra or empty section", () => {
    const without = REVIEW_PACKET.replace("## Existing-state evidence\nnone\n\n", "");
    expect(() => parsePacket(Buffer.from(without))).toThrow(SetupReviewUsageError);
    const reordered = REVIEW_PACKET.replace("## Owner answers and decisions\nD1: Who can sign in? -> Members only, by email link\n\n", "").replace("## Plan\n", "## Owner answers and decisions\nD1: x -> y\n\n## Plan\n");
    expect(() => parsePacket(Buffer.from(reordered.replace("## Existing-state evidence", "## Plan2")))).toThrow(SetupReviewUsageError);
    const swapped = REVIEW_PACKET.replace("## Source requirements", "## TMP").replace("## Owner answers and decisions", "## Source requirements").replace("## TMP", "## Owner answers and decisions");
    expect(() => parsePacket(Buffer.from(swapped))).toThrow(/order/);
    expect(() => parsePacket(Buffer.from(`${REVIEW_PACKET}\n## Plan\nagain\n`))).toThrow(SetupReviewUsageError);
    expect(() => parsePacket(Buffer.from(REVIEW_PACKET.replace("## Existing-state evidence\nnone", "## Existing-state evidence\n  \n")))).toThrow(/empty/);
    expect(() => parsePacket(Buffer.from(`preamble\n${REVIEW_PACKET}`))).toThrow(SetupReviewUsageError);
    expect(() => parsePacket(Buffer.from(REVIEW_PACKET.replace("## Plan", "## Plan\n## Notes")))).toThrow(SetupReviewUsageError);
    expect(() => parsePacket(Buffer.from([0xff, 0xfe, 0x00]))).toThrow(SetupReviewUsageError);
  });

  it("makes a changed requirement or owner answer a new revision, and the per-section hashes say which", () => {
    const base = parsePacket(Buffer.from(REVIEW_PACKET));
    const req = parsePacket(Buffer.from(REVIEW_PACKET.replace("one-hour slot (source", "two-hour slot (source")));
    const ans = parsePacket(Buffer.from(REVIEW_PACKET.replace("by email link", "by password")));
    expect(req.revisionSha256).not.toBe(base.revisionSha256);
    expect(ans.revisionSha256).not.toBe(base.revisionSha256);
    expect(req.sectionSha256s["Source requirements"]).not.toBe(base.sectionSha256s["Source requirements"]);
    expect(req.sectionSha256s.Plan).toBe(base.sectionSha256s.Plan);
    expect(ans.sectionSha256s["Owner answers and decisions"]).not.toBe(base.sectionSha256s["Owner answers and decisions"]);
  });
});

describe("normalizeBlock (T-536, the only normalisation rule 2 allows)", () => {
  it("turns CRLF into LF, strips trailing spaces and tabs, collapses blank runs and trims blank ends", () => {
    expect(normalizeBlock("\n\nA  \r\nB\t\n\n\n\nC\n\n")).toEqual(["A", "B", "", "C"]);
  });

  it("changes nothing else: case, bullets, inner spaces and Unicode stay", () => {
    expect(normalizeBlock("- a  b\n* A\nÉ")).toEqual(["- a  b", "* A", "É"]);
  });
});
