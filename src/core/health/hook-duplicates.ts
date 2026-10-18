/**
 * ISS-1222: the same storybloq hook registered more than once in
 * `~/.claude/settings.json`, through two launcher paths or two overlapping
 * matcher groups, runs more than once per source, possibly from a stale
 * binary. This check reads that one file and reports each collision by
 * semantic command. It picks no keeper and spawns nothing: `storybloq
 * setup-skill` is the reconcile. Project, local and managed settings layers
 * are not inspected.
 */
import { join } from "node:path";
import { findHookCollisions } from "../hook-duplicates.js";
import { adviseCheck, okCheck, readJsonObject, skipCheck, type HealthCheck, type HealthContext, type HealthDeps } from "./types.js";

const ID = "hook-duplicates" as const;
export const SETTINGS_MAX_BYTES = 1024 * 1024;

export async function checkHookDuplicates(ctx: HealthContext, deps: HealthDeps): Promise<HealthCheck> {
  if (ctx.client === "codex") {
    return skipCheck(ID, "Storybloq hooks live in Claude Code's settings, so this check does not apply when running under Codex.", "hooks are Claude Code settings");
  }
  const path = join(deps.claudeConfigDir, "settings.json");
  const scope = deps.claudeSettingsDisplay;
  const read = readJsonObject(deps, path, SETTINGS_MAX_BYTES);
  if (read.kind === "absent") {
    return okCheck(ID, `No duplicate storybloq hook rows: ${scope} does not exist, so no hook is registered there.`, { path, collisions: 0 });
  }
  if (read.kind === "indeterminate") {
    return skipCheck(ID, `Storybloq could not read ${scope} (${read.reason}), so it cannot tell whether a hook is registered twice.`, "settings unreadable", { unreadable: path });
  }
  const collisions = findHookCollisions(read.value);
  if (collisions.length === 0) {
    return okCheck(ID, `No duplicate storybloq hook rows were found in ${scope}; each hook there runs once per event and source.`, { path, collisions: 0 });
  }
  const listed = collisions
    .map((c) => `${c.hookType} \`${c.key.replace(/^storybloq:/, "storybloq ")}\` x ${c.rows.length} (${c.rows.map((r) => `matcher "${r.matcher}": ${r.command}`).join("; ")})`)
    .join("; ");
  return adviseCheck(
    ID,
    `${scope} runs the same storybloq hook more than once: ${listed}. Each extra row runs the hook again, possibly from a stale binary. Run \`storybloq setup-skill\` to keep the global binary's row and drop the rest.`,
    { path, collisions: collisions.length },
  );
}
