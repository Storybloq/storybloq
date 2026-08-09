import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { canonicalHash, hashWithoutKey } from "../../src/bus/canonical.js";
import { classifyBusRuntime, initializeBus } from "../../src/bus/index.js";
import { createBusFixture, createIssue, type BusFixture } from "./helpers.js";
import { runBusCli } from "./cli-harness.js";

// Bus CLI regression guards: the `--to` deprecation, `--force-archive` threading,
// the v1 `check --ship` upgrade message, and the doctor readiness line. All use
// --delivery poll so no real ~/.claude or ~/.codex hook files are touched.

const fixtures: BusFixture[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })),
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-cli");
  fixtures.push(value);
  return value;
}

function sign<T extends Record<string, unknown>>(unsigned: T, key: keyof T): T {
  return { ...unsigned, [key]: hashWithoutKey(unsigned, key) };
}

// Hand-builds a single-endpoint v1 runtime with one unread noncritical message.
async function createV1Runtime(): Promise<{ root: string; taskId: string; threadId: string; messageId: string }> {
  const root = await mkdtemp(join(tmpdir(), "bus-cli-v1-"));
  roots.push(root);
  await initProject(root, { name: "bus-cli-v1" });
  const canonical = await realpath(root);

  const configPath = join(root, ".story", "config.json");
  const { readFile } = await import("node:fs/promises");
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

  const endpointId = randomUUID();
  const taskId = "codex-task-drain";
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role: "implementer",
    client: "codex",
    surface: "codex_desktop",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt: null,
    retiredReason: null,
  }, null, 2) + "\n", "utf-8");

  const threadId = randomUUID();
  const messageId = randomUUID();
  const thread = sign({
    schema: "storybloq-bus-thread/v1",
    threadId,
    kind: "question",
    topicRef: { ticket: "T-001" },
    participantRoles: ["reviewer", "implementer"],
    maxHops: 6,
    createdAt: now,
    threadHash: "0".repeat(64),
  }, "threadHash");
  const entry = sign({
    schema: "storybloq-bus-entry/v1",
    entryId: randomUUID(),
    threadId,
    seq: 1,
    type: "message",
    prevHash: thread.threadHash,
    payload: {
      messageId,
      from: { endpointId: randomUUID(), role: "reviewer", client: "claude" },
      toRole: "implementer",
      kind: "question",
      severity: "low",
      body: "unread noncritical over the CLI",
    },
    createdAt: now,
    entryHash: "0".repeat(64),
  }, "entryHash");

  const threadDir = join(busRoot, "threads", threadId);
  await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
  await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");
  await writeFile(join(threadDir, "entries", `000001-message-${entry.entryId}.json`), JSON.stringify(entry, null, 2) + "\n", "utf-8");
  await writeFile(join(busRoot, "mailboxes", "implementer", `000000000001-${messageId}.json`), JSON.stringify({
    schema: "storybloq-bus-mailbox/v1",
    role: "implementer",
    mailboxSeq: 1,
    messageId,
    threadId,
    entrySeq: 1,
    entryHash: entry.entryHash,
  }, null, 2) + "\n", "utf-8");

  return { root, taskId, threadId, messageId };
}

interface UnreadSpec {
  readonly threadId: string;
  readonly messageId: string;
  readonly severity: "info" | "low" | "medium" | "high";
  readonly seq: number;
}

// Builds a single-endpoint v1 runtime carrying one unread noncritical message per
// spec, each in its own thread with a distinct mailbox sequence. The caller
// supplies fixed thread/message ids so two independently built fixtures produce
// byte-identical archived-unread strings (the strings carry role, severity,
// messageId, threadId), which lets the CLI pass-through be deep-compared against
// initializeBus's own return value.
async function createV1RuntimeWithUnread(specs: readonly UnreadSpec[]): Promise<{ root: string; taskId: string }> {
  const root = await mkdtemp(join(tmpdir(), "bus-cli-v1-multi-"));
  roots.push(root);
  await initProject(root, { name: "bus-cli-v1-multi" });
  const canonical = await realpath(root);

  const { readFile } = await import("node:fs/promises");
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

  const endpointId = randomUUID();
  const taskId = "codex-task-drain";
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
    schema: "storybloq-bus-endpoint/v1",
    endpointId,
    role: "implementer",
    client: "codex",
    surface: "codex_desktop",
    clientTaskId: taskId,
    processRef: null,
    state: "unknown",
    joinedAt: now,
    lastSeenAt: now,
    wakePolicy: "never",
    lastPolledMailboxSeq: 0,
    lastBlockedMailboxSeq: 0,
    retiredAt: null,
    retiredReason: null,
  }, null, 2) + "\n", "utf-8");

  for (const spec of specs) {
    const thread = sign({
      schema: "storybloq-bus-thread/v1",
      threadId: spec.threadId,
      kind: "question",
      topicRef: { ticket: "T-001" },
      participantRoles: ["reviewer", "implementer"],
      maxHops: 6,
      createdAt: now,
      threadHash: "0".repeat(64),
    }, "threadHash");
    const entry = sign({
      schema: "storybloq-bus-entry/v1",
      entryId: randomUUID(),
      threadId: spec.threadId,
      seq: 1,
      type: "message",
      prevHash: thread.threadHash,
      payload: {
        messageId: spec.messageId,
        from: { endpointId: randomUUID(), role: "reviewer", client: "claude" },
        toRole: "implementer",
        kind: "question",
        severity: spec.severity,
        body: `unread ${spec.severity} ${spec.messageId}`,
      },
      createdAt: now,
      entryHash: "0".repeat(64),
    }, "entryHash");
    const threadDir = join(busRoot, "threads", spec.threadId);
    await mkdir(join(threadDir, "entries"), { recursive: true, mode: 0o700 });
    await writeFile(join(threadDir, "thread.json"), JSON.stringify(thread, null, 2) + "\n", "utf-8");
    await writeFile(join(threadDir, "entries", `000001-message-${entry.entryId}.json`), JSON.stringify(entry, null, 2) + "\n", "utf-8");
    await writeFile(join(busRoot, "mailboxes", "implementer", `${String(spec.seq).padStart(12, "0")}-${spec.messageId}.json`), JSON.stringify({
      schema: "storybloq-bus-mailbox/v1",
      role: "implementer",
      mailboxSeq: spec.seq,
      messageId: spec.messageId,
      threadId: spec.threadId,
      entrySeq: 1,
      entryHash: entry.entryHash,
    }, null, 2) + "\n", "utf-8");
  }

  return { root, taskId };
}

describe("Storybloq Bus CLI regressions", () => {
  it("emits a structured deprecation for `bus send --to` and still routes to the sole peer", async () => {
    const value = await fx();
    const { stdout } = await runBusCli(value.root, [
      "bus", "send", "--format", "json",
      "--client", "claude", "--task-id", value.bTaskId,
      "--to", "implementer",
      "--thread-kind", "question", "--kind", "question", "--severity", "medium",
      "--body", "Routed to the sole peer despite --to",
      "--ci-run", "ci-deprecated-to", "--idempotency-key", "deprecated-to-1",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.deprecation).toContain("deprecated and ignored");
    // The deprecation does not block routing: a message was actually sent.
    expect(parsed.data.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.data.threadId).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ISS-953 fix step 12+15: `bus redeliver` end-to-end through the real CLI, and
  // `bus send`'s parked-result markdown rendering names the redeliver procedure in
  // prose using the same structured nextAction MCP callers get directly.
  it("names the redeliver procedure in prose on a parked `bus send`, and redelivers it through `bus redeliver` (ISS-953 fix step 12+15)", async () => {
    const value = await fx();
    const issueId = await createIssue(value.root, "medium");
    const configPath = join(value.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.bus = { maxHops: 2 };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const first = JSON.parse((await runBusCli(value.root, [
      "bus", "send", "--format", "json",
      "--client", "claude", "--task-id", value.bTaskId,
      "--thread-kind", "issue_notice", "--kind", "issue_notice", "--severity", "medium",
      "--body", "Opening the finding.", "--issue", issueId,
      "--idempotency-key", "cli-redeliver-first",
    ])).stdout).data;

    await runBusCli(value.root, [
      "bus", "send", "--format", "json",
      "--client", "codex", "--task-id", value.aTaskId,
      "--thread", first.threadId, "--kind", "reply", "--severity", "medium",
      "--body", "Acknowledged, investigating.",
      "--idempotency-key", "cli-redeliver-ack",
    ]);

    const { stdout: parkedMd } = await runBusCli(value.root, [
      "bus", "send", "--format", "md",
      "--client", "claude", "--task-id", value.bTaskId,
      "--thread", first.threadId, "--kind", "reply", "--severity", "medium",
      "--body", "One more check needed before this can close.",
      "--idempotency-key", "cli-redeliver-over-cap",
    ]);
    expect(parkedMd).toContain("parked at hop");
    expect(parkedMd).toContain("storybloq bus redeliver");
    expect(parkedMd).toContain(`--predecessor-thread ${first.threadId}`);
    const hashMatch = parkedMd.match(/--refused-entry-hash ([0-9a-f]{64})/);
    expect(hashMatch).not.toBeNull();
    const refusedEntryHash = hashMatch![1]!;

    const redelivered = JSON.parse((await runBusCli(value.root, [
      "bus", "redeliver", "--format", "json",
      "--client", "claude", "--task-id", value.bTaskId,
      "--predecessor-thread", first.threadId,
      "--refused-entry-hash", refusedEntryHash,
    ])).stdout).data;
    expect(redelivered).toMatchObject({ replaySource: "none", replayed: false, parked: false });
    expect(redelivered.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(redelivered.threadId).not.toBe(first.threadId);

    const { stdout: redeliverMd } = await runBusCli(value.root, [
      "bus", "redeliver", "--format", "md",
      "--client", "claude", "--task-id", value.bTaskId,
      "--predecessor-thread", first.threadId,
      "--refused-entry-hash", refusedEntryHash,
    ]);
    expect(redeliverMd).toContain("replayed from your own existing receipt");
  });

  it("initializes a fresh v2 runtime with `bus init`", async () => {
    const root = await mkdtemp(join(tmpdir(), "bus-cli-init-"));
    roots.push(root);
    await initProject(root, { name: "bus-cli-init" });
    const { stdout, exitCode } = await runBusCli(root, ["bus", "init", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(exitCode ?? 0).toBe(0);
  });

  it("refuses a v1 runtime from `bus init` with upgrade_required and directs to bus setup", async () => {
    // bus init is the low-level v2 initializer only. A v1 upgrade needs the caller's
    // identity to exempt its own endpoint from the drain offline proof (which the
    // identity-less init cannot supply), so it fails closed and routes to bus setup.
    const fxV1 = await createV1Runtime();
    const parsed = JSON.parse((await runBusCli(fxV1.root, ["bus", "init", "--format", "json"])).stdout);
    expect(parsed.error?.code).toBe("upgrade_required");
    expect(parsed.error?.message).toContain("bus setup");
    // The v1 runtime is untouched (no migration attempted from init).
    expect(await classifyBusRuntime(fxV1.root)).toBe("v1");
  });

  it("threads `bus setup --force-archive` through the v1 drain gate to override unread noncritical mail", async () => {
    const fxV1 = await createV1Runtime();
    const common = [
      "bus", "setup", "--format", "json",
      "--client", "codex", "--task-id", fxV1.taskId,
      "--surface", "codex_desktop", "--delivery", "poll",
    ];

    // Without --force-archive the unread noncritical message blocks the upgrade.
    const blocked = JSON.parse((await runBusCli(fxV1.root, common)).stdout);
    expect(blocked.error?.code).toBe("conflict");
    expect(blocked.error?.message).toContain("unread noncritical");

    // With --force-archive the same runtime migrates.
    const forced = JSON.parse((await runBusCli(fxV1.root, [...common, "--force-archive"])).stdout);
    expect(forced.data).toMatchObject({ migrated: true, setupState: "waiting_for_peer" });
    // The report names the EXACT archived unread message(s): messageId, threadId,
    // recipient role, and severity, not just a count.
    expect(forced.data.archivedUnread).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageId: fxV1.messageId,
        threadId: fxV1.threadId,
        role: "implementer",
        severity: "low",
      }),
    ]));

    // The Markdown output lists the same archived message(s). A fresh identical v1
    // runtime is used because the first was already migrated.
    const fxV1Md = await createV1Runtime();
    const md = (await runBusCli(fxV1Md.root, [
      "bus", "setup", "--format", "md",
      "--client", "codex", "--task-id", fxV1Md.taskId,
      "--surface", "codex_desktop", "--delivery", "poll", "--force-archive",
    ])).stdout;
    expect(md).toContain("Force-archived");
    expect(md).toContain(fxV1Md.messageId);
    expect(md).toContain(fxV1Md.threadId);
  });

  it("returns a clear ship gate for `bus check --ship` on a drainable v1 runtime", async () => {
    // A v1 runtime no longer refuses `bus check --ship`; it derives the same
    // {clear, blockers} shape from evaluateV1Drain's ship blockers. The fixture's
    // single message is severity "low" (noncritical), and an unread noncritical
    // message is a DRAIN blocker only -- never a SHIP blocker -- so the gate is clear.
    const fxV1 = await createV1Runtime();
    const { stdout } = await runBusCli(fxV1.root, ["bus", "check", "--ship", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toMatchObject({ clear: true, blockers: [] });
  });

  it("keeps `bus check --ship` clear when a durable-write temp coexists with committed entries (lock-free tolerance)", async () => {
    // `bus check --ship` is a LOCK-FREE read, so it must tolerate a concurrent ack/update
    // `durableCreate` temp: the temp is ignored, the committed chain still folds verified,
    // and the gate stays clear. Only the authoritative under-lock migration drain folds
    // strict (a temp-shaped tail is a fail-closed finding there). A regression that made the
    // shared drain evaluator unconditionally strict would flip this gate to a false blocker.
    const fxV1 = await createV1Runtime();
    const entriesDir = join(fxV1.root, ".story", "bus", "threads", fxV1.threadId, "entries");
    const committed = (await readdir(entriesDir)).find((name) => /^\d{6}-message-.*\.json$/.test(name))!;
    await writeFile(join(entriesDir, `${committed}.tmp.${process.pid}.${randomUUID()}`), "{ partial durable write in progress", "utf-8");

    const { stdout } = await runBusCli(fxV1.root, ["bus", "check", "--ship", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toMatchObject({ clear: true, blockers: [] });
  });

  it("reports a quarantined v1 thread as a `bus check --ship` blocker", async () => {
    const fxV1 = await createV1Runtime();
    // Tamper the thread's own hash so foldV1Thread quarantines it. A quarantined
    // thread is a non-overridable ship blocker. The mailbox pointer cross-check
    // validates only the message ENTRY (left untouched here), so no corrupt-record
    // finding is raised and the gate reports the blocker rather than failing closed.
    const threadPath = join(fxV1.root, ".story", "bus", "threads", fxV1.threadId, "thread.json");
    const thread = JSON.parse(await readFile(threadPath, "utf-8"));
    thread.threadHash = "f".repeat(64);
    await writeFile(threadPath, JSON.stringify(thread, null, 2) + "\n", "utf-8");

    // classifyBusRuntime reads instance.json, so the runtime stays v1 and reaches the gate.
    expect(await classifyBusRuntime(fxV1.root)).toBe("v1");
    const { stdout } = await runBusCli(fxV1.root, ["bus", "check", "--ship", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data.clear).toBe(false);
    expect((parsed.data.blockers as string[]).some((blocker) => blocker.includes("quarantined"))).toBe(true);
    expect(parsed.data.blockers).toContain(`quarantined Bus thread ${fxV1.threadId}`);
  });

  it("fails `bus check --ship` closed as corrupt on a corrupt v1 endpoint registry", async () => {
    const fxV1 = await createV1Runtime();
    // A malformed endpoint record could hide an attached peer from the offline proof,
    // so evaluateV1Drain fails closed with `corrupt` before returning a ship result.
    // classifyBusRuntime reads only instance.json, so the runtime is still v1.
    await writeFile(join(fxV1.root, ".story", "bus", "endpoints", "corrupt.json"), "{ not valid endpoint json", "utf-8");
    expect(await classifyBusRuntime(fxV1.root)).toBe("v1");
    const { stdout } = await runBusCli(fxV1.root, ["bus", "check", "--ship", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error?.code).toBe("corrupt");
  });

  it("returns bus_disabled for check/poll/ack/thread-update on a disabled project with residual v1 files, mutating nothing (F6/F7)", async () => {
    const fxV1 = await createV1Runtime();
    // Disable the feature while the residual v1 runtime files remain on disk.
    const configPath = join(fxV1.root, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.features = { ...config.features, bus: false };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

    const busRoot = join(fxV1.root, ".story", "bus");
    const endpointFile = join(busRoot, "endpoints", (await readdir(join(busRoot, "endpoints")))[0]!);
    const pointerFile = join(busRoot, "mailboxes", "implementer", `000000000001-${fxV1.messageId}.json`);
    const entriesDir = join(busRoot, "threads", fxV1.threadId, "entries");
    const snapshot = async () => ({
      endpoint: await readFile(endpointFile, "utf-8"), // carries the poll cursor
      pointer: await readFile(pointerFile, "utf-8"),
      entries: (await readdir(entriesDir)).sort().join(","),
    });
    const before = await snapshot();

    // check --ship gates on features.bus before classifying the runtime (F7); the
    // endpoint-scoped drain ops gate in resolveOwnedEndpoint (F6). All return bus_disabled.
    const check = JSON.parse((await runBusCli(fxV1.root, ["bus", "check", "--ship", "--format", "json"])).stdout);
    expect(check.error?.code).toBe("bus_disabled");
    const poll = JSON.parse((await runBusCli(fxV1.root, ["bus", "poll", "--client", "codex", "--task-id", fxV1.taskId, "--format", "json"])).stdout);
    expect(poll.error?.code).toBe("bus_disabled");
    const update = JSON.parse((await runBusCli(fxV1.root, [
      "bus", "thread", "update", fxV1.threadId, "--action", "park", "--reason", "drain park",
      "--client", "codex", "--task-id", fxV1.taskId, "--format", "json",
    ])).stdout);
    expect(update.error?.code).toBe("bus_disabled");
    // ack is a mutating drain op that gates in resolveOwnedEndpoint the same way; it
    // must also refuse on a disabled project rather than appending an ack entry.
    const ack = JSON.parse((await runBusCli(fxV1.root, [
      "bus", "ack", fxV1.messageId, "--disposition", "accepted",
      "--client", "codex", "--task-id", fxV1.taskId, "--format", "json",
    ])).stdout);
    expect(ack.error?.code).toBe("bus_disabled");

    // Nothing mutated: cursor, mailbox pointer, and thread entries are byte-identical.
    expect(await snapshot()).toEqual(before);
  });

  it("renders a coherent disabled readiness result for `bus doctor` on a disabled project", async () => {
    const root = await mkdtemp(join(tmpdir(), "bus-cli-disabled-"));
    roots.push(root);
    await initProject(root, { name: "bus-cli-disabled" });

    // busDoctor throws bus_disabled on a disabled project; the CLI must render a
    // readiness result and exit 0 rather than surfacing a bare error.
    const { stdout, exitCode } = await runBusCli(root, ["bus", "doctor", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toMatchObject({ enabled: false, healthy: false });
    expect(typeof parsed.data.readiness).toBe("string");
    expect(exitCode ?? 0).toBe(0);

    // The Markdown surface guides the user to setup instead of erroring.
    const md = (await runBusCli(root, ["bus", "doctor", "--format", "md"])).stdout;
    expect(md).toContain("Bus: disabled");
    expect(md).toContain("Readiness:");
  });

  it("renders a readiness line in `bus doctor` even when integrity findings exist", async () => {
    const value = await fx();
    // Break the layout so doctor reports integrity findings (setupState invalid).
    await rm(join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId, "pending"), { recursive: true });
    const { stdout } = await runBusCli(value.root, ["bus", "doctor", "--format", "md"]);
    expect(stdout).toContain("Storage has");
    expect(stdout).toContain("Readiness:");
    expect(stdout).toContain("invalid");
  });

  it("sources archivedUnread from the commit-time InitializeBusResult and reports none on a non-migrating call (#R5-G)", async () => {
    // NOTE ON SCOPE: no production test-seam exists to inject the pre-lock vs
    // commit-lock race window. The archived-unread list is captured UNDER the
    // migration + v1 operation locks inside initializeBus, with no injectable
    // durable-IO boundary between the pre-lock preflight and the commit-time
    // capture. These assertions therefore prove commit-time SOURCING structurally
    // (the returned list is the migration's own commit-time capture, empty on a
    // non-migrating call, and the CLI passes it through verbatim) rather than
    // proving the barrier holds under live contention. No source seam is added.
    const specs: UnreadSpec[] = [
      { threadId: randomUUID(), messageId: randomUUID(), severity: "low", seq: 1 },
      { threadId: randomUUID(), messageId: randomUUID(), severity: "medium", seq: 2 },
    ];
    const expectedRaw = specs.map((spec) =>
      `implementer mailbox: unread ${spec.severity} message ${spec.messageId} in thread ${spec.threadId}`,
    );

    // 1. A migrating call on a v1 runtime with two unread noncritical messages
    //    RETURNS both archived entries, captured at commit time.
    const migrating = await createV1RuntimeWithUnread(specs);
    const migrated = await initializeBus(migrating.root, { forceArchive: true, callerTaskId: migrating.taskId });
    expect(migrated.migrated).toBe(true);
    expect([...migrated.archivedUnread].sort()).toEqual([...expectedRaw].sort());

    // 2. A second call on the now-v2 runtime is non-migrating and reports NONE. A
    //    pre-lock preflight snapshot could wrongly re-surface the prior archive.
    const resumed = await initializeBus(migrating.root, { forceArchive: true, callerTaskId: migrating.taskId });
    expect(resumed.migrated).toBe(false);
    expect(resumed.archivedUnread).toEqual([]);

    // 3. The CLI report's archivedUnread passes through the SAME commit-time list.
    //    An equivalent fixture (identical thread/message ids) yields byte-identical
    //    entries, so the CLI's parsed `raw` fields deep-equal initializeBus's list.
    const viaCli = await createV1RuntimeWithUnread(specs);
    const { stdout } = await runBusCli(viaCli.root, [
      "bus", "setup", "--format", "json",
      "--client", "codex", "--task-id", viaCli.taskId,
      "--surface", "codex_desktop", "--delivery", "poll", "--force-archive",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.migrated).toBe(true);
    const cliRaw = parsed.data.archivedUnread.map((entry: { raw: string }) => entry.raw).sort();
    expect(cliRaw).toEqual([...migrated.archivedUnread].sort());
    // The CLI additionally parses each entry into its structured fields.
    expect(parsed.data.archivedUnread).toEqual(expect.arrayContaining(specs.map((spec) =>
      expect.objectContaining({
        messageId: spec.messageId,
        threadId: spec.threadId,
        role: "implementer",
        severity: spec.severity,
      }),
    )));
  });
});
