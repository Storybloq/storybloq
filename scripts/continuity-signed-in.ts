/**
 * T-525 Addendum E (owner ruling r-hs5j319qkr3gjvtz): the signed-in isolation mode of the continuity
 * runner, model-free parts. Only the Claude client process gets the operator's real HOME and default
 * config dir (the login lives there); every other process keeps a scratch HOME.
 *
 * Until E3's per-prompt provenance checks and the M2 to M6 evidence exist, the mode refuses to spawn
 * claude for real, even with --live-ack, and no signed-in record qualifies.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { SIGNED_IN_MISSING_GATES } from "./continuity-lib.js";
import { ALTERNATE_AUTH_ENV_VARS } from "./headless-common.js";
import type { SignedInProvenance } from "./headless-policy.js";

export const SIGNED_IN_RULING = "r-hs5j319qkr3gjvtz";

export { SIGNED_IN_MISSING_GATES };

const TOKEN_NAME = /(?:_API_KEY|_AUTH_TOKEN|OAUTH)/;

/**
 * E1: the names (never the values) that make a signed-in launch refuse. No token or API-key variable may
 * be present at all, and CLAUDE_CONFIG_DIR may not point the client away from the default dir.
 */
export function signedInEnvProblems(env: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>();
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", ...ALTERNATE_AUTH_ENV_VARS]) if (env[k] !== undefined) names.add(k);
  for (const k of Object.keys(env)) if (TOKEN_NAME.test(k) && env[k] !== undefined) names.add(k);
  if (env.CLAUDE_CONFIG_DIR !== undefined) names.add("CLAUDE_CONFIG_DIR");
  return [...names].sort();
}

/** The operator's real home from the password database, so a scratch HOME exported by the driver cannot stand in for it. */
export const realHome = (): string => userInfo().homedir;

export interface SignedInDirs { readonly work: string; readonly tmp: string; readonly launcherBin: string; readonly shimBin?: string }

/** E1: the client's exact environment. The real HOME, no CLAUDE_CONFIG_DIR, no token; the launcher first on PATH. */
export function signedInClientEnv(source: NodeJS.ProcessEnv, d: SignedInDirs, home: string = realHome()): NodeJS.ProcessEnv {
  const path = [d.launcherBin, ...(d.shimBin ? [d.shimBin] : []), source.PATH ?? "/usr/bin:/bin"].join(":");
  const env: NodeJS.ProcessEnv = {
    PATH: path, HOME: home, TMPDIR: d.tmp, STORYBLOQ_PROJECT_ROOT: d.work, STORYBLOQ_GLOBAL_DIR: join(d.tmp, "storybloq-global"), NO_UPDATE_NOTIFIER: "1",
  };
  for (const k of ["LANG", "LC_ALL"] as const) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

export interface LauncherSpec {
  readonly bin: string;
  readonly node: string;
  readonly cli: string;
  readonly scratchHome: string;
  readonly codexHome: string;
  readonly tmp: string;
  readonly work: string;
  readonly path: string;
  readonly lang?: string;
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The launcher script text: an empty environment plus the explicit table, then the pinned node and bundle. */
export function storybloqLauncherText(p: LauncherSpec): string {
  const env = [
    ["HOME", p.scratchHome], ["PATH", p.path], ["TMPDIR", p.tmp], ["STORYBLOQ_GLOBAL_DIR", join(p.tmp, "storybloq-global")],
    ["STORYBLOQ_PROJECT_ROOT", p.work], ["NO_UPDATE_NOTIFIER", "1"], ["CODEX_HOME", p.codexHome], ...(p.lang ? [["LANG", p.lang]] : []),
  ].map(([k, v]) => `${k}=${shQuote(v!)}`);
  return `#!/bin/sh\nexec /usr/bin/env -i ${env.join(" ")} ${shQuote(p.node)} ${shQuote(p.cli)} "$@"\n`;
}

/**
 * E4: <bin>/storybloq, mode 0500: the model's Bash reaches storybloq only through it, under the scratch
 * HOME, so housekeeping, the update cache, hook reconcile and skill refresh act on the scratch home.
 */
export function writeStorybloqLauncher(p: LauncherSpec): { readonly path: string; readonly sha256: string } {
  const text = storybloqLauncherText(p);
  const path = join(p.bin, "storybloq");
  writeFileSync(path, text, { mode: 0o500, flag: "wx" });
  return { path, sha256: createHash("sha256").update(text).digest("hex") };
}

const PROVENANCE_LISTS = ["agents", "commands", "skills", "plugins"] as const;
const PROVENANCE_KEYS: readonly string[] = ["clientVersion", ...PROVENANCE_LISTS, "outputStyle"];

/**
 * E3: the fields of a pinned provenance that are not what a signed-in launch needs: the client version and the
 * output style as non-empty strings, each listing as an array of distinct non-empty strings, and no other key.
 * Empty means it is well formed; whether the client then lists exactly these is checked per prompt.
 */
export function provenanceProblems(p: unknown): string[] {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return ["provenance"];
  const v = p as Record<string, unknown>;
  const out: string[] = [];
  const text = (x: unknown): boolean => typeof x === "string" && x !== "";
  if (!text(v.clientVersion)) out.push("clientVersion");
  for (const k of PROVENANCE_LISTS) {
    const l = v[k];
    // Spread first: every() skips a hole, so a sparse listing would pass and serialise as null entries.
    if (!Array.isArray(l) || ![...l].every(text) || new Set(l).size !== l.length) out.push(k);
  }
  if (!text(v.outputStyle)) out.push("outputStyle");
  for (const k of Object.keys(v)) if (!PROVENANCE_KEYS.includes(k)) out.push(`unexpected ${k}`);
  return out;
}

/** The pinned provenance, or a refusal naming every malformed field. */
export function checkedProvenance(p: unknown): SignedInProvenance {
  if (p === undefined) throw new Error("continuity-run: a signed-in launch needs its pinned provenance (Addendum E3); none was given; refusing");
  const bad = provenanceProblems(p);
  if (bad.length > 0) throw new Error(`continuity-run: the signed-in provenance is malformed: ${bad.join(", ")}; refusing`);
  return p as SignedInProvenance;
}

/** The refusal a signed-in launch gets: without the ack it names the ack, with it the missing gates. Null never, for now. */
export function signedInSpawnRefusal(liveAck: string | undefined): string {
  if (liveAck === undefined || liveAck === "") return `continuity-run: signed-in isolation needs --live-ack <ruling id> (${SIGNED_IN_RULING}) before any live launch; refusing`;
  return `continuity-run: signed-in isolation refuses to spawn claude even with --live-ack ${liveAck}: missing gates: ${SIGNED_IN_MISSING_GATES.join("; ")}`;
}
