/**
 * ISS-1278: which program a `storybloq` invocation starts -- the CLI, the MCP
 * server (`--mcp`) or the board MCP server (`--board-mcp`) -- decided once,
 * from the arguments. This module imports nothing: `index.ts` is bundled with
 * splitting off, and nothing here may touch process.stdin at link time
 * (ISS-1043).
 */

/** Global flags the CLI registers without a value; the only tokens allowed before a selector. */
export const COMPAT_PREFIX_FLAGS: ReadonlySet<string> = new Set(["--help", "--version"]);

export type EntryMode =
  | { readonly kind: "cli" }
  | { readonly kind: "mcp" | "board"; readonly deprecatedPrefix: readonly string[] };

export function resolveEntryMode(userArgs: readonly string[]): EntryMode {
  if (userArgs.includes("--board-mcp")) return { kind: "board", deprecatedPrefix: [] };
  if (userArgs.includes("--mcp")) return { kind: "mcp", deprecatedPrefix: [] };
  return { kind: "cli" };
}

/** The stderr line for a server selector that was not the first argument, or null. */
export function entryDeprecationLine(mode: EntryMode): string | null {
  return null;
}
