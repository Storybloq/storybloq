/**
 * T-538 commit 2b (plan 5.5): the served-review request grammar, the stdin credential scan, the response shape
 * and the budget. The forwarding entry, the request collector and the server are held by their own rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardReview } from "../../scripts/eval-fault-mcp.js";
import {
  argvProblem, BUDGET_TEXT, NO_ANSWER_TEXT, REQUEST_NAME, ReviewBudget, reviewRequestProblems, reviewResponse, RUN_BUDGET, scanForCredentials, SERVED_BUDGET, STREAM_CAP_BYTES,
} from "../../scripts/onboarding-eval-review.js";

const SS = "SS-0123abcd";
const PROJECT = "/w/project";
const req = (over: Record<string, unknown> = {}, id = "123-1"): Buffer =>
  Buffer.from(JSON.stringify({ id, argv: ["run", "--setup", SS], stdinBase64: Buffer.from("plan").toString("base64"), cwd: PROJECT, ...over }));
const problem = (name: string, bytes: Buffer): string | null => {
  const r = reviewRequestProblems(name, bytes, PROJECT);
  return "problem" in r ? r.problem : null;
};

describe("the served shapes (5.5 grammar)", () => {
  it("serves exactly the plan's shapes", () => {
    for (const a of [
      ["gate"], ["gate", "--setup", SS], ["run", "--setup", SS], ["run", "--setup", SS, "--backend", "codex"],
      ["run", "--setup", SS, "--new-cycle", "--reason", "the owner changed the plan"],
      ["run", "--setup", SS, "--backend", "codex", "--new-cycle", "--reason", "x"],
      ["run", "--setup", SS, "--new-cycle", "--reason", "x", "--backend", "codex"],
      ["status", "--setup", SS], ["status", "--setup", SS, "--skipped"],
    ]) expect(argvProblem(a), a.join(" ")).toBeNull();
  });

  it("refuses every widening, each branch by name", () => {
    expect(argvProblem([])).toMatch(/is not served/);
    expect(argvProblem(["probe"])).toMatch(/"probe" is not served/);
    expect(argvProblem(["gate", "--setup"])).toMatch(/gate takes nothing or --setup/);
    expect(argvProblem(["gate", "--setup", "SS-XYZ"])).toMatch(/gate takes nothing or --setup/);
    expect(argvProblem(["gate", "--skipped"])).toMatch(/gate takes/);
    expect(argvProblem(["status"])).toMatch(/status needs --setup/);
    expect(argvProblem(["status", "--setup", SS, "--json"])).toMatch(/optionally --skipped/);
    expect(argvProblem(["status", "--setup", SS, "--skipped", "--skipped"])).toMatch(/optionally --skipped/);
    expect(argvProblem(["run"])).toMatch(/run needs --setup/);
    expect(argvProblem(["run", "--setup", "ss-0123abcd"])).toMatch(/run needs --setup/);
    expect(argvProblem(["run", "--setup", SS, "--backend", "claude"])).toMatch(/run does not take "--backend"/);
    expect(argvProblem(["run", "--setup", SS, "--backend", "codex", "--backend", "codex"])).toMatch(/run does not take "--backend"/);
    expect(argvProblem(["run", "--setup", SS, "--new-cycle"])).toMatch(/run does not take "--new-cycle"/);
    expect(argvProblem(["run", "--setup", SS, "--new-cycle", "--reason", "a\nb"])).toMatch(/no newline/);
    expect(argvProblem(["run", "--setup", SS, "--new-cycle", "--reason", ""])).toMatch(/1 to 500 characters/);
    expect(argvProblem(["run", "--setup", SS, "--new-cycle", "--reason", "x".repeat(501)])).toMatch(/1 to 500 characters/);
    expect(argvProblem(["run", "--setup", SS, "--new-cycle", "--reason", "x".repeat(500)])).toBeNull();
    expect(argvProblem(["run", "--setup", SS, "--new-cycle", "--reason", "x", "--new-cycle", "--reason", "y"])).toMatch(/run does not take "--new-cycle"/);
  });
});

describe("reviewRequestProblems", () => {
  it("accepts a well-formed request and returns it", () => {
    const r = reviewRequestProblems("123-1.json", req(), PROJECT);
    expect(r).toEqual({ request: { id: "123-1", argv: ["run", "--setup", SS], stdinBase64: Buffer.from("plan").toString("base64"), cwd: PROJECT } });
  });

  it("refuses a name that is not <pid>-<counter>.json, an id that differs from its name, and a path separator", () => {
    expect(REQUEST_NAME.test("123-1.json")).toBe(true);
    for (const n of [".123-1.tmp", "123-1.claimed", "../1-1.json", "1-1.json.json", "a-1.json", "12345678901-1.json", "1-1234567.json"]) expect(problem(n, req()), n).toMatch(/is not <pid>-<counter>\.json/);
    expect(problem("123-1.json", req({}, "123-2"))).toBe("the request's id is not its file name");
    expect(problem("123-1.json", req({}, "../123-1"))).toBe("the request's id is not its file name");
  });

  it("refuses non-JSON, extra or missing keys, and a non-string field", () => {
    expect(problem("1-1.json", Buffer.from("{"))).toBe("the request is not JSON");
    expect(problem("1-1.json", Buffer.from("[]"))).toBe("the request is not an object");
    expect(problem("1-1.json", req({ extra: 1 }, "1-1"))).toMatch(/exactly id, argv, stdinBase64 and cwd/);
    const missing = JSON.parse(req({}, "1-1").toString()) as Record<string, unknown>;
    delete missing.cwd;
    expect(problem("1-1.json", Buffer.from(JSON.stringify(missing)))).toMatch(/exactly id, argv/);
    expect(problem("1-1.json", req({ id: 1 }, "1-1"))).toBe("the request's id is not its file name");
    expect(problem("1-1.json", req({ argv: "run" }, "1-1"))).toMatch(/argv must be/);
    expect(problem("1-1.json", req({ argv: ["run", 1] }, "1-1"))).toMatch(/argv must be/);
    expect(problem("1-1.json", req({ argv: Array(9).fill("gate") }, "1-1"))).toMatch(/argv must be at most 8/);
    expect(problem("1-1.json", req({ argv: ["gate", "x".repeat(601)] }, "1-1"))).toMatch(/at most 600 characters/);
    expect(problem("1-1.json", req({ stdinBase64: 5 }, "1-1"))).toBe("stdinBase64 is not a string");
    expect(problem("1-1.json", req({ stdinBase64: "%%%%" }, "1-1"))).toBe("stdinBase64 is not base64");
    expect(problem("1-1.json", req({ cwd: 5 }, "1-1"))).toBe("cwd is not a string");
  });

  it("refuses a cwd other than the project, a grammar violation, and over-large stdin or file", () => {
    expect(problem("1-1.json", req({ cwd: "/w/project/sub" }, "1-1"))).toBe("cwd is not the project root");
    expect(problem("1-1.json", req({ argv: ["run", "--setup", SS, "--backend", "claude"] }, "1-1"))).toMatch(/run does not take/);
    expect(problem("1-1.json", req({ stdinBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64") }, "1-1"))).toMatch(/decoded stdin is over/);
    expect(problem("1-1.json", Buffer.alloc(2 * 1024 * 1024 + 1, 32))).toMatch(/over 2097152 bytes/);
  });
});

describe("the stdin credential scan (5.9, over the served stdin)", () => {
  it("finds each form by offset and name, never by value", () => {
    const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    const text = `ok ${jwt} sk-ant-${"x".repeat(20)} rt_${"y".repeat(20)} "refresh_token": "${"z".repeat(24)}" tail`;
    const hits = scanForCredentials(Buffer.from(text));
    expect(hits.map((h) => h.pattern)).toEqual(expect.arrayContaining(["jwt", "sk-ant-", "rt_", "token key"]));
    expect(hits[0]!.offset).toBe(3);
    for (const h of hits) expect(Object.keys(h).sort()).toEqual(["offset", "pattern"]);
  });

  it("finds a held secret by exact value, and a clean packet has no hit", () => {
    expect(scanForCredentials(Buffer.from("plan with secret-value-123 inside"), ["secret-value-123"])).toEqual([{ offset: 10, pattern: "held secret" }]);
    expect(scanForCredentials(Buffer.from("## Plan\nTicket: Sign in\nsk-short\n"), ["absent"])).toEqual([]);
  });
});

describe("the response and the budget", () => {
  it("caps each stream at 1 MiB and says so", () => {
    const r = reviewResponse("1-1", 0, Buffer.from("out"), Buffer.from("err"));
    expect(r).toEqual({ id: "1-1", exit: 0, stdoutBase64: Buffer.from("out").toString("base64"), stderrBase64: Buffer.from("err").toString("base64"), truncated: false });
    const big = reviewResponse("1-2", 1, Buffer.alloc(STREAM_CAP_BYTES + 5, 97), Buffer.alloc(0));
    expect(Buffer.from(big.stdoutBase64, "base64").length).toBe(STREAM_CAP_BYTES);
    expect(big.truncated).toBe(true);
  });

  it("charges 16 served and 6 run, the next refused", () => {
    const b = new ReviewBudget();
    for (let i = 0; i < RUN_BUDGET; i++) expect(b.charge("run")).toBe(true);
    expect(b.charge("run")).toBe(false);
    for (let i = RUN_BUDGET; i < SERVED_BUDGET; i++) expect(b.charge("status")).toBe(true);
    expect(b.charge("gate")).toBe(false);
    expect(BUDGET_TEXT).toBe("setup-review: the evaluation's review budget is spent");
    expect(NO_ANSWER_TEXT).toBe("setup-review: the harness did not answer");
  });
});

describe("the cli entry forwards setup-review (forwardReview)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const setup = () => {
    const d = mkdtempSync(join(tmpdir(), "t538-2b-fwd-"));
    dirs.push(d);
    mkdirSync(join(d, "eval-events"));
    mkdirSync(join(d, "responses"));
    return { d, events: join(d, "eval-events", "events.jsonl"), responses: join(d, "responses"), requests: join(d, "eval-events", "review-requests") };
  };
  const io = (onSleep: () => void, waitMs = 1000) => {
    let t = 0;
    return { pid: 4242, cwd: PROJECT, stdin: Buffer.from("plan bytes"), waitMs, pollMs: 250, now: () => t, sleep: (ms: number) => { t += ms; onSleep(); } };
  };

  it("publishes a request the harness grammar accepts, then returns the answer's streams and exit code", () => {
    const p = setup();
    let seen: string[] = [];
    const r = forwardReview(["run", "--setup", SS], p.events, p.responses, io(() => {
      seen = readdirSync(p.requests);
      const name = seen[0]!;
      const id = name.slice(0, -5);
      expect(reviewRequestProblems(name, readFileSync(join(p.requests, name)), PROJECT)).toEqual({ request: { id, argv: ["run", "--setup", SS], stdinBase64: Buffer.from("plan bytes").toString("base64"), cwd: PROJECT } });
      writeFileSync(join(p.responses, `${id}.json`), JSON.stringify(reviewResponse(id, 3, Buffer.from("served out"), Buffer.from("served err"))));
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^4242-[0-9]+\.json$/);
    expect(r).toEqual({ stdout: Buffer.from("served out"), stderr: Buffer.from("served err"), exit: 3 });
  });

  it("with no response folder, or no answer in time, or an answer for another id, it is the harness's no-answer, exit 70", () => {
    const p = setup();
    const none = { stdout: Buffer.alloc(0), stderr: Buffer.from(`${NO_ANSWER_TEXT}\n`), exit: 70 };
    expect(forwardReview(["gate"], p.events, undefined, io(() => {}))).toEqual(none);
    expect(existsSync(p.requests)).toBe(false);
    expect(forwardReview(["gate"], p.events, p.responses, io(() => {}, 1000))).toEqual(none);
    expect(readdirSync(p.requests)).toHaveLength(1);
    const r = forwardReview(["gate"], p.events, p.responses, io(() => {
      for (const n of readdirSync(p.requests)) writeFileSync(join(p.responses, n), JSON.stringify(reviewResponse("1-1", 0, Buffer.from("x"), Buffer.alloc(0))));
    }));
    expect(r).toEqual(none);
  });
});
