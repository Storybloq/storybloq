/**
 * C-v4.1 commit 5, plan section 5.7 and the shared 3.7 rows run through
 * proof: every row builds a real repository with a board, writes device
 * receipts onto the record, and reads proof through `proveRef`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proofSeams, proveRef } from "../../src/core/proof.js";
import { recordRevision } from "../../src/core/record-revision.js";
import { cleanupTempDirs, git, headSha, isolateGit, makeProjectRepo } from "../mcp/board-git-fixtures.js";

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => {
  proofSeams.beforeRevalidate = async () => {};
  cleanupTempDirs();
});

type Json = Record<string, unknown>;
const CLEAN = { staged: 0, unstaged: 0, untracked: 0, submodule: 0 };

interface Board {
  root: string;
  board: string;
  unit: string;
  codeSha: string;
  ledgerSha: string;
  file: string;
}

const readRec = (b: Board): Json => JSON.parse(readFileSync(b.file, "utf8")) as Json;
const writeRec = (b: Board, rec: Json): void => writeFileSync(b.file, JSON.stringify(rec, null, 2) + "\n");

/** T-001 with a landed code commit, then a ledger-only commit on top; origin/main at the ledger commit. */
async function board(opts: { kind?: "ticket" | "issue"; code?: boolean } = {}): Promise<Board> {
  const { root } = await makeProjectRepo();
  const cfgPath = join(root, ".story", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Json;
  if (typeof cfg.boardId !== "string") cfg.boardId = "b-00000000000000AA";
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const kind = opts.kind ?? "ticket";
  const id = kind === "ticket" ? "T-001" : "ISS-001";
  const file = join(root, ".story", kind === "ticket" ? "tickets" : "issues", `${id}.json`);
  const rec: Json = kind === "ticket"
    ? { id, title: "Ticket", description: "do it", type: "task", status: "open", phase: "p0", order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null }
    : { id, title: "Issue", status: "open", severity: "medium", components: [], impact: "x", resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [] };
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ledger");
  if (opts.code !== false) {
    writeFileSync(join(root, "code.txt"), "one\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", `${id} the code`);
  }
  const codeSha = headSha(root);
  writeFileSync(join(root, ".story", "notes.txt"), "ledger only\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "ledger only");
  const ledgerSha = headSha(root);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const b = String(cfg.boardId);
  return { root, board: b, unit: `${b}:${id}`, codeSha, ledgerSha, file };
}

let seq = 0;
function receipt(b: Board, over: Json = {}): Json {
  seq += 1;
  const rec = readRec(b);
  const kind = rec.id === "T-001" ? "ticket" : "issue";
  const sha = (over.sha as string | undefined) ?? b.codeSha;
  return {
    id: `rc-${String(seq).padStart(16, "0")}`, v: 1, kind: "device", target: b.unit, unitRef: b.unit, repo: b.board, sha,
    revisions: { unit: recordRevision(rec, kind) },
    observation: { head: sha, headMatchesSha: true, worktree: CLEAN },
    attestation: { builtFromSha: sha, builtClean: true },
    result: "pass", data: { deviceClass: "real" },
    recordedAt: `2026-11-16T00:00:${String(seq % 60).padStart(2, "0")}Z`, recordedBy: "test",
    ...over,
  };
}

function append(b: Board, ...rs: Json[]): void {
  const rec = readRec(b);
  rec.receipts = [...((rec.receipts as Json[] | undefined) ?? []), ...rs];
  writeRec(b, rec);
}

const prove = (b: Board, page?: number) => proveRef(b.root, "T-001", page !== undefined ? { page } : {});

describe("proof (C-v4.1 commit 5, 5.5 and 5.6)", () => {
  it("a passing real-device attempt on the landed code proves, with verifiedAt and a proving row", async () => {
    const b = await board();
    const r = receipt(b);
    append(b, r);
    const p = await prove(b);
    expect(p).toMatchObject({ unit: b.unit, outcome: "proven", verifiedAt: r.recordedAt, evidenceTotal: 1 });
    expect(p.evidence[0]).toMatchObject({ receipt: r.id, status: "proving" });
  });

  it("completion and reopen keep proof, checkpointEvidence included", async () => {
    const b = await board();
    append(b, receipt(b));
    writeRec(b, { ...readRec(b), status: "complete", completedDate: "2026-11-16", checkpointEvidence: [{ x: 1 }] });
    expect((await prove(b)).outcome).toBe("proven");
    writeRec(b, { ...readRec(b), status: "open", completedDate: null });
    expect((await prove(b)).outcome).toBe("proven");
  });

  it("resolving an issue keeps proof", async () => {
    const b = await board({ kind: "issue" });
    append(b, receipt(b));
    const before = await proveRef(b.root, "ISS-001");
    writeRec(b, { ...readRec(b), status: "resolved", resolvedDate: "2026-11-16", resolution: "fixed" });
    expect((await proveRef(b.root, "ISS-001")).outcome).toBe(before.outcome);
  });

  it("withdrawal, a tombstone and a blockedBy conflict are ineligible; a bookkeeping conflict is not", async () => {
    const b = await board();
    append(b, receipt(b));
    const base = readRec(b);
    writeRec(b, { ...base, resolutionKind: "withdrawn" });
    expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: expect.stringContaining("withdrawn") });
    writeRec(b, { ...base, deletedAt: "2026-11-16" });
    expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: expect.stringContaining("deleted") });
    writeRec(b, { ...base, _conflicts: [{ fieldPath: "blockedBy", field: "blockedBy", kind: "field" }] });
    expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: expect.stringContaining("merge conflict on blockedBy") });
    // A conflict on a bookkeeping field leaves the item eligible; the entry is still substantive to the revision (5.2), so it reads stale.
    writeRec(b, { ...base, _conflicts: [{ fieldPath: "order", field: "order", kind: "field" }] });
    expect(await prove(b)).toMatchObject({ outcome: "stale" });
  });

  it("a requirement edit and a dependency edit make it stale; a receipt-only append keeps it proven", async () => {
    const b = await board();
    append(b, receipt(b));
    const base = readRec(b);
    writeRec(b, { ...base, description: "changed" });
    expect(await prove(b)).toMatchObject({ outcome: "stale", reason: "evidence is for an older revision" });
    writeRec(b, { ...base, blockedBy: ["T-009"] });
    expect((await prove(b)).outcome).toBe("stale");
    writeRec(b, base);
    append(b, receipt(b, { unitRef: `${b.board}:T-777`, result: "fail" }));
    expect((await prove(b)).outcome).toBe("proven");
  });

  it("empty proving sets never prove: no receipts, only malformed ones, only an older revision (A1)", async () => {
    const b = await board();
    expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: "no current attempt" });
    append(b, { id: "rc-0000000000000999", v: 1, kind: "device" });
    expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: "no current attempt" });
    append(b, receipt(b, { revisions: { unit: "0".repeat(64) } }));
    expect(await prove(b)).toMatchObject({ outcome: "stale" });
  });

  it("a ledger-only sha descending from the code proves; a sha without the code fails rule 5; no code commit is unproven", async () => {
    const b = await board();
    append(b, receipt(b, { sha: b.ledgerSha }));
    expect((await prove(b)).outcome).toBe("proven");
    const c = await board({ code: false });
    append(c, receipt(c, { sha: c.ledgerSha }));
    expect(await prove(c)).toMatchObject({ outcome: "unproven", reason: "rule 5: no attributed code commit" });
  });

  it("an unknown-class issue with no code commit is unproven, and the non-code list skips rule 5 only", async () => {
    const b = await board({ kind: "issue", code: false });
    append(b, receipt(b, { sha: b.ledgerSha }));
    expect(await proveRef(b.root, "ISS-001")).toMatchObject({ outcome: "unproven", reason: "rule 5: no attributed code commit" });
    const cfgPath = join(b.root, ".story", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Json;
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, proof: { nonCodeItems: [{ ref: b.unit, reason: "docs only" }] } }, null, 2) + "\n");
    const p = await proveRef(b.root, "ISS-001");
    expect(p).toMatchObject({ outcome: "proven", children: [{ workClass: "non-code" }] });
  });

  it("a class written on the record or receipt is ignored: only the config list makes an item non-code", async () => {
    const b = await board({ kind: "issue", code: false });
    writeRec(b, { ...readRec(b), workClass: "non-code" });
    append(b, receipt(b, { sha: b.ledgerSha }));
    expect(await proveRef(b.root, "ISS-001")).toMatchObject({ outcome: "unproven", children: [{ workClass: "unknown" }] });
  });

  it("a later code commit on the default branch makes it stale", async () => {
    const b = await board();
    append(b, receipt(b));
    writeFileSync(join(b.root, "code.txt"), "two\n");
    git(b.root, "add", "code.txt");
    git(b.root, "commit", "-q", "-m", "T-001 more code");
    git(b.root, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(await prove(b)).toMatchObject({ outcome: "stale", reason: "a later code commit" });
  });

  it("a sha off the default branch fails rule 4, a dirty build fails rule 3, a dirty worktree is unproven", async () => {
    const b = await board();
    git(b.root, "checkout", "-q", "-b", "side");
    writeFileSync(join(b.root, "side.txt"), "x\n");
    git(b.root, "add", "-A");
    git(b.root, "commit", "-q", "-m", "T-001 side");
    const side = headSha(b.root);
    git(b.root, "checkout", "-q", "main");
    append(b, receipt(b, { sha: side }));
    expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: "rule 4: its sha is not on the default branch" });
    const c = await board();
    append(c, receipt(c, { attestation: { builtFromSha: c.codeSha, builtClean: false } }));
    expect(await prove(c)).toMatchObject({ outcome: "unproven", reason: "rule 3: not built clean from its sha" });
    const d = await board();
    append(d, receipt(d));
    writeFileSync(join(d.root, "stray.txt"), "x\n");
    expect(await prove(d)).toMatchObject({ outcome: "unproven", reason: "worktree dirty" });
  }, 30_000);

  it("3.7 through proof: superseded pass, concurrent pair, a later pass over both, a simulator superseder", async () => {
    const b = await board();
    const pass = receipt(b);
    const fail = receipt(b, { result: "fail", supersedes: [pass.id] });
    append(b, pass, fail);
    expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: "failing" });

    const c = await board();
    const p1 = receipt(c);
    const f1 = receipt(c, { result: "fail" });
    append(c, f1, p1);
    expect(await prove(c)).toMatchObject({ outcome: "unproven", reason: "concurrent" });
    append(c, receipt(c, { supersedes: [p1.id, f1.id] }));
    expect((await prove(c)).outcome).toBe("proven");

    const d = await board();
    const real = receipt(d);
    append(d, real, receipt(d, { data: { deviceClass: "simulator" }, supersedes: [real.id] }));
    const pd = await prove(d);
    expect(pd).toMatchObject({ outcome: "unproven", reason: "no real-device attempt" });
    expect(pd.evidence.map((e) => e.status).sort()).toEqual(["not-counted (deviceClass)", "superseded"]);

    const e = await board();
    const keep = receipt(e);
    append(e, keep, receipt(e, { unitRef: `${e.board}:T-777`, result: "fail", supersedes: [keep.id] }));
    expect((await prove(e)).outcome).toBe("proven");
  }, 30_000);

  it("a stored boardId no registered board carries is unproven (unresolved repo, Q2)", async () => {
    const b = await board();
    append(b, receipt(b), receipt(b, { unitRef: "b-zzzzzzzzzzzzzzzz:T-001" }));
    expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: expect.stringContaining("unresolved repo") });
  });

  it("evidence is paged 20 per page while the outcome is computed over every receipt", async () => {
    const b = await board();
    const rs = Array.from({ length: 24 }, () => receipt(b));
    append(b, ...rs, receipt(b, { result: "fail" }));
    const p1 = await prove(b, 1);
    const p2 = await prove(b, 2);
    expect(p1).toMatchObject({ outcome: "unproven", reason: "concurrent", evidenceTotal: 25, pages: 2 });
    expect(p1.evidence).toHaveLength(20);
    expect(p2.evidence).toHaveLength(5);
  });

  describe("inputs moving during proof (5.6, A4)", () => {
    const moveOnce = (fn: () => void) => {
      let done = false;
      proofSeams.beforeRevalidate = async () => {
        if (!done) { done = true; fn(); }
      };
    };

    it("a concurrent withdrawal recomputes to unproven", async () => {
      const b = await board();
      append(b, receipt(b));
      moveOnce(() => writeRec(b, { ...readRec(b), resolutionKind: "withdrawn" }));
      expect(await prove(b)).toMatchObject({ outcome: "unproven", recomputed: true, reason: expect.stringContaining("withdrawn") });
    });

    it("a superseding failure appended recomputes to failing", async () => {
      const b = await board();
      const r = receipt(b);
      append(b, r);
      moveOnce(() => append(b, receipt(b, { result: "fail", supersedes: [r.id] })));
      expect(await prove(b)).toMatchObject({ outcome: "unproven", recomputed: true, reason: "failing" });
    });

    it("a receipt conflict merged in recomputes", async () => {
      const b = await board();
      const r = receipt(b);
      append(b, r);
      moveOnce(() => writeRec(b, { ...readRec(b), _conflicts: [{ fieldPath: "receipts", kind: "receipt", id: r.id, base: null, ours: "d1", theirs: "d2" }] }));
      expect((await prove(b)).recomputed).toBe(true);
    });

    it("a nonCodeItems change recomputes, and a dirtied worktree recomputes to unproven", async () => {
      const b = await board();
      append(b, receipt(b));
      const cfgPath = join(b.root, ".story", "config.json");
      moveOnce(() => {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Json;
        writeFileSync(cfgPath, JSON.stringify({ ...cfg, proof: { nonCodeItems: [{ ref: b.unit, reason: "r" }] } }, null, 2) + "\n");
      });
      expect(await prove(b)).toMatchObject({ outcome: "proven", recomputed: true, children: [{ workClass: "non-code" }] });
      moveOnce(() => writeFileSync(join(b.root, "stray.txt"), "x\n"));
      expect(await prove(b)).toMatchObject({ outcome: "unproven", recomputed: true, reason: "worktree dirty" });
    });

    it("a ref moved recomputes; inputs that keep moving give inputs moved", async () => {
      const b = await board();
      append(b, receipt(b));
      moveOnce(() => git(b.root, "update-ref", "refs/heads/extra", "HEAD"));
      expect(await prove(b)).toMatchObject({ outcome: "proven", recomputed: true });
      let n = 0;
      proofSeams.beforeRevalidate = async () => { n += 1; git(b.root, "update-ref", `refs/heads/moving-${n}`, "HEAD"); };
      expect(await prove(b)).toMatchObject({ outcome: "unproven", reason: "inputs moved" });
    });
  });
});
