// T-538 S5b-0 commit 6a: the fake transport's own rows. It must behave as the seam does from runAttempt's
// side (paths under /vol/att, every exec recorded, the helper's documents), and nothing under scripts/
// may reach it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { treeDigest } from "../../scripts/onboarding-eval-lib.js";
import { asAttemptPath, type ExecSpec, STDIN_LIMIT } from "../../scripts/onboarding-eval-transport.js";
import { makeFakeTransport } from "./fake-transport.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "t538-ft-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const spec = (o: Partial<ExecSpec> = {}): ExecSpec => ({ argv: ["true"], cwd: asAttemptPath("/vol/att/project"), env: {}, stdin: null, timeoutSeconds: 10, stdoutLimit: 1 << 20, stderrLimit: 1 << 20, ...o });

describe("the fake transport", () => {
  it("runs in the mapped folder, maps /vol/att in arguments and env, and prints container paths only", async () => {
    const tree = mkdtempSync(join(root, "t-"));
    const t = makeFakeTransport({ tree });
    const r = await t.exec(spec({ argv: ["/bin/sh", "-c", 'pwd; echo "$HOME"; ls /vol/att'], env: { HOME: "/vol/att/home", PATH: "/usr/bin:/bin" } }));
    expect(r.outcome).toBe("ok");
    expect(r.stdout.toString().split("\n").slice(0, 3)).toEqual(["/vol/att/project", "/vol/att/home", "project"]);
    expect(r.stdout.toString()).not.toContain(tree);
    expect(t.calls).toEqual([{ kind: "exec", argv: ["/bin/sh", "-c", 'pwd; echo "$HOME"; ls /vol/att'], cwd: "/vol/att/project", env: { HOME: "/vol/att/home", PATH: "/usr/bin:/bin" } }]);
  });
  it("refuses what the real transport refuses", () => {
    const t = makeFakeTransport({ tree: mkdtempSync(join(root, "t-")) });
    expect(() => t.exec(spec({ env: { NODE_OPTIONS: "x" } as never }))).toThrow(/not allowed/);
    expect(() => t.exec(spec({ cwd: "/etc" as never }))).toThrow(/not a path under/);
    expect(() => t.exec(spec({ argv: [] }))).toThrow(/bad exec/);
  });
  it("streams whole lines and answers a stubbed command without running it", async () => {
    const t = makeFakeTransport({ tree: mkdtempSync(join(root, "t-")), stub: (argv) => (argv[0] === "codex" ? { status: 0, stdout: "{\"a\":1}\n{\"b\":2}\n" } : null) });
    const seen: string[] = [];
    const r = await t.execStream(spec({ argv: ["codex", "exec"] }), (l) => seen.push(l.toString()));
    expect([seen, r.child?.status]).toEqual([['{"a":1}', '{"b":2}'], 0]);
    expect(t.calls[0]!.kind).toBe("stream");
  });
  it("answers the helper from the same functions, on the mapped tree", async () => {
    const tree = mkdtempSync(join(root, "t-"));
    const t = makeFakeTransport({ tree });
    mkdirSync(join(tree, "project", ".story"), { recursive: true });
    writeFileSync(join(tree, "project", ".story", "config.json"), "{}");
    symlinkSync("config.json", join(tree, "project", ".story", "link"));
    expect(await t.helper("tree-digest", ["/vol/att/project"])).toEqual(treeDigest(join(tree, "project")));
    expect((await t.readBytes(asAttemptPath("/vol/att/project/.story/config.json"), 10))?.toString()).toBe("{}");
    expect(await t.readBytes(asAttemptPath("/vol/att/project/none"), 10)).toBeNull();
    await expect(t.readBytes(asAttemptPath("/vol/att/project/.story/link"), 10)).rejects.toThrow(/a symlink/);
    await expect(t.helper("rm" as never, [])).rejects.toThrow(/unknown helper operation/);
    const c = await t.captureLive([["ticket", "next"]]);
    expect([c.status, c.packExit, c.tar.length > 0]).toEqual(["consistent", 0, true]);
  });
  it("records stop, pack and removal and gives the scripted answers", async () => {
    const t = makeFakeTransport({ tree: mkdtempSync(join(root, "t-")), stop: () => ({ ok: false, reason: "scripted" }), left: () => 2 });
    const sig = new AbortController().signal;
    expect(await t.stop(10, sig)).toEqual({ ok: false, reason: "scripted" });
    expect(await t.packFinal({ image: "i", volume: "v", target: "/vol/att", profile: "attempt", rawDir: root, onCreated: () => {}, timeoutMs: 1 }, sig)).toEqual({ ok: false, reason: "the fake has no pack" });
    expect(await t.remove(sig)).toEqual({ left: 2 });
    expect(t.calls.map((c) => c.kind)).toEqual(["stop", "pack", "remove"]);
  });
});

// Each row runs a real command and a stubbed one: a stub stands for the client binary, so it must meet
// the same limits, cancel and timeout as a command that runs.
describe("the fake's exec contract, the same for a real and a stubbed command", () => {
  const modes = [
    { mode: "real", argv: (out: string, ms: number) => ["/bin/sh", "-c", `printf '%s' '${out}'; sleep ${ms / 1000}`], stub: undefined },
    { mode: "stubbed", argv: () => ["client"], stub: (out: string, ms: number) => () => ({ status: 0, stdout: out, delayMs: ms }) },
  ] as const;
  const make = (m: (typeof modes)[number], out: string, ms: number, extra: Record<string, unknown> = {}) => {
    const t = makeFakeTransport({ tree: mkdtempSync(join(root, "t-")), killGraceMs: 300, ...(m.stub ? { stub: m.stub(out, ms) } : {}), ...extra });
    return { t, argv: m.argv(out, ms) };
  };
  for (const m of modes) {
    it(`${m.mode}: stdout over its limit is cut, ambiguous with no child, and the crossing line never reaches the reader`, async () => {
      const { t, argv } = make(m, `${"x".repeat(40)}\n`, 0);
      const seen: string[] = [];
      const r = await t.execStream(spec({ argv, stdoutLimit: 10 }), (l) => seen.push(l.toString()));
      expect([r.overLimit, r.outcome, r.child, r.cliStatus, r.stdout.length, seen]).toEqual(["stdout", "ambiguous", null, null, 10, []]);
    });
    it(`${m.mode}: stdin over the limit throws before anything runs`, () => {
      const { t, argv } = make(m, "", 0);
      expect(() => t.exec(spec({ argv, stdin: Buffer.alloc(STDIN_LIMIT + 1) }))).toThrow(/stdin over the limit/);
      expect(t.calls).toEqual([]);
    });
    it(`${m.mode}: a signal already aborted ends it at once, ambiguous with no child`, async () => {
      const { t, argv } = make(m, "out", 5000);
      const ac = new AbortController();
      ac.abort();
      const started = Date.now();
      const r = await t.exec(spec({ argv }), ac.signal);
      expect([r.outcome, r.child, r.timedOut, Date.now() - started < 2000]).toEqual(["ambiguous", null, null, true]);
    });
    it(`${m.mode}: a cancel while it runs ends it, ambiguous with no child`, async () => {
      const { t, argv } = make(m, "out", 5000);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const started = Date.now();
      const r = await t.exec(spec({ argv }), ac.signal);
      expect([r.outcome, r.child, Date.now() - started < 3000]).toEqual(["ambiguous", null, true]);
    });
    it(`${m.mode}: its own timeout is the envelope's: TERM, reported as the child's signal, the outcome ok`, async () => {
      const { t, argv } = make(m, "out", 5000);
      const r = await t.exec(spec({ argv, timeoutSeconds: 1 }));
      expect([r.outcome, r.timedOut, r.child, r.cliStatus]).toEqual(["ok", "term", { status: null, signal: "SIGTERM" }, 143]);
    });
  }
});

describe("the fake leaves no timer behind", () => {
  it("a stub that settles on the timeout's TERM leaves no KILL grace timer running", async () => {
    const t = makeFakeTransport({ tree: mkdtempSync(join(root, "t-")), stub: () => ({ status: 0, stdout: "out", delayMs: 60_000 }) });
    vi.useFakeTimers();
    try {
      const pending = t.exec(spec({ argv: ["client"], timeoutSeconds: 1 }));
      await vi.advanceTimersByTimeAsync(1000);
      const r = await pending;
      expect([r.timedOut, r.child, vi.getTimerCount()]).toEqual(["term", { status: null, signal: "SIGTERM" }, 0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the fake's live capture: production's retry and predicate on its own tries", () => {
  const ledger = (): string => {
    const tree = mkdtempSync(join(root, "t-"));
    mkdirSync(join(tree, "project", ".story", "tickets"), { recursive: true });
    writeFileSync(join(tree, "project", ".story", "tickets", "T-001.json"), "{}");
    return tree;
  };
  it("equal digests with a failed pack are inconclusive after three tries, 2 s apart", async () => {
    const t = makeFakeTransport({ tree: ledger(), live: () => ({ pack: () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) }) });
    const c = await t.captureLive([]);
    expect([c.status, c.tries, c.d1 === c.d2, c.packExit, t.waits]).toEqual(["inconclusive", 3, true, 1, [2000, 2000]]);
  });
  it("a ledger with an entry it cannot read is inconclusive, with the problem kept", async () => {
    const tree = ledger();
    expect(spawnSync("mkfifo", [join(tree, "project", ".story", "pipe")]).status).toBe(0);
    const c = await makeFakeTransport({ tree }).captureLive([]);
    expect([c.status, c.tries, c.problems.length > 0]).toEqual(["inconclusive", 3, true]);
  });
  it("an inconsistent first try, then a valid one, is consistent on the second", async () => {
    const tree = ledger();
    const t = makeFakeTransport({ tree, live: (n) => (n === 1 ? { cli: () => { writeFileSync(join(tree, "project", ".story", "tickets", "T-002.json"), "{}"); return { status: 0, stdout: "" }; } } : {}) });
    const c = await t.captureLive([["ticket", "next"]]);
    expect([c.status, c.tries, t.waits, existsSync(join(tree, "project", ".story", "tickets", "T-002.json"))]).toEqual(["consistent", 2, [2000], true]);
  });
});

describe("nothing under scripts/ reaches the fake", () => {
  it("no script imports the fake or anything else under test/tooling", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|mts|mjs|js)$/.test(e.name) && /from\s+["'][^"']*\/test\/tooling\/|import\(\s*["'][^"']*\/test\/tooling\/|fake-transport/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(join(PKG, "scripts"));
    expect(offenders).toEqual([]);
  });
});
