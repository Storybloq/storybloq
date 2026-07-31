/**
 * T-450 / ruling C-2 item 1: the guide call is a registration seam.
 *
 * A server learns its identity from the environment at startup, and for Codex
 * there is nothing there to learn: `setup-skill` injects only
 * `STORYBLOQ_CLIENT=codex`, never a thread id. So a Codex server registers
 * identity-null and, without this seam, stays unattributable for its whole
 * life. Every session it owns would then resolve to `undetermined` with reason
 * `successor-identity-unknown`, which is a permanent, silent loss of the
 * recovery path for one of the two supported clients.
 *
 * The request-scoped `clientTaskId` on a guide call is the only place a CODEX
 * task identity ever appears (Claude's arrives in the startup environment),
 * which is why the seam lives at the very top of `handleAutonomousGuide`,
 * before session lookup and before any refusal. These tests drive the REAL
 * entry point rather than the registry helper: a unit test of
 * `reassertMcpServerIdentity` passes whether or not the guide calls it, so only
 * an end-to-end test pins the wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { liveMcpServers, clearSelfVouch, registerMcpServer, selfVouch } from "../../src/autonomous/mcp-registry.js";
import { serverRegistryBinder } from "../../src/autonomous/mcp-binding.js";
import { mcpProcessRole, __testing } from "../../src/autonomous/liveness.js";

let root: string;
let savedClient: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t450-guide-"));
  fs.mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  savedClient = process.env.STORYBLOQ_CLIENT;
});
afterEach(() => {
  if (savedClient === undefined) delete process.env.STORYBLOQ_CLIENT;
  else process.env.STORYBLOQ_CLIENT = savedClient;
  clearSelfVouch(root);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Read the entry off disk with no vouch to lean on, which is what a reader
 * without our in-process state gets. Same pid and permissions, so it simulates
 * that reader rather than being one.
 */
function onDiskIdentity(): unknown {
  clearSelfVouch(root);
  const seen = liveMcpServers(root);
  const mine = seen.kind === "observed" && seen.servers.find((s) => s.pid === process.pid);
  return mine ? mine.identity : undefined;
}

/**
 * Any guide call at all. The session does not exist, so this refuses; the seam
 * runs first and the refusal is the point, since the seam must not depend on
 * the call succeeding.
 *
 * The refusal is ASSERTED rather than caught. Swallowing it would let a guide
 * that threw before ever reaching the seam pass every test here whose
 * expectation is an ABSENT entry, since absence is also what a call that never
 * ran produces.
 */
async function guide(clientTaskId?: string): Promise<void> {
  const result = await handleAutonomousGuide(root, {
    sessionId: "no-such-session",
    action: "resume",
    ...(clientTaskId === undefined ? {} : { clientTaskId }),
  });
  expect(result.isError).toBe(true);
  expect(String(result.content?.[0]?.text ?? "")).toContain("no-such-session");
}

describe("T-450: a guide call asserts this server's registry identity", () => {
  it("registers an identity a server had no way to learn at startup", async () => {
    process.env.STORYBLOQ_CLIENT = "codex";
    await guide("thread-abc");
    expect(onDiskIdentity()).toEqual({
      client: "codex",
      id: "thread-abc",
      boundAt: expect.any(String),
    });
  });

  it("UPGRADES an entry that registered without one", async () => {
    process.env.STORYBLOQ_CLIENT = "codex";
    registerMcpServer(root, null); // the Codex startup shape
    await guide("thread-abc");
    expect(onDiskIdentity()).toMatchObject({ client: "codex", id: "thread-abc" });
  });

  it("repairs an entry deleted underneath a running server", async () => {
    process.env.STORYBLOQ_CLIENT = "claude";
    registerMcpServer(root, { client: "claude", id: "sess-1", boundAt: "2026-07-30T00:00:00.000Z" });
    fs.rmSync(join(root, ".story", "servers", String(process.pid)));
    await guide("sess-1");
    expect(onDiskIdentity()).toMatchObject({ client: "claude", id: "sess-1" });
  });

  it("a call with no usable identity leaves an existing entry alone", async () => {
    // Guide calls arrive with and without `clientTaskId`. One without must not
    // erase what an earlier one established, or the entry would flap between
    // attributable and unattributable and the verdict with it.
    process.env.STORYBLOQ_CLIENT = "codex";
    delete process.env.CODEX_THREAD_ID;
    registerMcpServer(root, { client: "codex", id: "thread-abc", boundAt: "2026-07-30T00:00:00.000Z" });
    await guide(undefined);
    expect(onDiskIdentity()).toMatchObject({ client: "codex", id: "thread-abc" });
  });

  it("a malformed clientTaskId is not recorded", async () => {
    // `normalizeClientTaskId` gates the value. A rejected one leaves the server
    // unattributable, which suppresses; recording it would publish a claim
    // about who we are on the strength of an unvalidated request field.
    process.env.STORYBLOQ_CLIENT = "codex";
    delete process.env.CODEX_THREAD_ID;
    await guide("not a valid id!");
    expect(onDiskIdentity()).toBeUndefined();

    // Absence only means something if the seam was capable of writing here. A
    // valid id through the identical path proves it was, so the absence above
    // is attributable to the gate rather than to a seam that never ran.
    await guide("thread-abc");
    expect(onDiskIdentity()).toMatchObject({ client: "codex", id: "thread-abc" });
  });

  /**
   * The wiring, driven through the process-wide binder the guide actually
   * calls. `registrationLost` is unit-tested against an isolated binder in the
   * liveness suite; what that cannot show is that the guide REPORTS to it. A
   * verified re-assert that discovers a lost entry and tells nobody leaves this
   * process marked registered and still stamping its pid onto sessions, on the
   * strength of an entry it could not corroborate.
   */
  it("reports a lost registration to the binder instead of swallowing it", async () => {
    process.env.STORYBLOQ_CLIENT = "claude";
    serverRegistryBinder.bind(root);
    try {
      expect(serverRegistryBinder.root).toBe(root);
      expect(mcpProcessRole()).toBe("mcp-registered");

      // A symlink to /dev/null: every write succeeds and nothing lands, so the
      // verified re-assert cannot prove the entry present however often it
      // retries. That is the shape a full disk or a lying filesystem produces.
      const entryPath = join(root, ".story", "servers", String(process.pid));
      fs.rmSync(entryPath, { force: true });
      fs.symlinkSync("/dev/null", entryPath);

      await guide("sess-1");

      expect(serverRegistryBinder.root).toBeNull();
      expect(mcpProcessRole()).toBe("mcp-unregistered");
      expect(serverRegistryBinder.retrying).toBe(true);
    } finally {
      serverRegistryBinder.release();
      __testing.setProcessRole("cli");
    }
  });

  it("a registry that cannot be written never fails the guide call", async () => {
    // Registry maintenance is a side effect of serving, never a precondition.
    //
    // The client is pinned so the seam has an identity to assert. With none,
    // `reassertMcpServerIdentity` returns before touching the filesystem and
    // this would pass without ever reaching the unwritable directory.
    process.env.STORYBLOQ_CLIENT = "claude";
    const blocked = mkdtempSync(join(tmpdir(), "t450-guide-blocked-"));
    fs.chmodSync(blocked, 0o500);
    try {
      // No `.catch` here on purpose: converting a rejection into a resolved
      // value would make this pass on exactly the failure it exists to catch.
      await expect(handleAutonomousGuide(blocked, {
        sessionId: "no-such-session", action: "resume", clientTaskId: "sess-1",
      })).resolves.toBeDefined();
      // The seam genuinely tried: `registerMcpServer` records the vouch before
      // the write can fail, so a vouch for this root is the guide's own evidence
      // that it reached the registry. Without it the assertion above would pass
      // just as well on a guide that skipped registry maintenance entirely.
      expect(selfVouch(blocked)?.identity).toMatchObject({ client: "claude", id: "sess-1" });
      // And the write genuinely failed. The vouch alone cannot show that, since
      // it is recorded before every attempt including the ones that succeed.
      expect(fs.existsSync(join(blocked, ".story", "servers", String(process.pid)))).toBe(false);
    } finally {
      clearSelfVouch(blocked);
      fs.chmodSync(blocked, 0o700);
      rmSync(blocked, { recursive: true, force: true });
    }
  });
});
