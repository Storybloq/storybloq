/**
 * ISS-1290: the `arrangement rebind` subcommand forwards every flag to the
 * core. The predecessor pen is a Claude task while the call asks for Codex,
 * and the ambient task id differs from the explicit caller, so a dropped
 * `--client` or `--client-task-id` cannot pass unnoticed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { initProject } from "../../../src/core/init.js";
import { registerArrangementCommand } from "../../../src/cli/register.js";

const id = "a-0123456789abcdef";
const dirs: string[] = [];
const originalCwd = process.cwd();
afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "arrangement-rebind-cli-"));
  dirs.push(root);
  await initProject(root, { name: "rebind-cli" });
  await mkdir(join(root, ".story/arrangements"), { recursive: true });
  await writeFile(join(root, `.story/arrangements/${id}.json`), JSON.stringify({
    id, lifecycle: "active", bounds: ["ISS-1290"], gates: [],
    parties: [{ role: "pen", client: "claude", identityAnchor: "old-pen" }, { role: "worker", client: "codex", identityAnchor: "worker" }],
    unreachability: { onIrreversibleWork: "hold" }, createdDate: "2026-09-10", updatedAt: "2026-09-10T00:00:00.000Z",
  }));
  vi.stubEnv("STORYBLOQ_CLIENT", "codex");
  vi.stubEnv("CODEX_THREAD_ID", "ambient-task");
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  process.chdir(root);
  return root;
}
function captureOutput(): string[] {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { output.push(String(s)); return true; }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { output.push(String(s)); return true; }) as any);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
  return output;
}
const parse = (args: string[]) => registerArrangementCommand(yargs().exitProcess(false)).parseAsync(["arrangement", "rebind", id, ...args]);
const flags = ["--role", "pen", "--to", "new-pen", "--client", "codex", "--evidence", "owner said", "--client-task-id", "new-pen"];

describe("arrangement rebind CLI", () => {
  it("C1: forwards role, target, target client, evidence and the explicit caller; JSON output", async () => {
    const root = await fixture();
    const output = captureOutput();
    await parse([...flags, "--format", "json"]);
    expect(process.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(output.join(""));
    const predecessor = JSON.parse(await readFile(join(root, `.story/arrangements/${id}.json`), "utf-8"));
    expect(predecessor.continuedBy).toBe(payload.data.successor);
    const successor = JSON.parse(await readFile(join(root, `.story/arrangements/${payload.data.successor}.json`), "utf-8"));
    expect(successor.parties.find((p: any) => p.role === "pen")).toEqual({ role: "pen", client: "codex", identityAnchor: "new-pen" });
    expect(successor.rebind.recordedBy).toEqual({ client: "codex", id: "new-pen" });
    expect(successor.rebind.recordedBy.id).not.toBe("ambient-task");
    expect(successor.rebind.evidence).toBe("owner said");
    expect(payload.data.coordinationSession).toBeNull();
  });

  it("C2: Markdown output", async () => {
    await fixture();
    const output = captureOutput();
    await parse([...flags, "--format", "md"]);
    expect(process.exitCode ?? 0).toBe(0);
    const text = output.join("");
    expect(text).toContain("Rebound pen of");
    expect(text).toContain("Liveness is machine-local: a pen on another machine reads as not live");
  });

  it("C3: a missing --evidence is refused by the parser and nothing changes", async () => {
    const root = await fixture();
    const predecessorBytes = await readFile(join(root, `.story/arrangements/${id}.json`));
    const output = captureOutput();
    let error: unknown;
    try {
      await parse(["--role", "pen", "--to", "new-pen", "--client-task-id", "new-pen", "--format", "json"]);
    } catch (err) {
      error = err;
    }
    const said = `${error === undefined ? "" : String(error)}${output.join("")}`;
    expect(error !== undefined || (process.exitCode ?? 0) !== 0).toBe(true);
    expect(said).toMatch(/evidence/i);
    expect(await readdir(join(root, ".story/arrangements"))).toEqual([`${id}.json`]);
    expect((await readFile(join(root, `.story/arrangements/${id}.json`))).equals(predecessorBytes)).toBe(true);
  });
});
