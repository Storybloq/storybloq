/**
 * T-527 (plan 3.6): verifying a knowledge-impact report against real git.
 *
 * Standalone temp repositories only (ISS-1220): fixture git config writes in a
 * linked worktree reach the shared `.git/config`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  confirmHead,
  DIVERGED_MESSAGE,
  realKnowledgeGit,
  verifyKnowledgeRebase,
  verifyKnowledgeReport,
  type KnowledgeReviewRef,
} from "../../src/autonomous/knowledge-verify.js";
import { KnowledgeImpactSchema, type KnowledgeImpact } from "../../src/autonomous/session-types.js";
import { CapabilitySchema, type Capability } from "../../src/models/capability.js";
import { TermSchema, type Term } from "../../src/models/glossary.js";

const roots: string[] = [];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf-8" });
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function commit(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}
function doc(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

const DATE = "2026-09-22";
function cap(overrides: Record<string, unknown> = {}): Capability {
  return CapabilitySchema.parse({
    id: "cap-core",
    name: "Core",
    summary: "The core module.",
    entryPoints: ["src"],
    contract: "Does the core thing.",
    checkedAt: { sha: "0".repeat(40), date: DATE },
    ...overrides,
  });
}
function term(overrides: Record<string, unknown> = {}): Term {
  return TermSchema.parse({ id: "term-duet", term: "duet", definition: "Two sessions.", updatedAt: "2026-09-22T00:00:00.000Z", ...overrides });
}
function caps(...entries: Capability[]): string {
  return doc({ version: 1, capabilities: entries });
}
function terms(...entries: Term[]): string {
  return doc({ version: 1, terms: entries });
}

const R1 = "r-0000000000000001";
const R2 = "r-0000000000000002";
function ruling(id: string, overrides: Record<string, unknown> = {}): string {
  return doc({
    id,
    text: "Logs go to stderr.",
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "fixture" },
    date: DATE,
    scopeTags: ["logging"],
    supersedes: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  });
}
const NOTE_PATH = ".story/notes/n-0000000000000001.json";
function note(content: string): string {
  return doc({
    id: "n-0000000000000001",
    displayId: "N-001",
    title: null,
    content,
    tags: [],
    status: "active",
    createdDate: DATE,
    updatedDate: DATE,
    updatedAt: "2026-09-22T00:00:00.000Z",
  });
}
const ISSUE_PATH = ".story/issues/i-0000000000000001.json";
function issue(impact: string, overrides: Record<string, unknown> = {}): string {
  return doc({
    id: "i-0000000000000001",
    displayId: "ISS-001",
    title: "Follow-up",
    status: "open",
    severity: "low",
    components: [],
    impact,
    resolution: null,
    location: [],
    discoveredDate: DATE,
    resolvedDate: null,
    relatedTickets: [],
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  });
}

const CAPS = ".story/capabilities.json";
const TERMS = ".story/glossary.json";

/** A repo with a ledger, then the implementation commit (code only). `seed` adds base records. */
function setup(seed: (root: string) => void = () => {}): { root: string; base: string; impl: string } {
  const root = mkdtempSync(join(tmpdir(), "knowledge-verify-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t.t"]);
  write(root, ".gitignore", ".story/sessions/\n");
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, CAPS, caps(cap()));
  write(root, TERMS, terms(term()));
  write(root, NOTE_PATH, note("The core module logs to stderr."));
  write(root, `.story/rulings/${R1}.json`, ruling(R1));
  seed(root);
  const base = commit(root, "base");
  write(root, "src/a.ts", "export const a = 2;\n");
  const impl = commit(root, "implementation");
  return { root, base, impl };
}

function review(impl: string, checkpoint = impl): KnowledgeReviewRef {
  return { itemId: "T-001", implementationCommit: impl, checkpoint };
}
function report(impl: string, overrides: Partial<Record<keyof KnowledgeImpact, unknown>> = {}): KnowledgeImpact {
  return KnowledgeImpactSchema.parse({
    implementationCommit: impl,
    maintenanceCommits: [],
    checked: ["cap-core"],
    outcome: "none",
    reason: "nothing the item changed is recorded knowledge",
    ...overrides,
  });
}
function impact(record: string, kind: string, disposition: string, evidence: Record<string, unknown> = {}): Record<string, unknown> {
  return { record, kind, proposed: `update ${record}`, disposition, evidence: { record, ...evidence } };
}
function impacts(impl: string, maintenance: string[], list: Record<string, unknown>[], checked = ["cap-core"]): KnowledgeImpact {
  return report(impl, { outcome: "impacts", reason: undefined, impacts: list, maintenanceCommits: maintenance, checked });
}
function verify(root: string, ref: KnowledgeReviewRef, rep: KnowledgeImpact) {
  return verifyKnowledgeReport(root, ref, rep, { git: realKnowledgeGit(root) });
}
async function refusal(run: ReturnType<typeof verify>): Promise<string> {
  const out = await run;
  if (out.ok) throw new Error("expected a refusal, got acceptance");
  return out.message;
}
/** A capability entry stamped at `sha`, so its freshness is current while `src` has not changed since. */
function stamped(sha: string, overrides: Record<string, unknown> = {}): Capability {
  return cap({ checkedAt: { sha, date: DATE }, ...overrides });
}

describe("preflight", () => {
  it("is knowledge_diverged when the implementation commit left HEAD's history (branch reset)", async () => {
    const { root, base, impl } = setup();
    git(root, ["reset", "-q", "--hard", base]);
    write(root, "src/b.ts", "x\n");
    commit(root, "elsewhere");
    const out = await verify(root, review(impl), report(impl));
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.condition).toBe("knowledge_diverged");
    expect(out.ok ? "" : out.message).toContain(DIVERGED_MESSAGE);
  });

  it("is knowledge_diverged when the checkpoint does not resolve", async () => {
    const { root, impl } = setup();
    const out = await verify(root, review(impl, "1".repeat(40)), report(impl));
    expect(out.ok ? null : out.condition).toBe("knowledge_diverged");
  });

  it("is knowledge_diverged for divergent history with an identical ledger tree", async () => {
    const { root, base, impl } = setup();
    git(root, ["reset", "-q", "--hard", base]);
    write(root, "src/a.ts", "export const a = 2;\n");
    commit(root, "same change, different commit");
    const out = await verify(root, review(impl), report(impl));
    expect(out.ok ? null : out.condition).toBe("knowledge_diverged");
  });

  it("refuses a report for another implementation commit", async () => {
    const { root, base, impl } = setup();
    const out = await verify(root, review(impl), report(base));
    expect(out.ok ? "" : out.message).toContain(`implementationCommit must be ${impl}`);
  });
});

describe("rule (a): code after the checkpoint", () => {
  it("refuses a code commit after the checkpoint and names knowledge_rebase", async () => {
    const { root, impl } = setup();
    write(root, "other/b.ts", "x\n");
    commit(root, "foreign code");
    expect(await refusal(verify(root, review(impl), report(impl)))).toMatch(/code committed after the checkpoint .*report knowledge_rebase/);
  });

  it("catches a code commit that arrives through a merged side branch", async () => {
    const { root, impl } = setup();
    git(root, ["checkout", "-q", "-b", "side"]);
    write(root, "other/side.ts", "x\n");
    commit(root, "side code");
    git(root, ["checkout", "-q", "main"]);
    write(root, NOTE_PATH, note("A ledger-only commit on main."));
    commit(root, "ledger on main");
    git(root, ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge side", "side"]);
    const message = await refusal(verify(root, review(impl), report(impl)));
    expect(message).toContain("code committed after the checkpoint");
    expect(message).toContain("other/side.ts");
  });

  it("does not read the mainline's own code as the merge's when a ledger-only side branch is merged", async () => {
    const { root, base, impl } = setup();
    git(root, ["checkout", "-q", "-b", "side", base]);
    write(root, NOTE_PATH, note("A ledger-only side branch."));
    commit(root, "side ledger");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge side", "side"]);
    expect((await verify(root, review(impl), report(impl))).ok).toBe(true);
  });

  it("accepts ledger-only commits after the checkpoint", async () => {
    const { root, impl } = setup();
    write(root, NOTE_PATH, note("Someone else refreshed this note."));
    commit(root, "foreign ledger");
    const out = await verify(root, review(impl), report(impl));
    expect(out.ok).toBe(true);
  });
});

describe("knowledge_rebase", () => {
  it("accepts a code-only commit after the checkpoint, then the report is accepted at the new checkpoint", async () => {
    const { root, impl } = setup();
    write(root, "other/b.ts", "x\n");
    const code = commit(root, "code only, ledger identical");
    await refusal(verify(root, review(impl), report(impl)));
    const rebase = await verifyKnowledgeRebase(realKnowledgeGit(root), review(impl));
    expect(rebase).toEqual({ ok: true, head: code });
    expect((await verify(root, review(impl, code), report(impl))).ok).toBe(true);
  });

  it("refuses when every commit after the checkpoint is ledger-only", async () => {
    const { root, impl } = setup();
    write(root, NOTE_PATH, note("ledger"));
    commit(root, "ledger");
    const rebase = await verifyKnowledgeRebase(realKnowledgeGit(root), review(impl));
    expect(rebase.ok ? "" : rebase.message).toContain("nothing to rebase");
  });

  it("refuses with no commits at all after the checkpoint", async () => {
    const { root, impl } = setup();
    const rebase = await verifyKnowledgeRebase(realKnowledgeGit(root), review(impl));
    expect(rebase.ok ? "" : rebase.message).toContain("nothing to rebase");
  });

  it("is knowledge_diverged when the checkpoint left HEAD's history", async () => {
    const { root, impl } = setup();
    write(root, "other/b.ts", "x\n");
    const checkpoint = commit(root, "rebased onto this");
    git(root, ["reset", "-q", "--hard", impl]);
    const rebase = await verifyKnowledgeRebase(realKnowledgeGit(root), review(impl, checkpoint));
    expect(rebase.ok ? null : rebase.condition).toBe("knowledge_diverged");
    expect(rebase.ok ? "" : rebase.message).toContain(`the checkpoint ${checkpoint.slice(0, 12)} is not an ancestor of HEAD`);
    const rep = await verify(root, review(impl, checkpoint), report(impl));
    expect(rep.ok ? null : rep.condition).toBe("knowledge_diverged");
  });

  it("keeps the original impacts across a rebase: maintenance, foreign code, rebase, report", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(stamped(impl, { summary: "The core module, now async." })));
    const m1 = commit(root, "maintenance");
    write(root, "other/b.ts", "x\n");
    const foreign = commit(root, "foreign code");
    const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]);
    expect(await refusal(verify(root, review(impl), rep))).toContain("code committed after the checkpoint");
    const rebase = await verifyKnowledgeRebase(realKnowledgeGit(root), review(impl));
    expect(rebase.ok).toBe(true);
    expect((await verify(root, review(impl, foreign), rep)).ok).toBe(true);
  });
});

describe("rule (b): maintenance commits", () => {
  it("refuses a listed mixed code-plus-ledger commit by name", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(stamped(impl, { summary: "Changed." })));
    write(root, "other/b.ts", "x\n");
    const mixed = commit(root, "mixed");
    const rep = impacts(impl, [mixed], [impact("cap-core", "capability-changed", "applied")]);
    const message = await refusal(verify(root, review(impl, mixed), rep));
    expect(message).toContain(`maintenance commit ${mixed.slice(0, 12)} is not ledger-only`);
  });

  it("refuses an unrelated historical commit", async () => {
    const { root, base, impl } = setup();
    const rep = report(impl, { maintenanceCommits: [base] });
    expect(await refusal(verify(root, review(impl), rep))).toContain("does not descend from the implementation commit");
  });

  it("refuses a detached maintenance commit on another branch", async () => {
    const { root, impl } = setup();
    git(root, ["checkout", "-q", "-b", "other"]);
    write(root, NOTE_PATH, note("elsewhere"));
    const detached = commit(root, "detached maintenance");
    git(root, ["checkout", "-q", "main"]);
    const rep = report(impl, { maintenanceCommits: [detached] });
    expect(await refusal(verify(root, review(impl), rep))).toContain("is not on HEAD's history");
  });

  it("refuses the implementation commit listed as maintenance", async () => {
    const { root, impl } = setup();
    expect(await refusal(verify(root, review(impl), report(impl, { maintenanceCommits: [impl] })))).toContain("is the implementation commit itself");
  });

  it("refuses maintenance commits out of ancestry order", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(stamped(impl, { summary: "One." })));
    const m1 = commit(root, "m1");
    write(root, CAPS, caps(stamped(impl, { summary: "Two." })));
    const m2 = commit(root, "m2");
    const rep = impacts(impl, [m2, m1], [impact("cap-core", "capability-changed", "applied")]);
    expect(await refusal(verify(root, review(impl), rep))).toContain("not ordered by ancestry");
  });
});

describe("rule (c): the working tree's .story/", () => {
  it("refuses uncommitted ledger changes", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(cap({ status: "review", pendingNote: "cap-core: refresh the contract" })));
    expect(await refusal(verify(root, review(impl), report(impl)))).toContain("uncommitted ledger changes");
  });

  it("refuses an untracked ledger file (an uncommitted proposal)", async () => {
    const { root, impl } = setup();
    write(root, `.story/rulings/${R2}.json`, ruling(R2, { status: "proposed", proposesToSupersede: R1, proposedFor: ["T-001"] }));
    expect(await refusal(verify(root, review(impl), report(impl)))).toContain("uncommitted ledger changes");
  });

  it("does not count ignored session state", async () => {
    const { root, impl } = setup();
    write(root, ".story/sessions/abc/state.json", "{}\n");
    expect((await verify(root, review(impl), report(impl))).ok).toBe(true);
  });
});

describe("rule (e): an unchanged .story/ tree", () => {
  it("refuses impacts when nothing under .story/ changed", async () => {
    const { root, impl } = setup();
    const rep = impacts(impl, [], [impact("cap-core", "capability-changed", "applied")]);
    expect(await refusal(verify(root, review(impl), rep))).toContain("impacts and maintenanceCommits must both be empty");
  });

  it("accepts outcome none with nothing listed", async () => {
    const { root, impl } = setup();
    const out = await verify(root, review(impl), report(impl));
    expect(out).toEqual({ ok: true, head: impl, maintenanceCommits: [], externalMaintenance: [] });
  });
});

describe("the table", () => {
  it("refuses a disposition outside the row and names the rows", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(stamped(impl, { status: "review", pendingNote: "retire: cap-core" })));
    const m1 = commit(root, "m1");
    const rep = impacts(impl, [m1], [impact("cap-core", "capability-removed", "applied")]);
    const message = await refusal(verify(root, review(impl), rep));
    expect(message).toContain("no row for cap- capability-removed applied");
    expect(message).toContain("capability-removed (pending)");
  });

  it("refuses a kind that belongs to another family", async () => {
    const { root, impl } = setup();
    write(root, TERMS, terms(term({ definition: "Two paired sessions." })));
    const m1 = commit(root, "m1");
    const rep = impacts(impl, [m1], [impact("term-duet", "stale-reference", "applied")], ["term-duet"]);
    expect(await refusal(verify(root, review(impl), rep))).toContain("no row for term- stale-reference applied");
  });

  describe("cap- applied", () => {
    it("accepts a changed entry that is effectively current at HEAD", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(stamped(impl, { summary: "The core module, now async." })));
      const m1 = commit(root, "m1");
      const out = await verify(root, review(impl), impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]));
      expect(out).toEqual({ ok: true, head: m1, maintenanceCommits: [m1], externalMaintenance: [] });
    });

    it("accepts stale-reference on the same evidence", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(stamped(impl, { entryPoints: ["src/a.ts"] })));
      const m1 = commit(root, "m1");
      expect((await verify(root, review(impl), impacts(impl, [m1], [impact("cap-core", "stale-reference", "applied")]))).ok).toBe(true);
    });

    it("refuses when only a stamp moved (content unchanged)", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(stamped(impl)));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("content is unchanged");
    });

    it("refuses an entry that is not effectively current (a pending note)", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(stamped(impl, { summary: "Changed.", pendingNote: "cap-core: more to do" })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("effectively current");
    });

    it("refuses an entry whose freshness is stale (unverifiable stamp)", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap({ summary: "Changed." })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("effectively current");
    });

    it("refuses capability-changed for an entry absent at the baseline", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap(), stamped(impl, { id: "cap-new", name: "New" })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-new", "capability-changed", "applied")]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("a new entry is capability-added");
    });

    it("accepts capability-added for a new entry", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap(), stamped(impl, { id: "cap-new", name: "New" })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-new", "capability-added", "applied")], ["cap-new"]);
      expect((await verify(root, review(impl), rep)).ok).toBe(true);
    });

    it("refuses capability-added for an entry that exists at the baseline", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(stamped(impl, { summary: "Changed." })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-added", "applied")]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("exists at the implementation commit");
    });
  });

  describe("cap- pending and the marker rule", () => {
    it("accepts a marker that names the record", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap({ status: "review", pendingNote: "cap-core: the contract needs the async note" })));
      const m1 = commit(root, "m1");
      expect((await verify(root, review(impl), impacts(impl, [m1], [impact("cap-core", "capability-changed", "pending")]))).ok).toBe(true);
    });

    it("refuses a marker that does not name the record id", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap({ status: "review", pendingNote: "refresh the contract later" })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "pending")]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("must name the record id");
    });

    it("refuses a pending disposition with no marker", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap({ status: "review" })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "pending")]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("needs a pendingNote");
    });

    it("refuses a marker unchanged since the baseline", async () => {
      const { root } = setup();
      write(root, CAPS, caps(cap({ status: "review", pendingNote: "cap-core: already pending" })));
      const impl2 = commit(root, "pending before the item");
      write(root, "src/a.ts", "export const a = 3;\n");
      const impl = commit(root, "implementation");
      write(root, CAPS, caps(cap({ status: "review", pendingNote: "cap-core: already pending", summary: "Touched." })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "pending")]);
      expect(impl2).not.toBe(impl);
      expect(await refusal(verify(root, review(impl), rep))).toContain("pendingNote is unchanged since the baseline");
    });

    it("accepts capability-removed as a retire: marker, and refuses any other note", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap({ status: "review", pendingNote: "retire: cap-core is gone with T-001" })));
      const m1 = commit(root, "m1");
      expect((await verify(root, review(impl), impacts(impl, [m1], [impact("cap-core", "capability-removed", "pending")]))).ok).toBe(true);

      const second = setup();
      write(second.root, CAPS, caps(cap({ status: "review", pendingNote: "cap-core is gone" })));
      const n1 = commit(second.root, "m1");
      const rep = impacts(second.impl, [n1], [impact("cap-core", "capability-removed", "pending")]);
      expect(await refusal(verify(second.root, review(second.impl), rep))).toContain('starts with "retire:"');
    });

    it("accepts a marker with an open issue that names the record", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap({ status: "review", pendingNote: "cap-core: see ISS-001" })));
      write(root, ISSUE_PATH, issue("cap-core needs its contract refreshed"));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "pending", { issueId: "ISS-001" })]);
      expect((await verify(root, review(impl), rep)).ok).toBe(true);
    });

    it("refuses a resolved issue, and an issue that does not name the record", async () => {
      const { root, impl } = setup();
      write(root, CAPS, caps(cap({ status: "review", pendingNote: "cap-core: see ISS-001" })));
      write(root, ISSUE_PATH, issue("cap-core needs work", { status: "resolved", resolution: "done", resolvedDate: DATE }));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "pending", { issueId: "ISS-001" })]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("is resolved");

      const second = setup();
      write(second.root, CAPS, caps(cap({ status: "review", pendingNote: "cap-core: see ISS-001" })));
      write(second.root, ISSUE_PATH, issue("something else"));
      const n1 = commit(second.root, "m1");
      const rep2 = impacts(second.impl, [n1], [impact("cap-core", "capability-changed", "pending", { issueId: "ISS-001" })]);
      expect(await refusal(verify(second.root, review(second.impl), rep2))).toContain("must name cap-core");
    });
  });

  describe("term-", () => {
    it("accepts term-drift applied when the term checks clean", async () => {
      const { root, impl } = setup();
      write(root, TERMS, terms(term({ definition: "Two paired sessions: a pen and a worker." })));
      const m1 = commit(root, "m1");
      expect((await verify(root, review(impl), impacts(impl, [m1], [impact("term-duet", "term-drift", "applied")], ["term-duet"]))).ok).toBe(true);
    });

    it("refuses term-drift applied when the term has a structural error at HEAD", async () => {
      const { root, impl } = setup();
      write(root, TERMS, terms(term({ definition: "Changed.", capabilities: ["cap-missing"] })));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("term-duet", "term-drift", "applied")], ["term-duet"]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("does not check clean");
    });

    it("accepts term-drift pending with a marker", async () => {
      const { root, impl } = setup();
      write(root, TERMS, terms(term({ pendingNote: "term-duet: definition predates the pen" })));
      const m1 = commit(root, "m1");
      expect((await verify(root, review(impl), impacts(impl, [m1], [impact("term-duet", "term-drift", "pending")], ["term-duet"]))).ok).toBe(true);
    });
  });

  describe("N-", () => {
    it("accepts stale-reference applied on a changed note", async () => {
      const { root, impl } = setup();
      write(root, NOTE_PATH, note("The core module logs through the logger."));
      const m1 = commit(root, "m1");
      expect((await verify(root, review(impl), impacts(impl, [m1], [impact("N-001", "stale-reference", "applied")], ["N-001"]))).ok).toBe(true);
    });

    it("refuses a pending note impact without an issue", async () => {
      const { root, impl } = setup();
      write(root, ISSUE_PATH, issue("N-001 is stale"));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("N-001", "stale-reference", "pending")], ["N-001"]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("names its follow-up issue");
    });

    it("accepts a pending note impact with an open issue filed in a listed commit, the note unchanged", async () => {
      const { root, impl } = setup();
      write(root, ISSUE_PATH, issue("N-001 is stale after T-001"));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact("N-001", "stale-reference", "pending", { issueId: "ISS-001" })], ["N-001"]);
      expect((await verify(root, review(impl), rep)).ok).toBe(true);
    });
  });

  describe("r- ruling-conflict", () => {
    const proposal = (overrides: Record<string, unknown> = {}): string =>
      ruling(R2, { text: "Logs go to the logger.", status: "proposed", proposesToSupersede: R1, proposedFor: ["T-001"], ...overrides });

    it("accepts a proposal filed in a listed commit, the accepted ruling unchanged", async () => {
      const { root, impl } = setup();
      write(root, `.story/rulings/${R2}.json`, proposal());
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact(R1, "ruling-conflict", "needs-decision", { proposalId: R2 })], [R1]);
      expect((await verify(root, review(impl), rep)).ok).toBe(true);
    });

    it("refuses when the accepted ruling itself was rewritten, even outside a listed commit", async () => {
      const { root, impl } = setup();
      write(root, `.story/rulings/${R1}.json`, ruling(R1, { text: "Logs go to the logger." }));
      commit(root, "someone rewrote the ruling");
      write(root, `.story/rulings/${R2}.json`, proposal());
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact(R1, "ruling-conflict", "needs-decision", { proposalId: R2 })], [R1]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("the accepted ruling changed");
    });

    it("refuses a proposal for another item, or one that supersedes another ruling", async () => {
      const { root, impl } = setup();
      write(root, `.story/rulings/${R2}.json`, proposal({ proposedFor: ["T-999"] }));
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact(R1, "ruling-conflict", "needs-decision", { proposalId: R2 })], [R1]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("is not proposed for T-001");

      const second = setup();
      write(second.root, `.story/rulings/${R2}.json`, proposal({ proposesToSupersede: null }));
      const n1 = commit(second.root, "m1");
      const rep2 = impacts(second.impl, [n1], [impact(R1, "ruling-conflict", "needs-decision", { proposalId: R2 })], [R1]);
      expect(await refusal(verify(second.root, review(second.impl), rep2))).toContain(`does not propose to supersede ${R1}`);
    });

    it("refuses ruling-conflict on a ruling that is only proposed", async () => {
      const { root, impl } = setup();
      write(root, `.story/rulings/${R2}.json`, proposal());
      const m1 = commit(root, "m1");
      const rep = impacts(impl, [m1], [impact(R2, "ruling-conflict", "needs-decision", { proposalId: R2 })], [R2]);
      expect(await refusal(verify(root, review(impl), rep))).toContain("is for an accepted ruling");
    });
  });
});

describe("rule (d): provenance", () => {
  it("accepts a change after the restart point when an earlier unlisted change was reverted", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(cap({ summary: "Someone else's edit." })));
    const e1 = commit(root, "external edit");
    write(root, CAPS, caps(cap()));
    const e2 = commit(root, "external revert");
    write(root, CAPS, caps(stamped(impl, { summary: "Ours." })));
    const m1 = commit(root, "m1");
    const out = await verify(root, review(impl), impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]));
    expect(out.ok).toBe(true);
    expect(out.ok ? out.externalMaintenance : []).toEqual([
      { id: "cap-core", commit: e1 },
      { id: "cap-core", commit: e2 },
    ]);
  });

  it("refuses a record changed by an unlisted ledger commit after the restart point", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(cap({ summary: "Someone else's edit." })));
    const e1 = commit(root, "external edit");
    write(root, CAPS, caps(stamped(impl, { summary: "Ours." })));
    const m1 = commit(root, "m1");
    const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]);
    expect(await refusal(verify(root, review(impl), rep))).toContain(`cap-core changed outside a listed maintenance commit (at ${e1.slice(0, 12)})`);
  });

  it("names an unlisted merge that brought the change, and accepts once the merge is listed", async () => {
    const { root, impl } = setup();
    git(root, ["checkout", "-q", "-b", "side"]);
    write(root, CAPS, caps(stamped(impl, { summary: "Ours, on a side branch." })));
    const s1 = commit(root, "side ledger");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge side", "side"]);
    const merge = git(root, ["rev-parse", "HEAD"]).trim();
    const refused = await refusal(verify(root, review(impl), impacts(impl, [s1], [impact("cap-core", "capability-changed", "applied")])));
    expect(refused).toContain(`cap-core changed in merge ${merge.slice(0, 8)}, which is not listed; list the merge commit if it is ledger-only`);
    expect((await verify(root, review(impl), impacts(impl, [merge], [impact("cap-core", "capability-changed", "applied")]))).ok).toBe(true);
    expect((await verify(root, review(impl), impacts(impl, [s1, merge], [impact("cap-core", "capability-changed", "applied")]))).ok).toBe(true);
  });

  it("holds a listed side-branch commit to attribution even when its merge is unlisted", async () => {
    const { root, impl } = setup();
    git(root, ["checkout", "-q", "-b", "side"]);
    write(root, NOTE_PATH, note("Rewritten on a side branch."));
    const s1 = commit(root, "side ledger");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge side", "side"]);
    expect(await refusal(verify(root, review(impl), report(impl, { maintenanceCommits: [s1] })))).toContain(
      `n-0000000000000001 changed in listed commit ${s1.slice(0, 12)}, but the report does not explain it`,
    );
  });

  it("accepts a listed side-branch stamp on a checked id", async () => {
    const { root, impl } = setup();
    git(root, ["checkout", "-q", "-b", "side"]);
    write(root, CAPS, caps(stamped(impl)));
    const s1 = commit(root, "side stamp");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge side", "side"]);
    const merge = git(root, ["rev-parse", "HEAD"]).trim();
    const out = await verify(root, review(impl), report(impl, { maintenanceCommits: [s1] }));
    expect(out.ok).toBe(true);
    expect(out.ok ? out.externalMaintenance : []).toEqual([{ id: "cap-core", commit: merge }]);
  });

  it("attributes a listed side-branch commit against its own parent, not the implementation commit", async () => {
    const { root, impl } = setup();
    git(root, ["checkout", "-q", "-b", "side"]);
    write(root, CAPS, caps(cap({ summary: "Someone else's edit on the side branch." })));
    commit(root, "side, unlisted");
    write(root, CAPS, caps(stamped(impl, { summary: "Someone else's edit on the side branch." })));
    const s2 = commit(root, "side stamp");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge side", "side"]);
    expect((await verify(root, review(impl), report(impl, { maintenanceCommits: [s2] }))).ok).toBe(true);
  });

  it("refuses a commit changing the entry after the last listed one", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(stamped(impl, { summary: "Ours." })));
    const m1 = commit(root, "m1");
    write(root, CAPS, caps(stamped(impl, { summary: "Theirs, later." })));
    const e1 = commit(root, "external edit after");
    const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]);
    expect(await refusal(verify(root, review(impl), rep))).toContain(`at ${e1.slice(0, 12)}`);
  });

  it("records another session's interleaved entry as external maintenance, never required", async () => {
    const { root, impl } = setup();
    const other = cap({ id: "cap-other", name: "Other" });
    write(root, CAPS, caps(cap(), other));
    const e1 = commit(root, "other session adds its entry");
    write(root, CAPS, caps(stamped(impl, { summary: "Ours." }), other));
    const m1 = commit(root, "m1");
    write(root, CAPS, caps(stamped(impl, { summary: "Ours." }), cap({ id: "cap-other", name: "Other", status: "review", pendingNote: "cap-other: theirs" })));
    const e2 = commit(root, "other session defers its entry");
    const out = await verify(root, review(impl), impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]));
    expect(out.ok).toBe(true);
    expect(out.ok ? out.externalMaintenance : []).toEqual([
      { id: "cap-other", commit: e1 },
      { id: "cap-other", commit: e2 },
    ]);
  });

  it("refuses an unexplained entry change inside a listed commit", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(stamped(impl, { summary: "Ours." }), cap({ id: "cap-other", name: "Other" })));
    const m1 = commit(root, "m1 also adds an entry");
    const rep = impacts(impl, [m1], [impact("cap-core", "capability-changed", "applied")]);
    expect(await refusal(verify(root, review(impl), rep))).toContain(`cap-other changed in listed commit ${m1.slice(0, 12)}`);
  });

  it("attributes stamp-only work through checked, and refuses it when unnamed", async () => {
    const { root, impl } = setup();
    write(root, TERMS, terms(term({ definition: "Two paired sessions." })));
    write(root, CAPS, caps(stamped(impl)));
    const m1 = commit(root, "m1: term drift plus a stamp");
    const named = impacts(impl, [m1], [impact("term-duet", "term-drift", "applied")], ["term-duet", "cap-core"]);
    expect((await verify(root, review(impl), named)).ok).toBe(true);
    const unnamed = impacts(impl, [m1], [impact("term-duet", "term-drift", "applied")], ["term-duet"]);
    expect(await refusal(verify(root, review(impl), unnamed))).toContain("cap-core changed in listed commit");
  });

  it("accepts outcome none with a stamp-only listed commit on a checked id", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(stamped(impl)));
    const m1 = commit(root, "stamp");
    expect((await verify(root, review(impl), report(impl, { maintenanceCommits: [m1] }))).ok).toBe(true);
  });

  it("accepts a pending marker on an entry created externally, recording the creation", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(cap(), cap({ id: "cap-new", name: "New" })));
    const e1 = commit(root, "created elsewhere");
    write(root, CAPS, caps(cap(), cap({ id: "cap-new", name: "New", status: "review", pendingNote: "cap-new: describe the T-001 surface" })));
    const m1 = commit(root, "m1 marker");
    const rep = impacts(impl, [m1], [impact("cap-new", "capability-added", "pending")], ["cap-new"]);
    const out = await verify(root, review(impl), rep);
    expect(out.ok).toBe(true);
    expect(out.ok ? out.externalMaintenance : []).toContainEqual({ id: "cap-new", commit: e1 });
  });

  it("never accepts an externally created entry as applied", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(cap(), stamped(impl, { id: "cap-new", name: "New" })));
    const e1 = commit(root, "created elsewhere");
    write(root, NOTE_PATH, note("An unrelated listed commit."));
    const m1 = commit(root, "m1");
    const rep = impacts(impl, [m1], [impact("cap-new", "capability-added", "applied"), impact("N-001", "stale-reference", "applied")], ["cap-new"]);
    expect(await refusal(verify(root, review(impl), rep))).toContain(`cap-new changed outside a listed maintenance commit (at ${e1.slice(0, 12)})`);
  });

  it("refuses an externally created, already pending entry reported with no listed marker change", async () => {
    const { root, impl } = setup();
    write(root, CAPS, caps(cap(), cap({ id: "cap-new", name: "New", status: "review", pendingNote: "cap-new: created pending" })));
    commit(root, "created pending elsewhere");
    write(root, NOTE_PATH, note("An unrelated listed commit."));
    const m1 = commit(root, "m1");
    const rep = impacts(impl, [m1], [impact("cap-new", "capability-added", "pending"), impact("N-001", "stale-reference", "applied")], ["cap-new"]);
    expect(await refusal(verify(root, review(impl), rep))).toContain("cap-new (marker) is unchanged since the baseline");
  });
});

describe("ISS-1340: issue changes in listed maintenance commits", () => {
  const LEGACY_ISSUE_PATH = ".story/issues/ISS-002.json";
  function legacyIssue(overrides: Record<string, unknown> = {}): string {
    const { displayId: _unused, ...rest } = JSON.parse(issue("The old module is misnamed.", { id: "ISS-002", title: "Closeout", ...overrides })) as Record<string, unknown>;
    return doc(rest);
  }
  const RESOLVED = { status: "resolved", resolution: "done", resolvedDate: DATE };
  const withOpenIssues = (root: string): void => {
    write(root, ISSUE_PATH, issue("The core module is misnamed."));
    write(root, LEGACY_ISSUE_PATH, legacyIssue());
  };

  it("accepts outcome none for a listed commit that resolves a hash-named issue", async () => {
    const { root, impl } = setup(withOpenIssues);
    write(root, ISSUE_PATH, issue("The core module is misnamed.", RESOLVED));
    const m1 = commit(root, "ledger: resolve ISS-001");
    expect(await verify(root, review(impl), report(impl, { maintenanceCommits: [m1] }))).toMatchObject({ ok: true });
  });

  it("accepts outcome none for a listed commit that resolves a legacy ISS-NNN.json issue", async () => {
    const { root, impl } = setup(withOpenIssues);
    write(root, LEGACY_ISSUE_PATH, legacyIssue(RESOLVED));
    const m1 = commit(root, "ledger: resolve ISS-002");
    expect(await verify(root, review(impl), report(impl, { maintenanceCommits: [m1] }))).toMatchObject({ ok: true });
  });

  it("still refuses an unexplained capability or note change beside the issue resolution, naming it", async () => {
    const { root, impl } = setup(withOpenIssues);
    write(root, ISSUE_PATH, issue("The core module is misnamed.", RESOLVED));
    const m1 = commit(root, "ledger: resolve ISS-001");
    expect(await verify(root, review(impl), report(impl, { maintenanceCommits: [m1] }))).toMatchObject({ ok: true });
    write(root, CAPS, caps(cap(), cap({ id: "cap-other", name: "Other" })));
    const m2 = commit(root, "ledger: also adds an entry");
    expect(await refusal(verify(root, review(impl), report(impl, { maintenanceCommits: [m1, m2] })))).toContain(`cap-other changed in listed commit ${m2.slice(0, 12)}`);

    const second = setup(withOpenIssues);
    write(second.root, LEGACY_ISSUE_PATH, legacyIssue(RESOLVED));
    write(second.root, NOTE_PATH, note("The core module logs through the logger."));
    const n1 = commit(second.root, "ledger: resolve ISS-002 and edit a note");
    expect(await refusal(verify(second.root, review(second.impl), report(second.impl, { maintenanceCommits: [n1] })))).toContain(
      `n-0000000000000001 changed in listed commit ${n1.slice(0, 12)}`,
    );
  });

  it("keeps every pending-evidence check when the same commit also resolves another issue", async () => {
    const pendingOn = (evidence: string, overrides: Record<string, unknown>, issueId = "ISS-001") => {
      const fx = setup((root) => write(root, LEGACY_ISSUE_PATH, legacyIssue()));
      write(fx.root, LEGACY_ISSUE_PATH, legacyIssue(RESOLVED));
      if (evidence !== "") write(fx.root, ISSUE_PATH, issue(evidence, overrides));
      const m1 = commit(fx.root, "ledger: closeout plus a follow-up");
      const rep = impacts(fx.impl, [m1], [impact("N-001", "stale-reference", "pending", { issueId })], ["N-001"]);
      return verify(fx.root, review(fx.impl), rep);
    };
    expect(await pendingOn("N-001 is stale after T-001", {})).toMatchObject({ ok: true });
    expect(await refusal(pendingOn("N-001 is stale after T-001", RESOLVED))).toContain("issue ISS-001 is resolved");
    expect(await refusal(pendingOn("", {}))).toContain("issue ISS-001 is not in the ledger at HEAD");
    expect(await refusal(pendingOn("Something else entirely", {}))).toContain("issue ISS-001 must name N-001");
  });
});

describe("snapshots", () => {
  it("refuses with baseline unavailable when the baseline catalog is malformed", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-verify-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "t"]);
    git(root, ["config", "user.email", "t@t.t"]);
    write(root, "src/a.ts", "1\n");
    write(root, CAPS, "{ not json");
    commit(root, "base");
    write(root, "src/a.ts", "2\n");
    const impl = commit(root, "impl");
    write(root, CAPS, caps(stamped(impl)));
    const m1 = commit(root, "m1 repairs the catalog");
    const rep = report(impl, { maintenanceCommits: [m1] });
    expect(await refusal(verify(root, review(impl), rep))).toContain(`baseline unavailable: ${CAPS}`);
  });
});

describe("rule (f): HEAD re-read", () => {
  it("refuses when HEAD moved after it was captured", async () => {
    const { root, impl } = setup();
    const out = await verify(root, review(impl), report(impl));
    expect(out.ok).toBe(true);
    expect(await confirmHead(realKnowledgeGit(root), impl)).toBeNull();
    write(root, NOTE_PATH, note("moved"));
    commit(root, "moved");
    const moved = await confirmHead(realKnowledgeGit(root), impl);
    expect(moved?.message).toContain("HEAD moved");
  });
});
