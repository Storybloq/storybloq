/**
 * T-489 wake wiring: the tier must run on the USER-FACING send path.
 *
 * The defect these exist to prevent is not subtle and it is not hypothetical: the
 * whole tier shipped once as a function with zero call sites, behind a green suite
 * and four review rounds. Every test here therefore drives a REAL send surface (the
 * yargs command tree, or the registered MCP tool handler) rather than the helper
 * they share, and asserts on what a sender actually observes.
 */

import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wakeCalls: { root: string; threadId: string; recipientId: string; wakeText: string }[] = [];
let wakeResult: (() => Promise<unknown>) | null = null;

vi.mock("../../src/bus/wake-runner.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    wakeAfterSend: async (input: {
      root: string;
      threadId: string;
      recipient: { endpointId: string };
      wakeText: string;
    }) => {
      wakeCalls.push({
        root: input.root,
        threadId: input.threadId,
        recipientId: input.recipient.endpointId,
        wakeText: input.wakeText,
      });
      if (wakeResult) return await wakeResult();
      return { kind: "requested", wakeId: "wake-1" };
    },
  };
});

const { BUS_WAKE_TEXT } = await import("../../src/bus/wake.js");
const { updateEndpoint } = await import("../../src/bus/endpoints.js");
const { pollBus } = await import("../../src/bus/index.js");
const { registerBusTools } = await import("../../src/mcp/bus-tools.js");
const { createBusFixture } = await import("./helpers.js");
const { runBusCli } = await import("./cli-harness.js");
const { wakeForSend } = await import("../../src/bus/send-with-wake.js");

let fixture: Awaited<ReturnType<typeof createBusFixture>>;

beforeEach(async () => {
  wakeCalls.length = 0;
  wakeResult = null;
  fixture = await createBusFixture("t489-wiring");
});

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

/** Both surfaces answer in a `{version, data}` envelope; the send result is `data`. */
function payload(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as { data?: unknown; error?: unknown };
  if (parsed.error !== undefined) throw new Error(`send failed: ${JSON.stringify(parsed.error)}`);
  return parsed.data as Record<string, unknown>;
}

/** The CODEX endpoint is the recipient, so a Claude sender wakes it. */
async function armCodexRecipient(policy: "idle" | "never"): Promise<void> {
  await updateEndpoint(fixture.root, fixture.a.endpointId, (current) => ({
    ...current,
    wakePolicy: policy,
  }));
}

function sendArgs(format: "md" | "json"): string[] {
  return [
    "bus", "send",
    "--endpoint", fixture.b.endpointId,
    "--task-id", fixture.bTaskId,
    "--thread-kind", "question",
    "--kind", "question",
    "--severity", "info",
    "--body", "does the wake tier actually run",
    "--idempotency-key", randomUUID(),
    // A new thread needs a ref; the Bus refuses one without.
    "--ci-run", "ci-t489-wiring",
    "--format", format,
  ];
}

describe("T-489 the CLI send path runs the wake tier", () => {
  it("invokes the wake ONCE, with the recipient endpoint and the shared text", async () => {
    await armCodexRecipient("idle");
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    const result = payload(stdout) as unknown as { threadId: string; messageId: string; wake?: string };

    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.recipientId).toBe(fixture.a.endpointId);
    expect(wakeCalls[0]!.threadId).toBe(result.threadId);
    // realpath: the CLI harness chdirs into the root and the command rediscovers
    // it, so /var and /private/var are the same directory by two names.
    expect(realpathSync(wakeCalls[0]!.root)).toBe(realpathSync(fixture.root));
    // Not "some string": the exact text, defined once, that the peer's agent reads.
    expect(wakeCalls[0]!.wakeText).toBe(BUS_WAKE_TEXT);
  });

  it("surfaces the outcome in the JSON result", async () => {
    await armCodexRecipient("idle");
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    expect(payload(stdout)["wake"]).toBe("requested");
  });

  it("surfaces the outcome in the human summary", async () => {
    await armCodexRecipient("idle");
    const { stdout } = await runBusCli(fixture.root, sendArgs("md"));
    expect(stdout).toContain("Wake: requested");
    // The send sentence stays intact: the two facts are reported separately.
    expect(stdout).toContain("in thread");
  });

  it("does NOT invoke the wake for an endpoint that never opted in", async () => {
    await armCodexRecipient("never");
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    expect(wakeCalls).toHaveLength(0);
    // ABSENT, not null: no attempt is a different fact from a recorded outcome.
    expect(payload(stdout)).not.toHaveProperty("wake");
  });

  it("does not report a wake when the tier declines the attempt", async () => {
    await armCodexRecipient("idle");
    wakeResult = async () => ({ kind: "no-attempt" });
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    expect(payload(stdout)).not.toHaveProperty("wake");
  });

  it("reports a skip as telemetry rather than hiding it", async () => {
    await armCodexRecipient("idle");
    wakeResult = async () => ({ kind: "skipped", reason: "active-turn" });
    const { stdout } = await runBusCli(fixture.root, sendArgs("json"));
    expect(payload(stdout)["wake"]).toBe("skipped:active-turn");
  });

  it("a REPLAYED send wakes nobody a second time", async () => {
    // Retrying an idempotency key commits nothing new. Waking again would start a
    // second turn on the peer and append a second wake entry for one message, which
    // is the retry the plan ruled out arriving through the back door.
    await armCodexRecipient("idle");
    const args = sendArgs("json");
    const first = payload((await runBusCli(fixture.root, args)).stdout);
    expect(wakeCalls).toHaveLength(1);

    const second = payload((await runBusCli(fixture.root, args)).stdout);
    expect(second["replayed"]).toBe(true);
    expect(second["messageId"]).toBe(first["messageId"]);
    expect(second).not.toHaveProperty("wake");
    expect(wakeCalls).toHaveLength(1);
  });

  it("a THROWING wake never fails the send, and the mail is still committed", async () => {
    // The tier is advisory. A send that reported failure because a wake blew up
    // would be strictly worse than having no wake tier at all.
    await armCodexRecipient("idle");
    wakeResult = async () => {
      throw new Error("app-server exploded");
    };
    const { stdout, exitCode } = await runBusCli(fixture.root, sendArgs("json"));
    const result = payload(stdout) as unknown as { messageId: string | null; wake?: string };
    expect(exitCode ?? 0).toBe(0);
    expect(result.messageId).not.toBeNull();
    expect(result).not.toHaveProperty("wake");

    // Committed means READABLE by the recipient, not merely reported.
    const polled = await pollBus(fixture.root, {
      endpointId: fixture.a.endpointId,
      clientTaskId: fixture.aTaskId,
    });
    expect(polled.messages.map((envelope) => envelope.message.messageId)).toContain(result.messageId);
  });
});

describe("T-489 the MCP send tool runs the same wake tier", () => {
  interface Registered {
    handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  }

  function registerAndFind(): Registered {
    const tools = new Map<string, Registered["handler"]>();
    const server = {
      registerTool: (name: string, _schema: unknown, handler: Registered["handler"]) => {
        tools.set(name, handler);
      },
    };
    registerBusTools(server as never, fixture.root);
    const handler = tools.get("storybloq_bus_send");
    if (!handler) throw new Error("storybloq_bus_send was never registered");
    return { handler };
  }

  async function send(idempotencyKey = randomUUID()): Promise<Record<string, unknown>> {
    const { handler } = registerAndFind();
    const out = await handler({
      endpointId: fixture.b.endpointId,
      clientTaskId: fixture.bTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "info",
      body: "does the MCP path wake too",
      refs: { ciRun: "ci-t489-wiring" },
      idempotencyKey,
    });
    return payload(out.content[0]!.text);
  }

  it("invokes the wake ONCE and reports the outcome", async () => {
    await armCodexRecipient("idle");
    const result = await send();
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0]!.recipientId).toBe(fixture.a.endpointId);
    expect(wakeCalls[0]!.wakeText).toBe(BUS_WAKE_TEXT);
    expect(result["wake"]).toBe("requested");
  });

  it("does NOT invoke the wake for an endpoint that never opted in", async () => {
    await armCodexRecipient("never");
    const result = await send();
    expect(wakeCalls).toHaveLength(0);
    expect(result).not.toHaveProperty("wake");
  });

  it("a REPLAYED send wakes nobody a second time", async () => {
    await armCodexRecipient("idle");
    const key = randomUUID();
    const first = await send(key);
    expect(wakeCalls).toHaveLength(1);

    const second = await send(key);
    expect(second["replayed"]).toBe(true);
    expect(second["messageId"]).toBe(first["messageId"]);
    expect(second).not.toHaveProperty("wake");
    expect(wakeCalls).toHaveLength(1);
  });

  it("a THROWING wake never fails the send", async () => {
    await armCodexRecipient("idle");
    wakeResult = async () => {
      throw new Error("app-server exploded");
    };
    const result = await send();
    expect(result["messageId"]).not.toBeNull();
    expect(result).not.toHaveProperty("wake");
  });
});

describe("T-489 the wake identifies itself with the REAL version", () => {
  it("sends storybloq's package version, not a literal", async () => {
    // A fabricated identity string in the daemon's userAgent makes a wake
    // unattributable, which is the one thing the field is for.
    const { __wakeRunnerTesting } = await import("../../src/bus/wake-runner.js");
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version: string };
    expect(__wakeRunnerTesting.clientVersion()).toBe(pkg.version);
    expect(__wakeRunnerTesting.clientVersion()).not.toBe("1.0.0");
  });
});

describe("T-489 a send that committed no mail wakes nobody", () => {
  function sendResult(over: Record<string, unknown>): never {
    return {
      threadId: "00000000-0000-4000-8000-000000000000",
      messageId: "11111111-1111-4111-8111-111111111111",
      toEndpoint: "",
      state: "open",
      hopCount: 1,
      hopsRemaining: 5,
      replayed: false,
      replaySource: "none",
      parked: false,
      nextAction: null,
      ...over,
    } as never;
  }

  it("does not wake for a PARKED send", async () => {
    // A hop-capped send was refused. The peer has nothing new to poll, so waking
    // it would send an agent to look at an empty inbox.
    await armCodexRecipient("idle");
    const out = await wakeForSend(
      fixture.root,
      sendResult({ toEndpoint: fixture.a.endpointId, parked: true }),
    );
    expect(out).toBeNull();
    expect(wakeCalls).toHaveLength(0);
  });

  it("does not wake when no message id was minted", async () => {
    await armCodexRecipient("idle");
    const out = await wakeForSend(
      fixture.root,
      sendResult({ toEndpoint: fixture.a.endpointId, messageId: null }),
    );
    expect(out).toBeNull();
    expect(wakeCalls).toHaveLength(0);
  });

  it("does not wake for a REPLAYED send", async () => {
    await armCodexRecipient("idle");
    const out = await wakeForSend(
      fixture.root,
      sendResult({ toEndpoint: fixture.a.endpointId, replayed: true, replaySource: "receipt" }),
    );
    expect(out).toBeNull();
    expect(wakeCalls).toHaveLength(0);
  });

  it("does not wake a recipient it cannot read", async () => {
    // Without the endpoint there is no policy to honour and no thread to wake.
    // Guessing one would be the same fabrication the gates exist to prevent.
    const out = await wakeForSend(
      fixture.root,
      sendResult({ toEndpoint: "22222222-2222-4222-8222-222222222222" }),
    );
    expect(out).toBeNull();
    expect(wakeCalls).toHaveLength(0);
  });

  it("DOES wake an ordinary committed send (negative control)", async () => {
    // Without this, gating everything out would pass all three tests above.
    await armCodexRecipient("idle");
    const out = await wakeForSend(fixture.root, sendResult({ toEndpoint: fixture.a.endpointId }));
    expect(out).toBe("requested");
    expect(wakeCalls).toHaveLength(1);
  });
});
