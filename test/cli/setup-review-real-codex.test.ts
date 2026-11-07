/**
 * ISS-1456, opt-in (STORYBLOQ_REAL_CODEX=1, binary at STORYBLOQ_REAL_CODEX_BIN):
 * the real codex binary as a test subject, never as a reviewer. Every row runs
 * with a scratch HOME, CODEX_HOME and TMPDIR, no credential but the probe's
 * dummy key, and the model provider at the probe's own 127.0.0.1 listener, so
 * no request leaves the machine. The sandbox is `codex sandbox` itself:
 * `:workspace` (workspace writes, networking off) and `:read-only`.
 * The ordinary suite never depends on this file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REVIEW_PACKET } from "../helpers/setup-review-fakes.js";

const REAL = process.env.STORYBLOQ_REAL_CODEX === "1";
const BIN = process.env.STORYBLOQ_REAL_CODEX_BIN ?? "";
const CLI = resolve(__dirname, "../../dist/cli.js");
const CHARACTERISED = "codex-cli 0.163.0";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Box {
  readonly root: string;
  readonly project: string;
  readonly store: string;
  readonly env: Record<string, string>;
}

/**
 * `inWorkspace`: the store under the sandbox's workspace root, which
 * `:workspace` lets the CLI write, so the row reaches the start probe. The
 * default store under the OS temp directory is outside it.
 */
function box(inWorkspace = false): Box {
  const root = mkdtempSync(join(tmpdir(), "sr-real-codex-"));
  roots.push(root);
  const bin = join(root, "bin");
  for (const d of ["bin", "home", "codex-home", "tmp", "project", "exec"]) mkdirSync(join(root, d), { mode: 0o700 });
  // codex and node only: no claude on PATH, so the verdict is codex's alone.
  symlinkSync(BIN, join(bin, "codex"));
  symlinkSync(process.execPath, join(bin, "node"));
  const store = inWorkspace ? join(root, "project", ".review-store") : join(root, "store");
  return {
    root, project: join(root, "project"), store,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home"), TMPDIR: join(root, "tmp"), STORYBLOQ_SETUP_REVIEW_DIR: store },
  };
}

/** A Codex turn's own markers, as a sandboxed agent shell has them. */
const TURN = { CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" };

function cli(b: Box, args: string[], opts: { sandbox?: ":workspace" | ":read-only"; input?: string } = {}): { code: number | null; out: string; err: string } {
  const command = [process.execPath, CLI, "setup-review", ...args];
  const [cmd, argv] = opts.sandbox ? [BIN, ["sandbox", "-P", opts.sandbox, "-C", b.project, "--", ...command]] : [command[0]!, command.slice(1)];
  const r = spawnSync(cmd, argv, { cwd: b.project, env: { ...b.env, ...(opts.sandbox ? TURN : {}) }, input: opts.input ?? "", encoding: "utf-8", timeout: 90_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A 127.0.0.1 port nothing listens on: bound by the OS, then released. */
function closedPort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => res(port));
    });
  });
}

const setupId = (out: string): string => /^Setup id: (SS-[0-9a-f]{8})$/m.exec(out)![1]!;
const storeEntries = (b: Box): string[] => (existsSync(b.store) ? readdirSync(b.store, { recursive: true }).map(String).sort() : []);

describe.runIf(REAL)("the real codex start (ISS-1456, opt-in)", () => {
  it("the binary is the characterised version", () => {
    const b = box();
    const r = spawnSync(BIN, ["--version"], { env: b.env, encoding: "utf-8" });
    expect(r.stdout.trim()).toBe(CHARACTERISED);
  });

  it("outside a sandbox codex reaches the probe's listener on its route with the nonce, so the start probe passes", async () => {
    const b = box();
    // Imported here, so the other rows run against an older build for RED.
    const { probeCodexStart } = await import("../../src/core/setup-review-backends.js");
    expect(await probeCodexStart(join(b.root, "exec"), b.env)).toEqual({ ok: true });
  }, 60_000);

  it("outside a sandbox the gate offers codex", () => {
    const b = box();
    const r = cli(b, ["gate"]);
    expect(r.out).toContain(`Reviewer probe: codex ${CHARACTERISED}\n`);
    expect(r.code).toBe(0);
  }, 120_000);

  it("inside a workspace-write sandbox, with the store in the system temp directory, the gate starts nothing and names the store", () => {
    const b = box();
    const r = cli(b, ["gate"], { sandbox: ":workspace" });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^Reviewer unavailable: review store: cannot be written from here \(EPERM\)/m);
    expect(storeEntries(b)).toEqual([]);
  }, 120_000);

  it("inside a workspace-write sandbox, with a store it can write, the gate does not offer codex, and says networking is denied", () => {
    const b = box(true);
    const r = cli(b, ["gate"], { sandbox: ":workspace" });
    expect(r.out).toContain("Reviewer probe: none available\n");
    expect(r.out).toMatch(/^Reviewer unavailable: codex: networking is denied in this sandbox/m);
    expect(r.code).toBe(0);
  }, 120_000);

  it("inside a workspace-write sandbox, with a store it can write, run starts no reviewer and records nothing", () => {
    const b = box(true);
    const id = setupId(cli(b, ["gate"]).out);
    const before = storeEntries(b);
    const r = cli(b, ["run", "--setup", id], { sandbox: ":workspace", input: REVIEW_PACKET });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^Reviewer probe: none available\nReviewer unavailable: codex: networking is denied in this sandbox/);
    expect(storeEntries(b).filter((e) => e.includes("records/SR-"))).toEqual([]);
    expect(storeEntries(b).filter((e) => !before.includes(e) && !e.includes("revisions"))).toEqual([]);
  }, 120_000);

  it("inside a read-only sandbox the gate starts nothing, writes nothing and names the store", () => {
    const b = box();
    const r = cli(b, ["gate"], { sandbox: ":read-only" });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^Reviewer unavailable: review store: cannot be written from here \(EPERM\)/m);
    expect(storeEntries(b)).toEqual([]);
  }, 120_000);

  it("inside a read-only sandbox run of an existing setup starts nothing", () => {
    const b = box();
    const id = setupId(cli(b, ["gate"]).out);
    const before = storeEntries(b);
    const r = cli(b, ["run", "--setup", id], { sandbox: ":read-only", input: REVIEW_PACKET });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/review store: cannot be written from here \(EPERM\)/);
    expect(storeEntries(b)).toEqual(before);
  }, 120_000);

  it("inside a read-only sandbox the owner's skip is printed, not recorded, and exits 0", () => {
    const b = box();
    const id = setupId(cli(b, ["gate"]).out);
    const before = storeEntries(b);
    const r = cli(b, ["status", "--setup", id, "--skipped"], { sandbox: ":read-only" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Setup review: not recorded, the review store is outside this sandbox.\n");
    expect(storeEntries(b)).toEqual(before);
  }, 120_000);

  it("the binary's own facts the probe reads: the fatal start line under read-only, with the provider at a closed localhost port", async () => {
    const b = box();
    const exec = join(b.root, "exec");
    const { probeOverrides, PROBE_KEY_ENV } = await import("../../src/core/setup-review-backends.js");
    const port = await closedPort();
    const r = spawnSync(BIN, ["sandbox", "-P", ":read-only", "-C", exec, "--", BIN, "exec", ...probeOverrides(port, "0".repeat(32)), "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "-"], {
      cwd: exec, env: { ...b.env, [PROBE_KEY_ENV]: "storybloq-probe-not-a-credential" }, input: "probe\n", encoding: "utf-8", timeout: 30_000,
    });
    expect(r.stderr).toMatch(/failed to initialize in-process app-server client: Operation not permitted/);
    expect(r.status).not.toBe(0);
    expect(dirname(exec)).toBe(b.root);
  }, 60_000);
});
