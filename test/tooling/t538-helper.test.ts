// T-538 S5b-0 commit 6a: helper.js, the program the host reads an attempt through (plan v10 section 8).
// The helper is bundled from the host's own functions, so these rows hold it to them: its input list is
// its import closure, and the built bundle answers exactly as the host functions do on the same tree.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEval, bundleClosure, EVAL_DIST, EVAL_INPUTS, HELPER_INPUTS, helperClosure } from "../../scripts/build-eval.mjs";
import { HELPER_OPS, liveTry, processCount, readBytesAt, rolloutLinesUnder, runOp } from "../../scripts/eval-helper.js";
import { runtimeExclusion, treeDigest } from "../../scripts/onboarding-eval-lib.js";
import { rule8 } from "../../scripts/onboarding-eval-checkset7.js";
import type { EventsLog } from "../../scripts/onboarding-eval-checkset7-events.js";
import { EVIDENCE_LIMIT, EVIDENCE_NOT_READ, ledgerState, observeEvidence } from "../../scripts/onboarding-eval-sessions.js";
import { walkNoFollow } from "../../scripts/onboarding-eval-walk.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "t538-hl-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A project with a ledger, a runtime gitignore, evidence, a link and a fifo-free mix of files. */
function project(): string {
  const p = mkdtempSync(join(root, "p-"));
  mkdirSync(join(p, ".story", "tickets"), { recursive: true });
  mkdirSync(join(p, "docs", "checkpoints", "m1"), { recursive: true });
  writeFileSync(join(p, ".story", "tickets", "T-001.json"), '{"id":"T-001"}\n');
  writeFileSync(join(p, ".story", ".gitignore"), "sessions/\nsnapshots/\n");
  writeFileSync(join(p, "docs", "checkpoints", "m1", "evidence.md"), "seen\n");
  writeFileSync(join(p, "a.ts"), "export {};\n");
  symlinkSync("a.ts", join(p, "link-a"));
  return p;
}

describe("the helper's build inputs, from the bundler's own record", () => {
  beforeAll(async () => { await buildEval(PKG); }, 240_000);
  it("the scripts the helper bundle was built from are exactly HELPER_INPUTS, and everything else in it is src/", () => {
    const closure = helperClosure(PKG);
    expect(closure.filter((f) => f.startsWith("scripts/"))).toEqual([...HELPER_INPUTS].sort());
    expect(closure.filter((f) => !f.startsWith("scripts/") && !f.startsWith("src/"))).toEqual([]);
    for (const f of HELPER_INPUTS) expect(EVAL_INPUTS).toContain(f);
  });
  it("the record sees every import form: a side effect, single quotes, a literal dynamic import, a re-export", async () => {
    // The bundler names paths from the real folder, so the temp folder is resolved first.
    const d = realpathSync(mkdtempSync(join(root, "forms-")));
    for (const [f, src] of Object.entries({
      "entry.ts": `import "./side.js";\nimport { a } from './single.js';\nexport * from "./reexport.js";\nexport const b = async () => (await import("./dyn.js")).c + a;\n`,
      "side.ts": "globalThis.x = 1;\n", "single.ts": "export const a = 1;\n", "reexport.ts": "export const r = 1;\n", "dyn.ts": "export const c = 1;\n",
    })) writeFileSync(join(d, f), src);
    const { build } = await import("esbuild");
    const r = await build({ entryPoints: [join(d, "entry.ts")], bundle: true, write: false, metafile: true, format: "esm", platform: "node", outfile: join(d, "out.js"), absWorkingDir: d, logLevel: "silent" });
    expect(bundleClosure(r.metafile, "out.js")).toEqual(["dyn.ts", "entry.ts", "reexport.ts", "side.ts", "single.ts"]);
    expect(() => bundleClosure(r.metafile, "other.js")).toThrow(/no output other.js/);
  });
});

describe("each operation answers as the host function it is built from", () => {
  it("on the same tree, called directly", () => {
    const p = project();
    expect(runOp("tree-digest", [p])).toEqual(treeDigest(p));
    expect(runOp("runtime-exclusion", [p])).toEqual(runtimeExclusion(p));
    expect(runOp("ledger-digest", [join(p, ".story")])).toEqual(ledgerState(join(p, ".story")));
    expect(runOp("observe-evidence", [p, "turn", "3"])).toEqual(observeEvidence(p, { kind: "turn", index: 3 }));
  });
  it("refuses an unknown operation and a wrong argument count, by name", () => {
    expect(() => runOp("rm", ["/"])).toThrow(/unknown helper operation rm/);
    expect(() => runOp("tree-digest", [])).toThrow(/takes 1 arguments/);
    expect(() => runOp("tree-digest", ["/a", "/b"])).toThrow(/takes 1 arguments/);
    expect(() => runOp("observe-evidence", ["/p", "turn", "1", "extra"])).toThrow(/takes 3 arguments/);
    expect(() => runOp("observe-evidence", ["/p", "later", "1"])).toThrow(/turn or event/);
    expect(() => runOp("read-bytes", ["/p", "-1"])).toThrow(/byte limit/);
    expect(() => runOp("capture-live", ["/s", '["ok", 3]'])).toThrow(/string array/);
    expect(HELPER_OPS).toEqual(["tree-digest", "runtime-exclusion", "ledger-digest", "observe-evidence", "rollout-lines", "process-count", "read-bytes", "capture-live"]);
  });
});

describe("the built bundle, run as a program", () => {
  let bundle = "";
  beforeAll(async () => {
    await buildEval(PKG);
    bundle = join(PKG, EVAL_DIST, "eval-helper.js");
  }, 240_000);
  const run = (args: readonly string[]): { status: number | null; doc: unknown } => {
    const r = spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 60_000 });
    return { status: r.status, doc: JSON.parse(r.stdout) as unknown };
  };
  it("prints one document whose ok value equals the host function's", () => {
    const p = project();
    expect(run(["tree-digest", p])).toEqual({ status: 0, doc: { ok: treeDigest(p) } });
    expect(run(["ledger-digest", join(p, ".story")])).toEqual({ status: 0, doc: { ok: ledgerState(join(p, ".story")) } });
    expect(run(["runtime-exclusion", p])).toEqual({ status: 0, doc: { ok: runtimeExclusion(p) } });
    expect(run(["observe-evidence", p, "event", "0"])).toEqual({ status: 0, doc: { ok: observeEvidence(p, { kind: "event", index: 0 }) } });
  });
  it("prints an error document and exits 1 on a failure", () => {
    expect(run(["no-such-op"])).toEqual({ status: 1, doc: { error: "unknown helper operation no-such-op" } });
  });
});

describe("read-bytes", () => {
  it("absent, a link, a folder and a fifo-like refusal are told apart; the bytes come back whole up to the limit", () => {
    const p = project();
    expect(readBytesAt(join(p, "nope"), 10)).toEqual({ absent: true });
    expect(readBytesAt(join(p, "link-a"), 100)).toEqual({ refused: "a symlink" });
    expect(readBytesAt(join(p, "docs"), 100)).toEqual({ refused: "not a regular file" });
    expect(readBytesAt(join(p, "a.ts"), 11)).toEqual({ base64: Buffer.from("export {};\n").toString("base64") });
    expect(readBytesAt(join(p, "a.ts"), 10)).toEqual({ refused: "over the limit of 10 bytes" });
    expect(readBytesAt(join(p, "a.ts"), 0)).toEqual({ refused: "over the limit of 0 bytes" });
    writeFileSync(join(p, "empty"), "");
    expect(readBytesAt(join(p, "empty"), 0)).toEqual({ base64: "" });
  });
  it("is the operation runOp dispatches, with its limit parsed", () => {
    const p = project();
    expect(runOp("read-bytes", [join(p, "a.ts"), "100"])).toEqual(readBytesAt(join(p, "a.ts"), 100));
  });
});

describe("rollout-lines", () => {
  const home = (): string => {
    const h = mkdtempSync(join(root, "ch-"));
    mkdirSync(join(h, "sessions", "2026", "11"), { recursive: true });
    writeFileSync(join(h, "sessions", "2026", "11", "rollout-T1.jsonl"), '{"a":1}\n{"b":\n{"c":3}\n');
    writeFileSync(join(h, "sessions", "2026", "11", "rollout-T2.jsonl"), '{"other":1}\n');
    writeFileSync(join(root, "outside-T1.jsonl"), '{"leak":1}\n');
    return h;
  };
  it("reads only this thread's .jsonl files, skips partial lines, and names a linked rollout without following it", () => {
    const h = home();
    symlinkSync(join(root, "outside-T1.jsonl"), join(h, "sessions", "link-T1.jsonl"));
    expect(rolloutLinesUnder(h, "T1")).toEqual({ lines: [{ a: 1 }, { c: 3 }], problems: ["CODEX_HOME/sessions/link-T1.jsonl is a link, not followed"] });
    expect(rolloutLinesUnder(join(root, "no-home"), "T1")).toEqual({ lines: [], problems: [] });
  });
  it("a linked sessions folder is named and never entered", () => {
    const h = mkdtempSync(join(root, "ch-"));
    const elsewhere = home();
    symlinkSync(join(elsewhere, "sessions"), join(h, "sessions"));
    expect(rolloutLinesUnder(h, "T1")).toEqual({ lines: [], problems: ["CODEX_HOME/sessions is a link, not followed"] });
  });
  it("a rollout swapped for an outside link or a fifo after it was found gives no foreign line and does not hang", () => {
    for (const swap of ["link", "fifo"] as const) {
      const h = home();
      const file = join(h, "sessions", "2026", "11", "rollout-T1.jsonl");
      const r = rolloutLinesUnder(h, "T1", (step, rel) => {
        if (step !== "open" || rel !== "sessions/2026/11/rollout-T1.jsonl") return;
        rmSync(file);
        if (swap === "link") symlinkSync(join(root, "outside-T1.jsonl"), file);
        else expect(spawnSync("mkfifo", [file]).status).toBe(0);
      });
      expect(r.lines).toEqual([]);
      expect(r.problems).toEqual([swap === "link" ? "CODEX_HOME/sessions/2026/11/rollout-T1.jsonl could not be read (ELOOP)" : "CODEX_HOME/sessions/2026/11/rollout-T1.jsonl changed while it was being read"]);
    }
  });
});

describe("process-count", () => {
  it("counts matching command lines and processes outside the caller's group, from a /proc it is given", () => {
    const proc = mkdtempSync(join(root, "proc-"));
    const add = (pid: number, cmd: string, pgrp: number): void => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "cmdline"), cmd.split(" ").join("\0"));
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (a (b) c) S 1 ${pgrp} ${pgrp} 0`);
    };
    add(10, "node /opt/eval/helper.js process-count eval-mcp.js", 10);
    add(11, "node /opt/storybloq/.eval-dist/eval-mcp.js", 7);
    add(12, "sleep 100", 10);
    mkdirSync(join(proc, "self"));
    expect(processCount("eval-mcp.js", proc, 10)).toEqual({ matching: 1, outsideGroup: 1 });
    expect(processCount("sleep", proc, 10)).toEqual({ matching: 1, outsideGroup: 1 });
  });
});

describe("the shared walk's per-path problems (commit 4's walk, used by the evidence and rollout reads)", () => {
  it("each problem reaches the visitor by path and kind, one for one with the findings it returns", () => {
    const d = mkdtempSync(join(root, "w-"));
    writeFileSync(join(d, "bad.txt"), "x");
    writeFileSync(join(d, "swapped.txt"), "x");
    expect(spawnSync("mkfifo", [join(d, "pipe")]).status).toBe(0);
    const seen: [string, string][] = [];
    const r = walkNoFollow(d, "t", {
      link: () => {}, file: (rel) => (rel === "bad.txt" ? "EIO" : null), problem: (rel, kind) => seen.push([rel, kind]),
    }, { hook: (step, rel) => { if (step === "open" && rel === "swapped.txt") { rmSync(join(d, rel)); expect(spawnSync("mkfifo", [join(d, rel)]).status).toBe(0); } } });
    expect(seen).toEqual([["bad.txt", "unreadable"], ["pipe", "other"], ["swapped.txt", "changed"]]);
    expect(r.problems).toEqual(["t/bad.txt could not be read (EIO)", "t/pipe is not a regular file, a folder or a link", "t/swapped.txt changed while it was being read"]);
  });
});

describe("observe-evidence (ISS-1467)", () => {
  const at = { kind: "turn", index: 2 } as const;
  const hex = (s: string): string => createHash("sha256").update(s).digest("hex");
  it("walks nested checkpoint folders and digests the regular files in them", () => {
    const p = project();
    mkdirSync(join(p, "docs", "checkpoints", "m1", "deep"));
    writeFileSync(join(p, "docs", "checkpoints", "m1", "deep", "more.md"), "more\n");
    expect(observeEvidence(p, at)).toEqual([
      { ref: "docs/checkpoints/m1/deep/more.md", sha256: hex("more\n"), at },
      { ref: "docs/checkpoints/m1/evidence.md", sha256: hex("seen\n"), at },
    ]);
  });
  it("records a link and a fifo as failed observations under their own paths, following no link", () => {
    const p = project();
    writeFileSync(join(root, "outside-evidence.md"), "outside\n");
    mkdirSync(join(root, "outside-dir"), { recursive: true });
    writeFileSync(join(root, "outside-dir", "x.md"), "x\n");
    symlinkSync(join(root, "outside-evidence.md"), join(p, "docs", "checkpoints", "m1", "link.md"));
    symlinkSync(join(root, "outside-dir"), join(p, "docs", "checkpoints", "linked-dir"));
    expect(spawnSync("mkfifo", [join(p, "docs", "checkpoints", "fifo")]).status).toBe(0);
    expect(observeEvidence(p, at)).toEqual([
      { ref: "docs/checkpoints/fifo", sha256: EVIDENCE_NOT_READ.other, at },
      { ref: "docs/checkpoints/linked-dir", sha256: EVIDENCE_NOT_READ.link, at },
      { ref: "docs/checkpoints/m1/evidence.md", sha256: hex("seen\n"), at },
      { ref: "docs/checkpoints/m1/link.md", sha256: EVIDENCE_NOT_READ.link, at },
    ]);
  });
  it("a file over the evidence limit is recorded as over the limit, not hashed, and one at the limit is hashed", () => {
    const p = project();
    writeFileSync(join(p, "docs", "checkpoints", "m1", "big.md"), Buffer.alloc(EVIDENCE_LIMIT + 1, 0x61));
    writeFileSync(join(p, "docs", "checkpoints", "m1", "edge.md"), Buffer.alloc(EVIDENCE_LIMIT, 0x61));
    expect(observeEvidence(p, at)).toEqual([
      { ref: "docs/checkpoints/m1/big.md", sha256: EVIDENCE_NOT_READ.over, at },
      { ref: "docs/checkpoints/m1/edge.md", sha256: createHash("sha256").update(Buffer.alloc(EVIDENCE_LIMIT, 0x61)).digest("hex"), at },
      { ref: "docs/checkpoints/m1/evidence.md", sha256: hex("seen\n"), at },
    ]);
  });
  it("a linked checkpoints folder is one failed observation, and a missing one is none", () => {
    const p = mkdtempSync(join(root, "p-"));
    mkdirSync(join(p, "docs"));
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "e.md"), "e\n");
    expect(observeEvidence(p, at)).toEqual([]);
    symlinkSync(join(root, "elsewhere"), join(p, "docs", "checkpoints"));
    expect(observeEvidence(p, at)).toEqual([{ ref: "docs/checkpoints", sha256: EVIDENCE_NOT_READ.link, at }]);
  });
  it("a linked docs folder is one failed observation and is never followed, though its target holds checkpoints", () => {
    const p = mkdtempSync(join(root, "p-"));
    const outside = project();
    symlinkSync(join(outside, "docs"), join(p, "docs"));
    expect(observeEvidence(p, at)).toEqual([{ ref: "docs", sha256: EVIDENCE_NOT_READ.link, at }]);
  });
  it("a folder, a file or a fifo swapped in between the check and the read is a failed observation, with nothing read from outside", () => {
    const outsideDir = mkdtempSync(join(root, "od-"));
    writeFileSync(join(outsideDir, "evidence.md"), "outside\n");
    const cases = [
      { step: "enter", rel: "docs/checkpoints/m1", swap: (x: string) => { renameSync(x, `${x}-gone`); symlinkSync(outsideDir, x); }, want: [{ ref: "docs/checkpoints/m1", sha256: EVIDENCE_NOT_READ.changed, at }] },
      { step: "open", rel: "docs/checkpoints/m1/evidence.md", swap: (x: string) => { rmSync(x); symlinkSync(join(outsideDir, "evidence.md"), x); }, want: [{ ref: "docs/checkpoints/m1/evidence.md", sha256: EVIDENCE_NOT_READ.failed, at }] },
      { step: "open", rel: "docs/checkpoints/m1/evidence.md", swap: (x: string) => { rmSync(x); expect(spawnSync("mkfifo", [x]).status).toBe(0); }, want: [{ ref: "docs/checkpoints/m1/evidence.md", sha256: EVIDENCE_NOT_READ.changed, at }] },
    ] as const;
    for (const c of cases) {
      const p = project();
      expect(observeEvidence(p, at, (step, rel) => { if (step === c.step && rel === c.rel) c.swap(join(p, rel)); })).toEqual(c.want);
    }
  });
  it("rule 8 fails a created evidence file that is now a link, naming what it saw", () => {
    const p = project();
    rmSync(join(p, "docs", "checkpoints", "m1", "evidence.md"));
    symlinkSync(join(root, "outside-evidence.md"), join(p, "docs", "checkpoints", "m1", "evidence.md"));
    const log = { events: [{ point: "evidence-created:docs/checkpoints/m1/evidence.md", sha256: hex("seen\n") }] } as unknown as EventsLog;
    expect(rule8([], [], log, observeEvidence(p, at))).toEqual([`rule 8: evidence docs/checkpoints/m1/evidence.md changed: created as ${hex("seen\n").slice(0, 12)}, observed as symlink at turn 2`]);
  });
});

describe("one live-capture try", () => {
  it("digests, packs, runs the readiness commands, digests again, in that order", () => {
    const p = project();
    const story = join(p, ".story");
    const order: string[] = [];
    const t = liveTry(story, [["ticket", "next"]], {
      pack: () => { order.push("pack"); return { status: 0, stdout: Buffer.from("TAR"), stderr: Buffer.alloc(0) }; },
      cli: (argv) => { order.push(argv.join(" ")); writeFileSync(join(story, "tickets", "T-002.json"), "{}"); return { status: 0, stdout: "T-001\n" }; },
      outside: () => 2,
    });
    expect(order).toEqual(["pack", "ticket next"]);
    expect(t.d1).not.toBe(t.d2);
    expect(t.d2).toBe(ledgerState(story).digest);
    expect([t.packExit, Buffer.from(t.tarBase64, "base64").toString(), t.readiness, t.outsideGroup]).toEqual([0, "TAR", [{ argv: ["ticket", "next"], status: 0, stdout: "T-001\n" }], 2]);
  });
});
