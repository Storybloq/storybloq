/**
 * T-525 Addendum E (owner ruling r-hs5j319qkr3gjvtz): the signed-in isolation mode of the continuity
 * runner, model-free parts. Only the Claude client process gets the operator's real HOME and default
 * config dir (the login lives there); every other process keeps a scratch HOME.
 *
 * Until E3's per-prompt provenance checks and the M2 to M6 evidence exist, the mode refuses to spawn
 * claude for real, even with --live-ack, and no signed-in record qualifies.
 */
import { createHash } from "node:crypto";
import { lstatSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SIGNED_IN_MISSING_GATES } from "./continuity-lib.js";
import { ALTERNATE_AUTH_ENV_VARS } from "./headless-common.js";
import { provenanceProblems, type SignedInProvenance } from "./headless-policy.js";

export const SIGNED_IN_RULING = "r-hs5j319qkr3gjvtz";

export { SIGNED_IN_MISSING_GATES };
// E3 (B1, B4): the pure listing and init checks live beside readbackProblems, which the regrade re-runs.
export { initProvenanceProblems, listingProblems, MEMORY_UNPROVEN } from "./headless-policy.js";

/**
 * E3 (B3): what lstat says about the memory files a signed-in client could load for `cwd`. The pinned client
 * exposes no listing of loaded memory, so the status is always "unproven" and refuses on its own; the evidence
 * (each read by lstat only, never opened) only adds to the refusal's text. The slug is a guess at the client's
 * folder name, so it is named as one whenever cwd holds a character whose encoding is not pinned.
 */
export function memoryProvenance(cwd: string, home: string, fs: { readonly lstatSync: (p: string) => { isSymbolicLink(): boolean } } = { lstatSync }): { readonly status: "unproven"; readonly evidence: readonly string[] } {
  const evidence: string[] = [];
  const look = (label: string, p: string): void => {
    try { fs.lstatSync(p); evidence.push(`${label} present`); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      evidence.push(code === "ENOENT" || code === "ENOTDIR" ? `${label} absent` : `${label} lstat ${code ?? "error"}`);
    }
  };
  look("user CLAUDE.md", join(home, ".claude", "CLAUDE.md"));
  const abs = resolve(cwd);
  look("guessed memory folder", join(home, ".claude", "projects", abs.replace(/[^A-Za-z0-9]/g, "-")));
  if (/[^A-Za-z0-9/_-]/.test(abs)) evidence.push("the guessed slug is unreliable: cwd holds a character whose encoding is not pinned");
  for (let d = abs; ; d = dirname(d)) {
    try { if (fs.lstatSync(d).isSymbolicLink()) evidence.push(`symlinked ancestor ${d}`); } catch (e) { evidence.push(`ancestor ${d} lstat ${(e as NodeJS.ErrnoException).code ?? "error"}`); }
    if (dirname(d) === d) break;
  }
  return { status: "unproven", evidence };
}

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

/**
 * T-538 S3 (note v5 C4): the only names a launcher's extra table may carry, the eval names the fresh client
 * column holds. Any other name, a base-table name included, is refused before anything is written.
 */
export const LAUNCHER_EXTRA_NAMES = [
  "STORYBLOQ_CLIENT", "STORYBLOQ_EVAL_EVENTS", "STORYBLOQ_SETUP_REVIEW_DIR", "STORYBLOQ_EVAL_FAULT", "STORYBLOQ_EVAL_FAULT_ID", "STORYBLOQ_EVAL_REVIEW_RESPONSES",
] as const;
export type LauncherExtraName = (typeof LAUNCHER_EXTRA_NAMES)[number];

export interface LauncherSpec {
  readonly bin: string;
  readonly node: string;
  readonly cli: string;
  /** T-538 S3: fixed arguments after the bundle (the evaluation bundle's `--entry cli`); none for continuity. */
  readonly args?: readonly string[];
  readonly scratchHome: string;
  readonly codexHome: string;
  readonly tmp: string;
  /** STORYBLOQ_PROJECT_ROOT; omitted (T-538), the CLI finds its project from its working folder. */
  readonly work?: string;
  /** T-538 S3: STORYBLOQ_GLOBAL_DIR; omitted, <tmp>/storybloq-global as before. */
  readonly globalDir?: string;
  readonly path: string;
  readonly lang?: string;
  /** T-538 S3: the allowlisted extra table (LAUNCHER_EXTRA_NAMES); none for continuity. */
  readonly extra?: Readonly<Partial<Record<LauncherExtraName, string>>>;
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The launcher's whole environment, in order: the base table, then the extra table. An extra name outside the
 * allowlist, or an empty extra value, throws. It is also the environment provisioning runs under (C3).
 */
export function storybloqLauncherEnv(p: LauncherSpec): Record<string, string> {
  const env: Record<string, string> = {
    HOME: p.scratchHome, PATH: p.path, TMPDIR: p.tmp, STORYBLOQ_GLOBAL_DIR: p.globalDir ?? join(p.tmp, "storybloq-global"),
    ...(p.work === undefined ? {} : { STORYBLOQ_PROJECT_ROOT: p.work }), NO_UPDATE_NOTIFIER: "1", CODEX_HOME: p.codexHome, ...(p.lang ? { LANG: p.lang } : {}),
  };
  for (const [k, v] of Object.entries(p.extra ?? {})) {
    if (!(LAUNCHER_EXTRA_NAMES as readonly string[]).includes(k)) throw new Error(`storybloq launcher: ${k} is not an allowed extra variable`);
    if (v === undefined || v === "") throw new Error(`storybloq launcher: the extra variable ${k} has no value`);
    env[k] = v;
  }
  return env;
}

/** The launcher script text: an empty environment plus the explicit table, then the pinned node and bundle. */
export function storybloqLauncherText(p: LauncherSpec): string {
  const env = Object.entries(storybloqLauncherEnv(p)).map(([k, v]) => `${k}=${shQuote(v)}`);
  return `#!/bin/sh\nexec /usr/bin/env -i ${env.join(" ")} ${[p.node, p.cli, ...(p.args ?? [])].map(shQuote).join(" ")} "$@"\n`;
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

// B-F4: one strict validator for preparation and for stored evidence, beside readbackProblems (no import cycle).
export { provenanceProblems } from "./headless-policy.js";

/** The pinned provenance, or a refusal naming every malformed field. */
export function checkedProvenance(p: unknown): SignedInProvenance {
  if (p === undefined) throw new Error("continuity-run: a signed-in launch needs its pinned provenance (Addendum E3); none was given; refusing");
  const bad = provenanceProblems(p);
  if (bad.length > 0) throw new Error(`continuity-run: the signed-in provenance is malformed: ${bad.join(", ")}; refusing`);
  return p as SignedInProvenance;
}

/**
 * T-538 signed-in note section 2: the refusal every T-538 entry point gives a signed-in request. It names no ack,
 * because none admits one; it is unconditional until every gate in the shared list is cleared by a reviewed change.
 */
export function unconditionalSignedInRefusal(who: string): string {
  return `${who}: signed-in isolation refuses to spawn any process: missing gates: ${SIGNED_IN_MISSING_GATES.join("; ")}`;
}

/** The refusal a signed-in launch gets: without the ack it names the ack, with it the missing gates. Null never, for now. */
export function signedInSpawnRefusal(liveAck: string | undefined): string {
  if (liveAck === undefined || liveAck === "") return `continuity-run: signed-in isolation needs --live-ack <ruling id> (${SIGNED_IN_RULING}) before any live launch; refusing`;
  return `continuity-run: signed-in isolation refuses to spawn claude even with --live-ack ${liveAck}: missing gates: ${SIGNED_IN_MISSING_GATES.join("; ")}`;
}
