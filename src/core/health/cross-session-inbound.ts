/**
 * T-502 check 5: does Claude Code deliver messages from your other sessions.
 *
 * `crossSessionInbound` decides whether a session accepts, holds or refuses
 * messages from the user's other sessions. Unset, a session running without
 * permission prompts HOLDS them, which is exactly the silent pen/worker duet
 * stall this check was added for: both agents are alive, neither is wrong,
 * and no message ever arrives.
 *
 * This is a SETTINGS-FILE assessment and says so (`detail.scope =
 * "settings-files"`). It reports what the files resolve to; it cannot see a
 * `--settings` flag the session was started with, and it never edits a file.
 *
 * Two rules carry the weight:
 *
 * ALL FOUR LAYERS MUST BE DETERMINATE. Unlike the other checks, the
 * could-change-the-verdict shortcut is NOT applied here, because the
 * remediation is a list of edits: an unreadable local file could hold a
 * restriction the suggested edits would not remove, so partial evidence gets
 * no verdict and no advice at all.
 *
 * STEPS COME FROM THE SELECTED BASE OBJECT. Managed settings supply the base
 * outright, so a user value underneath one is not a restriction and must
 * produce no step -- a step naming a shadowed layer would send the user to
 * edit a file that cannot change the outcome. The kind of advice is chosen
 * from the EFFECTIVE value, so an unset base with a local refuse says refuse,
 * and the missing base is expressed as a step rather than as the headline.
 */

import { join } from "node:path";
import { adviseCheck, okCheck, readJsonObject, skipCheck, type HealthCheck, type HealthContext, type HealthDeps } from "./types.js";

const ID = "cross-session-inbound" as const;
const KEY = "crossSessionInbound";
const SETTINGS_MAX_BYTES = 1024 * 1024;

const PROJECT_FILE = ".claude/settings.json";
const LOCAL_FILE = ".claude/settings.local.json";

export type InboundValue = "accept" | "hold" | "refuse";
const RANK: Readonly<Record<InboundValue, number>> = { accept: 0, hold: 1, refuse: 2 };

type LayerId = "managed" | "user" | "project" | "local";

export type LayerReading =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly value: InboundValue }
  | { readonly kind: "invalid"; readonly raw: string }
  | { readonly kind: "indeterminate"; readonly reason: string };

/** Where a machine's organization policy lives. Absent on most machines. */
export function managedSettingsPath(platform: string): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return "C:\\ProgramData\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

export function inboundLayerPaths(deps: HealthDeps, projectDir: string): ReadonlyArray<{ id: LayerId; path: string; display: string }> {
  return [
    { id: "managed", path: managedSettingsPath(deps.platform), display: managedSettingsPath(deps.platform) },
    { id: "user", path: join(deps.claudeConfigDir, "settings.json"), display: deps.claudeSettingsDisplay },
    { id: "project", path: join(projectDir, ".claude", "settings.json"), display: PROJECT_FILE },
    { id: "local", path: join(projectDir, ".claude", "settings.local.json"), display: LOCAL_FILE },
  ];
}

function readLayer(deps: HealthDeps, path: string): LayerReading {
  const doc = readJsonObject(deps, path, SETTINGS_MAX_BYTES);
  if (doc.kind === "absent") return { kind: "absent" };
  if (doc.kind === "indeterminate") return { kind: "indeterminate", reason: doc.reason };
  const value = doc.value[KEY];
  if (value === undefined) return { kind: "absent" };
  if (value === "accept" || value === "hold" || value === "refuse") return { kind: "ok", value };
  return { kind: "invalid", raw: JSON.stringify(value) ?? String(value) };
}

/** An invalid value behaves as hold: the binary does not honour it, and holding is what a user sees. */
function rankOf(reading: LayerReading): number {
  if (reading.kind === "ok") return RANK[reading.value];
  if (reading.kind === "invalid") return RANK.hold;
  return RANK.accept;
}

function nameOf(rank: number): InboundValue {
  return rank === RANK.refuse ? "refuse" : rank === RANK.hold ? "hold" : "accept";
}

const CAVEAT =
  "A session started with a --settings flag can replace the user value but not a managed one, and repository files only ever tighten.";

const OPENERS: Readonly<Record<"unset" | "hold" | "refuse", string>> = {
  unset:
    "Claude Code's crossSessionInbound setting is not set in your settings files, so a session that runs without permission prompts holds messages from your other sessions for manual review, and pen/worker messaging stalls.",
  hold:
    "Claude Code's crossSessionInbound settings files resolve to hold, so messages from your other sessions are held for manual review, and pen/worker messaging stalls.",
  refuse:
    "Claude Code's crossSessionInbound settings files resolve to refuse, so messages from your other sessions are rejected, and pen/worker messaging cannot work.",
};

const STEP = {
  addToUser: (userFile: string) => `Add \`"${KEY}": "accept"\` to ${userFile}.`,
  userChange: (userFile: string, value: string) => `Change ${KEY} from ${value} to accept in ${userFile}.`,
  setToAccept: (file: string, raw: string) =>
    `Set ${KEY} to accept in ${file} (its current value ${raw} is not one of accept, hold, refuse; hold and refuse are valid but keep messages from being delivered).`,
  repository: (file: string) => `Remove ${KEY} from ${file} or set it to accept there.`,
  admin: (value: string) =>
    `Your organization's managed settings set ${KEY} to ${value}; ask your admin to change it to accept (nothing in your own files can override it).`,
};

export async function checkCrossSessionInbound(ctx: HealthContext, deps: HealthDeps): Promise<HealthCheck> {
  const base = { projectDir: ctx.projectDir, scope: "settings-files" };
  if (ctx.client === "codex") {
    return skipCheck(ID, "crossSessionInbound is a Claude Code setting, so this check does not apply when running under Codex.", "not applicable to Codex", base);
  }

  const layers = inboundLayerPaths(deps, ctx.projectDir);
  const readings = new Map<LayerId, LayerReading>();
  for (const layer of layers) {
    const reading = readLayer(deps, layer.path);
    if (reading.kind === "indeterminate") {
      return skipCheck(
        ID,
        `Storybloq could not read ${layer.path}, so it will not guess whether messages from your other sessions are delivered.`,
        `unreadable: ${layer.path}`,
        base,
      );
    }
    readings.set(layer.id, reading);
  }

  const managed = readings.get("managed")!;
  const user = readings.get("user")!;
  const project = readings.get("project")!;
  const local = readings.get("local")!;

  // Managed supplies the base outright; the user file is consulted only when
  // it does not. The PROVENANCE is kept, because it decides both `detail.source`
  // and which base step (if any) can be offered.
  const baseSource: "managed" | "user" | null =
    managed.kind === "ok" || managed.kind === "invalid"
      ? "managed"
      : user.kind === "ok" || user.kind === "invalid"
        ? "user"
        : null;
  const baseReading: LayerReading = baseSource === "managed" ? managed : baseSource === "user" ? user : { kind: "absent" };

  const effectiveRank = Math.max(rankOf(baseReading), rankOf(project), rankOf(local));
  const effective = nameOf(effectiveRank);

  const detail: Record<string, string | number | boolean | null> = {
    ...base,
    effective,
    baseSource,
    source: baseSource,
    project: describe(project),
    local: describe(local),
  };
  // A user value under a managed base is recorded but never acted on.
  if (baseSource === "managed" && (user.kind === "ok" || user.kind === "invalid")) {
    detail.shadowedUser = user.kind === "ok" ? user.value : user.raw;
  }

  if (baseSource !== null && effectiveRank === RANK.accept) {
    // Says only what was verified. This check reads FILES: it cannot see a
    // --settings flag the session was started with, so it must not promise
    // that messages are actually delivered, and it carries the same caveat
    // the advise messages do.
    return okCheck(
      ID,
      `Your Claude Code settings files resolve crossSessionInbound to accept (set in your ${baseSource} settings), so nothing in them holds or refuses messages from your other sessions. ${CAVEAT}`,
      detail,
    );
  }

  // The kind comes from the EFFECTIVE value, not from the base's presence, so
  // an unset base with a local refuse renders the refuse opener. `unset` is
  // reached only when nothing restricts and there is no base at all: any
  // repository restriction raises the rank, and an accept base returned ok
  // above, so the two conditions the plan states are both implied here.
  const kind: "unset" | "hold" | "refuse" =
    effectiveRank === RANK.refuse ? "refuse" : effectiveRank === RANK.hold ? "hold" : "unset";

  const steps: string[] = [];
  steps.push(...baseStep(baseSource, baseReading, deps.claudeSettingsDisplay));
  steps.push(...repositoryStep(project, PROJECT_FILE));
  steps.push(...repositoryStep(local, LOCAL_FILE));

  return adviseCheck(ID, [OPENERS[kind], ...steps, CAVEAT].join(" "), { ...detail, kind });
}

/**
 * The base step, derived ONLY from the selected base object. Never by
 * inspecting managed and user separately: a shadowed user value must
 * contribute nothing, valid or invalid.
 */
function baseStep(baseSource: "managed" | "user" | null, reading: LayerReading, userFile: string): string[] {
  if (baseSource === null) return [STEP.addToUser(userFile)];
  if (baseSource === "managed") {
    if (reading.kind === "invalid") return [STEP.admin(reading.raw)];
    if (reading.kind === "ok" && reading.value !== "accept") return [STEP.admin(reading.value)];
    return [];
  }
  if (reading.kind === "invalid") return [STEP.setToAccept(userFile, reading.raw)];
  if (reading.kind === "ok" && reading.value !== "accept") return [STEP.userChange(userFile, reading.value)];
  return [];
}

/** A repository layer's step, derived only from that layer. */
function repositoryStep(reading: LayerReading, file: string): string[] {
  if (reading.kind === "invalid") return [STEP.setToAccept(file, reading.raw)];
  if (reading.kind === "ok" && reading.value !== "accept") return [STEP.repository(file)];
  return [];
}

function describe(reading: LayerReading): string {
  if (reading.kind === "ok") return reading.value;
  if (reading.kind === "invalid") return `invalid ${reading.raw}`;
  return reading.kind;
}
