import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initializeBus, joinEndpoint } from "../../src/bus/index.js";
import { createBusFixture, createIssue, type BusFixture } from "../bus/helpers.js";
import { toolSchema } from "./tool-schema-helpers.js";

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

function parsedArgs(tool: RegisteredTool, input: Record<string, unknown>): Record<string, unknown> {
  return toolSchema(tool.config.inputSchema).parse(input) as Record<string, unknown>;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Hand-builds a residual v1 Bus runtime on disk (schema literal + one endpoint)
// without enabling the feature, so the MCP handlers must gate before dispatching
// to the ungated v1 legacy-drain path.
async function writeV1Runtime(root: string): Promise<{ endpointId: string; taskId: string }> {
  const busRoot = join(root, ".story", "bus");
  for (const dir of [
    "threads", "endpoints", "succession", "locks",
    "mailboxes/implementer", "mailboxes/implementer/pending",
    "mailboxes/reviewer", "mailboxes/reviewer/pending",
  ]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }
  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: "0".repeat(64),
    createdAt: now,
  }, null, 2) + "\n", "utf-8");
  const endpointId = randomUUID();
  const taskId = "codex-task-v1";
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role: "implementer",
    client: "codex",
    surface: "codex_desktop",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt: null,
    retiredReason: null,
  }, null, 2) + "\n", "utf-8");
  return { endpointId, taskId };
}

// Same succession technique store.test.ts uses for finding #12/#14 fast-path
// tests: forge the current holder as a dead process, then replace it so the
// next caller has no prior receipt and is eligible for the marker-hit fast
// path (a same-caller repeat would fall through to sendBusMessage's own,
// pre-existing receipt lookup instead, never reaching the branch under test).
async function forgeOffline(root: string, endpointId: string): Promise<void> {
  const path = join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
  const endpoint = JSON.parse(await readFile(path, "utf-8"));
  await writeFile(path, JSON.stringify({
    ...endpoint,
    state: "attached",
    processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
  }, null, 2) + "\n", "utf-8");
}

async function replaceWithSuccessor(root: string, replaceId: string, taskId: string) {
  return (await joinEndpoint(root, {
    client: "claude",
    clientTaskId: taskId,
    surface: "claude_cli",
    replace: replaceId,
  })).endpoint;
}

describe("always-registered Storybloq Bus MCP tools", () => {
  // D6: the six Bus tools always register for a full project (was feature-gated).
  // A disabled call returns setup guidance instead of being absent.
  it("registers the six Bus tools even when Bus is disabled and returns setup guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-bus-disabled-"));
    roots.push(root);
    await initProject(root, { name: "disabled" });
    const tools = captureTools(root);
    expect([...tools.keys()].filter((name) => name.startsWith("storybloq_bus_")).sort()).toEqual([
      "storybloq_bus_ack",
      "storybloq_bus_poll",
      "storybloq_bus_redeliver",
      "storybloq_bus_send",
      "storybloq_bus_thread_get",
      "storybloq_bus_thread_update",
    ]);
    const poll = tools.get("storybloq_bus_poll")!;
    const result = await poll.handler(parsedArgs(poll, {
      endpointId: "00000000-0000-0000-0000-000000000000",
      clientTaskId: "codex-task-disabled",
    }));
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0]!.text).error;
    expect(error.code).toBe("bus_disabled");
    expect(error.message).toContain("storybloq bus setup");
  });

  it("returns bus_disabled for poll and thread_update when Bus is disabled but a v1 runtime is present (R18)", async () => {
    // R18: the v1 legacy-drain dispatch never asserts enablement itself, so the
    // poll/thread_update handlers must gate before classifying the runtime, or a
    // disabled project with a residual v1 runtime stays drainable (as ack already
    // gates). This mirrors the disabled-call contract for the ungated v1 path.
    const root = await mkdtemp(join(tmpdir(), "mcp-bus-v1-disabled-"));
    roots.push(root);
    await initProject(root, { name: "v1-disabled" }); // features.bus stays disabled
    const { endpointId, taskId } = await writeV1Runtime(root);
    const tools = captureTools(root);

    const poll = tools.get("storybloq_bus_poll")!;
    const polled = await poll.handler(parsedArgs(poll, { endpointId, clientTaskId: taskId }));
    expect(polled.isError).toBe(true);
    expect(JSON.parse(polled.content[0]!.text).error.code).toBe("bus_disabled");

    const threadUpdate = tools.get("storybloq_bus_thread_update")!;
    const updated = await threadUpdate.handler(parsedArgs(threadUpdate, {
      endpointId,
      clientTaskId: taskId,
      threadId: randomUUID(),
      action: "park",
      reason: "should be gated before dispatch",
    }));
    expect(updated.isError).toBe(true);
    expect(JSON.parse(updated.content[0]!.text).error.code).toBe("bus_disabled");
  });

  it("registers exactly six task-bound tools when Bus is enabled", async () => {
    const fixture: BusFixture = await createBusFixture("mcp-bus-enabled");
    roots.push(fixture.root);
    const tools = captureTools(fixture.root);
    expect([...tools.keys()].filter((name) => name.startsWith("storybloq_bus_")).sort()).toEqual([
      "storybloq_bus_ack",
      "storybloq_bus_poll",
      "storybloq_bus_redeliver",
      "storybloq_bus_send",
      "storybloq_bus_thread_get",
      "storybloq_bus_thread_update",
    ]);

    const send = tools.get("storybloq_bus_send")!;
    const sentResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Verify the MCP boundary",
      refs: { ciRun: "ci-mcp-1" },
      idempotencyKey: "mcp-question-1",
    }));
    const sent = JSON.parse(sentResult.content[0]!.text).data;
    expect(sentResult.isError).not.toBe(true);
    expect(sent.messageId).toMatch(/^[0-9a-f-]{36}$/);

    const poll = tools.get("storybloq_bus_poll")!;
    const polledResult = await poll.handler(parsedArgs(poll, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: fixture.implementerTaskId,
    }));
    const polled = JSON.parse(polledResult.content[0]!.text).data;
    expect(polled.messages[0]).toMatchObject({
      source: "storybloq_bus",
      authority: "peer_agent",
      sender: { role: null, client: "claude" },
      message: { body: "Verify the MCP boundary" },
    });

    const denied = await poll.handler(parsedArgs(poll, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: "foreign-task",
    }));
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]!.text).error.code).toBe("unauthorized");
  });

  it("adds concise Bus state to existing status JSON", async () => {
    const fixture = await createBusFixture("mcp-bus-status");
    roots.push(fixture.root);
    const status = captureTools(fixture.root).get("storybloq_status")!;
    const result = await status.handler(parsedArgs(status, { format: "json" }));
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.data.bus).toMatchObject({
      enabled: true,
      initialized: true,
      endpoints: 2,
      pendingMessages: 0,
      daemonState: "stopped",
    });
  });

  it("returns setup guidance when the runtime is enabled but not initialized", async () => {
    // D6: a disabled/uninitialized handler points the caller at `bus setup`.
    const fixture = await createBusFixture("mcp-bus-uninit");
    roots.push(fixture.root);
    await rm(join(fixture.root, ".story", "bus"), { recursive: true, force: true });
    // T-428: model a GENUINELY uninitialized checkout by also removing the gitignored
    // deletion-evidence (a clone never receives it). Deleting only the runtime while
    // evidence remains is `runtime_lost`, not `not_found`.
    await rm(join(fixture.root, ".story", ".bus-evidence.json"), { force: true });
    const poll = captureTools(fixture.root).get("storybloq_bus_poll")!;
    const result = await poll.handler(parsedArgs(poll, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: fixture.implementerTaskId,
    }));
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0]!.text).error;
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("storybloq bus setup");
  });

  it("becomes usable after an in-process config flip with no re-registration", async () => {
    // D6: `bus setup` from the CLI makes the already-running server usable. Here
    // the tools register while Bus is disabled, then the runtime is enabled and
    // joined in the same process; the captured handlers work with no re-register.
    const root = await mkdtemp(join(tmpdir(), "mcp-bus-flip-"));
    roots.push(root);
    await initProject(root, { name: "flip" });
    const tools = captureTools(root); // registered while Bus is disabled

    await initializeBus(root);
    await joinEndpoint(root, { client: "codex", clientTaskId: "codex-flip", surface: "codex_desktop" });
    const claude = (await joinEndpoint(root, { client: "claude", clientTaskId: "claude-flip", surface: "claude_cli" })).endpoint;

    const send = tools.get("storybloq_bus_send")!;
    const result = await send.handler(parsedArgs(send, {
      endpointId: claude.endpointId,
      clientTaskId: "claude-flip",
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Usable after the flip",
      refs: { ciRun: "ci-flip" },
      idempotencyKey: "flip-1",
    }));
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content[0]!.text).data;
    expect(data.messageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports an enabled but uninitialized fresh checkout without an error", async () => {
    const fixture = await createBusFixture("mcp-bus-fresh-checkout");
    roots.push(fixture.root);
    await rm(join(fixture.root, ".story", "bus"), { recursive: true, force: true });
    const status = captureTools(fixture.root).get("storybloq_status")!;

    const result = await status.handler(parsedArgs(status, { format: "json" }));
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.data.bus).toMatchObject({
      enabled: true,
      initialized: false,
      endpoints: 0,
      pendingMessages: 0,
    });
    expect(parsed.data.bus.error).toBeUndefined();
  });

  // ISS-953 fix step 3: hopsRemaining must be pinned THROUGH the MCP boundary,
  // not against the store function directly -- a schema that silently strips a
  // report field (ISS-988) can only be caught by a test that goes through the
  // real tool handler, and hopsRemaining is a genuinely new MCP-visible field.
  it("surfaces hopsRemaining consistently on bus_send and bus_thread_get through the MCP boundary (ISS-953)", async () => {
    const fixture: BusFixture = await createBusFixture("mcp-bus-hops-remaining");
    roots.push(fixture.root);
    const configPath = join(fixture.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const tools = captureTools(fixture.root);
    const send = tools.get("storybloq_bus_send")!;
    const threadGet = tools.get("storybloq_bus_thread_get")!;

    const firstResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "First hop toward the cap",
      refs: { ciRun: "ci-hops-1" },
      idempotencyKey: "hops-remaining-1",
    }));
    const first = JSON.parse(firstResult.content[0]!.text).data;
    expect(first).toMatchObject({ hopCount: 1, hopsRemaining: 1, parked: false });

    const secondResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: fixture.implementerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Second hop, lands exactly at the cap",
      refs: { ciRun: "ci-hops-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "hops-remaining-2",
    }));
    const second = JSON.parse(secondResult.content[0]!.text).data;
    expect(second).toMatchObject({ hopCount: 2, hopsRemaining: 0, parked: false });

    const got = await threadGet.handler(parsedArgs(threadGet, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadId: first.threadId,
    }));
    const thread = JSON.parse(got.content[0]!.text).data;
    expect(thread.thread.maxHops).toBe(2);
    expect(thread.hopCount).toBe(2);
    expect(thread.hopsRemaining).toBe(0);
  });

  // ISS-953 fix step 12: pins the storybloq_bus_redeliver tool's declared schema
  // and dispatch through the real MCP boundary -- a schema that silently strips or
  // mis-shapes a field can only be caught by a test that goes through the actual
  // tool handler, not the store function directly. The full named marker/receipt
  // branch semantics (marker-hit, corrupt-marker, authorization) are covered
  // directly against redeliverBusMessage in test/bus/store.test.ts; this test only
  // proves the tool is wired correctly end-to-end for a genuinely fresh redelivery.
  it("redelivers a hop-capped park through the storybloq_bus_redeliver MCP tool (ISS-953 fix step 12)", async () => {
    const fixture: BusFixture = await createBusFixture("mcp-bus-redeliver");
    roots.push(fixture.root);
    const issueId = await createIssue(fixture.root, "medium");
    const configPath = join(fixture.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const tools = captureTools(fixture.root);
    const send = tools.get("storybloq_bus_send")!;
    const threadGet = tools.get("storybloq_bus_thread_get")!;
    const redeliver = tools.get("storybloq_bus_redeliver")!;
    expect(redeliver).toBeDefined();

    const firstResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      severity: "medium",
      body: "Opening the finding.",
      refs: { issue: issueId },
      idempotencyKey: "mcp-redeliver-first",
    }));
    const first = JSON.parse(firstResult.content[0]!.text).data;
    expect(first).toMatchObject({ hopCount: 1, parked: false });

    const ackResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: fixture.implementerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      idempotencyKey: "mcp-redeliver-ack",
    }));
    const ack = JSON.parse(ackResult.content[0]!.text).data;
    expect(ack).toMatchObject({ hopCount: 2, parked: false });

    // Hop 3 exceeds maxHops: 2 and auto-parks. The park entry's byEndpoint is the
    // reviewer (whoever attempted the over-cap send), so redelivery below is
    // authorized as that same endpoint.
    const parkedResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "mcp-redeliver-third-over-cap",
    }));
    const parked = JSON.parse(parkedResult.content[0]!.text).data;
    expect(parked).toMatchObject({ parked: true, state: "parked" });
    expect(parked.nextAction).toMatchObject({
      procedure: "redeliver_on_hop_cap_successor",
      predecessorThreadId: first.threadId,
    });

    const got = await threadGet.handler(parsedArgs(threadGet, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadId: first.threadId,
    }));
    const thread = JSON.parse(got.content[0]!.text).data;
    const parkEntry = thread.entries.at(-1);
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap", byEndpoint: fixture.reviewer.endpointId } });

    const redeliveredResult = await redeliver.handler(parsedArgs(redeliver, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      predecessorThreadId: first.threadId,
      refusedEntryHash: parkEntry.entryHash,
    }));
    const redelivered = JSON.parse(redeliveredResult.content[0]!.text).data;
    expect(redelivered).toMatchObject({ replaySource: "none", replayed: false, parked: false });
    expect(redelivered.messageId).not.toBeNull();
    expect(redelivered.threadId).not.toBe(first.threadId);
  });

  // ISS-953 Codex round 2 finding #23 (line reference corrected, round 5
  // finding #16 -- brittle line numbers drift as helpers/tests are added
  // above; a test name doesn't): the "registers the six Bus tools even when
  // Bus is disabled and returns setup guidance" test above asserts all six
  // tools register while Bus is disabled but only ever
  // invokes storybloq_bus_poll's handler, never storybloq_bus_redeliver's --
  // so it never actually proved finding #12's fix (redeliverBusMessage's
  // marker-hit fast path asserting Bus is enabled before answering from an
  // already-verified marker, never resolving runtime state directly) is wired
  // correctly through the real MCP boundary. Build a genuine verified marker
  // first (through the tool handlers, same as the fresh-redelivery test
  // above), hand ownership to a successor so the second call has no prior
  // receipt and is eligible for the true marker-hit fast path (a same-caller
  // repeat falls through to sendBusMessage's own pre-existing receipt lookup
  // instead), disable Bus without touching its runtime on disk, then invoke
  // storybloq_bus_redeliver's registered handler directly and assert the
  // response is bus_disabled.
  it("returns bus_disabled from storybloq_bus_redeliver's marker-hit fast path when Bus is disabled without removing its runtime (ISS-953 Codex round 2 finding #23, security)", async () => {
    const fixture: BusFixture = await createBusFixture("mcp-bus-redeliver-disabled");
    roots.push(fixture.root);
    const issueId = await createIssue(fixture.root, "medium");
    const configPath = join(fixture.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const tools = captureTools(fixture.root);
    const send = tools.get("storybloq_bus_send")!;
    const threadGet = tools.get("storybloq_bus_thread_get")!;
    const redeliver = tools.get("storybloq_bus_redeliver")!;

    const firstResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      severity: "medium",
      body: "Opening the finding.",
      refs: { issue: issueId },
      idempotencyKey: "mcp-redeliver-disabled-first",
    }));
    const first = JSON.parse(firstResult.content[0]!.text).data;

    await send.handler(parsedArgs(send, {
      endpointId: fixture.implementer.endpointId,
      clientTaskId: fixture.implementerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      idempotencyKey: "mcp-redeliver-disabled-ack",
    }));

    const parkedResult = await send.handler(parsedArgs(send, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "mcp-redeliver-disabled-third-over-cap",
    }));
    const parked = JSON.parse(parkedResult.content[0]!.text).data;
    expect(parked).toMatchObject({ parked: true, state: "parked" });

    const got = await threadGet.handler(parsedArgs(threadGet, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      threadId: first.threadId,
    }));
    const thread = JSON.parse(got.content[0]!.text).data;
    const parkEntry = thread.entries.at(-1);

    // First redeliver call creates the verified marker via the ordinary
    // fallthrough path (Bus still enabled at this point).
    const firstRedeliverResult = await redeliver.handler(parsedArgs(redeliver, {
      endpointId: fixture.reviewer.endpointId,
      clientTaskId: fixture.reviewerTaskId,
      predecessorThreadId: first.threadId,
      refusedEntryHash: parkEntry.entryHash,
    }));
    const firstRedeliver = JSON.parse(firstRedeliverResult.content[0]!.text).data;
    expect(firstRedeliver.replaySource).toBe("none");

    await forgeOffline(fixture.root, fixture.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-mcp-redeliver-disabled";
    const reviewer2 = await replaceWithSuccessor(fixture.root, fixture.reviewer.endpointId, successorTaskId);

    // Disable Bus without touching its runtime on disk.
    config.features.bus = false;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const secondRedeliverResult = await redeliver.handler(parsedArgs(redeliver, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: first.threadId,
      refusedEntryHash: parkEntry.entryHash,
    }));
    expect(secondRedeliverResult.isError).toBe(true);
    const error = JSON.parse(secondRedeliverResult.content[0]!.text).error;
    expect(error.code).toBe("bus_disabled");
  });
});
