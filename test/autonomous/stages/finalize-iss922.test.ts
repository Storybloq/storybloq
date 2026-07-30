/**
 * ISS-922: parking a session after it commits, but before FINALIZE has seen
 * the commit, must not close the stage.
 *
 * Observed live: a session committed its work item, was parked by the
 * usage-limit hook, resumed, and then every FINALIZE exit refused work that
 * demonstrably existed on disk. Recovery required hand-editing state.json.
 *
 * Cause: `git.expectedHead` served two jobs at once. Park, resume-drift and
 * checkout all advance it, which is correct for drift detection and fatal for
 * the finalization baseline, because they advance it onto the very commit
 * FINALIZE has not yet seen. `git.itemBaseHead` now carries the finalization
 * baseline alone.
 *
 * These run against REAL temporary git repositories. Asserting on field values
 * after a hand-written poisoning would prove nothing about whether the stage
 * can still be closed, which is the property that actually failed.
 *
 * P1 and P2 call the REAL park functions, so they pin the writers themselves.
 * P3 does NOT: it is a stage-level test over the state that guide.ts's resume
 * fast-forward produces, constructed directly. The real resume writer is pinned
 * separately in test/autonomous/handle-resume.test.ts. P3 therefore cannot
 * catch a composition regression across park, resume and FINALIZE; it only
 * proves the stage survives that state shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import { prepareForCompact, prepareForLimitStop } from "../../../src/autonomous/session.js";
import { gitDiffTreeNames } from "../../../src/autonomous/git-inspector.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

const SESSION_ID = "00000000-0000-0000-0000-00000000922a";
const ISSUE_ID = "ISS-922-fixture";
const ISSUE_PATH = `.story/issues/${ISSUE_ID}.json`;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

function head(root: string): string {
  return git(root, ["rev-parse", "HEAD"]);
}

/** A real repo with a `.story/` tree and one initial commit. */
function buildRepo(): { root: string; initHead: string } {
  const root = mkdtempSync(join(tmpdir(), "iss922-"));
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["init", "-q", "."]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "initial"]);
  return { root, initHead: head(root) };
}

/** Land the item's work commit: the artifact plus a code file, as a real fix would. */
function landWorkCommit(root: string, opts?: { withArtifact?: boolean }): string {
  const withArtifact = opts?.withArtifact ?? true;
  writeFileSync(join(root, "src-change.txt"), `change ${Date.now()}\n`);
  if (withArtifact) {
    writeFileSync(join(root, ISSUE_PATH), JSON.stringify({ id: ISSUE_ID, status: "resolved" }));
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "work commit"]);
  return head(root);
}

/** An unrelated commit that touches neither the artifact nor anything the item owns. */
function landUnrelatedCommit(root: string): string {
  writeFileSync(join(root, `unrelated-${Date.now()}.txt`), "x\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "unrelated"]);
  return head(root);
}

function sessionDirFor(root: string): string {
  const dir = join(root, ".story", "sessions", SESSION_ID);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeState(root: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  const h = head(root);
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    recipe: "coding",
    state: "FINALIZE",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: "precommit_passed",
    git: {
      branch: "main",
      mergeBase: h,
      expectedHead: h,
      initHead: h,
      itemBaseHead: h,
      autoStash: null,
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
    },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
    ticket: undefined,
    currentIssue: { id: ISSUE_ID, title: "fixture", severity: "high" },
    resolvedIssues: [],
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as unknown as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "ISSUE_FIX", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
  } as unknown as ResolvedRecipe;
}

function readState(dir: string): FullSessionState {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as FullSessionState;
}

const stage = new FinalizeStage();
const text = (r: { instruction?: string }): string => r.instruction ?? "";

/**
 * The three FINALIZE exits, each from its OWN context. They are independently
 * reachable, so any one of them could regress while the other two stay green.
 */
async function assertAllThreeExitsOpen(root: string, dir: string, state: FullSessionState, workCommit: string) {
  const entered = await stage.enter(new StageContext(root, dir, { ...state }, makeRecipe()));
  expect(text(entered as { instruction?: string }), "enter() emitted the staging ceremony").not.toContain("# Finalize");
  // The already-committed shortcut delegates to handleCommit, so a healthy
  // enter() reaches the SAME exit as the other two. Asserting merely that some
  // action came back would pass on a refusal that happens not to say
  // "# Finalize".
  expect((entered as { action?: string }).action, "enter() did not carry the commit forward").toBe("goto");

  const staged = await stage.report(
    new StageContext(root, dir, { ...state, finalizeCheckpoint: null }, makeRecipe()),
    { completedAction: "files_staged" },
  );
  expect(text(staged), "report() fell through to the catch-all, so handleStage never ran")
    .not.toContain("Unexpected action");
  expect(text(staged), "handleStage dead-ended on an empty index").not.toContain("No files are staged");
  expect(staged.action, "handleStage did not carry the commit forward").toBe("goto");

  const committed = await stage.report(
    new StageContext(root, dir, { ...state }, makeRecipe()),
    { completedAction: "commit_done", commitHash: workCommit },
  );
  expect(text(committed), "handleCommit refused a commit that exists").not.toContain("No new commit detected");
  expect(committed.action, "handleCommit did not accept the commit").toBe("goto");
}

describe("ISS-922: a park between commit and FINALIZE must not close the stage", () => {
  let root: string;
  let dir: string;
  let initHead: string;

  beforeEach(() => {
    ({ root, initHead } = buildRepo());
    dir = sessionDirFor(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("P1: the usage-limit park (the observed failure) leaves every exit open", () => {
    const base = makeState(root);
    const workCommit = landWorkCommit(root);

    // The REAL park function, with the head it really captures at limit time.
    prepareForLimitStop(dir, { ...base, git: { ...base.git, itemBaseHead: initHead, expectedHead: initHead } }, {
      expectedHead: workCommit,
      permissionMode: "acceptEdits",
      resumeAt: Date.now() + 60_000,
      limitEventId: "evt-922",
    });

    const parked = readState(dir);
    expect(parked.git.expectedHead, "park should still record the observation").toBe(workCommit);
    expect(parked.git.itemBaseHead, "park must NOT move the finalization baseline").toBe(initHead);

    return assertAllThreeExitsOpen(root, dir, { ...parked, state: "FINALIZE", compactPending: false }, workCommit);
  });

  it("P2: the pre-FINALIZE compact window leaves every exit open", () => {
    const base = makeState(root, { state: "ISSUE_FIX" });
    const workCommit = landWorkCommit(root);

    // prepareForCompact throws on FINALIZE, so the reachable route is the
    // window where the commit has landed but the state is still ISSUE_FIX.
    prepareForCompact(dir, { ...base, git: { ...base.git, itemBaseHead: initHead, expectedHead: initHead } }, {
      expectedHead: workCommit,
    });

    const parked = readState(dir);
    expect(parked.git.expectedHead).toBe(workCommit);
    expect(parked.git.itemBaseHead, "compact must NOT move the finalization baseline").toBe(initHead);

    return assertAllThreeExitsOpen(root, dir, { ...parked, state: "FINALIZE", compactPending: false }, workCommit);
  });

  it("P3 (stage-level): the state the resume fast-forward produces leaves every exit open", async () => {
    const base = makeState(root);
    const workCommit = landWorkCommit(root);

    // The CLI PreCompact hook passes no opts, so expectedHead survives the
    // park; guide.ts's own-commit branch then fast-forwards it on resume.
    // Constructed here rather than driven: this asserts the STAGE tolerates the
    // resulting shape. That the resume writer actually produces it, and leaves
    // itemBaseHead alone, is pinned in test/autonomous/handle-resume.test.ts.
    const promoted = {
      ...base,
      git: { ...base.git, initHead, itemBaseHead: initHead, expectedHead: workCommit },
    };

    await assertAllThreeExitsOpen(root, dir, promoted, workCommit);
  });
});

describe("ISS-922: the baseline still refuses what it should", () => {
  let root: string;
  let dir: string;
  let initHead: string;

  beforeEach(() => {
    ({ root, initHead } = buildRepo());
    dir = sessionDirFor(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a commit without the item's artifact is still sent back to amend", async () => {
    const commitWithoutArtifact = landWorkCommit(root, { withArtifact: false });
    const state = makeState(root, {
      git: { ...makeState(root).git, initHead, itemBaseHead: initHead, expectedHead: initHead },
    } as Partial<FullSessionState>);

    const staged = await stage.report(
      new StageContext(root, dir, { ...state, finalizeCheckpoint: null }, makeRecipe()),
      { completedAction: "files_staged" },
    );
    expect(text(staged)).toContain(ISSUE_PATH);
    expect(text(staged)).toContain("not in the commit");
    expect(commitWithoutArtifact).toBe(head(root));
  });

  it("genuinely no new commit is still refused, and the refusal is not a dead end", async () => {
    const state = makeState(root);

    const committed = await stage.report(
      new StageContext(root, dir, state, makeRecipe()),
      { completedAction: "commit_done", commitHash: state.git.itemBaseHead! },
    );
    expect(text(committed)).toContain("No new commit detected");
    // The old text said "Create a commit first" and stopped there, which is
    // false for an operator whose commit already exists.
    expect(text(committed)).toContain("storybloq session stop");
    expect(text(committed)).toContain("git show");
  });

  it("a feature branch whose mergeBase sits behind HEAD does not fire the shortcut", async () => {
    // This is why mergeBase was rejected as the baseline: it is the fork point
    // from main, so it differs from HEAD before any work commit exists, and a
    // mergeBase-rooted baseline would demand an amend of a pre-existing commit.
    const forkPoint = initHead;
    const branchTip = landUnrelatedCommit(root);
    const state = makeState(root, {
      git: {
        branch: "feature", mergeBase: forkPoint, initHead: branchTip,
        itemBaseHead: branchTip, expectedHead: branchTip, autoStash: null,
        baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
      },
    } as unknown as Partial<FullSessionState>);

    const entered = await stage.enter(new StageContext(root, dir, state, makeRecipe()));
    expect(text(entered as { instruction?: string }), "shortcut fired against a pre-existing branch commit")
      .toContain("# Finalize");
  });
});

describe("ISS-922: diagnosing a session poisoned by a pre-fix CLI, without healing it", () => {
  let root: string;
  let dir: string;
  let initHead: string;

  beforeEach(() => {
    ({ root, initHead } = buildRepo());
    dir = sessionDirFor(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Legacy state as PARKING leaves it: no itemBaseHead at all, expectedHead
   * promoted onto the work commit, and mergeBase still on the item's review
   * base. That last part matters -- prepareForCompact / prepareForLimitStop
   * move expectedHead alone, and the diagnosis uses mergeBase to tell this
   * shape apart from foreign drift, which moves both.
   */
  function legacyPoisoned(workCommit: string): FullSessionState {
    const s = makeState(root);
    const g = { ...s.git, initHead, mergeBase: initHead, expectedHead: workCommit };
    delete (g as Record<string, unknown>).itemBaseHead;
    return { ...s, git: g } as FullSessionState;
  }

  it("names a stranded commit and the steps to confirm it, but never records it", async () => {
    // The guide does not heal this. A pre-existing branch tip is
    // indistinguishable from a stranded work commit in a pre-fix state, so the
    // evidence buys a better message and nothing more. What the operator must
    // NOT get is a dead end.
    const workCommit = landWorkCommit(root);
    const state = legacyPoisoned(workCommit);

    const committed = await stage.report(
      new StageContext(root, dir, state, makeRecipe()),
      { completedAction: "commit_done", commitHash: workCommit },
    );
    expect(committed.action, "still a refusal -- nothing is recorded").toBe("retry");
    const msg = text(committed);
    expect(msg, "the specific commit must be named").toContain(workCommit.slice(0, 7));
    expect(msg).toContain("predates the ISS-922 fix");
    expect(msg).toContain("NOT recorded automatically");
    expect(msg, "the escape must be spelled out").toContain("storybloq session stop");

    const staged = await stage.report(
      new StageContext(root, dir, { ...state, finalizeCheckpoint: null }, makeRecipe()),
      { completedAction: "files_staged" },
    );
    expect(text(staged)).not.toContain("Unexpected action");
    expect(text(staged), "the empty-index exit carries the same diagnosis")
      .toContain("predates the ISS-922 fix");
  });

  it("says nothing about a stranded commit for a session THIS CLI wrote", async () => {
    // The diagnosis is legacy-only, and this is why. A fixed session can pick an
    // item while HEAD already sits on the commit that FILED it -- that commit
    // descends from initHead and does modify the item's ledger file, so every
    // remaining check would pass on a commit the session never produced.
    const filingCommit = landWorkCommit(root);
    const base = makeState(root);
    const fixed = {
      ...base,
      git: { ...base.git, initHead, mergeBase: initHead, expectedHead: filingCommit, itemBaseHead: filingCommit },
    } as FullSessionState;

    const committed = await stage.report(
      new StageContext(root, dir, fixed, makeRecipe()),
      { completedAction: "commit_done", commitHash: filingCommit },
    );
    expect(committed.action).toBe("retry");
    const msg = text(committed);
    expect(msg).toContain("No new commit detected");
    expect(msg, "a fixed session must not be told its baseline may be poisoned")
      .not.toContain("predates the ISS-922 fix");
  });

  it("refuses a legacy branch TIP that already carried this item's ledger update", async () => {
    // The shape that makes automatic healing unsafe, and the reason it was
    // removed. The pre-fix checkout writer promoted expectedHead alone and left
    // mergeBase behind -- byte-identical to parking. Here the tip descends from
    // initHead and does modify the artifact, so every evidence check passes,
    // yet this session produced and reviewed nothing.
    const tip = landWorkCommit(root);
    const state = legacyPoisoned(tip);

    const committed = await stage.report(
      new StageContext(root, dir, state, makeRecipe()),
      { completedAction: "commit_done", commitHash: tip },
    );
    expect(committed.action, "an unreviewed pre-existing tip must not complete the item").toBe("retry");
    expect(text(committed)).toContain("No new commit detected");
  });

  it("refuses when an EARLIER commit touched the artifact but the candidate did not", async () => {
    // The case that separates exact candidate membership from "is the artifact
    // touched anywhere in the range". A range-level test passes this wrongly.
    landWorkCommit(root);
    const candidate = landUnrelatedCommit(root);
    const state = legacyPoisoned(candidate);

    const committed = await stage.report(
      new StageContext(root, dir, state, makeRecipe()),
      { completedAction: "commit_done", commitHash: candidate },
    );
    expect(text(committed)).toContain("No new commit detected");
  });

  it("offers no diagnosis for a later commit when only an EARLIER commit touched the artifact", async () => {
    // The false positive the diagnosis must never produce. Measured: the range
    // initHead..candidate for the artifact is NON-EMPTY (it lists the earlier
    // commit) while excluding the candidate -- so "the range found something"
    // is not evidence about THIS commit.
    writeFileSync(join(root, ISSUE_PATH), JSON.stringify({ id: ISSUE_ID, status: "inprogress" }));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "earlier commit touches the artifact"]);
    writeFileSync(join(root, "src.txt"), "later\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "later commit touches only source"]);
    const later = head(root);

    const committed = await stage.report(
      new StageContext(root, dir, legacyPoisoned(later), makeRecipe()),
      { completedAction: "commit_done", commitHash: later },
    );
    expect(text(committed)).toContain("No new commit detected");
    expect(text(committed), "no stranded-commit diagnosis may be offered for this shape")
      .not.toContain("predates the ISS-922 fix");
  });

  it("offers no diagnosis for a candidate on UNRELATED history, even though it modifies the artifact", async () => {
    // Isolates the ancestry condition, which is the only one that refuses here:
    // the candidate's own tree DOES change the artifact, so the direct evidence
    // check passes. It is simply not descended from initHead, so the range is
    // empty. Reachable for a legacy session whose branch strategy checked out
    // unrelated history before the item was finalized.
    git(root, ["checkout", "-q", "--orphan", "unrelated"]);
    git(root, ["rm", "-rq", "--cached", "."]);
    writeFileSync(join(root, "unrelated.txt"), "root\n");
    git(root, ["add", "unrelated.txt"]);
    // The orphan needs a root commit of its own first: diff-tree reports
    // nothing for a parentless commit, which would make the direct-evidence
    // check fail for the wrong reason and stop this isolating condition 2.
    git(root, ["commit", "-qm", "unrelated root"]);
    mkdirSync(join(root, ".story", "issues"), { recursive: true });
    writeFileSync(join(root, ISSUE_PATH), JSON.stringify({ id: ISSUE_ID, status: "resolved" }));
    git(root, ["add", ISSUE_PATH]);
    git(root, ["commit", "-qm", "unrelated history resolves the same issue"]);
    const foreign = head(root);

    const tree = await gitDiffTreeNames(root, foreign);
    expect(tree.ok && tree.data, "direct evidence must PASS, or this proves nothing")
      .toContain(ISSUE_PATH);

    const committed = await stage.report(
      new StageContext(root, dir, legacyPoisoned(foreign), makeRecipe()),
      { completedAction: "commit_done", commitHash: foreign },
    );
    expect(text(committed)).toContain("No new commit detected");
    expect(text(committed), "no stranded-commit diagnosis may be offered for this shape")
      .not.toContain("predates the ISS-922 fix");
  });

  it("offers no diagnosis for a commit that arrived by FOREIGN DRIFT, which moved mergeBase with it", async () => {
    // The drift writer (guide.ts) sets expectedHead AND mergeBase to the
    // drifted commit. Such a commit can descend from initHead and can modify
    // this very issue's file -- both evidence checks pass -- yet it is not this
    // session's work. mergeBase sitting on the candidate is the signature.
    const drifted = landWorkCommit(root);
    const state = legacyPoisoned(drifted);
    const drifShape = { ...state, git: { ...state.git, mergeBase: drifted } } as FullSessionState;

    const committed = await stage.report(
      new StageContext(root, dir, drifShape, makeRecipe()),
      { completedAction: "commit_done", commitHash: drifted },
    );
    expect(text(committed), "a drifted-in commit must not be recorded as this item's work")
      .toContain("No new commit detected");
    expect(text(committed), "no stranded-commit diagnosis may be offered for this shape")
      .not.toContain("predates the ISS-922 fix");
  });

  it("offers no diagnosis for a MERGE commit, whose artifact change the tree check cannot establish", async () => {
    // Isolates the direct tree-evidence condition. Measured on real git:
    // `rev-list --ancestry-path` ADDS commits rather than excluding merged-in
    // side branches (ISS-923), so a merge commit IS listed for the artifact's
    // range. The merge does introduce the artifact change relative to its first
    // parent, but `gitDiffTreeNames` runs diff-tree without -m/-c, which reports
    // nothing for a merge. So no direct evidence is available and the diagnosis
    // must be withheld rather than lean on range membership alone.
    const base = head(root);
    git(root, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(root, ISSUE_PATH), JSON.stringify({ id: ISSUE_ID, status: "resolved" }));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "side touches the artifact"]);
    git(root, ["checkout", "-q", "-"]);
    writeFileSync(join(root, "mainline.txt"), "m\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "mainline"]);
    git(root, ["merge", "-q", "--no-ff", "side", "-m", "merge"]);
    const mergeCommit = head(root);
    expect(mergeCommit).not.toBe(base);

    const state = legacyPoisoned(mergeCommit);
    const committed = await stage.report(
      new StageContext(root, dir, state, makeRecipe()),
      { completedAction: "commit_done", commitHash: mergeCommit },
    );
    expect(text(committed)).toContain("No new commit detected");
    expect(text(committed), "no stranded-commit diagnosis may be offered for this shape")
      .not.toContain("predates the ISS-922 fix");
  });

  it("refuses when the candidate IS the session baseline, adding no git work", async () => {
    const state = legacyPoisoned(initHead);
    const committed = await stage.report(
      new StageContext(root, dir, state, makeRecipe()),
      { completedAction: "commit_done", commitHash: initHead },
    );
    expect(text(committed)).toContain("No new commit detected");
  });
});
