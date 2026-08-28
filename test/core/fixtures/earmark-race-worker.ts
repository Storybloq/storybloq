// T-475: real cross-process worker for the earmark CAS concurrency matrix.
// Spawned via tsx as a genuinely separate OS process (mirroring
// project-lock-race-worker.ts's pattern) -- `.story/.lock` is a real
// cross-process filesystem lock, and same-process concurrent async calls
// cannot exercise the syscall-level interleaving only truly separate
// processes can race through.
//
// argv: [root, itemKind, itemId, barrierPath, resultPath, readyPath, mode, sessionId, role]
// mode: "reserve" | "pick"
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { withProjectLock, writeTicketUnlocked, writeIssueUnlocked } from "../../../src/core/project-loader.js";
import { tryAcquireEarmark, canPlaceEarmark } from "../../../src/core/earmarks.js";
import type { Earmark, EarmarkRole } from "../../../src/models/types.js";

async function main(): Promise<void> {
  const [, , root, itemKind, itemId, barrierPath, resultPath, readyPath, mode, sessionId, role] = process.argv;

  writeFileSync(readyPath, "ready");

  const barrierDeadline = Date.now() + 10_000;
  while (!existsSync(barrierPath)) {
    if (Date.now() > barrierDeadline) {
      writeFileSync(resultPath, JSON.stringify({ outcome: "barrier-timeout" }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  try {
    let outcome: Record<string, unknown> = {};
    await withProjectLock(root, { strict: false }, async ({ state }) => {
      const fresh = itemKind === "ticket"
        ? state.ticketByID(itemId)
        : state.issues.find((i) => i.id === itemId);
      if (!fresh) { outcome = { outcome: "missing" }; return; }

      if (mode === "pick") {
        const decision = tryAcquireEarmark(fresh.earmark, sessionId!, "worker");
        if (!decision.ok) {
          outcome = { outcome: "refused", holder: decision.holder, pid: process.pid };
          return;
        }
        if (itemKind === "ticket") {
          if (decision.write) await writeTicketUnlocked({ ...fresh, earmark: decision.write } as never, root);
        } else {
          await writeIssueUnlocked({ ...fresh, status: "inprogress", ...(decision.write ? { earmark: decision.write } : {}) } as never, root);
        }
        outcome = { outcome: "acquired", earmark: decision.write ?? fresh.earmark, pid: process.pid };
        return;
      }

      // mode === "reserve"
      const candidate: Earmark = {
        stage: "reserved",
        reservedBy: { client: "claude", id: `race-${process.pid}` },
        arrangementId: "a-0123456789abcdef",
        since: new Date().toISOString(),
        holderRole: (role ?? "worker") as EarmarkRole,
        holderSession: null,
      } as Earmark;
      const decision = canPlaceEarmark(fresh.earmark, fresh.status, candidate);
      if (!decision.ok) {
        outcome = { outcome: "refused", holder: decision.holder, pid: process.pid };
        return;
      }
      if (itemKind === "ticket") {
        await writeTicketUnlocked({ ...fresh, earmark: decision.earmark } as never, root);
      } else {
        await writeIssueUnlocked({ ...fresh, earmark: decision.earmark } as never, root);
      }
      outcome = { outcome: "placed", earmark: decision.earmark, pid: process.pid };
    });
    writeFileSync(resultPath, JSON.stringify(outcome));
  } catch (err) {
    writeFileSync(
      resultPath,
      JSON.stringify({ outcome: "error", message: err instanceof Error ? err.message : String(err), pid: process.pid }),
    );
  }
}

main();
