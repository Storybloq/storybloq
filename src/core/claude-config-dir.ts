/**
 * ISS-1270: where Claude Code keeps its user configuration. Claude Code reads
 * CLAUDE_CONFIG_DIR in place of `~/.claude`, so every storybloq write into
 * that directory (the /story skill, the Mods copy, settings.json) and every
 * read of a file Claude writes there resolves through this module. A fresh
 * benchmark cell sets only CLAUDE_CONFIG_DIR and keeps the real HOME, so a
 * hardcoded `~/.claude` would reach the real configuration from inside it.
 *
 * Read on every call, never cached: tests and the benchmark runner set the
 * variable after this module is imported.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The override, resolved, or null when it is unset or empty. An empty value must not resolve to the cwd. */
function configDirOverride(): string | null {
  const raw = process.env.CLAUDE_CONFIG_DIR;
  return typeof raw === "string" && raw.length > 0 ? resolve(raw) : null;
}

/** CLAUDE_CONFIG_DIR when set and non-empty, else `~/.claude`. */
export function claudeConfigDir(): string {
  return configDirOverride() ?? join(homedir(), ".claude");
}

/** Claude Code's user settings file: `~/.claude/settings.json`, or under the override. */
export function claudeSettingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

/**
 * The user-scope registry `~/.claude.json`. It sits BESIDE `~/.claude` by
 * default but INSIDE the override when CLAUDE_CONFIG_DIR is set, so it does
 * not follow claudeConfigDir() by a fixed relative path.
 */
export function claudeJsonPath(): string {
  const override = configDirOverride();
  return override === null ? join(homedir(), ".claude.json") : join(override, ".claude.json");
}

/**
 * How a path under the config dir is shown to a user: `~/.claude/<parts>`
 * when there is no override, else the resolved absolute path. Callers that
 * name a directory pass the trailing "/" themselves.
 */
export function claudeConfigDisplay(...parts: string[]): string {
  const override = configDirOverride();
  return override === null ? ["~/.claude", ...parts].join("/") : join(override, ...parts);
}
