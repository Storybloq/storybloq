import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeBusMessage,
  busDoctor,
  busSummary,
  checkBusShip,
  foldBusThread,
  joinEndpoint,
  pollBus,
  redeliverBusMessage,
  sendBusMessage,
  setBusHookPolicy,
  updateBusThread,
  type BusEndpoint,
} from "../../src/bus/index.js";
import * as fold from "../../src/bus/fold.js";
import * as io from "../../src/bus/io.js";
import * as endpointsModule from "../../src/bus/endpoints.js";
import { BusError } from "../../src/bus/errors.js";
import { canonicalHash, hashWithoutKey } from "../../src/bus/canonical.js";
import { idempotencyKeyHash } from "../../src/bus/security.js";
import { openDirNoFollow, validatedRedeliverMarkerDir } from "../../src/bus/paths.js";
import * as pathsModule from "../../src/bus/paths.js";
import { resolveInitializedBusPaths } from "../../src/bus/admin.js";
import { writeRefusedArtifact, readRefusedArtifact } from "../../src/bus/refused.js";
import * as refused from "../../src/bus/refused.js";
import { writeReceipt } from "../../src/bus/idempotency.js";
import { BusStatePayloadSchema, BusThreadRecordSchema, type BusMessagePayload } from "../../src/bus/schemas.js";
import { createBusFixture, createIssue, resolveIssue, type BusFixture } from "./helpers.js";

const fixtures: BusFixture[] = [];
const exec = promisify(execFile);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fixture(): Promise<BusFixture> {
  const value = await createBusFixture();
  fixtures.push(value);
  return value;
}

function reviewSend(value: BusFixture, overrides: Record<string, unknown> = {}) {
  return sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    toRole: "implementer",
    messageKind: "question",
    severity: "medium",
    body: "Can you verify the recovery boundary?",
    refs: { ciRun: "ci-fixture-1" },
    idempotencyKey: "review-question-1",
    ...overrides,
  });
}

describe("Storybloq Bus store", () => {
  it("sends, polls, acknowledges, and preserves task ownership", async () => {
    const value = await fixture();
    const sent = await reviewSend(value);
    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });

    expect(polled.messages).toHaveLength(1);
    expect(polled.messages[0]).toMatchObject({
      source: "storybloq_bus",
      authority: "peer_agent",
      integrity: "verified",
      sender: { role: null, client: "claude" },
      message: { messageId: sent.messageId, body: "Can you verify the recovery boundary?" },
    });
    await expect(pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: "foreign-task",
    })).rejects.toMatchObject({ code: "unauthorized" });

    await acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    expect((await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    })).messages).toHaveLength(0);
  });

  it("computes an ordinary send's payloadHash without the two genuinely new hop_cap_successor fields, keeping the pre-ISS-953 hash shape (ISS-953 fix step 7, backward compatibility)", async () => {
    // normalizeSend added predecessorRelation/refusedEntryHash to the object
    // canonicalHash is computed over. canonicalize (JCS) serializes an explicit
    // `null` property, it does not omit it -- so a draft that always included
    // these two keys, defaulting to null for ordinary sends, silently widened
    // the canonical JSON (and therefore the hash) for EVERY ordinary send, not
    // only hop_cap_successor ones. That would turn a legitimate retry against a
    // receipt written before this wave into a false idempotency_conflict. The
    // fix spreads these two keys in only when actually present.
    //
    // predecessorThreadId is deliberately NOT in that set: verified against
    // HEAD (git show HEAD:storybloq/src/bus/store.ts), it already existed as an
    // always-present `input.predecessorThreadId ?? null` in the hash shape
    // before ISS-953 touched this function at all -- it is reply/redelivery
    // plumbing from an earlier wave (succession redelivery), not new here. An
    // earlier draft of this fix incorrectly made it conditional too, which
    // would have been its OWN backward-compat break in the opposite direction
    // (changing the hash for every pre-existing predecessor-linked send).
    // This test proves an ordinary send's stored payloadHash matches an
    // independently computed hash of the pre-wave shape: predecessorThreadId
    // present as null, predecessorRelation/refusedEntryHash absent entirely.
    const value = await fixture();
    const sent = await reviewSend(value, { idempotencyKey: "s7-payloadhash-shape" });
    const folded = await foldBusThread(value.root, sent.threadId);
    const entry = folded.entries[0]!;
    expect(entry.type).toBe("message");
    const message = (entry as { type: "message"; payload: Record<string, unknown> }).payload;

    const expectedPreWaveHash = canonicalHash({
      fromEndpoint: (message.from as { endpointId: string }).endpointId,
      toEndpoint: message.to,
      kind: message.kind,
      severity: message.severity,
      body: message.body,
      refs: message.refs,
      inReplyTo: message.inReplyTo,
      threadKind: "question",
      targetThreadId: null,
      predecessorThreadId: null,
    });
    expect(message.payloadHash).toBe(expectedPreWaveHash);
  });

  it("accepts an ordinary send whose caller-chosen idempotencyKey happens to start with \"bus-redeliver:\", and replays it normally on retry (ISS-953 fix step 12, backward compatibility)", async () => {
    // An earlier draft of this fix rejected any ordinary (non-redeliver) send
    // whose idempotencyKey started with "bus-redeliver:" outright, reasoning
    // that the prefix is redeliverIdempotencyKey's own reserved namespace.
    // Nothing reserved that literal string before this wave, though, so the
    // rejection broke retries for any pre-existing send that had legitimately
    // chosen it as an ordinary idempotencyKey. There is no reservation: an
    // ordinary send may use this prefix freely, and a retry with the identical
    // key/payload replays exactly like any other idempotencyKey would.
    const value = await fixture();
    const key = "bus-redeliver:" + "0".repeat(64);
    const first = await reviewSend(value, { idempotencyKey: key });
    const replay = await reviewSend(value, { idempotencyKey: key });
    expect(replay).toMatchObject({ replayed: true, threadId: first.threadId, messageId: first.messageId });
  });

  it("answers from the verified marker rather than a false idempotency_conflict when an unrelated ordinary receipt occupies the derived redeliver key (ISS-953 fix step 12, security)", async () => {
    // redeliverIdempotencyKey derives "bus-redeliver:<refusedEntryHash>" from the
    // refusedEntryHash alone, with no reservation preventing an ordinary send
    // from choosing that same literal string as its own idempotencyKey (see the
    // backward-compatibility test above). If it does, the resulting ordinary
    // receipt sits at the EXACT (endpointId, keyHash) pair the marker-hit
    // branch's ownReceipt lookup consults -- an unrelated collision, not
    // evidence of a genuine prior redelivery. Naively treating receipt
    // PRESENCE as proof of "this caller already holds their own redelivery
    // receipt" would defer to sendBusMessage's own replay, which compares the
    // redelivery's payloadHash against the unrelated receipt's and reports a
    // spurious idempotency_conflict instead of ever answering from the marker.
    //
    // ISS-953 Codex round 5 finding #12: NARROWED. THIS test's own colliding
    // receipt names a DIFFERENT thread than marker.successorThreadId (an
    // unrelated ordinary send that created its own new thread), so it only
    // exercises rejection of a different-thread collision via the threadId
    // check. It does NOT prove threadId matching marker.successorThreadId is
    // sufficient on its own -- an ordinary message landing directly ON the
    // successor thread would ALSO produce a receipt whose threadId matches,
    // even though it is not the redelivery's own receipt. Production code
    // (store.ts's ownReceipt check) accordingly requires state === "final"
    // AND threadId === marker.successorThreadId AND messageId ===
    // verifiedState.message.messageId together, never threadId alone. The
    // same-thread/different-message collision this narrower claim leaves
    // untested here IS covered, by the sibling test below: "answers from the
    // verified marker rather than a false idempotency_conflict when the
    // caller's own receipt at the derived redeliver key names the SAME
    // successor thread but a DIFFERENT message" (ISS-953 Codex round 3
    // finding #13, idempotency/hardening).
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s13-collision");

    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s13-collision";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    // reviewer2 has never redelivered this refusedEntryHash before, so its own
    // receipt slot at the derived key is empty. Plant an unrelated ORDINARY
    // receipt there directly, using the exact same literal idempotencyKey
    // redeliverIdempotencyKey would derive -- an ordinary send is free to
    // choose it (nothing reserves it), and this is legal today per the test
    // above.
    await sendBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Unrelated ordinary send that happens to collide on the derived key.",
      refs: { ciRun: "s13-collision-plant" },
      idempotencyKey: "bus-redeliver:" + parkEntry.entryHash,
    });

    const second = await redeliverBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(second).toMatchObject({
      replaySource: "marker",
      replayed: true,
      threadId: first.threadId,
      messageId: first.messageId,
    });
  });

  it("rejects an ordinary new-thread create carrying a stray refusedEntryHash with neither predecessorRelation nor predecessorThreadId (ISS-953 Codex round 3 finding #8, operation-shape validation)", async () => {
    // This is the scenario finding #8 filed almost verbatim: an ordinary send
    // (here, a brand new thread) carrying a meaningless refusedEntryHash that
    // no dispatch-specific code ever consults, previously incorporated into
    // payloadHash anyway (see the backward-compatibility test above) and
    // otherwise silently ignored. Validate the shape before normalizeSend is
    // ever reached.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { parkEntry } = await parkOverCap(value, issueId, "s8-stray-hash-alone");
    await expect(reviewSend(value, {
      idempotencyKey: "s8-stray-hash-alone-send",
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an ordinary new-thread create carrying a stray predecessorRelation with neither refusedEntryHash nor predecessorThreadId (ISS-953 Codex round 3 finding #8, operation-shape validation)", async () => {
    const value = await fixture();
    await expect(reviewSend(value, {
      idempotencyKey: "s8-stray-relation-alone",
      predecessorRelation: "hop_cap_successor",
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects refusedEntryHash and predecessorThreadId together without predecessorRelation (ISS-953 Codex round 3 finding #8, operation-shape validation)", async () => {
    // Isolates the predecessorRelation clause of the trio check: the other
    // two fields are both genuinely present and valid, so only omitting
    // predecessorRelation should trip this rejection.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s8-missing-relation");
    await expect(reviewSend(value, {
      idempotencyKey: "s8-missing-relation-send",
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects predecessorRelation and predecessorThreadId together without refusedEntryHash (ISS-953 Codex round 3 finding #8, operation-shape validation)", async () => {
    // Isolates the refusedEntryHash clause of the trio check.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId } = await parkOverCap(value, issueId, "s8-missing-hash");
    await expect(reviewSend(value, {
      idempotencyKey: "s8-missing-hash-send",
      predecessorThreadId: threadId,
      predecessorRelation: "hop_cap_successor",
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects predecessorRelation and refusedEntryHash together without predecessorThreadId (ISS-953 Codex round 3 finding #8, operation-shape validation)", async () => {
    // Isolates the predecessorThreadId clause of the trio check.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { parkEntry } = await parkOverCap(value, issueId, "s8-missing-predecessor-thread");
    await expect(reviewSend(value, {
      idempotencyKey: "s8-missing-predecessor-thread-send",
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a reply declaring the complete hop_cap_successor trio via the pre-existing threadId/predecessorThreadId guard, not a redundant new one (ISS-953 Codex round 3 finding #8, operation-shape validation)", async () => {
    // Codex's suggestion asked to "reject the trio when threadId is present."
    // That combination is already unreachable past finding #8's new check:
    // the trio requires predecessorThreadId, and the pre-existing guard just
    // above ("Replies cannot set threadKind or predecessorThreadId") already
    // rejects threadId combined with predecessorThreadId. Adding a second,
    // dedicated throw for the same combination would be dead code. This test
    // pins that the rejection still happens, and specifically via the
    // PRE-EXISTING message, proving no separate throw was needed.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const existing = await reviewSend(value, { idempotencyKey: "s8-reply-target" });
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s8-reply-trio");
    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: existing.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "A reply cannot also declare a hop_cap_successor redelivery.",
      idempotencyKey: "s8-reply-trio-send",
      predecessorRelation: "hop_cap_successor",
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("Replies cannot set threadKind or predecessorThreadId"),
    });
  });

  it("makes send retries idempotent and rejects changed payloads", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const replay = await reviewSend(value);
    expect(replay).toMatchObject({ replayed: true, threadId: first.threadId, messageId: first.messageId });
    await expect(reviewSend(value, { body: "Changed payload" })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });

  it("scopes identical idempotency keys to the sending endpoint", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const reply = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "The endpoint-scoped key remains independent.",
      refs: { ciRun: "ci-endpoint-scope" },
      inReplyTo: first.messageId,
      idempotencyKey: "review-question-1",
    });

    expect(reply).toMatchObject({ replayed: false, threadId: first.threadId });
    expect(reply.messageId).not.toBe(first.messageId);
  });

  it("serializes concurrent writers into one contiguous hash chain", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    await Promise.all([
      sendBusMessage(value.root, {
        endpointId: value.implementer.endpointId,
        clientTaskId: value.implementerTaskId,
        threadId: first.threadId,
        toRole: "reviewer",
        messageKind: "reply",
        severity: "medium",
        body: "The first concurrent boundary is verified.",
        refs: { ciRun: "ci-concurrent-2" },
        inReplyTo: first.messageId,
        idempotencyKey: "concurrent-implementer-reply",
      }),
      sendBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        threadId: first.threadId,
        toRole: "implementer",
        messageKind: "question",
        severity: "medium",
        body: "Can you also verify the second concurrent boundary?",
        refs: { ciRun: "ci-concurrent-3" },
        inReplyTo: first.messageId,
        idempotencyKey: "concurrent-reviewer-question",
      }),
    ]);

    const folded = await foldBusThread(value.root, first.threadId);
    expect(folded).toMatchObject({ integrity: "verified", validThroughSeq: 3, hopCount: 3 });
    expect(folded.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("recovers a pending pointer and reconstructs a deleted pointer", async () => {
    const value = await fixture();
    await reviewSend(value);
    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    const pointer = (await readdir(mailbox)).find((name) => /^\d{12}-.*\.json$/.test(name));
    if (!pointer) throw new Error("pointer not found");
    await rename(join(mailbox, pointer), join(mailbox, "pending", pointer));

    expect((await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    })).messages).toHaveLength(1);
    expect((await readdir(join(mailbox, "pending"))).filter((name) => name.endsWith(".json"))).toHaveLength(0);

    await unlink(join(mailbox, pointer));
    const rebuilt = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(rebuilt.messages).toHaveLength(1);
    expect((await readdir(mailbox)).filter((name) => /^\d{12}-.*\.json$/.test(name))).toHaveLength(1);
  });

  it("clears an orphan pending intent without serving it", async () => {
    const value = await fixture();
    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    const messageId = randomUUID();
    const pointer = {
      schema: "storybloq-bus-mailbox/v2",
      endpointId: value.implementer.endpointId,
      mailboxSeq: 1,
      messageId,
      threadId: randomUUID(),
      entrySeq: 1,
      entryHash: "a".repeat(64),
      createdAt: new Date().toISOString(),
    };
    const filename = `000000000001-${messageId}.json`;
    await writeFile(join(mailbox, "pending", filename), JSON.stringify(pointer), "utf-8");

    const result = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(result.messages).toHaveLength(0);
    expect(await readdir(join(mailbox, "pending"))).toHaveLength(0);
  });

  it("recovers a deleted mailbox counter without reusing a sequence", async () => {
    const value = await fixture();
    await reviewSend(value);
    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    await unlink(join(mailbox, "counter.json"));
    await reviewSend(value, {
      body: "Can you verify the second recovery boundary?",
      refs: { ciRun: "ci-fixture-2" },
      idempotencyKey: "review-question-2",
    });
    const sequences = (await readdir(mailbox))
      .map((filename) => /^(\d{12})-/.exec(filename)?.[1])
      .filter((value): value is string => value !== undefined)
      .sort();
    expect(sequences).toEqual(["000000000001", "000000000002"]);
  });

  it("quarantines a modified immutable entry and does not serve its payload", async () => {
    const value = await fixture();
    const sent = await reviewSend(value);
    const entriesDir = join(value.root, ".story", "bus", "threads", sent.threadId, "entries");
    const filename = (await readdir(entriesDir))[0]!;
    const path = join(entriesDir, filename);
    const entry = JSON.parse(await readFile(path, "utf-8"));
    entry.payload.body = "tampered";
    await writeFile(path, JSON.stringify(entry, null, 2) + "\n", "utf-8");

    const folded = await foldBusThread(value.root, sent.threadId);
    expect(folded).toMatchObject({ integrity: "quarantined", validThroughSeq: 0 });
    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(polled.messages).toHaveLength(0);
    expect(polled.findings.join("\n")).toMatch(/valid thread prefix|integrity chain/);
  });

  it("serves only the valid prefix when a middle entry is modified", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "The valid-prefix boundary is verified.",
      refs: { ciRun: "ci-prefix-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "prefix-reply-2",
    });
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "This corrupt suffix must not be served.",
      refs: { ciRun: "ci-prefix-3" },
      inReplyTo: second.messageId,
      idempotencyKey: "prefix-reply-3",
    });
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const secondPath = join(entriesDir, (await readdir(entriesDir)).sort()[1]!);
    const entry = JSON.parse(await readFile(secondPath, "utf-8"));
    entry.payload.body = "modified middle entry";
    await writeFile(secondPath, JSON.stringify(entry, null, 2) + "\n", "utf-8");

    const folded = await foldBusThread(value.root, first.threadId);
    expect(folded).toMatchObject({ integrity: "quarantined", validThroughSeq: 1 });
    const polled = await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(polled.messages.map((message) => message.message.body))
      .toEqual(["Can you verify the recovery boundary?"]);
    expect(polled.findings.join("\n")).toContain("valid thread prefix");
  });

  it("rebuilds corrupt derived state and removes a restored post-ack pointer", async () => {
    const value = await fixture();
    const sent = await reviewSend(value);
    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    const pointerName = (await readdir(mailbox)).find((name) => /^\d{12}-.*\.json$/.test(name));
    if (!pointerName) throw new Error("pointer not found");
    const pointerBody = await readFile(join(mailbox, pointerName), "utf-8");
    const derived = join(value.root, ".story", "bus", "threads", sent.threadId, "derived.json");
    await writeFile(derived, "not-json", "utf-8");

    await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    });
    expect(JSON.parse(await readFile(derived, "utf-8"))).toMatchObject({
      schema: "storybloq-bus-derived/v1",
      threadId: sent.threadId,
      lastSeq: 1,
      integrity: "verified",
    });

    await acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    await writeFile(join(mailbox, pointerName), pointerBody, "utf-8");
    expect((await pollBus(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
    })).messages).toHaveLength(0);
    expect((await readdir(mailbox)).filter((name) => /^\d{12}-.*\.json$/.test(name))).toHaveLength(0);
  });

  it("rejects critical messages without a canonical unresolved critical issue", async () => {
    const value = await fixture();
    await expect(reviewSend(value, {
      severity: "critical",
      idempotencyKey: "critical-without-issue",
    })).rejects.toMatchObject({ code: "invalid_input" });

    const issueId = await createIssue(value.root, "critical");
    const sent = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      toRole: "implementer",
      messageKind: "issue_notice",
      severity: "critical",
      body: "The release boundary can lose acknowledged data.",
      refs: { issue: issueId },
      idempotencyKey: "critical-issue-1",
    });
    expect((await checkBusShip(value.root)).blockers.join("\n")).toMatch(/unacknowledged critical/);

    await acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    expect((await checkBusShip(value.root)).clear).toBe(true);
    await resolveIssue(value.root, issueId);
  });

  it("gates critical questions and parked critical threads, not only issue notices", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      messageKind: "question",
      severity: "critical",
      body: "Can the release boundary lose critical state?",
      refs: { issue: issueId },
      idempotencyKey: "critical-question-1",
    });
    expect((await checkBusShip(value.root)).clear).toBe(false);
    await acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "accepted",
    });
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: sent.threadId,
      action: "park",
      reason: "Waiting for critical release evidence",
    });
    expect((await checkBusShip(value.root)).blockers.join("\n"))
      .toMatch(/parked Bus thread with unresolved critical issue/);
  });

  it("clears the ship gate when an unacked critical thread is resolved, but not while it stays open", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const sent = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "critical",
      body: "Can the release boundary lose critical state?",
      refs: { issue: issueId },
      idempotencyKey: "shipgate-critical-1",
    });
    // Control: an unresolved, unacked critical thread blocks the ship gate.
    expect((await checkBusShip(value.root)).blockers.join("\n")).toMatch(/unacknowledged critical/);

    // Resolving the thread with evidence supersedes the per-message ack and clears
    // the unacked-critical blocker (Fix A) even though the message was never acked.
    // A question-kind thread does not require its canonical issue resolved first, so
    // this isolates the resolve-clears-the-gate behavior from issue resolution.
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: sent.threadId,
      action: "resolve",
      resolution: "Superseded by an evidenced resolution",
      evidence: { ciRun: "ci-shipgate-resolved" },
    });
    expect(await checkBusShip(value.root)).toEqual({ clear: true, blockers: [] });

    // Control 2: a second unresolved unacked-critical thread stays blocked, proving
    // resolve clears the gate per-thread rather than disabling the critical check.
    const issueTwo = await createIssue(value.root, "critical");
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "critical",
      body: "A second critical question",
      refs: { issue: issueTwo },
      idempotencyKey: "shipgate-critical-2",
    });
    expect((await checkBusShip(value.root)).clear).toBe(false);
  });

  it("blocks ship on a critical duplicate-fingerprint refusal, and clears once the thread is resolved directly from parked (ISS-953 fix step 9)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const first = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "critical",
      body: "Can the release boundary lose critical state?",
      refs: { issue: issueId },
      idempotencyKey: "shipgate-refusal-critical-1",
    });
    // duplicate_fingerprint can NEVER receive a hop_cap_successor redeliver marker
    // (that relation is scoped to hop_cap-triggered issue_notice parks only), so
    // this refusal has no path to "redelivered" -- it can only ever clear via the
    // second, thread-resolution escape hatch fix step 9 adds.
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "critical",
      body: "Can the release boundary lose critical state?",
      refs: { issue: issueId },
      idempotencyKey: "shipgate-refusal-critical-2",
    });
    expect(parked).toMatchObject({ parked: true });

    const blocked = await checkBusShip(value.root);
    expect(blocked.clear).toBe(false);
    expect(blocked.blockers.join("\n")).toMatch(/unresolved critical Bus refusal/);

    // Resolve directly from "parked" (never reopened) -- the same evidenced-
    // resolution-supersedes escape hatch updateBusThread's `resolve` action already
    // permits for the pre-existing unacked-critical/parked-critical blockers above.
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "resolve",
      resolution: "Superseded by an evidenced resolution",
      evidence: { ciRun: "ci-shipgate-refusal-resolved" },
    });
    expect(await checkBusShip(value.root)).toEqual({ clear: true, blockers: [] });
  });

  it("blocks ship unconditionally when a refusal's artifact is missing, regardless of severity (ISS-953 fix step 9)", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "shipgate-refusal-missing-artifact",
    });
    expect(parked).toMatchObject({ parked: true });
    const folded = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(folded.refusals[0]!.droppedMessage.severity).toBe("medium");
    const artifactPath = join(
      value.root, ".story", "bus", "refused", `${folded.refusals[0]!.droppedMessage.refusedPayloadHash}.json`,
    );
    await unlink(artifactPath);

    const blocked = await checkBusShip(value.root);
    expect(blocked.clear).toBe(false);
    expect(blocked.blockers.join("\n")).toMatch(/refused message artifact is missing/);
  });

  it("blocks ship unconditionally when a refusal's artifact is corrupt, distinct from missing (ISS-953 Codex round 2 finding #21, test coverage)", async () => {
    // The sibling test above isolates only the `missing` artifact status --
    // a regression that blocked missing artifacts but accidentally permitted
    // corrupt ones would still pass it. "reports a corrupt refused artifact
    // as a doctor finding..." (fix step 10) proves busDoctor's OWN corrupt
    // handling, a different caller through a different code path; it does
    // not exercise checkBusShip's unconditional corruption blocker at all.
    // Tampers the artifact's content while preserving its filename (the
    // same technique the doctor test uses) so the artifact still resolves
    // by hash lookup but fails its own content-hash check.
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "shipgate-refusal-corrupt-artifact",
    });
    expect(parked).toMatchObject({ parked: true });
    const folded = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(folded.refusals[0]!.droppedMessage.severity).toBe("medium");
    const artifactHash = folded.refusals[0]!.droppedMessage.refusedPayloadHash;
    const artifactPath = join(value.root, ".story", "bus", "refused", `${artifactHash}.json`);
    await writeFile(artifactPath, JSON.stringify({
      schema: "storybloq-bus-refused-artifact/v1",
      messageKind: "question",
      severity: "medium",
      body: "tampered content, no longer matching the filename hash",
      refs: {},
    }, null, 2) + "\n", "utf-8");

    const blocked = await checkBusShip(value.root);
    expect(blocked.clear).toBe(false);
    expect(blocked.blockers.join("\n")).toMatch(/refused message artifact is corrupt/);
    expect(blocked.blockers.join("\n")).not.toMatch(/artifact is missing/);
  });

  it("rejects high-confidence secrets in bodies, refs, and state text", async () => {
    const value = await fixture();
    await expect(reviewSend(value, {
      body: "token sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      idempotencyKey: "secret-body",
    })).rejects.toMatchObject({ code: "secret_detected" });
    await expect(reviewSend(value, {
      refs: { ciRun: "https://user:password@example.com/run" },
      idempotencyKey: "secret-ref",
    })).rejects.toMatchObject({ code: "secret_detected" });
    await expect(reviewSend(value, {
      refs: { ciRun: "ci-safe", files: ["../secret"] },
      idempotencyKey: "traversal-ref",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reviewSend(value, {
      refs: { ciRun: "ci-safe", files: ["src/unsafe\nname.ts"] },
      idempotencyKey: "control-ref",
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reviewSend(value, {
      body: "x".repeat(16 * 1024 + 1),
      idempotencyKey: "oversized-body",
    })).rejects.toMatchObject({ code: "invalid_input" });

    const sent = await reviewSend(value, {
      body: "Can state text carry credentials?",
      refs: { ciRun: "ci-state-secret" },
      idempotencyKey: "state-secret-thread",
    });
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: sent.threadId,
      action: "park",
      reason: "token sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    })).rejects.toMatchObject({ code: "secret_detected" });
    await expect(acknowledgeBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      messageId: sent.messageId!,
      disposition: "deferred",
      reason: "unsafe\u000bcontrol",
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a symlinked protocol directory", async () => {
    const value = await fixture();
    const threads = join(value.root, ".story", "bus", "threads");
    const target = join(value.root, ".story", "bus-symlink-target");
    await rm(threads, { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(target, threads, "dir");

    await expect(reviewSend(value)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reports clean health after ordinary traffic and persists hook policy locally", async () => {
    const value = await fixture();
    await reviewSend(value);
    const policy = await setBusHookPolicy(value.root, ["codex"], true);
    expect(policy).toMatchObject({ claude: false, codex: true });
    expect((await busDoctor(value.root)).healthy).toBe(true);
  });

  it("reports an abandoned lock recovery guard without removing it", async () => {
    const value = await fixture();
    const guard = join(value.root, ".story", "bus", "locks", "thread-dead.lock.reap");
    await writeFile(guard, JSON.stringify({ owner: "unknown" }), "utf-8");

    const doctor = await busDoctor(value.root);

    expect(doctor.healthy).toBe(false);
    expect(doctor.findings).toContain(
      "lock recovery guard requires explicit owner inspection: thread-dead.lock.reap",
    );
    expect(await readFile(guard, "utf-8")).toContain("unknown");
  });

  it("reports a missing protocol directory without recreating it", async () => {
    const value = await fixture();
    const pending = join(value.root, ".story", "bus", "mailboxes", value.reviewer.endpointId, "pending");
    await rm(pending, { recursive: true });

    const doctor = await busDoctor(value.root);

    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toContain(pending);
    await expect(checkBusShip(value.root)).rejects.toMatchObject({ code: "corrupt" });
    await expect(readdir(pending)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports markerState 'pending' as an untrusted-successor doctor finding, never 'invalid'/'corrupt', for a marker written before its successor lands (ISS-953 fix step 10; wording updated under the ISS-1002 interim remedy, round 5 finding #10)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    // ISS-953 Codex round 2 findings #19/#22: a duplicate_fingerprint park can
    // never be redelivered at all (verifiedSuccessorState now rejects it
    // structurally, before ever looking at the successor), so a pending-marker
    // fixture must be built on a genuinely hop-cap-eligible refusal -- the
    // original two-identical-question fixture here was itself a
    // duplicate_fingerprint park and could never have exercised the pending
    // (crash-window) path this test is named for.
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "doctor-pending");
    const unlandedSuccessorId = randomUUID();

    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: threadId,
        predecessorEntryHash: parkEntry.entryHash,
        originalByEndpoint: value.reviewer.endpointId,
        successorThreadId: unlandedSuccessorId,
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    const pendingFindings = doctor.findings.filter((finding) => finding.includes(parkEntry.entryHash));
    expect(pendingFindings).toHaveLength(1);
    expect(pendingFindings[0]).toMatch(/redelivery pending.*not trusted.*storybloq_bus_redeliver.*retry/);
    expect(pendingFindings[0]).not.toMatch(/invalid|corrupt/);
  });

  it("reports a distinctly-worded 'invalid' finding for a redeliver marker whose bindings mismatch its park entry (ISS-953 fix step 10; rebuilt on parkOverCap, ISS-953 Codex round 5 finding #13)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    // ISS-953 Codex round 5 finding #13: the original version of this test
    // built its refusal from two reviewSend calls carrying the SAME body and
    // refs, which is a duplicate_fingerprint park, not hop_cap.
    // verifiedSuccessorState's very first check (`if (trigger !== "hop_cap")
    // return { status: "invalid" }`) rejects a duplicate_fingerprint marker
    // unconditionally, before `bound` is ever evaluated -- so the old test
    // passed regardless of whether the predecessorEntryHash mismatch this
    // test names in its own title was checked at all. parkOverCap produces a
    // genuine hop_cap park, so the forged predecessorEntryHash below is the
    // ONLY thing that can make this marker fail.
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s10-invalid-binding");

    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: threadId,
        // Wrong on purpose: does not match parkEntry.entryHash.
        predecessorEntryHash: "0".repeat(64),
        originalByEndpoint: value.reviewer.endpointId,
        successorThreadId: randomUUID(),
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    const invalidFindings = doctor.findings.filter((finding) => finding.includes(parkEntry.entryHash));
    expect(invalidFindings).toHaveLength(1);
    // ISS-953 Codex round 5 finding #11: message reworded classification-neutral
    // (it no longer implies "schema failure or binding mismatch" are the only
    // two causes), so this no longer matches the literal word "invalid" --
    // asserting the distinct wording and its absence from the "pending" case
    // is still exactly what this test is named for.
    expect(invalidFindings[0]).toMatch(/redeliver marker.*failed integrity\/binding verification/);
    expect(invalidFindings[0]).not.toMatch(/pending/);
  });

  it("reports a missing refused artifact as a doctor finding, distinct from a corrupt one (ISS-953 fix step 10)", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "doctor-refusals-missing-artifact",
    });
    const folded = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    const artifactHash = folded.refusals[0]!.droppedMessage.refusedPayloadHash;
    const artifactPath = join(value.root, ".story", "bus", "refused", `${artifactHash}.json`);
    await unlink(artifactPath);

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toMatch(/refused message artifact is missing/);
    expect(doctor.findings.join("\n")).not.toMatch(/artifact is corrupt/);
  });

  it("reports a corrupt refused artifact as a doctor finding when its content no longer matches its own hash (ISS-953 fix step 10)", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "doctor-refusals-corrupt-artifact",
    });
    const folded = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    const artifactHash = folded.refusals[0]!.droppedMessage.refusedPayloadHash;
    const artifactPath = join(value.root, ".story", "bus", "refused", `${artifactHash}.json`);
    await writeFile(artifactPath, JSON.stringify({
      schema: "storybloq-bus-refused-artifact/v1",
      messageKind: "question",
      severity: "medium",
      body: "tampered content, no longer matching the filename hash",
      refs: {},
    }, null, 2) + "\n", "utf-8");

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toMatch(/refused message artifact is corrupt/);
    expect(doctor.findings.join("\n")).not.toMatch(/artifact is missing/);
  });

  it("reports an orphan refused artifact that no live thread's park entry references (ISS-953 fix step 10)", async () => {
    const value = await fixture();
    await reviewSend(value);
    const refusedDir = join(value.root, ".story", "bus", "refused");
    await mkdir(refusedDir, { recursive: true });
    const orphanHash = "a".repeat(64);
    await writeFile(join(refusedDir, `${orphanHash}.json`), JSON.stringify({
      schema: "storybloq-bus-refused-artifact/v1",
      messageKind: "question",
      severity: "low",
      body: "never referenced by any park entry",
      refs: {},
    }, null, 2) + "\n", "utf-8");

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.join("\n")).toContain(`orphan artifact ${orphanHash}`);
  });

  it("reports a non-regular refused directory entry (symlink or nested directory) as a finding, distinct from a malformed filename and never followed (ISS-953 Codex round 2 finding #15, security)", async () => {
    // The malformed-filename branch just below (a regular file whose name
    // does not match <hash>.json) was already reported; a non-regular entry
    // hit an early `continue` with NO finding at all, so a symlink or nested
    // directory NAMED like a valid artifact was invisible to doctor.
    const value = await fixture();
    await reviewSend(value);
    const refusedDir = join(value.root, ".story", "bus", "refused");
    await mkdir(refusedDir, { recursive: true });

    const symlinkHash = "b".repeat(64);
    const symlinkTarget = join(value.root, "escape-target.json");
    await writeFile(symlinkTarget, JSON.stringify({ not: "a real artifact" }, null, 2) + "\n", "utf-8");
    await symlink(symlinkTarget, join(refusedDir, `${symlinkHash}.json`));

    const dirHash = "c".repeat(64);
    await mkdir(join(refusedDir, `${dirHash}.json`));

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    const findings = doctor.findings.join("\n");
    expect(findings).toContain(`${symlinkHash}.json is not a regular <hash>.json artifact`);
    expect(findings).toContain(`${dirHash}.json is not a regular <hash>.json artifact`);
    // Never followed: readdir's withFileTypes dirent classifies the symlink
    // without ever resolving it, so its target content is never read,
    // parsed, or hash-verified as if it were the artifact -- neither of
    // these two must ever surface as "orphan" (that classification requires
    // successfully matching the <hash>.json pattern first) or "corrupt"
    // (that requires successfully reading and parsing artifact content).
    expect(findings).not.toContain("orphan artifact");
    expect(findings).not.toContain("artifact is corrupt");
  });

  it("rejects a refused-directory swap landing after resolveBusPaths's own one-time symlink check but before doctor's orphan scan reads it, and never enumerates the escape target (ISS-953 Codex round 6 MAJOR #8, security)", async () => {
    // The test above (round 2 finding #15) covers a symlink NAMED like an
    // artifact INSIDE refused. This covers refused ITSELF, and specifically
    // the gap the finding named: resolveBusPaths (via classifyBusRuntime, at
    // the very top of busDoctor) already rejects a symlink that is present
    // BEFORE the call starts -- that much a bare pre-existing symlink alone
    // cannot exercise, since it is caught before the orphan scan is ever
    // reached. The bug was that the scan then read paths.refused directly,
    // long after that one-time check, with no revalidation of its own -- a
    // swap landing strictly AFTER resolveBusPaths's check but before the
    // scan's own read was previously followed. Route the swap through the
    // orphan scan's own call to validatedRefusedDir so it lands in exactly
    // that gap, mirroring the durableWrite-interleaving tests above.
    const value = await fixture();
    await reviewSend(value);
    const refusedDir = join(value.root, ".story", "bus", "refused");

    const escapeDir = join(value.root, "escape-outside-bus-root");
    await mkdir(escapeDir, { recursive: true, mode: 0o700 });
    const escapeFileName = "definitely-not-a-refused-artifact.txt";
    await writeFile(join(escapeDir, escapeFileName), "secret content outside the bus root", "utf-8");
    const realRoot = await realpath(value.root);
    const realEscapeDir = await realpath(escapeDir);
    if (!realEscapeDir.startsWith(realRoot)) {
      throw new Error("SAFETY ABORT: escape target resolved outside the fixture tmpdir");
    }

    const realValidatedRefusedDir = refused.validatedRefusedDir;
    const spy = vi.spyOn(refused, "validatedRefusedDir").mockImplementationOnce(async (paths, opts) => {
      // THE SWAP: lands strictly between resolveBusPaths's own already-passed
      // check at the top of busDoctor and the orphan scan's own use of the
      // refused directory a call later -- this fixture has no refusal, so
      // this is the orphan scan's only call to validatedRefusedDir.
      await rm(refusedDir, { recursive: true, force: true });
      await symlink(escapeDir, refusedDir);
      return realValidatedRefusedDir(paths, opts);
    });

    let doctor: Awaited<ReturnType<typeof busDoctor>>;
    try {
      doctor = await busDoctor(value.root);
    } finally {
      spy.mockRestore();
    }

    expect(doctor.healthy).toBe(false);
    const findings = doctor.findings.join("\n");
    expect(findings).toMatch(/refused:.*symlink/i);
    // Never enumerated: if the escape directory's own filename ever surfaced
    // anywhere in doctor's output, the symlink swap was followed instead of
    // caught -- proving validatedRefusedDir's own re-check at this use was
    // bypassed, the exact regression round 6 MAJOR #8 identified.
    expect(findings).not.toContain(escapeFileName);
  });

  it("does not orphan a valid park's own artifact when the SAME thread is later quarantined by unrelated forged content (ISS-953 Codex round 2 finding #16)", async () => {
    // foldBusThread deliberately returns an EMPTY refusals list once a
    // thread is quarantined (fold.ts), even though `entries` still holds
    // every entry successfully parsed before the corruption -- including an
    // earlier, genuinely-landed automatic park. Collecting referenced
    // artifact hashes ONLY from `refusals` therefore loses this reference
    // the moment ANYTHING later on the same thread corrupts it, regardless
    // of how unrelated that corruption is to the park itself.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s16-orphan-quarantine");
    // Fixture-produced-state assertion before exercising behaviour that
    // depends on it (L-055 instance).
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap", automatic: true } });
    const artifactHash = parkEntry.payload.droppedMessage.refusedPayloadHash;

    // Same forged-message-after-park technique as "quarantines a forged
    // message appended after a park transition" above.
    const parkedFold = await foldBusThread(value.root, threadId);
    const entriesDir = join(value.root, ".story", "bus", "threads", threadId, "entries");
    const entryId = randomUUID();
    const unsigned = {
      schema: "storybloq-bus-entry/v2",
      entryId,
      threadId,
      seq: parkedFold.validThroughSeq + 1,
      type: "message",
      prevHash: parkedFold.lastHash,
      createdAt: new Date().toISOString(),
      entryHash: "0".repeat(64),
      payload: {
        ...parkedFold.messages[0]!,
        messageId: randomUUID(),
        body: "Forged message after park",
        idempotencyKeyHash: "a".repeat(64),
        payloadHash: "b".repeat(64),
      },
    };
    const entry = { ...unsigned, entryHash: hashWithoutKey(unsigned, "entryHash") };
    await writeFile(
      join(entriesDir, `${String(parkedFold.validThroughSeq + 1).padStart(6, "0")}-message-${entryId}.json`),
      JSON.stringify(entry, null, 2) + "\n",
      "utf-8",
    );

    // Sanity: the tamper genuinely quarantines the thread (this test is
    // meaningless against a thread doctor would already flag as verified).
    expect((await foldBusThread(value.root, threadId)).integrity).toBe("quarantined");

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    const findings = doctor.findings.join("\n");
    expect(findings).not.toContain(`orphan artifact ${artifactHash}`);
    expect(findings).not.toContain("orphan analysis is incomplete");
  });

  it("suppresses ALL orphan classification, reporting analysis as incomplete instead, when a thread fold fails completely rather than merely quarantining (ISS-953 Codex round 2 finding #16)", async () => {
    // Distinct from the quarantine case above: foldBusThread here THROWS
    // outright (thread.json itself fails schema validation), so there is no
    // partial `entries` to fall back to at all -- doctor cannot know what
    // this thread's park entries, if any, referenced. Any apparent orphan
    // could actually belong to this unreadable thread, so orphan
    // classification must be suppressed wholesale, not just for this
    // thread's own artifact.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s16-orphan-throw");
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap", automatic: true } });
    const artifactHash = parkEntry.payload.droppedMessage.refusedPayloadHash;

    const threadJsonPath = join(value.root, ".story", "bus", "threads", threadId, "thread.json");
    await writeFile(threadJsonPath, JSON.stringify({ schema: "not-a-valid-thread-record" }, null, 2) + "\n", "utf-8");

    await expect(foldBusThread(value.root, threadId)).rejects.toBeDefined();

    const doctor = await busDoctor(value.root);
    expect(doctor.healthy).toBe(false);
    const findings = doctor.findings.join("\n");
    expect(findings).toContain(`thread ${threadId}:`);
    expect(findings).toContain("orphan analysis is incomplete");
    expect(findings).not.toContain(`orphan artifact ${artifactHash}`);
    expect(findings).not.toContain("orphan artifact");
  });

  it("treats an absent per-checkout runtime as inactive and ship-clear", async () => {
    const value = await fixture();
    const busRoot = join(value.root, ".story", "bus");
    await rm(busRoot, { recursive: true });
    // T-428: model a genuinely fresh checkout (no runtime AND no deletion-evidence,
    // as a clone would have). An evidenced runtime that is deleted is `runtime_lost`,
    // not ship-clear -- that N-083 case is covered by deletion-evidence.test.ts.
    await rm(join(value.root, ".story", ".bus-evidence.json"), { force: true });

    await expect(busDoctor(value.root)).resolves.toEqual({
      healthy: true,
      summary: expect.objectContaining({ enabled: true, initialized: false }),
      findings: [],
      notices: [],
    });
    await expect(checkBusShip(value.root)).resolves.toEqual({ clear: true, blockers: [] });
    await expect(busSummary(value.root)).resolves.toMatchObject({
      enabled: true,
      initialized: false,
      endpoints: 0,
      pendingMessages: 0,
    });
    await expect(reviewSend(value)).rejects.toMatchObject({
      code: "not_found",
      message: "Bus is not initialized in this checkout. Run `storybloq bus setup` first.",
    });
    await expect(readdir(busRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns BusError for ambiguous send modes", async () => {
    const value = await fixture();
    await expect(reviewSend(value, { threadKind: undefined })).rejects.toBeInstanceOf(BusError);
  });

  it("parks before writing an actionable hop beyond the configured cap", async () => {
    const value = await fixture();
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    const first = await reviewSend(value);
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "The recovery boundary is verified.",
      refs: { ciRun: "ci-fixture-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "implementation-reply-1",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "Please run one more check.",
      refs: { ciRun: "ci-fixture-3" },
      inReplyTo: second.messageId,
      idempotencyKey: "review-reply-over-cap",
    });
    const folded = await foldBusThread(value.root, first.threadId);

    expect(parked).toMatchObject({ parked: true, messageId: null, hopCount: 2, state: "parked" });
    expect(folded.messages).toHaveLength(2);
    expect(folded.entries.at(-1)).toMatchObject({ type: "state", payload: { trigger: "hop_cap" } });
  });

  // ISS-953 fix step 3: test the CONSEQUENCE the number exists to predict, not
  // just the subtraction. A test asserting hopsRemaining === 1 in isolation
  // proves the formula; only sending one more and observing whether it parks
  // proves the number meant anything to a caller deciding whether to send.
  it("hopsRemaining reaches 0 exactly at the boundary where the next actionable send parks", async () => {
    const value = await fixture();
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    // hopCount 1 of 2 -- one hop below the cap.
    const first = await reviewSend(value);
    expect(first).toMatchObject({ hopCount: 1, hopsRemaining: 1, parked: false });

    // The successful send AT hopCount === maxHops - 1 is the boundary: it lands
    // (this is not itself the over-cap send) and reports hopsRemaining: 0,
    // because a caller reading this result has zero budget for what comes next.
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "At the boundary now.",
      refs: { ciRun: "ci-boundary-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "boundary-second",
    });
    expect(second).toMatchObject({ hopCount: 2, hopsRemaining: 0, parked: false });

    // The CONSEQUENCE: the very next actionable send parks. hopsRemaining: 0 was
    // not a pessimistic guess -- it was exact. The park result itself also
    // reports hopsRemaining: 0, alongside parked: true.
    const third = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "This one should park.",
      refs: { ciRun: "ci-boundary-3" },
      inReplyTo: second.messageId,
      idempotencyKey: "boundary-third",
    });
    expect(third).toMatchObject({ parked: true, messageId: null, hopCount: 2, hopsRemaining: 0 });
  });

  // hopsRemaining deliberately follows the SAME precedent as the pre-existing
  // hopCount/state fields: replayFromFold's own comment documents that those
  // are recomputed LIVE from a fresh fold on replay (only messageId/parked are
  // pinned to what the original operation actually did -- see the comment on
  // replayFromFold). This is not a gap; freezing hopsRemaining to its
  // originally-reported value would be a NEW, asymmetric special case for one
  // field, and would be strictly less safe: hopCount is monotonically
  // non-decreasing, so a live recompute can only ever report a number <= the
  // original (more cautious), never a higher, falsely-reassuring one. Pinned
  // as a regression test rather than left to be rediscovered by a future
  // reader who only checks the comment and not the actual behavior.
  it("replaying an already-final receipt reports hopsRemaining against the CURRENT fold, matching hopCount's existing precedent", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Intervening activity after the first send.",
      refs: { ciRun: "ci-probe-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "probe-second",
    });
    expect(first).toMatchObject({ hopCount: 1, hopsRemaining: 7 });
    expect(second).toMatchObject({ hopCount: 2, hopsRemaining: 6 });

    // Replay the FIRST send's exact idempotency key, now that the thread has
    // moved on. It must not create a duplicate message (messageId matches the
    // original) and must not re-throw as a conflict (payload is identical).
    const replay = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "review-question-1",
    });
    expect(replay.messageId).toBe(first.messageId);
    expect(replay.replayed).toBe(true);
    // The live fold, not the frozen original: hopCount/hopsRemaining reflect
    // the SECOND send's effect too, exactly like the pre-existing hopCount
    // field already does (same fold, same call).
    expect(replay).toMatchObject({ hopCount: 2, hopsRemaining: 6 });
  });

  // Pen ruling on ISS-953: the live-on-replay behavior above is safe ONLY
  // because hopsRemaining cannot increase (maxHops is frozen per-thread at
  // creation, entries are append-only, hopCount is monotonically
  // non-decreasing). That property is the actual load-bearing safety argument
  // and was previously stated only in a Bus message, not checked anywhere
  // executable -- pin it so it stays true after any future change (e.g. a
  // mutable maxHops, or entry compaction) rather than rotting into a stale
  // comment. Checked across a real sequence, including a replay observation.
  it("hopsRemaining is monotonically non-increasing across every observation on a thread, including a replay", async () => {
    const value = await fixture();
    const observations: number[] = [];

    const first = await reviewSend(value);
    observations.push(first.hopsRemaining);

    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Second observation.",
      refs: { ciRun: "ci-monotonic-2" },
      inReplyTo: first.messageId,
      idempotencyKey: "monotonic-second",
    });
    observations.push(second.hopsRemaining);

    const third = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "Third observation.",
      refs: { ciRun: "ci-monotonic-3" },
      inReplyTo: second.messageId,
      idempotencyKey: "monotonic-third",
    });
    observations.push(third.hopsRemaining);

    // Replay the FIRST send after two further hops landed -- the sharpest
    // point to check the invariant, since this is exactly the observation a
    // frozen-value design would have gotten wrong in the other direction.
    const replay = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "review-question-1",
    });
    expect(replay.replayed).toBe(true);
    observations.push(replay.hopsRemaining);

    for (let i = 1; i < observations.length; i++) {
      expect(observations[i]).toBeLessThanOrEqual(observations[i - 1]!);
    }
    expect(observations).toEqual([7, 6, 5, 5]);
  });

  it("parks an exact repeated actionable fingerprint in the same direction", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "duplicate-actionable",
    });
    expect(parked).toMatchObject({ parked: true, messageId: null });
    expect((await foldBusThread(value.root, first.threadId)).entries.at(-1))
      .toMatchObject({ type: "state", payload: { trigger: "duplicate_fingerprint" } });
  });

  it("writes a refused artifact for a hop-cap park, hash-addressed and independently readable (ISS-953 fix step 4)", async () => {
    const value = await fixture();
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    const first = await reviewSend(value);
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Bringing hopCount to the configured cap.",
      refs: { ciRun: "ci-refused-artifact-setup" },
      inReplyTo: first.messageId,
      idempotencyKey: "hop-cap-refused-artifact-setup",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "This reply trips the hop cap and must not be dropped silently.",
      refs: { ciRun: "ci-refused-artifact" },
      inReplyTo: second.messageId,
      idempotencyKey: "hop-cap-refused-artifact",
    });
    expect(parked).toMatchObject({ parked: true, messageId: null });

    const folded = await foldBusThread(value.root, first.threadId);
    const parkEntry = folded.entries.at(-1) as {
      type: string;
      payload: { droppedMessage?: { messageKind: string; severity: string; refusedPayloadHash: string } };
    };
    expect(parkEntry.type).toBe("state");
    const droppedMessage = parkEntry.payload.droppedMessage;
    expect(droppedMessage).toMatchObject({ messageKind: "reply", severity: "medium" });
    expect(droppedMessage!.refusedPayloadHash).toMatch(/^[a-f0-9]{64}$/);

    const artifactPath = join(value.root, ".story", "bus", "refused", `${droppedMessage!.refusedPayloadHash}.json`);
    const artifact = JSON.parse(await readFile(artifactPath, "utf-8"));
    expect(artifact).toMatchObject({
      schema: "storybloq-bus-refused-artifact/v1",
      messageKind: "reply",
      severity: "medium",
      body: "This reply trips the hop cap and must not be dropped silently.",
      refs: { ciRun: "ci-refused-artifact" },
    });
  });

  it("writes a refused artifact for a duplicate-fingerprint park too (ISS-953 fix step 4, both triggers)", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "duplicate-actionable-artifact",
    });
    expect(parked).toMatchObject({ parked: true, messageId: null });

    const folded = await foldBusThread(value.root, first.threadId);
    const parkEntry = folded.entries.at(-1) as {
      type: string;
      payload: { trigger?: string; droppedMessage?: { messageKind: string; severity: string; refusedPayloadHash: string } };
    };
    expect(parkEntry.payload.trigger).toBe("duplicate_fingerprint");
    const droppedMessage = parkEntry.payload.droppedMessage;
    expect(droppedMessage).toMatchObject({ messageKind: "question", severity: "medium" });
    const artifactPath = join(value.root, ".story", "bus", "refused", `${droppedMessage!.refusedPayloadHash}.json`);
    const artifact = JSON.parse(await readFile(artifactPath, "utf-8"));
    expect(artifact).toMatchObject({
      messageKind: "question",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
    });
  });

  it("dedupes a byte-identical dropped message across two separate park events into ONE shared artifact (ISS-953 fix step 4, EEXIST hash-verify path)", async () => {
    // Regression test: writeRefusedArtifact's EEXIST branch was dead code until
    // just now -- it checked (err as NodeJS.ErrnoException).code !== "EEXIST", but
    // durableCreate wraps a real EEXIST as BusError("conflict", ...), which never
    // carries that raw errno code. A second byte-identical drop therefore always
    // re-threw "conflict" instead of hash-verifying and deduping, undetected because
    // no existing test drove two separate park events to the SAME artifact content.
    const value = await fixture();
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    // A park transitions its own thread to "parked" (replyToThread refuses any
    // further send once state !== "open"), so two independent park events with
    // byte-identical dropped content require two SEPARATE threads, each hop-capped
    // down on its own, rather than parking the same thread twice.
    const droppedContent = {
      messageKind: "reply" as const,
      severity: "medium" as const,
      body: "Identical dropped content, twice.",
      refs: { ciRun: "dedupe-dropped" },
    };
    async function hopCapToPark(prefix: string) {
      const created = await reviewSend(value, {
        refs: { ciRun: `${prefix}-first` },
        idempotencyKey: `${prefix}-first`,
      });
      await sendBusMessage(value.root, {
        endpointId: value.implementer.endpointId,
        clientTaskId: value.implementerTaskId,
        threadId: created.threadId,
        toRole: "reviewer",
        messageKind: "reply",
        severity: "medium",
        body: "At cap now.",
        refs: { ciRun: `${prefix}-second` },
        inReplyTo: created.messageId,
        idempotencyKey: `${prefix}-second`,
      });
      const parked = await sendBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        threadId: created.threadId,
        toRole: "implementer",
        idempotencyKey: `${prefix}-park`,
        ...droppedContent,
      });
      return { threadId: created.threadId, parked };
    }

    const first = await hopCapToPark("dedupe-a");
    const second = await hopCapToPark("dedupe-b");
    expect(first.parked.parked).toBe(true);
    expect(second.parked.parked).toBe(true);

    const foldedFirst = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    const foldedSecond = await foldBusThread(value.root, second.threadId, { includeRefusals: true });
    expect(foldedFirst.refusals[0]!.droppedMessage.refusedPayloadHash)
      .toBe(foldedSecond.refusals[0]!.droppedMessage.refusedPayloadHash);
    expect(foldedFirst.refusals[0]!.artifactStatus).toBe("resolved");
    expect(foldedSecond.refusals[0]!.artifactStatus).toBe("resolved");

    const refusedFiles = await readdir(join(value.root, ".story", "bus", "refused"));
    expect(refusedFiles).toHaveLength(1);
  });

  it("does not resolve refusals unless the caller opts in, and reports markerState 'none' with no redeliver attempted (ISS-953 fix step 8)", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "high",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "duplicate-actionable-refusals-none",
    });
    expect(parked).toMatchObject({ parked: true });

    const withoutOptIn = await foldBusThread(value.root, first.threadId);
    expect(withoutOptIn.refusals).toEqual([]);

    const withOptIn = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(withOptIn.refusals).toHaveLength(1);
    expect(withOptIn.refusals[0]).toMatchObject({
      trigger: "duplicate_fingerprint",
      byEndpoint: value.reviewer.endpointId,
      artifactStatus: "resolved",
      disposition: "unresolved",
      markerState: "none",
    });
    expect(withOptIn.refusals[0]!.droppedMessage.severity).toBe("high");
    expect(withOptIn.refusals[0]!.successorThreadId).toBeUndefined();
  });

  it("reports markerState 'invalid' when a redeliver marker's bindings mismatch its park entry (ISS-953 fix step 8)", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "duplicate-actionable-refusals-invalid",
    });
    const folded = await foldBusThread(value.root, first.threadId);
    const parkEntry = folded.entries.at(-1)!;

    const markerDir = join(value.root, ".story", "bus", "threads", first.threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: first.threadId,
        // Wrong on purpose: does not match parkEntry.entryHash.
        predecessorEntryHash: "0".repeat(64),
        originalByEndpoint: value.reviewer.endpointId,
        successorThreadId: randomUUID(),
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    const resolved = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(parked.parked).toBe(true);
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("never exposes discardedSuccessorThreadId from an unbound marker, even though the marker record itself carries it (ISS-953 Codex round 6 findings #2/#3, security)", async () => {
    // A marker whose bindings mismatch its park entry classifies "invalid"
    // (the test above) -- this proves the SAME unbound marker's own
    // discardedSuccessorThreadId field, if present, must never be copied onto
    // the refusal despite the marker being schema-valid and present on disk.
    // The old gate checked only whether the marker file was present and
    // parseable (marker.status), not whether it actually bound to THIS
    // refusal (markerState) -- an on-disk forger's unbound marker previously
    // slipped a fabricated discardedSuccessorThreadId straight through to an
    // operator-facing notice, contradicting the field's documented meaning as
    // evidence of a completed supersede.
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "duplicate-actionable-refusals-invalid-discarded",
    });
    const folded = await foldBusThread(value.root, first.threadId);
    const parkEntry = folded.entries.at(-1)!;

    const markerDir = join(value.root, ".story", "bus", "threads", first.threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: first.threadId,
        // Wrong on purpose: does not match parkEntry.entryHash -- unbound.
        predecessorEntryHash: "0".repeat(64),
        originalByEndpoint: value.reviewer.endpointId,
        successorThreadId: randomUUID(),
        discardedSuccessorThreadId: randomUUID(),
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    const resolved = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(parked.parked).toBe(true);
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
    expect(resolved.refusals[0]).not.toHaveProperty("discardedSuccessorThreadId");
  });

  it("reports markerState 'invalid', not 'verified', when redeliver-markers is a symlink (ISS-953 fix step 8, security)", async () => {
    // resolveRefusals (fold.ts) reads redeliver markers through its OWN call site,
    // independent of redeliverBusMessage's -- the ship gate and bus_thread_get's
    // refusals both go through this path, so a symlink escape here could let a
    // forged "verified"/"redelivered" disposition clear a critical refusal that
    // was never actually redelivered.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s8-symlink-read");
    const real = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(real.replaySource).toBe("none");

    const resolvedBefore = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolvedBefore.refusals[0]).toMatchObject({ disposition: "redelivered", markerState: "verified" });

    const escapeTarget = join(value.root, "escaped-redeliver-markers-fold");
    await mkdir(escapeTarget, { recursive: true, mode: 0o700 });
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    const realMarker = await readFile(join(markerDir, `${parkEntry.entryHash}.json`), "utf-8");
    await rm(markerDir, { recursive: true, force: true });
    await writeFile(join(escapeTarget, `${parkEntry.entryHash}.json`), realMarker, "utf-8");
    await symlink(escapeTarget, markerDir);

    const resolvedAfter = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolvedAfter.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports markerState 'pending' when a bindings-correct marker's successor thread has not landed yet (ISS-953 fix step 8)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    // ISS-953 Codex round 2 findings #19/#22: same rebuild as the doctor
    // pending fixture above -- a duplicate_fingerprint park has no redeliver
    // path at all, so it can never legitimately produce a pending marker.
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "fold-pending");
    const unlandedSuccessorId = randomUUID();

    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: threadId,
        predecessorEntryHash: parkEntry.entryHash,
        originalByEndpoint: value.reviewer.endpointId,
        successorThreadId: unlandedSuccessorId,
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    const resolved = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "pending" });
    expect(resolved.refusals[0]!.successorThreadId).toBeUndefined();
  });

  it("reports markerState 'verified' and disposition 'redelivered' only for a self-consistent, content-matching successor (ISS-953 fix step 8)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    // A NEW thread's first message must equal its threadKind (validateInitialKinds),
    // so the dropped, later-redelivered message must ALSO be messageKind
    // "issue_notice" for the synthetic successor below to be constructible. A
    // "reply" is the more common real-world drop (fix step 11's own concern);
    // that content-shape is exercised end-to-end by the real-creation-path
    // test below.
    //
    // ISS-953 Codex round 2 findings #19/#22: the park itself must be
    // genuinely hop-cap-eligible, never duplicate_fingerprint (which
    // verifiedSuccessorState now rejects structurally before ever looking at
    // the successor) -- triggered here by an intervening ack reply pushing
    // hopCount to the lowered cap, never by sending identical content twice.
    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "ci-fixture-1-ack" },
      idempotencyKey: "verified-fixture-ack",
    });
    const dropped = {
      messageKind: "issue_notice" as const,
      severity: "medium" as const,
      body: "A second issue_notice for the same finding, dropped by the hop cap.",
      refs: { issue: issueId, ciRun: "ci-fixture-1" },
    };
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      inReplyTo: first.messageId,
      idempotencyKey: "verified-fixture-over-cap",
      ...dropped,
    });
    expect(parked).toMatchObject({ parked: true, state: "parked" });
    const predecessorFold = await foldBusThread(value.root, first.threadId);
    const parkEntry = predecessorFold.entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap" } });

    // Constructs the successor thread synthetically -- an ordinary thread with
    // byte-identical content to the artifact, then patched with the two
    // self-consistency fields and its threadHash recomputed -- rather than
    // going through fix step 11's real hop_cap_successor createThread branch,
    // which this same file exercises directly elsewhere (see the "ISS-953 fix
    // step 11" tests below). This isolates resolveRefusals's OWN verification
    // logic from the creation path's own behavior, deliberately, not as a
    // stand-in for a branch that did not yet exist.
    const successor = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      toRole: "implementer",
      idempotencyKey: "synthetic-successor-thread",
      ...dropped,
    });
    const threadJsonPath = join(value.root, ".story", "bus", "threads", successor.threadId, "thread.json");
    const rawThread = JSON.parse(await readFile(threadJsonPath, "utf-8"));
    const patchedUnsigned = {
      ...rawThread,
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      predecessorEntryHash: parkEntry.entryHash,
      // ISS-953 Codex round 3 finding #1: the real hop_cap_successor branch
      // (store.ts) hard-codes topicRef to ONLY { issue: predecessor's issue },
      // never the full topicRefFrom(refs) an ordinary thread creation derives --
      // this synthetic successor's own dropped.refs carries an extra ciRun,
      // so its topicRef must be narrowed the same way here, or verifiedSuccessorState's
      // new topicRef check (comparing against the ALREADY-VERIFIED predecessor)
      // rejects this otherwise-legitimate synthetic successor as tampered.
      topicRef: { issue: issueId },
      threadHash: "0".repeat(64),
    };
    const patchedThread = { ...patchedUnsigned, threadHash: hashWithoutKey(patchedUnsigned, "threadHash") };
    await writeFile(threadJsonPath, JSON.stringify(patchedThread, null, 2) + "\n", "utf-8");
    // The successor's sole entry chains off the ORIGINAL (pre-patch) threadHash via
    // prevHash; re-chain it off the patched thread's new threadHash and recompute
    // the entry's own hash, or foldBusThread quarantines the successor on the
    // resulting "integrity chain mismatch".
    const successorEntriesDir = join(value.root, ".story", "bus", "threads", successor.threadId, "entries");
    const [successorEntryFilename] = await readdir(successorEntriesDir);
    const successorEntryPath = join(successorEntriesDir, successorEntryFilename!);
    const rawEntry = JSON.parse(await readFile(successorEntryPath, "utf-8"));
    const patchedEntryUnsigned = { ...rawEntry, prevHash: patchedThread.threadHash, entryHash: "0".repeat(64) };
    const patchedEntry = { ...patchedEntryUnsigned, entryHash: hashWithoutKey(patchedEntryUnsigned, "entryHash") };
    await writeFile(successorEntryPath, JSON.stringify(patchedEntry, null, 2) + "\n", "utf-8");

    const markerDir = join(value.root, ".story", "bus", "threads", first.threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: first.threadId,
        predecessorEntryHash: parkEntry.entryHash,
        originalByEndpoint: value.reviewer.endpointId,
        successorThreadId: successor.threadId,
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    expect((await foldBusThread(value.root, successor.threadId)).integrity).toBe("verified");
    const resolved = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({
      disposition: "redelivered",
      markerState: "verified",
      successorThreadId: successor.threadId,
    });
  });

  // ISS-953 Codex round 3 finding #1: re-chain a GENUINE, redeliverBusMessage-created
  // successor thread after hand-patching one field, the same technique the wave uses
  // throughout -- thread.json's threadHash covers `participants`/`kind`/`topicRef`
  // directly, so any patch to them requires recomputing threadHash, which in turn
  // requires re-chaining the successor's sole entry's prevHash and recomputing ITS
  // entryHash, or foldBusThread quarantines the successor on "integrity chain
  // mismatch" before verifiedSuccessorState's own checks are ever reached.
  async function repatchSuccessorThread(
    root: string,
    successorThreadId: string,
    threadPatch: Record<string, unknown>,
    payloadPatch: Record<string, unknown> = {},
  ): Promise<void> {
    const threadJsonPath = join(root, ".story", "bus", "threads", successorThreadId, "thread.json");
    const rawThread = JSON.parse(await readFile(threadJsonPath, "utf-8"));
    const patchedUnsigned = { ...rawThread, ...threadPatch, threadHash: "0".repeat(64) };
    const patchedThread = { ...patchedUnsigned, threadHash: hashWithoutKey(patchedUnsigned, "threadHash") };
    await writeFile(threadJsonPath, JSON.stringify(patchedThread, null, 2) + "\n", "utf-8");

    const entriesDir = join(root, ".story", "bus", "threads", successorThreadId, "entries");
    const [entryFilename] = await readdir(entriesDir);
    const entryPath = join(entriesDir, entryFilename!);
    const rawEntry = JSON.parse(await readFile(entryPath, "utf-8"));
    const patchedEntryUnsigned = {
      ...rawEntry,
      payload: { ...rawEntry.payload, ...payloadPatch },
      prevHash: patchedThread.threadHash,
      entryHash: "0".repeat(64),
    };
    const patchedEntry = { ...patchedEntryUnsigned, entryHash: hashWithoutKey(patchedEntryUnsigned, "entryHash") };
    await writeFile(entryPath, JSON.stringify(patchedEntry, null, 2) + "\n", "utf-8");
  }

  it("reports markerState 'invalid' when a genuine successor's kind diverges from its verified predecessor's, even though sender/content/recipient all still check out (ISS-953 Codex round 3 finding #1, security)", async () => {
    // Everything else about this successor is genuine: a real redeliverBusMessage
    // call, a real marker, real authorship. Only `kind` is hand-patched after the
    // fact (thread.kind, never the message's own payload.kind) -- a coherently
    // forged successor that kept every OTHER check passing but detached from the
    // predecessor's issue_notice kind previously still verified.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s1-kind");
    const redelivered = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(redelivered.replaySource).toBe("none");

    await repatchSuccessorThread(value.root, redelivered.threadId, { kind: "question" });

    expect((await foldBusThread(value.root, redelivered.threadId)).integrity).toBe("verified");
    const resolved = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports markerState 'invalid' when a genuine successor's topicRef points at a DIFFERENT issue than its verified predecessor's (ISS-953 Codex round 3 finding #1, security)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const otherIssueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s1-topic");
    const redelivered = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(redelivered.replaySource).toBe("none");

    await repatchSuccessorThread(value.root, redelivered.threadId, { topicRef: { issue: otherIssueId } });

    expect((await foldBusThread(value.root, redelivered.threadId)).integrity).toBe("verified");
    const resolved = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports markerState 'invalid' when a genuine successor's first message is redirected to an endpoint that is not the predecessor's other participant (ISS-953 Codex round 3 finding #1, security, recipient redirect)", async () => {
    // The attack finding #1 names directly: a coherently forged successor that
    // redirects the preserved message elsewhere while still marking the refusal
    // redelivered. Redirected to an endpoint that does not exist in the registry
    // at all (the participants tuple is schema-validated as two UUIDs, not as two
    // REGISTERED endpoints, so this is a genuine on-disk-forgeable shape) --
    // proves the recipient check rejects a target with no succession chain to the
    // predecessor's other participant, independent of the sender/content/kind/
    // topicRef checks, which all still pass here.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s1-recipient");
    const redelivered = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(redelivered.replaySource).toBe("none");

    const impersonatorId = randomUUID();
    const threadJsonPath = join(value.root, ".story", "bus", "threads", redelivered.threadId, "thread.json");
    const rawThread = JSON.parse(await readFile(threadJsonPath, "utf-8"));
    const patchedParticipants = rawThread.participants.map((id: string) => (id === value.implementer.endpointId ? impersonatorId : id));
    await repatchSuccessorThread(value.root, redelivered.threadId, { participants: patchedParticipants }, { to: impersonatorId });

    expect((await foldBusThread(value.root, redelivered.threadId)).integrity).toBe("verified");
    const resolved = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports markerState 'invalid' when a forged successor's kind matches its predecessor's, but the predecessor itself is not issue_notice -- consistency alone is not the creation invariant (S7 round 3, order item 4 pen return, security)", async () => {
    // The pen's review of the kind/topicRef check found a gap: comparing
    // successorThread.kind only to predecessor.thread.kind checks CONSISTENCY,
    // not the actual creation invariant -- createHopCapSuccessorThread's own
    // `predecessor.thread.kind !== "issue_notice"` guard refuses it outright
    // unless the PREDECESSOR's own kind is "issue_notice", and hop-cap park
    // itself has no thread-kind gate (only
    // message-kind actionability + hop count), so a genuine "question" thread
    // CAN carry a hop-cap park with a critical droppedMessage. A forged
    // "question"-kind successor over a genuine "question" predecessor would
    // satisfy mere consistency without the added predecessor.thread.kind ===
    // "issue_notice" clause.
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "question",
      messageKind: "question",
      refs: { issue: issueId },
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s1-kind-half-ack" },
      idempotencyKey: "s1-kind-half-ack",
    });
    const dropped = {
      messageKind: "question" as const,
      severity: "critical" as const,
      body: "A second, critical question over the hop cap.",
      refs: { issue: issueId },
    };
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      inReplyTo: first.messageId,
      idempotencyKey: "s1-kind-half-over-cap",
      ...dropped,
    });
    expect(parked).toMatchObject({ parked: true, state: "parked" });
    const predecessorFold = await foldBusThread(value.root, first.threadId);
    const parkEntry = predecessorFold.entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap" } });

    // Synthetic successor, ALSO kind "question" -- satisfies mere consistency
    // with the predecessor's kind, the gap the pen's review found.
    // createHopCapSuccessorThread itself would refuse this predecessor outright
    // (its own `predecessor.thread.kind !== "issue_notice"` guard); simulate
    // what a forged on-disk successor of this shape would look like, the same
    // technique the sibling "verified" test above uses for its own synthetic
    // successor.
    const successor = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      toRole: "implementer",
      idempotencyKey: "s1-kind-half-synthetic-successor",
      ...dropped,
    });
    const threadJsonPath = join(value.root, ".story", "bus", "threads", successor.threadId, "thread.json");
    const rawThread = JSON.parse(await readFile(threadJsonPath, "utf-8"));
    const patchedUnsigned = {
      ...rawThread,
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      predecessorEntryHash: parkEntry.entryHash,
      threadHash: "0".repeat(64),
    };
    const patchedThread = { ...patchedUnsigned, threadHash: hashWithoutKey(patchedUnsigned, "threadHash") };
    await writeFile(threadJsonPath, JSON.stringify(patchedThread, null, 2) + "\n", "utf-8");
    const successorEntriesDir = join(value.root, ".story", "bus", "threads", successor.threadId, "entries");
    const [successorEntryFilename] = await readdir(successorEntriesDir);
    const successorEntryPath = join(successorEntriesDir, successorEntryFilename!);
    const rawEntry = JSON.parse(await readFile(successorEntryPath, "utf-8"));
    const patchedEntryUnsigned = { ...rawEntry, prevHash: patchedThread.threadHash, entryHash: "0".repeat(64) };
    const patchedEntry = { ...patchedEntryUnsigned, entryHash: hashWithoutKey(patchedEntryUnsigned, "entryHash") };
    await writeFile(successorEntryPath, JSON.stringify(patchedEntry, null, 2) + "\n", "utf-8");

    const markerDir = join(value.root, ".story", "bus", "threads", first.threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: first.threadId,
        predecessorEntryHash: parkEntry.entryHash,
        originalByEndpoint: value.reviewer.endpointId,
        successorThreadId: successor.threadId,
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    expect((await foldBusThread(value.root, successor.threadId)).integrity).toBe("verified");
    const resolved = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports markerState 'invalid' for an otherwise binding-correct marker attached to a duplicate_fingerprint park, never 'pending' (ISS-953 Codex round 2 findings #19/#22, security)", async () => {
    // A duplicate_fingerprint park has no redeliver path at all: unlike a
    // hop_cap park, the SAME content can always be resent and delivered
    // normally once the recipient replies, so no legitimate crash window can
    // ever produce a marker against one. This marker's own bindings
    // (predecessorThreadId/predecessorEntryHash/originalByEndpoint) agree
    // exactly with the park entry -- isolating the assertion to the trigger
    // check alone, not a bindings mismatch a different check would also
    // catch. The named successor thread does not need to exist: trigger is
    // checked before verifiedSuccessorState ever attempts to fold it, so
    // this is the minimal fixture that isolates the check under test.
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Can you verify the recovery boundary?",
      refs: { ciRun: "ci-fixture-1" },
      idempotencyKey: "invalid-marker-duplicate-fingerprint",
    });
    expect(parked).toMatchObject({ parked: true, state: "parked" });
    const folded = await foldBusThread(value.root, first.threadId);
    const parkEntry = folded.entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "duplicate_fingerprint" } });
    const unlandedSuccessorId = randomUUID();

    const markerDir = join(value.root, ".story", "bus", "threads", first.threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true });
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: first.threadId,
        predecessorEntryHash: parkEntry.entryHash,
        originalByEndpoint: value.reviewer.endpointId,
        successorThreadId: unlandedSuccessorId,
        createdAt: new Date().toISOString(),
      }, null, 2) + "\n",
      "utf-8",
    );

    const resolved = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
    expect(resolved.refusals[0]!.successorThreadId).toBeUndefined();
  });

  it("redelivers a hop-capped issue_notice reply through the real creation path, deriving topic from the predecessor even with empty message refs, and resolves the predecessor's refusal to 'redelivered'/'verified' (ISS-953 fix step 11)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: "s11-happy-first",
    });
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s11-second" },
      idempotencyKey: "s11-happy-second",
    });
    expect(second).toMatchObject({ hopCount: 2, parked: false });

    // Empty refs on purpose: this is the common real-world shape (a plain reply
    // continuing an existing conversation restates nothing), and the exact case
    // topicRefFrom would throw invalid_input on if the successor's topic were ever
    // derived from the message's own refs instead of the predecessor's.
    const dropped = {
      messageKind: "reply" as const,
      severity: "medium" as const,
      body: "One more check needed before this can close.",
      refs: {},
    };
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      idempotencyKey: "s11-happy-third-over-cap",
      ...dropped,
    });
    expect(parked).toMatchObject({ parked: true, state: "parked" });

    const predecessorFold = await foldBusThread(value.root, first.threadId);
    const parkEntry = predecessorFold.entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap", byEndpoint: value.reviewer.endpointId } });

    const successor = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      idempotencyKey: "s11-redeliver-fresh",
      ...dropped,
    });
    expect(successor.parked).toBe(false);
    expect(successor.messageId).not.toBeNull();

    const successorFold = await foldBusThread(value.root, successor.threadId);
    expect(successorFold.integrity).toBe("verified");
    expect(successorFold.thread).toMatchObject({
      kind: "issue_notice",
      topicRef: { issue: issueId },
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      predecessorEntryHash: parkEntry.entryHash,
      participants: [value.reviewer.endpointId, value.implementer.endpointId],
    });
    expect(successorFold.messages[0]).toMatchObject({
      kind: dropped.messageKind,
      severity: dropped.severity,
      body: dropped.body,
      refs: dropped.refs,
    });

    // The step-8 commitment: a real end-to-end verified/redelivered case through
    // the actual creation path, not the synthetic hand-patched fixture.
    const resolvedPredecessor = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(resolvedPredecessor.refusals[0]).toMatchObject({
      disposition: "redelivered",
      markerState: "verified",
      successorThreadId: successor.threadId,
    });
  });

  it("returns the SAME successor on a repeat hop_cap_successor call once verified, without creating a second thread or marker (ISS-953 fix step 11)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: "s11-hit-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged.",
      refs: { ciRun: "s11-hit-second" },
      idempotencyKey: "s11-hit-second",
    });
    const dropped = {
      messageKind: "reply" as const,
      severity: "medium" as const,
      body: "Redeliver-me content.",
      refs: { ciRun: "s11-hit-dropped" },
    };
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      idempotencyKey: "s11-hit-third-over-cap",
      ...dropped,
    });
    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;

    const successor1 = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      idempotencyKey: "s11-hit-redeliver-a",
      ...dropped,
    });
    // A different idempotencyKey forces this second call past reviewer's OWN
    // receipt short-circuit and back into createThread's marker check, which is
    // the actual marker-hit path this test exists to exercise.
    const successor2 = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      idempotencyKey: "s11-hit-redeliver-b",
      ...dropped,
    });
    expect(successor2.threadId).toBe(successor1.threadId);
    expect(successor2.messageId).toBe(successor1.messageId);
    expect(successor2.replayed).toBe(true);

    const markerFiles = await readdir(join(value.root, ".story", "bus", "threads", first.threadId, "redeliver-markers"));
    expect(markerFiles).toHaveLength(1);
    const threadFiles = await readdir(join(value.root, ".story", "bus", "threads"));
    expect(threadFiles).toHaveLength(2); // predecessor + exactly one successor
  });

  it("refuses hop_cap_successor redelivery from the predecessor's OTHER original participant, and creates no marker (ISS-953 fix step 11)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: "s11-unauth-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged.",
      refs: { ciRun: "s11-unauth-second" },
      idempotencyKey: "s11-unauth-second",
    });
    const dropped = {
      messageKind: "reply" as const,
      severity: "medium" as const,
      body: "Unauthorized redeliver attempt content.",
      refs: { ciRun: "s11-unauth-dropped" },
    };
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      idempotencyKey: "s11-unauth-third-over-cap",
      ...dropped,
    });
    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;
    const threadsBefore = (await readdir(join(value.root, ".story", "bus", "threads"))).sort();

    // The dropped message's byEndpoint is the reviewer; the implementer (the
    // predecessor's OTHER original participant) has no succession chain reaching
    // it and must be refused, not merely discouraged.
    await expect(sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      idempotencyKey: "s11-unauthorized-attempt",
      ...dropped,
    })).rejects.toMatchObject({ code: "unauthorized" });

    await expect(readdir(join(value.root, ".story", "bus", "threads", first.threadId, "redeliver-markers")))
      .rejects.toMatchObject({ code: "ENOENT" });
    // Direct proof, not just inferred from marker-directory absence (which is only
    // sound because marker-write precedes thread-creation): no new thread landed.
    expect((await readdir(join(value.root, ".story", "bus", "threads"))).sort()).toEqual(threadsBefore);
  });

  it("selects the predecessor's OTHER original participant correctly even when a park entry's recorded byEndpoint is not literally one of the predecessor thread's original participants (ISS-953 Codex round 3 finding #10, correctness/hardening)", async () => {
    // Finding #10's literal scenario -- "the dropped message was authored by a
    // successor endpoint" -- is NOT reachable through the exposed send path: an
    // ordinary sendBusMessage reply requires the CALLER to be literally present
    // in thread.participants (readThreadParticipants's own check, which
    // has no succession-chain fallback, unlike updateBusThread's ISS-872 check),
    // and thread.participants is fixed permanently at thread creation. So a
    // genuine automatic hop-cap park's byEndpoint is always literal to its own
    // thread's participants -- confirmed by attempting exactly this construction
    // (successor authors the over-cap reply) and observing it rejected with
    // "Endpoint is not a participant in this thread" before ever reaching the
    // park logic. This test instead hand-forges the park entry's own byEndpoint
    // field (recomputing its entryHash, the same technique repatchSuccessorThread
    // uses elsewhere in this file), representing a hand-tampered/corrupted park
    // record rather than a legitimately reachable one -- the fix must not
    // silently select the wrong participant against that shape either, matching
    // this suite's existing posture of hardening against forged on-disk state
    // (finding #1's forged-successor tests, the corrupt-chain tests) even where
    // the ordinary API cannot produce it itself.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s10-forge");
    // ISS-953 Codex round 4, task 10 comment sweep: this was previously stated
    // as [value.implementer.endpointId, value.reviewer.endpointId] -- wrong.
    // parkOverCap's first send is reviewSend, which calls sendBusMessage with
    // endpointId: value.reviewer.endpointId as the CALLER -- publishNewThread
    // constructs a new thread's participants as [endpoint.endpointId,
    // toEndpointId], caller first, so the genuine order is reviewer first:
    // predecessor.thread.participants === [value.reviewer.endpointId, value.implementer.endpointId];
    // parkEntry.payload.byEndpoint === value.reviewer.endpointId (literal, genuine).

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s10-forge";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    // Forge the park entry's byEndpoint to reviewer2's id: not literally in
    // predecessor.thread.participants (only the ORIGINAL reviewer/implementer
    // ids are), reachable via reviewer2's genuine succession chain.
    const entriesDir = join(value.root, ".story", "bus", "threads", threadId, "entries");
    const [entryFilename] = (await readdir(entriesDir)).sort().slice(-1);
    const entryPath = join(entriesDir, entryFilename!);
    const rawEntry = JSON.parse(await readFile(entryPath, "utf-8"));
    const patchedUnsigned = { ...rawEntry, payload: { ...rawEntry.payload, byEndpoint: reviewer2.endpointId }, entryHash: "0".repeat(64) };
    const patchedEntry = { ...patchedUnsigned, entryHash: hashWithoutKey(patchedUnsigned, "entryHash") };
    await writeFile(entryPath, JSON.stringify(patchedEntry, null, 2) + "\n", "utf-8");
    const forgedParkEntry = (await foldBusThread(value.root, threadId)).entries.at(-1)!;
    expect(forgedParkEntry).toMatchObject({ entryHash: patchedEntry.entryHash, payload: { byEndpoint: reviewer2.endpointId } });

    // The correct "other participant" is the ORIGINAL implementer -- never the
    // original reviewer (the author side, wrongly selected by literal inequality
    // against reviewer2's id, which matches neither original participant
    // literally).
    const result = await redeliverBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: forgedParkEntry.entryHash,
    });
    expect(result.toEndpoint).toBe(value.implementer.endpointId);

    // ISS-953 Codex round 4 finding #8: the assertion above only checks the
    // CREATE path's own result (store.ts, already fixed by round 3's finding
    // #10). It never exercises verifiedSuccessorState's OWN, independently
    // computed recipient-binding check (fold.ts) on the successor this call
    // just made -- that is a genuinely separate code path (fold.ts's read-side
    // classifier, not store.ts's write-side selection), and it can disagree
    // with the create path's answer without this test noticing.
    const foldedAfter = await foldBusThread(value.root, threadId, { includeRefusals: true });
    const refusal = foldedAfter.refusals.find((entry) => entry.entryHash === forgedParkEntry.entryHash);
    expect(refusal).toMatchObject({
      markerState: "verified",
      disposition: "redelivered",
      successorThreadId: result.threadId,
    });
  });

  it("refuses hop_cap_successor redelivery whose content does not exactly match the resolved refused artifact (ISS-953 fix step 11)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: "s11-mismatch-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged.",
      refs: { ciRun: "s11-mismatch-second" },
      idempotencyKey: "s11-mismatch-second",
    });
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "The real dropped body.",
      refs: { ciRun: "s11-mismatch-dropped" },
      idempotencyKey: "s11-mismatch-third-over-cap",
    });
    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      idempotencyKey: "s11-mismatch-attempt",
      messageKind: "reply",
      severity: "medium",
      body: "A DIFFERENT body than what was actually dropped.",
      refs: { ciRun: "s11-mismatch-dropped" },
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses hop_cap_successor redelivery against a duplicate_fingerprint park entry (ineligible trigger) (ISS-953 fix step 11)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const dupBody = "Can you verify the recovery boundary?";
    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      body: dupBody,
      refs: { issue: issueId },
      idempotencyKey: "s11-dup-first",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "issue_notice",
      severity: "medium",
      body: dupBody,
      refs: { issue: issueId },
      idempotencyKey: "s11-dup-second",
    });
    expect(parked.parked).toBe(true);
    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;
    expect(parkEntry.payload.trigger).toBe("duplicate_fingerprint");

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      idempotencyKey: "s11-dup-redeliver-attempt",
      messageKind: "issue_notice",
      severity: "medium",
      body: dupBody,
      refs: { issue: issueId },
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ISS-953 fix step 12: standard 3-hop setup (issue_notice, ack reply, over-cap
  // reply) that auto-parks on the THIRD hop under maxHops: 2 -- shared by every
  // redeliverBusMessage test below, all of which act on that same park entry.
  // byEndpoint on the resulting park entry is always the reviewer (whoever
  // attempted the over-cap send), matching the fix step 11 happy-path test.
  async function parkOverCap(
    value: BusFixture,
    issueId: string,
    prefix: string,
  ): Promise<{ threadId: string; parkEntry: { entryHash: string } }> {
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: `${prefix}-first`,
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: `${prefix}-ack` },
      idempotencyKey: `${prefix}-ack`,
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: `${prefix}-over-cap`,
    });
    expect(parked).toMatchObject({ parked: true, state: "parked" });
    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap", byEndpoint: value.reviewer.endpointId } });
    return { threadId: first.threadId, parkEntry };
  }

  // Forge an endpoint positively offline (a processRef whose pid does not exist
  // reads as dead, satisfying --replace's offline proof), then replace it with a
  // fresh claude successor -- mirrors succession-redelivery.test.ts's own helpers,
  // duplicated locally rather than shared since that file's helpers are private.
  async function forgeOffline(root: string, endpointId: string): Promise<void> {
    const path = join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
    const endpoint = JSON.parse(await readFile(path, "utf-8"));
    await writeFile(path, JSON.stringify({
      ...endpoint,
      state: "attached",
      processRef: { pid: 999999999, signature: "darwin:deadbeef", capturedAt: new Date().toISOString() },
    }, null, 2) + "\n", "utf-8");
  }

  async function replaceWithSuccessor(root: string, replaceId: string, taskId: string): Promise<BusEndpoint> {
    return (await joinEndpoint(root, {
      client: "claude",
      clientTaskId: taskId,
      surface: "claude_cli",
      replace: replaceId,
    })).endpoint;
  }

  // Corrupt an endpoint's OWN succession chain by pointing predecessorEndpointId at
  // a well-formed but nonexistent UUID -- sourced from succession-redelivery.test.ts's
  // "fails closed to self-only authority on a corrupt predecessor chain" precedent.
  // endpointAddressees (endpoints.ts) walks the chain and, on a missing
  // ancestor, falls back to { ids: [endpoint.endpointId], corrupt: <reason> }: works
  // identically whether the target already has a legitimate predecessorEndpointId
  // (a real successor, overwritten here) or none at all (an original fixture
  // endpoint, gaining one for the first time).
  async function corruptEndpointChain(root: string, endpointId: string): Promise<void> {
    const path = join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
    const endpoint = JSON.parse(await readFile(path, "utf-8"));
    await writeFile(path, JSON.stringify({
      ...endpoint,
      predecessorEndpointId: "00000000-0000-4000-8000-000000000000",
    }, null, 2) + "\n", "utf-8");
  }

  it("replaying an already-parked send recomputes and reports the same nextAction as the original result when nothing has changed since the park (ISS-953 fix step 14, test i)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s14-i");

    // Retry the SAME send that produced the park (identical endpoint + idempotency
    // key + payload): a receipt replay of a parked outcome, not a fresh operation.
    // nextAction is recomputed on this call rather than cached from the original
    // (see store.ts's own BusSendResult.nextAction doc comment) -- it matches here
    // only because nothing eligibility-relevant (the artifact, the linked issue)
    // has changed between the two calls.
    const replay = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "s14-i-over-cap",
    });
    expect(replay).toMatchObject({ parked: true, replayed: true, replaySource: "receipt" });
    expect(replay.nextAction).toEqual({
      procedure: "redeliver_on_hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      predecessorThreadId: threadId,
    });
  });

  it("offers no redeliver nextAction for a legacy hop-cap park entry with no droppedMessage (ISS-953 fix step 13, backward compatibility)", async () => {
    // droppedMessage is new as of fix step 4. A park entry written by an older
    // build has automatic:true, trigger:"hop_cap", and no droppedMessage at all --
    // simulated here by stripping the field from an otherwise-genuine park entry
    // and recomputing its entryHash. nextActionForPark previously checked only
    // trigger === "hop_cap", so it would offer redeliver_on_hop_cap_successor for
    // this entry even though redeliverBusMessage itself rejects it as
    // invalid_input for the same missing field -- a guaranteed dead end.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId } = await parkOverCap(value, issueId, "s13-legacy");

    const entriesDir = join(value.root, ".story", "bus", "threads", threadId, "entries");
    const parkFilename = (await readdir(entriesDir)).sort().at(-1)!;
    const parkPath = join(entriesDir, parkFilename);
    const rawEntry = JSON.parse(await readFile(parkPath, "utf-8"));
    const originalEntryHash = rawEntry.entryHash;
    delete rawEntry.payload.droppedMessage;
    rawEntry.entryHash = "0".repeat(64);
    rawEntry.entryHash = hashWithoutKey(rawEntry, "entryHash");
    await writeFile(parkPath, JSON.stringify(rawEntry, null, 2) + "\n", "utf-8");

    // The committed receipt binds to the park entry's ORIGINAL hash
    // (committedAutomaticPark rejects a receipt/entry mismatch as corrupt, by
    // design -- see store.ts's own comment on that check). Since this test
    // tampers the entry itself (recomputing its hash), the receipt must be
    // updated in lockstep to keep pointing at the same logical entry, exactly as
    // a real pre-existing legacy receipt would already point at its own
    // (never-tampered) legacy entry hash.
    const receiptKeyHash = idempotencyKeyHash(value.reviewer.endpointId, "s13-legacy-over-cap");
    const receiptPath = join(value.root, ".story", "bus", "idempotency", value.reviewer.endpointId, `${receiptKeyHash}.json`);
    const rawReceipt = JSON.parse(await readFile(receiptPath, "utf-8"));
    expect(rawReceipt.stateEntryHash).toBe(originalEntryHash);
    rawReceipt.stateEntryHash = rawEntry.entryHash;
    await writeFile(receiptPath, JSON.stringify(rawReceipt, null, 2) + "\n", "utf-8");

    // Sanity: core fold integrity is untouched by this tamper (the entryHash was
    // correctly recomputed) -- this test is meaningless if the core fold itself
    // already rejects the thread on other grounds.
    const tamperedFold = await foldBusThread(value.root, threadId);
    expect(tamperedFold.integrity).toBe("verified");

    const replay = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "s13-legacy-over-cap",
    });
    expect(replay).toMatchObject({ parked: true, replayed: true, replaySource: "receipt" });
    expect(replay.nextAction).toBeNull();
  });

  it("offers no redeliver nextAction once the park entry's refused artifact is missing, even though the entry itself is otherwise perfectly valid (ISS-953 Codex round 5 finding #8, dead-end guidance)", async () => {
    // Sibling to the legacy-droppedMessage test above, same doctrine, different
    // failure mode: droppedMessage is PRESENT and structurally valid here, but
    // the artifact it points at (refusedPayloadHash) has been deleted out from
    // under it -- simulating out-of-band artifact loss/corruption between the
    // original park and a later replay. createHopCapSuccessorThread's own
    // content re-verification (readConsistentRefusedArtifact) requires
    // "resolved" before it will proceed, so recommending
    // redeliver_on_hop_cap_successor here is a guaranteed dead end exactly
    // like the legacy case above, just reached through a different gap in the
    // same guard.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s8-r5-artifact-missing");

    const folded = await foldBusThread(value.root, threadId);
    const entry = folded.entries.find((candidate) => candidate.entryHash === parkEntry.entryHash);
    if (!entry || entry.type !== "state" || !entry.payload.droppedMessage) {
      throw new Error("unreachable: parkOverCap always produces a droppedMessage-bearing park entry");
    }
    const paths = await resolveInitializedBusPaths(value.root);
    const artifactPath = join(paths.refused, `${entry.payload.droppedMessage.refusedPayloadHash}.json`);
    await rm(artifactPath);

    const replay = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "s8-r5-artifact-missing-over-cap",
    });
    expect(replay).toMatchObject({ parked: true, replayed: true, replaySource: "receipt" });
    expect(replay.nextAction).toBeNull();

    // Confirms the guard is not merely defensive-and-unreachable: the call the
    // OLD code would have recommended really does fail, the same shape as the
    // legacy-droppedMessage test's own justification.
    await expect(redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("offers no redeliver nextAction once the park entry's linked issue has been resolved, even though the entry and its artifact are otherwise perfectly valid (ISS-953 Codex round 6 finding #4, dead-end guidance)", async () => {
    // Sibling to the artifact-missing test above, same doctrine, a third gap in
    // the same guard: createHopCapSuccessorThread separately requires the
    // linked issue to exist and be unresolved (`!issue || issue.status ===
    // "resolved"` -> BusError("conflict")) before it will proceed, but
    // nextActionForPark never checked that -- so a replay after the linked
    // issue resolves (as this one legitimately can, between the original park
    // and any later retry) still recommended redeliver_on_hop_cap_successor,
    // a guaranteed dead end reached through yet another gap in the same guard.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s4-r6-issue-resolved");

    await resolveIssue(value.root, issueId);

    const replay = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "s4-r6-issue-resolved-over-cap",
    });
    expect(replay).toMatchObject({ parked: true, replayed: true, replaySource: "receipt" });
    expect(replay.nextAction).toBeNull();

    // Confirms the guard is not merely defensive-and-unreachable: the call the
    // OLD code would have recommended really does fail, the same shape as the
    // artifact-missing test's own justification.
    await expect(redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a hop_cap_successor send whose declared threadKind merely coincides with the dropped message's kind, instead of silently accepting it (ISS-953 fix step 11, security)", async () => {
    // validateInitialKinds's hop_cap_successor exception previously only checked
    // threadKind === "issue_notice" to short-circuit past the general
    // threadKind === messageKind check -- it never REQUIRED "issue_notice" when
    // that short-circuit did not fire. A caller declaring threadKind "question"
    // whose dropped message also happened to be kind "question" would pass
    // validation by coincidence, even though createHopCapSuccessorThread hard-
    // codes the actual successor's kind to "issue_notice" regardless -- so the
    // caller's declaration and the server's actual write would silently diverge.
    // Reject any threadKind other than "issue_notice" for this relation outright.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: "s11-kind-mismatch-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s11-kind-mismatch-ack" },
      idempotencyKey: "s11-kind-mismatch-ack",
    });
    // The dropped message's own kind is "question" -- deliberately chosen because
    // "question" is also a valid BusThreadKind, the coincidence this test exploits.
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "medium",
      body: "Does this need a design doc first?",
      idempotencyKey: "s11-kind-mismatch-over-cap",
    });
    expect(parked).toMatchObject({ parked: true });
    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap" } });

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "medium",
      body: "Does this need a design doc first?",
      idempotencyKey: "s11-kind-mismatch-direct",
      predecessorThreadId: first.threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a hop_cap_successor send whose messageKind is status, claim, or release, even when the resolved artifact agrees (ISS-953 Codex round 2 finding #7, validation)", async () => {
    // validateInitialKinds's hop_cap_successor exception replaces the ordinary
    // threadKind/messageKind pairing check with only the issue_notice
    // requirement, and previously returned without enforcing anything about
    // messageKind. A genuine park can never itself produce a non-actionable
    // droppedMessage (overHopCap only fires for ACTIONABLE_KINDS messages), so
    // an end-to-end send with a mismatched non-actionable messageKind would
    // already be caught by createHopCapSuccessorThread's later content
    // re-verification (artifact.messageKind !== normalized.messageKind) for
    // an unrelated reason -- not isolating this check. Hand-craft the
    // artifact and its park entry's droppedMessage to AGREE on the
    // non-actionable kind (simulating a corrupted/hand-edited pair, or a
    // future park path that no longer gates on ACTIONABLE_KINDS), so content
    // re-verification passes and only validateInitialKinds's own gate can
    // still reject it.
    for (const messageKind of ["status", "claim", "release"] as const) {
      const value = await fixture();
      const issueId = await createIssue(value.root, "medium");
      const { threadId } = await parkOverCap(value, issueId, `s7-non-actionable-${messageKind}`);

      const tamperedArtifact = {
        schema: "storybloq-bus-refused-artifact/v1",
        messageKind,
        severity: "medium",
        body: "One more check needed before this can close.",
        refs: {},
      };
      const newHash = canonicalHash(tamperedArtifact);
      const refusedDir = join(value.root, ".story", "bus", "refused");
      await writeFile(join(refusedDir, `${newHash}.json`), JSON.stringify(tamperedArtifact, null, 2) + "\n", "utf-8");

      const entriesDir = join(value.root, ".story", "bus", "threads", threadId, "entries");
      const parkFilename = (await readdir(entriesDir)).sort().at(-1)!;
      const parkPath = join(entriesDir, parkFilename);
      const rawEntry = JSON.parse(await readFile(parkPath, "utf-8"));
      rawEntry.payload.droppedMessage.messageKind = messageKind;
      rawEntry.payload.droppedMessage.refusedPayloadHash = newHash;
      rawEntry.entryHash = "0".repeat(64);
      rawEntry.entryHash = hashWithoutKey(rawEntry, "entryHash");
      await writeFile(parkPath, JSON.stringify(rawEntry, null, 2) + "\n", "utf-8");
      const tamperedEntryHash: string = rawEntry.entryHash;

      // Sanity: core fold integrity is untouched by this tamper -- this test
      // is meaningless if the core fold itself already rejects the thread.
      const tamperedFold = await foldBusThread(value.root, threadId);
      expect(tamperedFold.integrity).toBe("verified");

      await expect(sendBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        threadKind: "issue_notice",
        messageKind,
        severity: "medium",
        body: "One more check needed before this can close.",
        idempotencyKey: `s7-non-actionable-${messageKind}-send`,
        predecessorThreadId: threadId,
        predecessorRelation: "hop_cap_successor",
        refusedEntryHash: tamperedEntryHash,
      })).rejects.toMatchObject({ code: "invalid_input" });

      const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
      await expect(readdir(markerDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects a hop_cap_successor send that declares inReplyTo, even naming a genuine predecessor-thread message id (ISS-953 Codex round 2 finding #8, security)", async () => {
    // messagePayload sets inReplyTo straight from the caller's own input,
    // unconditionally, for every relation. A hop_cap_successor send's message
    // becomes the successor thread's very FIRST entry -- its own fold's
    // `messages` array is necessarily still empty at that point, so accepting
    // ANY non-null inReplyTo would self-destruct the successor the instant it
    // is folded (the core fold's "reply target does not exist in the valid
    // prefix" check), even when the named id genuinely exists -- just on the
    // PREDECESSOR thread, not this brand new one. Reject it outright before
    // ever reaching creation, rather than accept it and quarantine what this
    // very call just created.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s8-inreplyto");
    // A genuine message id, taken from the predecessor thread itself -- not a
    // random/garbage id -- to prove this is rejected on principle (any
    // inReplyTo is invalid here), not merely because it fails some unrelated
    // existence check.
    const predecessorFold = await foldBusThread(value.root, threadId);
    const genuineMessageId = predecessorFold.messages[0]!.messageId;

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "s8-inreplyto-direct",
      inReplyTo: genuineMessageId,
      predecessorThreadId: threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "invalid_input" });

    // Nothing was created: no marker, no successor thread pointer left behind
    // by the rejected attempt.
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await expect(readdir(markerDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to mint a hop_cap_successor thread against a recipient who retired between sendBusMessage's outer peer resolution and createHopCapSuccessorThread's own re-check (ISS-953 Codex round 2 finding #9, security)", async () => {
    // toEndpointId is resolved once, early, by resolveActivePeer inside
    // sendBusMessage -- well before threads.lock is ever acquired.
    // createHopCapSuccessorThread re-fetches the endpoint registry itself,
    // close to use, and its existing chain-reachability check
    // (endpointAddressees(peerEndpoint, allEndpoints).ids.includes(...))
    // passes trivially for a retired peer too, since endpointAddressees always
    // includes the STARTING endpoint's own id regardless of its own retirement
    // status -- only ancestor/successor walks care about retirement. Without an
    // explicit retiredAt check, a peer that retires in the outer-resolution
    // window is still an eligible-looking recipient.
    //
    // Roles are reversed from parkOverCap's (implementer sends the over-cap
    // message, reviewer receives): the resolved recipient here must be able to
    // be forged offline and replaced by succession, and only the claude_cli
    // reviewer fixture endpoint qualifies (the codex_desktop implementer's
    // liveness is unconditionally "unknown" and can never be proven offline) --
    // same constraint noted at the "reports the successor message's own
    // recorded recipient" test above.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first0 = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      severity: "medium",
      body: "Investigate the recovery boundary.",
      refs: { issue: issueId },
      idempotencyKey: "s9-toctou-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first0.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s9-toctou-ack" },
      idempotencyKey: "s9-toctou-ack",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first0.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "s9-toctou-over-cap",
    });
    expect(parked).toMatchObject({ parked: true });
    const parkEntry = (await foldBusThread(value.root, first0.threadId)).entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap", byEndpoint: value.implementer.endpointId } });

    // Intercept listEndpoints: the FIRST call within this send is
    // resolveActivePeer's own outer resolution (must see the reviewer still
    // active, exactly as a genuine pre-race resolution would). The SECOND call
    // is createHopCapSuccessorThread's fresh re-fetch, close to use -- retiring
    // the reviewer immediately before that call, then calling through to the
    // real implementation, simulates the reviewer retiring in the window
    // between the two, while toEndpointId still names the now-retired id.
    const originalListEndpoints = endpointsModule.listEndpoints;
    let calls = 0;
    const spy = vi.spyOn(endpointsModule, "listEndpoints").mockImplementation(async (root) => {
      calls += 1;
      if (calls === 2) {
        await forgeOffline(root, value.reviewer.endpointId);
        await replaceWithSuccessor(root, value.reviewer.endpointId, "claude-task-reviewer-successor-s9-toctou");
      }
      return originalListEndpoints(root);
    });

    try {
      await expect(sendBusMessage(value.root, {
        endpointId: value.implementer.endpointId,
        clientTaskId: value.implementerTaskId,
        threadKind: "issue_notice",
        messageKind: "reply",
        severity: "medium",
        body: "One more check needed before this can close.",
        idempotencyKey: "s9-toctou-redeliver",
        predecessorThreadId: first0.threadId,
        predecessorRelation: "hop_cap_successor",
        refusedEntryHash: parkEntry.entryHash,
      })).rejects.toMatchObject({ code: "conflict" });
    } finally {
      vi.restoreAllMocks();
    }

    // Nothing was created: no marker left behind by the rejected attempt.
    const markerDir = join(value.root, ".story", "bus", "threads", first0.threadId, "redeliver-markers");
    await expect(readdir(markerDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers the marker-hit fast path from verifiedSuccessorState's OWN verified snapshot, immune to the successor's first entry changing in the window a second, unverified fold would have re-read it (ISS-953 Codex round 2 finding #14, security)", async () => {
    // verifiedSuccessorState already validates the successor's provenance and
    // artifact match. The vulnerable shape this finding names discards that
    // verified fold and re-folds the successor a second time, checking only
    // integrity and that entry zero is a message on the SECOND read -- never
    // re-confirming provenance or content. The successor directory can change
    // between the two reads, so that second, unverified read can return
    // identifiers from a successor that was never actually checked.
    //
    // Prove the CONSEQUENCE, not just the mechanism: tamper the successor's
    // real first entry (recomputing its own entryHash so the tamper is
    // internally consistent and would survive a naive integrity+type check)
    // as a side effect of verifiedSuccessorState itself returning, via
    // vi.spyOn(fold.verifiedSuccessorState) -- not a second vi.spyOn on
    // foldBusThread, which cannot see this: verifiedSuccessorState's own
    // internal fold of the successor is a same-module call within fold.ts,
    // invisible to a spy on the fold module's export object (only a
    // cross-module caller resolves through that export binding), so timing
    // off foldBusThread call-count silently never observes it and produces a
    // false pass regardless of which shape is under test. Spying on
    // verifiedSuccessorState itself sidesteps that: store.ts's call to it IS
    // a genuine cross-module call, so the tamper lands deterministically
    // right after the ONE read verifiedSuccessorState performs, no matter
    // which call site (this one or the EEXIST-recovery sibling below) is
    // under test. Assert the returned messageId is still the ORIGINAL,
    // pre-tamper one: a second, unverified fold (the reverted shape) reads
    // the successor AFTER the tamper and would return the tampered id.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s14-swap");

    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s14-swap";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    const successorEntriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const originalVerifiedSuccessorState = fold.verifiedSuccessorState;
    let swapped = false;
    const spy = vi.spyOn(fold, "verifiedSuccessorState").mockImplementation(async (...callArgs: Parameters<typeof fold.verifiedSuccessorState>) => {
      const result = await originalVerifiedSuccessorState(...callArgs);
      if (!swapped) {
        swapped = true;
        const [entryFilename] = await readdir(successorEntriesDir);
        const entryPath = join(successorEntriesDir, entryFilename!);
        const rawEntry = JSON.parse(await readFile(entryPath, "utf-8"));
        rawEntry.payload.messageId = randomUUID();
        rawEntry.entryHash = "0".repeat(64);
        rawEntry.entryHash = hashWithoutKey(rawEntry, "entryHash");
        await writeFile(entryPath, JSON.stringify(rawEntry, null, 2) + "\n", "utf-8");
      }
      return result;
    });

    try {
      const second = await redeliverBusMessage(value.root, {
        endpointId: reviewer2.endpointId,
        clientTaskId: successorTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      });
      expect(second).toMatchObject({ replaySource: "marker", replayed: true, threadId: first.threadId, messageId: first.messageId });
    } finally {
      spy.mockRestore();
    }
  });

  it("answers createHopCapSuccessorThread's EEXIST-recovery branch from verifiedSuccessorState's OWN verified snapshot too, the uncited sibling of finding #14's cited call site (ISS-953 Codex round 2 finding #14, security)", async () => {
    // The identical discard-and-refold shape finding #14 named at
    // redeliverBusMessage's marker-hit branch also existed, uncited by line
    // number, at createHopCapSuccessorThread's EEXIST-recovery branch (a
    // second sendBusMessage call racing an existing marker under lock). Same
    // consequence-level proof as the sibling test above, reached via a
    // second createThread call with a different idempotencyKey (forces past
    // reviewer's own receipt short-circuit into the EEXIST branch, mirroring
    // "returns the SAME successor on a repeat hop_cap_successor call").
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s14-eexist-swap");

    const successor1 = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      refs: {},
      idempotencyKey: "s14-eexist-swap-a",
    });

    const successorEntriesDir = join(value.root, ".story", "bus", "threads", successor1.threadId, "entries");
    const originalVerifiedSuccessorState = fold.verifiedSuccessorState;
    let swapped = false;
    const spy = vi.spyOn(fold, "verifiedSuccessorState").mockImplementation(async (...callArgs: Parameters<typeof fold.verifiedSuccessorState>) => {
      const result = await originalVerifiedSuccessorState(...callArgs);
      if (!swapped) {
        swapped = true;
        const [entryFilename] = await readdir(successorEntriesDir);
        const entryPath = join(successorEntriesDir, entryFilename!);
        const rawEntry = JSON.parse(await readFile(entryPath, "utf-8"));
        rawEntry.payload.messageId = randomUUID();
        rawEntry.entryHash = "0".repeat(64);
        rawEntry.entryHash = hashWithoutKey(rawEntry, "entryHash");
        await writeFile(entryPath, JSON.stringify(rawEntry, null, 2) + "\n", "utf-8");
      }
      return result;
    });

    try {
      const successor2 = await sendBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        threadKind: "issue_notice",
        predecessorThreadId: threadId,
        predecessorRelation: "hop_cap_successor",
        refusedEntryHash: parkEntry.entryHash,
        messageKind: "reply",
        severity: "medium",
        body: "One more check needed before this can close.",
        refs: {},
        idempotencyKey: "s14-eexist-swap-b",
      });
      expect(successor2).toMatchObject({ threadId: successor1.threadId, messageId: successor1.messageId, replayed: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("propagates a genuine EEXIST-recovery marker read failure as io_error, never collapsing it into corrupt (ISS-953 Codex round 2 finding #10)", async () => {
    // createHopCapSuccessorThread's own EEXIST-recovery read (a second
    // sendBusMessage call racing an existing marker) used to swallow every
    // read failure -- including a transient io_error like EACCES/EMFILE --
    // into the same "exists but does not match its own bindings" corrupt
    // diagnosis a genuinely mismatched marker gets. Mirrors the sibling
    // "propagates a genuine marker read failure as io_error" test for
    // redeliverBusMessage's own lock-free marker read (fix step 12), but
    // reached via the createThread EEXIST branch this finding actually cites.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s10-eexist-ioerror");

    const successor1 = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      refs: {},
      idempotencyKey: "s10-eexist-ioerror-a",
    });
    void successor1;

    const markerPath = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers", `${parkEntry.entryHash}.json`);
    await chmod(markerPath, 0o000);

    try {
      // A different idempotencyKey forces this second call past reviewer's own
      // receipt short-circuit and back into createThread's marker check, the
      // same technique "returns the SAME successor on a repeat hop_cap_successor
      // call" uses to reach this branch at all.
      await expect(sendBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        threadKind: "issue_notice",
        predecessorThreadId: threadId,
        predecessorRelation: "hop_cap_successor",
        refusedEntryHash: parkEntry.entryHash,
        messageKind: "reply",
        severity: "medium",
        body: "One more check needed before this can close.",
        refs: {},
        idempotencyKey: "s10-eexist-ioerror-b",
      })).rejects.toMatchObject({ code: "io_error" });
    } finally {
      await chmod(markerPath, 0o600);
    }
  });

  it("returns bus_disabled from the marker-hit fast path when Bus is disabled without removing its runtime (ISS-953 Codex round 2 finding #12, security)", async () => {
    // Every other entry point into Bus runtime state (sendBusMessage, etc.)
    // loads project config and calls assertBusEnabled before touching
    // anything. redeliverBusMessage resolved the runtime directly and never
    // did -- disabling Bus does not delete its runtime from disk, so a
    // verified-marker fast path could still successfully answer from a
    // disabled project, while the same call falling through to
    // sendBusMessage correctly fails closed with bus_disabled.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-disabled");

    // First call creates the verified marker via the ordinary fallthrough path.
    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    // A same-caller repeat holds its own receipt already and falls through to
    // sendBusMessage's own receipt lookup (replaySource "receipt"), never the
    // marker-hit "answer directly" branch this finding is about. Hand
    // ownership to a live successor endpoint (mirroring the fix step 14 test
    // v setup) so the second call has no prior receipt and is eligible for
    // the true marker-hit fast path.
    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s12-disabled";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    // Disable Bus without touching its runtime on disk.
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.features.bus = false;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    // Second call, from the successor, hits the marker-hit fast path.
    await expect(redeliverBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "bus_disabled" });
  });

  it("rejects a thread record where predecessorEntryHash is present without predecessorRelation and predecessorThreadId (ISS-953 Codex round 2 finding #6, schema integrity)", async () => {
    // predecessorRelation and predecessorEntryHash describe one inseparable
    // relation together with predecessorThreadId. A record declaring only
    // predecessorEntryHash (the case here) previously core-folded as valid even
    // though there is no predecessorRelation to explain what it names and no
    // predecessorThreadId to say which thread it names it on.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const first = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      severity: "medium",
      body: "Investigate the recovery boundary.",
      refs: { issue: issueId },
      idempotencyKey: "s6-partial-predecessor-fields",
    });
    const threadJsonPath = join(value.root, ".story", "bus", "threads", first.threadId, "thread.json");
    const rawThread = JSON.parse(await readFile(threadJsonPath, "utf-8"));
    const patchedUnsigned = {
      ...rawThread,
      predecessorEntryHash: "0".repeat(64),
      threadHash: "0".repeat(64),
    };
    const patchedThread = { ...patchedUnsigned, threadHash: hashWithoutKey(patchedUnsigned, "threadHash") };
    await writeFile(threadJsonPath, JSON.stringify(patchedThread, null, 2) + "\n", "utf-8");

    await expect(foldBusThread(value.root, first.threadId)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("supersedes a marker written before its successor thread landed with a fresh id, discarding the pre-assigned one, and leaves exactly one marker file naming the thread that actually got published (ISS-953 fix step 14 / ISS-1002 interim remedy, test iv)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s14-iv");

    const discardedSuccessorThreadId = randomUUID();
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const markerPath = join(markerDir, `${parkEntry.entryHash}.json`);
    await writeFile(markerPath, JSON.stringify({
      schema: "storybloq-bus-redeliver-marker/v1",
      predecessorThreadId: threadId,
      predecessorEntryHash: parkEntry.entryHash,
      originalByEndpoint: value.reviewer.endpointId,
      successorThreadId: discardedSuccessorThreadId,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf-8");

    const result = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(result.replaySource).toBe("none");
    // ISS-1002: the pre-existing marker's successorThreadId names no real
    // thread yet -- the same shape a forged marker would take -- so it is
    // never adopted. A fresh id is minted and published instead.
    expect(result.threadId).not.toBe(discardedSuccessorThreadId);

    const markerFiles = await readdir(markerDir);
    expect(markerFiles).toEqual([`${parkEntry.entryHash}.json`]);
    const supersededMarker = JSON.parse(await readFile(markerPath, "utf-8"));
    expect(supersededMarker.successorThreadId).toBe(result.threadId);
    expect(supersededMarker.discardedSuccessorThreadId).toBe(discardedSuccessorThreadId);
  });

  it("surfaces the discarded successor id in `storybloq bus doctor` output after a pending marker is superseded (ISS-1002 interim remedy observability)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "iss1002-observability");

    const discardedSuccessorThreadId = randomUUID();
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const markerPath = join(markerDir, `${parkEntry.entryHash}.json`);
    await writeFile(markerPath, JSON.stringify({
      schema: "storybloq-bus-redeliver-marker/v1",
      predecessorThreadId: threadId,
      predecessorEntryHash: parkEntry.entryHash,
      originalByEndpoint: value.reviewer.endpointId,
      successorThreadId: discardedSuccessorThreadId,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf-8");

    const result = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    // The redeliver call itself supersedes-and-publishes in one pass, so by
    // the time doctor reads it back the marker classifies as "verified" (its
    // own fresh successor landed) -- discardedSuccessorThreadId must still
    // be visible even though the state is no longer "pending".
    expect(result.threadId).not.toBe(discardedSuccessorThreadId);

    const doctor = await busDoctor(value.root);
    // ISS-1002 follow-up: a completed, self-healed supersede is reported on
    // the non-gating `notices` channel, never `findings` -- ISS-993 means
    // nothing ever removes the marker, so a findings-based signal here would
    // fail `storybloq bus doctor` permanently after one benign resume.
    expect(doctor.healthy).toBe(true);
    expect(doctor.findings.filter((finding) => finding.includes(parkEntry.entryHash))).toHaveLength(0);
    const notices = doctor.notices.filter((notice) => notice.includes(parkEntry.entryHash));
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toMatch(/pending|invalid|corrupt/);
    expect(notices[0]).toContain("superseded a prior claim");
    expect(notices[0]).toContain(discardedSuccessorThreadId);
  });

  it("answers a successor endpoint's redeliver from the marker directly after succession, without ever touching the receipt system (ISS-953 fix step 14, test v)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s14-v");

    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    const second = await redeliverBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(second).toMatchObject({
      replaySource: "marker",
      replayed: true,
      threadId: first.threadId,
      messageId: first.messageId,
    });

    // The receipt system was never touched for the successor: no idempotency
    // directory was ever created for it, proving the marker answered directly
    // rather than falling through to sendBusMessage's own receipt machinery.
    await expect(readdir(join(value.root, ".story", "bus", "idempotency", reviewer2.endpointId)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates the caller under endpoint-<id>.lock before answering from a verified marker, closing the TOCTOU the lock-free ownership snapshot leaves open (ISS-953 fix step 11, security)", async () => {
    // redeliverBusMessage's ownership and succession-chain checks (top of the
    // function) run lock-free, before it is even known that the marker-hit fast
    // path -- rather than the fallthrough sendBusMessage pipeline, which
    // revalidates both under endpoint-<id>.lock via its own withEndpointCaller --
    // will answer the call. Without a re-check inside the marker-hit branch
    // itself, a caller whose endpoint is retired and replaced by succession
    // AFTER that lock-free snapshot but BEFORE the marker-hit return would still
    // be answered from the stale snapshot.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s11-toctou");

    // Same setup as test v: create the successor via the fallthrough pipeline,
    // leaving a verified marker, then hand ownership to a live successor
    // endpoint (reviewer2) so the second call below is eligible for the
    // marker-hit fast path.
    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s11-toctou";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    // Simulate the race: intercept verifiedSuccessorState itself -- the
    // earliest point, still inside the lock-free portion of the function,
    // where the marker-hit branch is committed to reviewer2's identity -- and,
    // as a side effect of that call resolving, retire reviewer2 and replace it
    // with a THIRD endpoint, exactly what a genuine concurrent succession
    // would do. This does NOT spy on foldBusThread: since ISS-953 Codex round
    // 2 finding #14, the marker-hit branch answers from verifiedSuccessorState's
    // own verified snapshot and never re-folds the successor thread a second
    // time, so a spy timed off foldBusThread would have no second call left to
    // intercept and would silently never fire. verifiedSuccessorState is a
    // genuine cross-module call from store.ts into fold.ts, so spying on it
    // here is visible the same way spying on foldBusThread was before the
    // second read was removed.
    const originalVerifiedSuccessorState = fold.verifiedSuccessorState;
    let raced = false;
    const spy = vi.spyOn(fold, "verifiedSuccessorState").mockImplementation(async (...callArgs: Parameters<typeof fold.verifiedSuccessorState>) => {
      const result = await originalVerifiedSuccessorState(...callArgs);
      if (!raced) {
        raced = true;
        await forgeOffline(value.root, reviewer2.endpointId);
        await replaceWithSuccessor(value.root, reviewer2.endpointId, "claude-task-reviewer-successor-s11-toctou-race");
      }
      return result;
    });

    try {
      await expect(redeliverBusMessage(value.root, {
        endpointId: reviewer2.endpointId,
        clientTaskId: successorTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      })).rejects.toMatchObject({ code: "unauthorized" });
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed with corrupt, not a false authorization, when the caller's own succession chain is corrupt at createHopCapSuccessorThread's caller check, reached directly via sendBusMessage (ISS-953 Codex round 3 finding #9, caller check, security)", async () => {
    // Direct sendBusMessage with predecessorRelation: "hop_cap_successor" bypasses
    // redeliverBusMessage's own earlier checks entirely and lands straight in
    // createHopCapSuccessorThread's own authorization -- isolates finding #9's
    // caller check (store.ts, "Store the result once and check .corrupt BEFORE
    // .ids") from finding #12's checks in redeliverBusMessage, a structurally
    // identical but separately-cited sibling site.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s9-caller");

    await corruptEndpointChain(value.root, value.reviewer.endpointId);

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      refs: {},
      idempotencyKey: "s9-caller-direct",
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("fails closed with corrupt, not a false authorization, when the resolved recipient's own succession chain is corrupt at createHopCapSuccessorThread's peer check (ISS-953 Codex round 3 finding #9, peer check, security)", async () => {
    // Same direct-send entry point as the caller-check test above, but the
    // CALLER's chain stays clean and the resolved PEER's (implementer's) chain is
    // corrupted instead -- isolates #9's second, uncited gate (createHopCapSuccessorThread's
    // own peerAddressees check) from its caller-side sibling immediately above.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s9-peer");

    await corruptEndpointChain(value.root, value.implementer.endpointId);

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      refs: {},
      idempotencyKey: "s9-peer-direct",
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("fails closed with corrupt, not a false authorization, when a successor caller's own succession chain is corrupt at redeliverBusMessage's initial lock-free check (ISS-953 Codex round 3 finding #12, initial check, security)", async () => {
    // No marker exists yet for this refusedEntryHash, so this exercises the
    // INITIAL check (redeliverBusMessage's own initialCallerAddressees check)
    // in isolation from the marker-hit section entirely -- it must reject
    // before ever reading the marker file.
    // The caller is a genuine SUCCESSOR of the original park author (not the
    // author itself): with the corrupt-check removed, the self-only ids
    // fallback ([reviewer2.endpointId]) does not include parkEntry's original
    // byEndpoint (the retired reviewer), so a reverted check still surfaces a
    // difference (unauthorized instead of corrupt) rather than silently
    // matching by coincidence, keeping this test's RED-proof meaningful.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-initial");

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s12-initial";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);
    await corruptEndpointChain(value.root, reviewer2.endpointId);

    await expect(redeliverBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("revalidates the caller's succession chain under endpoint-<id>.lock before answering from a verified marker, closing the corruption-TOCTOU the lock-free initial check leaves open (ISS-953 Codex round 3 finding #12, under-lock recheck, security)", async () => {
    // Same race shape as the retirement-TOCTOU test above (ISS-953 fix step 11):
    // spy on fold.verifiedSuccessorState -- the latest point still inside the
    // lock-free portion of redeliverBusMessage where the marker-hit branch is
    // committed to reviewer2's identity -- and, as a side effect of that call
    // resolving, corrupt reviewer2's OWN succession chain in place, exactly what
    // a genuine concurrent hand-edit/attack would do in the same window. The
    // initial check (initialCallerAddressees) already ran, lock-free, against
    // reviewer2's still-clean chain before this spy ever fires, so only the
    // UNDER-LOCK recheck (freshAddressees, inside withEndpointCaller's fresh
    // re-read) can catch the corruption -- isolating it from the initial check
    // tested above.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-recheck");

    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s12-recheck";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    const originalVerifiedSuccessorState = fold.verifiedSuccessorState;
    let raced = false;
    const spy = vi.spyOn(fold, "verifiedSuccessorState").mockImplementation(async (...callArgs: Parameters<typeof fold.verifiedSuccessorState>) => {
      const result = await originalVerifiedSuccessorState(...callArgs);
      if (!raced) {
        raced = true;
        await corruptEndpointChain(value.root, reviewer2.endpointId);
      }
      return result;
    });

    try {
      await expect(redeliverBusMessage(value.root, {
        endpointId: reviewer2.endpointId,
        clientTaskId: successorTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      })).rejects.toMatchObject({ code: "corrupt" });
    } finally {
      spy.mockRestore();
    }
  });

  it("still delivers to the resolved peer's LIVE successor when that peer retires and is replaced in the window between createHopCapSuccessorThread's retiredAt check and publication -- the mailbox pointer is a delivery index, not the durable record, and reconcileEndpointMailbox rebuilds it from the entry on the successor's next poll (ISS-953 Codex round 3 finding #11, pinning test, ruled: real race, no fix -- harm structurally absent)", async () => {
    // Pen's ruling (S7 round 3, order item 6 second half): neither locking the
    // peer through publication nor a narrower re-check-before-write closes this
    // window (both were considered and rejected -- a narrower window still isn't
    // closed and would read as a guarantee it cannot make). The window is real,
    // but publishNewThread's durable record is the thread ENTRY, never the
    // mailbox pointer, and reconcileEndpointMailbox (called unconditionally by
    // pollBus) rebuilds a pointer from the entry for any addressee in the
    // polling endpoint's succession chain -- including a successor of the
    // originally-resolved (now-retired) peer. This test pins exactly the
    // property the ruling's correctness rests on: if it goes red, the ruling
    // is wrong and both rejected fixes come back on the table.
    //
    // Race technique: spy on refused.readConsistentRefusedArtifact -- the FIRST
    // genuine async I/O point inside createHopCapSuccessorThread after the
    // retiredAt check already ran and passed against the peer while it was
    // still live -- and, as a side effect of that call resolving,
    // retire the peer and replace it with a successor, landing the race in the
    // exact window the ruling analyzes: after the check, before
    // publishNewThread's mailbox-pointer write.
    //
    // Roles are the REVERSE of parkOverCap's (implementer authors the park,
    // reviewer receives): the implementer fixture endpoint's surface is
    // "codex_desktop", whose liveness is unconditionally "unknown" (endpoints.ts)
    // and so can never be positively proven offline/replaced -- only the
    // claude_cli reviewer endpoint can stand in for the "peer later retired and
    // replaced by succession" role forgeOffline needs (same constraint the
    // existing fix-step-11 marker-hit-branch-recipient test names).
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      severity: "medium",
      body: "Investigate the recovery boundary.",
      refs: { issue: issueId },
      idempotencyKey: "s11-race-first",
    });
    // predecessor.thread.participants === [implementer.id, reviewer.id].
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s11-race-ack" },
      idempotencyKey: "s11-race-ack",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "s11-race-over-cap",
    });
    expect(parked).toMatchObject({ parked: true, state: "parked" });
    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap", byEndpoint: value.implementer.endpointId } });

    // readConsistentRefusedArtifact is called FOUR times in this flow (traced via
    // stack, since every call shares identical arguments): (1) fold.ts's own
    // resolveRefusals, invoked internally by redeliverBusMessage's own
    // predecessor foldBusThread call; (2) redeliverBusMessage's own explicit
    // pre-marker content check, still before the retiredAt check is even
    // reached; (3) fold.ts's resolveRefusals again, invoked internally by
    // createHopCapSuccessorThread's OWN re-fold of the same predecessor;
    // (4) createHopCapSuccessorThread's own explicit call, the only one of the
    // four positioned AFTER its own retiredAt check.
    // Race on that fourth call specifically -- any earlier call lands before
    // toEndpointId is ever resolved (sendBusMessage's own resolveActivePeer, in
    // the fallthrough this function delegates to) and would not exercise the
    // window this test targets at all.
    const originalReadConsistentRefusedArtifact = refused.readConsistentRefusedArtifact;
    let callCount = 0;
    let raced = false;
    let reviewer2: BusEndpoint | undefined;
    const successorTaskId = "claude-task-reviewer-successor-s11-race";
    const spy = vi.spyOn(refused, "readConsistentRefusedArtifact").mockImplementation(async (...callArgs: Parameters<typeof refused.readConsistentRefusedArtifact>) => {
      callCount += 1;
      const result = await originalReadConsistentRefusedArtifact(...callArgs);
      if (!raced && callCount === 4) {
        raced = true;
        await forgeOffline(value.root, value.reviewer.endpointId);
        reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);
      }
      return result;
    });

    let result;
    try {
      result = await redeliverBusMessage(value.root, {
        endpointId: value.implementer.endpointId,
        clientTaskId: value.implementerTaskId,
        predecessorThreadId: first.threadId,
        refusedEntryHash: parkEntry.entryHash,
      });
    } finally {
      spy.mockRestore();
    }

    // Publication completed cleanly despite the mid-flight retirement -- the
    // retiredAt check ran and passed BEFORE the race, so it never fires here,
    // and nothing downstream re-checks it (per the ruling).
    expect(result.replaySource).toBe("none");
    expect(result.toEndpoint).toBe(value.reviewer.endpointId);
    if (!reviewer2) throw new Error("race did not fire");

    // The successor's mailbox has no pointer for this message yet (it was
    // written into the now-retired original reviewer's mailbox instead) --
    // reconcileEndpointMailbox must rebuild it from the entry on this poll.
    const successorMailboxBefore = join(value.root, ".story", "bus", "mailboxes", reviewer2.endpointId);
    expect((await readdir(successorMailboxBefore).catch(() => [])).some((name) => /^\d{12}-.*\.json$/.test(name))).toBe(false);

    const polled = await pollBus(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
    });
    expect(polled.messages.map((envelope) => envelope.message.messageId)).toContain(result.messageId);
    expect((await readdir(successorMailboxBefore)).some((name) => /^\d{12}-.*\.json$/.test(name))).toBe(true);
  });

  it("prevents duplication via the marker alone: two different idempotencyKey values racing the same refusedEntryHash still produce exactly one successor (ISS-953 fix step 14, test vi)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s14-vi");

    const buildInput = (idempotencyKey: string) => ({
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice" as const,
      predecessorThreadId: threadId,
      predecessorRelation: "hop_cap_successor" as const,
      refusedEntryHash: parkEntry.entryHash,
      messageKind: "reply" as const,
      severity: "medium" as const,
      body: "One more check needed before this can close.",
      refs: {},
      idempotencyKey,
    });

    const [a, b] = await Promise.all([
      sendBusMessage(value.root, buildInput("s14-vi-key-a")),
      sendBusMessage(value.root, buildInput("s14-vi-key-b")),
    ]);
    expect(a.threadId).toBe(b.threadId);
    expect(a.messageId).toBe(b.messageId);

    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    expect(await readdir(markerDir)).toEqual([`${parkEntry.entryHash}.json`]);
  });

  it("reports the successor message's own recorded recipient at createHopCapSuccessorThread's marker-hit branch, not this call's freshly resolved peer (ISS-953 fix step 11, security)", async () => {
    // The marker-hit branch answers directly from an ALREADY-EXISTING,
    // already-verified successor without creating anything new. toEndpointId is
    // resolved fresh for THIS call's own peer lookup; if the original recipient
    // was replaced by succession between the successor's creation and this
    // later marker-hit call, toEndpointId now names the NEW peer while the
    // successor message's own `to` field still names whoever it was actually
    // addressed to at creation time. Reporting the fresh one describes a
    // delivery that never happened. Reached (rather than
    // redeliverBusMessage's own already-correct lock-free fast path) by using
    // a SECOND, different idempotencyKey directly against sendBusMessage, which
    // collides EEXIST on the existing marker inside createHopCapSuccessorThread
    // under lock -- the same shape as test vi, but sequenced (not raced) around
    // a succession so the two calls' resolved peers genuinely diverge.
    //
    // The sender/recipient roles are the reverse of parkOverCap's (implementer
    // sends, reviewer receives): the implementer fixture endpoint is
    // surface "codex_desktop", whose liveness is unconditionally "unknown"
    // (endpoints.ts), so it can never be positively proven offline and
    // replaced. Only the claude_cli reviewer endpoint can stand in for the
    // "recipient later replaced by succession" role forgeOffline needs.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first0 = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      severity: "medium",
      body: "Investigate the recovery boundary.",
      refs: { issue: issueId },
      idempotencyKey: "s11-mh-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first0.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s11-mh-ack" },
      idempotencyKey: "s11-mh-ack",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first0.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      idempotencyKey: "s11-mh-over-cap",
    });
    expect(parked).toMatchObject({ parked: true });
    const parkEntry = (await foldBusThread(value.root, first0.threadId)).entries.at(-1)!;
    expect(parkEntry).toMatchObject({ type: "state", payload: { trigger: "hop_cap", byEndpoint: value.implementer.endpointId } });

    const buildInput = (idempotencyKey: string) => ({
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadKind: "issue_notice" as const,
      predecessorThreadId: first0.threadId,
      predecessorRelation: "hop_cap_successor" as const,
      refusedEntryHash: parkEntry.entryHash,
      messageKind: "reply" as const,
      severity: "medium" as const,
      body: "One more check needed before this can close.",
      refs: {},
      idempotencyKey,
    });

    const first = await sendBusMessage(value.root, buildInput("s11-marker-hit-recipient-key-a"));
    expect(first.toEndpoint).toBe(value.reviewer.endpointId);

    await forgeOffline(value.root, value.reviewer.endpointId);
    await replaceWithSuccessor(value.root, value.reviewer.endpointId, "claude-task-reviewer-successor-s11");

    const second = await sendBusMessage(value.root, buildInput("s11-marker-hit-recipient-key-b"));
    expect(second.threadId).toBe(first.threadId);
    expect(second.messageId).toBe(first.messageId);
    expect(second.toEndpoint).toBe(value.reviewer.endpointId);
  });

  it("blocks ship on a critical hop-cap-triggered question refusal (ineligible for redelivery: not issue_notice), and clears once resolved directly from parked (ISS-953 fix step 14, test vii)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "critical");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      messageKind: "question",
      severity: "critical",
      body: "Can the release boundary lose critical state?",
      refs: { issue: issueId },
      idempotencyKey: "s14-vii-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      idempotencyKey: "s14-vii-ack",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      messageKind: "reply",
      severity: "critical",
      refs: { issue: issueId },
      body: "Escalating further before this can close.",
      idempotencyKey: "s14-vii-second-over-cap",
    });
    expect(parked).toMatchObject({ parked: true });
    // ISS-953 Codex round 2 finding #5: this thread is "question", not
    // issue_notice -- nextActionForPark must not offer redeliver guidance for
    // a park it cannot itself satisfy. The redeliverBusMessage call just below
    // proves the same ineligibility from the OTHER side (the write site
    // rejects it); this proves nextActionForPark already knew not to dangle
    // that guidance in front of a caller in the first place.
    expect(parked.nextAction).toBeNull();
    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;
    expect(parkEntry.payload.trigger).toBe("hop_cap");

    await expect(redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: first.threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "invalid_input" });

    const blocked = await checkBusShip(value.root);
    expect(blocked.clear).toBe(false);
    expect(blocked.blockers.join("\n")).toMatch(/unresolved critical Bus refusal/);

    await updateBusThread(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      action: "resolve",
      resolution: "Superseded by an evidenced resolution",
      evidence: { ciRun: "s14-vii-resolved" },
    });
    expect(await checkBusShip(value.root)).toEqual({ clear: true, blockers: [] });
  });

  it("verifies a refusal's successor exactly one hop deep (never touching the successor's OWN refusals) and terminates on a self-referential marker rather than hanging (ISS-953 fix step 14, test ix)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s14-ix");

    const successor = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(successor.replaySource).toBe("none");

    // Booby-trap the SUCCESSOR's own redeliver-markers directory with an invalid
    // file. If resolving thread1's refusal ever folded past its immediate
    // successor into that successor's OWN refusals, this would surface as an
    // error; a clean "verified" result proves the walk stayed exactly one hop.
    const successorMarkerDir = join(value.root, ".story", "bus", "threads", successor.threadId, "redeliver-markers");
    await mkdir(successorMarkerDir, { recursive: true, mode: 0o700 });
    await writeFile(join(successorMarkerDir, "0".repeat(64) + ".json"), "{ not valid json", "utf-8");

    const resolved = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({
      disposition: "redelivered",
      markerState: "verified",
      successorThreadId: successor.threadId,
    });

    // Hand-corrupt thread1's OWN marker into a self-reference (a 1-cycle): keep
    // every binding correct so it passes the binding check, but point
    // successorThreadId back at thread1 itself instead of the real successor.
    const markerPath = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers", `${parkEntry.entryHash}.json`);
    const marker = JSON.parse(await readFile(markerPath, "utf-8"));
    marker.successorThreadId = threadId;
    await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");

    // Must terminate (this test's own completion within the suite's timeout is
    // part of the proof -- a recursive or cycle-following implementation would
    // hang or overflow here) with a DEFINED "invalid" outcome: thread1 fails its
    // own self-consistency check (no predecessorRelation, since it is the
    // original thread, not a hop_cap_successor of itself).
    const cyclic = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(cyclic.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports markerState 'invalid' when the successor's actual first entry is not a message, even though a matching message exists later (ISS-953 fix step 8, security)", async () => {
    // verifiedSuccessorState checked successorFold.messages[0], not the
    // successor's actual first IMMUTABLE entry. The core fold loop accepts a
    // "wake" entry without touching state or messages at all, so a successor
    // whose real seq-1 entry is a wake (hand-inserted here, since no production
    // code ever writes one to a hop_cap_successor thread) followed by the
    // genuinely matching message at seq 2 would report messages[0] as that
    // later message and verify -- even though the thread's actual first entry
    // was never checked against the artifact.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s8-wake-first");
    const real = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(real.replaySource).toBe("none");

    const resolvedBefore = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolvedBefore.refusals[0]).toMatchObject({ disposition: "redelivered", markerState: "verified" });

    const entriesDir = join(value.root, ".story", "bus", "threads", real.threadId, "entries");
    const originalFilename = (await readdir(entriesDir))[0]!;
    const originalPath = join(entriesDir, originalFilename);
    const originalEntry = JSON.parse(await readFile(originalPath, "utf-8"));
    const threadRecord = JSON.parse(await readFile(join(value.root, ".story", "bus", "threads", real.threadId, "thread.json"), "utf-8"));

    const unsignedWake = {
      schema: "storybloq-bus-entry/v2",
      entryId: randomUUID(),
      threadId: real.threadId,
      seq: 1,
      type: "wake",
      prevHash: threadRecord.threadHash,
      payload: {
        wakeId: randomUUID(),
        endpointId: value.reviewer.endpointId,
        attempt: 1,
        batchCursor: 0,
        action: "requested",
      },
      createdAt: new Date().toISOString(),
      entryHash: "0".repeat(64),
    };
    unsignedWake.entryHash = hashWithoutKey(unsignedWake, "entryHash");

    const shiftedMessage = { ...originalEntry, seq: 2, prevHash: unsignedWake.entryHash, entryHash: "0".repeat(64) };
    shiftedMessage.entryHash = hashWithoutKey(shiftedMessage, "entryHash");

    await writeFile(join(entriesDir, "000001-wake-" + unsignedWake.entryId + ".json"), JSON.stringify(unsignedWake, null, 2) + "\n", "utf-8");
    await writeFile(join(entriesDir, "000002-message-" + originalEntry.entryId + ".json"), JSON.stringify(shiftedMessage, null, 2) + "\n", "utf-8");
    await unlink(originalPath);

    // Sanity: the tampered successor's core fold is still "verified" integrity
    // (a wake entry is accepted silently) -- this test is meaningless if the
    // core fold itself already rejects the thread on other grounds.
    const tamperedSuccessorFold = await foldBusThread(value.root, real.threadId);
    expect(tamperedSuccessorFold.integrity).toBe("verified");
    expect(tamperedSuccessorFold.messages[0]).toMatchObject({ kind: "reply" });

    const resolvedAfter = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolvedAfter.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports markerState 'invalid' when the successor thread's createdByEndpoint disagrees with its own first message's sender (ISS-953 Codex round 2 finding #3, security, authorship binding part 1)", async () => {
    // Every check before this one verifies the successor's STRUCTURE and
    // CONTENT self-consistently against the marker and the artifact, but
    // nothing tied WHO produced it back to the original sender. A thread
    // record and first message satisfying every earlier check can still be
    // forged directly on disk, bypassing createHopCapSuccessorThread's own
    // in-lock authorization entirely. This is the cheaper, purely structural
    // half of that binding: the thread record's own createdByEndpoint must at
    // least agree with the first message's own recorded sender -- a forged
    // thread record and a forged first message written independently need not
    // agree with each other by accident.
    //
    // createdByEndpoint itself is deliberately left as the GENUINE creator
    // (value.reviewer) here, tampering only the first message's `from`: if
    // createdByEndpoint were ALSO changed to the same unrelated endpoint (as
    // an earlier draft of this test did), the chain-reachability check below
    // would independently reject the tamper too, since that endpoint's own
    // chain would not reach marker.originalByEndpoint either -- silently
    // passing even with THIS test's own check removed, and proving nothing
    // about it specifically. Leaving createdByEndpoint genuine keeps its own
    // chain trivially reaching marker.originalByEndpoint (itself), so only
    // the structural agreement check under test can catch this tamper.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s3-creator-mismatch");
    const real = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(real.replaySource).toBe("none");

    const resolvedBefore = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolvedBefore.refusals[0]).toMatchObject({ disposition: "redelivered", markerState: "verified" });

    // Tamper the first message's `from` alone, to an endpoint that genuinely
    // exists (value.implementer) but is not the thread's real creator --
    // createdByEndpoint is left untouched (still value.reviewer), so the two
    // now disagree. `to` must flip to reviewer too: the genuine message is
    // FROM reviewer TO implementer, and leaving `to` as implementer would
    // make from === to, which the core fold's own message-direction check
    // already rejects on its own, for an unrelated reason.
    const entriesDir = join(value.root, ".story", "bus", "threads", real.threadId, "entries");
    const entryFilename = (await readdir(entriesDir))[0]!;
    const entryPath = join(entriesDir, entryFilename);
    const rawEntry = JSON.parse(await readFile(entryPath, "utf-8"));
    rawEntry.payload.from.endpointId = value.implementer.endpointId;
    rawEntry.payload.to = value.reviewer.endpointId;
    rawEntry.entryHash = "0".repeat(64);
    rawEntry.entryHash = hashWithoutKey(rawEntry, "entryHash");
    await writeFile(entryPath, JSON.stringify(rawEntry, null, 2) + "\n", "utf-8");

    // Sanity: the tampered successor's own core fold is still "verified"
    // integrity, and createdByEndpoint genuinely still disagrees with the
    // tampered sender -- this test is meaningless if the core fold itself
    // already rejects the thread on other grounds, or if both happen to
    // agree after the tamper.
    const tamperedSuccessorFold = await foldBusThread(value.root, real.threadId);
    expect(tamperedSuccessorFold.integrity).toBe("verified");
    expect(tamperedSuccessorFold.thread.createdByEndpoint).toBe(value.reviewer.endpointId);
    expect((tamperedSuccessorFold.entries[0] as { type: "message"; payload: { from: { endpointId: string } } }).payload.from.endpointId)
      .toBe(value.implementer.endpointId);

    const resolvedAfter = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolvedAfter.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports markerState 'invalid' when the successor's agreed-upon creator has no succession chain reaching the marker's original sender (ISS-953 Codex round 2 finding #3, security, authorship binding part 2)", async () => {
    // The realistic forgery is COHERENT, not inconsistent: an attacker who
    // controls the filesystem sets createdByEndpoint and the first message's
    // own `from` to the SAME endpoint (exactly what createHopCapSuccessorThread
    // itself always does for a genuine creation), so the structural agreement
    // check in the test above passes. What must still catch this is the
    // second half of authorship binding: that agreed-upon creator's own
    // succession chain must reach marker.originalByEndpoint -- the same
    // endpointAddressees check createHopCapSuccessorThread itself enforces at
    // creation time, which a direct-to-disk forgery never went through.
    // value.implementer has no succession relationship to value.reviewer (the
    // dropped message's real original sender) in this fixture, so it is a
    // valid stand-in for an unrelated forger.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s3-chain-mismatch");
    const real = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(real.replaySource).toBe("none");

    const resolvedBefore = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolvedBefore.refusals[0]).toMatchObject({ disposition: "redelivered", markerState: "verified" });

    const threadPath = join(value.root, ".story", "bus", "threads", real.threadId, "thread.json");
    const rawThread = JSON.parse(await readFile(threadPath, "utf-8"));
    rawThread.createdByEndpoint = value.implementer.endpointId;
    rawThread.threadHash = "0".repeat(64);
    rawThread.threadHash = hashWithoutKey(rawThread, "threadHash");
    await writeFile(threadPath, JSON.stringify(rawThread, null, 2) + "\n", "utf-8");

    const entriesDir = join(value.root, ".story", "bus", "threads", real.threadId, "entries");
    const entryFilename = (await readdir(entriesDir))[0]!;
    const entryPath = join(entriesDir, entryFilename);
    const rawEntry = JSON.parse(await readFile(entryPath, "utf-8"));
    // The genuine message is FROM reviewer TO implementer. Flipping only
    // `from` to implementer would make from === to (both participants, but
    // identical), which the core fold's own message-direction check already
    // rejects -- flip `to` to reviewer as well so the entry stays a
    // structurally valid message between the thread's two real participants,
    // isolating this test to the authorship check alone.
    rawEntry.payload.from.endpointId = value.implementer.endpointId;
    rawEntry.payload.to = value.reviewer.endpointId;
    rawEntry.prevHash = rawThread.threadHash;
    rawEntry.entryHash = "0".repeat(64);
    rawEntry.entryHash = hashWithoutKey(rawEntry, "entryHash");
    await writeFile(entryPath, JSON.stringify(rawEntry, null, 2) + "\n", "utf-8");

    const tamperedSuccessorFold = await foldBusThread(value.root, real.threadId);
    expect(tamperedSuccessorFold.integrity).toBe("verified");
    // createdByEndpoint and the first message's from now agree (both
    // implementer), so the structural check above is satisfied -- only the
    // chain-reachability check can still catch this.
    expect(tamperedSuccessorFold.thread.createdByEndpoint).toBe(value.implementer.endpointId);
    expect((tamperedSuccessorFold.entries[0] as { type: "message"; payload: { from: { endpointId: string } } }).payload.from.endpointId)
      .toBe(value.implementer.endpointId);

    const resolvedAfter = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolvedAfter.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "invalid" });
  });

  it("reports refusal artifactStatus 'corrupt' when the park entry's own droppedMessage.severity diverges from the resolved artifact's (ISS-953 fix step 8, security)", async () => {
    // readRefusedArtifact hash-verifies the artifact against its OWN filename,
    // so tampering the artifact's content is caught. It says nothing about
    // whether the ENTRY's own droppedMessage.{messageKind,severity} -- stored
    // separately, inside the hash-chained entry log -- still agrees with the
    // artifact's copy of the same facts. The ship gate reads
    // droppedMessage.severity directly, never touching the artifact; a
    // filesystem-level tamperer who recomputes the entry's own entryHash can
    // make the two diverge undetected unless readConsistentRefusedArtifact's
    // cross-check exists.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s8-severity-mismatch");
    expect(parkEntry.payload.droppedMessage.severity).toBe("medium");

    const entriesDir = join(value.root, ".story", "bus", "threads", threadId, "entries");
    const parkFilename = (await readdir(entriesDir)).sort().at(-1)!;
    const parkPath = join(entriesDir, parkFilename);
    const rawEntry = JSON.parse(await readFile(parkPath, "utf-8"));
    rawEntry.payload.droppedMessage.severity = "critical";
    rawEntry.entryHash = "0".repeat(64);
    rawEntry.entryHash = hashWithoutKey(rawEntry, "entryHash");
    await writeFile(parkPath, JSON.stringify(rawEntry, null, 2) + "\n", "utf-8");

    // Sanity: core fold integrity is untouched by this tamper (the entryHash
    // was correctly recomputed) -- this test is meaningless if the core fold
    // itself already rejects the thread on other grounds.
    const tamperedFold = await foldBusThread(value.root, threadId);
    expect(tamperedFold.integrity).toBe("verified");

    const resolved = await foldBusThread(value.root, threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "none", artifactStatus: "corrupt" });
  });

  it("redelivers a fresh hop-cap park through redeliverBusMessage directly, marking replaySource 'none' (ISS-953 fix step 12)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-fresh");

    const result = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(result).toMatchObject({ replaySource: "none", replayed: false, parked: false });
    expect(result.messageId).not.toBeNull();
    expect(result.threadId).not.toBe(threadId);

    const markerPath = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers", `${parkEntry.entryHash}.json`);
    const marker = JSON.parse(await readFile(markerPath, "utf-8"));
    expect(marker).toMatchObject({ predecessorThreadId: threadId, successorThreadId: result.threadId });
  });

  it("defers a same-caller repeat call to sendBusMessage's own receipt lookup, never the marker fast-path (ISS-953 fix step 12)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-repeat");

    const input = {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    };
    const fresh = await redeliverBusMessage(value.root, input);
    expect(fresh.replaySource).toBe("none");

    // The marker is now genuinely "verified" (the successor from the fresh call
    // above landed), so a caller who did NOT already hold the receipt would hit the
    // marker fast-path here. This caller DOES hold it -- the same reviewer endpoint,
    // same derived key -- so it must defer to sendBusMessage's own receipt replay
    // instead, per fix step 12's caller-receipt gate.
    const repeat = await redeliverBusMessage(value.root, input);
    expect(repeat).toMatchObject({ replaySource: "receipt", replayed: true, threadId: fresh.threadId, messageId: fresh.messageId });

    // (ISS-953 fix step 14 test ii): exactly one successor thread exists and
    // exactly one marker file names it, regardless of how the repeat was answered.
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    expect(await readdir(markerDir)).toEqual([`${parkEntry.entryHash}.json`]);
    const allThreads = await readdir(join(value.root, ".story", "bus", "threads"));
    expect(allThreads.filter((id) => id !== threadId)).toEqual([fresh.threadId]);
  });

  it("answers from the verified marker rather than a false idempotency_conflict when the caller's own receipt at the derived redeliver key names the SAME successor thread but a DIFFERENT message (ISS-953 Codex round 3 finding #13, idempotency/hardening)", async () => {
    // redeliverIdempotencyKey's "bus-redeliver:<hash>" string is not reserved (see
    // the comment at the fix site) -- an ordinary send can legitimately use it as
    // its own caller-chosen idempotencyKey, and if it landed on the SUCCESSOR
    // thread itself, its receipt's threadId would coincidentally match
    // marker.successorThreadId too, even though its messageId is not the original
    // redelivery's. The pre-fix check (threadId alone) would misclassify this as
    // "caller already holds their own receipt", deferring to sendBusMessage's own
    // replay -- which then throws idempotency_conflict (payloadHash mismatch
    // against the artifact) instead of answering from the already-verified marker.
    //
    // REACHABILITY NOTE (same class as finding #10's): traced whether a genuine
    // succession-based caller sequence can produce this collision and it cannot,
    // for the identical structural reason -- an ordinary reply requires LITERAL
    // thread-participant membership (readThreadParticipants, no succession
    // fallback), and a thread's participants are fixed permanently to whichever
    // two literal identities existed at its creation. The caller eligible for
    // this marker-hit branch with "no receipt of its own yet" is, by definition,
    // a SUCCESSOR of whoever created the marker's successor thread -- a
    // different literal identity than either of that thread's two fixed
    // participants -- so it can never itself be the one to send the colliding
    // ordinary reply there. And the endpoint that DID create the thread already
    // holds the CORRECT (matching) receipt from that creation, so reusing its
    // own key can only ever replay identically, never diverge to a different
    // messageId (idempotency keys are permanently bound to their first payload
    // once committed). This test instead hand-forges the colliding receipt file
    // directly via writeReceipt, representing a receipt collision from an
    // unrelated concurrent redeliver attempt against a DIFFERENT, now-superseded
    // marker write, or a caller pre-registering a receipt at a value they
    // predicted (the same category of forged-but-plausible on-disk state this
    // suite already hardens against for successors and chains).
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s13-collide");

    const fresh = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(fresh.replaySource).toBe("none");

    // Succession hands the identity to reviewer2, who holds NO genuine receipt
    // yet at the derived key (receipts are scoped per endpointId) -- eligible
    // for the marker-hit fast path on its own next redeliver call, same as test
    // v, EXCEPT its own receipt store already (forged) holds an entry at that
    // exact key naming this same successor thread but a different message.
    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s13-collide";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    const paths = await resolveInitializedBusPaths(value.root);
    const collidingKey = `bus-redeliver:${parkEntry.entryHash}`;
    const collidingKeyHash = idempotencyKeyHash(reviewer2.endpointId, collidingKey);
    const collidingMessageId = randomUUID();
    expect(collidingMessageId).not.toBe(fresh.messageId);
    await writeReceipt(paths, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: reviewer2.endpointId,
      keyHash: collidingKeyHash,
      payloadHash: "0".repeat(64),
      threadId: fresh.threadId,
      toEndpoint: value.implementer.endpointId,
      messageId: collidingMessageId,
      mailboxSeq: 1,
      state: "final",
      outcome: "delivered",
      createdAt: new Date().toISOString(),
    });

    // reviewer2's redeliver call must still answer from the verified marker --
    // never fall through to a false idempotency_conflict against the colliding
    // ordinary receipt.
    const result = await redeliverBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(result).toMatchObject({ replaySource: "marker", replayed: true, threadId: fresh.threadId, messageId: fresh.messageId });
  });

  it("answers from the verified marker rather than a false idempotency_conflict when the caller's own receipt at the derived redeliver key is still 'pending', matching threadId and messageId but never having committed a publication identity (ISS-953 Codex round 3 finding #13, state clause, idempotency/hardening)", async () => {
    // Isolates the "final" requirement independently of the threadId/messageId
    // clauses tested above: a "pending" receipt (idempotency.ts's own invariant)
    // has not committed a publication identity at all, so it cannot be evidence
    // of a prior redelivery even when its threadId and messageId otherwise
    // agree with verifiedState's own message -- a pending receipt naming these
    // exact values could only arise mid-crash-recovery or via a hand-forged
    // file, not a completed prior call.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s13-pending");

    const fresh = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(fresh.replaySource).toBe("none");

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s13-pending";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    const paths = await resolveInitializedBusPaths(value.root);
    const collidingKey = `bus-redeliver:${parkEntry.entryHash}`;
    const collidingKeyHash = idempotencyKeyHash(reviewer2.endpointId, collidingKey);
    await writeReceipt(paths, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: reviewer2.endpointId,
      keyHash: collidingKeyHash,
      payloadHash: "0".repeat(64),
      threadId: fresh.threadId,
      toEndpoint: value.implementer.endpointId,
      messageId: fresh.messageId,
      mailboxSeq: 1,
      state: "pending",
      createdAt: new Date().toISOString(),
    });

    const result = await redeliverBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(result).toMatchObject({ replaySource: "marker", replayed: true, threadId: fresh.threadId, messageId: fresh.messageId });
  });

  it("answers from the verified marker rather than a false idempotency_conflict when the caller's own receipt at the derived redeliver key names a DIFFERENT thread even though it names the SAME messageId (ISS-953 Codex round 3 finding #13, threadId clause, idempotency/hardening)", async () => {
    // Isolates the threadId requirement independently of the messageId clause
    // tested above: a receipt whose messageId happens to coincide with
    // verifiedState's own message, but whose threadId names a different thread
    // entirely, is not evidence of a prior redelivery of THIS successor either
    // -- both fields must agree, not either alone. (The existing fix-step-12
    // "unrelated ordinary receipt" test already covers a threadId mismatch
    // where messageId ALSO differs; this isolates threadId specifically by
    // holding messageId fixed, which that test does not.)
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s13-threadid");

    const fresh = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(fresh.replaySource).toBe("none");

    await forgeOffline(value.root, value.reviewer.endpointId);
    const successorTaskId = "claude-task-reviewer-successor-s13-threadid";
    const reviewer2 = await replaceWithSuccessor(value.root, value.reviewer.endpointId, successorTaskId);

    const paths = await resolveInitializedBusPaths(value.root);
    const collidingKey = `bus-redeliver:${parkEntry.entryHash}`;
    const collidingKeyHash = idempotencyKeyHash(reviewer2.endpointId, collidingKey);
    await writeReceipt(paths, {
      schema: "storybloq-bus-receipt/v1",
      endpointId: reviewer2.endpointId,
      keyHash: collidingKeyHash,
      payloadHash: "0".repeat(64),
      threadId: randomUUID(),
      toEndpoint: value.implementer.endpointId,
      messageId: fresh.messageId,
      mailboxSeq: 1,
      state: "final",
      outcome: "delivered",
      createdAt: new Date().toISOString(),
    });

    const result = await redeliverBusMessage(value.root, {
      endpointId: reviewer2.endpointId,
      clientTaskId: successorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(result).toMatchObject({ replaySource: "marker", replayed: true, threadId: fresh.threadId, messageId: fresh.messageId });
  });

  it("throws corrupt on a hand-corrupted marker even when the caller already holds a valid receipt for it, before any replay is honored (ISS-953 fix step 12)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-corrupt");

    const input = {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    };
    const fresh = await redeliverBusMessage(value.root, input);
    expect(fresh.replaySource).toBe("none");

    const threadsBefore = (await readdir(join(value.root, ".story", "bus", "threads"))).sort();

    const markerPath = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers", `${parkEntry.entryHash}.json`);
    const marker = JSON.parse(await readFile(markerPath, "utf-8"));
    marker.predecessorEntryHash = "0".repeat(64);
    await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");

    // The SAME caller who just redelivered above, and who therefore already holds a
    // valid final receipt for this exact key: the corrupted marker must still be
    // caught, unconditionally, BEFORE that receipt is ever consulted.
    await expect(redeliverBusMessage(value.root, input)).rejects.toMatchObject({ code: "corrupt" });

    const threadsAfter = (await readdir(join(value.root, ".story", "bus", "threads"))).sort();
    expect(threadsAfter).toEqual(threadsBefore);
  });

  it("throws corrupt on a bindings-valid but self-referential marker, through redeliverBusMessage itself (ISS-953 fix step 12, mutant pass)", async () => {
    // A mutant on redeliverBusMessage's own state === "invalid" branch survived
    // every other named test: the hand-corrupted-marker test above corrupts a
    // BOUND field (predecessorEntryHash), which the earlier bindings check catches
    // before verifiedSuccessorState ever runs, and test ix's self-referential
    // marker is only ever read through foldBusThread, never through
    // redeliverBusMessage. Neither exercises this function's own "invalid"
    // classification. This test keeps every bound field correct and only breaks
    // the named successor's self-consistency, so verifiedSuccessorState is the
    // sole thing standing between it and a false replay.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-selfref");

    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    const markerPath = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers", `${parkEntry.entryHash}.json`);
    const marker = JSON.parse(await readFile(markerPath, "utf-8"));
    marker.successorThreadId = threadId;
    await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", "utf-8");

    await expect(redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("refuses redelivery from a caller whose succession chain does not reach the dropped message's original sender, and writes no marker (ISS-953 fix step 12)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-unauth");
    const threadsBefore = (await readdir(join(value.root, ".story", "bus", "threads"))).sort();

    await expect(redeliverBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "unauthorized" });

    await expect(readdir(join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers")))
      .rejects.toMatchObject({ code: "ENOENT" });
    // Direct proof, not just inferred from marker-directory absence (which is only
    // sound because marker-write precedes thread-creation): no new thread landed.
    expect((await readdir(join(value.root, ".story", "bus", "threads"))).sort()).toEqual(threadsBefore);
  });

  it("refuses an unauthorized caller against an ALREADY-VERIFIED marker via the fast path alone (ISS-953 fix step 12, mutant pass)", async () => {
    // A mutant bypassing redeliverBusMessage's own authorization preflight
    // survived the test above unchanged, because that test's park entry has no
    // existing marker yet: the call falls all the way through to
    // createHopCapSuccessorThread, whose OWN (intentionally redundant)
    // authorization check under lock still catches it. That redundancy is by
    // design, but it means the preflight's authorization check, by itself, was
    // unverified for the one case where it is the SOLE gate: an already-verified
    // marker, answered from the fast path that never reaches
    // createHopCapSuccessorThread at all.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-authz-hit");

    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    await expect(redeliverBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("propagates a genuine marker read failure as io_error, distinct from both absent and corrupt (ISS-953 fix step 12)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-ioerror");

    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const markerPath = join(markerDir, `${parkEntry.entryHash}.json`);
    await writeFile(markerPath, "{}", "utf-8");
    await chmod(markerPath, 0o000);

    try {
      await expect(redeliverBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      })).rejects.toMatchObject({ code: "io_error" });
    } finally {
      await chmod(markerPath, 0o600);
    }
  });

  it("refuses to create a marker through a symlinked redeliver-markers directory, and creates nothing at the symlink target (ISS-953 fix step 12, security)", async () => {
    // Goes through sendBusMessage directly with predecessorRelation:
    // "hop_cap_successor" (the same real creation path the fix step 11 happy-path
    // test uses), NOT redeliverBusMessage: redeliverBusMessage's own lock-free
    // preflight read would intercept a symlinked directory before the write path
    // was ever reached, which would make this test pass even if the write site's
    // OWN validation were missing -- this is the call path that reaches
    // createHopCapSuccessorThread's marker write with no earlier check in front
    // of it at all.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-symlink-write");

    const escapeTarget = join(value.root, "escaped-redeliver-markers");
    await mkdir(escapeTarget, { recursive: true, mode: 0o700 });
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await symlink(escapeTarget, markerDir);

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      predecessorThreadId: threadId,
      predecessorRelation: "hop_cap_successor",
      refusedEntryHash: parkEntry.entryHash,
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      refs: {},
      idempotencyKey: "s12-symlink-write-redeliver",
    })).rejects.toMatchObject({ code: "corrupt" });

    expect(await readdir(escapeTarget)).toEqual([]);
  });

  it("refuses to read a marker through a symlinked redeliver-markers directory, distinct from a genuinely absent one (ISS-953 fix step 12, security)", async () => {
    // Real successor first, via the real fixed path, so the forged marker below
    // can name a GENUINELY verifiable successor: only then does redeliverBusMessage
    // take the "answer directly from the marker" fast path rather than falling
    // through to sendBusMessage/createHopCapSuccessorThread, whose own write-site
    // validation would otherwise mask a broken read-site check the same way it
    // masked the write test above before that one was corrected.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s12-symlink-read");
    const real = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(real.replaySource).toBe("none");

    const escapeTarget = join(value.root, "escaped-redeliver-markers-read");
    await mkdir(escapeTarget, { recursive: true, mode: 0o700 });
    // Copy of the now-real, verifiable marker at the escape target: if the
    // directory-level symlink were followed, this would be read and TRUSTED.
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    const realMarker = await readFile(join(markerDir, `${parkEntry.entryHash}.json`), "utf-8");
    await rm(markerDir, { recursive: true, force: true });
    await writeFile(join(escapeTarget, `${parkEntry.entryHash}.json`), realMarker, "utf-8");
    await symlink(escapeTarget, markerDir);

    // A different caller with succession authority but no receipt of its own for
    // this key, so a correct implementation reaches the marker-hit fast path
    // (never sendBusMessage) -- exactly like fix step 14 test v.
    await forgeOffline(value.root, value.reviewer.endpointId);
    const reviewerSuccessorTaskId = "claude-task-reviewer-symlink-successor";
    const reviewerSuccessor = await replaceWithSuccessor(value.root, value.reviewer.endpointId, reviewerSuccessorTaskId);

    await expect(redeliverBusMessage(value.root, {
      endpointId: reviewerSuccessor.endpointId,
      clientTaskId: reviewerSuccessorTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("refuses redelivery when the predecessor thread's OWN directory has been replaced with a symlink, not only its redeliver-markers leaf (ISS-953 Codex round 2 finding #1, security)", async () => {
    // The two symlink tests above only replace "redeliver-markers" itself.
    // lstat never validates an INTERMEDIATE path component, so joining that
    // leaf under an unvalidated predecessorThreadId and lstat-ing only the
    // leaf silently follows the THREAD directory too, if it were ever
    // replaced with a symlink after its original, genuinely-safe Bus-managed
    // creation (publishNewThread's atomic tempDir-then-rename) -- a TOCTOU the
    // original "Bus already creates it safely at creation time" reasoning did
    // not cover.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s1-thread-symlink");

    const realThreadDir = join(value.root, ".story", "bus", "threads", threadId);
    const escapeDir = join(value.root, "escaped-thread-dir");
    // Preserve the thread's own genuine content at the escape target so
    // folding it through the symlink still succeeds and reaches
    // validatedRedeliverMarkerDir's OWN check -- a fold-level failure earlier
    // would give this test a false pass for the wrong reason.
    await exec("cp", ["-R", realThreadDir, escapeDir]);
    await rm(realThreadDir, { recursive: true, force: true });
    await symlink(escapeDir, realThreadDir);

    await expect(redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    })).rejects.toMatchObject({ code: "corrupt" });

    // Nothing was created at the escape target: the thread-directory check
    // runs before any mkdir of "redeliver-markers" is even attempted.
    expect(await readdir(escapeDir)).not.toContain("redeliver-markers");
  });

  it("fsyncs the thread directory on an EEXIST retry too, not only when this call's own mkdir created redeliver-markers (ISS-953 Codex round 2 finding #2, crash durability)", async () => {
    // The parent (thread) directory entry for "redeliver-markers" is only
    // durable once fsynced. An earlier version only synced when THIS call's
    // own mkdir succeeded (justCreated); a call that hits EEXIST because a
    // PRIOR call already created the directory has no way to know whether
    // that PRIOR call crashed before reaching its own sync -- skipping the
    // sync here on the assumption "someone already did it" is exactly the
    // assumption a crash between mkdir and sync falsifies.
    // A SEQUENTIAL second call cannot exercise the EEXIST branch at all: the
    // function's own fast path returns immediately once its initial lstat
    // finds "redeliver-markers" already present, never reaching mkdir. Only a
    // genuine race -- two calls whose initial lstat BOTH observe ENOENT before
    // either commits via mkdir -- puts one of them through EEXIST.
    //
    // ISS-953 Codex round 3 finding #18: an earlier version of this test got
    // that race from Promise.all alone, with a comment asserting Node's fs
    // promises "reliably interleave that way". That was an assumption about
    // the scheduler, not a guarantee, and it is the dangerous kind: if the
    // second call's lstat lands after the first call's mkdir, it returns
    // through the fast path, the EEXIST branch never runs, and the test PASSES
    // while no longer testing the durability property it is named for. A test
    // that silently stops testing is worse than one that fails. The explicit
    // two-party rendezvous below removes the scheduler from the question --
    // neither call can proceed past its own ENOENT probe until BOTH have
    // probed, so exactly one mkdir wins and the other is guaranteed to take
    // the EEXIST path, on every run and every machine.
    const value = await fixture();
    const paths = await resolveInitializedBusPaths(value.root);
    const issueId = await createIssue(value.root, "medium");
    const { threadId } = await parkOverCap(value, issueId, "s2-eexist-sync");

    let arrived = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const bothProbed = async (): Promise<void> => {
      arrived += 1;
      if (arrived === 2) openGate();
      await gate;
    };

    const syncSpy = vi.spyOn(io, "syncDirectory");
    try {
      const [first, second] = await Promise.all([
        validatedRedeliverMarkerDir(paths, threadId, { create: true, afterProbe: bothProbed }),
        validatedRedeliverMarkerDir(paths, threadId, { create: true, afterProbe: bothProbed }),
      ]);
      // Proves both calls reached the seam at all: afterProbe fires for BOTH
      // calls immediately after the existence probe and strictly before the
      // dirExists branch, so a fast-path call reaches the barrier exactly
      // like a slow-path one -- arrived === 2 does not distinguish that.
      // Holding the first call here until both have arrived is what forces
      // both probes to observe absence before either commits via mkdir,
      // which is what guarantees exactly one mkdir lands on EEXIST recovery.
      expect(arrived).toBe(2);
      expect(first).not.toBeNull();
      expect(second).toBe(first);
      // Both the mkdir winner AND the EEXIST loser must sync: neither can
      // assume the other has (or will) durably persist the directory entry.
      expect(syncSpy).toHaveBeenCalledTimes(2);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it("takes the fast path and syncs NOTHING when its probe lands after another call already created the directory -- the interleaving the pre-#18 Promise.all shape could silently land on (ISS-953 Codex round 3 finding #18, test reliability)", async () => {
    // This is the other half of #18's proof. The barrier test above pins that
    // BOTH calls sync when both probe before either mkdir. This one pins what
    // happens under the OPPOSITE interleaving -- the one the old Promise.all
    // test assumed could not occur -- and shows it is observably different:
    // the late call returns through the fast path, never reaches mkdir, and
    // syncs nothing at all.
    //
    // Together the two tests are the demonstration the racy shape needed: the
    // old test asserted exactly 2 syncs, and 2 is correct for one interleaving
    // and wrong for the other, with nothing in the old test forcing which one
    // ran. It was not merely fragile, it was asserting a scheduling outcome.
    // Nothing here depends on scheduling: the calls are strictly sequential.
    const value = await fixture();
    const paths = await resolveInitializedBusPaths(value.root);
    const issueId = await createIssue(value.root, "medium");
    const { threadId } = await parkOverCap(value, issueId, "s18-fastpath");

    const first = await validatedRedeliverMarkerDir(paths, threadId, { create: true });
    expect(first).not.toBeNull();

    // Spy installed only AFTER the directory exists, so the count below is the
    // late call's own behaviour alone, uncontaminated by the creating call.
    const syncSpy = vi.spyOn(io, "syncDirectory");
    try {
      const second = await validatedRedeliverMarkerDir(paths, threadId, { create: true });
      expect(second).toBe(first);
      expect(syncSpy).toHaveBeenCalledTimes(0);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it("READ: a forged marker reached through the post-return directory swap is classified 'pending' by verifiedSuccessorState and never trusted (ISS-953 Codex round 3 finding #17, security, executed not inferred)", async () => {
    // Per the pen's ruling: the paths.ts residual note is a verification
    // artifact making an unverified claim about the READ side specifically,
    // and nobody had executed the escape it describes. This test DOES, and
    // pins the result -- the swap reaches the forged file (the escape itself
    // is real and stays open by design, see paths.ts), but its content is
    // independently re-verified against real on-disk successor-thread state
    // and never trusted or acted on. This is the narrower, safer half of
    // ISS-999; the CREATE half below is the genuinely exploitable one and is
    // now closed for its silence by store.ts's post-write verification.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s17-escape");

    // Genuine first redelivery, UNINSTRUMENTED -- creates the real marker and
    // redeliver-markers directory exactly as production would.
    const first = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(first.replaySource).toBe("none");

    const legitimateParent = join(value.root, ".story", "bus", "threads", threadId);
    const escapeDir = join(value.root, "escaped-redeliver-markers-17");
    await mkdir(escapeDir, { recursive: true, mode: 0o700 });

    // SAFETY, non-negotiable: both paths verified inside the fixture tmpdir
    // via realpath (not raw string prefix) BEFORE any destructive op, because
    // of the macOS /tmp -> /private/tmp symlink (L-055 instance 5) -- a naive
    // string check can pass on a path that is not actually where it looks.
    const realRoot = await realpath(value.root);
    const realLegitimateParent = await realpath(legitimateParent);
    const realEscapeDir = await realpath(escapeDir);
    if (!realLegitimateParent.startsWith(realRoot) || !realEscapeDir.startsWith(realRoot)) {
      throw new Error("SAFETY ABORT: escape target resolved outside the fixture tmpdir");
    }

    // The attacker's forged marker at the escape target. originalByEndpoint
    // is read from the REAL park entry, not guessed or randomized -- the
    // residual's own threat model grants the attacker write access inside
    // this checkout, which means read access to the same files too, so a
    // forgery that used a wrong value here would be testing my own test's
    // sloppiness, not the actual defense. Only successorThreadId is
    // necessarily fabricated (a genuine one would require forging an entire
    // real, hash-chained successor thread, which is the actual question).
    const genuinePredecessor = await foldBusThread(value.root, threadId);
    const genuineParkEntry = genuinePredecessor.entries.find((entry) => entry.entryHash === parkEntry.entryHash);
    if (!genuineParkEntry || genuineParkEntry.type !== "state" || genuineParkEntry.payload.action !== "park") {
      throw new Error("test setup invariant violated: park entry not found on refold");
    }
    const forgedMarker = {
      schema: "storybloq-bus-redeliver-marker/v1",
      predecessorThreadId: threadId,
      predecessorEntryHash: parkEntry.entryHash,
      originalByEndpoint: genuineParkEntry.payload.byEndpoint,
      successorThreadId: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      join(escapeDir, `${parkEntry.entryHash}.json`),
      JSON.stringify(forgedMarker, null, 2) + "\n",
      "utf-8",
    );

    let interceptedCalls = 0;
    const real = pathsModule.validatedRedeliverMarkerDir;
    const spy = vi
      .spyOn(pathsModule, "validatedRedeliverMarkerDir")
      .mockImplementationOnce(async (callPaths, callThreadId, opts) => {
        // L-055 instance 6: assert WHICH invocation this is before trusting
        // anything -- a spy on a shared cross-module function can be hit by
        // an unrelated call, and a swap injected into the wrong call would
        // produce a plausible-looking WRONG answer feeding a security claim.
        // This must be the READ variant (create: false) -- the second
        // redeliverBusMessage call's own marker-check, for this exact thread.
        expect(callThreadId).toBe(threadId);
        expect(opts).toMatchObject({ create: false });
        interceptedCalls += 1;

        const dir = await real(callPaths, callThreadId, opts);
        expect(dir).not.toBeNull();
        const realDirPath = await realpath(dir!);
        if (!realDirPath.startsWith(realRoot)) {
          throw new Error("SAFETY ABORT: validated dir resolved outside the fixture tmpdir");
        }

        // THE SWAP: exactly the window paths.ts's residual note describes --
        // AFTER validatedRedeliverMarkerDir's own validation has completed
        // and returned, BEFORE the caller's subsequent join+read ever runs.
        await rm(dir!, { recursive: true, force: true });
        await symlink(escapeDir, dir!, "dir");

        return dir;
      });

    // Observed independently of the resolved/rejected outcome, so the
    // classification the forged marker actually received is a FACT rather
    // than an inference from downstream replay behaviour (which turns out to
    // be confounded by the caller's own prior-receipt: see the disposition).
    let observedVerifiedStatus: string | undefined;
    const realVerifiedSuccessorState = fold.verifiedSuccessorState;
    const verifiedSpy = vi.spyOn(fold, "verifiedSuccessorState").mockImplementationOnce(async (...args) => {
      const result = await realVerifiedSuccessorState(...args);
      observedVerifiedStatus = result.status;
      return result;
    });

    let outcome:
      | { kind: "resolved"; value: Awaited<ReturnType<typeof redeliverBusMessage>> }
      | { kind: "rejected"; error: unknown };
    try {
      const second = await redeliverBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      });
      outcome = { kind: "resolved", value: second };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
      verifiedSpy.mockRestore();
    }

    expect(interceptedCalls).toBe(1);

    // THE ASSERTION, unconfounded: this is what actually answers whether the
    // forged marker's content was trusted. It does NOT depend on whether
    // outcome resolved or rejected -- this test's second redeliverBusMessage
    // call reuses the same caller as the genuine first call above, which can
    // itself replay from ITS OWN prior receipt once the marker is correctly
    // classified as unverified (see the CREATE test below for the
    // unconfounded, no-prior-receipt scenario). What is unconfounded here is
    // the classification itself: a forged marker naming a successorThreadId
    // that does not resolve to any real, hash-chained thread on disk can only
    // ever be "pending" or "invalid", never "verified" -- proving content-level
    // impersonation requires forging an entire successor thread, not one file.
    expect(observedVerifiedStatus).toBe("pending");
    // The forged successorThreadId must never appear in a resolved result,
    // regardless of which fallback path answered the call.
    if (outcome.kind === "resolved") {
      expect((outcome.value as { threadId?: string }).threadId).not.toBe(forgedMarker.successorThreadId);
    }
  });

  it("CREATE: a first-ever marker write redirected by a post-return directory swap is caught deterministically, never reported as success (ISS-999, security)", async () => {
    // Companion to the READ test above. Finding #17 named both "reads or
    // creates the marker" -- this covers CREATE, and this is the half that
    // was genuinely exploitable: executed once as fact-finding (recorded in
    // ISS-999), it showed durableCreate's own write silently followed the
    // swap, landing the LEGITIMATE marker in an attacker directory while
    // redeliverBusMessage reported complete success (replaySource:"none",
    // no error) -- a real successor thread got created with no signal the
    // marker meant to guard its uniqueness was never where it should be.
    //
    // The very first redelivery attempt for a park entry is the scenario:
    // no marker directory exists yet and no receipt can exist either, so
    // nothing short-circuits before createHopCapSuccessorThread's own
    // validatedRedeliverMarkerDir call (create: true) and durableCreate.
    //
    // store.ts's fix does not close the underlying race (accepted by design,
    // see paths.ts -- Node has no path-relative-to-fd operation, so a fresh
    // join+open after any validated directory return necessarily re-resolves
    // symlinks at every intermediate component again). It closes the
    // SILENCE: a post-write lstat on the exact validated directory string
    // (never recomputed from a possibly-swapped handle) deterministically
    // catches a PERSISTENT redirect -- the practical case, since a
    // swap-then-immediately-revert achieves nothing for an attacker.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s17-escape-create");

    const legitimateParent = join(value.root, ".story", "bus", "threads", threadId);
    const escapeDir = join(value.root, "escaped-redeliver-markers-17-create");
    await mkdir(escapeDir, { recursive: true, mode: 0o700 });

    const realRoot = await realpath(value.root);
    const realLegitimateParent = await realpath(legitimateParent);
    const realEscapeDir = await realpath(escapeDir);
    if (!realLegitimateParent.startsWith(realRoot) || !realEscapeDir.startsWith(realRoot)) {
      throw new Error("SAFETY ABORT: escape target resolved outside the fixture tmpdir");
    }

    let createCallIntercepted = false;
    let readCallPassedThrough = 0;
    const real = pathsModule.validatedRedeliverMarkerDir;
    const spy = vi.spyOn(pathsModule, "validatedRedeliverMarkerDir").mockImplementation(async (callPaths, callThreadId, opts) => {
      if (!opts.create) {
        // The read-check at the TOP of redeliverBusMessage, on a park entry
        // that has never been redelivered: nothing exists yet, nothing to
        // swap. Pass through unmodified so the real absent-marker fallthrough
        // (the scenario under test) is reached genuinely, not simulated.
        readCallPassedThrough += 1;
        return real(callPaths, callThreadId, opts);
      }
      // L-055 instance 6: this must be the CREATE call, exactly once, for
      // this thread, from createHopCapSuccessorThread's own marker write.
      expect(callThreadId).toBe(threadId);
      createCallIntercepted = true;

      const dir = await real(callPaths, callThreadId, opts);
      const realDirPath = await realpath(dir!);
      if (!realDirPath.startsWith(realRoot)) {
        throw new Error("SAFETY ABORT: validated dir resolved outside the fixture tmpdir");
      }

      // THE SWAP, on the CREATE call this time: the directory has just been
      // legitimately created and validated by the real implementation, then
      // swapped in the window between that validation returning and the
      // caller's own durableCreate ever running.
      await rm(dir!, { recursive: true, force: true });
      await symlink(escapeDir, dir!, "dir");

      return dir;
    });

    let outcome:
      | { kind: "resolved"; value: Awaited<ReturnType<typeof redeliverBusMessage>> }
      | { kind: "rejected"; error: unknown };
    try {
      const result = await redeliverBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      });
      outcome = { kind: "resolved", value: result };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
    }

    expect(readCallPassedThrough).toBeGreaterThanOrEqual(1);
    expect(createCallIntercepted).toBe(true);

    // THE ASSERTION: the caller must never see success. Before the fix, this
    // resolved with replaySource:"none" -- a genuine, silent success.
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      expect((outcome.error as BusError).message).toContain("was replaced during the write");
    }

    // The race itself is NOT expected to be closed -- the write still lands
    // in the escape directory, exactly as the fix's own comment says it
    // must (a deterministic post-check, not a prevention). What must be
    // true is that the caller is told, not silently handed success.
    const escapeContents = await readdir(escapeDir).catch(() => [] as string[]);
    const markerFilename = `${parkEntry.entryHash}.json`;
    expect(escapeContents).toContain(markerFilename);
  });

  it("rejects a directory swapped to a symlink between inspection and open, even on the degraded (no-O_NOFOLLOW) path (ISS-953 Codex round 3 finding #3 residual, order item 9, security)", async () => {
    // openDirNoFollow (paths.ts) is validatedRedeliverMarkerDir's atomic
    // replacement for a bare lstat, mirroring io.ts's openReadNoFollow for
    // directories instead of files. Forcing noFollowFlag to 0 simulates a
    // platform lacking kernel-level O_NOFOLLOW enforcement -- the portable
    // lstat + dev/ino identity check floor must still catch a directory
    // swapped for a symlink in the window between the lstat and the open,
    // exactly the same defense readTextNoFollow/readJsonNoFollow already
    // prove for files (deletion-evidence.test.ts).
    const value = await fixture();
    const real = join(value.root, "nofollow-dir-real");
    const other = join(value.root, "nofollow-dir-other");
    await mkdir(real, { mode: 0o700 });
    await mkdir(other, { mode: 0o700 });

    await expect(openDirNoFollow(real, "test directory", 0, async () => {
      await rm(real, { recursive: true, force: true });
      await symlink(other, real, "dir");
    })).rejects.toMatchObject({ code: "corrupt" });
  });

  it("accepts a genuine directory and rejects a genuine symlink through openDirNoFollow directly, on the degraded (no-O_NOFOLLOW) path too (ISS-953 Codex round 3 finding #3 residual, order item 9, security)", async () => {
    const value = await fixture();
    const real = join(value.root, "nofollow-dir-plain");
    await mkdir(real, { mode: 0o700 });
    await expect(openDirNoFollow(real, "test directory", 0)).resolves.toBeUndefined();

    const link = join(value.root, "nofollow-dir-symlink");
    await symlink(real, link, "dir");
    await expect(openDirNoFollow(link, "test directory", 0)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("translates a raw ELOOP from a directory-to-symlink swap landing between lstat and open into the documented BusError('corrupt', ...) contract, not a raw OS error (ISS-953 Codex round 4 finding #3, error handling)", async () => {
    // Distinct from the degraded-path tests above: those force noFollowFlag to 0,
    // so their swap target is followed and caught by the dev/ino identity check
    // AFTER a successful open(). This test leaves O_NOFOLLOW active (the real,
    // non-degraded default) so open() itself refuses to follow the swapped-in
    // symlink and throws a RAW ELOOP -- the exact case the pre-check's own
    // comment claims callers are "entitled to rely on" a clean BusError for, but
    // that only covered a symlink already present at lstat time.
    const value = await fixture();
    const real = join(value.root, "nofollow-dir-eloop-real");
    const other = join(value.root, "nofollow-dir-eloop-other");
    await mkdir(real, { mode: 0o700 });
    await mkdir(other, { mode: 0o700 });

    const outcome = await openDirNoFollow(real, "test directory", undefined, async () => {
      await rm(real, { recursive: true, force: true });
      await symlink(other, real, "dir");
    }).then(
      () => ({ kind: "resolved" as const }),
      (error) => ({ kind: "rejected" as const, error }),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      expect((outcome.error as BusError).message).toContain("changed during open");
    }
  });

  it("validates busRoot on the refused-directory fast path too, not only when creating it (ISS-953 Codex round 3 finding #4, security)", async () => {
    // lstat only guards the path's FINAL component. The fast path (refused
    // already exists, the common case on every call after the first) used to
    // return `dir` on nothing more than that -- never re-checking busRoot
    // itself. An attacker-controlled directory bearing its own "refused"
    // subdirectory, swapped in for the real busRoot, satisfies that fast
    // path's checks completely while redirecting every read/write.
    const value = await fixture();
    const paths = await resolveInitializedBusPaths(value.root);
    const busRootPath = join(value.root, ".story", "bus");

    const escapeTarget = join(value.root, "escaped-bus-root");
    await mkdir(join(escapeTarget, "refused"), { recursive: true, mode: 0o700 });
    await rm(busRootPath, { recursive: true, force: true });
    await symlink(escapeTarget, busRootPath);

    const fakeMessage: BusMessagePayload = {
      messageId: randomUUID(),
      from: { endpointId: value.reviewer.endpointId, client: "claude", authority: "peer_agent" },
      to: value.implementer.endpointId,
      kind: "reply",
      severity: "medium",
      body: "s4-busroot-swap",
      refs: {},
      inReplyTo: null,
      idempotencyKeyHash: "0".repeat(64),
      payloadHash: "0".repeat(64),
    };

    await expect(writeRefusedArtifact(paths, fakeMessage)).rejects.toMatchObject({ code: "corrupt" });
    // Never followed: nothing written at the escape target.
    expect(await readdir(join(escapeTarget, "refused"))).toEqual([]);
  });

  it("fsyncs busRoot on an EEXIST retry too, not only when this call's own mkdir created refused (ISS-953 Codex round 3 finding #5, crash durability)", async () => {
    // Same crash-durability gap as finding #2 above, at the independent
    // refused.ts:validatedRefusedDir site: the parent (busRoot) directory
    // entry for "refused" is only durable once fsynced, and a call that hits
    // EEXIST because a PRIOR call already created the directory has no way to
    // know whether that prior call crashed before reaching its own sync.
    // "refused" is provisioned at Bus init (paths.ts, non-layout-required,
    // same T-430 treatment as autoAttach) -- removed here to simulate an
    // existing v2 runtime that predates this feature, the actual scenario
    // validatedRefusedDir's lazy-creation path exists for; a fresh fixture's
    // pre-provisioned directory would otherwise always take the fast path
    // and never reach mkdir/EEXIST at all.
    //
    // ISS-953 Codex round 4 finding #9: this test originally raced two
    // Promise.all'd writeRefusedArtifact calls and relied on Node's fs
    // promises happening to interleave so both lstat probes landed before
    // either mkdir committed -- an assumption about the scheduler, not a
    // guarantee, and the same flaw round 3 finding #18 already fixed for the
    // marker-dir sibling (paths.ts's validatedRedeliverMarkerDir). If the
    // second call's probe landed after the first call's mkdir, it would take
    // the fast path, the EEXIST branch would never run, and this test would
    // PASS while no longer testing the durability property it is named for.
    // Replaced with the same explicit two-party rendezvous #18 used: neither
    // call proceeds past its own ENOENT probe until BOTH have probed, so
    // exactly one mkdir wins and the other is guaranteed to take the EEXIST
    // path, on every run and every machine. Calls validatedRefusedDir
    // directly (now exported for this purpose, mirroring paths.ts's
    // validatedRedeliverMarkerDir) rather than through writeRefusedArtifact,
    // so the barrier sits at the exact probe this finding is about, not one
    // layer removed from it.
    const value = await fixture();
    const paths = await resolveInitializedBusPaths(value.root);
    await rm(join(value.root, ".story", "bus", "refused"), { recursive: true, force: true });

    let arrived = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const bothProbed = async (): Promise<void> => {
      arrived += 1;
      if (arrived === 2) openGate();
      await gate;
    };

    const syncSpy = vi.spyOn(io, "syncDirectory");
    try {
      const [first, second] = await Promise.all([
        refused.validatedRefusedDir(paths, { create: true, afterProbe: bothProbed }),
        refused.validatedRefusedDir(paths, { create: true, afterProbe: bothProbed }),
      ]);
      // Proves both calls reached the seam at all: afterProbe fires for BOTH
      // calls immediately after the existence probe and strictly before the
      // dirExists branch, so a fast-path call reaches the barrier exactly
      // like a slow-path one -- arrived === 2 does not distinguish that.
      // Holding the first call here until both have arrived is what forces
      // both probes to observe absence before either commits via mkdir,
      // which is what guarantees exactly one mkdir lands on EEXIST recovery.
      expect(arrived).toBe(2);
      expect(first).not.toBeNull();
      expect(second).toBe(first);
      const busRootSyncs = syncSpy.mock.calls.filter(([dir]) => dir === paths.busRoot);
      // Both the mkdir winner AND the EEXIST loser must sync busRoot.
      expect(busRootSyncs).toHaveLength(2);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it("takes the fast path and syncs NOTHING when its probe lands after another call already created the refused directory -- the interleaving the pre-#9 Promise.all shape could silently land on (ISS-953 Codex round 4 finding #9, test reliability)", async () => {
    // The other half of #9's proof, mirroring round 3 finding #18's own
    // companion test for the marker-dir sibling exactly. The barrier test
    // above pins that BOTH calls sync when both probe before either mkdir.
    // This one pins the OPPOSITE interleaving -- the one the old Promise.all
    // test assumed could not occur -- and shows it is observably different:
    // the late call returns through the fast path, never reaches mkdir, and
    // syncs nothing at all. Nothing here depends on scheduling: the calls are
    // strictly sequential.
    const value = await fixture();
    const paths = await resolveInitializedBusPaths(value.root);
    await rm(join(value.root, ".story", "bus", "refused"), { recursive: true, force: true });

    const first = await refused.validatedRefusedDir(paths, { create: true });
    expect(first).not.toBeNull();

    // Spy installed only AFTER the directory exists, so the count below is the
    // late call's own behaviour alone, uncontaminated by the creating call.
    const syncSpy = vi.spyOn(io, "syncDirectory");
    try {
      const second = await refused.validatedRefusedDir(paths, { create: true });
      expect(second).toBe(first);
      expect(syncSpy).toHaveBeenCalledTimes(0);
    } finally {
      syncSpy.mockRestore();
    }
  });

  it("catches a refused-artifact write redirected by a post-validation swap, mirroring ISS-999's post-write verification but for writeRefusedArtifact instead of the redeliver marker (ISS-953 Codex round 4 finding #4, security)", async () => {
    // ISS-953 Codex round 5 finding #14: this spies on durableCreate (io.ts)
    // -- a genuine cross-module call (refused.ts imports it from a different
    // module), the same boundary as the syncDirectory spy just above --
    // NOT because validatedRefusedDir is unreachable (it is exported and the
    // preceding tests in this file call it directly). durableCreate is the
    // right seam because the swap this test injects (see "THE SWAP" below)
    // lands POST-VALIDATION but PRE-WRITE: after validatedRefusedDir has
    // already resolved and returned the target directory, but before the
    // real durableCreate call that actually writes to it. Spying on
    // validatedRefusedDir itself could not inject a swap at that exact
    // point, since the swap has to happen strictly between its return and
    // the write, not as part of its own execution.
    const value = await fixture();
    const paths = await resolveInitializedBusPaths(value.root);
    const escapeDir = join(value.root, "escaped-refused-4");
    await mkdir(escapeDir, { recursive: true, mode: 0o700 });

    const realRoot = await realpath(value.root);
    const realEscapeDir = await realpath(escapeDir);
    if (!realEscapeDir.startsWith(realRoot)) {
      throw new Error("SAFETY ABORT: escape target resolved outside the fixture tmpdir");
    }

    const fakeMessage: BusMessagePayload = {
      messageId: randomUUID(),
      from: { endpointId: value.reviewer.endpointId, client: "claude", authority: "peer_agent" },
      to: value.implementer.endpointId,
      kind: "reply",
      severity: "medium",
      body: "s4-r4-postwrite-swap",
      refs: {},
      inReplyTo: null,
      idempotencyKeyHash: "0".repeat(64),
      payloadHash: "0".repeat(64),
    };

    const realDurableCreate = io.durableCreate;
    const spy = vi.spyOn(io, "durableCreate").mockImplementationOnce(async (target, content) => {
      const targetDir = dirname(target as string);
      const realTargetDir = await realpath(targetDir);
      if (!realTargetDir.startsWith(realRoot)) {
        throw new Error("SAFETY ABORT: write target resolved outside the fixture tmpdir");
      }
      // THE SWAP: lands in the window between validatedRefusedDir's return
      // (already resolved into `target` by the time writeRefusedArtifact
      // calls durableCreate) and the write itself -- durableCreate's own path
      // resolution then follows the swap, landing the write in the escape
      // directory instead of the validated one, exactly the ISS-999 shape.
      await rm(targetDir, { recursive: true, force: true });
      await symlink(escapeDir, targetDir, "dir");
      await realDurableCreate(target, content);
    });

    let outcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };
    try {
      const result = await writeRefusedArtifact(paths, fakeMessage);
      outcome = { kind: "resolved", value: result };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      expect((outcome.error as BusError).message).toContain("was replaced during the write");
    }
    // The race itself is NOT expected to be closed (ISS-999 doctrine, same
    // scope limit): the write still landed in the escape directory. What must
    // be true is that the caller is told, not silently handed success.
    const escapeContents = await readdir(escapeDir);
    expect(escapeContents).toHaveLength(1);
  });

  it("catches a refused-artifact write redirected to a directory pre-populated with a hash-valid artifact, when durableCreate reports EEXIST instead of succeeding, which the OLD checks (try-block only) could not see (ISS-953 Codex round 5 finding #6, security)", async () => {
    // The finding-#4 test above swaps the directory into a FRESH escape
    // target, so durableCreate's write succeeds there and the try block's
    // own dirCheck (which used to live right after the write, still inside
    // the try) caught it. This test drives the OTHER branch: the escape
    // target is pre-populated with a hash-valid artifact BEFORE the swap, so
    // durableCreate's write attempt (following the symlink) finds an
    // existing file under that exact content-addressed name and throws
    // BusError("conflict") instead of succeeding. The OLD code's catch
    // branch only hash-verified that existing content and returned --
    // dirCheck/fileCheck were statements inside the try block, never reached
    // once durableCreate threw -- so a park committed successfully off an
    // artifact that exists only behind the swapped directory. This is the
    // exact scenario the round-5 fix moved dirCheck/fileCheck past the
    // try/catch to close.
    const value = await fixture();
    const paths = await resolveInitializedBusPaths(value.root);
    const escapeDir = join(value.root, "escaped-refused-6");
    await mkdir(escapeDir, { recursive: true, mode: 0o700 });

    const realRoot = await realpath(value.root);
    const realEscapeDir = await realpath(escapeDir);
    if (!realEscapeDir.startsWith(realRoot)) {
      throw new Error("SAFETY ABORT: escape target resolved outside the fixture tmpdir");
    }

    const fakeMessage: BusMessagePayload = {
      messageId: randomUUID(),
      from: { endpointId: value.reviewer.endpointId, client: "claude", authority: "peer_agent" },
      to: value.implementer.endpointId,
      kind: "reply",
      severity: "medium",
      body: "s6-r5-eexist-swap",
      refs: {},
      inReplyTo: null,
      idempotencyKeyHash: "0".repeat(64),
      payloadHash: "0".repeat(64),
    };

    // Precompute the exact artifact shape and hash writeRefusedArtifact will
    // derive from fakeMessage, so the escape target's pre-populated content
    // is genuinely hash-valid, not merely well-formed -- the same
    // canonicalHash/serialize pair refused.ts itself uses.
    const artifact = {
      schema: "storybloq-bus-refused-artifact/v1" as const,
      messageKind: fakeMessage.kind,
      severity: fakeMessage.severity,
      body: fakeMessage.body,
      refs: fakeMessage.refs,
    };
    const refusedPayloadHash = canonicalHash(artifact);
    await writeFile(join(escapeDir, `${refusedPayloadHash}.json`), `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");

    const realDurableCreate = io.durableCreate;
    const spy = vi.spyOn(io, "durableCreate").mockImplementationOnce(async (target, content) => {
      const targetDir = dirname(target as string);
      const realTargetDir = await realpath(targetDir);
      if (!realTargetDir.startsWith(realRoot)) {
        throw new Error("SAFETY ABORT: write target resolved outside the fixture tmpdir");
      }
      // Same swap window as the finding-#4 test above -- but the escape
      // target already holds this exact artifact's content under this exact
      // filename, so the real durableCreate call throws EEXIST/"conflict"
      // instead of succeeding.
      await rm(targetDir, { recursive: true, force: true });
      await symlink(escapeDir, targetDir, "dir");
      await realDurableCreate(target, content);
    });

    let outcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };
    try {
      const result = await writeRefusedArtifact(paths, fakeMessage);
      outcome = { kind: "resolved", value: result };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      expect((outcome.error as BusError).message).toContain("was replaced during the write");
    }
    // The race itself is NOT expected to be closed (ISS-999 doctrine, same
    // scope limit): the pre-populated content is still sitting in the
    // escape directory. What must be true is that the caller is told, not
    // silently handed success off it.
    const escapeContents = await readdir(escapeDir);
    expect(escapeContents).toHaveLength(1);
  });

  it("catches a refused artifact whose FILE (not its containing directory) is swapped for a symlink after the write lands -- the leaf-swap-only scenario fileCheck exists for, distinct from dirCheck's directory-swap shape above (ISS-953 byte-review, closing an L-055 coverage gap)", async () => {
    // The finding-#4 and finding-#6 tests above both swap the DIRECTORY
    // before or during the write, so dirCheck's lstat(dir) is the check that
    // actually fires in both. Neither constructs the shape fileCheck exists
    // for: the directory left completely alone (created once by
    // validatedRefusedDir, never touched again) and identity-valid, with only
    // the leaf FILE at the validated target path swapped for a symlink AFTER
    // the real write lands. dirCheck's lstat on `dir` cannot see a leaf-only
    // swap; only fileCheck's lstat on `target` can. Confirmed missing by
    // reverting fileCheck alone (refused.ts) and running this file's full
    // suite before this test existed: every test still passed, including the
    // finding-#6 test above, whose assertion is on dirCheck's "was replaced
    // during the write" message, not fileCheck's -- that test's directory
    // swap resolves through `dir` and throws before fileCheck is ever
    // reached, which is how this gap stayed invisible.
    const value = await fixture();
    const paths = await resolveInitializedBusPaths(value.root);

    const decoyPath = join(value.root, "leaf-swap-decoy.json");
    await writeFile(decoyPath, "{}", "utf-8");

    const realRoot = await realpath(value.root);
    const realDecoyPath = await realpath(decoyPath);
    if (!realDecoyPath.startsWith(realRoot)) {
      throw new Error("SAFETY ABORT: decoy target resolved outside the fixture tmpdir");
    }

    const fakeMessage: BusMessagePayload = {
      messageId: randomUUID(),
      from: { endpointId: value.reviewer.endpointId, client: "claude", authority: "peer_agent" },
      to: value.implementer.endpointId,
      kind: "reply",
      severity: "medium",
      body: "leaf-swap-only-filecheck",
      refs: {},
      inReplyTo: null,
      idempotencyKeyHash: "0".repeat(64),
      payloadHash: "0".repeat(64),
    };

    const realDurableCreate = io.durableCreate;
    const spy = vi.spyOn(io, "durableCreate").mockImplementationOnce(async (target, content) => {
      // No directory-level interference at all, unlike the finding-#4/#6
      // tests above -- the real write lands for real, exactly as a
      // legitimate call would. THE SWAP happens strictly AFTER that genuine
      // write completes: the leaf file at the validated target path is
      // removed and replaced with a symlink to an unrelated decoy file. The
      // directory one level up (`dir`) is never touched, so dirCheck sees a
      // completely genuine, non-symlink directory.
      await realDurableCreate(target, content);
      await rm(target as string, { force: true });
      await symlink(decoyPath, target as string);
    });

    let outcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };
    try {
      const result = await writeRefusedArtifact(paths, fakeMessage);
      outcome = { kind: "resolved", value: result };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      // The point of this test: assert on fileCheck's OWN message, not
      // dirCheck's. A prior comment in refused.ts claimed the finding-#6 test
      // above independently exercised fileCheck; it does not -- its
      // assertion is on dirCheck's "was replaced during the write" message.
      // This assertion is what actually pins fileCheck rather than implying
      // coverage that was never there.
      expect((outcome.error as BusError).message).toContain("did not land at its validated path after being written");
      expect((outcome.error as BusError).message).not.toContain("was replaced during the write");
    }
  });

  it("catches a redeliver marker overwritten with a different, schema-valid marker at the same path after the legitimate write, which the OLD lstat-only check could not see (ISS-953 Codex round 4 finding #7, security)", async () => {
    // The OLD check (a bare lstat on markerPath, same shape as the CREATE
    // test above and refused.ts's own fileCheck) only confirmed a regular,
    // non-symlink file existed at the path -- true even when that file's
    // CONTENT is a different, equally schema-valid marker. This is a
    // DIFFERENT attack shape than the CREATE test above (that one swaps the
    // directory before the write ever lands; this one leaves the directory
    // and the write alone and swaps the FILE's content afterward), so it is
    // not redundant with it. The legitimate marker is written for real, then
    // immediately overwritten in place -- same path, same file type, still a
    // schema-valid BusRedeliverMarker -- with a DIFFERENT successorThreadId,
    // simulating an external actor landing a different marker at the exact
    // validated path in the window between durableCreate's return and this
    // fix's read-back check.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s7-marker-content-swap");

    const markerFilename = `${parkEntry.entryHash}.json`;
    const forgedSuccessorThreadId = randomUUID();

    const realDurableCreate = io.durableCreate;
    const spy = vi.spyOn(io, "durableCreate").mockImplementation(async (target, content) => {
      await realDurableCreate(target, content);
      if (basename(target as string) !== markerFilename) return;
      // THE SWAP: same path, same file type (a genuine regular file, never a
      // symlink), different content -- written with ordinary writeFile, not
      // durableCreate, since durableCreate is exclusive and would reject an
      // already-existing target the way an external overwrite need not.
      const original = JSON.parse(content as string);
      const forged = { ...original, successorThreadId: forgedSuccessorThreadId };
      await writeFile(target as string, `${JSON.stringify(forged, null, 2)}\n`, "utf-8");
    });

    let outcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };
    try {
      const result = await redeliverBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      });
      outcome = { kind: "resolved", value: result };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      expect((outcome.error as BusError).message).toContain("did not land at its validated path after being written");
    }
  });

  it("does not let a persistent redeliver-markers directory swap, pre-populated with a bindings-valid forged marker, supply the successorThreadId a fresh redeliver adopts, when durableCreate reports EEXIST instead of succeeding (ISS-953 Codex round 5 finding #10, security)", async () => {
    // Structural twin of the refused.ts round-5 finding #6 test above, at the
    // marker sibling. The forged marker's BINDINGS (predecessorThreadId,
    // predecessorEntryHash, originalByEndpoint) are set to match exactly what
    // the real call will attempt to write -- those are public, predictable
    // values -- but its successorThreadId is attacker-chosen and names no
    // real thread. Before the round-5 fix, the EEXIST-recovery branch read
    // and trusted this marker without ever re-validating markerDir's
    // identity: the binding check passed (bindings match), and
    // verifiedSuccessorState's foldBusThread on the nonexistent
    // attacker-chosen thread returned BusError("not_found"), which
    // verifiedSuccessorState maps to "pending" -- not "invalid" -- so the old
    // code fell through to `successorThreadId = existing.successorThreadId`
    // and published a REAL new thread under the attacker's chosen id, never
    // the server's own pre-assigned one. The fix runs markerDirCheck before
    // either the fresh-write read-back or this EEXIST marker read, so the
    // directory swap is caught deterministically, on every call, before any
    // of that logic ever sees the forged marker's content.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s10-r5-eexist-dir-swap");

    const escapeDir = join(value.root, "escaped-redeliver-markers-10");
    await mkdir(escapeDir, { recursive: true, mode: 0o700 });
    const realRoot = await realpath(value.root);
    const realEscapeDir = await realpath(escapeDir);
    if (!realEscapeDir.startsWith(realRoot)) {
      throw new Error("SAFETY ABORT: escape target resolved outside the fixture tmpdir");
    }

    const attackerSuccessorThreadId = randomUUID();
    const forgedMarker = {
      schema: "storybloq-bus-redeliver-marker/v1" as const,
      predecessorThreadId: threadId,
      predecessorEntryHash: parkEntry.entryHash,
      originalByEndpoint: parkEntry.payload.byEndpoint,
      successorThreadId: attackerSuccessorThreadId,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(join(escapeDir, `${parkEntry.entryHash}.json`), `${JSON.stringify(forgedMarker, null, 2)}\n`, "utf-8");

    const realDurableCreate = io.durableCreate;
    const spy = vi.spyOn(io, "durableCreate").mockImplementationOnce(async (target, content) => {
      const targetDir = dirname(target as string);
      const realTargetDir = await realpath(targetDir);
      if (!realTargetDir.startsWith(realRoot)) {
        throw new Error("SAFETY ABORT: write target resolved outside the fixture tmpdir");
      }
      // Same swap window as refused.ts's round-5 finding #6 test -- the
      // escape target already holds a bindings-valid marker under this
      // exact filename, so the real durableCreate call throws
      // EEXIST/"conflict" instead of succeeding.
      await rm(targetDir, { recursive: true, force: true });
      await symlink(escapeDir, targetDir, "dir");
      await realDurableCreate(target, content);
    });

    let outcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };
    try {
      const result = await redeliverBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      });
      outcome = { kind: "resolved", value: result };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      expect((outcome.error as BusError).message).toContain("was replaced during the write");
    }
    // Never adopted: the attacker's chosen successorThreadId names no
    // published thread either way.
    await expect(
      resolveInitializedBusPaths(value.root).then((paths) =>
        readdir(join(paths.threads, attackerSuccessorThreadId)).catch(() => null),
      ),
    ).resolves.toBeNull();
  });

  it("rejects a persistent redeliver-markers directory swap landing between the ISS-1002 supersede's durableWrite call and this fix's own post-write checks, and publishes no successor (ISS-953 Codex round 6 MAJOR #5, security)", async () => {
    // The ISS-1002 remedy's supersede branch had NO post-write verification at
    // all when round 6 reviewed it -- the shared markerDirCheck earlier in
    // this function runs BEFORE this branch's own async work (the existing-
    // marker read, verifiedSuccessorState's fold and endpoint reads), so it is
    // stale by the time durableWrite actually runs. A directory swap landing
    // in that gap would have redirected the supersede write silently, exactly
    // ISS-999's shape recreated inside the fix meant to close a sibling of it.
    // Structural twin of the round-5 finding #10 test above, but targeting
    // durableWrite (the supersede path) instead of durableCreate (the
    // fresh-write / EEXIST-recovery path).
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s6-r6-supersede-dir-swap");

    // Pre-write a bindings-valid marker naming a successorThreadId that
    // resolves no real thread -- verifiedSuccessorState classifies this
    // "pending", which is exactly the branch that reaches durableWrite.
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const staleSuccessorThreadId = randomUUID();
    await writeFile(
      join(markerDir, `${parkEntry.entryHash}.json`),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: threadId,
        predecessorEntryHash: parkEntry.entryHash,
        originalByEndpoint: parkEntry.payload.byEndpoint,
        successorThreadId: staleSuccessorThreadId,
        createdAt: "2026-01-01T00:00:00.000Z",
      }, null, 2) + "\n",
      "utf-8",
    );

    const escapeDir = join(value.root, "escaped-redeliver-markers-s6-r6");
    await mkdir(escapeDir, { recursive: true, mode: 0o700 });
    const realRoot = await realpath(value.root);
    const realEscapeDir = await realpath(escapeDir);
    if (!realEscapeDir.startsWith(realRoot)) {
      throw new Error("SAFETY ABORT: escape target resolved outside the fixture tmpdir");
    }

    const realDurableWrite = io.durableWrite;
    const spy = vi.spyOn(io, "durableWrite").mockImplementationOnce(async (target, content) => {
      const targetDir = dirname(target as string);
      const realTargetDir = await realpath(targetDir);
      if (!realTargetDir.startsWith(realRoot)) {
        throw new Error("SAFETY ABORT: write target resolved outside the fixture tmpdir");
      }
      // THE SWAP: lands strictly between the shared (now-stale) markerDirCheck
      // earlier in this function and this call's own write -- durableWrite's
      // path resolution then follows the swap, landing the supersede write in
      // the escape directory instead of the validated one.
      await rm(targetDir, { recursive: true, force: true });
      await symlink(escapeDir, targetDir, "dir");
      await realDurableWrite(target, content);
    });

    let outcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };
    try {
      const result = await redeliverBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      });
      outcome = { kind: "resolved", value: result };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      expect((outcome.error as BusError).message).toContain("replaced during the supersede write");
    }
    // The write DID follow the swap (proving the check we're testing is the
    // only thing catching this, not some earlier guard): the escape directory
    // holds the supersede attempt's content.
    const escapeContents = await readdir(escapeDir);
    expect(escapeContents).toContain(`${parkEntry.entryHash}.json`);
    // No successor was published under this call's own pre-assigned id --
    // the rejection happened before publishNewThread, not after.
    const paths = await resolveInitializedBusPaths(value.root);
    const liveThreadIds = await readdir(paths.threads);
    expect(liveThreadIds).toEqual([threadId]);
  });

  it("catches a supersede marker overwritten with a different, schema-valid marker at the same path after the legitimate ISS-1002 write, which had no read-back check at all (ISS-953 Codex round 6 MAJOR #5, security)", async () => {
    // Structural twin of the round-4 finding #7 test above (content
    // substitution at the same path after a legitimate write succeeds), but
    // targeting the ISS-1002 supersede's durableWrite instead of the
    // fresh-write path's durableCreate.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s6-r6-supersede-content-swap");

    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    await mkdir(markerDir, { recursive: true, mode: 0o700 });
    const staleSuccessorThreadId = randomUUID();
    const markerFilename = `${parkEntry.entryHash}.json`;
    await writeFile(
      join(markerDir, markerFilename),
      JSON.stringify({
        schema: "storybloq-bus-redeliver-marker/v1",
        predecessorThreadId: threadId,
        predecessorEntryHash: parkEntry.entryHash,
        originalByEndpoint: parkEntry.payload.byEndpoint,
        successorThreadId: staleSuccessorThreadId,
        createdAt: "2026-01-01T00:00:00.000Z",
      }, null, 2) + "\n",
      "utf-8",
    );

    const forgedDiscardedId = randomUUID();
    const realDurableWrite = io.durableWrite;
    const spy = vi.spyOn(io, "durableWrite").mockImplementation(async (target, content) => {
      await realDurableWrite(target, content);
      if (basename(target as string) !== markerFilename) return;
      // THE SWAP: same path, same file type, still a schema-valid
      // BusRedeliverMarker -- with a DIFFERENT discardedSuccessorThreadId,
      // simulating an external actor landing a different marker at the exact
      // validated path in the window between durableWrite's return and this
      // fix's read-back check.
      const original = JSON.parse(content as string);
      const forged = { ...original, discardedSuccessorThreadId: forgedDiscardedId };
      await writeFile(target as string, `${JSON.stringify(forged, null, 2)}\n`, "utf-8");
    });

    let outcome: { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };
    try {
      const result = await redeliverBusMessage(value.root, {
        endpointId: value.reviewer.endpointId,
        clientTaskId: value.reviewerTaskId,
        predecessorThreadId: threadId,
        refusedEntryHash: parkEntry.entryHash,
      });
      outcome = { kind: "resolved", value: result };
    } catch (error) {
      outcome = { kind: "rejected", error };
    } finally {
      spy.mockRestore();
    }

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(BusError);
      expect((outcome.error as BusError).code).toBe("corrupt");
      expect((outcome.error as BusError).message).toContain("did not land at its validated path after being superseded");
    }
  });

  it("states the ACCEPTED predecessor contract in its refusal message: predecessorThreadId alone is valid, so the message must not demand all three together (ISS-953 Codex round 3 finding #7, error handling)", () => {
    // The refinement's predicate only fires once predecessorRelation or
    // predecessorEntryHash appears, so predecessorThreadId ALONE parses --
    // the ordinary, pre-ISS-953 resolved-thread-successor shape. The old
    // message ("must be present together or all absent") described a stricter
    // rule than the code implements, so a caller holding a perfectly valid
    // predecessorThreadId was told to remove it. This test pins the MESSAGE
    // TEXT, not merely the accept/reject outcome: the outcome was already
    // correct, the wording was the defect, and only an assertion on the string
    // can regress-guard a string.
    const base = {
      schema: "storybloq-bus-thread/v2" as const,
      threadId: randomUUID(),
      kind: "issue_notice" as const,
      topicRef: { issue: "ISS-953" },
      participants: [randomUUID(), randomUUID()] as [string, string],
      maxHops: 8,
      createdByEndpoint: randomUUID(),
      createdAt: "2026-08-07T00:00:00.000Z",
      threadHash: "0".repeat(64),
    };

    // The shape the old message defamed: predecessorThreadId alone, ACCEPTED.
    expect(BusThreadRecordSchema.safeParse({ ...base, predecessorThreadId: randomUUID() }).success).toBe(true);
    // Control: all three absent, also accepted (every pre-wave record).
    expect(BusThreadRecordSchema.safeParse(base).success).toBe(true);
    // Control: the complete trio, accepted.
    expect(BusThreadRecordSchema.safeParse({
      ...base,
      predecessorThreadId: randomUUID(),
      predecessorRelation: "hop_cap_successor" as const,
      predecessorEntryHash: "a".repeat(64),
    }).success).toBe(true);

    // Malformed AROUND a valid predecessor -- finding #7's exact scenario:
    // relation present, entryHash missing, predecessorThreadId legitimately
    // present. Rejected correctly, but the message must not tell the caller
    // its valid predecessorThreadId is the problem.
    const malformed = BusThreadRecordSchema.safeParse({
      ...base,
      predecessorThreadId: randomUUID(),
      predecessorRelation: "hop_cap_successor" as const,
    });
    expect(malformed.success).toBe(false);
    if (malformed.success) throw new Error("unreachable: asserted false above");
    expect(malformed.error.issues[0]!.message).toBe(
      "predecessorRelation and predecessorEntryHash must either both be absent, or both be present with predecessorThreadId",
    );
  });

  it("rejects droppedMessage on a state entry unless it is an automatic park with a valid trigger (ISS-953 Codex round 3 finding #6, data integrity)", () => {
    // BusStatePayloadSchema previously accepted droppedMessage on ANY state
    // action, without requiring automatic===true or a valid trigger enum
    // value -- permitting shapes like a resolve/reopen entry carrying
    // refused-message identity, or an "automatic" park with no trigger at
    // all. The refinement is gated on droppedMessage's PRESENCE only, so the
    // legacy/backward-compat control case (no droppedMessage at all) must
    // stay untouched -- every historical automatic park entry predating this
    // field parses this way.
    const droppedMessage = {
      messageKind: "reply" as const,
      severity: "medium" as const,
      refusedPayloadHash: "0".repeat(64),
    };
    const validAutomaticPark = {
      action: "park" as const,
      byEndpoint: randomUUID(),
      reason: "over cap",
      automatic: true,
      trigger: "hop_cap" as const,
      droppedMessage,
    };

    // Control: legacy shape, no droppedMessage at all -- untouched by the refinement.
    const { droppedMessage: _omit, ...legacyShape } = validAutomaticPark;
    expect(BusStatePayloadSchema.safeParse(legacyShape).success).toBe(true);

    // Control: the fully-valid shape still parses.
    expect(BusStatePayloadSchema.safeParse(validAutomaticPark).success).toBe(true);

    // Malformed: droppedMessage present, trigger absent.
    const { trigger: _t, ...noTrigger } = validAutomaticPark;
    const noTriggerResult = BusStatePayloadSchema.safeParse(noTrigger);
    expect(noTriggerResult.success).toBe(false);
    if (!noTriggerResult.success) {
      expect(noTriggerResult.error.issues.some((issue) => issue.path.includes("droppedMessage"))).toBe(true);
    }

    // Malformed: droppedMessage present, automatic is not true.
    expect(BusStatePayloadSchema.safeParse({ ...validAutomaticPark, automatic: false }).success).toBe(false);
    expect(BusStatePayloadSchema.safeParse({ ...validAutomaticPark, automatic: undefined }).success).toBe(false);

    // Malformed: droppedMessage present, action is not "park".
    expect(BusStatePayloadSchema.safeParse({
      ...validAutomaticPark,
      action: "resolve" as const,
      resolution: "handled",
      evidence: { ciRun: "ci-1" },
    }).success).toBe(false);
  });

  it("never lets an absent or malformed park trigger normalize to hop_cap eligibility inside resolveRefusals itself (ISS-953 Codex round 3 finding #2, data integrity)", async () => {
    // Finding #6's schema refinement (immediately above) now rejects a
    // malformed trigger at PARSE time for every entry written or re-read
    // going forward, so a normal write-then-read -- or the wave's usual
    // hand-tamper-then-recompute-hash technique, which still goes through
    // the same readJsonNoFollow(path, BusEntrySchema) call foldBusThread
    // uses -- can no longer produce a malformed-trigger entry that reaches
    // resolveRefusals at all: it fails to parse and quarantines the whole
    // thread before resolveRefusals ever runs. This test proves
    // resolveRefusals's OWN defensive check in genuine isolation from that
    // schema gate: it intercepts the ONE readJsonNoFollow call that reads
    // the park entry's file and returns an in-memory-only payload with the
    // trigger deleted (recomputing entryHash so the chain-integrity check
    // still passes), bypassing Zod validation entirely for that single call
    // -- exactly as if finding #6's schema check did not exist -- while
    // every other read (thread.json, redeliver markers, the refused
    // artifact) delegates to the real implementation unchanged. A genuine
    // cross-module spy target: io.ts defines readJsonNoFollow, fold.ts calls
    // it from a different module, the same boundary the EEXIST-fsync tests
    // above already spy across successfully (vi.spyOn(io, "syncDirectory")).
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const { threadId, parkEntry } = await parkOverCap(value, issueId, "s2-trigger");

    // Redeliver FIRST, against the genuine (valid-trigger) entry, so a real,
    // verified marker + successor thread exist before any tampering --
    // proving the fix denies "verified" even when a marker that WOULD
    // otherwise verify is already on disk, not merely when none exists.
    const redelivered = await redeliverBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      predecessorThreadId: threadId,
      refusedEntryHash: parkEntry.entryHash,
    });
    expect(redelivered.replaySource).toBe("none");

    const entriesDir = join(value.root, ".story", "bus", "threads", threadId, "entries");
    const parkFilename = (await readdir(entriesDir)).sort().at(-1)!;
    // Canonicalize: macOS mkdtemp roots land under /var/folders/... (a symlink to
    // /private/var/folders/...), but io.ts's own path resolution ends up reading
    // through the resolved /private form -- comparing against the un-resolved
    // value.root-derived path would never match, silently never intercepting
    // anything and leaving the REAL (unmutated, genuinely valid-trigger) entry to
    // flow through, which would make this test pass for the wrong reason.
    const parkPath = await realpath(join(entriesDir, parkFilename));

    // Precompute the mutated entry (trigger deleted, entryHash recomputed to keep
    // the chain-integrity check satisfied) OUTSIDE the spy, once: readRedeliverMarker
    // looks a marker up by `${entryHash}.json`, keyed off the CURRENT entry's
    // entryHash -- since deleting trigger necessarily changes that hash, the
    // marker genuinely created above (bound to the ORIGINAL entryHash) would
    // otherwise be invisible to the mutated entry, collapsing markerState to
    // "none" and proving nothing about the marker-present branch.
    const rawParkEntry = JSON.parse(await readFile(parkPath, "utf-8"));
    const mutatedEntry = structuredClone(rawParkEntry);
    delete mutatedEntry.payload.trigger;
    mutatedEntry.entryHash = "0".repeat(64);
    mutatedEntry.entryHash = hashWithoutKey(mutatedEntry, "entryHash");

    // ISS-953 Codex round 5 finding #4: a marker copied byte-for-byte from one
    // that verified against the ORIGINAL (unmutated) entry hash can never pass
    // `bound` here either -- its own predecessorEntryHash still names the
    // original hash, not the mutated one, so `bound` fails on its own
    // regardless of whether the `!validTrigger` disjunct exists. That
    // construction proves nothing about the disjunct's own necessity. An
    // on-disk forger is not limited to copying an existing marker: nothing
    // stops them from writing a FRESH marker whose filename AND
    // predecessorEntryHash both name the mutated hash directly -- `bound`
    // would then be TRUE on its own terms, and only `!validTrigger` stands
    // between this malformed-trigger entry and the deeper
    // verifiedSuccessorState check. This marker is deliberately built that
    // way: bound to the mutated entry, naming a successorThreadId that
    // resolves no real thread (so reaching verifiedSuccessorState, if the
    // disjunct were ever removed, would classify "pending", not "invalid" --
    // a clearly observable difference from what this test asserts below).
    const markerDir = join(value.root, ".story", "bus", "threads", threadId, "redeliver-markers");
    const boundForgedMarker = {
      schema: "storybloq-bus-redeliver-marker/v1",
      predecessorThreadId: threadId,
      predecessorEntryHash: mutatedEntry.entryHash,
      originalByEndpoint: value.reviewer.endpointId,
      successorThreadId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      join(markerDir, `${mutatedEntry.entryHash}.json`),
      JSON.stringify(boundForgedMarker, null, 2) + "\n",
      "utf-8",
    );

    const originalReadJsonNoFollow = io.readJsonNoFollow;
    const spy = vi.spyOn(io, "readJsonNoFollow").mockImplementation(async (...callArgs: Parameters<typeof io.readJsonNoFollow>) => {
      const [path] = callArgs;
      if (path === parkPath) return mutatedEntry;
      return originalReadJsonNoFollow(...callArgs);
    });

    try {
      const folded = await foldBusThread(value.root, threadId, { includeRefusals: true });
      expect(folded.integrity).toBe("verified");
      expect(folded.refusals).toHaveLength(1);
      const refusal = folded.refusals[0]!;
      // A present marker exists for this exact (mutated) entryHash, freshly
      // forged (not copied) with a filename and predecessorEntryHash that
      // both bind it directly to the mutated entry -- `bound` would succeed
      // on its own terms if ever reached. The malformed trigger must still
      // force both channels closed, never "resolved"/"verified"/"redelivered",
      // through the `!validTrigger` disjunct alone.
      expect(refusal.artifactStatus).toBe("corrupt");
      expect(refusal.markerState).toBe("invalid");
      expect(refusal.disposition).toBe("unresolved");
      // ISS-953 Codex round 4 finding #2: the exposed trigger itself must not
      // be fabricated to "hop_cap" for this same malformed entry -- before the
      // fix, resolveRefusals normalized ANY non-"duplicate_fingerprint" trigger
      // (including the deleted one this test constructs) to "hop_cap" for the
      // value actually returned on BusRefusal, even though every other channel
      // on this exact refusal (artifactStatus, markerState, disposition, all
      // asserted just above) already reports it as unclassifiable.
      expect(refusal.trigger).toBe("invalid");
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an oversized hop-cap-triggering reply as invalid_input before any park or artifact write (ISS-953 fix step 5)", async () => {
    const value = await fixture();
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    const first = await reviewSend(value);
    const second = await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Bringing hopCount to the configured cap.",
      refs: { ciRun: "ci-oversized-hop-cap-setup" },
      inReplyTo: first.messageId,
      idempotencyKey: "hop-cap-oversized-setup",
    });
    const oversizedFiles = Array.from({ length: 40 }, (_, i) => `${"f".repeat(850)}-${String(i).padStart(2, "0")}`);

    await expect(sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "This reply is oversized and also trips the hop cap.",
      refs: { ciRun: "ci-oversized-hop-cap", files: oversizedFiles },
      inReplyTo: second.messageId,
      idempotencyKey: "hop-cap-oversized",
    })).rejects.toMatchObject({ code: "invalid_input" });

    const folded = await foldBusThread(value.root, first.threadId);
    expect(folded.entries).toHaveLength(2);
    expect(folded.state).toBe("open");
    // The refused/ dir itself is provisioned at init (paths.ts, non-layout-required,
    // matching auto-attach's treatment) -- it existing is not evidence of a write;
    // absence of any FILE in it is.
    expect(await readdir(join(value.root, ".story", "bus", "refused"))).toEqual([]);
  });

  // Shared by both DIAGNOSTIC variants below: drives a real send -> automatic
  // hop-cap park -> writeRefusedArtifact -> readRefusedArtifact round trip with
  // a caller-supplied body, and reports the measured numbers rather than
  // assuming them. Not itself an `it` -- both variants below call it.
  async function measureMaxBodyArtifact(
    value: BusFixture,
    body: string,
    idempotencyPrefix: string,
  ): Promise<{ bodyBytes: number; artifactBytes: number; readStatus: string }> {
    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: await createIssue(value.root, "medium") },
      idempotencyKey: `${idempotencyPrefix}-first`,
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: `${idempotencyPrefix}-ack` },
      idempotencyKey: `${idempotencyPrefix}-ack`,
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body,
      idempotencyKey: `${idempotencyPrefix}-over-cap`,
    });
    expect(parked).toMatchObject({ parked: true, state: "parked" });

    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;
    const refusedPayloadHash = (parkEntry as { payload: { droppedMessage: { refusedPayloadHash: string } } })
      .payload.droppedMessage.refusedPayloadHash;
    const artifactPath = join(value.root, ".story", "bus", "refused", `${refusedPayloadHash}.json`);
    const raw = await readFile(artifactPath);
    const readResult = await readRefusedArtifact(await resolveInitializedBusPaths(value.root), refusedPayloadHash);
    return { bodyBytes: Buffer.byteLength(body, "utf-8"), artifactBytes: raw.length, readStatus: readResult.status };
  }

  it("DIAGNOSTIC A: a maximum-length body under the DEFAULT config (16384 bytes, security.ts's normalizeMessageBody -- tighter than the 65536-char schema cap neither Codex nor the pen's suspicion accounted for) stays well under BUS_MAX_REFUSED_PAYLOAD_BYTES even under worst-case JSON-escaping content (ISS-953 Codex round 4, pen suspicion pre-fix)", async () => {
    const value = await fixture();
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    // All double-quote characters: worst case for JSON string escaping (each
    // becomes \", doubling the encoded length), not the best case ("x" repeat)
    // the first attempt at this test used before hitting normalizeMessageBody's
    // 16384-byte wall.
    const maxBody = '"'.repeat(15000);
    const result = await measureMaxBodyArtifact(value, maxBody, "s5-diag-a");
    // Empirically bisected: 15000 passes the unconditional BUS_MAX_ENTRY_BYTES=32768
    // entry-size gate (ISS-953 fix step 5, already shipped, checked against the
    // serialized entry in publishNewThread and its counterparts before park-vs-
    // direct-send is even decided); 16000 trips it. That gate -- not this test's
    // own body length -- is the true ceiling; see DIAGNOSTIC B for why raising
    // config.bus.maxBodyBytes cannot bypass it.
    expect(result.artifactBytes).toBeLessThanOrEqual(65536);
    expect(result.readStatus).toBe("resolved");
  });

  it("DIAGNOSTIC B: raising config.bus.maxBodyBytes CANNOT reproduce the pen's suspicion, because fix step 5's entry-size gate (BUS_MAX_ENTRY_BYTES=32768) is independent of config and fires unconditionally before park classification, regardless of how high maxBodyBytes is set (ISS-953 Codex round 4, pen suspicion refuted)", async () => {
    const value = await fixture();
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    // Raised well past the default, and past what DIAGNOSTIC A showed the entry
    // gate actually allows -- if the pen's suspicion were reachable via a raised
    // config, THIS is the config that would reach it. It does not: normalizeSend
    // accepts the larger body (config permits it, and 40000 chars is still under
    // the schema's own 65536-char ceiling), but store.ts's fix-step-5 gate --
    // which reads directly off the serialized entry, never off config -- rejects
    // it first, at the exact same 32768-byte boundary DIAGNOSTIC A found. The
    // refused-artifact path (writeRefusedArtifact) is never reached at all.
    config.bus = { maxHops: 2, maxBodyBytes: 40000 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const maxBody = '"'.repeat(40000);
    await expect(measureMaxBodyArtifact(value, maxBody, "s5-diag-b"))
      .rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("Message entry exceeds") });
    // Direct proof the artifact path was never reached, not just inferred from
    // the rejection.
    expect(await readdir(join(value.root, ".story", "bus", "refused"))).toEqual([]);
  });

  // A structurally-identical, not merely analogous, guarantee for the OTHER park
  // trigger: `replyToThread` computes `overHopCap` and `duplicate` from the SAME
  // `entry` variable, AFTER the single size check above already ran (store.ts).
  // A duplicate-fingerprint match additionally requires byte-identical body/refs
  // against an already-delivered message -- and this is unreachable because BOTH
  // of today's message-entry write paths (createThread's initial message,
  // replyToThread's direct-send message) size-gate before writing, so an oversized
  // message can never enter delivered history in the first place; fold.ts's
  // read-time BUS_MAX_ENTRY_BYTES cap is a second line of defence, not the reason.
  // A future THIRD message-entry write path added without its own size gate would
  // resurrect this branch. There is no separate code path to exercise here; the
  // guard above and this one are the same `if`, run once, before either boolean
  // exists.

  it("quarantines a forged message appended after a park transition", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    const parked = await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "park",
      reason: "Waiting for new evidence",
    });
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const entryId = randomUUID();
    const unsigned = {
      schema: "storybloq-bus-entry/v2",
      entryId,
      threadId: first.threadId,
      seq: 3,
      type: "message",
      prevHash: parked.lastHash,
      createdAt: new Date().toISOString(),
      entryHash: "0".repeat(64),
      payload: {
        ...parked.messages[0]!,
        messageId: randomUUID(),
        body: "Forged message after park",
        idempotencyKeyHash: "a".repeat(64),
        payloadHash: "b".repeat(64),
      },
    };
    const entry = { ...unsigned, entryHash: hashWithoutKey(unsigned, "entryHash") };
    await writeFile(
      join(entriesDir, `000003-message-${entryId}.json`),
      JSON.stringify(entry, null, 2) + "\n",
      "utf-8",
    );

    expect(await foldBusThread(value.root, first.threadId)).toMatchObject({
      integrity: "quarantined",
      validThroughSeq: 2,
      finding: expect.stringContaining("parked thread received a message"),
    });
  });

  it("blocks ship on a quarantined thread that dropped a critical message before it was corrupted, even though no delivered message or the issue itself is critical (ISS-953 fix step 9, security)", async () => {
    // `critical` in checkBusShip is derived from folded.messages plus the
    // issue's own severity -- both blind to a message that was critical
    // severity but got DROPPED (parked+refused) rather than delivered, since a
    // dropped message never becomes a folded.messages entry. foldBusThread also
    // never resolves refusals past a corrupted core fold (fold.ts's
    // integrity-gated short-circuit), so folded.refusals is empty for a
    // quarantined thread too. Gating the quarantine blocker behind `critical`
    // let a thread that dropped a critical message and was LATER corrupted by
    // unrelated tampering ship silently: neither check would ever fire. The
    // quarantine blocker must be unconditional.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    // requireIssueForCritical defaults to true, which would additionally require
    // this test's critical message to reference a CRITICAL-severity issue --
    // exactly the case this test needs to avoid, since the point is a critical
    // drop on a thread whose issue and delivered messages are all non-critical.
    config.bus = { maxHops: 2, requireIssueForCritical: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      severity: "medium",
      refs: { issue: issueId },
      idempotencyKey: "s9-quarantine-critical-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s9-quarantine-critical-ack" },
      idempotencyKey: "s9-quarantine-critical-ack",
    });
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "critical",
      body: "This needs the release boundary check before it can close.",
      idempotencyKey: "s9-quarantine-critical-over-cap",
    });
    expect(parked).toMatchObject({ parked: true });

    // Sanity, before corruption: checkBusShip already blocks via the existing
    // refusal-scan path (fix step 9's "unresolved critical Bus refusal"). This
    // test is only meaningful if the POST-corruption case is distinct from it.
    const beforeCorruption = await checkBusShip(value.root);
    expect(beforeCorruption.clear).toBe(false);
    expect(beforeCorruption.blockers.join("\n")).toMatch(/unresolved critical Bus refusal/);

    // Corrupt the thread: forge a message entry appended after the park (same
    // technique as "quarantines a forged message appended after a park
    // transition" above), unrelated to the critical drop itself.
    const parkedFold = await foldBusThread(value.root, first.threadId);
    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const entryId = randomUUID();
    const unsigned = {
      schema: "storybloq-bus-entry/v2",
      entryId,
      threadId: first.threadId,
      seq: parkedFold.validThroughSeq + 1,
      type: "message",
      prevHash: parkedFold.lastHash,
      createdAt: new Date().toISOString(),
      entryHash: "0".repeat(64),
      payload: {
        ...parkedFold.messages[0]!,
        messageId: randomUUID(),
        body: "Forged message after park",
        idempotencyKeyHash: "a".repeat(64),
        payloadHash: "b".repeat(64),
      },
    };
    const entry = { ...unsigned, entryHash: hashWithoutKey(unsigned, "entryHash") };
    await writeFile(
      join(entriesDir, `${String(unsigned.seq).padStart(6, "0")}-message-${entryId}.json`),
      JSON.stringify(entry, null, 2) + "\n",
      "utf-8",
    );

    const corruptedFold = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(corruptedFold.integrity).toBe("quarantined");
    expect(corruptedFold.refusals).toEqual([]);
    // The drop is the ONLY critical content on this thread, and it is invisible
    // to folded.messages by design.
    expect(corruptedFold.messages.some((message) => message.severity === "critical")).toBe(false);

    const afterCorruption = await checkBusShip(value.root);
    expect(afterCorruption.clear).toBe(false);
    expect(afterCorruption.blockers.join("\n")).toMatch(/quarantined Bus thread/);
  });

  it("requires unseen evidence to reopen a parked thread", async () => {
    const value = await fixture();
    const first = await reviewSend(value);
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "park",
      reason: "Waiting for a new CI run",
    });
    const reopened = await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "New CI evidence is available",
      evidence: { ciRun: "ci-new-evidence" },
    });
    expect(reopened.state).toBe("open");
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "park",
      reason: "One more verification is required",
    });
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "Retry old evidence",
      evidence: { ciRun: "ci-new-evidence" },
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("marks a hop-cap-dropped message's own evidence as seen, so reopening with that exact evidence is rejected as stale (ISS-953 fix step 16)", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: "s16-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s16-ack" },
      idempotencyKey: "s16-ack",
    });
    // The evidence carried by the DROPPED (parked-away) message itself -- never
    // submitted as reopen evidence by anyone, yet must already read as "seen" once
    // the park lands, per fix step 16's mark-seen-not-whitelist rule.
    const droppedRef = "s16-dropped-evidence";
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      refs: { ciRun: droppedRef },
      idempotencyKey: "s16-over-cap",
    });
    expect(parked).toMatchObject({ parked: true });

    // Resubmitting the DROPPED message's own evidence as if it were new is
    // rejected -- it was never actually seen by either participant, but the fold
    // now marks it seen the moment the park lands, closing the staleness gap.
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "Retry the dropped evidence",
      evidence: { ciRun: droppedRef },
    })).rejects.toMatchObject({ code: "conflict" });

    // Control: genuinely new evidence still reopens normally -- the widening marks
    // the dropped ref seen, it does not block reopen altogether.
    const reopened = await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "Genuinely new evidence",
      evidence: { ciRun: "s16-genuinely-new" },
    });
    expect(reopened.state).toBe("open");
  });

  it("keeps dropped evidence marked seen even after its artifact is deleted (ISS-953 fix step 16, fail-closed revision)", async () => {
    // Codex found the gap in the original fix step 16 implementation: it read
    // the dropped message's evidence from the ARTIFACT, so deleting or
    // corrupting that artifact after the park landed silently un-widened the
    // seen-set, making the exact evidence that was just dropped resubmittable
    // as if new. The fix persists evidenceKeys onto the park entry itself at
    // write time (refused.ts), so this test deletes the artifact BEFORE
    // attempting the reopen and asserts the widening still holds -- the whole
    // point of moving off the artifact read.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: "s16-fc-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s16-fc-ack" },
      idempotencyKey: "s16-fc-ack",
    });
    const droppedRef = "s16-fc-dropped-evidence";
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      refs: { ciRun: droppedRef },
      idempotencyKey: "s16-fc-over-cap",
    });
    expect(parked).toMatchObject({ parked: true });

    const parkEntry = (await foldBusThread(value.root, first.threadId)).entries.at(-1)!;
    expect(parkEntry.payload.droppedMessage.evidenceKeys).toEqual([`ci:${droppedRef}`]);
    const refusedDir = join(value.root, ".story", "bus", "refused");
    await rm(join(refusedDir, `${parkEntry.payload.droppedMessage.refusedPayloadHash}.json`));

    // Reopening with the dropped evidence is still rejected as stale, even
    // though the artifact it would otherwise have been read from is gone.
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "Retry the dropped evidence after artifact loss",
      evidence: { ciRun: droppedRef },
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("reports artifactStatus 'corrupt' and still rejects the artifact's TRUE evidence as stale when the entry's own evidenceKeys is tampered, never the tampered value (ISS-953 Codex round 2 finding #24, security)", async () => {
    // The fail-closed-revision test above covers artifact DELETION only. This
    // covers the other half finding #24 names: the entry's persisted
    // evidenceKeys is a SEPARATE copy inside the hash-chained entry log, whose
    // own hash a tamperer can freely recompute -- unlike the artifact, whose
    // filename is a content hash (refusedPayloadHash) checked by re-hashing
    // the PARSED content and comparing it against that filename. An attacker
    // CAN overwrite the artifact's content while keeping its filename intact
    // (ISS-953 Codex round 5 finding #15 corrected the earlier claim that
    // this was not possible) -- content-addressing makes that tampering
    // DETECTABLE, since the recomputed hash then disagrees with the
    // filename, not UNDOABLE. The entry-side evidenceKeys copy this test
    // targets has no independent content-addressed binding of its own at
    // all, which is exactly the asymmetry this test isolates: change ONLY
    // the entry-side copy (to a WRONG, unrelated value), recompute the
    // entry's own hash exactly as the existing severity-consistency test
    // does, and leave the artifact fully intact -- isolating the assertion
    // to the evidenceKeys cross-check alone, not a broader artifact
    // corruption a different check would also catch.
    const value = await fixture();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = await reviewSend(value, {
      threadKind: "issue_notice",
      messageKind: "issue_notice",
      refs: { issue: issueId },
      idempotencyKey: "s24-first",
    });
    await sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "medium",
      body: "Acknowledged, investigating.",
      refs: { ciRun: "s24-ack" },
      idempotencyKey: "s24-ack",
    });
    const trueDroppedRef = "s24-true-dropped-evidence";
    const parked = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      toRole: "implementer",
      messageKind: "reply",
      severity: "medium",
      body: "One more check needed before this can close.",
      refs: { ciRun: trueDroppedRef },
      idempotencyKey: "s24-over-cap",
    });
    expect(parked).toMatchObject({ parked: true });

    const predecessorFold = await foldBusThread(value.root, first.threadId);
    const parkEntry = predecessorFold.entries.at(-1)!;
    // Fixture-produced-state assertion before exercising behaviour that
    // depends on it (a recurring L-055 instance this wave: a fixture can
    // silently produce the wrong trigger or, here, the wrong evidenceKeys,
    // regardless of what the test name claims).
    expect(parkEntry.payload.droppedMessage.evidenceKeys).toEqual([`ci:${trueDroppedRef}`]);

    const entriesDir = join(value.root, ".story", "bus", "threads", first.threadId, "entries");
    const parkFilename = (await readdir(entriesDir)).sort().at(-1)!;
    const parkPath = join(entriesDir, parkFilename);
    const rawEntry = JSON.parse(await readFile(parkPath, "utf-8"));
    rawEntry.payload.droppedMessage.evidenceKeys = ["ci:s24-wrong-evidence"];
    rawEntry.entryHash = "0".repeat(64);
    rawEntry.entryHash = hashWithoutKey(rawEntry, "entryHash");
    await writeFile(parkPath, JSON.stringify(rawEntry, null, 2) + "\n", "utf-8");

    // Sanity: core fold integrity is untouched by this tamper (the entryHash
    // was correctly recomputed) -- this test is meaningless if the core fold
    // itself already rejects the thread on other grounds.
    const tamperedFold = await foldBusThread(value.root, first.threadId);
    expect(tamperedFold.integrity).toBe("verified");

    const resolved = await foldBusThread(value.root, first.threadId, { includeRefusals: true });
    expect(resolved.refusals[0]).toMatchObject({ disposition: "unresolved", markerState: "none", artifactStatus: "corrupt" });

    // The TRUE evidence (what the still-intact artifact actually contains)
    // remains rejected as stale: mark-seen prefers the artifact's own
    // derived keys over the tampered entry-side copy, so tampering
    // evidenceKeys can never make genuinely-dropped evidence appear unseen.
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "Retry the true dropped evidence despite the tamper",
      evidence: { ciRun: trueDroppedRef },
    })).rejects.toMatchObject({ code: "conflict" });

    // Control: the TAMPERED (wrong) value was never genuinely dropped, so it
    // must NOT read as seen -- proving the fix prefers the artifact's truth
    // outright, rather than unioning both copies together.
    const reopenedWithTamperedValue = await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "The tampered value was never actually dropped",
      evidence: { ciRun: "s24-wrong-evidence" },
    });
    expect(reopenedWithTamperedValue.state).toBe("open");
  });

  it("records both commit and CI identities from mixed reopen evidence", async () => {
    const value = await fixture();
    await exec("git", ["init", "-b", "main"], { cwd: value.root });
    await exec("git", ["config", "user.email", "bus-test@example.com"], { cwd: value.root });
    await exec("git", ["config", "user.name", "Bus Test"], { cwd: value.root });
    await exec("git", ["commit", "--allow-empty", "-m", "evidence"], { cwd: value.root });
    const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: value.root })).stdout.trim();
    const first = await reviewSend(value);
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "park",
      reason: "Waiting for mixed evidence",
    });
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "Commit and CI evidence arrived",
      evidence: { commit, ciRun: "ci-mixed-evidence" },
    });
    await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "park",
      reason: "Waiting for evidence newer than the mixed pair",
    });

    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "reopen",
      reason: "Retrying the CI half of old evidence",
      evidence: { ciRun: "ci-mixed-evidence" },
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("resolves issue threads only after canonical resolution and links successors", async () => {
    const value = await fixture();
    const issueId = await createIssue(value.root, "high");
    const first = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "issue_notice",
      toRole: "implementer",
      messageKind: "issue_notice",
      severity: "high",
      body: "The recovery check needs a guard.",
      refs: { issue: issueId },
      idempotencyKey: "high-issue-thread",
    });
    await expect(updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "resolve",
      resolution: "Guard verified",
      evidence: { ciRun: "ci-resolution" },
    })).rejects.toMatchObject({ code: "conflict" });

    await resolveIssue(value.root, issueId);
    expect((await updateBusThread(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadId: first.threadId,
      action: "resolve",
      resolution: "Guard verified",
      evidence: { ciRun: "ci-resolution" },
    })).state).toBe("resolved");
    await expect(sendBusMessage(value.root, {
      endpointId: value.implementer.endpointId,
      clientTaskId: value.implementerTaskId,
      threadId: first.threadId,
      toRole: "reviewer",
      messageKind: "reply",
      severity: "info",
      body: "Late reply",
      refs: { ciRun: "ci-late" },
      idempotencyKey: "late-reply",
    })).rejects.toMatchObject({ code: "thread_parked" });

    const successor = await sendBusMessage(value.root, {
      endpointId: value.reviewer.endpointId,
      clientTaskId: value.reviewerTaskId,
      threadKind: "question",
      predecessorThreadId: first.threadId,
      toRole: "implementer",
      messageKind: "question",
      severity: "info",
      body: "Does the successor evidence hold?",
      refs: { ciRun: "ci-successor" },
      idempotencyKey: "successor-thread",
    });
    expect((await foldBusThread(value.root, successor.threadId)).thread.predecessorThreadId)
      .toBe(first.threadId);
  });
});
