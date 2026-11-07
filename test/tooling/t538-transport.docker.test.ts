// T-538 S5b-0 commit 3: the envelope, production's route and the predicate on real containers
// (plan sections 4 and 8). A plain run skips this with a named reason; the shipping gate sets
// STORYBLOQ_REQUIRE_DOCKER=1. Always under box run. No model and no credential of any kind.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptRunArgs, containerNames, packCreateArgs, proxyRunArgs, type SandboxRole, volumeInitArgs } from "../../scripts/onboarding-eval-container.js";
import { shapeProblems, type Role } from "../../scripts/onboarding-eval-predicate.js";
import { asAttemptPath, DOCKER_ENDPOINT, DOCKER_EXE, type ExecSpec, type ExecTransport, makeDockerTransport, Transport } from "../../scripts/onboarding-eval-transport.js";

const IMAGE = process.env.T538_IMAGE ?? "";
const PROXY_IMAGE = process.env.T538_PROXY_IMAGE ?? "";
const REQUIRED = process.env.STORYBLOQ_REQUIRE_DOCKER === "1";
const docker = (args: readonly string[], timeout = 120_000): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 64 * 1048576 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const usable = docker(["version", "--format", "{{.Server.Version}}"], 15_000).status === 0 && IMAGE !== "" && PROXY_IMAGE !== "";
const skipReason = "docker tests skipped: no usable engine, or T538_IMAGE and T538_PROXY_IMAGE are not set";
if (!usable && !REQUIRED) console.log(skipReason);

describe.runIf(REQUIRED && !usable)("the docker gate for the transport", () => {
  it("fails when the shipping gate requires docker and it is not usable", () => { expect.fail(skipReason); });
});

const must = (args: readonly string[]): string => {
  const r = docker(args);
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.slice(0, 400)}`);
  return r.stdout.trim();
};
const SUITE = `c3${process.pid}`;
const used: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "t538-trd-"));
const home = join(scratch, "home");
const configDir = join(scratch, "cfg");
mkdirSync(home);
mkdirSync(configDir);

/** A sandbox role's objects, with no proxy: its relay only connects when asked. */
function sandbox(id: string, role: SandboxRole = "attempt"): string {
  used.push(id);
  const n = containerNames(id, role);
  const label = ["--label", `cpm-t538-attempt=${id}`];
  for (const v of [n.attemptVolume, n.socketVolume]) must(["volume", "create", ...label, v]);
  return must(attemptRunArgs(id, IMAGE, 900, undefined, role));
}
const transportFor = (containerId: string): ExecTransport => Transport.production({ home, configDir, containerId });
const spec = (argv: readonly string[], o: Partial<ExecSpec> = {}): ExecSpec => ({ argv, cwd: asAttemptPath("/vol/att/project"), env: {}, stdin: null, timeoutSeconds: 60, stdoutLimit: 16 * 1048576, stderrLimit: 16 * 1048576, ...o });
const removeLabelled = (id: string): void => {
  const f = `label=cpm-t538-attempt=${id}`;
  for (const [kind, q] of [["rm", ["ps", "-aq", "--filter", f]], ["volume", ["volume", "ls", "-q", "--filter", f]], ["network", ["network", "ls", "-q", "--filter", f]]] as const) {
    const ids = docker(q).stdout.trim().split("\n").filter(Boolean);
    if (ids.length > 0) docker(kind === "rm" ? ["rm", "-fv", ...ids] : [kind, "rm", ...ids]);
  }
};

afterAll(() => { for (const id of used) removeLabelled(id); rmSync(scratch, { recursive: true, force: true }); }, 120_000);

describe.runIf(usable)("the envelope, through a real container", () => {
  let t: ExecTransport;
  let box = "";
  beforeAll(() => { box = sandbox(`${SUITE}env`); t = transportFor(box); }, 120_000);

  it.each([0, 1, 124, 125, 126, 127, 137])("a command that itself exits %i is reported as that, not as a timeout or a runner failure", (n) => {
    const r = t.execSync(spec(["sh", "-c", `exit ${n}`]));
    expect([r.child?.status, r.child?.signal, r.timedOut, r.cliStatus, r.outcome]).toEqual([n, null, "no", n, "ok"]);
  }, 60_000);
  it("a missing program is 127 from the envelope and still ok", () => {
    const r = t.execSync(spec(["/no/such/program"]));
    expect([r.child?.status, r.cliStatus, r.outcome]).toEqual([127, 127, "ok"]);
  }, 60_000);
  it("a file that cannot run is 126 from the envelope", () => {
    const r = t.execSync(spec(["/etc/passwd"]));
    expect([r.child?.status, r.cliStatus, r.outcome]).toEqual([126, 126, "ok"]);
  }, 60_000);
  it("the envelope refuses a call it cannot read, with no line", () => {
    for (const args of [["x", "0", "--", "true"], ["x", "1", "true"], ["x", "1", "--"], ["", "1", "--", "true"]]) {
      const r = docker(["exec", box, "node", "/opt/eval/envelope.mjs", ...args]);
      expect(r.status).toBe(2);
      expect(r.stderr).not.toContain("EVAL-ENVELOPE");
    }
  }, 60_000);
  it("a signal stays a signal, and is not confused with exiting 137", () => {
    const u = t.execSync(spec(["sh", "-c", "kill -USR1 $$"]));
    expect([u.child?.status, u.child?.signal, u.cliStatus, u.outcome, u.timedOut]).toEqual([null, "SIGUSR1", 138, "ok", "no"]);
    const k = t.execSync(spec(["sh", "-c", "kill -KILL $$"]));
    expect([k.child?.status, k.child?.signal, k.cliStatus, k.outcome]).toEqual([null, "SIGKILL", 137, "ok"]);
  }, 60_000);
  it("output passes through unchanged and the line does not show", () => {
    const r = t.execSync(spec(["sh", "-c", "printf 'a\\000b\\n'; printf 'err\\n' >&2"]));
    expect(r.stdout).toEqual(Buffer.from("a\0b\n"));
    expect(r.stderr.toString()).toBe("err\n");
  }, 60_000);
  it("sets the working folder and env", () => {
    const r = t.execSync(spec(["sh", "-c", "pwd; echo $TMPDIR"], { env: { TMPDIR: "/vol/att/tmp" } }));
    expect(r.stdout.toString()).toBe("/vol/att/project\n/vol/att/tmp\n");
  }, 60_000);
  it("a timeout the child honours is term, and the whole group goes", () => {
    const started = Date.now();
    const r = t.execSync(spec(["sh", "-c", "sleep 111 & sleep 111"], { timeoutSeconds: 1 }));
    expect([r.child?.signal, r.timedOut, r.cliStatus, r.outcome]).toEqual(["SIGTERM", "term", 143, "ok"]);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(t.execSync(spec(["sh", "-c", "pgrep -c -f 'sleep 11[1]' || true"])).stdout.toString().trim()).toBe("0");
  }, 60_000);
  it("something in the group ignoring TERM goes when the child has gone", () => {
    const r = t.execSync(spec(["sh", "-c", "(trap '' TERM; exec sleep 333) & sleep 333"], { timeoutSeconds: 1 }));
    expect([r.child?.signal, r.timedOut, r.outcome]).toEqual(["SIGTERM", "term", "ok"]);
    expect(t.execSync(spec(["sh", "-c", "pgrep -c -f 'sleep 33[3]' || true"])).stdout.toString().trim()).toBe("0");
  }, 60_000);
  it("a child ignoring TERM is killed 30 seconds later, and its group with it", () => {
    const started = Date.now();
    const r = t.execSync(spec(["sh", "-c", "trap '' TERM; sleep 222 & sleep 222"], { timeoutSeconds: 1 }));
    expect([r.child?.signal, r.timedOut, r.cliStatus, r.outcome]).toEqual(["SIGKILL", "kill", 137, "ok"]);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(30_000);
    expect(took).toBeLessThan(50_000);
    expect(t.execSync(spec(["sh", "-c", "pgrep -c -f 'sleep 22[2]' || true"])).stdout.toString().trim()).toBe("0");
  }, 90_000);
  it("a killed envelope leaves no line while the container runs: ambiguous, never a status", async () => {
    const running = t.execStream(spec(["sleep", "77"], { timeoutSeconds: 100 }), () => {});
    for (let i = 0; i < 40; i++) {
      if (t.execSync(spec(["sh", "-c", "pgrep -c -x sleep || true"])).stdout.toString().trim() !== "0") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(t.execSync(spec(["pkill", "-KILL", "-f", "[e]nvelope.mjs [^ ]* 100 -- sleep 77"])).child?.status).toBe(0);
    const r = await running;
    expect([r.child, r.timedOut, r.stdinAccepted, r.outcome]).toEqual([null, null, null, "ambiguous"]);
    expect(r.cliStatus).not.toBeNull();
    t.execSync(spec(["pkill", "-KILL", "-x", "sleep"]));
  }, 60_000);
  it("takes all the stdin a reader wants, and counts it", () => {
    const body = Buffer.alloc(1048576, 0x61);
    const r = t.execSync(spec(["wc", "-c"], { stdin: body }));
    expect(r.stdout.toString().trim()).toBe(String(body.length));
    expect([r.stdinAccepted, r.child?.status, r.outcome]).toEqual([body.length, 0, "ok"]);
  }, 60_000);
  it("stdin larger than the child reads is a recorded fact, not a crash", () => {
    const body = Buffer.alloc(8 * 1048576, 0x62);
    const r = t.execSync(spec(["head", "-c", "10"], { stdin: body }));
    expect([r.stdout.length, r.child?.status, r.outcome]).toEqual([10, 0, "ok"]);
    expect(r.stdinAccepted).toBeLessThan(body.length);
  }, 60_000);
  it("the child closing stdin first is a recorded fact, not a crash", () => {
    const r = t.execSync(spec(["sh", "-c", "exec 0<&-; sleep 1; exit 3"], { stdin: Buffer.alloc(4 * 1048576, 0x63) }));
    expect([r.child?.status, r.cliStatus, r.outcome]).toEqual([3, 3, "ok"]);
    expect(r.stdinAccepted).toBeLessThan(4 * 1048576);
  }, 60_000);
  it("no stdin means /dev/null, so a reader ends at once", () => {
    const r = t.execSync(spec(["sh", "-c", "readlink /proc/self/fd/0; cat; echo done"], { timeoutSeconds: 20 }));
    expect([r.stdout.toString(), r.timedOut, r.stdinAccepted, r.outcome]).toEqual(["/dev/null\ndone\n", "no", 0, "ok"]);
  }, 60_000);
  it("a child that leaves something behind still reports its own status", () => {
    const r = t.execSync(spec(["sh", "-c", "sleep 2 >/dev/null 2>&1 & exit 5"]));
    expect([r.child?.status, r.outcome]).toEqual([5, "ok"]);
  }, 60_000);
  it("streams lines from a real command and classifies the same way", async () => {
    const seen: string[] = [];
    const r = await t.execStream(spec(["sh", "-c", "echo one; echo two; exit 124"]), (l) => seen.push(l.toString()));
    expect(seen).toEqual(["one", "two"]);
    expect([r.child?.status, r.timedOut, r.outcome]).toEqual([124, "no", "ok"]);
  }, 60_000);
  it("over a limit it stops reading and says which", async () => {
    const r = t.execSync(spec(["sh", "-c", "head -c 100000 /dev/zero"], { stdoutLimit: 100 }));
    expect([r.overLimit, r.stdout.length]).toEqual(["stdout", 100]);
    const s = await t.execStream(spec(["sh", "-c", "head -c 10000000 /dev/zero >&2"], { stderrLimit: 100 }), () => {});
    expect(s.overLimit).toBe("stderr");
    expect(s.stderr.length).toBe(100);
  }, 60_000);
});

describe.runIf(usable)("production's route", () => {
  it("a dead endpoint is ambiguous with the CLI's words, and the daemon check says it did not answer", () => {
    const t = makeDockerTransport({ exe: DOCKER_EXE, endpoint: "unix:///nonexistent/t538.sock", home, configDir, containerId: "b".repeat(64) });
    const r = t.execSync(spec(["true"]));
    expect([r.child, r.outcome]).toEqual([null, "ambiguous"]);
    expect(r.cliStatus).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/connect/i);
    expect(t.daemonProblem("anything")).toMatch(/did not answer/);
  }, 60_000);
  it("the real daemon's id is compared to the manifest's", () => {
    const id = must(["info", "--format", "{{.ID}}"]);
    const t = transportFor("c".repeat(64));
    expect(t.daemonProblem(id)).toBeNull();
    expect(t.daemonProblem("other")).toMatch(/not the manifest/);
  }, 60_000);
  it("a fake docker on PATH, DOCKER_HOST and DOCKER_CONTEXT change nothing, and the fake never runs", () => {
    const containerId = sandbox(`${SUITE}route`);
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const sentinel = join(scratch, "fake-ran");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\ntouch ${sentinel}\nexit 99\n`);
    chmodSync(join(bin, "docker"), 0o755);
    const saved = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, DOCKER_CONFIG: process.env.DOCKER_CONFIG };
    let r;
    try {
      process.env.PATH = `${bin}:${process.env.PATH}`;
      process.env.DOCKER_HOST = "unix:///nonexistent/t538.sock";
      process.env.DOCKER_CONTEXT = "t538-dead-context";
      process.env.DOCKER_CONFIG = join(scratch, "nope");
      r = transportFor(containerId).execSync(spec(["sh", "-c", "exit 42"]));
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    expect([r.child?.status, r.outcome]).toEqual([42, "ok"]);
    expect(existsSync(sentinel)).toBe(false);
    expect(DOCKER_ENDPOINT.startsWith("unix:///")).toBe(true);
  }, 120_000);
  it("a container replaced under the same name is not reached: the id is gone", () => {
    const id = `${SUITE}swap`;
    const first = sandbox(id);
    const t = transportFor(first);
    expect(t.execSync(spec(["true"])).outcome).toBe("ok");
    must(["rm", "-f", first]);
    const second = must(attemptRunArgs(id, IMAGE, 900));
    expect(second).not.toBe(first);
    const r = t.execSync(spec(["touch", "/vol/att/project/reached-after-swap"]));
    expect([r.child, r.outcome]).toEqual([null, "container-gone"]);
    expect(transportFor(second).execSync(spec(["test", "-e", "/vol/att/project/reached-after-swap"])).child?.status).toBe(1);
  }, 120_000);
  it("a removed container inspects as nothing", () => {
    const stopped = sandbox(`${SUITE}stop`);
    must(["rm", "-f", stopped]);
    expect(transportFor(stopped).inspect()).toBeNull();
  }, 120_000);
});

describe.runIf(usable)("the predicate on real containers", () => {
  const judged = (role: Role, containerId: string, extra: { attemptId: string; serves?: SandboxRole; pack?: { volume: string; target: string; profile: string } }): readonly string[] => shapeProblems(transportFor(containerId).inspect(), {
    role, id: containerId, attemptId: extra.attemptId, image: role === "proxy" ? PROXY_IMAGE : IMAGE, deadlineSeconds: 900,
    ...(role === "proxy" ? { proxyEnv: { ALLOW: "sink:8080", EXPIRY_MS: "600000" }, servesRole: extra.serves ?? "attempt" } : {}),
    ...(extra.pack ? { pack: extra.pack } : {}),
  });
  it.each(["attempt", "probe", "judge"] as const)("%s and its own proxy, as launched, pass", (role) => {
    const id = `${SUITE}p${role}`;
    const n = containerNames(id, role);
    used.push(id);
    const label = ["--label", `cpm-t538-attempt=${id}`];
    for (const v of [n.proxyVolume]) must(["volume", "create", ...label, v]);
    must(["network", "create", ...label, n.external]);
    const box = sandbox(id, role);
    must(volumeInitArgs(id, PROXY_IMAGE, role));
    const proxy = must(proxyRunArgs(id, PROXY_IMAGE, { ALLOW: "sink:8080", EXPIRY_MS: "600000" }, role));
    expect(judged(role, box, { attemptId: id })).toEqual([]);
    expect(judged("proxy", proxy, { attemptId: id, serves: role })).toEqual([]);
  }, 120_000);
  it("the pack helper, as created, passes before it starts", () => {
    const id = `${SUITE}ppack`;
    sandbox(id);
    const volume = containerNames(id).attemptVolume;
    const helper = must(packCreateArgs(id, IMAGE, volume, "/vol/att", "project"));
    expect(judged("pack", helper, { attemptId: id, pack: { volume, target: "/vol/att", profile: "project" } })).toEqual([]);
  }, 120_000);
  it.each([
    ["a capability", ["--cap-add", "NET_ADMIN"]],
    ["a sysctl", ["--sysctl", "net.ipv4.ip_unprivileged_port_start=0"]],
    ["a host", ["--add-host", "evil:1.2.3.4"]],
    ["an env entry", ["--env", "EXTRA=1"]],
    ["a label", ["--label", "extra=1"]],
  ])("a really different launch refuses: %s", (_name, extra) => {
    const id = `${SUITE}d${_name.replace(/\W/g, "")}`;
    const n = containerNames(id);
    used.push(id);
    const label = ["--label", `cpm-t538-attempt=${id}`];
    for (const v of [n.attemptVolume, n.socketVolume]) must(["volume", "create", ...label, v]);
    const args = [...attemptRunArgs(id, IMAGE, 900)];
    args.splice(2, 0, ...extra);
    expect(judged("attempt", must(args), { attemptId: id }).length).toBeGreaterThan(0);
  }, 120_000);
});
