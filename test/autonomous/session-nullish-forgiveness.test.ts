/**
 * Null is forgiven exactly where absence is (ISS-907, N-097 operator 4).
 *
 * A hand-edit or a version-skewed writer stores `null` where this build omits
 * the field. For a declared-optional scalar the two forms are semantically
 * identical, yet `.optional()` rejects null, so one cosmetic difference fails
 * the WHOLE state.json parse and the session becomes unreadable (the ISS-902
 * escalation class). Operator 4's concrete case: `codexUnavailableSince
 * expected string, received null` cost a 20-minute archaeology.
 *
 * The forgiveness is deliberately narrow, and all three limits are pinned
 * below rather than left to the docblock. Required fields still reject null:
 * a null `startedAt` is genuine damage, not skew, and forgiving it would
 * conceal the difference. Fields already `.nullable()` keep their meaningful
 * null. Optional CONTAINERS (objects, arrays, records) are untouched -- null
 * there is a shape question, not a scalar-presence question.
 *
 * TRAP (recorded on the filing): SessionStateSchema is `.passthrough()`, so a
 * probe using an UNKNOWN key passes before AND after and proves nothing. Every
 * probe below targets a DECLARED field.
 *
 * The helper's whole correctness sits in `??` rather than `||`, so one test
 * exists purely to kill that mutant; and one test drives a real state.json
 * through `session list` rather than `safeParse`, because the acceptance
 * criterion is that the OPERATOR SURFACE stops calling the session damaged.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStateSchema, parseSessionState } from "../../src/autonomous/session-types.js";
import {
  createSession,
  readSession,
  readSessionStrict,
  listAllSessionsDetailed,
} from "../../src/autonomous/session.js";
import { handleSessionList } from "../../src/cli/commands/session.js";
import { nextReviewer } from "../../src/autonomous/review-depth.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A real, schema-valid state to mutate -- hand-built fixtures drift. */
function realState(): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "storybloq-nullish-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  const s = createSession(root, "default", "ws-1");
  return JSON.parse(
    readFileSync(join(root, ".story", "sessions", s.sessionId, "state.json"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("declared-optional scalars forgive null (ISS-907)", () => {
  it("parses codexUnavailableSince: null -- operator 4's exact failure -- and reads it as undefined", () => {
    const r = SessionStateSchema.safeParse({ ...realState(), codexUnavailableSince: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.codexUnavailableSince).toBeUndefined();
  });

  it("forgives null on nested optional scalars: ticket.displayId and ticket.lastPlanHash", () => {
    const r = SessionStateSchema.safeParse({
      ...realState(),
      ticket: {
        id: "t-abc",
        displayId: null,
        title: "A ticket",
        claimed: false,
        lastPlanHash: null,
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ticket?.displayId).toBeUndefined();
      expect(r.data.ticket?.lastPlanHash).toBeUndefined();
      expect(r.data.ticket?.title).toBe("A ticket");
    }
  });

  it("forgives null inside array elements: completedTickets timing and review codexSessionId", () => {
    const r = SessionStateSchema.safeParse({
      ...realState(),
      completedTickets: [
        {
          id: "t-abc",
          displayId: null,
          title: null,
          commitHash: null,
          startedAt: null,
          completedAt: null,
        },
      ],
      reviews: {
        plan: [
          {
            round: 1,
            reviewer: "codex",
            verdict: "approve",
            findingCount: 0,
            criticalCount: 0,
            unresolvedCriticalCount: null,
            majorCount: 0,
            suggestionCount: 0,
            codexSessionId: null,
            timestamp: "2026-07-30T00:00:00.000Z",
          },
        ],
        code: [],
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.completedTickets[0]!.completedAt).toBeUndefined();
      expect(r.data.reviews.plan[0]!.codexSessionId).toBeUndefined();
      expect(r.data.reviews.plan[0]!.unresolvedCriticalCount).toBeUndefined();
    }
  });

  it("forgives null on lease.workspaceId while the required lease timestamps still reject it", () => {
    const base = realState();
    const lease = base.lease as Record<string, unknown>;

    const forgiven = SessionStateSchema.safeParse({
      ...base,
      lease: { ...lease, workspaceId: null },
    });
    expect(forgiven.success).toBe(true);

    const damaged = SessionStateSchema.safeParse({
      ...base,
      lease: { ...lease, lastHeartbeat: null },
    });
    expect(damaged.success).toBe(false);
  });

  it("still rejects null on a required field: startedAt null is damage, not skew", () => {
    const r = SessionStateSchema.safeParse({ ...realState(), startedAt: null });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "startedAt");
      expect(issue).toBeDefined();
    }
  });

  it("does not widen optional CONTAINERS: objects, arrays and records all still fail on null", () => {
    // The forgiveness is for scalar presence. Null on a container is a shape
    // corruption and stays visible as one. Arrays and records are asserted
    // alongside the object because the exclusion covers all three, and a
    // future sweep that widened only the arrays would otherwise pass.
    const base = realState();
    for (const field of ["ticket", "resolvedPipeline", "resolvedStages", "verificationCounters"]) {
      const r = SessionStateSchema.safeParse({ ...base, [field]: null });
      expect(r.success, `${field}: null must not parse`).toBe(false);
    }
  });

  it("keeps write semantics: a round-tripped state carries no null for forgiven fields", () => {
    const r = SessionStateSchema.safeParse({ ...realState(), codexUnavailableSince: null });
    expect(r.success).toBe(true);
    if (r.success) {
      // Re-serializing the PARSED state must not reintroduce the null -- the
      // normalization is on read, and what this build writes is the omitted form.
      expect(JSON.stringify(r.data)).not.toContain('"codexUnavailableSince":null');
    }
  });

  it("discards ONLY null, never a falsy-but-present value", () => {
    // The helper is `v ?? undefined`, and the whole of its correctness sits in
    // that operator. Written `v || undefined` it still passes every test above,
    // because none of them stores a falsy non-null -- so this is the one that
    // actually pins the choice. `false` and `0` are real, stored answers here:
    // codexUnavailable false means "codex is fine", not "nobody asked".
    const r = SessionStateSchema.safeParse({
      ...realState(),
      codexUnavailable: false,
      contextPressure: {
        level: "low",
        guideCallCount: 0,
        ticketsCompleted: 0,
        compactionCount: 0,
        eventsLogBytes: 0,
        workItemsAtLastCompaction: 0,
        eventsLogBytesAtLastCompaction: 0,
      },
      stealReason: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.codexUnavailable).toBe(false);
      expect(r.data.contextPressure.workItemsAtLastCompaction).toBe(0);
      expect(r.data.contextPressure.eventsLogBytesAtLastCompaction).toBe(0);
      expect(r.data.stealReason).toBe("");
    }
  });

  it("leaves .nullable() fields alone: their null is the answer, not an absence", () => {
    // The third scope claim, and the one a future sweep is most likely to
    // break. These fields DECLARE null as their default and distinguish it
    // from absence, so `forgiveNull` must never reach them.
    const base = realState();
    const r = SessionStateSchema.safeParse({
      ...base,
      ticketStartedAt: null,
      preCompactState: null,
      finalizeCheckpoint: null,
      limitEventId: null,
      git: { ...(base.git as Record<string, unknown>), branch: null, mergeBase: null },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.ticketStartedAt).toBeNull();
      expect(r.data.preCompactState).toBeNull();
      expect(r.data.finalizeCheckpoint).toBeNull();
      expect(r.data.limitEventId).toBeNull();
      expect(r.data.git.branch).toBeNull();
      expect(r.data.git.mergeBase).toBeNull();
    }
  });
});

describe("widening the timestamp does not strand the codex flag it is paired with (ISS-918)", () => {
  /**
   * `codexUnavailable` and `codexUnavailableSince` are read as a PAIR
   * (review-depth.ts: `timestamp ? withinTTL(timestamp) : !!boolean`). The
   * timestamp carries the TTL; the boolean is a pre-ISS-110 shim nothing ever
   * clears. So boolean-without-usable-timestamp blocks codex FOREVER.
   *
   * Forgiving null on the timestamp alone would have made that combination
   * reachable for the first time, and via the most natural hand-edit there is:
   * clearing a stale timestamp to un-stick codex would have stuck it
   * permanently instead. The preprocess step is what prevents that, and it
   * works because it runs on the RAW object -- an explicit null is still
   * distinguishable from a legacy absent field at that point, so ISS-098's
   * sticky semantics survive untouched for states that genuinely predate the
   * timestamp.
   *
   * These go through `parseSessionState`, not `SessionStateSchema.safeParse`,
   * because that is the seam every disk read uses and the only one that
   * applies the repair. Parsing the bare schema here passes the ISS-907
   * assertions and fails these -- which is the point: the schema alone does
   * not carry this fix, and a future caller that reaches past the seam
   * reintroduces the trap.
   */
  it("clears the flag when the timestamp is EXPLICITLY nulled, so codex is not blocked forever", () => {
    const r = parseSessionState({
      ...realState(),
      codexUnavailable: true,
      codexUnavailableSince: null,
    });
    // ISS-907: it reads instead of bricking the session.
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.codexUnavailableSince).toBeUndefined();
    // ISS-918: and the orphaned sticky flag went with it.
    expect(r.data.codexUnavailable).toBe(false);
    expect(
      nextReviewer([], ["codex", "agent"], r.data.codexUnavailable, r.data.codexUnavailableSince),
    ).toBe("codex");
  });

  it("leaves a genuine pre-ISS-110 state alone: absent timestamp keeps its sticky block", () => {
    // The discrimination that makes the fix safe. This state never had a
    // timestamp written -- it is not a hand-edit -- so ISS-098's behavior is
    // preserved exactly, and nothing about review-backend selection changed.
    const base = realState();
    delete base.codexUnavailableSince;
    const r = parseSessionState({ ...base, codexUnavailable: true });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.codexUnavailable).toBe(true);
    expect(r.data.codexUnavailableSince).toBeUndefined();
    expect(
      nextReviewer([], ["codex", "agent"], r.data.codexUnavailable, r.data.codexUnavailableSince),
    ).toBe("agent");
  });

  it("does not mint a flag that was never there", () => {
    // Nulling the timestamp on a state with no boolean must not ADD one. The
    // preprocess repairs a contradiction; it does not invent state.
    const base = realState();
    delete base.codexUnavailable;
    const r = parseSessionState({ ...base, codexUnavailableSince: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.codexUnavailable).toBeUndefined();
  });

  it("does not launder a malformed flag: an invalid codexUnavailable still fails loudly", () => {
    // The repair must not become a corruption filter. A string here is real
    // damage and has to keep naming itself, exactly as it would without the
    // null timestamp beside it.
    const r = parseSessionState({
      ...realState(),
      codexUnavailable: "invalid",
      codexUnavailableSince: null,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "codexUnavailable")).toBe(true);
    }
  });

  it("leaves a null flag to the ordinary scalar forgiveness, rather than rewriting it to false", () => {
    // `codexUnavailable: null` is the ISS-907 case, not the ISS-918 one. It
    // must come back undefined (the omitted form this build writes), not a
    // freshly minted `false`.
    const r = parseSessionState({
      ...realState(),
      codexUnavailable: null,
      codexUnavailableSince: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.codexUnavailable).toBeUndefined();
  });

  it("leaves an already-false flag alone", () => {
    const r = parseSessionState({
      ...realState(),
      codexUnavailable: false,
      codexUnavailableSince: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.codexUnavailable).toBe(false);
  });

  it("still honors a live timestamp, and still expires a stale one", () => {
    // The untouched control: the TTL path is the authority and keeps working.
    const live = new Date(Date.now() - 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(nextReviewer([], ["codex", "agent"], true, live)).toBe("agent");
    expect(nextReviewer([], ["codex", "agent"], true, stale)).toBe("codex");
  });
});

describe("the operator surface actually recovers (ISS-907 acceptance)", () => {
  /**
   * The tests above pin the schema. This one pins the THING THAT WAS BROKEN:
   * a state.json on disk carrying operator 4's null no longer reads as a
   * damaged session. Asserting only `safeParse` would leave the acceptance
   * criterion -- "the session stops being unreadable" -- resting on the
   * assumption that nothing between the file and the operator re-rejects it.
   */
  it("reads a session whose state.json carries operator 4's null, and does not list it as damaged", async () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-nullish-e2e-"));
    roots.push(root);
    mkdirSync(join(root, ".story", "sessions"), { recursive: true });
    const created = createSession(root, "default", "ws-1");
    const dir = join(root, ".story", "sessions", created.sessionId);
    const file = join(dir, "state.json");
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...raw, codexUnavailableSince: null }));

    expect(readSession(dir)).not.toBeNull();
    expect(readSessionStrict(dir).ok).toBe(true);

    const detailed = listAllSessionsDetailed(root);
    expect(detailed.damaged).toHaveLength(0);
    expect(detailed.sessions.map((s) => s.state.sessionId)).toEqual([created.sessionId]);

    const out = await handleSessionList(root, { status: "all", format: "text" });
    expect(out).not.toContain("corrupt");
    expect(out).toContain(created.sessionId);
  });
});
