import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverArrayRegistrations, registrationKey } from "./array-registration-inventory.js";
import { E2ECliFixture, runE2ECli, CLI_PATH } from "../helpers/e2e-cli.js";
import { git as fixtureGit } from "../helpers/git-fixture.js";

// ISS-886 regression suite. Runs against the BUILT bundle: `npm run build` must
// have produced a current dist/cli.js before this file can pass (same dependency
// as merge-driver-e2e.test.ts and team-capabilities-e2e.test.ts).
//
// These cases exist end-to-end rather than as unit tests because the defect lived
// in the yargs REGISTRATIONS in src/cli/register.ts, which handler-level tests
// bypass entirely.

// Every test here spawns several `node dist/cli.js` subprocesses. Each is fast
// alone, but under a full parallel suite run they exceed the 5s default and time
// out. The other e2e suites in this repo raise the limit per test (20000 in
// merge-driver-e2e.test.ts); this file does it once since every test spawns.
vi.setConfig({ testTimeout: 30_000 });

const cliPath = CLI_PATH;

// ISS-1091: isolated HOME/CODEX_HOME/STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME
// (test/helpers/e2e-cli.ts) so these subprocesses can never touch the real
// developer machine's skills/config/hooks/cache, and never race a concurrent
// CLI version's skill-marker refresh onto a captured stream.
let fixture: E2ECliFixture;
beforeAll(async () => {
  fixture = await E2ECliFixture.create();
});
afterAll(async () => {
  await fixture.cleanup();
});

// Returns stdout only (fix direction d) -- never mixes stderr into `out`, on
// either the success or failure path, so a housekeeping notice on stderr can
// never corrupt a JSON envelope this file parses out of `out`.
function run(cwd: string, ...args: string[]): { code: number; out: string } {
  const result = runE2ECli(fixture, args, { cwd });
  return { code: result.status ?? 1, out: result.stdout };
}

/** Parses the JSON error envelope, asserting the output IS exactly one envelope. */
function errorEnvelope(out: string): { code: string; message: string } {
  const parsed = JSON.parse(out) as {
    version?: number;
    error?: { code: string; message: string };
  };
  expect(parsed, `expected an object envelope, got: ${out}`).toBeTypeOf("object");
  expect(parsed, `expected an object envelope, got: ${out}`).not.toBeNull();
  expect(parsed.version, `envelope version, got: ${out}`).toBe(1);
  expect(parsed.error, `expected an error envelope, got: ${out}`).toBeDefined();
  return parsed.error!;
}

/** Asserts a rejection: nonzero exit AND an invalid_input envelope. */
function expectRejected(res: { code: number; out: string }, messagePart?: string): void {
  expect(res.code, `expected a nonzero exit, got 0 with: ${res.out}`).not.toBe(0);
  const err = errorEnvelope(res.out);
  expect(err.code).toBe("invalid_input");
  if (messagePart !== undefined) expect(err.message).toContain(messagePart);
}

function newProject(prefix: string, type: "npm" | "orchestrator" = "npm"): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const init = run(dir, "init", "--name", prefix, "--type", type);
  expect(init.code, init.out).toBe(0);
  return dir;
}

function readNodes(dir: string): Record<string, Record<string, unknown>> {
  const config = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8")) as {
    nodes?: Record<string, Record<string, unknown>>;
  };
  expect(config.nodes, "expected nodes in config.json").toBeDefined();
  return config.nodes!;
}

function readEntities(dir: string, kind: string): Record<string, unknown>[] {
  const entityDir = join(dir, ".story", kind);
  return readdirSync(entityDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(entityDir, f), "utf-8")) as Record<string, unknown>);
}

function byDisplayId(dir: string, kind: string, id: string): Record<string, unknown> {
  const found = readEntities(dir, kind).find((e) => (e.displayId ?? e.id) === id);
  expect(found, `${id} not found in ${kind}`).toBeDefined();
  return found!;
}

beforeAll(() => {
  expect(
    () => readFileSync(cliPath),
    "dist/cli.js is missing. Run `npm run build` before this suite.",
  ).not.toThrow();
});

describe("ISS-886 reported defect: tags", () => {
  it("splits a comma-separated --tags into distinct tags", () => {
    const dir = newProject("iss886-tags");
    // Before the fix this stored ONE tag, "researchcompetitivelandscape":
    // yargs kept the comma, then tag normalization stripped it as an invalid
    // character and concatenated the values.
    expect(run(dir, "note", "create", "--content", "c", "--tags", "research,competitive,landscape").code)
      .toBe(0);
    expect(readEntities(dir, "notes")[0]!.tags).toEqual(["research", "competitive", "landscape"]);
  });

  it("keeps a numeric tag instead of silently dropping it", () => {
    const dir = newProject("iss886-numeric");
    // Before the fix --tags registered as type "array", so yargs parsed 2026 as a
    // NUMBER and tag normalization discarded every non-string. The tag vanished
    // at exit 0.
    expect(run(dir, "note", "create", "--content", "c", "--tags", "2026", "roadmap").code).toBe(0);
    expect(readEntities(dir, "notes")[0]!.tags).toEqual(["2026", "roadmap"]);
  });

  it("rejects a bare --tags on update instead of silently clearing tags", () => {
    const dir = newProject("iss886-bare");
    run(dir, "note", "create", "--content", "c", "--tags", "alpha", "beta");
    // Before the fix this emptied the tag list at exit 0, despite --clear-tags
    // existing for exactly that purpose.
    const res = run(dir, "note", "update", "N-001", "--tags", "--format", "json");
    expectRejected(res, "Use --clear-tags to clear tags.");
    expect(byDisplayId(dir, "notes", "N-001").tags).toEqual(["alpha", "beta"]);
  });

  it("still clears tags through --clear-tags", () => {
    const dir = newProject("iss886-clear");
    run(dir, "note", "create", "--content", "c", "--tags", "alpha");
    expect(run(dir, "note", "update", "N-001", "--clear-tags").code).toBe(0);
    expect(byDisplayId(dir, "notes", "N-001").tags).toEqual([]);
  });

  it("leaves tags untouched when --tags is omitted", () => {
    const dir = newProject("iss886-absent");
    run(dir, "note", "create", "--content", "c", "--tags", "alpha");
    expect(run(dir, "note", "update", "N-001", "--title", "t").code).toBe(0);
    expect(byDisplayId(dir, "notes", "N-001").tags).toEqual(["alpha"]);
  });

  it("applies the same rules to lesson tags", () => {
    const dir = newProject("iss886-lesson");
    expect(
      run(dir, "lesson", "create", "--title", "t", "--content", "c", "--context", "x",
        "--source", "manual", "--tags", "a,b").code,
    ).toBe(0);
    expect(readEntities(dir, "lessons")[0]!.tags).toEqual(["a", "b"]);
  });
});

describe("ISS-886 sweep: other newly comma-enabled options", () => {
  it("splits issue --components and --related-tickets", () => {
    const dir = newProject("iss886-issue");
    run(dir, "ticket", "create", "--title", "a", "--type", "task");
    run(dir, "ticket", "create", "--title", "b", "--type", "task");
    // --components stored one bogus value "cli,mcp" before the fix;
    // --related-tickets failed with not_found on the literal "T-001,T-002".
    const res = run(dir, "issue", "create", "--title", "i", "--severity", "low",
      "--impact", "x", "--components", "cli,mcp", "--related-tickets", "T-001,T-002");
    expect(res.code, res.out).toBe(0);
    const issue = readEntities(dir, "issues")[0]!;
    expect(issue.components).toEqual(["cli", "mcp"]);
    expect(issue.relatedTickets).toEqual(["T-001", "T-002"]);
  });

  it("splits ticket --blocked-by", () => {
    const dir = newProject("iss886-blocked");
    run(dir, "ticket", "create", "--title", "a", "--type", "task");
    run(dir, "ticket", "create", "--title", "b", "--type", "task");
    const res = run(dir, "ticket", "create", "--title", "c", "--type", "task",
      "--blocked-by", "T-001,T-002");
    expect(res.code, res.out).toBe(0);
    expect(byDisplayId(dir, "tickets", "T-003").blockedBy).toEqual(["T-001", "T-002"]);
  });

  it("splits dispatch ids into two resolved rows", () => {
    const dir = newProject("iss886-dispatch");
    run(dir, "ticket", "create", "--title", "a", "--type", "task");
    run(dir, "ticket", "create", "--title", "b", "--type", "task");
    const res = run(dir, "dispatch", "T-001,T-002", "--dry-run");
    // Asserting on resolution, not substring presence: before the fix the literal
    // "T-001,T-002" was reported as ONE skipped invalid ID, and that text still
    // contains both id substrings.
    expect(res.out).not.toContain("Skipped");
    expect(res.out).toContain("**Agents:** 2");
    expect(res.out).toMatch(/\|\s*1\s*\|\s*T-001\s*\|/);
    expect(res.out).toMatch(/\|\s*2\s*\|\s*T-002\s*\|/);
  });
});

describe("ISS-886: a separator-only value must not silently clear a field", () => {
  it("rejects --blocked-by ',' and leaves the existing value intact", () => {
    // The point of this case is the SURVIVAL of prior state, so the prior state
    // has to be real. A ticket cannot block itself, so establishing it on T-001
    // fails and leaves blockedBy at [], where a silent clear is indistinguishable
    // from success. Two tickets are required.
    const dir = newProject("iss886-sep-blocked");
    expect(run(dir, "ticket", "create", "--title", "a", "--type", "task").code).toBe(0);
    expect(run(dir, "ticket", "create", "--title", "b", "--type", "task").code).toBe(0);
    const setup = run(dir, "ticket", "update", "T-002", "--blocked-by", "T-001", "--format", "json");
    expect(setup.code, setup.out).toBe(0);
    expect(byDisplayId(dir, "tickets", "T-002").blockedBy).toEqual(["T-001"]);

    // Today this is a loud not_found on the literal ",". Turning it into an empty
    // list would silently CLEAR blockedBy, the exact failure class ISS-886 exists
    // to remove.
    const res = run(dir, "ticket", "update", "T-002", "--blocked-by", ",", "--format", "json");
    expectRejected(res, "contains separators but no values");
    expect(byDisplayId(dir, "tickets", "T-002").blockedBy).toEqual(["T-001"]);
  });

  it("rejects --components ',,' and leaves the existing value intact", () => {
    const dir = newProject("iss886-sep-components");
    const create = run(dir, "issue", "create", "--title", "i", "--severity", "low",
      "--impact", "x", "--components", "cli", "--format", "json");
    expect(create.code, create.out).toBe(0);
    expect(byDisplayId(dir, "issues", "ISS-001").components).toEqual(["cli"]);

    const res = run(dir, "issue", "update", "ISS-001", "--components", ",,", "--format", "json");
    expectRejected(res, "contains separators but no values");
    expect(byDisplayId(dir, "issues", "ISS-001").components).toEqual(["cli"]);
  });

  it("rejects --tags ',' on create, so no entity is written at all", () => {
    const dir = newProject("iss886-sep-tags");
    const res = run(dir, "note", "create", "--content", "c", "--tags", ",", "--format", "json");
    expectRejected(res, "contains separators but no values");
    expect(readEntities(dir, "notes")).toEqual([]);
  });

  it("rejects a stray separator even alongside a valid value", () => {
    const dir = newProject("iss886-sep-mixed");
    const res = run(dir, "issue", "create", "--title", "i", "--severity", "low",
      "--impact", "x", "--components", "cli", ",", "--format", "json");
    expectRejected(res, "contains separators but no values");
    expect(readEntities(dir, "issues")).toEqual([]);
  });
});

describe("ISS-886 regression guards: behavior that must NOT change", () => {
  it("keeps --location as one value when the path contains a comma", () => {
    const dir = newProject("iss886-location");
    const res = run(dir, "issue", "create", "--title", "i", "--severity", "low",
      "--impact", "x", "--location", "src/a,b.ts:10");
    expect(res.code, res.out).toBe(0);
    expect(readEntities(dir, "issues")[0]!.location).toEqual(["src/a,b.ts:10"]);
  });

  it("still parses a comma-bearing --source-ref JSON payload", () => {
    const dir = newProject("iss886-sourceref");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\n", "utf-8");
    const res = run(dir, "issue", "create", "--title", "i", "--severity", "low", "--impact", "x",
      "--source-ref", '{"path":"src/a.ts","startLine":1,"endLine":2}');
    expect(res.code, res.out).toBe(0);
    expect((readEntities(dir, "issues")[0]!.sourceRefs as unknown[]).length).toBe(1);
  });

  it("still fails loudly on a blank --source-ref rather than dropping it", () => {
    // empty: "preserve" exists for this: dropping the blank would silence a real
    // error and shift the 1-based index in every later message.
    const dir = newProject("iss886-blank-ref");
    const res = run(dir, "issue", "create", "--title", "i", "--severity", "low",
      "--impact", "x", "--source-ref", " ", "--format", "json");
    // Nonzero exit included: an error envelope emitted at exit 0 is exactly the
    // silent-failure shape ISS-886 is about.
    expectRejected(res, "value 1");
    expect(readEntities(dir, "issues")).toEqual([]);
  });

  it("still splits --cross-node-blocked-by, the documented comma syntax", () => {
    // Documented at src/skill/federation-setup.md:167 and :201.
    const dir = newProject("iss886-crossnode");
    run(dir, "ticket", "create", "--title", "a", "--type", "task");
    const res = run(dir, "ticket", "update", "T-001",
      "--cross-node-blocked-by", "engine:T-001,client:T-005");
    expect(res.code, res.out).toBe(0);
    expect(byDisplayId(dir, "tickets", "T-001").crossNodeBlockedBy)
      .toEqual(["engine:T-001", "client:T-005"]);
  });

  it("still removes crossNodeBlockedBy entirely on a bare flag, not storing []", () => {
    const dir = newProject("iss886-crossnode-clear");
    expect(run(dir, "ticket", "create", "--title", "a", "--type", "task").code).toBe(0);
    // The setup must be verified: if the non-comma value failed to persist, the
    // field would already be absent and the removal assertion below would pass
    // without anything having been removed.
    const setup = run(dir, "ticket", "update", "T-001", "--cross-node-blocked-by", "engine:T-001");
    expect(setup.code, setup.out).toBe(0);
    expect(byDisplayId(dir, "tickets", "T-001").crossNodeBlockedBy).toEqual(["engine:T-001"]);

    expect(run(dir, "ticket", "update", "T-001", "--cross-node-blocked-by").code).toBe(0);
    expect("crossNodeBlockedBy" in byDisplayId(dir, "tickets", "T-001")).toBe(false);
  });

  it("still reports a blank or separator-only dispatch id as invalid", () => {
    // empty: "preserve" keeps these from collapsing to [] and silently taking
    // the no-ID branch. Asserted structurally rather than on the word "Skipped",
    // which could appear on some other output path: the invalid-ID reason and a
    // zero agent count together pin which branch ran.
    const dir = newProject("iss886-dispatch-blank");
    expect(run(dir, "ticket", "create", "--title", "a", "--type", "task").code).toBe(0);
    for (const arg of ["", ",", ",,"]) {
      const res = run(dir, "dispatch", arg, "--dry-run");
      expect(res.out, `dispatch "${arg}"`).toMatch(/\*\*Skipped:\*\*.*\(invalid ID format\)/);
      expect(res.out, `dispatch "${arg}"`).toContain("**Agents:** 0");
    }
    // An ABSENT positional must not be reported as an invalid ID: yargs fires
    // coerce with [] there, which is why the spec cannot demand a value. It takes
    // the no-ID branch instead, which dispatches the open ticket (ISS-1112: a new
    // ticket is no longer invisible to recommendations).
    const absent = run(dir, "dispatch", "--dry-run");
    expect(absent.out).not.toMatch(/\*\*Skipped:\*\*/);
    expect(absent.out).toContain("**Agents:** 1");
    expect(absent.out).toContain("| 1 | T-001 | ticket |");
  });
});

/**
 * Coverage matrix: one row per array registration in src/cli.
 *
 * The prohibition gate proves nothing registers an array value outside the policy
 * wrappers. This proves the other direction: every registration that DOES go
 * through them is exercised end to end at least once. The completeness test below
 * compares these keys against the registrations discovered in the source, so a
 * newly added array option fails this suite until it has a row.
 */
interface Coverage {
  /** Registration key, matching registrationKey() from the inventory module. */
  key: string;
  /** Project type for `init`. Node commands require an orchestrator project. */
  type?: "npm" | "orchestrator";
  /** Exercises the registration and asserts the parsed value landed correctly. */
  check: (dir: string) => void;
}

function seedTickets(dir: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const res = run(dir, "ticket", "create", "--title", `t${i}`, "--type", "task");
    expect(res.code, res.out).toBe(0);
  }
}

function seedIssue(dir: string): void {
  const res = run(dir, "issue", "create", "--title", "i", "--severity", "low", "--impact", "x");
  expect(res.code, res.out).toBe(0);
}

function seedFile(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\n", "utf-8");
}

const SOURCE_REF = '{"path":"src/a.ts","startLine":1,"endLine":2}';

function seedNodes(dir: string, ...names: string[]): void {
  for (const name of names) {
    mkdirSync(join(dir, name), { recursive: true });
    const res = run(dir, "node", "add", name, "--path", `./${name}`);
    expect(res.code, res.out).toBe(0);
  }
}

/**
 * T-523: a project that `capability add` can actually write into. The
 * checkpoint is stamped at HEAD, so these rows need a real commit, not just a
 * `.story/` directory. Standalone temp repo (ISS-1220), never a linked
 * worktree: a fixture's git config writes reach the shared `.git/config`.
 */
function gitify(dir: string): void {
  mkdirSync(join(dir, "src", "core"), { recursive: true });
  writeFileSync(join(dir, "src", "core", "thing.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "core", "other.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "src", "core", "a,b.ts"), "export const c = 3;\n");
  // The fixture helper scrubs the environment, so a developer's global git
  // config (signing, hooks, templates) cannot change what these rows see.
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.invalid"],
    ["config", "user.name", "T"],
    ["add", "-A"],
    ["commit", "-q", "-m", "base"],
  ]) fixtureGit(dir, args);
}

function capabilities(dir: string): Array<Record<string, never> & {
  id: string; entryPoints: string[]; surfaces: Record<string, string[]>;
  rulings?: string[]; items?: string[]; terms?: string[];
}> {
  const raw = readFileSync(join(dir, ".story", "capabilities.json"), "utf-8");
  return (JSON.parse(raw) as { capabilities: never[] }).capabilities;
}

/** `capability add` with the five required flags plus whatever a row is testing. */
/**
 * The id is an explicit parameter rather than something a caller can append,
 * because yargs turns a REPEATED string option into an array: passing
 * `--id cap-other` as an extra produced `id: ["cap-thing", "cap-other"]`,
 * which the schema rejects, and the fixture then failed before the behaviour
 * under test ever ran. The name follows the id because a capability name is
 * unique too (T-529): a second entry reusing one is refused.
 */
function addCapAs(dir: string, id: string, ...extra: string[]): { code: number; out: string } {
  return run(dir, "capability", "add",
    "--id", id, "--name", id === "cap-thing" ? "Thing" : `Thing ${id}`, "--summary", "Does the thing.",
    "--contract", "Returns the thing.", ...extra);
}

function addCap(dir: string, ...extra: string[]): { code: number; out: string } {
  return addCapAs(dir, "cap-thing", ...extra);
}

function terms(dir: string): Array<Record<string, never> & {
  id: string; term: string; aliases?: string[]; capabilities?: string[]; rulings?: string[];
}> {
  const raw = readFileSync(join(dir, ".story", "glossary.json"), "utf-8");
  return (JSON.parse(raw) as { terms: never[] }).terms;
}

/** `term add` with the three required flags plus whatever a row is testing. */
function addTerm(dir: string, ...extra: string[]): { code: number; out: string } {
  return run(dir, "term", "add",
    "--id", "term-pen", "--term", "pen",
    "--definition", "The session model that owns the judgement gates.", ...extra);
}

/**
 * T-529: a glossary as a merge leaves it, two entries claiming one word and
 * the collision recorded, so `resolve glossary --invariant 1` has something
 * to resolve. The word carries a comma and the alias surrounding spaces: both
 * resolve flags take their values literally, never split and never trimmed.
 */
function seedWordCollision(dir: string): void {
  const at = "2026-09-20T10:00:00.000Z";
  const doc = {
    version: 1,
    terms: [
      { id: "term-pen", term: "pen, tier", definition: "The session model.", updatedAt: at },
      { id: "term-mgr", term: "manager", aliases: [" Pen, Tier "], definition: "The one who files.", updatedAt: at },
    ],
    _conflicts: [{ fieldPath: "/terms", kind: "invariant", rule: "term-owner", key: "pen, tier", entityIds: ["term-mgr", "term-pen"] }],
  };
  writeFileSync(join(dir, ".story", "glossary.json"), JSON.stringify(doc, null, 2) + "\n");
}

/** T-537: a project with owner checkpoints turned on. */
function enableCheckpoints(dir: string): void {
  const res = run(dir, "checkpoint", "enable");
  expect(res.code, res.out).toBe(0);
}

type CheckpointState = { generation: number; revision: number; digest: string };

/** `checkpoint create` for a decision, read back from its JSON summary. */
function createCheckpoint(dir: string, ...extra: string[]): { id: string; expected: CheckpointState } {
  const res = run(dir, "checkpoint", "create", "--title", "Pick a store", "--owner", "owner",
    "--kind", "decision", "--question", "sqlite or pg?", "--format", "json", ...extra);
  expect(res.code, res.out).toBe(0);
  return (JSON.parse(res.out) as { data: { id: string; expected: CheckpointState } }).data;
}

/** The state a lifecycle change names, as `checkpoint list` prints it. */
function expectedArgs(e: CheckpointState): string[] {
  return ["--generation", String(e.generation), "--revision", String(e.revision), "--digest", e.digest];
}

/** `checkpoint resolve` that also records the response as an owner-direct ruling. */
function resolveWithRuling(dir: string, id: string, expected: CheckpointState, ...extra: string[]): { code: number; out: string } {
  return run(dir, "checkpoint", "resolve", id, ...expectedArgs(expected),
    "--response", "sqlite", "--ruling", "owner-direct", "--client-task-id", "e2e-test-session",
    ...extra, "--format", "json");
}

function evidenceRefs(dir: string, id: string): unknown {
  return (byDisplayId(dir, "tickets", id).ownerCheckpoint as { evidenceRefs?: unknown }).evidenceRefs;
}

const MATRIX: Coverage[] = [
  {
    key: "capability add --entry",
    check: (dir) => {
      gitify(dir);
      const res = addCap(dir, "--entry", "src/core/thing.ts", "--entry", "src/core/other.ts");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.entryPoints).toEqual(["src/core/thing.ts", "src/core/other.ts"]);
      // A comma is legal in a filename, so this flag is LITERAL: splitting it
      // would store two pointers naming nothing, and a wrong entry point can
      // never go stale, so the entry would report `current` forever about a
      // file it is not watching.
      const lit = addCapAs(dir, "cap-comma", "--entry", "src/core/a,b.ts");
      expect(lit.code, lit.out).toBe(0);
      expect(capabilities(dir)[1]!.entryPoints).toEqual(["src/core/a,b.ts"]);
    },
  },
  {
    key: "capability add --cli",
    check: (dir) => {
      gitify(dir);
      const res = addCap(dir, "--entry", "src/core/thing.ts", "--cli", "capability add,capability get");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.cli).toEqual(["capability add", "capability get"]);
    },
  },
  {
    key: "capability add --mcp-tool",
    check: (dir) => {
      gitify(dir);
      const res = addCap(dir, "--entry", "src/core/thing.ts", "--mcp-tool", "storybloq_capability_add,storybloq_capability_get");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.mcp).toEqual(["storybloq_capability_add", "storybloq_capability_get"]);
    },
  },
  {
    key: "capability add --app",
    check: (dir) => {
      gitify(dir);
      const res = addCap(dir, "--entry", "src/core/thing.ts", "--app", "Sidebar,Inspector");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.app).toEqual(["Sidebar", "Inspector"]);
    },
  },
  {
    key: "capability add --surface-file",
    check: (dir) => {
      gitify(dir);
      const res = addCap(dir, "--entry", "src/core/thing.ts", "--surface-file", "REVIEW.md", "--surface-file", "RULES.md");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.files).toEqual(["REVIEW.md", "RULES.md"]);
      // Literal, for the same reason as --entry: this names a tracked file.
      const lit = addCapAs(dir, "cap-comma", "--entry", "src/core/thing.ts", "--surface-file", "a,b.md");
      expect(lit.code, lit.out).toBe(0);
      expect(capabilities(dir)[1]!.surfaces.files).toEqual(["a,b.md"]);
    },
  },
  {
    key: "capability add --ruling",
    check: (dir) => {
      gitify(dir);
      const res = addCap(dir, "--entry", "src/core/thing.ts", "--ruling", "r-aaaaaaaaaaaaaaaa,r-bbbbbbbbbbbbbbbb");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.rulings).toEqual(["r-aaaaaaaaaaaaaaaa", "r-bbbbbbbbbbbbbbbb"]);
    },
  },
  {
    key: "capability add --item",
    check: (dir) => {
      gitify(dir);
      const res = addCap(dir, "--entry", "src/core/thing.ts", "--item", "T-001,T-002");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.items).toEqual(["T-001", "T-002"]);
    },
  },
  {
    key: "capability add --term",
    check: (dir) => {
      gitify(dir);
      const res = addCap(dir, "--entry", "src/core/thing.ts", "--term", "term-pen,term-hands");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.terms).toEqual(["term-pen", "term-hands"]);
    },
  },
  {
    key: "capability update --entry",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "update", "cap-thing", "--entry", "src/core/thing.ts", "--entry", "src/core/other.ts");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.entryPoints).toEqual(["src/core/thing.ts", "src/core/other.ts"]);
      const lit = run(dir, "capability", "update", "cap-thing", "--entry", "src/core/a,b.ts");
      expect(lit.code, lit.out).toBe(0);
      expect(capabilities(dir)[0]!.entryPoints).toEqual(["src/core/a,b.ts"]);
    },
  },
  {
    key: "capability update --cli",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "update", "cap-thing", "--cli", "capability add,capability get");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.cli).toEqual(["capability add", "capability get"]);
    },
  },
  {
    key: "capability update --mcp-tool",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "update", "cap-thing", "--mcp-tool", "storybloq_capability_add,storybloq_capability_get");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.mcp).toEqual(["storybloq_capability_add", "storybloq_capability_get"]);
    },
  },
  {
    key: "capability update --app",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "update", "cap-thing", "--app", "Sidebar,Inspector");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.app).toEqual(["Sidebar", "Inspector"]);
    },
  },
  {
    key: "capability update --surface-file",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "update", "cap-thing", "--surface-file", "REVIEW.md", "--surface-file", "RULES.md");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.files).toEqual(["REVIEW.md", "RULES.md"]);
      const lit = run(dir, "capability", "update", "cap-thing", "--surface-file", "a,b.md");
      expect(lit.code, lit.out).toBe(0);
      expect(capabilities(dir)[0]!.surfaces.files).toEqual(["a,b.md"]);
    },
  },
  {
    key: "capability update --ruling",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "update", "cap-thing", "--ruling", "r-aaaaaaaaaaaaaaaa,r-bbbbbbbbbbbbbbbb");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.rulings).toEqual(["r-aaaaaaaaaaaaaaaa", "r-bbbbbbbbbbbbbbbb"]);
    },
  },
  {
    key: "capability update --item",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "update", "cap-thing", "--item", "T-001,T-002");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.items).toEqual(["T-001", "T-002"]);
    },
  },
  {
    key: "capability update --term",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "update", "cap-thing", "--term", "term-pen,term-hands");
      expect(res.code, res.out).toBe(0);
      expect(capabilities(dir)[0]!.terms).toEqual(["term-pen", "term-hands"]);
    },
  },
  {
    key: "capability check --stamp",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      expect(addCapAs(dir, "cap-other", "--entry", "src/core/other.ts").code, "seed").toBe(0);
      const before = capabilities(dir).map((c) => (c as unknown as { checkedAt: { sha: string } }).checkedAt.sha);
      writeFileSync(join(dir, "src", "core", "thing.ts"), "export const a = 9;\n");
      writeFileSync(join(dir, "src", "core", "other.ts"), "export const b = 9;\n");
      fixtureGit(dir, ["commit", "-qam", "change"]);
      const res = run(dir, "capability", "check", "--stamp", "cap-thing,cap-other");
      expect(res.code, res.out).toBe(0);
      const after = capabilities(dir).map((c) => (c as unknown as { checkedAt: { sha: string } }).checkedAt.sha);
      // Both ids in one comma-joined value, so a failure to split would stamp
      // neither: the whole string is not an id.
      expect(after[0]).not.toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
    },
  },
  {
    key: "capability match --path",
    check: (dir) => {
      gitify(dir);
      expect(addCap(dir, "--entry", "src/core/thing.ts").code, "seed").toBe(0);
      expect(addCapAs(dir, "cap-other", "--entry", "src/core/other.ts").code, "seed").toBe(0);
      const res = run(dir, "capability", "match", "--path", "src/core/thing.ts", "--path", "src/core/other.ts", "--format", "json");
      expect(res.code, res.out).toBe(0);
      const ids = (JSON.parse(res.out) as { data: { matches: Array<{ id: string }> } }).data.matches.map((m) => m.id);
      expect(ids.sort()).toEqual(["cap-other", "cap-thing"]);
      // Literal: a query for a path containing a comma must ask about that one
      // path. An entry sits AT that path, so only the literal reading finds
      // it: split, the query becomes `src/core/a` and `b.ts`, and neither is,
      // contains or sits under `src/core/a,b.ts`.
      expect(addCapAs(dir, "cap-comma", "--entry", "src/core/a,b.ts").code, "seed").toBe(0);
      const lit = run(dir, "capability", "match", "--path", "src/core/a,b.ts", "--format", "json");
      expect(lit.code, lit.out).toBe(0);
      const litIds = (JSON.parse(lit.out) as { data: { matches: Array<{ id: string }> } }).data.matches.map((m) => m.id);
      expect(litIds).toEqual(["cap-comma"]);
    },
  },
  {
    key: "term add --alias",
    check: (dir) => {
      const res = addTerm(dir, "--alias", "pen tier", "--alias", "the pen, as filed");
      expect(res.code, res.out).toBe(0);
      // An alias is a WORD OR SHORT PHRASE a reader might write, and a phrase can
      // contain a comma. Splitting it would mint an alias nobody wrote, which the
      // matcher would then claim this entry owns.
      expect(terms(dir)[0]!.aliases).toEqual(["pen tier", "the pen, as filed"]);
    },
  },
  {
    key: "term add --capability",
    check: (dir) => {
      const res = addTerm(dir, "--capability", "cap-orchestrate,cap-review");
      expect(res.code, res.out).toBe(0);
      expect(terms(dir)[0]!.capabilities).toEqual(["cap-orchestrate", "cap-review"]);
    },
  },
  {
    key: "term add --ruling",
    check: (dir) => {
      const res = addTerm(dir, "--ruling", "r-aaaaaaaaaaaaaaaa,r-bbbbbbbbbbbbbbbb");
      expect(res.code, res.out).toBe(0);
      expect(terms(dir)[0]!.rulings).toEqual(["r-aaaaaaaaaaaaaaaa", "r-bbbbbbbbbbbbbbbb"]);
    },
  },
  {
    key: "term update --alias",
    check: (dir) => {
      expect(addTerm(dir, "--alias", "pen tier").code, "seed").toBe(0);
      const res = run(dir, "term", "update", "term-pen", "--alias", "the pen, as filed");
      expect(res.code, res.out).toBe(0);
      // The supplied list REPLACES the stored one, so the seeded alias is gone
      // and the comma survived: one alias, not two, and not three.
      expect(terms(dir)[0]!.aliases).toEqual(["the pen, as filed"]);
    },
  },
  {
    key: "term update --capability",
    check: (dir) => {
      expect(addTerm(dir, "--capability", "cap-old").code, "seed").toBe(0);
      const res = run(dir, "term", "update", "term-pen", "--capability", "cap-orchestrate,cap-review");
      expect(res.code, res.out).toBe(0);
      expect(terms(dir)[0]!.capabilities).toEqual(["cap-orchestrate", "cap-review"]);
    },
  },
  {
    key: "term update --ruling",
    check: (dir) => {
      expect(addTerm(dir, "--ruling", "r-cccccccccccccccc").code, "seed").toBe(0);
      const res = run(dir, "term", "update", "term-pen", "--ruling", "r-aaaaaaaaaaaaaaaa,r-bbbbbbbbbbbbbbbb");
      expect(res.code, res.out).toBe(0);
      expect(terms(dir)[0]!.rulings).toEqual(["r-aaaaaaaaaaaaaaaa", "r-bbbbbbbbbbbbbbbb"]);
    },
  },
  {
    key: "resolve --rename",
    check: (dir) => {
      seedWordCollision(dir);
      const res = run(dir, "resolve", "glossary", "--invariant", "1", "--rename", "term-pen", " pen, the tier ");
      expect(res.code, res.out).toBe(0);
      // Two values, the second whole and untrimmed: a split would make three
      // and be refused, and a trim would store a different term.
      expect(terms(dir).find((t) => t.id === "term-pen")!.term).toBe(" pen, the tier ");
    },
  },
  {
    key: "resolve --drop-alias",
    check: (dir) => {
      seedWordCollision(dir);
      // The alias is matched exactly: a trimmed value would not be an alias
      // of term-mgr, and the resolution would be refused.
      const res = run(dir, "resolve", "glossary", "--invariant", "1", "--drop-alias", "term-mgr", " Pen, Tier ");
      expect(res.code, res.out).toBe(0);
      expect(terms(dir).find((t) => t.id === "term-mgr")!.aliases).toBeUndefined();
    },
  },
  {
    key: "ticket create --blocked-by",
    check: (dir) => {
      seedTickets(dir, 2);
      const res = run(dir, "ticket", "create", "--title", "c", "--type", "task",
        "--blocked-by", "T-001,T-002");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "tickets", "T-003").blockedBy).toEqual(["T-001", "T-002"]);
    },
  },
  {
    key: "ticket update --blocked-by",
    check: (dir) => {
      seedTickets(dir, 3);
      const res = run(dir, "ticket", "update", "T-003", "--blocked-by", "T-001,T-002");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "tickets", "T-003").blockedBy).toEqual(["T-001", "T-002"]);
    },
  },
  {
    key: "ticket update --cross-node-blocked-by",
    check: (dir) => {
      // Comma splitting here predates ISS-886 and is documented at
      // src/skill/federation-setup.md:167 and :201, so this is a regression guard.
      seedTickets(dir, 1);
      const res = run(dir, "ticket", "update", "T-001",
        "--cross-node-blocked-by", "engine:T-001, client:T-005");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "tickets", "T-001").crossNodeBlockedBy)
        .toEqual(["engine:T-001", "client:T-005"]);
    },
  },
  {
    key: "issue create --components",
    check: (dir) => {
      const res = run(dir, "issue", "create", "--title", "i", "--severity", "low",
        "--impact", "x", "--components", "cli,mcp");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "issues", "ISS-001").components).toEqual(["cli", "mcp"]);
    },
  },
  {
    key: "issue create --related-tickets",
    check: (dir) => {
      seedTickets(dir, 2);
      const res = run(dir, "issue", "create", "--title", "i", "--severity", "low",
        "--impact", "x", "--related-tickets", "T-001,T-002");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "issues", "ISS-001").relatedTickets).toEqual(["T-001", "T-002"]);
    },
  },
  {
    key: "issue create --location",
    check: (dir) => {
      const res = run(dir, "issue", "create", "--title", "i", "--severity", "low",
        "--impact", "x", "--location", "src/a,b.ts:10");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "issues", "ISS-001").location).toEqual(["src/a,b.ts:10"]);
    },
  },
  {
    key: "issue create --source-ref",
    check: (dir) => {
      seedFile(dir);
      const res = run(dir, "issue", "create", "--title", "i", "--severity", "low",
        "--impact", "x", "--source-ref", SOURCE_REF);
      expect(res.code, res.out).toBe(0);
      const refs = byDisplayId(dir, "issues", "ISS-001").sourceRefs as { path: string }[];
      expect(refs).toHaveLength(1);
      expect(refs[0]!.path).toBe("src/a.ts");
    },
  },
  {
    key: "issue update --components",
    check: (dir) => {
      seedIssue(dir);
      const res = run(dir, "issue", "update", "ISS-001", "--components", "cli, mcp");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "issues", "ISS-001").components).toEqual(["cli", "mcp"]);
    },
  },
  {
    key: "issue update --related-tickets",
    check: (dir) => {
      seedTickets(dir, 2);
      seedIssue(dir);
      const res = run(dir, "issue", "update", "ISS-001", "--related-tickets", "T-001,T-002");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "issues", "ISS-001").relatedTickets).toEqual(["T-001", "T-002"]);
    },
  },
  {
    key: "issue update --location",
    check: (dir) => {
      seedIssue(dir);
      const res = run(dir, "issue", "update", "ISS-001", "--location", "src/a,b.ts:10");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "issues", "ISS-001").location).toEqual(["src/a,b.ts:10"]);
    },
  },
  {
    key: "issue update --source-ref",
    check: (dir) => {
      seedFile(dir);
      seedIssue(dir);
      const res = run(dir, "issue", "update", "ISS-001", "--source-ref", SOURCE_REF);
      expect(res.code, res.out).toBe(0);
      const refs = byDisplayId(dir, "issues", "ISS-001").sourceRefs as { path: string }[];
      expect(refs).toHaveLength(1);
      expect(refs[0]!.path).toBe("src/a.ts");
    },
  },
  {
    key: "note create --tags",
    check: (dir) => {
      const res = run(dir, "note", "create", "--content", "c", "--tags", "a,b");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "notes", "N-001").tags).toEqual(["a", "b"]);
    },
  },
  {
    key: "note update --tags",
    check: (dir) => {
      expect(run(dir, "note", "create", "--content", "c", "--tags", "old").code).toBe(0);
      expect(run(dir, "note", "update", "N-001", "--tags", "a,b").code).toBe(0);
      expect(byDisplayId(dir, "notes", "N-001").tags).toEqual(["a", "b"]);
      // requireValue is set only on the update registrations, where --clear-tags
      // gives the bare flag a replacement.
      expectRejected(run(dir, "note", "update", "N-001", "--tags", "--format", "json"));
      expect(byDisplayId(dir, "notes", "N-001").tags).toEqual(["a", "b"]);
    },
  },
  {
    key: "lesson create --tags",
    check: (dir) => {
      const res = run(dir, "lesson", "create", "--title", "t", "--content", "c",
        "--context", "x", "--source", "manual", "--tags", "a,b");
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "lessons", "L-001").tags).toEqual(["a", "b"]);
    },
  },
  {
    key: "lesson digest --select",
    check: (dir) => {
      expect(run(dir, "lesson", "create", "--title", "Matches", "--content", "c",
        "--context", "x", "--source", "manual", "--tags", "cli-status").code).toBe(0);
      expect(run(dir, "lesson", "create", "--title", "Excluded", "--content", "c",
        "--context", "x", "--source", "manual", "--tags", "other").code).toBe(0);
      const res = run(dir, "lesson", "digest", "--select", "component:cli-status", "--format", "json");
      expect(res.code, res.out).toBe(0);
      const parsed = JSON.parse(res.out) as { data: { digest: string } };
      expect(parsed.data.digest).toContain("Matches");
      expect(parsed.data.digest).not.toContain("Excluded");
      expectRejected(run(dir, "lesson", "digest", "--select", "bogus:x", "--format", "json"));
    },
  },
  {
    key: "lesson update --tags",
    check: (dir) => {
      expect(run(dir, "lesson", "create", "--title", "t", "--content", "c",
        "--context", "x", "--source", "manual", "--tags", "old").code).toBe(0);
      expect(run(dir, "lesson", "update", "L-001", "--tags", "a,b").code).toBe(0);
      expect(byDisplayId(dir, "lessons", "L-001").tags).toEqual(["a", "b"]);
      expectRejected(run(dir, "lesson", "update", "L-001", "--tags", "--format", "json"));
      expect(byDisplayId(dir, "lessons", "L-001").tags).toEqual(["a", "b"]);
    },
  },
  {
    key: "dispatch [ids]",
    check: (dir) => {
      seedTickets(dir, 2);
      const res = run(dir, "dispatch", "T-001,T-002", "--dry-run");
      // Asserting on resolution, not substring presence: before the fix the
      // literal "T-001,T-002" was reported as ONE skipped invalid ID, and that
      // text still contains both id substrings.
      expect(res.out).not.toContain("Skipped");
      expect(res.out).toContain("**Agents:** 2");
      expect(res.out).toMatch(/\|\s*1\s*\|\s*T-001\s*\|/);
      expect(res.out).toMatch(/\|\s*2\s*\|\s*T-002\s*\|/);
    },
  },
  {
    key: "node add --depends-on",
    type: "orchestrator",
    check: (dir) => {
      seedNodes(dir, "engine", "other");
      mkdirSync(join(dir, "client"), { recursive: true });
      const res = run(dir, "node", "add", "client", "--path", "./client",
        "--depends-on", "engine, other");
      expect(res.code, res.out).toBe(0);
      expect(readNodes(dir).client!.dependsOn).toEqual(["engine", "other"]);
    },
  },
  {
    key: "node add --link",
    type: "orchestrator",
    check: (dir) => {
      seedNodes(dir, "engine");
      mkdirSync(join(dir, "client"), { recursive: true });
      // comma: "literal" here: a via description is free text, so splitting it
      // would corrupt the link rather than produce two links.
      const res = run(dir, "node", "add", "client", "--path", "./client",
        "--link", "engine:calls A, then B");
      expect(res.code, res.out).toBe(0);
      expect(readNodes(dir).client!.links).toEqual([{ to: "engine", via: "calls A, then B" }]);
    },
  },
  {
    key: "node update --depends-on",
    type: "orchestrator",
    check: (dir) => {
      seedNodes(dir, "engine", "other", "client");
      const res = run(dir, "node", "update", "client", "--depends-on", "engine, other");
      expect(res.code, res.out).toBe(0);
      expect(readNodes(dir).client!.dependsOn).toEqual(["engine", "other"]);
    },
  },
  {
    key: "node update --link",
    type: "orchestrator",
    check: (dir) => {
      seedNodes(dir, "engine", "client");
      const res = run(dir, "node", "update", "client", "--link", "engine:calls A, then B");
      expect(res.code, res.out).toBe(0);
      expect(readNodes(dir).client!.links).toEqual([{ to: "engine", via: "calls A, then B" }]);
    },
  },
  {
    key: "bus send --file",
    check: (dir) => {
      const init = run(dir, "bus", "init");
      expect(init.code, init.out).toBe(0);
      // --surface is explicit because the test env deliberately clears client
      // identity, so process-ancestry detection cannot resolve it.
      //
      // ISS-1091 discovery: `bus setup` with the default --delivery live
      // preflights that the client's base Claude/Codex hooks are already
      // registered (src/cli/commands/bus.ts:772-799) -- against a real
      // developer HOME this always passed silently because a real,
      // long-ago `storybloq setup` had globally installed those hooks, an
      // undeclared dependency on real machine state that genuine HOME
      // isolation exposes (exactly the defect class this run exists to
      // find). This test is a registration-coverage check for --file's
      // comma handling, not a hook-delivery test, so --delivery poll
      // declares its true dependency surface instead of dragging hook
      // installation into its scaffolding.
      const first = run(dir, "bus", "setup", "--client", "claude", "--task-id", "task-a",
        "--surface", "claude_cli", "--delivery", "poll");
      expect(first.code, first.out).toBe(0);
      const second = run(dir, "bus", "setup", "--client", "codex", "--task-id", "task-b",
        "--surface", "codex_cli", "--delivery", "poll");
      expect(second.code, second.out).toBe(0);
      seedTickets(dir, 1);
      // comma: "literal": a referenced path may legitimately contain a comma, and
      // splitting it would turn one real path into two nonexistent ones.
      const send = run(dir, "bus", "send", "--client", "claude", "--task-id", "task-a",
        "--kind", "status", "--thread-kind", "coordination", "--body", "b",
        "--idempotency-key", "k1", "--ticket", "T-001",
        "--file", "reports/a,b.json", "--format", "json");
      expect(send.code, send.out).toBe(0);

      const poll = run(dir, "bus", "poll", "--client", "codex", "--task-id", "task-b",
        "--format", "json");
      expect(poll.code, poll.out).toBe(0);
      const parsed = JSON.parse(poll.out) as {
        data: { messages: { message: { refs: { files?: string[] } } }[] };
      };
      expect(parsed.data.messages).toHaveLength(1);
      expect(parsed.data.messages[0]!.message.refs.files).toEqual(["reports/a,b.json"]);
    },
  },
  {
    key: "arrangement create --bounds",
    check: (dir) => {
      seedTickets(dir, 2);
      const res = run(dir, "arrangement", "create",
        "--bounds", "T-001,T-002",
        "--party", "role=pen,client=claude,identityAnchor=pen-1",
        "--party", "role=worker,client=claude,identityAnchor=worker-1",
        "--unreachability-irreversible", "hold");
      expect(res.code, res.out).toBe(0);
      expect(readEntities(dir, "arrangements")[0]!.bounds).toEqual(["T-001", "T-002"]);
    },
  },
  {
    key: "duet spawn --bounds",
    check: (dir) => {
      seedTickets(dir, 2);
      // --print creates no arrangement and writes nothing (T-530 D3); the split
      // list still has to reach the handler, which echoes it in the dry run.
      const res = run(dir, "duet", "spawn", "--name", "w", "--pen", "p", "--print",
        "--pen-task-id", "11111111-2222-4333-8444-555555555555",
        "--bounds", "T-001,T-002");
      expect(res.code, res.out).toBe(0);
      expect(res.out).toContain("Bounds: T-001, T-002");
      expect(res.out).toContain("no arrangement created, no files written");
    },
  },
  {
    key: "arrangement create --party",
    check: (dir) => {
      seedTickets(dir, 1);
      // comma: "literal" here: it is the field separator WITHIN one
      // --party value, so a "split" policy would shred each entry into
      // unparsable fragments and this command would fail outright.
      const res = run(dir, "arrangement", "create",
        "--bounds", "T-001",
        "--party", "role=pen,client=claude,identityAnchor=pen-1",
        "--party", "role=worker,client=codex,identityAnchor=worker-1",
        "--unreachability-irreversible", "hold");
      expect(res.code, res.out).toBe(0);
      expect(readEntities(dir, "arrangements")[0]!.parties).toEqual([
        { role: "pen", client: "claude", identityAnchor: "pen-1" },
        { role: "worker", client: "codex", identityAnchor: "worker-1" },
      ]);
    },
  },
  {
    key: "ticket create --cites-ruling",
    check: (dir) => {
      const ruling = run(dir, "ruling", "create", "--text", "t", "--attribution", "owner-direct",
        "--date", "2026-08-28", "--client-task-id", "e2e-test-session", "--format", "json");
      expect(ruling.code, ruling.out).toBe(0);
      const rulingId = (JSON.parse(ruling.out) as { data: { id: string } }).data.id;
      const res = run(dir, "ticket", "create", "--title", "t", "--type", "task",
        "--cites-ruling", `${rulingId},${rulingId}`);
      expect(res.code, res.out).toBe(0);
      expect(readEntities(dir, "tickets")[0]!.citesRulings).toEqual([rulingId]);
    },
  },
  {
    key: "ticket update --cites-ruling",
    check: (dir) => {
      const ruling = run(dir, "ruling", "create", "--text", "t", "--attribution", "owner-direct",
        "--date", "2026-08-28", "--client-task-id", "e2e-test-session", "--format", "json");
      const rulingId = (JSON.parse(ruling.out) as { data: { id: string } }).data.id;
      seedTickets(dir, 1);
      const id = (byDisplayId(dir, "tickets", "T-001").id) as string;
      const res = run(dir, "ticket", "update", id, "--cites-ruling", rulingId);
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "tickets", "T-001").citesRulings).toEqual([rulingId]);
    },
  },
  {
    key: "issue create --cites-ruling",
    check: (dir) => {
      const ruling = run(dir, "ruling", "create", "--text", "t", "--attribution", "owner-direct",
        "--date", "2026-08-28", "--client-task-id", "e2e-test-session", "--format", "json");
      const rulingId = (JSON.parse(ruling.out) as { data: { id: string } }).data.id;
      const res = run(dir, "issue", "create", "--title", "i", "--severity", "low", "--impact", "x",
        "--cites-ruling", `${rulingId},${rulingId}`);
      expect(res.code, res.out).toBe(0);
      expect(readEntities(dir, "issues")[0]!.citesRulings).toEqual([rulingId]);
    },
  },
  {
    key: "issue update --cites-ruling",
    check: (dir) => {
      const ruling = run(dir, "ruling", "create", "--text", "t", "--attribution", "owner-direct",
        "--date", "2026-08-28", "--client-task-id", "e2e-test-session", "--format", "json");
      const rulingId = (JSON.parse(ruling.out) as { data: { id: string } }).data.id;
      seedIssue(dir);
      const id = (byDisplayId(dir, "issues", "ISS-001").id) as string;
      const res = run(dir, "issue", "update", id, "--cites-ruling", rulingId);
      expect(res.code, res.out).toBe(0);
      expect(byDisplayId(dir, "issues", "ISS-001").citesRulings).toEqual([rulingId]);
    },
  },
  {
    // T-494: `--cites` binds the new ruling to the items it governs, in the
    // same transaction that writes the ruling. Split-list like every other row
    // here, so a comma-joined value must land as two separate citations.
    key: "ruling create --cites",
    check: (dir) => {
      seedTickets(dir, 1);
      seedIssue(dir);
      const res = run(dir, "ruling", "create",
        "--text", "verbatim text", "--attribution", "owner-direct", "--date", "2026-08-28",
        "--client-task-id", "e2e-test-session",
        "--cites", "T-001,ISS-001", "--format", "json");
      expect(res.code, res.out).toBe(0);
      const rulingId = (JSON.parse(res.out) as { data: { id: string } }).data.id;
      expect(byDisplayId(dir, "tickets", "T-001").citesRulings).toEqual([rulingId]);
      expect(byDisplayId(dir, "issues", "ISS-001").citesRulings).toEqual([rulingId]);
    },
  },
  {
    key: "ruling propose --for",
    check: (dir) => {
      seedTickets(dir, 1);
      seedIssue(dir);
      const res = run(dir, "ruling", "propose",
        "--text", "proposed text", "--attribution", "owner-direct", "--date", "2026-09-22",
        "--client-task-id", "e2e-test-session",
        "--for", "T-001,ISS-001", "--format", "json");
      expect(res.code, res.out).toBe(0);
      expect(readEntities(dir, "rulings")[0]!.proposedFor).toEqual(["T-001", "ISS-001"]);
      // T-522: a proposal binds nothing, so neither item gains a citation before accept.
      expect(readEntities(dir, "tickets")[0]!.citesRulings ?? []).toEqual([]);
    },
  },
  {
    key: "ruling propose --scope-tag",
    check: (dir) => {
      const res = run(dir, "ruling", "propose",
        "--text", "proposed text", "--attribution", "owner-direct", "--date", "2026-09-22",
        "--client-task-id", "e2e-test-session",
        "--scope-tag", "alpha,beta");
      expect(res.code, res.out).toBe(0);
      expect(readEntities(dir, "rulings")[0]!.scopeTags).toEqual(["alpha", "beta"]);
    },
  },
  {
    key: "ruling create --scope-tag",
    check: (dir) => {
      const res = run(dir, "ruling", "create",
        "--text", "verbatim text", "--attribution", "owner-direct", "--date", "2026-08-28",
        "--client-task-id", "e2e-test-session",
        "--scope-tag", "alpha,beta");
      expect(res.code, res.out).toBe(0);
      expect(readEntities(dir, "rulings")[0]!.scopeTags).toEqual(["alpha", "beta"]);
    },
  },
  {
    key: "ruling supersede --scope-tag",
    check: (dir) => {
      const created = run(dir, "ruling", "create",
        "--text", "old", "--attribution", "owner-direct", "--date", "2026-08-27",
        "--client-task-id", "e2e-test-session", "--format", "json");
      expect(created.code, created.out).toBe(0);
      const oldId = (JSON.parse(created.out) as { data: { id: string } }).data.id;
      const res = run(dir, "ruling", "supersede", oldId,
        "--text", "new", "--attribution", "owner-direct", "--date", "2026-08-28",
        "--client-task-id", "e2e-test-session",
        "--scope-tag", "gamma,delta");
      expect(res.code, res.out).toBe(0);
      const superseding = readEntities(dir, "rulings").find((r) => r.id !== oldId)!;
      expect(superseding.scopeTags).toEqual(["gamma", "delta"]);
    },
  },
  {
    key: "checkpoint create --blocked-by",
    check: (dir) => {
      seedTickets(dir, 2);
      enableCheckpoints(dir);
      const { id } = createCheckpoint(dir, "--blocked-by", "T-001,T-002");
      expect(byDisplayId(dir, "tickets", id).blockedBy).toEqual(["T-001", "T-002"]);
    },
  },
  {
    key: "checkpoint create --evidence-ref",
    check: (dir) => {
      enableCheckpoints(dir);
      const { id } = createCheckpoint(dir, "--evidence-ref", "docs/a.md,docs/b.md");
      expect(evidenceRefs(dir, id)).toEqual(["docs/a.md", "docs/b.md"]);
    },
  },
  {
    key: "checkpoint attach --evidence-ref",
    check: (dir) => {
      seedTickets(dir, 1);
      enableCheckpoints(dir);
      const res = run(dir, "checkpoint", "attach", "T-001", "--owner", "owner",
        "--kind", "decision", "--question", "sqlite or pg?", "--evidence-ref", "docs/a.md,docs/b.md");
      expect(res.code, res.out).toBe(0);
      expect(evidenceRefs(dir, "T-001")).toEqual(["docs/a.md", "docs/b.md"]);
    },
  },
  {
    key: "checkpoint change --evidence-ref",
    check: (dir) => {
      enableCheckpoints(dir);
      const { id, expected } = createCheckpoint(dir);
      const res = run(dir, "checkpoint", "change", id, ...expectedArgs(expected),
        "--kind", "decision", "--question", "sqlite or pg?", "--evidence-ref", "docs/a.md,docs/b.md");
      expect(res.code, res.out).toBe(0);
      expect(evidenceRefs(dir, id)).toEqual(["docs/a.md", "docs/b.md"]);
    },
  },
  {
    key: "checkpoint resolve --ruling-scope-tag",
    check: (dir) => {
      enableCheckpoints(dir);
      const { id, expected } = createCheckpoint(dir);
      const res = resolveWithRuling(dir, id, expected, "--ruling-scope-tag", "alpha,beta");
      expect(res.code, res.out).toBe(0);
      expect(readEntities(dir, "rulings")[0]!.scopeTags).toEqual(["alpha", "beta"]);
    },
  },
  {
    // T-502: `health --only` is a read-only selector, so unlike every row
    // above there is no stored field to inspect. What it proves instead is
    // the array behaviour itself: the comma expression selects exactly those
    // two checks in the fixed order, and a bare flag is rejected rather than
    // silently meaning "all", which would hide a typo'd value.
    key: "health --only",
    check: (dir) => {
      const res = run(dir, "health", "--only", "cli-version,cross-session-inbound", "--format", "json");
      expect(res.code, res.out).toBe(0);
      // ISS-1223: health json is the shared {version, data} envelope.
      const ids = (JSON.parse(res.out) as { data: { checks: Array<{ id: string }> } }).data.checks.map((c) => c.id);
      expect(ids).toEqual(["cli-version", "cross-session-inbound"]);
      expectRejected(run(dir, "health", "--only", "--format", "json"));
    },
  },
];

describe("ISS-886 registration coverage matrix", () => {
  it("has a row for every array registration in src/cli, and no stale rows", () => {
    // Fails in BOTH directions: a new registration with no row, and a row whose
    // registration was renamed or removed.
    const discovered = discoverArrayRegistrations().map(registrationKey);
    expect([...new Set(MATRIX.map((r) => r.key))].sort()).toEqual(discovered);
    // Guards a scanner that silently finds nothing, which would make the set
    // comparison above vacuous if MATRIX were ever emptied alongside it.
    expect(discovered.length).toBeGreaterThan(15);
  });

  it.each(MATRIX)("$key", ({ key, type, check }) => {
    const prefix = `iss886-${key.replace(/[^a-z0-9]+/gi, "-")}`;
    check(newProject(prefix, type ?? "npm"));
  });
});

describe("ISS-1343 checkpoint resolve --ruling-scope-tag", () => {
  it("refuses a separator-only value before anything is written", () => {
    // `,` is the empty case under SPLIT_LIST: it yields no values and is
    // refused. A lone "" is dropped instead (empty: "drop"), exactly as
    // `ruling create --scope-tag` treats it.
    const dir = newProject("iss1343-ruling-scope-tag-empty");
    enableCheckpoints(dir);
    const { id, expected } = createCheckpoint(dir);
    const before = byDisplayId(dir, "tickets", id);
    expectRejected(resolveWithRuling(dir, id, expected, "--ruling-scope-tag", ","), "contains separators but no values");
    expect(existsSync(join(dir, ".story", "rulings")) ? readEntities(dir, "rulings") : []).toEqual([]);
    expect(byDisplayId(dir, "tickets", id)).toEqual(before);
  });
});

describe("ISS-886 error boundary", () => {
  it("reports an array-option failure as invalid_input, not io_error", () => {
    // yargs wraps a coerce throw in YError and discards the code, so without the
    // recovery in the CLI failure handler this surfaced as io_error.
    const dir = newProject("iss886-boundary");
    const res = run(dir, "note", "create", "--content", "c", "--tags", ",", "--format", "json");
    expectRejected(res);
  });

  it("emits exactly one error envelope, not a doubled or partial one", () => {
    // The recovery path writes output and then throws HandledError. A parse-only
    // JSON check would also pass for `null` or for the FIRST of two concatenated
    // envelopes, so this pins the whole document: one object, version 1, the
    // expected code, no trailing content.
    const dir = newProject("iss886-one-envelope");
    const res = run(dir, "note", "create", "--content", "c", "--tags", ",", "--format", "json");
    const trimmed = res.out.trim();
    const err = errorEnvelope(trimmed);
    expect(err.code).toBe("invalid_input");
    expect(err.message).toBe('--tags was given ",", which contains separators but no values.');
    // One document, nothing appended: a second concatenated envelope would both
    // break the parse above and add a second "version" key.
    expect(trimmed.startsWith("{")).toBe(true);
    expect(trimmed.endsWith("}")).toBe(true);
    expect(trimmed.match(/"version"/g)).toHaveLength(1);
  });

  it("leaves an unrelated .check() failure on its existing path", () => {
    // Deliberately unchanged: the recovery is scoped to array options. That
    // .check() failures report io_error is a separate pre-existing defect,
    // pinned here so this change is provably not widening.
    const dir = newProject("iss886-check");
    const res = run(dir, "note", "create", "--format", "json");
    expect(res.code).not.toBe(0);
    expect(errorEnvelope(res.out).code).toBe("io_error");
  });

  it("leaves a CliValidationError thrown from an async handler on its existing path", () => {
    // The recovery keys on a stashed error, and only a coerce callback stashes
    // one. A CliValidationError raised INSIDE an async handler bypasses .fail
    // entirely, reaching parseAsync().catch as itself. That it reports io_error
    // rather than its own invalid_input is a separate pre-existing defect; pinned
    // here so the recovery is provably not reaching this path.
    const dir = newProject("iss886-handler-throw");
    const res = run(dir, "ticket", "update", "NOPE", "--title", "x", "--format", "json");
    expect(res.code).not.toBe(0);
    const err = errorEnvelope(res.out);
    expect(err.code).toBe("io_error");
    expect(err.message).toContain('Invalid ticket ID "NOPE"');
  });

  it("does not let a successful coerce leave a stale error behind for a later failure", () => {
    // The slot is keyed on message and cleared around the parse, so a run whose
    // array options coerce cleanly must not be able to attribute a LATER
    // handler-thrown error to an array option.
    const dir = newProject("iss886-stale-slot");
    expect(run(dir, "ticket", "create", "--title", "a", "--type", "task").code).toBe(0);
    const res = run(dir, "ticket", "update", "NOPE", "--blocked-by", "T-001", "--format", "json");
    expect(res.code).not.toBe(0);
    const err = errorEnvelope(res.out);
    expect(err.message).toContain('Invalid ticket ID "NOPE"');
    expect(err.message).not.toContain("--blocked-by");
  });
});
