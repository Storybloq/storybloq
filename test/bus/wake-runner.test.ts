/**
 * T-489 wake runner internals.
 *
 * These cover the distinctions that vanish once an outcome has collapsed into a
 * single skip reason: proven absence versus an unreadable response, and a known
 * cursor versus a fabricated one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __wakeRunnerTesting, readPolledSeqFor, wakeAfterSend } from "../../src/bus/wake-runner.js";
import { initializeBus, joinEndpoint, sendBusMessage, updateEndpoint } from "../../src/bus/index.js";
import { resolveBusPaths } from "../../src/bus/paths.js";
import { initProject } from "../../src/core/init.js";
import { randomUUID } from "node:crypto";
import type { CodexAppServerClient } from "../../src/bus/codex-app-server.js";

const { findThreadPaged, loadedIds } = __wakeRunnerTesting;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stubClient(responses: unknown[]): CodexAppServerClient {
  let i = 0;
  return {
    request: async () => responses[Math.min(i++, responses.length - 1)],
    close: () => undefined,
  };
}

const FAR = () => Date.now() + 60_000;

describe("T-489 thread paging never turns an unreadable page into proven absence", () => {
  it("finds the thread on the first page", async () => {
    const client = stubClient([{ data: [{ id: "t-1", status: { type: "idle" } }], nextCursor: null }]);
    const out = await findThreadPaged(client, "t-1", FAR());
    expect(out).toEqual({ id: "t-1", status: { type: "idle" } });
  });

  it("reports not-found only after a VALID page ends the listing", async () => {
    const client = stubClient([{ data: [{ id: "other" }], nextCursor: null }]);
    expect(await findThreadPaged(client, "t-1", FAR())).toBe("not-found");
  });

  it("treats a non-object response as incomplete, NOT as absence", async () => {
    expect(await findThreadPaged(stubClient(["nope"]), "t-1", FAR())).toBe("incomplete");
    expect(await findThreadPaged(stubClient([null]), "t-1", FAR())).toBe("incomplete");
  });

  it("treats a missing or malformed data array as incomplete, NOT as absence", async () => {
    // An empty response object previously read as an exhausted listing and
    // recorded skipped:thread-not-found: a positive claim of absence made on a
    // response we could not read.
    expect(await findThreadPaged(stubClient([{}]), "t-1", FAR())).toBe("incomplete");
    expect(await findThreadPaged(stubClient([{ data: "not-an-array" }]), "t-1", FAR())).toBe("incomplete");
  });

  it("treats an unusable pagination cursor as incomplete, NOT as absence", async () => {
    expect(await findThreadPaged(stubClient([{ data: [], nextCursor: 42 }]), "t-1", FAR())).toBe("incomplete");
    expect(await findThreadPaged(stubClient([{ data: [], nextCursor: "" }]), "t-1", FAR())).toBe("incomplete");
  });

  it("accepts null and undefined as the documented terminal cursor", async () => {
    expect(await findThreadPaged(stubClient([{ data: [], nextCursor: null }]), "t-1", FAR())).toBe("not-found");
    expect(await findThreadPaged(stubClient([{ data: [] }]), "t-1", FAR())).toBe("not-found");
  });

  it("treats an UNINSPECTABLE record as incomplete, NOT as absence", async () => {
    // Skipping a record we could not read and then reporting `not-found` turns an
    // unreadable element into a positive claim of absence: the target could be
    // exactly the record that was skipped.
    expect(await findThreadPaged(stubClient([{ data: [null], nextCursor: null }]), "t-1", FAR())).toBe(
      "incomplete",
    );
    expect(await findThreadPaged(stubClient([{ data: ["t-1"], nextCursor: null }]), "t-1", FAR())).toBe(
      "incomplete",
    );
    expect(await findThreadPaged(stubClient([{ data: [{}], nextCursor: null }]), "t-1", FAR())).toBe(
      "incomplete",
    );
    expect(await findThreadPaged(stubClient([{ data: [{ id: 7 }], nextCursor: null }]), "t-1", FAR())).toBe(
      "incomplete",
    );
    expect(await findThreadPaged(stubClient([{ data: [{ id: "" }], nextCursor: null }]), "t-1", FAR())).toBe(
      "incomplete",
    );
  });

  it("refuses on an INTERMEDIATE page's unusable record instead of paging on to not-found", async () => {
    // The dangerous shape: page one is unreadable, page two ends the listing
    // cleanly. Continuing would let the clean terminal page supply an absence
    // conclusion that page one failed to support.
    const client = stubClient([
      { data: [null], nextCursor: "c1" },
      { data: [{ id: "other" }], nextCursor: null },
    ]);
    expect(await findThreadPaged(client, "t-1", FAR())).toBe("incomplete");
  });

  it("still returns the thread when it is found ALONGSIDE unusable records", async () => {
    // Inspection succeeded for the record that matters, so refusing here would
    // discard a positive identification on the strength of unrelated garbage.
    const client = stubClient([
      { data: [null, { id: "t-1", status: { type: "idle" } }, {}], nextCursor: null },
    ]);
    expect(await findThreadPaged(client, "t-1", FAR())).toEqual({ id: "t-1", status: { type: "idle" } });
  });

  it("reports incomplete when the deadline has already passed", async () => {
    const client = stubClient([{ data: [], nextCursor: null }]);
    expect(await findThreadPaged(client, "t-1", Date.now() - 1)).toBe("incomplete");
  });

  it("reads loaded ids as bare strings or as records carrying one", async () => {
    expect(await loadedIds(stubClient([{ data: ["a", { id: "b" }, 7, null] }]))).toEqual(["a", "b"]);
    // An empty array does not reveal its element type, so neither shape is assumed.
    expect(await loadedIds(stubClient([{ data: [] }]))).toEqual([]);
    expect(await loadedIds(stubClient([{}]))).toEqual([]);
  });
});

describe("T-489 an unknown mailbox high-water is never treated as cursor zero", () => {
  it("reports pending-unknown, not already-polled, and spawns nothing", async () => {
    // A cursor of 0 would make every nonnegative polled sequence satisfy
    // `polled >= cursor`, so an endpoint whose mailbox could not be read would
    // record skipped:already-polled-through-batch for a cursor never established.
    const root = await mkdtemp(join(tmpdir(), "t489-runner-"));
    roots.push(root);
    await initProject(root, { name: "t489-runner" });
    await initializeBus(root);
    await joinEndpoint(root, { client: "claude", clientTaskId: "task-a", surface: "claude_cli" });
    const b = (
      await joinEndpoint(root, { client: "codex", clientTaskId: "task-b", surface: "codex_cli" })
    ).endpoint;
    // Never messaged, so there is no mailbox counter to read.
    const recipient = await updateEndpoint(root, b.endpointId, (current) => ({
      ...current,
      wakePolicy: "idle",
    }));

    const outcome = await wakeAfterSend({
      root,
      threadId: "00000000-0000-4000-8000-000000000000",
      recipient,
      wakeText: "check the bus",
      deadlineMs: 3000,
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "pending-unknown" });
  });
});

describe("T-489 gate 4 refuses rather than manufacturing a cursor", () => {
  async function project(): Promise<{ root: string; codexEndpointId: string }> {
    const root = await mkdtemp(join(tmpdir(), "t489-cursor-"));
    roots.push(root);
    await initProject(root, { name: "t489-cursor" });
    await initializeBus(root);
    const a = (
      await joinEndpoint(root, { client: "claude", clientTaskId: "task-a", surface: "claude_cli" })
    ).endpoint;
    const b = (
      await joinEndpoint(root, { client: "codex", clientTaskId: "task-b", surface: "codex_cli" })
    ).endpoint;
    // Send so the recipient's mailbox counter exists and is READABLE.
    await sendBusMessage(root, {
      endpointId: a.endpointId,
      clientTaskId: "task-a",
      to: b.endpointId,
      threadKind: "question",
      body: "hello",
      messageKind: "question",
      severity: "info",
      refs: { ciRun: "ci-t489-cursor" },
      idempotencyKey: randomUUID(),
    });
    return { root, codexEndpointId: b.endpointId };
  }

  it("returns null when the batch cursor was never established, even though the mailbox READS FINE", async () => {
    // This is the case a whole-flow test cannot reach: the mailbox is perfectly
    // readable here, so only the unknown-cursor refusal can produce null. Without
    // it, `polled >= 0` would satisfy a fabricated cursor of zero.
    const { root, codexEndpointId } = await project();
    const paths = await resolveBusPaths(root);
    expect(
      await readPolledSeqFor({ root, paths, endpointId: codexEndpointId, batchCursorKnown: false }),
    ).toBeNull();
    expect(
      await readPolledSeqFor({ root, paths, endpointId: codexEndpointId, batchCursorKnown: true }),
    ).toBe(0);
  });

  it("re-reads the endpoint from disk instead of trusting a stale snapshot", async () => {
    const { root, codexEndpointId } = await project();
    const paths = await resolveBusPaths(root);
    // Simulate the peer polling AFTER any snapshot the caller might hold.
    await updateEndpoint(root, codexEndpointId, (current) => ({
      ...current,
      lastPolledMailboxSeq: 7,
    }));
    expect(
      await readPolledSeqFor({ root, paths, endpointId: codexEndpointId, batchCursorKnown: true }),
    ).toBe(7);
  });

  it("returns null for an endpoint that no longer exists", async () => {
    const { root } = await project();
    const paths = await resolveBusPaths(root);
    expect(
      await readPolledSeqFor({
        root,
        paths,
        endpointId: "00000000-0000-4000-8000-000000000000",
        batchCursorKnown: true,
      }),
    ).toBeNull();
  });
});
