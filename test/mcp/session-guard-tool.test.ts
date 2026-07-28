import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { registerAllTools, registerSessionGuardTool } from "../../src/mcp/tools.js";
import { registerDegradedTools } from "../../src/mcp/index.js";
import { toolSchema } from "./tool-schema-helpers.js";

/**
 * T-446: `storybloq_session_guard` MCP contract.
 *
 * Registration in BOTH modes is the load-bearing assertion. Degraded mode
 * previously exposed only `storybloq_status` and `storybloq_init`; the guard
 * joins that otherwise minimal surface here, because a tools.ts-only
 * registration would leave it unavailable on exactly the no-project case the
 * skill hits first.
 */

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

interface Registry {
  readonly tools: Map<string, RegisteredTool>;
  /** Every registration, in order. A Map alone hides duplicates by overwriting. */
  readonly registrations: string[];
  readonly removals: string[];
}

/**
 * The fake server mirrors the real one closely enough to expose a lifecycle bug:
 * it counts registrations per name and throws on a duplicate, because the MCP
 * SDK does too. A Map-only fake silently overwrites, which is how a
 * double-registration can pass a test and then break the live tool swap.
 */
function makeRegistry(): { registry: Registry; server: never } {
  const registry: Registry = { tools: new Map(), registrations: [], removals: [] };
  const server = {
    registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) => {
      if (registry.tools.has(name)) throw new Error(`Tool ${name} is already registered`);
      registry.registrations.push(name);
      registry.tools.set(name, { config, handler });
      return {
        remove: () => {
          registry.removals.push(name);
          registry.tools.delete(name);
        },
      };
    },
    sendToolListChanged: () => {},
  } as unknown as never;
  return { registry, server };
}

function capture(register: (server: never, root: string) => void, root: string): Map<string, RegisteredTool> {
  const { registry, server } = makeRegistry();
  register(server, root);
  return registry.tools;
}

/** Registrations minus removals: what is actually live under this name. */
function liveCount(registry: Registry, name: string): number {
  const registered = registry.registrations.filter((n) => n === name).length;
  const removed = registry.removals.filter((n) => n === name).length;
  return registered - removed;
}

/**
 * Runs `fn` with the given environment applied, restoring afterwards. Deleting
 * on `undefined` matters: a leftover `CODEX_THREAD_ID` would pick a different
 * identity branch than the one under test.
 */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Client identity is pinned for the whole file, not per test.
 *
 * The production handler resolves the client from `STORYBLOQ_CLIENT` and reads
 * that client's id variable, so a runner (or an earlier test) that leaves any of
 * the three populated changes the expected ownership relationship without
 * changing any behavior under test. Tests that need specific values set them
 * with `withEnv`; everything else starts from a known-empty identity.
 */
const identityKeys = ["STORYBLOQ_CLIENT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"] as const;
let savedIdentity: Map<string, string | undefined>;
beforeEach(() => {
  savedIdentity = new Map(identityKeys.map((k) => [k, process.env[k]]));
  process.env.STORYBLOQ_CLIENT = "claude";
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
});
afterEach(() => {
  for (const [k, v] of savedIdentity) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "storybloq-guard-mcp-"));
  roots.push(root);
  await initProject(root, { name: "guard", type: "npm" });
  return root;
}

async function writeSession(root: string, dir: string, state: Record<string, unknown>): Promise<void> {
  const path = join(root, ".story", "sessions", dir);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "state.json"),
    JSON.stringify({
      sessionId: dir,
      status: "active",
      state: "IMPLEMENT",
      mode: "auto",
      ticket: { id: "T-020", title: "Task ownership" },
      compactPending: false,
      lease: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      ...state,
    }),
  );
}

async function call(tool: RegisteredTool, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = toolSchema(tool.config.inputSchema).parse(input) as Record<string, unknown>;
  const result = await tool.handler(parsed);
  expect(result.isError, result.content[0]?.text).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("storybloq_session_guard registration", () => {
  it("registers in the full tool set", async () => {
    const tools = capture(registerAllTools as never, await project());
    expect(tools.has("storybloq_session_guard")).toBe(true);
  });

  it("registers in degraded mode, where the skill needs it most", async () => {
    const bare = await mkdtemp(join(tmpdir(), "storybloq-guard-degraded-"));
    roots.push(bare);
    const tools = capture(registerDegradedTools as never, bare);
    expect(tools.has("storybloq_session_guard")).toBe(true);
  });

  it("returns `free` with no .story/ rather than erroring", async () => {
    const bare = await mkdtemp(join(tmpdir(), "storybloq-guard-degraded-"));
    roots.push(bare);
    const tools = capture(registerDegradedTools as never, bare);
    const out = await call(tools.get("storybloq_session_guard")!, {});
    expect(out.overallAction).toBe("free");
    expect(out.sessions).toEqual([]);
  });

  /**
   * The degraded guard and the full-set guard share a name, so the post-init
   * swap has to remove one before registering the other. Registering twice
   * throws, the throw lands in the swap's catch, and the catch re-registers the
   * degraded surface -- leaving the user in degraded mode after an init that
   * SUCCEEDED. This exercises the real swap rather than the initial map.
   */
  it("survives the degraded -> full swap with exactly one guard registered", async () => {
    const bare = await mkdtemp(join(tmpdir(), "storybloq-guard-swap-"));
    roots.push(bare);
    const { registry, server } = makeRegistry();
    (registerDegradedTools as (s: never, root: string) => void)(server, bare);
    expect(liveCount(registry, "storybloq_session_guard")).toBe(1);

    const origCwd = process.cwd();
    process.chdir(bare);
    let text: string;
    try {
      const result = await registry.tools.get("storybloq_init")!.handler({ name: "swap", type: "npm" });
      text = result.content[0]!.text;
    } finally {
      process.chdir(origCwd);
    }

    expect(text).toContain("Initialized");
    expect(text, "swap failed and fell back to degraded mode").not.toContain("tool registration failed");
    // The full set is present, and the guard survived as a single registration.
    expect(registry.tools.has("storybloq_ticket_create")).toBe(true);
    expect(registry.tools.has("storybloq_session_guard")).toBe(true);
    expect(liveCount(registry, "storybloq_session_guard")).toBe(1);
    expect(registry.registrations.filter((n) => n === "storybloq_session_guard")).toHaveLength(2);
    expect(registry.removals).toContain("storybloq_session_guard");
  });
});

describe("storybloq_session_guard contract", () => {
  /**
   * The collision diagnostic has to survive the tool boundary, not just exist
   * in the classifier.
   *
   * Deduplication drops one record from `sessions`, so the note is the ONLY
   * place the dropped directory is named. A handler projection that omitted
   * `transcriptionNotes` would leave an operator holding a collision they
   * cannot address, while every classifier test stayed green.
   */
  it("returns the duplicate-sessionId note through the serialized response", async () => {
    const root = await project();
    await writeSession(root, "dir-aaa", { sessionId: "collided" });
    await writeSession(root, "dir-zzz", { sessionId: "collided" });

    const tools = capture(registerSessionGuardTool as never, root);
    const out = await call(tools.get("storybloq_session_guard")!, {});

    expect(out.sessions, "deduplication did not happen at the boundary").toHaveLength(1);
    const notes = out.transcriptionNotes as string[] | undefined;
    expect(notes, "transcriptionNotes did not survive the tool boundary").toBeDefined();
    const note = (notes ?? []).find((n) => n.includes("collided"));
    expect(note, `no collision note: ${JSON.stringify(notes)}`).toBeDefined();
    // Both directories, and which is which -- otherwise the operator knows a
    // collision exists but not what to inspect or delete.
    expect(note).toContain("dir-aaa");
    expect(note).toContain("dir-zzz");
    expect(note).toMatch(/kept dir-aaa, dropped dir-zzz/);
  });

  /**
   * A malformed id must DEGRADE, not fail.
   *
   * > Missing or malformed identity never blocks the legacy workflow, but it
   * > cannot prove same-task ownership.
   *
   * A schema regex here would reject the whole call, leaving the caller with no
   * verdict at all -- which is blocking, in the plainest sense of the word. So
   * this tool is deliberately looser than `storybloq_autonomous_guide`, which
   * keeps the pattern because it MUTATES ownership. The pattern still applies,
   * one layer in, via `normalizeClientTaskId`.
   *
   * This is invisible to classifier tests: they call `evaluateSessionGuard`
   * directly and never cross the boundary that was rejecting the argument.
   */
  it("accepts a malformed clientTaskId at the boundary rather than rejecting the call", async () => {
    const tools = capture(registerSessionGuardTool as never, await project());
    const schema = toolSchema(tools.get("storybloq_session_guard")!.config.inputSchema);
    expect(() => schema.parse({})).not.toThrow();
    expect(() => schema.parse({ clientTaskId: "ok-task-1" })).not.toThrow();
    expect(() => schema.parse({ clientTaskId: "not a valid id!!" })).not.toThrow();
  });

  /**
   * Precedence, which the ownerless variant below cannot see.
   *
   * With both environment variables cleared, "normalize the explicit value to
   * null, then inherit the environment" and "select explicit over environment,
   * then normalize" produce the same answer. They differ only when the
   * environment HAS a valid id: the first would silently identify the caller as
   * the environment's owner after being handed a malformed explicit id, which
   * contradicts the contract that a supplied malformed id degrades to no
   * identity. `explicit ?? environment` is the precedence Step 0.5 preserves,
   * with normalization after it.
   */
  it("does not fall back to the environment when an explicit id is malformed", async () => {
    const root = await project();
    const tools = capture(registerSessionGuardTool as never, root);
    const guard = tools.get("storybloq_session_guard")!;

    const saved = { claude: process.env.CLAUDE_CODE_SESSION_ID, codex: process.env.CODEX_THREAD_ID };
    process.env.CLAUDE_CODE_SESSION_ID = "valid-environment-task";
    delete process.env.CODEX_THREAD_ID;
    try {
      const result = await guard.handler({ clientTaskId: "not a valid id!!" }, {});
      const payload = JSON.parse((result.content[0] as { text: string }).text) as {
        identityUnavailable: boolean;
      };
      expect(
        payload.identityUnavailable,
        "a malformed explicit id inherited the environment identity instead of degrading",
      ).toBe(true);
    } finally {
      if (saved.claude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = saved.claude;
      if (saved.codex !== undefined) process.env.CODEX_THREAD_ID = saved.codex;
    }
  });

  it("treats a malformed clientTaskId as no identity, and still returns a verdict", async () => {
    const root = await project();
    const tools = capture(registerSessionGuardTool as never, root);
    const guard = tools.get("storybloq_session_guard")!;

    const saved = { claude: process.env.CLAUDE_CODE_SESSION_ID, codex: process.env.CODEX_THREAD_ID };
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    try {
      const result = await guard.handler({ clientTaskId: "not a valid id!!" }, {});
      const payload = JSON.parse((result.content[0] as { text: string }).text) as {
        identityUnavailable: boolean;
        overallAction: string | null;
      };
      // A verdict, not an error: the caller is told it cannot prove ownership
      // and can still act on the classification.
      expect(payload.identityUnavailable).toBe(true);
      expect(payload.overallAction).not.toBeNull();
    } finally {
      if (saved.claude !== undefined) process.env.CLAUDE_CODE_SESSION_ID = saved.claude;
      if (saved.codex !== undefined) process.env.CODEX_THREAD_ID = saved.codex;
    }
  });

  /**
   * The boundary is string-or-omitted by design, so an MCP caller has no way to
   * assert "identity unavailable" over a populated environment variable --
   * omission inherits it. Pinned as a test rather than left implicit because the
   * alternative reading (null forces the identity off) is a plausible thing to
   * add later, and it would be a new capability rather than a transcription of
   * Step 0.5, whose resolver is `explicit ?? environment`.
   */
  it("has no wire representation for an explicitly absent identity", async () => {
    const tools = capture(registerSessionGuardTool as never, await project());
    const schema = toolSchema(tools.get("storybloq_session_guard")!.config.inputSchema);
    expect(() => schema.parse({ clientTaskId: null })).toThrow();
  });

  /**
   * Depends on the file-level identity pin above rather than the ambient
   * environment: the handler resolves the client from `STORYBLOQ_CLIENT`, so a
   * runner with `STORYBLOQ_CLIENT=codex` would classify this Claude-owned
   * session as foreign and fail on unchanged behavior.
   */
  it("classifies the caller's own live session as same-owner / continue", async () => {
    const root = await project();
    await writeSession(root, "mine", {
      ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
    });
    const tools = capture(registerSessionGuardTool as never, root);
    const out = await call(tools.get("storybloq_session_guard")!, { clientTaskId: "caller-task" });
    expect(out.overallAction).toBe("continue");
    expect(out.identityUnavailable).toBe(false);
  });

  it("returns a null overallAction when more than one session bears, with both verdicts intact", async () => {
    const root = await project();
    await writeSession(root, "mine", {
      ownerTask: { client: "claude", id: "caller-task", boundAt: "2026-07-01T00:00:00Z" },
    });
    await writeSession(root, "theirs", {
      ownerTask: { client: "claude", id: "other-task", boundAt: "2026-07-01T00:00:00Z" },
    });
    const tools = capture(registerSessionGuardTool as never, root);
    const out = await call(tools.get("storybloq_session_guard")!, { clientTaskId: "caller-task" });
    expect(out.overallAction).toBeNull();
    expect(out.primary).toBeNull();

    // The warning has to cross the boundary too. A null action with no
    // explanation leaves an MCP caller holding conflicting per-session verdicts
    // and nothing telling them the conflict is unresolved -- at which point
    // picking the permissive one looks reasonable.
    const rationale = String(out.overallRationale ?? "");
    expect(rationale, "no aggregate explanation survived serialization").toMatch(/no aggregate verdict/i);
    expect(rationale).toMatch(/unresolved hazard, not a permission/i);
    expect(rationale).toMatch(/ISS-898/);
    expect(rationale, "the serialized rationale still authorizes execution").not.toMatch(
      /apply each session's own rule|act on it directly/i,
    );
    // Both directions. A payload that said "take no action" would resolve the
    // conflict by refusal, which the source supports no better.
    expect(rationale, "the serialized rationale resolves the conflict by refusal").not.toMatch(
      /do not act on any|take no action|refuse to act on/i,
    );
    expect((out.sessions as unknown[])).toHaveLength(2);
  });

  /**
   * The directory name is a real session id, because that is what
   * `resolveSessionSelector` accepts. An operator handed only the embedded
   * `sessionId` of a mismatched record cannot address the session at all, which
   * is the entire reason `sourceDir` is on the payload.
   */
  it("emits sourceDir alongside sessionId so an operator has a usable selector", async () => {
    const dirUuid = "11111111-2222-4333-8444-555555555555";
    const embeddedUuid = "99999999-8888-4777-8666-555555555555";
    const root = await project();
    await writeSession(root, dirUuid, { sessionId: embeddedUuid, ownerTask: null });
    const tools = capture(registerSessionGuardTool as never, root);
    const out = await call(tools.get("storybloq_session_guard")!, { clientTaskId: "caller-task" });
    const session = (out.sessions as Record<string, unknown>[])[0]!;
    expect(session.sessionId).toBe(embeddedUuid);
    expect(session.sourceDir).toBe(dirUuid);
  });

  /**
   * Omitting the field inherits the client's environment identity, matching how
   * `currentClientTaskId` resolves the guide's own caller. Parsing `{}` against
   * the schema does not prove that; only invoking the handler does. A boundary
   * that dropped the value on the floor would report the caller's OWN session as
   * foreign and steer it to monitor-only.
   */
  it("falls back to the environment identity when clientTaskId is omitted", async () => {
    const root = await project();
    await writeSession(root, "mine", {
      ownerTask: { client: "claude", id: "env-task-id", boundAt: "2026-07-01T00:00:00Z" },
    });
    const tools = capture(registerSessionGuardTool as never, root);

    await withEnv(
      { STORYBLOQ_CLIENT: "claude", CLAUDE_CODE_SESSION_ID: "env-task-id", CODEX_THREAD_ID: undefined },
      async () => {
        const out = await call(tools.get("storybloq_session_guard")!, {});
        expect(out.identityUnavailable).toBe(false);
        expect(out.overallAction).toBe("continue");
      },
    );
  });

  /**
   * The same fallback, through the MCP boundary, for the other client. A guard
   * that read CLAUDE_CODE_SESSION_ID regardless of client would call this
   * Codex caller's OWN session foreign, and would also match a stale Claude id
   * against a Codex-owned session. Both clients are exercised because only one
   * of them is the default, and a default-only test proves nothing about pairing.
   */
  it("pairs the codex client with CODEX_THREAD_ID, not the claude variable", async () => {
    const root = await project();
    await writeSession(root, "mine", {
      ownerTask: { client: "codex", id: "codex-thread-id", boundAt: "2026-07-01T00:00:00Z" },
    });
    const tools = capture(registerSessionGuardTool as never, root);

    await withEnv(
      {
        STORYBLOQ_CLIENT: "codex",
        CODEX_THREAD_ID: "codex-thread-id",
        // Set, and deliberately wrong: reading it here is the bug.
        CLAUDE_CODE_SESSION_ID: "claude-leftover-id",
      },
      async () => {
        const out = await call(tools.get("storybloq_session_guard")!, {});
        expect(out.identityUnavailable).toBe(false);
        expect(out.overallAction).toBe("continue");
      },
    );
  });

  it("treats a session owned by a different environment identity as foreign", async () => {
    const root = await project();
    await writeSession(root, "theirs", {
      ownerTask: { client: "claude", id: "someone-else", boundAt: "2026-07-01T00:00:00Z" },
    });
    const tools = capture(registerSessionGuardTool as never, root);

    await withEnv(
      { STORYBLOQ_CLIENT: "claude", CLAUDE_CODE_SESSION_ID: "env-task-id", CODEX_THREAD_ID: undefined },
      async () => {
        const out = await call(tools.get("storybloq_session_guard")!, {});
        expect(out.identityUnavailable).toBe(false);
        expect(out.overallAction).toBe("monitor-only");
      },
    );
  });

  it("does not name a question tool anywhere in the payload (ISS-833)", async () => {
    const root = await project();
    await writeSession(root, "theirs", {
      ownerTask: { client: "claude", id: "other-task", boundAt: "2026-07-01T00:00:00Z" },
    });
    const tools = capture(registerSessionGuardTool as never, root);
    const out = await call(tools.get("storybloq_session_guard")!, { clientTaskId: "caller-task" });
    expect(JSON.stringify(out)).not.toMatch(/AskUserQuestion/i);
  });
});

describe("population survives serialization, since Step 2 reconciles on it", () => {
  it("labels an active and a resumable verdict at the MCP boundary", async () => {
    const root = await project();
    await writeSession(root, "s-live", { sessionId: "s-live", state: "IMPLEMENT", ownerTask: null });
    await writeSession(root, "s-compact", {
      sessionId: "s-compact",
      state: "COMPACT",
      compactPending: true,
      lease: { expiresAt: "2020-01-01T00:00:00.000Z" },
      ownerTask: null,
    });

    const tools = capture(registerSessionGuardTool as never, root);
    const out = await call(tools.get("storybloq_session_guard")!, { clientTaskId: "caller-task" });
    const sessions = out.sessions as Record<string, unknown>[];
    const byId = new Map(sessions.map((v) => [v.sessionId as string, v]));

    expect(byId.size, "fixture did not produce both populations").toBe(2);
    expect(byId.get("s-live")?.population, "active verdict lost its population in serialization").toBe(
      "activeSessions",
    );
    expect(byId.get("s-compact")?.population, "resumable verdict lost its population in serialization").toBe(
      "resumableSessions",
    );
  });
});
