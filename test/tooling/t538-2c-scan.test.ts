/**
 * T-538 commit 2c, plan 5.9: the canary is compared after every turn; the credential scan reads every file whole
 * in overlapping chunks, never follows a link, and an attempt it does not clear never reaches the judge.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hitText, SCAN_CHUNK, scanFiles } from "../../scripts/onboarding-eval-collect.js";
import { CANDIDATE_MAX, CredentialStream, OVERLONG_CANDIDATE } from "../../scripts/onboarding-eval-review.js";
import { CANARY_FILE, canaryProblems, makeCanary } from "../../scripts/onboarding-eval-config.js";
import { printablePointer, scanProblem } from "../../scripts/onboarding-eval-judge.js";
import { INVALID_FILE, invalidReasons, PACKET_LIMIT_BYTES, SCAN_PENDING_FILE, scanAndClear, stopUnconfirmed } from "../../scripts/onboarding-eval-run.js";
import { existsSync as f13Exists } from "node:fs";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "t538scan-"))); dirs.push(d); return d; };
const FORM = `sk-ant-${"a".repeat(24)}`;

describe("the canary (5.9)", () => {
  it("holds as made; a new entry, a write, a chmod and a touch are each named", () => {
    const d = scratch();
    const c = makeCanary(join(d, "canary"));
    expect(canaryProblems(c)).toEqual([]);
    writeFileSync(join(d, "canary", "x"), "");
    expect(canaryProblems(c)).toEqual([`canary: the folder's entries changed (${CANARY_FILE}, x)`]);
    rmSync(join(d, "canary", "x"));
    chmodSync(join(d, "canary", CANARY_FILE), 0o644);
    utimesSync(join(d, "canary", CANARY_FILE), new Date(0), new Date(0));
    expect(canaryProblems(c)).toEqual(["canary: the file's mode changed", "canary: the file's mtime changed"]);
    writeFileSync(join(d, "canary", CANARY_FILE), "other\n");
    expect(canaryProblems(c)).toContain("canary: the file's bytes changed");
  });
});

describe("the credential scan over files (5.9)", () => {
  it("a form across a chunk boundary is seen once, at its true offset", () => {
    const d = scratch();
    const at = SCAN_CHUNK - 10;
    const bytes = Buffer.alloc(SCAN_CHUNK * 2 + 100, 0x2e);
    Buffer.from(FORM).copy(bytes, at);
    writeFileSync(join(d, "big.bin"), bytes);
    expect(scanFiles([d])).toEqual({ hits: [{ file: join(d, "big.bin"), offset: at, pattern: "sk-ant-" }, { file: join(d, "big.bin"), offset: at, pattern: "sk-" }], unreadable: [], files: 1 });
  });

  it("a form just before the boundary is not counted twice; one in the second chunk keeps its offset", () => {
    const d = scratch();
    const bytes = Buffer.alloc(SCAN_CHUNK * 2, 0x2e);
    Buffer.from(FORM).copy(bytes, SCAN_CHUNK - 4096 + 8);
    Buffer.from(`rt_${"b".repeat(20)}`).copy(bytes, SCAN_CHUNK + 5000);
    writeFileSync(join(d, "f"), bytes);
    expect(scanFiles([join(d, "f")]).hits.map(hitText)).toEqual([
      `${join(d, "f")} at byte ${SCAN_CHUNK - 4096 + 8} (sk-ant-)`, `${join(d, "f")} at byte ${SCAN_CHUNK - 4096 + 8} (sk-)`, `${join(d, "f")} at byte ${SCAN_CHUNK + 5000} (rt_)`,
    ]);
  });

  it("the held secret is compared in memory and named by its pattern only", () => {
    const d = scratch();
    writeFileSync(join(d, "turn.jsonl"), "x held-token-value y\n");
    const r = scanFiles([d], ["held-token-value"]);
    expect(r.hits).toEqual([{ file: join(d, "turn.jsonl"), offset: 2, pattern: "held secret" }]);
    expect(JSON.stringify(r)).not.toContain("held-token-value");
  });

  it("a link is never followed; a FIFO and a missing path are not scanned and are named", () => {
    const d = scratch();
    const outside = scratch();
    writeFileSync(join(outside, "auth.json"), `{"refresh_token": "${"r".repeat(30)}"}`);
    mkdirSync(join(d, "raw"));
    symlinkSync(join(outside, "auth.json"), join(d, "raw", "auth.json"));
    execFileSync("/usr/bin/mkfifo", [join(d, "raw", "pipe")]);
    const r = scanFiles([join(d, "raw"), join(d, "gone")]);
    expect(r.hits).toEqual([]);
    expect(r.unreadable).toEqual([`${join(d, "raw", "pipe")}: a special file`, `${join(d, "gone")}: missing`]);
  });
});

describe("F6: the scan carries an unfinished candidate across the 1 MiB boundary, whatever its length", () => {
  const across = (text: string, before: number): { file: string; at: number } => {
    const d = scratch();
    const bytes = Buffer.alloc(SCAN_CHUNK * 2 + 100, 0x20);
    const at = SCAN_CHUNK - before;
    Buffer.from(text).copy(bytes, at);
    writeFileSync(join(d, "f"), bytes);
    return { file: join(d, "f"), at };
  };

  it("a 6000-character quoted token field starting 5000 bytes before the boundary", () => {
    const { file, at } = across(`"access_token": "${"x".repeat(6000)}"`, 5000);
    expect(scanFiles([file]).hits).toEqual([{ file, offset: at, pattern: "token key" }]);
  });

  it("a JWT starting 5000 bytes before the boundary", () => {
    const { file, at } = across(`eyJ${"a".repeat(3000)}.${"b".repeat(3000)}.${"c".repeat(40)}`, 5000);
    expect(scanFiles([file]).hits).toEqual([{ file, offset: at, pattern: "jwt" }]);
  });

  it("a held secret longer than the old 4 KiB overlap, across the boundary", () => {
    // Starts 6000 bytes before the boundary, so the old 4 KiB overlap could never hold all of it.
    const secret = `held-${"q".repeat(10_000)}`;
    const { file, at } = across(secret, 6000);
    expect(scanFiles([file], [secret]).hits).toEqual([{ file, offset: at, pattern: "held secret" }]);
  });

  it("a candidate still open past the bound is a hit itself (fail closed)", () => {
    // Open at the boundary and already longer than the bound there.
    const { file, at } = across(`"access_token": "${"x".repeat(CANDIDATE_MAX + 10_000)}`, CANDIDATE_MAX + 5000);
    expect(scanFiles([file]).hits).toEqual([{ file, offset: at, pattern: OVERLONG_CANDIDATE }]);
  });

  it("the stream finds a form pushed one byte at a time, at its true offset, once", () => {
    const s = new CredentialStream();
    const text = Buffer.from(`pad ${FORM} and "id_token" : '${"z".repeat(30)}' end`);
    for (const b of text) s.push(Buffer.from([b]));
    expect(s.hits()).toEqual([{ offset: 4, pattern: "sk-ant-" }, { offset: 4, pattern: "sk-" }, { offset: 4 + FORM.length + 5, pattern: "token key" }]);
  });

  it("plain text with no form gives no hit and carries almost nothing", () => {
    const s = new CredentialStream();
    for (let i = 0; i < 64; i++) s.push(Buffer.from("the quick brown fox jumps over the lazy dog. ".repeat(500)));
    expect(s.hits()).toEqual([]);
  });
});

describe("an attempt the scan does not clear never reaches the judge (5.9)", () => {
  it("F12: a harness command that exits 0 with its cleanup unconfirmed stops the attempt before its result is used", () => {
    const base = { status: 0, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false, spawnError: null };
    expect(() => stopUnconfirmed({ ...base, cleanup: "unconfirmed" as const }, "storybloq status")).toThrow(/ended \(0\) but its process group was not confirmed gone; the attempt stops/);
    const fine = { ...base, cleanup: "confirmed" as const };
    expect(stopUnconfirmed(fine, "storybloq status")).toBe(fine);
  });

  it("F13: the scan collector failing after publication leaves the marker, and the judge refuses the record; a clean scan removes it", async () => {
    const d = scratch();
    const raw = scratch();
    writeFileSync(join(d, SCAN_PENDING_FILE), "{}\n");
    writeFileSync(join(d, "record.json"), "{}");
    const snap = { recordBytes: Buffer.from("{}"), packetBytes: Buffer.from("{}") };
    await expect(scanAndClear({ scan: async () => { throw new Error("onboarding-eval: evidence: the collector failed"); } }, d, raw, 2, [])).rejects.toThrow("the collector failed");
    expect(f13Exists(join(d, SCAN_PENDING_FILE))).toBe(true);
    expect(scanProblem(d, snap)).toBe(`the record's scan has not cleared (${SCAN_PENDING_FILE}); the judge is not called`);
    await scanAndClear({ scan: async () => ({ hits: [], unreadable: [], files: 2 }) }, d, raw, 2, []);
    expect(f13Exists(join(d, SCAN_PENDING_FILE))).toBe(false);
    expect(scanProblem(d, snap)).toBe(null);
  });

  it("F9: a token field embedded in a string value, escaped in the raw bytes, is found in the decoded value", () => {
    const d = scratch();
    const packet = Buffer.from(JSON.stringify({ notes: [{ text: `config was {"access_token": "${"t".repeat(30)}"}` }] }));
    expect(packet.toString()).toContain('\\"access_token\\"');
    expect(scanProblem(d, { recordBytes: Buffer.from("{}"), packetBytes: packet })).toBe("a credential form in grading-packet.json at /notes/0/text (token key, in a decoded string); the attempt is invalid and the judge is not called");
  });

  it("H1: a credential written as a unicode-escaped key is refused by name, and the refusal carries neither the credential nor its escaped form", () => {
    const d = scratch();
    const form = `sk-ant-${"k".repeat(24)}`;
    const escaped = [...form].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const record = Buffer.from(`{"meta": {"plain": 1, "${escaped}": "x"}}`);
    expect(record.includes(Buffer.from(form))).toBe(false);
    expect(Object.keys((JSON.parse(record.toString()) as { meta: object }).meta)).toContain(form);
    const problem = scanProblem(d, { recordBytes: record, packetBytes: Buffer.from("{}") });
    expect(problem).toBe("a credential form in record.json at /meta/@1 (sk-ant-, in a decoded string); the attempt is invalid and the judge is not called");
    for (const leak of [form, escaped, form.slice(7), "kkkkkkkk"]) expect(problem).not.toContain(leak);
  });

  it("H1: a pointer the scan flags as a whole is withheld, not printed", () => {
    expect(printablePointer("/a/sk-ant-" + "q".repeat(24), [])).toBe("(a path the scan flags, withheld)");
    expect(printablePointer("/notes/0/text", [])).toBe("/notes/0/text");
    expect(printablePointer("", [])).toBe("/");
  });

  it("F9: a held secret written with unicode escapes is found in the decoded value", () => {
    const d = scratch();
    const held = "placeholder-held-value-not-a-token";
    const escaped = [...held].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const record = Buffer.from(`{"summary": "${escaped}"}`);
    expect(record.includes(Buffer.from(held))).toBe(false);
    const prior = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = held;
    try {
      expect(scanProblem(d, { recordBytes: record, packetBytes: Buffer.from("{}") })).toBe("a credential form in record.json at /summary (held secret, in a decoded string); the attempt is invalid and the judge is not called");
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = prior;
    }
  });

  it("a hit, an unreadable file and an oversize packet are each a reason the attempt is invalid", () => {
    expect(invalidReasons(10, { hits: [], unreadable: [], files: 3 })).toEqual([]);
    expect(invalidReasons(PACKET_LIMIT_BYTES + 1, { hits: [{ file: "/r/turn-01.jsonl", offset: 7, pattern: "jwt" }], unreadable: ["/r/p: a special file"], files: 1 })).toEqual([
      `the packet is ${PACKET_LIMIT_BYTES + 1} bytes, over the ${PACKET_LIMIT_BYTES} byte limit, and is refused, not partly scanned`,
      "a credential form in /r/turn-01.jsonl at byte 7 (jwt)",
      "not scanned: /r/p: a special file",
    ]);
  });

  it("the judge refuses a record marked invalid, an oversize packet and a packet carrying a form", () => {
    const d = scratch();
    const ok = { recordBytes: Buffer.from("{}"), packetBytes: Buffer.from("{}") };
    expect(scanProblem(d, ok)).toBeNull();
    expect(scanProblem(d, { ...ok, packetBytes: Buffer.alloc(PACKET_LIMIT_BYTES + 1) })).toMatch(/is refused, not partly scanned$/);
    expect(scanProblem(d, { ...ok, packetBytes: Buffer.from(`{"x":"${FORM}"}`) })).toBe("a credential form in grading-packet.json at byte 6 (sk-ant-); the attempt is invalid and the judge is not called");
    writeFileSync(join(d, INVALID_FILE), "{}\n");
    expect(scanProblem(d, ok)).toBe(`the attempt is invalid (${INVALID_FILE}); the judge is not called`);
  });
});
