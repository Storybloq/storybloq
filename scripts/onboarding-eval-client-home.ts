/**
 * T-538 commit 3, pen ruling on finding 4 (option A): the storybloq CLI's own per-command housekeeping
 * (src/cli/housekeeping.ts) reconciles the storybloq hooks in the client's settings.json and refreshes a stale
 * skill copy. That is designed product behaviour, so it is part of provisioning: the harness runs its own
 * `storybloq --version` once per arm, before the manifest is taken, and records every client-home file that call
 * created or changed. The manifest then pins those bytes, and a later write to the client home is a real change
 * that stops the run. The registry update check, the one housekeeping write that needs the network, is held off
 * by the product's own opt-out (NO_UPDATE_NOTIFIER, set in both environment columns).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileEntry, type ManifestEntry } from "./onboarding-eval-config.js";
import { readBounded, walkNoFollow } from "./onboarding-eval-walk.js";

/** One client-home file the provisioning call created or changed, relative to the attempt folder. */
export interface ClientHomeWrite { readonly path: string; readonly sha256: string; readonly change: "created" | "changed" }
export interface ClientHomeProvisioning { readonly command: string; readonly exit: number; readonly version: string; readonly markers: readonly string[]; readonly writes: readonly ClientHomeWrite[] }

/** The child that writes the skill markers with the product's own writer (onboarding-eval-skill-marker.ts). */
export interface MarkerWriter { readonly command: string; readonly args: readonly string[] }

/** The manifest entries with each provisioning write pinned: a changed file's entry replaced, a created one added. */
export function pinWrites(entries: readonly ManifestEntry[], p: ClientHomeProvisioning, root: string): ManifestEntry[] {
  const out = [...entries];
  for (const w of p.writes) {
    const entry = fileEntry(join(root, w.path));
    const at = out.findIndex((e) => e.path === entry.path);
    if (at >= 0) out[at] = entry;
    else out.push(entry);
  }
  return out;
}

/** The command provisioning runs: read-only, and not on housekeeping's skip list, so housekeeping runs. */
export const CLIENT_HOME_COMMAND = ["--version"] as const;
/** A configuration file is small; anything larger is refused rather than read. */
const FILE_LIMIT = 8 * 1024 * 1024;

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * Every regular file under the folders, by absolute path, with its sha256. A link (the Codex credential link) is
 * held by its target text alone, read with readlink and never followed or opened. An unreadable entry throws.
 */
export function folderHashes(folders: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const folder of folders) {
    const { problems } = walkNoFollow(folder, folder, {
      link: (rel, target) => { out.set(`${folder}/${rel}`, `link:${target}`); },
      file: (rel, fd) => {
        const r = readBounded(fd, FILE_LIMIT);
        if (!("bytes" in r)) return "code" in r ? r.code : "over";
        out.set(`${folder}/${rel}`, sha256(r.bytes));
        return null;
      },
    }, { missingIsEmpty: true });
    if (problems.length > 0) throw new Error(`onboarding-eval: provisioning: client home: ${problems.join("; ")}`);
  }
  return out;
}

/**
 * Runs `<command> --version` with the client's environment in a folder of its own (never the project, so the
 * project-scoped housekeeping finds no project) and returns what it wrote to the client-home folders. A failed
 * call, or one that removed a file, is a provisioning failure by cause.
 */
export function provisionClientHome(o: {
  readonly command: string; readonly args?: readonly string[]; readonly folders: readonly string[];
  readonly env: Record<string, string>; readonly provisionDir: string; readonly root: string;
  /** The CLI version the bundle reports, the skill source it was built from, and the copies to mark (skill targets). */
  readonly version: string; readonly skillSource: string; readonly markers: readonly string[]; readonly markerWriter: MarkerWriter;
}): ClientHomeProvisioning {
  const before = folderHashes(o.folders);
  if (o.markers.length > 0) {
    const m = spawnSync(o.markerWriter.command, [...o.markerWriter.args, o.version, o.skillSource, ...o.markers], { cwd: o.provisionDir, env: o.env, encoding: "utf-8", timeout: 120_000 });
    if (m.error !== undefined || m.status !== 0) {
      const why = m.error !== undefined ? m.error.message : (m.stderr.split("\n").find((l) => /Error/.test(l)) ?? m.stderr.split("\n").find((l) => l.trim() !== "") ?? `signal ${String(m.signal)}`);
      throw new Error(`onboarding-eval: provisioning: client home: the skill markers were not written (exit ${String(m.status)}): ${why}`);
    }
  }
  const r = spawnSync(o.command, [...(o.args ?? []), ...CLIENT_HOME_COMMAND], { cwd: o.provisionDir, env: o.env, encoding: "utf-8", timeout: 120_000 });
  const exit = r.status ?? -1;
  if (r.error !== undefined || exit !== 0) {
    const why = r.error !== undefined ? r.error.message : (r.stderr.split("\n").find((l) => l.trim() !== "") ?? `signal ${String(r.signal)}`);
    throw new Error(`onboarding-eval: provisioning: client home: storybloq ${CLIENT_HOME_COMMAND.join(" ")} failed (exit ${exit}): ${why}`);
  }
  if (r.stdout.trim() !== o.version) throw new Error(`onboarding-eval: provisioning: client home: the CLI reports ${r.stdout.trim()}, not ${o.version}`);
  if (r.stderr.includes("not the global install")) throw new Error("onboarding-eval: provisioning: client home: the CLI still reads the skill copy as stale");
  const after = folderHashes(o.folders);
  const removed = [...before.keys()].filter((p) => !after.has(p));
  if (removed.length > 0) throw new Error(`onboarding-eval: provisioning: client home: storybloq ${CLIENT_HOME_COMMAND.join(" ")} removed ${removed.map((p) => relative(o.root, p)).join(", ")}`);
  const writes: ClientHomeWrite[] = [];
  for (const [p, h] of [...after.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const was = before.get(p);
    if (was === h) continue;
    if (h.startsWith("link:") || was?.startsWith("link:")) throw new Error(`onboarding-eval: provisioning: client home: storybloq ${CLIENT_HOME_COMMAND.join(" ")} changed the link ${relative(o.root, p)}`);
    writes.push({ path: relative(o.root, p), sha256: h, change: was === undefined ? "created" : "changed" });
  }
  return { command: `storybloq ${CLIENT_HOME_COMMAND.join(" ")}`, exit, version: o.version, markers: [...o.markers], writes };
}
