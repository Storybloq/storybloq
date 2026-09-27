import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, lstatSync, renameSync, readFileSync, chmodSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProjectLockAsync, releaseProjectLock } from "../../src/core/project-lock.js";
import { settingsLockPath } from "../../src/core/settings-write-lock.js";
import { captureProcessSignatureSync } from "../../src/core/process-identity.js";
import { removeHook } from "../../src/cli/commands/setup-skill.js";
import {
  classifyLedger,
  inspectTreeForRemoval,
  removeInspectedTree,
  removeLimitResumeMember,
  retireGlobalConfigMember,
  retireLimitHooks,
  retireSettingsHooks,
  RETIREMENT_MARKER_BASENAME,
  RETIREMENT_LOCK_BASENAME,
  readOwnedFileNoFollow,
  runLimitRetirement,
  stopRetiredWaker,
  unlinkIdentified,
  wakeChildMarkers,
  type RetirementDeps,
  type WakerStopDeps,
} from "../../src/core/limit-retirement.js";

const cmd = (command: string) => ({ type: "command", command });
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid!;

describe("retireLimitHooks", () => {
  it("removes the canonical StopFailure limit-stop row and drops the emptied event", () => {
    const settings = {
      hooks: {
        StopFailure: [{ matcher: "rate_limit", hooks: [cmd("/usr/local/bin/storybloq session limit-stop")] }],
        PreCompact: [{ matcher: "", hooks: [cmd("storybloq session compact-prepare")] }],
      },
    };
    const r = retireLimitHooks(settings);
    expect(r.removedEntries).toBe(1);
    expect(r.removedGroups).toBe(1);
    expect(r.settings).toEqual({ hooks: { PreCompact: settings.hooks.PreCompact } });
    // The input is never mutated.
    expect(settings.hooks.StopFailure).toHaveLength(1);
  });

  it("matches the legacy claudestory basename and a quoted path with spaces", () => {
    const r = retireLimitHooks({
      hooks: {
        StopFailure: [
          {
            matcher: "rate_limit",
            hooks: [cmd("claudestory session limit-stop"), cmd("'/Users/a b/bin/storybloq' session limit-stop")],
          },
        ],
      },
    });
    expect(r.removedEntries).toBe(2);
    expect(r.settings).toEqual({ hooks: {} });
  });

  it("removes resume-prompt only from the exact \"resume\" SessionStart group", () => {
    const compact = { matcher: "compact", hooks: [cmd("storybloq session resume-prompt")] };
    const broad = { matcher: "startup|resume|clear|compact", hooks: [cmd("storybloq session resume-prompt"), cmd("storybloq session intel-start")] };
    const r = retireLimitHooks({
      hooks: { SessionStart: [compact, { matcher: "resume", hooks: [cmd("storybloq session resume-prompt")] }, broad] },
    });
    expect(r.removedEntries).toBe(1);
    expect(r.removedGroups).toBe(1);
    expect(r.settings).toEqual({ hooks: { SessionStart: [compact, broad] } });
  });

  it("keeps third-party rows in a mixed group and a third-party resume group", () => {
    const theirs = cmd("/opt/other/tool on-resume");
    const r = retireLimitHooks({
      hooks: {
        SessionStart: [{ matcher: "resume", hooks: [cmd("storybloq session resume-prompt"), theirs] }],
        StopFailure: [{ matcher: "rate_limit", hooks: [cmd("other-tool session limit-stop"), cmd("storybloq session limit-stop")] }],
      },
    });
    expect(r.removedEntries).toBe(2);
    expect(r.removedGroups).toBe(0);
    expect(r.settings).toEqual({
      hooks: {
        SessionStart: [{ matcher: "resume", hooks: [theirs] }],
        StopFailure: [{ matcher: "rate_limit", hooks: [cmd("other-tool session limit-stop")] }],
      },
    });
  });

  it("leaves lookalike commands, shell wrappers and odd shapes untouched", () => {
    const settings = {
      hooks: {
        StopFailure: [
          { matcher: "rate_limit", hooks: [cmd("storybloq session limit-stop-extra"), cmd("storybloq session limit-stop; rm -rf /"), "not-an-object"] },
          "not-a-group",
        ],
        Weird: "not-an-array",
      },
    };
    const r = retireLimitHooks(settings);
    expect(r.removedEntries).toBe(0);
    expect(r.settings).toEqual(settings);
  });

  it("is a no-op on a rerun and on settings with no hooks", () => {
    const once = retireLimitHooks({ hooks: { StopFailure: [{ matcher: "rate_limit", hooks: [cmd("storybloq session limit-stop")] }] } });
    const twice = retireLimitHooks(once.settings);
    expect(twice.removedEntries).toBe(0);
    expect(twice.settings).toEqual(once.settings);
    expect(retireLimitHooks({ model: "x" })).toEqual({ settings: { model: "x" }, removedEntries: 0, removedGroups: 0 });
  });
});

describe("removeLimitResumeMember", () => {
  it("drops limitResume and keeps every other member", () => {
    const r = removeLimitResumeMember(JSON.stringify({ limitResume: { enabled: true }, sessionIntel: { enabled: false }, healthCheck: false }));
    expect(r.kind).toBe("changed");
    if (r.kind === "changed") expect(JSON.parse(r.text)).toEqual({ sessionIntel: { enabled: false }, healthCheck: false });
  });

  it("leaves an otherwise empty config as {} rather than deleting it", () => {
    const r = removeLimitResumeMember('{"limitResume":{"enabled":false}}');
    expect(r).toEqual({ kind: "changed", text: "{}\n" });
  });

  it("reports unchanged without the member and malformed for non-objects", () => {
    expect(removeLimitResumeMember('{"sessionIntel":{}}')).toEqual({ kind: "unchanged" });
    expect(removeLimitResumeMember("{not json")).toEqual({ kind: "malformed" });
    expect(removeLimitResumeMember("[1]")).toEqual({ kind: "malformed" });
    expect(removeLimitResumeMember("null")).toEqual({ kind: "malformed" });
  });
});

describe("inspectTreeForRemoval / removeInspectedTree", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-limit-retire-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports an absent root", () => {
    expect(inspectTreeForRemoval(join(dir, "wake-claims"))).toEqual({ kind: "absent" });
  });

  it("removes a regular tree deepest first", () => {
    const root = join(dir, "wake-claims");
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(root, "a", "c1.json"), "{}");
    writeFileSync(join(root, "c2.json"), "{}");
    const inspection = inspectTreeForRemoval(root);
    expect(inspection.kind).toBe("ok");
    if (inspection.kind !== "ok") return;
    expect(inspection.nodes.at(-1)!.path).toBe(root);
    expect(removeInspectedTree(inspection.nodes)).toEqual({ kind: "removed", count: 4 });
    expect(existsSync(root)).toBe(false);
  });

  it("refuses the whole tree over a nested symlink and deletes nothing", () => {
    const root = join(dir, "wake-claims");
    mkdirSync(join(root, "a"), { recursive: true });
    writeFileSync(join(dir, "outside.json"), "{}");
    writeFileSync(join(root, "a", "c1.json"), "{}");
    symlinkSync(join(dir, "outside.json"), join(root, "a", "link.json"));
    const inspection = inspectTreeForRemoval(root);
    expect(inspection.kind).toBe("refused");
    if (inspection.kind === "refused") expect(inspection.reasons.join("\n")).toContain("symlink");
    expect(existsSync(join(root, "a", "c1.json"))).toBe(true);
    expect(existsSync(join(dir, "outside.json"))).toBe(true);
  });

  it("refuses a symlinked root", () => {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "wake-claims"));
    expect(inspectTreeForRemoval(join(dir, "wake-claims")).kind).toBe("refused");
  });

  it("refuses a special file", () => {
    const root = join(dir, "wake-claims");
    mkdirSync(root);
    if (spawnSync("mkfifo", [join(root, "pipe")]).status !== 0) return;
    const inspection = inspectTreeForRemoval(root);
    expect(inspection.kind).toBe("refused");
    if (inspection.kind === "refused") expect(inspection.reasons.join("\n")).toContain("not a regular file or directory");
  });

  it("refuses a node owned by another uid", () => {
    const root = join(dir, "wake-claims");
    mkdirSync(root);
    writeFileSync(join(root, "c.json"), "{}");
    const real = process.getuid;
    const mine = lstatSync(root).uid;
    Object.defineProperty(process, "getuid", { value: () => mine + 1, configurable: true });
    try {
      const inspection = inspectTreeForRemoval(root);
      expect(inspection.kind).toBe("refused");
      if (inspection.kind === "refused") expect(inspection.reasons.join("\n")).toContain(`owned by uid ${mine}`);
    } finally {
      Object.defineProperty(process, "getuid", { value: real, configurable: true });
    }
    expect(existsSync(join(root, "c.json"))).toBe(true);
  });

  it("aborts when a node is swapped between inspection and removal", () => {
    const root = join(dir, "wake-claims");
    mkdirSync(root);
    writeFileSync(join(root, "c.json"), "{}");
    const inspection = inspectTreeForRemoval(root);
    expect(inspection.kind).toBe("ok");
    if (inspection.kind !== "ok") return;
    // Replace the file with a different inode at the same path.
    writeFileSync(join(dir, "swap.json"), "{}");
    renameSync(join(dir, "swap.json"), join(root, "c.json"));
    const r = removeInspectedTree(inspection.nodes);
    expect(r).toEqual({ kind: "aborted", reason: `${join(root, "c.json")}: changed since inspection`, removed: 0 });
    expect(existsSync(join(root, "c.json"))).toBe(true);
  });

  it("refuses an entry added after inspection instead of sweeping it", () => {
    const root = join(dir, "wake-claims");
    mkdirSync(root);
    writeFileSync(join(root, "c.json"), "{}");
    const inspection = inspectTreeForRemoval(root);
    if (inspection.kind !== "ok") throw new Error("expected ok");
    writeFileSync(join(root, "late.json"), "{}");
    const r = removeInspectedTree(inspection.nodes);
    expect(r.kind).toBe("aborted");
    if (r.kind === "aborted") {
      expect(r.reason).toContain("ENOTEMPTY");
      expect(r.removed).toBe(1);
    }
    expect(existsSync(join(root, "late.json"))).toBe(true);
  });

  it("aborts when the parent guard refuses, before the first removal or before the root", () => {
    const root = join(dir, "wake-claims");
    mkdirSync(root);
    writeFileSync(join(root, "c.json"), "{}");
    const inspection = inspectTreeForRemoval(root);
    if (inspection.kind !== "ok") throw new Error("expected ok");
    expect(removeInspectedTree(inspection.nodes, () => "parent swapped")).toEqual({ kind: "aborted", reason: "parent swapped", removed: 0 });
    let calls = 0;
    const r = removeInspectedTree(inspection.nodes, () => (++calls === 2 ? "parent swapped" : null));
    expect(r).toEqual({ kind: "aborted", reason: "parent swapped", removed: 1 });
    expect(existsSync(root)).toBe(true);
  });
});

describe("retireSettingsHooks / retireGlobalConfigMember", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-limit-retire-io-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const limitSettings = () => ({
    model: "x",
    hooks: {
      StopFailure: [{ matcher: "rate_limit", hooks: [cmd("storybloq session limit-stop")] }],
      Stop: [{ matcher: "", hooks: [cmd("storybloq hook-status")] }],
    },
  });

  it("rewrites settings without the limit rows and is unchanged on a rerun", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify(limitSettings()));
    expect(await retireSettingsHooks(path)).toEqual({ kind: "rewritten", removed: 1 });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ model: "x", hooks: { Stop: limitSettings().hooks.Stop } });
    expect(await retireSettingsHooks(path)).toEqual({ kind: "unchanged" });
  });

  it("writes through a symlinked settings.json and keeps the link", async () => {
    const real = join(dir, "dotfiles-settings.json");
    const link = join(dir, "settings.json");
    writeFileSync(real, JSON.stringify(limitSettings()));
    symlinkSync(real, link);
    expect((await retireSettingsHooks(link)).kind).toBe("rewritten");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8")).hooks.StopFailure).toBeUndefined();
  });

  it("leaves malformed settings untouched and reports absent files", async () => {
    const path = join(dir, "settings.json");
    expect(await retireSettingsHooks(path)).toEqual({ kind: "absent" });
    writeFileSync(path, "{ not json");
    const r = await retireSettingsHooks(path);
    expect(r.kind).toBe("refused");
    expect(readFileSync(path, "utf-8")).toBe("{ not json");
  });

  it("refuses when the user edits settings between the read and the write", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify(limitSettings()));
    const edited = JSON.stringify({ ...limitSettings(), theme: "dark" });
    const r = await retireSettingsHooks(path, { beforeRecheck: () => writeFileSync(path, edited) });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toContain("changed while being rewritten");
    expect(readFileSync(path, "utf-8")).toBe(edited);
  });

  it("prepares the new copy before the recheck, and a change during that window leaves the file and no temp behind (T-534 round 2)", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify(limitSettings()));
    const edited = JSON.stringify({ ...limitSettings(), theme: "dark" });
    let tempsDuringWindow: string[] = [];
    const r = await retireSettingsHooks(path, {
      beforeRecheck: () => {
        tempsDuringWindow = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
        writeFileSync(path, edited);
      },
    });
    expect(tempsDuringWindow).toHaveLength(1);
    expect(r.kind).toBe("refused");
    expect(readFileSync(path, "utf-8")).toBe(edited);
    expect(readdirSync(dir).filter((n) => n !== "settings.json")).toEqual([]);
  });

  it("refuses a settings file replaced by another inode with identical bytes during the window", async () => {
    const path = join(dir, "settings.json");
    const original = JSON.stringify(limitSettings());
    writeFileSync(path, original);
    const r = await retireSettingsHooks(path, {
      beforeRecheck: () => {
        writeFileSync(join(dir, "other.json"), original);
        renameSync(join(dir, "other.json"), path);
      },
    });
    expect(r.kind).toBe("refused");
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("refuses when a symlinked settings.json is repointed during the window", async () => {
    const real = join(dir, "a.json");
    const other = join(dir, "b.json");
    const link = join(dir, "settings.json");
    writeFileSync(real, JSON.stringify(limitSettings()));
    writeFileSync(other, JSON.stringify(limitSettings()));
    symlinkSync(real, link);
    const r = await retireSettingsHooks(link, {
      beforeRecheck: () => {
        unlinkSync(link);
        symlinkSync(other, link);
      },
    });
    expect(r.kind).toBe("refused");
    expect(JSON.parse(readFileSync(real, "utf-8")).hooks.StopFailure).toBeDefined();
    expect(JSON.parse(readFileSync(other, "utf-8")).hooks.StopFailure).toBeDefined();
  });

  it("waits for the lock every Storybloq settings writer takes, and refuses while another holds it", async () => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify(limitSettings()));
    const held = await acquireProjectLockAsync(settingsLockPath(path)!);
    try {
      const r = await retireSettingsHooks(path, { lockDeadlineMs: 200 });
      expect(r.kind).toBe("refused");
      if (r.kind === "refused") expect(r.reason).toContain("holds the lock");
      expect(JSON.parse(readFileSync(path, "utf-8")).hooks.StopFailure).toBeDefined();
      // Another writer of the same file queues behind the same lock.
      expect(await removeHook("Stop", "storybloq hook-status", path)).toBe("skipped");
    } finally {
      releaseProjectLock(held);
    }
    expect((await retireSettingsHooks(path)).kind).toBe("rewritten");
  }, 15_000);

  it("drops only limitResume from the global config, keeping its permissions", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ limitResume: { enabled: true }, sessionIntel: { enabled: false } }));
    chmodSync(path, 0o640);
    expect(retireGlobalConfigMember(path)).toEqual({ kind: "rewritten", removed: 1 });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ sessionIntel: { enabled: false } });
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["config.json"]);
    expect(retireGlobalConfigMember(path)).toEqual({ kind: "unchanged" });
  });

  it("refuses a global config owned by another uid and leaves it untouched", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, '{"limitResume":{},"a":1}');
    const real = process.getuid;
    const mine = lstatSync(path).uid;
    Object.defineProperty(process, "getuid", { value: () => mine + 1, configurable: true });
    try {
      expect(retireGlobalConfigMember(path)).toEqual({ kind: "refused", reason: `${path}: owned by uid ${mine}` });
    } finally {
      Object.defineProperty(process, "getuid", { value: real, configurable: true });
    }
    expect(readFileSync(path, "utf-8")).toBe('{"limitResume":{},"a":1}');
  });

  it("refuses a symlinked, malformed or concurrently edited global config", () => {
    const real = join(dir, "real.json");
    writeFileSync(real, '{"limitResume":{}}');
    const link = join(dir, "config.json");
    symlinkSync(real, link);
    expect(retireGlobalConfigMember(link)).toEqual({ kind: "refused", reason: `${link}: symlink` });
    expect(readFileSync(real, "utf-8")).toBe('{"limitResume":{}}');

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "[");
    expect(retireGlobalConfigMember(bad).kind).toBe("refused");

    const path = join(dir, "edited.json");
    writeFileSync(path, '{"limitResume":{},"a":1}');
    const r = retireGlobalConfigMember(path, { beforeRecheck: () => writeFileSync(path, '{"limitResume":{},"a":2}') });
    expect(r.kind).toBe("refused");
    expect(readFileSync(path, "utf-8")).toBe('{"limitResume":{},"a":2}');
    expect(retireGlobalConfigMember(join(dir, "none.json"))).toEqual({ kind: "absent" });
  });
});

describe("classifyLedger", () => {
  const record = (attempt: unknown, extra: Record<string, unknown> = {}) => ({
    clientTaskId: "task-1",
    projectRoot: "/p",
    storybloqSessionId: "s-1",
    attempt,
    ...extra,
  });
  const ledger = (records: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, records });
  const calls: string[] = [];
  const probes = (
    child: "match" | "absent" | "unknown",
    claimant: "alive" | "dead" | "unknown",
    scan: "present" | "absent" | "unknown" = "absent",
  ) => ({
    probeChild: (pid: number, markers: readonly string[]) => {
      calls.push(`child ${pid} ${markers.join(",")}`);
      return child;
    },
    inspectClaimant: (pid: number, signature: string | null) => {
      calls.push(`claimant ${pid} ${signature}`);
      return claimant;
    },
    scanForChild: (markers: readonly string[]) => {
      calls.push(`scan ${markers.join(",")}`);
      return scan;
    },
  });
  beforeEach(() => {
    calls.length = 0;
  });

  it("judges a spawned attempt by its child, not by a dead claimant", () => {
    const text = ledger({ "claude:task-1": record({ id: "a1", childPid: 42, claimantPid: 7, claimantSignature: "sig" }) });
    const r = classifyLedger(text, probes("match", "dead"));
    expect(r).toMatchObject({ kind: "ok", blocking: true, attempts: [{ kind: "child", verdict: "live", attemptId: "a1" }] });
    expect(calls).toEqual([`child 42 ${wakeChildMarkers("task-1", "a1").join(",")}`]);
    expect(classifyLedger(text, probes("absent", "alive"))).toMatchObject({ blocking: false, attempts: [{ verdict: "gone" }] });
    expect(classifyLedger(text, probes("unknown", "dead"))).toMatchObject({ blocking: true, attempts: [{ verdict: "preserve" }] });
  });

  it("preserves a child it cannot identify without probing", () => {
    for (const attempt of [{ id: "a1", childPid: -3 }, { childPid: 42 }]) {
      const r = classifyLedger(ledger({ k: record(attempt) }), probes("absent", "dead"));
      expect(r).toMatchObject({ blocking: true, attempts: [{ kind: "child", verdict: "preserve" }] });
    }
    const noTask = classifyLedger(ledger({ k: { attempt: { id: "a1", childPid: 42 } } }), probes("absent", "dead"));
    expect(noTask).toMatchObject({ blocking: true, attempts: [{ verdict: "preserve" }] });
    expect(calls).toEqual([]);
  });

  it("judges a bare claim by its claimant identity", () => {
    const text = ledger({ k: record({ id: "a1", childPid: null, claimantPid: 7, claimantSignature: "sig" }) });
    expect(classifyLedger(text, probes("absent", "alive"))).toMatchObject({ blocking: true, attempts: [{ kind: "claim", verdict: "live" }] });
    // A reused pid inspects as dead (signature mismatch) and the claim is gone.
    expect(classifyLedger(text, probes("match", "dead"))).toMatchObject({ blocking: false, attempts: [{ verdict: "gone" }] });
    expect(classifyLedger(text, probes("absent", "unknown"))).toMatchObject({ blocking: true, attempts: [{ verdict: "preserve" }] });
    expect(calls.filter((c) => !c.startsWith("scan ")).every((c) => c === "claimant 7 sig")).toBe(true);
  });

  it("a dead claimant with no recorded child is gone only when a process scan finds no child (spawned before the pid was persisted)", () => {
    const text = ledger({ k: record({ id: "a1", childPid: null, claimantPid: 7, claimantSignature: "sig" }) });
    // The waker spawned the child, then died before recording its pid.
    expect(classifyLedger(text, probes("absent", "dead", "present"))).toMatchObject({
      blocking: true, attempts: [{ kind: "claim", verdict: "live" }],
    });
    expect(calls).toContain(`scan ${wakeChildMarkers("task-1", "a1").join(",")}`);
    expect(classifyLedger(text, probes("absent", "dead", "unknown"))).toMatchObject({ blocking: true, attempts: [{ verdict: "preserve" }] });
    expect(classifyLedger(text, probes("absent", "dead", "absent"))).toMatchObject({ blocking: false, attempts: [{ verdict: "gone" }] });
    // An attempt that cannot name its child is preserved without a scan.
    calls.length = 0;
    const anonymous = ledger({ k: { projectRoot: "/p", storybloqSessionId: "s-1", attempt: { id: "a1", claimantPid: 7, claimantSignature: "sig" } } });
    expect(classifyLedger(anonymous, probes("absent", "dead", "absent"))).toMatchObject({ blocking: true, attempts: [{ verdict: "preserve" }] });
    expect(calls.some((c) => c.startsWith("scan "))).toBe(false);
  });

  it("preserves a claim with a missing signature or claimant", () => {
    const noSig = classifyLedger(ledger({ k: record({ id: "a1", claimantPid: 7 }) }), probes("absent", "unknown"));
    expect(noSig).toMatchObject({ blocking: true, attempts: [{ verdict: "preserve", reason: "claimant 7: unknown (no signature)" }] });
    expect(calls).toEqual(["claimant 7 null"]);
    const noClaimant = classifyLedger(ledger({ k: record({ id: "a1" }) }), probes("absent", "dead"));
    expect(noClaimant).toMatchObject({ blocking: true, attempts: [{ verdict: "preserve", reason: "claimant not recorded" }] });
  });

  it("lists referenced sessions, skips empty attempts and preserves malformed records", () => {
    const r = classifyLedger(
      ledger({ a: record(null), b: record(undefined, { storybloqSessionId: "s-2" }), c: "junk", d: record("junk") }),
      probes("absent", "dead"),
    );
    expect(r).toMatchObject({
      kind: "ok",
      blocking: true,
      sessions: [
        { projectRoot: "/p", sessionId: "s-1" },
        { projectRoot: "/p", sessionId: "s-2" },
        { projectRoot: "/p", sessionId: "s-1" },
      ],
      attempts: [
        { recordKey: "c", verdict: "preserve" },
        { recordKey: "d", verdict: "preserve" },
      ],
    });
    expect(classifyLedger(ledger({}))).toEqual({ kind: "ok", attempts: [], sessions: [], blocking: false });
  });

  it("reports a malformed ledger", () => {
    expect(classifyLedger("{").kind).toBe("malformed");
    expect(classifyLedger("[]").kind).toBe("malformed");
    expect(classifyLedger('{"records":[]}').kind).toBe("malformed");
  });
});

describe("retired waker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-limit-retire-waker-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fake process: alive until `diesAfter` signals of the listed kinds arrive. */
  function fakeWaker(opts: { identity?: "alive" | "unknown"; argv?: boolean; diesOn?: NodeJS.Signals | null; unknownAfterTerm?: boolean }) {
    const sent: NodeJS.Signals[] = [];
    let dead = false;
    const deps: WakerStopDeps = {
      inspect: () => {
        if (dead) return "dead";
        if (opts.unknownAfterTerm && sent.length > 0) return "unknown";
        return opts.identity ?? "alive";
      },
      isWakerArgv: () => opts.argv ?? true,
      signal: (_pid, sig) => {
        sent.push(sig);
        if (opts.diesOn === sig) dead = true;
      },
      sleep: async () => {},
    };
    return { deps, sent };
  }
  const lock = (body: unknown) => {
    const path = join(dir, "waker.lock");
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  };

  it("stops a verified waker with SIGTERM, and SIGKILLs one that ignores it", async () => {
    const path = lock({ pid: 4242, processSignature: "sig" });
    const term = fakeWaker({ diesOn: "SIGTERM" });
    expect(await stopRetiredWaker(path, term.deps)).toMatchObject({ kind: "stopped", killed: false });
    expect(term.sent).toEqual(["SIGTERM"]);
    const kill = fakeWaker({ diesOn: "SIGKILL" });
    expect(await stopRetiredWaker(path, kill.deps)).toMatchObject({ kind: "stopped", killed: true });
    expect(kill.sent).toEqual(["SIGTERM", "SIGKILL"]);
    const stuck = fakeWaker({ diesOn: null });
    expect(await stopRetiredWaker(path, stuck.deps)).toMatchObject({ kind: "refused" });
    expect(stuck.sent).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("never signals a dead, unverifiable or foreign pid", async () => {
    const path = lock({ pid: 4242, processSignature: "sig" });
    const dead = fakeWaker({ diesOn: null });
    dead.deps = { ...dead.deps, inspect: () => "dead" };
    expect(await stopRetiredWaker(path, dead.deps)).toMatchObject({ kind: "not-running" });
    expect(dead.sent).toEqual([]);
    const unknown = fakeWaker({ identity: "unknown" });
    expect(await stopRetiredWaker(path, unknown.deps)).toMatchObject({ kind: "refused" });
    const foreign = fakeWaker({ argv: false });
    expect(await stopRetiredWaker(path, foreign.deps)).toMatchObject({ kind: "refused" });
    expect([...unknown.sent, ...foreign.sent]).toEqual([]);
    const lost = fakeWaker({ unknownAfterTerm: true });
    expect(await stopRetiredWaker(path, lost.deps)).toMatchObject({ kind: "refused" });
    expect(lost.sent).toEqual(["SIGTERM"]);
  });

  it("refuses an unreadable, symlinked or pid-less lock and reports an absent one", async () => {
    const quiet = fakeWaker({});
    expect(await stopRetiredWaker(join(dir, "none.lock"), quiet.deps)).toEqual({ kind: "absent" });
    expect(await stopRetiredWaker(lock("{"), quiet.deps)).toMatchObject({ kind: "refused" });
    expect(await stopRetiredWaker(lock({ pid: 0 }), quiet.deps)).toMatchObject({ kind: "refused" });
    const real = join(dir, "real.lock");
    writeFileSync(real, JSON.stringify({ pid: 4242, processSignature: "sig" }));
    const link = join(dir, "link.lock");
    symlinkSync(real, link);
    expect(await stopRetiredWaker(link, quiet.deps)).toEqual({ kind: "refused", reason: `${link}: symlink` });
    expect(quiet.sent).toEqual([]);
  });

  it("unlinks only the file first identified", () => {
    const path = join(dir, "a.lock");
    writeFileSync(path, "x");
    const first = readOwnedFileNoFollow(path, 100);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    renameSync(path, join(dir, "old.lock"));
    writeFileSync(path, "y");
    expect(unlinkIdentified(path, first)).toBe(`${path}: changed since inspection`);
    expect(existsSync(path)).toBe(true);
    const second = readOwnedFileNoFollow(path, 100);
    if (second.kind !== "ok") throw new Error("read");
    expect(unlinkIdentified(path, second)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(unlinkIdentified(path, second)).toBeNull();
    expect(readOwnedFileNoFollow(path, 100)).toEqual({ kind: "absent" });
    writeFileSync(path, "toolong");
    expect(readOwnedFileNoFollow(path, 3).kind).toBe("refused");
  });
});

describe("runLimitRetirement", () => {
  let home: string;
  let globalDir: string;
  let settingsPath: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-limit-retire-run-"));
    globalDir = join(home, ".claude", "storybloq");
    mkdirSync(globalDir, { recursive: true });
    settingsPath = join(home, ".claude", "settings.json");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const noWaker: WakerStopDeps = {
    inspect: () => "dead",
    isWakerArgv: () => false,
    signal: () => {
      throw new Error("must not signal");
    },
    sleep: async () => {},
  };
  const seen: string[][] = [];
  const deps = (over: Partial<RetirementDeps> = {}): RetirementDeps => ({
    globalDir,
    settingsPath,
    cliVersion: "1.16.0",
    probes: { probeChild: () => "absent", inspectClaimant: () => "dead", scanForChild: () => "absent" },
    waker: noWaker,
    normalizeSessions: async (sessions) => {
      seen.push(sessions.map((s) => `${s.projectRoot}#${s.sessionId}`));
      return [];
    },
    lockDeadlineMs: 200,
    ...over,
  });
  const installLegacy = () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          StopFailure: [{ matcher: "rate_limit", hooks: [cmd("storybloq session limit-stop")] }],
          Stop: [{ matcher: "", hooks: [cmd("third-party stop")] }],
        },
      }),
    );
    writeFileSync(join(globalDir, "waker.lock"), JSON.stringify({ pid: 4242, processSignature: "sig" }));
    // A ledger writer that died holding its lock.
    writeFileSync(join(globalDir, "limit-ledger.lock"), JSON.stringify({ pid: deadPid(), token: "stale", processSignature: null }));
    writeFileSync(
      join(globalDir, "limit-ledger.json"),
      JSON.stringify({
        schemaVersion: 1,
        records: { "claude:t": { clientTaskId: "t", projectRoot: "/p", storybloqSessionId: "s", attempt: { id: "a", childPid: 99 } } },
      }),
    );
    mkdirSync(join(globalDir, "wake-claims", "s"), { recursive: true });
    writeFileSync(join(globalDir, "wake-claims", "s", "wake-claim.json"), "{}");
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ limitResume: { enabled: true }, other: 1 }));
  };
  beforeEach(() => {
    seen.length = 0;
  });

  it("retires everything, writes the marker, and is a no-op afterwards", async () => {
    installLegacy();
    const r = await runLimitRetirement(deps());
    expect(r.kind).toBe("retired");
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ hooks: { Stop: [{ matcher: "", hooks: [cmd("third-party stop")] }] } });
    expect(readdirSync(globalDir).sort()).toEqual([RETIREMENT_MARKER_BASENAME, "config.json"].sort());
    expect(JSON.parse(readFileSync(join(globalDir, "config.json"), "utf-8"))).toEqual({ other: 1 });
    expect(JSON.parse(readFileSync(join(globalDir, RETIREMENT_MARKER_BASENAME), "utf-8"))).toMatchObject({ cliVersion: "1.16.0" });
    expect(seen).toEqual([["/p#s"]]);
    expect(await runLimitRetirement(deps())).toEqual({ kind: "already" });
  });

  it("keeps the ledger, claims and waker.lock and writes no marker while an attempt lives", async () => {
    installLegacy();
    const r = await runLimitRetirement(deps({ probes: { probeChild: () => "match", inspectClaimant: () => "dead", scanForChild: () => "absent" } }));
    expect(r.kind).toBe("incomplete");
    for (const name of ["limit-ledger.json", "wake-claims", "waker.lock", "limit-ledger.lock"]) {
      expect(existsSync(join(globalDir, name))).toBe(true);
    }
    expect(existsSync(join(globalDir, RETIREMENT_MARKER_BASENAME))).toBe(false);
    // Hooks are still retired, and the next run finishes once the child is gone.
    expect(readFileSync(settingsPath, "utf-8")).not.toContain("limit-stop");
    expect((await runLimitRetirement(deps())).kind).toBe("retired");
  });

  it("removes the ledger only through its lock: a live or unreadable holder keeps both (T-534 round 2)", async () => {
    installLegacy();
    const lockPath = join(globalDir, "limit-ledger.lock");
    const live = JSON.stringify({ pid: process.pid, token: "writer", acquiredAt: Date.now(), renewedAt: Date.now(), processSignature: captureProcessSignatureSync(process.pid) });
    writeFileSync(lockPath, live);
    const r = await runLimitRetirement(deps());
    expect(r).toMatchObject({ kind: "incomplete", problems: [expect.stringContaining("held by a live ledger writer")] });
    expect(readFileSync(lockPath, "utf-8")).toBe(live);
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(true);
    expect(existsSync(join(globalDir, RETIREMENT_MARKER_BASENAME))).toBe(false);

    writeFileSync(lockPath, "{");
    expect((await runLimitRetirement(deps())).kind).toBe("incomplete");
    expect(readFileSync(lockPath, "utf-8")).toBe("{");
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(true);

    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), token: "gone", processSignature: null }));
    expect((await runLimitRetirement(deps())).kind).toBe("retired");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(false);
  });

  it("fences a ledger writer paused between its ownership check and its rename (T-534 round 2)", async () => {
    installLegacy();
    const lockPath = join(globalDir, "limit-ledger.lock");
    const ledgerPath = join(globalDir, "limit-ledger.json");
    const late = JSON.stringify({ schemaVersion: 1, records: {} });
    let heldByUs = false;
    const r = await runLimitRetirement(deps({
      ledgerHooks: {
        afterLedgerUnlink: () => {
          // The lock names this process with a fresh token, so a waiting
          // writer's fence (token check before rename) fails ...
          const body = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid: number; token: string };
          heldByUs = body.pid === process.pid && body.token !== "stale";
          // ... but one that passed its fence earlier renames anyway.
          writeFileSync(ledgerPath, late);
        },
      },
    }));
    expect(heldByUs).toBe(true);
    expect(r).toMatchObject({ kind: "incomplete", problems: [expect.stringContaining("rewritten by a retired ledger writer")] });
    expect(readFileSync(ledgerPath, "utf-8")).toBe(late);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(globalDir, RETIREMENT_MARKER_BASENAME))).toBe(false);
    // The next command removes the late ledger and finishes.
    expect((await runLimitRetirement(deps())).kind).toBe("retired");
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("leaves the waker lock and ledger when the waker cannot be stopped", async () => {
    installLegacy();
    const r = await runLimitRetirement(deps({ waker: { ...noWaker, inspect: () => "unknown" } }));
    expect(r.kind).toBe("incomplete");
    expect(existsSync(join(globalDir, "waker.lock"))).toBe(true);
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(true);
    expect(existsSync(join(globalDir, RETIREMENT_MARKER_BASENAME))).toBe(false);
  });

  it("keeps a malformed ledger and refuses a claims tree it cannot vouch for", async () => {
    installLegacy();
    writeFileSync(join(globalDir, "limit-ledger.json"), "{");
    expect((await runLimitRetirement(deps())).kind).toBe("incomplete");
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(true);
    writeFileSync(join(globalDir, "limit-ledger.json"), JSON.stringify({ records: {} }));
    const outside = join(home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "k");
    symlinkSync(outside, join(globalDir, "wake-claims", "s", "escape"));
    expect((await runLimitRetirement(deps())).kind).toBe("incomplete");
    expect(readFileSync(join(outside, "keep"), "utf-8")).toBe("k");
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(true);
    expect(existsSync(join(globalDir, RETIREMENT_MARKER_BASENAME))).toBe(false);
  });

  it("skips when another process holds the retirement lock", async () => {
    installLegacy();
    writeFileSync(
      join(globalDir, RETIREMENT_LOCK_BASENAME),
      JSON.stringify({ pid: process.pid, token: "held", acquiredAt: Date.now(), processSignature: null }),
    );
    expect(await runLimitRetirement(deps())).toEqual({ kind: "busy" });
    expect(existsSync(join(globalDir, "limit-ledger.json"))).toBe(true);
  });

  it("succeeds on a clean HOME and on one with no settings file", async () => {
    expect((await runLimitRetirement(deps())).kind).toBe("retired");
    expect(seen).toEqual([[]]);
  });
});
