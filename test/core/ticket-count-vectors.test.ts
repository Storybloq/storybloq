/**
 * ISS-1377 / ISS-1378: the shared ticket-count vectors. The Mac app's
 * `ProjectState` reads `test/fixtures/ticket-count-vectors.json` and must
 * compute the same counts, umbrella and phase progress and releases. The drift
 * test proves the file is the CLI's current output; the spot checks below are
 * written out by hand so a generator bug cannot pin itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VECTORS_OUT, buildVectors, serializeVectors } from "../../scripts/ticket-count-vectors.js";

const vectors = buildVectors();
const board = (name: string) => {
  const b = vectors.boards.find((x) => x.name === name);
  if (!b) throw new Error(`no board ${name}`);
  return b.expected;
};
const release = (name: string, id: string) => board(name).releases.filter((r) => r.id === id);

describe("ticket-count vectors", () => {
  it("the checked-in file is current", () => {
    expect(readFileSync(VECTORS_OUT, "utf-8")).toBe(serializeVectors());
  });

  it("dates follow the proleptic Gregorian calendar", () => {
    const valid = Object.fromEntries(vectors.dates.map((d) => [d.value, d.valid]));
    expect(valid["2024-02-29"]).toBe(true);
    expect(valid["2026-02-29"]).toBe(false);
    expect(valid["1900-02-29"]).toBe(false);
    expect(valid["2000-02-29"]).toBe(true);
    expect(valid["0000-02-29"]).toBe(true);
    expect(valid["2026-04-31"]).toBe(false);
    expect(valid["2026-1-01"]).toBe(false);
  });

  it("a duplicated id is excluded from the counts and never releases", () => {
    expect(board("duplicate id").counts).toMatchObject({ leaf: 3, terminal: 1, active: 2, blocked: 1 });
    expect(release("duplicate id", "T-001").map((r) => r.reason)).toEqual(["duplicate", "duplicate"]);
  });

  it("an effective withdrawal holds its dependents and a stale one does not", () => {
    expect(release("withdrawn and stale blockers", "T-050")[0]).toEqual({ id: "T-050", releases: false, reason: "withdrawn", detail: ["T-050"] });
    expect(release("withdrawn and stale blockers", "T-052")[0]).toMatchObject({ releases: true, reason: null });
    expect(board("withdrawn and stale blockers").counts).toMatchObject({ terminal: 4, delivered: 2, withdrawn: 2 });
  });

  it("umbrella progress counts active descendants and release still withholds", () => {
    expect(board("archived withdrawals").umbrellas).toEqual({ "T-093": { status: "notstarted", total: 1, complete: 0, withdrawn: 0 } });
    expect(release("archived withdrawals", "T-090")[0]).toMatchObject({ releases: false, reason: "withheld" });
    expect(board("mixed siblings").umbrellas["T-190"]).toEqual({ status: "notstarted", total: 1, complete: 0, withdrawn: 0 });
  });

  it("an omitted file holds the umbrella it names, after rule 0 and before the checkpoint rule", () => {
    expect(release("omitted child", "T-300")[0]).toEqual({ id: "T-300", releases: false, reason: "incomplete", detail: [".story/tickets/T-302.json"] });
    expect(release("omitted under another root", "T-350")[0]).toMatchObject({ releases: true, reason: null });
    expect(release("omitted beside checkpoint", "T-395")[0]).toMatchObject({ releases: false, reason: "incomplete" });
    expect(release("duplicated and omitted", "T-397").map((r) => r.reason)).toEqual(["duplicate", "duplicate"]);
  });

  it("a pending checkpoint keeps a stored-complete ticket out of the terminal count", () => {
    expect(board("checkpoints").counts).toMatchObject({ leaf: 14, terminal: 4, blocked: 3 });
    expect(release("checkpoints", "T-164")[0]).toMatchObject({ releases: false, reason: "checkpoint" });
  });
});
