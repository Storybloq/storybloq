/**
 * T-486 U1-4: the resolution-metadata write boundary and the kind setter.
 *
 * Every fixture is a real team project in a fresh git repository, made ready
 * by the current `team setup` and then broken in exactly one way: the fence
 * lowered, or the v5 registration removed. Kinds an old writer left behind
 * are written raw, as an old writer would.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import {
  authoriseIssueBytes,
  prepareIssueWrite,
  prepareIssueWriteSeams,
  resolutionWriteContextFor,
  runTransactionUnlocked,
  withProjectLock,
  writeConfigUnlocked,
  writeIssue,
} from "../../src/core/project-loader.js";
import {
  MERGE_DRIVER_CONTRACTS,
  MERGE_DRIVER_V5_CMD,
  MERGE_DRIVER_V5_NAME,
  lastConfigRecord,
  registeredMergeDriverRecord,
  registrationOverrides,
  teamSetup,
  type GitRead,
  gitRead,
} from "../../src/core/team-setup.js";
import {
  ResolutionWriteContextError,
  assertResolutionMetadataWrite,
  createResolutionWriteContext,
  type ResolutionWriteContext,
} from "../../src/core/resolution-write-guard.js";
import { resolutionDigest } from "../../src/core/resolution-kind.js";
import { handleIssueCreate, handleIssueUpdate } from "../../src/cli/commands/issue.js";
import { handleResolve } from "../../src/cli/commands/conflicts.js";
import { restoreRecord, RestoreUnsafe } from "../../src/core/ledger-restore.js";
import { capabilityCatalog } from "../../src/cli/commands/capability.js";
import type { Issue } from "../../src/models/issue.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
let globalConfig: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u14-home-"));
  globalConfig = join(scratchHome, "gitconfig");
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "STORYBLOQ_VERSION"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.STORYBLOQ_VERSION = "1.16.0";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(globalConfig, { force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

// T-486 A9: "legacy-clone" selects v4 in this clone (doctor row M4), "unset-merge" puts `-merge` on issues (row M6).
type Board = "ready" | "low-fence" | "unregistered" | "legacy-clone" | "unset-merge" | "non-team";

/** A project at `root` (also the git root), set up by the current handlers and then broken one way. */
async function board(kind: Board): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u14-"));
  dirs.push(root);
  git(root, "init", "-q");
  await initProject(root, { name: "t486" });
  if (kind === "non-team") return root;
  const path = join(root, ".story", "config.json");
  const config = JSON.parse(readFileSync(path, "utf-8"));
  config.team = { enabled: true };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  await teamSetup(root);
  if (kind === "low-fence") {
    const c = JSON.parse(readFileSync(path, "utf-8"));
    c.team.minCliVersion = "1.15.0";
    writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
  } else if (kind === "unregistered") {
    git(root, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
  } else if (kind === "legacy-clone") {
    const info = join(root, git(root, "rev-parse", "--git-path", "info/attributes"));
    writeFileSync(info, readFileSync(info, "utf-8").replaceAll(`merge=${MERGE_DRIVER_V5_NAME}`, "merge=storybloq-json-v4"));
  } else if (kind === "unset-merge") {
    const info = join(root, git(root, "rev-parse", "--git-path", "info/attributes"));
    writeFileSync(info, readFileSync(info, "utf-8") + ".story/issues/*.json -merge\n");
  }
  return root;
}

async function createIssue(root: string, title = "a bug"): Promise<Issue> {
  const r = await handleIssueCreate(
    { title, severity: "medium", impact: "it breaks", components: [], relatedTickets: [], location: [] },
    "json",
    root,
  );
  return JSON.parse(r.output).data as Issue;
}

const issuePath = (root: string, id: string) => join(root, ".story", "issues", `${id}.json`);
const readIssue = (root: string, id: string) => JSON.parse(readFileSync(issuePath(root, id), "utf-8")) as Record<string, unknown>;
const writeRaw = (root: string, id: string, record: Record<string, unknown>) =>
  writeFileSync(issuePath(root, id), JSON.stringify(record, null, 2) + "\n");
const bytes = (root: string, id: string) => readFileSync(issuePath(root, id), "utf-8");

function boundKind(kind: string, closedOn: string, resolution: string) {
  return { kind, closedOn, resolutionDigest: resolutionDigest(resolution) };
}

async function rejection(run: Promise<unknown>): Promise<Error> {
  const err = await run.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

/** An open issue still carrying the kind an old writer bound to a closure it later reopened. */
async function reopenedWithOldKind(root: string): Promise<{ id: string; closed: Record<string, unknown> }> {
  const issue = await createIssue(root);
  const closed: Record<string, unknown> = { ...readIssue(root, issue.id), status: "resolved", resolvedDate: "2026-09-01", resolution: "fixed it" };
  closed.resolutionKind = boundKind("fixed", "2026-09-01", "fixed it");
  writeRaw(root, issue.id, { ...closed, status: "open", resolvedDate: null });
  return { id: issue.id, closed };
}

describe("kind setter (F1, F2, S1, S2)", () => {
  it("a ready board writes the bound kind from the post-update issue", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    await handleIssueUpdate(issue.id, { status: "resolved", resolution: "patched", resolutionKind: "fixed" }, "json", root);
    const stored = readIssue(root, issue.id);
    expect(stored.resolutionKind).toEqual(boundKind("fixed", stored.resolvedDate as string, "patched"));
  });

  it("a non-team board needs no fence", async () => {
    const root = await board("non-team");
    const issue = await createIssue(root);
    await handleIssueUpdate(issue.id, { status: "resolved", resolution: "patched", resolutionKind: "wontfix" }, "json", root);
    expect((readIssue(root, issue.id).resolutionKind as { kind: string }).kind).toBe("wontfix");
  });

  it.each([
    ["F1", "low-fence" as const, /team\.minCliVersion is 1\.15\.0, below 1\.16\.0/],
    ["F2", "unregistered" as const, /storybloq-json-v5 merge driver is not registered/],
    ["A9 M4", "legacy-clone" as const, /with storybloq-json-v4, not storybloq-json-v5/],
    ["A9 M6", "unset-merge" as const, /with no driver, not storybloq-json-v5/],
  ])("%s: a %s board refuses the kind, names storybloq team setup and writes nothing", async (_id, kind, gap) => {
    const root = await board(kind);
    const issue = await createIssue(root);
    const before = bytes(root, issue.id);
    const err = await rejection(handleIssueUpdate(issue.id, { status: "resolved", resolution: "patched", resolutionKind: "fixed" }, "json", root));
    expect(err.message).toMatch(gap);
    expect(err.message).toMatch(/storybloq team setup/);
    expect(bytes(root, issue.id)).toBe(before);
  });

  it("S1: a kind on an issue that is not resolved after the update is refused", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    const err = await rejection(handleIssueUpdate(issue.id, { resolution: "patched", resolutionKind: "fixed" }, "json", root));
    expect(err.message).toMatch(/needs a resolved issue; this one is open/);
  });

  it("a kind with no resolution text is refused", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    const err = await rejection(handleIssueUpdate(issue.id, { status: "resolved", resolutionKind: "fixed" }, "json", root));
    expect(err.message).toMatch(/needs a resolution/);
  });

  it("S2: duplicate without --duplicate-of is refused; with a resolving target it is written with the canonical id", async () => {
    const root = await board("ready");
    const original = await createIssue(root, "original");
    const copy = await createIssue(root, "copy");
    const err = await rejection(handleIssueUpdate(copy.id, { status: "resolved", resolution: "same", resolutionKind: "duplicate" }, "json", root));
    expect(err.message).toMatch(/duplicate needs --duplicate-of/);
    await handleIssueUpdate(copy.id, { status: "resolved", resolution: "same", resolutionKind: "duplicate", duplicateOf: original.displayId! }, "json", root);
    const stored = readIssue(root, copy.id);
    expect(stored.duplicateOf).toBe(original.id);
    expect((stored.resolutionKind as { kind: string }).kind).toBe("duplicate");
  });

  it.each([
    ["missing", "ISS-999", /names no ticket or issue/],
    ["self", "self", /cannot name the issue itself/],
  ])("--duplicate-of refuses a %s target", async (_n, ref, message) => {
    const root = await board("ready");
    const issue = await createIssue(root);
    const err = await rejection(handleIssueUpdate(issue.id, { duplicateOf: ref === "self" ? issue.id : ref }, "json", root));
    expect(err.message).toMatch(message);
  });

  it("reopening deletes the kind; re-resolving without a kind does not bring it back", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    await handleIssueUpdate(issue.id, { status: "resolved", resolution: "patched", resolutionKind: "fixed" }, "json", root);
    await handleIssueUpdate(issue.id, { status: "open" }, "json", root);
    expect("resolutionKind" in readIssue(root, issue.id)).toBe(false);
    await handleIssueUpdate(issue.id, { status: "resolved" }, "json", root);
    expect("resolutionKind" in readIssue(root, issue.id)).toBe(false);
  });

  it("changing the resolution text without a kind deletes the kind", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    await handleIssueUpdate(issue.id, { status: "resolved", resolution: "patched", resolutionKind: "fixed" }, "json", root);
    await handleIssueUpdate(issue.id, { resolution: "patched differently" }, "json", root);
    expect("resolutionKind" in readIssue(root, issue.id)).toBe(false);
  });
});

describe("the boundary keeps what it does not change (B3, B4, B6, W1, W2, W4)", () => {
  it("B3: an unrelated update on a low-fence board keeps a raw kind byte for byte", async () => {
    const root = await board("low-fence");
    const issue = await createIssue(root);
    const raw = { ...readIssue(root, issue.id), status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") };
    writeRaw(root, issue.id, raw);
    await handleIssueUpdate(issue.id, { title: "renamed" }, "json", root);
    expect(readIssue(root, issue.id).resolutionKind).toEqual(raw.resolutionKind);
  });

  it("B3: an unrelated update keeps a malformed kind (preserving is never refused)", async () => {
    const root = await board("low-fence");
    const issue = await createIssue(root);
    writeRaw(root, issue.id, { ...readIssue(root, issue.id), resolutionKind: "garbage" });
    await handleIssueUpdate(issue.id, { title: "renamed" }, "json", root);
    expect(readIssue(root, issue.id).resolutionKind).toBe("garbage");
  });

  it("B4: reopening on a low-fence board succeeds and deletes the kind", async () => {
    const root = await board("low-fence");
    const issue = await createIssue(root);
    writeRaw(root, issue.id, { ...readIssue(root, issue.id), status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") });
    await handleIssueUpdate(issue.id, { status: "open" }, "json", root);
    expect("resolutionKind" in readIssue(root, issue.id)).toBe(false);
  });

  it("B6: evidence written for a different disposition is refused at the boundary", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    const next = { ...readIssue(root, issue.id), disposition: "owner_gated", dispositionReason: "why", dispositionRef: issue.id, dispositionFor: "accepted_out_of_scope" };
    const err = await rejection(writeIssue(next as Issue, root));
    expect(err.message).toMatch(/dispositionFor accepted_out_of_scope is not the disposition owner_gated/);
  });

  it.each([
    ["W1 (stale date)", { closedOn: "2026-08-01" }, /closedOn 2026-08-01 is not resolvedDate 2026-09-01/],
    ["W2 (stale digest)", { resolutionDigest: "0000000000000000" }, /resolutionDigest does not match/],
  ])("%s: a newly written kind that does not bind is refused even on a ready board", async (_n, override, message) => {
    const root = await board("ready");
    const issue = await createIssue(root);
    const next = {
      ...readIssue(root, issue.id), status: "resolved", resolvedDate: "2026-09-01", resolution: "r",
      resolutionKind: { ...boundKind("fixed", "2026-09-01", "r"), ...override },
    };
    const err = await rejection(writeIssue(next as Issue, root));
    expect(err.message).toMatch(message);
  });

  it("a newly inserted malformed kind is refused", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    const err = await rejection(writeIssue({ ...readIssue(root, issue.id), resolutionKind: { kind: "fixed" } } as Issue, root));
    expect(err.message).toMatch(/resolutionKind must be/);
  });

  it("W4: an old writer's same-day reopen and re-resolve with unchanged text leaves the kind effective (residual, pinned)", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    await handleIssueUpdate(issue.id, { status: "resolved", resolution: "patched", resolutionKind: "fixed" }, "json", root);
    const kept = readIssue(root, issue.id);
    writeRaw(root, issue.id, { ...kept, status: "open", resolvedDate: null });
    writeRaw(root, issue.id, kept);
    const out = JSON.parse((await handleIssueUpdate(issue.id, { title: "t" }, "json", root)).output).data;
    expect(out.effective.resolutionKind).toBe("fixed");
  });
});

describe("activation is a write (A3: B7 restore, B8 conflict resolution)", () => {
  async function restoreFixture(kind: Board) {
    const root = await board(kind);
    const { id, closed } = await reopenedWithOldKind(root);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "reopened");
    const expectOid = git(root, "rev-parse", "HEAD");
    const reopened = bytes(root, id);
    writeRaw(root, id, closed);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "closed");
    const fromOid = git(root, "rev-parse", "HEAD");
    writeFileSync(issuePath(root, id), reopened);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "reopened again");
    return { root, id, fromOid, expectOid, reopened };
  }

  it.each(["low-fence", "unregistered", "legacy-clone", "unset-merge"] as const)("B7: on a %s board, restoring the matching closure under an unchanged raw kind is refused", async (kind) => {
    const { root, id, fromOid, expectOid, reopened } = await restoreFixture(kind);
    const err = await restoreRecord(root, { kind: "record", path: `.story/issues/${id}.json` }, fromOid, expectOid, { capabilityCatalog }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreUnsafe);
    expect((err as RestoreUnsafe).invariant).toBe("resolution-metadata");
    expect(bytes(root, id)).toBe(reopened);
  });

  it("B7: on a ready board the same restore succeeds", async () => {
    const { root, id, fromOid, expectOid } = await restoreFixture("ready");
    const r = await restoreRecord(root, { kind: "record", path: `.story/issues/${id}.json` }, fromOid, expectOid, { capabilityCatalog });
    expect(r.outcome).toBe("restored");
    expect(readIssue(root, id).status).toBe("resolved");
  });

  it("B7 (Codex F2): a restore checked on a ready board is refused when the fence drops before its write", async () => {
    const { root, id, fromOid, expectOid, reopened } = await restoreFixture("ready");
    const lowerFence = async () => {
      const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
      await writeConfigUnlocked({ ...config, team: { ...config.team, minCliVersion: "1.15.0" } }, root);
    };
    const err = await rejection(restoreRecord(root, { kind: "record", path: `.story/issues/${id}.json` }, fromOid, expectOid, { capabilityCatalog, beforeWrite: lowerFence }));
    expect(err.message).toMatch(/prepare it again/);
    expect(bytes(root, id)).toBe(reopened);
  });

  async function conflictFixture(kind: Board) {
    const root = await board(kind);
    const { id, closed } = await reopenedWithOldKind(root);
    const body = readIssue(root, id);
    const side = (rec: Record<string, unknown>) => ["status", "resolvedDate", "lifecycle", "resolutionKind"].map((m) => [m, rec[m]] as const);
    const ours = Object.fromEntries(side(body));
    const theirs = Object.fromEntries(side(closed));
    body._conflicts = Object.keys(ours).map((m) => ({
      fieldPath: `/${m}`, field: m, kind: "coupled", group: "issue-status", base: ours[m], ours: ours[m], theirs: theirs[m],
    }));
    writeRaw(root, id, body);
    return { root, id, before: bytes(root, id) };
  }

  it.each(["low-fence", "unregistered", "legacy-clone", "unset-merge"] as const)("B8: on a %s board, resolve --use theirs to the matching closure is refused", async (kind) => {
    const { root, id, before } = await conflictFixture(kind);
    const err = await rejection(handleResolve(id, root, { field: "status", use: "theirs", format: "json" }));
    expect(err.message).toMatch(/storybloq team setup/);
    expect(bytes(root, id)).toBe(before);
  });

  it("B8: on a ready board the same resolution succeeds and the kind is effective", async () => {
    const { root, id } = await conflictFixture("ready");
    await handleResolve(id, root, { field: "status", use: "theirs", format: "json" });
    const out = JSON.parse((await handleIssueUpdate(id, { title: "t" }, "json", root)).output).data;
    expect(out.effective.resolutionKind).toBe("fixed");
  });

  it("B1: conflict resolution writing a new kind on a low-fence board is refused", async () => {
    const root = await board("low-fence");
    const issue = await createIssue(root);
    const body: Record<string, unknown> = { ...readIssue(root, issue.id), status: "resolved", resolvedDate: "2026-09-01", resolution: "r" };
    body._conflicts = [{ fieldPath: "/resolutionKind", field: "resolutionKind", kind: "coupled", group: "issue-status", base: undefined, ours: undefined, theirs: boundKind("fixed", "2026-09-01", "r") }];
    writeRaw(root, issue.id, body);
    const before = bytes(root, issue.id);
    await rejection(handleResolve(issue.id, root, { field: "resolutionKind", use: "theirs", format: "json" }));
    expect(bytes(root, issue.id)).toBe(before);
  });
});

describe("recovery and the write context (B5, C1-C3, X1, X2)", () => {
  it("B5: forward recovery applies a journaled kind write after the fence was lowered", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    const next = { ...readIssue(root, issue.id), status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") };
    let prepared!: { target: string; content: string };
    await withProjectLock(root, { strict: true }, async () => { prepared = await prepareIssueWrite(next as Issue, root); });
    const { target, content } = prepared;
    const configPath = join(root, ".story", "config.json");
    const c = JSON.parse(readFileSync(configPath, "utf-8"));
    c.team.minCliVersion = "1.15.0";
    writeFileSync(configPath, JSON.stringify(c, null, 2) + "\n");
    const tempPath = `${target}.recover.tmp`;
    writeFileSync(tempPath, content);
    writeFileSync(join(root, ".story", ".txn.json"), JSON.stringify({ entries: [{ op: "write", target, tempPath }], commitStarted: true }));
    await withProjectLock(root, { strict: false }, async () => {});
    expect(bytes(root, issue.id)).toBe(content);
  });

  it("C1: a kind write under withProjectLock completes with the guard active (no lock re-entry)", async () => {
    const root = await board("ready");
    const issue = await createIssue(root);
    const next = { ...readIssue(root, issue.id), status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") };
    let wrote = false;
    await withProjectLock(root, { strict: true }, async () => {
      const { target, content } = await prepareIssueWrite(next as Issue, root);
      await runTransactionUnlocked(root, [{ op: "write", target, content }]);
      wrote = true;
    });
    expect(wrote).toBe(true);
  });

  it("C3: the exported writeIssue (withLock, no loaded config) still refuses on a low-fence board", async () => {
    const root = await board("low-fence");
    const issue = await createIssue(root);
    const next = { ...readIssue(root, issue.id), status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") };
    const err = await rejection(writeIssue(next as Issue, root));
    expect(err.message).toMatch(/below 1\.16\.0/);
  });

  it("C2: a 50-item prepared batch reads the driver command once and each path's attribute once", async () => {
    const root = await board("ready");
    // One issue through the handler, 49 written beside it as raw copies: the
    // assertions count git reads during the batch, and 50 handler creates
    // (each loading the growing project) put this near the 5 s timeout.
    const template = readIssue(root, (await createIssue(root, "bug 0")).id);
    const issues: Record<string, unknown>[] = [template];
    for (let i = 1; i < 50; i++) {
      const id = `i-${String(i).padStart(16, "0")}`;
      const record = { ...template, id, displayId: `ISS-${100 + i}`, title: `bug ${i}` };
      writeRaw(root, id, record);
      issues.push(record);
    }
    const calls: string[] = [];
    const counting: GitRead = (args, cwd) => {
      calls.push(args[0] === "config" ? "config" : `attr:${args.at(-1)}`);
      return gitRead(args, cwd);
    };
    const ops: Array<{ target: string; content: string }> = [];
    await withProjectLock(root, { strict: true }, async () => {
      const ctx = resolutionWriteContextFor(root).withGit(counting);
      for (const issue of issues) {
        const next = { ...issue, status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") };
        ops.push(await prepareIssueWrite(next as Issue, root, { resolutionContext: ctx }));
      }
      await runTransactionUnlocked(root, ops.map((o) => ({ op: "write" as const, ...o })));
    });
    expect(calls.filter((c) => c === "config")).toHaveLength(1);
    const attrs = calls.filter((c) => c.startsWith("attr:"));
    expect(attrs).toHaveLength(50);
    expect(new Set(attrs).size).toBe(50);
  });

  it("C2: a second write of the same path in one context reads nothing new", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const calls: string[][] = [];
    const next = { ...issue, status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") };
    await withProjectLock(root, { strict: true }, async () => {
      const ctx = resolutionWriteContextFor(root).withGit((a, c) => (calls.push([...a]), gitRead(a, c)));
      await prepareIssueWrite(next as Issue, root, { resolutionContext: ctx });
      const after = calls.length;
      expect(after).toBeGreaterThan(0);
      await prepareIssueWrite({ ...next, title: "again" } as Issue, root, { resolutionContext: ctx });
      expect(calls.length).toBe(after);
    });
  });

  it.each([
    ["X1 (legacy display-id filename)", "ISS-001"],
    ["X2 (hash filename)", "i-0000000000000001"],
  ])("%s: a transaction naming the same issue twice is refused with no write and no journal", async (_n, id) => {
    const root = await board("non-team");
    const created = await createIssue(root);
    const record = { ...readIssue(root, created.id), id, displayId: "ISS-001" };
    rmSync(issuePath(root, created.id));
    writeRaw(root, id, record);
    const before = bytes(root, id);
    const target = issuePath(root, id);
    await withProjectLock(root, { strict: false }, async () => {
      const err = await rejection(runTransactionUnlocked(root, [
        { op: "write", target, content: before.replace("a bug", "one") },
        { op: "write", target: join(root, ".story", "issues", ".", `${id}.json`), content: before.replace("a bug", "two") },
      ]));
      expect(err.message).toMatch(/more than once/);
    });
    expect(bytes(root, id)).toBe(before);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
  });
});

describe("the write context is the lock's own (B6: C4-C7)", () => {
  const kindWrite = (root: string, issue: Record<string, unknown>) =>
    ({ ...issue, status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") }) as unknown as Issue;

  it("C4: two projects locked concurrently each decide on their own config", async () => {
    const ready = await board("ready");
    const low = await board("low-fence");
    const a = readIssue(ready, (await createIssue(ready)).id);
    const b = readIssue(low, (await createIssue(low)).id);
    let gate!: () => void;
    const both = new Promise<void>((r) => (gate = r));
    let entered = 0;
    const run = (root: string, issue: Record<string, unknown>) =>
      withProjectLock(root, { strict: true }, async () => {
        if (++entered === 2) gate();
        await both;
        await prepareIssueWrite(kindWrite(root, issue), root);
      });
    const [ra, rb] = await Promise.allSettled([run(ready, a), run(low, b)]);
    expect(ra.status).toBe("fulfilled");
    expect(rb.status).toBe("rejected");
    expect(String((rb as PromiseRejectedResult).reason.message)).toMatch(/below 1\.16\.0/);
  });

  it("C5: a context kept past its lock refuses, and so does detached work started under the lock", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    let kept!: ResolutionWriteContext;
    let detached!: Promise<unknown>;
    let release!: () => void;
    const later = new Promise<void>((r) => (release = r));
    await withProjectLock(root, { strict: true }, async () => {
      kept = resolutionWriteContextFor(root);
      detached = later.then(() => prepareIssueWrite(kindWrite(root, issue), root));
    });
    expect(kept.released).toBe(true);
    await expect(prepareIssueWrite(kindWrite(root, issue), root, { resolutionContext: kept })).rejects.toBeInstanceOf(ResolutionWriteContextError);
    release();
    await expect(detached).rejects.toBeInstanceOf(ResolutionWriteContextError);
  });

  it("C6: with no lock held, a write is refused with the typed error before anything is read or loaded", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    rmSync(join(root, ".story", "config.json"));
    const err = await rejection(prepareIssueWrite({ ...issue, title: "unrelated" } as unknown as Issue, root));
    expect(err).toBeInstanceOf(ResolutionWriteContextError);
    expect(err.message).toMatch(/no project lock is held/);
  });

  it("C7: a context for another project is refused, and under nested locks each root decides on its own lock", async () => {
    const one = await board("low-fence");
    const two = await board("ready");
    const outer = readIssue(one, (await createIssue(one)).id);
    const issue = readIssue(two, (await createIssue(two)).id);
    await withProjectLock(one, { strict: true }, async () => {
      const foreign = resolutionWriteContextFor(one);
      await withProjectLock(two, { strict: true }, async () => {
        const err = await rejection(prepareIssueWrite(kindWrite(two, issue), two, { resolutionContext: foreign }));
        expect(err).toBeInstanceOf(ResolutionWriteContextError);
        expect(err.message).toMatch(/is for .*, not /);
        await prepareIssueWrite(kindWrite(two, issue), two);
        const outerErr = await rejection(prepareIssueWrite(kindWrite(one, outer), one));
        expect(outerErr).not.toBeInstanceOf(ResolutionWriteContextError);
        expect(outerErr.message).toMatch(/below 1\.16\.0/);
      });
    });
  });

  it("a config write inside the operation invalidates the fence decision", async () => {
    const root = await board("low-fence");
    const issue = readIssue(root, (await createIssue(root)).id);
    const { writeConfigUnlocked } = await import("../../src/core/project-loader.js");
    await withProjectLock(root, { strict: true }, async ({ state }) => {
      expect(resolutionWriteContextFor(root).config()).toBe(state.config);
      await rejection(prepareIssueWrite(kindWrite(root, issue), root));
      await writeConfigUnlocked({ ...state.config, team: { ...state.config.team, minCliVersion: "1.16.0" } }, root);
      expect(resolutionWriteContextFor(root).config()).not.toBe(state.config);
      await prepareIssueWrite(kindWrite(root, issue), root);
    });
  });

  it("C6c: writeIssueUnlocked with no lock is refused with the typed error and writes nothing, for an ordinary edit", async () => {
    const root = await board("non-team");
    const issue = readIssue(root, (await createIssue(root)).id);
    const before = bytes(root, issue.id as string);
    const { writeIssueUnlocked } = await import("../../src/core/project-loader.js");
    const err = await rejection(writeIssueUnlocked({ ...issue, title: "no lock" } as unknown as Issue, root));
    expect(err).toBeInstanceOf(ResolutionWriteContextError);
    expect(bytes(root, issue.id as string)).toBe(before);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
  });

  it("C6b: an injected context made outside the lock is refused while the lock is held", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const injected = createResolutionWriteContext(root);
    await withProjectLock(root, { strict: true }, async () => {
      const err = await rejection(prepareIssueWrite(kindWrite(root, issue), root, { resolutionContext: injected }));
      expect(err).toBeInstanceOf(ResolutionWriteContextError);
      expect(err.message).toMatch(/not held by this operation/);
    });
  });
});

describe("the U1-3 integration killers, gated kind-write stage (C2 of round 5)", () => {
  it("R6: after setup migrates a pre-U1 clone, a gated kind write succeeds", async () => {
    const root = await board("ready");
    const info = join(root, git(root, "rev-parse", "--git-path", "info/attributes"));
    writeFileSync(info, readFileSync(info, "utf-8").replaceAll(`merge=${MERGE_DRIVER_V5_NAME}`, "merge=storybloq-json-v4"));
    git(root, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    const issue = await createIssue(root);
    await rejection(handleIssueUpdate(issue.id, { status: "resolved", resolution: "r", resolutionKind: "fixed" }, "json", root));
    await teamSetup(root);
    await handleIssueUpdate(issue.id, { status: "resolved", resolution: "r", resolutionKind: "fixed" }, "json", root);
    expect((readIssue(root, issue.id).resolutionKind as { kind: string }).kind).toBe("fixed");
  });

  it("R7: a quoted-path registration refuses the kind write with the setup message; after setup it succeeds", async () => {
    const root = await board("ready");
    git(root, "config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.driver`, `"/usr/local/bin/storybloq" merge-driver --protocol 5 %O %A %B %P`);
    const issue = await createIssue(root);
    const err = await rejection(handleIssueUpdate(issue.id, { status: "resolved", resolution: "r", resolutionKind: "fixed" }, "json", root));
    expect(err.message).toContain("unsupported merge driver registration");
    expect(err.message).toContain("storybloq team setup");
    await teamSetup(root);
    await handleIssueUpdate(issue.id, { status: "resolved", resolution: "r", resolutionKind: "fixed" }, "json", root);
    expect((readIssue(root, issue.id).resolutionKind as { kind: string }).kind).toBe("fixed");
  });
});


describe("the U1-4 Codex round (F1 to F3)", () => {
  const kindWrite = (root: string, issue: Record<string, unknown>) =>
    ({ ...issue, status: "resolved", resolvedDate: "2026-09-01", resolution: "r", resolutionKind: boundKind("fixed", "2026-09-01", "r") }) as unknown as Issue;

  it("F1: a context released while the replaced record is read is refused, held or supplied", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const before = bytes(root, issue.id as string);
    const read = prepareIssueWriteSeams.readPrior;
    try {
      for (const supplied of [false, true]) {
        await withProjectLock(root, { strict: true }, async () => {
          const ctx = resolutionWriteContextFor(root);
          prepareIssueWriteSeams.readPrior = async (path) => {
            ctx.release();
            return read(path);
          };
          const err = await rejection(prepareIssueWrite(kindWrite(root, issue), root, supplied ? { resolutionContext: ctx } : undefined));
          expect(err, `supplied=${supplied}`).toBeInstanceOf(ResolutionWriteContextError);
          prepareIssueWriteSeams.readPrior = read;
        });
      }
    } finally {
      prepareIssueWriteSeams.readPrior = read;
    }
    expect(bytes(root, issue.id as string)).toBe(before);
  });

  it("F1: the guard itself refuses a released context, even for a write with no resolution metadata", async () => {
    const root = await board("non-team");
    const ctx = createResolutionWriteContext(root);
    ctx.release();
    expect(() => assertResolutionMetadataWrite(ctx, ".story/issues/ISS-001.json", {}, { id: "ISS-001", title: "plain" })).toThrow(ResolutionWriteContextError);
    expect(() => assertResolutionMetadataWrite(ctx, ".story/issues/ISS-001.json", {}, { id: "ISS-001", title: "plain" })).toThrow(/lock that was released/);
  });

  it("F1: a context whose lock no longer owns .story/.lock is refused", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const lock = join(root, ".story", ".lock");
    await withProjectLock(root, { strict: true }, async () => {
      const held = readFileSync(lock, "utf-8");
      writeFileSync(lock, JSON.stringify({ ...JSON.parse(held), token: "another-holder" }));
      try {
        const err = await rejection(prepareIssueWrite(kindWrite(root, issue), root));
        expect(err).toBeInstanceOf(ResolutionWriteContextError);
        expect(err.message).toMatch(/no longer owns \.story\/\.lock/);
      } finally {
        writeFileSync(lock, held);
      }
    });
  });

  it("F2: a kind write prepared before the fence drops in the same operation is refused at commit, and nothing is written", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const before = bytes(root, issue.id as string);
    await withProjectLock(root, { strict: true }, async ({ state }) => {
      const prepared = await prepareIssueWrite(kindWrite(root, issue), root);
      await writeConfigUnlocked({ ...state.config, team: { ...state.config.team, enabled: true, minCliVersion: "1.15.0" } }, root);
      const err = await rejection(runTransactionUnlocked(root, [{ op: "write", ...prepared }]));
      expect(err.message).toMatch(/state that changed before it was committed; prepare it again/);
    });
    expect(bytes(root, issue.id as string)).toBe(before);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
  });

  it("F2: a write whose check did not read the board still commits after a config write", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    await withProjectLock(root, { strict: true }, async ({ state }) => {
      const prepared = await prepareIssueWrite({ ...issue, title: "retitled" } as unknown as Issue, root);
      await writeConfigUnlocked({ ...state.config, team: { ...state.config.team, enabled: true, minCliVersion: "1.15.0" } }, root);
      await runTransactionUnlocked(root, [{ op: "write", ...prepared }]);
    });
    expect(readIssue(root, issue.id as string).title).toBe("retitled");
  });

  it("F2 (fixup 2): preparing the same issue again after the fence drops leaves the first bytes refused, nothing written", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const before = bytes(root, issue.id as string);
    await withProjectLock(root, { strict: true }, async ({ state }) => {
      const prepared = await prepareIssueWrite(kindWrite(root, issue), root);
      await writeConfigUnlocked({ ...state.config, team: { ...state.config.team, enabled: true, minCliVersion: "1.15.0" } }, root);
      await prepareIssueWrite({ ...issue, title: "an ordinary edit" } as unknown as Issue, root);
      const err = await rejection(runTransactionUnlocked(root, [{ op: "write", ...prepared }]));
      expect(err.message).toMatch(/not the bytes that were prepared for it; prepare it again/);
    });
    expect(bytes(root, issue.id as string)).toBe(before);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
  });

  it("F2 (fixup 2): bytes prepared under one lock are refused under the next, nothing written", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const before = bytes(root, issue.id as string);
    let prepared: { target: string; content: string } | undefined;
    await withProjectLock(root, { strict: true }, async () => {
      prepared = await prepareIssueWrite(kindWrite(root, issue), root);
    });
    await withProjectLock(root, { strict: true }, async () => {
      const err = await rejection(runTransactionUnlocked(root, [{ op: "write", ...prepared! }]));
      expect(err.message).toMatch(/nothing prepared it under this lock/);
    });
    expect(bytes(root, issue.id as string)).toBe(before);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
  });

  it("F2 (fixup 2): issue bytes nobody prepared are refused, nothing written", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const before = bytes(root, issue.id as string);
    await withProjectLock(root, { strict: true }, async () => {
      const err = await rejection(runTransactionUnlocked(root, [{ op: "write", target: issuePath(root, issue.id as string), content: before.replace("a bug", "unprepared") }]));
      expect(err.message).toMatch(/nothing prepared it under this lock/);
    });
    expect(bytes(root, issue.id as string)).toBe(before);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
  });

  it("H1 (fixup 3): an ordinary edit committed from detached work after its lock is released is refused, nothing written", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const before = bytes(root, issue.id as string);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let detached!: Promise<Error>;
    await withProjectLock(root, { strict: true }, async () => {
      const prepared = await prepareIssueWrite({ ...issue, title: "detached" } as unknown as Issue, root);
      detached = gate.then(() => rejection(runTransactionUnlocked(root, [{ op: "write", ...prepared }])));
    });
    release();
    expect((await detached).message).toMatch(/was released or no longer owns \.story\/\.lock; prepare it again/);
    expect(bytes(root, issue.id as string)).toBe(before);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
  });

  it("H1 (fixup 3): an ordinary edit committed after the lock was replaced is refused, nothing written", async () => {
    const root = await board("ready");
    const issue = readIssue(root, (await createIssue(root)).id);
    const before = bytes(root, issue.id as string);
    const lock = join(root, ".story", ".lock");
    await withProjectLock(root, { strict: true }, async () => {
      const prepared = await prepareIssueWrite({ ...issue, title: "after replacement" } as unknown as Issue, root);
      const held = readFileSync(lock, "utf-8");
      writeFileSync(lock, JSON.stringify({ ...JSON.parse(held), token: "another-holder" }));
      try {
        const err = await rejection(runTransactionUnlocked(root, [{ op: "write", ...prepared }]));
        expect(err.message).toMatch(/was released or no longer owns \.story\/\.lock; prepare it again/);
      } finally {
        writeFileSync(lock, held);
      }
    });
    expect(bytes(root, issue.id as string)).toBe(before);
    expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);
  });

  it("H2 (fixup 3): authoriseIssueBytes checks the bytes themselves, so kind-bearing content is refused on a low-fence board", async () => {
    const root = await board("low-fence");
    const issue = readIssue(root, (await createIssue(root)).id);
    const target = issuePath(root, issue.id as string);
    const before = bytes(root, issue.id as string);
    const kindBearing = JSON.stringify(kindWrite(root, issue), null, 2) + "\n";
    await withProjectLock(root, { strict: true }, async () => {
      expect(() => authoriseIssueBytes(root, target, issue, kindBearing)).toThrow(/below 1\.16\.0/);
      expect(() => authoriseIssueBytes(root, target, issue, "[1, 2]")).toThrow(/not a JSON object/);
      expect(() => authoriseIssueBytes(root, target, issue, "{ not json")).toThrow(/not a JSON object/);
      const err = await rejection(runTransactionUnlocked(root, [{ op: "write", target, content: kindBearing }]));
      expect(err.message).toMatch(/nothing prepared it under this lock/);
    });
    expect(bytes(root, issue.id as string)).toBe(before);
  });

  describe("F3: git config records", () => {
    const local = ["local", "file:.git/config"];

    it("bare output equal to the contract command is malformed, not a registration", () => {
      expect(lastConfigRecord(`${MERGE_DRIVER_V5_CMD}\n`)).toMatchObject({ kind: "malformed" });
      expect(lastConfigRecord(MERGE_DRIVER_V5_CMD)).toMatchObject({ kind: "malformed" });
    });

    it("a record without its final NUL, or an incomplete triple, is malformed", () => {
      expect(lastConfigRecord([...local, MERGE_DRIVER_V5_CMD].join("\0"))).toMatchObject({ kind: "malformed" });
      expect(lastConfigRecord([...local].join("\0") + "\0")).toMatchObject({ kind: "malformed" });
      expect(lastConfigRecord(["nowhere", "file:x", "v"].join("\0") + "\0")).toMatchObject({ kind: "malformed" });
      expect(lastConfigRecord(["local", "", "v"].join("\0") + "\0")).toMatchObject({ kind: "malformed" });
    });

    it("whole records parse, and the last one wins", () => {
      const out = ["global", "file:/home/.gitconfig", "a\nb", ...local, MERGE_DRIVER_V5_CMD].join("\0") + "\0";
      expect(lastConfigRecord(out)).toEqual({ kind: "ok", scope: "local", origin: "file:.git/config", value: MERGE_DRIVER_V5_CMD });
    });

    const bare: GitRead = (args) => {
      const key = args.at(-1)!;
      const name = key.slice("merge.".length, -".driver".length);
      return `${MERGE_DRIVER_CONTRACTS.get(name)!.command}\n`;
    };

    it("registrationOverrides reports malformed output as a git read failure for every driver", async () => {
      const root = await board("non-team");
      const problems = registrationOverrides(root, bare);
      expect(problems).toEqual(
        [...MERGE_DRIVER_CONTRACTS.keys()].map((name) => `git could not read merge.${name}.driver: the git config output does not end with a NUL`),
      );
    });

    it("the doctor's scope-carrying read reports malformed output as a git failure, never present", async () => {
      const root = await board("non-team");
      expect(registeredMergeDriverRecord(root, MERGE_DRIVER_V5_NAME, bare)).toEqual({
        kind: "git",
        detail: `unreadable git config record for merge.${MERGE_DRIVER_V5_NAME}.driver: the git config output does not end with a NUL`,
      });
    });
  });
});
