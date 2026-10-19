/**
 * T-538 S3b: the VERIFY run of `storybloq setup-verify`. The approved start
 * command runs in its own process group (runOwnedGroup) against one absolute
 * startup deadline:
 *
 * 1. before launch, nothing listens on the port (else `port-occupied`);
 * 2. readiness polls `GET http://127.0.0.1:<port><path>`, each request
 *    aborted at the time remaining; the leader must be alive at the start of
 *    each poll, before each request and after the second observation (else
 *    `exited-early`, even when a process it left behind still serves); no
 *    2xx in time is `not-ready`;
 * 3. ownership is observed before each request and again after a 2xx
 *    response is consumed: every listener that could accept 127.0.0.1:port
 *    (127.0.0.1, and the wildcards `*`, which lsof prints for 0.0.0.0 and for
 *    a dual-stack `[::]`, read as able to accept IPv4 because lsof cannot
 *    report IPV6_V6ONLY) must belong to the group, and at least one must be
 *    there; a foreign pid is `foreign-listener`, a query that fails, times
 *    out, prints what it should not, or names a pid ps then cannot find is
 *    `ownership-unknown`. One observation (lsof, then ps) shares one bound
 *    of OWNERSHIP_QUERY_MS, never the time left to the startup deadline. The
 *    absolute deadline is checked after each observation, before each
 *    request and before ready: once it has passed the answer is `not-ready`,
 *    a 2xx included. So readiness ends by startupTimeoutMs plus one
 *    observation bound plus scheduling slack, the guaranteed maximum;
 * 4. the group is stopped whatever happened, and the port must then be free
 *    (else `shutdown-failed`; a foreign process holding it is never signalled,
 *    because signals go only to the group).
 *
 * Residual race, accepted: a foreign process that answers the 2xx and leaves
 * between the observation before the request and the one after the response,
 * while a listener the group owns stays bound throughout. The approved
 * command runs as written, so no readiness token is asked of it.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { runOwnedGroup } from "./process-group.js";

/** How often readiness is polled, and the longest one ownership observation (lsof, then ps) may take. */
export const READINESS_POLL_MS = 100;
export const OWNERSHIP_QUERY_MS = 5000;

/**
 * Test seams, not reachable through any CLI or MCP input: where lsof and ps
 * are, and awaited barriers at each point a race can be forced. Each is read
 * at call time.
 */
export const serveSeams: {
  lsofPath: string;
  psPath: string;
  ownershipQueryMs: number;
  afterPortCheck: () => void | Promise<void>;
  beforeOwnership1: () => void | Promise<void>;
  afterResponse: () => void | Promise<void>;
  afterOwnership2: () => void | Promise<void>;
  duringShutdown: () => void | Promise<void>;
} = {
  lsofPath: "/usr/sbin/lsof",
  psPath: "/bin/ps",
  ownershipQueryMs: OWNERSHIP_QUERY_MS,
  afterPortCheck: () => {},
  beforeOwnership1: () => {},
  afterResponse: () => {},
  afterOwnership2: () => {},
  duringShutdown: () => {},
};

export type ServeFailure =
  | "port-occupied"
  | "exited-early"
  | "not-ready"
  | "foreign-listener"
  | "ownership-unknown"
  | "shutdown-failed"
  | "cleanup-failed"
  | "failed";

export type ServeOutcome =
  | { readonly kind: "verified"; readonly status: number; readonly tail: string }
  | { readonly kind: ServeFailure; readonly detail: string; readonly tail: string };

export interface ServeSpec {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
  readonly readinessPath: string;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly onData: (chunk: Buffer) => void;
  readonly tail: () => string;
}

interface Listener { readonly pid: number; readonly host: string }

type Query<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

/** Runs a tool to completion within `timeoutMs`: its exit code and stdout, or why it could not be read. */
function runTool(path: string, args: readonly string[], timeoutMs: number): Promise<Query<{ code: number | null; stdout: string }>> {
  return new Promise((resolve) => {
    let stdout = "";
    let done = false;
    const finish = (q: Query<{ code: number | null; stdout: string }>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(q);
    };
    const child = spawn(path, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, why: `${path} did not answer within ${timeoutMs} ms` });
    }, Math.max(1, timeoutMs));
    child.stdout!.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.on("error", (e) => finish({ ok: false, why: `${path} could not run (${e.message})` }));
    child.on("close", (code) => finish({ ok: true, value: { code, stdout } }));
  });
}

/** Every TCP listener on `port` as lsof prints it (-Fpn): pid and host. Exit 1 with no output is none. */
export async function listenersOn(port: number, timeoutMs: number): Promise<Query<Listener[]>> {
  const r = await runTool(serveSeams.lsofPath, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], timeoutMs);
  if (!r.ok) return r;
  const { code, stdout } = r.value;
  if (code === 1 && stdout === "") return { ok: true, value: [] };
  if (code !== 0) return { ok: false, why: `lsof exited with code ${code}` };
  const out: Listener[] = [];
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      if (!/^[1-9]\d*$/.test(rest)) return { ok: false, why: `lsof printed a malformed pid line: ${line}` };
      pid = Number(rest);
    } else if (tag === "f") {
      continue;
    } else if (tag === "n") {
      const m = /^(.*):(\d+)$/.exec(rest);
      if (pid === null || m === null || Number(m[2]) !== port) return { ok: false, why: `lsof printed an unexpected name line: ${line}` };
      out.push({ pid, host: m[1]! });
    } else {
      return { ok: false, why: `lsof printed an unexpected line: ${line}` };
    }
  }
  return { ok: true, value: out };
}

/** Whether a listener on this host could accept a connection to 127.0.0.1. */
function acceptsLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "*" || host === "0.0.0.0" || host === "[::]" || host === "[::ffff:127.0.0.1]";
}

/** Each pid's process group, from ps; a pid ps cannot find fails the query. */
async function groupsOf(pids: readonly number[], timeoutMs: number): Promise<Query<Map<number, number>>> {
  const r = await runTool(serveSeams.psPath, ["-o", "pid=,pgid=", "-p", pids.join(",")], timeoutMs);
  if (!r.ok) return r;
  const groups = new Map<number, number>();
  for (const line of r.value.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) groups.set(Number(m[1]), Number(m[2]));
  }
  const missing = pids.find((p) => !groups.has(p));
  if (missing !== undefined) return { ok: false, why: `pid ${missing} listened on the port but ps could not find it` };
  return { ok: true, value: groups };
}

type Ownership = { readonly kind: "owned" } | { readonly kind: "none" } | { readonly kind: "foreign"; readonly detail: string } | { readonly kind: "unknown"; readonly detail: string };

/** One observation, lsof and ps within one bound: every listener that could accept 127.0.0.1:port is the group's, and there is at least one. */
async function observe(port: number, pgid: number): Promise<Ownership> {
  const until = Date.now() + serveSeams.ownershipQueryMs;
  const found = await listenersOn(port, serveSeams.ownershipQueryMs);
  if (!found.ok) return { kind: "unknown", detail: found.why };
  const eligible = found.value.filter((l) => acceptsLoopback(l.host));
  if (eligible.length === 0) return { kind: "none" };
  const pids = [...new Set(eligible.map((l) => l.pid))];
  const groups = await groupsOf(pids, until - Date.now());
  if (!groups.ok) return { kind: "unknown", detail: groups.why };
  const foreign = pids.filter((p) => groups.value.get(p) !== pgid);
  if (foreign.length > 0) return { kind: "foreign", detail: `pid ${foreign.join(", ")} outside the group listens on ${port}` };
  return { kind: "owned" };
}

/** Whether lsof can run here: VERIFY cannot prove ownership without it. */
export async function lsofUnavailable(): Promise<string | null> {
  try {
    await access(serveSeams.lsofPath, constants.X_OK);
    return null;
  } catch (err) {
    return `lsof is not available at ${serveSeams.lsofPath} (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One GET, aborted at `timeoutMs`: the status after the body is consumed, or null. */
async function request(url: string, timeoutMs: number): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type Readiness = { readonly kind: "ready"; readonly status: number } | { readonly kind: ServeFailure; readonly detail: string };

/** Runs the VERIFY launch, readiness and shutdown. The caller checked the capability first. */
export async function runServe(spec: ServeSpec): Promise<ServeOutcome> {
  const deadline = Date.now() + spec.startupTimeoutMs;
  const before = await listenersOn(spec.port, serveSeams.ownershipQueryMs);
  if (!before.ok) return { kind: "ownership-unknown", detail: before.why, tail: "" };
  if (before.value.length > 0) return { kind: "port-occupied", detail: `pid ${[...new Set(before.value.map((l) => l.pid))].join(", ")} already listens on ${spec.port}`, tail: "" };
  await serveSeams.afterPortCheck();

  const url = `http://127.0.0.1:${spec.port}${spec.readinessPath}`;
  const run = await runOwnedGroup<Readiness>(
    { command: "/bin/sh", args: ["-c", spec.command], cwd: spec.cwd, env: spec.env, shutdownTimeoutMs: spec.shutdownTimeoutMs, onData: spec.onData },
    async (group) => {
      const notReady: Readiness = { kind: "not-ready", detail: `no 2xx from ${url} within ${spec.startupTimeoutMs} ms` };
      const expired = () => Date.now() >= deadline;
      // The leader must be alive, not merely some pid of its group: a launcher that forks the server and exits is not the approved command answering.
      const leaderGone = async (when: string): Promise<Readiness | null> => {
        if (group.exited() === null && group.probe() === "alive") return null;
        // The leader may be gone but not yet reaped (darwin answers EPERM for a group of zombies): wait for its exit, within the deadline.
        await Promise.race([group.exit, pause(Math.max(0, deadline - Date.now()))]);
        const exit = group.exited();
        return { kind: "exited-early", detail: exit === null ? "its process group is gone" : exit.signal !== null ? `it ended by ${exit.signal} ${when}` : `it exited with code ${exit.code} ${when}` };
      };
      for (;;) {
        if (expired()) return notReady;
        const gone = await leaderGone("before answering");
        if (gone !== null) return gone;
        await serveSeams.beforeOwnership1();
        const first = await observe(spec.port, group.pgid);
        if (expired()) return notReady;
        if (first.kind === "foreign") return { kind: "foreign-listener", detail: first.detail };
        if (first.kind === "unknown") return { kind: "ownership-unknown", detail: first.detail };
        if (first.kind === "owned") {
          const before = await leaderGone("before answering");
          if (before !== null) return before;
          const status = await request(url, deadline - Date.now());
          if (status !== null && status >= 200 && status < 300) {
            if (expired()) return notReady;
            await serveSeams.afterResponse();
            const second = await observe(spec.port, group.pgid);
            await serveSeams.afterOwnership2();
            if (expired()) return notReady;
            const after = await leaderGone("before its answer was confirmed");
            if (after !== null) return after;
            if (second.kind === "owned") return { kind: "ready", status };
            if (second.kind === "foreign") return { kind: "foreign-listener", detail: second.detail };
            return { kind: "ownership-unknown", detail: second.kind === "unknown" ? second.detail : `no listener of the group was on ${spec.port} after the 2xx` };
          }
        }
        await pause(Math.min(READINESS_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },
  );
  if (run.kind === "spawn-error") return { kind: "failed", detail: `the command could not start (${run.reason})`, tail: "" };
  if (!run.value.ok) throw run.value.error;
  const readiness = run.value.value;
  if (run.cleanup === "unconfirmed") return { kind: "cleanup-failed", detail: run.cleanupDetail ?? "the group was not confirmed gone", tail: spec.tail() };
  await serveSeams.duringShutdown();
  const after = await listenersOn(spec.port, serveSeams.ownershipQueryMs);
  if (readiness.kind !== "ready") return { kind: readiness.kind, detail: readiness.detail, tail: spec.tail() };
  if (!after.ok) return { kind: "shutdown-failed", detail: `the port could not be checked after shutdown: ${after.why}`, tail: spec.tail() };
  if (after.value.length > 0) return { kind: "shutdown-failed", detail: `pid ${[...new Set(after.value.map((l) => l.pid))].join(", ")} still listens on ${spec.port} after shutdown`, tail: spec.tail() };
  return { kind: "verified", status: readiness.status, tail: spec.tail() };
}
