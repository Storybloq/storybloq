import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yargs from "yargs";
import {
  __storeTesting,
  busSummary,
  describeDeliveryTiers,
  initializeBus,
  joinEndpoint,
  mailboxHasPointerCandidate,
  pollBus,
  readMailboxHighwater,
  sendBusMessage,
  setBusHookPolicy,
  updateEndpoint,
  type BusDeliveryCapabilities,
  type BusEndpoint,
} from "../../src/bus/index.js";
import { Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { initProject } from "../../src/core/init.js";
import { resolveBusPaths } from "../../src/bus/paths.js";
import {
  hasBusToolHook,
  installProjectBusToolHook,
  readProjectSettingsNoFollow,
} from "../../src/core/project-settings.js";
import { registerBusCommand } from "../../src/cli/commands/bus.js";
import { claimBusStopDelivery, claimBusToolDelivery, handleBusToolHook } from "../../src/cli/commands/hook-status.js";
import { createBusFixture, type BusFixture } from "./helpers.js";
import { runBusCli } from "./cli-harness.js";

class ExitSignal extends Error {
  constructor(readonly code?: number) {
    super("exit");
  }
}

// Invoke the real PostToolUse hook handler with a mocked stdin payload. The handler
// uses process.stdout.write's flush callback, so the stdout mock MUST invoke it or
// the handler would hang; process.exit is neutralized so the test can unwind it.
async function captureToolHook(input: Record<string, unknown>): Promise<{ stdout: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const origOut = process.stdout.write;
  const origExit = process.exit;
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const stream = Readable.from([JSON.stringify(input)]) as unknown as NodeJS.ReadStream;
  (stream as { isTTY?: boolean }).isTTY = false;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  (process.stdout.write as unknown) = (chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown) => {
    out.push(String(chunk));
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    if (typeof callback === "function") (callback as () => void)();
    return true;
  };
  let exitCode: number | undefined;
  (process.exit as unknown) = ((code?: number) => { exitCode = code; throw new ExitSignal(code); }) as never;
  try {
    await handleBusToolHook();
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    process.stdout.write = origOut;
    (process.exit as unknown) = origExit;
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
  }
  return { stdout: out.join(""), exitCode };
}

function endpointPath(root: string, endpointId: string): string {
  return join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
}

async function readEndpointRecord(root: string, endpointId: string): Promise<BusEndpoint> {
  return JSON.parse(await readFile(endpointPath(root, endpointId), "utf-8")) as BusEndpoint;
}

// codex (a) -> claude (b): mail lands in the CLAUDE endpoint's mailbox, the surface
// the Claude-only PostToolUse (on-tool) channel serves.
function sendToClaude(value: BusFixture, index: number) {
  return sendBusMessage(value.root, {
    endpointId: value.a.endpointId,
    clientTaskId: value.aTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: `On-tool boundary ${index}`,
    refs: { ciRun: `ci-tool-${index}` },
    idempotencyKey: `tool-question-${index}`,
  });
}

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "skill");

async function busHelp(args: string[]): Promise<string> {
  const parser = registerBusCommand(yargs([])).exitProcess(false);
  return await new Promise<string>((resolve, reject) => {
    parser.parse(args, (err: Error | undefined, _argv: unknown, output: string) => {
      if (err) reject(err);
      else resolve(output);
    });
  });
}

const fixtures: BusFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture.root, { recursive: true, force: true })));
});

async function fixture(): Promise<BusFixture> {
  const value = await createBusFixture();
  fixtures.push(value);
  return value;
}

// reviewer (b/claude) -> implementer (a/codex): mail lands in the implementer mailbox.
function reviewSend(value: BusFixture, overrides: Record<string, unknown> = {}) {
  return sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: "Can you verify the recovery boundary?",
    refs: { ciRun: "ci-fixture-1" },
    idempotencyKey: "review-question-1",
    ...overrides,
  });
}

describe("T-427 cheap mailbox gates", () => {
  it("readMailboxHighwater reports unknown before any allocation and the highest seq after a send", async () => {
    const value = await fixture();
    const paths = await resolveBusPaths(value.root, false);

    // No message has ever been allocated to the implementer -> no counter.json.
    expect(await readMailboxHighwater(paths, value.implementer.endpointId)).toEqual({ known: false });

    await reviewSend(value);

    // The first allocated mailboxSeq is 1, so the high-water (nextSeq - 1) is 1.
    expect(await readMailboxHighwater(paths, value.implementer.endpointId)).toEqual({ known: true, highwater: 1 });

    // The sender's own mailbox never received anything -> still unknown.
    expect(await readMailboxHighwater(paths, value.reviewer.endpointId)).toEqual({ known: false });
  });

  it("mailboxHasPointerCandidate is fold-free: false for an empty mailbox, true once a pointer exists", async () => {
    const value = await fixture();
    const paths = await resolveBusPaths(value.root, false);

    expect(await mailboxHasPointerCandidate(paths, value.implementer.endpointId)).toBe(false);

    await reviewSend(value);

    expect(await mailboxHasPointerCandidate(paths, value.implementer.endpointId)).toBe(true);
    // The sender's mailbox holds no pointer.
    expect(await mailboxHasPointerCandidate(paths, value.reviewer.endpointId)).toBe(false);
  });

  it("mailboxHasPointerCandidate THROWS when the mailbox directory is deleted (deletion is not emptiness)", async () => {
    const value = await fixture();
    const paths = await resolveBusPaths(value.root, false);
    const mailbox = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId);
    await rm(mailbox, { recursive: true, force: true });
    // A vanished mailbox is corruption/deletion, not "no pending pointer": it must escalate
    // (throw) so the wait loop's interval tick surfaces the real cause instead of a false empty.
    await expect(mailboxHasPointerCandidate(paths, value.implementer.endpointId)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("mailboxHasPointerCandidate THROWS when the pending child is a symlink (no-follow)", async () => {
    const value = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "bus-evil-pending-"));
    fixtures.push({ root: outside } as BusFixture); // cleaned up by afterEach
    const paths = await resolveBusPaths(value.root, false);
    const pending = join(value.root, ".story", "bus", "mailboxes", value.implementer.endpointId, "pending");
    await rm(pending, { recursive: true, force: true });
    await symlink(outside, pending); // a symlinked pending would redirect the scan outside the runtime
    await expect(mailboxHasPointerCandidate(paths, value.implementer.endpointId)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("mailboxHasPointerCandidate THROWS when pending is deleted MID-SCAN (deletion after its lstat, not lazy absence)", async () => {
    const value = await fixture();
    const paths = await resolveBusPaths(value.root, false);
    // Delete pending AFTER its initial lstat proves it existed but BEFORE its readdir. Only
    // absence at the initial lstat is benign (lazily-created child); a deletion mid-scan is
    // corruption and must escalate, never be discarded as a false "empty". Match on the
    // path the probe actually operates on (realpath-resolved), not a hand-built path.
    __storeTesting.setAfterMailboxLstatHook(async (dir) => {
      if (dir.endsWith("pending")) await rm(dir, { recursive: true, force: true });
    });
    try {
      await expect(mailboxHasPointerCandidate(paths, value.implementer.endpointId)).rejects.toMatchObject({ code: "corrupt" });
    } finally {
      __storeTesting.setAfterMailboxLstatHook(null);
    }
  });

  it("seeds counter.json on the first empty authoritative tool-gate check (never-messaged hot path)", async () => {
    const value = await fixture();
    const paths = await resolveBusPaths(value.root, false);
    await setBusHookPolicy(value.root, ["claude"], true);

    // Before any tool call the Claude endpoint's mailbox has never been messaged -> no counter.
    expect(await readMailboxHighwater(paths, value.b.endpointId)).toEqual({ known: false });

    // The first PostToolUse gate check finds an empty mailbox and seeds counter.json, so
    // every subsequent tool call reads a KNOWN high-water (0) rather than re-scanning the
    // directory -- the fix for the activated-but-never-messaged hot path.
    const toolInput = { session_id: value.bTaskId, cwd: value.root, hook_event_name: "PostToolUse" };
    expect(await claimBusToolDelivery(value.root, toolInput)).toBeNull();
    expect(await readMailboxHighwater(paths, value.b.endpointId)).toEqual({ known: true, highwater: 0 });
  });
});

describe("T-427 delivery capabilities", () => {
  it("reports no active channels on a fresh, hookless two-endpoint bus", async () => {
    const value = await fixture();
    const summary = await busSummary(value.root);
    expect(summary.deliveryCapabilities).toEqual({ onStop: "none", onTool: "none" });
    expect(describeDeliveryTiers(summary.deliveryCapabilities)).toBe("poll");
  });

  it("onStop is 'all' when both clients' hook policy is on, 'partial' when only one is", async () => {
    const value = await fixture();

    await setBusHookPolicy(value.root, ["claude"], true);
    let summary = await busSummary(value.root);
    // Two participants (claude + codex); only claude's policy is on.
    expect(summary.deliveryCapabilities.onStop).toBe("partial");
    expect(summary.deliveryCapabilities.onTool).toBe("none");
    expect(describeDeliveryTiers(summary.deliveryCapabilities)).toBe("on-stop (partial)");

    await setBusHookPolicy(value.root, ["codex"], true);
    summary = await busSummary(value.root);
    expect(summary.deliveryCapabilities.onStop).toBe("all");
    expect(describeDeliveryTiers(summary.deliveryCapabilities)).toBe("on-stop");
  });

  it("onTool is 'claude_only' when the Claude endpoint's tool hook fired in its bound session (codex peer present)", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude", "codex"], true);

    // Simulate the PostToolUse hook having fired for the Claude endpoint (b) in
    // its currently-bound session: activation identity matches the endpoint's task.
    await updateEndpoint(value.root, value.b.endpointId, (current) => ({
      ...current,
      toolHookActivation: {
        taskId: current.clientTaskId,
        hookCommand: "storybloq hook-bus-tool",
        updatedAt: new Date().toISOString(),
      },
    }));

    const summary = await busSummary(value.root);
    expect(summary.deliveryCapabilities.onStop).toBe("all");
    // Codex has no PostToolUse surface, so on-tool can never be "all" here.
    expect(summary.deliveryCapabilities.onTool).toBe("claude_only");
    expect(describeDeliveryTiers(summary.deliveryCapabilities)).toBe("on-stop + on-tool (Claude only)");
  });

  it("ignores tool activation whose taskId no longer matches the endpoint's bound session", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude", "codex"], true);

    // Activation stamped for a DIFFERENT (stale) session id -> not on-tool.
    await updateEndpoint(value.root, value.b.endpointId, (current) => ({
      ...current,
      toolHookActivation: {
        taskId: "claude-some-older-session",
        hookCommand: "storybloq hook-bus-tool",
        updatedAt: new Date().toISOString(),
      },
    }));

    const summary = await busSummary(value.root);
    expect(summary.deliveryCapabilities.onTool).toBe("none");
  });
});

describe("T-427 honest labels (never oversell as live/push)", () => {
  const ALL_CAPS: BusDeliveryCapabilities[] = (["none", "partial", "all"] as const).flatMap((onStop) =>
    (["none", "partial", "claude_only", "all"] as const).map((onTool) => ({ onStop, onTool })),
  );

  it("describeDeliveryTiers never emits live/push/real-time for any capability combination", () => {
    for (const caps of ALL_CAPS) {
      const label = describeDeliveryTiers(caps);
      expect(label).not.toMatch(/live|push|real.?time/i);
    }
    // The exact state that USED to render "live delivery on" now reads honestly.
    expect(describeDeliveryTiers({ onStop: "all", onTool: "none" })).toBe("on-stop");
    expect(describeDeliveryTiers({ onStop: "all", onTool: "all" })).toBe("on-stop + on-tool");
    expect(describeDeliveryTiers({ onStop: "all", onTool: "partial" })).toBe("on-stop + on-tool (partial)");
    expect(describeDeliveryTiers({ onStop: "none", onTool: "none" })).toBe("poll");
  });

  it("bus status Markdown never prints the word 'live' even with both hook policies on", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude", "codex"], true);
    const { stdout } = await runBusCli(value.root, ["bus", "status", "--format", "md"]);
    expect(stdout).toContain("delivery: on-stop");
    expect(stdout).not.toMatch(/\blive\b/i);
  });

  it("bus command help never uses banned delivery phrases (the --delivery live flag choice is allowed)", async () => {
    for (const args of [["bus", "--help"], ["bus", "setup", "--help"], ["bus", "hooks", "--help"], ["bus", "poll", "--help"]]) {
      const help = await busHelp(args);
      expect(help).not.toMatch(/live delivery|guarded live|delivery is live|delivery:\s*live|push delivery/i);
    }
  });

  it("the bus-mode and reference skill docs describe the tiers without overselling", async () => {
    const busMode = await readFile(join(skillDir, "bus-mode.md"), "utf-8");
    const reference = await readFile(join(skillDir, "reference.md"), "utf-8");
    for (const doc of [busMode, reference]) {
      expect(doc).not.toMatch(/live delivery|guarded live|delivery is live|delivery:\s*live|push delivery/i);
    }
    // The required tier vocabulary + the explicit harness-constraint statement.
    expect(busMode).toContain("on-stop");
    expect(busMode).toContain("on-tool");
    expect(busMode).toMatch(/no daemon and no push/i);
    // ISS-1001: the surviving constraint is scoped to a RUNNING TOOL CALL, and delivery
    // rides the harness's own Stop/PostToolUse boundaries. The older, broader claim (that
    // nothing external can reach a session at all) was false once Claude Code 2.1.224+
    // shipped native cross-session messaging, which starts a new turn in an IDLE session.
    // Pin the true statement and its mechanism, and keep the false one from returning.
    expect(busMode).toMatch(/a running tool call is never interrupted/i);
    expect(busMode).toMatch(/Stop and PostToolUse boundaries/i);
    expect(busMode).not.toMatch(/no external process can inject/i);
  });
});

describe("T-427 tool-boundary (on-tool) delivery", () => {
  const toolInput = (value: BusFixture) => ({ session_id: value.bTaskId, cwd: value.root, hook_event_name: "PostToolUse" });

  it("blocks on pending mail via the on-tool channel and advances the SEPARATE tool cursor", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude"], true);
    await sendToClaude(value, 1);

    // The on-tool path returns a REASON-only advisory (never the Stop block contract).
    const decision = await claimBusToolDelivery(value.root, toolInput(value));
    expect(decision).not.toBeNull();
    expect(decision).not.toHaveProperty("decision");
    expect(decision?.reason).toContain("storybloq_bus_poll");
    expect(decision?.reason).not.toContain("On-tool boundary 1");

    const endpoint = await readEndpointRecord(value.root, value.b.endpointId);
    expect(endpoint.lastToolBlockedMailboxSeq).toBeGreaterThan(0);
    // The tool channel must NOT touch the Stop channel's cursor.
    expect(endpoint.lastBlockedMailboxSeq).toBe(0);
    // Activation was recorded for the bound session.
    expect(endpoint.toolHookActivation?.taskId).toBe(value.bTaskId);

    // Second tool call for the same message is suppressed.
    expect(await claimBusToolDelivery(value.root, toolInput(value))).toBeNull();
  });

  it("records activation on the FIRST tool call even when the mailbox is empty, and emits no block", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude"], true);

    expect(await claimBusToolDelivery(value.root, toolInput(value))).toBeNull();
    const endpoint = await readEndpointRecord(value.root, value.b.endpointId);
    expect(endpoint.toolHookActivation?.taskId).toBe(value.bTaskId);
    // busSummary now reports on-tool active (claude only; codex peer present).
    expect((await busSummary(value.root)).deliveryCapabilities.onTool).toBe("claude_only");
  });

  it("does not suppress the reliable Stop channel: both channels surface the same message once", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude"], true);
    await sendToClaude(value, 1);

    // on-tool advises first (mid-turn), reason-only.
    expect(await claimBusToolDelivery(value.root, toolInput(value))).toMatchObject({ reason: expect.stringContaining("storybloq_bus_poll") });
    // The Stop channel is independent and still surfaces the same message at turn end.
    const stopInput = { session_id: value.bTaskId, cwd: value.root, stop_hook_active: false };
    expect(await claimBusStopDelivery(value.root, stopInput, "claude")).toMatchObject({ decision: "block" });

    const endpoint = await readEndpointRecord(value.root, value.b.endpointId);
    expect(endpoint.lastToolBlockedMailboxSeq).toBeGreaterThan(0);
    expect(endpoint.lastBlockedMailboxSeq).toBeGreaterThan(0);
  });

  it("a real poll clears both channels", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude"], true);
    await sendToClaude(value, 1);
    expect(await claimBusToolDelivery(value.root, toolInput(value))).toMatchObject({ reason: expect.stringContaining("storybloq_bus_poll") });

    await pollBus(value.root, { endpointId: value.b.endpointId, clientTaskId: value.bTaskId });

    // Nothing new after a poll advanced lastPolledMailboxSeq.
    expect(await claimBusToolDelivery(value.root, toolInput(value))).toBeNull();
    const stopInput = { session_id: value.bTaskId, cwd: value.root, stop_hook_active: false };
    expect(await claimBusStopDelivery(value.root, stopInput, "claude")).toBeNull();
  });

  it("returns null when the Claude hook policy is off", async () => {
    const value = await fixture();
    await sendToClaude(value, 1);
    expect(await claimBusToolDelivery(value.root, toolInput(value))).toBeNull();
  });

  it("fast path performs no endpoint write once activation is recorded and the mailbox is empty", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude"], true);
    // First call records activation (a durable write -> new inode).
    await claimBusToolDelivery(value.root, toolInput(value));
    const inoAfterActivation = statSync(endpointPath(value.root, value.b.endpointId)).ino;

    // Steady-state empty calls must not rewrite the endpoint record (no fold, no write).
    await claimBusToolDelivery(value.root, toolInput(value));
    await claimBusToolDelivery(value.root, toolInput(value));
    expect(statSync(endpointPath(value.root, value.b.endpointId)).ino).toBe(inoAfterActivation);
  });

  it("still surfaces pending mail when counter.json is missing but a pointer survives (no false negative)", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude"], true);
    // Record activation on an empty mailbox (the fast-path precondition).
    expect(await claimBusToolDelivery(value.root, toolInput(value))).toBeNull();

    // A peer message arrives, THEN the high-water counter is lost (corruption / manual
    // deletion) while its mailbox pointer remains.
    await sendToClaude(value, 1);
    const counterPath = join(value.root, ".story", "bus", "mailboxes", value.b.endpointId, "counter.json");
    await rm(counterPath, { force: true });

    // The gate must NOT read the missing counter as "nothing new" once activated: it
    // disambiguates via the pointer scan and escalates, surfacing the advisory.
    const decision = await claimBusToolDelivery(value.root, toolInput(value));
    expect(decision).toMatchObject({ reason: expect.stringContaining("storybloq_bus_poll") });
  });

  it("does NOT regress the mailbox sequence below the delivered cursor after counter.json loss", async () => {
    const value = await fixture();
    const paths = await resolveBusPaths(value.root, false);
    await setBusHookPolicy(value.root, ["claude"], true);
    // Activate the tool hook on an empty mailbox (records activation, seeds nothing yet).
    await claimBusToolDelivery(value.root, toolInput(value));

    // Construct an ESTABLISHED mailbox: history was delivered up to seq 3, then the
    // pointers were acked+pruned (mailbox empty) and counter.json was lost. Advance the
    // delivered cursor and delete the counter directly to build exactly that state.
    await updateEndpoint(value.root, value.b.endpointId, (c) => ({ ...c, lastPolledMailboxSeq: 3 }));
    await rm(join(value.root, ".story", "bus", "mailboxes", value.b.endpointId, "counter.json"), { force: true });

    // The gate must NOT seed nextSeq:1 here (the endpoint HAS surfaced history); seeding 1
    // would let the next send allocate a seq at/below cursor 3 and be suppressed forever.
    expect(await claimBusToolDelivery(value.root, toolInput(value))).toBeNull();
    expect(await readMailboxHighwater(paths, value.b.endpointId)).toEqual({ known: false });

    // A fresh send reconstructs a safe floor from the endpoint cursor: seq 4 (> 3), not 1.
    await sendToClaude(value, 4);
    expect(await readMailboxHighwater(paths, value.b.endpointId)).toEqual({ known: true, highwater: 4 });

    // Both hook channels surface the new message (proof its seq is above the old cursor).
    expect(await claimBusToolDelivery(value.root, toolInput(value)))
      .toMatchObject({ reason: expect.stringContaining("storybloq_bus_poll") });
    const stopInput = { session_id: value.bTaskId, cwd: value.root, stop_hook_active: false };
    expect(await claimBusStopDelivery(value.root, stopInput, "claude")).toMatchObject({ decision: "block" });
  });
});

describe("T-427 PostToolUse hook handler", () => {
  it("emits the documented PostToolUse additionalContext envelope when mail is pending", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude"], true);
    await sendToClaude(value, 1);

    const { stdout, exitCode } = await captureToolHook({
      session_id: value.bTaskId,
      cwd: value.root,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("storybloq_bus_poll"),
      },
    });
    // Never leaks the peer's message body into the prompt.
    expect(stdout).not.toContain("On-tool boundary 1");
  });

  it("emits nothing (silent exit 0) when the mailbox is empty", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude"], true);
    const { stdout, exitCode } = await captureToolHook({
      session_id: value.bTaskId,
      cwd: value.root,
      hook_event_name: "PostToolUse",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });
});

describe("T-427 bus hooks disable turns the on-tool tier off", () => {
  it("clears the Claude hook policy and removes the project-local on-tool hook", async () => {
    const value = await fixture();
    // The bus fixture root is not a git work tree, so install skips git guards.
    await installProjectBusToolHook(value.root, "/x/storybloq");
    await setBusHookPolicy(value.root, ["claude"], true);
    expect(hasBusToolHook(await readProjectSettingsNoFollow(value.root), "/x/storybloq hook-bus-tool")).toBe(true);

    const { stdout, exitCode } = await runBusCli(value.root, ["bus", "hooks", "disable", "--client", "claude", "--format", "json"]);
    expect(exitCode).toBe(0);
    // The JSON response keeps the policy fields at the TOP level (matching the enable
    // path's shape), so `data.claude`/`data.codex` structured consumers do not break.
    const parsed = JSON.parse(stdout) as { data: { claude: unknown; codex: unknown; removalWarning?: unknown } };
    expect(parsed.data.claude).toBe(false);
    expect(typeof parsed.data.codex).toBe("boolean");

    const summary = await busSummary(value.root);
    expect(summary.hookDelivery.claude).toBe(false);
    expect(summary.deliveryCapabilities.onTool).toBe("none");
    expect(hasBusToolHook(await readProjectSettingsNoFollow(value.root), "/x/storybloq hook-bus-tool")).toBe(false);
  });

  // Regression: the markdown renderer dereferences policy.claude/policy.codex, so
  // disableHooksForClient MUST return the policy object. When it returned undefined the
  // command mutated the policy and then threw while rendering, reporting exit 1 instead
  // of the documented success. The JSON path above never dereferences policy, so only a
  // markdown-mode assertion catches this.
  it("renders the disabled policy in markdown (returns the policy, does not throw)", async () => {
    const value = await fixture();
    await setBusHookPolicy(value.root, ["claude", "codex"], true);

    const { stdout, exitCode } = await runBusCli(value.root, ["bus", "hooks", "disable", "--client", "claude"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Bus hook delivery disabled.");
    expect(stdout).toContain("Claude: off");
    // Codex was left enabled, so the rendered policy must reflect both endpoints.
    expect(stdout).toContain("Codex: on");
  });
});

describe("T-427 on-tool coverage is per-endpoint, not per client", () => {
  const twoClaudeRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(twoClaudeRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reports onTool 'partial' when only one of two active Claude sessions has fired the hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "bus-two-claude-"));
    twoClaudeRoots.push(root);
    await initProject(root, { name: "bus-two-claude" });
    await initializeBus(root);
    const task1 = "claude-task-one";
    const task2 = "claude-task-two";
    const e1 = (await joinEndpoint(root, { client: "claude", clientTaskId: task1, surface: "claude_cli" })).endpoint;
    await joinEndpoint(root, { client: "claude", clientTaskId: task2, surface: "claude_cli" });
    await setBusHookPolicy(root, ["claude"], true);

    // Only endpoint #1 has a matching tool-hook activation; #2 never fired.
    await updateEndpoint(root, e1.endpointId, (current) => ({
      ...current,
      toolHookActivation: { taskId: task1, hookCommand: "x hook-bus-tool", updatedAt: new Date().toISOString() },
    }));

    const summary = await busSummary(root);
    // One distinct client (claude), so the old per-client math would overstate as 'all'.
    expect(summary.deliveryCapabilities.onTool).toBe("partial");
    expect(describeDeliveryTiers(summary.deliveryCapabilities)).toContain("on-tool (partial)");
  });
});
