import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverArrayRegistrations, registrationKey } from "./array-registration-inventory.js";

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

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(pkgRoot, "dist", "cli.js");

function run(cwd: string, ...args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [cliPath, ...args], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
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
    // coerce with [] there, which is why the spec cannot demand a value.
    const absent = run(dir, "dispatch", "--dry-run");
    expect(absent.out).not.toMatch(/\*\*Skipped:\*\*/);
    expect(absent.out).toContain("**Agents:** 0");
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

const MATRIX: Coverage[] = [
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
      const first = run(dir, "bus", "setup", "--client", "claude", "--task-id", "task-a",
        "--surface", "claude_cli");
      expect(first.code, first.out).toBe(0);
      const second = run(dir, "bus", "setup", "--client", "codex", "--task-id", "task-b",
        "--surface", "codex_cli");
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
