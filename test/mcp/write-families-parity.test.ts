import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { HIDDEN_LEGACY_TOOLS, WRITE_FAMILIES } from "../../src/mcp/tool-profile.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleArrangementCreate } from "../../src/cli/commands/arrangement.js";
import {
  handleCheckpointCreate,
  handleCheckpointEnable,
  handleCheckpointList,
  handleCheckpointResolve,
} from "../../src/cli/commands/checkpoint.js";
import { isolateGit } from "./board-git-fixtures.js";

/**
 * 1.20 commit 0 (pen review of d7162ec0, finding 3): for each of the eighteen
 * former write tools, the former name and its family action give the same
 * reply, the same ledger bytes and the same git state, on a success and on
 * the representative refusals (a commit that meets a staged file, the team
 * version fence, an earmark held by another task).
 *
 * Each side runs on its own fresh project with the clock, the git dates and
 * the canonical id source fixed, so the two runs are byte-comparable.
 */

const ids = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../src/core/canonical-id.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/canonical-id.js")>();
  return {
    ...real,
    generateCanonicalId: (prefix: string) => `${prefix}-${String(++ids.n).padStart(16, "0")}`,
  };
});

const DATE = "2026-02-02T02:02:02Z";
const RESERVER = "reserver-task-1";
const PEN_TASK = "pen-task-1";
const SESSION = "11111111-2222-4333-8444-555555555555";

let restoreGit: () => void;
const dirs: string[] = [];
beforeEach(() => {
  restoreGit = isolateGit();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  restoreGit();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });

async function newProject(): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "mcp-family-parity-")));
  dirs.push(root);
  await initProject(root, { name: "fixture" });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

interface Conn {
  root: string;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

async function connect(root: string): Promise<Conn> {
  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  registerAllTools(server, root);
  const client = new Client({ name: "family-parity", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    root,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as Array<{ text?: string }>;
      return { text: content.map((p) => p.text ?? "").join("\n"), isError: result.isError === true };
    },
    close: () => client.close(),
  };
}

/** Every ledger byte except the per-call liveness touch, plus the git state. */
function state(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = join(rel, entry.name);
      if (/^\.story[\\/]sessions[\\/][^\\/]+[\\/]telemetry[\\/]lastMcpCall$/.test(next)) continue;
      if (entry.isDirectory()) walk(next);
      else out[next] = readFileSync(join(root, next), "utf-8");
    }
  };
  walk(".story");
  out["git log"] = git(root, "log", "--format=%H %s");
  out["git status"] = git(root, "status", "--porcelain", "--untracked-files=all");
  out["git index"] = git(root, "ls-files", "--stage");
  return out;
}

type Ctx = Record<string, string>;
type Setup = (c: Conn) => Promise<Ctx>;

// ---- setups shared by the rows ----------------------------------------------

const enableCheckpoints: Setup = async (c) => {
  await handleCheckpointEnable("md", c.root);
  return {};
};

const CONTENT = { title: "Pick a store", owner: "owner", kind: "decision", question: "sqlite or pg?", evidenceRefs: ["docs/store.md"] };

async function expectedOf(root: string, id: string): Promise<Ctx> {
  const listed = JSON.parse((await handleCheckpointList("json", root)).output).data as Array<{ id: string; expected: Record<string, unknown> }>;
  const found = listed.find((s) => s.id === id)!;
  return Object.fromEntries(Object.entries(found.expected).map(([k, v]) => [k, String(v)]));
}

const openCheckpoint: Setup = async (c) => {
  await enableCheckpoints(c);
  const created = JSON.parse((await handleCheckpointCreate({ ...CONTENT, phase: "p0" }, "json", c.root)).output).data as { id: string };
  return { id: created.id, ...(await expectedOf(c.root, created.id)) };
};

const resolvedCheckpoint: Setup = async (c) => {
  const open = await openCheckpoint(c);
  await handleCheckpointResolve(open.id!, { generation: Number(open.generation), revision: Number(open.revision), digest: open.digest!, response: "pg" }, "json", c.root);
  return { id: open.id!, ...(await expectedOf(c.root, open.id!)) };
};

const expected = (ctx: Ctx) => ({ id: ctx.id, generation: Number(ctx.generation), revision: Number(ctx.revision), digest: ctx.digest });

const ticket: Setup = async (c) => {
  const created = await handleTicketCreate(
    { title: "Board item", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    c.root,
  );
  return { ticket: JSON.parse(created.output).data.id as string };
};

const ticketWithCheckpoints: Setup = async (c) => ({ ...(await enableCheckpoints(c)), ...(await ticket(c)) });

const arranged: Setup = async (c) => {
  const t = await ticket(c);
  const arrangement = await handleArrangementCreate(
    {
      bounds: [t.ticket!],
      parties: [
        { role: "pen", client: "claude", identityAnchor: PEN_TASK },
        { role: "worker", client: "claude", identityAnchor: RESERVER },
      ] as never,
      onIrreversibleWork: "hold",
    },
    "json",
    c.root,
  );
  return { ...t, arrangement: JSON.parse(arrangement.output).data.id as string };
};

const reserved: Setup = async (c) => {
  const ctx = await arranged(c);
  const r = await c.call("storybloq_earmark_reserve", { ref: ctx.ticket, role: "worker", arrangement: ctx.arrangement, clientTaskId: RESERVER });
  expect(r.isError, r.text).toBe(false);
  return ctx;
};

/** A live autonomous session owned by the reserving task, the target of an assign. */
const reservedWithLiveSession: Setup = async (c) => {
  const ctx = await reserved(c);
  const dir = join(c.root, ".story", "sessions", SESSION);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    schemaVersion: 1, sessionId: SESSION, recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null, git: { branch: null, mergeBase: null },
    lease: { workspaceId: "test-ws", lastHeartbeat: now, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
    ownerTask: { client: "claude", id: RESERVER, boundAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null, compactPending: false, compactPreparedAt: null,
    resumeBlocked: false, terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
  }, null, 2));
  return ctx;
};

const RULING = { attribution: "owner-direct", date: "2026-02-02", clientTaskId: "parity-task" };

const ruled: Setup = async (c) => {
  const r = await c.call("storybloq_ruling_create", { text: "Ship on green.", ...RULING });
  expect(r.isError, r.text).toBe(false);
  return { ruling: /\b(r-[0-9a-z]{16})\b/.exec(r.text)![1]! };
};

const proposed: Setup = async (c) => {
  const r = await c.call("storybloq_ruling_propose", { text: "Ship on green.", ...RULING });
  const m = /Proposed ruling (r-[0-9a-z]+) \(revision ([0-9a-f]{64})\)/.exec(r.text);
  expect(m, r.text).not.toBeNull();
  return { ruling: m![1]!, revision: m![2]! };
};

const CAPABILITY = { id: "cap-widgets", name: "Widgets", summary: "Makes widgets.", entryPoints: [".story"], contract: "A widget per call." };
const TERM = { id: "term-widget", term: "widget", definition: "A thing on the board.", distinction: "Not a gadget." };

const capability: Setup = async (c) => {
  const r = await c.call("storybloq_capability_add", CAPABILITY);
  expect(r.isError, r.text).toBe(false);
  return {};
};

const term: Setup = async (c) => {
  const r = await c.call("storybloq_term_add", TERM);
  expect(r.isError, r.text).toBe(false);
  return {};
};

/** The capability catalog carries a change someone else staged, so a commit must not take it. */
const capabilityStagedElsewhere: Setup = async (c) => {
  await capability(c);
  git(c.root, "add", "--", ".story/capabilities.json");
  return {};
};

/** The team version fence: this CLI is older than the board requires. */
const fenced = (inner?: Setup): Setup => async (c) => {
  const ctx = inner ? await inner(c) : {};
  const path = join(c.root, ".story", "config.json");
  const config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...config, team: { enabled: true, minCliVersion: "99.0.0" } }, null, 2) + "\n");
  return ctx;
};

// ---- the table ----------------------------------------------------------------

interface Row {
  label: string;
  legacy: string;
  setup?: Setup;
  args: (ctx: Ctx) => Record<string, unknown>;
  /** "ok": a write lands; "refused": an error and nothing changes; "skipped": the write lands, the commit is skipped. */
  outcome: "ok" | "refused" | "skipped";
  /** Text the legacy reply must carry, so the row exercises what its label says. */
  shows?: RegExp;
}

const ROWS: Row[] = [
  // ruling
  { label: "create", legacy: "storybloq_ruling_create", args: () => ({ text: "Ship on green.", ...RULING }), outcome: "ok" },
  { label: "create, committed", legacy: "storybloq_ruling_create", args: () => ({ text: "Ship on green.", ...RULING, commit: true }), outcome: "ok", shows: /Git: committed [0-9a-f]+/ },
  { label: "supersede", legacy: "storybloq_ruling_supersede", setup: ruled, args: (x) => ({ id: x.ruling, text: "Ship on amber.", ...RULING }), outcome: "ok", shows: /now supersedes/ },
  { label: "propose", legacy: "storybloq_ruling_propose", args: () => ({ text: "Ship on green.", ...RULING }), outcome: "ok", shows: /Proposed ruling/ },
  { label: "accept", legacy: "storybloq_ruling_accept", setup: proposed, args: (x) => ({ id: x.ruling, revision: x.revision, ...RULING }), outcome: "ok" },
  { label: "withdraw", legacy: "storybloq_ruling_withdraw", setup: proposed, args: (x) => ({ id: x.ruling, reason: "talked it through", clientTaskId: "parity-task" }), outcome: "ok", shows: /Withdrew proposal/ },
  { label: "propose behind the team version fence", legacy: "storybloq_ruling_propose", setup: fenced(), args: () => ({ text: "Ship on green.", ...RULING }), outcome: "refused", shows: /99\.0\.0/ },
  // earmark
  { label: "reserve", legacy: "storybloq_earmark_reserve", setup: arranged, args: (x) => ({ ref: x.ticket, role: "worker", arrangement: x.arrangement, clientTaskId: RESERVER }), outcome: "ok" },
  { label: "reserve an item another task holds", legacy: "storybloq_earmark_reserve", setup: reserved, args: (x) => ({ ref: x.ticket, role: "pen", arrangement: x.arrangement, clientTaskId: PEN_TASK }), outcome: "refused", shows: /Cannot reserve .*held by/ },
  { label: "assign", legacy: "storybloq_earmark_assign", setup: reservedWithLiveSession, args: (x) => ({ ref: x.ticket, to: SESSION, role: "worker", arrangement: x.arrangement, clientTaskId: RESERVER }), outcome: "ok" },
  { label: "release", legacy: "storybloq_earmark_release", setup: reserved, args: (x) => ({ ref: x.ticket, clientTaskId: RESERVER }), outcome: "ok" },
  // checkpoint
  { label: "create", legacy: "storybloq_checkpoint_create", setup: enableCheckpoints, args: () => ({ ...CONTENT, phase: "p0" }), outcome: "ok", shows: /Created checkpoint/ },
  { label: "create behind the team version fence", legacy: "storybloq_checkpoint_create", setup: fenced(enableCheckpoints), args: () => ({ ...CONTENT, phase: "p0" }), outcome: "refused", shows: /99\.0\.0/ },
  { label: "attach", legacy: "storybloq_checkpoint_attach", setup: ticketWithCheckpoints, args: (x) => ({ id: x.ticket, owner: "owner", kind: "decision", question: "Which store?" }), outcome: "ok" },
  { label: "change", legacy: "storybloq_checkpoint_change", setup: openCheckpoint, args: (x) => ({ ...expected(x), kind: "decision", question: "pg or sqlite?" }), outcome: "ok" },
  { label: "resolve", legacy: "storybloq_checkpoint_resolve", setup: openCheckpoint, args: (x) => ({ ...expected(x), response: "pg" }), outcome: "ok" },
  { label: "reopen", legacy: "storybloq_checkpoint_reopen", setup: resolvedCheckpoint, args: (x) => ({ ...expected(x), reason: "the load changed" }), outcome: "ok" },
  { label: "retire", legacy: "storybloq_checkpoint_retire", setup: openCheckpoint, args: (x) => ({ ...expected(x), reason: "no longer needed" }), outcome: "ok" },
  // capability
  { label: "add", legacy: "storybloq_capability_add", args: () => CAPABILITY, outcome: "ok" },
  { label: "update", legacy: "storybloq_capability_update", setup: capability, args: () => ({ id: CAPABILITY.id, summary: "Makes better widgets." }), outcome: "ok" },
  { label: "update, commit meets a change staged by someone else", legacy: "storybloq_capability_update", setup: capabilityStagedElsewhere, args: () => ({ id: CAPABILITY.id, summary: "Makes better widgets.", commit: true }), outcome: "skipped", shows: /commit skipped \(\.story\/capabilities\.json already staged by another change\)/ },
  // term
  { label: "add", legacy: "storybloq_term_add", args: () => TERM, outcome: "ok" },
  { label: "add, committed", legacy: "storybloq_term_add", args: () => ({ ...TERM, commit: true }), outcome: "ok", shows: /Git: committed [0-9a-f]+/ },
  { label: "add behind the team version fence", legacy: "storybloq_term_add", setup: fenced(), args: () => TERM, outcome: "refused", shows: /99\.0\.0/ },
  { label: "update", legacy: "storybloq_term_update", setup: term, args: () => ({ id: TERM.id, definition: "A thing.", clear: ["distinction"] }), outcome: "ok" },
];

const familyOf = (legacy: string) => WRITE_FAMILIES.find((f) => legacy.startsWith(f.prefix) && f.actions.includes(legacy.slice(f.prefix.length)))!;

async function run(name: string, row: Row, args: (ctx: Ctx) => Record<string, unknown>) {
  ids.n = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(DATE));
  vi.stubEnv("GIT_AUTHOR_DATE", DATE);
  vi.stubEnv("GIT_COMMITTER_DATE", DATE);
  const root = await newProject();
  const conn = await connect(root);
  try {
    const ctx = row.setup ? await row.setup(conn) : {};
    const before = state(root);
    const reply = await conn.call(name, args(ctx));
    const after = state(root);
    const norm = (s: string) => s.split(root).join("<root>");
    return {
      reply: { text: norm(reply.text), isError: reply.isError },
      changed: JSON.stringify(after) !== JSON.stringify(before),
      after: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, norm(v)])),
    };
  } finally {
    await conn.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
}

describe("every former write tool and its family action: same reply, same ledger, same git state", () => {
  it("covers all eighteen former tools, each with a success", () => {
    expect(new Set(ROWS.map((r) => r.legacy))).toEqual(new Set(HIDDEN_LEGACY_TOOLS));
    for (const legacy of HIDDEN_LEGACY_TOOLS) {
      expect(ROWS.some((r) => r.legacy === legacy && r.outcome === "ok"), `${legacy} has a success row`).toBe(true);
    }
  });

  it.each(ROWS.map((r) => [`${r.legacy} ${r.label}`, r] as const))("%s", async (_name, row) => {
    const family = familyOf(row.legacy);
    const action = row.legacy.slice(family.prefix.length);
    const legacy = await run(row.legacy, row, row.args);
    const viaFamily = await run(family.name, row, (ctx) => ({ action, ...row.args(ctx) }));

    expect(legacy.reply.isError, legacy.reply.text).toBe(row.outcome === "refused");
    expect(legacy.changed, `${row.legacy}: the ledger or git state changed`).toBe(row.outcome !== "refused");
    if (row.shows) expect(legacy.reply.text).toMatch(row.shows);

    expect(viaFamily.reply).toEqual(legacy.reply);
    expect(viaFamily.changed).toBe(legacy.changed);
    expect(viaFamily.after).toEqual(legacy.after);
  });
});
