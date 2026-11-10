/**
 * T-538 commit 2b (plan 5.5): the request collector's `requests` mode and the harness's review server, with a
 * stand-in for the served command. The real CLI path is held by the end-to-end rows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStream, EXIT_CREDENTIAL as F10_EXIT_CREDENTIAL, scanForCredentials as f10Scan, STREAM_CAP_BYTES as F10_CAP, STREAM_HITS_MAX } from "../../scripts/onboarding-eval-review.js";
import { serveReviewCommand } from "../../scripts/onboarding-eval-run.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { FOLDER_CHANGED, LISTING_LIMIT, pollRequests, pollSeams, requestsWorker, UNCLAIMED_LIMIT } from "../../scripts/onboarding-eval-collect.js";
import { BUDGET_TEXT, EXIT_BUDGET, POLL_UNANSWERED, QUEUE_BYTES, QUEUE_FULL_TEXT, RUN_BUDGET, ReviewBudget, ReviewServer, SERVED_BUDGET, ReviewTurn, sha256, WORKER_EXITED, type ServeCommand, type ServedLine } from "../../scripts/onboarding-eval-review.js";
import { SERVED_CREDENTIAL, servedRecordProblems, UNSERVED_RECORD } from "../../scripts/onboarding-eval-checkset6.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(PKG, "node_modules", "tsx", "dist", "cli.mjs");
const COLLECT = join(PKG, "scripts", "onboarding-eval-collect.ts");

const SS = "SS-0123abcd";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "t538-2b-srv-")); dirs.push(d); return d; };
const body = (id: string, argv: string[] = ["run", "--setup", SS], stdin = "## Plan\nTicket: Sign in\n", cwd = "/w/project"): string =>
  JSON.stringify({ id, argv, stdinBase64: Buffer.from(stdin).toString("base64"), cwd });

describe("the collector's requests mode (5.8)", () => {
  it("lists final names only, drops claimed ids, orders by pid then counter, and reads each one", () => {
    const d = scratch();
    for (const [n, t] of [["9-2.json", body("9-2")], ["9-10.json", body("9-10")], ["10-1.json", body("10-1")], [".9-3.tmp", "x"], ["9-1.claimed", ""], ["notes.txt", "x"], ["8-1.json", body("8-1")]] as const) writeFileSync(join(d, n), t);
    const r = pollRequests(d, new Set(["8-1"]));
    expect("entries" in r && r.entries.map((e) => e.id)).toEqual(["9-2", "9-10", "10-1"]);
    expect("entries" in r && Buffer.from((r.entries[0] as { bytes: string }).bytes, "base64").toString()).toBe(body("9-2"));
    expect("ignored" in r && r.ignored).toEqual(["9-1.claimed", "notes.txt"]);
    expect(pollRequests(join(d, "missing"), new Set())).toEqual({ entries: [], ignored: [] });
    writeFileSync(join(d, "file"), "");
    expect(pollRequests(join(d, "file"), new Set())).toEqual({ failure: "review requests: the folder is not a directory" });
  });

  it("F3: the folder swapped for a link between its listing and its reads is a folder failure, and the outside file is never returned", () => {
    const d = scratch();
    const req = join(d, "req");
    const outside = join(d, "outside");
    mkdirSync(req);
    mkdirSync(outside);
    writeFileSync(join(req, "1-1.json"), body("1-1"));
    writeFileSync(join(outside, "1-1.json"), body("1-1", ["gate"], "outside-bytes"));
    const cwd = process.cwd();
    pollSeams.afterListing = () => { renameSync(req, join(d, "req-moved")); symlinkSync(outside, req); };
    try {
      expect(pollRequests(req, new Set())).toEqual({ failure: FOLDER_CHANGED });
    } finally {
      pollSeams.afterListing = () => {};
    }
    expect(process.cwd()).toBe(cwd);
    // The link itself, polled afresh, is not a directory.
    expect(pollRequests(req, new Set())).toEqual({ failure: "review requests: the folder is not a directory" });
  });

  it("F3: the folder swapped for a link after its anchoring lstat and before the chdir is a folder failure, and the outside file is never returned", () => {
    const d = scratch();
    const req = join(d, "req");
    const outside = join(d, "outside");
    mkdirSync(req);
    mkdirSync(outside);
    writeFileSync(join(req, "1-1.json"), body("1-1"));
    writeFileSync(join(outside, "1-1.json"), body("1-1", ["gate"], "outside-bytes"));
    const cwd = process.cwd();
    pollSeams.beforeChdir = () => { renameSync(req, join(d, "req-moved")); symlinkSync(outside, req); };
    // Swapped back before the closing check, so only the check after the chdir can see the swap.
    pollSeams.afterListing = () => { rmSync(req); renameSync(join(d, "req-moved"), req); };
    try {
      expect(pollRequests(req, new Set())).toEqual({ failure: FOLDER_CHANGED });
    } finally {
      pollSeams.beforeChdir = () => {};
      pollSeams.afterListing = () => {};
    }
    expect(process.cwd()).toBe(cwd);
  });

  it("refuses a link, a FIFO and a 3 MiB file per entry, without blocking", () => {
    const d = scratch();
    writeFileSync(join(d, "target"), body("1-1"));
    symlinkSync(join(d, "target"), join(d, "1-1.json"));
    expect(spawnSync("/usr/bin/mkfifo", [join(d, "1-2.json")]).status).toBe(0);
    writeFileSync(join(d, "1-3.json"), Buffer.alloc(3 * 1024 * 1024, 32));
    const t = Date.now();
    const r = pollRequests(d, new Set());
    expect(Date.now() - t).toBeLessThan(5000);
    expect("entries" in r && r.entries).toEqual([
      { id: "1-1", problem: "the request is a link" },
      { id: "1-2", problem: "the request is not a regular file" },
      { id: "1-3", problem: "the request is over 2097152 bytes" },
    ]);
  });

  it(`holds ${UNCLAIMED_LIMIT} unclaimed requests beside temporaries and claimed files; the next one, or a listing past ${LISTING_LIMIT}, is a folder failure`, () => {
    const d = scratch();
    for (let i = 1; i <= UNCLAIMED_LIMIT; i++) writeFileSync(join(d, `1-${i}.json`), body(`1-${i}`));
    for (let i = 1; i <= 100; i++) writeFileSync(join(d, `.2-${i}.tmp`), "x");
    for (let i = 1; i <= 100; i++) writeFileSync(join(d, `3-${i}.json`), body(`3-${i}`));
    const claimed = new Set(Array.from({ length: 100 }, (_, i) => `3-${i + 1}`));
    const ok = pollRequests(d, claimed);
    expect("entries" in ok && ok.entries).toHaveLength(UNCLAIMED_LIMIT);
    writeFileSync(join(d, "4-1.json"), body("4-1"));
    expect(pollRequests(d, claimed)).toEqual({ failure: `review requests: more than ${UNCLAIMED_LIMIT} unclaimed requests are present` });
    const big = scratch();
    for (let i = 0; i <= LISTING_LIMIT; i++) writeFileSync(join(big, `.${i}.tmp`), "");
    expect(pollRequests(big, new Set())).toEqual({ failure: `review requests: the listing passes ${LISTING_LIMIT} entries` });
  });

  it("the worker answers each poll line with one result line", async () => {
    const d = scratch();
    writeFileSync(join(d, "5-1.json"), body("5-1"));
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (c) => lines.push(...String(c).split("\n").filter(Boolean)));
    const done = requestsWorker(d, input, output);
    input.write(`${JSON.stringify({ claimed: [] })}\n`);
    input.write(`${JSON.stringify({ claimed: ["5-1"] })}\n`);
    input.end();
    await done;
    expect(lines.map((l) => (JSON.parse(l) as { entries: { id: string }[] }).entries.map((e) => e.id))).toEqual([["5-1"], []]);
  });
});

describe("the review server (5.5)", () => {
  const setup = (serve: ServeCommand, secrets: string[] = [], onStreams?: (s: { readonly stdout: CredentialStream; readonly stderr: CredentialStream }) => void, deadline = 1000) => {
    const d = scratch();
    const p = { requests: join(d, "eval-events", "review-requests"), responses: join(d, "review-responses"), store: join(d, "store") };
    for (const x of Object.values(p)) mkdirSync(x, { recursive: true });
    const log: ServedLine[] = [];
    const server = new ReviewServer({ ...p, project: "/w/project", budget: new ReviewBudget(), secrets, deadlineMs: () => deadline, serve, log: (l) => log.push(l), ...(onStreams !== undefined ? { onStreams } : {}) });
    const put = (id: string, text: string): void => writeFileSync(join(p.requests, `${id}.json`), text);
    const offer = (): void => { const r = pollRequests(p.requests, new Set(server.claimedIds())); if ("entries" in r) server.offer(r.entries); };
    const response = (id: string) => JSON.parse(readFileSync(join(p.responses, `${id}.json`), "utf-8")) as { exit: number; stdoutBase64: string; stderrBase64: string };
    return { d, p, server, log, put, offer, response };
  };
  const ok: ServeCommand = async (args, stdin) => ({ exit: 0, stdout: Buffer.from(`served ${args.join(" ")} ${stdin.length}`), stderr: Buffer.alloc(0), cleanup: "confirmed", timedOut: false });
  const F10_FORM = `sk-ant-${"a".repeat(24)}`;

  it("F10: a credential crossing the capture boundary, which truncation would drop, is refused", async () => {
    const pad = Buffer.alloc(F10_CAP - 10, 0x78);
    const s = setup(async (_args, _stdin, _ms, _setStop, watch) => {
      watch(Buffer.concat([pad, Buffer.from(F10_FORM.slice(0, 10))]), "stdout");
      watch(Buffer.from(F10_FORM.slice(10)), "stdout");
      const kept = Buffer.concat([pad, Buffer.from(F10_FORM)]).subarray(0, F10_CAP + 1);
      expect(f10Scan(kept)).toEqual([]);
      return { exit: 0, stdout: kept, stderr: Buffer.alloc(0), cleanup: "confirmed", timedOut: false };
    });
    s.put("9-1", body("9-1"));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(s.response("9-1").exit).toBe(F10_EXIT_CREDENTIAL);
    expect(Buffer.from(s.response("9-1").stdoutBase64, "base64").length).toBe(0);
    expect(Buffer.from(s.response("9-1").stderrBase64, "base64").toString()).toContain("the reviewer's output carries a credential form (sk-ant-)");
  });

  it("H2: a reviewer printing many distinct credential forms is stopped at the first, and the scan keeps nothing more after it", async () => {
    const forms = Array.from({ length: 500 }, (_, i) => `sk-ant-${String(i).padStart(4, "0")}${"b".repeat(24)}\n`);
    let streams: { readonly stdout: CredentialStream; readonly stderr: CredentialStream } | null = null;
    const events: string[] = [];
    let sizeAtStop: { hits: number; carry: number } | null = null;
    const s = setup(async (_args, _stdin, _ms, setStop, watch) => {
      let stopped = false;
      setStop(() => { stopped = true; events.push("stop"); sizeAtStop = streams!.stdout.size(); });
      for (const [i, f] of forms.entries()) {
        watch(Buffer.from(f), "stdout");
        events.push(`chunk ${i}`);
        if (stopped && i >= 3) break;
      }
      return { exit: 0, stdout: Buffer.from(forms.slice(0, 4).join("")), stderr: Buffer.alloc(0), cleanup: "confirmed", timedOut: false };
    }, [], (st) => { streams = st; });
    s.put("9-1", body("9-1"));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    // The stop came inside the first chunk's watch call, before the reviewer wrote a second.
    expect(events.slice(0, 2)).toEqual(["stop", "chunk 0"]);
    expect(sizeAtStop).not.toBeNull();
    expect(streams!.stdout.size()).toEqual(sizeAtStop);
    expect(streams!.stdout.hits().length).toBeLessThanOrEqual(2);
    expect(s.response("9-1").exit).toBe(F10_EXIT_CREDENTIAL);
    expect(Buffer.from(s.response("9-1").stdoutBase64, "base64").length).toBe(0);
  });

  it("H2: the real serve command is stopped on the first hit, its cleanup awaited, and answered exit 65", async () => {
    const d = scratch();
    const cli = join(d, "cli.mjs");
    const after = join(d, "after");
    // Prints one credential form, then would write a marker 4 s later: only a stop on the first hit prevents it.
    writeFileSync(cli, `import { writeFileSync } from "node:fs";\nprocess.stdout.write(${JSON.stringify(F10_FORM)} + "\\n");\nsetTimeout(() => writeFileSync(${JSON.stringify(after)}, "x"), 4000);\n`);
    const s = setup(serveReviewCommand(cli, d, { PATH: "/usr/bin:/bin" }), [], undefined, 20_000);
    const t0 = Date.now();
    s.put("9-1", body("9-1"));
    s.offer();
    await s.server.idle();
    const ms = Date.now() - t0;
    expect(await s.server.stop()).toBe("confirmed");
    expect(s.response("9-1").exit).toBe(F10_EXIT_CREDENTIAL);
    expect(ms).toBeLessThan(3000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(after)).toBe(false);
  });

  it("H2: a credential stream keeps at most STREAM_HITS_MAX hits however many distinct forms pass through it", () => {
    const stream = new CredentialStream();
    for (let i = 0; i < 1000; i++) stream.push(Buffer.from(`sk-ant-${String(i).padStart(4, "0")}${"c".repeat(24)}\n`));
    expect(stream.size().hits).toBe(STREAM_HITS_MAX);
    expect(stream.hits()[0]).toEqual({ offset: 0, pattern: "sk-ant-" });
  });

  it("F10: the real serve command shows every chunk to the scan before its cap", async () => {
    const d = scratch();
    const cli = join(d, "cli.mjs");
    writeFileSync(cli, `process.stdout.write("x".repeat(${F10_CAP - 10}) + ${JSON.stringify(F10_FORM)});\n`);
    const stream = new CredentialStream();
    const r = await serveReviewCommand(cli, d, { PATH: "/usr/bin:/bin" })(["run"], Buffer.alloc(0), 30_000, () => {}, (c, which) => { if (which === "stdout") stream.push(c); });
    expect(r.exit).toBe(0);
    expect(r.stdout.length).toBe(F10_CAP + 1);
    expect(f10Scan(r.stdout)).toEqual([]);
    expect(stream.hits()).toEqual([{ offset: F10_CAP - 10, pattern: "sk-ant-" }, { offset: F10_CAP - 10, pattern: "sk-" }]);
  });

  it("serves a valid request: the command's output byte for byte, the record it published, and the request file deleted", async () => {
    const s = setup(async (args, stdin, ms) => {
      mkdirSync(join(s.p.store, "pk", SS, "records", "r1"), { recursive: true });
      writeFileSync(join(s.p.store, "pk", SS, "records", "r1", "record.json"), JSON.stringify({ setupId: SS, cycle: 1, recordId: "r1", revisionSha256: sha256(stdin), state: "completed" }));
      return { exit: 0, stdout: Buffer.from(`out ${args.join(" ")} ${ms}`), stderr: Buffer.from("err"), cleanup: "confirmed", timedOut: false };
    });
    s.put("7-1", body("7-1"));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(Buffer.from(s.response("7-1").stdoutBase64, "base64").toString()).toBe(`out run --setup ${SS} 1000`);
    expect(s.response("7-1").exit).toBe(0);
    expect(existsSync(join(s.p.requests, "7-1.json"))).toBe(false);
    expect(s.log).toHaveLength(1);
    expect(s.log[0]).toMatchObject({ id: "7-1", argv: ["run", "--setup", SS], exit: 0, stdinSha256: sha256("## Plan\nTicket: Sign in\n") });
    expect(s.log[0]!.published).toEqual([{ setupId: SS, cycle: 1, recordId: "r1", packetSha256: sha256("## Plan\nTicket: Sign in\n"), files: { [`pk/${SS}/records/r1/record.json`]: expect.stringMatching(/^[0-9a-f]{64}$/) } }]);
  });

  it("F4: a flood while a served command runs is answered at once past the budget or the queue limit, and the queue never holds more than its limit", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const s = setup(async (...a) => { await held; return ok(...a); });
    s.put("1-1", body("1-1"));
    s.offer();
    const big = "x".repeat(900 * 1024);
    const flood = Array.from({ length: 40 }, (_, i) => `2-${i + 1}`);
    for (const id of flood) s.put(id, body(id, ["gate"], big));
    s.offer();
    // The served command is still running: nothing waits that the budget refused or the queue could not hold.
    expect(s.server.retainedBytes()).toBeLessThanOrEqual(QUEUE_BYTES);
    const waiting = flood.filter((id) => !existsSync(join(s.p.responses, `${id}.json`)));
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.length).toBeLessThan(SERVED_BUDGET - 1);
    const answered = flood.filter((id) => !waiting.includes(id));
    const overBudget = flood.slice(SERVED_BUDGET - 1);
    for (const id of overBudget) {
      expect(s.response(id).exit, id).toBe(EXIT_BUDGET);
      expect(Buffer.from(s.response(id).stderrBase64, "base64").toString(), id).toBe(`${BUDGET_TEXT}\n`);
    }
    for (const id of answered.filter((x) => !overBudget.includes(x))) {
      expect(s.response(id).exit, id).toBe(64);
      expect(Buffer.from(s.response(id).stderrBase64, "base64").toString(), id).toBe(`${QUEUE_FULL_TEXT}\n`);
    }
    release();
    await s.server.idle();
    await s.server.stop();
    expect(s.server.retainedBytes()).toBe(0);
    for (const id of ["1-1", ...flood]) expect(existsSync(join(s.p.responses, `${id}.json`)), id).toBe(true);
  });

  it("refuses a grammar violation, a wrong id and a non-string field with exit 64, creating nothing outside the response folder", async () => {
    let calls = 0;
    const s = setup(async (...a) => { calls++; return ok(...a); });
    s.put("1-1", body("1-1", ["run", "--setup", SS, "--backend", "claude"]));
    s.put("1-2", body("1-3"));
    s.put("1-4", JSON.stringify({ id: "1-4", argv: ["gate"], stdinBase64: 5, cwd: "/w/project" }));
    s.put("1-5", body("1-5", ["gate"], "", "/elsewhere"));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(calls).toBe(0);
    for (const id of ["1-1", "1-2", "1-4", "1-5"]) expect(s.response(id).exit, id).toBe(64);
    expect(Buffer.from(s.response("1-2").stderrBase64, "base64").toString()).toMatch(/id is not its file name/);
    expect(readdirSync(s.d).sort()).toEqual(["eval-events", "review-responses", "store"]);
    expect(s.log.every((l) => l.refused !== undefined)).toBe(true);
  });

  it("claims an id once: a request left in place, or rewritten after its claim, is never served again", async () => {
    let calls = 0;
    const s = setup(async (...a) => { calls++; return ok(...a); });
    s.put("2-1", body("2-1", ["gate"]));
    s.offer();
    s.put("2-1", body("2-1", ["run", "--setup", SS]));
    s.offer();
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(calls).toBe(1);
    expect(s.log.map((l) => l.argv)).toEqual([["gate"]]);
  });

  it("serves two requests at once one after the other, in claim order", async () => {
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const s = setup(async (args, stdin) => {
      running++; most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 30));
      order.push(args[0]!);
      running--;
      return ok(args, stdin, 0, () => {}, () => {});
    });
    s.put("3-1", body("3-1", ["gate"]));
    s.put("3-2", body("3-2", ["status", "--setup", SS]));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(most).toBe(1);
    expect(order).toEqual(["gate", "status"]);
  });

  it("a packet carrying a credential form never reaches the reviewer: exit 65 and the attempt is marked", async () => {
    let calls = 0;
    const s = setup(async (...a) => { calls++; return ok(...a); }, ["held-secret-value"]);
    s.put("4-1", body("4-1", ["run", "--setup", SS], `plan sk-ant-${"x".repeat(30)}`));
    s.put("4-2", body("4-2", ["run", "--setup", SS], "plan held-secret-value"));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(calls).toBe(0);
    expect(s.response("4-1").exit).toBe(65);
    expect(s.response("4-2").exit).toBe(65);
    expect(s.server.credential).toEqual({ id: "4-1", hit: { offset: 5, pattern: "sk-ant-" } });
    expect(JSON.stringify(s.log)).not.toContain("held-secret-value");
  });

  it("P2: a credential form in --reason never reaches the reviewer: exit 65, the attempt is marked, and the log carries no argv", async () => {
    let calls = 0;
    const s = setup(async (...a) => { calls++; return ok(...a); }, ["held-secret-value"]);
    s.put("4-3", body("4-3", ["run", "--setup", SS, "--new-cycle", "--reason", `retry rt_${"y".repeat(20)}`]));
    s.put("4-4", body("4-4", ["run", "--setup", SS, "--new-cycle", "--reason", "retry held-secret-value"]));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(calls).toBe(0);
    expect(s.response("4-3").exit).toBe(65);
    expect(s.response("4-4").exit).toBe(65);
    expect(Buffer.from(s.response("4-3").stderrBase64, "base64").toString()).toBe("setup-review: refused: the arguments carry a credential form (rt_ in argument 6 at byte 6)\n");
    expect(s.server.credential).toEqual({ id: "4-3", hit: { offset: 6, pattern: "rt_" } });
    expect(JSON.stringify(s.log)).not.toMatch(/held-secret-value|rt_y/);
    expect(s.log.map((l) => l.argv)).toEqual([null, null]);
  });

  it("5.9: a reviewer whose output carries a credential form is answered 65 with none of its output, and the attempt is marked", async () => {
    const s = setup(async () => ({ exit: 0, stdout: Buffer.from(`verdict ok rt_${"z".repeat(20)}\n`), stderr: Buffer.alloc(0), cleanup: "confirmed" as const, timedOut: false }));
    s.put("4-5", body("4-5", ["run", "--setup", SS]));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(s.response("4-5").exit).toBe(65);
    expect(Buffer.from(s.response("4-5").stdoutBase64, "base64").length).toBe(0);
    expect(Buffer.from(s.response("4-5").stderrBase64, "base64").toString()).toBe("setup-review: refused: the reviewer's output carries a credential form (rt_)\n");
    expect(s.server.credential).toEqual({ id: "4-5", hit: { offset: 11, pattern: "rt_" } });
    expect(JSON.stringify(s.log)).not.toContain("rt_zz");
  });

  it(`the ${RUN_BUDGET + 1}th run is refused with exit 75, charged at the claim`, async () => {
    let calls = 0;
    const s = setup(async (...a) => { calls++; return ok(...a); });
    for (let i = 1; i <= RUN_BUDGET + 1; i++) s.put(`5-${i}`, body(`5-${i}`));
    s.offer();
    await s.server.idle();
    await s.server.stop();
    expect(calls).toBe(RUN_BUDGET);
    expect(s.response(`5-${RUN_BUDGET + 1}`).exit).toBe(75);
    expect(Buffer.from(s.response(`5-${RUN_BUDGET + 1}`).stderrBase64, "base64").toString()).toBe("setup-review: the evaluation's review budget is spent\n");
  });

  it("a turn that ends mid-review stops the served command and waits for it; a request still queued is answered 70 unserved", async () => {
    let stopped = false;
    let calls = 0;
    const s = setup((args, stdin, ms, setStop) => new Promise((resolve) => {
      calls++;
      setStop(() => { stopped = true; resolve({ exit: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cleanup: "confirmed", timedOut: false }); });
    }));
    s.put("6-1", body("6-1"));
    s.put("6-2", body("6-2", ["gate"]));
    s.offer();
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.server.stop()).toBe("confirmed");
    expect(stopped).toBe(true);
    expect(s.response("6-1").exit).toBe(70);
    expect(calls).toBe(1);
    expect(s.response("6-2").exit).toBe(70);
    expect(Buffer.from(s.response("6-2").stderrBase64, "base64").toString()).toBe("setup-review: the harness did not answer\n");
  });
});

describe("one turn's review side: the collector worker polled and its entries served (5.5, 5.8)", () => {
  const rig = (worker?: { command: string; args: string[] }) => {
    const d = scratch();
    const p = { requests: join(d, "eval-events", "review-requests"), responses: join(d, "review-responses"), store: join(d, "store") };
    for (const x of Object.values(p)) mkdirSync(x, { recursive: true });
    const served: string[] = [];
    const server = new ReviewServer({ ...p, project: "/w/project", budget: new ReviewBudget(), secrets: [], deadlineMs: () => 1000, log: () => {},
      serve: async (args, stdin) => { served.push(args[0]!); return { exit: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0), cleanup: "confirmed", timedOut: false }; } });
    const failures: string[] = [];
    const turn = new ReviewTurn({
      server, timeoutMs: 120_000, pollMs: 50, answerMs: 1500, onFailure: (f) => failures.push(f),
      worker: { ...(worker ?? { command: process.execPath, args: [TSX, COLLECT, "requests", p.requests] }), cwd: d, env: { PATH: process.env.PATH ?? "", HOME: d, TMPDIR: d } },
    });
    const until = async (ok: () => boolean, ms = 20_000): Promise<void> => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };
    return { d, p, server, served, failures, turn, until, put: (id: string, text: string) => writeFileSync(join(p.requests, `${id}.json`), text) };
  };

  it("serves a request through the real worker, and keeps serving after the clock passes five minutes into the turn", async () => {
    const r = rig();
    r.put("8-1", body("8-1", ["gate"]));
    await r.until(() => r.served.length === 1);
    expect(r.served).toEqual(["gate"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      r.put("8-2", body("8-2", ["status", "--setup", SS]));
      await r.until(() => r.served.length === 2);
    } finally {
      vi.useRealTimers();
    }
    expect(r.served).toEqual(["gate", "status"]);
    const end = await r.turn.end();
    expect(end).toEqual({ failure: null, cleanup: "confirmed", cleanupDetail: null });
    expect(r.failures).toEqual([]);
  }, 60_000);

  it("a folder-wide failure from the worker ends the turn under its own name", async () => {
    const r = rig();
    for (let i = 1; i <= 65; i++) r.put(`9-${i}`, body(`9-${i}`, ["gate"]));
    await r.until(() => r.failures.length > 0);
    expect(r.failures).toEqual(["review requests: more than 64 unclaimed requests are present"]);
    expect((await r.turn.end()).failure).toBe("review requests: more than 64 unclaimed requests are present");
    expect(r.served).toEqual([]);
  }, 60_000);

  it(`a worker that never answers a poll ends the turn as "${POLL_UNANSWERED}", and is stopped`, async () => {
    const r = rig({ command: process.execPath, args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"] });
    await r.until(() => r.failures.length > 0);
    expect(r.failures).toEqual([POLL_UNANSWERED]);
    const end = await r.turn.end();
    expect(end.failure).toBe(POLL_UNANSWERED);
    expect(end.cleanup).toBe("confirmed");
  }, 60_000);

  it(`a worker that exits ends the turn as "${WORKER_EXITED}"`, async () => {
    const r = rig({ command: process.execPath, args: ["-e", "process.exit(0)"] });
    await r.until(() => r.failures.length > 0);
    expect(r.failures).toEqual([WORKER_EXITED]);
    expect((await r.turn.end()).failure).toBe(WORKER_EXITED);
  }, 60_000);
});

describe("check set 6: every completed record traced to the served run that produced it (5.5)", () => {
  const PACKET = "## Plan\nTicket: Sign in\n";
  const plant = (store: string, rec: Record<string, unknown>): { path: string; sha: string } => {
    // The product's layout: records/<record id>/record.json.
    const dir = join(store, "pk", SS, "records", String(rec.recordId));
    mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(rec);
    writeFileSync(join(dir, "record.json"), text);
    return { path: `pk/${SS}/records/${String(rec.recordId)}/record.json`, sha: sha256(text) };
  };
  const line = (over: Partial<ServedLine> & { published: ServedLine["published"] }): ServedLine => ({
    id: "1-1", argv: ["run", "--setup", SS], stdinSha256: sha256(PACKET), exit: 0, stdoutSha256: sha256(""), stderrSha256: sha256(""), start: "s", end: "e", ...over,
  });
  const record = { setupId: SS, cycle: 1, recordId: "r1", revisionSha256: sha256(PACKET), state: "completed" };

  it("a record a served run published passes; the same record with no producing line fails by name", () => {
    const store = scratch();
    const f = plant(store, record);
    const ok = line({ published: [{ setupId: SS, cycle: 1, recordId: "r1", packetSha256: sha256(PACKET), files: { [f.path]: f.sha } }] });
    expect(servedRecordProblems(store, [ok], false)).toEqual([]);
    expect(servedRecordProblems(store, [], false)).toEqual([`${UNSERVED_RECORD}: ${f.path}`]);
  });

  it("a producing line that is not a run, did not exit 0, carries another packet or another file hash, or appears twice, fails", () => {
    const store = scratch();
    const f = plant(store, record);
    const pub = { setupId: SS, cycle: 1, recordId: "r1", packetSha256: sha256(PACKET), files: { [f.path]: f.sha } };
    for (const bad of [
      [line({ argv: ["status", "--setup", SS], published: [pub] })],
      [line({ exit: 1, published: [pub] })],
      [line({ stdinSha256: sha256("other"), published: [pub] })],
      [line({ published: [{ ...pub, files: { [f.path]: sha256("x") } }] })],
      [line({ published: [pub] }), line({ id: "1-2", published: [pub] })],
    ]) expect(servedRecordProblems(store, bad, false), JSON.stringify(bad)).toEqual([`${UNSERVED_RECORD}: ${f.path}`]);
  });

  it("a failed record needs no producer; in the reviewer-unavailable arm any completed record fails", () => {
    const store = scratch();
    plant(store, { ...record, recordId: "r0", state: "failed" });
    expect(servedRecordProblems(store, [], false)).toEqual([]);
    const f = plant(store, record);
    const pub = { setupId: SS, cycle: 1, recordId: "r1", packetSha256: sha256(PACKET), files: { [f.path]: f.sha } };
    expect(servedRecordProblems(store, [line({ published: [pub] })], true)).toEqual([`a completed review record in the reviewer-unavailable arm: ${f.path}`]);
  });

  it("a request refused for a credential form fails the run as invalid", () => {
    const store = scratch();
    expect(servedRecordProblems(store, [line({ exit: 65, refused: "setup-review: refused: the packet carries a credential form (jwt at byte 0)", published: [] })], false)).toEqual([`${SERVED_CREDENTIAL}: request 1-1`]);
  });
});
