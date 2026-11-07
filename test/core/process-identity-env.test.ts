/**
 * ISS-1421: a lock holder is never judged dead because the reader's locale or
 * timezone differs. Only a dead pid or a differing process start reclaims.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectProcessIdentity } from "../../src/bus/lock.js";
import { initProject } from "../../src/core/init.js";
import {
  DEFAULT_WAKER_STOP_DEPS,
  removeLedgerUnderLock,
  stopRetiredWaker,
} from "../../src/core/limit-retirement.js";
import {
  __processIdentitySeams,
  captureProcessSignatureSync,
  capturePinnedSignatureSync,
  inspectProcessIdentitySync,
  legacyVerdict,
  ownPinnedSignatureSync,
  verifyIdentityForSignalSync,
} from "../../src/core/process-identity.js";
import { acquireProjectLockAsync, releaseProjectLock } from "../../src/core/project-lock.js";
import { parseLstart } from "../../src/core/session-intel/process-era.js";

const OTHER_ENV: Record<string, string | undefined> = {
  LANG: "en_CA.UTF-8",
  LC_ALL: undefined,
  LC_TIME: undefined,
  TZ: "Asia/Tokyo",
};

async function withEnv<T>(env: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const children: ChildProcess[] = [];
const dirs: string[] = [];

async function liveChild(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((done) => child.once("spawn", () => done()));
  return child.pid!;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iss1421-"));
  dirs.push(dir);
  return dir;
}

const LSTART = "Wed Sep  9 12:15:15 2026";
const START = parseLstart(LSTART)!;
const pinned = (uid: number, start = START) => `darwin2:${uid}:${start}`;

/** Answers ps through the seam: `legacy` and `pinned` give stdout, or throw for a failed or timed out ps. */
function fakePs(answers: { legacy?: () => string; pinned?: () => string }): void {
  __processIdentitySeams.psOutput = (form) => {
    const answer = answers[form];
    if (!answer) throw new Error("ps failed");
    return answer();
  };
}

const eperm = () =>
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  });

beforeEach(() => {
  __processIdentitySeams.psOutput = null;
  __processIdentitySeams.resetOwnStart?.();
});

afterEach(() => {
  __processIdentitySeams.psOutput = null;
  __processIdentitySeams.resetOwnStart?.();
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin")("a different environment on Darwin", () => {
  it("a live holder read under another locale and timezone is not dead", async () => {
    const pid = await liveChild();
    const signature = captureProcessSignatureSync(pid);
    expect(signature).toMatch(/^darwin:[0-9a-f]{64}$/);
    const verdict = await withEnv(OTHER_ENV, () => inspectProcessIdentitySync(pid, signature));
    expect(verdict).not.toBe("dead");
  });

  it("a different-environment CLI does not write inside a project lock hold", async () => {
    const cli = resolve(process.cwd(), "dist/cli.js");
    expect(existsSync(cli), "dist/cli.js is built before this suite").toBe(true);
    const root = tempDir();
    await initProject(root, { name: "iss1421" });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
    const created = spawnSync(process.execPath, [cli, "ticket", "create", "--title", "a", "--type", "task"], {
      cwd: root, env, encoding: "utf-8",
    });
    expect(created.status, created.stderr).toBe(0);
    const tickets = join(root, ".story", "tickets");
    const file = join(tickets, readdirSync(tickets)[0]!);
    const before = readFileSync(file, "utf-8");
    const id = (JSON.parse(before) as { displayId?: string; id: string }).displayId ?? JSON.parse(before).id;

    const handle = await acquireProjectLockAsync(join(root, ".story", ".lock"));
    let released = false;
    const child = spawn(process.execPath, [cli, "ticket", "update", id, "--title", "b"], {
      cwd: root,
      env: { ...env, LANG: "en_CA.UTF-8", TZ: "Asia/Tokyo" },
      stdio: "ignore",
    });
    children.push(child);
    const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    try {
      await new Promise((done) => setTimeout(done, 2_000));
      expect(readFileSync(file, "utf-8"), "the CLI wrote inside the hold").toBe(before);
      releaseProjectLock(handle);
      released = true;
      expect(await exited).toBe(0);
      expect(readFileSync(file, "utf-8")).toContain('"title": "b"');
    } finally {
      if (!released) releaseProjectLock(handle);
    }
  }, 60_000);

  it("the limit ledger lock of a live holder is left in place by a different-environment reader", async () => {
    const pid = await liveChild();
    const dir = tempDir();
    const lockPath = join(dir, "limit-ledger.lock");
    const body = { pid, token: "t", acquiredAt: Date.now(), renewedAt: Date.now(), processSignature: captureProcessSignatureSync(pid) };
    writeFileSync(lockPath, JSON.stringify(body), { mode: 0o600 });
    const result = await withEnv(OTHER_ENV, () => removeLedgerUnderLock(dir, null));
    expect(result).toMatch(/held by/);
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).token).toBe("t");
  });
});

/** The same table holds for the sync path and the async bus path. */
const PATHS: Array<[string, (pid: number, signature: string | null, recorded?: unknown) => unknown]> = [
  ["core", inspectProcessIdentitySync],
  ["bus", inspectProcessIdentity],
];

describe.runIf(process.platform === "darwin").each(PATHS)("the Darwin table, %s path", (_name, inspect) => {
  const OUT = (uid: number, lstart = LSTART) => () => `  ${uid} ${lstart}\n`;

  it("a differing start is proven reuse", async () => {
    const pid = await liveChild();
    fakePs({ pinned: OUT(501, "Wed Sep  9 12:15:16 2026") });
    expect(await inspect(pid, "darwin:x", pinned(501))).toBe("dead");
  });

  it("a differing start with a differing uid is proven reuse", async () => {
    const pid = await liveChild();
    fakePs({ pinned: OUT(0, "Wed Sep  9 12:15:16 2026") });
    expect(await inspect(pid, "darwin:x", pinned(501))).toBe("dead");
  });

  it("an equal start and uid is alive, whatever the legacy value", async () => {
    const pid = await liveChild();
    fakePs({ pinned: OUT(501) });
    expect(await inspect(pid, "darwin:x", pinned(501))).toBe("alive");
  });

  it("a uid-only difference is unknown with a successful kill(0)", async () => {
    const pid = await liveChild();
    fakePs({ pinned: OUT(0) });
    expect(await inspect(pid, "darwin:x", pinned(501))).toBe("unknown");
  });

  it("a uid-only difference is unknown with EPERM", async () => {
    const pid = await liveChild();
    fakePs({ pinned: OUT(0) });
    eperm();
    expect(await inspect(pid, "darwin:x", pinned(501))).toBe("unknown");
  });

  it("EPERM with a differing start is dead", async () => {
    const pid = await liveChild();
    fakePs({ pinned: OUT(0, "Wed Sep  9 12:15:16 2026") });
    eperm();
    expect(await inspect(pid, "darwin:x", pinned(501))).toBe("dead");
  });

  it("EPERM with only a legacy value is unknown", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => "0 other" });
    eperm();
    expect(await inspect(pid, "darwin:x")).toBe("unknown");
  });

  it.each([
    ["failed or timed out", undefined],
    ["empty", () => "\n"],
    ["malformed", () => "not a ps line"],
    ["no start", () => "501\n"],
    ["uid only words", () => "x Wed Sep  9 12:15:15 2026\n"],
  ])("a pinned witness that is %s gives unknown", async (_label, answer) => {
    const pid = await liveChild();
    fakePs({ pinned: answer });
    expect(await inspect(pid, "darwin:x", pinned(501))).toBe("unknown");
  });

  it.each([
    ["failed or timed out", undefined],
    ["empty", () => "\n"],
  ])("a legacy witness that is %s gives unknown", async (_label, answer) => {
    const pid = await liveChild();
    fakePs({ legacy: answer });
    expect(await inspect(pid, "darwin:x")).toBe("unknown");
  });

  it("a legacy witness of other text is a mismatch, and so unknown", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => "not a ps line" });
    expect(await inspect(pid, "darwin:x")).toBe("unknown");
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a number", 5],
    ["no tag", `501:${START}`],
    ["the wrong tag", `darwin:501:${START}`],
    ["a word for the uid", `darwin2:x:${START}`],
    ["a word for the start", "darwin2:501:x"],
    ["a zero start", "darwin2:501:0"],
    ["a trailing part", `darwin2:501:${START}:1`],
  ])("a pinned field that is %s falls to the legacy value, unknown on a mismatch", async (_label, recorded) => {
    const pid = await liveChild();
    fakePs({ legacy: () => "0 other", pinned: OUT(0, "Wed Sep  9 12:15:16 2026") });
    expect(await inspect(pid, "darwin:x", recorded)).toBe("unknown");
  });

  it("an equal legacy value with no pinned field is alive", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => "501 same" });
    const signature = captureProcessSignatureSync(pid);
    const bus = _name === "bus";
    if (bus) {
      const { captureProcessSignature } = await import("../../src/bus/lock.js");
      expect(await inspect(pid, await captureProcessSignature(pid))).toBe("alive");
    } else {
      expect(await inspect(pid, signature)).toBe("alive");
    }
  });

  it.each(["darwin:bogus", "mismatched-process-signature", "linux:1:2", ""])(
    "a live pid with the legacy value %j is unknown",
    async (value) => {
      const pid = await liveChild();
      expect(await inspect(pid, value)).toBe("unknown");
    },
  );

  it("a null legacy value with no pinned field is unknown", async () => {
    const pid = await liveChild();
    expect(await inspect(pid, null)).toBe("unknown");
  });

  it("no record time plays any part in the verdict", async () => {
    // The verdict takes no time at all; a time witness would need an argument and fail here.
    const pid = await liveChild();
    fakePs({ legacy: () => "0 other", pinned: OUT(501) });
    const call = inspect as (...args: unknown[]) => unknown;
    for (const ms of [0, 999]) {
      for (const offset of [-1, 0, 1]) {
        const at = (START + offset) * 1000 + ms;
        expect(await call(pid, "darwin:x", undefined, at)).toBe("unknown");
        expect(await call(pid, "darwin:x", undefined, new Date(at).toISOString())).toBe("unknown");
      }
    }
    for (const missing of [undefined, null, "nope", Number.NaN]) {
      expect(await call(pid, "darwin:x", undefined, missing)).toBe("unknown");
    }
  });
});

describe("the dead cases", () => {
  it.each(PATHS)("ESRCH is dead on the %s path, with a pinned field or none", async (_name, inspect) => {
    const pid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid!;
    expect(await inspect(pid, "darwin:x")).toBe("dead");
    expect(await inspect(pid, null, pinned(501))).toBe("dead");
  });
});

describe("the legacy verdict by platform", () => {
  it("a mismatch is unknown on Darwin and dead on Linux", () => {
    expect(legacyVerdict("a", "b", "darwin")).toBe("unknown");
    expect(legacyVerdict("linux:1:2", "linux:1:3", "linux")).toBe("dead");
    expect(legacyVerdict("anything", "linux:1:3", "linux")).toBe("dead");
  });

  it("equal is alive and an absent side is unknown, on both", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(legacyVerdict("a", "a", platform)).toBe("alive");
      expect(legacyVerdict(null, "a", platform)).toBe("unknown");
      expect(legacyVerdict("a", null, platform)).toBe("unknown");
    }
  });
});

describe.runIf(process.platform === "linux")("EPERM on Linux", () => {
  it("goes to the signature comparison", async () => {
    const pid = await liveChild();
    const signature = captureProcessSignatureSync(pid);
    eperm();
    expect(inspectProcessIdentitySync(pid, signature)).toBe("alive");
    expect(inspectProcessIdentitySync(pid, "linux:1:2")).toBe("dead");
    expect(inspectProcessIdentitySync(pid, null)).toBe("unknown");
  });
});

describe.runIf(process.platform === "darwin")("the pinned capture", () => {
  it("is the same in another locale and timezone", async () => {
    const pid = await liveChild();
    const here = capturePinnedSignatureSync(pid);
    expect(here).toMatch(/^darwin2:\d+:[1-9]\d*$/);
    await withEnv(OTHER_ENV, () => expect(capturePinnedSignatureSync(pid)).toBe(here));
    await withEnv({ ...OTHER_ENV, TZ: "America/Los_Angeles" }, () => expect(capturePinnedSignatureSync(pid)).toBe(here));
  });

  it("reads a single-digit day under the pinned environment", () => {
    fakePs({ pinned: () => `  501 ${LSTART}\n` });
    expect(capturePinnedSignatureSync(4242)).toBe(`darwin2:501:${START}`);
  });

  it.each([["failed", undefined], ["empty", () => ""], ["malformed", () => "abc"]])(
    "is null when ps is %s",
    (_label, answer) => {
      fakePs({ pinned: answer });
      expect(capturePinnedSignatureSync(4242)).toBeNull();
    },
  );

  it("own uid agrees with what ps reports for this process", () => {
    expect(ownPinnedSignatureSync()).toBe(capturePinnedSignatureSync(process.pid));
  });

  it("caches only the start: a uid change shows on the next read with no second ps", () => {
    let calls = 0;
    __processIdentitySeams.psOutput = () => {
      calls += 1;
      return `  501 ${LSTART}\n`;
    };
    const first = ownPinnedSignatureSync();
    const uid = process.geteuid!();
    expect(first).toBe(pinned(uid));
    vi.spyOn(process, "geteuid").mockReturnValue(uid + 1);
    expect(ownPinnedSignatureSync()).toBe(pinned(uid + 1));
    expect(calls).toBe(1);
  });

  it("does not cache a failed read", () => {
    fakePs({});
    expect(ownPinnedSignatureSync()).toBeNull();
    fakePs({ pinned: () => `  501 ${LSTART}\n` });
    expect(ownPinnedSignatureSync()).toBe(pinned(process.geteuid!()));
  });
});

describe.runIf(process.platform === "darwin")("the project lock", () => {
  let lockPath = "";
  beforeEach(() => {
    lockPath = join(tempDir(), ".lock");
  });
  const put = (body: Record<string, unknown>) => writeFileSync(lockPath, JSON.stringify(body), { mode: 0o600 });
  const token = () => (JSON.parse(readFileSync(lockPath, "utf-8")) as { token: string }).token;

  it("a live holder under another environment keeps the lock", async () => {
    const pid = await liveChild();
    put({ pid, token: "held", acquiredAt: Date.now(), processSignature: captureProcessSignatureSync(pid) });
    await withEnv(OTHER_ENV, async () => {
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out/);
    });
    expect(token()).toBe("held");
  });

  it.each(["darwin:bogus", "mismatched-process-signature", "linux:1:2"])(
    "a live pid with the legacy value %j stays untouched",
    async (processSignature) => {
      const pid = await liveChild();
      put({ pid, token: "held", acquiredAt: Date.now(), processSignature });
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out/);
      expect(token()).toBe("held");
    },
  );

  it("no acquiredAt, at or around the holder's start, reclaims a legacy mismatch", async () => {
    const pid = await liveChild();
    const start = Number(capturePinnedSignatureSync(pid)!.split(":")[2]);
    const times: unknown[] = [undefined, "nope"];
    for (const ms of [0, 999]) for (const offset of [-1, 0, 1]) times.push((start + offset) * 1000 + ms);
    for (const [index, acquiredAt] of times.entries()) {
      const heldToken = `held-at-${index}`;
      put({ pid, token: heldToken, acquiredAt, processSignature: "darwin:x" });
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 60, pollMs: 10 })).rejects.toThrow(/Timed out/);
      expect(token()).toBe(heldToken);
    }
  });

  it("a differing start reclaims a live pid", async () => {
    const pid = await liveChild();
    put({ pid, token: "reused", acquiredAt: Date.now(), processSignature: "darwin:x", pinnedSignature: pinned(process.geteuid!(), 1000) });
    const handle = await acquireProjectLockAsync(lockPath, { deadlineMs: 1000, pollMs: 20 });
    expect(handle).toBeTruthy();
    releaseProjectLock(handle);
  });

  it("a uid-only difference keeps the lock, with kill(0) and with EPERM", async () => {
    const pid = await liveChild();
    const live = capturePinnedSignatureSync(pid)!;
    const [, uid, start] = live.split(":");
    put({ pid, token: "held", acquiredAt: Date.now(), processSignature: "darwin:x", pinnedSignature: `darwin2:${Number(uid) + 1}:${start}` });
    await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out/);
    expect(token()).toBe("held");
    put({ pid, token: "held2", acquiredAt: Date.now(), processSignature: "darwin:x", pinnedSignature: `darwin2:${Number(uid) + 1}:${start}` });
    eperm();
    await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out/);
    expect(token()).toBe("held2");
  });

  describe("our own pid", () => {
    it("a legacy mismatch polls and refuses at the deadline", async () => {
      put({ pid: process.pid, token: "self", acquiredAt: Date.now(), processSignature: "darwin:x" });
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out/);
      expect(token()).toBe("self");
    });

    it("a cached signature, an environment change and a fresh acquisition never reclaim", async () => {
      const held = await acquireProjectLockAsync(lockPath);
      const body = JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
      delete body.pinnedSignature;
      body.processSignature = await withEnv(OTHER_ENV, () => captureProcessSignatureSync(process.pid));
      const heldToken = body.token;
      rmSync(lockPath);
      writeFileSync(lockPath, JSON.stringify(body), { mode: 0o600 });
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out/);
      expect(token()).toBe(heldToken);
      rmSync(lockPath);
      void held;
    });

    it("a differing start reclaims", async () => {
      put({ pid: process.pid, token: "old", acquiredAt: Date.now(), processSignature: "darwin:x", pinnedSignature: pinned(process.geteuid!(), 1000) });
      const handle = await acquireProjectLockAsync(lockPath, { deadlineMs: 1000, pollMs: 20 });
      releaseProjectLock(handle);
    });

    it("a uid-only difference polls", async () => {
      const own = ownPinnedSignatureSync()!;
      const [, uid, start] = own.split(":");
      put({ pid: process.pid, token: "self", acquiredAt: Date.now(), processSignature: "darwin:x", pinnedSignature: `darwin2:${Number(uid) + 1}:${start}` });
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out/);
      expect(token()).toBe("self");
    });

    it("no usable own signature stays alive", async () => {
      put({ pid: process.pid, token: "self", acquiredAt: Date.now(), processSignature: null });
      await expect(acquireProjectLockAsync(lockPath, { deadlineMs: 200, pollMs: 20 })).rejects.toThrow(/Timed out/);
      expect(token()).toBe("self");
    });
  });

  describe("what it writes", () => {
    const bodyOf = () => JSON.parse(readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
    /** The reader before this change: a legacy mismatch was dead. */
    const oldInspect = (pid: number, expected: string) =>
      captureProcessSignatureSync(pid) === expected ? "alive" : "dead";

    it("off Darwin the field is not written and not read", async () => {
      const original = process.platform;
      const pid = await liveChild();
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      try {
        expect(capturePinnedSignatureSync(pid)).toBeNull();
        expect(ownPinnedSignatureSync()).toBeNull();
        expect(inspectProcessIdentitySync(pid, null, "darwin2:501:1000")).toBe("unknown");
        const handle = await acquireProjectLockAsync(lockPath);
        expect(bodyOf()).not.toHaveProperty("pinnedSignature");
        releaseProjectLock(handle);
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("keeps the legacy form and adds the pinned field", async () => {
      const handle = await acquireProjectLockAsync(lockPath);
      const body = bodyOf();
      expect(oldInspect(process.pid, body.processSignature as string)).toBe("alive");
      expect(body.processSignature).toMatch(/^darwin:[0-9a-f]{64}$/);
      expect(body.pinnedSignature).toBe(ownPinnedSignatureSync());
      // An old reader in the same environment compares the legacy value alone.
      expect(body.processSignature).toBe(captureProcessSignatureSync(process.pid));
      releaseProjectLock(handle);
    });

    it("omits the field when the capture fails", async () => {
      const real = captureProcessSignatureSync(process.pid);
      fakePs({ legacy: () => "501 same" });
      const handle = await acquireProjectLockAsync(lockPath);
      const body = bodyOf();
      expect(body).not.toHaveProperty("pinnedSignature");
      expect(body.processSignature).not.toBe(real);
      releaseProjectLock(handle);
    });

    it("a later acquisition carries the current uid", async () => {
      const first = await acquireProjectLockAsync(lockPath);
      const uid = process.geteuid!();
      expect(bodyOf().pinnedSignature).toMatch(new RegExp(`^darwin2:${uid}:`));
      releaseProjectLock(first);
      vi.spyOn(process, "geteuid").mockReturnValue(uid + 1);
      const second = await acquireProjectLockAsync(lockPath);
      expect(bodyOf().pinnedSignature).toMatch(new RegExp(`^darwin2:${uid + 1}:`));
      releaseProjectLock(second);
    });
  });
});

describe.runIf(process.platform === "darwin")("the limit ledger lock", () => {
  const put = (dir: string, body: Record<string, unknown>) =>
    writeFileSync(join(dir, "limit-ledger.lock"), JSON.stringify(body), { mode: 0o600 });

  it("a differing start reclaims it, through the field on the body", async () => {
    const pid = await liveChild();
    const dir = tempDir();
    put(dir, { pid, token: "t", acquiredAt: 1, renewedAt: 1, processSignature: "darwin:x", pinnedSignature: pinned(process.geteuid!(), 1000) });
    expect(removeLedgerUnderLock(dir, null)).toBeNull();
    expect(existsSync(join(dir, "limit-ledger.lock"))).toBe(false);
  });

  it("the body it writes carries the pinned field", () => {
    const dir = tempDir();
    let seen: Record<string, unknown> | null = null;
    const ledger = join(dir, "limit-ledger.json");
    writeFileSync(ledger, "{}", { mode: 0o600 });
    const st = statSync(ledger);
    removeLedgerUnderLock(dir, { dev: st.dev, ino: st.ino, text: "{}" }, {
      afterLedgerUnlink: () => {
        seen = JSON.parse(readFileSync(join(dir, "limit-ledger.lock"), "utf-8")) as Record<string, unknown>;
      },
    });
    if (seen !== null) {
      const body = seen as Record<string, unknown>;
      expect(body.pinnedSignature).toBe(ownPinnedSignatureSync());
      expect(body.processSignature).toBe(captureProcessSignatureSync(process.pid));
    } else {
      throw new Error("the removal did not reach the hook");
    }
  });
});

describe.runIf(process.platform === "darwin")("signalling a retired waker", () => {
  const LEGACY = "  501 Wed Sep  9 12:15:15 2026 node --sb-waker waker-run";
  const OTHER = "  501 Wed Sep  9 12:15:15 2026 node other";

  async function stop(body: Record<string, unknown>, opts: { argv?: boolean; dieOn?: NodeJS.Signals } = {}) {
    const dir = tempDir();
    const path = join(dir, "waker.lock");
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
    const sent: NodeJS.Signals[] = [];
    const result = await stopRetiredWaker(path, {
      ...DEFAULT_WAKER_STOP_DEPS,
      isWakerArgv: () => opts.argv ?? true,
      signal: (_pid, sig) => {
        sent.push(sig);
      },
      sleep: async () => {},
    });
    return { result, sent };
  }

  it("same pid, uid and second, different legacy signatures, matching markers: zero signals", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => LEGACY, pinned: () => `  501 ${LSTART}\n` });
    const signature = captureProcessSignatureSync(pid);
    fakePs({ legacy: () => OTHER, pinned: () => `  501 ${LSTART}\n` });
    const { result, sent } = await stop({ pid, processSignature: signature, pinnedSignature: pinned(501) });
    expect(sent).toEqual([]);
    expect(result).toMatchObject({ kind: "refused" });
  });

  it("the post-SIGTERM recheck refuses on a legacy change: no SIGKILL", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => LEGACY });
    const signature = captureProcessSignatureSync(pid);
    let termSent = false;
    fakePs({ legacy: () => (termSent ? OTHER : LEGACY), pinned: () => `  501 ${LSTART}\n` });
    const dir = tempDir();
    const path = join(dir, "waker.lock");
    writeFileSync(path, JSON.stringify({ pid, processSignature: signature, pinnedSignature: pinned(501) }), { mode: 0o600 });
    const sent: NodeJS.Signals[] = [];
    const result = await stopRetiredWaker(path, {
      ...DEFAULT_WAKER_STOP_DEPS,
      isWakerArgv: () => true,
      signal: (_pid, sig) => {
        sent.push(sig);
        termSent = true;
      },
      sleep: async () => {},
    });
    expect(sent).toEqual(["SIGTERM"]);
    expect(result).toMatchObject({ kind: "refused" });
  });

  it("an exact legacy match with the markers is signalled, as today", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => LEGACY });
    const signature = captureProcessSignatureSync(pid);
    const { sent } = await stop({ pid, processSignature: signature });
    expect(sent).toContain("SIGTERM");
  });

  it("a start that differs after SIGTERM counts as gone: no SIGKILL", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => LEGACY });
    const signature = captureProcessSignatureSync(pid);
    let termSent = false;
    fakePs({ legacy: () => LEGACY, pinned: () => (termSent ? "  501 Wed Sep  9 12:15:16 2026\n" : `  501 ${LSTART}\n`) });
    const path = join(tempDir(), "waker.lock");
    writeFileSync(path, JSON.stringify({ pid, processSignature: signature, pinnedSignature: pinned(501) }), { mode: 0o600 });
    const sent: NodeJS.Signals[] = [];
    const result = await stopRetiredWaker(path, {
      ...DEFAULT_WAKER_STOP_DEPS,
      isWakerArgv: () => true,
      signal: (_pid, sig) => {
        sent.push(sig);
        termSent = true;
      },
      sleep: async () => {},
    });
    expect(sent).toEqual(["SIGTERM"]);
    expect(result).toMatchObject({ kind: "stopped", killed: false });
  });

  it("a start that differs after SIGKILL counts as killed", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => LEGACY });
    const signature = captureProcessSignatureSync(pid);
    let killSent = false;
    fakePs({ legacy: () => LEGACY, pinned: () => (killSent ? "  501 Wed Sep  9 12:15:16 2026\n" : `  501 ${LSTART}\n`) });
    const path = join(tempDir(), "waker.lock");
    writeFileSync(path, JSON.stringify({ pid, processSignature: signature, pinnedSignature: pinned(501) }), { mode: 0o600 });
    const sent: NodeJS.Signals[] = [];
    const result = await stopRetiredWaker(path, {
      ...DEFAULT_WAKER_STOP_DEPS,
      isWakerArgv: () => true,
      signal: (_pid, sig) => {
        sent.push(sig);
        if (sig === "SIGKILL") killSent = true;
      },
      sleep: async () => {},
    });
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({ kind: "stopped", killed: true });
  });

  it("a differing start is not running and gets no signal", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => LEGACY, pinned: () => "  501 Wed Sep  9 12:15:16 2026\n" });
    const signature = captureProcessSignatureSync(pid);
    const { result, sent } = await stop({ pid, processSignature: signature, pinnedSignature: pinned(501) });
    expect(sent).toEqual([]);
    expect(result).toMatchObject({ kind: "not-running" });
  });

  it("the verifier: pinned equality never upgrades a legacy mismatch", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => OTHER, pinned: () => `  501 ${LSTART}\n` });
    expect(verifyIdentityForSignalSync(pid, "darwin:x", pinned(501))).toBe("unknown");
    expect(verifyIdentityForSignalSync(pid, null, pinned(501))).toBe("unknown");
    expect(inspectProcessIdentitySync(pid, "darwin:x", pinned(501))).toBe("alive");
  });

  it("the verifier: EPERM alone gives unknown, a differing start dead, ESRCH dead", async () => {
    const pid = await liveChild();
    fakePs({ legacy: () => LEGACY, pinned: () => "  501 Wed Sep  9 12:15:16 2026\n" });
    const signature = captureProcessSignatureSync(pid);
    expect(verifyIdentityForSignalSync(pid, signature, pinned(501))).toBe("dead");
    const spy = eperm();
    expect(verifyIdentityForSignalSync(pid, signature)).toBe("unknown");
    expect(verifyIdentityForSignalSync(pid, signature, pinned(501))).toBe("dead");
    spy.mockRestore();
    const gone = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid!;
    expect(verifyIdentityForSignalSync(gone, signature)).toBe("dead");
  });
});
