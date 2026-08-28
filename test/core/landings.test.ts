import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildLandings, type Landing, type LandingsResult } from "../../src/core/landings.js";
import { writeGateAckUnlocked } from "../../src/core/gate-ack-loader.js";
import { computeGateAckId, type GateAck, type GateAckPin } from "../../src/models/gate-ack.js";
import { makeState, makeTicket, makeIssue } from "./test-factories.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function commit(cwd: string, subject: string): string {
  writeFileSyncUnique(cwd);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--allow-empty", "-m", subject]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

let fileCounter = 0;
function writeFileSyncUnique(cwd: string): void {
  // Real (non-empty) commits so `%T` (tree id) differs commit to commit,
  // which is closer to reality than `--allow-empty`'s repeated empty tree.
  writeFileSync(join(cwd, `f${fileCounter++}.txt`), `content ${fileCounter}\n`);
}

describe("buildLandings", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "landings-"));
    // Explicit, not just the ambient default: a machine with
    // `init.defaultObjectFormat=sha256` set globally would otherwise create a
    // SHA-256 repo here and break every fixed-40-hex-char assertion below,
    // independent of anything this feature does.
    git(root, ["init", "-q", "--object-format=sha1"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    await mkdir(join(root, ".story", "arrangement-acks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function okResult(result: LandingsResult): Extract<LandingsResult, { status: "ok" }> {
    expect(result.status).toBe("ok");
    return result as Extract<LandingsResult, { status: "ok" }>;
  }

  it("reports landings-unavailable, never throws, when root is not a git repository", async () => {
    const bare = await mkdtemp(join(tmpdir(), "not-a-repo-"));
    try {
      const state = makeState({});
      const result = buildLandings(bare, state, {});
      expect(result.status).toBe("landings-unavailable");
      if (result.status === "landings-unavailable") expect(result.reason.length).toBeGreaterThan(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("resolves a subject-ref ticket token to its canonical id", async () => {
    commit(root, "docs: unrelated");
    commit(root, "feat: implement T-100 -- add the thing");
    const state = makeState({ tickets: [makeTicket({ id: "t-0000000000000100", displayId: "T-100" })] });
    const result = okResult(buildLandings(root, state, {}));
    const landing = result.landings.find((l) => l.subject.includes("T-100"))!;
    expect(landing.refs).toHaveLength(1);
    expect(landing.refs[0]!.ref).toBe("t-0000000000000100");
    expect(landing.refs[0]!.source).toBe("subject-ref");
    expect(landing.unresolvedTokens).toEqual([]);
  });

  it("resolves an issue ref and reports notApplicable coverage for it", async () => {
    commit(root, "fix: ISS-200 -- patch the bug");
    const state = makeState({ issues: [makeIssue({ id: "i-0000000000000200", displayId: "ISS-200" })] });
    const result = okResult(buildLandings(root, state, {}));
    const landing = result.landings[0]!;
    expect(landing.refs[0]!.ref).toBe("i-0000000000000200");
    expect(landing.refs[0]!.coverage.gateAckCoverage).toBe("notApplicable");
    expect(landing.summary).toBe("not-applicable");
  });

  it("records a ref-shaped token that does not resolve as unresolved, not silently dropped", async () => {
    commit(root, "chore: T-999999 -- ghost ticket, never existed");
    const result = okResult(buildLandings(root, makeState({}), {}));
    expect(result.landings[0]!.refs).toEqual([]);
    expect(result.landings[0]!.unresolvedTokens).toContain("T-999999");
    expect(result.landings[0]!.summary).toBe("unattributed");
  });

  it("a subject containing the OLD printable-control-character delimiters (0x1e/0x1f) still parses and resolves correctly (field alignment unaffected), but renders those bytes sanitized rather than verbatim (T-477 round-4 finding #3)", async () => {
    // Verified empirically: git happily stores these bytes in a subject and
    // `%s` echoes them back unchanged -- only NUL is refused by git itself,
    // which is exactly why this parser now delimits on NUL instead. The
    // record still parses and the ref still resolves despite the control
    // bytes being present in the RAW git subject, proving field alignment is
    // unaffected -- but the acceptor's post-cap ruling requires all
    // repo-controlled display text to be sanitized before rendering, so the
    // rendered `subject` replaces those bytes with `?` rather than echoing
    // them verbatim (a terminal-escape-injection defense, not a parsing
    // concern).
    writeFileSyncUnique(root);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "feat: T-1 -- weird\x1fsubject\x1ewith control chars"]);
    const result = okResult(buildLandings(root, makeState({ tickets: [makeTicket({ id: "t-0000000000000001", displayId: "T-1" })] }), {}));
    expect(result.landings).toHaveLength(1);
    expect(result.landings[0]!.subject).toBe("feat: T-1 -- weird?subject?with control chars");
    expect(result.landings[0]!.refs).toHaveLength(1);
    expect(result.landings[0]!.refs[0]!.ref).toBe("t-0000000000000001");
  });

  it("a commit with zero refs is unattributed, always visible (not dropped from the feed)", async () => {
    commit(root, "chore: routine maintenance, no ticket");
    const result = okResult(buildLandings(root, makeState({}), {}));
    expect(result.landings).toHaveLength(1);
    expect(result.landings[0]!.refs).toEqual([]);
    expect(result.landings[0]!.summary).toBe("unattributed");
  });

  it("--since excludes the boundary commit and includes everything after it", async () => {
    const boundary = commit(root, "T-1: boundary commit");
    commit(root, "T-1: after boundary");
    const state = makeState({ tickets: [makeTicket({ id: "t-0000000000000001", displayId: "T-1" })] });
    const result = okResult(buildLandings(root, state, { since: boundary }));
    expect(result.landings).toHaveLength(1);
    expect(result.landings[0]!.subject).toContain("after boundary");
  });

  it("--limit caps the default range without --since", async () => {
    for (let i = 0; i < 5; i++) commit(root, `chore: commit ${i}`);
    const result = okResult(buildLandings(root, makeState({}), { limit: 2 }));
    expect(result.landings).toHaveLength(2);
  });

  it("a negative --limit is rejected rather than passed to git, which treats a negative max-count as unlimited", async () => {
    for (let i = 0; i < 3; i++) commit(root, `chore: commit ${i}`);
    const result = buildLandings(root, makeState({}), { limit: -1 });
    expect(result.status).toBe("landings-unavailable");
    if (result.status === "landings-unavailable") expect(result.reason).toContain("--limit");
  });

  it("a non-integer --limit is rejected with a clear reason instead of a raw git error", async () => {
    commit(root, "chore: something");
    const result = buildLandings(root, makeState({}), { limit: 1.5 });
    expect(result.status).toBe("landings-unavailable");
    if (result.status === "landings-unavailable") expect(result.reason).toContain("--limit");
  });

  describe("resolution-sha cross-referencing", () => {
    it("finds a resolution-sha ref for an issue whose resolution names this exact commit, and marks crossConfirmed when the subject ALSO names it", async () => {
      const sha = commit(root, "fix: ISS-5 -- patch applied");
      const state = makeState({ issues: [makeIssue({ id: "i-0000000000000005", displayId: "ISS-5", resolution: `Fixed in commit ${sha}.` })] });
      const result = okResult(buildLandings(root, state, {}));
      const landing = result.landings[0]!;
      expect(landing.refs).toHaveLength(1);
      expect(landing.refs[0]!.ref).toBe("i-0000000000000005");
      expect(landing.refs[0]!.crossConfirmed).toBe(true);
    });

    it("a resolution-sha ref with NO matching subject token is source resolution-sha and not crossConfirmed", async () => {
      const sha = commit(root, "chore: unrelated commit message");
      const state = makeState({ issues: [makeIssue({ id: "i-0000000000000006", resolution: `See ${sha} for the fix.` })] });
      const result = okResult(buildLandings(root, state, {}));
      const landing = result.landings[0]!;
      expect(landing.refs).toHaveLength(1);
      expect(landing.refs[0]!.source).toBe("resolution-sha");
      expect(landing.refs[0]!.crossConfirmed).toBe(false);
    });

    it("a full-length sha in a resolution that matches no commit in this run is unresolvedResolutionShas with reason unresolved", async () => {
      commit(root, "chore: something");
      const fakeSha = "f".repeat(40);
      const state = makeState({ issues: [makeIssue({ id: "i-0000000000000007", resolution: `Fixed in ${fakeSha}.` })] });
      const result = okResult(buildLandings(root, state, {}));
      expect(result.unresolvedResolutionShas).toEqual([{ issueRef: "i-0000000000000007", token: fakeSha, reason: "unresolved" }]);
    });

    it("finds a resolution-sha ref even when the resolution text spells the sha in UPPERCASE (free-form prose, unlike git's own always-lowercase %H)", async () => {
      const sha = commit(root, "chore: something");
      const state = makeState({ issues: [makeIssue({ id: "i-0000000000000009", resolution: `Fixed in ${sha.toUpperCase()}.` })] });
      const result = okResult(buildLandings(root, state, {}));
      const landing = result.landings[0]!;
      expect(landing.refs).toHaveLength(1);
      expect(landing.refs[0]!.ref).toBe("i-0000000000000009");
      expect(landing.refs[0]!.source).toBe("resolution-sha");
    });

    it("an abbreviated (short) sha in a resolution is ambiguous-prefix, never guess-matched", async () => {
      const sha = commit(root, "chore: something");
      const state = makeState({ issues: [makeIssue({ id: "i-0000000000000008", resolution: `Fixed in ${sha.slice(0, 10)}.` })] });
      const result = okResult(buildLandings(root, state, {}));
      expect(result.unresolvedResolutionShas).toEqual([{ issueRef: "i-0000000000000008", token: sha.slice(0, 10), reason: "ambiguous-prefix" }]);
      // Never silently folded into this commit's refs even though the prefix DOES match it.
      expect(result.landings[0]!.refs).toEqual([]);
    });
  });

  describe("review coverage wiring", () => {
    async function ackForHead(root: string, ticketRef: string, overrides: Partial<GateAck> = {}): Promise<GateAck> {
      const sha = git(root, ["rev-parse", "HEAD"]);
      const treeId = git(root, ["rev-parse", `${sha}^{tree}`]);
      const parents = git(root, ["log", "-1", "--format=%P", sha]);
      const parentSha = parents.trim().split(/\s+/)[0]!;
      const pin: GateAckPin = { kind: "tree-digest", parentSha, treeId };
      const ack: GateAck = {
        id: computeGateAckId("a-0000000000000001", "pre-commit-ack", ticketRef, pin),
        arrangementId: "a-0000000000000001",
        gateName: "pre-commit-ack",
        ackRole: "pen",
        ticketRef,
        pin,
        decidedAt: "2026-08-28T00:00:00.000Z",
        reviewTrail: { present: false },
        contested: false,
        ...overrides,
      } as GateAck;
      return writeGateAckUnlocked(ack, root);
    }

    it("a commit with a matching pre-commit-ack reads fully-covered when reviewTrail is present", async () => {
      commit(root, "chore: unrelated first commit"); // gives the T-1 commit a real parent
      commit(root, "feat: T-1 -- implement");
      await ackForHead(root, "t-0000000000000001", { reviewTrail: { present: true, verdict: "approve" } });
      const state = makeState({ tickets: [makeTicket({ id: "t-0000000000000001", displayId: "T-1" })] });
      const result = okResult(buildLandings(root, state, {}));
      const landing = result.landings.find((l) => l.subject.includes("T-1"))!;
      expect(landing.refs[0]!.coverage.gateAckCoverage).toBe("matched");
      expect(landing.refs[0]!.coverage.reviewEvidence).toBe("present");
      expect(landing.summary).toBe("fully-covered");
    });

    it("a commit with NO ack at all reads absent -> needs-attention", async () => {
      commit(root, "chore: unrelated first commit"); // gives the T-2 commit a real parent
      commit(root, "feat: T-2 -- implement");
      const state = makeState({ tickets: [makeTicket({ id: "t-0000000000000002", displayId: "T-2" })] });
      const result = okResult(buildLandings(root, state, {}));
      const landing = result.landings[0]!;
      expect(landing.refs[0]!.coverage.gateAckCoverage).toBe("absent");
      expect(landing.summary).toBe("needs-attention");
    });

    it("a broken ack's ticketRef spelled with a DIFFERENT alias of the SAME ticket (display id vs. this run's canonical ref) is scoped to that ticket via the real ProjectState resolver, not fail-closed globally (T-477 round-4 finding #2)", async () => {
      commit(root, "chore: unrelated first commit"); // gives the T-477 commit a real parent
      commit(root, "feat: T-477 -- implement"); // subject uses the DISPLAY form
      // Broken record (schema mismatch: pin has no recognized kind), whose
      // OWN ticketRef is spelled in the DISPLAY form -- while `buildLandings`
      // classifies this commit's ref in its CANONICAL form (below). Before
      // the round-4 alias-set fix, a plain `===` comparison would never see
      // these as the same ticket.
      await writeFile(
        join(root, ".story", "arrangement-acks", "g-aliasedbroken0.json"),
        JSON.stringify({
          id: "g-aliasedbroken0",
          arrangementId: "a-0000000000000001",
          gateName: "pre-commit-ack",
          ackRole: "pen",
          ticketRef: "T-477",
          pin: { kind: "plan-hash" },
        }),
      );
      const state = makeState({ tickets: [makeTicket({ id: "t-0000000000000477", displayId: "T-477" })] });
      const result = okResult(buildLandings(root, state, {}));
      // Scoped to T-477 itself (its own coverage reads unknown over its own
      // unreadable ack)...
      const landing = result.landings.find((l) => l.subject.includes("T-477"))!;
      expect(landing.refs[0]!.coverage.gateAckCoverage).toBe("unknown");
      // ...and NOT leaked into the project-wide unattributed bucket, which is
      // exactly what round-4 finding #2 caught: the alias mismatch used to
      // make this indistinguishable from a truly unattributable record.
      expect(result.unattributedGateAckWarnings).toEqual([]);
    });

    it("the project-wide unattributed-corruption doctrine forces every gate-ack-eligible ref to unknown for the whole run", async () => {
      commit(root, "chore: unrelated");
      commit(root, "feat: T-3 -- implement");
      await ackForHead(root, "t-0000000000000003", { reviewTrail: { present: true, verdict: "approve" } });
      // A totally unparseable ack file, no recoverable ticketRef at all.
      await writeFile(join(root, ".story", "arrangement-acks", "g-corrupt00000000.json"), "{not json");

      const state = makeState({ tickets: [makeTicket({ id: "t-0000000000000003", displayId: "T-3" })] });
      const result = okResult(buildLandings(root, state, {}));
      expect(result.unattributedGateAckWarnings.length).toBeGreaterThan(0);
      const landing = result.landings.find((l) => l.subject.includes("T-3"))!;
      expect(landing.refs[0]!.coverage.gateAckCoverage).toBe("unknown");
      expect(["matched", "absent"]).not.toContain(landing.refs[0]!.coverage.gateAckCoverage);
    });
  });

  describe("object format", () => {
    it("reports the repo's real object format (sha1 on an ordinary test-created repo)", async () => {
      commit(root, "chore: something");
      const result = okResult(buildLandings(root, makeState({}), {}));
      expect(result.objectFormat).toBe("sha1");
      expect(result.landings[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    });
  });
});
