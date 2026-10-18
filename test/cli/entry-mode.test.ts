/**
 * ISS-1278: `--mcp` (or `--board-mcp`) anywhere in argv used to start a
 * server, including as another flag's value. The mode is now resolved once:
 * only the CLI's valueless global flags may come before a selector, and the
 * first token after them decides.
 */

import { describe, it, expect } from "vitest";
import { COMPAT_PREFIX_FLAGS, entryDeprecationLine, resolveEntryMode } from "../../src/cli/entry-mode.js";

const SELECTORS = [
  { selector: "--mcp", kind: "mcp" },
  { selector: "--board-mcp", kind: "board" },
] as const;

describe("ISS-1278: resolveEntryMode", () => {
  it("allows exactly the CLI's valueless global flags before a selector", () => {
    expect([...COMPAT_PREFIX_FLAGS].sort()).toEqual(["--help", "--version"]);
  });

  for (const { selector: S, kind } of SELECTORS) {
    describe(`selector ${S}`, () => {
      it("starts the server when it is the first argument, with nothing deprecated", () => {
        expect(resolveEntryMode([S])).toEqual({ kind, deprecatedPrefix: [] });
      });

      it.each([
        [["--version", S], ["--version"]],
        [["--help", S], ["--help"]],
        [["--version", "--help", S], ["--version", "--help"]],
      ])("starts the server after only allowlisted flags: %j", (args, prefix) => {
        expect(resolveEntryMode(args)).toEqual({ kind, deprecatedPrefix: prefix });
      });

      it.each([
        [["note", "create", "--content", S]],
        [["ticket", "create", "--title", S]],
        [["status", S]],
        [["--format", "json", S]],
        [["--format=json", S]],
        [["--content", "-x", S]],
        [["--no-color", S]],
        [["note", "create", "--", S]],
        [[`--content=${S}`]],
      ])("runs the CLI when anything else comes first: %j", (args) => {
        expect(resolveEntryMode(args)).toEqual({ kind: "cli" });
      });

      // M4's killers: a separator alone, or after an allowlisted flag, is not
      // masked by a command word.
      it.each([
        [["--", S]],
        [["--version", "--", S]],
      ])("runs the CLI when a separator comes before the selector: %j", (args) => {
        expect(resolveEntryMode(args)).toEqual({ kind: "cli" });
      });
    });
  }

  it.each([[[]], [["status"]]])("runs the CLI with no selector: %j", (args) => {
    expect(resolveEntryMode(args)).toEqual({ kind: "cli" });
  });

  it.each([
    [["--mcp", "--board-mcp"], "mcp"],
    [["--board-mcp", "--mcp"], "board"],
    [["--version", "--mcp", "--board-mcp"], "mcp"],
    [["--version", "--board-mcp", "--mcp"], "board"],
    [["status", "--mcp", "--board-mcp"], "cli"],
  ])("lets the first selector win: %j", (args, kind) => {
    expect(resolveEntryMode(args).kind).toBe(kind);
  });

  it("writes a deprecation line only when a prefix came before the selector", () => {
    expect(entryDeprecationLine(resolveEntryMode(["--mcp"]))).toBeNull();
    expect(entryDeprecationLine(resolveEntryMode(["status"]))).toBeNull();
    expect(entryDeprecationLine(resolveEntryMode(["--version", "--mcp"]))).toBe(
      "storybloq: put --mcp first; the arguments before it (--version) are deprecated\n",
    );
    expect(entryDeprecationLine(resolveEntryMode(["--help", "--version", "--board-mcp"]))).toBe(
      "storybloq: put --board-mcp first; the arguments before it (--help --version) are deprecated\n",
    );
  });
});
