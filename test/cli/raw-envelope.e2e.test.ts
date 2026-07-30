/**
 * The JSON envelope is documented in every --help and --raw honors its
 * contract end to end (ISS-910).
 *
 * Runs against the BUILT bundle: `npm run build` must have produced a current
 * dist/cli.js before this file can pass (same dependency as the other e2e
 * suites here). These cases exist end-to-end because the defect surface is
 * the yargs REGISTRATIONS and the root middleware, which handler-level tests
 * bypass entirely.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 30_000 });

const pkgRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(pkgRoot, "dist", "cli.js");

function run(cwd: string, ...args: string[]): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync("node", [cliPath, ...args], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

let projectDir: string;

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "storybloq-raw-e2e-"));
  const init = run(projectDir, "init", "--name", "raw-e2e", "--format", "json");
  expect(init.code).toBe(0);
});

/**
 * yargs hard-wraps help text at the terminal width and will break mid-token,
 * so `{"sessions", "damaged"}` can arrive split across two lines. Compare with
 * all whitespace removed: the assertion is about the text being present, not
 * about where the renderer chose to fold it.
 */
function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

describe("envelope documentation is structural", () => {
  it("subcommand --help states the envelope and the --raw contract", () => {
    const { out } = run(projectDir, "status", "--help");
    expect(squash(out)).toContain(squash('{"version": 1, "data": ...}'));
    expect(out).toContain("--raw");
  });

  it("the envelope doc reaches a DEPTH-2 subcommand, which a root epilogue cannot", () => {
    // The mechanism has to be the shared builder helper: a root .epilogue()
    // does not propagate to subcommand --help in yargs 17.
    const { out } = run(projectDir, "conflicts", "list", "--help");
    expect(squash(out)).toContain(squash('{"version": 1, "data": ...}'));
    expect(out).toContain("--raw");
  });

  it("the session list exemption names its own shape in --help", () => {
    const { out } = run(projectDir, "session", "list", "--help");
    expect(squash(out)).toContain(squash('{"sessions", "damaged"}'));
    expect(squash(out)).toContain(squash("NOT the shared"));
  });
});

describe("--raw end to end", () => {
  it("status --format json keeps the envelope; --raw emits the data payload alone", () => {
    const enveloped = run(projectDir, "status", "--format", "json");
    expect(enveloped.code).toBe(0);
    const env = JSON.parse(enveloped.out) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(env).toHaveProperty("data");

    const raw = run(projectDir, "status", "--format", "json", "--raw");
    expect(raw.code).toBe(0);
    const payload = JSON.parse(raw.out) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("version");
    expect(payload).toEqual(env.data);
  });

  it("--raw without --format json is ONE invalid_input error, not a rethrow into io_error", () => {
    const { code, out } = run(projectDir, "status", "--raw");
    expect(code).not.toBe(0);
    expect(out).toContain("--raw flag requires --format json");
    // Reported once, and as user input -- routing this through .check() or a
    // rethrow lands it in the io_error catch-all instead.
    expect(out.match(/Error \[/g) ?? []).toHaveLength(1);
    expect(out).toContain("invalid_input");
    expect(out).not.toContain("io_error");
    // The md formatter escapes a line-leading dash; the message must not
    // reach the operator as "\\--raw".
    expect(out).not.toContain("\\--raw");
  });

  it("a CliValidationError from an async handler keeps its pinned single-envelope path", () => {
    // ISS-886 pinned this shape. An earlier attempt to classify the raw-mode
    // misuse inside .fail() also intercepted THIS error, printing an
    // invalid_input envelope and then letting the parse rejection print a
    // second io_error one. Two envelopes from one run.
    const { code, out } = run(projectDir, "ticket", "update", "NOPE", "--title", "x", "--format", "json");
    expect(code).not.toBe(0);
    expect(out.match(/"version":/g) ?? []).toHaveLength(1);
  });

  it("a deviant-shape command rejects --raw at PARSE time, before its handler can run", () => {
    // limit-status emits {ok, data}. It does not register --raw, so strict
    // parsing rejects the flag during validation -- the seam-level rejection
    // would come too late for the mutating members of this family.
    const { code, out } = run(projectDir, "limit-status", "--format", "json", "--raw");
    expect(code).not.toBe(0);
    expect(out).toContain("Unknown argument: raw");
  });

  it("session list never registered --raw, so strict parsing rejects it", () => {
    const { code, out } = run(projectDir, "session", "list", "--raw");
    expect(code).not.toBe(0);
    expect(out).toContain("raw");
  });
});

/**
 * The help annotation must match REALITY, not a hand-maintained belief.
 *
 * Every command below is driven for real and its actual top-level JSON keys
 * compared against what its --help claims. A command annotated as deviant
 * whose output turns out to be the shared envelope (or the reverse) fails
 * here, so the annotation cannot rot into a lie -- which is the exact class
 * of defect ISS-910 exists to fix.
 */
describe("deviant-shape annotations match actual output", () => {
  function topLevelKeys(out: string): string[] | null {
    try {
      const parsed = JSON.parse(out) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return Object.keys(parsed).sort();
    } catch {
      return null;
    }
  }

  const isSharedEnvelope = (keys: string[] | null): boolean =>
    keys !== null &&
    keys.length >= 2 &&
    keys.includes("version") &&
    (keys.includes("data") || keys.includes("error"));

  it("gc and limit-status: help names the {ok, data} shape AND they really emit it", () => {
    for (const argv of [["gc"], ["limit-status"]]) {
      const help = run(projectDir, ...argv, "--help");
      expect(squash(help.out), `${argv.join(" ")} --help`).toContain(squash('{"ok", "data"}'));
      expect(squash(help.out), `${argv.join(" ")} --help`).toContain(squash("NOT the shared"));
      // and it must not LIST a flag it does not accept (the epilogue prose
      // mentions --raw to explain its absence; an options row would be a lie)
      expect(/^\s+--raw\s/m.test(help.out), `${argv.join(" ")} lists --raw`).toBe(false);

      const keys = topLevelKeys(run(projectDir, ...argv, "--format", "json").out);
      expect(keys, `${argv.join(" ")} actual keys`).toEqual(["data", "ok"]);
      expect(isSharedEnvelope(keys)).toBe(false);
    }
  });

  it("an annotated command rejects --raw instead of silently emitting its own shape", () => {
    const { code, out } = run(projectDir, "gc", "--format", "json", "--raw");
    expect(code).not.toBe(0);
    expect(out).toContain("Unknown argument: raw");
  });

  it("a MUTATING deviant command rejects --raw without performing the mutation", () => {
    // The ordering is the whole point: rejecting at the output seam would let
    // team init write its config and only then report a raw-mode error,
    // inviting a retry of work that already succeeded.
    const dir = mkdtempSync(join(tmpdir(), "storybloq-raw-mutate-"));
    expect(run(dir, "init", "--name", "mutate-probe", "--format", "json").code).toBe(0);
    const configPath = join(dir, ".story", "config.json");
    const before = readFileSync(configPath, "utf-8");

    const { code, out } = run(dir, "team", "init", "--format", "json", "--raw");
    expect(code).not.toBe(0);
    expect(out).toContain("Unknown argument: raw");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(JSON.parse(before) as Record<string, unknown>).not.toHaveProperty("team");
  });

  it("a deviant command's FAILURE branch is JSON too -- the documented contract holds on the error path", () => {
    // Annotating conflicts show as {"ok", ...} made its not-found branch part
    // of this issue: a routine lookup failure was answering in prose, so an
    // automated caller following the newly documented contract still got
    // non-JSON on stdout -- the same parser breakage ISS-910 exists to close.
    const { code, out } = run(projectDir, "conflicts", "show", "T-999", "--format", "json");
    expect(code).not.toBe(0);
    const keys = topLevelKeys(out);
    expect(keys).toEqual(["error", "ok"]);
    expect((JSON.parse(out) as { ok: boolean; error: string }).ok).toBe(false);
    expect((JSON.parse(out) as { error: string }).error).toContain("not found");
  });

  it("a found entity with nothing to report is success with an empty list, same shape", () => {
    const created = run(projectDir, "ticket", "create", "--title", "shape probe", "--type", "task", "--format", "json");
    expect(created.code).toBe(0);
    const id = (JSON.parse(created.out) as { data: { displayId?: string; id: string } }).data;
    const ref = id.displayId ?? id.id;

    const { code, out } = run(projectDir, "conflicts", "show", ref, "--format", "json");
    expect(code).toBe(0);
    expect(topLevelKeys(out)).toEqual(["data", "ok"]);
    const parsed = JSON.parse(out) as { ok: boolean; data: { conflicts: unknown[] } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.conflicts).toEqual([]);
  });

  it("the no-project guard answers in JSON for BOTH families, not prose", () => {
    // These guards live in the yargs adapter, ahead of the shared pipeline,
    // so they never passed through a formatter. Under --format json they
    // answered in prose -- non-JSON on stdout for the most routine failure
    // there is, one layer above the handlers this issue already fixed.
    const bare = mkdtempSync(join(tmpdir(), "storybloq-no-project-"));

    // Deviant family: {"ok", "error"}
    const dev = run(bare, "conflicts", "list", "--format", "json");
    expect(dev.code).not.toBe(0);
    expect(topLevelKeys(dev.out), "conflicts list outside a project").toEqual(["error", "ok"]);
    expect((JSON.parse(dev.out) as { ok: boolean }).ok).toBe(false);

    // Shared-envelope family: {"version", "error"}
    const std = run(bare, "team", "config", "show", "--format", "json");
    expect(std.code).not.toBe(0);
    expect(topLevelKeys(std.out), "team config show outside a project").toEqual(["error", "version"]);
    expect((JSON.parse(std.out) as { version: number }).version).toBe(1);

    // md rendering is unchanged
    const md = run(bare, "conflicts", "list");
    expect(md.out.trim()).toBe("No .story/ project found.");
  });

  it("unannotated commands really do emit the shared envelope", () => {
    for (const argv of [["status"], ["validate"], ["ticket", "list"], ["reconcile"]]) {
      const keys = topLevelKeys(run(projectDir, ...argv, "--format", "json").out);
      expect(isSharedEnvelope(keys), `${argv.join(" ")} should be the shared envelope`).toBe(true);
      const help = run(projectDir, ...argv, "--help");
      expect(squash(help.out), `${argv.join(" ")} --help`).not.toContain(squash("NOT the shared"));
    }
  });
});
