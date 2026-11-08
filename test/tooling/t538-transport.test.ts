// T-538 S5b-0 commit 3: the transport's rules that need no engine, against a fake executable named
// explicitly. Production's own route is proven against the real engine in the docker file.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_ENV, asAttemptPath, decideOutcome, DOCKER_ENDPOINT, DOCKER_EXE, type DockerConfig, type EnvelopeLine, type ExecSpec, HelperDefect, lineAgrees, LINUX_SIGNALS, makeDockerTransport, parseEnvelopeLine, STDIN_LIMIT, WATCHDOG_MARGIN_SECONDS,
} from "../../scripts/onboarding-eval-transport.js";

const root = mkdtempSync(join(tmpdir(), "t538-tr-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ID = "a".repeat(64);
const line = (o: Partial<EnvelopeLine>): EnvelopeLine => ({ status: 0, signal: null, timedOut: "no", stdinAccepted: 0, ...o });
const framed = (id: string, o: unknown): Buffer => Buffer.from(`\0EVAL-ENVELOPE ${id} ${JSON.stringify(o)}\n`);

/** A stand-in docker that records what it was given and answers as its behaviour file says. */
function fake(behaviour: Record<string, unknown>, extra: Partial<DockerConfig> = {}) {
  const dir = mkdtempSync(join(root, "f-"));
  const exe = join(dir, "docker");
  writeFileSync(join(dir, "behaviour.json"), JSON.stringify(behaviour));
  writeFileSync(exe, `#!${process.execPath}
const fs = require("fs"); const b0 = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "behaviour.json"))}, "utf8"));
const a = process.argv.slice(2);
const callsFile = ${JSON.stringify(join(dir, "calls"))};
const n = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\\n").filter(Boolean).length : 0;
fs.appendFileSync(callsFile, JSON.stringify({ argv: a, env: process.env }) + "\\n");
fs.appendFileSync(${JSON.stringify(join(dir, "pids"))}, process.pid + "\\n");
const verb = a[4];
// A per-verb behaviour wins, then the n-th of a sequence, then the one behaviour.
const b = b0.verbs?.[verb] ?? (b0.seq ? b0.seq[Math.min(n, b0.seq.length - 1)] : b0);
if (verb === "inspect" && a.includes("--format")) { process.stdout.write(String(b.exitCode ?? "0") + "\\n"); process.exit(0); }
if (verb === "inspect") { if (b.inspect === undefined) { process.stderr.write(b.inspectError ?? "Cannot connect"); process.exit(1); } process.stdout.write(JSON.stringify([b.inspect])); process.exit(0); }
if (verb === "info") { process.stdout.write(b.daemon ?? ""); process.exit(b.daemon ? 0 : 1); }
const at = a.indexOf("/opt/eval/envelope.mjs"); const execId = a[at + 1];
if (b.hang) setTimeout(() => {}, 120000);
if (b.stdout) process.stdout.write(b.stdout);
if (b.stderr) process.stderr.write(b.stderr);
if (b.raw !== undefined) process.stderr.write("\\0EVAL-ENVELOPE " + execId + " " + b.raw + "\\n");
if (b.line) process.stderr.write("\\0EVAL-ENVELOPE " + (b.lineId ?? execId) + " " + JSON.stringify(b.line) + "\\n");
if (b.after) process.stderr.write(b.after);
process.exitCode = b.status ?? 0;
`);
  chmodSync(exe, 0o755);
  const home = join(dir, "home");
  const configDir = join(dir, "cfg");
  mkdirSync(home);
  mkdirSync(configDir);
  const config: DockerConfig = { exe, endpoint: "unix:///fake.sock", home, configDir, containerId: ID, ...extra };
  const pids = (): number[] => readFileSync(join(dir, "pids"), "utf8").trim().split("\n").map(Number);
  return { t: makeDockerTransport(config), config, dir, pids, calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }), home, configDir };
}
const spec = (o: Partial<ExecSpec> = {}): ExecSpec => ({ argv: ["true"], cwd: asAttemptPath("/vol/att/project"), env: {}, stdin: null, timeoutSeconds: 5, stdoutLimit: 1000, stderrLimit: 1000, ...o });
const OK = { status: 0, signal: null, timedOut: "no", stdinAccepted: 0 };

describe("attempt paths and env", () => {
  it.each(["/vol/att", "/vol/att/project", "/vol/att/a/b"])("accepts %s", (p) => expect(asAttemptPath(p)).toBe(p));
  it.each(["/vol/attx", "/etc", "project", "/vol/att/../../etc", "/vol/sock", ""])("refuses %j", (p) => expect(() => asAttemptPath(p)).toThrow());
  it("names exactly the plan's keys", async () => {
    expect([...ALLOWED_ENV].sort()).toEqual(["CODEX_HOME", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "PATH", "STORYBLOQ_EVAL_EVENTS", "STORYBLOQ_EVAL_FAULT", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_SETUP_REVIEW_DIR", "TMPDIR"]);
  });
  it.each(ALLOWED_ENV)("%s passes as -e", async (k) => {
    const f = fake({ line: OK });
    await f.t.exec(spec({ env: { [k]: "v" } }));
    expect(f.calls()[0]!.argv).toContain(`${k}=v`);
  });
  it.each(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS", "home"])("%s throws before anything runs", async (k) => {
    const f = fake({ line: OK });
    expect(() => f.t.exec(spec({ env: { [k]: "v" } }))).toThrow(/not allowed/);
    expect(() => f.calls()).toThrow();
  });
  it("refuses stdin over the limit, a bad timeout, an empty command", async () => {
    const f = fake({ line: OK });
    expect(() => f.t.exec(spec({ stdin: Buffer.alloc(STDIN_LIMIT + 1) }))).toThrow(/stdin/);
    expect(() => f.t.exec(spec({ timeoutSeconds: 0 }))).toThrow();
    expect(() => f.t.exec(spec({ argv: [] }))).toThrow();
  });
  it("addresses a container only by its 64-hex id", async () => {
    for (const containerId of ["t538-att-x", "a".repeat(63), "A".repeat(64), `${"a".repeat(64)} `]) {
      expect(() => makeDockerTransport({ exe: "/x", endpoint: "unix:///x", home: "/x", configDir: "/x", containerId })).toThrow(/64-hex/);
    }
  });
});

describe("the envelope's stdin count", () => {
  it("counts only what was accepted: a write to a child that closed stdin is not", async () => {
    const script = join(import.meta.dirname, "..", "..", "scripts", "eval-container", "envelope.mjs");
    const c = spawn(process.execPath, [script, "e1", "20", "--", "sh", "-c", "exec 0<&-; sleep 2; exit 3"], { stdio: ["pipe", "ignore", "pipe"] });
    const err: Buffer[] = [];
    c.stderr.on("data", (d: Buffer) => err.push(d));
    await new Promise((res) => setTimeout(res, 1000));
    c.stdin.on("error", () => {});
    c.stdin.end(Buffer.alloc(1000, 0x61));
    const code = await new Promise((res) => c.on("close", res));
    const parsed = parseEnvelopeLine(Buffer.concat(err), "e1");
    expect([code, parsed?.line.status, parsed?.line.stdinAccepted]).toEqual([3, 3, 0]);
  }, 30_000);
});

describe("the envelope line", () => {
  it("is taken only when last and for this exec, and removed", async () => {
    const r = parseEnvelopeLine(Buffer.concat([Buffer.from("real\n"), framed("e1", OK)]), "e1");
    expect(r!.line).toEqual(OK);
    expect(r!.rest.toString()).toBe("real\n");
  });
  it.each([
    ["another exec's", framed("e2", OK)],
    ["text after it", Buffer.concat([framed("e1", OK), Buffer.from("later\n")])],
    ["no newline", framed("e1", OK).subarray(0, -1)],
    ["a last byte standing in for the newline", Buffer.concat([framed("e1", OK).subarray(0, -1), Buffer.from("x")])],
    ["a blank line after it", Buffer.concat([framed("e1", OK), Buffer.from("\n")])],
    ["bad JSON", Buffer.from("\0EVAL-ENVELOPE e1 {nope\n")],
    ["status and signal both", framed("e1", { ...OK, status: 1, signal: "SIGTERM" })],
    ["neither", framed("e1", { ...OK, status: null })],
    ["a status out of range", framed("e1", { ...OK, status: 256 })],
    ["an unknown signal", framed("e1", { ...OK, status: null, signal: "SIGNOPE" })],
    ["an unknown timeout word", framed("e1", { ...OK, timedOut: "maybe" })],
    ["a negative count", framed("e1", { ...OK, stdinAccepted: -1 })],
    ["nothing", Buffer.alloc(0)],
    ["a null payload", framed("e1", null)],
    ["an array payload", framed("e1", [OK])],
    ["a number payload", framed("e1", 7)],
    ["a text payload", framed("e1", "ok")],
  ])("%s is no line", (_n, buf) => expect(parseEnvelopeLine(buf, "e1")).toBeNull());
  it("the last of two is the one read", async () => {
    const r = parseEnvelopeLine(Buffer.concat([framed("e1", { ...OK, status: 9 }), framed("e1", OK)]), "e1");
    expect(r!.line.status).toBe(0);
    expect(r!.rest.length).toBeGreaterThan(0);
  });
  it("uses Linux's signal numbers whatever the host's", async () => {
    expect(lineAgrees(line({ status: null, signal: "SIGUSR1" }), 138)).toBe(true);
    expect(LINUX_SIGNALS.SIGTERM).toBe(15);
    expect(LINUX_SIGNALS.SIGKILL).toBe(9);
  });
});

describe("the outcome", () => {
  const never = () => { throw new Error("must not ask"); };
  it.each([124, 125, 126, 127, 137, 0, 1])("a line saying %i agreeing with the CLI is ok, whatever the number", async (n) => {
    expect(decideOutcome(line({ status: n }), n, never)).toBe("ok");
  });
  it("a signal is ok only at 128+N", async () => {
    expect(decideOutcome(line({ status: null, signal: "SIGKILL" }), 137, never)).toBe("ok");
    expect(decideOutcome(line({ status: null, signal: "SIGKILL" }), 143, never)).toBe("ambiguous");
  });
  it("disagreement is ambiguous and asks nothing", async () => {
    expect(decideOutcome(line({ status: 0 }), 1, never)).toBe("ambiguous");
    expect(decideOutcome(line({ status: 0 }), null, never)).toBe("ambiguous");
  });
  it.each([[true, "ambiguous"], [null, "ambiguous"], [false, "container-gone"]] as const)("no line with running=%s is %s, for any exit number", (running, want) => {
    for (const n of [137, 125, 1, null]) expect(decideOutcome(null, n, () => running)).toBe(want);
  });
});

describe("the docker call", () => {
  it("passes exactly the scratch env, config and endpoint, and the envelope", async () => {
    const f = fake({ line: OK });
    const r = (await f.t.exec(spec({ argv: ["echo", "a b"], env: { HOME: "/vol/att/home" } })));
    const { argv, env } = f.calls()[0]!;
    // macOS itself adds this one to every process, before the first line of the fake runs.
    delete env.__CF_USER_TEXT_ENCODING;
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: f.home });
    expect(argv.slice(0, 4)).toEqual(["--config", f.configDir, "--host", "unix:///fake.sock"]);
    const execId = argv[argv.indexOf("/opt/eval/envelope.mjs") + 1]!;
    expect(argv.slice(4)).toEqual(["exec", "-w", "/vol/att/project", "-e", "HOME=/vol/att/home", ID, "node", "/opt/eval/envelope.mjs", execId, "5", "--", "echo", "a b"]);
    expect(r.outcome).toBe("ok");
    expect(r.child).toEqual({ status: 0, signal: null });
  });
  it("asks for -i only with stdin", async () => {
    const f = fake({ line: OK });
    await f.t.exec(spec({ stdin: Buffer.from("x") }));
    expect(f.calls()[0]!.argv[4 + 1]).toBe("-i");
  });
  it("uses a fresh exec id each time, so an old line cannot answer", async () => {
    const f = fake({ line: OK });
    await f.t.exec(spec());
    await f.t.exec(spec());
    const ids = f.calls().map(({ argv }) => argv[argv.indexOf("/opt/eval/envelope.mjs") + 1]);
    expect(new Set(ids).size).toBe(2);
  });
  it("names the exact production executable and endpoint", async () => {
    expect(DOCKER_EXE).toBe("/Applications/Docker.app/Contents/Resources/bin/docker");
    expect(DOCKER_ENDPOINT).toBe("unix:///Users/amirshayegh/.docker/run/docker.sock");
  });
  it("removes the line and keeps the rest of stderr", async () => {
    const f = fake({ stderr: "before\n", stdout: "out", line: OK });
    const r = (await f.t.exec(spec()));
    expect(r.stderr.toString()).toBe("before\n");
    expect(r.stdout.toString()).toBe("out");
  });
  it("a planted line for another exec stays evidence and proves nothing", async () => {
    const f = fake({ lineId: "someone-else", line: OK, inspect: { State: { Running: true } } });
    const r = (await f.t.exec(spec()));
    expect(r.outcome).toBe("ambiguous");
    expect(r.child).toBeNull();
    expect(r.timedOut).toBeNull();
    expect(r.stdinAccepted).toBeNull();
    expect(r.stderr.toString()).toContain("someone-else");
  });
  it.each(["null", "[]", "7"])("a final line carrying %s is ambiguous with stderr kept, and does not throw", async (raw) => {
    const f = fake({ stderr: "before\n", raw, inspect: { State: { Running: true } } });
    const r = (await f.t.exec(spec()));
    expect([r.outcome, r.child, r.timedOut]).toEqual(["ambiguous", null, null]);
    expect(r.stderr.toString()).toContain("before\n");
    expect(r.stderr.toString()).toContain(`EVAL-ENVELOPE`);
  });
  it("text after the line leaves the line unread", async () => {
    const f = fake({ line: OK, after: "x\n", inspect: { State: { Running: true } } });
    expect((await f.t.exec(spec())).outcome).toBe("ambiguous");
  });
  it("a CLI status that disagrees is ambiguous, with both preserved", async () => {
    const f = fake({ line: { ...OK, status: 3 }, status: 4 });
    const r = (await f.t.exec(spec()));
    expect([r.outcome, r.cliStatus, r.child?.status]).toEqual(["ambiguous", 4, 3]);
  });
  it("no line: running is ambiguous, stopped and missing are gone, failed inspect is ambiguous", async () => {
    const s = spec();
    expect((await fake({ status: 137, inspect: { State: { Running: true } } }).t.exec(s)).outcome).toBe("ambiguous");
    expect((await fake({ status: 137, inspect: { State: { Running: false } } }).t.exec(s)).outcome).toBe("container-gone");
    expect((await fake({ status: 1, inspectError: `Error: No such container: ${ID}` }).t.exec(s)).outcome).toBe("container-gone");
    expect((await fake({ status: 1, inspectError: "Cannot connect to the Docker daemon" }).t.exec(s)).outcome).toBe("ambiguous");
  });
  it("marks and cuts what is over a limit", async () => {
    const o = (await fake({ stdout: "x".repeat(50), line: OK }).t.exec(spec({ stdoutLimit: 10 })));
    expect([o.overLimit, o.stdout.length]).toEqual(["stdout", 10]);
    const e = (await fake({ stderr: "y".repeat(50), line: OK }).t.exec(spec({ stderrLimit: 10 })));
    expect([e.overLimit, e.stderr.length]).toEqual(["stderr", 10]);
    expect((await fake({ stderr: "y".repeat(10), line: OK }).t.exec(spec({ stderrLimit: 10 }))).overLimit).toBeNull();
  });
  it("streams whole lines and ends with the same result", async () => {
    const f = fake({ stdout: "one\ntwo\nthree", line: OK });
    const seen: string[] = [];
    const r = await f.t.execStream(spec(), (l) => seen.push(l.toString()));
    expect(seen).toEqual(["one", "two"]);
    expect([r.outcome, r.stdout.toString()]).toEqual(["ok", "one\ntwo\nthree"]);
  });
  it("a stream over its limit stops reading and says so", async () => {
    const r = await fake({ stdout: "x".repeat(5000), line: OK, inspect: { State: { Running: true } } }).t.execStream(spec({ stdoutLimit: 10 }), () => {});
    expect([r.overLimit, r.stdout.length]).toEqual(["stdout", 10]);
    const e = await fake({ stderr: "y".repeat(9000), line: OK, inspect: { State: { Running: true } } }).t.execStream(spec({ stderrLimit: 10 }), () => {});
    expect(e.overLimit).toBe("stderr");
  });
  const unstartable = (kind: "ENOENT" | "EACCES") => {
    const f = fake({});
    if (kind === "EACCES") { chmodSync(f.config.exe, 0o644); return { ...f.config }; }
    return { ...f.config, exe: join(root, "no-such-docker") };
  };
  it.each(["ENOENT", "EACCES"] as const)("a docker that cannot start (%s) settles once, ambiguous, with its reason kept", async (kind) => {
    const t = makeDockerTransport(unstartable(kind));
    const seen: string[] = [];
    const r = await t.execStream(spec(), (l) => seen.push(l.toString()));
    expect([r.cliStatus, r.child, r.timedOut, r.outcome, seen]).toEqual([null, null, null, "ambiguous", []]);
    expect(r.stderr.toString()).toContain(kind);
    const withStdin = await t.execStream(spec({ stdin: Buffer.from("x") }), () => {});
    expect([withStdin.cliStatus, withStdin.outcome]).toEqual([null, "ambiguous"]);
    const sync = (await t.exec(spec()));
    expect([sync.cliStatus, sync.child, sync.outcome]).toEqual([null, null, "ambiguous"]);
    expect(sync.stderr.toString()).toContain(kind);
  });
  it("a stream over a limit does not wait for the CLI to finish", async () => {
    const started = Date.now();
    const o = await fake({ hang: true, stdout: "x".repeat(5000) }).t.execStream(spec({ timeoutSeconds: 1, stdoutLimit: 10 }), () => {});
    expect(o.overLimit).toBe("stdout");
    const e = await fake({ hang: true, stderr: "y".repeat(9000) }).t.execStream(spec({ timeoutSeconds: 1, stderrLimit: 10 }), () => {});
    expect(e.overLimit).toBe("stderr");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);
  it("the host watchdog ends a CLI that never returns, 60 seconds past the envelope's own timeout", async () => {
    expect(WATCHDOG_MARGIN_SECONDS).toBe(60);
    const f = fake({ hang: true, inspect: { State: { Running: true } } });
    const started = Date.now();
    const sync = (await makeDockerTransport({ ...f.config, watchdogMarginSeconds: 0 }).exec(spec({ timeoutSeconds: 1 })));
    expect([sync.cliStatus, sync.child, sync.outcome]).toEqual([null, null, "ambiguous"]);
    const stream = await makeDockerTransport({ ...f.config, watchdogMarginSeconds: 0 }).execStream(spec({ timeoutSeconds: 1 }), () => {});
    expect([stream.cliStatus, stream.child, stream.outcome]).toEqual([null, null, "ambiguous"]);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
  it("the watchdog is cleared when the stream ends: no timer is left to kill anything later", async () => {
    const f = fake({ stdout: "done\n", line: OK });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const before = vi.getTimerCount();
      const r = await makeDockerTransport({ ...f.config, watchdogMarginSeconds: 0 }).execStream(spec({ timeoutSeconds: 1 }), () => {});
      expect([r.cliStatus, r.outcome]).toEqual([0, "ok"]);
      expect(vi.getTimerCount()).toBe(before);
      vi.advanceTimersByTime(5_000);
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
  it("compares the daemon's id to the manifest's", async () => {
    expect(fake({ daemon: "abc\n" }).t.daemonProblem("abc")).toBeNull();
    expect(fake({ daemon: "abc\n" }).t.daemonProblem("xyz")).toMatch(/not the manifest/);
    expect(fake({}).t.daemonProblem("abc")).toMatch(/did not answer/);
  });
  it("inspects by id and returns the document", async () => {
    const f = fake({ inspect: { State: { Running: true }, Id: ID } });
    expect((f.t.inspect() as { Id: string }).Id).toBe(ID);
    expect(f.calls()[0]!.argv.slice(4)).toEqual(["inspect", "--type", "container", ID]);
  });
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const doc = (o: unknown): string => `${JSON.stringify(o)}\n`;
const HID = "b".repeat(64);

describe("a harness step's exec (commit 6a: the plan's execSync, made asynchronous)", () => {
  it("stops at stdout's own limit while stderr's is larger, and the CLI is dead when the result arrives", async () => {
    const f = fake({ hang: true, stdout: "x".repeat(5000), stderr: "e" }, { watchdogMarginSeconds: 30 });
    const started = Date.now();
    const r = await f.t.exec(spec({ timeoutSeconds: 30, stdoutLimit: 10, stderrLimit: 1_000_000 }));
    expect([r.overLimit, r.stdout.length]).toEqual(["stdout", 10]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(f.pids().filter(alive)).toEqual([]);
  }, 30_000);
  it("stops at stderr's own limit while stdout's is larger", async () => {
    const f = fake({ hang: true, stderr: "y".repeat(9000) }, { watchdogMarginSeconds: 30 });
    const r = await f.t.exec(spec({ timeoutSeconds: 30, stdoutLimit: 1_000_000, stderrLimit: 10 }));
    expect([r.overLimit, r.stderr.length]).toEqual(["stderr", 10]);
    expect(f.pids().filter(alive)).toEqual([]);
  }, 30_000);
  it("a cancel kills the CLI, for a step and for a turn, and each settles after it exited", async () => {
    for (const kind of ["exec", "stream"] as const) {
      const f = fake({ hang: true }, { watchdogMarginSeconds: 30 });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const r = kind === "exec" ? await f.t.exec(spec({ timeoutSeconds: 30 }), ac.signal) : await f.t.execStream(spec({ timeoutSeconds: 30 }), () => {}, ac.signal);
      expect([r.cliStatus, r.child]).toEqual([null, null]);
      expect(f.pids().filter(alive)).toEqual([]);
    }
  }, 30_000);
  it("a signal already aborted kills it at once", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = fake({ hang: true }, { watchdogMarginSeconds: 30 });
    const r = await f.t.exec(spec({ timeoutSeconds: 30 }), ac.signal);
    expect(r.cliStatus).toBeNull();
  }, 30_000);
});

describe("the helper", () => {
  it("runs node /opt/eval/helper.js in /vol/att with its fixed env and returns the ok value", async () => {
    const f = fake({ stdout: doc({ ok: { a: 1 } }), line: OK });
    expect(await f.t.helper("tree-digest", ["/vol/att/project"])).toEqual({ a: 1 });
    const argv = f.calls()[0]!.argv;
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["node", "/opt/eval/helper.js", "tree-digest", "/vol/att/project"]);
    expect(argv.slice(5, 11)).toEqual(["-w", "/vol/att", "-e", "HOME=/vol/att/home", "-e", "PATH=/usr/local/bin:/usr/bin:/bin"]);
  });
  it("an error document, a malformed one, a non-zero exit, an over-limit one and an ambiguous exec are defects", async () => {
    await expect(fake({ stdout: doc({ error: "boom" }), line: { ...OK, status: 1 }, status: 1 }).t.helper("ledger-digest", ["/x"])).rejects.toThrow(new HelperDefect("helper ledger-digest: boom"));
    await expect(fake({ stdout: "{not json", line: OK }).t.helper("ledger-digest", ["/x"])).rejects.toThrow(/not one JSON document/);
    await expect(fake({ stdout: "[1]", line: OK }).t.helper("ledger-digest", ["/x"])).rejects.toThrow(/not an object/);
    await expect(fake({ stdout: doc({ ok: 1 }), line: { ...OK, status: 2 }, status: 2 }).t.helper("ledger-digest", ["/x"])).rejects.toThrow(/exit 2/);
    await expect(fake({ stdout: doc({ ok: 1 }), status: 0, inspect: { State: { Running: true } } }).t.helper("ledger-digest", ["/x"])).rejects.toThrow(/ambiguous/);
    await expect(fake({ stdout: doc({ ok: 1 }), stderr: "z".repeat(1048576 + 5000), line: OK }).t.helper("ledger-digest", ["/x"])).rejects.toThrow(/stderr is over the limit/);
  });
  it("readBytes: absent is null, bytes come back, a refusal throws, and only an attempt path is asked for", async () => {
    expect(await fake({ stdout: doc({ ok: { absent: true } }), line: OK }).t.readBytes(asAttemptPath("/vol/att/x"), 10)).toBeNull();
    expect((await fake({ stdout: doc({ ok: { base64: Buffer.from("hi").toString("base64") } }), line: OK }).t.readBytes(asAttemptPath("/vol/att/x"), 10))?.toString()).toBe("hi");
    await expect(fake({ stdout: doc({ ok: { refused: "a symlink" } }), line: OK }).t.readBytes(asAttemptPath("/vol/att/x"), 10)).rejects.toThrow("read /vol/att/x: a symlink");
    await expect(fake({}).t.readBytes("/etc/passwd" as never, 10)).rejects.toThrow(/not a path under/);
  });
});

describe("the live capture", () => {
  const live = (o: Record<string, unknown>) => ({ stdout: doc({ ok: { d1: "A", d2: "A", problems: [], packExit: 0, tarBase64: Buffer.from("T").toString("base64"), recordsBase64: "", readiness: [], outsideGroup: 0, ...o } }), line: OK });
  const waits: number[] = [];
  const opts = { wait: async (ms: number) => { waits.push(ms); } };
  it("one clean try is consistent", async () => {
    const f = fake(live({}), opts);
    const c = await f.t.captureLive([["ticket", "next"]]);
    expect([c.status, c.tries, c.tar.toString()]).toEqual(["consistent", 1, "T"]);
    const argv = f.calls()[0]!.argv;
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["node", "/opt/eval/helper.js", "capture-live", "/vol/att/project/.story", '["ticket","next"]']);
  });
  it("a writer that stops in time is consistent on a retry, 2 s later", async () => {
    waits.length = 0;
    const c = await fake({ seq: [live({ d2: "B" }), live({})] }, opts).t.captureLive([]);
    expect([c.status, c.tries, waits]).toEqual(["consistent", 2, [2000]]);
  });
  it("digests that never agree are inconclusive after three tries, with both kept", async () => {
    waits.length = 0;
    const c = await fake(live({ d2: "B" }), opts).t.captureLive([]);
    expect([c.status, c.tries, c.d1, c.d2, waits]).toEqual(["inconclusive", 3, "A", "B", [2000, 2000]]);
  });
  it("a pack read failure, a failed pack exit, unparseable records and a ledger problem are inconclusive too", async () => {
    for (const o of [{ recordsBase64: Buffer.from("E\0file changed as we read it\0").toString("base64") }, { packExit: 2 }, { recordsBase64: Buffer.from("junk").toString("base64") }, { problems: [".story: unreadable"] }]) {
      expect((await fake(live(o), opts).t.captureLive([])).status).toBe("inconclusive");
    }
  });
});

describe("stop, final pack and removal", () => {
  it("stop: docker stop -t N by id; a failure and a cancel are named", async () => {
    const f = fake({ status: 0 });
    expect(await f.t.stop(10, new AbortController().signal)).toEqual({ ok: true });
    expect(f.calls()[0]!.argv.slice(4)).toEqual(["stop", "-t", "10", ID]);
    expect(await fake({ status: 1, stderr: "no such container" }).t.stop(10, new AbortController().signal)).toEqual({ ok: false, reason: "docker stop failed (1): no such container" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const h = fake({ hang: true });
    expect(await h.t.stop(10, ac.signal)).toEqual({ ok: false, reason: "the stop was cancelled" });
    expect(h.pids().filter(alive)).toEqual([]);
  }, 30_000);
  const packer = (start: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const f = fake({ verbs: { create: { stdout: `${HID}\n` }, start, rm: {}, kill: {}, ...extra } }, { attemptId: "att-1" });
    const raw = join(f.dir, "raw");
    mkdirSync(raw);
    const created: string[] = [];
    const req = { image: "sha256:img", volume: "t538-vol", target: "/vol/att", profile: "attempt" as const, rawDir: raw, onCreated: (id: string) => created.push(`${id}@${f.calls().length}`), timeoutMs: 20_000 };
    return { f, raw, created, req };
  };
  it("pack: created with production's arguments, recorded before start, written 0600, hashed, published, and the helper removed", async () => {
    const { f, raw, created, req } = packer({ stdout: "TARBYTES", stderr: "M\0store\0" });
    const r = await f.t.packFinal(req, new AbortController().signal);
    expect(r).toMatchObject({ ok: true, tarPath: join(raw, "attempt.tar"), bytes: 8, records: { missing: ["store"] } });
    expect(readFileSync(join(raw, "attempt.tar"), "utf8")).toBe("TARBYTES");
    expect(statSync(join(raw, "attempt.tar")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(raw, "attempt.tar.part"))).toBe(false);
    // Recorded after the create and before anything else ran.
    expect(created).toEqual([`${HID}@1`]);
    const verbs = f.calls().map((c) => c.argv.slice(4, 6).join(" "));
    expect(verbs).toEqual(["create --init", `start -a`, "inspect --type", `rm -fv`]);
    expect(f.calls()[0]!.argv).toContain("cpm-t538-attempt=att-1");
  });
  it("pack: a helper that exits non-zero, records that are not records, and an archive already published fail, and the helper still goes", async () => {
    const bad = packer({ stdout: "T" }, { inspect: { exitCode: 2 } });
    expect(await bad.f.t.packFinal(bad.req, new AbortController().signal)).toEqual({ ok: false, reason: "the pack helper exited 2" });
    expect(bad.f.calls().at(-1)!.argv.slice(4)).toEqual(["rm", "-fv", HID]);
    const junk = packer({ stdout: "T", stderr: "not records" });
    expect(await junk.f.t.packFinal(junk.req, new AbortController().signal)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a record/) });
    const twice = packer({ stdout: "T" });
    writeFileSync(join(twice.raw, "attempt.tar"), "OLD");
    expect(await twice.f.t.packFinal(twice.req, new AbortController().signal)).toEqual({ ok: false, reason: "an archive of that name is already published" });
    expect(readFileSync(join(twice.raw, "attempt.tar"), "utf8")).toBe("OLD");
  });
  it("pack: a cancel kills the CLI and the helper, and a failed create starts nothing", async () => {
    const hung = packer({ hang: true, stdout: "T" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect(await hung.f.t.packFinal(hung.req, ac.signal)).toEqual({ ok: false, reason: "the pack was cancelled" });
    expect(hung.f.calls().map((c) => c.argv[4])).toEqual(["create", "start", "kill", "rm"]);
    const none = packer({});
    const noCreate = fake({ verbs: { create: { status: 1, stderr: "no image" } } }, { attemptId: "att-1" });
    expect(await noCreate.t.packFinal(none.req, new AbortController().signal)).toMatchObject({ ok: false, reason: expect.stringMatching(/not created/) });
    expect(noCreate.calls().map((c) => c.argv[4])).toEqual(["create"]);
  }, 30_000);
  it("pack and removal refuse a transport with no attempt id", async () => {
    const f = fake({});
    await expect(f.t.packFinal(packer({}).req, new AbortController().signal)).rejects.toThrow(/no attempt id/);
    await expect(f.t.remove(new AbortController().signal)).rejects.toThrow(/no attempt id/);
  });
  it("removal selects by this attempt's label only and counts what is left", async () => {
    const f = fake({ seq: [{ stdout: "c1\nc2\n" }, {}, { stdout: "v1\n" }, {}, { stdout: "" }, { stdout: "v1\n" }] }, { attemptId: "att-1" });
    expect(await f.t.remove(new AbortController().signal)).toEqual({ left: 1 });
    expect(f.calls().map((c) => c.argv.slice(4))).toEqual([
      ["ps", "-aq", "--filter", "label=cpm-t538-attempt=att-1"], ["rm", "-fv", "c1", "c2"],
      ["volume", "ls", "-q", "--filter", "label=cpm-t538-attempt=att-1"], ["volume", "rm", "v1"],
      ["ps", "-aq", "--filter", "label=cpm-t538-attempt=att-1"], ["volume", "ls", "-q", "--filter", "label=cpm-t538-attempt=att-1"],
    ]);
    expect(await fake({ status: 1 }, { attemptId: "att-1" }).t.remove(new AbortController().signal)).toEqual({ left: 2 });
  });
});
