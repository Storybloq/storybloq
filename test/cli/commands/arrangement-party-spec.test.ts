import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { parsePartySpec, registerArrangementCommand } from "../../../src/cli/register.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { initProject } from "../../../src/core/init.js";

// ISS-1078 ([R1-FIX 8]): `--party` value grammar -- quoting/escaping support
// for commas inside a value, plus the argv-level proof that the documented
// two-layer shell-quoting example actually works end to end.

describe("parsePartySpec (parser level)", () => {
  it("parses an existing unquoted spec byte-identically (regression)", () => {
    const party = parsePartySpec("role=pen,client=claude,identityAnchor=pen-1");
    expect(party).toEqual({ role: "pen", client: "claude", identityAnchor: "pen-1" });
  });

  it("parses an unquoted spec with an optional modelTier field (regression)", () => {
    const party = parsePartySpec("role=worker,client=codex,identityAnchor=w-1,modelTier=cheap");
    expect(party).toEqual({ role: "worker", client: "codex", identityAnchor: "w-1", modelTier: "cheap" });
  });

  it("parses a quoted value containing a literal comma", () => {
    const party = parsePartySpec('role=pen,client=codex,identityAnchor="session x, shared obj"');
    expect(party.identityAnchor).toBe("session x, shared obj");
  });

  it("a quoted value may appear as any field, not just the last", () => {
    const party = parsePartySpec('role=pen,identityAnchor="a, b",client=codex');
    expect(party.identityAnchor).toBe("a, b");
    expect(party.client).toBe("codex");
  });

  it("round-trips an escaped quote and an escaped backslash to their literal characters", () => {
    const party = parsePartySpec('role=pen,client=codex,identityAnchor="say \\"hi\\" and \\\\ this"');
    expect(party.identityAnchor).toBe('say "hi" and \\ this');
  });

  it("an unquoted value may contain a raw quote or backslash literally", () => {
    const party = parsePartySpec('role=pen,client=codex,identityAnchor=weird"val\\ue');
    expect(party.identityAnchor).toBe('weird"val\\ue');
  });

  it("refuses an unescaped comma with no quoting, naming the offending fragment", () => {
    // Existing behavior, unchanged: an unquoted value can't contain a comma --
    // it gets split into a bare fragment with no `=`, which is refused by name.
    expect(() => parsePartySpec("role=pen,client=codex,identityAnchor=a,b"))
      .toThrow(/Malformed --party entry \(expected key=value pairs\): "role=pen,client=codex,identityAnchor=a,b"/);
  });

  it("refuses an unterminated quote by name", () => {
    expect(() => parsePartySpec('role=pen,client=codex,identityAnchor="unterminated'))
      .toThrow(/unterminated quote/);
  });

  it("refuses unexpected characters after a closing quote, by name", () => {
    expect(() => parsePartySpec('role=pen,client=codex,identityAnchor="ok"trailing,foo=bar'))
      .toThrow(/unexpected characters after closing quote/);
  });

  it("refuses an unrecognized backslash escape inside quotes, by name", () => {
    expect(() => parsePartySpec('role=pen,client=codex,identityAnchor="bad \\n escape"'))
      .toThrow(/invalid escape/);
  });

  it("refuses a trailing comma with no following field (regression: pre-fix split(',') behavior)", () => {
    expect(() => parsePartySpec("role=pen,client=codex,identityAnchor=a,"))
      .toThrow(/Malformed --party entry \(expected key=value pairs\)/);
  });

  it("refuses a malformed fragment BETWEEN two valid key=value pairs, not absorbed into the next key (codex round 1)", () => {
    // Before the fix, the scan for the next `=` searched PAST the comma
    // after "junk", silently treating "junk,modelTier" as one key and
    // dropping modelTier's real value entirely instead of raising an error.
    expect(() => parsePartySpec("role=pen,client=codex,identityAnchor=abc,junk,modelTier=opus"))
      .toThrow(/offending fragment: "junk"/);
  });
});

// --- Argv-level CLI integration (proves the documented two-layer example works) ---

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function runArrangementCreateCli(args: string[]): Promise<{ out: string }> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write);
  try {
    await registerArrangementCommand(yargs(args)).exitProcess(false).parseAsync();
  } catch {
    // yargs validation may throw with exitProcess(false); assert on captured output.
  } finally {
    spy.mockRestore();
  }
  return { out: chunks.join("") };
}

describe("arrangement create --party (argv-level CLI integration)", () => {
  it("parses the exact help-text example end to end: outer single-quotes (shell) + inner double-quotes (parser)", async () => {
    // identityAnchor's own schema (CLIENT_TASK_ID_PATTERN) never permits a
    // comma or space, so it can't itself demonstrate a SUCCESSFUL end-to-end
    // create; `modelTier` is the free-text field the help text's own example
    // uses for this reason. The comma-in-identityAnchor case is exercised
    // for the PARSER (which is form-agnostic) in the parser-level suite above.
    const dir = await mkdtemp(join(tmpdir(), "party-spec-cli-"));
    dirs.push(dir);
    await initProject(dir, { name: "party-spec-cli" });
    const created = await handleTicketCreate(
      { title: "t", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json",
      dir,
    );
    const ticketId = (JSON.parse(created.output) as { data: { id: string } }).data.id;

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      // Once the shell's own outer single-quotes have already been stripped
      // (exactly what happens when a user runs the documented
      // `--party 'role=pen,client=codex,identityAnchor=session-1,modelTier="opus, fallback sonnet"'`
      // example -- verbatim, including identityAnchor, per codex round 1's
      // finding that the prior example omitted a required field), this is
      // the single argv string node actually receives.
      await runArrangementCreateCli([
        "arrangement",
        "create",
        "--bounds",
        ticketId,
        "--party",
        "role=pen,client=codex,identityAnchor=session-1,modelTier=\"opus, fallback sonnet\"",
        "--party",
        "role=worker,client=claude,identityAnchor=worker-1",
        "--unreachability-irreversible",
        "hold",
        "--format",
        "json",
      ]);

      const { loadArrangementsSafe } = await import("../../../src/core/arrangement-loader.js");
      const { arrangements } = loadArrangementsSafe(dir);
      expect(arrangements).toHaveLength(1);
      const pen = arrangements[0]!.parties.find((p) => p.role === "pen");
      expect(pen?.identityAnchor).toBe("session-1");
      expect(pen?.modelTier).toBe("opus, fallback sonnet");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("refuses an unquoted comma-containing --party value with the improved, fragment-naming error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "party-spec-cli-bad-"));
    dirs.push(dir);
    await initProject(dir, { name: "party-spec-cli-bad" });
    const created = await handleTicketCreate(
      { title: "t", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json",
      dir,
    );
    const ticketId = (JSON.parse(created.output) as { data: { id: string } }).data.id;

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const { out } = await runArrangementCreateCli([
        "arrangement",
        "create",
        "--bounds",
        ticketId,
        "--party",
        "role=pen,client=codex,identityAnchor=session x, shared obj",
        "--party",
        "role=worker,client=claude,identityAnchor=worker-1",
        "--unreachability-irreversible",
        "hold",
        "--format",
        "json",
      ]);
      expect(out).toContain("Malformed --party entry");

      const { loadArrangementsSafe } = await import("../../../src/core/arrangement-loader.js");
      const { arrangements } = loadArrangementsSafe(dir);
      expect(arrangements).toHaveLength(0);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
