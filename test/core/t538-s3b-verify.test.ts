/**
 * T-538 S3b commit 4: `storybloq setup-verify` runs a VERIFY establishment.
 * The approved start command runs in its own process group; verified is a
 * 2xx from 127.0.0.1:<port><path> with every listener that could accept it
 * owned by the group, observed before the request and again after the
 * response, then the group stopped and the port free. Every other outcome
 * writes nothing and prints the run token; without process groups or lsof
 * nothing runs (unsupported, exit 4).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { setupApply } from "../../src/core/setup-apply.js";
import { setupVerify, setupVerifySeams } from "../../src/core/setup-verify.js";
import { serveSeams } from "../../src/core/setup-verify-serve.js";
import { processGroupSeams } from "../../src/core/process-group.js";
import { comp, editTicket, payload, pinEnvironment, t, type PT } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 60_000 });
const { folder } = pinEnvironment("t538-s3b-verify");

const SERVER = join(import.meta.dirname, "fixtures", "t538-server.mjs");
const REAL = { ...serveSeams };
const realOwn = processGroupSeams.ownGroup;
const open: Server[] = [];
afterEach(async () => {
  Object.assign(serveSeams, REAL);
  processGroupSeams.ownGroup = realOwn;
  setupVerifySeams.afterRun = () => {};
  await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const TOKEN = /\(run ([0-9a-f]{16})\)\.$/;

/** A listener in this test process, outside any group setup-verify starts. */
function listen(port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, host, () => {
      open.push(s);
      resolve(s);
    });
  });
}

async function freePort(): Promise<number> {
  const s = await listen(0, "127.0.0.1");
  const port = (s.address() as { port: number }).port;
  open.splice(open.indexOf(s), 1);
  await new Promise((r) => s.close(r));
  return port;
}

const files = async (root: string) => ({
  ticket: await readFile(join(root, ".story", "tickets", "T-002.json"), "utf-8"),
  config: await readFile(join(root, ".story", "config.json"), "utf-8"),
});

const configOf = async (root: string) => JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8")) as {
  setupVerification: { components: Array<{ test: unknown; verify: { status: string } }> };
  recipeOverrides: { stages: Record<string, { enabled?: boolean }> };
};

const serve = (port: number, mode = "ok") => `"${process.execPath}" "${SERVER}" ${port} ${mode}`;

/** A finished full-level setup whose VERIFY runs `command` with readiness at 127.0.0.1:<port>/health, established by T-002. */
async function ready(port: number, command = serve(port)): Promise<string> {
  const root = await folder();
  const tickets: PT[] = [t("K2", []), t("K3", ["K2"], { establishes: { component: "app", stage: "verify", scaffold: "K2" } }), t("K4", ["K3"])];
  const p = payload({ level: "full", tickets, components: [{ ...comp(), verify: { startCommand: command, readinessUrl: `http://127.0.0.1:${port}/health`, status: "pending", reason: "no server yet" } }] });
  (p.quality as { verifyApplies: boolean }).verifyApplies = true;
  expect((await setupApply(root, p)).exitCode).toBe(0);
  await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
  return root;
}

const editSpec = (root: string, over: Record<string, unknown>) => editTicket(root, "T-002", (r) => {
  const v = (r.setup as { verification: { spec: Record<string, unknown> } }).verification;
  v.spec = { ...v.spec, ...over };
});

/** Runs a VERIFY that does not verify and checks it wrote nothing and printed its run. */
async function fails(root: string, line: RegExp): Promise<string[]> {
  const before = await files(root);
  const r = await setupVerify(root, { ticket: "T-002" });
  expect(r.exitCode).toBe(1);
  expect(r.lines[0]).toMatch(line);
  expect(r.lines[0]).toMatch(/ T-002 stays as it was \(run [0-9a-f]{16}\)\.$/);
  expect(await files(root)).toEqual(before);
  return r.lines;
}

describe("a verified VERIFY", () => {
  it("completes the ticket, turns on only VERIFY, and leaves the port free", async () => {
    const port = await freePort();
    const root = await ready(port);
    const before = await configOf(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r).toEqual({ exitCode: 0, lines: [`Verified: app verify (127.0.0.1:${port}/health answered 200); stages on: VERIFY`] });
    const after = await configOf(root);
    expect(after.setupVerification.components[0]!.verify.status).toBe("verified");
    expect(after.setupVerification.components[0]!.test).toEqual(before.setupVerification.components[0]!.test);
    expect(after.recipeOverrides.stages.VERIFY).toMatchObject({ enabled: true });
    const { VERIFY: _a, ...restAfter } = after.recipeOverrides.stages;
    const { VERIFY: _b, ...restBefore } = before.recipeOverrides.stages;
    expect(restAfter).toEqual(restBefore);
    await listen(port, "127.0.0.1");
  });

  it("stops a server that ignores SIGTERM after the shutdown timeout, and still verifies", async () => {
    const port = await freePort();
    const root = await ready(port, serve(port, "ignore-term"));
    await editSpec(root, { shutdownTimeoutMs: 300 });
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
    await listen(port, "127.0.0.1");
  });

  it("ignores a listener on [::1], which cannot accept 127.0.0.1", async () => {
    const port = await freePort();
    const root = await ready(port);
    let other: Server | null = null;
    serveSeams.afterPortCheck = async () => { other = await listen(port, "::1"); };
    serveSeams.afterOwnership2 = async () => { await new Promise((r) => other!.close(r)); };
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
  });
});

describe("a VERIFY that does not verify writes nothing and prints its run", () => {
  it("a port already in use is port-occupied, and the command never starts", async () => {
    const port = await freePort();
    const root = await ready(port, `touch started; ${serve(port)}`);
    await listen(port, "127.0.0.1");
    await fails(root, new RegExp(`^Verification failed: app verify: port occupied: pid ${process.pid} already listens on ${port}\\.`));
    expect(existsSync(join(root, "started"))).toBe(false);
  });

  it("a command that exits before answering is exited-early, with the tail", async () => {
    const port = await freePort();
    const lines = await fails(await ready(port, serve(port, "exit")), /^Verification failed: app verify: exited early: it exited with code 3 before answering\./);
    expect(lines).toContain("  | exiting before listening");
  });

  it("no 2xx by the startup deadline is not-ready", async () => {
    const port = await freePort();
    const root = await ready(port, serve(port, "status-500"));
    await editSpec(root, { startupTimeoutMs: 1500 });
    await fails(root, new RegExp(`^Verification failed: app verify: not ready: no 2xx from http://127\\.0\\.0\\.1:${port}/health within 1500 ms\\.`));
  });

  it("an ownership query the deadline overtakes is not-ready, not ownership-unknown: each query has its own bound", async () => {
    const port = await freePort();
    const root = await ready(port, serve(port, "status-500"));
    const slow = join(root, "slow-lsof");
    await writeFile(slow, `#!/bin/sh\nsleep 0.5\nexec ${REAL.lsofPath} "$@"\n`, { mode: 0o755 });
    serveSeams.lsofPath = slow;
    await editSpec(root, { startupTimeoutMs: 700 });
    await fails(root, new RegExp(`^Verification failed: app verify: not ready: no 2xx from http://127\\.0\\.0\\.1:${port}/health within 700 ms\\.`));
  });

  it("a slow ownership query well inside the deadline gets its whole bound, and the run verifies", async () => {
    const port = await freePort();
    const root = await ready(port);
    const slow = join(root, "slow-lsof");
    await writeFile(slow, `#!/bin/sh\nsleep 0.3\nexec ${REAL.lsofPath} "$@"\n`, { mode: 0o755 });
    serveSeams.lsofPath = slow;
    await editSpec(root, { startupTimeoutMs: 5000 });
    expect(await setupVerify(root, { ticket: "T-002" })).toEqual({ exitCode: 0, lines: [`Verified: app verify (127.0.0.1:${port}/health answered 200); stages on: VERIFY`] });
  });

  /** A run with slow lsof and ps from `slowFrom` on, Q = 1000 ms and a 1500 ms startup; returns the outcome and ms from the port check to the shutdown. */
  async function overtaken(port: number, root: string, at: "observation-1" | "observation-2" | "after-2"): Promise<{ lines: string[]; ms: number }> {
    const fast = join(root, "fast-lsof");
    await writeFile(join(root, "slow-lsof"), `#!/bin/sh\nsleep 0.5\nexec ${REAL.lsofPath} "$@"\n`, { mode: 0o755 });
    await writeFile(join(root, "slow-ps"), `#!/bin/sh\nsleep 2\nexec ${REAL.psPath} "$@"\n`, { mode: 0o755 });
    await writeFile(fast, `#!/bin/sh\nexec ${REAL.lsofPath} "$@"\n`, { mode: 0o755 });
    serveSeams.lsofPath = fast;
    serveSeams.ownershipQueryMs = 1000;
    await editSpec(root, { startupTimeoutMs: 1500 });
    let t0 = 0;
    let t1 = 0;
    const slow = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + 1450 - Date.now())));
      serveSeams.lsofPath = join(root, "slow-lsof");
      serveSeams.psPath = join(root, "slow-ps");
    };
    serveSeams.afterPortCheck = () => { t0 = Date.now(); };
    if (at === "observation-1") serveSeams.beforeOwnership1 = slow;
    if (at === "observation-2") serveSeams.afterResponse = slow;
    if (at === "after-2") serveSeams.afterOwnership2 = async () => { await new Promise((r) => setTimeout(r, Math.max(0, t0 + 1600 - Date.now()))); };
    serveSeams.duringShutdown = () => { t1 = Date.now(); };
    const lines = await fails(root, new RegExp(`^Verification failed: app verify: not ready: no 2xx from http://127\\.0\\.0\\.1:${port}/health within 1500 ms\\.`));
    return { lines, ms: t1 - t0 };
  }

  it("an observation the deadline overtakes is not-ready, and readiness ends by the startup timeout plus one observation bound", async () => {
    const port = await freePort();
    const { ms } = await overtaken(port, await ready(port), "observation-1");
    expect(ms).toBeLessThanOrEqual(1500 + 1000 + 300);
  });

  it("a 2xx in time whose second observation the deadline overtakes is not-ready, within the same bound", async () => {
    const port = await freePort();
    const { ms } = await overtaken(port, await ready(port), "observation-2");
    expect(ms).toBeLessThanOrEqual(1500 + 1000 + 300);
  });

  it("a 2xx in time confirmed only after the deadline is not-ready", async () => {
    const port = await freePort();
    await overtaken(port, await ready(port), "after-2");
  });

  it("a launcher that leaves its server behind and exits is exited-early, though the server answers", async () => {
    const port = await freePort();
    await fails(await ready(port, `${serve(port)} & exit 0`), /^Verification failed: app verify: exited early: it exited with code 0 before answering\./);
    await listen(port, "127.0.0.1");
  });

  it("a leader that dies between the 2xx and the second observation is exited-early, though its server still owns the port", async () => {
    const port = await freePort();
    const root = await ready(port, `${serve(port)} & echo $$ > leader.pid; wait`);
    serveSeams.afterResponse = async () => {
      process.kill(Number(await readFile(join(root, "leader.pid"), "utf-8")), "SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
    };
    await fails(root, /^Verification failed: app verify: exited early: it ended by SIGKILL before its answer was confirmed\./);
    await listen(port, "127.0.0.1");
  });

  it("a listener outside the group is foreign-listener, and is never signalled", async () => {
    const port = await freePort();
    const root = await ready(port, "sleep 30");
    serveSeams.afterPortCheck = async () => { await listen(port, "127.0.0.1"); };
    await fails(root, new RegExp(`^Verification failed: app verify: foreign listener: pid ${process.pid} outside the group listens on ${port}\\.`));
  });

  it("a foreign listener that appears after the response is foreign-listener", async () => {
    const port = await freePort();
    const root = await ready(port);
    serveSeams.afterResponse = async () => { await listen(port, "0.0.0.0"); };
    await fails(root, /^Verification failed: app verify: foreign listener: pid \d+(, \d+)* outside the group listens on \d+\./);
  });

  it("no listener of the group after the 2xx is ownership-unknown: an empty observation never passes", async () => {
    const port = await freePort();
    await fails(await ready(port, serve(port, "close-after")), new RegExp(`^Verification failed: app verify: ownership unknown: no listener of the group was on ${port} after the 2xx\\.`));
  });

  it("an lsof that fails is ownership-unknown, and exit 1 with output is not read as none", async () => {
    const port = await freePort();
    const root = await ready(port, `touch started; ${serve(port)}`);
    const fake = join(root, "fake-lsof");
    await writeFile(fake, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    serveSeams.lsofPath = fake;
    await fails(root, /^Verification failed: app verify: ownership unknown: lsof exited with code 2\./);
    expect(existsSync(join(root, "started"))).toBe(false);
    await writeFile(fake, "#!/bin/sh\necho p1\nexit 1\n", { mode: 0o755 });
    await fails(root, /^Verification failed: app verify: ownership unknown: lsof exited with code 1\./);
  });

  it("a malformed lsof line is ownership-unknown", async () => {
    const port = await freePort();
    const root = await ready(port);
    const fake = join(root, "fake-lsof");
    await writeFile(fake, "#!/bin/sh\necho p12\necho x\n", { mode: 0o755 });
    serveSeams.lsofPath = fake;
    await fails(root, /^Verification failed: app verify: ownership unknown: lsof printed an unexpected line: x\./);
  });

  it("a listener pid ps cannot find is ownership-unknown", async () => {
    const port = await freePort();
    const root = await ready(port);
    serveSeams.psPath = "/usr/bin/true";
    await fails(root, /^Verification failed: app verify: ownership unknown: pid \d+ listened on the port but ps could not find it\./);
  });

  it("a listener on the port after the stop is shutdown-failed", async () => {
    const port = await freePort();
    const root = await ready(port);
    serveSeams.duringShutdown = async () => { await listen(port, "127.0.0.1"); };
    await fails(root, new RegExp(`^Verification failed: app verify: shutdown failed: pid ${process.pid} still listens on ${port} after shutdown\\.`));
  });

  it("a change during the run is stale (exit 5)", async () => {
    const port = await freePort();
    const root = await ready(port);
    setupVerifySeams.afterRun = async () => { await editTicket(root, "T-002", (r) => { r.status = "inprogress"; }); };
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(5);
    expect((await configOf(root)).setupVerification.components[0]!.verify.status).toBe("pending");
  });
});

describe("a VERIFY spec and record", () => {
  it("is refused when the spec's readiness endpoint and the record's URL disagree", async () => {
    const port = await freePort();
    const root = await ready(port);
    await editSpec(root, { readinessPath: "/other" });
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(2);
    expect(r.lines[0]).toBe(`Setup-verify refused: T-002's verification spec and the setup verification record disagree on the readiness URL of app (${port}/other against ${port}/health).`);
  });
});

describe("VERIFY where it cannot run", () => {
  it("without lsof is unsupported (exit 4) with nothing started, and leave-off answers it", async () => {
    const port = await freePort();
    const root = await ready(port, `touch started; ${serve(port)}`);
    serveSeams.lsofPath = "/nonexistent/lsof";
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(4);
    expect(r.lines[0]).toMatch(/^Setup-verify stopped: app's verify stage cannot run here; nothing was written \(run [0-9a-f]{16}\)\.$/);
    expect(r.lines[1]).toBe("Ambiguity: verification unsupported · T-002 · observed lsof is not available at /nonexistent/lsof (ENOENT); expected a platform that can own the verify command's processes and see who listens on its port · resolutions: leave-off | stop");
    expect(existsSync(join(root, "started"))).toBe(false);
    expect(await files(root)).toEqual(before);
    const left = await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "no server here", run: TOKEN.exec(r.lines[0]!)![1]! });
    expect(left).toEqual({ exitCode: 0, lines: ["Left off: app verify; T-002 is complete and the stages are unchanged."] });
    expect((await configOf(root)).setupVerification.components[0]!.verify.status).toBe("left-off");
  });

  it("without process groups is unsupported before lsof is asked", async () => {
    const port = await freePort();
    const root = await ready(port);
    processGroupSeams.ownGroup = false;
    serveSeams.lsofPath = "/nonexistent/lsof";
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(4);
    expect(r.lines[1]).toMatch(/observed this platform has no process groups to own \(Windows\);/);
  });

  it("refuses an adapter by name", async () => {
    const port = await freePort();
    const root = await ready(port);
    serveSeams.lsofPath = "/nonexistent/lsof";
    const run = TOKEN.exec((await setupVerify(root, { ticket: "T-002" })).lines[0]!)![1]!;
    expect(await setupVerify(root, { ticket: "T-002", resolve: "adapter", argv: ["x"], ownerWords: "x", run }))
      .toEqual({ exitCode: 2, lines: ["Setup-verify refused: --resolve adapter: a verify stage has no evidence to adapt; its resolutions are leave-off and stop."] });
  });
});
