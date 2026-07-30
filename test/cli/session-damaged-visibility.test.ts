/**
 * Damaged sessions are visible, and the error names the field (ISS-897,
 * N-097 operator 4).
 *
 * Two defects, one file:
 *
 * 1. `storybloq session list` read through `listAllSessions`, which dropped any
 *    session whose `state.json` failed `safeParse`. That is the command the
 *    ownership guard's own rationale sends operators to when it cannot
 *    determine state -- so the tool of last resort concealed the very thing it
 *    was being consulted about.
 * 2. Every surface reported the constant "corrupt or unreadable". The operator
 *    in N-097 called that the worst DX moment in the product: zod knows exactly
 *    which field failed, and throwing that away turns a one-line fix into
 *    twenty minutes of schema archaeology.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleSessionList,
  handleSessionShow,
  handleSessionRepair,
} from "../../src/cli/commands/session.js";
import { handleSessionReport } from "../../src/cli/commands/session-report.js";
import {
  createSession,
  readSession,
  readSessionStrict,
  findSessionByIdDetailed,
  listAllSessions,
} from "../../src/autonomous/session.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-damaged-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

/**
 * A session that is real in every respect except one bad field.
 *
 * `codexUnavailableSince` is operator 4's ACTUAL case: declared
 * `z.string().optional()`, so an explicit null fails the whole parse and the
 * entire session becomes unreadable over a field that means nothing when absent.
 */
function damagedSession(root: string, over: Record<string, unknown>): string {
  const state = createSession(root, "default", "ws-1");
  const raw = JSON.parse(
    readFileSync(join(root, ".story", "sessions", state.sessionId, "state.json"), "utf-8"),
  ) as Record<string, unknown>;
  writeFileSync(
    join(root, ".story", "sessions", state.sessionId, "state.json"),
    JSON.stringify({ ...raw, ...over }),
  );
  return state.sessionId;
}

describe("session list surfaces damaged sessions", () => {
  it("renders a damaged row in text, naming the field and the selector to inspect it", async () => {
    const root = makeRoot();
    const id = damagedSession(root, { codexUnavailableSince: null });
    // Precondition: the strict reader really does reject it, so this test is
    // exercising concealment rather than a fixture that happens to parse.
    expect(readSession(join(root, ".story", "sessions", id))).toBeNull();
    // And the OLD api still drops it. This line is the measurement that makes
    // the assertions below meaningful, NOT an endorsement: `listAllSessions`
    // is what concealed the row, and every caller that makes a decision about
    // ownership or lifecycle has to use `listAllSessionsDetailed` instead.
    // `session-compact.ts` was the last one that did not -- a single bad field
    // made a task's own autonomous session vanish and its limit stop record as
    // `plain` -- and it now reads the detailed result and says so on stderr
    // when it cannot account for an entry.
    expect(listAllSessions(root)).toHaveLength(0);

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain(id);
    expect(out).toContain("corrupt");
    expect(out).toContain("codexUnavailableSince expected string, received null");
    expect(out).toContain(`storybloq session show ${id}`);
  });

  it("no decision-making caller is left on the dropping API", () => {
    // The plain API is kept for callers where dropping an unreadable session is
    // genuinely safe, and there is no type that separates those from the rest.
    // So the separation is asserted here: a caller that classifies, routes, or
    // decides ownership cannot use it, because an unparseable session is
    // indistinguishable from an absent one and the two lead to opposite
    // actions. `session-compact.ts` proved the point -- it decided
    // autonomous-vs-plain from a list that had silently dropped the session it
    // was deciding about.
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "cli", "commands", "session-compact.ts"),
      "utf-8",
    );
    expect(src, "session-compact must not classify from the dropping API").not.toMatch(
      /\blistAllSessions\s*\(/,
    );
    expect(src).toMatch(/\blistAllSessionsDetailed\s*\(/);
  });

  it("renders it regardless of the --status filter, because it has no status to filter on", async () => {
    const root = makeRoot();
    const id = damagedSession(root, { codexUnavailableSince: null });
    for (const status of ["active", "completed", "superseded"] as const) {
      const out = await handleSessionList(root, { status, format: "text" });
      expect(out, `--status ${status} hid the damaged row`).toContain(id);
    }
  });

  it("reports it in JSON under `damaged`, with structured issues", async () => {
    const root = makeRoot();
    const id = damagedSession(root, { codexUnavailableSince: null });
    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      sessions: unknown[];
      damaged: { sourceDir: string; reason: string; issues: { path: string; expected?: string; received?: string }[] }[];
    };
    expect(parsed.damaged).toHaveLength(1);
    expect(parsed.damaged[0]!.sourceDir).toBe(id);
    expect(parsed.damaged[0]!.issues[0]).toMatchObject({
      path: "codexUnavailableSince",
      expected: "string",
      received: "null",
    });
  });

  it("says `No sessions found.` only when there is genuinely nothing", async () => {
    const root = makeRoot();
    expect(await handleSessionList(root, { status: "all", format: "text" })).toBe("No sessions found.");
  });

  it("reports a directory with no state.json, because that is what the guard sent them here for", async () => {
    // It is tempting to omit this -- there is no record to show -- but the
    // scanner reports it as `state-missing` and the guard's remedy is "run
    // storybloq session list". A scan warning pointing at a command that shows
    // nothing is the same dead end this issue exists to remove. It is also the
    // observable shape of `createSession` between its mkdir and its first write.
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", "11111111-2222-4333-8444-999999999999"), { recursive: true });
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).not.toBe("No sessions found.");
    expect(out).toContain("11111111-2222-4333-8444-999999999999");
    expect(out).toContain("no readable state.json is in it");

    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      damaged: { sourceDir: string; reason: string }[];
      unavailable: { sourceDir: string; reason: string }[];
    };
    // `unavailable`, NOT `damaged`. The row is still surfaced -- that is what
    // this test is for -- but the collection NAME is a contract: the doc on
    // `damaged` says consumers treat it as repair-or-remove candidates, and a
    // directory mid-creation, or one behind a dangling link, is neither. Nothing
    // read the bytes here, so nothing may file it under a name that invites
    // destroying it.
    expect(parsed.damaged).toHaveLength(0);
    expect(parsed.unavailable).toHaveLength(1);
    expect(parsed.unavailable[0]!.reason).toContain("no readable state.json is in it");
  });

  it("offers a usable address for a NON-canonical damaged directory instead of a selector that would fail", async () => {
    // `listAllSessionsDetailed` accepts a contained directory of any name, but
    // `resolveSessionSelector` requires a canonical uuid -- so printing
    // `session show <name>` unconditionally hands the operator a command that
    // errors.
    const root = makeRoot();
    // A REAL damaged record, not an empty directory. An empty one has no
    // `state.json`, so it lands in `unavailable` and is rendered by a different
    // loop -- the damaged row's address fallback could regress entirely and
    // this test would stay green, having exercised the wrong collection.
    mkdirSync(join(root, ".story", "sessions", "legacy-dir"), { recursive: true });
    writeFileSync(join(root, ".story", "sessions", "legacy-dir", "state.json"), "{ not json");

    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      damaged: { sourceDir: string }[];
      unavailable: { sourceDir: string }[];
    };
    expect(parsed.damaged.map((d) => d.sourceDir), "fixture is not in `damaged`").toEqual(["legacy-dir"]);
    expect(parsed.unavailable).toHaveLength(0);

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain("legacy-dir");
    expect(out).not.toContain("session show legacy-dir");
    expect(out).toContain("not a session id");
  });
});

describe("session list JSON is ADDITIVE", () => {
  it("keeps every prior key on each element, and adds sourceDir", async () => {
    const root = makeRoot();
    const state = createSession(root, "default", "ws-1");
    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      sessions: Record<string, unknown>[];
    };
    // Pinned explicitly: these are the keys a consumer written before ISS-897
    // reads, and their MEANING must not have moved either.
    for (const key of [
      "sessionId",
      "status",
      "state",
      "leaseExpiresAt",
      "ticketId",
      "mode",
      "lastGuideCall",
    ]) {
      expect(Object.keys(parsed.sessions[0]!), `lost prior key ${key}`).toContain(key);
    }
    expect(parsed.sessions[0]!.sessionId).toBe(state.sessionId);
    expect(parsed.sessions[0]!.status).toBe("active");
    // The addition: the embedded id cannot distinguish two directories that
    // carry the same one, and this names the physical directory. It is a CLI
    // selector only when it matches `SESSION_ID_REGEX` -- this suite's own
    // `legacy-dir` and `.lock` cases are reported here and still refused by
    // `resolveSessionSelector`. For those, a consumer resolves this name
    // relative to `.story/sessions` rather than passing it to a session
    // command. (Scan DIAGNOSTICS carry a `sourcePath` for the same reason;
    // these session rows do not, and this assertion does not claim they do.)
    expect(parsed.sessions[0]!.sourceDir).toBe(state.sessionId);
  });
});

describe("the failing field is named at every surface", () => {
  it("session show", async () => {
    const root = makeRoot();
    const id = damagedSession(root, { codexUnavailableSince: null });
    await expect(handleSessionShow(root, id, { format: "text", events: 5 })).rejects.toThrow(
      /codexUnavailableSince expected string, received null/,
    );
  });

  it("session report", async () => {
    const root = makeRoot();
    const id = damagedSession(root, { codexUnavailableSince: null });
    const result = await handleSessionReport(id, root);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("codexUnavailableSince expected string, received null");
  });

  it("names a nested path with its array index", async () => {
    const root = makeRoot();
    const id = damagedSession(root, { lensReviewHistory: [{ disposition: "not-a-disposition" }] });
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain(id);
    // Not "lensReviewHistory: invalid" -- the operator needs the element too.
    expect(out).toMatch(/lensReviewHistory\[0\]/);
  });

  it("names a NON-STRING expected side, e.g. a numeric literal", async () => {
    // zod carries `expected` as a number for `z.literal(1)`, and testing only
    // for a string dropped the expected side entirely for a numeric field.
    //
    // `revision`, not `schemaVersion`: a present-but-unsupported version no
    // longer reaches the schema at all (it is fenced as `unsupported-version`,
    // see below), so it can no longer serve as the numeric-literal example. Any
    // numeric field will do -- what is under test is the rendering of a
    // non-string `expected`, not which field produced it.
    const root = makeRoot();
    const id = damagedSession(root, { revision: "not-a-number" });
    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      damaged: { sourceDir: string; issues: { path: string; expected?: string; received?: string }[] }[];
    };
    expect(parsed.damaged[0]!.sourceDir).toBe(id);
    const issue = parsed.damaged[0]!.issues.find((i) => i.path === "revision");
    expect(issue, `revision not named: ${JSON.stringify(parsed.damaged[0]!.issues)}`).toBeDefined();
    expect(issue!.expected).toBe("number");
  });

  it("treats a present-but-UNSUPPORTED schemaVersion as UNREAD, not as damage", async () => {
    // The two surfaces used to contradict each other about one file. The
    // scanner admitted the record, said the fields may not mean what this build
    // assumes, and warned against deleting it -- while `session list`/`show`/
    // `report` routed the same file through the schema and offered
    // `session delete`. One of those was telling the operator to destroy a
    // session over a version number, having established nothing about it.
    const root = makeRoot();
    const id = damagedSession(root, { schemaVersion: 0 });
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain(id);
    expect(out).toContain("does not support");
    expect(out).toContain("do NOT delete it");
    expect(out).not.toContain("session delete");
    // ...and it does not vouch for the file either. The version fence returns
    // BEFORE the schema runs, so a truncated state.json with `schemaVersion: 0`
    // lands here too and nothing has looked at its fields. "Intact" would be a
    // claim this path never established.
    expect(out).toContain("nothing here establishes that it is damaged OR that it is sound");
    expect(out).not.toMatch(/is intact/);
  });

  /**
   * The unsupported version is reported by SERIALIZING it, and the value being
   * serialized is one this build already refused to interpret (ISS-897).
   *
   * These two tests exist because the scanner-level coverage does not reach
   * here. `session list` is the command the ownership guard sends an operator
   * to, and the incompatible row is built by `describeIncompatible`, which
   * interpolates `rawVersion` -- an arbitrary JSON value out of a `state.json`.
   * A bare `JSON.stringify` there is both a crash and a flood, reachable from a
   * file on disk, on the surface of last resort.
   */
  function rawStateSession(root: string, appendJson: string): string {
    const state = createSession(root, "default", "ws-1");
    const path = join(root, ".story", "sessions", state.sessionId, "state.json");
    const text = readFileSync(path, "utf-8");
    // Appended, so it wins: JSON.parse keeps the LAST occurrence of a key. The
    // text is assembled by hand because the value is one `JSON.stringify`
    // cannot emit, which is the whole point of the fixture.
    writeFileSync(path, `${text.trimEnd().slice(0, -1)},${appendJson}}`);
    return state.sessionId;
  }

  it("reports an unserializable schemaVersion instead of crashing the listing", async () => {
    const root = makeRoot();
    // Deeper than the ENCODER can go, shallower than the PARSER refuses. The
    // asymmetry is the bug: this file loads without complaint and then kills
    // the report about it.
    const deep = `${"[".repeat(20000)}1${"]".repeat(20000)}`;
    const id = rawStateSession(root, `"schemaVersion":${deep}`);
    // Precondition: the fixture really is beyond the encoder, so this test is
    // exercising the guard rather than a value that would have been fine.
    expect(() => JSON.stringify(JSON.parse(deep) as unknown)).toThrow();

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain(id);
    expect(out, "the value is reported as unrenderable, not omitted").toContain("unserializable");
    expect(out).toContain("do NOT delete it");
  });

  it("bounds a huge schemaVersion and says how much it cut", async () => {
    const root = makeRoot();
    const flood = JSON.stringify(["x".repeat(50_000)]);
    const id = rawStateSession(root, `"schemaVersion":${flood}`);

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain(id);
    // Bounded...
    expect(out.length, "listing floods the screen").toBeLessThan(5_000);
    // ...and the cut is REPORTED with the original magnitude, so a reader can
    // tell an ordinary field from a payload built to bury the line it sits on.
    expect(out).toMatch(/truncated from \d+ characters/);
  });

  it("caps a wholly broken file rather than emitting an unbounded string", async () => {
    const root = makeRoot();
    const id = damagedSession(root, {
      sessionId: 1,
      recipe: 2,
      state: 3,
      revision: "x",
      status: 4,
      startedAt: 5,
    });
    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      damaged: { sourceDir: string; reason: string; issues: unknown[] }[];
    };
    expect(parsed.damaged[0]!.sourceDir).toBe(id);
    expect(parsed.damaged[0]!.issues.length).toBeLessThanOrEqual(3);
    // The cap is REPORTED, not hidden: a silently truncated diagnostic is the
    // same defect this work exists to fix.
    expect(parsed.damaged[0]!.reason).toMatch(/and \d+ more/);
  });
});

/**
 * Untrusted text reaches a terminal, so it is neutralized before it renders
 * (ISS-897, code review round 2).
 *
 * Both inputs on these paths come from outside the process: a directory name
 * chosen by whoever created it, and the contents of a `state.json` this build
 * could not validate. An ESC sequence in either one can recolour the screen or
 * move the cursor; a newline can forge a row that reads as a separate session.
 * Substitution keeps the surrounding name VISIBLE, which is what a reader
 * scans a list by; it is not identity-preserving, and nothing here claims it
 * is. Every dangerous code point becomes the same `?`, so two names differing
 * only in which one they carry render alike -- telling them apart is the
 * reversible ADDRESS's job, covered by the incompatible-row test below.
 *
 * These surfaces exist to be read during an incident, when the reader is
 * deciding whether another agent is running -- the worst moment to be shown a
 * fabricated line.
 *
 * The STRUCTURED output keeps the parsed values unmodified. Only the human rendering is
 * sanitized, so a JSON consumer still sees exactly what is on disk.
 */
describe("untrusted text is neutralized before rendering", () => {
  const ESC = String.fromCharCode(27);
  const FAKE_ID = "99999999-9999-4999-8999-999999999999";
  const NEWLINE = String.fromCharCode(10);

  it("strips control characters from a hostile directory name", async () => {
    const root = makeRoot();
    const hostile = `bad${ESC}[31m${NEWLINE}    ${FAKE_ID} healthy`;
    mkdirSync(join(root, ".story", "sessions", hostile), { recursive: true });
    writeFileSync(join(root, ".story", "sessions", hostile, "state.json"), "{}");

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(`m${NEWLINE}    ${FAKE_ID}`);
    // Replaced, not deleted: two names differing only by an invisible byte must
    // still look different, or an operator cannot tell the rows apart.
    expect(out).toContain("bad?[31m?");
  });

  it("strips them from the by-hand path too, not just the row label", async () => {
    // The row label was sanitized first; the absolute path printed underneath
    // for non-canonical names embeds the SAME name and was not, which made the
    // sanitizer decorative.
    const root = makeRoot();
    const hostile = `x${ESC}]0;pwned${String.fromCharCode(7)}`;
    mkdirSync(join(root, ".story", "sessions", hostile), { recursive: true });
    writeFileSync(join(root, ".story", "sessions", hostile, "state.json"), "{}");

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain("inspect by hand");
    expect(out).not.toContain(ESC);
  });

  // `status`, deliberately. It is a zod ENUM, and only `invalid_enum_value`
  // puts the file's actual bytes in `received` -- `invalid_type` reports a type
  // NAME ("string"), which carries nothing from disk. `state` looks like the
  // obvious choice and is not: it is a plain string by design (T-328 forward
  // compat), so any value parses and nothing reaches the renderer at all.
  const HOSTILE_VALUE = `${ESC}[2J${NEWLINE}fake row`;

  it("strips them from a schema value read out of the bad state.json", async () => {
    const root = makeRoot();
    const id = damagedSession(root, { status: HOSTILE_VALUE });
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain(id);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(`${NEWLINE}fake row`);
    expect(out).toContain("?[2J?fake row");
  });

  it.each([
    ["a paragraph separator", "\u2029"],
    ["a line separator", "\u2028"],
    ["a right-to-left override", "\u202e"],
    ["a first-strong isolate", "\u2066"],
  ])("neutralizes %s, which is not a C0 control", async (_label, ch) => {
    // None of these is a "control character" in the C0 sense, and all of them
    // defeat the point of a row that names a directory: U+2028/U+2029 are LINE
    // BREAKS to many renderers, and the bidi marks REORDER text visually
    // without changing a byte, so one directory can be made to display as
    // another.
    const root = makeRoot();
    const hostile = `dir${ch}name`;
    mkdirSync(join(root, ".story", "sessions", hostile), { recursive: true });
    writeFileSync(join(root, ".story", "sessions", hostile, "state.json"), "{}");
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).not.toContain(ch);
    expect(out).toContain("dir?name");
  });

  it("leaves the STRUCTURED value unmodified -- only the rendering is changed", async () => {
    const root = makeRoot();
    damagedSession(root, { status: HOSTILE_VALUE });
    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      damaged: { issues: { path: string; received?: string }[] }[];
    };
    const issue = parsed.damaged[0]!.issues.find((i) => i.path === "status");
    // JSON is not a terminal. A consumer diffing against the file on disk needs
    // what is actually there, and sanitizing here would silently corrupt it.
    expect(issue, JSON.stringify(parsed.damaged[0])).toBeDefined();
    expect(issue!.received).toBe(HOSTILE_VALUE);
  });
});

/**
 * "Not there" and "there but broken" are different answers (ISS-897).
 *
 * `readSessionStrict` learned to split ENOENT on `state.json` into
 * `missing-state`, which is the observable shape of `createSession` between its
 * mkdir and its first write. That split is only correct when the DIRECTORY
 * exists: reported for an absent session too, it calls a session that was never
 * created "corrupt", which sends an operator looking for damage that is not
 * there -- the same misdirection ISS-902 introduced this type to remove.
 */
describe("an absent session directory is missing, not corrupt", () => {
  it("reports `missing` when the directory does not exist", () => {
    const root = makeRoot();
    const r = readSessionStrict(join(root, ".story", "sessions", "no-such-session"));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.failure).toEqual({ kind: "missing" });
  });

  it("still reports `missing-state` when the directory exists without the file", () => {
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "half-created");
    mkdirSync(dir, { recursive: true });
    const r = readSessionStrict(dir);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.failure).toEqual({ kind: "unreadable", reason: "missing-state" });
  });

  it("a DANGLING session directory symlink is not-there-versus-broken, and reports broken", () => {
    // `existsSync` FOLLOWS the link and returns false for a dangling one, so it
    // cannot tell "no session was ever created here" from "a session directory
    // is right there and its target is gone". Reported as `missing`, the second
    // becomes an ordinary not-found: the CLI says no such session while an entry
    // sits in `.story/sessions` that an operator has to go look at. That is the
    // same concealment ISS-897 closes for `.story/sessions` itself, one level
    // down. `lstat` does not follow, so only an ENOENT from it proves absence.
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "dangling");
    symlinkSync(join(root, ".story", "sessions", "nowhere"), dir);
    const r = readSessionStrict(dir);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.failure).not.toEqual({ kind: "missing" });
    expect(r.ok ? null : r.failure?.kind).toBe("unreadable");
  });

  it("`session report` does not answer not-found for a dangling directory", async () => {
    // The reader fix was real and UNREACHABLE from here: this command had its
    // own `existsSync` precheck in front of it, so it exited "not found" before
    // `readSessionStrict` could classify anything. Asserting only at the reader
    // would have left the operator-visible behaviour exactly as it was, which
    // is the whole complaint N-097 filed.
    const root = makeRoot();
    const id = "aaaa1111-2222-4333-8444-666666666666";
    symlinkSync(join(root, ".story", "sessions", "nowhere"), join(root, ".story", "sessions", id));
    const r = await handleSessionReport(id, root, "text");
    expect(r.errorCode).not.toBe("not_found");
    expect(r.output).not.toContain("not found");
    // And it must not swap one unsupported claim for another: a dangling parent
    // establishes only that no readable state file can be REACHED, not that the
    // directory is intact or that the filename is unused.
    expect(r.output).toContain("an entry exists at that path, but no readable state.json is in it");
    expect(r.output).not.toContain("its directory exists");
    expect(r.output).not.toContain("state.json missing");
  });

  it("gives an INCOMPATIBLE row an address, like every other unreadable row", async () => {
    // The one row type that had no address line. This enumerator admits a
    // contained directory under ANY name, so a non-canonical incompatible
    // session could not be reached at all: the CLI selector refuses the name,
    // and the only identifier printed was the `sanitizeDisplayText` label,
    // which maps every dangerous code point to `?`. Two distinct directories
    // then render as the same name, on a row that says "inspect state.json"
    // and gives no unambiguous way to find it.
    const root = makeRoot();
    const ESC = String.fromCharCode(27);
    const RLO = "\u202e";
    // The two names differ in ONE code point and both of those code points
    // sanitize to `?`, so the labels are identical. Earlier this fixture used
    // `legacy<ESC>a` and `legacy<ESC>b`, which sanitize to `legacy?a` and
    // `legacy?b` -- already distinct, so it proved nothing about the address.
    for (const name of [`legacy${ESC}x`, `legacy${RLO}x`]) {
      const dir = join(root, ".story", "sessions", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 0, status: "active" }));
    }

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain("does not support");
    // The premise: both rows print the SAME lossy label, so the label alone
    // cannot tell an operator which directory either row is about.
    expect(out.split("legacy?x").length - 1, "labels do not collide").toBe(2);
    // ...and each row carries a REVERSIBLE address, so the two stay distinct.
    expect(out, "no address on the incompatible row").toContain("inspect by hand");
    expect(out).toContain("legacy\\u001bx");
    expect(out).toContain("legacy\\u202ex");
  });

  it("does not advertise a selector for a session-SHAPED entry that is not a directory", async () => {
    // `unavailable` deliberately admits a symlink of any name and a
    // session-shaped name on a non-directory, because the scanner diagnoses
    // both and this command is where its warnings send the operator. Those rows
    // then reach the address line, where the NAME passes the session-id regex
    // and the entry still cannot be resolved: `resolveSessionSelector` requires
    // a contained DIRECTORY. Printing the command over that hands the operator
    // an instruction that answers "not found" about a row this same output just
    // told them exists -- the dead end this issue closes, arriving as a wrong
    // instruction instead of as silence.
    const root = makeRoot();
    const id = "aaaa1111-2222-4333-8444-999999999999";
    // A session-SHAPED name on a plain file: passes the regex, is not a
    // directory, and is exactly what `entry-not-a-directory` reports.
    writeFileSync(join(root, ".story", "sessions", id), "not a session");

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out, "row missing").toContain(id);
    expect(out, "advertised a selector that cannot resolve").not.toContain(
      `storybloq session show ${id}`,
    );
    expect(out).toContain("inspect by hand");
    expect(out).toContain("this entry is not a directory");
  });

  it("a DANGLING `.story/sessions` is not an empty project", async () => {
    // `readdirSync` raises ENOENT for a dangling symlink exactly as it does for
    // a path that was never created, and the catch returned four empty arrays
    // for both. That says "this project has no sessions" about a root this
    // build could not enumerate -- and it says it in `storybloq session list`,
    // the command the guard's own rationale sends an operator to when it cannot
    // determine state. The scanner reports the same root as
    // `sessions-dir-unreadable`, so the two surfaces contradicted each other
    // about one path, with the concealing one being the tool of last resort.
    const root = makeRoot();
    rmSync(join(root, ".story", "sessions"), { recursive: true, force: true });
    symlinkSync(join(root, ".story", "nowhere"), join(root, ".story", "sessions"));

    // Precondition: this really is the ENOENT shape, not a different error.
    expect(existsSync(join(root, ".story", "sessions"))).toBe(false);
    expect(lstatSync(join(root, ".story", "sessions")).isSymbolicLink()).toBe(true);

    // It must NOT answer "no sessions". Either shape is acceptable -- a throw
    // the command renders, or a reported fault -- but the accepted throw has to
    // be the INTENDED one. A bare `catch { pass }` accepted any crash at all,
    // so an unrelated TypeError would have counted as the enumerator correctly
    // refusing to report an empty project.
    const outcome = await handleSessionList(root, { status: "all", format: "text" }).then(
      (out) => ({ kind: "resolved" as const, out }),
      (err: unknown) => ({ kind: "threw" as const, message: err instanceof Error ? err.message : String(err) }),
    );

    if (outcome.kind === "threw") {
      // Named, so a crash from somewhere else cannot pass as this refusal.
      expect(outcome.message, `unexpected failure: ${outcome.message}`).toMatch(
        /sessions directory|could not be (read|enumerated)|ENOENT/i,
      );
    } else {
      // Resolved: then it has to SAY there was a fault, not merely mention the
      // word "sessions" somewhere in a heading.
      expect(outcome.out, "reported an empty project over an unreadable root").toMatch(
        /unreadable|could not be read|could not be enumerated/i,
      );
      expect(outcome.out).not.toMatch(/no sessions/i);
    }
  });

  it("`session show` does not answer not-found for a dangling directory either", async () => {
    const root = makeRoot();
    const id = "aaaa1111-2222-4333-8444-777777777777";
    symlinkSync(join(root, ".story", "sessions", "nowhere"), join(root, ".story", "sessions", id));
    const err = await handleSessionShow(root, id, { format: "text" }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).not.toBeNull();
    // Not "not found" -- the entry is there. And not a claim that the DIRECTORY
    // exists either: it is a broken link, and telling an operator to create a
    // state.json inside it makes the write follow the link somewhere else.
    expect(err).not.toMatch(/not found/i);
    expect(err).not.toContain("the session directory exists");
    expect(err).toContain("an entry exists at that path");
  });

  it("findSessionByIdDetailed makes the same distinction", () => {
    // Its own pre-check had the same `existsSync` call, so fixing only the
    // readers would leave the single caller that reaches them still answering
    // `missing` before either could be consulted.
    const root = makeRoot();
    const id = "aaaa1111-2222-4333-8444-555555555555";
    symlinkSync(join(root, ".story", "sessions", "nowhere"), join(root, ".story", "sessions", id));
    const r = findSessionByIdDetailed(root, id);
    expect(r.kind).not.toBe("missing");
  });
});

/**
 * The `missing-state` reason has to survive to every surface, not just the one
 * that introduced it.
 *
 * `session list` learned to say "its directory exists but state.json is missing";
 * `session show` and `session report` are the two commands that message sends
 * operators to next, and each formats the failure independently. A surface that
 * still says "invalid state.json" sends someone looking for a file to inspect or
 * repair that is not there.
 */
describe("every surface distinguishes a missing state.json from an invalid one", () => {
  function halfCreated(root: string, id: string): void {
    mkdirSync(join(root, ".story", "sessions", id), { recursive: true });
  }

  const ID = "77777777-2222-4333-8444-555555555555";

  it("session list says an entry is there and the state file is not", async () => {
    const root = makeRoot();
    halfCreated(root, ID);
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain(ID);
    // Phrased on the ENTRY, not the directory. This reason is also reached by a
    // DANGLING directory symlink, where `readSessionStrict` established only
    // that the path is not absent -- so asserting the directory exists would be
    // false there and would tell an operator to write a state.json into a
    // broken link.
    expect(out).toContain("an entry exists at that path, but no readable state.json is in it");
    expect(out).not.toContain("invalid");
  });

  it("session show says it too", async () => {
    const root = makeRoot();
    halfCreated(root, ID);
    await expect(handleSessionShow(root, ID, { format: "text" })).rejects.toThrow(
      /an entry exists at that path, but no readable state\.json is in it/,
    );
  });

  it("session report says it too, rather than `invalid state.json`", async () => {
    const root = makeRoot();
    halfCreated(root, ID);
    const res = await handleSessionReport(ID, root, "text");
    // Evidence-neutral, matching `session show` and `session list`. The old
    // "state.json missing" came from a leaf `existsSync` precheck that a
    // dangling PARENT symlink also satisfied, so the command asserted a fact
    // about a path it could not reach. The read now classifies, and all three
    // surfaces say the same establishable thing.
    expect(res.output ?? "").toContain("an entry exists at that path, but no readable state.json is in it");
    expect(res.output ?? "").not.toContain("invalid state.json");
  });

  it("and session report still names the FIELD for a genuine schema failure", async () => {
    // The split must not have cost the detail it was built beside.
    const root = makeRoot();
    const id = damagedSession(root, { codexUnavailableSince: null });
    const res = await handleSessionReport(id, root, "text");
    expect(res.output ?? "").toContain("invalid state.json");
    expect(res.output ?? "").toContain("codexUnavailableSince");
  });

  it("and reports unparseable JSON as its own reason", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".story", "sessions", ID), { recursive: true });
    writeFileSync(join(root, ".story", "sessions", ID, "state.json"), '{"truncated"');
    const res = await handleSessionReport(ID, root, "text");
    expect(res.output ?? "").toContain("not valid JSON");
  });
});

/**
 * `session list` and the scanner must agree about `.lock` (ISS-897).
 *
 * The scanner treats `.lock` as reserved only when it is EMPTY, because this
 * enumerator admits a contained directory under any name and so `.lock` is a
 * name a real session can have. If `listAllSessionsDetailed` kept skipping the
 * name unconditionally, the guard would report a session that the command it
 * sends operators to cannot show -- the same dead end, moved one file over.
 */
describe("a populated .lock directory is a session, not a lock", () => {
  it("appears in session list", async () => {
    const root = makeRoot();
    const real = createSession(root, "default", "ws-1");
    const lock = join(root, ".story", "sessions", ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "state.json"),
      readFileSync(join(root, ".story", "sessions", real.sessionId, "state.json"), "utf-8"),
    );

    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      sessions: { sourceDir: string }[];
    };
    expect(parsed.sessions.map((x) => x.sourceDir)).toContain(".lock");
  });

  it("and a .lock holding anything ELSE is surfaced too", async () => {
    // The exemption is for the shape `proper-lockfile` creates, which holds
    // nothing. Asking instead whether `.lock/state.json` is absent answers
    // "this is a lock" for a `.lock` holding a pid file -- or, worse, for a
    // session directory caught between its mkdir and its state write, which is
    // a real session concealed under the one name that buys silence.
    const root = makeRoot();
    createSession(root, "default", "ws-1");
    const lock = join(root, ".story", "sessions", ".lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "12345");

    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      unavailable: { sourceDir: string; reason: string }[];
    };
    expect(parsed.unavailable.map((x) => x.sourceDir)).toContain(".lock");
  });

  it("while an EMPTY .lock stays invisible, as proper-lockfile intends", async () => {
    const root = makeRoot();
    createSession(root, "default", "ws-1");
    mkdirSync(join(root, ".story", "sessions", ".lock"), { recursive: true });
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).not.toContain(".lock");
  });
});

/**
 * A newer schema version is NOT corruption (ISS-897, ISS-902).
 *
 * `readSessionStrict` had no version fence, so a session written by a newer
 * build failed `safeParse` and arrived at every surface as ordinary corruption.
 * That is the one misclassification that can destroy data: the failure is a
 * READER failure, so the remedy is to upgrade the reader -- and `session show`
 * was offering `session delete --yes` instead, over a file it had established
 * nothing about. Note the claim being made here, and the one that is not: the
 * version is the wrong evidence for destroying the file. It is not evidence the
 * file is worth keeping either.
 *
 * Hence the constant below: the one sentence every version-fenced surface has
 * to be able to say. Both fences -- newer and unsupported -- return before
 * field validation, so each has established that this build did not interpret
 * the file and nothing whatsoever about its contents. Any surface that upgrades
 * that into "intact" is vouching for fields it never interpreted or validated.
 */
const NEUTRAL = "nothing here establishes that it is damaged OR that it is sound";

describe("a session from a newer storybloq reads as needing an upgrade, not as corrupt", () => {
  // ...but "not corrupt" is NOT "intact". The version fence returns before the
  // schema runs, so this build has read one number and nothing else. These
  // fixtures make that concrete: they carry a `schemaVersion` and no valid
  // session fields at all, and they still reach this branch. Asserting the
  // files are sound would pin a claim the fence is specifically designed not to
  // make, and would reject the evidence-neutral wording every other
  // version-fenced surface now uses.
  const ID = "66666666-2222-4333-8444-555555555555";

  function newerSession(root: string): string {
    return damagedSession(root, { schemaVersion: 99 });
  }

  it("readSessionStrict reports version-skew, not a schema failure", () => {
    const root = makeRoot();
    const id = newerSession(root);
    const r = readSessionStrict(join(root, ".story", "sessions", id));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.failure).toEqual({
      kind: "version-skew",
      writerVersion: 99,
      readerVersion: 1,
    });
  });

  it("session list says upgrade, and never says delete", async () => {
    const root = makeRoot();
    const id = newerSession(root);
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain(id);
    expect(out).toContain("needs-upgrade");
    expect(out).toContain("written by a newer storybloq");
    expect(out).toContain("do NOT delete it");
    expect(out).toContain(NEUTRAL);
    expect(out).not.toMatch(/is intact/);
  });

  it("is listed under `incompatible`, NOT under `damaged`", async () => {
    // The collection NAME is part of the contract. An automated consumer that
    // cleans up whatever is in `damaged` would destroy a session nothing found
    // anything wrong with, which
    // is why avoiding the word "corrupt" in the text output was not enough.
    const root = makeRoot();
    const id = newerSession(root);
    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      damaged: { sourceDir: string }[];
      incompatible: { sourceDir: string; writerVersion: number; readerVersion: number; reason: string }[];
    };
    expect(parsed.damaged.map((d) => d.sourceDir)).not.toContain(id);
    expect(parsed.incompatible.map((i) => i.sourceDir)).toContain(id);
    const entry = parsed.incompatible.find((i) => i.sourceDir === id)!;
    expect(entry.writerVersion).toBe(99);
    expect(entry.readerVersion).toBe(1);
    expect(entry.reason).toContain("do NOT delete it");
  });

  it("session show says upgrade, and never offers deletion", async () => {
    const root = makeRoot();
    const id = newerSession(root);
    await expect(handleSessionShow(root, id, { format: "text" })).rejects.toThrow(
      new RegExp(NEUTRAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    // Not "is NOT lost" either: that promises a compatible reader would get the
    // session back, and this fence read one number before returning.
    await expect(handleSessionShow(root, id, { format: "text" })).rejects.not.toThrow(/is NOT lost/);
    await expect(handleSessionShow(root, id, { format: "text" })).rejects.not.toThrow(
      /session delete/,
    );
    await expect(handleSessionShow(root, id, { format: "text" })).rejects.not.toThrow(/is intact/);
  });

  it("session repair refuses without suggesting deletion", async () => {
    // `repair`'s corrupt branch sends operators to `session delete`, which is
    // the one irreversible remedy in this command set.
    const root = makeRoot();
    const id = newerSession(root);
    // Refused, and NOT because the session was found to be fine: this build
    // could not determine the schema, so it could not determine the condition.
    // "Does not need repairing" was a finding the fence never made.
    await expect(handleSessionRepair(root, { selector: id, dryRun: false, all: false, yes: true })).rejects.toThrow(
      /could not determine the file's schema, and so could not determine its condition/,
    );
    await expect(handleSessionRepair(root, { selector: id, dryRun: false, all: false, yes: true })).rejects.not.toThrow(
      /session delete/,
    );
  });

  it("session report says upgrade and returns version_mismatch, not project_corrupt", async () => {
    const root = makeRoot();
    const id = newerSession(root);
    const res = await handleSessionReport(id, root, "text");
    expect(res.output ?? "").toContain(NEUTRAL);
    expect(res.output ?? "").not.toContain("is NOT lost");
    expect(res.output ?? "").not.toContain("corrupt");
    expect(res.output ?? "").toContain("Do NOT delete it");
    expect(res.errorCode).toBe("version_mismatch");
  });
});

/**
 * U+061C is a `Bidi_Control` too (ISS-897, review round 9).
 *
 * The first cut of the sanitizer covered the two obvious ranges and missed it,
 * which is the same class of character reached through a different script. This
 * test exists so the next partial range update fails here rather than shipping.
 */
describe("the sanitizer covers the whole Bidi_Control set", () => {
  // ALL TWELVE, not the endpoints. Testing only the ends of each range is what
  // lets a regression drop U+202B-U+202D or U+2067-U+2068 while staying green,
  // which is the exact failure this block was written to catch.
  it.each([
    ["U+061C ARABIC LETTER MARK", "\u061c"],
    ["U+200E LEFT-TO-RIGHT MARK", "\u200e"],
    ["U+200F RIGHT-TO-LEFT MARK", "\u200f"],
    ["U+202A LEFT-TO-RIGHT EMBEDDING", "\u202a"],
    ["U+202B RIGHT-TO-LEFT EMBEDDING", "\u202b"],
    ["U+202C POP DIRECTIONAL FORMATTING", "\u202c"],
    ["U+202D LEFT-TO-RIGHT OVERRIDE", "\u202d"],
    ["U+202E RIGHT-TO-LEFT OVERRIDE", "\u202e"],
    ["U+2066 LEFT-TO-RIGHT ISOLATE", "\u2066"],
    ["U+2067 RIGHT-TO-LEFT ISOLATE", "\u2067"],
    ["U+2068 FIRST STRONG ISOLATE", "\u2068"],
    ["U+2069 POP DIRECTIONAL ISOLATE", "\u2069"],
  ])("%s cannot survive into a rendered row", async (_label, ch) => {
    const root = makeRoot();
    const hostile = `dir${ch}name`;
    mkdirSync(join(root, ".story", "sessions", hostile), { recursive: true });
    writeFileSync(join(root, ".story", "sessions", hostile, "state.json"), "{}");
    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).not.toContain(ch);
    expect(out).toContain("dir?name");
  });
});

describe("a session that PARSES can still carry hostile content (ISS-897)", () => {
  // The sanitizer above defends the DIRECTORY NAME, which is filesystem data.
  // These are the fields INSIDE a state.json that passed the schema. `state` is
  // deliberately a free string (T-328) so a newer workflow state does not brick
  // an older reader, and `ticket.id`/`ticket.title` are equally unconstrained --
  // so "it parsed" says nothing about whether it is safe to print. These rows
  // are what an operator reads during an incident to decide whether another
  // agent is running, and a session must not be able to forge one.
  const ESC = "\u001b";
  const HOSTILE_STATE = `IMPLEMENT${ESC}[2K`;
  const HOSTILE_TICKET = "T-001\n0000  active     COMPLETE";

  function hostileSession(root: string): string {
    const st = createSession(root, "default", "ws-1");
    const file = join(root, ".story", "sessions", st.sessionId, "state.json");
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      file,
      JSON.stringify({
        ...raw,
        state: HOSTILE_STATE,
        ticket: { id: HOSTILE_TICKET, title: `Title${ESC}[31m`, claimed: false },
      }),
    );
    // Precondition: this is a HEALTHY session. If it stopped parsing, the test
    // would be exercising the damaged-row path instead of the readable one.
    expect(
      readSessionStrict(join(root, ".story", "sessions", st.sessionId)).ok,
      "fixture must still parse",
    ).toBe(true);
    return st.sessionId;
  }

  function assertNeutralized(out: string, label: string, keep = "IMPLEMENT") {
    expect(out, `${label}: raw ESC`).not.toContain(ESC);
    expect(out, `${label}: forged row`).not.toContain("\n0000  active");
    // Neutralized, not dropped: the operator still has to be able to tell which
    // session the row is about. (`session report` has no workflow-state line,
    // so it is identified by the ticket instead.)
    expect(out, `${label}: content lost`).toContain(keep);
  }

  it("session list neutralizes them in the readable table", async () => {
    const root = makeRoot();
    hostileSession(root);
    assertNeutralized(await handleSessionList(root, { status: "all", format: "text" }), "list");
  });

  it("session show neutralizes them", async () => {
    const root = makeRoot();
    const id = hostileSession(root);
    assertNeutralized(await handleSessionShow(root, id, { format: "text" }), "show");
  });

  it("session report neutralizes them", async () => {
    const root = makeRoot();
    const id = hostileSession(root);
    const res = await handleSessionReport(id, root, "text");
    // `res.output`, NOT `JSON.stringify(res)`. Stringifying encodes the ESC and
    // the newline itself, so every assertion below would pass over a report that
    // had rendered the value unsanitized -- the test would have proved only that
    // `JSON.stringify` works.
    // The success shape omits `isError` entirely, so assert the absence of a
    // failure rather than a literal `false`.
    expect(res.isError).toBeFalsy();
    assertNeutralized(res.output ?? "", "report", "T-001");
  });

  it("session report cannot have a LINK or an element injected into it", async () => {
    // A separate axis from the one above, and the reason it needs its own test:
    // `assertNeutralized` checks terminal controls and forged rows, which is a
    // question about BYTES. This is a question about STRUCTURE, and the report
    // is where it bites hardest -- `formatSessionReport` has exactly two
    // formats, `json` and `md`, so every non-JSON byte it emits is Markdown,
    // and `storybloq_session_report` hands that text straight to an MCP client
    // that may render it. A ticket title is session-controlled and unvalidated
    // beyond being a string, so without document escaping it can author a link,
    // a raw element or a code span inside the one document an operator reads
    // while deciding whether to intervene.
    const root = makeRoot();
    const st = createSession(root, "default", "ws-1");
    const file = join(root, ".story", "sessions", st.sessionId, "state.json");
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const payload =
      "[storybloq docs](https://elsewhere.example) <img src=x onerror=1> `code` **bold** _em_";
    writeFileSync(
      file,
      JSON.stringify({ ...raw, ticket: { id: "T-001", title: payload, claimed: false } }),
    );
    const res = await handleSessionReport(st.sessionId, root, "md");
    expect(res.isError).toBeFalsy();
    const out = res.output ?? "";

    // No structure survives.
    expect(out, "link").not.toContain("](https://elsewhere.example)");
    expect(out, "element").not.toContain("<img");
    expect(out, "code span").not.toMatch(/[^\\]`code`/);
    expect(out, "emphasis").not.toMatch(/[^\\]\*\*bold\*\*/);
    // Not even as an AUTOLINK, which escaping the brackets does not touch: a
    // bare `https://...` is clickable in GitHub-flavoured Markdown on its own,
    // so a payload that drops the `[text](...)` wrapper gets a live link out of
    // an escaper that appears to have neutralized it.
    expect(out, "autolink").not.toContain("https://elsewhere.example");

    // ...and the text is still THERE. Escaping that DROPPED the payload would
    // pass every assertion above while destroying the thing the report exists
    // to show: what the session actually claimed its ticket was called.
    expect(out).toContain("storybloq docs");
    expect(out).toContain("elsewhere.example");
    expect(out).toContain("bold");
    expect(out, "angle brackets left open").toContain("&lt;img");
  });

  it("but the JSON branch keeps the parsed values unmodified", async () => {
    // Sanitizing there would hand a consumer comparing against `state.json` a
    // value that is not in the file. `JSON.stringify` already encodes the
    // control characters, so they cannot break out of the string.
    //
    // Not "raw bytes": the file was decoded and parsed before this formatter
    // saw anything, so what is preserved is the parsed value, and the assertion
    // below now checks that value rather than only its encoding.
    const root = makeRoot();
    hostileSession(root);
    const out = await handleSessionList(root, { status: "all", format: "json" });
    expect(out).toContain("\\u001b");
    expect(out).not.toContain(ESC);
    const parsed = JSON.parse(out) as { sessions: { state: string }[] };
    expect(parsed.sessions[0]!.state, "the parsed value was altered").toBe(HOSTILE_STATE);
  });
});
