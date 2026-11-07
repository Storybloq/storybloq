/**
 * T-538 S5b-0 commit 4: the copy-out reader (plan section 9). Every archive here is built byte for byte by
 * a test-only tar builder and read through the real gate and the real tar-stream; nothing is mocked. Each
 * hostile row keeps a sentinel outside the host root and proves it untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACK_LIMITS, type PackLimits } from "../../scripts/onboarding-eval-tar-gate.js";
import { clearStaging, extractionPath, finalDir, HOST_PATH_MAX, linkReach, linkViolations, parsePackRecords, readArchive, stagingDir, type Extraction, type PackRecords } from "../../scripts/onboarding-eval-reader.js";

// --- a test-only tar builder -----------------------------------------------------------------------

const oct = (n: number, width: number): string => `${n.toString(8).padStart(width - 1, "0")}\u0000`;
interface H {
  readonly name: string | Buffer;
  readonly flag?: string;
  readonly size?: number;
  readonly mode?: number;
  readonly link?: string;
  readonly prefix?: string;
  readonly magic?: Buffer;
  readonly sizeField?: Buffer;
  readonly badChecksum?: boolean;
}
function header(h: H): Buffer {
  const b = Buffer.alloc(512);
  const put = (v: string | Buffer, at: number, len: number): void => { const x = typeof v === "string" ? Buffer.from(v, "utf-8") : v; x.copy(b, at, 0, Math.min(x.length, len)); };
  put(h.name, 0, 100);
  put(oct(h.mode ?? 0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(h.sizeField ?? oct(h.size ?? 0, 12), 124, 12);
  put(oct(0, 12), 136, 12);
  b[156] = (h.flag ?? "0").charCodeAt(0);
  if (h.link) put(h.link, 157, 100);
  put(h.magic ?? Buffer.from("ustar\u000000", "latin1"), 257, 8);
  put(oct(0, 8), 329, 8);
  put(oct(0, 8), 337, 8);
  if (h.prefix) put(h.prefix, 345, 155);
  b.fill(0x20, 148, 156);
  let sum = 0;
  for (const x of b) sum += x;
  put(`${(h.badChecksum ? sum + 1 : sum).toString(8).padStart(6, "0")}\u0000 `, 148, 8);
  return b;
}
const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
const file = (name: string | Buffer, text = "", extra: Partial<H> = {}): Buffer => { const d = Buffer.from(text); return Buffer.concat([header({ name, size: d.length, ...extra }), pad(d)]); };
const dir = (name: string): Buffer => header({ name: `${name}/`, flag: "5", mode: 0o755 });
const sym = (name: string, link: string): Buffer => header({ name, flag: "2", link, mode: 0o777 });
const hard = (name: string, link: string): Buffer => header({ name, flag: "1", link });
/** One pax record with its exact length. */
function rec(key: string, value: string | Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(` ${key}=`), Buffer.from(value), Buffer.from("\n")]);
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len += 1;
  return Buffer.concat([Buffer.from(String(len)), body]);
}
const pax = (...records: Buffer[]): Buffer => { const body = Buffer.concat(records); return Buffer.concat([header({ name: "PaxHeaders/x", flag: "x", size: body.length }), pad(body)]); };
const END = Buffer.alloc(1024);
const tar = (...parts: Buffer[]): Buffer => { const b = Buffer.concat([...parts, END]); return Buffer.concat([b, Buffer.alloc((10240 - (b.length % 10240)) % 10240)]); };

// --- the harness around one read -------------------------------------------------------------------

const NO_RECORDS: PackRecords = { missing: [], omitted: [], sockets: [], errors: [], aliases: [] };
let root = "";
let host = "";
const SENTINEL = "SENTINEL-UNTOUCHED\n";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "t538t-")));
  host = join(root, "host");
  mkdirSync(host);
  writeFileSync(join(root, "sentinel.txt"), SENTINEL);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function read(bytes: Buffer, o: { limits?: PackLimits; records?: PackRecords; attempt?: number; afterRead?: (g: never[]) => void } = {}): Promise<Extraction> {
  const at = join(root, `a-${o.attempt ?? 1}.tar`);
  writeFileSync(at, bytes);
  return readArchive({ tarPath: at, hostRoot: host, profile: "attempt", attempt: o.attempt ?? 1, records: o.records ?? NO_RECORDS, limits: o.limits, afterRead: o.afterRead as never });
}
/** The archive failed whole: nothing final, the staging folder gone, the sentinel unchanged. */
async function refused(bytes: Buffer, why: RegExp, limits?: PackLimits): Promise<void> {
  const x = await read(bytes, { limits });
  expect(x.complete).toBe(false);
  expect(x.errors.join("\n")).toMatch(why);
  expect(x.notMaterialized).toEqual([]);
  expect(existsSync(finalDir(host, "attempt"))).toBe(false);
  expect(existsSync(stagingDir(host, "attempt", 1))).toBe(false);
  expect(readFileSync(join(root, "sentinel.txt"), "utf-8")).toBe(SENTINEL);
}
const final = (rel: string): string => join(finalDir(host, "attempt"), rel);
const nm = (x: Extraction, path: string) => x.notMaterialized.find((n) => n.path === path);

describe("a clean archive", () => {
  it("lands whole in final/, files 0600 and folders 0700, staging gone, its sha and counts recorded", async () => {
    const bytes = tar(dir("project"), dir("project/src"), file("project/src/a.ts", "a\n", { mode: 0o4755 }), file("project/b.txt", "bb\n"));
    const x = await read(bytes);
    expect(x.errors).toEqual([]);
    expect(x.complete).toBe(true);
    expect(x.archiveSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(x.counts).toEqual({ entries: 4, files: 2, folders: 2, bytes: 5 });
    expect(readFileSync(final("project/src/a.ts"), "utf-8")).toBe("a\n");
    expect(lstatSync(final("project/src/a.ts")).mode & 0o7777).toBe(0o600);
    expect(lstatSync(final("project/src")).mode & 0o7777).toBe(0o700);
    expect(existsSync(stagingDir(host, "attempt", 1))).toBe(false);
    expect(JSON.parse(readFileSync(extractionPath(host, "attempt", 1), "utf-8"))).toEqual(x);
  });
  it("an empty archive is valid and complete", async () => {
    const x = await read(tar());
    expect([x.complete, x.counts.entries]).toEqual([true, 0]);
  });
  it("carries the records: missing roots, omitted folders, sockets as special", async () => {
    const x = await read(tar(dir("project")), { records: { ...NO_RECORDS, missing: ["store"], omitted: ["project/node_modules"], sockets: ["project/sock"] } });
    expect([x.complete, x.rootsMissing, x.omitted, nm(x, "project/sock")?.class, x.errors]).toEqual([true, ["store"], ["project/node_modules"], "special", []]);
  });
  it("a valid archive whose pack reported an error is not complete and publishes nothing, the message kept", async () => {
    const x = await read(tar(dir("project"), file("project/a.txt", "a")), { records: { ...NO_RECORDS, errors: ["find: a folder could not be read"] } });
    expect(x.complete).toBe(false);
    expect(x.errors).toEqual(["pack: find: a folder could not be read", "archive: the pack reported errors, so the archive may be missing evidence"]);
    expect(existsSync(finalDir(host, "attempt"))).toBe(false);
    expect(existsSync(stagingDir(host, "attempt", 1))).toBe(false);
  });
  it("an archive with an A record publishes nothing: the alias would be credential content under another name", async () => {
    const x = await read(tar(dir("project"), file("project/innocent.txt", "FAKE")), { records: { ...NO_RECORDS, aliases: ["/vol/att/project/innocent.txt"] } });
    expect(x.complete).toBe(false);
    expect(x.aliases).toEqual(["/vol/att/project/innocent.txt"]);
    expect(x.errors.join("\n")).toMatch(/another name for the credential: \/vol\/att\/project\/innocent\.txt/);
    expect(existsSync(finalDir(host, "attempt"))).toBe(false);
    expect(existsSync(stagingDir(host, "attempt", 1))).toBe(false);
    expect(JSON.parse(readFileSync(extractionPath(host, "attempt", 1), "utf-8")).aliases).toEqual(["/vol/att/project/innocent.txt"]);
  });
  it("counts pax keys it reads past, but not the times", async () => {
    const x = await read(tar(pax(rec("mtime", "1.5"), rec("atime", "1"), rec("ctime", "1"), rec("uname", "eval"), rec("comment", "x")), file("f", "1")));
    expect([x.complete, x.ignoredPaxKeys]).toEqual([true, 2]);
  });
  it("a pax path long name is the effective name", async () => {
    const long = `project/${"d".repeat(120)}/f.txt`;
    const x = await read(tar(pax(rec("path", long)), file("short", "1")));
    expect(readFileSync(final(long), "utf-8")).toBe("1");
    expect(x.complete).toBe(true);
  });
  it("the ustar prefix joins the name", async () => {
    await read(tar(file("f.txt", "p", { prefix: "project/deep" })));
    expect(readFileSync(final("project/deep/f.txt"), "utf-8")).toBe("p");
  });
});

describe("the archive file itself", () => {
  it("a link at the archive's path is not followed", async () => {
    writeFileSync(join(root, "real.tar"), tar(file("f", "1")));
    symlinkSync(join(root, "real.tar"), join(root, "link.tar"));
    const x = await readArchive({ tarPath: join(root, "link.tar"), hostRoot: host, profile: "attempt", attempt: 1, records: NO_RECORDS });
    expect(x.complete).toBe(false);
    expect(x.errors.join()).toMatch(/could not be opened \(ELOOP\)/);
  });
  it("a FIFO at the archive's path is not waited on", async () => {
    expect(spawnSync("mkfifo", [join(root, "fifo.tar")]).status).toBe(0);
    const x = await readArchive({ tarPath: join(root, "fifo.tar"), hostRoot: host, profile: "attempt", attempt: 1, records: NO_RECORDS });
    expect(x.errors.join()).toMatch(/not a regular file/);
  });
});

describe("links, judged from the archive's metadata and never created", () => {
  it("a symlink out of the tree to the sentinel escapes, is not created, and is a violation under project", async () => {
    const x = await read(tar(dir("project"), sym("project/out", join(root, "sentinel.txt"))));
    expect(nm(x, "project/out")).toEqual({ path: "project/out", class: "symlink", target: join(root, "sentinel.txt"), escapes: "escapes" });
    expect(existsSync(final("project/out"))).toBe(false);
    expect(linkViolations(x).map((n) => n.path)).toEqual(["project/out"]);
    expect(readFileSync(join(root, "sentinel.txt"), "utf-8")).toBe(SENTINEL);
  });
  it("a symlink then a file through it refuses the archive", async () => {
    mkdirSync(join(root, "outdir"));
    await refused(tar(dir("project"), sym("project/through", join(root, "outdir")), file("project/through/x.txt", "x")), /used as a file and a folder/);
    expect(readdirSync(join(root, "outdir"))).toEqual([]);
  });
  it("a chain resolves through the archive's own links; a chain that leaves escapes; a loop is unknown", async () => {
    const x = await read(tar(dir("project"), file("project/real.txt", "r"), sym("project/a", "b"), sym("project/b", "real.txt"),
      sym("project/c", "d"), sym("project/d", "../../outside"), sym("project/l1", "l2"), sym("project/l2", "l1")));
    expect([nm(x, "project/a")?.escapes, nm(x, "project/c")?.escapes, nm(x, "project/l1")?.escapes]).toEqual(["inside", "escapes", "unknown"]);
    expect(linkViolations(x).map((n) => n.path).sort()).toEqual(["project/c", "project/d", "project/l1", "project/l2"]);
  });
  it("a link out of project into another root stays inside the archive and is not a violation; one outside the protected roots is not either", async () => {
    const x = await read(tar(dir("project"), dir("home"), sym("project/s", "../store/x"), sym("home/far", "/etc/passwd")));
    expect([nm(x, "project/s")?.escapes, nm(x, "home/far")?.escapes]).toEqual(["inside", "escapes"]);
    expect(linkViolations(x)).toEqual([]);
  });
  it("linkReach: a target through a linked folder, depth past 40, and an absolute target", () => {
    const links = new Map([["p/dir", "../q"], ["p/x", "dir/../../.."]]);
    expect(linkReach("p/y", "dir/file", links)).toBe("inside");
    expect(linkReach("p/x", "dir/../../..", links)).toBe("escapes");
    const chain = new Map(Array.from({ length: 45 }, (_v, k) => [`l${k}`, `l${k + 1}`] as [string, string]));
    expect(linkReach("l0", "l1", chain)).toBe("unknown");
    expect(linkReach("a/b", "/abs", new Map())).toBe("escapes");
  });
  it("a pax linkpath that traverses escapes", async () => {
    const x = await read(tar(dir("project"), pax(rec("linkpath", "../../../../etc/passwd")), sym("project/t", "short")));
    expect(nm(x, "project/t")).toMatchObject({ target: "../../../../etc/passwd", escapes: "escapes" });
  });
  it("a hard link is listed and not created; a forward hard link refuses the archive", async () => {
    const x = await read(tar(dir("project"), file("project/a.ts", "a"), hard("project/b.ts", "project/a.ts")));
    expect(nm(x, "project/b.ts")).toEqual({ path: "project/b.ts", class: "hardlink", target: "project/a.ts" });
    expect(existsSync(final("project/b.ts"))).toBe(false);
    rmSync(host, { recursive: true }); mkdirSync(host);
    await refused(tar(dir("project"), hard("project/b.ts", "project/a.ts"), file("project/a.ts", "a")), /hard link to project\/a.ts, which has not appeared/);
  });
  it("a hard link through pax linkpath to a path outside refuses the archive", async () => {
    await refused(tar(dir("project"), pax(rec("linkpath", "../../etc/passwd")), hard("project/h", "x")), /hard link to \.\.\/\.\.\/etc\/passwd/);
  });
});

describe("names", () => {
  it.each([
    ["a ../ ustar name", file("../escaped.txt", "x")],
    ["an absolute ustar name", file(`${"/"}abs-escaped.txt`, "x")],
    ["a ../ in the prefix", file("f.txt", "x", { prefix: "../.." })],
    ["a ../ pax path", Buffer.concat([pax(rec("path", "project/../../escaped.txt")), file("short", "x")])],
    ["an absolute pax path", Buffer.concat([pax(rec("path", "/abs-escaped.txt")), file("short", "x")])],
    ["an empty segment", file("project//x.txt", "x")],
  ])("%s is refused by name, created nowhere", async (_n, entry) => {
    const x = await read(tar(entry));
    expect(x.complete).toBe(true);
    expect(x.notMaterialized.map((n) => n.class)).toEqual(["refused-name"]);
    expect(existsSync(join(host, "staging", "escaped.txt"))).toBe(false);
    expect(existsSync(join(host, "escaped.txt"))).toBe(false);
    expect(existsSync("/abs-escaped.txt")).toBe(false);
    expect(readFileSync(join(root, "sentinel.txt"), "utf-8")).toBe(SENTINEL);
  });
  it("a name that is not UTF-8 is refused by name", async () => {
    const x = await read(tar(file(Buffer.concat([Buffer.from("project/bad-"), Buffer.from([0xff]), Buffer.from("-name")]), "x")));
    expect(x.notMaterialized.map((n) => n.class)).toEqual(["refused-name"]);
  });
  it("a path longer than the host allows is too-long, and the rest is written", async () => {
    // Sized from the host's own limit, so the destination is over it on macOS and on Linux while the
    // archive path stays inside the gate's pathBytes.
    const need = HOST_PATH_MAX - Buffer.byteLength(stagingDir(host, "attempt", 1)) + 1;
    const segs: string[] = [];
    while (Buffer.byteLength(`project/${segs.join("/")}/f`) < need) segs.push("d".repeat(200));
    const long = `project/${segs.join("/")}/f`;
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(PACK_LIMITS.pathBytes);
    expect(Buffer.byteLength(join(stagingDir(host, "attempt", 1), long))).toBeGreaterThanOrEqual(HOST_PATH_MAX);
    const x = await read(tar(pax(rec("path", long)), file("short", "x"), file("ok.txt", "ok")));
    expect(x.notMaterialized.map((n) => n.class)).toEqual(["too-long"]);
    expect(readFileSync(final("ok.txt"), "utf-8")).toBe("ok");
  });
});

describe("host collisions", () => {
  it("a case pair and an NFC/NFD pair: the first written, every name listed, and assertions over them blocked", async () => {
    const nfc = "project/.story/tickets/café.json";
    const nfd = "project/.story/tickets/café.json";
    const x = await read(tar(dir("project"), dir("project/.story"), dir("project/.story/tickets"), file("project/.story/config.json", "{}"),
      file("project/.story/tickets/T-1.json", "upper"), file("project/.story/tickets/t-1.json", "lower"), file(nfc, "nfc"), file(nfd, "nfd")));
    expect(x.notMaterialized.filter((n) => n.class === "collision").map((n) => n.path).sort()).toEqual([nfd, nfc, "project/.story/tickets/T-1.json", "project/.story/tickets/t-1.json"].sort());
    expect(readFileSync(final("project/.story/tickets/T-1.json"), "utf-8")).toBe("upper");
    const { blockedBy } = await import("../../scripts/onboarding-eval-assertion-deps.js");
    expect(blockedBy([{ tree: "project/.story/tickets" }], x)).toMatch(/^evidence-blocked: project\/\.story\/tickets\/.*, collision$/);
    expect(blockedBy([{ file: "project/.story/tickets/T-1.json" }], x)).toBe("evidence-blocked: project/.story/tickets/T-1.json, collision");
    expect(blockedBy([{ file: "project/.story/config.json" }], x)).toBeNull();
  });
  it("a folder that collides takes its contents with it", async () => {
    const x = await read(tar(dir("project"), dir("project/Src"), file("project/Src/a", "1"), dir("project/src"), file("project/src/b", "2")));
    expect(x.notMaterialized.map((n) => [n.path, n.class])).toEqual([["project/Src", "collision"], ["project/src", "collision"], ["project/src/b", "collision"]]);
    expect(existsSync(final("project/Src/b"))).toBe(false);
  });
});

describe("special entries", () => {
  it("a setuid file is written owner-only with no special bits; a FIFO and devices are listed, not created", async () => {
    const x = await read(tar(dir("project"), file("project/setuid", "s", { mode: 0o4755 }), header({ name: "project/fifo", flag: "6" }),
      header({ name: "project/tty", flag: "3" }), header({ name: "project/disk", flag: "4" })));
    expect(lstatSync(final("project/setuid")).mode & 0o7777).toBe(0o600);
    expect(x.notMaterialized.map((n) => [n.path, n.class])).toEqual([["project/fifo", "special"], ["project/tty", "special"], ["project/disk", "special"]]);
    expect(readdirSync(final("project"))).toEqual(["setuid"]);
  });
});

describe("assertions over what was not shown", () => {
  const ex = (o: Partial<Extraction>): Extraction => ({ archiveSha256: "x", complete: true, profile: "attempt", counts: { entries: 0, files: 0, folders: 0, bytes: 0 }, rootsMissing: [], notMaterialized: [], omitted: [], aliases: [], ignoredPaxKeys: 0, errors: [], ...o });
  it("a link several levels below a declared tree blocks it; a sibling file still runs", async () => {
    const { blockedBy } = await import("../../scripts/onboarding-eval-assertion-deps.js");
    const x = ex({ notMaterialized: [{ path: "project/.story/tickets/a/b/c/link", class: "symlink", target: "x", escapes: "inside" }] });
    expect(blockedBy([{ tree: "project/.story/tickets" }], x)).toBe("evidence-blocked: project/.story/tickets/a/b/c/link, symlink");
    expect(blockedBy([{ tree: "project/.story" }], x)).toBe("evidence-blocked: project/.story/tickets/a/b/c/link, symlink");
    expect(blockedBy([{ file: "project/.story/config.json" }], x)).toBeNull();
    expect(blockedBy([{ file: "project/.story/tickets/a/b/c/link/inner" }], x)).toBe("evidence-blocked: project/.story/tickets/a/b/c/link, symlink");
  });
  it("an ancestor not shown blocks a file; a missing root and an omitted folder do too; an incomplete archive blocks everything", async () => {
    const { blockedBy } = await import("../../scripts/onboarding-eval-assertion-deps.js");
    expect(blockedBy([{ file: "project/.story/a.json" }], ex({ notMaterialized: [{ path: "project/.story", class: "refused-name" }] }))).toBe("evidence-blocked: project/.story, refused-name");
    expect(blockedBy([{ file: "eval-events/events.jsonl" }], ex({ rootsMissing: ["eval-events"] }))).toBe("evidence-blocked: eval-events/events.jsonl, under the missing root eval-events");
    expect(blockedBy([{ tree: "project" }], ex({ omitted: ["project/web/node_modules"] }))).toBe("evidence-blocked: project/web/node_modules, omitted");
    expect(blockedBy([{ file: "project/web/node_modules/x" }], ex({ omitted: ["project/web/node_modules"] }))).toBe("evidence-blocked: project/web/node_modules, omitted");
    expect(blockedBy([{ file: "project/web/x" }], ex({ omitted: ["project/web/node_modules"] }))).toBeNull();
    expect(blockedBy([], ex({ complete: false }))).toBe("evidence-blocked: the archive, incomplete");
    expect(blockedBy([{ tree: "store" }], ex({ notMaterialized: [{ path: "storefront/x", class: "special" }] }))).toBeNull();
  });
});

describe("refused whole: the structure", () => {
  const body = (): Buffer => Buffer.concat([dir("project"), file("project/a.txt", "a".repeat(700))]);
  it("a bad header checksum", async () => { await refused(tar(file("f", "1", { badChecksum: true })), /checksum that does not match/); });
  it("base-256 size", async () => {
    const f = Buffer.alloc(12); f[0] = 0x80; f[11] = 1;
    await refused(tar(Buffer.concat([header({ name: "f", sizeField: f }), pad(Buffer.from("x"))])), /base-256 size/);
  });
  it("a size that is not octal", async () => { await refused(tar(header({ name: "f", sizeField: Buffer.from("00000000009\u0000") })), /size field that is not octal/); });
  it("old-GNU magic", async () => { await refused(tar(file("f", "1", { magic: Buffer.from("ustar  \u0000", "latin1") })), /not ustar 00/); });
  it.each([["L", "GNU long name"], ["K", "GNU long link"], ["S", "sparse"], ["M", "multivolume"], ["V", "volume"], ["N", "old long names"], ["g", "global"], ["7", "contiguous"], ["Z", "unknown"], ["\u0000", "old regular"]])("the typeflag %j (%s)", async (flag) => {
    await refused(tar(Buffer.concat([header({ name: "f", flag, size: 1 }), pad(Buffer.from("x"))])), /typeflag/);
  });
  it("a GNU sparse pax key", async () => { await refused(tar(pax(rec("GNU.sparse.size", "10")), file("f", "1")), /sparse pax key/); });
  it("a typeflag-0 name ending in /", async () => { await refused(tar(file("project/", "")), /regular file whose name ends in \//); });
  it("a truncated payload", async () => { await refused(body().subarray(0, 512 + 512 + 300), /truncated/); });
  it("a cut mid-header", async () => { await refused(body().subarray(0, 512 + 200), /truncated/); });
  it("a cut at a block boundary", async () => { await refused(body().subarray(0, 1024), /truncated/); });
  it("no end blocks after the last entry", async () => { await refused(body(), /without its end-of-archive blocks/); });
  it("one zero block only", async () => { await refused(Buffer.concat([body(), Buffer.alloc(512)]), /without its end-of-archive blocks/); });
  it("data after the end marker", async () => { await refused(Buffer.concat([tar(dir("project")), Buffer.from("tail")]), /data after the end/); });
  it.each([1, 511])("%i zero bytes after the padded end are a part block, refused", async (n) => {
    await refused(Buffer.concat([tar(dir("project")), Buffer.alloc(n)]), /ends inside a block after its end/);
  });
  it("a whole extra zero block after the end is padding, accepted", async () => {
    const x = await read(Buffer.concat([tar(dir("project")), Buffer.alloc(512)]));
    expect([x.complete, x.errors]).toEqual([true, []]);
  });
  it("an entry after a lone zero block", async () => { await refused(tar(dir("project"), Buffer.alloc(512), file("f", "1")), /zero block inside the archive/); });
  it("a directory or link that carries data", async () => { await refused(tar(header({ name: "d/", flag: "5", size: 1 }), pad(Buffer.from("x"))), /directory entry that carries data/); });
});

describe("a refusal lists nothing", () => {
  it("an entry listed before the refusal is not reported: the archive failed whole", async () => {
    // Refused at the end, after the parser has already seen and listed the FIFO and the link.
    await refused(Buffer.concat([dir("project"), header({ name: "project/fifo", flag: "6" }), sym("project/l", "x")]), /without its end-of-archive blocks/);
  });
});

describe("refused whole: pax", () => {
  it.each([[5, "larger"], [1, "smaller"]])("a pax size %i, %s than the payload", async (n) => {
    await refused(tar(pax(rec("size", String(n))), file("f", "abc")), /pax size that disagrees/);
  });
  it("a pax header with no entry following", async () => { await refused(tar(pax(rec("path", "x"))), /pax header with no entry following/); });
  it("two pax headers in a row", async () => { await refused(tar(pax(rec("path", "x")), pax(rec("path", "y")), file("f", "1")), /pax header with no entry following/); });
  it("a bad record length", async () => { await refused(tar(pax(Buffer.from("99 path=x\n")), file("f", "1")), /pax record with a bad length/); });
  it("a record whose length fits but does not end in a newline", async () => { await refused(tar(pax(Buffer.from("8 path=x")), file("f", "1")), /pax record with a bad length/); });
  it("a record without =", async () => { await refused(tar(pax(Buffer.from("9 pathx\n\n")), file("f", "1")), /without a key and `=`|bad length/); });
  it("a repeated key", async () => { await refused(tar(pax(rec("path", "a"), rec("path", "b")), file("f", "1")), /pax key path repeated/); });
  it("a path with NUL", async () => { await refused(tar(pax(rec("path", Buffer.from("a\u0000b"))), file("f", "1")), /pax path with NUL/); });
});

describe("refused whole: duplicates", () => {
  it.each([
    ["a twice", [file("a", "1"), file("a", "2")]],
    ["a against ./a", [file("a", "1"), file("./a", "2")]],
    ["a/ against a", [dir("a"), file("a", "2")]],
    ["a file then a folder of the same name", [file("a", "1"), dir("a")]],
    ["a file then a path through it", [file("a", "1"), file("a/b", "2")]],
    ["a folder implied by a child, then a file of that name", [file("a/b", "1"), file("a", "2")]],
  ] as [string, Buffer[]][])("%s", async (_n, parts) => {
    await refused(tar(...parts), /twice|used as a file and a folder/);
  });
});

describe("refused whole: each limit in section 12", () => {
  const small = (o: Partial<PackLimits>): PackLimits => ({ ...PACK_LIMITS, ...o });
  it("archive bytes", async () => { await refused(tar(file("f", "x".repeat(4000))), /over its byte limit/, small({ archiveBytes: 8192 })); });
  it("entries", async () => { await refused(tar(file("a", "1"), file("b", "1"), file("c", "1")), /more entries than the limit/, small({ entries: 2 })); });
  it("one pax header", async () => { await refused(tar(pax(rec("comment", "x".repeat(600))), file("f", "1")), /pax header over its limit/, small({ paxHeaderBytes: 512 })); });
  it("total metadata", async () => { await refused(tar(file("a", "1"), file("b", "1"), file("c", "1")), /metadata is over its limit/, small({ metadataBytes: 1024 })); });
  it("depth", async () => { await refused(tar(file("a/b/c/d", "1")), /deeper than its limit/, small({ depth: 3 })); });
  it("path length", async () => { await refused(tar(file("abcdefghij", "1")), /path over its limit/, small({ pathBytes: 8 })); });
  it("component length", async () => { await refused(tar(file("a/abcdefghij", "1")), /component over its limit/, small({ componentBytes: 8 })); });
  it("per file", async () => { await refused(tar(file("f", "x".repeat(600))), /file over its limit/, small({ fileBytes: 512 })); });
});

describe("the gate and the parser must agree", () => {
  it("a gate record the parser reads differently refuses the archive", async () => {
    const x = await read(tar(dir("project"), file("project/a.txt", "a")), { afterRead: (g: never[]) => { (g as unknown as { name: string }[])[1]!.name = "project/b.txt"; } });
    expect(x.complete).toBe(false);
    expect(x.errors.join()).toMatch(/entry 2 reads differently/);
    expect(existsSync(finalDir(host, "attempt"))).toBe(false);
  });
  it("a count that differs refuses it too", async () => {
    const x = await read(tar(dir("project")), { afterRead: (g: never[]) => { (g as unknown as object[]).push({}); } });
    expect(x.errors.join()).toMatch(/the gate read 2 entries and the parser 1/);
  });
});

describe("staging and retries", () => {
  it("a failed try leaves nothing; the next try reads into its own folder and both results stay", async () => {
    const bad = await read(tar(file("f", "1", { badChecksum: true })), { attempt: 1 });
    const good = await read(tar(file("f", "1")), { attempt: 2 });
    expect([bad.complete, good.complete]).toEqual([false, true]);
    expect(existsSync(extractionPath(host, "attempt", 1)) && existsSync(extractionPath(host, "attempt", 2))).toBe(true);
    expect(readdirSync(join(host, "staging"))).toEqual([]);
  });
  it("a staging folder left by an earlier try is refused, not written into", async () => {
    mkdirSync(stagingDir(host, "attempt", 1), { recursive: true });
    await expect(read(tar(file("f", "1")))).rejects.toThrow(/EEXIST/);
  });
  it("a restart clears every staging folder and .part file and keeps the rest", () => {
    mkdirSync(join(host, "staging", "attempt-3"), { recursive: true });
    mkdirSync(join(host, "raw"));
    writeFileSync(join(host, "raw", "attempt.tar.part"), "x");
    writeFileSync(join(host, "raw", "attempt.tar"), "y");
    expect(clearStaging(host)).toEqual([]);
    expect([existsSync(join(host, "staging")), readdirSync(join(host, "raw"))]).toEqual([false, ["attempt.tar"]]);
  });
});

describe("a pack's stderr records", () => {
  it("parses every record kind", () => {
    const b = Buffer.from("M\u0000store\u0000O\u0000project/node_modules\u0000S\u0000project/sock\u0000E\u0000tar: x\u0000A\u0000/vol/att/project/c\u0000");
    expect(parsePackRecords(b)).toEqual({ missing: ["store"], omitted: ["project/node_modules"], sockets: ["project/sock"], errors: ["tar: x"], aliases: ["/vol/att/project/c"] });
  });
  it.each([["plain text", "tar: oops\n"], ["an unknown tag", "Q\u0000x\u0000"], ["a cut-off record", "M\u0000store"], ["a tag with no separator", "Mstore\u0000"]])("refuses %s", (_n, t) => {
    expect(parsePackRecords(Buffer.from(t))).toHaveProperty("refused");
  });
  it("refuses records over the limit", () => {
    expect(parsePackRecords(Buffer.alloc((8 << 20) + 1, 0x41))).toEqual({ refused: "the pack's records are over their limit" });
  });
});
