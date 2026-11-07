// T-538 S5b-0 commit 4: copy-out on the host side (plan section 9). A pack's stdout is a tar and its
// stderr only NUL-framed records; this module reads both. The tar goes through the gate and tar-stream
// together, into a fresh staging folder that becomes final only whole. Links, devices, bad names and
// host collisions are never created; they go to the sidecar, `notMaterialized`, which assertion-deps
// reads to block what they hide. Nothing calls this yet; the conversion commit does.
/// <reference path="./tar-stream.d.ts" />
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, createReadStream, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import tarStream from "tar-stream";
import { compareReadings, GateRefusal, PACK_LIMITS, TarGate, type GateEntry, type PackLimits, type ParsedEntry } from "./onboarding-eval-tar-gate.js";

export type PackProfile = "attempt" | "judge" | "proxy" | "live";
/** Section 12: the runner's limit on a pack's stderr records. */
export const PACK_RECORD_LIMIT = 8 << 20;

/** A pack's stderr, read as records: M missing root, O omitted folder, S socket, E tool message, A credential alias. */
export interface PackRecords {
  readonly missing: readonly string[];
  readonly omitted: readonly string[];
  readonly sockets: readonly string[];
  readonly errors: readonly string[];
  readonly aliases: readonly string[];
}

/** Records, or why the stream is not records at all: stderr carries nothing else, so anything else is a failed pack. */
export function parsePackRecords(stderr: Buffer): PackRecords | { readonly refused: string } {
  if (stderr.length > PACK_RECORD_LIMIT) return { refused: "the pack's records are over their limit" };
  const out = { M: [] as string[], O: [] as string[], S: [] as string[], E: [] as string[], A: [] as string[] };
  let p = 0;
  while (p < stderr.length) {
    const tag = String.fromCharCode(stderr[p]!);
    if (!(tag in out) || stderr[p + 1] !== 0) return { refused: `the pack's stderr carries something that is not a record at byte ${p}` };
    const end = stderr.indexOf(0, p + 2);
    if (end < 0) return { refused: "the pack's last record is cut off" };
    out[tag as keyof typeof out].push(stderr.subarray(p + 2, end).toString("utf-8"));
    p = end + 1;
  }
  return { missing: out.M, omitted: out.O, sockets: out.S, errors: out.E, aliases: out.A };
}

export type NotMaterializedClass = "symlink" | "hardlink" | "special" | "refused-name" | "collision" | "too-long";
export type LinkReach = "inside" | "escapes" | "unknown";
export interface NotMaterialized { readonly path: string; readonly class: NotMaterializedClass; readonly target?: string; readonly escapes?: LinkReach }

/** `extraction.json`, a mandatory grading input. */
export interface Extraction {
  readonly archiveSha256: string | null;
  readonly complete: boolean;
  readonly profile: PackProfile;
  readonly counts: { readonly entries: number; readonly files: number; readonly folders: number; readonly bytes: number };
  readonly rootsMissing: readonly string[];
  readonly notMaterialized: readonly NotMaterialized[];
  readonly omitted: readonly string[];
  readonly ignoredPaxKeys: number;
  readonly errors: readonly string[];
}

/** The host's longest path; macOS's PATH_MAX is 1024, Linux's 4096. */
export const HOST_PATH_MAX = platform() === "darwin" ? 1024 : 4096;
const HOST_NAME_MAX = 255;

/** Why a name cannot be a host path under the staging root, or null. */
function refusedName(e: GateEntry): string | null {
  if (!e.utf8) return "not UTF-8";
  // An absolute name has an empty first segment, so the next rule refuses it.
  const parts = e.path.split("/");
  if (parts.some((c) => c === "")) return "an empty segment";
  if (parts.some((c) => c === ".." || c === ".")) return "a dot segment";
  return null;
}

/** The key under which the host file system may treat two names as one: case-folded and NFC. */
const hostKey = (p: string): string => p.normalize("NFC").toLowerCase();

/** Resolves a symlink's target lexically through the archive's own symlinks, to depth 40. */
export function linkReach(path: string, target: string, links: ReadonlyMap<string, string>): LinkReach {
  let budget = 40;
  const walk = (base: readonly string[], to: string): LinkReach | string[] => {
    if (to.startsWith("/")) return "escapes";
    const out = [...base];
    for (const c of to.split("/")) {
      if (c === "" || c === ".") continue;
      if (c === "..") { if (out.length === 0) return "escapes"; out.pop(); continue; }
      out.push(c);
      const here = out.join("/");
      const next = links.get(here);
      if (next !== undefined) {
        if (--budget < 0) return "unknown";
        out.pop();
        const r = walk(out, next);
        if (typeof r === "string") return r;
        out.splice(0, out.length, ...r);
      }
    }
    return out;
  };
  const parts = path.split("/");
  const r = walk(parts.slice(0, -1), target);
  return typeof r === "string" ? r : "inside";
}

/** The protected roots of section 20: a link under one that escapes, or cannot be resolved, is a violation. */
const PROTECTED = ["project", "store", "eval-events"];
export function linkViolations(x: Extraction): NotMaterialized[] {
  const under = (p: string): boolean => (x.profile === "live" ? true : PROTECTED.some((r) => p === r || p.startsWith(`${r}/`)));
  return x.notMaterialized.filter((n) => n.class === "symlink" && n.escapes !== "inside" && under(n.path));
}

export interface ReadInputs {
  readonly tarPath: string;
  readonly hostRoot: string;
  readonly profile: PackProfile;
  readonly attempt: number;
  readonly records: PackRecords;
  readonly limits?: PackLimits;
  /** Test seam: a hook that corrupts the gate's record before the comparison. */
  readonly afterRead?: (gate: GateEntry[]) => void;
}

export const stagingDir = (hostRoot: string, profile: PackProfile, attempt: number): string => join(hostRoot, "staging", `${profile}-${attempt}`);
export const finalDir = (hostRoot: string, profile: PackProfile): string => join(hostRoot, "final", profile);
/** One per try, so a failed try's result stays beside the one that completed. */
export const extractionPath = (hostRoot: string, profile: PackProfile, attempt: number): string => join(hostRoot, "final", `${profile}.try-${attempt}.extraction.json`);

/** A runner restart: every staging folder and `.part` file for the attempt goes, before any pack. Returns what could not be removed. */
export function clearStaging(hostRoot: string): string[] {
  const left: string[] = [];
  const rm = (p: string): void => { try { rmSync(p, { recursive: true, force: true }); } catch { left.push(p); } };
  rm(join(hostRoot, "staging"));
  let raw: string[] = [];
  try { raw = readdirSync(join(hostRoot, "raw")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") left.push(join(hostRoot, "raw")); }
  for (const n of raw) if (n.endsWith(".part")) rm(join(hostRoot, "raw", n));
  return left;
}

/**
 * Reads one archive into `final/<profile>/`. The archive file is opened without following a link and
 * must be a regular file. Every failure fails the whole archive: the staging folder is removed and
 * `complete` is false, never a partial success. The result is written beside the final tree, either way, one file per try.
 */
export async function readArchive(i: ReadInputs): Promise<Extraction> {
  const limits = i.limits ?? PACK_LIMITS;
  const staging = stagingDir(i.hostRoot, i.profile, i.attempt);
  const errors: string[] = [...i.records.errors.map((e) => `pack: ${e}`)];
  const notMaterialized: NotMaterialized[] = i.records.sockets.map((path) => ({ path, class: "special" as const }));
  const counts = { entries: 0, files: 0, folders: 0, bytes: 0 };
  const gate = new TarGate(limits);
  const parsed: ParsedEntry[] = [];
  const hash = createHash("sha256");
  const links = new Map<string, string>();
  const keys = new Map<string, string>();
  const groups = new Map<string, Set<string>>();
  const blocked = new Set<string>();
  let archiveSha256: string | null = null;
  let complete = false;

  mkdirSync(join(i.hostRoot, "staging"), { recursive: true, mode: 0o700 });
  mkdirSync(join(i.hostRoot, "final"), { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  const hostPath = (rel: string): string => join(staging, rel);
  /** The first name that holds this key, if another does; every prefix counts, since a folder collides too. */
  const collides = (rel: string): string | null => {
    const parts = rel.split("/");
    for (let k = 1; k <= parts.length; k++) {
      const p = parts.slice(0, k).join("/");
      const owner = keys.get(hostKey(p));
      if (owner !== undefined && owner !== p) return owner;
      if (blocked.has(p) && k < parts.length) return p;
    }
    return null;
  };
  const claim = (rel: string): void => { const parts = rel.split("/"); for (let k = 1; k <= parts.length; k++) { const p = parts.slice(0, k).join("/"); if (!keys.has(hostKey(p))) keys.set(hostKey(p), p); } };
  const ensureParents = (rel: string): void => {
    const parts = rel.split("/");
    for (let k = 1; k < parts.length; k++) {
      const p = parts.slice(0, k).join("/");
      try { mkdirSync(hostPath(p), { mode: 0o700 }); counts.folders += 1; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
  };

  let fd: number | null = null;
  try {
    try { fd = openSync(i.tarPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); } catch (e) { throw new GateRefusal(`the archive could not be opened (${(e as NodeJS.ErrnoException).code ?? "unknown"})`); }
    if (!fstatSync(fd).isFile()) throw new GateRefusal("the archive is not a regular file");
    const extract = tarStream.extract();
    extract.on("entry", (header, stream, next) => {
      parsed.push({ name: header.name, type: header.type, size: header.size ?? 0, linkname: header.linkname ?? null });
      const e = gate.entries[parsed.length - 1];
      const done = (err?: unknown): void => { if (err) next(err as Error); else next(); };
      if (e === undefined) { stream.resume(); stream.on("end", () => done(new GateRefusal("the parser emitted an entry the gate did not read"))); return; }
      counts.entries += 1;
      const why = refusedName(e);
      const rel = e.path;
      const tooLong = why === null && (Buffer.byteLength(hostPath(rel)) >= HOST_PATH_MAX || rel.split("/").some((c) => Buffer.byteLength(c) > HOST_NAME_MAX));
      const owner = why === null && !tooLong ? collides(rel) : null;
      const skipStream = (): void => { stream.on("end", () => done()); stream.resume(); };
      if (why !== null) { notMaterialized.push({ path: e.name, class: "refused-name" }); blocked.add(rel); skipStream(); return; }
      if (tooLong) { notMaterialized.push({ path: rel, class: "too-long" }); blocked.add(rel); skipStream(); return; }
      if (owner !== null) {
        const g = groups.get(owner) ?? new Set([owner]);
        g.add(rel);
        groups.set(owner, g);
        blocked.add(rel);
        skipStream();
        return;
      }
      if (e.type === "symlink") { links.set(rel, e.linkname ?? ""); claim(rel); skipStream(); return; }
      if (e.type === "link") { notMaterialized.push({ path: rel, class: "hardlink", target: (e.linkname ?? "").replace(/^(\.\/)+/, "") }); claim(rel); skipStream(); return; }
      if (e.type === "fifo" || e.type === "character-device" || e.type === "block-device") { notMaterialized.push({ path: rel, class: "special" }); claim(rel); skipStream(); return; }
      claim(rel);
      ensureParents(rel);
      if (e.type === "directory") {
        try { mkdirSync(hostPath(rel), { mode: 0o700 }); counts.folders += 1; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(hostPath(rel)).isDirectory()) { done(err); return; } }
        skipStream();
        return;
      }
      // A regular file: created fresh, never through anything, owner-only and with no exec bit.
      let out: number;
      try { out = openSync(hostPath(rel), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); } catch (err) { stream.resume(); done(err); return; }
      counts.files += 1;
      // Closed exactly once, whichever of finish and destroy comes first: a second close could hit a reused number.
      let open = true;
      const shut = (): void => { if (open) { open = false; closeSync(out); } };
      stream.pipe(new Writable({
        write(chunk: Buffer, _enc, cb) { try { writeSync(out, chunk); counts.bytes += chunk.length; cb(); } catch (err) { cb(err as Error); } },
        final(cb) { try { shut(); cb(); } catch (err) { cb(err as Error); } },
        destroy(err, cb) { try { shut(); } catch { /* reported by final */ } cb(err); },
      })).on("finish", () => done()).on("error", (err: Error) => done(err));
    });
    const tap = new Transform({ transform(chunk: Buffer, _enc, cb: TransformCallback) { hash.update(chunk); cb(null, chunk); } });
    // The stream owns the descriptor from here and closes it however the pipeline ends.
    const source = createReadStream("", { fd });
    fd = null;
    await pipeline(source, tap, gate, extract);
    i.afterRead?.(gate.entries);
    const disagreement = compareReadings(gate.entries, parsed);
    if (disagreement !== null) throw new GateRefusal(disagreement);
    archiveSha256 = hash.digest("hex");
    for (const [owner, g] of groups) for (const p of [...g].sort()) notMaterialized.push({ path: p, class: "collision", ...(p === owner ? {} : { target: owner }) });
    for (const [path, target] of links) notMaterialized.push({ path, class: "symlink", target, escapes: linkReach(path, target, links) });
    complete = true;
  } catch (e) {
    errors.push(e instanceof GateRefusal ? `archive: ${e.message}` : `archive: ${(e as Error).message}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }

  if (complete) {
    try { renameSync(staging, finalDir(i.hostRoot, i.profile)); } catch (e) { complete = false; errors.push(`final: ${(e as Error).message}`); }
  }
  if (!complete) {
    try { rmSync(staging, { recursive: true, force: true }); } catch (e) { errors.push(`staging could not be removed: ${staging} (${(e as NodeJS.ErrnoException).code ?? "unknown"})`); }
  }
  const result: Extraction = {
    archiveSha256, complete, profile: i.profile, counts,
    rootsMissing: [...i.records.missing], notMaterialized: complete ? notMaterialized : [], omitted: [...i.records.omitted],
    ignoredPaxKeys: gate.ignoredPaxKeys, errors,
  };
  const at = openSync(extractionPath(i.hostRoot, i.profile, i.attempt), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { writeSync(at, `${JSON.stringify(result, null, 2)}\n`); } finally { closeSync(at); }
  return result;
}
