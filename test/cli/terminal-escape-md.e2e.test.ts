/**
 * ISS-1281, through the built CLI: repo-sourced text reaches a terminal with
 * no raw control characters in Markdown output, while JSON output keeps every
 * byte (the formatter's own JSON, untouched by the write seam).
 *
 * The read commands run on a FIXED ledger written straight to `.story/` (fixed
 * ids, dates and paths, the hostile strings stored as JSON escapes, which is
 * the path a cloned repo takes). Create and update run through the CLI; their
 * ids and dates are not compared, only the hostile strings, exactly.
 *
 * Runs against the BUILT bundle: `npm run build` must have produced a current
 * dist/cli.js before this file can pass.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { E2ECliFixture, runE2ECli } from "../helpers/e2e-cli.js";

vi.setConfig({ testTimeout: 30_000 });

const ESC_TITLE = "Plain \u001b[31mRED\u001b[0m \u001b]0;pwned\u0007 end";
const HOSTILE = "x\u001b[31m \u001b]0;t\u0007 \u009b2J \u202e \u2028 y";
const DESCRIPTION = `first line ${HOSTILE}\nsecond\tline\r\nthird line`;
const EMOJI = [
  "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}",
  "\u{1F469}\u200d\u{1F4BB}",
  "\u26a0\ufe0f",
  "\u2764\ufe0f",
];
const EMOJI_TITLE = EMOJI.map((e) => `\u001b${e}\u001b`).join(" ");
const LONG = Array.from({ length: 40 }, (_, i) => `Clean line ${i + 1} of a long description, with nothing to replace in it at all.`).join("\n");

/** A terminal control left in Markdown output. LF and TAB are document structure. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const DATE = "2026-01-01";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/** The fixed ledger: every record and every field the read commands print is pinned. */
function plantLedger(dir: string): void {
  const story = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) mkdirSync(join(story, sub), { recursive: true });
  writeJson(join(story, "config.json"), {
    features: { handovers: true, issues: true, reviews: true, roadmap: true, tickets: true },
    language: "unknown", project: `proj ${HOSTILE}`, schemaVersion: 2, type: "generic", version: 2,
  });
  writeJson(join(story, "roadmap.json"), {
    blockers: [], date: DATE, title: "roadmap",
    phases: [{ description: `phase ${HOSTILE}`, id: "p0", label: "PHASE 0", name: `Setup ${HOSTILE}` }],
  });
  writeJson(join(story, "tickets", "T-001.json"), {
    blockedBy: [], completedDate: null, createdDate: DATE, description: DESCRIPTION, id: "T-001",
    order: 10, phase: "p0", status: "open", title: `ticket ${HOSTILE}`, type: "task",
  });
  writeJson(join(story, "tickets", "T-002.json"), {
    blockedBy: [], completedDate: null, createdDate: DATE, description: "emoji", id: "T-002",
    order: 20, phase: "p0", status: "open", title: EMOJI_TITLE, type: "task",
  });
  writeJson(join(story, "tickets", "T-003.json"), {
    blockedBy: [], completedDate: null, createdDate: DATE, description: LONG, id: "T-003",
    order: 30, phase: "p0", status: "open", title: "long clean description", type: "task",
  });
  writeJson(join(story, "issues", "ISS-001.json"), {
    components: [], discoveredDate: DATE, id: "ISS-001", impact: DESCRIPTION, location: [], phase: null,
    relatedTickets: [], resolution: null, resolvedDate: null, severity: "high", status: "open", title: `issue ${HOSTILE}`,
  });
  writeJson(join(story, "notes", "N-001.json"), {
    content: DESCRIPTION, createdDate: DATE, id: "N-001", status: "active", tags: [], title: `note ${HOSTILE}`, updatedDate: DATE,
  });
  writeJson(join(story, "lessons", "L-001.json"), {
    content: DESCRIPTION, context: `context ${HOSTILE}`, createdDate: DATE, id: "L-001", lastValidated: DATE,
    reinforcements: 0, source: "manual", status: "active", supersedes: null, tags: [], title: `lesson ${HOSTILE}`, updatedDate: DATE,
  });
}

let fixture: E2ECliFixture;
let fixed: string;
let scratch: string;

beforeAll(async () => {
  fixture = await E2ECliFixture.create();
  // Both ledgers live under the fixture root, so fixture.cleanup() removes them.
  fixed = join(fixture.root, "fixed");
  mkdirSync(fixed);
  plantLedger(fixed);
  scratch = join(fixture.root, "scratch");
  mkdirSync(scratch);
  const init = runE2ECli(fixture, ["init", "--name", "scratch"], { cwd: scratch });
  expect(init.status, init.stdout + init.stderr).toBe(0);
});

afterAll(async () => {
  await fixture.cleanup();
});

function run(cwd: string, args: string[], env?: Record<string, string>): { code: number | null; out: string; err: string } {
  const res = runE2ECli(fixture, args, { cwd, ...(env ? { env } : {}) });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

const READ_COMMANDS: string[][] = [
  ["ticket", "list"],
  ["ticket", "get", "T-001"],
  ["issue", "list"],
  ["issue", "get", "ISS-001"],
  ["note", "list"],
  ["lesson", "list"],
  ["recommend"],
  ["status"],
  ["export", "--all"],
];

describe("Markdown output holds no terminal controls (ISS-1281)", () => {
  it("E1: the issue's reproduction: create, list and get show ? where each control was", () => {
    const created = run(scratch, ["ticket", "create", "--title", ESC_TITLE, "--type", "task"]);
    expect(created.code, created.out).toBe(0);
    const expected = "Plain ?[31mRED?[0m ?]0;pwned? end";
    expect(created.out).toContain(expected);
    expect(created.out).not.toMatch(UNSAFE);
    const id = /T-\d+/.exec(created.out)![0];
    for (const args of [["ticket", "list"], ["ticket", "get", id]]) {
      const res = run(scratch, args);
      expect(res.code, args.join(" ")).toBe(0);
      expect(res.out, args.join(" ")).toContain(expected);
      expect(res.out, args.join(" ")).not.toMatch(UNSAFE);
    }
  });

  it.each(READ_COMMANDS.map((c) => [c.join(" "), c] as const))("E2: %s (md) has no control characters, and its line breaks and tabs survive", (_label, args) => {
    const res = run(fixed, [...args]);
    expect(res.code === 0 || res.code === 3, `${args.join(" ")}: ${res.out}${res.err}`).toBe(true);
    expect(res.out).not.toMatch(UNSAFE);
    // export escapes Markdown brackets, so its `[` and `]` arrive as `\[` and `\]`.
    const visible = args[0] === "export" ? "x?\\[31m ?\\]0;t? ?2J ? ? y" : "x?[31m ?]0;t? ?2J ? ? y";
    expect(res.out).toContain(visible);
  });

  it("E2: descriptions keep their line breaks and tabs, and CRLF reads as LF", () => {
    const res = run(fixed, ["ticket", "get", "T-001"]);
    expect(res.out).toContain("second\tline\nthird line");
    expect(res.out).not.toContain("?\nthird");
  });

  it("E2: create and update confirmations of every entity are sanitized", () => {
    const steps: string[][] = [
      ["ticket", "create", "--title", HOSTILE, "--type", "task", "--description", DESCRIPTION],
      ["ticket", "update", "T-001", "--title", HOSTILE],
      ["issue", "create", "--title", HOSTILE, "--severity", "low", "--impact", DESCRIPTION],
      ["issue", "update", "ISS-001", "--title", HOSTILE],
      ["note", "create", "--title", HOSTILE, "--content", DESCRIPTION],
      ["note", "update", "N-001", "--title", HOSTILE],
      ["lesson", "create", "--title", HOSTILE, "--content", DESCRIPTION, "--context", "c", "--source", "manual"],
      ["lesson", "update", "L-001", "--title", HOSTILE],
    ];
    for (const args of steps) {
      const res = run(scratch, args);
      expect(res.code, `${args.slice(0, 2).join(" ")}: ${res.out}${res.err}`).toBe(0);
      expect(res.out, args.slice(0, 2).join(" ")).not.toMatch(UNSAFE);
      expect(res.out, args.slice(0, 2).join(" ")).toContain("x?[31m ?]0;t? ?2J ? ? y");
    }
  });

  it("E3: ZWJ and VS16 emoji keep every byte; only the controls beside them become ?", () => {
    const res = run(fixed, ["ticket", "get", "T-002"]);
    expect(res.code).toBe(0);
    for (const e of EMOJI) expect(res.out).toContain(`?${e}?`);
    expect(res.out).not.toMatch(UNSAFE);
  });

  it("E7: a long clean multi-line description comes out byte for byte", () => {
    const res = run(fixed, ["ticket", "get", "T-003"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(LONG);
  });
});

describe("JSON output keeps every byte (ISS-1281)", () => {
  /** stdout is exactly the formatter's 2-space JSON, and every hostile string is in it verbatim. */
  function expectJsonIntact(out: string, label: string): unknown {
    const parsed = JSON.parse(out) as unknown;
    expect(out, label).toBe(JSON.stringify(parsed, null, 2) + "\n");
    // JSON.stringify escapes C0 but leaves C1, U+202E and U+2028 raw: those
    // bytes are on stdout exactly as stored, and the escaped form is exact.
    expect(out, label).toContain(JSON.stringify(HOSTILE).slice(1, -1));
    return parsed;
  }

  it.each(READ_COMMANDS.map((c) => [c.join(" "), c] as const))("E4: %s --format json", (label, args) => {
    const res = run(fixed, [...args, "--format", "json"]);
    expect(res.code === 0 || res.code === 3, `${label}: ${res.out}${res.err}`).toBe(true);
    expectJsonIntact(res.out, label);
  });

  it.each(READ_COMMANDS.map((c) => [c.join(" "), c] as const))("E4: %s --format json --raw", (label, args) => {
    const res = run(fixed, [...args, "--format", "json", "--raw"]);
    expect(res.code === 0 || res.code === 3, `${label}: ${res.out}${res.err}`).toBe(true);
    expectJsonIntact(res.out, `${label} --raw`);
  });

  it("E4: status --compact writes JSON whatever --format says, and it stays intact", () => {
    for (const args of [["status", "--compact"], ["status", "--compact", "--format", "md"]]) {
      const res = run(fixed, args);
      expect(res.code === 0 || res.code === 3, `${args.join(" ")}: ${res.out}${res.err}`).toBe(true);
      const parsed = expectJsonIntact(res.out, args.join(" ")) as { data: { project: string; phases: Array<{ name: string }> } };
      expect(parsed.data.project).toBe(`proj ${HOSTILE}`);
      expect(parsed.data.phases[0]!.name).toBe(`Setup ${HOSTILE}`);
    }
  });

  it("E4: create and update in JSON return the hostile strings exactly (ids and dates not compared)", () => {
    const steps: Array<[string[], string]> = [
      [["ticket", "create", "--title", HOSTILE, "--type", "task", "--description", DESCRIPTION], "title"],
      [["ticket", "update", "T-001", "--title", HOSTILE], "title"],
      [["issue", "create", "--title", HOSTILE, "--severity", "low", "--impact", DESCRIPTION], "title"],
      [["note", "create", "--title", HOSTILE, "--content", DESCRIPTION], "title"],
      [["lesson", "create", "--title", HOSTILE, "--content", DESCRIPTION, "--context", "c", "--source", "manual"], "title"],
    ];
    for (const [args, field] of steps) {
      const res = run(scratch, [...args, "--format", "json"]);
      expect(res.code, `${args.slice(0, 2).join(" ")}: ${res.out}${res.err}`).toBe(0);
      const parsed = expectJsonIntact(res.out, args.slice(0, 2).join(" ")) as { data: Record<string, unknown> };
      expect(parsed.data[field]).toBe(HOSTILE);
    }
  });

  it("E5: codex-review --format guide-report is JSON whatever the global format, so the report keeps every byte", async () => {
    const { verdictsForKind } = await import("../../src/cli/commands/codex-review.js");
    const verdict = verdictsForKind("plan")[0]!;
    const sessionId = "00000000-0000-0000-0000-000000001281";
    const sessionDir = join(fixed, ".story", "sessions", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "plan.md"), "# The plan\n", "utf-8");
    const now = "2026-01-01T00:00:00.000Z";
    writeJson(join(sessionDir, "state.json"), {
      schemaVersion: 1, sessionId, recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
      reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
      git: { branch: "main", mergeBase: "HEAD", expectedHead: "HEAD" },
      lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
      contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
      pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
      compactPending: false, compactPreparedAt: null, resumeBlocked: false,
      terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
      config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
      ticket: { id: "T-001", title: "t", claimed: true, risk: "low" },
      filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    });

    // A fixture-local codex first on PATH: it answers --version, and for
    // `exec ... -o <path> -` writes a fixed review carrying the hostile
    // strings. The real reviewer is never called.
    const stubs = join(fixture.root, "codex-stub");
    mkdirSync(stubs, { recursive: true });
    const review = {
      verdict,
      summary: HOSTILE,
      findings: [{
        severity: "minor", category: "x", description: HOSTILE, file: null, line: null, suggestion: null,
        recommendedNextState: null, principle: null, origin: null, originClass: null, sinceRound: null, dispositionReason: null,
      }],
    };
    writeFileSync(join(stubs, "review.json"), JSON.stringify(review), "utf-8");
    writeFileSync(
      join(stubs, "codex"),
      `#!${process.execPath}\n` +
        "const a = process.argv.slice(2);\n" +
        "if (a[0] === '--version') { console.log('codex 0.0.0-stub'); process.exit(0); }\n" +
        "const fs = require('node:fs');\n" +
        "const o = a[a.indexOf('-o') + 1];\n" +
        `fs.writeFileSync(o, fs.readFileSync(${JSON.stringify(join(stubs, "review.json"))}));\n` +
        "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n",
      "utf-8",
    );
    chmodSync(join(stubs, "codex"), 0o755);

    const res = run(fixed, ["codex-review", "plan", "--session", sessionId], { PATH: [stubs, process.env.PATH ?? ""].join(delimiter) });
    expect(res.code, res.out + res.err).toBe(0);
    const parsed = JSON.parse(res.out) as { verdict: string; notes: string; findings: Array<{ description: string }> };
    expect(res.out).toBe(JSON.stringify(parsed, null, 2) + "\n");
    expect(parsed.verdict).toBe(verdict);
    expect(parsed.notes).toBe(`route=native; ${HOSTILE}`);
    expect(parsed.findings[0]!.description).toBe(HOSTILE);
    expect(readFileSync(join(sessionDir, "review", "plan-codex-output.json"), "utf-8")).toBe(JSON.stringify(review));
  });
});
