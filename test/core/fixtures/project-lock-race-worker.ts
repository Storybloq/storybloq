// ISS-942: real cross-process worker for the steal-path multi-process race
// test. Spawned via tsx as a genuinely separate OS process (not an in-process
// Promise.all), so it can exercise the exact syscall-level interleaving
// (unlinkSync/linkSync inside the steal-lock's critical section) that
// same-process concurrent async calls cannot: within one Node process,
// consecutive synchronous fs calls with no `await` between them execute
// atomically with respect to other same-process work, so they can never
// actually interleave -- only truly separate processes can race there.
//
// argv: [lockPath, barrierPath, resultPath, readyPath, holdMs, deadlineMs]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { acquireProjectLockAsync, releaseProjectLock } from "../../../src/core/project-lock.js";

async function main(): Promise<void> {
  const [, , lockPath, barrierPath, resultPath, readyPath, holdMsRaw, deadlineMsRaw] = process.argv;
  const holdMs = Number(holdMsRaw ?? "150");
  const deadlineMs = Number(deadlineMsRaw ?? "5000");

  // Signal readiness BEFORE waiting on the barrier, so the parent can confirm
  // every worker has survived its tsx cold start and reached the wait loop
  // before releasing the barrier. A fixed sleep in the parent cannot make
  // this guarantee under load (a slow-to-start worker would simply race late,
  // reducing genuine simultaneous contention without failing the test).
  writeFileSync(readyPath, "ready");

  // Wait for the barrier file so every spawned worker starts racing as close
  // to simultaneously as possible, maximizing genuine OS-level contention.
  const barrierDeadline = Date.now() + 10_000;
  while (!existsSync(barrierPath)) {
    if (Date.now() > barrierDeadline) {
      writeFileSync(resultPath, JSON.stringify({ outcome: "barrier-timeout" }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  try {
    const handle = await acquireProjectLockAsync(lockPath, { deadlineMs, pollMs: 10 });
    // Immediate cross-check against the CURRENT on-disk state (not our own
    // handle's own expectation): this is the direct double-grant probe. A
    // caller whose returned handle does not match what is actually on disk
    // right now proves two winners existed simultaneously.
    let verified = false;
    try {
      const onDisk = JSON.parse(readFileSync(lockPath, "utf-8")) as { token?: string };
      verified = onDisk.token === handle.token;
    } catch {
      verified = false;
    }
    writeFileSync(resultPath, JSON.stringify({ outcome: "acquired", token: handle.token, verified, pid: process.pid }));
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    releaseProjectLock(handle);
  } catch (err) {
    writeFileSync(
      resultPath,
      JSON.stringify({ outcome: "failed", message: err instanceof Error ? err.message : String(err), pid: process.pid }),
    );
  }
}

main();
