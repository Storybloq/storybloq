import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// ISS-928: scripts/tsc-gate.sh driven against a stub npx (and, for two cells, a
// stub grep) first on PATH. Never runs real tsc. Each stub's behaviour is
// written into the stub file for its cell; nothing in the shipped script reads
// an environment knob.

const SCRIPT = resolve(__dirname, "../../scripts/tsc-gate.sh");
const scriptText = readFileSync(SCRIPT, "utf8");

function baseline(name: string): number {
  const m = new RegExp(`^${name}=(\\d+)$`, "m").exec(scriptText);
  if (!m || m[1] === undefined) throw new Error(`${name} not found in tsc-gate.sh`);
  return Number(m[1]);
}
const SRC_B = baseline("SRC_BASELINE");
const TEST_B = baseline("TEST_BASELINE");

interface Program {
  heads?: number;
  rc: number;
  fakeHeadContinuations?: boolean;
  extra?: string;
  raw?: string;
}
interface Cell {
  src: Program;
  test: Program;
  preflightRc?: number;
  grepStub?: string;
  /** Each config's --showConfig: a files list (defaults cover src/ and src/ + test/) or raw output. */
  showConfig?: { src?: string[] | string; test?: string[] | string };
}
interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  tmpLeft: string[];
  root: string;
}

function heads(prefix: string, p: Program): string {
  if (p.raw !== undefined) return p.raw;
  let out = "";
  for (let i = 0; i < (p.heads ?? 0); i++) {
    out += `${prefix}/x${i}.ts(1,1): error TS2322: synthetic\n`;
    out += "  Type 'string' is not assignable to type 'number'.\n";
    if (p.fakeHeadContinuations) out += `  ${prefix}/fake.ts(1,1): error TS1234: continuation\n`;
  }
  return out + (p.extra ?? "");
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function showConfig(files: string[] | string): string {
  if (typeof files === "string") return files;
  return `{\n    "files": [\n${files.map((f) => `        "${f}"`).join(",\n")}\n    ]\n}\n`;
}

function npxStub(root: string, cell: Cell): string {
  return [
    "#!/bin/bash",
    'case " $* " in',
    '  *" --showConfig "*)',
    '    case " $* " in',
    `      *" -p tsconfig.json "*) cat ${q(join(root, "src.showconfig"))} ;;`,
    `      *" -p tsconfig.test.json "*) cat ${q(join(root, "test.showconfig"))} ;;`,
    "    esac",
    `    exit ${cell.preflightRc ?? 0} ;;`,
    "esac",
    'echo "npm notice New major version of npm available" >&2',
    'case " $* " in',
    `  *" -p tsconfig.json "*) cat ${q(join(root, "src.out"))}; exit ${cell.src.rc} ;;`,
    `  *" -p tsconfig.test.json "*) cat ${q(join(root, "test.out"))}; exit ${cell.test.rc} ;;`,
    "esac",
    "exit 99",
    "",
  ].join("\n");
}

function setup(cell: Cell): { root: string; bin: string; tmp: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "tsc-gate-test-"));
  const bin = join(root, "bin");
  const tmp = join(root, "tmp");
  const cwd = join(root, "cwd");
  for (const d of [bin, tmp, cwd]) mkdirSync(d);
  writeFileSync(join(root, "src.out"), heads("src", cell.src));
  writeFileSync(join(root, "test.out"), heads("test", cell.test));
  writeFileSync(join(root, "src.showconfig"), showConfig(cell.showConfig?.src ?? ["./src/index.ts"]));
  writeFileSync(join(root, "test.showconfig"), showConfig(cell.showConfig?.test ?? ["./src/index.ts", "./test/a.test.ts"]));
  writeFileSync(join(bin, "npx"), npxStub(root, cell));
  chmodSync(join(bin, "npx"), 0o755);
  if (cell.grepStub !== undefined) {
    writeFileSync(join(bin, "grep"), cell.grepStub);
    chmodSync(join(bin, "grep"), 0o755);
  }
  return { root, bin, tmp, cwd };
}

function run(cell: Cell): Result {
  const { root, bin, tmp, cwd } = setup(cell);
  const r = spawnSync("/bin/bash", [SCRIPT], {
    cwd,
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tmp, HOME: root },
    encoding: "utf8",
  });
  const tmpLeft = readdirSync(tmp);
  rmSync(root, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, tmpLeft, root };
}

const good = (): Cell => ({ src: { heads: SRC_B, rc: 2 }, test: { heads: TEST_B, rc: 2 } });
const COUNT_LINE = /^(src|test): /m;

function expectFatal(r: Result, reason: string): void {
  expect(r.status).toBe(3);
  expect(r.stderr).toContain(`tsc-gate: fatal: `);
  expect(r.stderr).toContain(reason);
  expect(r.stdout).not.toMatch(COUNT_LINE);
  expect(r.stdout).not.toContain("exceeds its baseline");
  expect(r.stdout).not.toContain("below its baseline");
  expect(r.tmpLeft).toEqual([]);
}

describe.skipIf(process.platform === "win32")("ISS-928 tsc-gate.sh against a stub tsc", () => {
  it("S1: both counts at their baselines exit 0 with both count lines", () => {
    const r = run(good());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`src: ${SRC_B} (baseline ${SRC_B})\ntest: ${TEST_B} (baseline ${TEST_B})\n`);
    expect(r.stderr).toBe("");
    expect(r.tmpLeft).toEqual([]);
  });

  it("S2: a test count over its baseline exits 1 after both programs report", () => {
    const r = run({ src: { heads: SRC_B, rc: 2 }, test: { heads: TEST_B + 1, rc: 2 } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`src: ${SRC_B} (baseline ${SRC_B})`);
    expect(r.stdout).toContain(`test: ${TEST_B + 1} (baseline ${TEST_B})`);
    expect(r.stdout).toContain(`tsc-gate: test count ${TEST_B + 1} exceeds its baseline ${TEST_B}`);
    expect(r.tmpLeft).toEqual([]);
  });

  it("S3: a count below its baseline exits 0 and says to lower that baseline", () => {
    const r = run({ src: { heads: SRC_B - 1, rc: 2 }, test: { heads: TEST_B, rc: 2 } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `tsc-gate: src count ${SRC_B - 1} is below its baseline ${SRC_B}: lower SRC_BASELINE to ${SRC_B - 1} in scripts/tsc-gate.sh`,
    );
    expect(r.stdout).not.toContain("TEST_BASELINE");
    expect(r.tmpLeft).toEqual([]);
  });

  it("S4: a clean rc 0 run with no output counts zero for both programs", () => {
    const r = run({ src: { rc: 0 }, test: { rc: 0 } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`src: 0 (baseline ${SRC_B})`);
    expect(r.stdout).toContain(`test: 0 (baseline ${TEST_B})`);
    expect(r.stdout).toContain("lower SRC_BASELINE to 0");
    expect(r.stdout).toContain("lower TEST_BASELINE to 0");
    expect(r.tmpLeft).toEqual([]);
  });

  it("S5: tsc rc 1 is fatal even with valid heads", () => {
    const c = good();
    c.src.rc = 1;
    expectFatal(run(c), "src: tsc exited 1, which is not a diagnostics exit");
  });

  it("S6: a signal-style rc 137 is fatal", () => {
    const c = good();
    c.test.rc = 137;
    expectFatal(run(c), "test: tsc exited 137, which is not a diagnostics exit");
  });

  it("S7: rc 2 with no file-anchored head is fatal", () => {
    const c = good();
    c.test = { raw: "something odd\n", rc: 2 };
    expectFatal(run(c), "test: tsc exited 2 but printed no file-anchored diagnostic");
  });

  it("S8: a global diagnostic beside valid heads is fatal", () => {
    const c = good();
    c.test.extra = "error TS5083: Cannot read file '/x/tsconfig.base.json'.\n";
    expectFatal(run(c), "test: 1 diagnostic(s) with no file location");
  });

  it("S9: an indented continuation holding a complete fake head is never counted", () => {
    const r = run({
      src: { heads: SRC_B, rc: 2, fakeHeadContinuations: true },
      test: { heads: TEST_B, rc: 2, fakeHeadContinuations: true },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`src: ${SRC_B} (baseline ${SRC_B})\ntest: ${TEST_B} (baseline ${TEST_B})\n`);
    expect(r.tmpLeft).toEqual([]);
  });

  it("S10: harmless npx stderr on a good run neither fails the gate nor leaks", () => {
    const cell = good();
    const { root, bin } = setup(cell);
    const direct = spawnSync(join(bin, "npx"), ["--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"], { encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
    expect(direct.stderr).toContain("npm notice");

    const r = run(cell);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`src: ${SRC_B} (baseline ${SRC_B})\ntest: ${TEST_B} (baseline ${TEST_B})\n`);
    expect(r.stderr).toBe("");
    expect(r.tmpLeft).toEqual([]);
  });

  it("S11: a grep operational error is fatal in the main shell, with no count line after it", () => {
    const c = good();
    c.grepStub = '#!/bin/bash\n/usr/bin/grep "$@"\nexit 2\n';
    expectFatal(run(c), "grep failed (status 2)");
  });

  it("S12: tsc rc 0 with unexpected stdout is fatal", () => {
    const c = good();
    c.src.rc = 0;
    expectFatal(run(c), "src: tsc exited 0 but printed output");
  });

  it("S13: a failing --showConfig preflight is fatal", () => {
    const c = good();
    c.preflightRc = 1;
    expectFatal(run(c), "src: tsc -p tsconfig.json --showConfig exited 1");
  });

  it("S14: a non-numeric count is fatal", () => {
    const c = good();
    c.grepStub = "#!/bin/bash\necho x\nexit 0\n";
    expectFatal(run(c), "grep printed a non-numeric count 'x'");
  });

  it("S15: a src count over its baseline exits 1 after both programs report", () => {
    const r = run({ src: { heads: SRC_B + 1, rc: 2 }, test: { heads: TEST_B, rc: 2 } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`src: ${SRC_B + 1} (baseline ${SRC_B})`);
    expect(r.stdout).toContain(`tsc-gate: src count ${SRC_B + 1} exceeds its baseline ${SRC_B}`);
    expect(r.stdout).toContain(`test: ${TEST_B} (baseline ${TEST_B})`);
    expect(r.tmpLeft).toEqual([]);
  });

  it("S16: a test config whose --showConfig lists no test/ file is fatal", () => {
    const c = good();
    c.showConfig = { test: ["./src/index.ts"] };
    expectFatal(run(c), "test: --showConfig lists no test/ file; the config does not cover test/");
  });

  it("S17: a src config whose --showConfig lists no src/ file is fatal", () => {
    const c = good();
    c.showConfig = { src: ["./test/a.test.ts"] };
    expectFatal(run(c), "src: --showConfig lists no src/ file; the config does not cover src/");
  });

  it("S18: a test/ pattern in exclude is not a test file", () => {
    const c = good();
    c.showConfig = { test: '{\n    "files": [\n        "./src/index.ts"\n    ],\n    "exclude": [\n        "./test/**"\n    ]\n}\n' };
    expectFatal(run(c), "test: --showConfig lists no test/ file; the config does not cover test/");
  });

  it("S19: --showConfig output that is not JSON is fatal even with rc 0", () => {
    const c = good();
    c.showConfig = { test: '{ "files": [ "./test/a.test.ts"\n' };
    expectFatal(run(c), "--showConfig output is not valid JSON");
  });

  it("S20: --showConfig output with no top-level files array is fatal", () => {
    const c = good();
    c.showConfig = { test: '{\n    "include": [\n        "./test/a.test.ts"\n    ]\n}\n' };
    expectFatal(run(c), "--showConfig output has no top-level files array");
  });
});
