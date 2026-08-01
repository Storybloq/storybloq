/**
 * T-450 step 5, commit B: the disposition derivation the baseline left open.
 *
 * WHY THIS FILE IS SEPARATE. The suite in
 * `cancellation-transition-characterization.test.ts` is commit A of a two-commit
 * protocol: it was written and green against the SHIPPED code, then left
 * unedited across the extraction, which is the whole reason it counts as
 * evidence. Adding a test to it now -- after the extraction, to cover something
 * the extraction made me think about -- would quietly convert that baseline into
 * a suite written against the refactor's output. So this lands beside it instead.
 *
 * WHAT IT PINS. Two properties of the caller's disposition derivation, both of
 * which survived mutation testing against every other suite. They live together
 * because both are about how the derivation uses the project lock, and both need
 * the same `withProjectLock` instrumentation.
 *
 * ONE -- the settled flag. The extraction replaced two booleans (`ticketReleased`,
 * `ticketConflict`) with a `TicketDisposition` union chosen inside the project
 * lock and a `settled` flag guarding the catch:
 *
 *     } catch {
 *       if (!settled) disposition = { kind: "failed", ticketId };
 *     }
 *
 * I told the code reviewer this preserves the old behavior "across throws before,
 * during, and after disposition selection". Mutation testing then showed that
 * removing `!settled` -- so that ANY throw overwrites an already-decided arm --
 * left every test green. The claim was true but unproven, which is the same
 * category of unproven self-assessment L-039 was filed about. A throw arriving
 * after the lock callback has already released a ticket must not be reported as
 * a failure to release: the ticket is released on disk either way, and an audit
 * record saying otherwise is a lie about a write that actually happened.
 *
 * Both directions are here, but they are NOT equally strong, and an earlier
 * version of this comment claimed they were. It said the pair forces `settled`
 * to track whether an arm was chosen. It does not. `auditOf` maps `unchanged`
 * and `failed` to the SAME triple, and the pre-try initializer is already
 * `unchanged/missing`, so hardwiring `settled` to true leaves an externally
 * identical payload in the early-throw case: same three fields, same untouched
 * ticket. The early-throw test is therefore CHARACTERIZATION of the legacy
 * false/false payload, not a discriminator. Only the late-throw case has
 * observable consequences, and it is the one that kills the mutant.
 *
 * The hardwired-true mutant is recorded as an audited equivalent in the harness
 * (CT54) rather than left implicit, so the limit is written down where the
 * figure is produced instead of only here.
 *
 * TWO -- the empty-id short circuit. `ticket.id` is `z.string()` with no
 * `.min(1)`, so an empty string is schema-valid and can reach here. The
 * derivation answers it without taking the project lock. Deleting that branch
 * produces a BYTE-IDENTICAL audit payload: the fallthrough looks up a ticket
 * named "" , finds nothing, and lands on the same unchanged arm with the same
 * three fields. So no payload assertion can tell the two apart, which is why
 * this one went unnoticed. What differs is that the mutant acquires a project
 * lock to learn nothing. The lock is the observable, so the lock is what gets
 * asserted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where the injected throw lands relative to the lock callback. `after` is the
 * case the mutant survived; `before` is its complement. `off` for the control.
 */
const THROW: { at: "off" | "before" | "after" } = { at: "off" };

/** How many times the project lock was acquired during a cancellation. */
const LOCK = { calls: 0 };

vi.mock("../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-loader.js")>();
  return {
    ...actual,
    // DEFENSIVE CONTRACT-VIOLATION INJECTION. `withProjectLock` does not promise
    // to throw after a successful callback; this deliberately breaks that to put
    // the caller's catch in the exact position the mutant exploits. Everything
    // else delegates, so the release itself is the real one.
    withProjectLock: vi.fn(async (...args: Parameters<typeof actual.withProjectLock>) => {
      LOCK.calls += 1;
      if (THROW.at === "before") throw new Error("injected: lock acquisition failed");
      const out = await actual.withProjectLock(...args);
      if (THROW.at === "after") throw new Error("injected: lock teardown failed after the arm was decided");
      return out;
    }),
  };
});

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

function writeTicket(root: string): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-08-01",
    completedDate: null, blockedBy: [],
  }));
}

function plantSession(root: string, ticketId = "T-001"): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: "guided",
    ticket: { id: ticketId, title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

/** The audit triple, read from the `cancelled` entry in events.log. */
function auditTriple(sessDir: string): Record<string, unknown> {
  const raw = readFileSync(join(sessDir, "events.log"), "utf-8");
  const events = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  const cancelled = events.filter((e) => e.type === "cancelled");
  expect(cancelled, "exactly one cancelled event").toHaveLength(1);
  return (cancelled[0]?.data as Record<string, unknown>) ?? {};
}

/** Read straight off disk, which is a SOURCE INDEPENDENT of the audit payload. */
function ticketStatus(root: string): unknown {
  return (JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8")) as Record<string, unknown>).status;
}

describe("T-450: the settled flag decides whether a throw can overwrite a chosen arm", () => {
  let root: string;

  beforeEach(() => {
    THROW.at = "off";
    LOCK.calls = 0;
    root = mkdtempSync(join(tmpdir(), "sb-settled-"));
    setupProject(root);
    writeTicket(root);
  });

  afterEach(() => {
    THROW.at = "off";
    killSidecarsInRoot(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("control: with no throw the release is reported as a release", async () => {
    // Establishes that this fixture actually reaches the release arm. Without
    // this, the two tests below could both be passing because the release never
    // happened at all, and they would still look like they proved something.
    const { sessionId, sessDir } = plantSession(root);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    expect(ticketStatus(root), "the ticket really was released").toBe("open");
    const audit = auditTriple(sessDir);
    expect(audit.ticketId).toBe("T-001");
    expect(audit.ticketReleased).toBe(true);
    expect(audit.ticketConflict).toBe(false);
  });

  it("a throw AFTER the arm is decided leaves the decided arm standing", async () => {
    // COMPATIBILITY INVARIANT. The release already happened -- `writeTicketUnlocked`
    // committed it inside the lock -- so the audit must keep saying so. Reporting
    // `ticketReleased: false` here would deny a write that is on disk, and an
    // operator reading that record would go looking for a ticket to release that
    // is already open.
    THROW.at = "after";
    const { sessionId, sessDir } = plantSession(root);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    // The independent source first: the throw did not roll the release back.
    expect(ticketStatus(root), "the release survived the injected throw").toBe("open");
    const audit = auditTriple(sessDir);
    expect(audit.ticketId).toBe("T-001");
    expect(audit.ticketReleased, "a late throw must not rewrite a completed release as a failure").toBe(true);
    expect(audit.ticketConflict).toBe(false);
  });

  it("a throw BEFORE any arm is decided preserves the legacy unreleased payload", async () => {
    // CHARACTERIZATION, and deliberately not claimed as more than that. This
    // pins the payload a caller sees when the release fails outright: the
    // ticket is named, nothing is reported as released, and no conflict is
    // claimed. It cannot distinguish the `failed` arm from the `unchanged`
    // initializer, because both produce this exact triple; see the header.
    THROW.at = "before";
    const { sessionId, sessDir } = plantSession(root);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    // The untouched ticket confirms that reporting `released: false` is
    // consistent with what is actually on disk. It does NOT distinguish the
    // `failed` arm from the `unchanged` initializer; nothing observable can,
    // which is the point made in the header.
    expect(ticketStatus(root), "the callback never ran").toBe("inprogress");
    const audit = auditTriple(sessDir);
    expect(audit.ticketId).toBe("T-001");
    expect(audit.ticketReleased).toBe(false);
    expect(audit.ticketConflict).toBe(false);
  });

  it("an empty ticket id is answered without taking the project lock", async () => {
    // COMPATIBILITY INVARIANT. The payload here is indistinguishable from the
    // fallthrough's, so the lock is the only thing that separates them. An empty
    // id is not a ticket to look up; taking a lock to discover that is work done
    // on behalf of a value already known to be unusable.
    const { sessionId, sessDir } = plantSession(root, "");
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    expect(LOCK.calls, "no lock is taken for an empty ticket id").toBe(0);
    const audit = auditTriple(sessDir);
    expect(audit.ticketId, "the empty id is reported as itself, not as absent").toBe("");
    expect(audit.ticketReleased).toBe(false);
    expect(audit.ticketConflict).toBe(false);
    expect(ticketStatus(root), "and no ticket was touched").toBe("inprogress");
  });

  it("a real ticket id DOES take the project lock", async () => {
    // The complement, and the reason the assertion above is not vacuous: if the
    // derivation never locked at all, `LOCK.calls === 0` would prove nothing.
    const { sessionId } = plantSession(root);
    await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(LOCK.calls, "a resolvable id is looked up under the lock").toBe(1);
  });

  it("cancellation still completes when the release throws", async () => {
    // DOCUMENTED CURRENT HAZARD, not an endorsement: a ticket that could not be
    // released does not stop the session from being published as cancelled. The
    // tail is single-attempt, so there is no route back to retry the release.
    // Step 6 is where the durable protocol lands; this records today's behavior
    // so a change to it is visible.
    THROW.at = "before";
    const { sessionId, sessDir } = plantSession(root);
    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const state = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    expect(state.state).toBe("SESSION_END");
    expect(state.status).toBe("completed");
    expect(state.terminationReason).toBe("cancelled");
  });
});
