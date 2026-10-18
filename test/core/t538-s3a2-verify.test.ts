/**
 * T-538 S3a-2 commit 7: `storybloq setup-verify --ticket <id>`, the run.
 * The component's command replays a recorded real runner output
 * (__fixtures__/t538-runner-output) with its recorded exit code, so each
 * verdict is the runner's own words; live runners come with the resolutions.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setupApply } from "../../src/core/setup-apply.js";
import { evidenceEnv, setupVerify, setupVerifySeams } from "../../src/core/setup-verify.js";
import { processGroupSeams } from "../../src/core/process-group.js";
import { handleSetupVerify } from "../../src/cli/commands/setup-verify.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { SID, comp, editTicket, faultOnce, makeRegistry, payload, pinEnvironment, ticketFile } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 30_000 });
const { home, folder } = pinEnvironment("t538-s3a2v");

const REPLAY = join(import.meta.dirname, "fixtures", "t538-replay.sh");
/** One invocation (a setup's test command is one) that prints a recorded output and exits with the recorded code. */
const replay = (name: string, extra = ""): string => `sh ${REPLAY} ${name}${extra === "" ? "" : ` ${extra}`}`;

const realProbe = processGroupSeams.probe;
afterEach(() => {
  setupVerifySeams.afterRun = () => {};
  processGroupSeams.probe = realProbe;
});

const files = async (root: string) => ({
  ticket: await readFile(join(root, ".story", "tickets", "T-002.json"), "utf-8"),
  config: await readFile(join(root, ".story", "config.json"), "utf-8"),
});

/** A finished setup whose component runs `command`, with the scaffold (T-001) built. */
async function ready(command: string, runner = "vitest"): Promise<string> {
  const root = await folder();
  expect((await setupApply(root, payload({ components: [comp({ command, runner })] }))).exitCode).toBe(0);
  await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
  return root;
}

const configOf = async (root: string) => JSON.parse(await readFile(join(root, ".story", "config.json"), "utf-8")) as {
  setupVerification: { components: Array<{ test: { status: string } }> };
  recipeOverrides: { stages: Record<string, { enabled?: boolean; command?: string }> };
};

describe("a verified run", () => {
  it("completes the ticket, records the result, and turns the served stages on in one write", async () => {
    const root = await ready(replay("vitest-pass"));
    const before = await configOf(root);
    expect(before.setupVerification.components[0]!.test.status).toBe("pending");
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r).toEqual({ exitCode: 0, lines: ["Verified: app test (vitest, 2 tests); stages on: TEST"] });
    const t = await ticketFile(root, "T-002");
    expect(t.status).toBe("complete");
    expect(t.completedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const result = (t.setup as { verification: { result: { status: string; counts: unknown; tailDigest: string; at: string } } }).verification.result;
    expect(result).toMatchObject({ status: "verified", counts: { executed: 2, failed: 0 } });
    expect(result.tailDigest).toMatch(/^[0-9a-f]{64}$/);
    const after = await configOf(root);
    expect(after.setupVerification.components[0]!.test.status).toBe("verified");
    expect(after.recipeOverrides.stages.TEST).toMatchObject({ enabled: true, command: replay("vitest-pass") });
    // tests-only turns TEST on; WRITE_TESTS stays as the level has it (quality matrix).
    expect(after.recipeOverrides.stages.WRITE_TESTS).toEqual(before.recipeOverrides.stages.WRITE_TESTS);
    // Nothing else in the config moved.
    const strip = (c: Record<string, unknown>) => ({ ...c, setupVerification: null, recipeOverrides: { ...(c.recipeOverrides as object), stages: { ...(c.recipeOverrides as { stages: object }).stages, TEST: null, WRITE_TESTS: null } } });
    expect(strip(after as unknown as Record<string, unknown>)).toEqual(strip(before as unknown as Record<string, unknown>));
  });

  it("is the same through the CLI and MCP, and MCP's first line is the exit code", async () => {
    const cliRoot = await ready(replay("cargo-pass"), "cargo");
    const cli = await handleSetupVerify({ cwd: cliRoot, env: process.env }, { ticket: "T-002" });
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.split("\n")[0]).toBe("Verified: app test (cargo, 2 tests); stages on: TEST");

    const mcpRoot = await ready(replay("cargo-pass"), "cargo");
    const { tools, server } = makeRegistry();
    registerAllTools(server, mcpRoot);
    const out = await tools.get("storybloq_setup_verify")!.handler({ ticket: "T-002" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text.split("\n").slice(0, 2)).toEqual(["[exit 0]", "Verified: app test (cargo, 2 tests); stages on: TEST"]);
    expect((await ticketFile(mcpRoot, "T-002")).status).toBe("complete");
  });

  it("refuses a second run once verified, on the ticket and on the component", async () => {
    const root = await ready(replay("vitest-pass"));
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
    expect(await setupVerify(root, { ticket: "T-002" })).toEqual({ exitCode: 2, lines: ["Setup-verify refused: app's test stage is already verified."] });
    await editTicket(root, "T-002", (r) => { r.status = "open"; r.completedDate = null; });
    expect((await setupVerify(root, { ticket: "T-002" })).lines).toEqual(["Setup-verify refused: app's test stage is already verified."]);
  });

  it("runs the spec's command through the shell, as written (the quotes are the shell's)", async () => {
    const root = await ready(`sh '${REPLAY}' 'vitest-pass'`);
    expect(await setupVerify(root, { ticket: "T-002" })).toEqual({ exitCode: 0, lines: ["Verified: app test (vitest, 2 tests); stages on: TEST"] });
  });

  it("rebuilds only the served stages: every other stage and every other field of a served one stay as they were", async () => {
    const root = await ready(replay("vitest-pass"));
    const path = join(root, ".story", "config.json");
    const c = JSON.parse(await readFile(path, "utf-8")) as { recipeOverrides: { stages: Record<string, Record<string, unknown>> } };
    const others = Object.keys(c.recipeOverrides.stages).filter((k) => k !== "TEST" && k !== "WRITE_TESTS");
    expect(others.length).toBeGreaterThan(0);
    for (const k of others) c.recipeOverrides.stages[k]!.enabled = !(c.recipeOverrides.stages[k]!.enabled === true);
    c.recipeOverrides.stages.TEST = { ...(c.recipeOverrides.stages.TEST ?? {}), onExhaustion: "stop" };
    await writeFile(path, JSON.stringify(c, null, 2) + "\n");
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
    const after = (await configOf(root)) as unknown as typeof c;
    for (const k of others) expect(after.recipeOverrides.stages[k]).toEqual(c.recipeOverrides.stages[k]);
    expect(after.recipeOverrides.stages.TEST).toMatchObject({ enabled: true, onExhaustion: "stop" });
  });
});

describe("a run that does not verify writes nothing", () => {
  it.each<[string, string, number, RegExp]>([
    ["vitest", "vitest-fail", 1, /^Verification failed: app test \(vitest\): the run reported a failure; 2 run, 1 failed\. T-002 stays as it was\.$/],
    ["vitest", "vitest-none", 1, /^Verification failed: app test \(vitest\): exited with code 1; 0 run, 0 failed\. T-002 stays as it was\.$/],
    ["vitest", "vitest-none-pass", 1, /^Verification found no tests: app test \(vitest\) ran 0 tests\. T-002 stays as it was\.$/],
    ["go", "go-build", 1, /^Verification failed: app test \(go\): the run reported an error/],
    ["vitest", "jest-pass", 4, /^Setup-verify stopped: the evidence of T-002's run cannot be read; nothing was written\.$/],
  ])("%s replaying %s exits %i", async (runner, name, code, first) => {
    const root = await ready(replay(name), runner);
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(code);
    expect(r.lines[0]).toMatch(first);
    expect(r.lines.slice(code === 4 ? 2 : 1).every((l) => l.startsWith("  | "))).toBe(true);
    expect(await files(root)).toEqual(before);
  });

  it("an unreadable run names the class and the three resolutions", async () => {
    const root = await ready(replay("jest-pass"));
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.lines[1]).toBe("Ambiguity: verification evidence unreadable · T-002 · observed the output carries jest summaries as well as vitest's; expected one vitest summary · resolutions: adapter | leave-off | stop");
  });

  it("the deadline is the spec's: a run past it fails as timed out", async () => {
    const root = await ready("sleep 20");
    await editTicket(root, "T-002", (r) => { ((r.setup as { verification: { spec: { timeoutMs: number } } }).verification.spec.timeoutMs = 300); });
    const before = await files(root);
    const started = Date.now();
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.lines[0]).toMatch(/^Verification failed: app test \(vitest\): timed out after 300 ms\./);
    expect(r.exitCode).toBe(1);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await files(root)).toEqual(before);
  });

  it("a group whose cleanup cannot be confirmed is exit 5 and writes nothing, even after a passing run", async () => {
    const root = await ready(replay("vitest-pass"));
    processGroupSeams.probe = () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    expect(r.exitCode).toBe(5);
    expect(r.lines[0]).toMatch(/^Setup-verify stopped: cleanup unconfirmed: kill\(-\d+, 0\) answered EPERM 2000 ms after the last signal; nothing was written\.$/);
    expect(await files(root)).toEqual(before);
  });
});

describe("refusals before anything runs (exit 2)", () => {
  async function refused(root: string, ticket: string, line: string | RegExp): Promise<void> {
    const marker = join(root, "ran");
    const before = await files(root);
    const r = await setupVerify(root, { ticket });
    expect(r.exitCode).toBe(2);
    if (typeof line === "string") expect(r.lines).toEqual([line]);
    else expect(r.lines.join("\n")).toMatch(line);
    expect(existsSync(marker)).toBe(false);
    expect(await files(root)).toEqual(before);
  }
  
  it("while the setup that created the ticket is unfinished, on both transports", async () => {
    const root = await folder();
    faultOnce("step:config");
    expect((await setupApply(root, payload({ components: [comp({ command: "touch ran" })] }))).exitCode).toBe(3);
    const line = `Setup refused: finish or stop the setup first: storybloq setup-apply --setup ${SID} --resume`;
    await refused(root, "T-002", line);
    const { tools, server } = makeRegistry();
    registerAllTools(server, root);
    const out = await tools.get("storybloq_setup_verify")!.handler({ ticket: "T-002" });
    expect(out.content[0]!.text).toBe(`[exit 2]\n${line}\n`);
  });

  it("a ticket that is not an establishment, or not in the project", async () => {
    const root = await ready("touch ran");
    await refused(root, "T-003", "Setup-verify refused: T-003 is not an establishment ticket; setup-verify runs only on a ticket a setup created to establish a test stage.");
    await refused(root, "T-404", "Setup-verify refused: no ticket T-404 in this project.");
  });

  it("while the scaffold it waits on is not complete", async () => {
    const root = await folder();
    expect((await setupApply(root, payload({ components: [comp({ command: "touch ran" })] }))).exitCode).toBe(0);
    await refused(root, "T-002", "Setup-verify refused: T-002 waits on T-001, which is not complete.");
  });

  it("while anything further back in the closure is not complete", async () => {
    const root = await ready("touch ran");
    await editTicket(root, "T-001", (r) => { r.blockedBy = ["T-003"]; });
    await refused(root, "T-002", "Setup-verify refused: T-002 waits on T-003, which is not complete.");
  });

  it("with no record, an invalid one, or one from another setup", async () => {
    const root = await ready("touch ran");
    const path = join(root, ".story", "config.json");
    const config = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const { setupVerification, ...rest } = config;
    await writeFile(path, JSON.stringify(rest, null, 2) + "\n");
    await refused(root, "T-002", "Setup-verify refused: this project's config has no setup verification record (.story/config.json setupVerification); it predates setup-verify.");
    await writeFile(path, JSON.stringify({ ...rest, setupVerification: { ...(setupVerification as object), version: 2 } }, null, 2) + "\n");
    await refused(root, "T-002", /^Setup-verify refused: the setup verification record in \.story\/config\.json does not read: version /);
    await writeFile(path, JSON.stringify({ ...rest, setupVerification: { ...(setupVerification as object), setupId: "SS-99999999" } }, null, 2) + "\n");
    await refused(root, "T-002", `Setup-verify refused: the setup verification record belongs to setup SS-99999999, not ${SID}.`);
  });

  it.each(["workdir", "command", "runner", "wrapper"] as const)("when the spec and the record disagree on the %s", async (field) => {
    const root = await ready(replay("vitest-pass"));
    const path = join(root, ".story", "config.json");
    const config = JSON.parse(await readFile(path, "utf-8")) as { setupVerification: { components: Array<Record<string, unknown> & { test: Record<string, unknown> }> } };
    const c = config.setupVerification.components[0]!;
    if (field === "workdir") c.workdir = "elsewhere";
    else c.test[field] = field === "command" ? "make test" : field === "runner" ? "jest" : "none";
    await writeFile(path, JSON.stringify(config, null, 2) + "\n");
    await refused(root, "T-002", new RegExp(`^Setup-verify refused: T-002's verification spec and the setup verification record disagree on the ${field} of app `));
  });

  it("a superseded ticket, and a key two active tickets carry", async () => {
    const root = await ready("touch ran");
    const raw = JSON.parse(await readFile(join(root, ".story", "tickets", "T-002.json"), "utf-8")) as Record<string, unknown>;
    await writeFile(join(root, ".story", "tickets", "T-009.json"), JSON.stringify({ ...raw, id: "T-009", displayId: "T-009" }, null, 2) + "\n");
    await refused(root, "T-002", "Setup-verify refused: T-002 is not the only active item with setup key K3 (T-002, T-009).");
    await editTicket(root, "T-009", (r) => { (r.setup as Record<string, unknown>).supersededBy = "T-002"; });
    await refused(root, "T-009", "Setup-verify refused: T-009 was superseded by T-002; its key K3 belongs to that ticket.");
  });

  it("a ticket complete without a result names --reopen", async () => {
    const root = await ready("touch ran");
    const path = join(root, ".story", "tickets", "T-002.json");
    const t = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...t, status: "complete", completedDate: "2026-10-18" }, null, 2) + "\n");
    await refused(root, "T-002", "Setup-verify refused: T-002 is complete without a verification result; reopen it with storybloq setup-verify --ticket T-002 --reopen.");
  });

  describe("ownership", () => {
    const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    async function asSam<T>(fn: () => Promise<T>): Promise<T> {
      await writeFile(join(home(), "gitconfig"), "[user]\n\temail = sam@example.com\n");
      try {
        return await fn();
      } finally {
        await rm(join(home(), "gitconfig"), { force: true });
      }
    }

    it("a claim by another user is refused", async () => {
      const root = await ready("touch ran");
      await editTicket(root, "T-002", (r) => { r.status = "inprogress"; r.claim = { user: "rival@example.com", branch: "rival", since: "2026-10-18" }; });
      await asSam(() => refused(root, "T-002", "Setup-verify refused: Cannot complete T-002: it is claimed by rival@example.com and this caller cannot prove ownership."));
    });

    it("the caller's claim stamped by another session is refused", async () => {
      const root = await ready("touch ran");
      await editTicket(root, "T-002", (r) => { r.status = "inprogress"; r.claim = { user: "sam@example.com", branch: "main", since: "2026-10-18" }; r.claimedBySession = "11111111-2222-3333-4444-555555555555"; });
      await asSam(() => refused(root, "T-002", /^Setup-verify refused: Cannot complete T-002: it is claimed by sam@example\.com and this caller cannot prove ownership\.$/));
    });

    for (const how of ["malformed", "unreadable"] as const) {
      it(`a ${how} session store entry fails closed, naming it`, async () => {
        const root = await ready("touch ran");
        const dir = join(root, ".story", "sessions", SESSION_ID);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "state.json"), how === "malformed" ? "{ not json" : JSON.stringify({ status: "active" }));
        if (how === "unreadable") await chmod(join(dir, "state.json"), 0o000);
        try {
          await refused(root, "T-002", new RegExp(`^Setup-verify refused: ownership cannot be verified: A session directory that may hold .*${SESSION_ID}`, "s"));
        } finally {
          await chmod(join(dir, "state.json"), 0o644);
        }
      });
    }

    it("the caller's own claim completes, and the claim goes with the completion", async () => {
      const root = await ready(replay("vitest-pass"));
      await editTicket(root, "T-002", (r) => { r.status = "inprogress"; r.claim = { user: "sam@example.com", branch: "main", since: "2026-10-18" }; });
      expect((await asSam(() => setupVerify(root, { ticket: "T-002" }))).exitCode).toBe(0);
      const t = await ticketFile(root, "T-002");
      expect([t.status, "claim" in t]).toEqual(["complete", false]);
    });
  });
});

describe("freshness: a change during the run is exit 5 with nothing written", () => {
  const changes: Array<[string, (root: string) => Promise<void>]> = [
    ["the ticket's claim", (root) => editTicket(root, "T-002", (r) => { r.claim = { user: "rival@example.com", branch: "b", since: "2026-10-18" }; })],
    ["a dependency", (root) => editTicket(root, "T-002", (r) => { r.blockedBy = ["T-001", "T-003"]; })],
    ["a prerequisite's status", (root) => editTicket(root, "T-001", (r) => { r.status = "inprogress"; r.completedDate = null; })],
    ["the metadata", (root) => editTicket(root, "T-002", (r) => { ((r.setup as { verification: Record<string, unknown> }).verification.decision = { kind: "stop", ownerWords: "wait", at: "2026-10-18T00:00:00Z" }); })],
    ["the setup unfinished again", async (root) => {
      const dir = join(root, ".story", "notes");
      for (const f of await readdir(dir)) {
        const raw = JSON.parse(await readFile(join(dir, f), "utf-8")) as { status: string; setup?: { record?: string } };
        if (raw.setup?.record !== "progress") continue;
        raw.status = "active";
        await writeFile(join(dir, f), JSON.stringify(raw, null, 2) + "\n");
      }
    }],
    ["a prerequisite's own prerequisites, still released", async (root) => {
      const raw = await ticketFile(root, "T-001");
      const { setup: _setup, ...rest } = raw;
      await writeFile(join(root, ".story", "tickets", "T-003.json"), JSON.stringify({ ...rest, id: "T-003", title: "an older piece of work" }, null, 2) + "\n");
      await editTicket(root, "T-001", (r) => { r.blockedBy = ["T-003"]; });
    }],
    ["a served stage", async (root) => {
      const path = join(root, ".story", "config.json");
      const c = JSON.parse(await readFile(path, "utf-8")) as { recipeOverrides: { stages: Record<string, Record<string, unknown>> } };
      c.recipeOverrides.stages.TEST = { ...(c.recipeOverrides.stages.TEST ?? {}), command: "npm run other" };
      await writeFile(path, JSON.stringify(c, null, 2) + "\n");
    }],
    ["the record", async (root) => {
      const path = join(root, ".story", "config.json");
      const c = JSON.parse(await readFile(path, "utf-8")) as { setupVerification: { components: Array<{ test: { command: string } }> } };
      c.setupVerification.components[0]!.test.command = "npm run other";
      await writeFile(path, JSON.stringify(c, null, 2) + "\n");
    }],
  ];

  it.each(changes)("%s", async (_name, change) => {
    const root = await ready(replay("vitest-pass"));
    setupVerifySeams.afterRun = () => change(root);
    const r = await setupVerify(root, { ticket: "T-002" });
    const after = await files(root);
    expect(r.exitCode).toBe(5);
    expect(r.lines[0]).toMatch(/^Setup-verify stale: .*; nothing was written\. Run storybloq setup-verify --ticket T-002 again\.$/);
    const t = JSON.parse(after.ticket) as { status: string; setup: { verification: Record<string, unknown> } };
    expect(t.setup.verification.result).toBeUndefined();
    expect(JSON.parse(after.config).setupVerification.components[0].test.status).toBe("pending");
  });
});

describe("the evidence environment", () => {
  it("appends to inherited options and never replaces them", () => {
    const pytest = evidenceEnv("pytest", { PYTEST_ADDOPTS: '-m "not slow" --ignore=x', PATH: "/bin" }, "/tmp/r/junit.xml");
    expect(pytest).toEqual({ env: { PATH: "/bin", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", PYTEST_ADDOPTS: `-m "not slow" --ignore=x --junitxml='/tmp/r/junit.xml'` } });
    expect(evidenceEnv("go", { GOFLAGS: "-tags=integration" }, "/x")).toEqual({ env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", GOFLAGS: "-tags=integration -v" } });
    expect(evidenceEnv("go", {}, "/x")).toEqual({ env: { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", GOFLAGS: "-v" } });
    expect(evidenceEnv("vitest", { GOFLAGS: "-json", PYTEST_ADDOPTS: "--junitxml=a" }, "/x")).toEqual({ env: { GOFLAGS: "-json", PYTEST_ADDOPTS: "--junitxml=a", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" } });
  });

  it.each<[string, Record<string, string>, string]>([
    ["pytest", { PYTEST_ADDOPTS: "--junitxml=/elsewhere.xml" }, "PYTEST_ADDOPTS already names a JUnit report (--junitxml)"],
    ["pytest", { PYTEST_ADDOPTS: "-q --junit-xml /elsewhere.xml" }, "PYTEST_ADDOPTS already names a JUnit report (--junitxml)"],
    ["pytest", { PYTEST_ADDOPTS: "-p no:junitxml" }, "PYTEST_ADDOPTS turns the JUnit report off (-p no:junitxml)"],
    ["go", { GOFLAGS: "-mod=mod -json" }, "GOFLAGS asks for JSON output (-json)"],
  ])("%s with %j is unreadable before anything runs", async (runner, extra, reason) => {
    const root = await ready(replay(runner === "go" ? "go-pass" : "pytest-pass", "touch"), runner);
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002" }, { env: { ...process.env, ...extra } });
    expect(r.exitCode).toBe(4);
    expect(r.lines[1]).toContain(`observed ${reason};`);
    expect(existsSync(join(root, "ran"))).toBe(false);
    expect(await files(root)).toEqual(before);
  });

  it("the command sees CI, NO_COLOR and FORCE_COLOR and the inherited options, appended", async () => {
    const root = await ready(replay("go-pass", "seen"), "go");
    expect((await setupVerify(root, { ticket: "T-002" }, { env: { ...process.env, GOFLAGS: "-tags=integration" } })).exitCode).toBe(0);
    expect(await readFile(join(root, "seen"), "utf-8")).toBe("1|1|0|-tags=integration -v\n");
  });
});
