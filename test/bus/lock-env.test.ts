/**
 * ISS-1421: the bus lock and endpoint liveness under a reader in another
 * locale and timezone, and what automatic replacement may do about it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { attemptAutoAttach } from "../../src/bus/auto-attach.js";
import { __testing as endpointTesting, endpointLiveness, joinEndpoint, listEndpoints, retireEndpoint } from "../../src/bus/endpoints.js";
import { v1EndpointLiveness } from "../../src/bus/legacy-v1.js";
import { acquireHardenedLock, captureProcessSignature, inspectProcessIdentity, releaseHardenedLock } from "../../src/bus/lock.js";
import { __processIdentitySeams, capturePinnedSignatureSync } from "../../src/core/process-identity.js";
import { createBusFixture, type BusFixture } from "./helpers.js";

const OTHER_ENV: Record<string, string | undefined> = { LANG: "en_CA.UTF-8", LC_ALL: undefined, LC_TIME: undefined, TZ: "Asia/Tokyo" };

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
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
const cleanups: string[] = [];
const fixtures: BusFixture[] = [];

async function liveChild(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((done) => child.once("spawn", () => done()));
  return child.pid!;
}

afterEach(async () => {
  __processIdentitySeams.psOutput = null;
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
  for (const value of fixtures.splice(0)) await rm(value.root, { recursive: true, force: true });
});

async function lockFile(body: (pid: number) => Promise<Record<string, unknown>>): Promise<{ path: string; pid: number }> {
  const dir = await mkdtemp(join(tmpdir(), "iss1421-bus-"));
  cleanups.push(dir);
  const path = join(dir, "x.lock");
  const pid = await liveChild();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(await body(pid)), { mode: 0o600 });
  return { path, pid };
}

const lockBody = (pid: number, processSignature: string | null) => ({
  pid,
  token: randomBytes(32).toString("hex"),
  acquiredAt: new Date().toISOString(),
  processSignature,
});

describe.runIf(process.platform === "darwin")("the bus lock in another environment", () => {
  it("a live holder inspected under another locale and timezone is not dead", async () => {
    const pid = await liveChild();
    const signature = await captureProcessSignature(pid);
    expect(signature).toMatch(/^darwin:/);
    const verdict = await withEnv(OTHER_ENV, () => inspectProcessIdentity(pid, signature));
    expect(verdict).not.toBe("dead");
  });

  it("a hardened lock held by a live process is busy, not reclaimed", async () => {
    const { path } = await lockFile(async (pid) => lockBody(pid, await captureProcessSignature(pid)));
    const before = await readFile(path, "utf-8");
    await withEnv(OTHER_ENV, async () => {
      await expect(acquireHardenedLock(path, { timeoutMs: 200 })).rejects.toThrow(/Timed out acquiring lock/);
    });
    expect(await readFile(path, "utf-8")).toBe(before);
  });

  it.each(["darwin:bogus", "mismatched-process-signature", "linux:1:2"])(
    "a live pid with the legacy value %j stays untouched",
    async (value) => {
      const { path } = await lockFile(async (pid) => lockBody(pid, value));
      const before = await readFile(path, "utf-8");
      await expect(acquireHardenedLock(path, { timeoutMs: 200 })).rejects.toThrow(/Timed out acquiring lock/);
      expect(await readFile(path, "utf-8")).toBe(before);
    },
  );

  it("the lock body it writes has no new field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iss1421-bus-"));
    cleanups.push(dir);
    const path = join(dir, "y.lock");
    const handle = await acquireHardenedLock(path, { timeoutMs: 500 });
    expect(Object.keys(JSON.parse(await readFile(path, "utf-8"))).sort()).toEqual(["acquiredAt", "pid", "processSignature", "token"]);
    await releaseHardenedLock(handle);
  });
});

describe.runIf(process.platform === "darwin")("endpoint liveness", () => {
  async function fixture(): Promise<BusFixture> {
    const value = await createBusFixture("iss1421");
    fixtures.push(value);
    return value;
  }

  async function forge(root: string, endpointId: string, processRef: Record<string, unknown>): Promise<void> {
    const path = join(root, ".story", "bus", "endpoints", `${endpointId}.json`);
    const endpoint = JSON.parse(await readFile(path, "utf-8"));
    await writeFile(path, JSON.stringify({ ...endpoint, state: "attached", processRef }, null, 2) + "\n", "utf-8");
  }

  const ref = (pid: number, extra: Record<string, unknown> = {}) => ({
    pid,
    signature: "darwin:deadbeef",
    capturedAt: new Date().toISOString(),
    ...extra,
  });

  it("the field decides: a differing start is offline, an equal one attached", async () => {
    const pid = await liveChild();
    const live = capturePinnedSignatureSync(pid)!;
    const [, uid] = live.split(":");
    const base = { surface: "claude_cli" } as never;
    const reused = { ...(base as object), processRef: ref(pid, { pinnedSignature: `darwin2:${uid}:1000` }) };
    const same = { ...(base as object), processRef: ref(pid, { pinnedSignature: live }) };
    expect(await endpointLiveness(reused as never)).toBe("offline");
    expect(await endpointLiveness(same as never)).toBe("attached");
    expect(await v1EndpointLiveness(reused as never)).toBe("offline");
    expect(await v1EndpointLiveness(same as never)).toBe("attached");
  });

  it("no capturedAt, at or around the holder's start, makes a legacy mismatch offline", async () => {
    const pid = await liveChild();
    const start = Number(capturePinnedSignatureSync(pid)!.split(":")[2]);
    const times: unknown[] = [undefined, "nope"];
    for (const ms of [0, 999]) for (const offset of [-1, 0, 1]) times.push(new Date((start + offset) * 1000 + ms).toISOString());
    for (const capturedAt of times) {
      const endpoint = { surface: "claude_cli", processRef: { pid, signature: "darwin:deadbeef", capturedAt } };
      expect(await endpointLiveness(endpoint as never)).toBe("unknown");
      expect(await v1EndpointLiveness(endpoint as never)).toBe("unknown");
    }
  });

  it("the processRef it writes carries the field", async () => {
    const pid = await liveChild();
    const out = await endpointTesting.processRefFor("claude_cli", { pid } as never);
    expect(out?.signature).toBe(await captureProcessSignature(pid));
    expect((out as { pinnedSignature?: unknown } | null)?.pinnedSignature).toBe(capturePinnedSignatureSync(pid));
  });

  it("an old reader parses the processRef and in the same environment still matches it", async () => {
    const pid = await liveChild();
    const out = (await endpointTesting.processRefFor("claude_cli", { pid } as never))!;
    const old = z.object({ pid: z.number(), signature: z.string(), capturedAt: z.string() }).passthrough();
    expect(old.parse(JSON.parse(JSON.stringify(out))).signature).toBe(await captureProcessSignature(pid));
  });

  it("a capture failure omits the field and keeps the record", async () => {
    const pid = await liveChild();
    __processIdentitySeams.psOutput = (form) => {
      if (form === "pinned") throw new Error("ps failed");
      return "501 same";
    };
    const out = await endpointTesting.processRefFor("claude_cli", { pid } as never);
    expect(out?.signature).toMatch(/^darwin:/);
    expect(out).not.toHaveProperty("pinnedSignature");
  });

  it("an unknown live endpoint blocks automatic replacement and changes only through explicit retirement", async () => {
    const value = await fixture();
    const pid = await liveChild();
    await forge(value.root, value.b.endpointId, ref(pid));
    expect(await endpointLiveness((await listEndpoints(value.root)).endpoints.find((e) => e.endpointId === value.b.endpointId)!)).toBe("unknown");

    await attemptAutoAttach({ root: value.root, client: "claude", clientTaskId: "successor-task" } as never);
    const afterAuto = (await listEndpoints(value.root)).endpoints;
    expect(afterAuto.find((e) => e.endpointId === value.b.endpointId)?.retiredAt ?? null).toBeNull();
    expect(afterAuto.some((e) => !e.retiredAt && e.clientTaskId === "successor-task")).toBe(false);

    await expect(joinEndpoint(value.root, {
      client: "claude",
      clientTaskId: "successor-task",
      surface: "claude_cli",
      replace: value.b.endpointId,
    })).rejects.toMatchObject({ code: "conflict" });

    const retired = await retireEndpoint(value.root, value.b.endpointId, "Owner confirmed it is gone");
    expect(retired.retiredAt).not.toBeNull();
  });
});
