/**
 * T-486 U1-1: the resolution-kind and disposition-evidence projections, the
 * load schema's leniency, the validate warnings, the two merge groups and the
 * protected metadata keys.
 *
 * The corpus at test/fixtures/resolution-kind/issue-cases.json is shared with
 * the Mac app's tests (M1), so the case list is pinned by name: a dropped case
 * must fail here, not shrink the loop.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dispositionEvidenceView,
  resolutionKindView,
  resolutionDigest,
} from "../../src/core/resolution-kind.js";
import { IssueSchema } from "../../src/models/issue.js";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { validateProject } from "../../src/core/validation.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { getMergeRules } from "../../src/core/field-classification.js";
import { handleIssueMetaSet, handleIssueUpdate } from "../../src/cli/commands/issue.js";

interface Case {
  name: string;
  /** False only for an issue the load schema refuses for a reason unrelated to T-486. */
  loadable?: boolean;
  issue: Record<string, unknown>;
  expectedKindView: unknown;
  expectedEvidenceView: unknown;
}

const CORPUS = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/resolution-kind/issue-cases.json"), "utf-8"),
) as Case[];

const byName = (name: string): Case => {
  const c = CORPUS.find((x) => x.name === name);
  if (!c) throw new Error(`corpus case missing: ${name}`);
  return c;
};

describe("T-486 corpus: the projections", () => {
  it("carries exactly the agreed cases", () => {
    expect(CORPUS.map((c) => c.name)).toEqual([
      "effective fixed",
      "effective wontfix",
      "effective duplicate",
      "effective superseded",
      "effective not_reproducible",
      "absent",
      "reopened",
      "open with a still-matching binding",
      "inprogress with a still-matching binding",
      "stale date",
      "stale digest",
      "same day unchanged resolution (W4 residual)",
      "null resolution digest",
      "non-string resolution",
      "non-ascii resolution",
      "composed text against a decomposed digest (no normalisation)",
      "CRLF text against an LF digest (no normalisation)",
      "malformed missing field",
      "malformed non-string kind",
      "malformed unknown kind",
      "malformed bad closedOn",
      "malformed short digest",
      "malformed string",
      "malformed array",
      "malformed null",
      "wrong entity withdrawn",
      "evidence effective",
      "evidence unbound after a disposition change",
      "evidence unbound after a clear",
      "evidence malformed reason",
      "evidence malformed dispositionFor",
      "evidence missing dispositionFor",
    ]);
  });

  for (const c of CORPUS) {
    it(`${c.name}: kind view and evidence view`, () => {
      expect(resolutionKindView(c.issue)).toEqual(c.expectedKindView);
      expect(dispositionEvidenceView(c.issue)).toEqual(c.expectedEvidenceView);
    });
  }

  it("the digest is the first 16 hex characters of sha256 over the resolution text", () => {
    expect(resolutionDigest(null)).toBe(resolutionDigest(""));
    expect(resolutionDigest("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(resolutionDigest("x")).not.toBe(resolutionDigest("y"));
  });

  it("the digest matches the fixed vectors byte for byte, with no normalisation", () => {
    const vectors = JSON.parse(
      readFileSync(join(__dirname, "../fixtures/resolution-kind/digest-vectors.json"), "utf-8"),
    ) as { text: string; digest: string }[];
    expect(vectors.length).toBe(7);
    for (const v of vectors) expect(resolutionDigest(v.text), JSON.stringify(v.text)).toBe(v.digest);
    const nfc = "R\u00e9solu: caf\u00e9";
    const lf = "line one\nline two";
    expect(resolutionDigest(nfc)).not.toBe(resolutionDigest(nfc.normalize("NFD")));
    expect(resolutionDigest(lf)).not.toBe(resolutionDigest(lf.replace("\n", "\r\n")));
  });

  it("a non-string resolution never throws and never counts", () => {
    const issue = { ...byName("effective wontfix").issue, resolution: { text: "x" } };
    expect(() => resolutionKindView(issue)).not.toThrow();
    expect(resolutionKindView(issue)).toEqual({ kind: null, state: "stale" });
  });

  it("every corpus issue parses under the load schema, whatever its resolution metadata", () => {
    for (const c of CORPUS) expect(IssueSchema.safeParse(c.issue).success, c.name).toBe(c.loadable !== false);
  });
});

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

async function boardWith(issues: Record<string, unknown>[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u1-"));
  roots.push(root);
  await initProject(root, { name: "t486" });
  for (const issue of issues) {
    writeFileSync(join(root, ".story", "issues", `${String(issue.id)}.json`), JSON.stringify(issue, null, 2) + "\n");
  }
  return root;
}

const withId = (c: Case, id: string): Record<string, unknown> => ({ ...c.issue, id });

describe("T-486 load: malformed resolution metadata never drops an issue (R3-2)", () => {
  const malformed = CORPUS.filter((c) => c.name.startsWith("malformed") || c.name.startsWith("evidence malformed") || c.name === "wrong entity withdrawn");

  it("each malformed record loads with no schema_error", async () => {
    const issues = malformed.map((c, n) => withId(c, `ISS-${String(n + 1).padStart(3, "0")}`));
    const root = await boardWith(issues);
    const { state, warnings } = await loadProject(root);
    expect(warnings.filter((w) => w.type === "schema_error")).toEqual([]);
    expect(state.issues.map((i) => i.id).sort()).toEqual(issues.map((i) => String(i.id)).sort());
  });

  it("an unrelated strict edit succeeds and leaves the malformed value unchanged", async () => {
    for (const c of malformed) {
      const root = await boardWith([withId(c, "ISS-001")]);
      const path = join(root, ".story", "issues", "ISS-001.json");
      const before = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      await handleIssueUpdate("ISS-001", { title: "retitled" }, "json", root);
      const after = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      expect(after.title, c.name).toBe("retitled");
      for (const key of ["resolutionKind", "dispositionReason", "dispositionRef", "dispositionFor"]) {
        // The writer serialises with sorted keys, so compare values, not key order.
        expect(after[key], `${c.name}: ${key}`).toStrictEqual(before[key]);
        expect(key in after, `${c.name}: ${key} presence`).toBe(key in before);
      }
    }
  });
});

describe("T-486 validate: why a kind or evidence does not count", () => {
  const T486_CODES = new Set([
    "resolution_kind_stale",
    "resolution_kind_malformed",
    "resolution_kind_wrong_entity",
    "disposition_evidence_unbound",
    "disposition_evidence_malformed",
    "reserved_key_collision",
  ]);

  // Every T-486 finding is a warning, and no case introduces an error-level
  // finding: metadata that does not count must never fail validation.
  async function codesFor(c: Case): Promise<string[]> {
    const root = await boardWith([withId(c, "ISS-001")]);
    const { state } = await loadProject(root);
    const findings = validateProject(state).findings.filter((f) => f.entity === "ISS-001");
    for (const f of findings) {
      if (T486_CODES.has(f.code)) expect(f.level, `${c.name}: ${f.code}`).toBe("warning");
    }
    expect(findings.filter((f) => f.level === "error"), c.name).toEqual([]);
    return findings.map((f) => f.code);
  }

  it("no loadable corpus case raises an error-level finding", async () => {
    for (const c of CORPUS.filter((x) => x.loadable !== false)) await codesFor(c);
  });

  it("stale kinds warn", async () => {
    for (const name of [
      "reopened",
      "open with a still-matching binding",
      "inprogress with a still-matching binding",
      "stale date",
      "stale digest",
      "composed text against a decomposed digest (no normalisation)",
      "CRLF text against an LF digest (no normalisation)",
    ]) {
      expect(await codesFor(byName(name)), name).toContain("resolution_kind_stale");
    }
  });

  it("malformed and wrong-entity kinds warn", async () => {
    expect(await codesFor(byName("malformed short digest"))).toContain("resolution_kind_malformed");
    expect(await codesFor(byName("malformed null"))).toContain("resolution_kind_malformed");
    expect(await codesFor(byName("wrong entity withdrawn"))).toContain("resolution_kind_wrong_entity");
  });

  it("an effective kind raises none of them", async () => {
    const codes = await codesFor(byName("effective wontfix"));
    expect(codes.filter((c) => c.startsWith("resolution_kind"))).toEqual([]);
  });

  it("unbound evidence warns and names both dispositions", async () => {
    const root = await boardWith([withId(byName("evidence unbound after a disposition change"), "ISS-001")]);
    const { state } = await loadProject(root);
    const f = validateProject(state).findings.find((x) => x.code === "disposition_evidence_unbound");
    expect(f?.message).toContain("accepted_out_of_scope");
    expect(f?.message).toContain("owner_gated");
    expect(await codesFor(byName("evidence unbound after a clear"))).toContain("disposition_evidence_unbound");
  });

  it("malformed evidence warns; effective evidence does not", async () => {
    expect(await codesFor(byName("evidence malformed reason"))).toContain("disposition_evidence_malformed");
    expect((await codesFor(byName("evidence effective"))).filter((c) => c.startsWith("disposition_evidence"))).toEqual([]);
  });

  it("a stored key named effective or stored is reported as a collision", async () => {
    const base = byName("absent").issue;
    expect(await codesFor({ ...byName("absent"), issue: { ...base, effective: "mine" } })).toContain("reserved_key_collision");
    expect(await codesFor({ ...byName("absent"), issue: { ...base, stored: 1 } })).toContain("reserved_key_collision");
  });
});

describe("T-486 merge groups (R3-6)", () => {
  const RESOLVED = byName("effective wontfix").issue;

  it("issue-status: a kind on one side and a date change on the other is one divergence", () => {
    const base = { ...RESOLVED };
    const ours = { ...RESOLVED, resolutionKind: { ...(RESOLVED.resolutionKind as object), kind: "fixed" } };
    const theirs = { ...RESOLVED, resolvedDate: "2026-03-01" };
    const r = threeWayMerge(base, ours, theirs, "issue");
    expect(r.clean).toBe(false);
    expect(r.conflicts.some((c) => c.group === "issue-status")).toBe(true);
  });

  const STATUS = ["status", "resolvedDate", "lifecycle", "resolutionKind"];
  const groupIsOurs = (merged: Record<string, unknown>, ours: Record<string, unknown>) => {
    for (const m of STATUS) {
      expect(Object.hasOwn(merged, m), m).toBe(Object.hasOwn(ours, m));
      if (Object.hasOwn(ours, m)) expect(merged[m], m).toStrictEqual(ours[m]);
    }
  };

  it("issue-status: a stale kind on ours and a re-resolution on theirs never merge into an effective kind", () => {
    // Neither side is effective. Before keep-ours the body took base's
    // closure on D and ours' kind bound to D.
    const { resolutionKind: kind, ...unkinded } = RESOLVED;
    const base = { ...unkinded };
    const ours = { ...unkinded, status: "open", resolvedDate: null, resolutionKind: kind };
    const theirs = { ...unkinded, resolvedDate: "2026-03-01" };
    expect(resolutionKindView(ours).state).not.toBe("effective");
    expect(resolutionKindView(theirs).state).toBe("absent");
    const r = threeWayMerge(base, ours, theirs, "issue");
    expect(r.clean).toBe(false);
    expect(resolutionKindView(r.merged).state).not.toBe("effective");
    groupIsOurs(r.merged, ours);
  });

  it("issue-status: theirs effective as a whole side and ours not keeps ours in the body and theirs whole in the entries", () => {
    const { resolutionKind: kind, ...unkinded } = RESOLVED;
    const base = { ...unkinded };
    const ours = { ...unkinded, status: "open", resolvedDate: null };
    const theirs = { ...unkinded, resolutionKind: kind };
    expect(resolutionKindView(theirs).state).toBe("effective");
    const r = threeWayMerge(base, ours, theirs, "issue");
    expect(r.clean).toBe(false);
    expect(resolutionKindView(r.merged).state).toBe("absent");
    groupIsOurs(r.merged, ours);
    const entries = r.conflicts.filter((c) => c.group === "issue-status");
    expect(entries.map((c) => c.field).sort()).toEqual([...STATUS].sort());
    for (const c of entries) expect(c.theirs, c.field).toStrictEqual((theirs as Record<string, unknown>)[String(c.field)]);
  });

  const OPEN = byName("evidence effective").issue;

  it("issue-disposition: a reason change on one side and a disposition change on the other is one divergence", () => {
    const ours = { ...OPEN, dispositionReason: "a different reason" };
    const theirs = { ...OPEN, disposition: "accepted_out_of_scope" };
    const r = threeWayMerge({ ...OPEN }, ours, theirs, "issue");
    expect(r.clean).toBe(false);
    expect(r.conflicts.some((c) => c.group === "issue-disposition")).toBe(true);
  });

  it("issue-disposition: dispositionFor on one side and dispositionRef on the other is one divergence", () => {
    const ours = { ...OPEN, dispositionFor: "escalate_only" };
    const theirs = { ...OPEN, dispositionRef: "ISS-009" };
    const r = threeWayMerge({ ...OPEN }, ours, theirs, "issue");
    expect(r.clean).toBe(false);
    expect(r.conflicts.some((c) => c.group === "issue-disposition")).toBe(true);
  });

  // Fixup 1: a base lacking an optional member, each side changing the group
  // differently and theirs adding that member. Before keep-ours the body took
  // base's reason plus theirs' added member, a disposition no side wrote.
  const DISPOSITION = ["disposition", "dispositionReason", "dispositionRef", "dispositionFor", "duplicateOf"];
  const added: Record<string, unknown> = { dispositionRef: "ISS-009", dispositionFor: "owner_gated", duplicateOf: "ISS-003" };

  it.each(["dispositionRef", "dispositionFor", "duplicateOf"])("issue-disposition: a base lacking %s keeps ours whole in the body and theirs whole in the entries", (member) => {
    const { [member]: _dropped, ...base } = OPEN as Record<string, unknown>;
    const ours: Record<string, unknown> = { ...base, dispositionReason: "ours changed the reason" };
    const theirs = { ...base, dispositionReason: "theirs changed the reason", [member]: added[member] };
    const r = threeWayMerge(base, ours, theirs, "issue");
    expect(r.clean).toBe(false);
    for (const m of DISPOSITION) {
      expect(Object.hasOwn(r.merged, m), m).toBe(Object.hasOwn(ours, m));
      if (Object.hasOwn(ours, m)) expect(r.merged[m], m).toStrictEqual(ours[m]);
    }
    expect(Object.hasOwn(r.merged, member)).toBe(false);
    const entries = r.conflicts.filter((c) => c.group === "issue-disposition");
    expect(entries.map((c) => c.field).sort()).toEqual([...DISPOSITION].sort());
    for (const c of entries) expect(c.theirs, c.field).toStrictEqual((theirs as Record<string, unknown>)[String(c.field)]);
  });

  it("issue-disposition: a member absent on every side stays absent, never an undefined own key", () => {
    const { duplicateOf: _d, ...base } = OPEN as Record<string, unknown>;
    const ours = { ...base, dispositionReason: "ours changed the reason" };
    const theirs = { ...base, dispositionReason: "theirs changed the reason" };
    const r = threeWayMerge(base, ours, theirs, "issue");
    expect(r.clean).toBe(false);
    expect("duplicateOf" in r.merged).toBe(false);
    // The serialised body has no such key (its conflict entry may still name it).
    expect(Object.keys(JSON.parse(JSON.stringify(r.merged)))).not.toContain("duplicateOf");
  });

  it("group membership is exactly as specified, on every member", () => {
    const rules = getMergeRules("issue");
    const status = ["status", "resolvedDate", "lifecycle", "resolutionKind"];
    const disposition = ["disposition", "dispositionReason", "dispositionRef", "dispositionFor", "duplicateOf"];
    for (const key of status) expect(rules[key], key).toEqual({ kind: "coupled", group: "issue-status", members: status, onDivergence: "keep-ours" });
    for (const key of disposition) expect(rules[key], key).toEqual({ kind: "coupled", group: "issue-disposition", members: disposition, onDivergence: "keep-ours" });
  });
});

describe("T-486 metadata protection", () => {
  for (const key of ["disposition", "dispositionReason", "dispositionRef", "dispositionFor", "duplicateOf", "resolutionKind"]) {
    it(`issue meta set refuses ${key} as a protected core field`, async () => {
      const root = await boardWith([withId(byName("absent"), "ISS-001")]);
      await expect(handleIssueMetaSet("ISS-001", key, "x", "json", root)).rejects.toThrow(
        `targets protected core field "${key}"`,
      );
    });
  }
});
