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
      "stale date",
      "stale digest",
      "same day unchanged resolution (W4 residual)",
      "null resolution digest",
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

  it("every corpus issue parses under the load schema, whatever its resolution metadata", () => {
    for (const c of CORPUS) expect(IssueSchema.safeParse(c.issue).success, c.name).toBe(true);
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
  async function codesFor(c: Case): Promise<string[]> {
    const root = await boardWith([withId(c, "ISS-001")]);
    const { state } = await loadProject(root);
    return validateProject(state).findings.filter((f) => f.entity === "ISS-001").map((f) => f.code);
  }

  it("stale kinds warn", async () => {
    for (const name of ["reopened", "stale date", "stale digest"]) {
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

  it("group membership is exactly as specified, on every member", () => {
    const rules = getMergeRules("issue");
    const status = ["status", "resolvedDate", "lifecycle", "resolutionKind"];
    const disposition = ["disposition", "dispositionReason", "dispositionRef", "dispositionFor", "duplicateOf"];
    for (const key of status) expect(rules[key], key).toEqual({ kind: "coupled", group: "issue-status", members: status });
    for (const key of disposition) expect(rules[key], key).toEqual({ kind: "coupled", group: "issue-disposition", members: disposition });
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
