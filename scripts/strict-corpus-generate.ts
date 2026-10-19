/**
 * ISS-1398: writes the Mac app's strict-ledger corpus
 * (macos/claudestoryTests/Fixtures/strict-ledger-corpus.json): one valid base
 * record per kind using every optional key, one case per field-table cell
 * (absent, null, wrong type) and the boundary cases. Each case's `json` is raw
 * JSON text. The verdicts are not stored here: the app's differential test
 * asks the real zod schemas (strict-corpus-verdicts.ts) every run.
 *
 *   npx tsx scripts/strict-corpus-generate.ts > ../macos/claudestoryTests/Fixtures/strict-ledger-corpus.json
 */
type Kind = "ticket" | "issue" | "note" | "lesson";
type Json = Record<string, unknown>;
const cases: Array<{ kind: Kind; label: string; json: string }> = [];

const C16 = "0123456789abcdef";
const earmark = {
  stage: "reserved", reservedBy: { client: "claude", id: "task-1" }, arrangementId: `a-${C16}`,
  since: "2026-01-01T00:00:00Z", holderRole: "pen", holderSession: null,
};
const common = {
  displayId: "X", previousDisplayIds: ["Y"], lifecycle: "active", rank: "a0",
  createdAt: "2026-01-01T00:00:00Z", deletedAt: "x", deletedBy: "x",
  _conflicts: [{ fieldPath: "title", kind: "field", base: "a", ours: "b", theirs: "c" }],
  unknownPassthrough: { any: [1, "x", null] },
};
const bases: Record<Kind, Json> = {
  ticket: {
    id: "T-1", title: "t", description: "", type: "task", status: "open", phase: "p1", order: 10,
    createdDate: "2026-01-02", completedDate: null, blockedBy: ["T-2", `t-${C16}`], parentTicket: "T-3",
    createdBy: "a", assignedTo: null, lastModifiedBy: "b", updatedDate: "2026-01-03", updatedAt: "2026-01-03T00:00:00Z",
    claimedBySession: null, crossNodeBlockedBy: ["node-a:T-4", `n_b:i-${C16}`], ...common,
    claim: { user: "u", branch: "b", since: "s", extra: 1 }, earmark, citesRulings: [`r-${C16}`],
    ownerCheckpoint: { x: 1 }, checkpointEvidence: null, resolutionKind: 3, priority: "p1", waitingOn: "owner",
  },
  issue: {
    id: "ISS-1", title: "i", status: "open", severity: "low", components: ["c"], impact: "x", resolution: null,
    location: ["a.ts:1"], sourceRefs: [{ path: "src/a.ts", startLine: 1, endLine: 2, revision: "abcd", snapshotId: "s", reviewId: "r" }],
    dedupeKey: "k", discoveredDate: "2026-01-02", resolvedDate: null, relatedTickets: ["T-1"], order: 3, phase: null,
    createdBy: null, assignedTo: "a", lastModifiedBy: null, updatedDate: null, updatedAt: null, ...common,
    earmark: null, citesRulings: [], disposition: "duplicate", duplicateOf: "ISS-2",
    resolutionKind: null, dispositionReason: "r", dispositionRef: 1, dispositionFor: [], priority: "p0", waitingOn: "none",
  },
  note: {
    id: "N-1", title: null, content: "c", tags: ["t"], status: "active", createdDate: "2026-01-02",
    updatedDate: "2026-01-02", createdBy: "a", updatedAt: "2026-01-02T00:00:00Z", ...common,
  },
  lesson: {
    id: "L-1", title: "l", content: "c", context: "", source: "manual", tags: [], reinforcements: 0,
    lastValidated: "2026-01-02", createdDate: "2026-01-02", updatedDate: "2026-01-02", createdBy: null,
    updatedAt: null, supersedes: null, status: "active", ...common,
  },
};

/** One wrong-type example per field (the field tables' last column). */
const wrong: Record<Kind, Record<string, unknown[]>> = {
  ticket: {
    id: [1, "nope"], title: [""], description: [1], type: ["bug"], status: ["blocked"], phase: [1],
    order: [1.5, "1", true], createdDate: ["2026-02-30"], completedDate: ["2026-1-1"], blockedBy: [["X-1"], "T-1"],
    parentTicket: ["nope"], createdBy: [1], assignedTo: [1], lastModifiedBy: [1], claimedBySession: [1],
    updatedDate: ["x"], updatedAt: [1], crossNodeBlockedBy: [["T-1"]], claim: [{ user: "u", branch: "b" }, "x"],
    earmark: [{ stage: "x" }, {}], citesRulings: [["R-1"]],
  },
  issue: {
    id: ["T-1"], title: [""], status: ["closed"], severity: ["p1"], components: [[1]], impact: [1], resolution: [1],
    location: ["a"], sourceRefs: [[{ path: "a", startLine: 1.5, revision: "abcd" }], {}], dedupeKey: ["a\u0007", ""],
    discoveredDate: ["2026-13-01"], resolvedDate: ["x"], relatedTickets: [["ISS-1"]], order: [1.5, "3"], phase: [1],
    createdBy: [1], assignedTo: [1], lastModifiedBy: [1], updatedDate: ["x"], updatedAt: [1], earmark: [{}],
    citesRulings: [["x"]], disposition: ["x"], duplicateOf: ["N-1"],
  },
  note: {
    id: ["L-1"], title: [1], content: [" ﻿ ", 1], tags: [[1]], status: ["x"], createdDate: ["x"], updatedDate: ["x"],
    createdBy: [1], updatedAt: [1],
  },
  lesson: {
    id: ["N-1"], title: [""], content: ["　"], context: [1], source: ["x"], tags: [[1]], reinforcements: [-1, 1.5],
    lastValidated: ["x"], createdDate: ["x"], updatedDate: ["x"], createdBy: [1], updatedAt: [1], supersedes: ["N-1"],
    status: ["x"],
  },
};
const commonWrong: Record<string, unknown[]> = {
  displayId: [1], previousDisplayIds: [[1]], lifecycle: ["gone"], rank: [1], createdAt: [1], deletedAt: [1],
  deletedBy: [1], _conflicts: [{}, [{}]],
};

function add(kind: Kind, label: string, record: Json | string): void {
  cases.push({ kind, label: `${kind}: ${label}`, json: typeof record === "string" ? record : JSON.stringify(record) });
}
function edit(kind: Kind, changes: Json, drop: string[] = []): Json {
  const r: Json = { ...bases[kind], ...changes };
  for (const k of drop) delete r[k];
  return r;
}

for (const kind of Object.keys(bases) as Kind[]) {
  add(kind, "base", bases[kind]);
  const fields = { ...wrong[kind], ...commonWrong };
  for (const field of Object.keys(fields)) {
    add(kind, `${field} absent`, edit(kind, {}, [field]));
    add(kind, `${field} null`, edit(kind, { [field]: null }));
    fields[field]!.forEach((v, i) => add(kind, `${field} wrong ${i}`, edit(kind, { [field]: v })));
  }
}

// Integral numbers of any magnitude, and the JavaScript rounding edges.
for (const [kind, field] of [["ticket", "order"], ["issue", "order"], ["lesson", "reinforcements"]] as const) {
  const text = JSON.stringify(bases[kind]);
  for (const literal of ["1e20", "9007199254740992", "9007199254740993", "1.0", "-0"]) {
    add(kind, `${field} ${literal}`, text.replace(new RegExp(`"${field}":[^,]+`), `"${field}":${literal}`));
  }
}
// Known differences, pinned (ISS-1409): Foundation refuses these texts at parse.
add("ticket", "known difference: 1e400 in an unknown field", JSON.stringify(bases.ticket).replace(/}$/, `,"big":1e400}`));
add("ticket", "known difference: 1e400 in priority", JSON.stringify(bases.ticket).replace(/"priority":"p1"/, `"priority":1e400`));
add("ticket", "known difference: escaped lone surrogate", JSON.stringify(bases.ticket).replace(/"title":"t"/, `"title":"\\ud800"`));

// UTF-16 lengths with supplementary characters.
const emoji = "\u{1F600}";
const units = (n: number) => emoji.repeat(Math.floor(n / 2)) + (n % 2 ? "a" : "");
for (const n of [512, 513]) add("issue", `dedupeKey ${n} units`, edit("issue", { dedupeKey: units(n) }));
for (const n of [1024, 1025]) add("issue", `sourceRef path ${n} units`, edit("issue", { sourceRefs: [{ path: units(n), startLine: 1, contentHash: "a".repeat(64) }] }));
for (const n of [256, 257]) {
  add("issue", `snapshotId ${n} units`, edit("issue", { sourceRefs: [{ path: "a", startLine: 1, revision: "abcd", snapshotId: units(n) }] }));
  add("issue", `reviewId ${n} units`, edit("issue", { sourceRefs: [{ path: "a", startLine: 1, revision: "abcd", reviewId: units(n) }] }));
}
// Source refs: each refinement and safe-path rule.
const ref = (r: Json) => edit("issue", { sourceRefs: [{ path: "a/b.ts", startLine: 2, ...r }] });
add("issue", "sourceRef revision only", ref({ revision: "ABCD" }));
add("issue", "sourceRef contentHash only", ref({ contentHash: "F".repeat(64) }));
add("issue", "sourceRef neither revision nor contentHash", ref({}));
add("issue", "sourceRef empty revision", ref({ revision: "", contentHash: "a".repeat(64) }));
add("issue", "sourceRef endLine before startLine", ref({ revision: "abcd", endLine: 1 }));
add("issue", "sourceRef endLine equal", ref({ revision: "abcd", endLine: 2 }));
add("issue", "sourceRef endLine null", ref({ revision: "abcd", endLine: null }));
add("issue", "sourceRef startLine 0", ref({ revision: "abcd", startLine: 0 }));
add("issue", "sourceRef startLine 1.5", ref({ revision: "abcd", startLine: 1.5 }));
for (const p of ["/abs", "a\\b", "a:b", "a//b", "./a", "a/..", "a/", "a\u0001", "é/\u{1F600}"]) {
  add("issue", `sourceRef path ${JSON.stringify(p)}`, ref({ revision: "abcd", path: p }));
}
add("issue", "sourceRef unknown key passes through", ref({ revision: "abcd", extra: true }));
// Conflict entries: both refinements, and sides that may be absent.
const conflict = (kind: Kind, e: Json) => edit(kind, { _conflicts: [{ fieldPath: "f", ...e }] });
for (const k of ["field", "array-element", "delete-edit", "coupled"]) add("note", `conflict ${k} with no sides`, conflict("note", { kind: k }));
add("note", "conflict invariant complete", conflict("note", { kind: "invariant", rule: "term-owner", key: "k", entityIds: ["a", "b"] }));
for (const missing of ["rule", "key", "entityIds"]) {
  const e: Json = { kind: "invariant", rule: "term-owner", key: "k", entityIds: ["a", "b"] };
  delete e[missing];
  add("note", `conflict invariant without ${missing}`, conflict("note", e));
}
add("note", "conflict invariant duplicate entityIds", conflict("note", { kind: "invariant", rule: "term-owner", key: "k", entityIds: ["a", "a"] }));
add("note", "conflict invariant NFC and NFD entityIds", conflict("note", { kind: "invariant", rule: "capability-name", key: "k", entityIds: ["é", "é"] }));
add("note", "conflict invariant bad rule", conflict("note", { kind: "invariant", rule: "x", key: "k", entityIds: ["a", "b"] }));
add("note", "conflict empty entityId", conflict("note", { kind: "field", entityId: "" }));
add("note", "conflict empty entityIds member", conflict("note", { kind: "field", entityIds: [""] }));
add("note", "conflict coupled with entityId and object sides", conflict("note", { kind: "coupled", entityId: "e", base: {}, ours: {}, theirs: {} }));
for (const side of ["base", "ours", "theirs"]) {
  for (const v of [null, [], "s"]) {
    add("note", `conflict coupled with entityId, ${side} ${JSON.stringify(v)}`, conflict("note", { kind: "coupled", entityId: "e", base: {}, ours: {}, theirs: {}, [side]: v }));
  }
  add("note", `conflict coupled with entityId, ${side} absent`, conflict("note", { kind: "coupled", entityId: "e", base: {}, ours: {}, theirs: {}, [side]: undefined }));
}
add("note", "conflict coupled without entityId, scalar sides", conflict("note", { kind: "coupled", base: 1, ours: "x", theirs: null }));
// JavaScript trim and content.
for (const [name, text] of [["FEFF", "﻿"], ["3000", "　"], ["2028", " "], ["0085", "\u0085"], ["180E", "᠎"], ["200B", "​"]]) {
  add("note", `content only U+${name}`, edit("note", { content: text }));
  add("lesson", `content only U+${name}`, edit("lesson", { content: text }));
}
// Earmarks.
const mark = (e: Json) => edit("ticket", { earmark: { ...earmark, ...e } });
const uuid = "123e4567-e89b-12d3-a456-426614174000";
add("ticket", "earmark assigned uuid", mark({ stage: "assigned", holderSession: uuid }));
add("ticket", "earmark assigned uppercase uuid", mark({ stage: "assigned", holderSession: uuid.toUpperCase() }));
add("ticket", "earmark assigned non-uuid", mark({ stage: "assigned", holderSession: "x" }));
add("ticket", "earmark assigned null session", mark({ stage: "assigned", holderSession: null }));
add("ticket", "earmark reserved with a session", mark({ holderSession: uuid }));
add("ticket", "earmark reserved without holderSession", mark({ holderSession: undefined }));
for (const since of ["2026-01-01T00:00Z", "2026-01-01T00:00:00.123456Z", "2026-01-01T00:00:00+01:00", "2026-01-01T00:00:00", "2026-02-29T00:00:00Z", "2024-02-29T00:00:00Z", "2026-01-01T24:00:00Z"]) {
  add("ticket", `earmark since ${since}`, mark({ since }));
}
add("ticket", "earmark task id 128 units", mark({ reservedBy: { client: "codex", id: "a".repeat(128) } }));
add("ticket", "earmark task id 129 units", mark({ reservedBy: { client: "codex", id: "a".repeat(129) } }));
add("ticket", "earmark bad client", mark({ reservedBy: { client: "x", id: "a" } }));
add("ticket", "earmark worker role", mark({ holderRole: "worker" }));
// Dates.
for (const d of ["0000-02-29", "1900-02-29", "2000-02-29", "2026-02-29", "2026-04-31", "2026-00-10", "2026-01-00", "١٢٣٤-01-01"]) {
  add("ticket", `createdDate ${d}`, edit("ticket", { createdDate: d }));
}
// Anchors: a trailing line terminator never matches a JS `$`.
const tails: Array<[string, string]> = [["LF", "\n"], ["CRLF", "\r\n"], ["U+2028", " "], ["U+2029", " "]];
for (const [name, tail] of tails) {
  add("ticket", `id with trailing ${name}`, edit("ticket", { id: `T-1${tail}` }));
  add("ticket", `canonical id with trailing ${name}`, edit("ticket", { id: `t-${C16}${tail}` }));
  add("issue", `id with trailing ${name}`, edit("issue", { id: `ISS-1${tail}` }));
  add("note", `id with trailing ${name}`, edit("note", { id: `N-1${tail}` }));
  add("lesson", `id with trailing ${name}`, edit("lesson", { id: `L-1${tail}` }));
  add("ticket", `cross-node ref with trailing ${name}`, edit("ticket", { crossNodeBlockedBy: [`node:T-1${tail}`] }));
  add("ticket", `ruling id with trailing ${name}`, edit("ticket", { citesRulings: [`r-${C16}${tail}`] }));
  add("ticket", `date with trailing ${name}`, edit("ticket", { createdDate: `2026-01-02${tail}` }));
  add("issue", `revision with trailing ${name}`, ref({ revision: `abcd${tail}` }));
  add("issue", `contentHash with trailing ${name}`, ref({ contentHash: `${"a".repeat(64)}${tail}` }));
  add("ticket", `earmark uuid with trailing ${name}`, mark({ stage: "assigned", holderSession: `${uuid}${tail}` }));
  add("ticket", `earmark since with trailing ${name}`, mark({ since: `2026-01-01T00:00:00Z${tail}` }));
  add("ticket", `earmark task id with trailing ${name}`, mark({ reservedBy: { client: "claude", id: `task${tail}` } }));
  add("ticket", `arrangement id with trailing ${name}`, mark({ arrangementId: `a-${C16}${tail}` }));
}
add("ticket", "id with Arabic-Indic digits", edit("ticket", { id: "T-١" }));
add("ticket", "blockedBy NFD-looking id", edit("ticket", { blockedBy: ["T-1́"] }));
add("ticket", "not an object", "[1]");

const labels = new Set(cases.map((c) => c.label));
if (labels.size !== cases.length) throw new Error("duplicate labels");
process.stdout.write(JSON.stringify(cases, null, 1) + "\n");
