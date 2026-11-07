// T-538 S5b-0 commit 3: the transport's rules that need no engine, against a fake executable named
// explicitly. Production's own route is proven against the real engine in the docker file.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALLOWED_ENV, asAttemptPath, decideOutcome, DOCKER_ENDPOINT, DOCKER_EXE, type EnvelopeLine, type ExecSpec, lineAgrees, LINUX_SIGNALS, makeDockerTransport, parseEnvelopeLine, STDIN_LIMIT, WATCHDOG_MARGIN_SECONDS,
} from "../../scripts/onboarding-eval-transport.js";

const root = mkdtempSync(join(tmpdir(), "t538-tr-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ID = "a".repeat(64);
const line = (o: Partial<EnvelopeLine>): EnvelopeLine => ({ status: 0, signal: null, timedOut: "no", stdinAccepted: 0, ...o });
const framed = (id: string, o: unknown): Buffer => Buffer.from(`\0EVAL-ENVELOPE ${id} ${JSON.stringify(o)}\n`);

/** A stand-in docker that records what it was given and answers as its behaviour file says. */
function fake(behaviour: Record<string, unknown>) {
  const dir = mkdtempSync(join(root, "f-"));
  const exe = join(dir, "docker");
  writeFileSync(join(dir, "behaviour.json"), JSON.stringify(behaviour));
  writeFileSync(exe, `#!${process.execPath}
const fs = require("fs"); const b = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "behaviour.json"))}, "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "calls"))}, JSON.stringify({ argv: a, env: process.env }) + "\\n");
const verb = a[4];
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
  const config = { exe, endpoint: "unix:///fake.sock", home, configDir, containerId: ID };
  return { t: makeDockerTransport(config), config, calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> }), home, configDir };
}
const spec = (o: Partial<ExecSpec> = {}): ExecSpec => ({ argv: ["true"], cwd: asAttemptPath("/vol/att/project"), env: {}, stdin: null, timeoutSeconds: 5, stdoutLimit: 1000, stderrLimit: 1000, ...o });
const OK = { status: 0, signal: null, timedOut: "no", stdinAccepted: 0 };

describe("attempt paths and env", () => {
  it.each(["/vol/att", "/vol/att/project", "/vol/att/a/b"])("accepts %s", (p) => expect(asAttemptPath(p)).toBe(p));
  it.each(["/vol/attx", "/etc", "project", "/vol/att/../../etc", "/vol/sock", ""])("refuses %j", (p) => expect(() => asAttemptPath(p)).toThrow());
  it("names exactly the plan's keys", () => {
    expect([...ALLOWED_ENV].sort()).toEqual(["CODEX_HOME", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "PATH", "STORYBLOQ_EVAL_EVENTS", "STORYBLOQ_EVAL_FAULT", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_SETUP_REVIEW_DIR", "TMPDIR"]);
  });
  it.each(ALLOWED_ENV)("%s passes as -e", (k) => {
    const f = fake({ line: OK });
    f.t.execSync(spec({ env: { [k]: "v" } }));
    expect(f.calls()[0]!.argv).toContain(`${k}=v`);
  });
  it.each(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS", "home"])("%s throws before anything runs", (k) => {
    const f = fake({ line: OK });
    expect(() => f.t.execSync(spec({ env: { [k]: "v" } }))).toThrow(/not allowed/);
    expect(() => f.calls()).toThrow();
  });
  it("refuses stdin over the limit, a bad timeout, an empty command", () => {
    const f = fake({ line: OK });
    expect(() => f.t.execSync(spec({ stdin: Buffer.alloc(STDIN_LIMIT + 1) }))).toThrow(/stdin/);
    expect(() => f.t.execSync(spec({ timeoutSeconds: 0 }))).toThrow();
    expect(() => f.t.execSync(spec({ argv: [] }))).toThrow();
  });
  it("addresses a container only by its 64-hex id", () => {
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
  it("is taken only when last and for this exec, and removed", () => {
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
  it("the last of two is the one read", () => {
    const r = parseEnvelopeLine(Buffer.concat([framed("e1", { ...OK, status: 9 }), framed("e1", OK)]), "e1");
    expect(r!.line.status).toBe(0);
    expect(r!.rest.length).toBeGreaterThan(0);
  });
  it("uses Linux's signal numbers whatever the host's", () => {
    expect(lineAgrees(line({ status: null, signal: "SIGUSR1" }), 138)).toBe(true);
    expect(LINUX_SIGNALS.SIGTERM).toBe(15);
    expect(LINUX_SIGNALS.SIGKILL).toBe(9);
  });
});

describe("the outcome", () => {
  const never = () => { throw new Error("must not ask"); };
  it.each([124, 125, 126, 127, 137, 0, 1])("a line saying %i agreeing with the CLI is ok, whatever the number", (n) => {
    expect(decideOutcome(line({ status: n }), n, never)).toBe("ok");
  });
  it("a signal is ok only at 128+N", () => {
    expect(decideOutcome(line({ status: null, signal: "SIGKILL" }), 137, never)).toBe("ok");
    expect(decideOutcome(line({ status: null, signal: "SIGKILL" }), 143, never)).toBe("ambiguous");
  });
  it("disagreement is ambiguous and asks nothing", () => {
    expect(decideOutcome(line({ status: 0 }), 1, never)).toBe("ambiguous");
    expect(decideOutcome(line({ status: 0 }), null, never)).toBe("ambiguous");
  });
  it.each([[true, "ambiguous"], [null, "ambiguous"], [false, "container-gone"]] as const)("no line with running=%s is %s, for any exit number", (running, want) => {
    for (const n of [137, 125, 1, null]) expect(decideOutcome(null, n, () => running)).toBe(want);
  });
});

describe("the docker call", () => {
  it("passes exactly the scratch env, config and endpoint, and the envelope", () => {
    const f = fake({ line: OK });
    const r = f.t.execSync(spec({ argv: ["echo", "a b"], env: { HOME: "/vol/att/home" } }));
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
  it("asks for -i only with stdin", () => {
    const f = fake({ line: OK });
    f.t.execSync(spec({ stdin: Buffer.from("x") }));
    expect(f.calls()[0]!.argv[4 + 1]).toBe("-i");
  });
  it("uses a fresh exec id each time, so an old line cannot answer", () => {
    const f = fake({ line: OK });
    f.t.execSync(spec());
    f.t.execSync(spec());
    const ids = f.calls().map(({ argv }) => argv[argv.indexOf("/opt/eval/envelope.mjs") + 1]);
    expect(new Set(ids).size).toBe(2);
  });
  it("names the exact production executable and endpoint", () => {
    expect(DOCKER_EXE).toBe("/Applications/Docker.app/Contents/Resources/bin/docker");
    expect(DOCKER_ENDPOINT).toBe("unix:///Users/amirshayegh/.docker/run/docker.sock");
  });
  it("removes the line and keeps the rest of stderr", () => {
    const f = fake({ stderr: "before\n", stdout: "out", line: OK });
    const r = f.t.execSync(spec());
    expect(r.stderr.toString()).toBe("before\n");
    expect(r.stdout.toString()).toBe("out");
  });
  it("a planted line for another exec stays evidence and proves nothing", () => {
    const f = fake({ lineId: "someone-else", line: OK, inspect: { State: { Running: true } } });
    const r = f.t.execSync(spec());
    expect(r.outcome).toBe("ambiguous");
    expect(r.child).toBeNull();
    expect(r.timedOut).toBeNull();
    expect(r.stdinAccepted).toBeNull();
    expect(r.stderr.toString()).toContain("someone-else");
  });
  it.each(["null", "[]", "7"])("a final line carrying %s is ambiguous with stderr kept, and does not throw", (raw) => {
    const f = fake({ stderr: "before\n", raw, inspect: { State: { Running: true } } });
    const r = f.t.execSync(spec());
    expect([r.outcome, r.child, r.timedOut]).toEqual(["ambiguous", null, null]);
    expect(r.stderr.toString()).toContain("before\n");
    expect(r.stderr.toString()).toContain(`EVAL-ENVELOPE`);
  });
  it("text after the line leaves the line unread", () => {
    const f = fake({ line: OK, after: "x\n", inspect: { State: { Running: true } } });
    expect(f.t.execSync(spec()).outcome).toBe("ambiguous");
  });
  it("a CLI status that disagrees is ambiguous, with both preserved", () => {
    const f = fake({ line: { ...OK, status: 3 }, status: 4 });
    const r = f.t.execSync(spec());
    expect([r.outcome, r.cliStatus, r.child?.status]).toEqual(["ambiguous", 4, 3]);
  });
  it("no line: running is ambiguous, stopped and missing are gone, failed inspect is ambiguous", () => {
    const s = spec();
    expect(fake({ status: 137, inspect: { State: { Running: true } } }).t.execSync(s).outcome).toBe("ambiguous");
    expect(fake({ status: 137, inspect: { State: { Running: false } } }).t.execSync(s).outcome).toBe("container-gone");
    expect(fake({ status: 1, inspectError: `Error: No such container: ${ID}` }).t.execSync(s).outcome).toBe("container-gone");
    expect(fake({ status: 1, inspectError: "Cannot connect to the Docker daemon" }).t.execSync(s).outcome).toBe("ambiguous");
  });
  it("marks and cuts what is over a limit", () => {
    const o = fake({ stdout: "x".repeat(50), line: OK }).t.execSync(spec({ stdoutLimit: 10 }));
    expect([o.overLimit, o.stdout.length]).toEqual(["stdout", 10]);
    const e = fake({ stderr: "y".repeat(50), line: OK }).t.execSync(spec({ stderrLimit: 10 }));
    expect([e.overLimit, e.stderr.length]).toEqual(["stderr", 10]);
    expect(fake({ stderr: "y".repeat(10), line: OK }).t.execSync(spec({ stderrLimit: 10 })).overLimit).toBeNull();
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
    const sync = t.execSync(spec());
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
    const sync = makeDockerTransport({ ...f.config, watchdogMarginSeconds: 0 }).execSync(spec({ timeoutSeconds: 1 }));
    expect([sync.cliStatus, sync.child, sync.outcome]).toEqual([null, null, "ambiguous"]);
    const stream = await makeDockerTransport({ ...f.config, watchdogMarginSeconds: 0 }).execStream(spec({ timeoutSeconds: 1 }), () => {});
    expect([stream.cliStatus, stream.child, stream.outcome]).toEqual([null, null, "ambiguous"]);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
  it("compares the daemon's id to the manifest's", () => {
    expect(fake({ daemon: "abc\n" }).t.daemonProblem("abc")).toBeNull();
    expect(fake({ daemon: "abc\n" }).t.daemonProblem("xyz")).toMatch(/not the manifest/);
    expect(fake({}).t.daemonProblem("abc")).toMatch(/did not answer/);
  });
  it("inspects by id and returns the document", () => {
    const f = fake({ inspect: { State: { Running: true }, Id: ID } });
    expect((f.t.inspect() as { Id: string }).Id).toBe(ID);
    expect(f.calls()[0]!.argv.slice(4)).toEqual(["inspect", "--type", "container", ID]);
  });
});
