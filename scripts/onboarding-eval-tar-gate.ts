// T-538 S5b-0 commit 4: the gate in front of the archive parser (plan section 9, Reader). tar-stream
// 2.2.0 is lenient where the plan must not be, so this pass-through reads the same 512-byte structure
// on its own and refuses what the parser would quietly accept. Its record of each entry must then equal
// what the parser emitted, in order and in number, so a disagreement between two readings can never
// choose an interpretation. Nothing calls this yet; the conversion commit does.
import { Transform, type TransformCallback } from "node:stream";

/** Section 12's pack limits. A stream over any of them fails the whole archive. */
export interface PackLimits {
  readonly archiveBytes: number;
  readonly entries: number;
  readonly paxHeaderBytes: number;
  readonly metadataBytes: number;
  readonly pathBytes: number;
  readonly componentBytes: number;
  readonly depth: number;
  readonly fileBytes: number;
}
export const PACK_LIMITS: PackLimits = {
  archiveBytes: 1 << 30, entries: 100_000, paxHeaderBytes: 64 << 10, metadataBytes: 32 << 20,
  pathBytes: 4096, componentBytes: 255, depth: 64, fileBytes: 256 << 20,
};

export type EntryType = "file" | "link" | "symlink" | "character-device" | "block-device" | "directory" | "fifo";
const TYPES: Record<string, EntryType> = { "0": "file", "1": "link", "2": "symlink", "3": "character-device", "4": "block-device", "5": "directory", "6": "fifo" };

/** One entry as the gate read it. `name` is the effective name: pax applied, a directory's one trailing `/` removed. */
export interface GateEntry {
  readonly name: string;
  /** The same name with any leading `./` removed: what duplicates and links are judged on. */
  readonly path: string;
  readonly utf8: boolean;
  readonly type: EntryType;
  readonly size: number;
  readonly linkname: string | null;
  readonly mode: number;
}

export class GateRefusal extends Error {}

const BLOCK = 512;
const MAGIC = Buffer.from("ustar\u000000", "latin1");
const IGNORED_TIME_KEYS = new Set(["mtime", "atime", "ctime"]);

const padded = (n: number): number => Math.ceil(n / BLOCK) * BLOCK;
const field = (h: Buffer, at: number, len: number): Buffer => h.subarray(at, at + len);
const text = (b: Buffer): Buffer => { const z = b.indexOf(0); return z < 0 ? b : b.subarray(0, z); };
const isUtf8 = (b: Buffer): boolean => { try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } };

/** A strict octal field: digits, then NUL or space padding; base-256 and anything else refuse. Empty only where `empty` allows. */
function octal(h: Buffer, at: number, len: number, name: string, empty: boolean): number {
  const b = field(h, at, len);
  if ((b[0]! & 0x80) !== 0) throw new GateRefusal(`a base-256 ${name} field`);
  const s = b.toString("latin1");
  const m = /^ *([0-7]*)[ \u0000]*$/.exec(s);
  if (m === null) throw new GateRefusal(`a ${name} field that is not octal`);
  if (m[1] === "") { if (empty) return 0; throw new GateRefusal(`an empty ${name} field`); }
  return parseInt(m[1]!, 8);
}

interface Pax { readonly path?: Buffer; readonly linkpath?: Buffer; readonly size?: number; readonly ignored: number }

/** Pax records, strictly: `<len> <key>=<value>\n` with an exact length, no repeat, no sparse keys, no NUL in a name. */
function parsePax(body: Buffer): Pax {
  const seen = new Set<string>();
  let path: Buffer | undefined;
  let linkpath: Buffer | undefined;
  let size: number | undefined;
  let ignored = 0;
  let p = 0;
  while (p < body.length) {
    const sp = body.indexOf(0x20, p);
    const digits = sp < 0 ? "" : body.subarray(p, sp).toString("latin1");
    if (!/^[1-9][0-9]*$/.test(digits)) throw new GateRefusal("a pax record with a bad length");
    const len = Number(digits);
    if (len < digits.length + 3 || p + len > body.length || body[p + len - 1] !== 0x0a) throw new GateRefusal("a pax record with a bad length");
    const rec = body.subarray(sp + 1, p + len - 1);
    const eq = rec.indexOf(0x3d);
    if (eq <= 0) throw new GateRefusal("a pax record without a key and `=`");
    const key = rec.subarray(0, eq).toString("utf-8");
    const value = rec.subarray(eq + 1);
    if (seen.has(key)) throw new GateRefusal(`the pax key ${key} repeated in one header`);
    seen.add(key);
    if (key.startsWith("GNU.sparse.")) throw new GateRefusal("a sparse pax key");
    if (key === "path" || key === "linkpath") {
      if (value.length === 0) throw new GateRefusal(`an empty pax ${key}`);
      if (value.includes(0)) throw new GateRefusal(`a pax ${key} with NUL`);
      if (key === "path") path = value; else linkpath = value;
    } else if (key === "size") {
      if (!/^[0-9]+$/.test(value.toString("latin1"))) throw new GateRefusal("a pax size that is not a number");
      size = Number(value.toString("latin1"));
    } else if (!IGNORED_TIME_KEYS.has(key)) ignored += 1;
    p += len;
  }
  return { path, linkpath, size, ignored };
}

/**
 * A pass-through that refuses the archive at the first thing section 9 lists. `entries` holds what it
 * read, `ignoredPaxKeys` counts pax keys it read past. The stream errors with a GateRefusal on refusal.
 */
export class TarGate extends Transform {
  readonly entries: GateEntry[] = [];
  ignoredPaxKeys = 0;
  refusal: string | null = null;
  private readonly limits: PackLimits;
  private total = 0;
  private metadata = 0;
  private skip = 0;
  private acc = Buffer.alloc(0);
  private need = BLOCK;
  private collecting: "header" | "pax" = "header";
  private paxSize = 0;
  private pax: Pax | null = null;
  private zeros = 0;
  private readonly names = new Set<string>();
  private readonly nonFolders = new Set<string>();
  private readonly folders = new Set<string>();

  constructor(limits: PackLimits = PACK_LIMITS) {
    super();
    this.limits = limits;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.refusal !== null) { cb(new GateRefusal(this.refusal)); return; }
    try {
      this.total += chunk.length;
      if (this.total > this.limits.archiveBytes) throw new GateRefusal("the archive is over its byte limit");
      this.consume(chunk);
      cb(null, chunk);
    } catch (e) {
      cb(this.refuse(e));
    }
  }

  override _flush(cb: TransformCallback): void {
    if (this.refusal !== null) { cb(new GateRefusal(this.refusal)); return; }
    try {
      if (this.zeros < 2) {
        if (this.skip > 0 || this.acc.length > 0) throw new GateRefusal("the archive is truncated");
        throw new GateRefusal("the archive ends without its end-of-archive blocks");
      }
      // Padding after the end marker is counted in `total` only, so whole blocks are checked here.
      if (this.acc.length > 0 || this.total % BLOCK !== 0) throw new GateRefusal("the archive ends inside a block after its end");
      cb();
    } catch (e) {
      cb(this.refuse(e));
    }
  }

  private refuse(e: unknown): Error {
    if (!(e instanceof GateRefusal)) throw e;
    this.refusal = e.message;
    return e;
  }

  private consume(chunk: Buffer): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - i);
        this.skip -= n;
        i += n;
        continue;
      }
      if (this.zeros >= 2) {
        // After the end marker, zero padding only.
        for (; i < chunk.length; i++) if (chunk[i] !== 0) throw new GateRefusal("data after the end of the archive");
        continue;
      }
      const n = Math.min(this.need - this.acc.length, chunk.length - i);
      this.acc = Buffer.concat([this.acc, chunk.subarray(i, i + n)]);
      i += n;
      if (this.acc.length === this.need) {
        const block = this.acc;
        this.acc = Buffer.alloc(0);
        if (this.collecting === "pax") this.onPax(block.subarray(0, this.paxSize));
        else this.onHeader(block);
      }
    }
  }

  private onPax(body: Buffer): void {
    this.pax = parsePax(body);
    this.ignoredPaxKeys += this.pax.ignored;
    this.collecting = "header";
    this.need = BLOCK;
  }

  private onHeader(h: Buffer): void {
    if (h.every((b) => b === 0)) {
      if (this.pax !== null) throw new GateRefusal("a pax header with no entry following");
      this.zeros += 1;
      return;
    }
    if (this.zeros > 0) throw new GateRefusal("a zero block inside the archive");
    this.metadata += BLOCK;
    let sum = 0;
    for (let k = 0; k < BLOCK; k++) sum += k >= 148 && k < 156 ? 0x20 : h[k]!;
    if (octal(h, 148, 8, "checksum", false) !== sum) throw new GateRefusal("a header checksum that does not match");
    if (!field(h, 257, 8).equals(MAGIC)) throw new GateRefusal("a header that is not ustar 00");
    const flag = String.fromCharCode(h[156]!);
    const mode = octal(h, 100, 8, "mode", false);
    octal(h, 108, 8, "uid", true);
    octal(h, 116, 8, "gid", true);
    const size = octal(h, 124, 12, "size", false);
    octal(h, 136, 12, "mtime", true);
    octal(h, 329, 8, "devmajor", true);
    octal(h, 337, 8, "devminor", true);
    if (flag === "x") {
      if (this.pax !== null) throw new GateRefusal("a pax header with no entry following");
      if (size > this.limits.paxHeaderBytes) throw new GateRefusal("a pax header over its limit");
      this.metadata += size;
      if (this.metadata > this.limits.metadataBytes) throw new GateRefusal("the archive's metadata is over its limit");
      this.collecting = "pax";
      this.paxSize = size;
      this.need = Math.max(padded(size), BLOCK);
      if (size === 0) throw new GateRefusal("a pax record with a bad length");
      return;
    }
    const type = TYPES[flag];
    if (type === undefined) throw new GateRefusal(`the typeflag ${JSON.stringify(flag)}`);
    if (this.metadata > this.limits.metadataBytes) throw new GateRefusal("the archive's metadata is over its limit");
    const pax = this.pax;
    this.pax = null;
    const prefix = text(field(h, 345, 155));
    const own = text(field(h, 0, 100));
    let raw = pax?.path ?? (prefix.length > 0 ? Buffer.concat([prefix, Buffer.from("/"), own]) : own);
    if (pax?.size !== undefined && pax.size !== size) throw new GateRefusal("a pax size that disagrees with the header");
    if (type === "file" && raw[raw.length - 1] === 0x2f) throw new GateRefusal("a regular file whose name ends in /");
    if (type !== "file" && size !== 0) throw new GateRefusal(`a ${type} entry that carries data`);
    if (size > this.limits.fileBytes) throw new GateRefusal("a file over its limit");
    if (type === "directory" && raw[raw.length - 1] === 0x2f) raw = raw.subarray(0, raw.length - 1);
    if (raw.length === 0) throw new GateRefusal("an entry with no name");
    const linkRaw = pax?.linkpath ?? text(field(h, 157, 100));
    const name = raw.toString("utf-8");
    const path = name.replace(/^(\.\/)+/, "");
    const parts = path.split("/");
    if (raw.length > this.limits.pathBytes) throw new GateRefusal("a path over its limit");
    if (parts.some((c) => Buffer.byteLength(c) > this.limits.componentBytes)) throw new GateRefusal("a path component over its limit");
    if (parts.length > this.limits.depth) throw new GateRefusal("a path deeper than its limit");
    if (this.entries.length + 1 > this.limits.entries) throw new GateRefusal("more entries than the limit");
    if (this.names.has(path)) throw new GateRefusal(`the path ${path} twice`);
    for (let k = 1; k < parts.length; k++) {
      const up = parts.slice(0, k).join("/");
      if (this.nonFolders.has(up)) throw new GateRefusal(`the path ${up} used as a file and a folder`);
      this.folders.add(up);
    }
    if (type !== "directory" && this.folders.has(path)) throw new GateRefusal(`the path ${path} used as a file and a folder`);
    const linkname = linkRaw.length > 0 ? linkRaw.toString("utf-8") : null;
    if (type === "link") {
      const target = (linkname ?? "").replace(/^(\.\/)+/, "");
      if (!this.names.has(target) || this.folders.has(target)) throw new GateRefusal(`a hard link to ${target}, which has not appeared as a file`);
    }
    this.names.add(path);
    if (type === "directory") this.folders.add(path); else this.nonFolders.add(path);
    this.entries.push({ name, path, utf8: isUtf8(raw), type, size, linkname: type === "link" || type === "symlink" ? linkname : null, mode });
    this.skip = padded(size);
  }
}

/** What the parser emitted for one entry, as `compareReadings` compares it. */
export interface ParsedEntry { readonly name: string; readonly type: string | null; readonly size: number; readonly linkname: string | null }

/** Null when the two readings agree in order and number, else what differs. */
export function compareReadings(gate: readonly GateEntry[], parsed: readonly ParsedEntry[]): string | null {
  if (gate.length !== parsed.length) return `the gate read ${gate.length} entries and the parser ${parsed.length}`;
  for (let k = 0; k < gate.length; k++) {
    const g = gate[k]!;
    const p = parsed[k]!;
    const pName = p.type === "directory" && p.name.endsWith("/") ? p.name.slice(0, -1) : p.name;
    const pLink = p.type === "link" || p.type === "symlink" ? p.linkname : null;
    if (g.name !== pName || g.type !== p.type || g.size !== p.size || g.linkname !== pLink) return `entry ${k + 1} reads differently: the gate saw ${JSON.stringify([g.name, g.type, g.size, g.linkname])}, the parser ${JSON.stringify([pName, p.type, p.size, pLink])}`;
  }
  return null;
}
