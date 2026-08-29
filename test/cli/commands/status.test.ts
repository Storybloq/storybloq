import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleStatus } from "../../../src/cli/commands/status.js";
import { MAX_PROSE_LENGTH } from "../../../src/core/display-text.js";
import { formatStatus, formatFederatedStatus } from "../../../src/core/output-formatter.js";
import { makeState, makeTicket, makeRoadmap, makePhase } from "../../core/test-factories.js";
import { describeAddressableAgedAnomaly } from "../../../src/core/session-age.js";
import type { CommandContext } from "../../../src/cli/run.js";
import type { ActiveSessionSummary, SessionScanDiagnostic } from "../../../src/core/session-scan.js";
import type { LimitStopSummary } from "../../../src/core/limit-ledger.js";
import type { FederationState } from "../../../src/federation/state.js";
import type { Config } from "../../../src/models/config.js";

/**
 * ISS-893: a COMPLETE LimitStopSummary. The markdown section reads
 * clientTaskId, nextAttemptAt, status, mode, limitType and wakeAttempts, so a
 * partial cast would render "undefined" and pass the JSON assertions while
 * silently proving nothing about the markdown branch.
 */
const sampleLimitStop: LimitStopSummary = {
  key: "limit-key-1",
  clientTaskId: "task-abcdef01",
  storybloqSessionId: null,
  projectRoot: "/tmp/project",
  sessionType: "plain",
  status: "stopped",
  mode: "headless",
  limitType: "session",
  resetAt: Date.parse("2026-07-29T00:00:00Z"),
  nextAttemptAt: Date.parse("2026-07-29T00:05:00Z"),
  wakeAttempts: 0,
  generation: 1,
  reasonCode: null,
};

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

/**
 * The PLUMBING, not the formatter (ISS-897).
 *
 * Every other assertion in this file calls `formatStatus` or
 * `formatFederatedStatus` directly, so all of them would still pass if
 * `handleStatus` stopped forwarding `scanSessionSummaries(...).diagnostics`.
 * That is not a cosmetic regression: `sessionDiagnostics` is the CAPABILITY
 * signal a fallback reader uses to tell a verified-clean scan from a build that
 * cannot report one. Drop the field and every clean scan reads as `unknown`
 * completeness, which turns the permissive answer into a stop for every project
 * on the planet -- or, from the other direction, an absent field cannot be
 * distinguished from an empty one and a concealed session reads as no session.
 */
describe("handleStatus forwards the scanner's diagnostics", () => {
  // Every case here mints a project under the system temp directory, and
  // without this each local and CI run leaves another `.story` tree behind.
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "sb-status-"));
    roots.push(root);
    return root;
  }

  function ctxAt(root: string, format: "md" | "json" = "json"): CommandContext {
    return makeCtx({ format, root } as never);
  }

  it("emits an EMPTY array for a clean scan, not an absent field", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".story", "sessions"), { recursive: true });
    const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as {
      data: { sessionDiagnostics?: unknown };
    };
    expect(parsed.data.sessionDiagnostics).toEqual([]);
  });

  it("carries a real diagnostic through to the JSON payload", async () => {
    // A directory with no state.json: the scanner's `state-missing` omission.
    const root = tempRoot();
    mkdirSync(join(root, ".story", "sessions", "half-created"), { recursive: true });
    const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as {
      data: { sessionDiagnostics: { kind: string; category: string; sourceDir: string }[] };
    };
    expect(parsed.data.sessionDiagnostics).toHaveLength(1);
    expect(parsed.data.sessionDiagnostics[0]!.kind).toBe("state-missing");
    expect(parsed.data.sessionDiagnostics[0]!.category).toBe("omission");
    expect(parsed.data.sessionDiagnostics[0]!.sourceDir).toBe("half-created");
  });

  it("and through to the markdown warning block", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".story", "sessions", "half-created"), { recursive: true });
    const out = (await handleStatus(ctxAt(root, "md"))).output;
    expect(out).toContain("Session Scan Warnings");
    expect(out).toContain("half-created");
  });
});

describe("handleStatus: arrangements (T-473)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "sb-status-arr-"));
    roots.push(root);
    return root;
  }

  function writeArrangement(root: string, overrides: Record<string, unknown> = {}): void {
    mkdirSync(join(root, ".story", "arrangements"), { recursive: true });
    const arrangement = {
      id: "a-0123456789abcdef",
      lifecycle: "active",
      bounds: ["T-001"],
      parties: [
        { role: "pen", client: "claude", identityAnchor: "pen-session" },
        { role: "worker", client: "claude", identityAnchor: "worker-session" },
      ],
      gates: [],
      unreachability: { onIrreversibleWork: "hold" },
      createdDate: "2026-08-27",
      ...overrides,
    };
    writeFileSync(join(root, ".story", "arrangements", `${arrangement.id}.json`), JSON.stringify(arrangement));
  }

  function ctxAt(root: string, format: "md" | "json" = "json"): CommandContext {
    return makeCtx({
      format,
      root,
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    } as never);
  }

  it("renders an active arrangement in the JSON payload", async () => {
    const root = tempRoot();
    writeArrangement(root);
    const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as {
      data: { arrangements: { id: string; lifecycle: string }[]; arrangementWarnings: string[] };
    };
    expect(parsed.data.arrangements).toHaveLength(1);
    expect(parsed.data.arrangements[0]!.id).toBe("a-0123456789abcdef");
    expect(parsed.data.arrangements[0]!.lifecycle).toBe("active");
    expect(parsed.data.arrangementWarnings).toEqual([]);
  });

  it("renders an active arrangement in the Markdown output", async () => {
    const root = tempRoot();
    writeArrangement(root);
    const out = (await handleStatus(ctxAt(root, "md"))).output;
    expect(out).toContain("## Arrangements");
    expect(out).toContain("a-0123456789abcdef");
  });

  it("omits a closed arrangement from both formats", async () => {
    const root = tempRoot();
    writeArrangement(root, { lifecycle: "closed" });
    const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as {
      data: { arrangements: unknown[] };
    };
    expect(parsed.data.arrangements).toEqual([]);
    const out = (await handleStatus(ctxAt(root, "md"))).output;
    expect(out).not.toContain("## Arrangements");
  });

  it("T-478: reports an arrangement_gate_risk-shaped warning for a plan-ack-without-pre-commit-ack arrangement (ISS-1050 interim)", async () => {
    const root = tempRoot();
    writeArrangement(root, { gates: [{ name: "plan-ack", ackRole: "pen" }] });
    const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as { data: { arrangementWarnings: string[] } };
    expect(parsed.data.arrangementWarnings.some((w) => w.includes("plan-ack") && w.includes("pre-commit-ack") && w.includes("ISS-1050"))).toBe(true);
  });

  it("T-478: no gate-risk warning when both plan-ack and pre-commit-ack are configured", async () => {
    const root = tempRoot();
    writeArrangement(root, { gates: [{ name: "plan-ack", ackRole: "pen" }, { name: "pre-commit-ack", ackRole: "pen" }] });
    const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as { data: { arrangementWarnings: string[] } };
    expect(parsed.data.arrangementWarnings).toEqual([]);
  });

  it("reports a warning, not a failure, for a bound ref that no longer resolves", async () => {
    const root = tempRoot();
    writeArrangement(root, { bounds: ["T-999"] });
    const result = await handleStatus(ctxAt(root));
    expect(result.exitCode).toBeUndefined();
    const parsed = JSON.parse(result.output) as { data: { arrangementWarnings: string[] } };
    expect(parsed.data.arrangementWarnings.some((w) => w.includes("T-999") && w.includes("not found"))).toBe(true);
  });

  it("reports a warning, not a failure, for a corrupt arrangement file (binding item 2: never blocks status)", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".story", "arrangements"), { recursive: true });
    writeFileSync(join(root, ".story", "arrangements", "a-broken.json"), "{not json");
    const result = await handleStatus(ctxAt(root));
    expect(result.exitCode).toBeUndefined();
    const parsed = JSON.parse(result.output) as { data: { arrangements: unknown[]; arrangementWarnings: string[] } };
    expect(parsed.data.arrangements).toEqual([]);
    expect(parsed.data.arrangementWarnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("A2: a hostile bound ref cannot reach arrangementWarnings' 'not found' path at all -- TicketRefSchema/IssueRefSchema reject it at load time, surfacing only the already-sanitized schema-mismatch warning", async () => {
    // Every bound ref is validated against TicketRefSchema/IssueRefSchema
    // before an arrangement is ever accepted onto disk (^T-\d+[a-z]?$,
    // ^ISS-\d+$, or the canonical crockford forms) -- there is no character
    // class overlap with control/bidi/invisible characters, so a hostile ref
    // never survives to reach buildStatusArrangements' own "not found"/
    // "ambiguous" warning composition. It is rejected one layer earlier, by
    // loadArrangementsSafe's schema-mismatch check, whose warning is already
    // covered by the filename test above.
    const root = tempRoot();
    const hostileRef = "T-999\n​[fake-line]";
    writeArrangement(root, { bounds: [hostileRef] });
    const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as {
      data: { arrangements: unknown[]; arrangementWarnings: string[] };
    };
    expect(parsed.data.arrangements).toEqual([]);
    expect(parsed.data.arrangementWarnings).toHaveLength(1);
    expect(parsed.data.arrangementWarnings[0]).toContain("schema mismatch");
    expect(parsed.data.arrangementWarnings[0]).not.toContain("\n");
    expect(parsed.data.arrangementWarnings[0]).not.toContain("​");
  });

  it("A2: sanitizes a hostile arrangement filename before it reaches arrangementWarnings", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".story", "arrangements"), { recursive: true });
    // A directory-listing entry can legally contain control characters on
    // POSIX filesystems; loadArrangementsSafe must sanitize the filename it
    // echoes back, not just the ref values it resolves itself.
    writeFileSync(join(root, ".story", "arrangements", "a-broken\n​.json"), "{not json");
    const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as { data: { arrangementWarnings: string[] } };
    expect(parsed.data.arrangementWarnings).toHaveLength(1);
    expect(parsed.data.arrangementWarnings[0]).not.toContain("\n");
    expect(parsed.data.arrangementWarnings[0]).not.toContain("​");
  });

  describe("ISS-1077: node-qualified bounds", () => {
    function writeOrchestratorConfig(root: string, nodes: Record<string, { path: string }>): void {
      mkdirSync(join(root, ".story"), { recursive: true });
      writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
        version: 2, schemaVersion: 2, project: "orchestrator", type: "orchestrator", language: "typescript",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
        nodes: Object.fromEntries(Object.entries(nodes).map(([name, n]) => [name, { path: n.path, health: "grey", dependsOn: [], stack: "", role: "", summary: "" }])),
      }));
    }

    const CANONICAL_NODE_TICKET = "t-0123456789abcdef";

    function writeNodeProject(name: string, canonicalTicketId: string): string {
      const dir = mkdtempSync(join(tmpdir(), `sb-status-node-${name}-`));
      roots.push(dir);
      const storyDir = join(dir, ".story");
      mkdirSync(join(storyDir, "tickets"), { recursive: true });
      writeFileSync(join(storyDir, "config.json"), JSON.stringify({
        version: 2, schemaVersion: 2, project: name, type: "npm", language: "typescript",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      }));
      writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
        version: 2, title: "r", date: "2026-01-01", phases: [{ id: "p1", label: "P1", name: "P1", description: "" }], blockers: [],
      }));
      // Post-migration hash-filename shape: id IS the canonical form, displayId carries T-001.
      writeFileSync(join(storyDir, "tickets", `${canonicalTicketId}.json`), JSON.stringify({
        id: canonicalTicketId, displayId: "T-001", title: "node ticket", description: "", type: "task", status: "open", phase: "p1",
        order: 1, createdDate: "2026-01-01", completedDate: null, blockedBy: [], updatedAt: "2026-01-01T00:00:00.000Z",
      }));
      return dir;
    }

    it("resolves cleanly against a node's own ticket, no warning", async () => {
      const nodeDir = writeNodeProject("engine", CANONICAL_NODE_TICKET);
      const root = tempRoot();
      writeOrchestratorConfig(root, { engine: { path: nodeDir } });
      writeArrangement(root, { bounds: [`engine:${CANONICAL_NODE_TICKET}`] });
      const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as { data: { arrangementWarnings: string[] } };
      expect(parsed.data.arrangementWarnings).toEqual([]);
    });

    it("reports a distinct 'unusable' warning, not a false-healthy 'found', when a team-mode node's bound is uniquely resolvable but not by its exact id (codex round 2)", async () => {
      // Same single-ticket node fixture as the "resolves cleanly" test above,
      // but bound by displayId ("T-001") instead of the canonical id. This
      // uniquely resolves (exactly one ticket has that displayId -- not
      // "ambiguous"), yet `arrangementCoversNodeItem`'s exact-string
      // comparison would refuse it (A4-2's traced residual): the diagnostic
      // must not report "found" for a bound that cannot actually authorize a
      // write.
      const nodeDir = writeNodeProject("engine", CANONICAL_NODE_TICKET);
      const root = tempRoot();
      writeOrchestratorConfig(root, { engine: { path: nodeDir } });
      writeArrangement(root, { bounds: ["engine:T-001"] });
      const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as { data: { arrangementWarnings: string[] } };
      expect(parsed.data.arrangementWarnings.some((w) =>
        w.includes("engine:T-001") && w.includes("engine") && !w.includes("ambiguous") && !w.includes("not found"),
      )).toBe(true);
    });

    it("reports a warning naming the node when a node-qualified bound does not resolve there", async () => {
      const nodeDir = writeNodeProject("engine", "T-001");
      const root = tempRoot();
      writeOrchestratorConfig(root, { engine: { path: nodeDir } });
      writeArrangement(root, { bounds: ["engine:t-0123456789abcdef"] });
      const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as { data: { arrangementWarnings: string[] } };
      expect(parsed.data.arrangementWarnings.some((w) => w.includes("engine:t-0123456789abcdef") && w.includes("not found") && w.includes("engine"))).toBe(true);
    });

    it("reports a 'could not be checked' warning, not a failure, when the bound node cannot be resolved", async () => {
      const root = tempRoot();
      writeOrchestratorConfig(root, { broken: { path: join(tmpdir(), "sb-status-does-not-exist-" + Date.now()) } });
      writeArrangement(root, { bounds: ["broken:t-0123456789abcdef"] });
      const result = await handleStatus(ctxAt(root));
      expect(result.exitCode).toBeUndefined();
      const parsed = JSON.parse(result.output) as { data: { arrangementWarnings: string[] } };
      expect(parsed.data.arrangementWarnings.some((w) => w.includes("broken") && w.includes("could not be checked"))).toBe(true);
    });

    it("reports a 'could not be checked' warning for a node-qualified bound naming a node that is not (or no longer) in orchestrator config", async () => {
      const root = tempRoot();
      writeOrchestratorConfig(root, {});
      writeArrangement(root, { bounds: ["nosuchnode:t-0123456789abcdef"] });
      const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as { data: { arrangementWarnings: string[] } };
      expect(parsed.data.arrangementWarnings.some((w) => w.includes("nosuchnode") && w.includes("could not be checked"))).toBe(true);
    });

    it("reports a distinct 'ambiguous' warning, not a false-healthy 'found', when a display-form node bound matches more than one item (codex round 1: A4 residual must not be hidden)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sb-status-node-ambiguous-"));
      roots.push(dir);
      const storyDir = join(dir, ".story");
      mkdirSync(join(storyDir, "tickets"), { recursive: true });
      writeFileSync(join(storyDir, "config.json"), JSON.stringify({
        version: 2, schemaVersion: 2, project: "engine", type: "npm", language: "typescript",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      }));
      writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
        version: 2, title: "r", date: "2026-01-01", phases: [{ id: "p1", label: "P1", name: "P1", description: "" }], blockers: [],
      }));
      // Two post-migration tickets sharing the same displayId -- exactly what
      // makes `resolveTicketRef("T-001")` ambiguous rather than found/missing.
      writeFileSync(join(storyDir, "tickets", "t-0123456789abcdef.json"), JSON.stringify({
        id: "t-0123456789abcdef", displayId: "T-001", title: "first", description: "", type: "task", status: "open", phase: "p1",
        order: 1, createdDate: "2026-01-01", completedDate: null, blockedBy: [], updatedAt: "2026-01-01T00:00:00.000Z",
      }));
      writeFileSync(join(storyDir, "tickets", "t-fedcba9876543210.json"), JSON.stringify({
        id: "t-fedcba9876543210", displayId: "T-001", title: "second", description: "", type: "task", status: "open", phase: "p1",
        order: 2, createdDate: "2026-01-01", completedDate: null, blockedBy: [], updatedAt: "2026-01-01T00:00:00.000Z",
      }));

      const root = tempRoot();
      writeOrchestratorConfig(root, { engine: { path: dir } });
      writeArrangement(root, { bounds: ["engine:T-001"] });
      const parsed = JSON.parse((await handleStatus(ctxAt(root))).output) as { data: { arrangementWarnings: string[] } };
      expect(parsed.data.arrangementWarnings.some((w) => w.includes("engine:T-001") && w.includes("ambiguous") && w.includes("engine"))).toBe(true);
      expect(parsed.data.arrangementWarnings.some((w) => w.includes("could not be checked"))).toBe(false);
    });
  });
});

describe("handleStatus", () => {
  it("returns formatted status for md", async () => {
    const ctx = makeCtx({
      state: makeState({
        tickets: [makeTicket({ id: "T-001", phase: "p1" })],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      }),
    });
    const result = await handleStatus(ctx);
    expect(result.output).toContain("Tickets:");
    expect(result.exitCode).toBeUndefined();
  });

  it("returns valid JSON for json format", async () => {
    const ctx = makeCtx({ format: "json" });
    const result = await handleStatus(ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.project).toBe("test");
  });

  it("handles empty project", async () => {
    const ctx = makeCtx();
    const result = await handleStatus(ctx);
    expect(result.output).toContain("Tickets:");
    expect(result.output).toContain("0/0");
  });

  it("defaults to OK exit code", async () => {
    const ctx = makeCtx();
    const result = await handleStatus(ctx);
    expect(result.exitCode).toBeUndefined();
  });
});

describe("formatStatus with active sessions (ISS-023)", () => {
  it("shows no Active Sessions section when no sessions exist", () => {
    const state = makeState();
    const output = formatStatus(state, "md", []);
    expect(output).not.toContain("Active Sessions");
  });

  it("shows Active Sessions section with session details", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [{
      sessionId: "abcdef1234567890",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-042",
      ticketTitle: "Build API endpoint",
    }];
    const output = formatStatus(state, "md", sessions);
    expect(output).toContain("## Active Sessions");
    expect(output).not.toContain("abcdef12");
    expect(output).toContain("IMPLEMENT");
    expect(output).toContain("T-042");
    expect(output).toContain("auto mode");
  });

  it("excludes sessions from output when array is empty", () => {
    const state = makeState();
    const output = formatStatus(state, "md", []);
    expect(output).not.toContain("## Active Sessions");
  });

  it("shows multiple active sessions", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [
      { sessionId: "sess-aaa", state: "PLAN", mode: "guided", ticketId: "T-001", ticketTitle: "First" },
      { sessionId: "sess-bbb", state: "CODE_REVIEW", mode: "review", ticketId: "T-002", ticketTitle: "Second" },
    ];
    const output = formatStatus(state, "md", sessions);
    expect(output).toContain("T-001: First");
    expect(output).toContain("T-002: Second");
    expect(output).not.toContain("sess-aaa");
    expect(output).not.toContain("sess-bbb");
    expect(output).toContain("guided mode");
    expect(output).toContain("review mode");
  });

  it("includes activeSessions in JSON output", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [{
      sessionId: "sess-json",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-010",
      ticketTitle: "JSON test",
    }];
    const output = formatStatus(state, "json", sessions);
    const parsed = JSON.parse(output);
    expect(parsed.data.activeSessions).toHaveLength(1);
    expect(parsed.data.activeSessions[0].sessionId).toBe("sess-json");
  });

  it("keeps Markdown concise and exposes full ownership metadata in JSON", () => {
    const state = makeState();
    const sessions: ActiveSessionSummary[] = [{
      sessionId: "full-storybloq-session-id",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-020",
      ticketTitle: "Native task ownership",
      ownerTask: { client: "codex", id: "codex-thread-id", boundAt: "2026-07-09T00:00:00Z" },
      leaseExpiresAt: "2026-07-09T01:00:00Z",
      leaseState: "live",
      compactPending: false,
    }];

    const markdown = formatStatus(state, "md", sessions);
    expect(markdown).toContain("T-020: Native task ownership -- IMPLEMENT in a Codex task");
    expect(markdown).not.toContain("codex-thread-id");
    expect(markdown).not.toContain("full-storybloq-session-id");

    const parsed = JSON.parse(formatStatus(state, "json", sessions));
    expect(parsed.data.activeSessions[0]).toMatchObject({
      sessionId: "full-storybloq-session-id",
      ownerTask: { client: "codex", id: "codex-thread-id" },
      leaseState: "live",
      compactPending: false,
    });
  });

  it("reports expired compact recovery separately from activeSessions", () => {
    const state = makeState();
    const compact: ActiveSessionSummary = {
      sessionId: "compact-session-id",
      state: "COMPACT",
      mode: "auto",
      ticketId: "T-021",
      ticketTitle: "Recover task",
      ownerTask: null,
      leaseExpiresAt: "2026-07-09T00:00:00Z",
      leaseState: "expired",
      compactPending: true,
    };
    const parsed = JSON.parse(formatStatus(state, "json", [], [compact]));
    // ISS-891: empty rather than absent. A COMPACT session is reported ONLY under
    // resumableSessions, and activeSessions says so explicitly instead of leaving
    // the reader to infer it from a missing key.
    expect(parsed.data.activeSessions).toEqual([]);
    expect(parsed.data.resumableSessions).toHaveLength(1);
    expect(parsed.data.resumableSessions[0].sessionId).toBe("compact-session-id");

    const markdown = formatStatus(state, "md", [], [compact]);
    expect(markdown).toContain("## Resumable Sessions");
    expect(markdown).toContain("T-021: Recover task -- COMPACT recovery available (expired lease)");
    expect(markdown).not.toContain("compact-session-id");
  });

  it("emits both session arrays empty rather than omitting them (ISS-891)", () => {
    // Contract change. Omission made "no sessions" and "server too old to report
    // sessions" the same observation, so a consumer had to fail closed and
    // re-verify through the CLI. Presence is now the capability signal; the
    // contents are the answer.
    const state = makeState();
    const parsed = JSON.parse(formatStatus(state, "json", []));
    expect(parsed.data.activeSessions).toEqual([]);
    expect(parsed.data.resumableSessions).toEqual([]);
    expect(Object.keys(parsed.data)).toContain("activeSessions");
    expect(Object.keys(parsed.data)).toContain("resumableSessions");
  });

  it("emits both session arrays empty on an orchestrator too (ISS-891)", () => {
    // The active-session guard reads status without knowing the project type, so
    // the federated path has to carry the same contract or the guard is back to
    // fail-closed on orchestrators.
    const parsed = JSON.parse(
      formatFederatedStatus(sampleFedState, orchestratorConfig, "json", []),
    );
    expect(parsed.data.activeSessions).toEqual([]);
    expect(parsed.data.resumableSessions).toEqual([]);
  });

  it("emits limitStops empty rather than omitting it, on both paths (ISS-893)", () => {
    // Same contract, same reasoning as the session arrays above: omission made
    // "no limit stops" and "server too old to report limit stops" the same
    // observation. ISS-891 deliberately fixed only the arrays it named; this is
    // the one remaining field in these two objects that carried the old pattern.
    const plain = JSON.parse(formatStatus(makeState(), "json", []));
    expect(plain.data.limitStops).toEqual([]);
    expect(Object.keys(plain.data)).toContain("limitStops");

    const federated = JSON.parse(
      formatFederatedStatus(sampleFedState, orchestratorConfig, "json", []),
    );
    expect(federated.data.limitStops).toEqual([]);
    expect(Object.keys(federated.data)).toContain("limitStops");
  });

  it("still reports limit stops when they exist, on both paths (ISS-893)", () => {
    // Guards the opposite failure: hardcoding []. toEqual([]) above would pass
    // for the wrong reason if the key were present but never populated.
    const plain = JSON.parse(
      formatStatus(makeState(), "json", [], [], undefined, [sampleLimitStop]),
    );
    expect(plain.data.limitStops.map((s: LimitStopSummary) => s.key)).toEqual(["limit-key-1"]);

    const federated = JSON.parse(
      formatFederatedStatus(
        sampleFedState, orchestratorConfig, "json", [], [], undefined, [sampleLimitStop],
      ),
    );
    expect(federated.data.limitStops.map((s: LimitStopSummary) => s.key)).toEqual(["limit-key-1"]);
  });

  it("leaves the markdown branch unchanged in both cases (ISS-893)", () => {
    // This contract change is JSON-only. The markdown section already omits
    // itself when empty and must keep doing so, on both paths.
    expect(formatStatus(makeState(), "md", [])).not.toContain("## Limit-stop records");
    expect(formatFederatedStatus(sampleFedState, orchestratorConfig, "md", []))
      .not.toContain("## Limit-stop records");

    const plainMd = formatStatus(makeState(), "md", [], [], undefined, [sampleLimitStop]);
    expect(plainMd).toContain("## Limit-stop records");
    expect(plainMd).toContain("auto-resumes");

    const fedMd = formatFederatedStatus(
      sampleFedState, orchestratorConfig, "md", [], [], undefined, [sampleLimitStop],
    );
    expect(fedMd).toContain("## Limit-stop records");
  });

  it("still reports sessions when they exist, on both paths (ISS-891)", () => {
    // Guards the opposite failure: hardcoding the empty arrays. BOTH arrays carry
    // a distinct session on BOTH paths, because feeding only one of them leaves
    // the other satisfied by a hardcoded [] and proves nothing about it.
    const active: ActiveSessionSummary = {
      sessionId: "sess-active",
      state: "IMPLEMENT",
      mode: "auto",
      ticketId: "T-030",
      ticketTitle: "Active",
    };
    const resumable: ActiveSessionSummary = {
      sessionId: "sess-resumable",
      state: "COMPACT",
      mode: "auto",
      ticketId: "T-031",
      ticketTitle: "Resumable",
      leaseState: "expired",
      compactPending: true,
    };

    const plain = JSON.parse(formatStatus(makeState(), "json", [active], [resumable]));
    expect(plain.data.activeSessions.map((s: ActiveSessionSummary) => s.sessionId)).toEqual([
      "sess-active",
    ]);
    expect(plain.data.resumableSessions.map((s: ActiveSessionSummary) => s.sessionId)).toEqual([
      "sess-resumable",
    ]);

    const federated = JSON.parse(
      formatFederatedStatus(sampleFedState, orchestratorConfig, "json", [active], [resumable]),
    );
    expect(federated.data.activeSessions.map((s: ActiveSessionSummary) => s.sessionId)).toEqual([
      "sess-active",
    ]);
    expect(federated.data.resumableSessions.map((s: ActiveSessionSummary) => s.sessionId)).toEqual([
      "sess-resumable",
    ]);
  });
});

const orchestratorConfig: Config = {
  version: 2,
  schemaVersion: 2,
  project: "studio",
  type: "orchestrator",
  language: "typescript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  nodes: {
    engine: { path: "~/Dev/engine", health: "green", role: "Core engine", summary: "Pipeline working", dependsOn: [] },
    cloud: { path: "~/Dev/cloud", health: "yellow", role: "Cloud API", summary: "Webhook system", dependsOn: ["engine"] },
  },
};

const sampleFedState: FederationState = {
  orchestratorProject: "studio",
  nodeCount: 2,
  reachableCount: 2,
  unreachableCount: 0,
  nodes: [
    {
      name: "engine",
      rawPath: "~/Dev/engine",
      resolvedPath: "/Users/dev/engine",
      health: "green",
      role: "Core engine",
      summary: "Pipeline working",
      dependsOn: [],
      reachable: true,
      scanSummary: {
        project: "engine", type: "npm", ticketCount: 45, openTickets: 10,
        completeTickets: 35, issueCount: 5, openIssues: 3,
        lastHandoverDate: "2026-05-18", lastHandoverTitle: "Session",
      },
    },
    {
      name: "cloud",
      rawPath: "~/Dev/cloud",
      resolvedPath: "/Users/dev/cloud",
      health: "yellow",
      role: "Cloud API",
      summary: "Webhook system",
      dependsOn: ["engine"],
      reachable: true,
      scanSummary: {
        project: "cloud", type: "npm", ticketCount: 30, openTickets: 8,
        completeTickets: 22, issueCount: 3, openIssues: 2,
        lastHandoverDate: "2026-05-17", lastHandoverTitle: "Feature",
      },
    },
  ],
  totalTickets: 75,
  totalOpenTickets: 18,
  totalCompleteTickets: 57,
  totalIssues: 8,
  totalOpenIssues: 5,
  lastScanTimestamp: new Date().toISOString(),
};

describe("formatFederatedStatus (T-334)", () => {
  it("shows orchestrator heading with federation summary", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("studio");
    expect(output).toContain("orchestrator");
    expect(output).toContain("2 nodes");
  });

  it("shows node table with health and counts", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("engine");
    expect(output).toContain("green");
    expect(output).toContain("cloud");
    expect(output).toContain("yellow");
  });

  it("shows aggregated ticket/issue totals", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "md");
    expect(output).toContain("75");
    expect(output).toContain("5 open");
  });

  it("shows unreachable nodes with reason", () => {
    const withUnreachable: FederationState = {
      ...sampleFedState,
      reachableCount: 1,
      unreachableCount: 1,
      nodes: [
        sampleFedState.nodes[0]!,
        {
          name: "cloud",
          rawPath: "~/Dev/cloud",
          resolvedPath: null,
          health: "yellow",
          role: "Cloud API",
          summary: "",
          dependsOn: ["engine"],
          reachable: false,
          unreachableReason: "path does not exist",
        },
      ],
    };
    const output = formatFederatedStatus(withUnreachable, orchestratorConfig, "md");
    expect(output).toContain("unreachable");
  });

  it("produces valid JSON output", () => {
    const output = formatFederatedStatus(sampleFedState, orchestratorConfig, "json");
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(parsed.data.federation).toBeDefined();
    expect(parsed.data.federation.nodeCount).toBe(2);
    expect(parsed.data.federation.totalTickets).toBe(75);
  });

  it("includes review backends when configured", () => {
    const configWithReview: Config = {
      ...orchestratorConfig,
      recipeOverrides: { reviewBackends: ["lenses", "agent"] },
    };
    const output = formatFederatedStatus(sampleFedState, configWithReview, "md");
    expect(output).toContain("lenses");
  });
});

describe("arrangementsSection on both formatters (T-473)", () => {
  const arrangements = {
    items: [
      {
        id: "a-0123456789abcdef",
        lifecycle: "active" as const,
        bounds: ["T-473"],
        parties: [{ role: "pen" as const, client: "claude" as const }, { role: "worker" as const, client: "claude" as const }],
      },
    ],
    warnings: ["arrangements/a-broken.json: invalid JSON"],
  };

  it("formatStatus renders items and warnings in Markdown", () => {
    const out = formatStatus(makeState(), "md", [], [], undefined, [], undefined, [], arrangements);
    expect(out).toContain("## Arrangements");
    expect(out).toContain("a-0123456789abcdef");
    expect(out).toContain("arrangements/a-broken.json: invalid JSON");
  });

  it("formatStatus renders items and warnings in JSON, as separate top-level keys", () => {
    const parsed = JSON.parse(formatStatus(makeState(), "json", [], [], undefined, [], undefined, [], arrangements));
    expect(parsed.data.arrangements).toHaveLength(1);
    expect(parsed.data.arrangements[0].id).toBe("a-0123456789abcdef");
    expect(parsed.data.arrangementWarnings).toEqual(["arrangements/a-broken.json: invalid JSON"]);
  });

  it("formatFederatedStatus renders items and warnings in Markdown", () => {
    const out = formatFederatedStatus(sampleFedState, orchestratorConfig, "md", [], [], undefined, [], undefined, [], arrangements);
    expect(out).toContain("## Arrangements");
    expect(out).toContain("a-0123456789abcdef");
  });

  it("formatFederatedStatus renders items and warnings in JSON, as separate top-level keys", () => {
    const parsed = JSON.parse(
      formatFederatedStatus(sampleFedState, orchestratorConfig, "json", [], [], undefined, [], undefined, [], arrangements),
    );
    expect(parsed.data.arrangements).toHaveLength(1);
    expect(parsed.data.arrangementWarnings).toEqual(["arrangements/a-broken.json: invalid JSON"]);
  });

  it("neither formatter renders the section when both items and warnings are empty (default)", () => {
    expect(formatStatus(makeState(), "md")).not.toContain("## Arrangements");
    expect(formatFederatedStatus(sampleFedState, orchestratorConfig, "md")).not.toContain("## Arrangements");
  });
});

/**
 * `sessionDiagnostics` is a positive claim, so it must not appear unless a scan
 * actually produced it (ISS-897).
 *
 * An empty array means "the scan ran and concealed nothing". Defaulting the
 * formatter parameter to `[]` made every caller that performed NO scan assert a
 * verified-clean result -- the exact fail-open the field exists to close, wearing
 * the field's own name.
 */
describe("sessionDiagnostics is only claimed when a scan supplied it (ISS-897)", () => {
  it("is absent when the formatter is called without it", () => {
    const parsed = JSON.parse(formatStatus(makeState(), "json")) as { data: Record<string, unknown> };
    expect(Object.keys(parsed.data)).not.toContain("sessionDiagnostics");
  });

  it("is present and empty when a clean scan supplied one", () => {
    const parsed = JSON.parse(formatStatus(makeState(), "json", [], [], undefined, [], [])) as {
      data: { sessionDiagnostics: unknown[] };
    };
    expect(parsed.data.sessionDiagnostics).toEqual([]);
  });

  it("carries the entries and renders a warning block when the scan was not clean", () => {
    const diagnostic = {
      kind: "state-unreadable" as const,
      category: "omission" as const,
      sourceDir: "broken",
      sourcePath: "/p/.story/sessions/broken/state.json",
      sessionId: null,
      reason: "could not be read",
    };
    const parsed = JSON.parse(formatStatus(makeState(), "json", [], [], undefined, [], [diagnostic])) as {
      data: { sessionDiagnostics: unknown[] };
    };
    expect(parsed.data.sessionDiagnostics).toHaveLength(1);
    const md = formatStatus(makeState(), "md", [], [], undefined, [], [diagnostic]);
    expect(md).toContain("## Session Scan Warnings");
    expect(md).toContain("broken");
  });

  it("adds nothing to Markdown when the scan was clean", () => {
    expect(formatStatus(makeState(), "md", [], [], undefined, [], [])).not.toContain("Session Scan Warnings");
  });

  /**
   * ISS-945: `aged-anomaly` admits NO record at all, same as `omission` does --
   * but unlike `omission` it must not be treated as a concealment GAP, or an
   * aged debris directory would print the same "cannot be established" warning
   * an actual unread session does, which is exactly the false alarm this
   * category exists to relieve.
   */
  it("renders an aged-anomaly diagnostic without concealment language, with its full remedy text intact", () => {
    const reason = describeAddressableAgedAnomaly("11111111-2222-4333-8444-555555555555");
    const diagnostic = {
      kind: "state-missing-aged" as const,
      category: "aged-anomaly" as const,
      sourceDir: "11111111-2222-4333-8444-555555555555",
      sourcePath: "/p/.story/sessions/11111111-2222-4333-8444-555555555555/state.json",
      sessionId: null,
      reason,
      remedy: "session-delete" as const,
    };
    const md = formatStatus(makeState(), "md", [], [], undefined, [], [diagnostic]);
    expect(md).toContain("## Session Scan Warnings");
    // The "gap"/"cannot be established" framing is `concealing`-only (omission),
    // and this diagnostic is the ONLY one in the array -- so none of that
    // framing may appear.
    expect(md).not.toContain("cannot be established");
    expect(md).not.toContain("gap");
    expect(md).toContain("aged-anomaly");
    expect(md).toContain("11111111-2222-4333-8444-555555555555");
    expect(md).toContain("session delete 11111111-2222-4333-8444-555555555555 --yes");
    expect(md).toContain("does not prove no session is being created here");
  });

  /**
   * A reason is PROSE, and it was being cut at a label width (ISS-897).
   *
   * `sanitizeDisplayText` defaults to 300 characters, which is a budget for a
   * directory NAME. The scanner's reasons are paragraphs, and the collision one
   * runs to about 800 -- so the rendered line stopped mid-argument and the
   * sentence it dropped was the one telling the operator not to delete
   * anything. The safety instruction is last precisely because it is the
   * conclusion, which makes a tail-truncating cap the worst possible one here.
   */
  it("does not truncate a diagnostic reason at the label width", () => {
    // Shaped like the real collision reason: long, and with the instruction
    // that matters at the very end.
    const reason =
      `Session id abc is embedded in 2 different directories: a, b. ${"Filler that stands in for the argument. ".repeat(12)}` +
      "Nothing here establishes which copy is stale, so do not delete anything on this diagnostic alone.";
    expect(reason.length, "fixture no longer exceeds the label width").toBeGreaterThan(300);

    const md = formatStatus(makeState(), "md", [], [], undefined, [], [
      {
        kind: "duplicate-session-id" as const,
        category: "collision" as const,
        sourceDir: "a",
        sourcePath: "/p/.story/sessions/a",
        sessionId: "abc",
        reason,
      },
    ]);
    expect(md, "the remedy was truncated away").toContain("do not delete anything on this diagnostic alone");
    expect(md, "label-width truncation marker").not.toContain("... (truncated)");
  });

  it("still bounds a reason, at the prose budget rather than the label one", () => {
    // The control above only proves the 300 cap is gone. Removing the bound
    // ENTIRELY also passes it, and `reason` is caller-supplied at the typed
    // seam -- so an unbounded one floods the status output an operator is
    // reading to find out whether another agent is running. Both halves have to
    // be pinned or the fix reads as "stop truncating".
    const flood = "z".repeat(MAX_PROSE_LENGTH * 2);
    const md = formatStatus(makeState(), "md", [], [], undefined, [], [
      {
        kind: "duplicate-session-id" as const,
        category: "collision" as const,
        sourceDir: "a",
        sourcePath: "/p/.story/sessions/a",
        sessionId: "abc",
        reason: flood,
      },
    ]);
    expect(md, "reason is unbounded").not.toContain(flood);
    expect(md.length, "reason is unbounded").toBeLessThan(MAX_PROSE_LENGTH + 2_000);
    // The marker itself goes through the strict Markdown pass, which escapes
    // the parentheses -- so match the escaped form rather than the raw one.
    expect(md, "cut without saying so").toMatch(/\.\.\. .{0,2}truncated/);
  });

  /**
   * The federated formatter is a SEPARATE implementation of both the JSON
   * serialization and the Markdown rendering, so every assertion above is blind
   * to it. An orchestrator project is exactly where a concealed session matters
   * most, since one pen per repo is the invariant the guard protects.
   */
  describe("the federated formatter carries the same contract", () => {
    const fed = (
      format: "json" | "md",
      sessionDiagnostics?: readonly SessionScanDiagnostic[],
    ): string =>
      formatFederatedStatus(
        sampleFedState,
        orchestratorConfig,
        format,
        [],
        [],
        undefined,
        [],
        sessionDiagnostics,
      );

    it("omits the key when no scan supplied one", () => {
      const parsed = JSON.parse(fed("json")) as { data: Record<string, unknown> };
      expect(Object.keys(parsed.data)).not.toContain("sessionDiagnostics");
    });

    it("is present and empty when a clean scan supplied one", () => {
      const parsed = JSON.parse(fed("json", [])) as { data: { sessionDiagnostics: unknown[] } };
      expect(parsed.data.sessionDiagnostics).toEqual([]);
    });

    it("carries entries and renders the warning block", () => {
      const diagnostic: SessionScanDiagnostic = {
        kind: "state-unreadable",
        category: "omission",
        sourceDir: "broken",
        sourcePath: "/p/.story/sessions/broken/state.json",
        sessionId: null,
        reason: "could not be read",
      };
      const parsed = JSON.parse(fed("json", [diagnostic])) as {
        data: { sessionDiagnostics: unknown[] };
      };
      expect(parsed.data.sessionDiagnostics).toHaveLength(1);
      const md = fed("md", [diagnostic]);
      expect(md).toContain("## Session Scan Warnings");
      expect(md).toContain("broken");
    });

    it("neutralizes control characters in its Markdown, but not in its JSON", () => {
      const ESC = String.fromCharCode(27);
      const diagnostic: SessionScanDiagnostic = {
        kind: "state-unreadable",
        category: "omission",
        sourceDir: `bad${ESC}[31m`,
        sourcePath: "/p/.story/sessions/bad/state.json",
        sessionId: null,
        reason: "could not be read",
      };
      expect(fed("md", [diagnostic])).not.toContain(ESC);
      const parsed = JSON.parse(fed("json", [diagnostic])) as {
        data: { sessionDiagnostics: { sourceDir: string }[] };
      };
      expect(parsed.data.sessionDiagnostics[0]!.sourceDir).toBe(diagnostic.sourceDir);
    });
  });

  /**
   * Both Markdown renderers, as one table.
   *
   * Both formatters route diagnostics through the SAME `sessionDiagnosticLines`
   * helper, so the escaping has one home -- but each constructs and emits its
   * own diagnostic section around it, and that plumbing is where raw values
   * survived the last time this was fixed: the standard path was corrected and
   * the federated one went on passing its list elsewhere, because nothing
   * exercised the pair. Every assertion about how a diagnostic RENDERS belongs
   * here, run against both, not against one of them -- an orchestrator project
   * reads the federated output and no other.
   */
  const RENDERERS: [string, (d: SessionScanDiagnostic) => string][] = [
    ["standard", (d) => formatStatus(makeState(), "md", [], [], undefined, [], [d])],
    [
      "federated",
      (d) => formatFederatedStatus(sampleFedState, orchestratorConfig, "md", [], [], undefined, [], [d]),
    ],
  ];

  it.each(RENDERERS)("renders a collection-level path as an ADDRESS, not a label (%s)", (_label, render) => {
    // A fault against the sessions directory itself has `sourceDir: null` by
    // design, so `sourcePath` is the only thing to show -- and it is an address
    // the operator is expected to open. Truncating it to the 300-char label cap
    // does not shorten the path, it makes it wrong.
    const ESC = String.fromCharCode(27);
    const BACKSLASH = String.fromCharCode(92);
    const deep = `/${"nested-project-directory/".repeat(20)}.story/sessions`;
    expect(deep.length).toBeGreaterThan(300);
    const diagnostic: SessionScanDiagnostic = {
      kind: "sessions-dir-unreadable",
      category: "omission",
      sourceDir: null,
      sourcePath: `${deep}${ESC}[31m`,
      sessionId: null,
      reason: "EACCES",
    };
    const md = render(diagnostic);
    expect(md).not.toContain(ESC);
    // RECOVERABLE, not merely inert. `?` is a legal filename character, so
    // substituting it produces a path that is both untypeable and ambiguous
    // with a real one -- on the single surface whose whole purpose is telling
    // the operator which file to go open. The escape text decodes back.
    //
    // Two escapings compose here and the order is the whole point.
    // `sanitizeDisplayPath` renders the control character as the literal text
    // `\u001b`; the Markdown pass then doubles that backslash and escapes the
    // `[`, because the string is going into a document. So what the operator
    // reads is `\u001b[31m` and what the source holds is
    // `\\u001b\[31m`. Asserting the un-escaped form asserts the document is
    // not escaped, which is the property that lets a directory NAME author a
    // link in the warning that says a session may be concealed.
    expect(md).toContain(`${deep}${BACKSLASH}${BACKSLASH}u001b${BACKSLASH}[31m`);
    expect(md).toContain("decode them to get the name on disk");
    expect(md).not.toContain(`${deep}?[31m`);
    expect(md).not.toContain("(truncated)");
  });

  it.each(RENDERERS)(
    "gives an ENTRY-level diagnostic the reversible address too, not just the lossy name (%s)",
    (label, render) => {
      // The label is what a reader scans the list by, so it stays. What it
      // cannot do is stand alone: `sanitizeDisplayText` maps every control
      // character, bidi mark and invisible to `?`, and `?` is itself a legal
      // filename character. So two hostile directories and one innocent one all
      // print the same name -- on the line whose entire job is telling the
      // operator that a session may be CONCEALED and which one to go look at.
      //
      // The record already carries the answer in `sourcePath`. Rendering only
      // the label threw it away.
      const ESC = String.fromCharCode(27);
      const RLO = "\u202e";
      const BACKSLASH = String.fromCharCode(92);
      const dirs = [`dir${ESC}x`, `dir${RLO}x`, "dir?x"];
      const rendered = dirs.map((dir) =>
        render({
          kind: "state-unreadable" as const,
          category: "omission" as const,
          sourceDir: dir,
          sourcePath: `/p/.story/sessions/${dir}/state.json`,
          sessionId: null,
          reason: "EACCES",
        }),
      );

      // The labels collapse -- that is the premise, not the bug being tested.
      for (const md of rendered) {
        expect(md, `${label}: label`).toContain("dir?x");
      }
      // ...and each line still distinguishes its directory, because the
      // reversible address came with it.
      expect(rendered[0], `${label}: ESC address`).toContain(
        `dir${BACKSLASH}${BACKSLASH}u001bx`,
      );
      expect(rendered[1], `${label}: RLO address`).toContain(
        `dir${BACKSLASH}${BACKSLASH}u202ex`,
      );
      // The innocent one comes through unmodified and unmarked: nothing to escape,
      // so it must not be dressed up to look like the hostile pair.
      expect(rendered[2], `${label}: innocent`).toContain("sessions/dir?x/state.json");
      expect(rendered[2], `${label}: innocent`).not.toContain("u001b");

      // No two of the three render the same line.
      expect(new Set(rendered).size, `${label}: three distinct lines`).toBe(3);

      // Still a document sink: the address is escaped for Markdown after it is
      // encoded, never before.
      const linky = render({
        kind: "state-unreadable" as const,
        category: "omission" as const,
        sourceDir: "plain",
        sourcePath: "/p/.story/sessions/a](https://evil.example)/state.json",
        sessionId: null,
        reason: "EACCES",
      });
      expect(linky, `${label}: address link`).not.toContain("](https://evil.example)");
      expect(linky, `${label}: address autolink`).not.toContain("https://evil.example");
    },
  );

  it.each(RENDERERS)(
    "cannot have a LINK or an element injected through a directory NAME (%s)",
    (label, render) => {
    // A separate axis from the control-character one below, and this is the
    // worst surface in the output to leave open: the sentence that tells an
    // operator a session may be concealed, carrying a name straight off disk.
    // `storybloq_status` defaults to `format: "md"` and returns this text to an
    // MCP client, so without document escaping the name authors real structure
    // in the warning about itself.
    //
    // The rest of this formatter is NOT document-escaped -- see ISS-915 -- and
    // that is a decision about pre-existing fields. It is not a licence to add
    // a new one with the same hole.
    const payload = "[click](https://elsewhere.example) <img src=x> `code` **bold**";
    const diagnostic = {
      kind: "state-unreadable" as const,
      category: "omission" as const,
      sourceDir: payload,
      sourcePath: "/p/.story/sessions/bad/state.json",
      sessionId: null,
      reason: `see https://evil.example and ${payload}`,
    };
    // BOTH formatters. They share `sessionDiagnosticLines`, so the escaping
    // itself has one home -- but each builds and plumbs its own diagnostic
    // section around it, and that plumbing is where the values survived last
    // time: the standard formatter was wired up and the federated one was left
    // passing its list somewhere else, because nothing exercised the pair. An
    // orchestrator project reads the federated output and no other.
    const md = render(diagnostic);

    expect(md, `${label}: link`).not.toContain("](https://elsewhere.example)");
    expect(md, `${label}: element`).not.toContain("<img");
    expect(md, `${label}: code span`).not.toMatch(/[^\\]`code`/);
    // Bare URLs autolink in GFM on their own, so escaping the brackets is not
    // enough -- a payload that omits the wrapper still gets a clickable link.
    expect(md, `${label}: autolink`).not.toContain("https://evil.example");
    expect(md, `${label}: autolink`).not.toContain("https://elsewhere.example");

    // Neutralized, not dropped: the operator has to be able to see the name
    // with its printable content visible, and the reversible address preserves the decoded name needed to compare against a directory listing, or they cannot go find it.
    expect(md, `${label}: text lost`).toContain("click");
    expect(md, `${label}: text lost`).toContain("elsewhere.example");
    expect(md, `${label}: angle brackets`).toContain("&lt;img");
  },
);

  it("neutralizes control characters in the rendered warning, but not in JSON", () => {
    // The directory name and the reason both come off the filesystem, and this
    // block renders during an incident, when the reader is deciding whether
    // another agent is running. `escapeMarkdownInline` does not cover it: it
    // guards line-leading Markdown markers and preserves everything else.
    const ESC = String.fromCharCode(27);
    const NEWLINE = String.fromCharCode(10);
    const BACKSLASH = String.fromCharCode(92);
    const diagnostic = {
      kind: "state-unreadable" as const,
      category: "omission" as const,
      sourceDir: `bad${ESC}[31m${NEWLINE}- **fake** row`,
      sourcePath: "/p/.story/sessions/bad/state.json",
      sessionId: null,
      reason: `broke${ESC}]0;title`,
    };
    const md = formatStatus(makeState(), "md", [], [], undefined, [], [diagnostic]);
    expect(md).not.toContain(ESC);
    // The forged bullet must not survive as its own line.
    expect(md).not.toContain(`${NEWLINE}- **fake** row`);
    // `?` for each control character, then the document pass escapes the `[`
    // and the `*` the payload supplied.
    expect(md).toContain(`bad?${BACKSLASH}[31m?`);
    expect(md).not.toContain("**fake**");

    // The structured payload is not a terminal, and a consumer comparing it
    // against a directory listing needs the decoded name unmodified.
    const parsed = JSON.parse(formatStatus(makeState(), "json", [], [], undefined, [], [diagnostic])) as {
      data: { sessionDiagnostics: { sourceDir: string }[] };
    };
    expect(parsed.data.sessionDiagnostics[0]!.sourceDir).toBe(diagnostic.sourceDir);
  });
});
