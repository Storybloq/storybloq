/**
 * Scanner diagnostics (ISS-897).
 *
 * `scanSessionSummaries` used to drop everything it could not read, parse, or
 * account for with a bare `continue`, so no consumer could tell "nothing is
 * running" from "something may be running and I could not read it".
 *
 * BOTH directions are load-bearing here. The loud rows prove concealment is now
 * reported; the SILENT rows prove the fix did not overshoot -- each one is a
 * shape that occurs on healthy projects, and diagnosing it would drive the hot
 * ownership guard to `unverifiable` for no reason. The silent tests are the ones
 * that would catch a well-meant future widening.
 *
 * Faults use wrong file types rather than chmod: a chmod-based EACCES test run
 * as root reads the file anyway and passes for the wrong reason.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySessionGuard } from "../../src/core/session-guard.js";
import { readSessionStrict } from "../../src/autonomous/session.js";
import { scanSessionSummaries, type SessionScanDiagnostic } from "../../src/core/session-scan.js";
import { WORKFLOW_STATES } from "../../src/autonomous/session-types.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-scan-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

/** A canonical session id, so name-shape rules can be exercised both ways. */
const UUID = "11111111-2222-4333-8444-555555555555";

function writeState(root: string, dirName: string, state: unknown): string {
  const dir = join(root, ".story", "sessions", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), typeof state === "string" ? state : JSON.stringify(state));
  return dir;
}

/** A record the scanner admits to `activeSessions`, with overrides applied last. */
function activeState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: UUID,
    status: "active",
    state: "IMPLEMENT",
    mode: "auto",
    lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
    ...over,
  };
}

const kinds = (d: readonly SessionScanDiagnostic[]): string[] => d.map((x) => x.kind).sort();
const scan = (root: string) => {
  const r = scanSessionSummaries(root);
  return { ...r, diagnostics: r.diagnostics ?? [] };
};

// ---------------------------------------------------------------------------
// The collection itself
// ---------------------------------------------------------------------------

describe("the sessions directory", () => {
  it("ABSENT is silent -- it genuinely means no session has ever run", () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-scan-"));
    roots.push(root);
    mkdirSync(join(root, ".story"), { recursive: true });
    const r = scan(root);
    expect(r.diagnostics).toEqual([]);
    expect(r.activeSessions).toEqual([]);
  });

  it("and a dangling ANCESTOR is REPORTED, not silent, not just a dangling sessions directory", () => {
    // The same fault one level higher, and the errno hides it twice over. With
    // `.story` dangling, `readdirSync(.story/sessions)` raises ENOENT AND
    // `lstatSync(.story/sessions)` raises ENOENT -- so the second observation,
    // which exists to disambiguate the first, returns exactly as ambiguous an
    // answer. A check that stops there declares an empty project and returns a
    // clean, complete scan with no diagnostics, over a collection that cannot
    // be read at all. Absence is only proven by climbing to an ancestor that
    // EXISTS and finding a directory.
    const root = mkdtempSync(join(tmpdir(), "storybloq-scan-anc-"));
    roots.push(root);
    symlinkSync(join(root, "nowhere-at-all"), join(root, ".story"));

    const r = scan(root);
    const d = r.diagnostics.find((x) => x.kind === "sessions-dir-unreadable");
    expect(d, JSON.stringify(r.diagnostics)).toBeDefined();
    expect(d!.category).toBe("omission");
    expect(r.activeSessions).toEqual([]);
  });

  it("but a genuinely absent project is still silent, however deep", () => {
    // The control the climb must not break: several absent levels in a row are
    // still an absence, and a project that has never run a session has exactly
    // that shape. Answering `probe-failed` here would make every fresh project
    // report a scan fault.
    const root = mkdtempSync(join(tmpdir(), "storybloq-scan-fresh-"));
    roots.push(root);
    // No `.story` at all -- not even the parent directory.
    const r = scan(root);
    expect(r.diagnostics, JSON.stringify(r.diagnostics)).toEqual([]);
    expect(r.activeSessions).toEqual([]);
  });

  it("a DANGLING symlink is reported, not read as absence", () => {
    // `readdirSync` FOLLOWS the link, so this raises ENOENT -- the same errno an
    // absent directory raises, and the one the catch exempts. Trusting the errno
    // alone reports `free` over a `complete` scan with nothing to inspect, while
    // `.story/sessions` is sitting right there in an unusable form: the ISS-897
    // failure at collection scale. `lstat` does not follow, which separates the
    // two. Same distinction `lockIsEmpty` makes for a `.lock` entry, one level up.
    const root = mkdtempSync(join(tmpdir(), "storybloq-scan-"));
    roots.push(root);
    mkdirSync(join(root, ".story"), { recursive: true });
    symlinkSync(join(root, ".story", "nowhere"), join(root, ".story", "sessions"));
    const [d] = scan(root).diagnostics;
    expect(d?.kind).toBe("sessions-dir-unreadable");
    expect(d?.category).toBe("omission");
    expect(d?.sourceDir).toBeNull();
    // And the reason must not read as an ordinary unreadable directory: the
    // errno IS ENOENT, so "could not be read (ENOENT)" would be actively
    // confusing next to the row above that treats ENOENT as absence.
    expect(d?.reason).toContain("a second look found a SYMLINK entry");
    expect(d?.reason).toContain("NOT an absent sessions directory");
    // It reports the entry it SAW, not a conclusion about the target. The two
    // observations are separated in time, so this arrangement and one where the
    // whole path was swapped between the calls are indistinguishable from here --
    // and "repoint or remove the link" destroys a valid link in the second case.
    expect(d?.reason).toContain("not atomic");
    for (const forbidden of ["does not resolve", "Repoint", "remove the link", "Delete"]) {
      expect(d?.reason, forbidden).not.toContain(forbidden);
    }
  });

  it("UNREADABLE is reported -- ENOTDIR is not the same answer as ENOENT", () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-scan-"));
    roots.push(root);
    mkdirSync(join(root, ".story"), { recursive: true });
    writeFileSync(join(root, ".story", "sessions"), "not a directory");
    const [d] = scan(root).diagnostics;
    expect(d?.kind).toBe("sessions-dir-unreadable");
    expect(d?.category).toBe("omission");
    // No entry to name, so the path carries the collection instead.
    expect(d?.sourceDir).toBeNull();
    expect(d?.sourcePath).toContain(join(".story", "sessions"));
  });
});

// ---------------------------------------------------------------------------
// Entries that are not directories
// ---------------------------------------------------------------------------

describe("non-directory entries", () => {
  it("a symlink of any name is reported -- readdir never follows it", () => {
    const root = makeRoot();
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "state.json"), JSON.stringify(activeState()));
    symlinkSync(real, join(root, ".story", "sessions", "not-a-uuid"));
    const [d] = scan(root).diagnostics;
    expect(d?.kind).toBe("entry-not-a-directory");
    expect(d?.sourceDir).toBe("not-a-uuid");
  });

  it("a REGULAR FILE named like a session id is reported", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".story", "sessions", UUID), "{}");
    expect(kinds(scan(root).diagnostics)).toEqual(["entry-not-a-directory"]);
  });

  it("an ordinary file is SILENT -- a .DS_Store must not stop the guard", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".story", "sessions", ".DS_Store"), "\0\0");
    writeFileSync(join(root, ".story", "sessions", "notes.txt"), "scratch");
    expect(scan(root).diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Directories the scan cannot read
// ---------------------------------------------------------------------------

describe("unreadable and unparseable state", () => {
  it("a missing state.json is reported -- createSession mkdirs BEFORE its first write", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", UUID), { recursive: true });
    const [d] = scan(root).diagnostics;
    expect(d?.kind).toBe("state-missing");
    expect(d?.category).toBe("omission");
  });

  it("a missing state.json is reported for a NON-canonical directory name too", () => {
    // The scanner admits a directory of any name that holds a state.json
    // (see ActiveSessionSummary.sourceDir), so gating this on UUID shape would
    // silence exactly the legacy sessions that doc comment describes.
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "legacy-session-dir"), { recursive: true });
    expect(kinds(scan(root).diagnostics)).toEqual(["state-missing"]);
  });

  it("the .lock directory is SILENT -- proper-lockfile takes it via mkdir", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", ".lock"), { recursive: true });
    expect(scan(root).diagnostics).toEqual([]);
  });

  it("a .lock SYMLINK is reported -- the reserved name buys silence only for the real shape", () => {
    // The name is exempt because `proper-lockfile` creates it as a directory.
    // Exempting the NAME rather than the shape would hand any entry called
    // `.lock` unconditional silence, and readdir does not follow a symlink --
    // so a live session behind one would vanish from the scan entirely, through
    // the one entry name the scanner was told to ignore.
    const root = makeRoot();
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "state.json"), JSON.stringify(activeState()));
    symlinkSync(real, join(root, ".story", "sessions", ".lock"));

    const [d] = scan(root).diagnostics;
    expect(d?.kind).toBe("entry-not-a-directory");
    expect(d?.category).toBe("omission");
    expect(d?.sourceDir).toBe(".lock");
    // And the session it hides is genuinely absent from the population, which
    // is what makes the diagnostic load-bearing rather than cosmetic.
    expect(scan(root).activeSessions).toHaveLength(0);
  });

  it("a NON-EMPTY .lock directory without a state.json is still reported", () => {
    // The exemption covers the shape `proper-lockfile` creates, which holds
    // nothing. The old probe asked a different question -- is `.lock/state.json`
    // absent -- which answers "this is a lock" for a `.lock` holding a pid file,
    // a stray temp file, or a session directory created a moment before its
    // state write. That last one is precisely the shape the exemption must not
    // swallow: it is a session, mid-creation, under a name that buys silence.
    const root = makeRoot();
    const lock = join(root, ".story", "sessions", ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "12345");

    const [d] = scan(root).diagnostics;
    expect(d?.kind).toBe("state-missing");
    expect(d?.category).toBe("omission");
    expect(d?.sourceDir).toBe(".lock");
  });

  it("a .lock directory holding a SUBDIRECTORY is reported too", () => {
    // Same rule, and the shape a half-created session actually leaves behind.
    const root = makeRoot();
    const lock = join(root, ".story", "sessions", ".lock");
    mkdirSync(join(lock, "nested"), { recursive: true });
    expect(kinds(scan(root).diagnostics)).toEqual(["state-missing"]);
  });

  it("a real .lock DIRECTORY holding a valid state.json is NOT skipped", () => {
    // The exemption is for the shape `proper-lockfile` creates, which is an
    // empty directory. This scanner admits a contained session directory under
    // ANY name, so `.lock` is a name a real session can legitimately have --
    // and skipping it by name would delete a live session from the population
    // through the one entry name the scanner was told to ignore.
    const root = makeRoot();
    writeState(root, ".lock", activeState());
    const r = scan(root);
    expect(r.activeSessions).toHaveLength(1);
    expect(r.activeSessions[0]!.sourceDir).toBe(".lock");
    expect(r.diagnostics).toEqual([]);
  });

  it("a .lock directory whose state.json is a DANGLING symlink is reported", () => {
    // `existsSync` follows symlinks and returns false for a dangling one, so it
    // would read this as an empty lock and skip it -- concealing a
    // session-shaped directory behind the one entry name the scanner is allowed
    // to ignore. Only an explicit ENOENT earns the exemption.
    const root = makeRoot();
    const lock = join(root, ".story", "sessions", ".lock");
    mkdirSync(lock, { recursive: true });
    symlinkSync(join(root, "nowhere", "state.json"), join(lock, "state.json"));
    // It is NOT silently skipped -- and the fault it gets says what was actually
    // observed. `readFileSync` also follows the link and raises ENOENT, the same
    // errno an absent file raises, so classifying on the errno alone reported
    // "this session directory has no state.json". That is false: an entry by
    // that name exists, and an operator told the file is missing who then writes
    // one watches the write follow that entry somewhere else. `lstat` separates
    // the two.
    const [d] = scan(root).diagnostics;
    expect(d, `silently skipped: ${JSON.stringify(scan(root).diagnostics)}`).toBeDefined();
    expect(d!.kind).toBe("state-unreadable");
    expect(d!.category).toBe("omission");
    expect(d!.sourceDir).toBe(".lock");
    expect(d!.reason).toContain("a second look found a SYMLINK entry");
    expect(d!.reason).not.toContain("has no state.json");
    // The claim stops at what was seen. This test ARRANGES a dangling link, but
    // the scanner cannot tell that from a link whose target arrived between the
    // two calls, so it may not say the target is missing -- and it may not issue
    // a remedy that assumes it.
    expect(d!.reason).toContain("not atomic");
    for (const forbidden of ["target is not there", "Repoint", "remove it", "Delete"]) {
      expect(d!.reason, forbidden).not.toContain(forbidden);
    }
  });

  it("a genuinely absent state.json still reports `state-missing`", () => {
    // The control for the row above: the lstat probe must not turn every ENOENT
    // into a symlink story. An unused name is still the creation-race shape.
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "half-created"), { recursive: true });
    const [d] = scan(root).diagnostics;
    expect(d!.kind).toBe("state-missing");
    expect(d!.reason).toContain("has no state.json");
  });

  it("a .lock regular FILE stays silent, like any other stray file", () => {
    // Not an exemption for the name -- it falls through to the ordinary-file
    // rule. A regular file has no children, so unlike a symlink it cannot be
    // hiding a session, and reporting it would be the `.DS_Store` noise the
    // rule above exists to avoid.
    const root = makeRoot();
    writeFileSync(join(root, ".story", "sessions", ".lock"), "");
    expect(scan(root).diagnostics).toEqual([]);
  });

  it("EISDIR on state.json is reported, and is a different kind from ENOENT", () => {
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "broken", "state.json"), { recursive: true });
    expect(kinds(scan(root).diagnostics)).toEqual(["state-unreadable"]);
  });

  it("unparseable JSON is reported", () => {
    const root = makeRoot();
    writeState(root, "truncated", '{"status":"active"');
    expect(kinds(scan(root).diagnostics)).toEqual(["state-invalid-json"]);
  });

  /**
   * `JSON.parse("null")` SUCCEEDS and returns null, and the pre-fix scanner then
   * read `.status` off it and threw a TypeError -- on the hot MCP path, in a
   * function documented never to throw.
   */
  it.each([["null", "null"], ["[]", "an array"], ['"x"', "a string"], ["42", "a number"]])(
    "a state.json whose root is %s is reported, and the scan does not throw",
    (raw) => {
      const root = makeRoot();
      writeState(root, "weird", raw);
      expect(() => scanSessionSummaries(root)).not.toThrow();
      expect(kinds(scan(root).diagnostics)).toEqual(["state-not-an-object"]);
    },
  );
});

// ---------------------------------------------------------------------------
// Parseable records: status, and the fields that get substituted
// ---------------------------------------------------------------------------

describe("parseable records", () => {
  it("an unrecognized status is reported -- the schema DEFAULTS an absent one to active", () => {
    const root = makeRoot();
    writeState(root, "typo", activeState({ status: "actve" }));
    const [d] = scan(root).diagnostics;
    expect(d?.kind).toBe("status-undetermined");
    expect(d?.reason).toContain("actve");
  });

  it.each(["completed", "superseded"])("status %s is SILENT -- positively inactive", (status) => {
    const root = makeRoot();
    writeState(root, "done", activeState({ status }));
    expect(scan(root).diagnostics).toEqual([]);
  });

  it("SESSION_END is SILENT -- positively terminal", () => {
    const root = makeRoot();
    writeState(root, "ended", activeState({ state: "SESSION_END" }));
    expect(scan(root).diagnostics).toEqual([]);
  });

  it("an invalid sessionId is `normalized`, and the record is STILL reported", () => {
    const root = makeRoot();
    writeState(root, "no-id", activeState({ sessionId: 7 }));
    const r = scan(root);
    // Nothing about ownership is unknown here, so this must not conceal.
    expect(r.activeSessions).toHaveLength(1);
    expect(r.activeSessions[0]!.sessionId).toBe("no-id");
    const [d] = r.diagnostics;
    expect(d?.kind).toBe("session-id-invalid");
    expect(d?.category).toBe("normalized");
  });

  it("an unusable state is `undetermined`, and the record is STILL reported", () => {
    const root = makeRoot();
    writeState(root, "no-state", activeState({ state: 42 }));
    const r = scan(root);
    expect(r.activeSessions).toHaveLength(1);
    expect(r.activeSessions[0]!.state).toBe("unknown");
    expect(r.diagnostics[0]!.category).toBe("undetermined");
  });
});

// ---------------------------------------------------------------------------
// The lease axis
// ---------------------------------------------------------------------------

describe("lease state", () => {
  const compactPending = { state: "COMPACT", compactPending: true };
  const expired = { lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() } };

  it("a resumable member with an EXPIRED lease is silent -- it is genuinely resumable", () => {
    const root = makeRoot();
    writeState(root, "recover", activeState({ ...compactPending, ...expired }));
    const r = scan(root);
    expect(r.resumableSessions).toHaveLength(1);
    expect(r.diagnostics).toEqual([]);
  });

  it.each([
    ["missing", {}],
    ["invalid", { lease: { expiresAt: "not-a-date" } }],
  ])("a resumable member with a %s lease is reported as `undetermined`, and stays in the array", (state, over) => {
    const root = makeRoot();
    const s = activeState({ ...compactPending, ...over });
    if (state === "missing") delete s.lease;
    writeState(root, "recover", s);
    const r = scan(root);
    // Membership must not change: T-446's `classifyResumable` already declines
    // to offer recovery for these, and re-deriving that here is how the two
    // implementations drift.
    expect(r.resumableSessions).toHaveLength(1);
    const [d] = r.diagnostics;
    expect(d?.kind).toBe("lease-undetermined");
    expect(d?.category).toBe("undetermined");
  });

  it("an unadmitted record with an EXPIRED lease AND a known state is SILENT -- determinate, and ubiquitous", () => {
    // Narrow on purpose: silence here is earned by BOTH axes being determinate.
    // The state axis is exercised separately below, because that is where the
    // exclusion was over-broad.
    const root = makeRoot();
    writeState(root, "stale", activeState(expired));
    const r = scan(root);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  /**
   * The lease is determinate here, so the round-1 exclusion would silence these
   * -- but membership in `resumableSessions` is decided by comparing `state` to
   * "COMPACT", and an undetermined state fails that comparison silently. The
   * record then never reaches the guard, so its `unknown-workflow-state` gate --
   * which exists precisely to stop an undetermined state reading as a valid
   * non-COMPACT one -- never runs. Each of these may be a corrupted COMPACT
   * recovery session.
   */
  describe("expired + compactPending, but the STATE is undetermined", () => {
    it.each([
      ["a non-string state", 42],
      ["a state typo", "COMPCT"],
      ["an absent state", undefined],
    ])("%s is reported as an omission", (_label, state) => {
      const root = makeRoot();
      const s = activeState({ ...expired, compactPending: true, state });
      if (state === undefined) delete s.state;
      writeState(root, "corrupt-compact", s);
      const r = scan(root);
      expect(r.activeSessions).toEqual([]);
      expect(r.resumableSessions).toEqual([]);
      // The kind names the axis that FAILED. Here the lease is positively
      // expired and the state is the undetermined one, so a consumer grouping by
      // kind must not be told this is a lease problem.
      const d = r.diagnostics.find((x) => x.kind === "unadmitted-state-undetermined");
      expect(d, `no omission emitted: ${JSON.stringify(r.diagnostics)}`).toBeDefined();
      expect(d!.category).toBe("omission");
      expect(d!.reason).toContain("not a known workflow state");
      expect(r.diagnostics.some((x) => x.kind === "unadmitted-lease-undetermined")).toBe(false);
    });
  });

  it.each([
    ["missing", {}],
    ["invalid", { lease: { expiresAt: "not-a-date" } }],
  ])("an unadmitted record with a %s lease IS reported -- it vanishes and was never established", (state, over) => {
    const root = makeRoot();
    const s = activeState(over);
    if (state === "missing") delete s.lease;
    writeState(root, "orphan", s);
    const r = scan(root);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
    const [d] = r.diagnostics;
    expect(d?.kind).toBe("unadmitted-lease-undetermined");
    expect(d?.category).toBe("omission");
  });

  it("a COMPACT record without compactPending and a missing lease is also reported", () => {
    const root = makeRoot();
    const s = activeState({ state: "COMPACT", compactPending: false });
    delete s.lease;
    writeState(root, "half", s);
    expect(kinds(scan(root).diagnostics)).toEqual(["unadmitted-lease-undetermined"]);
  });
});

describe("compactPending is a third membership axis", () => {
  const expired = { lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() } };

  // `compactPending` decides membership in `resumableSessions` exactly as the
  // state and the lease do, and the scanner coerces it with `=== true`. That
  // coercion turns any present non-boolean into a determinate `false`, so an
  // expired COMPACT record carrying one drops out of BOTH populations while the
  // other two axes look perfectly determinate -- a silent concealment behind a
  // scan that reports itself complete.
  it.each([
    ["a string", "true"],
    ["a number", 1],
    ["null", null],
    ["an object", { pending: true }],
  ])("%s compactPending on an expired COMPACT record is reported", (_label, value) => {
    const root = makeRoot();
    const s = activeState({ ...expired, state: "COMPACT", compactPending: value });
    writeState(root, "compact-odd", s);
    const r = scan(root);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
    const [d] = r.diagnostics;
    expect(d?.kind, `no omission emitted: ${JSON.stringify(r.diagnostics)}`).toBe(
      "unadmitted-compact-pending-undetermined",
    );
    expect(d?.category).toBe("omission");
    expect(d?.reason).toContain("rather than a boolean");
  });

  it.each([
    ["a string", "true"],
    ["a number", 1],
    ["an object", { pending: true }],
  ])("%s compactPending on an expired NON-COMPACT record stays SILENT", (_label, value) => {
    // The field cannot have changed either population here: `isResumable` is
    // already false because the state is not COMPACT, and the expired lease
    // determinately excludes it from `activeSessions`. Diagnosing it would be a
    // false stop on a stale record that is fully explicable -- a leftover
    // malformed `compactPending` on an expired IMPLEMENT session.
    const root = makeRoot();
    writeState(root, "stale-implement", activeState({ ...expired, state: "IMPLEMENT", compactPending: value }));
    const r = scan(root);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("an UNKNOWN state wins over a malformed compactPending", () => {
    // Both fields are independently malformed, and both would earn a diagnostic
    // on their own. The state one takes precedence: a record whose `state`
    // cannot be read cannot be reasoned about at all, so whether
    // `compactPending` would have affected membership is not a question this
    // build can reach. Reporting both would give the operator two findings for
    // one unusable record, the second of them unanswerable.
    const root = makeRoot();
    writeState(root, "both-bad", activeState({ ...expired, state: "NOT_A_STATE", compactPending: "true" }));
    expect(kinds(scan(root).diagnostics)).toEqual(["unadmitted-state-undetermined"]);
  });

  it.each([["absent", undefined], ["boolean false", false]])(
    "%s compactPending stays SILENT -- both are determinate observations",
    (_label, value) => {
      // The distinction the new axis draws is determinate-vs-not, not
      // admitted-vs-not. An expired COMPACT record that is genuinely not pending
      // is a shape every project accumulates: all three axes read cleanly, it
      // belongs in neither population, and reporting it would be the false
      // positive that makes an operator stop trusting the warnings.
      const root = makeRoot();
      const s = activeState({ ...expired, state: "COMPACT", compactPending: value });
      if (value === undefined) delete s.compactPending;
      writeState(root, "compact-plain", s);
      const r = scan(root);
      expect(r.activeSessions).toEqual([]);
      expect(r.resumableSessions).toEqual([]);
      expect(r.diagnostics).toEqual([]);
    },
  );

  it("a boolean TRUE with an expired lease is admitted and silent", () => {
    const root = makeRoot();
    writeState(root, "compact-true", activeState({ ...expired, state: "COMPACT", compactPending: true }));
    const r = scan(root);
    expect(r.resumableSessions).toHaveLength(1);
    expect(r.diagnostics).toEqual([]);
  });
});

describe("a session from a newer storybloq is reported, not classified", () => {
  // The scanner has its own hand-rolled field reads and never goes through
  // `readSessionStrict`, so the version fence has to exist in both. Without it
  // the two disagree about one directory: the CLI says "needs upgrade" while
  // this scanner hands the guard an ordinary record read under a schema that may
  // have moved -- and that record can carry a PERMISSIVE verdict.
  it("emits an omission and admits it to neither population", () => {
    const root = makeRoot();
    writeState(root, "from-the-future", activeState({ schemaVersion: 99 }));
    const r = scan(root);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
    const [d] = r.diagnostics;
    expect(d?.kind).toBe("state-version-skew");
    expect(d?.category).toBe("omission");
    expect(d?.sessionId).toBe(UUID);
    // Never framed as damage, and never offered deletion...
    expect(d?.reason).toContain("Do NOT delete it");
    // ...and it does not promise recoverability either. "Not lost" says a
    // compatible reader would still get the session back, which this fence
    // cannot establish: it interpreted only `schemaVersion` and returned before validating the remaining fields.
    expect(d?.reason).not.toContain("is NOT lost");
    // ...and never vouched for either. This fence fires on the version field
    // alone and returns before the rest is validated, so an incomplete or
    // writer-invalid record reaches the same branch as a perfectly good one.
    expect(d?.reason).toContain(
      "nothing here establishes that it is damaged OR that it is sound",
    );
    expect(d?.reason).not.toMatch(/is INTACT/i);
  });

  /**
   * `schemaVersion` is split THREE ways, not two.
   *
   * The earlier rule here was "only a NEWER version is a problem", justified by
   * three claims that do not hold. An OLDER schema can move a field's meaning
   * just as a newer one can. The legacy shape is the ABSENT field, not an
   * explicit `0`, so accepting `0` was never required for legacy support. And
   * the choice was never between admitting the record and going blind.
   *
   * So:
   *  - ABSENT        the documented legacy shape. Silent, classified.
   *  - NEWER number  `state-version-skew`. Not classified at all.
   *  - anything else `schema-version-undetermined`, WHEN the record is
   *                  otherwise admitted. ADMITTED, so the operator still sees
   *                  the session -- and BLOCKING, so the guard withholds the
   *                  aggregate rather than answering over fields read under a
   *                  schema the file does not claim.
   *
   * The last row carries a condition, and it is load-bearing. A record excluded
   * by one of the field-based gates -- a terminal-looking `status`, a
   * SESSION_END -- never reaches either population, so its unsupported version
   * is reported under `unadmitted-schema-version-undetermined` instead: an
   * omission, because the record really is missing from what was reported. The
   * tests below cover both. Saying every present unsupported value is admitted
   * would describe the case this scanner most needs to get right as though it
   * could not happen.
   *
   * The admitted row is the point: visibility and refusal-to-act are not in
   * tension. A record that vanishes tells an operator less than one that is
   * named.
   */
  it.each([
    ["a lower version", 0],
    ["a string", "1"],
    ["null", null],
    ["absent", undefined],
    // "admitted", not "classified": this runs the SCANNER and asserts membership
    // in `activeSessions`. Classification happens later, in the guard, and can
    // drop the record at deduplication first.
  ])("%s schemaVersion is NOT a skew and is still ADMITTED", (_label, value) => {
    const root = makeRoot();
    const st = activeState({ schemaVersion: value });
    if (value === undefined) delete st.schemaVersion;
    writeState(root, "ordinary", st);
    const r = scan(root);
    expect(r.diagnostics.some((x) => x.kind === "state-version-skew")).toBe(false);
    // Admission is the half that does not change: dropping the record would
    // leave the operator with "the scan concealed something" in place of a
    // named session.
    expect(r.activeSessions).toHaveLength(1);
  });

  it("does not CRASH building the diagnostic for a value JSON.stringify cannot encode", () => {
    // The reporting path is where an unsupported schema gets described, and the
    // description reaches for `JSON.stringify` on a value parsed out of a file
    // this build has already decided it cannot interpret. The encoder recurses,
    // so it raises RangeError well before the parser does -- 20000 nested arrays
    // parse without complaint and then blow the stack on the way out. A guard
    // whose contract is to fail closed on an untrusted payload must not fail by
    // crashing: the caller is left with no verdict at all, which is strictly
    // worse than the `unverifiable` this diagnostic was being written to
    // produce. That makes it a denial of service authored by a file on disk.
    const root = makeRoot();
    // Written as TEXT, because the fixture helper would hit the same encoder
    // limit trying to produce it -- which is itself the point: the value is
    // reachable by `JSON.parse` and unreachable by `JSON.stringify`, and only a
    // file on disk has to cross that gap.
    const deep = `${"[".repeat(20000)}${"]".repeat(20000)}`;
    const base = activeState() as Record<string, unknown>;
    delete base.schemaVersion;
    writeState(root, "deep", `{"schemaVersion":${deep},${JSON.stringify(base).slice(1)}`);

    const r = scan(root);
    const d = r.diagnostics.find((x) => x.kind.endsWith("schema-version-undetermined"));
    expect(d, JSON.stringify(r.diagnostics.map((x) => x.kind))).toBeDefined();
    // Reported as unrenderable rather than omitted: "the field could not be
    // rendered" is a finding about the record, and dropping it would leave the
    // reader assuming the value was ordinary.
    expect(d!.reason).toContain("unserializable");
  });

  it("and BOUNDS a value that encodes but would bury the sentence around it", () => {
    // The other half. A large-but-shallow value encodes fine and produces a
    // reason megabytes long, in an incident report someone is reading to find
    // out whether another agent is running. Burying that answer is its own
    // denial of service, so the rendering is capped -- and says what it cut, or
    // a reader cannot tell a field from a payload built to flood the line.
    const root = makeRoot();
    writeState(root, "wide", activeState({ schemaVersion: "x".repeat(20000) }));

    const r = scan(root);
    const d = r.diagnostics.find((x) => x.kind.endsWith("schema-version-undetermined"))!;
    expect(d.reason.length).toBeLessThan(2000);
    // The EXACT magnitude, not just the word. Reporting "truncated from" with a
    // wrong or constant number is the same failure as reporting nothing: the
    // number exists so a reader can tell an ordinary field from a payload built
    // to bury the line, and a number that does not track the payload cannot.
    const expected = JSON.stringify("x".repeat(20000)).length;
    expect(d.reason).toContain(`truncated from ${expected} characters`);
  });

  it("but an ABSENT version is the only SILENT one", () => {
    // The legacy shape, and the only value that earns no annotation. T-446's
    // fixtures write no `schemaVersion`, so this is also what keeps the frozen
    // matrix exercised.
    const root = makeRoot();
    const st = activeState();
    delete st.schemaVersion;
    writeState(root, "ordinary", st);
    expect(scan(root).diagnostics).toEqual([]);
  });

  it.each([
    ["a lower version", 0],
    ["a string", "1"],
    ["null", null],
    ["an object", { v: 1 }],
  ])("%s schemaVersion is admitted WITH a blocking diagnostic", (_label, value) => {
    const root = makeRoot();
    writeState(root, "ordinary", activeState({ schemaVersion: value }));
    const r = scan(root);
    const d = r.diagnostics.find((x) => x.kind === "schema-version-undetermined");
    expect(d, JSON.stringify(value)).toBeDefined();
    expect(d!.category).toBe("undetermined");
    expect(d!.sourceDir).toBe("ordinary");
    // Named, not concealed -- and the remedy never suggests destroying it.
    expect(d!.reason).toContain("observed and admitted");
    expect(d!.reason).toContain("Do not delete it.");
    // It claims ADMISSION, which is what this point in the scan establishes --
    // not classification, which happens later and can still drop the record.
    expect(d!.reason).not.toContain("reported above");
    expect(r.activeSessions).toHaveLength(1);
  });

  it.each([
    ["a terminal status", { status: "completed" }],
    ["a SESSION_END state", { state: "SESSION_END" }],
    ["both at once", { status: "completed", state: "SESSION_END" }],
  ])(
    "becomes an UNADMITTED omission when %s would have retired the record",
    (_label, terminal) => {
      // Three ways to be wrong here and only one that holds.
      //
      // `schema-version-undetermined` is out: it annotates an ADMITTED record,
      // and the guard reads it beside an empty population as an invariant
      // violation -- which is what happened when it was emitted before these
      // gates.
      //
      // A silent drop is also out, and that is the one this replaces. Both
      // gates decide the record no longer bears on the project by reading
      // `status` and `state`, and under a schema this build does not support it
      // cannot say what either string means. An older schema that used one of
      // them differently makes a live session disappear from the populations
      // AND from the diagnostics, completeness reads `complete`, and the
      // aggregate is free to answer `free` over it.
      //
      // So: not reported as a session, reported as an OMISSION. The category is
      // the honest one -- a record really is missing from the populations --
      // and it withholds the aggregate on the completeness axis.
      const root = makeRoot();
      writeState(root, "done", activeState({ schemaVersion: 0, ...terminal }));
      const r = scan(root);

      expect(r.activeSessions).toEqual([]);
      expect(r.resumableSessions).toEqual([]);
      expect(r.diagnostics.some((x) => x.kind === "schema-version-undetermined")).toBe(false);

      const d = r.diagnostics.find((x) => x.kind === "unadmitted-schema-version-undetermined");
      expect(d, JSON.stringify(r.diagnostics)).toBeDefined();
      expect(d!.category).toBe("omission");
      expect(d!.sourceDir).toBe("done");
      // It has to say WHY the terminal-looking fields were not believed, or the
      // next reader deletes the branch as redundant with the gates below it.
      expect(d!.reason).toContain("read under a schema the file does not claim");
      expect(d!.reason).toContain("Do not delete it.");
    },
  );

  it("and the aggregate is withheld for it, rather than answering `free`", () => {
    // The consequence that makes the kind load-bearing. A silent drop here left
    // an empty project and a clean scan, which is the most permissive answer
    // the guard has, over a record it could not read.
    const root = makeRoot();
    writeState(root, "done", activeState({ schemaVersion: 0, status: "completed" }));
    const v = classifySessionGuard(scan(root), {
      client: "claude",
      task: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(v.scanCompleteness).toBe("incomplete");
    expect(v.overallAction).toBe("unverifiable");
  });

  it("but STILL diagnoses a present directory with no state.json", () => {
    // The control. The two cases differ only in whether the DIRECTORY is there,
    // so a fix that skips on the state-file probe alone would silence this one
    // too -- and this one is a real gap: a session being created looks exactly
    // like this, and so does one whose state file was deleted.
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "half-created"), { recursive: true });

    const r = scan(root);
    const d = r.diagnostics.find((x) => x.kind === "state-missing");
    expect(d, JSON.stringify(r.diagnostics)).toBeDefined();
    expect(d!.sourceDir).toBe("half-created");
    expect(d!.category).toBe("omission");
  });

  it("and when an EXPIRED LEASE would have retired it just as quietly", () => {
    // The third exclusion path, and the one the status/SESSION_END pre-gate
    // walks straight past. This record calls itself active with a known
    // non-COMPACT state, so it clears that gate -- and then a live-lease check
    // and a COMPACT check admit it to neither population, and it leaves through
    // the unadmitted branch, where every diagnostic is conditioned on a field
    // being INDETERMINATE. Here they all look determinate, so it left in
    // silence, and the scan reported itself `complete` over a session it could
    // not read.
    //
    // "Determinate" is the claim that does not survive. `expired` is a reading
    // of `lease.expiresAt` and `IMPLEMENT` is a reading of `state`, both made
    // under a schema the file does not claim, so neither is an observation.
    const root = makeRoot();
    writeState(
      root,
      "stale-looking",
      activeState({
        schemaVersion: 0,
        status: "active",
        state: "IMPLEMENT",
        lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
      }),
    );
    const r = scan(root);

    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
    const d = r.diagnostics.find((x) => x.kind === "unadmitted-schema-version-undetermined");
    expect(d, JSON.stringify(r.diagnostics)).toBeDefined();
    expect(d!.category).toBe("omission");
    expect(d!.sourceDir).toBe("stale-looking");
    // It has to name the two readings that excluded it, or the next reader
    // cannot tell this branch from the status/SESSION_END one.
    expect(d!.reason).toContain("its lease reads");
    expect(d!.reason).toContain("its state reads");
    expect(d!.reason).toContain("neither is established");
  });

  it("and that shape reaches the guard as `unverifiable`, not `free`", () => {
    // The whole point: a silent drop here left an EMPTY project on a scan that
    // called itself complete, which is the most permissive answer the guard has.
    const root = makeRoot();
    writeState(
      root,
      "stale-looking",
      activeState({
        schemaVersion: 0,
        status: "active",
        state: "IMPLEMENT",
        lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
      }),
    );
    const v = classifySessionGuard(scan(root), {
      client: "claude",
      task: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(v.scanCompleteness).toBe("incomplete");
    expect(v.overallAction).toBe("unverifiable");
    expect(v.sessions).toEqual([]);
  });

  it("while the SAME shape under a supported schema stays silent", () => {
    // The control that keeps the gate conditioned on the version rather than
    // removed. An expired, non-COMPACT active session is the ordinary residue
    // every project accumulates; diagnosing those would put a healthy project
    // into `unverifiable` on every invocation.
    const root = makeRoot();
    writeState(
      root,
      "stale-looking",
      activeState({
        status: "active",
        state: "IMPLEMENT",
        lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
      }),
    );
    const r = scan(root);
    expect(r.diagnostics).toEqual([]);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
  });

  it("an ABSENT status is ACTIVE, because the schema declares that default", () => {
    // The scanner reads `status` by hand, so it has to honour the same defaults
    // the schema applies or it becomes the one component that disagrees.
    // `SessionStateSchema` declares `.default("active")`, which means a record
    // written before the field existed is active everywhere else in this
    // codebase -- and answering `status-undetermined` for it drops it from both
    // populations and blocks the project on a session nothing is wrong with.
    const root = makeRoot();
    writeState(root, "legacy-nostatus", activeState({ status: undefined }));
    const r = scan(root);

    expect(r.diagnostics, JSON.stringify(r.diagnostics)).toEqual([]);
    expect(r.activeSessions.map((x) => x.sourceDir)).toEqual(["legacy-nostatus"]);
  });

  it("but a PRESENT unrecognized status is still undetermined", () => {
    // The control. The default covers an ABSENT field; a value that is there
    // and unreadable is a different claim, and retiring the record on it would
    // be the silent drop this whole kind exists to stop.
    const root = makeRoot();
    writeState(root, "weird", activeState({ status: "paused" }));
    const r = scan(root);

    const d = r.diagnostics.find((x) => x.kind === "status-undetermined");
    expect(d, JSON.stringify(r.diagnostics)).toBeDefined();
    expect(d!.category).toBe("omission");
    expect(r.activeSessions).toEqual([]);
  });

  it("a non-UUID STRING sessionId is substituted too, not just a non-string one", () => {
    // `typeof x === "string"` was the whole test, and the schema says
    // `z.string().uuid()`. So `"not-a-session-id"` was accepted as identity by
    // the scanner and rejected by every strict reader -- and identity is not a
    // display concern here: this value becomes the DEDUPLICATION key and the
    // key the guard correlates diagnostics on. Two records sharing an invalid
    // id would have been collapsed into one collision on a value that
    // establishes nothing.
    const root = makeRoot();
    writeState(root, "bad-id", activeState({ sessionId: "not-a-session-id" }));
    const r = scan(root);

    const d = r.diagnostics.find((x) => x.kind === "session-id-invalid");
    expect(d, JSON.stringify(r.diagnostics)).toBeDefined();
    expect(d!.category).toBe("normalized");
    expect(d!.sourceDir).toBe("bad-id");
    // Substituted, not dropped: the record is still admitted and still gets its
    // ordinary verdict, which is what `normalized` means.
    expect(r.activeSessions.map((x) => x.sessionId)).toEqual(["bad-id"]);
  });

  it("and an EMPTY-string sessionId, which is the one that could merge records", () => {
    // The concrete hazard behind the rule above. Two records both carrying `""`
    // would deduplicate against each other as though they were one session --
    // dropping one before classification, on an id that identifies nothing.
    const root = makeRoot();
    writeState(root, "empty-a", activeState({ sessionId: "" }));
    writeState(root, "empty-b", activeState({ sessionId: "" }));
    const r = scan(root);

    // Two distinct records, each keyed on its own directory. Not one collision.
    expect(r.activeSessions.map((x) => x.sessionId).sort()).toEqual(["empty-a", "empty-b"]);
    expect(r.diagnostics.filter((x) => x.kind === "duplicate-session-id")).toEqual([]);
    expect(r.diagnostics.filter((x) => x.kind === "session-id-invalid")).toHaveLength(2);
  });

  it("keys `state-undetermined` on the SUBSTITUTED id, so it correlates to its own record", () => {
    // Both fields unusable at once is the case that breaks: `sessionId` is
    // missing so the summary substitutes `sourceDir`, and `state` is unusable
    // so this diagnostic fires. Keyed on the raw embedded id it carried null,
    // while the record it describes is keyed by the directory name -- and the
    // guard correlates on `sessionId` AND `sourceDir` together, so it reported
    // this scanner's own diagnostic as matching neither population. An
    // invariant violation, over a record sitting in `activeSessions`.
    const root = makeRoot();
    writeState(root, "no-id-no-state", activeState({ sessionId: undefined, state: 7 }));
    const r = scan(root);

    const summary = r.activeSessions.find((s) => s.sourceDir === "no-id-no-state");
    expect(summary, JSON.stringify(r)).toBeDefined();

    const d = r.diagnostics.find((x) => x.kind === "state-undetermined");
    expect(d, JSON.stringify(r.diagnostics)).toBeDefined();
    // The two agree about what identifies this record, which is the whole
    // requirement -- not that the id has any particular value.
    expect(d!.sessionId).toBe(summary!.sessionId);
    expect(d!.sourceDir).toBe("no-id-no-state");
  });

  it("but a SUPPORTED-schema terminal record is still retired in silence", () => {
    // The control, and the reason the gate is conditioned on the version rather
    // than removed. Under a schema this build does support, `completed` means
    // completed -- and every project accumulates finished sessions, so blocking
    // on them would put the whole product into `unverifiable`.
    const root = makeRoot();
    writeState(root, "done", activeState({ status: "completed" }));
    const r = scan(root);
    expect(r.diagnostics).toEqual([]);
    expect(r.activeSessions).toEqual([]);
  });

  it.each([
    ["a lower version", 0],
    ["a string", "1"],
    ["null", null],
  ])("%s schemaVersion withholds the aggregate for the CALLER'S OWN session", (_label, value) => {
    // The relationship that could actually have gone permissive. A foreign live
    // session is already `monitor-only`, so pinning only that proved nothing --
    // it would have passed with no blocking diagnostic at all. Same owner is
    // where an unsupported version used to reach `continue`.
    const root = makeRoot();
    writeState(
      root,
      "ordinary",
      activeState({
        schemaVersion: value,
        ownerTask: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" },
      }),
    );
    const v = classifySessionGuard(scan(root), {
      client: "claude",
      task: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(v.overallAction).toBe("unverifiable");
    // The per-record verdict is PRESERVED. Withholding the aggregate is not the
    // same as discarding what was found.
    expect(v.sessions).toHaveLength(1);
    expect(v.primary?.relationship).toBe("same-owner");
    expect(v.overallRationale).toContain("not one this build supports");
  });

  it.each([
    ["a lower version", 0],
    ["a string", "1"],
    ["null", null],
  ])("%s schemaVersion withholds it for an UNOWNED COMPACT session too", (_label, value) => {
    // The other permissive outcome: an unowned COMPACT session is the migration
    // path that resumes automatically. Auto-resuming a session whose fields were
    // read under a schema it does not claim is the worst of the three.
    const root = makeRoot();
    writeState(
      root,
      "ordinary",
      activeState({ schemaVersion: value, state: "COMPACT", compactPending: true }),
    );
    const v = classifySessionGuard(scan(root), {
      client: "claude",
      task: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(v.overallAction).toBe("unverifiable");
    expect(v.sessions).toHaveLength(1);
  });

  it("and an ABSENT version still reaches the permissive answer", () => {
    // The control. Without it the two rows above would pass just as well if the
    // guard had started withholding for every session, which would be the large
    // false stop the split exists to avoid.
    const root = makeRoot();
    const st = activeState({ ownerTask: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" } });
    delete st.schemaVersion;
    writeState(root, "ordinary", st);
    const v = classifySessionGuard(scan(root), {
      client: "claude",
      task: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(v.overallAction).toBe("continue");
  });

  it("correlates to the SUBSTITUTED id when `sessionId` is unusable too", () => {
    // The two annotations meet on one record, and the correlation is what
    // breaks if the kind reports the id it READ rather than the id the record
    // is REPORTED under. An invalid `sessionId` makes the summary substitute
    // the directory name, so a diagnostic carrying the raw embedded value --
    // null here -- matches no reported session, and the guard's correlation
    // reads that as an invariant violation: it tells the operator the scan
    // result is malformed and to obtain a fresh one, over a record sitting
    // right there in `activeSessions` with a real file to inspect.
    const root = makeRoot();
    const st = activeState({ schemaVersion: 0 });
    delete st.sessionId;
    writeState(root, "ordinary", st);
    const r = scan(root);

    // Both annotations, on the same admitted record.
    expect(r.activeSessions).toHaveLength(1);
    expect(r.activeSessions[0]!.sessionId).toBe("ordinary");
    const version = r.diagnostics.find((x) => x.kind === "schema-version-undetermined");
    expect(version).toBeDefined();
    expect(r.diagnostics.some((x) => x.kind === "session-id-invalid")).toBe(true);
    // The reported id, not the one on disk. `session-id-invalid` deliberately
    // carries null -- it is the diagnostic ABOUT the missing id -- but every
    // other kind has to name the record as the reader will see it.
    expect(version!.sessionId).toBe("ordinary");
    expect(version!.sourceDir).toBe("ordinary");

    // ...and the guard therefore names the file, rather than reporting that
    // nothing in the scan corresponds to the diagnostic.
    const v = classifySessionGuard(r, {
      client: "claude",
      task: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(v.overallAction).toBe("unverifiable");
    expect(v.sessions).toHaveLength(1);
    expect(v.overallRationale).toContain("ordinary");
    expect(v.overallRationale).not.toContain("matches neither a reported session");
  });

  it("and the strict reader really does reject them, so the asymmetry is real", () => {
    // Pins the disagreement as OBSERVED rather than asserted. If the strict
    // reader ever starts accepting these, this comment stops being true and the
    // scanner's leniency needs re-arguing.
    const root = makeRoot();
    writeState(root, "aaaa1111-2222-4333-8444-555555555555", activeState({ schemaVersion: 0 }));
    const r = readSessionStrict(join(root, ".story", "sessions", "aaaa1111-2222-4333-8444-555555555555"));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.failure.kind).toBe("unreadable");
  });
});

describe("a malformed `mode` is reported WITHOUT blocking", () => {
  // The one hand-read field whose substitution changes nothing: `mode` is
  // carried into the verdict for display and no rule branches on it. So it gets
  // the `normalized` category -- reported, but not concealment -- which is what
  // that category exists for. Promoting it to `omission` would stop the guard
  // for a cosmetic defect.
  it.each([
    ["a number", 3],
    ["null", null],
    ["an object", { mode: "auto" }],
  ])("%s is reported as normalized, and the record stays admitted", (_label, value) => {
    const root = makeRoot();
    writeState(root, "oddmode", activeState({ mode: value }));
    const r = scan(root);
    expect(r.activeSessions).toHaveLength(1);
    expect(r.activeSessions[0]!.mode).toBe("auto");
    const [d] = r.diagnostics;
    expect(d?.kind).toBe("mode-normalized");
    expect(d?.category).toBe("normalized");
    // Admission-scoped: the scanner admits, the guard classifies survivors, so
    // the reason may say no rule READS `mode` but not that a verdict was reached.
    expect(d?.reason).toContain("No ownership rule reads `mode`");
    expect(d?.reason).toContain("the scanner admitted the record");
  });

  it("does not make the scan incomplete", () => {
    const root = makeRoot();
    writeState(root, "oddmode", activeState({ mode: 3 }));
    const v = classifySessionGuard(scan(root), { task: null, client: "claude" });
    // `normalized` is not concealment, so the aggregate still stands.
    expect(v.scanCompleteness).toBe("complete");
    expect(v.overallAction).not.toBe("unverifiable");
  });

  it("an ABSENT or valid mode stays silent", () => {
    const root = makeRoot();
    const s = activeState();
    delete s.mode;
    writeState(root, "no-mode", s);
    writeState(root, "good-mode", activeState({ sessionId: "88888888-2222-4333-8444-555555555555", mode: "review" }));
    expect(scan(root).diagnostics).toEqual([]);
  });
});

describe("an ownerTask that is present but unreadable", () => {
  // The scanner normalizes an invalid owner id to null, and null means "legacy,
  // no owner recorded" to the guard -- which auto-resumes a live COMPACT legacy
  // session. So the substitution has to be visible, or a damaged owner reads as
  // no owner and another task's session gets taken over.
  it.each([
    ["an empty id", { client: "claude", id: "", boundAt: "2026-01-01T00:00:00.000Z" }],
    ["a non-string id", { client: "claude", id: 7, boundAt: "2026-01-01T00:00:00.000Z" }],
    ["an unknown client", { client: "emacs", id: "task-1", boundAt: "2026-01-01T00:00:00.000Z" }],
    ["a missing boundAt", { client: "claude", id: "task-1" }],
  ])("%s is reported as `undetermined`, and the record stays admitted", (_label, ownerTask) => {
    const root = makeRoot();
    writeState(root, "badowner", activeState({ ownerTask }));
    const r = scan(root);
    // Still ADMITTED, with its owner normalized to null -- T-446 froze that.
    // Only the fact that the owner could not be read is added. Admission is all
    // this assertion can show: it runs the SCANNER, and classification happens
    // later in the guard, which may drop this record at deduplication first.
    // The guard-side behaviour is covered end to end in session-guard.test.ts.
    expect(r.activeSessions).toHaveLength(1);
    expect(r.activeSessions[0]!.ownerTask).toBeNull();
    const [d] = r.diagnostics;
    expect(d?.kind, `nothing emitted: ${JSON.stringify(r.diagnostics)}`).toBe("owner-task-undetermined");
    // `undetermined`, not `omission`: the category contract reserves `omission`
    // for a record that VANISHED, and this one is right there in the population.
    // What is undetermined is its owner, and the aggregate is blocked on a
    // separate axis rather than by claiming the scan lost something.
    expect(d?.category).toBe("undetermined");
    expect(d?.reason).toContain("take over another task's session");
  });

  it.each([
    ["session-id-invalid", { sessionId: 7 }],
    ["state-undetermined", { state: 7 }],
    ["mode-normalized", { mode: 7 }],
  ])("no %s annotation is emitted for an unadmitted stale record either", (kind, over) => {
    // The invariant is uniform across every non-`omission` category: those
    // annotate a record that IS in a reported population. A determinately stale
    // session -- expired lease, not a recovery candidate -- is silent by design,
    // and hanging warnings on it would put noise on the ordinary leftovers every
    // project accumulates, describing a row the reader cannot see.
    const root = makeRoot();
    writeState(
      root,
      "stale",
      activeState({ ...over, lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() } }),
    );
    const r = scan(root);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
    expect(r.diagnostics.some((d) => d.kind === kind)).toBe(false);
  });

  it("is NOT emitted for a record admitted to neither population", () => {
    // The correctness of this diagnostic is the admission condition. An
    // unadmitted record produces no verdict, so nothing is decided from its
    // owner -- and emitting it anyway would block the aggregate of an UNRELATED
    // valid session standing beside it, with a rationale claiming the affected
    // session is reported above when it is not.
    const root = makeRoot();
    writeState(
      root,
      "stale-badowner",
      activeState({
        lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
        ownerTask: { client: "claude", id: "", boundAt: "2026-01-01T00:00:00.000Z" },
      }),
    );
    const r = scan(root);
    expect(r.activeSessions).toEqual([]);
    expect(r.resumableSessions).toEqual([]);
    expect(r.diagnostics.some((d) => d.kind === "owner-task-undetermined")).toBe(false);
  });

  it("an unadmitted malformed owner does not block an unrelated valid session", () => {
    // The end-to-end statement of the same thing, which is where it would
    // actually have hurt: a stale record with a damaged owner must not take a
    // healthy project to `unverifiable`.
    const root = makeRoot();
    writeState(
      root,
      "stale-badowner",
      activeState({
        sessionId: "88888888-2222-4333-8444-555555555555",
        lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
        ownerTask: { client: "claude", id: "", boundAt: "2026-01-01T00:00:00.000Z" },
      }),
    );
    writeState(
      root,
      "healthy",
      activeState({ ownerTask: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" } }),
    );
    const v = classifySessionGuard(scan(root), { task: { client: "claude", id: "me" }, client: "claude" });
    expect(v.overallAction).toBe("continue");
    expect(v.scanCompleteness).toBe("complete");
  });

  it("is admitted by the scanner, then dropped by deduplication without being claimed as a surviving session", () => {
    // The shape that broke the rationale's wording. Two directories share one
    // `sessionId`, the scanner admits BOTH, and deduplication then drops the one
    // carrying the malformed owner -- so the affected directory is named among
    // the collision details and is absent from `sessions`. "Admitted" and
    // "surviving" are different steps, and a duplicated session directory is
    // exactly how a damaged owner tends to arise, so this is not a corner.
    const root = makeRoot();
    writeState(
      root,
      "aaa-first",
      activeState({ ownerTask: { client: "claude", id: "me", boundAt: "2026-01-01T00:00:00.000Z" } }),
    );
    writeState(
      root,
      "zzz-second",
      activeState({ ownerTask: { client: "claude", id: "", boundAt: "2026-01-01T00:00:00.000Z" } }),
    );
    const r = scan(root);
    // Both admitted, so the diagnostic is emitted for the second.
    expect(r.activeSessions).toHaveLength(2);
    const owner = r.diagnostics.find((d) => d.kind === "owner-task-undetermined");
    expect(owner?.sourceDir).toBe("zzz-second");

    const v = classifySessionGuard(r, { task: { client: "claude", id: "me" }, client: "claude" });
    expect(v.overallAction).toBe("unverifiable");
    // The affected directory is NOT among the surviving sessions...
    expect(v.sessions.map((x) => x.sourceDir)).toEqual(["aaa-first"]);
    // ...so the rationale must name it, and must place it where it actually is.
    // Not a disjunction ("one place or the other") -- the guard correlates the
    // directory against the survivors and the dropped set and SAYS which.
    expect(v.overallRationale).toContain("zzz-second");
    expect(v.overallRationale).not.toContain("IS reported above");
    expect(v.overallRationale).toContain(
      "zzz-second was observed and admitted, then dropped by deduplication",
    );
    // And the surviving directory must not be swept into that same sentence.
    expect(v.overallRationale).not.toContain("aaa-first was observed and admitted");
  });

  it("leaves scan completeness alone, and blocks the aggregate anyway", () => {
    const root = makeRoot();
    writeState(root, "badowner", activeState({ ownerTask: { client: "claude", id: "", boundAt: "x" } }));
    const v = classifySessionGuard(scan(root), { task: { client: "claude", id: "me" }, client: "claude" });
    // Nothing vanished, so the scan is complete and the rationale must not tell
    // an operator to go looking for a session that is not missing.
    expect(v.scanCompleteness).toBe("complete");
    expect(v.overallRationale).not.toContain("could not account for");
    // And it is still withheld.
    expect(v.overallAction).toBe("unverifiable");
    expect(v.overallRationale).toContain("WHO owns it");
  });

  it("a genuinely ABSENT ownerTask stays silent", () => {
    // Absent is the legacy shape every pre-migration project has, and reporting
    // it would put all of them into `unverifiable`.
    const root = makeRoot();
    const s = activeState();
    delete s.ownerTask;
    writeState(root, "legacy", s);
    expect(scan(root).diagnostics).toEqual([]);
  });

  it("an explicit null ownerTask stays silent too", () => {
    const root = makeRoot();
    writeState(root, "explicit-null", activeState({ ownerTask: null }));
    expect(scan(root).diagnostics).toEqual([]);
  });

  it("a VALID ownerTask stays silent", () => {
    const root = makeRoot();
    writeState(
      root,
      "owned",
      activeState({ ownerTask: { client: "claude", id: "task-1", boundAt: "2026-01-01T00:00:00.000Z" } }),
    );
    const r = scan(root);
    expect(r.diagnostics).toEqual([]);
    expect(r.activeSessions[0]!.ownerTask?.id).toBe("task-1");
  });
});

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

describe("duplicate embedded session id", () => {
  it("reports ONE structured diagnostic carrying every directory, and keeps both records", () => {
    const root = makeRoot();
    writeState(root, "zzz", activeState());
    writeState(root, "aaa", activeState());
    const r = scan(root);
    // The scanner reports both faithfully; collapsing to one verdict is the
    // guard's job, per the Step 0.5 sentence it transcribes.
    expect(r.activeSessions).toHaveLength(2);
    const dupes = r.diagnostics.filter((d) => d.kind === "duplicate-session-id");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.category).toBe("collision");
    expect(dupes[0]!.conflictingSourceDirs).toEqual(["aaa", "zzz"]);
    expect(dupes[0]!.sessionId).toBe(UUID);
    // `aaa`/`zzz` are NOT canonical session ids, so `resolveSessionSelector`
    // would refuse them. Advertising `session show <dir>` here would hand the
    // operator a command that cannot resolve, at the moment they are trying to
    // work out which of the two sessions is real.
    expect(dupes[0]!.reason).toContain("not a canonical session id");
    // DESCRIPTIVE ONLY. A diagnostic is passed through verbatim at the typed and
    // Mode A seams, so a supplied payload can name a directory no deduplication
    // ever touched -- and this sentence is rendered by ordinary status output,
    // with no guard verdict in the picture. It may name what was seen and say
    // where to get an answer; it may not authorize a deletion.
    expect(dupes[0]!.reason).not.toContain("session delete");
    expect(dupes[0]!.reason).toContain("Run the session guard");
    expect(dupes[0]!.reason).toContain("do not delete anything on this diagnostic alone");
  });

  it("carries all THREE directories and infers no stale copy among them", () => {
    const root = makeRoot();
    writeState(root, "ccc", activeState());
    writeState(root, "aaa", activeState());
    writeState(root, "bbb", activeState());
    const [d] = scan(root).diagnostics.filter((x) => x.kind === "duplicate-session-id");
    expect(d!.conflictingSourceDirs).toEqual(["aaa", "bbb", "ccc"]);
    // One diagnostic for the id, not one per extra directory.
    expect(scan(root).diagnostics.filter((x) => x.kind === "duplicate-session-id")).toHaveLength(1);
    // All THREE named, so nothing is left behind when the operator goes to look
    // -- and still no instruction to remove any of them.
    expect(d!.reason).toContain("aaa, bbb, ccc");
    expect(d!.reason).toContain("do not delete anything on this diagnostic alone");
  });

  it("advertises the CLI selectors when EVERY colliding directory is canonical", () => {
    const root = makeRoot();
    const other = "88888888-2222-4333-8444-555555555555";
    writeState(root, UUID, activeState());
    writeState(root, other, activeState());
    const [d] = scan(root).diagnostics.filter((x) => x.kind === "duplicate-session-id");
    expect(d!.conflictingSourceDirs).toEqual([other, UUID].sort());
    // Both names resolve, so the INSPECT hint is the one worth giving -- that
    // is the part that differs by name shape. The cleanup command is not, at any
    // name shape, this surface's to offer.
    expect(d!.reason).toContain("storybloq session show <dir>");
    expect(d!.reason).not.toContain("session delete");
  });

  it("never puts a deletion instruction in ANY collision reason", () => {
    // Swept rather than asserted case by case: the reason text branches on name
    // shape, and it was the non-canonical branch that kept "delete every stale
    // directory by hand" after the canonical one had been cleaned up.
    for (const dirs of [["aaa", "zzz"], [UUID, "88888888-2222-4333-8444-555555555555"]]) {
      const root = makeRoot();
      for (const dir of dirs) writeState(root, dir, activeState());
      const [d] = scan(root).diagnostics.filter((x) => x.kind === "duplicate-session-id");
      for (const forbidden of ["session delete", "delete every", "remove every", "by hand"]) {
        expect(d!.reason, `${dirs.join("/")}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("does not fire for distinct ids", () => {
    const root = makeRoot();
    writeState(root, "a", activeState());
    writeState(root, "b", activeState({ sessionId: "99999999-2222-4333-8444-555555555555" }));
    expect(scan(root).diagnostics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aggregate properties
// ---------------------------------------------------------------------------

describe("the scan as a whole", () => {
  it("reports a mixed fault set in full, not just the first one", () => {
    const root = makeRoot();
    writeState(root, "zzz", activeState());
    writeState(root, "aaa", activeState());
    mkdirSync(join(root, ".story", "sessions", "broken", "state.json"), { recursive: true });
    expect(kinds(scan(root).diagnostics)).toEqual(["duplicate-session-id", "state-unreadable"]);
  });

  it("orders diagnostics deterministically", () => {
    const root = makeRoot();
    writeState(root, "zeta", '{"bad');
    writeState(root, "alpha", '{"bad');
    expect(scan(root).diagnostics.map((d) => d.sourceDir)).toEqual(["alpha", "zeta"]);
  });

  it("is empty on a healthy project", () => {
    const root = makeRoot();
    writeState(root, "fine", activeState());
    const r = scan(root);
    expect(r.activeSessions).toHaveLength(1);
    expect(r.diagnostics).toEqual([]);
  });

  /**
   * Shapes a healthy project really produces. Each would drive the hot ownership
   * guard to `unverifiable` for no reason, which is the way this fix can hurt
   * someone who has nothing wrong with their project.
   */
  describe("healthy shapes stay silent", () => {
    it("a `.story/sessions` that is itself a SYMLINK still scans normally", () => {
      // Containment canonicalizes the sessions root before comparing, so the
      // link resolves and every child is contained. Were that not so, EVERY
      // session on such a project would emit `entry-not-contained`.
      const root = mkdtempSync(join(tmpdir(), "storybloq-scan-"));
      roots.push(root);
      mkdirSync(join(root, ".story"), { recursive: true });
      const real = join(root, "real-sessions");
      mkdirSync(join(real, "s1"), { recursive: true });
      writeFileSync(join(real, "s1", "state.json"), JSON.stringify(activeState()));
      symlinkSync(real, join(root, ".story", "sessions"));
      const r = scan(root);
      expect(r.activeSessions).toHaveLength(1);
      expect(r.diagnostics).toEqual([]);
    });

    it("atomic-write leftovers in the sessions root stay silent", () => {
      const root = makeRoot();
      writeState(root, "s1", activeState());
      writeFileSync(join(root, ".story", "sessions", ".state.json.tmp"), "partial");
      writeFileSync(join(root, ".story", "sessions", "state.json.12345.tmp"), "partial");
      const r = scan(root);
      expect(r.activeSessions).toHaveLength(1);
      expect(r.diagnostics).toEqual([]);
    });

    it("a held .lock beside a real session leaves the verdict alone", () => {
      const root = makeRoot();
      writeState(root, "s1", activeState());
      mkdirSync(join(root, ".story", "sessions", ".lock"), { recursive: true });
      const r = scan(root);
      expect(r.activeSessions).toHaveLength(1);
      expect(r.diagnostics).toEqual([]);
    });

    /**
     * The exhaustive sweep. Every rule in this file is a judgement about which
     * shapes deserve to stop the guard, and the cost of getting one wrong is a
     * healthy project that cannot start work. This asserts the whole state
     * space at once, so a future widening cannot quietly take a valid state
     * with it.
     *
     * The invariant is NO OMISSION, not "unadmitted": these fixtures differ in
     * which population they land in -- a `COMPACT` record with
     * `compactPending: true` is admitted to `resumableSessions`, most of the
     * rest are admitted nowhere -- and that is not what is under test here.
     * What every one of them shares is that a valid state, expired or not,
     * conceals nothing and must raise no omission.
     */
    it.each(WORKFLOW_STATES.map((s) => [s] as const))(
      "an expired record in the valid state %s emits no omission, with and without compactPending",
      (state) => {
        for (const compactPending of [false, true]) {
          const root = makeRoot();
          writeState(
            root,
            "s1",
            activeState({
              state,
              compactPending,
              lease: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
            }),
          );
          const omissions = scan(root).diagnostics.filter((d) => d.category === "omission");
          expect(omissions, `${state} compactPending=${compactPending}`).toEqual([]);
        }
      },
    );

    it.each(WORKFLOW_STATES.filter((s) => s !== "SESSION_END").map((s) => [s] as const))(
      "a live record in the valid state %s is admitted with no diagnostic",
      (state) => {
        const root = makeRoot();
        writeState(root, "s1", activeState({ state }));
        const r = scan(root);
        expect(r.activeSessions).toHaveLength(1);
        expect(r.diagnostics).toEqual([]);
      },
    );

    it("a session's own auxiliary files and telemetry directory are invisible here", () => {
      const root = makeRoot();
      const dir = writeState(root, "s1", activeState());
      mkdirSync(join(dir, "telemetry"), { recursive: true });
      writeFileSync(join(dir, "plan.md"), "x");
      writeFileSync(join(dir, "events.log"), "{}\n");
      const r = scan(root);
      expect(r.activeSessions).toHaveLength(1);
      expect(r.diagnostics).toEqual([]);
    });
  });
});
