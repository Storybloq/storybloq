/**
 * T-538 S3b commit 2: a resolution names the run it answers. A stopped
 * (exit 4) run prints `(run <16 hex>)` in its first line, the first 16 hex of
 * its stage digest over what the run depended on; `--resolve` requires
 * `--run` with that value, and a change since the run is stale (exit 5) with
 * nothing written. The token binds only the evidence variables of the
 * environment, so a resolution from another shell can name the run.
 */
import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setupApply } from "../../src/core/setup-apply.js";
import { runToken, setupVerify, stageDigest } from "../../src/core/setup-verify.js";
import { handleSetupVerify } from "../../src/cli/commands/setup-verify.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { comp, editTicket, makeRegistry, payload, pinEnvironment, ticketFile } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 30_000 });
const { folder } = pinEnvironment("t538-s3b-run");

const REPLAY = join(import.meta.dirname, "fixtures", "t538-replay.sh");
/** jest's output under a vitest spec: the evidence is unreadable, so the run stops with exit 4. */
const UNREADABLE = `sh ${REPLAY} jest-pass`;

const files = async (root: string) => ({
  ticket: await readFile(join(root, ".story", "tickets", "T-002.json"), "utf-8"),
  config: await readFile(join(root, ".story", "config.json"), "utf-8"),
});

async function ready(command = UNREADABLE): Promise<string> {
  const root = await folder();
  expect((await setupApply(root, payload({ components: [comp({ command })] }))).exitCode).toBe(0);
  await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
  return root;
}

const TOKEN = /\(run ([0-9a-f]{16})\)\.$/;

async function stopped(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const r = await setupVerify(root, { ticket: "T-002" }, { env });
  expect(r.exitCode).toBe(4);
  return TOKEN.exec(r.lines[0]!)![1]!;
}

describe("the run token", () => {
  it("is the first 16 hex of the stage digest, which names the stage", () => {
    const fields = { id: "t-1", key: "K3" };
    expect(runToken(stageDigest("test", fields))).toBe(stageDigest("test", fields).slice(0, 16));
    expect(stageDigest("build", fields)).not.toBe(stageDigest("test", fields));
  });

  it("is printed by a stopped run, and the same for the same state", async () => {
    const root = await ready();
    const first = await stopped(root);
    expect(await stopped(root)).toBe(first);
  });

  it("ignores variables outside the evidence, and binds the ones inside it", async () => {
    const root = await ready();
    const first = await stopped(root, { ...process.env, UNRELATED_SHELL_VAR: "a" });
    expect(await stopped(root, { ...process.env, UNRELATED_SHELL_VAR: "b" })).toBe(first);
    expect(await stopped(root, { ...process.env, GOFLAGS: "-tags=x" })).not.toBe(first);
  });

  it("answers its run: leave-off with the token completes the ticket", async () => {
    const root = await ready();
    const run = await stopped(root, { ...process.env, UNRELATED_SHELL_VAR: "a" });
    const r = await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "later", run }, { env: { ...process.env, UNRELATED_SHELL_VAR: "b" } });
    expect(r).toEqual({ exitCode: 0, lines: ["Left off: app test; T-002 is complete and the stages are unchanged."] });
  });
});

describe("a resolution without its run", () => {
  it("is refused without --run, nothing written", async () => {
    const root = await ready();
    await stopped(root);
    const before = await files(root);
    expect(await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "later" }))
      .toEqual({ exitCode: 2, lines: ["Setup-verify refused: a resolution answers one stopped run: pass --run with the value in the first line of T-002's stopped run."] });
    expect(await files(root)).toEqual(before);
  });

  it("refuses a malformed --run, and --run without --resolve", async () => {
    const root = await ready();
    expect(await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "x", run: "ABC" }))
      .toEqual({ exitCode: 2, lines: ["Setup-verify refused: --run takes the 16 hex a stopped run printed, not ABC."] });
    expect(await setupVerify(root, { ticket: "T-002", run: "0123456789abcdef" }))
      .toEqual({ exitCode: 2, lines: ["Setup-verify refused: --run goes with --resolve."] });
  });

  it("is stale (exit 5) with a token no run printed, nothing written", async () => {
    const root = await ready();
    const run = await stopped(root);
    const other = run.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const before = await files(root);
    expect(await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "x", run: other })).toEqual({
      exitCode: 5,
      lines: [`Setup-verify stale: the ticket, its prerequisites, the record, the stages or the ownership changed since run ${other}; nothing was written. Run storybloq setup-verify --ticket T-002 again.`],
    });
    expect(await files(root)).toEqual(before);
  });

  it("is stale after the ticket's metadata changes since the run, and the next run's token answers", async () => {
    const root = await ready();
    const run = await stopped(root);
    await editTicket(root, "T-002", (r) => { r.status = "inprogress"; });
    const before = await files(root);
    const r = await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "x", run });
    expect(r.exitCode).toBe(5);
    expect(await files(root)).toEqual(before);
    const again = await stopped(root);
    expect(again).not.toBe(run);
    expect((await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "x", run: again })).exitCode).toBe(0);
    expect((await ticketFile(root, "T-002")).status).toBe("inprogress");
  });

  it("is stale after a decision: a token answers its run once", async () => {
    const root = await ready();
    const run = await stopped(root);
    expect((await setupVerify(root, { ticket: "T-002", resolve: "stop", ownerWords: "x", run })).exitCode).toBe(0);
    expect((await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "y", run })).exitCode).toBe(5);
  });

  it("takes --run on the CLI handler and as MCP's run", async () => {
    const cliRoot = await ready();
    const cli = await handleSetupVerify({ cwd: cliRoot, env: process.env }, { ticket: "T-002", resolve: "stop", ownerWords: "x", run: await stopped(cliRoot) });
    expect([cli.exitCode, cli.stdout]).toEqual([0, expect.stringMatching(/^Decision recorded for T-002: stop\. Nothing else changed\.\n/)]);

    const mcpRoot = await ready();
    const { tools, server } = makeRegistry();
    registerAllTools(server, mcpRoot);
    const tool = tools.get("storybloq_setup_verify")!;
    const first = (await tool.handler({ ticket: "T-002" })).content[0]!.text.split("\n");
    expect(first[0]).toBe("[exit 4]");
    const run = TOKEN.exec(first[1]!)![1]!;
    expect((await tool.handler({ ticket: "T-002", resolve: "stop", ownerWords: "x", run })).content[0]!.text.split("\n")[0]).toBe("[exit 0]");
  });
});
