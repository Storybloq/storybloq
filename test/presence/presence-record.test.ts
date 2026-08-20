/**
 * ISS-1022: the presence record's transition and ordering properties.
 *
 * These are the properties a filesystem test cannot pin, because they are
 * about what happens when hook events arrive in an order the writer did not
 * choose. The record has no way to verify ordering for itself -- hook payloads
 * carry `session_id` and nothing identifying which SessionStart minted the
 * current record -- so the design's whole answer is "run synchronously and
 * inherit Claude Code's sequencing", with `closedToolIds` as belt and braces.
 * Both halves are pinned here.
 */
import { describe, it, expect } from "vitest";

import {
  PRESENCE_SHED_STEPS,
  applyPresenceEvent,
  isValidSessionId,
  parsePresenceRecord,
  serializePresence,
  type PresenceEventContext,
} from "../../src/presence/record.js";
import {
  MAX_AGENT_IDS,
  MAX_CLOSED_TOOL_IDS,
  MAX_ID_BYTES,
  MAX_OPEN_TOOLS,
  MAX_TARGET_BYTES,
  MAX_TOOL_NAME_BYTES,
  MAX_RECORD_BYTES,
  PRESENCE_SCHEMA_VERSION,
  type SessionPresence,
} from "../../src/presence/types.js";

const SESSION = "sess-abc123";

function ctx(over: Partial<PresenceEventContext> & Pick<PresenceEventContext, "event">): PresenceEventContext {
  return {
    sessionId: SESSION,
    nowIso: "2026-08-20T12:00:00.000Z",
    source: null,
    toolId: null,
    toolName: null,
    target: null,
    agentId: null,
    suppressed: false,
    ...over,
  };
}

function start(prev: SessionPresence | null = null, at = "2026-08-20T12:00:00.000Z", source = "startup") {
  return applyPresenceEvent(prev, ctx({ event: "SessionStart", nowIso: at, source }));
}

function pre(prev: SessionPresence | null, id: string, tool = "Read", at = "2026-08-20T12:00:01.000Z", over: Partial<PresenceEventContext> = {}) {
  return applyPresenceEvent(prev, ctx({ event: "PreToolUse", toolId: id, toolName: tool, nowIso: at, ...over }));
}

function post(prev: SessionPresence | null, id: string | null, tool = "Read", at = "2026-08-20T12:00:02.000Z") {
  return applyPresenceEvent(prev, ctx({ event: "PostToolUse", toolId: id, toolName: tool, nowIso: at }));
}

// ---------------------------------------------------------------------------

describe("session id validation (ISS-1022)", () => {
  it("accepts the client session id shape", () => {
    expect(isValidSessionId("a")).toBe(true);
    expect(isValidSessionId("018yt4g5-Wb1u.2hqs:3iiXLvjb")).toBe(true);
  });

  /**
   * The id becomes a FILENAME, so these are not style rules. The
   * leading-alnum requirement is what refuses `.` and `..`; the character
   * class refuses every separator on both platforms.
   */
  it("refuses anything that could escape the presence directory", () => {
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "/abs", ".hidden", "a\0b", "a b", "a".repeat(129)]) {
      expect(isValidSessionId(bad), `should refuse ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("presence transitions (ISS-1022)", () => {
  it("SessionStart initialises, and preserves startedAt across a later start", () => {
    const first = start(null, "2026-08-20T10:00:00.000Z");
    expect(first.generation).toBe(1);
    expect(first.startedAt).toBe("2026-08-20T10:00:00.000Z");

    // resume / clear / compact continue the SAME session, so the panel keeps
    // showing how long it has been going.
    const second = start(first, "2026-08-20T11:00:00.000Z", "compact");
    expect(second.startedAt).toBe("2026-08-20T10:00:00.000Z");
    expect(second.generation).toBe(2);
    expect(second.source).toBe("compact");
  });

  it("SessionStart discards the previous generation's turn state", () => {
    const withWork = pre(start(), "tu_1", "Bash");
    expect(withWork.openTools).toHaveLength(1);
    const restarted = start(withWork, "2026-08-20T13:00:00.000Z", "clear");
    expect(restarted.openTools).toEqual([]);
    expect(restarted.closedToolIds).toEqual([]);
    expect(restarted.agentIds).toEqual([]);
  });

  /**
   * The isolation claim is about IDENTITY, not about the `fork` source string:
   * a fork carries a different `session_id`, so it addresses a different record
   * and shares no turn state with its parent. Pinning that needs two ids, which
   * is why this builds the parent's busy record explicitly.
   */
  it("a fork gets its own record rather than inheriting the parent's turn state", () => {
    const parent = pre(start(null, "2026-08-20T12:00:00.000Z"), "tu_parent", "Bash");
    expect(parent.openTools.map((t) => t.id)).toEqual(["tu_parent"]);

    const forked = applyPresenceEvent(null, ctx({
      event: "SessionStart",
      sessionId: "sess-forked",
      source: "fork",
      nowIso: "2026-08-20T12:00:02.000Z",
    }));
    expect(forked.sessionId).toBe("sess-forked");
    expect(forked.source).toBe("fork");
    expect(forked.generation).toBe(1);
    expect(forked.openTools).toEqual([]);
    expect(forked.startedAt).toBe("2026-08-20T12:00:02.000Z");
    // The parent is untouched by the fork's start.
    expect(parent.openTools.map((t) => t.id)).toEqual(["tu_parent"]);
  });

  it("PreToolUse opens and PostToolUse closes, correlated by tool_use_id", () => {
    const opened = pre(start(), "tu_1", "Bash");
    expect(opened.openTools.map((t) => t.id)).toEqual(["tu_1"]);
    const closed = post(opened, "tu_1", "Bash");
    expect(closed.openTools).toEqual([]);
    expect(closed.closedToolIds).toContain("tu_1");
  });

  it("Stop clears the turn's open tools and agents", () => {
    const busy = pre(pre(start(), "tu_1"), "tu_2", "Bash", "2026-08-20T12:00:01.500Z", { agentId: "agent-1" });
    expect(busy.openTools).toHaveLength(2);
    const stopped = applyPresenceEvent(busy, ctx({ event: "Stop", nowIso: "2026-08-20T12:00:09.000Z" }));
    expect(stopped.openTools).toEqual([]);
    expect(stopped.agentIds).toEqual([]);
    expect(stopped.endedAt).toBeNull();
  });

  it("SessionEnd tombstones", () => {
    const ended = applyPresenceEvent(pre(start(), "tu_1"), ctx({ event: "SessionEnd", nowIso: "2026-08-20T12:30:00.000Z" }));
    expect(ended.endedAt).toBe("2026-08-20T12:30:00.000Z");
    expect(ended.openTools).toEqual([]);
  });

  /**
   * A user who reopens the same session id after `/exit` must not stay hidden
   * forever, so a start REVIVES a tombstoned record rather than being ignored.
   */
  it("SessionStart revives a tombstoned record", () => {
    const ended = applyPresenceEvent(start(), ctx({ event: "SessionEnd", nowIso: "2026-08-20T12:30:00.000Z" }));
    expect(ended.endedAt).not.toBeNull();
    expect(start(ended, "2026-08-20T14:00:00.000Z", "resume").endedAt).toBeNull();
  });
});

describe("presence ordering hazards (ISS-1022)", () => {
  /** The belt-and-braces property: a straggler PreToolUse cannot reopen a finished tool. */
  it("a late PreToolUse after its PostToolUse does not reopen the tool", () => {
    const closed = post(pre(start(), "tu_1"), "tu_1");
    const straggler = pre(closed, "tu_1", "Read", "2026-08-20T12:00:03.000Z");
    expect(straggler.openTools).toEqual([]);
    expect(straggler.closedToolIds).toContain("tu_1");
  });

  /** The inverse interleaving: PostToolUse arrives with nothing open. */
  it("PostToolUse with no matching open tool still records the id as closed", () => {
    const closedFirst = post(start(), "tu_9");
    expect(closedFirst.closedToolIds).toContain("tu_9");
    // ...so the PreToolUse that follows is a no-op rather than a phantom open tool.
    expect(pre(closedFirst, "tu_9").openTools).toEqual([]);
  });

  it("a straggler after SessionEnd does not resurrect the session", () => {
    const ended = applyPresenceEvent(start(), ctx({ event: "SessionEnd", nowIso: "2026-08-20T12:30:00.000Z" }));
    const after = pre(ended, "tu_late", "Read", "2026-08-20T12:30:01.000Z");
    expect(after.endedAt).toBe("2026-08-20T12:30:00.000Z");
  });

  it("duplicate PreToolUse for the same id opens it once", () => {
    const twice = pre(pre(start(), "tu_1"), "tu_1", "Read", "2026-08-20T12:00:01.900Z");
    expect(twice.openTools).toHaveLength(1);
  });

  it("identical timestamps do not confuse correlation", () => {
    const at = "2026-08-20T12:00:00.000Z";
    const two = pre(pre(start(null, at), "tu_a", "Read", at), "tu_b", "Grep", at);
    expect(post(two, "tu_a", "Read", at).openTools.map((t) => t.id)).toEqual(["tu_b"]);
  });

  /**
   * A backward clock jump must not corrupt the record. `lastEventAt` states
   * what the clock said -- the reader is what clamps -- but every structural
   * invariant has to survive.
   */
  it("a backward clock jump leaves the record structurally valid", () => {
    const opened = pre(start(null, "2026-08-20T12:00:00.000Z"), "tu_1", "Read", "2026-08-20T12:00:05.000Z");
    const jumped = post(opened, "tu_1", "Read", "2026-08-20T11:59:00.000Z");
    expect(jumped.lastEventAt).toBe("2026-08-20T11:59:00.000Z");
    expect(jumped.startedAt).toBe("2026-08-20T12:00:00.000Z");
    expect(jumped.openTools).toEqual([]);
    expect(serializePresence(jumped)).not.toBeNull();
  });

  /**
   * Without tool_use_id the fallback closes the OLDEST open call of the same
   * name. Correlation degrades under parallel same-tool calls; it must never
   * close a DIFFERENT tool.
   */
  it("without tool_use_id, PostToolUse closes the oldest same-name call and never another tool", () => {
    const two = pre(pre(start(), "syn:Read:1", "Read"), "syn:Bash:2", "Bash");
    const closed = post(two, null, "Bash");
    expect(closed.openTools.map((t) => t.tool)).toEqual(["Read"]);
  });
});

describe("presence bounds (ISS-1022)", () => {
  it("parallel tool bursts stay within the open-tool cap, keeping the newest", () => {
    let rec = start();
    for (let i = 0; i < MAX_OPEN_TOOLS + 5; i++) {
      rec = pre(rec, `tu_${i}`, "Bash", `2026-08-20T12:00:0${i % 10}.000Z`);
    }
    expect(rec.openTools).toHaveLength(MAX_OPEN_TOOLS);
    expect(rec.openTools[rec.openTools.length - 1]!.id).toBe(`tu_${MAX_OPEN_TOOLS + 4}`);
  });

  it("closed-tool ids stay within their cap", () => {
    let rec = start();
    for (let i = 0; i < MAX_CLOSED_TOOL_IDS + 10; i++) rec = post(rec, `tu_${i}`);
    expect(rec.closedToolIds).toHaveLength(MAX_CLOSED_TOOL_IDS);
  });

  /**
   * The no-reopen guarantee is BOUNDED, and this pins exactly where it ends so
   * the bound is a decision on record rather than a surprise. An id evicted by
   * MAX_CLOSED_TOOL_IDS later closures CAN be reopened by a straggler. Reaching
   * that window requires an ordering violation of the kind synchronous hook
   * registration already prevents, and the cost is one stale row that the next
   * Stop clears -- so the bound is accepted rather than paid for with a
   * per-generation Bloom filter.
   */
  it("a straggler whose id has been EVICTED does reopen, which is the accepted bound", () => {
    let rec = post(pre(start(), "tu_first"), "tu_first");
    expect(rec.closedToolIds).toContain("tu_first");

    for (let i = 0; i < MAX_CLOSED_TOOL_IDS; i++) rec = post(rec, `tu_filler_${i}`);
    expect(rec.closedToolIds).not.toContain("tu_first");

    const reopened = pre(rec, "tu_first", "Read", "2026-08-20T12:09:00.000Z");
    expect(reopened.openTools.map((t) => t.id)).toEqual(["tu_first"]);
    // ...and the next Stop is what clears it, so the residual is one stale row.
    expect(applyPresenceEvent(reopened, ctx({ event: "Stop" })).openTools).toEqual([]);
  });

  /**
   * Two separate properties, because they defend different things.
   *
   * First: the per-field caps are the REAL bound, and the worst case they
   * permit must sit comfortably under MAX_RECORD_BYTES. If a future cap change
   * pushed it over, the write would start failing in production before anyone
   * noticed the arithmetic.
   *
   * Second: `serializePresence`'s shedding ladder is last-resort defence that
   * `applyPresenceEvent` cannot reach precisely BECAUSE of the first property
   * (and `parsePresenceRecord` re-applies the caps on read, so a corrupt file
   * cannot reach it either). It is exercised here as a unit so a broken ladder
   * cannot rot unnoticed behind that fact.
   */
  it("the worst case the caps permit stays well under the record bound", () => {
    // Exact byte lengths, so the margin below is measured against the real
    // ceiling rather than against whatever happened to be generated.
    const exact = (bytes: number, seed: string) => (seed + "z".repeat(bytes)).slice(0, bytes);
    let rec = start();
    // MAX_AGENT_IDS events, not MAX_OPEN_TOOLS: openTools caps at 8 while
    // agentIds keeps accumulating to 16, so fewer events leaves agentIds half
    // full and the "worst case" understated.
    for (let i = 0; i < MAX_AGENT_IDS; i++) {
      rec = pre(rec, exact(MAX_ID_BYTES, `id${i}-`), exact(MAX_TOOL_NAME_BYTES, `tool${i}-`), "2026-08-20T12:00:01.000Z", {
        target: exact(MAX_TARGET_BYTES, `d/${i}/`),
        agentId: exact(MAX_ID_BYTES, `agent${i}-`),
      });
    }
    for (let i = 0; i < MAX_CLOSED_TOOL_IDS; i++) rec = post(rec, exact(MAX_ID_BYTES, `closed${i}-`));

    // Every capped collection is genuinely saturated.
    expect(rec.openTools).toHaveLength(MAX_OPEN_TOOLS);
    expect(rec.agentIds).toHaveLength(MAX_AGENT_IDS);
    expect(rec.closedToolIds).toHaveLength(MAX_CLOSED_TOOL_IDS);
    for (const t of rec.openTools) {
      expect(Buffer.byteLength(t.id, "utf-8")).toBe(MAX_ID_BYTES);
      expect(Buffer.byteLength(t.tool, "utf-8")).toBe(MAX_TOOL_NAME_BYTES);
      expect(Buffer.byteLength(t.target!, "utf-8")).toBe(MAX_TARGET_BYTES);
    }

    const bytes = Buffer.byteLength(serializePresence(rec)!, "utf-8");
    expect(bytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    // Headroom, not a coincidence: a cap change that halves this margin should
    // be a deliberate decision rather than a silent approach to the cliff.
    expect(bytes).toBeLessThan(MAX_RECORD_BYTES * 0.75);
  });

  /**
   * The ORDER of the ladder, pinned step by step. Asserting only that
   * "something was shed" lets an implementation reorder or skip stages and
   * still pass, and the order is the whole design: closed ids are pure ordering
   * defence that nobody renders, open tools are the only thing the panel shows.
   */
  it("sheds in a fixed order, least load-bearing state first", () => {
    const rec: SessionPresence = {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      sessionId: SESSION,
      generation: 1,
      startedAt: "2026-08-20T12:00:00.000Z",
      lastEventAt: "2026-08-20T12:00:00.000Z",
      source: "startup",
      openTools: Array.from({ length: 6 }, (_, i) => ({
        id: `open-${i}`, tool: "Read", target: `src/f${i}.ts`,
        startedAt: "2026-08-20T12:00:00.000Z", agentId: `a${i}`,
      })),
      closedToolIds: Array.from({ length: 30 }, (_, i) => `closed-${i}`),
      agentIds: Array.from({ length: 12 }, (_, i) => `agent-${i}`),
      suppressed: false,
      endedAt: null,
    };

    const [one, two, three, four] = PRESENCE_SHED_STEPS;
    expect(PRESENCE_SHED_STEPS).toHaveLength(4);

    const s1 = one!(rec);
    expect(s1.closedToolIds).toEqual(rec.closedToolIds.slice(-8));
    expect(s1.agentIds).toEqual(rec.agentIds);      // untouched at this stage
    expect(s1.openTools).toEqual(rec.openTools);

    const s2 = two!(s1);
    expect(s2.agentIds).toEqual(rec.agentIds.slice(-4));
    expect(s2.openTools).toEqual(rec.openTools);    // still untouched

    const s3 = three!(s2);
    expect(s3.openTools).toHaveLength(2);
    expect(s3.openTools.map((t) => t.id)).toEqual(["open-4", "open-5"]); // newest kept
    expect(s3.openTools.every((t) => t.target === null)).toBe(true);

    const s4 = four!(s3);
    expect(s4.openTools).toEqual(s3.openTools.slice(-1)); // the NEWEST, not just any one
    expect(s4.closedToolIds).toEqual([]);
    expect(s4.agentIds).toEqual([]);

    // Identity is never shed: a record that lost these would be unreadable.
    for (const step of [s1, s2, s3, s4]) {
      expect(step.sessionId).toBe(SESSION);
      expect(step.startedAt).toBe(rec.startedAt);
      expect(step.generation).toBe(1);
    }
  });

  it("applies the ladder when handed an over-cap record, and refuses one that cannot fit", () => {
    const filler = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => `${prefix}-${"y".repeat(200)}-${i}`);
    // Deliberately violates every cap: this is the shape the ladder exists for,
    // and it is not reachable through applyPresenceEvent or parsePresenceRecord.
    const oversized: SessionPresence = {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      sessionId: SESSION,
      generation: 1,
      startedAt: "2026-08-20T12:00:00.000Z",
      lastEventAt: "2026-08-20T12:00:00.000Z",
      source: "startup",
      openTools: Array.from({ length: 40 }, (_, i) => ({
        id: `open-${"z".repeat(200)}-${i}`,
        tool: "NotebookEdit".padEnd(120, "q"),
        target: "a/".repeat(200) + "f.ts",
        startedAt: "2026-08-20T12:00:00.000Z",
        agentId: `agent-${"w".repeat(200)}-${i}`,
      })),
      closedToolIds: filler(120, "closed"),
      agentIds: filler(60, "agent"),
      suppressed: false,
      endedAt: null,
    };
    const shed = JSON.parse(serializePresence(oversized)!) as SessionPresence;
    expect(Buffer.byteLength(JSON.stringify(shed), "utf-8")).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    // Closed ids are the least load-bearing state, so they go first...
    expect(shed.closedToolIds.length).toBeLessThan(oversized.closedToolIds.length);
    // ...and the open tools -- the only state a reader renders -- survive longest.
    expect(shed.openTools.length).toBeGreaterThan(0);
    expect(shed.sessionId).toBe(SESSION);

    // A record whose REQUIRED fields alone blow the bound cannot be written at
    // all: a partial write would produce a file the bounded reader refuses.
    expect(serializePresence({ ...oversized, sessionId: "s".repeat(MAX_RECORD_BYTES * 2) })).toBeNull();
  });

  it("a long turn keeps the record under the reader's size bound", () => {
    let rec = start();
    for (let i = 0; i < 200; i++) {
      rec = pre(rec, `tool-use-id-${"x".repeat(100)}-${i}`, "NotebookEdit".padEnd(60, "z"), "2026-08-20T12:00:01.000Z", {
        target: "a/".repeat(90) + "file.txt",
        agentId: `agent-${i}`,
      });
      if (i % 2 === 0) rec = post(rec, `tool-use-id-${"x".repeat(100)}-${i}`);
    }
    const text = serializePresence(rec);
    expect(text).not.toBeNull();
    expect(Buffer.byteLength(text!, "utf-8")).toBeLessThanOrEqual(MAX_RECORD_BYTES);
  });
});

describe("presence parsing (ISS-1022)", () => {
  it("round-trips a written record", () => {
    const rec = pre(start(), "tu_1", "Read", "2026-08-20T12:00:01.000Z", { target: "src/main.ts" });
    const parsed = parsePresenceRecord(serializePresence(rec)!, SESSION);
    expect(parsed).toEqual({ ...rec, schemaVersion: PRESENCE_SCHEMA_VERSION });
  });

  it("refuses a record belonging to a different session", () => {
    expect(parsePresenceRecord(serializePresence(start())!, "someone-else")).toBeNull();
  });

  it("returns null for corrupt or non-object content", () => {
    for (const bad of ["", "{", "null", "[]", '"a string"', "123"]) {
      expect(parsePresenceRecord(bad, SESSION)).toBeNull();
    }
  });

  /** One malformed tool entry must not erase a live session's record. */
  it("drops malformed open-tool entries without failing the whole parse", () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      sessionId: SESSION,
      generation: 3,
      startedAt: "2026-08-20T12:00:00.000Z",
      lastEventAt: "2026-08-20T12:00:05.000Z",
      openTools: [
        { id: "good", tool: "Read", target: null, startedAt: "2026-08-20T12:00:01.000Z", agentId: null },
        { id: "no-tool-name", startedAt: "2026-08-20T12:00:01.000Z" },
        "not an object",
        null,
      ],
      closedToolIds: ["ok", 42, null],
      agentIds: [],
      suppressed: false,
      endedAt: null,
    });
    const parsed = parsePresenceRecord(text, SESSION)!;
    expect(parsed.openTools.map((t) => t.id)).toEqual(["good"]);
    expect(parsed.closedToolIds).toEqual(["ok"]);
    expect(parsed.generation).toBe(3);
  });

  it("a record with no usable startedAt is treated as absent", () => {
    const text = JSON.stringify({ sessionId: SESSION, startedAt: "not a date" });
    expect(parsePresenceRecord(text, SESSION)).toBeNull();
  });
});
