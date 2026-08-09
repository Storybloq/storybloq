import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { currentCliVersion } from "../../src/core/team-capabilities.js";
import { canonicalHash, hashWithoutKey } from "../../src/bus/canonical.js";
import {
  BusInstanceSchema,
  V1InstanceSchema,
  busDoctor,
  busSummary,
  classifyBusRuntime,
  exportBusThread,
  initializeBus,
  isValidV1Live,
  joinEndpoint,
  pollBus,
  sendBusMessage,
} from "../../src/bus/index.js";
import { createBusFixture, type BusFixture } from "./helpers.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// D5 upgrade: drain gate, then an atomic, resumable archive protocol. v1 runtimes
// are frozen for new traffic but drainable. The happy-path drain lives in
// legacy-drain.test.ts; this file covers refusal listings, force-archive scope,
// the version fence, and concurrent-migration safety.

const roots: string[] = [];
const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })),
  ]);
});

function sign<T extends Record<string, unknown>>(unsigned: T, key: keyof T): T {
  return { ...unsigned, [key]: hashWithoutKey(unsigned, key) };
}

interface V1Message {
  readonly messageId: string;
  readonly fromRole: "implementer" | "reviewer";
  readonly toRole: "implementer" | "reviewer";
  readonly severity: "critical" | "high" | "medium" | "low" | "info";
  readonly body: string;
  readonly acked?: boolean;
  readonly withPointer?: boolean;
}

interface V1EndpointSpec {
  readonly role: "implementer" | "reviewer";
  readonly client: "claude" | "codex";
  readonly surface: "claude_cli" | "codex_cli" | "codex_desktop";
  readonly taskId: string;
}

interface V1Spec {
  readonly endpoints: readonly V1EndpointSpec[];
  readonly thread?: { readonly kind: string; readonly messages: readonly V1Message[] };
}

interface V1Fixture {
  readonly root: string;
  readonly endpointIds: Record<string, string>;
  readonly threadId: string | null;
}

async function createV1Runtime(spec: V1Spec, name = "bus-v1-migration"): Promise<V1Fixture> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  roots.push(root);
  await initProject(root, { name });
  const canonical = await realpath(root);
  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");

  const busRoot = join(root, ".story", "bus");
  for (const dir of [
    "threads", "endpoints", "succession", "locks",
    "mailboxes/implementer", "mailboxes/implementer/pending",
    "mailboxes/reviewer", "mailboxes/reviewer/pending",
  ]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }

  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1",
    instanceId: randomUUID(),
    projectRootHash: canonicalHash(canonical),
    createdAt: now,
  }, null, 2) + "\n", "utf-8");

  const endpointIds: Record<string, string> = {};
  for (const endpoint of spec.endpoints) {
    const endpointId = randomUUID();
    endpointIds[endpoint.taskId] = endpointId;
    await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
      schema: "storybloq-bus-endpoint/v1",
      endpointId,
      role: endpoint.role,
      client: endpoint.client,
      surface: endpoint.surface,
      clientTaskId: endpoint.taskId,
      processRef: null,
      state: "unknown",
      joinedAt: now,
      lastSeenAt: now,
      wakePolicy: "never",
      lastPolledMailboxSeq: 0,
      lastBlockedMailboxSeq: 0,
      retiredAt: null,
    }, null, 2) + "\n", "utf-8");
  }

  let threadId: string | null = null;
  if (spec.thread) {
    threadId = randomUUID();
    const thread = sign({
      schema: "storybloq-bus-thread/v1",
      threadId,
      kind: spec.thread.kind,
      topicRef: { ticket: "T-001" },
      participantRoles: ["reviewer", "implementer"],
      maxHops: 6,
      createdAt: now,
      threadHash: "0".repeat(64),
    }, "threadHash");
    const threadDir = join(busRoot, "threads", threadId);
    await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
    await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");

    let prevHash = thread.threadHash;
    let seq = 0;
    for (const message of spec.thread.messages) {
      seq += 1;
      const messageSeq = seq;
      const entry = sign({
        schema: "storybloq-bus-entry/v1",
        entryId: randomUUID(),
        threadId,
        seq,
        type: "message",
        prevHash,
        payload: {
          messageId: message.messageId,
          from: { endpointId: randomUUID(), role: message.fromRole, client: "claude" },
          toRole: message.toRole,
          kind: "question",
          severity: message.severity,
          body: message.body,
        },
        createdAt: now,
        entryHash: "0".repeat(64),
      }, "entryHash");
      await writeFile(join(threadDir, "entries", `${String(seq).padStart(6, "0")}-message-${entry.entryId}.json`), JSON.stringify(entry, null, 2) + "\n", "utf-8");
      prevHash = entry.entryHash;

      if (message.acked) {
        seq += 1;
        const ack = sign({
          schema: "storybloq-bus-entry/v1",
          entryId: randomUUID(),
          threadId,
          seq,
          type: "ack",
          prevHash,
          payload: { messageId: message.messageId, byEndpoint: endpointIds[spec.endpoints[0]!.taskId], disposition: "accepted" },
          createdAt: now,
          entryHash: "0".repeat(64),
        }, "entryHash");
        await writeFile(join(threadDir, "entries", `${String(seq).padStart(6, "0")}-ack-${ack.entryId}.json`), JSON.stringify(ack, null, 2) + "\n", "utf-8");
        prevHash = ack.entryHash;
      }

      if (message.withPointer) {
        // The pointer must reference the message entry's REAL seq and hash. A
        // placeholder entryHash is a misfiled pointer that the v1 envelope
        // cross-check correctly rejects as corrupt (mirrors legacy-drain.test.ts).
        await writeFile(join(busRoot, "mailboxes", message.toRole, `000000000001-${message.messageId}.json`), JSON.stringify({
          schema: "storybloq-bus-mailbox/v1",
          role: message.toRole,
          mailboxSeq: 1,
          messageId: message.messageId,
          threadId,
          entrySeq: messageSeq,
          entryHash: entry.entryHash,
        }, null, 2) + "\n", "utf-8");
      }
    }
  }

  return { root, endpointIds, threadId };
}

describe("Storybloq Bus v1 -> v2 migration (D5)", () => {
  it("refuses migration on unread noncritical mail with an explicit listing", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "info", body: "unread noncritical", withPointer: true }] },
    });
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("unread noncritical") });
    // Never migrated: still a v1 runtime.
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  it("refuses migration on a ship-gate blocker as a separate gate, even with --force-archive", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "critical", body: "unacked critical", withPointer: true }] },
    });
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("ship gate") });
    // --force-archive covers unread noncritical delivery only, never ship blockers.
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain", forceArchive: true }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("ship gate") });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  it("archives unread noncritical mail with --force-archive and keeps it exportable", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "low", body: "force-archive body", withPointer: true }] },
    });
    const result = await initializeBus(fx.root, { callerTaskId: "codex-drain", forceArchive: true });
    expect(result.migrated).toBe(true);
    expect(await classifyBusRuntime(fx.root)).toBe("v2");
    const archived = await exportBusThread(fx.root, fx.threadId!, "md");
    expect(archived).toContain("legacy v1");
    expect(archived).toContain("force-archive body");
  });

  it("refuses migration (corrupt) for a v1 runtime carrying a renamed duplicate endpoint record", async () => {
    // A DISTINCT filename recording the SAME endpointId is a renamed/duplicate record.
    // listV1Endpoints now enumerates the endpoints dir and requires every entry to be a
    // regular `<uuid>.json` file whose stored endpointId matches the filename stem, so
    // `<id>-dup.json` is a fail-closed finding: migration refuses corrupt rather than
    // silently archiving an untrustworthy duplicate. The endpoint-lock enumerator sees
    // the same finding, so the runtime never reaches lock acquisition.
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
    });
    const busRoot = join(fx.root, ".story", "bus");
    const duplicatedId = fx.endpointIds["codex-drain"]!;
    const original = JSON.parse(await readFile(join(busRoot, "endpoints", `${duplicatedId}.json`), "utf-8"));
    await writeFile(
      join(busRoot, "endpoints", `${duplicatedId}-dup.json`),
      JSON.stringify(original, null, 2) + "\n",
      "utf-8",
    );
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "corrupt" });
    // The runtime is untouched and remains v1 (migration threw before committing v2).
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  describe("migration path symlink guard (round-11 J)", () => {
    // A drainable v1 runtime (single caller-owned endpoint, no threads) reaches a
    // clear drain and would normally migrate to v2. Swapping a migration path for a
    // symlink to an external decoy must make migration fail closed (`corrupt`)
    // rather than let it mkdir/rename/rm outside .story. Each case asserts the
    // external decoy is byte-untouched and the live v1 runtime is unchanged.
    async function drainableV1(): Promise<V1Fixture> {
      return createV1Runtime({
        endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      });
    }

    async function makeDecoy(): Promise<{ dir: string; sentinel: string }> {
      const dir = await mkdtemp(join(tmpdir(), "bus-migration-decoy-"));
      roots.push(dir);
      const sentinel = join(dir, "sentinel.txt");
      await writeFile(sentinel, "decoy-untouched", "utf-8");
      return { dir, sentinel };
    }

    async function expectDecoyUntouched(decoy: { dir: string; sentinel: string }): Promise<void> {
      expect(await readFile(decoy.sentinel, "utf-8")).toBe("decoy-untouched");
      expect((await readdir(decoy.dir)).sort()).toEqual(["sentinel.txt"]);
    }

    it("fails closed when `.story/bus-migration` is a symlink (guarded pre-lock)", async () => {
      const fx = await drainableV1();
      const decoy = await makeDecoy();
      // Point the migration root at an external directory BEFORE migration runs. The
      // pre-lock guard (before the initial mkdir of bus-migration) fails closed.
      await symlink(decoy.dir, join(fx.root, ".story", "bus-migration"));

      await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
        .rejects.toMatchObject({ code: "corrupt" });
      await expectDecoyUntouched(decoy);
      expect(await classifyBusRuntime(fx.root)).toBe("v1");
    });

    it("fails closed when `.story/bus-migration/v2-staging` is a symlink (re-guarded under the lock)", async () => {
      const fx = await drainableV1();
      const decoy = await makeDecoy();
      // bus-migration itself must be a real dir so the pre-lock guard passes and
      // migration reaches the under-lock re-guard, where the symlinked child fails.
      await mkdir(join(fx.root, ".story", "bus-migration"), { recursive: true, mode: 0o700 });
      await symlink(decoy.dir, join(fx.root, ".story", "bus-migration", "v2-staging"));

      await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
        .rejects.toMatchObject({ code: "corrupt" });
      await expectDecoyUntouched(decoy);
      expect(await classifyBusRuntime(fx.root)).toBe("v1");
    });

    it("fails closed when `.story/bus-migration/v1` is a symlink (re-guarded under the lock)", async () => {
      const fx = await drainableV1();
      const decoy = await makeDecoy();
      await mkdir(join(fx.root, ".story", "bus-migration"), { recursive: true, mode: 0o700 });
      await symlink(decoy.dir, join(fx.root, ".story", "bus-migration", "v1"));

      await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
        .rejects.toMatchObject({ code: "corrupt" });
      await expectDecoyUntouched(decoy);
      expect(await classifyBusRuntime(fx.root)).toBe("v1");
    });
  });

  describe("archive finalization guard (R12) + ambiguity guard (R14)", () => {
    // R12 adds `assertMigrationPathSafe` calls in `finishArchive` on `.story/bus/archive`
    // and `.story/bus/archive/v1` before the mkdir + durableRename that move the archived
    // v1 tree under the committed v2 runtime.
    //
    // REACHABILITY NOTE: a fresh full migration always rebuilds `.story/bus` from a clean
    // staging tree immediately before `finishArchive`, so `.story/bus/archive` is created
    // fresh and can never be a pre-existing symlink on that path. The path where the archive
    // dir CAN be attacker-pre-placed as a symlink is the resume-at-step-5 branch: a committed
    // v2 is already live and `bus-migration/v1` still awaits its final move. `initializeBus`
    // re-enters migration for a COMMITTED-V2 runtime that still carries a leftover
    // `bus-migration/v1`, running `finishArchive` under the migration lock (the two
    // `reconstructCommittedV2WithLeftover` tests below pin both outcomes).
    //
    // R14 AMBIGUITY GUARD: a LIVE, valid v1 runtime coexisting with a leftover
    // `bus-migration/v1` is a DIFFERENT and non-resumable state -- two v1 trees, neither
    // provably authoritative. Auto-archiving the leftover as canonical would risk discarding
    // the live runtime's real work (the "unsafe state transition" Codex flagged), so
    // migration must fail closed and leave both trees intact. The first test pins that guard.

    it("fails closed (corrupt) when a live valid v1 coexists with a leftover bus-migration/v1 (ambiguous authority)", async () => {
      // A live valid v1 plus a leftover `bus-migration/v1` is NOT the resumable step-5 crash
      // state (that state has a committed v2 live). Two v1 trees coexist and neither can be
      // proven authoritative, so migration fails closed rather than archiving the leftover as
      // canonical and quarantining the live v1 -- which would silently discard real work.
      const fx = await createV1Runtime({
        endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      });
      const migrationRoot = join(fx.root, ".story", "bus-migration");
      await mkdir(join(migrationRoot, "v1"), { recursive: true, mode: 0o700 });
      await writeFile(join(migrationRoot, "v1", "leftover-sentinel.txt"), "prior-archived-v1", "utf-8");

      await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
        .rejects.toMatchObject({ code: "corrupt" });

      // Nothing migrated: the live runtime is still a v1 and the leftover is byte-intact.
      expect(await classifyBusRuntime(fx.root)).toBe("v1");
      expect(await readFile(join(migrationRoot, "v1", "leftover-sentinel.txt"), "utf-8")).toBe("prior-archived-v1");
      expect(await pathExists(join(fx.root, ".story", "bus", "archive", "v1"))).toBe(false);
    });

    // R15 #3: isValidV1Live (and the pre-flight fence) read the live instance TRI-STATE.
    // Only proven absence/corruption returns false; a transient io_error (EACCES/EIO)
    // must PROPAGATE and abort, never collapse to "not a valid v1" and fall through to a
    // destructive durableRename(liveBus, alien-*) + rebuild from the STALE leftover. This
    // pins the observable data-safety invariant: an unreadable live v1 instance alongside
    // a leftover bus-migration/v1 aborts with io_error and renames/rebuilds NOTHING.
    // Skipped as root, where chmod 000 does not produce EACCES.
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    it.skipIf(isRoot)("aborts (io_error) without renaming or rebuilding when the live v1 instance is transiently unreadable", async () => {
      const fx = await createV1Runtime({
        endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      });
      const migrationRoot = join(fx.root, ".story", "bus-migration");
      await mkdir(join(migrationRoot, "v1"), { recursive: true, mode: 0o700 });
      await writeFile(join(migrationRoot, "v1", "leftover-sentinel.txt"), "prior-archived-v1", "utf-8");

      const instancePath = join(fx.root, ".story", "bus", "instance.json");
      // Make the live v1 instance unreadable so reading it yields EACCES -> io_error.
      await chmod(instancePath, 0o000);
      try {
        await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
          .rejects.toMatchObject({ code: "io_error" });
      } finally {
        await chmod(instancePath, 0o600);
      }

      // No destructive mutation: the live tree was NOT renamed to `alien-*`, the leftover
      // is byte-intact, no v2 archive was created, and the runtime still classifies v1.
      const migrationEntries = await readdir(migrationRoot).catch(() => []);
      expect(migrationEntries.filter((name) => name.startsWith("alien-"))).toEqual([]);
      expect(await readFile(join(migrationRoot, "v1", "leftover-sentinel.txt"), "utf-8")).toBe("prior-archived-v1");
      expect(await pathExists(join(fx.root, ".story", "bus", "archive"))).toBe(false);
      expect(await classifyBusRuntime(fx.root)).toBe("v1");
    });

    // Reconstructs the resume-at-step-5 on-disk shape: a committed v2 live tree with
    // `bus-migration/v1` still present (a prior migrator committed v2 but crashed before
    // its final archive move). Drives a real migration to completion, then moves the
    // archived v1 back out from under the v2 tree into `bus-migration/v1`.
    async function reconstructCommittedV2WithLeftover(): Promise<{ root: string; busRoot: string; migrationRoot: string }> {
      const fx = await createV1Runtime({
        endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      });
      expect((await initializeBus(fx.root, { callerTaskId: "codex-drain" })).migrated).toBe(true);
      const busRoot = join(fx.root, ".story", "bus");
      const migrationRoot = join(fx.root, ".story", "bus-migration");
      await mkdir(migrationRoot, { recursive: true, mode: 0o700 });
      // Tag the leftover so the archive move can be verified byte-for-byte.
      await writeFile(join(busRoot, "archive", "v1", "leftover-sentinel.txt"), "prior-archived-v1", "utf-8");
      await rename(join(busRoot, "archive", "v1"), join(migrationRoot, "v1"));
      await rm(join(busRoot, "archive"), { recursive: true, force: true });
      expect(await classifyBusRuntime(fx.root)).toBe("v2");
      return { root: fx.root, busRoot, migrationRoot };
    }

    it("resumes a committed v2 with a leftover bus-migration/v1 and finalizes the archive", async () => {
      const { root, busRoot, migrationRoot } = await reconstructCommittedV2WithLeftover();

      // initializeBus re-enters migration's resume branch: finishArchive moves the leftover
      // v1 under the committed v2 tree, and `bus-migration/v1` is consumed.
      await initializeBus(root, { callerTaskId: "codex-drain" });
      expect(await classifyBusRuntime(root)).toBe("v2");
      expect(await readFile(join(busRoot, "archive", "v1", "leftover-sentinel.txt"), "utf-8")).toBe("prior-archived-v1");
      expect(await pathExists(join(migrationRoot, "v1"))).toBe(false);
    });

    it("fails the resume closed (corrupt) when `.story/bus/archive` is a symlink, leaving the leftover intact", async () => {
      const { root, busRoot, migrationRoot } = await reconstructCommittedV2WithLeftover();

      // Plant a symlink where finishArchive's guard rejects it, pointing at an external decoy.
      const decoy = await mkdtemp(join(tmpdir(), "bus-archive-decoy-"));
      roots.push(decoy);
      await writeFile(join(decoy, "sentinel.txt"), "decoy-untouched", "utf-8");
      await symlink(decoy, join(busRoot, "archive"));

      // The resume reaches finishArchive, whose archive-symlink guard fails closed. This is
      // the state that finally makes that guard reachable through the public API.
      await expect(initializeBus(root, { callerTaskId: "codex-drain" }))
        .rejects.toMatchObject({ code: "corrupt" });
      // The external decoy is byte-untouched: no archive rename traversed the symlink.
      expect(await readFile(join(decoy, "sentinel.txt"), "utf-8")).toBe("decoy-untouched");
      expect((await readdir(decoy)).sort()).toEqual(["sentinel.txt"]);
      // The leftover is still present: finishArchive threw before the archive move.
      expect(await pathExists(join(migrationRoot, "v1"))).toBe(true);
    });
  });

  it("refuses migration when another peer endpoint is not positively offline", async () => {
    const fx = await createV1Runtime({
      endpoints: [
        { role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" },
        { role: "reviewer", client: "claude", surface: "claude_cli", taskId: "claude-peer" },
      ],
    });
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("positively offline") });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
  });

  it("refuses new join traffic on a v1 runtime with upgrade_required", async () => {
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
    });
    await expect(joinEndpoint(fx.root, {
      client: "claude",
      clientTaskId: "claude-new",
      surface: "claude_cli",
    })).rejects.toMatchObject({ code: "upgrade_required" });
  });

  it("serializes concurrent migrators and never quarantines the migrated v2 tree", async () => {
    // Regression for a concurrent-migration data-loss bug: two initializeBus
    // calls that both read v1 before either commits must not let the loser run a
    // fresh migration over the winner's v2 tree (which archived the v1 threads).
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "info", body: "concurrent archive body", acked: true }] },
    });
    const results = await Promise.allSettled([
      initializeBus(fx.root, { callerTaskId: "codex-drain" }),
      initializeBus(fx.root, { callerTaskId: "codex-drain" }),
    ]);
    for (const result of results) expect(result.status).toBe("fulfilled");
    expect(await classifyBusRuntime(fx.root)).toBe("v2");
    // The archived thread survived (the loser did not clobber the live v2 tree).
    const archived = await exportBusThread(fx.root, fx.threadId!, "md");
    expect(archived).toContain("concurrent archive body");
    // No alien quarantine of a valid v2 live tree.
    const migrationEntries = await readdir(join(fx.root, ".story", "bus-migration")).catch(() => []);
    expect(migrationEntries.filter((name) => name.startsWith("alien-"))).toEqual([]);
  });

  it("documents the 1.7.0 failure shape: a v2 instance fails the v1 instance schema", async () => {
    const v2Instance = {
      schema: "storybloq-bus-instance/v2",
      instanceId: randomUUID(),
      projectRootHash: "a".repeat(64),
      protocolVersion: 2,
      minCliVersion: "1.8.0",
      createdAt: new Date().toISOString(),
    };
    // The v1 CLI parses instance.json with the v1 schema and fails closed on Bus ops.
    expect(V1InstanceSchema.safeParse(v2Instance).success).toBe(false);
    // The v2 schema accepts it; a v1 instance fails the v2 schema.
    expect(BusInstanceSchema.safeParse(v2Instance).success).toBe(true);
    expect(BusInstanceSchema.safeParse({
      schema: "storybloq-bus-instance/v1",
      instanceId: randomUUID(),
      projectRootHash: "a".repeat(64),
      createdAt: new Date().toISOString(),
    }).success).toBe(false);
  });

  it("refuses a future protocolVersion runtime with an upgrade message", async () => {
    const value = await createBusFixture("bus-future");
    fixtures.push(value);
    const instancePath = join(value.root, ".story", "bus", "instance.json");
    const instance = JSON.parse(await readFile(instancePath, "utf-8"));
    await writeFile(instancePath, JSON.stringify({ ...instance, protocolVersion: 3, minCliVersion: "9.9.9" }, null, 2) + "\n", "utf-8");

    // The centralized version fence refuses a future-protocol runtime with the
    // same upgrade_required shape across EVERY reader (classifyBusRuntime,
    // readBusInstance via join/init, busSummary, busDoctor), naming the required
    // version. No reader returns a usable instance or reports it as plain corrupt.
    await expect(classifyBusRuntime(value.root))
      .rejects.toMatchObject({ code: "upgrade_required", message: expect.stringContaining("9.9.9") });
    await expect(joinEndpoint(value.root, {
      client: "claude",
      clientTaskId: "claude-future",
      surface: "claude_cli",
    })).rejects.toMatchObject({ code: "upgrade_required", message: expect.stringContaining("9.9.9") });
    await expect(initializeBus(value.root)).rejects.toMatchObject({
      code: "upgrade_required",
      message: expect.stringContaining("9.9.9"),
    });
    await expect(busSummary(value.root))
      .rejects.toMatchObject({ code: "upgrade_required", message: expect.stringContaining("9.9.9") });
    await expect(busDoctor(value.root))
      .rejects.toMatchObject({ code: "upgrade_required", message: expect.stringContaining("9.9.9") });
  });

  it("rejects a v2-literal instance missing protocolVersion as corrupt with zero mutation before rejection", async () => {
    const value = await createBusFixture("bus-missing-protocol");
    fixtures.push(value);
    const instancePath = join(value.root, ".story", "bus", "instance.json");
    const configPath = join(value.root, ".story", "config.json");
    const gitignorePath = join(value.root, ".story", ".gitignore");

    // Arrange a runtime that DOES have pending mutations for initializeBus to make
    // if the fence ran late: disable features.bus and drop the `bus-migration/`
    // gitignore line. A late fence would re-enable the feature and re-add the
    // ignore entry (initializeBus's under-lock mutations) before rejecting, so the
    // byte-identical assertions below are only meaningful with this arrangement.
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.features = { ...(config.features ?? {}), bus: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    const gitignore = await readFile(gitignorePath, "utf-8");
    const trimmedGitignore = gitignore
      .split("\n")
      .filter((line) => line.trim() !== "bus-migration/")
      .join("\n");
    expect(trimmedGitignore).not.toContain("bus-migration/");
    await writeFile(gitignorePath, trimmedGitignore, "utf-8");

    // A v2-literal instance whose required protocolVersion field is absent still
    // satisfies the tolerant classifier (protocolOf defaults it to 2) but fails
    // the strict v2 schema. fenceExistingRuntime must strict-validate BEFORE any
    // mutation, so initializeBus rejects corrupt and touches nothing.
    const instance = JSON.parse(await readFile(instancePath, "utf-8"));
    delete instance.protocolVersion;
    expect(instance.schema).toBe("storybloq-bus-instance/v2");
    await writeFile(instancePath, JSON.stringify(instance, null, 2) + "\n", "utf-8");

    const configBefore = await readFile(configPath, "utf-8");
    const gitignoreBefore = await readFile(gitignorePath, "utf-8");
    const instanceBefore = await readFile(instancePath, "utf-8");

    await expect(initializeBus(value.root)).rejects.toMatchObject({ code: "corrupt" });

    // Both tracked files are byte-identical: the pre-flight fence ran BEFORE any
    // mutation, so features.bus was NOT re-enabled and the `bus-migration/` ignore
    // entry was NOT re-added.
    expect(await readFile(configPath, "utf-8")).toBe(configBefore);
    expect(JSON.parse(configBefore).features.bus).toBe(false);
    expect(await readFile(gitignorePath, "utf-8")).toBe(gitignoreBefore);
    expect(gitignoreBefore).not.toContain("bus-migration/");
    // The runtime tree is untouched (the malformed instance was not rebuilt).
    expect(await readFile(instancePath, "utf-8")).toBe(instanceBefore);
  });

  it("fences an endpoint op when instance.json minCliVersion exceeds the current CLI (R9)", async () => {
    const value = await createBusFixture("bus-mincli-fence");
    fixtures.push(value);
    const instancePath = join(value.root, ".story", "bus", "instance.json");
    const instance = JSON.parse(await readFile(instancePath, "utf-8"));

    // Control: the runtime self-writes minCliVersion 1.8.0, so an endpoint op runs.
    await expect(pollBus(value.root, { endpointId: value.a.endpointId, clientTaskId: value.aTaskId }))
      .resolves.toHaveProperty("messages");

    // A higher minCliVersion on a still-valid v2 runtime (protocolVersion stays 2)
    // is fenced through resolveInitializedBusPaths, naming instance.json.
    //
    // DERIVED, not hardcoded. This literal used to be "1.9.0", which fenced
    // correctly until the package version actually reached 1.9.0 -- at which
    // point the fence stopped firing and the test failed during the release
    // bump. A value computed from the CLI's own version is above it by
    // construction, so no future bump can walk past it. The fence compares
    // against currentCliVersion(), so deriving from that same source is what
    // makes "strictly newer" true rather than merely likely.
    const tooNew = (() => {
      const major = Number.parseInt((currentCliVersion() ?? "0").split(".")[0] ?? "0", 10);
      return `${(Number.isFinite(major) ? major : 0) + 1}.0.0`;
    })();

    await writeFile(instancePath, JSON.stringify({ ...instance, minCliVersion: tooNew }, null, 2) + "\n", "utf-8");
    await expect(pollBus(value.root, { endpointId: value.a.endpointId, clientTaskId: value.aTaskId }))
      .rejects.toMatchObject({ code: "upgrade_required", message: expect.stringContaining("instance.json") });
    await expect(pollBus(value.root, { endpointId: value.a.endpointId, clientTaskId: value.aTaskId }))
      .rejects.toMatchObject({ message: expect.stringContaining(tooNew) });

    // The fence is centralized: the pure read surfaces (summary + doctor) refuse
    // the too-new minCliVersion too, not only the endpoint op (pollBus).
    await expect(busSummary(value.root))
      .rejects.toMatchObject({ code: "upgrade_required", message: expect.stringContaining(tooNew) });
    await expect(busDoctor(value.root))
      .rejects.toMatchObject({ code: "upgrade_required", message: expect.stringContaining(tooNew) });
  });

  it("refuses an unknown instance schema as corrupt and never routes it into migration (R12)", async () => {
    const value = await createBusFixture("bus-unknown-schema");
    fixtures.push(value);
    const instancePath = join(value.root, ".story", "bus", "instance.json");
    const instance = JSON.parse(await readFile(instancePath, "utf-8"));

    // An unknown schema literal still satisfies the tolerant reader but is neither
    // the exact v1 nor v2 literal, so it must fail closed rather than default to v1.
    await writeFile(instancePath, JSON.stringify({ ...instance, schema: "storybloq-bus-instance/vX" }, null, 2) + "\n", "utf-8");

    await expect(classifyBusRuntime(value.root)).rejects.toMatchObject({ code: "corrupt" });
    await expect(initializeBus(value.root)).rejects.toMatchObject({ code: "corrupt" });

    // Fail-closed: never routed into the destructive v1 migration/archive path.
    expect(await pathExists(join(value.root, ".story", "bus-migration"))).toBe(false);
    expect(await pathExists(join(value.root, ".story", "bus", "archive"))).toBe(false);
    // The instance is left intact (unknown schema unchanged, not rebuilt).
    const after = JSON.parse(await readFile(instancePath, "utf-8"));
    expect(after.schema).toBe("storybloq-bus-instance/vX");
  });

  it("fails the drain gate closed on a malformed v1 endpoint, staying tolerant to reads (R14)", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "info", body: "endpoint drain body", acked: true }] },
    });
    // A malformed endpoint record must fail the drain gate closed, not be skipped
    // (a silent skip can hide an attached peer from the offline proof).
    await writeFile(join(fx.root, ".story", "bus", "endpoints", "corrupt.json"), "{ not valid endpoint json", "utf-8");

    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "corrupt" });
    // Never archived; still a v1 runtime.
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
    expect(await pathExists(join(fx.root, ".story", "bus-migration", "v1"))).toBe(false);
    expect(await pathExists(join(fx.root, ".story", "bus", "archive"))).toBe(false);

    // The tolerant read surface stays available on the same malformed runtime.
    await expect(busSummary(fx.root)).resolves.toMatchObject({ initialized: true });
    await expect(busDoctor(fx.root)).resolves.toMatchObject({ healthy: false });
    await expect(exportBusThread(fx.root, fx.threadId!, "md")).resolves.toContain("endpoint drain body");
  });

  it("fails the drain gate closed on a malformed v1 mailbox pointer, staying tolerant to reads (R14)", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "info", body: "pointer drain body", acked: true }] },
    });
    // A corrupt pending pointer is otherwise indistinguishable from empty, so the
    // gate must fail closed rather than treat it as nothing-to-drain.
    await writeFile(
      join(fx.root, ".story", "bus", "mailboxes", "implementer", `000000000009-${randomUUID()}.json`),
      '{"schema":"storybloq-bus-mailbox/v1"}',
      "utf-8",
    );

    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
    expect(await pathExists(join(fx.root, ".story", "bus-migration", "v1"))).toBe(false);
    expect(await pathExists(join(fx.root, ".story", "bus", "archive"))).toBe(false);

    await expect(busSummary(fx.root)).resolves.toMatchObject({ initialized: true });
    await expect(busDoctor(fx.root)).resolves.toMatchObject({ healthy: false });
    await expect(exportBusThread(fx.root, fx.threadId!, "md")).resolves.toContain("pointer drain body");
  });

  it("fails the drain gate closed on a malformed (non-UUID) thread directory, force-archive included (R14)", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "info", body: "thread dir drain body", acked: true }] },
    });
    // A non-UUID directory where a thread belongs could hide pending work, so the
    // drain gate fails closed rather than treating it as nothing-to-drain.
    await mkdir(join(fx.root, ".story", "bus", "threads", "not-a-thread-uuid"), { recursive: true, mode: 0o700 });

    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "corrupt" });
    // --force-archive never bypasses a corrupt record (thrown before the unread
    // noncritical gate).
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain", forceArchive: true }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
    expect(await pathExists(join(fx.root, ".story", "bus", "archive"))).toBe(false);

    // Read surfaces stay tolerant on the same runtime.
    await expect(busSummary(fx.root)).resolves.toMatchObject({ initialized: true });
    await expect(busDoctor(fx.root)).resolves.toMatchObject({ healthy: false });
    await expect(exportBusThread(fx.root, fx.threadId!, "md")).resolves.toContain("thread dir drain body");
  });

  it("fails the drain gate closed on an envelope-mismatched (misfiled) mailbox pointer, force-archive included (R14)", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "info", body: "misfiled pointer body", acked: true }] },
    });
    // A pointer that PARSES and matches its filename but whose envelope disagrees
    // with the referenced thread entry (here a foreign messageId at the real seq)
    // is a stale/tampered pointer the gate must fail closed on, not fold silently.
    const foreignMessageId = randomUUID();
    await writeFile(
      join(fx.root, ".story", "bus", "mailboxes", "implementer", `000000000009-${foreignMessageId}.json`),
      JSON.stringify({
        schema: "storybloq-bus-mailbox/v1",
        role: "implementer",
        mailboxSeq: 9,
        messageId: foreignMessageId,
        threadId: fx.threadId,
        entrySeq: 1,
        entryHash: "a".repeat(64),
      }, null, 2) + "\n",
      "utf-8",
    );

    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining("does not match its thread entry") });
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain", forceArchive: true }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");

    await expect(busSummary(fx.root)).resolves.toMatchObject({ initialized: true });
    await expect(busDoctor(fx.root)).resolves.toMatchObject({ healthy: false });
    await expect(exportBusThread(fx.root, fx.threadId!, "md")).resolves.toContain("misfiled pointer body");
  });

  it("fails the drain gate closed on a SYMLINKED v1 endpoint record and surfaces it in doctor (F1)", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "info", body: "symlink endpoint body", acked: true }] },
    });
    // A live/unknown NON-owner reviewer endpoint whose record is a SYMLINK. The prior
    // listRegularJsonFiles scan dropped symlinks silently, hiding this peer from the
    // offline proof (fail-open). The enumerating scan now records a finding so the
    // drain gate fails closed rather than migrating over a possibly-attached peer.
    const hiddenId = randomUUID();
    const target = join(fx.root, ".story", "hidden-endpoint.json");
    await writeFile(target, JSON.stringify({
      schema: "storybloq-bus-endpoint/v1",
      endpointId: hiddenId,
      role: "reviewer",
      client: "claude",
      surface: "claude_cli",
      clientTaskId: "claude-hidden-peer",
      processRef: null,
      state: "unknown",
      joinedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      wakePolicy: "never",
      lastPolledMailboxSeq: 0,
      lastBlockedMailboxSeq: 0,
      retiredAt: null,
    }, null, 2) + "\n", "utf-8");
    await symlink(target, join(fx.root, ".story", "bus", "endpoints", `${hiddenId}.json`));

    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "corrupt" });
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain", forceArchive: true }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
    expect(await pathExists(join(fx.root, ".story", "bus", "archive"))).toBe(false);

    // Doctor/status stay tolerant reads but surface the endpoint finding.
    await expect(busSummary(fx.root)).resolves.toMatchObject({ initialized: true });
    const doctor = await busDoctor(fx.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.some((finding) => finding.includes("not a regular <uuid>.json file"))).toBe(true);
  });

  it("fails the drain gate closed on a SYMLINKED v1 mailbox pointer, force-archive included (F2)", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "info", body: "symlink pointer body", acked: true }] },
    });
    // A pointer file that is a SYMLINK (its target a real, valid pointer). The prior
    // listRegularJsonFiles scan dropped symlinks silently, so a tampered/renamed unread
    // delivery record read as empty (fail-open). The enumerating scan records a finding
    // that fails the drain gate closed, and --force-archive never bypasses it.
    const pointerId = randomUUID();
    const target = join(fx.root, ".story", "hidden-pointer.json");
    await writeFile(target, JSON.stringify({
      schema: "storybloq-bus-mailbox/v1",
      role: "implementer",
      mailboxSeq: 9,
      messageId: pointerId,
      threadId: fx.threadId,
      entrySeq: 1,
      entryHash: "a".repeat(64),
    }, null, 2) + "\n", "utf-8");
    await symlink(target, join(fx.root, ".story", "bus", "mailboxes", "implementer", `000000000009-${pointerId}.json`));

    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "corrupt" });
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain", forceArchive: true }))
      .rejects.toMatchObject({ code: "corrupt" });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
    expect(await pathExists(join(fx.root, ".story", "bus", "archive"))).toBe(false);

    const doctor = await busDoctor(fx.root);
    expect(doctor.healthy).toBe(false);
    expect(doctor.findings.some((finding) => finding.includes("unexpected non-pointer entry"))).toBe(true);
  });

  it("blocks migration on a quarantined critical thread as a ship gate, force-archive included (R13)", async () => {
    const messageId = randomUUID();
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
      thread: { kind: "question", messages: [{ messageId, fromRole: "reviewer", toRole: "implementer", severity: "critical", body: "critical body", acked: true }] },
    });
    // Tamper the message entry so its hash no longer verifies: the thread folds as
    // quarantined. A quarantined thread's verified prefix cannot prove the critical
    // message noncritical, so it is a non-overridable ship-gate blocker (never
    // archived, force-archive included).
    const entriesDir = join(fx.root, ".story", "bus", "threads", fx.threadId!, "entries");
    const entryFile = (await readdir(entriesDir)).find((name) => name.includes("-message-"))!;
    const entry = JSON.parse(await readFile(join(entriesDir, entryFile), "utf-8"));
    entry.payload.body = "tampered critical body";
    await writeFile(join(entriesDir, entryFile), JSON.stringify(entry, null, 2) + "\n", "utf-8");

    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain" }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("ship gate") });
    await expect(initializeBus(fx.root, { callerTaskId: "codex-drain", forceArchive: true }))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("ship gate") });
    expect(await classifyBusRuntime(fx.root)).toBe("v1");
    expect(await pathExists(join(fx.root, ".story", "bus", "archive"))).toBe(false);

    // Read surfaces stay available; export still renders the quarantined thread.
    await expect(busSummary(fx.root)).resolves.toMatchObject({ initialized: true });
    await expect(busDoctor(fx.root)).resolves.toMatchObject({ healthy: false });
    await expect(exportBusThread(fx.root, fx.threadId!, "md")).resolves.toBeTypeOf("string");
  });
});

// R15 #3 DIRECT coverage of the resume authority classifier. The end-to-end unreadable-
// instance test above aborts at the pre-flight fence (which reads the same instance
// first), so it cannot by itself prove isValidV1Live propagates io_error rather than
// collapsing to false. These unit tests pin the tri-state at the function boundary: only
// proven absence/corruption is false; a transient io_error PROPAGATES (so the resume
// ambiguity guard aborts instead of falling through to a destructive alien-rename+rebuild).
describe("isValidV1Live tri-state (R15 #3)", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  async function v1BusRoot(): Promise<string> {
    const fx = await createV1Runtime({
      endpoints: [{ role: "implementer", client: "codex", surface: "codex_desktop", taskId: "codex-drain" }],
    });
    return join(fx.root, ".story", "bus");
  }

  it("returns true for a valid live v1 instance", async () => {
    expect(await isValidV1Live(await v1BusRoot())).toBe(true);
  });

  it("returns false when the instance is provably absent (not_found)", async () => {
    const busRoot = await v1BusRoot();
    await rm(join(busRoot, "instance.json"));
    expect(await isValidV1Live(busRoot)).toBe(false);
  });

  it("returns false when the instance fails the v1 schema (corrupt), not a throw", async () => {
    const busRoot = await v1BusRoot();
    // A v2-literal instance is a well-formed file that is simply not a valid v1 instance.
    await writeFile(join(busRoot, "instance.json"), JSON.stringify({
      schema: "storybloq-bus-instance/v2",
      instanceId: randomUUID(),
      projectRootHash: "a".repeat(64),
      protocolVersion: 2,
      minCliVersion: "1.8.0",
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf-8");
    expect(await isValidV1Live(busRoot)).toBe(false);
  });

  it.skipIf(isRoot)("PROPAGATES io_error (does not collapse to false) when the instance is transiently unreadable", async () => {
    const busRoot = await v1BusRoot();
    const instancePath = join(busRoot, "instance.json");
    await chmod(instancePath, 0o000);
    try {
      // A pre-fix `catch { return false }` would resolve false here; the tri-state must throw.
      await expect(isValidV1Live(busRoot)).rejects.toMatchObject({ code: "io_error" });
    } finally {
      await chmod(instancePath, 0o600);
    }
  });
});
