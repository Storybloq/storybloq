/**
 * ISS-1022: the presence hook against a real project directory.
 *
 * This handler runs SYNCHRONOUSLY on every PreToolUse and PostToolUse, in a
 * process whose non-zero exit would BLOCK the user's tool call. So the tests
 * that matter most here are not the happy path -- they are the ones proving
 * that a corrupt, hostile or contended checkout costs a bounded amount of time
 * and then gets out of the way.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runPresenceHook, isPresenceEnabled, correlatesWithActiveAutonomousSession, removePresenceRecords } from "../../src/presence/handler.js";
import { isValidSessionId, parsePresenceRecord } from "../../src/presence/record.js";
import { LOCK_ACQUIRE_BUDGET_MS, acquireLock, releaseLock } from "../../src/presence/io.js";
import { MAX_PRESENCE_BASENAME_BYTES, PRESENCE_TTL_MS, presenceFileBase, type SessionPresence } from "../../src/presence/types.js";

const SESSION = "sess-handler-1";

let root: string;
let presenceDir: string;

function config(value: Record<string, unknown> = { version: 1 }): void {
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify(value));
}

function hook(event: string, over: Record<string, unknown> = {}, now = new Date("2026-08-20T12:00:00.000Z")) {
  return runPresenceHook({ hook_event_name: event, session_id: SESSION, cwd: root, ...over }, now);
}

function readSessionId(fileName: string): string | null {
  const parsed = JSON.parse(readFileSync(join(presenceDir, fileName), "utf-8")) as { sessionId?: string };
  return parsed.sessionId ?? null;
}

function record(sessionId = SESSION): SessionPresence | null {
  const path = join(presenceDir, `${sessionId}.json`);
  if (!existsSync(path)) return null;
  return parsePresenceRecord(readFileSync(path, "utf-8"), sessionId);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "presence-handler-"));
  mkdirSync(join(root, ".story"));
  config();
  presenceDir = join(root, ".story", "telemetry", "presence");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("presence hook happy path (ISS-1022)", () => {
  it("writes the record under .story/telemetry/presence/", () => {
    expect(hook("SessionStart", { source: "startup" })).toBe("written");
    expect(existsSync(join(presenceDir, `${SESSION}.json`))).toBe(true);
    expect(record()!.generation).toBe(1);
  });

  /**
   * The location is the whole reason older app versions do not churn. A
   * sibling such as `.story/presence/` falls through the Mac app's
   * `FileWatcher.classify` to `.state` and triggers a FULL PROJECT RELOAD per
   * tool call on a machine running a build that knows nothing about presence.
   * `rootWatcherPathFilter` has dropped every `/telemetry/` path except
   * `alive` and `lastMcpCall` since T-282, which predates both shipped
   * releases, so this path is invisible there.
   */
  it("writes nowhere except under the telemetry subtree", () => {
    hook("SessionStart", { source: "startup" });
    expect(existsSync(join(root, ".story", "presence"))).toBe(false);
    expect(readdirSync(join(root, ".story")).sort()).toEqual(["config.json", "telemetry"]);
  });

  it("drives a full turn: start, tool open, tool close, stop", () => {
    hook("SessionStart", { source: "startup" });
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "tu_1", tool_input: { file_path: join(root, ".story", "config.json") } });
    expect(record()!.openTools).toHaveLength(1);
    expect(record()!.openTools[0]!.target).toBe(".story/config.json");
    hook("PostToolUse", { tool_name: "Read", tool_use_id: "tu_1" });
    expect(record()!.openTools).toEqual([]);
    hook("Stop");
    expect(record()!.endedAt).toBeNull();
    hook("SessionEnd", { reason: "exit" });
    expect(record()!.endedAt).not.toBeNull();
  });

  it("keeps concurrent sessions in separate records", () => {
    hook("SessionStart", { source: "startup" });
    runPresenceHook({ hook_event_name: "SessionStart", session_id: "sess-other", cwd: root, source: "startup" });
    expect(readdirSync(presenceDir).filter((f) => f.endsWith(".json")).sort())
      .toEqual([`${SESSION}.json`, "sess-other.json"]);
  });
});

describe("presence hook refusals (ISS-1022)", () => {
  it("does nothing for a hook event it does not handle", () => {
    expect(hook("PreCompact")).toBe("skipped-not-presence-event");
    expect(runPresenceHook("not an object")).toBe("skipped-not-presence-event");
    expect(runPresenceHook(null)).toBe("skipped-not-presence-event");
    expect(existsSync(presenceDir)).toBe(false);
  });

  it("refuses an invalid session id rather than deriving a filename from it", () => {
    for (const bad of ["../escape", "", ".", "..", "a/b", "a\\b", "/abs", ".hidden", "a b", "x".repeat(129), 42, null]) {
      expect(runPresenceHook({ hook_event_name: "Stop", session_id: bad, cwd: root })).toBe("skipped-invalid-session");
    }
    expect(existsSync(presenceDir)).toBe(false);
  });

  /**
   * These ids are LEGAL -- they match the client task id shape -- but writing
   * them verbatim would break on Windows: `:` is NTFS alternate-data-stream
   * syntax, and `CON`/`AUX`/`COM1` are device names. Refusing them would
   * silently drop presence for a session whose id is perfectly valid, so they
   * go into the encoded namespace instead, and the id itself is preserved
   * inside the record where the app reads it from.
   *
   * The expected basenames are written out rather than derived from
   * `presenceFileBase`, so this is a specification of the mapping and not a
   * restatement of whatever the implementation currently does.
   */
  it("accepts portability-hazard ids and encodes them into a safe filename", () => {
    const cases: Array<[string, string]> = [
      ["task:123", "_orqxg2z2gezdg.json"],       // colon: NTFS alternate data stream
      ["CON", "_inhu4.json"],                    // Windows console device
      ["com1", "_mnxw2mi.json"],                 // Windows serial port, case-insensitive
      ["aux.thing", "_mf2xqltunbuw4zy.json"],    // device name with an extension
      ["MixedCase", "_jvuxqzleinqxgzi.json"],    // uppercase: folds on APFS/NTFS
      ["ordinary-id", "ordinary-id.json"],          // lowercase and portable: kept readable
    ];
    for (const [id, expectedFile] of cases) {
      expect(runPresenceHook({ hook_event_name: "SessionStart", session_id: id, cwd: root, source: "startup" })).toBe("written");
      expect(existsSync(join(presenceDir, expectedFile)), `${id} -> ${expectedFile}`).toBe(true);
      expect(readSessionId(expectedFile), "the raw id survives in the body").toBe(id);
    }
    // The mapping is injective: no two ids share a record.
    expect(new Set(cases.map(([, f]) => f)).size).toBe(cases.length);
    expect(readdirSync(presenceDir).filter((f) => f.endsWith(".json"))).toHaveLength(cases.length);
  });

  /**
   * The case percent-encoding could not survive: a legal 128-character id made
   * entirely of colons would triple to 384 characters and blow past the
   * 255-byte component limit every mainstream filesystem imposes, so every
   * write for that session would fail silently. Lowercase base32 is bounded by
   * construction AND collision-free under filesystem case folding, which is why
   * the encoded namespace uses it.
   */
  it("keeps the filename inside the filesystem's component limit for the longest legal id", () => {
    const worst = "a" + ":".repeat(127);
    expect(worst).toHaveLength(128);
    expect(runPresenceHook({ hook_event_name: "SessionStart", session_id: worst, cwd: root, source: "startup" })).toBe("written");

    const files = readdirSync(presenceDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(Buffer.byteLength(files[0]!, "utf-8")).toBeLessThan(255);
    // The id itself is preserved in the body, which is where the app reads it.
    expect(readSessionId(files[0]!)).toBe(worst);
    expect(presenceFileBase(worst).length).toBeLessThanOrEqual(MAX_PRESENCE_BASENAME_BYTES);
    expect(MAX_PRESENCE_BASENAME_BYTES + ".json".length).toBeLessThan(255);
  });

  /**
   * The two namespaces must not overlap. `_` cannot begin an accepted session
   * id, so a literal id can never collide with an encoded one -- which is the
   * property that makes the readable fast path safe to have at all.
   */
  it("the readable and encoded filename namespaces cannot collide", () => {
    const encoded = presenceFileBase("has:colon");
    expect(encoded.startsWith("_")).toBe(true);
    expect(isValidSessionId(encoded)).toBe(false);
    // ...so no session id exists that would be written to that same basename.
    expect(presenceFileBase("plain-id")).toBe("plain-id");
  });

  /**
   * The hazard that string-level uniqueness does not cover. APFS and NTFS fold
   * case by DEFAULT, so `abc` and `ABC` are the same file: two live sessions
   * would overwrite each other's records, on the primary target platform, with
   * no error anywhere. Every basename this writer produces must therefore stay
   * distinct after case folding -- which is why the encoded namespace is
   * lowercase base32 and not base64url.
   */
  it("basenames stay distinct under filesystem case folding", () => {
    const ids = ["abc", "ABC", "AbC", "session-1", "SESSION-1", "a:b", "A:B", "con", "CON"];
    const folded = ids.map((id) => presenceFileBase(id).toLowerCase());
    expect(new Set(folded).size, `collision among ${folded.join(", ")}`).toBe(ids.length);
    // The whole produced alphabet is case-fold-stable: no basename changes
    // under folding, so equality after folding is equality outright.
    for (const id of ids) {
      const base = presenceFileBase(id);
      expect(base.toLowerCase(), `${id} -> ${base} must be fold-stable`).toBe(base);
    }
  });

  /** base32 must round-trip distinctly across every length, not just collide-free at one. */
  it("the encoded namespace is injective across lengths", () => {
    const ids = Array.from({ length: 40 }, (_, i) => "A".repeat(i + 1));
    const bases = ids.map((id) => presenceFileBase(id));
    expect(new Set(bases).size).toBe(ids.length);
    expect(bases.every((b) => b.startsWith("_") && /^_[a-z2-7]+$/.test(b))).toBe(true);
  });

  it("does nothing outside a storybloq project", () => {
    const bare = mkdtempSync(join(tmpdir(), "presence-bare-"));
    try {
      expect(runPresenceHook({ hook_event_name: "Stop", session_id: SESSION, cwd: bare })).toBe("skipped-no-project");
      expect(runPresenceHook({ hook_event_name: "Stop", session_id: SESSION })).toBe("skipped-no-project");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("presence opt-out (ISS-1022)", () => {
  it("writes nothing when statusWriter.presence is false", () => {
    config({ version: 1, statusWriter: { presence: false } });
    expect(hook("SessionStart", { source: "startup" })).toBe("skipped-disabled");
    expect(existsSync(join(presenceDir, `${SESSION}.json`))).toBe(false);
  });

  /**
   * Fails OPEN to enabled on every uncertainty, matching
   * `isStopHookStatusWriteEnabled`: a broken config must never silently blind
   * the Mac app. Only an explicit `false` disables.
   */
  it("fails open to enabled for absent, malformed and non-boolean config", () => {
    rmSync(join(root, ".story", "config.json"));
    expect(isPresenceEnabled(root)).toBe(true);
    writeFileSync(join(root, ".story", "config.json"), "{not json");
    expect(isPresenceEnabled(root)).toBe(true);
    config({ version: 1, statusWriter: { presence: "no" } });
    expect(isPresenceEnabled(root)).toBe(true);
    config({ version: 1, statusWriter: "nonsense" });
    expect(isPresenceEnabled(root)).toBe(true);
  });

  /** config.json is USER input, so a legitimately symlinked config is honoured. */
  it("honours a symlinked config.json", () => {
    const real = join(root, "real-config.json");
    writeFileSync(real, JSON.stringify({ version: 1, statusWriter: { presence: false } }));
    rmSync(join(root, ".story", "config.json"));
    symlinkSync(real, join(root, ".story", "config.json"));
    expect(isPresenceEnabled(root)).toBe(false);
  });

  it("removePresenceRecords clears an existing directory", () => {
    hook("SessionStart", { source: "startup" });
    expect(readdirSync(presenceDir).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(removePresenceRecords(root)).toBeGreaterThan(0);
    expect(readdirSync(presenceDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
    // Idempotent, and cheap when there is no directory at all.
    expect(removePresenceRecords(root)).toBe(0);
    rmSync(presenceDir, { recursive: true });
    expect(removePresenceRecords(root)).toBe(0);
  });
});

describe("autonomous correlation (ISS-1022)", () => {
  function status(payload: Record<string, unknown>): void {
    writeFileSync(join(root, ".story", "status.json"), JSON.stringify(payload));
  }

  it("suppresses a session that matches the active autonomous claudeCodeSessionId", () => {
    status({ sessionActive: true, claudeCodeSessionId: SESSION });
    hook("SessionStart", { source: "startup" });
    expect(record()!.suppressed).toBe(true);
  });

  it("suppresses a session that matches the active autonomous ownerTask id", () => {
    status({ sessionActive: true, claudeCodeSessionId: null, ownerTask: { client: "claude", id: SESSION, boundAt: "x" } });
    hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tu_1" });
    expect(record()!.suppressed).toBe(true);
  });

  /**
   * `unowned` returning false is a deliberate decision, not a fallthrough. An
   * active autonomous session that records NO owner is not evidence that THIS
   * Claude session is the one driving it, and suppressing on that basis would
   * hide an unrelated interactive session in any project where an ownerless
   * autonomous session happens to be running.
   */
  it("does not suppress when the active autonomous session records no owner at all", () => {
    status({ sessionActive: true });
    hook("SessionStart", { source: "startup" });
    expect(record()!.suppressed).toBe(false);
    expect(correlatesWithActiveAutonomousSession(root, SESSION)).toBe(false);
  });

  /**
   * ownerTask WINS over the legacy id. That precedence is the ISS-899
   * resolver's, which is exactly why this reads through it rather than
   * comparing the two fields here: a sixth hand-rolled copy is how the first
   * five drifted.
   */
  it("honours ownerTask precedence when the legacy id disagrees with it", () => {
    status({
      sessionActive: true,
      claudeCodeSessionId: SESSION,
      ownerTask: { client: "claude", id: "a-different-task", boundAt: "x" },
    });
    expect(correlatesWithActiveAutonomousSession(root, SESSION)).toBe(false);
    // ...and the mirror image: ownerTask matches while the legacy id does not.
    status({
      sessionActive: true,
      claudeCodeSessionId: "a-different-task",
      ownerTask: { client: "claude", id: SESSION, boundAt: "x" },
    });
    expect(correlatesWithActiveAutonomousSession(root, SESSION)).toBe(true);
  });

  it("ignores a malformed ownerTask rather than trusting its id", () => {
    status({ sessionActive: true, ownerTask: { id: SESSION } });         // no client
    expect(correlatesWithActiveAutonomousSession(root, SESSION)).toBe(false);
    status({ sessionActive: true, ownerTask: [SESSION] });
    expect(correlatesWithActiveAutonomousSession(root, SESSION)).toBe(false);
  });

  it("does not suppress an unrelated session, or one whose autonomous session is inactive", () => {
    status({ sessionActive: true, claudeCodeSessionId: "somebody-else" });
    hook("SessionStart", { source: "startup" });
    expect(record()!.suppressed).toBe(false);
    status({ sessionActive: false });
    hook("Stop");
    expect(record()!.suppressed).toBe(false);
  });

  /**
   * The init race: PreToolUse for the FIRST guide call can precede the
   * autonomous record existing, so a plain record is created and must then be
   * suppressed rather than duplicated in the panel.
   */
  it("suppresses a record that already existed before the autonomous session appeared", () => {
    hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tu_1" });
    expect(record()!.suppressed).toBe(false);
    status({ sessionActive: true, claudeCodeSessionId: SESSION });
    hook("PostToolUse", { tool_name: "Bash", tool_use_id: "tu_1" });
    expect(record()!.suppressed).toBe(true);
  });

  /**
   * The reversal case end to end. This is why suppression is a FLAG and not a
   * tombstone: the user keeps working in the same Claude session after
   * `/story auto` finishes, with no new SessionStart, and a tombstone would
   * hide the rest of that session's work permanently.
   */
  it("un-suppresses when the autonomous session completes and the user keeps working", () => {
    hook("SessionStart", { source: "startup" });
    expect(record()!.suppressed).toBe(false);

    status({ sessionActive: true, claudeCodeSessionId: SESSION });
    hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tu_auto" });
    expect(record()!.suppressed).toBe(true);

    status({ sessionActive: false });
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "tu_after" });
    expect(record()!.suppressed).toBe(false);
    expect(record()!.endedAt).toBeNull();
  });

  /** status.json is a GENERATED artifact, so a symlink there is refused rather than followed. */
  it("refuses a symlinked status.json", () => {
    const real = join(root, "elsewhere-status.json");
    writeFileSync(real, JSON.stringify({ sessionActive: true, claudeCodeSessionId: SESSION }));
    symlinkSync(real, join(root, ".story", "status.json"));
    expect(correlatesWithActiveAutonomousSession(root, SESSION)).toBe(false);
  });

  /**
   * ISS-1012 shipped a content gate that stopped status.json churn. Presence
   * must not reintroduce it through the back door.
   */
  it("leaves status.json byte-identical across a full interactive turn", () => {
    status({ sessionActive: false, source: "hook" });
    const path = join(root, ".story", "status.json");
    const before = readFileSync(path);
    const beforeStat = statSync(path);

    hook("SessionStart", { source: "startup" });
    for (let i = 0; i < 10; i++) {
      hook("PreToolUse", { tool_name: "Read", tool_use_id: `tu_${i}`, tool_input: { file_path: join(root, ".story", "config.json") } });
      hook("PostToolUse", { tool_name: "Read", tool_use_id: `tu_${i}` });
    }
    hook("Stop");

    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).ino).toBe(beforeStat.ino);
    expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs);
  });
});

describe("hot-path hardening (ISS-1022)", () => {
  /**
   * Both project-controlled files the hook reads before the lock are now on a
   * synchronous per-tool-call path, so a FIFO at either one must not hang
   * every tool call in a corrupt or hostile checkout.
   */
  it.skipIf(process.platform === "win32")("a FIFO at config.json or status.json neither hangs nor blocks", () => {
    rmSync(join(root, ".story", "config.json"));
    execFileSync("mkfifo", [join(root, ".story", "config.json")]);
    // The FIFO makes config.json unreadable, so root discovery no longer finds
    // this directory by config.json -- pin the outcome via the reader instead.
    const started = Date.now();
    expect(isPresenceEnabled(root)).toBe(true); // unreadable -> fail open
    expect(Date.now() - started).toBeLessThan(1000);

    execFileSync("mkfifo", [join(root, ".story", "status.json")]);
    const t2 = Date.now();
    expect(correlatesWithActiveAutonomousSession(root, SESSION)).toBe(false);
    expect(Date.now() - t2).toBeLessThan(1000);
  });

  it("an oversized config.json or status.json is refused rather than loaded", () => {
    writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ version: 1, pad: "x".repeat(300_000) }));
    expect(isPresenceEnabled(root)).toBe(true); // over the bound -> unreadable -> fail open
    writeFileSync(join(root, ".story", "status.json"), JSON.stringify({ sessionActive: true, claudeCodeSessionId: SESSION, pad: "x".repeat(300_000) }));
    expect(correlatesWithActiveAutonomousSession(root, SESSION)).toBe(false);
  });

  /**
   * The budget that matters: a stale lock left by a crashed hook must cost at
   * most LOCK_ACQUIRE_BUDGET_MS and then DROP the update. The autonomous
   * lock discipline's 2s deadline would stall every tool call on the project.
   */
  it("a held lock costs at most the acquire budget and drops the write", () => {
    hook("SessionStart", { source: "startup" });
    const before = record()!;
    mkdirSync(join(presenceDir, `${SESSION}.lock`));

    const started = Date.now();
    const outcome = hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tu_blocked" });
    const elapsed = Date.now() - started;

    expect(outcome).toBe("skipped-lock-busy");
    expect(elapsed).toBeLessThan(LOCK_ACQUIRE_BUDGET_MS + 150);
    expect(record()!.lastEventAt).toBe(before.lastEventAt); // dropped, not corrupted

    // The next event repairs it once the lock clears.
    rmSync(join(presenceDir, `${SESSION}.lock`), { recursive: true });
    expect(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tu_ok" }, new Date("2026-08-20T12:05:00.000Z"))).toBe("written");
    expect(record()!.openTools.map((t) => t.id)).toEqual(["tu_ok"]);
  });

  /**
   * The branches that could actually break the bound are the ones where the
   * lock can NEVER be acquired. A non-directory squatting on the lock path
   * makes `mkdir` return EEXIST forever, and polling it would burn the whole
   * budget on every event for something that will never clear; a persistent
   * `lstat` error would spin with no sleep at all until the client's own hook
   * timeout killed the process.
   */
  it("refuses immediately when the lock path can never become acquirable", () => {
    mkdirSync(presenceDir, { recursive: true });
    const lockPath = join(presenceDir, "squatted.lock");

    writeFileSync(lockPath, "not a directory");
    let started = Date.now();
    expect(acquireLock(lockPath)).toBe(false);
    expect(Date.now() - started, "a regular file must not cost the polling budget").toBeLessThan(LOCK_ACQUIRE_BUDGET_MS / 2);

    rmSync(lockPath);
    symlinkSync(join(root, ".story"), lockPath, "dir");
    started = Date.now();
    expect(acquireLock(lockPath)).toBe(false);
    expect(Date.now() - started, "a symlink must not cost the polling budget").toBeLessThan(LOCK_ACQUIRE_BUDGET_MS / 2);
  });

  /**
   * A stale lock directory that cannot be removed -- non-empty, because
   * something crashed mid-write inside it -- used to be the worst case of all:
   * `rmdir` fails, the failure is swallowed, and because the lock reads as
   * stale the loop skips its sleep entirely and spins for the full budget on
   * every single tool call, forever.
   */
  it("refuses immediately when a stale lock cannot be removed", () => {
    mkdirSync(presenceDir, { recursive: true });
    const lockPath = join(presenceDir, "stuck.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "leftover"), "x"); // rmdir will fail with ENOTEMPTY
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockPath, longAgo, longAgo);

    const started = Date.now();
    expect(acquireLock(lockPath)).toBe(false);
    expect(Date.now() - started, "a stuck stale lock must not cost the polling budget")
      .toBeLessThan(LOCK_ACQUIRE_BUDGET_MS / 2);
  });

  it("acquires a free lock immediately and releases it", () => {
    mkdirSync(presenceDir, { recursive: true });
    const lockPath = join(presenceDir, "free.lock");
    const started = Date.now();
    expect(acquireLock(lockPath)).toBe(true);
    expect(Date.now() - started).toBeLessThan(LOCK_ACQUIRE_BUDGET_MS / 2);
    expect(acquireLock(lockPath), "a held lock is not re-acquirable").toBe(false);
    releaseLock(lockPath);
    expect(acquireLock(lockPath)).toBe(true);
    releaseLock(lockPath);
  });

  /** A lock left by a crashed hook must not block the project forever. */
  it("reclaims a stale lock rather than waiting out the budget", () => {
    mkdirSync(presenceDir, { recursive: true });
    const lockPath = join(presenceDir, "stale.lock");
    mkdirSync(lockPath);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockPath, longAgo, longAgo);
    const started = Date.now();
    expect(acquireLock(lockPath)).toBe(true);
    expect(Date.now() - started).toBeLessThan(LOCK_ACQUIRE_BUDGET_MS / 2);
    releaseLock(lockPath);
  });

  it("a corrupt record is replaced rather than failing the hook", () => {
    hook("SessionStart", { source: "startup" });
    writeFileSync(join(presenceDir, `${SESSION}.json`), "{{{ not json");
    expect(hook("PreToolUse", { tool_name: "Read", tool_use_id: "tu_1" })).toBe("written");
    expect(record()!.sessionId).toBe(SESSION);
  });
});

describe("presence sweep (ISS-1022)", () => {
  it("removes records past the TTL, and only on SessionStart or SessionEnd", () => {
    hook("SessionStart", { source: "startup" });
    const orphan = join(presenceDir, "sess-long-gone.json");
    writeFileSync(orphan, JSON.stringify({ sessionId: "sess-long-gone", startedAt: "2020-01-01T00:00:00.000Z" }));
    const old = new Date(Date.now() - PRESENCE_TTL_MS - 60_000);
    utimesSync(orphan, old, old);

    // A per-tool-call event must never pay for a directory scan.
    hook("PreToolUse", { tool_name: "Read", tool_use_id: "tu_1" });
    expect(existsSync(orphan)).toBe(true);
    hook("Stop");
    expect(existsSync(orphan)).toBe(true);

    hook("SessionStart", { source: "resume" }, new Date());
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(presenceDir, `${SESSION}.json`))).toBe(true);
  });
});
