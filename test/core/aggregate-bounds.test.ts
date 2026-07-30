/**
 * Bounding each value does not bound the output (ISS-897).
 *
 * Every cap added earlier in this issue applies to ONE name, ONE serialization,
 * ONE reason. The prose they sit in joins collections whose SIZE is untrusted:
 * `.story/sessions` is workspace-controlled and a `SessionScanResult` is
 * caller-supplied at the typed seam. Forty capped names is still an enormous
 * sentence, in an MCP response an operator reads during an incident.
 *
 * Each test here floods a collection rather than a value, so it fails if only
 * the per-value cap is present. The count is asserted alongside the bound in
 * every case: a list that is shortened without saying so reads as the whole
 * set, which is a worse answer than either.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedList, boundedLines, MAX_LIST_BUDGET } from "../../src/core/bounded-list.js";
import { classifySessionGuard } from "../../src/core/session-guard.js";
import { formatStatus } from "../../src/core/output-formatter.js";
import { scanSessionSummaries } from "../../src/core/session-scan.js";
import type { ActiveSessionSummary, SessionScanDiagnostic } from "../../src/core/session-scan.js";
import { handleSessionList, handleSessionShow } from "../../src/cli/commands/session.js";
import { handleSessionReport } from "../../src/cli/commands/session-report.js";
import { createSession, probePath } from "../../src/autonomous/session.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "storybloq-bounds-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

describe("boundedList", () => {
  it("keeps entries WHOLE and reports the total it cut to", () => {
    const items = Array.from({ length: 200 }, (_, i) => `directory-number-${i}`);
    const out = boundedList(items, { noun: "directories" });

    expect(out.length).toBeLessThan(MAX_LIST_BUDGET + 80);
    expect(out).toMatch(/\(showing \d+ of 200 directories\)$/);
    // A name cut in half is a name that does not exist, and this output is
    // compared against a filesystem.
    for (const fragment of out.split(" ... ")[0]!.split(", ")) {
      expect(items, `partial entry rendered: ${fragment}`).toContain(fragment);
    }
  });

  it("says nothing about a total when it showed everything", () => {
    expect(boundedList(["a", "b"], { noun: "directories" })).toBe("a, b");
  });

  it("always emits one entry, even an over-long one", () => {
    // Better an over-long name than "showing 0 of 1": the entry's own renderer
    // is what bounds its length, and this function must not swallow the only
    // thing there is to say.
    const huge = "x".repeat(MAX_LIST_BUDGET * 2);
    expect(boundedList([huge, "b"], { noun: "directories" })).toContain(huge);
  });
});

describe("boundedLines", () => {
  it("passes a short list through untouched", () => {
    expect(boundedLines(["- a", "- b"], { maxLines: 5, noun: "x", fullSetHint: "h" })).toEqual(["- a", "- b"]);
  });

  it("cuts and says how many, and where the rest is", () => {
    const out = boundedLines(Array.from({ length: 40 }, (_, i) => `- ${i}`), {
      maxLines: 5,
      noun: "scan warnings",
      fullSetHint: "See JSON.",
    });
    expect(out).toHaveLength(6);
    expect(out[5]).toContain("35 more scan warnings (40 total)");
    expect(out[5]).toContain("See JSON.");
  });
});

describe("the guard's prose is bounded across the POPULATION (ISS-897)", () => {
  const caller = { task: { client: "claude" as const, id: "t1" }, claudeCodeSessionId: null };

  const summary = (dir: string, sessionId: string): ActiveSessionSummary =>
    ({
      sessionId,
      sourceDir: dir,
      state: "IMPLEMENT",
      mode: "auto",
      status: "active",
      ticketId: null,
      ticketTitle: null,
      leaseState: "live",
      leaseExpiresAt: null,
      compactPending: false,
      ownerTask: { client: "claude", id: "t1" },
    }) as unknown as ActiveSessionSummary;

  it("bounds the rationale over many sessions", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      summary(`dir-${String(i).padStart(4, "0")}`, `1111${String(i).padStart(4, "0")}-2222-4333-8444-555555555555`),
    );
    const v = classifySessionGuard({ activeSessions: many, resumableSessions: [] }, caller as never);

    expect(v.overallRationale!.length, "rationale grows with the population").toBeLessThan(4_000);
    // The COUNT is the answer; only the name list is cut.
    expect(v.overallRationale).toContain("300");
    expect(v.overallRationale).toMatch(/showing \d+ of 300 sessions/);
  });

  it("bounds the number of per-collision notes", () => {
    // One note per dropped duplicate, and each note is a paragraph.
    const collided = Array.from({ length: 200 }, (_, i) =>
      summary(`dir-${String(i).padStart(4, "0")}`, "aaaa1111-2222-4333-8444-555555555555"),
    );
    const v = classifySessionGuard({ activeSessions: collided, resumableSessions: [] }, caller as never);

    expect(v.transcriptionNotes.length, "one paragraph per event").toBeLessThan(20);
    // Nothing is LOST: every participant is still in the structured field.
    expect(v.collisions).toHaveLength(199);
  });

  it("bounds the directory list in a diagnostic rationale", () => {
    const diagnostics = Array.from({ length: 200 }, (_, i) => ({
      kind: "state-unreadable",
      category: "omission",
      sourceDir: `broken-${String(i).padStart(4, "0")}`,
      sourcePath: `/p/.story/sessions/broken-${i}/state.json`,
      sessionId: null,
      reason: "could not be read",
    })) as unknown as SessionScanDiagnostic[];
    const v = classifySessionGuard(
      { activeSessions: [], resumableSessions: [], diagnostics },
      caller as never,
    );
    const prose = [...v.transcriptionNotes, v.overallRationale ?? ""].join(" ");

    expect(prose.length, "prose grows with the diagnostic count").toBeLessThan(6_000);
    expect(prose).toMatch(/showing \d+ of 200/);
  });
});

describe("status output is bounded across the diagnostic count (ISS-897)", () => {
  it("caps the warning section and points at the full set", () => {
    const diagnostics = Array.from({ length: 300 }, (_, i) => ({
      kind: "state-unreadable" as const,
      category: "omission" as const,
      sourceDir: `broken-${i}`,
      sourcePath: `/p/.story/sessions/broken-${i}/state.json`,
      sessionId: null,
      reason: "could not be read",
    }));
    const md = formatStatus(
      {
        config: { project: "p" },
        completeLeafTicketCount: 0,
        leafTicketCount: 0,
        blockedCount: 0,
        activeIssueCount: 0,
        activeNoteCount: 0,
        archivedNoteCount: 0,
        activeLessonCount: 0,
        deprecatedLessonCount: 0,
        handoverFilenames: [],
        phases: [],
        tickets: [],
        roadmap: { phases: [] },
      } as never,
      "md",
      [],
      [],
      undefined,
      [],
      diagnostics,
    );

    expect(md.split("\n").filter((l) => l.startsWith("- **")).length).toBeLessThanOrEqual(21);
    expect(md).toContain("more scan warnings (300 total)");
    // The GAP COUNT is outside the bound: it is the finding, and the list is
    // only the address.
    expect(md).toContain("300 gaps");
  });
});

describe("a collision reason keeps its safety tail (ISS-897)", () => {
  it("bounds the directory list rather than letting the remedy be cut off", () => {
    const root = makeRoot();
    const id = "aaaa1111-2222-4333-8444-555555555555";
    for (let i = 0; i < 60; i += 1) {
      const dir = join(root, ".story", "sessions", `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "state.json"),
        // A LIVE lease, or the record is not admitted to `activeSessions` at
        // all and no collision is ever detected.
        JSON.stringify({
          sessionId: id,
          status: "active",
          state: "IMPLEMENT",
          mode: "auto",
          lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
        }),
      );
    }

    const d = scanSessionSummaries(root).diagnostics.find((x) => x.kind === "duplicate-session-id")!;
    expect(d, "fixture produced no collision").toBeDefined();
    // The count is stated, the list is cut...
    expect(d.reason).toContain("60 different directories");
    expect(d.reason).toMatch(/showing \d+ of 60 directories/);
    // ...and the tail an operator must read survived, which is what an
    // unbounded list took away once the Markdown renderer capped the reason.
    expect(d.reason).toContain("do not delete anything on this diagnostic alone");
    expect(d.reason.length).toBeLessThan(4_000);
    // Nothing is lost: the complete set is on the structured field.
    expect(d.conflictingSourceDirs).toHaveLength(60);
  });
});

describe("every per-record section of the session report is bounded (ISS-897)", () => {
  it("caps completed tickets and review rounds, keeping the counts", async () => {
    // Same untrusted `state.json` as the timeline. Bounding two sections of one
    // document and leaving the rest open is not a bound.
    // Built from a REAL session so the fixture stays valid as the schema moves;
    // hand-writing one drifts and fails as a parse error rather than as the
    // bound this test is about.
    const root = makeRoot();
    const id = createSession(root, "default", "ws-1").sessionId;
    const statePath = join(root, ".story", "sessions", id, "state.json");
    const base = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    const round = (n: number) => ({
      round: n,
      verdict: "approve",
      findingCount: 0,
      criticalCount: 0,
      majorCount: 0,
      suggestionCount: 0,
      reviewer: "codex",
      timestamp: new Date(0).toISOString(),
    });
    writeFileSync(
      statePath,
      JSON.stringify({
        ...base,
        completedTickets: Array.from({ length: 500 }, (_, i) => ({
          id: `T-${i}`,
          title: `ticket ${i}`,
          commitHash: "aaa",
        })),
        reviews: {
          ...(base.reviews as Record<string, unknown>),
          plan: Array.from({ length: 300 }, (_, i) => round(i)),
          code: Array.from({ length: 300 }, (_, i) => round(i)),
        },
      }),
    );

    const result = await handleSessionReport(id, root);
    const out = result.output;

    expect(out).toContain("more completed tickets (500 total)");
    expect(out).toContain("more plan review rounds (300 total)");
    expect(out).toContain("more code review rounds (300 total)");
    // The counts each section leads with are OUTSIDE the bound: they are the
    // answer, and the per-record lines are only the detail.
    expect(out).toContain("**Plan reviews:** 300 round(s)");
    expect(out).toContain("**Code reviews:** 300 round(s)");
    expect(out.length, "report grows with the record count").toBeLessThan(20_000);
  });
});

describe("a symlinked `.story/sessions` still proves absence (ISS-897)", () => {
  it("reports a missing session as missing, not as unreadable", () => {
    // A symlinked sessions root is a supported layout. The ancestor walk used
    // `lstat`, which answers "not a directory" for a perfectly healthy link --
    // so the first EXISTING ancestor of an absent session was the link, absence
    // became unprovable, and every not-found in such a project turned into
    // "could not be read".
    const root = makeRoot();
    const real = join(root, "elsewhere-sessions");
    mkdirSync(real, { recursive: true });
    rmSync(join(root, ".story", "sessions"), { recursive: true, force: true });
    symlinkSync(real, join(root, ".story", "sessions"));

    expect(probePath(join(root, ".story", "sessions", "never-created"))).toBe("absent");
  });

  it("still refuses to prove absence beneath a DANGLING link", () => {
    // The control. A dangling ancestor is present-and-unresolvable, which
    // establishes nothing about what is below it -- following the link must not
    // collapse that case into the one above.
    const root = makeRoot();
    rmSync(join(root, ".story", "sessions"), { recursive: true, force: true });
    symlinkSync(join(root, "nowhere-at-all"), join(root, ".story", "sessions"));

    expect(probePath(join(root, ".story", "sessions", "never-created"))).toBe("probe-failed");
  });
});

describe("the text session listing is bounded (ISS-897)", () => {
  it("caps each collection without splitting a row from its address", async () => {
    const root = makeRoot();
    for (let i = 0; i < 120; i += 1) {
      const dir = join(root, ".story", "sessions", `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), "{ not json");
    }

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).toContain("showing 50 of 120 damaged sessions");
    expect(out).toContain("--format json` for the complete set");
    // A cut entry would leave a fault named with no way to reach it, so every
    // rendered row must still be followed by its detail and its address.
    const rows = out.split("\n").filter((l) => l.includes("corrupt"));
    expect(rows).toHaveLength(50);
    expect(out.split("\n").filter((l) => l.trimStart().startsWith("state.json"))).toHaveLength(50);
  });
});

describe("`session show` bounds its per-session arrays too (ISS-897)", () => {
  it("caps completed tickets, resolved issues and the event tail", async () => {
    const root = makeRoot();
    const id = createSession(root, "default", "ws-1").sessionId;
    const dir = join(root, ".story", "sessions", id);
    const statePath = join(dir, "state.json");
    const base = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      statePath,
      JSON.stringify({
        ...base,
        completedTickets: Array.from({ length: 400 }, (_, i) => ({
          id: `T-${i}`,
          title: `t${i}`,
          commitHash: "aaaaaaaa",
        })),
        resolvedIssues: Array.from({ length: 400 }, (_, i) => `ISS-${i}`),
      }),
    );
    writeFileSync(
      join(dir, "events.log"),
      Array.from(
        { length: 400 },
        (_, i) => JSON.stringify({ rev: i, type: "tick", timestamp: new Date(0).toISOString() }),
      ).join("\n") + "\n",
    );

    // `--events` is caller-chosen and nothing capped it, so asking for the lot
    // rendered the lot.
    const out = await handleSessionShow(root, id, { format: "text", events: 400 });

    expect(out).toContain("more completed tickets (400 total)");
    expect(out).toContain("more resolved issues (400 total)");
    expect(out).toContain("more events (400 total)");
    expect(out.length, "detail view grows with the arrays").toBeLessThan(20_000);
  });
});

describe("session list JSON never throws on an untrusted schemaVersion (ISS-897)", () => {
  it("publishes a bounded serialization instead of the raw value", async () => {
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "aaaa1111-2222-4333-8444-555555555555");
    mkdirSync(dir, { recursive: true });
    const deep = `${"[".repeat(20000)}1${"]".repeat(20000)}`;
    // Parses fine; the ENCODER cannot emit it. Putting it straight into the
    // response object made the listing's own `JSON.stringify` throw.
    writeFileSync(
      join(dir, "state.json"),
      `{"sessionId":"aaaa1111-2222-4333-8444-555555555555","status":"active","schemaVersion":${deep}}`,
    );

    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      incompatible: { rawVersion?: unknown; rawVersionSerialization?: string }[];
    };
    expect(parsed.incompatible).toHaveLength(1);
    // A separate KEY, so a consumer can tell a serialization from a
    // `schemaVersion` that genuinely is a string.
    expect(parsed.incompatible[0]!.rawVersion).toBeUndefined();
    expect(parsed.incompatible[0]!.rawVersionSerialization).toBe("unserializable");
  });

  it("keeps the real value when it is small and encodable", async () => {
    const root = makeRoot();
    const dir = join(root, ".story", "sessions", "bbbb1111-2222-4333-8444-555555555555");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ sessionId: "bbbb1111-2222-4333-8444-555555555555", status: "active", schemaVersion: 0 }),
    );

    const parsed = JSON.parse(await handleSessionList(root, { status: "all", format: "json" })) as {
      incompatible: { rawVersion?: unknown; rawVersionSerialization?: string }[];
    };
    expect(parsed.incompatible[0]!.rawVersion).toBe(0);
    expect(parsed.incompatible[0]!.rawVersionSerialization).toBeUndefined();
  });
});
