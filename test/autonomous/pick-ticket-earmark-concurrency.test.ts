/**
 * T-475 section 10: the earmark CAS concurrency matrix, run through genuine
 * separate OS processes (not in-process Promise.all) racing the real
 * `.story/.lock` filesystem lock -- the same discipline
 * project-lock-race-worker.ts already established for the lock primitive
 * itself. A ready/go barrier (each worker signals readiness, the parent
 * releases one barrier file) makes the overlap real rather than accidental.
 *
 * Three race shapes, for both the ticket and issue choke points:
 * reserve-vs-reserve, reserve-vs-pick, pick-vs-pick.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, "../core/fixtures/earmark-race-worker.ts");

interface WorkerOutcome {
  outcome: "placed" | "acquired" | "refused" | "missing" | "error" | "barrier-timeout";
  earmark?: unknown;
  holder?: unknown;
  message?: string;
  pid?: number;
}

function spawnWorker(
  root: string,
  itemKind: "ticket" | "issue",
  itemId: string,
  barrierPath: string,
  resultPath: string,
  readyPath: string,
  mode: "reserve" | "pick",
  sessionId: string,
  role: string,
) {
  return fork(
    WORKER_PATH,
    [root, itemKind, itemId, barrierPath, resultPath, readyPath, mode, sessionId, role],
    { stdio: "ignore", execArgv: ["--import", "tsx"] },
  );
}

async function waitForExit(child: ReturnType<typeof fork>): Promise<void> {
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function waitForReady(readyPath: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (true) {
    try { readFileSync(readyPath); return; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`worker never signaled ready: ${readyPath}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function readResult(resultPath: string): WorkerOutcome {
  return JSON.parse(readFileSync(resultPath, "utf-8"));
}

describe("earmark CAS concurrency matrix (T-475 section 10)", () => {
  let root: string;
  const tempDirs: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "earmark-race-"));
    tempDirs.push(root);
    await initProject(root, { name: "earmark-race" });
  });

  afterEach(() => {
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function createTicket(): Promise<string> {
    const result = await handleTicketCreate(
      { title: "race ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json",
      root,
    );
    return JSON.parse(result.output).data.id as string;
  }

  async function createIssue(): Promise<string> {
    const result = await handleIssueCreate(
      { title: "race issue", severity: "medium", impact: "", components: [], relatedTickets: [], location: [] },
      "json",
      root,
    );
    return JSON.parse(result.output).data.id as string;
  }

  async function race(
    itemKind: "ticket" | "issue",
    itemId: string,
    workers: Array<{ mode: "reserve" | "pick"; sessionId: string; role: string }>,
  ): Promise<WorkerOutcome[]> {
    const barrierPath = join(root, `barrier-${Date.now()}-${Math.random()}`);
    const specs = workers.map((w, i) => ({
      ...w,
      resultPath: join(root, `result-${i}-${Date.now()}-${Math.random()}.json`),
      readyPath: join(root, `ready-${i}-${Date.now()}-${Math.random()}.json`),
    }));
    const children = specs.map((s) =>
      spawnWorker(root, itemKind, itemId, barrierPath, s.resultPath, s.readyPath, s.mode, s.sessionId, s.role),
    );
    await Promise.all(specs.map((s) => waitForReady(s.readyPath)));
    writeFileSync(barrierPath, "go");
    await Promise.all(children.map(waitForExit));
    return specs.map((s) => readResult(s.resultPath));
  }

  const SESSION_A = "11111111-1111-4111-8111-111111111111";
  const SESSION_B = "22222222-2222-4222-8222-222222222222";

  describe.each([
    ["ticket", () => createTicket()] as const,
    ["issue", () => createIssue()] as const,
  ])("%s path", (itemKind, createItem) => {
    it("reserve vs. reserve: exactly one wins, loser's conflict names the winner", async () => {
      const itemId = await createItem();
      const results = await race(itemKind, itemId, [
        { mode: "reserve", sessionId: "n/a", role: "worker" },
        { mode: "reserve", sessionId: "n/a", role: "worker" },
      ]);

      const placed = results.filter((r) => r.outcome === "placed");
      const refused = results.filter((r) => r.outcome === "refused");
      expect(placed.length).toBe(1);
      expect(refused.length).toBe(1);
      expect((refused[0]!.holder as { stage: string }).stage).toBe("reserved");
    });

    it("reserve(role the picker does not hold) vs. pick: exactly one of {reservation, pick} lands, never both -- a genuine role-mismatch conflict", async () => {
      // A reservation for the SAME role a pick would hold is not adversarial
      // at all under R5 -- picking up your own role's reservation is the
      // intended handoff, not a race (both can legitimately succeed in
      // sequence: reserve places, then pick converts on top of it). The
      // conflict this scenario actually needs to prove is a reservation for
      // a DIFFERENT role racing a same-role pick on the same item.
      const itemId = await createItem();
      const results = await race(itemKind, itemId, [
        { mode: "reserve", sessionId: "n/a", role: "pen" },
        { mode: "pick", sessionId: SESSION_A, role: "worker" },
      ]);

      const finalRaw = itemKind === "ticket"
        ? JSON.parse(readFileSync(join(root, ".story", "tickets", `${itemId}.json`), "utf-8"))
        : JSON.parse(readFileSync(join(root, ".story", "issues", `${itemId}.json`), "utf-8"));
      const finalEarmark = finalRaw.earmark ?? null;

      const reserveResult = results[0]!;
      const pickResult = results[1]!;

      if (itemKind === "issue") {
        // The issue path's pick ALWAYS makes an observable write (status ->
        // inprogress) even against an unearmarked item, so this race is
        // fully deterministic regardless of lock-acquisition order: whichever
        // transaction runs second always observes the first's effect and
        // refuses. Exactly one of the two ever wins.
        const winners = results.filter((r) => r.outcome === "placed" || r.outcome === "acquired");
        const refused = results.filter((r) => r.outcome === "refused");
        expect(winners.length).toBe(1);
        expect(refused.length).toBe(1);
        if (reserveResult.outcome === "placed") {
          expect(pickResult.outcome).toBe("refused");
          expect(finalRaw.status).toBe("open");
          expect(finalEarmark?.stage).toBe("reserved");
          expect(finalEarmark?.holderRole).toBe("pen");
        } else {
          expect(reserveResult.outcome).toBe("refused");
          expect(finalRaw.status).toBe("inprogress");
          expect(finalEarmark).toBeNull();
        }
        return;
      }

      // The ticket path's choke point makes NO write at all when picking an
      // unearmarked ticket (status/claim acquisition stays plan.ts's own,
      // untouched, separate transaction -- R4's fence). This makes the
      // reservation UNCONDITIONALLY win regardless of race order: if reserve
      // reads/writes first, pick observes the role-mismatched reservation
      // and is correctly refused; if pick reads first (nothing to see yet),
      // it succeeds as a complete no-op that changes nothing, leaving the
      // reservation free to land immediately after with nothing to conflict
      // with. Either way, the reservation always lands and the earmark is
      // never internally split.
      expect(reserveResult.outcome).toBe("placed");
      expect(["acquired", "refused"]).toContain(pickResult.outcome);
      expect(finalEarmark).not.toBeNull();
      expect(finalEarmark.stage).toBe("reserved");
      expect(finalEarmark.holderRole).toBe("pen");
      if (pickResult.outcome === "refused") {
        expect((pickResult.holder as { holderRole: string }).holderRole).toBe("pen");
      }
    });

    it("pick vs. pick on a pre-earmarked item: the assigned session wins, the other is refused with the holder named", async () => {
      const itemId = await createItem();
      // Pre-place an assignment to SESSION_A via a reservation-then-convert
      // sequence (mirrors how a real assignment would exist before the race).
      const setup = await race(itemKind, itemId, [{ mode: "reserve", sessionId: "n/a", role: "worker" }]);
      expect(setup[0]!.outcome).toBe("placed");
      // Convert to assigned(SESSION_A) via a real pick before the race starts.
      const preAcquire = await race(itemKind, itemId, [{ mode: "pick", sessionId: SESSION_A, role: "worker" }]);
      expect(preAcquire[0]!.outcome).toBe("acquired");

      const results = await race(itemKind, itemId, [
        { mode: "pick", sessionId: SESSION_A, role: "worker" },
        { mode: "pick", sessionId: SESSION_B, role: "worker" },
      ]);

      const acquired = results.filter((r) => r.outcome === "acquired");
      const refused = results.filter((r) => r.outcome === "refused");
      // SESSION_A already owns the assignment (no-op pass, "acquired" with
      // no new write); SESSION_B is refused, holder named as SESSION_A.
      expect(acquired.length).toBe(1);
      expect(refused.length).toBe(1);
      expect((refused[0]!.holder as { holderSession: string }).holderSession).toBe(SESSION_A);

      const finalRaw = itemKind === "ticket"
        ? JSON.parse(readFileSync(join(root, ".story", "tickets", `${itemId}.json`), "utf-8"))
        : JSON.parse(readFileSync(join(root, ".story", "issues", `${itemId}.json`), "utf-8"));
      expect(finalRaw.earmark.holderSession).toBe(SESSION_A);
    });
  });
});
