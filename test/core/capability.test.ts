import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync, unlinkSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  checkCapabilities,
  matchCapabilities,
  matchDisclosure,
  effectiveStatus,
  isPathWithin,
  isStampable,
  queryPathRefusal,
  CHECK_DEADLINE_MS,
  type GitCallOptions,
  type GitOutcome,
  type GitRunner,
} from "../../src/core/capability.js";
import { titleWords } from "../../src/core/catalog.js";
import { CapabilitySchema, EntryPointSchema, type Capability } from "../../src/models/capability.js";
import type { ProjectState } from "../../src/core/project-state.js";

/**
 * Every repo here is a STANDALONE clone in a temp directory, never a linked
 * worktree: a fixture's `git config` writes reach the shared `.git/config` of
 * a worktree's parent, which once left the production checkout bare (ISS-1220).
 */
const roots: string[] = [];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf-8" });
}

function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "capability-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function commit(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function capability(overrides: Record<string, unknown> = {}): Capability {
  return CapabilitySchema.parse({
    id: "cap-core",
    name: "Core",
    summary: "The core module does the core thing.",
    entryPoints: ["src/core"],
    contract: "It does the core thing and returns a result.",
    checkedAt: { sha: "0".repeat(40), date: "2026-09-20" },
    ...overrides,
  });
}

function codesFor(report: Awaited<ReturnType<typeof checkCapabilities>>, id: string): string[] {
  return report.entries.find((e) => e.id === id)!.results.map((r) => r.code);
}

function statusFor(report: Awaited<ReturnType<typeof checkCapabilities>>, id: string): string {
  return report.entries.find((e) => e.id === id)!.effectiveStatus;
}

/**
 * Real git, synchronously, with no timeout and no abort signal: the machine is
 * out of the measurement. `override` answers selected calls instead, which is
 * how a test reaches a git failure mode a real repository will not produce on
 * demand.
 */
function controlledGit(override?: (args: readonly string[]) => GitOutcome | null): { run: GitRunner; calls: number } {
  const state = {
    calls: 0,
    run: (async (root: string, args: readonly string[], _signal: AbortSignal, options?: GitCallOptions) => {
      state.calls += 1;
      const answered = override?.(args);
      if (answered) return answered;
      const env = options?.lazyFetch === false ? { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" } : GIT_ENV;
      try {
        return { ok: true, stdout: execFileSync("git", ["-C", root, ...args], { env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { status?: number | null; stdout?: string; stderr?: string };
        return { ok: typeof e.status === "number", stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: typeof e.status === "number" ? e.status : null };
      }
    }) as GitRunner,
  };
  return state;
}

describe("checkCapabilities: freshness", () => {
  it("an ancestor checkpoint with nothing changed underneath is current", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    write(root, "docs/readme.md", "unrelated");
    commit(root, "unrelated change outside the entry points");

    const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })]);
    expect(codesFor(report, "cap-core")).toEqual([]);
    expect(statusFor(report, "cap-core")).toBe("current");
  });

  it("a change under an entry point since the checkpoint is review, not wrong", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    write(root, "src/core/a.ts", "two");
    commit(root, "edit inside the entry point");

    const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_changed"]);
    expect(statusFor(report, "cap-core")).toBe("review");
  });

  it("a checkpoint that is not an ancestor of HEAD is unverifiable, never assumed fresh", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    commit(root, "base");
    git(root, ["checkout", "-q", "-b", "divergent"]);
    write(root, "src/core/a.ts", "sideways");
    const divergent = commit(root, "on the divergent branch");
    git(root, ["checkout", "-q", "main"]);

    const report = await checkCapabilities(root, [capability({ checkedAt: { sha: divergent, date: "2026-09-20" } })]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
    expect(statusFor(report, "cap-core")).toBe("review");
  });

  it("a checkpoint sha that is not a commit at all is unverifiable", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    commit(root, "base");

    const report = await checkCapabilities(root, [capability({ checkedAt: { sha: "d".repeat(40), date: "2026-09-20" } })]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
  });

  it("an abbreviated checkpoint sha resolves", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    write(root, "src/core/a.ts", "two");
    commit(root, "edit");

    const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base.slice(0, 8), date: "2026-09-20" } })]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_changed"]);
  });

  it("two entries on two different checkpoints are each judged against their own", async () => {
    const root = newRepo();
    write(root, "src/a/x.ts", "one");
    write(root, "src/b/y.ts", "one");
    const first = commit(root, "base");
    write(root, "src/a/x.ts", "two");
    const second = commit(root, "edit a only");

    const report = await checkCapabilities(root, [
      capability({ id: "cap-a", name: "A", entryPoints: ["src/a"], checkedAt: { sha: first, date: "2026-09-20" } }),
      capability({ id: "cap-b", name: "B", entryPoints: ["src/a"], checkedAt: { sha: second, date: "2026-09-20" } }),
    ]);
    expect(codesFor(report, "cap-a")).toEqual(["capability_changed"]);
    expect(codesFor(report, "cap-b")).toEqual([]);
  });

  it("sees a change only the MERGE commit introduced, which a per-commit log shows no diff for", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "base");
    const base = commit(root, "base");

    // An evil merge: neither branch touches the entry point, and the merge
    // commit introduces the change by itself. A per-commit log would report
    // the two side edits and never name a.ts, so this is the fixture that can
    // tell a tree diff apart from a walk over commits.
    git(root, ["checkout", "-q", "-b", "side"]);
    // OUTSIDE the watched entry point (`src/core`), so the only thing a walk
    // over commits could report under it is what the merge itself introduced.
    write(root, "docs/side-only.md", "side");
    commit(root, "side edit, not under the entry point");

    git(root, ["checkout", "-q", "main"]);
    write(root, "docs/main-only.md", "main");
    commit(root, "main edit, not under the entry point");

    git(root, ["merge", "--no-commit", "--no-ff", "side"]);
    write(root, "src/core/a.ts", "introduced by the merge alone");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "--no-gpg-sign", "-m", "merge, with an edit belonging to no parent"]);

    expect(git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/), "HEAD must be the merge commit").toHaveLength(3);
    const perCommit = git(root, ["log", "--no-merges", "--name-only", "--format=", `${base}..HEAD`]);
    expect(perCommit, "the fixture is only meaningful while no ordinary commit names the entry point").not.toContain("src/core/a.ts");

    const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_changed"]);
  });

  it("a rename away from the entry point is both changed and a missing path", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    renameSync(join(root, "src/core/a.ts"), join(root, "src/core/b.ts"));
    commit(root, "rename");

    const entry = capability({ entryPoints: ["src/core/a.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core").sort()).toEqual(["capability_changed", "capability_missing_path"]);
    expect(statusFor(report, "cap-core")).toBe("review");
  });

  it("a deletion of the entry point is both changed and a missing path", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    unlinkSync(join(root, "src/core/a.ts"));
    commit(root, "delete");

    const entry = capability({ entryPoints: ["src/core/a.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core").sort()).toEqual(["capability_changed", "capability_missing_path"]);
  });
});

describe("checkCapabilities: literal pathspecs", () => {
  /**
   * Each name here is pathspec magic or shell-special. Without `:(literal)` the
   * diff would either widen to a glob or be rejected outright, and the entry
   * would look changed whenever an unrelated sibling changed.
   */
  const TRICKY = [":lead.ts", "src/[x].ts", "src/a*b.ts", "src/:colon.ts", "src/with space.ts", "src/new\nline.ts"];

  it("matches a name containing pathspec magic as exact bytes, not as a glob", async () => {
    const root = newRepo();
    for (const p of TRICKY) write(root, p, "one");
    write(root, "src/axxb.ts", "decoy that a glob would catch");
    write(root, "src/x.ts", "decoy that a character class would catch");
    const base = commit(root, "base");

    // Touch ONLY the decoys. A literal pathspec must report nothing changed.
    // This direction alone is weak evidence: a widened pathspec would also have
    // to survive the isPathWithin filter on the diff's output, which drops
    // `src/axxb.ts` anyway. The test below is the one that fails without
    // `:(literal)`, because a leading colon makes git read the name as magic.
    write(root, "src/axxb.ts", "touched");
    write(root, "src/x.ts", "touched");
    commit(root, "touch the decoys only");

    const entry = capability({ entryPoints: TRICKY, checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual([]);
  });

  it("still reports a real change to each of those names, one at a time", async () => {
    for (const tricky of TRICKY) {
      const root = newRepo();
      write(root, tricky, "one");
      const base = commit(root, "base");
      write(root, tricky, "two");
      commit(root, "edit the tricky name");

      const entry = capability({ entryPoints: [tricky], checkedAt: { sha: base, date: "2026-09-20" } });
      const report = await checkCapabilities(root, [entry]);
      expect(codesFor(report, "cap-core"), tricky).toEqual(["capability_changed"]);
    }
    // One repo and several git subprocesses per name, so the default 5s is thin.
  }, 20000);

  it("parses the NUL-delimited diff so a newline in a name is one path, not two", async () => {
    const root = newRepo();
    write(root, "src/new\nline.ts", "one");
    const base = commit(root, "base");
    write(root, "src/new\nline.ts", "two");
    commit(root, "edit");

    // The entry point is the newline name ITSELF. An entry of "src" would be
    // satisfied by either half of a split path, so a parser that split on \n
    // would still report one changed file under it and pass.
    const entry = capability({ entryPoints: ["src/new\nline.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    const detail = report.entries[0]!.results[0]!.detail;
    expect(detail).toContain("1 file(s)");
    expect(detail, "the whole name, in the reversible display form").toContain("src/new\\u000aline.ts");
  });
});

describe("checkCapabilities: batching and the deadline", () => {
  it("spends three subprocesses per DISTINCT checkpoint plus one for HEAD", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");

    const entries = Array.from({ length: 12 }, (_, i) =>
      capability({ id: `cap-e${i}`, name: `E${i}`, checkedAt: { sha: base, date: "2026-09-20" } }),
    );
    const report = await checkCapabilities(root, entries);
    expect(report.gitCalls).toBe(4);
  });

  /**
   * The invariant is a SUBPROCESS COUNT that scales with distinct checkpoints.
   * It is measured through a controlled runner: real git, run synchronously,
   * with no per-call timeout and no abort signal. The production runner's 10s
   * timeout and the check's 30s abort are wall-clock, and under load they kill
   * calls, which lowers the count and makes a slow machine read as a batching
   * change. The frozen clock only stops the DEADLINE from halting scheduling;
   * it does not disarm those timers, which is why the runner is replaced too.
   */
  it("spends exactly three per distinct checkpoint as the number of checkpoints grows", async () => {
    const root = newRepo();
    const shas: string[] = [];
    write(root, "src/core/a.ts", "seed");
    shas.push(commit(root, "seed"));
    for (let i = 1; i < 16; i++) {
      write(root, `src/core/f${i}.ts`, String(i));
      shas.push(commit(root, `c${i}`));
    }

    const entries = shas.map((sha, i) =>
      capability({ id: `cap-e${i}`, name: `E${i}`, checkedAt: { sha, date: "2026-09-20" } }),
    );
    const runner = controlledGit();
    const report = await checkCapabilities(root, entries, null, { now: () => 0, runGit: runner.run });
    // One for HEAD, then resolve + ancestor + diff for each of 16 checkpoints.
    expect(report.gitCalls).toBe(1 + 3 * 16);
    expect(runner.calls).toBe(1 + 3 * 16);
    expect(report.unchecked).toEqual([]);
    expect(report.deadlineHit).toBe(false);
    // Every checkpoint but the last is behind HEAD with files added under
    // src/core since; the last IS HEAD, so nothing changed under it.
    for (let i = 0; i < 15; i++) expect(codesFor(report, `cap-e${i}`), `cap-e${i}`).toEqual(["capability_changed"]);
    expect(codesFor(report, "cap-e15")).toEqual([]);
  });

  it("marks every unscheduled entry as a timeout rather than leaving it current", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");

    // A clock that is already past the deadline after the first reading.
    let reads = 0;
    const now = (): number => (reads++ === 0 ? 0 : CHECK_DEADLINE_MS + 1);

    const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })], null, { now });
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_timeout"]);
    expect(statusFor(report, "cap-core")).toBe("review");
    expect(report.deadlineHit).toBe(true);
    expect(report.unchecked).toEqual(["cap-core"]);
    expect(report.gitCalls).toBe(1);
  });

  it("--no-check skips the git work entirely and still runs the structural checks", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    write(root, "src/core/a.ts", "two");
    commit(root, "edit");

    const entry = capability({ entryPoints: ["src/core", "src/gone"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry], null, { skipFreshness: true });
    expect(codesFor(report, "cap-core")).toEqual(["capability_missing_path"]);
    expect(report.gitCalls).toBe(0);
    expect(report.head).toBeNull();
  });

  it("reports incomplete rather than current when HEAD cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "capability-nogit-"));
    roots.push(root);
    mkdirSync(join(root, "src", "core"), { recursive: true });
    writeFileSync(join(root, "src", "core", "a.ts"), "one");

    const report = await checkCapabilities(root, [capability()]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(statusFor(report, "cap-core")).toBe("review");
    expect(report.unchecked).toEqual(["cap-core"]);
  });
});

describe("checkCapabilities: structural", () => {
  it("names a missing entry point", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");

    const entry = capability({ entryPoints: ["src/core", "src/nope.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    const results = report.entries[0]!.results;
    expect(results.map((r) => r.code)).toEqual(["capability_missing_path"]);
    expect(results[0]!.detail).toContain("src/nope.ts");
  });

  it("reports a dangling symlink entry point as missing, and says why", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    symlinkSync("./nowhere.ts", join(root, "src", "core", "dangling.ts"));
    const base = commit(root, "base");

    const entry = capability({ entryPoints: ["src/core/dangling.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    const results = report.entries[0]!.results;
    expect(results.map((r) => r.code)).toContain("capability_missing_path");
    expect(results.find((r) => r.code === "capability_missing_path")!.detail).toContain("target does not resolve");
  });

  it("refuses an entry point that resolves outside the project root", async () => {
    const root = newRepo();
    const outside = mkdtempSync(join(tmpdir(), "capability-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.ts"), "not ours");
    write(root, "src/core/a.ts", "one");
    symlinkSync(join(outside, "secret.ts"), join(root, "src", "core", "escape.ts"));
    const base = commit(root, "base");

    const entry = capability({ entryPoints: ["src/core/escape.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toContain("capability_path_escape");
    expect(statusFor(report, "cap-core")).toBe("review");
  });

  it("flags an unknown ruling id", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");

    const entry = capability({ rulings: ["r-0123456789abcdef"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_unknown_ruling"]);
  });

  // A structural finding asserts something about the repository, so it may
  // only be raised when the check actually saw the repository say so.
  it("a ruling whose file exists but does not parse is incomplete, not unknown", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    write(root, ".story/rulings/r-0123456789abcdef.json", "{ not json");
    const base = commit(root, "base");

    const entry = capability({ rulings: ["r-0123456789abcdef"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(report.entries[0]!.results[0]!.detail).toBe(
      "ruling r-0123456789abcdef exists but could not be read or validated, so the reference was not checked",
    );
    expect(isStampable(report.entries[0]!)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("a ruling file this process cannot read is incomplete, not unknown", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    // A VALID ruling, so the only thing the chmod changes is readability. An
    // unparseable fixture would be incomplete whether or not it could be read,
    // and the permission bit would then be proving nothing.
    write(
      root,
      ".story/rulings/r-0123456789abcdef.json",
      JSON.stringify({
        id: "r-0123456789abcdef",
        text: "The ruling this capability cites.",
        attribution: "owner-direct",
        recordedBy: { client: "claude", id: "claude-session-abc" },
        date: "2026-09-20",
        scopeTags: [],
        supersedes: null,
        createdAt: "2026-09-20T00:00:00.000Z",
      }),
    );
    const base = commit(root, "base");
    const entry = capability({ rulings: ["r-0123456789abcdef"], checkedAt: { sha: base, date: "2026-09-20" } });
    expect(codesFor(await checkCapabilities(root, [entry]), "cap-core"), "readable, the same fixture is clean").toEqual([]);

    const file = join(root, ".story", "rulings", "r-0123456789abcdef.json");
    chmodSync(file, 0o000);
    try {
      const report = await checkCapabilities(root, [entry]);
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      expect(isStampable(report.entries[0]!)).toBe(false);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("an unparseable ruling file with no recoverable id makes every unresolved ruling incomplete", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    write(root, ".story/rulings/not-a-ruling-id.json", "{ not json");
    const base = commit(root, "base");

    const entry = capability({ rulings: ["r-0123456789abcdef"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(report.entries[0]!.results[0]!.detail).toContain("the rulings scan was incomplete");
  });

  it("resolves items against the project state, in either id form", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    const state = {
      tickets: [{ id: "t-qnja385m9qmnc5ak", displayId: "T-523" }],
      issues: [{ id: "ISS-1107" }],
    } as unknown as ProjectState;

    const known = capability({ items: ["T-523", "t-qnja385m9qmnc5ak", "ISS-1107"], checkedAt: { sha: base, date: "2026-09-20" } });
    expect(codesFor(await checkCapabilities(root, [known], state), "cap-core")).toEqual([]);

    const unknown = capability({ items: ["T-999"], checkedAt: { sha: base, date: "2026-09-20" } });
    expect(codesFor(await checkCapabilities(root, [unknown], state), "cap-core")).toEqual(["capability_unknown_item"]);
  });

  it("treats an absent glossary as empty, so every term reference is unresolved", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");

    const entry = capability({ terms: ["term-pen"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_unknown_term"]);
  });

  it("checks surface names against the shipped reference inventory", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");

    const real = capability({
      surfaces: { cli: ["status"], mcp: ["storybloq_status"] },
      checkedAt: { sha: base, date: "2026-09-20" },
    });
    expect(codesFor(await checkCapabilities(root, [real]), "cap-core")).toEqual([]);

    const invented = capability({
      surfaces: { cli: ["capability wishlist"], mcp: ["storybloq_not_a_tool"] },
      checkedAt: { sha: base, date: "2026-09-20" },
    });
    const report = await checkCapabilities(root, [invented]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_unknown_surface", "capability_unknown_surface"]);
  });

  it("takes conflicted and invariant-problem ids from the caller", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");

    const entry = capability({ checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry], null, {
      conflictedIds: new Set(["cap-core"]),
      problemIds: new Set(["cap-core"]),
    });
    expect(codesFor(report, "cap-core")).toEqual(["capability_conflicted", "capability_invariant_problem"]);
    expect(statusFor(report, "cap-core")).toBe("review");
  });
});

describe("effective status and stampability", () => {
  it("a stored review flag survives a clean check", () => {
    expect(effectiveStatus("review", [])).toBe("review");
    expect(effectiveStatus("current", [])).toBe("current");
  });

  it("any result at all makes the effective status review", () => {
    const one = [{ code: "capability_changed", cls: "freshness", detail: "x" }] as const;
    expect(effectiveStatus("current", one)).toBe("review");
  });

  it("freshness is stampable and structural is not, which is what makes stamping a recovery", () => {
    const freshness = { id: "cap-a", storedStatus: "current", effectiveStatus: "review", results: [{ code: "capability_changed", cls: "freshness", detail: "x" }] } as const;
    const structural = { id: "cap-b", storedStatus: "current", effectiveStatus: "review", results: [{ code: "capability_missing_path", cls: "structural", detail: "x" }] } as const;
    const incomplete = { id: "cap-c", storedStatus: "current", effectiveStatus: "review", results: [{ code: "capability_check_timeout", cls: "incomplete", detail: "x" }] } as const;
    expect(isStampable(freshness)).toBe(true);
    expect(isStampable(structural)).toBe(false);
    expect(isStampable(incomplete)).toBe(false);
  });
});

describe("matchCapabilities: paths", () => {
  const entries = [
    capability({ id: "cap-core", name: "Core", entryPoints: ["src/core"] }),
    capability({ id: "cap-file", name: "File", entryPoints: ["src/cli/commands/ruling.ts"] }),
    capability({ id: "cap-extra", name: "Extra", entryPoints: ["src/core-extra"] }),
  ];
  const ids = (paths: string[]): string[] =>
    matchCapabilities(entries, { paths }).matches.map((m) => m.capability.id);

  it("matches an exact entry point", () => {
    expect(ids(["src/core"])).toEqual(["cap-core"]);
  });

  it("matches a query underneath a directory entry point", () => {
    expect(ids(["src/core/ruling.ts"])).toEqual(["cap-core"]);
  });

  it("matches a directory query that contains a file entry point", () => {
    expect(ids(["src/cli"])).toEqual(["cap-file"]);
  });

  it("never matches across a partial segment", () => {
    expect(ids(["src/core"])).not.toContain("cap-extra");
    expect(ids(["src/core-extra"])).toEqual(["cap-extra"]);
  });

  it("never matches a sibling file", () => {
    expect(ids(["src/cli/commands/lesson.ts"])).toEqual([]);
  });

  it("returns nothing for a wholly unrelated path", () => {
    expect(ids(["docs/readme.md"])).toEqual([]);
  });

  it("normalises a trailing slash on the query side too", () => {
    expect(ids(["src/core/"])).toEqual(["cap-core"]);
  });

  it("isPathWithin is segment-aware in both the equal and the nested case", () => {
    expect(isPathWithin("src/core", "src/core")).toBe(true);
    expect(isPathWithin("src/core", "src/core/a.ts")).toBe(true);
    expect(isPathWithin("src/core", "src/core-extra/a.ts")).toBe(false);
    expect(isPathWithin("src/core", "src")).toBe(false);
  });
});

describe("matchCapabilities: title, phase and disclosure", () => {
  const entries = [
    capability({ id: "cap-logging", name: "Capped logging", summary: "Truncate a log line at a byte cap.", entryPoints: ["src/log"] }),
    capability({ id: "cap-rulings", name: "Rulings", summary: "Record an attributed decision.", entryPoints: ["src/core/ruling.ts"], items: ["T-476"] }),
  ];

  it("matches whole words of the title against name and summary", () => {
    const res = matchCapabilities(entries, { title: "Add a cap to the logging output" });
    expect(res.matches.map((m) => m.capability.id)).toEqual(["cap-logging"]);
    expect(res.matches[0]!.reasons[0]!.detail).toContain("logging");
  });

  it("drops stop words and short words so a generic title matches nothing", () => {
    expect(titleWords("Add the new set of all")).toEqual([]);
    expect(matchCapabilities(entries, { title: "Add the new set of all" }).matches).toEqual([]);
  });

  it("does not stem, so a near-miss is a miss rather than a wrong entry", () => {
    // "ruling" is one character off "Rulings" and appears nowhere in the
    // summary, so the singular must not reach the plural entry.
    expect(matchCapabilities(entries, { title: "the ruling" }).matches).toEqual([]);
    expect(matchCapabilities(entries, { title: "the rulings" }).matches.map((m) => m.capability.id)).toEqual(["cap-rulings"]);
  });

  it("matches a phase through the entry's items", () => {
    const state = { tickets: [{ id: "T-476", phase: "phase-1" }], issues: [] } as unknown as ProjectState;
    const res = matchCapabilities(entries, { phaseId: "phase-1" }, state);
    expect(res.matches.map((m) => m.capability.id)).toEqual(["cap-rulings"]);
    expect(res.matches[0]!.reasons[0]!.kind).toBe("phase");
  });

  it("combines criteria as a union and reports EVERY reason, not the first", () => {
    const state = { tickets: [{ id: "T-476", phase: "phase-1" }], issues: [] } as unknown as ProjectState;
    const res = matchCapabilities(entries, { paths: ["src/core/ruling.ts"], title: "the rulings packet", phaseId: "phase-1" }, state);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]!.reasons.map((r) => r.kind)).toEqual(["path", "title", "phase"]);

    // Criteria that match DIFFERENT entries. The case above has all three
    // pointing at one entry, so an implementation that INTERSECTED the
    // criteria would satisfy it just as well; only a split query separates a
    // union from an intersection.
    const split = matchCapabilities(entries, { paths: ["src/log"], title: "the rulings packet" });
    expect(split.matches.map((m) => m.capability.id).sort()).toEqual(["cap-logging", "cap-rulings"]);
    expect(split.matches.map((m) => m.reasons.map((r) => r.kind))).toEqual([["path"], ["title"]]);
  });

  it("lists excluded entries instead of silently dropping them, and still counts them", () => {
    const res = matchCapabilities(entries, { paths: ["src/log"] }, null, new Map([["cap-logging", "unresolved conflict"]]));
    expect(res.matches).toEqual([]);
    expect(res.excluded).toEqual([{ id: "cap-logging", reason: "unresolved conflict" }]);
    expect(res.inventorySize).toBe(2);
  });

  it("always reports what was searched and that the search was bounded", () => {
    const res = matchCapabilities(entries, { paths: ["nothing/here"] });
    expect(res.bounded).toBe("inventory only");
    expect(res.searched).toEqual({ paths: ["nothing/here"], titleWords: [], phaseId: null });
    expect(matchDisclosure(res)).toContain("searched 2 inventory entries");
    expect(matchDisclosure(res)).toContain("no match is not evidence that no implementation exists");
  });

  it("discloses the title words it actually used, not the raw title", () => {
    const res = matchCapabilities(entries, { title: "Add the logging cap" });
    expect(res.searched.titleWords).toEqual(["logging", "cap"]);
    expect(matchDisclosure(res)).toContain("title words (logging, cap)");
  });
});

describe("checkCapabilities: what `merge-base --is-ancestor` exit codes mean", () => {
  function setup(): { root: string; entry: Capability } {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    return { root, entry: capability({ checkedAt: { sha: base, date: "2026-09-20" } }) };
  }
  const answering = (exitCode: number) =>
    controlledGit((args) => (args[0] === "merge-base" ? { ok: true, stdout: "", stderr: "", exitCode } : null));

  it("exit 1 is git answering NO: a freshness finding, and stampable", async () => {
    const { root, entry } = setup();
    const report = await checkCapabilities(root, [entry], null, { runGit: answering(1).run });
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
    expect(report.unchecked).toEqual([]);
    expect(isStampable(report.entries[0]!)).toBe(true);
  });

  it("exit 128 is git failing to answer: incomplete, unchecked, and NOT stampable", async () => {
    const { root, entry } = setup();
    const report = await checkCapabilities(root, [entry], null, { runGit: answering(128).run });
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(report.entries[0]!.results[0]!.detail).toContain("exit 128");
    expect(report.unchecked).toEqual(["cap-core"]);
    expect(isStampable(report.entries[0]!)).toBe(false);
  });
});

describe("checkCapabilities: a checkpoint that does not resolve claims only what git said", () => {
  const skipIfRoot = it.skipIf(process.getuid?.() === 0);
  const objectPath = (root: string, sha: string): string => join(root, ".git", "objects", sha.slice(0, 2), sha.slice(2));

  function twoCommits(): { root: string; base: string; head: string } {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    write(root, "src/core/a.ts", "two");
    const head = commit(root, "edit");
    return { root, base, head };
  }

  async function checkAt(root: string, sha: string, runGit?: GitRunner) {
    const report = await checkCapabilities(root, [capability({ checkedAt: { sha, date: "2026-09-20" } })], null, runGit ? { runGit } : {});
    return { report, entry: report.entries[0]!, detail: report.entries[0]!.results[0]?.detail };
  }

  it("git finding no such object is unverifiable and stampable, and costs one resolve", async () => {
    const { root } = twoCommits();
    const absent = "d".repeat(40);
    const { report, entry, detail } = await checkAt(root, absent);
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
    expect(detail).toBe(
      `git could not find checkpoint ${absent} in this repository (a shallow clone, or a commit rebased away and garbage-collected, looks like this): re-inspect and re-stamp`,
    );
    expect(isStampable(entry)).toBe(true);
    expect(report.unchecked).toEqual([]);
    expect(report.gitCalls).toBe(2);
  });

  it("an abbreviated sha git cannot find is the same finding", async () => {
    const { root } = twoCommits();
    const { report, entry } = await checkAt(root, "dddddddd");
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
    expect(isStampable(entry)).toBe(true);
  });

  it("a checkpoint older than a shallow clone's boundary stays stampable", async () => {
    const { root: origin, base } = twoCommits();
    const parent = mkdtempSync(join(tmpdir(), "capability-shallow-"));
    roots.push(parent);
    git(parent, ["clone", "-q", "--depth", "1", `file://${origin}`, "clone"]);
    const root = join(parent, "clone");
    const { report, entry, detail } = await checkAt(root, base);
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
    expect(detail).toContain("git could not find checkpoint");
    expect(isStampable(entry)).toBe(true);
  });

  it("a sha naming a tree is unverifiable, with git's own type, at one extra call", async () => {
    const { root, head } = twoCommits();
    const tree = git(root, ["rev-parse", `${head}^{tree}`]).trim();
    const { report, entry, detail } = await checkAt(root, tree);
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
    expect(detail).toBe(`checkpoint ${tree} names a tree, which does not resolve to a commit: re-inspect and re-stamp`);
    expect(isStampable(entry)).toBe(true);
    expect(report.gitCalls).toBe(3);
  });

  it("a corrupt loose checkpoint object is incomplete, quoting git, and NOT stampable", async () => {
    const { root, base } = twoCommits();
    const obj = objectPath(root, base);
    chmodSync(obj, 0o644);
    writeFileSync(obj, "not a zlib stream");
    const { report, entry, detail } = await checkAt(root, base);
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(detail).toContain(`git could not read checkpoint ${base} (exit 128): git said "`);
    expect(isStampable(entry)).toBe(false);
    expect(report.unchecked).toEqual(["cap-core"]);
  });

  // Exit 128 is classified before any probe runs. On this fixture `cat-file -t`
  // answers a type for the corrupt commit anyway, so probing first would report
  // a corrupt object as "names a tag".
  it("a corrupt PACKED checkpoint is incomplete, never a type the corrupt bytes happen to spell", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    git(root, ["repack", "-a", "-d", "-q"]);
    write(root, "src/core/a.ts", "two");
    commit(root, "edit, left loose so HEAD still reads");
    const packDir = join(root, ".git", "objects", "pack");
    const pack = join(packDir, readdirSync(packDir).find((f) => f.endsWith(".pack"))!);
    chmodSync(pack, 0o644);
    const bytes = readFileSync(pack);
    for (let i = 12; i < bytes.length - 20; i++) bytes[i]! ^= 0x5a;
    writeFileSync(pack, bytes);

    const { report, entry, detail } = await checkAt(root, base);
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(detail).toContain("(exit 128)");
    expect(isStampable(entry)).toBe(false);
  });

  skipIfRoot("a checkpoint object this process cannot open is incomplete, not absent", async () => {
    const { root, base } = twoCommits();
    const obj = objectPath(root, base);
    chmodSync(obj, 0o000);
    try {
      const { report, entry, detail } = await checkAt(root, base);
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      expect(detail).toContain(`git could not read checkpoint ${base}: git said "`);
      expect(isStampable(entry)).toBe(false);
    } finally {
      chmodSync(obj, 0o444);
    }
  });

  skipIfRoot("an object directory this process cannot list is incomplete, not absent", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    // HEAD's commit object must sit in another shard, or HEAD is what fails.
    let head = base;
    for (let i = 0; head.slice(0, 2) === base.slice(0, 2) || head === base; i++) {
      write(root, "src/core/a.ts", `edit ${i}`);
      head = commit(root, `edit ${i}`);
    }
    const shard = dirname(objectPath(root, base));
    chmodSync(shard, 0o000);
    try {
      const { report, entry, detail } = await checkAt(root, base);
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      expect(detail).toContain(`git could not read checkpoint ${base}: git said "`);
      expect(isStampable(entry)).toBe(false);
    } finally {
      chmodSync(shard, 0o755);
    }
  });

  function resolveAnswering(resolve: GitOutcome, probe?: GitOutcome): { run: GitRunner; probes: () => number } {
    let probes = 0;
    const git = controlledGit((args) => {
      if (args[0] === "rev-parse" && args.includes("--quiet")) return resolve;
      if (args[0] === "cat-file") {
        probes += 1;
        return probe ?? null;
      }
      return null;
    });
    return { run: git.run, probes: () => probes };
  }
  const outcome = (exitCode: number | null, stdout = "", stderr = ""): GitOutcome => ({ ok: exitCode !== null, stdout, stderr, exitCode });

  it("exit 128 is incomplete before the type probe runs, even when the probe would answer a type", async () => {
    const { root, base } = twoCommits();
    const git = resolveAnswering(outcome(128, "", "error: inflate: data stream error\nfatal: packed object is corrupt"), outcome(0, "tag\n"));
    const { report, detail } = await checkAt(root, base, git.run);
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(detail).toBe(`git could not read checkpoint ${base} (exit 128): git said "error: inflate: data stream error"`);
    expect(git.probes()).toBe(0);
  });

  it("the probe answering `commit` for an object the resolve could not read is a contradiction: incomplete", async () => {
    const { root, base } = twoCommits();
    const git = resolveAnswering(outcome(1, "", "error: unable to open loose object"), outcome(0, "commit\n"));
    const { report, entry } = await checkAt(root, base, git.run);
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(isStampable(entry)).toBe(false);
    expect(git.probes()).toBe(1);
  });

  it("a probe that fails or is killed is incomplete, not a type", async () => {
    const { root, base } = twoCommits();
    for (const probe of [outcome(128, "", "fatal: could not get object info"), outcome(null)]) {
      const git = resolveAnswering(outcome(1, "", "error: unable to open loose object"), probe);
      const { report } = await checkAt(root, base, git.run);
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      expect(git.probes()).toBe(1);
    }
  });

  it("a resolve that succeeds but prints no id is incomplete", async () => {
    const { root, base } = twoCommits();
    const { report, detail } = await checkAt(root, base, resolveAnswering(outcome(0, "\n")).run);
    expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
    expect(detail).toBe(`git resolved checkpoint ${base} but printed no commit id`);
  });

  it("git's stderr is quoted as one sanitized, capped line", async () => {
    const { root, base } = twoCommits();
    const hostile = `\n  \u001b[31merror\u001b[0m: ${"x".repeat(500)}\u202e\nsecond line`;
    const { detail } = await checkAt(root, base, resolveAnswering(outcome(128, "", hostile)).run);
    expect(detail).toContain(`(exit 128): git said "?[31merror?[0m: xxx`);
    expect(detail).toContain("... (truncated)");
    expect(detail).not.toMatch(/[\u001b\u202e]/);
    expect(detail).not.toContain("second line");
    expect(detail!.length).toBeLessThan(400);
  });
});

// A partial clone asks its promisor remote for any object it lacks, unless the
// caller turns that off. These rows pin the CONSEQUENCES of turning it off for
// the checkpoint resolve and its probe: what the check reports, and whether it
// wrote anything into the object store. Spawn counts are how this was found,
// and are deliberately not what is asserted.
describe("checkCapabilities: the checkpoint resolve never asks a promisor remote", () => {
  const skipIfRoot = it.skipIf(process.getuid?.() === 0);

  function originWithHistory(): { origin: string; base: string; head: string } {
    const origin = newRepo();
    write(origin, "src/core/a.ts", "one");
    const base = commit(origin, "base");
    write(origin, "src/core/a.ts", "two");
    const head = commit(origin, "edit");
    git(origin, ["config", "uploadpack.allowFilter", "true"]);
    git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    return { origin, base, head };
  }

  function cloneOf(origin: string, flags: string[]): string {
    const parent = mkdtempSync(join(tmpdir(), "capability-partial-"));
    roots.push(parent);
    git(parent, ["clone", "-q", ...flags, `file://${origin}`, "clone"]);
    return join(parent, "clone");
  }

  /** Runs `body` with the origin unreachable: a lazy fetch then fails loudly instead of quietly succeeding. */
  async function withOriginGone<T>(origin: string, body: () => Promise<T>): Promise<T> {
    const away = `${origin}.away`;
    renameSync(origin, away);
    try {
      return await body();
    } finally {
      renameSync(away, origin);
    }
  }

  it("an absent checkpoint in a partial clone is unverifiable and stampable, never incomplete", async () => {
    const { origin } = originWithHistory();
    const root = cloneOf(origin, ["--filter=blob:none"]);
    const absent = "d".repeat(40);
    const report = await withOriginGone(origin, () =>
      checkCapabilities(root, [capability({ checkedAt: { sha: absent, date: "2026-09-20" } })]),
    );
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
    expect(report.entries[0]!.results[0]!.detail).toContain(`git could not find checkpoint ${absent}`);
    expect(isStampable(report.entries[0]!)).toBe(true);
  });

  // Both filters. blob:none is the one CI checkouts use; the two agree today,
  // which is no promise that a later git keeps them agreeing.
  //
  // ISS-1280: --fetch opens only the diff, so the resolve stays local and the
  // row reads the same with it on.
  it.each([
    ["blob:none", false],
    ["tree:0", false],
    ["blob:none", true],
    ["tree:0", true],
  ] as const)("a checkpoint past the shallow boundary of a FILTERED clone (%s, fetch %s) stays stampable", async (filter, fetch) => {
    const { origin, base } = originWithHistory();
    const root = cloneOf(origin, ["--depth", "1", `--filter=${filter}`]);
    const report = await withOriginGone(origin, () =>
      checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })], null, { fetch }),
    );
    expect(codesFor(report, "cap-core")).toEqual(["capability_unverifiable_checkpoint"]);
    expect(report.entries[0]!.results[0]!.detail).toContain(`git could not find checkpoint ${base}`);
    expect(isStampable(report.entries[0]!)).toBe(true);
  });

  // A replaced environment does not fail loudly: with no PATH, node looks git
  // up in /usr/bin:/bin, so the resolve quietly runs a different git without
  // the caller's HOME, config or GIT_* variables. A recording `git` first on
  // PATH makes that visible, and shows which calls carry the variable.
  //
  // ISS-1280: every call is local by default, the diff included; under fetch
  // only the diff may fetch, with git terminal prompts disabled. A checkpoint
  // naming a tree drives the type probe, so it is recorded too.
  it.each([false, true])("every call runs in the caller's environment plus the lazy-fetch variable (fetch %s)", async (fetch) => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
    write(root, "src/core/a.ts", "two");
    commit(root, "edit");
    const bin = mkdtempSync(join(tmpdir(), "capability-bin-"));
    roots.push(bin);
    const log = join(bin, "calls.log");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "\${CAPABILITY_TEST_MARK:-unset}" "\${GIT_NO_LAZY_FETCH:-unset}" "\${GIT_TERMINAL_PROMPT:-unset}" "$*" >> '${log}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    const saved = { path: process.env.PATH, mark: process.env.CAPABILITY_TEST_MARK, lazy: process.env.GIT_NO_LAZY_FETCH, prompt: process.env.GIT_TERMINAL_PROMPT };
    process.env.PATH = `${bin}:${saved.path ?? ""}`;
    process.env.CAPABILITY_TEST_MARK = "inherited";
    // The prompt rows are asserted as `unset`, which is a claim about the
    // AMBIENT environment: a developer or CI with either variable exported
    // would see the recorder print it and the test would fail for a reason
    // that has nothing to do with the code.
    delete process.env.GIT_NO_LAZY_FETCH;
    delete process.env.GIT_TERMINAL_PROMPT;
    try {
      const report = await checkCapabilities(
        root,
        [
          capability({ checkedAt: { sha: base, date: "2026-09-20" } }),
          capability({ id: "cap-tree", checkedAt: { sha: tree, date: "2026-09-20" } }),
        ],
        null,
        { fetch },
      );
      expect(codesFor(report, "cap-core")).toEqual(["capability_changed"]);
      expect(codesFor(report, "cap-tree")).toEqual(["capability_unverifiable_checkpoint"]);
      const calls = readFileSync(log, "utf-8").trim().split("\n");
      const kinds = {
        head: calls.filter((c) => c.includes("rev-parse --verify HEAD^{commit}")),
        resolve: calls.filter((c) => c.includes("rev-parse --verify --quiet")),
        probe: calls.filter((c) => c.includes(" cat-file -t ")),
        ancestor: calls.filter((c) => c.includes(" merge-base --is-ancestor ")),
        diff: calls.filter((c) => c.includes(" diff --no-renames ")),
      };
      expect(Object.values(kinds).map((k) => k.length)).toEqual([1, 2, 1, 1, 1]);
      expect(calls).toHaveLength(6);
      for (const call of [...kinds.head, ...kinds.resolve, ...kinds.probe, ...kinds.ancestor]) {
        expect(call.startsWith("inherited|1|unset|")).toBe(true);
      }
      expect(kinds.diff[0]!.startsWith(fetch ? "inherited|0|0|" : "inherited|1|unset|")).toBe(true);
    } finally {
      // Assigning an undefined value writes the STRING "undefined", which is a
      // PATH of one nonexistent directory; the variable has to be deleted.
      if (saved.path === undefined) delete process.env.PATH;
      else process.env.PATH = saved.path;
      if (saved.mark === undefined) delete process.env.CAPABILITY_TEST_MARK;
      else process.env.CAPABILITY_TEST_MARK = saved.mark;
      if (saved.lazy === undefined) delete process.env.GIT_NO_LAZY_FETCH;
      else process.env.GIT_NO_LAZY_FETCH = saved.lazy;
      if (saved.prompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = saved.prompt;
    }
  });

  // The probe only runs when the resolve found the object and could not read
  // it. Asking the promisor then changes no classification, since the probe
  // fails either way, but it does reach the network and write a pack. That
  // write is the consequence pinned here.
  skipIfRoot("probing an unreadable checkpoint writes nothing into the object store", async () => {
    const { origin, base } = originWithHistory();
    const root = cloneOf(origin, ["--filter=blob:none"]);
    // Promisor fetches always keep packs, so make the objects loose by hand.
    const packDir = join(root, ".git", "objects", "pack");
    const aside = mkdtempSync(join(tmpdir(), "capability-packs-"));
    roots.push(aside);
    for (const f of readdirSync(packDir)) renameSync(join(packDir, f), join(aside, f));
    for (const f of readdirSync(aside).filter((n) => n.endsWith(".pack"))) {
      execFileSync("git", ["unpack-objects", "-q"], { cwd: root, env: GIT_ENV, input: readFileSync(join(aside, f)) });
    }
    const obj = join(root, ".git", "objects", base.slice(0, 2), base.slice(2));
    chmodSync(obj, 0o000);
    try {
      const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })]);
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      expect(isStampable(report.entries[0]!)).toBe(false);
      expect(readdirSync(packDir)).toEqual([]);
    } finally {
      chmodSync(obj, 0o444);
    }
  });

  // ISS-1280: the freshness diff is the one call that needs objects a partial
  // clone may lack: a treeless clone holds no old trees. By default it no
  // longer fetches them, so the entry is incomplete with git's evidence and a
  // likely cause; `fetch` lets it fetch. Every row pins the classification and
  // whether the object store changed, never a spawn count.
  describe("the freshness diff fetches only when asked (ISS-1280)", () => {
    const objectFiles = (root: string): string[] =>
      (readdirSync(join(root, ".git", "objects"), { recursive: true }) as string[]).sort();
    const LIKELY = "in this partial clone the likely cause is that the checkpoint's trees are not stored locally";
    const REMEDY = "run `storybloq capability check --fetch`";
    const failedDiff = (args: readonly string[]): GitOutcome | null =>
      args[0] === "diff" ? { ok: true, stdout: "", stderr: "fatal: unable to read tree (abc123)\n", exitCode: 128 } : null;

    it("a treeless clone with a LIVE origin: incomplete with git's evidence, and nothing fetched", async () => {
      const { origin, base } = originWithHistory();
      const root = cloneOf(origin, ["--filter=tree:0"]);
      const before = objectFiles(root);
      const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })]);
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      const detail = report.entries[0]!.results[0]!.detail;
      expect(detail).toContain(`could not diff ${base}..HEAD for this entry's paths: git said "`);
      expect(detail).toContain(LIKELY);
      expect(detail).toContain(REMEDY);
      expect(isStampable(report.entries[0]!)).toBe(false);
      expect(objectFiles(root)).toEqual(before);
    });

    it("a treeless clone with the origin gone: incomplete with git's evidence, and nothing fetched", async () => {
      const { origin, base } = originWithHistory();
      const root = cloneOf(origin, ["--filter=tree:0"]);
      const before = objectFiles(root);
      const report = await withOriginGone(origin, () =>
        checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })]),
      );
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      expect(report.entries[0]!.results[0]!.detail).toContain(': git said "');
      expect(objectFiles(root)).toEqual(before);
    });

    it("with fetch, a treeless clone fetches the trees and reads the change", async () => {
      const { origin, base } = originWithHistory();
      const root = cloneOf(origin, ["--filter=tree:0"]);
      const before = objectFiles(root);
      const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })], null, { fetch: true });
      expect(codesFor(report, "cap-core")).toEqual(["capability_changed"]);
      expect(report.entries[0]!.results[0]!.detail).toContain("src/core/a.ts");
      expect(objectFiles(root).length).toBeGreaterThan(before.length);
    });

    it("with fetch, an inherited GIT_NO_LAZY_FETCH=1 does not defeat the opt-in", async () => {
      const { origin, base } = originWithHistory();
      const root = cloneOf(origin, ["--filter=tree:0"]);
      const saved = process.env.GIT_NO_LAZY_FETCH;
      process.env.GIT_NO_LAZY_FETCH = "1";
      try {
        const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })], null, { fetch: true });
        expect(codesFor(report, "cap-core")).toEqual(["capability_changed"]);
      } finally {
        if (saved === undefined) delete process.env.GIT_NO_LAZY_FETCH;
        else process.env.GIT_NO_LAZY_FETCH = saved;
      }
    });

    it("with fetch and the origin gone: the fetch-enabled diff failed, with evidence and no --fetch remedy", async () => {
      const { origin, base } = originWithHistory();
      const root = cloneOf(origin, ["--filter=tree:0"]);
      const before = objectFiles(root);
      const report = await withOriginGone(origin, () =>
        checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })], null, { fetch: true }),
      );
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      const detail = report.entries[0]!.results[0]!.detail;
      expect(detail.startsWith(`the fetch-enabled diff of ${base}..HEAD failed: git said "`)).toBe(true);
      expect(detail).not.toContain("--fetch");
      expect(detail).not.toContain(LIKELY);
      expect(objectFiles(root)).toEqual(before);
    });

    it("a blobless clone never needed the network: the change is read and nothing is fetched", async () => {
      const { origin, base } = originWithHistory();
      const root = cloneOf(origin, ["--filter=blob:none"]);
      const before = objectFiles(root);
      const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })]);
      expect(codesFor(report, "cap-core")).toEqual(["capability_changed"]);
      expect(objectFiles(root)).toEqual(before);
    });

    it("a failed diff outside a partial clone carries git's evidence and claims no cause", async () => {
      const root = newRepo();
      write(root, "src/core/a.ts", "one");
      const base = commit(root, "base");
      write(root, "src/core/a.ts", "two");
      commit(root, "edit");
      const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })], null, {
        runGit: controlledGit(failedDiff).run,
      });
      expect(report.entries[0]!.results.map((r) => r.detail)).toEqual([
        `could not diff ${base}..HEAD for this entry's paths: git said "fatal: unable to read tree (abc123)"`,
      ]);
    });

    it("a failed diff in a partial clone names the likely cause beside git's evidence", async () => {
      const { origin, base } = originWithHistory();
      const root = cloneOf(origin, ["--filter=blob:none"]);
      const report = await checkCapabilities(root, [capability({ checkedAt: { sha: base, date: "2026-09-20" } })], null, {
        runGit: controlledGit(failedDiff).run,
      });
      const detail = report.entries[0]!.results[0]!.detail;
      expect(detail).toContain(`could not diff ${base}..HEAD for this entry's paths: git said "fatal: unable to read tree (abc123)"`);
      expect(detail).toContain(LIKELY);
      expect(detail).toContain(REMEDY);
    });
  });
});

describe("normalized entry points against git's paths and against queries", () => {
  it("a change under an entry written as `./src//core/` makes it stale, because the stored form is git's form", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");
    write(root, "src/core/a.ts", "two");
    commit(root, "edit");

    const entry = capability({ entryPoints: ["./src//core/"], checkedAt: { sha: base, date: "2026-09-20" } });
    expect(entry.entryPoints).toEqual(["src/core"]);
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_changed"]);
  });

  const matchIds = (entryPoints: string[], query: string): string[] =>
    matchCapabilities([capability({ entryPoints })], { paths: [query] }).matches.map((m) => m.capability.id);

  it("relates `./src/core/x.ts` to the entry `src/core`: only the query has the odd form", () => {
    expect(matchIds(["src/core"], "./src/core/x.ts")).toEqual(["cap-core"]);
    expect(matchIds(["src/core"], "src//core/x.ts")).toEqual(["cap-core"]);
  });

  it("relates `src/core/x.ts` to an entry written `./src//core/`: only the entry had the odd form", () => {
    expect(matchIds(["./src//core/"], "src/core/x.ts")).toEqual(["cap-core"]);
  });
});

describe("match queries are held to the entry-point rules", () => {
  it("refuses each rule's form with its own reason", () => {
    expect(queryPathRefusal("/repo/src/core/x.ts")).toContain("is absolute: pass it relative to the repository root");
    expect(queryPathRefusal("src\\core\\x.ts")).toContain("uses backslashes");
    expect(queryPathRefusal("src/core/../other/x.ts")).toContain("contains a `..` segment");
    expect(queryPathRefusal(".")).toContain("names the repo root");
    expect(queryPathRefusal("")).toContain("names the repo root");
  });

  // A refusal is printed like a detail, so the query in it takes the path form:
  // JSON.stringify, which it replaced, escaped C0 and left C1, bidi and U+2028
  // raw. One hostile row per rule that can carry one; the root rule cannot
  // (every root form is dots and slashes), so its row pins the empty query.
  it("names a refused query in the reversible path form, and an empty one by name", () => {
    const rows: Array<[string, string]> = [
      ["/src/\u009b31mx.ts", "path /src/\\u009b31mx.ts  (rendered with"],
      ["src/\u202egnp/../x.ts", "path src/\\u202egnp/../x.ts  (rendered with"],
      ["src\\new\u2028line.ts", "path src\\\\new\\u2028line.ts  (rendered with"],
    ];
    for (const [q, prefix] of rows) {
      const refusal = queryPathRefusal(q);
      expect(refusal).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
      expect(refusal?.startsWith(prefix)).toBe(true);
    }
    expect(queryPathRefusal("")).toMatch(/^path \(empty\) names the repo root/);
    expect(queryPathRefusal("./")).toMatch(/^path \.\/ names the repo root/);
  });

  it("accepts the lossless odd forms the normalizer rewrites, and a name that merely contains dots", () => {
    expect(queryPathRefusal("./src//core/x.ts")).toBeNull();
    expect(queryPathRefusal("src/a..b.ts")).toBeNull();
  });

  /**
   * The design this protects: ONE rule source. If the query side ever drops,
   * adds or alters a predicate the entry side does not, some form here is
   * accepted on one side and refused on the other.
   */
  it("refuses a query exactly when the schema refuses the same text as an entry point", () => {
    const forms = [
      "src/core",
      "./src//core/",
      "src/a..b.ts",
      "/abs/x.ts",
      "///",
      "src/../x.ts",
      "..",
      "a\\b.ts",
      ".",
      "./",
      "",
    ];
    for (const form of forms) {
      expect({ form, refused: queryPathRefusal(form) !== null }).toEqual({
        form,
        refused: !EntryPointSchema.safeParse(form).success,
      });
    }
  });

  it("core THROWS when a refused form reaches it: a handler skipped validation, and a quiet no-match would hide that", () => {
    const entries = [capability({ entryPoints: ["src/core"] })];
    for (const q of ["src/core/../other/file.ts", "/src/core/x.ts", "src\\core\\x.ts", ""]) {
      expect(() => matchCapabilities(entries, { paths: [q] })).toThrow(/^matchCapabilities received an unvalidated query: path /);
    }
  });
});

describe("checkCapabilities: no component of an entry point may be a symlink", () => {
  function repoWithTarget(): { root: string } {
    const root = newRepo();
    write(root, "src/real/thing.ts", "one");
    return { root };
  }

  it("flags a LEAF symlink, names it, and names the real path to use instead", async () => {
    const { root } = repoWithTarget();
    symlinkSync("real/thing.ts", join(root, "src", "core-link.ts"), "file");
    const base = commit(root, "base");

    const entry = capability({ entryPoints: ["src/core-link.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_symlinked_path"]);
    const detail = report.entries[0]!.results[0]!.detail;
    expect(detail).toContain("through the symlink src/core-link.ts");
    expect(detail).toContain("point the entry at the real path src/real/thing.ts");
    expect(isStampable(report.entries[0]!)).toBe(false);
  });

  it("flags an ANCESTOR symlink too: `src/link/thing.ts` is as inert as the link itself", async () => {
    const { root } = repoWithTarget();
    symlinkSync("real", join(root, "src", "link"), "dir");
    const base = commit(root, "base");

    const entry = capability({ entryPoints: ["src/link/thing.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_symlinked_path"]);
    const detail = report.entries[0]!.results[0]!.detail;
    expect(detail).toContain("through the symlink src/link");
    expect(detail).toContain("point the entry at the real path src/real/thing.ts");
    expect(isStampable(report.entries[0]!)).toBe(false);
  });

  it("says git cannot watch it at all when an ancestor link leads outside the repository", async () => {
    const { root } = repoWithTarget();
    const outside = mkdtempSync(join(tmpdir(), "capability-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.ts"), "not ours");
    symlinkSync(outside, join(root, "src", "away"), "dir");
    const base = commit(root, "base");

    const entry = capability({ entryPoints: ["src/away/secret.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_path_escape"]);
    const detail = report.entries[0]!.results[0]!.detail;
    expect(detail).toContain("through the symlink src/away");
    expect(detail).toContain("git cannot watch a path outside the repository at all");
  });

  it("treats a link to the project root as INSIDE, and asks for a concrete entry point rather than an empty path", async () => {
    const { root } = repoWithTarget();
    symlinkSync("..", join(root, "src", "to-root"), "dir");
    const base = commit(root, "base");

    const entry = capability({ entryPoints: ["src/to-root"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_symlinked_path"]);
    const detail = report.entries[0]!.results[0]!.detail;
    expect(detail).toContain("through the symlink src/to-root");
    expect(detail).toContain("resolves to the repo root");
    expect(detail).not.toContain("outside the repository");
    expect(detail).not.toMatch(/real path\s*$/);
  });

  it("does NOT flag a plain path when the project root itself is reached through a symlink", async () => {
    const { root } = repoWithTarget();
    const base = commit(root, "base");
    const holder = mkdtempSync(join(tmpdir(), "capability-rootlink-"));
    roots.push(holder);
    const linkedRoot = join(holder, "project");
    symlinkSync(root, linkedRoot, "dir");

    const entry = capability({ entryPoints: ["src/real/thing.ts", "src/real"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(linkedRoot, [entry]);
    expect(codesFor(report, "cap-core")).toEqual([]);
    expect(statusFor(report, "cap-core")).toBe("current");
  });
});

/**
 * A structural finding asserts something about the repository, so it may only
 * be raised when the check actually saw the repository say so. A directory the
 * check cannot read is not evidence that the entry point is missing.
 */
describe("checkCapabilities: a path the check could not see is incomplete, never missing", () => {
  // Root reads through mode 000, so the unreadable case cannot be built there.
  const asRoot = process.getuid?.() === 0;

  function lockedRepo(): { root: string; locked: string; base: string } {
    const root = newRepo();
    write(root, "src/locked/thing.ts", "one");
    symlinkSync("locked/thing.ts", join(root, "src", "link.ts"), "file");
    const base = commit(root, "base");
    return { root, locked: join(root, "src", "locked"), base };
  }

  it.skipIf(asRoot)("an entry under an unreadable directory is incomplete, names the errno, and is not stampable", async () => {
    const { root, locked, base } = lockedRepo();
    chmodSync(locked, 0o000);
    try {
      const entry = capability({ entryPoints: ["src/locked/thing.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
      const report = await checkCapabilities(root, [entry]);
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      expect(codesFor(report, "cap-core")).not.toContain("capability_missing_path");
      expect(report.entries[0]!.results[0]!.detail).toBe("could not inspect entry point src/locked/thing.ts (EACCES)");
      expect(isStampable(report.entries[0]!)).toBe(false);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(asRoot)("a link whose target sits under an unreadable directory is incomplete, not a dangling link", async () => {
    const { root, locked, base } = lockedRepo();
    chmodSync(locked, 0o000);
    try {
      const entry = capability({ entryPoints: ["src/link.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
      const report = await checkCapabilities(root, [entry]);
      expect(codesFor(report, "cap-core")).toEqual(["capability_check_incomplete"]);
      expect(report.entries[0]!.results[0]!.detail).toBe("could not resolve the target of entry point src/link.ts (EACCES)");
      expect(isStampable(report.entries[0]!)).toBe(false);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("a path through a FILE (ENOTDIR) is missing: the path as written does not exist", async () => {
    const { root, base } = lockedRepo();
    const entry = capability({ entryPoints: ["src/locked/thing.ts/inner"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_missing_path"]);
    expect(report.entries[0]!.results[0]!.detail).toBe("entry point does not exist: src/locked/thing.ts/inner");
  });

  it("a link through a FILE is a dangling link, not incomplete", async () => {
    const root = newRepo();
    write(root, "src/file.ts", "one");
    symlinkSync("file.ts/inner", join(root, "src", "bad-link.ts"), "file");
    const base = commit(root, "base");
    const entry = capability({ entryPoints: ["src/bad-link.ts"], checkedAt: { sha: base, date: "2026-09-20" } });
    const report = await checkCapabilities(root, [entry]);
    expect(codesFor(report, "cap-core")).toEqual(["capability_missing_path"]);
    expect(report.entries[0]!.results[0]!.detail).toBe("entry point is a symlink whose target does not resolve: src/bad-link.ts");
  });
});

describe("checkCapabilities: a move is a change at BOTH ends", () => {
  it("reports the source entry when a file moves into another entry sharing its checkpoint", async () => {
    const root = newRepo();
    write(root, "src/a/x.ts", "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n");
    write(root, "src/a/keep.ts", "keep");
    write(root, "src/b/other.ts", "other");
    const base = commit(root, "base");
    git(root, ["mv", "src/a/x.ts", "src/b/x.ts"]);
    commit(root, "move");

    // One checkpoint, so one batched diff over both paths: the case where
    // rename detection reported only the destination.
    const checkedAt = { sha: base, date: "2026-09-20" };
    const a = capability({ id: "cap-a", name: "A", entryPoints: ["src/a"], checkedAt });
    const b = capability({ id: "cap-b", name: "B", entryPoints: ["src/b"], checkedAt });
    const report = await checkCapabilities(root, [a, b]);
    expect(codesFor(report, "cap-a")).toEqual(["capability_changed"]);
    expect(report.entries.find((e) => e.id === "cap-a")!.results[0]!.detail).toContain("src/a/x.ts");
    expect(codesFor(report, "cap-b")).toEqual(["capability_changed"]);
    expect(report.gitCalls).toBe(4);
  });
});

describe("every path and label in a detail is sanitized; the structured fields stay raw", () => {
  const ESC = "\u001b[31m";
  const RLO = "\u202e";

  /** No raw control, line-separator or bidi character reaches a printed string. */
  function expectPrintable(text: string): void {
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
  }

  function detailFor(results: readonly { code: string; detail: string }[], code: string): string {
    const found = results.find((r) => r.code === code);
    expect(found, code).toBeDefined();
    return found!.detail;
  }

  it("names from git's changed-file list render in the reversible escaped form", async () => {
    const root = newRepo();
    const names = [`src/esc${ESC}red.ts`, `src/bidi${RLO}gnp.ts`, "src/new\nline.ts"];
    for (const n of names) write(root, n, "one");
    const base = commit(root, "base");
    for (const n of names) write(root, n, "two");
    commit(root, "edit");

    const report = await checkCapabilities(root, [capability({ entryPoints: ["src"], checkedAt: { sha: base, date: "2026-09-20" } })]);
    const detail = detailFor(report.entries[0]!.results, "capability_changed");
    expect(detail).toContain("3 file(s)");
    expectPrintable(detail);
    expect(detail).toContain("src/esc\\u001b[31mred.ts");
    expect(detail).toContain("src/bidi\\u202egnp.ts");
    expect(detail).toContain("src/new\\u000aline.ts");
  });

  it("an entry point renders escaped in every structural detail that names it", async () => {
    const root = newRepo();
    const outside = mkdtempSync(join(tmpdir(), "capability-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.ts"), "not ours");
    write(root, `src/real${ESC}.ts`, "one");
    symlinkSync(`real${ESC}.ts`, join(root, "src", `link${RLO}.ts`));
    symlinkSync(`nowhere${ESC}.ts`, join(root, "src", `dangling${ESC}.ts`));
    symlinkSync(join(outside, "secret.ts"), join(root, "src", `escape${ESC}.ts`));
    const base = commit(root, "base");

    const entry = capability({
      entryPoints: [`src/gone${ESC}.ts`, `src/dangling${ESC}.ts`, `src/link${RLO}.ts`, `src/escape${ESC}.ts`],
      checkedAt: { sha: base, date: "2026-09-20" },
    });
    const results = (await checkCapabilities(root, [entry])).entries[0]!.results;
    for (const r of results) expectPrintable(r.detail);
    const missing = results.filter((r) => r.code === "capability_missing_path").map((r) => r.detail);
    expect(missing.some((d) => d.startsWith("entry point does not exist: src/gone\\u001b[31m.ts"))).toBe(true);
    expect(missing.some((d) => d.startsWith("entry point is a symlink whose target does not resolve: src/dangling\\u001b[31m.ts"))).toBe(true);
    const linked = detailFor(results, "capability_symlinked_path");
    expect(linked).toContain("entry point src/link\\u202e.ts");
    expect(linked).toContain("passes through the symlink src/link\\u202e.ts");
    expect(linked).toContain("point the entry at the real path src/real\\u001b[31m.ts");
    const escaped = detailFor(results, "capability_path_escape");
    expect(escaped).toContain("entry point src/escape\\u001b[31m.ts");
    expect(escaped).toContain("through the symlink src/escape\\u001b[31m.ts");
  });

  it.skipIf(process.getuid?.() === 0)("an entry point the check could not see renders escaped too", async () => {
    const root = newRepo();
    write(root, `src/locked/thing${ESC}.ts`, "one");
    symlinkSync(`locked/thing${ESC}.ts`, join(root, "src", `link${ESC}.ts`), "file");
    const base = commit(root, "base");
    const locked = join(root, "src", "locked");
    chmodSync(locked, 0o000);
    try {
      const entry = capability({
        entryPoints: [`src/locked/thing${ESC}.ts`, `src/link${ESC}.ts`],
        checkedAt: { sha: base, date: "2026-09-20" },
      });
      const details = (await checkCapabilities(root, [entry])).entries[0]!.results.map((r) => r.detail);
      for (const d of details) expectPrintable(d);
      expect(details.some((d) => d.startsWith("could not inspect entry point src/locked/thing\\u001b[31m.ts") && d.endsWith("(EACCES)"))).toBe(true);
      expect(details.some((d) => d.startsWith("could not resolve the target of entry point src/link\\u001b[31m.ts") && d.endsWith("(EACCES)"))).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("an unknown surface name renders as a label, each dangerous character marked", async () => {
    const root = newRepo();
    write(root, "src/core/a.ts", "one");
    const base = commit(root, "base");

    const entry = capability({ surfaces: { cli: [`wish${ESC}list`], mcp: [`tool${RLO}x`] }, checkedAt: { sha: base, date: "2026-09-20" } });
    const details = (await checkCapabilities(root, [entry])).entries[0]!.results.map((r) => r.detail);
    expect(details).toEqual([
      "no such CLI command in storybloq reference: wish?[31mlist",
      "no such MCP tool in storybloq reference: tool?x",
    ]);
  });

  it("match reasons and the disclosure render paths escaped and the phase as a label; `searched` and the entry stay raw", () => {
    const ep = `src/es${ESC}c`;
    const query = `${ep}/x.ts`;
    const phase = `phase${ESC}1`;
    const entry = capability({ id: "cap-esc", entryPoints: [ep], items: ["T-476"] });
    const state = { tickets: [{ id: "T-476", phase }], issues: [] } as unknown as ProjectState;
    const res = matchCapabilities([entry], { paths: [query], phaseId: phase }, state);

    const [pathReason, phaseReason] = res.matches[0]!.reasons;
    expectPrintable(pathReason!.detail);
    expect(pathReason!.detail.startsWith("src/es\\u001b[31mc/x.ts")).toBe(true);
    expect(pathReason!.detail).toContain("is under the entry point src/es\\u001b[31mc");
    expect(phaseReason!.detail).toBe("phase phase?[31m1 includes T-476");

    const disclosure = matchDisclosure(res);
    expectPrintable(disclosure);
    expect(disclosure).toContain("path (src/es\\u001b[31mc/x.ts");
    expect(disclosure).toContain("phase phase?[31m1");

    // A consumer feeds these back into `match --path` or opens them, and an
    // encoding is only reversible for a consumer that knows to reverse it.
    expect(res.searched.paths).toEqual([query]);
    expect(res.searched.phaseId).toBe(phase);
    expect(res.matches[0]!.capability.entryPoints).toEqual([ep]);
  });
});
