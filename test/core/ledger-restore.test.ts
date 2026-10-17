/**
 * T-526 (plan D4): restoring one ledger record to its projection at a commit.
 *
 * Standalone temp repositories only (ISS-1220): fixture git config writes in a
 * linked worktree reach the shared `.git/config`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import canonicalize from "canonicalize";
import { restoreRecord, RestoreUnsafe, RestoreInputError, type RestoreTarget } from "../../src/core/ledger-restore.js";
import type { SnapshotGitRunner } from "../../src/core/ledger-snapshot.js";
import { acquireProjectLockAsync, releaseProjectLock } from "../../src/core/project-lock.js";
import { capabilityCatalog } from "../../src/cli/commands/capability.js";
import { initProject } from "../../src/core/init.js";
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
async function newProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ledger-restore-"));
  roots.push(root);
  // The restore takes the project lock, which loads the project.
  await initProject(root, { name: "Restore", type: "npm" });
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "user.email", "t@t.t"]);
  return root;
}
function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf-8");
}
function commit(root: string, message: string): string {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}
/** The catalog writer's own serialization, so a fixture file is byte-identical to one the CLI wrote. */
function doc(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function cap(overrides: Record<string, unknown> = {}): Capability {
  return CapabilitySchema.parse({
    id: "cap-core",
    name: "Core",
    summary: "The core module.",
    entryPoints: ["src"],
    contract: "Does the core thing.",
    checkedAt: { sha: "0".repeat(40), date: "2026-09-20" },
    ...overrides,
  });
}
function term(overrides: Record<string, unknown> = {}): Term {
  return TermSchema.parse({ id: "term-duet", term: "duet", definition: "Two sessions.", updatedAt: "2026-09-20T00:00:00.000Z", ...overrides });
}
function caps(...entries: Capability[]): string {
  return doc({ version: 1, capabilities: entries });
}
function terms(...entries: Term[]): string {
  return doc({ version: 1, terms: entries });
}

const R1 = "r-0000000000000001";
function ruling(overrides: Record<string, unknown> = {}): string {
  return doc({
    id: R1,
    text: "Some ruling",
    attribution: "owner-direct",
    recordedBy: { client: "claude", id: "fixture" },
    date: "2026-09-20",
    scopeTags: ["logging"],
    supersedes: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  });
}
const NOTE_PATH = ".story/notes/n-0000000000000001.json";
function note(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "n-0000000000000001",
    displayId: "N-001",
    title: null,
    content,
    tags: [],
    status: "active",
    createdDate: "2026-09-20",
    updatedDate: "2026-09-20",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

const CAP_TARGET: RestoreTarget = { kind: "capability", id: "cap-core" };
const TERM_TARGET: RestoreTarget = { kind: "term", id: "term-duet" };
const deps = { capabilityCatalog };
/** For a refusal: reaching the write is itself a failure, so every refusal also proves it came before the write. */
const refuseDeps = {
  capabilityCatalog,
  beforeWrite: async () => {
    throw new Error("the restore reached its write before refusing");
  },
};

async function refusal(run: Promise<unknown>): Promise<RestoreUnsafe> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RestoreUnsafe);
  return err as RestoreUnsafe;
}

describe("restoreRecord: the success path", () => {
  it("rewrites only the target capability; a second entry in the same file is untouched", async () => {
    const root = await newProject();
    const other = cap({ id: "cap-other", name: "Other", summary: "Another module." });
    write(root, ".story/capabilities.json", caps(cap(), other));
    const base = commit(root, "base");
    // The other entry ALSO changes after base, so restoring the whole historical
    // catalog would lose its edit: only the target may move.
    const otherLater = cap({ id: "cap-other", name: "Other", summary: "Another module, edited since." });
    write(root, ".story/capabilities.json", caps(cap({ summary: "An edit someone regrets." }), otherLater));
    const mixed = commit(root, "edit");

    const result = await restoreRecord(root, CAP_TARGET, base, mixed, deps);

    expect(result).toEqual({ outcome: "restored", target: "capability cap-core" });
    // Byte for byte: the target is back at base, the other entry keeps its later value.
    expect(read(root, ".story/capabilities.json")).toBe(caps(cap(), otherLater));
  });

  it("restores a single-record file to the exact blob bytes at --from", async () => {
    const root = await newProject();
    // Deliberately NOT the CLI's formatting: a byte-exact restore keeps the blob as committed.
    const baseBytes = JSON.stringify(note("First thought."), null, 4) + "\n";
    write(root, NOTE_PATH, baseBytes);
    const sibling = ".story/notes/n-0000000000000002.json";
    write(root, sibling, doc(note("Sibling.", { id: "n-0000000000000002", displayId: "N-002" })));
    const base = commit(root, "base");
    write(root, NOTE_PATH, doc(note("Second thought.")));
    write(root, sibling, doc(note("Sibling edited.", { id: "n-0000000000000002", displayId: "N-002" })));
    const mixed = commit(root, "edit");

    const result = await restoreRecord(root, { kind: "record", path: NOTE_PATH }, base, mixed, deps);

    expect(result).toEqual({ outcome: "restored", target: NOTE_PATH });
    expect(read(root, NOTE_PATH)).toBe(baseBytes);
    expect(read(root, sibling)).toBe(doc(note("Sibling edited.", { id: "n-0000000000000002", displayId: "N-002" })));
  });

  it("compares --expect against the PROJECTION, not the file bytes", async () => {
    const root = await newProject();
    write(root, NOTE_PATH, doc(note("First thought.")));
    const base = commit(root, "base");
    const edited = note("Second thought.");
    write(root, NOTE_PATH, doc(edited));
    const mixed = commit(root, "edit");
    // Same record, different bytes: reordered keys and another indent.
    const reordered = Object.fromEntries(Object.entries(edited).reverse());
    write(root, NOTE_PATH, JSON.stringify(reordered));
    expect(read(root, NOTE_PATH)).not.toBe(doc(edited));
    expect(canonicalize(JSON.parse(read(root, NOTE_PATH)))).toBe(canonicalize(edited));

    const result = await restoreRecord(root, { kind: "record", path: NOTE_PATH }, base, mixed, deps);
    expect(result.outcome).toBe("restored");
    expect(read(root, NOTE_PATH)).toBe(doc(note("First thought.")));
  });

  it("the catalog projection includes pendingNote: a deferred entry no longer matches its undeferred --expect", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", caps(cap()));
    const base = commit(root, "base");
    write(root, ".story/capabilities.json", caps(cap({ summary: "Edited." })));
    const mixed = commit(root, "edit");
    write(root, ".story/capabilities.json", caps(cap({ summary: "Edited.", pendingNote: "Owed work.", status: "review" })));

    const err = await refusal(restoreRecord(root, CAP_TARGET, base, mixed, refuseDeps));
    expect(err.reason).toBe("expect-mismatch");
  });

  it("holds the project lock for the write", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", caps(cap()));
    const base = commit(root, "base");
    write(root, ".story/capabilities.json", caps(cap({ summary: "Edited." })));
    const mixed = commit(root, "edit");

    let contender: unknown = "not attempted";
    const result = await restoreRecord(root, CAP_TARGET, base, mixed, {
      ...deps,
      beforeWrite: async () => {
        try {
          const handle = await acquireProjectLockAsync(join(root, ".story", ".lock"), { deadlineMs: 150, pollMs: 10 });
          releaseProjectLock(handle);
          contender = "acquired";
        } catch (err) {
          contender = err;
        }
      },
    });
    expect(result.outcome).toBe("restored");
    expect(contender).toBeInstanceOf(Error);
  });

  it("reports unchanged and writes nothing when the record already equals its projection at --from", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", caps(cap()));
    const base = commit(root, "base");
    const before = statSync(join(root, ".story/capabilities.json")).mtimeMs;
    let wrote = false;

    const result = await restoreRecord(root, CAP_TARGET, base, base, { ...deps, beforeWrite: async () => void (wrote = true) });

    expect(result).toEqual({ outcome: "unchanged", target: "capability cap-core" });
    expect(wrote).toBe(false);
    expect(statSync(join(root, ".story/capabilities.json")).mtimeMs).toBe(before);
  });
});

describe("restoreRecord: a mixed commit round trip", () => {
  it("undoes the term half of a code-plus-term commit, and a re-apply is its own restore", async () => {
    const root = await newProject();
    write(root, "src/thing.ts", "export const a = 1;\n");
    write(root, ".story/glossary.json", terms(term()));
    const baseline = commit(root, "baseline");
    write(root, "src/thing.ts", "export const a = 2;\n");
    write(root, ".story/glossary.json", terms(term({ definition: "Two sessions, one pen." })));
    const mixed = commit(root, "code and a term edit together");

    // Both oids go through readLedgerSnapshot: a sized tree listing each.
    const calls: string[][] = [];
    const spy: SnapshotGitRunner = async (r, args, input) => {
      calls.push([...args]);
      const out = spawnSync("git", ["-C", r, ...args], { input: input ?? "", env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" } });
      return { code: out.status, stdout: out.stdout, stderr: out.stderr.toString("utf-8") };
    };

    const undone = await restoreRecord(root, TERM_TARGET, baseline, mixed, { ...deps, git: spy });
    expect(undone.outcome).toBe("restored");
    expect(read(root, ".story/glossary.json")).toBe(terms(term()));
    // The code half of the commit is not the restore's business.
    expect(read(root, "src/thing.ts")).toBe("export const a = 2;\n");
    const listings = calls.filter((c) => c[0] === "ls-tree");
    expect(listings).toHaveLength(2);
    for (const l of listings) expect(l).toContain("-l");
    expect(listings.map((l) => l[l.indexOf("-l") + 1])).toEqual([baseline, mixed]);

    // Re-applying is a separate, explicit change in the other direction.
    const redone = await restoreRecord(root, TERM_TARGET, mixed, baseline, deps);
    expect(redone.outcome).toBe("restored");
    expect(read(root, ".story/glossary.json")).toBe(terms(term({ definition: "Two sessions, one pen." })));
  });
});

describe("restoreRecord: refusals, each before the write", () => {
  it("expect-mismatch when the record moved after --expect, and nothing is written", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", caps(cap()));
    const base = commit(root, "base");
    write(root, ".story/capabilities.json", caps(cap({ summary: "Edited." })));
    const mixed = commit(root, "edit");
    const drifted = caps(cap({ summary: "Edited again, uncommitted." }));
    write(root, ".story/capabilities.json", drifted);

    const err = await refusal(restoreRecord(root, CAP_TARGET, base, mixed, refuseDeps));
    expect(err.reason).toBe("expect-mismatch");
    expect(err.message).toMatch(/^restore-unsafe: capability cap-core: expect-mismatch \(-\)/);
    expect(read(root, ".story/capabilities.json")).toBe(drifted);
  });

  it("expect-mismatch when the record is absent on one side only", async () => {
    const root = await newProject();
    write(root, ".story/glossary.json", terms());
    const empty = commit(root, "no term yet");
    write(root, ".story/glossary.json", terms(term()));
    const withTerm = commit(root, "term");
    // Current has the term; --expect says it should be absent.
    const err = await refusal(restoreRecord(root, TERM_TARGET, withTerm, empty, refuseDeps));
    expect(err.reason).toBe("expect-mismatch");
  });

  it("absent-source: a restore never deletes, so a term restore cannot drop the id a capability links", async () => {
    const root = await newProject();
    write(root, ".story/glossary.json", terms());
    write(root, ".story/capabilities.json", caps(cap()));
    const before = commit(root, "before the term");
    write(root, ".story/glossary.json", terms(term()));
    write(root, ".story/capabilities.json", caps(cap({ terms: ["term-duet"] })));
    const after = commit(root, "term linked");

    const err = await refusal(restoreRecord(root, TERM_TARGET, before, after, refuseDeps));
    expect(err.reason).toBe("absent-source");
    expect(read(root, ".story/glossary.json")).toBe(terms(term()));
  });

  it("absent-source for a single-record file absent at --from", async () => {
    const root = await newProject();
    write(root, "README.md", "x\n");
    const empty = commit(root, "empty");
    write(root, NOTE_PATH, doc(note("Born later.")));
    const born = commit(root, "note");
    const err = await refusal(restoreRecord(root, { kind: "record", path: NOTE_PATH }, empty, born, refuseDeps));
    expect(err.reason).toBe("absent-source");
    expect(read(root, NOTE_PATH)).toBe(doc(note("Born later.")));
  });

  it("conflict: a catalog entry carrying _conflicts is refused, even when nothing would change", async () => {
    const root = await newProject();
    const conflicted = cap({ _conflicts: [{ fieldPath: "/summary", kind: "field", base: "a", ours: "b", theirs: "c" }] });
    write(root, ".story/capabilities.json", caps(conflicted));
    const base = commit(root, "conflicted");
    const err = await refusal(restoreRecord(root, CAP_TARGET, base, base, refuseDeps));
    expect(err.reason).toBe("conflict");
  });

  it("conflict: a single-record file carrying _conflicts is refused", async () => {
    const root = await newProject();
    write(root, NOTE_PATH, doc(note("First.")));
    const base = commit(root, "base");
    const conflicted = doc(note("Second.", { _conflicts: [{ fieldPath: "/content", kind: "field", base: "a", ours: "b", theirs: "c" }] }));
    write(root, NOTE_PATH, conflicted);
    const head = commit(root, "conflicted");
    const err = await refusal(restoreRecord(root, { kind: "record", path: NOTE_PATH }, base, head, refuseDeps));
    expect(err.reason).toBe("conflict");
    expect(read(root, NOTE_PATH)).toBe(conflicted);
  });

  it("accepted-ruling: a ruling that is effectively accepted now is never restored", async () => {
    const root = await newProject();
    write(root, `.story/rulings/${R1}.json`, ruling({ status: "proposed", text: "Draft." }));
    const draft = commit(root, "draft");
    // A 1.15-shaped record: accepted by shape.
    write(root, `.story/rulings/${R1}.json`, ruling());
    const accepted = commit(root, "accepted");
    const err = await refusal(restoreRecord(root, { kind: "record", path: `.story/rulings/${R1}.json` }, draft, accepted, refuseDeps));
    expect(err.reason).toBe("accepted-ruling");
    expect(read(root, `.story/rulings/${R1}.json`)).toBe(ruling());
  });

  it("acceptance-claim: restored content that claims acceptance is refused", async () => {
    const root = await newProject();
    write(root, `.story/rulings/${R1}.json`, ruling());
    const legacy = commit(root, "legacy");
    write(root, `.story/rulings/${R1}.json`, ruling({ status: "proposed", text: "Reopened." }));
    const proposed = commit(root, "proposed");
    const before = read(root, `.story/rulings/${R1}.json`);
    const err = await refusal(restoreRecord(root, { kind: "record", path: `.story/rulings/${R1}.json` }, legacy, proposed, refuseDeps));
    expect(err.reason).toBe("invariant");
    expect(err.invariant).toBe("acceptance-claim");
    expect(read(root, `.story/rulings/${R1}.json`)).toBe(before);
  });

  it("a proposal restores to an earlier proposal", async () => {
    const root = await newProject();
    write(root, `.story/rulings/${R1}.json`, ruling({ status: "proposed", text: "First draft." }));
    const first = commit(root, "first");
    write(root, `.story/rulings/${R1}.json`, ruling({ status: "proposed", text: "Second draft." }));
    const second = commit(root, "second");
    const result = await restoreRecord(root, { kind: "record", path: `.story/rulings/${R1}.json` }, first, second, deps);
    expect(result.outcome).toBe("restored");
    expect(read(root, `.story/rulings/${R1}.json`)).toBe(ruling({ status: "proposed", text: "First draft." }));
  });
});

describe("restoreRecord: invariants", () => {
  it("capability-name-collision: the restored name is now another entry's", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", caps(cap({ name: "Shared Name" })));
    const base = commit(root, "base");
    const now = caps(cap({ name: "Renamed" }), cap({ id: "cap-other", name: "shared name " }));
    write(root, ".story/capabilities.json", now);
    const head = commit(root, "renamed, and the name reused");
    const err = await refusal(restoreRecord(root, CAP_TARGET, base, head, refuseDeps));
    expect(err.reason).toBe("invariant");
    expect(err.invariant).toBe("capability-name-collision");
    expect(read(root, ".story/capabilities.json")).toBe(now);
  });

  it("dangling-reference: a restored capability links a term that no longer exists", async () => {
    const root = await newProject();
    write(root, ".story/glossary.json", terms(term()));
    write(root, ".story/capabilities.json", caps(cap({ terms: ["term-duet"] })));
    const base = commit(root, "linked");
    write(root, ".story/glossary.json", terms());
    write(root, ".story/capabilities.json", caps(cap()));
    const head = commit(root, "unlinked and removed");
    const before = read(root, ".story/capabilities.json");
    const err = await refusal(restoreRecord(root, CAP_TARGET, base, head, refuseDeps));
    expect(err.reason).toBe("invariant");
    expect(err.invariant).toBe("dangling-reference");
    expect(read(root, ".story/capabilities.json")).toBe(before);
  });

  it("term-collision: a restored alias is now owned by another term", async () => {
    const root = await newProject();
    write(root, ".story/glossary.json", terms(term({ aliases: ["pair"] })));
    const base = commit(root, "alias");
    const now = terms(term(), term({ id: "term-pair", term: "pair", definition: "Two of a thing." }));
    write(root, ".story/glossary.json", now);
    const head = commit(root, "alias became a term");
    const err = await refusal(restoreRecord(root, TERM_TARGET, base, head, refuseDeps));
    expect(err.reason).toBe("invariant");
    expect(err.invariant).toBe("term-collision");
    expect(read(root, ".story/glossary.json")).toBe(now);
  });

  it("dangling-reference: a restored term links a capability that no longer exists", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", caps(cap()));
    write(root, ".story/glossary.json", terms(term({ capabilities: ["cap-core"] })));
    const base = commit(root, "linked");
    write(root, ".story/capabilities.json", caps());
    write(root, ".story/glossary.json", terms(term()));
    const head = commit(root, "capability gone");
    const before = read(root, ".story/glossary.json");
    const err = await refusal(restoreRecord(root, TERM_TARGET, base, head, refuseDeps));
    expect(err.reason).toBe("invariant");
    expect(err.invariant).toBe("dangling-reference");
    expect(read(root, ".story/glossary.json")).toBe(before);
  });

  it("schema: a single-record source that fails its own schema is refused", async () => {
    const root = await newProject();
    write(root, NOTE_PATH, doc({ ...note("x"), status: "not-a-status" }));
    const bad = commit(root, "bad");
    write(root, NOTE_PATH, doc(note("Fixed.")));
    const head = commit(root, "fixed");
    const before = read(root, NOTE_PATH);
    const err = await refusal(restoreRecord(root, { kind: "record", path: NOTE_PATH }, bad, head, refuseDeps));
    expect(err.reason).toBe("invariant");
    expect(err.invariant).toBe("schema");
    expect(read(root, NOTE_PATH)).toBe(before);
  });

  it("utf-8: a source blob that is not valid UTF-8 is refused, never rewritten with replacement characters", async () => {
    const root = await newProject();
    const text = doc(note("Before \u00e9 after."));
    // Swap the two-byte e-acute for a lone continuation byte: JSON.parse still
    // accepts the decoded string, but the bytes do not round-trip.
    const bad = Buffer.from(text.replace("\u00e9", "\u0001"), "utf-8");
    bad[bad.indexOf(0x01)] = 0x80;
    mkdirSync(dirname(join(root, NOTE_PATH)), { recursive: true });
    writeFileSync(join(root, NOTE_PATH), bad);
    const broken = commit(root, "bad bytes");
    write(root, NOTE_PATH, doc(note("Fixed.")));
    const head = commit(root, "fixed");
    const err = await refusal(restoreRecord(root, { kind: "record", path: NOTE_PATH }, broken, head, refuseDeps));
    expect(err.reason).toBe("invariant");
    expect(err.invariant).toBe("utf-8");
    expect(read(root, NOTE_PATH)).toBe(doc(note("Fixed.")));
  });

  it("filename-id: a single-record source whose id is not its filename is refused", async () => {
    const root = await newProject();
    write(root, NOTE_PATH, doc(note("Misnamed.", { id: "n-0000000000000009" })));
    const bad = commit(root, "misnamed");
    write(root, NOTE_PATH, doc(note("Fixed.")));
    const head = commit(root, "fixed");
    const before = read(root, NOTE_PATH);
    const err = await refusal(restoreRecord(root, { kind: "record", path: NOTE_PATH }, bad, head, refuseDeps));
    expect(err.reason).toBe("invariant");
    expect(err.invariant).toBe("filename-id");
    expect(read(root, NOTE_PATH)).toBe(before);
  });
});

describe("restoreRecord: inputs", () => {
  it.each([
    [".story/tickets/T-001.json"],
    [".story/lessons/L-001.json"],
    [".story/notes/sub/N-001.json"],
    [".story/notes/../tickets/T-001.json"],
    [".story/notes/N-001.txt"],
    ["/abs/.story/notes/N-001.json"],
    [".story/config.json"],
  ])("refuses %s as a target", async (path) => {
    const root = await newProject();
    write(root, "README.md", "x\n");
    const base = commit(root, "base");
    await expect(restoreRecord(root, { kind: "record", path }, base, base, deps)).rejects.toBeInstanceOf(RestoreInputError);
  });

  it("names tickets and lessons as out of scope rather than calling them malformed", async () => {
    const root = await newProject();
    write(root, "README.md", "x\n");
    const base = commit(root, "base");
    for (const family of ["tickets", "lessons"]) {
      await expect(restoreRecord(root, { kind: "record", path: `.story/${family}/X-001.json` }, base, base, deps)).rejects.toThrow(
        `ledger restore does not restore ${family}`,
      );
    }
  });

  it("an oid that does not resolve is an input error, not a refusal", async () => {
    const root = await newProject();
    write(root, ".story/capabilities.json", caps(cap()));
    const base = commit(root, "base");
    await expect(restoreRecord(root, CAP_TARGET, "0".repeat(40), base, deps)).rejects.toBeInstanceOf(RestoreInputError);
    await expect(restoreRecord(root, CAP_TARGET, base, "--help", deps)).rejects.toBeInstanceOf(RestoreInputError);
  });
});

// T-481 B4: restore writes the recorded bytes back, outside the stamping write
// path, so a restored issue keeps exactly its historical updatedDate.
describe("T-481 B4: restore never stamps updatedDate", () => {
  it("an issue record restores to its exact base bytes, old updatedDate included", async () => {
    const root = await newProject();
    const path = ".story/issues/i-0000000000000001.json";
    const issue = (impact: string) => ({
      id: "i-0000000000000001", displayId: "ISS-001", title: "Old issue", status: "open", severity: "medium",
      components: [], impact, resolution: null, location: [], discoveredDate: "2020-01-01", resolvedDate: null,
      relatedTickets: [], order: 10, phase: null, updatedDate: "2020-01-01",
    });
    const baseBytes = doc(issue("first"));
    write(root, path, baseBytes);
    const base = commit(root, "base");
    write(root, path, doc({ ...issue("second"), updatedDate: "2020-02-02" }));
    const mixed = commit(root, "edit");
    const result = await restoreRecord(root, { kind: "record", path }, base, mixed, deps);
    expect(result).toEqual({ outcome: "restored", target: path });
    expect(read(root, path)).toBe(baseBytes);
  });
});
