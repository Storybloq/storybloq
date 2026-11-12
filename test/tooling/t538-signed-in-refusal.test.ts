/**
 * T-538 signed-in note section 2 (S0): the unconditional signed-in refusal and the fresh-Claude admission
 * restriction, at every entry point: the driver (its command line and its preflight), the direct runner and the
 * probe turn. Each row shows zero spawns of any process, zero writes under a fake real home, zero reads of a
 * credential's content, and the refusal text naming the shared gates.
 *
 * In process: every node:child_process entry is a recording seam that refuses; node:os resolves the real home to a
 * fake one; node:fs content reads under that fake home are recorded and refused while an operation runs (hashing
 * happens outside that window). The runner's own entry runs as a child with recording stand-ins as the only
 * executables on its PATH, and a preloaded read spy that records content reads under its fake home.
 *
 * The fence (pen ruling G1): the runner's and the probe's CLI entries refuse every Claude run. The only admission is
 * a stand-in's, passed by the wrapper under test/fixtures and by test code, and it never admits signed-in.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const rec = (name: string) => (...a: unknown[]): never => { seam.calls.push(`${name} ${String(a[0])}`); throw new Error(`spawn seam: ${name} refused`); };
  const fake = { spawn: rec("spawn"), spawnSync: rec("spawnSync"), exec: rec("exec"), execSync: rec("execSync"), execFile: rec("execFile"), execFileSync: rec("execFileSync"), fork: rec("fork") };
  return { ...real, ...fake, default: { ...real, ...fake } };
});

/** The real-home resolver (userInfo().homedir, and homedir()) answers the current fake home. */
const homeSeam = vi.hoisted(() => ({ home: null as string | null }));
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const fake = {
    homedir: () => homeSeam.home ?? real.homedir(),
    userInfo: (o?: { encoding: BufferEncoding }) => ({ ...real.userInfo(o), homedir: homeSeam.home ?? real.userInfo(o).homedir }),
  };
  return { ...real, ...fake, default: { ...real, ...fake } };
});

/** Content reads under the fake home, while an operation's window is open, are recorded and refused. */
const readSeam = vi.hoisted(() => ({ open: false, reads: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const guard = (name: string, f: (...a: never[]) => unknown) => (...a: unknown[]): unknown => {
    const p = a[0];
    if (readSeam.open && homeSeam.home !== null && (typeof p === "string" || p instanceof URL)) {
      const abs = resolve(p instanceof URL ? fileURLToPath(p) : p);
      if (abs === homeSeam.home || abs.startsWith(`${homeSeam.home}/`)) {
        readSeam.reads.push(`${name} ${abs}`);
        throw new Error(`read seam: ${name} under the fake real home refused`);
      }
    }
    return (f as (...x: unknown[]) => unknown)(...a);
  };
  const fake = {
    readFileSync: guard("readFileSync", real.readFileSync), readFile: guard("readFile", real.readFile), openSync: guard("openSync", real.openSync),
    open: guard("open", real.open), createReadStream: guard("createReadStream", real.createReadStream), copyFileSync: guard("copyFileSync", real.copyFileSync),
    cpSync: guard("cpSync", real.cpSync), readdirSync: guard("readdirSync", real.readdirSync),
  };
  return { ...real, ...fake, default: { ...real, ...fake } };
});

const { KEYCHAIN_OPEN, READ_BOUNDARY_UNPROVEN, SIGNED_IN_MISSING_GATES } = await import("../../scripts/continuity-lib.js");
const { MEMORY_UNPROVEN } = await import("../../scripts/headless-policy.js");
const { realHome, unconditionalSignedInRefusal } = await import("../../scripts/continuity-signed-in.js");
const { armIsolationProblems, cli, generateManifest, parseManifest, preflightProblems, CLAUDE_ARM_REFUSAL, MANIFEST_PATH } = await import("../../scripts/onboarding-eval-driver.js");
type PreflightProbe = import("../../scripts/onboarding-eval-driver.js").PreflightProbe;
const { admissionRefusal, probeTurnArgs, FRESH_CLAUDE_NOT_ADMITTED, PROBE_PROMPT_TEMPLATE, PROBE_SHA256 } = await import("../../scripts/onboarding-eval-probe.js");
const { runAdmission } = await import("../../scripts/onboarding-eval-run.js");
const realCp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(PKG, "node_modules", "tsx", "dist", "cli.mjs");
const RUNNER = join(PKG, "scripts", "onboarding-eval-run.ts");
const ADMITTED_RUNNER = join(PKG, "test", "fixtures", "t538-admitted-runner.ts");
const READ_SPY = join(PKG, "test", "fixtures", "t538-read-spy.mjs");
const THREE = [READ_BOUNDARY_UNPROVEN, KEYCHAIN_OPEN, MEMORY_UNPROVEN];
const STAND_IN = { kind: "fresh-claude-stand-in" } as const;
const NOT_ADMITTED = (who: string): string => `${who}: ${FRESH_CLAUDE_NOT_ADMITTED}`;

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  homeSeam.home = null;
  readSeam.open = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };

/** A fake real home with FAKE secrets where the real ones live; never the real home. The resolver answers it. */
function fakeRealHome(): string {
  const h = tmp("t538s0-home-");
  mkdirSync(join(h, ".claude"), { recursive: true });
  mkdirSync(join(h, ".codex"), { recursive: true });
  writeFileSync(join(h, ".claude", ".credentials.json"), "FAKE-SECRET-S0-NOT-REAL\n");
  writeFileSync(join(h, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(h, ".claude.json"), "{}\n");
  writeFileSync(join(h, ".codex", "auth.json"), "FAKE-SECRET-S0-NOT-REAL\n");
  homeSeam.home = h;
  return h;
}

/** Every entry under `dir` with its kind, mode, size, mtime and content hash: any write changes it. Never inside a window. */
function treeHash(dir: string): string {
  if (readSeam.open) throw new Error("treeHash inside an operation window");
  const rows: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      const body = st.isFile() ? createHash("sha256").update(readFileSync(p)).digest("hex") : st.isSymbolicLink() ? readlinkSync(p) : "";
      rows.push(`${p.slice(dir.length)}|${st.mode}|${st.size}|${st.mtimeMs}|${body}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/** Runs one operation with the read window open; the window closes even when it throws. */
async function inWindow<T>(op: () => T | Promise<T>): Promise<T> {
  readSeam.reads.length = 0;
  seam.calls.length = 0;
  readSeam.open = true;
  try { return await op(); } finally { readSeam.open = false; }
}
const caught = async (op: () => unknown): Promise<string | null> => { try { await op(); return null; } catch (e) { return (e as Error).message; } };

const COMMIT = "a".repeat(40);
const ABSENT = Symbol("absent");
const manifestText = (claudeIsolation: unknown, codexIsolation: unknown = "fresh"): string => {
  const pin = (o: Record<string, unknown>, iso: unknown): Record<string, unknown> => (iso === ABSENT ? o : { ...o, isolation: iso });
  return JSON.stringify({
    id: "t538-s0", commit: COMMIT, evalBundleDigest: "e".repeat(64), toolListSha256: "f".repeat(64), probeSha256: PROBE_SHA256,
    clients: { codex: pin({ version: "0.153.4", model: "gpt-6-astra", judgeModel: "gpt-6-astra" }, codexIsolation), claude: pin({ version: "2.9.0", model: "opus", judgeModel: "gpt-6-astra" }, claudeIsolation) },
    limits: { turnMs: 60_000, attemptMs: 120_000, armMs: 240_000 },
    cells: [{ id: "c1", case: "x", fixture: "empty-idea", variant: "none", checkSet: 7 }],
  });
};
const LEGACY = manifestText(ABSENT, ABSENT);

/** A preflight probe whose every read records its name; a refused preflight calls none of them. */
function recordingProbe(): { probe: PreflightProbe; reads: string[] } {
  const reads: string[] = [];
  const r = <T>(name: string, v: T) => (): T => { reads.push(name); return v; };
  return {
    reads,
    probe: {
      version: (a) => { reads.push(`version ${a}`); return a === "codex" ? "codex-cli 0.153.4" : "2.9.0 (Claude Code)"; },
      managedSettings: r("managedSettings", [] as string[]), freeBytes: r("freeBytes", 30 * 1024 ** 3), counts: r("counts", { vitest: 0, jest: 0 }),
      codexCredential: r("codexCredential", true), claudeTokenLength: r("claudeTokenLength", 1), evalInputDigest: r("evalInputDigest", "e".repeat(64)),
      toolListSha256: r("toolListSha256", "f".repeat(64)), distProblems: () => { reads.push("distProblems"); return []; },
      capabilityProbe: async () => { reads.push("capabilityProbe"); return []; },
    },
  };
}

function expectGates(text: string): void {
  for (const g of SIGNED_IN_MISSING_GATES) expect(text).toContain(g);
  for (const g of THREE) expect(text).toContain(g);
}

/** Driver deps that record every use; a refused claude run uses none of them. */
function driverDeps(used: string[], git?: (a: readonly string[]) => { ok: boolean; out: string; status?: number }) {
  return {
    pkg: PKG, now: () => 0, alive: () => false, out: (s: string) => { used.push(`out ${s.trim()}`); },
    git: ((a: readonly string[]) => { used.push(`git ${a.join(" ")}`); return git ? git(a) : { ok: false, out: "" }; }) as Parameters<typeof cli>[1]["git"],
    preflight: async () => { used.push("preflight"); return []; },
    arm: async () => { used.push("arm"); return { kind: "done" as const }; },
  };
}

describe("S0: the shared gate list", () => {
  it("gains READ_BOUNDARY_UNPROVEN and KEYCHAIN_OPEN, next to MEMORY_UNPROVEN and the existing gates", () => {
    expect(SIGNED_IN_MISSING_GATES.slice(-3)).toEqual(THREE);
    expect(SIGNED_IN_MISSING_GATES.length).toBe(5);
    expectGates(unconditionalSignedInRefusal("x"));
    expect(unconditionalSignedInRefusal("x")).not.toMatch(/live-ack/);
  });

  it("the real-home resolver answers the fake home in these rows (the seam is live)", () => {
    const home = fakeRealHome();
    expect(realHome()).toBe(home);
  });
});

describe("S0 G1: the admission rule", () => {
  it("refuses claude for omitted, fresh and signed-in isolation; codex runs fresh only", () => {
    expect(() => runAdmission(["--client", "claude"])).toThrow(NOT_ADMITTED("onboarding-eval"));
    expect(() => runAdmission(["--client", "claude", "--isolation", "fresh"])).toThrow(NOT_ADMITTED("onboarding-eval"));
    expect(() => runAdmission(["--client", "claude", "--isolation", "signed-in"])).toThrow(unconditionalSignedInRefusal("onboarding-eval"));
    expect(runAdmission(["--client", "codex"])).toBe("fresh");
    expect(runAdmission(["--client", "codex", "--isolation", "fresh"])).toBe("fresh");
    expect(() => runAdmission(["--client", "codex", "--isolation", "signed-in"])).toThrow(/signed-in isolation is the claude arm's; codex runs fresh only/);
    expect(() => runAdmission([])).not.toThrow();
  });

  it.each([
    ["a repeated flag", ["--isolation", "fresh", "--isolation", "fresh"], /given more than once/],
    ["conflicting flags", ["--isolation", "fresh", "--isolation", "signed-in"], /given more than once/],
    ["conflicting flags, signed-in first", ["--isolation", "signed-in", "--isolation", "fresh"], /given more than once/],
    ["an unknown value", ["--isolation", "shared"], /must be fresh or signed-in, not "shared"/],
    ["a missing value", ["--isolation"], /must be fresh or signed-in, not null/],
    ["the = form", ["--isolation=fresh"], /not --isolation=<value>/],
    ["the = form for signed-in", ["--isolation=signed-in"], /not --isolation=<value>/],
  ])("refuses %s for either client, even with the stand-in admission", (_n, flags, re) => {
    for (const c of ["claude", "codex"]) {
      expect(() => runAdmission(["--client", c, ...flags])).toThrow(re);
      expect(() => runAdmission(["--client", c, ...flags], STAND_IN)).toThrow(re);
    }
  });

  it("the stand-in admission admits fresh claude only; signed-in stays unconditionally refused", () => {
    expect(runAdmission(["--client", "claude"], STAND_IN)).toBe("fresh");
    expect(runAdmission(["--client", "claude", "--isolation", "fresh"], STAND_IN)).toBe("fresh");
    expect(() => runAdmission(["--client", "claude", "--isolation", "signed-in"], STAND_IN)).toThrow(unconditionalSignedInRefusal("onboarding-eval"));
    expect(admissionRefusal("claude", "signed-in", "w", STAND_IN)).toBe(unconditionalSignedInRefusal("w"));
    expect(admissionRefusal("claude", null, "w", { kind: "anything-else" } as never)).toBe(NOT_ADMITTED("w"));
  });
});

describe("S0 G2: the driver's command line", () => {
  it.each([
    ["a nonexistent root", (_h: string) => join(tmp("t538s0-root-"), "driver")],
    ["a nonexistent root under the fake real home", (h: string) => join(h, "eval-root", "driver")],
  ])("refuses a claude arm run on %s before the root is created, git, preflight, the arm or any spawn", async (_n, rootOf) => {
    const home = fakeRealHome();
    vi.stubEnv("HOME", home);
    const root = rootOf(home);
    const before = treeHash(home);
    const used: string[] = [];
    const err = await inWindow(() => caught(() => cli(["--root", root, "--arm", "claude"], driverDeps(used))));
    expect(err).toBe(`preflight refused: ${CLAUDE_ARM_REFUSAL}`);
    expectGates(err!);
    expect(err).toMatch(/fresh claude arm is not admitted without a separate owner ruling and a reviewed manifest change/);
    expect(used).toEqual([]);
    expect(seam.calls).toEqual([]);
    expect(readSeam.reads).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(dirname(root))).toBe(root.startsWith(home) ? false : true);
    expect(treeHash(home)).toBe(before);
  });

  it("keeps the bookkeeping operations their own branches: --unlock on a claude arm reaches the root (the control)", async () => {
    const root = join(tmp("t538s0-root-"), "driver");
    const used: string[] = [];
    const err = await caught(() => cli(["--root", root, "--arm", "claude", "--unlock", "--reason", "control"], driverDeps(used)));
    expect(err).toBe("there is no lock to clear");
    expect(existsSync(root)).toBe(true);
  });
});

describe("S0: the driver's preflight", () => {
  it("refuses the pinned signed-in claude arm before any probe, naming every gate", async () => {
    const home = fakeRealHome();
    const before = treeHash(home);
    const { probe, reads } = recordingProbe();
    const root = tmp("t538s0-pf-");
    const problems = await inWindow(() => preflightProblems(parseManifest(manifestText("signed-in")), root, "claude", probe, 0));
    expect(problems).toHaveLength(1);
    expectGates(problems[0]!);
    expect(reads).toEqual([]);
    expect(seam.calls).toEqual([]);
    expect(readSeam.reads).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "preflight.json"), "utf-8"))).toMatchObject({ counts: null, problems });
    expect(treeHash(home)).toBe(before);
  });

  it("does not admit a fresh claude arm: the admission refusal, before any probe", async () => {
    fakeRealHome();
    const { probe, reads } = recordingProbe();
    const problems = await inWindow(() => preflightProblems(parseManifest(manifestText("fresh")), tmp("t538s0-pf-"), "claude", probe, 0));
    expect(problems).toEqual(["the claude arm's fresh isolation is not admitted: it needs a separate owner ruling and a reviewed manifest change"]);
    expect(reads).toEqual([]);
    expect(seam.calls).toEqual([]);
    expect(readSeam.reads).toEqual([]);
  });

  it("leaves the codex arm's fresh path running its probes (the control)", async () => {
    const { probe, reads } = recordingProbe();
    expect(armIsolationProblems(parseManifest(manifestText("signed-in")), "codex")).toEqual([]);
    expect(await preflightProblems(parseManifest(manifestText("signed-in")), tmp("t538s0-pf-"), "codex", probe, 0)).toEqual([]);
    expect(reads).toContain("capabilityProbe");
  });
});

describe("S0 G3: manifests with and without isolation", () => {
  it("reads a legacy manifest (no isolation) as historical fresh for both arms, its bytes untouched", () => {
    const bytes = Buffer.from(LEGACY, "utf-8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const m = parseManifest(bytes);
    expect(m.clients.codex.isolation).toBe("fresh");
    expect(m.clients.claude.isolation).toBe("fresh");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
    expect(bytes.toString("utf-8")).toBe(LEGACY);
    expect(LEGACY).not.toMatch(/isolation/);
  });

  it("runs the codex preflight on a legacy manifest, and refuses its claude arm as fresh-not-admitted", async () => {
    const { probe, reads } = recordingProbe();
    expect(await preflightProblems(parseManifest(LEGACY), tmp("t538s0-pf-"), "codex", probe, 0)).toEqual([]);
    expect(reads).toContain("capabilityProbe");
    const second = recordingProbe();
    expect(await preflightProblems(parseManifest(LEGACY), tmp("t538s0-pf-"), "claude", second.probe, 0)).toEqual(["the claude arm's fresh isolation is not admitted: it needs a separate owner ruling and a reviewed manifest change"]);
    expect(second.reads).toEqual([]);
  });

  it("renders --results from a legacy manifest at HEAD, quoting the manifest's own sha256", async () => {
    const d = tmp("t538s0-res-");
    const root = join(d, "driver");
    const plan = join(d, "plan.md");
    writeFileSync(plan, "# plan\n\n## 3. Cells\n\nc\n\n## 9. Budget\n\nb\n\n## 10. Results\n\nr\n");
    const out = join(d, "results.md");
    const git = (a: readonly string[]) => {
      if (a[0] === "rev-parse" && a[1] === "--show-prefix") return { ok: true, out: "storybloq/\n" };
      if (a[0] === "rev-parse" && a[1] === "HEAD") return { ok: true, out: `${COMMIT}\n` };
      if (a[0] === "cat-file" && a[2] === `HEAD:storybloq/${MANIFEST_PATH}`) return { ok: true, out: LEGACY };
      if (a[0] === "status") return { ok: true, out: "" };
      return { ok: false, out: "", status: 128 };
    };
    const used: string[] = [];
    expect(await cli(["--root", root, "--results", out, "--plan", plan, "--date", "2026-11-12"], driverDeps(used, git))).toBe(0);
    const sha = createHash("sha256").update(Buffer.from(LEGACY, "utf-8")).digest("hex");
    expect(readFileSync(out, "utf-8")).toContain(`manifest sha256 ${sha}`);
  });

  it("a newly generated manifest pins isolation explicitly, and generation refuses a missing value", () => {
    const m = generateManifest({ id: "g", commit: COMMIT, evalBundleDigest: "e".repeat(64), toolListSha256: "f".repeat(64), probeSha256: PROBE_SHA256, codexVersion: "0.153.4", claudeVersion: "2.9.0" });
    expect(m.clients.codex.isolation).toBe("fresh");
    expect(m.clients.claude.isolation).toBe("signed-in");
    expect(() => parseManifest(LEGACY, { requireIsolation: true })).toThrow(/clients\.codex\.isolation is missing; a new manifest pins it/);
    expect(() => parseManifest(manifestText(ABSENT), { requireIsolation: true })).toThrow(/clients\.claude\.isolation is missing; a new manifest pins it/);
    expect(parseManifest(manifestText("signed-in"), { requireIsolation: true }).clients.claude.isolation).toBe("signed-in");
  });

  it.each([
    ["codex signed-in", manifestText("fresh", "signed-in"), /clients\.codex\.isolation is "signed-in", not fresh/],
    ["claude shared", manifestText("shared"), /clients\.claude\.isolation is "shared"/],
    ["claude explicit null", manifestText(null), /clients\.claude\.isolation is null/],
    ["claude empty", manifestText(""), /clients\.claude\.isolation is ""/],
    ["claude a number", manifestText(1), /clients\.claude\.isolation is 1/],
    ["codex a list", manifestText("fresh", ["fresh"]), /clients\.codex\.isolation is \["fresh"\]/],
  ])("refuses an invalid explicit isolation: %s", (_n, text, re) => {
    expect(() => parseManifest(text)).toThrow(re);
    expect(() => parseManifest(text, { requireIsolation: true })).toThrow(re);
  });
});

/** A valid ack and the pinned probe prompt, so a refusal is the admission rule's and not a fixture check's. */
function probeFixtures(): { argv: string[]; ack: string; prompt: string } {
  const d = tmp("t538s0-probe-");
  const ack = join(d, "ack");
  const prompt = join(d, "prompt.txt");
  writeFileSync(ack, "owner ack");
  writeFileSync(prompt, PROBE_PROMPT_TEMPLATE);
  return { argv: ["--probe-turn", "--ack", ack, "--prompt-file", prompt], ack, prompt };
}

describe("S0 G4: the probe turn", () => {
  it.each([
    ["omitted isolation", [], NOT_ADMITTED("--probe-turn")],
    ["explicit fresh", ["--isolation", "fresh"], NOT_ADMITTED("--probe-turn")],
    ["signed-in", ["--isolation", "signed-in"], unconditionalSignedInRefusal("--probe-turn")],
  ])("refuses claude with %s and a valid ack and prompt: no spawn, no read under the home, no write", async (_n, flags, message) => {
    const { argv } = probeFixtures();
    const home = fakeRealHome();
    const before = treeHash(home);
    expect(await inWindow(() => caught(() => probeTurnArgs([...argv, ...flags], "claude", "none")))).toBe(message);
    expect(seam.calls).toEqual([]);
    expect(readSeam.reads).toEqual([]);
    expect(treeHash(home)).toBe(before);
  });

  it("admits the same fixtures only with the stand-in admission, and never signed-in (the control)", () => {
    const { argv, ack, prompt } = probeFixtures();
    expect(probeTurnArgs(argv, "claude", "none", STAND_IN)).toEqual({ ack, promptFile: prompt });
    expect(probeTurnArgs([...argv, "--isolation", "fresh"], "claude", "none", STAND_IN)).toEqual({ ack, promptFile: prompt });
    expect(() => probeTurnArgs([...argv, "--isolation", "signed-in"], "claude", "none", STAND_IN)).toThrow(unconditionalSignedInRefusal("--probe-turn"));
    expect(() => probeTurnArgs([...argv, "--isolation", "fresh", "--isolation", "signed-in"], "claude", "none", STAND_IN)).toThrow(/more than once/);
  });
});

describe("S0: the direct runner's real entry, as a child", { timeout: 180_000 }, () => {
  /** The runner as a child: recording stand-ins are the only executables on its PATH; a preloaded spy records content reads under its fake home. */
  async function runChild(o: { entry?: string; client?: string; extra?: string[]; env?: Record<string, string> } = {}): Promise<{ status: number | null; stderr: string; log: string; reads: string; result: Record<string, unknown> | null; dir: string; homeSame: boolean }> {
    const dir = tmp("t538s0-run-");
    const home = fakeRealHome();
    homeSeam.home = null;
    const before = treeHash(home);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "spawned.log");
    const readLog = join(dir, "reads.log");
    for (const name of ["claude", "codex", "git", "security", "npm", "python3", "sh", "bash", "sandbox-exec", "pgrep", "lsof"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(log)}\nexit 97\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const resultFile = join(dir, "result.json");
    const args = [TSX, o.entry ?? RUNNER, "--client", o.client ?? "claude", "--fixture", "empty-idea", "--out", join(dir, "out"), "--raw-out", join(dir, "raw"), "--attempt-base", join(dir, "att"), "--result", resultFile, ...(o.extra ?? [])];
    const env = { ...o.env, PATH: bin, HOME: home, TMPDIR: dir, NODE_OPTIONS: `--import ${READ_SPY}`, T538_SPY_HOME: home, T538_SPY_LOG: readLog };
    const r = await new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = realCp.spawn(process.execPath, args, { cwd: PKG, env, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr!.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
      child.on("close", (status) => done({ status, stderr }));
    });
    return {
      status: r.status, stderr: r.stderr, dir,
      log: existsSync(log) ? readFileSync(log, "utf-8") : "",
      reads: existsSync(readLog) ? readFileSync(readLog, "utf-8") : "",
      result: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf-8")) as Record<string, unknown> : null,
      homeSame: treeHash(home) === before,
    };
  }

  function expectRefused(r: Awaited<ReturnType<typeof runChild>>, message: string): void {
    expect(r.status).toBe(2);
    expect(r.log).toBe("");
    expect(r.reads).toBe("");
    expect(r.homeSame).toBe(true);
    expect(existsSync(join(r.dir, "out"))).toBe(false);
    expect(existsSync(join(r.dir, "raw"))).toBe(false);
    expect(existsSync(join(r.dir, "att"))).toBe(false);
    expect(r.result).toMatchObject({ ok: false, stage: "args", message });
  }

  it.each([
    ["a run, omitted isolation", () => [], NOT_ADMITTED("onboarding-eval")],
    ["a run, explicit fresh", () => ["--isolation", "fresh"], NOT_ADMITTED("onboarding-eval")],
    ["a run, signed-in", () => ["--isolation", "signed-in"], unconditionalSignedInRefusal("onboarding-eval")],
    ["a probe turn with a valid ack and prompt, omitted isolation", () => probeFixtures().argv, NOT_ADMITTED("onboarding-eval")],
    ["a probe turn with a valid ack and prompt, explicit fresh", () => [...probeFixtures().argv, "--isolation", "fresh"], NOT_ADMITTED("onboarding-eval")],
    ["a probe turn with a valid ack and prompt, signed-in", () => [...probeFixtures().argv, "--isolation", "signed-in"], unconditionalSignedInRefusal("onboarding-eval")],
  ])("the CLI entry refuses claude on %s: no spawn, no read or write under the home, no output", async (_n, extra, message) => {
    const r = await runChild({ extra: extra() });
    expectRefused(r, message);
    if (message.includes("signed-in")) expectGates(r.stderr);
  });

  it("the CLI entry refuses claude with every admission-shaped flag and variable set (the fence)", async () => {
    const fake = fakeRealHome();
    homeSeam.home = null;
    const r = await runChild({
      extra: [...probeFixtures().argv, "--admission", "fresh-claude-stand-in", "--stand-in", "--admit", "--owner-ack", "--tool-sets", "all", "--model", "opus", "--variant", "none", "--live", "--yes"],
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "placeholder-not-a-token", ANTHROPIC_API_KEY: "placeholder-not-a-key", CLAUDE_CONFIG_DIR: join(fake, ".claude"),
        T538_ADMISSION: "fresh-claude-stand-in", T538_STAND_IN: "1", STORYBLOQ_ADMIT_CLAUDE: "1", ONBOARDING_EVAL_ADMISSION: "fresh-claude-stand-in",
        STORYBLOQ_EVAL_ISOLATION: "fresh", VITEST: "true", NODE_ENV: "test", CI: "1",
      },
    });
    expectRefused(r, NOT_ADMITTED("onboarding-eval"));
  });

  it("the test-only wrapper still refuses signed-in", async () => {
    expectRefused(await runChild({ entry: ADMITTED_RUNNER, extra: ["--isolation", "signed-in"] }), unconditionalSignedInRefusal("onboarding-eval"));
    expectRefused(await runChild({ entry: ADMITTED_RUNNER, extra: [...probeFixtures().argv, "--isolation", "signed-in"] }), unconditionalSignedInRefusal("onboarding-eval"));
  });

  it("the child's real-home resolver answers the fake home, and a credential read through it is recorded and refused (the spy's control)", async () => {
    const dir = tmp("t538s0-spy-");
    const home = fakeRealHome();
    homeSeam.home = null;
    const before = treeHash(home);
    const readLog = join(dir, "reads.log");
    const probe = join(dir, "probe.mts");
    const signedIn = pathToFileURL(join(PKG, "scripts", "continuity-signed-in.ts")).href;
    writeFileSync(probe, [
      'import { readFileSync } from "node:fs";',
      'import { homedir, userInfo } from "node:os";',
      'import { join } from "node:path";',
      `const { realHome } = await import(${JSON.stringify(signedIn)});`,
      'let read = "none";',
      // Never the real home: the read is attempted only when the resolver answers the fake home this row planted.
      `if (realHome() !== ${JSON.stringify(home)}) read = "not redirected; no read attempted";`,
      'else try { read = readFileSync(join(realHome(), ".claude", ".credentials.json"), "utf-8"); } catch (e) { read = `refused: ${(e as Error).message}`; }',
      'process.stdout.write(JSON.stringify({ realHome: realHome(), homedir: homedir(), userInfo: userInfo().homedir, read }));',
    ].join("\n"));
    const env = { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir, NODE_OPTIONS: `--import ${READ_SPY}`, T538_SPY_HOME: home, T538_SPY_LOG: readLog };
    const r = realCp.spawnSync(process.execPath, [TSX, probe], { cwd: PKG, env, encoding: "utf-8", timeout: 60_000 });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, string>;
    expect(out).toEqual({ realHome: home, homedir: home, userInfo: home, read: "refused: read spy: readFileSync under the fake real home refused" });
    expect(readFileSync(readLog, "utf-8")).toBe(`readFileSync ${join(home, ".claude", ".credentials.json")}\n`);
    expect(treeHash(home)).toBe(before);
  });

  it("the seam sees a spawn: a codex fresh run reaches the codex stand-in (the control)", async () => {
    const r = await runChild({ client: "codex" });
    expect(r.status).toBe(2);
    expect(r.log).toMatch(/^codex --version/m);
    expect(r.homeSame).toBe(true);
  });

  it("the wrapper admits a fresh claude run past the admission rule (the control)", async () => {
    const r = await runChild({ entry: ADMITTED_RUNNER });
    expect(r.result).not.toMatchObject({ stage: "args" });
    expect(r.log).not.toBe("");
  });
});

describe("S0 G1: the fence in the source tree", () => {
  const files = (root: string): string[] => realFs.readdirSync(root, { recursive: true, encoding: "utf-8" })
    .map((f) => join(root, f)).filter((f) => /\.(ts|mts|js|mjs|cjs)$/.test(f) && realFs.statSync(f).isFile());

  it("no file under scripts/ or src/ constructs the stand-in admission; only the type and the comparison name it", () => {
    const hits = [...files(join(PKG, "scripts")), ...files(join(PKG, "src"))].flatMap((f) => realFs.readFileSync(f, "utf-8").split("\n")
      .map((line, i) => ({ f: relative(PKG, f), i, line })).filter((h) => h.line.includes("fresh-claude-stand-in")));
    expect(hits.map((h) => h.f)).toEqual(["scripts/onboarding-eval-probe.ts", "scripts/onboarding-eval-probe.ts"]);
    expect(hits[0]!.line).toMatch(/^export interface StandInAdmission \{ readonly kind: "fresh-claude-stand-in" \}$/);
    expect(hits[1]!.line).toMatch(/admission\?\.kind === "fresh-claude-stand-in"/);
  });

  it("the CLI entries pass no admission: the runner's entry calls runnerCli with argv only, and nothing shipped imports the wrapper", () => {
    const run = realFs.readFileSync(RUNNER, "utf-8");
    expect(run.match(/runnerCli\(process\.argv[^\n]*/g)).toEqual(["runnerCli(process.argv.slice(2));"]);
    for (const f of [...files(join(PKG, "scripts")), ...files(join(PKG, "src"))]) expect(realFs.readFileSync(f, "utf-8")).not.toMatch(/(from|import\(|spawn[^\n]*)\s*["'][^"'\n]*t538-admitted-runner/);
    const callers = [...files(join(PKG, "scripts")), ...files(join(PKG, "src"))].filter((f) => /\b(runnerCli|runAdmission|probeTurnArgs)\(/.test(realFs.readFileSync(f, "utf-8"))).map((f) => relative(PKG, f)).sort();
    expect(callers).toEqual(["scripts/onboarding-eval-probe.ts", "scripts/onboarding-eval-run.ts"]);
  });
});
