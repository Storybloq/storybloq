/**
 * T-538 S3a-2 commit 8: the owner's answers to an unreadable run (adapter,
 * leave-off, stop), the adapter evidence contract, reopen, and live runs.
 * The real-adapter, wrapper and live tests run the real runner in a real
 * project; each is skipped, its reason in its title, when the runner is not
 * on PATH.
 */
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setupApply } from "../../src/core/setup-apply.js";
import { setupVerify, type SetupVerifyInput } from "../../src/core/setup-verify.js";
import { handleSetupVerify } from "../../src/cli/commands/setup-verify.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { registerSetupVerifyCommand } from "../../src/cli/register.js";
import yargs from "yargs";
import { SID, comp, editTicket, faultOnce, makeRegistry, payload, pinEnvironment, ticketBytes, ticketFile } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 120_000 });
const { home, folder } = pinEnvironment("t538-s3a2r");

const REPLAY = join(import.meta.dirname, "fixtures", "t538-replay.sh");
const replay = (name: string, extra = ""): string => `sh ${REPLAY} ${name}${extra === "" ? "" : ` ${extra}`}`;
const RECORDINGS = join(import.meta.dirname, "__fixtures__", "t538-runner-output");
const NODE_MODULES = resolve(import.meta.dirname, "..", "..", "node_modules");

const has = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
/** A live test, skipped with its reason named when the runner is not on PATH. */
const live = (tool: string) => (has(tool) ? it : it.skip);
const needs = (tool: string): string => (has(tool) ? "" : ` (skipped: ${tool} is not on PATH)`);

/** The test process's environment without vitest's own variables, so a nested vitest run is an ordinary one. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(VITEST|TINYPOOL|NODE_ENV$)/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

const OWNER = "the summary is hidden by our script; run vitest directly";

/** The run token a stopped (exit 4) run printed in its first line: a resolution names the run it answers (T-538 S3b). */
const tokenOf = (r: { exitCode: number; lines: string[] }): string => {
  expect(r.exitCode).toBe(4);
  return /\(run ([0-9a-f]{16})\)\.?$/.exec(r.lines[0]!)![1]!;
};

/** A run that stops unreadable, and its token. */
const stoppedRun = async (root: string, env?: NodeJS.ProcessEnv): Promise<string> => tokenOf(await setupVerify(root, { ticket: "T-002" }, env === undefined ? {} : { env }));

/** A well-formed token no run printed, for refusals that come before the token is compared. */
const NO_RUN = "0000000000000000";

const files = async (root: string) => ({
  ticket: await ticketBytes(root, "T-002"),
  config: await readFile(join(root, ".story", "config.json"), "utf-8"),
});

const configOf = async (root: string) => JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8")) as {
  setupVerification: { components: Array<{ test: { status: string }; decision?: unknown }> };
  recipeOverrides: { stages: Record<string, unknown> };
};

const verificationOf = (t: Record<string, unknown>) => (t.setup as { verification: { decision?: unknown; result?: { status: string }; reopened?: unknown[] } }).verification;

/** A finished setup for one component, with the scaffold (T-001) built. */
async function ready(command: string, runner = "vitest", wrapper = "none", root?: string): Promise<string> {
  const dir = root ?? await folder();
  expect((await setupApply(dir, payload({ components: [comp({ command, runner, wrapper })] }))).exitCode).toBe(0);
  await editTicket(dir, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
  return dir;
}

async function closeOutside(root: string): Promise<void> {
  await editTicket(root, "T-002", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
}

// --- Real projects -------------------------------------------------------------

async function vitestProject(root: string, script: string): Promise<void> {
  await symlink(NODE_MODULES, join(root, "node_modules"), "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: script } }, null, 2) + "\n");
  await writeFile(join(root, "sum.test.js"), `import { test, expect } from "vitest";\ntest("adds", () => expect(1 + 1).toBe(2));\ntest("subtracts", () => expect(2 - 1).toBe(1));\n`);
}

async function pytestProject(root: string): Promise<void> {
  await writeFile(join(root, "test_sum.py"), "def test_adds():\n    assert 1 + 1 == 2\n\ndef test_subtracts():\n    assert 2 - 1 == 1\n");
}

async function goProject(root: string): Promise<void> {
  await writeFile(join(root, "go.mod"), "module example.com/demo\n\ngo 1.21\n");
  await writeFile(join(root, "sum.go"), "package demo\n\nfunc Add(a, b int) int { return a + b }\n");
  await writeFile(join(root, "sum_test.go"), "package demo\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 1) != 2 {\n\t\tt.Fatal(\"add\")\n\t}\n}\n\nfunc TestAddZero(t *testing.T) {\n\tif Add(0, 2) != 2 {\n\t\tt.Fatal(\"zero\")\n\t}\n}\n");
}

async function cargoProject(root: string): Promise<void> {
  await writeFile(join(root, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "lib.rs"), "pub fn add(a: i32, b: i32) -> i32 { a + b }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() { assert_eq!(super::add(1, 1), 2); }\n    #[test]\n    fn zero() { assert_eq!(super::add(0, 2), 2); }\n}\n");
}

describe("the adapter evidence contract, with real runners", () => {
  live("pytest")(`pytest with PYTEST_ADDOPTS=--junitxml elsewhere: adapter ["pytest"] dropping it verifies from the handler's own report${needs("pytest")}`, async () => {
    const root = await folder();
    await pytestProject(root);
    await ready("pytest", "pytest", "none", root);
    const elsewhere = join(root, "elsewhere.xml");
    const env = cleanEnv({ PYTEST_ADDOPTS: `--junitxml=${elsewhere}` });

    const plain = await setupVerify(root, { ticket: "T-002" }, { env });
    expect(plain.exitCode).toBe(4);
    expect(plain.lines[1]).toContain("observed PYTEST_ADDOPTS already names a JUnit report (--junitxml);");

    const decided = await setupVerify(root, { ticket: "T-002", resolve: "adapter", argv: ["pytest"], drop: ["PYTEST_ADDOPTS"], ownerWords: "drop our report option", run: tokenOf(plain) }, { env });
    expect(decided).toEqual({ exitCode: 0, lines: [`Decision recorded for T-002: adapter. The next storybloq setup-verify --ticket T-002 runs ["pytest"] in . with no shell; PYTEST_ADDOPTS (${JSON.stringify(`--junitxml=${elsewhere}`)}) is dropped and replaced by PYTEST_ADDOPTS=--junitxml='<report>'.`] });
    expect((await ticketFile(root, "T-002")).status).toBe("open");

    const r = await setupVerify(root, { ticket: "T-002" }, { env });
    expect(r).toEqual({ exitCode: 0, lines: ["Verified: app test (pytest, 2 tests); stages on: TEST"] });
    expect(existsSync(elsewhere)).toBe(false);
    // The config command is the setup's, not the adapter's.
    expect((await configOf(root)).recipeOverrides.stages.TEST).toMatchObject({ enabled: true, command: "pytest" });
  });

  live("go")(`go with GOFLAGS=-json: adapter ["go","test","./..."] dropping it verifies from -v lines${needs("go")}`, async () => {
    const root = await folder();
    await goProject(root);
    await ready("go test ./...", "go", "none", root);
    const env = cleanEnv({ GOFLAGS: "-json" });
    const run = await stoppedRun(root, env);
    const decided = await setupVerify(root, { ticket: "T-002", resolve: "adapter", argv: ["go", "test", "./..."], drop: ["GOFLAGS"], ownerWords: "our GOFLAGS asks for json", run }, { env });
    expect(decided.lines[0]).toBe(`Decision recorded for T-002: adapter. The next storybloq setup-verify --ticket T-002 runs ["go","test","./..."] in . with no shell; GOFLAGS ("-json") is dropped and replaced by GOFLAGS=-v.`);
    expect(await setupVerify(root, { ticket: "T-002" }, { env })).toEqual({ exitCode: 0, lines: ["Verified: app test (go, 2 tests); stages on: TEST"] });
  });

  live("npx")(`a compound npm script that hides the vitest summary: adapter ["npx","vitest","run"] verifies${needs("npx")}`, async () => {
    const root = await folder();
    await vitestProject(root, "vitest run > /dev/null 2>&1 && echo tests done");
    await ready("npm test", "vitest", "npm", root);
    const env = cleanEnv();
    const plain = await setupVerify(root, { ticket: "T-002" }, { env });
    expect(plain.exitCode).toBe(4);
    expect(plain.lines).toContain("  | tests done");
    expect((await setupVerify(root, { ticket: "T-002", resolve: "adapter", argv: ["npx", "vitest", "run"], ownerWords: OWNER, run: tokenOf(plain) }, { env })).lines[0])
      .toBe(`Decision recorded for T-002: adapter. The next storybloq setup-verify --ticket T-002 runs ["npx","vitest","run"] in . with no shell.`);
    expect(await setupVerify(root, { ticket: "T-002" }, { env })).toEqual({ exitCode: 0, lines: ["Verified: app test (vitest, 2 tests); stages on: TEST"] });
    expect((await configOf(root)).recipeOverrides.stages.TEST).toMatchObject({ command: "npm test" });
  });
});

describe("wrappers as real subprocesses", () => {
  live("npx")(`npm test${needs("npx")}`, async () => {
    const root = await folder();
    await vitestProject(root, "vitest run");
    await ready("npm test", "vitest", "npm", root);
    expect((await setupVerify(root, { ticket: "T-002" }, { env: cleanEnv() })).lines).toEqual(["Verified: app test (vitest, 2 tests); stages on: TEST"]);
  });

  live("pytest")(`make test${needs("pytest")}`, async () => {
    const root = await folder();
    await pytestProject(root);
    await writeFile(join(root, "Makefile"), "test:\n\tpytest\n");
    await ready("make test", "pytest", "make", root);
    expect((await setupVerify(root, { ticket: "T-002" }, { env: cleanEnv() })).lines).toEqual(["Verified: app test (pytest, 2 tests); stages on: TEST"]);
  });

  it("a stub manage.py printing a recorded Django run", async () => {
    const root = await folder();
    await writeFile(join(root, "manage.py"), `import sys\nsys.stderr.write(open(${JSON.stringify(join(RECORDINGS, "django-pass.txt"))}).read())\n`);
    await ready("python3 manage.py test", "django", "django-manage", root);
    expect((await setupVerify(root, { ticket: "T-002" })).lines).toEqual(["Verified: app test (django, 2 tests); stages on: TEST"]);
  });
});

describe("live runs", () => {
  live("pytest")(`pytest with PYTEST_ADDOPTS='-m "not slow" --ignore=x' intact${needs("pytest")}`, async () => {
    const root = await folder();
    await pytestProject(root);
    await ready("pytest", "pytest", "none", root);
    expect((await setupVerify(root, { ticket: "T-002" }, { env: cleanEnv({ PYTEST_ADDOPTS: '-m "not slow" --ignore=x' }) })).lines).toEqual(["Verified: app test (pytest, 2 tests); stages on: TEST"]);
  });

  live("go")(`go with GOFLAGS=-tags=integration intact${needs("go")}`, async () => {
    const root = await folder();
    await goProject(root);
    await ready("go test ./...", "go", "none", root);
    expect((await setupVerify(root, { ticket: "T-002" }, { env: cleanEnv({ GOFLAGS: "-tags=integration" }) })).lines).toEqual(["Verified: app test (go, 2 tests); stages on: TEST"]);
  });

  live("cargo")(`cargo test${needs("cargo")}`, async () => {
    const root = await folder();
    await cargoProject(root);
    await ready("cargo test", "cargo", "none", root);
    expect((await setupVerify(root, { ticket: "T-002" }, { env: cleanEnv() })).lines).toEqual(["Verified: app test (cargo, 2 tests); stages on: TEST"]);
  });

  live("npx")(`vitest${needs("npx")}`, async () => {
    const root = await folder();
    await vitestProject(root, "vitest run");
    await ready("npx vitest run", "vitest", "none", root);
    expect((await setupVerify(root, { ticket: "T-002" }, { env: cleanEnv() })).lines).toEqual(["Verified: app test (vitest, 2 tests); stages on: TEST"]);
  });
});

describe("resolutions", () => {
  it("adapter and stop record the decision on both records and leave the ticket open and the stages as they were", async () => {
    for (const kind of ["adapter", "stop"] as const) {
      const root = await ready(replay("jest-pass"));
      const run = await stoppedRun(root);
      const before = await configOf(root);
      const input: SetupVerifyInput = kind === "adapter" ? { ticket: "T-002", resolve: kind, argv: ["sh", REPLAY, "vitest-pass"], ownerWords: OWNER, run } : { ticket: "T-002", resolve: kind, ownerWords: "  not now  ", run };
      expect((await setupVerify(root, input)).exitCode).toBe(0);
      const t = await ticketFile(root, "T-002");
      const after = await configOf(root);
      expect(t.status).toBe("open");
      expect(verificationOf(t).decision).toEqual(after.setupVerification.components[0]!.decision);
      expect(verificationOf(t).decision).toMatchObject(kind === "adapter"
        ? { kind, adapter: { argv: ["sh", REPLAY, "vitest-pass"], drop: [] }, ownerWords: OWNER }
        : { kind, ownerWords: "not now" });
      expect(verificationOf(t).result).toBeUndefined();
      expect(after.setupVerification.components[0]!.test.status).toBe("pending");
      expect(after.recipeOverrides).toEqual(before.recipeOverrides);
    }
  });

  it("the adapter's argv runs with no shell, and the next plain run uses it", async () => {
    const root = await ready(replay("jest-pass"));
    const run = await stoppedRun(root);
    // The fixture checks it received the literal $HOME and exits 97 before any evidence otherwise; a shell would have expanded it.
    const literal = ["sh", REPLAY, "vitest-pass", "expect-literal", "$HOME"];
    expect(spawnSync("sh", ["-c", literal.map((w) => (w === "$HOME" ? w : `'${w}'`)).join(" ")], { env: { PATH: "/usr/bin:/bin", HOME: "/home/someone" } }).status).toBe(97);
    expect((await setupVerify(root, { ticket: "T-002", resolve: "adapter", argv: literal, ownerWords: OWNER, run })).exitCode).toBe(0);
    expect(await setupVerify(root, { ticket: "T-002" })).toEqual({ exitCode: 0, lines: ["Verified: app test (vitest, 2 tests); stages on: TEST"] });
    expect((await configOf(root)).recipeOverrides.stages.TEST).toMatchObject({ command: replay("jest-pass") });
  });

  it("stop records the decision only: a later run still runs", async () => {
    const root = await ready(replay("jest-pass"));
    const run = await stoppedRun(root);
    expect((await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "later", run })).lines).toEqual(["Decision recorded for T-002: stop. Nothing else changed."]);
    // It runs again and stops again, under a new token: the decision is part of what the run depends on.
    expect(await stoppedRun(root)).not.toBe(run);
  });

  it("leave-off closes the ticket with result left-off, leaves the component off and the stages unchanged", async () => {
    const root = await ready(replay("jest-pass"));
    const run = await stoppedRun(root);
    const before = await configOf(root);
    expect(await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "no tests for now", run }))
      .toEqual({ exitCode: 0, lines: ["Left off: app test; T-002 is complete and the stages are unchanged."] });
    const t = await ticketFile(root, "T-002");
    const after = await configOf(root);
    expect(t.status).toBe("complete");
    expect(t.completedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(verificationOf(t).result).toMatchObject({ status: "left-off" });
    expect(verificationOf(t).decision).toMatchObject({ kind: "leave-off", ownerWords: "no tests for now" });
    expect(after.setupVerification.components[0]!.decision).toEqual(verificationOf(t).decision);
    expect(after.setupVerification.components[0]!.test.status).toBe("left-off");
    expect(after.recipeOverrides).toEqual(before.recipeOverrides);
  });

  it("is the same through the CLI and MCP", async () => {
    const cliRoot = await ready(replay("jest-pass"));
    const cli = await handleSetupVerify({ cwd: cliRoot, env: process.env }, { ticket: "T-002", resolve: "leave-off", ownerWords: "skip", run: await stoppedRun(cliRoot, process.env) });
    expect([cli.exitCode, cli.stdout.split("\n")[0]]).toEqual([0, "Left off: app test; T-002 is complete and the stages are unchanged."]);

    const mcpRoot = await ready(replay("jest-pass"));
    const { tools, server } = makeRegistry();
    registerAllTools(server, mcpRoot);
    const tool = tools.get("storybloq_setup_verify")!;
    const stopped = (await tool.handler({ ticket: "T-002" })).content[0]!.text.split("\n");
    expect(stopped[0]).toBe("[exit 4]");
    const run = /\(run ([0-9a-f]{16})\)\.?$/.exec(stopped[1]!)![1]!;
    const out = await tool.handler({ ticket: "T-002", resolve: "adapter", argv: ["sh", REPLAY, "vitest-pass"], ownerWords: OWNER, run });
    expect(out.content[0]!.text.split("\n")[0]).toBe("[exit 0]");
    expect((await tool.handler({ ticket: "T-002" })).content[0]!.text.split("\n").slice(0, 2)).toEqual(["[exit 0]", "Verified: app test (vitest, 2 tests); stages on: TEST"]);
    expect(verificationOf(await ticketFile(mcpRoot, "T-002")).decision).toMatchObject({ kind: "adapter" });
  });
});

/** Drives the real `setup-verify` yargs command in-process, as the CLI does. */
async function runCli(root: string, args: string[]): Promise<{ stdout: string; exitCode: number | undefined }> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write;
  const origCwd = process.cwd();
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; };
  let exitCode: number | undefined;
  try {
    process.chdir(root);
    process.exitCode = undefined;
    await registerSetupVerifyCommand(yargs(args)).exitProcess(false).fail(false).parseAsync();
    exitCode = process.exitCode as number | undefined;
  } finally {
    process.stdout.write = origWrite;
    process.chdir(origCwd);
    process.exitCode = origExit;
  }
  return { stdout: chunks.join(""), exitCode };
}

describe("the CLI flags", () => {
  it("--resolve adapter with repeated --argv (a dash word by =), --owner-words, then --reopen", async () => {
    const root = await ready(replay("jest-pass"));
    const first = await runCli(root, ["setup-verify", "--ticket", "T-002"]);
    expect(first.exitCode).toBe(4);
    const run = /\(run ([0-9a-f]{16})\)\.?$/.exec(first.stdout.split("\n")[0]!)![1]!;
    const r = await runCli(root, ["setup-verify", "--ticket", "T-002", "--resolve", "adapter", "--argv", "sh", `--argv=${REPLAY}`, "--argv=vitest-pass", "--argv=-x", "--owner-words", "run it directly", "--run", run]);
    expect(r.exitCode).toBe(0);
    expect(verificationOf(await ticketFile(root, "T-002")).decision).toMatchObject({ kind: "adapter", adapter: { argv: ["sh", REPLAY, "vitest-pass", "-x"], drop: [] }, ownerWords: "run it directly" });
    const verified = await runCli(root, ["setup-verify", "--ticket", "T-002"]);
    expect([verified.exitCode, verified.stdout.split("\n")[0]]).toEqual([0, "Verified: app test (vitest, 2 tests); stages on: TEST"]);

    const other = await ready(replay("vitest-pass"));
    await closeOutside(other);
    const reopened = await runCli(other, ["setup-verify", "--ticket", "T-002", "--reopen"]);
    expect([reopened.exitCode, reopened.stdout.split("\n")[0]]).toEqual([0, "Reopened: T-002 is open; run storybloq setup-verify --ticket T-002."]);
    const stopped = await runCli(other, ["setup-verify", "--ticket", "T-002", "--resolve", "stop"]);
    expect([stopped.exitCode, stopped.stdout]).toEqual([2, "Setup-verify refused: a resolution records the owner's words: pass --owner-words.\n"]);
  });
});

describe("resolution refusals (exit 2, nothing written)", () => {
  async function refused(root: string, input: SetupVerifyInput, line: string | RegExp, env?: NodeJS.ProcessEnv): Promise<void> {
    const before = await files(root);
    const r = await setupVerify(root, input, env === undefined ? {} : { env });
    expect(r.exitCode).toBe(2);
    if (typeof line === "string") expect(r.lines).toEqual([line]);
    else expect(r.lines.join("\n")).toMatch(line);
    expect(await files(root)).toEqual(before);
  }

  it.each<[string, SetupVerifyInput, string]>([
    ["no owner words", { ticket: "T-002", resolve: "stop" }, "Setup-verify refused: a resolution records the owner's words: pass --owner-words."],
    ["blank owner words", { ticket: "T-002", resolve: "leave-off", ownerWords: "  " }, "Setup-verify refused: a resolution records the owner's words: pass --owner-words."],
    ["an empty argv", { ticket: "T-002", resolve: "adapter", argv: [], ownerWords: "x" }, "Setup-verify refused: an adapter needs a command: pass --argv with at least one word."],
    ["no argv", { ticket: "T-002", resolve: "adapter", ownerWords: "x" }, "Setup-verify refused: an adapter needs a command: pass --argv with at least one word."],
    ["an empty word", { ticket: "T-002", resolve: "adapter", argv: ["npx", ""], ownerWords: "x" }, "Setup-verify refused: an adapter's argv has an empty word."],
    ["argv without an adapter", { ticket: "T-002", resolve: "stop", argv: ["npx"], ownerWords: "x" }, "Setup-verify refused: --argv and --drop go with --resolve adapter."],
    ["an unknown drop", { ticket: "T-002", resolve: "adapter", argv: ["npx"], drop: ["PATH"], ownerWords: "x" }, "Setup-verify refused: --drop names PATH; an adapter drops only PYTEST_ADDOPTS or GOFLAGS."],
    ["resolve with reopen", { ticket: "T-002", resolve: "stop", reopen: true, ownerWords: "x" }, "Setup-verify refused: --resolve and --reopen do not go together."],
    ["owner words alone", { ticket: "T-002", ownerWords: "x" }, "Setup-verify refused: --owner-words goes with --resolve."],
  ])("%s", async (_name, input, line) => {
    await refused(await ready(replay("jest-pass")), input, line);
  });

  it("a drop of a variable the spec's runner does not read", async () => {
    await refused(await ready(replay("pytest-pass"), "pytest"), { ticket: "T-002", resolve: "adapter", argv: ["pytest"], drop: ["GOFLAGS"], ownerWords: "x", run: NO_RUN },
      "Setup-verify refused: --drop names GOFLAGS, which pytest does not read; a pytest adapter drops only PYTEST_ADDOPTS.");
    await refused(await ready(replay("jest-pass")), { ticket: "T-002", resolve: "adapter", argv: ["npx"], drop: ["PYTEST_ADDOPTS"], ownerWords: "x", run: NO_RUN },
      "Setup-verify refused: --drop names PYTEST_ADDOPTS, which vitest does not read; a vitest adapter drops nothing.");
  });

  it("a drop when the unreadable run did not come from an incompatible inherited option", async () => {
    const root = await ready(replay("pytest-pass"), "pytest");
    await refused(root, { ticket: "T-002", resolve: "adapter", argv: ["pytest"], drop: ["PYTEST_ADDOPTS"], ownerWords: "x", run: NO_RUN },
      "Setup-verify refused: --drop PYTEST_ADDOPTS: PYTEST_ADDOPTS does not conflict with the evidence options here, so the unreadable run did not come from it; drop nothing.",
      { ...process.env, PYTEST_ADDOPTS: "-q" });
  });

  it("verified is terminal: leave-off, adapter, stop and reopen are refused", async () => {
    const root = await ready(replay("vitest-pass"));
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
    for (const input of [
      { ticket: "T-002", resolve: "leave-off", ownerWords: "x" },
      { ticket: "T-002", resolve: "adapter", argv: ["npx"], ownerWords: "x" },
      { ticket: "T-002", resolve: "stop", ownerWords: "x" },
    ] as SetupVerifyInput[]) await refused(root, input, "Setup-verify refused: app's test stage is already verified.");
    await refused(root, { ticket: "T-002", reopen: true }, "Setup-verify refused: T-002 is already verified.");
  });

  it("left-off is terminal: a run, a resolution and reopen are refused", async () => {
    const root = await ready(replay("jest-pass"));
    expect((await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "x", run: await stoppedRun(root) })).exitCode).toBe(0);
    await refused(root, { ticket: "T-002" }, "Setup-verify refused: app's test stage is already left off.");
    await refused(root, { ticket: "T-002", resolve: "stop", ownerWords: "x" }, "Setup-verify refused: app's test stage is already left off.");
    await refused(root, { ticket: "T-002", reopen: true }, "Setup-verify refused: T-002 is already left off.");
  });

  it("terminality is read on the record's component too, whichever ticket asks", async () => {
    const root = await ready(replay("vitest-pass"));
    const path = join(root, ".story", "config.json");
    const c = JSON.parse(await readFile(path, "utf-8")) as { setupVerification: { components: Array<{ test: { status: string } }> } };
    c.setupVerification.components[0]!.test.status = "verified";
    await writeFile(path, JSON.stringify(c, null, 2) + "\n");
    for (const input of [
      { ticket: "T-002" },
      { ticket: "T-002", resolve: "leave-off", ownerWords: "x" },
      { ticket: "T-002", resolve: "adapter", argv: ["npx"], ownerWords: "x" },
    ] as SetupVerifyInput[]) await refused(root, input, "Setup-verify refused: app's test stage is already verified.");
  });

  it("the active-setup refusal comes first for every resolution and reopen, on both transports", async () => {
    const root = await folder();
    faultOnce("step:config");
    expect((await setupApply(root, payload({ components: [comp({ command: replay("vitest-pass") })] }))).exitCode).toBe(3);
    const line = `Setup refused: finish or stop the setup first: storybloq setup-apply --setup ${SID} --resume`;
    const inputs: SetupVerifyInput[] = [
      { ticket: "T-002", resolve: "adapter", argv: ["npx"], ownerWords: "x" },
      { ticket: "T-002", resolve: "leave-off", ownerWords: "x" },
      { ticket: "T-002", resolve: "stop", ownerWords: "x" },
      { ticket: "T-002", reopen: true },
    ];
    const { tools, server } = makeRegistry();
    registerAllTools(server, root);
    for (const input of inputs) {
      await refused(root, input, line);
      const out = await tools.get("storybloq_setup_verify")!.handler({ ...input });
      expect(out.content[0]!.text).toBe(`[exit 2]\n${line}\n`);
    }
  });

  it("a superseded ticket is refused for every operation, and the winner stays byte-equal", async () => {
    const root = await ready(replay("vitest-pass"));
    const raw = JSON.parse(await ticketBytes(root, "T-002")) as Record<string, unknown>;
    await writeFile(join(root, ".story", "tickets", "T-009.json"), JSON.stringify({ ...raw, id: "T-009", displayId: "T-009", status: "complete", completedDate: "2026-10-18", setup: { ...(raw.setup as object), supersededBy: "T-002" } }, null, 2) + "\n");
    const before = await files(root);
    for (const input of [
      { ticket: "T-009" },
      { ticket: "T-009", resolve: "adapter", argv: ["npx"], ownerWords: "x" },
      { ticket: "T-009", resolve: "leave-off", ownerWords: "x" },
      { ticket: "T-009", resolve: "stop", ownerWords: "x" },
      { ticket: "T-009", reopen: true },
    ] as SetupVerifyInput[]) {
      expect(await setupVerify(root, input)).toEqual({ exitCode: 2, lines: ["Setup-verify refused: T-009 was superseded by T-002; its key K3 belongs to that ticket."] });
    }
    expect(await files(root)).toEqual(before);
  });

  describe("ownership", () => {
    async function asSam<T>(fn: () => Promise<T>): Promise<T> {
      await writeFile(join(home(), "gitconfig"), "[user]\n\temail = sam@example.com\n");
      try {
        return await fn();
      } finally {
        await writeFile(join(home(), "gitconfig"), "");
      }
    }

    it("a foreign claim is refused for leave-off, adapter and stop", async () => {
      const root = await ready(replay("jest-pass"));
      await editTicket(root, "T-002", (r) => { r.status = "inprogress"; r.claim = { user: "rival@example.com", branch: "rival", since: "2026-10-18" }; });
      for (const input of [
        { ticket: "T-002", resolve: "leave-off", ownerWords: "x", run: NO_RUN },
        { ticket: "T-002", resolve: "adapter", argv: ["npx"], ownerWords: "x", run: NO_RUN },
        { ticket: "T-002", resolve: "stop", ownerWords: "x", run: NO_RUN },
      ] as SetupVerifyInput[]) {
        await asSam(() => refused(root, input, "Setup-verify refused: Cannot complete T-002: it is claimed by rival@example.com and this caller cannot prove ownership."));
      }
    });

    it("a foreign session stamp is refused for leave-off", async () => {
      const root = await ready(replay("jest-pass"));
      await editTicket(root, "T-002", (r) => { r.status = "inprogress"; r.claim = { user: "sam@example.com", branch: "main", since: "2026-10-18" }; r.claimedBySession = "11111111-2222-3333-4444-555555555555"; });
      await asSam(() => refused(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "x", run: NO_RUN }, /^Setup-verify refused: Cannot complete T-002: /));
    });

    it("a malformed session store fails closed for leave-off and reopen", async () => {
      const root = await ready(replay("jest-pass"));
      const dir = join(root, ".story", "sessions", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "state.json"), "{ not json");
      await refused(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "x", run: NO_RUN }, /^Setup-verify refused: ownership cannot be verified: /);
      await closeOutside(root);
      const before = await files(root);
      expect((await setupVerify(root, { ticket: "T-002", reopen: true })).lines[0]).toMatch(/^Setup-verify refused: ownership cannot be verified: /);
      expect(await files(root)).toEqual(before);
    });

    it("reopen with a foreign claim, or a foreign session stamp, on the completed ticket is refused", async () => {
      const root = await ready(replay("vitest-pass"));
      await editTicket(root, "T-002", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; r.claim = { user: "rival@example.com", branch: "rival", since: "2026-10-18" }; });
      await asSam(() => refused(root, { ticket: "T-002", reopen: true }, "Setup-verify refused: Cannot reopen T-002: it is complete and this caller cannot prove ownership."));
      await editTicket(root, "T-002", (r) => { r.claim = { user: "sam@example.com", branch: "main", since: "2026-10-18" }; r.claimedBySession = "11111111-2222-3333-4444-555555555555"; });
      await asSam(() => refused(root, { ticket: "T-002", reopen: true }, "Setup-verify refused: Cannot reopen T-002: it is complete and this caller cannot prove ownership."));
    });
  });
});

describe("the lifecycle", () => {
  it("an inprogress establishment ticket (as /story auto leaves it) verifies", async () => {
    const root = await ready(replay("vitest-pass"));
    await editTicket(root, "T-002", (r) => { r.status = "inprogress"; });
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
  });

  it("closed without verification, then reopen, then verify", async () => {
    const root = await ready(replay("vitest-pass"));
    await closeOutside(root);
    expect((await setupVerify(root, { ticket: "T-002" })).lines).toEqual(["Setup-verify refused: T-002 is complete without a verification result; reopen it with storybloq setup-verify --ticket T-002 --reopen."]);
    expect(await setupVerify(root, { ticket: "T-002", reopen: true })).toEqual({ exitCode: 0, lines: ["Reopened: T-002 is open; run storybloq setup-verify --ticket T-002."] });
    const t = await ticketFile(root, "T-002");
    expect([t.status, t.completedDate]).toEqual(["open", null]);
    expect(verificationOf(t).reopened).toHaveLength(1);
    expect((await configOf(root)).setupVerification.components[0]!.test.status).toBe("pending");
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
    expect(verificationOf(await ticketFile(root, "T-002")).reopened).toHaveLength(1);
  });

  it("reopen is refused for a ticket that is not complete", async () => {
    const root = await ready(replay("vitest-pass"));
    const before = await files(root);
    expect(await setupVerify(root, { ticket: "T-002", reopen: true })).toEqual({ exitCode: 2, lines: ["Setup-verify refused: T-002 is open, not complete; there is nothing to reopen."] });
    expect(await files(root)).toEqual(before);
  });

  it("reopen through MCP", async () => {
    const root = await ready(replay("vitest-pass"));
    await closeOutside(root);
    const { tools, server } = makeRegistry();
    registerAllTools(server, root);
    expect((await tools.get("storybloq_setup_verify")!.handler({ ticket: "T-002", reopen: true })).content[0]!.text.split("\n").slice(0, 2)).toEqual(["[exit 0]", "Reopened: T-002 is open; run storybloq setup-verify --ticket T-002."]);
    expect((await ticketFile(root, "T-002")).status).toBe("open");
  });
});
