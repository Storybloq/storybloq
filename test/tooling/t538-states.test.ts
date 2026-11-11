/**
 * T-538 commit 3 (plan v5 6.2): the milestone-states boundary rules, without a model. The live and regrade
 * routes share `statesFindings`; the stand-in run that drives each transition through the CLI is in
 * t538-s5a-variants.test.ts.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyStateParts, parseStateRecords, recomputeStates, STATE_BOUNDARIES, STATE_FILE, stateNames, stateRecord, statesFindings, statesText, type StateRecord } from "../../scripts/onboarding-eval-states.js";

const PKG = join(__dirname, "..", "..");
const V = "milestone-states";
const FOLLOW = "^Add tap to rota line";

/** A record set that passes every boundary: T-3 is the checkpoint, T-4 the dependent, T-2 the unrelated ready ticket. */
function passing(): StateRecord[] {
  const tickets = [{ id: "T-2", title: "Print the rota line", status: "open" }, { id: "T-3", title: "Watering rota demo", status: "open" }, { id: "T-4", title: "Rotate by weekday", status: "open" }];
  const rec = (at: string, state: string, events: string[], blocked: boolean, more: StateRecord["tickets"] = []): StateRecord => ({
    at, checkpoint: { id: "T-3", state, historyEvents: events }, dependent: { id: "T-4", blocked },
    ready: blocked ? ["T-2"] : ["T-2", "T-4"], blocked: blocked ? ["T-4"] : [], tickets: [...tickets, ...more],
  });
  return [
    rec("milestone-run", "pending", [], true),
    rec("demo-approval", "pending", [], true),
    rec("reopen", "approved", ["resolved"], false),
    rec("reapproval", "pending", ["resolved", "reopened"], true),
    rec("change-request", "approved", ["resolved", "reopened", "resolved"], false),
    rec("dependent-run", "pending", ["resolved", "reopened", "resolved", "changed"], true, [{ id: "T-5", title: "Add tap to rota line", status: "open" }]),
    rec("after-last", "pending", ["resolved", "reopened", "resolved", "changed"], true, [{ id: "T-5", title: "Add tap to rota line", status: "open" }]),
  ];
}
const at = (records: StateRecord[], n: number, over: Partial<StateRecord>): StateRecord[] => records.map((r, i) => (i === n ? { ...r, ...over } : r));

describe("statesFindings: each boundary's rule", () => {
  it("a run whose every boundary holds has no finding", () => {
    expect(statesFindings(passing(), FOLLOW)).toEqual([]);
    expect(STATE_BOUNDARIES).toEqual(passing().map((r) => r.at));
  });
  it("a missing capture fails its boundary, never passes it: none, one dropped, and the wrong label at a position", () => {
    expect(statesFindings(null, FOLLOW)).toEqual(STATE_BOUNDARIES.map((b, n) => `${V}: no state capture at boundary ${n} (${b})`));
    expect(statesFindings([], FOLLOW)).toHaveLength(STATE_BOUNDARIES.length);
    expect(statesFindings(passing().slice(0, 6), FOLLOW)).toEqual([`${V}: no state capture at boundary 6 (after-last)`]);
    const shifted = passing().filter((_, i) => i !== 3);
    expect(statesFindings(shifted, FOLLOW)).toEqual(expect.arrayContaining([`${V}: no state capture at boundary 3 (reapproval)`, `${V}: no state capture at boundary 4 (change-request)`]));
  });
  it("a capture with no checkpoint, no dependent, or a load error fails that boundary by name", () => {
    expect(statesFindings(at(passing(), 2, { checkpoint: null }), FOLLOW)).toEqual([`${V}: boundary 2 (reopen) holds no checkpoint`]);
    expect(statesFindings(at(passing(), 4, { dependent: null }), FOLLOW)).toEqual([`${V}: boundary 4 (change-request) holds no dependent`]);
    expect(statesFindings(at(passing(), 1, { error: "boom", checkpoint: null }), FOLLOW)).toEqual([`${V}: boundary 1 (demo-approval): the captured ledger could not be loaded (boom)`]);
  });
  it("boundary 0: pending, the dependent blocked and out of the ready list, and another ticket ready", () => {
    const p = passing();
    expect(statesFindings(at(p, 0, { checkpoint: { ...p[0]!.checkpoint!, state: "approved" } }), FOLLOW)).toEqual([`${V}: boundary 0 (milestone-run): the checkpoint is approved, not pending`]);
    expect(statesFindings(at(p, 0, { blocked: [] }), FOLLOW)).toEqual([`${V}: boundary 0 (milestone-run): the dependent T-4 is not blocked and out of the ready list`]);
    expect(statesFindings(at(p, 0, { ready: ["T-2", "T-4"] }), FOLLOW)).toEqual([`${V}: boundary 0 (milestone-run): the dependent T-4 is not blocked and out of the ready list`]);
    expect(statesFindings(at(p, 0, { ready: ["T-3"] }), FOLLOW)).toEqual([`${V}: boundary 0 (milestone-run): no other ticket is ready`]);
  });
  it("boundary 2: approved, and the dependent no longer held", () => {
    const p = passing();
    expect(statesFindings(at(p, 2, { checkpoint: { ...p[2]!.checkpoint!, state: "pending" } }), FOLLOW)).toEqual([`${V}: boundary 2 (reopen): the checkpoint is pending, not approved`]);
    expect(statesFindings(at(p, 2, { dependent: { id: "T-4", blocked: true } }), FOLLOW)).toEqual([`${V}: boundary 2 (reopen): the dependent T-4 is blocked by the checkpoint`]);
  });
  it("boundary 3: pending, the history ends reopened, the dependent held again", () => {
    const p = passing();
    expect(statesFindings(at(p, 3, { checkpoint: { ...p[3]!.checkpoint!, state: "approved" } }), FOLLOW)).toEqual([`${V}: boundary 3 (reapproval): the checkpoint is approved, not pending`]);
    expect(statesFindings(at(p, 3, { checkpoint: { ...p[3]!.checkpoint!, historyEvents: ["resolved", "changed"] } }), FOLLOW)).toEqual([`${V}: boundary 3 (reapproval): the checkpoint's history ends changed, not reopened`]);
    expect(statesFindings(at(p, 3, { checkpoint: { ...p[3]!.checkpoint!, historyEvents: [] } }), FOLLOW)).toEqual([`${V}: boundary 3 (reapproval): the checkpoint's history ends empty, not reopened`]);
    expect(statesFindings(at(p, 3, { dependent: { id: "T-4", blocked: false } }), FOLLOW)).toEqual([`${V}: boundary 3 (reapproval): the dependent T-4 is not blocked by the checkpoint`]);
  });
  it("boundary 4: approved again", () => {
    const p = passing();
    expect(statesFindings(at(p, 4, { checkpoint: { ...p[4]!.checkpoint!, state: "retired" } }), FOLLOW)).toEqual([`${V}: boundary 4 (change-request): the checkpoint is retired, not approved`]);
  });
  it("boundary 5: pending, the history ends changed, the dependent held, and the follow-up ticket exists", () => {
    const p = passing();
    expect(statesFindings(at(p, 5, { checkpoint: { ...p[5]!.checkpoint!, state: "approved" } }), FOLLOW)).toEqual([`${V}: boundary 5 (dependent-run): the checkpoint is approved, not pending`]);
    expect(statesFindings(at(p, 5, { checkpoint: { ...p[5]!.checkpoint!, historyEvents: ["resolved", "reopened"] } }), FOLLOW)).toEqual([`${V}: boundary 5 (dependent-run): the checkpoint's history ends reopened, not changed`]);
    expect(statesFindings(at(p, 5, { dependent: { id: "T-4", blocked: false } }), FOLLOW)).toEqual([`${V}: boundary 5 (dependent-run): the dependent T-4 is not blocked by the checkpoint`]);
    expect(statesFindings(at(p, 5, { tickets: p[0]!.tickets }), FOLLOW)).toEqual([`${V}: boundary 5 (dependent-run): no ticket's title matches the follow-up ${FOLLOW}`]);
    expect(statesFindings(p, null)).toEqual([`${V}: boundary 5 (dependent-run): no ticket's title matches the follow-up (none set)`]);
  });
  it("more captures than boundaries is a finding", () => {
    expect(statesFindings([...passing(), passing()[6]!], FOLLOW)).toEqual([`${V}: 8 state captures, more than the 7 boundaries`]);
  });
});

describe("state captures and records", () => {
  it("the records file round-trips and refuses another shape", () => {
    expect(parseStateRecords(statesText(passing()))).toEqual(passing());
    expect(() => parseStateRecords("[]")).toThrow("not {records: [...]}");
    expect(() => parseStateRecords(JSON.stringify({ records: [{ at: 1 }] }))).toThrow("a record is not a state record");
    expect(() => parseStateRecords("x")).toThrow();
  });
  it("copies only what work selection reads, as pinned replay names, and recomputes the same record from the copy", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538st-")));
    try {
      const story = join(dir, "story");
      mkdirSync(join(story, "tickets"), { recursive: true });
      mkdirSync(join(story, "issues"));
      mkdirSync(join(story, "handovers"));
      writeFileSync(join(story, "config.json"), JSON.stringify({ version: 2, schemaVersion: 1, project: "x", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }));
      writeFileSync(join(story, "roadmap.json"), JSON.stringify({ title: "x", date: "2026-01-01", phases: [{ id: "p1", label: "P1", name: "One", description: "d" }], blockers: [] }));
      const t = (id: string, blockedBy: string[]) => JSON.stringify({ id, title: id, type: "task", status: "open", phase: "p1", order: 10, description: "", createdDate: "2026-01-01", completedDate: null, blockedBy, parentTicket: null });
      writeFileSync(join(story, "tickets", "T-001.json"), t("T-001", []));
      writeFileSync(join(story, "tickets", "T-002.json"), t("T-002", ["T-001"]));
      writeFileSync(join(story, "handovers", "h.md"), "not copied\n");
      const raw = join(dir, "raw");
      const pins = copyStateParts(story, raw, 0);
      expect(pins.map((p) => p.path)).toEqual(["states/0/.story/tickets/T-001.json", "states/0/.story/tickets/T-002.json", "states/0/.story/config.json", "states/0/.story/roadmap.json"]);
      expect(pins.every((p) => STATE_FILE.test(p.path))).toBe(true);
      expect(stateNames(raw)).toEqual([...pins.map((p) => p.path)].sort());
      const r = await stateRecord(join(raw, "states", "0"), "milestone-run", null, "T-002");
      expect(r).toMatchObject({ at: "milestone-run", checkpoint: null, dependent: { id: "T-002", blocked: false }, ready: ["T-001"], blocked: ["T-002"] });
      expect(await recomputeStates(raw, [r], null)).toEqual([r]);
      // The copy is evidence: a broken one gives a record carrying the loader's refusal, never a thrown run.
      writeFileSync(join(raw, "states", "0", ".story", "config.json"), "{");
      const broken = await stateRecord(join(raw, "states", "0"), "milestone-run", null, "T-002");
      expect(broken).toMatchObject({ checkpoint: null, dependent: { id: "T-002", blocked: false }, ready: [], blocked: [] });
      expect(broken.error).toMatch(/\S/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("P7: a hash-id checkpoint referenced by its display id still holds the dependent, resolved as the product resolves it", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538st-")));
    try {
      const story = join(dir, ".story");
      mkdirSync(join(story, "tickets"), { recursive: true });
      writeFileSync(join(story, "config.json"), JSON.stringify({ version: 2, schemaVersion: 4, checkpointEnable: { at: "2026-11-10T00:00:00.000Z", step: "complete" }, project: "x", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }));
      writeFileSync(join(story, "roadmap.json"), JSON.stringify({ title: "x", date: "2026-11-10", phases: [{ id: "p0", label: "P0", name: "Setup", description: "d" }], blockers: [] }));
      const t = (id: string, extra: object) => JSON.stringify({ id, title: id, type: "task", status: "open", phase: "p0", order: 10, description: "", createdDate: "2026-11-10", completedDate: null, blockedBy: [], ...extra });
      const created = { at: "2026-11-10T00:00:01.000Z", by: "unknown", digest: "2c138b82ac142342c57c1a9b21cb18f25bc62ca937b49f59f3c548324e6e8ef3", event: "created", evidenceRefs: [], generation: 1, kind: "decision", question: "Ship?", revision: 1 };
      const ownerCheckpoint = { digest: created.digest, evidenceRefs: [], generation: 1, history: [created], kind: "decision", lifecycle: "active", owner: "owner", question: "Ship?", revision: 1 };
      const HASH = "t-0123456789abcdef";
      writeFileSync(join(story, "tickets", `${HASH}.json`), t(HASH, { displayId: "T-002", title: "Demo checkpoint", ownerCheckpoint, setup: { setupId: "SS-0a1b2c3d", key: "K2" } }));
      writeFileSync(join(story, "tickets", "T-001.json"), t("T-001", {}));
      writeFileSync(join(story, "tickets", "T-003.json"), t("T-003", { blockedBy: ["T-002"] }));
      const r = await stateRecord(dir, "milestone-run", { kind: "decision", owner: "owner" }, "T-003");
      expect(r.error).toBeUndefined();
      expect(r.checkpoint).toMatchObject({ id: HASH, state: "pending" });
      expect(r.dependent).toEqual({ id: "T-003", blocked: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a record is read from the copy with the product's loader and queries, never from CLI text", () => {
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-states.ts"), "utf-8");
    expect(src).not.toMatch(/child_process|spawn|execFile|execSync|dist\/cli/);
    expect(src).toMatch(/loadProjectNoRecover\(root\)/);
    expect(src).toMatch(/nextTickets\(state, 50\)/);
    expect(src).toMatch(/blockedTickets\(state\)/);
    expect(src).toMatch(/checkpointState\(cp\)/);
  });
});
