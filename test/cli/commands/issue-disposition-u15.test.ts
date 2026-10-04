/**
 * T-486 U1-5: the disposition setter (S3-S5), the A to B to A residual
 * (E-ABA), and the plan 5b validate warnings assigned to this slice by pen
 * ruling (duplicate without duplicateOf, dangling or self duplicateOf,
 * unresolvable dispositionRef).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { validateProject } from "../../../src/core/validation.js";
import { dispositionEvidenceView, dispositionRefForm } from "../../../src/core/resolution-kind.js";
import { loadRulingsSafe } from "../../../src/core/ruling-loader.js";
import { handleIssueCreate, handleIssueUpdate } from "../../../src/cli/commands/issue.js";
import { handleRulingCreate } from "../../../src/cli/commands/ruling.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "t486-u15-"));
  roots.push(dir);
  await initProject(dir, { name: "t486" });
  return dir;
}

async function createIssue(dir: string, title: string): Promise<string> {
  const r = await handleIssueCreate(
    { title, severity: "medium", impact: "", components: [], relatedTickets: [], location: [] },
    "json",
    dir,
  );
  return (JSON.parse(r.output) as { data: { id: string } }).data.id;
}

const pathOf = (dir: string, id: string): string => join(dir, ".story", "issues", `${id}.json`);
const raw = (dir: string, id: string): Record<string, unknown> => JSON.parse(readFileSync(pathOf(dir, id), "utf-8")) as Record<string, unknown>;
const writeRaw = (dir: string, id: string, record: Record<string, unknown>): void => writeFileSync(pathOf(dir, id), JSON.stringify(record, null, 2) + "\n");
/** A team-mode tombstone, as `issue delete` writes it on a team board. */
const tombstone = (dir: string, id: string): void =>
  writeRaw(dir, id, { ...raw(dir, id), lifecycle: "deleted", deletedAt: "2026-10-04T00:00:00.000Z", deletedBy: "t486" });
const issueBytes = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(join(dir, ".story", "issues")).map((f) => [f, readFileSync(join(dir, ".story", "issues", f), "utf-8")]));

/** Expects the update to be refused with `code` and to change no issue byte. */
async function refused(dir: string, id: string, updates: Parameters<typeof handleIssueUpdate>[1], code: string, message: RegExp): Promise<void> {
  const before = issueBytes(dir);
  await expect(handleIssueUpdate(id, updates, "json", dir)).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
  expect(issueBytes(dir)).toEqual(before);
}

const EVIDENCE_KEYS = ["disposition", "dispositionReason", "dispositionRef", "dispositionFor"] as const;

describe("S3: a disposition is written with its reason and ref, never alone", () => {
  it("writes all four keys, binding the evidence to the disposition", async () => {
    const dir = await project();
    const ref = await createIssue(dir, "the decision record");
    const id = await createIssue(dir, "needs an owner call");
    await handleIssueUpdate(id, { disposition: "owner_gated", dispositionReason: "pricing", dispositionRef: ref }, "json", dir);
    expect(raw(dir, id)).toMatchObject({ disposition: "owner_gated", dispositionReason: "pricing", dispositionRef: ref, dispositionFor: "owner_gated" });
    expect(dispositionEvidenceView(raw(dir, id)).state).toBe("effective");
  });

  it.each([
    ["no reason", { dispositionRef: "ISS-001" }, /needs --reason:/],
    ["a blank reason", { dispositionReason: "  ", dispositionRef: "ISS-001" }, /needs --reason:/],
    ["no ref", { dispositionReason: "why" }, /needs --ref:/],
    ["neither", {}, /needs --reason and --ref:/],
  ])("refuses %s and writes nothing", async (_name, extra, message) => {
    const dir = await project();
    const id = await createIssue(dir, "needs an owner call");
    await refused(dir, id, { disposition: "owner_gated", ...extra }, "invalid_input", message);
  });

  it("refuses a reason or ref without a disposition", async () => {
    const dir = await project();
    const id = await createIssue(dir, "x");
    await refused(dir, id, { dispositionReason: "why" }, "invalid_input", /pass the disposition too/);
    await refused(dir, id, { dispositionRef: "ISS-001" }, "invalid_input", /pass the disposition too/);
  });

  it("refuses an unknown disposition value", async () => {
    const dir = await project();
    const id = await createIssue(dir, "x");
    await refused(dir, id, { disposition: "parked", dispositionReason: "why", dispositionRef: "ISS-001" }, "invalid_input", /Unknown disposition "parked"/);
  });

  it("duplicate needs a duplicateOf that resolves, and stores it with the evidence", async () => {
    const dir = await project();
    const original = await createIssue(dir, "the original");
    const id = await createIssue(dir, "the copy");
    await refused(dir, id, { disposition: "duplicate", dispositionReason: "same bug", dispositionRef: original }, "invalid_input", /needs --duplicate-of/);
    await handleIssueUpdate(id, { disposition: "duplicate", dispositionReason: "same bug", dispositionRef: original, duplicateOf: original }, "json", dir);
    expect(raw(dir, id)).toMatchObject({ disposition: "duplicate", duplicateOf: original, dispositionFor: "duplicate" });
  });
});

describe("S4: the ref names something that exists, and the canonical id is stored", () => {
  /** A hash-filename issue whose display id differs from its canonical id. */
  async function hashIssue(dir: string): Promise<{ id: string; displayId: string }> {
    const seed = await createIssue(dir, "seed");
    const id = "i-0000000000000050";
    writeRaw(dir, id, { ...raw(dir, seed), id, displayId: "ISS-050", title: "the hash-file record" });
    return { id, displayId: "ISS-050" };
  }

  it("accepts the display id and the canonical id, and stores the canonical one both times", async () => {
    const dir = await project();
    const target = await hashIssue(dir);
    const id = await createIssue(dir, "needs an owner call");
    await handleIssueUpdate(id, { disposition: "owner_gated", dispositionReason: "r", dispositionRef: target.displayId }, "json", dir);
    expect(raw(dir, id).dispositionRef).toBe(target.id);
    await handleIssueUpdate(id, { disposition: "escalate_only", dispositionReason: "r2", dispositionRef: target.id }, "json", dir);
    expect(raw(dir, id)).toMatchObject({ dispositionRef: target.id, dispositionFor: "escalate_only" });
  });

  it("refuses a ref that names nothing", async () => {
    const dir = await project();
    const id = await createIssue(dir, "x");
    await refused(dir, id, { disposition: "owner_gated", dispositionReason: "r", dispositionRef: "ISS-999" }, "not_found", /names no ticket, issue, note, lesson or ruling/);
  });

  it("refuses a ref to a deleted item", async () => {
    const dir = await project();
    const gone = await createIssue(dir, "deleted later");
    tombstone(dir, gone);
    const id = await createIssue(dir, "x");
    await refused(dir, id, { disposition: "owner_gated", dispositionReason: "r", dispositionRef: gone }, "invalid_input", /is deleted/);
  });

  it("accepts a git sha and an https URL by syntax, and refuses an https string that is not a URL", async () => {
    const dir = await project();
    const id = await createIssue(dir, "x");
    await handleIssueUpdate(id, { disposition: "owner_gated", dispositionReason: "r", dispositionRef: "f800f795" }, "json", dir);
    expect(raw(dir, id).dispositionRef).toBe("f800f795");
    await handleIssueUpdate(id, { disposition: "owner_gated", dispositionReason: "r", dispositionRef: "https://example.com/decision" }, "json", dir);
    expect(raw(dir, id).dispositionRef).toBe("https://example.com/decision");
    await refused(dir, id, { disposition: "owner_gated", dispositionReason: "r", dispositionRef: "https://exa mple.com" }, "invalid_input", /not a valid https URL/);
  });

  it("accepts a ruling id", async () => {
    const dir = await project();
    const created = await handleRulingCreate({ text: "Verbatim ruling text.", attribution: "owner-direct", date: "2026-10-04", scopeTags: [], clientTaskId: "t486-u15" }, "json", dir);
    const rulingId = (JSON.parse(created.output) as { data: { id: string } }).data.id;
    const id = await createIssue(dir, "x");
    await handleIssueUpdate(id, { disposition: "owner_gated", dispositionReason: "r", dispositionRef: rulingId }, "json", dir);
    expect(raw(dir, id).dispositionRef).toBe(rulingId);
  });

  it("dispositionRefForm classifies by syntax", () => {
    expect(dispositionRefForm("abcdef1")).toBe("sha");
    expect(dispositionRefForm("abcdef")).toBe("item");
    expect(dispositionRefForm("https://example.com")).toBe("url");
    expect(dispositionRefForm("https://exa mple.com")).toBe("bad-url");
    expect(dispositionRefForm("http://example.com")).toBe("item");
  });
});

describe("S5: clearing removes the disposition with all of its evidence", () => {
  it("deletes all four keys, dispositionFor included, and duplicateOf with them", async () => {
    const dir = await project();
    const original = await createIssue(dir, "the original");
    const id = await createIssue(dir, "the copy");
    await handleIssueUpdate(id, { disposition: "duplicate", dispositionReason: "same bug", dispositionRef: original, duplicateOf: original }, "json", dir);
    await handleIssueUpdate(id, { disposition: null }, "json", dir);
    const after = raw(dir, id);
    for (const key of [...EVIDENCE_KEYS, "duplicateOf"]) expect(Object.prototype.hasOwnProperty.call(after, key), key).toBe(false);
  });

  it("keeps duplicateOf when the issue is resolved as a duplicate", async () => {
    const dir = await project();
    const original = await createIssue(dir, "the original");
    const id = await createIssue(dir, "the copy");
    await handleIssueUpdate(id, { disposition: "duplicate", dispositionReason: "same bug", dispositionRef: original, duplicateOf: original }, "json", dir);
    await handleIssueUpdate(id, { status: "resolved", resolution: "Duplicate of the original.", resolutionKind: "duplicate" }, "json", dir);
    await handleIssueUpdate(id, { disposition: null }, "json", dir);
    const after = raw(dir, id);
    for (const key of EVIDENCE_KEYS) expect(Object.prototype.hasOwnProperty.call(after, key), key).toBe(false);
    expect(after.duplicateOf).toBe(original);
  });

  it("refuses a clear combined with a reason, a ref, or a duplicate-of", async () => {
    const dir = await project();
    const original = await createIssue(dir, "the original");
    const id = await createIssue(dir, "x");
    await refused(dir, id, { disposition: null, dispositionReason: "r" }, "invalid_input", /do not pass --reason or --ref/);
    await refused(dir, id, { disposition: null, dispositionRef: original }, "invalid_input", /do not pass --reason or --ref/);
    await refused(dir, id, { disposition: null, duplicateOf: original }, "invalid_input", /do not pass --duplicate-of with it/);
  });
});

describe("E-ABA (residual 2): evidence written for A shows again once A holds again", () => {
  it("is unbound while the disposition is B, and effective again when a raw writer returns it to A", async () => {
    const dir = await project();
    const ref = await createIssue(dir, "the decision record");
    const id = await createIssue(dir, "needs an owner call");
    await handleIssueUpdate(id, { disposition: "owner_gated", dispositionReason: "pricing", dispositionRef: ref }, "json", dir);
    const a = raw(dir, id);
    writeRaw(dir, id, { ...a, disposition: "escalate_only" });
    expect(dispositionEvidenceView(raw(dir, id)).state).toBe("unbound");
    writeRaw(dir, id, { ...a, disposition: "owner_gated" });
    expect(dispositionEvidenceView(raw(dir, id))).toEqual({ reason: "pricing", ref, state: "effective" });
    const { state } = await loadProject(dir);
    expect(validateProject(state).findings.filter((f) => f.entity === id && f.code.startsWith("disposition_"))).toEqual([]);
  });
});

describe("plan 5b validate warnings (assigned to U1-5 by pen ruling)", () => {
  async function findings(dir: string, withRulings = false) {
    const { state } = await loadProject(dir);
    return validateProject(state, undefined, withRulings ? { rulings: loadRulingsSafe(dir).rulings } : {}).findings;
  }
  const codesFor = (list: Awaited<ReturnType<typeof findings>>, id: string, prefix: string) =>
    list.filter((f) => f.entity === id && f.code.startsWith(prefix)).map((f) => ({ code: f.code, message: f.message }));

  it("duplicate_without_target: a duplicate disposition with no duplicateOf", async () => {
    const dir = await project();
    const id = await createIssue(dir, "x");
    writeRaw(dir, id, { ...raw(dir, id), disposition: "duplicate" });
    expect(codesFor(await findings(dir), id, "duplicate_")).toEqual([
      { code: "duplicate_without_target", message: `Issue ${id} is marked a duplicate but has no duplicateOf naming what it duplicates.` },
    ]);
  });

  it("duplicate_without_target: an effective duplicate resolution kind with no duplicateOf", async () => {
    const dir = await project();
    const original = await createIssue(dir, "the original");
    const id = await createIssue(dir, "the copy");
    await handleIssueUpdate(id, { status: "resolved", resolution: "Duplicate.", resolutionKind: "duplicate", duplicateOf: original }, "json", dir);
    const { duplicateOf: _d, ...without } = raw(dir, id);
    writeRaw(dir, id, without);
    expect(codesFor(await findings(dir), id, "duplicate_").map((f) => f.code)).toEqual(["duplicate_without_target"]);
  });

  it("duplicate_of_dangling: names nothing, or a deleted item; duplicate_of_self: names the issue itself", async () => {
    const dir = await project();
    const gone = await createIssue(dir, "deleted later");
    tombstone(dir, gone);
    const a = await createIssue(dir, "a");
    const b = await createIssue(dir, "b");
    const c = await createIssue(dir, "c");
    writeRaw(dir, a, { ...raw(dir, a), duplicateOf: "ISS-999" });
    writeRaw(dir, b, { ...raw(dir, b), duplicateOf: gone });
    writeRaw(dir, c, { ...raw(dir, c), duplicateOf: c });
    const list = await findings(dir);
    expect(codesFor(list, a, "duplicate_")).toEqual([{ code: "duplicate_of_dangling", message: `Issue ${a} has duplicateOf "ISS-999" that names no ticket or issue.` }]);
    expect(codesFor(list, b, "duplicate_")).toEqual([{ code: "duplicate_of_dangling", message: `Issue ${b} has duplicateOf "${gone}" that names a deleted item.` }]);
    expect(codesFor(list, c, "duplicate_")).toEqual([{ code: "duplicate_of_self", message: `Issue ${c} has duplicateOf naming the issue itself.` }]);
  });

  it("a live duplicateOf is silent", async () => {
    const dir = await project();
    const original = await createIssue(dir, "the original");
    const id = await createIssue(dir, "the copy");
    await handleIssueUpdate(id, { disposition: "duplicate", dispositionReason: "same", dispositionRef: original, duplicateOf: original }, "json", dir);
    expect(codesFor(await findings(dir), id, "duplicate_")).toEqual([]);
    expect(codesFor(await findings(dir), id, "disposition_")).toEqual([]);
  });

  it("disposition_ref_unresolved: an effective ref that names nothing, a deleted item, or a broken https URL", async () => {
    const dir = await project();
    const gone = await createIssue(dir, "deleted later");
    tombstone(dir, gone);
    const ids = [await createIssue(dir, "a"), await createIssue(dir, "b"), await createIssue(dir, "c")];
    const refs = ["ISS-999", gone, "https://exa mple.com"];
    ids.forEach((id, n) => writeRaw(dir, id, { ...raw(dir, id), disposition: "owner_gated", dispositionReason: "r", dispositionRef: refs[n], dispositionFor: "owner_gated" }));
    const list = await findings(dir);
    expect(codesFor(list, ids[0]!, "disposition_")).toEqual([
      { code: "disposition_ref_unresolved", message: `Issue ${ids[0]} has a disposition ref "ISS-999" that names no ticket, issue, note, lesson or ruling, and is not a git sha or an https URL.` },
    ]);
    expect(codesFor(list, ids[1]!, "disposition_")).toEqual([{ code: "disposition_ref_unresolved", message: `Issue ${ids[1]} has a disposition ref "${gone}" that names a deleted item.` }]);
    expect(codesFor(list, ids[2]!, "disposition_")).toEqual([{ code: "disposition_ref_unresolved", message: `Issue ${ids[2]} has a disposition ref "https://exa mple.com" that is not a valid https URL.` }]);
  });

  it("an unbound or malformed ref is left to the evidence warnings, and a sha is accepted", async () => {
    const dir = await project();
    const a = await createIssue(dir, "a");
    const b = await createIssue(dir, "b");
    writeRaw(dir, a, { ...raw(dir, a), disposition: "escalate_only", dispositionReason: "r", dispositionRef: "ISS-999", dispositionFor: "owner_gated" });
    writeRaw(dir, b, { ...raw(dir, b), disposition: "owner_gated", dispositionReason: "r", dispositionRef: "f800f795", dispositionFor: "owner_gated" });
    const list = await findings(dir);
    expect(codesFor(list, a, "disposition_").map((f) => f.code)).toEqual(["disposition_evidence_unbound"]);
    expect(codesFor(list, b, "disposition_")).toEqual([]);
  });

  it("a ruling-shaped ref is checked only when the rulings are loaded", async () => {
    const dir = await project();
    const created = await handleRulingCreate({ text: "Verbatim ruling text.", attribution: "owner-direct", date: "2026-10-04", scopeTags: [], clientTaskId: "t486-u15" }, "json", dir);
    const live = (JSON.parse(created.output) as { data: { id: string } }).data.id;
    const missing = "r-0000000000000000";
    const a = await createIssue(dir, "a");
    const b = await createIssue(dir, "b");
    writeRaw(dir, a, { ...raw(dir, a), disposition: "owner_gated", dispositionReason: "r", dispositionRef: live, dispositionFor: "owner_gated" });
    writeRaw(dir, b, { ...raw(dir, b), disposition: "owner_gated", dispositionReason: "r", dispositionRef: missing, dispositionFor: "owner_gated" });
    expect(codesFor(await findings(dir), b, "disposition_")).toEqual([]);
    const loaded = await findings(dir, true);
    expect(codesFor(loaded, a, "disposition_")).toEqual([]);
    expect(codesFor(loaded, b, "disposition_").map((f) => f.code)).toEqual(["disposition_ref_unresolved"]);
  });
});
